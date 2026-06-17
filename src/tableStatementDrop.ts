import * as vscode from 'vscode';
import { QueryRunner } from './queryRunner';
import { TreeNode } from './tableExplorer';
import { StatementKind, buildStatement, deriveQualifier, toPreview, autoJoinClauses, JoinFkEdge } from './statementBuilder';
import { showJoinDialog, JoinDialogTable, JoinDialogIdentityEdge, JoinDialogAddPayload } from './joinDialog';
import { ColumnMappingManager } from './columnMappingManager';
import { getErrorMessage } from './logger';

export { StatementKind, buildStatement, deriveQualifier } from './statementBuilder';

/**
 * Custom MIME type used to transfer dragged tables from the tree view into a
 * text editor. The same identifier is advertised by the drag controller and
 * read back by the document drop edit provider.
 */
export const TABLE_DRAG_MIME = 'application/vnd.postgresquerybuilder.table';

interface DraggedTable {
    schema: string;
    table: string;
}

/**
 * Tables dragged from the tree view in the most recent drag gesture. The join
 * dialog webview cannot read VS Code's internal drag payload, so it asks the
 * extension (via `requestAddTables`) which tables were last dragged. Consumed
 * (and cleared) on read so a stale drop does not re-add tables.
 */
let lastDraggedTables: DraggedTable[] = [];

function consumeLastDraggedTables(): DraggedTable[] {
    const tables = lastDraggedTables;
    lastDraggedTables = [];
    return tables;
}

/**
 * Order and labels of the statement choices presented to the user.
 * `select` is the default selection.
 */
const STATEMENT_KINDS: Array<{ kind: StatementKind; label: string }> = [
    { kind: 'name', label: 'Name only' },
    { kind: 'insert', label: 'Insert' },
    { kind: 'delete', label: 'Delete' },
    { kind: 'update', label: 'Update' },
    { kind: 'select', label: 'Select' },
    { kind: 'join', label: 'Join' }
];

const DEFAULT_KIND: StatementKind = 'select';

/**
 * Persists the chosen alias/qualifier per table so it is reused on subsequent
 * drops of the same table.
 */
export class QualifierStore {
    private static readonly KEY = 'tableQualifiers';

    constructor(private readonly memento: vscode.Memento) {}

    get(schema: string, table: string): string | undefined {
        const map = this.memento.get<Record<string, string>>(QualifierStore.KEY, {});
        return map[`${schema}.${table}`];
    }

    async set(schema: string, table: string, qualifier: string): Promise<void> {
        const map = { ...this.memento.get<Record<string, string>>(QualifierStore.KEY, {}) };
        map[`${schema}.${table}`] = qualifier;
        await this.memento.update(QualifierStore.KEY, map);
    }
}

/**
 * Drag controller for the table tree view. Advertises a custom MIME type so
 * dragged tables can be dropped into any text editor.
 */
export class TableDragAndDropController implements vscode.TreeDragAndDropController<TreeNode> {
    readonly dropMimeTypes: string[] = [];
    readonly dragMimeTypes: string[] = [TABLE_DRAG_MIME];

    handleDrag(
        source: readonly TreeNode[],
        dataTransfer: vscode.DataTransfer,
        _token: vscode.CancellationToken
    ): void {
        const tables: DraggedTable[] = source
            .filter((n): n is Extract<TreeNode, { type: 'table' }> => n.type === 'table')
            .map(n => ({ schema: n.schema, table: n.table }));
        if (tables.length === 0) {
            return;
        }
        lastDraggedTables = tables;
        dataTransfer.set(TABLE_DRAG_MIME, new vscode.DataTransferItem(JSON.stringify(tables)));
    }
}

/**
 * Receives tables dropped into a text editor, prompts for the statement kind
 * (with a live preview and an editable alias), and returns the chosen
 * statement to be inserted at the drop position.
 */
export class TableStatementDropProvider implements vscode.DocumentDropEditProvider {
    constructor(
        private readonly queryRunner: QueryRunner,
        private readonly qualifierStore: QualifierStore,
        private readonly columnMappingManager?: ColumnMappingManager
    ) {}

    async provideDocumentDropEdits(
        document: vscode.TextDocument,
        position: vscode.Position,
        dataTransfer: vscode.DataTransfer,
        token: vscode.CancellationToken
    ): Promise<vscode.DocumentDropEdit | undefined> {
        const item = dataTransfer.get(TABLE_DRAG_MIME);
        if (!item) {
            return undefined;
        }

        let tables: DraggedTable[];
        try {
            tables = JSON.parse(await item.asString());
        } catch {
            return undefined;
        }
        if (!Array.isArray(tables) || tables.length === 0) {
            return undefined;
        }

        // Multiple tables: offer a JOIN SELECT builder dialog.
        if (tables.length > 1) {
            const sql = await this.pickJoinStatement(tables);
            if (sql === undefined) {
                return undefined;
            }
            // The dialog is interactive and resolves long after VS Code has
            // finished the drop gesture, so a returned DocumentDropEdit would
            // be ignored. Insert the text ourselves at the drop position.
            await this.insertAt(document, position, sql);
            return undefined;
        }

        const parts: string[] = [];
        for (const t of tables) {
            if (token.isCancellationRequested) {
                return undefined;
            }
            const text = await this.pickStatement(t.schema, t.table);
            if (text === undefined) {
                // User cancelled this table; cancel the whole drop.
                return undefined;
            }
            parts.push(text);
        }

        if (parts.length === 0) {
            return undefined;
        }
        // The quick pick is interactive and resolves after VS Code has
        // finished the drop gesture, so insert the text ourselves rather than
        // relying on a (by then ignored) returned DocumentDropEdit.
        await this.insertAt(document, position, parts.join('\n\n'));
        return undefined;
    }

    /**
     * Insert `text` at `position` in the document. Prefers the active text
     * editor for that document (so the selection/cursor is updated), and falls
     * back to a workspace edit otherwise.
     */
    private async insertAt(
        document: vscode.TextDocument,
        position: vscode.Position,
        text: string
    ): Promise<void> {
        const editor = vscode.window.visibleTextEditors.find(
            e => e.document.uri.toString() === document.uri.toString()
        );
        if (editor) {
            await editor.edit(editBuilder => editBuilder.insert(position, text));
            const inserted = editor.document.positionAt(
                editor.document.offsetAt(position) + text.length
            );
            editor.selection = new vscode.Selection(inserted, inserted);
            return;
        }
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, position, text);
        await vscode.workspace.applyEdit(edit);
    }

    /**
     * Build join edges derived from user-defined custom column mappings, for the
     * given set of join tables. A mapping `A.col -> B.col` becomes an edge when
     * both A and B are part of the join. Columns are returned in their quoted
     * form (resolved from the table's column list) so they match the FK edges.
     */
    private customMappingEdges(
        joinTables: ReadonlyArray<{ schema: string; table: string; columns: string[]; rawColumns: string[] }>
    ): JoinDialogIdentityEdge[] {
        if (!this.columnMappingManager) {
            return [];
        }
        const find = (schema: string, table: string) =>
            joinTables.find(t => t.schema === schema && t.table === table);
        const quoteCol = (
            t: { columns: string[]; rawColumns: string[] },
            rawCol: string
        ): string | undefined => {
            const i = t.rawColumns.indexOf(rawCol);
            return i >= 0 ? t.columns[i] : undefined;
        };

        const edges: JoinDialogIdentityEdge[] = [];
        const seen = new Set<string>();
        for (const m of this.columnMappingManager.getAllMappings()) {
            const src = find(m.sourceSchema, m.sourceTable);
            const tgt = find(m.targetSchema, m.targetTable);
            if (!src || !tgt) {
                continue;
            }
            const fromCol = quoteCol(src, m.sourceColumn);
            const toCol = quoteCol(tgt, m.targetColumn);
            if (!fromCol || !toCol) {
                continue;
            }
            const sig = `${m.sourceSchema}.${m.sourceTable}.${fromCol}->${m.targetSchema}.${m.targetTable}.${toCol}`;
            if (seen.has(sig)) {
                continue;
            }
            seen.add(sig);
            // A mapping condition references a column on the mapping's source
            // table. Resolve it to its quoted form so it matches the join columns.
            const extraConditions = (m.conditions ?? [])
                .map(cond => {
                    const col = quoteCol(src, cond.column);
                    return col
                        ? { schema: m.sourceSchema, table: m.sourceTable, column: col, operator: cond.operator, value: cond.value }
                        : undefined;
                })
                .filter((c): c is NonNullable<typeof c> => !!c);
            edges.push({
                fromSchema: m.sourceSchema,
                fromTable: m.sourceTable,
                fromColumn: fromCol,
                toSchema: m.targetSchema,
                toTable: m.targetTable,
                toColumn: toCol,
                extraConditions: extraConditions.length ? extraConditions : undefined
            });
        }
        return edges;
    }

    private async pickJoinStatement(tables: DraggedTable[]): Promise<string | undefined> {
        // The tables that opened this dialog are already part of the join, so
        // clear any leftover drag state to keep the first "Add tables…" click
        // from re-consuming them (which would otherwise be a no-op).
        consumeLastDraggedTables();
        let data: Awaited<ReturnType<QueryRunner['getMultiTableJoinData']>>;
        try {
            data = await this.queryRunner.getMultiTableJoinData(tables);
        } catch (err: unknown) {
            vscode.window.showErrorMessage(`Failed to load tables for JOIN: ${getErrorMessage(err)}`);
            return undefined;
        }
        const dialogTables: JoinDialogTable[] = data.tables.map(t => ({
            schema: t.schema,
            table: t.table,
            tableReference: t.tableReference,
            alias: this.qualifierStore.get(t.schema, t.table)
                ?? deriveQualifier(t.firstColumnRaw, t.table),
            columns: t.columns
        }));

        // Ensure aliases are unique so qualified columns are unambiguous.
        const seen = new Map<string, number>();
        for (const dt of dialogTables) {
            const base = dt.alias;
            const n = seen.get(base) ?? 0;
            if (n > 0) {
                dt.alias = `${base}${n + 1}`;
            }
            seen.set(base, n + 1);
        }

        const indexOf = (schema: string, table: string) =>
            data.tables.findIndex(t => t.schema === schema && t.table === table);

        const fkEdges: JoinFkEdge[] = data.foreignKeys
            .map(fk => ({
                fromIndex: indexOf(fk.fromSchema, fk.fromTable),
                fromColumn: fk.fromColumn,
                toIndex: indexOf(fk.toSchema, fk.toTable),
                toColumn: fk.toColumn
            }))
            .filter(e => e.fromIndex >= 0 && e.toIndex >= 0);

        // Also derive edges from user-defined custom column mappings.
        for (const ce of this.customMappingEdges(data.tables)) {
            const fromIndex = indexOf(ce.fromSchema, ce.fromTable);
            const toIndex = indexOf(ce.toSchema, ce.toTable);
            if (fromIndex < 0 || toIndex < 0) {
                continue;
            }
            const dup = fkEdges.some(e =>
                e.fromIndex === fromIndex && e.toIndex === toIndex
                && e.fromColumn === ce.fromColumn && e.toColumn === ce.toColumn);
            if (!dup) {
                const extraConditions = (ce.extraConditions ?? [])
                    .map(ec => {
                        const ti = indexOf(ec.schema, ec.table);
                        return ti >= 0
                            ? { tableIndex: ti, column: ec.column, operator: ec.operator, value: ec.value }
                            : undefined;
                    })
                    .filter((c): c is NonNullable<typeof c> => !!c);
                fkEdges.push({
                    fromIndex,
                    fromColumn: ce.fromColumn,
                    toIndex,
                    toColumn: ce.toColumn,
                    extraConditions: extraConditions.length ? extraConditions : undefined
                });
            }
        }

        const initialJoins = autoJoinClauses(
            dialogTables.map(t => t.alias),
            fkEdges
        );

        // Track the set of tables currently in the dialog so dropping more
        // tables can skip duplicates and recompute FK edges over the full set.
        const currentSet: DraggedTable[] = data.tables.map(t => ({ schema: t.schema, table: t.table }));

        const onAddTables = async (): Promise<JoinDialogAddPayload | undefined> => {
            // Prefer tables from a just-completed drag gesture; otherwise let the
            // user pick from all available tables. (Dropping a tree item onto a
            // webview does not reliably deliver a DOM drop event, so the dialog
            // also exposes a clickable "Add tables…" affordance that routes here.)
            let candidates = consumeLastDraggedTables();
            if (candidates.length === 0) {
                candidates = await this.promptForTables(currentSet);
            }
            if (candidates.length === 0) {
                return undefined;
            }
            // The same table may be added again as another instance (with its
            // own alias and join clause), so duplicates are not filtered out.
            // Only genuinely new tables need their metadata fetched; build a
            // de-duplicated set for the join-data query.
            const trulyNew = candidates.filter(
                d => !currentSet.some(c => c.schema === d.schema && c.table === d.table)
            );
            const uniqueCombined: DraggedTable[] = [];
            for (const t of [...currentSet, ...trulyNew]) {
                if (!uniqueCombined.some(u => u.schema === t.schema && u.table === t.table)) {
                    uniqueCombined.push(t);
                }
            }
            let combinedData: Awaited<ReturnType<QueryRunner['getMultiTableJoinData']>>;
            try {
                combinedData = await this.queryRunner.getMultiTableJoinData(uniqueCombined);
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Failed to add tables to JOIN: ${getErrorMessage(err)}`);
                return undefined;
            }

            const newDialogTables: JoinDialogTable[] = candidates.map(n => {
                const td = combinedData.tables.find(t => t.schema === n.schema && t.table === n.table)!;
                return {
                    schema: td.schema,
                    table: td.table,
                    tableReference: td.tableReference,
                    alias: this.qualifierStore.get(td.schema, td.table)
                        ?? deriveQualifier(td.firstColumnRaw, td.table),
                    columns: td.columns
                };
            });

            const edges: JoinDialogIdentityEdge[] = combinedData.foreignKeys.map(fk => ({
                fromSchema: fk.fromSchema,
                fromTable: fk.fromTable,
                fromColumn: fk.fromColumn,
                toSchema: fk.toSchema,
                toTable: fk.toTable,
                toColumn: fk.toColumn
            }));

            // Include edges derived from custom column mappings over the full set.
            for (const ce of this.customMappingEdges(combinedData.tables)) {
                const dup = edges.some(e =>
                    e.fromSchema === ce.fromSchema && e.fromTable === ce.fromTable && e.fromColumn === ce.fromColumn
                    && e.toSchema === ce.toSchema && e.toTable === ce.toTable && e.toColumn === ce.toColumn);
                if (!dup) {
                    edges.push(ce);
                }
            }

            currentSet.push(...candidates);
            return { tables: newDialogTables, fkEdges: edges };
        };

        const onRemoveTable = (schema: string, table: string): void => {
            const i = currentSet.findIndex(c => c.schema === schema && c.table === table);
            if (i >= 0) {
                currentSet.splice(i, 1);
            }
        };

        const result = await showJoinDialog(dialogTables, fkEdges, initialJoins, onAddTables, onRemoveTable);
        if (!result) {
            return undefined;
        }
        // Remember the chosen alias for each table so it is reused next time.
        for (const a of result.aliases) {
            if (a.alias && a.alias.trim()) {
                await this.qualifierStore.set(a.schema, a.table, a.alias.trim());
            }
        }
        return result.sql;
    }

    /**
     * Show a multi-select quick pick of all tables, used when the user clicks
     * the dialog's "Add tables…" affordance. Tables already in the join are
     * included too, so the same table can be added again as another instance
     * with its own alias and join clause (e.g. a self-join).
     */
    private async promptForTables(
        current: ReadonlyArray<DraggedTable>
    ): Promise<DraggedTable[]> {
        let all: Array<{ schema: string; table: string }>;
        try {
            all = await this.queryRunner.listAllTables();
        } catch (err: unknown) {
            vscode.window.showErrorMessage(`Failed to list tables: ${getErrorMessage(err)}`);
            return [];
        }
        if (all.length === 0) {
            vscode.window.showInformationMessage('No tables available to add.');
            return [];
        }
        const inJoin = (t: { schema: string; table: string }) =>
            current.some(c => c.schema === t.schema && c.table === t.table);
        const picks = await vscode.window.showQuickPick(
            all.map(t => ({
                label: `${t.schema}.${t.table}`,
                description: inJoin(t) ? 'already in join — adds another instance' : undefined,
                schema: t.schema,
                table: t.table
            })),
            {
                canPickMany: true,
                title: 'Add tables to JOIN',
                placeHolder: 'Select one or more tables to add to the join'
            }
        );
        if (!picks || picks.length === 0) {
            return [];
        }
        return picks.map(p => ({ schema: p.schema, table: p.table }));
    }

    private async pickStatement(schema: string, table: string): Promise<string | undefined> {
        let build: { tableReference: string; columns: string[]; columnTypes: string[]; firstColumnRaw: string | null };
        try {
            build = await this.queryRunner.getStatementBuildData(schema, table);
        } catch (err: unknown) {
            vscode.window.showErrorMessage(`Failed to load columns for ${schema}.${table}: ${getErrorMessage(err)}`);
            return undefined;
        }

        let qualifier = this.qualifierStore.get(schema, table)
            ?? deriveQualifier(build.firstColumnRaw, table);

        interface KindItem extends vscode.QuickPickItem {
            statementKind: StatementKind;
        }

        return await new Promise<string | undefined>(resolve => {
            const qp = vscode.window.createQuickPick<KindItem>();
            qp.ignoreFocusOut = true;
            qp.matchOnDescription = true;
            const editButton: vscode.QuickInputButton = {
                iconPath: new vscode.ThemeIcon('edit'),
                tooltip: 'Change alias/qualifier for this table'
            };
            qp.buttons = [editButton];

            let activeKind: StatementKind = DEFAULT_KIND;
            let editing = false;
            let settled = false;

            const buildText = (kind: StatementKind) =>
                buildStatement(kind, { tableReference: build.tableReference, columns: build.columns, columnTypes: build.columnTypes, qualifier });

            const rebuild = () => {
                qp.title = `Insert statement for ${schema}.${table}  —  alias: ${qualifier}`;
                qp.placeholder = 'Pick a statement type (preview shown below) — Enter to insert';
                qp.items = STATEMENT_KINDS.map(({ kind, label }) => ({
                    label,
                    statementKind: kind,
                    description: kind === DEFAULT_KIND ? '(default)' : undefined,
                    detail: kind === 'join'
                        ? 'Opens the interactive JOIN builder (add tables, set conditions)'
                        : toPreview(buildText(kind))
                }));
                const active = qp.items.find(i => i.statementKind === activeKind);
                if (active) {
                    qp.activeItems = [active];
                }
            };

            qp.onDidChangeActive(active => {
                if (active[0]) {
                    activeKind = active[0].statementKind;
                }
            });

            qp.onDidTriggerButton(async () => {
                editing = true;
                qp.hide();
                const value = await vscode.window.showInputBox({
                    title: `Alias for ${schema}.${table}`,
                    prompt: 'Alias/qualifier used to prefix columns in generated statements',
                    value: qualifier,
                    validateInput: v =>
                        v.trim().length === 0 ? 'Alias cannot be empty' : undefined
                });
                editing = false;
                if (value && value.trim()) {
                    qualifier = value.trim();
                    await this.qualifierStore.set(schema, table, qualifier);
                }
                rebuild();
                qp.show();
            });

            qp.onDidAccept(async () => {
                const selected = qp.selectedItems[0] ?? qp.activeItems[0];
                if (!selected) {
                    return;
                }
                settled = true;
                qp.dispose();
                if (selected.statementKind === 'join') {
                    // Open the interactive JOIN builder seeded with this table so
                    // the user can add more tables and configure the join.
                    const sql = await this.pickJoinStatement([{ schema, table }]);
                    resolve(sql);
                    return;
                }
                const text = buildText(selected.statementKind);
                resolve(text);
            });

            qp.onDidHide(() => {
                if (editing || settled) {
                    return;
                }
                qp.dispose();
                resolve(undefined);
            });

            rebuild();
            qp.show();
        });
    }
}
