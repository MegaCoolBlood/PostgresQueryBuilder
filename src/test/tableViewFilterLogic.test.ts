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
} = require(path.join(__dirname, '../../src/webview/tableView.js'));

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

test('normalizeCellInput trims plain text', () => {
    assert.equal(normalizeCellInput('  hello  ', false, SEP), 'hello');
    assert.equal(normalizeCellInput('', false, SEP), '');
});

test('normalizeCellInput normalizes numeric input', () => {
    assert.equal(normalizeCellInput('1 234,50', true, SEP), '1234.50');
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

