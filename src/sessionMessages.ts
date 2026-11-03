import * as vscode from 'vscode';
import type { DbSessionRef, SessionNotice } from './dbSession';
import { getErrorMessage, Logger } from './logger';
import { buildHtmlDocument, WEBVIEW_ESCAPE_HTML_JS } from './webviewUtils';
import { icon } from './webviewAssets';

/** The panel that shows what the server said besides results, one log per database session. */
export const MESSAGES_PANEL_NAME = 'PostgreSQL Messages';

/** The webview view of that panel. */
export const MESSAGES_VIEW_ID = 'postgresSessionMessages';

/** A log keeps this many messages; older ones are dropped. */
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
    messages: SessionMessage[];
}

/**
 * One log per database session, under the session's key: the tabs and files
 * sharing a session share its log. A log is created by its first message and
 * lives until it is discarded — when the session ends.
 */
export class SessionMessageLog {
    private readonly logs = new Map<string, SessionLog>();
    private readonly listeners = new Set<(key: string) => void>();

    constructor(private readonly limit: number = MAX_MESSAGES_PER_LOG) {}

    append(ref: DbSessionRef, message: SessionMessage): void {
        let log = this.logs.get(ref.key);
        if (!log) {
            log = { key: ref.key, label: ref.label, messages: [] };
            this.logs.set(ref.key, log);
        }
        log.messages.push(message);
        if (log.messages.length > this.limit) {
            log.messages.splice(0, log.messages.length - this.limit);
        }
        this.emit(ref.key);
    }

    get(key: string): SessionLog | undefined {
        return this.logs.get(key);
    }

    /** Empty the log of `key`, which stays for further messages. */
    clear(key: string): void {
        const log = this.logs.get(key);
        if (!log || log.messages.length === 0) return;
        log.messages = [];
        this.emit(key);
    }

    /** Forget the log of `key` entirely, because its session has ended. */
    discard(key: string): void {
        if (this.logs.delete(key)) {
            this.emit(key);
        }
    }

    onDidChange(listener: (key: string) => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
    }

    private emit(key: string): void {
        for (const listener of [...this.listeners]) {
            listener(key);
        }
    }
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
}

export function messagesViewState(shown: DbSessionRef | undefined, log: SessionLog | undefined): MessagesViewState {
    return {
        label: shown ? shown.label : null,
        messages: (log?.messages ?? []).map((message) => ({ ...message, tone: messageTone(message.severity) }))
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
            }
        });
    }

    dispose(): void {
        this.subscription.dispose();
        this.view = undefined;
    }

    private async copy(): Promise<void> {
        const messages = this.shown ? this.log.get(this.shown.key)?.messages ?? [] : [];
        if (messages.length === 0) return;
        try {
            await vscode.env.clipboard.writeText(messages.map(formatSessionMessage).join('\n'));
            vscode.window.setStatusBarMessage(`Copied ${messages.length} ${messages.length === 1 ? 'message' : 'messages'}.`, 3000);
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
        <button class="btn btn-sm" id="copyBtn" title="Copy the messages of this session to the clipboard">${icon('copy')}Copy</button>
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
const clearBtn = document.getElementById('clearBtn');
copyBtn.addEventListener('click', () => vscode.postMessage({ type: 'copy' }));
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
    countEl.textContent = state.label ? messages.length + ' ' + (messages.length === 1 ? 'message' : 'messages') : '';
    copyBtn.disabled = messages.length === 0;
    clearBtn.disabled = messages.length === 0;
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
