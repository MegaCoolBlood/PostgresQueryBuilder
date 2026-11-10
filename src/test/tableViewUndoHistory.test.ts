import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

const { cloneEditValue, serializeEditValue, editStatesEqual, applyHistoryEntry, rebaseEditHistory } = require(
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

// ===== 3.5.3: running the query keeps the query and filter steps undoable =====

const noFilters = { values: {}, exact: {}, modes: {} };

test('rebaseEditHistory keeps every query step of the history after a run', () => {
    const history = [
        snapshot({ query: 'SELECT 1', filters: noFilters }),
        snapshot({ query: 'SELECT 12', filters: noFilters }),
        snapshot({ query: 'SELECT 123', filters: noFilters })
    ];
    const current = snapshot({ query: 'SELECT 123', filters: noFilters });
    const r = rebaseEditHistory(history, 2, current, editStatesEqual);
    assert.deepEqual(r.history.map((s: any) => s.query), ['SELECT 1', 'SELECT 12', 'SELECT 123']);
    assert.equal(r.index, 2);
});

test('rebaseEditHistory drops grid edits and merges the steps that only differed in them', () => {
    const history = [
        snapshot({ query: 'SELECT 1' }),
        snapshot({ query: 'SELECT 1', modified: new Map([['0:name', 'x']]) }),
        snapshot({ query: 'SELECT 1', modified: new Map([['0:name', 'x']]), deleted: new Set([3]) }),
        snapshot({ query: 'SELECT 2', modified: new Map([['0:name', 'x']]), deleted: new Set([3]) })
    ];
    const current = snapshot({ query: 'SELECT 2' });
    const r = rebaseEditHistory(history, 3, current, editStatesEqual);
    assert.deepEqual(r.history.map((s: any) => s.query), ['SELECT 1', 'SELECT 2']);
    for (const s of r.history) {
        assert.equal(s.modified.size, 0);
        assert.equal(s.deleted.size, 0);
    }
});

test('rebaseEditHistory keeps the filter row of each step together with its query', () => {
    const filtered = { values: { name: 'abc' }, exact: {}, modes: {} };
    const history = [
        snapshot({ query: 'SELECT * FROM t', filters: noFilters }),
        snapshot({ query: "SELECT * FROM t WHERE name ILIKE '%abc%'", filters: filtered })
    ];
    const r = rebaseEditHistory(history, 1, history[1], editStatesEqual);
    assert.equal(r.history.length, 2);
    assert.deepEqual(r.history[0].filters, noFilters);
    assert.deepEqual(r.history[1].filters, filtered);
    assert.equal(r.index, 1);
});

test('rebaseEditHistory appends the current state when it differs from the last step', () => {
    const history = [snapshot({ query: 'SELECT 1' }), snapshot({ query: 'SELECT 2' })];
    const current = snapshot({ query: 'SELECT 3' });
    const r = rebaseEditHistory(history, 1, current, editStatesEqual);
    assert.deepEqual(r.history.map((s: any) => s.query), ['SELECT 1', 'SELECT 2', 'SELECT 3']);
    assert.equal(r.history[r.index], current);
});

test('rebaseEditHistory drops the redo tail beyond the current step', () => {
    const history = [snapshot({ query: 'SELECT 1' }), snapshot({ query: 'SELECT 2' }), snapshot({ query: 'SELECT 3' })];
    // Undone back to SELECT 1 and run: SELECT 2 and 3 are no longer redoable.
    const r = rebaseEditHistory(history, 0, snapshot({ query: 'SELECT 1' }), editStatesEqual);
    assert.deepEqual(r.history.map((s: any) => s.query), ['SELECT 1']);
    assert.equal(r.index, 0);
});

test('rebaseEditHistory does not share state with the history it was built from', () => {
    const history = [snapshot({ query: 'SELECT 1', filters: { values: { a: 'x' }, exact: {}, modes: {} } })];
    const r = rebaseEditHistory(history, 0, snapshot({ query: 'SELECT 2' }), editStatesEqual);
    r.history[0].filters.values.a = 'changed';
    assert.equal(history[0].filters.values.a, 'x');
});

test('rebaseEditHistory starts from the current state when there is no history', () => {
    const current = snapshot();
    assert.deepEqual(rebaseEditHistory([], 0, current, editStatesEqual), { history: [current], index: 0 });
    assert.deepEqual(rebaseEditHistory(undefined, 0, current, editStatesEqual), { history: [current], index: 0 });
});

test('a fresh result rebases the undo history instead of starting it over', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/webview/tableView.js'), 'utf8');
    const loaded = src.slice(src.indexOf('function handleRowsLoaded('), src.indexOf('function handlePrimaryKeysLoaded('));
    assert.match(loaded, /rebaseEditHistoryOnNewRows\(\)/);
    assert.doesNotMatch(loaded, /resetEditHistory\(\)/, 'a run must not wipe the query steps');
});

test('an undo step holds the filter row and restores it with the query', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/webview/tableView.js'), 'utf8');
    const capture = src.slice(src.indexOf('function captureEditState('), src.indexOf('function restoreEditState('));
    assert.match(capture, /filters: cloneEditValue\(\{ values: filters, exact: exactFilters, modes: filterModes \}\)/);
    const restore = src.slice(src.indexOf('function restoreEditState('), src.indexOf('function resetEditHistory('));
    assert.match(restore, /filters = cloneEditValue\(snap\.filters\.values\)/);
    assert.match(restore, /renderHeader\(\)/);
});
