import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DbSessionManager, parseCommitMode, runsOutsideTransaction, type CommitMode, type DbSessionManagerOptions } from '../dbSession';

/** Stands in for a `pg` client: records statements and can be told what to answer. */
class FakeClient extends EventEmitter {
    queries: string[] = [];
    ended = false;
    /** What `getTransactionStatus()` reports: `I`, `T` or `E`. */
    txStatus = 'I';
    constructor(readonly processID: number, private readonly handler?: (sql: string) => unknown) {
        super();
    }
    getTransactionStatus(): string {
        return this.txStatus;
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

test('a save inside a transaction the user opened becomes a savepoint of it', async () => {
    const { manager, clients } = createSessions();
    const session = manager.acquire(REF, 'file');
    await session.query('BEGIN');
    clients[0].txStatus = 'T';

    const joined = await session.transaction(async (query, inUserTransaction) => {
        await query('UPDATE t SET a = 1');
        return inUserTransaction;
    });

    assert.equal(joined, true);
    assert.deepEqual(clients[0].queries, ['BEGIN', 'SAVEPOINT pqb_save', 'UPDATE t SET a = 1', 'RELEASE SAVEPOINT pqb_save']);
});

test('a failed save inside the user transaction rolls back only to its savepoint', async () => {
    const { manager, clients } = createSessions({
        handler: (sql) => { if (sql.startsWith('UPDATE')) throw new Error('boom'); return { rows: [] }; }
    });
    const session = manager.acquire(REF, 'file');
    await session.query('SELECT 1');
    clients[0].txStatus = 'T';

    await assert.rejects(session.transaction((query) => query('UPDATE t SET a = 1')), /boom/);

    assert.deepEqual(clients[0].queries, [
        'SELECT 1', 'SAVEPOINT pqb_save', 'UPDATE t SET a = 1', 'ROLLBACK TO SAVEPOINT pqb_save', 'RELEASE SAVEPOINT pqb_save'
    ]);
});

test('nothing is saved into a failed transaction of the user', async () => {
    const { manager, clients } = createSessions();
    const session = manager.acquire(REF, 'file');
    await session.query('SELECT 1');
    clients[0].txStatus = 'E';

    await assert.rejects(session.transaction((query) => query('UPDATE t SET a = 1')), /has failed, so nothing can be saved in it\. End it with ROLLBACK/);

    assert.deepEqual(clients[0].queries, ['SELECT 1']);
});

test('a save outside a transaction reports that it did not join one', async () => {
    const { manager } = createSessions();
    const joined = await manager.acquire(REF, 'file').transaction(async (_query, inUserTransaction) => inUserTransaction);
    assert.equal(joined, false);
});

test('queryOutsideTransaction runs only while the session is outside a transaction', async () => {
    const { manager, clients } = createSessions();
    const session = manager.acquire(REF, 'file');

    assert.notEqual(await session.queryOutsideTransaction('SELECT 1'), null);
    clients[0].txStatus = 'T';
    assert.equal(await session.queryOutsideTransaction('SELECT 2'), null);

    assert.deepEqual(clients[0].queries, ['SELECT 1']);
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

test('disconnectAll closes every connection opened for the previous connection', async () => {
    const { manager, clients, lost, setGeneration } = createSessions();
    const first = manager.acquire(REF, 'file');
    const second = manager.acquire({ key: 'tab:2', label: 'public.orders' }, 'panel:2');
    await first.query('SELECT 1');
    await second.query('SELECT 1');

    setGeneration(2);
    manager.disconnectAll();

    assert.deepEqual(clients.map((c) => c.ended), [true, true]);
    assert.equal(first.isOpen, false);
    assert.equal(first.isClosed, false);
    await first.query('SELECT 2');
    assert.equal(clients.length, 3);
    assert.deepEqual(lost, []);
});

test('a connection opened for the new connection survives the late announcement of the switch', async () => {
    const { manager, clients, setGeneration } = createSessions();
    const session = manager.acquire(REF, 'file');
    await session.query('SELECT 1');

    // The switch is counted first and announced only after the old pool ended;
    // a statement in between already reconnected.
    setGeneration(2);
    await session.query("SET pks_ate_payroll.l_von = '2026-09-21'");
    manager.disconnectAll();

    assert.equal(clients.length, 2);
    assert.equal(clients[1].ended, false);
    assert.equal(session.isOpen, true);
    await session.query('SELECT 2');
    assert.deepEqual(clients[1].queries, ["SET pks_ate_payroll.l_von = '2026-09-21'", 'SELECT 2']);
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

// ===== commit mode and open transaction =====

/** Sessions whose fake clients track BEGIN / COMMIT / ROLLBACK as the server does; `fail` fails a statement. */
function createTransactionalSessions(mode: CommitMode = 'auto') {
    const clients: FakeClient[] = [];
    const changes: string[] = [];
    let defaultMode = mode;
    const manager = new DbSessionManager({
        openClient: async () => {
            const client: FakeClient = new FakeClient(100 + clients.length, (sql) => {
                if (/^BEGIN\b/i.test(sql)) client.txStatus = 'T';
                else if (/^(COMMIT|ROLLBACK)$/i.test(sql)) client.txStatus = 'I';
                else if (/^ROLLBACK TO SAVEPOINT\b/i.test(sql)) client.txStatus = 'T';
                else if (/fail/i.test(sql)) {
                    if (client.txStatus === 'T') client.txStatus = 'E';
                    throw new Error('boom');
                }
                return { rows: [] };
            });
            clients.push(client);
            return client as any;
        },
        generation: () => 1,
        defaultCommitMode: () => defaultMode
    });
    manager.onDidChange((key) => changes.push(key));
    return { manager, clients, changes, setDefault: (value: CommitMode) => { defaultMode = value; } };
}

test('parseCommitMode knows the three modes and treats anything else as auto-commit', () => {
    assert.equal(parseCommitMode('manual'), 'manual');
    assert.equal(parseCommitMode('run'), 'run');
    for (const value of ['auto', undefined, null, '', 'MANUAL', 42]) assert.equal(parseCommitMode(value), 'auto');
});

test('runsOutsideTransaction names what PostgreSQL refuses in a transaction and transaction control', () => {
    for (const sql of ['VACUUM t', 'vacuum (analyze) t', 'CREATE DATABASE x', 'create index concurrently i on t (a)',
        'REINDEX TABLE CONCURRENTLY t', 'ALTER SYSTEM SET x = 1', 'BEGIN', 'start transaction', 'COMMIT', 'ROLLBACK',
        'END', 'SAVEPOINT s', '-- tidy up\nVACUUM t', '/* end */ COMMIT']) {
        assert.equal(runsOutsideTransaction(sql), true, sql);
    }
    for (const sql of ['UPDATE t SET a = 1', 'CREATE INDEX i ON t (a)', 'SELECT 1', "INSERT INTO log VALUES ('VACUUM')", 'begin_work()']) {
        assert.equal(runsOutsideTransaction(sql), false, sql);
    }
});

test('a session commits as its connection says until a mode is chosen for it, which ends with the session', () => {
    const { manager, changes, setDefault } = createTransactionalSessions('manual');
    const session = manager.acquire(REF, 'file');
    assert.equal(session.commitMode, 'manual');
    setDefault('auto');
    assert.equal(manager.commitModeOf(REF.key), 'auto', 'follows the active connection');

    manager.setCommitMode(REF.key, 'run');
    assert.equal(session.commitMode, 'run');
    assert.deepEqual(changes, [REF.key], 'the panel hears of the choice');
    manager.setCommitMode(REF.key, 'run');
    assert.equal(changes.length, 1, 'choosing it again changes nothing');

    manager.release(REF.key, 'file');
    assert.equal(manager.commitModeOf(REF.key), 'auto');
});

test('a mode can be chosen for a session before its first statement', async () => {
    const { manager, clients } = createTransactionalSessions('auto');
    manager.setCommitMode(REF.key, 'manual');
    const session = manager.acquire(REF, 'file');
    await session.beginForStatement('UPDATE t SET a = 1');
    assert.deepEqual(clients[0].queries, ['BEGIN']);
});

test('auto-commit opens no transaction and does not even wait for the session', async () => {
    const { manager, clients } = createTransactionalSessions('auto');
    const session = manager.acquire(REF, 'file');
    assert.equal(await session.beginForStatement('UPDATE t SET a = 1'), false);
    assert.equal(clients.length, 0);
});

test('manual commit opens one transaction for the statements and none for what may not run in one', async () => {
    const { manager, clients } = createTransactionalSessions('manual');
    const session = manager.acquire(REF, 'file');
    assert.equal(await session.beginForStatement('VACUUM t'), false);
    assert.equal(clients.length, 0, 'VACUUM needs no connection opened for a BEGIN');

    assert.equal(await session.beginForStatement('UPDATE t SET a = 1'), true);
    await session.query('UPDATE t SET a = 1');
    assert.equal(await session.beginForStatement('UPDATE t SET b = 2'), false, 'already in a transaction');
    assert.equal(await session.beginForStatement('COMMIT'), false);

    assert.deepEqual(clients[0].queries, ['BEGIN', 'UPDATE t SET a = 1']);
    assert.equal(session.transactionState, 'open');
});

test('a session announces when its transaction opens, fails and ends, once each', async () => {
    const { manager, changes } = createTransactionalSessions('manual');
    const session = manager.acquire(REF, 'file');
    assert.equal(session.transactionState, 'none');
    await session.query('SELECT 1');
    const connected = changes.length;
    assert.equal(session.transactionState, 'idle');

    await session.query('SELECT 2');
    assert.equal(changes.length, connected, 'nothing changed');
    await session.beginForStatement('UPDATE t SET a = 1');
    assert.equal(session.transactionState, 'open');
    assert.equal(changes.length, connected + 1);
    await assert.rejects(session.query('UPDATE fail'), /boom/);
    assert.equal(session.transactionState, 'failed');
    assert.equal(changes.length, connected + 2);

    assert.equal(await session.rollback(), true);
    assert.equal(session.transactionState, 'idle');
    assert.equal(changes.length, connected + 3);
});

test('commit and rollback end only an open transaction', async () => {
    const { manager, clients } = createTransactionalSessions('manual');
    const session = manager.acquire(REF, 'file');
    assert.equal(await session.commit(), false, 'no connection, nothing to commit');
    assert.equal(clients.length, 0);

    await session.query('SELECT 1');
    assert.equal(await session.commit(), false);
    await session.beginForStatement('UPDATE t SET a = 1');
    assert.equal(await session.commit(), true);
    assert.deepEqual(clients[0].queries, ['SELECT 1', 'BEGIN', 'COMMIT']);
    assert.equal(session.transactionState, 'idle');
});

test('a save of the Data Viewer in manual commit stays in a transaction left open for the user', async () => {
    const { manager, clients } = createTransactionalSessions('manual');
    const session = manager.acquire(REF, 'tab');

    const joined = await session.transaction(async (query, inUserTransaction) => {
        await query('UPDATE t SET a = 1');
        return inUserTransaction;
    });

    assert.equal(joined, true, 'nothing is permanent before the user commits');
    assert.deepEqual(clients[0].queries, ['BEGIN', 'SAVEPOINT pqb_save', 'UPDATE t SET a = 1', 'RELEASE SAVEPOINT pqb_save']);
    assert.equal(session.transactionState, 'open');

    await assert.rejects(session.transaction((query) => query('UPDATE fail')), /boom/);
    assert.equal(session.transactionState, 'open', 'a failed save leaves the earlier work where it was');
});

test('a failed save in manual commit that opened the transaction rolls it back entirely', async () => {
    const { manager, clients } = createTransactionalSessions('manual');
    const session = manager.acquire(REF, 'tab');
    await assert.rejects(session.transaction((query) => query('UPDATE fail')), /boom/);
    assert.deepEqual(clients[0].queries, ['BEGIN', 'SAVEPOINT pqb_save', 'UPDATE fail', 'ROLLBACK']);
    assert.equal(session.transactionState, 'idle');
});
