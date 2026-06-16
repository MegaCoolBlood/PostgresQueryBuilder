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

test('normalizeSearchPath trims surrounding whitespace', () => {
    assert.equal(ConnectionManager.normalizeSearchPath('  leda, public  '), 'leda, public');
});

test('normalizeSearchPath returns null for empty or whitespace-only input', () => {
    assert.equal(ConnectionManager.normalizeSearchPath(''), null);
    assert.equal(ConnectionManager.normalizeSearchPath('    '), null);
});

test('normalizeSearchPath keeps a normal comma-separated value unchanged', () => {
    assert.equal(
        ConnectionManager.normalizeSearchPath('leda, leda_types, oracle, public'),
        'leda, leda_types, oracle, public'
    );
});

test('getSearchPath returns the raw search_path reported by SHOW search_path', async () => {
    const cm = createManager();
    (cm as any).pool = {
        query: async (sql: string) => {
            assert.equal(sql, 'SHOW search_path');
            return { rows: [{ search_path: 'leda, leda_types, oracle' }] };
        }
    };

    assert.equal(await cm.getSearchPath(), 'leda, leda_types, oracle');
});

test('getSearchPath returns an empty string when no row is returned', async () => {
    const cm = createManager();
    (cm as any).pool = { query: async () => ({ rows: [] }) };
    assert.equal(await cm.getSearchPath(), '');
});

test('setSearchPath throws when not connected', async () => {
    const cm = createManager();
    await assert.rejects(() => cm.setSearchPath('public'), /Not connected/);
});

test('setSearchPath throws when the pool config is missing', async () => {
    const cm = createManager();
    // A pool without a stored pool config (e.g. internal inconsistency) must not
    // attempt a rebuild.
    (cm as any).pool = { query: async () => ({ rows: [] }), end: async () => {} };
    (cm as any).currentPoolConfig = null;
    await assert.rejects(() => cm.setSearchPath('public'), /Not connected/);
});
