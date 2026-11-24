import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const {
    readBuilderState,
    builderStateToSql,
    emptyBuilderState,
    builderMetadataRequest,
    mergeBuilderMetadata,
    viewTabForKey,
    normalizeRunSql,
    queryDiffersFromRun,
    preparedRunOutcome
} = require(path.join(__dirname, '../../../src/webview/tableView.js'));

// The SELECTs the Query Builder has to read; each must survive read → write → read.
const CORPUS = [
    'SELECT * FROM orders',
    'SELECT id, name FROM customers',
    'SELECT o.id, o.total FROM orders o',
    'SELECT o.id FROM orders AS o',
    'SELECT "O"."Id", "Name" FROM "MySchema"."Orders" "O"',
    'SELECT o.id FROM sales.orders o',
    'SELECT a.x FROM a INNER JOIN b ON b.a_id = a.id',
    'SELECT a.x FROM a LEFT OUTER JOIN b ON b.k = a.k RIGHT JOIN c ON c.k = b.k FULL OUTER JOIN d ON d.k = c.k CROSS JOIN e',
    'SELECT o.id FROM orders o JOIN order_items i ON i.order_id = o.id AND i.tenant = o.tenant',
    "SELECT o.id FROM orders o LEFT JOIN customers c ON c.id = o.customer_id AND c.status = 'active' AND c.level >= 3",
    'SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id AND lower(c.name) = o.name_key',
    'SELECT * FROM a JOIN b USING (k, j)',
    'SELECT * FROM a NATURAL LEFT JOIN b',
    'SELECT a.x, b.y FROM a, b, c WHERE a.id = b.a_id AND c.z = 1 AND b.q = c.q',
    'SELECT DISTINCT a.k FROM a',
    'SELECT DISTINCT ON (a.k) a.k, a.v FROM a ORDER BY a.k, a.v DESC',
    "SELECT upper(c.name) AS name_upper, c.a + c.b total, CASE WHEN c.x > 0 THEN 'p' ELSE 'n' END AS sign FROM c",
    'SELECT t.*, count(*) AS n FROM t GROUP BY t.id',
    "SELECT x FROM t WHERE a = 1 AND b <> 'x' AND c IN (1, 2) AND d BETWEEN 1 AND 5 AND e LIKE 'a%' AND f IS NULL AND g IS NOT NULL",
    'SELECT x FROM t WHERE a = 1 OR b = 2',
    'SELECT x FROM t WHERE t.k IN (SELECT k FROM u WHERE u.flag OR u.other)',
    "SELECT t.x FROM t WHERE t.id = :id AND t.day >= :'from'::date AND t.code = :\"col\" AND t.n = $1 AND t.v = p_var",
    'SELECT t.dept, sum(t.amount) AS total FROM t WHERE t.year = 2024 GROUP BY t.dept HAVING sum(t.amount) > 100',
    'SELECT x FROM t ORDER BY x DESC NULLS LAST, 2 ASC, y NULLS FIRST',
    'SELECT x FROM t LIMIT 10 OFFSET 20',
    'SELECT x FROM t ORDER BY x OFFSET 5 ROWS FETCH FIRST 10 ROWS ONLY',
    'SELECT x FROM t WHERE t.id = 1 FOR UPDATE OF t NOWAIT',
    'WITH recent AS (SELECT * FROM orders WHERE day > now() - interval \'1 day\') SELECT r.id FROM recent r JOIN customers c ON c.id = r.customer_id',
    'SELECT a FROM t UNION ALL SELECT b FROM u ORDER BY 1',
    'SELECT s.n FROM (SELECT 1 AS n) s JOIN t ON t.n = s.n',
    'SELECT g.i FROM generate_series(1, 3) AS g(i)',
    'SELECT * FROM a CROSS JOIN LATERAL (SELECT * FROM b WHERE b.k = a.k) sub',
    'SELECT * FROM ONLY parent p TABLESAMPLE SYSTEM (10)',
    '-- report\nSELECT a.x /* inline */ + 1 AS y -- trailing\nFROM a -- table\nWHERE a.x = 1 -- first\n  AND a.y = /* value */ 2\nORDER BY a.x',
    'SELECT mitarbeiter.region(mit_id) as region, mit_id FROM mitarbeiter',
    'SELECT a FROM t1, t2 RIGHT JOIN t3 ON t3.k = t2.k WHERE t1.a = t2.b',
    'SELECT x FROM t WHERE a IS DISTINCT FROM b;',
    'SELECT 1'
];

function read(sql: string) {
    return readBuilderState(sql);
}

// ===== readBuilderState / builderStateToSql round trip =====

for (const sql of CORPUS) {
    test(`builder state round trip is stable: ${sql.replace(/\s+/g, ' ').slice(0, 70)}`, () => {
        const state = read(sql);
        assert.ok(state, 'reads the query');
        const written = builderStateToSql(state);
        assert.deepEqual(read(written), state);
        assert.equal(builderStateToSql(read(written)), written);
    });
}

// ===== readBuilderState =====

test('readBuilderState reads columns, aliases, joins, WHERE and ORDER BY', () => {
    const state = read(
        'select o.id, o.total as amount, c.name customer from public.orders o '
        + "inner join sales.customers as c on c.id = o.customer_id and o.status = 'open' and lower(c.name) <> '' "
        + 'where o.total > 100 order by o.id desc nulls last, 2'
    );
    assert.deepEqual(state, {
        distinct: false,
        selectItems: [
            { kind: 'column', tableIndex: 0, column: 'id' },
            { kind: 'expr', text: 'o.total', alias: 'amount' },
            { kind: 'expr', text: 'c.name', alias: 'customer' }
        ],
        tables: [
            { schema: 'public', table: 'orders', tableReference: 'public.orders', alias: 'o', columns: [] },
            { schema: 'sales', table: 'customers', tableReference: 'sales.customers', alias: 'c', columns: [] }
        ],
        joins: [{
            type: 'INNER JOIN',
            conditions: [{ leftAlias: 'o', leftColumn: 'customer_id', rightColumn: 'id' }],
            literalConditions: [{ literalAlias: 'o', literalColumn: 'status', operator: '=', value: 'open' }],
            rawConditions: ["lower(c.name) <> ''"]
        }],
        where: [{ kind: 'compare', left: 'o.total', operator: '>', right: '100' }],
        orderBy: [{ expr: 'o.id', direction: 'DESC', nulls: 'LAST' }, { expr: '2' }],
        carried: {}
    });
});

test('readBuilderState keeps quoted names as written and unquotes schema and table for the catalog', () => {
    const state = read('SELECT "O"."Id", "Name" FROM "MySchema"."Orders" "O"');
    assert.deepEqual(state.tables, [
        { schema: 'MySchema', table: 'Orders', tableReference: '"MySchema"."Orders"', alias: '"O"', columns: [] }
    ]);
    assert.deepEqual(state.selectItems, [
        { kind: 'column', tableIndex: 0, column: '"Id"' },
        // A bare name next to an aliased table may be a variable: it stays text.
        { kind: 'expr', text: '"Name"' }
    ]);
});

test('readBuilderState resolves a bare column only for a single table without alias', () => {
    assert.deepEqual(read('SELECT id, true, current_date FROM orders').selectItems, [
        { kind: 'column', tableIndex: 0, column: 'id' },
        { kind: 'expr', text: 'true' },
        { kind: 'expr', text: 'current_date' }
    ]);
    assert.deepEqual(read('SELECT id FROM a JOIN b ON b.k = a.k').selectItems, [{ kind: 'expr', text: 'id' }]);
});

test('readBuilderState reads the function call of the region example as an expression', () => {
    const state = read('SELECT mitarbeiter.region(mit_id) as region, mit_id FROM mitarbeiter');
    assert.deepEqual(state.selectItems, [
        { kind: 'expr', text: 'mitarbeiter.region(mit_id)', alias: 'region' },
        { kind: 'column', tableIndex: 0, column: 'mit_id' }
    ]);
    assert.equal(builderStateToSql(state), 'SELECT mitarbeiter.region(mit_id) AS region, mit_id FROM mitarbeiter');
});

test('readBuilderState keeps wildcards as expressions', () => {
    assert.deepEqual(read('SELECT t.*, * FROM t').selectItems, [
        { kind: 'expr', text: 't.*' },
        { kind: 'expr', text: '*' }
    ]);
});

test('readBuilderState keeps USING and NATURAL as join markers', () => {
    const state = read('SELECT * FROM a JOIN b USING (k, j) NATURAL LEFT JOIN c');
    assert.deepEqual(state.joins.map((j: { type: string; rawConditions: string[] }) => [j.type, j.rawConditions]), [
        ['INNER JOIN', ['USING (k, j)']],
        ['LEFT JOIN', ['NATURAL']]
    ]);
    assert.equal(builderStateToSql(state), 'SELECT * FROM a INNER JOIN b USING (k, j) NATURAL LEFT JOIN c');
});

test('readBuilderState turns comma joins with WHERE equalities into inner joins', () => {
    const state = read('SELECT a.x FROM a, b, c WHERE a.id = b.a_id AND c.z = 1 AND b.q = c.q');
    assert.deepEqual(state.joins, [
        { type: 'INNER JOIN', conditions: [{ leftAlias: 'a', leftColumn: 'id', rightColumn: 'a_id' }], literalConditions: [], rawConditions: [] },
        { type: 'INNER JOIN', conditions: [{ leftAlias: 'b', leftColumn: 'q', rightColumn: 'q' }], literalConditions: [], rawConditions: [] }
    ]);
    assert.deepEqual(state.where, [{ kind: 'compare', left: 'c.z', operator: '=', right: '1' }]);
    assert.equal(builderStateToSql(state), 'SELECT a.x FROM a INNER JOIN b ON b.a_id = a.id INNER JOIN c ON c.q = b.q WHERE c.z = 1');
});

test('readBuilderState leaves a WHERE equality alone when the later table is an outer join', () => {
    const state = read('SELECT a.x FROM a LEFT JOIN b ON b.k = a.k WHERE a.id = b.id');
    assert.deepEqual(state.where, [{ kind: 'compare', left: 'a.id', operator: '=', right: 'b.id' }]);
    assert.equal(state.joins[0].conditions.length, 1);
});

test('readBuilderState keeps a right join after a comma as one parenthesised item', () => {
    const state = read('SELECT a FROM t1, t2 RIGHT JOIN t3 ON t3.k = t2.k');
    assert.equal(state.tables[1].raw, '(t2 RIGHT JOIN t3 ON t3.k = t2.k)');
    assert.equal(builderStateToSql(state), 'SELECT a FROM t1 CROSS JOIN (t2 RIGHT JOIN t3 ON t3.k = t2.k)');
});

test('readBuilderState reads DISTINCT ON', () => {
    const state = read('SELECT DISTINCT ON (a.k) a.k, a.v FROM a');
    assert.equal(state.distinct, true);
    assert.equal(state.distinctOn, 'a.k');
    assert.equal(builderStateToSql(state), 'SELECT DISTINCT ON (a.k) k, v FROM a');
});

test('readBuilderState splits WHERE at AND but not inside BETWEEN, and keeps OR groups whole', () => {
    assert.deepEqual(read("SELECT x FROM t WHERE a BETWEEN 1 AND 5 AND b IN (1, 2) AND c LIKE 'x%' AND d IS NOT NULL").where, [
        { kind: 'raw', text: 'a BETWEEN 1 AND 5' },
        { kind: 'raw', text: 'b IN (1, 2)' },
        { kind: 'compare', left: 'c', operator: 'LIKE', right: "'x%'" },
        { kind: 'compare', left: 'd', operator: 'IS NOT NULL', right: '' }
    ]);
    assert.deepEqual(read('SELECT x FROM t WHERE a = 1 OR b = 2 AND c = 3').where, [
        { kind: 'raw', text: 'a = 1 OR b = 2 AND c = 3' }
    ]);
    assert.deepEqual(read('SELECT x FROM t WHERE t.k = (SELECT max(k) FROM u)').where, [
        { kind: 'raw', text: 't.k = (SELECT max(k) FROM u)' }
    ]);
});

test('readBuilderState keeps placeholders and variables as text', () => {
    const state = read("SELECT t.x FROM t WHERE t.id = :id AND t.day >= :'from'::date AND t.n = $1 AND t.v = p_var");
    assert.deepEqual(state.where.map((c: { right: string }) => c.right), [':id', ":'from'::date", '$1', 'p_var']);
});

test('readBuilderState carries GROUP BY, HAVING, LIMIT, FETCH, locking, WITH and set operations', () => {
    assert.deepEqual(read('SELECT t.d, sum(t.a) AS s FROM t GROUP BY t.d HAVING sum(t.a) > 1 LIMIT 10 OFFSET 5').carried, {
        groupBy: 't.d', having: 'sum(t.a) > 1', limit: '10', offset: '5'
    });
    assert.deepEqual(read('SELECT x FROM t OFFSET 5 ROWS FETCH FIRST 10 ROWS ONLY FOR UPDATE').carried, {
        offset: '5 ROWS', fetch: 'FIRST 10 ROWS ONLY', locking: 'FOR UPDATE'
    });
    const cte = read('WITH c AS (SELECT 1 AS k) SELECT c.k FROM c UNION SELECT 2');
    assert.deepEqual(cte.carried, { with: 'WITH c AS (SELECT 1 AS k)', setOps: 'UNION SELECT 2' });
    assert.equal(cte.tables[0].raw, 'c');
});

test('readBuilderState keeps subqueries and functions in FROM as raw items with their alias', () => {
    const state = read('SELECT s.n FROM (SELECT 1 AS n) s, generate_series(1, 3) g(i) WHERE s.n = g.i');
    assert.deepEqual(state.tables.map((t: { raw: string; alias: string }) => [t.raw, t.alias]), [
        ['(SELECT 1 AS n) s', 's'],
        ['generate_series(1, 3) g(i)', 'g']
    ]);
    assert.deepEqual(state.selectItems, [{ kind: 'column', tableIndex: 0, column: 'n' }]);
    assert.deepEqual(state.joins[0].conditions, [{ leftAlias: 's', leftColumn: 'n', rightColumn: 'i' }]);
});

test('readBuilderState keeps comments inside expressions and conditions', () => {
    const state = read('-- report\nSELECT a.x /* inline */ + 1 AS y\nFROM a\nWHERE a.y = /* value */ 2');
    assert.deepEqual(state.selectItems, [{ kind: 'expr', text: 'a.x /* inline */ + 1', alias: 'y' }]);
    assert.deepEqual(state.where, [{ kind: 'raw', text: 'a.y = /* value */ 2' }]);
});

test('readBuilderState returns null for anything but a single SELECT', () => {
    assert.equal(read('UPDATE t SET a = 1'), null);
    assert.equal(read('WITH c AS (SELECT 1) DELETE FROM t'), null);
    assert.equal(read('SELECT 1; SELECT 2'), null);
    assert.equal(read('SELECT a INTO b FROM t'), null);
    assert.equal(read(''), null);
    assert.equal(readBuilderState(null), null);
});

// ===== builderStateToSql =====

test('builderStateToSql writes edited conditions, literals and empty select lists', () => {
    const state = read('SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id OR c.alt = o.customer_id WHERE o.a = 1 OR o.b = 2');
    state.selectItems = [];
    state.joins[0].literalConditions.push({ literalAlias: 'c', literalColumn: 'owner', operator: '=', value: "O'Brien" });
    state.where.push({ kind: 'compare', left: 'o.c', operator: 'IS NULL', right: '' });
    assert.equal(
        builderStateToSql(state),
        "SELECT * FROM orders o INNER JOIN customers c ON c.owner = 'O''Brien' AND (c.id = o.customer_id OR c.alt = o.customer_id) "
        + 'WHERE (o.a = 1 OR o.b = 2) AND o.c IS NULL'
    );
});

test('builderStateToSql keeps a line comment from swallowing the next clause', () => {
    const sql = builderStateToSql({
        distinct: false,
        selectItems: [{ kind: 'expr', text: 'x' }],
        tables: [{ schema: '', table: 't', tableReference: 't', alias: '', columns: [] }],
        joins: [],
        where: [{ kind: 'raw', text: 'a = 1 -- note' }],
        orderBy: [{ expr: 'x' }],
        carried: {}
    });
    assert.equal(sql, 'SELECT x FROM t WHERE a = 1 -- note\nORDER BY x');
});

// ===== The Query Builder tab =====

test('builderStateToSql writes the alias of a renamed column', () => {
    const state = readBuilderState('SELECT o.id, o.total FROM orders o');
    state.selectItems[0].alias = 'order_id';
    assert.equal(builderStateToSql(state), 'SELECT o.id AS order_id, o.total FROM orders o');
});

test('an empty query bar is an empty builder, which writes no SQL', () => {
    assert.equal(builderStateToSql(emptyBuilderState()), '');
    assert.deepEqual(builderMetadataRequest(emptyBuilderState()), []);
});

test('builderMetadataRequest asks once per table and nothing for raw FROM items', () => {
    const state = readBuilderState('SELECT * FROM sales.orders o JOIN customers c ON c.id = o.customer_id JOIN customers c2 ON c2.id = o.payer_id CROSS JOIN generate_series(1, 3) g');
    assert.deepEqual(builderMetadataRequest(state), [
        { schema: 'sales', table: 'orders' },
        { schema: '', table: 'customers' }
    ]);
});

test('mergeBuilderMetadata adds the columns, schema and saved alias and keeps the query as written', () => {
    const state = readBuilderState('SELECT c."Name", c.id FROM customers c JOIN unknown u ON u.k = c.k ORDER BY c.id DESC, u.k');
    const merged = mergeBuilderMetadata(state, {
        tables: [{ schema: '', table: 'customers', resolvedSchema: 'public', columns: ['id', 'name', '"Name"'], savedAlias: 'cu' }],
        identityEdges: []
    });
    assert.equal(merged.tables[0].schema, 'public');
    assert.equal(merged.tables[0].alias, 'c', 'the alias of the query stays');
    assert.equal(merged.tables[0].savedAlias, 'cu');
    assert.deepEqual(merged.tables[0].columns, ['id', 'name', '"Name"']);
    assert.deepEqual(merged.tables[1].columns, [], 'a table the host did not find keeps no columns');
    assert.deepEqual(merged.orderBy[0], { expr: 'c.id', direction: 'DESC', column: { tableIndex: 0, column: 'id' } }, 'a sort by a known column is offered as that column');
    assert.equal(merged.orderBy[1].column, undefined);
    assert.equal(builderStateToSql(merged), builderStateToSql(state));
    assert.deepEqual(mergeBuilderMetadata(state, null).tables, state.tables, 'no answer, nothing merged');
});

test('mergeBuilderMetadata lists a selected column as the query spells it', () => {
    const state = readBuilderState('SELECT c."id" FROM customers c');
    const merged = mergeBuilderMetadata(state, { tables: [{ schema: '', table: 'customers', resolvedSchema: 'public', columns: ['id', 'name'] }] });
    assert.deepEqual(merged.tables[0].columns, ['"id"', 'name']);
});

test('the arrow keys, Home and End move between the tabs', () => {
    assert.equal(viewTabForKey('data', 'ArrowRight'), 'builder');
    assert.equal(viewTabForKey('builder', 'ArrowRight'), 'data');
    assert.equal(viewTabForKey('data', 'ArrowLeft'), 'builder');
    assert.equal(viewTabForKey('builder', 'Home'), 'data');
    assert.equal(viewTabForKey('data', 'End'), 'builder');
    assert.equal(viewTabForKey('data', 'Enter'), null);
});

// ===== The stale-data hint =====

test('queryDiffersFromRun ignores layout, comments, case of keywords and a trailing semicolon', () => {
    const ran = 'SELECT o.id, o.total FROM orders o WHERE o.total>10 ORDER BY o.id';
    assert.equal(queryDiffersFromRun('select o.id,\n       o.total\n  from orders o -- big ones\n where o.total > 10\n order by o.id;', ran), false);
    assert.equal(queryDiffersFromRun('SELECT o.id, o.total FROM orders o WHERE o.total > 20 ORDER BY o.id', ran), true);
    assert.equal(queryDiffersFromRun('SELECT o.id FROM orders o', ran), true);
    assert.equal(queryDiffersFromRun(ran, ''), false, 'nothing has run yet');
});

test('normalizeRunSql keeps literals, quoted names and operators apart', () => {
    assert.notEqual(normalizeRunSql("SELECT 'A'"), normalizeRunSql("SELECT 'a'"));
    assert.notEqual(normalizeRunSql('SELECT "Id" FROM t'), normalizeRunSql('SELECT "id" FROM t'));
    assert.notEqual(normalizeRunSql('SELECT a < = b'), normalizeRunSql('SELECT a <= b'));
    assert.equal(normalizeRunSql('SELECT  a  ,b FROM t ;'), normalizeRunSql('select a, b from t'));
    assert.equal(normalizeRunSql('SELECT $$ x  y $$'), 'select $$ x  y $$');
});

// ===== Run with placeholders =====

test('preparedRunOutcome runs the filled-in SQL, gives up on a cancel and drops old answers', () => {
    assert.deepEqual(preparedRunOutcome({ requestId: 2, sql: 'SELECT 42', cancelled: false }, 2), { action: 'run', sql: 'SELECT 42' });
    assert.deepEqual(preparedRunOutcome({ requestId: 2, sql: null, cancelled: true }, 2), { action: 'cancel' });
    assert.deepEqual(preparedRunOutcome({ requestId: 1, sql: 'SELECT 1' }, 2), { action: 'ignore' });
    assert.deepEqual(preparedRunOutcome({ requestId: 1, sql: 'SELECT 1' }, null), { action: 'ignore' });
});