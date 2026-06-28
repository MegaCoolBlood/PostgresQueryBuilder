import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionManager } from '../connectionManager';

function createManager(): ConnectionManager {
    const fakeContext: any = {
        secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
        subscriptions: []
    };
    return new ConnectionManager(fakeContext);
}

test('ensureConnected returns true without prompting when already connected', async () => {
    const cm = createManager();
    (cm as any).pool = { query: async () => ({ rows: [] }) };

    let prompted = false;
    (cm as any).selectConnection = async () => { prompted = true; };

    const result = await cm.ensureConnected();
    assert.equal(result, true);
    assert.equal(prompted, false);
});

test('ensureConnected prompts and returns true when the user picks a connection', async () => {
    const cm = createManager();
    // Not connected initially.
    assert.equal(cm.isConnected(), false);

    let prompted = false;
    (cm as any).selectConnection = async () => {
        prompted = true;
        // Simulate the user selecting a connection that establishes a pool.
        (cm as any).pool = { query: async () => ({ rows: [] }) };
    };

    const result = await cm.ensureConnected();
    assert.equal(prompted, true);
    assert.equal(result, true);
});

test('ensureConnected prompts and returns false when the user cancels', async () => {
    const cm = createManager();
    assert.equal(cm.isConnected(), false);

    let prompted = false;
    (cm as any).selectConnection = async () => {
        prompted = true;
        // User dismissed the prompt: no pool gets created.
    };

    const result = await cm.ensureConnected();
    assert.equal(prompted, true);
    assert.equal(result, false);
});
