import './helpers/vscodeMock';
import { vscodeStub } from './helpers/vscodeMock';
import test, { after } from 'node:test';
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
    adds: Array<{ query: Omit<SavedQuery, 'id'>; scope: SavedQueryScope }>;
    saved: string[];
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
        },
        async add(newQuery: Omit<SavedQuery, 'id'>, scope: SavedQueryScope) {
            recorded.adds.push({ query: newQuery, scope });
            const created = { ...newQuery, id: 'new-id', scope } as SavedQuery;
            queries.push(created);
            return created;
        }
    };
    return store as unknown as SavedQueryStore;
}

const originalCreate = vscodeStub.window.createWebviewPanel;
const originalRelative = (vscodeStub.workspace as Record<string, unknown>).asRelativePath;
after(() => {
    vscodeStub.window.createWebviewPanel = originalCreate;
    (vscodeStub.workspace as Record<string, unknown>).asRelativePath = originalRelative;
});

/** Releases the panel a previous test opened; it is a singleton. */
let releasePrevious: (() => void) | undefined;

/** Open the panel against a stubbed webview and capture everything it emits. */
function openPanel(
    t: { after(fn: () => void): void },
    queries: SavedQuery[],
    blockMove = false,
    request?: { id?: string; draft?: { name: string; sql: string } }
): Harness {
    releasePrevious?.();
    const recorded: Recorded = { updates: [], moves: [], deletes: [], adds: [], saved: [] };
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

    vscodeStub.window.createWebviewPanel = () => panel as never;
    (vscodeStub.workspace as Record<string, unknown>).asRelativePath =
        (uri: { fsPath: string }) => uri.fsPath;
    releasePrevious = () => onDispose?.();
    t.after(() => onDispose?.());

    ManageBookmarksPanel.show(
        fakeStore(queries, recorded, blockMove),
        request ? { ...request, onSaved: (id: string) => recorded.saved.push(id) } : undefined
    );
    assert.ok(onMessage, 'the panel of a previous test was still open');

    return {
        html: panel.webview.html,
        posted,
        recorded,
        async send(message: Record<string, unknown>) {
            await onMessage?.(message);
        }
    };
}

function query(id: string, scope: SavedQueryScope, parameters: SavedQueryParameter[] = [], sql = 'SELECT 1'): SavedQuery {
    return { id, name: `Query ${id}`, sql, parameters, scope, schema: 'public', table: 't' };
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

test('the edit dialog holds the statement itself and a way into a real editor', (t) => {
    const panel = openPanel(t, [query('a', 'global')]);

    assert.ok(panel.html.includes('<textarea id="editSql"'), 'the statement cannot be edited in the dialog');
    assert.ok(panel.html.includes('id="editInEditor"'), 'the dialog does not offer an editor tab');
});

test('the raw statement reaches the dialog while the table shows a one-line preview', async (t) => {
    const panel = openPanel(t, [query('a', 'global', [], 'SELECT *\n  FROM t')]);
    await panel.send({ command: 'ready' });

    const loaded = panel.posted.find(m => m.command === 'queriesLoaded');
    const item = (loaded!.queries as Array<Record<string, unknown>>)[0];
    assert.equal(item.sql, 'SELECT *\n  FROM t');
    assert.equal(item.preview, 'SELECT * FROM t');
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

test('an edited statement is stored and its placeholders are reconciled with it', async (t) => {
    const panel = openPanel(t, [query('a', 'global', [{ name: 'since', kind: 'number', label: 'Start' }], 'SELECT * FROM t WHERE d > :since')]);
    await panel.send({
        command: 'updateQuery',
        id: 'a',
        updates: {
            name: 'Open orders',
            scope: 'global',
            sql: '  SELECT * FROM t WHERE d > :since AND c = :code  ',
            parameters: [{ name: 'since', kind: 'number', label: 'Start' }]
        }
    });

    assert.deepEqual(panel.recorded.updates[0].patch, {
        parameters: [
            { name: 'since', kind: 'number', label: 'Start' },
            { name: 'code', kind: 'text' }
        ],
        sql: 'SELECT * FROM t WHERE d > :since AND c = :code',
        name: 'Open orders'
    });
});

test('an unchanged statement leaves the placeholder metadata exactly as it was edited', async (t) => {
    const panel = openPanel(t, [query('a', 'global', [{ name: 'since', kind: 'text' }], 'SELECT :since')]);
    await panel.send({
        command: 'updateQuery',
        id: 'a',
        updates: {
            name: 'Query a',
            scope: 'global',
            sql: 'SELECT :since',
            parameters: [{ name: 'since', kind: 'text', defaultValue: 'today' }]
        }
    });

    assert.deepEqual(panel.recorded.updates[0].patch, {
        parameters: [{ name: 'since', kind: 'text', defaultValue: 'today' }],
        name: 'Query a'
    });
});

test('the editor button hands the query to the command that opens an editor tab', async (t) => {
    const invoked: unknown[][] = [];
    const originalExecute = vscodeStub.commands.executeCommand;
    vscodeStub.commands.executeCommand = (...args: unknown[]) => { invoked.push(args); return Promise.resolve(undefined); };
    t.after(() => { vscodeStub.commands.executeCommand = originalExecute; });

    const panel = openPanel(t, [query('a', 'global')]);
    await panel.send({ command: 'editInEditor', id: 'a' });

    assert.deepEqual(invoked, [['postgresQueryBuilder.editSavedQuerySql', 'a']]);
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

// ===== The same dialog creates a bookmark =====

test('a draft opens the dialog with the placeholders of its statement', async (t) => {
    const panel = openPanel(t, [], false, { draft: { name: 'Orders', sql: 'SELECT * FROM o WHERE d = :day' } });
    await panel.send({ command: 'ready' });

    const commands = panel.posted.map(m => m.command);
    assert.deepEqual(commands, ['queriesLoaded', 'openDialog'], 'the dialog needs the list before it opens');
    const dialog = panel.posted[1] as { mode: string; draft: { name: string; sql: string; parameters: unknown[] } };
    assert.equal(dialog.mode, 'create');
    assert.equal(dialog.draft.name, 'Orders');
    assert.equal(dialog.draft.sql, 'SELECT * FROM o WHERE d = :day');
    assert.deepEqual(dialog.draft.parameters, [{ name: 'day', kind: 'text' }]);
});

test('an existing query opens the same dialog in edit mode', async (t) => {
    const panel = openPanel(t, [query('a', 'global')], false, { id: 'a' });
    await panel.send({ command: 'ready' });

    assert.deepEqual(panel.posted[1], { command: 'openDialog', mode: 'edit', id: 'a' });
});

test('the dialog stores a new query with the scope and the placeholders it was given', async (t) => {
    const panel = openPanel(t, [], false, { draft: { name: 'Orders', sql: 'SELECT :day' } });
    await panel.send({ command: 'ready' });
    await panel.send({
        command: 'createQuery',
        updates: {
            name: '  Orders  ',
            sql: '  SELECT :day  ',
            scope: 'workspace',
            parameters: [{ name: 'day', kind: 'number', label: 'Day' }]
        }
    });

    assert.equal(panel.recorded.adds.length, 1);
    assert.equal(panel.recorded.adds[0].scope, 'workspace');
    assert.equal(panel.recorded.adds[0].query.name, 'Orders');
    assert.equal(panel.recorded.adds[0].query.sql, 'SELECT :day');
    assert.deepEqual(panel.recorded.adds[0].query.parameters, [{ name: 'day', kind: 'number', label: 'Day' }]);
    assert.deepEqual(panel.recorded.saved, ['new-id'], 'the caller was not told which query was stored');
});

test('a new query without a name or a statement is not stored', async (t) => {
    const panel = openPanel(t, [], false, { draft: { name: '', sql: 'SELECT 1' } });
    await panel.send({ command: 'createQuery', updates: { name: '   ', sql: 'SELECT 1' } });
    await panel.send({ command: 'createQuery', updates: { name: 'Orders', sql: '   ' } });

    assert.deepEqual(panel.recorded.adds, []);
    assert.deepEqual(panel.recorded.saved, []);
});

test('editing a query reports its id back to the caller once', async (t) => {
    const panel = openPanel(t, [query('a', 'global')], false, { id: 'a' });
    await panel.send({ command: 'updateQuery', id: 'a', updates: { name: 'A', sql: 'SELECT 1', scope: 'global' } });
    await panel.send({ command: 'updateQuery', id: 'a', updates: { name: 'B', sql: 'SELECT 1', scope: 'global' } });

    assert.deepEqual(panel.recorded.saved, ['a'], 'the callback must not fire for later, unrelated edits');
});
