import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DbSessionRef, SessionNotice } from './dbSession';
import { getErrorMessage, Logger } from './logger';
import { buildHtmlDocument, WEBVIEW_ESCAPE_HTML_JS } from './webviewUtils';
import { icon } from './webviewAssets';

/** The panel that shows what the server said besides results, one log per database session. */
export const MESSAGES_PANEL_NAME = 'PostgreSQL Messages';

/** The webview view of that panel. */
export const MESSAGES_VIEW_ID = 'postgresSessionMessages';

/** The panel keeps this many messages of a log; *Save* writes all of them. */
export const MAX_MESSAGES_PER_LOG = 2000;

/** One entry of a session's log. */
export interface SessionMessage {
    /** Local time it arrived, `HH:MM:SS`. */
    time: string;
    /** What it came from: the file or tab whose statement caused it. */
    source: string;
    /** `NOTICE`, `INFO`, `WARNING`, `ERROR`, … as the server sent it, or `EXPORT`. */
    severity: string;
    text: string;
    /** Further lines such as `DETAIL: …`, `HINT: …`, `CONTEXT: …`. */
    details: string[];
}

/** The colour token a message is shown in. */
export type MessageTone = 'danger' | 'warning' | 'success' | 'info';

function clockTime(now: Date): string {
    return now.toTimeString().slice(0, 8);
}

/** A message of the server — `RAISE NOTICE`, a warning, the error of a failed statement — as a log entry. */
export function noticeMessage(source: string, notice: SessionNotice, now: Date = new Date()): SessionMessage {
    const details: string[] = [];
    if (notice.detail) details.push(`DETAIL: ${notice.detail}`);
    if (notice.hint) details.push(`HINT: ${notice.hint}`);
    if (notice.where) details.push(`CONTEXT: ${notice.where.replace(/\n/g, '\n         ')}`);
    return { time: clockTime(now), source, severity: notice.severity || 'NOTICE', text: notice.message ?? '', details };
}

/** An `-- @export` of the query on 0-based `line` that wrote `rows` rows to `filePath`. */
export function exportMessage(source: string, line: number, rows: number, filePath: string, now: Date = new Date()): SessionMessage {
    return {
        time: clockTime(now),
        source,
        severity: 'EXPORT',
        text: `line ${line + 1}, ${rows} ${rows === 1 ? 'row' : 'rows'} to ${filePath}`,
        details: []
    };
}

/** A log entry as plain text, e.g. for the clipboard: one line plus its indented detail lines. */
export function formatSessionMessage(message: SessionMessage): string {
    const lines = [`[${message.time}] ${message.source} — ${message.severity}: ${message.text}`];
    for (const detail of message.details) {
        lines.push(`    ${detail.replace(/\n/g, '\n    ')}`);
    }
    return lines.join('\n');
}

export function messageTone(severity: string): MessageTone {
    switch (severity.toUpperCase()) {
        case 'ERROR':
        case 'FATAL':
        case 'PANIC':
            return 'danger';
        case 'WARNING':
            return 'warning';
        case 'EXPORT':
            return 'success';
        default:
            return 'info';
    }
}

/** The messages of one database session. */
export interface SessionLog {
    key: string;
    label: string;
    /** The newest messages, at most the limit of the log. */
    messages: SessionMessage[];
    /** Every message since the log began or was cleared, including those no longer kept. */
    total: number;
}

type SpoolOperation = { kind: 'append'; text: string } | { kind: 'truncate' } | { kind: 'remove' };

/**
 * A file that receives every message of one log, so *Save* can write more of
 * them than the panel keeps. Writes are queued and run one after the other,
 * consecutive messages in one write, so a flood of `RAISE NOTICE` neither
 * blocks the extension host nor reorders the file.
 */
export class MessageSpool {
    private operations: SpoolOperation[] = [];
    private running?: Promise<void>;
    private removed = false;

    constructor(readonly filePath: string) {}

    write(text: string): void {
        if (this.removed) return;
        const last = this.operations[this.operations.length - 1];
        if (last?.kind === 'append') {
            last.text += text;
        } else {
            this.operations.push({ kind: 'append', text });
        }
        this.pump();
    }

    /** Empty the file; what was still waiting to be written is dropped as well. */
    truncate(): void {
        if (this.removed) return;
        this.operations = [{ kind: 'truncate' }];
        this.pump();
    }

    /** Delete the file; nothing is written to it any more. */
    remove(): void {
        if (this.removed) return;
        this.removed = true;
        this.operations = [{ kind: 'remove' }];
        this.pump();
    }

    /** Settles once everything queued so far has reached the file. */
    async idle(): Promise<void> {
        while (this.running) {
            await this.running;
        }
    }

    /** Write the whole file to `target`, after everything queued has reached it. */
    async copyTo(target: string): Promise<void> {
        await this.idle();
        if (fs.existsSync(this.filePath)) {
            await fs.promises.copyFile(this.filePath, target);
        } else {
            await fs.promises.writeFile(target, '', 'utf8');
        }
    }

    /** The whole file, after everything queued has reached it. */
    async read(): Promise<string> {
        await this.idle();
        return fs.existsSync(this.filePath) ? fs.promises.readFile(this.filePath, 'utf8') : '';
    }

    private pump(): void {
        if (this.running) return;
        this.running = (async () => {
            while (this.operations.length > 0) {
                const operation = this.operations.shift() as SpoolOperation;
                try {
                    if (operation.kind === 'append') {
                        await fs.promises.appendFile(this.filePath, operation.text, 'utf8');
                    } else if (operation.kind === 'truncate') {
                        await fs.promises.writeFile(this.filePath, '', 'utf8');
                    } else {
                        await fs.promises.rm(this.filePath, { force: true });
                    }
                } catch (err: unknown) {
                    Logger.error('MessageSpool.pump', err);
                }
            }
        })().finally(() => {
            this.running = undefined;
            if (this.operations.length > 0) this.pump();
        });
    }
}

export interface SessionMessageLogOptions {
    /** How many messages a log keeps for the panel; default {@link MAX_MESSAGES_PER_LOG}. */
    limit?: number;
    /**
     * The folder in which a temporary folder for the spool files is made on
     * the first message, e.g. `os.tmpdir()`. Without it nothing is spooled and
     * *Save* writes only the messages the log keeps.
     */
    spoolRoot?: string;
}

/**
 * One log per database session, under the session's key: the tabs and files
 * sharing a session share its log. A log is created by its first message and
 * lives until it is discarded — when the session ends. It keeps the newest
 * messages for the panel and spools every message to a file of its own.
 */
export class SessionMessageLog {
    private readonly logs = new Map<string, SessionLog>();
    private readonly spools = new Map<string, MessageSpool>();
    /** Spools of discarded logs whose file is still being deleted. */
    private readonly retiring = new Set<MessageSpool>();
    private readonly listeners = new Set<(key: string) => void>();
    private readonly limit: number;
    private readonly spoolRoot?: string;
    private spoolDir?: string;
    private spoolCounter = 0;

    constructor(options: SessionMessageLogOptions = {}) {
        this.limit = options.limit ?? MAX_MESSAGES_PER_LOG;
        this.spoolRoot = options.spoolRoot;
    }

    append(ref: DbSessionRef, message: SessionMessage): void {
        let log = this.logs.get(ref.key);
        if (!log) {
            log = { key: ref.key, label: ref.label, messages: [], total: 0 };
            this.logs.set(ref.key, log);
        }
        log.messages.push(message);
        log.total++;
        if (log.messages.length > this.limit) {
            log.messages.splice(0, log.messages.length - this.limit);
        }
        this.spoolOf(ref.key)?.write(`${formatSessionMessage(message)}\n`);
        this.emit(ref.key);
    }

    get(key: string): SessionLog | undefined {
        return this.logs.get(key);
    }

    /** Empty the log of `key`, which stays for further messages. */
    clear(key: string): void {
        const log = this.logs.get(key);
        if (!log || log.total === 0) return;
        log.messages = [];
        log.total = 0;
        this.spools.get(key)?.truncate();
        this.emit(key);
    }

    /** Forget the log of `key` entirely, because its session has ended. */
    discard(key: string): void {
        const spool = this.spools.get(key);
        if (spool) {
            spool.remove();
            this.spools.delete(key);
            this.retiring.add(spool);
            void spool.idle().then(() => this.retiring.delete(spool));
        }
        if (this.logs.delete(key)) {
            this.emit(key);
        }
    }

    /**
     * Write every message of the log of `key` — not only those it keeps — to
     * `target`, one per line as they are copied. Returns how many were written.
     */
    async saveTo(key: string, target: string): Promise<number> {
        const log = this.logs.get(key);
        const spool = this.spools.get(key);
        if (spool) {
            await spool.copyTo(target);
        } else {
            await fs.promises.writeFile(target, this.keptText(log), 'utf8');
        }
        return log?.total ?? 0;
    }

    /**
     * Every message of the log of `key` — not only those it keeps — as text,
     * one per line as *Save* writes them.
     */
    async readAll(key: string): Promise<{ text: string; count: number }> {
        const log = this.logs.get(key);
        const spool = this.spools.get(key);
        const text = spool ? await spool.read() : this.keptText(log);
        return { text, count: log?.total ?? 0 };
    }

    private keptText(log: SessionLog | undefined): string {
        return (log?.messages ?? []).map((m) => `${formatSessionMessage(m)}\n`).join('');
    }

    /** Settles once every spool — also one being deleted — has done what it was given. */
    async idle(): Promise<void> {
        await Promise.all([...this.spools.values(), ...this.retiring].map((spool) => spool.idle()));
    }

    onDidChange(listener: (key: string) => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
    }

    /** Forget every log and delete the spool files. */
    dispose(): void {
        for (const spool of this.spools.values()) {
            spool.remove();
        }
        this.logs.clear();
        this.spools.clear();
        this.retiring.clear();
        this.listeners.clear();
        if (this.spoolDir) {
            try {
                fs.rmSync(this.spoolDir, { recursive: true, force: true });
            } catch (err: unknown) {
                Logger.error('SessionMessageLog.dispose', err);
            }
            this.spoolDir = undefined;
        }
    }

    private spoolOf(key: string): MessageSpool | undefined {
        const existing = this.spools.get(key);
        if (existing || !this.spoolRoot) return existing;
        try {
            this.spoolDir ??= fs.mkdtempSync(path.join(this.spoolRoot, 'pqb-messages-'));
        } catch (err: unknown) {
            // Without a spool the log still shows and saves what it keeps.
            Logger.error('SessionMessageLog.spoolOf', err);
            return undefined;
        }
        const spool = new MessageSpool(path.join(this.spoolDir, `session-${++this.spoolCounter}.log`));
        this.spools.set(key, spool);
        return spool;
    }

    private emit(key: string): void {
        for (const listener of [...this.listeners]) {
            listener(key);
        }
    }
}

/**
 * The name *Save* suggests for the log of the session `label`, e.g.
 * `payroll-messages-2026-11-03.log` for `payroll.sql`.
 */
export function messagesFileName(label: string, now: Date = new Date()): string {
    const base = label
        .replace(/\.(sql|pgsql|psql)$/i, '')
        .replace(/[\\/:*?"<>|\s]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60) || 'session';
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${base}-messages-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.log`;
}

/** Where the statements of a session report what the server said. */
export interface SessionMessageSink {
    append(ref: DbSessionRef, message: SessionMessage): void;
    /** Show the log of `ref` and bring the panel into view without taking the focus. */
    reveal(ref: DbSessionRef): void;
}

/** What the panel is told to show. */
export interface MessagesViewState {
    /** The session shown, or null while no SQL file or Data Viewer has been active. */
    label: string | null;
    messages: Array<SessionMessage & { tone: MessageTone }>;
    /** Every message of the log, of which `messages` are the newest. */
    total: number;
    /** E.g. `12 messages`, or `last 2000 of 5234 messages` once the panel no longer shows them all. */
    countText: string;
}

/** How many messages the panel shows, and of how many when it no longer shows all of them. */
export function messagesCountText(shown: number, total: number): string {
    const noun = total === 1 ? 'message' : 'messages';
    return shown < total ? `last ${shown} of ${total} ${noun}` : `${total} ${noun}`;
}

export function messagesViewState(shown: DbSessionRef | undefined, log: SessionLog | undefined): MessagesViewState {
    const messages = log?.messages ?? [];
    const total = log?.total ?? 0;
    return {
        label: shown ? shown.label : null,
        messages: messages.map((message) => ({ ...message, tone: messageTone(message.severity) })),
        total,
        countText: shown ? messagesCountText(messages.length, total) : ''
    };
}

/**
 * The *PostgreSQL Messages* panel. It shows the log of one session at a time:
 * that of the SQL file or Data Viewer tab that was active last.
 */
export class SessionMessagesView implements vscode.WebviewViewProvider, SessionMessageSink, vscode.Disposable {
    static readonly viewType = MESSAGES_VIEW_ID;

    private view?: vscode.WebviewView;
    private shown?: DbSessionRef;
    private readonly subscription: { dispose(): void };

    constructor(readonly log: SessionMessageLog) {
        this.subscription = log.onDidChange((key) => {
            if (key === this.shown?.key) this.render();
        });
    }

    /** The session whose log is shown, if any. */
    get shownSession(): DbSessionRef | undefined {
        return this.shown;
    }

    append(ref: DbSessionRef, message: SessionMessage): void {
        this.log.append(ref, message);
    }

    /** Switch the panel to the log of `ref`. */
    show(ref: DbSessionRef): void {
        if (this.shown && this.shown.key === ref.key && this.shown.label === ref.label) return;
        this.shown = { key: ref.key, label: ref.label };
        this.render();
    }

    reveal(ref: DbSessionRef): void {
        this.show(ref);
        if (this.view) {
            this.view.show(true);
            return;
        }
        // Not resolved yet: open it through the command every view gets.
        Promise.resolve(vscode.commands.executeCommand(`${MESSAGES_VIEW_ID}.focus`, { preserveFocus: true }))
            .catch((err: unknown) => Logger.error('SessionMessagesView.reveal', err));
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml(webviewView.webview);
        webviewView.onDidDispose?.(() => {
            if (this.view === webviewView) this.view = undefined;
        });
        webviewView.webview.onDidReceiveMessage((message: { type?: string }) => {
            if (message.type === 'ready') {
                this.render();
            } else if (message.type === 'clear') {
                if (this.shown) this.log.clear(this.shown.key);
            } else if (message.type === 'copy') {
                void this.copy();
            } else if (message.type === 'save') {
                void this.save();
            }
        });
    }

    dispose(): void {
        this.subscription.dispose();
        this.view = undefined;
        this.log.dispose();
    }

    /** Write every message of the shown log to a file the user picks. */
    private async save(): Promise<void> {
        const shown = this.shown;
        if (!shown || !this.log.get(shown.key)?.total) return;
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(folder, messagesFileName(shown.label))),
            filters: { 'Log Files': ['log', 'txt'] },
            title: `Save the Messages of ${shown.label}`
        });
        if (!uri) return;
        try {
            const count = await this.log.saveTo(shown.key, uri.fsPath);
            vscode.window.setStatusBarMessage(`Saved ${count} ${count === 1 ? 'message' : 'messages'} to ${uri.fsPath}.`, 5000);
        } catch (err: unknown) {
            Logger.error('SessionMessagesView.save', err);
            vscode.window.showErrorMessage(`Saving the messages failed: ${getErrorMessage(err)}`);
        }
    }

    /** Put every message of the shown log on the clipboard, as *Save* writes them. */
    private async copy(): Promise<void> {
        const shown = this.shown;
        if (!shown || !this.log.get(shown.key)?.total) return;
        try {
            const { text, count } = await this.log.readAll(shown.key);
            await vscode.env.clipboard.writeText(text.replace(/\n$/, ''));
            vscode.window.setStatusBarMessage(`Copied ${count} ${count === 1 ? 'message' : 'messages'}.`, 3000);
        } catch (err: unknown) {
            Logger.error('SessionMessagesView.copy', err);
            vscode.window.showErrorMessage(`Copying the messages failed: ${getErrorMessage(err)}`);
        }
    }

    private render(): void {
        if (!this.view) return;
        const state = messagesViewState(this.shown, this.shown ? this.log.get(this.shown.key) : undefined);
        Promise.resolve(this.view.webview.postMessage({ type: 'log', key: this.shown?.key ?? null, state }))
            .catch(() => undefined);
    }

    private getHtml(webview: vscode.Webview): string {
        const styles = `
html, body { height: 100%; }
body { padding: 0; display: flex; flex-direction: column; }
.toolbar { justify-content: space-between; flex-wrap: nowrap; padding: var(--sp-1) var(--sp-2); border-bottom: 1px solid var(--c-border); }
.session { display: flex; align-items: baseline; gap: var(--sp-2); min-width: 0; }
.session-label { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count { font-size: var(--fs-xs); color: var(--c-muted); white-space: nowrap; }
.list { flex: 1; overflow-y: auto; padding: var(--sp-1) 0; font-family: var(--font-mono); font-size: var(--fs-sm); }
.empty { padding: var(--sp-3); font-family: inherit; color: var(--c-muted); }
.msg { padding: 1px var(--sp-2); white-space: pre-wrap; word-break: break-word; user-select: text; }
.msg-time, .msg-source { color: var(--c-muted); }
.msg-sev { font-weight: 600; }
.msg.tone-danger .msg-sev { color: var(--c-danger); }
.msg.tone-warning .msg-sev { color: var(--c-warning); }
.msg.tone-success .msg-sev { color: var(--c-success); }
.msg.tone-info .msg-sev { color: var(--c-info); }
.msg.tone-danger { background: color-mix(in srgb, var(--c-danger) 8%, transparent); }
.msg-detail { padding-left: var(--sp-5); color: var(--c-muted); }`;
        const body = `
<div class="toolbar">
    <div class="session"><span class="session-label" id="label"></span><span class="count" id="count"></span></div>
    <div class="toolbar-group">
        <button class="btn btn-sm" id="copyBtn" title="Copy every message of this session to the clipboard, including those the panel no longer shows">${icon('copy')}Copy</button>
        <button class="btn btn-sm" id="saveBtn" title="Save every message of this session to a file, including those the panel no longer shows">${icon('save')}Save</button>
        <button class="btn btn-sm" id="clearBtn" title="Clear the messages of this session">${icon('trash')}Clear</button>
    </div>
</div>
<div class="list" id="list"></div>`;
        const script = `
const vscode = acquireVsCodeApi();
const listEl = document.getElementById('list');
const labelEl = document.getElementById('label');
const countEl = document.getElementById('count');
const copyBtn = document.getElementById('copyBtn');
const saveBtn = document.getElementById('saveBtn');
const clearBtn = document.getElementById('clearBtn');
copyBtn.addEventListener('click', () => vscode.postMessage({ type: 'copy' }));
saveBtn.addEventListener('click', () => vscode.postMessage({ type: 'save' }));
clearBtn.addEventListener('click', () => vscode.postMessage({ type: 'clear' }));

${WEBVIEW_ESCAPE_HTML_JS}

let shownKey = null;

function render(key, state) {
    const switched = key !== shownKey;
    shownKey = key;
    const atBottom = listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 4;
    const messages = state.messages || [];
    labelEl.textContent = state.label ? 'Session of ' + state.label : 'No session';
    labelEl.title = state.label ? 'The database session of ' + state.label + ' and every tab sharing it' : '';
    countEl.textContent = state.countText || '';
    copyBtn.disabled = !state.total;
    saveBtn.disabled = !state.total;
    clearBtn.disabled = !state.total;
    if (!state.label) {
        listEl.innerHTML = '<div class="empty">Open a SQL file or a Data Viewer tab to see the messages of its database session.</div>';
        return;
    }
    if (messages.length === 0) {
        listEl.innerHTML = '<div class="empty">No messages from the database session of ' + escapeHtml(state.label) + ' yet.</div>';
        return;
    }
    let html = '';
    for (const m of messages) {
        html += '<div class="msg tone-' + escapeHtml(m.tone) + '">'
            + '<span class="msg-time">[' + escapeHtml(m.time) + ']</span> '
            + (m.source && m.source !== state.label ? '<span class="msg-source">' + escapeHtml(m.source) + ' — </span>' : '')
            + '<span class="msg-sev">' + escapeHtml(m.severity) + ':</span> '
            + '<span class="msg-text">' + escapeHtml(m.text) + '</span>';
        for (const d of m.details || []) {
            html += '<div class="msg-detail">' + escapeHtml(d) + '</div>';
        }
        html += '</div>';
    }
    listEl.innerHTML = html;
    if (switched || atBottom) {
        listEl.scrollTop = listEl.scrollHeight;
    }
}

window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg && msg.type === 'log') {
        render(msg.key, msg.state);
    }
});

vscode.postMessage({ type: 'ready' });`;
        return buildHtmlDocument({ webview, title: MESSAGES_PANEL_NAME, styles, body, script });
    }
}
