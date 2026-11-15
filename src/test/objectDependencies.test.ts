import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DependenciesProvider,
    USED_BY_QUERY,
    USES_QUERY,
    contextValueOf,
    relationKindOf,
    toDependencyRow,
    type DependencyNode,
    type DependencyRow
} from '../objectDependencies';

function dbRow(classid: string, oid: number, type: string, identity: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { class_name: classid, oid, object_type: type, object_schema: 'app', object_identity: identity, rel_name: null, rel_kind: null, ...extra };
}

/** Answers the dependency queries from a map `direction:classid:oid` → rows, and records them. */
function source(rows: Record<string, Array<Record<string, unknown>>>, fail = false) {
    const queries: Array<{ direction: string; params: unknown[] }> = [];
    return {
        queries,
        query: async (sql: string, params: unknown[]) => {
            const direction = sql === USED_BY_QUERY ? 'usedBy' : 'uses';
            queries.push({ direction, params });
            if (fail) throw new Error('permission denied');
            return rows[`${direction}:${String(params[0]).replace('pg_catalog.', '')}:${params[1]}`] ?? [];
        },
        toNode: async (row: DependencyRow) => (row.classid === 'pg_class' ? { type: 'table', schema: 'app', table: row.relName, kind: 'table' } : undefined)
    };
}

const ROOT = { target: { classid: 'pg_proc', oid: 10 }, title: 'function app.f()', icon: 'symbol-function' };

async function labels(provider: DependenciesProvider, node?: DependencyNode, depth = 0, max = 3): Promise<string[]> {
    if (depth > max) return [];
    const out: string[] = [];
    for (const child of await provider.getChildren(node)) {
        const item = provider.getTreeItem(child);
        out.push(`${'  '.repeat(depth)}${String(item.label)}${item.description ? ` (${String(item.description)})` : ''}`);
        if (item.collapsibleState !== 0) out.push(...await labels(provider, child, depth + 1, max));
    }
    return out;
}

// ===== rows =====

test('a result row becomes a DependencyRow with the class without its schema', () => {
    const row = toDependencyRow(dbRow('pg_catalog.pg_class', 5, 'view', 'app.v', { rel_name: 'v', rel_kind: 'v' }));
    assert.deepEqual(row, { classid: 'pg_class', oid: 5, type: 'view', schema: 'app', identity: 'app.v', relName: 'v', relKind: 'v' });
    assert.deepEqual(['r', 'p', 'v', 'm', 'f', 'S', 'i'].map(relationKindOf), ['table', 'table', 'view', 'matview', 'foreign', 'sequence', undefined]);
});

test('the queries take the object as parameters, skip internal and extension dependencies and system objects', () => {
    for (const sql of [USED_BY_QUERY, USES_QUERY]) {
        assert.match(sql, /\$1::regclass/);
        assert.match(sql, /\$2::oid/);
        assert.match(sql, /deptype IN \('n', 'a'\)/);
        assert.match(sql, /NOT IN \('pg_catalog', 'information_schema'\)/);
        assert.match(sql, /pg_rewrite rw ON .*rw\.oid = r\.objid/, 'a rewrite rule is shown as its view');
    }
    assert.match(USES_QUERY, /pg_trigger tg\s+WHERE .* tg\.tgrelid = \$2::oid AND NOT tg\.tgisinternal/);
    assert.match(USED_BY_QUERY, /c\.reltype/, 'what uses the row type of a relation uses the relation');
});

test('the context value lets the menus of the Objects and Tables views apply', () => {
    assert.equal(contextValueOf({ type: 'object', kind: 'function', db: {} }), 'dbObject.function');
    assert.equal(contextValueOf({ type: 'table', kind: 'view' }), 'table');
    assert.equal(contextValueOf({ type: 'schema' }), 'objectSchema');
    assert.equal(contextValueOf(undefined), 'dependency');
});

// ===== tree =====

test('the view is empty until an object is chosen, then shows Used by, Uses and the repository usages', async () => {
    const src = source({
        'usedBy:pg_proc:10': [dbRow('pg_catalog.pg_class', 20, 'view', 'app.v', { rel_name: 'v', rel_kind: 'v' })],
        'uses:pg_proc:10': []
    });
    const provider = new DependenciesProvider(src);
    assert.deepEqual(await provider.getChildren(), []);
    provider.setRoot({
        ...ROOT,
        usages: async () => [{ uri: 'file:///repo/a.sql', start: { line: 4, character: 2 }, end: { line: 4, character: 3 } }]
    });
    assert.deepEqual(await labels(provider, undefined, 0, 2), [
        'function app.f()',
        '  Used by',
        '    app.v (view)',
        '  Uses',
        '    It uses nothing else in the database',
        '  Used in the repository (1)',
        '    file:///repo/a.sql:5'
    ]);
    assert.deepEqual(src.queries[0].params, ['pg_catalog.pg_proc', 10]);
});

test('an entry carries the node of its view, so its commands apply, and expands into its own dependencies', async () => {
    const src = source({
        'usedBy:pg_proc:10': [dbRow('pg_catalog.pg_class', 20, 'view', 'app.v', { rel_name: 'v', rel_kind: 'v' })],
        'usedBy:pg_class:20': [dbRow('pg_catalog.pg_class', 30, 'materialized view', 'app.mv', { rel_name: 'mv', rel_kind: 'm' })]
    });
    const provider = new DependenciesProvider(src);
    provider.setRoot(ROOT);
    const usedBy = (await provider.getChildren((await provider.getChildren())[0]))[0];
    const [view] = await provider.getChildren(usedBy);
    assert.equal(view.type, 'dependency');
    assert.equal(provider.getTreeItem(view).contextValue, 'table');
    assert.deepEqual((view as { node?: unknown }).node, { type: 'table', schema: 'app', table: 'v', kind: 'table' });
    const [mv] = await provider.getChildren(view);
    assert.equal(provider.getTreeItem(mv).label, 'app.mv');
});

test('a dependency cycle ends at the first repetition', async () => {
    const src = source({
        'uses:pg_proc:10': [dbRow('pg_catalog.pg_proc', 11, 'function', 'app.g()')],
        'uses:pg_proc:11': [dbRow('pg_catalog.pg_proc', 10, 'function', 'app.f()')]
    });
    const provider = new DependenciesProvider(src);
    provider.setRoot(ROOT);
    const uses = (await provider.getChildren((await provider.getChildren())[0]))[1];
    const [g] = await provider.getChildren(uses);
    const [f] = await provider.getChildren(g);
    assert.equal(provider.getTreeItem(f).collapsibleState, 0, 'the root object again is not expandable');
    assert.deepEqual(await provider.getChildren(f), []);
});

test('results are kept until Refresh; a failing query shows its error in the view', async () => {
    const src = source({});
    const provider = new DependenciesProvider(src);
    provider.setRoot(ROOT);
    const usedBy = (await provider.getChildren((await provider.getChildren())[0]))[0];
    await provider.getChildren(usedBy);
    await provider.getChildren(usedBy);
    assert.equal(src.queries.length, 1);
    provider.refresh();
    await provider.getChildren(usedBy);
    assert.equal(src.queries.length, 2);

    const failing = new DependenciesProvider(source({}, true));
    failing.setRoot(ROOT);
    const group = (await failing.getChildren((await failing.getChildren())[0]))[0];
    const [message] = await failing.getChildren(group);
    assert.match(String(failing.getTreeItem(message).label), /Could not read the dependencies: permission denied/);
});

test('Clear empties the view', async () => {
    const provider = new DependenciesProvider(source({}));
    provider.setRoot(ROOT);
    provider.clear();
    assert.deepEqual(await provider.getChildren(), []);
    assert.equal(provider.current, undefined);
});
