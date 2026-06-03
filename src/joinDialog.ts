import * as vscode from 'vscode';
import { buildJoinSelect, JoinClause, JoinTableSpec, JoinType } from './statementBuilder';

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
}

interface ConfirmPayload {
    tables: JoinTableSpec[];
    joins: JoinClause[];
}

/**
 * Show a modal-like webview that lets the user reorder tables, edit aliases
 * and adjust join conditions before inserting a multi-table JOIN SELECT.
 * Resolves with the final SQL, or `undefined` if cancelled.
 */
export function showJoinDialog(
    tables: JoinDialogTable[],
    fkEdges: JoinDialogFkEdge[],
    initialJoins: JoinClause[]
): Promise<string | undefined> {
    return new Promise<string | undefined>(resolve => {
        const panel = vscode.window.createWebviewPanel(
            'postgresJoinBuilder',
            'Build JOIN SELECT',
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
            { enableScripts: true, retainContextWhenHidden: true }
        );

        let settled = false;

        panel.webview.onDidReceiveMessage((msg: any) => {
            if (msg?.command === 'confirm') {
                const payload = msg.payload as ConfirmPayload;
                const sql = buildJoinSelect(payload.tables, payload.joins);
                settled = true;
                resolve(sql);
                panel.dispose();
            } else if (msg?.command === 'cancel') {
                settled = true;
                resolve(undefined);
                panel.dispose();
            }
        });

        panel.onDidDispose(() => {
            if (!settled) {
                resolve(undefined);
            }
        });

        const nonce = String(Math.random()).slice(2);
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
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
    h2 { margin: 0 0 8px; font-size: 1.1em; }
    .hint { color: var(--vscode-descriptionForeground); margin-bottom: 12px; font-size: 0.9em; }
    .table-row, .join-block {
        border: 1px solid var(--vscode-panel-border);
        border-radius: 4px; padding: 8px; margin-bottom: 8px;
        background: var(--vscode-editorWidget-background);
    }
    .table-row { display: flex; align-items: center; gap: 8px; }
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
    .join-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
    pre {
        background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 4px;
        white-space: pre-wrap; overflow-x: auto; max-height: 240px; overflow-y: auto;
    }
    .actions { margin-top: 12px; display: flex; gap: 8px; }
    .section-title { font-weight: 600; margin: 14px 0 6px; }
</style>
</head>
<body>
    <h2>Build JOIN SELECT</h2>
    <div class="hint">Reorder tables, rename aliases and adjust join conditions. Joins were pre-filled from existing primary/foreign keys where possible.</div>

    <div class="section-title">Tables (order)</div>
    <div id="tables"></div>

    <div class="section-title">Joins</div>
    <div id="joins"></div>

    <div class="section-title">Preview</div>
    <pre id="preview"></pre>

    <div class="actions">
        <button class="primary" id="confirm">Insert statement</button>
        <button id="cancel">Cancel</button>
    </div>

<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const JOIN_TYPES = ${joinTypes};
    const data = ${data};

    // order: array of original table indices in display order
    let order = data.tables.map((_, i) => i);
    // aliases keyed by original index
    let aliases = data.tables.map(t => t.alias);
    // joins keyed by original index -> { type, conditions: [{leftAlias,leftColumn,rightColumn}] }
    // initialJoins is positional (for tables[1..]); map to original index of the
    // table at that position in the initial order (identity at start).
    let joins = {};
    data.joins.forEach((j, idx) => { joins[idx + 1] = JSON.parse(JSON.stringify(j)); });

    function tableAt(pos) { return data.tables[order[pos]]; }
    function aliasOf(origIdx) { return aliases[origIdx]; }

    function escapeHtml(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function move(pos, delta) {
        const np = pos + delta;
        if (np < 0 || np >= order.length) return;
        const tmp = order[pos]; order[pos] = order[np]; order[np] = tmp;
        render();
    }

    function setAlias(origIdx, value) {
        aliases[origIdx] = value.trim() || aliases[origIdx];
    }

    function ensureJoin(origIdx) {
        if (!joins[origIdx]) joins[origIdx] = { type: 'INNER JOIN', conditions: [] };
        return joins[origIdx];
    }

    function earlierColumnOptions(pos) {
        // All (alias, column) pairs from tables before pos.
        const opts = [];
        for (let p = 0; p < pos; p++) {
            const t = tableAt(p);
            const a = aliasOf(order[p]);
            for (const c of t.columns) opts.push({ alias: a, column: c });
        }
        return opts;
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
            const on = j.conditions.length
                ? j.conditions.map(c => t.alias + '.' + c.rightColumn + ' = ' + c.leftAlias + '.' + c.leftColumn).join(' AND ')
                : '';
            lines.push(j.type + ' ' + t.tableReference + ' ' + t.alias + ' ON ' + on);
        }
        return 'SELECT\\n' + selectList + '\\n' + lines.join('\\n') + ';';
    }

    function render() {
        // Tables
        const tablesEl = document.getElementById('tables');
        tablesEl.innerHTML = '';
        order.forEach((oi, pos) => {
            const t = data.tables[oi];
            const row = document.createElement('div');
            row.className = 'table-row';
            row.innerHTML =
                '<button data-up="' + pos + '" ' + (pos === 0 ? 'disabled' : '') + '>\u2191</button>' +
                '<button data-down="' + pos + '" ' + (pos === order.length - 1 ? 'disabled' : '') + '>\u2193</button>' +
                '<span class="badge">' + (pos === 0 ? 'FROM' : 'JOIN') + '</span>' +
                '<span class="name">' + escapeHtml(t.schema + '.' + t.table) + '</span>' +
                ' as <input class="alias" data-alias="' + oi + '" value="' + escapeHtml(aliases[oi]) + '">';
            tablesEl.appendChild(row);
        });

        // Joins
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
                    const leftVal = c.leftAlias + '.' + c.leftColumn;
                    const leftOpts = earlier.map(o => {
                        const v = o.alias + '.' + o.column;
                        return '<option value="' + escapeHtml(v) + '" ' + (v === leftVal ? 'selected' : '') + '>' + escapeHtml(v) + '</option>';
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
                html += '<div class="cond-row"><button data-addcond="' + oi + '">+ Add condition</button></div>';
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
        document.querySelectorAll('[data-alias]').forEach(inp => {
            inp.onchange = () => { setAlias(+inp.dataset.alias, inp.value); render(); };
        });
        document.querySelectorAll('[data-jtype]').forEach(sel => {
            sel.onchange = () => { ensureJoin(+sel.dataset.jtype).type = sel.value; render(); };
        });
        document.querySelectorAll('[data-left]').forEach(sel => {
            sel.onchange = () => {
                const [oi, ci] = sel.dataset.left.split(':').map(Number);
                const [a, col] = splitAliasCol(sel.value);
                joins[oi].conditions[ci].leftAlias = a;
                joins[oi].conditions[ci].leftColumn = col;
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
        document.querySelectorAll('[data-addcond]').forEach(b => b.onclick = () => {
            const oi = +b.dataset.addcond;
            const pos = order.indexOf(oi);
            const earlier = earlierColumnOptions(pos);
            const t = data.tables[oi];
            const left = earlier[0] || { alias: aliases[order[0]], column: (data.tables[order[0]].columns[0] || '') };
            ensureJoin(oi).conditions.push({
                leftAlias: left.alias, leftColumn: left.column, rightColumn: t.columns[0] || ''
            });
            render();
        });
    }

    function splitAliasCol(v) {
        const i = v.indexOf('.');
        return [v.slice(0, i), v.slice(i + 1)];
    }

    document.getElementById('confirm').onclick = () => {
        const tables = order.map(oi => ({
            alias: aliases[oi],
            tableReference: data.tables[oi].tableReference,
            columns: data.tables[oi].columns
        }));
        const joinsArr = [];
        for (let pos = 1; pos < order.length; pos++) {
            const oi = order[pos];
            joinsArr.push(joins[oi] || { type: 'CROSS JOIN', conditions: [] });
        }
        vscode.postMessage({ command: 'confirm', payload: { tables, joins: joinsArr } });
    };
    document.getElementById('cancel').onclick = () => vscode.postMessage({ command: 'cancel' });

    render();
</script>
</body>
</html>`;
}
