import test from 'node:test';
import assert from 'node:assert/strict';
import {
    addColumn,
    addJoin,
    addTable,
    connectColumns,
    createEmptyModel,
    criteriaCondition,
    generateSql,
    groupByExpressions,
    hasTopLevelOr,
    moveColumn,
    normalizeExpressionKey,
    removeJoin,
    removeTable,
    renameQualifier,
    resolveColumnTables,
    selectedColumns,
    setCriteria,
    setSort,
    setTableAlias,
    toggleColumn,
    tokenizeSql,
    updateColumn,
    updateJoin,
    type QbForeignKey,
    type QbMappingEdge,
    type QueryModel
} from '../queryBuilderModel';
import { parseSelect, parseSql } from '../queryBuilderParser';

// ===== helpers =====

/** The model with ids replaced by positions and canvas/warning data dropped. */
function canonical(model: QueryModel): unknown {
    const tableIndex = (id: string | undefined) => (id === undefined ? undefined : model.tables.findIndex((t) => t.id === id));
    return {
        ...model,
        warnings: undefined,
        tables: model.tables.map(({ id: _id, x: _x, y: _y, ...rest }) => rest),
        joins: model.joins.map(({ id: _id, leftTableId, rightTableId, ...rest }) => ({ ...rest, left: tableIndex(leftTableId), right: tableIndex(rightTableId) })),
        columns: model.columns.map(({ id: _id, tableId, ...rest }) => ({ ...rest, table: tableIndex(tableId) }))
    };
}

const IGNORED_TREE_KEYS = new Set(['location', 'stmt_location', 'stmt_len', 'rexpr_list_start', 'rexpr_list_end']);

/** libpg-query's parse tree without source positions; ASC is the default sort direction. */
async function normalizedTree(sql: string): Promise<unknown> {
    const tree = await parseSql(sql);
    return JSON.parse(JSON.stringify(tree.stmts.map((s) => s.stmt)), (key, value) => {
        if (IGNORED_TREE_KEYS.has(key)) return undefined;
        if (key === 'sortby_dir' && value === 'SORTBY_ASC') return 'SORTBY_DEFAULT';
        return value;
    });
}

interface Case {
    name: string;
    sql: string;
    /** The generated SQL has the same parse tree as the original (fully representable). */
    exact: boolean;
    check?: (model: QueryModel, generated: string) => void;
}

const CORPUS: Case[] = [
    {
        name: 'simple select',
        sql: 'SELECT id, name FROM customers',
        exact: true,
        check: (m) => {
            assert.deepEqual(m.columns.map((c) => [c.expression, c.column, c.tableId]), [['id', 'id', 't1'], ['name', 'name', 't1']]);
            assert.deepEqual(m.warnings, []);
        }
    },
    {
        name: 'aliases with and without AS, schema-qualified table',
        sql: 'SELECT c.id, c.name AS customer_name, c.city town FROM public.customers c',
        exact: true,
        check: (m) => {
            assert.deepEqual(m.tables[0], { id: 't1', kind: 'relation', name: 'customers', schema: 'public', alias: 'c' });
            assert.deepEqual(m.columns.map((c) => c.alias), [undefined, 'customer_name', 'town']);
        }
    },
    {
        name: 'quoted mixed-case identifiers',
        sql: 'SELECT o."Id", o."CustomerName" AS "Kunde" FROM "Sales"."Order" o',
        exact: true,
        check: (m, sql) => {
            assert.equal(m.tables[0].schema, 'Sales');
            assert.equal(m.tables[0].name, 'Order');
            assert.equal(m.columns[1].column, 'CustomerName');
            assert.match(sql, /FROM\n {4}"Sales"\."Order" o/);
            assert.match(sql, /o\."CustomerName" AS "Kunde"/);
        }
    },
    {
        name: 'unquoted mixed case keeps the expression text',
        sql: 'SELECT Cust.ID, Cust.Name FROM Customers Cust',
        exact: true,
        check: (m) => {
            assert.equal(m.tables[0].alias, 'cust');
            assert.equal(m.columns[0].expression, 'Cust.ID');
            assert.equal(m.columns[0].column, 'id');
        }
    },
    {
        name: 'inner join',
        sql: 'SELECT o.id, c.name FROM orders o INNER JOIN customers c ON o.customer_id = c.id',
        exact: true,
        check: (m) => assert.deepEqual(m.joins, [{ id: 'j1', leftTableId: 't1', rightTableId: 't2', type: 'INNER', pairs: [{ leftColumn: 'customer_id', rightColumn: 'id' }] }])
    },
    { name: 'left join', sql: 'SELECT o.id, i.qty FROM orders o LEFT JOIN order_items i ON o.id = i.order_id', exact: true },
    { name: 'right join', sql: 'SELECT o.id, i.qty FROM orders o RIGHT OUTER JOIN order_items i ON o.id = i.order_id', exact: true },
    {
        name: 'full join',
        sql: 'SELECT a.x, b.y FROM a FULL JOIN b ON a.k = b.k',
        exact: true,
        check: (m) => assert.equal(m.joins[0].type, 'FULL')
    },
    {
        name: 'cross join',
        sql: 'SELECT a.x, b.y FROM a CROSS JOIN b',
        exact: true,
        check: (m) => assert.equal(m.joins[0].type, 'CROSS')
    },
    {
        name: 'join using',
        sql: 'SELECT * FROM orders JOIN order_items USING (order_id, shop_id)',
        exact: true,
        check: (m) => {
            assert.equal(m.joins[0].using, true);
            assert.deepEqual(m.joins[0].pairs, [{ leftColumn: 'order_id', rightColumn: 'order_id' }, { leftColumn: 'shop_id', rightColumn: 'shop_id' }]);
        }
    },
    {
        name: 'multi-column join with an extra raw condition',
        sql: 'SELECT * FROM a LEFT JOIN b ON a.k1 = b.k1 AND a.k2 >= b.k2 AND b.active = true',
        exact: true,
        check: (m) => {
            assert.deepEqual(m.joins[0].pairs, [{ leftColumn: 'k1', rightColumn: 'k1' }, { leftColumn: 'k2', rightColumn: 'k2', operator: '>=' }]);
            assert.equal(m.joins[0].condition, 'b.active = true');
        }
    },
    { name: 'natural join', sql: 'SELECT * FROM a NATURAL LEFT JOIN b', exact: true },
    {
        name: 'three tables, one joined to two',
        sql: 'SELECT * FROM a JOIN b ON a.id = b.a_id JOIN c ON b.id = c.b_id AND a.id = c.a_id',
        exact: true,
        check: (m) => assert.deepEqual(m.joins.map((j) => [j.leftTableId, j.rightTableId]), [['t1', 't2'], ['t2', 't3'], ['t1', 't3']])
    },
    {
        name: 'reversed join condition is normalised to left = right',
        sql: 'SELECT * FROM a JOIN b ON b.a_id = a.id',
        exact: false,
        check: (m, sql) => {
            assert.deepEqual(m.joins[0].pairs, [{ leftColumn: 'id', rightColumn: 'a_id' }]);
            assert.match(sql, /INNER JOIN b ON a\.id = b\.a_id/);
        }
    },
    {
        name: 'comma join with its condition in WHERE becomes an INNER JOIN',
        sql: 'SELECT a.x, b.y FROM a, b WHERE a.id = b.a_id AND a.x > 5',
        exact: false,
        check: (m, sql) => {
            assert.equal(m.joins.length, 1);
            assert.equal(m.joins[0].type, 'INNER');
            assert.deepEqual(m.columns[0].criteria, ['> 5']);
            assert.match(sql, /INNER JOIN b ON a\.id = b\.a_id/);
            assert.ok(m.warnings.some((w) => w.includes('INNER JOIN')));
        }
    },
    {
        name: 'comma join without condition stays a comma join',
        sql: 'SELECT * FROM a, b',
        exact: true,
        check: (m, sql) => {
            assert.equal(m.joins.length, 0);
            assert.match(sql, /a,\n {4}b/);
        }
    },
    {
        name: 'WHERE condition on the nullable side of an outer join is not turned into a join',
        sql: 'SELECT * FROM a LEFT JOIN x ON a.id = x.a_id, b WHERE x.id = b.x_id',
        exact: true,
        check: (m) => {
            assert.equal(m.joins.length, 1);
            assert.deepEqual(m.whereExtra, ['x.id = b.x_id']);
        }
    },
    {
        name: 'nested join is flattened',
        sql: 'SELECT * FROM a JOIN (b JOIN c ON b.id = c.b_id) ON a.id = b.a_id',
        exact: false,
        check: (m) => {
            assert.equal(m.joins.length, 2);
            assert.ok(m.warnings.some((w) => w.includes('nested') && w.includes('flat')));
        }
    },
    {
        name: 'nested outer join on the right of an inner join is kept raw',
        sql: 'SELECT * FROM a JOIN (b LEFT JOIN c ON b.id = c.bid) ON a.x = c.x',
        exact: true,
        check: (m) => {
            assert.deepEqual(m.tables.map((t) => [t.kind, t.name ?? t.sql]), [['relation', 'a'], ['function', '(b LEFT JOIN c ON b.id = c.bid)']]);
            assert.deepEqual(m.joins.map((j) => [j.type, j.pairs, j.condition]), [['INNER', [], 'a.x = c.x']]);
            assert.ok(m.warnings.some((w) => w.includes('nested') && w.includes('raw SQL')));
        }
    },
    {
        name: 'nested inner join on the right of an outer join is kept raw',
        sql: 'SELECT * FROM a LEFT JOIN (b JOIN c ON b.id = c.bid) ON a.id = b.aid',
        exact: true,
        check: (m) => assert.deepEqual(m.tables.map((t) => t.kind), ['relation', 'function'])
    },
    {
        name: 'aggregates, GROUP BY, HAVING, ORDER BY alias',
        sql: 'SELECT d.name, count(*) AS cnt, sum(e.salary), avg(DISTINCT e.age) FROM dept d JOIN emp e ON d.id = e.dept_id GROUP BY d.name HAVING count(*) > 10 ORDER BY cnt DESC',
        exact: true,
        check: (m) => {
            assert.deepEqual(m.columns.map((c) => [c.aggregate, c.expression]), [[undefined, 'd.name'], ['COUNT', '*'], ['SUM', 'e.salary'], ['AVG DISTINCT', 'e.age']]);
            assert.equal(m.columns[0].groupBy, true);
            assert.equal(m.columns[1].having, '> 10');
            assert.equal(m.columns[1].sortType, 'DESC');
            assert.equal(m.autoGroupBy, undefined);
        }
    },
    {
        name: 'COUNT DISTINCT',
        sql: 'SELECT count(DISTINCT customer_id) FROM orders',
        exact: true,
        check: (m) => assert.equal(m.columns[0].aggregate, 'COUNT DISTINCT')
    },
    {
        name: 'GROUP BY ordinal',
        sql: 'SELECT region, count(*) FROM sales GROUP BY 1',
        exact: false,
        check: (m, sql) => {
            assert.equal(m.columns[0].groupBy, true);
            assert.match(sql, /GROUP BY\n {4}region/);
        }
    },
    {
        name: 'GROUP BY on a column that is not selected adds a hidden column',
        sql: 'SELECT count(*) FROM emp GROUP BY dept',
        exact: true,
        check: (m) => assert.deepEqual(m.columns[1], { id: 'c2', expression: 'dept', output: false, groupBy: true, criteria: [], tableId: 't1', column: 'dept' })
    },
    {
        name: 'GROUP BY a bare name groups by the input column, not by an output alias of the same name',
        sql: 'SELECT upper(name) AS name, count(*) FROM t GROUP BY name',
        exact: true,
        check: (m, sql) => {
            assert.equal(m.columns[0].groupBy, false);
            assert.deepEqual([m.columns[2].expression, m.columns[2].output, m.columns[2].groupBy], ['name', false, true]);
            assert.match(sql, /GROUP BY\n {4}name$/);
        }
    },
    {
        name: 'functional dependency: grouping by less than the plain columns turns auto GROUP BY off',
        sql: 'SELECT c.id, c.name, count(*) FROM customers c JOIN orders o ON c.id = o.customer_id GROUP BY c.id',
        exact: true,
        check: (m) => assert.equal(m.autoGroupBy, false)
    },
    {
        name: 'ROLLUP is kept raw',
        sql: 'SELECT dept, sum(x) FROM t GROUP BY ROLLUP (dept)',
        exact: true,
        check: (m) => assert.deepEqual(m.groupByExtra, ['ROLLUP (dept)'])
    },
    {
        name: 'HAVING across expressions is kept raw',
        sql: 'SELECT dept, count(*) FROM emp GROUP BY dept HAVING max(salary) < 100 AND count(*) > avg(salary)',
        exact: true,
        check: (m) => {
            assert.deepEqual(m.havingExtra, ['count(*) > avg(salary)']);
            assert.equal(m.columns[2].aggregate, 'MAX');
            assert.equal(m.columns[2].output, false);
            assert.equal(m.columns[2].having, '< 100');
        }
    },
    { name: 'DISTINCT', sql: 'SELECT DISTINCT city FROM customers ORDER BY city', exact: true, check: (m) => assert.equal(m.distinct, true) },
    {
        name: 'DISTINCT ON',
        sql: 'SELECT DISTINCT ON (customer_id) customer_id, created_at FROM orders ORDER BY customer_id, created_at DESC',
        exact: true,
        check: (m) => assert.deepEqual(m.distinctOn, ['customer_id'])
    },
    {
        name: 'ORDER BY ordinal, NULLS LAST and an expression',
        sql: 'SELECT name, created_at FROM t ORDER BY 2 DESC NULLS LAST, lower(name)',
        exact: false,
        check: (m) => {
            assert.deepEqual([m.columns[1].sortType, m.columns[1].sortOrder, m.columns[1].nulls], ['DESC', 1, 'LAST']);
            assert.deepEqual([m.columns[2].expression, m.columns[2].output, m.columns[2].sortOrder], ['lower(name)', false, 2]);
        }
    },
    {
        name: 'ORDER BY ordinal after a star keeps the ordinal',
        sql: 'SELECT *, x FROM ONLY parent p ORDER BY 2 DESC',
        exact: true,
        check: (m, sql) => {
            assert.equal(m.tables[0].only, true);
            assert.deepEqual([m.columns[2].expression, m.columns[2].output], ['2', false]);
            assert.match(sql, /FROM\n {4}ONLY parent p\nORDER BY\n {4}2 DESC$/);
        }
    },
    {
        name: 'OR criteria rows',
        sql: "SELECT * FROM emp WHERE (dept = 'A' AND salary > 1000) OR dept = 'B'",
        exact: true,
        check: (m) => {
            const dept = m.columns.find((c) => c.expression === 'dept');
            const salary = m.columns.find((c) => c.expression === 'salary');
            assert.deepEqual(dept?.criteria, ["= 'A'", "= 'B'"]);
            assert.deepEqual(salary?.criteria, ['> 1000']);
        }
    },
    {
        name: 'OR group next to a plain condition stays raw',
        sql: 'SELECT * FROM t WHERE t.x = 1 AND (t.y = 2 OR t.z = 3)',
        exact: true,
        check: (m) => {
            assert.deepEqual(m.whereExtra, ['(t.y = 2 OR t.z = 3)']);
            assert.deepEqual(m.columns[1].criteria, ['= 1']);
        }
    },
    {
        name: 'IN, BETWEEN, LIKE, IS NULL and NOT ILIKE criteria',
        sql: "SELECT * FROM emp WHERE dept IN ('A', 'B') AND salary BETWEEN 1000 AND 2000 AND name LIKE 'M%' AND manager_id IS NULL AND name NOT ILIKE '%x%' AND dept NOT IN ('C')",
        exact: true,
        check: (m) => {
            assert.deepEqual(m.columns.slice(1).map((c) => [c.expression, c.criteria]), [
                ['dept', ["IN ('A', 'B')"]],
                ['salary', ['BETWEEN 1000 AND 2000']],
                ['name', ["LIKE 'M%'"]],
                ['manager_id', ['IS NULL']],
                ['name', ["NOT ILIKE '%x%'"]],
                ['dept', ["NOT IN ('C')"]]
            ]);
            assert.equal(m.whereExtra, undefined);
        }
    },
    {
        name: 'functions in the select list',
        sql: "SELECT upper(c.name) AS uname, coalesce(c.phone, '-') phone, now() FROM customers c",
        exact: true,
        check: (m) => assert.deepEqual(m.columns.map((c) => c.expression), ['upper(c.name)', "coalesce(c.phone, '-')", 'now()'])
    },
    {
        name: 'CASE expression',
        sql: "SELECT CASE WHEN amount > 100 THEN 'big' ELSE 'small' END AS size FROM orders WHERE CASE WHEN a AND b THEN 1 END = 1 AND c = 2",
        exact: true,
        check: (m) => assert.equal(m.columns[0].expression, "CASE WHEN amount > 100 THEN 'big' ELSE 'small' END")
    },
    {
        name: 'casts',
        sql: "SELECT amount::numeric(10,2), CAST(created_at AS date), x::timestamp with time zone FROM orders WHERE created_at::date = '2024-01-01'::date",
        exact: true,
        check: (m) => {
            assert.equal(m.columns[2].expression, 'x::timestamp with time zone');
            assert.deepEqual(m.columns[3].criteria, ["= '2024-01-01'::date"]);
        }
    },
    {
        name: 'subquery in FROM',
        sql: 'SELECT s.total FROM (SELECT customer_id, sum(amount) AS total FROM orders GROUP BY customer_id) s WHERE s.total > 100',
        exact: true,
        check: (m) => {
            assert.equal(m.tables[0].kind, 'subquery');
            assert.equal(m.tables[0].sql, 'SELECT customer_id, sum(amount) AS total FROM orders GROUP BY customer_id');
            assert.deepEqual(m.tables[0].columns, ['customer_id', 'total']);
            assert.equal(m.columns[0].tableId, 't1');
        }
    },
    {
        name: 'subqueries in WHERE',
        sql: 'SELECT * FROM customers c WHERE c.id IN (SELECT customer_id FROM orders) AND c.id NOT IN (SELECT 1) AND EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)',
        exact: true,
        check: (m) => {
            assert.deepEqual(m.columns[1].criteria, ['IN (SELECT customer_id FROM orders)']);
            assert.deepEqual(m.columns[2].criteria, ['NOT IN (SELECT 1)']);
            assert.deepEqual(m.whereExtra, ['EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)']);
        }
    },
    {
        name: 'CTE',
        sql: 'WITH RECURSIVE big (id) AS MATERIALIZED (SELECT id FROM orders WHERE amount > 100), small AS (SELECT 1) SELECT b.id FROM big b',
        exact: true,
        check: (m) => {
            assert.equal(m.recursive, true);
            assert.deepEqual(m.ctes[0], { name: 'big', sql: 'SELECT id FROM orders WHERE amount > 100', aliasColumns: ['id'], materialized: true, columns: ['id'] });
            assert.equal(m.ctes[1].sql, 'SELECT 1');
        }
    },
    {
        name: 'UNION is kept as raw tail',
        sql: 'SELECT id FROM a WHERE a.x = 1 UNION ALL SELECT id FROM b ORDER BY 1 LIMIT 3',
        exact: true,
        check: (m) => {
            assert.equal(m.tail, 'UNION ALL SELECT id FROM b ORDER BY 1 LIMIT 3');
            assert.equal(m.limit, undefined);
            assert.ok(m.warnings.some((w) => w.includes('UNION')));
        }
    },
    {
        name: 'LIMIT and OFFSET',
        sql: 'SELECT * FROM t ORDER BY id LIMIT 10 OFFSET 20',
        exact: true,
        check: (m) => assert.deepEqual([m.limit, m.offset], ['10', '20'])
    },
    {
        name: 'OFFSET … FETCH FIRST',
        sql: 'SELECT * FROM t ORDER BY id OFFSET 5 ROWS FETCH FIRST 10 ROWS ONLY',
        exact: true,
        check: (m) => assert.deepEqual([m.limit, m.offset, m.limitWithTies], ['10', '5', undefined])
    },
    {
        name: 'FETCH WITH TIES',
        sql: 'SELECT * FROM t ORDER BY id FETCH FIRST 3 ROWS WITH TIES',
        exact: true,
        check: (m) => assert.equal(m.limitWithTies, true)
    },
    {
        name: "the user's schema-qualified function call",
        sql: 'SELECT mitarbeiter.region(mit_id) as region, mit_id FROM mitarbeiter',
        exact: true,
        check: (m, sql) => {
            assert.deepEqual(m.columns.map((c) => [c.expression, c.alias, c.column]), [['mitarbeiter.region(mit_id)', 'region', undefined], ['mit_id', undefined, 'mit_id']]);
            assert.equal(sql, 'SELECT\n    mitarbeiter.region(mit_id) AS region,\n    mit_id\nFROM\n    mitarbeiter');
        }
    },
    {
        name: 'window function stays a raw expression',
        sql: 'SELECT id, row_number() OVER (PARTITION BY dept ORDER BY salary DESC) AS rn, count(*) OVER () FROM emp',
        exact: true,
        check: (m) => assert.equal(m.columns[2].aggregate, undefined)
    },
    {
        name: 'non-ASCII text keeps the right offsets',
        sql: "SELECT m.\"Straße\", 'Grüße 😀' AS gruß, m.ort FROM mitarbeiter m WHERE m.ort = 'München'",
        exact: true,
        check: (m) => {
            assert.deepEqual(m.columns.map((c) => c.expression), ['m."Straße"', "'Grüße 😀'", 'm.ort']);
            assert.deepEqual(m.columns[2].criteria, ["= 'München'"]);
        }
    },
    {
        name: 'LATERAL table function with column aliases',
        sql: 'SELECT * FROM t, LATERAL jsonb_array_elements(t.data) WITH ORDINALITY AS e(value, n)',
        exact: true,
        check: (m) => assert.deepEqual([m.tables[1].kind, m.tables[1].sql, m.tables[1].alias, m.tables[1].aliasColumns, m.tables[1].lateral], ['function', 'jsonb_array_elements(t.data) WITH ORDINALITY', 'e', ['value', 'n'], true])
    },
    {
        name: 'reserved words as names',
        sql: 'SELECT t."from", t.order, t.x AS "select" FROM "user" t',
        exact: true,
        check: (m) => assert.equal(m.tables[0].name, 'user')
    },
    {
        name: 'locking clause',
        sql: 'SELECT * FROM t WHERE id = 1 FOR UPDATE SKIP LOCKED',
        exact: true,
        check: (m) => assert.equal(m.locking, 'FOR UPDATE SKIP LOCKED')
    },
    {
        name: 'IS DISTINCT FROM in select list and WHERE',
        sql: 'SELECT a IS DISTINCT FROM b AS changed FROM t WHERE a IS NOT DISTINCT FROM 5',
        exact: true,
        check: (m) => assert.deepEqual(m.columns[1].criteria, ['IS NOT DISTINCT FROM 5'])
    },
    {
        name: 'ordered-set aggregate',
        sql: 'SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY salary) FROM emp',
        exact: true
    },
    {
        name: 'comments inside expressions are kept, others reported',
        sql: 'SELECT a /* inline */ + 1 AS x, -- second\n b FROM t',
        exact: true,
        check: (m) => {
            assert.equal(m.columns[0].expression, 'a /* inline */ + 1');
            assert.ok(m.warnings.some((w) => w.includes('Comments')));
        }
    },
    {
        name: 'trailing semicolon',
        sql: 'SELECT 1 AS one;',
        exact: true
    }
];

// ===== round trip =====

for (const c of CORPUS) {
    test(`round trip: ${c.name}`, async () => {
        const first = await parseSelect(c.sql);
        const generated = generateSql(first);
        await assert.doesNotReject(parseSql(generated), `generated SQL does not parse:\n${generated}`);
        const second = await parseSelect(generated);
        assert.deepEqual(canonical(second), canonical(first), `model changed after a round trip:\n${generated}`);
        assert.equal(generateSql(second), generated, 'generating twice is not stable');
        if (c.exact) {
            assert.deepEqual(await normalizedTree(generated), await normalizedTree(c.sql), `parse tree differs:\n${generated}`);
        }
        c.check?.(first, generated);
    });
}

test('the round-trip corpus has at least 25 queries', () => {
    assert.ok(CORPUS.length >= 25);
});

// ===== FROM order =====

/** The tables in FROM order and the AND-ed conditions of ON and WHERE: all that decides a query of inner joins. */
async function innerJoinSignature(sql: string): Promise<{ tables: string[]; conditions: string[] }> {
    const select = ((await normalizedTree(sql)) as any[])[0].SelectStmt;
    const tables: string[] = [];
    const conditions: string[] = [];
    const addConditions = (node: any) => {
        if (!node) return;
        if (node.BoolExpr?.boolop === 'AND_EXPR') node.BoolExpr.args.forEach(addConditions);
        else conditions.push(JSON.stringify(node));
    };
    const visit = (node: any) => {
        if (node.RangeVar) {
            tables.push(node.RangeVar.relname);
            return;
        }
        assert.equal(node.JoinExpr?.jointype, 'JOIN_INNER', `not an inner join: ${JSON.stringify(node)}`);
        visit(node.JoinExpr.larg);
        visit(node.JoinExpr.rarg);
        addConditions(node.JoinExpr.quals);
    };
    select.fromClause.forEach(visit);
    addConditions(select.whereClause);
    return { tables, conditions: conditions.sort() };
}

test('a flattened nested inner join generates an equivalent query with the tables in their order', async () => {
    const sql = 'SELECT * FROM a JOIN (b JOIN c ON b.id = c.bid) ON a.x = c.x';
    const generated = generateSql(await parseSelect(sql));
    assert.match(generated, /FROM\n {4}a\n {4}CROSS JOIN b\n {4}INNER JOIN c ON a\.x = c\.x AND b\.id = c\.bid$/);
    assert.deepEqual(await innerJoinSignature(generated), await innerJoinSignature(sql));
});

test('a raw condition of a flattened nested join goes to the join of its last table', async () => {
    const generated = generateSql(await parseSelect('SELECT a.v FROM a JOIN (b JOIN c ON b.id = c.bid) ON a.id = b.aid AND f(c.x)'));
    assert.match(generated, /FROM\n {4}a\n {4}INNER JOIN b ON a\.id = b\.aid\n {4}INNER JOIN c ON f\(c\.x\) AND b\.id = c\.bid$/);
});

test('SELECT * keeps the order of comma-separated tables joined in WHERE', async () => {
    const sql = 'SELECT * FROM a, b, c WHERE a.id = c.aid AND b.id = c.bid';
    const generated = generateSql(await parseSelect(sql));
    assert.match(generated, /FROM\n {4}a\n {4}CROSS JOIN b\n {4}INNER JOIN c ON a\.id = c\.aid AND b\.id = c\.bid$/);
    assert.deepEqual(await innerJoinSignature(generated), await innerJoinSignature(sql));
    const again = generateSql(await parseSelect(generated));
    assert.equal(again, generated, 'generating twice is not stable');
});

test('outer joins keep their order and their meaning when the tables are joined in WHERE as well', async () => {
    for (const sql of [
        'SELECT * FROM a LEFT JOIN b ON a.id = b.aid INNER JOIN c ON b.id = c.bid AND a.id = c.aid RIGHT JOIN d ON c.id = d.cid',
        'SELECT * FROM a RIGHT JOIN b ON a.id = b.aid, c WHERE c.bid = b.id',
        'SELECT * FROM a LEFT JOIN b ON a.id = b.aid, c, d WHERE a.id = d.aid AND c.id = d.cid'
    ]) {
        const generated = generateSql(await parseSelect(sql));
        assert.equal(generateSql(await parseSelect(generated)), generated, `not stable:\n${generated}`);
        const relations = async (text: string) => JSON.stringify(await normalizedTree(text)).match(/"relname":"\w+"/g);
        assert.deepEqual(await relations(generated), await relations(sql), `the tables changed their order:\n${generated}`);
    }
    assert.equal(
        generateSql(await parseSelect('SELECT * FROM a LEFT JOIN b ON a.id = b.aid INNER JOIN c ON b.id = c.bid AND a.id = c.aid RIGHT JOIN d ON c.id = d.cid')),
        'SELECT\n    *\nFROM\n    a\n    LEFT JOIN b ON a.id = b.aid\n    INNER JOIN c ON b.id = c.bid AND a.id = c.aid\n    RIGHT JOIN d ON c.id = d.cid'
    );
});

// ===== parseSelect errors =====

test('parseSelect rejects statements other than SELECT', async () => {
    await assert.rejects(parseSelect('UPDATE t SET a = 1'), /Only a SELECT statement can be edited in the Query Builder/);
    await assert.rejects(parseSelect('SELECT 1; SELECT 2'), /single SELECT/);
    await assert.rejects(parseSelect('SELECT * INTO new_t FROM t'), /SELECT INTO/);
    await assert.rejects(parseSelect('VALUES (1)'), /starts with SELECT/);
    await assert.rejects(parseSelect('   '), /Enter a SELECT statement/);
});

// ===== generateSql =====

function model(partial: Partial<QueryModel>): QueryModel {
    return { ...createEmptyModel(), ...partial };
}

test('generateSql writes SELECT * without output columns and quotes names only when needed', () => {
    const m = model({ tables: [{ id: 't1', kind: 'relation', schema: 'Sales', name: 'order items', alias: 'oi' }] });
    assert.equal(generateSql(m), 'SELECT\n    *\nFROM\n    "Sales"."order items" oi');
});

test('generateSql ORs criteria rows and ANDs the criteria of one row', () => {
    const m = model({
        tables: [{ id: 't1', kind: 'relation', name: 'emp', alias: 'e' }],
        columns: [
            { id: 'c1', expression: 'e.dept', output: true, groupBy: false, criteria: ["'A'", "= 'B'"] },
            { id: 'c2', expression: 'e.salary', output: false, groupBy: false, criteria: ['> 10', ''] }
        ],
        whereExtra: ['e.active']
    });
    assert.equal(generateSql(m), [
        'SELECT', '    e.dept', 'FROM', '    emp e', 'WHERE',
        '    (', "        (e.dept = 'A' AND e.salary > 10)", "        OR e.dept = 'B'", '    )', '    AND e.active'
    ].join('\n'));
});

test('generateSql groups by plain non-aggregated output columns once an aggregate is set', () => {
    const m = model({
        tables: [{ id: 't1', kind: 'relation', name: 'emp', alias: 'e' }],
        columns: [
            { id: 'c1', expression: 'e.dept', tableId: 't1', column: 'dept', output: true, groupBy: false, criteria: [] },
            { id: 'c2', expression: "'x'", output: true, groupBy: false, criteria: [] },
            { id: 'c3', expression: 'e.salary', tableId: 't1', column: 'salary', output: true, aggregate: 'SUM', groupBy: false, criteria: [], having: '100' }
        ]
    });
    assert.deepEqual(groupByExpressions(m), ['e.dept']);
    assert.match(generateSql(m), /GROUP BY\n {4}e\.dept\nHAVING\n {4}SUM\(e\.salary\) = 100$/);
    assert.deepEqual(groupByExpressions({ ...m, autoGroupBy: false }), []);
});

test('generateSql places tables along joins, flips the type for the left side and separates unconnected tables with commas', () => {
    const m = model({
        tables: [
            { id: 't1', kind: 'relation', name: 'a' },
            { id: 't2', kind: 'relation', name: 'b' },
            { id: 't3', kind: 'relation', name: 'c' },
            { id: 't4', kind: 'subquery', sql: 'SELECT 1 AS one', alias: 's' }
        ],
        joins: [
            { id: 'j1', leftTableId: 't3', rightTableId: 't1', type: 'LEFT', pairs: [{ leftColumn: 'a_id', rightColumn: 'id' }] },
            { id: 'j2', leftTableId: 't1', rightTableId: 't2', type: 'CROSS', pairs: [], condition: 'a.x = 1 OR b.y = 2' },
            { id: 'j3', leftTableId: 't2', rightTableId: 't3', type: 'INNER', pairs: [{ leftColumn: 'id', rightColumn: 'b_id' }] }
        ]
    });
    assert.equal(generateSql(m), [
        'SELECT', '    *', 'FROM',
        '    a',
        '    RIGHT JOIN c ON c.a_id = a.id',
        '    INNER JOIN b ON (a.x = 1 OR b.y = 2) AND b.id = c.b_id,',
        '    (SELECT 1 AS one) s'
    ].join('\n'));
});

test('criteriaCondition treats a bare value as equality and parenthesizes boolean expressions', () => {
    assert.equal(criteriaCondition('x', '5'), 'x = 5');
    assert.equal(criteriaCondition('x', "like 'a%'"), "x like 'a%'");
    assert.equal(criteriaCondition('x', '<> 3'), 'x <> 3');
    assert.equal(criteriaCondition('a OR b', 'IS TRUE'), '(a OR b) IS TRUE');
});

// ===== lexer =====

test('tokenizeSql recognises strings, dollar quotes, quoted names, comments and operators', () => {
    const tokens = tokenizeSql("SELECT E'it\\'s', $f$a;b$f$, \"x\"\"y\", $1 /* c /* n */ */ --x\n a<>-1, b::int");
    assert.deepEqual(tokens.map((t) => [t.type, t.text]), [
        ['word', 'SELECT'], ['string', "E'it\\'s'"], ['punct', ','], ['string', '$f$a;b$f$'], ['punct', ','],
        ['qident', '"x""y"'], ['punct', ','], ['param', '$1'], ['comment', '/* c /* n */ */'], ['comment', '--x'],
        ['word', 'a'], ['op', '<>'], ['op', '-'], ['number', '1'], ['punct', ','], ['word', 'b'], ['op', '::'], ['word', 'int']
    ]);
});

test('normalizeExpressionKey ignores case, spacing and unnecessary quotes', () => {
    assert.equal(normalizeExpressionKey('COUNT( "x" )'), normalizeExpressionKey('count(x)'));
    assert.notEqual(normalizeExpressionKey('"X"'), normalizeExpressionKey('x'));
});

test('tokenizeSql reads :name placeholders as parameters, but not casts, := or array slices', () => {
    const tokens = tokenizeSql(`a = :id, :'from'::date, :"col", x := 1, v[lo:hi], ARRAY[:p], ':s'`);
    assert.deepEqual(tokens.filter((t) => t.type === 'param').map((t) => t.text), [':id', `:'from'`, ':"col"', ':p']);
    assert.deepEqual(tokens.filter((t) => t.text === ':').length, 2, 'the colons of := and of the slice');
    assert.ok(tokens.some((t) => t.type === 'op' && t.text === '::'));
});

test('placeholders are values to the grid helpers', () => {
    assert.equal(criteriaCondition('m.mit_id', '= :id'), 'm.mit_id = :id');
    assert.equal(criteriaCondition('m.mit_id', ':id'), 'm.mit_id = :id');
    assert.equal(criteriaCondition('m.mit_id', `:'from'`), `m.mit_id = :'from'`);
    assert.equal(hasTopLevelOr('a = :or'), false);
    assert.notEqual(normalizeExpressionKey(':a'), normalizeExpressionKey(': a'));
});

// ===== edit helpers =====

const FKS: QbForeignKey[] = [
    { name: 'orders_customer_fk', schema: 'public', table: 'orders', columns: ['customer_id'], refSchema: 'public', refTable: 'customers', refColumns: ['id'] },
    { name: 'items_order_fk', schema: 'public', table: 'order_items', columns: ['order_id', 'shop_id'], refSchema: 'public', refTable: 'orders', refColumns: ['id', 'shop_id'] }
];

test('addTable suggests unique aliases and joins along foreign keys in both directions', () => {
    let m = createEmptyModel();
    const customers = addTable(m, { schema: 'public', name: 'customers', columns: ['id', 'name'] }, FKS);
    m = customers.model;
    assert.equal(customers.table.alias, 'c');
    assert.deepEqual(customers.joins, []);
    const items = addTable(m, { schema: 'public', name: 'order_items', columns: ['oi_id'] }, FKS);
    m = items.model;
    assert.equal(items.table.alias, 'oi');
    const orders = addTable(m, { schema: 'public', name: 'orders', columns: ['ord_id'] }, FKS);
    m = orders.model;
    assert.equal(orders.table.alias, 'ord');
    assert.deepEqual(orders.joins.map((j) => [j.leftTableId, j.rightTableId, j.pairs]), [
        [customers.table.id, orders.table.id, [{ leftColumn: 'id', rightColumn: 'customer_id' }]],
        [items.table.id, orders.table.id, [{ leftColumn: 'order_id', rightColumn: 'id' }, { leftColumn: 'shop_id', rightColumn: 'shop_id' }]]
    ]);
    const second = addTable(m, { schema: 'public', name: 'customers' }, [], { autoJoin: false });
    assert.equal(second.table.alias, 'c2');
    assert.match(generateSql(m), /FROM\n {4}public\.customers c\n {4}INNER JOIN public\.orders ord ON c\.id = ord\.customer_id\n {4}INNER JOIN public\.order_items oi ON oi\.order_id = ord\.id AND oi\.shop_id = ord\.shop_id$/);
});

test('addTable does not modify the model it is given', () => {
    const m = createEmptyModel();
    addTable(m, { name: 'customers' });
    assert.deepEqual(m, createEmptyModel());
});

/** A custom mapping orders(cust_no, shop) -> customers(number, shop) with a condition on orders. */
const MAPPING_EDGE: QbMappingEdge = {
    mapping: true, schema: 'public', table: 'orders', columns: ['cust_no', 'shop'],
    refSchema: 'public', refTable: 'customers', refColumns: ['number', 'shop'],
    conditions: [{ column: 'Kind', operator: '=', value: "O'Brien" }, { column: 'level', operator: '>=', value: '2' }]
};

test('addTable joins along a custom mapping in either direction, with its pairs and its conditions on the source table', async () => {
    const forward = addTable(addTable(createEmptyModel(), { schema: 'public', name: 'customers', alias: 'c' }).model,
        { schema: 'public', name: 'orders', alias: 'o' }, [MAPPING_EDGE]);
    assert.deepEqual(forward.joins.map((j) => [j.pairs, j.condition]), [[
        [{ leftColumn: 'number', rightColumn: 'cust_no' }, { leftColumn: 'shop', rightColumn: 'shop' }],
        `o."Kind" = 'O''Brien' AND o.level >= 2`
    ]]);
    const reverse = addTable(addTable(createEmptyModel(), { schema: 'public', name: 'orders', alias: 'o' }).model,
        { schema: 'public', name: 'customers', alias: 'c' }, [MAPPING_EDGE]);
    assert.deepEqual(reverse.joins.map((j) => [j.pairs, j.condition]), [[
        [{ leftColumn: 'cust_no', rightColumn: 'number' }, { leftColumn: 'shop', rightColumn: 'shop' }],
        `o."Kind" = 'O''Brien' AND o.level >= 2`
    ]]);
    const sql = generateSql(reverse.model);
    assert.match(sql, /INNER JOIN public\.customers c ON o\.cust_no = c\.number AND o\.shop = c\.shop AND o\."Kind" = 'O''Brien' AND o\.level >= 2/);
    assert.equal(generateSql(await parseSelect(sql)), sql, 'the generated SQL is read back unchanged');
});

test('addTable puts the pairs of a custom mapping into the foreign-key join of the same tables, without repeating a pair', async () => {
    const fk: QbForeignKey = { schema: 'public', table: 'orders', columns: ['Cust_No'], refSchema: 'public', refTable: 'customers', refColumns: ['number'] };
    const base = addTable(createEmptyModel(), { schema: 'public', name: 'customers', alias: 'c' }).model;
    const { joins, model } = addTable(base, { schema: 'public', name: 'orders', alias: 'o' }, [MAPPING_EDGE, fk]);
    assert.equal(joins.length, 1);
    assert.equal(model.joins.length, 1);
    assert.deepEqual(joins[0].pairs, [{ leftColumn: 'number', rightColumn: 'Cust_No' }, { leftColumn: 'shop', rightColumn: 'shop' }]);
    assert.equal(joins[0].condition, `o."Kind" = 'O''Brien' AND o.level >= 2`);
    const sql = generateSql(model);
    assert.equal(generateSql(await parseSelect(sql)), sql);
    const fkOnly = addTable(base, { schema: 'public', name: 'orders', alias: 'o' }, [fk]);
    assert.equal(fkOnly.joins[0].condition, undefined, 'without a mapping the foreign-key join is unchanged');
});

test('toggleColumn adds, hides and removes grid columns', () => {
    const { model: m0, table } = addTable(createEmptyModel(), { name: 'emp', alias: 'e' });
    let m = toggleColumn(m0, table.id, 'name');
    m = toggleColumn(m, table.id, 'Salary');
    assert.deepEqual(m.columns.map((c) => c.expression), ['e.name', 'e."Salary"']);
    assert.deepEqual(selectedColumns(m, table.id), ['name', 'Salary']);
    m = setCriteria(m, m.columns[1].id, 0, '> 10');
    m = toggleColumn(m, table.id, 'Salary');
    assert.equal(m.columns[1].output, false, 'a column with criteria is hidden, not removed');
    m = toggleColumn(m, table.id, 'name');
    assert.deepEqual(m.columns.map((c) => c.column), ['Salary']);
    m = toggleColumn(m, table.id, 'Salary', true);
    assert.equal(m.columns[0].output, true);
});

test('removeTable drops its joins and columns', () => {
    const a = addTable(createEmptyModel(), { name: 'orders' }, FKS);
    const b = addTable(a.model, { name: 'customers' }, FKS);
    let m = toggleColumn(b.model, a.table.id, 'id');
    m = toggleColumn(m, b.table.id, 'name');
    assert.equal(m.joins.length, 1);
    m = removeTable(m, b.table.id);
    assert.deepEqual([m.tables.length, m.joins.length, m.columns.map((c) => c.column)], [1, 0, ['id']]);
});

test('setSort appends, inserts and removes sort positions without gaps', () => {
    let m = createEmptyModel();
    for (const e of ['a', 'b', 'c']) m = addColumn(m, { expression: e }).model;
    const [a, b, c] = m.columns.map((x) => x.id);
    m = setSort(m, a, 'ASC');
    m = setSort(m, b, 'DESC');
    m = setSort(m, c, 'ASC', 1, 'LAST');
    assert.deepEqual(m.columns.map((x) => x.sortOrder), [2, 3, 1]);
    m = setSort(m, c, undefined);
    assert.deepEqual(m.columns.map((x) => [x.sortType, x.sortOrder]), [['ASC', 1], ['DESC', 2], [undefined, undefined]]);
    assert.match(generateSql(m), /ORDER BY\n {4}a ASC,\n {4}b DESC$/);
});

test('setTableAlias rewrites qualifiers in expressions, criteria and conditions', () => {
    const a = addTable(createEmptyModel(), { name: 'orders', alias: 'o' });
    const b = addTable(a.model, { name: 'customers', alias: 'c' });
    let m = toggleColumn(b.model, a.table.id, 'id');
    m = addColumn(m, { expression: 'upper(o.note) || oo.x', criteria: ["= o.kind"] }).model;
    m = addJoin(m, { leftTableId: a.table.id, rightTableId: b.table.id, pairs: [{ leftColumn: 'customer_id', rightColumn: 'id' }], condition: 'o.active' }).model;
    m = setTableAlias(m, a.table.id, 'ord');
    assert.deepEqual(m.columns.map((c) => c.expression), ['ord.id', 'upper(ord.note) || oo.x']);
    assert.deepEqual(m.columns[1].criteria, ['= ord.kind']);
    assert.equal(m.joins[0].condition, 'ord.active');
    m = setTableAlias(m, a.table.id, undefined);
    assert.equal(m.columns[0].expression, 'orders.id');
    assert.equal(renameQualifier('"o".x + o2.o + x.o.y', 'o', 'p'), 'p.x + o2.o + x.o.y');
});

test('moveColumn, updateColumn and connectColumns edit the grid and joins', () => {
    let m = createEmptyModel();
    for (const e of ['a', 'b', 'c']) m = addColumn(m, { expression: e }).model;
    m = moveColumn(m, m.columns[2].id, 0);
    assert.deepEqual(m.columns.map((c) => c.expression), ['c', 'a', 'b']);
    m = updateColumn(m, m.columns[0].id, { alias: 'cc', aggregate: 'MAX' });
    m = updateColumn(m, m.columns[0].id, { alias: undefined });
    assert.deepEqual([m.columns[0].alias, m.columns[0].aggregate], [undefined, 'MAX']);

    const t1 = addTable(createEmptyModel(), { name: 'a' });
    const t2 = addTable(t1.model, { name: 'b' });
    let j = connectColumns(t2.model, t1.table.id, 'id', t2.table.id, 'a_id');
    j = connectColumns(j, t2.table.id, 'k', t1.table.id, 'k2');
    assert.equal(j.joins.length, 1);
    assert.deepEqual(j.joins[0].pairs, [{ leftColumn: 'id', rightColumn: 'a_id' }, { leftColumn: 'k2', rightColumn: 'k' }]);
    j = updateJoin(j, j.joins[0].id, { type: 'LEFT' });
    assert.equal(j.joins[0].type, 'LEFT');
    assert.equal(removeJoin(j, j.joins[0].id).joins.length, 0);
});

test('resolveColumnTables assigns unqualified columns to the only table that has them', () => {
    const a = addTable(createEmptyModel(), { name: 'a' });
    const b = addTable(a.model, { name: 'b' });
    let m = addColumn(b.model, { expression: 'name' }).model;
    m = addColumn(m, { expression: 'id' }).model;
    m = resolveColumnTables(m, { [a.table.id]: ['id', 'name'], [b.table.id]: ['id'] });
    assert.deepEqual(m.columns.map((c) => [c.tableId, c.column]), [[a.table.id, 'name'], [undefined, undefined]]);
});
