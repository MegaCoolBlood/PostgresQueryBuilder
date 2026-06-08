import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const {
    stripTrailingLimitOffset,
    parseSqlForWhere,
    findTopLevelKeywordIndex,
    splitWhereByAnd,
    whereClauseTargetsColumn,
    parseSqlForOrder
} = require(path.join(__dirname, '../../src/webview/tableView.js'));

// ===== 0.2.0: "Load More" for custom queries (stripTrailingLimitOffset) =====

test('stripTrailingLimitOffset reports no limit for a plain SELECT', () => {
    assert.deepEqual(
        stripTrailingLimitOffset('SELECT * FROM t'),
        { base: 'SELECT * FROM t', hadLimit: false }
    );
});

test('stripTrailingLimitOffset strips a trailing LIMIT', () => {
    assert.deepEqual(
        stripTrailingLimitOffset('SELECT * FROM t LIMIT 50'),
        { base: 'SELECT * FROM t', hadLimit: true }
    );
});

test('stripTrailingLimitOffset strips a trailing LIMIT/OFFSET pair', () => {
    assert.deepEqual(
        stripTrailingLimitOffset('SELECT * FROM t LIMIT 50 OFFSET 100'),
        { base: 'SELECT * FROM t', hadLimit: true }
    );
});

test('stripTrailingLimitOffset strips an OFFSET-before-LIMIT pair', () => {
    assert.deepEqual(
        stripTrailingLimitOffset('SELECT * FROM t OFFSET 100 LIMIT 50'),
        { base: 'SELECT * FROM t', hadLimit: true }
    );
});

test('stripTrailingLimitOffset ignores a trailing semicolon and whitespace', () => {
    assert.deepEqual(
        stripTrailingLimitOffset('SELECT * FROM t LIMIT 50;  '),
        { base: 'SELECT * FROM t', hadLimit: true }
    );
});

test('stripTrailingLimitOffset does not treat LIMIT inside a string literal as a clause', () => {
    assert.deepEqual(
        stripTrailingLimitOffset("SELECT * FROM t WHERE name = 'LIMIT 5'"),
        { base: "SELECT * FROM t WHERE name = 'LIMIT 5'", hadLimit: false }
    );
});

test('stripTrailingLimitOffset does not strip LIMIT inside a subquery (parenthesized)', () => {
    const sql = 'SELECT * FROM (SELECT * FROM t LIMIT 5) sub';
    assert.deepEqual(
        stripTrailingLimitOffset(sql),
        { base: sql, hadLimit: false }
    );
});

test('stripTrailingLimitOffset strips the outer LIMIT but keeps a subquery LIMIT', () => {
    assert.deepEqual(
        stripTrailingLimitOffset('SELECT * FROM (SELECT * FROM t LIMIT 5) sub LIMIT 50'),
        { base: 'SELECT * FROM (SELECT * FROM t LIMIT 5) sub', hadLimit: true }
    );
});

// ===== 0.2.0: WHERE preservation when filtering / exact match =====

test('parseSqlForWhere splits base and WHERE clause', () => {
    assert.deepEqual(
        parseSqlForWhere('SELECT * FROM t WHERE a = 1'),
        { base: 'SELECT * FROM t', where: 'a = 1', orderBy: '' }
    );
});

test('parseSqlForWhere returns empty WHERE when none is present', () => {
    assert.deepEqual(
        parseSqlForWhere('SELECT * FROM t'),
        { base: 'SELECT * FROM t', where: '', orderBy: '' }
    );
});

test('parseSqlForWhere separates a trailing ORDER BY from the WHERE', () => {
    assert.deepEqual(
        parseSqlForWhere('SELECT * FROM t WHERE a = 1 ORDER BY b DESC'),
        { base: 'SELECT * FROM t', where: 'a = 1', orderBy: 'b DESC' }
    );
});

test('parseSqlForWhere strips a previously appended LIMIT/OFFSET', () => {
    assert.deepEqual(
        parseSqlForWhere('SELECT * FROM t WHERE a = 1 LIMIT 50 OFFSET 0'),
        { base: 'SELECT * FROM t', where: 'a = 1', orderBy: '' }
    );
});

test('parseSqlForWhere ignores a WHERE that appears inside a string literal', () => {
    const parsed = parseSqlForWhere("SELECT * FROM t WHERE name = 'WHERE x'");
    assert.equal(parsed.base, 'SELECT * FROM t');
    assert.equal(parsed.where, "name = 'WHERE x'");
});

test('findTopLevelKeywordIndex ignores keywords inside parentheses', () => {
    const sql = 'SELECT * FROM (SELECT 1 WHERE x) s WHERE y = 1';
    const idx = findTopLevelKeywordIndex(sql, 'WHERE');
    assert.equal(sql.substring(idx), 'WHERE y = 1');
});

test('findTopLevelKeywordIndex returns -1 when keyword is absent', () => {
    assert.equal(findTopLevelKeywordIndex('SELECT * FROM t', 'WHERE'), -1);
});

test('splitWhereByAnd splits top-level AND conditions', () => {
    assert.deepEqual(
        splitWhereByAnd('a = 1 AND b = 2 AND c = 3'),
        ['a = 1', 'b = 2', 'c = 3']
    );
});

test('splitWhereByAnd keeps AND inside parentheses intact', () => {
    assert.deepEqual(
        splitWhereByAnd('a = 1 AND (b = 2 AND c = 3)'),
        ['a = 1', '(b = 2 AND c = 3)']
    );
});

test('splitWhereByAnd does not split on AND inside a string literal', () => {
    assert.deepEqual(
        splitWhereByAnd("note = 'x AND y' AND b = 2"),
        ["note = 'x AND y'", 'b = 2']
    );
});

test('whereClauseTargetsColumn matches a bare column', () => {
    assert.equal(whereClauseTargetsColumn('amount = 5', 'amount'), true);
    assert.equal(whereClauseTargetsColumn('amount = 5', 'name'), false);
});

test('whereClauseTargetsColumn matches a qualified column', () => {
    assert.equal(whereClauseTargetsColumn('t.amount = 5', 'amount'), true);
    assert.equal(whereClauseTargetsColumn('public.t.amount = 5', 'amount'), true);
});

test('whereClauseTargetsColumn matches a quoted column case-insensitively', () => {
    assert.equal(whereClauseTargetsColumn('"Amount" = 5', 'amount'), true);
});

// ===== 0.2.0: ORDER BY context menu (parseSqlForOrder) =====

test('parseSqlForOrder extracts a trailing ORDER BY', () => {
    assert.deepEqual(
        parseSqlForOrder('SELECT * FROM t ORDER BY a ASC'),
        { base: 'SELECT * FROM t', orderBy: 'a ASC' }
    );
});

test('parseSqlForOrder returns empty orderBy when absent', () => {
    assert.deepEqual(
        parseSqlForOrder('SELECT * FROM t'),
        { base: 'SELECT * FROM t', orderBy: '' }
    );
});

test('parseSqlForOrder strips a generated LIMIT before extracting ORDER BY', () => {
    assert.deepEqual(
        parseSqlForOrder('SELECT * FROM t ORDER BY a, b DESC LIMIT 50 OFFSET 0'),
        { base: 'SELECT * FROM t', orderBy: 'a, b DESC' }
    );
});
