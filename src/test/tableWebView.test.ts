import './helpers/vscodeMock';
import { vscodeStub, fireDidSaveTextDocument, fireDidCloseTextDocument, stubWarningMessage } from './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import { DbSessionManager } from '../dbSession';
import { buildCustomResultColumns, buildColumnProbeSql, buildCellEditorFileName, cellEditorFileExtension, TableWebViewManager, queryEditorAssets, formatQueryBarText, buildDataViewerCsp, applyDataViewerCsp } from '../tableWebView';
import { QueryRunner } from '../queryRunner';
import { QualifierStore } from '../tableStatementDrop';
import { ManageBookmarksPanel } from '../manageBookmarksPanel';
import { getIconSprite, getSharedStyles } from '../webviewAssets';
import { formatSqlChecked } from '../plpgsqlFormatter';
import { getFormatOptions } from '../formatSettings';

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
    const state: { onMessage: (m: any) => any; onViewState: () => any; onDispose: Array<() => void> } = { onMessage: async () => {}, onViewState: () => {}, onDispose: [] };
    const panel = {
        posted,
        state,
        visible: true,
        webview: {
            html: '',
            postMessage: (m: any) => { posted.push(m); return Promise.resolve(true); },
            onDidReceiveMessage: (cb: any) => { state.onMessage = cb; return { dispose() {} }; }
        },
        onDidDispose: (cb: () => void) => { state.onDispose.push(cb); return { dispose() {} }; },
        onDidChangeViewState: (cb: any) => { state.onViewState = cb; return { dispose() {} }; },
        reveal() {},
        disposed: 0,
        dispose() {
            this.disposed++;
            for (const cb of [...state.onDispose]) cb();
        }
    };
    return panel;
}

function createManager(overrides: { connection?: any; mappings?: any[]; dbSessions?: DbSessionManager } = {}) {
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
        isConnected: () => true,
        ensureConnected: async () => true,
        query: async () => ({ rows: [], fields: [] }),
        queryMetadata: async () => [],
        getPool: () => ({
            connect: async () => ({
                query: async (sql: string) => { executed.push(sql); return { rowCount: 1 }; },
                release() {}
            })
        }),
        ...(overrides.connection || {})
    };
    // Rows reach the grid through the positional path, so derive it from the
    // name-keyed stub each test defines.
    if (!connectionManager.queryPositional) {
        connectionManager.queryPositional = async (sql: string, params?: any[]) => {
            const result = await connectionManager.query(sql, params);
            const fields = result.fields || [];
            return {
                ...result,
                rows: (result.rows || []).map((row: any) => fields.map((f: any) => row[f.name]))
            };
        };
    }
    const columnMappingManager: any = {
        onDidChange: () => ({ dispose() {} }),
        getMappingsForTable: (schema: string, table: string) =>
            (overrides.mappings || []).filter((m: any) => m.sourceSchema === schema && m.sourceTable === table),
        deletedMappings: [] as string[],
        deleteMapping(id: string) { this.deletedMappings.push(id); return Promise.resolve(); }
    };
    const permanentConstraintManager: any = { getConstraints: () => [], getSorts: () => [] };
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
        context, connectionManager, columnMappingManager, permanentConstraintManager, undefined, savedQueryStore, overrides.dbSessions
    );
    return { manager, globalStateStore, executed, savedQueryStore, storagePath, columnMappingManager };
}

/** Open a query panel and return it together with its message callback. */
async function openCustomQueryPanel(savedQuery?: any, overrides: { connection?: any; mappings?: any[] } = {}) {
    const { manager, globalStateStore, executed, savedQueryStore, storagePath, columnMappingManager } = createManager(overrides);
    const panel = createFakePanel();
    const originalCreate = vscodeStub.window.createWebviewPanel;
    vscodeStub.window.createWebviewPanel = () => panel;
    try {
        await manager.openQueryView('SELECT 1 AS n', 'Custom', undefined, savedQuery);
    } finally {
        vscodeStub.window.createWebviewPanel = originalCreate;
    }
    return { panel, send: (m: any) => panel.state.onMessage(m), globalStateStore, executed, savedQueryStore, storagePath, columnMappingManager };
}

/** Record the dialog requests instead of opening the Bookmarked Queries panel. */
function captureBookmarkDialog() {
    const list: any[] = [];
    const original = ManageBookmarksPanel.show;
    ManageBookmarksPanel.show = (_store: any, request?: any) => { if (request) list.push(request); };
    return { list, restore: () => { ManageBookmarksPanel.show = original; } };
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

/** Open a table view and return its init message. */
async function openTablePanelInit(schema: string, table: string, seed?: (globalStateStore: Record<string, any>) => void) {
    const { manager, globalStateStore } = createManager();
    if (seed) { seed(globalStateStore); }
    const panel = createFakePanel();
    const originalCreate = vscodeStub.window.createWebviewPanel;
    vscodeStub.window.createWebviewPanel = () => panel;
    try {
        await manager.openTableView(schema, table);
    } finally {
        vscodeStub.window.createWebviewPanel = originalCreate;
    }
    return panel.posted.find(m => m.command === 'init');
}

test('table panel: init omits the alias qualifier when the option is off', async () => {
    const init = await openTablePanelInit('public', 'orders');
    assert.ok(init, 'expected an init message');
    assert.equal(init.origin, 'table');
    assert.equal(init.qualifyColumnsWithAlias, false);
    assert.equal(init.tableAlias, '');
});

test('table panel: init carries the option and the persisted table alias', async () => {
    const originalGetConfig = vscodeStub.workspace.getConfiguration;
    vscodeStub.workspace.getConfiguration = (_section?: string) => ({
        get<T>(key: string, defaultValue?: T): T {
            return (key === 'qualifyColumnsWithAlias' ? true : defaultValue) as T;
        }
    });
    let init;
    try {
        init = await openTablePanelInit('public', 'orders', (store) => {
            store['tableQualifiers'] = { 'public.orders': 'ord' };
        });
    } finally {
        vscodeStub.workspace.getConfiguration = originalGetConfig;
    }
    assert.ok(init, 'expected an init message');
    assert.equal(init.qualifyColumnsWithAlias, true);
    assert.equal(init.tableAlias, 'ord');
});

test('table panel: with the option on but no persisted alias the webview derives one', async () => {
    const originalGetConfig = vscodeStub.workspace.getConfiguration;
    vscodeStub.workspace.getConfiguration = (_section?: string) => ({
        get<T>(key: string, defaultValue?: T): T {
            return (key === 'qualifyColumnsWithAlias' ? true : defaultValue) as T;
        }
    });
    let init;
    try {
        init = await openTablePanelInit('public', 'orders');
    } finally {
        vscodeStub.workspace.getConfiguration = originalGetConfig;
    }
    assert.ok(init, 'expected an init message');
    assert.equal(init.qualifyColumnsWithAlias, true);
    // No stored alias: the empty string tells the webview to derive one.
    assert.equal(init.tableAlias, '');
});

test('table panel: init carries the mapping-default-to-workspace option', async () => {
    const offInit = await openTablePanelInit('public', 'orders');
    assert.equal(offInit.newMappingDefaultWorkspace, false);

    const originalGetConfig = vscodeStub.workspace.getConfiguration;
    vscodeStub.workspace.getConfiguration = (_section?: string) => ({
        get<T>(key: string, defaultValue?: T): T {
            return (key === 'newMappingsToWorkspace' ? true : defaultValue) as T;
        }
    });
    let onInit;
    try {
        onInit = await openTablePanelInit('public', 'orders');
    } finally {
        vscodeStub.workspace.getConfiguration = originalGetConfig;
    }
    assert.equal(onInit.newMappingDefaultWorkspace, true);
});

test('query panel: openGeneratedStatement opens the given SQL in a new editor', async () => {
    const { panel, send } = await openCustomQueryPanel();
    const originalOpen = vscodeStub.workspace.openTextDocument;
    const originalShow = vscodeStub.window.showTextDocument;
    let openedWith: any;
    let shown = false;
    vscodeStub.workspace.openTextDocument = (arg: any) => { openedWith = arg; return Promise.resolve({ uri: 'doc' }); };
    vscodeStub.window.showTextDocument = () => { shown = true; return Promise.resolve(undefined); };
    try {
        await send({ command: 'openGeneratedStatement', sql: 'DELETE FROM orders o\nWHERE o.status = 1;' });
    } finally {
        vscodeStub.workspace.openTextDocument = originalOpen;
        vscodeStub.window.showTextDocument = originalShow;
    }
    assert.equal(openedWith.language, 'sql');
    assert.equal(openedWith.content, 'DELETE FROM orders o\nWHERE o.status = 1;');
    assert.ok(shown, 'expected the generated statement to be shown in an editor');
    assert.ok(!panel.posted.some(m => m.command === 'error'), 'no error expected');
});

test('query panel: openGeneratedStatement ignores an empty statement', async () => {
    const { send } = await openCustomQueryPanel();
    const originalOpen = vscodeStub.workspace.openTextDocument;
    let opened = false;
    vscodeStub.workspace.openTextDocument = (arg: any) => { opened = true; return Promise.resolve({ uri: arg }); };
    try {
        await send({ command: 'openGeneratedStatement', sql: '   ' });
    } finally {
        vscodeStub.workspace.openTextDocument = originalOpen;
    }
    assert.equal(opened, false, 'an empty statement must not open an editor');
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

test('query panel: the bookmark button opens the shared dialog with the statement', async () => {
    const { send } = await openCustomQueryPanel();
    const requests = captureBookmarkDialog();
    try {
        await send({ command: 'bookmarkQuery', id: '', name: 'public.o', sql: '  SELECT 1  ' });
    } finally {
        requests.restore();
    }
    assert.equal(requests.list.length, 1);
    assert.equal(requests.list[0].draft.sql, 'SELECT 1');
    assert.equal(requests.list[0].draft.name, 'public.o');
});

test('query panel: bookmarking a running saved query edits that query', async () => {
    const { send, savedQueryStore } = await openCustomQueryPanel();
    savedQueryStore.queries.push({ id: 'a', name: 'A', sql: 'SELECT 1', parameters: [] });
    const requests = captureBookmarkDialog();
    try {
        await send({ command: 'bookmarkQuery', id: 'a', name: 'A', sql: 'SELECT 1' });
    } finally {
        requests.restore();
    }
    assert.equal(requests.list[0].id, 'a');
    assert.equal(requests.list[0].draft, undefined, 'an existing query is edited, not created again');
});

test('query panel: the grid adopts the query the dialog stored', async () => {
    const { panel, send, savedQueryStore } = await openCustomQueryPanel();
    const requests = captureBookmarkDialog();
    try {
        await send({ command: 'bookmarkQuery', id: '', name: 'Q', sql: 'SELECT * FROM t WHERE a = :a' });
        savedQueryStore.queries.push({
            id: 'new-id', name: 'Q', sql: 'SELECT * FROM t WHERE a = :a', parameters: [{ name: 'a', kind: 'text' }]
        });
        requests.list[0].onSaved('new-id');
    } finally {
        requests.restore();
    }
    const msg = panel.posted.find(m => m.command === 'savedQuerySaved');
    assert.ok(msg, 'expected savedQuerySaved');
    assert.equal(msg.id, 'new-id');
    assert.equal(msg.sql, 'SELECT * FROM t WHERE a = :a');
    assert.deepEqual(msg.parameters, [{ name: 'a', kind: 'text' }]);
});

test('query panel: bookmarking without a statement opens no dialog', async () => {
    const { send } = await openCustomQueryPanel();
    const requests = captureBookmarkDialog();
    try {
        await send({ command: 'bookmarkQuery', id: '', name: 'Q', sql: '   ' });
    } finally {
        requests.restore();
    }
    assert.equal(requests.list.length, 0);
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

test('query panel: the row token of an opened cell comes back unchanged on save', async () => {
    const rowToken = { fingerprint: '[["id",7]]' };
    const { panel, doc } = await openCellEditor({ rowToken });
    fs.writeFileSync(doc.uri.fsPath, 'edited', 'utf8');
    fireDidSaveTextDocument(doc);

    const msg = panel.posted.filter((m: any) => m.command === 'cellEditorValue').pop();
    assert.deepEqual(msg.rowToken, rowToken);
});

test('query panel: a cell editor tab of a closed panel writes nothing back but still cleans up', async () => {
    const { panel, doc } = await openCellEditor();
    panel.state.onDispose.forEach(cb => cb());
    panel.posted.length = 0;

    fs.writeFileSync(doc.uri.fsPath, 'too late', 'utf8');
    fireDidSaveTextDocument(doc);
    assert.equal(panel.posted.some((m: any) => m.command === 'cellEditorValue'), false);

    fireDidCloseTextDocument(doc);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fs.existsSync(doc.uri.fsPath), false, 'the scratch file must be gone');
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

// ===== Relation metadata of a joined, aliased ad-hoc query =====

/**
 * A result built from two real tables whose columns are all renamed: orders
 * (oid 1) with id/customer_id and customers (oid 2) with id/name.
 */
const JOIN_FIELDS = [
    { name: 'bestellung', dataTypeID: 23, tableID: 1, columnID: 1 },
    { name: 'kunden_nr', dataTypeID: 23, tableID: 1, columnID: 2 },
    { name: 'kunden_id', dataTypeID: 23, tableID: 2, columnID: 1 },
    { name: 'kunde', dataTypeID: 25, tableID: 2, columnID: 2 }
];

/** Connection stub answering the catalog queries for {@link JOIN_FIELDS}. */
function joinConnection() {
    return {
        query: async () => ({ rows: [{ bestellung: 1, kunden_nr: 7, kunden_id: 7, kunde: 'ACME' }], fields: JOIN_FIELDS }),
        queryMetadata: async (sql: string, params?: any[]) => {
            if (sql.includes('FROM pg_class')) {
                return [
                    { oid: 1, nspname: 'public', relname: 'orders', relkind: 'r' },
                    { oid: 2, nspname: 'public', relname: 'customers', relkind: 'r' }
                ];
            }
            if (sql.includes('FROM pg_attribute')) {
                return [
                    { attrelid: 1, attnum: 1, attname: 'id' },
                    { attrelid: 1, attnum: 2, attname: 'customer_id' },
                    { attrelid: 2, attnum: 1, attname: 'id' },
                    { attrelid: 2, attnum: 2, attname: 'name' }
                ];
            }
            if (sql.includes('indisprimary')) {
                return [{ attname: 'id' }];
            }
            if (sql.includes('AS ref_schema')) {
                return params?.[1] === 'orders'
                    ? [{ fk_column: 'customer_id', ref_schema: 'public', ref_table: 'customers', ref_column: 'id' }]
                    : [];
            }
            if (sql.includes('AS local_column')) {
                return params?.[1] === 'customers'
                    ? [{ fk_schema: 'public', fk_table: 'orders', fk_column: 'customer_id', local_column: 'id' }]
                    : [];
            }
            return [];
        }
    };
}

/** Mapping on customers.name, conditional on customers.id. */
const CUSTOMER_MAPPING = {
    id: 'm1',
    sourceSchema: 'public',
    sourceTable: 'customers',
    sourceColumn: 'name',
    targetSchema: 'public',
    targetTable: 'notes',
    targetColumn: 'subject',
    conditions: [{ column: 'id', operator: '=', value: '7' }],
    additionalColumnPairs: [{ sourceColumn: 'id', targetColumn: 'customer_id' }],
    isDefault: false
};

/** Run a joined query in a panel and return everything it posted back. */
async function runJoinedQuery(mappings: any[] = []) {
    const opened = await openCustomQueryPanel(undefined, { connection: joinConnection(), mappings });
    await opened.send({ command: 'loadRows', sql: 'SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id' });
    // The relation metadata is loaded without blocking the rows.
    await new Promise(resolve => setImmediate(resolve));
    return opened;
}

test('query panel: foreign keys of every joined table arrive under the result column names', async () => {
    const { panel } = await runJoinedQuery();
    const msg = panel.posted.find((m: any) => m.command === 'foreignKeysLoaded');
    assert.ok(msg, 'expected foreignKeysLoaded to be posted for an ad-hoc query');
    assert.deepEqual(msg.foreignKeys, [
        { column: 'kunden_nr', refSchema: 'public', refTable: 'customers', refColumn: 'id' }
    ]);
});

test('query panel: referencing tables of every joined table arrive under the result column names', async () => {
    const { panel } = await runJoinedQuery();
    const msg = panel.posted.find((m: any) => m.command === 'referencingTablesLoaded');
    assert.ok(msg, 'expected referencingTablesLoaded to be posted for an ad-hoc query');
    assert.deepEqual(msg.referencingTables, [
        { fkSchema: 'public', fkTable: 'orders', fkColumn: 'customer_id', localColumn: 'kunden_id' }
    ]);
});

test('query panel: custom mappings of a joined table follow the renamed columns', async () => {
    const { panel } = await runJoinedQuery([CUSTOMER_MAPPING]);
    const msg = panel.posted.filter((m: any) => m.command === 'customMappingsLoaded').pop();
    assert.ok(msg, 'expected customMappingsLoaded to be posted for an ad-hoc query');
    assert.equal(msg.mappings.length, 1);
    assert.equal(msg.mappings[0].sourceColumn, 'kunde');
    assert.equal(msg.mappings[0].targetTable, 'notes');
    // Conditions and composite pairs name source columns as well.
    assert.deepEqual(msg.mappings[0].conditions, [{ column: 'kunden_id', operator: '=', value: '7' }]);
    assert.deepEqual(msg.mappings[0].additionalColumnPairs, [{ sourceColumn: 'kunden_id', targetColumn: 'customer_id' }]);
    // The stored mapping itself keeps the real column names.
    assert.equal(CUSTOMER_MAPPING.sourceColumn, 'name');
    assert.equal(CUSTOMER_MAPPING.conditions[0].column, 'id');
});

test('query panel: a result of several tables loads no key or default metadata', async () => {
    const { panel } = await runJoinedQuery();
    assert.equal(panel.posted.some((m: any) => m.command === 'primaryKeysLoaded'), false);
    assert.equal(panel.posted.some((m: any) => m.command === 'columnDefaultsLoaded'), false);
});

/** Column data of the tables involved in the related-join tests. */
const JOIN_TABLES: Record<string, any> = {
    customers: { schema: 'public', table: 'customers', tableReference: 'customers', columns: ['id', 'name'], rawColumns: ['id', 'name'], firstColumnRaw: 'id' },
    orders: { schema: 'public', table: 'orders', tableReference: 'orders', columns: ['id', 'customer_id'], rawColumns: ['id', 'customer_id'], firstColumnRaw: 'id' }
};

/** Send an openRelatedJoin message and return the query panel it opened. */
async function openRelatedJoin(message: any) {
    const { send } = await openCustomQueryPanel();
    const opened = createFakePanel();
    const originalCreate = vscodeStub.window.createWebviewPanel;
    vscodeStub.window.createWebviewPanel = () => opened;
    const runner: any = QueryRunner.prototype;
    const originalJoinData = runner.getMultiTableJoinData;
    runner.getMultiTableJoinData = async (tables: any[]) => ({ tables: tables.map(t => JOIN_TABLES[t.table]) });
    try {
        await send(Object.assign({ command: 'openRelatedJoin' }, message));
    } finally {
        vscodeStub.window.createWebviewPanel = originalCreate;
        runner.getMultiTableJoinData = originalJoinData;
    }
    return opened.posted.find((m: any) => m.command === 'init');
}

test('query panel: a query joined in as a derived table is matched on its own column names', async () => {
    const sourceSql = 'SELECT o.customer_id AS kunden_nr FROM orders o JOIN parts p ON p.id = o.part_id';
    const init = await openRelatedJoin({
        sourceSchema: 'public', sourceTable: 'orders',
        targetSchema: 'public', targetTable: 'customers',
        columnPairs: [{ sourceColumn: 'kunden_nr', targetColumn: 'id' }],
        sourceSql,
        sourceColumns: ['kunden_nr']
    });
    assert.ok(init, 'expected the joined query to be opened');
    assert.ok(init.sql.includes(`(${sourceSql})`), `derived table missing in ${init.sql}`);
    assert.ok(init.sql.includes('"kunden_nr"'), `the result column must be joined on: ${init.sql}`);
});

test('query panel: a column the derived query does not show is rejected', async () => {
    const original = vscodeStub.window.showErrorMessage;
    const errors: string[] = [];
    vscodeStub.window.showErrorMessage = (msg: string) => { errors.push(msg); return Promise.resolve(undefined); };
    try {
        const init = await openRelatedJoin({
            sourceSchema: 'public', sourceTable: 'orders',
            targetSchema: 'public', targetTable: 'customers',
            columnPairs: [{ sourceColumn: 'customer_id', targetColumn: 'id' }],
            sourceSql: 'SELECT o.customer_id AS kunden_nr FROM orders o JOIN parts p ON p.id = o.part_id',
            sourceColumns: ['kunden_nr']
        });
        assert.equal(init, undefined, 'no query may be opened for an unknown column');
    } finally {
        vscodeStub.window.showErrorMessage = original;
    }
    assert.match(errors.join('\n'), /Unknown column: customer_id/);
});

test('query panel: a plain single-table query is still joined to the table itself', async () => {
    const init = await openRelatedJoin({
        sourceSchema: 'public', sourceTable: 'orders',
        targetSchema: 'public', targetTable: 'customers',
        columnPairs: [{ sourceColumn: 'customer_id', targetColumn: 'id' }],
        where: "state = 'open'",
        sourceSql: '',
        sourceColumns: []
    });
    assert.ok(init, 'expected the joined query to be opened');
    assert.ok(!init.sql.includes('SELECT o.customer_id'), 'no derived table expected');
    assert.ok(init.sql.includes('orders'), `the source table must be joined in: ${init.sql}`);
});

test('query panel: the joins of the current query are carried into the new one', async () => {
    const init = await openRelatedJoin({
        sourceSchema: 'public', sourceTable: 'orders',
        targetSchema: 'public', targetTable: 'customers',
        columnPairs: [{ sourceColumn: 'customer_id', targetColumn: 'id' }],
        where: "p.name LIKE 'A%'",
        sourceSql: '',
        sourceColumns: [],
        sourceJoins: 'LEFT JOIN parts p ON p.id = o.part_id',
        sourceAlias: 'o'
    });
    assert.ok(init, 'expected the joined query to be opened');
    assert.ok(init.sql.includes('INNER JOIN orders o ON'), `the source keeps its alias: ${init.sql}`);
    assert.ok(init.sql.includes('LEFT JOIN parts p ON p.id = o.part_id'), `carried join missing in ${init.sql}`);
    assert.ok(init.sql.includes("WHERE p.name LIKE 'A%'"), `the WHERE clause must stay whole: ${init.sql}`);
});

test('query panel: carried joins without a usable alias fall back to a plain join', async () => {
    const init = await openRelatedJoin({
        sourceSchema: 'public', sourceTable: 'orders',
        targetSchema: 'public', targetTable: 'customers',
        columnPairs: [{ sourceColumn: 'customer_id', targetColumn: 'id' }],
        sourceSql: '',
        sourceColumns: [],
        sourceJoins: 'LEFT JOIN parts p ON p.id = o.part_id',
        sourceAlias: 'o; DROP TABLE parts'
    });
    assert.ok(init, 'expected the joined query to be opened');
    assert.ok(!init.sql.includes('LEFT JOIN parts'), `no join may be carried over: ${init.sql}`);
    assert.ok(!init.sql.includes('DROP TABLE'), `the alias must not reach the SQL: ${init.sql}`);
});

// ===== Key columns selected silently for a custom query =====

/** `SELECT o.customer_id AS kunden_nr FROM orders o` — the key is not shown. */
const KEYLESS_FIELDS = [{ name: 'kunden_nr', dataTypeID: 23, tableID: 1, columnID: 2 }];
const KEY_FIELD = { name: '__pqb_key_0', dataTypeID: 23, tableID: 1, columnID: 1 };
const KEYLESS_SQL = 'SELECT o.customer_id AS kunden_nr FROM orders o';

/**
 * Connection stub for a result whose key column is missing: the fields of a
 * statement depend on whether it selects the key column.
 */
function keylessConnection(options: { failWithKey?: boolean } = {}) {
    const ran: string[] = [];
    const connection = {
        query: async (sql: string) => {
            const withKey = sql.includes('__pqb_key_0');
            if (sql.includes('FROM orders')) {
                ran.push(sql);
                if (withKey && options.failWithKey) {
                    throw new Error('column o.id does not exist');
                }
            }
            return {
                rows: withKey ? [{ kunden_nr: 7, __pqb_key_0: 42 }] : [{ kunden_nr: 7 }],
                fields: withKey ? [...KEYLESS_FIELDS, KEY_FIELD] : KEYLESS_FIELDS
            };
        },
        queryMetadata: async (sql: string) => {
            if (sql.includes('FROM pg_class')) {
                return [{ oid: 1, nspname: 'public', relname: 'orders', relkind: 'r' }];
            }
            if (sql.includes('FROM pg_attribute')) {
                return [{ attrelid: 1, attnum: 1, attname: 'id' }, { attrelid: 1, attnum: 2, attname: 'customer_id' }];
            }
            if (sql.includes('indisprimary')) {
                return [{ attname: 'id' }];
            }
            return [];
        }
    };
    return { connection, ran };
}

/** Load a keyless query and return the panel plus the statements it ran. */
async function runKeylessQuery(options: { failWithKey?: boolean } = {}) {
    const { connection, ran } = keylessConnection(options);
    const opened = await openCustomQueryPanel(undefined, { connection });
    await opened.send({ command: 'loadRows', sql: KEYLESS_SQL });
    await new Promise(resolve => setImmediate(resolve));
    const rowsLoaded = opened.panel.posted.filter((m: any) => m.command === 'rowsLoaded').pop();
    return { ...opened, ran, rowsLoaded };
}

test('query panel: a query that hides its key selects it silently', async () => {
    const { ran, rowsLoaded } = await runKeylessQuery();
    assert.ok(ran.some(sql => sql.includes('o."id" AS "__pqb_key_0"')), `key column missing in ${ran.join(' | ')}`);
    assert.ok(rowsLoaded, 'expected the rows to be posted');
    assert.deepEqual(rowsLoaded.columns.map((c: any) => c.name), ['kunden_nr'], 'the key must not be shown');
    assert.equal(rowsLoaded.rows[0].__pqb_key_0, 42, 'the row keeps the key value');
});

test('query panel: the silently selected key identifies the row', async () => {
    const { rowsLoaded } = await runKeylessQuery();
    const caps = rowsLoaded.capabilities;
    assert.equal(caps.identityStrategy, 'pk');
    assert.equal(caps.warning, null, 'a key was found, so nothing has to be warned about');
    assert.deepEqual(caps.tables[0].identityColumns.map((c: any) => c.name), ['__pqb_key_0']);
    assert.deepEqual(caps.tables[0].identityColumns.map((c: any) => c.sourceColumn), ['id']);
    // Everything the grid resolves a column through leaves the key out.
    assert.deepEqual(Object.keys(caps.columnSources), ['kunden_nr']);
    assert.deepEqual(caps.editableColumns, ['kunden_nr']);
    assert.deepEqual(caps.tables[0].columns.map((c: any) => c.name), ['kunden_nr']);
});

test('query panel: every appended page carries the key as well', async () => {
    const opened = await runKeylessQuery();
    await opened.send({ command: 'loadRows', sql: `${KEYLESS_SQL} LIMIT 100 OFFSET 100`, baseSql: KEYLESS_SQL, append: true });
    const paged = opened.ran.filter(sql => sql.includes('OFFSET 100'));
    assert.equal(paged.length, 1, 'expected the next page to be fetched');
    assert.ok(paged[0].includes('__pqb_key_0'), `the appended page lost the key: ${paged[0]}`);
});

test('query panel: a key that cannot be selected costs no result', async () => {
    const { ran, rowsLoaded } = await runKeylessQuery({ failWithKey: true });
    assert.ok(ran.some(sql => !sql.includes('__pqb_key_0')), 'expected the plain query to be run');
    assert.ok(rowsLoaded, 'the rows must arrive anyway');
    assert.deepEqual(rowsLoaded.columns.map((c: any) => c.name), ['kunden_nr']);
    assert.equal(rowsLoaded.capabilities.identityStrategy, 'row');
});

// ===== A table the query joins in twice =====

/** Both aliases select the same column of the same table. */
const TWICE_SQL = 'SELECT a.wert AS "IRWAZ", b.wert AS "PLAWAZ" FROM attributes a JOIN attributes b ON b.id = a.next';

/** Load a query that joins one table under two aliases. */
async function runTwiceJoinedQuery() {
    const ran: string[] = [];
    const field = (name: string, columnID: number) => ({ name, dataTypeID: 25, tableID: 1, columnID });
    const connection = {
        query: async (sql: string) => {
            const withKeys = sql.includes('__pqb_key_0');
            if (sql.includes('FROM attributes')) {
                ran.push(sql);
            }
            return {
                rows: withKeys
                    ? [{ IRWAZ: 'x', PLAWAZ: 'y', __pqb_key_0: 11, __pqb_key_1: 22 }]
                    : [{ IRWAZ: 'x', PLAWAZ: 'y' }],
                fields: withKeys
                    ? [field('IRWAZ', 2), field('PLAWAZ', 2), field('__pqb_key_0', 1), field('__pqb_key_1', 1)]
                    : [field('IRWAZ', 2), field('PLAWAZ', 2)]
            };
        },
        queryMetadata: async (sql: string) => {
            if (sql.includes('FROM pg_class')) {
                return [{ oid: 1, nspname: 'public', relname: 'attributes', relkind: 'r' }];
            }
            if (sql.includes('FROM pg_attribute')) {
                return [{ attrelid: 1, attnum: 1, attname: 'id' }, { attrelid: 1, attnum: 2, attname: 'wert' }];
            }
            if (sql.includes('indisprimary')) {
                return [{ attname: 'id' }];
            }
            return [];
        }
    };
    const opened = await openCustomQueryPanel(undefined, { connection });
    await opened.send({ command: 'loadRows', sql: TWICE_SQL });
    await new Promise(resolve => setImmediate(resolve));
    return { ran, rowsLoaded: opened.panel.posted.filter((m: any) => m.command === 'rowsLoaded').pop() };
}

test('query panel: a table joined in twice gets a key per alias', async () => {
    const { ran, rowsLoaded } = await runTwiceJoinedQuery();
    const executed = ran.find(sql => sql.includes('__pqb_key_0')) || '';
    assert.ok(executed.includes('a."id" AS "__pqb_key_0"'), `the first alias lost its key: ${executed}`);
    assert.ok(executed.includes('b."id" AS "__pqb_key_1"'), `the second alias lost its key: ${executed}`);
    assert.ok(rowsLoaded, 'expected the rows to be posted');
    assert.deepEqual(rowsLoaded.columns.map((c: any) => c.name), ['IRWAZ', 'PLAWAZ']);
});

test('query panel: each alias of a twice-joined table identifies its own row', async () => {
    const { rowsLoaded } = await runTwiceJoinedQuery();
    const tables = rowsLoaded.capabilities.tables;

    assert.equal(tables.length, 2, 'both occurrences must be planned separately');
    assert.deepEqual(tables.map((t: any) => t.qualifier), ['a', 'b']);
    assert.deepEqual(tables.map((t: any) => t.identityStrategy), ['pk', 'pk']);
    assert.deepEqual(tables.map((t: any) => t.identityColumns[0].name), ['__pqb_key_0', '__pqb_key_1']);
    assert.deepEqual(tables.map((t: any) => t.columns.map((c: any) => c.name)), [['IRWAZ'], ['PLAWAZ']]);
    assert.equal(rowsLoaded.capabilities.warning, null);
});

// ===== Two result columns that carry the same name =====

/** Both aliases select the same unaliased columns, so the names collide. */
const DUPLICATE_SQL = 'SELECT a.a, a.b, b.a, b.b FROM things a LEFT JOIN things b ON b.c > a.c WHERE a.a = 20';

/** Load a query whose result names two columns `a` and two columns `b`. */
async function runDuplicateNameQuery() {
    const field = (name: string, columnID: number) => ({ name, dataTypeID: 23, tableID: 1, columnID });
    const fieldsOf = (sql: string) => {
        const base = [field('a', 1), field('b', 2), field('a', 1), field('b', 2)];
        return sql.includes('__pqb_key_0')
            ? [...base, field('__pqb_key_0', 4), field('__pqb_key_1', 4)]
            : base;
    };
    const connection = {
        // The probe for the early header asks for the columns only.
        query: async (sql: string) => ({ rows: [], fields: fieldsOf(sql) }),
        // The real result: the second alias found no match, so its values are
        // NULL while the first alias has values.
        queryPositional: async (sql: string) => ({
            rows: [sql.includes('__pqb_key_0') ? [20, 7, null, null, 11, null] : [20, 7, null, null]],
            fields: fieldsOf(sql),
            rowCount: 1
        }),
        queryMetadata: async (sql: string) => {
            if (sql.includes('FROM pg_class')) {
                return [{ oid: 1, nspname: 'public', relname: 'things', relkind: 'r' }];
            }
            if (sql.includes('FROM pg_attribute')) {
                return [
                    { attrelid: 1, attnum: 1, attname: 'a' },
                    { attrelid: 1, attnum: 2, attname: 'b' },
                    { attrelid: 1, attnum: 3, attname: 'c' },
                    { attrelid: 1, attnum: 4, attname: 'id' }
                ];
            }
            if (sql.includes('indisprimary')) {
                return [{ attname: 'id' }];
            }
            return [];
        }
    };
    const opened = await openCustomQueryPanel(undefined, { connection });
    await opened.send({ command: 'loadRows', sql: DUPLICATE_SQL });
    await new Promise(resolve => setImmediate(resolve));
    return { rowsLoaded: opened.panel.posted.filter((m: any) => m.command === 'rowsLoaded').pop() };
}

test('query panel: duplicated column names carry the alias they are selected through', async () => {
    const { rowsLoaded } = await runDuplicateNameQuery();
    assert.ok(rowsLoaded, 'expected the rows to be posted');
    assert.deepEqual(rowsLoaded.columns.map((c: any) => c.name), ['a.a', 'a.b', 'b.a', 'b.b']);
});

test('query panel: a column shown twice keeps the values of both aliases', async () => {
    const { rowsLoaded } = await runDuplicateNameQuery();
    assert.deepEqual(rowsLoaded.rows[0]['a.a'], 20, 'the first alias must not be overwritten');
    assert.deepEqual(rowsLoaded.rows[0]['a.b'], 7);
    assert.equal(rowsLoaded.rows[0]['b.a'], null, 'the unmatched join stays empty');
    assert.equal(rowsLoaded.rows[0]['b.b'], null);
});

test('query panel: a renamed column still resolves to its own table occurrence', async () => {
    const { rowsLoaded } = await runDuplicateNameQuery();
    const sources = rowsLoaded.capabilities.columnSources;
    assert.deepEqual(sources['a.a'].qualifier, 'a');
    assert.deepEqual(sources['a.a'].sourceColumn, 'a', 'the real column keeps its own name');
    assert.deepEqual(sources['b.a'].qualifier, 'b');
    assert.deepEqual(
        rowsLoaded.capabilities.tables.map((t: any) => t.qualifier),
        ['a', 'b'],
        'both occurrences are written back separately'
    );
});

// ===== SQL editor of the query bar (3.3.0) =====

test('queryEditorAssets maps the Monaco files to webview URIs when they were built', () => {
    const assets = queryEditorAssets('/ext', (f) => `uri:${f.replace(/\\/g, '/')}`, () => true);
    assert.deepEqual(assets, {
        script: 'uri:/ext/dist/monaco/monaco.js',
        css: 'uri:/ext/dist/monaco/monaco.css',
        worker: 'uri:/ext/dist/monaco/editor.worker.js'
    });
});

test('queryEditorAssets yields null without the bundle or without a URI mapping, so the text box stays', () => {
    assert.equal(queryEditorAssets('/ext', (f) => f, (f) => !f.endsWith('editor.worker.js')), null);
    assert.equal(queryEditorAssets('/ext', undefined, () => true), null);
});

test('data viewer: the SQL editor module is injected before the grid script that attaches it', async () => {
    const { panel } = await openCustomQueryPanel();
    const html = panel.webview.html;
    const editorJs = fs.readFileSync(path.join(EXTENSION_PATH, 'src', 'webview', 'queryEditor.js'), 'utf8');
    const gridJs = fs.readFileSync(path.join(EXTENSION_PATH, 'src', 'webview', 'tableView.js'), 'utf8');
    assert.ok(html.includes(editorJs), 'the editor module is missing');
    assert.ok(html.indexOf(editorJs) < html.indexOf(gridJs), 'the editor module must come first');
    // The stub webview cannot map resource URIs, so the panel falls back to the text box.
    assert.ok(html.includes('window.QUERY_EDITOR_ASSETS = null;'));
});

test('query editor: a saved table alias makes every open panel drop its cached catalog', async () => {
    const { panel, globalStateStore } = await openCustomQueryPanel();
    const memento: any = {
        get: (key: string, def?: any) => (key in globalStateStore ? globalStateStore[key] : def),
        update: (key: string, value: any) => { globalStateStore[key] = value; return Promise.resolve(); }
    };
    await new QualifierStore(memento).set('public', 'orders', 'o');
    assert.ok(panel.posted.some((m: any) => m.command === 'completionCatalogChanged'));
});

test('query editor: the catalog carries the alias each table is completed with', async () => {
    const { panel, send, globalStateStore } = await openCustomQueryPanel(undefined, {
        connection: {
            isConnected: () => true,
            queryMetadata: async (sql: string) => {
                if (sql.includes('first_column')) {
                    return [
                        { table_schema: 'public', table_name: 'mitarbeiter_tag', first_column: 'mtd_id' },
                        { table_schema: 'public', table_name: 'orders', first_column: 'ord_id' },
                        { table_schema: 'public', table_name: 'users', first_column: 'id' }
                    ];
                }
                if (sql.includes('pg_namespace')) return [{ nspname: 'public' }];
                if (sql.includes('current_schemas')) return [{ schema_name: 'public' }];
                return ['mitarbeiter_tag', 'orders', 'users'].map((t) => ({ table_schema: 'public', table_name: t, rel_kind: 'table' }));
            }
        }
    });
    // The alias chosen when dragging the table into an editor wins.
    globalStateStore.tableQualifiers = { 'public.orders': 'o' };
    await send({ command: 'queryEditorRequest', requestId: 8, kind: 'catalog' });
    const reply = panel.posted.find((m: any) => m.command === 'queryEditorResponse');
    assert.deepEqual(reply.result.relations, [
        { schema: 'public', name: 'mitarbeiter_tag', kind: 'table', alias: 'mtd' },
        { schema: 'public', name: 'orders', kind: 'table', alias: 'o' },
        { schema: 'public', name: 'users', kind: 'table' }
    ]);
});

test('query editor: the panel is told whether completed tables get their alias', async () => {
    const { panel } = await openCustomQueryPanel();
    assert.equal(panel.posted.find((m: any) => m.command === 'init').completionTableAlias, true, 'on by default');

    const original = vscodeStub.workspace.getConfiguration;
    vscodeStub.workspace.getConfiguration = () => ({ get: <T>(key: string, def?: T) => (key === 'completion.tableAlias' ? false : def) as T });
    try {
        const off = await openCustomQueryPanel();
        assert.equal(off.panel.posted.find((m: any) => m.command === 'init').completionTableAlias, false);
    } finally {
        vscodeStub.workspace.getConfiguration = original;
    }
});

test('query editor: the catalog lists schemas, relations and the search_path of the connection', async () => {
    const { panel, send } = await openCustomQueryPanel(undefined, {
        connection: {
            isConnected: () => true,
            queryMetadata: async (sql: string) => {
                if (sql.includes('pg_namespace')) return [{ nspname: 'public' }, { nspname: 'sales' }];
                if (sql.includes('current_schemas')) return [{ schema_name: 'public' }];
                return [
                    { table_schema: 'public', table_name: 'orders', rel_kind: 'table' },
                    { table_schema: 'sales', table_name: 'totals', rel_kind: 'matview' }
                ];
            }
        }
    });
    await send({ command: 'queryEditorRequest', requestId: 7, kind: 'catalog' });
    const reply = panel.posted.find((m: any) => m.command === 'queryEditorResponse');
    assert.deepEqual(reply, {
        command: 'queryEditorResponse',
        requestId: 7,
        result: {
            schemas: ['public', 'sales'],
            relations: [
                { schema: 'public', name: 'orders', kind: 'table' },
                { schema: 'sales', name: 'totals', kind: 'matview' }
            ],
            searchPath: ['public']
        }
    });
});

test('query editor: without a connection the catalog is empty and nobody is asked to connect', async () => {
    let prompts = 0;
    const { panel, send } = await openCustomQueryPanel(undefined, {
        connection: { isConnected: () => false, ensureConnected: async () => { prompts++; return true; } }
    });
    const before = prompts;
    await send({ command: 'queryEditorRequest', requestId: 1, kind: 'catalog' });
    const reply = panel.posted.find((m: any) => m.command === 'queryEditorResponse');
    assert.deepEqual(reply.result, { schemas: [], relations: [], searchPath: [] });
    assert.equal(prompts, before, 'typing must never open the connection picker');
});

test('query editor: columns come with their types, read by parameter', async () => {
    const calls: any[] = [];
    const { panel, send } = await openCustomQueryPanel(undefined, {
        connection: {
            isConnected: () => true,
            queryMetadata: async (sql: string, params?: any[]) => {
                calls.push({ sql, params });
                return [{ column_name: 'id', data_type: 'integer' }, { column_name: 'Order Date', data_type: 'date' }];
            }
        }
    });
    await send({ command: 'queryEditorRequest', requestId: 2, kind: 'columns', schema: 'public', table: "o'rders" });
    const reply = panel.posted.find((m: any) => m.command === 'queryEditorResponse');
    assert.deepEqual(reply.result, [{ name: 'id', type: 'integer' }, { name: 'Order Date', type: 'date' }]);
    assert.deepEqual(calls[0].params, ['public', "o'rders"]);
    assert.ok(!calls[0].sql.includes("o'rders"), 'names must never be interpolated');
});

test('query editor: a failing lookup is answered with null instead of an error popup', async () => {
    const errors: string[] = [];
    const original = vscodeStub.window.showErrorMessage;
    vscodeStub.window.showErrorMessage = (msg: string) => { errors.push(msg); return Promise.resolve(undefined); };
    try {
        const { panel, send } = await openCustomQueryPanel(undefined, {
            connection: { isConnected: () => true, queryMetadata: async () => { throw new Error('boom'); } }
        });
        await send({ command: 'queryEditorRequest', requestId: 3, kind: 'catalog' });
        const reply = panel.posted.find((m: any) => m.command === 'queryEditorResponse');
        assert.equal(reply.requestId, 3);
        assert.equal(reply.result, null);
        assert.deepEqual(errors, []);
    } finally {
        vscodeStub.window.showErrorMessage = original;
    }
});

test('query editor: formatting uses the PL/pgSQL formatter and drops the trailing newline', async () => {
    const { panel, send } = await openCustomQueryPanel();
    await send({ command: 'queryEditorRequest', requestId: 4, kind: 'format', sql: 'select a, b from t where a = 1' });
    const reply = panel.posted.find((m: any) => m.command === 'queryEditorResponse');
    assert.equal(reply.result.ok, true);
    assert.equal(reply.result.text, formatSqlChecked('select a, b from t where a = 1', getFormatOptions()).text.replace(/\s+$/, ''));
    assert.match(reply.result.text, /^SELECT/);
    assert.ok(!/\s$/.test(reply.result.text));
});

test('formatQueryBarText leaves the text alone and says why when the formatter is turned off', () => {
    const info: string[] = [];
    const originalConfig = vscodeStub.workspace.getConfiguration;
    const originalInfo = vscodeStub.window.showInformationMessage;
    vscodeStub.workspace.getConfiguration = () => ({ get: <T>(key: string, def?: T) => (key === 'format.enable' ? false : def) as T });
    vscodeStub.window.showInformationMessage = (msg: string) => { info.push(msg); return Promise.resolve(undefined); };
    try {
        assert.deepEqual(formatQueryBarText('select 1'), { ok: false, text: 'select 1' });
        assert.match(info[0], /postgresQueryBuilder\.format\.enable/);
    } finally {
        vscodeStub.workspace.getConfiguration = originalConfig;
        vscodeStub.window.showInformationMessage = originalInfo;
    }
});
// ===== Auto refresh =====

/** Connection stub that records every statement the panel runs against it. */
function recordingConnection(options: { connected?: boolean; fail?: boolean } = {}) {
    const ran: string[] = [];
    let prompts = 0;
    const connection = {
        isConnected: () => options.connected !== false,
        ensureConnected: async () => { prompts++; return true; },
        query: async (sql: string) => {
            ran.push(sql);
            if (options.fail && !sql.includes('LIMIT 0')) throw new Error('relation "orders" does not exist');
            return { rows: [{ n: 1 }], fields: [{ name: 'n', dataTypeID: 23 }] };
        }
    };
    return { connection, ran, prompts: () => prompts };
}

test('auto refresh: a statement that changes data is refused and not run', async () => {
    const { connection, ran } = recordingConnection();
    const { panel, send } = await openCustomQueryPanel(undefined, { connection });
    ran.length = 0;
    await send({ command: 'loadRows', sql: "UPDATE orders SET state = 'x' RETURNING *", autoRefresh: true, autoRefreshId: 3 });
    const stopped = panel.posted.find((m: any) => m.command === 'autoRefreshStopped');
    assert.ok(stopped, 'expected the auto refresh to be refused');
    assert.equal(stopped.autoRefreshId, 3);
    assert.match(stopped.reason, /changes data/);
    assert.deepEqual(ran, [], 'nothing may be executed');
});

test('auto refresh: an explicit LOCK TABLE is refused and not run', async () => {
    const { connection, ran } = recordingConnection();
    const { panel, send } = await openCustomQueryPanel(undefined, { connection });
    ran.length = 0;
    await send({ command: 'loadRows', sql: 'LOCK TABLE orders IN ACCESS EXCLUSIVE MODE', autoRefresh: true, autoRefreshId: 5 });
    const stopped = panel.posted.find((m: any) => m.command === 'autoRefreshStopped');
    assert.ok(stopped, 'expected the auto refresh to be refused');
    assert.equal(stopped.autoRefreshId, 5);
    assert.match(stopped.reason, /explicit lock/);
    assert.deepEqual(ran, [], 'nothing may be executed');
});

test('auto refresh: without a connection it is skipped instead of asking for one', async () => {
    const rec = recordingConnection({ connected: false });
    const { panel, send } = await openCustomQueryPanel(undefined, { connection: rec.connection });
    const promptsBefore = rec.prompts();
    await send({ command: 'loadRows', sql: 'SELECT * FROM orders', autoRefresh: true, autoRefreshId: 4 });
    const skipped = panel.posted.find((m: any) => m.command === 'autoRefreshSkipped');
    assert.deepEqual(skipped, { command: 'autoRefreshSkipped', reason: 'notConnected', autoRefreshId: 4 });
    assert.equal(rec.prompts(), promptsBefore, 'no connection prompt may appear');
    assert.deepEqual(rec.ran, []);
});

test('auto refresh: the rows come back marked, without the early header or the relation metadata', async () => {
    const opened = await openCustomQueryPanel(undefined, { connection: joinConnection() });
    const sql = 'SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id';
    await opened.send({ command: 'loadRows', sql });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(opened.panel.posted.some((m: any) => m.command === 'foreignKeysLoaded'), 'a normal load delivers the metadata');
    opened.panel.posted.length = 0;

    await opened.send({ command: 'loadRows', sql: `${sql} LIMIT 50 OFFSET 0`, baseSql: sql, autoRefresh: true, autoRefreshId: 7 });
    await new Promise(resolve => setImmediate(resolve));
    const rows = opened.panel.posted.find((m: any) => m.command === 'rowsLoaded');
    assert.ok(rows, 'expected the refreshed rows');
    assert.equal(rows.autoRefresh, true);
    assert.equal(rows.autoRefreshId, 7);
    const commands = opened.panel.posted.map((m: any) => m.command);
    assert.ok(!commands.includes('columnsLoaded'), `unexpected early header: ${commands.join(', ')}`);
    assert.ok(!commands.includes('foreignKeysLoaded'), `unexpected metadata: ${commands.join(', ')}`);
    assert.ok(!commands.includes('referencingTablesLoaded'), `unexpected metadata: ${commands.join(', ')}`);
});

test('auto refresh: a failing refresh names itself in the error', async () => {
    const original = vscodeStub.window.showErrorMessage;
    vscodeStub.window.showErrorMessage = () => Promise.resolve(undefined);
    try {
        const { connection } = recordingConnection({ fail: true });
        const { panel, send } = await openCustomQueryPanel(undefined, { connection });
        await send({ command: 'loadRows', sql: 'SELECT * FROM orders', autoRefresh: true, autoRefreshId: 9 });
        const error = panel.posted.find((m: any) => m.command === 'error');
        assert.ok(error, 'expected an error');
        assert.equal(error.autoRefreshId, 9);

        await send({ command: 'loadRows', sql: 'SELECT * FROM orders' });
        const manual = panel.posted.filter((m: any) => m.command === 'error').pop();
        assert.equal(manual.autoRefreshId, undefined, 'a manual run is not an auto refresh');
    } finally {
        vscodeStub.window.showErrorMessage = original;
    }
});

test('auto refresh: a custom interval is asked for and answered in seconds', async () => {
    const original = vscodeStub.window.showInputBox;
    const asked: any[] = [];
    try {
        vscodeStub.window.showInputBox = (options: any) => { asked.push(options); return Promise.resolve('1m 30s'); };
        const { panel, send } = await openCustomQueryPanel();
        await send({ command: 'chooseAutoRefreshInterval', current: 45 });
        assert.equal(asked[0].value, '45 s', 'the interval in use is offered for editing');
        assert.equal(asked[0].validateInput('soon'), 'Enter a duration such as 45, 45s, 2m or 1h 30m.');
        assert.deepEqual(panel.posted.find((m: any) => m.command === 'autoRefreshIntervalChosen'), { command: 'autoRefreshIntervalChosen', seconds: 90 });

        vscodeStub.window.showInputBox = () => Promise.resolve(undefined);
        await send({ command: 'chooseAutoRefreshInterval', current: 0 });
        const cancelled = panel.posted.filter((m: any) => m.command === 'autoRefreshIntervalChosen').pop();
        assert.equal(cancelled.seconds, null, 'cancelling keeps the interval');
    } finally {
        vscodeStub.window.showInputBox = original;
    }
});

test('auto refresh: the panel is told when it is hidden or shown again', async () => {
    const { panel } = await openCustomQueryPanel();
    panel.visible = false;
    panel.state.onViewState();
    panel.visible = true;
    panel.state.onViewState();
    const states = panel.posted.filter((m: any) => m.command === 'viewStateChanged').map((m: any) => m.visible);
    assert.deepEqual(states, [false, true]);
});
// ===== Content Security Policy =====

test('data viewer: the panel gets a nonce CSP and no inline event handlers', async () => {
    const { panel } = await openCustomQueryPanel();
    const html: string = panel.webview.html;
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
    assert.ok(meta, 'expected a CSP meta tag');
    assert.match(meta[1], /default-src 'none'/);
    const nonce = /script-src 'nonce-([A-Za-z0-9]+)'/.exec(meta[1]);
    assert.ok(nonce, 'expected a script nonce');
    const scripts = html.match(/<script\b[^>]*>/g) || [];
    assert.ok(scripts.length > 0);
    for (const tag of scripts) {
        assert.ok(tag.includes(`nonce="${nonce[1]}"`), `script without nonce: ${tag}`);
    }
    assert.ok(!/\son(click|change|input|load|error|mouse\w+|key\w+)=["']/i.test(html), 'inline event handlers are blocked by the CSP');
});

test('buildDataViewerCsp allows the Monaco resources and blob workers', () => {
    const csp = buildDataViewerCsp('https://res.example', 'abc');
    assert.match(csp, /script-src 'nonce-abc' https:\/\/res\.example/);
    assert.match(csp, /worker-src https:\/\/res\.example blob:/);
    assert.match(csp, /font-src https:\/\/res\.example data:/);
});

test('applyDataViewerCsp leaves script text injected later untouched', () => {
    const html = applyDataViewerCsp('<head><title>x</title></head><script>/* JS */</script>', '', 'n1');
    assert.ok(html.includes('<script nonce="n1">/* JS */</script>'));
    assert.ok(html.indexOf('Content-Security-Policy') > html.indexOf('</title>'));
});

// ===== Load ids =====

test('data viewer: every answer to a load names the load it belongs to', async () => {
    const { connection } = recordingConnection();
    const { panel, send } = await openCustomQueryPanel(undefined, { connection });
    panel.posted.length = 0;
    await send({ command: 'loadRows', sql: 'SELECT * FROM orders LIMIT 50 OFFSET 0', baseSql: 'SELECT * FROM orders', wantTotal: true, loadId: 12 });
    const answers = panel.posted.filter((m: any) => ['columnsLoaded', 'rowsLoaded', 'totalCountLoaded'].includes(m.command));
    assert.ok(answers.some((m: any) => m.command === 'rowsLoaded'));
    for (const m of answers) assert.equal(m.loadId, 12, `${m.command} without the load id`);
});

test('data viewer: a failing load names its load id in the error', async () => {
    const original = vscodeStub.window.showErrorMessage;
    vscodeStub.window.showErrorMessage = () => Promise.resolve(undefined);
    try {
        const { connection } = recordingConnection({ fail: true });
        const { panel, send } = await openCustomQueryPanel(undefined, { connection });
        await send({ command: 'loadRows', sql: 'SELECT * FROM orders', loadId: 4 });
        const error = panel.posted.filter((m: any) => m.command === 'error').pop();
        assert.equal(error.loadId, 4);
    } finally {
        vscodeStub.window.showErrorMessage = original;
    }
});

// ===== Export =====

test('data viewer: an export of a statement that writes is refused before anything runs', async () => {
    const originalError = vscodeStub.window.showErrorMessage;
    const originalSave = vscodeStub.window.showSaveDialog;
    const errors: string[] = [];
    let dialogs = 0;
    vscodeStub.window.showErrorMessage = (msg: string) => { errors.push(msg); return Promise.resolve(undefined); };
    vscodeStub.window.showSaveDialog = () => { dialogs++; return Promise.resolve(undefined); };
    try {
        const { connection, ran } = recordingConnection();
        const { send } = await openCustomQueryPanel(undefined, { connection });
        ran.length = 0;
        await send({ command: 'exportData', sql: "UPDATE orders SET state = 'x'", options: { format: 'csv', filename: 'x.csv' }, columns: [] });
        assert.deepEqual(ran, [], 'nothing may be executed');
        assert.equal(dialogs, 0, 'no save dialog for a refused export');
        assert.match(errors[0], /Export failed: .*SELECT/);
    } finally {
        vscodeStub.window.showErrorMessage = originalError;
        vscodeStub.window.showSaveDialog = originalSave;
    }
});

// ===== Custom mappings =====

test('data viewer: deleting a custom mapping happens only after the modal confirmation', async () => {
    const original = vscodeStub.window.showWarningMessage;
    const asked: any[] = [];
    try {
        const { send, columnMappingManager } = await openCustomQueryPanel();
        vscodeStub.window.showWarningMessage = (...args: any[]) => { asked.push(args); return Promise.resolve(undefined); };
        await send({ command: 'deleteCustomMapping', mappingId: 'm1' });
        assert.deepEqual(columnMappingManager.deletedMappings, [], 'cancelled: nothing deleted');
        assert.deepEqual(asked[0][1], { modal: true });

        vscodeStub.window.showWarningMessage = () => Promise.resolve('Delete' as any);
        await send({ command: 'deleteCustomMapping', mappingId: 'm1' });
        assert.deepEqual(columnMappingManager.deletedMappings, ['m1']);
    } finally {
        vscodeStub.window.showWarningMessage = original;
    }
});

// ===== 3.4.0: a database session per Data Viewer =====

/** A session manager whose connections record what they are asked to run. */
function createSessionManager(answer?: (sql: string) => Promise<any>, txStatus: () => string = () => 'I') {
    const clients: any[] = [];
    const dbSessions = new DbSessionManager({
        openClient: async () => {
            const client: any = new EventEmitter();
            client.processID = 900 + clients.length;
            client.queries = [] as string[];
            client.ended = false;
            client.getTransactionStatus = () => txStatus();
            client.query = async (config: any) => {
                const sql = typeof config === 'string' ? config : config.text;
                client.queries.push(sql);
                if (answer) return answer(sql);
                return { rows: [[1]], fields: [{ name: 'n', dataTypeID: 23 }], rowCount: 1 };
            };
            client.end = async () => { client.ended = true; client.emit('ended'); };
            clients.push(client);
            return client;
        },
        generation: () => 1
    });
    return { dbSessions, clients };
}

/** Run `open` with `panel` as the next webview panel the manager creates. */
async function withPanel(open: () => Promise<void>) {
    const panel = createFakePanel();
    const originalCreate = vscodeStub.window.createWebviewPanel;
    vscodeStub.window.createWebviewPanel = () => panel;
    try {
        await open();
    } finally {
        vscodeStub.window.createWebviewPanel = originalCreate;
    }
    return panel;
}

const loadRows = (sql: string) => ({ command: 'loadRows', sql: `${sql} LIMIT 50 OFFSET 0`, baseSql: sql, loadId: 1 });
const columnProbe = (sql: string) => `SELECT * FROM (${sql}) AS _pqb_cols LIMIT 0`;
const lastSessionInfo = (panel: any) => panel.posted.filter((m: any) => m.command === 'sessionInfo').pop()?.session;
/** What a session ran for the user, without the search_path lookups of the table references. */
const userQueries = (client: any) => client.queries.filter((sql: string) => !sql.includes("current_setting('search_path')"));

test('every Data Viewer runs its queries, column probe included, on a database session of its own', async () => {
    const { dbSessions, clients } = createSessionManager();
    const poolQueries: string[] = [];
    const { manager } = createManager({
        dbSessions,
        connection: {
            query: async (sql: string) => { poolQueries.push(sql); return { rows: [], fields: [] }; },
            queryPositional: async (sql: string) => { poolQueries.push(sql); return { rows: [], fields: [] }; }
        }
    });
    const first = await withPanel(() => manager.openQueryView('SELECT 1 AS n', 'First'));
    const second = await withPanel(() => manager.openQueryView('SELECT 2 AS n', 'Second'));
    assert.deepEqual(lastSessionInfo(first), { label: 'First', own: true, sharedWith: 0, open: false, pid: null });

    await first.state.onMessage(loadRows('SELECT 1 AS n'));
    await second.state.onMessage(loadRows('SELECT 2 AS n'));
    await first.state.onMessage(loadRows('SELECT 1 AS n'));

    assert.deepEqual(poolQueries.filter((sql) => sql.includes('SELECT 1 AS n') || sql.includes('SELECT 2 AS n')), [],
        'neither the query nor its column probe may run on the pool');
    assert.equal(clients.length, 2);
    assert.deepEqual(userQueries(clients[0]), [
        columnProbe('SELECT 1 AS n'), 'SELECT 1 AS n LIMIT 50 OFFSET 0',
        columnProbe('SELECT 1 AS n'), 'SELECT 1 AS n LIMIT 50 OFFSET 0'
    ]);
    assert.deepEqual(userQueries(clients[1]), [columnProbe('SELECT 2 AS n'), 'SELECT 2 AS n LIMIT 50 OFFSET 0']);
    assert.ok(first.posted.some((m: any) => m.command === 'rowsLoaded'));
    assert.deepEqual(lastSessionInfo(first), { label: 'First', own: true, sharedWith: 0, open: true, pid: 900 });
});

test('the column probe is left out while the session is inside a transaction', async () => {
    const { dbSessions, clients } = createSessionManager(undefined, () => 'T');
    const { manager } = createManager({ dbSessions });
    const panel = await withPanel(() => manager.openQueryView('SELECT 1 AS n', 'First'));

    await panel.state.onMessage(loadRows('SELECT 1 AS n'));

    assert.deepEqual(userQueries(clients[0]), ['SELECT 1 AS n LIMIT 50 OFFSET 0'],
        'a failing probe would abort the transaction of the user');
    assert.ok(panel.posted.some((m: any) => m.command === 'rowsLoaded'));
});

test('a save inside the open transaction of the session says it still needs COMMIT', async (t) => {
    const infos: any[] = [];
    const original = vscodeStub.window.showInformationMessage;
    vscodeStub.window.showInformationMessage = (...args: any[]) => { infos.push(args); return Promise.resolve(undefined); };
    t.after(() => { vscodeStub.window.showInformationMessage = original; });
    const { dbSessions, clients } = createSessionManager(undefined, () => 'T');
    const { manager } = createManager({ dbSessions });
    const panel = await withPanel(() => manager.openQueryView('SELECT 1 AS n', 'First'));

    await panel.state.onMessage({ command: 'commitChanges', targets: [], sql: 'UPDATE t SET a = 1 WHERE id = 7;' });

    assert.deepEqual(clients[0].queries, ['SAVEPOINT pqb_save', 'UPDATE t SET a = 1 WHERE id = 7', 'RELEASE SAVEPOINT pqb_save']);
    assert.ok(panel.posted.some((m: any) => m.command === 'commitSuccess'));
    assert.equal(infos[0][0],
        'Edited statements ran inside the open transaction of the database session; they become permanent once that transaction is committed with COMMIT.');
});

test('Data Viewers opened with the session of a SQL file share that session', async () => {
    const { dbSessions, clients } = createSessionManager();
    const { manager } = createManager({ dbSessions });
    const ref = { key: 'file:file:///work/payroll.sql', label: 'payroll.sql' };
    dbSessions.acquire(ref, 'file');

    const first = await withPanel(() => manager.openQueryView('SELECT 1 AS n', 'A', undefined, undefined, ref));
    const second = await withPanel(() => manager.openQueryView('SELECT 2 AS n', 'B', undefined, undefined, ref));
    await first.state.onMessage(loadRows('SELECT 1 AS n'));
    await second.state.onMessage(loadRows('SELECT 2 AS n'));

    assert.equal(clients.length, 1);
    assert.deepEqual(userQueries(clients[0]), [
        columnProbe('SELECT 1 AS n'), 'SELECT 1 AS n LIMIT 50 OFFSET 0',
        columnProbe('SELECT 2 AS n'), 'SELECT 2 AS n LIMIT 50 OFFSET 0'
    ]);
    assert.deepEqual(lastSessionInfo(first), { label: 'payroll.sql', own: false, sharedWith: 2, open: true, pid: 900 });
});

test('closing a Data Viewer ends its own session', async () => {
    const { dbSessions, clients } = createSessionManager();
    const { manager } = createManager({ dbSessions });
    const panel = await withPanel(() => manager.openQueryView('SELECT 1 AS n', 'First'));
    await panel.state.onMessage(loadRows('SELECT 1 AS n'));

    panel.state.onDispose.forEach((dispose) => dispose());

    assert.equal(clients[0].ended, true);
});

test('a table opened through a foreign key runs on the session of the Data Viewer it came from', async () => {
    const { dbSessions, clients } = createSessionManager();
    const { manager } = createManager({ dbSessions });
    const orders = await withPanel(() => manager.openQueryView('SELECT 1 AS n', 'orders'));
    await orders.state.onMessage(loadRows('SELECT 1 AS n'));

    const customers = await withPanel(() => orders.state.onMessage({
        command: 'openForeignKey', refSchema: 'public', refTable: 'customers', refColumn: 'id', value: 5, conditions: []
    }));
    await customers.state.onMessage(loadRows('SELECT * FROM public.customers'));

    assert.equal(clients.length, 1);
    assert.ok(clients[0].queries.some((sql: string) => sql.includes("current_setting('search_path')")),
        'the table reference is resolved with the search_path of the session it runs on');
    assert.deepEqual(userQueries(clients[0]), [
        columnProbe('SELECT 1 AS n'), 'SELECT 1 AS n LIMIT 50 OFFSET 0',
        columnProbe('SELECT * FROM public.customers'), 'SELECT * FROM public.customers LIMIT 50 OFFSET 0'
    ]);
    assert.deepEqual(lastSessionInfo(customers), { label: 'orders', own: false, sharedWith: 1, open: true, pid: 900 });

    // The session outlives the tab that opened it while the other one uses it.
    orders.state.onDispose.forEach((dispose) => dispose());
    assert.equal(clients[0].ended, false);
});
/** Open a query panel through openQueryViewWithLoad and record how its first query ends. */
async function openTrackedPanel(manager: TableWebViewManager, ref: { key: string; label: string }) {
    let view: any;
    const panel = await withPanel(async () => { view = await manager.openQueryViewWithLoad('SELECT 1 AS n', 'A', ref); });
    const outcome: { value?: any } = {};
    view.loaded.then((value: any) => { outcome.value = value; });
    return { panel, outcome };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test('openQueryViewWithLoad tells a script once the first query of the panel has run', async () => {
    const { dbSessions } = createSessionManager();
    const { manager } = createManager({ dbSessions });
    const ref = { key: 'file:file:///work/payroll.sql', label: 'payroll.sql' };
    dbSessions.acquire(ref, 'file');
    const { panel, outcome } = await openTrackedPanel(manager, ref);
    await nextTurn();
    assert.equal(outcome.value, undefined, 'nothing has run yet');

    await panel.state.onMessage(loadRows('SELECT 1 AS n'));
    await nextTurn();

    assert.deepEqual(outcome.value, { status: 'loaded' });
    assert.ok(panel.posted.some((m: any) => m.command === 'rowsLoaded'));
});

test('openQueryViewWithLoad reports a first query that failed', async (t) => {
    const original = vscodeStub.window.showErrorMessage;
    vscodeStub.window.showErrorMessage = () => Promise.resolve(undefined);
    t.after(() => { vscodeStub.window.showErrorMessage = original; });
    const { dbSessions } = createSessionManager(async () => { throw new Error('relation "x" does not exist'); });
    const { manager } = createManager({ dbSessions });
    const ref = { key: 'file:file:///work/payroll.sql', label: 'payroll.sql' };
    dbSessions.acquire(ref, 'file');
    const { panel, outcome } = await openTrackedPanel(manager, ref);

    await panel.state.onMessage(loadRows('SELECT 1 AS n'));
    await nextTurn();

    assert.deepEqual(outcome.value, { status: 'failed', error: 'relation "x" does not exist' });
});

test('openQueryViewWithLoad reports a panel closed before its first query ran', async () => {
    const { dbSessions } = createSessionManager();
    const { manager } = createManager({ dbSessions });
    const ref = { key: 'file:file:///work/payroll.sql', label: 'payroll.sql' };
    dbSessions.acquire(ref, 'file');
    const { panel, outcome } = await openTrackedPanel(manager, ref);

    panel.state.onDispose.forEach((dispose) => dispose());
    await nextTurn();

    assert.deepEqual(outcome.value, { status: 'closed' });
});

test('openQueryViewWithLoad places the panel as asked and reports the group it is in', async () => {
    const { dbSessions } = createSessionManager();
    const { manager } = createManager({ dbSessions });
    const ref = { key: 'file:file:///work/payroll.sql', label: 'payroll.sql' };
    dbSessions.acquire(ref, 'file');
    const panel: any = createFakePanel();
    const shownWith: any[] = [];
    const originalCreate = vscodeStub.window.createWebviewPanel;
    vscodeStub.window.createWebviewPanel = (...args: any[]) => { shownWith.push(args[2]); return panel; };
    let view: any;
    try {
        view = await manager.openQueryViewWithLoad('SELECT 1 AS n', 'A', ref, { viewColumn: 2, preserveFocus: true });
        await manager.openQueryViewWithLoad('SELECT 2 AS n', 'B', ref);
    } finally {
        vscodeStub.window.createWebviewPanel = originalCreate;
    }

    assert.deepEqual(shownWith, [
        { viewColumn: 2, preserveFocus: true },
        { viewColumn: vscodeStub.ViewColumn.Beside, preserveFocus: false }
    ]);
    panel.viewColumn = 2;
    assert.equal(view.viewColumn(), 2);
});

test('the session badge resets the session of the panel after asking', async (t) => {
    const { dbSessions, clients } = createSessionManager();
    const { manager } = createManager({ dbSessions });
    const panel = await withPanel(() => manager.openQueryView('SELECT 1 AS n', 'First'));
    await panel.state.onMessage(loadRows('SELECT 1 AS n'));
    const asked = stubWarningMessage(t, (items) => items.find((item) => item === 'Reset Session'));

    await panel.state.onMessage({ command: 'resetSession' });

    assert.equal(asked.length, 1);
    assert.equal(clients[0].ended, true);
    assert.equal(lastSessionInfo(panel).open, false);
});

test('a query cut off by closing its Data Viewer is not reported as an error', async (t) => {
    const errors: any[] = [];
    const original = vscodeStub.window.showErrorMessage;
    vscodeStub.window.showErrorMessage = (...args: any[]) => { errors.push(args); return Promise.resolve(undefined); };
    t.after(() => { vscodeStub.window.showErrorMessage = original; });
    let client: any;
    const { dbSessions } = createSessionManager(() => new Promise((_resolve, reject) => {
        client.once('ended', () => reject(new Error('Connection terminated')));
    }));
    const { manager } = createManager({ dbSessions });
    const panel = await withPanel(() => manager.openQueryView('SELECT pg_sleep(60)', 'Slow'));
    const session = dbSessions.get('tab:1');
    assert.ok(session, 'the panel holds a session of its own');
    await session.run(async (c: any) => { client = c; });

    const running = panel.state.onMessage(loadRows('SELECT pg_sleep(60)'));
    await new Promise((resolve) => setImmediate(resolve));
    panel.state.onDispose.forEach((dispose) => dispose());
    await running;

    assert.deepEqual(errors, []);
});

// ===== executable columns =====

/** A query panel whose executable values go to `runner`. */
async function openPanelWithRunner(runner: any) {
    const { manager } = createManager();
    manager.setExecutableValueRunner(runner);
    const panel = createFakePanel();
    const originalCreate = vscodeStub.window.createWebviewPanel;
    vscodeStub.window.createWebviewPanel = () => panel;
    try {
        await manager.openQueryView('SELECT 1 AS n', 'Locks');
    } finally {
        vscodeStub.window.createWebviewPanel = originalCreate;
    }
    return { panel, send: (m: any) => panel.state.onMessage(m) };
}

function recordingRunner(outcome: any = { status: 'executed', message: 'SELECT returned 1 row in 3 ms.' }) {
    return {
        calls: [] as any[],
        async run(type: any, value: string, target: any) {
            this.calls.push({ type, value, target });
            return outcome;
        }
    };
}

test('the run button of a cell runs its value as the column prefix says and reports the outcome to the panel', async () => {
    const runner = recordingRunner();
    const { panel, send } = await openPanelWithRunner(runner);

    await send({ command: 'runExecutableValue', column: 'pgsql_kill_command', value: 'SELECT pg_terminate_backend(42);' });

    assert.equal(runner.calls.length, 1);
    assert.equal(runner.calls[0].type.kind, 'statement');
    assert.equal(runner.calls[0].value, 'SELECT pg_terminate_backend(42);');
    assert.deepEqual(panel.posted.filter((m: any) => m.command === 'executableValueDone'), [{
        command: 'executableValueDone',
        column: 'pgsql_kill_command',
        value: 'SELECT pg_terminate_backend(42);',
        outcome: { status: 'executed', message: 'SELECT returned 1 row in 3 ms.' }
    }]);
});

test('a column without a prefix runs nothing, whatever the panel asks', async () => {
    const runner = recordingRunner();
    const { panel, send } = await openPanelWithRunner(runner);

    await send({ command: 'runExecutableValue', column: 'kill_command', value: 'DROP TABLE orders' });

    assert.equal(runner.calls.length, 0);
    assert.equal(panel.posted.some((m: any) => m.command === 'executableValueDone'), false);
});

test('Make Column Executable asks for the type and tells the panel the prefix, or null when cancelled', async (t) => {
    const picks: any[] = [];
    const answers = [(items: any[]) => items.find((i) => i.prefix === 'pgsql_'), () => undefined];
    const original = vscodeStub.window.showQuickPick;
    vscodeStub.window.showQuickPick = ((items: any, options: any) => {
        picks.push({ items, options });
        return Promise.resolve(answers.shift()!(items));
    }) as any;
    t.after(() => { vscodeStub.window.showQuickPick = original; });
    const { panel, send } = await openPanelWithRunner(recordingRunner());

    await send({ command: 'chooseExecutableType', column: 'kill_command' });
    await send({ command: 'chooseExecutableType', column: 'pgsql_kill_command' });

    assert.equal(picks[0].options.title, 'Make Column "kill_command" Executable');
    assert.equal(picks[0].items.some((i: any) => i.label === 'Not Executable'), false);
    assert.equal(picks[1].items[picks[1].items.length - 1].label, 'Not Executable');
    assert.deepEqual(panel.posted.filter((m: any) => m.command === 'executableTypeChosen'), [
        { command: 'executableTypeChosen', column: 'kill_command', prefix: 'pgsql_' },
        { command: 'executableTypeChosen', column: 'pgsql_kill_command', prefix: null }
    ]);
});

// ===== the Export tab of an -- @export … dialog instruction =====

const EXPORT_REQUEST = {
    title: 'Export: line 12 of payroll.sql',
    format: 'csv' as const,
    fileName: 'payroll_line12.csv',
    folder: 'C:\\work',
    options: { csvSeparator: ';' },
    sql: 'SELECT * FROM orders'
};

/** Open the Export tab for `request`, with the choice it will resolve to. */
function openExportTab(request: any = EXPORT_REQUEST) {
    const { manager } = createManager();
    const panel = createFakePanel();
    const originalCreate = vscodeStub.window.createWebviewPanel;
    vscodeStub.window.createWebviewPanel = () => panel;
    try {
        const choice = manager.openExportDialog(request);
        return { panel, choice, send: (m: any) => panel.state.onMessage(m) };
    } finally {
        vscodeStub.window.createWebviewPanel = originalCreate;
    }
}

test('the Export tab shows only the export dialog, prefilled from the instruction, and runs nothing', () => {
    const { panel } = openExportTab();

    const init = panel.posted.find((m: any) => m.command === 'init');
    assert.equal(init.title, 'Export: line 12 of payroll.sql');
    assert.deepEqual(init.exportOnly, { format: 'csv', fileName: 'payroll_line12.csv', folder: 'C:\\work', options: { csvSeparator: ';' } });
    assert.match(panel.webview.html, /id="exportDialogOverlay"/, 'the page of the Data Viewer, with its export dialog');
    assert.equal(panel.posted.some((m: any) => m.command === 'rowsLoaded'), false);
});

test('Export in the Export tab answers with the choice and closes the tab', async () => {
    const { panel, choice, send } = openExportTab();

    await send({ command: 'exportDialogResult', options: { format: 'csv', filename: 'orders.csv', saveLocation: 'C:\\exports', csvSeparator: '\t' } });

    assert.deepEqual(await choice, { settings: { format: 'csv', csvSeparator: '\t' }, fileName: 'orders.csv', folder: 'C:\\exports' });
    assert.equal(panel.disposed, 1);
});

test('Cancel in the Export tab, or closing it, chooses nothing', async () => {
    const cancelled = openExportTab();
    await cancelled.send({ command: 'exportDialogResult', options: null });
    assert.equal(await cancelled.choice, undefined);
    assert.equal(cancelled.panel.disposed, 1);

    const closed = openExportTab();
    closed.panel.dispose();
    assert.equal(await closed.choice, undefined);
});

test('an answer of an export dialog in an ordinary Data Viewer is ignored', async () => {
    const { send } = await openCustomQueryPanel();
    await send({ command: 'exportDialogResult', options: { format: 'csv' } });
});
