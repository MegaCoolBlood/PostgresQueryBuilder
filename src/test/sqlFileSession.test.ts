import './helpers/vscodeMock';
import { vscodeStub, fireDidChangeTabs, stubWarningMessage } from './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DbSessionManager } from '../dbSession';
import {
    SqlFileSessions,
    errorOffset,
    fileSessionRef,
    formatServerMessage,
    isResultQuery,
    queryViewTitle,
    splitStatements,
    statementToExecute,
    summarizeExecution,
    summarizeFileRun,
    tabShowsUri,
    resultValueText,
    statementErrorText,
    MESSAGES_CHANNEL_NAME,
    type QueryViewLoad
} from '../sqlFileSession';

const DO_BLOCK = [
    'DO $$',
    'DECLARE',
    "    v_periodenBeginn  TIMESTAMP := TO_TIMESTAMP('21.09.2026', 'DD.MM.YYYY');",
    "    v_periodenEnde    TIMESTAMP := TO_TIMESTAMP('20.10.2026', 'DD.MM.YYYY');",
    "    v_stichtag        TIMESTAMP := TO_TIMESTAMP('22.10.2026', 'DD.MM.YYYY');",
    'BEGIN',
    '    -- assumption: the package exists as a schema; a ; here ends nothing',
    '    CALL pks_ate_payroll.p_set_params(v_periodenBeginn, v_periodenEnde, v_stichtag);',
    'END $$'
].join('\n');

const SET_CONFIG = [
    "SELECT set_config('pks_ate_payroll.l_von', TO_TIMESTAMP('21.09.2026', 'DD.MM.YYYY')::TEXT, FALSE)",
    'UNION ALL',
    "SELECT set_config('pks_ate_payroll.l_bis', TO_TIMESTAMP('20.10.2026', 'DD.MM.YYYY')::TEXT, FALSE)"
].join('\n');

const SELECT = 'SELECT * FROM pks_ate_payroll.v_lohn';

const FILE = `${DO_BLOCK};\n\n${SET_CONFIG};\n\n${SELECT};\n\n`;

// ===== statementToExecute: exactly the selection =====

test('a selection is executed exactly as selected', () => {
    const start = FILE.indexOf(SET_CONFIG);
    assert.deepEqual(
        statementToExecute(FILE, start, start + SET_CONFIG.length),
        { sql: SET_CONFIG, start }
    );
});

test('without a selection nothing is executed, wherever the cursor is', () => {
    const offset = FILE.indexOf('CALL');
    assert.equal(statementToExecute(FILE, offset, offset), null);
    assert.equal(statementToExecute(FILE, 0, 0), null);
});

test('a selection of blanks and comments executes nothing', () => {
    assert.equal(statementToExecute('  -- x\n  ', 0, 9), null);
});

// ===== splitStatements =====

test('splitStatements keeps a DO block together', () => {
    assert.deepEqual(splitStatements(FILE), [DO_BLOCK, SET_CONFIG, SELECT]);
});

test('semicolons in strings, quoted names and comments do not split a statement', () => {
    assert.deepEqual(
        splitStatements("SELECT 'a;b' AS \"x;y\" /* c;d */, 2 -- e;f\nFROM t;\nSELECT 3;"),
        ["SELECT 'a;b' AS \"x;y\" /* c;d */, 2 -- e;f\nFROM t", 'SELECT 3']
    );
});

test('comments in front of a statement are not part of it', () => {
    assert.deepEqual(splitStatements('-- set up the period\nSELECT 1;'), ['SELECT 1']);
});

test('an escaped quote in an E string does not end the string', () => {
    assert.deepEqual(
        splitStatements("SELECT E'it\\'s; fine' AS x;\nSELECT 2;"),
        ["SELECT E'it\\'s; fine' AS x", 'SELECT 2']
    );
});

test('a dollar sign inside a name or a parameter does not start a dollar quote', () => {
    assert.deepEqual(
        splitStatements('SELECT a$b$c FROM t;\nDELETE FROM t WHERE id = $1;\nSELECT 2;'),
        ['SELECT a$b$c FROM t', 'DELETE FROM t WHERE id = $1', 'SELECT 2']
    );
});

test('a BEGIN ATOMIC body is kept together with its CASE … END', () => {
    const procedure = [
        'CREATE PROCEDURE purge() LANGUAGE SQL',
        'BEGIN ATOMIC',
        '  DELETE FROM audit_log;',
        "  UPDATE t SET kind = CASE WHEN a THEN 'x' ELSE 'y' END;",
        'END'
    ].join('\n');
    assert.deepEqual(splitStatements(`${procedure};\nSELECT 1;`), [procedure, 'SELECT 1']);
});

test('a file without a statement has none', () => {
    assert.deepEqual(splitStatements(''), []);
    assert.deepEqual(splitStatements('  -- only a comment\n'), []);
});

// ===== isResultQuery / queryViewTitle =====

test('isResultQuery accepts the queries whose rows are worth a look', () => {
    assert.equal(isResultQuery(SELECT), true);
    assert.equal(isResultQuery(SET_CONFIG), true);
    assert.equal(isResultQuery('WITH x AS (SELECT 1) SELECT * FROM x'), true);
    assert.equal(isResultQuery('VALUES (1), (2)'), true);
    assert.equal(isResultQuery('TABLE orders'), true);
    assert.equal(isResultQuery('SELECT * FROM orders FOR UPDATE'), true);
    assert.equal(isResultQuery("SELECT 'insert into' AS note"), true);
});

test('isResultQuery leaves statements that change something to be executed', () => {
    assert.equal(isResultQuery(DO_BLOCK), false);
    assert.equal(isResultQuery('CALL p()'), false);
    assert.equal(isResultQuery('SELECT * INTO copy FROM orders'), false);
    assert.equal(isResultQuery('WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone'), false);
    assert.equal(isResultQuery('UPDATE t SET a = 1'), false);
});

test('queryViewTitle names the Data Viewer like View Data does', () => {
    assert.equal(queryViewTitle('SELECT *\n  FROM orders'), 'View Data: SELECT * FROM orders');
    assert.equal(queryViewTitle(SELECT + ' WHERE period = 1'), 'View Data: SELECT * FROM pks_ate_payroll.v_lohn WHE…');
});

// ===== summarizeExecution =====

test('summarizeExecution names a statement without a row count', () => {
    assert.equal(summarizeExecution([{ command: 'DO', rowCount: null }], 12), 'DO completed in 12 ms.');
    assert.equal(summarizeExecution([{ command: 'CALL', rowCount: null }], 3), 'CALL completed in 3 ms.');
    assert.equal(summarizeExecution([{ command: null, rowCount: null }], 3), 'The statement completed in 3 ms.');
});

test('summarizeExecution counts the rows a statement returned or changed', () => {
    assert.equal(summarizeExecution([{ command: 'SELECT', rowCount: 2 }], 5), 'SELECT returned 2 rows in 5 ms.');
    assert.equal(summarizeExecution([{ command: 'UPDATE', rowCount: 1 }], 5), 'UPDATE affected 1 row in 5 ms.');
});

test('summarizeExecution lists every statement of a script', () => {
    assert.equal(
        summarizeExecution([{ command: 'DO', rowCount: null }, { command: 'SELECT', rowCount: 3 }, { command: 'DELETE', rowCount: 0 }], 1500),
        '3 statements completed in 1.5 s: DO, SELECT (3 rows), DELETE (0 rows).'
    );
});

// ===== summarizeFileRun =====

test('summarizeFileRun tells how many statements ran and how many went to the Data Viewer', () => {
    assert.equal(summarizeFileRun('payroll.sql', 4, 1, 1234), 'Ran all 4 statements of payroll.sql in 1.2 s; 1 query opened in the Data Viewer.');
    assert.equal(summarizeFileRun('payroll.sql', 3, 2, 50), 'Ran all 3 statements of payroll.sql in 50 ms; 2 queries opened in the Data Viewer.');
    assert.equal(summarizeFileRun('payroll.sql', 1, 0, 12), 'Ran the statement of payroll.sql in 12 ms.');
});

// ===== formatServerMessage / errorOffset / tabShowsUri / fileSessionRef =====

test('formatServerMessage writes a server message with its details', () => {
    const at = new Date(2026, 9, 22, 9, 5, 7);
    assert.equal(
        formatServerMessage('payroll.sql', { severity: 'NOTICE', message: 'period set', detail: 'd', hint: 'h', where: 'PL/pgSQL function inline_code_block line 8 at RAISE' }, at),
        '[09:05:07] payroll.sql — NOTICE: period set\n'
        + '    DETAIL: d\n'
        + '    HINT: h\n'
        + '    CONTEXT: PL/pgSQL function inline_code_block line 8 at RAISE'
    );
    assert.equal(formatServerMessage('x', { message: 'plain' }, at), '[09:05:07] x — NOTICE: plain');
});

test('errorOffset maps the reported position into the document', () => {
    assert.equal(errorOffset({ position: '5' }, 100, 20), 104);
    assert.equal(errorOffset({ position: '1' }, 0, 20), 0);
});

test('errorOffset ignores an error without a usable position', () => {
    assert.equal(errorOffset(new Error('boom'), 0, 20), null);
    assert.equal(errorOffset({ position: '0' }, 0, 20), null);
    assert.equal(errorOffset({ position: '99' }, 0, 20), null);
    assert.equal(errorOffset(null, 0, 20), null);
});

test('tabShowsUri recognises a text tab and both sides of a diff', () => {
    const uri = { toString: () => 'file:///work/payroll.sql' };
    assert.equal(tabShowsUri({ uri }, 'file:///work/payroll.sql'), true);
    assert.equal(tabShowsUri({ original: uri, modified: { toString: () => 'x' } }, 'file:///work/payroll.sql'), true);
    assert.equal(tabShowsUri({ uri: { toString: () => 'file:///other.sql' } }, 'file:///work/payroll.sql'), false);
    assert.equal(tabShowsUri(undefined, 'file:///work/payroll.sql'), false);
});

test('fileSessionRef keys the session by the document and names it by the file', () => {
    assert.deepEqual(
        fileSessionRef({ toString: () => 'file:///work/payroll.sql' }, '/work/payroll.sql'),
        { key: 'file:file:///work/payroll.sql', label: 'payroll.sql' }
    );
});

// ===== SqlFileSessions =====

class FakeClient extends EventEmitter {
    queries: string[] = [];
    /** Every query as it was passed, a config object included. */
    configs: Array<string | { text: string; rowMode?: string }> = [];
    ended = false;
    constructor(readonly processID: number, private readonly onQuery?: (client: FakeClient, sql: string) => unknown) {
        super();
    }
    async query(textOrConfig: string | { text: string }): Promise<any> {
        const sql = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text;
        this.queries.push(sql);
        this.configs.push(textOrConfig);
        const answer = this.onQuery ? await this.onQuery(this, sql) : undefined;
        return answer ?? { rows: [], fields: [], rowCount: null, command: sql.trim().split(/\s+/)[0].toUpperCase() };
    }
    async end(): Promise<void> {
        this.ended = true;
    }
}

const URI = 'file:///work/payroll.sql';

function createDocument(text: string) {
    return {
        uri: { toString: () => URI },
        fileName: '/work/payroll.sql',
        isClosed: false,
        getText: () => text,
        offsetAt: (position: { offset: number }) => position.offset,
        positionAt: (offset: number) => ({ offset, line: text.slice(0, offset).split('\n').length - 1 })
    };
}

function createEditor(text: string, cursor: number, selectionEnd = cursor) {
    const start = { offset: Math.min(cursor, selectionEnd) };
    const end = { offset: Math.max(cursor, selectionEnd) };
    return {
        document: createDocument(text),
        selection: { start, end, active: end } as any,
        revealed: [] as any[],
        revealRange(range: any) { this.revealed.push(range); }
    };
}

/** Pretend the file is open in a tab, or closed when `open` is false. */
function showFile(open: boolean) {
    vscodeStub.window.tabGroups.all = open ? [{ tabs: [{ input: { uri: { toString: () => URI } } }] }] : [];
}

/** Replace a `window` function for the rest of one test and record its calls. */
function recordWindowCalls(t: { after(fn: () => void): void }, name: 'showInformationMessage' | 'showErrorMessage' | 'showWarningMessage' | 'withProgress' | 'showSaveDialog', impl?: (...args: any[]) => any): any[][] {
    const calls: any[][] = [];
    const window = vscodeStub.window as any;
    const original = window[name];
    window[name] = (...args: any[]) => {
        calls.push(args);
        return impl ? impl(...args) : Promise.resolve(undefined);
    };
    t.after(() => { window[name] = original; });
    return calls;
}

function createFileSessions(options: {
    onQuery?: (client: FakeClient, sql: string) => unknown;
    connected?: boolean;
    poolQuery?: (sql: string, params?: unknown[]) => Promise<any>;
    /** How the first query of a Data Viewer opened for `sql` ends; loaded at once by default. */
    viewerLoad?: (sql: string) => Promise<QueryViewLoad>;
    exporter?: any;
} = {}) {
    const clients: FakeClient[] = [];
    /** Statements run on the session (`run:`) and Data Viewers opened (`view:`), in order. */
    const events: string[] = [];
    const manager = new DbSessionManager({
        openClient: async () => {
            const client = new FakeClient(4711 + clients.length, (c, sql) => {
                events.push(`run:${sql}`);
                return options.onQuery?.(c, sql);
            });
            clients.push(client);
            return client as any;
        },
        generation: () => 1
    });
    const channel = {
        lines: [] as string[],
        shown: 0,
        appendLine(line: string) { this.lines.push(line); },
        show() { this.shown++; }
    };
    const history: Array<{ sql: string }> = [];
    const poolQueries: Array<{ sql: string; params?: unknown[] }> = [];
    const opened: Array<{ sql: string; title: string; ref: any; placement?: any }> = [];
    const connectionManager: any = {
        ensureConnected: async () => options.connected !== false,
        query: async (sql: string, params?: unknown[]) => {
            poolQueries.push({ sql, params });
            return options.poolQuery ? options.poolQuery(sql, params) : { rows: [] };
        }
    };
    const modifyHistoryStore: any = { addMany: (entries: Array<{ sql: string }>) => history.push(...entries) };
    const openQueryView = async (sql: string, title: string, ref: any, placement?: any) => {
        opened.push({ sql, title, ref, placement });
        events.push(`view:${sql}`);
        return {
            loaded: options.viewerLoad ? options.viewerLoad(sql) : Promise.resolve({ status: 'loaded' } as QueryViewLoad),
            // The editor group the first Data Viewer landed in, beside the file.
            viewColumn: () => 2
        };
    };
    const fileSessions = new SqlFileSessions(manager, connectionManager, channel as any, modifyHistoryStore, openQueryView, options.exporter);
    showFile(true);
    return { manager, clients, channel, history, poolQueries, opened, events, fileSessions };
}

/** An editor in which exactly `selected` is selected. */
function selecting(text: string, selected: string) {
    const start = text.indexOf(selected);
    assert.ok(start >= 0, `"${selected}" is not in the text`);
    return createEditor(text, start, start + selected.length);
}

/** Let `withProgress` hand out a token whose Cancel the test presses itself. */
function controllableCancel(t: { after(fn: () => void): void }) {
    const control = { cancel: () => undefined as void };
    recordWindowCalls(t, 'withProgress', (_options: any, task: any) => task(
        { report() {} },
        { isCancellationRequested: false, onCancellationRequested: (listener: () => void) => { control.cancel = listener; return { dispose() {} }; } }
    ));
    return control;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('Execute Selection runs the selected DO block in the session of the file', async (t) => {
    const infos = recordWindowCalls(t, 'showInformationMessage');
    const { fileSessions, clients, manager } = createFileSessions();
    t.after(() => fileSessions.dispose());

    await fileSessions.execute(selecting(FILE, `${DO_BLOCK};`) as any);

    assert.equal(clients.length, 1);
    assert.deepEqual(clients[0].queries, [`${DO_BLOCK};`]);
    assert.match(String(infos[0][0]), /^DO completed in \d+ ms\.$/);
    const session = manager.get(`file:${URI}`);
    assert.ok(session && session.isOpen, 'the file keeps its session open');
});

test('Execute Selection runs nothing without a selection, wherever the cursor is', async (t) => {
    const warnings = recordWindowCalls(t, 'showWarningMessage');
    const { fileSessions, clients } = createFileSessions();
    t.after(() => fileSessions.dispose());

    await fileSessions.execute(createEditor(FILE, FILE.indexOf('CALL')) as any);
    await fileSessions.execute(selecting('SELECT 1; -- nothing to run\n', '-- nothing to run') as any);
    await fileSessions.execute(undefined);

    assert.equal(clients.length, 0);
    assert.equal(warnings.length, 3);
    assert.equal(warnings[0][0], 'Select the statements to execute: Execute Selection runs exactly the selected text.');
});

test('a selected SELECT opens in the Data Viewer on the session of the file instead of running', async (t) => {
    const { fileSessions, clients, opened, manager } = createFileSessions();
    t.after(() => fileSessions.dispose());

    await fileSessions.execute(selecting(FILE, `${SELECT};`) as any);

    assert.deepEqual(clients, [], 'nothing was fetched just to be counted');
    assert.equal(opened.length, 1);
    assert.equal(opened[0].sql, SELECT);
    assert.equal(opened[0].title, 'View Data: SELECT * FROM pks_ate_payroll.v_lohn');
    assert.deepEqual(opened[0].ref, { key: `file:${URI}`, label: 'payroll.sql' });
    assert.ok(manager.get(`file:${URI}`), 'the file holds the session the Data Viewer runs on');
});

test('a selection of several statements runs as a whole, even with a SELECT among them', async (t) => {
    const infos = recordWindowCalls(t, 'showInformationMessage');
    const { fileSessions, clients, opened } = createFileSessions({
        onQuery: () => [{ command: 'DO', rowCount: null }, { command: 'SELECT', rowCount: 2 }]
    });
    t.after(() => fileSessions.dispose());
    const selected = `${DO_BLOCK};\n\n${SET_CONFIG};`;

    await fileSessions.execute(selecting(FILE, selected) as any);

    assert.deepEqual(opened, []);
    assert.deepEqual(clients[0].queries, [selected]);
    assert.match(String(infos[0][0]), /^2 statements completed in \d+ ms: DO, SELECT \(2 rows\)\.$/);
});

test('every selection of a file runs on the same connection, so a setting stays visible', async (t) => {
    recordWindowCalls(t, 'showInformationMessage');
    const { fileSessions, clients, manager } = createFileSessions();
    t.after(() => fileSessions.dispose());
    const setting = "SET pks_ate_payroll.l_von = '2026-09-21'";
    const text = `${FILE}${setting};\n`;

    await fileSessions.execute(selecting(text, DO_BLOCK) as any);
    await fileSessions.execute(selecting(text, setting) as any);
    // A Data Viewer opened from the file with "View Data" uses the same session.
    const { ref } = fileSessions.acquire(createDocument(text) as any);
    await manager.acquire(ref, 'panel:1').query(SELECT);

    assert.equal(clients.length, 1);
    assert.deepEqual(clients[0].queries, [DO_BLOCK, setting, SELECT]);
});

test('Execute Selection counts the messages of the server and shows them', async (t) => {
    const infos = recordWindowCalls(t, 'showInformationMessage');
    const { fileSessions, channel } = createFileSessions({
        onQuery: (client) => { client.emit('notice', { severity: 'NOTICE', message: 'period set' }); }
    });
    t.after(() => fileSessions.dispose());

    await fileSessions.execute(selecting(FILE, DO_BLOCK) as any);

    assert.match(String(infos[0][0]), /The server sent 1 message, shown in the "PostgreSQL Messages" output\./);
    assert.equal(channel.shown, 1);
    assert.equal(MESSAGES_CHANNEL_NAME, 'PostgreSQL Messages');
});

test('a selection that fails puts the cursor where the server saw the error', async (t) => {
    const errors = recordWindowCalls(t, 'showErrorMessage');
    const { fileSessions, channel } = createFileSessions({
        onQuery: () => {
            throw Object.assign(new Error('syntax error at or near "SELEC"'), { position: '10', hint: 'check the spelling' });
        }
    });
    t.after(() => fileSessions.dispose());
    const text = 'SELECT 1;\n\nDO $$ BEGIN SELEC 1; END $$;';
    const editor = selecting(text, 'DO $$ BEGIN SELEC 1; END $$;');

    await fileSessions.execute(editor as any);

    assert.equal(errors[0][0], 'Execute Selection failed: syntax error at or near "SELEC"');
    assert.equal((editor.selection as any).active.offset, text.indexOf('DO $$') + 9);
    assert.equal(editor.revealed.length, 1);
    assert.match(channel.lines[0], /payroll\.sql — ERROR: syntax error at or near "SELEC"\n {4}HINT: check the spelling$/);
});

test('statements that change data are recorded in the Modify History', async (t) => {
    recordWindowCalls(t, 'showInformationMessage');
    const { fileSessions, history } = createFileSessions();
    t.after(() => fileSessions.dispose());
    const text = 'CALL pks_ate_payroll.p_set_params(now(), now(), now());\nSELECT 1;';

    await fileSessions.execute(createEditor(text, 0, text.length) as any);

    assert.deepEqual(history, [{ sql: 'CALL pks_ate_payroll.p_set_params(now(), now(), now())' }]);
});

test('Execute Selection runs nothing when no connection is chosen', async (t) => {
    const { fileSessions, clients } = createFileSessions({ connected: false });
    t.after(() => fileSessions.dispose());

    await fileSessions.execute(selecting(FILE, DO_BLOCK) as any);

    assert.equal(clients.length, 0);
});

test('cancelling a running selection cancels its own server process', async (t) => {
    const control = controllableCancel(t);
    recordWindowCalls(t, 'showErrorMessage');
    let release: () => void = () => undefined;
    const { fileSessions, poolQueries } = createFileSessions({
        onQuery: () => new Promise<void>((resolve) => { release = resolve; }).then(() => {
            throw new Error('canceling statement due to user request');
        })
    });
    t.after(() => fileSessions.dispose());

    const running = fileSessions.execute(selecting('DO $$ BEGIN PERFORM pg_sleep(60); END $$;', 'DO $$ BEGIN PERFORM pg_sleep(60); END $$') as any);
    await tick();
    control.cancel();
    await tick();
    release();
    await running;

    assert.deepEqual(poolQueries, [{ sql: 'SELECT pg_cancel_backend($1)', params: [4711] }]);
});

test('cancelling a selection still waiting for its turn skips it and cancels nothing else', async (t) => {
    const control = controllableCancel(t);
    const infos = recordWindowCalls(t, 'showInformationMessage');
    let release: () => void = () => undefined;
    const { fileSessions, manager, clients, poolQueries } = createFileSessions({
        onQuery: (_client, sql) => (sql === 'SELECT pg_sleep(60)' ? new Promise((resolve) => { release = () => resolve(undefined); }) : undefined)
    });
    t.after(() => fileSessions.dispose());
    // A Data Viewer on the file's session is busy with a long query.
    const { ref } = fileSessions.acquire(createDocument(FILE) as any);
    const viewerQuery = manager.acquire(ref, 'panel:1').query('SELECT pg_sleep(60)');
    await tick();

    const waiting = fileSessions.execute(selecting(FILE, DO_BLOCK) as any);
    await tick();
    control.cancel();
    release();
    await viewerQuery;
    await waiting;

    assert.deepEqual(poolQueries, [], 'the query of the Data Viewer was left alone');
    assert.deepEqual(clients[0].queries, ['SELECT pg_sleep(60)'], 'the cancelled selection never ran');
    assert.equal(infos[0][0], 'Execute Selection was cancelled before it started; nothing ran.');
});

test('the next statement of the session waits until a slow cancel request has been handled', async (t) => {
    const control = controllableCancel(t);
    recordWindowCalls(t, 'showInformationMessage');
    let finishStatement: () => void = () => undefined;
    let answerCancel: () => void = () => undefined;
    const { fileSessions, manager, clients, poolQueries } = createFileSessions({
        onQuery: (_client, sql) => (sql === DO_BLOCK ? new Promise((resolve) => { finishStatement = () => resolve(undefined); }) : undefined),
        // The pool first has to open a connection for the cancel request.
        poolQuery: () => new Promise((resolve) => { answerCancel = () => resolve({ rows: [] }); })
    });
    t.after(() => fileSessions.dispose());

    const running = fileSessions.execute(selecting(FILE, DO_BLOCK) as any);
    await tick();
    control.cancel();
    // A Data Viewer on the file's session queues its query behind the selection.
    const { ref } = fileSessions.acquire(createDocument(FILE) as any);
    const viewerQuery = manager.acquire(ref, 'panel:1').query('SELECT 1');
    // The selection ends on its own before the cancel request reached the server.
    finishStatement();
    await tick();
    await tick();
    assert.deepEqual(clients[0].queries, [DO_BLOCK], 'the cancel request would hit the query of the Data Viewer');

    answerCancel();
    await running;
    await viewerQuery;
    assert.deepEqual(clients[0].queries, [DO_BLOCK, 'SELECT 1']);
    assert.deepEqual(poolQueries, [{ sql: 'SELECT pg_cancel_backend($1)', params: [4711] }]);
});

// ===== Execute File =====

const UPDATE = 'UPDATE pks_ate_payroll.lohn SET done = false';
const DELETE = 'DELETE FROM pks_ate_payroll.tmp';
/** Line 1 a comment, the DO block on lines 2–10, UPDATE on 12, SELECT on 14, DELETE on 16. */
const SCRIPT = `-- payroll run\n${DO_BLOCK};\n\n${UPDATE};\n\n${SELECT};\n\n${DELETE};\n`;

/** Let every pending promise of the run settle. */
async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
        await tick();
    }
}

function deferredLoad() {
    let resolve: (outcome: QueryViewLoad) => void = () => undefined;
    const promise = new Promise<QueryViewLoad>((res) => { resolve = res; });
    return { promise, resolve };
}

test('Execute File runs the file from top to bottom on its session and opens SELECTs in the Data Viewer', async (t) => {
    const infos = recordWindowCalls(t, 'showInformationMessage');
    const { fileSessions, events, opened, history, clients } = createFileSessions();
    t.after(() => fileSessions.dispose());

    await fileSessions.executeFile(createEditor(SCRIPT, 0) as any);

    assert.deepEqual(events, [`run:${DO_BLOCK}`, `run:${UPDATE}`, `view:${SELECT}`, `run:${DELETE}`]);
    assert.equal(clients.length, 1, 'every statement ran on the one session of the file');
    assert.deepEqual(opened[0].ref, { key: `file:${URI}`, label: 'payroll.sql' });
    assert.deepEqual(history, [{ sql: UPDATE }, { sql: DELETE }]);
    assert.match(String(infos[0][0]), /^Ran all 4 statements of payroll\.sql in \d+ ms; 1 query opened in the Data Viewer\.$/);
});

test('Execute File opens all its Data Viewers as tabs of one group beside the file', async (t) => {
    recordWindowCalls(t, 'showInformationMessage');
    const { fileSessions, opened } = createFileSessions();
    t.after(() => fileSessions.dispose());
    const queries = ['SELECT 1 AS a', 'SELECT 2 AS b', 'SELECT 3 AS c'];

    await fileSessions.executeFile(createEditor(queries.map((q) => `${q};`).join('\n'), 0) as any);

    assert.deepEqual(opened.map((o) => o.placement), [
        { viewColumn: vscodeStub.ViewColumn.Beside, preserveFocus: true },
        { viewColumn: 2, preserveFocus: true },
        { viewColumn: 2, preserveFocus: true }
    ], 'only the first one may open a new group; the file keeps the focus');
});

test('a SELECT handed over by Execute Selection opens like View Data and takes the focus', async (t) => {
    const { fileSessions, opened } = createFileSessions();
    t.after(() => fileSessions.dispose());

    await fileSessions.execute(selecting(FILE, SELECT) as any);

    assert.equal(opened[0].placement, undefined);
});

test('Execute File runs the whole file even when text is selected', async (t) => {
    recordWindowCalls(t, 'showInformationMessage');
    const { fileSessions, events } = createFileSessions();
    t.after(() => fileSessions.dispose());

    await fileSessions.executeFile(selecting(SCRIPT, UPDATE) as any);

    assert.equal(events.length, 4);
});

test('Execute File goes on only once the Data Viewer has loaded its first page', async (t) => {
    recordWindowCalls(t, 'showInformationMessage');
    const load = deferredLoad();
    const { fileSessions, events } = createFileSessions({ viewerLoad: () => load.promise });
    t.after(() => fileSessions.dispose());

    const running = fileSessions.executeFile(createEditor(SCRIPT, 0) as any);
    await settle();
    assert.deepEqual(events, [`run:${DO_BLOCK}`, `run:${UPDATE}`, `view:${SELECT}`],
        'the DELETE below must not change the data before the SELECT has shown it');

    load.resolve({ status: 'loaded' });
    await running;
    assert.deepEqual(events.at(-1), `run:${DELETE}`);
});

test('Execute File stops at the first statement that fails and points at the error', async (t) => {
    const errors = recordWindowCalls(t, 'showErrorMessage');
    const { fileSessions, events } = createFileSessions({
        onQuery: (_client, sql) => {
            if (sql === UPDATE) {
                throw Object.assign(new Error('column "done" does not exist'), { position: '35' });
            }
            return undefined;
        }
    });
    t.after(() => fileSessions.dispose());
    const editor = createEditor(SCRIPT, 0);

    await fileSessions.executeFile(editor as any);

    assert.deepEqual(events, [`run:${DO_BLOCK}`, `run:${UPDATE}`], 'nothing after the failed statement ran');
    assert.equal(errors[0][0],
        'Execute File stopped at statement 2 of 4 (line 12); the statement before it ran: column "done" does not exist');
    assert.equal((editor.selection as any).active.offset, SCRIPT.indexOf(UPDATE) + 34);
});

test('a query that fails in the Data Viewer stops Execute File at its statement', async (t) => {
    const errors = recordWindowCalls(t, 'showErrorMessage');
    const { fileSessions, events } = createFileSessions({
        viewerLoad: async () => ({ status: 'failed', error: 'relation "pks_ate_payroll.v_lohn" does not exist' })
    });
    t.after(() => fileSessions.dispose());
    const editor = createEditor(SCRIPT, 0);

    await fileSessions.executeFile(editor as any);

    assert.deepEqual(events, [`run:${DO_BLOCK}`, `run:${UPDATE}`, `view:${SELECT}`]);
    assert.equal(errors[0][0],
        'Execute File stopped at statement 3 of 4 (line 14), whose query failed in the Data Viewer; '
        + 'the 2 statements before it ran: relation "pks_ate_payroll.v_lohn" does not exist');
    assert.equal((editor.selection as any).active.offset, SCRIPT.indexOf(SELECT), 'the cursor goes to the failed statement');
});

test('cancelling Execute File while a Data Viewer loads runs nothing after it', async (t) => {
    const control = controllableCancel(t);
    const infos = recordWindowCalls(t, 'showInformationMessage');
    const load = deferredLoad();
    const { fileSessions, events } = createFileSessions({ viewerLoad: () => load.promise });
    t.after(() => fileSessions.dispose());

    const running = fileSessions.executeFile(createEditor(SCRIPT, 0) as any);
    await settle();
    control.cancel();
    await running;

    assert.deepEqual(events, [`run:${DO_BLOCK}`, `run:${UPDATE}`, `view:${SELECT}`]);
    assert.equal(infos[0][0], 'Execute File was cancelled after 3 of 4 statements; the rest did not run.');
});

test('cancelling Execute File during a statement cancels that statement and stops without an error', async (t) => {
    const control = controllableCancel(t);
    const infos = recordWindowCalls(t, 'showInformationMessage');
    const errors = recordWindowCalls(t, 'showErrorMessage');
    let release: () => void = () => undefined;
    const { fileSessions, events, poolQueries } = createFileSessions({
        onQuery: (_client, sql) => (sql === UPDATE
            ? new Promise<void>((resolve) => { release = resolve; }).then(() => { throw new Error('canceling statement due to user request'); })
            : undefined)
    });
    t.after(() => fileSessions.dispose());

    const running = fileSessions.executeFile(createEditor(SCRIPT, 0) as any);
    await settle();
    control.cancel();
    await settle();
    release();
    await running;

    assert.deepEqual(poolQueries, [{ sql: 'SELECT pg_cancel_backend($1)', params: [4711] }]);
    assert.deepEqual(events, [`run:${DO_BLOCK}`, `run:${UPDATE}`]);
    assert.deepEqual(errors, []);
    assert.equal(infos[0][0], 'Execute File was cancelled after 1 of 4 statements; the rest did not run.');
});

test('Execute File on a file without statements warns and runs nothing', async (t) => {
    const warnings = recordWindowCalls(t, 'showWarningMessage');
    const { fileSessions, events } = createFileSessions();
    t.after(() => fileSessions.dispose());

    await fileSessions.executeFile(createEditor('-- nothing here yet\n', 0) as any);
    await fileSessions.executeFile(undefined);

    assert.deepEqual(events, []);
    assert.deepEqual(warnings.map((w) => w[0]), ['The file holds no statement to execute.', 'Open the SQL file to execute.']);
});

test('the session of a file ends once no tab shows the file', async (t) => {
    recordWindowCalls(t, 'showInformationMessage');
    const { fileSessions, clients, manager } = createFileSessions();
    t.after(() => fileSessions.dispose());
    await fileSessions.execute(selecting(FILE, DO_BLOCK) as any);

    fireDidChangeTabs();
    assert.equal(clients[0].ended, false, 'the file is still open');

    showFile(false);
    fireDidChangeTabs();
    assert.equal(clients[0].ended, true);
    assert.equal(manager.get(`file:${URI}`), undefined);
});

test('the session of a closed file lives on while a Data Viewer opened from it uses it', async (t) => {
    recordWindowCalls(t, 'showInformationMessage');
    const { fileSessions, clients, manager } = createFileSessions();
    t.after(() => fileSessions.dispose());
    await fileSessions.execute(selecting(FILE, DO_BLOCK) as any);
    const ref = fileSessionRef({ toString: () => URI }, '/work/payroll.sql');
    manager.acquire(ref, 'panel:1');

    showFile(false);
    fireDidChangeTabs();
    assert.equal(clients[0].ended, false);

    manager.release(ref.key, 'panel:1');
    assert.equal(clients[0].ended, true);
});

test('Reset Database Session asks first and then throws the session of the file away', async (t) => {
    recordWindowCalls(t, 'showInformationMessage');
    const { fileSessions, clients } = createFileSessions();
    t.after(() => fileSessions.dispose());
    const editor = selecting(FILE, DO_BLOCK);
    await fileSessions.execute(editor as any);

    // Cancel first, confirm the second time.
    const answers: Array<string | undefined> = [undefined, 'Reset Session'];
    const asked = stubWarningMessage(t, () => answers.shift());
    await fileSessions.reset(editor as any);
    assert.equal(clients[0].ended, false, 'cancelled');

    await fileSessions.reset(editor as any);
    assert.equal(clients[0].ended, true);
    assert.equal(asked.length, 2);
    assert.equal(asked[0][0], 'Reset the database session of "payroll.sql"?');
});

test('Reset Database Session on a file without a session says there is nothing to reset', async (t) => {
    const infos = recordWindowCalls(t, 'showInformationMessage');
    const { fileSessions } = createFileSessions();
    t.after(() => fileSessions.dispose());

    await fileSessions.reset(createEditor(FILE, 0) as any);

    assert.match(String(infos[0][0]), /No database session is open for "payroll\.sql" yet/);
});
// ===== executeOnSession: a statement from a Data Viewer =====

const KILL = 'SELECT pg_terminate_backend(4242);';
const panelRef = { key: 'tab:7', label: 'Locks' };

test('executeOnSession runs the statement in the given session and names its single result', async (t) => {
    recordWindowCalls(t, 'showInformationMessage');
    const { fileSessions, manager, clients } = createFileSessions({
        onQuery: (_c, sql) => sql.startsWith('SELECT pg_terminate_backend')
            ? { command: 'SELECT', rowCount: 1, rows: [{ pg_terminate_backend: true }], fields: [{ name: 'pg_terminate_backend' }] }
            : undefined
    });
    t.after(() => fileSessions.dispose());
    const session = manager.acquire(panelRef, 'panel:7');

    const outcome = await fileSessions.executeOnSession(session, 'Locks', KILL);

    assert.equal(outcome.status, 'executed');
    assert.match((outcome as any).message, /^SELECT returned 1 row in \d+ ms\. Result: true\.$/);
    assert.deepEqual(clients[0].queries, [KILL]);
    assert.equal(session.isOpen, true, 'the session of the Data Viewer stays open');
});

test('executeOnSession records data changes in the Modify History and reports nothing itself', async (t) => {
    const infos = recordWindowCalls(t, 'showInformationMessage');
    const errors = recordWindowCalls(t, 'showErrorMessage');
    const { fileSessions, manager, history } = createFileSessions({
        onQuery: () => ({ command: 'UPDATE', rowCount: 3, rows: [], fields: [] })
    });
    t.after(() => fileSessions.dispose());

    const outcome = await fileSessions.executeOnSession(manager.acquire(panelRef, 'panel:7'), 'Locks', 'UPDATE jobs SET done = true');

    assert.deepEqual(outcome, { status: 'executed', message: (outcome as any).message });
    assert.match((outcome as any).message, /^UPDATE affected 3 rows in \d+ ms\.$/);
    assert.deepEqual(history, [{ sql: 'UPDATE jobs SET done = true' }]);
    assert.equal(infos.length + errors.length, 0, 'the caller reports the outcome');
});

test('executeOnSession returns a failure with its context and logs the details of the server', async (t) => {
    const errors = recordWindowCalls(t, 'showErrorMessage');
    const { fileSessions, manager, channel } = createFileSessions({
        onQuery: () => {
            throw Object.assign(new Error('must be a superuser to terminate superuser process'), { hint: 'Ask an admin.', where: 'SQL statement "x"\nline 2' });
        }
    });
    t.after(() => fileSessions.dispose());

    const outcome = await fileSessions.executeOnSession(manager.acquire(panelRef, 'panel:7'), 'Locks', KILL);

    assert.deepEqual(outcome, { status: 'failed', message: 'must be a superuser to terminate superuser process (SQL statement "x")' });
    assert.match(channel.lines.join('\n'), /Locks — ERROR: must be a superuser[\s\S]*HINT: Ask an admin\./);
    assert.equal(errors.length, 0);
});

test('executeOnSession runs nothing when Cancel was pressed before the statement got its turn', async (t) => {
    const control = controllableCancel(t);
    let release: () => void = () => undefined;
    const { fileSessions, manager, clients } = createFileSessions({
        onQuery: (_c, sql) => sql === 'SELECT pg_sleep(10)' ? new Promise((resolve) => { release = () => resolve(undefined); }) : undefined
    });
    t.after(() => fileSessions.dispose());
    const session = manager.acquire(panelRef, 'panel:7');
    const busy = session.query('SELECT pg_sleep(10)');
    await tick();

    const pending = fileSessions.executeOnSession(session, 'Locks', KILL);
    await tick();
    control.cancel();
    release();
    await busy;

    assert.deepEqual(await pending, { status: 'cancelled' });
    assert.deepEqual(clients[0].queries, ['SELECT pg_sleep(10)']);
});

test('resultValueText names the single value of a single statement and nothing else', () => {
    const one = (value: unknown) => [{ rows: [{ v: value }], fields: [{ name: 'v' }] }];
    assert.equal(resultValueText(one(true)), 'true');
    assert.equal(resultValueText(one(null)), 'NULL');
    assert.equal(resultValueText(one({ a: 1 })), '{"a":1}');
    assert.equal(resultValueText(one('x'.repeat(300))), 'x'.repeat(200) + '…');
    assert.equal(resultValueText([{ rows: [{ a: 1 }, { a: 2 }], fields: [{ name: 'a' }] }]), undefined);
    assert.equal(resultValueText([{ rows: [{ a: 1, b: 2 }], fields: [{ name: 'a' }, { name: 'b' }] }]), undefined);
    assert.equal(resultValueText([{ rows: [], fields: [] }]), undefined);
    assert.equal(resultValueText([...one(1), ...one(2)]), undefined);
});

test('statementErrorText adds the first line of the context of an error', () => {
    assert.equal(statementErrorText(new Error('boom')), 'boom');
    assert.equal(statementErrorText(Object.assign(new Error('boom'), { where: 'PL/pgSQL function f() line 3\nmore' })), 'boom (PL/pgSQL function f() line 3)');
});

// ===== -- @export instructions =====

/** A SQL file saved in a fresh folder, which is removed after the test. */
function savedFile(t: { after(fn: () => void): void }, editor: ReturnType<typeof createEditor>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgqb-export-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    (editor.document as any).fileName = path.join(dir, 'payroll.sql');
    return { editor, dir };
}

/** An exporter that records what it is asked to do instead of writing files. */
function fakeExporter(options: { choice?: any; saved?: Record<string, any> } = {}) {
    return {
        written: [] as Array<{ rows: any[]; columns: any[]; options: any }>,
        dialogs: [] as any[],
        savedDefaults(format: string) { return options.saved?.[format]; },
        async chooseSettings(request: any) { this.dialogs.push(request); return options.choice; },
        async write(rows: any[], columns: any[], opts: any) { this.written.push({ rows, columns, options: opts }); }
    };
}

const ORDERS = 'SELECT id, name FROM orders';
const ORDERS_RESULT = {
    command: 'SELECT', rowCount: 2,
    rows: [[1, 'Alice'], [2, 'Bob']],
    fields: [{ name: 'id', dataTypeID: 23 }, { name: 'name', dataTypeID: 25 }]
};
const exportingSessions = (exporter: any, onQuery?: (c: FakeClient, sql: string) => unknown) => createFileSessions({
    exporter,
    onQuery: onQuery ?? ((_c, sql) => sql === ORDERS ? ORDERS_RESULT : undefined),
    poolQuery: async (sql) => sql.includes('pg_type') ? { rows: [{ oid: 23, typname: 'int4' }, { oid: 25, typname: 'text' }] } : { rows: [] }
});

const EXPORT_SCRIPT = [
    `${DO_BLOCK};`,
    '-- @export csv file=exports/{file}.csv separator=;',
    `${ORDERS};`,
    'SELECT * FROM customers;'
].join('\n');
/** 0-based line of the instruction in EXPORT_SCRIPT, right below the DO block. */
const EXPORT_LINE = DO_BLOCK.split('\n').length;

test('Execute File writes a query under an @export instruction to its file instead of showing it', async (t) => {
    const infos = recordWindowCalls(t, 'showInformationMessage');
    const exporter = fakeExporter({ saved: { csv: { csvLineEnding: 'lf', csvSeparator: '|' } } });
    const { fileSessions, clients, opened, channel, events } = exportingSessions(exporter);
    t.after(() => fileSessions.dispose());
    const { editor, dir } = savedFile(t, createEditor(EXPORT_SCRIPT, 0));

    await fileSessions.executeFile(editor as any);

    assert.deepEqual(events, [`run:${DO_BLOCK}`, `run:${ORDERS}`, 'view:SELECT * FROM customers']);
    assert.deepEqual(opened.map((o) => o.sql), ['SELECT * FROM customers'], 'only the query without instruction is shown');
    assert.deepEqual(clients[0].configs[1], { text: ORDERS, rowMode: 'array' });
    const target = path.join(dir, 'exports', 'payroll.csv');
    assert.deepEqual(exporter.written, [{
        rows: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
        columns: [{ name: 'id', dataType: 'int4' }, { name: 'name', dataType: 'text' }],
        // The instruction outranks the saved defaults, which outrank the dialog's presets.
        options: { format: 'csv', csvSeparator: ';', csvIncludeHeaders: true, csvQuoteStrings: true, csvLineEnding: 'lf', filePath: target }
    }]);
    assert.ok(channel.lines.some((l) => l.endsWith(`payroll.sql — EXPORT: line ${EXPORT_LINE + 2}, 2 rows to ${target}`)), 'named by the line of the query');
    assert.equal(infos[0][0].replace(/\d+ ms/, 'N ms'),
        `Ran all 3 statements of payroll.sql in N ms; 1 query opened in the Data Viewer; 2 rows exported to ${target}.`);
});

test('an existing export file is only overwritten after asking, and declining cancels the run', async (t) => {
    const infos = recordWindowCalls(t, 'showInformationMessage');
    const answers: Array<string | undefined> = [undefined, 'Overwrite'];
    const asked = stubWarningMessage(t, () => answers.shift());
    const exporter = fakeExporter();
    const { fileSessions, opened } = exportingSessions(exporter);
    t.after(() => fileSessions.dispose());
    const { editor, dir } = savedFile(t, createEditor(EXPORT_SCRIPT, 0));
    fs.mkdirSync(path.join(dir, 'exports'));
    fs.writeFileSync(path.join(dir, 'exports', 'payroll.csv'), 'old', 'utf8');

    await fileSessions.executeFile(editor as any);
    assert.equal(asked[0][0], `"payroll.csv" already exists in ${path.join(dir, 'exports')}. Overwrite it?`);
    assert.equal(exporter.written.length, 0);
    assert.equal(opened.length, 0, 'nothing after the export ran');
    assert.equal(infos[0][0], 'Execute File was cancelled after 1 of 3 statements; the rest did not run.');

    await fileSessions.executeFile(editor as any);
    assert.equal(exporter.written.length, 1);
    assert.equal(opened.length, 1);
});

test('without file= a save dialog asks where the export goes, and its Cancel cancels the run', async (t) => {
    const infos = recordWindowCalls(t, 'showInformationMessage');
    const answers: Array<{ fsPath: string } | undefined> = [];
    const saves = recordWindowCalls(t, 'showSaveDialog', () => Promise.resolve(answers.shift()));
    const exporter = fakeExporter();
    const { fileSessions, clients } = exportingSessions(exporter);
    t.after(() => fileSessions.dispose());
    const { editor, dir } = savedFile(t, createEditor(`-- @export json pretty=false\n${ORDERS};`, 0));

    answers.push({ fsPath: path.join(dir, 'chosen.json') });
    await fileSessions.executeFile(editor as any);
    assert.equal(saves[0][0].defaultUri.fsPath, path.join(dir, 'payroll_line2.json'), 'named by the line of the query');
    assert.deepEqual(saves[0][0].filters, { 'JSON Files': ['json'] });
    assert.deepEqual(exporter.written[0].options, { format: 'json', jsonPretty: false, jsonArrayWrapper: true, filePath: path.join(dir, 'chosen.json') });

    answers.push(undefined);
    await fileSessions.executeFile(editor as any);
    assert.equal(exporter.written.length, 1);
    assert.equal(clients[0].queries.length, 1, 'the query does not run for a cancelled export');
    assert.equal(infos[1][0], 'Execute File was cancelled after 0 of 1 statements; the rest did not run.');
});

test('dialog opens the export dialog prefilled from the instruction, and exports what it chose', async (t) => {
    recordWindowCalls(t, 'showInformationMessage');
    const exporter = fakeExporter();
    const { fileSessions } = exportingSessions(exporter);
    t.after(() => fileSessions.dispose());
    const { editor, dir } = savedFile(t, createEditor(`-- @export excel dialog file=out/{file} sheet=Orders\n${ORDERS};`, 0));
    (exporter as any).chooseSettings = async function (request: any) {
        this.dialogs.push(request);
        return { settings: { format: 'excel', excelSheetName: 'Open', excelIncludeHeaders: true }, fileName: 'orders.xlsx', folder: dir };
    };
    const saves = recordWindowCalls(t, 'showSaveDialog', (options: any) => Promise.resolve({ fsPath: options.defaultUri.fsPath }));

    await fileSessions.executeFile(editor as any);

    assert.deepEqual(exporter.dialogs, [{
        title: 'Export: line 2 of payroll.sql',
        format: 'excel',
        fileName: 'payroll.xlsx',
        folder: path.join(dir, 'out'),
        options: { excelSheetName: 'Orders' },
        sql: ORDERS,
        sessionRef: { key: `file:${URI}`, label: 'payroll.sql' }
    }]);
    assert.equal(saves[0][0].defaultUri.fsPath, path.join(dir, 'orders.xlsx'), 'the save dialog has the last word, as in the Data Viewer');
    assert.deepEqual(exporter.written[0].options, {
        format: 'excel', excelSheetName: 'Open', excelIncludeHeaders: true, excelSqlStatement: ORDERS, filePath: path.join(dir, 'orders.xlsx')
    });
});

test('Cancel in the export dialog stops the run before its query runs', async (t) => {
    const infos = recordWindowCalls(t, 'showInformationMessage');
    const exporter = fakeExporter({ choice: undefined });
    const { fileSessions, clients, opened } = exportingSessions(exporter);
    t.after(() => fileSessions.dispose());
    const { editor } = savedFile(t, createEditor(EXPORT_SCRIPT.replace('csv file=', 'csv dialog file='), 0));

    await fileSessions.executeFile(editor as any);

    assert.equal(exporter.dialogs.length, 1);
    assert.deepEqual(clients[0].queries, [DO_BLOCK]);
    assert.equal(opened.length, 0);
    assert.equal(infos[0][0], 'Execute File was cancelled after 1 of 3 statements; the rest did not run.');
});

test('a wrong instruction stops Execute File before anything runs and shows its line', async (t) => {
    const errors = recordWindowCalls(t, 'showErrorMessage');
    const exporter = fakeExporter();
    const { fileSessions, clients } = exportingSessions(exporter);
    t.after(() => fileSessions.dispose());
    const editor = createEditor(`${DO_BLOCK};\n-- @export cvs\nSELECT 1;\n-- @export csv file=o_{month}.csv\nSELECT 2;`, 0);

    await fileSessions.executeFile(editor as any);

    assert.equal(clients.length, 0, 'not even the session was opened');
    assert.equal(errors[0][0], `Execute File did not start, nothing ran. The @export instruction on line ${EXPORT_LINE + 1}: `
        + '"cvs" is neither a format (csv, excel, json, xml, insert) nor dialog. (1 more instruction is wrong as well)');
    assert.equal((editor.selection as any).start.line, EXPORT_LINE);
    assert.equal(editor.revealed.length, 1);
});

test('an export whose query fails stops the run at that statement', async (t) => {
    const errors = recordWindowCalls(t, 'showErrorMessage');
    const exporter = fakeExporter();
    const { fileSessions, opened } = exportingSessions(exporter, (_c, sql) => {
        if (sql === ORDERS) throw new Error('relation "orders" does not exist');
        return undefined;
    });
    t.after(() => fileSessions.dispose());
    const { editor } = savedFile(t, createEditor(EXPORT_SCRIPT, 0));

    await fileSessions.executeFile(editor as any);

    assert.equal(exporter.written.length, 0);
    assert.equal(opened.length, 0);
    assert.equal(errors[0][0], `Execute File stopped at statement 2 of 3 (line ${EXPORT_LINE + 2}); the statement before it ran: relation "orders" does not exist`);
});

test('Execute Selection exports a selected query whose instruction stands above the selection', async (t) => {
    const infos = recordWindowCalls(t, 'showInformationMessage');
    const exporter = fakeExporter();
    const { fileSessions, opened } = exportingSessions(exporter);
    t.after(() => fileSessions.dispose());
    const text = `SELECT 0;\n\n-- @export csv file=selected.csv\n${ORDERS};\nSELECT 2;`;
    const { editor, dir } = savedFile(t, selecting(text, ORDERS));

    await fileSessions.execute(editor as any);

    assert.equal(opened.length, 0, 'the query is exported, not shown');
    assert.equal(exporter.written[0].options.filePath, path.join(dir, 'selected.csv'));
    assert.equal(infos[0][0].replace(/\d+ ms/, 'N ms'),
        `Ran the statement of the selection in payroll.sql in N ms; 2 rows exported to ${path.join(dir, 'selected.csv')}.`);
});

test('Execute Selection over several statements with an instruction runs them one by one', async (t) => {
    recordWindowCalls(t, 'showInformationMessage');
    const exporter = fakeExporter();
    const { fileSessions, clients } = exportingSessions(exporter);
    t.after(() => fileSessions.dispose());
    const text = `${DO_BLOCK};\n-- @export csv file=selected.csv\n${ORDERS};`;
    const { editor } = savedFile(t, selecting(text, text));

    await fileSessions.execute(editor as any);

    assert.deepEqual(clients[0].queries, [DO_BLOCK, ORDERS], 'not as one batch');
    assert.equal(exporter.written.length, 1);
});

test('a selection without an instruction still runs as one batch', async (t) => {
    recordWindowCalls(t, 'showInformationMessage');
    const { fileSessions, clients } = exportingSessions(fakeExporter());
    t.after(() => fileSessions.dispose());
    const text = `${DO_BLOCK};\nUPDATE jobs SET done = true;`;

    await fileSessions.execute(selecting(text, text) as any);

    assert.deepEqual(clients[0].queries, [text]);
});

test('summarizeFileRun names a single export and points to the messages for several', () => {
    assert.equal(summarizeFileRun('payroll.sql', 2, 0, 12, [{ rows: 1, path: 'C:\\o.csv' }]), 'Ran all 2 statements of payroll.sql in 12 ms; 1 row exported to C:\\o.csv.');
    assert.equal(
        summarizeFileRun('payroll.sql', 3, 1, 12, [{ rows: 1, path: 'a' }, { rows: 2, path: 'b' }]),
        'Ran all 3 statements of payroll.sql in 12 ms; 1 query opened in the Data Viewer; 2 queries exported, listed in the "PostgreSQL Messages" output.'
    );
});
