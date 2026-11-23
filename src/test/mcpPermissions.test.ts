import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AI_CAPABILITIES,
    EDIT_CONNECTION_COMMAND_TITLE,
    aiCapabilities,
    confirmsWrites,
    isAllowed,
    refusalMessage
} from '../mcpPermissions';

// ===== aiCapabilities / isAllowed =====

test('a connection without AI settings allows nothing', () => {
    assert.deepEqual(aiCapabilities({}), []);
    assert.deepEqual(aiCapabilities(null), []);
    for (const capability of AI_CAPABILITIES) {
        assert.equal(isAllowed({}, capability), false, capability);
        assert.equal(isAllowed({ ai: {} }, capability), false, capability);
    }
});

test('only capabilities set to true are granted, in the order of the form', () => {
    const config = { ai: { ddl: true, metadata: true, readData: false } };
    assert.deepEqual(aiCapabilities(config), ['metadata', 'ddl']);
    assert.equal(isAllowed(config, 'metadata'), true);
    assert.equal(isAllowed(config, 'readData'), false);
    assert.equal(isAllowed({ ai: { writeData: 'yes' as unknown as boolean } }, 'writeData'), false, 'only a real true grants');
});

// ===== confirmsWrites =====

test('AI writes are confirmed unless the user turned it off', () => {
    assert.equal(confirmsWrites({}), true);
    assert.equal(confirmsWrites(undefined), true);
    assert.equal(confirmsWrites({ ai: { writeData: true } }), true);
    assert.equal(confirmsWrites({ ai: { confirmWrites: false } }), false);
});

// ===== refusalMessage =====

test('a refusal names the connection, the capability and how the user grants it', () => {
    const message = refusalMessage('prod', 'readData');
    assert.match(message, /"prod" does not allow AI assistants to read data \(readData\)/);
    assert.ok(message.includes(EDIT_CONNECTION_COMMAND_TITLE), 'names the command that edits a connection');
    assert.match(message, /"Edit Connection"/);
    assert.match(message, /tick "Read data" under "AI access \(Copilot \/ MCP\)"/);
    assert.match(refusalMessage('x', 'ddl'), /to change the database structure \(ddl\)/);
});
