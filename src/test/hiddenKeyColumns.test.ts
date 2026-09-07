import test from 'node:test';
import assert from 'node:assert/strict';
import { addHiddenKeyColumns, isHiddenKeyColumn, planHiddenKeyColumns, resultColumnQualifiers } from '../hiddenKeyColumns';
import type { ColumnSource, IdentityStrategy, TableEditPlan } from '../resultSource';

function col(name: string, tableOid: number, table: string, sourceColumn: string): ColumnSource {
    return { name, tableOid, schema: 'public', table, sourceColumn };
}

function plan(
    tableOid: number,
    table: string,
    columns: ColumnSource[],
    missingKeyColumns: string[],
    identityStrategy: IdentityStrategy = 'row'
): TableEditPlan {
    return { tableOid, schema: 'public', table, identityStrategy, identityColumns: columns, columns, missingKeyColumns };
}

/** One table whose key is not selected: `SELECT o.customer_id AS kunden_nr`. */
const ORDERS = plan(1, 'orders', [col('kunden_nr', 1, 'orders', 'customer_id')], ['id']);

const names = (tables: TableEditPlan[]) => tables.flatMap(t => t.columns.map(c => c.name));

test('planHiddenKeyColumns adds the key of an aliased table', () => {
    const keys = planHiddenKeyColumns('SELECT o.customer_id AS kunden_nr FROM orders o', [ORDERS], names([ORDERS]));
    assert.deepEqual(keys, [{ name: '__pqb_key_0', qualifier: 'o', column: 'id' }]);
});

test('planHiddenKeyColumns adds a composite key in full', () => {
    const composite = plan(1, 'orders', [col('kunden_nr', 1, 'orders', 'customer_id')], ['tenant', 'id']);
    const keys = planHiddenKeyColumns('SELECT o.customer_id AS kunden_nr FROM orders o', [composite], []);
    assert.deepEqual(keys.map(k => k.column), ['tenant', 'id']);
    assert.deepEqual(keys.map(k => k.name), ['__pqb_key_0', '__pqb_key_1']);
});

test('planHiddenKeyColumns picks the alias of each table of a joined query', () => {
    const sql = 'SELECT o.customer_id AS kunden_nr, /* hi */ c.name AS kunde\n'
        + '-- o.id AS bestellung,\n'
        + 'FROM orders o LEFT JOIN customers c ON c.id = o.customer_id';
    const tables = [ORDERS, plan(2, 'customers', [col('kunde', 2, 'customers', 'name')], ['id'])];
    const keys = planHiddenKeyColumns(sql, tables, names(tables));
    assert.deepEqual(keys, [
        { name: '__pqb_key_0', qualifier: 'o', column: 'id' },
        { name: '__pqb_key_1', qualifier: 'c', column: 'id' }
    ]);
});

test('planHiddenKeyColumns skips a table that is selected through two aliases', () => {
    const sql = 'SELECT a.value AS first, b.value AS second FROM attributes a JOIN attributes b ON b.id = a.next';
    const twice = plan(1, 'attributes', [
        col('first', 1, 'attributes', 'value'),
        col('second', 1, 'attributes', 'value')
    ], ['id']);
    assert.deepEqual(planHiddenKeyColumns(sql, [twice], names([twice])), []);
});

test('planHiddenKeyColumns gives each alias of a twice-joined table its own key', () => {
    const sql = 'SELECT a.value AS first, b.value AS second FROM attributes a JOIN attributes b ON b.id = a.next';
    const first = { ...plan(1, 'attributes', [col('first', 1, 'attributes', 'value')], ['id']), qualifier: 'a' };
    const second = { ...plan(1, 'attributes', [col('second', 1, 'attributes', 'value')], ['id']), qualifier: 'b' };

    assert.deepEqual(planHiddenKeyColumns(sql, [first, second], ['first', 'second']), [
        { name: '__pqb_key_0', qualifier: 'a', column: 'id' },
        { name: '__pqb_key_1', qualifier: 'b', column: 'id' }
    ]);
});

test('resultColumnQualifiers reports the alias every column is selected through', () => {
    const sql = 'SELECT a.value AS first, b.value AS second, count(*) AS total, id FROM attributes a JOIN attributes b ON b.id = a.next';
    const qualifiers = resultColumnQualifiers(sql);

    assert.equal(qualifiers.get('first'), 'a');
    assert.equal(qualifiers.get('second'), 'b');
    assert.equal(qualifiers.get('total'), undefined);
    assert.equal(qualifiers.get('id'), undefined);
});

test('resultColumnQualifiers leaves out a name two aliases give the same way', () => {
    const qualifiers = resultColumnQualifiers('SELECT a.value, b.value FROM attributes a JOIN attributes b ON b.id = a.next');
    assert.equal(qualifiers.has('value'), false);
});

test('resultColumnQualifiers reports nothing for a query that cannot be read', () => {
    assert.equal(resultColumnQualifiers('UPDATE t SET x = 1').size, 0);
});

test('planHiddenKeyColumns skips a table whose columns are all computed', () => {
    const computed = plan(1, 'orders', [col('kunden_nr', 1, 'orders', 'customer_id')], ['id']);
    const sql = 'SELECT upper(o.customer_id) AS kunden_nr FROM orders o';
    assert.deepEqual(planHiddenKeyColumns(sql, [computed], names([computed])), []);
});

test('planHiddenKeyColumns leaves a query alone that must not gain a column', () => {
    const cases: Record<string, string> = {
        grouped: 'SELECT o.customer_id AS kunden_nr FROM orders o GROUP BY o.customer_id',
        distinct: 'SELECT DISTINCT o.customer_id AS kunden_nr FROM orders o',
        combined: 'SELECT o.customer_id AS kunden_nr FROM orders o UNION SELECT 1 FROM x',
        cte: 'WITH x AS (SELECT 1) SELECT o.customer_id AS kunden_nr FROM orders o',
        several: 'SELECT o.customer_id AS kunden_nr FROM orders o; SELECT 1',
        nothing: 'SELECT 1 AS kunden_nr'
    };
    for (const [label, sql] of Object.entries(cases)) {
        assert.deepEqual(planHiddenKeyColumns(sql, [ORDERS], names([ORDERS])), [], label);
    }
});

test('planHiddenKeyColumns keeps a grouped sub-select from blocking the rewrite', () => {
    const sql = 'SELECT o.customer_id AS kunden_nr FROM orders o'
        + ' LEFT JOIN (SELECT s.id, max(s.n) AS total FROM stats s GROUP BY s.id) t ON t.id = o.id';
    assert.deepEqual(planHiddenKeyColumns(sql, [ORDERS], names([ORDERS])).length, 1);
});

test('planHiddenKeyColumns adds an unqualified key only when nothing else is joined', () => {
    const single = plan(1, 'orders', [col('customer_id', 1, 'orders', 'customer_id')], ['id']);
    assert.deepEqual(planHiddenKeyColumns('SELECT customer_id FROM orders', [single], ['customer_id']), [
        { name: '__pqb_key_0', qualifier: '', column: 'id' }
    ]);
    assert.deepEqual(planHiddenKeyColumns('SELECT customer_id FROM orders, log', [single], ['customer_id']), []);
    assert.deepEqual(planHiddenKeyColumns('SELECT customer_id FROM orders JOIN log ON true', [single], ['customer_id']), []);
});

test('planHiddenKeyColumns ignores a table that is already identified by its key', () => {
    const identified = plan(1, 'orders', [col('id', 1, 'orders', 'id')], [], 'pk');
    assert.deepEqual(planHiddenKeyColumns('SELECT o.id FROM orders o', [identified], ['id']), []);
});

test('planHiddenKeyColumns avoids a name the result already uses', () => {
    const keys = planHiddenKeyColumns('SELECT o.customer_id AS kunden_nr FROM orders o', [ORDERS], ['__pqb_key_0']);
    assert.deepEqual(keys.map(k => k.name), ['__pqb_key_1']);
});

test('planHiddenKeyColumns matches a quoted alias as the server folds it', () => {
    const quoted = plan(1, 'orders', [col('Kunden Nr', 1, 'orders', 'customer_id')], ['id']);
    const keys = planHiddenKeyColumns('SELECT o.customer_id AS "Kunden Nr" FROM orders o', [quoted], ['Kunden Nr']);
    assert.deepEqual(keys, [{ name: '__pqb_key_0', qualifier: 'o', column: 'id' }]);
});

test('addHiddenKeyColumns appends the keys to the select list', () => {
    const sql = addHiddenKeyColumns(
        'SELECT o.customer_id AS kunden_nr\nFROM orders o\nWHERE o.state = 1 LIMIT 100',
        [{ name: '__pqb_key_0', qualifier: 'o', column: 'id' }]
    );
    assert.equal(
        sql,
        'SELECT o.customer_id AS kunden_nr\n, o."id" AS "__pqb_key_0"\nFROM orders o\nWHERE o.state = 1 LIMIT 100'
    );
});

test('addHiddenKeyColumns leaves the FROM of a sub-select alone', () => {
    const sql = addHiddenKeyColumns(
        "SELECT (SELECT max(n) FROM stats) AS top, o.customer_id FROM orders o",
        [{ name: '__pqb_key_0', qualifier: 'o', column: 'id' }]
    );
    assert.match(sql, /o\."id" AS "__pqb_key_0"\nFROM orders o$/);
});

test('addHiddenKeyColumns writes an unqualified key without a prefix', () => {
    const sql = addHiddenKeyColumns('SELECT customer_id FROM orders', [{ name: '__pqb_key_0', qualifier: '', column: 'id' }]);
    assert.equal(sql, 'SELECT customer_id, "id" AS "__pqb_key_0"\nFROM orders');
});

test('addHiddenKeyColumns keeps a trailing comment from swallowing the key', () => {
    const sql = addHiddenKeyColumns(
        'SELECT o.customer_id AS kunden_nr -- the customer\nFROM orders o',
        [{ name: '__pqb_key_0', qualifier: 'o', column: 'id' }]
    );
    assert.equal(
        sql,
        'SELECT o.customer_id AS kunden_nr -- the customer\n, o."id" AS "__pqb_key_0"\nFROM orders o'
    );
});

test('addHiddenKeyColumns returns the query unchanged when there is nothing to add', () => {
    assert.equal(addHiddenKeyColumns('SELECT 1', []), 'SELECT 1');
    assert.equal(addHiddenKeyColumns('SELECT 1', [{ name: '__pqb_key_0', qualifier: '', column: 'id' }]), 'SELECT 1');
});

test('isHiddenKeyColumn recognises only the reserved alias', () => {
    assert.equal(isHiddenKeyColumn('__pqb_key_0'), true);
    assert.equal(isHiddenKeyColumn('kunden_nr'), false);
    assert.equal(isHiddenKeyColumn('pqb_key_0'), false);
});
