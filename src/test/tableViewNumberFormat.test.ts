import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const { normalizeNumericInput, formatNumberDisplay, formatExactMatchValue, normalizeFilterInputValue } = require(
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
