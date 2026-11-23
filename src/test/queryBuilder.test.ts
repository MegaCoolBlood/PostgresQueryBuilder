import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { vscodeStub } from './helpers/vscodeMock';
import {
    MODEL_INTENTS,
    ModelHistory,
    PANEL_COMMANDS,
    QbIntentError,
    QueryBuilderManager,
    type QueryBuilderPanel,
    bindExpression,
    buildQueryBuilderHtml,
    builderTitle,
    carryOverPositions,
    formatPreviewValue,
    indentContinuationLines,
    lineIndentAt,
    locateApplyRange,
    offsetToLineColumn,
    relationsFromNodes,
    runPreviewQuery,
    selectSourceFromText,
    type PreviewClient,
    type QueryBuilderServices,
    type QueryBuilderTarget
} from '../queryBuilder';
import { addTable, createEmptyModel, generateSql, toggleColumn, type QueryModel } from '../queryBuilderModel';
import type { CatalogRow } from '../queryBuilderCatalog';
import type { CustomColumnMapping } from '../columnMappingManager';

const ROOT = path.join(__dirname, '..', '..', '..');
const WEBVIEW_JS = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'queryBuilder.js'), 'utf8');
const EDITOR_JS = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'queryEditor.js'), 'utf8');
const HOST_TS = fs.readFileSync(path.join(ROOT, 'src', 'queryBuilder.ts'), 'utf8');

/** orders o JOIN customers c, with o.id ticked. */
function ordersAndCustomers(): QueryModel {
    let m = addTable(createEmptyModel(), { schema: 'public', name: 'orders', alias: 'o', x: 10, y: 20 }).model;
    m = addTable(m, { schema: 'public', name: 'customers', alias: 'c' }).model;
    return toggleColumn(m, 't1', 'id');
}

function intent(model: QueryModel, command: string, msg: Record<string, unknown>): QueryModel {
    return MODEL_INTENTS[command](model, { command, ...msg });
}

// ===== ModelHistory =====

test('ModelHistory records one undo step per change and drops the redo branch on a new change', () => {
    const empty = createEmptyModel();
    const history = new ModelHistory(empty);
    const one = { ...empty, distinct: true };
    assert.equal(history.commit(one), true);
    assert.equal(history.commit({ ...one }), false, 'a change that changes nothing is no step');
    assert.equal(history.undo(), true);
    assert.equal(history.current, empty);
    assert.equal(history.canRedo, true);
    assert.equal(history.redo(), true);
    assert.equal(history.current, one);
    history.undo();
    history.commit({ ...empty, limit: '5' });
    assert.equal(history.canRedo, false);
    assert.equal(history.redo(), false);
});

test('ModelHistory keeps at most its limit of undo steps; replace adds none', () => {
    const history = new ModelHistory(createEmptyModel(), 2);
    for (const limit of ['1', '2', '3']) history.commit({ ...createEmptyModel(), limit });
    history.replace({ ...createEmptyModel(), limit: '4' });
    assert.equal(history.undo(), true);
    assert.equal(history.current.limit, '2');
    assert.equal(history.undo(), true);
    assert.equal(history.undo(), false);
});

// ===== MODEL_INTENTS =====

test('toggleColumn and setAllColumns tick the columns of a table', () => {
    let m = ordersAndCustomers();
    m = intent(m, 'toggleColumn', { tableId: 't2', column: 'name', output: true });
    assert.match(generateSql(m), /c\.name/);
    m = intent(m, 'setAllColumns', { tableId: 't1', columns: ['id', 'total'], output: true });
    assert.deepEqual(m.columns.filter((c) => c.tableId === 't1').map((c) => c.column), ['id', 'total']);
    m = intent(m, 'setAllColumns', { tableId: 't1', columns: ['id', 'total'], output: false });
    assert.equal(m.columns.some((c) => c.tableId === 't1'), false);
});

test('an intent for a table, column or join that no longer exists is refused with a message', () => {
    const m = ordersAndCustomers();
    assert.throws(() => intent(m, 'removeTable', { tableId: 'nope' }), QbIntentError);
    assert.throws(() => intent(m, 'removeColumn', { columnId: 'nope' }), QbIntentError);
    assert.throws(() => intent(m, 'removeJoin', { joinId: 'nope' }), QbIntentError);
    assert.throws(() => intent(m, 'connectColumns', { leftTableId: 't1', leftColumn: 'id', rightTableId: 't1', rightColumn: 'id' }), /two different tables/);
});

test('editTable renames the alias everywhere but refuses one another table already has', () => {
    const m = ordersAndCustomers();
    const renamed = intent(m, 'editTable', { tableId: 't1', alias: 'ord' });
    assert.match(generateSql(renamed), /ord\.id/);
    assert.throws(() => intent(m, 'editTable', { tableId: 't1', alias: 'C' }), /already uses the alias/);
});

test('editTable changes the SQL of a derived table but never empties it', () => {
    const m = addTable(createEmptyModel(), { kind: 'subquery', sql: 'SELECT 1 AS a', alias: 's' }).model;
    const edited = intent(m, 'editTable', { tableId: 't1', alias: 's', sql: ' SELECT 2 AS a ' });
    assert.equal(edited.tables[0].sql, 'SELECT 2 AS a');
    assert.throws(() => intent(m, 'editTable', { tableId: 't1', sql: '  ' }), /cannot be empty/);
    assert.throws(() => intent(m, 'editTable', { tableId: 't1', alias: '' }), /needs an alias/);
});

test('connectColumns and updateJoin build an outer join with its condition', () => {
    let m = ordersAndCustomers();
    m = intent(m, 'connectColumns', { leftTableId: 't1', leftColumn: 'customer_id', rightTableId: 't2', rightColumn: 'id' });
    const joinId = m.joins[0].id;
    m = intent(m, 'updateJoin', { joinId, type: 'left', pairs: [{ leftColumn: 'customer_id', rightColumn: 'id', operator: '=' }, { leftColumn: '', rightColumn: 'x' }], condition: ' c.active ' });
    assert.match(generateSql(m), /LEFT JOIN public\.customers c ON o\.customer_id = c\.id AND c\.active/);
    assert.deepEqual(m.joins[0].pairs, [{ leftColumn: 'customer_id', rightColumn: 'id' }], 'incomplete pairs are dropped, = is the default');
    assert.throws(() => intent(m, 'updateJoin', { joinId, type: 'SIDEWAYS' }), /Unknown join type/);
    m = intent(m, 'updateJoin', { joinId, condition: '' });
    assert.equal(m.joins[0].condition, undefined);
});

test('editing the pairs of a NATURAL join ends it', () => {
    let m = ordersAndCustomers();
    m = { ...m, joins: [{ id: 'j1', leftTableId: 't1', rightTableId: 't2', type: 'INNER', pairs: [], natural: true }] };
    m = intent(m, 'updateJoin', { joinId: 'j1', pairs: [{ leftColumn: 'customer_id', rightColumn: 'id' }] });
    assert.equal(m.joins[0].natural, undefined);
    assert.match(generateSql(m), /INNER JOIN public\.customers c ON o\.customer_id = c\.id/);
});

test('bindExpression ties a typed qualifier.column to its table', () => {
    const m = ordersAndCustomers();
    assert.deepEqual(bindExpression(m, 'c.name'), { tableId: 't2', column: 'name' });
    assert.deepEqual(bindExpression(m, 'C."Name"'), { tableId: 't2', column: 'Name' });
    assert.equal(bindExpression(m, 'upper(c.name)'), undefined);
    assert.equal(bindExpression(m, 'x.name'), undefined);
});

test('updateColumn rebinds a changed expression and validates the aggregate', () => {
    let m = ordersAndCustomers();
    const id = m.columns[0].id;
    m = intent(m, 'updateColumn', { columnId: id, patch: { expression: 'c.name', alias: 'customer', aggregate: 'count' } });
    assert.deepEqual([m.columns[0].tableId, m.columns[0].column, m.columns[0].alias, m.columns[0].aggregate], ['t2', 'name', 'customer', 'COUNT']);
    m = intent(m, 'updateColumn', { columnId: id, patch: { expression: 'length(c.name)', aggregate: null, alias: null } });
    assert.deepEqual([m.columns[0].tableId, m.columns[0].column, m.columns[0].alias, m.columns[0].aggregate], [undefined, undefined, undefined, undefined]);
    assert.throws(() => intent(m, 'updateColumn', { columnId: id, patch: { aggregate: 'MEDIAN' } }), /Unknown aggregate/);
    assert.throws(() => intent(m, 'updateColumn', { columnId: id, patch: { expression: ' ' } }), /cannot be empty/);
});

test('setSort, setCriteria and setDistinct reach the generated SQL', () => {
    let m = ordersAndCustomers();
    const id = m.columns[0].id;
    m = intent(m, 'setSort', { columnId: id, sortType: 'desc', nulls: 'last' });
    m = intent(m, 'setCriteria', { columnId: id, row: 1, text: '> 10' });
    m = intent(m, 'setDistinct', { distinct: true });
    const sql = generateSql(m);
    assert.match(sql, /^SELECT DISTINCT/);
    assert.match(sql, /WHERE\n {4}o\.id > 10/);
    assert.match(sql, /ORDER BY\n {4}o\.id DESC NULLS LAST/);
    m = intent(m, 'setSort', { columnId: id, sortType: null });
    assert.equal(m.columns[0].sortType, undefined);
});

test('setDistinct off also drops DISTINCT ON', () => {
    const m = { ...ordersAndCustomers(), distinct: true, distinctOn: ['o.id'] };
    assert.equal(intent(m, 'setDistinct', { distinct: false }).distinctOn, undefined);
});

test('setRawParts edits the WITH queries and the raw conditions and refuses a nameless or doubled WITH query', () => {
    let m: QueryModel = { ...ordersAndCustomers(), ctes: [{ name: 'x', sql: 'SELECT 1 AS a', columns: ['a'], materialized: true }] };
    m = intent(m, 'setRawParts', {
        ctes: [{ index: 0, name: 'x', sql: 'SELECT 2 AS b' }, { name: '', sql: '' }],
        whereExtra: ['o.a = 1 OR o.b = 2', ' '],
        havingExtra: []
    });
    assert.deepEqual(m.ctes, [{ name: 'x', sql: 'SELECT 2 AS b', materialized: true }], 'stale columns go, the other settings stay');
    assert.deepEqual(m.whereExtra, ['o.a = 1 OR o.b = 2']);
    assert.equal(m.havingExtra, undefined);
    assert.throws(() => intent(m, 'setRawParts', { ctes: [{ name: '', sql: 'SELECT 1' }] }), /needs a name/);
    assert.throws(() => intent(m, 'setRawParts', { ctes: [{ name: 'a', sql: 'SELECT 1' }, { name: 'A', sql: 'SELECT 2' }] }), /used by two/);
});

test('placeTables and moveTable store rounded, non-negative positions and skip unknown tables', () => {
    const m = intent(ordersAndCustomers(), 'placeTables', { positions: [{ tableId: 't2', x: 100.6, y: -5 }, { tableId: 'zz', x: 1, y: 1 }, { tableId: 't1', x: 'a', y: 1 }] });
    assert.deepEqual([m.tables[1].x, m.tables[1].y], [101, 0]);
    assert.deepEqual([m.tables[0].x, m.tables[0].y], [10, 20]);
    const moved = intent(m, 'moveTable', { tableId: 't1', x: 300, y: 40 });
    assert.deepEqual([moved.tables[0].x, moved.tables[0].y], [300, 40]);
});

test('addExpression adds a grid row, tied to its table when it names a plain column', () => {
    let m = ordersAndCustomers();
    m = intent(m, 'addExpression', { expression: ' count(*) ' });
    m = intent(m, 'addExpression', { expression: 'c.name' });
    assert.deepEqual(m.columns.slice(1).map((c) => [c.expression, c.tableId]), [['count(*)', undefined], ['c.name', 't2']]);
    assert.throws(() => intent(m, 'addExpression', { expression: '' }), QbIntentError);
});

// ===== carryOverPositions =====

test('carryOverPositions keeps the place of a table by alias, else by relation, and leaves new tables unplaced', () => {
    const previous = ordersAndCustomers();
    previous.tables[1].x = 300;
    previous.tables[1].y = 40;
    let next = addTable(createEmptyModel(), { schema: 'public', name: 'orders', alias: 'o' }).model;
    next = addTable(next, { name: 'customers', alias: 'cust' }).model;
    next = addTable(next, { schema: 'public', name: 'items', alias: 'i' }).model;
    const result = carryOverPositions(previous, next);
    assert.deepEqual(result.tables.map((t) => [t.x, t.y]), [[10, 20], [300, 40], [undefined, undefined]]);
});

test('carryOverPositions gives a table that appears twice the two places it had', () => {
    let previous = addTable(createEmptyModel(), { name: 'emp', alias: 'e', x: 1, y: 1 }).model;
    previous = addTable(previous, { name: 'emp', alias: 'm', x: 2, y: 2 }).model;
    let next = addTable(createEmptyModel(), { name: 'emp', alias: 'boss' }).model;
    next = addTable(next, { name: 'emp', alias: 'e' }).model;
    assert.deepEqual(carryOverPositions(previous, next).tables.map((t) => t.x), [2, 1]);
});

test('offsetToLineColumn counts 1-based lines and columns', () => {
    assert.deepEqual(offsetToLineColumn('SELECT\n  FROM x', 9), { line: 2, column: 3 });
    assert.deepEqual(offsetToLineColumn('abc', 0), { line: 1, column: 1 });
    assert.deepEqual(offsetToLineColumn('abc', 99), { line: 1, column: 4 });
});

// ===== Apply into a SQL file =====

test('locateApplyRange finds the statement where it was, or at its only other place, and refuses otherwise', () => {
    const original = 'SELECT a FROM t';
    assert.deepEqual(locateApplyRange(`-- x\n${original};`, 5, original), { start: 5, end: 20 });
    assert.deepEqual(locateApplyRange(`-- added line\n-- x\n${original};`, 5, original), { start: 19, end: 34 });
    assert.match((locateApplyRange('SELECT b FROM t;', 0, original) as { error: string }).error, /changed in the editor/);
    assert.match((locateApplyRange(`x ${original}; ${original};`, 0, original) as { error: string }).error, /more than once/);
});

test('indentContinuationLines indents a statement written into a function body, except multi-line literals', () => {
    assert.equal(indentContinuationLines('SELECT\n    a\nFROM\n\n    t', '    '), 'SELECT\n        a\n    FROM\n\n        t');
    const literal = "SELECT 'line one\nline two' AS x";
    assert.equal(indentContinuationLines(literal, '  '), literal);
    assert.equal(indentContinuationLines('SELECT\n1', ''), 'SELECT\n1');
    assert.equal(lineIndentAt('BEGIN\n\t  RETURN QUERY SELECT 1;', 20), '\t  ');
});

// ===== Entry points =====

test('selectSourceFromText returns the exact range of the SELECT at the cursor in a function body', () => {
    const text = 'CREATE FUNCTION f() RETURNS SETOF t AS $$\nBEGIN\n    RETURN QUERY SELECT a\n      FROM t ;\nEND $$ LANGUAGE plpgsql;';
    const source = selectSourceFromText(text, text.indexOf('FROM t'));
    assert.ok(source);
    assert.equal(text.slice(source.start, source.end), 'SELECT a\n      FROM t');
    assert.equal(source.sql, 'SELECT a\n      FROM t');
    assert.equal(source.readOnlyReason, undefined);
});

test('selectSourceFromText opens a SELECT INTO without Apply, so the INTO is never lost', () => {
    const text = 'DO $$ BEGIN SELECT count(*) INTO n FROM t; END $$;';
    const source = selectSourceFromText(text, text.indexOf('count'));
    assert.ok(source?.readOnlyReason?.includes('INTO'));
    assert.equal(source?.sql, 'SELECT count(*) INTO n FROM t');
});

test('selectSourceFromText uses a selection verbatim and ignores UPDATE statements', () => {
    const text = 'SELECT 1;\nSELECT a FROM t WHERE x = 1;';
    const start = text.indexOf('SELECT a');
    const source = selectSourceFromText(text, 0, { start, end: text.length });
    assert.equal(source?.sql, 'SELECT a FROM t WHERE x = 1');
    assert.equal(selectSourceFromText('UPDATE t SET a = 1 WHERE b = 2', 3), undefined);
    assert.equal(selectSourceFromText('   ', 1), undefined);
});

test('relationsFromNodes takes the selected tables of the Tables view once each, without repository-only ones', () => {
    const node = { type: 'table', schema: 'public', table: 'orders', kind: 'table' };
    assert.deepEqual(relationsFromNodes(node, undefined), [{ schema: 'public', name: 'orders' }]);
    assert.deepEqual(relationsFromNodes(node, [
        node,
        { type: 'table', schema: 'public', table: 'v', kind: 'view' },
        { type: 'table', schema: 'public', table: 'repo', kind: 'table', status: 'repoOnly' },
        { type: 'schema', schema: 'public' },
        { type: 'table', schema: 'public', table: 'orders', kind: 'table' }
    ]), [{ schema: 'public', name: 'orders' }, { schema: 'public', name: 'v' }]);
    assert.deepEqual(relationsFromNodes(undefined, undefined), []);
});

test('builderTitle names the first table of the query', () => {
    assert.equal(builderTitle(createEmptyModel()), 'Query Builder');
    assert.equal(builderTitle(ordersAndCustomers()), 'Query Builder: orders');
});

// ===== Results preview =====

function fakeClient(answers: Record<string, unknown> = {}, failOn?: string) {
    const sent: string[] = [];
    const released: unknown[] = [];
    const client: PreviewClient = {
        async query(config) {
            const sql = typeof config === 'string' ? config : config.text;
            sent.push(sql);
            if (failOn && sql.startsWith(failOn)) throw new Error('boom');
            return (answers[sql.split(' ')[0]] as any) ?? { rows: [] };
        },
        release(err?: Error | boolean) { released.push(err); }
    };
    return { client, sent, released };
}

test('runPreviewQuery reads the first rows through a cursor in a read-only transaction that is rolled back', async () => {
    const rows = [[1, null], [2, new Date('2024-01-02T03:04:05Z')], [3, Buffer.from([1, 255])]];
    const f = fakeClient({ FETCH: { rows, fields: [{ name: 'id' }, { name: 'id' }] } });
    const result = await runPreviewQuery(async () => f.client, 'SELECT 1', 2);
    assert.deepEqual(f.sent, ['BEGIN READ ONLY', 'DECLARE qb_preview NO SCROLL CURSOR FOR\nSELECT 1', 'FETCH 3 FROM qb_preview', 'ROLLBACK']);
    assert.deepEqual(result.columns, ['id', 'id'], 'duplicate column names survive');
    assert.deepEqual(result.rows, [['1', null], ['2', '2024-01-02T03:04:05.000Z']]);
    assert.equal(result.truncated, true);
    assert.deepEqual(f.released, [undefined]);
});

test('runPreviewQuery rolls back and releases the client when the query fails', async () => {
    const f = fakeClient({}, 'DECLARE');
    await assert.rejects(runPreviewQuery(async () => f.client, 'SELECT x'), /boom/);
    assert.deepEqual(f.sent.slice(-1), ['ROLLBACK']);
    assert.equal(f.released.length, 1);
});

test('formatPreviewValue shows dates, bytes and JSON as text and keeps NULL', () => {
    assert.equal(formatPreviewValue(null), null);
    assert.equal(formatPreviewValue(Buffer.from([0xab])), '\\xab');
    assert.equal(formatPreviewValue({ a: [1] }), '{"a":[1]}');
    assert.equal(formatPreviewValue(12.5), '12.5');
});

// ===== Message contract =====

function postedCommands(source: string): string[] {
    return [...new Set([...source.matchAll(/command:\s*'([A-Za-z]+)'/g)].map((m) => m[1]))];
}

test('every command the webview posts has a handler on the host, and every handler is used', () => {
    const posted = [...postedCommands(WEBVIEW_JS), ...postedCommands(EDITOR_JS)];
    const handled = new Set<string>([...Object.keys(MODEL_INTENTS), ...PANEL_COMMANDS]);
    const unhandled = posted.filter((c) => !handled.has(c));
    assert.deepEqual(unhandled, [], `posted by queryBuilder.js but not handled: ${unhandled.join(', ')}`);
    const unused = [...handled].filter((c) => !posted.includes(c));
    assert.deepEqual(unused, [], `handled but never posted: ${unused.join(', ')}`);
});

test('every command the host posts is handled by the webview', () => {
    const sent = [...new Set([...HOST_TS.matchAll(/command:\s*'([A-Za-z]+)'/g)].map((m) => m[1]))]
        .filter((c) => !(PANEL_COMMANDS as readonly string[]).includes(c));
    const cases = new Set([...`${WEBVIEW_JS}\n${EDITOR_JS}`.matchAll(/case '([A-Za-z]+)'|msg\.command === '([A-Za-z]+)'/g)].map((m) => m[1] || m[2]));
    const missing = sent.filter((c) => !cases.has(c));
    assert.deepEqual(missing, [], `posted by the host but not handled: ${missing.join(', ')}`);
    assert.ok(sent.includes('state') && sent.includes('previewResult'));
});

// ===== The panel =====

function createFakePanel() {
    const posted: any[] = [];
    let onMessage: (m: unknown) => unknown = () => undefined;
    const disposers: Array<() => void> = [];
    const panel = {
        title: '',
        posted,
        send: (m: unknown) => onMessage(m),
        webview: {
            html: '',
            cspSource: 'vscode-resource:',
            postMessage: (m: unknown) => { posted.push(m); return Promise.resolve(true); },
            onDidReceiveMessage: (cb: (m: unknown) => unknown) => { onMessage = cb; return { dispose() {} }; }
        },
        onDidDispose: (cb: () => void) => { disposers.push(cb); return { dispose() {} }; },
        reveal() {},
        dispose() { for (const cb of disposers) cb(); },
        viewStateListeners: [] as Array<(e: unknown) => void>,
        onDidChangeViewState(cb: (e: unknown) => void) { this.viewStateListeners.push(cb); return { dispose() {} }; },
        /** The user switches to this panel. */
        activate() { for (const cb of this.viewStateListeners) cb({ webviewPanel: { active: true } }); }
    };
    return panel;
}

/** Catalog answers for public.orders(id, customer_id) and public.customers(id, name) with one foreign key. */
function fakeCatalog(): (sql: string, params?: unknown[]) => Promise<CatalogRow[]> {
    const columns: Record<string, string[]> = { orders: ['id', 'customer_id', 'total'], customers: ['id', 'name'] };
    return async (sql, params) => {
        if (sql.includes('to_regclass')) return columns[String(params?.[0])] ? [{ schema_name: 'public' }] : [];
        if (sql.includes('a.attname AS column_name')) {
            return (columns[String(params?.[1])] ?? []).map((name, i) => ({ column_name: name, data_type: 'integer', is_nullable: false, ordinal: i + 1, is_primary_key: name === 'id' }));
        }
        if (sql.includes("con.contype = 'f'")) {
            return [{ constraint_name: 'fk', schema_name: 'public', table_name: 'orders', ref_schema: 'public', ref_table: 'customers', columns: ['customer_id'], ref_columns: ['id'] }];
        }
        return [];
    };
}

async function openBuilder(options: { sql?: string; tables?: Array<{ schema: string; name: string }>; target?: QueryBuilderTarget } = {}, overrides: Partial<QueryBuilderServices> = {}) {
    const panel = createFakePanel();
    const opened: Array<{ sql: string; title: string }> = [];
    const services: QueryBuilderServices = {
        extensionPath: ROOT,
        ensureConnected: async () => true,
        isConnected: () => true,
        catalogQuery: fakeCatalog(),
        mappings: () => [],
        takeDraggedTables: () => [],
        onConnectionChanged: () => ({ dispose() {} }),
        runPreview: async () => ({ columns: ['n'], rows: [['1']], truncated: false, durationMs: 1 }),
        openInDataViewer: async (sql, title) => { opened.push({ sql, title }); },
        editorRequest: async () => ({ ok: true }),
        ...overrides
    };
    const original = vscodeStub.window.createWebviewPanel;
    vscodeStub.window.createWebviewPanel = () => panel;
    try {
        const manager = new QueryBuilderManager(services);
        const builder = await manager.open(options);
        return { panel, builder, manager, opened, last: (command: string) => [...panel.posted].reverse().find((m) => m.command === command) };
    } finally {
        vscodeStub.window.createWebviewPanel = original;
    }
}

test('the Query Builder document has a strict CSP with a nonce, the Monaco sources and no inline handler', () => {
    const html = buildQueryBuilderHtml({ cspSource: 'vscode-resource:' }, ROOT, { applyTitle: 'Write it "back"' });
    const nonce = /<script nonce="([^"]+)">/.exec(html)?.[1];
    assert.ok(nonce);
    assert.match(html, new RegExp(`script-src 'nonce-${nonce}' vscode-resource:`));
    assert.match(html, /default-src 'none'/);
    assert.match(html, /worker-src vscode-resource: blob:/);
    assert.ok(html.includes('data-action="apply" title="Write it &quot;back&quot;"'));
    assert.equal(/\son[a-z]+="/.test(html.replace(/<script[\s\S]*<\/script>/, '')), false);
    assert.ok(html.includes('window.QB_CONFIG = {"aggregates":["COUNT"'));
    assert.equal(buildQueryBuilderHtml({ cspSource: 'x' }, ROOT, {}).includes('data-action="apply"'), false, 'no Apply without a target');
});

test('the Query Builder has no table list of its own: the canvas takes the width and asks for the tables dragged from the Tables view', () => {
    const html = buildQueryBuilderHtml({ cspSource: 'vscode-resource:' }, ROOT, {});
    for (const gone of ['qb-sidebar', 'relFilter', 'relList', 'refreshCatalog']) assert.equal(html.includes(gone), false, `${gone} is still there`);
    assert.match(html, /<button class="btn btn-icon" data-action="addDraggedTables" title="Add Dragged Tables: [^"]+">/);
    assert.match(WEBVIEW_JS, /addDraggedTables: \(\) => post\(\{ command: 'requestDroppedTables' \}\)/);
    assert.match(WEBVIEW_JS, /Right-click tables in the Tables view and choose Add to Query Builder, or drag them here\./);
});

test('opening the builder with tables adds them joined along their foreign key and names the panel', async () => {
    const { panel, builder, last } = await openBuilder({ tables: [{ schema: 'public', name: 'customers' }, { schema: 'public', name: 'orders' }] });
    assert.equal(panel.title, 'Query Builder: customers');
    assert.equal(builder.model.joins.length, 1);
    assert.match(generateSql(builder.model), /FROM\n {4}public\.customers c\n {4}INNER JOIN public\.orders o ON c\.id = o\.customer_id/);
    await builder.receive({ command: 'ready' });
    const state = last('state');
    assert.deepEqual(state.columns.t1.map((c: any) => [c.name, c.isPrimaryKey]), [['id', true], ['name', false]]);
});

test('tables added from the Tables view are placed by the diagram or at the drop point, as one undo step', async () => {
    const { builder, panel, last } = await openBuilder();
    await builder.addTables([{ schema: 'public', name: 'orders' }], { x: 40.4, y: 50 });
    await builder.addTables([{ schema: 'public', name: 'orders' }, { schema: 'public', name: 'customers' }]);
    assert.deepEqual(builder.model.tables.map((t) => [t.alias, t.x]), [['o', 40], ['o2', undefined], ['c', undefined]]);
    assert.equal(builder.model.joins.length, 1, 'customers is joined to the first orders');
    assert.equal(last('state').origin, 'addTable');
    await builder.receive({ command: 'undo' });
    assert.equal(builder.model.tables.length, 1, 'one Undo takes the whole batch back');
    assert.equal(last('state').canRedo, true);
    await panel.send({ command: 'redo' });
    await builder.receive({ command: 'ready' });
    assert.equal(builder.model.tables.length, 3);
});

test('a SQL edit with a syntax error is reported with its position and keeps the diagram', async () => {
    const { builder, last, panel } = await openBuilder({ sql: 'SELECT o.id FROM public.orders o' });
    const before = builder.model;
    await builder.receive({ command: 'sqlEdited', sql: 'SELECT o.id\nFROM public.orders o\nWHERE', seq: 3 });
    const status = last('sqlStatus');
    assert.deepEqual([status.seq, status.ok, status.line], [3, false, 3]);
    assert.ok(status.column >= 1);
    assert.equal(builder.model, before);
    // Run, Apply and Copy refuse to use the last valid query silently.
    await builder.receive({ command: 'runPreview' });
    assert.match(last('previewResult').error, /cannot be read/);
    assert.match(last('notice').text, /Fix it in the SQL tab/);
    // A valid edit clears the error.
    panel.posted.length = 0;
    await builder.receive({ command: 'sqlEdited', sql: 'SELECT o.id, o.total FROM public.orders o', seq: 4 });
    assert.equal(last('sqlStatus').ok, true);
    assert.equal(last('state').origin, 'sql');
    await builder.receive({ command: 'runPreview' });
    assert.deepEqual(last('previewResult').rows, [['1']]);
});

test('reading edited SQL keeps the diagram positions and assigns unqualified columns to their table', async () => {
    const { builder } = await openBuilder({ sql: 'SELECT o.id FROM public.orders o' });
    await builder.receive({ command: 'moveTable', tableId: 't1', x: 300, y: 120 });
    await builder.receive({ command: 'sqlEdited', sql: 'SELECT name FROM public.orders o JOIN public.customers c ON c.id = o.customer_id', seq: 1 });
    assert.deepEqual([builder.model.tables[0].x, builder.model.tables[0].y], [300, 120]);
    assert.equal(builder.model.columns[0].tableId, 't2');
});

test('opening the builder on SQL it cannot read shows the text with its error once the webview is ready', async () => {
    const { builder, panel, last } = await openBuilder({ sql: 'SELECT FROM WHERE' });
    panel.posted.length = 0;
    await builder.receive({ command: 'ready' });
    const status = last('sqlStatus');
    assert.equal(status.sql, 'SELECT FROM WHERE');
    assert.equal(status.ok, false);
});

/** The SQL tab of the webview fed with the messages the host posted. */
function replayToSqlTab(posted: any[]) {
    const { createSqlText } = require(path.join(ROOT, 'src', 'webview', 'queryBuilder.js'));
    const tab = { text: '', status: { ok: true } as any, active: 'diagram' };
    const sqlText = createSqlText({
        getText: () => tab.text,
        setText: (t: string) => { tab.text = t; },
        post: () => undefined,
        setTimer: () => 0,
        clearTimer: () => undefined,
        showStatus: (s: unknown) => { tab.status = s; }
    });
    for (const msg of posted) {
        if (msg.command === 'state') sqlText.state(msg, tab.active === 'sql');
        if (msg.command === 'sqlStatus' && sqlText.status(msg)) {
            tab.active = 'sql';
            sqlText.shown();
        }
    }
    return tab;
}

test('SQL the builder cannot read stays in the SQL tab with its error, and an Undo with nothing to undo does not let Apply overwrite it', async () => {
    const applied: string[] = [];
    const target: QueryBuilderTarget = { description: 'x', apply: async (sql) => { applied.push(sql); return { ok: true, message: 'done' }; } };
    const sql = 'SELECT * FROM t WHERE id = :id AND';
    const panel = createFakePanel();
    const original = vscodeStub.window.createWebviewPanel;
    vscodeStub.window.createWebviewPanel = () => panel;
    let builder: QueryBuilderPanel;
    try {
        const manager = new QueryBuilderManager({
            extensionPath: ROOT,
            ensureConnected: async () => true,
            isConnected: () => true,
            catalogQuery: fakeCatalog(),
            mappings: () => [],
            takeDraggedTables: () => [],
            onConnectionChanged: () => ({ dispose() {} }),
            runPreview: async () => ({ columns: [], rows: [], truncated: false, durationMs: 0 }),
            openInDataViewer: async () => undefined,
            editorRequest: async () => null
        });
        const opening = manager.open({ sql, target });
        // The webview may be ready while the SQL is still being read.
        panel.send({ command: 'ready' });
        builder = await opening;
    } finally {
        vscodeStub.window.createWebviewPanel = original;
    }
    await builder.receive({ command: 'undo' });
    const tab = replayToSqlTab(panel.posted);
    assert.equal(tab.active, 'sql');
    assert.equal(tab.text, sql);
    assert.equal(tab.status.ok, false);
    await builder.receive({ command: 'apply' });
    await builder.receive({ command: 'copySql' });
    assert.deepEqual(applied, []);
    assert.match([...panel.posted].reverse().find((m) => m.command === 'notice').text, /cannot be read.*Fix it in the SQL tab/);
});

test('a refused intent is reported and the webview gets the unchanged state back', async () => {
    const { builder, last } = await openBuilder({ sql: 'SELECT o.id FROM public.orders o' });
    await builder.receive({ command: 'removeTable', tableId: 'gone' });
    assert.equal(last('notice').kind, 'error');
    assert.equal(last('state').origin, 'rejected');
    assert.equal(builder.model.tables.length, 1);
});

test('a placement of new tables by the diagram is no undo step', async () => {
    const { builder, last } = await openBuilder({ sql: 'SELECT 1 FROM public.orders o' });
    await builder.receive({ command: 'placeTables', record: false, positions: [{ tableId: 't1', x: 24, y: 24 }] });
    assert.equal(last('state').origin, 'place');
    assert.equal(last('state').canUndo, false);
    await builder.receive({ command: 'placeTables', positions: [{ tableId: 't1', x: 50, y: 24 }] });
    assert.equal(last('state').canUndo, true);
});

test('Apply hands the SQL to the target and reports its answer; without a target it explains why not', async () => {
    const applied: string[] = [];
    const target: QueryBuilderTarget = { description: 'x', apply: async (sql) => { applied.push(sql); return { ok: true, message: 'done' }; } };
    const { builder, last } = await openBuilder({ sql: 'SELECT o.id FROM public.orders o', target });
    await builder.receive({ command: 'apply' });
    assert.deepEqual(applied, [generateSql(builder.model)]);
    assert.deepEqual([last('notice').text, last('notice').kind], ['done', 'info']);
    const plain = await openBuilder({ sql: 'SELECT 1' });
    await plain.builder.receive({ command: 'apply' });
    assert.match(plain.last('notice').text, /nothing to apply/);
});

test('Run waits for a SQL edit posted before it', async () => {
    const ran: string[] = [];
    const { builder, panel } = await openBuilder({ sql: 'SELECT o.id FROM public.orders o' }, { runPreview: async (sql) => { ran.push(sql); return { columns: [], rows: [], truncated: false, durationMs: 0 }; } });
    const edit = panel.send({ command: 'sqlEdited', sql: 'SELECT o.total FROM public.orders o', seq: 1 });
    await Promise.all([edit, builder.receive({ command: 'runPreview' })]);
    assert.match(ran[0], /o\.total/);
});

test('the preview is answered with an error when there is no connection', async () => {
    const { builder, last } = await openBuilder({ sql: 'SELECT 1' }, { ensureConnected: async () => false, isConnected: () => false });
    await builder.receive({ command: 'runPreview' });
    assert.match(last('previewResult').error, /Not connected/);
    await builder.addTables([{ schema: 'public', name: 'orders' }]);
    assert.match(last('notice').text, /Connect to a database/);
});

test('Open in Data Viewer and the editor requests are answered', async () => {
    const { builder, opened, last } = await openBuilder({ sql: 'SELECT o.id FROM public.orders o' }, {
        editorRequest: async (kind) => { if (kind === 'columns') throw new Error('offline'); return ['catalog']; }
    });
    await builder.receive({ command: 'openInDataViewer' });
    assert.deepEqual(opened, [{ sql: generateSql(builder.model), title: 'Query Builder: orders' }]);
    await builder.receive({ command: 'queryEditorRequest', requestId: 7, kind: 'catalog' });
    assert.deepEqual(last('queryEditorResponse'), { command: 'queryEditorResponse', requestId: 7, result: ['catalog'] });
    await builder.receive({ command: 'queryEditorRequest', requestId: 8, kind: 'columns' });
    assert.deepEqual(last('queryEditorResponse'), { command: 'queryEditorResponse', requestId: 8, result: null });
});

test('Run and Open in Data Viewer ask for the placeholder values and use the filled-in SQL; Apply and Copy keep the placeholders', async () => {
    const ran: string[] = [];
    const asked: Array<[string, string]> = [];
    const applied: string[] = [];
    const target: QueryBuilderTarget = { description: 'x', apply: async (sql) => { applied.push(sql); return { ok: true, message: 'done' }; } };
    const { builder, opened, last } = await openBuilder({ sql: 'SELECT o.id FROM public.orders o WHERE o.id = :id', target }, {
        runPreview: async (sql) => { ran.push(sql); return { columns: [], rows: [], truncated: false, durationMs: 0 }; },
        askForVariables: async (sql, label) => { asked.push([sql, label]); return sql.replace(':id', '42'); }
    });
    assert.deepEqual(builder.model.columns.map((c) => c.criteria), [['= :id']]);
    await builder.receive({ command: 'runPreview' });
    assert.deepEqual(asked.map(([, label]) => label), ['Run']);
    assert.match(asked[0][0], /o\.id = :id/);
    assert.deepEqual(ran.length, 1);
    assert.match(ran[0], /o\.id = 42/);
    assert.deepEqual(last('previewResult').rows, []);
    await builder.receive({ command: 'openInDataViewer' });
    assert.match(opened[0].sql, /o\.id = 42/);
    await builder.receive({ command: 'apply' });
    assert.match(applied[0], /o\.id = :id/);
});

test('cancelling the placeholder values runs nothing but answers the Results tab', async () => {
    const ran: string[] = [];
    const { builder, opened, last } = await openBuilder({ sql: 'SELECT o.id FROM public.orders o' }, {
        runPreview: async (sql) => { ran.push(sql); return { columns: [], rows: [], truncated: false, durationMs: 0 }; },
        askForVariables: async () => undefined
    });
    await builder.receive({ command: 'setCriteria', columnId: builder.model.columns[0].id, row: 0, text: '= :id' });
    assert.match(generateSql(builder.model), /WHERE\n {4}o\.id = :id/);
    await builder.receive({ command: 'runPreview' });
    assert.deepEqual(ran, []);
    assert.match(last('previewResult').error, /not run/);
    await builder.receive({ command: 'openInDataViewer' });
    assert.deepEqual(opened, []);
});

test('a query without placeholders runs without asking', async () => {
    let asked = 0;
    const { builder, last } = await openBuilder({ sql: 'SELECT o.id FROM public.orders o WHERE o.id = 1' }, {
        askForVariables: async (sql) => { asked++; return sql; }
    });
    await builder.receive({ command: 'runPreview' });
    assert.equal(asked, 0);
    assert.deepEqual(last('previewResult').rows, [['1']]);
});

test('a connection change runs in turn with the model changes, so one posted while it reads the catalog is kept', async () => {
    const catalog = fakeCatalog();
    let connectionChanged = () => undefined as void;
    let blockColumns = false;
    let release: (() => void) | undefined;
    const { builder, panel } = await openBuilder({ sql: 'SELECT o.id FROM public.orders o' }, {
        onConnectionChanged: (listener) => { connectionChanged = listener; return { dispose() {} }; },
        catalogQuery: async (sql, params) => {
            if (blockColumns && sql.includes('a.attname AS column_name')) {
                blockColumns = false;
                await new Promise<void>((resolve) => { release = resolve; });
            }
            return catalog(sql, params);
        }
    });
    const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
    blockColumns = true;
    connectionChanged();
    await settle();
    const intent = builder.receive({ command: 'setDistinct', distinct: true });
    await settle();
    assert.ok(release, 'the catalog is being read');
    release?.();
    await intent;
    await settle();
    assert.equal(builder.model.distinct, true);
    assert.ok(panel.posted.some((m) => m.command === 'state' && m.origin === 'catalog'));
    assert.equal([...panel.posted].reverse().find((m) => m.command === 'state').model.distinct, true);
});

test('closing the panel forgets it', async () => {
    const { panel, manager } = await openBuilder();
    assert.equal(manager.openPanels, 1);
    panel.dispose();
    assert.equal(manager.openPanels, 0);
});

/** Open another builder in the same manager, on a new fake panel. */
async function openAnother(manager: QueryBuilderManager, run: () => Promise<QueryBuilderPanel> = () => manager.open()) {
    const panel = createFakePanel();
    const original = vscodeStub.window.createWebviewPanel;
    vscodeStub.window.createWebviewPanel = () => panel;
    try {
        return { panel, builder: await run() };
    } finally {
        vscodeStub.window.createWebviewPanel = original;
    }
}

test('Add to Query Builder adds to the builder used last, and a closed one is skipped', async () => {
    const first = await openBuilder();
    const second = await openAnother(first.manager);
    assert.equal(first.manager.lastActive, second.builder, 'a new builder is the one used last');
    first.panel.activate();
    assert.equal(await first.manager.addTables([{ schema: 'public', name: 'orders' }]), first.builder);
    assert.deepEqual(first.builder.model.tables.map((t) => t.name), ['orders']);
    assert.equal(second.builder.model.tables.length, 0);
    first.panel.dispose();
    assert.equal(await first.manager.addTables([{ schema: 'public', name: 'customers' }]), second.builder);
    assert.deepEqual(second.builder.model.tables.map((t) => t.name), ['customers']);
});

test('Add to Query Builder opens a new builder with the tables when none is open', async () => {
    const { panel, manager } = await openBuilder();
    panel.dispose();
    const added = await openAnother(manager, () => manager.addTables([{ schema: 'public', name: 'customers' }, { schema: 'public', name: 'orders' }]));
    assert.equal(manager.openPanels, 1);
    assert.equal(added.panel.title, 'Query Builder: customers');
    assert.equal(added.builder.model.joins.length, 1);
    assert.equal(added.builder.model.tables.length, 2);
});

test('a drop on the canvas adds the tables last dragged from the Tables view, or explains how to add tables', async () => {
    const dragged: Array<Array<{ schema: string; name: string }>> = [[{ schema: 'public', name: 'orders' }, { schema: 'public', name: 'customers' }]];
    const { builder, last } = await openBuilder({}, { takeDraggedTables: () => dragged.shift() ?? [] });
    await builder.receive({ command: 'requestDroppedTables', x: 120.6, y: 80 });
    assert.deepEqual(builder.model.tables.map((t) => [t.name, t.x, t.y]), [['orders', 121, 80], ['customers', undefined, undefined]]);
    assert.equal(builder.model.joins.length, 1);
    assert.equal(last('state').canUndo, true);
    await builder.receive({ command: 'requestDroppedTables' });
    assert.equal(builder.model.tables.length, 2);
    assert.match(last('notice').text, /^Drag tables from the Tables view onto the canvas, or right-click them and choose Add to Query Builder\.$/);
    await builder.receive({ command: 'undo' });
    assert.deepEqual(builder.model.tables, [], 'the dropped tables are one undo step');
});

test('tables added together are joined along the custom column mappings as well', async () => {
    const mappings: CustomColumnMapping[] = [{
        id: 'm1', sourceSchema: 'public', sourceTable: 'customers', sourceColumn: 'name',
        targetSchema: 'public', targetTable: 'orders', targetColumn: 'total',
        conditions: [{ column: 'name', operator: '<>', value: "it's" }], isDefault: true
    }];
    const { builder } = await openBuilder({ tables: [{ schema: 'public', name: 'customers' }, { schema: 'public', name: 'orders' }] }, { mappings: () => mappings });
    assert.equal(builder.model.joins.length, 1);
    assert.match(generateSql(builder.model), /INNER JOIN public\.orders o ON c\.id = o\.customer_id AND c\.name = o\.total AND c\.name <> 'it''s'/);
});

// ===== Manifest =====

test('the Query Builder commands are contributed with category and icon and offered where they apply', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const commands = new Map((manifest.contributes.commands as Array<{ command: string; title: string; category?: string; icon?: string }>).map((c) => [c.command, c]));
    for (const [id, title] of [
        ['postgresQueryBuilder.openQueryBuilder', 'New Query Builder'],
        ['postgresQueryBuilder.openTablesInQueryBuilder', 'Open in Query Builder'],
        ['postgresQueryBuilder.addTablesToQueryBuilder', 'Add to Query Builder'],
        ['postgresQueryBuilder.editSelectInQueryBuilder', 'Edit SELECT in Query Builder']
    ]) {
        const command = commands.get(id);
        assert.equal(command?.title, title);
        assert.equal(command?.category, 'PostgreSQL Query Booster');
        assert.ok(command?.icon, `${id} has no icon`);
    }
    const menus = manifest.contributes.menus;
    const tableItem = menus['view/item/context'].find((m: { command: string }) => m.command === 'postgresQueryBuilder.openTablesInQueryBuilder');
    assert.match(tableItem.when, /view == postgresTableExplorer && viewItem =~/);
    const addItem = menus['view/item/context'].find((m: { command: string }) => m.command === 'postgresQueryBuilder.addTablesToQueryBuilder');
    assert.equal(addItem.when, tableItem.when, 'Add to Query Builder is offered on the same nodes as Open in Query Builder');
    assert.equal(addItem.group.split('@')[0], tableItem.group.split('@')[0], 'and next to it');
    assert.ok(menus['view/title'].some((m: { command: string; when: string }) => m.command === 'postgresQueryBuilder.openQueryBuilder' && m.when === 'view == postgresTableExplorer'));
    const editor = menus['editor/context'].find((m: { command: string }) => m.command === 'postgresQueryBuilder.editSelectInQueryBuilder');
    for (const language of ['sql', 'postgres', 'pgsql']) assert.ok(editor.when.includes(`resourceLangId == ${language}`));
    const palette = menus.commandPalette.find((m: { command: string }) => m.command === 'postgresQueryBuilder.openTablesInQueryBuilder');
    assert.equal(palette.when, 'false', 'the table command needs a tree node');
    const addPalette = menus.commandPalette.find((m: { command: string }) => m.command === 'postgresQueryBuilder.addTablesToQueryBuilder');
    assert.equal(addPalette.when, 'false', 'Add to Query Builder needs a tree node');
    const extension = fs.readFileSync(path.join(ROOT, 'src', 'extension.ts'), 'utf8');
    for (const id of ['openQueryBuilder', 'openTablesInQueryBuilder', 'addTablesToQueryBuilder', 'editSelectInQueryBuilder']) {
        assert.ok(extension.includes(`registerCommand('postgresQueryBuilder.${id}'`), `${id} is not registered`);
    }
});
