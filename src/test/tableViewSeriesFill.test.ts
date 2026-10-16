import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const { seriesKindForType, continueSeries, planFillExtension, planSeriesWrites, fillPreviewText } = require(
    path.join(__dirname, '../../../src/webview/tableView.js')
);

// ===== seriesKindForType =====

test('seriesKindForType recognises numbers, dates, timestamps and times', () => {
    for (const t of ['integer', 'smallint', 'bigint', 'numeric', 'numeric(10,2)', 'real', 'double precision']) {
        assert.equal(seriesKindForType(t), 'number', t);
    }
    assert.equal(seriesKindForType('date'), 'date');
    assert.equal(seriesKindForType('timestamp without time zone'), 'timestamp');
    assert.equal(seriesKindForType('timestamp(3) with time zone'), 'timestamp');
    assert.equal(seriesKindForType('time without time zone'), 'time');
    assert.equal(seriesKindForType('time with time zone'), 'time');
});

test('seriesKindForType leaves every other type to repetition', () => {
    for (const t of ['text', 'character varying(20)', 'boolean', 'uuid', 'interval', 'money', 'jsonb', 'integer[]', '']) {
        assert.equal(seriesKindForType(t), '', t);
    }
});

// ===== continueSeries: numbers =====

test('continueSeries continues two numbers by their step', () => {
    assert.deepEqual(continueSeries(['1', '3'], 'number', 3), ['5', '7', '9']);
});

test('continueSeries repeats the steps of three numbers in turn', () => {
    assert.deepEqual(continueSeries(['1', '3', '2'], 'number', 6), ['4', '3', '5', '4', '6', '5']);
});

test('continueSeries accepts numbers delivered as JS numbers and counts down', () => {
    assert.deepEqual(continueSeries([10, 7] as any, 'number', 3), ['4', '1', '-2']);
});

test('continueSeries keeps decimals exact and at the largest scale', () => {
    assert.deepEqual(continueSeries(['0.1', '0.2'], 'number', 3), ['0.3', '0.4', '0.5']);
    assert.deepEqual(continueSeries(['1.50', '2.25'], 'number', 2), ['3.00', '3.75']);
    assert.deepEqual(continueSeries(['-0.5', '0'], 'number', 2), ['0.5', '1.0']);
});

test('continueSeries keeps bigint precision beyond JS numbers', () => {
    assert.deepEqual(
        continueSeries(['9007199254740990', '9007199254740991'], 'number', 2),
        ['9007199254740992', '9007199254740993']
    );
});

test('continueSeries repeats values it cannot read as numbers', () => {
    assert.deepEqual(continueSeries(['1', ''], 'number', 3), ['1', '', '1']);
    assert.deepEqual(continueSeries(['1e3', '2e3'], 'number', 2), ['1e3', '2e3']);
});

// ===== continueSeries: dates, timestamps, times =====

test('continueSeries steps dates by their distance in days', () => {
    assert.deepEqual(continueSeries(['2024-02-27', '2024-02-28'], 'date', 3), ['2024-02-29', '2024-03-01', '2024-03-02']);
    assert.deepEqual(continueSeries(['2024-01-01', '2024-01-08'], 'date', 2), ['2024-01-15', '2024-01-22']);
});

test('continueSeries steps dates on the same day of the month by whole months', () => {
    assert.deepEqual(continueSeries(['2024-01-15', '2024-02-15'], 'date', 3), ['2024-03-15', '2024-04-15', '2024-05-15']);
    assert.deepEqual(continueSeries(['2023-06-01', '2024-06-01'], 'date', 2), ['2025-06-01', '2026-06-01']);
});

test('continueSeries clamps a monthly day to the length of a shorter month', () => {
    assert.deepEqual(continueSeries(['2024-01-30', '2024-03-30'], 'date', 2), ['2024-05-30', '2024-07-30']);
    assert.deepEqual(continueSeries(['2023-12-30', '2024-01-30'], 'date', 1), ['2024-02-29']);
});

test('continueSeries keeps month ends on the last day of each month', () => {
    assert.deepEqual(continueSeries(['2024-01-31', '2024-02-29'], 'date', 3), ['2024-03-31', '2024-04-30', '2024-05-31']);
});

test('continueSeries repeats the month steps of three dates in turn', () => {
    assert.deepEqual(continueSeries(['2024-01-10', '2024-03-10', '2024-02-10'], 'date', 4),
        ['2024-04-10', '2024-03-10', '2024-05-10', '2024-04-10']);
});

test('continueSeries steps timestamps by their exact distance and keeps their shape', () => {
    assert.deepEqual(continueSeries(['2024-01-31 22:00:00', '2024-01-31 23:30:00'], 'timestamp', 2),
        ['2024-02-01 01:00:00', '2024-02-01 02:30:00']);
    assert.deepEqual(continueSeries(['2024-01-01T10:00:00.250Z', '2024-01-01T10:00:00.500Z'], 'timestamp', 2),
        ['2024-01-01T10:00:00.750Z', '2024-01-01T10:00:01.000Z']);
});

test('continueSeries steps timestamps at the same time of the same day of month by months', () => {
    assert.deepEqual(continueSeries(['2024-01-15 08:00:00', '2024-02-15 08:00:00'], 'timestamp', 2),
        ['2024-03-15 08:00:00', '2024-04-15 08:00:00']);
});

test('continueSeries keeps microseconds of timestamps', () => {
    assert.deepEqual(continueSeries(['2024-01-01 00:00:00.000001', '2024-01-01 00:00:00.000003'], 'timestamp', 1),
        ['2024-01-01 00:00:00.000005']);
});

test('continueSeries wraps times around midnight and keeps the time zone', () => {
    assert.deepEqual(continueSeries(['22:00:00', '23:00:00'], 'time', 2), ['00:00:00', '01:00:00']);
    assert.deepEqual(continueSeries(['08:00:00+01', '08:15:00+01'], 'time', 1), ['08:30:00+01']);
});

test('continueSeries continues dates backwards when given in reverse', () => {
    assert.deepEqual(continueSeries(['2024-03-01', '2024-02-01'], 'date', 2), ['2024-01-01', '2023-12-01']);
});

test('continueSeries repeats date values it cannot read or whose zones differ', () => {
    assert.deepEqual(continueSeries(['2024-01-01', 'infinity'], 'date', 2), ['2024-01-01', 'infinity']);
    assert.deepEqual(continueSeries(['2024-02-30', '2024-03-01'], 'date', 1), ['2024-02-30']);
    assert.deepEqual(continueSeries(['10:00+01', '11:00+02'], 'time', 1), ['10:00+01']);
});

// ===== continueSeries: repetition =====

test('continueSeries repeats text and single values in order', () => {
    assert.deepEqual(continueSeries(['A', 'B'], '', 5), ['A', 'B', 'A', 'B', 'A']);
    assert.deepEqual(continueSeries(['5'], 'number', 3), ['5', '5', '5']);
    assert.deepEqual(continueSeries(['1', '2'], 'number', 0), []);
    assert.deepEqual(continueSeries([], 'number', 2), []);
});

// ===== planFillExtension =====

const block = { minR: 2, maxR: 3, minC: 1, maxC: 2 };

test('planFillExtension extends downwards below the block', () => {
    assert.deepEqual(planFillExtension(block, { r: 6, c: 2 }), {
        direction: 'down', target: { minR: 4, maxR: 6, minC: 1, maxC: 2 }
    });
});

test('planFillExtension extends upwards above the block', () => {
    assert.deepEqual(planFillExtension(block, { r: 0, c: 1 }), {
        direction: 'up', target: { minR: 0, maxR: 1, minC: 1, maxC: 2 }
    });
});

test('planFillExtension extends to the right and to the left', () => {
    assert.deepEqual(planFillExtension(block, { r: 3, c: 5 }), {
        direction: 'right', target: { minR: 2, maxR: 3, minC: 3, maxC: 5 }
    });
    assert.deepEqual(planFillExtension(block, { r: 2, c: 0 }), {
        direction: 'left', target: { minR: 2, maxR: 3, minC: 0, maxC: 0 }
    });
});

test('planFillExtension follows the axis the pointer left the block furthest along', () => {
    assert.equal(planFillExtension(block, { r: 4, c: 6 }).direction, 'right');
    assert.equal(planFillExtension(block, { r: 7, c: 4 }).direction, 'down');
    assert.equal(planFillExtension(block, { r: 5, c: 4 }).direction, 'down', 'a tie goes vertical');
});

test('planFillExtension extends nothing while the pointer is inside the block', () => {
    assert.equal(planFillExtension(block, { r: 2, c: 2 }), null);
    assert.equal(planFillExtension(null, { r: 2, c: 2 }), null);
});

// ===== planSeriesWrites (shared by the drag preview and the fill) =====

// A 4 x 3 grid: column 0 numbers, column 1 dates, column 2 text.
const grid = [
    ['1', '2024-01-31', 'A'],
    ['3', '2024-02-29', 'B'],
    ['', '', ''],
    ['', '', '']
];
const valueAt = (r: number, c: number) => grid[r][c];
const kindOf = (c: number) => ['number', 'date', ''][c];

test('planSeriesWrites continues each column of a block filled downwards', () => {
    const source = { minR: 0, maxR: 1, minC: 0, maxC: 2 };
    const plan = planFillExtension(source, { r: 3, c: 2 });
    assert.deepEqual(planSeriesWrites(source, plan, valueAt, kindOf), [
        { r: 2, c: 0, value: '5' }, { r: 3, c: 0, value: '7' },
        { r: 2, c: 1, value: '2024-03-31' }, { r: 3, c: 1, value: '2024-04-30' },
        { r: 2, c: 2, value: 'A' }, { r: 3, c: 2, value: 'B' }
    ]);
});

test('planSeriesWrites fills upwards starting next to the block', () => {
    const g = [['', ''], ['', ''], ['5', 'x'], ['7', 'y']];
    const source = { minR: 2, maxR: 3, minC: 0, maxC: 1 };
    const plan = planFillExtension(source, { r: 0, c: 0 });
    assert.deepEqual(planSeriesWrites(source, plan, (r: number, c: number) => g[r][c], (c: number) => ['number', ''][c]), [
        { r: 1, c: 0, value: '3' }, { r: 0, c: 0, value: '1' },
        { r: 1, c: 1, value: 'y' }, { r: 0, c: 1, value: 'x' }
    ]);
});

test('planSeriesWrites continues a row sideways only when its columns share a kind', () => {
    const g = [['1', '2', '', ''], ['x', 'y', '', '']];
    const at = (r: number, c: number) => g[r][c];
    const source = { minR: 0, maxR: 1, minC: 0, maxC: 1 };
    const plan = planFillExtension(source, { r: 0, c: 3 });
    assert.deepEqual(planSeriesWrites(source, plan, at, () => 'number'), [
        { r: 0, c: 2, value: '3' }, { r: 0, c: 3, value: '4' },
        { r: 1, c: 2, value: 'x' }, { r: 1, c: 3, value: 'y' }
    ]);
    const mixed = (c: number) => ['number', ''][c];
    assert.deepEqual(planSeriesWrites(source, plan, at, mixed).slice(0, 2), [
        { r: 0, c: 2, value: '1' }, { r: 0, c: 3, value: '2' }
    ]);
});

test('planSeriesWrites writes nothing without a plan', () => {
    assert.deepEqual(planSeriesWrites({ minR: 0, maxR: 1, minC: 0, maxC: 0 }, null, valueAt, kindOf), []);
});

// ===== fillPreviewText =====

test('fillPreviewText shows a number the way the grid displays it', () => {
    assert.equal(fillPreviewText('1234567.5', true, ' '), '1 234 567,5');
    assert.equal(fillPreviewText('7', true, ' '), '7');
});

test('fillPreviewText shows other values as they are and an empty value as NULL', () => {
    assert.equal(fillPreviewText('2024-03-31', false, ' '), '2024-03-31');
    assert.equal(fillPreviewText('', true, ' '), 'NULL');
    assert.equal(fillPreviewText(null, false, ' '), 'NULL');
});
