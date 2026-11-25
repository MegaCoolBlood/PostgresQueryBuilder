import './helpers/vscodeMock';
import { vscodeStub } from './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
    serializeWorkspaceQuery,
    fileContentDiffers,
    detectLineEnding,
    withLineEnding,
    SavedQuery,
    SavedQueryParameter,
    normalizeTag,
    normalizeTags,
    compareTags,
    collectTags,
    withTag,
    withoutTag
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

test('parseQueryPlaceholders ignores a named slice bound but keeps placeholders in an ARRAY constructor', () => {
    assert.deepEqual(placeholderNames('SELECT a[1:n] FROM t WHERE a[lo:hi] = ARRAY[:x]'), ['x']);
    assert.deepEqual(placeholderNames('SELECT a[:n], b[ 2 : m ][:k], "c[d"[1:e] FROM t'), []);
    assert.deepEqual(placeholderNames('SELECT * FROM t WHERE a && ARRAY[:x, :y] AND b = array /* c */ [ :z ]'), ['x', 'y', 'z']);
    assert.deepEqual(placeholderNames('SELECT ARRAY[:x][1:n], myarray[:k] FROM t WHERE c = :after'), ['x', 'after']);
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

test('renderParameterValue reads a date in the forms of the date picker', () => {
    assert.equal(renderParameterValue('2026-11-25', 'date'), `DATE '2026-11-25'`);
    assert.equal(renderParameterValue(' 5.1.2026 ', 'date'), `DATE '2026-01-05'`);
    assert.equal(renderParameterValue('2026-11-25 10:39', 'date'), `DATE '2026-11-25'`, 'a time is dropped, as by the picker');
    assert.equal(renderParameterValue('-infinity', 'date'), `DATE '-infinity'`);
});

test('renderParameterValue reads a 24-hour timestamp and keeps a typed offset', () => {
    assert.equal(renderParameterValue('2026-11-25T18:05', 'timestamp'), `TIMESTAMP '2026-11-25 18:05:00'`);
    assert.equal(renderParameterValue('25.11.2026 18:05:09.25', 'timestamp'), `TIMESTAMP '2026-11-25 18:05:09.25'`);
    assert.equal(renderParameterValue('2026-11-25', 'timestamp'), `TIMESTAMP '2026-11-25 00:00:00'`);
    assert.equal(renderParameterValue('2026-11-25 18:05+01', 'timestamp'), `TIMESTAMPTZ '2026-11-25 18:05:00+01'`);
    assert.equal(renderParameterValue('infinity', 'timestamp'), `TIMESTAMP 'infinity'`);
});

test('renderParameterValue rejects a date or timestamp that does not exist', () => {
    assert.throws(() => renderParameterValue('31.02.2026', 'date'), /^Error: "31\.02\.2026" is not a valid date\.$/);
    assert.throws(() => renderParameterValue('2026-11-25 10:39+01', 'date'), /not a valid date/, 'a date takes no offset');
    assert.throws(() => renderParameterValue('2026-11-25 24:00', 'timestamp'), /^Error: "2026-11-25 24:00" is not a valid timestamp\.$/);
    assert.throws(() => renderParameterValue("2026-11-25'; DROP TABLE t; --", 'timestamp'), /not a valid timestamp/);
});

test('renderParameterValue writes NULL for null, except for an identifier', () => {
    assert.equal(renderParameterValue(null, 'text'), 'NULL');
    assert.equal(renderParameterValue(null, 'timestamp'), 'NULL');
    assert.throws(() => renderParameterValue(null, 'identifier', 'col'), /:col cannot be NULL/);
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

test('applyQueryParameters writes NULL for a null value of every kind but an identifier', () => {
    for (const kind of ['text', 'number', 'date', 'timestamp', 'raw'] as const) {
        assert.equal(applyQueryParameters('SELECT :v', { v: null }, [{ name: 'v', kind, defaultValue: '1' }]), 'SELECT NULL', kind);
    }
    assert.throws(
        () => applyQueryParameters('SELECT * FROM t ORDER BY :col', { col: null }, [{ name: 'col', kind: 'identifier' }]),
        /^Error: :col cannot be NULL: it is an identifier\.$/
    );
});

test('applyQueryParameters falls back to NULL for a missing value when the default is NULL', () => {
    const params: SavedQueryParameter[] = [{ name: 'until', kind: 'date', defaultNull: true }];
    assert.equal(applyQueryParameters('SELECT :until', {}, params), 'SELECT NULL');
    assert.equal(applyQueryParameters('SELECT :until', { until: '' }, params), 'SELECT NULL');
    assert.equal(applyQueryParameters('SELECT :until', { until: '25.11.2026' }, params), `SELECT DATE '2026-11-25'`);
});

test('applyQueryParameters renders date and timestamp placeholders as typed literals', () => {
    assert.equal(
        applyQueryParameters(
            'SELECT * FROM t WHERE d = :d AND ts >= :ts',
            { d: '2026-11-25', ts: '25.11.2026 10:39' },
            [{ name: 'd', kind: 'date' }, { name: 'ts', kind: 'timestamp' }]
        ),
        `SELECT * FROM t WHERE d = DATE '2026-11-25' AND ts >= TIMESTAMP '2026-11-25 10:39:00'`
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

test('normalizeParameters keeps date and timestamp kinds and a NULL default instead of a default value', () => {
    assert.deepEqual(
        normalizeParameters([
            { name: 'd', kind: 'date', defaultValue: '2026-01-01' },
            { name: 'ts', kind: 'timestamp', defaultNull: true, defaultValue: 'ignored' },
            { name: 'col', kind: 'identifier', defaultNull: true, defaultValue: 'id' },
            { name: 'x', kind: 'text', defaultNull: 'yes' }
        ] as any),
        [
            { name: 'd', kind: 'date', defaultValue: '2026-01-01' },
            { name: 'ts', kind: 'timestamp', defaultNull: true },
            { name: 'col', kind: 'identifier', defaultValue: 'id' },
            { name: 'x', kind: 'text' }
        ]
    );
});

test('a NULL default survives the workspace file and a changed statement', () => {
    const stored = serializeWorkspaceQuery({
        id: '1', name: 'x', sql: 'SELECT :until', parameters: [{ name: 'until', kind: 'timestamp', defaultNull: true }]
    });
    const loaded = normalizeSavedQuery(JSON.parse(JSON.stringify(stored)))!;
    assert.deepEqual(loaded.parameters, [{ name: 'until', kind: 'timestamp', defaultNull: true }]);
    assert.deepEqual(
        mergeParameters('SELECT :until, :since', loaded.parameters),
        [{ name: 'until', kind: 'timestamp', defaultNull: true }, { name: 'since', kind: 'text' }]
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

test('serializeWorkspaceQuery strips lastUsed and scope', () => {
    const serialized = serializeWorkspaceQuery({
        id: '1', name: 'x', sql: 'SELECT 1', parameters: [], lastUsed: 1788762384116, scope: 'workspace'
    });
    assert.deepEqual(serialized, { id: '1', name: 'x', sql: 'SELECT 1', parameters: [] });
});

test('serializeWorkspaceQuery keeps schema and table', () => {
    const serialized = serializeWorkspaceQuery({
        id: '1', name: 'x', sql: 'SELECT 1', parameters: [], schema: 'public', table: 't', lastUsed: 42
    });
    assert.deepEqual(serialized, { id: '1', name: 'x', sql: 'SELECT 1', parameters: [], schema: 'public', table: 't' });
});

test('serializeWorkspaceQuery writes the keys in one fixed order, whatever order they were built in', () => {
    const asCreated = serializeWorkspaceQuery({
        name: 'x', sql: 'SELECT :a', parameters: [{ kind: 'number', name: 'a' } as SavedQueryParameter],
        schema: 'public', table: 't', tags: ['Reports'], lastUsed: 1, id: '1'
    } as SavedQuery);
    const asLoaded = serializeWorkspaceQuery(normalizeSavedQuery(JSON.parse(JSON.stringify(asCreated)))!);
    assert.deepEqual(Object.keys(asCreated), ['id', 'name', 'sql', 'parameters', 'schema', 'table', 'tags']);
    assert.deepEqual(Object.keys(asCreated.parameters[0]), ['name', 'kind']);
    assert.equal(JSON.stringify(asLoaded), JSON.stringify(asCreated));
});

test('serializeWorkspaceQuery keeps unknown keys after the known ones', () => {
    const serialized = serializeWorkspaceQuery({ extra: 1, id: '1', name: 'x', sql: 'SELECT 1', parameters: [] } as any);
    assert.deepEqual(Object.keys(serialized), ['id', 'name', 'sql', 'parameters', 'extra']);
});

test('fileContentDiffers ignores line endings but not content', () => {
    assert.equal(fileContentDiffers('{\n}\n', '{\n}\n'), false);
    assert.equal(fileContentDiffers('{\r\n}\r\n', '{\n}\n'), false);
    assert.equal(fileContentDiffers('{\n "a": 1\n}\n', '{\n "a": 2\n}\n'), true);
    assert.equal(fileContentDiffers(undefined, '{}\n'), true);
});

test('detectLineEnding follows the first line break and defaults to LF', () => {
    assert.equal(detectLineEnding('{\r\n}\r\n'), '\r\n');
    assert.equal(detectLineEnding('{\n}\n'), '\n');
    assert.equal(detectLineEnding('{\r\n}\n'), '\r\n');
    assert.equal(detectLineEnding('{}'), '\n');
    assert.equal(detectLineEnding(''), '\n');
    assert.equal(detectLineEnding(undefined), '\n');
});

test('withLineEnding rewrites every line break and leaves escaped ones in values alone', () => {
    const json = JSON.stringify({ sql: 'SELECT 1\r\nFROM t\n' }, null, 2) + '\n';
    const crlf = withLineEnding(json, '\r\n');
    assert.equal(crlf, '{\r\n  "sql": "SELECT 1\\r\\nFROM t\\n"\r\n}\r\n');
    assert.equal(withLineEnding(crlf, '\n'), json);
    assert.equal(withLineEnding(crlf, '\r\n'), crlf);
});

// ===== Workspace queries file =====

/**
 * Point the `vscode` stub at a throwaway folder and back its `workspace.fs`
 * with the real file system; returns the file path and a write counter.
 */
function useTempWorkspace(t: any): { file: string; writes: () => number } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pgqb-queries-'));
    const originalFolders = vscodeStub.workspace.workspaceFolders;
    const originalFs = vscodeStub.workspace.fs;
    const originalJoinPath = vscodeStub.Uri.joinPath;
    let writeCount = 0;

    vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: root, path: root } }];
    vscodeStub.workspace.fs = {
        async writeFile(uri: any, content: Uint8Array) { writeCount++; fs.writeFileSync(uri.fsPath, content); },
        async readFile(uri: any) { return fs.readFileSync(uri.fsPath); },
        async createDirectory(uri: any) { fs.mkdirSync(uri.fsPath, { recursive: true }); }
    } as any;
    vscodeStub.Uri.joinPath = (base: any, ...segs: string[]) => {
        const joined = path.join(base.fsPath, ...segs);
        return { fsPath: joined, path: joined };
    };

    t.after(() => {
        vscodeStub.workspace.workspaceFolders = originalFolders;
        vscodeStub.workspace.fs = originalFs;
        vscodeStub.Uri.joinPath = originalJoinPath;
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { file: path.join(root, 'postgres-query-builder.queries.json'), writes: () => writeCount };
}

test('running a new workspace query leaves the queries file unchanged', async (t) => {
    const ws = useTempWorkspace(t);
    const created = await new SavedQueryStore(createMockContext()).add({
        name: 'Open orders', sql: 'SELECT * FROM o WHERE s = :s',
        parameters: [{ name: 's', kind: 'text' }], schema: 'public', table: 'o', tags: ['Reports']
    }, 'workspace');
    const afterCreate = fs.readFileSync(ws.file, 'utf8');
    const written = JSON.parse(afterCreate).queries[0];
    assert.deepEqual(Object.keys(written), ['id', 'name', 'sql', 'parameters', 'schema', 'table', 'tags']);

    // The file is read back as on the next start, then the query is run.
    const writesBefore = ws.writes();
    await new SavedQueryStore(createMockContext()).touch(created.id);
    assert.equal(fs.readFileSync(ws.file, 'utf8'), afterCreate);
    assert.equal(ws.writes(), writesBefore, 'an unchanged file is not written again');
});

test('a queries file checked out with CRLF line endings is not rewritten by a run', async (t) => {
    const ws = useTempWorkspace(t);
    const created = await new SavedQueryStore(createMockContext()).add({
        name: 'Q', sql: 'SELECT 1', parameters: []
    }, 'workspace');
    const crlf = fs.readFileSync(ws.file, 'utf8').replace(/\n/g, '\r\n');
    fs.writeFileSync(ws.file, crlf);

    const writesBefore = ws.writes();
    await new SavedQueryStore(createMockContext()).touch(created.id);
    assert.equal(ws.writes(), writesBefore);
    assert.equal(fs.readFileSync(ws.file, 'utf8'), crlf);
});

test('editing a workspace query still writes the queries file', async (t) => {
    const ws = useTempWorkspace(t);
    const store = new SavedQueryStore(createMockContext());
    const created = await store.add({ name: 'Q', sql: 'SELECT 1', parameters: [] }, 'workspace');
    await store.update(created.id, { name: 'Renamed' });
    assert.equal(JSON.parse(fs.readFileSync(ws.file, 'utf8')).queries[0].name, 'Renamed');
});

test('editing a query in a CRLF queries file keeps CRLF and changes only the edited line', async (t) => {
    const ws = useTempWorkspace(t);
    const store = new SavedQueryStore(createMockContext());
    const created = await store.add({ name: 'Q', sql: 'SELECT 1', parameters: [] }, 'workspace');
    await store.add({ name: 'Other', sql: 'SELECT 2', parameters: [] }, 'workspace');
    const before = fs.readFileSync(ws.file, 'utf8').replace(/\n/g, '\r\n');
    fs.writeFileSync(ws.file, before);

    await new SavedQueryStore(createMockContext()).update(created.id, { name: 'Renamed' });
    const after = fs.readFileSync(ws.file, 'utf8');
    assert.equal(after.replace(/\r\n/g, '').includes('\n'), false, 'no bare LF is written');
    const beforeLines = before.split('\r\n');
    const afterLines = after.split('\r\n');
    assert.equal(afterLines.length, beforeLines.length);
    const changed = afterLines.filter((line, i) => line !== beforeLines[i]);
    assert.deepEqual(changed, ['      "name": "Renamed",']);
});

test('a new queries file is written with LF', async (t) => {
    const ws = useTempWorkspace(t);
    await new SavedQueryStore(createMockContext()).add({ name: 'Q', sql: 'SELECT 1', parameters: [] }, 'workspace');
    assert.equal(fs.readFileSync(ws.file, 'utf8').includes('\r'), false);
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

test('a remembered NULL value is kept as null, next to the remembered strings', async () => {
    const store = new SavedQueryStore(createMockContext());
    await store.setParameterValues('q1', { from: '2024-01-01', until: null, skipped: undefined as any });
    assert.deepEqual(store.getParameterValues('q1'), { from: '2024-01-01', until: null });
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

// ===== Tags (3.3.0) =====

test('normalizeTag trims levels, collapses whitespace and drops empty levels', () => {
    assert.equal(normalizeTag('  Reports  /  Monthly / '), 'Reports/Monthly');
    assert.equal(normalizeTag('Two   words'), 'Two words');
    assert.equal(normalizeTag(' / '), '');
    assert.equal(normalizeTag(42), '');
});

test('normalizeTags dedupes case-insensitively, keeps the first spelling and sorts', () => {
    assert.deepEqual(normalizeTags(['sales', 'Reports/Monthly', 'Sales', '', 'Reports']), ['Reports', 'Reports/Monthly', 'sales']);
    assert.deepEqual(normalizeTags('b, a ,,A'), ['a', 'b']);
    assert.deepEqual(normalizeTags(undefined), []);
});

test('compareTags sorts a folder before its subfolders', () => {
    assert.deepEqual(['A B', 'A/B', 'A'].sort(compareTags), ['A', 'A/B', 'A B']);
});

test('collectTags gathers every tag in use once', () => {
    assert.deepEqual(collectTags([
        { id: '1', name: 'a', sql: 'x', parameters: [], tags: ['Sales'] },
        { id: '2', name: 'b', sql: 'x', parameters: [], tags: ['sales', 'Ops'] },
        { id: '3', name: 'c', sql: 'x', parameters: [] }
    ]), ['Ops', 'Sales']);
});

test('withTag and withoutTag add and remove one tag case-insensitively', () => {
    assert.deepEqual(withTag(['A'], 'b'), ['A', 'b']);
    assert.deepEqual(withTag(['A'], 'a'), ['A']);
    assert.deepEqual(withTag(undefined, 'x'), ['x']);
    assert.deepEqual(withoutTag(['A', 'B'], 'a'), ['B']);
    assert.deepEqual(withoutTag(undefined, 'a'), []);
});

test('normalizeSavedQuery keeps a clean tag list and omits an empty one', () => {
    const tagged = normalizeSavedQuery({ id: '1', name: 'q', sql: 'SELECT 1', tags: [' Sales ', 'sales', 7] });
    assert.deepEqual(tagged?.tags, ['Sales']);
    const untagged = normalizeSavedQuery({ id: '1', name: 'q', sql: 'SELECT 1', tags: [] });
    assert.equal(untagged && 'tags' in untagged, false);
});

test('add and update store normalized tags and drop the field once it is empty', async () => {
    const store = new SavedQueryStore(createMockContext());
    const created = await store.add({ name: 'q', sql: 'SELECT 1', parameters: [], tags: ['b', ' a '] });
    assert.deepEqual(store.get(created.id)?.tags, ['a', 'b']);
    await store.update(created.id, { tags: ['Reports / Monthly'] });
    assert.deepEqual(store.get(created.id)?.tags, ['Reports/Monthly']);
    await store.update(created.id, { name: 'renamed' });
    assert.deepEqual(store.get(created.id)?.tags, ['Reports/Monthly'], 'a patch without tags keeps them');
    await store.update(created.id, { tags: [] });
    assert.equal('tags' in (store.get(created.id) as object), false);
});

test('addTag and removeTag change the tags of several queries at once', async () => {
    const store = new SavedQueryStore(createMockContext());
    const a = await store.add({ name: 'a', sql: 'SELECT 1', parameters: [], tags: ['Old'] });
    const b = await store.add({ name: 'b', sql: 'SELECT 2', parameters: [] });
    await store.addTag([a.id, b.id], 'Sales');
    assert.deepEqual(store.get(a.id)?.tags, ['Old', 'Sales']);
    assert.deepEqual(store.get(b.id)?.tags, ['Sales']);
    await store.removeTag([a.id, b.id], 'sales');
    assert.deepEqual(store.get(a.id)?.tags, ['Old']);
    assert.equal(store.get(b.id)?.tags, undefined);
    await store.removeTag([a.id]);
    assert.equal(store.get(a.id)?.tags, undefined, 'without a tag every tag is removed');
});