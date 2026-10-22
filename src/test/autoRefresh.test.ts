import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import {
    parseAutoRefreshInterval,
    autoRefreshIntervalError,
    formatAutoRefreshInterval,
    autoRefreshRefusal,
    exportQueryRefusal,
    AUTO_REFRESH_MIN_SECONDS,
    AUTO_REFRESH_MAX_SECONDS
} from '../autoRefresh';

const webview = require(path.join(__dirname, '../../../src/webview/tableView.js'));

// ===== parseAutoRefreshInterval =====

test('parseAutoRefreshInterval reads a bare number as seconds', () => {
    assert.equal(parseAutoRefreshInterval('45'), 45);
    assert.equal(parseAutoRefreshInterval(' 7 '), 7);
});

test('parseAutoRefreshInterval reads units and combinations of them', () => {
    assert.equal(parseAutoRefreshInterval('45s'), 45);
    assert.equal(parseAutoRefreshInterval('2m'), 120);
    assert.equal(parseAutoRefreshInterval('2 min'), 120);
    assert.equal(parseAutoRefreshInterval('1h 30m'), 5400);
    assert.equal(parseAutoRefreshInterval('1 hour 5 minutes 10 seconds'), 3910);
    assert.equal(parseAutoRefreshInterval('1M30S'), 90);
});

test('parseAutoRefreshInterval accepts a decimal point or comma', () => {
    assert.equal(parseAutoRefreshInterval('1.5m'), 90);
    assert.equal(parseAutoRefreshInterval('1,5 min'), 90);
    assert.equal(parseAutoRefreshInterval('2.4'), 2);
});

test('parseAutoRefreshInterval rejects anything that is not a duration', () => {
    for (const text of ['', '   ', 'soon', '5 days', '1h x', '-5', 'm5', '5 5']) {
        assert.equal(parseAutoRefreshInterval(text), null, JSON.stringify(text));
    }
});

// ===== autoRefreshIntervalError =====

test('autoRefreshIntervalError accepts the allowed range', () => {
    assert.equal(autoRefreshIntervalError(String(AUTO_REFRESH_MIN_SECONDS)), undefined);
    assert.equal(autoRefreshIntervalError('24h'), undefined);
    assert.equal(AUTO_REFRESH_MAX_SECONDS, 86400);
});

test('autoRefreshIntervalError explains what is wrong', () => {
    assert.match(autoRefreshIntervalError('soon')!, /duration such as/);
    assert.match(autoRefreshIntervalError('0')!, /at least 1 second/);
    assert.match(autoRefreshIntervalError('0.2s')!, /at least 1 second/);
    assert.match(autoRefreshIntervalError('25h')!, /at most 24 hours/);
});

// ===== formatAutoRefreshInterval =====

test('formatAutoRefreshInterval writes seconds, minutes and hours', () => {
    assert.equal(formatAutoRefreshInterval(5), '5 s');
    assert.equal(formatAutoRefreshInterval(60), '1 min');
    assert.equal(formatAutoRefreshInterval(90), '1 min 30 s');
    assert.equal(formatAutoRefreshInterval(3600), '1 h');
    assert.equal(formatAutoRefreshInterval(5400), '1 h 30 min');
    assert.equal(formatAutoRefreshInterval(0), '0 s');
});

test('formatAutoRefreshInterval output reads back to the same interval', () => {
    for (const seconds of [1, 5, 59, 60, 61, 300, 3599, 3600, 3661, 86400]) {
        assert.equal(parseAutoRefreshInterval(formatAutoRefreshInterval(seconds)), seconds);
    }
});

test('the webview formats intervals exactly like the extension', () => {
    for (const seconds of [0, 1, 5, 45, 60, 90, 300, 3600, 3661, 86400]) {
        assert.equal(webview.formatAutoRefreshInterval(seconds), formatAutoRefreshInterval(seconds));
    }
});

// ===== autoRefreshRefusal =====

test('autoRefreshRefusal lets plain reads through', () => {
    for (const sql of [
        'SELECT * FROM orders',
        'select o.* from orders o where o.state = \'open\' order by 1 limit 50 offset 0',
        'WITH t AS (SELECT 1 AS n) SELECT * FROM t',
        'TABLE orders',
        'VALUES (1), (2)',
        'SELECT updated_at, deleted, inserted_by FROM audit',
        "SELECT 'insert into x' AS note, \"update\" FROM t",
        '-- delete from x\nSELECT 1',
        'SELECT $$ update t set a = 1 $$'
    ]) {
        assert.equal(autoRefreshRefusal(sql), null, sql);
    }
});

test('autoRefreshRefusal refuses statements that write or change the schema', () => {
    for (const sql of [
        "UPDATE orders SET state = 'x'",
        'DELETE FROM orders',
        'INSERT INTO orders (id) VALUES (1)',
        'TRUNCATE orders',
        'DROP TABLE orders',
        'CALL do_it()',
        'REFRESH MATERIALIZED VIEW mv',
        'SELECT 1; DELETE FROM orders'
    ]) {
        assert.match(autoRefreshRefusal(sql)!, /changes data/, sql);
    }
});

test('autoRefreshRefusal refuses reads that hide a write', () => {
    for (const sql of [
        'WITH gone AS (DELETE FROM orders RETURNING *) SELECT * FROM gone',
        'WITH x AS (UPDATE orders o SET state = 1 RETURNING o.id) SELECT * FROM x',
        'SELECT nextval(\'orders_id_seq\')',
        'SELECT * INTO backup FROM orders',
        'EXPLAIN ANALYZE DELETE FROM orders'
    ]) {
        assert.match(autoRefreshRefusal(sql)!, /changes data/, sql);
    }
});

test('autoRefreshRefusal refuses a query that locks rows', () => {
    assert.match(autoRefreshRefusal('SELECT * FROM orders FOR UPDATE')!, /locks rows/);
    assert.match(autoRefreshRefusal('SELECT * FROM orders FOR NO KEY UPDATE SKIP LOCKED')!, /locks rows/);
    assert.match(autoRefreshRefusal('SELECT * FROM orders o FOR SHARE OF o')!, /locks rows/);
});

test('autoRefreshRefusal refuses explicit lock statements', () => {
    for (const sql of [
        'LOCK TABLE orders IN ACCESS EXCLUSIVE MODE',
        'lock orders',
        'LOCK TABLE ONLY public.orders, customers IN SHARE MODE NOWAIT',
        '/* keep others out */ LOCK TABLE orders',
        'SELECT * FROM orders; LOCK TABLE orders'
    ]) {
        assert.match(autoRefreshRefusal(sql)!, /explicit lock \(LOCK TABLE \/ advisory lock\)/, sql);
    }
});

test('autoRefreshRefusal refuses advisory lock functions', () => {
    for (const sql of [
        'SELECT pg_advisory_lock(42)',
        'SELECT pg_try_advisory_lock(1, 2)',
        'SELECT pg_advisory_xact_lock(42)',
        'SELECT pg_advisory_lock_shared(42)',
        'SELECT pg_try_advisory_xact_lock_shared(42), * FROM jobs',
        'SELECT PG_ADVISORY_LOCK (42)'
    ]) {
        assert.match(autoRefreshRefusal(sql)!, /explicit lock/, sql);
    }
});

test('autoRefreshRefusal does not mistake a column or text named lock for a lock', () => {
    for (const sql of [
        'SELECT lock, locked_at FROM jobs',
        'SELECT * FROM locks WHERE lock = 1',
        "SELECT 'LOCK TABLE orders' AS hint",
        '-- LOCK TABLE orders\nSELECT 1',
        'SELECT pg_advisory_unlock_all_count FROM stats',
        'SELECT * FROM pg_locks'
    ]) {
        assert.equal(autoRefreshRefusal(sql), null, sql);
    }
});

test('autoRefreshRefusal has nothing to refuse in an empty text', () => {
    assert.equal(autoRefreshRefusal(''), null);
    assert.equal(autoRefreshRefusal('  ;  '), null);
});

// ===== exportQueryRefusal =====

test('exportQueryRefusal lets a single read through', () => {
    assert.equal(exportQueryRefusal('SELECT * FROM orders WHERE id > 5'), null);
    assert.equal(exportQueryRefusal('WITH x AS (SELECT 1) SELECT * FROM x;'), null);
    assert.equal(exportQueryRefusal("SELECT 'update t set a = 1' AS txt"), null);
});

test('exportQueryRefusal refuses writes, locks, several statements and non-SELECTs', () => {
    assert.match(exportQueryRefusal("UPDATE orders SET state = 'x'") || '', /only a SELECT/i);
    assert.match(exportQueryRefusal('WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d') || '', /changes data/);
    assert.match(exportQueryRefusal('SELECT * FROM orders FOR UPDATE') || '', /lock/);
    assert.match(exportQueryRefusal('SELECT 1; DELETE FROM orders') || '', /several statements/);
    assert.match(exportQueryRefusal('   ') || '', /no query/);
});