/**
 * Finds the CREATE statements of database objects in SQL source text, so the
 * Objects and Tables views can compare the database with the repository.
 *
 * Pure: no `vscode`, no I/O. A single linear pass tokenizes the text and skips
 * comments, string literals and dollar-quoted bodies, so a `CREATE` inside a
 * function body or an `EXECUTE '…'` string is never mistaken for a definition.
 * The body of a DO block is the exception: it runs when the file is deployed.
 */
import { createHash } from 'crypto';

export type RepoObjectKind =
    | 'function' | 'procedure' | 'aggregate'
    | 'type' | 'domain' | 'sequence' | 'trigger' | 'extension' | 'schema'
    | 'table' | 'view' | 'matview' | 'foreign';

export const ROUTINE_KINDS: ReadonlySet<RepoObjectKind> = new Set<RepoObjectKind>(['function', 'procedure', 'aggregate']);

export interface SourcePosition {
    /** 0-based line. */
    line: number;
    /** 0-based character within the line. */
    character: number;
}

export interface RepoDefinition {
    kind: RepoObjectKind;
    /** Schema as written — folded to lower case unless quoted; null when the name is unqualified. */
    schema: string | null;
    /** Object name, folded to lower case unless quoted. */
    name: string;
    /**
     * Normalised identity argument types of a function, procedure or aggregate
     * (see {@link normalizeTypeName}); `'?'` stands for a type that cannot be
     * known from the source (`%TYPE`). null for every other kind.
     */
    argTypes: string[] | null;
    /** The table a trigger is defined on. */
    table?: { schema: string | null; name: string };
    /** The schemas of a `SET search_path` earlier in the same file; null when there was none. */
    searchPath: string[] | null;
    /** Range of the (qualified) object name. */
    start: SourcePosition;
    end: SourcePosition;
    /** Range of the whole statement, from CREATE to its last token. */
    statementStart?: SourcePosition;
    statementEnd?: SourcePosition;
    /** Parameters of a function or procedure, in signature order. */
    params?: RepoParam[];
    /** How many arguments a call may pass: OUT parameters count for procedures only (CALL passes them). */
    argCount?: ArgCount;
    /** The result type of a function as written after RETURNS. */
    returns?: string;
    /** The doc comment right above the statement, as written. */
    doc?: RepoDoc;
    /** md5 of the normalised body of a function or procedure (see {@link normalizeRoutineBody}). */
    bodyHash?: string;
    /** md5 of the body's tokens without comments (see {@link routineTokenText}). */
    tokenHash?: string;
}

export interface RepoParam {
    /** Name as written (folded unless quoted); null for an unnamed parameter. */
    name: string | null;
    mode: 'in' | 'out' | 'inout' | 'variadic';
    /** The type as written, e.g. `VARCHAR(20)`. */
    type: string;
    /** The default as written, without `DEFAULT` / `=`. */
    defaultValue: string | null;
    /** Range of the name, or of the type when the parameter has no name. */
    start: SourcePosition;
    end: SourcePosition;
}

export interface ArgCount {
    min: number;
    /** `Infinity` with a VARIADIC parameter. */
    max: number;
}

export interface RepoDoc {
    /** The comment as written: a `/** … *\/` block, or consecutive `--` lines. */
    text: string;
    block: boolean;
    start: SourcePosition;
    end: SourcePosition;
}

/** True when a call with `count` arguments fits `range`. */
export function acceptsArgCount(range: ArgCount | undefined | null, count: number): boolean {
    return !range || (count >= range.min && count <= range.max);
}

/**
 * The body of a routine the way it is compared with `pg_proc.prosrc`: without
 * whitespace and with ASCII letters in lower case, so a reformatted repository
 * does not count as different. Only ASCII is folded, so the database side,
 * which does the same in SQL (see the catalog query), cannot depend on its locale.
 */
export function normalizeRoutineBody(body: string): string {
    return body.replace(/[ \t\n\r\f\v]+/g, '').replace(/[A-Z]+/g, s => s.toLowerCase());
}

export function routineBodyHash(body: string): string {
    return createHash('md5').update(normalizeRoutineBody(body), 'utf8').digest('hex');
}

/**
 * The body of a routine as the exact comparison sees it: its tokens without
 * comments and whitespace, words in lower case, strings and quoted names as
 * written. A `-- note` that became `/* note *\/`, with or without its line
 * break, is no difference; a changed string literal is. Bodies nested in
 * dollar quotes (`EXECUTE $q$ … $q$`) are compared the same way.
 */
export function routineTokenText(body: string): string {
    return tokenize(body).map(t => {
        if (t.type === 'word') return t.value;
        if (t.type === 'dollar') {
            const inner = dollarContent(t.text);
            return inner === null ? t.text : `$$${routineTokenText(inner)}$$`;
        }
        return t.text;
    }).join(' ');
}

export function routineTokenHash(body: string): string {
    return createHash('md5').update(routineTokenText(body), 'utf8').digest('hex');
}

/**
 * The SQL without its comments, also those inside dollar-quoted bodies, the
 * same way on both sides of a comparison:
 * - a comment on lines of its own goes with its lines;
 * - a comment at the end of a line goes with that line break, so
 *   `x -- note` + new line + `+ 1` and `x /* note *\/ + 1` both become `x + 1`;
 * - a comment between code becomes a space.
 */
export function stripSqlComments(sql: string): string {
    return stripComments(stripComments(sql, 'ownLines'), 'rest');
}

function stripComments(sql: string, pass: 'ownLines' | 'rest'): string {
    const comments: SqlComment[] = [];
    const toks = tokenize(sql, comments);
    const cuts: Array<{ start: number; end: number; text: string }> = [];
    for (const c of comments) {
        const lineStart = sql.lastIndexOf('\n', c.start - 1) + 1;
        const nl = sql.indexOf('\n', c.end);
        const lineEnd = nl < 0 ? sql.length : nl;
        const before = sql.slice(lineStart, c.start);
        const after = sql.slice(c.end, lineEnd);
        const ownLines = /^[ \t]*$/.test(before) && /^[ \t\r]*$/.test(after);
        if (pass === 'ownLines') {
            if (ownLines) cuts.push({ start: lineStart, end: nl < 0 ? sql.length : nl + 1, text: '' });
        } else if (/^[ \t\r]*$/.test(after)) {
            // At the end of a line: the line break and the next line's indentation go too.
            let end = nl < 0 ? sql.length : nl + 1;
            while (end < sql.length && (sql[end] === ' ' || sql[end] === '\t')) end++;
            cuts.push({ start: c.start - (before.length - before.trimEnd().length), end, text: nl < 0 ? '' : ' ' });
        } else {
            cuts.push({ start: c.start, end: c.end, text: ' ' });
        }
    }
    for (const t of toks) {
        if (t.type !== 'dollar') continue;
        const inner = dollarContent(t.text);
        if (inner === null) continue;
        const tag = t.text.slice(0, t.text.indexOf('$', 1) + 1);
        cuts.push({ start: t.start, end: t.end, text: tag + stripComments(inner, pass) + tag });
    }
    cuts.sort((a, b) => a.start - b.start);
    let out = '';
    let at = 0;
    for (const cut of cuts) {
        if (cut.start < at) continue;
        out += sql.slice(at, cut.start) + cut.text;
        at = cut.end;
    }
    return out + sql.slice(at);
}

// ===== Tokenizer ===============================================================

export type TokType = 'word' | 'qident' | 'string' | 'dollar' | 'number' | 'punct' | 'op';

/** A comment the tokenizer skipped, kept for doc comments. */
export interface SqlComment {
    start: number;
    end: number;
    text: string;
    block: boolean;
}

export interface Tok {
    type: TokType;
    /** Source text of the token. */
    text: string;
    /** word: lower case; qident: unquoted name; string: content; otherwise the text. */
    value: string;
    start: number;
    end: number;
}

const OP_CHARS = new Set(['+', '-', '*', '/', '<', '>', '=', '~', '!', '@', '#', '%', '^', '&', '|', '`', '?', ':']);
const PUNCT_CHARS = new Set(['(', ')', ',', ';', '[', ']', '.']);
const WORD_START = /[A-Za-z_\u0080-\uffff]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-\uffff]/;
const DOLLAR_TAG = /\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y;

/** End offset (exclusive) of a quoted run starting at `i` (the opening quote). */
function readQuoted(src: string, i: number, quote: string, backslashEscapes: boolean): number {
    const n = src.length;
    let j = i + 1;
    while (j < n) {
        const c = src[j];
        if (backslashEscapes && c === '\\') {
            j += 2;
            continue;
        }
        if (c === quote) {
            if (src[j + 1] === quote) {
                j += 2;
                continue;
            }
            return j + 1;
        }
        j++;
    }
    return n;
}

/**
 * Break SQL text into tokens with their offsets. Comments are skipped; when
 * `comments` is given they are collected there, in source order.
 */
export function tokenize(src: string, comments?: SqlComment[]): Tok[] {
    const toks: Tok[] = [];
    const n = src.length;
    let i = 0;
    const push = (type: TokType, start: number, end: number, value?: string): void => {
        const text = src.slice(start, end);
        toks.push({ type, text, value: value ?? text, start, end });
    };
    while (i < n) {
        const c = src[i];
        const c2 = src[i + 1];
        if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v' || c === '\uFEFF') {
            i++;
            continue;
        }
        if (c === '-' && c2 === '-') {
            const nl = src.indexOf('\n', i);
            const end = nl < 0 ? n : nl;
            comments?.push({ start: i, end, text: src.slice(i, end).replace(/\r$/, ''), block: false });
            i = nl < 0 ? n : nl + 1;
            continue;
        }
        if (c === '/' && c2 === '*') {
            const start = i;
            let depth = 1;
            i += 2;
            while (i < n && depth > 0) {
                if (src[i] === '/' && src[i + 1] === '*') {
                    depth++;
                    i += 2;
                } else if (src[i] === '*' && src[i + 1] === '/') {
                    depth--;
                    i += 2;
                } else {
                    i++;
                }
            }
            comments?.push({ start, end: i, text: src.slice(start, i), block: true });
            continue;
        }
        // A psql meta-command (\i, \set, \connect …) runs to the end of the line.
        if (c === '\\') {
            const nl = src.indexOf('\n', i);
            i = nl < 0 ? n : nl + 1;
            continue;
        }
        if (c === "'") {
            const end = readQuoted(src, i, "'", false);
            push('string', i, end, src.slice(i + 1, end - 1).replace(/''/g, "'"));
            i = end;
            continue;
        }
        if ((c === 'e' || c === 'E') && c2 === "'") {
            const end = readQuoted(src, i + 1, "'", true);
            push('string', i, end, src.slice(i + 2, end - 1));
            i = end;
            continue;
        }
        if ((c === 'b' || c === 'B' || c === 'x' || c === 'X' || c === 'n' || c === 'N') && c2 === "'") {
            const end = readQuoted(src, i + 1, "'", false);
            push('string', i, end, src.slice(i + 2, end - 1));
            i = end;
            continue;
        }
        if ((c === 'u' || c === 'U') && c2 === '&' && (src[i + 2] === "'" || src[i + 2] === '"')) {
            const quote = src[i + 2];
            const end = readQuoted(src, i + 2, quote, false);
            push(quote === '"' ? 'qident' : 'string', i, end, src.slice(i + 3, end - 1));
            i = end;
            continue;
        }
        if (c === '"') {
            const end = readQuoted(src, i, '"', false);
            push('qident', i, end, src.slice(i + 1, end - 1).replace(/""/g, '"'));
            i = end;
            continue;
        }
        if (c === '$') {
            DOLLAR_TAG.lastIndex = i;
            const m = DOLLAR_TAG.exec(src);
            if (m) {
                const tag = m[0];
                const close = src.indexOf(tag, i + tag.length);
                const end = close < 0 ? n : close + tag.length;
                push('dollar', i, end);
                i = end;
                continue;
            }
            // A positional parameter such as $1.
            let j = i + 1;
            while (j < n && /[0-9]/.test(src[j])) j++;
            push('op', i, j);
            i = j;
            continue;
        }
        if (WORD_START.test(c)) {
            let j = i + 1;
            while (j < n && WORD_PART.test(src[j])) j++;
            push('word', i, j, src.slice(i, j).toLowerCase());
            i = j;
            continue;
        }
        if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(c2 ?? ''))) {
            let j = i + 1;
            while (j < n && /[0-9A-Za-z_.]/.test(src[j])) j++;
            push('number', i, j);
            i = j;
            continue;
        }
        if (PUNCT_CHARS.has(c)) {
            push('punct', i, i + 1);
            i++;
            continue;
        }
        if (OP_CHARS.has(c)) {
            let j = i + 1;
            while (j < n && OP_CHARS.has(src[j]) && !(src[j] === '-' && src[j + 1] === '-') && !(src[j] === '/' && src[j + 1] === '*')) j++;
            push('op', i, j);
            i = j;
            continue;
        }
        // Anything else is a single character the scanner has no use for.
        push('op', i, i + 1);
        i++;
    }
    return toks;
}

// ===== Helpers over token lists ================================================

export function isWord(t: Tok | undefined, value: string): boolean {
    return !!t && t.type === 'word' && t.value === value;
}

export function isPunct(t: Tok | undefined, text: string): boolean {
    return !!t && t.type === 'punct' && t.text === text;
}

/** Split `toks` at top-level tokens for which `isSep` holds (parentheses and brackets nest). */
export function splitTopLevel(toks: Tok[], isSep: (t: Tok) => boolean): Tok[][] {
    const parts: Tok[][] = [];
    let current: Tok[] = [];
    let depth = 0;
    for (const t of toks) {
        if (isPunct(t, '(') || isPunct(t, '[')) depth++;
        else if (isPunct(t, ')') || isPunct(t, ']')) depth--;
        if (depth === 0 && isSep(t)) {
            parts.push(current);
            current = [];
            continue;
        }
        current.push(t);
    }
    parts.push(current);
    return parts;
}

/** Index of the parenthesis closing the one at `open`, or -1. */
export function matchingParen(toks: Tok[], open: number): number {
    let depth = 0;
    for (let k = open; k < toks.length; k++) {
        if (isPunct(toks[k], '(')) depth++;
        else if (isPunct(toks[k], ')')) {
            depth--;
            if (depth === 0) return k;
        }
    }
    return -1;
}

export interface QualifiedName {
    parts: string[];
    first: Tok;
    last: Tok;
    /** Index of the token after the name. */
    next: number;
}

export function readQualifiedName(toks: Tok[], i: number): QualifiedName | null {
    const t = toks[i];
    if (!t || (t.type !== 'word' && t.type !== 'qident')) return null;
    const parts = [t.value];
    let last = t;
    let j = i + 1;
    while (isPunct(toks[j], '.') && toks[j + 1] && (toks[j + 1].type === 'word' || toks[j + 1].type === 'qident')) {
        last = toks[j + 1];
        parts.push(last.value);
        j += 2;
    }
    return { parts, first: t, last, next: j };
}

export function splitName(parts: string[]): { schema: string | null; name: string } {
    const name = parts[parts.length - 1];
    const schema = parts.length >= 2 ? parts[parts.length - 2] : null;
    return { schema, name };
}

// ===== Type names ==============================================================

/**
 * Spellings of a type mapped to the one `format_type` uses, so a function
 * declared as `f(int, varchar)` matches `f(integer, character varying)`.
 */
const TYPE_ALIASES: Record<string, string> = {
    int: 'integer',
    int4: 'integer',
    int2: 'smallint',
    int8: 'bigint',
    float4: 'real',
    float8: 'double precision',
    float: 'double precision',
    decimal: 'numeric',
    bool: 'boolean',
    varchar: 'character varying',
    'char varying': 'character varying',
    'national character varying': 'character varying',
    'national char varying': 'character varying',
    char: 'character',
    bpchar: 'character',
    'national character': 'character',
    'national char': 'character',
    nchar: 'character',
    timestamp: 'timestamp without time zone',
    timestamptz: 'timestamp with time zone',
    time: 'time without time zone',
    timetz: 'time with time zone',
    varbit: 'bit varying'
};

/** First words of multi-word type names, with the words that may follow them. */
const MULTIWORD_TYPE_STARTS: Record<string, string[]> = {
    double: ['precision'],
    character: ['varying'],
    char: ['varying'],
    bit: ['varying'],
    national: ['character', 'char'],
    timestamp: ['with', 'without'],
    time: ['with', 'without'],
    interval: ['year', 'month', 'day', 'hour', 'minute', 'second']
};

export function normalizeTypeTokens(toks: Tok[]): string {
    if (toks.length === 0) return '?';
    if (toks.some(t => t.type === 'op' && t.text.startsWith('%'))) return '?';
    let words: Array<{ value: string; quoted: boolean }> = [];
    let isArray = false;
    let floatPrecision: number | null = null;
    for (let k = 0; k < toks.length; k++) {
        const t = toks[k];
        if (isPunct(t, '.')) {
            // Drop the schema qualifier: only the last segment names the type.
            words = [];
            continue;
        }
        if (isPunct(t, '(')) {
            const close = matchingParen(toks, k);
            const inner = toks.slice(k + 1, close < 0 ? toks.length : close);
            if (inner.length === 1 && inner[0].type === 'number') floatPrecision = Number(inner[0].text);
            k = close < 0 ? toks.length : close;
            continue;
        }
        if (isPunct(t, '[')) {
            isArray = true;
            while (k < toks.length && !isPunct(toks[k], ']')) k++;
            continue;
        }
        if (isWord(t, 'array')) {
            isArray = true;
            continue;
        }
        if (t.type === 'word') words.push({ value: t.value, quoted: false });
        else if (t.type === 'qident') words.push({ value: t.value, quoted: true });
    }
    if (words.length === 0) return '?';
    let phrase = words.map(w => w.value).join(' ');
    if (words.length === 1 && words[0].quoted && phrase === 'char') {
        phrase = '"char"';
    } else if (words[0].value === 'interval' && !words[0].quoted) {
        phrase = 'interval';
    } else if ((phrase === 'float') && floatPrecision !== null && floatPrecision <= 24) {
        phrase = 'real';
    } else {
        phrase = TYPE_ALIASES[phrase] ?? phrase;
    }
    return isArray ? `${phrase}[]` : phrase;
}

/**
 * Normalise a type name for comparison: drop the schema qualifier, type
 * modifiers and array bounds, fold unquoted words and map aliases to the
 * spelling of `format_type` (`int4` → `integer`, `varchar(20)[]` →
 * `character varying[]`). Used for the repository and the database side alike.
 */
export function normalizeTypeName(typeText: string): string {
    return normalizeTypeTokens(tokenize(typeText));
}

/** The tokens of one argument without its name, e.g. `p_id integer` → `integer`. */
export function dropArgumentName(arg: Tok[]): Tok[] {
    if (arg.length <= 1) return arg;
    const [t0, t1] = arg;
    if (t1.type !== 'word' && t1.type !== 'qident') return arg;
    if (t1.type === 'word' && t1.value === 'array') return arg;
    if (t0.type === 'word' && t1.type === 'word' && MULTIWORD_TYPE_STARTS[t0.value]?.includes(t1.value)) return arg;
    return arg.slice(1);
}

const ARG_MODES = new Set(['in', 'out', 'inout', 'variadic']);

interface ParsedParam {
    param: RepoParam;
    /** The type tokens, for the identity type. */
    typeToks: Tok[];
}

/** The parameters of a parameter list (the tokens between the parentheses). */
function parseParams(toks: Tok[], ctx: ScanContext): ParsedParam[] {
    if (toks.length === 0) return [];
    const result: ParsedParam[] = [];
    for (const rawArg of splitTopLevel(toks, t => isPunct(t, ','))) {
        let arg = rawArg;
        let defaultToks: Tok[] = [];
        const cut = arg.findIndex((t, k) => isWord(t, 'default') || (t.type === 'op' && t.text === '=' && k > 0));
        if (cut >= 0) {
            defaultToks = arg.slice(cut + 1);
            arg = arg.slice(0, cut);
        }
        if (arg.length === 0) continue;
        let mode: RepoParam['mode'] = 'in';
        if (arg[0].type === 'word' && ARG_MODES.has(arg[0].value) && arg.length > 1) {
            mode = arg[0].value as RepoParam['mode'];
            arg = arg.slice(1);
        } else if (arg.length > 2 && arg[1].type === 'word' && ARG_MODES.has(arg[1].value)) {
            // PostgreSQL also takes the mode after the name: `p_id IN integer`.
            mode = arg[1].value as RepoParam['mode'];
            arg = [arg[0], ...arg.slice(2)];
        }
        const typeToks = dropArgumentName(arg);
        const named = typeToks !== arg;
        const first = named ? arg[0] : typeToks[0];
        const last = named ? arg[0] : typeToks[typeToks.length - 1];
        result.push({
            param: {
                name: named ? arg[0].value : null,
                mode,
                type: sourceOf(typeToks, ctx.text),
                defaultValue: defaultToks.length > 0 ? sourceOf(defaultToks, ctx.text) : null,
                start: ctx.toPosition(first.start),
                end: ctx.toPosition(last.end)
            },
            typeToks
        });
    }
    return result;
}

/** The source text of a run of tokens, with runs of white space folded. */
function sourceOf(toks: Tok[], text: string): string {
    if (toks.length === 0) return '';
    return text.slice(toks[0].start, toks[toks.length - 1].end).replace(/\s+/g, ' ');
}

/**
 * Identity argument types: OUT parameters are no part of the signature
 * pg_proc.proargtypes records, for functions as for procedures.
 */
function identityTypes(params: ParsedParam[]): string[] {
    return params.filter(p => p.param.mode !== 'out').map(p => normalizeTypeTokens(p.typeToks));
}

/** How many arguments a call may pass; CALL passes the OUT parameters of a procedure too. */
function argCountOf(params: RepoParam[], kind: RepoObjectKind): ArgCount {
    const passed = kind === 'procedure' ? params : params.filter(p => p.mode !== 'out');
    return {
        min: passed.filter(p => p.defaultValue === null).length,
        max: passed.some(p => p.mode === 'variadic') ? Infinity : passed.length
    };
}

/** Identity argument types of an aggregate from the parentheses after its name. */
function parseAggregateArguments(toks: Tok[], ctx: ScanContext): string[] | null {
    if (toks.length === 1 && toks[0].type === 'op' && toks[0].text === '*') return [];
    // The old syntax: CREATE AGGREGATE name (BASETYPE = type, SFUNC = …).
    const options = splitTopLevel(toks, t => isPunct(t, ','));
    const looksLikeOptions = options.some(o => o.length >= 2 && o[0].type === 'word' && o[1].type === 'op' && o[1].text === '=');
    if (looksLikeOptions) {
        const basetype = options.find(o => isWord(o[0], 'basetype'));
        if (!basetype) return null;
        const typeToks = basetype.slice(2);
        if (typeToks.length === 1 && typeToks[0].type === 'word' && typeToks[0].value === 'any') return [];
        if (typeToks.length === 1 && typeToks[0].type === 'string' && typeToks[0].value.toLowerCase() === 'any') return [];
        return [normalizeTypeTokens(typeToks)];
    }
    // Ordered-set aggregates: (direct args ORDER BY aggregated args).
    const orderAt = toks.findIndex((t, k) => isWord(t, 'order') && isWord(toks[k + 1], 'by'));
    if (orderAt >= 0) {
        return [
            ...identityTypes(parseParams(toks.slice(0, orderAt), ctx)),
            ...identityTypes(parseParams(toks.slice(orderAt + 2), ctx))
        ];
    }
    return identityTypes(parseParams(toks, ctx));
}

/** Words that end the RETURNS clause of a routine. */
const ROUTINE_OPTION_WORDS = new Set([
    'language', 'as', 'immutable', 'stable', 'volatile', 'strict', 'called', 'security', 'external', 'parallel',
    'cost', 'rows', 'set', 'window', 'leakproof', 'not', 'support', 'transform', 'begin', 'return', 'returns'
]);

/** RETURNS text and body of a routine, from the tokens after its parameter list. */
function routineTail(toks: Tok[], from: number, text: string): { returns?: string; body?: string } {
    const result: { returns?: string; body?: string } = {};
    let depth = 0;
    for (let k = from; k < toks.length; k++) {
        const t = toks[k];
        if (isPunct(t, '(')) depth++;
        else if (isPunct(t, ')')) depth--;
        if (depth !== 0) continue;
        if (isWord(t, 'returns') && result.returns === undefined && !isWord(toks[k + 1], 'null')) {
            let end = k + 1;
            let inner = 0;
            while (end < toks.length) {
                const u = toks[end];
                if (isPunct(u, '(')) inner++;
                else if (isPunct(u, ')')) inner--;
                if (inner === 0 && u.type === 'word' && ROUTINE_OPTION_WORDS.has(u.value) && end > k + 1) break;
                end++;
            }
            result.returns = sourceOf(toks.slice(k + 1, end), text);
            k = end - 1;
        } else if (isWord(t, 'as') && result.body === undefined) {
            const first = toks[k + 1];
            // `AS 'obj_file', 'link_symbol'`: prosrc holds the link symbol.
            const bodyTok = first?.type === 'string' && isPunct(toks[k + 2], ',') && toks[k + 3]?.type === 'string' ? toks[k + 3] : first;
            if (bodyTok?.type === 'dollar') result.body = dollarContent(bodyTok.text) ?? undefined;
            else if (bodyTok?.type === 'string') result.body = bodyTok.value;
        }
    }
    return result;
}

/** The text between the tags of a dollar-quoted string; null when it is not terminated. */
export function dollarContent(text: string): string | null {
    const tag = /^\$[^$]*\$/.exec(text)?.[0];
    if (!tag || text.length < tag.length * 2 || !text.endsWith(tag)) return null;
    return text.slice(tag.length, text.length - tag.length);
}

// ===== Statements ==============================================================

const KIND_WORDS: Record<string, RepoObjectKind> = {
    function: 'function',
    procedure: 'procedure',
    aggregate: 'aggregate',
    type: 'type',
    domain: 'domain',
    sequence: 'sequence',
    trigger: 'trigger',
    extension: 'extension',
    schema: 'schema',
    table: 'table',
    view: 'view'
};

const CREATE_MODIFIERS = new Set(['temp', 'temporary', 'global', 'local', 'unlogged', 'recursive', 'constraint', 'materialized', 'foreign', 'trusted', 'procedural']);

/** Schemas named by a search_path value, without the entries that never take new objects. */
function searchPathEntries(values: string[]): string[] {
    return values
        .map(v => v.trim())
        .map(v => (v.startsWith('"') && v.endsWith('"') && v.length >= 2 ? v.slice(1, -1).replace(/""/g, '"') : v.toLowerCase()))
        .filter(v => v.length > 0 && v !== '$user' && v !== 'pg_catalog' && v !== 'pg_temp');
}

/** The search_path a `SET search_path …` or `set_config('search_path', …)` statement sets; undefined when it is none. */
export function searchPathOf(stmt: Tok[]): string[] | null | undefined {
    if (isWord(stmt[0], 'set')) {
        let k = 1;
        if (isWord(stmt[k], 'session') || isWord(stmt[k], 'local')) k++;
        if (!isWord(stmt[k], 'search_path')) return undefined;
        k++;
        if (isWord(stmt[k], 'to') || (stmt[k]?.type === 'op' && stmt[k].text === '=')) k++;
        if (isWord(stmt[k], 'default')) return null;
        const values = splitTopLevel(stmt.slice(k), t => isPunct(t, ','))
            .filter(part => part.length > 0)
            .map(part => (part[0].type === 'string' ? part[0].value : part[0].type === 'qident' ? `"${part[0].value}"` : part[0].value));
        return searchPathEntries(values.flatMap(v => (v.startsWith('"') ? [v] : v.split(','))));
    }
    const call = stmt.findIndex(t => isWord(t, 'set_config'));
    if (call >= 0 && isPunct(stmt[call + 1], '(') && stmt[call + 2]?.type === 'string'
        && stmt[call + 2].value.toLowerCase() === 'search_path' && isPunct(stmt[call + 3], ',')
        && stmt[call + 4]?.type === 'string') {
        return searchPathEntries(stmt[call + 4].value.split(','));
    }
    return undefined;
}

interface ScanContext {
    searchPath: string[] | null;
    /** The text the token offsets refer to (the inner text of a DO block). */
    text: string;
    comments: SqlComment[];
    toPosition(offset: number): SourcePosition;
    /** The doc comment of the enclosing statement (a DO block), for statements without one of their own. */
    outerDoc?: RepoDoc;
}

/**
 * The doc comment right before `offset`: the last `/** … *\/` block with only
 * white space up to it, else the `--` lines directly above.
 */
function docBefore(offset: number, ctx: ScanContext): RepoDoc | undefined {
    const { comments, text } = ctx;
    let lo = 0;
    let hi = comments.length - 1;
    let at = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (comments[mid].end <= offset) {
            at = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    if (at < 0) return undefined;
    const last = comments[at];
    const gap = text.slice(last.end, offset);
    if (!/^\s*$/.test(gap)) return undefined;
    if (last.block) {
        if (!last.text.startsWith('/**') || last.text.startsWith('/**/')) return undefined;
        return { text: last.text, block: true, start: ctx.toPosition(last.start), end: ctx.toPosition(last.end) };
    }
    // `--` lines: directly above (at most one line break), each on its own line.
    if ((gap.match(/\n/g) ?? []).length > 1) return undefined;
    let first = at;
    while (first > 0) {
        const prev = comments[first - 1];
        const between = text.slice(prev.end, comments[first].start);
        if (prev.block || !/^[ \t\r]*\n[ \t]*$/.test(between)) break;
        first--;
    }
    const lineStart = text.lastIndexOf('\n', comments[first].start - 1) + 1;
    if (!/^[ \t]*$/.test(text.slice(lineStart, comments[first].start))) return undefined;
    const lines = comments.slice(first, at + 1).map(c => c.text);
    return { text: lines.join('\n'), block: false, start: ctx.toPosition(comments[first].start), end: ctx.toPosition(last.end) };
}

/** The definition a CREATE statement makes (`toks[0]` is the CREATE). */
function parseCreate(toks: Tok[], ctx: ScanContext, schemaOverride: string | null, out: RepoDefinition[]): void {
    let j = 1;
    if (isWord(toks[j], 'or') && isWord(toks[j + 1], 'replace')) j += 2;
    let temporary = false;
    let materialized = false;
    let foreign = false;
    while (toks[j]?.type === 'word' && CREATE_MODIFIERS.has(toks[j].value)) {
        const v = toks[j].value;
        if (v === 'temp' || v === 'temporary') temporary = true;
        if (v === 'materialized') materialized = true;
        if (v === 'foreign') foreign = true;
        j++;
    }
    const kindWord = toks[j]?.type === 'word' ? toks[j].value : '';
    let kind = KIND_WORDS[kindWord];
    if (!kind || temporary) return;
    if (kind === 'table' && foreign) kind = 'foreign';
    if (kind === 'view' && materialized) kind = 'matview';
    if ((kind !== 'table' && kind !== 'foreign') && foreign) return;
    j++;
    if (isWord(toks[j], 'if') && isWord(toks[j + 1], 'not') && isWord(toks[j + 2], 'exists')) j += 3;
    // CREATE SCHEMA AUTHORIZATION role names the schema after the role.
    if (kind === 'schema' && isWord(toks[j], 'authorization')) j++;

    const qname = readQualifiedName(toks, j);
    if (!qname) return;
    const { schema: writtenSchema, name } = splitName(qname.parts);
    const schema = kind === 'schema' || kind === 'extension' ? null : writtenSchema ?? schemaOverride;
    const def: RepoDefinition = {
        kind,
        schema,
        name,
        argTypes: null,
        searchPath: ctx.searchPath,
        start: ctx.toPosition(qname.first.start),
        end: ctx.toPosition(qname.last.end),
        statementStart: ctx.toPosition(toks[0].start),
        statementEnd: ctx.toPosition(toks[toks.length - 1].end)
    };
    const doc = docBefore(toks[0].start, ctx) ?? ctx.outerDoc;
    if (doc) def.doc = doc;
    let k = qname.next;

    if (kind === 'function' || kind === 'procedure' || kind === 'aggregate') {
        if (!isPunct(toks[k], '(')) return;
        const close = matchingParen(toks, k);
        if (close < 0) return;
        const inner = toks.slice(k + 1, close);
        if (kind === 'aggregate') {
            def.argTypes = parseAggregateArguments(inner, ctx);
            if (def.argTypes) def.argCount = { min: def.argTypes.length, max: def.argTypes.length };
        } else {
            const params = parseParams(inner, ctx);
            def.argTypes = identityTypes(params);
            def.params = params.map(p => p.param);
            def.argCount = argCountOf(def.params, kind);
            const tail = routineTail(toks, close + 1, ctx.text);
            if (tail.returns !== undefined && kind === 'function') def.returns = tail.returns;
            if (tail.body !== undefined) {
                def.bodyHash = routineBodyHash(tail.body);
                def.tokenHash = routineTokenHash(tail.body);
            }
        }
    } else if (kind === 'trigger') {
        let depth = 0;
        for (; k < toks.length; k++) {
            if (isPunct(toks[k], '(')) depth++;
            else if (isPunct(toks[k], ')')) depth--;
            else if (depth === 0 && isWord(toks[k], 'on')) break;
        }
        const table = readQualifiedName(toks, k + 1);
        if (!table) return;
        const t = splitName(table.parts);
        def.table = { schema: t.schema ?? schemaOverride, name: t.name };
        def.schema = null;
    }
    out.push(def);

    // CREATE SCHEMA s CREATE TABLE … CREATE VIEW …: the elements belong to s.
    if (kind === 'schema') {
        const starts: number[] = [];
        let depth = 0;
        for (let m = k; m < toks.length; m++) {
            if (isPunct(toks[m], '(')) depth++;
            else if (isPunct(toks[m], ')')) depth--;
            else if (depth === 0 && isWord(toks[m], 'create')) starts.push(m);
        }
        starts.forEach((s, idx) => parseCreate(toks.slice(s, starts[idx + 1] ?? toks.length), ctx, name, out));
    }
}

function lineStarts(text: string): number[] {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') starts.push(i + 1);
    }
    return starts;
}

/** Maps offsets of a text to line and character. */
export function positionMapper(text: string): (offset: number) => SourcePosition {
    const starts = lineStarts(text);
    return (offset: number): SourcePosition => {
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= offset) lo = mid;
            else hi = mid - 1;
        }
        return { line: lo, character: offset - starts[lo] };
    };
}

/**
 * The CREATE statements in the body of a DO block. Unlike a function body, a
 * DO block runs when the file is deployed, so `BEGIN CREATE TYPE …; EXCEPTION
 * WHEN duplicate_object THEN NULL; END` defines the type. A CREATE inside an
 * `EXECUTE '…'` string is still a string and does not count.
 */
function scanDoBlock(stmt: Tok[], ctx: ScanContext, out: RepoDefinition[]): void {
    const body = stmt.find(t => t.type === 'dollar');
    if (!body) return;
    const content = dollarContent(body.text);
    if (content === null) return;
    const base = body.start + (body.text.length - content.length) / 2;
    const comments: SqlComment[] = [];
    const toks = tokenize(content, comments);
    const inner: ScanContext = {
        searchPath: ctx.searchPath,
        text: content,
        comments,
        toPosition: (offset) => ctx.toPosition(base + offset),
        outerDoc: docBefore(stmt[0].start, ctx)
    };
    for (const part of splitTopLevel(toks, t => isPunct(t, ';'))) {
        // The CREATE can follow BEGIN, THEN or ELSE within the same statement.
        const at = part.findIndex(t => isWord(t, 'create'));
        if (at >= 0) parseCreate(part.slice(at), inner, null, out);
    }
}

/**
 * Every CREATE statement of a database object in `text`, in source order.
 * Temporary objects and objects the navigator does not show (indexes, roles,
 * languages, …) are left out.
 */
export function scanSqlText(text: string): RepoDefinition[] {
    const comments: SqlComment[] = [];
    const toks = tokenize(text, comments);
    const ctx: ScanContext = { searchPath: null, text, comments, toPosition: positionMapper(text) };
    const out: RepoDefinition[] = [];
    for (const stmt of splitTopLevel(toks, t => isPunct(t, ';'))) {
        if (stmt.length === 0) continue;
        const searchPath = searchPathOf(stmt);
        if (searchPath !== undefined) {
            ctx.searchPath = searchPath;
            continue;
        }
        if (isWord(stmt[0], 'create')) parseCreate(stmt, ctx, null, out);
        else if (isWord(stmt[0], 'do')) scanDoBlock(stmt, ctx, out);
    }
    return out;
}
