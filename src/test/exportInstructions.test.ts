import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { statementRanges } from '../sqlFileSession';
import {
    EXPORT_DIALOG_PRESETS,
    EXPORT_FILE_EXTENSIONS,
    defaultExportFileName,
    exportDialogChoiceFrom,
    exportPlaceholders,
    exportSettingsFor,
    exportTargetErrors,
    fillExportPlaceholders,
    shiftClock,
    parseExportInstruction,
    planExportInstructions,
    resolveExportTarget
} from '../exportInstructions';

const ROOT = path.join(__dirname, '..', '..', '..');

/** The instruction parsed from `text`, failing the test on an error. */
function parsed(text: string) {
    const result = parseExportInstruction(text, 4);
    assert.ok('instruction' in result, 'error' in result ? result.error.message : '');
    return result.instruction;
}

/** The message of the error `text` gives. */
function rejected(text: string): string {
    const result = parseExportInstruction(text, 4);
    assert.ok('error' in result, `"${text}" was accepted`);
    assert.equal(result.error.line, 4);
    return result.error.message;
}

// ===== parseExportInstruction =====

test('an instruction names the format and the options of the export dialog', () => {
    assert.deepEqual(parsed(' csv file=exports/orders.csv separator=; header=false quote=no lineending=LF'), {
        line: 4,
        format: 'csv',
        dialog: false,
        file: 'exports/orders.csv',
        options: { csvSeparator: ';', csvIncludeHeaders: false, csvQuoteStrings: false, csvLineEnding: 'lf' }
    });
    assert.deepEqual(parsed('excel sheet="Open orders" sqlsheet=yes').options, { excelSheetName: 'Open orders', excelIncludeSqlSheet: true });
    assert.deepEqual(parsed('json pretty=off array=on').options, { jsonPretty: false, jsonArrayWrapper: true });
    assert.deepEqual(parsed('xml root=orders row=order').options, { xmlRootElement: 'orders', xmlRowElement: 'order' });
    assert.deepEqual(parsed('insert table=archive.orders batch=100 onconflict=update conflict="id, tenant"').options, {
        insertTableName: 'archive.orders', insertBatchSize: 100, insertOnConflict: 'update', insertConflictColumns: ['id', 'tenant']
    });
});

test('formats have their aliases and words their places and spellings', () => {
    assert.equal(parsed('XLSX').format, 'excel');
    assert.equal(parsed('sql dialog').format, 'insert');
    assert.equal(parsed('file=out.csv CSV').format, 'csv');
    assert.equal(parsed('csv separator=tab').options.csvSeparator, '\t');
    assert.equal(parsed('csv separator=semicolon').options.csvSeparator, ';');
    assert.equal(parsed("csv file='my exports/a b.csv'").file, 'my exports/a b.csv');
    assert.equal(parsed('csv file="say ""hi"".csv"').file, 'say "hi".csv');
});

test('dialog opens the export dialog, which may also choose the format', () => {
    assert.deepEqual(parsed('dialog'), { line: 4, format: undefined, dialog: true, file: undefined, options: {} });
    const insert = parsed('insert dialog');
    assert.equal(insert.dialog, true);
    assert.equal(insert.options.insertTableName, undefined, 'the table is entered in the dialog');
});

test('a wrong instruction is refused with what is wrong', () => {
    assert.match(rejected(''), /Name the format — csv, excel, json, xml or insert — or add dialog/);
    assert.match(rejected('csv json'), /two formats, csv and json/);
    assert.match(rejected('cvs'), /"cvs" is neither a format/);
    assert.match(rejected('json separator=;'), /separator= is no option of a json export; it knows file, pretty, array/);
    assert.match(rejected('csv header=true header=false'), /header= is given twice/);
    assert.match(rejected('csv header=maybe'), /header=maybe is neither true nor false/);
    assert.match(rejected('csv lineending=cr'), /no line ending/);
    assert.match(rejected('insert table=t batch=0'), /from 1 to 1000/);
    assert.match(rejected('insert'), /needs table=/);
    assert.match(rejected('insert table=t onconflict=update'), /onconflict=update needs conflict=/);
    assert.match(rejected('insert table=t onconflict=merge'), /none of none, nothing and update/);
    assert.match(rejected('excel sheet=a/b'), /no valid sheet name/);
    assert.match(rejected('xml root="a b"'), /no valid XML element name/);
    assert.match(rejected('csv file="out.csv'), /never closed/);
    assert.match(rejected('dialog header=true'), /Name the format before its options/);
    assert.match(rejected('csv file='), /file= needs a file name/);
    assert.match(rejected('csv separator="a""b"'), /separator/);
});

// ===== planExportInstructions =====

const returnsRows = (sql: string) => /^\s*(select|with|values|table)\b/i.test(sql);

/** The statements of a script, as Execute File splits them. */
function rangesOf(text: string): Array<{ start: number; end: number }> {
    return statementRanges(text).filter((range): range is { start: number; end: number } => range !== null);
}

const SCRIPT = [
    "DO $$ BEGIN PERFORM set_config('app.month', '2026-10', false); END $$;", // 0
    '',                                                                       // 1
    '-- the orders of the month',                                             // 2
    '-- @export csv file=exports/orders_{date}.csv separator=;',              // 3
    '',                                                                       // 4
    'SELECT * FROM orders',                                                   // 5
    '-- @export not an instruction: it is inside the statement',              // 6
    "WHERE month = current_setting('app.month');",                            // 7
    '',                                                                       // 8
    'SELECT * FROM customers;'                                                // 9
].join('\n');

test('an instruction belongs to the statement below it, across comments and blank lines', () => {
    const { statements, errors } = planExportInstructions(SCRIPT, rangesOf(SCRIPT), returnsRows);
    assert.deepEqual(errors, []);
    assert.deepEqual(statements.map((s) => s.instruction?.line ?? null), [null, 3, null]);
    assert.equal(statements[1].instruction?.file, 'exports/orders_{date}.csv');
});

test('the instruction keyword is matched as a word in any letter case', () => {
    const text = '-- @EXPORT json\nSELECT 1;\n-- @exported yesterday\nSELECT 2;';
    const { statements } = planExportInstructions(text, rangesOf(text), returnsRows);
    assert.deepEqual(statements.map((s) => s.instruction?.format ?? null), ['json', null]);
});

test('every wrong instruction of a script is reported before anything runs', () => {
    const text = [
        '-- @export csv',          // 0
        'UPDATE orders SET x = 1;', // 1
        '-- @export cvs',           // 2
        'SELECT 1;',                // 3
        '-- @export csv',           // 4
        '-- @export json',          // 5
        'SELECT 2;',                // 6
        '-- @export csv'            // 7
    ].join('\n');
    const { errors } = planExportInstructions(text, rangesOf(text), returnsRows);
    assert.deepEqual(errors.map((e) => e.line), [0, 2, 5, 7]);
    assert.match(errors[0].message, /returns no rows/);
    assert.match(errors[1].message, /"cvs" is neither a format/);
    assert.match(errors[2].message, /Only one @export instruction may stand above a statement; line 5 has one already/);
    assert.match(errors[3].message, /No statement follows it/);
});

test('a selection takes the instruction above its first statement and ignores the rest of the file', () => {
    const all = rangesOf(SCRIPT);
    const start = SCRIPT.indexOf('SELECT * FROM orders');
    const end = SCRIPT.indexOf(';', start);
    const plan = planExportInstructions(SCRIPT, [{ start, end }], returnsRows, {
        firstGapStart: all[0].end,
        trailingEnd: end
    });
    assert.deepEqual(plan.errors, []);
    assert.equal(plan.statements[0].instruction?.line, 3);
});

// ===== settings, presets and targets =====

test('the presets are what the export dialog of the Data Viewer shows', () => {
    const html = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'tableView.html'), 'utf8');
    const input = (id: string) => new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? '';
    const checked = (id: string) => /\schecked\b/.test(input(id));
    const value = (id: string) => /value="([^"]*)"/.exec(input(id))?.[1];
    const firstOption = (id: string) => new RegExp(`<select id="${id}">\\s*<option value="([^"]*)"`).exec(html)?.[1];
    assert.deepEqual(EXPORT_DIALOG_PRESETS, {
        csv: { csvSeparator: firstOption('csvSeparator'), csvIncludeHeaders: checked('csvIncludeHeaders'), csvQuoteStrings: checked('csvQuoteStrings'), csvLineEnding: firstOption('csvLineEnding') },
        json: { jsonPretty: checked('jsonPretty'), jsonArrayWrapper: checked('jsonArrayWrapper') },
        xml: { xmlRootElement: value('xmlRootElement'), xmlRowElement: value('xmlRowElement') },
        insert: { insertBatchSize: Number(value('insertBatchSize')), insertOnConflict: firstOption('insertOnConflict') },
        excel: { excelIncludeHeaders: checked('excelIncludeHeaders'), excelSheetName: value('excelSheetName'), excelIncludeSqlSheet: checked('excelIncludeSqlSheet') }
    });
});

test('options come from the dialog presets, then the saved defaults, then the instruction', () => {
    const saved = { csvSeparator: '|', csvLineEnding: 'lf' as const, insertTableName: 'other_table', filePath: 'C:\\old.csv' };
    assert.deepEqual(exportSettingsFor('csv', saved, { csvSeparator: ';' }, 'SELECT 1'), {
        format: 'csv', csvSeparator: ';', csvIncludeHeaders: true, csvQuoteStrings: true, csvLineEnding: 'lf'
    });
    assert.deepEqual(
        exportSettingsFor('insert', { insertTableName: 'other_table', insertBatchSize: 50 }, { insertTableName: 'archive.orders' }, 'SELECT 1'),
        { format: 'insert', insertBatchSize: 50, insertOnConflict: 'none', insertTableName: 'archive.orders' },
        'a saved table name of another export is never used'
    );
    assert.equal(exportSettingsFor('excel', undefined, {}, 'SELECT * FROM orders').excelSqlStatement, 'SELECT * FROM orders');
});

const NOW = new Date(2026, 9, 26, 7, 5, 9);
const VALUES = exportPlaceholders(NOW, 'C:\\work\\payroll.sql');

test('the placeholders of a file name are the date, the time and the SQL file', () => {
    assert.deepEqual(VALUES, { date: '2026-10-26', time: '070509', file: 'payroll', now: NOW });
});

// ===== clock placeholders =====

const fill = (file: string, now: Date) => fillExportPlaceholders(file, exportPlaceholders(now, 'C:\\work\\payroll.sql'));

test('the clock placeholders give every part of the time the export runs, zero-padded', () => {
    // Monday, 26 October 2026, 07:05:09.042 — the 299th day of the year.
    const now = new Date(2026, 9, 26, 7, 5, 9, 42);
    assert.deepEqual(
        fill('{YEAR}|{YR}|{MON}|{MDAY}|{YDAY}|{WDAY}|{HOUR}|{MIN}|{SEC}|{MSEC}', now),
        { text: '2026|26|10|26|299|1|07|05|09|042' }
    );
    assert.deepEqual(fill('{HOUR}{MIN}', new Date(2026, 9, 25, 23, 59)), { text: '2359' }, '24-hour clock');
    assert.deepEqual(fill('{WDAY}', new Date(2026, 9, 25)), { text: '7' }, 'Sunday is 7');
    assert.deepEqual(fill('{MDAY}.{MON}', new Date(2026, 0, 5)), { text: '05.01' });
});

test('{YDAY} counts to 366 in a leap year and to 365 otherwise', () => {
    assert.deepEqual(fill('{YDAY}', new Date(2028, 11, 31)), { text: '366' });
    assert.deepEqual(fill('{YDAY}', new Date(2026, 11, 31)), { text: '365' });
    assert.deepEqual(fill('{YDAY}', new Date(2026, 0, 1)), { text: '001' });
});

test('a clock placeholder is found in any case, like the others', () => {
    assert.deepEqual(fill('{year}_{Yr}_{date}_{FILE}', new Date(2026, 9, 26)), { text: '2026_26_2026-10-26_payroll' });
});

test('an offset moves a clock placeholder by its own unit, across the turn of the year', () => {
    // Friday, 1 January 2027, 00:05:09.007.
    const now = new Date(2027, 0, 1, 0, 5, 9, 7);
    assert.deepEqual(fill('{YR-1}', now), { text: '26' }, 'last two-digit year');
    assert.deepEqual(fill('{YEAR-1}_{YEAR+1}_{YR+1}', now), { text: '2026_2028_28' });
    assert.deepEqual(fill('{MON-1}_{MON+12}', now), { text: '12_01' });
    assert.deepEqual(fill('{MDAY-1}_{YDAY-1}', now), { text: '31_365' }, 'yesterday was 31 December 2026');
    assert.deepEqual(fill('{WDAY}_{WDAY+3}_{WDAY-5}', now), { text: '5_1_7' });
    assert.deepEqual(fill('{HOUR-1}_{MIN-10}_{SEC+51}_{MSEC-8}', now), { text: '23_55_00_999' });
    assert.deepEqual(fill('{YR-1}', new Date(2000, 5, 1)), { text: '99' });
    assert.deepEqual(fill('{MDAY+1}', new Date(2028, 1, 28)), { text: '29' }, 'the leap day');
});

test('an offset may be written with blanks', () => {
    assert.deepEqual(fill('{YR - 1}_{ MON }', new Date(2027, 0, 1)), { text: '26_{ MON }' }, 'a name with a blank before it is no placeholder');
    assert.deepEqual(fill('{YR -1}', new Date(2027, 0, 1)), { text: '26' });
});

test('a wrong offset or an offset on a fixed placeholder is refused with its reason', () => {
    const now = new Date(2027, 0, 1);
    assert.match((fill('{YR-x}', now) as any).error, /^\{YR-x\} is no placeholder; an offset is \+ or - and a whole number, such as \{YR-1\}, and may name a unit, such as \{YR-1 MON\}\.$/);
    assert.match((fill('{YR*2}', now) as any).error, /an offset is \+ or -/);
    assert.match((fill('{date-1}', now) as any).error, /^\{date-1\}: only the clock placeholders .* take an offset\.$/);
    assert.match((fill('{file+1}', now) as any).error, /only the clock placeholders/);
    assert.match((fill('{month}', now) as any).error, /\{month\} is no placeholder; file= knows \{date\}, \{time\}, \{file\}, \{YEAR\}, \{YR\}, .*\{MSEC\}\./);
});

test('file= with clock placeholders names its file before anything runs', () => {
    const values = exportPlaceholders(new Date(2027, 0, 15, 8, 30), 'C:\\work\\payroll.sql');
    assert.deepEqual(resolveExportTarget('out/{file}_{YEAR}{MON-1}', 'csv', 'C:\\work', values, path.win32), { path: 'C:\\work\\out\\payroll_202712.csv' });
    assert.deepEqual(
        exportTargetErrors([{ start: 0, end: 1, instruction: { line: 3, format: 'csv', file: 'o_{YR-}', dialog: false, options: {} } as any }], 'C:\\work', values),
        [{ line: 3, message: '{YR-} is no placeholder; an offset is + or - and a whole number, such as {YR-1}, and may name a unit, such as {YR-1 MON}.' }]
    );
});

// ===== offsets with a unit =====

test('an offset may name the unit it steps by, so the year follows the month back', () => {
    // Friday, 15 January 2027, 08:30.
    const now = new Date(2027, 0, 15, 8, 30);
    assert.deepEqual(fill('{YR-1 MON}', now), { text: '26' }, 'the year of last month');
    assert.deepEqual(fill('{YEAR-1 MON}{MON-1}', now), { text: '202612' }, 'last month with its year');
    assert.deepEqual(fill('{YEAR-1 MON}{MON-1 MON}', now), { text: '202612' }, 'the own unit may be named');
    assert.deepEqual(fill('{YEAR}{MON-1}', now), { text: '202712' }, 'without a unit each placeholder moves on its own');
    assert.deepEqual(fill('{YEAR-1 MON}', new Date(2027, 5, 15)), { text: '2027' }, 'in June last month is this year');
    assert.deepEqual(fill('{MON-14 DAY}{MDAY-14 DAY}', now), { text: '0101' }, 'two weeks back is 1 January');
    assert.deepEqual(fill('{YEAR-15 DAY}-{MON-15 DAY}-{MDAY-15}', now), { text: '2026-12-31' });
    assert.deepEqual(fill('{MDAY-9 HOUR}_{HOUR-9 HOUR}', now), { text: '14_23' }, 'nine hours back is yesterday evening');
    assert.deepEqual(fill('{YDAY+1 YEAR}', new Date(2027, 11, 31)), { text: '366' }, '31 December of the leap year 2028');
});

test('a month or a year back keeps the day where the month has it, and takes its last day otherwise', () => {
    assert.deepEqual(fill('{MON-1 MON}-{MDAY-1 MON}', new Date(2027, 2, 31)), { text: '02-28' });
    assert.deepEqual(fill('{MON-1 MON}-{MDAY-1 MON}', new Date(2028, 2, 31)), { text: '02-29' });
    assert.deepEqual(fill('{YEAR-1 YEAR}-{MDAY-1 YEAR}', new Date(2028, 1, 29)), { text: '2027-28' });
    assert.deepEqual(fill('{MON+1 MON}-{MDAY+1 MON}', new Date(2027, 0, 31)), { text: '02-28' });
    assert.deepEqual(fill('{MDAY-1 MON}', new Date(2027, 4, 15)), { text: '15' });
});

test('the unit is found in any case and may be written as the name of a placeholder', () => {
    const now = new Date(2027, 0, 1, 0, 30);
    assert.deepEqual(fill('{yr-1 mon}_{MON-1 Mon}', now), { text: '26_12' });
    assert.deepEqual(fill('{MON-1 MDAY}_{YEAR-1 YR}_{MON-1 WDAY}', now), { text: '12_2026_12' });
    assert.deepEqual(fill('{YR - 1  MON}', now), { text: '26' });
});

test('an unknown unit or a unit without a number is refused', () => {
    const now = new Date(2027, 0, 1);
    assert.equal((fill('{YR-1 WEEK}', now) as any).error, '{YR-1 WEEK}: the unit of an offset is YEAR, MON, DAY, HOUR, MIN, SEC or MSEC.');
    assert.match((fill('{YR MON}', now) as any).error, /^\{YR MON\} is no placeholder; an offset is/);
    assert.match((fill('{YR-1 MON DAY}', now) as any).error, /^\{YR-1 MON DAY\} is no placeholder/);
    assert.match((fill('{file-1 MON}', now) as any).error, /only the clock placeholders/);
});

test('shiftClock moves the moment on the calendar and keeps the time of day', () => {
    const at = new Date(2027, 2, 31, 8, 30, 15, 250);
    assert.deepEqual(shiftClock(at, -1, 'MON'), new Date(2027, 1, 28, 8, 30, 15, 250));
    assert.deepEqual(shiftClock(at, 13, 'MON'), new Date(2028, 3, 30, 8, 30, 15, 250));
    assert.deepEqual(shiftClock(at, -2, 'YEAR'), new Date(2025, 2, 31, 8, 30, 15, 250));
    assert.deepEqual(shiftClock(at, -31, 'DAY'), new Date(2027, 1, 28, 8, 30, 15, 250));
    assert.deepEqual(shiftClock(at, 90, 'MIN'), new Date(2027, 2, 31, 10, 0, 15, 250));
    assert.deepEqual(shiftClock(at, -251, 'MSEC'), new Date(2027, 2, 31, 8, 30, 14, 999));
});

test('file= is filled in, gets the extension of its format and is relative to the SQL file', () => {
    assert.deepEqual(resolveExportTarget('exports/{file}_{date}_{TIME}', 'csv', 'C:\\work', VALUES, path.win32), {
        path: 'C:\\work\\exports\\payroll_2026-10-26_070509.csv'
    });
    assert.deepEqual(resolveExportTarget('report.txt', 'csv', 'C:\\work', VALUES, path.win32), { path: 'C:\\work\\report.txt' });
    assert.deepEqual(resolveExportTarget('D:\\out\\orders', 'excel', 'C:\\work', VALUES, path.win32), { path: 'D:\\out\\orders.xlsx' });
    assert.deepEqual(resolveExportTarget('../out/o.json', 'json', '/srv/sql', VALUES, path.posix), { path: '/srv/out/o.json' });
});

test('file= with an unknown placeholder or relative to an unsaved file is refused', () => {
    assert.match((resolveExportTarget('o_{month}.csv', 'csv', 'C:\\work', VALUES, path.win32) as any).error, /\{month\} is no placeholder/);
    assert.match((resolveExportTarget('o.csv', 'csv', undefined, VALUES, path.win32) as any).error, /not saved yet/);
    assert.deepEqual(resolveExportTarget('C:\\o.csv', 'csv', undefined, VALUES, path.win32), { path: 'C:\\o.csv' });
});

test('an export without file= suggests a name after the SQL file and the line', () => {
    assert.equal(defaultExportFileName(VALUES, 11, 'excel'), 'payroll_line12.xlsx');
    assert.deepEqual(Object.keys(EXPORT_FILE_EXTENSIONS).sort(), ['csv', 'excel', 'insert', 'json', 'xml']);
});

// ===== the answer of the export dialog =====

test('the answer of the export dialog is taken with its file and the options it knows', () => {
    assert.deepEqual(exportDialogChoiceFrom({
        format: 'csv', filename: 'orders.csv', saveLocation: ' C:\\exports ',
        csvSeparator: ';', csvIncludeHeaders: false, csvLineEnding: 'lf', jsonPretty: 'yes', unknown: 1
    }), {
        settings: { format: 'csv', csvSeparator: ';', csvIncludeHeaders: false, csvLineEnding: 'lf' },
        fileName: 'orders.csv',
        folder: 'C:\\exports',
        typedFileName: '',
        askAtRunTime: false
    });
    const instruction = exportDialogChoiceFrom({ format: 'json', filename: 'export.json', typedFilename: ' out/{file} ', askAtRunTime: true });
    assert.equal(instruction?.typedFileName, 'out/{file}', 'as typed, placeholders and folders kept');
    assert.equal(instruction?.askAtRunTime, true);
    assert.equal(exportDialogChoiceFrom({ format: 'json', askAtRunTime: 'yes' })?.askAtRunTime, false);
});

test('a cancelled or malformed answer of the export dialog chooses nothing', () => {
    assert.equal(exportDialogChoiceFrom(null), undefined);
    assert.equal(exportDialogChoiceFrom({ format: 'pdf' }), undefined);
    assert.equal(exportDialogChoiceFrom({ format: 'xlsx' }), undefined, 'the dialog sends excel');
    const odd = exportDialogChoiceFrom({ format: 'insert', filename: '..\\..\\evil.sql', insertOnConflict: 'drop', csvLineEnding: 'cr' });
    assert.equal(odd?.fileName, 'evil.sql', 'the folder is chosen in its own field');
    assert.equal(odd?.settings.insertOnConflict, undefined);
});

// ===== the Export tab and the extension agree =====

test('the Export tab answers the extension with the message it handles', () => {
    const js = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'tableView.js'), 'utf8');
    const host = fs.readFileSync(path.join(ROOT, 'src', 'tableWebView.ts'), 'utf8');
    assert.ok(js.includes("command: 'exportDialogResult', options: opts"), 'Export answers with the options');
    assert.ok(js.includes("command: 'exportDialogResult', options: null"), 'Cancel answers with nothing');
    assert.ok(js.includes('if (msg.exportOnly)'), 'the panel knows the Export tab');
    assert.ok(host.includes('exportDialogResult: this.handleExportDialogResult'));
    assert.ok(host.includes('exportOnly: {'));
});

test('the export dialog of the Export tab shows the query it exports, as text and only there', () => {
    const html = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'tableView.html'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'tableView.css'), 'utf8');
    const js = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'tableView.js'), 'utf8');

    // Inside the dialog, between its header and its options.
    const dialog = html.slice(html.indexOf('id="exportDialogOverlay"'), html.indexOf('class="export-dialog-content"'));
    assert.match(dialog, /<span id="exportDialogTitle">Export Data<\/span>/);
    assert.match(dialog, /<div class="export-query" id="exportQuery">[\s\S]*<pre class="export-query-sql" id="exportQuerySql"[^>]*><\/pre>/);
    assert.equal(/id="exportQuery"[^>]*style=/.test(html), false, 'no inline style');

    // Hidden in the Data Viewer, whose query bar shows the query anyway.
    assert.match(css, /\.export-query \{\s*display: none;/);
    assert.match(css, /body\.export-only \.export-query \{\s*display: block;/);

    // The SQL comes from the file, so it is set as text, never as markup.
    assert.match(js, /getElementById\('exportQuerySql'\)\.textContent = typeof exportOnly\.sql === 'string' \? exportOnly\.sql : ''/);
    assert.match(js, /getElementById\('exportDialogTitle'\)\.textContent = title \|\| 'Export Data'/);
    assert.equal(/exportQuerySql'\)\.innerHTML/.test(js), false);
});
