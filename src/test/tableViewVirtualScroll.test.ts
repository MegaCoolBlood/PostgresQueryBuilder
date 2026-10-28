import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const WEBVIEW = path.join(__dirname, '../../../src/webview');
const {
    buildRenderPlan,
    virtualRowOffset,
    virtualRowAt,
    virtualWindow,
    buildAutoColumnWidthCss
} = require(path.join(WEBVIEW, 'tableView.js'));

const JS = fs.readFileSync(path.join(WEBVIEW, 'tableView.js'), 'utf8');
const CSS = fs.readFileSync(path.join(WEBVIEW, 'tableView.css'), 'utf8');

// ===== the order the rows are shown in =====

test('the plan shows the loaded rows in display order with new rows next to their anchor', () => {
    const inserted = [{ anchor: null }, { anchor: 7 }, { anchor: 99 }];
    const duplicated = [{ anchor: 7 }, { anchor: null }];
    assert.deepEqual(buildRenderPlan([3, 7, 5], inserted, duplicated), [
        { kind: 'insert', idx: 0 },
        { kind: 'dup', idx: 1 },
        { kind: 'row', idx: 3 },
        { kind: 'row', idx: 7 },
        { kind: 'insert', idx: 1 },
        { kind: 'dup', idx: 0 },
        { kind: 'row', idx: 5 },
        // Its anchor row is filtered out, so it goes last instead of getting lost.
        { kind: 'insert', idx: 2 }
    ]);
    assert.deepEqual(buildRenderPlan([], [], []), []);
});

test('the plan of 30 000 rows is built without copying the rows', () => {
    const order = Array.from({ length: 30000 }, (_, i) => 29999 - i);
    const started = Date.now();
    const plan = buildRenderPlan(order, [], []);
    assert.equal(plan.length, 30000);
    assert.deepEqual(plan[0], { kind: 'row', idx: 29999 });
    assert.ok(Date.now() - started < 200, 'building the plan must stay cheap');
});

// ===== where the rows are =====

test('rows of one height are found by their offset and back', () => {
    assert.equal(virtualRowOffset(0, 29, []), 0);
    assert.equal(virtualRowOffset(1000, 29, []), 29000);
    assert.equal(virtualRowAt(0, 29, [], 100), 0);
    assert.equal(virtualRowAt(28.9, 29, [], 100), 0);
    assert.equal(virtualRowAt(29, 29, [], 100), 1);
    assert.equal(virtualRowAt(29 * 55 + 3, 29, [], 100), 55);
    assert.equal(virtualRowAt(1e9, 29, [], 100), 99, 'clamped to the last row');
    assert.equal(virtualRowAt(-50, 29, [], 100), 0);
    assert.equal(virtualRowAt(10, 29, [], 0), 0);
});

test('rows dragged taller move the rows below them down', () => {
    const extras = [{ index: 2, extra: 60 }, { index: 5, extra: 10 }];
    assert.equal(virtualRowOffset(2, 20, extras), 40);
    assert.equal(virtualRowOffset(3, 20, extras), 120, 'row 2 is 80 px high');
    assert.equal(virtualRowOffset(6, 20, extras), 190, 'row 5 is 30 px high');
    assert.equal(virtualRowAt(40, 20, extras, 10), 2);
    assert.equal(virtualRowAt(119, 20, extras, 10), 2, 'still inside the tall row');
    assert.equal(virtualRowAt(120, 20, extras, 10), 3);
    assert.equal(virtualRowAt(185, 20, extras, 10), 5);
    assert.equal(virtualRowAt(190, 20, extras, 10), 6);
    for (let r = 0; r < 10; r++) {
        assert.equal(virtualRowAt(virtualRowOffset(r, 20, extras), 20, extras, 10), r, `round trip of row ${r}`);
    }
});

test('the window holds the rows in view and a buffer on either side', () => {
    assert.deepEqual(
        virtualWindow({ scrollTop: 29 * 1000, viewportHeight: 29 * 20, rowHeight: 29, total: 30000, buffer: 40, extras: [] }),
        { visibleStart: 1000, visibleEnd: 1021, start: 960, end: 1061 }
    );
    assert.deepEqual(
        virtualWindow({ scrollTop: 0, viewportHeight: 600, rowHeight: 29, total: 30000, buffer: 40, extras: [] }),
        { visibleStart: 0, visibleEnd: 21, start: 0, end: 61 }
    );
    assert.deepEqual(
        virtualWindow({ scrollTop: 29 * 29995, viewportHeight: 600, rowHeight: 29, total: 30000, buffer: 40, extras: [] }),
        { visibleStart: 29995, visibleEnd: 30000, start: 29955, end: 30000 }
    );
    assert.deepEqual(virtualWindow({ scrollTop: 0, viewportHeight: 600, rowHeight: 29, total: 0, buffer: 40 }), { start: 0, end: 0, visibleStart: 0, visibleEnd: 0 });
    assert.equal(virtualWindow({ scrollTop: 0, viewportHeight: 600, rowHeight: 0, total: 50, buffer: 0 }).visibleEnd, 26, 'an unknown row height is assumed');
});

// ===== column widths =====

test('columns keep the widest they have been, unless the user set their width', () => {
    assert.equal(
        buildAutoColumnWidthCss({ name: 180.4, city: 64, id: 0 }, { city: 120 }),
        '#dataTable th[data-col="name"], #dataTable td[data-col="name"] { min-width: 180px; }'
    );
    assert.equal(buildAutoColumnWidthCss({}, {}), '');
});

// ===== the grid renders only what is in view =====

test('the grid puts only the rows around the visible ones into the DOM, between two spacers', () => {
    assert.match(JS, /function renderWindow\(force\)/);
    assert.match(JS, /const parts = \[spacerRowHtml\(virtualRowOffset\(win\.start/);
    assert.match(JS, /<tr class="v-spacer" aria-hidden="true"><td colspan="\$\{columns\.length \+ 2\}" style="--v-h:/);
    assert.match(JS, /gridScroller\.addEventListener\('scroll', \(\) => renderWindow\(false\), \{ passive: true \}\)/);
    assert.match(CSS, /#tableBody tr\.v-spacer td \{\s*height: var\(--v-h, 0\);\s*padding: 0;\s*border: 0;/);
    assert.match(CSS, /\.table-wrapper \{[^}]*overflow-anchor: none;/, 'scroll anchoring would fight the replaced rows');
    assert.match(CSS, /\.row-num-cell \{[^}]*min-width: calc\(var\(--row-num-digits, 1\) \* 1ch\);/);
});

test('the cells listen through the tbody instead of carrying listeners of their own', () => {
    assert.equal(JS.includes('wireTableListeners'), false);
    assert.equal(/querySelectorAll\([^)]*\)\.forEach\(\s*\(?\w+\)?\s*=>\s*\{\s*\w+\.addEventListener/.test(JS.slice(JS.indexOf('function renderBody()'), JS.indexOf('function handleCellEdit('))), false);
    for (const event of ['focusin', 'focusout', 'input', 'contextmenu']) {
        assert.ok(JS.includes(`tableBody.addEventListener('${event}'`), `no delegated ${event} listener`);
    }
    // The row selection runs before the row action buttons, as it did on the rows.
    const selection = JS.indexOf("// Row selection: clicking anywhere in an existing row marks it as");
    const actions = JS.indexOf('const ROW_ACTIONS = {');
    assert.ok(selection > 0 && actions > selection);
});

test('no code reads a row by its place among the rows of the tbody any more', () => {
    assert.equal(/sectionRowIndex/.test(JS), false);
    const rowsAccess = JS.match(/tableBody\.rows\b/g) || [];
    assert.equal(rowsAccess.length, 2, 'only rowElementAt and measureRenderedRows walk the tbody rows');
});

test('cell text is escaped without a DOM round trip per cell', () => {
    const escape = JS.slice(JS.indexOf('    function escapeHtml(text) {'), JS.indexOf('    function escapeAttr(text) {'));
    assert.equal(escape.includes('createElement'), false);
    assert.match(escape, /replace\(\/\[&<>\]\/g/);
});
