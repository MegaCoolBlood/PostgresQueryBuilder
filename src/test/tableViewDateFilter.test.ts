import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PICKER_INPUTS, PICKER_SHORTCUTS } from './helpers/dateTimeInputs';

const {
    normalizeDateTimeFilterValue,
    buildFilterClause,
    rowValueMatchesFilter,
    splitWhereByAnd,
    whereClauseTargetsColumn,
    parseSqlForWhere,
    mergeColumnConditions,
    assembleWhereQuery,
    formatSql
} = require(path.join(__dirname, '../../../src/webview/tableView.js'));
const dtp = require(path.join(__dirname, '../../../src/webview/dateTimePicker.js'));

const SEP = ' ';
const TABLE_SQL = 'SELECT * FROM leda.bos_http_log';

// Merges column filters into `sql` the way the Data Viewer does when Enter is
// pressed in the filter row.
function applyFilters(sql: string, clausesByCol: Record<string, string | null>): string {
    const parsed = parseSqlForWhere(sql);
    const byCol: Record<string, string> = {};
    for (const col of Object.keys(clausesByCol)) byCol[col] = clausesByCol[col] || '';
    return assembleWhereQuery(parsed, mergeColumnConditions(parsed, byCol));
}

function dateClause(val: unknown, operator: string, kind = 'timestamp'): string | null {
    return buildFilterClause('hl_adat', val, 'date', false, operator, SEP, kind);
}

// ===== normalizeDateTimeFilterValue =====

test('normalizeDateTimeFilterValue writes a datetime-local value with a space and its minute as the unit', () => {
    const v = normalizeDateTimeFilterValue('2026-11-25T10:39', 'timestamp');
    assert.equal(v.iso, '2026-11-25 10:39');
    assert.equal(v.end, '2026-11-25 10:40');
    assert.equal(v.unit, 'minute');
});

test('normalizeDateTimeFilterValue takes the unit from the precision written', () => {
    assert.deepEqual(
        ['2026-11-25', '2026-11-25 10:39', '2026-11-25T10:39:15', '2026-11-25T10:39:15.123']
            .map(s => { const v = normalizeDateTimeFilterValue(s, 'timestamp'); return [v.iso, v.end, v.unit]; }),
        [
            ['2026-11-25', '2026-11-26', 'day'],
            ['2026-11-25 10:39', '2026-11-25 10:40', 'minute'],
            ['2026-11-25 10:39:15', '2026-11-25 10:39:16', 'second'],
            ['2026-11-25 10:39:15.123', '2026-11-25 10:39:15.124', 'fraction']
        ]
    );
});

test('normalizeDateTimeFilterValue reads the dotted European form', () => {
    assert.equal(normalizeDateTimeFilterValue('25.11.2026 10:39', 'timestamp').iso, '2026-11-25 10:39');
    assert.equal(normalizeDateTimeFilterValue('5.1.2026 9:05', 'timestamp').iso, '2026-01-05 09:05');
    assert.equal(normalizeDateTimeFilterValue('25.11.2026', 'timestamp').iso, '2026-11-25');
});

test('normalizeDateTimeFilterValue works on whole days for a date column', () => {
    const v = normalizeDateTimeFilterValue('2026-11-25T10:39', 'date');
    assert.deepEqual([v.iso, v.end, v.unit], ['2026-11-25', '2026-11-26', 'day']);
});

test('normalizeDateTimeFilterValue rolls the end over days, months, years and leap days', () => {
    const end = (s: string) => normalizeDateTimeFilterValue(s, 'timestamp').end;
    assert.equal(end('2026-11-25 23:59'), '2026-11-26 00:00');
    assert.equal(end('2026-04-30 23:59:59'), '2026-05-01 00:00:00');
    assert.equal(end('2026-12-31 23:59'), '2027-01-01 00:00');
    assert.equal(end('2024-02-28'), '2024-02-29');
    assert.equal(end('2024-02-29'), '2024-03-01');
    assert.equal(end('2023-02-28 23:59'), '2023-03-01 00:00');
    assert.equal(end('2026-12-31'), '2027-01-01');
});

test('normalizeDateTimeFilterValue rejects unreadable values and an offset on a date', () => {
    for (const s of ['', 'yesterday', '2026-02-30', '2023-02-29', '2026-11-25 24:00', '32.01.2026', '2026-11-25 10:39+01 x', 'infinityx']) {
        assert.equal(normalizeDateTimeFilterValue(s, 'timestamp'), null, s);
    }
    assert.equal(normalizeDateTimeFilterValue('2026-11-25 10:39+01', 'date'), null);
});

test('normalizeDateTimeFilterValue keeps an offset in both ends of the unit', () => {
    const v = normalizeDateTimeFilterValue('25.11.2026 10:39 +01', 'timestamp');
    assert.deepEqual([v.iso, v.end, v.unit, v.zone], ['2026-11-25 10:39+01', '2026-11-25 10:40+01', 'minute', '+01']);
    const z = normalizeDateTimeFilterValue('2026-11-25t23:59:59z', 'timestamp');
    assert.deepEqual([z.iso, z.end], ['2026-11-25 23:59:59Z', '2026-11-26 00:00:00Z']);
});

test('normalizeDateTimeFilterValue reads every value the date picker accepts and writes', () => {
    const now = new Date(2026, 10, 25, 14, 7, 33);
    for (const kind of ['date', 'timestamp']) {
        for (const text of [...PICKER_INPUTS, ...PICKER_SHORTCUTS]) {
            const picked = dtp.parseDateTimeInput(text, kind, now);
            if (picked.error) continue;
            assert.notEqual(normalizeDateTimeFilterValue(picked.value, kind), null, `${kind} ${text} ? ${picked.value}`);
            if (PICKER_INPUTS.includes(text)) assert.notEqual(normalizeDateTimeFilterValue(text, kind), null, `${kind} ${text} as typed`);
        }
    }
});

// ===== buildFilterClause (date) =====

test('buildFilterClause makes = on a minute cover the whole minute', () => {
    assert.equal(dateClause('2026-11-25T10:39', '='), `(hl_adat >= '2026-11-25 10:39' AND hl_adat < '2026-11-25 10:40')`);
});

test('buildFilterClause builds every operator from the unit of the value', () => {
    const cases: Array<[string, string, string]> = [
        ['=', '2026-11-25 10:39:15', `(hl_adat >= '2026-11-25 10:39:15' AND hl_adat < '2026-11-25 10:39:16')`],
        ['!=', '2026-11-25 10:39', `NOT (hl_adat >= '2026-11-25 10:39' AND hl_adat < '2026-11-25 10:40')`],
        ['<', '2026-11-25 10:39', `hl_adat < '2026-11-25 10:39'`],
        ['<=', '2026-11-25 10:39', `hl_adat < '2026-11-25 10:40'`],
        ['>', '2026-11-25 10:39', `hl_adat >= '2026-11-25 10:40'`],
        ['>=', '2026-11-25 10:39', `hl_adat >= '2026-11-25 10:39'`],
        ['=', '2026-11-25', `(hl_adat >= '2026-11-25' AND hl_adat < '2026-11-26')`],
        ['<=', '2024-02-28', `hl_adat < '2024-02-29'`],
        ['>', '2026-12-31 23:59:59', `hl_adat >= '2027-01-01 00:00:00'`]
    ];
    for (const [op, value, expected] of cases) assert.equal(dateClause(value, op), expected, `${op} ${value}`);
});

test('buildFilterClause builds a date range from the start of from to the end of to', () => {
    assert.equal(
        dateClause({ from: '2026-11-25T10:39', to: '2026-11-25T11:39' }, '='),
        `(hl_adat >= '2026-11-25 10:39' AND hl_adat < '2026-11-25 11:40')`
    );
    assert.equal(dateClause({ from: '2026-11-25T10:39', to: '' }, '='), `hl_adat >= '2026-11-25 10:39'`);
    assert.equal(dateClause({ from: '', to: '2026-11-30' }, '='), `hl_adat < '2026-12-01'`);
    assert.equal(dateClause({ from: '', to: '' }, '='), null);
});

test('buildFilterClause uses whole days on a date column', () => {
    assert.equal(
        buildFilterClause('d', '2026-11-25', 'date', false, '=', SEP, 'date'),
        `(d >= '2026-11-25' AND d < '2026-11-26')`
    );
});

test('buildFilterClause compares with infinity as one point', () => {
    const cases: Array<[string, string, string]> = [
        ['=', 'infinity', `hl_adat = 'infinity'`],
        ['!=', '-Infinity', `hl_adat <> '-infinity'`],
        ['<', 'infinity', `hl_adat < 'infinity'`],
        ['<=', 'infinity', `hl_adat <= 'infinity'`],
        ['>', '-infinity', `hl_adat > '-infinity'`],
        ['>=', '+infinity', `hl_adat >= 'infinity'`]
    ];
    for (const [op, value, expected] of cases) assert.equal(dateClause(value, op), expected, `${op} ${value}`);
    assert.equal(buildFilterClause('d', 'infinity', 'date', false, '=', SEP, 'date'), `d = 'infinity'`);
    assert.equal(
        dateClause({ from: '2026-11-25', to: 'infinity' }, '='),
        `(hl_adat >= '2026-11-25' AND hl_adat <= 'infinity')`
    );
});

test('buildFilterClause keeps the offset of a timestamptz value in both bounds', () => {
    assert.equal(dateClause('2026-11-25 10:39+01', '='), `(hl_adat >= '2026-11-25 10:39+01' AND hl_adat < '2026-11-25 10:40+01')`);
    assert.equal(dateClause('2026-11-25T10:39:15-05:30', '>'), `hl_adat >= '2026-11-25 10:39:16-05:30'`);
});

test('an infinity filter replaces the condition of the column instead of dropping it', () => {
    const before = `${TABLE_SQL} WHERE (hl_adat >= '2026-11-25' AND hl_adat < '2026-11-26') AND hl_status = 200`;
    assert.equal(applyFilters(before, { hl_adat: dateClause('infinity', '=') }), `${TABLE_SQL} WHERE hl_status = 200 AND hl_adat = 'infinity'`);
});

test('buildFilterClause writes no date condition for an unreadable value', () => {
    assert.equal(dateClause('not a date', '='), null);
    assert.equal(dateClause({ from: 'nope', to: '2026-11-25' }, '='), `hl_adat < '2026-11-26'`);
});

test('buildFilterClause keeps an exact match on a timestamp as plain equality', () => {
    assert.equal(
        buildFilterClause('hl_adat', '2026-11-25 10:45:12.123', 'date', true, '=', SEP, 'timestamp'),
        `hl_adat = '2026-11-25 10:45:12.123'`
    );
});

// ===== rowValueMatchesFilter (date) =====

test('rowValueMatchesFilter keeps a timestamp inside a datetime-local range', () => {
    const range = { from: '2026-11-25T10:39', to: '2026-11-25T11:39' };
    assert.equal(rowValueMatchesFilter('2026-11-25 10:45:12', range, 'date', 'between', SEP, 'timestamp'), true);
    assert.equal(rowValueMatchesFilter('2026-11-25 11:39:59.999', range, 'date', 'between', SEP, 'timestamp'), true);
    assert.equal(rowValueMatchesFilter('2026-11-25 11:40:00', range, 'date', 'between', SEP, 'timestamp'), false);
    assert.equal(rowValueMatchesFilter('2026-11-25 10:38:59', range, 'date', 'between', SEP, 'timestamp'), false);
    assert.equal(rowValueMatchesFilter(null, range, 'date', 'between', SEP, 'timestamp'), false);
});

test('rowValueMatchesFilter applies every date operator like the SQL condition', () => {
    const at = (cell: string, mode: string, value: string) => rowValueMatchesFilter(cell, value, 'date', mode, SEP, 'timestamp');
    assert.equal(at('2026-11-25 10:39:30', 'equals', '2026-11-25T10:39'), true);
    assert.equal(at('2026-11-25 10:40:00', 'equals', '2026-11-25T10:39'), false);
    assert.equal(at('2026-11-25 10:39:30', 'not_equals', '2026-11-25T10:39'), false);
    assert.equal(at('2026-11-25 10:40:00', 'not_equals', '2026-11-25T10:39'), true);
    assert.equal(at('2026-11-25 10:39:30', 'lt', '2026-11-25T10:39'), false);
    assert.equal(at('2026-11-25 10:39:30', 'lte', '2026-11-25T10:39'), true);
    assert.equal(at('2026-11-25 10:39:30', 'gt', '2026-11-25T10:39'), false);
    assert.equal(at('2026-11-25 10:40:00', 'gt', '2026-11-25T10:39'), true);
    assert.equal(at('2026-11-25 10:39:00', 'gte', '2026-11-25T10:39'), true);
    assert.equal(at('2026-11-25 23:59:59', 'equals', '2026-11-25'), true);
    assert.equal(at('2026-11-26 00:00:00', 'equals', '2026-11-25'), false);
});

test('rowValueMatchesFilter compares timestamptz cells on their local time and ignores the offset', () => {
    assert.equal(rowValueMatchesFilter('2026-11-25 10:45:12.123+01', '2026-11-25T10:45', 'date', 'equals', SEP, 'timestamp'), true);
    assert.equal(rowValueMatchesFilter('2026-11-25 10:45:12+05:30', '2026-11-25T10:45:12', 'date', 'equals', SEP, 'timestamp'), true);
    assert.equal(rowValueMatchesFilter('2026-11-25 10:46:00-08', '2026-11-25T10:45', 'date', 'equals', SEP, 'timestamp'), false);
});

test('rowValueMatchesFilter matches date cells on whole days', () => {
    assert.equal(rowValueMatchesFilter('2026-11-25', '25.11.2026', 'date', 'equals', SEP, 'date'), true);
    assert.equal(rowValueMatchesFilter('2026-11-24', { from: '2026-11-25', to: '' }, 'date', 'between', SEP, 'date'), false);
});

test('rowValueMatchesFilter lets every row through an unreadable date filter', () => {
    assert.equal(rowValueMatchesFilter('2026-11-25 10:45:12', 'garbage', 'date', 'equals', SEP, 'timestamp'), true);
    assert.equal(rowValueMatchesFilter('2026-11-25 10:45:12', { from: '', to: '' }, 'date', 'between', SEP, 'timestamp'), true);
});

test('rowValueMatchesFilter compares cells with an infinity filter like the SQL condition', () => {
    const at = (cell: string, mode: string, value: string) => rowValueMatchesFilter(cell, value, 'date', mode, SEP, 'timestamp');
    assert.equal(at('infinity', 'equals', 'infinity'), true);
    assert.equal(at('2026-11-25 10:39:00', 'equals', 'infinity'), false);
    assert.equal(at('infinity', 'not_equals', 'infinity'), false);
    assert.equal(at('-infinity', 'not_equals', 'infinity'), true);
    assert.equal(at('2026-11-25 10:39:00', 'lt', 'infinity'), true);
    assert.equal(at('infinity', 'lt', 'infinity'), false);
    assert.equal(at('infinity', 'lte', 'infinity'), true);
    assert.equal(at('-infinity', 'gt', '-infinity'), false);
    assert.equal(at('2026-11-25 10:39:00', 'gt', '-infinity'), true);
    assert.equal(at('-infinity', 'gte', '-infinity'), true);
    assert.equal(rowValueMatchesFilter('infinity', { from: '2026-11-25', to: 'infinity' }, 'date', 'between', SEP, 'timestamp'), true);
});

test('rowValueMatchesFilter leaves a filter value with an offset to the database', () => {
    assert.equal(rowValueMatchesFilter('2026-11-25 08:00:00+01', '2026-11-25 10:39+01', 'date', 'equals', SEP, 'timestamp'), true);
    assert.equal(rowValueMatchesFilter('2026-11-25 08:00:00', { from: '2026-11-25 10:39Z', to: '' }, 'date', 'between', SEP, 'timestamp'), true);
});

test('rowValueMatchesFilter places infinity outside every bound', () => {
    assert.equal(rowValueMatchesFilter('infinity', '2026-11-25', 'date', 'gt', SEP, 'timestamp'), true);
    assert.equal(rowValueMatchesFilter('-infinity', '2026-11-25', 'date', 'lt', SEP, 'timestamp'), true);
    assert.equal(rowValueMatchesFilter('infinity', '2026-11-25', 'date', 'equals', SEP, 'timestamp'), false);
});

// ===== splitWhereByAnd =====

test('splitWhereByAnd keeps the AND of a BETWEEN with it', () => {
    assert.deepEqual(
        splitWhereByAnd(`hl_adat BETWEEN '2026-11-25T10:39' AND '2026-11-25T11:39' AND hl_session::TEXT ILIKE '%a%'`),
        [`hl_adat BETWEEN '2026-11-25T10:39' AND '2026-11-25T11:39'`, `hl_session::TEXT ILIKE '%a%'`]
    );
});

test('splitWhereByAnd keeps NOT BETWEEN and BETWEEN SYMMETRIC together', () => {
    assert.deepEqual(
        splitWhereByAnd('a NOT BETWEEN 1 AND 5 AND b between symmetric 9 and 2 AND c = 1'),
        ['a NOT BETWEEN 1 AND 5', 'b between symmetric 9 and 2', 'c = 1']
    );
});

test('splitWhereByAnd handles BETWEEN with parenthesised bounds and inside parentheses', () => {
    assert.deepEqual(
        splitWhereByAnd('a BETWEEN (SELECT min(x) FROM t WHERE y BETWEEN 1 AND 2) AND (3 + 4) AND (b BETWEEN 1 AND 2 AND c = 3) AND d = 4'),
        ['a BETWEEN (SELECT min(x) FROM t WHERE y BETWEEN 1 AND 2) AND (3 + 4)', '(b BETWEEN 1 AND 2 AND c = 3)', 'd = 4']
    );
});

test('splitWhereByAnd ignores BETWEEN and AND inside strings, quoted names and longer words', () => {
    assert.deepEqual(
        splitWhereByAnd(`note = 'x between y' AND "between" = 1 AND between_at = 2 AND name = 'a and b'`),
        [`note = 'x between y'`, `"between" = 1`, 'between_at = 2', `name = 'a and b'`]
    );
});

test('formatSql keeps a BETWEEN on one line of the WHERE', () => {
    assert.equal(
        formatSql('SELECT * FROM t WHERE a BETWEEN 1 AND 2 AND b = 3'),
        'SELECT *\nFROM t\nWHERE a BETWEEN 1 AND 2\n    AND b = 3'
    );
});

// ===== whereClauseTargetsColumn (date ranges) =====

test('whereClauseTargetsColumn recognises the parenthesised date range of a column', () => {
    assert.equal(whereClauseTargetsColumn(`(hl_adat >= '2026-11-25 10:39' AND hl_adat < '2026-11-25 10:40')`, 'hl_adat'), true);
    assert.equal(whereClauseTargetsColumn(`NOT (hl_adat >= '2026-11-25 10:39' AND hl_adat < '2026-11-25 10:40')`, 'hl_adat'), true);
    assert.equal(whereClauseTargetsColumn(`(t."hl_adat" >= '2026-11-25' AND t."hl_adat" < '2026-11-26')`, 'hl_adat'), true);
});

test('whereClauseTargetsColumn leaves a parenthesised group on other columns alone', () => {
    assert.equal(whereClauseTargetsColumn('(a = 1 OR b = 2)', 'a'), false);
    assert.equal(whereClauseTargetsColumn('(a = 1 AND b = 2)', 'a'), false);
    assert.equal(whereClauseTargetsColumn('(a = 1) OR (a = 2)', 'a'), false);
});

// ===== user scenarios: filter row → merged WHERE =====

test('a datetime-local range filter writes ISO bounds that cover the to minute', () => {
    const sql = applyFilters(TABLE_SQL, { hl_adat: dateClause({ from: '2026-11-25T10:39', to: '2026-11-25T11:39' }, '=') });
    assert.equal(sql, `${TABLE_SQL} WHERE (hl_adat >= '2026-11-25 10:39' AND hl_adat < '2026-11-25 11:40')`);
    assert.equal(
        rowValueMatchesFilter('2026-11-25 10:45:12', { from: '2026-11-25T10:39', to: '2026-11-25T11:39' }, 'date', 'between', SEP, 'timestamp'),
        true
    );
});

test('clearing one bound of an old BETWEEN and filtering another column writes valid SQL', () => {
    const before = `${TABLE_SQL} WHERE hl_adat BETWEEN '2026-11-25T10:39' AND '2026-11-25T11:39'`;
    const sql = applyFilters(before, {
        hl_adat: dateClause({ from: '', to: '2026-11-25T11:39' }, '='),
        hl_session: `hl_session::TEXT ILIKE '%a%'`
    });
    assert.equal(sql, `${TABLE_SQL} WHERE hl_adat < '2026-11-25 11:40' AND hl_session::TEXT ILIKE '%a%'`);
});

test('switching an old BETWEEN to = replaces it as a whole', () => {
    const before = `${TABLE_SQL} WHERE hl_adat BETWEEN '2026-11-25T10:39' AND '2026-11-25T11:39' AND hl_session::TEXT ILIKE '%a%'`;
    const sql = applyFilters(before, { hl_adat: dateClause('2026-11-25T15:42', '=') });
    assert.equal(
        sql,
        `${TABLE_SQL} WHERE hl_session::TEXT ILIKE '%a%' AND (hl_adat >= '2026-11-25 15:42' AND hl_adat < '2026-11-25 15:43')`
    );
});

test('filtering again replaces the parenthesised date range of the column', () => {
    const before = `${TABLE_SQL} WHERE (hl_adat >= '2026-11-25 10:39' AND hl_adat < '2026-11-25 11:40') AND hl_status = 200`;
    assert.equal(
        applyFilters(before, { hl_adat: dateClause('2026-11-25T15:42', '!=') }),
        `${TABLE_SQL} WHERE hl_status = 200 AND NOT (hl_adat >= '2026-11-25 15:42' AND hl_adat < '2026-11-25 15:43')`
    );
    const negated = `${TABLE_SQL} WHERE NOT (hl_adat >= '2026-11-25 15:42' AND hl_adat < '2026-11-25 15:43') AND hl_status = 200`;
    assert.equal(
        applyFilters(negated, { hl_adat: dateClause('2026-11-25', '>=') }),
        `${TABLE_SQL} WHERE hl_status = 200 AND hl_adat >= '2026-11-25'`
    );
});

test('clearing a date filter removes its parenthesised range', () => {
    const before = `${TABLE_SQL} WHERE hl_status = 200 AND (hl_adat >= '2026-11-25 10:39' AND hl_adat < '2026-11-25 11:40')`;
    assert.equal(applyFilters(before, { hl_adat: null }), `${TABLE_SQL} WHERE hl_status = 200`);
    assert.equal(
        applyFilters(`${TABLE_SQL} WHERE (hl_adat >= '2026-11-25' AND hl_adat < '2026-11-26')`, { hl_adat: null }),
        TABLE_SQL
    );
});
