import * as vscode from 'vscode';
import { SavedQueryStore, SavedQueryParameter, SavedQueryScope, mergeParameters } from './savedQueryStore';
import { buildHtmlDocument, WEBVIEW_ESCAPE_HTML_JS } from './webviewUtils';
import { icon } from './webviewAssets';
import { getErrorMessage } from './logger';

const PARAMETER_KINDS = ['text', 'number', 'identifier', 'raw'];

/** Read a parameter list back from the webview's edit dialog. */
export function toParameters(raw: unknown): SavedQueryParameter[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const result: SavedQueryParameter[] = [];
    for (const p of raw) {
        const name = typeof p?.name === 'string' ? p.name.trim() : '';
        if (!name) {
            continue;
        }
        const param: SavedQueryParameter = {
            name,
            kind: PARAMETER_KINDS.includes(p?.kind) ? p.kind : 'text'
        };
        const label = typeof p?.label === 'string' ? p.label.trim() : '';
        if (label) {
            param.label = label;
        }
        const defaultValue = typeof p?.defaultValue === 'string' ? p.defaultValue : '';
        if (defaultValue !== '') {
            param.defaultValue = defaultValue;
        }
        result.push(param);
    }
    return result;
}

/**
 * Edits the metadata of every bookmarked query in one place: where it is
 * stored, its name, and the description, type and default value of each of its
 * `:name` placeholders. The statement itself is edited in a normal editor tab.
 */
export class ManageBookmarksPanel {
    public static readonly viewType = 'postgresManageBookmarks';
    private static current: ManageBookmarksPanel | undefined;

    static show(store: SavedQueryStore): void {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        if (ManageBookmarksPanel.current) {
            ManageBookmarksPanel.current.panel.reveal(column);
            ManageBookmarksPanel.current.refresh();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            ManageBookmarksPanel.viewType,
            'Bookmarked Queries',
            column,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        ManageBookmarksPanel.current = new ManageBookmarksPanel(panel, store);
    }

    private readonly disposables: vscode.Disposable[] = [];

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly store: SavedQueryStore
    ) {
        this.panel.webview.html = this.getHtml(this.panel.webview);
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(async (msg) => {
            try {
                switch (msg.command) {
                    case 'ready':
                        this.refresh();
                        break;
                    case 'setScope': {
                        const ids: string[] = Array.isArray(msg.ids) ? msg.ids : [];
                        const scope: SavedQueryScope = msg.scope === 'workspace' ? 'workspace' : 'global';
                        let blocked = 0;
                        for (const id of ids) {
                            if (!await this.store.move(id, scope) && this.store.get(id)?.scope !== scope) {
                                blocked++;
                            }
                        }
                        if (blocked) {
                            vscode.window.showWarningMessage(
                                `${blocked} quer${blocked === 1 ? 'y' : 'ies'} could not be shared: no workspace folder is open.`
                            );
                        }
                        break;
                    }
                    case 'delete': {
                        const ids: string[] = Array.isArray(msg.ids) ? msg.ids : [];
                        for (const id of ids) {
                            await this.store.delete(id);
                        }
                        break;
                    }
                    case 'updateQuery': {
                        const id: string = msg.id;
                        const updates = msg.updates || {};
                        const scope: SavedQueryScope = updates.scope === 'workspace' ? 'workspace' : 'global';
                        const parameters = toParameters(updates.parameters);
                        const patch: { name?: string; sql?: string; parameters: SavedQueryParameter[] } = { parameters };
                        const sql = typeof updates.sql === 'string' ? updates.sql.trim() : '';
                        if (sql && sql !== this.store.get(id)?.sql) {
                            patch.sql = sql;
                            // The placeholders may have changed with the statement.
                            patch.parameters = mergeParameters(sql, parameters);
                        }
                        if (typeof updates.name === 'string' && updates.name.trim()) {
                            patch.name = updates.name.trim();
                        }
                        await this.store.update(id, patch);
                        if (this.store.get(id)?.scope !== scope && !await this.store.move(id, scope)) {
                            vscode.window.showWarningMessage(
                                'The query could not be shared with the workspace: no workspace folder is open.'
                            );
                        }
                        break;
                    }
                    case 'editInEditor':
                        await vscode.commands.executeCommand('postgresQueryBuilder.editSavedQuerySql', msg.id);
                        break;
                    case 'openFile': {
                        const uri = this.store.getWorkspaceFileUri();
                        if (!uri || !this.store.hasWorkspaceFile()) {
                            vscode.window.showInformationMessage(
                                'No workspace file yet. Move a query to the workspace scope to create it.'
                            );
                            break;
                        }
                        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
                        break;
                    }
                }
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Bookmarked Queries: ${getErrorMessage(err)}`);
            }
        }, null, this.disposables);

        this.disposables.push(this.store.onDidChange(() => this.refresh()));
    }

    private refresh(): void {
        const queries = this.store.getAll().map(q => ({
            id: q.id,
            name: q.name,
            scope: q.scope,
            schema: q.schema,
            table: q.table,
            parameters: Array.isArray(q.parameters) ? q.parameters : [],
            sql: q.sql,
            preview: q.sql.replace(/\s+/g, ' ').trim()
        }));
        const fileUri = this.store.getWorkspaceFileUri();
        const filePath = fileUri ? vscode.workspace.asRelativePath(fileUri) : '';
        this.panel.webview.postMessage({ command: 'queriesLoaded', queries, filePath });
    }

    private dispose(): void {
        ManageBookmarksPanel.current = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            try { this.disposables.pop()?.dispose(); } catch { /* ignore */ }
        }
    }

    private getHtml(webview: vscode.Webview): string {
        const styles = `
        body { padding: var(--sp-3) var(--sp-4); }
        h2 { margin: 0 0 var(--sp-2) 0; font-size: var(--fs-lg); }
        .hint { margin-bottom: var(--sp-3); }
        .file-info { font-size: var(--fs-xs); color: var(--c-muted); margin-bottom: var(--sp-3); }
        .file-info code { background: var(--c-code-bg); padding: 1px var(--sp-1); border-radius: var(--radius); }
        .toolbar { margin-bottom: var(--sp-2); padding-bottom: var(--sp-2); border-bottom: 1px solid var(--c-border); }
        .toolbar input[type="text"] { flex: 1 1 200px; min-width: 160px; }
        .selection-info { font-size: var(--fs-sm); color: var(--c-muted); margin-left: auto; }
        thead th { position: sticky; top: 0; z-index: var(--z-sticky); }
        tbody td { vertical-align: top; }
        tbody tr:hover { background: var(--c-hover); }
        tbody tr.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
        .badge { margin-left: var(--sp-1); }
        .badge-workspace { background: var(--vscode-gitDecoration-addedResourceForeground, var(--c-success)); color: var(--c-bg); }
        .badge-personal { background: var(--c-muted); color: var(--c-bg); }
        .empty { padding: var(--sp-6); text-align: center; color: var(--c-muted); }
        .sub { font-size: var(--fs-xs); color: var(--c-muted); margin-top: 2px; }
        .sub em { font-style: italic; }
        .muted { color: var(--c-muted); }
        .push-right { margin-left: auto; }
        /* Edit dialog */
        .dlg { width: 640px; }
        .dlg fieldset { border: 1px solid var(--c-border); border-radius: var(--radius); margin: 0 0 var(--sp-3) 0; padding: var(--sp-2) var(--sp-3); }
        .dlg legend { padding: 0 var(--sp-1); font-size: var(--fs-xs); color: var(--c-muted); }
        .dlg-grid { display: grid; grid-template-columns: 90px 1fr; gap: var(--sp-2); align-items: center; }
        .dlg-grid label { font-size: var(--fs-sm); color: var(--c-muted); }
        .dlg input[type="text"], .dlg select { width: 100%; }
        .dlg-row { display: flex; gap: var(--sp-2); align-items: center; margin-top: var(--sp-2); }
        .dlg-row label { font-size: var(--fs-sm); }
        .param-head, .param-row { display: grid; grid-template-columns: 110px 90px minmax(120px, 1.4fr) minmax(100px, 1fr); gap: var(--sp-1); align-items: center; }
        .param-head { font-size: var(--fs-xs); color: var(--c-muted); margin-bottom: var(--sp-1); }
        .param-row { margin-top: var(--sp-1); }
        .param-name { font-size: var(--fs-sm); overflow: hidden; text-overflow: ellipsis; }
        .dlg textarea { width: 100%; min-height: 140px; resize: vertical; }
        .legend-row { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-1); }
        .legend-row span { font-size: var(--fs-xs); color: var(--c-muted); }`;
        const body = `
    <h2>Bookmarked Queries</h2>
    <div class="hint">Manage where a query is stored and what its placeholders mean. Select entries and change their scope to share them with the team (Workspace) or keep them private (Personal). The statement itself is edited with "Edit Bookmarked Query SQL".</div>
    <div class="file-info" id="fileInfo"></div>

    <div class="toolbar">
        <input type="text" id="filter" placeholder="Filter: name, table, placeholder..." />
        <button class="btn btn-sm" id="selectAll">Select all</button>
        <button class="btn btn-sm" id="selectNone">Clear</button>
        <button class="btn btn-sm" id="invert">Invert</button>
        <button class="btn btn-sm" id="selectPersonal">Personal</button>
        <button class="btn btn-sm" id="selectWorkspace">Workspace</button>
        <span class="selection-info" id="selInfo">0 selected</span>
    </div>
    <div class="toolbar">
        <button class="btn btn-primary" id="moveWorkspace" title="Move the selected queries to the workspace file (will be committed to git)">${icon('goto')}To Workspace</button>
        <button class="btn" id="movePersonal" title="Move the selected queries to your personal store (not shared)">${icon('goto')}To Personal</button>
        <button class="btn btn-danger" id="deleteSel" title="Delete the selected queries">${icon('trash')}Delete</button>
        <button class="btn push-right" id="openFile" title="Open the workspace file the shared queries live in">${icon('edit')}Open workspace file</button>
    </div>

    <table id="tbl">
        <thead>
            <tr>
                <th style="width:24px;"><input type="checkbox" id="headerCheckbox" /></th>
                <th>Scope</th>
                <th>Name</th>
                <th>Source</th>
                <th>Placeholders</th>
                <th style="width:60px;"></th>
            </tr>
        </thead>
        <tbody id="tbody"></tbody>
    </table>
    <div class="empty" id="emptyMsg" style="display:none;">No bookmarked queries yet.</div>

    <!-- Edit dialog -->
    <div class="dlg-overlay" id="editOverlay">
        <div class="dlg">
            <div class="dlg-header">
                <span>Edit Bookmarked Query</span>
                <button class="btn btn-ghost btn-icon" id="editClose" title="Close">${icon('close')}</button>
            </div>
            <div class="dlg-body">
                <fieldset>
                    <legend>Query</legend>
                    <div class="dlg-grid">
                        <label for="editName">Name</label><input type="text" id="editName" />
                    </div>
                    <div class="dlg-row">
                        <input type="checkbox" id="editShare" />
                        <label for="editShare" title="Store this query in the workspace file so it can be committed to git">Share with workspace (commit to git)</label>
                    </div>
                </fieldset>
                <fieldset>
                    <legend>Statement</legend>
                    <div class="legend-row">
                        <span>Placeholders are written as :name and are reconciled when you save.</span>
                        <button class="btn btn-sm push-right" id="editInEditor" title="Open this statement in an editor tab with syntax highlighting and formatting">${icon('goto')}Edit in editor</button>
                    </div>
                    <textarea id="editSql" class="mono" spellcheck="false"></textarea>
                </fieldset>
                <fieldset>
                    <legend>Placeholders</legend>
                    <div class="param-head">
                        <span>Placeholder</span>
                        <span>Type</span>
                        <span>Description</span>
                        <span>Default value</span>
                    </div>
                    <div id="editParams"></div>
                    <div class="sub" id="noParams" style="display:none;">This query takes no placeholders. Write <em>:name</em> in the statement to add one.</div>
                </fieldset>
            </div>
            <div class="dlg-footer">
                <button class="btn btn-primary" id="editSave">${icon('check')}Save</button>
                <button class="btn" id="editCancel">Cancel</button>
            </div>
        </div>
    </div>

`;
        const script = `
        ${WEBVIEW_ESCAPE_HTML_JS}

        const KINDS = ${JSON.stringify(PARAMETER_KINDS)};
        const vscode = acquireVsCodeApi();
        let queries = [];
        let filtered = [];
        let selected = new Set();

        const tbody = document.getElementById('tbody');
        const emptyMsg = document.getElementById('emptyMsg');
        const filterInput = document.getElementById('filter');
        const selInfo = document.getElementById('selInfo');
        const headerCheckbox = document.getElementById('headerCheckbox');
        const fileInfo = document.getElementById('fileInfo');

        function describeParam(p) {
            let text = ':' + escapeHtml(p.name) + ' <span class="muted">(' + escapeHtml(p.kind || 'text') + ')</span>';
            if (p.label) text += ' — ' + escapeHtml(p.label);
            if (p.defaultValue) text += ' <span class="muted">= ' + escapeHtml(p.defaultValue) + '</span>';
            return text;
        }

        function render() {
            const q = filterInput.value.trim().toLowerCase();
            filtered = q ? queries.filter(item => {
                const hay = [item.name, item.schema || '', item.table || '']
                    .concat(item.parameters.map(p => p.name + ' ' + (p.label || '')))
                    .join(' ').toLowerCase();
                return hay.includes(q);
            }) : queries.slice();
            if (filtered.length === 0) {
                tbody.innerHTML = '';
                emptyMsg.style.display = 'block';
                emptyMsg.textContent = queries.length === 0 ? 'No bookmarked queries yet.' : 'No queries match the filter.';
            } else {
                emptyMsg.style.display = 'none';
                tbody.innerHTML = filtered.map(item => {
                    const isSel = selected.has(item.id);
                    const scopeBadge = item.scope === 'workspace'
                        ? '<span class="badge badge-workspace">Workspace</span>'
                        : '<span class="badge badge-personal">Personal</span>';
                    const source = (item.schema && item.table)
                        ? escapeHtml(item.schema) + '.' + escapeHtml(item.table)
                        : '<span class="muted">—</span>';
                    const params = item.parameters.length
                        ? item.parameters.map(p => '<div class="sub">' + describeParam(p) + '</div>').join('')
                        : '<span class="muted">—</span>';
                    return '<tr class="' + (isSel ? 'selected' : '') + '" data-id="' + escapeHtml(item.id) + '">'
                        + '<td><input type="checkbox" class="row-cb"' + (isSel ? ' checked' : '') + ' /></td>'
                        + '<td>' + scopeBadge + '</td>'
                        + '<td>' + escapeHtml(item.name) + '<div class="sub mono">' + escapeHtml(item.preview.slice(0, 80)) + '</div></td>'
                        + '<td class="mono">' + source + '</td>'
                        + '<td>' + params + '</td>'
                        + '<td><button class="btn btn-sm edit-btn" title="Edit this query">${icon('edit')}Edit</button></td>'
                        + '</tr>';
                }).join('');
            }
            updateSelInfo();
        }

        function updateSelInfo() {
            const visIds = filtered.map(item => item.id);
            const visSel = visIds.filter(id => selected.has(id)).length;
            selInfo.textContent = visSel + ' selected (of ' + filtered.length + ' shown, ' + queries.length + ' total)';
            headerCheckbox.checked = filtered.length > 0 && visSel === filtered.length;
            headerCheckbox.indeterminate = visSel > 0 && visSel < filtered.length;
            const hasSel = selected.size > 0;
            document.getElementById('moveWorkspace').disabled = !hasSel;
            document.getElementById('movePersonal').disabled = !hasSel;
            document.getElementById('deleteSel').disabled = !hasSel;
        }

        tbody.addEventListener('click', (e) => {
            const tr = e.target.closest('tr[data-id]');
            if (!tr) return;
            const id = tr.getAttribute('data-id');
            if (e.target.classList.contains('edit-btn')) {
                openEditDialog(id);
                return;
            }
            if (e.target.classList.contains('row-cb')) {
                if (e.target.checked) selected.add(id); else selected.delete(id);
            } else {
                if (selected.has(id)) selected.delete(id); else selected.add(id);
            }
            render();
        });

        headerCheckbox.addEventListener('change', () => {
            const visIds = filtered.map(item => item.id);
            if (headerCheckbox.checked) {
                visIds.forEach(id => selected.add(id));
            } else {
                visIds.forEach(id => selected.delete(id));
            }
            render();
        });

        filterInput.addEventListener('input', render);

        document.getElementById('selectAll').addEventListener('click', () => {
            queries.forEach(item => selected.add(item.id));
            render();
        });
        document.getElementById('selectNone').addEventListener('click', () => {
            selected.clear();
            render();
        });
        document.getElementById('invert').addEventListener('click', () => {
            filtered.map(item => item.id).forEach(id => {
                if (selected.has(id)) selected.delete(id); else selected.add(id);
            });
            render();
        });
        document.getElementById('selectPersonal').addEventListener('click', () => {
            filtered.filter(item => item.scope !== 'workspace').forEach(item => selected.add(item.id));
            render();
        });
        document.getElementById('selectWorkspace').addEventListener('click', () => {
            filtered.filter(item => item.scope === 'workspace').forEach(item => selected.add(item.id));
            render();
        });

        function selectedIds() { return Array.from(selected); }

        document.getElementById('moveWorkspace').addEventListener('click', () => {
            const ids = selectedIds();
            if (!ids.length) return;
            if (!confirm('Move ' + ids.length + ' quer' + (ids.length === 1 ? 'y' : 'ies') + ' to the workspace file?\\nThey will be visible to everyone who clones this workspace once you commit the file.')) return;
            vscode.postMessage({ command: 'setScope', ids, scope: 'workspace' });
        });
        document.getElementById('movePersonal').addEventListener('click', () => {
            const ids = selectedIds();
            if (!ids.length) return;
            if (!confirm('Move ' + ids.length + ' quer' + (ids.length === 1 ? 'y' : 'ies') + ' to your personal store?\\nThey will be removed from the workspace file (commit the change to share the removal).')) return;
            vscode.postMessage({ command: 'setScope', ids, scope: 'global' });
        });
        document.getElementById('deleteSel').addEventListener('click', () => {
            const ids = selectedIds();
            if (!ids.length) return;
            if (!confirm('Delete ' + ids.length + ' quer' + (ids.length === 1 ? 'y' : 'ies') + '? This cannot be undone.')) return;
            vscode.postMessage({ command: 'delete', ids });
        });
        document.getElementById('openFile').addEventListener('click', () => {
            vscode.postMessage({ command: 'openFile' });
        });

        // ===== Edit dialog =====
        let editingId = null;
        const editOverlay = document.getElementById('editOverlay');
        const editParams = document.getElementById('editParams');
        const noParams = document.getElementById('noParams');

        function openEditDialog(id) {
            const item = queries.find(x => x.id === id);
            if (!item) return;
            editingId = id;
            document.getElementById('editName').value = item.name || '';
            document.getElementById('editShare').checked = item.scope === 'workspace';
            document.getElementById('editSql').value = item.sql;
            editParams.innerHTML = '';
            item.parameters.forEach(p => addParamRow(p));
            noParams.style.display = item.parameters.length ? 'none' : 'block';
            editOverlay.classList.add('open');
        }

        function closeEditDialog() {
            editOverlay.classList.remove('open');
            editingId = null;
        }

        function addParamRow(p) {
            const row = document.createElement('div');
            row.className = 'param-row';
            const kindOptions = KINDS.map(k =>
                '<option value="' + k + '"' + ((p.kind || 'text') === k ? ' selected' : '') + '>' + k + '</option>'
            ).join('');
            row.innerHTML =
                '<span class="param-name mono" title="' + escapeHtml(':' + p.name) + '">:' + escapeHtml(p.name) + '</span>' +
                '<select class="p-kind" title="How the value is written into the statement">' + kindOptions + '</select>' +
                '<input type="text" class="p-label" placeholder="what this value means" value="' + escapeHtml(p.label || '') + '" />' +
                '<input type="text" class="p-default" placeholder="optional" value="' + escapeHtml(p.defaultValue || '') + '" />';
            row.setAttribute('data-name', p.name);
            editParams.appendChild(row);
        }

        function gatherParameters() {
            const out = [];
            editParams.querySelectorAll('.param-row').forEach(row => {
                out.push({
                    name: row.getAttribute('data-name'),
                    kind: row.querySelector('.p-kind').value,
                    label: row.querySelector('.p-label').value,
                    defaultValue: row.querySelector('.p-default').value
                });
            });
            return out;
        }

        document.getElementById('editClose').addEventListener('click', closeEditDialog);
        document.getElementById('editCancel').addEventListener('click', closeEditDialog);
        document.getElementById('editInEditor').addEventListener('click', () => {
            if (!editingId) return;
            vscode.postMessage({ command: 'editInEditor', id: editingId });
            closeEditDialog();
        });
        editOverlay.addEventListener('click', (e) => {
            if (e.target === editOverlay) closeEditDialog();
        });

        document.getElementById('editSave').addEventListener('click', () => {
            if (!editingId) return;
            const name = document.getElementById('editName').value.trim();
            if (!name) {
                alert('The name must not be empty.');
                return;
            }
            const sql = document.getElementById('editSql').value.trim();
            if (!sql) {
                alert('The statement must not be empty.');
                return;
            }
            vscode.postMessage({
                command: 'updateQuery',
                id: editingId,
                updates: {
                    name,
                    sql,
                    parameters: gatherParameters(),
                    scope: document.getElementById('editShare').checked ? 'workspace' : 'global'
                }
            });
            closeEditDialog();
        });

        window.addEventListener('message', (e) => {
            const msg = e.data;
            if (msg.command === 'queriesLoaded') {
                queries = msg.queries || [];
                const existing = new Set(queries.map(item => item.id));
                selected = new Set(Array.from(selected).filter(id => existing.has(id)));
                if (msg.filePath) {
                    fileInfo.innerHTML = 'Workspace file: <code>' + escapeHtml(msg.filePath) + '</code>';
                } else {
                    fileInfo.textContent = 'No workspace folder open — only personal queries are available.';
                }
                render();
            }
        });

        vscode.postMessage({ command: 'ready' });`;
        return buildHtmlDocument({ webview, title: 'Bookmarked Queries', styles, body, script });
    }
}
