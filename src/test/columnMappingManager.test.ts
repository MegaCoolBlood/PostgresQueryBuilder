import test from 'node:test';
import assert from 'node:assert/strict';
import { ColumnMappingManager, CustomColumnMapping } from '../columnMappingManager';

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

function createSampleMapping(overrides: Partial<Omit<CustomColumnMapping, 'id'>> = {}): Omit<CustomColumnMapping, 'id'> {
    return {
        sourceSchema: 'public',
        sourceTable: 'items',
        sourceColumn: 'item_id',
        targetSchema: 'public',
        targetTable: 'cars',
        targetColumn: 'id',
        conditions: [],
        isDefault: false,
        ...overrides
    };
}

test('addMapping creates a mapping with a generated id', () => {
    const manager = new ColumnMappingManager(createMockContext());
    const result = manager.addMapping(createSampleMapping());

    assert.ok(result.id, 'should have an id');
    assert.equal(result.sourceTable, 'items');
    assert.equal(result.targetTable, 'cars');
});

test('getAllMappings returns all stored mappings', () => {
    const manager = new ColumnMappingManager(createMockContext());
    manager.addMapping(createSampleMapping());
    manager.addMapping(createSampleMapping({ sourceTable: 'orders' }));

    const all = manager.getAllMappings();
    assert.equal(all.length, 2);
});

test('getMappingsForTable filters by schema and table', () => {
    const manager = new ColumnMappingManager(createMockContext());
    manager.addMapping(createSampleMapping());
    manager.addMapping(createSampleMapping({ sourceSchema: 'other', sourceTable: 'items' }));
    manager.addMapping(createSampleMapping({ sourceTable: 'orders' }));

    const result = manager.getMappingsForTable('public', 'items');
    assert.equal(result.length, 1);
    assert.equal(result[0].sourceTable, 'items');
    assert.equal(result[0].sourceSchema, 'public');
});

test('getMappingsForColumn filters by schema, table, and column', () => {
    const manager = new ColumnMappingManager(createMockContext());
    manager.addMapping(createSampleMapping({ sourceColumn: 'item_id' }));
    manager.addMapping(createSampleMapping({ sourceColumn: 'other_col' }));

    const result = manager.getMappingsForColumn('public', 'items', 'item_id');
    assert.equal(result.length, 1);
    assert.equal(result[0].sourceColumn, 'item_id');
});

test('updateMapping modifies an existing mapping', () => {
    const manager = new ColumnMappingManager(createMockContext());
    const mapping = manager.addMapping(createSampleMapping());

    manager.updateMapping(mapping.id, { targetTable: 'trucks', isDefault: true });

    const all = manager.getAllMappings();
    assert.equal(all.length, 1);
    assert.equal(all[0].targetTable, 'trucks');
    assert.equal(all[0].isDefault, true);
    assert.equal(all[0].id, mapping.id);
});

test('updateMapping does nothing for non-existent id', () => {
    const manager = new ColumnMappingManager(createMockContext());
    manager.addMapping(createSampleMapping());

    manager.updateMapping('nonexistent', { targetTable: 'trucks' });

    const all = manager.getAllMappings();
    assert.equal(all.length, 1);
    assert.equal(all[0].targetTable, 'cars');
});

test('deleteMapping removes the mapping by id', () => {
    const manager = new ColumnMappingManager(createMockContext());
    const m1 = manager.addMapping(createSampleMapping());
    const m2 = manager.addMapping(createSampleMapping({ sourceColumn: 'type' }));

    manager.deleteMapping(m1.id);

    const all = manager.getAllMappings();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, m2.id);
});

test('deleteMapping does nothing for non-existent id', () => {
    const manager = new ColumnMappingManager(createMockContext());
    manager.addMapping(createSampleMapping());

    manager.deleteMapping('nonexistent');

    assert.equal(manager.getAllMappings().length, 1);
});

// ===== Condition Evaluation Tests =====

test('getApplicableMappings returns mapping when no conditions', () => {
    const manager = new ColumnMappingManager(createMockContext());
    manager.addMapping(createSampleMapping({ conditions: [] }));

    const result = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: 'car' });
    assert.equal(result.length, 1);
});

test('getApplicableMappings with equality condition matches', () => {
    const manager = new ColumnMappingManager(createMockContext());
    manager.addMapping(createSampleMapping({
        conditions: [{ column: 'type', operator: '=', value: 'car' }]
    }));

    const match = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: 'car' });
    assert.equal(match.length, 1);

    const noMatch = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: 'truck' });
    assert.equal(noMatch.length, 0);
});

test('getApplicableMappings with != condition', () => {
    const manager = new ColumnMappingManager(createMockContext());
    manager.addMapping(createSampleMapping({
        conditions: [{ column: 'type', operator: '!=', value: 'car' }]
    }));

    const match = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: 'truck' });
    assert.equal(match.length, 1);

    const noMatch = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: 'car' });
    assert.equal(noMatch.length, 0);
});

test('getApplicableMappings with > condition', () => {
    const manager = new ColumnMappingManager(createMockContext());
    manager.addMapping(createSampleMapping({
        conditions: [{ column: 'priority', operator: '>', value: '5' }]
    }));

    const match = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 1, priority: '9' });
    assert.equal(match.length, 1);

    const noMatch = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 1, priority: '3' });
    assert.equal(noMatch.length, 0);
});

test('getApplicableMappings with ILIKE condition (case-insensitive contains)', () => {
    const manager = new ColumnMappingManager(createMockContext());
    manager.addMapping(createSampleMapping({
        conditions: [{ column: 'type', operator: 'ILIKE', value: 'CAR' }]
    }));

    const match = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: 'racecar' });
    assert.equal(match.length, 1);

    const noMatch = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: 'truck' });
    assert.equal(noMatch.length, 0);
});

test('getApplicableMappings with LIKE condition (case-sensitive contains)', () => {
    const manager = new ColumnMappingManager(createMockContext());
    manager.addMapping(createSampleMapping({
        conditions: [{ column: 'type', operator: 'LIKE', value: 'Car' }]
    }));

    const match = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: 'raceCar' });
    assert.equal(match.length, 1);

    const noMatch = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: 'racecar' });
    assert.equal(noMatch.length, 0);
});

test('getApplicableMappings with multiple conditions (all must match)', () => {
    const manager = new ColumnMappingManager(createMockContext());
    manager.addMapping(createSampleMapping({
        conditions: [
            { column: 'type', operator: '=', value: 'car' },
            { column: 'status', operator: '=', value: 'active' }
        ]
    }));

    const match = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: 'car', status: 'active' });
    assert.equal(match.length, 1);

    const partialMatch = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: 'car', status: 'inactive' });
    assert.equal(partialMatch.length, 0);
});

test('getApplicableMappings with null row value does not match', () => {
    const manager = new ColumnMappingManager(createMockContext());
    manager.addMapping(createSampleMapping({
        conditions: [{ column: 'type', operator: '=', value: 'car' }]
    }));

    const result = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: null });
    assert.equal(result.length, 0);
});

test('getApplicableMappings with undefined row value does not match', () => {
    const manager = new ColumnMappingManager(createMockContext());
    manager.addMapping(createSampleMapping({
        conditions: [{ column: 'type', operator: '=', value: 'car' }]
    }));

    const result = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5 });
    assert.equal(result.length, 0);
});

test('getApplicableMappings filters multiple mappings by conditions', () => {
    const manager = new ColumnMappingManager(createMockContext());
    manager.addMapping(createSampleMapping({
        targetTable: 'cars',
        conditions: [{ column: 'type', operator: '=', value: 'car' }]
    }));
    manager.addMapping(createSampleMapping({
        targetTable: 'trucks',
        conditions: [{ column: 'type', operator: '=', value: 'truck' }]
    }));
    manager.addMapping(createSampleMapping({
        targetTable: 'all_vehicles',
        conditions: []
    }));

    const carRow = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: 'car' });
    assert.equal(carRow.length, 2); // cars + all_vehicles
    assert.ok(carRow.some(m => m.targetTable === 'cars'));
    assert.ok(carRow.some(m => m.targetTable === 'all_vehicles'));

    const truckRow = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: 'truck' });
    assert.equal(truckRow.length, 2); // trucks + all_vehicles
    assert.ok(truckRow.some(m => m.targetTable === 'trucks'));
    assert.ok(truckRow.some(m => m.targetTable === 'all_vehicles'));
});

test('addMapping preserves label and isDefault fields', () => {
    const manager = new ColumnMappingManager(createMockContext());
    const mapping = manager.addMapping(createSampleMapping({
        label: 'Item to Car',
        isDefault: true
    }));

    assert.equal(mapping.label, 'Item to Car');
    assert.equal(mapping.isDefault, true);
});

test('generated ids are unique', () => {
    const manager = new ColumnMappingManager(createMockContext());
    const m1 = manager.addMapping(createSampleMapping());
    const m2 = manager.addMapping(createSampleMapping());

    assert.notEqual(m1.id, m2.id);
});
