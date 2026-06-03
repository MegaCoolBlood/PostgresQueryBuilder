import * as vscode from 'vscode';
import { QueryRunner } from './queryRunner';
import { TreeNode } from './tableExplorer';
import { StatementKind, buildStatement, deriveQualifier, toPreview, autoJoinClauses, JoinFkEdge } from './statementBuilder';
import { showJoinDialog, JoinDialogTable } from './joinDialog';

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
        private readonly qualifierStore: QualifierStore
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

    private async pickJoinStatement(tables: DraggedTable[]): Promise<string | undefined> {
        let data: Awaited<ReturnType<QueryRunner['getMultiTableJoinData']>>;
        try {
            data = await this.queryRunner.getMultiTableJoinData(tables);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to load tables for JOIN: ${err?.message || err}`);
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

        const initialJoins = autoJoinClauses(
            dialogTables.map(t => t.alias),
            fkEdges
        );

        const result = await showJoinDialog(dialogTables, fkEdges, initialJoins);
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

    private async pickStatement(schema: string, table: string): Promise<string | undefined> {
        let build: { tableReference: string; columns: string[]; columnTypes: string[]; firstColumnRaw: string | null };
        try {
            build = await this.queryRunner.getStatementBuildData(schema, table);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to load columns for ${schema}.${table}: ${err?.message || err}`);
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
                    detail: toPreview(buildText(kind))
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

            qp.onDidAccept(() => {
                const selected = qp.selectedItems[0] ?? qp.activeItems[0];
                if (!selected) {
                    return;
                }
                settled = true;
                const text = buildText(selected.statementKind);
                qp.dispose();
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
