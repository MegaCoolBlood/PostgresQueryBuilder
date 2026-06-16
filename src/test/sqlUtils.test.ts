import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeSqlLiteral } from '../sqlUtils';

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
