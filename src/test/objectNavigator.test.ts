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
import { routineBodyHash, scanSqlText } from '../repositoryScanner';
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
            if (sql.includes('p.prosrc FROM pg_catalog.pg_proc')) return catalog.filter(r => r.prosrc !== undefined).map(r => ({ oid: r.oid, prosrc: r.prosrc }));
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

// ===== Show Empty Schemas =====

test('a schema with nothing to show is hidden until Show Empty Schemas is on; the choice is kept', async () => {
    const { provider, stored } = createProvider();
    // public holds only extension objects, which the view hides by default.
    assert.deepEqual((await provider.getChildren()).map(n => labelOf(provider, n)), ['app', 'billing', 'Extensions']);
    await provider.setShowEmptySchemas(true);
    const roots = await provider.getChildren();
    assert.deepEqual(roots.map(n => labelOf(provider, n)), ['app', 'billing', 'public', 'Extensions']);
    assert.deepEqual(await provider.getChildren(roots[2]), [], 'an empty schema has no categories');
    assert.equal(stored.get('postgresQueryBuilder.objectNavigator.showEmptySchemas'), true);
    assert.equal((await provider.shownSchema('public'))?.schema, 'public');
});

test('empty is what the settings leave: with extension objects shown, public is no longer empty', async () => {
    const { provider } = createProvider({ settings: { showExtensionObjects: true } });
    assert.ok((await provider.getChildren()).some(n => labelOf(provider, n) === 'public'));
    const { provider: noTypes } = createProvider({ settings: { objectKinds: ['type', 'extension'] } });
    assert.deepEqual((await noTypes.getChildren()).map(n => labelOf(noTypes, n)), ['app', 'Extensions'], 'billing holds only a domain, which is switched off');
});

test('while filtering, Show Empty Schemas adds nothing', async () => {
    const { provider } = createProvider();
    await provider.setShowEmptySchemas(true);
    provider.setFilter('tax');
    assert.deepEqual((await provider.getChildren()).map(n => labelOf(provider, n)), ['app']);
    assert.equal(provider.isFiltering, true);
    assert.equal(await provider.shownSchema('public'), undefined);
});

// ===== differs =====

test('a function whose code differs is marked once the exact comparison has read its body; comments do not count', async () => {
    const catalog = [
        dbRow('function', 'app', 'same', { args: '', arg_types: [], body_hash: routineBodyHash(' SELECT 1 '), prosrc: ' SELECT 1 ' }),
        dbRow('function', 'app', 'changed', { args: '', arg_types: [], body_hash: routineBodyHash(' SELECT 2 '), prosrc: ' SELECT 2 ' }),
        dbRow('function', 'app', 'commented', { args: '', arg_types: [], body_hash: routineBodyHash(' SELECT 1 /* note */ '), prosrc: ' SELECT 1 /* note */ ' })
    ];
    const { provider } = createProvider({
        catalog,
        files: {
            'r.sql': [
                'CREATE FUNCTION app.same() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
                'CREATE FUNCTION app.changed() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
                'CREATE FUNCTION app.commented() RETURNS int LANGUAGE sql AS $$ SELECT 1 -- note',
                '$$;'
            ].join('\n')
        }
    });
    assert.equal((await findObject(provider, 'changed()')).status, 'both', 'not marked before the body was compared');
    await provider.catalog.bodies.settled();
    provider.rerender();
    const same = await findObject(provider, 'same()');
    const changed = await findObject(provider, 'changed()');
    const commented = await findObject(provider, 'commented()');
    assert.deepEqual([same.status, changed.status, commented.status], ['both', 'differs', 'both']);
    const item = provider.getTreeItem(changed);
    assert.match(String(item.tooltip), /differs from the repository/);
    assert.ok(item.resourceUri, 'a differing entry is decorated');
    await provider.setOnlyDifferences(true);
    assert.equal(provider.isHidden(changed), false);
    assert.equal(provider.isHidden(same), true);
});

test('an object the full comparison found different is marked, and its tooltip says what differs', async () => {
    const { provider } = createProvider({ files: { 'r.sql': "CREATE TYPE app.mood AS ENUM ('a');" } });
    provider.setComparisonMarks({ differences: (kind, schema, name) => (kind === 'type' && name === 'mood' ? [{ path: "value 'b'", message: 'missing in the repository' }] : undefined) });
    const mood = await findObject(provider, 'mood');
    assert.equal(mood.status, 'differs');
    assert.match(String(provider.getTreeItem(mood).tooltip), /• value 'b': missing in the repository/);
});
