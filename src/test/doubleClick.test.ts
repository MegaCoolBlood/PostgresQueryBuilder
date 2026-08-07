import test from 'node:test';
import assert from 'node:assert/strict';
import { DoubleClickGate, DOUBLE_CLICK_MS } from '../doubleClick';

test('a single click does not open anything', () => {
    const gate = new DoubleClickGate();
    assert.equal(gate.accept('public.orders', 1000), false);
});

test('a second click on the same item within the window is a double click', () => {
    const gate = new DoubleClickGate();
    gate.accept('public.orders', 1000);
    assert.equal(gate.accept('public.orders', 1000 + DOUBLE_CLICK_MS - 1), true);
});

test('a second click after the window starts over instead of opening', () => {
    const gate = new DoubleClickGate();
    gate.accept('public.orders', 1000);
    assert.equal(gate.accept('public.orders', 1000 + DOUBLE_CLICK_MS), false);
    assert.equal(gate.accept('public.orders', 1000 + DOUBLE_CLICK_MS + 10), true);
});

test('clicking two different items in quick succession opens neither', () => {
    const gate = new DoubleClickGate();
    assert.equal(gate.accept('public.orders', 1000), false);
    assert.equal(gate.accept('public.customers', 1050), false);
});

test('a third click does not count as another double click', () => {
    const gate = new DoubleClickGate();
    gate.accept('q1', 1000);
    assert.equal(gate.accept('q1', 1100), true);
    assert.equal(gate.accept('q1', 1200), false);
    assert.equal(gate.accept('q1', 1300), true);
});

test('each gate tracks its own view', () => {
    const tables = new DoubleClickGate();
    const bookmarks = new DoubleClickGate();
    tables.accept('public.orders', 1000);
    assert.equal(bookmarks.accept('public.orders', 1100), false);
    assert.equal(tables.accept('public.orders', 1200), true);
});
