import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TableExplorerProvider } from '../tableExplorer';

function createProvider(): any {
    // The provider only needs a connection manager reference for construction;
    // the filter/highlight helpers under test do not touch it.
    return new TableExplorerProvider({} as any);
}

// ===== 0.2.1: multi-term search scoring =====

test('scoreString returns 0 when no filter is set', () => {
    const p = createProvider();
    assert.equal(p.scoreString('public.users'), 0);
});

test('scoreString counts a single matching term', () => {
    const p = createProvider();
    p.setFilter('user');
    assert.equal(p.scoreString('public.users'), 1);
    assert.equal(p.scoreString('public.orders'), 0);
});

test('scoreString counts each space-separated term independently', () => {
    const p = createProvider();
    p.setFilter('pub user');
    assert.equal(p.scoreString('public.users'), 2);
    assert.equal(p.scoreString('public.orders'), 1); // only "pub" matches
});

test('scoreString is case-insensitive', () => {
    const p = createProvider();
    p.setFilter('USER');
    assert.equal(p.scoreString('public.Users'), 1);
});

test('setFilter ignores extra whitespace between terms', () => {
    const p = createProvider();
    p.setFilter('  pub    user  ');
    assert.equal(p.scoreString('public.users'), 2);
});

// ===== 0.2.1: highlight ranges =====

test('computeHighlights returns [] with no filter', () => {
    const p = createProvider();
    assert.deepEqual(p.computeHighlights('users'), []);
});

test('computeHighlights marks a single term occurrence', () => {
    const p = createProvider();
    p.setFilter('user');
    assert.deepEqual(p.computeHighlights('users'), [[0, 4]]);
});

test('computeHighlights marks every occurrence of a term', () => {
    const p = createProvider();
    p.setFilter('a');
    assert.deepEqual(p.computeHighlights('banana'), [[1, 2], [3, 4], [5, 6]]);
});

test('computeHighlights merges adjacent ranges from different terms', () => {
    const p = createProvider();
    p.setFilter('ab cd');
    // "ab" -> [1,3], "cd" -> [3,5] : adjacent ranges collapse into one
    assert.deepEqual(p.computeHighlights('xabcdy'), [[1, 5]]);
});

test('computeHighlights merges overlapping ranges from different terms', () => {
    const p = createProvider();
    p.setFilter('ana nan');
    // "ana" -> [1,4], "nan" -> [2,5] : overlap merges into [1,5]
    assert.deepEqual(p.computeHighlights('banana'), [[1, 5]]);
});

test('computeHighlights returns [] when terms do not match', () => {
    const p = createProvider();
    p.setFilter('xyz');
    assert.deepEqual(p.computeHighlights('public.users'), []);
});
