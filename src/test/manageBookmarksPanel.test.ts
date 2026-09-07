import './helpers/vscodeMock';
import { vscodeStub } from './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ManageBookmarksPanel, toParameters } from '../manageBookmarksPanel';
import { SavedQuery, SavedQueryParameter, SavedQueryScope, SavedQueryStore } from '../savedQueryStore';

// ===== Reading the edit dialog back =====

test('toParameters keeps the description and the default value of a placeholder', () => {
    assert.deepEqual(
        toParameters([{ name: 'since', kind: 'text', label: '  Start date  ', defaultValue: '2024-01-01' }]),
        [{ name: 'since', kind: 'text', label: 'Start date', defaultValue: '2024-01-01' }]
    );
});

test('toParameters drops an empty description and an empty default value', () => {
    assert.deepEqual(
        toParameters([{ name: 'id', kind: 'number', label: '   ', defaultValue: '' }]),
        [{ name: 'id', kind: 'number' }]
    );
});

test('toParameters falls back to a text placeholder when the kind is unknown', () => {
    assert.deepEqual(toParameters([{ name: 'x', kind: 'sql-injection' }]), [{ name: 'x', kind: 'text' }]);
});

test('toParameters ignores rows without a name and anything that is not a list', () => {
    assert.deepEqual(toParameters([{ name: '  ' }, { kind: 'text' }, null]), []);
    assert.deepEqual(toParameters(undefined), []);
    assert.deepEqual(toParameters('nope'), []);
});

// ===== The panel talking to the store =====

interface Recorded {
    updates: Array<{ id: string; patch: Partial<Omit<SavedQuery, 'id'>> }>;
    moves: Array<{ id: string; scope: SavedQueryScope }>;
    deletes: string[];
}

interface Harness {
    html: string;
    posted: Array<Record<string, unknown>>;
    recorded: Recorded;
    send(message: Record<string, unknown>): Promise<void>;
}

function fakeStore(queries: SavedQuery[], recorded: Recorded, blockMove: boolean): SavedQueryStore {
    const store = {
        onDidChange: (_listener: () => void) => ({ dispose() {} }),
        getAll: () => queries,
        get: (id: string) => queries.find(q => q.id === id),
        getWorkspaceFileUri: () => ({ fsPath: '/repo/.vscode/queries.json' }),
        hasWorkspaceFile: () => true,
        async update(id: string, patch: Partial<Omit<SavedQuery, 'id'>>) {
            recorded.updates.push({ id, patch });
        },
        async move(id: string, scope: SavedQueryScope) {
            recorded.moves.push({ id, scope });
            const q = queries.find(item => item.id === id);
            if (!q || q.scope === scope || blockMove) {
                return false;
            }
            q.scope = scope;
            return true;
        },
        async delete(id: string) {
            recorded.deletes.push(id);
        }
    };
    return store as unknown as SavedQueryStore;
}

/** Open the panel against a stubbed webview and capture everything it emits. */
function openPanel(t: { after(fn: () => void): void }, queries: SavedQuery[], blockMove = false): Harness {
    const recorded: Recorded = { updates: [], moves: [], deletes: [] };
    const posted: Array<Record<string, unknown>> = [];
    let onMessage: ((msg: Record<string, unknown>) => void | Promise<void>) | undefined;
    let onDispose: (() => void) | undefined;
    const panel = {
        webview: {
            html: '',
            cspSource: 'vscode-webview:',
            postMessage: (msg: Record<string, unknown>) => { posted.push(msg); return Promise.resolve(true); },
            onDidReceiveMessage: (listener: typeof onMessage) => { onMessage = listener; return { dispose() {} }; }
        },
        onDidDispose: (listener: () => void) => { onDispose = listener; return { dispose() {} }; },
        reveal: () => { /* not used */ },
        dispose: () => { /* not used */ }
    };

    const originalCreate = vscodeStub.window.createWebviewPanel;
    const originalRelative = (vscodeStub.workspace as Record<string, unknown>).asRelativePath;
    vscodeStub.window.createWebviewPanel = () => panel as never;
    (vscodeStub.workspace as Record<string, unknown>).asRelativePath =
        (uri: { fsPath: string }) => uri.fsPath;
    t.after(() => {
        onDispose?.();
        vscodeStub.window.createWebviewPanel = originalCreate;
        (vscodeStub.workspace as Record<string, unknown>).asRelativePath = originalRelative;
    });

    ManageBookmarksPanel.show(fakeStore(queries, recorded, blockMove));

    return {
        html: panel.webview.html,
        posted,
        recorded,
        async send(message: Record<string, unknown>) {
            await onMessage?.(message);
        }
    };
}

function query(id: string, scope: SavedQueryScope, parameters: SavedQueryParameter[] = []): SavedQuery {
    return { id, name: `Query ${id}`, sql: 'SELECT 1', parameters, scope, schema: 'public', table: 't' };
}

test('the panel offers a scope, a description and a default value for every placeholder', (t) => {
    const panel = openPanel(t, [query('a', 'global', [{ name: 'since', kind: 'text' }])]);

    for (const marker of ['id="editShare"', 'class="p-label"', 'class="p-default"', 'class="p-kind"']) {
        assert.ok(panel.html.includes(marker), `the edit dialog is missing ${marker}`);
    }
    assert.ok(panel.html.includes('Share with workspace'), 'the dialog does not say where the query is stored');
    assert.ok(panel.html.includes('>Description<'), 'the dialog does not label the description');
    assert.ok(panel.html.includes('>Default value<'), 'the dialog does not label the default value');
});

test('the panel hands the queries to the webview once it is ready', async (t) => {
    const panel = openPanel(t, [query('a', 'workspace', [{ name: 'since', kind: 'text', label: 'Start' }])]);
    await panel.send({ command: 'ready' });

    const loaded = panel.posted.find(m => m.command === 'queriesLoaded');
    assert.ok(loaded, 'the webview never received the queries');
    assert.equal(loaded.filePath, '/repo/.vscode/queries.json');
    assert.deepEqual((loaded.queries as Array<Record<string, unknown>>)[0].parameters, [
        { name: 'since', kind: 'text', label: 'Start' }
    ]);
});

test('saving the dialog stores the placeholder metadata and the new scope', async (t) => {
    const panel = openPanel(t, [query('a', 'global', [{ name: 'since', kind: 'text' }])]);
    await panel.send({
        command: 'updateQuery',
        id: 'a',
        updates: {
            name: '  Open orders  ',
            scope: 'workspace',
            parameters: [{ name: 'since', kind: 'number', label: 'Start date', defaultValue: '7' }]
        }
    });

    assert.deepEqual(panel.recorded.updates, [{
        id: 'a',
        patch: {
            parameters: [{ name: 'since', kind: 'number', label: 'Start date', defaultValue: '7' }],
            name: 'Open orders'
        }
    }]);
    assert.deepEqual(panel.recorded.moves, [{ id: 'a', scope: 'workspace' }]);
});

test('saving the dialog without a scope change leaves the query where it is', async (t) => {
    const panel = openPanel(t, [query('a', 'workspace')]);
    await panel.send({ command: 'updateQuery', id: 'a', updates: { name: 'Open orders', scope: 'workspace', parameters: [] } });

    assert.deepEqual(panel.recorded.moves, [], 'the query was moved although its scope did not change');
});

test('the bulk actions move and delete every selected query', async (t) => {
    const panel = openPanel(t, [query('a', 'global'), query('b', 'global')]);
    await panel.send({ command: 'setScope', ids: ['a', 'b'], scope: 'workspace' });
    await panel.send({ command: 'delete', ids: ['a'] });

    assert.deepEqual(panel.recorded.moves, [{ id: 'a', scope: 'workspace' }, { id: 'b', scope: 'workspace' }]);
    assert.deepEqual(panel.recorded.deletes, ['a']);
});

test('the panel reports a query that could not be shared instead of failing silently', async (t) => {
    const warnings: string[] = [];
    const originalWarn = vscodeStub.window.showWarningMessage;
    vscodeStub.window.showWarningMessage = (msg: string) => { warnings.push(msg); return Promise.resolve(undefined); };
    t.after(() => { vscodeStub.window.showWarningMessage = originalWarn; });

    // A store that refuses the move leaves the query personal.
    const panel = openPanel(t, [query('a', 'global')], true);
    await panel.send({ command: 'setScope', ids: ['a'], scope: 'workspace' });

    assert.equal(warnings.length, 1, 'the blocked move was not reported');
    assert.match(warnings[0], /no workspace folder is open/);
});
