import './helpers/vscodeMock';
import { vscodeStub } from './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    addBuilderTables,
    builderSqlFromState,
    builderTableRefs,
    editSelectInQueryBuilder,
    openNewQueryBuilder,
    openTablesInQueryBuilder,
    relationsFromNodes,
    type OpenQueryView
} from '../dataViewerBuilder';

const ROOT = path.join(__dirname, '..', '..', '..');

/** A QueryRunner stand-in that knows `public.orders` and `public.customers`, joined by a foreign key. */
function fakeRunner() {
    const columns: Record<string, string[]> = { orders: ['id', 'customer_id'], customers: ['id', 'name'] };
    return {
        getMultiTableJoinData: async (tables: Array<{ schema: string; table: string }>) => {
            const known = tables.filter(t => t.schema === 'public' && columns[t.table]);
            return {
                tables: known.map(t => ({ ...t, tableReference: t.table, columns: columns[t.table], rawColumns: columns[t.table], firstColumnRaw: 'id' })),
                foreignKeys: known.some(t => t.table === 'orders') && known.some(t => t.table === 'customers')
                    ? [{ fromSchema: 'public', fromTable: 'orders', fromColumn: 'customer_id', toSchema: 'public', toTable: 'customers', toColumn: 'id' }]
                    : []
            };
        },
        listAllTables: async () => [{ schema: 'public', table: 'orders' }, { schema: 'public', table: 'customers' }]
    };
}

/** Records how a Data Viewer was opened. */
function recordOpen() {
    const opened: any[] = [];
    const open: OpenQueryView = async (sql, title, viewColumn, _saved, sessionRef, options) => {
        opened.push({ sql, title, viewColumn, sessionRef, options });
    };
    return { opened, open };
}

// ===== relationsFromNodes / builderTableRefs =====

test('relationsFromNodes takes the selected tables of the Tables view once each, without repository-only ones', () => {
    const node = { type: 'table', schema: 'public', table: 'orders', kind: 'table' };
    assert.deepEqual(relationsFromNodes(node, undefined), [{ schema: 'public', table: 'orders' }]);
    assert.deepEqual(relationsFromNodes(node, [
        node,
        { type: 'table', schema: 'public', table: 'v', kind: 'view' },
        { type: 'table', schema: 'public', table: 'repo', kind: 'table', status: 'repoOnly' },
        { type: 'schema', schema: 'public' },
        { type: 'table', schema: 'public', table: 'orders', kind: 'table' }
    ]), [{ schema: 'public', table: 'orders' }, { schema: 'public', table: 'v' }]);
    assert.deepEqual(relationsFromNodes(undefined, undefined), []);
});

test('builderTableRefs keeps only well-formed tables from a webview message', () => {
    assert.deepEqual(builderTableRefs([{ schema: 'public', table: 'a' }, { table: 'b' }, { schema: 'x' }, null, 'c']), [
        { schema: 'public', table: 'a' },
        { schema: '', table: 'b' }
    ]);
    assert.deepEqual(builderTableRefs(undefined), []);
});

// ===== builderSqlFromState =====

test('builderSqlFromState refuses what is no builder state', () => {
    assert.equal(builderSqlFromState(null), null);
    assert.equal(builderSqlFromState('SELECT 1'), null);
    assert.equal(builderSqlFromState({ tables: [], selectItems: [] }), '');
});

// ===== addBuilderTables =====

test('addBuilderTables hands out only the added tables, with the join edges over the whole set', async () => {
    const chosen: any[] = [];
    const payload = await addBuilderTables(fakeRunner(), undefined, undefined, [
        { schema: 'public', table: 'orders' },
        { schema: 'public', table: 'gone' },
        { schema: '', table: 'unresolved' }
    ], async (_runner, current) => {
        chosen.push(current);
        return [{ schema: 'public', table: 'customers' }];
    });
    assert.deepEqual(chosen, [[{ schema: 'public', table: 'orders' }, { schema: 'public', table: 'gone' }]], 'tables without schema are not offered as current');
    assert.deepEqual(payload?.tables.map(t => `${t.schema}.${t.table}`), ['public.customers']);
    assert.equal(payload?.fkEdges.length, 1);
    assert.equal(await addBuilderTables(fakeRunner(), undefined, undefined, [], async () => []), null, 'nothing chosen, nothing added');
});

// ===== Entry points =====

test('New Query Builder opens an empty Data Viewer on the builder tab that waits for Run', async () => {
    const { opened, open } = recordOpen();
    await openNewQueryBuilder(open);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].sql, '');
    assert.equal(opened[0].title, 'Query Builder');
    assert.deepEqual(opened[0].options, { tab: 'builder', run: false });
});

test('Open in Query Builder joins the selected tables and opens them on the builder tab without running', async () => {
    const { opened, open } = recordOpen();
    await openTablesInQueryBuilder({ queryRunner: fakeRunner(), mappings: undefined, qualifiers: undefined, open }, [
        { schema: 'public', table: 'orders' },
        { schema: 'public', table: 'customers' }
    ]);
    assert.equal(opened.length, 1);
    assert.deepEqual(opened[0].options, { tab: 'builder', run: false });
    assert.equal(opened[0].title, 'Query Builder: orders, customers');
    const sql = opened[0].sql.replace(/\s+/g, ' ');
    assert.match(sql, /FROM orders \w+ (INNER |LEFT )?JOIN customers \w+ ON \w+\.id = \w+\.customer_id/i);
    assert.doesNotMatch(sql, /;\s*$/);
});

/** A text editor stand-in on `text` with the cursor at `cursor`. */
function fakeEditor(text: string, cursor: number) {
    const document = {
        uri: { fsPath: path.join('work', 'report.sql'), path: '/work/report.sql' },
        getText: () => text,
        offsetAt: (p: any) => p.offset
    };
    return { document, selection: { isEmpty: true, active: { offset: cursor } } } as any;
}

test('Edit SELECT in Query Builder opens the statement on the file\'s session with Apply to File', async () => {
    const { opened, open } = recordOpen();
    const text = 'SELECT 1;\nSELECT a FROM t WHERE b = :b;\n';
    const ref = { key: 'file:report', label: 'report.sql' };
    await editSelectInQueryBuilder({ open, sessionRefFor: () => ref }, fakeEditor(text, text.indexOf('a FROM')));
    assert.equal(opened.length, 1);
    assert.equal(opened[0].sql, 'SELECT a FROM t WHERE b = :b', 'the placeholder stays as text');
    assert.equal(opened[0].sessionRef, ref);
    assert.equal(opened[0].options.tab, 'builder');
    assert.equal(opened[0].options.run, false);
    assert.equal(opened[0].options.applyTarget.label, 'report.sql');
});

test('Edit SELECT in Query Builder opens a SELECT INTO without Apply and says why', async (t) => {
    const infos: string[] = [];
    const original = vscodeStub.window.showInformationMessage;
    vscodeStub.window.showInformationMessage = (message: string) => { infos.push(message); return Promise.resolve(undefined); };
    t.after(() => { vscodeStub.window.showInformationMessage = original; });
    const { opened, open } = recordOpen();
    const text = 'DO $$ BEGIN SELECT count(*) INTO n FROM t; END $$;';
    await editSelectInQueryBuilder({ open }, fakeEditor(text, text.indexOf('count')));
    assert.equal(opened[0].sql, 'SELECT count(*) FROM t');
    assert.equal(opened[0].options.applyTarget, undefined);
    assert.match(infos[0], /INTO/);
});

// ===== Manifest and wiring =====

test('the Query Builder commands are contributed, offered where they apply and registered', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const commands = new Map((manifest.contributes.commands as Array<{ command: string; title: string; category?: string; icon?: string }>).map((c) => [c.command, c]));
    for (const [id, title] of [
        ['postgresQueryBuilder.openQueryBuilder', 'New Query Builder'],
        ['postgresQueryBuilder.openTablesInQueryBuilder', 'Open in Query Builder'],
        ['postgresQueryBuilder.editSelectInQueryBuilder', 'Edit SELECT in Query Builder']
    ]) {
        const command = commands.get(id);
        assert.equal(command?.title, title);
        assert.equal(command?.category, 'PostgreSQL Query Booster');
        assert.ok(command?.icon, `${id} has no icon`);
    }
    assert.equal(commands.has('postgresQueryBuilder.addTablesToQueryBuilder'), false, 'the tab replaced Add to Query Builder');
    const menus = manifest.contributes.menus;
    const all = JSON.stringify(menus);
    assert.equal(all.includes('addTablesToQueryBuilder'), false);
    const tableItem = menus['view/item/context'].find((m: { command: string }) => m.command === 'postgresQueryBuilder.openTablesInQueryBuilder');
    assert.match(tableItem.when, /view == postgresTableExplorer && viewItem =~/);
    assert.ok(menus['view/title'].some((m: { command: string; when: string }) => m.command === 'postgresQueryBuilder.openQueryBuilder' && m.when === 'view == postgresTableExplorer'));
    const editor = menus['editor/context'].find((m: { command: string }) => m.command === 'postgresQueryBuilder.editSelectInQueryBuilder');
    for (const language of ['sql', 'postgres', 'pgsql']) assert.ok(editor.when.includes(`resourceLangId == ${language}`));
    const palette = menus.commandPalette.find((m: { command: string }) => m.command === 'postgresQueryBuilder.openTablesInQueryBuilder');
    assert.equal(palette.when, 'false', 'the table command needs a tree node');

    const extension = fs.readFileSync(path.join(ROOT, 'src', 'extension.ts'), 'utf8');
    for (const id of ['openQueryBuilder', 'openTablesInQueryBuilder', 'editSelectInQueryBuilder']) {
        assert.ok(extension.includes(`registerCommand('postgresQueryBuilder.${id}'`), `${id} is not registered`);
    }
    assert.equal(extension.includes('addTablesToQueryBuilder'), false);
    assert.doesNotMatch(extension, /from '\.\/queryBuilder'/, 'the entry points no longer use the standalone Query Builder');
    assert.match(extension, /setVariableValuePrompt\(/, 'Run in a Data Viewer asks placeholder values');
});
