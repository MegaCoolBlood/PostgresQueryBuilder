import * as vscode from 'vscode';
import * as path from 'path';
import {
    EXPORT_FORMAT_NAMES,
    EXPORT_INSTRUCTION_OPTIONS,
    exportPlaceholders,
    exportTargetErrors,
    findInstructionLines,
    parseExportInstruction,
    planExportInstructions,
    resolveExportTarget,
    type ExportDialogChoice,
    type ExportDialogRequest,
    type ExportFormat,
    type ExportInstruction,
    type ExportPlaceholders,
    type ExportSettings,
    type InstructionError,
    type InstructionLine
} from './exportInstructions';
import { codeMask, isResultQuery, statementRanges } from './sqlFileSession';
import { getErrorMessage, Logger } from './logger';

/** The formats in the order they are offered. */
export const EXPORT_FORMATS: ReadonlyArray<ExportFormat> = ['csv', 'excel', 'json', 'xml', 'insert'];

export const EXPORT_FORMAT_DOCS: Readonly<Record<ExportFormat, string>> = {
    csv: 'Comma-separated values: separator, header line, quoting and line endings can be set.',
    excel: 'An Excel workbook (.xlsx) with the rows on one sheet and, optionally, the query on a second one.',
    json: 'A JSON array with one object per row.',
    xml: 'An XML document with one element per row.',
    insert: 'INSERT statements that write the rows into a table.'
};

/** What an option means and, where the choice is closed, the values it takes. */
export interface OptionDoc {
    description: string;
    values?: ReadonlyArray<{ value: string; description: string }>;
}

const BOOLEAN_VALUES = [
    { value: 'true', description: 'Yes' },
    { value: 'false', description: 'No' }
];

/** Every option of every format; a test keeps it in step with EXPORT_INSTRUCTION_OPTIONS. */
export const EXPORT_OPTION_DOCS: Readonly<Record<ExportFormat, Readonly<Record<string, OptionDoc>>>> = {
    csv: {
        separator: {
            description: 'The character written between two values.',
            values: [
                { value: ',', description: 'Comma' },
                { value: ';', description: 'Semicolon' },
                { value: 'tab', description: 'Tab' },
                { value: '|', description: 'Pipe' },
                { value: 'space', description: 'Space' }
            ]
        },
        header: { description: 'Write the column names as the first line.', values: BOOLEAN_VALUES },
        quote: { description: 'Put a value that holds the separator, a double quote or a line break in double quotes.', values: BOOLEAN_VALUES },
        lineending: {
            description: 'How each line ends.',
            values: [
                { value: 'crlf', description: 'Windows (CRLF)' },
                { value: 'lf', description: 'Unix (LF)' }
            ]
        }
    },
    json: {
        pretty: { description: 'Indent the JSON so it can be read.', values: BOOLEAN_VALUES },
        array: { description: 'Wrap the rows in an array.', values: BOOLEAN_VALUES }
    },
    xml: {
        root: { description: 'The name of the root element.' },
        row: { description: 'The name of the element written for each row.' }
    },
    insert: {
        table: { description: 'The table the INSERT statements write to, such as `archive.orders`. Required unless `dialog` asks for it when the file runs.' },
        batch: {
            description: 'How many rows one INSERT statement writes, from 1 to 1000.',
            values: [
                { value: '1', description: 'One statement per row' },
                { value: '100', description: '100 rows per statement' },
                { value: '1000', description: '1000 rows per statement' }
            ]
        },
        onconflict: {
            description: 'What an INSERT does when the row exists already.',
            values: [
                { value: 'none', description: 'No ON CONFLICT clause' },
                { value: 'nothing', description: 'ON CONFLICT DO NOTHING' },
                { value: 'update', description: 'ON CONFLICT … DO UPDATE of every column outside the key; needs conflict=' }
            ]
        },
        conflict: { description: 'The key columns a conflict is detected on, separated by commas, such as `id,tenant_id`.' }
    },
    excel: {
        sheet: { description: 'The name of the sheet with the rows, up to 31 characters.' },
        header: { description: 'Write the column names as the first row.', values: BOOLEAN_VALUES },
        sqlsheet: { description: 'Add a second sheet that holds the query.', values: BOOLEAN_VALUES }
    }
};

export const FILE_OPTION_DOC = 'The file the result is written to. A relative path is relative to the folder of the SQL file, '
    + 'missing folders are created, and the extension of the format is added to a name without one. '
    + '`{date}`, `{time}` and `{file}` are filled in. Without `file=` a save dialog asks each time the file runs.';

export const DIALOG_DOC = 'Open the export dialog of the Data Viewer when the file runs — prefilled from this instruction and showing '
    + 'the query — to choose format, file and options then.';

export const PLACEHOLDER_DOCS: Readonly<Record<keyof ExportPlaceholders, string>> = {
    date: 'The day the export runs, such as 2026-10-28.',
    time: 'The time the export runs, such as 135959.',
    file: 'The name of the SQL file without its extension.'
};

/** A value as an instruction writes it: in double quotes when it holds a blank or a quote. */
export function instructionValue(value: string): string {
    return value === '' || /[\s"']/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const SEPARATOR_WORDS: Readonly<Record<string, string>> = { '\t': 'tab', ' ': 'space' };

/** One option value as text, or undefined when the option is not set. */
function optionText(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
    if (Array.isArray(value)) {
        const items = value.map((v) => String(v).trim()).filter((v) => v !== '');
        return items.length > 0 ? instructionValue(items.join(',')) : undefined;
    }
    const text = String(value);
    if (text === '') return undefined;
    return SEPARATOR_WORDS[text] ?? instructionValue(text);
}

/**
 * The `-- @export` line for an export: the format, `dialog` when asked for,
 * `file=` when there is a file, and every option of the format that is set,
 * in the order the export dialog shows them.
 */
export function formatExportInstruction(spec: {
    format: ExportFormat;
    dialog?: boolean;
    file?: string;
    settings: Partial<ExportSettings>;
}): string {
    const words = ['--', '@export', spec.format];
    if (spec.dialog) words.push('dialog');
    if (spec.file) words.push(`file=${instructionValue(spec.file)}`);
    for (const [name, option] of Object.entries(EXPORT_INSTRUCTION_OPTIONS[spec.format])) {
        const text = optionText(spec.settings[option.key]);
        if (text !== undefined) words.push(`${name}=${text}`);
    }
    return words.join(' ');
}

/**
 * The `file=` of the file name and folder chosen in the export dialog: a
 * folder inside the folder of the SQL file is written relative to it, with
 * forward slashes, any other one in full. An empty name means no `file=`.
 */
export function instructionFile(
    typedName: string,
    folder: string,
    documentFolder: string | undefined,
    pathApi: path.PlatformPath = path
): string | undefined {
    const name = typedName.trim();
    if (name === '') return undefined;
    if (pathApi.isAbsolute(name) || folder.trim() === '') return name;
    const dir = folder.trim();
    if (documentFolder) {
        const relative = pathApi.relative(documentFolder, dir);
        if (relative === '') return name;
        if (!relative.startsWith('..') && !pathApi.isAbsolute(relative)) {
            return `${relative.split(pathApi.sep).join('/')}/${name}`;
        }
    }
    return pathApi.join(dir, name);
}

/** The instruction line the export dialog's choice stands for. */
export function instructionTextFromChoice(choice: ExportDialogChoice, documentFolder: string | undefined, pathApi: path.PlatformPath = path): string {
    return formatExportInstruction({
        format: choice.settings.format,
        dialog: choice.askAtRunTime,
        file: instructionFile(choice.typedFileName, choice.folder, documentFolder, pathApi),
        settings: choice.settings
    });
}

/** Why the instruction a choice stands for would be refused when the file runs, or undefined. */
export function instructionChoiceProblem(
    choice: ExportDialogChoice,
    documentFolder: string | undefined,
    values: ExportPlaceholders,
    pathApi: path.PlatformPath = path
): string | undefined {
    const text = instructionTextFromChoice(choice, documentFolder, pathApi);
    const parsed = parseExportInstruction(text.replace(/^--\s*@export/, ''), 0);
    if ('error' in parsed) {
        return parsed.error.message;
    }
    const { file, format } = parsed.instruction;
    if (file && format) {
        const resolved = resolveExportTarget(file, format, documentFolder, values, pathApi);
        if ('error' in resolved) return resolved.error;
    }
    return undefined;
}

/** The query an instruction belongs to, and the instruction above it if there is one. */
export interface ExportTarget {
    start: number;
    end: number;
    sql: string;
    instruction?: InstructionLine;
    /** The instruction above, read; undefined when there is none or it cannot be read. */
    parsed?: ExportInstruction;
}

const nonNull = (range: { start: number; end: number } | null): range is { start: number; end: number } => range !== null;

/**
 * The query the cursor at `offset` means: the statement it is in, or — on an
 * `-- @export` line, a blank line or a comment above a statement — the
 * statement below. Only a query returning rows can be exported.
 */
export function locateExportTarget(text: string, offset: number): ExportTarget | { error: string } {
    const ranges = statementRanges(text).filter(nonNull);
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    const nextBreak = text.indexOf('\n', offset);
    const lineEnd = nextBreak < 0 ? text.length : nextBreak;

    let index = ranges.findIndex((r) => r.start <= offset && offset <= r.end);
    if (index < 0) {
        // After a statement on its own line, the cursor still means it.
        index = ranges.findIndex((r) => r.end >= lineStart && r.end <= offset && r.start <= lineEnd);
    }
    if (index < 0) {
        index = ranges.findIndex((r) => r.start >= offset);
    }
    if (index < 0) {
        return { error: 'Place the cursor in the query to export, or on the line above it.' };
    }
    const range = ranges[index];
    const sql = text.slice(range.start, range.end);
    if (!isResultQuery(sql)) {
        return { error: 'The statement at the cursor returns no rows. Only a query (SELECT, WITH … SELECT, VALUES or TABLE) can be exported.' };
    }
    const gapStart = index === 0 ? 0 : ranges[index - 1].end;
    const instruction = findInstructionLines(text, gapStart, range.start)[0];
    const target: ExportTarget = { start: range.start, end: range.end, sql, instruction };
    if (instruction) {
        const parsed = parseExportInstruction(instruction.body, instruction.line);
        if ('instruction' in parsed) target.parsed = parsed.instruction;
    }
    return target;
}

/**
 * The same query in `text` after the document changed: the statement with the
 * same SQL nearest to where it was. Undefined when it is gone.
 */
export function relocateExportTarget(text: string, previous: ExportTarget): ExportTarget | undefined {
    const candidates = statementRanges(text)
        .filter(nonNull)
        .filter((r) => text.slice(r.start, r.end) === previous.sql)
        .sort((a, b) => Math.abs(a.start - previous.start) - Math.abs(b.start - previous.start));
    if (candidates.length === 0) return undefined;
    const located = locateExportTarget(text, candidates[0].start);
    return 'error' in located ? undefined : located;
}

/**
 * The text change that writes `lineText` for the query: it replaces the
 * instruction above it, or goes on a new line right above the query with the
 * indentation of the query. `line` is where the instruction ends up.
 */
export function instructionEdit(text: string, target: ExportTarget, lineText: string): { start: number; end: number; text: string; line: number; column: number } {
    if (target.instruction) {
        const lineStart = text.lastIndexOf('\n', target.instruction.start - 1) + 1;
        return {
            start: target.instruction.start,
            end: target.instruction.end,
            text: lineText,
            line: target.instruction.line,
            column: target.instruction.start - lineStart
        };
    }
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lineStart = text.lastIndexOf('\n', target.start - 1) + 1;
    const before = text.slice(lineStart, target.start);
    const line = text.slice(0, lineStart).split('\n').length - 1;
    if (/^[ \t]*$/.test(before)) {
        return { start: lineStart, end: lineStart, text: `${before}${lineText}${eol}`, line, column: before.length };
    }
    // Another statement ends on the line the query starts on.
    return { start: target.start, end: target.start, text: `${eol}${lineText}${eol}`, line: line + 1, column: 0 };
}

const NAME_PART = String.raw`[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*`;

/** The table the query reads from first, as written (`sales.orders`), or undefined. */
export function queryTable(sql: string): string | undefined {
    // The mask turns a quoted name, quotes included, into underscores, so it
    // reads as one plain name while its offsets still point into `sql`.
    const masked = codeMask(sql);
    const m = new RegExp(String.raw`\bfrom\s+(${NAME_PART}(?:\s*\.\s*${NAME_PART})?)`, 'i').exec(masked);
    if (!m) return undefined;
    const start = m.index + m[0].length - m[1].length;
    const original = sql.slice(start, m.index + m[0].length);
    // Only the blanks around the dot go; those inside a quoted name stay.
    const dot = /\s*\.\s*/.exec(m[1]);
    return dot ? `${original.slice(0, dot.index)}.${original.slice(dot.index + dot[0].length)}` : original;
}

/** What the export dialog of an instruction starts with. */
export function instructionPrefill(
    target: ExportTarget,
    documentFolder: string | undefined,
    fallbackFolder: string,
    pathApi: path.PlatformPath = path
): { format: ExportFormat; fileName: string; folder: string; options: Partial<ExportSettings>; askAtRunTime: boolean } {
    const folder = documentFolder ?? fallbackFolder;
    const parsed = target.parsed;
    if (parsed) {
        let fileName = '';
        let fileFolder = folder;
        if (parsed.file) {
            const file = parsed.file.replace(/\\/g, pathApi.sep === '\\' ? '\\' : '/');
            fileName = pathApi.basename(file);
            const dir = pathApi.dirname(file);
            if (dir !== '.') fileFolder = pathApi.isAbsolute(dir) ? dir : pathApi.resolve(folder, dir);
        }
        return { format: parsed.format ?? 'csv', fileName, folder: fileFolder, options: parsed.options, askAtRunTime: parsed.dialog };
    }
    // A new instruction, or one that cannot be read: start from what it seems to want.
    const firstWord = (target.instruction?.body.trim().split(/\s+/)[0] ?? '').toLowerCase();
    const table = queryTable(target.sql);
    const base = table ? table.split('.').pop()!.replace(/"/g, '').replace(/[^\w.-]+/g, '_') : '';
    return {
        format: EXPORT_FORMAT_NAMES[firstWord] ?? 'csv',
        fileName: base || '{file}',
        folder,
        options: table ? { insertTableName: table } : {},
        askAtRunTime: false
    };
}

/** Every wrong instruction of a SQL file, as Execute File would report it. */
export function exportInstructionProblems(text: string, documentFolder: string | undefined, documentFileName: string, now: Date = new Date()): InstructionError[] {
    if (!/@export/i.test(text)) return [];
    const plan = planExportInstructions(text, statementRanges(text).filter(nonNull), isResultQuery);
    return [...plan.errors, ...exportTargetErrors(plan.statements, documentFolder, exportPlaceholders(now, documentFileName))]
        .sort((a, b) => a.line - b.line);
}

// ===== autocomplete and hover inside an -- @export line =====

/** A suggestion inside an `-- @export` line. */
export interface AssistCompletion {
    label: string;
    insertText: string;
    kind: 'keyword' | 'format' | 'option' | 'value' | 'placeholder' | 'snippet';
    detail?: string;
    documentation?: string;
    /** Open the suggestions again after inserting, for the value of an option. */
    retrigger?: boolean;
    /** `insertText` is snippet syntax with tab stops. */
    snippet?: boolean;
    sortText?: string;
}

/** The words of an instruction with where each starts; an open quote keeps the rest in one word. */
function instructionTokens(rest: string, offset: number): Array<{ text: string; start: number; end: number; open: boolean }> {
    const tokens: Array<{ text: string; start: number; end: number; open: boolean }> = [];
    let i = 0;
    while (i < rest.length) {
        while (i < rest.length && /\s/.test(rest[i])) i++;
        if (i >= rest.length) break;
        const start = i;
        let quote = '';
        while (i < rest.length && (quote !== '' || !/\s/.test(rest[i]))) {
            const ch = rest[i];
            if (quote === '' && (ch === '"' || ch === "'")) {
                quote = ch;
            } else if (ch === quote) {
                // A doubled quote stands for the quote itself.
                if (rest[i + 1] === quote) {
                    i++;
                } else {
                    quote = '';
                }
            }
            i++;
        }
        tokens.push({ text: rest.slice(start, i), start: offset + start, end: offset + i, open: quote !== '' });
    }
    return tokens;
}

const INSTRUCTION_START = /^(\s*--\s*)(@export)\b/i;

/** The snippet that writes a whole instruction, with the format and the file to fill in. */
export const EXPORT_SNIPPET = '-- @export ${1|csv,excel,json,xml,insert|} file=${2:{file\\}_{date\\}}';

/**
 * The suggestions for the text before the cursor on a line. `trigger` is the
 * character that opened them, if one did: a blank, `=` or `{` only inside an
 * `-- @export` line, `@` only after `--`. Columns count from the line start.
 */
export function exportInstructionCompletions(linePrefix: string, trigger?: string): { from: number; items: AssistCompletion[] } | null {
    const start = INSTRUCTION_START.exec(linePrefix);
    if (!start) {
        if (trigger !== undefined && trigger !== '@') return null;
        const begun = /^(\s*)(--?\s*@?[A-Za-z]*|@?[A-Za-z]*)$/.exec(linePrefix);
        if (!begun || (trigger === '@' && !/^(--\s*)?@$/.test(begun[2]))) return null;
        const snippet: AssistCompletion = {
            label: '-- @export',
            insertText: EXPORT_SNIPPET,
            snippet: true,
            kind: 'snippet',
            detail: 'Export the query below instead of showing it',
            documentation: 'Run through *Execute File* or *Execute Selection*, the query below this line is written to a file '
                + 'instead of being shown in the Data Viewer. Use **Add Export Instruction** to choose everything in the export dialog.'
        };
        return { from: begun[1].length, items: [snippet] };
    }

    const restStart = start[0].length;
    const rest = linePrefix.slice(restStart);
    if (rest === '' || !/^\s/.test(rest)) return null;
    const tokens = instructionTokens(rest, restStart);
    // Inside a quoted value nothing is suggested.
    if (tokens.length > 0 && tokens[tokens.length - 1].open) return null;
    const endsInBlank = /\s$/.test(rest);
    const current = endsInBlank || tokens.length === 0 ? { text: '', start: linePrefix.length, end: linePrefix.length } : tokens[tokens.length - 1];
    const done = endsInBlank ? tokens : tokens.slice(0, -1);

    let format: ExportFormat | undefined;
    let dialog = false;
    const used = new Set<string>();
    for (const token of done) {
        const eq = token.text.indexOf('=');
        if (eq >= 0) {
            used.add(token.text.slice(0, eq).toLowerCase());
        } else if (token.text.toLowerCase() === 'dialog') {
            dialog = true;
        } else if (EXPORT_FORMAT_NAMES[token.text.toLowerCase()]) {
            format = EXPORT_FORMAT_NAMES[token.text.toLowerCase()];
        }
    }

    const eq = current.text.indexOf('=');
    if (eq >= 0) {
        if (trigger === ' ') return null;
        const key = current.text.slice(0, eq).toLowerCase();
        const valueStart = current.start + eq + 1;
        const value = current.text.slice(eq + 1);
        if (key === 'file') {
            const open = value.lastIndexOf('{');
            const from = open > value.lastIndexOf('}') ? valueStart + open : linePrefix.length;
            const items = (Object.keys(PLACEHOLDER_DOCS) as Array<keyof ExportPlaceholders>).map((name, i): AssistCompletion => ({
                label: `{${name}}`, insertText: `{${name}}`, kind: 'placeholder', detail: PLACEHOLDER_DOCS[name], sortText: String(i)
            }));
            return { from, items };
        }
        const doc = format ? EXPORT_OPTION_DOCS[format][key] : undefined;
        if (!doc?.values || trigger === '{') return null;
        return {
            from: valueStart,
            items: doc.values.map((v, i): AssistCompletion => ({
                label: v.value, insertText: v.value, kind: 'value', detail: v.description, sortText: String(i)
            }))
        };
    }
    if (trigger === '=' || trigger === '{') return null;

    const items: AssistCompletion[] = [];
    if (!format) {
        EXPORT_FORMATS.forEach((name, i) => items.push({
            label: name, insertText: `${name} `, kind: 'format', detail: EXPORT_FORMAT_DOCS[name], retrigger: true, sortText: `0${i}`
        }));
    }
    if (!dialog) {
        items.push({ label: 'dialog', insertText: format ? 'dialog ' : 'dialog', kind: 'keyword', detail: 'Ask in the export dialog when the file runs', documentation: DIALOG_DOC, retrigger: !!format, sortText: '1' });
    }
    if (format) {
        if (!used.has('file')) {
            items.push({ label: 'file=', insertText: 'file=', kind: 'option', detail: 'The file to write', documentation: FILE_OPTION_DOC, retrigger: true, sortText: '2' });
        }
        Object.entries(EXPORT_OPTION_DOCS[format]).forEach(([name, doc], i) => {
            if (used.has(name)) return;
            items.push({ label: `${name}=`, insertText: `${name}=`, kind: 'option', detail: doc.description, retrigger: !!doc.values, sortText: `3${i}` });
        });
    }
    return { from: current.start, items };
}

/** Markdown that explains the instruction as a whole. */
function overviewMarkdown(): string {
    return [
        '**-- @export** — when *Execute File* or *Execute Selection* runs the query below this line, its result is written to a file instead of being shown in the Data Viewer.',
        '',
        '`-- @export <format> [dialog] [file=…] [option=value …]`',
        '',
        `Formats: ${EXPORT_FORMATS.map((f) => `\`${f}\``).join(', ')}. A value with blanks goes in double quotes.`,
        '',
        'Every instruction is checked before the first statement runs. **Add Export Instruction** writes one from the export dialog.'
    ].join('\n');
}

function optionListMarkdown(format: ExportFormat): string {
    return [`- \`file=\` — ${FILE_OPTION_DOC}`]
        .concat(Object.entries(EXPORT_OPTION_DOCS[format]).map(([name, doc]) => `- \`${name}=\` — ${doc.description}`))
        .join('\n');
}

function optionMarkdown(name: string, doc: OptionDoc): string {
    const values = doc.values ? `\n\n${doc.values.map((v) => `- \`${v.value}\` — ${v.description}`).join('\n')}` : '';
    return `**${name}=** — ${doc.description}${values}`;
}

/** The explanation for the word at `column` of an `-- @export` line, with its range on the line. */
export function exportInstructionHover(lineText: string, column: number): { markdown: string; start: number; end: number } | null {
    const start = INSTRUCTION_START.exec(lineText);
    if (!start) return null;
    const keywordStart = start[1].length;
    const keywordEnd = start[0].length;
    if (column >= keywordStart && column <= keywordEnd) {
        return { markdown: overviewMarkdown(), start: keywordStart, end: keywordEnd };
    }
    const tokens = instructionTokens(lineText.slice(keywordEnd), keywordEnd);
    const format = tokens.map((t) => EXPORT_FORMAT_NAMES[t.text.toLowerCase()]).find((f) => f !== undefined);
    const token = tokens.find((t) => column >= t.start && column <= t.end);
    if (!token) return null;
    const range = { start: token.start, end: token.end };
    const word = token.text.toLowerCase();
    const eq = word.indexOf('=');
    if (eq < 0) {
        const named = EXPORT_FORMAT_NAMES[word];
        if (named) {
            return { markdown: `**${word}** — ${EXPORT_FORMAT_DOCS[named]}\n\n${optionListMarkdown(named)}`, ...range };
        }
        return word === 'dialog' ? { markdown: `**dialog** — ${DIALOG_DOC}`, ...range } : null;
    }
    const key = word.slice(0, eq);
    if (key === 'file') {
        const placeholders = (Object.keys(PLACEHOLDER_DOCS) as Array<keyof ExportPlaceholders>)
            .map((name) => `- \`{${name}}\` — ${PLACEHOLDER_DOCS[name]}`).join('\n');
        return { markdown: `**file=** — ${FILE_OPTION_DOC}\n\n${placeholders}`, ...range };
    }
    const doc = format ? EXPORT_OPTION_DOCS[format][key] : undefined;
    return doc ? { markdown: optionMarkdown(key, doc), ...range } : null;
}

// ===== VS Code =====

export const ADD_EXPORT_INSTRUCTION_COMMAND = 'postgresQueryBuilder.addExportInstruction';

/** The source the diagnostics of wrong instructions carry. */
export const DIAGNOSTIC_SOURCE = '@export';

const COMPLETION_KINDS: Readonly<Record<AssistCompletion['kind'], vscode.CompletionItemKind>> = {
    keyword: vscode.CompletionItemKind.Keyword,
    format: vscode.CompletionItemKind.EnumMember,
    option: vscode.CompletionItemKind.Property,
    value: vscode.CompletionItemKind.Value,
    placeholder: vscode.CompletionItemKind.Variable,
    snippet: vscode.CompletionItemKind.Snippet
};

/**
 * Helps writing `-- @export` instructions in SQL files: the command and code
 * action **Add Export Instruction**, suggestions and explanations inside an
 * instruction, and every wrong instruction marked while it is typed.
 */
export class ExportInstructionAssist implements vscode.Disposable {
    private readonly diagnostics: vscode.DiagnosticCollection;
    private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly subscriptions: vscode.Disposable[] = [];

    constructor(
        private readonly openExportDialog: (request: ExportDialogRequest) => Promise<ExportDialogChoice | undefined>,
        private readonly languages: ReadonlyArray<string>
    ) {
        this.diagnostics = vscode.languages.createDiagnosticCollection('pgExportInstructions');
        const selector = this.languages.map((language) => ({ language }));
        this.subscriptions.push(
            this.diagnostics,
            vscode.languages.registerCompletionItemProvider(selector, { provideCompletionItems: (doc, pos, _t, ctx) => this.completions(doc, pos, ctx) }, '@', ' ', '=', '{'),
            vscode.languages.registerHoverProvider(selector, { provideHover: (doc, pos) => this.hover(doc, pos) }),
            vscode.languages.registerCodeActionsProvider(selector, { provideCodeActions: (doc, range, ctx) => this.codeActions(doc, range, ctx) }, {
                providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite]
            }),
            vscode.workspace.onDidOpenTextDocument((doc) => this.schedule(doc, 0)),
            vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document, 300)),
            vscode.workspace.onDidCloseTextDocument((doc) => this.forget(doc))
        );
        for (const doc of vscode.workspace.textDocuments) {
            this.schedule(doc, 0);
        }
    }

    /**
     * Write or rewrite the instruction of the query at the cursor — or at
     * `offset` of the document `uri` — from the export dialog of the Data
     * Viewer, which shows the query and starts from the instruction there.
     */
    async addInstruction(uri?: vscode.Uri, offset?: number): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        const document = !uri
            ? editor?.document
            : editor?.document.uri.toString() === uri.toString()
                ? editor.document
                : vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
        if (!document) {
            vscode.window.showWarningMessage('Open a SQL file and place the cursor in the query to export.');
            return;
        }
        const at = typeof offset === 'number' ? offset : (editor && editor.document === document ? document.offsetAt(editor.selection.active) : 0);
        const target = locateExportTarget(document.getText(), at);
        if ('error' in target) {
            vscode.window.showWarningMessage(target.error);
            return;
        }
        const documentFolder = document.isUntitled ? undefined : path.dirname(document.fileName);
        const fallbackFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const values = exportPlaceholders(new Date(), document.fileName);
        const prefill = instructionPrefill(target, documentFolder, fallbackFolder);
        const queryLine = document.positionAt(target.start).line;
        const version = document.version;
        const viewColumn = editor?.document === document ? editor.viewColumn : undefined;

        const choice = await this.openExportDialog({
            ...prefill,
            title: `Export Instruction: line ${queryLine + 1} of ${path.basename(document.fileName)}`,
            sql: target.sql,
            purpose: 'instruction',
            submitLabel: target.instruction ? 'Update' : 'Insert',
            validate: (c) => instructionChoiceProblem(c, documentFolder, values)
        });
        if (!choice) return;
        if (document.isClosed) {
            vscode.window.showWarningMessage('The SQL file was closed, so the export instruction was not written.');
            return;
        }
        const text = document.getText();
        const current = document.version === version ? target : relocateExportTarget(text, target);
        if (!current) {
            vscode.window.showWarningMessage('The query changed while the export dialog was open, so the export instruction was not written. Run Add Export Instruction again.');
            return;
        }
        const lineText = instructionTextFromChoice(choice, documentFolder);
        const change = instructionEdit(text, current, lineText);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)), change.text);
        if (!await vscode.workspace.applyEdit(edit)) {
            vscode.window.showErrorMessage('The export instruction could not be written into the SQL file.');
            return;
        }
        try {
            const shown = await vscode.window.showTextDocument(document, { viewColumn });
            const from = new vscode.Position(change.line, change.column);
            const to = new vscode.Position(change.line, change.column + lineText.length);
            shown.selection = new vscode.Selection(from, to);
            shown.revealRange(new vscode.Range(from, to), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        } catch (err: unknown) {
            Logger.error('ExportInstructionAssist.addInstruction', err);
        }
    }

    dispose(): void {
        for (const timer of this.pending.values()) clearTimeout(timer);
        this.pending.clear();
        for (const subscription of this.subscriptions) subscription.dispose();
    }

    private completions(document: vscode.TextDocument, position: vscode.Position, context: vscode.CompletionContext): vscode.CompletionItem[] | undefined {
        const prefix = document.lineAt(position.line).text.slice(0, position.character);
        const trigger = context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter ? context.triggerCharacter : undefined;
        const result = exportInstructionCompletions(prefix, trigger);
        if (!result || result.items.length === 0) return undefined;
        const range = new vscode.Range(position.line, result.from, position.line, position.character);
        return result.items.map((spec) => {
            const item = new vscode.CompletionItem(spec.label, COMPLETION_KINDS[spec.kind]);
            item.insertText = spec.snippet ? new vscode.SnippetString(spec.insertText) : spec.insertText;
            item.range = range;
            item.detail = spec.detail;
            if (spec.documentation) item.documentation = new vscode.MarkdownString(spec.documentation);
            if (spec.sortText) item.sortText = spec.sortText;
            if (spec.retrigger) item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest' };
            return item;
        });
    }

    private hover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
        const found = exportInstructionHover(document.lineAt(position.line).text, position.character);
        if (!found) return undefined;
        return new vscode.Hover(new vscode.MarkdownString(found.markdown), new vscode.Range(position.line, found.start, position.line, found.end));
    }

    private codeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext): vscode.CodeAction[] {
        const text = document.getText();
        if (text.length > 2_000_000) return [];
        const offset = document.offsetAt(range.start);
        const target = locateExportTarget(text, offset);
        if ('error' in target) return [];
        const queryLine = document.positionAt(target.start).line;
        const onInstruction = target.instruction !== undefined && target.instruction.line === range.start.line;
        // The light bulb shows only on the first line of a query and on its
        // instruction; Ctrl+. offers the action anywhere in the query.
        if (context.triggerKind === vscode.CodeActionTriggerKind.Automatic && range.start.line !== queryLine && !onInstruction) {
            return [];
        }
        const broken = target.instruction !== undefined && target.parsed === undefined;
        const title = !target.instruction ? 'Add Export Instruction' : broken ? 'Rewrite Export Instruction' : 'Edit Export Instruction';
        const action = new vscode.CodeAction(title, broken ? vscode.CodeActionKind.QuickFix : vscode.CodeActionKind.RefactorRewrite);
        action.command = { command: ADD_EXPORT_INSTRUCTION_COMMAND, title, arguments: [document.uri, offset] };
        if (broken) {
            action.diagnostics = context.diagnostics.filter((d) => d.source === DIAGNOSTIC_SOURCE && d.range.start.line === target.instruction!.line);
            action.isPreferred = true;
        }
        return [action];
    }

    /** Check the instructions of `document` once it has been quiet for `delay` ms. */
    private schedule(document: vscode.TextDocument, delay: number): void {
        if (!this.languages.includes(document.languageId)) return;
        const key = document.uri.toString();
        const previous = this.pending.get(key);
        if (previous) clearTimeout(previous);
        this.pending.set(key, setTimeout(() => {
            this.pending.delete(key);
            this.check(document);
        }, delay));
    }

    private check(document: vscode.TextDocument): void {
        if (document.isClosed) return;
        try {
            const folder = document.isUntitled ? undefined : path.dirname(document.fileName);
            const problems = exportInstructionProblems(document.getText(), folder, document.fileName);
            this.diagnostics.set(document.uri, problems.map((problem) => {
                const lineText = document.lineAt(problem.line).text;
                const start = Math.max(0, lineText.indexOf('--'));
                const diagnostic = new vscode.Diagnostic(
                    new vscode.Range(problem.line, start, problem.line, lineText.length),
                    problem.message,
                    vscode.DiagnosticSeverity.Error
                );
                diagnostic.source = DIAGNOSTIC_SOURCE;
                return diagnostic;
            }));
        } catch (err: unknown) {
            Logger.log('exportInstructions', `Checking the export instructions failed: ${getErrorMessage(err)}`);
        }
    }

    private forget(document: vscode.TextDocument): void {
        const key = document.uri.toString();
        const timer = this.pending.get(key);
        if (timer) clearTimeout(timer);
        this.pending.delete(key);
        this.diagnostics.delete(document.uri);
    }
}
