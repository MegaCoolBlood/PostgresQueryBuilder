import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const {
    refreshIdentityColumns,
    rowIdentityKey,
    remapRowIndex,
    remapSelection,
    scrollTopKeepingOffset
} = require(path.join(__dirname, '../../../src/webview/tableView.js'));

const keysOf = (rows: object[], keyColumns: string[]) => rows.map(r => rowIdentityKey(r, keyColumns));

// ===== refreshIdentityColumns / rowIdentityKey =====

test('refreshIdentityColumns prefers the identity columns of the result tables', () => {
    const tables = [{ identityColumns: [{ name: 'id' }] }, { identityColumns: [{ name: 'other_id' }] }];
    assert.deepEqual(refreshIdentityColumns(['pk'], tables, { id: 1, other_id: 2, pk: 3 }), ['id', 'other_id']);
});

test('refreshIdentityColumns falls back to the primary key, then to the whole row', () => {
    assert.deepEqual(refreshIdentityColumns(['id'], [], { id: 1, name: 'a' }), ['id']);
    assert.deepEqual(refreshIdentityColumns(['id'], [], { name: 'a' }), []);
    assert.deepEqual(refreshIdentityColumns([], [{ identityColumns: [] }], { name: 'a' }), []);
});

test('rowIdentityKey by primary key ignores changed values, by row it does not', () => {
    const before = { id: 1, name: 'a' };
    const after = { id: 1, name: 'b' };
    assert.equal(rowIdentityKey(before, ['id']), rowIdentityKey(after, ['id']));
    assert.notEqual(rowIdentityKey(before, []), rowIdentityKey(after, []));
});

// ===== remapRowIndex =====

test('remapRowIndex follows a row that moved to another line', () => {
    const keys = keysOf([{ id: 3 }, { id: 1 }, { id: 2 }], ['id']);
    assert.equal(remapRowIndex(rowIdentityKey({ id: 1 }, ['id']), keys, 0), 1);
});

test('remapRowIndex yields -1 for a row that is gone', () => {
    const keys = keysOf([{ id: 3 }, { id: 2 }], ['id']);
    assert.equal(remapRowIndex(rowIdentityKey({ id: 1 }, ['id']), keys, 0), -1);
});

test('remapRowIndex picks the duplicate nearest to the old position', () => {
    const rows = [{ v: 'x' }, { v: 'y' }, { v: 'x' }, { v: 'y' }, { v: 'x' }];
    const keys = keysOf(rows, []);
    const key = rowIdentityKey({ v: 'x' }, []);
    assert.equal(remapRowIndex(key, keys, 3), 2);
    assert.equal(remapRowIndex(key, keys, 5), 4);
    assert.equal(remapRowIndex(key, keys, 0), 0);
});

// ===== remapSelection =====

test('remapSelection moves the selected row and both corners of the cell selection', () => {
    const k = (id: number) => rowIdentityKey({ id }, ['id']);
    const snapshot = {
        selected: { key: k(2), index: 1 },
        anchor: { key: k(2), index: 1, c: 0 },
        focus: { key: k(3), index: 2, c: 4 }
    };
    const result = remapSelection(snapshot, keysOf([{ id: 3 }, { id: 9 }, { id: 1 }, { id: 2 }], ['id']));
    assert.deepEqual(result, { selectedRowIdx: 3, anchor: { index: 3, c: 0 }, focus: { index: 0, c: 4 } });
});

test('remapSelection selects nothing when the selected row is gone', () => {
    const k = (id: number) => rowIdentityKey({ id }, ['id']);
    const result = remapSelection({ selected: { key: k(2), index: 1 } }, keysOf([{ id: 1 }, { id: 3 }], ['id']));
    assert.deepEqual(result, { selectedRowIdx: null, anchor: null, focus: null });
});

test('remapSelection drops the whole cell selection when one corner row is gone', () => {
    const k = (id: number) => rowIdentityKey({ id }, ['id']);
    const snapshot = {
        selected: { key: k(1), index: 0 },
        anchor: { key: k(1), index: 0, c: 0 },
        focus: { key: k(2), index: 1, c: 3 }
    };
    const result = remapSelection(snapshot, keysOf([{ id: 1 }, { id: 3 }], ['id']));
    assert.deepEqual(result, { selectedRowIdx: 0, anchor: null, focus: null });
});

test('remapSelection keeps a whole-row selection spanning all columns', () => {
    const k = (id: number) => rowIdentityKey({ id }, ['id']);
    const snapshot = {
        selected: null,
        anchor: { key: k(5), index: 4, c: 0 },
        focus: { key: k(5), index: 4, c: 6 }
    };
    const result = remapSelection(snapshot, keysOf([{ id: 5 }, { id: 4 }], ['id']));
    assert.deepEqual(result, { selectedRowIdx: null, anchor: { index: 0, c: 0 }, focus: { index: 0, c: 6 } });
});

// ===== scrollTopKeepingOffset =====

test('scrollTopKeepingOffset keeps the row at the same distance from the top of the view', () => {
    // The row was 75 px below the top of the view and now starts at 500 px.
    assert.equal(scrollTopKeepingOffset(500, 75, 10000), 425);
});

test('scrollTopKeepingOffset stays within the scrollable range', () => {
    assert.equal(scrollTopKeepingOffset(25, 200, 10000), 0);
    assert.equal(scrollTopKeepingOffset(5000, 0, 1200), 1200);
    assert.equal(scrollTopKeepingOffset(300, 50, -10), 0);
});
