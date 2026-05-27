import * as vscode from 'vscode';

export class SearchViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'postgresTableSearch';

    private _view?: vscode.WebviewView;
    private _onDidChangeFilter = new vscode.EventEmitter<string>();
    readonly onDidChangeFilter = this._onDidChangeFilter.event;

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

        webviewView.webview.html = this._getHtml();

        webviewView.webview.onDidReceiveMessage((message) => {
            if (message.type === 'filter') {
                this._filterText = message.value;
                this._onDidChangeFilter.fire(this._filterText);
            }
        });
    }

    private _getHtml(): string {
        return `<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            padding: 4px 8px;
            margin: 0;
        }
        .search-container {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        input {
            width: 100%;
            padding: 4px 8px;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-size: 13px;
            border-radius: 2px;
            outline: none;
            box-sizing: border-box;
        }
        input:focus {
            border-color: var(--vscode-focusBorder);
        }
        input::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }
        .hint {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }
    </style>
</head>
<body>
    <div class="search-container">
        <input type="text" id="searchInput" placeholder="Filter tables... (e.g. schema.table)" />
    </div>
    <div class="hint">Teilqualifiziert: schema.table oder nur table</div>
    <script>
        const vscode = acquireVsCodeApi();
        const input = document.getElementById('searchInput');
        let debounceTimer;
        input.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                vscode.postMessage({ type: 'filter', value: input.value });
            }, 200);
        });
        input.focus();
    </script>
</body>
</html>`;
    }
}
