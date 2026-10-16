import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import { types } from 'pg';
import '../connectionManager';

// ===== Type parsers installed by connectionManager =====

test('a date column is delivered as the raw YYYY-MM-DD text, never shifted by the timezone', () => {
    assert.equal(types.getTypeParser(1082, 'text')('2024-01-31'), '2024-01-31');
});

test('a timestamp column is delivered as the raw text as stored', () => {
    assert.equal(types.getTypeParser(1114, 'text')('2024-01-31 10:15:00'), '2024-01-31 10:15:00');
});
