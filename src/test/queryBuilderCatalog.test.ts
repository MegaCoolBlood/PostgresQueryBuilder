import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildForeignKeysQuery,
    listColumns,
    listForeignKeys,
    mappingJoinEdges,
    QB_COLUMNS_QUERY,
    toStringArray,
    type CatalogRow
} from '../queryBuilderCatalog';
import type { CustomColumnMapping } from '../columnMappingManager';
import { parseSql } from '../queryBuilderParser';

/** A query function that records its calls and answers with `rows`. */
function fakeQuery(rows: CatalogRow[]) {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const query = async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return rows;
    };
    return { calls, query };
}

// ===== listColumns =====

test('listColumns queries one relation by parameters and maps type, nullability and primary key', async () => {
    const { calls, query } = fakeQuery([
        { column_name: 'id', data_type: 'integer', is_nullable: false, ordinal: 1, is_primary_key: true },
        { column_name: 'Name', data_type: 'character varying(40)', is_nullable: true, ordinal: 3, is_primary_key: false }
    ]);
    const columns = await listColumns(query, 'public', 'Order');
    assert.deepEqual(calls, [{ sql: QB_COLUMNS_QUERY, params: ['public', 'Order'] }]);
    assert.deepEqual(columns, [
        { name: 'id', dataType: 'integer', nullable: false, isPrimaryKey: true, ordinal: 1 },
        { name: 'Name', dataType: 'character varying(40)', nullable: true, isPrimaryKey: false, ordinal: 3 }
    ]);
});

// ===== listForeignKeys =====

test('listForeignKeys by schemas maps multi-column keys in key order', async () => {
    const { calls, query } = fakeQuery([{
        constraint_name: 'items_order_fk', schema_name: 'public', table_name: 'order_items',
        ref_schema: 'public', ref_table: 'orders', columns: ['order_id', 'shop_id'], ref_columns: '{id,"shop id"}'
    }]);
    const keys = await listForeignKeys(query, { schemas: ['public'] });
    assert.deepEqual(calls[0].params, [['public']]);
    assert.match(calls[0].sql, /con\.contype = 'f'/);
    assert.match(calls[0].sql, /unnest\(con\.conkey, con\.confkey\) WITH ORDINALITY/);
    assert.deepEqual(keys, [{
        name: 'items_order_fk', schema: 'public', table: 'order_items', columns: ['order_id', 'shop_id'],
        refSchema: 'public', refTable: 'orders', refColumns: ['id', 'shop id']
    }]);
});

test('listForeignKeys by tables passes schemas and names as parallel array parameters', async () => {
    const { calls, query } = fakeQuery([]);
    await listForeignKeys(query, { tables: [{ schema: 'public', name: 'orders' }, { schema: 'hr', name: 'emp' }] });
    assert.deepEqual(calls[0].params, [['public', 'hr'], ['orders', 'emp']]);
    assert.doesNotMatch(calls[0].sql, /orders'|'emp/);
});

test('listForeignKeys does not query for an empty scope', async () => {
    const { calls, query } = fakeQuery([]);
    assert.deepEqual(await listForeignKeys(query, { schemas: [] }), []);
    assert.deepEqual(await listForeignKeys(query, { tables: [] }), []);
    assert.equal(calls.length, 0);
});

test('the catalog queries are valid PostgreSQL', async () => {
    for (const sql of [
        QB_COLUMNS_QUERY,
        buildForeignKeysQuery({ schemas: ['a'] }).sql,
        buildForeignKeysQuery({ tables: [{ schema: 'a', name: 'b' }] }).sql
    ]) {
        await assert.doesNotReject(parseSql(sql), sql);
    }
});

test('toStringArray reads driver arrays and array literals', () => {
    assert.deepEqual(toStringArray(['a', 'b']), ['a', 'b']);
    assert.deepEqual(toStringArray('{a,"b,c","d\\"e"}'), ['a', 'b,c', 'd"e']);
    assert.deepEqual(toStringArray('{}'), []);
    assert.deepEqual(toStringArray(null), []);
});

// ===== mappingJoinEdges =====

function mapping(overrides: Partial<CustomColumnMapping>): CustomColumnMapping {
    return {
        id: 'm', sourceSchema: 'public', sourceTable: 'orders', sourceColumn: 'cust_no',
        targetSchema: 'public', targetTable: 'customers', targetColumn: 'number',
        conditions: [], isDefault: false, ...overrides
    };
}

const ORDERS_AND_CUSTOMERS = [{ schema: 'public', name: 'orders' }, { schema: 'public', name: 'customers' }];

test('mappingJoinEdges reads a mapping like a foreign key, with its additional pairs and its conditions', () => {
    const edges = mappingJoinEdges([mapping({
        label: 'by number',
        additionalColumnPairs: [{ sourceColumn: 'shop', targetColumn: 'shop' }],
        conditions: [{ column: 'kind', operator: 'like', value: "O'B" }, { column: 'x', operator: '; DROP', value: '1' }]
    })], ORDERS_AND_CUSTOMERS);
    assert.deepEqual(edges, [{
        name: 'by number', mapping: true,
        schema: 'public', table: 'orders', columns: ['cust_no', 'shop'],
        refSchema: 'public', refTable: 'customers', refColumns: ['number', 'shop'],
        conditions: [{ column: 'kind', operator: 'LIKE', value: "O'B" }]
    }]);
});

test('mappingJoinEdges takes only mappings between the given tables and one per pair of tables, the default first', () => {
    const tables = [...ORDERS_AND_CUSTOMERS, { schema: 'public', name: 'shops' }];
    const edges = mappingJoinEdges([
        mapping({ id: 'first' }),
        mapping({ id: 'reverse', sourceTable: 'customers', sourceColumn: 'number', targetTable: 'orders', targetColumn: 'cust_no', isDefault: true }),
        mapping({ id: 'later', targetColumn: 'other' }),
        mapping({ id: 'elsewhere', targetTable: 'invoices' }),
        mapping({ id: 'self', targetTable: 'orders' }),
        mapping({ id: 'shops', targetTable: 'shops', targetColumn: 'id' })
    ], tables);
    assert.deepEqual(edges.map((e) => [e.table, e.columns[0], e.refTable, e.refColumns[0]]), [
        ['customers', 'number', 'orders', 'cust_no'],
        ['orders', 'cust_no', 'shops', 'id']
    ]);
    assert.deepEqual(mappingJoinEdges([mapping({ id: 'first' }), mapping({ id: 'later', targetColumn: 'other' })], ORDERS_AND_CUSTOMERS)
        .map((e) => e.refColumns[0]), ['number'], 'without a default the first mapping wins');
});
