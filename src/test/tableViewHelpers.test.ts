import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const {
    cellToString,
    hasSqlComment,
    collapseSqlWhitespace,
    splitTopLevelCommas,
    splitTopLevelClauses,
    buildRowIdentity
} = require(path.join(__dirname, '../../src/webview/tableView.js'));

// ===== cellToString =====

test('cellToString renders null and undefined as an empty string', () => {
    assert.equal(cellToString(null), '');
    assert.equal(cellToString(undefined), '');
});

test('cellToString stringifies primitive values', () => {
    assert.equal(cellToString(42), '42');
    assert.equal(cellToString(0), '0');
    assert.equal(cellToString(false), 'false');
    assert.equal(cellToString('hello'), 'hello');
});

test('cellToString serializes objects and arrays as JSON', () => {
    assert.equal(cellToString({ a: 1, b: 'x' }), '{"a":1,"b":"x"}');
    assert.equal(cellToString([1, 2, 3]), '[1,2,3]');
    assert.equal(cellToString({ nested: { y: true } }), '{"nested":{"y":true}}');
});

test('cellToString falls back to String() for non-serializable objects', () => {
    const circular: any = {};
    circular.self = circular;
    assert.equal(cellToString(circular), '[object Object]');
});

// ===== hasSqlComment =====

test('hasSqlComment detects a line comment', () => {
    assert.equal(hasSqlComment('SELECT 1 -- trailing'), true);
});

test('hasSqlComment detects a block comment', () => {
    assert.equal(hasSqlComment('SELECT /* c */ 1'), true);
});

test('hasSqlComment returns false for a plain statement', () => {
    assert.equal(hasSqlComment('SELECT * FROM t WHERE x = 1'), false);
});

test('hasSqlComment ignores comment markers inside a string literal', () => {
    assert.equal(hasSqlComment("SELECT '-- not a comment'"), false);
    assert.equal(hasSqlComment("SELECT '/* not a comment */'"), false);
});

test('hasSqlComment ignores comment markers inside a quoted identifier', () => {
    assert.equal(hasSqlComment('SELECT "weird--col" FROM t'), false);
});

test('hasSqlComment handles escaped quotes within a string literal', () => {
    assert.equal(hasSqlComment("SELECT 'O''Reilly -- x'"), false);
});

// ===== collapseSqlWhitespace =====

test('collapseSqlWhitespace collapses runs of whitespace to single spaces', () => {
    assert.equal(collapseSqlWhitespace('SELECT   *\n\nFROM\tt'), 'SELECT * FROM t');
});

test('collapseSqlWhitespace trims leading and trailing whitespace', () => {
    assert.equal(collapseSqlWhitespace('   SELECT 1   '), 'SELECT 1');
});

test('collapseSqlWhitespace preserves whitespace inside string literals', () => {
    assert.equal(collapseSqlWhitespace("SELECT  'a   b'  FROM t"), "SELECT 'a   b' FROM t");
});

test('collapseSqlWhitespace preserves whitespace inside quoted identifiers', () => {
    assert.equal(collapseSqlWhitespace('SELECT  "a   b"  FROM t'), 'SELECT "a   b" FROM t');
});

// ===== splitTopLevelCommas =====

test('splitTopLevelCommas splits a simple column list', () => {
    assert.deepEqual(splitTopLevelCommas('a, b, c'), ['a', ' b', ' c']);
});

test('splitTopLevelCommas keeps commas inside parentheses intact', () => {
    assert.deepEqual(
        splitTopLevelCommas('a, fn(b, c), d'),
        ['a', ' fn(b, c)', ' d']
    );
});

test('splitTopLevelCommas keeps commas inside string literals intact', () => {
    assert.deepEqual(
        splitTopLevelCommas("a, 'x, y', b"),
        ['a', " 'x, y'", ' b']
    );
});

test('splitTopLevelCommas keeps commas inside quoted identifiers intact', () => {
    assert.deepEqual(
        splitTopLevelCommas('a, "weird, col", b'),
        ['a', ' "weird, col"', ' b']
    );
});

test('splitTopLevelCommas returns a single element when there is no top-level comma', () => {
    assert.deepEqual(splitTopLevelCommas('count(*)'), ['count(*)']);
});

// ===== splitTopLevelClauses =====

test('splitTopLevelClauses splits a SELECT into ordered clause segments', () => {
    assert.deepEqual(
        splitTopLevelClauses('SELECT a FROM t WHERE x = 1'),
        [
            { kw: 'SELECT', content: 'a' },
            { kw: 'FROM', content: 't' },
            { kw: 'WHERE', content: 'x = 1' }
        ]
    );
});

test('splitTopLevelClauses matches the longest multi-word JOIN keyword', () => {
    assert.deepEqual(
        splitTopLevelClauses('SELECT a FROM t LEFT OUTER JOIN u ON t.id = u.id'),
        [
            { kw: 'SELECT', content: 'a' },
            { kw: 'FROM', content: 't' },
            { kw: 'LEFT OUTER JOIN', content: 'u ON t.id = u.id' }
        ]
    );
});

test('splitTopLevelClauses does not split on keywords inside parentheses', () => {
    assert.deepEqual(
        splitTopLevelClauses('SELECT a FROM (SELECT b FROM u) sub'),
        [
            { kw: 'SELECT', content: 'a' },
            { kw: 'FROM', content: '(SELECT b FROM u) sub' }
        ]
    );
});

test('splitTopLevelClauses does not split on keywords inside string literals', () => {
    assert.deepEqual(
        splitTopLevelClauses("SELECT 'FROM WHERE' AS lbl"),
        [{ kw: 'SELECT', content: "'FROM WHERE' AS lbl" }]
    );
});

test('splitTopLevelClauses places GROUP BY, ORDER BY and LIMIT on their own segments', () => {
    assert.deepEqual(
        splitTopLevelClauses('SELECT a FROM t GROUP BY a ORDER BY a LIMIT 10'),
        [
            { kw: 'SELECT', content: 'a' },
            { kw: 'FROM', content: 't' },
            { kw: 'GROUP BY', content: 'a' },
            { kw: 'ORDER BY', content: 'a' },
            { kw: 'LIMIT', content: '10' }
        ]
    );
});

// ===== buildRowIdentity =====

test('buildRowIdentity uses only the primary key columns when a PK exists', () => {
    const row = { id: 7, name: 'Alice', age: 30 };
    assert.deepEqual(buildRowIdentity(['id'], ['id', 'name', 'age'], row), { id: 7 });
});

test('buildRowIdentity supports composite primary keys', () => {
    const row = { a: 1, b: 2, c: 3 };
    assert.deepEqual(buildRowIdentity(['a', 'b'], ['a', 'b', 'c'], row), { a: 1, b: 2 });
});

test('buildRowIdentity falls back to all columns when there is no primary key', () => {
    const row = { ts: '2026-01-01', level: 'info', msg: 'hi' };
    assert.deepEqual(
        buildRowIdentity([], ['ts', 'level', 'msg'], row),
        { ts: '2026-01-01', level: 'info', msg: 'hi' }
    );
});

test('buildRowIdentity keeps null values in the full-row fallback', () => {
    const row = { a: 1, note: null };
    assert.deepEqual(buildRowIdentity([], ['a', 'note'], row), { a: 1, note: null });
});

test('buildRowIdentity treats a missing primaryKeys argument as no primary key', () => {
    const row = { a: 1, b: 2 };
    assert.deepEqual(buildRowIdentity(undefined, ['a', 'b'], row), { a: 1, b: 2 });
});

