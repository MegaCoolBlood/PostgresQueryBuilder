import * as vscode from 'vscode';
import { ModifyHistoryStore } from './modifyHistoryStore';

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
        webviewView.webview.html = this._getHtml();

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

    private _getHtml(): string {
        return `<!DOCTYPE html>
<html>
<head>
<style>
body { padding: 0; margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
.toolbar { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.toolbar .count { font-size: 11px; color: var(--vscode-descriptionForeground); }
.toolbar button { padding: 2px 8px; font-size: 11px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; cursor: pointer; }
.toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
.list { overflow-y: auto; }
.empty { padding: 12px; text-align: center; font-size: 12px; color: var(--vscode-descriptionForeground); }
.entry { padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); cursor: pointer; }
.entry:hover { background: var(--vscode-list-hoverBackground); }
.entry-meta { font-size: 10px; color: var(--vscode-descriptionForeground); display: flex; justify-content: space-between; gap: 8px; margin-bottom: 2px; }
.entry-sql { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>
<div class="toolbar">
    <span class="count" id="count">0 entries</span>
    <button id="clearBtn" title="Clear modify history">Clear</button>
</div>
<div class="list" id="list"></div>
<script>
const vscode = acquireVsCodeApi();
const listEl = document.getElementById('list');
const countEl = document.getElementById('count');
document.getElementById('clearBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'clear' });
});

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}

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

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
    }
}
