import { fireDidChangeTextDocument, languageRegistrations, stubWarningMessage, vscodeStub } from './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
    ADD_EXPORT_INSTRUCTION_COMMAND,
    DIAGNOSTIC_SOURCE,
    EXPORT_FORMATS,
    EXPORT_OPTION_DOCS,
    EXPORT_SNIPPET,
    ExportInstructionAssist,
    exportInstructionCompletions,
    exportInstructionHover,
    exportInstructionProblems,
    formatExportInstruction,
    instructionChoiceProblem,
    instructionEdit,
    instructionFile,
    instructionPrefill,
    instructionTextFromChoice,
    locateExportTarget,
    queryTable,
    relocateExportTarget,
    type ExportTarget
} from '../exportInstructionAssist';
import {
    EXPORT_FORMAT_NAMES,
    EXPORT_INSTRUCTION_OPTIONS,
    exportPlaceholders,
    exportSettingsFor,
    parseExportInstruction,
    type ExportDialogChoice,
    type ExportSettings
} from '../exportInstructions';

const ROOT = path.join(__dirname, '..', '..', '..');
const VALUES = exportPlaceholders(new Date(2026, 9, 28, 13, 59, 58), 'C:\\work\\payroll.sql');

/** The options an instruction gives, read back from its text. */
function readBack(text: string) {
    const parsed = parseExportInstruction(text.replace(/^--\s*@export/, ''), 0);
    assert.ok('instruction' in parsed, 'error' in parsed ? `${text}: ${parsed.error.message}` : '');
    return parsed.instruction;
}

/** The target of `offset`, failing the test on an error. */
function target(text: string, offset: number): ExportTarget {
    const located = locateExportTarget(text, offset);
    assert.ok(!('error' in located), 'error' in located ? located.error : '');
    return located as ExportTarget;
}

function choice(settings: ExportSettings, typedFileName = '', folder = '', askAtRunTime = false): ExportDialogChoice {
    return { settings, fileName: typedFileName || 'export', folder, typedFileName, askAtRunTime };
}

// ===== the documentation of the options =====

test('every option of every format is documented, in the order of the export dialog', () => {
    assert.deepEqual([...EXPORT_FORMATS].sort(), [...new Set(Object.values(EXPORT_FORMAT_NAMES))].sort());
    for (const format of EXPORT_FORMATS) {
        assert.deepEqual(Object.keys(EXPORT_OPTION_DOCS[format]), Object.keys(EXPORT_INSTRUCTION_OPTIONS[format]), format);
    }
});

test('every value the suggestions offer is one the instruction accepts', () => {
    for (const format of EXPORT_FORMATS) {
        for (const [name, doc] of Object.entries(EXPORT_OPTION_DOCS[format])) {
            for (const { value } of doc.values ?? []) {
                const extra = format === 'insert' ? ' table=t conflict=id' : '';
                const parsed = parseExportInstruction(`${format} ${name}=${value}${extra}`, 0);
                assert.ok('instruction' in parsed, `${format} ${name}=${value}: ${'error' in parsed ? parsed.error.message : ''}`);
            }
        }
    }
});

// ===== writing an instruction =====

test('an instruction from the export dialog spells out every option of its format', () => {
    const settings = exportSettingsFor('csv', undefined, { csvSeparator: ';' }, 'SELECT 1');
    assert.equal(
        formatExportInstruction({ format: 'csv', file: 'exports/orders', settings }),
        '-- @export csv file=exports/orders separator=; header=true quote=true lineending=crlf'
    );
    assert.equal(
        formatExportInstruction({ format: 'json', dialog: true, settings: exportSettingsFor('json', undefined, {}, '') }),
        '-- @export json dialog pretty=true array=true'
    );
});

test('every instruction it writes reads back to the same settings', () => {
    const cases: Array<{ settings: ExportSettings; file?: string }> = [
        { settings: { format: 'csv', csvSeparator: '\t', csvIncludeHeaders: false, csvQuoteStrings: true, csvLineEnding: 'lf' }, file: 'my exports/a "b".csv' },
        { settings: { format: 'csv', csvSeparator: ' ', csvIncludeHeaders: true, csvQuoteStrings: false, csvLineEnding: 'crlf' } },
        { settings: { format: 'csv', csvSeparator: "'", csvIncludeHeaders: true, csvQuoteStrings: true, csvLineEnding: 'crlf' } },
        { settings: { format: 'excel', excelSheetName: "O'Brien orders", excelIncludeHeaders: true, excelIncludeSqlSheet: true } },
        { settings: { format: 'json', jsonPretty: false, jsonArrayWrapper: true }, file: 'C:\\out\\{file}_{date}' },
        { settings: { format: 'xml', xmlRootElement: 'orders', xmlRowElement: 'order' } },
        { settings: { format: 'insert', insertTableName: 'archive."Order Lines"', insertBatchSize: 100, insertOnConflict: 'update', insertConflictColumns: ['id', 'tenant id'] } }
    ];
    for (const { settings, file } of cases) {
        const text = formatExportInstruction({ format: settings.format, file, settings });
        const back = readBack(text);
        const { format, ...options } = settings;
        assert.equal(back.format, format, text);
        assert.equal(back.file, file, text);
        assert.deepEqual(back.options, options, text);
    }
});

test('options that are not set are left out', () => {
    assert.equal(
        formatExportInstruction({ format: 'insert', dialog: true, settings: { format: 'insert', insertTableName: '', insertBatchSize: 1, insertOnConflict: 'none', insertConflictColumns: [] } }),
        '-- @export insert dialog batch=1 onconflict=none'
    );
});

test('a folder inside the folder of the SQL file is written relative to it', () => {
    assert.equal(instructionFile('orders', 'C:\\work\\exports\\2026', 'C:\\work', path.win32), 'exports/2026/orders');
    assert.equal(instructionFile('orders', 'C:\\work', 'C:\\work', path.win32), 'orders');
    assert.equal(instructionFile('{file}_{date}', '/srv/sql/out', '/srv/sql', path.posix), 'out/{file}_{date}');
    assert.equal(instructionFile('orders', 'D:\\exports', 'C:\\work', path.win32), 'D:\\exports\\orders');
    assert.equal(instructionFile('orders', '/srv/exports', '/srv/sql', path.posix), '/srv/exports/orders');
    assert.equal(instructionFile('orders', 'C:\\exports', undefined, path.win32), 'C:\\exports\\orders');
    assert.equal(instructionFile('D:\\o.csv', 'C:\\work', 'C:\\work', path.win32), 'D:\\o.csv');
    assert.equal(instructionFile('orders', '', 'C:\\work', path.win32), 'orders');
    assert.equal(instructionFile('  ', 'C:\\work', 'C:\\work', path.win32), undefined, 'no name: asked when the file runs');
});

test('the dialog refuses a choice that the run would refuse', () => {
    const csv = exportSettingsFor('csv', undefined, {}, '');
    assert.equal(instructionChoiceProblem(choice(csv, 'orders', 'C:\\work'), 'C:\\work', VALUES, path.win32), undefined);
    assert.equal(instructionChoiceProblem(choice(csv), 'C:\\work', VALUES, path.win32), undefined, 'without a file the run asks');
    assert.match(instructionChoiceProblem(choice(csv, 'o_{month}', 'C:\\work'), 'C:\\work', VALUES, path.win32) ?? '', /\{month\} is no placeholder/);
    assert.match(instructionChoiceProblem(choice(csv, 'orders', ''), undefined, VALUES, path.win32) ?? '', /not saved yet/);
    assert.equal(instructionChoiceProblem(choice(csv, 'orders', 'C:\\exports'), undefined, VALUES, path.win32), undefined, 'a chosen folder is written in full');
    const insert: ExportSettings = { format: 'insert', insertTableName: '', insertBatchSize: 1, insertOnConflict: 'none' };
    assert.match(instructionChoiceProblem(choice(insert, 'o', 'C:\\work'), 'C:\\work', VALUES, path.win32) ?? '', /needs table=/);
    assert.equal(instructionChoiceProblem(choice(insert, 'o', 'C:\\work', true), 'C:\\work', VALUES, path.win32), undefined, 'dialog asks for the table');
    const update: ExportSettings = { ...insert, insertTableName: 't', insertOnConflict: 'update' };
    assert.match(instructionChoiceProblem(choice(update, 'o', 'C:\\work'), 'C:\\work', VALUES, path.win32) ?? '', /needs conflict=/);
});

test('the instruction of a choice carries dialog, the file and the options', () => {
    const settings = exportSettingsFor('excel', undefined, { excelSheetName: 'Open orders' }, 'SELECT 1');
    assert.equal(
        instructionTextFromChoice(choice(settings, '{file}_{date}', 'C:\\work\\out', true), 'C:\\work', path.win32),
        '-- @export excel dialog file=out/{file}_{date} sheet="Open orders" header=true sqlsheet=false'
    );
});

// ===== finding the query =====

const FILE = [
    "DO $$ BEGIN PERFORM set_config('app.month', '2026-10', false); END $$;", // 0
    '',                                                                       // 1
    '-- open orders',                                                         // 2
    '-- @export csv file=orders separator=;',                                 // 3
    '    SELECT id, total',                                                   // 4
    '    FROM sales.orders',                                                  // 5
    '    -- @export not an instruction inside a statement',                   // 6
    "    WHERE month = current_setting('app.month');",                        // 7
    'SELECT 1; SELECT 2;',                                                    // 8
    '',                                                                       // 9
    '-- @export json pretty=maybe',                                           // 10
    'TABLE customers;',                                                       // 11
    'UPDATE jobs SET done = true;'                                            // 12
].join('\n');
const at = (line: number, column = 0) => FILE.split('\n').slice(0, line).join('\n').length + (line > 0 ? 1 : 0) + column;
const ORDERS_SQL = FILE.slice(FILE.indexOf('SELECT id'), FILE.indexOf("('app.month')") + "('app.month')".length);

test('the cursor in a query, on a line above it or on its instruction means that query', () => {
    for (const offset of [at(4, 10), at(7, 4), at(6, 8), at(1), at(2, 5), at(3, 12)]) {
        const found = target(FILE, offset);
        assert.equal(found.sql, ORDERS_SQL, `offset ${offset}`);
        assert.equal(found.instruction?.line, 3);
        assert.deepEqual(found.parsed?.options, { csvSeparator: ';' });
    }
});

test('the cursor after the semicolon of a query still means it', () => {
    assert.equal(target(FILE, at(7) + "    WHERE month = current_setting('app.month');".length).sql, ORDERS_SQL);
    assert.equal(target(FILE, at(8, 9)).sql, 'SELECT 1', 'after the first of two statements on a line');
    assert.equal(target(FILE, at(8, 12)).sql, 'SELECT 2');
});

test('an instruction that cannot be read is found, but not read', () => {
    const found = target(FILE, at(11, 3));
    assert.equal(found.sql, 'TABLE customers');
    assert.equal(found.instruction?.line, 10);
    assert.equal(found.parsed, undefined);
});

test('a statement that returns no rows, or no statement at all, cannot be exported', () => {
    assert.match((locateExportTarget(FILE, at(12, 3)) as any).error, /returns no rows/);
    assert.match((locateExportTarget(FILE, at(0, 3)) as any).error, /returns no rows/);
    assert.match((locateExportTarget('-- nothing yet\n', 3) as any).error, /Place the cursor in the query to export/);
});

test('after a change the query is found again by its text, or reported as gone', () => {
    const old = target(FILE, at(4, 6));
    const moved = `SELECT 0;\n-- a new comment\n${FILE}`;
    const again = relocateExportTarget(moved, old);
    assert.equal(again?.sql, ORDERS_SQL);
    assert.equal(again?.start, old.start + 'SELECT 0;\n-- a new comment\n'.length);
    assert.equal(relocateExportTarget(FILE.replace('SELECT id, total', 'SELECT id'), old), undefined);
});

// ===== writing it into the file =====

test('a new instruction goes on its own line above the query, with its indentation', () => {
    const text = 'SELECT 0;\r\n\r\n    SELECT * FROM orders;\r\n';
    const found = target(text, text.indexOf('orders'));
    const edit = instructionEdit(text, found, '-- @export csv');
    assert.deepEqual(edit, { start: text.indexOf('    SELECT *'), end: text.indexOf('    SELECT *'), text: '    -- @export csv\r\n', line: 2, column: 4 });
    const written = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    assert.equal(written, 'SELECT 0;\r\n\r\n    -- @export csv\r\n    SELECT * FROM orders;\r\n');
    assert.equal(target(written, written.indexOf('orders')).parsed?.format, 'csv', 'and it belongs to the query');
});

test('an existing instruction is replaced in place', () => {
    const found = target(FILE, at(4, 6));
    const edit = instructionEdit(FILE, found, '-- @export json pretty=false array=true');
    assert.equal(edit.start, at(3));
    assert.equal(edit.end, at(3) + '-- @export csv file=orders separator=;'.length);
    assert.equal(edit.line, 3);
    assert.equal(edit.column, 0);
});

test('a query that starts after another statement on the same line gets the instruction on a line of its own', () => {
    const text = 'SELECT 1; SELECT 2;';
    const edit = instructionEdit(text, target(text, 12), '-- @export csv');
    const written = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    assert.equal(written, 'SELECT 1; \n-- @export csv\nSELECT 2;');
    assert.equal(edit.line, 1);
    assert.equal(target(written, written.indexOf('SELECT 2')).instruction?.line, 1);
});

// ===== what the dialog starts with =====

test('the table the query reads names a new export and its INSERT target', () => {
    assert.equal(queryTable('SELECT * FROM sales.orders o'), 'sales.orders');
    assert.equal(queryTable('SELECT * FROM "Sales" . "Order Lines" WHERE 1 = 1'), '"Sales"."Order Lines"');
    assert.equal(queryTable("SELECT 'from x' AS a, b FROM t"), 't');
    assert.equal(queryTable('VALUES (1)'), undefined);
    const fresh = instructionPrefill(target(FILE, at(11, 3)), 'C:\\work', 'C:\\ws', path.win32);
    assert.equal(fresh.format, 'json', 'the format of an instruction that cannot be read is kept');
    const orders = instructionPrefill({ start: 0, end: 0, sql: 'SELECT * FROM "Sales"."Order Lines"' }, 'C:\\work', 'C:\\ws', path.win32);
    assert.deepEqual(orders, { format: 'csv', fileName: 'Order_Lines', folder: 'C:\\work', options: { insertTableName: '"Sales"."Order Lines"' }, askAtRunTime: false });
    const plain = instructionPrefill({ start: 0, end: 0, sql: 'VALUES (1)' }, undefined, 'C:\\ws', path.win32);
    assert.deepEqual(plain, { format: 'csv', fileName: '{file}', folder: 'C:\\ws', options: {}, askAtRunTime: false });
});

test('an existing instruction prefills the dialog with its format, file and options', () => {
    const text = '-- @export excel dialog file=out/{file}_{date} sheet=Orders\nSELECT 1;';
    assert.deepEqual(instructionPrefill(target(text, text.length - 2), '/srv/sql', '/ws', path.posix), {
        format: 'excel', fileName: '{file}_{date}', folder: '/srv/sql/out', options: { excelSheetName: 'Orders' }, askAtRunTime: true
    });
    const noFile = '-- @export csv separator=tab\nSELECT 1;';
    const prefill = instructionPrefill(target(noFile, noFile.length - 2), '/srv/sql', '/ws', path.posix);
    assert.equal(prefill.fileName, '', 'no file: asked when the file runs, as before');
    assert.equal(prefill.folder, '/srv/sql');
});

// ===== suggestions inside an instruction =====

const labels = (prefix: string, trigger?: string) => exportInstructionCompletions(prefix, trigger)?.items.map((i) => i.label) ?? null;

test('the snippet writes a whole instruction at the start of a line', () => {
    for (const prefix of ['', '    ', '-- @ex', 'exp', '@']) {
        const result = exportInstructionCompletions(prefix);
        assert.deepEqual(result?.items.map((i) => i.kind), ['snippet'], JSON.stringify(prefix));
        assert.equal(result?.from, prefix.length - prefix.trimStart().length);
    }
    assert.equal(EXPORT_SNIPPET, '-- @export ${1|csv,excel,json,xml,insert|} file=${2:{file\\}_{date\\}}');
    assert.deepEqual(labels('-- @', '@'), ['-- @export'], 'typing @ after -- offers it');
    assert.deepEqual(labels('@', '@'), ['-- @export']);
    assert.equal(labels('    ', ' '), null, 'a blank in the code offers nothing');
    assert.equal(labels('SELECT a'), null);
    assert.equal(labels('SELECT a@', '@'), null);
});

test('after @export come the formats and dialog', () => {
    const result = exportInstructionCompletions('-- @export ', ' ');
    assert.deepEqual(result?.items.map((i) => i.label), ['csv', 'excel', 'json', 'xml', 'insert', 'dialog']);
    assert.equal(result?.from, '-- @export '.length);
    assert.equal(result?.items[0].insertText, 'csv ');
    assert.equal(result?.items[0].retrigger, true);
    assert.equal(labels('-- @export'), null, 'not before the blank');
    assert.deepEqual(labels('-- @export dialog ', ' '), ['csv', 'excel', 'json', 'xml', 'insert']);
    assert.equal(exportInstructionCompletions('  --  @EXPORT j')?.from, '  --  @EXPORT '.length);
});

test('after the format come its options, each only once', () => {
    assert.deepEqual(labels('-- @export csv ', ' '), ['dialog', 'file=', 'separator=', 'header=', 'quote=', 'lineending=']);
    assert.deepEqual(labels('-- @export csv dialog separator=; file=x '), ['header=', 'quote=', 'lineending=']);
    assert.deepEqual(labels('-- @export insert table=t '), ['dialog', 'file=', 'batch=', 'onconflict=', 'conflict=']);
    const sep = exportInstructionCompletions('-- @export csv sep');
    assert.equal(sep?.from, '-- @export csv '.length, 'the word typed so far is replaced');
});

test('after an option come the values it takes', () => {
    const ending = exportInstructionCompletions('-- @export csv lineending=', '=');
    assert.deepEqual(ending?.items.map((i) => [i.label, i.detail]), [['crlf', 'Windows (CRLF)'], ['lf', 'Unix (LF)']]);
    assert.equal(ending?.from, '-- @export csv lineending='.length);
    assert.deepEqual(labels('-- @export csv header=t'), ['true', 'false']);
    assert.equal(exportInstructionCompletions('-- @export csv header=t')?.from, '-- @export csv header='.length);
    assert.deepEqual(labels('-- @export insert table=t onconflict='), ['none', 'nothing', 'update']);
    assert.equal(labels('-- @export excel sheet=', '='), null, 'a free text has no values');
    assert.equal(labels('-- @export csv bogus='), null);
    assert.equal(labels('-- @export dialog header='), null, 'without a format the option is unknown');
});

test('file= offers the placeholders, also in the middle of a name', () => {
    const fresh = exportInstructionCompletions('-- @export csv file=', '=');
    assert.deepEqual(fresh?.items.map((i) => i.label), ['{date}', '{time}', '{file}']);
    assert.equal(fresh?.from, '-- @export csv file='.length);
    const open = exportInstructionCompletions('-- @export csv file=out/{file}_{d', '{');
    assert.equal(open?.from, '-- @export csv file=out/{file}_'.length, 'the open placeholder is replaced');
    assert.equal(labels('-- @export csv separator={', '{'), null);
});

test('nothing is suggested inside a quoted value', () => {
    assert.equal(labels('-- @export excel sheet="Open ', ' '), null);
    assert.deepEqual(labels('-- @export excel sheet="Open orders" ', ' '), ['dialog', 'file=', 'header=', 'sqlsheet=']);
});

// ===== explanations =====

test('hovering an instruction explains the word under the mouse', () => {
    const line = '  -- @export csv dialog file=out/{file} separator=; bogus=1';
    const hover = (word: string) => exportInstructionHover(line, line.indexOf(word) + 1);
    const keyword = hover('@export');
    assert.match(keyword?.markdown ?? '', /^\*\*-- @export\*\* — when \*Execute File\* or \*Execute Selection\* runs the query below/);
    assert.deepEqual([keyword?.start, keyword?.end], [line.indexOf('@export'), line.indexOf('@export') + 7]);
    assert.match(hover('csv')?.markdown ?? '', /Comma-separated values[\s\S]*`separator=`[\s\S]*`lineending=`/);
    assert.match(hover('dialog')?.markdown ?? '', /Open the export dialog/);
    assert.match(hover('file=')?.markdown ?? '', /relative to the folder of the SQL file[\s\S]*`\{date\}`/);
    const sep = hover('separator=');
    assert.match(sep?.markdown ?? '', /\*\*separator=\*\* — The character written between two values\.[\s\S]*- `tab` — Tab/);
    assert.deepEqual([sep?.start, sep?.end], [line.indexOf('separator='), line.indexOf('separator=;') + 'separator=;'.length]);
    assert.equal(hover('bogus'), null);
    assert.equal(exportInstructionHover('-- an ordinary comment', 5), null);
});

// ===== checking every instruction =====

test('the problems of a file are those Execute File reports, wrong file names included', () => {
    const text = '-- @export cvs\nSELECT 1;\n-- @export csv file=o_{month}\nSELECT 2;\n-- @export csv\nUPDATE t SET a = 1;';
    const problems = exportInstructionProblems(text, 'C:\\work', 'C:\\work\\payroll.sql');
    assert.deepEqual(problems.map((p) => p.line), [0, 2, 4]);
    assert.match(problems[0].message, /"cvs" is neither a format/);
    assert.match(problems[1].message, /\{month\} is no placeholder/);
    assert.match(problems[2].message, /returns no rows/);
    assert.deepEqual(exportInstructionProblems('SELECT 1;', undefined, 'x.sql'), []);
});

// ===== in VS Code =====

/** A text document of the stub, at `version`, whose text can be changed. */
function fakeDocument(text: string, fileName = path.join(ROOT, 'work', 'payroll.sql')) {
    const doc: any = {
        uri: { toString: () => `file:///${fileName.replace(/\\/g, '/')}` },
        fileName,
        languageId: 'sql',
        isUntitled: false,
        isClosed: false,
        version: 1,
        text,
        getText() { return this.text; },
        offsetAt(p: { line: number; character: number }) {
            const lines = this.text.split('\n');
            return lines.slice(0, p.line).reduce((n: number, l: string) => n + l.length + 1, 0) + p.character;
        },
        positionAt(offset: number) {
            const before = this.text.slice(0, offset).split('\n');
            return new vscodeStub.Position(before.length - 1, before[before.length - 1].length);
        },
        lineAt(line: number) { return { text: this.text.split('\n')[line].replace(/\r$/, '') }; }
    };
    return doc;
}

/** The assist with a fake export dialog that answers with `answer`. */
function createAssist(t: { after(fn: () => void): void }, answer: (request: any) => ExportDialogChoice | undefined) {
    const requests: any[] = [];
    const assist = new ExportInstructionAssist(async (request) => { requests.push(request); return answer(request); }, ['sql']);
    t.after(() => assist.dispose());
    return { assist, requests };
}

/** Record the edits applied, and apply them to `doc`. */
function recordEdits(t: { after(fn: () => void): void }, doc: any) {
    const applied: any[] = [];
    const original = vscodeStub.workspace.applyEdit;
    vscodeStub.workspace.applyEdit = (async (edit: any) => {
        applied.push(...edit.changes);
        for (const change of edit.changes) {
            const start = doc.offsetAt(change.range.start);
            const end = doc.offsetAt(change.range.end);
            doc.text = doc.text.slice(0, start) + change.text + doc.text.slice(end);
            doc.version++;
        }
        return true;
    }) as any;
    t.after(() => { vscodeStub.workspace.applyEdit = original; });
    return applied;
}

/** Make `doc` the document of the active editor, with the cursor at `offset`. */
function activeEditor(t: { after(fn: () => void): void }, doc: any, offset: number) {
    const window = vscodeStub.window as any;
    const editor = { document: doc, viewColumn: 1, selection: { active: doc.positionAt(offset) } };
    const shown = { selection: undefined as any, revealed: [] as any[], revealRange(r: any) { this.revealed.push(r); } };
    const originalShow = window.showTextDocument;
    window.activeTextEditor = editor;
    window.showTextDocument = async () => shown;
    t.after(() => { window.activeTextEditor = undefined; window.showTextDocument = originalShow; });
    return shown;
}

const SCRIPT = "DO $$ BEGIN PERFORM set_config('app.month', '2026-10', false); END $$;\n\n    SELECT * FROM sales.orders;\n";

test('Add Export Instruction writes what the export dialog chose above the query', async (t) => {
    const doc = fakeDocument(SCRIPT);
    const applied = recordEdits(t, doc);
    const shown = activeEditor(t, doc, SCRIPT.indexOf('orders'));
    const settings = exportSettingsFor('csv', undefined, { csvSeparator: ';' }, '');
    const { assist, requests } = createAssist(t, (request) => choice(settings, request.fileName, path.join(path.dirname(doc.fileName), 'exports')));

    await assist.addInstruction();

    const { validate, ...request } = requests[0];
    assert.deepEqual(request, {
        format: 'csv',
        fileName: 'orders',
        folder: path.dirname(doc.fileName),
        options: { insertTableName: 'sales.orders' },
        askAtRunTime: false,
        title: 'Export Instruction: line 3 of payroll.sql',
        sql: 'SELECT * FROM sales.orders',
        purpose: 'instruction',
        submitLabel: 'Insert'
    });
    assert.match(validate(choice({ format: 'insert', insertTableName: '' }, 'o', path.dirname(doc.fileName))), /needs table=/);
    const line = '-- @export csv file=exports/orders separator=; header=true quote=true lineending=crlf';
    assert.equal(applied.length, 1);
    assert.equal(applied[0].text, `    ${line}\n`);
    assert.equal(doc.text, SCRIPT.replace('    SELECT', `    ${line}\n    SELECT`));
    assert.deepEqual([shown.selection.start.line, shown.selection.start.character, shown.selection.end.character], [2, 4, 4 + line.length]);
});

test('Add Export Instruction rewrites the instruction above the query, starting from it', async (t) => {
    const text = '-- @export json dialog file=out/{file}\nSELECT 1 AS n;';
    const doc = fakeDocument(text);
    const applied = recordEdits(t, doc);
    activeEditor(t, doc, text.length - 3);
    const { assist, requests } = createAssist(t, () => choice({ format: 'json', jsonPretty: false, jsonArrayWrapper: true }));

    await assist.addInstruction();

    assert.equal(requests[0].submitLabel, 'Update');
    assert.equal(requests[0].askAtRunTime, true);
    assert.equal(requests[0].fileName, '{file}');
    assert.equal(requests[0].folder, path.join(path.dirname(doc.fileName), 'out'));
    assert.equal(applied[0].text, '-- @export json pretty=false array=true');
    assert.equal(doc.text, '-- @export json pretty=false array=true\nSELECT 1 AS n;');
});

test('a query that moved while the dialog was open gets its instruction where it is now', async (t) => {
    const doc = fakeDocument(SCRIPT);
    recordEdits(t, doc);
    activeEditor(t, doc, SCRIPT.indexOf('orders'));
    const { assist } = createAssist(t, () => {
        doc.text = `-- a comment typed meanwhile\n${doc.text}`;
        doc.version++;
        return choice({ format: 'json', jsonPretty: true, jsonArrayWrapper: true });
    });

    await assist.addInstruction();

    assert.match(doc.text, /^-- a comment typed meanwhile\nDO[\s\S]*\n {4}-- @export json pretty=true array=true\n {4}SELECT \* FROM sales\.orders;/);
});

test('nothing is written when the query is gone, the dialog is cancelled or the cursor is in no query', async (t) => {
    const warnings = stubWarningMessage(t, () => undefined);
    const doc = fakeDocument(SCRIPT);
    const applied = recordEdits(t, doc);
    activeEditor(t, doc, SCRIPT.indexOf('orders'));
    let answer: ExportDialogChoice | undefined = choice({ format: 'json' });
    const { assist, requests } = createAssist(t, () => {
        doc.text = doc.text.replace('sales.orders', 'sales.invoices');
        doc.version++;
        return answer;
    });

    await assist.addInstruction();
    assert.match(String(warnings[0][0]), /The query changed while the export dialog was open/);

    answer = undefined;
    await assist.addInstruction();

    await assist.addInstruction(doc.uri, 3);
    assert.equal(requests.length, 2, 'no dialog for a DO block');
    assert.match(String(warnings[1][0]), /returns no rows/);
    assert.equal(applied.length, 0);
});

test('the light bulb offers the instruction on the first line of a query and on its instruction', () => {
    const doc = fakeDocument(FILE);
    const assist = new ExportInstructionAssist(async () => undefined, ['sql']);
    try {
        const provider = languageRegistrations.codeActions[languageRegistrations.codeActions.length - 1].provider;
        const actions = (line: number, column: number, triggerKind: number, diagnostics: any[] = []) => {
            const position = new vscodeStub.Position(line, column);
            return provider.provideCodeActions(doc, new vscodeStub.Range(position, position), { triggerKind, diagnostics });
        };
        const { Automatic, Invoke } = vscodeStub.CodeActionTriggerKind;
        const first = actions(4, 6, Automatic);
        assert.deepEqual(first.map((a: any) => [a.title, a.kind.value]), [['Edit Export Instruction', 'refactor.rewrite']]);
        assert.deepEqual(first[0].command, { command: ADD_EXPORT_INSTRUCTION_COMMAND, title: 'Edit Export Instruction', arguments: [doc.uri, at(4, 6)] });
        assert.equal(actions(3, 4, Automatic).length, 1, 'on its instruction');
        assert.deepEqual(actions(7, 6, Automatic), [], 'no light bulb further down');
        assert.equal(actions(7, 6, Invoke).length, 1, 'but Ctrl+. offers it there');
        assert.deepEqual(actions(12, 3, Invoke), [], 'not for an UPDATE');
        const diagnostic = { source: DIAGNOSTIC_SOURCE, range: new vscodeStub.Range(10, 0, 10, 28) };
        const broken = actions(10, 3, Automatic, [diagnostic]);
        assert.deepEqual([broken[0].title, broken[0].kind.value, broken[0].isPreferred], ['Rewrite Export Instruction', 'quickfix', true]);
        assert.deepEqual(broken[0].diagnostics, [diagnostic]);
        const fresh = fakeDocument('\nSELECT 1;');
        const freshProvider = provider.provideCodeActions(fresh, new vscodeStub.Range(1, 2, 1, 2), { triggerKind: Automatic, diagnostics: [] });
        assert.equal(freshProvider[0].title, 'Add Export Instruction');
    } finally {
        assist.dispose();
    }
});

test('wrong instructions are marked in the file, and the marks follow its changes', async () => {
    const doc = fakeDocument('-- @export cvs\nSELECT 1;');
    vscodeStub.workspace.textDocuments = [doc];
    const assist = new ExportInstructionAssist(async () => undefined, ['sql']);
    try {
        const collection = languageRegistrations.diagnostics[languageRegistrations.diagnostics.length - 1];
        await new Promise((resolve) => setTimeout(resolve, 20));
        const marks = collection.get(doc.uri);
        assert.equal(marks.length, 1);
        assert.match(marks[0].message, /"cvs" is neither a format/);
        assert.equal(marks[0].source, DIAGNOSTIC_SOURCE);
        assert.equal(marks[0].severity, vscodeStub.DiagnosticSeverity.Error);
        assert.deepEqual([marks[0].range.start.character, marks[0].range.end.character], [0, '-- @export cvs'.length]);

        doc.text = '-- @export csv\nSELECT 1;';
        fireDidChangeTextDocument(doc);
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.deepEqual(collection.get(doc.uri), []);
    } finally {
        vscodeStub.workspace.textDocuments = [];
        assist.dispose();
    }
});

test('the suggestions and explanations reach VS Code with their ranges', () => {
    const assist = new ExportInstructionAssist(async () => undefined, ['sql']);
    try {
        const completion = languageRegistrations.completion[languageRegistrations.completion.length - 1];
        assert.deepEqual(completion.triggers, ['@', ' ', '=', '{']);
        const doc = fakeDocument('-- @export csv lineending=');
        const items = completion.provider.provideCompletionItems(doc, new vscodeStub.Position(0, 26), {}, { triggerKind: vscodeStub.CompletionTriggerKind.TriggerCharacter, triggerCharacter: '=' });
        assert.deepEqual(items.map((i: any) => [i.label, i.insertText, i.range.start.character, i.range.end.character]), [['crlf', 'crlf', 26, 26], ['lf', 'lf', 26, 26]]);
        const snippet = completion.provider.provideCompletionItems(fakeDocument(''), new vscodeStub.Position(0, 0), {}, { triggerKind: vscodeStub.CompletionTriggerKind.Invoke });
        assert.equal(snippet[0].insertText.value, EXPORT_SNIPPET);
        assert.equal(snippet[0].kind, vscodeStub.CompletionItemKind.Snippet);
        const format = completion.provider.provideCompletionItems(fakeDocument('-- @export '), new vscodeStub.Position(0, 11), {}, { triggerKind: vscodeStub.CompletionTriggerKind.TriggerCharacter, triggerCharacter: ' ' });
        assert.deepEqual(format[0].command, { command: 'editor.action.triggerSuggest', title: 'Suggest' });

        const hover = languageRegistrations.hover[languageRegistrations.hover.length - 1].provider
            .provideHover(fakeDocument('-- @export csv'), new vscodeStub.Position(0, 12));
        assert.match(hover.contents.value, /^\*\*csv\*\*/);
        assert.deepEqual([hover.range.start.character, hover.range.end.character], [11, 14]);
    } finally {
        assist.dispose();
    }
});

// ===== the command and the export dialog =====

test('Add Export Instruction is a command of SQL files with its own entry in the context menu', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const command = manifest.contributes.commands.find((c: any) => c.command === ADD_EXPORT_INSTRUCTION_COMMAND);
    assert.deepEqual(command, { command: ADD_EXPORT_INSTRUCTION_COMMAND, title: 'Add Export Instruction', category: 'PostgreSQL Query Booster', icon: '$(export)' });
    assert.ok(manifest.contributes.menus['editor/context'].some((m: any) => m.command === ADD_EXPORT_INSTRUCTION_COMMAND && /resourceLangId == sql/.test(m.when)));
    // It comes last among the entries of SQL files, after Reset Database Session.
    const navigation = manifest.contributes.menus['editor/context']
        .filter((m: any) => String(m.group).startsWith('navigation@'))
        .map((m: any) => ({ command: m.command, order: Number(String(m.group).split('@')[1]) }));
    const own = navigation.find((m: any) => m.command === ADD_EXPORT_INSTRUCTION_COMMAND);
    assert.ok(navigation.every((m: any) => m === own || m.order < own.order), 'Add Export Instruction is not the last entry of its group');
    const extension = fs.readFileSync(path.join(ROOT, 'src', 'extension.ts'), 'utf8');
    assert.ok(extension.includes('registerCommand(ADD_EXPORT_INSTRUCTION_COMMAND'));
    assert.ok(extension.includes('new ExportInstructionAssist('));
});

test('the export dialog writes an instruction with its own button, run-time choice and checks', () => {
    const html = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'tableView.html'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'tableView.css'), 'utf8');
    const js = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'tableView.js'), 'utf8');
    assert.match(html, /<button class="btn btn-primary" id="exportExecute">.*<span id="exportExecuteLabel">Export<\/span><\/button>/);
    assert.match(html, /<div class="export-field-checkbox export-instruction-only">\s*<input type="checkbox" id="exportAskAtRunTime" \/>/);
    assert.match(html, /<div class="export-field export-only-field">\s*<label for="insertConflictColumns">/);
    assert.match(html, /<div class="export-dialog-error" id="exportDialogError" role="alert"><\/div>/);
    assert.match(css, /\.export-dialog \.export-only-field,\s*\.export-dialog \.export-instruction-only,\s*\.export-dialog \.export-instruction-hint \{\s*display: none;/);
    assert.match(css, /body\.export-instruction #exportSaveDefault \{\s*display: none;/);
    assert.match(js, /classList\.toggle\('export-instruction', exportOnly\.purpose === 'instruction'\)/);
    assert.match(js, /getElementById\('exportExecuteLabel'\)\.textContent = exportOnly\.submitLabel \|\| 'Export'/);
    assert.match(js, /opts\.typedFilename = exportFilename\.value\.trim\(\);\s*opts\.askAtRunTime = /);
    assert.match(js, /case 'exportDialogInvalid':\s*\/\/[^\n]*\n\s*document\.getElementById\('exportDialogError'\)\.textContent = String\(msg\.message \|\| ''\)/);
});
