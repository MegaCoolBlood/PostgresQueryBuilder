import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import { routineBodyHash, routineTokenHash, scanSqlText } from '../repositoryScanner';
import { DefinitionMatcher, UnmarkedObjects, type LocatedDefinition } from '../repositoryComparison';
import { toDbObject, type CatalogData, type DbObject } from '../databaseCatalog';
import { scanStructure } from '../ddlCompare';
import {
    COMPOSITES_QUERY,
    DOMAINS_QUERY,
    ENUMS_QUERY,
    INDEXES_QUERY,
    RANGES_QUERY,
    SEQUENCES_QUERY,
    StatementIndex,
    TABLE_COLUMNS_QUERY,
    TABLE_CONSTRAINTS_QUERY,
    TRIGGERS_QUERY,
    routineDifferences,
    runComparison,
    statementOrder,
    type ComparisonInput,
    type LocatedStatement
} from '../databaseComparison';
import { comparisonReport, entryContextValue, entryNode, marksOf, ComparisonProvider } from '../comparisonView';

let oid = 1;
function routine(name: string, body: string, extra: Record<string, unknown> = {}): DbObject {
    return toDbObject({
        kind: 'function', oid: oid++, schema_name: 'app', name, args: '', arg_types: [], full_args: '', min_args: 0, max_args: 0,
        detail: 'integer', body_hash: routineBodyHash(body), rel_schema: null, rel_name: null, rel_column: null,
        owner: null, language: 'plpgsql', comment: null, from_extension: false, ...extra
    })!;
}

const REPO: Record<string, string> = {
    'file:///repo/10_tables.sql': [
        'SET search_path = app;',
        "CREATE TABLE orders (id integer PRIMARY KEY, state varchar(1) NOT NULL DEFAULT 'N');",
        'CREATE TABLE planned (id integer);',
        "CREATE TYPE mood AS ENUM ('sad', 'happy');",
        'CREATE VIEW v_orders AS SELECT id FROM orders;'
    ].join('\n'),
    'file:///repo/11_more.sql': 'ALTER TABLE app.orders ADD COLUMN note text;',
    'file:///repo/fn.sql': [
        'CREATE FUNCTION app.same() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$;',
        'CREATE FUNCTION app.changed() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$;'
    ].join('\n')
};

function repository() {
    const definitions: LocatedDefinition[] = [];
    const statements: LocatedStatement[] = [];
    for (const [uri, text] of Object.entries(REPO)) {
        definitions.push(...scanSqlText(text).map(d => ({ ...d, uri })));
        statements.push(...scanStructure(text).map(s => ({ ...s, uri })));
    }
    return { definitions, statements };
}

/** A client answering the catalog queries; views go through the temporary-view step. */
function client(viewDefs: Record<string, string>) {
    const sent: string[] = [];
    let lastTemp = '';
    return {
        sent,
        query: async (sql: string, params?: unknown[]) => {
            sent.push(sql);
            const rows = (r: Array<Record<string, unknown>>) => ({ rows: r });
            if (sql === TABLE_COLUMNS_QUERY) {
                return rows([
                    { schema_name: 'app', table_name: 'orders', column_name: 'id', data_type: 'integer', not_null: true, default_expr: null, identity: '', generated: '' },
                    { schema_name: 'app', table_name: 'orders', column_name: 'state', data_type: 'character varying(1)', not_null: true, default_expr: "'N'::character varying", identity: '', generated: '' },
                    { schema_name: 'app', table_name: 'orders', column_name: 'note', data_type: 'character varying(200)', not_null: false, default_expr: null, identity: '', generated: '' }
                ]);
            }
            if (sql === TABLE_CONSTRAINTS_QUERY) return rows([{ schema_name: 'app', table_name: 'orders', constraint_name: 'orders_pkey', definition: 'PRIMARY KEY (id)' }]);
            if (sql === ENUMS_QUERY) return rows([{ schema_name: 'app', type_name: 'mood', labels: ['sad', 'happy'] }]);
            if ([INDEXES_QUERY, COMPOSITES_QUERY, RANGES_QUERY, DOMAINS_QUERY, SEQUENCES_QUERY, TRIGGERS_QUERY].includes(sql)) return rows([]);
            if (sql.startsWith('CREATE TEMPORARY VIEW')) {
                lastTemp = sql;
                return rows([]);
            }
            if (sql.includes("pg_get_viewdef('pg_temp.")) return rows([{ def: lastTemp.includes('FROM orders') ? viewDefs.repo : 'other' }]);
            if (sql.includes('pg_get_viewdef(')) return rows([{ def: viewDefs[String(params?.[0])] ?? '' }]);
            return rows([]);
        }
    };
}

function input(viewDefs: Record<string, string>, extra: Partial<ComparisonInput> = {}) {
    const { definitions, statements } = repository();
    const same = routine('same', ' BEGIN RETURN 1; END ');
    const changed = routine('changed', ' BEGIN RETURN 2; END ');
    const dbOnly = routine('legacy', 'x');
    const mood = toDbObject({ kind: 'type', oid: oid++, schema_name: 'app', name: 'mood', args: null, arg_types: null, detail: 'enum', rel_schema: null, rel_name: null, rel_column: null, owner: null, language: null, comment: null, from_extension: false })!;
    const catalog: CatalogData = { objects: [same, changed, dbOnly, mood], schemas: new Set(['app']), defaultSchema: 'app', searchPath: ['app'], serverVersion: 160000 };
    const c = client(viewDefs);
    const tokens = new Map<number, string>([[changed.oid, routineTokenHash(' BEGIN RETURN 2; END ')]]);
    const value: ComparisonInput = {
        client: c,
        catalog,
        relations: [{ schema: 'app', name: 'orders', kind: 'table' }, { schema: 'app', name: 'v_orders', kind: 'view' }],
        unmarked: new UnmarkedObjects([]),
        allowedSchema: () => true,
        matcher: new DefinitionMatcher(definitions, 'app'),
        statements,
        bodies: { status: () => 'both', settled: async () => undefined, tokenHashOf: (db) => tokens.get(db.oid) },
        ...extra
    };
    return { value, client: c };
}

// ===== runComparison =====

test('the comparison reports what differs, what exists only on one side, and counts what is equal', async () => {
    const { value } = input({ '"app"."v_orders"': ' SELECT orders.id\n   FROM orders;', repo: 'SELECT orders.id FROM orders;' });
    const result = await runComparison(value);
    const summary = result.entries.map(e => `${e.status} ${e.kind} ${e.schema}.${e.name}${e.differences.length ? `: ${e.differences.map(d => `${d.path} ${d.message}`).join('; ')}` : ''}`);
    assert.deepEqual(summary, [
        'differs function app.changed: body the code differs (comments, white space and type spellings ignored)',
        'dbOnly function app.legacy',
        'differs table app.orders: column note type text in the repository, character varying(200) in the database',
        'repoOnly table app.planned'
    ]);
    assert.equal(result.equal, 3, 'same(), mood and the view');
    assert.deepEqual(result.problems, []);
});

test('a view whose query the database prints differently differs; the temporary views go with savepoints', async () => {
    const { value, client: c } = input({ '"app"."v_orders"': 'SELECT orders.id, 1 FROM orders;', repo: 'SELECT orders.id FROM orders;' });
    const result = await runComparison(value);
    assert.deepEqual(result.entries.filter(e => e.kind === 'view').map(e => e.differences.map(d => d.message)), [['the query differs']]);
    const created = c.sent.findIndex(s => s.startsWith('CREATE TEMPORARY VIEW'));
    assert.equal(c.sent[created - 2], 'SAVEPOINT pqb_compare');
    assert.ok(c.sent.slice(created).includes('ROLLBACK TO SAVEPOINT pqb_compare'));
});

test('only the chosen kinds are compared, and a cancelled run says so', async () => {
    const { value } = input({}, { kinds: ['types'] });
    const result = await runComparison(value);
    assert.deepEqual(result.entries, []);
    assert.equal(result.equal, 1);
    let calls = 0;
    const cancelled = await runComparison(input({}, { isCancelled: () => ++calls > 3 }).value);
    assert.equal(cancelled.cancelled, true);
});

test('a catalog query that fails is listed as not compared instead of failing the run', async () => {
    const { value } = input({});
    const original = value.client.query;
    value.client = { query: async (sql: string, params?: unknown[]) => (sql === TABLE_COLUMNS_QUERY ? Promise.reject(new Error('permission denied')) : original(sql, params)) };
    const result = await runComparison(value);
    assert.deepEqual(result.problems, ['columns: permission denied']);
});

test('routineDifferences takes the best definition: any one matching body and signature is enough', () => {
    const db = routine('f', ' BEGIN RETURN 2; END ', { full_args: 'p_a integer', arg_types: ['integer'] });
    const defs = scanSqlText([
        'CREATE FUNCTION app.f(p_a integer) RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$;',
        'CREATE FUNCTION app.f(p_a integer) RETURNS integer LANGUAGE plpgsql AS $$ begin -- note\n return 2; end $$;'
    ].join('\n')).map(d => ({ ...d, uri: 'x' }));
    assert.deepEqual(routineDifferences(db, defs, routineTokenHash(' BEGIN RETURN 2; END ')), []);
    assert.deepEqual(routineDifferences(db, [defs[0]], routineTokenHash(' BEGIN RETURN 2; END ')).map(d => d.path), ['body']);
});

test('statements run in the natural order of their files', () => {
    const s = (uri: string, offset: number): LocatedStatement => ({ type: 'alterTable', schema: null, name: 't', searchPath: null, text: '', offset, uri });
    const sorted = [s('file:///105_b.sql', 0), s('file:///58_a.sql', 9), s('file:///58_a.sql', 1)].sort(statementOrder);
    assert.deepEqual(sorted.map(x => `${x.uri}@${x.offset}`), ['file:///58_a.sql@1', 'file:///58_a.sql@9', 'file:///105_b.sql@0']);
    const index = new StatementIndex([...scanStructure('CREATE TABLE app.t (a int); CREATE INDEX ix ON app.t (a);').map(x => ({ ...x, uri: 'f' })),
        ...scanStructure('DROP INDEX app.ix;').map(x => ({ ...x, uri: 'g' }))], 'app');
    assert.deepEqual(index.tableStatements('app', 't').map(x => x.type), ['createTable', 'createIndex', 'dropIndex']);
});

// ===== The Comparison view =====

test('entries become nodes of the Objects and Tables views, so their menus and commands apply', async () => {
    const { value } = input({ '"app"."v_orders"': 'x', repo: 'x' });
    const result = await runComparison(value);
    const changed = result.entries.find(e => e.name === 'changed')!;
    const planned = result.entries.find(e => e.name === 'planned')!;
    assert.equal(entryContextValue(changed), 'dbObject.function');
    assert.equal(entryContextValue(planned), 'table.repoOnly');
    assert.deepEqual(Object.keys(entryNode(changed)).sort(), ['args', 'db', 'definitions', 'kind', 'name', 'schema', 'status', 'type']);
    assert.equal(entryNode(planned).type, 'table');
    const marks = marksOf(result);
    assert.equal(marks.differences('table', 'app', 'orders')?.length, 1);
    assert.equal(marks.differences('function', 'app', 'same'), undefined);
});

test('the view groups by status and kind, filters by kind, and the report lists everything', async () => {
    const { value } = input({ '"app"."v_orders"': 'x', repo: 'x' });
    const result = await runComparison(value);
    const view = new ComparisonProvider();
    assert.deepEqual(view.getChildren(), []);
    view.setResult(result);
    const roots = view.getChildren();
    assert.deepEqual(roots.map(r => String(view.getTreeItem(r).label)), ['Differs (2)', 'Only in the database (1)', 'Only in the repository (1)']);
    const kinds = view.getChildren(roots[0]);
    assert.deepEqual(kinds.map(k => String(view.getTreeItem(k).label)), ['Functions (1)', 'Tables (1)']);
    const [orders] = view.getChildren(kinds[1]);
    assert.deepEqual(view.getChildren(orders).map(d => String(view.getTreeItem(d).label)), ['column note']);
    view.setKindFilter(new Set(['table']));
    assert.deepEqual(view.getChildren().map(r => String(view.getTreeItem(r).label)), ['Differs (1)', 'Only in the database (0)', 'Only in the repository (1)']);
    const report = comparisonReport(result, null);
    assert.match(report, /## Differs \(2\)/);
    assert.match(report, /- \*\*Tables\*\* `app\.orders`\n {4}- column note: type text in the repository, character varying\(200\) in the database/);
});

test('a routine body that differs only in type spellings is no difference, unless asked', () => {
    const db = routine('f', ' DECLARE v character varying; BEGIN END ');
    const defs = scanSqlText('CREATE FUNCTION app.f() RETURNS int LANGUAGE plpgsql AS $$ DECLARE v varchar; BEGIN END $$;').map(d => ({ ...d, uri: 'x' }));
    const body = ' DECLARE v character varying; BEGIN END ';
    assert.deepEqual(routineDifferences(db, defs, routineTokenHash(body)), []);
    assert.deepEqual(routineDifferences(db, defs, routineTokenHash(body, false), false).map(d => d.path), ['body']);
});
