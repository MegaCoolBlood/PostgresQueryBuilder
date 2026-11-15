import test from 'node:test';
import assert from 'node:assert/strict';
import { enclosingCall, referenceAt, referencesIn, type SqlReference } from '../sqlReferences';

/** The references of a text as `name:kinds[0]:call/argCount`, in order. */
function refs(text: string): string[] {
    return referencesIn(text).map(describe);
}

/** The same, for the given names only: bare column names are candidates for relations too. */
function refsOf(text: string, ...names: string[]): string[] {
    return referencesIn(text).filter(r => names.includes(r.name)).map(describe);
}

function describe(r: SqlReference): string {
    const name = r.schema ? `${r.schema}.${r.name}` : r.name;
    return `${name}:${r.kinds[0]}${r.call ? `(${r.argCount ?? '?'})` : ''}${r.declaration ? ':decl' : ''}`;
}

function at(text: string, needle: string, delta = 1): SqlReference | undefined {
    const i = text.indexOf(needle);
    assert.ok(i >= 0, `${needle} not in text`);
    return referenceAt(text, i + delta);
}

// ===== what a name stands for =====

test('CALL names a procedure, a name followed by ( a function, FROM a relation, :: a type', () => {
    assert.deepEqual(refs('CALL app.close_month(1, 2);'), ['app.close_month:procedure(2)']);
    assert.deepEqual(refsOf('SELECT f(1) FROM app.orders o;', 'f', 'orders'), ['f:function(1)', 'app.orders:table']);
    assert.deepEqual(refs("SELECT '1'::app.mood;"), ['app.mood:type']);
});

test('the name of a CREATE statement is a declaration of its kind', () => {
    assert.deepEqual(refsOf('CREATE OR REPLACE FUNCTION app.f(a integer) RETURNS integer LANGUAGE sql AS $$ SELECT a $$;', 'f', 'integer'),
        ['app.f:function:decl', 'integer:type', 'integer:type']);
    assert.deepEqual(refs('CREATE MATERIALIZED VIEW mv AS SELECT 1;'), ['mv:matview:decl']);
});

test('INSERT INTO t (cols), REFERENCES t (id) and CREATE INDEX … ON t (col) name relations, not calls', () => {
    assert.deepEqual(refsOf('INSERT INTO app.orders (id) VALUES (1);', 'orders'), ['app.orders:table']);
    assert.deepEqual(refsOf('CREATE TABLE t (id int REFERENCES app.customers (id));', 't', 'int', 'customers'),
        ['t:table:decl', 'int:type', 'app.customers:table']);
    assert.deepEqual(refsOf('CREATE INDEX ix ON app.orders (total);', 'orders'), ['app.orders:table']);
});

test('the access method of an index and the arguments of a cursor are no calls', () => {
    assert.deepEqual(refs('CREATE INDEX ix ON t USING btree (a);').filter(r => r.startsWith('btree')), []);
    assert.deepEqual(refs('ALTER TABLE t ADD EXCLUDE USING gist (r WITH &&);').filter(r => r.startsWith('gist')), []);
    const body = 'DO $$ BEGIN OPEN cu(1); FOR r IN cu_x(2) LOOP NULL; END LOOP; END $$;';
    assert.deepEqual(refs(body).filter(r => r.startsWith('cu')), []);
});

test('keywords that take parentheses, type modifiers and aliases are no references', () => {
    assert.deepEqual(refsOf('SELECT COALESCE(a, 1), CAST(b AS numeric(10, 2)) AS total FROM t;', 'coalesce', 'cast', 'numeric', 'total', 't'),
        ['numeric:type', 't:table']);
    assert.deepEqual(refsOf('SELECT 1 FROM t WHERE EXISTS (SELECT 1) AND x IN (1, 2);', 'exists', 'in', 't'), ['t:table']);
});

test('named arguments are counted but are no references themselves', () => {
    const [call] = referencesIn('SELECT f(p_a => 1, p_b := 2);');
    assert.equal(describe(call), 'f:function(2)');
    assert.deepEqual(call.namedArgs, ['p_a', 'p_b']);
});

test('nested calls count their own arguments; f() takes none and count(*) none either', () => {
    assert.deepEqual(refs('SELECT f(g(1, 2), 3), h(), count(*) FROM t;'), ['f:function(2)', 'g:function(2)', 'h:function(0)', 'count:function(0)', 't:table']);
});

test('calls inside the bodies of functions and DO blocks are found; comments and strings are not', () => {
    const text = [
        'CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $body$',
        'BEGIN',
        '  -- PERFORM in_comment(1);',
        "  RAISE NOTICE 'in_string(1)';",
        '  PERFORM app.inner_call(1);',
        'END $body$;',
        'DO $$ BEGIN CALL p(); END $$;'
    ].join('\n');
    const found = refs(text);
    assert.ok(found.includes('app.inner_call:function(1)'));
    assert.ok(found.includes('p:procedure(0)'));
    assert.ok(!found.some(r => r.startsWith('in_comment') || r.startsWith('in_string')));
});

test('the sequence of nextval is read from its string', () => {
    assert.deepEqual(refs("SELECT nextval('app.orders_id_seq');").filter(r => r.includes('seq')), ['app.orders_id_seq:sequence']);
});

test('a SET search_path earlier in the file goes with every later reference', () => {
    const call = referencesIn('SET search_path = billing, public;\nSELECT fee(1);').find(r => r.name === 'fee');
    assert.equal(call?.name, 'fee');
    assert.deepEqual(call?.searchPath, ['billing', 'public']);
});

// ===== referenceAt =====

test('referenceAt answers the name under the cursor, the schema part as a schema', () => {
    const text = 'SELECT app.add_tax(1);';
    assert.equal(describe(at(text, 'add_tax')!), 'app.add_tax:function(1)');
    assert.equal(describe(at(text, 'app.')!), 'app:schema');
    assert.equal(at('SELECT 1; -- add_tax(1)', 'add_tax'), undefined);
    assert.equal(at('SELECT 1 FROM t', 'SELECT'), undefined, 'keywords are no references');
});

test('referenceAt finds a trigger together with its table', () => {
    const ref = at('CREATE TRIGGER trg_audit AFTER INSERT ON app.orders FOR EACH ROW EXECUTE FUNCTION app.audit();', 'trg_audit');
    assert.ok(ref);
    assert.deepEqual([ref.kinds[0], ref.declaration, ref.table], ['trigger', true, { schema: 'app', name: 'orders' }]);
});

// ===== enclosingCall =====

test('enclosingCall answers the innermost call and the argument the cursor is in', () => {
    const text = 'SELECT f(1, g(2, ';
    const call = enclosingCall(text, text.length);
    assert.equal(call?.reference.name, 'g');
    assert.equal(call?.activeArgument, 1);
    const outer = 'SELECT f(1, g(2), ';
    assert.deepEqual([enclosingCall(outer, outer.length)?.reference.name, enclosingCall(outer, outer.length)?.activeArgument], ['f', 2]);
});

test('enclosingCall knows the parameter named in named notation, and ignores parentheses in strings', () => {
    const text = "SELECT f('(', p_b => ";
    const call = enclosingCall(text, text.length);
    assert.deepEqual([call?.reference.name, call?.activeArgument, call?.activeName], ['f', 1, 'p_b']);
    assert.equal(enclosingCall('SELECT (1 + ', 12), undefined, 'a parenthesis without a name is no call');
});
