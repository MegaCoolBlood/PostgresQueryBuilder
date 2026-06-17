import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const { uniqueAlias, computeAutoJoinClause } = require(
    path.join(__dirname, '../../src/webview/joinDialogLogic.js')
);

// ===== uniqueAlias =====

test('uniqueAlias returns the base when it is free', () => {
    assert.equal(uniqueAlias('emp', []), 'emp');
    assert.equal(uniqueAlias('emp', ['cust', 'ord']), 'emp');
});

test('uniqueAlias appends 2 for the first collision', () => {
    assert.equal(uniqueAlias('emp', ['emp']), 'emp2');
});

test('uniqueAlias skips already-taken numeric suffixes', () => {
    assert.equal(uniqueAlias('emp', ['emp', 'emp2']), 'emp3');
    assert.equal(uniqueAlias('emp', ['emp', 'emp2', 'emp3']), 'emp4');
});

test('uniqueAlias reuses a suffix freed by removing a table', () => {
    // emp2 was removed, so only emp remains visible: emp2 becomes free again
    // instead of jumping to emp3.
    assert.equal(uniqueAlias('emp', ['emp']), 'emp2');
});

// ===== computeAutoJoinClause =====

const empTables = () => [
    { schema: 'public', table: 'employees' },
    { schema: 'public', table: 'employees' }
];

// Self-referencing FK: employees.mgr_id -> employees.id
const selfEdge = {
    fromSchema: 'public', fromTable: 'employees', fromColumn: 'mgr_id',
    toSchema: 'public', toTable: 'employees', toColumn: 'id'
};

test('computeAutoJoinClause offers conditions for a second instance of the same table', () => {
    const clause = computeAutoJoinClause(1, [0, 1], empTables(), [selfEdge]);
    assert.equal(clause.type, 'INNER JOIN');
    assert.deepEqual(clause.conditions, [
        // second instance (orig 1) holds mgr_id, partner (orig 0) is referenced
        { leftOrig: 0, leftColumn: 'id', rightColumn: 'mgr_id' }
    ]);
    assert.deepEqual(clause.literals, []);
});

test('computeAutoJoinClause picks the earliest related preceding table as partner', () => {
    const tables = [
        { schema: 'public', table: 'customers' },
        { schema: 'public', table: 'unrelated' },
        { schema: 'public', table: 'orders' }
    ];
    const edge = {
        fromSchema: 'public', fromTable: 'orders', fromColumn: 'cust_id',
        toSchema: 'public', toTable: 'customers', toColumn: 'id'
    };
    const clause = computeAutoJoinClause(2, [0, 1, 2], tables, [edge]);
    assert.equal(clause.type, 'INNER JOIN');
    assert.deepEqual(clause.conditions, [
        { leftOrig: 0, leftColumn: 'id', rightColumn: 'cust_id' }
    ]);
});

test('computeAutoJoinClause links a parent referenced by the new child', () => {
    const tables = [
        { schema: 'public', table: 'customers' },
        { schema: 'public', table: 'orders' }
    ];
    const edge = {
        fromSchema: 'public', fromTable: 'orders', fromColumn: 'cust_id',
        toSchema: 'public', toTable: 'customers', toColumn: 'id'
    };
    const clause = computeAutoJoinClause(1, [0, 1], tables, [edge]);
    assert.deepEqual(clause.conditions, [
        { leftOrig: 0, leftColumn: 'id', rightColumn: 'cust_id' }
    ]);
});

test('computeAutoJoinClause falls back to CROSS JOIN without a related table', () => {
    const tables = [
        { schema: 'public', table: 'a' },
        { schema: 'public', table: 'b' }
    ];
    const clause = computeAutoJoinClause(1, [0, 1], tables, []);
    assert.equal(clause.type, 'CROSS JOIN');
    assert.deepEqual(clause.conditions, []);
    assert.deepEqual(clause.literals, []);
});

test('computeAutoJoinClause carries extra literal conditions from a custom mapping', () => {
    const tables = [
        { schema: 'public', table: 'orders' },
        { schema: 'public', table: 'customers' }
    ];
    const edge = {
        fromSchema: 'public', fromTable: 'orders', fromColumn: 'cust_id',
        toSchema: 'public', toTable: 'customers', toColumn: 'id',
        extraConditions: [
            { schema: 'public', table: 'orders', column: 'status', operator: '=', value: 'active' }
        ]
    };
    const clause = computeAutoJoinClause(1, [0, 1], tables, [edge]);
    assert.deepEqual(clause.conditions, [
        { leftOrig: 0, leftColumn: 'cust_id', rightColumn: 'id' }
    ]);
    assert.deepEqual(clause.literals, [
        { litOrig: 0, otherOrig: 1, litColumn: 'status', operator: '=', value: 'active' }
    ]);
});

test('computeAutoJoinClause only considers tables before the new one', () => {
    // The related table sits AFTER the new table in the order, so it is not a
    // valid (earlier) partner: result is a CROSS JOIN.
    const tables = [
        { schema: 'public', table: 'orders' },
        { schema: 'public', table: 'customers' }
    ];
    const edge = {
        fromSchema: 'public', fromTable: 'orders', fromColumn: 'cust_id',
        toSchema: 'public', toTable: 'customers', toColumn: 'id'
    };
    // new table is orders (orig 0) placed first; customers (orig 1) comes later
    const clause = computeAutoJoinClause(0, [0, 1], tables, [edge]);
    assert.equal(clause.type, 'CROSS JOIN');
});
