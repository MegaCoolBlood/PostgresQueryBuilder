import * as vscode from 'vscode';
import { SavedQueryStore, mergeParameters, placeholderNames } from './savedQueryStore';

/** Derive a readable, filesystem-safe `.sql` file name from a query name. */
export function savedQueryFileName(name: string): string {
    const safe = String(name || '')
        .trim()
        .replace(/[^A-Za-z0-9 ._-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/^[.\-]+/, '')
        .slice(0, 60);
    return (safe || 'query') + '.sql';
}

function pathKey(uri: vscode.Uri): string {
    return (uri.fsPath || '').toLowerCase();
}

/**
 * Edits the SQL of a saved query in a normal editor tab instead of an input
 * box, so syntax highlighting, formatting and multi-line editing all work.
 * The file lives in the extension's storage; saving it writes back to the store.
 */
export class SavedQueryEditor {
    /** File path (lower-cased) -> id of the saved query it belongs to. */
    private readonly openFiles = new Map<string, string>();

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly store: SavedQueryStore
    ) {
        context.subscriptions.push(
            vscode.workspace.onDidSaveTextDocument(doc => this.handleSave(doc))
        );
    }

    async open(queryId: string): Promise<void> {
        const query = this.store.get(queryId);
        if (!query) {
            return;
        }
        const dir = vscode.Uri.joinPath(this.context.globalStorageUri, 'savedQueries', query.id);
        await vscode.workspace.fs.createDirectory(dir);
        const file = vscode.Uri.joinPath(dir, savedQueryFileName(query.name));

        // Never overwrite a tab that is already open: it may hold unsaved edits.
        const alreadyOpen = vscode.workspace.textDocuments.some(d => pathKey(d.uri) === pathKey(file));
        if (!alreadyOpen) {
            await vscode.workspace.fs.writeFile(file, Buffer.from(query.sql, 'utf8'));
        }
        this.openFiles.set(pathKey(file), query.id);

        const doc = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(doc);
        vscode.window.setStatusBarMessage(
            `Editing "${query.name}" — save to update the query. Placeholders are written as :name.`,
            8000
        );
    }

    private async handleSave(doc: vscode.TextDocument): Promise<void> {
        const id = this.openFiles.get(pathKey(doc.uri));
        if (!id) {
            return;
        }
        const query = this.store.get(id);
        if (!query) {
            this.openFiles.delete(pathKey(doc.uri));
            vscode.window.showWarningMessage('This saved query no longer exists; the file was not applied.');
            return;
        }
        const sql = doc.getText().trim();
        if (!sql) {
            vscode.window.showWarningMessage(`"${query.name}" was not updated: the statement is empty.`);
            return;
        }
        await this.store.update(id, { sql, parameters: mergeParameters(sql, query.parameters) });
        const names = placeholderNames(sql);
        vscode.window.setStatusBarMessage(
            names.length
                ? `Updated "${query.name}" (${names.map(n => ':' + n).join(', ')})`
                : `Updated "${query.name}"`,
            5000
        );
    }
}
