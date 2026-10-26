import { stubWarningMessage, vscodeStub } from './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
    EXECUTABLE_COLUMN_TYPES,
    ExecutableValueRunner,
    POWERSHELL_TERMINAL_NAME,
    clipText,
    executableColumnType,
    executableConfirmation,
    executableTypePickItems,
    httpUrl,
    powershellPath,
    psqlInput,
    resolveFileValue,
    type ExecutableColumnType,
    type ExecutableValueHost
} from '../executableColumns';

const webview = require(path.join(__dirname, '../../../src/webview/tableView.js'));

const typeOf = (kind: string): ExecutableColumnType => EXECUTABLE_COLUMN_TYPES.find((t) => t.kind === kind)!;

/** Replace a member of the vscode stub for the rest of one test. */
function replace<T extends object, K extends keyof T>(t: { after(fn: () => void): void }, target: T, key: K, value: T[K]): void {
    const original = target[key];
    target[key] = value;
    t.after(() => { target[key] = original; });
}

/** Record the calls of a vscode stub function for the rest of one test. */
function record(t: { after(fn: () => void): void }, target: any, key: string, answer?: (...args: any[]) => any): any[][] {
    const calls: any[][] = [];
    replace(t, target, key, (...args: any[]) => {
        calls.push(args);
        return answer ? answer(...args) : Promise.resolve(undefined);
    });
    return calls;
}

interface FakeTerminal {
    name?: string;
    options?: any;
    sent: Array<[string, boolean]>;
    shown: number;
    exitStatus: unknown;
    show(): void;
    sendText(text: string, addNewLine: boolean): void;
    dispose(): void;
}

/** Terminals the stub reports as open; created ones are added to it. */
function useTerminals(t: { after(fn: () => void): void }): { open: FakeTerminal[]; create(options?: any): FakeTerminal } {
    const open: FakeTerminal[] = [];
    replace(t, vscodeStub.window as any, 'terminals', open);
    const create = (options?: any): FakeTerminal => {
        const terminal: FakeTerminal = {
            name: options?.name,
            options,
            sent: [],
            shown: 0,
            exitStatus: undefined,
            show() { this.shown++; },
            sendText(text, addNewLine) { this.sent.push([text, addNewLine]); },
            dispose() {}
        };
        open.push(terminal);
        return terminal;
    };
    return { open, create };
}

function fakeHost(overrides: Partial<ExecutableValueHost> = {}) {
    const calls = {
        opened: [] as Array<{ sql: string; title: string; ref: unknown }>,
        executed: [] as Array<{ session: unknown; label: string; sql: string }>,
        consoles: [] as FakeTerminal[]
    };
    const state = { generation: 1, terminals: undefined as undefined | { create(options?: any): FakeTerminal } };
    const host: ExecutableValueHost = {
        ensureConnected: async () => true,
        connectionName: () => 'prod',
        connectionGeneration: () => state.generation,
        openQueryView: async (sql, title, ref) => { calls.opened.push({ sql, title, ref }); },
        executeStatement: async (session, label, sql) => {
            calls.executed.push({ session, label, sql });
            return { status: 'executed', message: 'SELECT returned 1 row in 3 ms. Result: true.' };
        },
        openPsqlConsole: async () => {
            const terminal = state.terminals!.create({ name: 'psql: prod' });
            calls.consoles.push(terminal);
            return terminal as any;
        },
        ...overrides
    };
    return { host, calls, state };
}

const session: any = { label: 'Locks' };
const ref = { key: 'tab:3', label: 'Locks' };
const KILL = 'SELECT pg_terminate_backend(4242);';

// ===== the type table =====

test('the webview keeps an exact copy of the executable column types', () => {
    assert.deepEqual(webview.EXECUTABLE_COLUMN_TYPES, EXECUTABLE_COLUMN_TYPES);
});

test('every prefix ends with an underscore and only the types that run commands ask first', () => {
    for (const type of EXECUTABLE_COLUMN_TYPES) {
        assert.match(type.prefix, /^[a-z]+_$/);
    }
    assert.deepEqual(
        EXECUTABLE_COLUMN_TYPES.filter((t) => t.confirm).map((t) => t.prefix),
        ['pgsql_', 'psql_', 'ps_']
    );
});

// ===== executableColumnType =====

test('executableColumnType tells the type from the prefix in any letter case', () => {
    assert.equal(executableColumnType('sql_orders')?.kind, 'dataViewer');
    assert.equal(executableColumnType('pgsql_kill_command')?.kind, 'statement');
    assert.equal(executableColumnType('psql_describe')?.kind, 'psql');
    assert.equal(executableColumnType('ps_restart')?.kind, 'powershell');
    assert.equal(executableColumnType('URL_Homepage')?.kind, 'url');
    assert.equal(executableColumnType('file_log')?.kind, 'file');
    assert.equal(executableColumnType('Copy_Id')?.kind, 'copy');
});

test('executableColumnType needs a name after the prefix and the prefix at the start', () => {
    assert.equal(executableColumnType('sql_'), undefined);
    assert.equal(executableColumnType('kill_command'), undefined);
    assert.equal(executableColumnType('my_sql_text'), undefined);
    assert.equal(executableColumnType('psq_x'), undefined);
    assert.equal(executableColumnType(''), undefined);
});

// ===== executableTypePickItems =====

test('the quick pick offers every type, marks the current one and offers to remove it', () => {
    const fresh = executableTypePickItems(undefined);
    assert.deepEqual(fresh.map((i) => i.prefix), EXECUTABLE_COLUMN_TYPES.map((t) => t.prefix));
    assert.equal(fresh.some((i) => /current/.test(String(i.description))), false);
    assert.match(String(fresh[1].detail), /after asking every time$/);

    const current = executableTypePickItems(typeOf('statement'));
    assert.equal(current.find((i) => i.prefix === 'pgsql_')?.description, 'pgsql_… (current)');
    assert.deepEqual(current[current.length - 1], {
        label: 'Not Executable',
        description: 'removes pgsql_',
        detail: 'Show the values as ordinary text again',
        prefix: ''
    });
});

// ===== executableConfirmation =====

test('a statement, a psql input and a PowerShell command are confirmed with their exact text', () => {
    const statement = executableConfirmation(typeOf('statement'), KILL, { session: 'Locks', connection: 'prod' });
    assert.equal(statement?.message, 'Run this statement in the database session of "Locks"?');
    assert.equal(statement?.action, 'Run');
    assert.ok(statement?.detail.startsWith(`${KILL}\n\n`));
    assert.match(String(statement?.detail), /comes from the query result/);

    assert.equal(executableConfirmation(typeOf('psql'), '\\dt', { connection: 'prod' })?.message, 'Send this to the psql console of "prod"?');
    assert.equal(executableConfirmation(typeOf('powershell'), 'Get-Date', {})?.message, 'Run this command in PowerShell?');
});

test('opening, copying and showing values runs without asking', () => {
    for (const kind of ['dataViewer', 'url', 'file', 'copy']) {
        assert.equal(executableConfirmation(typeOf(kind), 'x', {}), null, kind);
    }
});

test('clipText shortens a long text and says how much is left out', () => {
    assert.equal(clipText('abc', 5), 'abc');
    assert.equal(clipText('abcdefg', 5), 'abcde\n… (2 more characters)');
});

// ===== value helpers =====

test('httpUrl accepts http and https links only', () => {
    assert.equal(httpUrl(' https://example.com/a?b=1 '), 'https://example.com/a?b=1');
    assert.equal(httpUrl('http://localhost:8080'), 'http://localhost:8080/');
    for (const value of ['javascript:alert(1)', 'file:///C:/x.txt', 'command:workbench.action.quit', 'vscode://x', 'example.com', '']) {
        assert.equal(httpUrl(value), null, value);
    }
});

test('resolveFileValue resolves absolute, quoted, file: and workspace-relative paths', () => {
    assert.deepEqual(resolveFileValue('C:\\logs\\app.log', [], path.win32), { path: 'C:\\logs\\app.log' });
    assert.deepEqual(resolveFileValue('"C:\\My Logs\\app.log"', [], path.win32), { path: 'C:\\My Logs\\app.log' });
    assert.deepEqual(resolveFileValue('/var/log/app.log', [], path.posix), { path: '/var/log/app.log' });
    assert.deepEqual(resolveFileValue('logs/app.log', ['/work/repo'], path.posix), { path: '/work/repo/logs/app.log' });
    const own = path.join(os.tmpdir(), 'pgqb file.log');
    assert.deepEqual(resolveFileValue(pathToFileURL(own).href, []), { path: own });
});

test('resolveFileValue refuses what is no file path', () => {
    assert.match((resolveFileValue('logs/app.log', [], path.posix) as any).error, /relative path, which needs an open workspace folder/);
    assert.match((resolveFileValue('https://example.com/a.txt', ['/w'], path.posix) as any).error, /not https: links/);
    assert.match((resolveFileValue('   ', ['/w'], path.posix) as any).error, /empty/);
});

test('psqlInput closes a statement with a semicolon so psql runs it', () => {
    assert.equal(psqlInput('SELECT 1'), 'SELECT 1;');
    assert.equal(psqlInput(' SELECT 1; '), 'SELECT 1;');
    assert.equal(psqlInput('\\dt public.*'), '\\dt public.*');
});

test('PowerShell is Windows PowerShell on Windows and pwsh elsewhere', () => {
    assert.equal(powershellPath('win32'), 'powershell.exe');
    assert.equal(powershellPath('linux'), 'pwsh');
    assert.equal(powershellPath('darwin'), 'pwsh');
});

// ===== ExecutableValueRunner =====

test('a pgsql_ value runs in the session of the Data Viewer after the user confirmed it', async (t) => {
    const asked = stubWarningMessage(t, (items) => items[0]);
    const infos = record(t, vscodeStub.window, 'showInformationMessage');
    const { host, calls } = fakeHost();

    const outcome = await new ExecutableValueRunner(host).run(typeOf('statement'), KILL, { session, ref });

    assert.equal(asked.length, 1);
    assert.equal(asked[0][0], 'Run this statement in the database session of "Locks"?');
    assert.equal((asked[0][1] as { modal?: boolean }).modal, true);
    assert.deepEqual(calls.executed, [{ session, label: 'Locks', sql: KILL }]);
    assert.deepEqual(outcome, { status: 'executed', message: 'SELECT returned 1 row in 3 ms. Result: true.' });
    assert.deepEqual(infos.map((c) => c[0]), ['SELECT returned 1 row in 3 ms. Result: true.']);
});

test('a pgsql_ value the user does not confirm is not run', async (t) => {
    stubWarningMessage(t, () => undefined);
    const { host, calls } = fakeHost();

    const outcome = await new ExecutableValueRunner(host).run(typeOf('statement'), KILL, { session, ref });

    assert.deepEqual(outcome, { status: 'cancelled' });
    assert.equal(calls.executed.length, 0);
});

test('a failing pgsql_ statement is reported with its error', async (t) => {
    stubWarningMessage(t, (items) => items[0]);
    const errors = record(t, vscodeStub.window, 'showErrorMessage');
    const { host } = fakeHost({ executeStatement: async () => ({ status: 'failed', message: 'permission denied' }) });

    const outcome = await new ExecutableValueRunner(host).run(typeOf('statement'), KILL, { session, ref });

    assert.deepEqual(outcome, { status: 'failed', message: 'permission denied' });
    assert.deepEqual(errors.map((c) => c[0]), ['Run as Statement failed: permission denied']);
});

test('nothing is asked or run without a connection', async (t) => {
    const asked = stubWarningMessage(t, (items) => items[0]);
    const { host, calls } = fakeHost({ ensureConnected: async () => false });

    const outcome = await new ExecutableValueRunner(host).run(typeOf('statement'), KILL, { session, ref });

    assert.deepEqual(outcome, { status: 'cancelled' });
    assert.equal(asked.length, 0);
    assert.equal(calls.executed.length, 0);
});

test('an empty value is not run', async (t) => {
    const asked = stubWarningMessage(t, (items) => items[0]);
    record(t, vscodeStub.window, 'showErrorMessage');
    const { host, calls } = fakeHost();

    const outcome = await new ExecutableValueRunner(host).run(typeOf('statement'), '   ', { session, ref });

    assert.equal(outcome.status, 'failed');
    assert.equal(asked.length, 0);
    assert.equal(calls.executed.length, 0);
});

test('a sql_ query opens in a new Data Viewer that shares the session of the panel', async (t) => {
    const asked = stubWarningMessage(t, (items) => items[0]);
    const { host, calls } = fakeHost();

    const outcome = await new ExecutableValueRunner(host).run(typeOf('dataViewer'), 'SELECT * FROM orders WHERE id = 7;', { session, ref });

    assert.deepEqual(outcome, { status: 'opened' });
    assert.equal(asked.length, 0, 'opening a query is not confirmed');
    assert.deepEqual(calls.opened, [{ sql: 'SELECT * FROM orders WHERE id = 7', title: 'View Data: SELECT * FROM orders WHERE id = 7', ref }]);
});

test('a sql_ value that changes data or holds several statements does not open', async (t) => {
    const errors = record(t, vscodeStub.window, 'showErrorMessage');
    const { host, calls } = fakeHost();
    const runner = new ExecutableValueRunner(host);

    for (const value of ['DELETE FROM orders', 'SELECT 1; SELECT 2', 'WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d']) {
        assert.equal((await runner.run(typeOf('dataViewer'), value, { session, ref })).status, 'failed', value);
    }
    assert.equal(calls.opened.length, 0);
    assert.match(String(errors[0][0]), /^Open in Data Viewer failed: A sql_ value has to be one query returning rows .* Use the pgsql_ prefix/);
});

test('psql_ values go to one psql console, reopened once it is closed or the connection changed', async (t) => {
    stubWarningMessage(t, (items) => items[0]);
    const terminals = useTerminals(t);
    const { host, calls, state } = fakeHost();
    state.terminals = terminals;
    const runner = new ExecutableValueRunner(host);

    assert.deepEqual(await runner.run(typeOf('psql'), 'SELECT 1', { session, ref }), { status: 'sent', message: 'Sent to the psql console of "prod".' });
    await runner.run(typeOf('psql'), '\\dt', { session, ref });
    assert.equal(calls.consoles.length, 1, 'the open console is reused');
    assert.deepEqual(calls.consoles[0].sent, [['SELECT 1;', true], ['\\dt', true]]);

    terminals.open.splice(0, terminals.open.length);
    await runner.run(typeOf('psql'), 'SELECT 2', { session, ref });
    assert.equal(calls.consoles.length, 2, 'a closed console is opened again');

    state.generation = 2;
    await runner.run(typeOf('psql'), 'SELECT 3', { session, ref });
    assert.equal(calls.consoles.length, 3, 'another connection gets its own console');
    assert.deepEqual(calls.consoles[2].sent, [['SELECT 3;', true]]);
});

test('a psql_ value is not sent when psql cannot be started', async (t) => {
    stubWarningMessage(t, (items) => items[0]);
    const errors = record(t, vscodeStub.window, 'showErrorMessage');
    const { host } = fakeHost({ openPsqlConsole: async () => undefined });

    assert.deepEqual(await new ExecutableValueRunner(host).run(typeOf('psql'), 'SELECT 1', { session, ref }), { status: 'cancelled' });
    assert.equal(errors.length, 0, 'the console has already said why');
});

test('ps_ values run in one PowerShell terminal, after confirmation', async (t) => {
    const asked = stubWarningMessage(t, (items) => items[0]);
    const terminals = useTerminals(t);
    const created = record(t, vscodeStub.window, 'createTerminal', (options) => terminals.create(options));
    const { host } = fakeHost();
    const runner = new ExecutableValueRunner(host, 'win32');

    assert.deepEqual(await runner.run(typeOf('powershell'), 'Restart-Service spooler', {}), { status: 'sent', message: 'Sent to the PowerShell terminal.' });
    await runner.run(typeOf('powershell'), 'Get-Date', {});

    assert.equal(asked.length, 2);
    assert.equal(asked[0][0], 'Run this command in PowerShell?');
    assert.equal(created.length, 1);
    assert.equal(created[0][0].name, POWERSHELL_TERMINAL_NAME);
    assert.equal(created[0][0].shellPath, 'powershell.exe');
    assert.deepEqual(terminals.open[0].sent, [['Restart-Service spooler', true], ['Get-Date', true]]);
});

test('url_ values open http(s) links in the browser and refuse any other link', async (t) => {
    const opened = record(t, vscodeStub.env, 'openExternal', () => Promise.resolve(true));
    const errors = record(t, vscodeStub.window, 'showErrorMessage');
    const runner = new ExecutableValueRunner(fakeHost().host);

    assert.deepEqual(await runner.run(typeOf('url'), 'https://example.com/ticket/7', {}), { status: 'opened' });
    assert.equal(String(opened[0][0]), 'https://example.com/ticket/7');

    assert.equal((await runner.run(typeOf('url'), 'command:workbench.action.terminal.new', {})).status, 'failed');
    assert.equal(opened.length, 1);
    assert.match(String(errors[0][0]), /^Open in Browser failed: Only http and https links are opened/);
});

test('file_ values open an existing file in the editor and report a missing one or a folder', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgqb-exec-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'app.log');
    fs.writeFileSync(file, 'log', 'utf8');
    const commands = record(t, vscodeStub.commands, 'executeCommand');
    const errors = record(t, vscodeStub.window, 'showErrorMessage');
    const runner = new ExecutableValueRunner(fakeHost().host);

    assert.deepEqual(await runner.run(typeOf('file'), file, {}), { status: 'opened' });
    assert.equal(commands[0][0], 'vscode.open');
    assert.equal(commands[0][1].fsPath, file);

    assert.equal((await runner.run(typeOf('file'), path.join(dir, 'missing.log'), {})).status, 'failed');
    assert.equal((await runner.run(typeOf('file'), dir, {})).status, 'failed');
    assert.equal(commands.length, 1);
    assert.match(String(errors[0][0]), /does not exist/);
    assert.match(String(errors[1][0]), /is a folder, not a file/);
});

test('copy_ values are copied to the clipboard', async (t) => {
    const written = record(t, vscodeStub.env.clipboard, 'writeText');
    const { host } = fakeHost();

    assert.deepEqual(await new ExecutableValueRunner(host).run(typeOf('copy'), 'ORD-2026-0042', {}), { status: 'copied' });
    assert.deepEqual(written, [['ORD-2026-0042']]);
});
