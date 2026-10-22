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
    splitStatements,
    statementRangeAt,
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

// ===== statementRangeAt / statementToExecute =====

function statementAt(text: string, offset: number): string | null {
    const range = statementRangeAt(text, offset);
    return range ? text.slice(range.start, range.end) : null;
}

test('the cursor anywhere in a DO block means the whole block, semicolons inside included', () => {
    assert.equal(statementAt(FILE, FILE.indexOf('CALL')), DO_BLOCK);
    assert.equal(statementAt(FILE, FILE.indexOf('DECLARE')), DO_BLOCK);
    assert.equal(statementAt(FILE, 0), DO_BLOCK);
});

test('the cursor at the end of a line behind a semicolon means that statement', () => {
    assert.equal(statementAt(FILE, FILE.indexOf('END $$;') + 'END $$;'.length), DO_BLOCK);
    assert.equal(statementAt('SELECT 1;   -- done\nSELECT 2;', 'SELECT 1;'.length), 'SELECT 1');
});

test('the cursor right before the next statement on the same line means that next statement', () => {
    assert.equal(statementAt('SELECT 1; SELECT 2;', 'SELECT 1; '.length), 'SELECT 2');
});

test('the cursor inside a statement spanning several lines means all of it', () => {
    assert.equal(statementAt(FILE, FILE.indexOf('UNION ALL')), SET_CONFIG);
    assert.equal(statementAt(FILE, FILE.indexOf('v_lohn')), SELECT);
});

test('the cursor in the blank space after the last statement means the last statement', () => {
    assert.equal(statementAt(FILE, FILE.length), SELECT);
});

test('semicolons in strings, quoted names and comments do not end a statement', () => {
    const text = "SELECT 'a;b' AS \"x;y\" /* c;d */, 2 -- e;f\nFROM t;\nSELECT 3;";
    assert.equal(statementAt(text, 3), "SELECT 'a;b' AS \"x;y\" /* c;d */, 2 -- e;f\nFROM t");
});

test('comments in front of a statement are not part of it', () => {
    assert.equal(statementAt('-- set up the period\nSELECT 1;', 3), 'SELECT 1');
});

test('an escaped quote in an E string does not end the string', () => {
    const text = "SELECT E'it\\'s; fine' AS x;\nSELECT 2;";
    assert.equal(statementAt(text, 3), "SELECT E'it\\'s; fine' AS x");
});

test('a file without a statement has none at the cursor', () => {
    assert.equal(statementAt('', 0), null);
    assert.equal(statementAt('  -- only a comment\n', 5), null);
});

test('a selection is executed exactly as selected', () => {
    const start = FILE.indexOf(SET_CONFIG);
    assert.deepEqual(
        statementToExecute(FILE, start, start + SET_CONFIG.length),
        { sql: SET_CONFIG, start }
    );
});

test('a selection of blanks and comments executes nothing', () => {
    assert.equal(statementToExecute('  -- x\n  ', 0, 9), null);
});

test('without a selection the statement under the cursor is executed', () => {
    const offset = FILE.indexOf('CALL');
    assert.deepEqual(statementToExecute(FILE, offset, offset), { sql: DO_BLOCK, start: 0 });
});

test('splitStatements keeps a DO block together', () => {
    assert.deepEqual(splitStatements(FILE), [DO_BLOCK, SET_CONFIG, SELECT]);
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

function createFileSessions(options: { onQuery?: (client: FakeClient, sql: string) => unknown; connected?: boolean } = {}) {
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
    const connectionManager: any = {
        ensureConnected: async () => options.connected !== false,
        query: async (sql: string, params?: unknown[]) => { poolQueries.push({ sql, params }); return { rows: [] }; }
    };
    const modifyHistoryStore: any = { addMany: (entries: Array<{ sql: string }>) => history.push(...entries) };
    const fileSessions = new SqlFileSessions(manager, connectionManager, channel as any, modifyHistoryStore);
    showFile(true);
    return { manager, clients, channel, history, poolQueries, fileSessions };
}

test('Execute Statement runs the DO block under the cursor in the session of the file', async (t) => {
    const infos = recordWindowCalls(t, 'showInformationMessage');
    const { fileSessions, clients, manager } = createFileSessions();
    t.after(() => fileSessions.dispose());

    await fileSessions.execute(createEditor(FILE, FILE.indexOf('CALL')) as any);

    assert.equal(clients.length, 1);
    assert.deepEqual(clients[0].queries, [DO_BLOCK]);
    assert.match(String(infos[0][0]), /^DO completed in \d+ ms\.$/);
    const session = manager.get(`file:${URI}`);
    assert.ok(session && session.isOpen, 'the file keeps its session open');
});

test('every statement of a file runs on the same connection, so a setting stays visible', async (t) => {
    recordWindowCalls(t, 'showInformationMessage');
    const { fileSessions, clients, manager } = createFileSessions();
    t.after(() => fileSessions.dispose());

    await fileSessions.execute(createEditor(FILE, FILE.indexOf('CALL')) as any);
    await fileSessions.execute(createEditor(FILE, FILE.indexOf('UNION ALL')) as any);
    // A Data Viewer opened from the file with "View Data" uses the same session.
    const { ref } = fileSessions.acquire(createDocument(FILE) as any);
    await manager.acquire(ref, 'panel:1').query(SELECT);

    assert.equal(clients.length, 1);
    assert.deepEqual(clients[0].queries, [DO_BLOCK, SET_CONFIG, SELECT]);
});

test('Execute Statement counts the messages of the server and shows them', async (t) => {
    const infos = recordWindowCalls(t, 'showInformationMessage');
    const { fileSessions, channel } = createFileSessions({
        onQuery: (client) => { client.emit('notice', { severity: 'NOTICE', message: 'period set' }); }
    });
    t.after(() => fileSessions.dispose());

    await fileSessions.execute(createEditor(FILE, FILE.indexOf('CALL')) as any);

    assert.match(String(infos[0][0]), /The server sent 1 message, shown in the "PostgreSQL Messages" output\./);
    assert.equal(channel.shown, 1);
    assert.equal(MESSAGES_CHANNEL_NAME, 'PostgreSQL Messages');
});

test('a statement that fails puts the cursor where the server saw the error', async (t) => {
    const errors = recordWindowCalls(t, 'showErrorMessage');
    const { fileSessions, channel } = createFileSessions({
        onQuery: () => {
            throw Object.assign(new Error('syntax error at or near "SELEC"'), { position: '10', hint: 'check the spelling' });
        }
    });
    t.after(() => fileSessions.dispose());
    const text = 'SELECT 1;\n\nDO $$ BEGIN SELEC 1; END $$;';
    const editor = createEditor(text, text.indexOf('BEGIN'));

    await fileSessions.execute(editor as any);

    assert.equal(errors[0][0], 'Execute Statement failed: syntax error at or near "SELEC"');
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

test('Execute Statement without a statement at the cursor warns and runs nothing', async (t) => {
    const warnings = recordWindowCalls(t, 'showWarningMessage');
    const { fileSessions, clients } = createFileSessions();
    t.after(() => fileSessions.dispose());

    await fileSessions.execute(createEditor('-- nothing to run\n', 3) as any);
    await fileSessions.execute(undefined);

    assert.equal(clients.length, 0);
    assert.equal(warnings.length, 2);
});

test('Execute Statement runs nothing when no connection is chosen', async (t) => {
    const { fileSessions, clients } = createFileSessions({ connected: false });
    t.after(() => fileSessions.dispose());

    await fileSessions.execute(createEditor(FILE, 0) as any);

    assert.equal(clients.length, 0);
});

test('cancelling Execute Statement asks the server to cancel the session process', async (t) => {
    let cancel: () => void = () => undefined;
    recordWindowCalls(t, 'withProgress', (_options: any, task: any) => task(
        { report() {} },
        { isCancellationRequested: false, onCancellationRequested: (listener: () => void) => { cancel = listener; return { dispose() {} }; } }
    ));
    recordWindowCalls(t, 'showErrorMessage');
    let release: () => void = () => undefined;
    const { fileSessions, poolQueries } = createFileSessions({
        onQuery: () => new Promise<void>((resolve) => { release = resolve; }).then(() => {
            throw new Error('canceling statement due to user request');
        })
    });
    t.after(() => fileSessions.dispose());

    const running = fileSessions.execute(createEditor('SELECT pg_sleep(60);', 0) as any);
    await new Promise((resolve) => setImmediate(resolve));
    cancel();
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await running;

    assert.deepEqual(poolQueries, [{ sql: 'SELECT pg_cancel_backend($1)', params: [4711] }]);
});

test('the session of a file ends once no tab shows the file', async (t) => {
    recordWindowCalls(t, 'showInformationMessage');
    const { fileSessions, clients, manager } = createFileSessions();
    t.after(() => fileSessions.dispose());
    await fileSessions.execute(createEditor(FILE, 0) as any);

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
    await fileSessions.execute(createEditor(FILE, 0) as any);
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
    const editor = createEditor(FILE, 0);
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
