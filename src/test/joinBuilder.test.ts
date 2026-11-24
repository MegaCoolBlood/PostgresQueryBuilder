import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const jb = require(path.join(__dirname, '../../../src/webview/joinBuilder.js'));

/** Two tables joined on a foreign key, all columns selected. */
function sampleState(): any {
    return {
        distinct: false,
        selectItems: [
            { kind: 'column', tableIndex: 0, column: 'id' },
            { kind: 'column', tableIndex: 0, column: 'name' },
            { kind: 'column', tableIndex: 1, column: 'total' }
        ],
        tables: [
            { schema: 'public', table: 'customers', tableReference: 'customers', alias: 'c', savedAlias: 'c', columns: ['id', 'name'] },
            { schema: 'public', table: 'orders', tableReference: 'orders', alias: 'o', columns: ['id', 'customer_id', 'total'] }
        ],
        joins: [{ type: 'LEFT JOIN', conditions: [{ leftAlias: 'c', leftColumn: 'id', rightColumn: 'customer_id' }] }],
        where: [],
        orderBy: [],
        carried: {}
    };
}

// ===== createModel / stateFromModel =====

test('a state survives the round trip through the model', () => {
    const state = sampleState();
    state.where = [
        { kind: 'compare', left: 'o.total', operator: 'BETWEEN', right: '$1 AND :max' },
        { kind: 'compare', left: 'c.name', operator: 'IS NULL', right: '' },
        { kind: 'raw', text: "c.name LIKE 'A%'" }
    ];
    state.orderBy = [{ expr: 'c.name', column: { tableIndex: 0, column: 'name' }, direction: 'DESC', nulls: 'LAST' }, { expr: 'random()' }];
    state.selectItems.push({ kind: 'expr', text: 'count(*)', alias: 'n' });
    state.distinct = true;
    state.distinctOn = 'c.id';
    state.carried = { groupBy: 'c.id', limit: '10' };
    const model = jb.createModel(state);
    assert.deepEqual(model.where[0].right2, { kind: 'raw', text: ':max' }, 'BETWEEN is edited as two bounds');
    assert.deepEqual(model.where[0].left, { kind: 'column', orig: 1, column: 'total' }, 'a column operand is recognised');
    const out = jb.stateFromModel(model);
    assert.deepEqual(out, {
        ...state,
        joins: [{ ...state.joins[0], literalConditions: [], rawConditions: [] }]
    });
});

test('raw ON conditions come back as text and a raw FROM item keeps its text', () => {
    const state = sampleState();
    state.tables.push({ schema: '', table: '', tableReference: '', alias: 's', columns: [], raw: '(SELECT 1 AS x) s' });
    state.joins.push({ type: 'INNER JOIN', conditions: [], rawConditions: ['s.x = o.id'] });
    const model = jb.createModel(state);
    assert.equal(jb.setTableAlias(model, 2, 't'), false, 'the alias of a raw item is part of its text');
    const out = jb.stateFromModel(model);
    assert.equal(out.tables[2].raw, '(SELECT 1 AS x) s');
    assert.equal('savedAlias' in out.tables[2], false);
    assert.deepEqual(out.joins[1].rawConditions, ['s.x = o.id']);
});

test('a join condition naming an unknown alias is kept as a text condition', () => {
    const state = sampleState();
    state.joins[0].conditions = [{ leftAlias: 'x', leftColumn: 'id', rightColumn: 'customer_id' }];
    const out = jb.stateFromModel(jb.createModel(state));
    assert.deepEqual(out.joins[0].conditions, []);
    assert.deepEqual(out.joins[0].rawConditions, ['o.customer_id = x.id']);
});

test('a table without alias is referred to by its table name', () => {
    const state = sampleState();
    state.tables[0] = { ...state.tables[0], alias: '', tableReference: 'public.customers' };
    state.joins[0].conditions[0].leftAlias = 'customers';
    state.where = [{ kind: 'compare', left: 'customers.name', operator: '=', right: "'x'" }];
    const model = jb.createModel(state);
    assert.deepEqual(model.joins[1].conditions, [{ leftOrig: 0, leftColumn: 'id', rightColumn: 'customer_id' }]);
    assert.deepEqual(model.where[0].left, { kind: 'column', orig: 0, column: 'name' });
    const out = jb.stateFromModel(model);
    assert.equal(out.joins[0].conditions[0].leftAlias, 'customers');
    assert.equal(out.where[0].left, 'customers.name');
});

test('a CROSS JOIN hands out no conditions but keeps them for another join type', () => {
    const model = jb.createModel(sampleState());
    model.typeByOrig[1] = model.joins[1].type = 'CROSS JOIN';
    assert.deepEqual(jb.stateFromModel(model).joins[0].conditions, []);
    model.typeByOrig[1] = model.joins[1].type = 'LEFT JOIN';
    assert.equal(jb.stateFromModel(model).joins[0].conditions.length, 1);
});

// ===== moveTable / removeTableAt =====

test('the state the builder hands out means the same SQL to the host and to the Data Viewer', () => {
    const { buildBuilderSql } = require('../statementBuilder');
    const { builderStateToSql } = require(path.join(__dirname, '../../../src/webview/tableView.js'));
    const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
    const model = jb.createModel(sampleState());
    jb.addWhereRow(model, false);
    model.where[0].right = { kind: 'raw', text: '$1' };
    jb.applyOperator(model.where[0], 'BETWEEN');
    model.where[0].right2 = { kind: 'raw', text: '$2' };
    jb.addWhereRow(model, true);
    model.where[1].text = 'c.name IS NULL OR o.total > 0';
    jb.addOrderByItem(model);
    jb.moveTable(model, 1, 0);
    const state = jb.stateFromModel(model);
    // A renamed column (the select list's alias field) keeps its alias on both sides.
    state.selectItems[0].alias = 'customer_id';
    const sql = normalize(buildBuilderSql(state, { semicolon: false }));
    assert.equal(sql, normalize(builderStateToSql(state)));
    assert.match(sql, /^SELECT c\.id AS customer_id, /);
    assert.match(sql, /WHERE c\.id BETWEEN \$1 AND \$2 AND \(c\.name IS NULL OR o\.total > 0\) ORDER BY c\.id$/);
});

test('moving the joined table into FROM re-attaches the join condition to the other table', () => {
    const model = jb.createModel(sampleState());
    assert.equal(jb.moveTable(model, 1, 0), true);
    const out = jb.stateFromModel(model);
    assert.deepEqual(out.tables.map((t: any) => t.alias), ['o', 'c']);
    assert.deepEqual(out.joins[0].conditions, [{ leftAlias: 'o', leftColumn: 'customer_id', rightColumn: 'id' }]);
    // Select items keep pointing at the same tables, now at other positions.
    assert.deepEqual(out.selectItems.map((s: any) => [s.tableIndex, s.column]), [[1, 'id'], [1, 'name'], [0, 'total']]);
});

test('moving a table back restores the original join', () => {
    const model = jb.createModel(sampleState());
    jb.moveTable(model, 1, 0);
    jb.moveTable(model, 1, 0);
    const out = jb.stateFromModel(model);
    assert.deepEqual(out.joins[0].conditions, [{ leftAlias: 'c', leftColumn: 'id', rightColumn: 'customer_id' }]);
    assert.equal(out.joins[0].type, 'LEFT JOIN');
});

test('a fixed condition follows its table out of the FROM slot instead of getting lost', () => {
    const state = sampleState();
    state.tables.push({ schema: 'public', table: 'items', tableReference: 'items', alias: 'i', columns: ['order_id'] });
    state.joins.push({ type: 'INNER JOIN', conditions: [{ leftAlias: 'o', leftColumn: 'id', rightColumn: 'order_id' }], rawConditions: ['i.order_id > 0'] });
    const model = jb.createModel(state);
    jb.addFixedCondition(model, 1);
    jb.moveTable(model, 1, 0);
    let out = jb.stateFromModel(model);
    assert.deepEqual(out.tables.map((t: any) => t.alias), ['o', 'c', 'i']);
    assert.deepEqual(out.joins[0].rawConditions, [], 'an incomplete fixed condition is not emitted');
    assert.equal(model.customByOrig[0].length, 1, 'the fixed condition moved to the table now joined second');
    jb.moveTable(model, 2, 0);
    out = jb.stateFromModel(model);
    assert.deepEqual(out.tables.map((t: any) => t.alias), ['i', 'o', 'c']);
    assert.deepEqual(out.joins[0].rawConditions, ['i.order_id > 0']);
});

test('removing a table drops everything that refers to it', () => {
    const state = sampleState();
    state.where = [
        { kind: 'compare', left: { kind: 'column', tableIndex: 1, column: 'total' }, operator: '>', right: { kind: 'raw', text: '0' } },
        { kind: 'compare', left: { kind: 'column', tableIndex: 0, column: 'id' }, operator: 'IS NULL' }
    ];
    state.orderBy = [{ expr: 'o.total', column: { tableIndex: 1, column: 'total' } }];
    const model = jb.createModel(state);
    const removed = jb.removeTableAt(model, 1);
    assert.equal(removed.table, 'orders');
    const out = jb.stateFromModel(model);
    assert.deepEqual(out.tables.map((t: any) => t.alias), ['c']);
    assert.deepEqual(out.joins, []);
    assert.deepEqual(out.selectItems.map((s: any) => s.column), ['id', 'name']);
    assert.deepEqual(out.where, [{ kind: 'compare', left: 'c.id', operator: 'IS NULL', right: '' }]);
    assert.deepEqual(out.orderBy, []);
});

test('the last table cannot be removed', () => {
    const model = jb.createModel({ ...sampleState(), tables: [sampleState().tables[0]], joins: [] });
    assert.equal(jb.removeTableAt(model, 0), null);
});

// Moves and removals checked on the SQL both builders write.
const { readBuilderState: readQuery, builderStateToSql: writeQuery } = require(path.join(__dirname, '../../../src/webview/tableView.js'));
const modelOf = (sql: string) => jb.createModel(readQuery(sql));
const sqlOf = (model: any) => writeQuery(jb.stateFromModel(model));

test('a CROSS JOIN handed a join condition by a move becomes an INNER JOIN', () => {
    const model = modelOf('SELECT * FROM a CROSS JOIN b JOIN c ON c.b_id = b.id');
    assert.equal(jb.moveTable(model, 1, 2), true);
    assert.equal(sqlOf(model), 'SELECT * FROM a INNER JOIN c ON TRUE INNER JOIN b ON b.id = c.b_id');
});

test('a CROSS JOIN handed a fixed condition by a move becomes an INNER JOIN', () => {
    const model = modelOf('SELECT * FROM a CROSS JOIN b JOIN c ON TRUE');
    model.customByOrig[2].push({ operator: '=', left: { kind: 'column', orig: 2, column: 'k' }, right: { kind: 'column', orig: 1, column: 'k' } });
    assert.equal(jb.moveTable(model, 1, 2), true);
    assert.equal(sqlOf(model), 'SELECT * FROM a INNER JOIN c ON TRUE INNER JOIN b ON c.k = b.k');
});

test('a text ON condition moves to the join of the latest table it names', () => {
    const model = modelOf('SELECT * FROM a JOIN b ON b.a_id = a.id AND b.v <= a.d JOIN c ON c.b_id = b.id');
    assert.equal(jb.moveTable(model, 0, 2), true);
    assert.equal(sqlOf(model), 'SELECT * FROM b INNER JOIN c ON c.b_id = b.id INNER JOIN a ON a.id = b.a_id AND b.v <= a.d');
    // Names in strings and comments do not count.
    const quoted = modelOf(`SELECT * FROM a JOIN b ON b.a_id = a.id JOIN "A" ON "A".id = b.id AND "A".d > /* a.y */ length('a.x') JOIN c ON c.b_id = b.id`);
    assert.equal(jb.moveTable(quoted, 0, 3), true);
    assert.equal(sqlOf(quoted), `SELECT * FROM b INNER JOIN "A" ON "A".id = b.id AND "A".d > /* a.y */ length('a.x') `
        + 'INNER JOIN c ON c.b_id = b.id INNER JOIN a ON a.id = b.a_id');
});

test('removing a table drops the text conditions that name it', () => {
    const model = modelOf('SELECT * FROM a JOIN b ON b.id = a.id JOIN c ON c.x = a.x AND c.y > b.y WHERE B.flag OR a.z = 1');
    assert.ok(jb.removeTableAt(model, 1));
    assert.equal(sqlOf(model), 'SELECT * FROM a INNER JOIN c ON c.x = a.x');
});

test('no table moves across a NATURAL or USING join, nor is one before it removed', () => {
    const model = modelOf('SELECT * FROM a NATURAL JOIN b JOIN c ON c.id = b.id');
    assert.equal(jb.moveTable(model, 0, 2), false);
    assert.equal(jb.moveTable(model, 1, 0), false);
    assert.match(jb.moveBlockReason(model, 0, 1), /^b is joined with NATURAL, which matches columns of the tables before it/);
    assert.equal(sqlOf(model), 'SELECT * FROM a NATURAL INNER JOIN b INNER JOIN c ON c.id = b.id');

    const using = modelOf('SELECT * FROM a JOIN d ON d.id = a.id JOIN b USING (k) JOIN c ON c.id = b.id JOIN e ON e.id = c.id');
    assert.equal(jb.moveTable(using, 0, 1), true, 'tables on one side of it still move');
    assert.equal(jb.moveTable(using, 3, 4), true);
    assert.equal(jb.removeTableAt(using, 0), null);
    assert.match(jb.removeBlockReason(using, 1), /USING/);
    assert.ok(jb.removeTableAt(using, 4), 'a table after it can go');
    assert.ok(jb.removeTableAt(using, 2), 'and so can the join itself');
    assert.equal(sqlOf(using), 'SELECT * FROM d INNER JOIN a ON a.id = d.id INNER JOIN e ON TRUE');

    const first = modelOf('SELECT * FROM a NATURAL JOIN b JOIN c ON c.id = b.id');
    assert.ok(jb.removeTableAt(first, 0), 'its only partner can go: the join turns into the FROM item');
    assert.equal(sqlOf(first), 'SELECT * FROM b INNER JOIN c ON c.id = b.id');
});

test('a NATURAL join takes no further conditions', () => {
    const model = modelOf('SELECT * FROM a NATURAL LEFT JOIN b');
    model.tables[0].columns = ['id'];
    model.tables[1].columns = ['id'];
    assert.equal(jb.addJoinCondition(model, 1), false);
    assert.equal(jb.addFixedCondition(model, 1), false);
    assert.equal(sqlOf(model), 'SELECT * FROM a NATURAL LEFT JOIN b');
});

test('a renamed alias is used by every reference to the table', () => {
    const state = sampleState();
    state.orderBy = [{ expr: 'c.name', column: { tableIndex: 0, column: 'name' } }];
    const model = jb.createModel(state);
    assert.equal(jb.setTableAlias(model, 0, '  cu '), true);
    assert.equal(jb.setTableAlias(model, 0, '   '), false);
    const out = jb.stateFromModel(model);
    assert.equal(out.tables[0].alias, 'cu');
    assert.equal(out.joins[0].conditions[0].leftAlias, 'cu');
    assert.equal(out.orderBy[0].expr, 'cu.name');
});

// ===== Column selection =====

test('ticking a column appends it to the SELECT list and unticking removes it', () => {
    const model = jb.createModel(sampleState());
    jb.toggleColumn(model, 1, 'id', true);
    jb.toggleColumn(model, 1, 'id', true);
    jb.toggleColumn(model, 0, 'name', false);
    const out = jb.stateFromModel(model);
    assert.deepEqual(out.selectItems.map((s: any) => [s.tableIndex, s.column]), [[0, 'id'], [1, 'total'], [1, 'id']]);
    assert.equal(jb.isColumnSelected(model, 0, 'name'), false);
});

test('All and None select every column of a table or none of them', () => {
    const model = jb.createModel(sampleState());
    jb.setAllColumns(model, 1, true);
    assert.deepEqual(jb.stateFromModel(model).selectItems.filter((s: any) => s.tableIndex === 1).map((s: any) => s.column), ['total', 'id', 'customer_id']);
    jb.setAllColumns(model, 0, false);
    assert.equal(jb.stateFromModel(model).selectItems.some((s: any) => s.tableIndex === 0), false);
});

test('a table without known columns is selected as a whole', () => {
    const state = sampleState();
    state.tables.push({ schema: '', table: '', tableReference: '', alias: 'g', columns: [], raw: 'generate_series(1, 3)' });
    const model = jb.createModel(state);
    jb.setAllColumns(model, 2, true);
    assert.deepEqual(jb.stateFromModel(model).selectItems.at(-1), { kind: 'column', tableIndex: 2, column: '*' });
});

test('select items, WHERE rows and ORDER BY items can be added, moved and removed', () => {
    const model = jb.createModel(sampleState());
    jb.addSelectExpression(model, 'now()');
    assert.equal(jb.moveItem(model.selectItems, 3, -1), true);
    assert.equal(jb.moveItem(model.selectItems, 0, -1), false);
    jb.addWhereRow(model, false);
    jb.addWhereRow(model, true);
    jb.addOrderByItem(model);
    jb.addOrderByItem(model);
    assert.equal(jb.removeItem(model.orderBy, 1), true);
    const out = jb.stateFromModel(model);
    assert.deepEqual(out.selectItems[2], { kind: 'expr', text: 'now()' });
    assert.deepEqual(out.where, [
        { kind: 'compare', left: 'c.id', operator: '=', right: '' },
        { kind: 'raw', text: '' }
    ]);
    assert.deepEqual(out.orderBy, [{ expr: 'c.id', column: { tableIndex: 0, column: 'id' } }]);
});

test('changing an operator adds or drops the right operands it needs', () => {
    const c: any = { operator: '=', left: { kind: 'raw', text: 'a' }, right: { kind: 'raw', text: 'b' } };
    jb.applyOperator(c, 'BETWEEN');
    assert.deepEqual(c.right2, { kind: 'raw', text: '' });
    jb.applyOperator(c, 'IS NULL');
    assert.equal('right' in c || 'right2' in c, false);
    jb.applyOperator(c, '<>');
    assert.deepEqual(c.right, { kind: 'raw', text: '' });
    assert.equal('right2' in c, false);
});

// ===== addTablesToModel =====

test('an added table gets a unique alias, joins over its foreign key and has its columns selected', () => {
    const model = jb.createModel(sampleState());
    const added = jb.addTablesToModel(model, {
        tables: [{ schema: 'public', table: 'items', tableReference: 'items', alias: 'o', columns: ['order_id', 'qty'] }],
        fkEdges: [{ fromSchema: 'public', fromTable: 'items', fromColumn: 'order_id', toSchema: 'public', toTable: 'orders', toColumn: 'id' }]
    }, true);
    assert.deepEqual(added, [2]);
    const out = jb.stateFromModel(model);
    assert.equal(out.tables[2].alias, 'o2');
    assert.deepEqual(out.joins[1], {
        type: 'INNER JOIN',
        conditions: [{ leftAlias: 'o', leftColumn: 'id', rightColumn: 'order_id' }],
        literalConditions: [],
        rawConditions: []
    });
    assert.deepEqual(out.selectItems.slice(3).map((s: any) => s.column), ['order_id', 'qty']);
});

test('a custom-mapping condition becomes an editable fixed condition', () => {
    const state = sampleState();
    state.joins[0].literalConditions = [{ literalAlias: 'o', literalColumn: 'total', operator: '>', value: '5' }];
    const model = jb.createModel(state);
    assert.equal(jb.promoteLiteral(model, 1, 0), true);
    const out = jb.stateFromModel(model);
    assert.deepEqual(out.joins[0].literalConditions, []);
    assert.deepEqual(out.joins[0].rawConditions, ['o.total > 5']);
});

// ===== createJoinBuilder =====

/** Just enough DOM for the component: one root element and delegated events. */
function mountBuilder(state: any, options: any = {}) {
    const listeners: Record<string, Array<(e: any) => void>> = {};
    const rootEl: any = {
        className: '',
        innerHTML: '',
        addEventListener: (type: string, fn: (e: any) => void) => { (listeners[type] ||= []).push(fn); },
        removeEventListener: () => {},
        remove: () => {},
        contains: () => true,
        querySelector: () => null,
        querySelectorAll: () => []
    };
    const g = globalThis as any;
    const previous = g.document;
    g.document = { createElement: () => rootEl };
    const posted: any[] = [];
    const changes: any[] = [];
    try {
        const api = jb.createJoinBuilder({ appendChild: () => {} }, state, {
            post: (m: any) => posted.push(m),
            onChange: (s: any) => changes.push(s),
            ...options
        });
        const fire = (type: string, el: any) => (listeners[type] || []).forEach(fn =>
            fn({ target: { closest: () => el }, button: 0, detail: 0, preventDefault() {}, stopPropagation() {} }));
        return { api, rootEl, posted, changes, fire };
    } finally {
        g.document = previous;
    }
}

const el = (jbAction: string, data: Record<string, string> = {}, extra: Record<string, any> = {}) =>
    ({ dataset: { jb: jbAction, ...data }, disabled: false, ...extra });

test('the builder escapes every table, column and expression it shows', () => {
    const state = sampleState();
    state.tables[1].columns.push('"<img src=x>"');
    state.selectItems.push({ kind: 'expr', text: '\'"><script>' });
    const { rootEl } = mountBuilder(state);
    assert.ok(rootEl.innerHTML.includes('&quot;&lt;img src=x&gt;&quot;'));
    assert.ok(!rootEl.innerHTML.includes('<img'));
    assert.ok(!rootEl.innerHTML.includes('<script>'));
    assert.ok(!/\son[a-z]+=/.test(rootEl.innerHTML), 'no inline event handler');
});

test('the builder reports user changes and asks the host for tables', () => {
    const { posted, changes, fire, api } = mountBuilder(sampleState());
    fire('change', el('col', { o: '0', c: 'name' }, { checked: false }));
    assert.deepEqual(changes.at(-1).selectItems.map((s: any) => s.column), ['id', 'total']);
    fire('click', el('add-tables'));
    assert.deepEqual(posted, [{ command: 'requestAddTables' }]);
    fire('click', el('remove-table', { o: '1' }));
    assert.deepEqual(posted.at(-1), { command: 'tableRemoved', schema: 'public', table: 'orders' });
    assert.equal(changes.at(-1).tables.length, 1);
    api.setState(sampleState());
    assert.equal(api.getState().tables.length, 2);
    assert.equal(changes.length, 2, 'setState does not report a change');
});

test('the builder shows the carried clauses read-only', () => {
    const state = sampleState();
    state.carried = { groupBy: 'c.id', having: 'count(*) > 1', locking: 'FOR UPDATE' };
    const { rootEl } = mountBuilder(state);
    assert.match(rootEl.innerHTML, /GROUP BY c\.id/);
    assert.match(rootEl.innerHTML, /HAVING count\(\*\) &gt; 1/);
    assert.match(rootEl.innerHTML, />FOR UPDATE</);
});

test('an operator the list lacks is shown as it is, not as =', () => {
    const state = sampleState();
    state.where = [
        { kind: 'compare', left: 'c.name', operator: '!=', right: "'x'" },
        { kind: 'compare', left: 'c.name', operator: 'NOT ILIKE', right: "'a%'" }
    ];
    const { rootEl } = mountBuilder(state);
    const selected = [...rootEl.innerHTML.matchAll(/<option selected>([^<]*)<\/option>/g)].map((m: any) => m[1]);
    assert.ok(selected.includes('!='));
    assert.ok(selected.includes('NOT ILIKE'));
    assert.ok(!selected.includes('='));
});

test('the move and remove buttons say why a NATURAL join keeps the tables in place', () => {
    const state = sampleState();
    state.joins[0] = { type: 'INNER JOIN', conditions: [], rawConditions: ['NATURAL'] };
    state.tables.push({ schema: 'public', table: 'items', tableReference: 'items', alias: 'i', columns: ['order_id'] });
    state.joins.push({ type: 'INNER JOIN', conditions: [{ leftAlias: 'o', leftColumn: 'id', rightColumn: 'order_id' }] });
    const { rootEl } = mountBuilder(state);
    const html: string = rootEl.innerHTML;
    assert.match(html, /data-jb="down" data-o="0" title="o is joined with NATURAL[^"]*" disabled/);
    assert.match(html, /data-jb="up" data-o="1" title="o is joined with NATURAL[^"]*" disabled/);
    assert.match(html, /data-jb="down" data-o="1" title="o is joined with NATURAL[^"]*" disabled/);
    assert.match(html, /data-jb="add-fixed" data-o="1" title="NATURAL joins take no further conditions" disabled/);
    assert.match(html, /data-jb="remove-table" data-o="1" title="Remove table from the query">/);
    assert.match(html, /data-jb="down" data-o="2" title="Move down" disabled/);
});

test('the builder offers no ORDER BY of its own for a UNION query', () => {
    const state = sampleState();
    state.carried = { setOps: 'UNION ALL SELECT 1, 2, 3 ORDER BY 1' };
    const { rootEl } = mountBuilder(state);
    assert.match(rootEl.innerHTML, /A UNION query is sorted after its last part — edit the ORDER BY in the query bar\./);
    assert.ok(!rootEl.innerHTML.includes('data-jb="add-order"'));
});
