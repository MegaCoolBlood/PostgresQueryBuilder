import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { QueryRunner } from './queryRunner';

export class SqlEditorManager {
    private panel: vscode.WebviewPanel | null = null;
    private context: vscode.ExtensionContext;
    private connectionManager: ConnectionManager;

    constructor(context: vscode.ExtensionContext, connectionManager: ConnectionManager) {
        this.context = context;
        this.connectionManager = connectionManager;
    }

    openSqlEditor(): void {
        if (this.panel) {
            this.panel.reveal();
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'postgresSqlEditor',
            'SQL Editor',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        this.panel.onDidDispose(() => {
            this.panel = null;
        });

        this.panel.webview.html = this.getHtml();

        this.panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'executeSQL') {
                const queryRunner = new QueryRunner(this.connectionManager);
                try {
                    const result = await queryRunner.executeSQL(message.sql);
                    this.panel?.webview.postMessage({
                        command: 'sqlResult',
                        rows: result.rows,
                        fields: result.fields.map((f: any) => f.name),
                        rowCount: result.rowCount
                    });
                } catch (err: any) {
                    this.panel?.webview.postMessage({
                        command: 'sqlError',
                        text: err.message
                    });
                    vscode.window.showErrorMessage(`SQL Error: ${err.message}`);
                }
            }
        });
    }

    private getHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SQL Editor</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            padding: 16px;
            margin: 0;
        }
        .editor-container {
            display: flex;
            flex-direction: column;
            height: calc(100vh - 32px);
        }
        .sql-input {
            flex: 0 0 auto;
            margin-bottom: 12px;
        }
        textarea {
            width: 100%;
            min-height: 150px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 8px;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            resize: vertical;
            box-sizing: border-box;
        }
        textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        .toolbar {
            margin-bottom: 12px;
        }
        button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 14px;
            cursor: pointer;
            font-size: 13px;
        }
        button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .result-container {
            flex: 1;
            overflow: auto;
        }
        .result-info {
            margin-bottom: 8px;
            color: var(--vscode-descriptionForeground);
        }
        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
        }
        th, td {
            border: 1px solid var(--vscode-panel-border);
            padding: 4px 8px;
            text-align: left;
            white-space: nowrap;
        }
        th {
            background: var(--vscode-editor-selectionBackground);
            position: sticky;
            top: 0;
        }
        tr:hover td {
            background: var(--vscode-list-hoverBackground);
        }
        .error {
            color: var(--vscode-errorForeground);
            padding: 8px;
            background: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            margin-top: 8px;
        }
    </style>
</head>
<body>
    <div class="editor-container">
        <div class="sql-input">
            <textarea id="sqlInput" placeholder="Enter SQL query..."></textarea>
        </div>
        <div class="toolbar">
            <button id="executeBtn">▶ Execute (Ctrl+Enter)</button>
        </div>
        <div class="result-container" id="resultContainer"></div>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const sqlInput = document.getElementById('sqlInput');
        const executeBtn = document.getElementById('executeBtn');
        const resultContainer = document.getElementById('resultContainer');

        executeBtn.addEventListener('click', executeQuery);
        sqlInput.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'Enter') {
                executeQuery();
            }
        });

        function executeQuery() {
            const sql = sqlInput.value.trim();
            if (!sql) return;
            resultContainer.innerHTML = '<div class="result-info">Executing...</div>';
            vscode.postMessage({ command: 'executeSQL', sql });
        }

        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.command === 'sqlResult') {
                let html = '<div class="result-info">' + msg.rowCount + ' row(s) affected/returned</div>';
                if (msg.fields.length > 0 && msg.rows.length > 0) {
                    html += '<table><thead><tr>';
                    msg.fields.forEach(f => { html += '<th>' + escapeHtml(f) + '</th>'; });
                    html += '</tr></thead><tbody>';
                    msg.rows.forEach(row => {
                        html += '<tr>';
                        msg.fields.forEach(f => {
                            const val = row[f];
                            html += '<td>' + escapeHtml(val === null ? 'NULL' : String(val)) + '</td>';
                        });
                        html += '</tr>';
                    });
                    html += '</tbody></table>';
                }
                resultContainer.innerHTML = html;
            } else if (msg.command === 'sqlError') {
                resultContainer.innerHTML = '<div class="error">' + escapeHtml(msg.text) + '</div>';
            }
        });

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
    </script>
</body>
</html>`;
    }
}
