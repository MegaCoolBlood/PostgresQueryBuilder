import './helpers/vscodeMock';
import { vscodeStub } from './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { showJoinDialog, type JoinDialogTable } from '../joinDialog';
import { QualifierStore, onDidChangeTableAliases } from '../tableStatementDrop';

// The real module object; the compiled `import * as fs` only wraps it in getters.
const fs = require('fs');

const LOGIC_FILE = path.join(__dirname, '../../../src/webview/joinDialogLogic.js');

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
    const originalRead = fs.readFileSync;
    vscodeStub.window.createWebviewPanel = () => panel;
    // The compiled module looks for the script next to out/; hand it the source file.
    fs.readFileSync = (file: any, ...rest: any[]) =>
        String(file).endsWith('joinDialogLogic.js') ? originalRead(LOGIC_FILE, ...rest) : originalRead(file, ...rest);
    let result: Promise<any>;
    try {
        result = showJoinDialog(TABLES, [], [], undefined, undefined, onSaveAlias);
    } finally {
        vscodeStub.window.createWebviewPanel = originalCreate;
        fs.readFileSync = originalRead;
    }
    return { panel, posted, result: result!, send: (m: any) => onMessage(m) };
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
    await send({
        command: 'confirm',
        payload: {
            tables: [
                { alias: 'x', tableReference: 'mitarbeiter_tag', columns: ['mtd_id'] },
                { alias: 'y', tableReference: 'orders', columns: ['ord_id'] }
            ],
            joins: [{ type: 'CROSS JOIN', conditions: [] }]
        }
    });
    const value = await result;
    assert.deepEqual(Object.keys(value), ['sql']);
    assert.match(value.sql, /FROM mitarbeiter_tag x/);
    assert.match(value.sql, /CROSS JOIN orders y/);
});

test('JOIN dialog: each table row has a save button and knows the saved alias', () => {
    const { panel } = openDialog();
    const html: string = panel.webview.html;
    assert.ok(html.includes('data-savealias'), 'save button missing');
    assert.ok(html.includes('#icon-save'), 'save icon missing');
    assert.ok(html.includes('"savedAlias":"mtd"'), 'saved alias not handed to the dialog');
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
