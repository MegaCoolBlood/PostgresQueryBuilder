/**
 * Finds the CREATE statements of database objects in SQL source text, so the
 * Objects and Tables views can compare the database with the repository.
 *
 * Pure: no `vscode`, no I/O. A single linear pass tokenizes the text and skips
 * comments, string literals and dollar-quoted bodies, so a `CREATE` inside a
 * function body or an `EXECUTE '…'` string is never mistaken for a definition.
 * The body of a DO block is the exception: it runs when the file is deployed.
 */

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
}

// ===== Tokenizer ===============================================================

type TokType = 'word' | 'qident' | 'string' | 'dollar' | 'number' | 'punct' | 'op';

interface Tok {
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

function tokenize(src: string): Tok[] {
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
            i = nl < 0 ? n : nl + 1;
            continue;
        }
        if (c === '/' && c2 === '*') {
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

function isWord(t: Tok | undefined, value: string): boolean {
    return !!t && t.type === 'word' && t.value === value;
}

function isPunct(t: Tok | undefined, text: string): boolean {
    return !!t && t.type === 'punct' && t.text === text;
}

/** Split `toks` at top-level tokens for which `isSep` holds (parentheses and brackets nest). */
function splitTopLevel(toks: Tok[], isSep: (t: Tok) => boolean): Tok[][] {
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
function matchingParen(toks: Tok[], open: number): number {
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

interface QualifiedName {
    parts: string[];
    first: Tok;
    last: Tok;
    /** Index of the token after the name. */
    next: number;
}

function readQualifiedName(toks: Tok[], i: number): QualifiedName | null {
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

function splitName(parts: string[]): { schema: string | null; name: string } {
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

function normalizeTypeTokens(toks: Tok[]): string {
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
function dropArgumentName(arg: Tok[]): Tok[] {
    if (arg.length <= 1) return arg;
    const [t0, t1] = arg;
    if (t1.type !== 'word' && t1.type !== 'qident') return arg;
    if (t1.type === 'word' && t1.value === 'array') return arg;
    if (t0.type === 'word' && t1.type === 'word' && MULTIWORD_TYPE_STARTS[t0.value]?.includes(t1.value)) return arg;
    return arg.slice(1);
}

const ARG_MODES = new Set(['in', 'out', 'inout', 'variadic']);

/** Identity argument types of a parameter list (the tokens between the parentheses). */
function parseRoutineArguments(toks: Tok[]): string[] {
    if (toks.length === 0) return [];
    const result: string[] = [];
    for (const rawArg of splitTopLevel(toks, t => isPunct(t, ','))) {
        let arg = rawArg;
        const cut = arg.findIndex((t, k) => isWord(t, 'default') || (t.type === 'op' && t.text === '=' && k > 0));
        if (cut >= 0) arg = arg.slice(0, cut);
        if (arg.length === 0) continue;
        let mode = 'in';
        if (arg[0].type === 'word' && ARG_MODES.has(arg[0].value) && arg.length > 1) {
            mode = arg[0].value;
            arg = arg.slice(1);
        } else if (arg.length > 2 && arg[1].type === 'word' && ARG_MODES.has(arg[1].value)) {
            // PostgreSQL also takes the mode after the name: `p_id IN integer`.
            mode = arg[1].value;
            arg = [arg[0], ...arg.slice(2)];
        }
        // OUT parameters are no part of the signature pg_proc.proargtypes records,
        // for functions as for procedures.
        if (mode === 'out') continue;
        result.push(normalizeTypeTokens(dropArgumentName(arg)));
    }
    return result;
}

/** Identity argument types of an aggregate from the parentheses after its name. */
function parseAggregateArguments(toks: Tok[]): string[] | null {
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
            ...parseRoutineArguments(toks.slice(0, orderAt)),
            ...parseRoutineArguments(toks.slice(orderAt + 2))
        ];
    }
    return parseRoutineArguments(toks);
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
function searchPathOf(stmt: Tok[]): string[] | null | undefined {
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
    toPosition(offset: number): SourcePosition;
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
        end: ctx.toPosition(qname.last.end)
    };
    let k = qname.next;

    if (kind === 'function' || kind === 'procedure' || kind === 'aggregate') {
        if (!isPunct(toks[k], '(')) return;
        const close = matchingParen(toks, k);
        if (close < 0) return;
        const inner = toks.slice(k + 1, close);
        def.argTypes = kind === 'aggregate' ? parseAggregateArguments(inner) : parseRoutineArguments(inner);
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

/**
 * The CREATE statements in the body of a DO block. Unlike a function body, a
 * DO block runs when the file is deployed, so `BEGIN CREATE TYPE …; EXCEPTION
 * WHEN duplicate_object THEN NULL; END` defines the type. A CREATE inside an
 * `EXECUTE '…'` string is still a string and does not count.
 */
function scanDoBlock(stmt: Tok[], ctx: ScanContext, out: RepoDefinition[]): void {
    const body = stmt.find(t => t.type === 'dollar');
    if (!body) return;
    const tag = /^\$[^$]*\$/.exec(body.text)?.[0];
    if (!tag || body.text.length < tag.length * 2 || !body.text.endsWith(tag)) return;
    const base = body.start + tag.length;
    const inner: ScanContext = { searchPath: ctx.searchPath, toPosition: (offset) => ctx.toPosition(base + offset) };
    const toks = tokenize(body.text.slice(tag.length, body.text.length - tag.length));
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
    const starts = lineStarts(text);
    const ctx: ScanContext = {
        searchPath: null,
        toPosition(offset: number): SourcePosition {
            let lo = 0;
            let hi = starts.length - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (starts[mid] <= offset) lo = mid;
                else hi = mid - 1;
            }
            return { line: lo, character: offset - starts[lo] };
        }
    };
    const out: RepoDefinition[] = [];
    for (const stmt of splitTopLevel(tokenize(text), t => isPunct(t, ';'))) {
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
