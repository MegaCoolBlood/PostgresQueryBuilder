import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WEBVIEW = path.join(__dirname, '../../../src/webview');
const { lineSelectionCorners, fullySelectedLines, selectAllCorners } = require(path.join(WEBVIEW, 'tableView.js'));

// ===== 3.3.0: select whole rows (row number) and whole columns (header strip) =====

test('lineSelectionCorners: a row number selects every column of that row', () => {
    assert.deepEqual(lineSelectionCorners('rows', 2, 2, 10, 4), {
        anchor: { r: 2, c: 0 },
        focus: { r: 2, c: 3 }
    });
});

test('lineSelectionCorners: dragging over row numbers spans the rows in either direction', () => {
    assert.deepEqual(lineSelectionCorners('rows', 1, 4, 10, 3), {
        anchor: { r: 1, c: 0 },
        focus: { r: 4, c: 2 }
    });
    assert.deepEqual(lineSelectionCorners('rows', 4, 1, 10, 3), {
        anchor: { r: 4, c: 0 },
        focus: { r: 1, c: 2 }
    });
});

test('lineSelectionCorners: a header strip selects every row of that column', () => {
    assert.deepEqual(lineSelectionCorners('cols', 1, 1, 5, 4), {
        anchor: { r: 0, c: 1 },
        focus: { r: 4, c: 1 }
    });
});

test('lineSelectionCorners: dragging over header strips spans the columns', () => {
    assert.deepEqual(lineSelectionCorners('cols', 3, 0, 5, 4), {
        anchor: { r: 0, c: 3 },
        focus: { r: 4, c: 0 }
    });
});

test('lineSelectionCorners clamps indexes to the grid', () => {
    assert.deepEqual(lineSelectionCorners('rows', -2, 99, 3, 2), {
        anchor: { r: 0, c: 0 },
        focus: { r: 2, c: 1 }
    });
    assert.deepEqual(lineSelectionCorners('cols', 7, -1, 3, 2), {
        anchor: { r: 0, c: 1 },
        focus: { r: 2, c: 0 }
    });
});

test('lineSelectionCorners returns null for an empty grid or an unknown kind', () => {
    assert.equal(lineSelectionCorners('rows', 0, 0, 0, 3), null);
    assert.equal(lineSelectionCorners('cols', 0, 0, 3, 0), null);
    assert.equal(lineSelectionCorners('cells', 0, 0, 3, 3), null);
});

test('fullySelectedLines marks the rows of a full-width selection', () => {
    assert.deepEqual(fullySelectedLines({ minR: 1, maxR: 3, minC: 0, maxC: 4 }, 10, 5), {
        rows: { min: 1, max: 3 },
        cols: null
    });
});

test('fullySelectedLines marks the columns of a full-height selection', () => {
    assert.deepEqual(fullySelectedLines({ minR: 0, maxR: 9, minC: 2, maxC: 3 }, 10, 5), {
        rows: null,
        cols: { min: 2, max: 3 }
    });
});

test('fullySelectedLines marks nothing for a partial block', () => {
    assert.deepEqual(fullySelectedLines({ minR: 1, maxR: 2, minC: 1, maxC: 2 }, 10, 5), {
        rows: null,
        cols: null
    });
});

test('fullySelectedLines marks rows and columns when the whole grid is selected', () => {
    assert.deepEqual(fullySelectedLines({ minR: 0, maxR: 2, minC: 0, maxC: 1 }, 3, 2), {
        rows: { min: 0, max: 2 },
        cols: { min: 0, max: 1 }
    });
});

test('fullySelectedLines handles a missing selection and an empty grid', () => {
    assert.deepEqual(fullySelectedLines(null, 3, 2), { rows: null, cols: null });
    assert.deepEqual(fullySelectedLines({ minR: 0, maxR: 0, minC: 0, maxC: 0 }, 0, 0), { rows: null, cols: null });
});

test('every column header carries the column-select strip and the click on it does not sort', () => {
    const js = fs.readFileSync(path.join(WEBVIEW, 'tableView.js'), 'utf8');
    assert.match(js, /<div class="col-select-strip" title="[^"]+"><\/div>\$\{escapeHtml\(col\.name\)\}/);
    assert.match(js, /closest\('\.col-select-strip'\)\) return;\s*sortState = nextSortState/);
});

test('the column-select strip and the selected-line markers are styled', () => {
    const css = fs.readFileSync(path.join(WEBVIEW, 'tableView.css'), 'utf8');
    assert.match(css, /\.col-select-strip\s*\{/);
    assert.match(css, /thead th\.col-selected\s*\{/);
    assert.match(css, /td\.row-num-cell\.row-num-selected\s*\{/);
});

// ===== 3.5.3: Ctrl+A selects every cell =====

test('selectAllCorners spans every row and column of the grid', () => {
    assert.deepEqual(selectAllCorners(120, 7, false, false), {
        anchor: { r: 0, c: 0 },
        focus: { r: 119, c: 6 }
    });
    assert.deepEqual(selectAllCorners(1, 1, false, false), { anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 } });
});

test('selectAllCorners marks every row number and column header as selected', () => {
    const { anchor, focus } = selectAllCorners(4, 3, false, false);
    assert.deepEqual(fullySelectedLines({ minR: anchor.r, maxR: focus.r, minC: anchor.c, maxC: focus.c }, 4, 3), {
        rows: { min: 0, max: 3 },
        cols: { min: 0, max: 2 }
    });
});

test('selectAllCorners leaves Ctrl+A to a field, a cell being edited, the code editor or an open dialog', () => {
    assert.equal(selectAllCorners(10, 3, true, false), null, 'selects the text of the focused field');
    assert.equal(selectAllCorners(10, 3, false, true), null, 'a dialog or menu is open');
});

test('selectAllCorners selects nothing in an empty grid', () => {
    assert.equal(selectAllCorners(0, 3, false, false), null);
    assert.equal(selectAllCorners(5, 0, false, false), null);
});

test('Ctrl+A is wired to select every cell and keeps its own meaning otherwise', () => {
    const js = fs.readFileSync(path.join(WEBVIEW, 'tableView.js'), 'utf8');
    assert.match(js, /\(e\.ctrlKey \|\| e\.metaKey\) && !e\.altKey && !e\.shiftKey && \(e\.key === 'a' \|\| e\.key === 'A'\)\) \{\s*if \(selectAllCells\(\)\) \{\s*e\.preventDefault\(\);/);
    const fn = js.slice(js.indexOf('function selectAllCells('), js.indexOf('function dataColumnCount('));
    assert.match(fn, /isTextEntryElement\(document\.activeElement\)/);
    assert.match(fn, /\.sql-dialog-overlay, \.dlg-overlay/);
    assert.match(fn, /selectAllCorners\(renderPlan\.length, columns\.length/);
});
