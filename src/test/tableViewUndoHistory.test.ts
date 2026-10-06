import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const { cloneEditValue, serializeEditValue, editStatesEqual, applyHistoryEntry } = require(
    path.join(__dirname, '../../../src/webview/tableView.js')
);

// ===== 3.2.2: unified undo/redo for grid edits and the query text =====

test('cloneEditValue deep-copies a Map independently of the source', () => {
    const src = new Map([['0:name', 'Alice']]);
    const copy = cloneEditValue(src);
    assert.deepEqual([...copy], [['0:name', 'Alice']]);
    copy.set('0:name', 'Bob');
    assert.equal(src.get('0:name'), 'Alice');
});

test('cloneEditValue deep-copies a Set independently of the source', () => {
    const src = new Set([1, 2]);
    const copy = cloneEditValue(src);
    copy.add(3);
    assert.deepEqual([...src], [1, 2]);
});

test('cloneEditValue clones nested arrays of objects that hold a Set (duplicated rows)', () => {
    const src = [{ row: { id: 1 }, anchor: 0, defaults: new Set(['id']) }];
    const copy = cloneEditValue(src);
    copy[0].row.id = 99;
    copy[0].defaults.add('name');
    assert.equal(src[0].row.id, 1);
    assert.deepEqual([...src[0].defaults], ['id']);
});

test('cloneEditValue returns primitives unchanged', () => {
    assert.equal(cloneEditValue('x'), 'x');
    assert.equal(cloneEditValue(5), 5);
    assert.equal(cloneEditValue(null), null);
});

test('serializeEditValue is order-independent for Maps and Sets', () => {
    const a = new Map([['a', 1], ['b', 2]]);
    const b = new Map([['b', 2], ['a', 1]]);
    assert.equal(serializeEditValue(a), serializeEditValue(b));
    assert.equal(serializeEditValue(new Set([1, 2, 3])), serializeEditValue(new Set([3, 1, 2])));
});

test('serializeEditValue is order-sensitive for arrays (row order matters)', () => {
    assert.notEqual(serializeEditValue([{ id: 1 }, { id: 2 }]), serializeEditValue([{ id: 2 }, { id: 1 }]));
});

function snapshot(overrides: any = {}) {
    return {
        modified: new Map(),
        deleted: new Set(),
        inserted: [],
        duplicated: [],
        invalid: new Map(),
        query: 'SELECT 1',
        ...overrides
    };
}

test('editStatesEqual treats snapshots with reordered Map/Set entries as equal', () => {
    const a = snapshot({ modified: new Map([['0:a', 'x'], ['1:b', 'y']]), deleted: new Set([2, 5]) });
    const b = snapshot({ modified: new Map([['1:b', 'y'], ['0:a', 'x']]), deleted: new Set([5, 2]) });
    assert.equal(editStatesEqual(a, b), true);
});

test('editStatesEqual distinguishes a changed cell, query, or added row', () => {
    const base = snapshot({ modified: new Map([['0:a', 'x']]) });
    assert.equal(editStatesEqual(base, snapshot({ modified: new Map([['0:a', 'z']]) })), false);
    assert.equal(editStatesEqual(base, snapshot({ modified: new Map([['0:a', 'x']]), query: 'SELECT 2' })), false);
    assert.equal(
        editStatesEqual(base, snapshot({ modified: new Map([['0:a', 'x']]), inserted: [{ row: {} }] })),
        false
    );
});

const eq = (a: unknown, b: unknown) => a === b;

test('applyHistoryEntry appends a new state and advances the index', () => {
    const r = applyHistoryEntry(['a'], 0, 'b', eq, false);
    assert.deepEqual(r.history, ['a', 'b']);
    assert.equal(r.index, 1);
});

test('applyHistoryEntry is a no-op when the state equals the current top', () => {
    const r = applyHistoryEntry(['a', 'b'], 1, 'b', eq, false);
    assert.deepEqual(r.history, ['a', 'b']);
    assert.equal(r.index, 1);
});

test('applyHistoryEntry drops the redo tail when pushing after an undo', () => {
    // History a,b,c with the pointer moved back to a: a new change forks here.
    const r = applyHistoryEntry(['a', 'b', 'c'], 0, 'x', eq, false);
    assert.deepEqual(r.history, ['a', 'x']);
    assert.equal(r.index, 1);
});

test('applyHistoryEntry coalesces by replacing the current top', () => {
    const r = applyHistoryEntry(['a', 'b'], 1, 'b2', eq, true);
    assert.deepEqual(r.history, ['a', 'b2']);
    assert.equal(r.index, 1);
});

test('applyHistoryEntry coalescing back to the previous state drops the top', () => {
    const r = applyHistoryEntry(['a', 'b'], 1, 'a', eq, true);
    assert.deepEqual(r.history, ['a']);
    assert.equal(r.index, 0);
});

test('applyHistoryEntry falls back to a push when there is nothing to coalesce', () => {
    const r = applyHistoryEntry(['a'], 0, 'b', eq, true);
    assert.deepEqual(r.history, ['a', 'b']);
    assert.equal(r.index, 1);
});

// A realistic walk of the user's scenario: grid and query edits interleave on
// one stack and undo pops them in exact reverse order.
test('a mixed grid/query sequence undoes in reverse order on one stack', () => {
    let history = ['s0'];
    let index = 0;
    const push = (state: string, coalesce = false) => {
        const r = applyHistoryEntry(history, index, state, eq, coalesce);
        history = r.history;
        index = r.index;
    };
    ['cellA1', 'selectEdit', 'deleteB5', 'fillC', 'addColumn', 'deleteD', 'addWhere']
        .forEach(s => push(s));
    assert.equal(history[index], 'addWhere');
    const undone: string[] = [];
    while (index > 0) { index--; undone.push(history[index]); }
    assert.deepEqual(undone, ['deleteD', 'addColumn', 'fillC', 'deleteB5', 'selectEdit', 'cellA1', 's0']);
});
