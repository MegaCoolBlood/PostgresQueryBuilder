import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const { normalizeNumericInput, formatNumberDisplay, formatExactMatchValue, normalizeFilterInputValue, escapeSqlString, liveFormatNumeric, stripThousandSeparators, cellRangeToTsv, parseClipboardTable, planClipboardPaste, singleClipboardValue, resolveMouseRelease, isSingleCellSelection } = require(
    path.join(__dirname, '../../../src/webview/tableView.js')
);

test('normalizeNumericInput strips thousand separators and converts decimal comma', () => {
    assert.equal(normalizeNumericInput('1 234,50', ' '), '1234.50');
    assert.equal(normalizeNumericInput('-9 999 999,99', ' '), '-9999999.99');
});

test('stripThousandSeparators removes separators but keeps the decimal as shown', () => {
    assert.equal(stripThousandSeparators('9 999 999,99', ' '), '9999999,99');
    assert.equal(stripThousandSeparators('1 234', ' '), '1234');
    assert.equal(stripThousandSeparators('-12 345,67', ' '), '-12345,67');
});

test('stripThousandSeparators supports other separators and leaves text alone', () => {
    assert.equal(stripThousandSeparators('1.234.567,89', '.'), '1234567,89');
    assert.equal(stripThousandSeparators('hello world', ' '), 'helloworld');
    assert.equal(stripThousandSeparators('1234,5', ''), '1234,5');
});

test('cellRangeToTsv joins columns with TAB and rows with CRLF (Excel-compatible)', () => {
    assert.equal(
        cellRangeToTsv([['a', 'b'], ['c', 'd']]),
        'a\tb\r\nc\td'
    );
    // A single cell has no separators.
    assert.equal(cellRangeToTsv([['only']]), 'only');
    // A single column of several rows is CRLF separated.
    assert.equal(cellRangeToTsv([['1'], ['2'], ['3']]), '1\r\n2\r\n3');
    // A single row of several columns is TAB separated.
    assert.equal(cellRangeToTsv([['x', 'y', 'z']]), 'x\ty\tz');
});

test('cellRangeToTsv tolerates empty and malformed input', () => {
    assert.equal(cellRangeToTsv([]), '');
    assert.equal(cellRangeToTsv(null), '');
    assert.equal(cellRangeToTsv(undefined), '');
    // Empty strings (e.g. NULL cells rendered blank) are preserved as empty fields.
    assert.equal(cellRangeToTsv([['a', ''], ['', 'd']]), 'a\t\r\n\td');
});

// ===== 3.2.0: paste a block of Excel cells into the grid =====

test('parseClipboardTable splits a TAB/newline block into a matrix', () => {
    assert.deepEqual(
        parseClipboardTable('a\tb\tc\r\nd\te\tf'),
        [['a', 'b', 'c'], ['d', 'e', 'f']]
    );
});

test('parseClipboardTable drops the single trailing empty row Excel appends', () => {
    assert.deepEqual(parseClipboardTable('a\tb\r\nc\td\r\n'), [['a', 'b'], ['c', 'd']]);
});

test('parseClipboardTable keeps genuine empty cells and empty middle rows', () => {
    assert.deepEqual(parseClipboardTable('a\t\r\n\td'), [['a', ''], ['', 'd']]);
    assert.deepEqual(parseClipboardTable('a\tb\r\n\r\nc\td'), [['a', 'b'], [''], ['c', 'd']]);
});

test('parseClipboardTable honours quoted fields with embedded tabs, newlines and quotes', () => {
    assert.deepEqual(parseClipboardTable('"a\tb"\tc'), [['a\tb', 'c']]);
    assert.deepEqual(parseClipboardTable('"line1\nline2"\tx'), [['line1\nline2', 'x']]);
    assert.deepEqual(parseClipboardTable('"say ""hi"""\ty'), [['say "hi"', 'y']]);
});

test('parseClipboardTable treats a lone quote inside plain text as a literal', () => {
    assert.deepEqual(parseClipboardTable('5" pipe\tqty'), [['5" pipe', 'qty']]);
});

test('parseClipboardTable returns a single empty row for empty input', () => {
    assert.deepEqual(parseClipboardTable(''), [['']]);
    assert.deepEqual(parseClipboardTable(null), [['']]);
});

test('planClipboardPaste overwrites existing rows from the start cell', () => {
    const plan = planClipboardPaste(
        [['1', '2'], ['3', '4']], 0, 0, 5, ['a', 'b', 'c'], () => true
    );
    assert.deepEqual(plan.cellUpdates, [
        { rowIdx: 0, colName: 'a', value: '1' },
        { rowIdx: 0, colName: 'b', value: '2' },
        { rowIdx: 1, colName: 'a', value: '3' },
        { rowIdx: 1, colName: 'b', value: '4' }
    ]);
    assert.deepEqual(plan.newRows, []);
});

test('planClipboardPaste maps columns from the selected start column', () => {
    const plan = planClipboardPaste([['x', 'y']], 2, 1, 5, ['a', 'b', 'c'], () => true);
    assert.deepEqual(plan.cellUpdates, [
        { rowIdx: 2, colName: 'b', value: 'x' },
        { rowIdx: 2, colName: 'c', value: 'y' }
    ]);
});

test('planClipboardPaste ignores values that fall past the last column', () => {
    const plan = planClipboardPaste([['x', 'y', 'z']], 0, 1, 5, ['a', 'b', 'c'], () => true);
    assert.deepEqual(plan.cellUpdates, [
        { rowIdx: 0, colName: 'b', value: 'x' },
        { rowIdx: 0, colName: 'c', value: 'y' }
    ]);
});

test('planClipboardPaste skips values whose target column is not editable', () => {
    const editable = (name: string) => name !== 'b';
    const plan = planClipboardPaste([['1', '2', '3']], 0, 0, 5, ['a', 'b', 'c'], editable);
    assert.deepEqual(plan.cellUpdates, [
        { rowIdx: 0, colName: 'a', value: '1' },
        { rowIdx: 0, colName: 'c', value: '3' }
    ]);
});

test('planClipboardPaste turns rows past the loaded data into new rows', () => {
    const plan = planClipboardPaste(
        [['1', '2'], ['3', '4'], ['5', '6']], 1, 0, 2, ['a', 'b'], () => true
    );
    assert.deepEqual(plan.cellUpdates, [
        { rowIdx: 1, colName: 'a', value: '1' },
        { rowIdx: 1, colName: 'b', value: '2' }
    ]);
    assert.deepEqual(plan.newRows, [
        { a: '3', b: '4' },
        { a: '5', b: '6' }
    ]);
});

test('planClipboardPaste appends every row as new when the start is past the data', () => {
    const plan = planClipboardPaste([['1', '2']], 0, 0, 0, ['a', 'b'], () => true);
    assert.deepEqual(plan.cellUpdates, []);
    assert.deepEqual(plan.newRows, [{ a: '1', b: '2' }]);
});

test('planClipboardPaste drops a new row that maps to no editable column', () => {
    const plan = planClipboardPaste([['x']], 0, 5, 0, ['a', 'b'], () => true);
    assert.deepEqual(plan.newRows, []);
});

test('singleClipboardValue returns the lone value of a one-cell matrix', () => {
    assert.equal(singleClipboardValue([['hello']]), 'hello');
    assert.equal(singleClipboardValue([['']]), '');
    assert.equal(singleClipboardValue(parseClipboardTable('42')), '42');
});

test('singleClipboardValue returns null for a multi-cell or empty matrix', () => {
    assert.equal(singleClipboardValue([['a', 'b']]), null);
    assert.equal(singleClipboardValue([['a'], ['b']]), null);
    assert.equal(singleClipboardValue([]), null);
    assert.equal(singleClipboardValue(null), null);
    // A one-row/one-column block with a trailing tab is two cells, not one.
    assert.equal(singleClipboardValue(parseClipboardTable('a\t')), null);
});

// ===== 3.2.0: click selects a cell, double-click edits, drag selects text =====

test('resolveMouseRelease keeps a rectangle after dragging across cells', () => {
    assert.equal(resolveMouseRelease(true, false), 'range');
    assert.equal(resolveMouseRelease(true, true), 'range');
});

test('resolveMouseRelease keeps a text selection made inside one cell', () => {
    assert.equal(resolveMouseRelease(false, true), 'text');
});

test('resolveMouseRelease marks the cell on a plain click', () => {
    assert.equal(resolveMouseRelease(false, false), 'select');
});

// ===== 3.2.0: Excel-style fill handle on a single selected cell =====

test('isSingleCellSelection is true only for a one-cell selection', () => {
    assert.equal(isSingleCellSelection({ r: 2, c: 3 }, { r: 2, c: 3 }), true);
    assert.equal(isSingleCellSelection({ r: 2, c: 3 }, { r: 2, c: 4 }), false);
    assert.equal(isSingleCellSelection({ r: 2, c: 3 }, { r: 5, c: 3 }), false);
    assert.equal(isSingleCellSelection(null, { r: 2, c: 3 }), false);
    assert.equal(isSingleCellSelection({ r: 2, c: 3 }, null), false);
    assert.equal(isSingleCellSelection(null, null), false);
});

test('formatNumberDisplay uses thousand separators and comma decimal', () => {
    assert.equal(formatNumberDisplay(12345.67, ' '), '12 345,67');
    assert.equal(formatNumberDisplay(-9876543.2, ' '), '-9 876 543,2');
});

test('formatExactMatchValue normalizes numeric exact matches', () => {
    assert.equal(formatExactMatchValue('1 234,50', 'numeric', ' '), "'1234.50'");
    assert.equal(formatExactMatchValue("O'Reilly", 'text', ' '), "'O''Reilly'");
});

test('normalizeFilterInputValue normalizes localized numeric filter input', () => {
    assert.equal(normalizeFilterInputValue('12 345,67', 'numeric', ' '), '12345.67');
    assert.equal(normalizeFilterInputValue('-9 999', 'numeric', ' '), '-9999');
});

test('normalizeNumericInput returns null/undefined unchanged', () => {
    assert.equal(normalizeNumericInput(null, ' '), null);
    assert.equal(normalizeNumericInput(undefined, ' '), undefined);
});

test('normalizeNumericInput returns empty string unchanged', () => {
    assert.equal(normalizeNumericInput('', ' '), '');
    assert.equal(normalizeNumericInput('   ', ' '), '');
});

test('normalizeNumericInput returns original for non-numeric input', () => {
    assert.equal(normalizeNumericInput('abc', ' '), 'abc');
    assert.equal(normalizeNumericInput('12a34', ' '), '12a34');
});

test('formatNumberDisplay returns null for null/undefined', () => {
    assert.equal(formatNumberDisplay(null, ' '), null);
    assert.equal(formatNumberDisplay(undefined, ' '), null);
});

test('formatNumberDisplay handles zero correctly', () => {
    assert.equal(formatNumberDisplay(0, ' '), '0');
    assert.equal(formatNumberDisplay(-0, ' '), '0');
});

test('formatNumberDisplay returns string for non-numeric value', () => {
    assert.equal(formatNumberDisplay('abc', ' '), 'abc');
});

test('formatNumberDisplay handles integer without decimals', () => {
    assert.equal(formatNumberDisplay(1000, ' '), '1 000');
    assert.equal(formatNumberDisplay(999, ' '), '999');
});

test('formatExactMatchValue escapes single quotes in text type', () => {
    assert.equal(formatExactMatchValue("it's a test", 'text', ' '), "'it''s a test'");
});

test('formatExactMatchValue handles null-like numeric string', () => {
    assert.equal(formatExactMatchValue('0', 'numeric', ' '), "'0'");
});

test('normalizeFilterInputValue returns string for text type', () => {
    assert.equal(normalizeFilterInputValue('hello', 'text', ' '), 'hello');
    assert.equal(normalizeFilterInputValue(123, 'text', ' '), '123');
});

test('normalizeFilterInputValue returns null/undefined unchanged', () => {
    assert.equal(normalizeFilterInputValue(null, 'numeric', ' '), null);
    assert.equal(normalizeFilterInputValue(undefined, 'text', ' '), undefined);
});

// Tests for live formatting (normalize then format round-trip)
test('live formatting: raw integer input gets thousand separators', () => {
    const input = '1234567';
    const normalized = normalizeNumericInput(input, ' ');
    const formatted = formatNumberDisplay(normalized, ' ');
    assert.equal(formatted, '1 234 567');
});

test('live formatting: raw decimal input gets thousand separators and comma', () => {
    const input = '1234567.89';
    const normalized = normalizeNumericInput(input, ' ');
    const formatted = formatNumberDisplay(normalized, ' ');
    assert.equal(formatted, '1 234 567,89');
});

test('live formatting: already formatted input stays stable (idempotent)', () => {
    const input = '1 234 567,89';
    const normalized = normalizeNumericInput(input, ' ');
    assert.equal(normalized, '1234567.89');
    const formatted = formatNumberDisplay(normalized, ' ');
    assert.equal(formatted, '1 234 567,89');
    // Second round-trip should produce same result
    const normalized2 = normalizeNumericInput(formatted, ' ');
    const formatted2 = formatNumberDisplay(normalized2, ' ');
    assert.equal(formatted2, '1 234 567,89');
});

test('live formatting: negative number gets formatted correctly', () => {
    const input = '-98765';
    const normalized = normalizeNumericInput(input, ' ');
    const formatted = formatNumberDisplay(normalized, ' ');
    assert.equal(formatted, '-98 765');
});

test('live formatting: small number (no separators needed)', () => {
    const input = '999';
    const normalized = normalizeNumericInput(input, ' ');
    const formatted = formatNumberDisplay(normalized, ' ');
    assert.equal(formatted, '999');
});

test('live formatting: number with decimal comma input', () => {
    const input = '12345,67';
    const normalized = normalizeNumericInput(input, ' ');
    assert.equal(normalized, '12345.67');
    const formatted = formatNumberDisplay(normalized, ' ');
    assert.equal(formatted, '12 345,67');
});

test('live formatting: partial input (just digits being typed) stays numeric', () => {
    // Simulate typing "1", "12", "123", "1234"
    assert.equal(formatNumberDisplay(normalizeNumericInput('1', ' '), ' '), '1');
    assert.equal(formatNumberDisplay(normalizeNumericInput('12', ' '), ' '), '12');
    assert.equal(formatNumberDisplay(normalizeNumericInput('123', ' '), ' '), '123');
    assert.equal(formatNumberDisplay(normalizeNumericInput('1234', ' '), ' '), '1 234');
    assert.equal(formatNumberDisplay(normalizeNumericInput('12345', ' '), ' '), '12 345');
    assert.equal(formatNumberDisplay(normalizeNumericInput('123456', ' '), ' '), '123 456');
    assert.equal(formatNumberDisplay(normalizeNumericInput('1234567', ' '), ' '), '1 234 567');
});

test('live formatting: non-numeric input is returned unchanged', () => {
    const input = 'abc';
    const normalized = normalizeNumericInput(input, ' ');
    assert.equal(normalized, 'abc'); // not a number, returned as-is
    const formatted = formatNumberDisplay(normalized, ' ');
    assert.equal(formatted, 'abc'); // formatNumberDisplay returns string for NaN
});

test('live formatting: empty input stays empty', () => {
    const input = '';
    const normalized = normalizeNumericInput(input, ' ');
    assert.equal(normalized, '');
});

// Tests for liveFormatNumeric
test('liveFormatNumeric: returns null for empty input', () => {
    assert.equal(liveFormatNumeric('', 0, ' '), null);
    assert.equal(liveFormatNumeric(null, 0, ' '), null);
});

test('liveFormatNumeric: returns null for non-numeric input', () => {
    assert.equal(liveFormatNumeric('abc', 0, ' '), null);
    assert.equal(liveFormatNumeric('12a34', 2, ' '), null);
});

test('liveFormatNumeric: returns null when already formatted (no change needed)', () => {
    // '1 234' is already formatted, so no change needed
    assert.equal(liveFormatNumeric('1 234', 3, ' '), null);
});

test('liveFormatNumeric: formats unformatted number and returns correct cursor', () => {
    // Typing '1234' with cursor at end (4 digits in)
    const result = liveFormatNumeric('1234', 4, ' ');
    assert.notEqual(result, null);
    assert.equal(result!.formatted, '1 234');
    assert.equal(result!.normalized, '1234');
    assert.equal(result!.newCursor, 5); // cursor after '4' in '1 234'
});

test('liveFormatNumeric: cursor in middle of number', () => {
    // Typing '1234567' with cursor after '4' (4 digits in)
    const result = liveFormatNumeric('1234567', 4, ' ');
    assert.notEqual(result, null);
    assert.equal(result!.formatted, '1 234 567');
    assert.equal(result!.newCursor, 5); // after '4' in '1 234 567'
});

test('liveFormatNumeric: cursor at start', () => {
    const result = liveFormatNumeric('1234', 0, ' ');
    assert.notEqual(result, null);
    assert.equal(result!.formatted, '1 234');
    assert.equal(result!.newCursor, 1); // 0 digits before cursor, lands after first char
});

test('liveFormatNumeric: cursor after first digit', () => {
    const result = liveFormatNumeric('1234', 1, ' ');
    assert.notEqual(result, null);
    assert.equal(result!.formatted, '1 234');
    assert.equal(result!.newCursor, 1); // after '1' in '1 234'
});

test('liveFormatNumeric: handles negative numbers', () => {
    const result = liveFormatNumeric('-1234', 5, ' ');
    assert.notEqual(result, null);
    assert.equal(result!.formatted, '-1 234');
    assert.equal(result!.newCursor, 6);
});

test('liveFormatNumeric: handles decimal numbers', () => {
    const result = liveFormatNumeric('1234.5', 6, ' ');
    assert.notEqual(result, null);
    assert.equal(result!.formatted, '1 234,5');
    assert.equal(result!.newCursor, 7);
});

test('liveFormatNumeric: handles number with decimal comma input', () => {
    const result = liveFormatNumeric('1234,5', 6, ' ');
    assert.notEqual(result, null);
    assert.equal(result!.formatted, '1 234,5');
    assert.equal(result!.normalized, '1234.5');
    assert.equal(result!.newCursor, 7);
});

test('liveFormatNumeric: small number returns null (no formatting needed)', () => {
    // '999' formatted is still '999', so no change
    assert.equal(liveFormatNumeric('999', 3, ' '), null);
});

test('liveFormatNumeric: large number cursor tracking', () => {
    // User typed '12345678' with cursor after '5' (5 digits in)
    const result = liveFormatNumeric('12345678', 5, ' ');
    assert.notEqual(result, null);
    assert.equal(result!.formatted, '12 345 678');
    // '5' is at index 5 in '12 345 678', cursor should be at 6
    assert.equal(result!.newCursor, 6);
});

test('escapeSqlString escapes single quotes', () => {
    assert.equal(escapeSqlString("O'Reilly"), "O''Reilly");
    assert.equal(escapeSqlString("it's a 'test'"), "it''s a ''test''");
    assert.equal(escapeSqlString('no quotes'), 'no quotes');
});
