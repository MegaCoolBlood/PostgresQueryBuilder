import { vscodeStub } from './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SavedQueryDragController,
    SavedQueryDropProvider,
    SAVED_QUERY_DRAG_MIME,
    planTagDrop,
    parseDraggedIds
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

test('handleDrag ignores folder nodes', () => {
    const transfer = createDataTransfer();
    new SavedQueryDragController().handleDrag(
        [{ type: 'tag', path: 'Reports' }, { type: 'untagged' }, queryNode('a')], transfer, NO_TOKEN
    );
    assert.deepEqual(JSON.parse(transfer.get(SAVED_QUERY_DRAG_MIME).value), ['a']);
});

test('handleDrag transfers nothing when no query is dragged', () => {
    const transfer = createDataTransfer();
    new SavedQueryDragController().handleDrag([{ type: 'tag', path: 'Reports' }], transfer, NO_TOKEN);
    assert.equal(transfer.get(SAVED_QUERY_DRAG_MIME), undefined);
});

// ===== dropping onto a tag folder (3.3.0) =====

test('planTagDrop adds the tag of the folder a query is dropped on', () => {
    assert.deepEqual(planTagDrop({ type: 'tag', path: 'Reports/Monthly' }), { action: 'add', tag: 'Reports/Monthly' });
});

test('planTagDrop treats a drop onto a query like a drop onto its folder', () => {
    assert.deepEqual(planTagDrop({ type: 'query', query: makeQuery('a', 'SELECT 1'), parent: 'Sales' }), { action: 'add', tag: 'Sales' });
    assert.deepEqual(planTagDrop({ type: 'query', query: makeQuery('a', 'SELECT 1'), parent: '' }), { action: 'clear' });
});

test('planTagDrop clears the tags on "Untagged" and does nothing elsewhere', () => {
    assert.deepEqual(planTagDrop({ type: 'untagged' }), { action: 'clear' });
    assert.equal(planTagDrop(undefined), undefined);
    assert.equal(planTagDrop({ type: 'query', query: makeQuery('a', 'SELECT 1') }), undefined);
});

test('parseDraggedIds reads the transferred ids and ignores garbage', () => {
    assert.deepEqual(parseDraggedIds('["a","b"]'), ['a', 'b']);
    assert.deepEqual(parseDraggedIds('not json'), []);
    assert.deepEqual(parseDraggedIds('{"a":1}'), []);
});

function createTagStore(queries: SavedQuery[]) {
    const calls: any[] = [];
    const store = {
        get: (id: string) => queries.find(q => q.id === id),
        addTag: async (ids: string[], tag: string) => { calls.push(['add', ids, tag]); },
        removeTag: async (ids: string[], tag?: string) => { calls.push(['remove', ids, tag]); }
    } as unknown as SavedQueryStore;
    return { store, calls };
}

function transferOf(ids: string[]) {
    const transfer = createDataTransfer();
    transfer.set(SAVED_QUERY_DRAG_MIME, { asString: () => Promise.resolve(JSON.stringify(ids)) });
    return transfer;
}

test('dropping queries onto a tag folder tags them', async () => {
    const { store, calls } = createTagStore([makeQuery('a', 'SELECT 1'), makeQuery('b', 'SELECT 2')]);
    await new SavedQueryDragController(store).handleDrop({ type: 'tag', path: 'Sales' }, transferOf(['a', 'b']), NO_TOKEN);
    assert.deepEqual(calls, [['add', ['a', 'b'], 'Sales']]);
});

test('dropping onto "Untagged" removes the tags only after confirmation', async () => {
    const tagged = { ...makeQuery('a', 'SELECT 1'), tags: ['Sales'] };
    const original = vscodeStub.window.showWarningMessage;
    try {
        let answer: string | undefined = undefined;
        vscodeStub.window.showWarningMessage = () => Promise.resolve(answer as any);
        const first = createTagStore([tagged]);
        await new SavedQueryDragController(first.store).handleDrop({ type: 'untagged' }, transferOf(['a']), NO_TOKEN);
        assert.deepEqual(first.calls, [], 'cancelled: nothing removed');

        answer = 'Remove Tags';
        const second = createTagStore([tagged, makeQuery('b', 'SELECT 2')]);
        await new SavedQueryDragController(second.store).handleDrop({ type: 'untagged' }, transferOf(['a', 'b']), NO_TOKEN);
        assert.deepEqual(second.calls, [['remove', ['a'], undefined]], 'only the tagged query is touched');
    } finally {
        vscodeStub.window.showWarningMessage = original;
    }
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
