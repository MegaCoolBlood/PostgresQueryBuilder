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
    private _onDidRequestPsqlConsole = new vscode.EventEmitter<void>();
    readonly onDidRequestPsqlConsole = this._onDidRequestPsqlConsole.event;

    private _filterText = '';

    get filterText(): string {
        return this._filterText;
    }

    /** Empty the Search field and clear the filter of every view it filters. */
    clearFilter(): void {
        this._filterText = '';
        void this._view?.webview.postMessage({ type: 'setFilter', value: '' });
        this._onDidChangeFilter.fire('');
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
            } else if (message.type === 'manageMappings') {
                this._onDidRequestManageMappings.fire();
            } else if (message.type === 'openPsqlConsole') {
                this._onDidRequestPsqlConsole.fire();
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
            margin-top: var(--sp-2);
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
    <div class="search-container">
        <input type="text" id="searchInput" placeholder="Filter tables and objects... (e.g. schema.name or multiple terms)" />
    </div>
    <div class="hint">Filters the Tables and the Objects view. Several terms separated by spaces: the matches with the most hits come first</div>
    <div class="button-row">
        <button class="btn" id="manageMappingsBtn" title="Open the manager for all custom column mappings (bulk share/move/delete)">${icon('goto')}Manage All Mappings</button>
    </div>
    <div class="button-row">
        <button class="btn" id="psqlConsoleBtn" title="Open psql for the active connection in a terminal">${icon('terminal')}Open psql Console</button>
    </div>`;
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
        document.getElementById('manageMappingsBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'manageMappings' });
        });
        document.getElementById('psqlConsoleBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'openPsqlConsole' });
        });
        window.addEventListener('message', (event) => {
            if (event.data && event.data.type === 'setFilter') {
                clearTimeout(debounceTimer);
                input.value = event.data.value;
            }
        });
        input.focus();`;
        return buildHtmlDocument({ webview, styles, body, script });
    }
}
