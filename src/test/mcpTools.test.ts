import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectionConfig } from '../connectionManager';
import {
    MCP_TOOLS,
    callTool,
    classifySql,
    classifyStatement,
    nameMatcher,
    requiredCapabilities,
    truncateText,
    type McpDbClient,
    type McpServices,
    type McpStatementResult,
    type ResolvedConnection
} from '../mcpTools';

const prod: ConnectionConfig = { name: 'prod', host: 'db.internal.example', port: 5432, database: 'app', user: 'alice_admin' };

interface Fake {
    services: McpServices;
    /** Every statement sent to the database, in order. */
    sql: string[];
    confirmations: Array<{ message: string; detail: string }>;
    clients: ResolvedConnection[];
    opened: string[];
}

/**
 * Services with one active connection; `answer` gives the result of a
 * statement sent with runStatement, `confirm` the user's choice.
 */
function fake(options: {
    saved?: ConnectionConfig[];
    active?: ConnectionConfig | null;
    answer?: (sql: string) => Partial<McpStatementResult> | Error | undefined;
    confirm?: boolean;
    maxRows?: number;
} = {}): Fake {
    const sql: string[] = [];
    const confirmations: Fake['confirmations'] = [];
    const clients: ResolvedConnection[] = [];
    const opened: string[] = [];
    const client: McpDbClient = {
        async query(text) {
            sql.push(text);
            return { rows: [], rowCount: 0 };
        },
        async runStatement(text) {
            sql.push(text);
            const answer = options.answer?.(text);
            if (answer instanceof Error) throw answer;
            return { fields: [], rows: [], rowCount: 0, command: text.split(/\s/)[0].toUpperCase(), ...answer };
        }
    };
    const services: McpServices = {
        savedConnections: () => options.saved ?? [prod],
        activeConnection: () => (options.active === undefined ? options.saved?.[0] ?? prod : options.active),
        async withClient(connection, work) {
            clients.push(connection);
            return work(client);
        },
        settings: () => ({ maxRows: options.maxRows ?? 500, statementTimeoutSeconds: 30 }),
        async askToProceed(message, detail) {
            confirmations.push({ message, detail });
            return options.confirm ?? true;
        },
        async openInDataViewer(text) { opened.push(text); },
        formatOptions: () => ({}),
        ddlOptions: () => ({ includeComments: true, includeOwner: true, includeGrants: true }),
        async plpgsqlCheck() { return []; },
        async readWorkspaceFile() { return ''; },
        async compareRepository() { return '# report'; },
        savedQueries: { list: () => [], add: async (q) => ({ ...q, id: 'q1' }) },
        mappings: { list: () => [], add: async (m) => ({ ...m, id: 'm1' }), update: async () => undefined, remove: async () => undefined }
    };
    return { services, sql, confirmations, clients, opened };
}

function tool(name: string) {
    const found = MCP_TOOLS.find((t) => t.name === name);
    assert.ok(found, `no tool ${name}`);
    return found;
}

function text(result: { content: Array<{ text: string }> }): string {
    return result.content.map((c) => c.text).join('\n');
}

const granted = (ai: ConnectionConfig['ai']): ConnectionConfig => ({ ...prod, ai });

// ===== classifyStatement =====

test('classifyStatement tells queries from writes', () => {
    assert.equal(classifyStatement('SELECT * FROM t'), 'read');
    assert.equal(classifyStatement('  (SELECT 1)'), 'read');
    assert.equal(classifyStatement('WITH x AS (SELECT 1) SELECT * FROM x'), 'read');
    assert.equal(classifyStatement('VALUES (1), (2)'), 'read');
    assert.equal(classifyStatement('TABLE t'), 'read');
    assert.equal(classifyStatement('SHOW search_path'), 'read');
    assert.equal(classifyStatement('SELECT * FROM t FOR UPDATE'), 'read', 'a row lock is no write; the read-only transaction refuses it');
    assert.equal(classifyStatement('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d'), 'dml');
    assert.equal(classifyStatement('SELECT * INTO copy FROM t'), 'ddl', 'SELECT INTO creates a table');
    for (const sql of ['INSERT INTO t VALUES (1)', 'update t set a = 1', 'DELETE FROM t', 'MERGE INTO t USING s ON true WHEN MATCHED THEN DELETE']) {
        assert.equal(classifyStatement(sql), 'dml', sql);
    }
    for (const sql of ['CREATE TABLE t (a int)', 'ALTER TABLE t ADD b int', 'DROP TABLE t', 'TRUNCATE t', 'GRANT SELECT ON t TO bob', 'REVOKE ALL ON t FROM bob', 'COMMENT ON TABLE t IS \'x\'']) {
        assert.equal(classifyStatement(sql), 'ddl', sql);
    }
    assert.equal(classifyStatement('CALL p()'), 'routine');
    assert.equal(classifyStatement('DO $$ BEGIN END $$'), 'routine');
    assert.equal(classifyStatement('BEGIN'), 'transaction');
    assert.equal(classifyStatement('COMMIT'), 'transaction');
    assert.equal(classifyStatement('SET search_path = x'), 'session');
    assert.equal(classifyStatement('EXPLAIN SELECT 1'), 'explain');
    assert.equal(classifyStatement('COPY t FROM \'/etc/passwd\''), 'unsupported');
    assert.equal(classifyStatement('VACUUM t'), 'unsupported');
});

test('classifyStatement ignores keywords in comments, strings and quoted names', () => {
    assert.equal(classifyStatement('-- DELETE FROM t\nSELECT 1'), 'read');
    assert.equal(classifyStatement('/* drop table t */ SELECT \'delete from t\' AS "insert"'), 'read');
    assert.equal(classifyStatement('SELECT $$update t set a = 1$$'), 'read');
    assert.equal(classifyStatement('SELECT update_date, deleted FROM t'), 'read', 'a word that only starts like a keyword');
    assert.equal(classifyStatement('/* SELECT */ DELETE FROM t'), 'dml');
});

test('classifyStatement reads the structure of a query, not keywords anywhere in it', () => {
    assert.equal(classifyStatement('SELECT 1 AS insert INTO newtab'), 'ddl', 'SELECT INTO behind an alias named insert');
    assert.equal(classifyStatement('select x as delete into evil from t'), 'ddl');
    assert.equal(classifyStatement('SELECT a AS update, b AS merge FROM t'), 'read');
    assert.equal(classifyStatement('(SELECT 1 AS insert INTO newtab)'), 'ddl');
    assert.equal(classifyStatement('WITH x AS (SELECT 1) SELECT * INTO copy FROM x'), 'ddl');
    assert.equal(classifyStatement('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d'), 'dml');
    assert.equal(classifyStatement('WITH d AS (INSERT INTO log VALUES (1) RETURNING *) SELECT * FROM d'), 'dml');
    assert.equal(classifyStatement('WITH d AS MATERIALIZED (UPDATE t SET a = 1 RETURNING *) SELECT * FROM d'), 'dml');
    assert.equal(classifyStatement('WITH a AS (WITH b AS (SELECT 1) INSERT INTO t SELECT * FROM b RETURNING *) SELECT * FROM a'), 'dml',
        'a data-modifying statement behind a WITH of its own');
    assert.equal(classifyStatement('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x'), 'dml');
    assert.equal(classifyStatement('WITH update AS (SELECT 1) SELECT * FROM update'), 'read', 'a common table expression named update');
    assert.equal(classifyStatement('WITH d AS (DELETE FROM t RETURNING *) SELECT * INTO copy FROM d'), 'dml+ddl');
    assert.equal(classifyStatement('INSERT INTO t SELECT * FROM s'), 'dml');
    assert.equal(classifyStatement('CREATE TABLE t AS SELECT 1'), 'ddl');
    assert.equal(classifyStatement('SELECT * FROM t FOR NO KEY UPDATE'), 'read');
    assert.deepEqual(requiredCapabilities(['dml+ddl']), ['writeData', 'ddl']);
});

test('classifySql splits a script, keeping semicolons of strings and bodies inside their statement', () => {
    const script = "SELECT ';'; CREATE FUNCTION f() RETURNS int AS $$ BEGIN DELETE FROM t; RETURN 1; END $$ LANGUAGE plpgsql;\nUPDATE t SET a = ';'";
    assert.deepEqual(classifySql(script).map((s) => s.kind), ['read', 'ddl', 'dml']);
});

test('requiredCapabilities: DML needs writeData, DDL needs ddl, routines and mixed scripts need both', () => {
    assert.deepEqual(requiredCapabilities(['dml']), ['writeData']);
    assert.deepEqual(requiredCapabilities(['ddl']), ['ddl']);
    assert.deepEqual(requiredCapabilities(['dml', 'ddl']), ['writeData', 'ddl']);
    assert.deepEqual(requiredCapabilities(['routine']), ['writeData', 'ddl']);
    assert.deepEqual(requiredCapabilities(['read']), ['writeData'], 'a query in execute_sql may call functions that write');
    assert.deepEqual(requiredCapabilities(['session']), []);
});

// ===== helpers =====

test('nameMatcher matches a part of the name, or a whole-name pattern with * or %', () => {
    assert.equal(nameMatcher('ORDER')('customer_orders'), true);
    assert.equal(nameMatcher('order_')('order_items'), true, 'an underscore is no wildcard');
    assert.equal(nameMatcher('order*')('order_items'), true);
    assert.equal(nameMatcher('order*')('customer_orders'), false);
    assert.equal(nameMatcher('%items')('order_items'), true);
    assert.equal(nameMatcher('a.b*')('axb'), false, 'other characters are literal');
    assert.equal(nameMatcher(undefined)('anything'), true);
});

test('truncateText cuts long text with a note', () => {
    assert.equal(truncateText('short', 10), 'short');
    assert.match(truncateText('x'.repeat(25), 10), /^x{10}\n… \[truncated: 15 more characters not shown\]$/);
});

// ===== permissions =====

test('a tool is refused with the reason when the connection does not grant its capability', async () => {
    const f = fake();
    const result = await callTool(tool('run_query'), { sql: 'SELECT 1' }, f.services);
    assert.equal(result.isError, true);
    assert.match(text(result), /"prod" does not allow AI assistants to read data/);
    assert.match(text(result), /Select Connection/);
    assert.deepEqual(f.sql, [], 'nothing reached the database');
    assert.deepEqual(f.clients, [], 'no connection was even opened');
});

test('list_connections names connections and permissions but never host or user', async () => {
    const other: ConnectionConfig = { name: 'qa', host: 'qa-host.example', port: 5433, database: 'qa_db', user: 'bob_secret', ai: { metadata: true, confirmWrites: false } };
    const f = fake({ saved: [prod, other], active: prod });
    const result = await callTool(tool('list_connections'), {}, f.services);
    const body = text(result);
    for (const secret of ['db.internal.example', 'alice_admin', 'qa-host.example', 'bob_secret', '5433', 'host', '"user"']) {
        assert.equal(body.includes(secret), false, `leaks ${secret}`);
    }
    const parsed = JSON.parse(body);
    assert.deepEqual(parsed.connections, [
        { name: 'prod', database: 'app', active: true, capabilities: [], askBeforeWrites: true },
        { name: 'qa', database: 'qa_db', active: false, capabilities: ['metadata'], askBeforeWrites: false }
    ]);
});

test('a named saved connection that is not active gets a client of its own and its own permissions', async () => {
    const other: ConnectionConfig = { name: 'qa', host: 'h', port: 1, database: 'qa', user: 'u', ai: { readData: true } };
    const f = fake({ saved: [prod, other], active: prod, answer: () => ({ fields: ['a'], rows: [[1]] }) });
    const result = await callTool(tool('run_query'), { sql: 'SELECT 1 AS a', connection: 'qa' }, f.services);
    assert.equal(result.isError, undefined, text(result));
    assert.deepEqual(f.clients.map((c) => [c.config.name, c.active]), [['qa', false]]);

    const unknown = await callTool(tool('run_query'), { sql: 'SELECT 1', connection: 'nope' }, f.services);
    assert.match(text(unknown), /No saved connection is named "nope". Saved connections: "prod", "qa"\./);
});

test('the permissions of the active connection are read from its saved entry, as last edited', async () => {
    const f = fake({ saved: [granted({ readData: true })], active: prod, answer: () => ({ fields: ['a'], rows: [] }) });
    const result = await callTool(tool('run_query'), { sql: 'SELECT 1' }, f.services);
    assert.equal(result.isError, undefined, text(result));
});

// ===== run_query =====

test('run_query reads through a cursor in a read-only transaction that is rolled back, one row past the limit', async () => {
    const f = fake({
        saved: [granted({ readData: true })],
        maxRows: 2,
        answer: (sql) => (sql.startsWith('FETCH') ? { fields: ['id', 'name'], rows: [[1, 'a'], [2, null], [3, 'c']] } : undefined)
    });
    const result = await callTool(tool('run_query'), { sql: 'SELECT id, name FROM t ORDER BY id;' }, f.services);
    assert.deepEqual(f.sql, [
        'BEGIN READ ONLY',
        'DECLARE pqb_mcp_cursor NO SCROLL CURSOR FOR SELECT id, name FROM t ORDER BY id\n',
        'FETCH FORWARD 3 FROM pqb_mcp_cursor',
        'ROLLBACK'
    ]);
    const body = JSON.parse(text(result));
    assert.deepEqual(body.columns, ['id', 'name']);
    assert.deepEqual(body.rows, [[1, 'a'], [2, null]]);
    assert.equal(body.truncated, true);
    assert.match(body.note, /Only the first 2 rows are shown/);
});

test('run_query asks for at most the user\'s limit, even when the assistant wants more', async () => {
    const f = fake({ saved: [granted({ readData: true })], maxRows: 10 });
    await callTool(tool('run_query'), { sql: 'SELECT 1', maxRows: 1000 }, f.services);
    assert.ok(f.sql.includes('FETCH FORWARD 11 FROM pqb_mcp_cursor'), f.sql.join('\n'));
    const fewer = fake({ saved: [granted({ readData: true })], maxRows: 10 });
    await callTool(tool('run_query'), { sql: 'SELECT 1', maxRows: 3 }, fewer.services);
    assert.ok(fewer.sql.includes('FETCH FORWARD 4 FROM pqb_mcp_cursor'));
});

test('run_query rolls back when the query fails', async () => {
    const f = fake({ saved: [granted({ readData: true })], answer: (sql) => (sql.startsWith('FETCH') ? new Error('division by zero') : undefined) });
    const result = await callTool(tool('run_query'), { sql: 'SELECT 1/0' }, f.services);
    assert.equal(result.isError, true);
    assert.match(text(result), /division by zero/);
    assert.equal(f.sql.at(-1), 'ROLLBACK');
});

test('run_query refuses writes, several statements and EXPLAIN without touching the database', async () => {
    const f = fake({ saved: [granted({ readData: true, writeData: true, ddl: true })] });
    assert.match(text(await callTool(tool('run_query'), { sql: 'DELETE FROM t' }, f.services)), /Use execute_sql/);
    assert.match(text(await callTool(tool('run_query'), { sql: 'WITH d AS (DELETE FROM t RETURNING 1) SELECT * FROM d' }, f.services)), /Use execute_sql/);
    assert.match(text(await callTool(tool('run_query'), { sql: 'SELECT 1; SELECT 2' }, f.services)), /exactly one statement/);
    assert.match(text(await callTool(tool('run_query'), { sql: 'EXPLAIN ANALYZE DELETE FROM t' }, f.services)), /explain_query/);
    assert.deepEqual(f.sql, []);
});

test('run_query runs SHOW directly inside the read-only transaction', async () => {
    const f = fake({ saved: [granted({ readData: true })], answer: () => ({ fields: ['search_path'], rows: [['public']] }) });
    const body = JSON.parse(text(await callTool(tool('run_query'), { sql: 'SHOW search_path' }, f.services)));
    assert.deepEqual(f.sql, ['BEGIN READ ONLY', 'SHOW search_path', 'ROLLBACK']);
    assert.deepEqual(body.rows, [['public']]);
});

// ===== execute_sql =====

test('execute_sql asks first and, when the user declines, runs nothing', async () => {
    const f = fake({ saved: [granted({ writeData: true })], confirm: false });
    const result = await callTool(tool('execute_sql'), { sql: 'DELETE FROM t WHERE id = 1' }, f.services);
    assert.equal(result.isError, true);
    assert.match(text(result), /declined/);
    assert.equal(f.confirmations.length, 1);
    assert.match(f.confirmations[0].message, /run 1 statement \(1 DML\) on "prod" \(database app\)/);
    assert.equal(f.confirmations[0].detail, '1. DML: DELETE FROM t WHERE id = 1');
    assert.equal(f.sql.some((s) => /DELETE|COMMIT/.test(s)), false, 'nothing was executed or committed');
});

test('execute_sql refuses DDL without the ddl capability, also in a script with allowed DML', async () => {
    const f = fake({ saved: [granted({ writeData: true })] });
    const result = await callTool(tool('execute_sql'), { sql: 'UPDATE t SET a = 1; DROP TABLE t' }, f.services);
    assert.equal(result.isError, true);
    assert.match(text(result), /does not allow AI assistants to change the database structure \(ddl\)/);
    assert.deepEqual(f.confirmations, [], 'refused before asking');
    assert.deepEqual(f.sql, []);
});

test('execute_sql runs every statement in one transaction, commits and reports the row counts', async () => {
    const f = fake({
        saved: [granted({ writeData: true, ddl: true, confirmWrites: false })],
        answer: (sql) => (sql.startsWith('UPDATE') ? { command: 'UPDATE', rowCount: 3 } : { command: 'CREATE', rowCount: null })
    });
    const result = await callTool(tool('execute_sql'), { sql: 'UPDATE t SET a = 1;\nCREATE INDEX ON t (a);' }, f.services);
    assert.deepEqual(f.confirmations, [], 'the user turned asking off for this connection');
    assert.deepEqual(f.sql, ['BEGIN', 'UPDATE t SET a = 1', 'CREATE INDEX ON t (a)', 'COMMIT']);
    assert.deepEqual(JSON.parse(text(result)), {
        committed: true,
        statements: [{ statement: 1, command: 'UPDATE', rowCount: 3 }, { statement: 2, command: 'CREATE', rowCount: null }]
    });
});

test('execute_sql rolls everything back when a statement fails', async () => {
    const f = fake({
        saved: [granted({ writeData: true })],
        answer: (sql) => (sql.startsWith('DELETE') ? new Error('violates foreign key constraint') : { command: 'INSERT', rowCount: 1 })
    });
    const result = await callTool(tool('execute_sql'), { sql: 'INSERT INTO t VALUES (1); DELETE FROM p' }, f.services);
    assert.equal(result.isError, true);
    assert.match(text(result), /Statement 2 \(DELETE FROM p\) failed: violates foreign key constraint\. Everything was rolled back\./);
    assert.deepEqual(f.sql, ['BEGIN', 'INSERT INTO t VALUES (1)', 'DELETE FROM p', 'ROLLBACK']);
});

test('execute_sql needs ddl for SELECT INTO, even behind a column alias named like a DML verb', async () => {
    const f = fake({ saved: [granted({ writeData: true })] });
    const result = await callTool(tool('execute_sql'), { sql: 'SELECT 1 AS insert INTO newtab' }, f.services);
    assert.match(text(result), /\(ddl\)/);
    assert.deepEqual(f.sql, []);
});

test('execute_sql shows every statement with its kind and without comments, so padding cannot hide one', async () => {
    const f = fake({ saved: [granted({ writeData: true, ddl: true })], confirm: false });
    const padding = `/*${' '.repeat(5000)}*/\n${'-- nothing to see\n'.repeat(200)}`;
    await callTool(tool('execute_sql'), { sql: `UPDATE t SET a = 1 -- harmless\n;${padding}DROP TABLE t; UPDATE t SET b = 2` }, f.services);
    assert.equal(f.confirmations.length, 1);
    assert.match(f.confirmations[0].message, /run 3 statements \(2 DML, 1 DDL\) on "prod"/);
    assert.equal(f.confirmations[0].detail, '1. DML: UPDATE t SET a = 1\n\n2. DDL: DROP TABLE t\n\n3. DML: UPDATE t SET b = 2');
});

test('execute_sql refuses SQL too long or too many statements to show in full, without asking or running', async () => {
    const f = fake({ saved: [granted({ writeData: true, ddl: true })] });
    const long = await callTool(tool('execute_sql'), { sql: `UPDATE t SET a = '${'x'.repeat(5000)}'; DROP TABLE t` }, f.services);
    assert.equal(long.isError, true);
    assert.match(text(long), /too long to show it completely.*Nothing was run\. Send smaller batches/s);
    const many = await callTool(tool('execute_sql'), { sql: 'DELETE FROM t;'.repeat(21) }, f.services);
    assert.match(text(many), /21 statements, too many/);
    assert.deepEqual(f.confirmations, []);
    assert.deepEqual(f.sql, []);

    const unasked = fake({ saved: [granted({ writeData: true, confirmWrites: false })] });
    const result = await callTool(tool('execute_sql'), { sql: `UPDATE t SET a = '${'x'.repeat(5000)}'` }, unasked.services);
    assert.equal(result.isError, undefined, 'without a dialog there is nothing to show');
});

test('execute_sql leaves transaction control to itself and refuses unsupported statements', async () => {
    const f = fake({ saved: [granted({ writeData: true, ddl: true })] });
    assert.match(text(await callTool(tool('execute_sql'), { sql: 'BEGIN; DELETE FROM t; COMMIT' }, f.services)), /leave out BEGIN, COMMIT/);
    assert.match(text(await callTool(tool('execute_sql'), { sql: 'COPY t FROM PROGRAM \'rm -rf /\'' }, f.services)), /is not supported by execute_sql/);
    assert.deepEqual(f.sql, []);
});

// ===== explain_query =====

test('explain_query runs EXPLAIN in a read-only transaction with the metadata capability alone', async () => {
    const f = fake({ saved: [granted({ metadata: true })], answer: () => ({ fields: ['QUERY PLAN'], rows: [['Seq Scan on t'], ['  Filter: (a = 1)']] }) });
    const result = await callTool(tool('explain_query'), { sql: 'SELECT * FROM t WHERE a = 1' }, f.services);
    assert.equal(text(result), 'Seq Scan on t\n  Filter: (a = 1)');
    assert.deepEqual(f.sql, ['BEGIN READ ONLY', 'EXPLAIN (FORMAT TEXT) SELECT * FROM t WHERE a = 1\n', 'ROLLBACK']);
});

test('explain_query with analyze needs readData, and writeData for a statement that writes', async () => {
    const f = fake({ saved: [granted({ metadata: true })] });
    assert.match(text(await callTool(tool('explain_query'), { sql: 'SELECT 1', analyze: true }, f.services)), /read data \(readData\)/);
    const reader = fake({ saved: [granted({ metadata: true, readData: true })] });
    assert.match(text(await callTool(tool('explain_query'), { sql: 'DELETE FROM t', analyze: true }, reader.services)), /change data \(writeData\)/);
    const writer = fake({ saved: [granted({ metadata: true, readData: true, writeData: true })], answer: () => ({ fields: ['QUERY PLAN'], rows: [['Delete on t']] }) });
    const result = await callTool(tool('explain_query'), { sql: 'DELETE FROM t', analyze: true }, writer.services);
    assert.equal(writer.confirmations.length, 1);
    assert.deepEqual(writer.sql, ['BEGIN', 'EXPLAIN (ANALYZE, FORMAT TEXT) DELETE FROM t\n', 'ROLLBACK']);
    assert.match(text(result), /rolled back/);
});

// ===== open_in_data_viewer =====

test('open_in_data_viewer opens a query of the active connection only', async () => {
    const other: ConnectionConfig = { name: 'qa', host: 'h', port: 1, database: 'qa', user: 'u', ai: { readData: true } };
    const f = fake({ saved: [granted({ readData: true }), other], active: prod });
    const result = await callTool(tool('open_in_data_viewer'), { sql: 'SELECT * FROM t' }, f.services);
    assert.equal(result.isError, undefined, text(result));
    assert.deepEqual(f.opened, ['SELECT * FROM t']);
    const refused = await callTool(tool('open_in_data_viewer'), { sql: 'SELECT 1', connection: 'qa' }, f.services);
    assert.match(text(refused), /active in VS Code \("prod"\) only/);
    assert.equal(f.opened.length, 1);
});

test('open_in_data_viewer first runs the query read-only, and opens it only when that works', async () => {
    const f = fake({ saved: [granted({ readData: true })], maxRows: 50 });
    const result = await callTool(tool('open_in_data_viewer'), { sql: 'SELECT * FROM t' }, f.services);
    assert.equal(result.isError, undefined, text(result));
    assert.deepEqual(f.sql, ['BEGIN READ ONLY', 'DECLARE pqb_mcp_cursor NO SCROLL CURSOR FOR SELECT * FROM t\n', 'FETCH FORWARD 51 FROM pqb_mcp_cursor', 'ROLLBACK']);
    assert.deepEqual(f.opened, ['SELECT * FROM t']);
});

test('open_in_data_viewer refuses a query that writes or locks rows, and opens nothing', async () => {
    const f = fake({
        saved: [granted({ readData: true })],
        answer: (sql) => (sql.startsWith('FETCH') ? new Error('cannot execute nextval() in a read-only transaction') : undefined)
    });
    const writes = await callTool(tool('open_in_data_viewer'), { sql: "SELECT setval('s', 1)" }, f.services);
    assert.equal(writes.isError, true);
    assert.match(text(writes), /changes the database.*Use execute_sql.*writeData/s);
    assert.equal(f.sql.at(-1), 'ROLLBACK');
    const failing = fake({ saved: [granted({ readData: true })], answer: (sql) => (sql.startsWith('FETCH') ? new Error('division by zero') : undefined) });
    assert.match(text(await callTool(tool('open_in_data_viewer'), { sql: 'SELECT 1/0' }, failing.services)), /failed, so it was not opened: division by zero/);
    const locks = fake({ saved: [granted({ readData: true })] });
    for (const sql of ['SELECT * FROM t FOR UPDATE', 'SELECT * FROM t FOR NO KEY UPDATE OF t', 'SELECT * FROM (SELECT * FROM t FOR SHARE) s', 'SELECT * FROM t FOR KEY SHARE']) {
        assert.match(text(await callTool(tool('open_in_data_viewer'), { sql }, locks.services)), /row locks/, sql);
    }
    assert.deepEqual(locks.sql, []);
    assert.deepEqual([...f.opened, ...failing.opened, ...locks.opened], []);
});

// ===== arguments =====

test('callTool reports invalid arguments as a tool error', async () => {
    const result = await callTool(tool('run_query'), { sql: 42 }, fake().services);
    assert.equal(result.isError, true);
    assert.match(text(result), /Invalid arguments for run_query/);
});

test('every tool has a title, a description and annotations, and only execute_sql and the mapping changes are destructive', () => {
    const names = new Set<string>();
    for (const t of MCP_TOOLS) {
        assert.ok(!names.has(t.name), `duplicate ${t.name}`);
        names.add(t.name);
        assert.match(t.name, /^[a-z_]+$/);
        assert.ok(t.title && t.description.length > 20, t.name);
        assert.equal(typeof t.annotations.readOnlyHint, 'boolean', t.name);
    }
    assert.deepEqual(MCP_TOOLS.filter((t) => t.annotations.destructiveHint).map((t) => t.name), ['execute_sql', 'update_mapping', 'delete_mapping']);
});

// ===== bookmarked queries and mappings: shared by all connections =====

test('bookmarked queries and custom column mappings need no permission of any connection', async () => {
    const f = fake({ saved: [prod] });
    const stored = { id: 'm7', sourceSchema: 's', sourceTable: 'a', sourceColumn: 'x', targetSchema: 's', targetTable: 'b', targetColumn: 'y', conditions: [], isDefault: false };
    f.services.mappings.list = () => [stored];
    f.services.savedQueries.list = () => [{ id: 'q7', name: 'Open orders', sql: 'SELECT 1', parameters: [] }];
    const calls: Array<[string, Record<string, unknown>]> = [
        ['list_saved_queries', {}],
        ['create_saved_query', { name: 'All orders', sql: 'SELECT * FROM orders' }],
        ['list_mappings', {}],
        ['create_mapping', { sourceSchema: 's', sourceTable: 'a', sourceColumn: 'x', targetSchema: 's', targetTable: 'b', targetColumn: 'y' }],
        ['update_mapping', { id: 'm7', label: 'Customer' }],
        ['delete_mapping', { id: 'm7' }]
    ];
    for (const [name, args] of calls) {
        assert.equal(tool(name).inputSchema.connection, undefined, `${name} takes no connection`);
        const result = await callTool(tool(name), args, f.services);
        assert.ok(!result.isError, `${name}: ${text(result)}`);
    }
    assert.deepEqual(f.confirmations, [], 'the per-connection "Ask before AI writes" does not apply to them');
    assert.deepEqual(f.clients, [], 'no database connection is opened');
});

test('running a bookmarked query needs only the readData permission of the connection it runs on', async () => {
    const queries = [{ id: 'q7', name: 'Open orders', sql: 'SELECT 1', parameters: [] }];
    const refused = fake({ saved: [prod] });
    refused.services.savedQueries.list = () => queries;
    const denied = await callTool(tool('run_saved_query'), { id: 'q7' }, refused.services);
    assert.equal(denied.isError, true);
    assert.match(text(denied), /read data \(readData\)/);
    assert.deepEqual(refused.sql, []);

    const allowed = fake({ saved: [granted({ readData: true })] });
    allowed.services.savedQueries.list = () => queries;
    const result = await callTool(tool('run_saved_query'), { id: 'q7' }, allowed.services);
    assert.ok(!result.isError, text(result));
    assert.ok(allowed.sql.some((s) => /BEGIN.*READ ONLY/i.test(s)), 'runs read-only');
});
