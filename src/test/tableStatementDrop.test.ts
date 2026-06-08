import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStatement, deriveQualifier, buildJoinSelect, autoJoinClauses } from '../statementBuilder';

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
