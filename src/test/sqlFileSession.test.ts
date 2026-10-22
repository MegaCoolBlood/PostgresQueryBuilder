import './helpers/vscodeMock';
import { vscodeStub, fireDidChangeTabs, stubWarningMessage } from './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
    tabShowsUri,
    MESSAGES_CHANNEL_NAME
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
    ended = false;
    constructor(readonly processID: number, private readonly onQuery?: (client: FakeClient, sql: string) => unknown) {
        super();
    }
    async query(textOrConfig: string | { text: string }): Promise<any> {
        const sql = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text;
        this.queries.push(sql);
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
        positionAt: (offset: number) => ({ offset })
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
function recordWindowCalls(t: { after(fn: () => void): void }, name: 'showInformationMessage' | 'showErrorMessage' | 'showWarningMessage' | 'withProgress', impl?: (...args: any[]) => any): any[][] {
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
} = {}) {
    const clients: FakeClient[] = [];
    const manager = new DbSessionManager({
        openClient: async () => {
            const client = new FakeClient(4711 + clients.length, options.onQuery);
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
    const opened: Array<{ sql: string; title: string; ref: any }> = [];
    const connectionManager: any = {
        ensureConnected: async () => options.connected !== false,
        query: async (sql: string, params?: unknown[]) => {
            poolQueries.push({ sql, params });
            return options.poolQuery ? options.poolQuery(sql, params) : { rows: [] };
        }
    };
    const modifyHistoryStore: any = { addMany: (entries: Array<{ sql: string }>) => history.push(...entries) };
    const openQueryView = async (sql: string, title: string, ref: any) => { opened.push({ sql, title, ref }); };
    const fileSessions = new SqlFileSessions(manager, connectionManager, channel as any, modifyHistoryStore, openQueryView);
    showFile(true);
    return { manager, clients, channel, history, poolQueries, opened, fileSessions };
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