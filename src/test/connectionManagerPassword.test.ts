import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionManager, ConnectionConfig } from '../connectionManager';

const existing: ConnectionConfig = {
    name: 'My DB',
    host: 'localhost',
    port: 5432,
    database: 'postgres',
    user: 'postgres'
};

test('reuses stored password when editing with an empty password field', async () => {
    const calls: string[] = [];
    const result = await ConnectionManager.resolvePassword('', existing, async (name) => {
        calls.push(name);
        return 'secret-stored';
    });
    assert.equal(result, 'secret-stored');
    assert.deepEqual(calls, ['My DB']);
});

test('reuses stored password when editing with an undefined password', async () => {
    const result = await ConnectionManager.resolvePassword(
        undefined as unknown as string,
        existing,
        async () => 'secret-stored'
    );
    assert.equal(result, 'secret-stored');
});

test('uses provided password when editing and a new password is entered', async () => {
    let lookedUp = false;
    const result = await ConnectionManager.resolvePassword('new-pass', existing, async () => {
        lookedUp = true;
        return 'secret-stored';
    });
    assert.equal(result, 'new-pass');
    assert.equal(lookedUp, false);
});

test('uses provided (empty) password for a new connection without lookup', async () => {
    let lookedUp = false;
    const result = await ConnectionManager.resolvePassword('', undefined, async () => {
        lookedUp = true;
        return 'secret-stored';
    });
    assert.equal(result, '');
    assert.equal(lookedUp, false);
});

test('keeps empty password when editing but no stored password exists', async () => {
    const result = await ConnectionManager.resolvePassword('', existing, async () => undefined);
    assert.equal(result, '');
});

test('looks up the stored password by the existing connection name (not a renamed one)', async () => {
    const calls: string[] = [];
    await ConnectionManager.resolvePassword('', existing, async (name) => {
        calls.push(name);
        return 'secret-stored';
    });
    assert.deepEqual(calls, ['My DB']);
});
