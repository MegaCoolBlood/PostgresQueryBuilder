import './helpers/vscodeMock';
import { vscodeStub, fireDidChangeConfiguration } from './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    MESSAGES_VIEW_ID,
    MAX_COPY_BYTES,
    MAX_KEPT_TEXT,
    MessageSpool,
    SessionMessageLog,
    SessionMessagesView,
    byteSizeText,
    exportMessage,
    formatSessionMessage,
    keptText,
    messageTone,
    messagesCountText,
    messagesFileName,
    messagesUpdate,
    messagesViewState,
    errorsCountText,
    noticeMessage,
    elapsedText,
    runTimeText,
    statementStartedMessage,
    timerText,
    TIMER_TEXT_JS
} from '../sessionMessages';

const AT = new Date(2026, 10, 3, 9, 5, 7);
const ROOT = path.join(__dirname, '..', '..', '..');
const FILE = { key: 'file:file:///work/payroll.sql', label: 'payroll.sql' };
const TAB = { key: 'tab:3', label: 'View Data: SELECT 1' };

// ===== noticeMessage / exportMessage / formatSessionMessage =====

test('a server message keeps its detail, hint and context as lines of their own', () => {
    const message = noticeMessage('payroll.sql', { severity: 'WARNING', message: 'period open', detail: 'd', hint: 'h', where: 'line 1\nline 2' }, AT);
    assert.deepEqual(message, {
        time: '09:05:07',
        source: 'payroll.sql',
        severity: 'WARNING',
        text: 'period open',
        details: ['DETAIL: d', 'HINT: h', 'CONTEXT: line 1\n         line 2']
    });
    assert.equal(
        formatSessionMessage(message),
        '[09:05:07] payroll.sql — WARNING: period open\n    DETAIL: d\n    HINT: h\n    CONTEXT: line 1\n             line 2'
    );
    assert.equal(noticeMessage('x', {}, AT).severity, 'NOTICE', 'a message without severity is a notice');
});

test('an export is listed with its line, its rows and its file', () => {
    assert.equal(
        formatSessionMessage(exportMessage('payroll.sql', 11, 1234, 'C:\\exports\\orders.csv', AT)),
        '[09:05:07] payroll.sql — EXPORT: line 12, 1234 rows to C:\\exports\\orders.csv'
    );
    assert.match(exportMessage('payroll.sql', 0, 1, 'o.csv', AT).text, /^line 1, 1 row to o\.csv$/);
});

test('messageTone colours errors, warnings and exports apart from notices', () => {
    assert.equal(messageTone('ERROR'), 'danger');
    assert.equal(messageTone('FATAL'), 'danger');
    assert.equal(messageTone('WARNING'), 'warning');
    assert.equal(messageTone('EXPORT'), 'success');
    assert.equal(messageTone('NOTICE'), 'info');
    assert.equal(messageTone('INFO'), 'info');
});

// ===== SessionMessageLog =====

test('every session has a log of its own', () => {
    const log = new SessionMessageLog();
    log.append(FILE, noticeMessage('payroll.sql', { message: 'a' }, AT));
    log.append(TAB, noticeMessage('tab', { message: 'b' }, AT));
    log.append(FILE, noticeMessage('payroll.sql', { message: 'c' }, AT));

    assert.deepEqual(log.get(FILE.key)?.messages.map((m) => m.text), ['a', 'c']);
    assert.deepEqual(log.get(TAB.key)?.messages.map((m) => m.text), ['b']);
    assert.equal(log.get(FILE.key)?.label, 'payroll.sql');
    assert.equal(log.get('tab:99'), undefined);
});

test('the tabs sharing a session write into the same log', () => {
    const log = new SessionMessageLog();
    // A Data Viewer opened from the file runs on the file's session, so its ref is the file's.
    log.append(FILE, noticeMessage('payroll.sql', { message: 'from the file' }, AT));
    log.append({ ...FILE }, noticeMessage('Locks', { message: 'from the viewer' }, AT));
    assert.deepEqual(log.get(FILE.key)?.messages.map((m) => m.text), ['from the file', 'from the viewer']);
});

test('a log keeps only its newest messages for the panel, but counts them all', () => {
    const log = new SessionMessageLog({ limit: 3 });
    for (const text of ['1', '2', '3', '4', '5']) {
        log.append(FILE, noticeMessage('f', { message: text }, AT));
    }
    assert.deepEqual(log.get(FILE.key)?.messages.map((m) => m.text), ['3', '4', '5']);
    assert.equal(log.get(FILE.key)?.total, 5);
});

test('clearing empties one log and discarding forgets it, each telling only about that session', () => {
    const log = new SessionMessageLog();
    const changed: string[] = [];
    log.append(FILE, noticeMessage('f', { message: 'a' }, AT));
    log.append(TAB, noticeMessage('t', { message: 'b' }, AT));
    const sub = log.onDidChange((key) => changed.push(key));

    log.clear(FILE.key);
    assert.deepEqual(log.get(FILE.key)?.messages, []);
    assert.equal(log.get(TAB.key)?.messages.length, 1);
    log.clear(FILE.key);
    log.discard(TAB.key);
    log.discard(TAB.key);
    assert.equal(log.get(TAB.key), undefined);
    assert.deepEqual(changed, [FILE.key, TAB.key], 'nothing is announced when nothing changed');

    sub.dispose();
    log.append(FILE, noticeMessage('f', { message: 'c' }, AT));
    assert.equal(changed.length, 2);
});

// ===== messagesViewState =====

test('the panel is told the session it shows and the tone of each message', () => {
    const log = new SessionMessageLog();
    log.append(FILE, noticeMessage('payroll.sql', { severity: 'ERROR', message: 'boom' }, AT));
    const state = messagesViewState(FILE, log.get(FILE.key));
    assert.equal(state.label, 'payroll.sql');
    assert.equal(state.messages[0].tone, 'danger');
    assert.equal(state.countText, '1 message');
    assert.deepEqual(messagesViewState(TAB, undefined), { label: 'View Data: SELECT 1', messages: [], total: 0, countText: '0 messages', errorsText: '', running: [] });
    assert.deepEqual(messagesViewState(undefined, undefined), { label: null, messages: [], total: 0, countText: '', errorsText: '', running: [] });
    assert.equal(state.errorsText, '1 error');
});

test('a log counts its errors, also those the panel no longer keeps, until it is cleared', () => {
    const log = new SessionMessageLog({ limit: 2 });
    log.append(FILE, noticeMessage('f', { severity: 'ERROR', message: 'e1' }, AT));
    log.append(FILE, noticeMessage('f', { severity: 'WARNING', message: 'w' }, AT));
    log.append(FILE, noticeMessage('f', { severity: 'FATAL', message: 'e2' }, AT));
    log.append(FILE, noticeMessage('f', { message: 'n' }, AT));
    assert.equal(log.get(FILE.key)?.errors, 2);
    assert.equal(messagesViewState(FILE, log.get(FILE.key)).errorsText, '2 errors');
    log.clear(FILE.key);
    assert.equal(log.get(FILE.key)?.errors, 0);
    assert.equal(messagesViewState(FILE, log.get(FILE.key)).errorsText, '');
});

test('errorsCountText names the errors only when there are some', () => {
    assert.equal(errorsCountText(0), '');
    assert.equal(errorsCountText(1), '1 error');
    assert.equal(errorsCountText(12), '12 errors');
});

test('the count tells when the panel no longer shows every message', () => {
    assert.equal(messagesCountText(12, 12), '12 messages');
    assert.equal(messagesCountText(2000, 5234), 'last 2000 of 5234 messages');
    const log = new SessionMessageLog({ limit: 2 });
    for (const text of ['1', '2', '3']) log.append(FILE, noticeMessage('f', { message: text }, AT));
    assert.equal(messagesViewState(FILE, log.get(FILE.key)).countText, 'last 2 of 3 messages');
});

// ===== messagesFileName =====

test('Save suggests a file named after the session and the day', () => {
    assert.equal(messagesFileName('payroll.sql', AT), 'payroll-messages-2026-11-03.log');
    assert.equal(messagesFileName('View Data: SELECT * FROM a', AT), 'View_Data_SELECT_FROM_a-messages-2026-11-03.log');
    assert.equal(messagesFileName('???', AT), 'session-messages-2026-11-03.log');
});

// ===== saving every message =====

function tempRoot(t: { after(fn: () => void): void }): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pqb-msg-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('Save writes every message of the session, also those the panel no longer keeps', async (t) => {
    const root = tempRoot(t);
    const log = new SessionMessageLog({ limit: 2, spoolRoot: root });
    t.after(() => log.dispose());
    for (let i = 1; i <= 5; i++) {
        log.append(FILE, noticeMessage('payroll.sql', { message: `step ${i}`, hint: i === 5 ? 'last' : undefined }, AT));
    }
    log.append(TAB, noticeMessage('tab', { message: 'another session' }, AT));
    const target = path.join(root, 'saved.log');

    const count = await log.saveTo(FILE.key, target);

    assert.equal(count, 5);
    assert.equal(log.get(FILE.key)?.messages.length, 2);
    assert.equal(fs.readFileSync(target, 'utf8'), [1, 2, 3, 4].map((i) => `[09:05:07] payroll.sql — NOTICE: step ${i}\n`).join('')
        + '[09:05:07] payroll.sql — NOTICE: step 5\n    HINT: last\n');
});

test('Save after Clear writes only what came after it', async (t) => {
    const root = tempRoot(t);
    const log = new SessionMessageLog({ limit: 2, spoolRoot: root });
    t.after(() => log.dispose());
    for (let i = 1; i <= 3; i++) log.append(FILE, noticeMessage('f', { message: `old ${i}` }, AT));
    log.clear(FILE.key);
    log.append(FILE, noticeMessage('f', { message: 'new' }, AT));
    const target = path.join(root, 'saved.log');

    assert.equal(await log.saveTo(FILE.key, target), 1);
    assert.equal(fs.readFileSync(target, 'utf8'), '[09:05:07] f — NOTICE: new\n');
});

test('the spool file of a session is deleted with its log, and the folder with the extension', async (t) => {
    const root = tempRoot(t);
    const log = new SessionMessageLog({ spoolRoot: root });
    log.append(FILE, noticeMessage('f', { message: 'a' }, AT));
    log.append(TAB, noticeMessage('t', { message: 'b' }, AT));
    await log.idle();
    const [folder] = fs.readdirSync(root);
    assert.match(folder, /^pqb-messages-/);
    assert.equal(fs.readdirSync(path.join(root, folder)).length, 2);

    log.discard(TAB.key);
    await log.idle();
    assert.equal(fs.readdirSync(path.join(root, folder)).length, 1);

    log.dispose();
    assert.deepEqual(fs.readdirSync(root), []);
});

test('a log without a spool saves the messages it keeps', async (t) => {
    const root = tempRoot(t);
    const log = new SessionMessageLog({ limit: 1 });
    log.append(FILE, noticeMessage('f', { message: 'a' }, AT));
    log.append(FILE, noticeMessage('f', { message: 'b' }, AT));
    const target = path.join(root, 'saved.log');
    await log.saveTo(FILE.key, target);
    assert.equal(fs.readFileSync(target, 'utf8'), '[09:05:07] f — NOTICE: b\n');
});

// ===== MessageSpool =====

test('a spool keeps the order of its messages and drops what Clear came after', async (t) => {
    const root = tempRoot(t);
    const spool = new MessageSpool(path.join(root, 'spool.log'));
    for (let i = 0; i < 1000; i++) spool.write(`${i}\n`);
    spool.truncate();
    spool.write('after clear\n');
    spool.write('and more\n');
    await spool.idle();
    assert.equal(fs.readFileSync(spool.filePath, 'utf8'), 'after clear\nand more\n');

    for (let i = 0; i < 3; i++) spool.write(`${i}\n`);
    const target = path.join(root, 'copy.log');
    await spool.copyTo(target);
    assert.equal(fs.readFileSync(target, 'utf8'), 'after clear\nand more\n0\n1\n2\n');

    spool.remove();
    spool.write('ignored\n');
    await spool.idle();
    assert.equal(fs.existsSync(spool.filePath), false);
});

// ===== SessionMessagesView =====

function resolveView(log: SessionMessageLog = new SessionMessageLog()) {
    const view = new SessionMessagesView(log, { schedule: (render) => render() });
    const posted: any[] = [];
    let handler: (msg: any) => void = () => undefined;
    let visibilityListener: () => void = () => undefined;
    const shownWithFocus: boolean[] = [];
    const webview: any = {
        options: {},
        html: '',
        cspSource: 'vscode-resource:',
        postMessage: (m: any) => { posted.push(m); return Promise.resolve(true); },
        onDidReceiveMessage: (cb: (msg: any) => void) => { handler = cb; return { dispose() {} }; }
    };
    const webviewView: any = {
        webview,
        visible: true,
        show: (preserveFocus: boolean) => { shownWithFocus.push(preserveFocus); },
        onDidDispose: () => ({ dispose() {} }),
        onDidChangeVisibility: (cb: () => void) => { visibilityListener = cb; return { dispose() {} }; }
    };
    view.resolveWebviewView(webviewView, {} as any, {} as any);
    return {
        view,
        html: webview.html as string,
        posted,
        send: (msg: any) => handler(msg),
        setVisible: (visible: boolean) => { webviewView.visible = visible; visibilityListener(); },
        get shownWithFocus() { return shownWithFocus; },
        last: () => posted[posted.length - 1]
    };
}

test('the panel shows only the log of the session of the active tab', () => {
    const { view, posted, last } = resolveView();
    view.append(FILE, noticeMessage('payroll.sql', { message: 'file message' }, AT));
    view.append(TAB, noticeMessage('tab', { message: 'tab message' }, AT));
    assert.equal(posted.length, 0, 'nothing is shown before a tab was active');

    view.show(FILE);
    assert.equal(last().key, FILE.key);
    assert.deepEqual(last().state.messages.map((m: any) => m.text), ['file message']);

    view.show(TAB);
    assert.equal(last().state.label, TAB.label);
    assert.deepEqual(last().state.messages.map((m: any) => m.text), ['tab message']);
});

test('a message of another session does not touch what the panel shows', () => {
    const { view, posted, last } = resolveView();
    view.show(FILE);
    const before = posted.length;
    view.append(TAB, noticeMessage('tab', { message: 'elsewhere' }, AT));
    assert.equal(posted.length, before);
    view.append(FILE, noticeMessage('payroll.sql', { message: 'here' }, AT));
    assert.deepEqual(last().state.messages.map((m: any) => m.text), ['here']);
});

test('switching to the tab that is already shown does not render again', () => {
    const { view, posted } = resolveView();
    view.show(FILE);
    view.show({ ...FILE });
    assert.equal(posted.length, 1);
});

// ===== a flood of messages =====

test('new messages of the shown log are sent alone, not the whole log again', () => {
    const { view, last } = resolveView();
    view.show(FILE);
    view.append(FILE, noticeMessage('payroll.sql', { message: 'first' }, AT));
    assert.equal(last().type, 'log', 'the first message replaces the empty text');
    view.append(FILE, noticeMessage('payroll.sql', { severity: 'WARNING', message: 'second' }, AT));

    assert.equal(last().type, 'append');
    assert.equal(last().key, FILE.key);
    assert.deepEqual(last().messages.map((m: any) => [m.text, m.tone]), [['second', 'warning']]);
    assert.equal(last().total, 2);
    assert.equal(last().countText, '2 messages');
    assert.equal(last().limit, 2000);
});

test('thousands of messages in a burst become one update of the panel', () => {
    const pending: Array<() => void> = [];
    const log = new SessionMessageLog({ limit: 100 });
    const view = new SessionMessagesView(log, { schedule: (render) => pending.push(render) });
    const posted: any[] = [];
    view.resolveWebviewView({
        webview: { options: {}, html: '', cspSource: 'x', postMessage: (m: any) => { posted.push(m); return Promise.resolve(true); }, onDidReceiveMessage: () => ({ dispose() {} }) },
        visible: true
    } as any, {} as any, {} as any);
    view.show(FILE);
    view.append(FILE, noticeMessage('f', { message: 'start' }, AT));
    pending.shift()?.();
    assert.equal(posted.length, 2);

    for (let i = 0; i < 5000; i++) {
        view.append(FILE, noticeMessage('f', { message: `row ${i}` }, AT));
    }
    assert.equal(pending.length, 1, 'one update is waiting, however many messages came');
    assert.equal(posted.length, 2, 'nothing is sent per message');
    pending.shift()?.();

    assert.equal(posted.length, 3);
    // More came than the panel keeps, so it gets its 100 lines whole instead of 5000 to append.
    assert.equal(posted[2].type, 'log');
    assert.equal(posted[2].state.messages.length, 100);
    assert.equal(posted[2].state.countText, 'last 100 of 5001 messages');
});

test('a hidden panel is sent nothing and gets the whole log when it is shown again', () => {
    const { view, posted, last, setVisible } = resolveView();
    view.show(FILE);
    view.append(FILE, noticeMessage('f', { message: 'a' }, AT));
    setVisible(false);
    const before = posted.length;
    view.append(FILE, noticeMessage('f', { message: 'b' }, AT));
    view.append(FILE, noticeMessage('f', { message: 'c' }, AT));
    assert.equal(posted.length, before);

    setVisible(true);
    assert.equal(last().type, 'log');
    assert.deepEqual(last().state.messages.map((m: any) => m.text), ['a', 'b', 'c']);
});

// ===== messagesUpdate =====

function logOf(texts: string[], id = 1, total = texts.length) {
    return { key: FILE.key, label: FILE.label, id, total, errors: 0, messages: texts.map((text) => noticeMessage('f', { message: text }, AT)), running: [] };
}

test('messagesUpdate sends only what is new while the same log grows', () => {
    const sent = { key: FILE.key, label: FILE.label, id: 1, total: 2 };
    const { update, sent: next } = messagesUpdate(FILE, logOf(['a', 'b', 'c', 'd']), sent, 10);
    assert.equal(update?.type, 'append');
    assert.deepEqual((update as any).messages.map((m: any) => m.text), ['c', 'd']);
    assert.deepEqual(next, { key: FILE.key, label: FILE.label, id: 1, total: 4 });
});

test('messagesUpdate sends nothing when nothing changed', () => {
    const sent = { key: FILE.key, label: FILE.label, id: 1, total: 2 };
    assert.equal(messagesUpdate(FILE, logOf(['a', 'b']), sent, 10).update, null);
});

test('messagesUpdate sends the whole log for anything but new messages', () => {
    const sent = { key: FILE.key, label: FILE.label, id: 1, total: 2 };
    const whole = (shown: any, log: any, before: any) => messagesUpdate(shown, log, before, 10).update?.type;
    assert.equal(whole(FILE, logOf(['a', 'b', 'c']), undefined), 'log', 'nothing was sent yet');
    assert.equal(whole(TAB, undefined, sent), 'log', 'another session');
    assert.equal(whole({ ...FILE, label: 'renamed' }, logOf(['a', 'b', 'c']), sent), 'log', 'another label');
    assert.equal(whole(FILE, logOf(['x'], 2), sent), 'log', 'cleared, or ended and begun anew');
    assert.equal(whole(FILE, undefined, sent), 'log', 'the session ended');
    assert.equal(whole(FILE, logOf(['c', 'd', 'e'], 1, 6), sent), 'log', 'more came than the log keeps');
    assert.equal(whole(FILE, logOf(['a']), { ...sent, total: 0 }), 'log', 'the first message replaces the empty text');
});

test('the log of a session that ended disappears from the panel', () => {
    const { view, last } = resolveView();
    view.show(FILE);
    view.append(FILE, noticeMessage('payroll.sql', { message: 'a' }, AT));
    view.log.discard(FILE.key);
    assert.deepEqual(last().state.messages, []);
    assert.equal(last().state.label, 'payroll.sql');
});

test('Clear empties only the log that is shown, and ready sends it again', () => {
    const { view, send, last } = resolveView();
    view.append(TAB, noticeMessage('tab', { message: 'kept' }, AT));
    view.show(FILE);
    view.append(FILE, noticeMessage('payroll.sql', { message: 'gone' }, AT));

    send({ type: 'clear' });
    assert.deepEqual(last().state.messages, []);
    assert.equal(view.log.get(TAB.key)?.messages.length, 1);

    view.append(FILE, noticeMessage('payroll.sql', { message: 'new' }, AT));
    send({ type: 'ready' });
    assert.deepEqual(last().state.messages.map((m: any) => m.text), ['new']);
});

test('Copy puts the shown log on the clipboard as text', async (t) => {
    const copied: string[] = [];
    const original = vscodeStub.env.clipboard.writeText;
    vscodeStub.env.clipboard.writeText = (text: string) => { copied.push(text); return Promise.resolve(); };
    t.after(() => { vscodeStub.env.clipboard.writeText = original; });
    const { view, send } = resolveView();
    view.show(FILE);
    view.append(FILE, noticeMessage('payroll.sql', { message: 'a', hint: 'h' }, AT));
    view.append(TAB, noticeMessage('tab', { message: 'not this one' }, AT));

    send({ type: 'copy' });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(copied, ['[09:05:07] payroll.sql — NOTICE: a\n    HINT: h']);
});

test('Copy puts every message of the session on the clipboard, like Save, not only those shown', async (t) => {
    const root = tempRoot(t);
    const copied: string[] = [];
    const statusMessages: unknown[] = [];
    const originalCopy = vscodeStub.env.clipboard.writeText;
    const originalStatus = vscodeStub.window.setStatusBarMessage;
    vscodeStub.env.clipboard.writeText = (text: string) => { copied.push(text); return Promise.resolve(); };
    vscodeStub.window.setStatusBarMessage = (...args: any[]) => { statusMessages.push(args[0]); return { dispose() {} }; };
    t.after(() => {
        vscodeStub.env.clipboard.writeText = originalCopy;
        vscodeStub.window.setStatusBarMessage = originalStatus;
    });
    const resolved = resolveView(new SessionMessageLog({ limit: 2, spoolRoot: root }));
    t.after(() => resolved.view.dispose());
    resolved.view.show(FILE);
    for (let i = 1; i <= 5; i++) {
        resolved.view.append(FILE, noticeMessage('payroll.sql', { message: `step ${i}` }, AT));
    }
    assert.equal(resolved.view.log.get(FILE.key)?.messages.length, 2, 'the panel shows only the newest');

    resolved.send({ type: 'copy' });
    for (let i = 0; i < 20 && copied.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.deepEqual(copied, [[1, 2, 3, 4, 5].map((i) => `[09:05:07] payroll.sql — NOTICE: step ${i}`).join('\n')]);
    assert.deepEqual(statusMessages, ['Copied 5 messages.']);
    const saved = path.join(root, 'saved.log');
    await resolved.view.log.saveTo(FILE.key, saved);
    assert.equal(fs.readFileSync(saved, 'utf8'), `${copied[0]}\n`, 'Copy and Save hold the same lines');
});

test('Copy offers nothing for a session without messages', async (t) => {
    const copied: string[] = [];
    const original = vscodeStub.env.clipboard.writeText;
    vscodeStub.env.clipboard.writeText = (text: string) => { copied.push(text); return Promise.resolve(); };
    t.after(() => { vscodeStub.env.clipboard.writeText = original; });
    const { view, send } = resolveView();
    view.show(FILE);
    send({ type: 'copy' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(copied, []);
});

test('reveal switches to the log and brings the panel into view without taking the focus', () => {
    const resolved = resolveView();
    resolved.view.reveal(TAB);
    assert.equal(resolved.view.shownSession?.key, TAB.key);
    assert.deepEqual(resolved.shownWithFocus, [true]);
});

test('reveal opens a panel that was never shown through its focus command, keeping the focus', async (t) => {
    const calls: unknown[][] = [];
    const original = vscodeStub.commands.executeCommand;
    vscodeStub.commands.executeCommand = (...args: unknown[]) => { calls.push(args); return Promise.resolve(undefined); };
    t.after(() => { vscodeStub.commands.executeCommand = original; });

    const view = new SessionMessagesView(new SessionMessageLog());
    view.reveal(FILE);

    assert.deepEqual(calls, [[`${MESSAGES_VIEW_ID}.focus`, { preserveFocus: true }]]);
    assert.equal(view.shownSession?.key, FILE.key);
});

test('the panel offers Copy, Save and Clear as labelled buttons and escapes what it shows', () => {
    const { html } = resolveView();
    assert.match(html, /<button class="btn btn-sm" id="copyBtn"[^>]*>.*#icon-copy.*Copy<\/button>/);
    assert.match(html, /<button class="btn btn-sm" id="saveBtn"[^>]*>.*#icon-save.*Save<\/button>/);
    assert.match(html, /<button class="btn btn-sm" id="clearBtn"[^>]*>.*#icon-trash.*Clear<\/button>/);
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /escapeHtml\(m\.text\)/);
    assert.match(html, /escapeHtml\(d\)/);
});

test('Save in the panel asks for a file and writes every message of the shown session to it', async (t) => {
    const root = tempRoot(t);
    const target = path.join(root, 'payroll.log');
    const dialogs: any[] = [];
    const statusMessages: unknown[] = [];
    const originalDialog = vscodeStub.window.showSaveDialog;
    const originalStatus = vscodeStub.window.setStatusBarMessage;
    vscodeStub.window.showSaveDialog = (options?: any) => { dialogs.push(options); return Promise.resolve({ fsPath: target }); };
    vscodeStub.window.setStatusBarMessage = (...args: any[]) => { statusMessages.push(args[0]); return { dispose() {} }; };
    t.after(() => {
        vscodeStub.window.showSaveDialog = originalDialog;
        vscodeStub.window.setStatusBarMessage = originalStatus;
    });
    const resolved = resolveView(new SessionMessageLog({ limit: 1, spoolRoot: root }));
    t.after(() => resolved.view.dispose());
    resolved.view.show(FILE);
    resolved.view.append(FILE, noticeMessage('payroll.sql', { message: 'first' }, AT));
    resolved.view.append(FILE, noticeMessage('payroll.sql', { message: 'second' }, AT));
    assert.equal(resolved.last().countText, 'last 1 of 2 messages');

    resolved.send({ type: 'save' });
    for (let i = 0; i < 20 && statusMessages.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.match(dialogs[0].defaultUri.fsPath, /payroll-messages-\d{4}-\d{2}-\d{2}\.log$/);
    assert.equal(fs.readFileSync(target, 'utf8'), '[09:05:07] payroll.sql — NOTICE: first\n[09:05:07] payroll.sql — NOTICE: second\n');
    assert.deepEqual(statusMessages, [`Saved 2 messages to ${target}.`]);
});

test('Save in the panel writes nothing when the dialog is cancelled or the log is empty', async (t) => {
    let asked = 0;
    const original = vscodeStub.window.showSaveDialog;
    vscodeStub.window.showSaveDialog = () => { asked++; return Promise.resolve(undefined); };
    t.after(() => { vscodeStub.window.showSaveDialog = original; });
    const { view, send } = resolveView();
    view.show(FILE);
    send({ type: 'save' });
    view.append(FILE, noticeMessage('f', { message: 'a' }, AT));
    send({ type: 'save' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(asked, 1, 'an empty log offers nothing to save');
});

// ===== Manifest and wiring =====

test('the manifest puts the messages view into a panel of its own', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const container = manifest.contributes.viewsContainers.panel.find((c: { id: string }) => c.id === 'postgresQueryBoosterMessages');
    assert.ok(container, 'panel container missing');
    assert.equal(container.title, 'PostgreSQL Messages');
    const views = manifest.contributes.views.postgresQueryBoosterMessages;
    assert.deepEqual(views.map((v: { id: string; type: string }) => [v.id, v.type]), [[MESSAGES_VIEW_ID, 'webview']]);
});

test('the extension ends a log with its session and follows the active tab', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'extension.ts'), 'utf8');
    assert.match(source, /registerWebviewViewProvider\(SessionMessagesView\.viewType, messagesView\)/);
    assert.match(source, /new SessionMessageLog\(\{ spoolRoot: os\.tmpdir\(\) \}\)/, 'every message is spooled, so Save can write all of them');
    assert.match(source, /dbSessions\.onDidChange\(\(key\) => \{\s*if \(!dbSessions\.get\(key\)\) messagesView\.log\.discard\(key\);/);
    assert.match(source, /onDidChangeActiveTextEditor\(showLogOfEditor\)/);
    assert.match(source, /onDidFocusSession\(\(ref\) => messagesView\.show\(ref\)\)/);
    assert.doesNotMatch(source, /createOutputChannel\('PostgreSQL Messages'\)|MESSAGES_CHANNEL_NAME/, 'no shared output for every session');
});

// ===== the script of the panel =====

/** Top-level entries of the list, as the script writes them. */
function entriesOf(html: string): string[] {
    return html ? html.split(/(?=<div class="(?:msg|empty)[ "])/).filter(Boolean) : [];
}

/** Just enough of an element for the panel's script; the list keeps its entries as HTML strings. */
class FakeElement {
    textContent = '';
    title = '';
    disabled = false;
    scrollTop = 0;
    clientHeight = 100;
    entries: string[] = [];
    get scrollHeight(): number { return this.entries.length * 20; }
    set innerHTML(html: string) { this.entries = entriesOf(html); }
    get innerHTML(): string { return this.entries.join(''); }
    insertAdjacentHTML(_position: string, html: string): void { this.entries.push(...entriesOf(html)); }
    get childElementCount(): number { return this.entries.length; }
    get firstElementChild(): { remove(): void } | null {
        return this.entries.length > 0 ? { remove: () => { this.entries.shift(); } } : null;
    }
    querySelector(selector: string): any {
        const list = this;
        const byId = /^\.msg\[data-id="(\d+)"\]$/.exec(selector);
        if (byId) {
            const index = this.entries.findIndex((e) => e.startsWith('<div class="msg ') && e.includes(` data-id="${byId[1]}"`));
            return index >= 0 ? { set outerHTML(html: string) { list.entries[index] = html; } } : null;
        }
        const index = selector === '.empty' ? this.entries.findIndex((e) => e.startsWith('<div class="empty"')) : -1;
        return index >= 0 ? { remove: () => { this.entries.splice(index, 1); } } : null;
    }
    addEventListener(type: string, listener: (event?: any) => void): void { this.listeners[type] = listener; }
    listeners: Record<string, (event?: any) => void> = {};
    hidden = false;
    /** Index of the entry marked as the current error, or -1. */
    current = -1;
    click(): void { this.listeners.click?.(); }
    querySelectorAll(selector: string): any[] {
        const list = this;
        if (selector === '.msg-timer[data-running]') {
            const RUNNING = /(<span class="msg-timer[^"]*" data-running data-started="(\d+)">)[^<]*/;
            return this.entries
                .map((entry, index) => ({ match: RUNNING.exec(entry), index }))
                .filter(({ match }) => match !== null)
                .map(({ match, index }) => ({
                    dataset: { started: (match as RegExpExecArray)[2] },
                    set textContent(text: string) {
                        list.entries[index] = list.entries[index].replace(RUNNING, (_all, open: string) => `${open}${text}`);
                    }
                }));
        }
        if (selector === '.msg.tone-danger') {
            return this.entries
                .map((entry, index) => ({ entry, index }))
                .filter(({ entry }) => entry.startsWith('<div class="msg tone-danger"'))
                .map(({ index }) => ({
                    offsetTop: index * 20,
                    classList: {
                        add: () => { this.current = index; },
                        remove: () => { if (this.current === index) this.current = -1; },
                        contains: (name: string) => name === 'current' && this.current === index
                    }
                }));
        }
        return [];
    }
}

function runPanelScript() {
    const { html } = resolveView();
    const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(html)?.[1] ?? '';
    const elements: Record<string, FakeElement> = {};
    const document = { getElementById: (id: string) => (elements[id] ??= new FakeElement()) };
    let receive: (ev: { data: any }) => void = () => undefined;
    const window = { addEventListener: (_type: string, listener: (ev: { data: any }) => void) => { receive = listener; } };
    const sent: any[] = [];
    // The panel's timers run when the test says so.
    const intervals = new Map<number, () => void>();
    let nextInterval = 1;
    const setInterval = (fn: () => void) => { intervals.set(nextInterval, fn); return nextInterval++; };
    const clearInterval = (handle: number) => { intervals.delete(handle); };
    new Function('acquireVsCodeApi', 'document', 'window', 'setInterval', 'clearInterval', script)(
        () => ({ postMessage: (m: any) => sent.push(m) }), document, window, setInterval, clearInterval
    );
    return {
        list: elements.list, count: elements.count, copy: elements.copyBtn, elements, send: (data: any) => receive({ data }), sent,
        intervals,
        tickTimers: () => { for (const fn of [...intervals.values()]) fn(); }
    };
}

const tone = (text: string) => ({ ...noticeMessage('payroll.sql', { message: text }, AT), tone: 'info' });

test('the panel script appends new messages and drops the oldest beyond the limit', () => {
    const panel = runPanelScript();
    assert.deepEqual(panel.sent, [{ type: 'ready' }]);
    panel.send({ type: 'log', key: FILE.key, state: { label: 'payroll.sql', messages: ['a', 'b', 'c'].map(tone), total: 3, countText: '3 messages' } });
    assert.equal(panel.list.childElementCount, 3);

    panel.send({ type: 'append', key: FILE.key, messages: ['d', 'e'].map(tone), total: 5, countText: 'last 4 of 5 messages', limit: 4 });

    assert.equal(panel.list.childElementCount, 4);
    assert.match(panel.list.entries[0], /msg-text">b</);
    assert.match(panel.list.entries[3], /msg-text">e</);
    assert.equal(panel.count.textContent, 'last 4 of 5 messages');
    assert.equal(panel.list.scrollTop, panel.list.scrollHeight, 'it follows new messages while scrolled to the end');
});

test('the panel script replaces the empty text with the first message and ignores another session', () => {
    const panel = runPanelScript();
    panel.send({ type: 'log', key: FILE.key, state: { label: 'payroll.sql', messages: [], total: 0, countText: '0 messages' } });
    assert.match(panel.list.innerHTML, /No messages from the database session of payroll\.sql yet/);
    assert.equal(panel.copy.disabled, true);

    panel.send({ type: 'append', key: FILE.key, messages: [tone('<b>first</b>')], total: 1, countText: '1 message', limit: 2000 });
    assert.equal(panel.list.childElementCount, 1);
    assert.match(panel.list.innerHTML, /&lt;b&gt;first&lt;\/b&gt;/, 'what the server says is escaped');
    assert.equal(panel.copy.disabled, false);

    panel.send({ type: 'append', key: TAB.key, messages: [tone('elsewhere')], total: 9, countText: '9 messages', limit: 2000 });
    assert.equal(panel.list.childElementCount, 1);
    assert.equal(panel.count.textContent, '1 message');
});

test('the panel script stays where the reader scrolled to while messages come in', () => {
    const panel = runPanelScript();
    panel.send({ type: 'log', key: FILE.key, state: { label: 'payroll.sql', messages: Array.from({ length: 50 }, (_, i) => tone(`m${i}`)), total: 50, countText: '50 messages' } });
    panel.list.scrollTop = 40;
    panel.send({ type: 'append', key: FILE.key, messages: [tone('new')], total: 51, countText: '51 messages', limit: 2000 });
    assert.equal(panel.list.scrollTop, 40);
});

// ===== errors stand out =====

const toned = (severity: string, text: string) => {
    const message = noticeMessage('payroll.sql', { severity, message: text }, AT);
    return { ...message, tone: messageTone(severity) };
};

test('an error is marked by its row, an icon and the header, a warning by its own icon', () => {
    const panel = runPanelScript();
    panel.send({
        type: 'log', key: FILE.key,
        state: { label: 'payroll.sql', messages: [toned('NOTICE', 'fine'), toned('WARNING', 'careful'), toned('ERROR', 'broken')], total: 3, countText: '3 messages', errorsText: '1 error' }
    });

    const [notice, warning, error] = panel.list.entries;
    assert.match(error, /^<div class="msg tone-danger">/);
    assert.match(error, /<span class="msg-sev"><svg class="ico" aria-hidden="true"><use href="#icon-error"\/><\/svg>ERROR:<\/span>/);
    assert.match(warning, /^<div class="msg tone-warning">/);
    assert.match(warning, /#icon-warning/);
    assert.doesNotMatch(notice, /#icon-/, 'a notice needs no mark');
    assert.equal(panel.elements.errorsBtn.hidden, false);
    assert.equal(panel.elements.errorsText.textContent, '1 error');
});

test('the error count in the header hides without errors and follows new ones', () => {
    const panel = runPanelScript();
    panel.send({ type: 'log', key: FILE.key, state: { label: 'payroll.sql', messages: [toned('NOTICE', 'a')], total: 1, countText: '1 message', errorsText: '' } });
    assert.equal(panel.elements.errorsBtn.hidden, true);

    panel.send({ type: 'append', key: FILE.key, messages: [toned('ERROR', 'b'), toned('ERROR', 'c')], total: 3, countText: '3 messages', errorsText: '2 errors', limit: 2000 });
    assert.equal(panel.elements.errorsBtn.hidden, false);
    assert.equal(panel.elements.errorsText.textContent, '2 errors');
});

test('the error count jumps from one error to the next and round to the first', () => {
    const panel = runPanelScript();
    const messages = ['NOTICE', 'ERROR', 'NOTICE', 'NOTICE', 'ERROR', 'NOTICE'].map((severity, i) => toned(severity, `m${i}`));
    panel.send({ type: 'log', key: FILE.key, state: { label: 'payroll.sql', messages, total: 6, countText: '6 messages', errorsText: '2 errors' } });
    panel.list.scrollTop = 0;

    panel.elements.errorsBtn.click();
    assert.equal(panel.list.scrollTop, 20);
    assert.equal(panel.list.current, 1);
    panel.elements.errorsBtn.click();
    assert.equal(panel.list.scrollTop, 80);
    assert.equal(panel.list.current, 4);
    panel.elements.errorsBtn.click();
    assert.equal(panel.list.scrollTop, 20, 'after the last error it starts again at the first');
    assert.equal(panel.list.current, 1);
});

test('the error count also steps through errors that all fit without scrolling', () => {
    const panel = runPanelScript();
    const messages = ['ERROR', 'NOTICE', 'ERROR'].map((severity, i) => toned(severity, `m${i}`));
    panel.send({ type: 'log', key: FILE.key, state: { label: 'payroll.sql', messages, total: 3, countText: '3 messages', errorsText: '2 errors' } });
    panel.list.scrollTop = 0;
    panel.elements.errorsBtn.click();
    panel.list.scrollTop = 0; // the list cannot scroll, so it stays at the top
    panel.elements.errorsBtn.click();
    assert.equal(panel.list.current, 2, 'the next error is marked, not the first one again');
});

test('the error and warning icons exist in the sprite', () => {
    const sprite = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'icons.svg'), 'utf8');
    assert.match(sprite, /<symbol id="icon-error" viewBox="0 0 16 16">/);
    assert.match(sprite, /<symbol id="icon-warning" viewBox="0 0 16 16">/);
});

// ===== a long run with many or large messages =====

test('keptText cuts a long text and says how much is left out', () => {
    assert.equal(keptText('short', 10), 'short');
    assert.equal(keptText('x'.repeat(12), 10), `${'x'.repeat(10)}… (2 more characters; Save writes them all)`);
    assert.equal(MAX_KEPT_TEXT, 4000);
});

test('the panel keeps a huge message cut short, while Save writes it in full', async (t) => {
    const root = tempRoot(t);
    const log = new SessionMessageLog({ spoolRoot: root });
    t.after(() => log.dispose());
    const huge = 'y'.repeat(MAX_KEPT_TEXT + 500);
    log.append(FILE, noticeMessage('f', { message: huge, detail: huge }, AT));

    const kept = log.get(FILE.key)!.messages[0];
    assert.equal(kept.text, keptText(huge));
    assert.equal(kept.details[0], `DETAIL: ${huge}`.slice(0, MAX_KEPT_TEXT) + '… (508 more characters; Save writes them all)');
    const target = path.join(root, 'saved.log');
    await log.saveTo(FILE.key, target);
    assert.equal(fs.readFileSync(target, 'utf8'), `[09:05:07] f — NOTICE: ${huge}\n    DETAIL: ${huge}\n`);
});

test('a log too large for the clipboard is not read, and Copy offers Save instead', async (t) => {
    const root = tempRoot(t);
    const copied: string[] = [];
    const warnings: unknown[][] = [];
    const dialogs: unknown[] = [];
    const originals = { copy: vscodeStub.env.clipboard.writeText, warn: vscodeStub.window.showWarningMessage, dialog: vscodeStub.window.showSaveDialog };
    vscodeStub.env.clipboard.writeText = (text: string) => { copied.push(text); return Promise.resolve(); };
    vscodeStub.window.showWarningMessage = ((...args: unknown[]) => { warnings.push(args); return Promise.resolve('Save'); }) as any;
    vscodeStub.window.showSaveDialog = (options?: any) => { dialogs.push(options); return Promise.resolve(undefined); };
    t.after(() => {
        vscodeStub.env.clipboard.writeText = originals.copy;
        vscodeStub.window.showWarningMessage = originals.warn;
        vscodeStub.window.showSaveDialog = originals.dialog;
    });
    const log = new SessionMessageLog({ spoolRoot: root });
    const view = new SessionMessagesView(log, { schedule: (render) => render(), maxCopyBytes: 200 });
    t.after(() => view.dispose());
    view.show(FILE);
    for (let i = 0; i < 10; i++) view.append(FILE, noticeMessage('payroll.sql', { message: `step ${i}` }, AT));

    assert.deepEqual(await log.readAll(FILE.key, 200), { tooLarge: true, bytes: 10 * '[09:05:07] payroll.sql — NOTICE: step 0\n'.length + 20, count: 10 });
    await (view as any).copy();

    assert.deepEqual(copied, [], 'nothing went to the clipboard');
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /^The session of payroll\.sql sent 10 messages \(\d+ bytes\), more than the clipboard can take safely \(200 bytes\)\. Save them to a file instead\?$/);
    assert.equal(warnings[0][1], 'Save');
    assert.equal(dialogs.length, 1, 'Save opens its dialog');
});

test('byteSizeText names a size in the unit that suits it', () => {
    assert.equal(byteSizeText(512), '512 bytes');
    assert.equal(byteSizeText(1536), '1.5 KB');
    assert.equal(byteSizeText(20 * 1024 * 1024), '20.0 MB');
    assert.equal(byteSizeText(3 * 1024 * 1024 * 1024), '3.0 GB');
    assert.equal(MAX_COPY_BYTES, 20 * 1024 * 1024);
});

test('a flood of messages keeps the panel and its log at their limit', async (t) => {
    const root = tempRoot(t);
    let posts = 0;
    const pending: Array<() => void> = [];
    const log = new SessionMessageLog({ limit: 50, spoolRoot: root });
    const view = new SessionMessagesView(log, { schedule: (render) => pending.push(render) });
    t.after(() => view.dispose());
    view.resolveWebviewView({ webview: { options: {}, html: '', cspSource: 'x', postMessage: () => { posts++; return Promise.resolve(true); }, onDidReceiveMessage: () => ({ dispose() {} }) }, visible: true } as any, {} as any, {} as any);
    view.show(FILE);
    for (let i = 0; i < 20_000; i++) {
        view.append(FILE, noticeMessage('f', { message: `row ${i}` }, AT));
        if (i % 1000 === 999) pending.splice(0).forEach((render) => render());
    }
    await log.idle();
    assert.equal(log.get(FILE.key)?.messages.length, 50);
    assert.equal(log.get(FILE.key)?.total, 20_000);
    assert.ok(posts <= 21, `the panel was updated ${posts} times, not once per message`);
    const saved = path.join(root, 'all.log');
    assert.equal(await log.saveTo(FILE.key, saved), 20_000);
    assert.equal(fs.readFileSync(saved, 'utf8').split('\n').length - 1, 20_000);
});

// ===== the entry of a statement a run starts =====

const STATEMENT = { uri: 'file:///work/payroll.sql', start: { line: 11, character: 0 }, end: { line: 13, character: 24 } };

test('a started statement is logged with a link to its line and a running timer', () => {
    const entry = statementStartedMessage('payroll.sql', STATEMENT, AT);
    assert.equal(entry.severity, 'RUN');
    assert.equal(entry.text, 'Started executing query at line 12');
    assert.deepEqual(entry.link, { text: 'line 12', ...STATEMENT });
    assert.deepEqual(entry.timer, { started: AT.getTime(), status: 'running' });
    assert.notEqual(statementStartedMessage('payroll.sql', STATEMENT, AT).id, entry.id, 'every entry has an id of its own');
});

test('timerText counts a running statement and tells how long one ran', () => {
    const started = AT.getTime();
    assert.equal(timerText({ started, status: 'running' }, started + 65_400), 'since 1 min 05 s');
    assert.equal(timerText({ started, status: 'done', ms: 3210 }, 0), 'after 3.2 s');
    assert.equal(timerText({ started, status: 'failed', ms: 12 }, 0), 'after 12 ms');
    assert.equal(timerText({ started, status: 'cancelled', ms: 125_000 }, 0), 'after 2 min 05 s');
    assert.equal(runTimeText(999.6), '1000 ms');
    assert.equal(runTimeText(59_999), '60.0 s');
    assert.equal(runTimeText(60_000), '1 min 00 s');
});

test('the panel counts and words a timer exactly as the extension does', () => {
    const { timerText: scriptTimerText } = new Function(`${TIMER_TEXT_JS}; return { timerText };`)();
    const started = 1_000_000;
    for (const ms of [0, 1, 999, 1000, 1499, 59_999, 60_000, 61_000, 3_599_999, 3_600_000, 7_385_000]) {
        assert.equal(scriptTimerText({ started, status: 'running' }, started + ms), timerText({ started, status: 'running' }, started + ms), `running ${ms}`);
        for (const status of ['done', 'failed', 'cancelled'] as const) {
            assert.equal(scriptTimerText({ started, status, ms }, 0), timerText({ started, status, ms }, 0), `${status} ${ms}`);
        }
    }
    assert.equal(elapsedText(65_000), '1 min 05 s');
});

test('a running statement keeps its line below every message until it ends', () => {
    const log = new SessionMessageLog();
    const entry = statementStartedMessage('payroll.sql', STATEMENT, AT);
    log.append(FILE, entry);
    for (let i = 0; i < 3; i++) log.append(FILE, noticeMessage('payroll.sql', { message: `step ${i}` }, AT));

    const running = log.get(FILE.key)!;
    assert.deepEqual(running.messages.map((m) => m.text), ['Started executing query at line 12', 'step 0', 'step 1', 'step 2']);
    assert.equal(running.messages[0].timer, undefined, 'the started line is a plain line');
    assert.equal(running.messages[0].link?.text, 'line 12', 'it still leads to the statement');
    assert.notEqual(running.messages[0].id, entry.id);
    assert.deepEqual(running.running.map((m) => [m.id, m.text, m.timer?.status]), [[entry.id, 'Executing query at line 12', 'running']]);
    assert.equal(running.total, 4, 'the running line is no message');

    log.finish(FILE, entry, 'done', 3210, AT);

    const ended = log.get(FILE.key)!;
    assert.deepEqual(ended.running, []);
    assert.equal(ended.total, 5);
    const last = ended.messages.at(-1)!;
    assert.equal(last.text, 'Finished executing query at line 12');
    assert.deepEqual(last.timer, { started: AT.getTime(), status: 'done', ms: 3210 });
    assert.equal(last.link?.text, 'line 12');
    assert.equal(formatSessionMessage(last), '[09:05:07] payroll.sql — RUN: Finished executing query at line 12 after 3.2 s');

    log.finish(FILE, entry, 'failed', 9999, AT);
    assert.equal(log.get(FILE.key)!.total, 5, 'a statement ends only once');
});

test('a failed or cancelled statement says so in its last line', () => {
    const log = new SessionMessageLog();
    const failed = statementStartedMessage('payroll.sql', STATEMENT, AT);
    const cancelled = statementStartedMessage('payroll.sql', STATEMENT, AT);
    log.append(FILE, failed);
    log.append(FILE, cancelled);
    log.finish(FILE, failed, 'failed', 420, AT);
    log.finish(FILE, cancelled, 'cancelled', 61_000, AT);
    assert.deepEqual(log.get(FILE.key)!.messages.slice(-2).map(formatSessionMessage), [
        '[09:05:07] payroll.sql — RUN: Failed executing query at line 12 after 420 ms',
        '[09:05:07] payroll.sql — RUN: Cancelled executing query at line 12 after 1 min 01 s'
    ]);
});

test('Clear keeps the line of a statement that is still running', () => {
    const log = new SessionMessageLog();
    const entry = statementStartedMessage('payroll.sql', STATEMENT, AT);
    log.append(FILE, entry);
    log.clear(FILE.key);
    assert.deepEqual(log.get(FILE.key)!.messages, []);
    assert.equal(log.get(FILE.key)!.running.length, 1);
    log.finish(FILE, entry, 'done', 1, AT);
    assert.deepEqual(log.get(FILE.key)!.messages.map((m) => m.text), ['Finished executing query at line 12']);
});

test('the log file has the start, every message and the end of a statement in order', async (t) => {
    const root = tempRoot(t);
    const log = new SessionMessageLog({ limit: 1, spoolRoot: root });
    t.after(() => log.dispose());
    const entry = statementStartedMessage('payroll.sql', STATEMENT, AT);
    log.append(FILE, entry);
    log.append(FILE, noticeMessage('payroll.sql', { message: 'inside' }, AT));
    log.finish(FILE, entry, 'failed', 420, AT);

    const target = path.join(root, 'saved.log');
    assert.equal(await log.saveTo(FILE.key, target), 3);
    assert.equal(fs.readFileSync(target, 'utf8'), [
        '[09:05:07] payroll.sql — RUN: Started executing query at line 12',
        '[09:05:07] payroll.sql — NOTICE: inside',
        '[09:05:07] payroll.sql — RUN: Failed executing query at line 12 after 420 ms',
        ''
    ].join('\n'));
});

test('the panel gets the running line with every update and the end as a new message', () => {
    const { view, last } = resolveView();
    view.show(FILE);
    const entry = statementStartedMessage('payroll.sql', STATEMENT, AT);
    view.append(FILE, entry);
    assert.equal(last().type, 'log');
    assert.deepEqual(last().state.running.map((m: any) => [m.text, m.tone]), [['Executing query at line 12', 'info']]);

    view.append(FILE, noticeMessage('payroll.sql', { message: 'step' }, AT));
    assert.equal(last().type, 'append');
    assert.deepEqual(last().messages.map((m: any) => m.text), ['step']);
    assert.equal(last().running.length, 1);

    view.finish(FILE, entry, 'done', 3210);
    assert.equal(last().type, 'append');
    assert.deepEqual(last().messages.map((m: any) => [m.text, m.timer.status]), [['Finished executing query at line 12', 'done']]);
    assert.deepEqual(last().running, []);
});

test('a click on the line of an entry opens its file with the whole statement selected', async (t) => {
    const opened: unknown[] = [];
    const shown: any[] = [];
    const revealed: any[] = [];
    const originals = {
        open: vscodeStub.workspace.openTextDocument,
        show: vscodeStub.window.showTextDocument,
        visible: vscodeStub.window.visibleTextEditors
    };
    vscodeStub.workspace.openTextDocument = (uri: any) => { opened.push(uri.toString()); return Promise.resolve({ uri }); };
    vscodeStub.window.showTextDocument = (document: any, options: any) => {
        shown.push({ document, options });
        return Promise.resolve({ revealRange: (range: any, type: number) => revealed.push({ range, type }) });
    };
    vscodeStub.window.visibleTextEditors = [{ document: { uri: { toString: () => STATEMENT.uri } }, viewColumn: 2 }];
    t.after(() => {
        vscodeStub.workspace.openTextDocument = originals.open;
        vscodeStub.window.showTextDocument = originals.show;
        vscodeStub.window.visibleTextEditors = originals.visible;
    });
    const { view, send } = resolveView();
    view.show(FILE);
    const entry = statementStartedMessage('payroll.sql', STATEMENT, AT);
    view.append(FILE, entry);

    send({ type: 'openLink', id: entry.id });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(opened, [STATEMENT.uri]);
    const { selection, viewColumn, preview } = shown[0].options;
    const at = (p: any) => [p.line, p.character];
    assert.deepEqual([at(selection.anchor), at(selection.active)], [[11, 0], [13, 24]]);
    assert.equal(viewColumn, 2, 'in the group that already shows the file');
    assert.equal(preview, false);
    assert.deepEqual(at(revealed[0].range.start), [11, 0]);
});

test('a click leads only to an entry of the shown log, by its id alone', async (t) => {
    const opened: unknown[] = [];
    const original = vscodeStub.workspace.openTextDocument;
    vscodeStub.workspace.openTextDocument = (uri: any) => { opened.push(uri); return Promise.resolve({ uri }); };
    t.after(() => { vscodeStub.workspace.openTextDocument = original; });
    const { view, send } = resolveView();
    view.show(FILE);
    const elsewhere = statementStartedMessage('tab', STATEMENT, AT);
    view.append(TAB, elsewhere);
    view.append(FILE, noticeMessage('payroll.sql', { message: 'no link' }, AT));

    send({ type: 'openLink', id: elsewhere.id, uri: 'file:///etc/passwd' });
    send({ type: 'openLink', id: 'x' });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(opened, []);
});

test('a statement that cannot be shown any more says so', async (t) => {
    const errors: unknown[] = [];
    const originals = { open: vscodeStub.workspace.openTextDocument, error: vscodeStub.window.showErrorMessage };
    vscodeStub.workspace.openTextDocument = () => Promise.reject(new Error('cannot open file:///work/payroll.sql'));
    vscodeStub.window.showErrorMessage = (message: string) => { errors.push(message); return Promise.resolve(undefined); };
    t.after(() => {
        vscodeStub.workspace.openTextDocument = originals.open;
        vscodeStub.window.showErrorMessage = originals.error;
    });
    const { view, send } = resolveView();
    view.show(FILE);
    const entry = statementStartedMessage('payroll.sql', STATEMENT, AT);
    view.append(FILE, entry);

    send({ type: 'openLink', id: entry.id });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(errors, ['The statement at line 12 cannot be shown: cannot open file:///work/payroll.sql']);
});

const running = (startedAgoMs: number) => {
    const entry = statementStartedMessage('payroll.sql', STATEMENT, new Date(Date.now() - startedAgoMs));
    return { ...entry, text: 'Executing query at line 12', tone: 'info' };
};
const logState = (messages: any[], runningLines: any[] = []) =>
    ({ label: 'payroll.sql', messages, total: messages.length, countText: `${messages.length} messages`, running: runningLines });

test('the panel shows the line of a statement as a link and asks the extension to open it', () => {
    const panel = runPanelScript();
    const entry = running(0);
    panel.send({ type: 'log', key: FILE.key, state: logState([], [entry]) });
    const runningEl = panel.elements.running;

    assert.equal(runningEl.hidden, false);
    assert.match(runningEl.entries[0], new RegExp(`data-id="${entry.id}"`));
    assert.match(runningEl.entries[0],
        new RegExp(`msg-text">Executing query at <a href="#" class="msg-link" data-link-id="${entry.id}" title="[^"]+">line 12</a></span>`));

    let prevented = false;
    runningEl.listeners.click({
        target: { closest: (selector: string) => (selector === '.msg-link' ? { dataset: { linkId: String(entry.id) } } : null) },
        preventDefault: () => { prevented = true; }
    });
    panel.list.listeners.click({ target: { closest: () => null }, preventDefault: () => { throw new Error('not a link'); } });

    assert.equal(prevented, true);
    assert.deepEqual(panel.sent.slice(1), [{ type: 'openLink', id: entry.id }]);
});

test('the running line stays below the messages while they come and goes once the statement ended', () => {
    const panel = runPanelScript();
    const entry = running(65_000);
    panel.send({ type: 'log', key: FILE.key, state: logState([tone('started')], [entry]) });
    const runningEl = panel.elements.running;
    assert.match(runningEl.entries[0], /<span class="msg-timer status-running" data-running data-started="\d+">since 1 min 0[56] s<\/span>/);
    assert.equal(panel.intervals.size, 1, 'a timer runs');

    panel.send({ type: 'append', key: FILE.key, messages: [tone('a'), tone('b')], total: 3, countText: '3 messages', limit: 2000, running: [entry] });
    assert.equal(panel.list.childElementCount, 3, 'the running line is no line of the list');
    assert.equal(runningEl.entries.length, 1);

    runningEl.entries[0] = runningEl.entries[0].replace(/since [^<]*/, 'stale');
    panel.tickTimers();
    assert.match(runningEl.entries[0], /since 1 min 0[56] s<\/span>/, 'renewed by the tick');

    const done = { ...entry, text: 'Finished executing query at line 12', timer: { ...entry.timer, status: 'done', ms: 65_000 } };
    panel.send({ type: 'append', key: FILE.key, messages: [done], total: 4, countText: '4 messages', limit: 2000, running: [] });
    assert.match(panel.list.entries[3], /msg-text">Finished executing query at <a[^>]*>line 12<\/a><\/span> <span class="msg-timer status-done">after 1 min 05 s<\/span>/);
    assert.equal(runningEl.hidden, true);
    assert.deepEqual(runningEl.entries, []);
    panel.tickTimers();
    assert.equal(panel.intervals.size, 0, 'no timer runs once every statement has ended');
});

test('the panel marks how a statement ended and starts no timer for one that has', () => {
    const panel = runPanelScript();
    const ended = (status: string, verb: string) => ({ ...running(0), text: `${verb} executing query at line 12`, timer: { started: 0, status, ms: 420 } });
    panel.send({ type: 'log', key: FILE.key, state: logState([ended('failed', 'Failed'), ended('cancelled', 'Cancelled')]) });
    assert.match(panel.list.entries[0], /^<div class="msg tone-info run-failed"/);
    assert.match(panel.list.entries[0], /<span class="msg-timer status-failed">after 420 ms<\/span>/);
    assert.match(panel.list.entries[1], /^<div class="msg tone-info run-cancelled"/);
    assert.equal(panel.elements.running.hidden, true);
    assert.equal(panel.intervals.size, 0);
});

test('the panel colours how a statement ended from tokens and says it in words', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'sessionMessages.ts'), 'utf8');
    assert.match(source, /\.msg-timer\.status-failed \{ color: var\(--c-danger\);/);
    assert.match(source, /\.msg-timer\.status-cancelled \{ color: var\(--c-warning\); \}/);
    assert.match(source, /\.msg\.run-failed \.msg-text \{ color: var\(--c-danger\); font-weight: 600; \}/);
    assert.match(source, /\.running \{ flex-shrink: 0;[^}]*border-top: 1px solid var\(--c-border\);/);
    assert.match(source, /<div class="list" id="list"><\/div>\s*<div class="running" id="running"[^>]*hidden><\/div>/);
    assert.match(source, /\.msg-link \{ color: var\(--vscode-textLink-foreground\);/);
});

// ===== Clear on Execute =====

/** Let the settings hold `clearOnExecute` for one test, and record what is written to them. */
function stubClearOnExecute(t: { after(fn: () => void): void }, value: unknown) {
    const writes: unknown[][] = [];
    const original = vscodeStub.workspace.getConfiguration;
    vscodeStub.workspace.getConfiguration = ((section?: string) => ({
        get: (key: string, fallback?: unknown) => (section === 'postgresQueryBuilder' && key === 'messages.clearOnExecute' ? value : fallback),
        update: (key: string, next: unknown, target: unknown) => { writes.push([section, key, next, target]); return Promise.resolve(); }
    })) as any;
    t.after(() => { vscodeStub.workspace.getConfiguration = original; });
    return writes;
}

test('with Clear on Execute a starting run empties the log of its session and no other', (t) => {
    stubClearOnExecute(t, true);
    const { view, last } = resolveView();
    view.show(FILE);
    view.append(FILE, noticeMessage('payroll.sql', { message: 'from the last run' }, AT));
    view.append(TAB, noticeMessage('tab', { message: 'another session' }, AT));

    view.runStarting(FILE);

    assert.equal(view.log.get(FILE.key)?.total, 0);
    assert.deepEqual(last().state.messages, [], 'the panel shows the emptied log');
    assert.equal(view.log.get(TAB.key)?.total, 1);
});

test('without Clear on Execute a starting run keeps the log', (t) => {
    stubClearOnExecute(t, undefined);
    const { view } = resolveView();
    view.append(FILE, noticeMessage('payroll.sql', { message: 'kept' }, AT));

    view.runStarting(FILE);

    assert.equal(view.clearOnExecute, false, 'off by default');
    assert.equal(view.log.get(FILE.key)?.total, 1);
});

test('Clear on Execute is a setting, off by default, in the group of the SQL files', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const group = manifest.contributes.configuration.find((g: { title: string }) => g.title === 'SQL & Data Viewer');
    const setting = group.properties['postgresQueryBuilder.messages.clearOnExecute'];
    assert.equal(setting.type, 'boolean');
    assert.equal(setting.default, false);
    assert.match(setting.description, /Clear on Execute/);
});

test('the panel is told how its checkbox is set when it is ready and when the setting changes', (t) => {
    let value = true;
    const original = vscodeStub.workspace.getConfiguration;
    vscodeStub.workspace.getConfiguration = (() => ({ get: () => value })) as any;
    t.after(() => { vscodeStub.workspace.getConfiguration = original; });
    const { send, posted } = resolveView();

    send({ type: 'ready' });
    assert.deepEqual(posted.filter((m: any) => m.type === 'options'), [{ type: 'options', clearOnExecute: true }]);

    value = false;
    fireDidChangeConfiguration(['postgresQueryBuilder.format.enable']);
    assert.equal(posted.filter((m: any) => m.type === 'options').length, 1, 'another setting changes nothing');
    fireDidChangeConfiguration(['postgresQueryBuilder.messages.clearOnExecute']);
    assert.deepEqual(posted.filter((m: any) => m.type === 'options').at(-1), { type: 'options', clearOnExecute: false });
});

test('the checkbox stores Clear on Execute as a user setting', async (t) => {
    const writes = stubClearOnExecute(t, false);
    const { send } = resolveView();

    send({ type: 'clearOnExecute', value: true });
    send({ type: 'clearOnExecute', value: 'yes' });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(writes, [
        ['postgresQueryBuilder', 'messages.clearOnExecute', true, vscodeStub.ConfigurationTarget.Global],
        ['postgresQueryBuilder', 'messages.clearOnExecute', false, vscodeStub.ConfigurationTarget.Global]
    ], 'only a true value turns it on');
});

test('a checkbox that could not be stored says so and shows the setting as it is', async (t) => {
    const errors: unknown[] = [];
    const originals = { config: vscodeStub.workspace.getConfiguration, error: vscodeStub.window.showErrorMessage };
    vscodeStub.workspace.getConfiguration = (() => ({ get: () => false, update: () => Promise.reject(new Error('read-only settings')) })) as any;
    vscodeStub.window.showErrorMessage = (message: string) => { errors.push(message); return Promise.resolve(undefined); };
    t.after(() => {
        vscodeStub.workspace.getConfiguration = originals.config;
        vscodeStub.window.showErrorMessage = originals.error;
    });
    const { send, last } = resolveView();

    send({ type: 'clearOnExecute', value: true });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(errors, ['"Clear on Execute" could not be saved: read-only settings']);
    assert.deepEqual(last(), { type: 'options', clearOnExecute: false }, 'the checkbox is unticked again');
});

test('the panel offers Clear on Execute as a labelled checkbox and reports a change', () => {
    const { html } = resolveView();
    assert.match(html, /<label class="clear-on-execute" title="[^"]+"><input type="checkbox" id="clearOnExecute">Clear on Execute<\/label>/);

    const panel = runPanelScript();
    const box = panel.elements.clearOnExecute as any;
    panel.send({ type: 'options', clearOnExecute: true });
    assert.equal(box.checked, true);

    box.checked = false;
    box.listeners.change();
    assert.deepEqual(panel.sent.at(-1), { type: 'clearOnExecute', value: false });
});
