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
            } else if (message.type === 'selectConnection') {
                vscode.commands.executeCommand('postgresQueryBuilder.selectConnection');
            } else if (message.type === 'newConnection') {
                vscode.commands.executeCommand('postgresQueryBuilder.connect');
            } else if (message.type === 'disconnect') {
                vscode.commands.executeCommand('postgresQueryBuilder.disconnect');
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
        .button-row {
            display: flex;
            gap: 4px;
            margin-bottom: 6px;
            flex-wrap: wrap;
        }
        button {
            flex: 1 1 auto;
            padding: 4px 8px;
            border: 1px solid var(--vscode-button-border, transparent);
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            font-size: 12px;
            border-radius: 2px;
            cursor: pointer;
        }
        button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        button.secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
    </style>
</head>
<body>
    <div class="button-row">
        <button id="selectConnBtn" title="Choose an existing saved connection">Select Connection</button>
        <button id="newConnBtn" class="secondary" title="Create a new connection">New</button>
        <button id="disconnectBtn" class="secondary" title="Disconnect">Disconnect</button>
    </div>
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
        document.getElementById('selectConnBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'selectConnection' });
        });
        document.getElementById('newConnBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'newConnection' });
        });
        document.getElementById('disconnectBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'disconnect' });
        });
        input.focus();
    </script>
</body>
</html>`;
    }
}
