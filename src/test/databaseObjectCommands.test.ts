import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DdlContentProvider,
    buildDropScript,
    buildGoToItems,
    ddlTargetOf,
    ddlTargetsOf,
    formatForCompare,
    resolvedFromNode,
    sortDefinitions,
    statementText,
    unwrapNode
} from '../databaseObjectCommands';
import type { DbObject, ObjectNode } from '../objectNavigator';
import type { TableNode } from '../tableExplorer';
import { DefinitionMatcher, type LocatedDefinition } from '../repositoryComparison';
import { DbIndex } from '../databaseCatalog';
import { scanSqlText } from '../repositoryScanner';

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

// ===== editor commands =====

const REPO_SQL = [
    'CREATE FUNCTION app.f(a integer) RETURNS integer',
    '  LANGUAGE sql AS $$ SELECT a $$ ;',
    'CREATE TABLE app.orders (id int);',
    'CREATE FUNCTION app.repo_only() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$'
].join('\n');

function repoDefinitions(): LocatedDefinition[] {
    return scanSqlText(REPO_SQL).map(d => ({ ...d, uri: 'file:///repo.sql' }));
}

test('statementText cuts the CREATE statement out of its file and ends it with a semicolon', () => {
    const [f, , repoOnly] = repoDefinitions();
    assert.equal(statementText(REPO_SQL, f), 'CREATE FUNCTION app.f(a integer) RETURNS integer\n  LANGUAGE sql AS $$ SELECT a $$ ;');
    assert.equal(statementText(REPO_SQL, repoOnly), 'CREATE FUNCTION app.repo_only() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;');
});

test('formatForCompare makes layout and keyword case differences of the two sides disappear', () => {
    const repo = formatForCompare('create function f() returns int language sql as $$ select 1 $$;');
    const db = formatForCompare('CREATE FUNCTION f()\n RETURNS int\n LANGUAGE sql\nAS $$ select 1 $$;');
    assert.equal(repo, db);
    assert.notEqual(formatForCompare('SELECT 1;'), formatForCompare('SELECT 2;'));
    const crlf = 'CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$\r\nBEGIN\r\n  RETURN 1;\r\nEND$$;';
    assert.equal(formatForCompare(crlf), formatForCompare(crlf.replace(/\r\n/g, '\n')), 'a body stored with CRLF compares equal');
});

test('resolvedFromNode gives a tree node the definitions and database entry the editor features use', () => {
    const db = dbObject({ kind: 'function', oid: 7, schema: 'app', name: 'f', args: 'a integer', argTypes: ['integer'] });
    const sources = { matcher: new DefinitionMatcher(repoDefinitions(), 'app'), db: new DbIndex([db], [{ schema: 'app', name: 'orders', kind: 'table' }], ['app']), searchPath: ['app'] };
    const fromObject = resolvedFromNode(objectNode(db), sources);
    assert.deepEqual([fromObject?.db?.object?.oid, fromObject?.definitions.map(d => d.start.line)], [7, [0]]);
    const table: TableNode = { type: 'table', schema: 'app', table: 'orders', kind: 'table' };
    const fromTable = resolvedFromNode(table, sources);
    assert.deepEqual([fromTable?.db?.relation?.name, fromTable?.definitions.length], ['orders', 1]);
    const repoOnly = resolvedFromNode(objectNode(undefined, { name: 'repo_only', status: 'repoOnly', repoArgTypes: [] }), sources);
    assert.deepEqual([repoOnly?.db, repoOnly?.definitions.length], [undefined, 1]);
    assert.equal(resolvedFromNode({ type: 'category', schema: 'app', kind: 'function' }, sources), undefined);
});

test('unwrapNode takes the view node out of an entry of the Dependencies view and ignores anything else', () => {
    const node = objectNode(dbObject({}));
    assert.equal(unwrapNode(node), node);
    assert.equal(unwrapNode({ type: 'dependency', node }), node);
    assert.equal(unwrapNode({ type: 'dependencyRoot', root: { node } }), node);
    assert.equal(unwrapNode({ type: 'dependencyGroup' }), undefined);
    assert.equal(unwrapNode('click'), undefined);
    assert.equal(unwrapNode(undefined), undefined);
});

test('the compare documents are served by URI and old ones are dropped', () => {
    const provider = new DdlContentProvider();
    const left = provider.add('app.f (repository)', 'CREATE A;');
    const right = provider.add('app.f (database)', 'CREATE B;');
    assert.notEqual(left.toString(), right.toString());
    assert.equal(provider.provideTextDocumentContent(left), 'CREATE A;');
    assert.match(left.toString(), /^pgqb-ddl:\/app\.f%20\(repository\)\.sql\?\d+$/);
    for (let i = 0; i < 40; i++) provider.add(`x${i}`, '');
    assert.equal(provider.provideTextDocumentContent(left), '');
});

test('formatForCompare can leave out the comments, so a line comment turned into a block comment or a lost line break is no difference', () => {
    const repo = 'CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$\nBEGIN\n  -- why\n\n  RETURN SIGN(1) -- note\n  + 1;\nEND $$;';
    const db = 'CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN SIGN(1) /* note*/ + 1;\nEND $$;';
    assert.notEqual(formatForCompare(repo), formatForCompare(db));
    assert.equal(formatForCompare(repo, true), formatForCompare(db, true));
});

test('an entry of the Comparison view is unwrapped to the node of its view', () => {
    const db = dbObject({ kind: 'function', oid: 3 });
    const node = unwrapNode({ type: 'comparisonEntry', entry: { kind: 'function', schema: 'app', name: 'f', args: '', status: 'differs', differences: [], definitions: [], db } });
    assert.equal((node as any).type, 'object');
    assert.equal((node as any).db.oid, 3);
});
