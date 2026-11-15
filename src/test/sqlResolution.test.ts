import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSqlText } from '../repositoryScanner';
import { DefinitionMatcher, type LocatedDefinition } from '../repositoryComparison';
import { DbIndex, toDbObject, type DbObject } from '../databaseCatalog';
import { referencesIn, type SqlReference } from '../sqlReferences';
import { candidateSchemas, resolveReference, sameObject, type ResolutionSources } from '../sqlResolution';

let oid = 1;
function fn(schema: string, name: string, argTypes: string[], min = argTypes.length, max = argTypes.length): DbObject {
    return toDbObject({
        kind: 'function', oid: oid++, schema_name: schema, name, args: argTypes.join(', '), arg_types: argTypes,
        min_args: min, max_args: max, detail: null, rel_schema: null, rel_name: null, rel_column: null,
        owner: null, language: 'sql', comment: null, from_extension: false
    })!;
}

const OBJECTS = [fn('app', 'f', ['integer']), fn('app', 'f', ['integer', 'integer']), fn('public', 'f', ['text']), fn('public', 'g', [])];

function sources(files: Record<string, string> = {}, searchPath: string[] | null = ['app', 'public']): ResolutionSources {
    const defs: LocatedDefinition[] = Object.entries(files).flatMap(([uri, sql]) => scanSqlText(sql).map(d => ({ ...d, uri })));
    return {
        matcher: defs.length > 0 ? new DefinitionMatcher(defs, 'app') : null,
        db: searchPath ? new DbIndex(OBJECTS, [{ schema: 'app', name: 't', kind: 'table' }], ['app', 'public']) : null,
        searchPath
    };
}

function call(text: string, name: string): SqlReference {
    const ref = referencesIn(text).find(r => r.name === name);
    assert.ok(ref, `no reference to ${name}`);
    return ref;
}

// ===== candidateSchemas =====

test('a qualified name is looked up in its schema, an unqualified one along the search_path', () => {
    assert.deepEqual(candidateSchemas({ schema: 'billing', searchPath: null, kinds: ['function'] }, ['app']), ['billing']);
    assert.deepEqual(candidateSchemas({ schema: null, searchPath: null, kinds: ['function'] }, ['app', 'public', 'app']), ['app', 'public']);
    assert.deepEqual(candidateSchemas({ schema: null, searchPath: ['billing'], kinds: ['function'] }, ['app']), ['billing'], 'the file beats the connection');
    assert.deepEqual(candidateSchemas({ schema: null, searchPath: null, kinds: ['function'] }, null), [null], 'without a connection any schema');
    assert.deepEqual(candidateSchemas({ schema: null, searchPath: ['x'], kinds: ['schema'] }, ['app']), [null], 'schemas have no schema');
});

// ===== resolveReference =====

test('the first schema of the search_path with a hit wins, as in PostgreSQL', () => {
    const resolved = resolveReference(call('SELECT f(1);', 'f'), sources());
    assert.deepEqual(resolved.map(o => [o.schema, o.db?.object?.argTypes]), [['app', ['integer']]]);
    const fromPublic = resolveReference(call('SET search_path = public;\nSELECT f(1);', 'f'), sources());
    assert.deepEqual(fromPublic.map(o => [o.schema, o.db?.object?.argTypes]), [['public', ['text']]]);
});

test('calls are narrowed to the overloads that take as many arguments; when none does, all are kept', () => {
    assert.equal(resolveReference(call('SELECT f(1, 2);', 'f'), sources()).length, 1);
    assert.equal(resolveReference(call('SELECT f(1, 2, 3);', 'f'), sources()).length, 2);
});

test('a definition of the repository joins its database object; one without becomes an object of its own', () => {
    const src = sources({
        'file:///f.sql': 'CREATE FUNCTION app.f(a integer) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
        'file:///h.sql': 'CREATE FUNCTION app.h() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;'
    });
    const [f] = resolveReference(call('SELECT f(1);', 'f'), src);
    assert.deepEqual([f.db?.object?.argTypes, f.definitions.map(d => d.uri)], [['integer'], ['file:///f.sql']]);
    const [h] = resolveReference(call('SELECT h();', 'h'), src);
    assert.deepEqual([h.schema, h.db, h.definitions.length], ['app', undefined, 1]);
});

test('without a connection the repository alone answers, in any schema', () => {
    const src = sources({ 'file:///h.sql': 'CREATE FUNCTION billing.h() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;' }, null);
    assert.deepEqual(resolveReference(call('SELECT h();', 'h'), src).map(o => o.schema), ['billing']);
    assert.deepEqual(resolveReference(call('SELECT missing_fn();', 'missing_fn'), src), []);
});

test('a relation reference finds the relation of the database', () => {
    const [t] = resolveReference(call('SELECT * FROM t;', 't'), sources());
    assert.deepEqual([t.kind, t.schema, t.db?.relation?.name], ['table', 'app', 't']);
});

test('sameObject compares kind group, schema, name and the overload', () => {
    const [one] = resolveReference(call('SELECT f(1);', 'f'), sources());
    const [again] = resolveReference(call('SELECT app.f(2);', 'f'), sources());
    const [two] = resolveReference(call('SELECT f(1, 2);', 'f'), sources());
    assert.equal(sameObject(one, again), true);
    assert.equal(sameObject(one, two), false);
});
