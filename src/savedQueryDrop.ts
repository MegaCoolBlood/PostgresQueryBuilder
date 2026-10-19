import * as vscode from 'vscode';
import { SavedQueryStore } from './savedQueryStore';
import { SavedQueryTreeNode } from './savedQueryExplorer';

/**
 * Custom MIME type used to transfer saved queries from the tree view into a
 * text editor. Advertised by the drag controller and read back by the document
 * drop edit provider.
 */
export const SAVED_QUERY_DRAG_MIME = 'application/vnd.postgresquerybuilder.savedquery';

/**
 * What dropping bookmarked queries onto a tree node does: onto a tag folder (or
 * a query inside one) the folder's tag is added; onto "Untagged" (or a query in
 * it) all tags are removed; anywhere else nothing happens.
 */
export function planTagDrop(target: SavedQueryTreeNode | undefined): { action: 'add'; tag: string } | { action: 'clear' } | undefined {
    if (!target) return undefined;
    if (target.type === 'tag') return { action: 'add', tag: target.path };
    if (target.type === 'untagged') return { action: 'clear' };
    if (target.parent === undefined) return undefined;
    return target.parent ? { action: 'add', tag: target.parent } : { action: 'clear' };
}

/** Parse the ids a drag carried, ignoring anything malformed. */
export function parseDraggedIds(text: string): string[] {
    try {
        const ids: unknown = JSON.parse(text);
        return Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
    } catch {
        return [];
    }
}

/**
 * Drag controller for the "Bookmarked Queries" tree view: a query dragged into
 * an editor inserts its SQL, a query dropped onto a tag folder gets that tag.
 */
export class SavedQueryDragController implements vscode.TreeDragAndDropController<SavedQueryTreeNode> {
    readonly dropMimeTypes: string[] = [SAVED_QUERY_DRAG_MIME];
    readonly dragMimeTypes: string[] = [SAVED_QUERY_DRAG_MIME];

    constructor(private readonly store?: SavedQueryStore) {}

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

    async handleDrop(
        target: SavedQueryTreeNode | undefined,
        dataTransfer: vscode.DataTransfer,
        _token: vscode.CancellationToken
    ): Promise<void> {
        const plan = planTagDrop(target);
        const item = dataTransfer.get(SAVED_QUERY_DRAG_MIME);
        if (!plan || !item || !this.store) {
            return;
        }
        const ids = parseDraggedIds(await item.asString());
        if (ids.length === 0) {
            return;
        }
        if (plan.action === 'add') {
            await this.store.addTag(ids, plan.tag);
            return;
        }
        const tagged = ids.filter(id => (this.store?.get(id)?.tags ?? []).length > 0);
        if (tagged.length === 0) {
            return;
        }
        const answer = await vscode.window.showWarningMessage(
            tagged.length === 1
                ? `Remove all tags from "${this.store.get(tagged[0])?.name}"?`
                : `Remove all tags from ${tagged.length} bookmarked queries?`,
            { modal: true },
            'Remove Tags'
        );
        if (answer === 'Remove Tags') {
            await this.store.removeTag(tagged);
        }
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
