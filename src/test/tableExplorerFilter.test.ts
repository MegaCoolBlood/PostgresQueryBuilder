import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TableExplorerProvider } from '../tableExplorer';

function createProvider(): any {
    // The provider only needs a connection manager reference for construction;
    // the filter/highlight helpers under test do not touch it.
    return new TableExplorerProvider({} as any);
}

// ===== 0.2.1: multi-term search scoring =====

test('scoreString returns 0 when no filter is set', () => {
    const p = createProvider();
    assert.equal(p.scoreString('public.users'), 0);
});

test('scoreString counts a single matching term', () => {
    const p = createProvider();
    p.setFilter('user');
    assert.equal(p.scoreString('public.users'), 1);
    assert.equal(p.scoreString('public.orders'), 0);
});

test('scoreString counts each space-separated term independently', () => {
    const p = createProvider();
    p.setFilter('pub user');
    assert.equal(p.scoreString('public.users'), 2);
    assert.equal(p.scoreString('public.orders'), 1); // only "pub" matches
});

test('scoreString is case-insensitive', () => {
    const p = createProvider();
    p.setFilter('USER');
    assert.equal(p.scoreString('public.Users'), 1);
});

test('setFilter ignores extra whitespace between terms', () => {
    const p = createProvider();
    p.setFilter('  pub    user  ');
    assert.equal(p.scoreString('public.users'), 2);
});

// ===== 0.2.1: highlight ranges =====

test('computeHighlights returns [] with no filter', () => {
    const p = createProvider();
    assert.deepEqual(p.computeHighlights('users'), []);
});

test('computeHighlights marks a single term occurrence', () => {
    const p = createProvider();
    p.setFilter('user');
    assert.deepEqual(p.computeHighlights('users'), [[0, 4]]);
});

test('computeHighlights marks every occurrence of a term', () => {
    const p = createProvider();
    p.setFilter('a');
    assert.deepEqual(p.computeHighlights('banana'), [[1, 2], [3, 4], [5, 6]]);
});

test('computeHighlights merges adjacent ranges from different terms', () => {
    const p = createProvider();
    p.setFilter('ab cd');
    // "ab" -> [1,3], "cd" -> [3,5] : adjacent ranges collapse into one
    assert.deepEqual(p.computeHighlights('xabcdy'), [[1, 5]]);
});

test('computeHighlights merges overlapping ranges from different terms', () => {
    const p = createProvider();
    p.setFilter('ana nan');
    // "ana" -> [1,4], "nan" -> [2,5] : overlap merges into [1,5]
    assert.deepEqual(p.computeHighlights('banana'), [[1, 5]]);
});

test('computeHighlights returns [] when terms do not match', () => {
    const p = createProvider();
    p.setFilter('xyz');
    assert.deepEqual(p.computeHighlights('public.users'), []);
});

// ===== 1.1.2: relations grouped into category nodes under a schema =====

function createProviderWithRelations(relationsBySchema: Record<string, Array<{ table_name: string; rel_kind: string }>>): any {
    const connectionManager = {
        isConnected: () => true,
        getActiveConnectionConfig: () => ({ schemas: undefined }),
        clearMetadataCache: () => {},
        queryMetadata: async (sql: string, params?: any[]) => {
            if (sql.includes('information_schema.schemata')) {
                return Object.keys(relationsBySchema).map(s => ({ schema_name: s }));
            }
            // Schema relation query, bound to $1 = schema name.
            const schema = params?.[0];
            return relationsBySchema[schema] ?? [];
        }
    };
    return new TableExplorerProvider(connectionManager as any);
}

test('schema children are category nodes only for kinds that are present, in fixed order', async () => {
    const p = createProviderWithRelations({
        public: [
            { table_name: 'users', rel_kind: 'table' },
            { table_name: 'active_users', rel_kind: 'view' },
            { table_name: 'remote_orders', rel_kind: 'foreign' }
        ]
    });

    const categories = await p.getChildren({ type: 'schema', schema: 'public' });
    assert.deepEqual(
        categories.map((c: any) => ({ type: c.type, schema: c.schema, kind: c.kind })),
        [
            { type: 'category', schema: 'public', kind: 'table' },
            { type: 'category', schema: 'public', kind: 'view' },
            { type: 'category', schema: 'public', kind: 'foreign' }
        ]
    );
});

test('materialized views appear as their own category', async () => {
    const p = createProviderWithRelations({
        reporting: [
            { table_name: 'orders', rel_kind: 'table' },
            { table_name: 'daily_sales', rel_kind: 'matview' }
        ]
    });

    const categories = await p.getChildren({ type: 'schema', schema: 'reporting' });
    assert.deepEqual(categories.map((c: any) => c.kind), ['table', 'matview']);
});

test('category children are the relations of that kind as leaf table nodes', async () => {
    const p = createProviderWithRelations({
        public: [
            { table_name: 'users', rel_kind: 'table' },
            { table_name: 'orders', rel_kind: 'table' },
            { table_name: 'active_users', rel_kind: 'view' }
        ]
    });

    const tables = await p.getChildren({ type: 'category', schema: 'public', kind: 'table' });
    assert.deepEqual(
        tables.map((t: any) => ({ type: t.type, table: t.table, kind: t.kind })),
        [
            { type: 'table', table: 'users', kind: 'table' },
            { type: 'table', table: 'orders', kind: 'table' }
        ]
    );

    const views = await p.getChildren({ type: 'category', schema: 'public', kind: 'view' });
    assert.deepEqual(views.map((t: any) => t.table), ['active_users']);
});

test('a filter keeps only categories that contain a matching relation', async () => {
    const p = createProviderWithRelations({
        public: [
            { table_name: 'users', rel_kind: 'table' },
            { table_name: 'active_users', rel_kind: 'view' },
            { table_name: 'remote_orders', rel_kind: 'foreign' }
        ]
    });
    p.setFilter('user');

    const categories = await p.getChildren({ type: 'schema', schema: 'public' });
    // Only "users" (table) and "active_users" (view) match -> no foreign category.
    assert.deepEqual(categories.map((c: any) => c.kind), ['table', 'view']);

    const foreign = await p.getChildren({ type: 'category', schema: 'public', kind: 'foreign' });
    assert.deepEqual(foreign, []);
});

test('getTreeItem marks schema and category nodes as expanded', () => {
    const p = createProvider();
    const schemaItem = p.getTreeItem({ type: 'schema', schema: 'public' });
    const categoryItem = p.getTreeItem({ type: 'category', schema: 'public', kind: 'view' });
    // 2 === TreeItemCollapsibleState.Expanded in the vscode mock.
    assert.equal(schemaItem.collapsibleState, 2);
    assert.equal(categoryItem.collapsibleState, 2);
    assert.equal(categoryItem.label, 'Views');
});
