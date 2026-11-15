import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import { routineBodyHash, scanSqlText } from '../repositoryScanner';
import { DefinitionMatcher, UnmarkedObjects, type LocatedDefinition } from '../repositoryComparison';
import { DbIndex, toDbObject, type DbObject, type DbRelation } from '../databaseCatalog';
import {
    addDocCommentEdit,
    addMissingParamsEdit,
    codeAt,
    codeLensesFor,
    definitionRanges,
    docFindings,
    docTemplateAt,
    documentSymbols,
    findReferences,
    hoverMarkdown,
    objectStatus,
    objectsAt,
    parseArgumentList,
    removeEntryEdit,
    routineCompletions,
    routineFindings,
    signatureHelpAt,
    workspaceSymbols,
    type IntelSources
} from '../sqlCodeIntel';

const TAX_SQL = [
    'SET search_path = app, public;',
    '/**',
    ' * Purpose: Adds the tax to an amount.',
    ' *',
    ' * Parameters:',
    ' * - amount (NUMERIC, IN): the net amount',
    ' */',
    'CREATE FUNCTION add_tax(amount numeric) RETURNS numeric LANGUAGE sql AS $$ SELECT amount * 1.2 $$;',
    'CREATE FUNCTION add_tax(amount numeric, rate numeric DEFAULT 0.2) RETURNS numeric LANGUAGE sql AS $$ SELECT amount * (1 + rate) $$;',
    'CREATE PROCEDURE close_month(p_month date) LANGUAGE plpgsql AS $$ BEGIN PERFORM add_tax(1); END $$;',
    ''
].join('\n');

const ORDERS_SQL = [
    'CREATE TABLE app.orders (id int, total numeric);',
    'CREATE VIEW app.order_totals AS SELECT add_tax(total) FROM app.orders;',
    '/** @deprecated use add_tax */',
    'CREATE FUNCTION app.old_tax(x numeric) RETURNS numeric LANGUAGE sql AS $$ SELECT x $$;',
    ''
].join('\n');

const FILES = [
    { uri: 'file:///repo/tax.sql', text: TAX_SQL },
    { uri: 'file:///repo/orders.sql', text: ORDERS_SQL }
];

let nextOid = 100;
function dbObject(kind: string, schema: string, name: string, extra: Record<string, unknown> = {}): DbObject {
    return toDbObject({
        kind, oid: nextOid++, schema_name: schema, name, args: null, arg_types: null, detail: null,
        rel_schema: null, rel_name: null, rel_column: null, owner: 'app_owner', language: null, comment: null,
        from_extension: false, ...extra
    })!;
}

const ADD_TAX_1 = dbObject('function', 'app', 'add_tax', {
    args: 'amount numeric', arg_types: ['numeric'], full_args: 'amount numeric', min_args: 1, max_args: 1,
    detail: 'numeric', language: 'sql', comment: 'Tax for the default rate', body_hash: routineBodyHash(' SELECT amount * 1.2 ')
});
const ADD_TAX_2 = dbObject('function', 'app', 'add_tax', {
    args: 'amount numeric, rate numeric', arg_types: ['numeric', 'numeric'], full_args: 'amount numeric, rate numeric DEFAULT 0.2',
    min_args: 1, max_args: 2, detail: 'numeric', language: 'sql', body_hash: routineBodyHash('SELECT 0')
});
const CLOSE_MONTH = dbObject('procedure', 'app', 'close_month', {
    args: 'p_month date', arg_types: ['date'], full_args: 'p_month date', min_args: 1, max_args: 1, language: 'plpgsql',
    body_hash: routineBodyHash(' BEGIN PERFORM add_tax(1); END ')
});
const FEE = dbObject('function', 'billing', 'fee', { args: 'x integer', arg_types: ['integer'], full_args: 'x integer', min_args: 1, max_args: 1, detail: 'integer' });
const OBJECTS = [ADD_TAX_1, ADD_TAX_2, CLOSE_MONTH, FEE];
const RELATIONS: DbRelation[] = [{ schema: 'app', name: 'orders', kind: 'table' }];

function definitions(files = FILES): LocatedDefinition[] {
    return files.flatMap(f => scanSqlText(f.text).map(d => ({ ...d, uri: f.uri })));
}

function sources(options: { connected?: boolean; files?: typeof FILES } = {}): IntelSources {
    const connected = options.connected ?? true;
    return {
        matcher: new DefinitionMatcher(definitions(options.files), 'app'),
        db: connected ? new DbIndex(OBJECTS, RELATIONS, ['app', 'billing', 'public']) : null,
        searchPath: connected ? ['app', 'public'] : null,
        builtins: connected ? { functions: new Set(['now', 'upper', 'count']), types: new Set(['integer', 'numeric']) } : null,
        unmarked: connected ? new UnmarkedObjects([]) : null,
        allowedSchema: (s) => !s.startsWith('pg_')
    };
}

const offsetOf = (text: string, needle: string, delta = 0): number => {
    const i = text.indexOf(needle);
    assert.ok(i >= 0, `${needle} not in text`);
    return i + delta;
};

// ===== objectsAt / definitionRanges =====

test('a call resolves to the overload that takes as many arguments, and goes to its CREATE statement', () => {
    const text = 'SELECT app.add_tax(1, 0.1);';
    const at = objectsAt(text, offsetOf(text, 'add_tax', 2), 'file:///scratch.sql', sources());
    assert.ok(at);
    assert.deepEqual(at.objects.map(o => o.db?.object?.oid), [ADD_TAX_2.oid]);
    assert.deepEqual(definitionRanges(at.objects).map(r => [r.uri, r.start.line]), [['file:///repo/tax.sql', 8]]);
});

test('the name of a CREATE statement stands for the object it creates, with its database entry', () => {
    const at = objectsAt(TAX_SQL, offsetOf(TAX_SQL, 'add_tax(amount numeric)', 1), 'file:///repo/tax.sql', sources());
    assert.ok(at);
    assert.equal(at.objects.length, 1);
    assert.equal(at.objects[0].db?.object?.oid, ADD_TAX_1.oid);
    assert.deepEqual(definitionRanges(at.objects).map(r => r.start.line), [7]);
});

test('without a connection every schema matches and only the repository answers', () => {
    const text = 'CALL close_month(now()::date);';
    const at = objectsAt(text, offsetOf(text, 'close_month', 1), 'file:///scratch.sql', sources({ connected: false }));
    assert.ok(at);
    assert.equal(at.objects.length, 1);
    assert.equal(at.objects[0].db, undefined);
    assert.equal(at.objects[0].definitions[0].uri, 'file:///repo/tax.sql');
});

// ===== findReferences =====

test('references of an overload are the calls that resolve to it, in every file; the declaration only on request', () => {
    const target = objectsAt(TAX_SQL, offsetOf(TAX_SQL, 'add_tax(amount numeric)', 1), 'file:///repo/tax.sql', sources())!.objects;
    const refs = findReferences(target, FILES, sources(), false);
    assert.deepEqual(refs.map(r => [r.uri, r.start.line]), [['file:///repo/tax.sql', 9], ['file:///repo/orders.sql', 1]]);
    const withDeclaration = findReferences(target, FILES, sources(), true);
    assert.deepEqual(withDeclaration[0], { uri: 'file:///repo/tax.sql', start: { line: 7, character: 16 }, end: { line: 7, character: 23 } });
    assert.equal(withDeclaration.length, 3);
});

test('a call of another overload or of a name in another schema is no reference', () => {
    const target = objectsAt(TAX_SQL, offsetOf(TAX_SQL, 'add_tax(amount numeric)', 1), 'file:///repo/tax.sql', sources())!.objects;
    const other = { uri: 'file:///other.sql', text: 'SELECT add_tax(1, 2), billing.add_tax(1);' };
    assert.deepEqual(findReferences(target, [other], sources(), false), []);
});

// ===== symbols =====

test('the outline lists every CREATE statement with its signature, statement range and doc summary', () => {
    const symbols = documentSymbols(TAX_SQL);
    assert.deepEqual(symbols.map(s => [s.name, s.kind, s.detail]), [
        ['add_tax(amount numeric)', 'function', 'Adds the tax to an amount.'],
        ['add_tax(amount numeric, rate numeric DEFAULT 0.2)', 'function', 'function'],
        ['close_month(p_month date)', 'procedure', 'procedure']
    ]);
    assert.deepEqual([symbols[0].start.line, symbols[0].selectionStart], [7, { line: 7, character: 16 }]);
});

test('workspace symbols match fuzzily, closest names first', () => {
    const found = workspaceSymbols(definitions(), 'tax');
    assert.deepEqual(found.map(f => f.def.name), ['add_tax', 'add_tax', 'old_tax']);
    assert.deepEqual(workspaceSymbols(definitions(), 'addtx').map(f => f.def.name), ['add_tax', 'add_tax']);
    assert.deepEqual(workspaceSymbols(definitions(), 'zzz'), []);
    assert.equal(workspaceSymbols(definitions(), '', 2).length, 2);
});

// ===== hover =====

test('the hover shows the signature, the repository doc first, the different database comment below, the status and the links', () => {
    const src = sources();
    const [object] = objectsAt(TAX_SQL, offsetOf(TAX_SQL, 'add_tax(amount numeric)', 1), 'file:///repo/tax.sql', src)!.objects;
    const md = hoverMarkdown({ object, status: objectStatus(object, src) });
    assert.match(md, /function app\.add_tax\(amount numeric\) → numeric/);
    assert.ok(md.indexOf('Adds the tax to an amount.') < md.indexOf('**Database comment:** Tax for the default rate'));
    assert.match(md, /\| amount \| numeric \| IN \| the net amount \|/);
    assert.match(md, /In the database and in the repository/);
    const link = /\[Open CREATE Script\]\(command:postgresQueryBuilder\.openCreateScript\?([^)]+)\)/.exec(md);
    assert.ok(link);
    const [node] = JSON.parse(decodeURIComponent(link[1]));
    assert.deepEqual([node.type, node.kind, node.db.oid], ['object', 'function', ADD_TAX_1.oid]);
    assert.match(md, /Compare with Database/);
});

test('the hover of a relation lists its columns and says how many more there are', () => {
    const src = sources();
    const text = 'SELECT * FROM app.orders;';
    const [object] = objectsAt(text, offsetOf(text, 'orders', 1), 'file:///x.sql', src)!.objects;
    const md = hoverMarkdown({ object, columns: [{ name: 'id', type: 'integer' }], columnCount: 3 });
    assert.match(md, /table app\.orders/);
    assert.match(md, /\| id \| integer \|/);
    assert.match(md, /and 2 more columns/);
});

test('the status of a routine whose body matches no definition is differs; a deprecated doc is struck through', () => {
    const src = sources();
    const second = objectsAt(TAX_SQL, offsetOf(TAX_SQL, 'add_tax(amount numeric, rate', 1), 'file:///repo/tax.sql', src)!.objects[0];
    assert.equal(objectStatus(second, src), 'differs');
    const old = objectsAt(ORDERS_SQL, offsetOf(ORDERS_SQL, 'old_tax', 1), 'file:///repo/orders.sql', src)!.objects[0];
    assert.equal(objectStatus(old, src), 'repoOnly');
    assert.match(hoverMarkdown({ object: old, status: 'repoOnly' }), /\*\*~~Deprecated~~\*\* use add\\_tax/);
});

// ===== signature help =====

test('signature help lists the overloads, activates the one that fits and the argument the cursor is in', () => {
    const text = 'SELECT add_tax(1, ';
    const help = signatureHelpAt(text, text.length, sources());
    assert.ok(help);
    assert.deepEqual(help.signatures.map(s => s.label), [
        'app.add_tax(amount numeric) → numeric',
        'app.add_tax(amount numeric, rate numeric DEFAULT 0.2) → numeric'
    ]);
    assert.equal(help.activeSignature, 1);
    assert.equal(help.activeParameter, 1);
    const [start, end] = help.signatures[1].parameters[1].label;
    assert.equal(help.signatures[1].label.slice(start, end), 'rate numeric DEFAULT 0.2');
    assert.equal(help.signatures[0].parameters[0].documentation, 'the net amount');
});

test('in named notation the named parameter is the active one', () => {
    const text = 'SELECT add_tax(rate => ';
    const help = signatureHelpAt(text, text.length, sources());
    assert.ok(help);
    assert.equal(help.activeSignature, 0);
    assert.equal(help.activeParameter, 0);
    const named = signatureHelpAt('SELECT add_tax(1, rate => ', 26, sources());
    assert.equal(named?.activeParameter, 1);
});

// ===== completion =====

test('completion offers functions while typing a name, procedures after CALL, as snippets with the required parameters', () => {
    const functions = routineCompletions('SELECT ad', 9, sources());
    assert.deepEqual(functions.map(c => [c.label, c.insertText]), [
        ['add_tax', 'add_tax(${1:amount})$0'],
        ['add_tax', 'add_tax(${1:amount})$0']
    ]);
    assert.equal(functions[1].labelDetail, '(amount numeric, rate numeric DEFAULT 0.2)');
    assert.equal(functions[0].description, 'app · → numeric');
    const procedures = routineCompletions('CALL ', 5, sources());
    assert.deepEqual(procedures.map(c => c.label), ['close_month']);
});

test('completion after schema. offers that schema only; outside the search_path a routine is inserted qualified', () => {
    assert.deepEqual(routineCompletions('SELECT billing.', 15, sources()).map(c => c.insertText), ['fee(${1:x})$0']);
    assert.deepEqual(routineCompletions('SELECT f', 8, sources()).map(c => c.insertText), ['billing.fee(${1:x})$0']);
});

test('completion includes routines only the repository has and marks deprecated ones; nothing in comments and strings', () => {
    const old = routineCompletions('SELECT ol', 9, sources());
    assert.deepEqual(old.map(c => [c.label, c.deprecated]), [['old_tax', true]]);
    assert.deepEqual(routineCompletions('-- SELECT ad', 12, sources()), []);
    assert.deepEqual(routineCompletions("SELECT 'ad", 10, sources()), [], 'an unterminated string is still a string');
    const body = 'CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM ad';
    assert.equal(routineCompletions(body, body.length, sources()).length, 2, 'in a body not closed yet');
    const closed = 'DO $$ BEGIN PERFORM ad END $$;';
    assert.equal(routineCompletions(closed, offsetOf(closed, 'ad ', 2), sources()).length, 2);
});

test('codeAt answers the code of a $$ body and null inside comments and strings', () => {
    const text = "SELECT 1; /* x */ DO $$ BEGIN PERFORM f(); END $$; SELECT 'abc';";
    assert.equal(codeAt(text, offsetOf(text, 'x */')), null);
    assert.equal(codeAt(text, offsetOf(text, 'abc', 1)), null);
    const inner = codeAt(text, offsetOf(text, 'f()', 1));
    assert.ok(inner);
    assert.equal(inner.text.slice(inner.offset - 1, inner.offset + 2), 'f()');
});

// ===== doc comment template =====

test('typing /** above a CREATE FUNCTION offers a doc comment with one entry per parameter', () => {
    const text = 'SELECT 1;\n  /**\n  CREATE FUNCTION f(p_a integer, OUT p_b text) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;';
    const template = docTemplateAt(text, offsetOf(text, '/**', 3));
    assert.ok(template);
    assert.equal(text.slice(template.replaceStart, template.replaceEnd), '/**');
    assert.match(template.snippet, /^\/\*\*\n {3}\* Purpose: \$\{1\}/);
    assert.match(template.snippet, /\n {3}\* - p_a \(integer, IN\): \$\{3\}\n {3}\* - p_b \(text, OUT\): \$\{4\}/);
    assert.match(template.snippet, /Returns: \$\{5:integer\}\n {3}\*\/$/);
});

test('no template when the next statement is no function or a statement stands in between', () => {
    assert.equal(docTemplateAt('/**\nCREATE TABLE t (a int);', 3), undefined);
    assert.equal(docTemplateAt('/**\nSELECT 1;\nCREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;', 3), undefined);
    assert.equal(docTemplateAt('x /**\nCREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;', 5), undefined);
    assert.ok(docTemplateAt('/** */\nCREATE PROCEDURE p() LANGUAGE sql AS $$ SELECT 1 $$;', 3), 'an auto-closed comment is replaced as well');
});

// ===== CodeLens =====

test('CodeLens says for every CREATE statement whether its object is in the database, differs or is missing', () => {
    const lenses = codeLensesFor(TAX_SQL, 'file:///repo/tax.sql', sources()).map(l => [l.object.name, l.status, l.start.line]);
    assert.deepEqual(lenses, [['add_tax', 'both', 7], ['add_tax', 'differs', 8], ['close_month', 'both', 9]]);
    const orders = codeLensesFor(ORDERS_SQL, 'file:///repo/orders.sql', sources()).map(l => [l.object.name, l.status]);
    assert.deepEqual(orders, [['orders', 'both'], ['order_totals', 'repoOnly'], ['old_tax', 'repoOnly']]);
    assert.deepEqual(codeLensesFor(TAX_SQL, 'file:///repo/tax.sql', sources({ connected: false })), []);
});

// ===== diagnostics =====

test('unknown routines and argument counts no overload takes are reported; built-ins, records and casts are not', () => {
    const text = [
        'SELECT nosuch(1);',
        'SELECT now(), upper(\'x\'), integer(\'1\');',
        'SELECT add_tax(1, 2, 3);',
        'SELECT rec.method(1);',
        'CALL close_month(now()::date);',
        "EXECUTE 'SELECT nosuch_either(1)';"
    ].join('\n');
    const findings = routineFindings(text, sources());
    assert.deepEqual(findings.map(f => [f.code, f.start.line]), [['unknownRoutine', 0], ['argumentCount', 2]]);
    assert.match(findings[0].message, /Unknown function nosuch/);
    assert.match(findings[1].message, /No overload of add_tax takes 3 arguments/);
});

test('a built-in that shares its name with a user routine is never reported for its argument count', () => {
    const src = sources();
    src.builtins!.functions.add('add_tax');
    assert.deepEqual(routineFindings('SELECT add_tax(1, 2, 3);', src), []);
});

test('nothing is reported without a connection', () => {
    assert.deepEqual(routineFindings('SELECT nosuch(1);', sources({ connected: false })), []);
});

// ===== doc checks and quick fixes =====

const DOC_SQL = [
    '/**',
    ' * Purpose: Does it.',
    ' *',
    ' * Parameters:',
    ' * - p_a (INTEGER, IN): first',
    ' * - p_gone (TEXT, IN): removed long ago',
    ' */',
    'CREATE FUNCTION f(p_a integer, p_b text) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;',
    'CREATE PROCEDURE p() LANGUAGE sql AS $$ SELECT 1 $$;',
    ''
].join('\n');

test('doc checks find undocumented and unknown parameters and routines without a doc comment', () => {
    assert.deepEqual(docFindings(DOC_SQL).map(f => [f.code, f.param ?? null, f.start.line]), [
        ['unknownParam', 'p_gone', 5],
        ['undocumentedParam', 'p_b', 7],
        ['missingDoc', null, 8]
    ]);
});

test('the quick fixes add the missing entries, remove an unknown entry and add a doc comment', () => {
    const [f, p] = scanSqlText(DOC_SQL);
    const add = addMissingParamsEdit(f);
    assert.ok(add);
    assert.equal(add.text, '\n * - p_b (text, IN): ');
    assert.deepEqual(add.start, { line: 5, character: 40 });
    const remove = removeEntryEdit(f, 'p_gone');
    assert.deepEqual([remove?.start, remove?.end, remove?.text], [{ line: 5, character: 0 }, { line: 6, character: 0 }, '']);
    const doc = addDocCommentEdit(DOC_SQL, p);
    assert.deepEqual(doc.start, { line: 8, character: 0 });
    assert.match(doc.text, /^\/\*\*\n \* Purpose: \n[\s\S]* \* - None\n \*\/\n$/);
});

// ===== parseArgumentList =====

test('the argument list of pg_get_function_arguments is read with modes and defaults', () => {
    const params = parseArgumentList('function', "amount numeric, rate numeric DEFAULT 0.2, OUT total numeric, VARIADIC tags text[] DEFAULT '{}'::text[]");
    assert.deepEqual(params.map(p => [p.name, p.mode, p.type, p.defaultValue]), [
        ['amount', 'in', 'numeric', null],
        ['rate', 'in', 'numeric', '0.2'],
        ['total', 'out', 'numeric', null],
        ['tags', 'variadic', 'text[]', "'{}'::text[]"]
    ]);
    assert.deepEqual(parseArgumentList('procedure', 'INOUT p_x integer').map(p => [p.name, p.mode]), [['p_x', 'inout']]);
});
