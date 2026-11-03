import './helpers/vscodeMock';
import { vscodeStub } from './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    MESSAGES_VIEW_ID,
    MessageSpool,
    SessionMessageLog,
    SessionMessagesView,
    exportMessage,
    formatSessionMessage,
    messageTone,
    messagesCountText,
    messagesFileName,
    messagesViewState,
    noticeMessage
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
    assert.deepEqual(messagesViewState(TAB, undefined), { label: 'View Data: SELECT 1', messages: [], total: 0, countText: '0 messages' });
    assert.deepEqual(messagesViewState(undefined, undefined), { label: null, messages: [], total: 0, countText: '' });
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
    const view = new SessionMessagesView(log);
    const posted: any[] = [];
    let handler: (msg: any) => void = () => undefined;
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
        show: (preserveFocus: boolean) => { shownWithFocus.push(preserveFocus); },
        onDidDispose: () => ({ dispose() {} })
    };
    view.resolveWebviewView(webviewView, {} as any, {} as any);
    return {
        view,
        html: webview.html as string,
        posted,
        send: (msg: any) => handler(msg),
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
    assert.equal(resolved.last().state.messages.length, 2, 'the panel shows only the newest');

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
    assert.equal(resolved.last().state.countText, 'last 1 of 2 messages');

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
