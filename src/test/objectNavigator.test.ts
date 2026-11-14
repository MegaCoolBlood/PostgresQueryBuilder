import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    NAVIGATOR_KINDS,
    ObjectNavigatorProvider,
    buildObjectCatalogQuery,
    type NavigatorNode,
    type NavigatorSettings,
    type ObjectNode
} from '../objectNavigator';
import { scanSqlText } from '../repositoryScanner';
import type { LocatedDefinition, RepositorySnapshot } from '../repositoryComparison';

type Row = Record<string, unknown>;

function dbRow(kind: string, schema: string, name: string, extra: Partial<Row> = {}): Row {
    return {
        kind, oid: Math.floor(Math.random() * 1e9), schema_name: schema, name,
        args: null, arg_types: null, detail: null, rel_schema: null, rel_name: null, rel_column: null,
        owner: 'owner', language: null, comment: null, from_extension: false, ...extra
    };
}

const CATALOG: Row[] = [
    dbRow('function', 'app', 'add_tax', { args: 'amount numeric', arg_types: ['numeric'], detail: 'numeric', language: 'sql' }),
    dbRow('function', 'app', 'add_tax', { args: 'amount numeric, rate numeric', arg_types: ['numeric', 'numeric'], detail: 'numeric', language: 'sql' }),
    dbRow('procedure', 'app', 'close_month', { args: 'p_month date', arg_types: ['date'] }),
    dbRow('type', 'app', 'mood', { detail: 'enum' }),
    dbRow('sequence', 'app', 'orders_id_seq', { detail: 'integer', rel_schema: 'app', rel_name: 'orders', rel_column: 'id' }),
    dbRow('trigger', 'app', 'orders_audit', { rel_schema: 'app', rel_name: 'orders' }),
    dbRow('domain', 'billing', 'amount', { detail: 'numeric(12,2)' }),
    dbRow('function', 'public', 'st_x', { args: 'geometry', arg_types: ['geometry'], detail: 'double precision', from_extension: true }),
    dbRow('extension', 'public', 'postgis', { detail: '3.4.0' })
];

function createConnection(catalog: Row[] = CATALOG) {
    const calls: string[] = [];
    const connection = {
        isConnected: () => true,
        getActiveConnectionConfig: () => ({ schemas: undefined as string[] | undefined }),
        clearMetadataCache: () => {},
        queryMetadata: async (sql: string) => {
            calls.push(sql);
            if (sql.includes('server_version_num')) return [{ server_version_num: 160000 }];
            if (sql.includes('information_schema.schemata')) return [{ schema_name: 'app' }, { schema_name: 'billing' }, { schema_name: 'public' }];
            if (sql.includes('current_schemas')) return [{ schema_name: 'public' }];
            if (sql.includes('pg_get_function_identity_arguments')) return catalog;
            return [];
        }
    };
    return { connection, calls };
}

function repository(files: Record<string, string> | null) {
    let scans = 0;
    const definitions: LocatedDefinition[] = files
        ? Object.entries(files).flatMap(([uri, sql]) => scanSqlText(sql).map(d => ({ ...d, uri })))
        : [];
    const snapshot: RepositorySnapshot | null = files ? { version: 1, definitions } : null;
    return {
        source: { snapshot: () => snapshot, ensureScanned: () => { scans++; } },
        scans: () => scans
    };
}

function createProvider(options: { settings?: Partial<NavigatorSettings>; files?: Record<string, string> | null; catalog?: Row[] } = {}) {
    const { connection, calls } = createConnection(options.catalog);
    const repo = repository(options.files ?? null);
    const settings: NavigatorSettings = { objectKinds: [...NAVIGATOR_KINDS], showExtensionObjects: false, ...options.settings };
    const stored = new Map<string, unknown>();
    const state = { get: <T>(key: string, d: T): T => (stored.has(key) ? stored.get(key) as T : d), update: async (key: string, v: unknown) => { stored.set(key, v); } };
    const provider = new ObjectNavigatorProvider(connection, () => settings, repo.source, state);
    return { provider, calls, repo, stored };
}

const labelOf = (provider: ObjectNavigatorProvider, node: NavigatorNode): string => {
    const label = provider.getTreeItem(node).label as { label: string } | string;
    return typeof label === 'string' ? label : label.label;
};

async function tree(provider: ObjectNavigatorProvider, node?: NavigatorNode, depth = 0): Promise<string[]> {
    const lines: string[] = [];
    for (const child of await provider.getChildren(node)) {
        lines.push(`${'  '.repeat(depth)}${labelOf(provider, child)}`);
        lines.push(...await tree(provider, child, depth + 1));
    }
    return lines;
}

async function findObject(provider: ObjectNavigatorProvider, label: string): Promise<ObjectNode> {
    const all = await provider.allObjectNodes();
    const node = all.find(n => labelOf(provider, n) === label);
    assert.ok(node, `no object labelled ${label}`);
    return node;
}

// ===== loading =====

test('nothing is queried before the view asks for its children, and the catalog is read once', async () => {
    const { provider, calls } = createProvider();
    assert.equal(calls.length, 0, 'constructing the view must not touch the database');
    await tree(provider);
    await tree(provider);
    assert.equal(calls.filter(sql => sql.includes('pg_get_function_identity_arguments')).length, 1);
});

test('the catalog query picks the columns of the server version', () => {
    assert.match(buildObjectCatalogQuery(160000, false), /p\.prokind/);
    assert.match(buildObjectCatalogQuery(160000, false), /tgparentid = 0/);
    assert.match(buildObjectCatalogQuery(100000, false), /p\.proisagg/);
    assert.doesNotMatch(buildObjectCatalogQuery(100000, false), /prokind|tgparentid/);
    assert.match(buildObjectCatalogQuery(160000, true), /= ANY\(\$1::text\[\]\)/, 'configured schemas travel as a parameter');
});

// ===== tree shape =====

test('objects are grouped by schema and kind, routines carry their signature, extensions come last', async () => {
    const { provider } = createProvider();
    assert.deepEqual(await tree(provider), [
        'app',
        '  Functions',
        '    add_tax(amount numeric)',
        '    add_tax(amount numeric, rate numeric)',
        '  Procedures',
        '    close_month(p_month date)',
        '  Types',
        '    mood',
        '  Sequences',
        '    orders_id_seq',
        '  Triggers',
        '    orders_audit',
        'billing',
        '  Domains',
        '    amount',
        'Extensions',
        '  postgis'
    ]);
});

test('an entry shows its detail as description and its kind in the tooltip', async () => {
    const { provider } = createProvider();
    const fn = provider.getTreeItem(await findObject(provider, 'add_tax(amount numeric)'));
    assert.equal(fn.description, '→ numeric');
    assert.match(String(fn.tooltip), /^Function app\.add_tax\(amount numeric\)\nReturns: numeric/);
    assert.equal(fn.contextValue, 'dbObject.function');
    const seq = provider.getTreeItem(await findObject(provider, 'orders_id_seq'));
    assert.equal(seq.description, 'integer · owned by orders.id');
    const trigger = provider.getTreeItem(await findObject(provider, 'orders_audit'));
    assert.equal(trigger.description, 'on orders');
});

test('a single click does not open anything: the item command waits for a double click', async () => {
    const { provider } = createProvider();
    const item = provider.getTreeItem(await findObject(provider, 'mood'));
    assert.equal(item.command?.command, 'postgresQueryBuilder.goToRepositoryDefinition');
    assert.equal(item.command?.arguments?.[1], 'click');
});

test('objects of extensions are hidden unless the setting shows them', async () => {
    assert.ok(!(await tree(createProvider().provider)).some(l => l.includes('st_x')));
    assert.ok((await tree(createProvider({ settings: { showExtensionObjects: true } }).provider)).some(l => l.includes('st_x(geometry)')));
});

test('the objectKinds setting decides which categories appear', async () => {
    const { provider } = createProvider({ settings: { objectKinds: ['domain'] } });
    assert.deepEqual(await tree(provider), ['billing', '  Domains', '    amount']);
});

// ===== filter =====

test('the Search filter keeps the matching objects, expands them and gives them ids of their own', async () => {
    const { provider } = createProvider();
    const collapsedId = provider.getTreeItem({ type: 'schema', schema: 'app', definitions: [] }).id;
    provider.setFilter('tax');
    assert.deepEqual(await tree(provider), ['app', '  Functions', '    add_tax(amount numeric)', '    add_tax(amount numeric, rate numeric)']);
    const schemaItem = provider.getTreeItem({ type: 'schema', schema: 'app', definitions: [] });
    assert.equal(schemaItem.collapsibleState, 2, 'expanded while filtering');
    assert.notEqual(schemaItem.id, collapsedId);
    const label = provider.getTreeItem(await findObject(provider, 'add_tax(amount numeric)')).label as { highlights: Array<[number, number]> };
    assert.deepEqual(label.highlights, [[4, 7]]);
});

test('isFilteredOut tells whether the Search filter hides an entry', async () => {
    const { provider } = createProvider();
    const mood = await findObject(provider, 'mood');
    provider.setFilter('tax');
    assert.equal(provider.isFilteredOut(mood), true);
    provider.setFilter('app.mo');
    assert.equal(provider.isFilteredOut(mood), false);
});

test('getParent leads from an object over its category to its schema', async () => {
    const { provider } = createProvider();
    const mood = await findObject(provider, 'mood');
    const category = provider.getParent(mood);
    assert.deepEqual(category, { type: 'category', schema: 'app', kind: 'type' });
    const schema = provider.getParent(category!);
    assert.equal(schema?.type, 'schema');
    assert.equal(provider.getParent(schema!), undefined);
    assert.deepEqual(provider.getParent(await findObject(provider, 'postgis')), { type: 'extensions' });
});

// ===== repository comparison =====

const REPO = {
    'db/app.sql': `
        CREATE SCHEMA app;
        CREATE FUNCTION app.add_tax(amount numeric) RETURNS numeric AS 'select amount' LANGUAGE sql;
        CREATE FUNCTION app.discount(numeric) RETURNS numeric AS 'select 1' LANGUAGE sql;
        CREATE TABLE app.orders (id serial);
        CREATE TRIGGER orders_audit AFTER INSERT ON app.orders FOR EACH ROW EXECUTE FUNCTION app.audit();
        CREATE TYPE app.mood AS ENUM ('ok');
        CREATE SCHEMA planned;`
};

test('the repository starts scanning when the view renders', async () => {
    const { provider, repo } = createProvider({ files: REPO });
    await provider.getChildren();
    assert.equal(repo.scans(), 1);
});

test('objects missing in the repository are marked, objects defined there are not', async () => {
    const { provider } = createProvider({ files: REPO });
    const inRepo = provider.getTreeItem(await findObject(provider, 'add_tax(amount numeric)'));
    assert.equal(inRepo.resourceUri, undefined);
    assert.match(String(inRepo.tooltip), /Defined in the repository\.$/);

    const missing = provider.getTreeItem(await findObject(provider, 'add_tax(amount numeric, rate numeric)'));
    assert.match(String(missing.resourceUri), /\?dbOnly$/);
    assert.match(String(missing.tooltip), /Not found in the repository\.$/);
});

test('a sequence of a serial column counts as defined by its table', async () => {
    const { provider } = createProvider({ files: REPO });
    const seq = await findObject(provider, 'orders_id_seq');
    assert.equal(seq.status, 'both');
    assert.equal(seq.definitions[0].kind, 'table');
});

test('objects that exist only in the repository are listed in their place', async () => {
    const { provider } = createProvider({ files: REPO });
    const lines = await tree(provider);
    assert.ok(lines.includes('    discount(numeric)'), lines.join('\n'));
    assert.ok(lines.includes('planned'), 'a schema only the repository creates gets its own node');
    const discount = await findObject(provider, 'discount(numeric)');
    const item = provider.getTreeItem(discount);
    assert.equal(item.contextValue, 'repoObject.function');
    assert.equal(item.description, 'only in repository');
    assert.match(String(item.resourceUri), /\?repoOnly$/);
    assert.deepEqual(provider.getParent(discount), { type: 'category', schema: 'app', kind: 'function' });
});

test('a repository without any CREATE statement marks nothing', async () => {
    const { provider } = createProvider({ files: { 'readme.sql': 'SELECT 1;' } });
    const node = await findObject(provider, 'add_tax(amount numeric, rate numeric)');
    assert.equal(node.status, undefined);
    assert.equal(provider.getTreeItem(node).resourceUri, undefined);
});

test('Show Only Differences hides what both sides have and is remembered', async () => {
    const { provider, stored } = createProvider({ files: REPO });
    await provider.setOnlyDifferences(true);
    const lines = await tree(provider);
    assert.ok(!lines.includes('    add_tax(amount numeric)'));
    assert.ok(lines.includes('    add_tax(amount numeric, rate numeric)'));
    assert.ok(lines.includes('    discount(numeric)'));
    assert.equal(provider.isHidden(await findObject(provider, 'add_tax(amount numeric)')), true);
    assert.equal(stored.get('postgresQueryBuilder.objectNavigator.onlyDifferences'), true);
});

test('PL/pgSQL is never listed, and a repository that creates it does not make it a repository-only entry', async () => {
    const { provider } = createProvider({
        catalog: [...CATALOG, dbRow('extension', 'pg_catalog', 'plpgsql', { detail: '1.0' })],
        files: { ...REPO, 'baseline.sql': 'CREATE EXTENSION IF NOT EXISTS plpgsql WITH SCHEMA pg_catalog;' }
    });
    const lines = await tree(provider);
    assert.ok(!lines.some(l => l.includes('plpgsql')), lines.join('\n'));
});

test('objects of an extension are not marked, even when the setting shows them', async () => {
    const { provider } = createProvider({ files: REPO, settings: { showExtensionObjects: true } });
    const stX = await findObject(provider, 'st_x(geometry)');
    assert.equal(stX.status, undefined);
    assert.equal(provider.getTreeItem(stX).resourceUri, undefined);
});
