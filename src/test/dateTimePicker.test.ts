import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

const dtp = require(path.join(__dirname, '../../../src/webview/dateTimePicker.js'));

const NOW = new Date(2026, 10, 25, 14, 7, 33);

// ===== parseDateTimeInput =====

test('parseDateTimeInput reads ISO dates and timestamps with a space or a T', () => {
    assert.equal(dtp.parseDateTimeInput('2026-11-25', 'date').value, '2026-11-25');
    assert.equal(dtp.parseDateTimeInput(' 2026-11-25 10:39 ', 'timestamp').value, '2026-11-25 10:39');
    assert.equal(dtp.parseDateTimeInput('2026-11-25T10:39', 'timestamp').value, '2026-11-25 10:39');
    assert.equal(dtp.parseDateTimeInput('2026-11-25t10:39:15', 'timestamp').value, '2026-11-25 10:39:15');
    assert.equal(dtp.parseDateTimeInput('2026-11-25 10:39:15.123', 'timestamp').value, '2026-11-25 10:39:15.123');
    assert.equal(dtp.parseDateTimeInput('2026-1-5 9:05', 'timestamp').value, '2026-01-05 09:05');
});

test('parseDateTimeInput keeps seconds and a time only when they were typed', () => {
    const r = dtp.parseDateTimeInput('2026-11-25 10:39', 'timestamp');
    assert.equal(r.parts.ss, null);
    assert.equal(dtp.parseDateTimeInput('2026-11-25', 'timestamp').value, '2026-11-25', 'a bare date stays a whole day');
    assert.equal(dtp.parseDateTimeInput('2026-11-25 10:39:00', 'timestamp').value, '2026-11-25 10:39:00');
});

test('parseDateTimeInput reads day-first dates with dots', () => {
    assert.equal(dtp.parseDateTimeInput('25.11.2026', 'date').value, '2026-11-25');
    assert.equal(dtp.parseDateTimeInput('25.11.2026 10:39', 'timestamp').value, '2026-11-25 10:39');
    assert.equal(dtp.parseDateTimeInput('5.1.2026 7:30:05', 'timestamp').value, '2026-01-05 07:30:05');
});

test('parseDateTimeInput resolves a bare time, today and now against the clock', () => {
    assert.equal(dtp.parseDateTimeInput('10:39', 'timestamp', NOW).value, '2026-11-25 10:39');
    assert.equal(dtp.parseDateTimeInput('today', 'date', NOW).value, '2026-11-25');
    assert.equal(dtp.parseDateTimeInput('Today', 'timestamp', NOW).value, '2026-11-25');
    assert.equal(dtp.parseDateTimeInput('now', 'timestamp', NOW).value, '2026-11-25 14:07');
    assert.equal(dtp.parseDateTimeInput('now', 'date', NOW).value, '2026-11-25');
    assert.ok(dtp.parseDateTimeInput('10:39', 'date', NOW).error, 'a date needs a day');
});

test('parseDateTimeInput drops the time of a date and keeps a time zone and infinity', () => {
    assert.equal(dtp.parseDateTimeInput('2026-11-25 10:39', 'date').value, '2026-11-25');
    assert.equal(dtp.parseDateTimeInput('2026-11-25 10:39:00+01', 'timestamp').value, '2026-11-25 10:39:00+01');
    assert.equal(dtp.parseDateTimeInput('2026-11-25 10:39:00.5+05:30', 'timestamp').value, '2026-11-25 10:39:00.5+05:30');
    assert.equal(dtp.parseDateTimeInput('2026-11-25T10:39Z', 'timestamp').value, '2026-11-25 10:39Z');
    assert.equal(dtp.parseDateTimeInput('-Infinity', 'timestamp').value, '-infinity');
    assert.deepEqual(dtp.parseDateTimeInput('   ', 'date'), { value: '', parts: null });
});

test('parseDateTimeInput rejects impossible times and days with a reason', () => {
    assert.equal(dtp.parseDateTimeInput('2026-11-25 24:00', 'timestamp').error, 'Hours run from 00 to 23.');
    assert.equal(dtp.parseDateTimeInput('2026-11-25 23:60', 'timestamp').error, 'Minutes run from 00 to 59.');
    assert.equal(dtp.parseDateTimeInput('2026-11-25 23:59:60', 'timestamp').error, 'Seconds run from 00 to 59.');
    assert.equal(dtp.parseDateTimeInput('31.02.2026', 'date').error, 'February 2026 has 28 days.');
    assert.equal(dtp.parseDateTimeInput('2026-13-01', 'date').error, 'Months run from 01 to 12.');
    assert.equal(dtp.parseDateTimeInput('29.02.2025', 'date').error, 'February 2025 has 28 days.');
    assert.equal(dtp.parseDateTimeInput('29.02.2024', 'date').value, '2024-02-29');
    assert.equal(dtp.parseDateTimeInput('29.02.2000', 'date').value, '2000-02-29');
    assert.ok(dtp.parseDateTimeInput('29.02.1900', 'date').error);
    assert.ok(dtp.parseDateTimeInput('0000-01-01', 'date').error);
    for (const text of ['yesterday', '2026/11/25', '2026-11-25 10', '2026-11-25 10:39 am', "2026-11-25'; --", '10.39']) {
        assert.ok(dtp.parseDateTimeInput(text, 'timestamp', NOW).error, `${text} is no timestamp`);
    }
});

// ===== formatDateTime =====

test('formatDateTime writes ISO text with a space, seconds only when set', () => {
    assert.equal(dtp.formatDateTime({ y: 2026, m: 1, d: 5 }, 'date'), '2026-01-05');
    assert.equal(dtp.formatDateTime({ y: 2026, m: 1, d: 5, hh: 7, mm: 3 }, 'timestamp'), '2026-01-05 07:03');
    assert.equal(dtp.formatDateTime({ y: 2026, m: 1, d: 5, hh: 7, mm: 3, ss: 9, frac: '.25' }, 'timestamp'), '2026-01-05 07:03:09.25');
    assert.equal(dtp.formatDateTime({ y: 2026, m: 1, d: 5, hh: 23, mm: 59, ss: 0, tz: '+01' }, 'date'), '2026-01-05');
    assert.equal(dtp.formatDateTime({ y: 33, m: 12, d: 31 }, 'date'), '0033-12-31');
});

// ===== pickedDateTime / nowDateTime =====

test('pickedDateTime writes a newly picked value without the offset of the value it opened with', () => {
    const opened = dtp.parseDateTimeInput('2026-01-15 10:00:00+01', 'timestamp').parts;
    assert.equal(dtp.pickedDateTime({ y: 2026, m: 7, d: 15, hh: 10, mm: 0, ss: null, frac: '' }, opened, 'timestamp'), '2026-07-15 10:00');
    assert.equal(dtp.pickedDateTime({ y: 2026, m: 7, d: 15, hh: 10, mm: 0, ss: 0, frac: '' }, opened, 'timestamp'), '2026-07-15 10:00:00');
    assert.equal(dtp.pickedDateTime({ y: 2026, m: 1, d: 15, hh: 11, mm: 0, ss: 0, frac: '' }, opened, 'timestamp'), '2026-01-15 11:00:00',
        'a changed time is a new wall-clock value too');
});

test('pickedDateTime keeps the opening text of a value confirmed unchanged', () => {
    const opened = dtp.parseDateTimeInput('2026-01-15 10:00:00+01', 'timestamp').parts;
    assert.equal(dtp.pickedDateTime({ y: 2026, m: 1, d: 15, hh: 10, mm: 0, ss: 0, frac: '' }, opened, 'timestamp'), '2026-01-15 10:00:00+01');
    const fraction = dtp.parseDateTimeInput('2026-01-15 10:00:00.25Z', 'timestamp').parts;
    assert.equal(dtp.pickedDateTime({ y: 2026, m: 1, d: 15, hh: 10, mm: 0, ss: 0, frac: '.25' }, fraction, 'timestamp'), '2026-01-15 10:00:00.25Z');
});

test('nowDateTime writes the local wall-clock time without an offset', () => {
    const clock = new Date(2026, 6, 15, 9, 5, 7);
    assert.equal(dtp.nowDateTime(clock, 'timestamp', false), '2026-07-15 09:05');
    assert.equal(dtp.nowDateTime(clock, 'timestamp', true), '2026-07-15 09:05:07');
    assert.equal(dtp.nowDateTime(clock, 'date', true), '2026-07-15');
});

test('parseDateTimeInput rejects an offset on a date', () => {
    assert.match(dtp.parseDateTimeInput('2026-11-25 10:39+01', 'date').error, /no time zone offset/);
    assert.match(dtp.parseDateTimeInput('2026-11-25T10:39Z', 'date').error, /no time zone offset/);
    assert.equal(dtp.parseDateTimeInput('2026-11-25 10:39+01', 'timestamp').value, '2026-11-25 10:39+01');
});

// ===== isoWeek =====

test('isoWeek numbers the weeks around the turn of the year like ISO 8601', () => {
    assert.equal(dtp.isoWeek(2020, 12, 31), 53);
    assert.equal(dtp.isoWeek(2021, 1, 3), 53);
    assert.equal(dtp.isoWeek(2021, 1, 4), 1);
    assert.equal(dtp.isoWeek(2026, 12, 31), 53);
    assert.equal(dtp.isoWeek(2027, 1, 3), 53);
    assert.equal(dtp.isoWeek(2027, 1, 4), 1);
    assert.equal(dtp.isoWeek(2024, 12, 30), 1, 'the Monday of week 1 of 2025');
    assert.equal(dtp.isoWeek(2026, 11, 25), 48);
});

// ===== monthGrid / month arithmetic =====

test('monthGrid lays a month out in six Monday-first weeks', () => {
    const grid = dtp.monthGrid(2026, 11);
    assert.equal(grid.length, 6);
    assert.ok(grid.every((week: unknown[]) => week.length === 7));
    assert.deepEqual(grid[0][0], { y: 2026, m: 10, d: 26, inMonth: false }, 'November 2026 starts on a Sunday');
    assert.deepEqual(grid[0][6], { y: 2026, m: 11, d: 1, inMonth: true });
    assert.deepEqual(grid[5][6], { y: 2026, m: 12, d: 6, inMonth: false });
    assert.ok(grid.every((week: Array<{ y: number; m: number; d: number }>) => dtp.weekdayIndex(week[0].y, week[0].m, week[0].d) === 0));
    const first = dtp.monthGrid(2021, 2)[0][0];
    assert.deepEqual(first, { y: 2021, m: 2, d: 1, inMonth: true }, 'a month starting on a Monday starts the grid');
});

test('addMonths and daysInMonth cross year ends and leap years', () => {
    assert.deepEqual(dtp.addMonths(2026, 12, 1), { y: 2027, m: 1 });
    assert.deepEqual(dtp.addMonths(2026, 1, -1), { y: 2025, m: 12 });
    assert.deepEqual(dtp.addMonths(2026, 11, -24), { y: 2024, m: 11 });
    assert.equal(dtp.daysInMonth(2024, 2), 29);
    assert.equal(dtp.daysInMonth(2026, 2), 28);
    assert.equal(dtp.daysInMonth(2026, 4), 30);
});

// ===== literalText =====

test('literalText finds the date inside a SQL literal of the Query Builder', () => {
    assert.equal(dtp.literalText("'2026-11-25 10:39'"), '2026-11-25 10:39');
    assert.equal(dtp.literalText("TIMESTAMP '2026-11-25'"), '2026-11-25');
    assert.equal(dtp.literalText("'2026-11-25'::date"), '2026-11-25');
    assert.equal(dtp.literalText('now()'), 'now()');
});
