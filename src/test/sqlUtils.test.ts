import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeSqlLiteral, formatPgArrayLiteral, pgValueToText } from '../sqlUtils';

test('escapeSqlLiteral wraps a plain string in single quotes', () => {
    assert.equal(escapeSqlLiteral('hello'), "'hello'");
});

test('escapeSqlLiteral doubles embedded single quotes', () => {
    assert.equal(escapeSqlLiteral("O'Reilly"), "'O''Reilly'");
    assert.equal(escapeSqlLiteral("''"), "''''''");
});

test('escapeSqlLiteral handles an empty string', () => {
    assert.equal(escapeSqlLiteral(''), "''");
});

test('escapeSqlLiteral neutralizes a classic injection payload', () => {
    assert.equal(
        escapeSqlLiteral("'; DROP TABLE users; --"),
        "'''; DROP TABLE users; --'"
    );
});

test('escapeSqlLiteral coerces non-string input via String()', () => {
    assert.equal(escapeSqlLiteral(123 as unknown as string), "'123'");
});

// ===== pgValueToText / formatPgArrayLiteral =====

test('pgValueToText returns null for SQL NULL', () => {
    assert.equal(pgValueToText(null), null);
    assert.equal(pgValueToText(undefined), null);
});

test('pgValueToText renders a json/jsonb object as JSON text', () => {
    assert.equal(pgValueToText({ a: 1, b: [true, null], c: 'x"y' }), '{"a":1,"b":[true,null],"c":"x\\"y"}');
});

test('pgValueToText keeps strings, numbers and booleans as their text', () => {
    assert.equal(pgValueToText('2024-01-31 10:15:00.123456+01'), '2024-01-31 10:15:00.123456+01');
    assert.equal(pgValueToText(42.5), '42.5');
    assert.equal(pgValueToText(false), 'false');
});

test('pgValueToText renders a Date as ISO text in UTC', () => {
    assert.equal(pgValueToText(new Date(Date.UTC(2024, 0, 31, 9, 15, 0, 123))), '2024-01-31T09:15:00.123Z');
});

test('pgValueToText renders bytea as \\x hex', () => {
    assert.equal(pgValueToText(Buffer.from([0xde, 0xad, 0x01])), '\\xdead01');
});

test('formatPgArrayLiteral renders a flat int array', () => {
    assert.equal(pgValueToText([1, 2, 3]), '{1,2,3}');
});

test('formatPgArrayLiteral quotes elements with special characters, empty strings and the word NULL', () => {
    assert.equal(
        formatPgArrayLiteral(['plain', 'a,b', 'say "hi"', 'back\\slash', '{x}', 'two words', '', 'NULL', null]),
        '{plain,"a,b","say \\"hi\\"","back\\\\slash","{x}","two words","","NULL",NULL}'
    );
});

test('formatPgArrayLiteral renders nested arrays and object elements as JSON', () => {
    assert.equal(formatPgArrayLiteral([[1, 2], [3, null]]), '{{1,2},{3,NULL}}');
    assert.equal(formatPgArrayLiteral([{ a: 1 }]), '{"{\\"a\\":1}"}');
});
