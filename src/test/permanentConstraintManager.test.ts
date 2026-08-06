import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PermanentConstraintManager,
    normalizeConstraints,
    normalizeSorts,
    ConstraintCondition,
    ConstraintSort
} from '../permanentConstraintManager';

function createMockContext() {
    const store: Record<string, any> = {};
    return {
        subscriptions: { push: (_: any) => {} },
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

// ===== normalizeConstraints =====

test('normalizeConstraints returns empty array for non-array input', () => {
    assert.deepEqual(normalizeConstraints(undefined), []);
    assert.deepEqual(normalizeConstraints(null), []);
    assert.deepEqual(normalizeConstraints('nope' as any), []);
});

test('normalizeConstraints keeps a well-formed binary condition', () => {
    const input: ConstraintCondition[] = [
        { operator: '=', left: { kind: 'column', column: 'status' }, right: { kind: 'raw', text: "'active'" } }
    ];
    assert.deepEqual(normalizeConstraints(input), input);
});

test('normalizeConstraints keeps a BETWEEN condition with both operands', () => {
    const input: ConstraintCondition[] = [
        {
            operator: 'BETWEEN',
            left: { kind: 'raw', text: 'CURRENT_TIMESTAMP' },
            right: { kind: 'column', column: 'valid_from' },
            right2: { kind: 'column', column: 'valid_to' }
        }
    ];
    assert.deepEqual(normalizeConstraints(input), input);
});

test('normalizeConstraints drops conditions missing operator or left operand', () => {
    const input = [
        { operator: '', left: { kind: 'column', column: 'a' } },
        { operator: '=', left: { kind: 'column', column: '' } },
        { operator: '=', left: undefined }
    ];
    assert.deepEqual(normalizeConstraints(input as any), []);
});

test('normalizeConstraints drops malformed operands but keeps the condition', () => {
    const input = [
        { operator: 'IS NULL', left: { kind: 'column', column: 'deleted_at' }, right: { kind: 'bogus' } }
    ];
    assert.deepEqual(normalizeConstraints(input as any), [
        { operator: 'IS NULL', left: { kind: 'column', column: 'deleted_at' } }
    ]);
});

// ===== PermanentConstraintManager =====

test('getConstraints returns empty array when nothing is stored', () => {
    const manager = new PermanentConstraintManager(createMockContext());
    assert.deepEqual(manager.getConstraints('public', 'orders'), []);
});

test('setConstraints persists and getConstraints reads them back', async () => {
    const manager = new PermanentConstraintManager(createMockContext());
    const conditions: ConstraintCondition[] = [
        { operator: '=', left: { kind: 'column', column: 'status' }, right: { kind: 'raw', text: "'active'" } }
    ];
    await manager.setConstraints('public', 'orders', conditions);
    assert.deepEqual(manager.getConstraints('public', 'orders'), conditions);
});

test('setConstraints keys constraints per schema.table', async () => {
    const manager = new PermanentConstraintManager(createMockContext());
    await manager.setConstraints('public', 'orders', [
        { operator: '=', left: { kind: 'column', column: 'a' }, right: { kind: 'raw', text: '1' } }
    ]);
    assert.deepEqual(manager.getConstraints('public', 'customers'), []);
});

test('setConstraints with only malformed conditions removes the entry', async () => {
    const manager = new PermanentConstraintManager(createMockContext());
    await manager.setConstraints('public', 'orders', [
        { operator: '=', left: { kind: 'column', column: 'status' }, right: { kind: 'raw', text: "'x'" } }
    ]);
    await manager.setConstraints('public', 'orders', [{ operator: '', left: { kind: 'column', column: '' } } as any]);
    assert.deepEqual(manager.getConstraints('public', 'orders'), []);
});

// ===== 2.2.3: permanent sort orders =====

test('normalizeSorts returns empty array for non-array input', () => {
    assert.deepEqual(normalizeSorts(undefined), []);
    assert.deepEqual(normalizeSorts(null), []);
    assert.deepEqual(normalizeSorts('nope' as any), []);
});

test('normalizeSorts keeps well-formed entries', () => {
    const input: ConstraintSort[] = [
        { column: 'created_at', direction: 'DESC' },
        { column: 'name', direction: 'ASC' }
    ];
    assert.deepEqual(normalizeSorts(input), input);
});

test('normalizeSorts defaults an unknown direction to ASC', () => {
    assert.deepEqual(
        normalizeSorts([{ column: 'name' }, { column: 'age', direction: 'sideways' }] as any),
        [{ column: 'name', direction: 'ASC' }, { column: 'age', direction: 'ASC' }]
    );
});

test('normalizeSorts accepts a lowercase direction', () => {
    assert.deepEqual(
        normalizeSorts([{ column: 'name', direction: 'desc' }] as any),
        [{ column: 'name', direction: 'DESC' }]
    );
});

test('normalizeSorts drops entries without a column name', () => {
    assert.deepEqual(
        normalizeSorts([{ column: '', direction: 'ASC' }, { direction: 'DESC' }, { column: '  ' }] as any),
        []
    );
});

test('getSorts returns empty array when nothing is stored', () => {
    const manager = new PermanentConstraintManager(createMockContext());
    assert.deepEqual(manager.getSorts('public', 'orders'), []);
});

test('setSorts persists and getSorts reads them back', async () => {
    const manager = new PermanentConstraintManager(createMockContext());
    const sorts: ConstraintSort[] = [{ column: 'created_at', direction: 'DESC' }];
    await manager.setSorts('public', 'orders', sorts);
    assert.deepEqual(manager.getSorts('public', 'orders'), sorts);
});

test('setSorts keys sorts per schema.table', async () => {
    const manager = new PermanentConstraintManager(createMockContext());
    await manager.setSorts('public', 'orders', [{ column: 'id', direction: 'ASC' }]);
    assert.deepEqual(manager.getSorts('public', 'customers'), []);
});

test('setSorts with only malformed entries removes the entry', async () => {
    const manager = new PermanentConstraintManager(createMockContext());
    await manager.setSorts('public', 'orders', [{ column: 'id', direction: 'ASC' }]);
    await manager.setSorts('public', 'orders', [{ column: '' } as any]);
    assert.deepEqual(manager.getSorts('public', 'orders'), []);
});

test('sorts and constraints are stored independently of each other', async () => {
    const manager = new PermanentConstraintManager(createMockContext());
    const conditions: ConstraintCondition[] = [
        { operator: '=', left: { kind: 'column', column: 'status' }, right: { kind: 'raw', text: "'active'" } }
    ];
    await manager.setConstraints('public', 'orders', conditions);
    await manager.setSorts('public', 'orders', [{ column: 'created_at', direction: 'DESC' }]);

    await manager.setSorts('public', 'orders', []);
    assert.deepEqual(manager.getConstraints('public', 'orders'), conditions);
    assert.deepEqual(manager.getSorts('public', 'orders'), []);
});
