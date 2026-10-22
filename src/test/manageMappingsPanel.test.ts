import './helpers/vscodeMock';
import { vscodeStub, stubWarningMessage } from './helpers/vscodeMock';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { ManageMappingsPanel } from '../manageMappingsPanel';
import { ColumnMappingManager, CustomColumnMapping } from '../columnMappingManager';

// ===== The panel talking to the mapping manager =====

interface Recorded {
    updates: Array<{ id: string; updates: Partial<Omit<CustomColumnMapping, 'id'>> }>;
    deletes: string[];
}

interface Harness {
    html: string;
    recorded: Recorded;
    send(message: Record<string, unknown>): Promise<void>;
}

function mapping(id: string, scope: 'workspace' | 'global'): CustomColumnMapping {
    return {
        id,
        scope,
        sourceSchema: 'public',
        sourceTable: 'orders',
        sourceColumn: 'customer_id',
        targetSchema: 'public',
        targetTable: 'customers',
        targetColumn: 'id'
    } as CustomColumnMapping;
}

function fakeManager(mappings: CustomColumnMapping[], recorded: Recorded): ColumnMappingManager {
    const manager = {
        onDidChange: (_listener: () => void) => ({ dispose() {} }),
        getAllMappings: () => mappings,
        getWorkspaceFileUri: () => undefined,
        hasWorkspaceFile: () => false,
        async updateMapping(id: string, updates: Partial<Omit<CustomColumnMapping, 'id'>>) {
            recorded.updates.push({ id, updates });
        },
        async deleteMapping(id: string) {
            recorded.deletes.push(id);
        }
    };
    return manager as unknown as ColumnMappingManager;
}

const originalCreate = vscodeStub.window.createWebviewPanel;
after(() => { vscodeStub.window.createWebviewPanel = originalCreate; });

/** Releases the panel a previous test opened; it is a singleton. */
let releasePrevious: (() => void) | undefined;

function openPanel(t: { after(fn: () => void): void }, mappings: CustomColumnMapping[]): Harness {
    releasePrevious?.();
    const recorded: Recorded = { updates: [], deletes: [] };
    let onMessage: ((msg: Record<string, unknown>) => void | Promise<void>) | undefined;
    let onDispose: (() => void) | undefined;
    const panel = {
        webview: {
            html: '',
            cspSource: 'vscode-webview:',
            postMessage: () => Promise.resolve(true),
            onDidReceiveMessage: (listener: typeof onMessage) => { onMessage = listener; return { dispose() {} }; }
        },
        onDidDispose: (listener: () => void) => { onDispose = listener; return { dispose() {} }; },
        reveal: () => { /* not used */ },
        dispose: () => { /* not used */ }
    };
    vscodeStub.window.createWebviewPanel = () => panel as never;
    releasePrevious = () => onDispose?.();
    t.after(() => onDispose?.());

    ManageMappingsPanel.show({} as vscode.ExtensionContext, fakeManager(mappings, recorded));
    assert.ok(onMessage, 'the panel of a previous test was still open');

    return {
        html: panel.webview.html,
        recorded,
        async send(message: Record<string, unknown>) {
            await onMessage?.(message);
        }
    };
}

test('the bulk actions move and delete the selected mappings once confirmed', async (t) => {
    const asked = stubWarningMessage(t, items => items[0]);
    const panel = openPanel(t, [mapping('a', 'global'), mapping('b', 'global')]);
    await panel.send({ command: 'setScope', ids: ['a', 'b'], scope: 'workspace' });
    await panel.send({ command: 'delete', ids: ['b'] });

    assert.deepEqual(asked.map(call => call[0]), ['Move 2 mappings to the workspace file?', 'Delete 1 mapping?']);
    assert.deepEqual(panel.recorded.updates, [
        { id: 'a', updates: { scope: 'workspace' } },
        { id: 'b', updates: { scope: 'workspace' } }
    ]);
    assert.deepEqual(panel.recorded.deletes, ['b']);
});

test('the bulk actions leave every mapping alone when the confirmation is cancelled', async (t) => {
    const asked = stubWarningMessage(t, () => undefined);
    const panel = openPanel(t, [mapping('a', 'workspace')]);
    await panel.send({ command: 'setScope', ids: ['a'], scope: 'global' });
    await panel.send({ command: 'delete', ids: ['a'] });

    assert.equal(asked.length, 2, 'a bulk action ran without asking');
    assert.deepEqual(asked[0][1], { modal: true, detail: 'It will be removed from the workspace file (commit the change to share the removal).' });
    assert.deepEqual(panel.recorded.updates, []);
    assert.deepEqual(panel.recorded.deletes, []);
});

test('editing a single mapping is not held up by a bulk confirmation', async (t) => {
    const asked = stubWarningMessage(t, () => undefined);
    const panel = openPanel(t, [mapping('a', 'global')]);
    await panel.send({ command: 'updateMapping', id: 'a', updates: { label: 'Customer' } });

    assert.equal(asked.length, 0);
    assert.deepEqual(panel.recorded.updates, [{ id: 'a', updates: { label: 'Customer' } }]);
});

test('the mappings panel asks on the host because a webview cannot show confirm() or alert()', (t) => {
    const panel = openPanel(t, [mapping('a', 'global')]);

    assert.doesNotMatch(panel.html, /\b(confirm|alert|prompt)\(/);
    assert.ok(panel.html.includes('id="editError"'), 'the dialog has no place for its validation message');
});
