import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SavedQueryExplorerProvider,
    describeSavedQuery,
    describeParameters,
    SavedQueryTreeNode
} from '../savedQueryExplorer';
import { SavedQuery, SavedQueryStore } from '../savedQueryStore';
import * as vscode from 'vscode';

function makeQuery(over: Partial<SavedQuery> = {}): SavedQuery {
    return {
        id: over.id || 'q1',
        name: over.name || 'Query',
        sql: over.sql || 'SELECT 1',
        parameters: over.parameters || [],
        scope: over.scope,
        schema: over.schema,
        table: over.table,
        lastUsed: over.lastUsed
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

// ===== getChildren =====

test('getChildren returns a flat list when only one scope is used', () => {
    const { store } = createFakeStore([
        makeQuery({ id: 'a', scope: 'global' }),
        makeQuery({ id: 'b', scope: 'global' })
    ]);
    const nodes = new SavedQueryExplorerProvider(store).getChildren();
    assert.deepEqual(nodes.map(n => n.type), ['query', 'query']);
});

test('getChildren groups by scope when both scopes are used', () => {
    const { store } = createFakeStore([
        makeQuery({ id: 'a', scope: 'workspace' }),
        makeQuery({ id: 'b', scope: 'global' })
    ]);
    const nodes = new SavedQueryExplorerProvider(store).getChildren() as SavedQueryTreeNode[];
    assert.deepEqual(nodes, [
        { type: 'group', scope: 'workspace' },
        { type: 'group', scope: 'global' }
    ]);
});

test('getChildren of a group returns only that scope', () => {
    const { store } = createFakeStore([
        makeQuery({ id: 'a', scope: 'workspace' }),
        makeQuery({ id: 'b', scope: 'global' })
    ]);
    const provider = new SavedQueryExplorerProvider(store);
    const nodes = provider.getChildren({ type: 'group', scope: 'global' });
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].type === 'query' && nodes[0].query.id, 'b');
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

test('getTreeItem wires a query to the run command', () => {
    const { store } = createFakeStore([]);
    const query = makeQuery({ id: 'x1', name: 'Orders', parameters: [{ name: 'from', kind: 'text' }] });
    const item = new SavedQueryExplorerProvider(store).getTreeItem({ type: 'query', query });
    assert.equal(item.label, 'Orders');
    assert.equal(item.contextValue, 'savedQuery');
    assert.equal(item.description, ':from');
    assert.equal(item.command?.command, 'postgresQueryBuilder.runSavedQuery');
    assert.deepEqual(item.command?.arguments, ['x1']);
});

test('getTreeItem marks a group with its scope', () => {
    const { store } = createFakeStore([]);
    const provider = new SavedQueryExplorerProvider(store);
    assert.equal(
        provider.getTreeItem({ type: 'group', scope: 'workspace' }).contextValue,
        'savedQueryGroup:workspace'
    );
    assert.equal(provider.getTreeItem({ type: 'group', scope: 'global' }).label, 'Personal');
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
