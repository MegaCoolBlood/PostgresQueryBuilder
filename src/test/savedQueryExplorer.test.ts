import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SavedQueryExplorerProvider,
    describeSavedQuery,
    describeParameters,
    savedQueryContextValue,
    childTagFolders,
    queriesInTagFolder,
    countInTagFolder,
    untaggedQueries,
    tagFolderLabel,
    UNTAGGED_LABEL
} from '../savedQueryExplorer';
import { SavedQuery, SavedQueryStore } from '../savedQueryStore';
import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function makeQuery(over: Partial<SavedQuery> = {}): SavedQuery {
    return {
        id: over.id || 'q1',
        name: over.name || 'Query',
        sql: over.sql || 'SELECT 1',
        parameters: over.parameters || [],
        scope: over.scope,
        schema: over.schema,
        table: over.table,
        lastUsed: over.lastUsed,
        tags: over.tags
    };
}

/** Minimal stand-in for the store: the explorer only reads getAll/onDidChange. */
function createFakeStore(queries: SavedQuery[]) {
    const emitter = new vscode.EventEmitter<void>();
    const store = {
        getAll: () => queries,
        onDidChange: emitter.event
    } as unknown as SavedQueryStore;
    return { store, fire: () => emitter.fire() };
}

// ===== describeSavedQuery / describeParameters =====

test('describeSavedQuery collapses whitespace to a single line', () => {
    assert.equal(
        describeSavedQuery(makeQuery({ sql: 'SELECT *\n  FROM t\n WHERE a = 1' })),
        'SELECT * FROM t WHERE a = 1'
    );
});

test('describeSavedQuery truncates a very long statement', () => {
    const described = describeSavedQuery(makeQuery({ sql: 'SELECT ' + 'x'.repeat(500) }));
    assert.equal(described.length, 201);
    assert.ok(described.endsWith('…'));
});

test('describeParameters lists the placeholders', () => {
    assert.equal(
        describeParameters(makeQuery({ parameters: [{ name: 'from', kind: 'text' }, { name: 'to', kind: 'text' }] })),
        ':from, :to'
    );
});

test('describeParameters is empty without placeholders', () => {
    assert.equal(describeParameters(makeQuery()), '');
});

// ===== savedQueryContextValue =====

test('savedQueryContextValue reflects the scope', () => {
    assert.equal(savedQueryContextValue(makeQuery({ scope: 'workspace' })), 'savedQuery.workspace');
    assert.equal(savedQueryContextValue(makeQuery({ scope: 'global' })), 'savedQuery.global');
});

test('savedQueryContextValue treats a query without scope as personal', () => {
    assert.equal(savedQueryContextValue(makeQuery({ scope: undefined })), 'savedQuery.global');
});

// ===== getChildren: tag folders (3.3.0) =====

test('getChildren lists the tag folders, then "Untagged" for queries without a tag', () => {
    const { store } = createFakeStore([
        makeQuery({ id: 'a', tags: ['Sales'] }),
        makeQuery({ id: 'b', tags: ['Finance', 'Sales'] }),
        makeQuery({ id: 'c' })
    ]);
    assert.deepEqual(new SavedQueryExplorerProvider(store).getChildren(), [
        { type: 'tag', path: 'Finance' },
        { type: 'tag', path: 'Sales' },
        { type: 'untagged' }
    ]);
});

test('getChildren omits "Untagged" when every query carries a tag', () => {
    const { store } = createFakeStore([makeQuery({ id: 'a', tags: ['Sales'] })]);
    assert.deepEqual(new SavedQueryExplorerProvider(store).getChildren(), [{ type: 'tag', path: 'Sales' }]);
});

test('getChildren shows only "Untagged" while no query is tagged', () => {
    const { store } = createFakeStore([makeQuery({ id: 'a' }), makeQuery({ id: 'b' })]);
    const provider = new SavedQueryExplorerProvider(store);
    assert.deepEqual(provider.getChildren(), [{ type: 'untagged' }]);
    assert.equal(
        provider.getTreeItem({ type: 'untagged' }).collapsibleState,
        vscode.TreeItemCollapsibleState.Expanded,
        'the only folder starts open'
    );
});

test('a query with several tags appears in each of their folders', () => {
    const { store } = createFakeStore([
        makeQuery({ id: 'a', name: 'Orders', tags: ['Sales', 'Daily'] }),
        makeQuery({ id: 'b', name: 'Invoices', tags: ['Sales'] })
    ]);
    const provider = new SavedQueryExplorerProvider(store);
    const ids = (path: string) => provider.getChildren({ type: 'tag', path })
        .map(n => n.type === 'query' ? n.query.id : n.type);
    assert.deepEqual(ids('Sales'), ['b', 'a'], 'sorted by name');
    assert.deepEqual(ids('Daily'), ['a']);
});

test('the "Untagged" folder lists the queries without a tag', () => {
    const { store } = createFakeStore([makeQuery({ id: 'a', tags: ['Sales'] }), makeQuery({ id: 'b' })]);
    const nodes = new SavedQueryExplorerProvider(store).getChildren({ type: 'untagged' });
    assert.deepEqual(nodes.map(n => n.type === 'query' && n.query.id), ['b']);
    assert.equal(nodes[0].type === 'query' && nodes[0].parent, '');
});

test('a slash in a tag nests folders, and a folder lists its subfolders before its queries', () => {
    const { store } = createFakeStore([
        makeQuery({ id: 'm', tags: ['Reports/Monthly'] }),
        makeQuery({ id: 'r', tags: ['Reports'] }),
        makeQuery({ id: 'y', tags: ['Reports/Yearly/Q1'] })
    ]);
    const provider = new SavedQueryExplorerProvider(store);
    assert.deepEqual(provider.getChildren(), [{ type: 'tag', path: 'Reports' }]);
    const inReports = provider.getChildren({ type: 'tag', path: 'Reports' });
    assert.deepEqual(inReports.map(n => n.type === 'tag' ? n.path : n.type === 'query' ? n.query.id : n.type),
        ['Reports/Monthly', 'Reports/Yearly', 'r']);
    assert.deepEqual(provider.getChildren({ type: 'tag', path: 'Reports/Yearly' }), [{ type: 'tag', path: 'Reports/Yearly/Q1' }]);
});

test('tag folders match case-insensitively and keep the first spelling', () => {
    const queries = [makeQuery({ id: 'a', tags: ['Sales'] }), makeQuery({ id: 'b', tags: ['sales'] })];
    assert.deepEqual(childTagFolders(queries, ''), ['Sales']);
    assert.deepEqual(queriesInTagFolder(queries, 'SALES').map(q => q.id), ['a', 'b']);
});

test('countInTagFolder counts the queries of a folder and its subfolders once each', () => {
    const queries = [
        makeQuery({ id: 'a', tags: ['Reports', 'Reports/Monthly'] }),
        makeQuery({ id: 'b', tags: ['Reports/Monthly'] }),
        makeQuery({ id: 'c', tags: ['ReportsOld'] })
    ];
    assert.equal(countInTagFolder(queries, 'Reports'), 2);
    assert.equal(countInTagFolder(queries, 'Reports/Monthly'), 2);
    assert.equal(untaggedQueries(queries).length, 0);
});

test('getTreeItem labels a nested tag folder with its last level and the query count', () => {
    const { store } = createFakeStore([makeQuery({ id: 'a', tags: ['Reports/Monthly'] })]);
    const item = new SavedQueryExplorerProvider(store).getTreeItem({ type: 'tag', path: 'Reports/Monthly' });
    assert.equal(item.label, 'Monthly');
    assert.equal(tagFolderLabel('Reports/Monthly'), 'Monthly');
    assert.equal(item.description, '1');
    assert.equal(item.contextValue, 'savedQueryTag');
    assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
});

test('the scope is named next to a query only while both scopes are in use', () => {
    const mixed = createFakeStore([
        makeQuery({ id: 'a', scope: 'workspace', parameters: [{ name: 'day', kind: 'text' }] }),
        makeQuery({ id: 'b', scope: 'global' })
    ]);
    const provider = new SavedQueryExplorerProvider(mixed.store);
    const [a, b] = provider.getChildren({ type: 'untagged' });
    assert.equal(provider.getTreeItem(a).description, 'Workspace · :day');
    assert.equal(provider.getTreeItem(b).description, 'Personal');

    const single = createFakeStore([makeQuery({ id: 'a', scope: 'global' })]);
    const only = new SavedQueryExplorerProvider(single.store);
    assert.equal(only.getTreeItem(only.getChildren({ type: 'untagged' })[0]).description, '');
});

test('getChildren of a query node has no children', () => {
    const { store } = createFakeStore([makeQuery()]);
    const provider = new SavedQueryExplorerProvider(store);
    assert.deepEqual(provider.getChildren({ type: 'query', query: makeQuery() }), []);
});

test('getChildren returns nothing when no query is stored', () => {
    const { store } = createFakeStore([]);
    assert.deepEqual(new SavedQueryExplorerProvider(store).getChildren(), []);
});

// ===== getTreeItem =====

test('getTreeItem wires a query to the double-click open command', () => {
    const { store } = createFakeStore([]);
    const query = makeQuery({ id: 'x1', name: 'Orders', parameters: [{ name: 'from', kind: 'text' }] });
    const item = new SavedQueryExplorerProvider(store).getTreeItem({ type: 'query', query });
    assert.equal(item.label, 'Orders');
    assert.equal(item.contextValue, 'savedQuery.global');
    assert.equal(item.description, ':from');
    assert.equal(item.command?.command, 'postgresQueryBuilder.openSavedQuery');
    assert.deepEqual(item.command?.arguments, ['x1']);
});

test('getTreeItem marks a workspace query so only its move stays available', () => {
    const { store } = createFakeStore([]);
    const item = new SavedQueryExplorerProvider(store).getTreeItem({
        type: 'query',
        query: makeQuery({ scope: 'workspace' })
    });
    assert.equal(item.contextValue, 'savedQuery.workspace');
});

test('getTreeItem names the scope and the tags in the tooltip', () => {
    const { store } = createFakeStore([]);
    const provider = new SavedQueryExplorerProvider(store);
    assert.equal(
        provider.getTreeItem({ type: 'query', query: makeQuery({ scope: 'workspace', sql: 'SELECT 1' }) }).tooltip,
        'Workspace\nSELECT 1'
    );
    assert.equal(
        provider.getTreeItem({ type: 'query', query: makeQuery({ sql: 'SELECT 1', tags: ['A', 'B/C'] }) }).tooltip,
        'Personal\nTags: A, B/C\nSELECT 1'
    );
});

test('getTreeItem marks the "Untagged" folder for its own context', () => {
    const { store } = createFakeStore([makeQuery({ id: 'a', tags: ['X'] }), makeQuery({ id: 'b' })]);
    const item = new SavedQueryExplorerProvider(store).getTreeItem({ type: 'untagged' });
    assert.equal(item.label, UNTAGGED_LABEL);
    assert.equal(item.contextValue, 'savedQueryUntagged');
    assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
});

// ===== change propagation =====

test('a store change refreshes the tree', () => {
    const { store, fire } = createFakeStore([]);
    const provider = new SavedQueryExplorerProvider(store);
    let fired = 0;
    provider.onDidChangeTreeData(() => { fired++; });
    fire();
    assert.equal(fired, 1);
});

// ===== menu contract =====

test('the move commands are bound to the opposite scope in package.json', () => {
    const pkg = JSON.parse(
        readFileSync(join(__dirname, '../../../package.json'), 'utf8')
    );
    const items: any[] = pkg.contributes.menus['view/item/context'];
    const whenOf = (command: string) => items.find(i => i.command === command)?.when;
    assert.match(whenOf('postgresQueryBuilder.moveSavedQueryToWorkspace'), /viewItem == savedQuery\.global/);
    assert.match(whenOf('postgresQueryBuilder.moveSavedQueryToGlobal'), /viewItem == savedQuery\.workspace/);
    for (const command of ['runSavedQuery', 'editSavedQuery', 'renameSavedQuery', 'deleteSavedQuery']) {
        assert.match(whenOf(`postgresQueryBuilder.${command}`), /savedQuery\\\./, command);
    }
});

test('the context menu edits a bookmark, tags included, through the bookmark dialog', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8'));
    const command = pkg.contributes.commands.find((c: { command: string }) => c.command === 'postgresQueryBuilder.editSavedQuery');
    assert.equal(command?.title, 'Edit Bookmarked Query...');
    const items: Array<{ command: string; group: string }> = pkg.contributes.menus['view/item/context'];
    assert.equal(items.find(i => i.command === 'postgresQueryBuilder.editSavedQuery')?.group, '1_modify@0', 'listed first');
    assert.ok(
        !JSON.stringify(pkg.contributes).includes('editSavedQueryTags'),
        'tags must not get a context menu entry of their own'
    );
    const source = readFileSync(join(__dirname, '../../../src/extension.ts'), 'utf8');
    assert.match(
        source,
        /registerCommand\('postgresQueryBuilder\.editSavedQuery',[\s\S]{0,200}?ManageBookmarksPanel\.show\(savedQueryStore, \{ id: query\.id \}\)/
    );
});
