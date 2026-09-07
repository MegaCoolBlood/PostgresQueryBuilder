import test from 'node:test';
import assert from 'node:assert/strict';

import {
    attributeKey,
    buildEditPlan,
    chooseIdentity,
    identityWarning,
    isWritableRelkind,
    resolveFieldSources,
    resultColumnAliases,
    sourceInstanceKey,
    splitAliasedSources,
    ColumnSource,
    RelationInfo,
    ResultFieldInfo,
    TableEditPlan
} from '../resultSource';

/** Build a column source without repeating the boilerplate in every test. */
function src(name: string, tableOid: number, table: string, sourceColumn = name): ColumnSource {
    return { name, tableOid, schema: 'public', table, sourceColumn };
}

// ===== 2.2.2: relation kinds =====

test('isWritableRelkind accepts tables, partitioned tables and foreign tables', () => {
    assert.equal(isWritableRelkind('r'), true);
    assert.equal(isWritableRelkind('p'), true);
    assert.equal(isWritableRelkind('f'), true);
});

test('isWritableRelkind rejects views and materialized views', () => {
    assert.equal(isWritableRelkind('v'), false);
    assert.equal(isWritableRelkind('m'), false);
});

test('isWritableRelkind assumes writable when the kind is unknown', () => {
    assert.equal(isWritableRelkind(undefined), true);
});

// ===== 2.2.2: mapping result fields to table columns =====

test('attributeKey combines relation oid and attribute number', () => {
    assert.equal(attributeKey(16385, 2), '16385:2');
});

test('resolveFieldSources maps aliased fields back to their table column', () => {
    const fields: ResultFieldInfo[] = [
        { name: 'user_id', dataTypeID: 23, tableID: 100, columnID: 1 },
        { name: 'user_name', dataTypeID: 25, tableID: 100, columnID: 2 }
    ];
    const relations: Record<number, RelationInfo> = { 100: { schema: 'public', table: 'users', relkind: 'r' } };
    const attributes = { '100:1': 'id', '100:2': 'name' };

    assert.deepEqual(resolveFieldSources(fields, relations, attributes), [
        { name: 'user_id', tableOid: 100, schema: 'public', table: 'users', sourceColumn: 'id' },
        { name: 'user_name', tableOid: 100, schema: 'public', table: 'users', sourceColumn: 'name' }
    ]);
});

test('resolveFieldSources returns null for computed columns and unknown relations', () => {
    const fields: ResultFieldInfo[] = [
        { name: 'total', dataTypeID: 23, tableID: 0, columnID: 0 },
        { name: 'literal', dataTypeID: 23 },
        { name: 'orphan', dataTypeID: 23, tableID: 999, columnID: 1 },
        { name: 'no_attr', dataTypeID: 23, tableID: 100, columnID: 7 }
    ];
    const relations: Record<number, RelationInfo> = { 100: { schema: 'public', table: 'users' } };

    assert.deepEqual(resolveFieldSources(fields, relations, { '100:1': 'id' }), [null, null, null, null]);
});

// ===== 2.2.2: row identity =====

test('chooseIdentity uses the primary key when every key column is in the result', () => {
    const columns = [src('id', 100, 'users'), src('name', 100, 'users')];
    const result = chooseIdentity(['id'], columns);

    assert.equal(result.strategy, 'pk');
    assert.deepEqual(result.identityColumns.map(c => c.sourceColumn), ['id']);
});

test('chooseIdentity falls back to all displayed columns when a key column is missing', () => {
    const columns = [src('name', 100, 'users'), src('email', 100, 'users')];
    const result = chooseIdentity(['id'], columns);

    assert.equal(result.strategy, 'row');
    assert.deepEqual(result.identityColumns.map(c => c.sourceColumn), ['name', 'email']);
});

test('chooseIdentity lists a duplicated source column only once', () => {
    const columns = [src('id', 100, 'users'), src('id2', 100, 'users', 'id')];
    const result = chooseIdentity([], columns);

    assert.equal(result.strategy, 'row');
    assert.deepEqual(result.identityColumns.map(c => c.name), ['id']);
});

test('chooseIdentity reports "none" when the table has no column in the result', () => {
    assert.deepEqual(chooseIdentity(['id'], []), { strategy: 'none', identityColumns: [] });
});

test('chooseIdentity requires the complete composite key', () => {
    const columns = [src('ts', 100, 'log'), src('msg', 100, 'log')];
    assert.equal(chooseIdentity(['ts', 'level'], columns).strategy, 'row');
});

// ===== 2.2.2: capabilities =====

test('buildEditPlan enables all features for a single table with a primary key', () => {
    const sources = [src('id', 100, 'users'), src('name', 100, 'users')];
    const caps = buildEditPlan(sources, { 100: ['id'] });

    assert.equal(caps.canEdit, true);
    assert.equal(caps.canInsert, true);
    assert.equal(caps.canDelete, true);
    assert.equal(caps.canConstrain, true);
    assert.equal(caps.canMap, true);
    assert.equal(caps.schema, 'public');
    assert.equal(caps.table, 'users');
    assert.equal(caps.identityStrategy, 'pk');
    assert.deepEqual(caps.editableColumns, ['id', 'name']);
    assert.equal(caps.warning, null);
});

test('buildEditPlan keeps a joined result editable but without insert/delete', () => {
    const sources = [src('id', 100, 'users'), src('order_id', 200, 'orders', 'id')];
    const caps = buildEditPlan(sources, { 100: ['id'], 200: ['id'] });

    assert.equal(caps.canEdit, true);
    assert.equal(caps.canInsert, false);
    assert.equal(caps.canDelete, false);
    assert.equal(caps.canConstrain, false);
    assert.equal(caps.canMap, false);
    assert.equal(caps.table, null);
    assert.deepEqual(caps.tables.map((t: TableEditPlan) => t.table), ['users', 'orders']);
    assert.deepEqual(caps.editableColumns, ['id', 'order_id']);
});

test('buildEditPlan marks computed-only results as not editable', () => {
    const caps = buildEditPlan([null, null], {});

    assert.equal(caps.canEdit, false);
    assert.equal(caps.canInsert, false);
    assert.deepEqual(caps.tables, []);
    assert.deepEqual(caps.editableColumns, []);
    assert.match(String(caps.warning), /not editable/);
});

test('buildEditPlan keeps computed columns read-only next to editable ones', () => {
    const caps = buildEditPlan([src('id', 100, 'users'), null], { 100: ['id'] });

    assert.deepEqual(caps.editableColumns, ['id']);
    assert.deepEqual(Object.keys(caps.columnSources), ['id']);
});

test('buildEditPlan warns and weakens the strategy when no primary key is available', () => {
    const caps = buildEditPlan([src('name', 100, 'users')], {});

    assert.equal(caps.canEdit, true);
    assert.equal(caps.identityStrategy, 'row');
    assert.match(String(caps.warning), /No primary key available for public\.users/);
});

test('buildEditPlan treats read-only relations as not editable', () => {
    const caps = buildEditPlan([src('id', 100, 'user_view')], { 100: ['id'] }, new Set([100]));

    assert.equal(caps.canEdit, false);
    assert.equal(caps.canInsert, false);
    // Constraints and mappings still work: they only need one source relation.
    assert.equal(caps.canConstrain, true);
    assert.equal(caps.tables[0].identityStrategy, 'none');
    assert.deepEqual(caps.editableColumns, []);
});

test('buildEditPlan reports the key columns a result does not expose', () => {
    const caps = buildEditPlan([src('name', 100, 'users')], { 100: ['tenant', 'id'] });
    assert.deepEqual(caps.tables[0].missingKeyColumns, ['tenant', 'id']);
});

test('buildEditPlan reports only the part of a composite key that is missing', () => {
    const caps = buildEditPlan([src('tenant', 100, 'users')], { 100: ['tenant', 'id'] });
    assert.deepEqual(caps.tables[0].missingKeyColumns, ['id']);
});

test('buildEditPlan reports nothing missing for a table identified by its key', () => {
    const caps = buildEditPlan([src('id', 100, 'users')], { 100: ['id'] });
    assert.deepEqual(caps.tables[0].missingKeyColumns, []);
});

// ===== 3.1.0: a table joined in more than once =====

test('splitAliasedSources marks the columns of a table used under two aliases', () => {
    const sources = [src('IRWAZ', 100, 'eaz', 'wert'), src('PLAWAZ', 100, 'eaz', 'wert'), src('name', 200, 'users')];
    const split = splitAliasedSources(sources, new Map([['IRWAZ', 'a'], ['PLAWAZ', 'b'], ['name', 'u']]));

    assert.equal(split[0]?.qualifier, 'a');
    assert.equal(split[1]?.qualifier, 'b');
    assert.equal(split[2]?.qualifier, undefined);
});

test('splitAliasedSources leaves a table alone when one of its aliases is unknown', () => {
    const sources = [src('IRWAZ', 100, 'eaz', 'wert'), src('computed', 100, 'eaz', 'wert')];
    const split = splitAliasedSources(sources, new Map([['IRWAZ', 'a']]));

    assert.equal(split[0]?.qualifier, undefined);
    assert.equal(split[1]?.qualifier, undefined);
});

test('splitAliasedSources leaves a table used under a single alias alone', () => {
    const split = splitAliasedSources([src('id', 100, 'users')], new Map([['id', 'u']]));
    assert.equal(split[0]?.qualifier, undefined);
});

test('buildEditPlan gives each alias of a table its own identity', () => {
    const sources = splitAliasedSources(
        [src('IRWAZ', 100, 'eaz', 'wert'), src('k0', 100, 'eaz', 'id'), src('PLAWAZ', 100, 'eaz', 'wert'), src('k1', 100, 'eaz', 'id')],
        new Map([['IRWAZ', 'a'], ['k0', 'a'], ['PLAWAZ', 'b'], ['k1', 'b']])
    );
    const caps = buildEditPlan(sources, { 100: ['id'] });

    assert.equal(caps.tables.length, 2);
    assert.deepEqual(caps.tables.map(t => sourceInstanceKey(t)), ['100:a', '100:b']);
    assert.deepEqual(caps.tables.map(t => t.identityColumns.map(c => c.name)), [['k0'], ['k1']]);
    // Two occurrences are two rows, so the result is no longer a single table.
    assert.equal(caps.canInsert, false);
});

test('identityWarning names a table joined in twice only once', () => {
    const sources = splitAliasedSources(
        [src('IRWAZ', 100, 'eaz', 'wert'), src('PLAWAZ', 100, 'eaz', 'wert')],
        new Map([['IRWAZ', 'a'], ['PLAWAZ', 'b']])
    );
    const caps = buildEditPlan(sources, {});

    assert.equal(caps.tables.length, 2);
    assert.match(String(caps.warning), /No primary key available for public\.eaz\. /);
});

// ===== 2.2.2: warnings =====

test('identityWarning explains an empty plan', () => {
    assert.match(String(identityWarning([])), /none of its columns/);
});

test('identityWarning stays silent when every table is identified by its primary key', () => {
    const plan: TableEditPlan[] = [
        { tableOid: 100, schema: 'public', table: 'users', identityStrategy: 'pk', identityColumns: [], columns: [], missingKeyColumns: [] }
    ];
    assert.equal(identityWarning(plan), null);
});

test('identityWarning names the tables that lack a primary key', () => {
    const plan: TableEditPlan[] = [
        { tableOid: 100, schema: 'public', table: 'users', identityStrategy: 'pk', identityColumns: [], columns: [], missingKeyColumns: [] },
        { tableOid: 200, schema: 'app', table: 'log', identityStrategy: 'row', identityColumns: [], columns: [], missingKeyColumns: [] }
    ];
    assert.match(String(identityWarning(plan)), /app\.log/);
});

test('identityWarning reports a fully unidentifiable result', () => {
    const plan: TableEditPlan[] = [
        { tableOid: 100, schema: 'public', table: 'users', identityStrategy: 'none', identityColumns: [], columns: [], missingKeyColumns: [] }
    ];
    assert.match(String(identityWarning(plan)), /cannot be identified/);
});

// ===== 3.1.0: result columns of a source column =====

/** A plan whose columns are renamed by the query. */
function aliasPlan(columns: ColumnSource[]): TableEditPlan {
    return { tableOid: 100, schema: 'public', table: 'users', identityStrategy: 'pk', identityColumns: [], columns, missingKeyColumns: [] };
}

test('resultColumnAliases maps a source column to the name the result gives it', () => {
    const aliases = resultColumnAliases(aliasPlan([src('user_id', 100, 'users', 'id')]));
    assert.deepEqual(aliases.get('id'), ['user_id']);
});

test('resultColumnAliases collects every result column of the same source column', () => {
    const aliases = resultColumnAliases(aliasPlan([
        src('id', 100, 'users'),
        src('id_again', 100, 'users', 'id')
    ]));
    assert.deepEqual(aliases.get('id'), ['id', 'id_again']);
});

test('resultColumnAliases knows nothing about a column the result does not show', () => {
    const aliases = resultColumnAliases(aliasPlan([src('id', 100, 'users')]));
    assert.equal(aliases.get('email'), undefined);
});
