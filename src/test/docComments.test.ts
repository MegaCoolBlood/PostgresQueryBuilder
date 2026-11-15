import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDocComment, docCommentTemplate, docForParam, docSummary, entryRemoval, firstSentence, missingParamsEdit, parseDocComment } from '../docComments';
import { scanSqlText } from '../repositoryScanner';

// ===== parseDocComment =====

test('the section style yields summary, description, parameters with type and mode, and the result', () => {
    const doc = parseDocComment([
        '/**',
        ' * Purpose: Adds the tax to an amount. Rounds to cents.',
        ' *',
        ' * Explanation: Uses the rate of the given day.',
        ' *',
        ' * Parameters:',
        ' * - amount (NUMERIC, IN): the net amount',
        ' * - p_day (DATE, IN): the day of the rate',
        ' *',
        ' * Returns: the gross amount',
        ' */'
    ].join('\n'));
    assert.equal(doc.summary, 'Adds the tax to an amount.');
    assert.match(doc.description, /Uses the rate of the given day\./);
    assert.deepEqual(doc.params.map(p => [p.name, p.type, p.mode, p.text]), [
        ['amount', 'NUMERIC', 'IN', 'the net amount'],
        ['p_day', 'DATE', 'IN', 'the day of the rate']
    ]);
    assert.equal(doc.returns, 'the gross amount');
});

test('Javadoc tags yield parameters, result, exceptions, deprecation, links and examples', () => {
    const doc = parseDocComment([
        '/**',
        ' * Closes the month.',
        ' * @param p_month first day of the month',
        ' * @return nothing',
        ' * @throws P0001 when the month is open',
        ' * @deprecated use close_period',
        ' * @see close_period',
        ' * @since 3.1',
        ' * @example CALL close_month(DATE \'2024-01-01\');',
        ' */'
    ].join('\n'));
    assert.equal(doc.summary, 'Closes the month.');
    assert.deepEqual(doc.params.map(p => [p.name, p.text, p.style]), [['p_month', 'first day of the month', 'tag']]);
    assert.equal(doc.returns, 'nothing');
    assert.deepEqual(doc.throws, ['P0001 when the month is open']);
    assert.equal(doc.deprecated, 'use close_period');
    assert.deepEqual(doc.see, ['close_period']);
    assert.deepEqual(doc.examples, ["CALL close_month(DATE '2024-01-01');"]);
    assert.deepEqual(doc.other, [{ tag: 'since', text: '3.1' }]);
});

test('a bare @deprecated is an empty deprecation text, not a missing one', () => {
    assert.equal(parseDocComment('/** Old. @deprecated */').deprecated, '');
    assert.equal(parseDocComment('/** New. */').deprecated, undefined);
});

test('the two styles mixed: the tag text wins, the section supplies type and mode', () => {
    const doc = parseDocComment([
        '/**',
        ' * Purpose: Sets it.',
        ' * Parameters:',
        ' * - p_x (INTEGER, INOUT): x',
        ' * @param p_x the value to set and to return',
        ' */'
    ].join('\n'));
    assert.deepEqual(doc.params.map(p => [p.name, p.type, p.mode, p.text]), [['p_x', 'INTEGER', 'INOUT', 'the value to set and to return']]);
});

test('the repeated labels of the generated leda comments are cleaned up', () => {
    const doc = parseDocComment([
        '/**',
        ' * Purpose: Purpose: Debug print: emits the given string as a NOTICE to the client',
        ' *',
        ' * Explanation: Purpose: Debug print: emits the given string as a NOTICE to the client Explanation:',
        ' * Debug print: emits the given string as a NOTICE to the client. Useful for tracing',
        ' * values during interactive sessions or test runs. Returns VOID; has no side effects',
        ' * beyond the NOTICE message. Parameters: s (VARCHAR, IN): string as a NOTICE to the',
        ' * client.',
        ' *',
        ' * Parameters:',
        ' * - s (VARCHAR, IN): string as a NOTICE to the client',
        ' */'
    ].join('\n'));
    assert.equal(doc.summary, 'Debug print: emits the given string as a NOTICE to the client.');
    assert.ok(!/Purpose:|Explanation:|Parameters:/.test(doc.description), doc.description);
    assert.match(doc.description, /Useful for tracing values during interactive sessions/);
    assert.deepEqual(doc.params.map(p => [p.name, p.type, p.text]), [['s', 'VARCHAR', 'string as a NOTICE to the client']]);
});

test('-- lines above a statement are a plain summary', () => {
    const [def] = scanSqlText('-- Returns the answer.\n-- Always 42.\nCREATE FUNCTION answer() RETURNS int LANGUAGE sql AS $$ SELECT 42 $$;');
    assert.ok(def.doc);
    assert.equal(def.doc.block, false);
    assert.equal(parseDocComment(def.doc.text).summary, 'Returns the answer.');
});

test('the doc comment of a statement is the block right above it, also across blank lines, never one above another statement', () => {
    const [withBlank] = scanSqlText('/** Doc of f. */\n\n\nCREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;');
    assert.equal(withBlank.doc?.text, '/** Doc of f. */');
    const [, g] = scanSqlText('/** Doc of t. */\nCREATE TABLE t (a int);\nCREATE FUNCTION g() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;');
    assert.equal(g.doc, undefined);
});

test('firstSentence stops at the first full stop that ends a sentence, not at an abbreviation', () => {
    assert.equal(firstSentence('Reads the rows, i.e. all of them. Then stops.'), 'Reads the rows, i.e. all of them.');
    assert.equal(firstSentence('No full stop'), 'No full stop');
});

test('docSummary and docForParam read the first doc comment and match names case-insensitively', () => {
    const defs = scanSqlText('/** Sums it. @param P_A the first */\nCREATE FUNCTION s(p_a int) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;');
    assert.equal(docSummary(defs), 'Sums it.');
    assert.equal(docForParam(parseDocComment(defs[0].doc!.text), 'p_a')?.text, 'the first');
    assert.equal(docSummary([]), undefined);
});

// ===== template =====

test('the template lists every parameter in signature order with type and mode, and the result of a function', () => {
    const [f] = scanSqlText('CREATE FUNCTION f(p_a integer, INOUT p_b text DEFAULT \'x\', OUT p_c date) RETURNS record LANGUAGE sql AS $$ SELECT 1 $$;');
    assert.equal(docCommentTemplate(f, '', false), [
        '/**',
        ' * Purpose: ',
        ' *',
        ' * Explanation: ',
        ' *',
        ' * Parameters:',
        ' * - p_a (integer, IN): ',
        ' * - p_b (text, INOUT): ',
        ' * - p_c (date, OUT): ',
        ' *',
        ' * Returns: record',
        ' */'
    ].join('\n'));
    const [p] = scanSqlText('CREATE PROCEDURE p() LANGUAGE sql AS $$ SELECT 1 $$;');
    assert.match(docCommentTemplate(p, '    ', true), /^\/\*\*\n {5}\* Purpose: \$\{1\}[\s\S]* {5}\* - None\n {5}\*\/$/);
});

// ===== checks and edits =====

test('the checks report every kind of finding with its position', () => {
    const text = [
        '/**',
        ' * Purpose: Does it.',
        ' * Parameters:',
        ' * - p_a (VARCHAR, IN): first',
        ' * - p_old (TEXT, IN): gone',
        ' */',
        'CREATE FUNCTION f(p_a integer, p_b text) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;'
    ].join('\n');
    const [def] = scanSqlText(text);
    assert.deepEqual(checkDocComment(def).map(f => [f.code, f.param, f.start.line]), [
        ['typeMismatch', 'p_a', 3],
        ['unknownParam', 'p_old', 4],
        ['undocumentedParam', 'p_b', 6]
    ]);
    const [noDoc] = scanSqlText('CREATE FUNCTION g() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;');
    assert.deepEqual(checkDocComment(noDoc).map(f => f.code), ['missingDoc']);
    const [table] = scanSqlText('CREATE TABLE t (a int);');
    assert.deepEqual(checkDocComment(table), [], 'only functions and procedures are checked');
});

test('missing entries are added in the style of the comment: as a Parameters entry or as @param', () => {
    const [section] = scanSqlText('/**\n * Parameters:\n * - p_a (INTEGER, IN): a\n */\nCREATE FUNCTION f(p_a integer, p_b text) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;');
    assert.equal(missingParamsEdit(section)?.text, '\n * - p_b (text, IN): ');
    const [tags] = scanSqlText('/**\n * Does it.\n * @param p_a a\n */\nCREATE FUNCTION f(p_a integer, p_b text) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;');
    assert.equal(missingParamsEdit(tags)?.text, '\n * @param p_b ');
    const [complete] = scanSqlText('/** @param p_a a */\nCREATE FUNCTION f(p_a integer) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;');
    assert.equal(missingParamsEdit(complete), undefined);
});

test('an entry on lines of its own can be removed, line break included', () => {
    const text = '/**\n * @param p_a a\n * @param p_old gone\n */\nCREATE FUNCTION f(p_a integer) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;';
    const [def] = scanSqlText(text);
    const removal = entryRemoval(def, 'p_old');
    assert.ok(removal);
    const raw = def.doc!.text;
    assert.equal(raw.slice(0, removal.start) + raw.slice(removal.end), '/**\n * @param p_a a\n */');
    assert.equal(entryRemoval(def, 'p_none'), undefined);
});
