import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { TableWebViewManager } from './tableWebView';
import { extractSelect, extractTableNames, substituteVariables } from './selectStatementExtractor';
import { buildHtmlDocument } from './webviewUtils';
import { icon } from './webviewAssets';

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
            if (!await this.connectionManager.ensureConnected()) {
                return;
            }
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

        // Drop identifiers that are actually columns of the referenced tables;
        // only the remaining (true) variables should be prompted for.
        const variables = await this.filterKnownColumns(extraction.sql, extraction.variables);

        if (variables.length === 0) {
            await this.tableWebViewManager.openQueryView(extraction.sql, this.makeTitle(extraction.sql));
            return;
        }

        const cache = this.getCache();
        const prefilled = variables.map(name => ({
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
        await this.tableWebViewManager.openQueryView(finalSql, this.makeTitle(finalSql));
    }

    /**
     * Remove identifiers that match real column names of any table referenced
     * in `sql`. This keeps PL/pgSQL variables (and positional parameters) while
     * filtering out plain columns that only look like variables. On any error
     * (or no referenced tables) the original list is returned unchanged.
     */
    private async filterKnownColumns(sql: string, variables: string[]): Promise<string[]> {
        if (variables.length === 0) return variables;
        try {
            const tableNames = extractTableNames(sql);
            if (tableNames.length === 0) return variables;
            const lowerNames = tableNames.map(n => n.toLowerCase());
            const rows = await this.connectionManager.queryMetadata(
                `SELECT DISTINCT lower(column_name) AS col
                 FROM information_schema.columns
                 WHERE lower(table_name) = ANY($1)`,
                [lowerNames]
            );
            const knownColumns = new Set<string>(rows.map(r => String(r.col)));
            if (knownColumns.size === 0) return variables;
            return variables.filter(v => !knownColumns.has(v.toLowerCase()));
        } catch {
            // Fall back to the unfiltered list if the lookup fails.
            return variables;
        }
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

            panel.webview.html = this.getModalHtml(panel.webview, sql, variables);

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

    private getModalHtml(webview: vscode.Webview, sql: string, variables: { name: string; value: string }[]): string {
        const esc = (s: string) =>
            s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

        const rows = variables.map((v, i) => `
            <div class="field">
                <label for="var_${i}" title="${esc(v.name)}">${esc(v.name)}</label>
                <input type="text" id="var_${i}" data-name="${esc(v.name)}" value="${esc(v.value)}"
                       placeholder="e.g. 123 or 'text' (leave empty to keep as-is)" />
            </div>`).join('');

        const styles = `
    body { padding: var(--sp-4); }
    h2 { font-size: var(--fs-lg); margin: 0 0 var(--sp-1); }
    p.hint { margin: 0 0 var(--sp-3); }
    pre.sql { background: var(--c-code-bg); border: 1px solid var(--c-border);
              padding: var(--sp-2); border-radius: var(--radius); max-height: 140px; overflow: auto;
              white-space: pre-wrap; font-family: var(--font-mono); font-size: var(--fs-sm); }
    .field label { text-align: right; overflow: hidden; text-overflow: ellipsis;
                   white-space: nowrap; font-family: var(--font-mono); }
    .field input { font-family: var(--font-mono); }
    .buttons { margin-top: var(--sp-4); display: flex; gap: var(--sp-2); justify-content: flex-end; }`;
        const body = `
    <h2>Provide query variables</h2>
    <p class="hint">Values are inserted verbatim. Quote string literals (e.g. <code>'active'</code>).
       Leave a field empty to keep the identifier unchanged. Press Ctrl+Enter to run.</p>
    <pre class="sql">${esc(sql)}</pre>
    <form id="form">
        ${rows}
        <div class="buttons">
            <button type="button" class="btn" id="cancelBtn">Cancel</button>
            <button type="submit" class="btn btn-primary" id="runBtn">${icon('run')}View Data</button>
        </div>
    </form>`;
        const script = `
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
        if (firstInput) { firstInput.focus(); firstInput.select(); }`;
        return buildHtmlDocument({ webview, styles, body, script });
    }
}
