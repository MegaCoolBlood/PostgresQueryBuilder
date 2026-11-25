import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { buildBuilderSql, JoinBuilderState, JoinClause, JoinType } from './statementBuilder';
import { getNonce, buildHtmlDocument } from './webviewUtils';
import { getDateTimePickerAssets, icon } from './webviewAssets';
import { getErrorMessage, Logger } from './logger';
import { formatSqlChecked } from './plpgsqlFormatter';
import { getFormatOptions, isFormatterEnabled } from './formatSettings';

/**
 * Read a file of `src/webview`, which ships next to the bundle: the bundled
 * extension lives in `dist/`, the `tsc` build used by the tests in `out/src/`.
 */
function readWebviewFile(name: string): string {
    for (const up of ['..', path.join('..', '..')]) {
        const file = path.join(__dirname, up, 'src', 'webview', name);
        if (fs.existsSync(file)) {
            return fs.readFileSync(file, 'utf8');
        }
    }
    throw new Error(`Webview asset not found: ${name}`);
}

/**
 * The shared join builder component for a webview: `script` (joinDialogLogic.js,
 * the date and time picker its value fields use, then joinBuilder.js, which
 * offers `window.JoinBuilder`; `window.DateTimePicker` comes along) and its
 * stylesheet `css`. Read from disk on every call, like the Data Viewer's assets.
 */
export function getJoinBuilderAssets(): { script: string; css: string } {
    const picker = getDateTimePickerAssets();
    return {
        script: `${readWebviewFile('joinDialogLogic.js')}\n${picker.script}\n${readWebviewFile('joinBuilder.js')}`,
        css: `${readWebviewFile('joinBuilder.css')}\n${picker.css}`
    };
}

/**
 * Lay out generated SQL with the PL/pgSQL formatter and the user's settings.
 * With the formatter turned off, or when its safety net refuses, the SQL is
 * returned unchanged.
 */
export function formatJoinSql(sql: string): string {
    if (!sql || !isFormatterEnabled()) {
        return sql;
    }
    try {
        const outcome = formatSqlChecked(sql, getFormatOptions());
        return outcome.ok ? outcome.text.replace(/\s+$/, '') : sql;
    } catch (err: unknown) {
        Logger.error('joinDialog.formatJoinSql', err);
        return sql;
    }
}

export interface JoinDialogTable {
    schema: string;
    table: string;
    tableReference: string;
    alias: string;
    /** The alias stored for the table, if any; "Save alias" is offered when the edited one differs. */
    savedAlias?: string;
    /** Already-quoted column identifiers. */
    columns: string[];
    /** The data type of each of `columns`, when known; the builder offers the date picker for date and timestamp columns. */
    columnTypes?: string[];
}

/** Foreign-key or custom-mapping edge identified by schema/table/column (order-independent). */
export interface JoinDialogIdentityEdge {
    fromSchema: string;
    fromTable: string;
    fromColumn: string;
    toSchema: string;
    toTable: string;
    toColumn: string;
    /**
     * Extra literal conditions (from a custom mapping) for the join's ON clause.
     * Each references a column on one of the two tables (by schema/table).
     */
    extraConditions?: Array<{
        schema: string;
        table: string;
        column: string;
        operator: string;
        value: string;
    }>;
}

/** Payload returned by `onAddTables` describing tables to append to the dialog. */
export interface JoinDialogAddPayload {
    tables: JoinDialogTable[];
    /** All known FK edges among the (now larger) full table set. */
    fkEdges: JoinDialogIdentityEdge[];
}

export interface JoinDialogResult {
    sql: string;
}

/**
 * The builder state the JOIN dialog starts with: the tables in the given
 * order, joined by `joins`, with every column of every table selected (`*`
 * for a table whose columns are unknown).
 */
export function initialJoinBuilderState(tables: JoinDialogTable[], joins: JoinClause[]): JoinBuilderState {
    return {
        distinct: false,
        selectItems: tables.flatMap((t, tableIndex) =>
            (t.columns.length ? t.columns : ['*']).map(column => ({ kind: 'column' as const, tableIndex, column }))),
        tables: tables.map(t => ({ ...t, columns: [...t.columns] })),
        joins,
        where: [],
        orderBy: [],
        carried: {}
    };
}

/** The formatted SQL of a builder state the webview sent; empty when it cannot be built. */
function builderSql(state: unknown): string {
    try {
        return formatJoinSql(buildBuilderSql(state as JoinBuilderState));
    } catch (err: unknown) {
        Logger.error('joinDialog.builderSql', err);
        return '';
    }
}

/**
 * Show a modal-like webview that lets the user reorder tables, edit aliases
 * and adjust join conditions, columns, WHERE and ORDER BY before inserting a
 * multi-table JOIN SELECT. Resolves with the final SQL — formatted with the
 * user's formatter settings — or `undefined` if cancelled. An alias edited in
 * the dialog is used for this statement only; `onSaveAlias` stores it for the
 * table when the user presses that row's "Save alias" button.
 */
export function showJoinDialog(
    tables: JoinDialogTable[],
    identityEdges: JoinDialogIdentityEdge[],
    initialJoins: JoinClause[],
    onAddTables?: () => Promise<JoinDialogAddPayload | undefined>,
    onRemoveTable?: (schema: string, table: string) => void,
    onSaveAlias?: (schema: string, table: string, alias: string) => Promise<void>
): Promise<JoinDialogResult | undefined> {
    return new Promise<JoinDialogResult | undefined>(resolve => {
        const panel = vscode.window.createWebviewPanel(
            'postgresJoinBuilder',
            'Build JOIN SELECT',
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
            { enableScripts: true, retainContextWhenHidden: true }
        );

        let settled = false;

        panel.webview.onDidReceiveMessage(async (msg: any) => {
            if (msg?.command === 'confirm') {
                const sql = builderSql(msg.state);
                if (!sql) {
                    return;
                }
                settled = true;
                resolve({ sql });
                panel.dispose();
            } else if (msg?.command === 'preview') {
                panel.webview.postMessage({ command: 'previewSql', requestId: msg.requestId, sql: builderSql(msg.state) });
            } else if (msg?.command === 'cancel') {
                settled = true;
                resolve(undefined);
                panel.dispose();
            } else if (msg?.command === 'requestAddTables') {
                if (!onAddTables) {
                    return;
                }
                const payload = await onAddTables();
                if (payload && payload.tables.length > 0) {
                    panel.webview.postMessage({ command: 'addTables', payload });
                }
            } else if (msg?.command === 'tableRemoved') {
                onRemoveTable?.(msg.schema, msg.table);
            } else if (msg?.command === 'saveAlias') {
                const alias = String(msg.alias ?? '').trim();
                if (!onSaveAlias || !alias) {
                    return;
                }
                try {
                    await onSaveAlias(msg.schema, msg.table, alias);
                    panel.webview.postMessage({ command: 'aliasSaved', schema: msg.schema, table: msg.table, alias });
                } catch (err: unknown) {
                    vscode.window.showErrorMessage(`Saving the alias failed: ${getErrorMessage(err)}`);
                }
            }
        });

        panel.onDidDispose(() => {
            if (!settled) {
                resolve(undefined);
            }
        });

        panel.webview.html = getHtml(panel.webview, getNonce(), initialJoinBuilderState(tables, initialJoins), identityEdges);
    });
}

const JOIN_TYPES: JoinType[] = ['INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN'];

function getHtml(
    webview: vscode.Webview,
    nonce: string,
    state: JoinBuilderState,
    identityEdges: JoinDialogIdentityEdge[]
): string {
    const assets = getJoinBuilderAssets();
    const data = JSON.stringify({ state, identityEdges, joinTypes: JOIN_TYPES, preview: builderSql(state) })
        .replace(/</g, '\\u003c');

    const styles = `
    body { padding: var(--sp-3); }
    h2 { margin: 0 0 var(--sp-2); font-size: var(--fs-lg); }
    .hint { margin-bottom: var(--sp-3); }
    .preview-title { font-weight: 600; margin: var(--sp-4) 0 var(--sp-2); }
    pre {
        background: var(--c-code-bg); padding: var(--sp-3); border-radius: var(--radius);
        white-space: pre-wrap; overflow-x: auto; max-height: 240px; overflow-y: auto;
        font-family: var(--font-mono); font-size: var(--fs-sm);
    }
    .actions { margin-top: var(--sp-3); display: flex; gap: var(--sp-2); }`;
    const body = `
    <h2>Build JOIN SELECT</h2>
    <div class="hint">Reorder tables, rename aliases, adjust join conditions and pick the columns, filters and sort order. A renamed alias applies to this statement only — the save button next to it keeps it as the table's alias from then on. Joins were pre-filled from existing primary/foreign keys where possible. Use “Add fixed condition” to add extra ON predicates such as <code>CURRENT_TIMESTAMP BETWEEN t.valid_from AND t.valid_to</code> or <code>t.type = 'TGB'</code>.</div>

    <div id="builder"></div>

    <div class="preview-title">Preview</div>
    <pre id="preview"></pre>

    <div class="actions">
        <button class="btn btn-primary" id="confirm">${icon('check')}Insert statement</button>
        <button class="btn" id="cancel">Cancel</button>
    </div>
`;
    const script = `
    const vscode = acquireVsCodeApi();
    const data = ${data};

    ${assets.script}

    const preview = document.getElementById('preview');
    preview.textContent = data.preview;

    // The host builds and formats the SQL; ask once the user pauses.
    let previewTimer = null;
    let previewRequest = 0;
    function requestPreview(state) {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(() => {
            previewRequest++;
            vscode.postMessage({ command: 'preview', requestId: previewRequest, state });
        }, 150);
    }

    const builder = window.JoinBuilder.createJoinBuilder(document.getElementById('builder'), data.state, {
        post: message => vscode.postMessage(message),
        onChange: requestPreview,
        joinTypes: data.joinTypes,
        identityEdges: data.identityEdges
    });

    window.addEventListener('message', ev => {
        const m = ev.data;
        if (!m) return;
        if (m.command === 'previewSql') {
            if (m.requestId === previewRequest) preview.textContent = m.sql;
            return;
        }
        builder.handleMessage(m);
    });

    document.getElementById('confirm').addEventListener('click', () => {
        clearTimeout(previewTimer);
        vscode.postMessage({ command: 'confirm', state: builder.getState() });
    });
    document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ command: 'cancel' }));`;
    return buildHtmlDocument({ webview, nonce, lang: 'en', styles: `${styles}\n${assets.css}`, body, script });
}

