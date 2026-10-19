import { vscodeStub } from './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTagSelection, editSavedQueryTags, summarizeTagSelection } from '../savedQueryTags';
import { SavedQuery, SavedQueryStore, normalizeTags } from '../savedQueryStore';

function q(id: string, tags?: string[]): SavedQuery {
    return { id, name: id.toUpperCase(), sql: 'SELECT 1', parameters: [], tags };
}

// ===== summarizeTagSelection =====

test('summarizeTagSelection ticks the tags every selected query carries', () => {
    const all = [q('a', ['Sales', 'Daily']), q('b', ['Sales']), q('c', ['Ops'])];
    assert.deepEqual(summarizeTagSelection(all, [all[0], all[1]]), {
        offered: ['Daily', 'Ops', 'Sales'],
        onAll: ['Sales'],
        partial: [{ tag: 'Daily', count: 1 }]
    });
});

test('summarizeTagSelection of a single query ticks exactly its tags', () => {
    const all = [q('a', ['Sales']), q('b', ['Ops'])];
    const summary = summarizeTagSelection(all, [all[0]]);
    assert.deepEqual(summary.onAll, ['Sales']);
    assert.deepEqual(summary.partial, []);
});

// ===== applyTagSelection =====

test('applyTagSelection adds picked tags and removes unticked common tags', () => {
    const all = [q('a', ['Sales', 'Daily']), q('b', ['Sales'])];
    const summary = summarizeTagSelection(all, all);
    assert.deepEqual(applyTagSelection(['Sales', 'Daily'], summary, ['New']), ['Daily', 'New']);
    assert.deepEqual(applyTagSelection(['Sales'], summary, ['New']), ['New']);
});

test('applyTagSelection keeps a partial tag unless it is picked', () => {
    const all = [q('a', ['Sales', 'Daily']), q('b', ['Sales'])];
    const summary = summarizeTagSelection(all, all);
    assert.deepEqual(applyTagSelection(['Sales'], summary, ['Sales']), ['Sales'], 'Daily stays off b');
    assert.deepEqual(applyTagSelection(['Sales'], summary, ['Sales', 'Daily']), ['Daily', 'Sales'], 'picking Daily adds it to b');
});

// ===== editSavedQueryTags (picker flow) =====

/** A scriptable stand-in for vscode.QuickPick. */
function fakeQuickPick() {
    const handlers: Record<string, (arg?: any) => void> = {};
    const on = (name: string) => (cb: (arg?: any) => void) => { handlers[name] = cb; return { dispose() {} }; };
    let selectedItems: any[] = [];
    const pick: any = {
        items: [] as any[],
        value: '',
        canSelectMany: false,
        get selectedItems() { return selectedItems; },
        set selectedItems(v: any[]) { selectedItems = v; handlers.selection?.(v); },
        onDidChangeValue: on('value'),
        onDidChangeSelection: on('selection'),
        onDidAccept: on('accept'),
        onDidHide: on('hide'),
        show() {},
        hide() { handlers.hide?.(); },
        dispose() {},
        // Test helpers; check sets every ticked item, as VS Code's selectedItems does
        type(text: string) { pick.value = text; handlers.value?.(text); },
        check(...labels: string[]) { pick.selectedItems = pick.items.filter((i: any) => labels.includes(i.label)); },
        accept() { handlers.accept?.(); }
    };
    return pick;
}

function fakeStore(queries: SavedQuery[]) {
    const updates: Array<[string, string[]]> = [];
    const store = {
        getAll: () => queries,
        get: (id: string) => queries.find(x => x.id === id),
        update: async (id: string, patch: { tags: string[] }) => {
            updates.push([id, patch.tags]);
            const target = queries.find(x => x.id === id);
            if (target) target.tags = normalizeTags(patch.tags);
        }
    } as unknown as SavedQueryStore;
    return { store, updates };
}

async function runPicker(queries: SavedQuery[], ids: string[], script: (pick: any) => void) {
    const pick = fakeQuickPick();
    const original = vscodeStub.window.createQuickPick;
    vscodeStub.window.createQuickPick = () => pick;
    try {
        const { store, updates } = fakeStore(queries);
        const run = editSavedQueryTags(store, ids);
        script(pick);
        const accepted = await run;
        return { pick, updates, accepted };
    } finally {
        vscodeStub.window.createQuickPick = original;
    }
}

test('the tag picker lists the existing tags with the query\'s own ones ticked', async () => {
    const { pick } = await runPicker([q('a', ['Sales']), q('b', ['Ops'])], ['a'], p => p.hide());
    assert.deepEqual(pick.items.map((i: any) => i.label), ['Ops', 'Sales']);
    assert.deepEqual(pick.selectedItems.map((i: any) => i.label), ['Sales']);
    assert.equal(pick.canSelectMany, true);
});

test('ticking and unticking tags in the picker updates the query', async () => {
    const { updates, accepted } = await runPicker([q('a', ['Sales']), q('b', ['Ops'])], ['a'], p => {
        p.check('Ops');
        p.accept();
    });
    assert.equal(accepted, true);
    assert.deepEqual(updates, [['a', ['Ops']]]);
});

test('a name typed in the picker becomes a new tag, even without ticking it', async () => {
    const { updates } = await runPicker([q('a', ['Sales'])], ['a'], p => {
        p.type('Reports / Monthly');
        assert.equal(p.items[0].label, 'Reports/Monthly', 'offered first as a new tag');
        assert.equal(p.items[0].description, 'new tag');
        p.accept();
    });
    assert.deepEqual(updates, [['a', ['Reports/Monthly', 'Sales']]]);
});

test('a tag ticked before filtering stays ticked after the filter changes', async () => {
    const { updates } = await runPicker([q('a'), q('b', ['Ops', 'Sales'])], ['a'], p => {
        p.check('Ops');
        p.type('New');
        p.check('Ops', 'New');
        p.accept();
    });
    assert.deepEqual(updates, [['a', ['New', 'Ops']]]);
});

test('cancelling the picker changes nothing', async () => {
    const { updates, accepted } = await runPicker([q('a', ['Sales'])], ['a'], p => {
        p.check();
        p.hide();
    });
    assert.equal(accepted, false);
    assert.deepEqual(updates, []);
});

test('the picker edits several queries, keeping a tag only some of them carry', async () => {
    const queries = [q('a', ['Sales', 'Daily']), q('b', ['Sales'])];
    const { pick, updates } = await runPicker(queries, ['a', 'b'], p => {
        p.check('Daily');
        p.accept();
    });
    assert.equal(pick.items.find((i: any) => i.label === 'Daily').description, 'on 1 of 2');
    assert.deepEqual(updates, [['a', ['Daily']], ['b', ['Daily']]], 'Sales unticked on both, Daily added to b');
});
