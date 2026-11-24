import './helpers/vscodeMock';
import { vscodeStub } from './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import { showJoinDialog, initialJoinBuilderState, type JoinDialogTable } from '../joinDialog';
import { QualifierStore, onDidChangeTableAliases } from '../tableStatementDrop';
import { buildBuilderSql } from '../statementBuilder';
import { formatSqlChecked } from '../plpgsqlFormatter';

const TABLES: JoinDialogTable[] = [
    { schema: 'public', table: 'mitarbeiter_tag', tableReference: 'mitarbeiter_tag', alias: 'mtd', savedAlias: 'mtd', columns: ['mtd_id'] },
    { schema: 'public', table: 'orders', tableReference: 'orders', alias: 'ord', columns: ['ord_id', 'ord_mtd_id'] }
];

/** Open the dialog on a fake panel; the dialog's script is read from src/webview. */
function openDialog(onSaveAlias?: (schema: string, table: string, alias: string) => Promise<void>) {
    const posted: any[] = [];
    let onMessage: (m: any) => Promise<void> = async () => {};
    const panel: any = {
        webview: {
            html: '',
            cspSource: 'vscode-resource:',
            postMessage: (m: any) => { posted.push(m); return Promise.resolve(true); },
            onDidReceiveMessage: (cb: any) => { onMessage = cb; return { dispose() {} }; }
        },
        onDidDispose: () => ({ dispose() {} }),
        dispose() {}
    };
    const originalCreate = vscodeStub.window.createWebviewPanel;
    vscodeStub.window.createWebviewPanel = () => panel;
    let result: Promise<any>;
    try {
        result = showJoinDialog(TABLES, [], [{ type: 'CROSS JOIN', conditions: [] }], undefined, undefined, onSaveAlias);
    } finally {
        vscodeStub.window.createWebviewPanel = originalCreate;
    }
    return { panel, posted, result: result!, send: (m: any) => onMessage(m) };
}

/** A two-table state as the builder would send it. */
function confirmState(): any {
    const state = initialJoinBuilderState(
        [{ ...TABLES[0], alias: 'x' }, { ...TABLES[1], alias: 'y' }],
        [{ type: 'INNER JOIN', conditions: [{ leftAlias: 'x', leftColumn: 'mtd_id', rightColumn: 'ord_mtd_id' }] }]
    );
    state.where.push({ kind: 'compare', left: { kind: 'column', tableIndex: 1, column: 'ord_id' }, operator: '>', right: { kind: 'raw', text: '$1' } });
    state.where.push({ kind: 'raw', text: 'x.mtd_id = 1 OR x.mtd_id = 2' });
    return state;
}

/** Run `fn` with the formatter's master switch set to `enabled`. */
async function withFormatter<T>(enabled: boolean, fn: () => Promise<T>): Promise<T> {
    const original = vscodeStub.workspace.getConfiguration;
    vscodeStub.workspace.getConfiguration = () => ({
        get: (key: string, def?: any) => (key === 'format.enable' ? enabled : def)
    });
    try {
        return await fn();
    } finally {
        vscodeStub.workspace.getConfiguration = original;
    }
}

// ===== JOIN dialog: saving an alias =====

test('JOIN dialog: an alias is stored only through its save button', async () => {
    const saved: string[][] = [];
    const { posted, send } = openDialog(async (schema, table, alias) => { saved.push([schema, table, alias]); });
    await send({ command: 'saveAlias', schema: 'public', table: 'orders', alias: '  o ' });
    assert.deepEqual(saved, [['public', 'orders', 'o']]);
    assert.deepEqual(posted.find((m) => m.command === 'aliasSaved'), { command: 'aliasSaved', schema: 'public', table: 'orders', alias: 'o' });
});

test('JOIN dialog: an empty alias is not stored', async () => {
    const saved: string[] = [];
    const { posted, send } = openDialog(async (_s, _t, alias) => { saved.push(alias); });
    await send({ command: 'saveAlias', schema: 'public', table: 'orders', alias: '   ' });
    assert.deepEqual(saved, []);
    assert.equal(posted.some((m) => m.command === 'aliasSaved'), false);
});

test('JOIN dialog: a failed save is reported and not confirmed to the dialog', async () => {
    const errors: string[] = [];
    const original = vscodeStub.window.showErrorMessage;
    vscodeStub.window.showErrorMessage = (msg: string) => { errors.push(msg); return Promise.resolve(undefined); };
    try {
        const { posted, send } = openDialog(async () => { throw new Error('storage full'); });
        await send({ command: 'saveAlias', schema: 'public', table: 'orders', alias: 'o' });
        assert.equal(posted.some((m) => m.command === 'aliasSaved'), false);
        assert.match(errors.join('\n'), /Saving the alias failed: storage full/);
    } finally {
        vscodeStub.window.showErrorMessage = original;
    }
});

test('JOIN dialog: inserting the statement returns only the SQL, no aliases to store', async () => {
    const { send, result } = openDialog(async () => {});
    await send({ command: 'confirm', state: confirmState() });
    const value = await result;
    assert.deepEqual(Object.keys(value), ['sql']);
    assert.match(value.sql, /FROM mitarbeiter_tag x/);
    assert.match(value.sql, /JOIN orders y/);
});

// ===== JOIN dialog: formatted SQL =====

test('JOIN dialog: the inserted statement is laid out by the formatter', async () => {
    const value = await withFormatter(true, async () => {
        const { send, result } = openDialog();
        await send({ command: 'confirm', state: confirmState() });
        return result;
    });
    const raw = buildBuilderSql(confirmState());
    const formatted = formatSqlChecked(raw, {});
    assert.equal(formatted.ok, true);
    assert.notEqual(formatted.text.trimEnd(), raw, 'the sample must give the formatter something to do');
    assert.equal(value.sql, formatted.text.trimEnd());
    assert.match(value.sql, /\$1/, 'placeholders stay as written');
});

test('JOIN dialog: with the formatter turned off the statement is inserted as built', async () => {
    const value = await withFormatter(false, async () => {
        const { send, result } = openDialog();
        await send({ command: 'confirm', state: confirmState() });
        return result;
    });
    assert.equal(value.sql, buildBuilderSql(confirmState()));
});

test('JOIN dialog: the preview answers with the formatted SQL of the request', async () => {
    const { posted, send } = await withFormatter(true, async () => {
        const opened = openDialog();
        await opened.send({ command: 'preview', requestId: 7, state: confirmState() });
        return opened;
    });
    assert.deepEqual(posted.at(-1), {
        command: 'previewSql',
        requestId: 7,
        sql: formatSqlChecked(buildBuilderSql(confirmState()), {}).text.trimEnd()
    });
    await send({ command: 'preview', requestId: 8, state: { tables: [] } });
    assert.deepEqual(posted.at(-1), { command: 'previewSql', requestId: 8, sql: '' });
});

test('JOIN dialog: hosts the shared join builder with every column selected', () => {
    const { panel } = openDialog();
    const html: string = panel.webview.html;
    assert.ok(html.includes('window.JoinBuilder.createJoinBuilder'), 'the shared component is not used');
    assert.ok(html.includes('.jb-table'), 'the component stylesheet is missing');
    assert.ok(html.includes('"savedAlias":"mtd"'), 'saved alias not handed to the dialog');
    assert.ok(html.includes('"selectItems":[{"kind":"column","tableIndex":0,"column":"mtd_id"}'), 'columns not selected');
    assert.ok(html.includes('"preview":"SELECT'), 'no initial preview');
    assert.ok(!html.includes('aliasMap'), 'confirming must not hand aliases back for storing');
    assert.match(html, /applies to this statement only/);
});

// ===== QualifierStore =====

test('QualifierStore announces every saved alias', async () => {
    const values: Record<string, any> = {};
    const memento: any = {
        get: (key: string, def?: any) => (key in values ? values[key] : def),
        update: (key: string, value: any) => { values[key] = value; return Promise.resolve(); }
    };
    const events: any[] = [];
    const sub = onDidChangeTableAliases((e) => events.push(e));
    try {
        const store = new QualifierStore(memento);
        await store.set('public', 'orders', 'o');
        assert.equal(store.get('public', 'orders'), 'o');
        // Another store over the same memento sees it and announces too.
        await new QualifierStore(memento).set('public', 'orders', 'ord');
        assert.equal(store.get('public', 'orders'), 'ord');
        assert.deepEqual(events, [{ schema: 'public', table: 'orders' }, { schema: 'public', table: 'orders' }]);
    } finally {
        sub.dispose();
    }
});
