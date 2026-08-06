import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
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
    mergeQueryParameters
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

// ===== mergeQueryParameters (webview copy) =====

test('mergeQueryParameters adds new placeholders as text', () => {
    assert.deepEqual(
        mergeQueryParameters('SELECT :a FROM t', []),
        [{ name: 'a', kind: 'text' }]
    );
});

test('mergeQueryParameters keeps the settings of a still-used placeholder', () => {
    const merged = mergeQueryParameters('SELECT :a FROM t', [
        { name: 'a', kind: 'number', label: 'Amount', defaultValue: '1' }
    ]);
    assert.equal(merged[0].kind, 'number');
    assert.equal(merged[0].label, 'Amount');
    assert.equal(merged[0].defaultValue, '1');
});

test('mergeQueryParameters drops placeholders that vanished from the SQL', () => {
    assert.deepEqual(
        mergeQueryParameters('SELECT 1', [{ name: 'a', kind: 'text' }]),
        []
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
    'SELECT arr[1:3] FROM t'
];

test('webview parseQueryPlaceholders matches the extension implementation', () => {
    for (const sql of PARITY_SQL) {
        assert.deepEqual(parseQueryPlaceholders(sql), tsParsePlaceholders(sql), sql);
        assert.deepEqual(placeholderNames(sql), tsPlaceholderNames(sql), sql);
    }
});

test('webview renderParameterValue matches the extension implementation', () => {
    const cases: Array<[string, any]> = [
        ["O'Brien", 'text'],
        ['42', 'number'],
        ['-3.5', 'number'],
        ['my"col', 'identifier'],
        ['a > 1', 'raw']
    ];
    for (const [value, kind] of cases) {
        assert.equal(renderParameterValue(value, kind), tsRenderParameterValue(value, kind), `${value}/${kind}`);
    }
});

test('webview applyQueryParameters matches the extension implementation', () => {
    const params = [
        { name: 'from', kind: 'text' as const },
        { name: 'to', kind: 'text' as const },
        { name: 'a', kind: 'text' as const },
        { name: 'b', kind: 'number' as const }
    ];
    const values = { from: '2024-01-01', to: '2024-12-31', a: ":b", b: '5', id: '9', yes: 'y', real: 'r' };
    for (const sql of PARITY_SQL) {
        const all = tsMergeParameters(sql, params);
        assert.equal(
            applyQueryParameters(sql, values, all),
            tsApplyQueryParameters(sql, values, all),
            sql
        );
    }
});

test('webview mergeQueryParameters matches the extension implementation', () => {
    const existing = [{ name: 'b', kind: 'number' as const, label: 'B', defaultValue: '2' }];
    for (const sql of PARITY_SQL) {
        assert.deepEqual(
            mergeQueryParameters(sql, existing).map((p: any) => ({
                name: p.name,
                kind: p.kind,
                label: p.label,
                defaultValue: p.defaultValue
            })),
            tsMergeParameters(sql, existing).map(p => ({
                name: p.name,
                kind: p.kind,
                label: p.label,
                defaultValue: p.defaultValue
            })),
            sql
        );
    }
});
