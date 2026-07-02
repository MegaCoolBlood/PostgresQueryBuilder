import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { QueryRunner } from './queryRunner';
import { ModifyHistoryStore, isModifyingSql, splitSqlStatements } from './modifyHistoryStore';
import { buildHtmlDocument, WEBVIEW_ESCAPE_HTML_JS } from './webviewUtils';
import { getErrorMessage } from './logger';
import { formatSql, coerceFormatOptions } from './plpgsqlFormatter';

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
                    const options = coerceFormatOptions({
                        keywordCase: cfg.get('format.keywordCase'),
                        identifierCase: cfg.get('format.identifierCase'),
                        dataTypeCase: cfg.get('format.dataTypeCase'),
                        indentStyle: cfg.get('format.indentStyle'),
                        indentSize: cfg.get('format.indentSize'),
                        commaStyle: cfg.get('format.commaStyle'),
                        blankLines: cfg.get('format.blankLines'),
                        simpleSelectSingleLine: cfg.get('format.simpleSelectSingleLine'),
                        preserveSingleLineRoutineHeaders: cfg.get('format.preserveSingleLineRoutineHeaders'),
                        preserveSingleLineIfBlocks: cfg.get('format.preserveSingleLineIfBlocks'),
                        preserveSingleLineSpecialCases: cfg.get('format.preserveSingleLineSpecialCases'),
                        listThresholds: cfg.get('format.listThresholds'),
                        normalizeDataTypes: cfg.get('format.normalizeDataTypes')
                    });
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
        .toolbar button + button {
            margin-left: 8px;
            background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
            color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
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
        }`;
        const body = `
    <div class="editor-container">
        <div class="sql-input">
            <textarea id="sqlInput" placeholder="Enter SQL query..."></textarea>
        </div>
        <div class="toolbar">
            <button id="executeBtn">▶ Execute (Ctrl+Enter)</button>
            <button id="formatBtn">Format PL/pgSQL</button>
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
