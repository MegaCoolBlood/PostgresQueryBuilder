import './helpers/vscodeMock';
import { vscodeStub } from './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ColumnMappingManager, CustomColumnMapping, normalizeWorkspaceRelativePath } from '../columnMappingManager';

function createMockContext() {
    const store: Record<string, any> = {};
    return {
        subscriptions: { push: (_: any) => {} },
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

test('addMapping creates a mapping with a generated id', async () => {
    const manager = new ColumnMappingManager(createMockContext());
    const result = await manager.addMapping(createSampleMapping());

    assert.ok(result.id, 'should have an id');
    assert.equal(result.sourceTable, 'items');
    assert.equal(result.targetTable, 'cars');
});

test('getAllMappings returns all stored mappings', async () => {
    const manager = new ColumnMappingManager(createMockContext());
    await manager.addMapping(createSampleMapping());
    await manager.addMapping(createSampleMapping({ sourceTable: 'orders' }));

    const all = manager.getAllMappings();
    assert.equal(all.length, 2);
});

test('getMappingsForTable filters by schema and table', async () => {
    const manager = new ColumnMappingManager(createMockContext());
    await manager.addMapping(createSampleMapping());
    await manager.addMapping(createSampleMapping({ sourceSchema: 'other', sourceTable: 'items' }));
    await manager.addMapping(createSampleMapping({ sourceTable: 'orders' }));

    const result = manager.getMappingsForTable('public', 'items');
    // Reverse mappings appear for tables that are targets; sources public.items targets public.cars,
    // so cars-side would get a reverse but items-side gets just the forward mapping.
    const forward = result.filter(m => !m.reversed);
    assert.equal(forward.length, 1);
    assert.equal(forward[0].sourceTable, 'items');
    assert.equal(forward[0].sourceSchema, 'public');
});

test('getMappingsForColumn filters by schema, table, and column', async () => {
    const manager = new ColumnMappingManager(createMockContext());
    await manager.addMapping(createSampleMapping({ sourceColumn: 'item_id' }));
    await manager.addMapping(createSampleMapping({ sourceColumn: 'other_col' }));

    const result = manager.getMappingsForColumn('public', 'items', 'item_id').filter(m => !m.reversed);
    assert.equal(result.length, 1);
    assert.equal(result[0].sourceColumn, 'item_id');
});

test('updateMapping modifies an existing mapping', async () => {
    const manager = new ColumnMappingManager(createMockContext());
    const mapping = await manager.addMapping(createSampleMapping());

    await manager.updateMapping(mapping.id, { targetTable: 'trucks', isDefault: true });

    const all = manager.getAllMappings();
    assert.equal(all.length, 1);
    assert.equal(all[0].targetTable, 'trucks');
    assert.equal(all[0].isDefault, true);
    assert.equal(all[0].id, mapping.id);
});

test('updateMapping does nothing for non-existent id', async () => {
    const manager = new ColumnMappingManager(createMockContext());
    await manager.addMapping(createSampleMapping());

    await manager.updateMapping('nonexistent', { targetTable: 'trucks' });

    const all = manager.getAllMappings();
    assert.equal(all.length, 1);
    assert.equal(all[0].targetTable, 'cars');
});

test('deleteMapping removes the mapping by id', async () => {
    const manager = new ColumnMappingManager(createMockContext());
    const m1 = await manager.addMapping(createSampleMapping());
    const m2 = await manager.addMapping(createSampleMapping({ sourceColumn: 'type' }));

    await manager.deleteMapping(m1.id);

    const all = manager.getAllMappings();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, m2.id);
});

test('deleteMapping does nothing for non-existent id', async () => {
    const manager = new ColumnMappingManager(createMockContext());
    await manager.addMapping(createSampleMapping());

    await manager.deleteMapping('nonexistent');

    assert.equal(manager.getAllMappings().length, 1);
});

// ===== Condition Evaluation Tests =====

test('getApplicableMappings returns mapping when no conditions', async () => {
    const manager = new ColumnMappingManager(createMockContext());
    await manager.addMapping(createSampleMapping({ conditions: [] }));

    const result = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: 'car' });
    assert.equal(result.filter(m => !m.reversed).length, 1);
});

test('reverse mapping carries the forward conditions as targetConditions', async () => {
    const manager = new ColumnMappingManager(createMockContext());
    await manager.addMapping(createSampleMapping({
        conditions: [{ column: 'type', operator: '=', value: 'car' }]
    }));

    // From the target table (public.cars) the mapping appears reversed.
    const reverse = manager.getMappingsForTable('public', 'cars').find(m => m.reversed);
    assert.ok(reverse, 'a reverse mapping should be offered on the target table');
    // The reverse mapping itself is unconditionally applicable (its own
    // conditions are empty), but it remembers the original conditions to apply
    // to the navigation target's WHERE clause.
    assert.deepEqual(reverse!.conditions, []);
    assert.deepEqual(reverse!.targetConditions, [{ column: 'type', operator: '=', value: 'car' }]);
});

test('forward mapping has no targetConditions', async () => {
    const manager = new ColumnMappingManager(createMockContext());
    await manager.addMapping(createSampleMapping({
        conditions: [{ column: 'type', operator: '=', value: 'car' }]
    }));

    const forward = manager.getMappingsForTable('public', 'items').find(m => !m.reversed);
    assert.ok(forward);
    assert.equal(forward!.targetConditions, undefined);
});

test('reverse mapping without conditions has no targetConditions', async () => {
    const manager = new ColumnMappingManager(createMockContext());
    await manager.addMapping(createSampleMapping({ conditions: [] }));

    const reverse = manager.getMappingsForTable('public', 'cars').find(m => m.reversed);
    assert.ok(reverse);
    assert.equal(reverse!.targetConditions, undefined);
});

test('getApplicableMappings with equality condition matches', async () => {
    const manager = new ColumnMappingManager(createMockContext());
    await manager.addMapping(createSampleMapping({
        conditions: [{ column: 'type', operator: '=', value: 'car' }]
    }));

    const match = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: 'car' }).filter(m => !m.reversed);
    assert.equal(match.length, 1);

    const noMatch = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: 'truck' }).filter(m => !m.reversed);
    assert.equal(noMatch.length, 0);
});

test('getApplicableMappings with != condition', async () => {
    const manager = new ColumnMappingManager(createMockContext());
    await manager.addMapping(createSampleMapping({
        conditions: [{ column: 'type', operator: '!=', value: 'car' }]
    }));

    const match = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: 'truck' }).filter(m => !m.reversed);
    assert.equal(match.length, 1);

    const noMatch = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: 'car' }).filter(m => !m.reversed);
    assert.equal(noMatch.length, 0);
});

test('getApplicableMappings with > condition', async () => {
    const manager = new ColumnMappingManager(createMockContext());
    await manager.addMapping(createSampleMapping({
        conditions: [{ column: 'priority', operator: '>', value: '5' }]
    }));

    const match = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 1, priority: '9' }).filter(m => !m.reversed);
    assert.equal(match.length, 1);

    const noMatch = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 1, priority: '3' }).filter(m => !m.reversed);
    assert.equal(noMatch.length, 0);
});

test('getApplicableMappings with ILIKE condition (case-insensitive contains)', async () => {
    const manager = new ColumnMappingManager(createMockContext());
    await manager.addMapping(createSampleMapping({
        conditions: [{ column: 'type', operator: 'ILIKE', value: 'CAR' }]
    }));

    const match = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: 'racecar' }).filter(m => !m.reversed);
    assert.equal(match.length, 1);

    const noMatch = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: 'truck' }).filter(m => !m.reversed);
    assert.equal(noMatch.length, 0);
});

test('getApplicableMappings with LIKE condition (case-sensitive contains)', async () => {
    const manager = new ColumnMappingManager(createMockContext());
    await manager.addMapping(createSampleMapping({
        conditions: [{ column: 'type', operator: 'LIKE', value: 'Car' }]
    }));

    const match = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: 'raceCar' }).filter(m => !m.reversed);
    assert.equal(match.length, 1);

    const noMatch = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: 'racecar' }).filter(m => !m.reversed);
    assert.equal(noMatch.length, 0);
});

test('getApplicableMappings with multiple conditions (all must match)', async () => {
    const manager = new ColumnMappingManager(createMockContext());
    await manager.addMapping(createSampleMapping({
        conditions: [
            { column: 'type', operator: '=', value: 'car' },
            { column: 'status', operator: '=', value: 'active' }
        ]
    }));

    const match = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: 'car', status: 'active' }).filter(m => !m.reversed);
    assert.equal(match.length, 1);

    const partialMatch = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: 'car', status: 'inactive' }).filter(m => !m.reversed);
    assert.equal(partialMatch.length, 0);
});

test('getApplicableMappings with null row value does not match', async () => {
    const manager = new ColumnMappingManager(createMockContext());
    await manager.addMapping(createSampleMapping({
        conditions: [{ column: 'type', operator: '=', value: 'car' }]
    }));

    const result = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: null }).filter(m => !m.reversed);
    assert.equal(result.length, 0);
});

test('getApplicableMappings with undefined row value does not match', async () => {
    const manager = new ColumnMappingManager(createMockContext());
    await manager.addMapping(createSampleMapping({
        conditions: [{ column: 'type', operator: '=', value: 'car' }]
    }));

    const result = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5 }).filter(m => !m.reversed);
    assert.equal(result.length, 0);
});

test('getApplicableMappings filters multiple mappings by conditions', async () => {
    const manager = new ColumnMappingManager(createMockContext());
    await manager.addMapping(createSampleMapping({
        targetTable: 'cars',
        conditions: [{ column: 'type', operator: '=', value: 'car' }]
    }));
    await manager.addMapping(createSampleMapping({
        targetTable: 'trucks',
        conditions: [{ column: 'type', operator: '=', value: 'truck' }]
    }));
    await manager.addMapping(createSampleMapping({
        targetTable: 'all_vehicles',
        conditions: []
    }));

    const carRow = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: 'car' }).filter(m => !m.reversed);
    assert.equal(carRow.length, 2); // cars + all_vehicles
    assert.ok(carRow.some(m => m.targetTable === 'cars'));
    assert.ok(carRow.some(m => m.targetTable === 'all_vehicles'));

    const truckRow = manager.getApplicableMappings('public', 'items', 'item_id', { item_id: 5, type: 'truck' }).filter(m => !m.reversed);
    assert.equal(truckRow.length, 2); // trucks + all_vehicles
    assert.ok(truckRow.some(m => m.targetTable === 'trucks'));
    assert.ok(truckRow.some(m => m.targetTable === 'all_vehicles'));
});

test('addMapping preserves label and isDefault fields', async () => {
    const manager = new ColumnMappingManager(createMockContext());
    const mapping = await manager.addMapping(createSampleMapping({
        label: 'Item to Car',
        isDefault: true
    }));

    assert.equal(mapping.label, 'Item to Car');
    assert.equal(mapping.isDefault, true);
});

test('generated ids are unique', async () => {
    const manager = new ColumnMappingManager(createMockContext());
    const m1 = await manager.addMapping(createSampleMapping());
    const m2 = await manager.addMapping(createSampleMapping());

    assert.notEqual(m1.id, m2.id);
});

// ===== Multi-column (composite-key) mapping tests =====

test('addMapping preserves additionalColumnPairs', async () => {
    const manager = new ColumnMappingManager(createMockContext());
    const mapping = await manager.addMapping(createSampleMapping({
        additionalColumnPairs: [
            { sourceColumn: 'tenant_id', targetColumn: 'tenant_id' },
            { sourceColumn: 'region', targetColumn: 'region' }
        ]
    }));

    assert.deepEqual(mapping.additionalColumnPairs, [
        { sourceColumn: 'tenant_id', targetColumn: 'tenant_id' },
        { sourceColumn: 'region', targetColumn: 'region' }
    ]);
});

test('reverse mapping swaps source/target of additional column pairs', async () => {
    const manager = new ColumnMappingManager(createMockContext());
    await manager.addMapping(createSampleMapping({
        additionalColumnPairs: [
            { sourceColumn: 'tenant_id', targetColumn: 'org_id' }
        ]
    }));

    // public.cars is the target, so it gets a reversed view of the mapping.
    const reversed = manager.getMappingsForTable('public', 'cars').filter(m => m.reversed);
    assert.equal(reversed.length, 1);
    assert.equal(reversed[0].sourceColumn, 'id');
    assert.equal(reversed[0].targetColumn, 'item_id');
    assert.deepEqual(reversed[0].additionalColumnPairs, [
        { sourceColumn: 'org_id', targetColumn: 'tenant_id' }
    ]);
});

test('normalizeColumnPairs drops malformed entries', () => {
    const { normalizeColumnPairs } = require('../columnMappingManager');
    const result = normalizeColumnPairs([
        { sourceColumn: 'a', targetColumn: 'b' },
        { sourceColumn: '', targetColumn: 'b' },
        { sourceColumn: 'c', targetColumn: '' },
        { sourceColumn: '  d  ', targetColumn: '  e  ' },
        { foo: 'bar' },
        null
    ]);
    assert.deepEqual(result, [
        { sourceColumn: 'a', targetColumn: 'b' },
        { sourceColumn: 'd', targetColumn: 'e' }
    ]);
});

test('normalizeColumnPairs returns empty array for non-array input', () => {
    const { normalizeColumnPairs } = require('../columnMappingManager');
    assert.deepEqual(normalizeColumnPairs(undefined), []);
    assert.deepEqual(normalizeColumnPairs(null), []);
    assert.deepEqual(normalizeColumnPairs('nope'), []);
});

// ===== Workspace mappings file =====

const WORKSPACE_FILE = 'postgres-query-builder.mappings.json';

/**
 * Point the `vscode` stub at a throwaway folder and back its `workspace.fs`
 * with the real file system, so the workspace mappings file is actually written.
 */
function useTempWorkspace(t: any): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pgqb-mappings-'));
    const originalFolders = vscodeStub.workspace.workspaceFolders;
    const originalFs = vscodeStub.workspace.fs;
    const originalJoinPath = vscodeStub.Uri.joinPath;

    vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: root, path: root } }];
    vscodeStub.workspace.fs = {
        async writeFile(uri: any, content: Uint8Array) { fs.writeFileSync(uri.fsPath, content); },
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
    return root;
}

function readWorkspaceFile(root: string): any {
    return JSON.parse(fs.readFileSync(path.join(root, WORKSPACE_FILE), 'utf8'));
}

test('normalizeWorkspaceRelativePath keeps a plain posix path', () => {
    assert.equal(
        normalizeWorkspaceRelativePath('.vscode/postgres-query-builder.mappings.json'),
        '.vscode/postgres-query-builder.mappings.json'
    );
});

test('normalizeWorkspaceRelativePath rewrites backslashes and strips path prefixes', () => {
    assert.equal(normalizeWorkspaceRelativePath('.vscode\\mappings.json'), '.vscode/mappings.json');
    assert.equal(normalizeWorkspaceRelativePath('./shared/mappings.json'), 'shared/mappings.json');
    assert.equal(normalizeWorkspaceRelativePath('/shared/mappings.json'), 'shared/mappings.json');
});

test('normalizeWorkspaceRelativePath falls back to the default for empty values', () => {
    assert.equal(normalizeWorkspaceRelativePath(''), 'postgres-query-builder.mappings.json');
    assert.equal(normalizeWorkspaceRelativePath('   '), 'postgres-query-builder.mappings.json');
    assert.equal(normalizeWorkspaceRelativePath(undefined), 'postgres-query-builder.mappings.json');
});

test('addMapping with workspace scope creates the shared file in the project root', async (t) => {
    const root = useTempWorkspace(t);
    const manager = new ColumnMappingManager(createMockContext());

    const created = await manager.addMapping(createSampleMapping(), 'workspace');

    assert.equal(created.scope, 'workspace');
    assert.ok(fs.existsSync(path.join(root, WORKSPACE_FILE)), 'the workspace file should exist');
    const file = readWorkspaceFile(root);
    assert.equal(file.version, 1);
    assert.equal(file.mappings.length, 1);
    assert.equal(file.mappings[0].sourceTable, 'items');
    assert.equal(file.mappings[0].scope, undefined, 'the scope is implied by the file, not stored in it');
});

test('createWorkspaceFile creates an empty shared file before any mapping is shared', async (t) => {
    const root = useTempWorkspace(t);
    const manager = new ColumnMappingManager(createMockContext());

    assert.equal(manager.hasWorkspaceFile(), false);
    const uri = await manager.createWorkspaceFile();

    assert.ok(uri, 'a uri should be returned');
    assert.equal(manager.hasWorkspaceFile(), true);
    assert.deepEqual(readWorkspaceFile(root).mappings, []);
});

test('updateMapping moves a personal mapping into the shared file', async (t) => {
    const root = useTempWorkspace(t);
    const manager = new ColumnMappingManager(createMockContext());
    const personal = await manager.addMapping(createSampleMapping(), 'global');
    assert.equal(fs.existsSync(path.join(root, WORKSPACE_FILE)), false);

    await manager.updateMapping(personal.id, { scope: 'workspace' });

    const file = readWorkspaceFile(root);
    assert.equal(file.mappings.length, 1);
    assert.equal(file.mappings[0].id, personal.id);
    assert.deepEqual(manager.getAllMappings().map(m => m.scope), ['workspace']);
});

test('updateMapping moves a shared mapping back out of the file', async (t) => {
    const root = useTempWorkspace(t);
    const manager = new ColumnMappingManager(createMockContext());
    const shared = await manager.addMapping(createSampleMapping(), 'workspace');

    await manager.updateMapping(shared.id, { scope: 'global' });

    assert.deepEqual(readWorkspaceFile(root).mappings, []);
    assert.deepEqual(manager.getAllMappings().map(m => m.scope), ['global']);
});

test('a mapping written to the shared file is read back by a new manager', async (t) => {
    const root = useTempWorkspace(t);
    const context = createMockContext();
    await new ColumnMappingManager(context).addMapping(createSampleMapping({ label: 'Shared' }), 'workspace');

    const reopened = new ColumnMappingManager(context).getAllMappings();

    assert.equal(reopened.length, 1);
    assert.equal(reopened[0].label, 'Shared');
    assert.equal(reopened[0].scope, 'workspace');
    assert.ok(root);
});

test('a configured path decides where the shared file is written', async (t) => {
    const root = useTempWorkspace(t);
    const originalGetConfiguration = vscodeStub.workspace.getConfiguration;
    vscodeStub.workspace.getConfiguration = () => ({
        get<T>(key: string, defaultValue?: T): T {
            return (key === 'customMappingsFile' ? 'config/team-mappings.json' : defaultValue) as T;
        }
    });
    t.after(() => { vscodeStub.workspace.getConfiguration = originalGetConfiguration; });

    const manager = new ColumnMappingManager(createMockContext());
    await manager.addMapping(createSampleMapping(), 'workspace');

    assert.ok(fs.existsSync(path.join(root, 'config', 'team-mappings.json')), 'the configured path should be used');
    assert.equal(fs.existsSync(path.join(root, WORKSPACE_FILE)), false, 'the default path should stay unused');
});

test('a configured path with backslashes still lands in the intended folder', async (t) => {
    const root = useTempWorkspace(t);
    const originalGetConfiguration = vscodeStub.workspace.getConfiguration;
    vscodeStub.workspace.getConfiguration = () => ({
        get<T>(key: string, defaultValue?: T): T {
            return (key === 'customMappingsFile' ? 'shared\\mappings.json' : defaultValue) as T;
        }
    });
    t.after(() => { vscodeStub.workspace.getConfiguration = originalGetConfiguration; });

    const manager = new ColumnMappingManager(createMockContext());
    await manager.addMapping(createSampleMapping(), 'workspace');

    assert.ok(fs.existsSync(path.join(root, 'shared', 'mappings.json')), 'the file should live in the shared folder');
});

test('without a workspace folder a shared mapping is kept personal and reported', async (t) => {
    const originalFolders = vscodeStub.workspace.workspaceFolders;
    const warnings: string[] = [];
    const originalWarn = vscodeStub.window.showWarningMessage;
    vscodeStub.workspace.workspaceFolders = undefined;
    vscodeStub.window.showWarningMessage = (msg: string) => { warnings.push(msg); return Promise.resolve(undefined); };
    t.after(() => {
        vscodeStub.workspace.workspaceFolders = originalFolders;
        vscodeStub.window.showWarningMessage = originalWarn;
    });

    const manager = new ColumnMappingManager(createMockContext());
    const created = await manager.addMapping(createSampleMapping(), 'workspace');

    assert.equal(created.scope, 'global');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /no workspace folder is open/i);
});
