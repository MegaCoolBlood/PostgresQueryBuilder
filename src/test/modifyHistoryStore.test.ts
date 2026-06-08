import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import { isModifyingSql, splitSqlStatements, ModifyHistoryStore, ModifyHistoryEntry } from '../modifyHistoryStore';

// ===== isModifyingSql =====

const MODIFYING = [
    'INSERT INTO t VALUES (1)',
    'update t set x = 1',
    'DELETE FROM t WHERE id = 1',
    'MERGE INTO t USING s ON (t.id = s.id)',
    'TRUNCATE t',
    'CREATE TABLE t (id int)',
    'DROP TABLE t',
    'ALTER TABLE t ADD COLUMN c int',
    'GRANT SELECT ON t TO bob',
    'REVOKE SELECT ON t FROM bob',
    'COMMENT ON TABLE t IS \'hi\'',
    'REFRESH MATERIALIZED VIEW mv',
    'CALL my_proc()'
];

for (const sql of MODIFYING) {
    test(`isModifyingSql is true for: ${sql.slice(0, 24)}`, () => {
        assert.equal(isModifyingSql(sql), true);
    });
}

test('isModifyingSql is false for SELECT and read-only statements', () => {
    assert.equal(isModifyingSql('SELECT * FROM t'), false);
    assert.equal(isModifyingSql('WITH x AS (SELECT 1) SELECT * FROM x'), false);
    assert.equal(isModifyingSql('EXPLAIN SELECT 1'), false);
    assert.equal(isModifyingSql('SHOW search_path'), false);
});

test('isModifyingSql is false for empty/blank input', () => {
    assert.equal(isModifyingSql(''), false);
    assert.equal(isModifyingSql('   \n  '), false);
});

test('isModifyingSql ignores leading line comments', () => {
    assert.equal(isModifyingSql('-- a note\nINSERT INTO t VALUES (1)'), true);
    assert.equal(isModifyingSql('-- a note\nSELECT 1'), false);
});

test('isModifyingSql ignores leading block comments', () => {
    assert.equal(isModifyingSql('/* header */ UPDATE t SET x = 1'), true);
    assert.equal(isModifyingSql('/* header */\n  SELECT 1'), false);
});

test('isModifyingSql is case-insensitive on the keyword', () => {
    assert.equal(isModifyingSql('InSeRt INTO t VALUES (1)'), true);
});

// ===== splitSqlStatements =====

test('splitSqlStatements splits on top-level semicolons', () => {
    assert.deepEqual(splitSqlStatements('SELECT 1; SELECT 2'), ['SELECT 1', 'SELECT 2']);
});

test('splitSqlStatements returns a single statement without a semicolon', () => {
    assert.deepEqual(splitSqlStatements('SELECT 1'), ['SELECT 1']);
});

test('splitSqlStatements ignores trailing and empty statements', () => {
    assert.deepEqual(splitSqlStatements('SELECT 1;;  ; SELECT 2;'), ['SELECT 1', 'SELECT 2']);
});

test('splitSqlStatements does not split on a semicolon inside a string literal', () => {
    assert.deepEqual(
        splitSqlStatements("INSERT INTO t VALUES ('a;b'); SELECT 2"),
        ["INSERT INTO t VALUES ('a;b')", 'SELECT 2']
    );
});

test('splitSqlStatements handles escaped single quotes within strings', () => {
    assert.deepEqual(
        splitSqlStatements("INSERT INTO t VALUES ('O''Brien;x'); SELECT 2"),
        ["INSERT INTO t VALUES ('O''Brien;x')", 'SELECT 2']
    );
});

test('splitSqlStatements does not split on a semicolon inside a line comment', () => {
    assert.deepEqual(
        splitSqlStatements('SELECT 1 -- a; b\n; SELECT 2'),
        ['SELECT 1 -- a; b', 'SELECT 2']
    );
});

test('splitSqlStatements does not split on a semicolon inside a block comment', () => {
    assert.deepEqual(
        splitSqlStatements('SELECT 1 /* a; b */; SELECT 2'),
        ['SELECT 1 /* a; b */', 'SELECT 2']
    );
});

// ===== ModifyHistoryStore =====

function createMockContext() {
    const store: Record<string, any> = {};
    return {
        globalState: {
            get<T>(key: string, defaultValue?: T): T {
                return store[key] !== undefined ? store[key] : defaultValue as T;
            },
            update(key: string, value: any) {
                store[key] = value;
                return Promise.resolve();
            }
        }
    } as any;
}

test('add stores an entry and getAll returns it', () => {
    const store = new ModifyHistoryStore(createMockContext());
    store.add({ sql: 'DELETE FROM t', schema: 'public', table: 't' });
    const all = store.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].sql, 'DELETE FROM t');
    assert.equal(all[0].schema, 'public');
    assert.ok(typeof all[0].timestamp === 'number');
});

test('add places the newest entry first', () => {
    const store = new ModifyHistoryStore(createMockContext());
    store.add({ sql: 'UPDATE t SET a = 1' });
    store.add({ sql: 'UPDATE t SET a = 2' });
    const all = store.getAll();
    assert.equal(all[0].sql, 'UPDATE t SET a = 2');
    assert.equal(all[1].sql, 'UPDATE t SET a = 1');
});

test('add trims whitespace and ignores empty statements', () => {
    const store = new ModifyHistoryStore(createMockContext());
    store.add({ sql: '   ' });
    store.add({ sql: '  INSERT INTO t VALUES (1)  ' });
    const all = store.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].sql, 'INSERT INTO t VALUES (1)');
});

test('add preserves an explicitly provided timestamp', () => {
    const store = new ModifyHistoryStore(createMockContext());
    const entry: ModifyHistoryEntry = { sql: 'DELETE FROM t', timestamp: 12345 };
    store.add(entry);
    assert.equal(store.getAll()[0].timestamp, 12345);
});

test('addMany keeps the given order with the first entry on top', () => {
    const store = new ModifyHistoryStore(createMockContext());
    store.addMany([
        { sql: 'INSERT INTO t VALUES (1)' },
        { sql: 'INSERT INTO t VALUES (2)' }
    ]);
    const all = store.getAll();
    assert.deepEqual(all.map(e => e.sql), [
        'INSERT INTO t VALUES (1)',
        'INSERT INTO t VALUES (2)'
    ]);
});

test('addMany skips empty entries and ignores empty input', () => {
    const store = new ModifyHistoryStore(createMockContext());
    store.addMany([]);
    store.addMany([{ sql: '  ' }, { sql: 'DELETE FROM t' }]);
    const all = store.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].sql, 'DELETE FROM t');
});

test('history is capped at 500 entries', () => {
    const store = new ModifyHistoryStore(createMockContext());
    for (let i = 0; i < 520; i++) {
        store.add({ sql: `UPDATE t SET a = ${i}` });
    }
    const all = store.getAll();
    assert.equal(all.length, 500);
    // Newest first
    assert.equal(all[0].sql, 'UPDATE t SET a = 519');
});

test('clear empties the history', () => {
    const store = new ModifyHistoryStore(createMockContext());
    store.add({ sql: 'DELETE FROM t' });
    store.clear();
    assert.deepEqual(store.getAll(), []);
});
