import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TableExplorerProvider } from '../tableExplorer';
import { scanSqlText } from '../repositoryScanner';

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

// ===== 4.0.0: reveal support and the comparison with the repository =====

function createProviderWithRepository(
    relationsBySchema: Record<string, Array<{ table_name: string; rel_kind: string }>>,
    files: Record<string, string> | null,
    extensionMembers: Array<{ member_kind: string; schema_name: string; name: string | null }> = []
): any {
    const connectionManager = {
        isConnected: () => true,
        getActiveConnectionConfig: () => ({ schemas: undefined }),
        clearMetadataCache: () => {},
        queryMetadata: async (sql: string, params?: any[]) => {
            if (sql.includes('current_schemas')) return [{ schema_name: 'public' }];
            if (sql.includes('pg_depend')) return extensionMembers;
            if (sql.includes('information_schema.schemata')) {
                return Object.keys(relationsBySchema).map(s => ({ schema_name: s }));
            }
            if (sql.includes('SELECT table_schema, table_name, rel_kind')) {
                return Object.entries(relationsBySchema).flatMap(([schema, rels]) => rels.map(r => ({ table_schema: schema, ...r })));
            }
            return relationsBySchema[params?.[0]] ?? [];
        }
    };
    const provider = new TableExplorerProvider(connectionManager as any);
    if (files) {
        const definitions = Object.entries(files).flatMap(([uri, sql]) => scanSqlText(sql).map(d => ({ ...d, uri })));
        provider.setRepository({ snapshot: () => ({ version: 1, definitions }), ensureScanned: () => {} });
    }
    return provider;
}

const SALES = { sales: [{ table_name: 'orders', rel_kind: 'table' }, { table_name: 'legacy', rel_kind: 'table' }] };
const SALES_REPO = {
    'schema.sql': `CREATE SCHEMA sales;
                   CREATE TABLE sales.orders (id int);
                   CREATE VIEW sales.order_totals AS SELECT 1;
                   CREATE TABLE archive.old_orders (id int);`
};

test('every node has a stable id and getParent leads back to its schema', () => {
    const p = createProvider();
    const table = { type: 'table', schema: 'public', table: 'users', kind: 'view' };
    assert.equal(p.getTreeItem(table).id, 'tables/table/public/view/users');
    const category = p.getParent(table);
    assert.deepEqual(category, { type: 'category', schema: 'public', kind: 'view' });
    assert.deepEqual(p.getParent(category), { type: 'schema', schema: 'public' });
    assert.equal(p.getParent({ type: 'schema', schema: 'public' }), undefined);
});

test('without a repository to compare with, no relation is marked', async () => {
    const p = createProviderWithRepository(SALES, null);
    const tables = await p.getChildren({ type: 'category', schema: 'sales', kind: 'table' });
    assert.ok(tables.every((t: any) => t.status === undefined && p.getTreeItem(t).resourceUri === undefined));
    assert.equal(await p.definitionsFor(tables[0]), null);
});

test('a relation missing in the repository is marked, one defined there is not', async () => {
    const p = createProviderWithRepository(SALES, SALES_REPO);
    const tables = await p.getChildren({ type: 'category', schema: 'sales', kind: 'table' });
    const byName = new Map<string, any>(tables.map((t: any) => [t.table, t]));
    assert.equal(byName.get('orders').status, 'both');
    assert.equal(p.getTreeItem(byName.get('orders')).resourceUri, undefined);
    assert.equal(byName.get('legacy').status, 'dbOnly');
    assert.match(String(p.getTreeItem(byName.get('legacy')).resourceUri), /\?dbOnly$/);
    assert.match(String(p.getTreeItem(byName.get('legacy')).tooltip), /Not found in the repository\.$/);
});

test('relations and schemas that exist only in the repository are listed', async () => {
    const p = createProviderWithRepository(SALES, SALES_REPO);
    const schemas = await p.getChildren();
    assert.deepEqual(schemas.map((s: any) => [s.schema, s.status]), [['archive', 'repoOnly'], ['sales', 'both']]);
    const categories = await p.getChildren({ type: 'schema', schema: 'sales' });
    assert.deepEqual(categories.map((c: any) => c.kind), ['table', 'view']);
    const [view] = await p.getChildren({ type: 'category', schema: 'sales', kind: 'view' });
    const item = p.getTreeItem(view);
    assert.equal(item.contextValue, 'table.repoOnly');
    assert.equal(item.description, 'only in repository');
    assert.equal(item.command.command, 'postgresQueryBuilder.goToRepositoryDefinition', 'nothing to open in the Data Viewer');
    assert.match(String(item.resourceUri), /\?repoOnly$/);
});

test('allRelationNodes lists every relation of the database and of the repository, ignoring the filter', async () => {
    const p = createProviderWithRepository(SALES, SALES_REPO);
    p.setFilter('nothing-matches');
    const all = await p.allRelationNodes();
    assert.deepEqual(all.map((r: any) => `${r.schema}.${r.table}:${r.status}`).sort(), [
        'archive.old_orders:repoOnly', 'sales.legacy:dbOnly', 'sales.order_totals:repoOnly', 'sales.orders:both'
    ]);
    assert.equal(p.isFilteredOut(all[0]), true);
    p.setFilter('');
    assert.equal(p.isFilteredOut(all[0]), false);
});

test('what an extension or PostgreSQL itself provides is never marked', async () => {
    const p = createProviderWithRepository(
        { oracle: [{ table_name: 'dual', rel_kind: 'view' }], pg_temp_56: [], sales: [{ table_name: 'stats', rel_kind: 'view' }] },
        SALES_REPO,
        [{ member_kind: 'schema', schema_name: 'oracle', name: null }, { member_kind: 'relation', schema_name: 'sales', name: 'stats' }]
    );
    // pg_temp_56 holds no relation; Show Empty Schemas lists it, unmarked.
    await p.setShowEmptySchemas(true);
    const schemas = await p.getChildren();
    assert.deepEqual(schemas.filter((s: any) => s.schema !== 'archive').map((s: any) => [s.schema, s.status]),
        [['oracle', undefined], ['pg_temp_56', undefined], ['sales', 'both']]);
    const [dual] = await p.getChildren({ type: 'category', schema: 'oracle', kind: 'view' });
    assert.equal(dual.status, undefined);
    const views = await p.getChildren({ type: 'category', schema: 'sales', kind: 'view' });
    assert.equal(views.find((v: any) => v.table === 'stats').status, undefined, 'a view of an extension is not marked');
});

// ===== Show Empty Schemas =====

function toggleState(initial: Record<string, unknown> = {}) {
    const stored = new Map<string, unknown>(Object.entries(initial));
    return { stored, get: <T>(key: string, d: T): T => (stored.has(key) ? stored.get(key) as T : d), update: async (key: string, v: unknown) => { stored.set(key, v); } };
}

test('schemas without relations are hidden until Show Empty Schemas is on, and the choice is kept', async () => {
    const p = createProviderWithRepository({ empty: [], sales: [{ table_name: 'orders', rel_kind: 'table' }] }, null);
    const state = toggleState();
    p.setState(state);
    assert.deepEqual((await p.getChildren()).map((s: any) => s.schema), ['sales']);
    assert.equal(await p.isEmptySchema('empty'), true);
    await p.setShowEmptySchemas(true);
    assert.deepEqual((await p.getChildren()).map((s: any) => s.schema), ['empty', 'sales']);
    assert.equal(state.stored.get('postgresQueryBuilder.tables.showEmptySchemas'), true);
    const restored = createProviderWithRepository({ empty: [] }, null);
    restored.setState(state);
    assert.equal(restored.showsEmptySchemas, true);
});

test('a schema only the repository creates stays visible, as a difference, with Show Empty Schemas off', async () => {
    const p = createProviderWithRepository({ sales: [{ table_name: 'orders', rel_kind: 'table' }] }, { 'a.sql': 'CREATE SCHEMA planned;' });
    p.setState(toggleState());
    const roots = await p.getChildren();
    assert.deepEqual(roots.map((s: any) => [s.schema, s.status]), [['planned', 'repoOnly'], ['sales', 'dbOnly']]);
});

test('the Search filter shows matching schemas with relations only, whatever Show Empty Schemas says', async () => {
    const p = createProviderWithRepository({ sales_empty: [], sales: [{ table_name: 'orders', rel_kind: 'table' }] }, null);
    p.setState(toggleState({ 'postgresQueryBuilder.tables.showEmptySchemas': true }));
    p.setFilter('orders');
    assert.deepEqual((await p.getChildren()).map((s: any) => s.schema), ['sales']);
});
