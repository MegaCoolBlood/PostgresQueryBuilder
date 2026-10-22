import { stubWarningMessage, vscodeStub } from './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { PoolConfig } from 'pg';
import {
    ConnectionConfig,
    ConnectionManager,
    allowsPlainFallback,
    buildSslOptions,
    connectionFingerprint,
    decideStoredPassword,
    effectiveSslMode,
    findUserOnlySettings,
    sslModeError
} from '../connectionManager';

const prod: ConnectionConfig = { name: 'prod', host: '127.0.0.1', port: 5432, database: 'app', user: 'alice' };

interface FakePool {
    config: PoolConfig;
    ended: boolean;
    connect(): Promise<{ release(): void }>;
    end(): Promise<void>;
    on(): void;
    query(): Promise<{ rows: Array<{ search_path: string }> }>;
}

/** A pool factory whose pools fail to connect with the next queued error, if any. */
function fakePoolFactory(failures: Array<Error | null> = []) {
    const pools: FakePool[] = [];
    const factory = (config: PoolConfig) => {
        const failure = failures.shift() ?? null;
        const pool: FakePool = {
            config,
            ended: false,
            async connect() {
                if (failure) throw failure;
                return { release() {} };
            },
            async end() { this.ended = true; },
            on() {},
            async query() { return { rows: [{ search_path: 'public' }] }; }
        };
        pools.push(pool);
        return pool as any;
    };
    return { factory, pools };
}

function createManager(factory: (config: PoolConfig) => any, secrets: Record<string, string> = {}): ConnectionManager {
    const context: any = {
        secrets: {
            get: async (key: string) => secrets[key],
            store: async (key: string, value: string) => { secrets[key] = value; },
            delete: async (key: string) => { delete secrets[key]; }
        },
        subscriptions: []
    };
    return new ConnectionManager(context, factory);
}

function connect(cm: ConnectionManager, config: ConnectionConfig, password = 'pw'): Promise<void> {
    return (cm as any).connect(config, password);
}

// ===== connect: a failed attempt keeps the previous connection =====

test('a failed connect leaves the manager disconnected and ends the new pool', async () => {
    const { factory, pools } = fakePoolFactory([new Error('password authentication failed')]);
    const cm = createManager(factory);

    await assert.rejects(() => connect(cm, prod), /password authentication failed/);

    assert.equal(cm.isConnected(), false);
    assert.equal(cm.getActiveConnectionConfig(), null);
    assert.equal(pools[0].ended, true);
});

test('a failed connect keeps the previous connection intact', async () => {
    const { factory, pools } = fakePoolFactory([null, new Error('timeout expired')]);
    const cm = createManager(factory);
    await connect(cm, prod);
    const working = cm.getPool();

    await assert.rejects(() => connect(cm, { ...prod, name: 'other', host: '127.0.0.2' }), /timeout expired/);

    assert.equal(cm.isConnected(), true);
    assert.equal(cm.getPool(), working);
    assert.equal(cm.getActiveConnectionConfig()?.name, 'prod');
    assert.equal(pools[0].ended, false, 'the working pool must not be ended');
    assert.equal(pools[1].ended, true, 'the broken pool must be ended');
});

test('a successful connect replaces and ends the previous pool and announces the change', async () => {
    const { factory, pools } = fakePoolFactory();
    const cm = createManager(factory);
    let changes = 0;
    cm.onConnectionChanged(() => { changes++; });
    await connect(cm, prod);

    await connect(cm, { ...prod, name: 'other' });

    assert.equal(cm.getPool(), pools[1] as any);
    assert.equal(cm.getActiveConnectionConfig()?.name, 'other');
    assert.equal(pools[0].ended, true);
    assert.equal(changes, 2);
});

// ===== connect: SSL modes =====

test('a connection without sslMode keeps the old behaviour: unverified SSL, falling back to plain', async () => {
    const { factory, pools } = fakePoolFactory([new Error('The server does not support SSL connections')]);
    const cm = createManager(factory);

    await connect(cm, prod);

    assert.deepEqual(pools[0].config.ssl, { rejectUnauthorized: false });
    assert.equal(pools[0].ended, true);
    assert.equal(pools[1].config.ssl, undefined);
    assert.equal(cm.getPool(), pools[1] as any);
});

test('verify-full never falls back to an unencrypted connection', async () => {
    const { factory, pools } = fakePoolFactory([new Error('The server does not support SSL connections')]);
    const cm = createManager(factory);

    await assert.rejects(() => connect(cm, { ...prod, sslMode: 'verify-full' }), /does not support SSL/);

    assert.equal(pools.length, 1);
    assert.equal(cm.isConnected(), false);
});

test('verify-full verifies against the configured CA file', async () => {
    const dir = fs.mkdtempSync(path.join(__dirname, 'pgqb-ca-'));
    const caFile = path.join(dir, 'ca.pem');
    try {
        fs.writeFileSync(caFile, 'PEM DATA', 'utf8');
        const { factory, pools } = fakePoolFactory();
        const cm = createManager(factory);

        await connect(cm, { ...prod, host: 'db.example.com', sslMode: 'verify-full', caFile });

        assert.deepEqual(pools[0].config.ssl, { rejectUnauthorized: true, servername: 'db.example.com', ca: 'PEM DATA' });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('verify-full reports an unreadable CA file without connecting', async () => {
    const { factory, pools } = fakePoolFactory();
    const cm = createManager(factory);

    await assert.rejects(
        () => connect(cm, { ...prod, sslMode: 'verify-full', caFile: path.join(__dirname, 'pgqb-missing-ca.pem') }),
        /Could not read the CA certificate file/
    );
    assert.equal(pools.length, 0);
});

// ===== SSL option mapping =====

test('effectiveSslMode treats a missing sslMode as prefer and fails closed on an unknown one', () => {
    assert.equal(effectiveSslMode({}), 'prefer');
    assert.equal(effectiveSslMode({ sslMode: '' as any }), 'prefer');
    assert.equal(effectiveSslMode({ sslMode: 'verify-full' }), 'verify-full');
    assert.equal(effectiveSslMode({ sslMode: 'Verify-Full' as any }), 'verify-full');
    assert.equal(effectiveSslMode({ sslMode: 'bogus' as any }), 'verify-full');
    assert.equal(effectiveSslMode({ sslMode: 'verify-ca' as any }), 'verify-full');
});

test('sslModeError names an unknown sslMode and accepts the known ones', () => {
    assert.equal(sslModeError({ name: 'prod' }), null);
    assert.equal(sslModeError({ name: 'prod', sslMode: 'require' }), null);
    assert.equal(sslModeError({ name: 'prod', sslMode: 'DISABLE' as any }), null);
    assert.match(sslModeError({ name: 'prod', sslMode: 'verify-ca' as any }) || '', /Unknown SSL mode "verify-ca" in connection "prod"/);
});

test('a connection with an unknown sslMode is refused before any pool is created', async () => {
    const { factory, pools } = fakePoolFactory();
    const cm = createManager(factory);
    await assert.rejects(() => connect(cm, { ...prod, sslMode: 'verify-ca' as any }), /Unknown SSL mode/);
    assert.equal(pools.length, 0);
    assert.equal(cm.isConnected(), false);
});

test('buildSslOptions maps every SSL mode to the pg ssl option', () => {
    assert.equal(buildSslOptions('disable', 'db'), false);
    assert.deepEqual(buildSslOptions('prefer', 'db'), { rejectUnauthorized: false });
    assert.deepEqual(buildSslOptions('require', 'db'), { rejectUnauthorized: false });
    assert.deepEqual(buildSslOptions('verify-full', 'db.example.com'), { rejectUnauthorized: true, servername: 'db.example.com' });
    assert.deepEqual(buildSslOptions('verify-full', '10.0.0.5', 'CA'), { rejectUnauthorized: true, ca: 'CA' });
});

test('only prefer may fall back to an unencrypted connection', () => {
    assert.equal(allowsPlainFallback('prefer'), true);
    assert.equal(allowsPlainFallback('require'), false);
    assert.equal(allowsPlainFallback('verify-full'), false);
    assert.equal(allowsPlainFallback('disable'), false);
});

// ===== stored passwords are bound to host, port, database and user =====

test('decideStoredPassword returns the password for the target it was saved for', () => {
    const decision = decideStoredPassword('pw', connectionFingerprint(prod), prod);
    assert.deepEqual(decision, { password: 'pw', bindFingerprint: undefined });
});

test('decideStoredPassword withholds the password from a different host, port, database or user', () => {
    const saved = connectionFingerprint(prod);
    for (const target of [
        { ...prod, host: 'evil.example.com' },
        { ...prod, port: 6543 },
        { ...prod, database: 'other' },
        { ...prod, user: 'mallory' }
    ]) {
        assert.equal(decideStoredPassword('pw', saved, target).password, undefined, JSON.stringify(target));
    }
});

test('decideStoredPassword trusts a legacy secret for its own connection on first use and binds it', () => {
    const decision = decideStoredPassword('pw', undefined, prod);
    assert.deepEqual(decision, { password: 'pw', bindFingerprint: connectionFingerprint(prod) });
});

test('decideStoredPassword binds a legacy secret to its saved entry, not to an edited target', () => {
    const decision = decideStoredPassword('pw', undefined, { ...prod, host: 'evil.example.com' }, prod);
    assert.deepEqual(decision, { password: undefined, bindFingerprint: connectionFingerprint(prod) });
});

test('connectionFingerprint ignores the case of the host name only', () => {
    assert.equal(connectionFingerprint({ ...prod, host: 'DB.Example.com' }), connectionFingerprint({ ...prod, host: 'db.example.com' }));
    assert.notEqual(connectionFingerprint({ ...prod, user: 'Alice' }), connectionFingerprint(prod));
});

test('getStoredPassword migrates a legacy secret and then refuses it for another host', async () => {
    const secrets: Record<string, string> = { pgqb_password_prod: 'pw' };
    const cm = createManager(fakePoolFactory().factory, secrets);

    assert.equal(await cm.getStoredPassword(prod), 'pw');
    assert.equal(secrets.pgqb_target_prod, connectionFingerprint(prod));
    assert.equal(await cm.getStoredPassword({ ...prod, host: 'evil.example.com' }), undefined);
    assert.equal(await cm.getStoredPassword(prod), 'pw');
});

test('a saved password is stored together with its target', async () => {
    const secrets: Record<string, string> = {};
    const cm = createManager(fakePoolFactory().factory, secrets);

    await (cm as any).storePassword(prod, 'pw');

    assert.equal(secrets.pgqb_password_prod, 'pw');
    assert.equal(secrets.pgqb_target_prod, connectionFingerprint(prod));
    assert.equal(await cm.getStoredPassword({ ...prod, database: 'other' }), undefined);
});

// ===== settings a workspace can no longer set =====

test('findUserOnlySettings spots connections and a psql path in a workspace settings file', () => {
    const text = '{\n  // team settings\n  "postgresQueryBuilder.savedConnections": [],\n  "postgresQueryBuilder.psqlPath" : "C:/x/psql.exe",\n  "editor.tabSize": 4\n}';
    assert.deepEqual(findUserOnlySettings(text), ['postgresQueryBuilder.savedConnections', 'postgresQueryBuilder.psqlPath']);
    assert.deepEqual(findUserOnlySettings('{ "postgresQueryBuilder.thousandSeparator": "." }'), []);
});

test('warnAboutIgnoredWorkspaceSettings warns once per workspace', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pqb-ws-'));
    fs.mkdirSync(path.join(dir, '.vscode'));
    fs.writeFileSync(path.join(dir, '.vscode', 'settings.json'), '{ "postgresQueryBuilder.savedConnections": [{ "name": "prod" }] }');
    const originalFolders = vscodeStub.workspace.workspaceFolders;
    vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: dir } }] as any;
    t.after(() => {
        vscodeStub.workspace.workspaceFolders = originalFolders;
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const calls = stubWarningMessage(t, () => undefined);
    const state: Record<string, unknown> = {};
    const context: any = {
        secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
        subscriptions: [],
        workspaceState: { get: (k: string) => state[k], update: async (k: string, v: unknown) => { state[k] = v; } }
    };
    const cm = new ConnectionManager(context, fakePoolFactory().factory);

    await cm.warnAboutIgnoredWorkspaceSettings();
    await cm.warnAboutIgnoredWorkspaceSettings();

    assert.equal(calls.length, 1, 'only one notice per workspace');
    assert.match(String(calls[0][0]), /postgresQueryBuilder\.savedConnections/);
});