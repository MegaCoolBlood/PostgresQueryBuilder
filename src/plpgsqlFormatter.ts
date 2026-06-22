/**
 * Configurable PL/pgSQL / SQL formatter.
 *
 * This module is intentionally free of any `vscode` dependency so it can be
 * unit-tested with plain `node --test`. The VS Code integration (settings,
 * formatting provider, command) lives in `extension.ts`.
 *
 * Design / guarantees:
 *  - The output is a re-spacing and re-casing of the original tokens. Tokens
 *    (identifiers, literals, comments, operators) are never dropped or altered
 *    beyond optional case changes on keywords / identifiers / data types, so the
 *    formatter cannot silently corrupt a statement.
 *  - String literals, dollar-quoted literals and comments are preserved
 *    verbatim. A dollar-quoted body that looks like PL/pgSQL code
 *    (contains BEGIN / DECLARE) is formatted recursively.
 *  - Blank lines authored by the user are preserved (paragraph breaks).
 */

export type CaseStyle = 'upper' | 'lower' | 'preserve';
export type IndentStyle = 'space' | 'tab';
export type CommaStyle = 'trailing' | 'leading';
export type BlankLineStyle = 'preserve' | 'collapse';

export interface FormatOptions {
    /** Case for SQL/PL keywords (SELECT, BEGIN, IF, ...). Default: 'upper'. */
    keywordCase: CaseStyle;
    /** Case for identifiers (table/column/variable names). Default: 'preserve'. */
    identifierCase: CaseStyle;
    /** Case for data type names (integer, varchar, ...). Default: 'upper'. */
    dataTypeCase: CaseStyle;
    /** Indentation character. Default: 'space'. */
    indentStyle: IndentStyle;
    /** Number of spaces per indent level (ignored for tabs). Default: 2. */
    indentSize: number;
    /** Comma placement in broken column lists. Default: 'trailing'. */
    commaStyle: CommaStyle;
    /** How to handle authored blank lines. Default: 'preserve' (keep 1:1). */
    blankLines: BlankLineStyle;
    /** Keep a simple SELECT (1 column, <=1 table, <=1 WHERE) on one line. Default: true. */
    simpleSelectSingleLine: boolean;
    /** Argument/parameter count up to which a call/parameter list stays inline. Default: 1. */
    argsInlineMax: number;
    /** Argument/parameter count from which a call/parameter list always wraps. Default: 4. */
    argsMultilineMin: number;
    /** Replace verbose type phrases with their short form (character varying -> varchar). Default: true. */
    normalizeDataTypes: boolean;
}

export const DEFAULT_FORMAT_OPTIONS: FormatOptions = {
    keywordCase: 'upper',
    identifierCase: 'preserve',
    dataTypeCase: 'upper',
    indentStyle: 'space',
    indentSize: 2,
    commaStyle: 'trailing',
    blankLines: 'preserve',
    simpleSelectSingleLine: true,
    argsInlineMax: 1,
    argsMultilineMin: 4,
    normalizeDataTypes: true
};

/**
 * Build a validated {@link FormatOptions} from arbitrary (e.g. configuration)
 * values, falling back to {@link DEFAULT_FORMAT_OPTIONS} for anything missing or
 * invalid. Pure (no `vscode` dependency) so callers can read settings and pass
 * the plain values in.
 */
export function coerceFormatOptions(raw: {
    keywordCase?: unknown;
    identifierCase?: unknown;
    dataTypeCase?: unknown;
    indentStyle?: unknown;
    indentSize?: unknown;
    commaStyle?: unknown;
    blankLines?: unknown;
    simpleSelectSingleLine?: unknown;
    argsInlineMax?: unknown;
    argsMultilineMin?: unknown;
    normalizeDataTypes?: unknown;
}): FormatOptions {
    const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
        typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
    const num = (value: unknown, min: number, max: number, fallback: number): number =>
        typeof value === 'number' && value >= min && value <= max ? Math.floor(value) : fallback;
    const size = num(raw.indentSize, 1, 8, DEFAULT_FORMAT_OPTIONS.indentSize);
    const inlineMax = num(raw.argsInlineMax, 0, 50, DEFAULT_FORMAT_OPTIONS.argsInlineMax);
    let multilineMin = num(raw.argsMultilineMin, 2, 100, DEFAULT_FORMAT_OPTIONS.argsMultilineMin);
    if (multilineMin <= inlineMax) multilineMin = inlineMax + 1;
    return {
        keywordCase: pick(raw.keywordCase, ['upper', 'lower', 'preserve'], DEFAULT_FORMAT_OPTIONS.keywordCase),
        identifierCase: pick(raw.identifierCase, ['upper', 'lower', 'preserve'], DEFAULT_FORMAT_OPTIONS.identifierCase),
        dataTypeCase: pick(raw.dataTypeCase, ['upper', 'lower', 'preserve'], DEFAULT_FORMAT_OPTIONS.dataTypeCase),
        indentStyle: pick(raw.indentStyle, ['space', 'tab'], DEFAULT_FORMAT_OPTIONS.indentStyle),
        indentSize: size,
        commaStyle: pick(raw.commaStyle, ['trailing', 'leading'], DEFAULT_FORMAT_OPTIONS.commaStyle),
        blankLines: pick(raw.blankLines, ['preserve', 'collapse'], DEFAULT_FORMAT_OPTIONS.blankLines),
        simpleSelectSingleLine: typeof raw.simpleSelectSingleLine === 'boolean'
            ? raw.simpleSelectSingleLine
            : DEFAULT_FORMAT_OPTIONS.simpleSelectSingleLine,
        argsInlineMax: inlineMax,
        argsMultilineMin: multilineMin,
        normalizeDataTypes: typeof raw.normalizeDataTypes === 'boolean'
            ? raw.normalizeDataTypes
            : DEFAULT_FORMAT_OPTIONS.normalizeDataTypes
    };
}

/** SQL / PL keywords that are case-normalised with `keywordCase`. */
const KEYWORDS = new Set([
    'select', 'from', 'where', 'and', 'or', 'not', 'null', 'true', 'false',
    'join', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'natural',
    'lateral', 'on', 'using', 'group', 'by', 'having', 'order', 'asc', 'desc',
    'nulls', 'first', 'last', 'limit', 'offset', 'fetch', 'next', 'row', 'rows',
    'only', 'union', 'all', 'intersect', 'except', 'as', 'distinct',
    'case', 'when', 'then', 'else', 'end', 'in', 'is', 'like', 'ilike',
    'similar', 'to', 'between', 'exists', 'any', 'some',
    'with', 'recursive', 'into', 'strict', 'values', 'returning',
    'insert', 'update', 'delete', 'set', 'for', 'of', 'nowait', 'share',
    'at', 'time', 'zone', 'local', 'collate', 'over', 'partition', 'window',
    'filter', 'within', 'cast', 'default', 'check', 'constraint', 'primary',
    'key', 'foreign', 'references', 'unique', 'create', 'or', 'replace',
    'table', 'view', 'materialized', 'index', 'sequence', 'schema',
    'function', 'procedure', 'trigger', 'returns', 'language', 'declare',
    'begin', 'end', 'if', 'elsif', 'elseif', 'loop', 'while', 'foreach',
    'exit', 'continue', 'return', 'query', 'raise', 'notice', 'warning',
    'exception', 'others', 'perform', 'execute', 'get', 'diagnostics',
    'found', 'call', 'do', 'assert', 'alter', 'drop', 'add', 'column',
    'rename', 'owner', 'grant', 'revoke', 'truncate', 'comment', 'analyze',
    'vacuum', 'copy', 'explain', 'refresh', 'temporary', 'temp', 'unlogged',
    'immutable', 'stable', 'volatile', 'security', 'definer', 'invoker',
    'cursor', 'open', 'close', 'move', 'array', 'cascade', 'restrict',
    'new', 'old', 'before', 'after', 'instead', 'each', 'statement',
    'leakproof', 'parallel', 'cost', 'support', 'called', 'external',
    'setof', 'inout', 'out', 'variadic', 'using', 'errcode'
]);

/** Routine characteristic keywords that each start their own line in a CREATE header. */
const ROUTINE_CHARACTERISTICS = new Set([
    'language', 'stable', 'immutable', 'volatile', 'strict', 'leakproof',
    'security', 'cost', 'rows', 'parallel', 'support', 'window', 'set',
    'transform', 'called', 'external'
]);

/** Data type names that are case-normalised with `dataTypeCase`. */
const DATATYPES = new Set([
    'int', 'int2', 'int4', 'int8', 'integer', 'bigint', 'smallint',
    'serial', 'bigserial', 'smallserial', 'numeric', 'decimal', 'real',
    'double', 'precision', 'float', 'float4', 'float8', 'money',
    'bool', 'boolean', 'char', 'character', 'varchar', 'varying', 'text',
    'citext', 'bytea', 'date', 'time', 'timestamp', 'timestamptz', 'timetz',
    'interval', 'uuid', 'json', 'jsonb', 'xml', 'bit', 'varbit', 'cidr',
    'inet', 'macaddr', 'point', 'line', 'lseg', 'box', 'path', 'polygon',
    'circle', 'tsvector', 'tsquery', 'name', 'regclass', 'oid', 'void',
    'record', 'anyelement', 'anyarray', 'trigger'
]);

/**
 * Verbose multi-word type phrases mapped to a canonical short form, applied when
 * `normalizeDataTypes` is enabled. Listed longest-first so the longest phrase wins.
 */
const TYPE_PHRASE_ALIASES: { words: string[]; canonical: string }[] = [
    { words: ['timestamp', 'without', 'time', 'zone'], canonical: 'timestamp' },
    { words: ['timestamp', 'with', 'time', 'zone'], canonical: 'timestamptz' },
    { words: ['time', 'without', 'time', 'zone'], canonical: 'time' },
    { words: ['time', 'with', 'time', 'zone'], canonical: 'timetz' },
    { words: ['character', 'varying'], canonical: 'varchar' },
    { words: ['bit', 'varying'], canonical: 'varbit' }
];

/** Merge verbose multi-word type phrases (e.g. `character varying`) into a single short-form token. */
function normalizeTypePhrases(toks: Tok[]): Tok[] {
    const out: Tok[] = [];
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        let matched = false;
        if (t.type === 'word') {
            for (const { words, canonical } of TYPE_PHRASE_ALIASES) {
                if (i + words.length > toks.length) continue;
                let ok = true;
                for (let k = 0; k < words.length; k++) {
                    const tk = toks[i + k];
                    if (tk.type !== 'word' || tk.text.toLowerCase() !== words[k]) { ok = false; break; }
                }
                if (ok) {
                    out.push({ type: 'word', text: canonical, nlBefore: t.nlBefore });
                    i += words.length - 1;
                    matched = true;
                    break;
                }
            }
        }
        if (!matched) out.push(t);
    }
    return out;
}

/** Clause keywords that start a fresh line within a SQL statement. */
const CLAUSE_NEWLINE = new Set([
    'select', 'from', 'where', 'group', 'order', 'having', 'limit', 'offset',
    'fetch', 'window', 'returning', 'values', 'union', 'intersect', 'except',
    'with', 'set'
]);

/** Disqualifies a SELECT from being kept on a single line. */
const SIMPLE_SELECT_BREAKERS = new Set([
    'group', 'having', 'order', 'limit', 'offset', 'fetch', 'window',
    'union', 'intersect', 'except', 'distinct', 'and', 'or', 'into',
    'join', 'inner', 'left', 'right', 'full', 'cross', 'natural'
]);

/** Words that introduce a JOIN and therefore begin a new line. */
const JOIN_WORDS = new Set(['join', 'inner', 'left', 'right', 'full', 'cross', 'natural']);

type TokType =
    | 'word' | 'quotedIdent' | 'string' | 'dollar' | 'number'
    | 'param' | 'lineComment' | 'blockComment' | 'punct' | 'operator';

interface Tok {
    type: TokType;
    text: string;
    /** Count of newline characters in the whitespace preceding this token. */
    nlBefore: number;
}

interface TokMeta {
    text: string;
    isKeyword: boolean;
    type: TokType | 'comment';
}

const OP_CHARS = new Set(['=', '<', '>', '!', '+', '-', '*', '/', '%', '|', '~', '@', '#', '&', '^', ':']);

/** Break `input` into a flat token list, preserving literals and comments. */
function tokenize(input: string): Tok[] {
    const toks: Tok[] = [];
    const n = input.length;
    let i = 0;
    let nl = 0;
    while (i < n) {
        const c = input[i];
        const c2 = input[i + 1];
        // Whitespace (count newlines for blank-line preservation)
        if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
            if (c === '\n') nl++;
            i++;
            continue;
        }
        // Line comment
        if (c === '-' && c2 === '-') {
            let j = i + 2;
            while (j < n && input[j] !== '\n') j++;
            toks.push({ type: 'lineComment', text: input.slice(i, j).replace(/\s+$/, ''), nlBefore: nl });
            nl = 0; i = j; continue;
        }
        // Block comment (nesting allowed)
        if (c === '/' && c2 === '*') {
            let j = i + 2;
            let depth = 1;
            while (j < n && depth > 0) {
                if (input[j] === '/' && input[j + 1] === '*') { depth++; j += 2; }
                else if (input[j] === '*' && input[j + 1] === '/') { depth--; j += 2; }
                else j++;
            }
            toks.push({ type: 'blockComment', text: input.slice(i, j), nlBefore: nl });
            nl = 0; i = j; continue;
        }
        // Single-quoted string
        if (c === "'") {
            let j = i + 1;
            while (j < n) {
                if (input[j] === '\\') { j += 2; continue; }
                if (input[j] === "'") {
                    if (input[j + 1] === "'") { j += 2; continue; }
                    j++; break;
                }
                j++;
            }
            toks.push({ type: 'string', text: input.slice(i, j), nlBefore: nl });
            nl = 0; i = j; continue;
        }
        // Quoted identifier
        if (c === '"') {
            let j = i + 1;
            while (j < n) {
                if (input[j] === '"') {
                    if (input[j + 1] === '"') { j += 2; continue; }
                    j++; break;
                }
                j++;
            }
            toks.push({ type: 'quotedIdent', text: input.slice(i, j), nlBefore: nl });
            nl = 0; i = j; continue;
        }
        // Dollar: positional parameter ($1) or dollar-quoted string ($tag$...$tag$)
        if (c === '$') {
            if (/\d/.test(c2 || '')) {
                let j = i + 1;
                while (j < n && /\d/.test(input[j])) j++;
                toks.push({ type: 'param', text: input.slice(i, j), nlBefore: nl });
                nl = 0; i = j; continue;
            }
            const tagMatch = /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/.exec(input.slice(i));
            if (tagMatch) {
                const tag = tagMatch[0];
                const close = input.indexOf(tag, i + tag.length);
                const j = close === -1 ? n : close + tag.length;
                toks.push({ type: 'dollar', text: input.slice(i, j), nlBefore: nl });
                nl = 0; i = j; continue;
            }
        }
        // Number
        if (/\d/.test(c)) {
            let j = i + 1;
            while (j < n && /[0-9_]/.test(input[j])) j++;
            if (input[j] === '.' && /\d/.test(input[j + 1] || '')) {
                j++;
                while (j < n && /[0-9_]/.test(input[j])) j++;
            }
            if (input[j] === 'e' || input[j] === 'E') {
                let k = j + 1;
                if (input[k] === '+' || input[k] === '-') k++;
                if (/\d/.test(input[k] || '')) {
                    k++;
                    while (k < n && /\d/.test(input[k])) k++;
                    j = k;
                }
            }
            toks.push({ type: 'number', text: input.slice(i, j), nlBefore: nl });
            nl = 0; i = j; continue;
        }
        // Identifier / keyword
        if (/[A-Za-z_\u0080-\uffff]/.test(c)) {
            let j = i + 1;
            while (j < n && /[A-Za-z0-9_$\u0080-\uffff]/.test(input[j])) j++;
            toks.push({ type: 'word', text: input.slice(i, j), nlBefore: nl });
            nl = 0; i = j; continue;
        }
        // Parentheses / structural punctuation
        if (c === '(' || c === ')' || c === ',' || c === ';' || c === '.' || c === '[' || c === ']') {
            toks.push({ type: 'punct', text: c, nlBefore: nl });
            nl = 0; i++; continue;
        }
        // Operator run
        if (OP_CHARS.has(c)) {
            let j = i + 1;
            while (j < n && OP_CHARS.has(input[j])) j++;
            toks.push({ type: 'operator', text: input.slice(i, j), nlBefore: nl });
            nl = 0; i = j; continue;
        }
        // Anything else: emit as a single punct token so nothing is lost
        toks.push({ type: 'punct', text: c, nlBefore: nl });
        nl = 0; i++;
    }
    return toks;
}

/** Parenthesis depth for each token (a `)` reports the post-close depth). */
function computeDepths(toks: Tok[]): number[] {
    const out: number[] = [];
    let depth = 0;
    for (const t of toks) {
        if (t.text === ')') { depth = Math.max(0, depth - 1); out.push(depth); }
        else { out.push(depth); if (t.text === '(') depth++; }
    }
    return out;
}

function applyCase(text: string, style: CaseStyle): string {
    if (style === 'upper') return text.toUpperCase();
    if (style === 'lower') return text.toLowerCase();
    return text;
}

type ParenKind = 'subquery' | 'paramlist' | 'call' | 'group' | 'typemod';
interface ParenInfo { match: number; kind: ParenKind; argCount: number; multiline: boolean; }
interface BlockFrame { type: 'declare' | 'begin' | 'if' | 'loop' | 'case'; head: number; exception?: boolean; }

/**
 * Format a PL/pgSQL / SQL string according to `options`.
 */
export function formatSql(input: string, options?: Partial<FormatOptions>): string {
    const opt: FormatOptions = { ...DEFAULT_FORMAT_OPTIONS, ...(options || {}) };
    const trailingNewline = /\n\s*$/.test(input);
    const toks = opt.normalizeDataTypes ? normalizeTypePhrases(tokenize(input)) : tokenize(input);
    const depths = computeDepths(toks);

    // --- Pre-scan: classify every parenthesis -------------------------------
    const sig = (idx: number, dir: -1 | 1): Tok | null => {
        let j = idx + dir;
        while (j >= 0 && j < toks.length && (toks[j].type === 'lineComment' || toks[j].type === 'blockComment')) j += dir;
        return j >= 0 && j < toks.length ? toks[j] : null;
    };

    // Parens that open a CREATE FUNCTION/PROCEDURE parameter list.
    const routineParenSet = new Set<number>();
    {
        let sawCreate = false;
        let sawRoutine = false;
        for (let i = 0; i < toks.length; i++) {
            const tk = toks[i];
            if (tk.type === 'word') {
                const w = tk.text.toLowerCase();
                if (w === 'create') { sawCreate = true; }
                else if ((w === 'function' || w === 'procedure') && sawCreate) { sawRoutine = true; }
            } else if (tk.text === '(') {
                if (sawRoutine) { routineParenSet.add(i); sawRoutine = false; sawCreate = false; }
            } else if (tk.text === ';') { sawCreate = false; sawRoutine = false; }
        }
    }

    const parenInfo = new Map<number, ParenInfo>();
    {
        const stack: number[] = [];
        const match = new Map<number, number>();
        for (let i = 0; i < toks.length; i++) {
            if (toks[i].text === '(') stack.push(i);
            else if (toks[i].text === ')') { const o = stack.pop(); if (o != null) match.set(o, i); }
        }
        for (const [open, close] of match) {
            let kind: ParenKind;
            if (routineParenSet.has(open)) kind = 'paramlist';
            else {
                const ns = sig(open, 1);
                const ps = sig(open, -1);
                if (ns && ns.type === 'word' && ['select', 'with', 'values'].includes(ns.text.toLowerCase())) kind = 'subquery';
                else if (ps && ps.type === 'word' && DATATYPES.has(ps.text.toLowerCase())) kind = 'typemod';
                else if (ps && ((ps.type === 'word' && !KEYWORDS.has(ps.text.toLowerCase())) || ps.type === 'quotedIdent' || ps.type === 'param' || ps.text === ')' || ps.text === ']')) kind = 'call';
                else kind = 'group';
            }
            let localP = 0, localB = 0, args = 0, hasTok = false, srcMulti = false;
            for (let k = open + 1; k < close; k++) {
                const tk = toks[k];
                if (tk.nlBefore >= 1) srcMulti = true;
                if (tk.type === 'lineComment' || tk.type === 'blockComment') { hasTok = true; continue; }
                hasTok = true;
                if (tk.text === '(') localP++;
                else if (tk.text === ')') localP--;
                else if (tk.text === '[') localB++;
                else if (tk.text === ']') localB--;
                else if (tk.text === ',' && localP === 0 && localB === 0) args++;
            }
            if (toks[close].nlBefore >= 1) srcMulti = true;
            const argCount = hasTok ? args + 1 : 0;
            let multiline = false;
            if (kind === 'subquery') multiline = true;
            else if (kind === 'call' || kind === 'paramlist') {
                if (argCount <= opt.argsInlineMax) multiline = false;
                else if (argCount >= opt.argsMultilineMin) multiline = true;
                else multiline = srcMulti;
            }
            parenInfo.set(open, { match: close, kind, argCount, multiline });
        }
    }

    const out: string[] = [];
    let cur = '';
    let prev: TokMeta | null = null;
    let lineIndent = 0;
    let pendingIndent = 0;
    let blockIndent = 0;
    let lastWord = '';
    let expectThen = false;
    let exceptionThen = false;
    let exceptionBodyIndent = 0;
    let inRoutineTrailer = false;
    let bracketDepth = 0;
    let betweenPending = 0;
    const blocks: BlockFrame[] = [];
    const lists: { depth: number; indent: number }[] = [];
    const parenStack: { kind: ParenKind; multiline: boolean; openIndent: number }[] = [];

    const indentStr = (level: number): string =>
        opt.indentStyle === 'tab' ? '\t'.repeat(Math.max(0, level)) : ' '.repeat(Math.max(0, level) * opt.indentSize);

    const flush = (): void => {
        if (cur !== '') {
            out.push((indentStr(lineIndent) + cur).replace(/\s+$/, ''));
            cur = '';
            prev = null;
        }
    };

    const insertBlanks = (n: number): void => {
        for (let k = 0; k < n; k++) { if (out.length > 0) out.push(''); }
    };

    const blanksFor = (tk: Tok): number => {
        const b = Math.max(0, tk.nlBefore - 1);
        return opt.blankLines === 'collapse' ? Math.min(1, b) : b;
    };

    const startLine = (indent: number, blanks: number): void => {
        flush();
        insertBlanks(blanks);
        lineIndent = indent;
        pendingIndent = indent;
    };

    const spaceBetween = (p: TokMeta, c: TokMeta): boolean => {
        const a = p.text;
        const b = c.text;
        if (b === ',' || b === ';' || b === ')' || b === ']' || b === '::') return false;
        if (b === '.' || a === '.') return false;
        if (a === '::') return false;
        if (a === '(' || a === '[') return false;
        if (b === '(') {
            if ((p.type === 'word' && !p.isKeyword) || p.type === 'quotedIdent' || a === ')' || a === ']') return false;
            return true;
        }
        if (b === '[') return false;
        return true;
    };

    const emit = (text: string, meta: TokMeta): void => {
        if (cur === '') {
            lineIndent = pendingIndent;
            cur = text;
        } else {
            cur += (prev && spaceBetween(prev, meta) ? ' ' : '') + text;
        }
        prev = meta;
    };

    const nextSignificant = (idx: number): Tok | null => sig(idx, 1);

    const popLists = (pd: number): void => {
        while (lists.length && lists[lists.length - 1].depth >= pd) lists.pop();
    };

    const isClauseOrEnd = (t: Tok | null): boolean => {
        if (!t) return true;
        if (t.text === ';' || t.text === ')') return true;
        if (t.type !== 'word') return false;
        const w = t.text.toLowerCase();
        return CLAUSE_NEWLINE.has(w) || JOIN_WORDS.has(w) || w === 'into';
    };

    const nearestBegin = (): BlockFrame | null => {
        for (let k = blocks.length - 1; k >= 0; k--) if (blocks[k].type === 'begin') return blocks[k];
        return null;
    };
    const nearestIf = (): BlockFrame | null => {
        for (let k = blocks.length - 1; k >= 0; k--) {
            if (blocks[k].type === 'if') return blocks[k];
            if (blocks[k].type === 'begin' || blocks[k].type === 'loop') return null;
        }
        return null;
    };

    /** Does this IF start a PL/pgSQL block (has a top-level THEN) vs. `IF [NOT] EXISTS`? */
    const ifIsBlock = (idx: number): boolean => {
        let d = 0;
        for (let k = idx + 1; k < toks.length; k++) {
            const tk = toks[k];
            if (tk.text === '(') d++;
            else if (tk.text === ')') { if (d === 0) return false; d--; }
            else if (d === 0) {
                if (tk.text === ';') return false;
                if (tk.type === 'word') {
                    const w = tk.text.toLowerCase();
                    if (w === 'then') return true;
                    if (w === 'loop' || w === 'begin' || w === 'end') return false;
                }
            }
        }
        return false;
    };

    /** If a `CREATE FUNCTION/PROCEDURE` at `idx` is written entirely on one source line, return its `;` index; else -1. */
    const singleLineRoutineEnd = (idx: number): number => {
        let sawRoutine = false;
        let d = 0;
        for (let k = idx + 1; k < toks.length; k++) {
            const tk = toks[k];
            if (tk.nlBefore >= 1) return -1;
            if (tk.text.includes('\n')) return -1;
            if (!sawRoutine) {
                if (tk.type === 'word') {
                    const w = tk.text.toLowerCase();
                    if (w === 'function' || w === 'procedure') sawRoutine = true;
                    else if (w !== 'or' && w !== 'replace') return -1;
                } else if (tk.text === '(') return -1;
            }
            if (tk.text === '(') d++;
            else if (tk.text === ')') d--;
            else if (tk.text === ';' && d === 0) return sawRoutine ? k : -1;
        }
        return -1;
    };

    /** If a simple one-line SELECT starts at `idx`, return the index of its `;` (or last token); else -1. */
    const simpleSelectEnd = (idx: number): number => {
        let d = 0;
        let b = 0;
        for (let k = idx + 1; k < toks.length; k++) {
            const tk = toks[k];
            if (tk.type === 'lineComment' || tk.type === 'blockComment') return -1;
            if (tk.text === '(') {
                const inf = parenInfo.get(k);
                if (inf && (inf.kind === 'subquery' || inf.multiline)) return -1;
                d++;
            } else if (tk.text === ')') { if (d === 0) return -1; d--; }
            else if (tk.text === '[') b++;
            else if (tk.text === ']') { if (b > 0) b--; }
            else if (d === 0 && b === 0) {
                if (tk.text === ';') return k;
                if (tk.text === ',') return -1;
                if (tk.type === 'word' && SIMPLE_SELECT_BREAKERS.has(tk.text.toLowerCase())) return -1;
            }
        }
        return toks.length - 1;
    };

    /** Does the comma-separated list starting after `idx` have more than one top-level item? */
    const listHasMultipleItems = (idx: number): boolean => {
        let d = 0, b = 0;
        for (let k = idx + 1; k < toks.length; k++) {
            const tk = toks[k];
            if (tk.text === '(') d++;
            else if (tk.text === ')') { if (d === 0) return false; d--; }
            else if (tk.text === '[') b++;
            else if (tk.text === ']') { if (b > 0) b--; }
            else if (d === 0 && b === 0) {
                if (tk.text === ',') return true;
                if (tk.text === ';') return false;
                if (tk.type === 'word') {
                    const w = tk.text.toLowerCase();
                    if (CLAUSE_NEWLINE.has(w) || JOIN_WORDS.has(w) || w === 'into' || w === 'from') return false;
                }
            }
        }
        return false;
    };

    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        const blanks = blanksFor(t);
        const pd = depths[i];
        const inSql = parenStack.length === 0 ? true : parenStack[parenStack.length - 1].kind === 'subquery';

        // --- Comments -------------------------------------------------------
        if (t.type === 'lineComment') {
            if (cur !== '') { cur += '  ' + t.text; flush(); }
            else if (t.nlBefore === 0 && out.length > 0) {
                // A trailing comment authored on the same line (e.g. after `;`)
                // stays attached to that line instead of moving to a new one.
                out[out.length - 1] = (out[out.length - 1] + '  ' + t.text).replace(/\s+$/, '');
            }
            else { insertBlanks(blanks); lineIndent = pendingIndent; out.push((indentStr(lineIndent) + t.text).replace(/\s+$/, '')); }
            prev = null;
            continue;
        }
        if (t.type === 'blockComment') {
            if (t.text.includes('\n')) {
                flush();
                insertBlanks(blanks);
                lineIndent = pendingIndent;
                const ls = t.text.split('\n');
                out.push((indentStr(lineIndent) + ls[0]).replace(/\s+$/, ''));
                for (let k = 1; k < ls.length; k++) out.push(ls[k].replace(/\s+$/, ''));
                prev = null;
            } else {
                emit(t.text, { text: t.text, isKeyword: false, type: 'comment' });
            }
            continue;
        }

        // --- Dollar-quoted literal / body -----------------------------------
        if (t.type === 'dollar') {
            const m = /^(\$[A-Za-z_]?[A-Za-z0-9_]*\$)([\s\S]*)\1$/.exec(t.text);
            const inner = m ? m[2] : '';
            const tag = m ? m[1] : t.text;
            const looksLikeCode = m && /\b(begin|declare)\b/i.test(inner);
            if (looksLikeCode) {
                emit(tag, { text: tag, isKeyword: false, type: 'operator' });
                flush();
                const innerFmt = formatSql(inner.replace(/^\s*\n/, '').replace(/\s+$/, ''), opt);
                const bodyIndent = blockIndent;
                for (const ln of innerFmt.split('\n')) {
                    out.push(ln === '' ? '' : indentStr(bodyIndent) + ln);
                }
                lineIndent = blockIndent;
                pendingIndent = blockIndent;
                cur = tag;
                prev = { text: tag, isKeyword: false, type: 'operator' };
            } else {
                emit(t.text, { text: t.text, isKeyword: false, type: 'dollar' });
            }
            continue;
        }

        // --- Words (keywords / identifiers / types) -------------------------
        if (t.type === 'word') {
            const w = t.text.toLowerCase();
            const cat: 'type' | 'keyword' | 'ident' =
                DATATYPES.has(w) ? 'type' : (KEYWORDS.has(w) ? 'keyword' : 'ident');
            const rendered = cat === 'type'
                ? applyCase(t.text, opt.dataTypeCase)
                : cat === 'keyword'
                    ? applyCase(t.text, opt.keywordCase)
                    : applyCase(t.text, opt.identifierCase);
            const meta: TokMeta = { text: rendered, isKeyword: cat !== 'ident', type: 'word' };

            // Keep a CREATE FUNCTION/PROCEDURE that the author wrote on a single line intact.
            if (w === 'create' && pd === 0 && parenStack.length === 0 && cur === '') {
                const end = singleLineRoutineEnd(i);
                if (end >= 0) {
                    startLine(blockIndent, blanks);
                    for (let k = i; k <= end; k++) emitInline(toks[k]);
                    flush();
                    pendingIndent = blockIndent;
                    lastWord = ''; i = end; continue;
                }
            }

            // CREATE FUNCTION/PROCEDURE header trailer (RETURNS / characteristics / AS)
            if (inRoutineTrailer && pd === 0) {
                if (w === 'as') {
                    startLine(0, blanks); emit(rendered, meta);
                    inRoutineTrailer = false; lastWord = w; continue;
                }
                if (w === 'returns') { emit(rendered, meta); lastWord = w; continue; }
                if (ROUTINE_CHARACTERISTICS.has(w)) {
                    startLine(1, blanks); emit(rendered, meta); lastWord = w; continue;
                }
                emit(rendered, meta); lastWord = w; continue;
            }

            // Simple single-line SELECT
            if (w === 'select' && pd === 0 && parenStack.length === 0 && cur === ''
                && opt.simpleSelectSingleLine) {
                const end = simpleSelectEnd(i);
                if (end >= 0) {
                    startLine(blockIndent, blanks);
                    for (let k = i; k <= end; k++) emitInline(toks[k]);
                    flush();
                    pendingIndent = blockIndent;
                    lastWord = ''; i = end; continue;
                }
            }

            // PL/pgSQL block structure (top level only)
            if (pd === 0) {
                // Track CASE *expressions* so their WHEN/ELSE/END are not
                // mistaken for IF/block control flow.
                if (w === 'case') {
                    blocks.push({ type: 'case', head: blockIndent });
                    emit(rendered, meta);
                    lastWord = w; continue;
                }
                if (blocks[blocks.length - 1]?.type === 'case') {
                    if (w === 'end') {
                        blocks.pop();
                        emit(rendered, meta);
                        const nx = toks[i + 1];
                        if (nx && nx.type === 'word' && nx.text.toLowerCase() === 'case') {
                            const rj = applyCase(nx.text, opt.keywordCase);
                            emit(rj, { text: rj, isKeyword: true, type: 'word' });
                            i++;
                        }
                        lastWord = w; continue;
                    }
                    if (w === 'when' || w === 'then' || w === 'else') {
                        emit(rendered, meta);
                        lastWord = w; continue;
                    }
                }
                // EXCEPTION block (start of an exception handler section)
                if (w === 'exception' && cur === '') {
                    const bf = nearestBegin();
                    if (bf) {
                        bf.exception = true;
                        startLine(bf.head, blanks); emit(rendered, meta); flush();
                        blockIndent = bf.head + 1; pendingIndent = blockIndent;
                        lastWord = w; continue;
                    }
                }
                // WHEN inside an EXCEPTION section
                if (w === 'when' && cur === '') {
                    const bf = nearestBegin();
                    if (bf && bf.exception) {
                        startLine(bf.head + 1, blanks); emit(rendered, meta);
                        exceptionThen = true; exceptionBodyIndent = bf.head + 2;
                        lastWord = w; continue;
                    }
                }
                if (w === 'declare') {
                    startLine(blockIndent, blanks); emit(rendered, meta); flush();
                    blocks.push({ type: 'declare', head: blockIndent });
                    blockIndent++; pendingIndent = blockIndent;
                    lastWord = w; continue;
                }
                if (w === 'begin') {
                    if (blocks[blocks.length - 1]?.type === 'declare') { const d = blocks.pop()!; blockIndent = d.head; }
                    startLine(blockIndent, blanks); emit(rendered, meta); flush();
                    blocks.push({ type: 'begin', head: blockIndent });
                    blockIndent++; pendingIndent = blockIndent;
                    lists.length = 0; lastWord = w; continue;
                }
                if (w === 'end') {
                    const frame = blocks.pop();
                    blockIndent = frame ? frame.head : Math.max(0, blockIndent - 1);
                    startLine(blockIndent, blanks); emit(rendered, meta);
                    pendingIndent = blockIndent;
                    const nx = toks[i + 1];
                    if (nx && nx.type === 'word' && ['if', 'loop', 'case'].includes(nx.text.toLowerCase())) {
                        const rj = applyCase(nx.text, opt.keywordCase);
                        emit(rj, { text: rj, isKeyword: true, type: 'word' });
                        i++;
                    }
                    lastWord = w; continue;
                }
                if (w === 'if' && ifIsBlock(i)) {
                    startLine(blockIndent, blanks); emit(rendered, meta);
                    expectThen = true; blocks.push({ type: 'if', head: blockIndent });
                    lastWord = w; continue;
                }
                if ((w === 'elsif' || w === 'elseif') && nearestIf()) {
                    const f = nearestIf()!;
                    startLine(f.head, blanks); emit(rendered, meta);
                    expectThen = true; lastWord = w; continue;
                }
                if (w === 'else' && nearestIf()) {
                    const f = nearestIf()!;
                    startLine(f.head, blanks); emit(rendered, meta); flush();
                    blockIndent = f.head + 1; pendingIndent = blockIndent; lastWord = w; continue;
                }
                if (w === 'then' && exceptionThen) {
                    emit(rendered, meta); flush();
                    blockIndent = exceptionBodyIndent; pendingIndent = blockIndent;
                    exceptionThen = false; lastWord = w; continue;
                }
                if (w === 'then' && expectThen) {
                    const f = nearestIf();
                    emit(rendered, meta); flush();
                    blockIndent = (f ? f.head : blockIndent) + 1; pendingIndent = blockIndent;
                    expectThen = false; lastWord = w; continue;
                }
                if (w === 'loop') {
                    emit(rendered, meta); flush();
                    blocks.push({ type: 'loop', head: blockIndent });
                    blockIndent++; pendingIndent = blockIndent; lastWord = w; continue;
                }
            }

            // JOINs (only inside an actual SQL context)
            if (JOIN_WORDS.has(w) && inSql) {
                popLists(pd);
                if (JOIN_WORDS.has(lastWord) || lastWord === 'outer') emit(rendered, meta);
                else { startLine(blockIndent + pd, blanks); emit(rendered, meta); }
                lastWord = w; continue;
            }

            // SQL clause keywords (only inside an actual SQL context)
            if (CLAUSE_NEWLINE.has(w) && inSql) {
                const clauseIndent = blockIndent + pd;
                popLists(pd);
                betweenPending = 0;
                startLine(clauseIndent, blanks); emit(rendered, meta);

                if (w === 'select') {
                    while (true) {
                        const nx = toks[i + 1];
                        if (nx && nx.type === 'word' && ['distinct', 'all'].includes(nx.text.toLowerCase())) {
                            const isDistinct = nx.text.toLowerCase() === 'distinct';
                            emit(applyCase(nx.text, opt.keywordCase), { text: nx.text, isKeyword: true, type: 'word' });
                            i++;
                            if (isDistinct && toks[i + 1] && toks[i + 1].type === 'word' && toks[i + 1].text.toLowerCase() === 'on') {
                                emit(applyCase(toks[i + 1].text, opt.keywordCase), { text: 'on', isKeyword: true, type: 'word' });
                                i++;
                                if (toks[i + 1] && toks[i + 1].text === '(') {
                                    let depth = 0;
                                    let j = i + 1;
                                    for (; j < toks.length; j++) {
                                        const tk = toks[j];
                                        emitInline(tk);
                                        if (tk.text === '(') depth++;
                                        else if (tk.text === ')') { depth--; if (depth === 0) break; }
                                    }
                                    i = j;
                                }
                            }
                            continue;
                        }
                        break;
                    }
                    const star = toks[i + 1];
                    if (star && star.text === '*' && isClauseOrEnd(nextSignificant(i + 1))) {
                        emit('*', { text: '*', isKeyword: false, type: 'operator' });
                        i++;
                        pendingIndent = clauseIndent + 1;
                        lastWord = w; continue;
                    }
                    if (!listHasMultipleItems(i)) {
                        // Single select-item: keep it on the SELECT line.
                        pendingIndent = clauseIndent + 1;
                        lastWord = w; continue;
                    }
                    lists.push({ depth: pd, indent: clauseIndent + 1 });
                    pendingIndent = clauseIndent + 1;
                    flush();
                    lastWord = w; continue;
                }

                if (w === 'set') {
                    lists.push({ depth: pd, indent: clauseIndent + 1 });
                    pendingIndent = clauseIndent + 1;
                    flush();
                    lastWord = w; continue;
                }

                pendingIndent = clauseIndent + 1;
                lastWord = w; continue;
            }

            if (w === 'into' && inSql && lastWord !== 'insert') {
                // SELECT ... INTO / RETURNING ... INTO: INTO starts its own line.
                const clauseIndent = blockIndent + pd;
                popLists(pd);
                betweenPending = 0;
                startLine(clauseIndent, blanks); emit(rendered, meta);
                const nx = toks[i + 1];
                if (nx && nx.type === 'word' && nx.text.toLowerCase() === 'strict') {
                    emit(applyCase(nx.text, opt.keywordCase), { text: nx.text, isKeyword: true, type: 'word' });
                    i++;
                }
                if (listHasMultipleItems(i)) {
                    lists.push({ depth: pd, indent: clauseIndent + 1 });
                    pendingIndent = clauseIndent + 1;
                    flush();
                } else {
                    pendingIndent = clauseIndent + 1;
                }
                lastWord = 'into'; continue;
            }
            if (w === 'into' && inSql) popLists(pd);

            // AND on its own line within a SQL condition (except the AND that belongs to BETWEEN).
            if (w === 'and' && inSql) {
                if (betweenPending > 0) {
                    betweenPending--;
                    emit(rendered, meta); lastWord = w; continue;
                }
                startLine(blockIndent + pd + 1, blanks); emit(rendered, meta);
                lastWord = w; continue;
            }
            if (w === 'between' && inSql) betweenPending++;

            // A word that starts a fresh line (e.g. CREATE / UPDATE / INSERT at the
            // start of a statement) is not routed through startLine, so insert any
            // authored blank lines here to preserve them.
            if (cur === '') insertBlanks(blanks);
            emit(rendered, meta);
            lastWord = w;
            continue;
        }

        // --- Punctuation ----------------------------------------------------
        if (t.text === ',') {
            const top = lists[lists.length - 1];
            if (top && top.depth === pd && bracketDepth === 0) {
                if (opt.commaStyle === 'leading') {
                    flush();
                    lineIndent = top.indent;
                    pendingIndent = top.indent;
                    cur = ',';
                    prev = { text: ',', isKeyword: false, type: 'punct' };
                } else {
                    emit(',', { text: ',', isKeyword: false, type: 'punct' });
                    flush();
                    pendingIndent = top.indent;
                }
            } else {
                emit(',', { text: ',', isKeyword: false, type: 'punct' });
            }
            continue;
        }

        if (t.text === ';') {
            popLists(pd);
            betweenPending = 0;
            emit(';', { text: ';', isKeyword: false, type: 'punct' });
            if (pd === 0) {
                flush();
                pendingIndent = blockIndent;
                lastWord = '';
                inRoutineTrailer = false;
            }
            continue;
        }

        if (t.text === '[') { emit('[', { text: '[', isKeyword: false, type: 'punct' }); bracketDepth++; continue; }
        if (t.text === ']') { emit(']', { text: ']', isKeyword: false, type: 'punct' }); bracketDepth = Math.max(0, bracketDepth - 1); continue; }

        if (t.text === '(') {
            const info = parenInfo.get(i);
            const kind: ParenKind = info ? info.kind : 'group';
            const multiline = info ? info.multiline : false;
            if (kind === 'typemod' && cur !== '') {
                // No space between a data type and its modifier, e.g. VARCHAR(500).
                cur += '(';
                prev = { text: '(', isKeyword: false, type: 'punct' };
            } else {
                emit('(', { text: '(', isKeyword: false, type: 'punct' });
            }
            const openIndent = lineIndent;
            parenStack.push({ kind, multiline, openIndent });
            if (multiline) {
                if (kind === 'subquery') {
                    flush(); pendingIndent = openIndent;
                } else {
                    flush();
                    pendingIndent = openIndent + 1;
                    lists.push({ depth: depths[i] + 1, indent: openIndent + 1 });
                }
            }
            continue;
        }

        if (t.text === ')') {
            const frame = parenStack.pop();
            popLists(pd + 1);
            if (frame && frame.multiline) {
                startLine(frame.openIndent, 0);
                emit(')', { text: ')', isKeyword: false, type: 'punct' });
            } else {
                emit(')', { text: ')', isKeyword: false, type: 'punct' });
            }
            if (frame && frame.kind === 'paramlist') inRoutineTrailer = true;
            continue;
        }

        // %TYPE / %ROWTYPE attribute references attach to the preceding name (no spaces).
        if (t.text === '%' && cur !== '') {
            const nx = toks[i + 1];
            if (nx && nx.type === 'word' && (nx.text.toLowerCase() === 'type' || nx.text.toLowerCase() === 'rowtype')) {
                const r = applyCase(nx.text, opt.keywordCase);
                cur += '%' + r;
                prev = { text: r, isKeyword: true, type: 'word' };
                i++;
                continue;
            }
        }

        // Generic punctuation / operators / literals
        emit(t.text, { text: t.text, isKeyword: false, type: t.type });
        continue;
    }

    flush();

    /** Emit a raw token inline (used while greedily consuming sub-runs). */
    function emitInline(tk: Tok): void {
        if (tk.type === 'word') {
            const w = tk.text.toLowerCase();
            const cat: 'type' | 'keyword' | 'ident' =
                DATATYPES.has(w) ? 'type' : (KEYWORDS.has(w) ? 'keyword' : 'ident');
            const rendered = cat === 'type'
                ? applyCase(tk.text, opt.dataTypeCase)
                : cat === 'keyword'
                    ? applyCase(tk.text, opt.keywordCase)
                    : applyCase(tk.text, opt.identifierCase);
            emit(rendered, { text: rendered, isKeyword: cat !== 'ident', type: 'word' });
        } else {
            emit(tk.text, { text: tk.text, isKeyword: false, type: tk.type });
        }
    }

    let result = out.join('\n').replace(/[ \t]+$/gm, '');
    if (opt.blankLines === 'collapse') result = result.replace(/\n{3,}/g, '\n\n');
    result = result.replace(/^\n+/, '').replace(/\n+$/, '');
    return trailingNewline ? result + '\n' : result;
}
