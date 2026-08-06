import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SavedQueryDragController,
    SavedQueryDropProvider,
    SAVED_QUERY_DRAG_MIME
} from '../savedQueryDrop';
import { SavedQuery, SavedQueryStore } from '../savedQueryStore';
import { SavedQueryTreeNode } from '../savedQueryExplorer';

function makeQuery(id: string, sql: string): SavedQuery {
    return { id, name: id, sql, parameters: [] };
}

/** Stand-in for vscode.DataTransfer (the stub only provides the item class). */
function createDataTransfer() {
    const items = new Map<string, any>();
    return {
        set: (mime: string, item: any) => { items.set(mime, item); },
        get: (mime: string) => items.get(mime)
    } as any;
}

function queryNode(id: string): SavedQueryTreeNode {
    return { type: 'query', query: makeQuery(id, 'SELECT ' + id) };
}

function createProvider(queries: SavedQuery[]) {
    const store = { get: (id: string) => queries.find(q => q.id === id) } as unknown as SavedQueryStore;
    return new SavedQueryDropProvider(store);
}

const NO_TOKEN: any = { isCancellationRequested: false };

// ===== drag =====

test('handleDrag transfers the ids of the dragged queries', () => {
    const transfer = createDataTransfer();
    new SavedQueryDragController().handleDrag([queryNode('a'), queryNode('b')], transfer, NO_TOKEN);
    assert.deepEqual(JSON.parse(transfer.get(SAVED_QUERY_DRAG_MIME).value), ['a', 'b']);
});

test('handleDrag ignores group nodes', () => {
    const transfer = createDataTransfer();
    new SavedQueryDragController().handleDrag(
        [{ type: 'group', scope: 'global' }, queryNode('a')], transfer, NO_TOKEN
    );
    assert.deepEqual(JSON.parse(transfer.get(SAVED_QUERY_DRAG_MIME).value), ['a']);
});

test('handleDrag transfers nothing when no query is dragged', () => {
    const transfer = createDataTransfer();
    new SavedQueryDragController().handleDrag([{ type: 'group', scope: 'global' }], transfer, NO_TOKEN);
    assert.equal(transfer.get(SAVED_QUERY_DRAG_MIME), undefined);
});

// ===== drop =====

async function drop(provider: SavedQueryDropProvider, payload: string | undefined) {
    const transfer = createDataTransfer();
    if (payload !== undefined) {
        transfer.set(SAVED_QUERY_DRAG_MIME, { asString: () => Promise.resolve(payload) });
    }
    return provider.provideDocumentDropEdits({} as any, {} as any, transfer, NO_TOKEN);
}

test('dropping a query inserts its SQL', async () => {
    const provider = createProvider([makeQuery('a', 'SELECT 1')]);
    const edit = await drop(provider, JSON.stringify(['a']));
    assert.equal(edit?.insertText, 'SELECT 1');
});

test('dropping several queries separates them by a blank line', async () => {
    const provider = createProvider([makeQuery('a', 'SELECT 1'), makeQuery('b', '  SELECT 2  ')]);
    const edit = await drop(provider, JSON.stringify(['a', 'b']));
    assert.equal(edit?.insertText, 'SELECT 1\n\nSELECT 2');
});

test('dropping keeps the placeholders as stored', async () => {
    const provider = createProvider([makeQuery('a', 'SELECT * FROM t WHERE d = :day')]);
    const edit = await drop(provider, JSON.stringify(['a']));
    assert.equal(edit?.insertText, 'SELECT * FROM t WHERE d = :day');
});

test('a drop without the saved-query payload is ignored', async () => {
    const provider = createProvider([makeQuery('a', 'SELECT 1')]);
    assert.equal(await drop(provider, undefined), undefined);
});

test('a malformed payload is ignored', async () => {
    const provider = createProvider([makeQuery('a', 'SELECT 1')]);
    assert.equal(await drop(provider, 'not json'), undefined);
    assert.equal(await drop(provider, JSON.stringify([])), undefined);
});

test('unknown ids produce no edit', async () => {
    const provider = createProvider([makeQuery('a', 'SELECT 1')]);
    assert.equal(await drop(provider, JSON.stringify(['gone'])), undefined);
});

test('a query whose SQL is blank is skipped', async () => {
    const provider = createProvider([makeQuery('a', '   '), makeQuery('b', 'SELECT 2')]);
    const edit = await drop(provider, JSON.stringify(['a', 'b']));
    assert.equal(edit?.insertText, 'SELECT 2');
});
