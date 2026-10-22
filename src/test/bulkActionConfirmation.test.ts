import './helpers/vscodeMock';
import { stubWarningMessage as stubWarning } from './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmBulkAction, describeBulkAction } from '../bulkActionConfirmation';

const QUERY = { singular: 'query', plural: 'queries' };

// ===== describeBulkAction =====

test('describeBulkAction names the count with the singular or the plural noun', () => {
    assert.equal(describeBulkAction('delete', 1, QUERY).message, 'Delete 1 query?');
    assert.equal(describeBulkAction('delete', 3, QUERY).message, 'Delete 3 queries?');
});

test('describeBulkAction explains what moving to the workspace and back means', () => {
    const toWorkspace = describeBulkAction('toWorkspace', 2, QUERY);
    assert.equal(toWorkspace.message, 'Move 2 queries to the workspace file?');
    assert.match(toWorkspace.detail, /^They will be visible to everyone/);
    assert.equal(toWorkspace.confirmLabel, 'Move to Workspace');

    const toPersonal = describeBulkAction('toPersonal', 1, QUERY);
    assert.equal(toPersonal.message, 'Move 1 query to your personal store?');
    assert.match(toPersonal.detail, /^It will be removed from the workspace file/);
    assert.equal(toPersonal.confirmLabel, 'Move to Personal');
});

// ===== confirmBulkAction =====

test('confirmBulkAction asks with a modal warning that offers the action', async (t) => {
    const calls = stubWarning(t, () => undefined);
    await confirmBulkAction('delete', 2, QUERY);

    assert.equal(calls.length, 1);
    const [message, options, ...items] = calls[0];
    assert.equal(message, 'Delete 2 queries?');
    assert.deepEqual(options, { modal: true, detail: 'This cannot be undone.' });
    assert.deepEqual(items, ['Delete']);
});

test('confirmBulkAction resolves true only when the action button is chosen', async (t) => {
    let answer: string | undefined;
    stubWarning(t, () => answer);

    answer = 'Delete';
    assert.equal(await confirmBulkAction('delete', 1, QUERY), true);
    answer = undefined; // Cancel or Escape
    assert.equal(await confirmBulkAction('delete', 1, QUERY), false);
});

test('confirmBulkAction does not ask when there is nothing to act on', async (t) => {
    const calls = stubWarning(t, items => items[0]);
    assert.equal(await confirmBulkAction('toWorkspace', 0, QUERY), false);
    assert.equal(calls.length, 0);
});
