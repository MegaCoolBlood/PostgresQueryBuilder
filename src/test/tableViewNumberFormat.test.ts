import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const { normalizeNumericInput, formatNumberDisplay, formatExactMatchValue, normalizeFilterInputValue, escapeSqlString } = require(
    path.join(__dirname, '../../src/webview/tableView.js')
);

test('normalizeNumericInput strips thousand separators and converts decimal comma', () => {
    assert.equal(normalizeNumericInput('1 234,50', ' '), '1234.50');
    assert.equal(normalizeNumericInput('-9 999 999,99', ' '), '-9999999.99');
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

test('escapeSqlString escapes single quotes', () => {
    assert.equal(escapeSqlString("O'Reilly"), "O''Reilly");
    assert.equal(escapeSqlString("it's a 'test'"), "it''s a ''test''");
    assert.equal(escapeSqlString('no quotes'), 'no quotes');
});
