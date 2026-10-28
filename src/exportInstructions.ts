import * as path from 'path';
import type { DbSessionRef } from './dbSession';
import type { ExportOptions, ExportRow } from './exportService';
import type { ExportProgressSink } from './exportProgress';

/** The export formats, as ExportService names them. */
export type ExportFormat = ExportOptions['format'];

/** Export options without the target file, as an instruction or the dialog sets them. */
export type ExportSettings = Omit<ExportOptions, 'filePath'>;

/** Names an instruction may use for a format. */
export const EXPORT_FORMAT_NAMES: Readonly<Record<string, ExportFormat>> = {
    csv: 'csv', excel: 'excel', xlsx: 'excel', json: 'json', xml: 'xml', insert: 'insert', sql: 'insert'
};

export const EXPORT_FILE_EXTENSIONS: Readonly<Record<ExportFormat, string>> = {
    csv: '.csv', excel: '.xlsx', json: '.json', xml: '.xml', insert: '.sql'
};

/**
 * What the export dialog of the Data Viewer shows before any saved default
 * applies. NOTE: mirrors the defaults written in src/webview/tableView.html;
 * src/test/exportInstructions.test.ts keeps them in sync.
 */
export const EXPORT_DIALOG_PRESETS: Readonly<Record<ExportFormat, Partial<ExportSettings>>> = {
    csv: { csvSeparator: ',', csvIncludeHeaders: true, csvQuoteStrings: true, csvLineEnding: 'crlf' },
    json: { jsonPretty: true, jsonArrayWrapper: true },
    xml: { xmlRootElement: 'data', xmlRowElement: 'row' },
    insert: { insertBatchSize: 1, insertOnConflict: 'none' },
    excel: { excelIncludeHeaders: true, excelSheetName: 'Data', excelIncludeSqlSheet: false }
};

/** The saved defaults the export dialog applies — never a table name or key columns of another export. */
const SAVED_DEFAULT_KEYS: Readonly<Record<ExportFormat, ReadonlyArray<keyof ExportSettings>>> = {
    csv: ['csvSeparator', 'csvIncludeHeaders', 'csvQuoteStrings', 'csvLineEnding'],
    json: ['jsonPretty', 'jsonArrayWrapper'],
    xml: ['xmlRootElement', 'xmlRowElement'],
    insert: ['insertBatchSize', 'insertOnConflict'],
    excel: ['excelIncludeHeaders', 'excelSheetName', 'excelIncludeSqlSheet']
};

type OptionKind = 'boolean' | 'separator' | 'lineEnding' | 'xmlName' | 'text' | 'batch' | 'conflictMode' | 'columns' | 'sheetName';

/** The options an instruction may give per format, by the name it uses for them. */
export const EXPORT_INSTRUCTION_OPTIONS: Readonly<Record<ExportFormat, Readonly<Record<string, { key: keyof ExportSettings; kind: OptionKind }>>>> = {
    csv: {
        separator: { key: 'csvSeparator', kind: 'separator' },
        header: { key: 'csvIncludeHeaders', kind: 'boolean' },
        quote: { key: 'csvQuoteStrings', kind: 'boolean' },
        lineending: { key: 'csvLineEnding', kind: 'lineEnding' }
    },
    json: {
        pretty: { key: 'jsonPretty', kind: 'boolean' },
        array: { key: 'jsonArrayWrapper', kind: 'boolean' }
    },
    xml: {
        root: { key: 'xmlRootElement', kind: 'xmlName' },
        row: { key: 'xmlRowElement', kind: 'xmlName' }
    },
    insert: {
        table: { key: 'insertTableName', kind: 'text' },
        batch: { key: 'insertBatchSize', kind: 'batch' },
        onconflict: { key: 'insertOnConflict', kind: 'conflictMode' },
        conflict: { key: 'insertConflictColumns', kind: 'columns' }
    },
    excel: {
        sheet: { key: 'excelSheetName', kind: 'sheetName' },
        header: { key: 'excelIncludeHeaders', kind: 'boolean' },
        sqlsheet: { key: 'excelIncludeSqlSheet', kind: 'boolean' }
    }
};

/** An `-- @export` instruction, telling that the query below it is exported instead of shown. */
export interface ExportInstruction {
    /** 0-based line of the instruction in the document. */
    line: number;
    /** Undefined only when the export dialog chooses it. */
    format: ExportFormat | undefined;
    /** The export dialog of the Data Viewer opens, prefilled from the instruction. */
    dialog: boolean;
    /** The target as written, placeholders not yet filled in. */
    file: string | undefined;
    options: Partial<ExportSettings>;
}

/** A wrong instruction, with its 0-based line. */
export interface InstructionError {
    line: number;
    message: string;
}

const SEPARATOR_NAMES: Readonly<Record<string, string>> = { tab: '\t', '\\t': '\t', comma: ',', semicolon: ';', pipe: '|', space: ' ' };
const BOOLEAN_WORDS: Readonly<Record<string, boolean>> = { true: true, yes: true, on: true, '1': true, false: false, no: false, off: false, '0': false };

/** Split the words of an instruction; a value in double or single quotes may hold blanks. */
function instructionWords(text: string): string[] | { error: string } {
    const words: string[] = [];
    let i = 0;
    while (i < text.length) {
        while (i < text.length && /\s/.test(text[i])) i++;
        if (i >= text.length) break;
        let word = '';
        while (i < text.length && !/\s/.test(text[i])) {
            const ch = text[i];
            if (ch === '"' || ch === "'") {
                let j = i + 1;
                let closed = false;
                while (j < text.length) {
                    if (text[j] === ch) {
                        if (text[j + 1] === ch) { word += ch; j += 2; continue; }
                        closed = true;
                        break;
                    }
                    word += text[j];
                    j++;
                }
                if (!closed) return { error: `The quote ${ch} opened here is never closed.` };
                i = j + 1;
                continue;
            }
            word += ch;
            i++;
        }
        words.push(word);
    }
    return words;
}

/** The value an option takes, or the reason it cannot. */
function optionValue(name: string, kind: OptionKind, raw: string): { value: unknown } | { error: string } {
    switch (kind) {
        case 'boolean': {
            const value = BOOLEAN_WORDS[raw.toLowerCase()];
            return value === undefined ? { error: `${name}=${raw} is neither true nor false.` } : { value };
        }
        case 'separator': {
            const value = SEPARATOR_NAMES[raw.toLowerCase()] ?? raw;
            return value === '' || /["\r\n]/.test(value)
                ? { error: `${name}= needs a separator other than a double quote or a line break, or one of tab, comma, semicolon, pipe, space.` }
                : { value };
        }
        case 'lineEnding': {
            const value = raw.toLowerCase();
            return value === 'crlf' || value === 'lf' ? { value } : { error: `${name}=${raw} is no line ending; use crlf or lf.` };
        }
        case 'xmlName':
            return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(raw) ? { value: raw } : { error: `${name}=${raw} is no valid XML element name.` };
        case 'text':
            return raw.trim() === '' ? { error: `${name}= needs a value.` } : { value: raw.trim() };
        case 'batch': {
            const value = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
            return value >= 1 && value <= 1000 ? { value } : { error: `${name}=${raw} has to be a number of rows from 1 to 1000.` };
        }
        case 'conflictMode': {
            const value = raw.toLowerCase();
            return ['none', 'nothing', 'update'].includes(value) ? { value } : { error: `${name}=${raw} is none of none, nothing and update.` };
        }
        case 'columns': {
            const value = raw.split(',').map((c) => c.trim()).filter((c) => c !== '');
            return value.length > 0 ? { value } : { error: `${name}= needs the key columns, separated by commas.` };
        }
        case 'sheetName':
            return raw.length >= 1 && raw.length <= 31 && !/[[\]:*?/\\]/.test(raw) && !/^'|'$/.test(raw)
                ? { value: raw }
                : { error: `${name}=${raw} is no valid sheet name: 1 to 31 characters, none of [ ] : * ? / \\.` };
    }
}

/**
 * Read the text after `@export`: a format, the word `dialog`, and
 * `key=value` options, in any order.
 */
export function parseExportInstruction(text: string, line: number): { instruction: ExportInstruction } | { error: InstructionError } {
    const fail = (message: string) => ({ error: { line, message } });
    const words = instructionWords(text);
    if (!Array.isArray(words)) return fail(words.error);

    let format: ExportFormat | undefined;
    let dialog = false;
    let file: string | undefined;
    const raw: Array<[string, string]> = [];
    const seen = new Set<string>();
    for (const word of words) {
        const eq = word.indexOf('=');
        if (eq < 0) {
            const lower = word.toLowerCase();
            if (lower === 'dialog') {
                dialog = true;
            } else if (EXPORT_FORMAT_NAMES[lower]) {
                if (format) return fail(`The instruction names two formats, ${format} and ${lower}.`);
                format = EXPORT_FORMAT_NAMES[lower];
            } else {
                return fail(`"${word}" is neither a format (csv, excel, json, xml, insert) nor dialog.`);
            }
            continue;
        }
        const key = word.slice(0, eq).toLowerCase();
        const value = word.slice(eq + 1);
        if (seen.has(key)) return fail(`${key}= is given twice.`);
        seen.add(key);
        if (key === 'file') {
            if (value.trim() === '') return fail('file= needs a file name.');
            file = value.trim();
        } else {
            raw.push([key, value]);
        }
    }

    if (!format && !dialog) {
        return fail('Name the format — csv, excel, json, xml or insert — or add dialog to choose it in the export dialog.');
    }
    const options: Partial<ExportSettings> = {};
    for (const [key, value] of raw) {
        if (!format) return fail(`Name the format before its options: ${key}= depends on it.`);
        const spec = EXPORT_INSTRUCTION_OPTIONS[format][key];
        if (!spec) {
            const known = Object.keys(EXPORT_INSTRUCTION_OPTIONS[format]).join(', ');
            return fail(`${key}= is no option of a ${format} export; it knows file, ${known}.`);
        }
        const parsed = optionValue(key, spec.kind, value);
        if ('error' in parsed) return fail(parsed.error);
        (options as Record<string, unknown>)[spec.key] = parsed.value;
    }
    if (format === 'insert' && !dialog && !options.insertTableName) {
        return fail('An insert export needs table=, the table its INSERT statements write to.');
    }
    if (options.insertOnConflict === 'update' && !options.insertConflictColumns) {
        return fail('onconflict=update needs conflict=, the key columns a conflict is detected on.');
    }
    return { instruction: { line, format, dialog, file, options } };
}

/** 0-based line of `offset` in `text`. */
function lineOf(text: string, offset: number): number {
    let line = 0;
    for (let i = 0; i < offset && i < text.length; i++) {
        if (text[i] === '\n') line++;
    }
    return line;
}

const INSTRUCTION_LINE = /^[ \t]*--[ \t]*@export\b(.*)$/gim;

/** An `-- @export` comment line: where it is and what follows the keyword. */
export interface InstructionLine {
    /** 0-based line. */
    line: number;
    /** Offset of the `--`. */
    start: number;
    /** Offset of the end of the line, before its line break. */
    end: number;
    /** The text after `@export`. */
    body: string;
}

/** The `-- @export` lines in `text` between the offsets `from` and `to`. */
export function findInstructionLines(text: string, from: number, to: number): InstructionLine[] {
    const found: InstructionLine[] = [];
    const gap = text.slice(from, to);
    INSTRUCTION_LINE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INSTRUCTION_LINE.exec(gap)) !== null) {
        const lineStart = from + m.index;
        const start = lineStart + m[0].indexOf('--');
        const body = m[1].replace(/\r$/, '');
        found.push({ line: lineOf(text, lineStart), start, end: lineStart + m[0].replace(/\r$/, '').length, body });
    }
    return found;
}

/** The instructions in `text` between `from` and `to`. */
function instructionsBetween(text: string, from: number, to: number): Array<{ line: number; body: string }> {
    return findInstructionLines(text, from, to).map(({ line, body }) => ({ line, body }));
}

/** A statement to run, with the instruction it carries. */
export interface PlannedStatement {
    start: number;
    end: number;
    instruction?: ExportInstruction;
}

/**
 * Give every statement the `-- @export` instruction on the comment lines above
 * it — between the statement before it (or `firstGapStart`) and itself. Every
 * instruction is checked before anything runs: a wrong one, two above one
 * statement, one above a statement that returns no rows, or one followed by
 * no statement before `trailingEnd` is reported with its line.
 */
export function planExportInstructions(
    text: string,
    ranges: ReadonlyArray<{ start: number; end: number }>,
    returnsRows: (sql: string) => boolean,
    bounds: { firstGapStart?: number; trailingEnd?: number } = {}
): { statements: PlannedStatement[]; errors: InstructionError[] } {
    const errors: InstructionError[] = [];
    const statements = ranges.map((range, index): PlannedStatement => {
        const from = index === 0 ? (bounds.firstGapStart ?? 0) : ranges[index - 1].end;
        const found = instructionsBetween(text, from, range.start);
        if (found.length === 0) return { start: range.start, end: range.end };
        if (found.length > 1) {
            errors.push({ line: found[1].line, message: `Only one @export instruction may stand above a statement; line ${found[0].line + 1} has one already.` });
        }
        const parsed = parseExportInstruction(found[0].body, found[0].line);
        if ('error' in parsed) {
            errors.push(parsed.error);
            return { start: range.start, end: range.end };
        }
        if (!returnsRows(text.slice(range.start, range.end))) {
            errors.push({ line: found[0].line, message: 'It stands above a statement that returns no rows; only a query (SELECT, WITH … SELECT, VALUES, TABLE) can be exported.' });
        }
        return { start: range.start, end: range.end, instruction: parsed.instruction };
    });
    const tailFrom = ranges.length > 0 ? ranges[ranges.length - 1].end : (bounds.firstGapStart ?? 0);
    for (const orphan of instructionsBetween(text, tailFrom, bounds.trailingEnd ?? text.length)) {
        errors.push({ line: orphan.line, message: 'No statement follows it, so there is nothing to export.' });
    }
    errors.sort((a, b) => a.line - b.line);
    return { statements, errors };
}

/** The values of the placeholders of a file name. */
export interface ExportPlaceholders {
    date: string;
    time: string;
    file: string;
}

export function exportPlaceholders(now: Date, documentFileName: string): ExportPlaceholders {
    const pad = (n: number) => String(n).padStart(2, '0');
    return {
        date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
        time: `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
        file: path.basename(documentFileName, path.extname(documentFileName))
    };
}

/**
 * The file an instruction's `file=` names: placeholders filled in, the
 * extension of the format added when the name has none, and a relative path
 * resolved against the folder of the SQL file.
 */
export function resolveExportTarget(
    file: string,
    format: ExportFormat,
    folder: string | undefined,
    values: ExportPlaceholders,
    pathApi: path.PlatformPath = path
): { path: string } | { error: string } {
    let unknown = '';
    const filled = file.replace(/\{(\w+)\}/g, (all, name: string) => {
        const value = (values as unknown as Record<string, string>)[name.toLowerCase()];
        if (value === undefined && !unknown) unknown = all;
        return value ?? all;
    });
    if (unknown) {
        return { error: `${unknown} is no placeholder; file= knows {date}, {time} and {file}.` };
    }
    const named = pathApi.extname(filled) === '' ? filled + EXPORT_FILE_EXTENSIONS[format] : filled;
    if (pathApi.isAbsolute(named)) {
        return { path: pathApi.normalize(named) };
    }
    if (!folder) {
        return { error: 'The SQL file is not saved yet, so a relative file= has no folder. Save the file or give an absolute path.' };
    }
    return { path: pathApi.resolve(folder, named) };
}

/** The name the save dialog suggests for an export without `file=`: `payroll_line12.csv`. */
export function defaultExportFileName(values: ExportPlaceholders, line: number, format: ExportFormat): string {
    return `${values.file}_line${line + 1}${EXPORT_FILE_EXTENSIONS[format]}`;
}

/**
 * A `file=` that cannot name a file — an unknown placeholder, a relative path
 * in a SQL file that was never saved — reported before anything runs.
 */
export function exportTargetErrors(
    statements: ReadonlyArray<PlannedStatement>,
    folder: string | undefined,
    values: ExportPlaceholders
): InstructionError[] {
    const errors: InstructionError[] = [];
    for (const { instruction } of statements) {
        if (!instruction?.file) continue;
        const resolved = resolveExportTarget(instruction.file, instruction.format ?? 'csv', folder, values);
        if ('error' in resolved) {
            errors.push({ line: instruction.line, message: resolved.error });
        }
    }
    return errors.sort((a, b) => a.line - b.line);
}

/**
 * The settings of an export: what the export dialog presets, the saved
 * defaults it would apply on top, and what the instruction names. An Excel
 * file gets the query for its optional SQL sheet.
 */
export function exportSettingsFor(
    format: ExportFormat,
    saved: Partial<ExportSettings> | undefined,
    instructionOptions: Partial<ExportSettings>,
    sql: string
): ExportSettings {
    const fromSaved: Partial<ExportSettings> = {};
    for (const key of SAVED_DEFAULT_KEYS[format]) {
        const value = saved?.[key];
        if (value !== undefined && value !== null && value !== '') {
            (fromSaved as Record<string, unknown>)[key] = value;
        }
    }
    const settings: ExportSettings = { format, ...EXPORT_DIALOG_PRESETS[format], ...fromSaved, ...instructionOptions };
    if (format === 'excel') {
        settings.excelSqlStatement = sql;
    }
    return settings;
}

/** One line for the messages output telling what was exported where. */
export function formatExportMessage(label: string, line: number, rows: number, filePath: string, now: Date = new Date()): string {
    const time = now.toTimeString().slice(0, 8);
    return `[${time}] ${label} — EXPORT: line ${line + 1}, ${rows} ${rows === 1 ? 'row' : 'rows'} to ${filePath}`;
}

/** What the Export tab is opened with. */
export interface ExportDialogRequest {
    title: string;
    format: ExportFormat;
    fileName: string;
    folder: string;
    options: Partial<ExportSettings>;
    sql: string;
    sessionRef?: DbSessionRef;
    /**
     * `export` (default) when a running file asks for the settings of an
     * export; `instruction` when the dialog writes an `-- @export` line.
     */
    purpose?: 'export' | 'instruction';
    /** The label of the dialog's main button. */
    submitLabel?: string;
    /** For an instruction: whether "Open this dialog when the file runs" starts ticked. */
    askAtRunTime?: boolean;
    /** Why a choice cannot be taken, shown in the dialog, which stays open; undefined to accept it. */
    validate?: (choice: ExportDialogChoice) => string | undefined;
}

/** What the user chose in the Export tab. */
export interface ExportDialogChoice {
    settings: ExportSettings;
    fileName: string;
    folder: string;
    /** The file name exactly as typed, '' when the field was left empty. */
    typedFileName: string;
    /** "Open this dialog when the file runs" of an instruction. */
    askAtRunTime: boolean;
}

/** Every option key a format may carry, for checking what the webview sends. */
const SETTING_TYPES: Readonly<Record<keyof ExportSettings, 'string' | 'boolean' | 'number' | 'strings'>> = {
    format: 'string',
    csvSeparator: 'string', csvQuoteStrings: 'boolean', csvIncludeHeaders: 'boolean', csvLineEnding: 'string',
    insertTableName: 'string', insertBatchSize: 'number', insertOnConflict: 'string', insertConflictColumns: 'strings',
    jsonPretty: 'boolean', jsonArrayWrapper: 'boolean',
    xmlRootElement: 'string', xmlRowElement: 'string',
    excelIncludeHeaders: 'boolean', excelSheetName: 'string', excelIncludeSqlSheet: 'boolean', excelSqlStatement: 'string'
};

/** The choice the Export tab posted, checked; undefined for a cancelled dialog or a malformed message. */
export function exportDialogChoiceFrom(raw: unknown): ExportDialogChoice | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const message = raw as Record<string, unknown>;
    const format = typeof message.format === 'string' ? EXPORT_FORMAT_NAMES[message.format] : undefined;
    if (!format || message.format !== format) return undefined;
    const settings: ExportSettings = { format };
    for (const [key, type] of Object.entries(SETTING_TYPES)) {
        const value = message[key];
        if (key === 'format' || value === undefined) continue;
        const ok = type === 'strings'
            ? Array.isArray(value) && value.every((v) => typeof v === 'string')
            : typeof value === type;
        if (ok) (settings as unknown as Record<string, unknown>)[key] = value;
    }
    if (settings.csvLineEnding !== undefined && settings.csvLineEnding !== 'crlf' && settings.csvLineEnding !== 'lf') {
        delete settings.csvLineEnding;
    }
    if (settings.insertOnConflict !== undefined && !['none', 'nothing', 'update'].includes(settings.insertOnConflict)) {
        delete settings.insertOnConflict;
    }
    const fileName = typeof message.filename === 'string' && message.filename.trim() !== ''
        ? path.basename(message.filename.trim())
        : `export${EXPORT_FILE_EXTENSIONS[format]}`;
    const folder = typeof message.saveLocation === 'string' ? message.saveLocation.trim() : '';
    const typedFileName = typeof message.typedFilename === 'string' ? message.typedFilename.trim() : '';
    return { settings, fileName, folder, typedFileName, askAtRunTime: message.askAtRunTime === true };
}

/**
 * Why the settings of an export cannot be used as they are, or undefined:
 * INSERT statements need the table they write to.
 */
export function exportChoiceProblem(choice: ExportDialogChoice): string | undefined {
    if (choice.settings.format === 'insert' && !(choice.settings.insertTableName ?? '').trim()) {
        return 'Enter the table the INSERT statements write to.';
    }
    if (choice.settings.format === 'insert' && choice.settings.insertOnConflict === 'update'
        && !(choice.settings.insertConflictColumns ?? []).length) {
        return 'ON CONFLICT … DO UPDATE needs the key columns a conflict is detected on.';
    }
    return undefined;
}

/** What running an export needs from the rest of the extension. */
export interface QueryExporter {
    /** The defaults saved in the export dialog for `format`, if any. */
    savedDefaults(format: ExportFormat): Partial<ExportSettings> | undefined;
    /** Open the Export tab; undefined when it was cancelled or closed. */
    chooseSettings(request: ExportDialogRequest): Promise<ExportDialogChoice | undefined>;
    write(rows: ExportRow[], columns: Array<{ name: string; dataType: string }>, options: ExportOptions, progress?: ExportProgressSink): Promise<void>;
}
