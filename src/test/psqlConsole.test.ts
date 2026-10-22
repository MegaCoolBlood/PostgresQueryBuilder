import { vscodeStub } from './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    PSQL_APPLICATION_NAME,
    PsqlConsole,
    PsqlHost,
    buildPsqlEnvironment,
    buildPsqlLaunch,
    escapePgOption,
    locatePsql,
    parseAnsiCodePage,
    psqlTerminalName,
    sortVersionsDescending
} from '../psqlConsole';
import { ConnectionConfig, ConnectionManager } from '../connectionManager';
import { SearchViewProvider } from '../searchViewProvider';

const ROOT = path.join(__dirname, '..', '..', '..');

const config: ConnectionConfig = {
    name: 'Prod DB',
    host: 'db.example.com',
    port: 5433,
    database: 'shop',
    user: 'alice'
};

/** A fake file system: `files` exist, `dirs` maps a folder to its entries. */
function fakeHost(
    platform: NodeJS.Platform,
    env: Record<string, string | undefined>,
    files: string[],
    dirs: Record<string, string[]> = {},
    codePage: number | null = null
): PsqlHost {
    return {
        platform,
        env,
        isFile: (p) => files.includes(p),
        listDirectory: (p) => dirs[p] ?? [],
        ansiCodePage: () => codePage
    };
}

// ===== buildPsqlEnvironment =====

test('buildPsqlEnvironment connects psql to the active connection', () => {
    assert.deepEqual(buildPsqlEnvironment(config, 's3cret'), {
        PGHOST: 'db.example.com',
        PGPORT: '5433',
        PGDATABASE: 'shop',
        PGUSER: 'alice',
        PGPASSWORD: 's3cret',
        PGAPPNAME: PSQL_APPLICATION_NAME
    });
});

test('buildPsqlEnvironment leaves the password out when none is stored, so psql asks for it', () => {
    assert.equal('PGPASSWORD' in buildPsqlEnvironment(config, undefined), false);
    assert.equal('PGPASSWORD' in buildPsqlEnvironment(config, ''), false);
});

test('buildPsqlEnvironment applies a search_path override through PGOPTIONS', () => {
    const env = buildPsqlEnvironment(config, 'x', 'app, public');
    assert.equal(env.PGOPTIONS, '-c search_path=app,\\ public');
});

test('buildPsqlEnvironment sets no PGOPTIONS for the server default search_path', () => {
    assert.equal('PGOPTIONS' in buildPsqlEnvironment(config, 'x', null), false);
    assert.equal('PGOPTIONS' in buildPsqlEnvironment(config, 'x', '   '), false);
});

test('buildPsqlEnvironment hands the SSL mode of the connection to psql', () => {
    assert.equal(buildPsqlEnvironment({ ...config, sslMode: 'disable' }, 'x').PGSSLMODE, 'disable');
    assert.equal(buildPsqlEnvironment({ ...config, sslMode: 'require' }, 'x').PGSSLMODE, 'require');
    const legacy = buildPsqlEnvironment(config, 'x');
    assert.equal('PGSSLMODE' in legacy, false, 'without sslMode psql keeps libpq\'s default prefer');
});

test('buildPsqlEnvironment verifies the certificate in psql like the extension does', () => {
    const system = buildPsqlEnvironment({ ...config, sslMode: 'verify-full' }, 'x');
    assert.equal(system.PGSSLMODE, 'verify-full');
    assert.equal(system.PGSSLROOTCERT, 'system');
    const own = buildPsqlEnvironment({ ...config, sslMode: 'verify-full', caFile: 'C:\\certs\\ca.pem' }, 'x');
    assert.equal(own.PGSSLROOTCERT, 'C:\\certs\\ca.pem');
    assert.equal(buildPsqlEnvironment({ ...config, sslMode: 'verify-ca' as any }, 'x').PGSSLMODE, 'verify-full', 'an unknown mode fails closed');
});

// ===== escapePgOption =====

test('escapePgOption escapes whitespace and backslashes for libpq', () => {
    assert.equal(escapePgOption('"my schema",public'), '"my\\ schema",public');
    assert.equal(escapePgOption('a\\b'), 'a\\\\b');
    assert.equal(escapePgOption('plain'), 'plain');
});

// ===== psqlTerminalName =====

test('psqlTerminalName names the connection in the terminal tab', () => {
    assert.equal(psqlTerminalName(config), 'psql: Prod DB');
});

// ===== sortVersionsDescending =====

test('sortVersionsDescending orders PostgreSQL install folders newest first', () => {
    assert.deepEqual(sortVersionsDescending(['9.6', '17', '16', '10']), ['17', '16', '10', '9.6']);
});

// ===== locatePsql =====

test('locatePsql uses a configured executable path', () => {
    const host = fakeHost('win32', {}, ['D:\\pg\\bin\\psql.exe']);
    assert.equal(locatePsql('D:\\pg\\bin\\psql.exe', host), 'D:\\pg\\bin\\psql.exe');
});

test('locatePsql completes a configured folder with the executable name', () => {
    const host = fakeHost('win32', {}, ['D:\\pg\\bin\\psql.exe']);
    assert.equal(locatePsql('D:\\pg\\bin', host), 'D:\\pg\\bin\\psql.exe');
    assert.equal(locatePsql('"D:\\pg\\bin"', host), 'D:\\pg\\bin\\psql.exe');
});

test('locatePsql reports a configured path that does not exist instead of guessing', () => {
    const host = fakeHost('win32', { PATH: 'C:\\tools' }, ['C:\\tools\\psql.exe']);
    assert.equal(locatePsql('D:\\missing', host), null);
});

test('locatePsql finds psql on PATH', () => {
    const win = fakeHost('win32', { Path: 'C:\\Windows;C:\\tools' }, ['C:\\tools\\psql.exe']);
    assert.equal(locatePsql('', win), 'C:\\tools\\psql.exe');
    const linux = fakeHost('linux', { PATH: '/usr/local/bin:/usr/bin' }, ['/usr/bin/psql']);
    assert.equal(locatePsql('', linux), '/usr/bin/psql');
});

test('locatePsql falls back to the newest PostgreSQL installation on Windows', () => {
    const host = fakeHost(
        'win32',
        { PATH: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' },
        ['C:\\Program Files\\PostgreSQL\\9.6\\bin\\psql.exe', 'C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe'],
        { 'C:\\Program Files\\PostgreSQL': ['9.6', '17'] }
    );
    assert.equal(locatePsql('', host), 'C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe');
});

test('locatePsql returns null when psql is nowhere to be found', () => {
    assert.equal(locatePsql('', fakeHost('win32', { PATH: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }, [])), null);
    assert.equal(locatePsql('', fakeHost('linux', { PATH: '/usr/bin' }, [])), null);
});

// ===== parseAnsiCodePage =====

test('parseAnsiCodePage reads the ACP value from reg query output', () => {
    const out = '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage\r\n    ACP    REG_SZ    1252\r\n\r\n';
    assert.equal(parseAnsiCodePage(out), 1252);
    assert.equal(parseAnsiCodePage('    ACP    REG_SZ    65001'), 65001);
});

test('parseAnsiCodePage returns null for unexpected output', () => {
    assert.equal(parseAnsiCodePage(''), null);
    assert.equal(parseAnsiCodePage('ERROR: The system was unable to find the specified registry key or value.'), null);
    assert.equal(parseAnsiCodePage('    OEMCP    REG_SZ    850'), null);
    assert.equal(parseAnsiCodePage('    ACP    REG_SZ    0'), null);
});

// ===== buildPsqlLaunch =====

test('buildPsqlLaunch switches the Windows console to the ANSI code page before psql starts', () => {
    const exe = 'C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe';
    assert.deepEqual(buildPsqlLaunch(exe, 'win32', 1252, 'C:\\WINDOWS\\system32\\cmd.exe'), {
        shellPath: 'C:\\WINDOWS\\system32\\cmd.exe',
        shellArgs: '/d /s /c "chcp 1252>nul & "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe""'
    });
});

test('buildPsqlLaunch falls back to cmd.exe when ComSpec is not set', () => {
    assert.equal(buildPsqlLaunch('C:\\pg\\psql.exe', 'win32', 1252, undefined).shellPath, 'cmd.exe');
});

test('buildPsqlLaunch starts psql directly when the code page is unknown or outside Windows', () => {
    assert.deepEqual(buildPsqlLaunch('C:\\pg\\psql.exe', 'win32', null, 'cmd.exe'), { shellPath: 'C:\\pg\\psql.exe' });
    assert.deepEqual(buildPsqlLaunch('/usr/bin/psql', 'linux', 1252, undefined), { shellPath: '/usr/bin/psql' });
    assert.deepEqual(buildPsqlLaunch('/usr/bin/psql', 'darwin', null, undefined), { shellPath: '/usr/bin/psql' });
});

// ===== PsqlConsole.open =====

interface FakeConnection {
    connected: boolean;
    passwordLookups: string[];
    searchPath: string | null;
}

function fakeConnectionManager(state: FakeConnection): ConnectionManager {
    return {
        ensureConnected: async () => state.connected,
        getActiveConnectionConfig: () => (state.connected ? config : null),
        getStoredPassword: async (cfg: ConnectionConfig) => { state.passwordLookups.push(cfg.name); return 's3cret'; },
        getSearchPathOverride: () => state.searchPath
    } as unknown as ConnectionManager;
}

const psqlHost = fakeHost('linux', { PATH: '/usr/bin' }, ['/usr/bin/psql']);

test('PsqlConsole opens psql in a transient terminal with the connection environment', async () => {
    const created: any[] = [];
    let shown = false;
    const original = vscodeStub.window.createTerminal;
    vscodeStub.window.createTerminal = (options: any) => {
        created.push(options);
        return { show() { shown = true; }, dispose() {} };
    };
    try {
        const state: FakeConnection = { connected: true, passwordLookups: [], searchPath: 'app' };
        await new PsqlConsole(fakeConnectionManager(state), psqlHost).open();
        assert.equal(created.length, 1);
        const opts = created[0];
        assert.equal(opts.name, 'psql: Prod DB');
        assert.equal(opts.shellPath, '/usr/bin/psql');
        assert.equal(opts.isTransient, true, 'a terminal holding the password must not be restored');
        assert.equal(opts.env.PGPASSWORD, 's3cret');
        assert.equal(opts.env.PGOPTIONS, '-c search_path=app');
        assert.equal(opts.shellArgs, undefined, 'nothing secret may go onto the command line');
        assert.deepEqual(state.passwordLookups, ['Prod DB']);
        assert.equal(shown, true);
    } finally {
        vscodeStub.window.createTerminal = original;
    }
});

test('PsqlConsole on Windows starts psql through cmd with the ANSI code page, keeping the password off the command line', async () => {
    const created: any[] = [];
    const original = vscodeStub.window.createTerminal;
    vscodeStub.window.createTerminal = (options: any) => {
        created.push(options);
        return { show() {}, dispose() {} };
    };
    try {
        const exe = 'C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe';
        const host = fakeHost(
            'win32',
            { PATH: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' },
            [exe],
            { 'C:\\Program Files\\PostgreSQL': ['17'] },
            1252
        );
        const state: FakeConnection = { connected: true, passwordLookups: [], searchPath: null };
        await new PsqlConsole(fakeConnectionManager(state), host).open();
        assert.equal(created.length, 1);
        assert.equal(created[0].shellPath, 'C:\\WINDOWS\\system32\\cmd.exe');
        assert.equal(created[0].shellArgs, `/d /s /c "chcp 1252>nul & "${exe}""`);
        assert.ok(!created[0].shellArgs.includes('s3cret'));
        assert.equal(created[0].env.PGPASSWORD, 's3cret');
    } finally {
        vscodeStub.window.createTerminal = original;
    }
});

test('PsqlConsole opens nothing when the user declines to connect', async () => {
    let created = 0;
    const original = vscodeStub.window.createTerminal;
    vscodeStub.window.createTerminal = () => { created++; return { show() {}, dispose() {} }; };
    try {
        const state: FakeConnection = { connected: false, passwordLookups: [], searchPath: null };
        assert.equal(await new PsqlConsole(fakeConnectionManager(state), psqlHost).open(), undefined);
        assert.equal(created, 0);
        assert.deepEqual(state.passwordLookups, []);
    } finally {
        vscodeStub.window.createTerminal = original;
    }
});

test('PsqlConsole explains a missing psql and offers to open the setting', async () => {
    let created = 0;
    const messages: string[] = [];
    const commands: any[][] = [];
    const originals = {
        createTerminal: vscodeStub.window.createTerminal,
        showErrorMessage: vscodeStub.window.showErrorMessage,
        executeCommand: vscodeStub.commands.executeCommand
    };
    vscodeStub.window.createTerminal = () => { created++; return { show() {}, dispose() {} }; };
    vscodeStub.window.showErrorMessage = (msg: string) => { messages.push(msg); return Promise.resolve('Open Settings' as any); };
    vscodeStub.commands.executeCommand = (...args: any[]) => { commands.push(args); return Promise.resolve(undefined); };
    try {
        const state: FakeConnection = { connected: true, passwordLookups: [], searchPath: null };
        await new PsqlConsole(fakeConnectionManager(state), fakeHost('linux', { PATH: '/usr/bin' }, [])).open();
        assert.equal(created, 0);
        assert.equal(messages.length, 1);
        assert.match(messages[0], /psql was not found/);
        assert.match(messages[0], /postgresQueryBuilder\.psqlPath/);
        assert.deepEqual(commands, [['workbench.action.openSettings', 'postgresQueryBuilder.psqlPath']]);
        assert.deepEqual(state.passwordLookups, [], 'the password is not read when psql cannot start');
    } finally {
        vscodeStub.window.createTerminal = originals.createTerminal;
        vscodeStub.window.showErrorMessage = originals.showErrorMessage;
        vscodeStub.commands.executeCommand = originals.executeCommand;
    }
});

// ===== ConnectionManager accessors =====

test('ConnectionManager reads the stored password of a connection from SecretStorage', async () => {
    const keys: string[] = [];
    const secrets: Record<string, string> = { 'pgqb_password_Prod DB': 'pw' };
    const context = {
        secrets: {
            get: async (key: string) => { keys.push(key); return secrets[key]; },
            store: async (key: string, value: string) => { secrets[key] = value; }
        }
    };
    const manager = new ConnectionManager(context as any);
    assert.equal(await manager.getStoredPassword(config), 'pw');
    assert.ok(keys.includes('pgqb_password_Prod DB'));
    assert.equal(manager.getSearchPathOverride(), null);
});

// ===== Search view button =====

function resolveSearchView(): { html: string; send(msg: unknown): void; provider: SearchViewProvider } {
    const provider = new SearchViewProvider();
    let handler: (msg: unknown) => void = () => {};
    const webview: any = {
        options: {},
        html: '',
        cspSource: 'vscode-resource:',
        onDidReceiveMessage: (cb: (msg: unknown) => void) => { handler = cb; return { dispose() {} }; }
    };
    provider.resolveWebviewView({ webview } as any, {} as any, {} as any);
    return { html: webview.html, send: (msg) => handler(msg), provider };
}

test('the search view offers the psql console below Manage All Mappings', () => {
    const { html } = resolveSearchView();
    const mappings = html.indexOf('id="manageMappingsBtn"');
    const consoleBtn = html.indexOf('id="psqlConsoleBtn"');
    assert.ok(mappings > 0 && consoleBtn > mappings, 'the console button must follow Manage All Mappings');
    assert.match(html, /id="psqlConsoleBtn"[^>]*>.*#icon-terminal.*Open psql Console<\/button>/);
});

test('the search view console button asks the extension to open the console', () => {
    const { send, provider } = resolveSearchView();
    let requests = 0;
    provider.onDidRequestPsqlConsole(() => requests++);
    send({ type: 'openPsqlConsole' });
    send({ type: 'manageMappings' });
    assert.equal(requests, 1);
});

// ===== Manifest =====

test('the manifest contributes the console command and its psql path setting', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const command = manifest.contributes.commands.find((c: { command: string }) => c.command === 'postgresQueryBuilder.openPsqlConsole');
    assert.ok(command, 'command missing');
    assert.equal(command.title, 'Open psql Console');
    assert.equal(command.category, 'PostgreSQL Query Booster');
    assert.equal(command.icon, '$(terminal)');
    const connections = manifest.contributes.configuration.find((g: { title: string }) => g.title === 'Connections');
    const setting = connections.properties['postgresQueryBuilder.psqlPath'];
    assert.ok(setting, 'setting missing from the Connections group');
    assert.equal(setting.type, 'string');
    assert.equal(setting.default, '');
});

test('the console command is registered by the extension', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'extension.ts'), 'utf8');
    assert.match(source, /registerCommand\('postgresQueryBuilder\.openPsqlConsole'/);
    assert.match(source, /onDidRequestPsqlConsole\(\(\) => \{\s*vscode\.commands\.executeCommand\('postgresQueryBuilder\.openPsqlConsole'\)/);
});
