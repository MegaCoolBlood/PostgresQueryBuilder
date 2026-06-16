import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    QueryRunner,
    SELECTABLE_TABLE_TYPES,
    SELECTABLE_TABLE_TYPES_SQL,
    buildRelationListQuery,
    buildSchemaRelationListQuery
} from '../queryRunner';

function createRunner(metadataHandler?: (sql: string, params?: any[]) => Promise<any[]> | any[]) {
    const metadataCalls: Array<{ sql: string; params?: any[] }> = [];
    const connectionManager = {
        queryMetadata: async (sql: string, params?: any[]) => {
            metadataCalls.push({ sql, params });
            if (metadataHandler) {
                return await metadataHandler(sql, params);
            }
            return [];
        }
    };
    const runner = new QueryRunner(
        connectionManager as any,
        () => ({ alwaysQualifySchema: false, alwaysQuote: false })
    );
    return { runner, metadataCalls };
}

test('SELECTABLE_TABLE_TYPES contains both foreign-table spellings', () => {
    assert.ok(SELECTABLE_TABLE_TYPES.includes('FOREIGN'));
    assert.ok(SELECTABLE_TABLE_TYPES.includes('FOREIGN TABLE'));
    assert.ok(SELECTABLE_TABLE_TYPES.includes('BASE TABLE'));
});

test('SELECTABLE_TABLE_TYPES includes views', () => {
    assert.ok(SELECTABLE_TABLE_TYPES.includes('VIEW'));
});

test('SELECTABLE_TABLE_TYPES_SQL renders a quoted value list', () => {
    assert.equal(SELECTABLE_TABLE_TYPES_SQL, "'BASE TABLE', 'FOREIGN', 'FOREIGN TABLE', 'VIEW'");
});

test('listAllTables filters on all selectable table types including foreign tables', async () => {
    const { runner, metadataCalls } = createRunner();
    await runner.listAllTables();

    assert.equal(metadataCalls.length, 1);
    const sql = metadataCalls[0].sql;
    assert.ok(sql.includes(`table_type IN (${SELECTABLE_TABLE_TYPES_SQL})`));
    assert.ok(sql.includes("'FOREIGN TABLE'"));
    assert.ok(sql.includes("'FOREIGN'"));
    assert.ok(sql.includes("'VIEW'"));
    assert.ok(sql.includes('pg_matviews'));
});

test('buildRelationListQuery merges information_schema relations with materialized views', () => {
    const sql = buildRelationListQuery();
    assert.ok(sql.includes('information_schema.tables'));
    assert.ok(sql.includes('FROM pg_matviews'));
    assert.ok(sql.includes('matviewname'));
    assert.ok(sql.includes("table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')"));
});

test('buildSchemaRelationListQuery filters both sources by schema parameter and includes materialized views', () => {
    const sql = buildSchemaRelationListQuery();
    assert.ok(sql.includes('information_schema.tables'));
    assert.ok(sql.includes('table_schema = $1'));
    assert.ok(sql.includes('FROM pg_matviews'));
    assert.ok(sql.includes('schemaname = $1'));
});

test('listAllTables returns foreign tables reported as either FOREIGN or FOREIGN TABLE', async () => {
    const { runner } = createRunner(() => [
        { table_schema: 'public', table_name: 'local_table' },
        { table_schema: 'ext', table_name: 'foreign_modern' },
        { table_schema: 'ext', table_name: 'foreign_legacy' }
    ]);

    const tables = await runner.listAllTables();
    assert.deepEqual(tables, [
        { schema: 'public', table: 'local_table' },
        { schema: 'ext', table: 'foreign_modern' },
        { schema: 'ext', table: 'foreign_legacy' }
    ]);
});

test('listAllTables returns views alongside tables', async () => {
    const { runner } = createRunner(() => [
        { table_schema: 'public', table_name: 'users' },
        { table_schema: 'public', table_name: 'active_users_view' }
    ]);

    const tables = await runner.listAllTables();
    assert.deepEqual(tables, [
        { schema: 'public', table: 'users' },
        { schema: 'public', table: 'active_users_view' }
    ]);
});

test('listAllTables returns materialized views merged from pg_matviews', async () => {
    const { runner } = createRunner(() => [
        { table_schema: 'public', table_name: 'orders' },
        { table_schema: 'reporting', table_name: 'daily_sales_mv' }
    ]);

    const tables = await runner.listAllTables();
    assert.deepEqual(tables, [
        { schema: 'public', table: 'orders' },
        { schema: 'reporting', table: 'daily_sales_mv' }
    ]);
});
