import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { TableWebViewManager } from './tableWebView';
import type { SqlFileSessions } from './sqlFileSession';
import { extractSelect, extractTableAliasMap, extractTableNames, queryVariableNames } from './selectStatementExtractor';
import {
    LIST_ELEMENT_KINDS,
    VARIABLE_KINDS,
    buildColumnTypeLookup,
    guessVariableKinds,
    initialVariableInput,
    mergeVariableCache,
    readSubmittedInputs,
    substituteTypedVariables,
    type CatalogColumn,
    type ColumnTypeLookup,
    type VariableInput
} from './sqlVariableValues';
import { buildHtmlDocument } from './webviewUtils';
import { getDateTimePickerAssets, icon } from './webviewAssets';
import { Logger } from './logger';

const VARIABLE_CACHE_KEY = 'viewDataVariableCache';

type PromptVariable = { name: string } & VariableInput;

/**
 * Implements the "View Data" command: extract the SELECT statement around the
 * cursor (or the current selection) inside a PL/pgSQL procedure/function, ask
 * the user to fill in any variables via a modal, then open the result in the
 * data viewer in a side-by-side editor. The Data Viewer runs on the database
 * session of the SQL file, so what "Execute Selection" set up there applies.
 */
export class ViewDataFromSelect {
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly connectionManager: ConnectionManager,
        private readonly tableWebViewManager: TableWebViewManager,
        private readonly fileSessions?: SqlFileSessions
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

        const finalSql = await this.askForVariableValues(extraction.sql, { variables: extraction.variables });
        if (finalSql === undefined) return; // cancelled
        await this.tableWebViewManager.openQueryView(
            finalSql, this.makeTitle(finalSql), vscode.ViewColumn.Beside, undefined, this.fileSessions?.acquire(doc).ref
        );
    }

    /**
     * Ask the user for the values of the variables of `sql` (`$1`, `:name`,
     * PL/pgSQL variables and record fields) with the typed variables form and
     * return the SQL with the values filled in; `sql` itself when it has no
     * variables, undefined when the user cancels. Names that are columns of
     * the referenced tables are no variables; the entered values and types are
     * remembered for next time.
     */
    async askForVariableValues(sql: string, options: { variables?: readonly string[]; actionLabel?: string } = {}): Promise<string | undefined> {
        const found = options.variables ?? queryVariableNames(sql);
        if (found.length === 0) return sql;

        // Drop identifiers that are actually columns of the referenced tables;
        // only the remaining (true) variables should be prompted for.
        const catalog = await this.loadColumnCatalog(sql);
        const variables = catalog.knownColumns.size === 0
            ? found
            : found.filter(v => !catalog.knownColumns.has(v.toLowerCase()));

        if (variables.length === 0) return sql;

        const cache = this.getCache();
        const guesses = guessVariableKinds(sql, catalog.lookup);
        const prefilled: PromptVariable[] = variables.map(name => ({
            name,
            ...initialVariableInput(cache[name.toLowerCase()], guesses.get(name.toLowerCase()))
        }));

        const thousandSeparator = vscode.workspace.getConfiguration('postgresQueryBuilder').get<string>('thousandSeparator', ' ');
        const inputs = await this.promptForVariables(sql, prefilled, thousandSeparator, options.actionLabel ?? 'View Data');
        if (!inputs) return undefined;

        // Persist the supplied values and types for next time.
        await this.context.globalState.update(VARIABLE_CACHE_KEY, mergeVariableCache(cache, inputs));

        return substituteTypedVariables(sql, inputs, { thousandSeparator }).sql;
    }

    /**
     * Read the columns of every table referenced in `sql`: their names keep
     * plain columns that only look like variables out of the prompt, their
     * types suggest how each variable's value is inserted. On any error (or
     * no referenced tables) nothing is known.
     */
    private async loadColumnCatalog(sql: string): Promise<{ knownColumns: Set<string>; lookup: ColumnTypeLookup }> {
        const empty = { knownColumns: new Set<string>(), lookup: () => undefined };
        try {
            const tableNames = extractTableNames(sql);
            if (tableNames.length === 0) return empty;
            const rows = await this.connectionManager.queryMetadata(
                `SELECT lower(table_name) AS tbl, lower(column_name) AS col, data_type AS type
                 FROM information_schema.columns
                 WHERE lower(table_name) = ANY($1)
                 ORDER BY CASE WHEN table_schema = ANY (current_schemas(false)) THEN 0 ELSE 1 END,
                          table_schema, ordinal_position`,
                [tableNames.map(n => n.toLowerCase())]
            );
            const columns: CatalogColumn[] = rows.map(r => ({
                table: String(r.tbl), column: String(r.col), type: String(r.type)
            }));
            return {
                knownColumns: new Set(columns.map(c => c.column)),
                lookup: buildColumnTypeLookup(extractTableAliasMap(sql), columns)
            };
        } catch (err: unknown) {
            Logger.error('ViewDataFromSelect.loadColumnCatalog', err);
            return empty;
        }
    }

    private makeTitle(sql: string): string {
        const oneLine = sql.replace(/\s+/g, ' ').trim();
        return 'View Data: ' + (oneLine.length > 40 ? oneLine.slice(0, 40) + '…' : oneLine);
    }

    private getCache(): Record<string, unknown> {
        return this.context.globalState.get<Record<string, unknown>>(VARIABLE_CACHE_KEY, {});
    }

    /**
     * Show a modal-style webview that lists the variables with their prefilled
     * values and types and resolves to the entered inputs, or `undefined` when
     * cancelled. Every edit is formatted on the host, which posts back the
     * resulting SQL and the per-variable errors for the live preview.
     */
    private promptForVariables(
        sql: string,
        variables: PromptVariable[],
        thousandSeparator: string,
        actionLabel: string
    ): Promise<Record<string, VariableInput> | undefined> {
        return new Promise((resolve) => {
            const panel = vscode.window.createWebviewPanel(
                'postgresViewDataVariables',
                'Provide query variables',
                vscode.ViewColumn.Active,
                { enableScripts: true, retainContextWhenHidden: true }
            );

            let settled = false;
            const finish = (result: Record<string, VariableInput> | undefined) => {
                if (settled) return;
                settled = true;
                resolve(result);
                panel.dispose();
            };
            const names = variables.map(v => v.name);

            panel.webview.html = this.getModalHtml(panel.webview, sql, variables, actionLabel);

            panel.webview.onDidReceiveMessage((message) => {
                if (message.command === 'preview' || message.command === 'submit') {
                    const inputs = readSubmittedInputs(message.inputs, names);
                    const result = substituteTypedVariables(sql, inputs, { thousandSeparator });
                    if (message.command === 'submit' && Object.keys(result.errors).length === 0) {
                        finish(inputs);
                        return;
                    }
                    void panel.webview.postMessage({
                        command: 'preview', seq: message.seq, sql: result.sql, errors: result.errors
                    });
                } else if (message.command === 'cancel') {
                    finish(undefined);
                }
            });

            panel.onDidDispose(() => finish(undefined));
        });
    }

    private getModalHtml(webview: vscode.Webview, sql: string, variables: PromptVariable[], actionLabel = 'View Data'): string {
        const esc = (s: string) =>
            s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

        const kindOptions = (selected: string) => VARIABLE_KINDS.map(k =>
            `<option value="${k.kind}"${k.kind === selected ? ' selected' : ''}>${esc(k.label)}</option>`).join('');
        const listKindOptions = (selected: string | undefined) => LIST_ELEMENT_KINDS.map(k =>
            `<option value="${k.kind}"${k.kind === (selected ?? 'string') ? ' selected' : ''}>${esc(k.label)}</option>`).join('');

        const rows = variables.map((v, i) => `
            <div class="var-row" data-index="${i}">
                <label class="var-name" for="var_${i}" title="${esc(v.name)}">${esc(v.name)}</label>
                <select class="var-kind" data-role="kind" aria-label="Type of ${esc(v.name)}"
                        title="How the value is inserted into the SQL">${kindOptions(v.kind)}</select>
                <div class="var-input" data-role="input"></div>
                <select class="var-list-kind" data-role="listKind" aria-label="Item type of ${esc(v.name)}"
                        title="Type of every item in the list"${v.kind === 'list' ? '' : ' hidden'}>${listKindOptions(v.listKind)}</select>
                <div class="var-error" data-role="error" role="alert"></div>
            </div>`).join('');

        const initial = JSON.stringify(variables.map(v => ({
            name: v.name, value: v.value, kind: v.kind, listKind: v.listKind ?? 'string'
        }))).replace(/</g, '\\u003c');

        const styles = `
    body { padding: var(--sp-4); }
    h2 { font-size: var(--fs-lg); margin: 0 0 var(--sp-1); }
    p.hint { margin: 0 0 var(--sp-3); }
    pre.sql { background: var(--c-code-bg); border: 1px solid var(--c-border);
              padding: var(--sp-2); border-radius: var(--radius); max-height: 180px; overflow: auto;
              white-space: pre-wrap; font-family: var(--font-mono); font-size: var(--fs-sm); margin: 0 0 var(--sp-3); }
    .preview-label { margin: 0 0 var(--sp-1); }
    .var-row { display: grid; grid-template-columns: minmax(120px, 180px) 120px minmax(0, 1fr) auto;
               gap: var(--sp-1) var(--sp-2); align-items: start; margin-bottom: var(--sp-2); }
    .var-name { text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                font-family: var(--font-mono); padding-top: 3px; }
    .var-input { display: flex; min-width: 0; }
    .var-input > input, .var-input > select, .var-input > textarea { flex: 1; min-width: 0; font-family: var(--font-mono); }
    .var-input > .hint { padding-top: 3px; font-family: var(--font-mono); }
    .var-row.invalid .var-input > :not(.dtp-button) { border-color: var(--c-danger); }
    .var-error { grid-column: 3 / -1; color: var(--c-danger); font-size: var(--fs-xs); }
    .var-error:empty { display: none; }
    .buttons { margin-top: var(--sp-4); display: flex; gap: var(--sp-2); justify-content: flex-end; }`;
        const body = `
    <h2>Provide query variables</h2>
    <p class="hint">Choose how each value is inserted: <em>Plain SQL</em> is used verbatim (leave it empty to keep
       the variable as it is), the other types are checked and quoted for you. A <em>List</em> takes one value per
       line or values separated by commas. A <em>Date</em> or <em>Timestamp</em> is typed as 2026-11-25 10:39
       (24-hour) or picked from the calendar next to it. Press Enter to run, Esc to cancel.</p>
    <form id="form">
        ${rows}
        <div class="hint preview-label">Preview</div>
        <pre class="sql" id="preview">${esc(sql)}</pre>
        <div class="buttons">
            <button type="button" class="btn" id="cancelBtn">Cancel</button>
            <button type="submit" class="btn btn-primary" id="runBtn">${icon('run')}${esc(actionLabel)}</button>
        </div>
    </form>`;
        const picker = getDateTimePickerAssets();
        const script = `${picker.script}
        const vscode = acquireVsCodeApi();
        const VARS = ${initial};
        const PLACEHOLDERS = {
            sql: "Inserted verbatim, e.g. 123 or 'text'",
            string: 'Text, quoted for you',
            number: 'e.g. 1234.5 or 1 234,5',
            list: 'One value per line, or separated by commas'
        };
        const form = document.getElementById('form');
        const runBtn = document.getElementById('runBtn');
        const preview = document.getElementById('preview');
        const rows = Array.from(form.querySelectorAll('.var-row'));
        const state = VARS.map(v => ({ name: v.name, kind: v.kind, listKind: v.listKind, value: v.value, memory: {} }));
        let seq = 0;

        // Carry a value over to another type where it still makes sense.
        function adaptValue(value, kind) {
            const v = String(value || '').trim();
            if (kind === 'date' || kind === 'timestamp') {
                const r = window.DateTimePicker.parseDateTimeInput(v, kind);
                return r.error ? '' : r.value;
            }
            if (kind === 'boolean') return /^(false|f|no|n|off|0)$/i.test(v) ? 'false' : 'true';
            if (kind === 'null') return '';
            return String(value || '');
        }

        function makeControl(s) {
            let el;
            if (s.kind === 'null') {
                el = document.createElement('span');
                el.className = 'hint';
                el.textContent = 'NULL';
                return el;
            }
            if (s.kind === 'boolean') {
                el = document.createElement('select');
                for (const v of ['true', 'false']) {
                    const opt = document.createElement('option');
                    opt.value = v;
                    opt.textContent = v;
                    el.appendChild(opt);
                }
            } else if (s.kind === 'list') {
                el = document.createElement('textarea');
                el.rows = 3;
            } else {
                el = document.createElement('input');
                el.type = 'text';
                if (s.kind === 'number') el.inputMode = 'decimal';
            }
            if (PLACEHOLDERS[s.kind]) el.placeholder = PLACEHOLDERS[s.kind];
            el.dataset.role = 'value';
            el.value = adaptValue(s.value, s.kind);
            return el;
        }

        function renderInput(i) {
            const row = rows[i];
            const s = state[i];
            if (s.picker) {
                s.picker.destroy();
                s.picker = null;
            }
            const el = makeControl(s);
            el.id = 'var_' + i;
            row.querySelector('[data-role="input"]').replaceChildren(el);
            row.querySelector('[data-role="listKind"]').hidden = s.kind !== 'list';
            // Dates and timestamps are typed (24-hour, ISO) or picked from a calendar.
            if (s.kind === 'date' || s.kind === 'timestamp') {
                s.picker = window.DateTimePicker.attachDateTimePicker(el, { kind: s.kind, allowEmpty: false });
            }
            // A value that does not fit the type is dropped; keep what is visible.
            if (s.kind !== 'null') s.value = el.value;
        }

        function collect() {
            const inputs = {};
            for (const s of state) inputs[s.name] = { value: s.value, kind: s.kind, listKind: s.listKind };
            return inputs;
        }

        function requestPreview() {
            seq++;
            vscode.postMessage({ command: 'preview', seq, inputs: collect() });
        }

        // Enter and Run always ask the host: it checks the current values and
        // either runs or posts their errors back. Run's disabled state may be
        // stale — a date field that just turned now / today / 10:39 into a
        // timestamp on this very Enter has only asked for a new preview.
        function submit() {
            seq++;
            vscode.postMessage({ command: 'submit', seq, inputs: collect() });
        }

        form.addEventListener('input', (e) => {
            const row = e.target.closest('.var-row');
            if (!row) return;
            const i = Number(row.dataset.index);
            const s = state[i];
            const role = e.target.dataset.role;
            if (role === 'kind') {
                const kind = e.target.value;
                if (kind === s.kind) return;
                s.memory[s.kind] = s.value;
                s.value = Object.prototype.hasOwnProperty.call(s.memory, kind) ? s.memory[kind] : adaptValue(s.value, kind);
                s.kind = kind;
                renderInput(i);
            } else if (role === 'listKind') {
                s.listKind = e.target.value;
            } else if (role === 'value') {
                s.value = e.target.value;
            }
            requestPreview();
        });

        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (!msg || msg.command !== 'preview' || msg.seq !== seq) return;
            preview.textContent = msg.sql;
            const errors = msg.errors || {};
            rows.forEach((row, i) => {
                const err = errors[state[i].name] || '';
                row.querySelector('[data-role="error"]').textContent = err;
                row.classList.toggle('invalid', !!err);
            });
            runBtn.disabled = Object.keys(errors).length > 0;
        });

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            submit();
        });
        document.getElementById('cancelBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'cancel' });
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.target.tagName !== 'TEXTAREA')
                && e.target.tagName !== 'BUTTON') {
                e.preventDefault();
                submit();
            } else if (e.key === 'Escape') {
                vscode.postMessage({ command: 'cancel' });
            }
        });

        state.forEach((s, i) => renderInput(i));
        requestPreview();
        const first = rows[0] && (rows[0].querySelector('[data-role="value"]') || rows[0].querySelector('[data-role="kind"]'));
        if (first) {
            first.focus();
            if (typeof first.select === 'function' && first.tagName !== 'SELECT') first.select();
        }`;
        return buildHtmlDocument({ webview, styles: `${styles}\n${picker.css}`, body, script });
    }
}
