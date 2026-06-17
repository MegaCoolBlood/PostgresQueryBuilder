import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { buildJoinSelect, JoinClause, JoinTableSpec, JoinType } from './statementBuilder';
import { getNonce, buildHtmlDocument, WEBVIEW_ESCAPE_HTML_JS } from './webviewUtils';

/**
 * Source of the shared join-dialog helper logic, inlined into the webview
 * script so the browser side and the unit tests use the exact same code.
 * Located under `src/webview` (shipped with the extension); resolved relative
 * to the compiled `out/` directory.
 */
function loadJoinDialogLogic(): string {
    const file = path.join(__dirname, '..', 'src', 'webview', 'joinDialogLogic.js');
    return fs.readFileSync(file, 'utf8');
}

export interface JoinDialogTable {
    schema: string;
    table: string;
    tableReference: string;
    alias: string;
    /** Already-quoted column identifiers. */
    columns: string[];
}

export interface JoinDialogFkEdge {
    fromIndex: number;
    fromColumn: string;
    toIndex: number;
    toColumn: string;
    /** Extra literal conditions; `tableIndex` identifies the owning table. */
    extraConditions?: Array<{ tableIndex: number; column: string; operator: string; value: string }>;
}

/** Foreign-key edge identified by schema/table/column (order-independent). */
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

interface ConfirmPayload {
    tables: JoinTableSpec[];
    joins: JoinClause[];
    aliasMap: Array<{ schema: string; table: string; alias: string }>;
}

export interface JoinDialogResult {
    sql: string;
    /** Final alias chosen for each table, to be persisted by the caller. */
    aliases: Array<{ schema: string; table: string; alias: string }>;
}

/**
 * Show a modal-like webview that lets the user reorder tables, edit aliases
 * and adjust join conditions before inserting a multi-table JOIN SELECT.
 * Resolves with the final SQL and chosen aliases, or `undefined` if cancelled.
 */
export function showJoinDialog(
    tables: JoinDialogTable[],
    fkEdges: JoinDialogFkEdge[],
    initialJoins: JoinClause[],
    onAddTables?: () => Promise<JoinDialogAddPayload | undefined>,
    onRemoveTable?: (schema: string, table: string) => void
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
                const payload = msg.payload as ConfirmPayload;
                const sql = buildJoinSelect(payload.tables, payload.joins);
                settled = true;
                resolve({ sql, aliases: payload.aliasMap });
                panel.dispose();
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
            }
        });

        panel.onDidDispose(() => {
            if (!settled) {
                resolve(undefined);
            }
        });

        const nonce = getNonce();
        panel.webview.html = getHtml(
            panel.webview,
            nonce,
            { tables, fkEdges, joins: initialJoins }
        );
    });
}

const JOIN_TYPES: JoinType[] = ['INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN'];

function getHtml(
    webview: vscode.Webview,
    nonce: string,
    initial: { tables: JoinDialogTable[]; fkEdges: JoinDialogFkEdge[]; joins: JoinClause[] }
): string {
    const data = JSON.stringify(initial).replace(/</g, '\\u003c');
    const joinTypes = JSON.stringify(JOIN_TYPES);

    const styles = `
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
    h2 { margin: 0 0 8px; font-size: 1.1em; }
    .hint { color: var(--vscode-descriptionForeground); margin-bottom: 12px; font-size: 0.9em; }
    .table-row, .join-block {
        border: 1px solid var(--vscode-panel-border);
        border-radius: 4px; padding: 8px; margin-bottom: 8px;
        background: var(--vscode-editorWidget-background);
    }
    .table-row { display: flex; align-items: center; gap: 8px; }
    .table-row.dragging { opacity: 0.4; }
    .table-row.drag-over { border-color: var(--vscode-focusBorder); border-style: dashed; }
    .drag-handle { cursor: grab; user-select: none; padding: 0 4px; color: var(--vscode-descriptionForeground); }
    .drag-handle:active { cursor: grabbing; }
    .remove-table { margin-left: auto; }
    .table-row .name { font-weight: 600; }
    .badge { font-size: 0.75em; padding: 1px 6px; border-radius: 8px;
        background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    button {
        background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
        border: none; padding: 3px 8px; border-radius: 3px; cursor: pointer; font-size: 0.85em;
    }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: 0.4; cursor: default; }
    input, select {
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border); border-radius: 3px; padding: 2px 4px;
    }
    input.alias { width: 90px; }
    .cond-row { display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
    .cond-literal .lit-text { font-family: var(--vscode-editor-font-family, monospace); opacity: 0.85; }
    .cust-raw { width: 160px; font-family: var(--vscode-editor-font-family, monospace); }
    .join-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
    pre {
        background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 4px;
        white-space: pre-wrap; overflow-x: auto; max-height: 240px; overflow-y: auto;
    }
    .actions { margin-top: 12px; display: flex; gap: 8px; }
    .section-title { font-weight: 600; margin: 14px 0 6px; }
    #dropZone {
        border: 1px dashed var(--vscode-panel-border); border-radius: 4px;
        padding: 12px; margin-bottom: 8px; text-align: center; cursor: pointer;
        color: var(--vscode-descriptionForeground); font-size: 0.9em;
    }
    #dropZone:hover { border-color: var(--vscode-focusBorder); color: var(--vscode-foreground); }
    #dropZone.drag-over {
        border-color: var(--vscode-focusBorder);
        background: var(--vscode-editorWidget-background);
        color: var(--vscode-foreground);
    }`;
    const body = `
    <h2>Build JOIN SELECT</h2>
    <div class="hint">Reorder tables, rename aliases and adjust join conditions. Joins were pre-filled from existing primary/foreign keys where possible. Use “+ Add fixed condition” to add extra ON predicates such as <code>CURRENT_TIMESTAMP BETWEEN t.valid_from AND t.valid_to</code> or <code>t.type = 'TGB'</code>.</div>

    <div class="section-title">Tables (order)</div>
    <div id="tables"></div>
    <div id="dropZone">+ Add tables…</div>

    <div class="section-title">Joins</div>
    <div id="joins"></div>

    <div class="section-title">Preview</div>
    <pre id="preview"></pre>

    <div class="actions">
        <button class="primary" id="confirm">Insert statement</button>
        <button id="cancel">Cancel</button>
    </div>
`;
    const script = `
    const vscode = acquireVsCodeApi();
    const JOIN_TYPES = ${joinTypes};
    const data = ${data};

    ${loadJoinDialogLogic()}

    // order: array of original table indices in display order
    let order = data.tables.map((_, i) => i);
    // aliases keyed by original index
    let aliases = data.tables.map(t => t.alias);
    // joins keyed by original index -> { type, conditions: [{leftOrig,leftColumn,rightColumn}] }
    // where leftOrig is the ORIGINAL index of the partner (earlier) table, so
    // the relationship survives reordering and renaming.
    // initialJoins is positional (for tables[1..]); the initial order is the
    // identity, so position p maps to original index p.
    let joins = {};
    // Join type per ORIGINAL table index, kept independently of the current
    // order so it is not lost while a table temporarily sits in the FROM slot.
    let typeByOrig = {};
    // Fixed/custom ON conditions per ORIGINAL table index. Each entry is a
    // structured row { operator, left, right, right2 }, where each operand is
    // { kind:'column', orig, column } or { kind:'raw', text }. Kept separate
    // from the rebuilt joins map so it survives reordering/normalization.
    let customByOrig = {};
    data.joins.forEach((j, idx) => {
        const oi = idx + 1;
        typeByOrig[oi] = j.type;
        const conditions = (j.conditions || []).map(c => ({
            leftOrig: aliases.indexOf(c.leftAlias),
            leftColumn: c.leftColumn,
            rightColumn: c.rightColumn
        })).filter(c => c.leftOrig >= 0);
        // partnerOrig: the table this join attaches to (from the equality cond).
        const partnerOrig = conditions.length ? conditions[0].leftOrig : -1;
        const literals = (j.literalConditions || []).map(lc => {
            const litOrig = aliases.indexOf(lc.literalAlias);
            const otherOrig = (litOrig === oi) ? partnerOrig : oi;
            return { litOrig, otherOrig, litColumn: lc.literalColumn, operator: lc.operator, value: lc.value };
        }).filter(l => l.litOrig >= 0 && l.otherOrig >= 0);
        joins[oi] = { type: j.type, conditions, literals };
    });

    // All known FK edges as schema/table/column identities, so they survive
    // reordering and so newly added tables can auto-join existing ones.
    let identityEdges = [];
    (data.fkEdges || []).forEach(e => {
        const from = data.tables[e.fromIndex];
        const to = data.tables[e.toIndex];
        if (from && to) {
            const extraConditions = (e.extraConditions || []).map(ec => {
                const t = data.tables[ec.tableIndex];
                return t ? { schema: t.schema, table: t.table, column: ec.column, operator: ec.operator, value: ec.value } : null;
            }).filter(Boolean);
            identityEdges.push({
                fromSchema: from.schema, fromTable: from.table, fromColumn: e.fromColumn,
                toSchema: to.schema, toTable: to.table, toColumn: e.toColumn,
                extraConditions
            });
        }
    });

    function sameEdge(a, b) {
        return a.fromSchema === b.fromSchema && a.fromTable === b.fromTable && a.fromColumn === b.fromColumn
            && a.toSchema === b.toSchema && a.toTable === b.toTable && a.toColumn === b.toColumn;
    }

    // Rebuild the directional join clauses from the order-independent set of
    // relationships currently stored in joins. Each condition links two tables
    // by their original index; after a reorder the condition is re-attached to
    // whichever of the two tables now comes later, so join conditions are never
    // lost when a table is moved (e.g. into the FROM slot).
    function normalizeJoins() {
        const links = [];
        const litLinks = [];
        Object.keys(joins).forEach(k => {
            const oi = +k;
            const j = joins[oi];
            if (!j) return;
            if (j.type) typeByOrig[oi] = j.type;
            (j.conditions || []).forEach(c => {
                if (c.leftOrig == null || c.leftOrig < 0 || c.leftOrig === oi) return;
                links.push({ a: c.leftOrig, colA: c.leftColumn, b: oi, colB: c.rightColumn });
            });
            (j.literals || []).forEach(l => {
                if (l.litOrig == null || l.litOrig < 0 || l.otherOrig == null || l.otherOrig < 0) return;
                litLinks.push({ litOrig: l.litOrig, otherOrig: l.otherOrig, litColumn: l.litColumn, operator: l.operator, value: l.value });
            });
        });

        const rebuilt = {};
        const seen = new Set();
        const litSeen = new Set();
        for (let pos = 1; pos < order.length; pos++) {
            const oi = order[pos];
            const earlier = new Set(order.slice(0, pos));
            const conds = [];
            for (const lk of links) {
                let partner = -1, partnerCol = null, myCol = null;
                if (lk.b === oi && earlier.has(lk.a)) { partner = lk.a; partnerCol = lk.colA; myCol = lk.colB; }
                else if (lk.a === oi && earlier.has(lk.b)) { partner = lk.b; partnerCol = lk.colB; myCol = lk.colA; }
                if (partner < 0) continue;
                const sig = oi + '|' + partner + '|' + myCol + '|' + partnerCol;
                if (seen.has(sig)) continue;
                seen.add(sig);
                conds.push({ leftOrig: partner, leftColumn: partnerCol, rightColumn: myCol });
            }
            const lits = [];
            for (const ll of litLinks) {
                // Attach to whichever endpoint comes later (this position) when
                // the other endpoint is already listed earlier.
                let belongs = false;
                if (ll.litOrig === oi && earlier.has(ll.otherOrig)) belongs = true;
                else if (ll.otherOrig === oi && earlier.has(ll.litOrig)) belongs = true;
                if (!belongs) continue;
                const sig = oi + '|' + ll.litOrig + '|' + ll.otherOrig + '|' + ll.litColumn + '|' + ll.operator + '|' + ll.value;
                if (litSeen.has(sig)) continue;
                litSeen.add(sig);
                lits.push({ litOrig: ll.litOrig, otherOrig: ll.otherOrig, litColumn: ll.litColumn, operator: ll.operator, value: ll.value });
            }
            rebuilt[oi] = { type: typeByOrig[oi] || 'INNER JOIN', conditions: conds, literals: lits, custom: customByOrig[oi] || [] };
        }
        joins = rebuilt;
    }

    function tableAt(pos) { return data.tables[order[pos]]; }
    function aliasOf(origIdx) { return aliases[origIdx]; }

    ${WEBVIEW_ESCAPE_HTML_JS}

    function move(pos, delta) {
        const np = pos + delta;
        if (np < 0 || np >= order.length) return;
        const tmp = order[pos]; order[pos] = order[np]; order[np] = tmp;
        render();
    }

    // Move the table currently at fromPos so it sits at toPos, preserving the
    // relative order of the others. Join conditions are keyed by the original
    // table index, so they are preserved across reordering.
    function moveTo(fromPos, toPos) {
        if (fromPos === toPos || fromPos < 0 || toPos < 0
            || fromPos >= order.length || toPos >= order.length) return;
        const [moved] = order.splice(fromPos, 1);
        order.splice(toPos, 0, moved);
        render();
    }

    function setAlias(origIdx, value) {
        aliases[origIdx] = value.trim() || aliases[origIdx];
    }

    // Remove the table at the given display position from the join. Its own join
    // clause is dropped, and any conditions on other tables that reference it are
    // removed too, so no dangling relationships remain. The original table data
    // is kept (only the display order changes) so indices stay stable.
    function removeTable(pos) {
        if (order.length <= 1 || pos < 0 || pos >= order.length) return;
        const oi = order[pos];
        order.splice(pos, 1);
        delete joins[oi];
        delete typeByOrig[oi];
        delete customByOrig[oi];
        Object.keys(joins).forEach(k => {
            const j = joins[k];
            if (j && j.conditions) {
                j.conditions = j.conditions.filter(c => c.leftOrig !== oi);
            }
        });
        const t = data.tables[oi];
        vscode.postMessage({ command: 'tableRemoved', schema: t.schema, table: t.table });
        render();
    }

    function ensureJoin(origIdx) {
        if (!joins[origIdx]) joins[origIdx] = { type: 'INNER JOIN', conditions: [], literals: [] };
        if (!joins[origIdx].literals) joins[origIdx].literals = [];
        if (!joins[origIdx].custom) joins[origIdx].custom = customByOrig[origIdx] || [];
        return joins[origIdx];
    }

    function ensureCustom(origIdx) {
        if (!customByOrig[origIdx]) customByOrig[origIdx] = [];
        return customByOrig[origIdx];
    }

    // All currently visible tables' columns as operand options for fixed
    // conditions: { orig, alias, column }. Any table in the join may be
    // referenced (not only earlier ones), since a fixed condition can compare
    // arbitrary columns.
    function allColumnOptions() {
        const opts = [];
        order.forEach(oi => {
            const t = data.tables[oi];
            for (const c of t.columns) opts.push({ orig: oi, alias: aliases[oi], column: c });
        });
        return opts;
    }

    // Resolve a stored operand into the shape expected by formatCustomCondition
    // (column → qualified ref using the current alias; raw → verbatim text).
    function resolveOperand(op) {
        if (!op) return { kind: 'raw', text: '' };
        if (op.kind === 'column') return { kind: 'column', ref: aliases[op.orig] + '.' + op.column };
        return { kind: 'raw', text: op.text || '' };
    }

    function resolveCustom(c) {
        return {
            operator: c.operator,
            left: resolveOperand(c.left),
            right: resolveOperand(c.right),
            right2: c.right2 ? resolveOperand(c.right2) : undefined
        };
    }

    function customConditionText(c) {
        return formatCustomCondition(resolveCustom(c));
    }

    // Render the dropdown + optional text input for one operand of a fixed
    // condition. The dropdown lists every column of every joined table plus a
    // "Custom value…" entry that switches the operand to a free-text input
    // (for literals like 'TGB' or expressions like CURRENT_TIMESTAMP).
    function operandControls(oi, ci, side, operand) {
        const cols = allColumnOptions();
        const op = operand || { kind: 'raw', text: '' };
        const colOpts = cols.map(o => {
            const v = 'c\u0001' + o.orig + '\u0001' + o.column;
            const sel = op.kind === 'column' && op.orig === o.orig && op.column === o.column;
            return '<option value="' + escapeHtml(v) + '" ' + (sel ? 'selected' : '') + '>' + escapeHtml(o.alias + '.' + o.column) + '</option>';
        }).join('');
        const rawSel = op.kind === 'raw' ? 'selected' : '';
        const sel = '<select class="operand-kind" data-cust-op="' + oi + ':' + ci + ':' + side + '">' +
            colOpts +
            '<option value="__raw__" ' + rawSel + '>Custom value…</option>' +
            '</select>';
        const rawInput = op.kind === 'raw'
            ? '<input class="cust-raw" data-cust-raw="' + oi + ':' + ci + ':' + side + '" value="' + escapeHtml(op.text || '') + '" placeholder="value / expression">'
            : '';
        return sel + rawInput;
    }

    function earlierColumnOptions(pos) {
        // All (orig, alias, column) tuples from tables before pos.
        const opts = [];
        for (let p = 0; p < pos; p++) {
            const t = tableAt(p);
            const oi = order[p];
            const a = aliasOf(oi);
            for (const c of t.columns) opts.push({ orig: oi, alias: a, column: c });
        }
        return opts;
    }

    function fmtLiteral(value) {
        if (/^-?\\d+(\\.\\d+)?$/.test(value)) return value;
        return "'" + String(value).replace(/'/g, "''") + "'";
    }

    function buildPreview() {
        const specs = order.map(oi => ({
            alias: aliases[oi],
            tableReference: data.tables[oi].tableReference,
            columns: data.tables[oi].columns
        }));
        const selectList = specs.flatMap(t => {
            const cols = t.columns.length ? t.columns : ['*'];
            return cols.map(c => '  ' + t.alias + '.' + c);
        }).join(',\\n');
        const lines = ['FROM ' + specs[0].tableReference + ' ' + specs[0].alias];
        for (let pos = 1; pos < order.length; pos++) {
            const oi = order[pos];
            const t = specs[pos];
            const j = joins[oi];
            if (!j || j.type === 'CROSS JOIN') {
                lines.push('CROSS JOIN ' + t.tableReference + ' ' + t.alias);
                continue;
            }
            const parts = j.conditions.map(c => t.alias + '.' + c.rightColumn + ' = ' + aliases[c.leftOrig] + '.' + c.leftColumn);
            (j.literals || []).forEach(l => {
                parts.push(aliases[l.litOrig] + '.' + l.litColumn + ' ' + l.operator + ' ' + fmtLiteral(l.value));
            });
            (customByOrig[oi] || []).forEach(c => {
                const txt = customConditionText(c);
                if (txt) parts.push(txt);
            });
            const on = parts.join(' AND ');
            lines.push(j.type + ' ' + t.tableReference + ' ' + t.alias + ' ON ' + on);
        }
        return 'SELECT\\n' + selectList + '\\n' + lines.join('\\n') + ';';
    }

    function render() {
        normalizeJoins();
        const tablesEl = document.getElementById('tables');
        tablesEl.innerHTML = '';
        order.forEach((oi, pos) => {
            const t = data.tables[oi];
            const row = document.createElement('div');
            row.className = 'table-row';
            row.draggable = true;
            row.dataset.pos = String(pos);
            row.innerHTML =
                '<span class="drag-handle" title="Drag to reorder">\u2630</span>' +
                '<button data-up="' + pos + '" ' + (pos === 0 ? 'disabled' : '') + '>\u2191</button>' +
                '<button data-down="' + pos + '" ' + (pos === order.length - 1 ? 'disabled' : '') + '>\u2193</button>' +
                '<span class="badge">' + (pos === 0 ? 'FROM' : 'JOIN') + '</span>' +
                '<span class="name">' + escapeHtml(t.schema + '.' + t.table) + '</span>' +
                ' as <input class="alias" data-alias="' + oi + '" value="' + escapeHtml(aliases[oi]) + '">' +
                '<button class="remove-table" data-remove="' + pos + '" title="Remove table from join" ' +
                (order.length <= 1 ? 'disabled' : '') + '>\u2715</button>';
            tablesEl.appendChild(row);
        });

        const joinsEl = document.getElementById('joins');
        joinsEl.innerHTML = '';
        for (let pos = 1; pos < order.length; pos++) {
            const oi = order[pos];
            const t = data.tables[oi];
            const j = ensureJoin(oi);
            const block = document.createElement('div');
            block.className = 'join-block';

            let html = '<div class="join-head"><select data-jtype="' + oi + '">' +
                JOIN_TYPES.map(jt => '<option ' + (jt === j.type ? 'selected' : '') + '>' + jt + '</option>').join('') +
                '</select><span class="name">' + escapeHtml(aliases[oi] + ' (' + t.schema + '.' + t.table + ')') + '</span></div>';

            if (j.type !== 'CROSS JOIN') {
                const earlier = earlierColumnOptions(pos);
                j.conditions.forEach((c, ci) => {
                    const leftOpts = earlier.map(o => {
                        const v = o.orig + '\u0001' + o.column;
                        const sel = (o.orig === c.leftOrig && o.column === c.leftColumn);
                        return '<option value="' + escapeHtml(v) + '" ' + (sel ? 'selected' : '') + '>' + escapeHtml(o.alias + '.' + o.column) + '</option>';
                    }).join('');
                    const rightOpts = t.columns.map(col =>
                        '<option value="' + escapeHtml(col) + '" ' + (col === c.rightColumn ? 'selected' : '') + '>' + escapeHtml(col) + '</option>'
                    ).join('');
                    html += '<div class="cond-row">' +
                        '<select data-left="' + oi + ':' + ci + '">' + leftOpts + '</select>' +
                        ' = ' +
                        '<span>' + escapeHtml(aliases[oi]) + '.</span>' +
                        '<select data-right="' + oi + ':' + ci + '">' + rightOpts + '</select>' +
                        '<button data-rmcond="' + oi + ':' + ci + '">Remove</button>' +
                        '</div>';
                });
                (j.literals || []).forEach((l, li) => {
                    html += '<div class="cond-row cond-literal" title="Condition from a custom mapping — click Edit to change it">' +
                        '<span class="lit-text">' + escapeHtml(aliases[l.litOrig] + '.' + l.litColumn + ' ' + l.operator + ' ' + fmtLiteral(l.value)) + '</span>' +
                        '<button data-editlit="' + oi + ':' + li + '">Edit</button>' +
                        '<button data-rmlit="' + oi + ':' + li + '">Remove</button>' +
                        '</div>';
                });
                (customByOrig[oi] || []).forEach((c, ci) => {
                    const operatorOpts = CUSTOM_OPERATORS.map(o =>
                        '<option ' + (o === c.operator ? 'selected' : '') + '>' + o + '</option>'
                    ).join('');
                    let row = '<div class="cond-row cond-custom" title="Fixed condition">' +
                        operandControls(oi, ci, 'left', c.left) +
                        '<select class="operand-operator" data-cust-operator="' + oi + ':' + ci + '">' + operatorOpts + '</select>';
                    if (isBetweenOperator(c.operator)) {
                        row += operandControls(oi, ci, 'right', c.right) +
                            '<span>AND</span>' +
                            operandControls(oi, ci, 'right2', c.right2);
                    } else if (!isUnaryOperator(c.operator)) {
                        row += operandControls(oi, ci, 'right', c.right);
                    }
                    row += '<button data-rmcustom="' + oi + ':' + ci + '">Remove</button></div>';
                    html += row;
                });
                html += '<div class="cond-row">' +
                    '<button data-addcond="' + oi + '">+ Add condition</button>' +
                    '<button data-addcustom="' + oi + '">+ Add fixed condition</button>' +
                    '</div>';
            }

            block.innerHTML = html;
            joinsEl.appendChild(block);
        }

        document.getElementById('preview').textContent = buildPreview();
        bind();
    }

    function bind() {
        document.querySelectorAll('[data-up]').forEach(b => b.onclick = () => move(+b.dataset.up, -1));
        document.querySelectorAll('[data-down]').forEach(b => b.onclick = () => move(+b.dataset.down, 1));
        document.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => removeTable(+b.dataset.remove));
        bindDragAndDrop();
        document.querySelectorAll('[data-alias]').forEach(inp => {
            inp.onchange = () => { setAlias(+inp.dataset.alias, inp.value); render(); };
        });
        document.querySelectorAll('[data-jtype]').forEach(sel => {
            sel.onchange = () => {
                const oi = +sel.dataset.jtype;
                typeByOrig[oi] = sel.value;
                ensureJoin(oi).type = sel.value;
                render();
            };
        });
        document.querySelectorAll('[data-left]').forEach(sel => {
            sel.onchange = () => {
                const [oi, ci] = sel.dataset.left.split(':').map(Number);
                const raw = sel.value;
                const si = raw.indexOf('\u0001');
                joins[oi].conditions[ci].leftOrig = Number(raw.slice(0, si));
                joins[oi].conditions[ci].leftColumn = raw.slice(si + 1);
                document.getElementById('preview').textContent = buildPreview();
            };
        });
        document.querySelectorAll('[data-right]').forEach(sel => {
            sel.onchange = () => {
                const [oi, ci] = sel.dataset.right.split(':').map(Number);
                joins[oi].conditions[ci].rightColumn = sel.value;
                document.getElementById('preview').textContent = buildPreview();
            };
        });
        document.querySelectorAll('[data-rmcond]').forEach(b => b.onclick = () => {
            const [oi, ci] = b.dataset.rmcond.split(':').map(Number);
            joins[oi].conditions.splice(ci, 1);
            render();
        });
        document.querySelectorAll('[data-rmlit]').forEach(b => b.onclick = () => {
            const [oi, li] = b.dataset.rmlit.split(':').map(Number);
            if (joins[oi] && joins[oi].literals) joins[oi].literals.splice(li, 1);
            render();
        });
        document.querySelectorAll('[data-editlit]').forEach(b => b.onclick = () => {
            // Promote a read-only custom-mapping literal into an editable fixed
            // condition: append it to the join's custom conditions and drop it
            // from the literals so it is not rendered twice or re-derived.
            const [oi, li] = b.dataset.editlit.split(':').map(Number);
            const lit = joins[oi] && joins[oi].literals && joins[oi].literals[li];
            if (!lit) return;
            ensureCustom(oi).push(literalToCustomCondition(lit));
            joins[oi].literals.splice(li, 1);
            render();
        });
        document.querySelectorAll('[data-addcond]').forEach(b => b.onclick = () => {
            const oi = +b.dataset.addcond;
            const pos = order.indexOf(oi);
            const earlier = earlierColumnOptions(pos);
            const t = data.tables[oi];
            const left = earlier[0] || { orig: order[0], column: (data.tables[order[0]].columns[0] || '') };
            ensureJoin(oi).conditions.push({
                leftOrig: left.orig, leftColumn: left.column, rightColumn: t.columns[0] || ''
            });
            render();
        });
        document.querySelectorAll('[data-addcustom]').forEach(b => b.onclick = () => {
            const oi = +b.dataset.addcustom;
            const first = allColumnOptions()[0];
            const left = first
                ? { kind: 'column', orig: first.orig, column: first.column }
                : { kind: 'raw', text: '' };
            ensureCustom(oi).push({ operator: '=', left, right: { kind: 'raw', text: '' } });
            render();
        });
        document.querySelectorAll('[data-rmcustom]').forEach(b => b.onclick = () => {
            const [oi, ci] = b.dataset.rmcustom.split(':').map(Number);
            if (customByOrig[oi]) customByOrig[oi].splice(ci, 1);
            render();
        });
        document.querySelectorAll('[data-cust-operator]').forEach(sel => {
            sel.onchange = () => {
                const [oi, ci] = sel.dataset.custOperator.split(':').map(Number);
                const c = customByOrig[oi][ci];
                c.operator = sel.value;
                // Ensure operands exist for the new operator shape.
                if (isUnaryOperator(c.operator)) {
                    delete c.right; delete c.right2;
                } else if (isBetweenOperator(c.operator)) {
                    if (!c.right) c.right = { kind: 'raw', text: '' };
                    if (!c.right2) c.right2 = { kind: 'raw', text: '' };
                } else {
                    if (!c.right) c.right = { kind: 'raw', text: '' };
                    delete c.right2;
                }
                render();
            };
        });
        document.querySelectorAll('[data-cust-op]').forEach(sel => {
            sel.onchange = () => {
                const [oi, ci, side] = sel.dataset.custOp.split(':');
                const c = customByOrig[+oi][+ci];
                const raw = sel.value;
                let operand;
                if (raw === '__raw__') {
                    operand = { kind: 'raw', text: '' };
                } else {
                    const parts = raw.split('\u0001');
                    operand = { kind: 'column', orig: Number(parts[1]), column: parts[2] };
                }
                c[side] = operand;
                render();
            };
        });
        document.querySelectorAll('[data-cust-raw]').forEach(inp => {
            inp.oninput = () => {
                const [oi, ci, side] = inp.dataset.custRaw.split(':');
                const c = customByOrig[+oi][+ci];
                if (!c[side] || c[side].kind !== 'raw') c[side] = { kind: 'raw', text: '' };
                c[side].text = inp.value;
                document.getElementById('preview').textContent = buildPreview();
            };
        });
    }

    let dragFromPos = null;
    function bindDragAndDrop() {
        document.querySelectorAll('.table-row').forEach(row => {
            row.addEventListener('dragstart', e => {
                dragFromPos = +row.dataset.pos;
                row.classList.add('dragging');
                if (e.dataTransfer) {
                    e.dataTransfer.effectAllowed = 'move';
                    // Required for Firefox to start the drag.
                    e.dataTransfer.setData('text/plain', String(dragFromPos));
                }
            });
            row.addEventListener('dragend', () => {
                dragFromPos = null;
                document.querySelectorAll('.table-row').forEach(r => r.classList.remove('dragging', 'drag-over'));
            });
            row.addEventListener('dragover', e => {
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
            });
            row.addEventListener('dragenter', e => {
                e.preventDefault();
                if (dragFromPos !== null && +row.dataset.pos !== dragFromPos) {
                    row.classList.add('drag-over');
                }
            });
            row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
            row.addEventListener('drop', e => {
                e.preventDefault();
                row.classList.remove('drag-over');
                if (dragFromPos === null) return;
                e.stopPropagation();
                const toPos = +row.dataset.pos;
                const from = dragFromPos;
                dragFromPos = null;
                moveTo(from, toPos);
            });
        });
    }

    // Auto-derive a join clause for a newly added table from known FK edges to
    // tables that already precede it in the current order. Delegates to the
    // shared, name-based helper so duplicate table instances get the same ON
    // conditions that were offered when the table was first added.
    function computeAutoJoin(origIdx) {
        const clause = computeAutoJoinClause(origIdx, order, data.tables, identityEdges);
        typeByOrig[origIdx] = clause.type;
        joins[origIdx] = clause;
    }

    // Append tables (and their FK edges) pushed by the extension after the user
    // drops additional tables onto the dialog. Existing order/aliases/joins are
    // preserved; new tables go to the end and auto-join earlier tables.
    function addTables(payload) {
        (payload.fkEdges || []).forEach(e => {
            if (!identityEdges.some(x => sameEdge(x, e))) identityEdges.push(e);
        });
        let added = false;
        (payload.tables || []).forEach(nt => {
            // Always add the table as a new instance (its own original index),
            // even if the same schema.table is already present. This lets the
            // same table appear multiple times with distinct aliases and their
            // own join clauses (e.g. a self-join). The alias is made unique
            // against the currently visible tables only, so a suffix freed by
            // removing a table is reused instead of ever-increasing.
            const alias = uniqueAlias(nt.alias || nt.table, order.map(oi => aliases[oi]));
            const origIdx = data.tables.length;
            data.tables.push(nt);
            aliases.push(alias);
            order.push(origIdx);
            computeAutoJoin(origIdx);
            added = true;
        });
        if (added) render();
    }

    // Tree → webview native drag events are not delivered by VS Code, so adding
    // tables is click-driven: clicking the zone asks the extension to show a
    // table picker (which also picks up any just-dragged tree selection).
    function bindAddTables() {
        const dropZone = document.getElementById('dropZone');
        dropZone.addEventListener('click', () => {
            vscode.postMessage({ command: 'requestAddTables' });
        });
    }

    window.addEventListener('message', ev => {
        const m = ev.data;
        if (m && m.command === 'addTables') addTables(m.payload);
    });

    document.getElementById('confirm').onclick = () => {
        normalizeJoins();
        const tables = order.map(oi => ({
            alias: aliases[oi],
            tableReference: data.tables[oi].tableReference,
            columns: data.tables[oi].columns
        }));
        const joinsArr = [];
        for (let pos = 1; pos < order.length; pos++) {
            const oi = order[pos];
            const j = joins[oi] || { type: 'CROSS JOIN', conditions: [], literals: [] };
            // Convert internal leftOrig references back to aliases for the builder.
            joinsArr.push({
                type: j.type,
                conditions: (j.conditions || []).map(c => ({
                    leftAlias: aliases[c.leftOrig],
                    leftColumn: c.leftColumn,
                    rightColumn: c.rightColumn
                })),
                literalConditions: (j.literals || []).map(l => ({
                    literalAlias: aliases[l.litOrig],
                    literalColumn: l.litColumn,
                    operator: l.operator,
                    value: l.value
                })),
                rawConditions: (customByOrig[oi] || [])
                    .map(c => customConditionText(c))
                    .filter(s => s && s.length > 0)
            });
        }
        const aliasMap = order.map(oi => ({
            schema: data.tables[oi].schema,
            table: data.tables[oi].table,
            alias: aliases[oi]
        }));
        vscode.postMessage({ command: 'confirm', payload: { tables, joins: joinsArr, aliasMap } });
    };
    document.getElementById('cancel').onclick = () => vscode.postMessage({ command: 'cancel' });

    bindAddTables();
    render();`;
    return buildHtmlDocument({ webview, nonce, lang: 'en', styles, body, script });
}
