import * as vscode from 'vscode';
import { SavedQueryStore, SavedQueryScope, mergeParameters, placeholderNames } from './savedQueryStore';
import { extractSelect, extractTableNames } from './selectStatementExtractor';

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

/** Name proposed when saving a statement from a file: its first table, else the file name. */
export function defaultSavedQueryName(sql: string, fileName: string): string {
    const table = extractTableNames(sql)[0];
    if (table) {
        return table;
    }
    const base = String(fileName || '').split(/[\\/]/).pop() || '';
    return base.replace(/\.[^.]+$/, '') || 'Query';
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

    /**
     * Store the statement the user is looking at in a file: the selection if
     * there is one, otherwise the statement around the cursor.
     */
    async saveFromEditor(editor: vscode.TextEditor | undefined): Promise<void> {
        if (!editor) {
            vscode.window.showWarningMessage('Open a SQL file and place the cursor inside the statement you want to bookmark.');
            return;
        }
        const doc = editor.document;
        const selection = editor.selection.isEmpty
            ? undefined
            : { start: doc.offsetAt(editor.selection.start), end: doc.offsetAt(editor.selection.end) };
        const sql = extractSelect(doc.getText(), doc.offsetAt(editor.selection.active), selection)?.sql?.trim();
        if (!sql) {
            vscode.window.showWarningMessage('No SELECT statement found at the cursor. Select the statement you want to bookmark.');
            return;
        }

        const name = await vscode.window.showInputBox({
            prompt: 'Name of the bookmarked query',
            value: defaultSavedQueryName(sql, doc.fileName),
            validateInput: v => v.trim() ? undefined : 'The name must not be empty.'
        });
        if (name === undefined) {
            return;
        }
        const scope = await this.pickScope();
        if (!scope) {
            return;
        }

        const parameters = mergeParameters(sql, []);
        await this.store.add({ name: name.trim(), sql, parameters }, scope);
        const names = placeholderNames(sql);
        vscode.window.showInformationMessage(
            names.length
                ? `Bookmarked "${name.trim()}" with the placeholders ${names.map(n => ':' + n).join(', ')}.`
                : `Bookmarked "${name.trim()}". Write :name in the statement to turn a value into a placeholder.`
        );
    }

    /** Ask where to store a new query; skipped when there is no workspace to share it with. */
    private async pickScope(): Promise<SavedQueryScope | undefined> {
        if (!vscode.workspace.workspaceFolders?.length) {
            return 'global';
        }
        const picked = await vscode.window.showQuickPick(
            [
                { label: 'Personal', description: 'Only for me', scope: 'global' as const },
                { label: 'Workspace', description: 'Shared via the workspace file', scope: 'workspace' as const }
            ],
            { placeHolder: 'Where should the query be stored?' }
        );
        return picked?.scope;
    }

    private async handleSave(doc: vscode.TextDocument): Promise<void> {
        const id = this.openFiles.get(pathKey(doc.uri));
        if (!id) {
            return;
        }
        const query = this.store.get(id);
        if (!query) {
            this.openFiles.delete(pathKey(doc.uri));
            vscode.window.showWarningMessage('This bookmarked query no longer exists; the file was not applied.');
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
