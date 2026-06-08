import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { TableWebViewManager } from './tableWebView';
import { extractSelect, substituteVariables } from './selectStatementExtractor';

const VARIABLE_CACHE_KEY = 'viewDataVariableCache';

/**
 * Implements the "View Data" command: extract the SELECT statement around the
 * cursor (or the current selection) inside a PL/pgSQL procedure/function, ask
 * the user to fill in any variables via a modal, then open the result in the
 * data viewer in a side-by-side editor.
 */
export class ViewDataFromSelect {
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly connectionManager: ConnectionManager,
        private readonly tableWebViewManager: TableWebViewManager
    ) {}

    async run(editor: vscode.TextEditor | undefined): Promise<void> {
        if (!editor) {
            vscode.window.showWarningMessage('Open a SQL file and place the cursor inside a SELECT statement.');
            return;
        }
        if (!this.connectionManager.isConnected()) {
            vscode.window.showWarningMessage('Connect to a PostgreSQL database first.');
            return;
        }

        const doc = editor.document;
        const fullText = doc.getText();
        const cursorOffset = doc.offsetAt(editor.selection.active);
        const selection = editor.selection.isEmpty
            ? undefined
            : { start: doc.offsetAt(editor.selection.start), end: doc.offsetAt(editor.selection.end) };

        const extraction = extractSelect(fullText, cursorOffset, selection);
        if (!extraction || !extraction.sql) {
            vscode.window.showWarningMessage('No SELECT statement found at the cursor.');
            return;
        }

        if (extraction.variables.length === 0) {
            this.tableWebViewManager.openCustomQueryView(extraction.sql, this.makeTitle(extraction.sql));
            return;
        }

        const cache = this.getCache();
        const prefilled = extraction.variables.map(name => ({
            name,
            value: cache[name.toLowerCase()] ?? ''
        }));

        const values = await this.promptForVariables(extraction.sql, prefilled);
        if (!values) return; // cancelled

        // Persist the supplied values for next time.
        const newCache = { ...cache };
        for (const [name, value] of Object.entries(values)) {
            newCache[name.toLowerCase()] = value;
        }
        await this.context.globalState.update(VARIABLE_CACHE_KEY, newCache);

        const finalSql = substituteVariables(extraction.sql, values);
        this.tableWebViewManager.openCustomQueryView(finalSql, this.makeTitle(finalSql));
    }

    private makeTitle(sql: string): string {
        const oneLine = sql.replace(/\s+/g, ' ').trim();
        return 'View Data: ' + (oneLine.length > 40 ? oneLine.slice(0, 40) + '…' : oneLine);
    }

    private getCache(): Record<string, string> {
        return this.context.globalState.get<Record<string, string>>(VARIABLE_CACHE_KEY, {});
    }

    /**
     * Show a modal-style webview that lists the variables with prefilled values
     * and resolves to the entered values, or `undefined` when cancelled.
     */
    private promptForVariables(
        sql: string,
        variables: { name: string; value: string }[]
    ): Promise<Record<string, string> | undefined> {
        return new Promise((resolve) => {
            const panel = vscode.window.createWebviewPanel(
                'postgresViewDataVariables',
                'Provide query variables',
                vscode.ViewColumn.Active,
                { enableScripts: true, retainContextWhenHidden: true }
            );

            let settled = false;
            const finish = (result: Record<string, string> | undefined) => {
                if (settled) return;
                settled = true;
                resolve(result);
                panel.dispose();
            };

            panel.webview.html = this.getModalHtml(sql, variables);

            panel.webview.onDidReceiveMessage((message) => {
                if (message.command === 'submit') {
                    finish(message.values || {});
                } else if (message.command === 'cancel') {
                    finish(undefined);
                }
            });

            panel.onDidDispose(() => finish(undefined));
        });
    }

    private getModalHtml(sql: string, variables: { name: string; value: string }[]): string {
        const esc = (s: string) =>
            s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

        const rows = variables.map((v, i) => `
            <div class="field">
                <label for="var_${i}" title="${esc(v.name)}">${esc(v.name)}</label>
                <input type="text" id="var_${i}" data-name="${esc(v.name)}" value="${esc(v.value)}"
                       placeholder="e.g. 123 or 'text' (leave empty to keep as-is)" />
            </div>`).join('');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
           color: var(--vscode-foreground); background: var(--vscode-editor-background);
           padding: 16px; margin: 0; }
    h2 { font-size: 1.1em; margin: 0 0 4px; }
    p.hint { color: var(--vscode-descriptionForeground); margin: 0 0 12px; }
    pre.sql { background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-panel-border);
              padding: 8px; border-radius: 4px; max-height: 140px; overflow: auto; white-space: pre-wrap;
              font-family: var(--vscode-editor-font-family); font-size: 12px; }
    .field { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .field label { flex: 0 0 180px; text-align: right; overflow: hidden; text-overflow: ellipsis;
                   white-space: nowrap; font-family: var(--vscode-editor-font-family); }
    .field input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
                   border: 1px solid var(--vscode-input-border); padding: 4px 6px; box-sizing: border-box;
                   font-family: var(--vscode-editor-font-family); }
    .field input:focus { outline: 1px solid var(--vscode-focusBorder); }
    .buttons { margin-top: 16px; display: flex; gap: 8px; justify-content: flex-end; }
    button { border: none; padding: 6px 14px; cursor: pointer; font-size: 13px; }
    .primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .primary:hover { background: var(--vscode-button-hoverBackground); }
    .secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
</style>
</head>
<body>
    <h2>Provide query variables</h2>
    <p class="hint">Values are inserted verbatim. Quote string literals (e.g. <code>'active'</code>).
       Leave a field empty to keep the identifier unchanged. Press Ctrl+Enter to run.</p>
    <pre class="sql">${esc(sql)}</pre>
    <form id="form">
        ${rows}
        <div class="buttons">
            <button type="button" class="secondary" id="cancelBtn">Cancel</button>
            <button type="submit" class="primary" id="runBtn">View Data</button>
        </div>
    </form>
    <script>
        const vscode = acquireVsCodeApi();
        const form = document.getElementById('form');
        function collect() {
            const values = {};
            form.querySelectorAll('input[data-name]').forEach(inp => {
                values[inp.getAttribute('data-name')] = inp.value;
            });
            return values;
        }
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            vscode.postMessage({ command: 'submit', values: collect() });
        });
        document.getElementById('cancelBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'cancel' });
        });
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'Enter') {
                vscode.postMessage({ command: 'submit', values: collect() });
            } else if (e.key === 'Escape') {
                vscode.postMessage({ command: 'cancel' });
            }
        });
        const firstInput = form.querySelector('input[data-name]');
        if (firstInput) { firstInput.focus(); firstInput.select(); }
    </script>
</body>
</html>`;
    }
}
