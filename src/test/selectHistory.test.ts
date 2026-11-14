import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    DEFAULT_SELECT_HISTORY_SIZE,
    SELECT_HISTORY_DRAG_MIME,
    SELECT_HISTORY_KEY,
    SelectHistoryDragController,
    SelectHistoryDropProvider,
    SelectHistoryProvider,
    SelectHistorySearchView,
    SelectHistoryStore,
    droppedSelectText,
    durationText,
    filterSelectHistory,
    finishSelect,
    lastRunText,
    normalizeHistorySql,
    recordSelect,
    searchHighlights,
    searchScore,
    searchTerms,
    selectHistoryLabel,
    selectHistoryLimit,
    settleInterruptedRuns,
    type SelectHistoryEntry
} from '../selectHistory';

const ROOT = path.join(__dirname, '..', '..', '..');
const NOW = new Date(2026, 10, 14, 15, 50).getTime();

/** A Memento kept in memory. */
function memento(initial: Record<string, unknown> = {}) {
    const values: Record<string, unknown> = { ...initial };
    return {
        values,
        get: <T>(key: string, fallback?: T) => (key in values ? values[key] as T : fallback as T),
        update: (key: string, value: unknown) => { values[key] = value; return Promise.resolve(); },
        keys: () => Object.keys(values)
    } as any;
}

const entry = (sql: string, extra: Partial<SelectHistoryEntry> = {}): SelectHistoryEntry => ({ sql, lastRun: NOW, runs: 1, ...extra });

// ===== pure helpers =====

test('selectHistoryLimit keeps the setting within its bounds and falls back to 500', () => {
    assert.equal(DEFAULT_SELECT_HISTORY_SIZE, 500);
    assert.equal(selectHistoryLimit(1000), 1000);
    assert.equal(selectHistoryLimit(3), 10);
    assert.equal(selectHistoryLimit(1e9), 10000);
    for (const value of [undefined, null, 'many', NaN]) assert.equal(selectHistoryLimit(value), 500);
});

test('recordSelect puts a new query on top and moves one that ran before there, counting its runs', () => {
    let history = recordSelect([], { sql: '  SELECT * FROM orders  ', source: 'View Data: orders', connection: 'prod' }, 1, 10);
    history = recordSelect(history, { sql: 'SELECT 1' }, 2, 10);
    history = recordSelect(history, { sql: 'SELECT * FROM orders;', source: 'payroll.sql', connection: 'test' }, 3, 10);

    assert.deepEqual(history, [
        { sql: 'SELECT * FROM orders', lastRun: 3, runs: 2, status: 'running', source: 'payroll.sql', connection: 'test' },
        { sql: 'SELECT 1', lastRun: 2, runs: 1, status: 'running' }
    ]);
});

test('finishSelect ends only the run that started at that time, with how long it took and why', () => {
    const history = [entry('SELECT * FROM orders', { lastRun: 5, status: 'running' }), entry('SELECT 1', { lastRun: 4, status: 'running' })];
    const failed = finishSelect(history, { sql: 'SELECT * FROM orders;', startedAt: 5, status: 'failed', durationMs: 420.4, detail: 'relation "orders" does not exist' });
    assert.deepEqual(failed[0], { sql: 'SELECT * FROM orders', lastRun: 5, runs: 1, status: 'failed', durationMs: 420, detail: 'relation "orders" does not exist' });
    assert.equal(failed[1].status, 'running');

    assert.deepEqual(finishSelect(failed, { sql: 'SELECT * FROM orders', startedAt: 1, status: 'done' }), failed,
        'an earlier run that ends late does not overwrite the later one');
    const done = finishSelect(failed, { sql: 'SELECT * FROM orders', startedAt: 5, status: 'done', durationMs: 7 });
    assert.equal(done[0].detail, undefined, 'a success forgets the old error');
});

test('a run still running when VS Code was closed counts as cancelled', () => {
    const settled = settleInterruptedRuns([entry('SELECT 1', { status: 'running' }), entry('SELECT 2', { status: 'done' }), entry('SELECT 3')]);
    assert.deepEqual(settled.map((e) => e.status), ['cancelled', 'done', undefined]);
    assert.equal(settled[0].detail, 'VS Code was closed while the query ran.');
});

test('recordSelect drops the oldest queries beyond the limit and ignores an empty one', () => {
    const history = [3, 2, 1].map((n) => entry(`SELECT ${n}`));
    assert.deepEqual(recordSelect(history, { sql: 'SELECT 4' }, NOW, 3).map((e) => e.sql), ['SELECT 4', 'SELECT 3', 'SELECT 2']);
    assert.deepEqual(recordSelect(history, { sql: '  ;  ' }, NOW, 3), history);
    assert.equal(normalizeHistorySql('SELECT 1 ;;\n'), 'SELECT 1');
});

test('the search finds every query with one of its words, as the Tables view does, the most hits first', () => {
    const history = [
        entry('SELECT count(*) FROM orders', { source: 'View Data: orders', connection: 'test' }),
        entry('SELECT * FROM payroll.lohn WHERE done', { source: 'payroll.sql', connection: 'prod' }),
        entry('SELECT * FROM payroll.lohn JOIN orders o ON o.id = 1', { source: 'payroll.sql', connection: 'prod' })
    ];
    assert.deepEqual(filterSelectHistory(history, 'LOHN ord').map((e) => e.sql), [
        'SELECT * FROM payroll.lohn JOIN orders o ON o.id = 1',
        'SELECT count(*) FROM orders',
        'SELECT * FROM payroll.lohn WHERE done'
    ], 'both words first, then newest first among one word');
    assert.deepEqual(filterSelectHistory(history, 'pay.lo'), [], 'a part of a word, not a pattern');
    assert.deepEqual(filterSelectHistory(history, 'payroll.l').length, 2);
    assert.deepEqual(filterSelectHistory(history, 'test').map((e) => e.source), ['View Data: orders'], 'the connection counts');
    assert.equal(filterSelectHistory(history, '   ').length, 3);
    assert.equal(searchScore(history[2], searchTerms('lohn orders xyz')), 2);
});

test('searchHighlights marks every hit of the search words in a label, merged where they overlap', () => {
    assert.deepEqual(searchHighlights('SELECT * FROM orders o', ['or', 'ders']), [[14, 20]]);
    assert.deepEqual(searchHighlights('SELECT * FROM orders', ['select', 'from']), [[0, 6], [9, 13]]);
    assert.deepEqual(searchHighlights('SELECT 1', []), []);
});

test('selectHistoryLabel shows the query on one line, shortened', () => {
    assert.equal(selectHistoryLabel('SELECT a,\n       b\nFROM t'), 'SELECT a, b FROM t');
    const long = selectHistoryLabel(`SELECT ${'x, '.repeat(100)}y FROM t`, 20);
    assert.equal(long.length, 20);
    assert.ok(long.endsWith('…'));
});

test('lastRunText gives the time for today and the date before', () => {
    assert.equal(lastRunText(new Date(2026, 10, 14, 9, 5).getTime(), NOW), '09:05');
    assert.equal(lastRunText(new Date(2026, 10, 12, 18, 30).getTime(), NOW), '2026-11-12 18:30');
});

test('droppedSelectText closes every statement with one semicolon', () => {
    assert.equal(droppedSelectText(['SELECT 1', 'SELECT 2;', '  ']), 'SELECT 1;\n\nSELECT 2;');
});

// ===== store =====

test('the store records, removes and clears queries and tells each change', async () => {
    const state = memento();
    const store = new SelectHistoryStore(state, () => 2);
    let changes = 0;
    store.onDidChange(() => { changes++; });

    await store.record('SELECT 1', 'View Data: SELECT 1', 'prod');
    await store.record('SELECT 2');
    await store.record('SELECT 3');
    assert.deepEqual(store.getAll().map((e) => e.sql), ['SELECT 3', 'SELECT 2'], 'kept within the limit');
    assert.equal(state.values[SELECT_HISTORY_KEY].length, 2, 'kept for the user');

    await store.remove(['SELECT 3;']);
    assert.deepEqual(store.getAll().map((e) => e.sql), ['SELECT 2']);
    await store.remove(['SELECT 9']);
    await store.clear();
    assert.deepEqual(store.getAll(), []);
    assert.equal(changes, 5, 'removing what is not there changes nothing');
});

test('the end of a run is applied after its start, even when both are asked for at once', async () => {
    const store = new SelectHistoryStore(memento());
    const started = store.record('SELECT 1', undefined, undefined, 100);
    const ended = store.finish('SELECT 1', 100, 'done', 12);
    await Promise.all([started, ended]);
    assert.deepEqual(store.getAll(), [{ sql: 'SELECT 1', lastRun: 100, runs: 1, status: 'done', durationMs: 12 }]);

    await store.record('SELECT 2', undefined, undefined, 200);
    await store.settleInterrupted();
    assert.deepEqual(store.getAll().map((e) => e.status), ['cancelled', 'done']);
});

test('trim drops the oldest queries once the limit was lowered', async () => {
    let limit = 5;
    const store = new SelectHistoryStore(memento({ [SELECT_HISTORY_KEY]: [5, 4, 3, 2, 1].map((n) => entry(`SELECT ${n}`)) }), () => limit);
    await store.trim();
    assert.equal(store.getAll().length, 5);
    limit = 2;
    await store.trim();
    assert.deepEqual(store.getAll().map((e) => e.sql), ['SELECT 5', 'SELECT 4']);
});

// ===== view =====

test('the view lists the queries newest first, narrowed down by the search', async () => {
    const store = new SelectHistoryStore(memento());
    const provider = new SelectHistoryProvider(store, () => NOW);
    let refreshed = 0;
    provider.onDidChangeTreeData(() => { refreshed++; });
    await store.record('SELECT * FROM orders');
    await store.record('SELECT * FROM lohn');

    assert.deepEqual(provider.getChildren().map((e) => e.sql), ['SELECT * FROM lohn', 'SELECT * FROM orders']);
    assert.equal(provider.searchMessage(), undefined);
    provider.setSearch(' orders ');
    provider.setSearch('orders');
    assert.deepEqual(provider.getChildren().map((e) => e.sql), ['SELECT * FROM orders']);
    assert.equal(provider.searchMessage(), '1 of 2 queries match "orders"');
    assert.deepEqual(provider.getChildren(provider.getChildren()[0]), []);
    assert.equal(refreshed, 3, 'the same search again does not refresh');

    const item: any = provider.getTreeItem(provider.getChildren()[0]);
    assert.deepEqual(item.label, { label: 'SELECT * FROM orders', highlights: [[14, 20]] });
});

test('an entry shows its query, when it ran, how often and how its last run ended, and runs on its command', () => {
    const provider = new SelectHistoryProvider(new SelectHistoryStore(memento()), () => NOW);
    const shown = entry('SELECT *\nFROM orders', {
        lastRun: new Date(2026, 10, 14, 9, 5).getTime(), runs: 3, source: 'payroll.sql', connection: 'prod',
        status: 'failed', durationMs: 420, detail: 'relation "orders" does not exist'
    });
    const item: any = provider.getTreeItem(shown);

    assert.equal(item.label, 'SELECT * FROM orders');
    assert.equal(item.description, '09:05 · 3× · Failed');
    assert.deepEqual([item.iconPath.id, item.iconPath.color.id], ['error', 'errorForeground']);
    assert.equal(item.contextValue, 'selectHistoryEntry');
    assert.match(item.tooltip.value, /^Last run 09:05, 3 runs in payroll\.sql on prod\n\n\*\*Failed after 420 ms: relation "orders" does not exist\*\*\n\n```sql\nSELECT \*\nFROM orders\n```/);
    assert.deepEqual(item.command, { command: 'postgresQueryBuilder.openSelectHistoryEntry', title: 'Run in the Data Viewer', arguments: [shown] });
});

test('each way a run ends has an icon of its own and is said in words where it needs attention', () => {
    const provider = new SelectHistoryProvider(new SelectHistoryStore(memento()), () => NOW);
    const look = (status?: any) => {
        const item: any = provider.getTreeItem(entry('SELECT 1', { status }));
        return [item.iconPath.id, item.iconPath.color?.id, item.description];
    };
    assert.deepEqual(look('done'), ['pass', 'testing.iconPassed', '15:50']);
    assert.deepEqual(look('failed'), ['error', 'errorForeground', '15:50 · Failed']);
    assert.deepEqual(look('cancelled'), ['circle-slash', 'editorWarning.foreground', '15:50 · Cancelled']);
    assert.deepEqual(look('running'), ['loading~spin', undefined, '15:50 · Running']);
    assert.deepEqual(look(undefined), ['history', undefined, '15:50'], 'an entry from before the status was kept');
    assert.equal(durationText(65_000), '1 min 05 s');
    assert.equal(durationText(3210), '3.2 s');
});

test('the search field filters the history while typing and shows the search it is filtered by', () => {
    const provider = new SelectHistoryProvider(new SelectHistoryStore(memento()), () => NOW);
    const posted: any[] = [];
    let receive: (message: any) => void = () => undefined;
    const webviewView: any = {
        webview: {
            options: {}, html: '', cspSource: 'vscode-resource:',
            postMessage: (m: any) => { posted.push(m); return Promise.resolve(true); },
            onDidReceiveMessage: (listener: (m: any) => void) => { receive = listener; return { dispose() {} }; }
        }
    };
    new SelectHistorySearchView(provider).resolveWebviewView(webviewView, {} as any, {} as any);

    receive({ type: 'filter', value: 'orders lohn' });
    assert.equal(provider.searchText, 'orders lohn');
    receive({ type: 'ready' });
    assert.deepEqual(posted, [{ type: 'value', value: 'orders lohn' }]);
    assert.match(webviewView.webview.html, /<input type="text" id="searchInput" placeholder="Filter queries\.\.\. \(several terms\)"/);
    assert.match(webviewView.webview.html, /setTimeout\(\(\) => vscode\.postMessage\(\{ type: 'filter', value: input\.value \}\), 200\)/, 'like the table search');
});

// ===== drag and drop =====

function dataTransfer() {
    const items = new Map<string, any>();
    return { get: (mime: string) => items.get(mime), set: (mime: string, item: any) => { items.set(mime, item); } } as any;
}

test('entries dragged into an editor insert their queries, each closed by a semicolon', async () => {
    const transfer = dataTransfer();
    new SelectHistoryDragController().handleDrag([entry('SELECT 1'), entry('SELECT 2')], transfer, {} as any);
    const edit: any = await new SelectHistoryDropProvider().provideDocumentDropEdits({} as any, {} as any, transfer, {} as any);
    assert.equal(edit.insertText, 'SELECT 1;\n\nSELECT 2;');

    const empty = dataTransfer();
    new SelectHistoryDragController().handleDrag([], empty, {} as any);
    assert.equal(empty.get(SELECT_HISTORY_DRAG_MIME), undefined);
    assert.equal(await new SelectHistoryDropProvider().provideDocumentDropEdits({} as any, {} as any, empty, {} as any), undefined);
    const broken = dataTransfer();
    broken.set(SELECT_HISTORY_DRAG_MIME, { asString: async () => 'not json' });
    assert.equal(await new SelectHistoryDropProvider().provideDocumentDropEdits({} as any, {} as any, broken, {} as any), undefined);
});

// ===== contribution =====

test('the Select History is a view with a search field above it, run, copy and delete and a setting for its size', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const contributes = pkg.contributes;
    const views = contributes.views.postgresQueryBuilderExplorer.map((v: any) => v.id);
    assert.equal(views.indexOf('postgresSelectHistorySearch') + 1, views.indexOf('postgresSelectHistory'), 'the search field sits right above the history');
    assert.equal(contributes.views.postgresQueryBuilderExplorer.find((v: any) => v.id === 'postgresSelectHistorySearch').type, 'webview');
    const title = contributes.menus['view/title'].filter((m: any) => /postgresSelectHistory/.test(m.when)).map((m: any) => m.command);
    assert.deepEqual(title, ['postgresQueryBuilder.clearSelectHistory']);
    const context = contributes.menus['view/item/context'].filter((m: any) => /postgresSelectHistory/.test(m.when));
    assert.deepEqual(context.map((m: any) => [m.command, m.group]), [
        ['postgresQueryBuilder.runSelectHistoryEntry', 'inline'],
        ['postgresQueryBuilder.runSelectHistoryEntry', '1_run@1'],
        ['postgresQueryBuilder.copySelectHistoryEntry', '2_edit@1'],
        ['postgresQueryBuilder.deleteSelectHistoryEntry', '3_delete@1']
    ]);
    const setting = contributes.configuration.flatMap((c: any) => Object.entries(c.properties)).find(([key]: [string]) => key === 'postgresQueryBuilder.selectHistory.maxEntries')?.[1];
    assert.deepEqual([setting.default, setting.minimum, setting.maximum], [500, 10, 10000]);
});
