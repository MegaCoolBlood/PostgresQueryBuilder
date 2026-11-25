import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {
    parseQueryPlaceholders as tsParsePlaceholders,
    placeholderNames as tsPlaceholderNames,
    renderParameterValue as tsRenderParameterValue,
    applyQueryParameters as tsApplyQueryParameters,
    mergeParameters as tsMergeParameters
} from '../savedQueryStore';

const {
    parseQueryPlaceholders,
    placeholderNames,
    renderParameterValue,
    applyQueryParameters,
    initialQueryParamDraft,
    queryParamDraftValues
} = require(path.join(__dirname, '../../../src/webview/tableView.js'));

// ===== parseQueryPlaceholders (webview copy) =====

test('parseQueryPlaceholders finds placeholders with their offsets', () => {
    assert.deepEqual(
        parseQueryPlaceholders('SELECT * FROM t WHERE id = :id'),
        [{ name: 'id', start: 27, end: 30 }]
    );
});

test('parseQueryPlaceholders ignores a :: cast', () => {
    assert.deepEqual(placeholderNames('SELECT a::text FROM t'), []);
});

test('parseQueryPlaceholders keeps the placeholder in front of a cast', () => {
    assert.deepEqual(placeholderNames('SELECT * FROM t WHERE id = :id::int'), ['id']);
});

test('parseQueryPlaceholders ignores a colon name inside a string literal', () => {
    assert.deepEqual(placeholderNames("SELECT * FROM t WHERE a = ':not_a_param'"), []);
});

test('parseQueryPlaceholders ignores a colon name inside a line comment', () => {
    assert.deepEqual(placeholderNames('SELECT 1 -- :nope\nFROM t WHERE a = :yes'), ['yes']);
});

test('parseQueryPlaceholders ignores a colon name inside a block comment', () => {
    assert.deepEqual(placeholderNames('SELECT 1 /* :nope */ FROM t'), []);
});

test('parseQueryPlaceholders ignores a colon name inside a dollar-quoted string', () => {
    assert.deepEqual(placeholderNames('SELECT $$ :nope $$ FROM t'), []);
});

test('parseQueryPlaceholders reports repeated names once per occurrence', () => {
    assert.equal(parseQueryPlaceholders('SELECT :a, :a FROM t').length, 2);
    assert.deepEqual(placeholderNames('SELECT :a, :a FROM t'), ['a']);
});

test('parseQueryPlaceholders returns nothing for empty input', () => {
    assert.deepEqual(parseQueryPlaceholders(''), []);
    assert.deepEqual(parseQueryPlaceholders(undefined), []);
});

// ===== renderParameterValue (webview copy) =====

test('renderParameterValue quotes text and doubles single quotes', () => {
    assert.equal(renderParameterValue("O'Brien", 'text'), "'O''Brien'");
});

test('renderParameterValue passes a valid number through', () => {
    assert.equal(renderParameterValue(' 42 ', 'number'), '42');
    assert.equal(renderParameterValue('-3.5', 'number'), '-3.5');
});

test('renderParameterValue rejects an injection attempt in a number', () => {
    assert.throws(() => renderParameterValue('1; DROP TABLE t', 'number'), /not a valid number/);
});

test('renderParameterValue quotes an identifier and doubles double quotes', () => {
    assert.equal(renderParameterValue('my"col', 'identifier'), '"my""col"');
});

test('renderParameterValue passes raw text through unchanged', () => {
    assert.equal(renderParameterValue('a > 1', 'raw'), 'a > 1');
});

test('renderParameterValue treats an unknown kind as text', () => {
    assert.equal(renderParameterValue('x', 'weird'), "'x'");
});

// ===== applyQueryParameters (webview copy) =====

test('applyQueryParameters substitutes every occurrence', () => {
    const sql = 'SELECT * FROM t WHERE a = :v OR b = :v';
    assert.equal(
        applyQueryParameters(sql, { v: 'x' }, [{ name: 'v', kind: 'text' }]),
        "SELECT * FROM t WHERE a = 'x' OR b = 'x'"
    );
});

test('applyQueryParameters does not substitute inside an inserted value', () => {
    const sql = 'SELECT :a, :b FROM t';
    assert.equal(
        applyQueryParameters(sql, { a: ':b', b: 'z' }, [{ name: 'a', kind: 'text' }, { name: 'b', kind: 'text' }]),
        "SELECT ':b', 'z' FROM t"
    );
});

test('applyQueryParameters falls back to the default value', () => {
    assert.equal(
        applyQueryParameters('SELECT :a', {}, [{ name: 'a', kind: 'number', defaultValue: '7' }]),
        'SELECT 7'
    );
});

test('applyQueryParameters throws when a value is missing', () => {
    assert.throws(
        () => applyQueryParameters('SELECT :a', {}, [{ name: 'a', kind: 'text' }]),
        /No value supplied for :a/
    );
});

test('applyQueryParameters returns the SQL unchanged without placeholders', () => {
    assert.equal(applyQueryParameters('SELECT 1', {}, []), 'SELECT 1');
});

test('applyQueryParameters matches names case-insensitively', () => {
    assert.equal(
        applyQueryParameters('SELECT :Name', { name: 'x' }, [{ name: 'Name', kind: 'text' }]),
        "SELECT 'x'"
    );
});

// ===== Parity between the extension host and the webview copies =====

const PARITY_SQL = [
    'SELECT * FROM t WHERE id = :id',
    'SELECT a::text FROM t WHERE b = :b',
    "SELECT * FROM t WHERE a = ':not_a_param' AND b = :b",
    'SELECT 1 -- :nope\nFROM t WHERE a = :yes',
    'SELECT 1 /* :nope */ FROM t WHERE a = :yes',
    'SELECT $$ :nope $$, :real FROM t',
    'SELECT :a, :a, :b FROM t',
    'SELECT * FROM t WHERE d BETWEEN :from AND :to',
    'SELECT 1',
    'SELECT arr[1:3] FROM t',
    'SELECT a[1:n] FROM t WHERE a[lo:hi] = ARRAY[:x]',
    'SELECT a[:n], "c[d"[1:e], myarray[:k] FROM t WHERE b = array /* c */ [ :y, :z ][1:m]'
];

test('webview parseQueryPlaceholders matches the extension implementation', () => {
    for (const sql of PARITY_SQL) {
        assert.deepEqual(parseQueryPlaceholders(sql), tsParsePlaceholders(sql), sql);
        assert.deepEqual(placeholderNames(sql), tsPlaceholderNames(sql), sql);
    }
});

/** The rendered SQL, or the message of the error thrown instead. */
function outcome(run: () => string): string {
    try { return run(); } catch (err: unknown) { return `Error: ${(err as Error).message}`; }
}

test('webview renderParameterValue matches the extension implementation', () => {
    const cases: Array<[string | null, any]> = [
        ["O'Brien", 'text'],
        ['42', 'number'],
        ['-3.5', 'number'],
        ['my"col', 'identifier'],
        ['a > 1', 'raw'],
        [null, 'text'],
        [null, 'number'],
        [null, 'raw']
    ];
    const dateInputs = [
        '2026-11-25', '25.11.2026', ' 5.1.2026 ', '2026-11-25T10:39', '2026-11-25 10:39', '2026-11-25T 10:39',
        '2026-11-25 10:39:15', '2026-11-25 10:39:15.123456', '2026-11-25 10:39+01', '2026-11-25T10:39:15Z',
        '2026-11-25 10:39 -05:30', '25.11.2026 7:05', 'infinity', '-infinity', '+Infinity', null
    ];
    for (const value of dateInputs) {
        cases.push([value, 'date'], [value, 'timestamp']);
    }
    for (const [value, kind] of cases) {
        assert.equal(
            outcome(() => renderParameterValue(value, kind)),
            outcome(() => tsRenderParameterValue(value, kind)),
            `${value}/${kind}`
        );
    }
});

test('webview renderParameterValue rejects the same invalid input with the same message', () => {
    const invalid: Array<[string | null, any]> = [
        ['31.02.2026', 'date'], ['2026-13-01', 'date'], ['0000-01-01', 'date'], ['2026-11-25 10:39+01', 'date'],
        ['now', 'date'], ['', 'date'], ['2026-11-25 24:00', 'timestamp'], ['2026-11-25 10:60', 'timestamp'],
        ['2026-11-25 10:39:60', 'timestamp'], ['2023-02-29 10:00', 'timestamp'], ["2026-11-25'; --", 'timestamp'],
        ['10:39', 'timestamp'], ['x', 'number'], [null, 'identifier']
    ];
    for (const [value, kind] of invalid) {
        let expected = '';
        try { tsRenderParameterValue(value, kind, 'p'); } catch (err: unknown) { expected = (err as Error).message; }
        assert.ok(expected, `the extension accepted ${value}/${kind}`);
        assert.throws(() => renderParameterValue(value, kind, 'p'), { message: expected }, `${value}/${kind}`);
    }
});

test('webview applyQueryParameters matches the extension implementation', () => {
    const params = [
        { name: 'from', kind: 'text' as const },
        { name: 'to', kind: 'text' as const },
        { name: 'a', kind: 'text' as const },
        { name: 'b', kind: 'number' as const }
    ];
    const values = { from: '2024-01-01', to: '2024-12-31', a: ":b", b: '5', id: '9', yes: 'y', real: 'r', x: '1', y: '2', z: '3' };
    for (const sql of PARITY_SQL) {
        const all = tsMergeParameters(sql, params);
        assert.equal(
            applyQueryParameters(sql, values, all),
            tsApplyQueryParameters(sql, values, all),
            sql
        );
    }
});

test('webview applyQueryParameters treats NULL and the NULL default like the extension', () => {
    const sql = 'SELECT * FROM t WHERE a = :a AND d = :d AND ts = :ts AND n = :n ORDER BY :col';
    const params = [
        { name: 'a', kind: 'text' as const, defaultValue: 'x' },
        { name: 'd', kind: 'date' as const, defaultNull: true },
        { name: 'ts', kind: 'timestamp' as const },
        { name: 'n', kind: 'number' as const, defaultNull: true },
        { name: 'col', kind: 'identifier' as const, defaultValue: 'id' }
    ];
    const runs: Array<Record<string, string | null>> = [
        { a: null, ts: '2026-11-25 10:39' },
        { a: '', d: '', ts: null, n: '3' },
        { d: '25.11.2026', ts: 'infinity', col: 'name' },
        { ts: '2026-11-25', col: null },
        { a: 'y' }
    ];
    for (const values of runs) {
        assert.equal(
            outcome(() => applyQueryParameters(sql, values, params)),
            outcome(() => tsApplyQueryParameters(sql, values, params)),
            JSON.stringify(values)
        );
    }
});

// ===== The run-time parameter form =====

test('initialQueryParamDraft prefers a remembered value, NULL included, over the default', () => {
    const params = [
        { name: 'a', kind: 'text', defaultValue: 'x' },
        { name: 'b', kind: 'date', defaultNull: true },
        { name: 'c', kind: 'timestamp', defaultNull: true },
        { name: 'd', kind: 'number', defaultValue: '7' },
        { name: 'e', kind: 'text' }
    ];
    assert.deepEqual(initialQueryParamDraft(params, { a: null, c: '2026-11-25 10:39', d: '' }), {
        a: { text: '', isNull: true },
        b: { text: '', isNull: true },
        c: { text: '2026-11-25 10:39', isNull: false },
        d: { text: '7', isNull: false },
        e: { text: '', isNull: false }
    });
});

test('initialQueryParamDraft never starts an identifier as NULL', () => {
    const params = [{ name: 'col', kind: 'identifier', defaultValue: 'id', defaultNull: true }];
    assert.deepEqual(initialQueryParamDraft(params, { col: null }), { col: { text: 'id', isNull: false } });
});

test('queryParamDraftValues gives null for a ticked NULL box and the text otherwise', () => {
    assert.deepEqual(
        queryParamDraftValues({ a: { text: 'kept', isNull: true }, b: { text: '2026-11-25', isNull: false }, c: { text: '', isNull: false } }),
        { a: null, b: '2026-11-25', c: '' }
    );
});

test('the parameter form offers NULL per row and the date picker for date and timestamp rows', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../../src/webview/tableView.js'), 'utf8');
    const start = source.indexOf('function renderQueryParamRows()');
    const body = source.slice(start, source.indexOf('function updateQueryParamsPreview()', start));
    assert.ok(start > 0 && body.length > 0, 'renderQueryParamRows not found');
    assert.match(body, /data-query-param-null=/, 'the rows have no NULL box');
    assert.match(body, /DateTimePicker\.attachDateTimePicker\(el, \{ kind: kind, allowEmpty: true \}\)/);
    assert.ok(body.indexOf('attachDateTimePicker') < body.indexOf("addEventListener('keydown'"),
        'the picker must see Enter before the form submits, so a typed date is committed first');
    assert.match(body, /cannot be NULL/, 'an identifier row does not say why it cannot be NULL');
    assert.match(source, /function applyQueryParamsDialog\(\) \{\s*commitQueryParamInputs\(\);/,
        'Run must use the values the date fields are about to show');
});
