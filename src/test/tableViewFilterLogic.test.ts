import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const {
    filterOperatorForMode,
    buildFilterClause,
    rowValueMatchesFilter,
    compareCellValues,
    normalizeCellInput,
    mappingConditionToClause,
    buildErrorDialogState
} = require(path.join(__dirname, '../../../src/webview/tableView.js'));

const SEP = ' ';

// ===== filterOperatorForMode =====

test('filterOperatorForMode maps every known mode', () => {
    assert.equal(filterOperatorForMode('not_equals'), '!=');
    assert.equal(filterOperatorForMode('gt'), '>');
    assert.equal(filterOperatorForMode('gte'), '>=');
    assert.equal(filterOperatorForMode('lt'), '<');
    assert.equal(filterOperatorForMode('lte'), '<=');
    assert.equal(filterOperatorForMode('equals'), '=');
});

test('filterOperatorForMode defaults unknown modes to =', () => {
    assert.equal(filterOperatorForMode('whatever'), '=');
    assert.equal(filterOperatorForMode(undefined), '=');
});

// ===== buildFilterClause =====

test('buildFilterClause returns null for empty values', () => {
    assert.equal(buildFilterClause('"c"', '', 'text', false, '=', SEP), null);
    assert.equal(buildFilterClause('"c"', null, 'text', false, '=', SEP), null);
    assert.equal(buildFilterClause('"c"', undefined, 'text', false, '=', SEP), null);
});

test('buildFilterClause builds an exact match clause', () => {
    assert.equal(
        buildFilterClause('"c"', '1 234,50', 'numeric', true, '=', SEP),
        `"c" = '1234.50'`
    );
    assert.equal(
        buildFilterClause('"c"', "O'Reilly", 'text', true, '=', SEP),
        `"c" = 'O''Reilly'`
    );
});

test('buildFilterClause builds a text ILIKE clause', () => {
    assert.equal(
        buildFilterClause('"c"', 'abc', 'text', false, '=', SEP),
        `"c"::text ILIKE '%abc%'`
    );
});

test('buildFilterClause escapes single quotes in text filters', () => {
    assert.equal(
        buildFilterClause('"c"', "a'b", 'text', false, '=', SEP),
        `"c"::text ILIKE '%a''b%'`
    );
});

test('buildFilterClause builds a numeric comparison clause', () => {
    assert.equal(
        buildFilterClause('"c"', '1 234,5', 'numeric', false, '>=', SEP),
        `"c" >= 1234.5`
    );
});

test('buildFilterClause returns null for non-numeric numeric input', () => {
    assert.equal(buildFilterClause('"c"', 'abc', 'numeric', false, '=', SEP), null);
});

test('buildFilterClause builds a date comparison clause', () => {
    assert.equal(
        buildFilterClause('"c"', '2024-01-01', 'date', false, '<', SEP),
        `"c" < '2024-01-01'`
    );
});

test('buildFilterClause builds numeric BETWEEN clauses', () => {
    assert.equal(
        buildFilterClause('"c"', { from: '1 000', to: '2 000' }, 'numeric', false, '=', SEP),
        `"c" BETWEEN 1000 AND 2000`
    );
    assert.equal(
        buildFilterClause('"c"', { from: '1 000', to: '' }, 'numeric', false, '=', SEP),
        `"c" >= 1000`
    );
    assert.equal(
        buildFilterClause('"c"', { from: '', to: '2 000' }, 'numeric', false, '=', SEP),
        `"c" <= 2000`
    );
    assert.equal(
        buildFilterClause('"c"', { from: '', to: '' }, 'numeric', false, '=', SEP),
        null
    );
});

test('buildFilterClause builds text BETWEEN clauses with escaping', () => {
    assert.equal(
        buildFilterClause('"c"', { from: 'a', to: 'z' }, 'text', false, '=', SEP),
        `"c" BETWEEN 'a' AND 'z'`
    );
    assert.equal(
        buildFilterClause('"c"', { from: 'a', to: '' }, 'text', false, '=', SEP),
        `"c" >= 'a'`
    );
});

// ===== rowValueMatchesFilter =====

test('rowValueMatchesFilter does contains matching for text', () => {
    assert.equal(rowValueMatchesFilter('Hello', 'ell', 'text', 'contains', SEP), true);
    assert.equal(rowValueMatchesFilter('Hello', 'xyz', 'text', 'contains', SEP), false);
    assert.equal(rowValueMatchesFilter(null, 'a', 'text', 'contains', SEP), false);
});

test('rowValueMatchesFilter is case-insensitive for text', () => {
    assert.equal(rowValueMatchesFilter('HELLO', 'hello', 'text', 'contains', SEP), true);
});

test('rowValueMatchesFilter applies numeric comparison modes', () => {
    assert.equal(rowValueMatchesFilter(10, '5', 'numeric', 'gt', SEP), true);
    assert.equal(rowValueMatchesFilter(3, '5', 'numeric', 'gt', SEP), false);
    assert.equal(rowValueMatchesFilter(5, '5', 'numeric', 'gte', SEP), true);
    assert.equal(rowValueMatchesFilter(5, '5', 'numeric', 'not_equals', SEP), false);
    assert.equal(rowValueMatchesFilter(4, '5', 'numeric', 'lt', SEP), true);
});

test('rowValueMatchesFilter treats null cells as non-matching for comparisons', () => {
    assert.equal(rowValueMatchesFilter(null, '5', 'numeric', 'gt', SEP), false);
});

test('rowValueMatchesFilter handles numeric BETWEEN ranges', () => {
    assert.equal(rowValueMatchesFilter(15, { from: '10', to: '20' }, 'numeric', undefined, SEP), true);
    assert.equal(rowValueMatchesFilter(25, { from: '10', to: '20' }, 'numeric', undefined, SEP), false);
    assert.equal(rowValueMatchesFilter(15, { from: '10', to: '' }, 'numeric', undefined, SEP), true);
    assert.equal(rowValueMatchesFilter(5, { from: '10', to: '' }, 'numeric', undefined, SEP), false);
});

test('rowValueMatchesFilter matches all rows for an empty range', () => {
    assert.equal(rowValueMatchesFilter(15, { from: '', to: '' }, 'numeric', undefined, SEP), true);
});

test('rowValueMatchesFilter handles text BETWEEN ranges', () => {
    assert.equal(rowValueMatchesFilter('m', { from: 'a', to: 'z' }, 'text', undefined, SEP), true);
    assert.equal(rowValueMatchesFilter('a', { from: 'a', to: 'z' }, 'text', undefined, SEP), true);
    assert.equal(rowValueMatchesFilter('z', { from: 'a', to: 'm' }, 'text', undefined, SEP), false);
});

// ===== compareCellValues =====

test('compareCellValues sorts numbers ascending and descending', () => {
    assert.ok(compareCellValues(1, 2, 'asc') < 0);
    assert.ok(compareCellValues(1, 2, 'desc') > 0);
    assert.equal(compareCellValues(2, 2, 'asc'), 0);
});

test('compareCellValues sorts strings via localeCompare', () => {
    assert.ok(compareCellValues('a', 'b', 'asc') < 0);
    assert.ok(compareCellValues('a', 'b', 'desc') > 0);
});

test('compareCellValues always sorts nulls last', () => {
    assert.equal(compareCellValues(null, 5, 'asc'), 1);
    assert.equal(compareCellValues(5, null, 'asc'), -1);
});

// ===== normalizeCellInput =====

test('normalizeCellInput preserves leading/trailing whitespace for text', () => {
    assert.equal(normalizeCellInput('  hello  ', false, SEP), '  hello  ');
    assert.equal(normalizeCellInput(' foo', false, SEP), ' foo');
    assert.equal(normalizeCellInput('', false, SEP), '');
});

test('normalizeCellInput normalizes numeric input', () => {
    assert.equal(normalizeCellInput('1 234,50', true, SEP), '1234.50');
});

test('normalizeCellInput trims surrounding whitespace for numeric input', () => {
    assert.equal(normalizeCellInput('  1 234,50  ', true, SEP), '1234.50');
});

test('normalizeCellInput leaves empty numeric input untouched', () => {
    assert.equal(normalizeCellInput('   ', true, SEP), '');
});

test('normalizeCellInput tolerates null/undefined raw text', () => {
    assert.equal(normalizeCellInput(null, false, SEP), '');
    assert.equal(normalizeCellInput(undefined, true, SEP), '');
});

// ===== mappingConditionToClause =====

test('mappingConditionToClause builds an equality clause with a quoted value', () => {
    const cond = { column: 'type', operator: '=', value: 'A' };
    assert.equal(mappingConditionToClause(cond, '"type"', 'text', SEP), `"type" = 'A'`);
});

test('mappingConditionToClause builds comparison clauses', () => {
    assert.equal(
        mappingConditionToClause({ column: 'qty', operator: '>', value: '10' }, '"qty"', 'numeric', SEP),
        `"qty" > '10'`
    );
    assert.equal(
        mappingConditionToClause({ column: 'type', operator: '!=', value: 'B' }, '"type"', 'text', SEP),
        `"type" != 'B'`
    );
});

test('mappingConditionToClause wraps LIKE/ILIKE values in a contains match', () => {
    assert.equal(
        mappingConditionToClause({ column: 'name', operator: 'LIKE', value: 'foo' }, '"name"', 'text', SEP),
        `"name" LIKE '%foo%'`
    );
    assert.equal(
        mappingConditionToClause({ column: 'name', operator: 'ILIKE', value: 'bar' }, '"name"', 'text', SEP),
        `"name" ILIKE '%bar%'`
    );
});

test('mappingConditionToClause escapes single quotes in values', () => {
    assert.equal(
        mappingConditionToClause({ column: 'note', operator: '=', value: "O'Brien" }, '"note"', 'text', SEP),
        `"note" = 'O''Brien'`
    );
});

test('mappingConditionToClause returns empty string for incomplete conditions', () => {
    assert.equal(mappingConditionToClause(null, '"x"', 'text', SEP), '');
    assert.equal(mappingConditionToClause({ column: '', operator: '=', value: 'a' }, '""', 'text', SEP), '');
    assert.equal(mappingConditionToClause({ column: 'x', operator: '', value: 'a' }, '"x"', 'text', SEP), '');
});

// ===== buildErrorDialogState =====

test('buildErrorDialogState shows the trimmed error message', () => {
    assert.deepEqual(
        buildErrorDialogState('  syntax error at or near "SELEC"  '),
        { visible: true, message: 'syntax error at or near "SELEC"' }
    );
});

test('buildErrorDialogState falls back to a generic message for blank input', () => {
    assert.deepEqual(buildErrorDialogState(''), { visible: true, message: 'An unknown error occurred.' });
    assert.deepEqual(buildErrorDialogState('   '), { visible: true, message: 'An unknown error occurred.' });
});

test('buildErrorDialogState tolerates null and undefined', () => {
    assert.deepEqual(buildErrorDialogState(null), { visible: true, message: 'An unknown error occurred.' });
    assert.deepEqual(buildErrorDialogState(undefined), { visible: true, message: 'An unknown error occurred.' });
});

test('buildErrorDialogState stringifies non-string error values', () => {
    assert.deepEqual(buildErrorDialogState(42), { visible: true, message: '42' });
});


// ===== numeric sorting (bigint / numeric arrive as strings) =====

const {
    compareNumericText,
    toNumericLiteral,
    sanitizeThousandSeparator,
    parseCellKey,
    formatMappingConditions,
    exportQuerySql,
    isStaleLoadAnswer,
    rowFingerprint,
    resolveCellEditorRow,
    planClipboardPaste,
    normalizeNumericInput,
    formatNumberDisplay
} = require(path.join(__dirname, '../../../src/webview/tableView.js'));

test('compareCellValues orders numeric strings of a numeric column by value', () => {
    const values = ['100', '20', '3', '-5', '1000000000000', null, '-20.5', '0.25'];
    const sorted = [...values].sort((a, b) => compareCellValues(a, b, 'asc', true));
    assert.deepEqual(sorted, ['-20.5', '-5', '0.25', '3', '20', '100', '1000000000000', null]);
    const desc = [...values].sort((a, b) => compareCellValues(a, b, 'desc', true));
    assert.deepEqual(desc, ['1000000000000', '100', '20', '3', '0.25', '-5', '-20.5', null]);
});

test('compareNumericText is exact beyond 2^53 and across scales', () => {
    assert.ok(compareNumericText('9007199254740993', '9007199254740992') > 0);
    assert.equal(compareNumericText('1.50', '1.5'), 0);
    assert.equal(compareNumericText('-0', '0'), 0);
    assert.ok(compareNumericText('-1.25', '-1.2') < 0);
    assert.ok(compareNumericText('NaN', '5') > 0, 'NaN sorts above every number');
});

// ===== numeric filter literals =====

test('buildFilterClause keeps the digits of a bigint filter value', () => {
    assert.equal(buildFilterClause('"id"', '9007199254740993', 'numeric', false, '=', SEP), '"id" = 9007199254740993');
    assert.equal(
        buildFilterClause('"id"', { from: '9007199254740993', to: '' }, 'numeric', false, '=', SEP),
        '"id" >= 9007199254740993'
    );
});

test('toNumericLiteral accepts plain numbers and rejects anything else', () => {
    assert.equal(toNumericLiteral('1e400'), '1e400');
    assert.equal(toNumericLiteral('-12.5'), '-12.5');
    assert.equal(toNumericLiteral('Infinity'), null);
    assert.equal(toNumericLiteral('1; DROP TABLE x'), null);
    assert.equal(buildFilterClause('"c"', 'Infinity', 'numeric', false, '=', SEP), null);
});

test('rowValueMatchesFilter compares bigint strings exactly', () => {
    assert.equal(rowValueMatchesFilter('9007199254740993', '9007199254740992', 'numeric', 'gt', SEP), true);
    assert.equal(rowValueMatchesFilter('5', 'abc', 'numeric', 'gt', SEP), true, 'an invalid filter does not constrain');
});

// ===== thousand separator =====

test('sanitizeThousandSeparator drops a separator that clashes with the decimal comma', () => {
    assert.equal(sanitizeThousandSeparator(','), '');
    assert.equal(sanitizeThousandSeparator('1'), '');
    assert.equal(sanitizeThousandSeparator('.'), '.');
    assert.equal(sanitizeThousandSeparator(' '), ' ');
});

test('a numeric value survives display and re-entry with every allowed separator', () => {
    for (const sep of [' ', '\u00a0', '.', "'", '', sanitizeThousandSeparator(',')]) {
        for (const value of ['0.5', '1234.5', '-9999999.99', '42']) {
            const shown = formatNumberDisplay(value, sep);
            assert.equal(normalizeNumericInput(shown, sep), value, `separator ${JSON.stringify(sep)}: ${value} -> ${shown}`);
        }
    }
});

// ===== cell keys =====

test('parseCellKey keeps a column name that contains a colon', () => {
    assert.deepEqual(parseCellKey('3:price:eur'), { rowIdx: 3, colName: 'price:eur' });
    assert.deepEqual(parseCellKey('0:id'), { rowIdx: 0, colName: 'id' });
});

// ===== mapping conditions =====

test('formatMappingConditions summarises conditions as plain text', () => {
    assert.equal(
        formatMappingConditions([{ column: 'kind', operator: '=', value: 'a' }, { column: 'n', operator: '>', value: 2 }]),
        "kind = 'a', n > '2'"
    );
    assert.equal(formatMappingConditions(undefined), '');
});

test('the mapping list escapes condition values from the workspace file', () => {
    const fs = require('node:fs');
    const src: string = fs.readFileSync(path.join(__dirname, '../../../src/webview/tableView.js'), 'utf8');
    assert.ok(src.includes('escapeHtml(formatMappingConditions(mapping.conditions))'));
    assert.ok(!/\$\{c\.value\}/.test(src), 'a condition value must never be interpolated raw');
});

// ===== export =====

test('exportQuerySql exports the executed query, not unsaved query bar text', () => {
    assert.equal(exportQuerySql('SELECT * FROM t', 'SELECT * FROM t', false), 'SELECT * FROM t');
    assert.equal(exportQuerySql('SELECT * FROM t LIMIT 100', 'SELECT * FROM t', true), 'SELECT * FROM t LIMIT 100');
    assert.equal(exportQuerySql('', '', false), '');
});

// ===== load ids =====

test('isStaleLoadAnswer drops answers to a replaced load only', () => {
    assert.equal(isStaleLoadAnswer(3, 4), true);
    assert.equal(isStaleLoadAnswer(4, 4), false);
    assert.equal(isStaleLoadAnswer(undefined, 4), false);
});

// ===== cell editor write-back =====

test('resolveCellEditorRow keeps the index while the row there is unchanged', () => {
    const rows = [{ id: 1 }, { id: 2 }];
    assert.equal(resolveCellEditorRow(rows, 1, { fingerprint: rowFingerprint(rows[1]) }), 1);
});

test('resolveCellEditorRow follows the record after a reload moved it', () => {
    const before = [{ id: 1, v: 'a' }, { id: 2, v: 'b' }];
    const token = { fingerprint: rowFingerprint(before[0]) };
    const after = [{ id: 3, v: 'new' }, { id: 1, v: 'a' }, { id: 2, v: 'b' }];
    assert.equal(resolveCellEditorRow(after, 0, token), 1);
});

test('resolveCellEditorRow never trusts a bare index that now holds another row (reopened panel)', () => {
    const token = { fingerprint: rowFingerprint({ id: 2, v: 'b' }) };
    const reopened = [{ id: 5, v: 'x' }, { id: 7, v: 'y' }, { id: 2, v: 'b' }];
    assert.equal(resolveCellEditorRow(reopened, 1, token), 2);
    assert.equal(resolveCellEditorRow([{ id: 5, v: 'x' }, { id: 7, v: 'y' }], 1, token), -1);
});

test('resolveCellEditorRow refuses a row that is gone, changed or ambiguous', () => {
    const token = { fingerprint: rowFingerprint({ id: 1, v: 'a' }) };
    assert.equal(resolveCellEditorRow([{ id: 1, v: 'changed' }], 0, token), -1);
    assert.equal(resolveCellEditorRow([{ id: 2, v: 'b' }], 0, token), -1);
    assert.equal(resolveCellEditorRow([{ id: 0, v: 'z' }, { id: 1, v: 'a' }, { v: 'a', id: 1 }], 0, token), -1);
});

// ===== paste into a sorted or filtered grid =====

test('planClipboardPaste follows the displayed row order', () => {
    // Grid sorted so that allRows 4, 0, 2 are shown in that order.
    const plan = planClipboardPaste([['a'], ['b'], ['c']], 0, 0, [4, 0, 2], ['x'], () => true);
    assert.deepEqual(plan.cellUpdates.map((u: any) => [u.rowIdx, u.value]), [[4, 'a'], [0, 'b'], [2, 'c']]);
    assert.deepEqual(plan.newRows, []);
});

test('planClipboardPaste adds new rows only past the last displayed row', () => {
    // Filtered: only allRows 1 and 3 are visible; the paste starts on row 3.
    const plan = planClipboardPaste([['a'], ['b']], 1, 0, [1, 3], ['x'], () => true);
    assert.deepEqual(plan.cellUpdates.map((u: any) => [u.rowIdx, u.value]), [[3, 'a']]);
    assert.deepEqual(plan.newRows, [{ x: 'b' }]);
});

// ===== review follow-up: sort types, range filter, duplicated json =====

const {
    isNumericScalarType,
    duplicateCellValue
} = require(path.join(__dirname, '../../../src/webview/tableView.js'));

test('isNumericScalarType sorts only plain number types by value', () => {
    for (const t of ['int4', 'int8', 'bigint', 'numeric(10,2)', 'float8', 'double precision', 'smallint', 'real']) {
        assert.equal(isNumericScalarType(t), true, t);
    }
    for (const t of ['_int4', 'integer[]', 'int4range', 'interval', 'point', 'money', 'text']) {
        assert.equal(isNumericScalarType(t), false, t);
    }
});

test('a money or range column sorts as text again instead of not at all', () => {
    const values = ['[5,9)', '[1,3)', '[3,4)'];
    const sorted = [...values].sort((a, b) => compareCellValues(a, b, 'asc', isNumericScalarType('int4range')));
    assert.deepEqual(sorted, ['[1,3)', '[3,4)', '[5,9)']);
});

test('rowValueMatchesFilter compares a numeric range exactly beyond 2^53', () => {
    const range = { from: '9007199254740993', to: '' };
    assert.equal(rowValueMatchesFilter('9007199254740992', range, 'numeric', undefined, SEP), false);
    assert.equal(rowValueMatchesFilter('9007199254740993', range, 'numeric', undefined, SEP), true);
    assert.equal(rowValueMatchesFilter('5', { from: '1', to: '10' }, 'numeric', undefined, SEP), true);
    assert.equal(rowValueMatchesFilter('11', { from: '1', to: '10' }, 'numeric', undefined, SEP), false);
});

test('rowValueMatchesFilter keeps NULL out of a numeric range and ignores an invalid bound', () => {
    assert.equal(rowValueMatchesFilter(null, { from: '-1', to: '1' }, 'numeric', undefined, SEP), false);
    assert.equal(rowValueMatchesFilter('5', { from: 'abc', to: '' }, 'numeric', undefined, SEP), true);
});

test('duplicateCellValue copies a json value as JSON text so a JSON string stays a string', () => {
    assert.equal(duplicateCellValue('123', 'jsonb', false), '"123"');
    assert.equal(duplicateCellValue('true', 'json', false), '"true"');
    assert.equal(duplicateCellValue({ a: 1 }, 'jsonb', false), '{"a":1}');
    assert.equal(duplicateCellValue(5, 'jsonb', false), '5');
    assert.equal(duplicateCellValue(null, 'jsonb', false), null);
});

test('duplicateCellValue leaves edited json text and other columns alone', () => {
    assert.equal(duplicateCellValue('{"b":2}', 'jsonb', true), '{"b":2}');
    assert.equal(duplicateCellValue('abc', 'text', false), 'abc');
    assert.equal(duplicateCellValue(7, 'int4', false), 7);
});

// ===== pruneColumnState: filters of columns the query no longer selects =====

const {
    pruneColumnState,
    selectListExpressions,
    columnFilterTarget,
    mergeColumnConditions,
    parseSqlForWhere: parseWhere,
    assembleWhereQuery: assembleWhere,
    whereClauseTargetsColumn: targetsColumn,
    buildNullConstraintClause: nullClause
} = require(path.join(__dirname, '../../../src/webview/tableView.js'));
const { POSTGRES_RESERVED_KEYWORDS } = require('../reservedKeywords');
const isReserved = (word: string) => POSTGRES_RESERVED_KEYWORDS.has(word);

test('pruneColumnState drops the filter, mode and exact flag of a removed column', () => {
    const pruned = pruneColumnState({
        filters: { region: 'nord', id: '5' },
        exactFilters: { region: true },
        filterModes: { region: 'gt', id: 'lt' },
        sortState: { column: null, direction: 'asc', previous: null }
    }, ['id']);
    assert.deepEqual(pruned.filters, { id: '5' });
    assert.deepEqual(pruned.exactFilters, {});
    assert.deepEqual(pruned.filterModes, { id: 'lt' });
});

test('pruneColumnState drops the sort of a removed column and a sort it would go back to', () => {
    const gone = pruneColumnState({ sortState: { column: 'region', direction: 'desc', previous: null } }, ['id']);
    assert.deepEqual(gone.sortState, { column: null, direction: 'asc', previous: null });
    const kept = pruneColumnState({
        sortState: { column: 'id', direction: 'asc', previous: { column: 'region', direction: 'desc' } }
    }, ['id']);
    assert.deepEqual(kept.sortState, { column: 'id', direction: 'asc', previous: null });
});

test('pruneColumnState keeps everything when the new result has no columns', () => {
    const state = {
        filters: { region: 'nord' }, exactFilters: {}, filterModes: {},
        sortState: { column: 'region', direction: 'asc', previous: null }
    };
    const pruned = pruneColumnState(state, []);
    assert.deepEqual(pruned.filters, { region: 'nord' });
    assert.equal(pruned.sortState.column, 'region');
});

test('the grid prunes the column state whenever a new column list arrives', () => {
    const fs = require('node:fs');
    const js = fs.readFileSync(path.join(__dirname, '../../../src/webview/tableView.js'), 'utf8');
    assert.match(js, /columns = msg\.columns \|\| \[\];\s*pruneStateOfRemovedColumns\(\);/);
    assert.match(js, /columns = msg\.columns \|\| columns;\s*if \(msg\.columns\) pruneStateOfRemovedColumns\(\);/);
});

// ===== selectListExpressions / columnFilterTarget: filtering computed columns =====

const quote = (name: string) => (/^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`);

// What the grid does on Enter in a filter box, through the pure helpers.
function filterQuery(sql: string, col: string, value: string, sources: Record<string, unknown> = {}): string {
    const target = columnFilterTarget(col, sources[col], selectListExpressions(sql, isReserved), quote);
    const clause = value ? buildFilterClause(target.reference, value, 'text', false, '=', SEP) : '';
    const parsed = parseWhere(sql);
    const where = target.clause === 'where' ? { [col]: clause } : {};
    const having = target.clause === 'having' ? { [col]: clause } : {};
    return assembleWhere(parsed, mergeColumnConditions(parsed, where, having, { [col]: target.reference }));
}

test('a filter on a function column is written on its expression, not its alias', () => {
    const sql = 'SELECT mitarbeiter.region(mit_id) as region, mit_id FROM mitarbeiter;';
    assert.equal(
        filterQuery(sql, 'region', 'nord'),
        "SELECT mitarbeiter.region(mit_id) as region, mit_id FROM mitarbeiter WHERE (mitarbeiter.region(mit_id))::text ILIKE '%nord%'"
    );
});

test('filtering a computed column again replaces its condition, clearing it removes it', () => {
    const sql = 'SELECT mitarbeiter.region(mit_id) as region, mit_id FROM mitarbeiter WHERE mit_id > 3';
    const once = filterQuery(sql, 'region', 'nord');
    const twice = filterQuery(once, 'region', 'süd');
    assert.equal(
        twice,
        "SELECT mitarbeiter.region(mit_id) as region, mit_id FROM mitarbeiter WHERE mit_id > 3 AND (mitarbeiter.region(mit_id))::text ILIKE '%süd%'"
    );
    assert.equal(filterQuery(twice, 'region', ''), 'SELECT mitarbeiter.region(mit_id) as region, mit_id FROM mitarbeiter WHERE mit_id > 3');
});

test('a plain column keeps being filtered by its name', () => {
    assert.equal(
        filterQuery('SELECT mitarbeiter.region(mit_id) as region, mit_id FROM mitarbeiter', 'mit_id', '7'),
        "SELECT mitarbeiter.region(mit_id) as region, mit_id FROM mitarbeiter WHERE mit_id::text ILIKE '%7%'"
    );
    assert.deepEqual(selectListExpressions('SELECT a, t.b, t.c AS c FROM t', isReserved), {});
});

test('selectListExpressions names columns the way PostgreSQL does', () => {
    const map = selectListExpressions(
        'SELECT upper(a) u, lower(b) AS "Low", count(*), s.fn(x), x::int, t.c AS d FROM t',
        isReserved
    );
    assert.deepEqual(Object.keys(map).sort(), ['Low', 'count', 'd', 'fn', 'u', 'x']);
    assert.equal(map.u.expression, 'upper(a)');
    assert.equal(map.Low.expression, 'lower(b)');
    assert.equal(map.fn.expression, 's.fn(x)');
    assert.equal(map.d.simple, true);
    assert.equal(columnFilterTarget('d', undefined, map, quote).reference, 't.c');
});

test('selectListExpressions keeps commas, parentheses and strings inside an expression together', () => {
    const map = selectListExpressions(
        "SELECT coalesce(nullif(a, ','), concat(b, ')(')) AS v, b FROM t",
        isReserved
    );
    assert.equal(map.v.expression, "coalesce(nullif(a, ','), concat(b, ')('))");
});

test('selectListExpressions skips DISTINCT ON, comments and leading CTEs', () => {
    const map = selectListExpressions(
        'WITH x AS (SELECT 1 AS one) SELECT DISTINCT ON (a) a, /* note */ upper(b) /* tail */ AS ub -- alias\n, c FROM t',
        isReserved
    );
    assert.deepEqual(Object.keys(map), ['ub']);
    assert.equal(map.ub.expression, 'upper(b)');
});

test('selectListExpressions leaves out a name the select list yields twice', () => {
    assert.deepEqual(selectListExpressions('SELECT upper(a) v, lower(a) v FROM t', isReserved), {});
});

test('a filter on an aggregate column goes into HAVING, after GROUP BY', () => {
    const sql = 'SELECT dept, count(*) AS n FROM emp WHERE active GROUP BY dept ORDER BY dept';
    assert.equal(
        filterQuery(sql, 'n', '3'),
        "SELECT dept, count(*) AS n FROM emp WHERE active GROUP BY dept HAVING (count(*))::text ILIKE '%3%' ORDER BY dept"
    );
    const kept = 'SELECT dept, count(*) AS n FROM emp GROUP BY dept HAVING count(*) > 1';
    const filtered = filterQuery(kept, 'n', '3');
    assert.equal(filtered, "SELECT dept, count(*) AS n FROM emp GROUP BY dept HAVING count(*) > 1 AND (count(*))::text ILIKE '%3%'");
    assert.equal(filterQuery(filtered, 'n', ''), kept);
});

test('an aggregate inside a subquery or a window does not count as an aggregate', () => {
    const map = selectListExpressions(
        'SELECT (SELECT max(b) FROM u) AS m, sum(a) OVER (PARTITION BY c) AS s, unnest(arr) AS e FROM t',
        isReserved
    );
    assert.equal(map.m.aggregate, false);
    assert.equal(columnFilterTarget('m', undefined, map, quote).clause, 'where');
    assert.equal(map.s.window, true);
    assert.equal(map.s.aggregate, false);
    assert.equal(columnFilterTarget('s', undefined, map, quote).clause, 'none');
    assert.equal(columnFilterTarget('e', undefined, map, quote).clause, 'none');
});

test('a column traced to an aliased source column keeps its qualified reference', () => {
    const map = selectListExpressions('SELECT a.x, b.x FROM a JOIN b ON true', isReserved);
    assert.deepEqual(
        columnFilterTarget('x', { qualifier: 'b', sourceColumn: 'x' }, map, quote),
        { reference: 'b.x', clause: 'where' }
    );
});

test('a WHERE filter on a grouped query goes before GROUP BY', () => {
    assert.equal(
        filterQuery('SELECT dept, count(*) AS n FROM emp GROUP BY dept', 'dept', 'it'),
        "SELECT dept, count(*) AS n FROM emp WHERE dept::text ILIKE '%it%' GROUP BY dept"
    );
    assert.equal(
        assembleWhere(parseWhere('SELECT a, count(*) FROM t GROUP BY a HAVING count(*) > 1'), [nullClause('a', false)]),
        'SELECT a, count(*) FROM t WHERE a IS NOT NULL GROUP BY a HAVING count(*) > 1'
    );
});

test('parseSqlForWhere leaves an ORDER BY inside an aggregate or a window alone', () => {
    const parsed = parseWhere("SELECT d, string_agg(n, ',' ORDER BY n) AS l, row_number() OVER (ORDER BY d) r FROM t GROUP BY d ORDER BY d");
    assert.equal(parsed.orderBy, 'd');
    assert.equal(parsed.groupBy, 'GROUP BY d');
    assert.equal(parsed.base, "SELECT d, string_agg(n, ',' ORDER BY n) AS l, row_number() OVER (ORDER BY d) r FROM t");
});

test('whereClauseTargetsColumn does not take a function call for the column of the same name', () => {
    assert.equal(targetsColumn('count(*) > 1', 'count'), false);
    assert.equal(targetsColumn('upper (name) = 1', 'upper'), false);
    assert.equal(targetsColumn('(count(*))::text ILIKE \'%1%\'', 'count', '(count(*))'), true);
    assert.equal(targetsColumn('t.ab = 1', 'b', 't.a'), false);
});
