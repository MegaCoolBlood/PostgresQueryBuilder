import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const {
    stripTrailingLimitOffset,
    parseSqlForWhere,
    findTopLevelKeywordIndex,
    splitWhereByAnd,
    whereClauseTargetsColumn,
    mergeWhereClauses,
    parseSqlForOrder,
    formatSql,
    buildNullConstraintClause,
    constraintIsUnary,
    constraintIsBetween,
    formatConstraintOperand,
    formatConstraintCondition,
    buildConstraintWhere,
    CONSTRAINT_SORT_DIRECTIONS,
    formatConstraintSort,
    buildConstraintOrderBy,
    isFreshRowLoad,
    recordFieldReadonlyAttr,
    buildConnectionBadge,
    canApplyQueryFilters,
    canManageTableMetadata,
    defaultInsertTableName
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

// ===== 2.2.2: applying and clearing column filters =====

test('mergeWhereClauses adds a clause for a newly filtered column', () => {
    assert.deepEqual(
        mergeWhereClauses(['"other" = 1'], { status: `"status" = 'open'` }),
        ['"other" = 1', `"status" = 'open'`]
    );
});

test('mergeWhereClauses replaces the existing clause of the same column', () => {
    assert.deepEqual(
        mergeWhereClauses([`"status" = 'open'`, '"other" = 1'], { status: `"status" = 'done'` }),
        ['"other" = 1', `"status" = 'done'`]
    );
});

test('mergeWhereClauses removes the clause when a filter was cleared', () => {
    assert.deepEqual(
        mergeWhereClauses([`"status" = 'open'`, '"other" = 1'], { status: '' }),
        ['"other" = 1']
    );
});

test('mergeWhereClauses can clear the last remaining clause', () => {
    assert.deepEqual(mergeWhereClauses([`"status" = 'open'`], { status: '' }), []);
});

test('mergeWhereClauses leaves clauses of untouched columns alone', () => {
    assert.deepEqual(
        mergeWhereClauses(['"a" = 1', '"b" = 2'], {}),
        ['"a" = 1', '"b" = 2']
    );
});

test('mergeWhereClauses adds and removes several columns at once', () => {
    assert.deepEqual(
        mergeWhereClauses(['"a" = 1', '"b" = 2'], { a: '', b: '"b" = 9', c: '"c" = 3' }),
        ['"b" = 9', '"c" = 3']
    );
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

// ===== 2.2.3: permanent per-table sort orders =====

test('CONSTRAINT_SORT_DIRECTIONS offers ASC and DESC', () => {
    assert.deepEqual(CONSTRAINT_SORT_DIRECTIONS, ['ASC', 'DESC']);
});

test('formatConstraintSort quotes the column and appends the direction', () => {
    assert.equal(formatConstraintSort({ column: 'created_at', direction: 'DESC' }, fmtCol), '"created_at" DESC');
});

test('formatConstraintSort defaults a missing or unknown direction to ASC', () => {
    assert.equal(formatConstraintSort({ column: 'name' }, fmtCol), '"name" ASC');
    assert.equal(formatConstraintSort({ column: 'name', direction: 'sideways' }, fmtCol), '"name" ASC');
});

test('formatConstraintSort accepts a lowercase direction', () => {
    assert.equal(formatConstraintSort({ column: 'name', direction: 'desc' }, fmtCol), '"name" DESC');
});

test('formatConstraintSort returns empty string without a column', () => {
    assert.equal(formatConstraintSort({ column: '', direction: 'ASC' }, fmtCol), '');
    assert.equal(formatConstraintSort({ column: '   ' }, fmtCol), '');
    assert.equal(formatConstraintSort(undefined, fmtCol), '');
});

test('buildConstraintOrderBy joins entries with commas and skips incomplete rows', () => {
    const sorts = [
        { column: 'created_at', direction: 'DESC' },
        { column: '' },
        { column: 'name', direction: 'ASC' }
    ];
    assert.equal(buildConstraintOrderBy(sorts, fmtCol), '"created_at" DESC, "name" ASC');
});

test('buildConstraintOrderBy returns empty string for no sorts', () => {
    assert.equal(buildConstraintOrderBy([], fmtCol), '');
    assert.equal(buildConstraintOrderBy(undefined, fmtCol), '');
});

test('a default query with constraints and sorts puts WHERE before ORDER BY', () => {
    const where = buildConstraintWhere(
        [{ operator: '=', left: { kind: 'column', column: 'status' }, right: { kind: 'raw', text: "'active'" } }],
        fmtCol
    );
    const orderBy = buildConstraintOrderBy([{ column: 'created_at', direction: 'DESC' }], fmtCol);
    const sql = `SELECT * FROM "t"` + (where ? ` WHERE ${where}` : '') + (orderBy ? ` ORDER BY ${orderBy}` : '');
    assert.equal(sql, `SELECT * FROM "t" WHERE "status" = 'active' ORDER BY "created_at" DESC`);
});

test('a permanent ORDER BY survives parseSqlForOrder round-tripping', () => {
    const orderBy = buildConstraintOrderBy([{ column: 'created_at', direction: 'DESC' }], fmtCol);
    assert.deepEqual(
        parseSqlForOrder(`SELECT * FROM "t" ORDER BY ${orderBy} LIMIT 50 OFFSET 0`),
        { base: 'SELECT * FROM "t"', orderBy: '"created_at" DESC' }
    );
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

// ===== 2.1.5: clickable connection badge =====

test('buildConnectionBadge prompts to select when no connection is known', () => {
    const badge = buildConnectionBadge('', '');
    assert.equal(badge.text, 'Select connection\u2026');
    assert.equal(badge.warn, false);
    assert.match(badge.title, /choose a database connection/i);
});

test('buildConnectionBadge shows the active connection and a switch hint', () => {
    const badge = buildConnectionBadge('prod', 'prod');
    assert.equal(badge.text, 'prod');
    assert.equal(badge.warn, false);
    assert.match(badge.title, /click to switch connection/i);
});

test('buildConnectionBadge warns when the active connection differs from the loaded one', () => {
    const badge = buildConnectionBadge('prod', 'staging');
    assert.match(badge.text, /prod/);
    assert.match(badge.text, /staging/);
    assert.equal(badge.warn, true);
    assert.match(badge.title, /click to switch connection/i);
});

test('buildConnectionBadge falls back to the current connection when no load is recorded', () => {
    const badge = buildConnectionBadge('', 'prod');
    assert.equal(badge.text, '(none)');
    assert.equal(badge.warn, false);
});

// ===== 2.1.5: filters can refine a custom query =====

test('canApplyQueryFilters is true whenever a query is shown in the query bar', () => {
    assert.equal(canApplyQueryFilters('SELECT * FROM public.users'), true);
    assert.equal(canApplyQueryFilters('SELECT 1'), true);
});

test('canApplyQueryFilters is false without a query', () => {
    assert.equal(canApplyQueryFilters(''), false);
    assert.equal(canApplyQueryFilters('   '), false);
    assert.equal(canApplyQueryFilters(undefined), false);
});

// ===== 2.2.2: table-bound actions are hidden in the custom-query view =====

test('canManageTableMetadata is true for an editable standard table view', () => {
    assert.equal(canManageTableMetadata('public', 'users', false), true);
});

test('canManageTableMetadata is false for a read-only custom-query result', () => {
    assert.equal(canManageTableMetadata('', '', true), false);
    assert.equal(canManageTableMetadata('public', 'users', true), false);
});

test('canManageTableMetadata is false when schema or table is unknown', () => {
    assert.equal(canManageTableMetadata('', '', false), false);
    assert.equal(canManageTableMetadata('public', '', false), false);
    assert.equal(canManageTableMetadata('', 'users', false), false);
});

test('defaultInsertTableName keeps a known table reference', () => {
    assert.equal(defaultInsertTableName('public.users'), 'public.users');
    assert.equal(defaultInsertTableName('"Public"."Users"'), '"Public"."Users"');
});

test('defaultInsertTableName falls back when there is no source table', () => {
    assert.equal(defaultInsertTableName(''), 'exported_data');
    assert.equal(defaultInsertTableName(undefined), 'exported_data');
});



