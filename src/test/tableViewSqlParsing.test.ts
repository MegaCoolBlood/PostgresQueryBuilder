import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const {
    stripTrailingLimitOffset,
    parseSqlForWhere,
    findTopLevelKeywordIndex,
    splitWhereByAnd,
    whereClauseTargetsColumn,
    parseSqlForOrder,
    formatSql,
    buildNullConstraintClause,
    constraintIsUnary,
    constraintIsBetween,
    formatConstraintOperand,
    formatConstraintCondition,
    buildConstraintWhere,
    shouldRenderEarlyColumns,
    isFreshRowLoad,
    recordFieldReadonlyAttr
} = require(path.join(__dirname, '../../../src/webview/tableView.js'));

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

// ===== 1.1.0: multi-line formatted SELECT in the data viewer (formatSql) =====

test('formatSql puts the FROM clause on its own line', () => {
    assert.equal(
        formatSql('SELECT * FROM public.foo'),
        'SELECT *\nFROM public.foo'
    );
});

test('formatSql lists each top-level column on its own indented line', () => {
    assert.equal(
        formatSql('SELECT a, b, c FROM t'),
        'SELECT\n    a,\n    b,\n    c\nFROM t'
    );
});

test('formatSql splits WHERE conditions on top-level AND', () => {
    assert.equal(
        formatSql('SELECT * FROM t WHERE a = 1 AND b = 2'),
        'SELECT *\nFROM t\nWHERE a = 1\n    AND b = 2'
    );
});

test('formatSql places JOIN, GROUP BY, ORDER BY and LIMIT on separate lines', () => {
    const input = 'SELECT a FROM t JOIN u ON t.id = u.tid GROUP BY a ORDER BY a LIMIT 50';
    assert.equal(
        formatSql(input),
        'SELECT a\nFROM t\nJOIN u ON t.id = u.tid\nGROUP BY a\nORDER BY a\nLIMIT 50'
    );
});

test('formatSql collapses pre-existing whitespace and re-formats', () => {
    const input = 'SELECT   a,\n   b\n  FROM    t   WHERE   a=1';
    assert.equal(
        formatSql(input),
        'SELECT\n    a,\n    b\nFROM t\nWHERE a=1'
    );
});

test('formatSql does not split commas inside a function call', () => {
    assert.equal(
        formatSql('SELECT coalesce(a, b) AS x, c FROM t'),
        'SELECT\n    coalesce(a, b) AS x,\n    c\nFROM t'
    );
});

test('formatSql does not treat keywords inside string literals as clauses', () => {
    assert.equal(
        formatSql("SELECT * FROM t WHERE name = 'from where'"),
        "SELECT *\nFROM t\nWHERE name = 'from where'"
    );
});

test('formatSql keeps DISTINCT on the SELECT line', () => {
    assert.equal(
        formatSql('SELECT DISTINCT a, b FROM t'),
        'SELECT DISTINCT\n    a,\n    b\nFROM t'
    );
});

test('formatSql leaves statements with comments untouched', () => {
    const input = 'SELECT a FROM t -- comment';
    assert.equal(formatSql(input), 'SELECT a FROM t -- comment');
});

test('formatSql leaves non-SELECT statements untouched (trimmed)', () => {
    assert.equal(formatSql('  UPDATE t SET a = 1;  '), 'UPDATE t SET a = 1');
});

test('formatSql strips a trailing semicolon', () => {
    assert.equal(formatSql('SELECT * FROM t;'), 'SELECT *\nFROM t');
});

test('formatSql is idempotent', () => {
    const once = formatSql('SELECT a, b FROM t WHERE a = 1 AND b = 2');
    assert.equal(formatSql(once), once);
});

// ===== 1.3.0: IS (NOT) NULL constraint from the column header menu =====

test('buildNullConstraintClause builds an IS NULL clause', () => {
    assert.equal(buildNullConstraintClause('"status"', true), '"status" IS NULL');
});

test('buildNullConstraintClause builds an IS NOT NULL clause', () => {
    assert.equal(buildNullConstraintClause('"status"', false), '"status" IS NOT NULL');
});

test('IS NULL clause merges into a query without an existing WHERE', () => {
    const parsed = parseSqlForWhere('SELECT * FROM t');
    const clauses = parsed.where ? splitWhereByAnd(parsed.where) : [];
    clauses.push(buildNullConstraintClause('"status"', true));
    assert.equal(`${parsed.base} WHERE ${clauses.join(' AND ')}`, 'SELECT * FROM t WHERE "status" IS NULL');
});

test('IS NOT NULL clause replaces an existing constraint on the same column', () => {
    const parsed = parseSqlForWhere(`SELECT * FROM t WHERE "status" IS NULL AND "other" = 1`);
    let clauses = parsed.where ? splitWhereByAnd(parsed.where) : [];
    clauses = clauses.filter((c: string) => !whereClauseTargetsColumn(c, 'status'));
    clauses.push(buildNullConstraintClause('"status"', false));
    assert.equal(
        `${parsed.base} WHERE ${clauses.join(' AND ')}`,
        `SELECT * FROM t WHERE "other" = 1 AND "status" IS NOT NULL`
    );
});

// ===== 1.3.0: permanent per-table constraints (fixed-condition design) =====

// Quote-everything column formatter, matching the webview's alwaysQuote mode.
const fmtCol = (c: string) => `"${String(c).replace(/"/g, '""')}"`;

test('constraintIsUnary recognises IS NULL / IS NOT NULL', () => {
    assert.equal(constraintIsUnary('IS NULL'), true);
    assert.equal(constraintIsUnary('is not null'), true);
    assert.equal(constraintIsUnary('='), false);
});

test('constraintIsBetween recognises BETWEEN', () => {
    assert.equal(constraintIsBetween('BETWEEN'), true);
    assert.equal(constraintIsBetween('between'), true);
    assert.equal(constraintIsBetween('='), false);
});

test('formatConstraintOperand quotes a column operand via the formatter', () => {
    assert.equal(formatConstraintOperand({ kind: 'column', column: 'valid_from' }, fmtCol), '"valid_from"');
});

test('formatConstraintOperand emits a raw operand verbatim', () => {
    assert.equal(formatConstraintOperand({ kind: 'raw', text: 'CURRENT_TIMESTAMP' }, fmtCol), 'CURRENT_TIMESTAMP');
});

test('formatConstraintCondition builds a binary condition', () => {
    const cond = { operator: '=', left: { kind: 'column', column: 'status' }, right: { kind: 'raw', text: "'active'" } };
    assert.equal(formatConstraintCondition(cond, fmtCol), `"status" = 'active'`);
});

test('formatConstraintCondition builds an IS NOT NULL condition', () => {
    const cond = { operator: 'IS NOT NULL', left: { kind: 'column', column: 'deleted_at' } };
    assert.equal(formatConstraintCondition(cond, fmtCol), '"deleted_at" IS NOT NULL');
});

test('formatConstraintCondition builds a BETWEEN condition', () => {
    const cond = {
        operator: 'BETWEEN',
        left: { kind: 'raw', text: 'CURRENT_TIMESTAMP' },
        right: { kind: 'column', column: 'valid_from' },
        right2: { kind: 'column', column: 'valid_to' }
    };
    assert.equal(formatConstraintCondition(cond, fmtCol), 'CURRENT_TIMESTAMP BETWEEN "valid_from" AND "valid_to"');
});

test('formatConstraintCondition returns empty string when an operand is missing', () => {
    assert.equal(formatConstraintCondition({ operator: '=', left: { kind: 'column', column: 'a' } }, fmtCol), '');
    assert.equal(formatConstraintCondition({ operator: 'BETWEEN', left: { kind: 'column', column: 'a' }, right: { kind: 'raw', text: '1' } }, fmtCol), '');
});

test('buildConstraintWhere joins multiple conditions with AND and skips incomplete rows', () => {
    const conditions = [
        { operator: '=', left: { kind: 'column', column: 'status' }, right: { kind: 'raw', text: "'active'" } },
        { operator: '=', left: { kind: 'column', column: 'incomplete' } },
        {
            operator: 'BETWEEN',
            left: { kind: 'raw', text: 'CURRENT_TIMESTAMP' },
            right: { kind: 'column', column: 'valid_from' },
            right2: { kind: 'column', column: 'valid_to' }
        }
    ];
    assert.equal(
        buildConstraintWhere(conditions, fmtCol),
        `"status" = 'active' AND CURRENT_TIMESTAMP BETWEEN "valid_from" AND "valid_to"`
    );
});

test('buildConstraintWhere returns empty string for no conditions', () => {
    assert.equal(buildConstraintWhere([], fmtCol), '');
    assert.equal(buildConstraintWhere(undefined, fmtCol), '');
});

// ===== 1.3.0: early column rendering while data is still loading =====

test('shouldRenderEarlyColumns is true for the initial page of a table view', () => {
    assert.equal(shouldRenderEarlyColumns(0, false), true);
    assert.equal(shouldRenderEarlyColumns(undefined, false), true);
});

test('shouldRenderEarlyColumns is false for paged "Load More" requests', () => {
    assert.equal(shouldRenderEarlyColumns(50, false), false);
    assert.equal(shouldRenderEarlyColumns(100, false), false);
});

test('shouldRenderEarlyColumns is false while a custom query is active', () => {
    assert.equal(shouldRenderEarlyColumns(0, true), false);
});

// ===== 2.1.5: pending edits are discarded when rows are reloaded =====

test('isFreshRowLoad is true for the initial page (offset 0)', () => {
    assert.equal(isFreshRowLoad(0, false), true);
    assert.equal(isFreshRowLoad(undefined, false), true);
    assert.equal(isFreshRowLoad(null, false), true);
});

test('isFreshRowLoad is false for paged "Load More" requests', () => {
    assert.equal(isFreshRowLoad(50, false), false);
    assert.equal(isFreshRowLoad(100, false), false);
});

test('isFreshRowLoad is false when appending custom-query pages', () => {
    assert.equal(isFreshRowLoad(0, true), false);
    assert.equal(isFreshRowLoad(undefined, true), false);
});

test('isFreshRowLoad is true when a custom query is re-run (not appending)', () => {
    assert.equal(isFreshRowLoad(0, false), true);
});

// ===== 2.1.5: Single Record View respects read-only views =====

test('recordFieldReadonlyAttr makes fields editable in a normal editable view', () => {
    assert.equal(recordFieldReadonlyAttr(false, false), '');
});

test('recordFieldReadonlyAttr marks fields readonly when the view is read-only', () => {
    assert.equal(recordFieldReadonlyAttr(false, true), 'readonly');
});

test('recordFieldReadonlyAttr marks fields readonly for rows pending deletion', () => {
    assert.equal(recordFieldReadonlyAttr(true, false), 'readonly');
    assert.equal(recordFieldReadonlyAttr(true, true), 'readonly');
});



