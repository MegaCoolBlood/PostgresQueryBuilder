/**
 * Typed variable values for the "View Data" command: how a value the user
 * typed for a `$1` / `:name` / PL/pgSQL variable becomes SQL text, which type
 * to suggest from the column the variable is compared with, and how the
 * choices are remembered.
 *
 * Pure — no `vscode` dependency — so it is unit tested with `node --test`.
 * The feature builds SQL text by design (the statement is shown and run as a
 * whole), so every value except *Plain SQL* is turned into a properly escaped
 * literal here.
 */
import { escapeSqlLiteral } from './sqlUtils';
import {
    extractDefinedNames,
    extractTableQualifiers,
    findVariableTokens,
    tokenizeSql,
    type SqlToken
} from './selectStatementExtractor';

export type VariableKind = 'sql' | 'string' | 'number' | 'date' | 'timestamp' | 'boolean' | 'null' | 'list';
export type ListElementKind = 'string' | 'number';

/** The choices of the *Type* drop-down, in display order. */
export const VARIABLE_KINDS: ReadonlyArray<{ kind: VariableKind; label: string }> = [
    { kind: 'sql', label: 'Plain SQL' },
    { kind: 'string', label: 'String' },
    { kind: 'number', label: 'Number' },
    { kind: 'date', label: 'Date' },
    { kind: 'timestamp', label: 'Timestamp' },
    { kind: 'boolean', label: 'Boolean' },
    { kind: 'null', label: 'NULL' },
    { kind: 'list', label: 'List' }
];

export const LIST_ELEMENT_KINDS: ReadonlyArray<{ kind: ListElementKind; label: string }> = [
    { kind: 'string', label: 'String' },
    { kind: 'number', label: 'Number' }
];

export interface VariableInput {
    value: string;
    kind: VariableKind;
    /** Element type of a `list`; ignored for every other kind. */
    listKind?: ListElementKind;
}

/**
 * How a list is wrapped: `parens` adds `( … )`, `bare` emits just the items
 * because the variable already sits alone inside parentheses (`IN (:ids)`),
 * `array` builds an array for `= ANY(:ids)`: `ARRAY[1, 2]` for numbers, an
 * untyped literal `'{"a","b"}'` for text (see {@link untypedArrayLiteral}).
 */
export type ListWrapping = 'parens' | 'bare' | 'array';

export interface FormatOptions {
    /** The configured thousand separator of the Data Viewer. */
    thousandSeparator?: string;
    listKind?: ListElementKind;
    listWrapping?: ListWrapping;
}

export type FormatResult = { sql: string; error?: undefined } | { error: string; sql?: undefined };

export function isVariableKind(value: unknown): value is VariableKind {
    return typeof value === 'string' && VARIABLE_KINDS.some(k => k.kind === value);
}

export function isListElementKind(value: unknown): value is ListElementKind {
    return value === 'string' || value === 'number';
}

// ===== Parsing =====

function countOf(text: string, ch: string): number {
    return text.split(ch).length - 1;
}

/**
 * Parse a number typed by a person into a SQL numeric literal, or `null` when
 * it is not a number. Spaces, non-breaking spaces, underscores, apostrophes
 * and the configured thousand separator are dropped. A single comma is the
 * decimal mark (as everywhere in the Data Viewer), a single dot too; with both
 * present the later one is the decimal mark and the other must group the
 * integer part in threes (`1.234,5`, `1,234.5`). Repeated commas or dots are
 * grouping only when every group has three digits. Anything else is rejected.
 */
export function parseNumberInput(text: string, thousandSeparator = ' '): string | null {
    let s = String(text ?? '').trim().replace(/[\s\u00a0\u202f_']/g, '');
    if (thousandSeparator && thousandSeparator !== '.' && thousandSeparator !== ',') {
        s = s.split(thousandSeparator).join('');
    }
    if (!s) return null;

    const sign = s[0] === '-' || s[0] === '+' ? s[0] : '';
    let body = sign ? s.slice(1) : s;
    let exponent = '';
    const exp = /[eE][+-]?\d+$/.exec(body);
    if (exp) {
        exponent = exp[0].toLowerCase();
        body = body.slice(0, exp.index);
    }

    const dots = countOf(body, '.');
    const commas = countOf(body, ',');
    let decimalMark = '';
    let groupMark = '';
    if (dots > 0 && commas > 0) {
        decimalMark = body.lastIndexOf('.') > body.lastIndexOf(',') ? '.' : ',';
        groupMark = decimalMark === '.' ? ',' : '.';
        if (countOf(body, decimalMark) > 1) return null;
    } else if (commas > 1) {
        groupMark = ',';
    } else if (commas === 1) {
        decimalMark = ',';
    } else if (dots > 1) {
        groupMark = '.';
    } else if (dots === 1) {
        decimalMark = '.';
    }

    let intPart = body;
    let fraction = '';
    if (decimalMark) {
        const idx = body.lastIndexOf(decimalMark);
        intPart = body.slice(0, idx);
        fraction = body.slice(idx + 1);
    }
    if (groupMark) {
        const groups = intPart.split(groupMark);
        if (!/^\d{1,3}$/.test(groups[0]) || groups.slice(1).some(g => !/^\d{3}$/.test(g))) return null;
        intPart = groups.join('');
    }
    if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fraction) || (intPart === '' && fraction === '')) return null;

    const literal = (intPart || '0') + (fraction ? '.' + fraction : '') + exponent;
    return sign === '-' ? '-' + literal : literal;
}

function isValidDate(year: number, month: number, day: number): boolean {
    if (year < 1 || month < 1 || month > 12 || day < 1) return false;
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    return day <= days;
}

/** `YYYY-MM-DD` of a real calendar day written as `YYYY-MM-DD` or `DD.MM.YYYY`, or `null`. */
function parseDatePart(text: string): string | null {
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
    const dotted = iso ? null : /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text);
    const [y, m, d] = iso ? [iso[1], iso[2], iso[3]] : dotted ? [dotted[3], dotted[2], dotted[1]] : ['', '', ''];
    if (!y || !isValidDate(Number(y), Number(m), Number(d))) return null;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/**
 * The date and time forms the date picker of the form accepts (its
 * `parseDateTimeInput`): `YYYY-MM-DD` or `DD.MM.YYYY`, optionally followed by
 * `T` or spaces and a 24-hour `HH:MM[:SS[.ffffff]]`, optionally with an offset
 * `Z` / `?hh[:mm]`. The picker turns `now`, `today` and a bare `HH:MM` into
 * this form before the form posts its values (its keydown handler on the
 * input runs before the form's Enter handler on the document), so the host
 * never needs to know the browser's clock.
 */
const DATE_TIME_INPUT = /^(\S+?)(?:(?:T\s*|\s+)(\d{1,2}):(\d{2})(?::(\d{2})(\.\d{1,6})?)?(Z|\s*[+-]\d{2}(?::?\d{2})?)?)?$/i;

interface DateTimeInput {
    date: string;
    time?: { hh: string; mm: string; ss?: string; frac: string };
    /** The offset as written (`+01`, `-05:30`, `Z`), '' for none. */
    zone: string;
}

function readDateTimeInput(text: string): DateTimeInput | 'infinity' | '-infinity' | null {
    const s = String(text ?? '').trim();
    const inf = /^([+-]?)infinity$/i.exec(s);
    if (inf) return inf[1] === '-' ? '-infinity' : 'infinity';
    const m = DATE_TIME_INPUT.exec(s);
    const date = m ? parseDatePart(m[1]) : null;
    if (!m || !date) return null;
    if (m[2] === undefined) return { date, zone: '' };
    const time = { hh: m[2].padStart(2, '0'), mm: m[3], ss: m[4], frac: m[5] ?? '' };
    if (Number(time.hh) > 23 || Number(time.mm) > 59 || Number(time.ss ?? 0) > 59) return null;
    return { date, time, zone: (m[6] ?? '').trim().toUpperCase() };
}

/**
 * A real calendar day as `YYYY-MM-DD` ? typed as `YYYY-MM-DD` or
 * `DD.MM.YYYY`; a time after it is dropped, as by the date picker ? or
 * `infinity` / `-infinity`; `null` for anything else, also for a time with
 * an offset (a date has no time zone).
 */
export function parseDateInput(text: string): string | null {
    const r = readDateTimeInput(text);
    if (r === null || typeof r === 'string') return r;
    return r.zone ? null : r.date;
}

function readTimestampInput(text: string): { text: string; zoned: boolean } | null {
    const r = readDateTimeInput(text);
    if (r === null || typeof r === 'string') return r === null ? null : { text: r, zoned: false };
    const t = r.time ?? { hh: '00', mm: '00', ss: '00', frac: '' };
    return { text: `${r.date} ${t.hh}:${t.mm}:${t.ss ?? '00'}${t.frac}${r.zone}`, zoned: r.zone !== '' };
}

/**
 * `YYYY-MM-DD[T ]HH:MM[:SS[.ffffff]][offset]` or `DD.MM.YYYY HH:MM?` (or a
 * bare date, meaning midnight), 24-hour, as `YYYY-MM-DD HH:MM:SS[.ffffff][offset]`
 * with the offset (`+01`, `-05:30`, `Z`) as typed; `infinity` / `-infinity`;
 * or `null`.
 */
export function parseTimestampInput(text: string): string | null {
    return readTimestampInput(text)?.text ?? null;
}

function parseBooleanInput(text: string): boolean | null {
    const s = String(text ?? '').trim().toLowerCase();
    if (/^(true|t|yes|y|on|1)$/.test(s)) return true;
    if (/^(false|f|no|n|off|0)$/.test(s)) return false;
    return null;
}

/**
 * Split list input into its items: one item per line when the text has more
 * than one line, otherwise comma-separated. Items are trimmed; empty ones are
 * dropped. (A number with a decimal comma therefore needs a line of its own.)
 */
export function parseListInput(text: string): string[] {
    const s = String(text ?? '');
    const parts = /[\r\n]/.test(s) ? s.split(/\r\n|\r|\n/) : s.split(',');
    return parts.map(p => p.trim()).filter(p => p !== '');
}

// ===== Formatting =====

/**
 * Text items as one untyped array literal (`'{"a","b"}'`) for `= ANY(…)`:
 * PostgreSQL gives it the array type of the column, so it works for uuid,
 * date, enum or inet columns, where `ARRAY['a']` (a text[]) would not. Every
 * element is double-quoted with `"` and `\` backslash-escaped, so no element
 * is read as NULL.
 */
export function untypedArrayLiteral(items: readonly string[]): string {
    const elements = items.map((item) => `"${item.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`);
    return escapeSqlLiteral(`{${elements.join(',')}}`);
}

/**
 * Turn the text the user typed into the SQL that replaces the variable.
 * *Plain SQL* is inserted verbatim (an empty value keeps the variable as it
 * is); every other kind is validated and rendered as a literal.
 */
export function formatVariableValue(value: string, kind: VariableKind, options: FormatOptions = {}): FormatResult {
    const text = String(value ?? '');
    switch (kind) {
        case 'sql':
            return { sql: text };
        case 'string':
            return { sql: escapeSqlLiteral(text) };
        case 'number': {
            const n = parseNumberInput(text, options.thousandSeparator);
            if (n !== null) return { sql: n };
            return { error: text.trim() ? `"${text.trim()}" is not a number.` : 'Enter a number.' };
        }
        case 'date': {
            const d = parseDateInput(text);
            return d ? { sql: `DATE '${d}'` } : { error: 'Enter a date as YYYY-MM-DD or DD.MM.YYYY.' };
        }
        case 'timestamp': {
            const ts = readTimestampInput(text);
            // An offset names an instant: TIMESTAMPTZ keeps it instead of dropping it.
            if (ts) return { sql: `${ts.zoned ? 'TIMESTAMPTZ' : 'TIMESTAMP'} '${ts.text}'` };
            return { error: 'Enter a timestamp as YYYY-MM-DD HH:MM[:SS] (24-hour) or DD.MM.YYYY HH:MM.' };
        }
        case 'boolean': {
            const b = parseBooleanInput(text);
            return b === null ? { error: 'Choose true or false.' } : { sql: b ? 'TRUE' : 'FALSE' };
        }
        case 'null':
            return { sql: 'NULL' };
        case 'list': {
            const items = parseListInput(text);
            if (items.length === 0) return { error: 'Enter at least one value.' };
            const elementKind: ListElementKind = options.listKind === 'number' ? 'number' : 'string';
            if (elementKind === 'string' && options.listWrapping === 'array') return { sql: untypedArrayLiteral(items) };
            const rendered: string[] = [];
            for (let i = 0; i < items.length; i++) {
                const r = formatVariableValue(items[i], elementKind, options);
                if (r.error !== undefined) return { error: `Item ${i + 1}: ${r.error}` };
                rendered.push(r.sql);
            }
            const joined = rendered.join(', ');
            switch (options.listWrapping) {
                case 'bare': return { sql: joined };
                case 'array': return { sql: `ARRAY[${joined}]` };
                default: return { sql: `(${joined})` };
            }
        }
        default:
            return { error: 'Unknown type.' };
    }
}

// ===== Type suggestion =====

const NUMBER_TYPES = new Set([
    'smallint', 'integer', 'bigint', 'int', 'int2', 'int4', 'int8', 'numeric', 'decimal',
    'real', 'double precision', 'float', 'float4', 'float8', 'oid',
    'smallserial', 'serial', 'bigserial', 'serial2', 'serial4', 'serial8'
]);

const STRING_TYPES = new Set([
    'text', 'character varying', 'varchar', 'character', 'char', 'bpchar', 'name', 'citext',
    'uuid', 'json', 'jsonb', 'xml', 'inet', 'cidr', 'macaddr', 'macaddr8', 'interval',
    'money', 'bit', 'bit varying', 'varbit', 'user-defined', 'tsvector', 'tsquery'
]);

/**
 * The kind suggested for a column of type `columnType` (as reported by
 * `information_schema.columns.data_type` or `format_type`). Arrays and unknown
 * types yield `sql` (Plain SQL).
 */
export function guessVariableKind(columnType: string | undefined): VariableKind {
    const t = String(columnType ?? '').trim().toLowerCase();
    if (!t || t.endsWith('[]') || t === 'array' || t.startsWith('_')) return 'sql';
    const base = t.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
    if (NUMBER_TYPES.has(base)) return 'number';
    if (base === 'date') return 'date';
    if (base.startsWith('timestamp')) return 'timestamp';
    if (base === 'boolean' || base === 'bool') return 'boolean';
    if (STRING_TYPES.has(base) || base.startsWith('time')) return 'string';
    return 'sql';
}

export interface ColumnRef {
    /** Lower-cased table name or alias in front of the column, if any. */
    qualifier?: string;
    /** Lower-cased column name. */
    column: string;
}

export interface VariableContext {
    /** The column the variable is compared with, if one could be read. */
    column?: ColumnRef;
    /** True when the variable is the whole value list of `IN (…)` / `= ANY(…)`. */
    isWholeList: boolean;
    /** How a list value has to be wrapped at this occurrence. */
    listWrapping: ListWrapping;
    /** A kind implied by the syntax alone (`LIKE` → string, `LIMIT` → number). */
    hint?: VariableKind;
}

const COMPARISON_OPS = new Set(['=', '<>', '!=', '<', '>', '<=', '>=']);
const BETWEEN_STOP = new Set(['and', 'or', 'where', 'on', 'when', 'then', 'else', 'having', 'select', 'not']);

function isPunct(t: SqlToken | undefined, text: string): boolean {
    return !!t && t.type === 'punct' && t.text === text;
}

function isWord(t: SqlToken | undefined, ...words: string[]): boolean {
    return !!t && t.type === 'word' && words.includes(t.text.toLowerCase());
}

/** The column ending at token `k` (`col` or `qualifier.col`), reading backwards. */
function columnBefore(tokens: SqlToken[], k: number): ColumnRef | undefined {
    const t = tokens[k];
    if (!t || t.type !== 'word') return undefined;
    const before = tokens[k - 1];
    if (before && before.type === 'op' && before.text === '::') return undefined;
    if (isPunct(before, '.') && tokens[k - 2] && tokens[k - 2].type === 'word') {
        return { qualifier: tokens[k - 2].text.toLowerCase(), column: t.text.toLowerCase() };
    }
    return { column: t.text.toLowerCase() };
}

/** The column starting at token `k` (`col`, `q.col` or `schema.q.col`), reading forwards. */
function columnAfter(tokens: SqlToken[], k: number): ColumnRef | undefined {
    const t = tokens[k];
    if (!t || t.type !== 'word') return undefined;
    const parts = [t.text.toLowerCase()];
    let j = k + 1;
    while (isPunct(tokens[j], '.') && tokens[j + 1] && tokens[j + 1].type === 'word') {
        parts.push(tokens[j + 1].text.toLowerCase());
        j += 2;
    }
    if (isPunct(tokens[j], '(')) return undefined;
    const column = parts[parts.length - 1];
    return parts.length > 1 ? { qualifier: parts[parts.length - 2], column } : { column };
}

/** `k`, or the token before it when `k` is a `NOT` (as in `NOT IN`, `NOT BETWEEN`). */
function skipNot(tokens: SqlToken[], k: number): number {
    return isWord(tokens[k], 'not') ? k - 1 : k;
}

/**
 * Read the comparison a variable occurrence (`span`, offsets into `sql`) sits
 * in: `col op var`, `var op col`, `col [NOT] IN (var)`, `col op ANY(var)`,
 * `col BETWEEN var AND var`, `col LIKE var`, `LIMIT var`.
 */
export function detectVariableContext(
    sql: string,
    span: { start: number; end: number },
    tokens: SqlToken[] = tokenizeSql(sql)
): VariableContext {
    const ctx: VariableContext = { isWholeList: false, listWrapping: 'parens' };
    const i = tokens.findIndex(t => t.start === span.start);
    if (i < 0) return ctx;
    let j = i;
    while (j + 1 < tokens.length && tokens[j].end < span.end) j++;
    const prev = tokens[i - 1];
    const next = tokens[j + 1];
    const depth = tokens[i].depth;

    const alone = isPunct(prev, '(') && isPunct(next, ')');
    if (alone) ctx.listWrapping = isWord(tokens[i - 2], 'any', 'all', 'some') ? 'array' : 'bare';

    // Inside a value list: IN ( … ) or op ANY/ALL/SOME ( … ).
    if (depth > 0) {
        let open = i - 1;
        while (open >= 0 && !(isPunct(tokens[open], '(') && tokens[open].depth === depth - 1)) open--;
        if (open >= 0) {
            const kw = tokens[open - 1];
            if (isWord(kw, 'in')) {
                ctx.column = columnBefore(tokens, skipNot(tokens, open - 2));
                ctx.isWholeList = alone;
                return ctx;
            }
            if (isWord(kw, 'any', 'all', 'some') && tokens[open - 2] && COMPARISON_OPS.has(tokens[open - 2].text)) {
                ctx.column = columnBefore(tokens, open - 3);
                ctx.isWholeList = alone;
                return ctx;
            }
        }
    }

    if (prev && prev.type === 'op' && COMPARISON_OPS.has(prev.text)) {
        ctx.column = columnBefore(tokens, i - 2);
        return ctx;
    }
    if (isWord(prev, 'like', 'ilike') || (isWord(prev, 'to') && isWord(tokens[i - 2], 'similar'))) {
        ctx.hint = 'string';
        return ctx;
    }
    if (isWord(prev, 'limit', 'offset')) {
        ctx.hint = 'number';
        return ctx;
    }
    if (isWord(prev, 'between', 'symmetric')) {
        const between = isWord(prev, 'symmetric') ? i - 2 : i - 1;
        ctx.column = columnBefore(tokens, skipNot(tokens, between - 1));
        return ctx;
    }
    if (isWord(prev, 'and')) {
        for (let k = i - 2; k >= 0 && tokens[k].depth >= depth; k--) {
            if (tokens[k].depth !== depth || tokens[k].type !== 'word') continue;
            if (isWord(tokens[k], 'between')) {
                ctx.column = columnBefore(tokens, skipNot(tokens, k - 1));
                return ctx;
            }
            if (BETWEEN_STOP.has(tokens[k].text.toLowerCase())) break;
        }
    }
    if (next && next.type === 'op' && COMPARISON_OPS.has(next.text)) {
        ctx.column = columnAfter(tokens, j + 2);
    }
    return ctx;
}

/** Resolves a column reference to its data type, or `undefined` when unknown. */
export type ColumnTypeLookup = (ref: ColumnRef) => string | undefined;

export interface CatalogColumn {
    table: string;
    column: string;
    type: string;
}

/**
 * A {@link ColumnTypeLookup} over the columns of the referenced tables.
 * `aliases` maps every table name and alias of the query to its table (see
 * `extractTableAliasMap`). An unqualified column resolves only when every
 * referenced table that has it agrees on the type.
 */
export function buildColumnTypeLookup(aliases: Map<string, string>, columns: CatalogColumn[]): ColumnTypeLookup {
    const byTable = new Map<string, Map<string, string>>();
    for (const c of columns) {
        const table = c.table.toLowerCase();
        let cols = byTable.get(table);
        if (!cols) { cols = new Map(); byTable.set(table, cols); }
        const column = c.column.toLowerCase();
        if (!cols.has(column)) cols.set(column, c.type);
    }
    return (ref: ColumnRef) => {
        const column = ref.column.toLowerCase();
        if (ref.qualifier) {
            const q = ref.qualifier.toLowerCase();
            const table = aliases.has(q) ? aliases.get(q) : q;
            return table ? byTable.get(table)?.get(column) : undefined;
        }
        const types = new Set<string>();
        for (const cols of byTable.values()) {
            const type = cols.get(column);
            if (type !== undefined) types.add(type);
        }
        return types.size === 1 ? [...types][0] : undefined;
    };
}

export interface KindGuess {
    kind: VariableKind;
    listKind?: ListElementKind;
}

function guessFromContext(ctx: VariableContext, lookup: ColumnTypeLookup): KindGuess | undefined {
    const type = ctx.column ? lookup(ctx.column) : undefined;
    if (ctx.isWholeList) {
        if (type === undefined) return undefined;
        const element = guessVariableKind(type);
        if (element === 'sql') return undefined;
        return { kind: 'list', listKind: element === 'number' ? 'number' : 'string' };
    }
    if (ctx.hint) return { kind: ctx.hint };
    if (type === undefined) return undefined;
    const kind = guessVariableKind(type);
    return kind === 'sql' ? undefined : { kind };
}

/**
 * Suggested kind per variable (lower-cased key), read from the first
 * occurrence whose comparison reveals one. Variables without a usable context
 * are absent from the result.
 */
export function guessVariableKinds(sql: string, lookup: ColumnTypeLookup): Map<string, KindGuess> {
    const result = new Map<string, KindGuess>();
    const tokens = tokenizeSql(sql);
    const occurrences = findVariableTokens(sql, extractTableQualifiers(sql), extractDefinedNames(sql));
    for (const occ of occurrences) {
        if (result.has(occ.key)) continue;
        const guess = guessFromContext(detectVariableContext(sql, occ, tokens), lookup);
        if (guess) result.set(occ.key, guess);
    }
    return result;
}

// ===== Substitution =====

export interface SubstitutionResult {
    sql: string;
    /** Error message per variable name (as given in `inputs`) whose value is invalid. */
    errors: Record<string, string>;
}

/**
 * Replace every variable of `sql` with its formatted value. Keys match
 * case-insensitively. Invalid values are reported in `errors` and leave their
 * variable untouched, as does an empty *Plain SQL* value. A list is wrapped
 * per occurrence, so `IN (:ids)` and `IN :ids` both come out right.
 */
export function substituteTypedVariables(
    sql: string,
    inputs: Record<string, VariableInput>,
    options: { thousandSeparator?: string } = {}
): SubstitutionResult {
    const errors: Record<string, string> = {};
    const lookup = new Map<string, VariableInput>();
    for (const [name, input] of Object.entries(inputs)) {
        if (!input || !isVariableKind(input.kind)) continue;
        const r = formatVariableValue(input.value, input.kind, { ...options, listKind: input.listKind });
        if (r.error !== undefined) {
            errors[name] = r.error;
            continue;
        }
        if (input.kind === 'sql' && String(input.value ?? '') === '') continue;
        lookup.set(name.toLowerCase(), input);
    }
    if (lookup.size === 0) return { sql, errors };

    const occurrences = findVariableTokens(sql, extractTableQualifiers(sql), extractDefinedNames(sql));
    let tokens: SqlToken[] | undefined;
    let result = sql;
    // Right to left, so earlier offsets stay valid.
    for (let i = occurrences.length - 1; i >= 0; i--) {
        const occ = occurrences[i];
        const input = lookup.get(occ.key);
        if (!input) continue;
        let listWrapping: ListWrapping | undefined;
        if (input.kind === 'list') {
            tokens ??= tokenizeSql(sql);
            listWrapping = detectVariableContext(sql, occ, tokens).listWrapping;
        }
        const r = formatVariableValue(input.value, input.kind, { ...options, listKind: input.listKind, listWrapping });
        let text = r.sql ?? '';
        // `x-:v` with -5 must not turn into the comment `x--5`.
        if (text.startsWith('-') && result[occ.start - 1] === '-') text = ' ' + text;
        result = result.slice(0, occ.start) + text + result.slice(occ.end);
    }
    return { sql: result, errors };
}

// ===== Remembered values =====

/** One entry of the `viewDataVariableCache` global state. */
export interface CachedVariable {
    value: string;
    kind: VariableKind;
    listKind?: ListElementKind;
}

/**
 * Read one remembered entry. Entries written before value types existed are
 * plain strings and come back as *Plain SQL*; anything unreadable is ignored.
 */
export function readCachedVariable(entry: unknown): VariableInput | undefined {
    if (typeof entry === 'string') return { value: entry, kind: 'sql' };
    if (!entry || typeof entry !== 'object') return undefined;
    const e = entry as { value?: unknown; kind?: unknown; listKind?: unknown };
    if (typeof e.value !== 'string' || !isVariableKind(e.kind)) return undefined;
    return isListElementKind(e.listKind)
        ? { value: e.value, kind: e.kind, listKind: e.listKind }
        : { value: e.value, kind: e.kind };
}

/**
 * The inputs a webview posted, keeping only the expected variable `names` and
 * well-formed entries.
 */
export function readSubmittedInputs(raw: unknown, names: readonly string[]): Record<string, VariableInput> {
    const result: Record<string, VariableInput> = {};
    if (!raw || typeof raw !== 'object') return result;
    const posted = raw as Record<string, unknown>;
    for (const name of names) {
        const input = Object.prototype.hasOwnProperty.call(posted, name) ? readCachedVariable(posted[name]) : undefined;
        if (input && typeof posted[name] === 'object') result[name] = input;
    }
    return result;
}

export function toCachedVariable(input: VariableInput): CachedVariable {
    const entry: CachedVariable = { value: String(input.value ?? ''), kind: input.kind };
    if (input.kind === 'list') entry.listKind = input.listKind === 'number' ? 'number' : 'string';
    return entry;
}

/** The cache with `inputs` stored under their lower-cased names. */
export function mergeVariableCache(
    cache: Record<string, unknown>,
    inputs: Record<string, VariableInput>
): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...cache };
    for (const [name, input] of Object.entries(inputs)) {
        if (input && isVariableKind(input.kind)) merged[name.toLowerCase()] = toCachedVariable(input);
    }
    return merged;
}

/**
 * The value and type a variable's row starts with: what was remembered for
 * it, else the suggested type, else empty *Plain SQL*. An empty Plain SQL
 * entry carries no choice, so the suggestion wins over it.
 */
export function initialVariableInput(cached: unknown, guess: KindGuess | undefined): VariableInput {
    const remembered = readCachedVariable(cached);
    if (remembered && !(remembered.kind === 'sql' && remembered.value === '')) return remembered;
    if (guess) {
        return guess.kind === 'list'
            ? { value: '', kind: 'list', listKind: guess.listKind ?? 'string' }
            : { value: '', kind: guess.kind };
    }
    return { value: '', kind: 'sql' };
}
