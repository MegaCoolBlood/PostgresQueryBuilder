import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDropScript, buildGoToItems, ddlTargetOf, ddlTargetsOf, sortDefinitions } from '../databaseObjectCommands';
import type { DbObject, ObjectNode } from '../objectNavigator';
import type { TableNode } from '../tableExplorer';
import type { LocatedDefinition } from '../repositoryComparison';

function dbObject(overrides: Partial<DbObject>): DbObject {
    return {
        kind: 'function', oid: 1, schema: 'app', name: 'f', args: null, argTypes: null, detail: null,
        relSchema: null, relName: null, relColumn: null, owner: null, language: null, comment: null, fromExtension: false,
        ...overrides
    };
}

function objectNode(db: DbObject | undefined, overrides: Partial<ObjectNode> = {}): ObjectNode {
    return {
        type: 'object', kind: db?.kind ?? 'function', schema: db?.schema ?? 'app', name: db?.name ?? 'f',
        args: db?.args ?? null, db, definitions: [], ...overrides
    };
}

// ===== ddlTargetOf =====

test('ddlTargetOf turns the nodes of both views into DDL targets', () => {
    assert.deepEqual(ddlTargetOf(objectNode(dbObject({ kind: 'function', oid: 7, args: 'a integer' }))),
        { kind: 'function', schema: 'app', name: 'f', args: 'a integer', oid: 7 });
    assert.deepEqual(ddlTargetOf(objectNode(dbObject({ kind: 'trigger', oid: 9, name: 'audit', relSchema: 'app', relName: 'orders' }))),
        { kind: 'trigger', schema: 'app', name: 'audit', table: 'orders', oid: 9 });
    assert.deepEqual(ddlTargetOf({ type: 'table', schema: 'app', table: 'orders', kind: 'matview' }),
        { kind: 'matview', schema: 'app', name: 'orders' });
    assert.deepEqual(ddlTargetOf({ type: 'schema', schema: 'app' }), { kind: 'schema', schema: 'app', name: 'app' });
});

test('ddlTargetOf has no target for groups and for objects that exist only in the repository', () => {
    assert.equal(ddlTargetOf({ type: 'category', schema: 'app', kind: 'table' }), undefined);
    assert.equal(ddlTargetOf({ type: 'extensions' }), undefined);
    assert.equal(ddlTargetOf(objectNode(undefined, { status: 'repoOnly' })), undefined);
    assert.equal(ddlTargetOf({ type: 'table', schema: 'app', table: 'planned', kind: 'table', status: 'repoOnly' }), undefined);
    assert.equal(ddlTargetOf({ type: 'schema', schema: 'planned', status: 'repoOnly', definitions: [] }), undefined);
});

test('ddlTargetsOf uses the whole selection, without duplicates and skipping what has no DDL', () => {
    const a = objectNode(dbObject({ oid: 1, name: 'a' }));
    const b = objectNode(dbObject({ oid: 2, name: 'b' }));
    const targets = ddlTargetsOf(a, [a, b, a, { type: 'category', schema: 'app', kind: 'table' }]);
    assert.deepEqual(targets.map(t => t.name), ['a', 'b']);
    assert.deepEqual(ddlTargetsOf(b, undefined).map(t => t.name), ['b'], 'a menu run without selection uses the clicked node');
});

test('buildDropScript drops in reverse order of the selection', () => {
    assert.equal(
        buildDropScript([{ kind: 'table', schema: 'app', name: 'parent' }, { kind: 'table', schema: 'app', name: 'child' }]),
        'DROP TABLE IF EXISTS app.child;\nDROP TABLE IF EXISTS app.parent;\n'
    );
});

// ===== Go to Database Object =====

test('buildGoToItems lists objects and relations by name with their kind, schema and repository status', () => {
    const objects = [
        objectNode(dbObject({ kind: 'function', name: 'total', args: 'a integer', detail: 'numeric' }), { status: 'dbOnly' }),
        objectNode(dbObject({ kind: 'extension', schema: 'public', name: 'postgis', detail: '3.4' })),
        objectNode(undefined, { kind: 'procedure', name: 'archive', args: 'integer', status: 'repoOnly' })
    ];
    const relations: TableNode[] = [{ type: 'table', schema: 'sales', table: 'orders', kind: 'table', status: 'both' }];
    const items = buildGoToItems(objects, relations);
    assert.deepEqual(items.map(i => [i.label, i.description, i.detail, i.target.view]), [
        ['$(gear) archive(integer)', 'app · Procedure · only in repository', undefined, 'objects'],
        ['$(table) orders', 'sales · Table', undefined, 'tables'],
        ['$(extensions) postgis', 'Extension', '3.4 · public', 'objects'],
        ['$(symbol-method) total(a integer)', 'app · Function · not in repository', '→ numeric', 'objects']
    ]);
});

test('sortDefinitions orders the places of a definition by file and line', () => {
    const def = (uri: string, line: number): LocatedDefinition => ({
        kind: 'table', schema: null, name: 't', argTypes: null, searchPath: null, uri,
        start: { line, character: 0 }, end: { line, character: 1 }
    });
    assert.deepEqual(sortDefinitions([def('b.sql', 1), def('a.sql', 9), def('a.sql', 2)]).map(d => `${d.uri}:${d.start.line}`),
        ['a.sql:2', 'a.sql:9', 'b.sql:1']);
});
