import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SavedQueryStore,
    parseQueryPlaceholders,
    placeholderNames,
    mergeParameters,
    renderParameterValue,
    applyQueryParameters,
    normalizeParameters,
    normalizeSavedQuery,
    normalizeSavedQueries,
    sortSavedQueries,
    SavedQuery,
    SavedQueryParameter
} from '../savedQueryStore';

function createMockContext() {
    const store: Record<string, any> = {};
    return {
        subscriptions: { push: (..._: any[]) => {} },
        globalState: {
            get<T>(key: string, defaultValue?: T): T {
                return store[key] !== undefined ? store[key] : (defaultValue as T);
            },
            update(key: string, value: any) {
                store[key] = value;
                return Promise.resolve();
            }
        }
    } as any;
}

// ===== parseQueryPlaceholders =====

test('parseQueryPlaceholders finds a single placeholder with its offsets', () => {
    assert.deepEqual(
        parseQueryPlaceholders('SELECT * FROM t WHERE id = :id'),
        [{ name: 'id', start: 27, end: 30 }]
    );
});

test('parseQueryPlaceholders finds several placeholders in order', () => {
    assert.deepEqual(
        placeholderNames('SELECT * FROM t WHERE d BETWEEN :from AND :to'),
        ['from', 'to']
    );
});

test('parseQueryPlaceholders does not treat a :: cast as a placeholder', () => {
    assert.deepEqual(parseQueryPlaceholders('SELECT a::text FROM t'), []);
});

test('parseQueryPlaceholders keeps a placeholder that is followed by a cast', () => {
    assert.deepEqual(placeholderNames('SELECT * FROM t WHERE id = :id::int'), ['id']);
});

test('parseQueryPlaceholders ignores a colon-name inside a string literal', () => {
    assert.deepEqual(parseQueryPlaceholders(`SELECT * FROM t WHERE b = ':not_a_param'`), []);
});

test('parseQueryPlaceholders ignores a colon-name inside a comment', () => {
    assert.deepEqual(parseQueryPlaceholders('SELECT * FROM t -- :nope\n'), []);
});

test('parseQueryPlaceholders ignores an assignment operator', () => {
    assert.deepEqual(parseQueryPlaceholders('x :=1'), []);
});

test('parseQueryPlaceholders ignores an array slice', () => {
    assert.deepEqual(parseQueryPlaceholders('SELECT a[1:3] FROM t'), []);
});

test('placeholderNames reports a repeated placeholder only once', () => {
    assert.deepEqual(placeholderNames('SELECT * FROM t WHERE a = :id OR b = :id'), ['id']);
});

test('parseQueryPlaceholders returns empty for non-string input', () => {
    assert.deepEqual(parseQueryPlaceholders(undefined as any), []);
    assert.deepEqual(parseQueryPlaceholders('' as any), []);
});

// ===== mergeParameters =====

test('mergeParameters adds newly found placeholders as text parameters', () => {
    assert.deepEqual(
        mergeParameters('SELECT * FROM t WHERE id = :id', []),
        [{ name: 'id', kind: 'text' }]
    );
});

test('mergeParameters keeps the settings of a still-used parameter', () => {
    const existing: SavedQueryParameter[] = [
        { name: 'id', kind: 'number', label: 'Order id', defaultValue: '1' }
    ];
    assert.deepEqual(mergeParameters('SELECT * FROM t WHERE id = :id', existing), existing);
});

test('mergeParameters drops parameters whose placeholder vanished', () => {
    assert.deepEqual(
        mergeParameters('SELECT * FROM t', [{ name: 'id', kind: 'number' }]),
        []
    );
});

// ===== renderParameterValue =====

test('renderParameterValue quotes text and doubles single quotes', () => {
    assert.equal(renderParameterValue("O'Brien", 'text'), `'O''Brien'`);
});

test('renderParameterValue emits a valid number verbatim', () => {
    assert.equal(renderParameterValue(' 42 ', 'number'), '42');
    assert.equal(renderParameterValue('-3.5', 'number'), '-3.5');
});

test('renderParameterValue rejects a non-numeric value for a number parameter', () => {
    assert.throws(() => renderParameterValue('1; DROP TABLE t', 'number'), /not a valid number/);
});

test('renderParameterValue quotes an identifier and doubles double quotes', () => {
    assert.equal(renderParameterValue('my"col', 'identifier'), '"my""col"');
});

test('renderParameterValue emits a raw value verbatim', () => {
    assert.equal(renderParameterValue('CURRENT_DATE - 7', 'raw'), 'CURRENT_DATE - 7');
});

// ===== applyQueryParameters =====

test('applyQueryParameters substitutes every occurrence of a placeholder', () => {
    assert.equal(
        applyQueryParameters(
            'SELECT * FROM t WHERE a = :id OR b = :id',
            { id: '7' },
            [{ name: 'id', kind: 'number' }]
        ),
        'SELECT * FROM t WHERE a = 7 OR b = 7'
    );
});

test('applyQueryParameters substitutes several placeholders', () => {
    assert.equal(
        applyQueryParameters(
            'SELECT * FROM t WHERE d BETWEEN :from AND :to',
            { from: '2024-01-01', to: '2024-12-31' },
            [{ name: 'from', kind: 'text' }, { name: 'to', kind: 'text' }]
        ),
        `SELECT * FROM t WHERE d BETWEEN '2024-01-01' AND '2024-12-31'`
    );
});

test('applyQueryParameters does not substitute inside an inserted value', () => {
    assert.equal(
        applyQueryParameters(
            'SELECT * FROM t WHERE a = :a AND b = :b',
            { a: ':b', b: 'x' },
            [{ name: 'a', kind: 'text' }, { name: 'b', kind: 'text' }]
        ),
        `SELECT * FROM t WHERE a = ':b' AND b = 'x'`
    );
});

test('applyQueryParameters falls back to the default value', () => {
    assert.equal(
        applyQueryParameters(
            'SELECT * FROM t WHERE s = :status',
            {},
            [{ name: 'status', kind: 'text', defaultValue: 'active' }]
        ),
        `SELECT * FROM t WHERE s = 'active'`
    );
});

test('applyQueryParameters reports a missing value without a default', () => {
    assert.throws(
        () => applyQueryParameters('SELECT * FROM t WHERE s = :status', {}, []),
        /No value supplied for :status/
    );
});

test('applyQueryParameters treats an unknown parameter as text', () => {
    assert.equal(
        applyQueryParameters('SELECT * FROM t WHERE s = :status', { status: 'a' }, []),
        `SELECT * FROM t WHERE s = 'a'`
    );
});

test('applyQueryParameters leaves a query without placeholders untouched', () => {
    assert.equal(applyQueryParameters('SELECT 1', {}, []), 'SELECT 1');
});

test('applyQueryParameters does not touch a literal that looks like a placeholder', () => {
    assert.equal(
        applyQueryParameters(
            `SELECT ':id' AS lit FROM t WHERE id = :id`,
            { id: '5' },
            [{ name: 'id', kind: 'number' }]
        ),
        `SELECT ':id' AS lit FROM t WHERE id = 5`
    );
});

// ===== normalization =====

test('normalizeParameters defaults an unknown kind to text and drops nameless entries', () => {
    assert.deepEqual(
        normalizeParameters([{ name: 'a', kind: 'bogus' }, { kind: 'text' }, { name: '  ' }] as any),
        [{ name: 'a', kind: 'text' }]
    );
});

test('normalizeParameters keeps only the first of two identically named parameters', () => {
    assert.deepEqual(
        normalizeParameters([{ name: 'a', kind: 'number' }, { name: 'A', kind: 'raw' }] as any),
        [{ name: 'a', kind: 'number' }]
    );
});

test('normalizeSavedQuery drops entries without id, name or sql', () => {
    assert.equal(normalizeSavedQuery({ name: 'x', sql: 'SELECT 1' }), undefined);
    assert.equal(normalizeSavedQuery({ id: '1', sql: 'SELECT 1' }), undefined);
    assert.equal(normalizeSavedQuery({ id: '1', name: 'x' }), undefined);
    assert.equal(normalizeSavedQuery('nope'), undefined);
});

test('normalizeSavedQueries keeps well-formed entries only', () => {
    assert.deepEqual(
        normalizeSavedQueries([{ id: '1', name: 'x', sql: 'SELECT 1' }, { id: '2' }]),
        [{ id: '1', name: 'x', sql: 'SELECT 1', parameters: [] }]
    );
});

test('sortSavedQueries orders by name case-insensitively', () => {
    const queries = [
        { id: '1', name: 'beta', sql: 'SELECT 1', parameters: [] },
        { id: '2', name: 'Alpha', sql: 'SELECT 1', parameters: [] }
    ];
    assert.deepEqual(sortSavedQueries(queries).map(q => q.name), ['Alpha', 'beta']);
});

// ===== SavedQueryStore =====

test('getAll returns an empty list when nothing is stored', () => {
    const store = new SavedQueryStore(createMockContext());
    assert.deepEqual(store.getAll(), []);
});

test('add persists a query and assigns an id', async () => {
    const store = new SavedQueryStore(createMockContext());
    const created = await store.add({ name: 'Open orders', sql: 'SELECT * FROM o WHERE s = :s', parameters: [{ name: 's', kind: 'text' }] });
    assert.ok(created.id);
    const all = store.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].name, 'Open orders');
    assert.equal(all[0].scope, 'global');
    assert.deepEqual(all[0].parameters, [{ name: 's', kind: 'text' }]);
});

test('get finds a query by id', async () => {
    const store = new SavedQueryStore(createMockContext());
    const created = await store.add({ name: 'q', sql: 'SELECT 1', parameters: [] });
    assert.equal(store.get(created.id)?.name, 'q');
    assert.equal(store.get('nope'), undefined);
});

test('update changes name, sql and parameters', async () => {
    const store = new SavedQueryStore(createMockContext());
    const created = await store.add({ name: 'q', sql: 'SELECT 1', parameters: [] });
    await store.update(created.id, { name: 'renamed', sql: 'SELECT 2', parameters: [{ name: 'a', kind: 'raw' }] });
    const updated = store.get(created.id);
    assert.equal(updated?.name, 'renamed');
    assert.equal(updated?.sql, 'SELECT 2');
    assert.deepEqual(updated?.parameters, [{ name: 'a', kind: 'raw' }]);
});

test('update ignores an unknown id', async () => {
    const store = new SavedQueryStore(createMockContext());
    await store.update('nope', { name: 'x' });
    assert.deepEqual(store.getAll(), []);
});

test('delete removes a query', async () => {
    const store = new SavedQueryStore(createMockContext());
    const created = await store.add({ name: 'q', sql: 'SELECT 1', parameters: [] });
    await store.delete(created.id);
    assert.deepEqual(store.getAll(), []);
});

test('onDidChange fires when a query is added, updated and deleted', async () => {
    const store = new SavedQueryStore(createMockContext());
    let fired = 0;
    store.onDidChange(() => { fired++; });
    const created = await store.add({ name: 'q', sql: 'SELECT 1', parameters: [] });
    await store.update(created.id, { name: 'q2' });
    await store.delete(created.id);
    assert.equal(fired, 3);
});

test('touch records the time a query was last used', async () => {
    const store = new SavedQueryStore(createMockContext());
    const created = await store.add({ name: 'q', sql: 'SELECT 1', parameters: [], lastUsed: 0 });
    await store.touch(created.id);
    assert.ok((store.get(created.id)?.lastUsed ?? 0) > 0);
});

test('parameter values are cached per query and cleared when empty', async () => {
    const store = new SavedQueryStore(createMockContext());
    assert.deepEqual(store.getParameterValues('q1'), {});
    await store.setParameterValues('q1', { from: '2024-01-01' });
    assert.deepEqual(store.getParameterValues('q1'), { from: '2024-01-01' });
    assert.deepEqual(store.getParameterValues('q2'), {});
    await store.setParameterValues('q1', {});
    assert.deepEqual(store.getParameterValues('q1'), {});
});

test('a query without a workspace folder stays in the personal store', async () => {
    const store = new SavedQueryStore(createMockContext());
    const created = await store.add({ name: 'q', sql: 'SELECT 1', parameters: [] }, 'workspace');
    assert.equal(store.getAll()[0].scope, 'global');
    assert.equal(store.get(created.id)?.name, 'q');
});

test('moving to a scope that is unavailable leaves the query where it is', async () => {
    const store = new SavedQueryStore(createMockContext());
    const created = await store.add({ name: 'q', sql: 'SELECT 1', parameters: [] });
    assert.equal(await store.move(created.id, 'workspace'), false);
    assert.equal(store.getAll()[0].scope, 'global');
});

test('malformed stored entries are ignored when reading', () => {
    const context = createMockContext();
    context.globalState.update('savedQueries', [
        { id: '1', name: 'ok', sql: 'SELECT 1' },
        { id: '2', name: '', sql: 'SELECT 1' },
        'garbage'
    ] as any);
    const store = new SavedQueryStore(context);
    const all: SavedQuery[] = store.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].name, 'ok');
});
