import * as vscode from 'vscode';
import { ModifyHistoryStore } from './modifyHistoryStore';
import { buildHtmlDocument, WEBVIEW_ESCAPE_HTML_JS } from './webviewUtils';
import { icon } from './webviewAssets';

export class ModifyHistoryViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'postgresModifyHistory';

    private _view?: vscode.WebviewView;

    constructor(private store: ModifyHistoryStore) {
        store.onDidChange(() => this.refresh());
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage((message) => {
            if (message.type === 'ready') {
                this.refresh();
            } else if (message.type === 'clear') {
                this.store.clear();
            } else if (message.type === 'copy') {
                vscode.env.clipboard.writeText(message.sql || '');
                vscode.window.showInformationMessage('SQL copied to clipboard');
            }
        });
    }

    refresh(): void {
        if (!this._view) return;
        this._view.webview.postMessage({
            type: 'history',
            entries: this.store.getAll()
        });
    }

    private _getHtml(webview: vscode.Webview): string {
        const styles = `
body { padding: 0; }
.toolbar { justify-content: space-between; padding: var(--sp-1) var(--sp-2); border-bottom: 1px solid var(--c-border); }
.toolbar .count { font-size: var(--fs-xs); color: var(--c-muted); }
.list { overflow-y: auto; }
.empty { padding: var(--sp-3); text-align: center; font-size: var(--fs-sm); color: var(--c-muted); }
.entry { padding: var(--sp-2); border-bottom: 1px solid var(--c-border); cursor: pointer; }
.entry:hover { background: var(--c-hover); }
.entry-meta { font-size: var(--fs-xs); color: var(--c-muted); display: flex; justify-content: space-between; gap: var(--sp-2); margin-bottom: 2px; }
.entry-sql { font-family: var(--font-mono); font-size: var(--fs-sm); white-space: pre-wrap; word-break: break-word; }`;
        const body = `
<div class="toolbar">
    <span class="count" id="count">0 entries</span>
    <button class="btn btn-sm" id="clearBtn" title="Clear modify history">${icon('trash')}Clear</button>
</div>
<div class="list" id="list"></div>`;
        const script = `
const vscode = acquireVsCodeApi();
const listEl = document.getElementById('list');
const countEl = document.getElementById('count');
document.getElementById('clearBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'clear' });
});

${WEBVIEW_ESCAPE_HTML_JS}

function formatTime(ts) {
    try {
        const d = new Date(ts);
        return d.toLocaleString();
    } catch { return String(ts); }
}

function render(entries) {
    countEl.textContent = entries.length + ' ' + (entries.length === 1 ? 'entry' : 'entries');
    if (entries.length === 0) {
        listEl.innerHTML = '<div class="empty">No executed modifying statements yet.</div>';
        return;
    }
    let html = '';
    entries.forEach((e, i) => {
        const target = (e.schema && e.table) ? (e.schema + '.' + e.table) : '';
        html += '<div class="entry" data-idx="' + i + '" title="Click to copy">';
        html += '<div class="entry-meta"><span>' + escapeHtml(target) + '</span><span>' + escapeHtml(formatTime(e.timestamp)) + '</span></div>';
        html += '<div class="entry-sql">' + escapeHtml(e.sql) + '</div>';
        html += '</div>';
    });
    listEl.innerHTML = html;
    listEl.querySelectorAll('.entry').forEach(div => {
        div.addEventListener('click', () => {
            const idx = parseInt(div.getAttribute('data-idx'));
            const e = currentEntries[idx];
            if (e) vscode.postMessage({ type: 'copy', sql: e.sql });
        });
    });
}

let currentEntries = [];
window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg.type === 'history') {
        currentEntries = msg.entries || [];
        render(currentEntries);
    }
});

vscode.postMessage({ type: 'ready' });`;
        return buildHtmlDocument({ webview, styles, body, script });
    }
}
