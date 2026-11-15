import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSqlText } from '../repositoryScanner';
import { DefinitionMatcher, MatcherCache, argumentTypesMatch, routineStatus, type LocatedDefinition } from '../repositoryComparison';

function definitions(files: Record<string, string>): LocatedDefinition[] {
    return Object.entries(files).flatMap(([uri, sql]) => scanSqlText(sql).map(d => ({ ...d, uri })));
}

// ===== DefinitionMatcher.find =====

test('find matches a relation by kind, schema and name', () => {
    const m = new DefinitionMatcher(definitions({ 'a.sql': 'CREATE TABLE sales.orders (id int);' }), 'public');
    assert.equal(m.find({ kind: 'table', schema: 'sales', name: 'orders' }).length, 1);
    assert.equal(m.find({ kind: 'table', schema: 'public', name: 'orders' }).length, 0, 'other schema');
    assert.equal(m.find({ kind: 'view', schema: 'sales', name: 'orders' }).length, 0, 'other kind');
});

test('an unqualified name belongs to the search_path of its file, else to the default schema', () => {
    const m = new DefinitionMatcher(definitions({
        'a.sql': 'CREATE TABLE plain (id int);',
        'b.sql': 'SET search_path TO app, public;\nCREATE TABLE scoped (id int);'
    }), 'main');
    assert.equal(m.find({ kind: 'table', schema: 'main', name: 'plain' }).length, 1);
    assert.equal(m.find({ kind: 'table', schema: 'app', name: 'scoped' }).length, 1);
    assert.equal(m.find({ kind: 'table', schema: 'main', name: 'scoped' }).length, 0);
});

test('functions match by their normalised argument types, so overloads are told apart', () => {
    const m = new DefinitionMatcher(definitions({
        'f.sql': `CREATE FUNCTION app.price(p int) RETURNS int AS 'x' LANGUAGE sql;
                  CREATE FUNCTION app.price(p varchar, q int8) RETURNS int AS 'x' LANGUAGE sql;`
    }), 'public');
    assert.equal(m.find({ kind: 'function', schema: 'app', name: 'price', argTypes: ['integer'] }).length, 1);
    assert.equal(m.find({ kind: 'function', schema: 'app', name: 'price', argTypes: ['character varying', 'bigint'] }).length, 1);
    assert.equal(m.find({ kind: 'function', schema: 'app', name: 'price', argTypes: ['text'] }).length, 0);
    assert.equal(m.find({ kind: 'function', schema: 'app', name: 'price', argTypes: [] }).length, 0);
});

test('the database side of a signature is normalised too, including qualified type names', () => {
    const m = new DefinitionMatcher(definitions({ 'f.sql': `CREATE FUNCTION f(m mood) RETURNS int AS 'x' LANGUAGE sql;` }), 'public');
    assert.equal(m.find({ kind: 'function', schema: 'public', name: 'f', argTypes: ['other_schema.mood'] }).length, 1);
});

test('a %TYPE argument matches any type in its position', () => {
    assert.equal(argumentTypesMatch(['?', 'text'], ['integer', 'text']), true);
    assert.equal(argumentTypesMatch(['?', 'text'], ['integer', 'integer']), false);
    assert.equal(argumentTypesMatch(['?'], ['integer', 'text']), false);
});

test('triggers match by table and name; schemas and extensions by name alone', () => {
    const m = new DefinitionMatcher(definitions({
        't.sql': `CREATE TRIGGER audit AFTER UPDATE ON sales.orders FOR EACH ROW EXECUTE FUNCTION f();
                  CREATE SCHEMA sales;
                  CREATE EXTENSION pgcrypto SCHEMA sales;`
    }), 'public');
    assert.equal(m.find({ kind: 'trigger', schema: 'sales', name: 'audit', table: 'orders' }).length, 1);
    assert.equal(m.find({ kind: 'trigger', schema: 'sales', name: 'audit', table: 'invoices' }).length, 0);
    assert.equal(m.find({ kind: 'schema', schema: '', name: 'sales' }).length, 1);
    assert.equal(m.find({ kind: 'extension', schema: '', name: 'pgcrypto' }).length, 1);
});

test('find returns every place an object is created', () => {
    const m = new DefinitionMatcher(definitions({
        'v1.sql': 'CREATE VIEW v AS SELECT 1;',
        'v2.sql': 'CREATE OR REPLACE VIEW public.v AS SELECT 2;'
    }), 'public');
    assert.deepEqual(m.find({ kind: 'view', schema: 'public', name: 'v' }).map(d => d.uri), ['v1.sql', 'v2.sql']);
});

// ===== DefinitionMatcher.unmatched =====

test('unmatched lists the repository objects missing in the database, grouped and sorted', () => {
    const m = new DefinitionMatcher(definitions({
        'a.sql': `CREATE TABLE public.kept (id int);
                  CREATE TABLE public.zeta (id int);
                  CREATE FUNCTION public.alpha(int) RETURNS int AS 'x' LANGUAGE sql;`,
        'b.sql': `CREATE TABLE public.zeta (id int, extra int);`
    }), 'public');
    const missing = m.unmatched([{ kind: 'table', schema: 'public', name: 'kept' }], new Set(['table', 'function'] as const));
    assert.deepEqual(missing.map(r => [r.identity.kind, r.identity.name, r.definitions.map(d => d.uri)]), [
        ['function', 'alpha', ['a.sql']],
        ['table', 'zeta', ['a.sql', 'b.sql']]
    ]);
});

test('unmatched only looks at the kinds asked for', () => {
    const m = new DefinitionMatcher(definitions({ 'a.sql': 'CREATE TABLE t (id int); CREATE SEQUENCE s;' }), 'public');
    assert.deepEqual(m.unmatched([], new Set(['sequence'] as const)).map(r => r.identity.name), ['s']);
});

test('an overload the database lacks is reported although another overload exists', () => {
    const m = new DefinitionMatcher(definitions({
        'f.sql': `CREATE FUNCTION f(int) RETURNS int AS 'x' LANGUAGE sql;
                  CREATE FUNCTION f(text) RETURNS int AS 'x' LANGUAGE sql;`
    }), 'public');
    const missing = m.unmatched([{ kind: 'function', schema: 'public', name: 'f', argTypes: ['integer'] }], new Set(['function'] as const));
    assert.deepEqual(missing.map(r => r.identity.argTypes), [['text']]);
});

// ===== MatcherCache =====

test('MatcherCache gives no matcher for a repository without any CREATE statement', () => {
    const cache = new MatcherCache();
    assert.equal(cache.get(null, 'public'), null);
    assert.equal(cache.get({ version: 1, definitions: [] }, 'public'), null);
});

test('MatcherCache reuses the matcher until the definitions or the default schema change', () => {
    const cache = new MatcherCache();
    const snapshot = { version: 1, definitions: definitions({ 'a.sql': 'CREATE TABLE t (id int);' }) };
    const first = cache.get(snapshot, 'public');
    assert.ok(first);
    assert.equal(cache.get(snapshot, 'public'), first);
    assert.notEqual(cache.get(snapshot, 'other'), first);
    assert.notEqual(cache.get({ ...snapshot, version: 2 }, 'other'), first);
});

// ===== DefinitionMatcher.lookup =====

test('lookup finds the definitions of a kind and name in one schema or in any', () => {
    const matcher = new DefinitionMatcher(definitions({
        'a.sql': 'CREATE FUNCTION app.f(a int) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
        'b.sql': 'SET search_path = billing;\nCREATE FUNCTION f(a text) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
        'c.sql': 'CREATE SCHEMA app;'
    }), 'public');
    assert.deepEqual(matcher.lookup('function', 'app', 'f').map(e => e.def.uri), ['a.sql']);
    assert.deepEqual(matcher.lookup('function', 'billing', 'f').map(e => e.identity.argTypes), [['text']]);
    assert.equal(matcher.lookup('function', null, 'f').length, 2);
    assert.equal(matcher.lookup('schema', 'whatever', 'app').length, 1, 'schemas have no schema');
    assert.equal([...matcher.entries()].length, 3);
});

// ===== routineStatus =====

test('a routine differs when its body matches none of its definitions; matching any one is enough', () => {
    const defs = definitions({
        'old.sql': 'CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
        'new.sql': 'CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 2 $$;'
    });
    assert.equal(routineStatus({ kind: 'function', bodyHash: defs[0].bodyHash }, defs), 'both');
    assert.equal(routineStatus({ kind: 'function', bodyHash: 'other' }, defs), 'differs');
    assert.equal(routineStatus({ kind: 'function', bodyHash: null }, defs), 'both', 'no hash (e.g. a C function) compares nothing');
    assert.equal(routineStatus({ kind: 'type', bodyHash: 'other' }, defs), 'both', 'only functions and procedures are compared');
    assert.equal(routineStatus({ kind: 'function', bodyHash: 'other' }, []), 'dbOnly');
});
