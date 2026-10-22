import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DbSessionManager, type DbSessionManagerOptions } from '../dbSession';

/** Stands in for a `pg` client: records statements and can be told what to answer. */
class FakeClient extends EventEmitter {
    queries: string[] = [];
    ended = false;
    constructor(readonly processID: number, private readonly handler?: (sql: string) => unknown) {
        super();
    }
    async query(textOrConfig: string | { text: string }, _values?: unknown[]): Promise<any> {
        const sql = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text;
        this.queries.push(sql);
        if (this.handler) {
            return await this.handler(sql);
        }
        return { rows: [], fields: [], rowCount: 0, command: sql.split(/\s+/)[0].toUpperCase() };
    }
    async end(): Promise<void> {
        this.ended = true;
    }
}

function createSessions(options: { handler?: (sql: string) => unknown } & Partial<DbSessionManagerOptions> = {}) {
    const clients: FakeClient[] = [];
    const lost: Array<{ label: string; reason: string }> = [];
    const notices: Array<{ label: string; message?: string }> = [];
    let generation = 1;
    const manager = new DbSessionManager({
        openClient: async () => {
            const client = new FakeClient(100 + clients.length, options.handler);
            clients.push(client);
            return client as any;
        },
        generation: () => generation,
        onLost: (session, reason) => lost.push({ label: session.label, reason }),
        onNotice: (session, notice) => notices.push({ label: session.label, message: notice.message }),
        ...options
    });
    return { manager, clients, lost, notices, setGeneration: (value: number) => { generation = value; } };
}

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

const REF = { key: 'file:///work/payroll.sql', label: 'payroll.sql' };

// ===== DbSession =====

test('a session opens its connection with the first statement and keeps it for the next ones', async () => {
    const { manager, clients } = createSessions();
    const session = manager.acquire(REF, 'file');
    assert.equal(clients.length, 0, 'nothing may connect before the first statement');
    assert.equal(session.isOpen, false);

    await session.query("SELECT set_config('pks_ate_payroll.l_von', '2026-09-21', false)");
    await session.query("SELECT current_setting('pks_ate_payroll.l_von')");

    assert.equal(clients.length, 1);
    assert.deepEqual(clients[0].queries, [
        "SELECT set_config('pks_ate_payroll.l_von', '2026-09-21', false)",
        "SELECT current_setting('pks_ate_payroll.l_von')"
    ]);
    assert.equal(session.isOpen, true);
    assert.equal(session.processId, 100);
});

test('a positional query of a session asks for rows as arrays', async () => {
    const seen: any[] = [];
    const { manager } = createSessions({
        openClient: async () => ({
            processID: 1,
            query: async (config: any) => { seen.push(config); return { rows: [[1]], fields: [{ name: 'n' }] }; },
            on() {},
            removeListener() {},
            end: async () => {}
        }) as any
    });
    const session = manager.acquire(REF, 'file');

    const result = await session.queryPositional('SELECT 1 AS n');

    assert.deepEqual(seen, [{ text: 'SELECT 1 AS n', rowMode: 'array', values: undefined }]);
    assert.deepEqual(result.rows, [[1]]);
});

test('the statements of one session run strictly one after the other', async () => {
    const { manager } = createSessions();
    const session = manager.acquire(REF, 'file');
    const gate = deferred();
    const order: string[] = [];

    const first = session.run(async () => { order.push('first:start'); await gate.promise; order.push('first:end'); });
    const second = session.run(async () => { order.push('second'); });
    await tick();
    assert.deepEqual(order, ['first:start']);

    gate.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first:start', 'first:end', 'second']);
});

test('a failed statement does not hold up the statements behind it', async () => {
    const { manager, clients } = createSessions({
        handler: (sql) => { if (sql.startsWith('SELEC ')) throw new Error('syntax error'); return { rows: [] }; }
    });
    const session = manager.acquire(REF, 'file');

    await assert.rejects(session.query('SELEC 1'), /syntax error/);
    await session.query('SELECT 1');

    assert.deepEqual(clients[0].queries, ['SELEC 1', 'SELECT 1']);
});

test('nothing slips into a transaction of the session', async () => {
    const { manager, clients } = createSessions();
    const session = manager.acquire(REF, 'file');
    const gate = deferred();

    const transaction = session.transaction(async (query) => {
        await query('UPDATE t SET a = 1');
        await gate.promise;
        await query('UPDATE t SET b = 2');
        return 'saved';
    });
    const read = session.query('SELECT * FROM t');
    await tick();
    gate.resolve();

    assert.equal(await transaction, 'saved');
    await read;
    assert.deepEqual(clients[0].queries, ['BEGIN', 'UPDATE t SET a = 1', 'UPDATE t SET b = 2', 'COMMIT', 'SELECT * FROM t']);
});

test('a failed transaction is rolled back and reports its own error', async () => {
    const { manager, clients } = createSessions({
        handler: (sql) => {
            if (sql.startsWith('UPDATE')) throw new Error('boom');
            if (sql === 'ROLLBACK') throw new Error('connection gone');
            return { rows: [] };
        }
    });
    const session = manager.acquire(REF, 'file');

    await assert.rejects(session.transaction((query) => query('UPDATE t SET a = 1')), /boom/);

    assert.deepEqual(clients[0].queries, ['BEGIN', 'UPDATE t SET a = 1', 'ROLLBACK']);
});

test('reset closes the connection and the next statement starts a fresh session', async () => {
    const { manager, clients, lost } = createSessions();
    const session = manager.acquire(REF, 'file');
    await session.query("SELECT set_config('x.y', '1', false)");

    assert.equal(session.reset(), true);
    assert.equal(clients[0].ended, true);
    assert.equal(session.isOpen, false);

    await session.query('SELECT 1');
    assert.equal(clients.length, 2);
    assert.deepEqual(clients[1].queries, ['SELECT 1']);
    assert.deepEqual(lost, [], 'a reset asked for is no loss to warn about');
});

test('reset reports when there was no connection to throw away', () => {
    const { manager } = createSessions();
    assert.equal(manager.acquire(REF, 'file').reset(), false);
});

test('a switched connection is picked up by the next statement without a warning', async () => {
    const { manager, clients, lost, setGeneration } = createSessions();
    const session = manager.acquire(REF, 'file');
    await session.query('SELECT 1');

    setGeneration(2);
    await session.query('SELECT 2');

    assert.equal(clients.length, 2);
    assert.equal(clients[0].ended, true);
    assert.deepEqual(clients[1].queries, ['SELECT 2']);
    assert.deepEqual(lost, []);
});

test('a connection the server closed is replaced and the loss is reported once', async () => {
    const { manager, clients, lost } = createSessions();
    const session = manager.acquire(REF, 'file');
    await session.query('SELECT 1');

    clients[0].emit('end');
    assert.equal(session.isOpen, false);

    await session.query('SELECT 2');
    await session.query('SELECT 3');

    assert.equal(clients.length, 2);
    assert.deepEqual(clients[1].queries, ['SELECT 2', 'SELECT 3']);
    assert.deepEqual(lost, [{ label: 'payroll.sql', reason: 'the server closed the connection' }]);
});

test('a connection error names the reason of the loss', async () => {
    const { manager, clients, lost } = createSessions();
    const session = manager.acquire(REF, 'file');
    await session.query('SELECT 1');

    clients[0].emit('error', new Error('Connection terminated unexpectedly'));
    clients[0].emit('end');
    await session.query('SELECT 2');

    assert.deepEqual(lost, [{ label: 'payroll.sql', reason: 'Connection terminated unexpectedly' }]);
});

test('the messages a session receives reach the notice listener with its label', async () => {
    const { manager, clients, notices } = createSessions();
    const session = manager.acquire(REF, 'file');
    await session.query('DO $$ BEGIN RAISE NOTICE $m$hello$m$; END $$');

    clients[0].emit('notice', { severity: 'NOTICE', message: 'hello' });

    assert.deepEqual(notices, [{ label: 'payroll.sql', message: 'hello' }]);
});

test('a session closed while its connection opens never uses that connection', async () => {
    const opening = deferred<any>();
    const { manager } = createSessions({ openClient: () => opening.promise });
    const session = manager.acquire(REF, 'panel:1');

    const pending = session.query('SELECT 1');
    await tick();
    manager.release(REF.key, 'panel:1');
    const client = new FakeClient(7);
    opening.resolve(client);

    await assert.rejects(pending, /closed/);
    assert.equal(client.ended, true);
    assert.deepEqual(client.queries, []);
});

// ===== DbSessionManager =====

test('a session is shared under its key and lives until its last holder releases it', async () => {
    const { manager, clients } = createSessions();
    const forFile = manager.acquire(REF, 'file');
    const forPanel = manager.acquire({ key: REF.key, label: 'something else' }, 'panel:1');

    assert.equal(forFile, forPanel);
    assert.equal(forPanel.label, 'payroll.sql');
    assert.equal(forPanel.owner, 'file');
    assert.equal(manager.holderCount(REF.key), 2);

    await forFile.query('SELECT 1');
    manager.release(REF.key, 'file');
    assert.equal(clients[0].ended, false, 'the panel still uses the session');
    assert.equal(manager.get(REF.key), forFile);

    manager.release(REF.key, 'panel:1');
    assert.equal(clients[0].ended, true);
    assert.equal(manager.get(REF.key), undefined);
    assert.equal(forFile.isClosed, true);
    await assert.rejects(forFile.query('SELECT 2'), /closed/);
});

test('releasing a holder twice or an unknown key changes nothing', async () => {
    const { manager } = createSessions();
    manager.acquire(REF, 'file');
    manager.acquire(REF, 'panel:1');

    manager.release(REF.key, 'panel:1');
    manager.release(REF.key, 'panel:1');
    manager.release('tab:404', 'panel:1');

    assert.equal(manager.holderCount(REF.key), 1);
});

test('disconnectAll closes every open connection without closing the sessions', async () => {
    const { manager, clients, lost } = createSessions();
    const first = manager.acquire(REF, 'file');
    const second = manager.acquire({ key: 'tab:2', label: 'public.orders' }, 'panel:2');
    await first.query('SELECT 1');
    await second.query('SELECT 1');

    manager.disconnectAll();

    assert.deepEqual(clients.map((c) => c.ended), [true, true]);
    assert.equal(first.isOpen, false);
    assert.equal(first.isClosed, false);
    await first.query('SELECT 2');
    assert.equal(clients.length, 3);
    assert.deepEqual(lost, []);
});

test('onDidChange reports a session that opens, gets shared and is released', async () => {
    const { manager } = createSessions();
    const changes: string[] = [];
    const subscription = manager.onDidChange((key) => changes.push(key));
    const session = manager.acquire(REF, 'file');
    assert.deepEqual(changes, []);

    await session.query('SELECT 1');
    manager.acquire(REF, 'panel:1');
    manager.release(REF.key, 'panel:1');
    subscription.dispose();
    manager.release(REF.key, 'file');

    assert.deepEqual(changes, [REF.key, REF.key, REF.key]);
});

test('dispose closes every session', async () => {
    const { manager, clients } = createSessions();
    const session = manager.acquire(REF, 'file');
    await session.query('SELECT 1');

    manager.dispose();

    assert.equal(clients[0].ended, true);
    assert.equal(session.isClosed, true);
    assert.equal(manager.get(REF.key), undefined);
});
