import * as vscode from 'vscode';
import { ColumnMappingManager, CustomColumnMapping, MappingScope } from './columnMappingManager';
import { buildHtmlDocument, WEBVIEW_ESCAPE_HTML_JS } from './webviewUtils';
import { icon } from './webviewAssets';
import { getErrorMessage } from './logger';

export class ManageMappingsPanel {
    public static readonly viewType = 'postgresManageMappings';
    private static current: ManageMappingsPanel | undefined;

    static show(context: vscode.ExtensionContext, manager: ColumnMappingManager): void {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        if (ManageMappingsPanel.current) {
            ManageMappingsPanel.current.panel.reveal(column);
            ManageMappingsPanel.current.refresh();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            ManageMappingsPanel.viewType,
            'Custom Mappings',
            column,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        ManageMappingsPanel.current = new ManageMappingsPanel(panel, context, manager);
    }

    private readonly disposables: vscode.Disposable[] = [];

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        _context: vscode.ExtensionContext,
        private readonly manager: ColumnMappingManager
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
                        const scope: MappingScope = msg.scope === 'workspace' ? 'workspace' : 'global';
                        for (const id of ids) {
                            await this.manager.updateMapping(id, { scope });
                        }
                        break;
                    }
                    case 'delete': {
                        const ids: string[] = Array.isArray(msg.ids) ? msg.ids : [];
                        for (const id of ids) {
                            await this.manager.deleteMapping(id);
                        }
                        break;
                    }
                    case 'updateMapping': {
                        const id: string = msg.id;
                        const updates = msg.updates || {};
                        await this.manager.updateMapping(id, updates);
                        break;
                    }
                    case 'openFile': {
                        const uri = this.manager.getWorkspaceFileUri();
                        if (uri) {
                            try {
                                const doc = await vscode.workspace.openTextDocument(uri);
                                await vscode.window.showTextDocument(doc);
                            } catch {
                                vscode.window.showInformationMessage('The workspace mappings file does not exist yet. Mark a mapping as "Workspace" to create it.');
                            }
                        } else {
                            vscode.window.showWarningMessage('No workspace folder is open.');
                        }
                        break;
                    }
                }
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Manage Mappings: ${getErrorMessage(err)}`);
            }
        }, null, this.disposables);

        this.disposables.push(this.manager.onDidChange(() => this.refresh()));
    }

    private refresh(): void {
        const mappings = this.manager.getAllMappings()
            .filter(m => !m.reversed)
            .map(m => ({
                id: m.id,
                scope: m.scope,
                isDefault: m.isDefault,
                label: m.label,
                sourceSchema: m.sourceSchema,
                sourceTable: m.sourceTable,
                sourceColumn: m.sourceColumn,
                targetSchema: m.targetSchema,
                targetTable: m.targetTable,
                targetColumn: m.targetColumn,
                conditions: m.conditions,
                additionalColumnPairs: m.additionalColumnPairs
            }));
        const fileUri = this.manager.getWorkspaceFileUri();
        const filePath = fileUri ? vscode.workspace.asRelativePath(fileUri) : '';
        this.panel.webview.postMessage({ command: 'mappingsLoaded', mappings, filePath });
    }

    private dispose(): void {
        ManageMappingsPanel.current = undefined;
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
        .badge-default { background: var(--vscode-charts-blue, var(--vscode-badge-background)); color: var(--vscode-badge-foreground); }
        .empty { padding: var(--sp-6); text-align: center; color: var(--c-muted); }
        .cond { font-size: var(--fs-xs); color: var(--c-muted); margin-top: 2px; font-style: italic; }
        .muted { color: var(--c-muted); }
        .push-right { margin-left: auto; }
        /* Edit dialog */
        .dlg { width: 560px; }
        .dlg fieldset { border: 1px solid var(--c-border); border-radius: var(--radius); margin: 0 0 var(--sp-3) 0; padding: var(--sp-2) var(--sp-3); }
        .dlg legend { padding: 0 var(--sp-1); font-size: var(--fs-xs); color: var(--c-muted); }
        .dlg-grid { display: grid; grid-template-columns: 90px 1fr 60px 1fr; gap: var(--sp-2); align-items: center; }
        .dlg-grid label { font-size: var(--fs-sm); color: var(--c-muted); }
        .dlg input[type="text"], .dlg select { width: 100%; }
        .dlg-row { display: flex; gap: var(--sp-2); align-items: center; margin-top: var(--sp-2); }
        .dlg-row label { font-size: var(--fs-sm); }
        .cond-row { display: grid; grid-template-columns: minmax(160px, 2fr) 80px minmax(120px, 1fr) 28px; gap: var(--sp-1); margin-top: var(--sp-1); align-items: center; }
        .mt-2 { margin-top: var(--sp-2); }`;
        const body = `
    <h2>Custom Column Mappings</h2>
    <div class="hint">Manage all mappings in one place. Select entries and change their scope to share them with the team (Workspace) or keep them private (Personal).</div>
    <div class="file-info" id="fileInfo"></div>

    <div class="toolbar">
        <input type="text" id="filter" placeholder="Filter: source/target table, column, label..." />
        <button class="btn btn-sm" id="selectAll">Select all</button>
        <button class="btn btn-sm" id="selectNone">Clear</button>
        <button class="btn btn-sm" id="invert">Invert</button>
        <button class="btn btn-sm" id="selectPersonal">Personal</button>
        <button class="btn btn-sm" id="selectWorkspace">Workspace</button>
        <span class="selection-info" id="selInfo">0 selected</span>
    </div>
    <div class="toolbar">
        <button class="btn btn-primary" id="moveWorkspace" title="Move selected mappings to the workspace file (will be committed to git)">${icon('goto')}To Workspace</button>
        <button class="btn" id="movePersonal" title="Move selected mappings to your personal store (not shared)">${icon('goto')}To Personal</button>
        <button class="btn btn-danger" id="deleteSel" title="Delete the selected mappings">${icon('trash')}Delete</button>
        <button class="btn push-right" id="openFile" title="Open the workspace mappings file">${icon('edit')}Open workspace file</button>
    </div>

    <table id="tbl">
        <thead>
            <tr>
                <th style="width:24px;"><input type="checkbox" id="headerCheckbox" /></th>
                <th>Scope</th>
                <th>Source</th>
                <th>Target</th>
                <th>Label / Conditions</th>
                <th style="width:60px;"></th>
            </tr>
        </thead>
        <tbody id="tbody"></tbody>
    </table>
    <div class="empty" id="emptyMsg" style="display:none;">No custom mappings defined.</div>

    <!-- Edit dialog -->
    <div class="dlg-overlay" id="editOverlay">
        <div class="dlg">
            <div class="dlg-header">
                <span>Edit Custom Column Mapping</span>
                <button class="btn btn-ghost btn-icon" id="editClose" title="Close">${icon('close')}</button>
            </div>
            <div class="dlg-body">
                <fieldset>
                    <legend>Source</legend>
                    <div class="dlg-grid">
                        <label for="editSrcSchema">Schema</label><input type="text" id="editSrcSchema" />
                        <label for="editSrcTable">Table</label><input type="text" id="editSrcTable" />
                        <label for="editSrcColumn">Column</label><input type="text" id="editSrcColumn" />
                        <label></label><span></span>
                    </div>
                </fieldset>
                <fieldset>
                    <legend>Target</legend>
                    <div class="dlg-grid">
                        <label for="editTgtSchema">Schema</label><input type="text" id="editTgtSchema" />
                        <label for="editTgtTable">Table</label><input type="text" id="editTgtTable" />
                        <label for="editTgtColumn">Column</label><input type="text" id="editTgtColumn" />
                        <label></label><span></span>
                    </div>
                </fieldset>
                <fieldset>
                    <legend>Metadata</legend>
                    <div class="dlg-grid">
                        <label for="editLabel">Label</label><input type="text" id="editLabel" placeholder="optional display name" />
                        <label></label><span></span>
                    </div>
                    <div class="dlg-row">
                        <input type="checkbox" id="editIsDefault" />
                        <label for="editIsDefault">Set as default (show FK button in cell)</label>
                    </div>
                    <div class="dlg-row">
                        <input type="checkbox" id="editShare" />
                        <label for="editShare" title="Store this mapping in the workspace mappings file so it can be committed to git">Share with workspace (commit to git)</label>
                    </div>
                </fieldset>
                <fieldset>
                    <legend>Conditions (optional)</legend>
                    <div id="editConditions"></div>
                    <button class="btn btn-sm mt-2" id="editAddCondition">${icon('add')}Add Condition</button>
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

        const vscode = acquireVsCodeApi();
        let mappings = [];
        let filtered = [];
        let selected = new Set();

        const tbody = document.getElementById('tbody');
        const emptyMsg = document.getElementById('emptyMsg');
        const filterInput = document.getElementById('filter');
        const selInfo = document.getElementById('selInfo');
        const headerCheckbox = document.getElementById('headerCheckbox');
        const fileInfo = document.getElementById('fileInfo');

        function render() {
            const q = filterInput.value.trim().toLowerCase();
            filtered = q ? mappings.filter(m => {
                const hay = [m.sourceSchema, m.sourceTable, m.sourceColumn, m.targetSchema, m.targetTable, m.targetColumn, m.label || ''].join(' ').toLowerCase();
                return hay.includes(q);
            }) : mappings.slice();
            if (filtered.length === 0) {
                tbody.innerHTML = '';
                emptyMsg.style.display = 'block';
                emptyMsg.textContent = mappings.length === 0 ? 'No custom mappings defined.' : 'No mappings match the filter.';
            } else {
                emptyMsg.style.display = 'none';
                tbody.innerHTML = filtered.map(m => {
                    const isSel = selected.has(m.id);
                    const scopeBadge = m.scope === 'workspace'
                        ? '<span class="badge badge-workspace">Workspace</span>'
                        : '<span class="badge badge-personal">Personal</span>';
                    const defBadge = m.isDefault ? '<span class="badge badge-default">Default</span>' : '';
                    const cond = (m.conditions && m.conditions.length)
                        ? '<div class="cond">IF ' + m.conditions.map(c => escapeHtml(c.column) + ' ' + escapeHtml(c.operator) + " '" + escapeHtml(c.value) + "'").join(' AND ') + '</div>'
                        : '';
                    const pairs = (m.additionalColumnPairs && m.additionalColumnPairs.length)
                        ? '<div class="cond">+ ' + m.additionalColumnPairs.map(p => escapeHtml(p.sourceColumn) + ' = ' + escapeHtml(p.targetColumn)).join(' AND ') + '</div>'
                        : '';
                    const label = m.label ? '<div>' + escapeHtml(m.label) + '</div>' : '';
                    return '<tr class="' + (isSel ? 'selected' : '') + '" data-id="' + escapeHtml(m.id) + '">'
                        + '<td><input type="checkbox" class="row-cb"' + (isSel ? ' checked' : '') + ' /></td>'
                        + '<td>' + scopeBadge + defBadge + '</td>'
                        + '<td class="mono">' + escapeHtml(m.sourceSchema) + '.' + escapeHtml(m.sourceTable) + '.' + escapeHtml(m.sourceColumn) + '</td>'
                        + '<td class="mono">' + escapeHtml(m.targetSchema) + '.' + escapeHtml(m.targetTable) + '.' + escapeHtml(m.targetColumn) + '</td>'
                        + '<td>' + label + cond + pairs + (label || cond || pairs ? '' : '<span class="muted">—</span>') + '</td>'
                        + '<td><button class="btn btn-sm edit-btn" title="Edit this mapping">${icon('edit')}Edit</button></td>'
                        + '</tr>';
                }).join('');
            }
            updateSelInfo();
        }

        function updateSelInfo() {
            const visIds = filtered.map(m => m.id);
            const visSel = visIds.filter(id => selected.has(id)).length;
            selInfo.textContent = visSel + ' selected (of ' + filtered.length + ' shown, ' + mappings.length + ' total)';
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
            const visIds = filtered.map(m => m.id);
            if (headerCheckbox.checked) {
                visIds.forEach(id => selected.add(id));
            } else {
                visIds.forEach(id => selected.delete(id));
            }
            render();
        });

        filterInput.addEventListener('input', render);

        document.getElementById('selectAll').addEventListener('click', () => {
            mappings.forEach(m => selected.add(m.id));
            render();
        });
        document.getElementById('selectNone').addEventListener('click', () => {
            selected.clear();
            render();
        });
        document.getElementById('invert').addEventListener('click', () => {
            const ids = filtered.map(m => m.id);
            ids.forEach(id => {
                if (selected.has(id)) selected.delete(id); else selected.add(id);
            });
            render();
        });
        document.getElementById('selectPersonal').addEventListener('click', () => {
            filtered.filter(m => m.scope !== 'workspace').forEach(m => selected.add(m.id));
            render();
        });
        document.getElementById('selectWorkspace').addEventListener('click', () => {
            filtered.filter(m => m.scope === 'workspace').forEach(m => selected.add(m.id));
            render();
        });

        function selectedIds() { return Array.from(selected); }

        document.getElementById('moveWorkspace').addEventListener('click', () => {
            const ids = selectedIds();
            if (!ids.length) return;
            if (!confirm('Move ' + ids.length + ' mapping(s) to the workspace file?\\nThey will be visible to everyone who clones this workspace once you commit the file.')) return;
            vscode.postMessage({ command: 'setScope', ids, scope: 'workspace' });
        });
        document.getElementById('movePersonal').addEventListener('click', () => {
            const ids = selectedIds();
            if (!ids.length) return;
            if (!confirm('Move ' + ids.length + ' mapping(s) to your personal store?\\nThey will be removed from the workspace file (commit the change to share the removal).')) return;
            vscode.postMessage({ command: 'setScope', ids, scope: 'global' });
        });
        document.getElementById('deleteSel').addEventListener('click', () => {
            const ids = selectedIds();
            if (!ids.length) return;
            if (!confirm('Delete ' + ids.length + ' mapping(s)? This cannot be undone.')) return;
            vscode.postMessage({ command: 'delete', ids });
        });
        document.getElementById('openFile').addEventListener('click', () => {
            vscode.postMessage({ command: 'openFile' });
        });

        // ===== Edit dialog =====
        const OPERATORS = ['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'ILIKE'];
        let editingId = null;
        const editOverlay = document.getElementById('editOverlay');
        const editConditions = document.getElementById('editConditions');

        function openEditDialog(id) {
            const m = mappings.find(x => x.id === id);
            if (!m) return;
            editingId = id;
            document.getElementById('editSrcSchema').value = m.sourceSchema || '';
            document.getElementById('editSrcTable').value = m.sourceTable || '';
            document.getElementById('editSrcColumn').value = m.sourceColumn || '';
            document.getElementById('editTgtSchema').value = m.targetSchema || '';
            document.getElementById('editTgtTable').value = m.targetTable || '';
            document.getElementById('editTgtColumn').value = m.targetColumn || '';
            document.getElementById('editLabel').value = m.label || '';
            document.getElementById('editIsDefault').checked = !!m.isDefault;
            document.getElementById('editShare').checked = m.scope === 'workspace';
            editConditions.innerHTML = '';
            (m.conditions || []).forEach(c => addCondRow(c));
            editOverlay.classList.add('open');
        }

        function closeEditDialog() {
            editOverlay.classList.remove('open');
            editingId = null;
        }

        function addCondRow(cond) {
            const row = document.createElement('div');
            row.className = 'cond-row';
            const opOptions = OPERATORS.map(o => '<option value="' + o + '"' + (cond && cond.operator === o ? ' selected' : '') + '>' + o + '</option>').join('');
            row.innerHTML =
                '<input type="text" class="cond-col" placeholder="column" value="' + escapeHtml(cond && cond.column || '') + '" />' +
                '<select class="cond-op">' + opOptions + '</select>' +
                '<input type="text" class="cond-val" placeholder="value" value="' + escapeHtml(cond && cond.value || '') + '" />' +
                '<button class="secondary cond-del" title="Remove condition">&times;</button>';
            row.querySelector('.cond-del').addEventListener('click', () => row.remove());
            editConditions.appendChild(row);
        }

        function gatherConditions() {
            const out = [];
            editConditions.querySelectorAll('.cond-row').forEach(row => {
                const col = row.querySelector('.cond-col').value.trim();
                const op = row.querySelector('.cond-op').value;
                const val = row.querySelector('.cond-val').value;
                if (col) out.push({ column: col, operator: op, value: val });
            });
            return out;
        }

        document.getElementById('editAddCondition').addEventListener('click', (e) => {
            e.preventDefault();
            addCondRow(null);
        });
        document.getElementById('editClose').addEventListener('click', closeEditDialog);
        document.getElementById('editCancel').addEventListener('click', closeEditDialog);
        editOverlay.addEventListener('click', (e) => {
            if (e.target === editOverlay) closeEditDialog();
        });

        document.getElementById('editSave').addEventListener('click', () => {
            if (!editingId) return;
            const updates = {
                sourceSchema: document.getElementById('editSrcSchema').value.trim(),
                sourceTable: document.getElementById('editSrcTable').value.trim(),
                sourceColumn: document.getElementById('editSrcColumn').value.trim(),
                targetSchema: document.getElementById('editTgtSchema').value.trim() || 'public',
                targetTable: document.getElementById('editTgtTable').value.trim(),
                targetColumn: document.getElementById('editTgtColumn').value.trim(),
                label: document.getElementById('editLabel').value.trim() || undefined,
                isDefault: document.getElementById('editIsDefault').checked,
                conditions: gatherConditions(),
                scope: document.getElementById('editShare').checked ? 'workspace' : 'global'
            };
            if (!updates.sourceSchema || !updates.sourceTable || !updates.sourceColumn || !updates.targetTable || !updates.targetColumn) {
                alert('Source schema/table/column and target table/column are required.');
                return;
            }
            vscode.postMessage({ command: 'updateMapping', id: editingId, updates });
            closeEditDialog();
        });

        window.addEventListener('message', (e) => {
            const msg = e.data;
            if (msg.command === 'mappingsLoaded') {
                mappings = msg.mappings || [];
                // Drop selections that no longer exist.
                const existing = new Set(mappings.map(m => m.id));
                selected = new Set(Array.from(selected).filter(id => existing.has(id)));
                if (msg.filePath) {
                    fileInfo.innerHTML = 'Workspace file: <code>' + escapeHtml(msg.filePath) + '</code>';
                } else {
                    fileInfo.textContent = 'No workspace folder open — only personal mappings are available.';
                }
                render();
            }
        });

        vscode.postMessage({ command: 'ready' });`;
        return buildHtmlDocument({ webview, styles, body, script });
    }
}
