import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_NAMES_QUERY, DatabaseCatalog, DbIndex, ROUTINE_BODIES_QUERY, RoutineBodies, buildObjectCatalogQuery, toDbObject, type CatalogConnection } from '../databaseCatalog';
import { routineBodyHash, routineTokenHash, scanSqlText } from '../repositoryScanner';

function row(extra: Record<string, unknown>): Record<string, unknown> {
    return {
        kind: 'function', oid: 1, schema_name: 'app', name: 'f', args: null, arg_types: null, detail: null,
        rel_schema: null, rel_name: null, rel_column: null, owner: null, language: null, comment: null, from_extension: false, ...extra
    };
}

// ===== toDbObject =====

test('toDbObject reads the argument counts, -1 standing for a VARIADIC parameter', () => {
    assert.deepEqual(toDbObject(row({ min_args: 1, max_args: 3 }))?.argCount, { min: 1, max: 3 });
    assert.deepEqual(toDbObject(row({ min_args: 0, max_args: -1 }))?.argCount, { min: 0, max: Infinity });
    assert.equal(toDbObject(row({ min_args: null, max_args: null }))?.argCount, undefined);
    assert.equal(toDbObject(row({ full_args: 'a integer DEFAULT 1', body_hash: 'abc' }))?.fullArgs, 'a integer DEFAULT 1');
    assert.equal(toDbObject(row({ kind: 'table' })), null, 'relations are not objects of the Objects view');
});

test('the catalog query hashes bodies the way the scanner does: whitespace dropped, ASCII letters folded', () => {
    const sql = buildObjectCatalogQuery(160000, false);
    assert.match(sql, /md5\(translate\(regexp_replace\(p\.prosrc, E'\[ \\\\t\\\\n\\\\r\\\\f\\\\v\]\+', '', 'g'\)/);
    assert.match(sql, /'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'/);
    assert.equal(routineBodyHash('\r\n  BEGIN\r\n    RETURN 1;\r\n  END;\r\n'), routineBodyHash('begin return 1; end;'));
    assert.notEqual(routineBodyHash("RETURN 'A';"), routineBodyHash("RETURN 'B';"));
});

// ===== DbIndex =====

test('DbIndex finds objects, relations and schemas by kind and name, in a schema or in any', () => {
    const objects = [toDbObject(row({ oid: 1 }))!, toDbObject(row({ oid: 2, schema_name: 'billing' }))!, toDbObject(row({ kind: 'extension', oid: 3, name: 'postgis', schema_name: 'public' }))!];
    const index = new DbIndex(objects, [{ schema: 'app', name: 't', kind: 'table' }], ['app', 'billing']);
    assert.deepEqual(index.lookup('function', 'app', 'f').map(e => e.object?.oid), [1]);
    assert.deepEqual(index.lookup('function', null, 'f').map(e => e.object?.oid), [1, 2]);
    assert.deepEqual(index.lookup('extension', 'whatever', 'postgis').map(e => e.schema), [''], 'extensions have no schema');
    assert.equal(index.lookup('table', 'app', 't')[0].relation?.name, 't');
    assert.equal(index.lookup('schema', null, 'billing').length, 1);
    assert.equal(index.hasName(['procedure', 'function'], 'f'), true);
    assert.equal([...index.entries(new Set(['function']))].length, 2);
});

// ===== DatabaseCatalog =====

function connection(fail = false): CatalogConnection & { calls: string[] } {
    const calls: string[] = [];
    let failing = fail;
    return {
        calls,
        isConnected: () => true,
        getActiveConnectionConfig: () => ({}),
        clearMetadataCache: () => calls.push('clear'),
        queryMetadata: async (sql: string) => {
            calls.push(sql);
            if (failing && sql.includes('pg_get_function_identity_arguments')) {
                failing = false;
                throw new Error('lost');
            }
            if (sql.includes('server_version_num')) return [{ server_version_num: 160000 }];
            if (sql.includes('current_schemas')) return [{ schema_name: 'app' }, { schema_name: 'public' }];
            if (sql.includes('information_schema.schemata')) return [{ schema_name: 'app' }];
            if (sql === BUILTIN_NAMES_QUERY) return [{ name_kind: 'function', name: 'now' }, { name_kind: 'type', name: 'integer' }];
            if (sql.includes('pg_get_function_identity_arguments')) return [row({ oid: 7 })];
            return [];
        }
    };
}

test('nothing is queried until asked, and what was loaded is kept until reset', async () => {
    const conn = connection();
    const catalog = new DatabaseCatalog(conn);
    assert.equal(conn.calls.length, 0);
    const data = await catalog.load();
    assert.deepEqual([data.objects.length, data.defaultSchema, data.searchPath], [1, 'app', ['app', 'public']]);
    const queries = conn.calls.length;
    await catalog.load();
    assert.equal(conn.calls.length, queries);
    let resets = 0;
    catalog.onDidReset(() => resets++);
    catalog.refresh();
    assert.equal(resets, 1);
    assert.ok(conn.calls.includes('clear'));
    await catalog.load();
    assert.ok(conn.calls.length > queries + 1);
});

test('a failed load is not kept, so the next request tries again', async () => {
    const catalog = new DatabaseCatalog(connection(true));
    await assert.rejects(catalog.load(), /lost/);
    assert.equal((await catalog.load()).objects.length, 1);
});

test('builtins separates function and type names; index combines objects, relations and schemas', async () => {
    const catalog = new DatabaseCatalog(connection());
    const builtins = await catalog.builtins();
    assert.deepEqual([[...builtins.functions], [...builtins.types]], [['now'], ['integer']]);
    const index = await catalog.index();
    assert.equal(index.lookup('function', 'app', 'f')[0].object?.oid, 7);
    assert.equal(index.lookup('schema', null, 'app').length, 1);
});

// ===== RoutineBodies =====

function bodiesConnection(bodies: Record<number, string>) {
    const asked: number[][] = [];
    const connection = {
        isConnected: () => true,
        getActiveConnectionConfig: () => ({}),
        clearMetadataCache: () => {},
        queryMetadata: async () => [],
        query: async (sql: string, params?: unknown[]) => {
            assert.equal(sql, ROUTINE_BODIES_QUERY);
            const oids = params![0] as number[];
            asked.push(oids);
            return { rows: oids.filter(o => bodies[o] !== undefined).map(o => ({ oid: o, prosrc: bodies[o] })) };
        }
    };
    return { connection, asked };
}

test('a routine the fast hash calls different counts as the same until its body is compared, comments ignored', async () => {
    const { connection, asked } = bodiesConnection({ 1: ' SELECT 1 /* moved */ ', 2: ' SELECT 2 ' });
    const bodies = new RoutineBodies(connection, 1);
    const defs = scanSqlText('CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 -- moved\n$$;').map(d => ({ ...d, uri: 'x' }));
    const commented = toDbObject(row({ oid: 1, body_hash: routineBodyHash(' SELECT 1 /* moved */ ') }))!;
    const changed = toDbObject(row({ oid: 2, body_hash: routineBodyHash(' SELECT 2 ') }))!;
    let changes = 0;
    bodies.onDidChange(() => changes++);
    assert.equal(bodies.status(commented, defs), 'both');
    assert.equal(bodies.status(changed, defs), 'both');
    assert.equal(bodies.busy, true);
    await bodies.settled();
    assert.deepEqual(asked, [[1], [2]], 'read in batches, without the metadata cache');
    assert.equal(changes, 2);
    assert.equal(bodies.status(commented, defs), 'both');
    assert.equal(bodies.status(changed, defs), 'differs');
    assert.equal(bodies.tokenHashOf(changed), routineTokenHash(' SELECT 2 '));
});

test('a routine without a body row is not asked for again; clear forgets everything', async () => {
    const { connection, asked } = bodiesConnection({});
    const bodies = new RoutineBodies(connection);
    const defs = scanSqlText('CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;').map(d => ({ ...d, uri: 'x' }));
    const gone = toDbObject(row({ oid: 9, body_hash: routineBodyHash('SELECT 9') }))!;
    bodies.status(gone, defs);
    await bodies.settled();
    assert.equal(bodies.status(gone, defs), 'differs', 'the fast answer stands');
    await bodies.settled();
    assert.equal(asked.length, 1);
    bodies.clear();
    bodies.status(gone, defs);
    await bodies.settled();
    assert.equal(asked.length, 2);
});

test('a body that differs only in how its types are spelt counts as the same, unless the setting says otherwise', async () => {
    const { connection } = bodiesConnection({ 1: ' DECLARE v character varying; BEGIN END ' });
    const bodies = new RoutineBodies(connection);
    const defs = scanSqlText('CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ DECLARE v varchar; BEGIN END $$;').map(d => ({ ...d, uri: 'x' }));
    const fn = toDbObject(row({ oid: 1, body_hash: routineBodyHash(' DECLARE v character varying; BEGIN END ') }))!;
    bodies.status(fn, defs);
    await bodies.settled();
    assert.equal(bodies.status(fn, defs), 'both');
    let changes = 0;
    bodies.onDidChange(() => changes++);
    bodies.ignoreTypeSpelling = false;
    assert.equal(changes, 1, 'the views are told to render again');
    assert.equal(bodies.status(fn, defs), 'differs');
    bodies.ignoreTypeSpelling = false;
    assert.equal(changes, 1);
});
