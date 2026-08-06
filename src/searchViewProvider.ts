import * as vscode from 'vscode';
import { buildHtmlDocument } from './webviewUtils';
import { icon } from './webviewAssets';

export class SearchViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'postgresTableSearch';

    private _view?: vscode.WebviewView;
    private _onDidChangeFilter = new vscode.EventEmitter<string>();
    readonly onDidChangeFilter = this._onDidChangeFilter.event;
    private _onDidRequestManageMappings = new vscode.EventEmitter<void>();
    readonly onDidRequestManageMappings = this._onDidRequestManageMappings.event;

    private _filterText = '';

    get filterText(): string {
        return this._filterText;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true
        };

        webviewView.webview.html = this._getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage((message) => {
            if (message.type === 'filter') {
                this._filterText = message.value;
                this._onDidChangeFilter.fire(this._filterText);
            } else if (message.type === 'selectConnection') {
                vscode.commands.executeCommand('postgresQueryBuilder.selectConnection');
            } else if (message.type === 'newConnection') {
                vscode.commands.executeCommand('postgresQueryBuilder.connect');
            } else if (message.type === 'disconnect') {
                vscode.commands.executeCommand('postgresQueryBuilder.disconnect');
            } else if (message.type === 'manageMappings') {
                this._onDidRequestManageMappings.fire();
            }
        });
    }

    private _getHtml(webview: vscode.Webview): string {
        const styles = `
        body {
            padding: var(--sp-2);
        }
        .button-row {
            display: flex;
            gap: var(--sp-1);
            margin-bottom: var(--sp-2);
            flex-wrap: wrap;
        }
        .button-row .btn {
            flex: 1 1 auto;
        }
        #searchInput {
            width: 100%;
        }
        .hint {
            margin-top: var(--sp-1);
        }`;
        const body = `
    <div class="button-row">
        <button class="btn btn-primary" id="selectConnBtn" title="Choose an existing saved connection">${icon('database')}Select Connection</button>
        <button class="btn" id="newConnBtn" title="Create a new connection">${icon('add')}New</button>
        <button class="btn" id="disconnectBtn" title="Disconnect">${icon('plug')}Disconnect</button>
    </div>
    <div class="button-row">
        <button class="btn" id="manageMappingsBtn" title="Open the manager for all custom column mappings (bulk share/move/delete)">${icon('goto')}Manage All Mappings…</button>
    </div>
    <div class="search-container">
        <input type="text" id="searchInput" placeholder="Filter tables... (e.g. schema.table or multiple terms)" />
    </div>
    <div class="hint">Mehrere mit Leerzeichen getrennte Begriffe: Treffer mit den meisten Übereinstimmungen oben</div>`;
        const script = `
        const vscode = acquireVsCodeApi();
        const input = document.getElementById('searchInput');
        let debounceTimer;
        input.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                vscode.postMessage({ type: 'filter', value: input.value });
            }, 200);
        });
        document.getElementById('selectConnBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'selectConnection' });
        });
        document.getElementById('newConnBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'newConnection' });
        });
        document.getElementById('disconnectBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'disconnect' });
        });
        document.getElementById('manageMappingsBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'manageMappings' });
        });
        input.focus();`;
        return buildHtmlDocument({ webview, styles, body, script });
    }
}
