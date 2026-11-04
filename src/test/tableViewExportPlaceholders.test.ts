import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const view = require(path.join(__dirname, '../../../src/webview/tableView.js'));
const { hasOpenPlaceholder, filterPlaceholderItems, insertPlaceholder, targetPreviewText } = view;

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const HTML = fs.readFileSync(path.join(SRC, 'webview', 'tableView.html'), 'utf8');
const JS = fs.readFileSync(path.join(SRC, 'webview', 'tableView.js'), 'utf8');
const CSS = fs.readFileSync(path.join(SRC, 'webview', 'tableView.css'), 'utf8');

const ITEMS = [
    { label: '{date}', insertText: '{date}' },
    { label: '{YEAR}', insertText: '{YEAR}' },
    { label: '{YR}', insertText: '{YR}' },
    { label: '{YEAR-1 MON}-{MON-1}', insertText: '{YEAR-1 MON}-{MON-1}' }
];

// ===== hasOpenPlaceholder =====

test('a placeholder is open while a { before the cursor has no } yet', () => {
    assert.equal(hasOpenPlaceholder('out/{', 5), true);
    assert.equal(hasOpenPlaceholder('out/{YE', 7), true);
    assert.equal(hasOpenPlaceholder('out/{YEAR}', 10), false);
    assert.equal(hasOpenPlaceholder('out/{YEAR}_', 11), false);
    assert.equal(hasOpenPlaceholder('{YEAR}_{', 8), true);
    assert.equal(hasOpenPlaceholder('out/{YEAR}', 5), true, 'only the text before the cursor counts');
    assert.equal(hasOpenPlaceholder('', 0), false);
});

// ===== filterPlaceholderItems =====

test('the suggestions are narrowed to what was typed after {, in any case', () => {
    assert.deepEqual(filterPlaceholderItems(ITEMS, '').map((i: any) => i.label), ITEMS.map((i) => i.label), 'the button shows all');
    assert.deepEqual(filterPlaceholderItems(ITEMS, '{').map((i: any) => i.label), ITEMS.map((i) => i.label));
    assert.deepEqual(filterPlaceholderItems(ITEMS, '{y').map((i: any) => i.label), ['{YEAR}', '{YR}', '{YEAR-1 MON}-{MON-1}']);
    assert.deepEqual(filterPlaceholderItems(ITEMS, '{yea').map((i: any) => i.label), ['{YEAR}', '{YEAR-1 MON}-{MON-1}']);
    assert.deepEqual(filterPlaceholderItems(ITEMS, '{x'), []);
    assert.deepEqual(filterPlaceholderItems(undefined, '{'), []);
});

// ===== insertPlaceholder =====

test('the chosen placeholder replaces what was typed of it and the cursor goes behind it', () => {
    assert.deepEqual(insertPlaceholder('out/{YE', 4, 7, '{YEAR}'), { text: 'out/{YEAR}', cursor: 10 });
    assert.deepEqual(insertPlaceholder('out/_x', 4, 4, '{file}'), { text: 'out/{file}_x', cursor: 10 }, 'inserted at the cursor');
    assert.deepEqual(insertPlaceholder('', 0, 0, '{YEAR-1 MON}-{MON-1}'), { text: '{YEAR-1 MON}-{MON-1}', cursor: 20 });
    assert.deepEqual(insertPlaceholder('ab', 5, 9, '{x}'), { text: 'ab{x}', cursor: 5 }, 'positions beyond the text are clamped');
});

// ===== targetPreviewText =====

test('the preview line tells where the file goes, that it is asked for, or what is wrong', () => {
    assert.deepEqual(targetPreviewText({ path: 'C:\\work\\o_2026.csv' }), { tone: '', text: 'If the SQL file ran now, the file would be ', path: 'C:\\work\\o_2026.csv' });
    assert.deepEqual(targetPreviewText({ ask: true }), { tone: '', text: 'No file name: a save dialog asks for the file each time the SQL file runs.', path: '' });
    assert.deepEqual(targetPreviewText({ error: '{YR-x} is no placeholder' }), { tone: 'error', text: '{YR-x} is no placeholder', path: '' });
    assert.deepEqual(targetPreviewText(undefined), { tone: '', text: '', path: '' });
});

// ===== markup and wiring =====

test('both fields of the export dialog have a button that offers the placeholders', () => {
    for (const field of ['exportFilename', 'exportSaveLocation']) {
        const button = new RegExp(`<button type="button" class="btn btn-sm btn-icon placeholder-btn" id="${field}Placeholders" data-placeholder-for="${field}" title="[^"]+" aria-label="[^"]+"><svg class="ico" aria-hidden="true"><use href="#icon-braces"/></svg></button>`);
        assert.match(HTML, button, field);
        assert.match(HTML, new RegExp(`<span class="typeahead-wrapper placeholder-field"><input type="text" id="${field}"[^>]*autocomplete="off"`), field);
    }
    assert.match(HTML, /<div class="export-target-preview" id="exportTargetPreview" aria-live="polite"><\/div>/);
});

test('the placeholder help shows only when the host offers it', () => {
    assert.match(CSS, /\.export-dialog \.placeholder-btn,\s*\.export-dialog \.export-target-preview \{\s*display: none;/);
    assert.match(CSS, /body\.export-file-assist \.export-dialog \.placeholder-btn \{\s*display: inline-flex;/);
    assert.match(JS, /document\.body\.classList\.toggle\('export-file-assist', exportOnly\.fileAssist === true\)/);
});

test('the panel asks the host for suggestions and the preview, and shows their answers', () => {
    assert.match(JS, /command: 'exportPlaceholderSuggest', requestId, text: input\.value, cursor/);
    assert.match(JS, /command: 'exportTargetPreview',/);
    assert.match(JS, /case 'exportPlaceholderSuggestions':\s*showPlaceholders\(msg\);/);
    assert.match(JS, /case 'exportTargetPreviewResult':\s*showTargetPreview\(msg\);/);
    // What the host sends is text, so it goes through the escapes.
    assert.match(JS, /escapeHtml\(item\.label\)/);
    assert.match(JS, /escapeHtml\(item\.example \|\| ''\)/);
    assert.match(JS, /escapeHtml\(item\.detail \|\| ''\)/);
    assert.match(JS, /pathEl\.textContent = view\.path/);
});

test('the list of suggestions is worked with the keyboard and does not close the dialog', () => {
    const start = JS.search(/input\.addEventListener\('keydown', \(e\) => \{\s*const assist = placeholderAssist;/);
    assert.ok(start >= 0, 'the keydown handler of the fields');
    const handler = JS.slice(start, JS.indexOf("input.addEventListener('blur'", start));
    assert.match(handler, /e\.key === 'ArrowDown' \|\| e\.key === 'ArrowUp'/);
    assert.match(handler, /e\.key === 'Enter' \|\| e\.key === 'Tab'[\s\S]*e\.stopPropagation\(\);\s*applyPlaceholder/);
    assert.match(handler, /e\.key === 'Escape'[\s\S]*e\.stopPropagation\(\);\s*closePlaceholders/);
});
