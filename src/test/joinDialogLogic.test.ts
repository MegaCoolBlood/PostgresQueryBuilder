import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const {
    uniqueAlias,
    computeAutoJoinClause,
    CUSTOM_OPERATORS,
    isUnaryOperator,
    isBetweenOperator,
    formatOperand,
    formatCustomCondition,
    formatSqlLiteral,
    literalToCustomCondition
} = require(
    path.join(__dirname, '../../../src/webview/joinDialogLogic.js')
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

test('computeAutoJoinClause builds a composite ON clause from multiple edges between the same tables', () => {
    const tables = [
        { schema: 'public', table: 'orders' },
        { schema: 'public', table: 'order_lines' }
    ];
    // A multi-column custom mapping yields one identity edge per column pair.
    const edges = [
        {
            fromSchema: 'public', fromTable: 'order_lines', fromColumn: 'order_id',
            toSchema: 'public', toTable: 'orders', toColumn: 'id'
        },
        {
            fromSchema: 'public', fromTable: 'order_lines', fromColumn: 'tenant_id',
            toSchema: 'public', toTable: 'orders', toColumn: 'tenant_id'
        }
    ];
    const clause = computeAutoJoinClause(1, [0, 1], tables, edges);
    assert.equal(clause.type, 'INNER JOIN');
    assert.deepEqual(clause.conditions, [
        { leftOrig: 0, leftColumn: 'id', rightColumn: 'order_id' },
        { leftOrig: 0, leftColumn: 'tenant_id', rightColumn: 'tenant_id' }
    ]);
    assert.deepEqual(clause.literals, []);
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

// ===== fixed/custom condition helpers =====

test('CUSTOM_OPERATORS exposes the supported operators', () => {
    assert.ok(CUSTOM_OPERATORS.includes('='));
    assert.ok(CUSTOM_OPERATORS.includes('BETWEEN'));
    assert.ok(CUSTOM_OPERATORS.includes('IS NULL'));
    assert.ok(CUSTOM_OPERATORS.includes('IS NOT NULL'));
});

test('isUnaryOperator detects IS NULL / IS NOT NULL', () => {
    assert.equal(isUnaryOperator('IS NULL'), true);
    assert.equal(isUnaryOperator('is not null'), true);
    assert.equal(isUnaryOperator('='), false);
    assert.equal(isUnaryOperator('BETWEEN'), false);
});

test('isBetweenOperator detects BETWEEN case-insensitively', () => {
    assert.equal(isBetweenOperator('BETWEEN'), true);
    assert.equal(isBetweenOperator('between'), true);
    assert.equal(isBetweenOperator('='), false);
});

test('formatOperand renders a column reference and raw text', () => {
    assert.equal(formatOperand({ kind: 'column', ref: 't.id' }), 't.id');
    assert.equal(formatOperand({ kind: 'raw', text: "'TGB'" }), "'TGB'");
    assert.equal(formatOperand({ kind: 'raw', text: 'CURRENT_TIMESTAMP' }), 'CURRENT_TIMESTAMP');
    assert.equal(formatOperand(null), '');
});

test('formatCustomCondition builds a simple comparison with a string literal', () => {
    assert.equal(
        formatCustomCondition({
            operator: '=',
            left: { kind: 'column', ref: 't.type' },
            right: { kind: 'raw', text: "'TGB'" }
        }),
        "t.type = 'TGB'"
    );
});

test('formatCustomCondition builds a column-to-column comparison', () => {
    assert.equal(
        formatCustomCondition({
            operator: '<=',
            left: { kind: 'column', ref: 'a.valid_from' },
            right: { kind: 'column', ref: 'b.valid_from' }
        }),
        'a.valid_from <= b.valid_from'
    );
});

test('formatCustomCondition builds a BETWEEN with a raw expression on the left', () => {
    assert.equal(
        formatCustomCondition({
            operator: 'BETWEEN',
            left: { kind: 'raw', text: 'CURRENT_TIMESTAMP' },
            right: { kind: 'column', ref: 't.valid_from' },
            right2: { kind: 'column', ref: 't.valid_to' }
        }),
        'CURRENT_TIMESTAMP BETWEEN t.valid_from AND t.valid_to'
    );
});

test('formatCustomCondition builds IS NULL / IS NOT NULL without a right operand', () => {
    assert.equal(
        formatCustomCondition({ operator: 'IS NULL', left: { kind: 'column', ref: 't.deleted_at' } }),
        't.deleted_at IS NULL'
    );
    assert.equal(
        formatCustomCondition({ operator: 'is not null', left: { kind: 'column', ref: 't.deleted_at' } }),
        't.deleted_at IS NOT NULL'
    );
});

test('formatCustomCondition returns empty string for incomplete rows', () => {
    assert.equal(formatCustomCondition(null), '');
    assert.equal(formatCustomCondition({ operator: '=', left: { kind: 'raw', text: '' }, right: { kind: 'raw', text: 'x' } }), '');
    assert.equal(formatCustomCondition({ operator: '=', left: { kind: 'column', ref: 't.id' }, right: { kind: 'raw', text: '' } }), '');
    assert.equal(formatCustomCondition({ operator: 'BETWEEN', left: { kind: 'column', ref: 't.id' }, right: { kind: 'raw', text: '1' } }), '');
});

test('formatCustomCondition uppercases a lowercase word operator', () => {
    assert.equal(
        formatCustomCondition({
            operator: 'like',
            left: { kind: 'column', ref: 't.name' },
            right: { kind: 'raw', text: "'A%'" }
        }),
        "t.name LIKE 'A%'"
    );
});

// ===== editing read-only custom-mapping conditions =====

test('formatSqlLiteral leaves numbers bare and quotes other values', () => {
    assert.equal(formatSqlLiteral('5'), '5');
    assert.equal(formatSqlLiteral('-3.14'), '-3.14');
    assert.equal(formatSqlLiteral('active'), "'active'");
    assert.equal(formatSqlLiteral("O'Brien"), "'O''Brien'");
});

test('literalToCustomCondition converts a string literal into an editable column = value row', () => {
    const cond = literalToCustomCondition({
        litOrig: 2, litColumn: 'status', operator: '=', value: 'active'
    });
    assert.deepEqual(cond, {
        operator: '=',
        left: { kind: 'column', orig: 2, column: 'status' },
        right: { kind: 'raw', text: "'active'" }
    });
});

test('literalToCustomCondition keeps numeric values unquoted', () => {
    const cond = literalToCustomCondition({
        litOrig: 0, litColumn: 'priority', operator: '>', value: '5'
    });
    assert.equal(cond.right.text, '5');
    assert.equal(cond.operator, '>');
    assert.deepEqual(cond.left, { kind: 'column', orig: 0, column: 'priority' });
});

test('literalToCustomCondition round-trips through formatCustomCondition', () => {
    // The converted, still-unedited condition must render to the same SQL the
    // read-only literal produced, only resolving the column via its alias.
    const cond = literalToCustomCondition({
        litOrig: 1, litColumn: 'type', operator: '=', value: 'TGB'
    });
    const resolved = {
        operator: cond.operator,
        left: { kind: 'column', ref: 'a.' + cond.left.column },
        right: cond.right
    };
    assert.equal(formatCustomCondition(resolved), "a.type = 'TGB'");
});

test('literalToCustomCondition defaults the operator when missing', () => {
    const cond = literalToCustomCondition({ litOrig: 0, litColumn: 'x', value: 'y' });
    assert.equal(cond.operator, '=');
});
