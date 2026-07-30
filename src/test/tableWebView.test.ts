import './helpers/vscodeMock';
import { vscodeStub } from './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { buildCustomResultColumns, buildColumnProbeSql, TableWebViewManager } from '../tableWebView';

test('buildCustomResultColumns resolves type names and column comments', () => {
    const fields = [
        { name: 'id', dataTypeID: 23, tableID: 100, columnID: 1 },
        { name: 'name', dataTypeID: 25, tableID: 100, columnID: 2 }
    ];
    const typeMap = { 23: 'int4', 25: 'text' };
    const commentMap = { '100:1': 'Primary key', '100:2': 'Display name' };

    assert.deepEqual(buildCustomResultColumns(fields, typeMap, commentMap), [
        { name: 'id', dataType: 'int4', isNullable: true, columnDefault: null, comment: 'Primary key' },
        { name: 'name', dataType: 'text', isNullable: true, columnDefault: null, comment: 'Display name' }
    ]);
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
    const context: any = {
        subscriptions: [],
        extensionPath: EXTENSION_PATH,
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
        queryMetadata: async () => []
    };
    const columnMappingManager: any = {
        onDidChange: () => ({ dispose() {} }),
        getMappingsForTable: () => []
    };
    const permanentConstraintManager: any = { getConstraints: () => [] };
    const manager = new TableWebViewManager(context, connectionManager, columnMappingManager, permanentConstraintManager);
    return { manager, globalStateStore };
}

/** Open a custom-query panel and return it together with its message callback. */
function openCustomQueryPanel() {
    const { manager, globalStateStore } = createManager();
    const panel = createFakePanel();
    const originalCreate = vscodeStub.window.createWebviewPanel;
    vscodeStub.window.createWebviewPanel = () => panel;
    try {
        manager.openCustomQueryView('SELECT 1 AS n', 'Custom');
    } finally {
        vscodeStub.window.createWebviewPanel = originalCreate;
    }
    return { panel, send: (m: any) => panel.state.onMessage(m), globalStateStore };
}

test('custom-query panel: Browse opens the folder dialog and reports the choice', async () => {
    const { panel, send } = openCustomQueryPanel();
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

test('custom-query panel: cancelling the folder dialog posts nothing', async () => {
    const { panel, send } = openCustomQueryPanel();
    const originalOpen = vscodeStub.window.showOpenDialog;
    vscodeStub.window.showOpenDialog = () => Promise.resolve(undefined);
    try {
        await send({ command: 'browseExportLocation' });
    } finally {
        vscodeStub.window.showOpenDialog = originalOpen;
    }
    assert.equal(panel.posted.some(m => m.command === 'exportLocationSelected'), false);
});

test('custom-query panel: export defaults can be loaded and saved', async () => {
    const { panel, send, globalStateStore } = openCustomQueryPanel();

    await send({ command: 'saveExportDefaults', format: 'csv', options: { csvSeparator: ';' }, saveLocation: 'C:\\exports' });
    assert.deepEqual(globalStateStore['exportDefaults'], { csv: { csvSeparator: ';' } });
    assert.equal(globalStateStore['exportSaveLocation'], 'C:\\exports');

    await send({ command: 'getExportDefaults' });
    const msg = panel.posted.find(m => m.command === 'exportDefaultsLoaded');
    assert.ok(msg, 'expected exportDefaultsLoaded to be posted back to the webview');
    assert.equal(msg.defaults.csv.csvSeparator, ';');
    assert.equal(msg.defaults._saveLocation, 'C:\\exports');
});

test('custom-query panel: exporting opens the save dialog in the saved location', async () => {
    const { send } = openCustomQueryPanel();
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

test('custom-query panel: commands it does not share stay unhandled', async () => {
    const { panel, send } = openCustomQueryPanel();
    await send({ command: 'commitChanges', changes: [] });
    assert.equal(panel.posted.some(m => m.command === 'commitSuccess'), false);
});

test('custom-query panel: init carries the alwaysQuote setting', () => {
    const originalGetConfig = vscodeStub.workspace.getConfiguration;
    vscodeStub.workspace.getConfiguration = (_section?: string) => ({
        get<T>(key: string, defaultValue?: T): T {
            return (key === 'alwaysQuote' ? true : defaultValue) as T;
        }
    });
    let panel;
    try {
        ({ panel } = openCustomQueryPanel());
    } finally {
        vscodeStub.workspace.getConfiguration = originalGetConfig;
    }

    const init = panel.posted.find(m => m.command === 'init');
    assert.ok(init, 'expected an init message');
    assert.equal(init.alwaysQuote, true);
    assert.equal(init.customQuery, 'SELECT 1 AS n');
});
