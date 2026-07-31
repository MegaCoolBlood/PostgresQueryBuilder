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

test('parseSearchPath splits a plain comma-separated search_path', () => {
    assert.deepEqual(
        QueryRunner.parseSearchPath('leda, leda_types, oracle', 'leda'),
        ['leda', 'leda_types', 'oracle']
    );
});

test('parseSearchPath replaces $user with the current user name', () => {
    assert.deepEqual(
        QueryRunner.parseSearchPath('"$user", public', 'alice'),
        ['alice', 'public']
    );
});

test('parseSearchPath handles unquoted $user and drops it when no user is given', () => {
    assert.deepEqual(QueryRunner.parseSearchPath('$user, public', ''), ['public']);
});

test('parseSearchPath strips surrounding double quotes and unescapes ""', () => {
    assert.deepEqual(
        QueryRunner.parseSearchPath('"My Schema", "a""b", public', 'u'),
        ['My Schema', 'a"b', 'public']
    );
});

test('parseSearchPath skips empty entries and trims whitespace', () => {
    assert.deepEqual(QueryRunner.parseSearchPath('  leda ,, , oracle ', 'u'), ['leda', 'oracle']);
});

test('parseSearchPath returns an empty list for an empty search_path', () => {
    assert.deepEqual(QueryRunner.parseSearchPath('', 'u'), []);
});

test('getSelectBuildInfo finds the schema via SHOW search_path even when current_schemas would be empty', async () => {
    // Regression: a pooled connection reported current_schemas(false) = [] even
    // though `SHOW search_path` correctly listed the schema. We now rely on
    // current_setting('search_path'), so the schema must be recognised.
    const { runner } = createRunner({
        activeConnectionConfig: { schemas: ['leda', 'leda_dev', 'leda_qa'] },
        queryHandler: (sql: string) => {
            if (sql.includes('current_setting')) {
                return { rows: [{ search_path: 'leda, leda_types, oracle', current_user: 'leda' }] };
            }
            throw new Error(`Unexpected query: ${sql}`);
        }
    });

    const buildInfo = await runner.getSelectBuildInfo('leda', 'bos_benutzer');
    assert.deepEqual(buildInfo, { alwaysQuote: false, tableReference: 'bos_benutzer' });
});

test('getSelectBuildInfo resolves a $user entry in the search_path to the current user', async () => {
    const { runner } = createRunner({
        queryHandler: (sql: string) => {
            if (sql.includes('current_setting')) {
                return { rows: [{ search_path: '"$user", public', current_user: 'leda' }] };
            }
            throw new Error(`Unexpected query: ${sql}`);
        }
    });

    const buildInfo = await runner.getSelectBuildInfo('leda', 'bos_benutzer');
    assert.deepEqual(buildInfo, { alwaysQuote: false, tableReference: 'bos_benutzer' });
});

test('getSelectBuildInfo qualifies schema even when it is in the connection display schemas but not on the search path', async () => {
    // The connection's configured `schemas` is only a display filter for the
    // tree (here both `leda` and `leda_dev` are shown). Only `leda` is on the
    // runtime search_path, so opening a `leda_dev` foreign table must qualify
    // the schema, otherwise the query would resolve against `leda`.
    const { runner, queryCalls } = createRunner({
        activeConnectionConfig: { schemas: ['leda', 'leda_dev'] },
        queryHandler: (sql: string) => {
            if (sql.includes('current_setting')) {
                return { rows: [{ search_path: 'leda, leda_types, oracle, public', current_user: 'leda' }] };
            }
            throw new Error(`Unexpected query: ${sql}`);
        }
    });

    const buildInfo = await runner.getSelectBuildInfo('leda_dev', 'persons');

    assert.deepEqual(buildInfo, { alwaysQuote: false, tableReference: 'leda_dev.persons' });
    assert.equal(queryCalls.length, 1);
    assert.ok(queryCalls[0].sql.includes('current_setting'));
});

test('getSelectBuildInfo does not qualify a schema that is on the runtime search path', async () => {
    const { runner, queryCalls } = createRunner({
        activeConnectionConfig: { schemas: ['leda', 'leda_dev'] },
        queryHandler: (sql: string) => {
            if (sql.includes('current_setting')) {
                return { rows: [{ search_path: 'leda, leda_types, oracle, public', current_user: 'leda' }] };
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
            if (sql.includes('current_setting')) {
                return { rows: [{ search_path: 'public, audit', current_user: 'postgres' }] };
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
            if (sql.includes('current_setting')) {
                return { rows: [{ search_path: 'public', current_user: 'postgres' }] };
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
        { name: 'id', dataType: 'integer', isNullable: false, columnDefault: null, comment: null }
    ]);
    assert.deepEqual(await runner.getPrimaryKeys('public', 'users'), ['id']);
    assert.deepEqual(await runner.getForeignKeys('public', 'orders'), [
        { column: 'user_id', refSchema: 'public', refTable: 'users', refColumn: 'id' }
    ]);
    assert.deepEqual(await runner.getReferencingTables('public', 'users'), [
        { fkSchema: 'public', fkTable: 'orders', fkColumn: 'user_id', localColumn: 'id' }
    ]);
});

test('getColumns maps a column comment and defaults a missing comment to null', async () => {
    const { runner, metadataCalls } = createRunner({
        metadataHandler: (sql: string) => {
            assert.ok(sql.includes('information_schema.columns'));
            assert.ok(sql.includes('pg_description'));
            return [
                { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null, column_comment: 'Primary key' },
                { column_name: 'name', data_type: 'text', is_nullable: 'YES', column_default: null, column_comment: null }
            ];
        }
    });

    assert.deepEqual(await runner.getColumns('public', 'users'), [
        { name: 'id', dataType: 'integer', isNullable: false, columnDefault: null, comment: 'Primary key' },
        { name: 'name', dataType: 'text', isNullable: true, columnDefault: null, comment: null }
    ]);
    assert.deepEqual(metadataCalls[0].params, ['public', 'users']);
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

    const sql = runner.generateSQL([{ schema: 'public', table: 'test_table', changes }]);

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

    const sql = runner.generateSQL([{
        schema: 'public',
        table: 'users',
        changes: {
            updates: [],
            inserts: [{ userId: 1 }],
            deletes: []
        }
    }]);

    assert.equal(sql, 'INSERT INTO "public"."users" ("userId") VALUES (1);');
});

test('commitChanges throws when not connected', async () => {
    const { runner } = createRunner({
        pool: undefined
    });

    await assert.rejects(() => runner.commitChanges([{ schema: 'public', table: 'users', changes: { updates: [], inserts: [], deletes: [] } }]), /Not connected to database/);
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

    await runner.commitChanges([{
        schema: 'public',
        table: 'users',
        changes: {
            updates: [{ primaryKey: { id: 1 }, changes: { name: 'Alice' } }],
            inserts: [{ id: 2, name: 'Bob' }, { emptyField: '' }],
            deletes: [{ id: 3 }]
        }
    }]);

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
            runner.commitChanges([{
                schema: 'public',
                table: 'users',
                changes: {
                    updates: [{ primaryKey: { id: 1 }, changes: { name: 'Alice' } }],
                    inserts: [],
                    deletes: []
                }
            }]),
        /boom/
    );

    assert.deepEqual(statements, ['BEGIN', 'UPDATE public.users SET name = $1 WHERE id = $2', 'ROLLBACK']);
    assert.equal(client.releaseCalled, true);
});

test('commitChanges identifies rows by all columns (with IS NULL) when there is no primary key', async () => {
    const statements: Array<{ sql: string; params?: any[] }> = [];
    const client = {
        query: async (sql: string, params?: any[]) => {
            statements.push({ sql, params });
            return {};
        },
        releaseCalled: false,
        release() { this.releaseCalled = true; }
    };

    const { runner } = createRunner({
        options: { alwaysQualifySchema: true, alwaysQuote: false },
        pool: { connect: async () => client }
    });

    await runner.commitChanges([{
        schema: 'public',
        table: 'log',
        changes: {
            updates: [{ primaryKey: { ts: '2026-01-01', level: 'info', note: null }, changes: { level: 'warn' } }],
            inserts: [],
            deletes: [{ ts: '2026-01-02', level: 'error', note: null }]
        }
    }]);

    assert.deepEqual(statements.map(s => s.sql), [
        'BEGIN',
        'UPDATE public.log SET level = $1 WHERE ts = $2 AND level = $3 AND note IS NULL',
        'DELETE FROM public.log WHERE ts = $1 AND level = $2 AND note IS NULL',
        'COMMIT'
    ]);
    // Null identity columns are emitted as IS NULL and contribute no params.
    assert.deepEqual(statements[1].params, ['warn', '2026-01-01', 'info']);
    assert.deepEqual(statements[2].params, ['2026-01-02', 'error']);
    assert.equal(client.releaseCalled, true);
});

test('commitChanges refuses an UPDATE with an empty row identity', async () => {
    const statements: string[] = [];
    const client = {
        query: async (sql: string) => { statements.push(sql); return {}; },
        releaseCalled: false,
        release() { this.releaseCalled = true; }
    };

    const { runner } = createRunner({
        options: { alwaysQualifySchema: true, alwaysQuote: false },
        pool: { connect: async () => client }
    });

    await assert.rejects(
        () => runner.commitChanges([{
            schema: 'public',
            table: 'log',
            changes: {
                updates: [{ primaryKey: {}, changes: { level: 'warn' } }],
                inserts: [],
                deletes: []
            }
        }]),
        /no columns available to identify the row/
    );
    // The bad UPDATE must never reach the database; the transaction rolls back.
    assert.ok(!statements.some(s => s.startsWith('UPDATE')));
    assert.ok(statements.includes('ROLLBACK'));
    assert.equal(client.releaseCalled, true);
});

test('commitChanges refuses a DELETE with an empty row identity', async () => {
    const statements: string[] = [];
    const client = {
        query: async (sql: string) => { statements.push(sql); return {}; },
        releaseCalled: false,
        release() { this.releaseCalled = true; }
    };

    const { runner } = createRunner({
        options: { alwaysQualifySchema: true, alwaysQuote: false },
        pool: { connect: async () => client }
    });

    await assert.rejects(
        () => runner.commitChanges([{
            schema: 'public',
            table: 'log',
            changes: {
                updates: [],
                inserts: [],
                deletes: [{}]
            }
        }]),
        /no columns available to identify the row/
    );
    assert.ok(!statements.some(s => s.startsWith('DELETE')));
    assert.ok(statements.includes('ROLLBACK'));
    assert.equal(client.releaseCalled, true);
});

test('generateSQL formats NULL values correctly', () => {
    const { runner } = createRunner({
        options: { alwaysQualifySchema: true, alwaysQuote: false }
    });

    const sql = runner.generateSQL([{
        schema: 'public',
        table: 'users',
        changes: {
            updates: [{ primaryKey: { id: 1 }, changes: { name: null, score: undefined } }],
            inserts: [],
            deletes: []
        }
    }]);

    assert.equal(sql, "UPDATE public.users SET name = NULL, score = NULL WHERE id = 1;");
});

test('generateSQL builds a full-row WHERE clause when the table has no primary key', () => {
    const { runner } = createRunner({
        options: { alwaysQualifySchema: true, alwaysQuote: false }
    });

    // Without a primary key the webview sends every column as the row identity.
    const sql = runner.generateSQL([{
        schema: 'public',
        table: 'log',
        changes: {
            updates: [{
                primaryKey: { ts: '2026-01-01', level: 'info', msg: "it's fine" },
                changes: { level: 'warn' }
            }],
            inserts: [],
            deletes: [{ ts: '2026-01-02', level: 'error', msg: 'boom' }]
        }
    }]);

    assert.equal(
        sql,
        "UPDATE public.log SET level = 'warn' WHERE ts = '2026-01-01' AND level = 'info' AND msg = 'it''s fine';\n\n" +
            "DELETE FROM public.log WHERE ts = '2026-01-02' AND level = 'error' AND msg = 'boom';"
    );
});

test('generateSQL emits IS NULL for null identity columns in UPDATE and DELETE', () => {
    const { runner } = createRunner({
        options: { alwaysQualifySchema: true, alwaysQuote: false }
    });

    const sql = runner.generateSQL([{
        schema: 'public',
        table: 'log',
        changes: {
            updates: [{ primaryKey: { a: 1, note: null }, changes: { note: 'set' } }],
            inserts: [],
            deletes: [{ a: 2, note: null }]
        }
    }]);

    assert.equal(
        sql,
        "UPDATE public.log SET note = 'set' WHERE a = 1 AND note IS NULL;\n\n" +
            "DELETE FROM public.log WHERE a = 2 AND note IS NULL;"
    );
});

test('generateSQL skips inserts where all fields are empty or null', () => {
    const { runner } = createRunner({
        options: { alwaysQualifySchema: true, alwaysQuote: false }
    });

    const sql = runner.generateSQL([{
        schema: 'public',
        table: 'users',
        changes: {
            updates: [],
            inserts: [{ name: '', age: null }],
            deletes: []
        }
    }]);

    assert.equal(sql, '');
});

test('formatIdentifier quotes identifiers with uppercase letters', () => {
    const { runner } = createRunner({
        options: { alwaysQualifySchema: true, alwaysQuote: false }
    });

    const sql = runner.generateSQL([{
        schema: 'public',
        table: 'Users',
        changes: {
            updates: [],
            inserts: [{ UserId: 1 }],
            deletes: []
        }
    }]);

    assert.equal(sql, 'INSERT INTO public."Users" ("UserId") VALUES (1);');
});

test('formatIdentifier escapes double quotes in identifiers', () => {
    const { runner } = createRunner({
        options: { alwaysQualifySchema: false, alwaysQuote: true }
    });

    const sql = runner.generateSQL([{
        schema: 'public',
        table: 'ta"ble',
        changes: {
            updates: [],
            inserts: [],
            deletes: [{ id: 1 }]
        }
    }]);

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

    // Should NOT call current_setting since alwaysQualifySchema is true
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

    await runner.commitChanges([{
        schema: 'public',
        table: 'users',
        changes: {
            updates: [{ primaryKey: { id: 1 }, changes: { name: null } }],
            inserts: [],
            deletes: []
        }
    }]);

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

    await runner.commitChanges([{
        schema: 'public',
        table: 'users',
        changes: {
            updates: [],
            inserts: [{ id: 5, name: 'Test' }],
            deletes: []
        }
    }]);

    assert.equal(statements[1].sql, 'INSERT INTO "public"."users" ("id", "name") VALUES ($1, $2)');
    assert.deepEqual(statements[1].params, [5, 'Test']);
});

// ===== 2.2.2: writing back to several source tables and verified row identity =====

/** Fake pooled client that records statements and reports a fixed rowCount. */
function createRecordingClient(rowCount: number | undefined = 1) {
    const statements: Array<{ sql: string; params?: any[] }> = [];
    const client = {
        statements,
        query: async (sql: string, params?: any[]) => {
            statements.push({ sql, params });
            return rowCount === undefined ? {} : { rowCount };
        },
        released: false,
        release() { this.released = true; }
    };
    return client;
}

test('commitChanges writes to every target table inside a single transaction', async () => {
    const client = createRecordingClient();
    const { runner } = createRunner({
        options: { alwaysQualifySchema: true, alwaysQuote: false },
        pool: { connect: async () => client }
    });

    await runner.commitChanges([
        {
            schema: 'public',
            table: 'users',
            identityStrategy: 'pk',
            changes: { updates: [{ primaryKey: { id: 1 }, changes: { name: 'Alice' } }], inserts: [], deletes: [] }
        },
        {
            schema: 'public',
            table: 'orders',
            identityStrategy: 'pk',
            changes: { updates: [{ primaryKey: { id: 9 }, changes: { qty: 5 } }], inserts: [], deletes: [] }
        }
    ]);

    assert.deepEqual(client.statements.map(s => s.sql), [
        'BEGIN',
        'UPDATE public.users SET name = $1 WHERE id = $2',
        'UPDATE public.orders SET qty = $1 WHERE id = $2',
        'COMMIT'
    ]);
    assert.equal(client.released, true);
});

test('commitChanges rolls back when a row without a primary key matches more than one row', async () => {
    const client = createRecordingClient(2);
    const { runner } = createRunner({
        options: { alwaysQualifySchema: true, alwaysQuote: false },
        pool: { connect: async () => client }
    });

    await assert.rejects(
        () => runner.commitChanges([{
            schema: 'app',
            table: 'log',
            identityStrategy: 'row',
            changes: {
                updates: [{ primaryKey: { msg: 'hi' }, changes: { msg: 'ho' } }],
                inserts: [],
                deletes: []
            }
        }]),
        /2 rows/
    );

    assert.ok(client.statements.some(s => s.sql === 'ROLLBACK'));
    assert.equal(client.released, true);
});

test('commitChanges accepts an unambiguous match without a primary key', async () => {
    const client = createRecordingClient(1);
    const { runner } = createRunner({
        options: { alwaysQualifySchema: true, alwaysQuote: false },
        pool: { connect: async () => client }
    });

    await runner.commitChanges([{
        schema: 'app',
        table: 'log',
        identityStrategy: 'row',
        changes: { updates: [], inserts: [], deletes: [{ msg: 'hi' }] }
    }]);

    assert.deepEqual(client.statements.map(s => s.sql), [
        'BEGIN',
        'DELETE FROM app.log WHERE msg = $1',
        'COMMIT'
    ]);
});

test('commitChanges does not verify the affected row count when a primary key identifies the row', async () => {
    const client = createRecordingClient(0);
    const { runner } = createRunner({
        options: { alwaysQualifySchema: true, alwaysQuote: false },
        pool: { connect: async () => client }
    });

    // A primary-key match is unique by definition, so a 0-row result (e.g. the
    // row was deleted meanwhile) must not abort the whole transaction here.
    await runner.commitChanges([{
        schema: 'public',
        table: 'users',
        identityStrategy: 'pk',
        changes: { updates: [{ primaryKey: { id: 1 }, changes: { name: 'Alice' } }], inserts: [], deletes: [] }
    }]);

    assert.ok(client.statements.some(s => s.sql === 'COMMIT'));
});

test('generateSQL emits the statements of every target', () => {
    const { runner } = createRunner({
        options: { alwaysQualifySchema: true, alwaysQuote: false }
    });

    const sql = runner.generateSQL([
        { schema: 'public', table: 'users', changes: { updates: [], inserts: [{ id: 1 }], deletes: [] } },
        { schema: 'public', table: 'orders', changes: { updates: [], inserts: [], deletes: [{ id: 9 }] } }
    ]);

    assert.equal(
        sql,
        'INSERT INTO public.users (id) VALUES (1);\n\nDELETE FROM public.orders WHERE id = 9;'
    );
});

// ===== 2.2.2: letting the database check an entered value =====

test('isPlainTypeName accepts the type names format_type() produces', () => {
    for (const name of ['integer', 'character varying(5)', 'numeric(10,2)', 'timestamp without time zone', 'text[]', 'my_type']) {
        assert.equal(QueryRunner.isPlainTypeName(name), true, name);
    }
});

test('isPlainTypeName rejects anything that could smuggle SQL into a cast', () => {
    for (const name of ['text); DROP TABLE users --', "text'", '"MySchema".mytype', 'text; SELECT 1', '']) {
        assert.equal(QueryRunner.isPlainTypeName(name), false, name);
    }
});

test('checkValueCast asks the database to cast the value to the column type', async () => {
    const { runner, queryCalls } = createRunner({});
    const result = await runner.checkValueCast('smallint', '42');

    assert.deepEqual(result, { valid: true });
    assert.equal(queryCalls[0].sql, 'SELECT CAST($1::text AS smallint)');
    assert.deepEqual(queryCalls[0].params, ['42']);
});

test('checkValueCast reports the database error as the reason', async () => {
    const { runner } = createRunner({
        queryHandler: () => { throw new Error('invalid input syntax for type timestamp: "31-31-2024"\nLINE 1: ...'); }
    });

    const result = await runner.checkValueCast('timestamp without time zone', '31-31-2024');

    assert.equal(result.valid, false);
    assert.equal(result.reason, 'invalid input syntax for type timestamp: "31-31-2024"');
});

test('checkValueCast skips NULL and unsafe type names without querying', async () => {
    const { runner, queryCalls } = createRunner({});

    assert.deepEqual(await runner.checkValueCast('integer', null), { valid: true });
    assert.deepEqual(await runner.checkValueCast('text); DROP TABLE t --', 'x'), { valid: true });
    assert.equal(queryCalls.length, 0);
});

// ===== 2.2.2: executing statements edited in the commit preview =====

test('executeStatements runs every statement of the edited script in one transaction', async () => {
    const client = createRecordingClient();
    const { runner } = createRunner({ pool: { connect: async () => client } });

    await runner.executeStatements("UPDATE t SET a = 1;\nDELETE FROM t WHERE b = 'x;y';");

    assert.deepEqual(client.statements.map(s => s.sql), [
        'BEGIN',
        'UPDATE t SET a = 1',
        "DELETE FROM t WHERE b = 'x;y'",
        'COMMIT'
    ]);
    assert.equal(client.released, true);
});

test('executeStatements rolls back when a statement fails', async () => {
    const statements: string[] = [];
    const client = {
        query: async (sql: string) => {
            statements.push(sql);
            if (sql.startsWith('DELETE')) { throw new Error('boom'); }
            return { rowCount: 1 };
        },
        released: false,
        release() { this.released = true; }
    };
    const { runner } = createRunner({ pool: { connect: async () => client } });

    await assert.rejects(() => runner.executeStatements('UPDATE t SET a = 1; DELETE FROM t;'), /boom/);

    assert.deepEqual(statements, ['BEGIN', 'UPDATE t SET a = 1', 'DELETE FROM t', 'ROLLBACK']);
    assert.equal(client.released, true);
});

test('executeStatements rejects an empty script before connecting', async () => {
    const { runner } = createRunner({ pool: undefined });
    await assert.rejects(() => runner.executeStatements('   ;  '), /no statement to execute/i);
});

test('executeStatements throws when there is no connection', async () => {
    const { runner } = createRunner({ pool: undefined });
    await assert.rejects(() => runner.executeStatements('DELETE FROM t'), /Not connected to database/);
});

// ===== 2.2.2: on-demand row count for an arbitrary query =====


test('getQueryRowCount counts the rows of a query without fetching them', async () => {
    const { runner, queryCalls } = createRunner({
        queryHandler: () => ({ rows: [{ count: '42' }] })
    });

    const count = await runner.getQueryRowCount('SELECT * FROM public.users WHERE active');

    assert.equal(count, 42);
    assert.equal(
        queryCalls[0].sql,
        'SELECT COUNT(*) AS count FROM (SELECT * FROM public.users WHERE active) AS _pqb_count'
    );
});

test('getQueryRowCount strips a trailing semicolon before wrapping the query', async () => {
    const { runner, queryCalls } = createRunner({
        queryHandler: () => ({ rows: [{ count: '1' }] })
    });

    await runner.getQueryRowCount('SELECT 1;  ');

    assert.equal(queryCalls[0].sql, 'SELECT COUNT(*) AS count FROM (SELECT 1) AS _pqb_count');
});

// ===== 2.2.2: capabilities resolved from the result metadata =====

test('resolveEditPlan maps result fields to their source table and primary key', async () => {
    const { runner } = createRunner({
        metadataHandler: (sql: string) => {
            if (sql.includes('pg_class')) {
                return [{ oid: 100, nspname: 'public', relname: 'users', relkind: 'r' }];
            }
            if (sql.includes('pg_index')) {
                return [{ attname: 'id' }];
            }
            if (sql.includes('pg_attribute')) {
                return [
                    { attrelid: 100, attnum: 1, attname: 'id' },
                    { attrelid: 100, attnum: 2, attname: 'name' }
                ];
            }
            return [];
        }
    });

    const caps = await runner.resolveEditPlan([
        { name: 'id', dataTypeID: 23, tableID: 100, columnID: 1 },
        { name: 'full_name', dataTypeID: 25, tableID: 100, columnID: 2 },
        { name: 'computed', dataTypeID: 23, tableID: 0, columnID: 0 }
    ]);

    assert.equal(caps.canEdit, true);
    assert.equal(caps.canInsert, true);
    assert.equal(caps.table, 'users');
    assert.equal(caps.identityStrategy, 'pk');
    assert.deepEqual(caps.editableColumns, ['id', 'full_name']);
    assert.equal(caps.columnSources['full_name'].sourceColumn, 'name');
});

test('resolveEditPlan reports a read-only result when no field comes from a table', async () => {
    const { runner, metadataCalls } = createRunner();

    const caps = await runner.resolveEditPlan([{ name: '?column?', dataTypeID: 23, tableID: 0, columnID: 0 }]);

    assert.equal(caps.canEdit, false);
    assert.equal(caps.table, null);
    // No relation to look up, so the catalog is not queried at all.
    assert.equal(metadataCalls.length, 0);
});

test('resolveEditPlan marks a view as not editable', async () => {
    const { runner } = createRunner({
        metadataHandler: (sql: string) => {
            if (sql.includes('pg_class')) {
                return [{ oid: 100, nspname: 'public', relname: 'active_users', relkind: 'v' }];
            }
            if (sql.includes('pg_attribute')) {
                return [{ attrelid: 100, attnum: 1, attname: 'id' }];
            }
            return [];
        }
    });

    const caps = await runner.resolveEditPlan([{ name: 'id', dataTypeID: 23, tableID: 100, columnID: 1 }]);

    assert.equal(caps.canEdit, false);
    assert.equal(caps.canInsert, false);
    // A single relation still allows constraints and column mappings.
    assert.equal(caps.canConstrain, true);
    assert.equal(caps.table, 'active_users');
});
