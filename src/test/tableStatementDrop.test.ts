import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStatement, deriveQualifier, buildJoinSelect, buildRelatedTableJoin, qualifyColumnReferences, autoJoinClauses } from '../statementBuilder';

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
