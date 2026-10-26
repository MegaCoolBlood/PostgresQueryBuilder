import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { POSTGRES_RESERVED_KEYWORDS } from '../reservedKeywords';

const {
    executableColumnType,
    executableTypeOfColumn,
    executableColumnAlias,
    executableIcon,
    executableMarkKey,
    executableMark,
    maskSqlStructure,
    renameSelectColumn
} = require(path.join(__dirname, '../../../src/webview/tableView.js'));

const isReserved = (word: string) => POSTGRES_RESERVED_KEYWORDS.has(word);
// The quoting of formatIdentifier in the Data Viewer with alwaysQuote off.
const formatIdent = (name: string) => /^[a-z_][a-z0-9_$]*$/.test(name) && !isReserved(name)
    ? name
    : `"${name.replace(/"/g, '""')}"`;

/** Rename `name` in `sql`, whose result columns are `columns`. */
function rename(sql: string, name: string, newName: string, columns: string[]) {
    return renameSelectColumn(sql, { name, index: columns.indexOf(name), columns }, newName, formatIdent, isReserved);
}

const BLOCKING_SESSIONS = [
    'SELECT',
    'psa.pid,',
    'psa.usename,',
    'psa.application_name,',
    'psa.query_start,',
    'pg_blocking_pids(psa.pid) AS blocked_by,',
    'psa.wait_event_type,',
    'psa.wait_event,',
    'psa.query AS blocked_query,',
    "'SELECT pg_terminate_backend(' || psa.pid || ');' AS kill_command",
    'FROM pg_stat_activity AS psa',
    'WHERE cardinality(pg_blocking_pids(psa.pid)) > 0 OR psa.pid IN ( SELECT unnest(pg_blocking_pids(blocked.pid)) FROM pg_stat_activity AS blocked )'
].join('\n');
const BLOCKING_COLUMNS = ['pid', 'usename', 'application_name', 'query_start', 'blocked_by', 'wait_event_type', 'wait_event', 'blocked_query', 'kill_command'];

// ===== which columns run their values =====

test('a column with a prefix runs its values when the query named it', () => {
    assert.equal(executableTypeOfColumn('pgsql_kill_command', undefined).kind, 'statement');
    assert.equal(executableTypeOfColumn('url_home', { sourceColumn: 'homepage', table: 'customers' }).kind, 'url');
});

test('a stored table column that merely starts with a prefix stays an ordinary column', () => {
    assert.equal(executableTypeOfColumn('ps_number', { sourceColumn: 'ps_number', table: 'orders' }), null);
    assert.equal(executableTypeOfColumn('url_slug', { sourceColumn: 'url_slug', table: 'pages' }), null);
    assert.equal(executableTypeOfColumn('kill_command', undefined), null);
});

test('executableColumnType of the webview matches prefixes case-insensitively', () => {
    assert.equal(executableColumnType('PGSQL_Kill').kind, 'statement');
    assert.equal(executableColumnType('sql_'), null);
});

test('executableColumnAlias adds, replaces and removes the prefix', () => {
    assert.equal(executableColumnAlias('kill_command', 'pgsql_'), 'pgsql_kill_command');
    assert.equal(executableColumnAlias('pgsql_kill_command', 'psql_'), 'psql_kill_command');
    assert.equal(executableColumnAlias('PGSQL_Kill', 'url_'), 'url_Kill');
    assert.equal(executableColumnAlias('pgsql_kill_command', ''), 'kill_command');
    assert.equal(executableColumnAlias('?column?', 'sql_'), 'sql_column');
});

test('every kind of executable column has an icon', () => {
    for (const kind of ['dataViewer', 'statement', 'psql', 'powershell', 'url', 'file', 'copy']) {
        assert.match(executableIcon(kind), /<use href="#icon-[a-z-]+"/, kind);
    }
});

// ===== marks =====

test('a value that ran is marked with when and how it ended', () => {
    assert.deepEqual(
        executableMark({ status: 'executed', message: 'SELECT returned 1 row in 3 ms. Result: true.' }, '15:07:12'),
        { status: 'executed', title: 'Executed at 15:07:12: SELECT returned 1 row in 3 ms. Result: true. Click to run it again.' }
    );
    assert.deepEqual(
        executableMark({ status: 'sent', message: 'Sent to the psql console of "prod".' }, '15:07:12'),
        { status: 'executed', title: 'Sent to the psql console of "prod" at 15:07:12. Click to send it again.' }
    );
    assert.deepEqual(
        executableMark({ status: 'failed', message: 'permission denied' }, '15:07:12'),
        { status: 'failed', title: 'Failed at 15:07:12: permission denied Click to try again.' }
    );
});

test('opening, copying or cancelling leaves no mark', () => {
    for (const status of ['opened', 'copied', 'cancelled']) {
        assert.equal(executableMark({ status }, '15:07:12'), null, status);
    }
    assert.equal(executableMark(undefined, '15:07:12'), null);
});

test('the mark belongs to the column and the exact value', () => {
    assert.notEqual(executableMarkKey('a', 'x'), executableMarkKey('b', 'x'));
    assert.notEqual(executableMarkKey('a', 'x'), executableMarkKey('a', 'x '));
    assert.equal(executableMarkKey('a', 'x'), executableMarkKey('a', 'x'));
});

// ===== maskSqlStructure =====

test('maskSqlStructure hides comments, literals and quoted names but keeps every offset', () => {
    const sql = "SELECT 'a, b' AS \"x, y\", $$c, d$$ -- e, f\n, E'g\\'h' FROM t";
    const masked = maskSqlStructure(sql);
    assert.equal(masked.length, sql.length);
    assert.equal(masked, 'SELECT 000000 AS "____", 00000000' + ' '.repeat(1 + '-- e, f'.length) + "\n, 0000000 FROM t");
});

// ===== renameSelectColumn =====

test('the alias of the column is replaced and nothing else of the query changes', () => {
    const result = rename(BLOCKING_SESSIONS, 'kill_command', 'pgsql_kill_command', BLOCKING_COLUMNS);
    assert.equal(result.sql, BLOCKING_SESSIONS.replace("');' AS kill_command", "');' AS pgsql_kill_command"));
});

test('a column without an alias gets one with AS', () => {
    const result = rename(BLOCKING_SESSIONS, 'pid', 'copy_pid', BLOCKING_COLUMNS);
    assert.equal(result.sql, BLOCKING_SESSIONS.replace('SELECT\npsa.pid,', 'SELECT\npsa.pid AS copy_pid,'));
    assert.equal(rename("SELECT a, 'x' || b, c FROM t", '?column?', 'sql_column', ['a', '?column?', 'c']).sql,
        "SELECT a, 'x' || b AS sql_column, c FROM t");
    assert.equal(rename('SELECT count(*) FROM t', 'count', 'copy_count', ['count']).sql, 'SELECT count(*) AS copy_count FROM t');
});

test('an alias written without AS is replaced in place', () => {
    assert.equal(rename('SELECT a, b total FROM t', 'total', 'copy_total', ['a', 'total']).sql, 'SELECT a, b copy_total FROM t');
    assert.equal(rename('SELECT a, count(*) n FROM t', 'n', 'copy_n', ['a', 'n']).sql, 'SELECT a, count(*) copy_n FROM t');
    assert.equal(rename("SELECT CASE WHEN a THEN 1 END flag FROM t", 'flag', 'copy_flag', ['flag']).sql, 'SELECT CASE WHEN a THEN 1 END copy_flag FROM t');
});

test('a quoted alias keeps a name that needs quotes', () => {
    assert.equal(rename('SELECT a AS "Kill Cmd" FROM t', 'Kill Cmd', 'pgsql_Kill Cmd', ['Kill Cmd']).sql, 'SELECT a AS "pgsql_Kill Cmd" FROM t');
});

test('the last word of an expression is no alias', () => {
    assert.equal(rename('SELECT x IS NULL, y FROM t', '?column?', 'copy_null', ['?column?', 'y']).sql, 'SELECT x IS NULL AS copy_null, y FROM t');
    assert.equal(rename('SELECT x::double precision FROM t', 'x', 'copy_x', ['x']).sql, 'SELECT x::double precision AS copy_x FROM t');
    assert.equal(rename("SELECT date '2026-01-01' FROM t", 'date', 'copy_d', ['date']).sql, "SELECT date '2026-01-01' AS copy_d FROM t");
    assert.equal(rename('SELECT a COLLATE "C" FROM t', 'a', 'copy_a', ['a']).sql, 'SELECT a COLLATE "C" AS copy_a FROM t');
});

test('commas and keywords inside strings, comments, quoted names and calls are no boundaries', () => {
    const sql = "SELECT 'a, FROM b' AS s, /* x, y */ f(1, 2) AS g, \"from, x\" -- c, d\n, z FROM t";
    const result = rename(sql, 'z', 'copy_z', ['s', 'g', 'from, x', 'z']);
    assert.equal(result.sql, sql.replace('\n, z FROM', '\n, z AS copy_z FROM'));
});

test('DISTINCT ON, a WITH query and a UNION are renamed in their outermost select list', () => {
    assert.equal(rename('SELECT DISTINCT ON (a) a, b FROM t', 'b', 'url_b', ['a', 'b']).sql, 'SELECT DISTINCT ON (a) a, b AS url_b FROM t');
    assert.equal(
        rename('WITH x AS (SELECT 1 AS n) SELECT n, n + 1 AS m FROM x', 'm', 'copy_m', ['n', 'm']).sql,
        'WITH x AS (SELECT 1 AS n) SELECT n, n + 1 AS copy_m FROM x'
    );
    assert.equal(
        rename('SELECT a AS v FROM t UNION ALL SELECT b FROM u', 'v', 'copy_v', ['v']).sql,
        'SELECT a AS copy_v FROM t UNION ALL SELECT b FROM u'
    );
});

test('a bare ORDER BY reference to the old name follows the new name', () => {
    assert.equal(
        rename('SELECT a, b AS x FROM t ORDER BY x DESC, a LIMIT 5', 'x', 'ps_x', ['a', 'x']).sql,
        'SELECT a, b AS ps_x FROM t ORDER BY ps_x DESC, a LIMIT 5'
    );
    assert.equal(
        rename('SELECT a, b AS x FROM t ORDER BY lower(x), t.x', 'x', 'ps_x', ['a', 'x']).sql,
        'SELECT a, b AS ps_x FROM t ORDER BY lower(x), t.x',
        'only a bare reference names the output column'
    );
});

test('a lone * is spelled out into the columns of the result', () => {
    assert.equal(rename('SELECT * FROM t ORDER BY b', 'b', 'url_b', ['a', 'b', 'Name']).sql, 'SELECT a, b AS url_b, "Name" FROM t ORDER BY url_b');
    assert.equal(rename('SELECT o.* FROM orders o', 'id', 'copy_id', ['id', 'total']).sql, 'SELECT o.id AS copy_id, o.total FROM orders o');
});

test('a column next to a * is found by position or by name', () => {
    assert.equal(rename('SELECT now() AS ts, * FROM t', 'ts', 'copy_ts', ['ts', 'a', 'b']).sql, 'SELECT now() AS copy_ts, * FROM t');
    assert.equal(rename('SELECT *, now() AS ts FROM t', 'ts', 'copy_ts', ['a', 'ts']).sql, 'SELECT *, now() AS copy_ts FROM t');
});

test('what cannot be renamed safely is refused with a reason', () => {
    assert.match(rename('SELECT *, now() AS ts FROM t', 'a', 'copy_a', ['a', 'ts']).error, /comes from a \* in the query/);
    assert.match(rename('UPDATE t SET a = 1', 'a', 'copy_a', ['a']).error, /holds no SELECT/);
    assert.match(rename('VALUES (1)', 'column1', 'copy_c', ['column1']).error, /holds no SELECT/);
    assert.match(rename('SELECT a.x, b.x FROM a, b', 'x', 'copy_x', ['x', 'x']).error, /2 columns named "x"/);
    assert.match(rename('SELECT a, b FROM t', 'c', 'copy_c', ['a', 'b']).error, /"c" was not found in the select list/);
    assert.match(rename('SELECT a,, b FROM t', 'a', 'copy_a', ['a', 'b']).error, /empty entry/);
});

test('a select list that does not match the result is matched by name instead of position', () => {
    // The query bar was edited after the run: positions moved, the name still decides.
    assert.equal(rename('SELECT c, a, b AS x FROM t', 'x', 'copy_x', ['a', 'x']).sql, 'SELECT c, a, b AS copy_x FROM t');
});

// ===== the messages between panel and extension =====

test('the panel and the extension agree on the messages of executable columns', () => {
    const js = fs.readFileSync(path.join(__dirname, '../../../src/webview/tableView.js'), 'utf8');
    const host = fs.readFileSync(path.join(__dirname, '../../../src/tableWebView.ts'), 'utf8');
    for (const command of ['runExecutableValue', 'chooseExecutableType']) {
        assert.ok(js.includes(`command: '${command}'`), `the panel posts ${command}`);
        assert.ok(host.includes(`${command}: this.handle`), `the extension handles ${command}`);
    }
    for (const command of ['executableValueDone', 'executableTypeChosen']) {
        assert.ok(host.includes(`command: '${command}'`), `the extension posts ${command}`);
        assert.ok(js.includes(`case '${command}':`), `the panel handles ${command}`);
    }
});
