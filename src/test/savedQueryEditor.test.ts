import './helpers/vscodeMock';
import { vscodeStub } from './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SavedQueryEditor, savedQueryFileName, defaultSavedQueryName } from '../savedQueryEditor';
import { ManageBookmarksPanel } from '../manageBookmarksPanel';
import { SavedQuery, SavedQueryStore } from '../savedQueryStore';

function makeQuery(over: Partial<SavedQuery> = {}): SavedQuery {
    return {
        id: over.id || 'q1',
        name: over.name || 'Orders',
        sql: over.sql || 'SELECT * FROM o',
        parameters: over.parameters || []
    };
}

/**
 * Build an editor with a stubbed store and file system, and hand back the
 * captured save listener so a save can be simulated.
 */
function createEditor(queries: SavedQuery[]) {
    const written: Array<{ path: string; content: string }> = [];
    const updated: Array<{ id: string; patch: any }> = [];
    const added: Array<{ query: any; scope: string }> = [];
    const dialogs: any[] = [];
    const shown: string[] = [];
    const warnings: string[] = [];
    const infos: string[] = [];
    let saveListener: ((doc: any) => any) | undefined;

    const store = {
        get: (id: string) => queries.find(q => q.id === id),
        update: (id: string, patch: any) => { updated.push({ id, patch }); return Promise.resolve(true); },
        add: (query: any, scope: string) => { added.push({ query, scope }); return Promise.resolve({ ...query, id: 'new' }); }
    } as unknown as SavedQueryStore;

    const context: any = {
        subscriptions: [],
        globalStorageUri: { fsPath: 'C:/storage', path: 'C:/storage' }
    };

    const originals = {
        onDidSave: vscodeStub.workspace.onDidSaveTextDocument,
        writeFile: vscodeStub.workspace.fs.writeFile,
        openTextDocument: vscodeStub.workspace.openTextDocument,
        showTextDocument: vscodeStub.window.showTextDocument,
        showWarning: vscodeStub.window.showWarningMessage,
        showInfo: vscodeStub.window.showInformationMessage,
        showInputBox: vscodeStub.window.showInputBox,
        showQuickPick: vscodeStub.window.showQuickPick,
        textDocuments: vscodeStub.workspace.textDocuments,
        workspaceFolders: vscodeStub.workspace.workspaceFolders,
        showDialog: ManageBookmarksPanel.show
    };
    // The dialog itself is covered by its own suite; here only the handover matters.
    ManageBookmarksPanel.show = (_store: any, request?: any) => { dialogs.push(request); };
    vscodeStub.workspace.onDidSaveTextDocument = (listener: any) => {
        saveListener = listener;
        return { dispose() {} };
    };
    (vscodeStub.workspace.fs as any).writeFile = async (uri: any, content: Uint8Array) => {
        written.push({ path: uri.fsPath, content: Buffer.from(content).toString('utf8') });
    };
    vscodeStub.workspace.openTextDocument = (uri: any) => Promise.resolve({ uri, getText: () => '' });
    vscodeStub.window.showTextDocument = (doc: any) => { shown.push(doc.uri.fsPath); return Promise.resolve(undefined); };
    vscodeStub.window.showWarningMessage = (msg: any) => { warnings.push(String(msg)); return Promise.resolve(undefined); };
    vscodeStub.window.showInformationMessage = (msg: any) => { infos.push(String(msg)); return Promise.resolve(undefined); };

    return {
        editor: new SavedQueryEditor(context, store),
        written,
        updated,
        added,
        dialogs,
        shown,
        warnings,
        infos,
        save: (path: string, text: string) => saveListener!({ uri: { fsPath: path }, getText: () => text }),
        setOpenDocuments: (paths: string[]) => {
            vscodeStub.workspace.textDocuments = paths.map(p => ({ uri: { fsPath: p } }));
        },
        restore: () => {
            vscodeStub.workspace.onDidSaveTextDocument = originals.onDidSave;
            (vscodeStub.workspace.fs as any).writeFile = originals.writeFile;
            vscodeStub.workspace.openTextDocument = originals.openTextDocument;
            vscodeStub.window.showTextDocument = originals.showTextDocument;
            vscodeStub.window.showWarningMessage = originals.showWarning;
            vscodeStub.window.showInformationMessage = originals.showInfo;
            vscodeStub.window.showInputBox = originals.showInputBox;
            vscodeStub.window.showQuickPick = originals.showQuickPick;
            vscodeStub.workspace.textDocuments = originals.textDocuments;
            vscodeStub.workspace.workspaceFolders = originals.workspaceFolders;
            ManageBookmarksPanel.show = originals.showDialog;
        }
    };
}

/** A minimal stand-in for `vscode.TextEditor` where offsets are used as positions. */
function fakeEditor(text: string, cursor: number, selection?: { start: number; end: number }) {
    return {
        document: {
            fileName: 'C:/repo/reports/orders.sql',
            getText: () => text,
            offsetAt: (p: number) => p
        },
        selection: {
            isEmpty: !selection,
            active: cursor,
            start: selection ? selection.start : cursor,
            end: selection ? selection.end : cursor
        }
    } as any;
}

// ===== savedQueryFileName =====

test('savedQueryFileName turns a name into a readable sql file name', () => {
    assert.equal(savedQueryFileName('Orders per day'), 'Orders-per-day.sql');
});

test('savedQueryFileName strips characters a path cannot contain', () => {
    assert.equal(savedQueryFileName('a/b\\c:d*?"<>|e'), 'abcde.sql');
});

test('savedQueryFileName falls back for a name without usable characters', () => {
    assert.equal(savedQueryFileName('///'), 'query.sql');
    assert.equal(savedQueryFileName(''), 'query.sql');
});

test('savedQueryFileName caps the length', () => {
    assert.equal(savedQueryFileName('x'.repeat(200)), 'x'.repeat(60) + '.sql');
});

// ===== open =====

test('open writes the SQL to a file and shows it', async () => {
    const ctx = createEditor([makeQuery({ sql: 'SELECT 1' })]);
    try {
        await ctx.editor.open('q1');
    } finally {
        ctx.restore();
    }
    assert.equal(ctx.written.length, 1);
    assert.equal(ctx.written[0].content, 'SELECT 1');
    assert.ok(ctx.written[0].path.endsWith('savedQueries/q1/Orders.sql'), ctx.written[0].path);
    assert.deepEqual(ctx.shown, [ctx.written[0].path]);
});

test('open does not overwrite a file that is already open', async () => {
    const ctx = createEditor([makeQuery()]);
    try {
        ctx.setOpenDocuments(['C:/storage/savedQueries/q1/Orders.sql']);
        await ctx.editor.open('q1');
    } finally {
        ctx.restore();
    }
    assert.equal(ctx.written.length, 0, 'unsaved edits must not be clobbered');
    assert.equal(ctx.shown.length, 1);
});

test('open ignores an unknown query', async () => {
    const ctx = createEditor([]);
    try {
        await ctx.editor.open('missing');
    } finally {
        ctx.restore();
    }
    assert.equal(ctx.written.length, 0);
    assert.equal(ctx.shown.length, 0);
});

// ===== saving =====

test('saving the file writes the SQL back and re-detects placeholders', async () => {
    const ctx = createEditor([makeQuery({ parameters: [{ name: 'day', kind: 'number' }] })]);
    try {
        await ctx.editor.open('q1');
        await ctx.save(ctx.written[0].path, '  SELECT * FROM o WHERE d = :day AND s = :state  ');
    } finally {
        ctx.restore();
    }
    assert.equal(ctx.updated.length, 1);
    assert.equal(ctx.updated[0].id, 'q1');
    assert.equal(ctx.updated[0].patch.sql, 'SELECT * FROM o WHERE d = :day AND s = :state');
    assert.deepEqual(ctx.updated[0].patch.parameters, [
        { name: 'day', kind: 'number' },
        { name: 'state', kind: 'text' }
    ]);
});

test('saving an unrelated file changes nothing', async () => {
    const ctx = createEditor([makeQuery()]);
    try {
        await ctx.editor.open('q1');
        await ctx.save('C:/somewhere/else.sql', 'SELECT 2');
    } finally {
        ctx.restore();
    }
    assert.equal(ctx.updated.length, 0);
});

test('saving an emptied file is refused', async () => {
    const ctx = createEditor([makeQuery()]);
    try {
        await ctx.editor.open('q1');
        await ctx.save(ctx.written[0].path, '   \n  ');
    } finally {
        ctx.restore();
    }
    assert.equal(ctx.updated.length, 0);
    assert.equal(ctx.warnings.length, 1);
});

test('saving after the query was deleted warns instead of writing', async () => {
    const queries = [makeQuery()];
    const ctx = createEditor(queries);
    try {
        await ctx.editor.open('q1');
        queries.length = 0;
        await ctx.save(ctx.written[0].path, 'SELECT 3');
    } finally {
        ctx.restore();
    }
    assert.equal(ctx.updated.length, 0);
    assert.equal(ctx.warnings.length, 1);
});

// ===== defaultSavedQueryName =====

test('defaultSavedQueryName proposes the first table of the statement', () => {
    assert.equal(defaultSavedQueryName('SELECT * FROM public.orders o', 'C:/repo/x.sql'), 'orders');
});

test('defaultSavedQueryName falls back to the file name without extension', () => {
    assert.equal(defaultSavedQueryName('SELECT 1', 'C:/repo/reports/daily.sql'), 'daily');
    assert.equal(defaultSavedQueryName('SELECT 1', 'daily.sql'), 'daily');
});

test('defaultSavedQueryName falls back once more for an unnamed document', () => {
    assert.equal(defaultSavedQueryName('SELECT 1', ''), 'Query');
});

// ===== saveFromEditor =====

test('saveFromEditor hands the statement at the cursor to the bookmark dialog', async () => {
    const ctx = createEditor([]);
    try {
        await ctx.editor.saveFromEditor(fakeEditor('SELECT * FROM orders;\n', 10));
    } finally {
        ctx.restore();
    }
    assert.equal(ctx.dialogs.length, 1);
    assert.match(ctx.dialogs[0].draft.sql, /^SELECT \* FROM orders/);
    assert.equal(ctx.added.length, 0, 'the dialog stores the query, not the editor');
});

test('saveFromEditor hands an explicit selection over verbatim', async () => {
    const text = 'SELECT a FROM t1;\nSELECT b FROM t2;';
    const ctx = createEditor([]);
    try {
        await ctx.editor.saveFromEditor(fakeEditor(text, 20, { start: 18, end: 35 }));
    } finally {
        ctx.restore();
    }
    assert.equal(ctx.dialogs[0].draft.sql, 'SELECT b FROM t2');
});

test('saveFromEditor proposes the first table as the name', async () => {
    const ctx = createEditor([]);
    try {
        await ctx.editor.saveFromEditor(fakeEditor('SELECT * FROM shop.orders', 5));
    } finally {
        ctx.restore();
    }
    assert.equal(ctx.dialogs[0].draft.name, 'orders');
});

test('saveFromEditor warns without an editor', async () => {
    const ctx = createEditor([]);
    try {
        await ctx.editor.saveFromEditor(undefined);
    } finally {
        ctx.restore();
    }
    assert.equal(ctx.dialogs.length, 0);
    assert.equal(ctx.warnings.length, 1);
});

test('saveFromEditor warns when there is no statement at the cursor', async () => {
    const ctx = createEditor([]);
    try {
        await ctx.editor.saveFromEditor(fakeEditor('   \n\n', 1));
    } finally {
        ctx.restore();
    }
    assert.equal(ctx.dialogs.length, 0);
    assert.equal(ctx.warnings.length, 1);
});
