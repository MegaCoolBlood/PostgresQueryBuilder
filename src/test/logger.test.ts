import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Logger } from '../logger';

function createChannel() {
    const lines: string[] = [];
    return {
        channel: { appendLine: (line: string) => lines.push(line) } as any,
        lines
    };
}

test('Logger.log is a safe no-op before initialization', () => {
    // No channel injected yet: must not throw.
    assert.doesNotThrow(() => Logger.log('test', 'should be ignored'));
});

test('Logger.log writes a timestamped, scoped line to the channel', () => {
    const { channel, lines } = createChannel();
    Logger.init(channel);

    Logger.log('queryRunner', 'hello world');

    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[queryRunner\] hello world$/);
});

test('Logger.error logs the stack of an Error instance', () => {
    const { channel, lines } = createChannel();
    Logger.init(channel);

    Logger.error('connection', new Error('boom'));

    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[connection\] ERROR: /);
    assert.match(lines[0], /boom/);
});

test('Logger.error stringifies non-Error values', () => {
    const { channel, lines } = createChannel();
    Logger.init(channel);

    Logger.error('connection', 'plain failure');

    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[connection\] ERROR: plain failure$/);
});
