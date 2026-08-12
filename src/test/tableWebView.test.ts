import './helpers/vscodeMock';
import { vscodeStub, fireDidSaveTextDocument, fireDidCloseTextDocument } from './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { buildCustomResultColumns, buildColumnProbeSql, buildCellEditorFileName, cellEditorFileExtension, TableWebViewManager } from '../tableWebView';
import { getIconSprite, getSharedStyles } from '../webviewAssets';

test('buildCustomResultColumns resolves type names and column comments', () => {
    const fields = [
        { name: 'id', dataTypeID: 23, tableID: 100, columnID: 1 },
        { name: 'name', dataTypeID: 25, tableID: 100, columnID: 2 }
    ];
    const typeMap = { 23: 'int4', 25: 'text' };
    const commentMap = { '100:1': 'Primary key', '100:2': 'Display name' };

    assert.deepEqual(buildCustomResultColumns(fields, typeMap, commentMap), [
        { name: 'id', dataType: 'int4', fullType: 'int4', isNullable: true, columnDefault: null, comment: 'Primary key' },
        { name: 'name', dataType: 'text', fullType: 'text', isNullable: true, columnDefault: null, comment: 'Display name' }
    ]);
});

test('buildCustomResultColumns reports the type including its modifier', () => {
    const fields = [
        { name: 'code', dataTypeID: 1043, dataTypeModifier: 9, tableID: 1, columnID: 1 },
        { name: 'amount', dataTypeID: 1700, dataTypeModifier: 655366, tableID: 1, columnID: 2 },
        { name: 'note', dataTypeID: 25, dataTypeModifier: -1, tableID: 1, columnID: 3 }
    ];
    const fullTypeMap = {
        '1043:9': 'character varying(5)',
        '1700:655366': 'numeric(10,2)',
        '25:-1': 'text'
    };
    const cols = buildCustomResultColumns(fields, { 1043: 'varchar', 1700: 'numeric', 25: 'text' }, {}, fullTypeMap);

    assert.deepEqual(cols.map(c => c.fullType), ['character varying(5)', 'numeric(10,2)', 'text']);
    assert.deepEqual(cols.map(c => c.dataType), ['varchar', 'numeric', 'text']);
});

test('buildCustomResultColumns falls back to the plain type name when no modifier is known', () => {
    const fields = [{ name: 'x', dataTypeID: 1043, dataTypeModifier: 9 }];
    const cols = buildCustomResultColumns(fields, { 1043: 'varchar' }, {}, {});
    assert.equal(cols[0].fullType, 'varchar');
});

test('buildCustomResultColumns leaves a table column without a comment as null', () => {
    const fields = [{ name: 'id', dataTypeID: 23, tableID: 100, columnID: 1 }];
    const cols = buildCustomResultColumns(fields, { 23: 'int4' }, {});
    assert.equal(cols[0].comment, null);
});

test('buildCustomResultColumns gives computed/expression columns no comment', () => {
    // A computed column (e.g. count(*) or a literal) has tableID/columnID 0.
    const fields = [
        { name: 'total', dataTypeID: 20, tableID: 0, columnID: 0 },
        { name: 'literal', dataTypeID: 25 }
    ];
    const commentMap = { '0:0': 'should never be used' };
    const cols = buildCustomResultColumns(fields, { 20: 'int8', 25: 'text' }, commentMap);

    assert.equal(cols[0].comment, null);
    assert.equal(cols[1].comment, null);
});

test('buildCustomResultColumns falls back to an empty data type for unknown OIDs', () => {
    const fields = [{ name: 'x', dataTypeID: 99999, tableID: 5, columnID: 3 }];
    const cols = buildCustomResultColumns(fields, {}, { '5:3': 'note' });
    assert.equal(cols[0].dataType, '');
    assert.equal(cols[0].comment, 'note');
});

test('buildCustomResultColumns keeps only the matching table/column comment', () => {
    const fields = [
        { name: 'a', dataTypeID: 23, tableID: 10, columnID: 1 },
        { name: 'b', dataTypeID: 23, tableID: 20, columnID: 1 }
    ];
    const commentMap = { '10:1': 'from table 10', '20:1': 'from table 20' };
    const cols = buildCustomResultColumns(fields, { 23: 'int4' }, commentMap);
    assert.equal(cols[0].comment, 'from table 10');
    assert.equal(cols[1].comment, 'from table 20');
});

// ===== buildColumnProbeSql =====

test('buildColumnProbeSql wraps a SELECT into a zero-row describe query', () => {
    assert.equal(
        buildColumnProbeSql('SELECT id, name FROM users'),
        'SELECT * FROM (SELECT id, name FROM users) AS _pqb_cols LIMIT 0'
    );
});

test('buildColumnProbeSql wraps a WITH (CTE) query', () => {
    assert.equal(
        buildColumnProbeSql('WITH x AS (SELECT 1 AS n) SELECT n FROM x'),
        'SELECT * FROM (WITH x AS (SELECT 1 AS n) SELECT n FROM x) AS _pqb_cols LIMIT 0'
    );
});

test('buildColumnProbeSql strips a trailing semicolon before wrapping', () => {
    assert.equal(
        buildColumnProbeSql('SELECT 1 ;  '),
        'SELECT * FROM (SELECT 1) AS _pqb_cols LIMIT 0'
    );
});

test('buildColumnProbeSql is case-insensitive to the leading keyword', () => {
    assert.equal(
        buildColumnProbeSql('select 1'),
        'SELECT * FROM (select 1) AS _pqb_cols LIMIT 0'
    );
});

test('buildColumnProbeSql returns null for non-SELECT statements', () => {
    assert.equal(buildColumnProbeSql('UPDATE t SET a = 1'), null);
    assert.equal(buildColumnProbeSql('INSERT INTO t VALUES (1)'), null);
    assert.equal(buildColumnProbeSql('DELETE FROM t'), null);
});

test('buildColumnProbeSql returns null for empty or non-string input', () => {
    assert.equal(buildColumnProbeSql(''), null);
    assert.equal(buildColumnProbeSql('   '), null);
    assert.equal(buildColumnProbeSql(';'), null);
    assert.equal(buildColumnProbeSql(undefined as any), null);
    assert.equal(buildColumnProbeSql(null as any), null);
});

test('buildColumnProbeSql does not treat "selection" as a SELECT keyword', () => {
    assert.equal(buildColumnProbeSql('selective_function()'), null);
});

// ===== Export in the read-only custom-query panel =====

/** Repo root, so the panel can read the real webview html/css/js assets. */
const EXTENSION_PATH = path.join(__dirname, '..', '..', '..');

function createFakePanel() {
    const posted: any[] = [];
    const state: { onMessage: (m: any) => any } = { onMessage: async () => {} };
    const panel = {
        posted,
        state,
        webview: {
            html: '',
            postMessage: (m: any) => { posted.push(m); return Promise.resolve(true); },
            onDidReceiveMessage: (cb: any) => { state.onMessage = cb; return { dispose() {} }; }
        },
        onDidDispose: (_cb: any) => ({ dispose() {} }),
        reveal() {}
    };
    return panel;
}

function createManager() {
    const globalStateStore: Record<string, any> = {};
    const executed: string[] = [];
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'pqb-storage-'));
    const context: any = {
        subscriptions: [],
        extensionPath: EXTENSION_PATH,
        globalStorageUri: { fsPath: storagePath, path: storagePath },
        globalState: {
            get: (key: string, def?: any) => (key in globalStateStore ? globalStateStore[key] : def),
            update: (key: string, value: any) => { globalStateStore[key] = value; return Promise.resolve(); }
        }
    };
    const connectionManager: any = {
        onConnectionChanged: () => ({ dispose() {} }),
        getActiveConnectionConfig: () => undefined,
        ensureConnected: async () => true,
        query: async () => ({ rows: [], fields: [] }),
        queryMetadata: async () => [],
        getPool: () => ({
            connect: async () => ({
                query: async (sql: string) => { executed.push(sql); return { rowCount: 1 }; },
                release() {}
            })
        })
    };
    const columnMappingManager: any = {
        onDidChange: () => ({ dispose() {} }),
        getMappingsForTable: () => []
    };
    const permanentConstraintManager: any = { getConstraints: () => [] };
    // Stand-in for SavedQueryStore: records what the panel asks it to persist.
    const savedQueryStore: any = {
        queries: [] as any[],
        added: [] as any[],
        updated: [] as any[],
        deleted: [] as string[],
        values: {} as Record<string, any>,
        touched: [] as string[],
        onDidChange: () => ({ dispose() {} }),
        getAll() { return this.queries; },
        get(id: string) { return this.queries.find((q: any) => q.id === id); },
        add(query: any, scope: string) {
            const created = { ...query, id: 'new-id', scope };
            this.queries.push(created);
            this.added.push({ query, scope });
            return Promise.resolve(created);
        },
        update(id: string, patch: any) { this.updated.push({ id, patch }); return Promise.resolve(true); },
        delete(id: string) { this.deleted.push(id); return Promise.resolve(true); },
        setParameterValues(id: string, values: any) { this.values[id] = values; return Promise.resolve(); },
        touch(id: string) { this.touched.push(id); return Promise.resolve(); },
        getParameterValues(id: string) { return this.values[id] || {}; }
    };
    const manager = new TableWebViewManager(
        context, connectionManager, columnMappingManager, permanentConstraintManager, undefined, savedQueryStore
    );
    return { manager, globalStateStore, executed, savedQueryStore, storagePath };
}

/** Open a query panel and return it together with its message callback. */
async function openCustomQueryPanel(savedQuery?: any) {
    const { manager, globalStateStore, executed, savedQueryStore, storagePath } = createManager();
    const panel = createFakePanel();
    const originalCreate = vscodeStub.window.createWebviewPanel;
    vscodeStub.window.createWebviewPanel = () => panel;
    try {
        await manager.openQueryView('SELECT 1 AS n', 'Custom', undefined, savedQuery);
    } finally {
        vscodeStub.window.createWebviewPanel = originalCreate;
    }
    return { panel, send: (m: any) => panel.state.onMessage(m), globalStateStore, executed, savedQueryStore, storagePath };
}

test('query panel: Browse opens the folder dialog and reports the choice', async () => {
    const { panel, send } = await openCustomQueryPanel();
    const originalOpen = vscodeStub.window.showOpenDialog;
    let dialogOptions: any;
    vscodeStub.window.showOpenDialog = (options?: any) => {
        dialogOptions = options;
        return Promise.resolve([{ fsPath: 'C:\\exports' }]);
    };
    try {
        await send({ command: 'browseExportLocation' });
    } finally {
        vscodeStub.window.showOpenDialog = originalOpen;
    }

    assert.equal(dialogOptions.canSelectFolders, true);
    assert.equal(dialogOptions.canSelectFiles, false);
    const msg = panel.posted.find(m => m.command === 'exportLocationSelected');
    assert.ok(msg, 'expected exportLocationSelected to be posted back to the webview');
    assert.equal(msg.path, 'C:\\exports');
});

test('query panel: cancelling the folder dialog posts nothing', async () => {
    const { panel, send } = await openCustomQueryPanel();
    const originalOpen = vscodeStub.window.showOpenDialog;
    vscodeStub.window.showOpenDialog = () => Promise.resolve(undefined);
    try {
        await send({ command: 'browseExportLocation' });
    } finally {
        vscodeStub.window.showOpenDialog = originalOpen;
    }
    assert.equal(panel.posted.some(m => m.command === 'exportLocationSelected'), false);
});

test('query panel: export defaults can be loaded and saved', async () => {
    const { panel, send, globalStateStore } = await openCustomQueryPanel();

    await send({ command: 'saveExportDefaults', format: 'csv', options: { csvSeparator: ';' }, saveLocation: 'C:\\exports' });
    assert.deepEqual(globalStateStore['exportDefaults'], { csv: { csvSeparator: ';' } });
    assert.equal(globalStateStore['exportSaveLocation'], 'C:\\exports');

    await send({ command: 'getExportDefaults' });
    const msg = panel.posted.find(m => m.command === 'exportDefaultsLoaded');
    assert.ok(msg, 'expected exportDefaultsLoaded to be posted back to the webview');
    assert.equal(msg.defaults.csv.csvSeparator, ';');
    assert.equal(msg.defaults._saveLocation, 'C:\\exports');
});

test('query panel: exporting opens the save dialog in the saved location', async () => {
    const { send } = await openCustomQueryPanel();
    const originalSave = vscodeStub.window.showSaveDialog;
    let saveOptions: any;
    vscodeStub.window.showSaveDialog = (options?: any) => {
        saveOptions = options;
        return Promise.resolve(undefined); // user cancels
    };
    try {
        await send({
            command: 'exportData',
            options: { format: 'csv', filename: 'result.csv', saveLocation: 'C:\\exports' },
            sql: 'SELECT 1 AS n',
            columns: [{ name: 'n', dataType: 'int4' }]
        });
    } finally {
        vscodeStub.window.showSaveDialog = originalSave;
    }

    assert.ok(saveOptions, 'expected the save dialog to be shown');
    assert.equal(saveOptions.defaultUri.fsPath, path.join('C:\\exports', 'result.csv'));
    assert.deepEqual(saveOptions.filters, { 'CSV Files': ['csv'] });
});

test('query panel: committing without targets reports an error instead of succeeding', async () => {
    const { panel, send } = await openCustomQueryPanel();
    await send({ command: 'commitChanges', targets: [] });
    assert.equal(panel.posted.some(m => m.command === 'commitSuccess'), false);
    assert.ok(panel.posted.some(m => m.command === 'error'), 'expected an error to be reported');
});

test('query panel: statements edited in the preview are executed verbatim', async () => {
    const { panel, send, executed } = await openCustomQueryPanel();

    await send({
        command: 'commitChanges',
        targets: [],
        sql: "UPDATE t SET a = 1 WHERE id = 7;\nDELETE FROM t WHERE id = 8;"
    });

    assert.deepEqual(executed, [
        'BEGIN',
        'UPDATE t SET a = 1 WHERE id = 7',
        'DELETE FROM t WHERE id = 8',
        'COMMIT'
    ]);
    assert.ok(panel.posted.some(m => m.command === 'commitSuccess'), 'expected commitSuccess');
});

test('query panel: a blank edited script falls back to the generated targets', async () => {
    const { panel, send, executed } = await openCustomQueryPanel();
    await send({ command: 'commitChanges', targets: [], sql: '   ' });
    assert.deepEqual(executed, []);
    assert.ok(panel.posted.some(m => m.command === 'error'), 'expected an error to be reported');
});

test('query panel: init carries the alwaysQuote setting and the query', async () => {
    const originalGetConfig = vscodeStub.workspace.getConfiguration;
    vscodeStub.workspace.getConfiguration = (_section?: string) => ({
        get<T>(key: string, defaultValue?: T): T {
            return (key === 'alwaysQuote' ? true : defaultValue) as T;
        }
    });
    let panel;
    try {
        ({ panel } = await openCustomQueryPanel());
    } finally {
        vscodeStub.workspace.getConfiguration = originalGetConfig;
    }

    const init = panel.posted.find(m => m.command === 'init');
    assert.ok(init, 'expected an init message');
    assert.equal(init.alwaysQuote, true);
    assert.equal(init.sql, 'SELECT 1 AS n');
    assert.equal(init.origin, 'query');
});

test('query panel: the injected script is not mangled by $ replacement patterns', async () => {
    const { panel } = await openCustomQueryPanel();
    const js = require('node:fs').readFileSync(
        path.join(EXTENSION_PATH, 'src', 'webview', 'tableView.js'), 'utf8'
    );
    assert.ok(panel.webview.html.includes(js), 'expected the script to be injected verbatim');
    assert.ok(panel.webview.html.trimEnd().endsWith('</html>'), 'expected intact HTML after the script');
});

test('data viewer: the shared design tokens and the icon sprite are injected', async () => {
    const { panel } = await openCustomQueryPanel();
    const html = panel.webview.html;
    assert.ok(html.includes(getSharedStyles()), 'expected the shared stylesheet');
    assert.ok(html.includes(getIconSprite()), 'expected the icon sprite');
    const css = require('node:fs').readFileSync(
        path.join(EXTENSION_PATH, 'src', 'webview', 'tableView.css'), 'utf8'
    );
    assert.ok(html.indexOf(getSharedStyles()) < html.indexOf(css), 'shared styles must come first');
});

test('data viewer: no placeholder survives in the rendered document', async () => {
    const { panel } = await openCustomQueryPanel();
    for (const placeholder of [
        '/* SHARED_CSS_PLACEHOLDER */',
        '/* CSS_PLACEHOLDER */',
        '/* JS_PLACEHOLDER */',
        '<!-- ICON_SPRITE_PLACEHOLDER -->'
    ]) {
        assert.equal(panel.webview.html.includes(placeholder), false, `${placeholder} was not replaced`);
    }
});

// ===== Saved queries =====

test('query panel: init without a saved query asks for no parameters', async () => {
    const { panel } = await openCustomQueryPanel();
    const init = panel.posted.find(m => m.command === 'init');
    assert.equal(init.awaitParameters, false);
    assert.equal(init.savedQueryId, '');
    assert.deepEqual(init.savedQueryParameters, []);
});

test('query panel: init of a parameterized saved query waits for values', async () => {
    const { panel } = await openCustomQueryPanel({
        id: 'q1',
        parameters: [{ name: 'from', kind: 'text' }],
        values: { from: '2024-01-01' }
    });
    const init = panel.posted.find(m => m.command === 'init');
    assert.equal(init.awaitParameters, true);
    assert.equal(init.savedQueryId, 'q1');
    assert.deepEqual(init.savedQueryParameters, [{ name: 'from', kind: 'text' }]);
    assert.deepEqual(init.savedQueryValues, { from: '2024-01-01' });
});

test('query panel: a saved query without placeholders runs immediately', async () => {
    const { panel } = await openCustomQueryPanel({ id: 'q1', parameters: [], values: {} });
    const init = panel.posted.find(m => m.command === 'init');
    assert.equal(init.awaitParameters, false);
    assert.equal(init.savedQueryId, 'q1');
});

test('query panel: getSavedQueries posts the stored queries back', async () => {
    const { panel, send, savedQueryStore } = await openCustomQueryPanel();
    savedQueryStore.queries.push({ id: 'a', name: 'A', sql: 'SELECT 1', parameters: [] });
    await send({ command: 'getSavedQueries' });
    const msg = panel.posted.filter(m => m.command === 'savedQueriesLoaded').pop();
    assert.ok(msg, 'expected savedQueriesLoaded');
    assert.equal(msg.queries.length, 1);
});

test('query panel: saving a new query stores it and reports its id', async () => {
    const { panel, send, savedQueryStore } = await openCustomQueryPanel();
    await send({
        command: 'saveSavedQuery',
        id: '',
        name: '  Orders  ',
        sql: 'SELECT * FROM o WHERE d = :day ',
        scope: 'workspace',
        parameters: [{ name: 'day', kind: 'text' }]
    });
    assert.equal(savedQueryStore.added.length, 1);
    assert.equal(savedQueryStore.added[0].scope, 'workspace');
    assert.equal(savedQueryStore.added[0].query.name, 'Orders');
    assert.equal(savedQueryStore.added[0].query.sql, 'SELECT * FROM o WHERE d = :day');
    const msg = panel.posted.find(m => m.command === 'savedQuerySaved');
    assert.ok(msg, 'expected savedQuerySaved');
    assert.equal(msg.id, 'new-id');
});

test('query panel: saving reconciles the parameters with the SQL', async () => {
    const { send, savedQueryStore } = await openCustomQueryPanel();
    await send({
        command: 'saveSavedQuery',
        name: 'Q',
        sql: 'SELECT * FROM t WHERE a = :a',
        parameters: [{ name: 'gone', kind: 'number' }]
    });
    assert.deepEqual(savedQueryStore.added[0].query.parameters, [{ name: 'a', kind: 'text' }]);
});

test('query panel: saving over an existing query updates it', async () => {
    const { send, savedQueryStore } = await openCustomQueryPanel();
    savedQueryStore.queries.push({ id: 'a', name: 'A', sql: 'SELECT 1', parameters: [] });
    await send({ command: 'saveSavedQuery', id: 'a', name: 'A2', sql: 'SELECT 2' });
    assert.equal(savedQueryStore.added.length, 0);
    assert.equal(savedQueryStore.updated[0].id, 'a');
    assert.equal(savedQueryStore.updated[0].patch.name, 'A2');
});

test('query panel: saving without a name is rejected', async () => {
    const { send, savedQueryStore } = await openCustomQueryPanel();
    await send({ command: 'saveSavedQuery', name: '  ', sql: 'SELECT 1' });
    assert.equal(savedQueryStore.added.length, 0);
    assert.equal(savedQueryStore.updated.length, 0);
});

test('query panel: deleting a saved query is forwarded to the store', async () => {
    const { send, savedQueryStore } = await openCustomQueryPanel();
    await send({ command: 'deleteSavedQuery', id: 'a' });
    assert.deepEqual(savedQueryStore.deleted, ['a']);
});

test('query panel: parameter values are cached and mark the query as used', async () => {
    const { send, savedQueryStore } = await openCustomQueryPanel();
    await send({ command: 'saveSavedQueryValues', id: 'a', values: { from: '1' } });
    assert.deepEqual(savedQueryStore.values['a'], { from: '1' });
    assert.deepEqual(savedQueryStore.touched, ['a']);
});

// ===== A cell value opened in an editor tab =====

test('cellEditorFileExtension picks the language of the column type', () => {
    assert.equal(cellEditorFileExtension('json'), 'json');
    assert.equal(cellEditorFileExtension('jsonb'), 'json');
    assert.equal(cellEditorFileExtension('xml'), 'xml');
    assert.equal(cellEditorFileExtension('text'), 'txt');
    assert.equal(cellEditorFileExtension(''), 'txt');
    assert.equal(cellEditorFileExtension(undefined as any), 'txt');
});

test('buildCellEditorFileName names the file after table and column', () => {
    assert.equal(buildCellEditorFileName('orders', 'note', 'text'), 'orders.note.txt');
    assert.equal(buildCellEditorFileName('orders', 'payload', 'jsonb'), 'orders.payload.json');
});

test('buildCellEditorFileName cannot be steered out of its folder', () => {
    const name = buildCellEditorFileName('..', '../../etc/passwd', 'text');
    assert.equal(name.includes('/'), false);
    assert.equal(name.includes('\\'), false);
    assert.equal(name.includes('..'), false);
    assert.equal(name, 'result.etc_passwd.txt');
});

test('buildCellEditorFileName falls back when table or column has no usable name', () => {
    assert.equal(buildCellEditorFileName('', '', 'text'), 'result.value.txt');
});

/** Open a cell in an editor tab and return the document the stub handed out. */
async function openCellEditor(message: any = {}) {
    const session = await openCustomQueryPanel();
    const opened: any[] = [];
    const originalOpen = vscodeStub.workspace.openTextDocument;
    vscodeStub.workspace.openTextDocument = (uri: any) => {
        const doc = { uri, getText: () => fs.readFileSync(uri.fsPath, 'utf8') };
        opened.push(doc);
        return Promise.resolve(doc);
    };
    try {
        await session.send({
            command: 'openCellInEditor',
            rowIdx: 2,
            column: 'note',
            dataType: 'text',
            value: 'line 1\nline 2',
            ...message
        });
    } finally {
        vscodeStub.workspace.openTextDocument = originalOpen;
    }
    return { ...session, doc: opened[0] };
}

test('query panel: opening a cell writes its value to a file and shows it', async () => {
    const { doc, storagePath } = await openCellEditor();
    assert.ok(doc, 'expected a document to be opened');
    assert.equal(fs.readFileSync(doc.uri.fsPath, 'utf8'), 'line 1\nline 2');
    assert.equal(path.basename(doc.uri.fsPath), 'result.note.txt');
    assert.ok(doc.uri.fsPath.startsWith(storagePath), 'the scratch file must live in the extension storage');
});

test('query panel: saving the opened file writes the value back into the cell', async () => {
    const { panel, doc } = await openCellEditor();
    fs.writeFileSync(doc.uri.fsPath, 'edited in the editor', 'utf8');
    fireDidSaveTextDocument(doc);

    const msg = panel.posted.filter((m: any) => m.command === 'cellEditorValue').pop();
    assert.ok(msg, 'expected cellEditorValue to be posted back');
    assert.equal(msg.rowIdx, 2);
    assert.equal(msg.column, 'note');
    assert.equal(msg.value, 'edited in the editor');
});

test('query panel: a read-only cell is opened but never written back', async () => {
    const { panel, doc } = await openCellEditor({ readOnly: true });
    fs.writeFileSync(doc.uri.fsPath, 'edited anyway', 'utf8');
    fireDidSaveTextDocument(doc);
    assert.equal(panel.posted.some((m: any) => m.command === 'cellEditorValue'), false);
});

test('query panel: closing the tab removes the file and stops the write-back', async () => {
    const { panel, doc } = await openCellEditor();
    fireDidCloseTextDocument(doc);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fs.existsSync(doc.uri.fsPath), false, 'the scratch file must be gone');

    fireDidSaveTextDocument({ uri: doc.uri, getText: () => 'late' });
    assert.equal(panel.posted.some((m: any) => m.command === 'cellEditorValue'), false);
});

test('query panel: saving a file that belongs to no cell posts nothing', async () => {
    const { panel } = await openCellEditor();
    fireDidSaveTextDocument({ uri: { fsPath: path.join(os.tmpdir(), 'unrelated.txt') }, getText: () => 'x' });
    assert.equal(panel.posted.some((m: any) => m.command === 'cellEditorValue'), false);
});
