import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomResultColumns, buildColumnProbeSql } from '../tableWebView';

test('buildCustomResultColumns resolves type names and column comments', () => {
    const fields = [
        { name: 'id', dataTypeID: 23, tableID: 100, columnID: 1 },
        { name: 'name', dataTypeID: 25, tableID: 100, columnID: 2 }
    ];
    const typeMap = { 23: 'int4', 25: 'text' };
    const commentMap = { '100:1': 'Primary key', '100:2': 'Display name' };

    assert.deepEqual(buildCustomResultColumns(fields, typeMap, commentMap), [
        { name: 'id', dataType: 'int4', isNullable: true, columnDefault: null, comment: 'Primary key' },
        { name: 'name', dataType: 'text', isNullable: true, columnDefault: null, comment: 'Display name' }
    ]);
});

test('buildCustomResultColumns leaves a table column without a comment as null', () => {
    const fields = [{ name: 'id', dataTypeID: 23, tableID: 100, columnID: 1 }];
    const cols = buildCustomResultColumns(fields, { 23: 'int4' }, {});
    assert.equal(cols[0].comment, null);
});

test('buildCustomResultColumns gives computed/expression columns no comment', () => {
    // A computed column (e.g. count(*) or a literal) has tableID/columnID 0.
    const fields = [
        { name: 'total', dataTypeID: 20, tableID: 0, columnID: 0 },
        { name: 'literal', dataTypeID: 25 }
    ];
    const commentMap = { '0:0': 'should never be used' };
    const cols = buildCustomResultColumns(fields, { 20: 'int8', 25: 'text' }, commentMap);

    assert.equal(cols[0].comment, null);
    assert.equal(cols[1].comment, null);
});

test('buildCustomResultColumns falls back to an empty data type for unknown OIDs', () => {
    const fields = [{ name: 'x', dataTypeID: 99999, tableID: 5, columnID: 3 }];
    const cols = buildCustomResultColumns(fields, {}, { '5:3': 'note' });
    assert.equal(cols[0].dataType, '');
    assert.equal(cols[0].comment, 'note');
});

test('buildCustomResultColumns keeps only the matching table/column comment', () => {
    const fields = [
        { name: 'a', dataTypeID: 23, tableID: 10, columnID: 1 },
        { name: 'b', dataTypeID: 23, tableID: 20, columnID: 1 }
    ];
    const commentMap = { '10:1': 'from table 10', '20:1': 'from table 20' };
    const cols = buildCustomResultColumns(fields, { 23: 'int4' }, commentMap);
    assert.equal(cols[0].comment, 'from table 10');
    assert.equal(cols[1].comment, 'from table 20');
});

// ===== buildColumnProbeSql =====

test('buildColumnProbeSql wraps a SELECT into a zero-row describe query', () => {
    assert.equal(
        buildColumnProbeSql('SELECT id, name FROM users'),
        'SELECT * FROM (SELECT id, name FROM users) AS _pqb_cols LIMIT 0'
    );
});

test('buildColumnProbeSql wraps a WITH (CTE) query', () => {
    assert.equal(
        buildColumnProbeSql('WITH x AS (SELECT 1 AS n) SELECT n FROM x'),
        'SELECT * FROM (WITH x AS (SELECT 1 AS n) SELECT n FROM x) AS _pqb_cols LIMIT 0'
    );
});

test('buildColumnProbeSql strips a trailing semicolon before wrapping', () => {
    assert.equal(
        buildColumnProbeSql('SELECT 1 ;  '),
        'SELECT * FROM (SELECT 1) AS _pqb_cols LIMIT 0'
    );
});

test('buildColumnProbeSql is case-insensitive to the leading keyword', () => {
    assert.equal(
        buildColumnProbeSql('select 1'),
        'SELECT * FROM (select 1) AS _pqb_cols LIMIT 0'
    );
});

test('buildColumnProbeSql returns null for non-SELECT statements', () => {
    assert.equal(buildColumnProbeSql('UPDATE t SET a = 1'), null);
    assert.equal(buildColumnProbeSql('INSERT INTO t VALUES (1)'), null);
    assert.equal(buildColumnProbeSql('DELETE FROM t'), null);
});

test('buildColumnProbeSql returns null for empty or non-string input', () => {
    assert.equal(buildColumnProbeSql(''), null);
    assert.equal(buildColumnProbeSql('   '), null);
    assert.equal(buildColumnProbeSql(';'), null);
    assert.equal(buildColumnProbeSql(undefined as any), null);
    assert.equal(buildColumnProbeSql(null as any), null);
});

test('buildColumnProbeSql does not treat "selection" as a SELECT keyword', () => {
    assert.equal(buildColumnProbeSql('selective_function()'), null);
});
