import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

const qb = require(path.join(__dirname, '../../../src/webview/queryBuilder.js'));

function model(overrides: Record<string, unknown> = {}): any {
    return { distinct: false, ctes: [], tables: [], joins: [], columns: [], warnings: [], ...overrides };
}

const orders = { id: 't1', kind: 'relation', schema: 'public', name: 'orders', alias: 'o' };
const customers = { id: 't2', kind: 'relation', schema: 'public', name: 'customers', alias: 'c' };
const items = { id: 't3', kind: 'relation', schema: 'public', name: 'items', alias: 'i' };
const lonely = { id: 't4', kind: 'relation', name: 'audit', alias: 'a' };

// ===== tableTitle / tableLabel =====

test('tableTitle names a relation with its schema and shows an alias only when it differs from the name', () => {
    assert.deepEqual(qb.tableTitle(orders), { name: 'public.orders', alias: 'o' });
    assert.deepEqual(qb.tableTitle({ id: 't', kind: 'relation', name: 'x', alias: 'x' }), { name: 'x', alias: '' });
    assert.equal(qb.tableDescription(orders), 'orders o');
    assert.equal(qb.tableDescription({ id: 't', kind: 'subquery', sql: 'SELECT 1', alias: 's' }), 's');
});

test('tableTitle shows a derived table as (subquery) and shortens a long function call', () => {
    assert.deepEqual(qb.tableTitle({ id: 't', kind: 'subquery', sql: 'SELECT 1', alias: 's' }), { name: '(subquery)', alias: 's' });
    const title = qb.tableTitle({ id: 't', kind: 'function', sql: 'generate_series(1, 1000000, 1)   AS something_long', alias: 'g' });
    assert.ok(title.name.length <= 32 && title.name.endsWith('…'));
});

// ===== boxColumns =====

test('boxColumns lists the catalog columns, adds the ones the query uses and marks the ticked ones', () => {
    const m = model({
        tables: [orders, customers],
        joins: [{ id: 'j1', leftTableId: 't2', rightTableId: 't1', type: 'INNER', pairs: [{ leftColumn: 'id', rightColumn: 'customer_ref' }] }],
        columns: [
            { id: 'c1', expression: 'o.total', tableId: 't1', column: 'total', output: true, groupBy: false, criteria: [] },
            { id: 'c2', expression: 'o.id', tableId: 't1', column: 'id', output: false, groupBy: false, criteria: ['> 1'] }
        ]
    });
    const cols = qb.boxColumns(orders, [{ name: 'id', dataType: 'integer', isPrimaryKey: true }], m);
    assert.deepEqual(cols.map((c: any) => [c.name, c.selected, c.isPrimaryKey]), [
        ['id', false, true],
        ['total', true, false],
        ['customer_ref', false, false]
    ]);
});

// ===== Layout =====

test('autoLayout puts joined tables left to right and a table without joins below them', () => {
    const joins = [
        { id: 'j1', leftTableId: 't1', rightTableId: 't2', type: 'INNER', pairs: [] },
        { id: 'j2', leftTableId: 't1', rightTableId: 't3', type: 'INNER', pairs: [] }
    ];
    const sizes = { t1: { width: 220, height: 100 }, t2: { width: 220, height: 60 }, t3: { width: 220, height: 60 }, t4: { width: 220, height: 40 } };
    const p = qb.autoLayout([orders, customers, items, lonely], joins, sizes);
    const { margin, width, gapX, gapY } = qb.QB_BOX;
    assert.deepEqual(p.t1, { x: margin, y: margin });
    assert.deepEqual(p.t2, { x: margin + width + gapX, y: margin });
    assert.deepEqual(p.t3, { x: margin + width + gapX, y: margin + 60 + gapY });
    // The second group starts below the tallest column of the first.
    assert.deepEqual(p.t4, { x: margin, y: margin + Math.max(100, 120 + gapY) + gapY });
});

test('autoLayout never lets two boxes overlap', () => {
    const tables = Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, kind: 'relation', name: `n${i}` }));
    const joins = [{ id: 'j', leftTableId: 't0', rightTableId: 't1', type: 'INNER', pairs: [] }, { id: 'k', leftTableId: 't0', rightTableId: 't2', type: 'LEFT', pairs: [] }];
    const p = qb.autoLayout(tables, joins, {});
    const rects = tables.map(t => ({ ...p[t.id], ...qb.estimateBoxSize(0) }));
    for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) assert.equal(qb.rectsOverlap(rects[i], rects[j]), false, `${i} overlaps ${j}`);
    }
});

test('placeMissing leaves placed tables alone and puts a new joined table right of its partner, below any box in the way', () => {
    const placedOrders = { ...orders, x: 20, y: 20 };
    const blocker = { ...lonely, x: 20 + 220 + qb.QB_BOX.gapX, y: 30 };
    const joins = [{ id: 'j1', leftTableId: 't1', rightTableId: 't2', type: 'INNER', pairs: [] }];
    const sizes = { t1: { width: 220, height: 80 }, t4: { width: 220, height: 50 }, t2: { width: 220, height: 50 } };
    const p = qb.placeMissing([placedOrders, blocker, customers], joins, sizes);
    assert.deepEqual(Object.keys(p), ['t2']);
    assert.equal(p.t2.x, blocker.x);
    assert.equal(p.t2.y, 30 + 50 + qb.QB_BOX.gapY);
});

test('placeMissing lays everything out when no table has a position yet, and returns nothing when all have one', () => {
    assert.deepEqual(Object.keys(qb.placeMissing([orders, customers], [], {})).sort(), ['t1', 't2']);
    assert.deepEqual(qb.placeMissing([{ ...orders, x: 0, y: 0 }], [], {}), {});
});

test('placeMissing puts a table without joins into a column right of every box', () => {
    const p = qb.placeMissing([{ ...orders, x: 400, y: 10 }, lonely], [], {});
    assert.equal(p.t4.x, 400 + qb.QB_BOX.width + qb.QB_BOX.gapX);
});

// ===== Join lines =====

test('rowAnchorY is the middle of the row and stays inside the scrolled column list', () => {
    const list = { top: 29, height: 100, scrollTop: 0 };
    assert.equal(qb.rowAnchorY(list, { top: 40, height: 20 }), 29 + 40 + 10);
    assert.equal(qb.rowAnchorY({ ...list, scrollTop: 200 }, { top: 40, height: 20 }), 29, 'a row scrolled out above sticks to the top');
    assert.equal(qb.rowAnchorY(list, { top: 400, height: 20 }), 129, 'a row below the visible part sticks to the bottom');
});

test('joinLineGeometry leaves each box on the edge facing the other', () => {
    const a = { x: 0, y: 0, width: 200, height: 100, anchorY: 40 };
    const b = { x: 400, y: 50, width: 200, height: 100, anchorY: 30 };
    const g = qb.joinLineGeometry(a, b);
    assert.deepEqual([g.fromSide, g.toSide], ['right', 'left']);
    assert.deepEqual(g.from, { x: 200, y: 40 });
    assert.deepEqual(g.to, { x: 400, y: 80 });
    assert.match(g.path, /^M 200 40 C .* 400 80$/);
    assert.deepEqual(g.mid, { x: 300, y: 60 });
    const back = qb.joinLineGeometry(b, a);
    assert.deepEqual([back.fromSide, back.toSide], ['left', 'right']);
});

test('joinLineGeometry joins boxes stacked above each other on their left edges', () => {
    const g = qb.joinLineGeometry({ x: 10, y: 0, width: 200, height: 80, anchorY: 40 }, { x: 60, y: 200, width: 200, height: 80, anchorY: 40 });
    assert.deepEqual([g.fromSide, g.toSide], ['left', 'left']);
    assert.equal(g.from.x, 10);
    assert.equal(g.to.x, 60);
});

test('outer joins are dashed and dotted at the end whose rows are all kept', () => {
    assert.equal(qb.joinLineClass('INNER'), 'qb-join-line');
    assert.equal(qb.joinLineClass('LEFT'), 'qb-join-line outer');
    assert.equal(qb.joinLineClass('CROSS'), 'qb-join-line cross');
    assert.deepEqual(qb.preservedEnds('LEFT'), { left: true, right: false });
    assert.deepEqual(qb.preservedEnds('RIGHT'), { left: false, right: true });
    assert.deepEqual(qb.preservedEnds('FULL'), { left: true, right: true });
});

test('the join dialog names the table whose rows an outer join keeps', () => {
    const choices = qb.joinTypeChoices('o', 'c');
    assert.deepEqual(choices.map((c: any) => c.type), qb.QB_JOIN_TYPES);
    assert.equal(choices.find((c: any) => c.type === 'LEFT').description, 'Include all rows from o');
    assert.equal(choices.find((c: any) => c.type === 'RIGHT').description, 'Include all rows from c');
});

// ===== Grid =====

test('criteriaColumnCount offers one empty criteria column more than are used, at least Criteria and one Or', () => {
    const col = (criteria: string[]) => ({ id: 'c', expression: 'x', output: true, groupBy: false, criteria });
    assert.equal(qb.criteriaColumnCount(model()), 2);
    assert.equal(qb.criteriaColumnCount(model({ columns: [col(['= 1'])] })), 2);
    assert.equal(qb.criteriaColumnCount(model({ columns: [col(['= 1', '', '= 3']), col([])] })), 4);
    assert.deepEqual([0, 1, 2].map(qb.criteriaHeader), ['Criteria', 'Or…', 'Or…']);
});

test('buildGridRows fills every criteria column and marks automatically grouped columns', () => {
    const m = model({
        tables: [orders],
        columns: [
            { id: 'c1', expression: 'o.customer_id', tableId: 't1', column: 'customer_id', output: true, groupBy: false, criteria: ['> 5'] },
            { id: 'c2', expression: 'o.total', tableId: 't1', column: 'total', output: true, groupBy: false, criteria: [], aggregate: 'SUM', alias: 'sum_total', sortType: 'DESC', sortOrder: 1, nulls: 'LAST' },
            { id: 'c3', expression: 'upper(o.note)', output: true, groupBy: true, criteria: [], having: '> 1' }
        ]
    });
    const rows = qb.buildGridRows(m);
    assert.deepEqual(rows.map((r: any) => r.groupBy), ['auto', 'off', 'on']);
    assert.deepEqual(rows[0].criteria, ['> 5', '']);
    assert.equal(rows[0].table, 'o');
    assert.equal(rows[2].table, '');
    assert.deepEqual([rows[1].aggregate, rows[1].alias, rows[1].sortType, rows[1].sortOrder, rows[1].nulls], ['SUM', 'sum_total', 'DESC', '1', 'LAST']);
    assert.deepEqual(rows.map((r: any) => [r.first, r.last]), [[true, false], [false, false], [false, true]]);
    const noAuto = qb.buildGridRows({ ...m, autoGroupBy: false });
    assert.equal(noAuto[0].groupBy, 'off');
});

test('reorderIndex drops a row before or after its target', () => {
    assert.equal(qb.reorderIndex(0, 2, true), 1);
    assert.equal(qb.reorderIndex(0, 2, false), 2);
    assert.equal(qb.reorderIndex(3, 1, true), 1);
    assert.equal(qb.reorderIndex(3, 1, false), 2);
    assert.equal(qb.reorderIndex(1, 1, true), 1);
});

// ===== Misc =====

test('sqlErrorText says where the error is when the host knows it', () => {
    assert.equal(qb.sqlErrorText({ ok: false, message: 'syntax error', line: 2, column: 7 }), 'Line 2, column 7: syntax error');
    assert.equal(qb.sqlErrorText({ ok: false, message: 'Only a SELECT statement can be edited' }), 'Only a SELECT statement can be edited');
});

test('isTypingTarget leaves the shortcuts to text fields but not to checkboxes', () => {
    assert.equal(qb.isTypingTarget({ tagName: 'INPUT', type: 'text' }), true);
    assert.equal(qb.isTypingTarget({ tagName: 'INPUT', type: 'checkbox' }), false);
    assert.equal(qb.isTypingTarget({ tagName: 'TEXTAREA' }), true);
    assert.equal(qb.isTypingTarget({ tagName: 'DIV' }), false);
    assert.equal(qb.isTypingTarget(null), false);
});

// ===== createSqlText =====

function sqlTab() {
    const page = { text: '', status: { ok: true } as any, posted: [] as any[], timer: undefined as undefined | (() => void) };
    const sqlText = qb.createSqlText({
        getText: () => page.text,
        setText: (t: string) => { page.text = t; },
        post: (m: unknown) => page.posted.push(m),
        setTimer: (fn: () => void) => { page.timer = fn; return 1; },
        clearTimer: () => { page.timer = undefined; },
        showStatus: (s: unknown) => { page.status = s; }
    });
    return { page, sqlText };
}

test('createSqlText keeps the SQL the builder could not read, with its error, when the SQL tab is shown for it', () => {
    const { page, sqlText } = sqlTab();
    sqlText.state({ origin: 'init', sql: 'SELECT\n    *', sqlError: false }, false);
    assert.equal(sqlText.status({ command: 'sqlStatus', seq: 0, ok: false, sql: 'SELECT :col FROM t', message: 'syntax error' }), true);
    sqlText.shown();
    assert.equal(page.text, 'SELECT :col FROM t');
    assert.equal(page.status.ok, false);
    assert.equal(sqlText.hasError, true);
});

test('createSqlText leaves a text the host could not read alone until a state says it was replaced', () => {
    const { page, sqlText } = sqlTab();
    sqlText.status({ command: 'sqlStatus', seq: 0, ok: false, sql: 'SELECT :col FROM t', message: 'syntax error' });
    sqlText.state({ origin: 'init', sql: 'SELECT\n    *', sqlError: true }, true);
    sqlText.state({ origin: 'history', sql: 'SELECT\n    *', sqlError: true }, false);
    sqlText.shown();
    assert.equal(page.text, 'SELECT :col FROM t');
    assert.equal(page.status.ok, false);
    sqlText.state({ origin: 'addTable', sql: 'SELECT\n    *\nFROM\n    t', sqlError: false }, true);
    assert.equal(page.text, 'SELECT\n    *\nFROM\n    t');
    assert.equal(page.status.ok, true);
});

test('createSqlText sends typed SQL after the pause and only takes the answer to the last edit', () => {
    const { page, sqlText } = sqlTab();
    page.text = 'SELECT 1';
    sqlText.input();
    page.timer?.();
    page.text = 'SELECT 2 FROM';
    sqlText.input();
    sqlText.flush();
    assert.deepEqual(page.posted, [{ command: 'sqlEdited', sql: 'SELECT 1', seq: 1 }, { command: 'sqlEdited', sql: 'SELECT 2 FROM', seq: 2 }]);
    assert.equal(sqlText.status({ command: 'sqlStatus', seq: 1, ok: false, message: 'old' }), false);
    assert.equal(page.status.ok, true, 'a stale answer is ignored');
    sqlText.status({ command: 'sqlStatus', seq: 2, ok: false, message: 'syntax error' });
    sqlText.state({ origin: 'sql', sql: 'SELECT 1', sqlError: true }, true);
    assert.equal(page.text, 'SELECT 2 FROM');
    assert.equal(page.status.message, 'syntax error');
});
