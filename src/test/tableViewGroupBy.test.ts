import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const {
    aggregatesFor,
    groupingRewrite,
    groupByColumn,
    aggregateColumn,
    removeGrouping,
    selectListExpressions,
    columnFilterTarget
} = require(path.join(__dirname, '../../../src/webview/tableView.js'));

const JS = fs.readFileSync(path.join(__dirname, '../../../src/webview/tableView.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '../../../src/webview/tableView.css'), 'utf8');

// ===== groupByColumn =====

test('groupByColumn keeps the column, groups by it and adds count(*) when there is no aggregate', () => {
    assert.equal(
        groupByColumn('SELECT id, dept, salary FROM emp', 'dept', ['id', 'dept', 'salary']),
        'SELECT dept, count(*) AS count FROM emp GROUP BY dept'
    );
});

test('groupByColumn groups an aliased, qualified column by its expression and keeps WHERE, ORDER BY and LIMIT in place', () => {
    assert.equal(
        groupByColumn('SELECT e.id, e.dept AS d FROM emp e WHERE e.salary > 10 ORDER BY d LIMIT 5', 'd', ['id', 'd']),
        'SELECT e.dept AS d, count(*) AS count FROM emp e WHERE e.salary > 10 GROUP BY e.dept ORDER BY d LIMIT 5'
    );
});

test('groupByColumn spells out SELECT * into the result columns', () => {
    assert.equal(
        groupByColumn('SELECT * FROM emp', 'dept', ['id', 'dept', 'salary']),
        'SELECT dept, count(*) AS count FROM emp GROUP BY dept'
    );
    assert.equal(
        groupByColumn('SELECT * FROM a JOIN b ON b.id = a.b_id', 'id', [
            { name: 'id', qualifier: 'a', sourceColumn: 'id' },
            { name: 'title' },
            { name: 'id', qualifier: 'b', sourceColumn: 'id' }
        ]),
        null,
        'a column name that occurs twice is ambiguous'
    );
});

test('groupByColumn extends an existing GROUP BY without duplicates and keeps HAVING', () => {
    const sql = 'SELECT dept, city, count(*) AS n FROM emp GROUP BY dept HAVING count(*) > 1';
    const cols = ['dept', 'city', 'n'];
    assert.equal(groupByColumn(sql, 'city', cols), 'SELECT dept, city, count(*) AS n FROM emp GROUP BY dept, city HAVING count(*) > 1');
    assert.equal(groupByColumn(sql, 'dept', cols), 'SELECT dept, count(*) AS n FROM emp GROUP BY dept HAVING count(*) > 1');
    assert.equal(
        groupByColumn('SELECT "Dept", count(*) AS n FROM emp GROUP BY  "Dept"', 'Dept', ['Dept', 'n']),
        'SELECT "Dept", count(*) AS n FROM emp GROUP BY "Dept"'
    );
});

test('groupByColumn quotes the added name with the given formatter and keeps it unique', () => {
    const quoteAll = (name: string) => `"${name}"`;
    assert.equal(
        groupByColumn('SELECT dept, total AS count FROM emp', 'dept', ['dept', 'count'], { formatIdent: quoteAll }),
        'SELECT dept, count(*) AS "count" FROM emp GROUP BY dept'
    );
    assert.equal(
        groupByColumn('SELECT dept, total AS count FROM emp GROUP BY dept, total', 'dept', ['dept', 'count']),
        'SELECT dept, total AS count, count(*) AS count_2 FROM emp GROUP BY dept, total'
    );
});

test('groupByColumn refuses an aggregated or constant column', () => {
    assert.equal(groupByColumn('SELECT dept, count(*) AS n FROM emp GROUP BY dept', 'n', ['dept', 'n']), null);
    assert.equal(groupByColumn("SELECT dept, 'x' AS tag FROM emp", 'tag', ['dept', 'tag']), null);
});

// ===== aggregateColumn =====

test('aggregateColumn wraps the column under its output name and groups by every other column', () => {
    assert.equal(
        aggregateColumn('SELECT t.dept, t.amount FROM t WHERE x > 1 ORDER BY t.dept', 'amount', 'sum', ['dept', 'amount']),
        'SELECT t.dept, sum(t.amount) AS amount FROM t WHERE x > 1 GROUP BY t.dept ORDER BY t.dept'
    );
    assert.equal(
        aggregateColumn('SELECT region AS r, price * qty AS total FROM sales', 'total', 'avg', ['r', 'total']),
        'SELECT region AS r, avg(price * qty) AS total FROM sales GROUP BY region'
    );
});

test('aggregateColumn spells out a qualified * and leaves constants out of GROUP BY', () => {
    assert.equal(
        aggregateColumn('SELECT a.*, b.name AS bn FROM a JOIN b ON b.id = a.b_id', 'x', 'max', ['id', 'x', 'bn']),
        'SELECT a.id, max(a.x) AS x, b.name AS bn FROM a JOIN b ON b.id = a.b_id GROUP BY a.id, b.name'
    );
    assert.equal(
        aggregateColumn("SELECT dept, 'lit' AS l, amount FROM t", 'amount', 'sum', ['dept', 'l', 'amount']),
        "SELECT dept, 'lit' AS l, sum(amount) AS amount FROM t GROUP BY dept"
    );
});

test('aggregateColumn resolves GROUP BY positions and drops the aggregated column from GROUP BY', () => {
    assert.equal(
        aggregateColumn('SELECT dept, amount FROM t GROUP BY 1, 2', 'amount', 'sum', ['dept', 'amount']),
        'SELECT dept, sum(amount) AS amount FROM t GROUP BY dept'
    );
});

test('aggregateColumn swaps the aggregate it added before and refuses a hand-written one', () => {
    assert.equal(
        aggregateColumn('SELECT dept, sum(amount) AS amount FROM t GROUP BY dept', 'amount', 'max', ['dept', 'amount']),
        'SELECT dept, max(amount) AS amount FROM t GROUP BY dept'
    );
    assert.equal(aggregateColumn('SELECT dept, count(*) AS n FROM t GROUP BY dept', 'n', 'sum', ['dept', 'n']), null);
    assert.equal(aggregateColumn('SELECT a FROM t', 'a', 'median', ['a']), null);
});

test('an aggregated column is filtered in HAVING afterwards', () => {
    const sql = aggregateColumn('SELECT dept, amount FROM t', 'amount', 'sum', ['dept', 'amount']);
    const target = columnFilterTarget('amount', undefined, selectListExpressions(sql), (n: string) => n);
    assert.equal(target.clause, 'having');
    assert.equal(target.reference, '(sum(amount))');
});

// ===== aggregatesFor =====

test('aggregatesFor offers sum and avg only for numbers and min/max only for ordered types', () => {
    const all = ['count', 'sum', 'avg', 'min', 'max'];
    assert.deepEqual(aggregatesFor('int4'), all);
    assert.deepEqual(aggregatesFor('numeric(10,2)'), all);
    assert.deepEqual(aggregatesFor('double precision'), all);
    assert.deepEqual(aggregatesFor('interval'), all);
    assert.deepEqual(aggregatesFor('money'), ['count', 'sum', 'min', 'max']);
    assert.deepEqual(aggregatesFor('character varying(20)'), ['count', 'min', 'max']);
    assert.deepEqual(aggregatesFor('timestamp(3) with time zone'), ['count', 'min', 'max']);
    assert.deepEqual(aggregatesFor('_int4'), ['count', 'min', 'max']);
    assert.deepEqual(aggregatesFor('bool'), ['count']);
    assert.deepEqual(aggregatesFor('jsonb'), ['count']);
    assert.deepEqual(aggregatesFor(''), ['count']);
});

// ===== removeGrouping =====

test('removeGrouping undoes an aggregate round trip and drops HAVING', () => {
    const original = 'SELECT t.dept, t.amount FROM t WHERE x > 1 ORDER BY t.dept';
    const grouped = aggregateColumn(original, 'amount', 'sum', ['dept', 'amount']);
    assert.equal(removeGrouping(grouped), original);
    assert.equal(
        removeGrouping('SELECT d, avg(price * qty) AS total FROM s GROUP BY d HAVING avg(price * qty) > 5'),
        'SELECT d, price * qty AS total FROM s'
    );
});

test('removeGrouping drops the added count(*) but keeps other hand-written aggregates', () => {
    assert.equal(removeGrouping('SELECT dept, count(*) AS count FROM emp GROUP BY dept'), 'SELECT dept FROM emp');
    assert.equal(
        removeGrouping('SELECT dept, string_agg(name, \', \') AS names FROM emp GROUP BY dept'),
        'SELECT dept, string_agg(name, \', \') AS names FROM emp'
    );
    assert.equal(removeGrouping('SELECT count(*) AS n FROM emp'), null);
    assert.equal(removeGrouping('SELECT a FROM t'), null);
});

// ===== unsupported queries =====

test('queries the rewrites cannot handle safely give null and a reason', () => {
    const cases: Array<[string, string[]]> = [
        ['SELECT a FROM t UNION SELECT a FROM u', ['a']],
        ['SELECT a, row_number() OVER () AS rn FROM t', ['a', 'rn']],
        ['SELECT a, unnest(tags) AS tag FROM t', ['a', 'tag']],
        ['SELECT DISTINCT ON (a) a, b FROM t', ['a', 'b']],
        ['SELECT a INTO x FROM t', ['a']],
        ['SELECT a FROM t FOR UPDATE', ['a']],
        ['SELECT *, * FROM t', ['a', 'a']],
        ['UPDATE t SET a = 1', ['a']]
    ];
    for (const [sql, cols] of cases) {
        assert.equal(groupByColumn(sql, 'a', cols), null, sql);
        const result = groupingRewrite(sql, { action: 'group', column: 'a' }, cols);
        assert.equal(typeof result.error, 'string', sql);
    }
    assert.equal(groupByColumn('SELECT a FROM t', 'missing', ['a']), null);
});

test('a WITH query is grouped in its outer SELECT', () => {
    assert.equal(
        groupByColumn('WITH x AS (SELECT * FROM t WHERE a > 1) SELECT a, b FROM x WHERE b < 3 ORDER BY a', 'a', ['a', 'b']),
        'WITH x AS (SELECT * FROM t WHERE a > 1) SELECT a, count(*) AS count FROM x WHERE b < 3 GROUP BY a ORDER BY a'
    );
});

// ===== menu wiring =====

test('the column header menu offers grouping and writes the query without running it', () => {
    assert.match(JS, /addHeaderGroupingItems\(e, items, colName\)/);
    assert.match(JS, /label: `Group by \$\{colName\}`/);
    assert.match(JS, /label: `Aggregate \$\{colName\}`/);
    assert.match(JS, /label: 'Remove grouping'/);
    const wiring = JS.slice(JS.indexOf('function addHeaderGroupingItems'), JS.indexOf('function addHeaderRelationItems'));
    assert.ok(wiring.length > 0);
    assert.match(wiring, /setQueryText\(group\.sql/);
    assert.doesNotMatch(wiring, /setQueryTextAndRun/);
    assert.match(wiring, /aggregatesFor\(/);
});

test('a disabled context menu entry is shown muted and does nothing', () => {
    assert.match(JS, /item\.disabled \? ' class="disabled" aria-disabled="true"'/);
    assert.match(JS, /if \(items\[idx\] && items\[idx\]\.disabled\) return;/);
    assert.match(CSS, /\.context-menu li\.disabled \{/);
});
