import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { buildStatement, deriveQualifier, buildJoinSelect, buildRelatedTableJoin, qualifyColumnReferences, autoJoinClauses, buildBuilderSql, type JoinBuilderState } from '../statementBuilder';
import { loadJoinMetadata, initialJoinsFor } from '../tableStatementDrop';

const opts = (qualifier = 'lei') => ({
    tableReference: 'leistungen',
    columns: ['lei_id', 'name', 'amount'],
    columnTypes: ['integer', 'text', 'numeric'],
    qualifier
});

test('deriveQualifier uses part before first underscore', () => {
    assert.equal(deriveQualifier('lei_id', 'leistungen'), 'lei');
    assert.equal(deriveQualifier('cust_order_id', 'orders'), 'cust');
});

test('deriveQualifier falls back to table name without underscore', () => {
    assert.equal(deriveQualifier('id', 'users'), 'users');
    assert.equal(deriveQualifier(null, 'users'), 'users');
    assert.equal(deriveQualifier('', 'users'), 'users');
});

test('buildStatement name returns only the table reference', () => {
    assert.equal(buildStatement('name', opts()), 'leistungen');
});

test('buildStatement select qualifies all columns', () => {
    assert.equal(
        buildStatement('select', opts()),
        'SELECT\n  lei.lei_id,\n  lei.name,\n  lei.amount\nFROM leistungen lei;'
    );
});

test('buildStatement select falls back to star with no columns', () => {
    assert.equal(
        buildStatement('select', { tableReference: 'leistungen', columns: [], qualifier: 'lei' }),
        'SELECT\n  lei.*\nFROM leistungen lei;'
    );
});

test('buildStatement insert lists all columns', () => {
    const sql = buildStatement('insert', opts());
    assert.ok(sql.startsWith('INSERT INTO leistungen ('));
    assert.ok(sql.includes('    lei_id,'));
    assert.ok(sql.includes('    amount'));
    assert.ok(sql.includes('VALUES ('));
    assert.ok(sql.includes('NULL::integer, -- lei_id'));
    assert.ok(sql.includes('NULL::text, -- name'));
    assert.ok(sql.includes('NULL::numeric -- amount'));
});

test('buildStatement update qualifies table and casts all columns', () => {
    assert.equal(
        buildStatement('update', opts()),
        'UPDATE leistungen lei\nSET\n  lei_id = NULL::integer,\n  name = NULL::text,\n  amount = NULL::numeric\nWHERE ;'
    );
});

test('buildStatement delete lists all columns in where clause', () => {
    assert.equal(
        buildStatement('delete', opts()),
        'DELETE FROM leistungen lei\nWHERE lei.lei_id = \n  AND lei.name = \n  AND lei.amount = ;'
    );
});

test('buildStatement join uses first column', () => {
    assert.equal(buildStatement('join', opts()), 'JOIN leistungen lei ON lei.lei_id = ');
});

test('buildStatement respects a custom qualifier', () => {
    assert.equal(
        buildStatement('select', opts('x')),
        'SELECT\n  x.lei_id,\n  x.name,\n  x.amount\nFROM leistungen x;'
    );
});

const joinTables = () => [
    { alias: 'o', tableReference: 'orders', columns: ['id', 'cust_id'] },
    { alias: 'c', tableReference: 'customers', columns: ['id', 'name'] }
];

test('buildJoinSelect builds a two-table inner join', () => {
    const joins = [
        {
            type: 'INNER JOIN' as const,
            conditions: [{ leftAlias: 'o', leftColumn: 'cust_id', rightColumn: 'id' }]
        }
    ];
    assert.equal(
        buildJoinSelect(joinTables(), joins),
        'SELECT\n  o.id,\n  o.cust_id,\n  c.id,\n  c.name\nFROM orders o\nINNER JOIN customers c ON c.id = o.cust_id;'
    );
});

test('buildJoinSelect renders CROSS JOIN without ON', () => {
    const joins = [{ type: 'CROSS JOIN' as const, conditions: [] }];
    assert.equal(
        buildJoinSelect(joinTables(), joins),
        'SELECT\n  o.id,\n  o.cust_id,\n  c.id,\n  c.name\nFROM orders o\nCROSS JOIN customers c;'
    );
});

test('buildJoinSelect supports multiple ON conditions', () => {
    const tables = [
        { alias: 'a', tableReference: 'a', columns: ['k1', 'k2'] },
        { alias: 'b', tableReference: 'b', columns: ['k1', 'k2'] }
    ];
    const joins = [
        {
            type: 'LEFT JOIN' as const,
            conditions: [
                { leftAlias: 'a', leftColumn: 'k1', rightColumn: 'k1' },
                { leftAlias: 'a', leftColumn: 'k2', rightColumn: 'k2' }
            ]
        }
    ];
    assert.equal(
        buildJoinSelect(tables, joins),
        'SELECT\n  a.k1,\n  a.k2,\n  b.k1,\n  b.k2\nFROM a a\nLEFT JOIN b b ON b.k1 = a.k1 AND b.k2 = a.k2;'
    );
});

test('autoJoinClauses links a child FK to the parent table', () => {
    // table 0 = orders (holds FK cust_id), table 1 = customers
    const clauses = autoJoinClauses(
        ['o', 'c'],
        [{ fromIndex: 0, fromColumn: 'cust_id', toIndex: 1, toColumn: 'id' }]
    );
    assert.equal(clauses.length, 1);
    assert.equal(clauses[0].type, 'INNER JOIN');
    assert.deepEqual(clauses[0].conditions, [
        { leftAlias: 'o', leftColumn: 'cust_id', rightColumn: 'id' }
    ]);
});

test('autoJoinClauses links parent referenced by later child', () => {
    // table 0 = customers, table 1 = orders (holds FK cust_id -> customers.id)
    const clauses = autoJoinClauses(
        ['c', 'o'],
        [{ fromIndex: 1, fromColumn: 'cust_id', toIndex: 0, toColumn: 'id' }]
    );
    assert.deepEqual(clauses[0].conditions, [
        { leftAlias: 'c', leftColumn: 'id', rightColumn: 'cust_id' }
    ]);
});

test('autoJoinClauses falls back to CROSS JOIN without FK', () => {
    const clauses = autoJoinClauses(['a', 'b'], []);
    assert.equal(clauses[0].type, 'CROSS JOIN');
    assert.deepEqual(clauses[0].conditions, []);
});

// ===== 1.1.0: JOIN dialog conditions from custom mappings =====

test('autoJoinClauses derives literal conditions from custom-mapping extras', () => {
    const clauses = autoJoinClauses(
        ['o', 'c'],
        [{
            fromIndex: 0,
            fromColumn: 'cust_id',
            toIndex: 1,
            toColumn: 'id',
            extraConditions: [{ tableIndex: 0, column: 'status', operator: '=', value: 'active' }]
        }]
    );
    assert.equal(clauses.length, 1);
    assert.equal(clauses[0].type, 'INNER JOIN');
    assert.deepEqual(clauses[0].conditions, [
        { leftAlias: 'o', leftColumn: 'cust_id', rightColumn: 'id' }
    ]);
    assert.deepEqual(clauses[0].literalConditions, [
        { literalAlias: 'o', literalColumn: 'status', operator: '=', value: 'active' }
    ]);
});

test('autoJoinClauses leaves literalConditions empty when no extras are present', () => {
    const clauses = autoJoinClauses(
        ['o', 'c'],
        [{ fromIndex: 0, fromColumn: 'cust_id', toIndex: 1, toColumn: 'id' }]
    );
    assert.deepEqual(clauses[0].literalConditions, []);
});

test('buildJoinSelect appends a quoted string literal condition to the ON clause', () => {
    const tables = [
        { alias: 'a', tableReference: 'a', columns: ['id'] },
        { alias: 'b', tableReference: 'b', columns: ['a_id'] }
    ];
    const joins = [{
        type: 'INNER JOIN' as const,
        conditions: [{ leftAlias: 'a', leftColumn: 'id', rightColumn: 'a_id' }],
        literalConditions: [{ literalAlias: 'a', literalColumn: 'status', operator: '=', value: 'active' }]
    }];
    assert.equal(
        buildJoinSelect(tables, joins),
        "SELECT\n  a.id,\n  b.a_id\nFROM a a\nINNER JOIN b b ON b.a_id = a.id AND a.status = 'active';"
    );
});

test('buildJoinSelect renders numeric literal conditions without quotes', () => {
    const tables = [
        { alias: 'a', tableReference: 'a', columns: ['id'] },
        { alias: 'b', tableReference: 'b', columns: ['a_id'] }
    ];
    const joins = [{
        type: 'LEFT JOIN' as const,
        conditions: [{ leftAlias: 'a', leftColumn: 'id', rightColumn: 'a_id' }],
        literalConditions: [{ literalAlias: 'a', literalColumn: 'priority', operator: '>', value: '5' }]
    }];
    assert.equal(
        buildJoinSelect(tables, joins),
        'SELECT\n  a.id,\n  b.a_id\nFROM a a\nLEFT JOIN b b ON b.a_id = a.id AND a.priority > 5;'
    );
});

test('buildJoinSelect leaves columns unqualified when a table has no alias', () => {
    const tables = [
        { alias: '', tableReference: 'a', columns: ['id'] },
        { alias: '', tableReference: 'b', columns: ['a_id'] }
    ];
    const joins = [{
        type: 'INNER JOIN' as const,
        conditions: [{ leftAlias: '', leftColumn: 'id', rightColumn: 'a_id' }],
        literalConditions: [{ literalAlias: '', literalColumn: 'status', operator: '=', value: 'active' }]
    }];
    assert.equal(
        buildJoinSelect(tables, joins),
        "SELECT\n  id,\n  a_id\nFROM a\nINNER JOIN b ON a_id = id AND status = 'active';"
    );
});

test('buildJoinSelect omits a table that only takes part in the join', () => {
    const tables = [
        { alias: 'a', tableReference: 'a', columns: ['id'] },
        { alias: 'b', tableReference: 'b', columns: ['a_id'], omitFromSelect: true }
    ];
    const joins = [{
        type: 'INNER JOIN' as const,
        conditions: [{ leftAlias: 'a', leftColumn: 'id', rightColumn: 'a_id' }]
    }];
    assert.equal(
        buildJoinSelect(tables, joins),
        'SELECT\n  a.id\nFROM a a\nINNER JOIN b b ON b.a_id = a.id;'
    );
});

test('buildJoinSelect appends an ORDER BY clause', () => {
    const joins = [{
        type: 'INNER JOIN' as const,
        conditions: [{ leftAlias: 'o', leftColumn: 'cust_id', rightColumn: 'id' }]
    }];
    assert.equal(
        buildJoinSelect(joinTables(), joins, ' c.name DESC '),
        'SELECT\n  o.id,\n  o.cust_id,\n  c.id,\n  c.name\nFROM orders o\n'
        + 'INNER JOIN customers c ON c.id = o.cust_id\nORDER BY c.name DESC;'
    );
    assert.equal(
        buildJoinSelect(joinTables(), joins, '   '),
        'SELECT\n  o.id,\n  o.cust_id,\n  c.id,\n  c.name\nFROM orders o\nINNER JOIN customers c ON c.id = o.cust_id;'
    );
});

// ===== buildRelatedTableJoin =====

test('buildRelatedTableJoin moves the current WHERE clause into the ON clause', () => {
    const sql = buildRelatedTableJoin({
        target: { tableReference: 'sap_rk_zuordnungen', columns: ['srz_rk_id', 'srz_sap_id', 'srz_g_von', 'srz_g_bis'] },
        source: { tableReference: 'regionen' },
        columnPairs: [{ sourceColumn: 'rk_id', targetColumn: 'srz_rk_id' }],
        sourceWhere: "rk_rk = 'DEB'"
    });
    assert.equal(
        sql,
        'SELECT\n  srz_rk_id,\n  srz_sap_id,\n  srz_g_von,\n  srz_g_bis\n'
        + "FROM sap_rk_zuordnungen\nINNER JOIN regionen ON rk_id = srz_rk_id AND rk_rk = 'DEB';"
    );
});

test('buildRelatedTableJoin works without a WHERE clause', () => {
    const sql = buildRelatedTableJoin({
        target: { tableReference: 'b', columns: ['a_id'] },
        source: { tableReference: 'a' },
        columnPairs: [{ sourceColumn: 'id', targetColumn: 'a_id' }]
    });
    assert.equal(sql, 'SELECT\n  a_id\nFROM b\nINNER JOIN a ON id = a_id;');
});

test('buildRelatedTableJoin joins on every column pair of a composite mapping', () => {
    const sql = buildRelatedTableJoin({
        target: { tableReference: 'b', columns: ['x', 'y'] },
        source: { tableReference: 'a' },
        columnPairs: [
            { sourceColumn: 'k1', targetColumn: 'x' },
            { sourceColumn: 'k2', targetColumn: 'y' }
        ]
    });
    assert.equal(sql, 'SELECT\n  x,\n  y\nFROM b\nINNER JOIN a ON k1 = x AND k2 = y;');
});

test('buildRelatedTableJoin adds the extra conditions of a custom mapping', () => {
    const sql = buildRelatedTableJoin({
        target: { tableReference: 'b', columns: ['a_id'] },
        source: { tableReference: 'a' },
        columnPairs: [{ sourceColumn: 'id', targetColumn: 'a_id' }],
        sourceConditions: [{ column: 'status', operator: '=', value: 'active' }],
        targetConditions: [{ column: 'kind', operator: '=', value: 'TGB' }],
        sourceWhere: 'id > 10'
    });
    assert.equal(
        sql,
        "SELECT\n  a_id\nFROM b\nINNER JOIN a ON id = a_id AND kind = 'TGB' AND status = 'active' AND id > 10;"
    );
});

test('buildRelatedTableJoin returns nothing without a column pair', () => {
    assert.equal(
        buildRelatedTableJoin({
            target: { tableReference: 'b', columns: ['x'] },
            source: { tableReference: 'a' },
            columnPairs: []
        }),
        ''
    );
});

test('buildRelatedTableJoin keeps the ORDER BY of the current query', () => {
    const sql = buildRelatedTableJoin({
        target: { tableReference: 'b', columns: ['a_id'] },
        source: { tableReference: 'a' },
        columnPairs: [{ sourceColumn: 'id', targetColumn: 'a_id' }],
        sourceOrderBy: 'name DESC'
    });
    assert.equal(sql, 'SELECT\n  a_id\nFROM b\nINNER JOIN a ON id = a_id\nORDER BY name DESC;');
});

test('buildRelatedTableJoin qualifies the carried clauses when aliases are used', () => {
    const sql = buildRelatedTableJoin({
        target: { tableReference: 'orders', columns: ['id', 'name'], alias: 'o' },
        source: { tableReference: 'customers', columns: ['id', 'name', 'status'], alias: 'c' },
        columnPairs: [{ sourceColumn: 'id', targetColumn: 'id' }],
        sourceConditions: [{ column: 'status', operator: '=', value: 'active' }],
        sourceWhere: "name LIKE 'A%' AND id > 10",
        sourceOrderBy: 'name ASC'
    });
    assert.equal(
        sql,
        'SELECT\n  o.id,\n  o.name\nFROM orders o\n'
        + "INNER JOIN customers c ON c.id = o.id AND c.status = 'active' AND c.name LIKE 'A%' AND c.id > 10\n"
        + 'ORDER BY c.name ASC;'
    );
});

test('buildRelatedTableJoin joins a sub-select as the source', () => {
    const sql = buildRelatedTableJoin({
        target: { tableReference: 'b', columns: ['a_id'], alias: 'b' },
        source: { tableReference: '(SELECT id FROM a WHERE x = 1)', columns: ['id'], alias: 'src' },
        columnPairs: [{ sourceColumn: 'id', targetColumn: 'a_id' }]
    });
    assert.equal(
        sql,
        'SELECT\n  b.a_id\nFROM b b\nINNER JOIN (SELECT id FROM a WHERE x = 1) src ON src.id = b.a_id;'
    );
});

// ===== qualifyColumnReferences =====

test('buildRelatedTableJoin carries the joins of the source query over', () => {
    const sql = buildRelatedTableJoin({
        target: { tableReference: 'reports', columns: ['id', 'emp_id'], alias: 'r' },
        source: {
            tableReference: 'employees',
            columns: [],
            alias: 'emp',
            joins: 'LEFT JOIN departments d ON d.id = emp.dep_id\nLEFT JOIN sites s ON s.id = d.site_id'
        },
        columnPairs: [{ sourceColumn: 'id', targetColumn: 'emp_id' }],
        sourceWhere: "s.name = 'Berlin'",
        sourceOrderBy: 'd.name'
    });
    assert.equal(
        sql,
        'SELECT\n  r.id,\n  r.emp_id\nFROM reports r\n'
        + 'INNER JOIN employees emp ON emp.id = r.emp_id\n'
        + 'LEFT JOIN departments d ON d.id = emp.dep_id\n'
        + 'LEFT JOIN sites s ON s.id = d.site_id\n'
        + "WHERE s.name = 'Berlin'\n"
        + 'ORDER BY d.name;'
    );
});

test('buildRelatedTableJoin keeps the WHERE clause in the ON clause without carried joins', () => {
    const sql = buildRelatedTableJoin({
        target: { tableReference: 'orders', columns: ['id'], alias: 'o' },
        source: { tableReference: 'customers', columns: ['id'], alias: 'c' },
        columnPairs: [{ sourceColumn: 'id', targetColumn: 'id' }],
        sourceWhere: 'id > 10'
    });
    assert.equal(
        sql,
        'SELECT\n  o.id\nFROM orders o\nINNER JOIN customers c ON c.id = o.id AND c.id > 10;'
    );
});

test('qualifyColumnReferences prefixes only known bare column names', () => {
    assert.equal(
        qualifyColumnReferences('status = 1 AND other = 2', ['status'], 'c'),
        'c.status = 1 AND other = 2'
    );
});

test('qualifyColumnReferences leaves literals, casts and qualified names alone', () => {
    assert.equal(
        qualifyColumnReferences("name = 'name' AND t.name = 1 AND name::text = ''", ['name'], 'c'),
        "c.name = 'name' AND t.name = 1 AND c.name::text = ''"
    );
});

test('qualifyColumnReferences does not touch a function name or a cast type', () => {
    assert.equal(
        qualifyColumnReferences('upper(name) = x::name', ['name', 'x'], 'c'),
        'upper(c.name) = c.x::name'
    );
});

test('qualifyColumnReferences matches a quoted column case-sensitively', () => {
    assert.equal(qualifyColumnReferences('"RkId" = 1', ['"RkId"'], 'r'), 'r."RkId" = 1');
    assert.equal(qualifyColumnReferences('RkId = 1', ['"RkId"'], 'r'), 'RkId = 1');
});

test('qualifyColumnReferences returns the fragment unchanged without an alias', () => {
    assert.equal(qualifyColumnReferences('a = 1', ['a'], ''), 'a = 1');
    assert.equal(qualifyColumnReferences('', ['a'], 'c'), '');
});

test('buildJoinSelect escapes single quotes inside string literal conditions', () => {
    const tables = [
        { alias: 'a', tableReference: 'a', columns: ['id'] },
        { alias: 'b', tableReference: 'b', columns: ['a_id'] }
    ];
    const joins = [{
        type: 'INNER JOIN' as const,
        conditions: [{ leftAlias: 'a', leftColumn: 'id', rightColumn: 'a_id' }],
        literalConditions: [{ literalAlias: 'a', literalColumn: 'owner', operator: '=', value: "O'Brien" }]
    }];
    assert.equal(
        buildJoinSelect(tables, joins),
        "SELECT\n  a.id,\n  b.a_id\nFROM a a\nINNER JOIN b b ON b.a_id = a.id AND a.owner = 'O''Brien';"
    );
});

// ===== 1.3.0: JOIN dialog allows the same table multiple times =====

test('buildJoinSelect builds a self-join of the same table with distinct aliases', () => {
    // The same table reference appears twice with different aliases, joined on
    // a self-referencing key (e.g. employee -> manager).
    const tables = [
        { alias: 'e', tableReference: 'employees', columns: ['id', 'mgr_id', 'name'] },
        { alias: 'm', tableReference: 'employees', columns: ['id', 'mgr_id', 'name'] }
    ];
    const joins = [
        {
            type: 'LEFT JOIN' as const,
            conditions: [{ leftAlias: 'e', leftColumn: 'mgr_id', rightColumn: 'id' }]
        }
    ];
    assert.equal(
        buildJoinSelect(tables, joins),
        'SELECT\n  e.id,\n  e.mgr_id,\n  e.name,\n  m.id,\n  m.mgr_id,\n  m.name\n'
        + 'FROM employees e\nLEFT JOIN employees m ON m.id = e.mgr_id;'
    );
});

test('buildJoinSelect supports three instances of the same table', () => {
    const tables = [
        { alias: 'a', tableReference: 'node', columns: ['id', 'parent_id'] },
        { alias: 'b', tableReference: 'node', columns: ['id', 'parent_id'] },
        { alias: 'c', tableReference: 'node', columns: ['id', 'parent_id'] }
    ];
    const joins = [
        {
            type: 'INNER JOIN' as const,
            conditions: [{ leftAlias: 'a', leftColumn: 'parent_id', rightColumn: 'id' }]
        },
        {
            type: 'INNER JOIN' as const,
            conditions: [{ leftAlias: 'b', leftColumn: 'parent_id', rightColumn: 'id' }]
        }
    ];
    assert.equal(
        buildJoinSelect(tables, joins),
        'SELECT\n  a.id,\n  a.parent_id,\n  b.id,\n  b.parent_id,\n  c.id,\n  c.parent_id\n'
        + 'FROM node a\nINNER JOIN node b ON b.id = a.parent_id\nINNER JOIN node c ON c.id = b.parent_id;'
    );
});

test('buildJoinSelect lets a duplicate table use its own CROSS JOIN', () => {
    // A second instance of the same table can be added without a relationship,
    // yielding a CROSS JOIN that the user can refine later.
    const tables = [
        { alias: 't1', tableReference: 'items', columns: ['id'] },
        { alias: 't2', tableReference: 'items', columns: ['id'] }
    ];
    const joins = [{ type: 'CROSS JOIN' as const, conditions: [] }];
    assert.equal(
        buildJoinSelect(tables, joins),
        'SELECT\n  t1.id,\n  t2.id\nFROM items t1\nCROSS JOIN items t2;'
    );
});

// ===== 1.3.0: fixed (raw) conditions on a JOIN clause =====

test('buildJoinSelect appends raw conditions after the key conditions', () => {
    const tables = [
        { alias: 't', tableReference: 'thing', columns: ['id'] },
        { alias: 'x', tableReference: 'other', columns: ['t_id'] }
    ];
    const joins = [{
        type: 'INNER JOIN' as const,
        conditions: [{ leftAlias: 't', leftColumn: 'id', rightColumn: 't_id' }],
        rawConditions: [
            'CURRENT_TIMESTAMP BETWEEN t.valid_from AND t.valid_to',
            "t.type = 'TGB'"
        ]
    }];
    assert.equal(
        buildJoinSelect(tables, joins),
        "SELECT\n  t.id,\n  x.t_id\nFROM thing t\n"
        + "INNER JOIN other x ON x.t_id = t.id"
        + " AND CURRENT_TIMESTAMP BETWEEN t.valid_from AND t.valid_to AND t.type = 'TGB';"
    );
});

test('buildJoinSelect uses a raw condition as the sole ON predicate', () => {
    const tables = [
        { alias: 'a', tableReference: 'a', columns: ['id'] },
        { alias: 'b', tableReference: 'b', columns: ['id'] }
    ];
    const joins = [{
        type: 'LEFT JOIN' as const,
        conditions: [],
        rawConditions: ['a.region = b.region']
    }];
    assert.equal(
        buildJoinSelect(tables, joins),
        'SELECT\n  a.id,\n  b.id\nFROM a a\nLEFT JOIN b b ON a.region = b.region;'
    );
});

test('buildJoinSelect ignores blank raw conditions', () => {
    const tables = [
        { alias: 'a', tableReference: 'a', columns: ['id'] },
        { alias: 'b', tableReference: 'b', columns: ['a_id'] }
    ];
    const joins = [{
        type: 'INNER JOIN' as const,
        conditions: [{ leftAlias: 'a', leftColumn: 'id', rightColumn: 'a_id' }],
        rawConditions: ['', '   ']
    }];
    assert.equal(
        buildJoinSelect(tables, joins),
        'SELECT\n  a.id,\n  b.a_id\nFROM a a\nINNER JOIN b b ON b.a_id = a.id;'
    );
});

test('buildJoinSelect combines literal and raw conditions on the ON clause', () => {
    const tables = [
        { alias: 'a', tableReference: 'a', columns: ['id'] },
        { alias: 'b', tableReference: 'b', columns: ['a_id'] }
    ];
    const joins = [{
        type: 'INNER JOIN' as const,
        conditions: [{ leftAlias: 'a', leftColumn: 'id', rightColumn: 'a_id' }],
        literalConditions: [{ literalAlias: 'a', literalColumn: 'status', operator: '=', value: 'active' }],
        rawConditions: ['a.priority > 5']
    }];
    assert.equal(
        buildJoinSelect(tables, joins),
        "SELECT\n  a.id,\n  b.a_id\nFROM a a\n"
        + "INNER JOIN b b ON b.a_id = a.id AND a.status = 'active' AND a.priority > 5;"
    );
});

test('buildJoinSelect parenthesises a raw condition holding a top-level OR', () => {
    const tables = [
        { alias: 'a', tableReference: 'a', columns: ['id'] },
        { alias: 'b', tableReference: 'b', columns: ['a_id'] }
    ];
    const joins = [{
        type: 'INNER JOIN' as const,
        conditions: [{ leftAlias: 'a', leftColumn: 'id', rightColumn: 'a_id' }],
        rawConditions: ["b.kind = 'or' OR (b.x = 1 OR b.y = 2)", 'b.z IN (1, 2)']
    }];
    assert.match(
        buildJoinSelect(tables, joins),
        /ON b\.a_id = a\.id AND \(b\.kind = 'or' OR \(b\.x = 1 OR b\.y = 2\)\) AND b\.z IN \(1, 2\);$/
    );
});

// ===== buildBuilderSql =====

function builderState(): JoinBuilderState {
    return {
        distinct: false,
        selectItems: [
            { kind: 'column', tableIndex: 0, column: 'id' },
            { kind: 'column', tableIndex: 1, column: 'total', alias: 'amount' },
            { kind: 'expr', text: 'count(*)', alias: 'n' }
        ],
        tables: [
            { schema: 'public', table: 'customers', tableReference: 'customers', alias: 'c', columns: ['id', 'name'] },
            { schema: 'public', table: 'orders', tableReference: 'public.orders', alias: 'o', columns: ['customer_id', 'total'] }
        ],
        joins: [{ type: 'LEFT JOIN', conditions: [{ leftAlias: 'c', leftColumn: 'id', rightColumn: 'customer_id' }] }],
        where: [],
        orderBy: [],
        carried: {}
    };
}

test('buildBuilderSql builds the SELECT list, FROM and JOINs of the state', () => {
    assert.equal(
        buildBuilderSql(builderState()),
        'SELECT\n  c.id,\n  o.total AS amount,\n  count(*) AS n\nFROM customers c\nLEFT JOIN public.orders o ON o.customer_id = c.id;'
    );
});

test('buildBuilderSql selects everything without select items and honours DISTINCT', () => {
    const state = { ...builderState(), selectItems: [], distinct: true };
    assert.match(buildBuilderSql(state), /^SELECT DISTINCT\n  \*\nFROM customers c/);
    state.distinctOn = 'c.id';
    assert.match(buildBuilderSql(state), /^SELECT DISTINCT ON \(c\.id\)\n/);
});

test('buildBuilderSql refers to a table without alias by its name, and to a lone one not at all', () => {
    const state = builderState();
    state.tables[1].alias = '';
    state.joins[0].conditions[0].leftAlias = 'c';
    assert.match(buildBuilderSql(state), /\n  orders\.total AS amount,[\s\S]*LEFT JOIN public\.orders ON orders\.customer_id = c\.id;$/);
    const lone: JoinBuilderState = { ...builderState(), tables: [{ ...builderState().tables[0], alias: '' }], joins: [], selectItems: [{ kind: 'column', tableIndex: 0, column: 'id' }] };
    assert.equal(buildBuilderSql(lone), 'SELECT\n  id\nFROM customers;');
});

test('buildBuilderSql ANDs the WHERE rows and keeps placeholders as written', () => {
    const state = builderState();
    state.where = [
        { kind: 'compare', left: 'o.total', operator: '>', right: '$1' },
        { kind: 'compare', left: { kind: 'column', tableIndex: 0, column: 'name' }, operator: 'BETWEEN', right: { kind: 'raw', text: ':low' }, right2: { kind: 'raw', text: ":'high'" } },
        { kind: 'compare', left: 'c.name', operator: 'IS NOT NULL', right: '' },
        { kind: 'compare', left: { kind: 'column', tableIndex: 0, column: 'id' }, operator: '=', right: { kind: 'column', tableIndex: 1, column: 'customer_id' } },
        { kind: 'compare', left: 'c.id', operator: '=', right: '  ' },
        { kind: 'raw', text: 'c.id = v_id OR c.name IS NULL' },
        { kind: 'raw', text: '' }
    ];
    assert.match(buildBuilderSql(state), new RegExp(
        '\\nWHERE o\\.total > \\$1\\n  AND c\\.name BETWEEN :low AND :\'high\'\\n  AND c\\.name IS NOT NULL'
        + '\\n  AND c\\.id = o\\.customer_id\\n  AND \\(c\\.id = v_id OR c\\.name IS NULL\\);$'
    ));
});

test('buildBuilderSql places ORDER BY and the carried clauses where they were', () => {
    const state = builderState();
    state.orderBy = [
        { expr: 'ignored', column: { tableIndex: 1, column: 'total' }, direction: 'DESC', nulls: 'LAST' },
        { expr: 'random()' },
        { expr: '  ' }
    ];
    state.where = [{ kind: 'raw', text: 'o.total > 0' }];
    state.carried = {
        with: 'WITH recent AS (SELECT 1)',
        groupBy: 'c.id, o.total',
        having: 'count(*) > 1',
        window: 'w AS (PARTITION BY c.id)',
        limit: '10',
        offset: '5',
        fetch: 'FIRST 3 ROWS ONLY',
        locking: 'FOR UPDATE OF c'
    };
    const sql = buildBuilderSql(state);
    assert.ok(sql.startsWith('WITH recent AS (SELECT 1)\nSELECT\n'));
    assert.ok(sql.endsWith(
        '\nWHERE o.total > 0\nGROUP BY c.id, o.total\nHAVING count(*) > 1\nWINDOW w AS (PARTITION BY c.id)'
        + '\nORDER BY o.total DESC NULLS LAST, random()\nLIMIT 10\nOFFSET 5\nFETCH FIRST 3 ROWS ONLY'
        + '\nFOR UPDATE OF c;'
    ));
});

test('buildBuilderSql writes no ORDER BY, LIMIT, OFFSET or FETCH in front of a UNION', () => {
    const state = builderState();
    state.orderBy = [{ expr: 'c.id', direction: 'DESC' }];
    state.carried = { limit: '10', offset: '5', fetch: 'FIRST 3 ROWS ONLY', setOps: 'UNION ALL SELECT 1, 2, 3 ORDER BY 1 LIMIT 5' };
    const sql = buildBuilderSql(state, { semicolon: false });
    assert.match(sql, /\nLEFT JOIN public\.orders o ON o\.customer_id = c\.id\nUNION ALL SELECT 1, 2, 3 ORDER BY 1 LIMIT 5$/);
    assert.equal((sql.match(/ORDER BY|LIMIT/g) ?? []).length, 2, 'only those of the UNION');
});

test('buildBuilderSql writes USING as ON pairs next to further conditions', () => {
    const state = builderState();
    state.tables[0].columns = ['id', 'kind', 'name'];
    state.tables.push({ schema: 'public', table: 'items', tableReference: 'items', alias: 'i', columns: [] });
    state.joins.push({ type: 'LEFT JOIN', conditions: [], rawConditions: ['USING (kind, "Id")', "i.state = 'open' OR i.state IS NULL"] });
    assert.ok(buildBuilderSql(state, { semicolon: false }).endsWith(
        `\nLEFT JOIN items i ON i.kind = c.kind AND i."Id" = o."Id" AND (i.state = 'open' OR i.state IS NULL)`
    ), 'a column the table before lacks pairs with the one that has it, an unknown one with the table just before');
    state.joins[1].rawConditions = ['USING (kind) AS j', 'i.x = 1'];
    assert.ok(buildBuilderSql(state, { semicolon: false }).endsWith('\nLEFT JOIN items i ON i.x = 1'), 'a USING it cannot read is left out');
});

test('buildBuilderSql emits raw FROM items verbatim and joins them through text conditions', () => {
    const state = builderState();
    state.tables.push({ schema: '', table: '', tableReference: '', alias: 's', columns: [], raw: '(SELECT customer_id, sum(total) AS t FROM orders GROUP BY 1) s' });
    state.joins.push({ type: 'INNER JOIN', conditions: [], rawConditions: ['s.customer_id = c.id'] });
    state.selectItems = [{ kind: 'column', tableIndex: 2, column: '*' }];
    assert.equal(
        buildBuilderSql(state, { semicolon: false }),
        'SELECT\n  s.*\nFROM customers c\nLEFT JOIN public.orders o ON o.customer_id = c.id'
        + '\nINNER JOIN (SELECT customer_id, sum(total) AS t FROM orders GROUP BY 1) s ON s.customer_id = c.id'
    );
});

test('buildBuilderSql writes USING, NATURAL, ON TRUE and CROSS JOIN', () => {
    const state = builderState();
    const t = (name: string) => ({ schema: 'public', table: name, tableReference: name, alias: name[0], columns: [] });
    state.tables.push(t('b'), t('d'), t('e'), t('f'));
    state.joins.push(
        { type: 'INNER JOIN', conditions: [], rawConditions: ['USING (id, kind)'] },
        { type: 'LEFT JOIN', conditions: [], rawConditions: ['NATURAL'] },
        { type: 'INNER JOIN', conditions: [] },
        { type: 'CROSS JOIN', conditions: [] }
    );
    assert.ok(buildBuilderSql(state).endsWith(
        '\nINNER JOIN b b USING (id, kind)\nNATURAL LEFT JOIN d d\nINNER JOIN e e ON TRUE\nCROSS JOIN f f;'
    ));
});

test('buildBuilderSql keeps the semicolon and the next clause out of a trailing line comment', () => {
    const state = builderState();
    state.where = [{ kind: 'raw', text: 'c.id = 1 -- the test customer' }];
    assert.ok(buildBuilderSql(state).endsWith('-- the test customer\n;'));
    state.orderBy = [{ expr: 'c.id' }];
    assert.ok(buildBuilderSql(state).endsWith('-- the test customer\nORDER BY c.id;'));
});

test('buildBuilderSql returns nothing for an empty state', () => {
    assert.equal(buildBuilderSql({ ...builderState(), tables: [], selectItems: [], joins: [] }), '');
});

// The Data Viewer writes a builder state with builderStateToSql (browser),
// the extension host with buildBuilderSql: both must mean the same statement.
const { readBuilderState, builderStateToSql } = require(path.join(__dirname, '../../../src/webview/tableView.js'));

const PARITY_QUERIES = [
    "SELECT c.id, o.total AS amount FROM customers c LEFT JOIN orders o ON o.customer_id = c.id AND o.state = 'open' "
        + 'WHERE o.total > $1 AND (c.name = :name OR c.id = 1) ORDER BY c.name DESC NULLS LAST LIMIT 10',
    'WITH r AS (SELECT 1 AS x) SELECT DISTINCT ON (c.id) c.id, count(*) FROM customers c JOIN r ON TRUE '
        + 'GROUP BY c.id HAVING count(*) > 1 OFFSET 5 FETCH FIRST 3 ROWS ONLY',
    'SELECT * FROM a JOIN b USING (id) NATURAL LEFT JOIN c, d WHERE a.x = d.y FOR UPDATE',
    'SELECT s.t FROM (SELECT customer_id, sum(total) AS t FROM orders GROUP BY 1) s CROSS JOIN generate_series(1, 3) g UNION ALL SELECT 1',
    "SELECT name FROM customers WHERE name LIKE 'A%' -- only A\nORDER BY 1",
    'SELECT orders.id, customers.name FROM public.orders JOIN customers ON customers.id = orders.customer_id OR customers.id IS NULL WHERE v_flag'
];

test('buildBuilderSql writes the same statement as the Data Viewer for the states it reads', () => {
    const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
    for (const query of PARITY_QUERIES) {
        const state = readBuilderState(query);
        assert.ok(state, `readBuilderState cannot read: ${query}`);
        assert.equal(normalize(buildBuilderSql(state, { semicolon: false })), normalize(builderStateToSql(state)), query);
    }
    const built = builderState();
    built.selectItems = built.selectItems.map(item => (item.kind === 'column' ? { kind: 'column', tableIndex: item.tableIndex, column: item.column } : item));
    built.joins[0].type = 'CROSS JOIN';
    built.where = [{ kind: 'compare', left: 'c.id', operator: '=', right: '$1' }, { kind: 'raw', text: 'a OR b' }];
    assert.equal(normalize(buildBuilderSql(built, { semicolon: false })), normalize(builderStateToSql(built)));
    // USING next to another condition, and an ORDER BY / LIMIT next to a UNION.
    const using = readBuilderState('SELECT * FROM a JOIN b USING (id, kind) UNION SELECT * FROM z ORDER BY 1');
    using.tables[0].columns = ['id'];
    using.joins[0].rawConditions.push('b.x > 1');
    using.orderBy = [{ expr: 'a.id' }];
    using.carried.limit = '5';
    const usingSql = normalize(buildBuilderSql(using, { semicolon: false }));
    assert.equal(usingSql, 'SELECT * FROM a INNER JOIN b ON b.id = a.id AND b.kind = a.kind AND b.x > 1 UNION SELECT * FROM z ORDER BY 1');
    assert.equal(usingSql, normalize(builderStateToSql(using)));
});

// ===== loadJoinMetadata / initialJoinsFor =====

function fakeJoinData() {
    const requested: Array<Array<{ schema: string; table: string }>> = [];
    const runner = {
        getMultiTableJoinData: async (tables: Array<{ schema: string; table: string }>) => {
            requested.push(tables);
            const known: Record<string, { columns: string[]; first: string }> = {
                customers: { columns: ['cus_id', '"Name"'], first: 'cus_id' },
                orders: { columns: ['ord_id', 'ord_cus_id', 'ord_state'], first: 'ord_id' }
            };
            return {
                tables: tables.map(t => ({
                    schema: t.schema,
                    table: t.table,
                    tableReference: t.table,
                    columns: known[t.table].columns,
                    rawColumns: known[t.table].columns.map(c => c.replace(/"/g, '')),
                    ...(t.table === 'orders' ? { columnTypes: ['integer', 'integer', 'timestamp with time zone'] } : {}),
                    firstColumnRaw: known[t.table].first
                })),
                foreignKeys: [{ fromSchema: 'public', fromTable: 'orders', fromColumn: 'ord_cus_id', toSchema: 'public', toTable: 'customers', toColumn: 'cus_id' }]
            };
        }
    };
    return { runner, requested };
}

test('loadJoinMetadata reads each table once and gives every instance a unique alias', async () => {
    const { runner, requested } = fakeJoinData();
    const store = { get: (_s: string, t: string) => (t === 'orders' ? 'o' : undefined) };
    const meta = await loadJoinMetadata(runner, undefined, [
        { schema: 'public', table: 'customers' },
        { schema: 'public', table: 'orders' },
        { schema: 'public', table: 'orders' }
    ], store);
    assert.equal(requested.length, 1);
    assert.equal(requested[0].length, 2);
    assert.deepEqual(meta.tables.map(t => [t.alias, t.savedAlias]), [['cus', undefined], ['o', 'o'], ['o2', 'o']]);
    assert.deepEqual(meta.tables[0].columns, ['cus_id', '"Name"']);
    assert.deepEqual(meta.tables[1].columnTypes, ['integer', 'integer', 'timestamp with time zone'], 'the types feed the date picker');
    assert.equal('columnTypes' in meta.tables[0], false, 'no types, no key');
    assert.deepEqual(meta.identityEdges, [
        { fromSchema: 'public', fromTable: 'orders', fromColumn: 'ord_cus_id', toSchema: 'public', toTable: 'customers', toColumn: 'cus_id' }
    ]);
    const plain = await loadJoinMetadata(runner, undefined, [{ schema: 'public', table: 'orders' }, { schema: 'public', table: 'orders' }], store, { uniqueAliases: false });
    assert.deepEqual(plain.tables.map(t => t.alias), ['o', 'o']);
});

test('loadJoinMetadata adds custom mappings with their quoted columns and conditions', async () => {
    const { runner } = fakeJoinData();
    const mappings = {
        getAllMappings: () => [{
            id: 'm1', sourceSchema: 'public', sourceTable: 'orders', sourceColumn: 'ord_id',
            targetSchema: 'public', targetTable: 'customers', targetColumn: 'Name',
            conditions: [{ column: 'ord_state', operator: '=', value: 'open' }]
        }, {
            id: 'm2', sourceSchema: 'public', sourceTable: 'orders', sourceColumn: 'ord_cus_id',
            targetSchema: 'public', targetTable: 'customers', targetColumn: 'cus_id'
        }] as any[]
    };
    const meta = await loadJoinMetadata(runner, mappings, [{ schema: 'public', table: 'customers' }, { schema: 'public', table: 'orders' }]);
    assert.equal(meta.identityEdges.length, 2, 'a mapping repeating a foreign key is not added twice');
    assert.deepEqual(meta.identityEdges[1], {
        fromSchema: 'public', fromTable: 'orders', fromColumn: 'ord_id',
        toSchema: 'public', toTable: 'customers', toColumn: '"Name"',
        extraConditions: [{ schema: 'public', table: 'orders', column: 'ord_state', operator: '=', value: 'open' }]
    });

    const joins = initialJoinsFor(meta.tables, meta.identityEdges);
    assert.deepEqual(joins, [{
        type: 'INNER JOIN',
        conditions: [
            { leftAlias: 'cus', leftColumn: 'cus_id', rightColumn: 'ord_cus_id' },
            { leftAlias: 'cus', leftColumn: '"Name"', rightColumn: 'ord_id' }
        ],
        literalConditions: [{ literalAlias: 'ord', literalColumn: 'ord_state', operator: '=', value: 'open' }]
    }]);
});

test('initialJoinsFor cross joins a table without a relation', () => {
    const joins = initialJoinsFor(
        [{ schema: 'public', table: 'a', alias: 'a' }, { schema: 'public', table: 'b', alias: 'b' }],
        []
    );
    assert.deepEqual(joins, [{ type: 'CROSS JOIN', conditions: [] }]);
});
