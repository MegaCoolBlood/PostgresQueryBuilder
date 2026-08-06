import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { QueryRunner } from './queryRunner';
import { ModifyHistoryStore, isModifyingSql, splitSqlStatements } from './modifyHistoryStore';
import { buildHtmlDocument, WEBVIEW_ESCAPE_HTML_JS } from './webviewUtils';
import { icon } from './webviewAssets';
import { getErrorMessage } from './logger';
import { formatSql } from './plpgsqlFormatter';
import { resolveFormatOptions } from './formatConfig';

export class SqlEditorManager {
    private panel: vscode.WebviewPanel | null = null;
    private context: vscode.ExtensionContext;
    private connectionManager: ConnectionManager;
    private modifyHistoryStore?: ModifyHistoryStore;

    constructor(context: vscode.ExtensionContext, connectionManager: ConnectionManager, modifyHistoryStore?: ModifyHistoryStore) {
        this.context = context;
        this.connectionManager = connectionManager;
        this.modifyHistoryStore = modifyHistoryStore;
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

        this.panel.webview.html = this.getHtml(this.panel.webview);

        this.panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'formatSQL') {
                const cfg = vscode.workspace.getConfiguration('postgresQueryBuilder');
                if (cfg.get<boolean>('format.enable', true) === false) {
                    vscode.window.showWarningMessage('The PL/pgSQL formatter is disabled (postgresQueryBuilder.format.enable).');
                    return;
                }
                try {
                    const options = resolveFormatOptions(
                        (configKey) => cfg.get(configKey),
                        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
                        cfg.get<string>('format.configPath')
                    );
                    this.panel?.webview.postMessage({ command: 'formatted', sql: formatSql(message.sql, options) });
                } catch (err: unknown) {
                    vscode.window.showErrorMessage(`Format failed: ${getErrorMessage(err)}`);
                }
                return;
            }
            if (message.command === 'executeSQL') {
                const queryRunner = new QueryRunner(this.connectionManager);
                try {
                    if (!await this.connectionManager.ensureConnected()) {
                        return;
                    }
                    const result = await queryRunner.executeSQL(message.sql);
                    if (this.modifyHistoryStore) {
                        for (const stmt of splitSqlStatements(message.sql)) {
                            if (isModifyingSql(stmt)) {
                                this.modifyHistoryStore.add({ sql: stmt });
                            }
                        }
                    }
                    this.panel?.webview.postMessage({
                        command: 'sqlResult',
                        rows: result.rows,
                        fields: result.fields.map((f) => f.name),
                        rowCount: result.rowCount
                    });
                } catch (err: unknown) {
                    this.panel?.webview.postMessage({
                        command: 'sqlError',
                        text: getErrorMessage(err)
                    });
                    vscode.window.showErrorMessage(`SQL Error: ${getErrorMessage(err)}`);
                }
            }
        });
    }

    private getHtml(webview: vscode.Webview): string {
        const styles = `
        body {
            padding: var(--sp-4);
        }
        .editor-container {
            display: flex;
            flex-direction: column;
            height: calc(100vh - 2 * var(--sp-4));
        }
        .sql-input {
            flex: 0 0 auto;
            margin-bottom: var(--sp-3);
        }
        textarea {
            width: 100%;
            min-height: 150px;
            padding: var(--sp-2);
            font-size: var(--vscode-editor-font-size);
        }
        .toolbar {
            margin-bottom: var(--sp-3);
        }
        .result-container {
            flex: 1;
            overflow: auto;
        }
        .result-info {
            margin-bottom: var(--sp-2);
            color: var(--c-muted);
        }
        th, td {
            border: 1px solid var(--c-border);
            white-space: nowrap;
        }
        th {
            position: sticky;
            top: 0;
            z-index: var(--z-sticky);
        }
        tr:hover td {
            background: var(--c-hover);
        }
        .error {
            color: var(--c-danger);
            padding: var(--sp-2);
            background: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            border-radius: var(--radius);
            margin-top: var(--sp-2);
        }`;
        const body = `
    <div class="editor-container">
        <div class="sql-input">
            <textarea id="sqlInput" placeholder="Enter SQL query..."></textarea>
        </div>
        <div class="toolbar">
            <button class="btn btn-primary" id="executeBtn" title="Execute (Ctrl+Enter)">${icon('run')}Execute</button>
            <button class="btn" id="formatBtn">${icon('format')}Format PL/pgSQL</button>
        </div>
        <div class="result-container" id="resultContainer"></div>
    </div>`;
        const script = `
        ${WEBVIEW_ESCAPE_HTML_JS}

        const vscode = acquireVsCodeApi();
        const sqlInput = document.getElementById('sqlInput');
        const executeBtn = document.getElementById('executeBtn');
        const formatBtn = document.getElementById('formatBtn');
        const resultContainer = document.getElementById('resultContainer');

        executeBtn.addEventListener('click', executeQuery);
        formatBtn.addEventListener('click', () => {
            const sql = sqlInput.value;
            if (!sql.trim()) return;
            vscode.postMessage({ command: 'formatSQL', sql });
        });
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
            if (msg.command === 'formatted') {
                sqlInput.value = msg.sql;
                return;
            }
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
        });`;
        return buildHtmlDocument({ webview, title: 'SQL Editor', styles, body, script });
    }
}
