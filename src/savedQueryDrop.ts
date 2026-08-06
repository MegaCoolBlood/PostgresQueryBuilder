import * as vscode from 'vscode';
import { SavedQueryStore } from './savedQueryStore';
import { SavedQueryTreeNode } from './savedQueryExplorer';

/**
 * Custom MIME type used to transfer saved queries from the tree view into a
 * text editor. Advertised by the drag controller and read back by the document
 * drop edit provider.
 */
export const SAVED_QUERY_DRAG_MIME = 'application/vnd.postgresquerybuilder.savedquery';

/** Drag controller for the "Saved Queries" tree view. */
export class SavedQueryDragController implements vscode.TreeDragAndDropController<SavedQueryTreeNode> {
    readonly dropMimeTypes: string[] = [];
    readonly dragMimeTypes: string[] = [SAVED_QUERY_DRAG_MIME];

    handleDrag(
        source: readonly SavedQueryTreeNode[],
        dataTransfer: vscode.DataTransfer,
        _token: vscode.CancellationToken
    ): void {
        const ids = source.filter(n => n.type === 'query').map(n => (n as { query: { id: string } }).query.id);
        if (ids.length === 0) {
            return;
        }
        dataTransfer.set(SAVED_QUERY_DRAG_MIME, new vscode.DataTransferItem(JSON.stringify(ids)));
    }
}

/**
 * Inserts the SQL of queries dropped into a text editor at the drop position.
 * The statement is inserted as stored, so `:name` placeholders stay visible and
 * can be filled in by hand.
 */
export class SavedQueryDropProvider implements vscode.DocumentDropEditProvider {
    constructor(private readonly store: SavedQueryStore) {}

    async provideDocumentDropEdits(
        _document: vscode.TextDocument,
        _position: vscode.Position,
        dataTransfer: vscode.DataTransfer,
        _token: vscode.CancellationToken
    ): Promise<vscode.DocumentDropEdit | undefined> {
        const item = dataTransfer.get(SAVED_QUERY_DRAG_MIME);
        if (!item) {
            return undefined;
        }

        let ids: unknown;
        try {
            ids = JSON.parse(await item.asString());
        } catch {
            return undefined;
        }
        if (!Array.isArray(ids) || ids.length === 0) {
            return undefined;
        }

        const statements = ids
            .map(id => this.store.get(String(id)))
            .filter((q): q is NonNullable<typeof q> => Boolean(q))
            .map(q => q.sql.trim())
            .filter(sql => sql.length > 0);
        if (statements.length === 0) {
            return undefined;
        }

        return new vscode.DocumentDropEdit(statements.join('\n\n'));
    }
}
