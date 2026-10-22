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

test('a timestamptz column is delivered as the raw text with its microseconds', () => {
    const raw = '2024-01-31 10:15:00.123456+01';
    assert.equal(types.getTypeParser(1184, 'text')(raw), raw);
});

test('timestamp, date and timestamptz arrays are delivered as arrays of raw text', () => {
    const parse = (oid: number, raw: string) => (types.getTypeParser as unknown as (o: number, f: string) => (v: string) => unknown)(oid, 'text')(raw);
    assert.deepEqual(parse(1185, '{"2024-01-31 10:15:00.123456+01",NULL}'), ['2024-01-31 10:15:00.123456+01', null]);
    assert.deepEqual(parse(1115, '{"2024-01-31 10:15:00"}'), ['2024-01-31 10:15:00']);
    assert.deepEqual(parse(1182, '{2024-01-31}'), ['2024-01-31']);
});

test('interval, point and circle values and their arrays are delivered as the server text', () => {
    const parse = (oid: number, raw: string) => (types.getTypeParser as unknown as (o: number, f: string) => (v: string) => unknown)(oid, 'text')(raw);
    assert.equal(parse(1186, '1 day 01:30:00'), '1 day 01:30:00');
    assert.equal(parse(600, '(1,2)'), '(1,2)');
    assert.equal(parse(718, '<(1,2),3>'), '<(1,2),3>');
    assert.deepEqual(parse(1187, '{"1 day","02:00:00"}'), ['1 day', '02:00:00']);
    assert.deepEqual(parse(1017, '{"(1,2)","(3,4)"}'), ['(1,2)', '(3,4)']);
    assert.deepEqual(parse(719, '{"<(1,2),3>"}'), ['<(1,2),3>']);
});
