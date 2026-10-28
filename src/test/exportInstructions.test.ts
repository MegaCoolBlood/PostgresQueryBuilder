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
    formatExportMessage,
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
    assert.deepEqual(VALUES, { date: '2026-10-26', time: '070509', file: 'payroll' });
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

test('an export is listed with its line, its rows and its file', () => {
    assert.equal(formatExportMessage('payroll.sql', 11, 1234, 'C:\\exports\\orders.csv', NOW), '[07:05:09] payroll.sql — EXPORT: line 12, 1234 rows to C:\\exports\\orders.csv');
    assert.match(formatExportMessage('payroll.sql', 0, 1, 'o.csv', NOW), /line 1, 1 row to/);
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
