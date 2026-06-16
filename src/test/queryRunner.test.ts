import test from 'node:test';
import assert from 'node:assert/strict';
import { ChangeSet, QueryRunner } from '../queryRunner';

type SelectOptions = { alwaysQualifySchema: boolean; alwaysQuote: boolean };

function createRunner({
    options = { alwaysQualifySchema: false, alwaysQuote: false },
    activeConnectionConfig,
    queryHandler,
    metadataHandler,
    pool
}: {
    options?: SelectOptions;
    activeConnectionConfig?: any;
    queryHandler?: (sql: string, params?: any[]) => Promise<any> | any;
    metadataHandler?: (sql: string, params?: any[]) => Promise<any[]> | any[];
    pool?: any;
} = {}) {
    const queryCalls: Array<{ sql: string; params?: any[] }> = [];
    const metadataCalls: Array<{ sql: string; params?: any[] }> = [];

    const connectionManager = {
        query: async (sql: string, params?: any[]) => {
            queryCalls.push({ sql, params });
            if (queryHandler) {
                return await queryHandler(sql, params);
            }
            return { rows: [], fields: [], rowCount: 0 };
        },
        queryMetadata: async (sql: string, params?: any[]) => {
            metadataCalls.push({ sql, params });
            if (metadataHandler) {
                return await metadataHandler(sql, params);
            }
            return [];
        },
        getPool: () => pool,
        getActiveConnectionConfig: () => activeConnectionConfig
    };

    const runner = new QueryRunner(connectionManager as any, () => options);
    return { runner, queryCalls, metadataCalls };
}

test('getSelectBuildInfo qualifies schema even when it is in the connection display schemas but not on the search path', async () => {
    // The connection's configured `schemas` is only a display filter for the
    // tree (here both `leda` and `leda_dev` are shown). Only `leda` is on the
    // runtime search_path, so opening a `leda_dev` foreign table must qualify
    // the schema, otherwise the query would resolve against `leda`.
    const { runner, queryCalls } = createRunner({
        activeConnectionConfig: { schemas: ['leda', 'leda_dev'] },
        queryHandler: (sql: string) => {
            if (sql.includes('current_schemas')) {
                return { rows: [{ schemas: ['leda', 'leda_types', 'oracle', 'public'] }] };
            }
            throw new Error(`Unexpected query: ${sql}`);
        }
    });

    const buildInfo = await runner.getSelectBuildInfo('leda_dev', 'persons');

    assert.deepEqual(buildInfo, { alwaysQuote: false, tableReference: 'leda_dev.persons' });
    assert.equal(queryCalls.length, 1);
    assert.ok(queryCalls[0].sql.includes('current_schemas'));
});

test('getSelectBuildInfo does not qualify a schema that is on the runtime search path', async () => {
    const { runner, queryCalls } = createRunner({
        activeConnectionConfig: { schemas: ['leda', 'leda_dev'] },
        queryHandler: (sql: string) => {
            if (sql.includes('current_schemas')) {
                return { rows: [{ schemas: ['leda', 'leda_types', 'oracle', 'public'] }] };
            }
            throw new Error(`Unexpected query: ${sql}`);
        }
    });

    const buildInfo = await runner.getSelectBuildInfo('leda', 'persons');

    assert.deepEqual(buildInfo, { alwaysQuote: false, tableReference: 'persons' });
    assert.equal(queryCalls.length, 1);
});

test('getSelectBuildInfo uses runtime search path when connection schemas are not configured', async () => {
    const { runner } = createRunner({
        queryHandler: (sql: string) => {
            if (sql.includes('current_schemas')) {
                return { rows: [{ schemas: ['public', 'audit'] }] };
            }
            throw new Error(`Unexpected query: ${sql}`);
        }
    });

    const buildInfo = await runner.getSelectBuildInfo('public', 'users');
    assert.deepEqual(buildInfo, { alwaysQuote: false, tableReference: 'users' });
});

test('fetchRows qualifies schema when schema is outside search path', async () => {
    const { runner, queryCalls } = createRunner({
        queryHandler: (sql: string) => {
            if (sql.includes('current_schemas')) {
                return { rows: [{ schemas: ['public'] }] };
            }
            if (sql.includes('SELECT *')) {
                return { rows: [{ id: 1 }] };
            }
            throw new Error(`Unexpected query: ${sql}`);
        }
    });

    const rows = await runner.fetchRows('sales', 'orders', 20, 10);

    assert.deepEqual(rows, [{ id: 1 }]);
    assert.equal(queryCalls[1].sql, 'SELECT * FROM sales.orders LIMIT $1 OFFSET $2');
    assert.deepEqual(queryCalls[1].params, [10, 20]);
});

test('getRowCount parses integer count response', async () => {
    const { runner, queryCalls } = createRunner({
        options: { alwaysQualifySchema: true, alwaysQuote: false },
        queryHandler: () => ({ rows: [{ count: '12' }] })
    });

    const count = await runner.getRowCount('public', 'users');

    assert.equal(count, 12);
    assert.equal(queryCalls[0].sql, 'SELECT COUNT(*) as count FROM public.users');
});

test('metadata methods map PostgreSQL rows into extension-friendly objects', async () => {
    const { runner } = createRunner({
        metadataHandler: (sql: string) => {
            if (sql.includes('information_schema.columns')) {
                return [{ column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null }];
            }
            if (sql.includes('i.indisprimary')) {
                return [{ attname: 'id' }];
            }
            if (sql.includes('AS ref_schema')) {
                return [{ fk_column: 'user_id', ref_schema: 'public', ref_table: 'users', ref_column: 'id' }];
            }
            if (sql.includes('AS fk_schema')) {
                return [{ fk_schema: 'public', fk_table: 'orders', fk_column: 'user_id', local_column: 'id' }];
            }
            throw new Error(`Unexpected metadata query: ${sql}`);
        }
    });

    assert.deepEqual(await runner.getColumns('public', 'users'), [
        { name: 'id', dataType: 'integer', isNullable: false, columnDefault: null }
    ]);
    assert.deepEqual(await runner.getPrimaryKeys('public', 'users'), ['id']);
    assert.deepEqual(await runner.getForeignKeys('public', 'orders'), [
        { column: 'user_id', refSchema: 'public', refTable: 'users', refColumn: 'id' }
    ]);
    assert.deepEqual(await runner.getReferencingTables('public', 'users'), [
        { fkSchema: 'public', fkTable: 'orders', fkColumn: 'user_id', localColumn: 'id' }
    ]);
});

test('executeSQL normalizes empty fields and rowCount', async () => {
    const { runner } = createRunner({
        queryHandler: () => ({ rows: [{ id: 1 }] })
    });

    const result = await runner.executeSQL('SELECT 1');
    assert.deepEqual(result, { rows: [{ id: 1 }], fields: [], rowCount: 0 });
});

test('generateSQL includes update, insert, delete, and reserved keyword quoting rules', () => {
    const { runner } = createRunner({
        options: { alwaysQualifySchema: true, alwaysQuote: false }
    });

    const changes: ChangeSet = {
        updates: [{ primaryKey: { id: 1 }, changes: { name: "O'Reilly", active: true, score: 7 } }],
        inserts: [{ id: 2, select: 'value', emptyField: '' }],
        deletes: [{ id: 3 }]
    };

    const sql = runner.generateSQL('public', 'test_table', changes);

    assert.equal(
        sql,
        `UPDATE public.test_table SET name = 'O''Reilly', active = TRUE, score = 7 WHERE id = 1;\n\n` +
            `INSERT INTO public.test_table (id, "select") VALUES (2, 'value');\n\n` +
            `DELETE FROM public.test_table WHERE id = 3;`
    );
});

test('generateSQL quotes identifiers when alwaysQuote is enabled', () => {
    const { runner } = createRunner({
        options: { alwaysQualifySchema: true, alwaysQuote: true }
    });

    const sql = runner.generateSQL('public', 'users', {
        updates: [],
        inserts: [{ userId: 1 }],
        deletes: []
    });

    assert.equal(sql, 'INSERT INTO "public"."users" ("userId") VALUES (1);');
});

test('commitChanges throws when not connected', async () => {
    const { runner } = createRunner({
        pool: undefined
    });

    await assert.rejects(() => runner.commitChanges('public', 'users', { updates: [], inserts: [], deletes: [] }), /Not connected to database/);
});

test('commitChanges runs update, insert and delete statements inside one transaction', async () => {
    const statements: Array<{ sql: string; params?: any[] }> = [];
    const client = {
        query: async (sql: string, params?: any[]) => {
            statements.push({ sql, params });
            return {};
        },
        releaseCalled: false,
        release() {
            this.releaseCalled = true;
        }
    };

    const { runner } = createRunner({
        options: { alwaysQualifySchema: true, alwaysQuote: false },
        pool: { connect: async () => client }
    });

    await runner.commitChanges('public', 'users', {
        updates: [{ primaryKey: { id: 1 }, changes: { name: 'Alice' } }],
        inserts: [{ id: 2, name: 'Bob' }, { emptyField: '' }],
        deletes: [{ id: 3 }]
    });

    assert.deepEqual(statements.map(s => s.sql), [
        'BEGIN',
        'UPDATE public.users SET name = $1 WHERE id = $2',
        'INSERT INTO public.users (id, name) VALUES ($1, $2)',
        'DELETE FROM public.users WHERE id = $1',
        'COMMIT'
    ]);
    assert.deepEqual(statements[1].params, ['Alice', 1]);
    assert.deepEqual(statements[2].params, [2, 'Bob']);
    assert.deepEqual(statements[3].params, [3]);
    assert.equal(statements.filter(s => s.sql.startsWith('INSERT INTO')).length, 1);
    assert.equal(client.releaseCalled, true);
});

test('commitChanges rolls back and releases client when a statement fails', async () => {
    const statements: string[] = [];
    const client = {
        query: async (sql: string) => {
            statements.push(sql);
            if (sql.startsWith('UPDATE')) {
                throw new Error('boom');
            }
            return {};
        },
        releaseCalled: false,
        release() {
            this.releaseCalled = true;
        }
    };

    const { runner } = createRunner({
        options: { alwaysQualifySchema: true, alwaysQuote: false },
        pool: { connect: async () => client }
    });

    await assert.rejects(
        () =>
            runner.commitChanges('public', 'users', {
                updates: [{ primaryKey: { id: 1 }, changes: { name: 'Alice' } }],
                inserts: [],
                deletes: []
            }),
        /boom/
    );

    assert.deepEqual(statements, ['BEGIN', 'UPDATE public.users SET name = $1 WHERE id = $2', 'ROLLBACK']);
    assert.equal(client.releaseCalled, true);
});

test('generateSQL formats NULL values correctly', () => {
    const { runner } = createRunner({
        options: { alwaysQualifySchema: true, alwaysQuote: false }
    });

    const sql = runner.generateSQL('public', 'users', {
        updates: [{ primaryKey: { id: 1 }, changes: { name: null, score: undefined } }],
        inserts: [],
        deletes: []
    });

    assert.equal(sql, "UPDATE public.users SET name = NULL, score = NULL WHERE id = 1;");
});

test('generateSQL skips inserts where all fields are empty or null', () => {
    const { runner } = createRunner({
        options: { alwaysQualifySchema: true, alwaysQuote: false }
    });

    const sql = runner.generateSQL('public', 'users', {
        updates: [],
        inserts: [{ name: '', age: null }],
        deletes: []
    });

    assert.equal(sql, '');
});

test('formatIdentifier quotes identifiers with uppercase letters', () => {
    const { runner } = createRunner({
        options: { alwaysQualifySchema: true, alwaysQuote: false }
    });

    const sql = runner.generateSQL('public', 'Users', {
        updates: [],
        inserts: [{ UserId: 1 }],
        deletes: []
    });

    assert.equal(sql, 'INSERT INTO public."Users" ("UserId") VALUES (1);');
});

test('formatIdentifier escapes double quotes in identifiers', () => {
    const { runner } = createRunner({
        options: { alwaysQualifySchema: false, alwaysQuote: true }
    });

    const sql = runner.generateSQL('public', 'ta"ble', {
        updates: [],
        inserts: [],
        deletes: [{ id: 1 }]
    });

    assert.equal(sql, 'DELETE FROM "public"."ta""ble" WHERE "id" = 1;');
});

test('getSelectTableReference always qualifies when alwaysQualifySchema is true', async () => {
    const { runner, queryCalls } = createRunner({
        options: { alwaysQualifySchema: true, alwaysQuote: false },
        queryHandler: (sql: string) => {
            if (sql.includes('SELECT *')) {
                return { rows: [{ id: 1 }] };
            }
            throw new Error(`Unexpected query: ${sql}`);
        }
    });

    await runner.fetchRows('public', 'users', 0, 10);

    // Should NOT call current_schemas since alwaysQualifySchema is true
    assert.equal(queryCalls.length, 1);
    assert.equal(queryCalls[0].sql, 'SELECT * FROM public.users LIMIT $1 OFFSET $2');
});

test('fetchRows with alwaysQuote quotes identifiers', async () => {
    const { runner, queryCalls } = createRunner({
        options: { alwaysQualifySchema: true, alwaysQuote: true },
        queryHandler: (sql: string) => {
            if (sql.includes('SELECT *')) {
                return { rows: [] };
            }
            throw new Error(`Unexpected query: ${sql}`);
        }
    });

    await runner.fetchRows('public', 'users', 0, 10);

    assert.equal(queryCalls[0].sql, 'SELECT * FROM "public"."users" LIMIT $1 OFFSET $2');
});

test('commitChanges passes null values as parameters', async () => {
    const statements: Array<{ sql: string; params?: any[] }> = [];
    const client = {
        query: async (sql: string, params?: any[]) => {
            statements.push({ sql, params });
            return {};
        },
        release() {}
    };

    const { runner } = createRunner({
        options: { alwaysQualifySchema: true, alwaysQuote: false },
        pool: { connect: async () => client }
    });

    await runner.commitChanges('public', 'users', {
        updates: [{ primaryKey: { id: 1 }, changes: { name: null } }],
        inserts: [],
        deletes: []
    });

    assert.equal(statements[1].sql, 'UPDATE public.users SET name = $1 WHERE id = $2');
    assert.deepEqual(statements[1].params, [null, 1]);
});

test('commitChanges with alwaysQuote quotes all identifiers', async () => {
    const statements: Array<{ sql: string; params?: any[] }> = [];
    const client = {
        query: async (sql: string, params?: any[]) => {
            statements.push({ sql, params });
            return {};
        },
        release() {}
    };

    const { runner } = createRunner({
        options: { alwaysQualifySchema: true, alwaysQuote: true },
        pool: { connect: async () => client }
    });

    await runner.commitChanges('public', 'users', {
        updates: [],
        inserts: [{ id: 5, name: 'Test' }],
        deletes: []
    });

    assert.equal(statements[1].sql, 'INSERT INTO "public"."users" ("id", "name") VALUES ($1, $2)');
    assert.deepEqual(statements[1].params, [5, 'Test']);
});
