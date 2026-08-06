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

/**
 * A pair of thresholds for one "should this list be multi-line?" decision: a
 * list with at most `inlineMax` items always stays on one line, a list with at
 * least `multilineMin` items always wraps, and in between the source layout
 * decides (single-line stays single, multi-line stays multi).
 */
export interface ListThreshold {
    inlineMax: number;
    multilineMin: number;
}

/** Every construct whose multi-line wrapping is governed by a threshold pair. */
export type ConstructKey =
    | 'createFunction'
    | 'createProcedure'
    | 'createType'
    | 'createTable'
    | 'returnsTable'
    | 'functionCall'
    | 'selectColumns'
    | 'fromTables'
    | 'groupByColumns'
    | 'orderByColumns'
    | 'insertColumns'
    | 'arrayLiterals'
    | 'inLists'
    | 'booleanGroups'
    | 'joinConditions'
    | 'ifConditions'
    | 'caseConditions'
    | 'operatorChains'
    | 'caseWhenThen'
    | 'exceptionWhenThen'
    | 'ifElse';

/**
 * Default threshold per construct. Count-based constructs use a small inline /
 * larger multi-line pair; structural blocks (`caseWhenThen`, `exceptionWhenThen`,
 * `ifElse`) default to "follow the source" ({0, 99} => the in-between band covers
 * every branch count, so a multi-line source stays multi-line — the normal case —
 * while a single-line source may stay on one line).
 */
export const DEFAULT_THRESHOLDS: Record<ConstructKey, ListThreshold> = {
    createFunction: { inlineMax: 0, multilineMin: 1 },
    createProcedure: { inlineMax: 0, multilineMin: 1 },
    createType: { inlineMax: 1, multilineMin: 2 },
    createTable: { inlineMax: 0, multilineMin: 1 },
    returnsTable: { inlineMax: 1, multilineMin: 4 },
    functionCall: { inlineMax: 1, multilineMin: 4 },
    selectColumns: { inlineMax: 1, multilineMin: 3 },
    fromTables: { inlineMax: 1, multilineMin: 4 },
    groupByColumns: { inlineMax: 1, multilineMin: 4 },
    orderByColumns: { inlineMax: 1, multilineMin: 4 },
    insertColumns: { inlineMax: 2, multilineMin: 10 },
    arrayLiterals: { inlineMax: 2, multilineMin: 10 },
    inLists: { inlineMax: 2, multilineMin: 10 },
    booleanGroups: { inlineMax: 1, multilineMin: 3 },
    joinConditions: { inlineMax: 1, multilineMin: 3 },
    ifConditions: { inlineMax: 1, multilineMin: 3 },
    caseConditions: { inlineMax: 1, multilineMin: 3 },
    operatorChains: { inlineMax: 1, multilineMin: 6 },
    caseWhenThen: { inlineMax: 0, multilineMin: 3 },
    exceptionWhenThen: { inlineMax: 0, multilineMin: 3 },
    ifElse: { inlineMax: 0, multilineMin: 3 }
};

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
    /** Keep a one-line CREATE FUNCTION/PROCEDURE header on one line. Default: true. */
    preserveSingleLineRoutineHeaders: boolean;
    /** Keep a fully one-line simple IF ... THEN ... END IF block on one line. Default: true. */
    preserveSingleLineIfBlocks: boolean;
    /** Per-construct multi-line wrapping thresholds. See {@link DEFAULT_THRESHOLDS}. */
    thresholds: Partial<Record<ConstructKey, ListThreshold>>;
    /** Replace verbose type phrases with their short form (character varying -> varchar). Default: true. */
    normalizeDataTypes: boolean;
    /** Phrase-to-type map used by normalizeDataTypes (e.g. "character varying" -> "varchar"). */
    dataTypeAliases: Record<string, string>;
}

export const DEFAULT_DATA_TYPE_ALIASES: Record<string, string> = {
    'timestamp without time zone': 'timestamp',
    'timestamp with time zone': 'timestamptz',
    'time without time zone': 'time',
    'time with time zone': 'timetz',
    int2: 'smallint',
    int4: 'integer',
    int8: 'bigint',
    'character varying': 'varchar',
    'bit varying': 'varbit'
};

function normalizeDataTypeAliasTable(raw: Record<string, unknown> | undefined): Record<string, string> {
    const phrase = (value: unknown): string => {
        if (typeof value !== 'string') return '';
        return value.trim().toLowerCase().replace(/\s+/g, ' ');
    };
    const aliases: Record<string, string> = {};
    Object.entries(DEFAULT_DATA_TYPE_ALIASES).forEach(([from, to]) => {
        aliases[phrase(from)] = phrase(to);
    });
    const srcTable = raw ?? {};
    Object.entries(srcTable).forEach(([from, to]) => {
        const src = phrase(from);
        const dst = phrase(to);
        if (!src || !dst) return;
        if (dst === src) {
            // Explicitly disable a default alias by mapping phrase -> same phrase.
            delete aliases[src];
            return;
        }
        // Canonical replacements must be a single token (e.g. varchar, timetz).
        if (dst.includes(' ')) return;
        aliases[src] = dst;
    });
    return aliases;
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
    preserveSingleLineRoutineHeaders: true,
    preserveSingleLineIfBlocks: true,
    thresholds: DEFAULT_THRESHOLDS,
    normalizeDataTypes: true,
    dataTypeAliases: DEFAULT_DATA_TYPE_ALIASES
};

/**
 * Build a validated {@link FormatOptions} from arbitrary (e.g. configuration)
 * values, falling back to {@link DEFAULT_FORMAT_OPTIONS} for anything missing or
 * invalid. Pure (no `vscode` dependency) so callers can read settings and pass
 * the plain values in.
 *
 * The per-construct thresholds are read from a single `listThresholds` table
 * whose values are `"inlineMax, multilineMin"` strings (so the VS Code settings
 * editor can render them as an editable table). A {@link ListThreshold} object
 * is also accepted for programmatic callers.
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
    preserveSingleLineRoutineHeaders?: unknown;
    preserveSingleLineIfBlocks?: unknown;
    // Legacy umbrella switch: kept as fallback for backward compatibility.
    preserveSingleLineSpecialCases?: unknown;
    listThresholds?: unknown;
    normalizeDataTypes?: unknown;
    dataTypeAliases?: unknown;
}): FormatOptions {
    const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
        typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
    const num = (value: unknown, min: number, max: number, fallback: number): number =>
        typeof value === 'number' && value >= min && value <= max ? Math.floor(value) : fallback;
    const size = num(raw.indentSize, 1, 8, DEFAULT_FORMAT_OPTIONS.indentSize);
    const table = (raw.listThresholds && typeof raw.listThresholds === 'object')
        ? raw.listThresholds as Record<string, unknown>
        : {};
    const dataTypeAliasTable = (raw.dataTypeAliases && typeof raw.dataTypeAliases === 'object')
        ? raw.dataTypeAliases as Record<string, unknown>
        : {};
    // Accept either a "inlineMax, multilineMin" string (settings table) or a
    // { inlineMax, multilineMin } object (programmatic callers); clamp & order.
    const threshold = (value: unknown, def: ListThreshold): ListThreshold => {
        let inlineMax = def.inlineMax;
        let multilineMin = def.multilineMin;
        if (typeof value === 'string') {
            const nums = value.match(/-?\d+/g);
            if (nums && nums.length >= 2) { inlineMax = Number(nums[0]); multilineMin = Number(nums[1]); }
        } else if (value && typeof value === 'object') {
            const o = value as Record<string, unknown>;
            if (typeof o.inlineMax === 'number') inlineMax = o.inlineMax;
            if (typeof o.multilineMin === 'number') multilineMin = o.multilineMin;
        }
        inlineMax = Math.min(50, Math.max(0, Math.floor(inlineMax)));
        multilineMin = Math.min(100, Math.max(1, Math.floor(multilineMin)));
        if (multilineMin <= inlineMax) multilineMin = inlineMax + 1;
        return { inlineMax, multilineMin };
    };
    const thresholds = {} as Record<ConstructKey, ListThreshold>;
    (Object.keys(DEFAULT_THRESHOLDS) as ConstructKey[]).forEach(key => {
        thresholds[key] = threshold(table[key], DEFAULT_THRESHOLDS[key]);
    });
    const aliases = normalizeDataTypeAliasTable(dataTypeAliasTable);
    const legacySingleLine = typeof raw.preserveSingleLineSpecialCases === 'boolean'
        ? raw.preserveSingleLineSpecialCases
        : undefined;
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
        preserveSingleLineRoutineHeaders: typeof raw.preserveSingleLineRoutineHeaders === 'boolean'
            ? raw.preserveSingleLineRoutineHeaders
            : (legacySingleLine ?? DEFAULT_FORMAT_OPTIONS.preserveSingleLineRoutineHeaders),
        preserveSingleLineIfBlocks: typeof raw.preserveSingleLineIfBlocks === 'boolean'
            ? raw.preserveSingleLineIfBlocks
            : (legacySingleLine ?? DEFAULT_FORMAT_OPTIONS.preserveSingleLineIfBlocks),
        thresholds,
        normalizeDataTypes: typeof raw.normalizeDataTypes === 'boolean'
            ? raw.normalizeDataTypes
            : DEFAULT_FORMAT_OPTIONS.normalizeDataTypes,
        dataTypeAliases: aliases
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
    'merge', 'matched',
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
function buildTypePhraseAliases(aliases: Record<string, string>): { words: string[]; canonical: string }[] {
    return Object.entries(aliases)
        .map(([from, to]) => ({ words: from.split(' ').filter(Boolean), canonical: to }))
        .filter(a => a.words.length > 0 && a.canonical.length > 0)
        .sort((a, b) => b.words.length - a.words.length);
}

/** Merge verbose multi-word type phrases (e.g. `character varying`) into a single short-form token. */
function normalizeTypePhrases(toks: Tok[], typeAliases: { words: string[]; canonical: string }[]): Tok[] {
    const out: Tok[] = [];
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        let matched = false;
        if (t.type === 'word') {
            for (const { words, canonical } of typeAliases) {
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

/**
 * Build a whitespace-independent *semantic signature* of a SQL/PL-pgSQL string:
 * the ordered list of its tokens, where only formatting-irrelevant differences
 * are normalised away. Two strings with the same signature can differ only in
 *
 *  - whitespace / line breaks (not tokens at all), and
 *  - keyword / identifier / data-type letter-case (words are lower-cased), and
 *  - verbose vs. canonical type phrases (when `normalizeTypes` is on), and
 *  - the internal layout of a dollar-quoted body (compared by its own tokens).
 *
 * Everything that carries meaning — literals, comments, operators, structural
 * punctuation and, crucially, the *number and order* of tokens — is preserved
 * verbatim. This is the basis of the formatter's safety net: if formatting ever
 * produces a different signature (for instance a line comment that absorbs the
 * code following it, turning real tokens into comment text), the change is
 * unsafe and must be rejected.
 */
function tokenSignature(input: string, normalizeTypes: boolean, dataTypeAliases: Record<string, string>): string {
    return semanticTokens(input, normalizeTypes, dataTypeAliases).map(t => t.sig).join('\u0001');
}

/** One entry of a {@link semanticTokens} stream. */
interface SemTok {
    /** The exact string used for equality (type + normalised text). */
    sig: string;
    /** A short, human-readable description of the token for diagnostics. */
    display: string;
}

/**
 * Flatten `input` into its meaning-carrying tokens (see {@link tokenSignature}),
 * expanding dollar-quoted bodies recursively. Used both for the fast equality
 * check and for producing a human-readable explanation of the first difference.
 */
function semanticTokens(input: string, normalizeTypes: boolean, dataTypeAliases: Record<string, string>): SemTok[] {
    const out: SemTok[] = [];
    const typeAliases = buildTypePhraseAliases(dataTypeAliases);
    const label = (type: string, text: string): string => {
        const clean = text.replace(/\s+/g, ' ').trim();
        const short = clean.length > 40 ? clean.slice(0, 37) + '…' : clean;
        return `\`${short}\` (${type})`;
    };
    const walk = (src: string): void => {
        let toks = tokenize(src);
        if (normalizeTypes) toks = normalizeTypePhrases(toks, typeAliases);
        for (const t of toks) {
            if (t.type === 'dollar') {
                const m = /^(\$[A-Za-z_]?[A-Za-z0-9_]*\$)([\s\S]*)\1$/.exec(t.text);
                if (m) {
                    // Tag is compared case-insensitively; the body is reformatted
                    // by the formatter, so compare it by its own token stream.
                    out.push({ sig: '$<' + m[1].toLowerCase(), display: label('dollar-tag', m[1]) });
                    walk(m[2]);
                    out.push({ sig: '>$', display: label('dollar-tag', m[1]) });
                    continue;
                }
            }
            // Words are compared case-insensitively; comments are compared
            // whitespace-insensitively (the formatter may re-indent them, trim
            // trailing blanks and rewrite line endings — none of which changes
            // their meaning), everything else verbatim.
            const text = t.type === 'word'
                ? t.text.toLowerCase()
                : (t.type === 'lineComment' || t.type === 'blockComment')
                    ? t.text.replace(/\s+/g, ' ').trim()
                    : t.text;
            out.push({ sig: t.type + '\u0000' + text, display: label(t.type, t.text) });
        }
    };
    walk(input);
    return out;
}

/**
 * Compare the semantic token streams of `input` and `output`. Returns `null`
 * when they are equivalent (formatting is safe), or a human-readable message
 * describing the first divergence when they are not.
 */
function signatureDiff(input: string, output: string, normalizeTypes: boolean, dataTypeAliases: Record<string, string>): string | null {
    const a = semanticTokens(input, normalizeTypes, dataTypeAliases);
    const b = semanticTokens(output, normalizeTypes, dataTypeAliases);
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        if (a[i].sig !== b[i].sig) {
            return `formatting would have changed the code at token ${i + 1}: `
                + `expected ${a[i].display} but the formatted output had ${b[i].display}.`;
        }
    }
    if (a.length !== b.length) {
        if (b.length > a.length) {
            return `formatting added unexpected tokens (e.g. ${b[len].display} after token ${len}); `
                + `it produced ${b.length} tokens instead of ${a.length}.`;
        }
        return `formatting dropped code (missing ${a[len].display} after token ${len}); `
            + `it produced ${b.length} tokens instead of ${a.length}.`;
    }
    return null;
}

/**
 * Returns `true` when two SQL / PL-pgSQL fragments have the same meaning, i.e.
 * they differ only in whitespace, keyword/identifier/type letter-case and (when
 * `normalizeTypes` is on) verbose vs. canonical type phrases. This is the exact
 * check the formatter uses as a safety net to guarantee it never alters logic.
 */
export function sqlSemanticallyEqual(
    a: string,
    b: string,
    normalizeTypes = true,
    dataTypeAliases: Record<string, string> = DEFAULT_DATA_TYPE_ALIASES
): boolean {
    const aliases = normalizeDataTypeAliasTable(dataTypeAliases as Record<string, unknown>);
    return tokenSignature(a, normalizeTypes, aliases) === tokenSignature(b, normalizeTypes, aliases);
}

/**
 * Like {@link sqlSemanticallyEqual}, but returns a human-readable description of
 * the first meaning-changing difference between `a` and `b`, or `null` when they
 * are equivalent. This is exactly the detail the formatter reports when its
 * safety net rejects a formatting result.
 */
export function sqlSemanticDiff(
    a: string,
    b: string,
    normalizeTypes = true,
    dataTypeAliases: Record<string, string> = DEFAULT_DATA_TYPE_ALIASES
): string | null {
    const aliases = normalizeDataTypeAliasTable(dataTypeAliases as Record<string, unknown>);
    return signatureDiff(a, b, normalizeTypes, aliases);
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

/**
 * SQL statement keywords that, when they begin a dollar-quoted body, mark the
 * body as SQL that should be reformatted (e.g. the query template of an
 * `EXECUTE format($query$ SELECT … $query$)` call).
 */
const SQL_STATEMENT_STARTERS = new Set([
    'select', 'with', 'insert', 'update', 'delete', 'merge'
]);

/**
 * Decides whether a dollar-quoted body should be reformatted as code. True when
 * it contains a PL/pgSQL block (`BEGIN`/`DECLARE`) or when it spans multiple
 * lines and its first significant word (ignoring leading whitespace and
 * comments) starts a SQL statement. Single-line bodies and bodies that are plain
 * text, JSON, regex patterns, etc. are left verbatim.
 */
function dollarBodyIsCode(body: string): boolean {
    if (/\b(begin|declare)\b/i.test(body)) return true;
    // A single-line SQL body (e.g. `AS $$ SELECT 1 $$`) is kept inline; only a
    // multi-line statement template is reformatted.
    if (!/\n/.test(body)) return false;
    let s = body;
    // Skip leading whitespace and comments to reach the first real word.
    for (;;) {
        const before = s;
        s = s.replace(/^\s+/, '');
        if (s.startsWith('--')) {
            const nl = s.indexOf('\n');
            s = nl === -1 ? '' : s.slice(nl + 1);
        } else if (s.startsWith('/*')) {
            const end = s.indexOf('*/');
            s = end === -1 ? '' : s.slice(end + 2);
        }
        if (s === before) break;
    }
    const mw = /^([A-Za-z_]+)/.exec(s);
    return mw ? SQL_STATEMENT_STARTERS.has(mw[1].toLowerCase()) : false;
}

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
        // Prefixed string literal: E'...', B'...', X'...' and U&'...'
        // (and their lowercase forms). Must be one token so no space is inserted
        // between the prefix and the quote (e.g. E'\n', not E '\n').
        {
            const lc = c.toLowerCase();
            let pfx = 0;
            if ((lc === 'e' || lc === 'b' || lc === 'x') && c2 === "'") pfx = 1;
            else if (lc === 'u' && c2 === '&' && input[i + 2] === "'") pfx = 2;
            if (pfx) {
                // Only E'...' gives a backslash its escaping meaning.
                const backslashEscapes = lc === 'e';
                let j = i + pfx + 1;
                while (j < n) {
                    if (backslashEscapes && input[j] === '\\') { j += 2; continue; }
                    if (input[j] === "'") {
                        if (input[j + 1] === "'") { j += 2; continue; }
                        j++; break;
                    }
                    j++;
                }
                toks.push({ type: 'string', text: input.slice(i, j), nlBefore: nl });
                nl = 0; i = j; continue;
            }
        }
        // Single-quoted string. With standard_conforming_strings (the default
        // since PostgreSQL 9.1) a backslash is an ordinary character here, so
        // `'\'` is a complete literal - only a doubled quote continues it.
        if (c === "'") {
            let j = i + 1;
            while (j < n) {
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
        // PostgreSQL `format()` specifier: a `%` immediately followed by one of
        // the type characters `s`, `I` or `L` is a single placeholder and must
        // never be split by inserting a space (that would change the meaning of
        // the format string, e.g. `%L` -> `% L`). Emitting it as one token keeps
        // the `%` and its type character glued together in the output. `%%` is
        // already a single token because both characters are operator characters.
        // The following character must not continue an identifier so real code
        // like `%system` (a `%` operator applied to `system`) is left untouched.
        if (c === '%' && (c2 === 's' || c2 === 'I' || c2 === 'L')) {
            const after = input[i + 2];
            if (after === undefined || !/[A-Za-z0-9_$\u0080-\uffff]/.test(after)) {
                toks.push({ type: 'operator', text: input.slice(i, i + 2), nlBefore: nl });
                nl = 0; i += 2; continue;
            }
        }
        // Operator run. In PostgreSQL `--` and `/*` always start a comment and
        // can never appear inside an operator, so the run must stop before either
        // sequence. Without this, `x || '.' ||-- note` would be lexed as a bogus
        // `||--` operator, the comment marker would be lost, and the code on the
        // following lines would silently be swallowed as operands (and, because no
        // comment token is produced, the safety net could not detect the damage).
        if (OP_CHARS.has(c)) {
            let j = i + 1;
            while (j < n && OP_CHARS.has(input[j])) {
                if (input[j] === '-' && input[j + 1] === '-') break;
                if (input[j] === '/' && input[j + 1] === '*') break;
                j++;
            }
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

type ParenKind = 'subquery' | 'paramlist' | 'call' | 'group' | 'typemod' | 'boolgroup';
interface ParenInfo { match: number; kind: ParenKind; argCount: number; multiline: boolean; srcMulti: boolean; }
interface BlockFrame { type: 'declare' | 'begin' | 'if' | 'loop' | 'case'; head: number; exception?: boolean; }

/**
 * Format a PL/pgSQL / SQL string according to `options`.
 */
/**
 * Formats SQL / PL/pgSQL source. The core pass is applied repeatedly (up to 10
 * times) until the output stabilises, so that newly introduced line breaks
 * (e.g. nested boolean groups) are themselves re-indented on a following pass.
 */
export function formatSql(input: string, options?: Partial<FormatOptions>): string {
    return formatSqlChecked(input, options).text;
}

/** Outcome of {@link formatSqlChecked}. */
export interface FormatResult {
    /** The text to apply: the formatted output when safe, otherwise the original input unchanged. */
    text: string;
    /** `true` when formatting was applied, `false` when the safety net rejected it. */
    ok: boolean;
    /** When `ok` is `false`, a human-readable explanation of why formatting was rejected. */
    reason?: string;
}

/**
 * Like {@link formatSql}, but reports whether the safety net rejected the
 * formatting and why. A formatter must NEVER change the meaning of the code, so
 * the formatted output is verified to have exactly the same semantic token
 * stream as the input (ignoring only whitespace and keyword/identifier/type
 * letter-case). If anything differs — e.g. a line comment that accidentally
 * absorbs the code following it — the formatting is discarded (`text` is the
 * original input) and `reason` describes the first divergence.
 */
export function formatSqlChecked(input: string, options?: Partial<FormatOptions>): FormatResult {
    // Work on LF-only text: the renderer joins its output with '\n', so a CRLF
    // file would otherwise end up with the '\r' stripped *inside* multi-line
    // string literals and comments, which the safety net rejects. The original
    // line ending is restored on the way out.
    const usesCrlf = /\r/.test(input);
    const source = usesCrlf ? input.replace(/\r\n?/g, '\n') : input;
    let result = formatSqlOnce(source, options);
    for (let pass = 1; pass < 10; pass++) {
        const next = formatSqlOnce(result, options);
        if (next === result) break;
        result = next;
    }
    const normalizeTypes = options?.normalizeDataTypes ?? DEFAULT_FORMAT_OPTIONS.normalizeDataTypes;
    const dataTypeAliases = normalizeDataTypeAliasTable((options?.dataTypeAliases ?? DEFAULT_DATA_TYPE_ALIASES) as Record<string, unknown>);
    const reason = signatureDiff(source, result, normalizeTypes, dataTypeAliases);
    if (reason) {
        return { text: input, ok: false, reason };
    }
    return { text: usesCrlf ? result.replace(/\n/g, '\r\n') : result, ok: true };
}

/**
 * Mark every character position that lives *inside* a string, dollar-quoted or
 * quoted-identifier literal. Such positions carry the literal's payload
 * verbatim: rewriting them (trimming trailing blanks, adding indentation)
 * changes the code's meaning. Comments are deliberately *not* marked — their
 * whitespace is normalised away before the semantic comparison, so re-indenting
 * or trimming them is harmless.
 */
function literalMask(text: string): Uint8Array {
    const n = text.length;
    const isProtected = new Uint8Array(n);
    let i = 0;
    while (i < n) {
        const c = text[i];
        const c2 = text[i + 1];
        // Line comment — skip to end of line (unprotected).
        if (c === '-' && c2 === '-') {
            let j = i + 2;
            while (j < n && text[j] !== '\n') j++;
            i = j;
            continue;
        }
        // Block comment (nesting allowed) — skip over it (unprotected).
        if (c === '/' && c2 === '*') {
            let j = i + 2;
            let depth = 1;
            while (j < n && depth > 0) {
                if (text[j] === '/' && text[j + 1] === '*') { depth++; j += 2; }
                else if (text[j] === '*' && text[j + 1] === '/') { depth--; j += 2; }
                else j++;
            }
            i = j;
            continue;
        }
        // Prefixed string literal: E'…', B'…', X'…', U&'…' (and lowercase forms).
        const lc = c.toLowerCase();
        let pfx = 0;
        if ((lc === 'e' || lc === 'b' || lc === 'x') && c2 === "'") pfx = 1;
        else if (lc === 'u' && c2 === '&' && text[i + 2] === "'") pfx = 2;
        if (pfx || c === "'") {
            const start = i;
            let j = i + (pfx ? pfx + 1 : 1);
            while (j < n) {
                if (text[j] === '\\') { j += 2; continue; }
                if (text[j] === "'") {
                    if (text[j + 1] === "'") { j += 2; continue; }
                    j++; break;
                }
                j++;
            }
            for (let k = start; k < j; k++) isProtected[k] = 1;
            i = j;
            continue;
        }
        // Quoted identifier.
        if (c === '"') {
            const start = i;
            let j = i + 1;
            while (j < n) {
                if (text[j] === '"') {
                    if (text[j + 1] === '"') { j += 2; continue; }
                    j++; break;
                }
                j++;
            }
            for (let k = start; k < j; k++) isProtected[k] = 1;
            i = j;
            continue;
        }
        // Dollar-quoted string ($tag$…$tag$) or positional parameter ($1).
        if (c === '$') {
            if (/\d/.test(c2 || '')) {
                let j = i + 1;
                while (j < n && /\d/.test(text[j])) j++;
                i = j;
                continue;
            }
            const tagMatch = /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/.exec(text.slice(i));
            if (tagMatch) {
                const tag = tagMatch[0];
                const close = text.indexOf(tag, i + tag.length);
                const j = close === -1 ? n : close + tag.length;
                for (let k = i; k < j; k++) isProtected[k] = 1;
                i = j;
                continue;
            }
        }
        i++;
    }
    return isProtected;
}

/**
 * For each physical line of `text`, whether the line *starts* inside a
 * multi-line literal (and therefore must be emitted byte-for-byte).
 */
function literalContinuationLines(text: string): boolean[] {
    const mask = literalMask(text);
    const flags: boolean[] = [];
    let pos = 0;
    for (const line of text.split('\n')) {
        flags.push(mask[pos] === 1);
        pos += line.length + 1;
    }
    return flags;
}

/**
 * Strip trailing spaces/tabs at the end of every physical line, but never touch
 * whitespace that lives *inside* a string / dollar-quoted / quoted-identifier
 * literal (see {@link literalMask}).
 */
function stripTrailingWhitespacePreservingLiterals(text: string): string {
    const n = text.length;
    const isProtected = literalMask(text);
    // Rebuild, dropping unprotected trailing spaces/tabs before each line break
    // and at end of input. A newline inside a literal is protected, so the
    // literal's interior lines are emitted verbatim.
    let result = '';
    let lineStart = 0;
    for (let k = 0; k <= n; k++) {
        if (k === n || (text[k] === '\n' && !isProtected[k])) {
            let end = k;
            while (end > lineStart && (text[end - 1] === ' ' || text[end - 1] === '\t') && !isProtected[end - 1]) end--;
            result += text.slice(lineStart, end);
            if (k < n) result += '\n';
            lineStart = k + 1;
        }
    }
    return result;
}

function formatSqlOnce(input: string, options?: Partial<FormatOptions>): string {
    const opt: FormatOptions = { ...DEFAULT_FORMAT_OPTIONS, ...(options || {}) };
    // Deep-merge the threshold table so a caller may override individual keys.
    opt.thresholds = { ...DEFAULT_THRESHOLDS, ...(options?.thresholds || {}) };
    // Per-construct "should this list be multi-line?" decision: below the
    // construct's lower threshold it always stays inline, at/above the upper
    // threshold it always wraps, and in between the source layout decides.
    const wantsMultiline = (count: number, srcMulti: boolean, key: ConstructKey): boolean => {
        const t = opt.thresholds[key] ?? DEFAULT_THRESHOLDS[key];
        if (count <= t.inlineMax) return false;
        if (count >= t.multilineMin) return true;
        return srcMulti;
    };
    const trailingNewline = /\n\s*$/.test(input);
    const typeAliases = buildTypePhraseAliases(normalizeDataTypeAliasTable(opt.dataTypeAliases as Record<string, unknown>));
    const toks = opt.normalizeDataTypes ? normalizeTypePhrases(tokenize(input), typeAliases) : tokenize(input);
    const depths = computeDepths(toks);

    // --- Pre-scan: classify every parenthesis -------------------------------
    const sig = (idx: number, dir: -1 | 1): Tok | null => {
        let j = idx + dir;
        while (j >= 0 && j < toks.length && (toks[j].type === 'lineComment' || toks[j].type === 'blockComment')) j += dir;
        return j >= 0 && j < toks.length ? toks[j] : null;
    };

    // Parens that open a CREATE FUNCTION/PROCEDURE parameter list, plus the
    // construct each such paren belongs to (for per-construct thresholds).
    const routineParenSet = new Set<number>();
    const parenConstruct = new Map<number, ConstructKey>();
    {
        let sawCreate = false;
        let routineKey: ConstructKey | null = null;
        for (let i = 0; i < toks.length; i++) {
            const tk = toks[i];
            if (tk.type === 'word') {
                const w = tk.text.toLowerCase();
                if (w === 'create') { sawCreate = true; }
                else if (w === 'function' && sawCreate) { routineKey = 'createFunction'; }
                else if (w === 'procedure' && sawCreate) { routineKey = 'createProcedure'; }
            } else if (tk.text === '(') {
                if (routineKey) { routineParenSet.add(i); parenConstruct.set(i, routineKey); routineKey = null; sawCreate = false; }
            } else if (tk.text === ';') { sawCreate = false; routineKey = null; }
        }
    }

    // Parens that open a CREATE TYPE attribute/value list (composite, ENUM, RANGE).
    const typeParenSet = new Set<number>();
    {
        let sawCreate = false;
        let sawType = false;
        for (let i = 0; i < toks.length; i++) {
            const tk = toks[i];
            if (tk.type === 'word') {
                const w = tk.text.toLowerCase();
                if (w === 'create') { sawCreate = true; }
                else if (w === 'type' && sawCreate) { sawType = true; }
                else if (w !== 'type') { sawCreate = false; }
            } else if (tk.text === '(') {
                if (sawType) { typeParenSet.add(i); parenConstruct.set(i, 'createType'); sawType = false; sawCreate = false; }
            } else if (tk.text === ';') { sawCreate = false; sawType = false; }
        }
    }

    // Parens that open a CREATE TABLE column list (the first top-level paren
    // after `CREATE [TEMP/UNLOGGED] TABLE [IF NOT EXISTS] name`).
    const tableParenSet = new Set<number>();
    {
        let sawCreate = false;
        let sawTable = false;
        for (let i = 0; i < toks.length; i++) {
            const tk = toks[i];
            if (tk.type === 'word') {
                const w = tk.text.toLowerCase();
                if (w === 'create') { sawCreate = true; }
                else if (w === 'table' && sawCreate) { sawTable = true; sawCreate = false; }
                else if (w === 'as' && sawTable) { sawTable = false; } // CREATE TABLE ... AS SELECT
            } else if (tk.text === '(') {
                if (sawTable) { tableParenSet.add(i); parenConstruct.set(i, 'createTable'); sawTable = false; }
            } else if (tk.text === ';') { sawCreate = false; sawTable = false; }
        }
    }

    // Parens that open a `RETURNS TABLE(...)` column list of a CREATE FUNCTION.
    const returnsTableParenSet = new Set<number>();
    {
        let sawReturns = false;
        let sawTable = false;
        for (let i = 0; i < toks.length; i++) {
            const tk = toks[i];
            if (tk.type === 'word') {
                const w = tk.text.toLowerCase();
                if (w === 'returns') { sawReturns = true; sawTable = false; }
                else if (w === 'table' && sawReturns) { sawTable = true; }
                else { sawReturns = false; sawTable = false; }
            } else if (tk.text === '(') {
                if (sawTable) { returnsTableParenSet.add(i); parenConstruct.set(i, 'returnsTable'); }
                sawReturns = false; sawTable = false;
            } else if (tk.text === ';') { sawReturns = false; sawTable = false; }
        }
    }

    // Per-context AND/OR grouping for JOIN ON, IF/ELSIF and CASE WHEN conditions.
    // Each condition's top-level AND/OR operators are counted once; if the
    // construct's threshold says the group should stay inline, its operator
    // token indices are recorded here so the renderer keeps them on one line.
    // With the default thresholds ({1,2}) a group of >=2 conditions always
    // wraps, so this set stays empty and the layout is unchanged.
    const condInlineSet = new Set<number>();
    // ON-token indices of a JOIN whose condition group wraps over several lines.
    // For those the renderer puts ON on its own line and right-aligns the ON /
    // AND / OR keywords (river style) so the conditions line up underneath.
    const joinOnBreakSet = new Set<number>();
    {
        const stack: string[] = [];
        const topKind = () => stack[stack.length - 1];
        const scanGroup = (start: number, key: ConstructKey, isEnd: (w: string) => boolean): void => {
            let depth = 0, between = 0, srcMulti = false;
            const ops: number[] = [];
            for (let k = start + 1; k < toks.length; k++) {
                const tk = toks[k];
                if (tk.nlBefore >= 1 && depth === 0) srcMulti = true;
                if (tk.text === '(') { depth++; continue; }
                if (tk.text === ')') { if (depth === 0) break; depth--; continue; }
                if (depth !== 0) continue;
                if (tk.text === ';') break;
                if (tk.type !== 'word') continue;
                const w = tk.text.toLowerCase();
                if (isEnd(w)) break;
                if (w === 'between') between++;
                else if (w === 'or') ops.push(k);
                else if (w === 'and') { if (between > 0) between--; else ops.push(k); }
            }
            if (ops.length === 0) return;
            if (!wantsMultiline(ops.length + 1, srcMulti, key)) {
                for (const idx of ops) condInlineSet.add(idx);
            } else if (key === 'joinConditions') {
                joinOnBreakSet.add(start);
            }
        };
        const thenEnd = (w: string) => w === 'then';
        const joinEnd = (w: string) => CLAUSE_NEWLINE.has(w) || JOIN_WORDS.has(w) || w === 'loop' || w === 'then';
        let prevWord = '';
        for (let i = 0; i < toks.length; i++) {
            const tk = toks[i];
            if (tk.type !== 'word') { if (tk.type !== 'lineComment' && tk.type !== 'blockComment') prevWord = ''; continue; }
            const w = tk.text.toLowerCase();
            if (w === 'case' && prevWord !== 'end') stack.push('case');
            else if (w === 'begin') stack.push('begin');
            else if (w === 'loop' && prevWord !== 'end') stack.push('loop');
            else if (w === 'if' && prevWord !== 'end') { stack.push('if'); scanGroup(i, 'ifConditions', thenEnd); }
            else if (w === 'elsif' || w === 'elseif') scanGroup(i, 'ifConditions', thenEnd);
            else if (w === 'when' && topKind() === 'case') scanGroup(i, 'caseConditions', thenEnd);
            else if (w === 'on') scanGroup(i, 'joinConditions', joinEnd);
            else if (w === 'end') stack.pop();
            prevWord = w;
        }
    }

    // Precedence-aware AND/OR indentation: within one boolean condition scope
    // (a `(...)` group or a clause tail such as WHERE/HAVING) that also contains a
    // top-level OR, the AND operators are indented one level deeper than the OR
    // operators — so each OR alternative sits at the scope base and its AND
    // sub-conditions hang underneath. A scope with only ANDs keeps them at the base.
    const andDeepSet = new Set<number>();
    {
        type Scope = { hasOr: boolean; ands: number[]; between: number };
        const newScope = (): Scope => ({ hasOr: false, ands: [], between: 0 });
        const stack: Scope[] = [newScope()];
        const finalize = (s: Scope): void => {
            if (s.hasOr) for (const a of s.ands) andDeepSet.add(a);
            s.hasOr = false; s.ands = []; s.between = 0;
        };
        for (let i = 0; i < toks.length; i++) {
            const tk = toks[i];
            if (tk.text === '(') { stack.push(newScope()); continue; }
            if (tk.text === ')') { const s = stack.pop(); if (s) finalize(s); if (stack.length === 0) stack.push(newScope()); continue; }
            if (tk.type !== 'word') {
                if (tk.text === ',' || tk.text === ';') finalize(stack[stack.length - 1]);
                continue;
            }
            const w = tk.text.toLowerCase();
            const top = stack[stack.length - 1];
            if (w === 'between') top.between++;
            else if (w === 'or') top.hasOr = true;
            else if (w === 'and') { if (top.between > 0) top.between--; else top.ands.push(i); }
            else if (CLAUSE_NEWLINE.has(w) || JOIN_WORDS.has(w)
                || w === 'on' || w === 'when' || w === 'then' || w === 'else'
                || w === 'loop' || w === 'into' || w === 'using') {
                finalize(top);
            }
        }
        finalize(stack[stack.length - 1]);
    }

    // Array literals (ARRAY[...] and nested element arrays): wrap their element
    // list per the `arrayLiterals` threshold. Subscripts (arr[i]) stay inline.
    const bracketInfo = new Map<number, { match: number; multiline: boolean }>();
    {
        const stack: { open: number; lit: boolean }[] = [];
        for (let i = 0; i < toks.length; i++) {
            const tk = toks[i];
            if (tk.text === '[') {
                const ps = sig(i, -1);
                let lit = false;
                if (ps && ps.type === 'word' && ps.text.toLowerCase() === 'array') lit = true;
                else if (stack.length && stack[stack.length - 1].lit && ps && (ps.text === '[' || ps.text === ',')) lit = true;
                stack.push({ open: i, lit });
            } else if (tk.text === ']') {
                const fr = stack.pop();
                if (!fr || !fr.lit) continue;
                let depth = 0, pdepth = 0, commas = 0, hasTok = false, srcMulti = false;
                for (let k = fr.open + 1; k < i; k++) {
                    const t2 = toks[k];
                    if (depth === 0 && pdepth === 0 && t2.nlBefore >= 1) srcMulti = true;
                    if (t2.type === 'lineComment' || t2.type === 'blockComment') { hasTok = true; continue; }
                    if (t2.text === '[') { depth++; hasTok = true; continue; }
                    if (t2.text === ']') { depth--; continue; }
                    if (t2.text === '(') { pdepth++; hasTok = true; continue; }
                    if (t2.text === ')') { pdepth--; continue; }
                    hasTok = true;
                    if (depth === 0 && pdepth === 0 && t2.text === ',') commas++;
                }
                const count = hasTok ? commas + 1 : 0;
                bracketInfo.set(fr.open, { match: i, multiline: wantsMultiline(count, srcMulti, 'arrayLiterals') });
            }
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
            let isInList = false;
            if (routineParenSet.has(open)) kind = 'paramlist';
            else if (returnsTableParenSet.has(open)) kind = 'paramlist';
            else if (typeParenSet.has(open) || tableParenSet.has(open)) kind = 'call';
            else {
                const ns = sig(open, 1);
                const ps = sig(open, -1);
                if (ns && ns.type === 'word' && ['select', 'with', 'values'].includes(ns.text.toLowerCase())) kind = 'subquery';
                else if (ps && ps.type === 'word' && ps.text.toLowerCase() === 'in') { kind = 'call'; isInList = true; }
                else if (ps && ps.type === 'word' && ps.text.toLowerCase() === 'row') kind = 'call';
                else if (ps && ps.type === 'word' && DATATYPES.has(ps.text.toLowerCase())) kind = 'typemod';
                else if (ps && ((ps.type === 'word' && !KEYWORDS.has(ps.text.toLowerCase())) || ps.type === 'quotedIdent' || ps.type === 'param' || ps.text === ')' || ps.text === ']')) kind = 'call';
                else kind = 'group';
            }
            let localP = 0, localB = 0, args = 0, hasTok = false, srcMulti = false;
            let between = 0, topBool = false, boolOps = 0, topOp = false;
            for (let k = open + 1; k < close; k++) {
                const tk = toks[k];
                if (tk.nlBefore >= 1) srcMulti = true;
                if (tk.type === 'lineComment' || tk.type === 'blockComment') { hasTok = true; continue; }
                hasTok = true;
                if (tk.text === '(') localP++;
                else if (tk.text === ')') localP--;
                else if (tk.text === '[') localB++;
                else if (tk.text === ']') localB--;
                else if (localP === 0 && localB === 0) {
                    if (tk.text === ',') args++;
                    else if (tk.type === 'operator' && tk.text !== '::') topOp = true;
                    else if (tk.type === 'word') {
                        const lw = tk.text.toLowerCase();
                        if (lw === 'between') between++;
                        else if (lw === 'or') { topBool = true; boolOps++; }
                        else if (lw === 'and') { if (between > 0) between--; else { topBool = true; boolOps++; } }
                    }
                }
            }
            if (toks[close].nlBefore >= 1) srcMulti = true;
            // A plain group that joins conditions with top-level AND/OR becomes a
            // multi-line boolean group (each operand / operator on its own line).
            if (kind === 'group' && topBool) kind = 'boolgroup';
            const argCount = hasTok ? args + 1 : 0;
            let multiline = false;
            if (kind === 'subquery') multiline = true;
            else if (kind === 'boolgroup') multiline = wantsMultiline(boolOps + 1, srcMulti, 'booleanGroups');
            else if (kind === 'call' || kind === 'paramlist') {
                const key: ConstructKey = parenConstruct.get(open) ?? (isInList ? 'inLists' : 'functionCall');
                multiline = wantsMultiline(argCount, srcMulti, key);
                // A function call the author deliberately split across lines whose
                // single argument is a compound expression (a top-level operator such
                // as `||`, `+`, …) keeps its multi-line layout instead of being
                // collapsed onto one line. Multi-argument calls already follow the
                // functionCall threshold above.
                if (!multiline && kind === 'call' && srcMulti && topOp && argCount <= 1) multiline = true;
            }
            parenInfo.set(open, { match: close, kind, argCount, multiline, srcMulti });
        }
    }

    // --- INSERT: keep the column list and the VALUES list(s) consistent -------
    // The decision (inline vs. multi-line) is taken once per INSERT from the
    // column count and whether either side was authored across multiple lines,
    // then applied to both the column list and every VALUES tuple.
    {
        const isWord = (idx: number, w: string): boolean =>
            idx >= 0 && idx < toks.length && toks[idx].type === 'word' && toks[idx].text.toLowerCase() === w;
        for (let i = 0; i < toks.length; i++) {
            if (!isWord(i, 'insert')) continue;
            // Find the column list paren (optional) and the VALUES keyword.
            let colOpen: number | null = null;
            let valuesIdx = -1;
            let depth = 0;
            for (let k = i + 1; k < toks.length; k++) {
                const tk = toks[k];
                if (tk.text === ';' && depth === 0) break;
                if (tk.text === '(') {
                    if (depth === 0 && colOpen === null && valuesIdx === -1) {
                        const info = parenInfo.get(k);
                        // Only treat as a column list if it is a plain comma list
                        // (call/group), not a sub-SELECT.
                        if (info && info.kind !== 'subquery') colOpen = k;
                    }
                    depth++;
                } else if (tk.text === ')') {
                    depth = Math.max(0, depth - 1);
                } else if (depth === 0 && tk.type === 'word' && tk.text.toLowerCase() === 'values') {
                    valuesIdx = k;
                    break;
                } else if (depth === 0 && tk.type === 'word' && tk.text.toLowerCase() === 'select') {
                    break; // INSERT ... SELECT: no VALUES list to link.
                }
            }
            // Collect the VALUES tuple parens (one or more, comma-separated).
            const valueOpens: number[] = [];
            if (valuesIdx !== -1) {
                let depth2 = 0;
                for (let k = valuesIdx + 1; k < toks.length; k++) {
                    const tk = toks[k];
                    if (tk.text === ';' && depth2 === 0) break;
                    if (tk.text === '(') {
                        if (depth2 === 0) valueOpens.push(k);
                        depth2++;
                    } else if (tk.text === ')') {
                        depth2 = Math.max(0, depth2 - 1);
                    } else if (depth2 === 0 && tk.type === 'word' && tk.text.toLowerCase() !== 'default') {
                        break; // reached a clause keyword after the tuples
                    }
                }
            }
            const targets: number[] = [];
            if (colOpen !== null) targets.push(colOpen);
            for (const v of valueOpens) targets.push(v);
            if (targets.length === 0) continue;
            // Column count drives the decision; fall back to the first tuple.
            const countInfo = parenInfo.get(colOpen !== null ? colOpen : valueOpens[0]);
            const n = countInfo ? countInfo.argCount : 0;
            const srcMulti = targets.some(t => { const inf = parenInfo.get(t); return !!inf && inf.srcMulti; });
            const wantMulti = wantsMultiline(n, srcMulti, 'insertColumns');
            for (const t of targets) {
                const inf = parenInfo.get(t);
                if (inf) parenInfo.set(t, { ...inf, multiline: wantMulti });
            }
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
    let ifCondBroke = false;
    let exceptionThen = false;
    let exceptionBodyIndent = 0;
    let inRoutineTrailer = false;
    let bracketDepth = 0;
    let betweenPending = 0;
    let forHeaderIndent: number | null = null;
    let mergeIndent: number | null = null;
    let mergeWhenStart = -1;
    let joinRiver = false;
    const blocks: BlockFrame[] = [];
    const lists: { depth: number; indent: number; bdepth?: number }[] = [];
    const parenStack: { kind: ParenKind; multiline: boolean; openIndent: number; savedBlockIndent?: number }[] = [];
    const bracketStack: { multiline: boolean; openIndent: number }[] = [];

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
        // JSON / JSONB path operators: no spaces around ->, ->>, #>, #>>
        if (a === '->' || a === '->>' || a === '#>' || a === '#>>') return false;
        if (b === '->' || b === '->>' || b === '#>' || b === '#>>') return false;
        if (b === '(') {
            if (p.type === 'word' && p.text.toLowerCase() === 'row') return false;
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
            if (blocks[k].type === 'begin' || blocks[k].type === 'loop' || blocks[k].type === 'case') return null;
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

    /** True when all tokens in [from..to] stay on the same source line. */
    const isSingleSourceLineRange = (from: number, to: number): boolean => {
        for (let k = from + 1; k <= to; k++) {
            const tk = toks[k];
            if (tk.nlBefore >= 1) return false;
            if (tk.text.includes('\n')) return false;
        }
        return true;
    };

    /** True when IF [ifIdx..endKw] has a top-level ELSE / ELSIF branch. */
    const ifHasTopLevelElseBranch = (ifIdx: number, endKw: number): boolean => {
        let pd = 0;
        let nested = 0;
        for (let k = ifIdx + 1; k < endKw; k++) {
            const tk = toks[k];
            if (tk.text === '(') { pd++; continue; }
            if (tk.text === ')') { pd = Math.max(0, pd - 1); continue; }
            if (pd !== 0 || tk.type !== 'word') continue;
            const w = tk.text.toLowerCase();
            if (w === 'if' || w === 'case' || w === 'loop' || w === 'begin') { nested++; continue; }
            if (w === 'end' && nested > 0) {
                nested--;
                const nx = toks[k + 1];
                const nw = nx && nx.type === 'word' ? nx.text.toLowerCase() : '';
                if (nw === 'if' || nw === 'loop' || nw === 'case') k++;
                continue;
            }
            if (nested === 0 && (w === 'else' || w === 'elsif' || w === 'elseif')) return true;
        }
        return false;
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
                if (tk.type === 'word') {
                    const lw = tk.text.toLowerCase();
                    if (lw === 'case') {
                        // A multiline CASE must not be collapsed; a single-line CASE is
                        // skipped wholesale so its inner words don't trip the breakers.
                        let cd = 0, nl = false, m = k;
                        for (; m < toks.length; m++) {
                            const mt = toks[m];
                            if (m > k && mt.nlBefore >= 1) nl = true;
                            if (mt.type === 'word') {
                                const mw = mt.text.toLowerCase();
                                if (mw === 'case') cd++;
                                else if (mw === 'end') { cd--; if (cd === 0) break; }
                            }
                        }
                        if (nl) return -1;
                        k = m; continue;
                    }
                    if (SIMPLE_SELECT_BREAKERS.has(lw)) return -1;
                }
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

    /**
     * True if the clause list starting after `idx` contains more than one
     * comma-separated item AND was authored across multiple source lines.
     * Used to keep an old-style comma `FROM a, b, c` list broken when the
     * author already spread it over several lines.
     */
    const clauseListInfo = (idx: number, stopAtFrom = false): { count: number; srcMulti: boolean } => {
        let d = 0, b = 0, commas = 0, hasTok = false, hasNewline = false;
        for (let k = idx + 1; k < toks.length; k++) {
            const tk = toks[k];
            // A top-level clause/JOIN keyword, closing paren or `;` ends the list;
            // its own leading newline must not count as a break inside the list.
            if (d === 0 && b === 0) {
                if (tk.text === ')' || tk.text === ';') break;
                if (tk.type === 'word') {
                    const w = tk.text.toLowerCase();
                    // `loop` ends a cursor `FOR … IN <query> LOOP`, so the list must
                    // not run on into the loop body (whose newlines would otherwise be
                    // mistaken for a multi-line list).
                    if (CLAUSE_NEWLINE.has(w) || JOIN_WORDS.has(w) || w === 'into' || w === 'loop' || (stopAtFrom && w === 'from')) break;
                }
            }
            if (tk.nlBefore >= 1 && d === 0 && b === 0) hasNewline = true;
            if (tk.text === '(') d++;
            else if (tk.text === ')') d--;
            else if (tk.text === '[') b++;
            else if (tk.text === ']') { if (b > 0) b--; }
            else if (d === 0 && b === 0 && tk.text === ',') commas++;
            if (tk.type !== 'lineComment' && tk.type !== 'blockComment') hasTok = true;
        }
        return { count: hasTok ? commas + 1 : 0, srcMulti: hasNewline };
    };

    // --- CASE expression helpers -------------------------------------------
    /**
     * Index of the `END` that closes the `CASE` at `caseIdx` (block-aware).
     * Accounts for nested `IF`/`LOOP`/`BEGIN`/`CASE` blocks so that a statement-form
     * `CASE … END CASE` whose branches contain `IF … END IF;` etc. is matched correctly
     * (its closing `END` is followed by `CASE`).
     */
    const caseMatchEnd = (caseIdx: number): number => {
        let depth = 0;
        for (let k = caseIdx; k < toks.length; k++) {
            const tk = toks[k];
            if (tk.type !== 'word') continue;
            const w = tk.text.toLowerCase();
            if (w === 'case' || w === 'if' || w === 'loop' || w === 'begin') {
                depth++;
            } else if (w === 'end') {
                depth--;
                if (depth === 0) return k;
                const nx = toks[k + 1];
                const nw = nx && nx.type === 'word' ? nx.text.toLowerCase() : '';
                if (nw === 'if' || nw === 'loop' || nw === 'case') k++; // consume nested-end qualifier
            }
        }
        return toks.length - 1;
    };

    // --- Structural-block collapse (ifElse / caseWhenThen / exceptionWhenThen) ---
    /**
     * Index of the `END` that closes the block currently open at `idx`, where `idx`
     * itself is NOT a block opener (e.g. the `EXCEPTION` keyword inside a `BEGIN`
     * block). Returns the matching enclosing `END`.
     */
    const enclosingEnd = (idx: number): number => {
        let depth = 0;
        for (let k = idx + 1; k < toks.length; k++) {
            const tk = toks[k];
            if (tk.type !== 'word') continue;
            const w2 = tk.text.toLowerCase();
            if (w2 === 'case' || w2 === 'if' || w2 === 'loop' || w2 === 'begin') depth++;
            else if (w2 === 'end') {
                if (depth === 0) return k;
                depth--;
                const nx = toks[k + 1];
                const nw = nx && nx.type === 'word' ? nx.text.toLowerCase() : '';
                if (nw === 'if' || nw === 'loop' || nw === 'case') k++;
            }
        }
        return toks.length - 1;
    };
    /** Count top-level `;` statement terminators in [a..b]. */
    const countStmts = (a: number, b: number): number => {
        let n = 0;
        for (let k = a; k <= b; k++) if (k >= 0 && k < toks.length && toks[k].text === ';') n++;
        return n;
    };
    /**
     * A structural block cannot be collapsed to one line if its body contains a
     * comment or a nested block construct (these forbidden keywords), because the
     * inline renderer would flatten them ambiguously.
     */
    const COLLAPSE_FORBIDDEN = new Set(['if', 'loop', 'begin', 'declare', 'case', 'exception']);
    const rangeBlocksCollapse = (a: number, b: number): boolean => {
        for (let k = a; k <= b; k++) {
            const tk = toks[k];
            if (!tk) continue;
            if (tk.type === 'lineComment' || tk.type === 'blockComment') return true;
            if (tk.type === 'word' && COLLAPSE_FORBIDDEN.has(tk.text.toLowerCase())) return true;
        }
        return false;
    };
    /** Should a structural block with `count` statements collapse onto one line? */
    const wantsCollapse = (count: number, key: ConstructKey): boolean => {
        const t = opt.thresholds[key] ?? DEFAULT_THRESHOLDS[key];
        return count >= 1 && count <= t.inlineMax;
    };

    // --- Operator chains (`+`, `-`, `*`, `/`, `||`) in an expression -----------
    // A long chain of binary arithmetic/concatenation operators is broken so that
    // each operator starts a new line (operator-leading), like a boolean group.
    // `opChainBreak` holds the indices of the operator tokens that should break.
    const opChainBreak = new Set<number>();
    {
        const isChainOp = (s: string): boolean =>
            s === '+' || s === '-' || s === '*' || s === '/' || s === '||';
        const endsOperand = (tk: Tok | null): boolean => {
            if (!tk) return false;
            if (tk.type === 'number' || tk.type === 'string' || tk.type === 'quotedIdent' || tk.type === 'param') return true;
            if (tk.text === ')' || tk.text === ']') return true;
            if (tk.type === 'word') {
                const w = tk.text.toLowerCase();
                if (w === 'end') return true;          // CASE … END
                return !KEYWORDS.has(w) || DATATYPES.has(w);
            }
            return false;
        };
        const startsOperand = (tk: Tok | null): boolean => {
            if (!tk) return false;
            if (tk.type === 'number' || tk.type === 'string' || tk.type === 'quotedIdent' || tk.type === 'param') return true;
            if (tk.text === '(') return true;
            if (tk.type === 'word') {
                const w = tk.text.toLowerCase();
                if (w === 'case' || w === 'not') return true;
                return !KEYWORDS.has(w) || DATATYPES.has(w);
            }
            return false;
        };
        type Acc = { ops: number[]; srcMulti: boolean };
        const finalize = (acc: Acc): void => {
            if (acc.ops.length >= 1 && wantsMultiline(acc.ops.length + 1, acc.srcMulti, 'operatorChains')) {
                for (const idx of acc.ops) opChainBreak.add(idx);
            }
            acc.ops = []; acc.srcMulti = false;
        };
        const stack: Acc[] = [{ ops: [], srcMulti: false }];
        for (let k = 0; k < toks.length; k++) {
            const tk = toks[k];
            if (tk.type === 'lineComment' || tk.type === 'blockComment') continue;
            // Treat an expression `CASE … END` as a single opaque operand.
            if (tk.type === 'word' && tk.text.toLowerCase() === 'case') { k = caseMatchEnd(k); continue; }
            if (tk.text === '(' || tk.text === '[') { stack.push({ ops: [], srcMulti: false }); continue; }
            if (tk.text === ')' || tk.text === ']') {
                finalize(stack[stack.length - 1]);
                if (stack.length > 1) stack.pop();
                continue;
            }
            const acc = stack[stack.length - 1];
            // A statement / list / clause boundary ends the current chain.
            if (tk.text === ';' || tk.text === ',') { finalize(acc); continue; }
            if (tk.type === 'word') {
                const w = tk.text.toLowerCase();
                if (CLAUSE_NEWLINE.has(w) || JOIN_WORDS.has(w) || w === 'into') { finalize(acc); continue; }
            }
            if (isChainOp(tk.text)) {
                if (endsOperand(sig(k, -1)) && startsOperand(sig(k, 1))) {
                    const ns = sig(k, 1);
                    if (tk.nlBefore >= 1 || (ns && ns.nlBefore >= 1)) acc.srcMulti = true;
                    acc.ops.push(k);
                } else {
                    finalize(acc); // unary sign / `SELECT *` / etc. — not a chain operator
                }
                continue;
            }
        }
        finalize(stack[0]);
    }

    /** Does any token in [a..b] start a new source line? */
    const rangeHasNewline = (a: number, b: number): boolean => {
        for (let k = a; k <= b; k++) if (k >= 0 && k < toks.length && toks[k].nlBefore >= 1) return true;
        return false;
    };
    /** Is this `FOR … IN <query> LOOP` a query loop (vs. an integer/range/array loop)? */
    const forLoopIsQuery = (forIdx: number): boolean => {
        for (let k = forIdx + 1; k < toks.length; k++) {
            if (depths[k] !== 0) continue;
            const tk = toks[k];
            if (tk.type !== 'word') continue;
            const w = tk.text.toLowerCase();
            if (w === 'loop') return false;
            if (w === 'select' || w === 'with' || w === 'values') return true;
        }
        return false;
    };
    /** Next CASE keyword in `names` at the top level (ignoring parens and nested CASE) within [from..to]. */
    const findCaseKeyword = (from: number, to: number, names: Set<string>): number => {
        let pd = 0, cd = 0;
        for (let k = from; k <= to; k++) {
            const tk = toks[k];
            if (tk.text === '(') pd++;
            else if (tk.text === ')') pd--;
            else if (tk.type === 'word' && pd === 0) {
                const w = tk.text.toLowerCase();
                if (w === 'case') cd++;
                else if (w === 'end') cd--;
                else if (cd === 0 && names.has(w)) return k;
            }
        }
        return -1;
    };
    /** Does the condition in [a..b] contain a top-level AND/OR (not the AND of a BETWEEN)? */
    const condHasTopLevelAndOr = (a: number, b: number): boolean => {
        let pd = 0, cd = 0, between = 0;
        for (let k = a; k <= b; k++) {
            const tk = toks[k];
            if (tk.text === '(') pd++;
            else if (tk.text === ')') pd--;
            else if (tk.type === 'word' && pd === 0) {
                const w = tk.text.toLowerCase();
                if (w === 'case') cd++;
                else if (w === 'end') cd--;
                else if (cd === 0) {
                    if (w === 'between') between++;
                    else if (w === 'or') return true;
                    else if (w === 'and') { if (between > 0) between--; else return true; }
                }
            }
        }
        return false;
    };
    /** Emit tokens [a..b] inline (with normal spacing/casing). */
    const emitRange = (a: number, b: number): void => {
        for (let k = a; k <= b; k++) emitInline(toks[k]);
    };
    /**
     * Emit a multi-condition WHEN clause, breaking before each top-level AND/OR.
     * In mixed OR/AND scopes, AND is indented one level deeper than OR so each
     * OR alternative stays on the base line and its AND parts hang underneath.
     */
    const renderCondMulti = (a: number, b: number, indent: number): void => {
        let pd = 0, cd = 0, between = 0;
        for (let k = a; k <= b; k++) {
            const tk = toks[k];
            let breakIndent: number | null = null;
            if (tk.type === 'word' && pd === 0) {
                const w = tk.text.toLowerCase();
                if (w === 'case') cd++;
                else if (w === 'end') cd--;
                else if (cd === 0) {
                    if (w === 'between') between++;
                    else if (w === 'or') breakIndent = indent;
                    else if (w === 'and') {
                        if (between > 0) between--;
                        else breakIndent = indent + (andDeepSet.has(k) ? 1 : 0);
                    }
                }
            }
            if (tk.text === '(') pd++;
            else if (tk.text === ')') pd--;
            if (breakIndent !== null) startLine(breakIndent, 0);
            emitInline(tk);
        }
    };
    /** Render a multiline CASE expression (caseIdx..caseEnd) as structured lines. */
    const renderCaseBody = (caseIdx: number, caseEnd: number): void => {
        emitInline(toks[caseIdx]); // CASE (attaches to the current line)
        const caseIndent = lineIndent;
        const whenIndent = caseIndent + 1;
        const deepIndent = caseIndent + 2;
        let k = caseIdx + 1;
        while (k < caseEnd) {
            const tk = toks[k];
            const w = tk.type === 'word' ? tk.text.toLowerCase() : '';
            if (w === 'when') {
                const thenIdx = findCaseKeyword(k + 1, caseEnd, new Set(['then']));
                const clauseEnd = thenIdx >= 0 ? findCaseKeyword(thenIdx + 1, caseEnd, new Set(['when', 'else'])) : -1;
                const resEnd = (clauseEnd >= 0 ? clauseEnd : caseEnd) - 1;
                const multiCond = thenIdx > k + 1 && condHasTopLevelAndOr(k + 1, thenIdx - 1);
                const clauseSingle = !rangeHasNewline(k + 1, resEnd);
                startLine(whenIndent, blanksFor(tk));
                emitInline(tk); // WHEN
                if (thenIdx < 0) { emitRange(k + 1, resEnd); k = clauseEnd >= 0 ? clauseEnd : caseEnd; continue; }
                if (multiCond) {
                    renderCondMulti(k + 1, thenIdx - 1, deepIndent);
                    startLine(whenIndent, 0); emitInline(toks[thenIdx]); // THEN on its own line
                    startLine(deepIndent, 0); emitResult(thenIdx + 1, resEnd);
                } else {
                    emitRange(k + 1, thenIdx - 1); // condition inline
                    emitInline(toks[thenIdx]); // THEN inline
                    if (clauseSingle) emitResult(thenIdx + 1, resEnd);
                    else { startLine(deepIndent, 0); emitResult(thenIdx + 1, resEnd); }
                }
                k = clauseEnd >= 0 ? clauseEnd : caseEnd;
            } else if (w === 'else') {
                const resEnd = caseEnd - 1;
                startLine(whenIndent, blanksFor(tk));
                emitInline(tk); // ELSE
                if (!rangeHasNewline(k + 1, resEnd)) emitResult(k + 1, resEnd);
                else { startLine(deepIndent, 0); emitResult(k + 1, resEnd); }
                k = caseEnd;
            } else if (tk.type === 'lineComment' || tk.type === 'blockComment') {
                startLine(whenIndent, blanksFor(tk));
                out.push((indentStr(whenIndent) + tk.text).replace(/\s+$/, ''));
                prev = null; pendingIndent = whenIndent;
                k++;
            } else {
                emitInline(tk); k++;
            }
        }
        startLine(caseIndent, blanksFor(toks[caseEnd]));
        emitInline(toks[caseEnd]); // END (left in `cur` so a trailing alias attaches)
    };
    /**
     * Emit a CASE branch result expression [a..b] inline, but render a nested
     * multiline CASE…END as its own structured block (recursively) instead of
     * flattening it onto a single line.
     */
    const emitResult = (a: number, b: number): void => {
        let k = a;
        while (k <= b) {
            const tk = toks[k];
            if (tk.type === 'word' && tk.text.toLowerCase() === 'case') {
                const end = caseMatchEnd(k);
                const after = toks[end + 1];
                const stmtForm = !!after && after.type === 'word' && after.text.toLowerCase() === 'case';
                if (end <= b && !stmtForm && rangeHasNewline(k + 1, end)) {
                    renderCaseBody(k, end);
                    k = end + 1;
                    continue;
                }
            }
            emitInline(tk);
            k++;
        }
    };

    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        const blanks = blanksFor(t);
        const pd = depths[i];
        const inSql = parenStack.length === 0 ? true : (parenStack[parenStack.length - 1].kind === 'subquery' || parenStack[parenStack.length - 1].kind === 'boolgroup');

        // --- Comments -------------------------------------------------------
        if (t.type === 'lineComment') {
            if (cur !== '' && t.nlBefore === 0) {
                // Trailing comment on the same source line as pending content: keep it attached.
                cur += '  ' + t.text; flush();
            } else if (cur === '' && t.nlBefore === 0 && out.length > 0) {
                // A trailing comment authored on the same line (e.g. after `;`)
                // stays attached to that line instead of moving to a new one.
                out[out.length - 1] = (out[out.length - 1] + '  ' + t.text).replace(/\s+$/, '');
            } else {
                // Comment on its own source line: flush any pending content first,
                // then emit the comment on a fresh line at the current indent.
                if (cur !== '') flush();
                insertBlanks(blanks); lineIndent = pendingIndent; out.push((indentStr(lineIndent) + t.text).replace(/\s+$/, ''));
            }
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
            const looksLikeCode = !!m && dollarBodyIsCode(inner);
            if (looksLikeCode) {
                // A PL/pgSQL block body (BEGIN/DECLARE) keeps its content at the
                // same level as the tags (e.g. `AS $BODY$` / `DECLARE` / `$BODY$`).
                // A SQL statement template (e.g. `format($query$ SELECT … $query$)`)
                // aligns its opening and closing tags and indents the body one
                // level deeper so the embedded query stands out.
                const isBlock = /\b(begin|declare)\b/i.test(inner);
                emit(tag, { text: tag, isKeyword: false, type: 'operator' });
                const tagIndent = lineIndent;
                flush();
                const innerFmt = formatSqlOnce(inner.replace(/^\s*\n/, '').replace(/\s+$/, ''), opt);
                const bodyIndent = isBlock ? blockIndent : tagIndent + 1;
                // Continuation lines of a multi-line string literal carry the
                // literal's payload and must not be shifted by the indentation.
                const innerLines = innerFmt.split('\n');
                const inLiteral = literalContinuationLines(innerFmt);
                for (let k = 0; k < innerLines.length; k++) {
                    const ln = innerLines[k];
                    out.push(ln === '' || inLiteral[k] ? ln : indentStr(bodyIndent) + ln);
                }
                const closeIndent = isBlock ? blockIndent : tagIndent;
                lineIndent = closeIndent;
                pendingIndent = closeIndent;
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
            // Exception: if the param-list threshold demands multi-line output, skip the
            // shortcut so the threshold takes effect even for originally single-line headers.
            if (opt.preserveSingleLineRoutineHeaders
                && w === 'create' && pd === 0 && parenStack.length === 0 && cur === '') {
                const end = singleLineRoutineEnd(i);
                if (end >= 0) {
                    let paramListWantsMultiline = false;
                    for (let k = i + 1; k <= end; k++) {
                        if (toks[k].text === '(' && routineParenSet.has(k)) {
                            const info = parenInfo.get(k);
                            if (info && info.multiline) paramListWantsMultiline = true;
                            break;
                        }
                    }
                    if (!paramListWantsMultiline) {
                        startLine(blockIndent, blanks);
                        for (let k = i; k <= end; k++) emitInline(toks[k]);
                        flush();
                        pendingIndent = blockIndent;
                        lastWord = ''; i = end; continue;
                    }
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

            // CASE *expressions*: a single-line CASE stays inline; a multiline CASE
            // is formatted (WHEN per line, etc.). The PL/pgSQL `CASE … END CASE`
            // statement form is left to the block handling below.
            if (w === 'case') {
                const caseEnd = caseMatchEnd(i);
                const after = toks[caseEnd + 1];
                const stmtForm = !!after && after.type === 'word' && after.text.toLowerCase() === 'case';
                if (!stmtForm) {
                    if (rangeHasNewline(i + 1, caseEnd)) renderCaseBody(i, caseEnd);
                    else emitRange(i, caseEnd);
                    i = caseEnd; lastWord = 'end'; continue;
                }
            }

            // PL/pgSQL block structure (top level only)
            if (pd === 0) {
                // MERGE statement: `MERGE` on its own line; each `WHEN [NOT] MATCHED
                // … THEN` clause and the closing `;` sit at the same (MERGE) level,
                // with the THEN action (UPDATE/INSERT/DELETE) indented one level deeper.
                if (w === 'merge' && cur === '') {
                    startLine(blockIndent, blanks); emit(rendered, meta); flush();
                    mergeIndent = blockIndent;
                    pendingIndent = blockIndent;
                    lastWord = w; continue;
                }
                if (mergeIndent !== null && w === 'when') {
                    blockIndent = mergeIndent;
                    startLine(mergeIndent, blanks); emit(rendered, meta);
                    // Remember the current line count so THEN can tell whether the
                    // WHEN condition ended up spanning multiple lines.
                    mergeWhenStart = out.length;
                    lastWord = w; continue;
                }
                if (mergeIndent !== null && w === 'then' && !expectThen && !exceptionThen
                    && blocks[blocks.length - 1]?.type !== 'case') {
                    // If the WHEN condition broke across several lines, put THEN on its
                    // own line at the WHEN level (like a multi-line IF); otherwise keep
                    // it on the WHEN line.
                    const condBroke = mergeWhenStart >= 0 && out.length > mergeWhenStart;
                    if (condBroke) { startLine(mergeIndent, blanks); emit(rendered, meta); flush(); }
                    else { emit(rendered, meta); flush(); }
                    mergeWhenStart = -1;
                    // Indent the THEN action (UPDATE/INSERT/DELETE, incl. SET/VALUES)
                    // one level deeper than the WHEN clause.
                    blockIndent = mergeIndent + 1;
                    pendingIndent = mergeIndent + 1;
                    lastWord = w; continue;
                }

                // CASE *statement* form (`CASE … END CASE` with statement bodies).
                // CASE/END CASE sit at the block indent, each WHEN/ELSE one level
                // deeper, and the branch body (assignments, nested IF/LOOP, …) one
                // level deeper still — with the body starting on the line after THEN.
                if (w === 'case') {
                    // Collapse a small `CASE … END CASE;` statement onto one line when configured.
                    const endKw = caseMatchEnd(i);
                    let spanEnd = endKw;
                    if (toks[endKw + 1]?.type === 'word' && toks[endKw + 1].text.toLowerCase() === 'case') spanEnd = endKw + 1;
                    if (toks[spanEnd + 1]?.text === ';') spanEnd++;
                    if (wantsCollapse(countStmts(i + 1, endKw - 1), 'caseWhenThen')
                        && !rangeBlocksCollapse(i + 1, endKw - 1)) {
                        startLine(blockIndent, blanks);
                        for (let k = i; k <= spanEnd; k++) emitInline(toks[k]);
                        flush();
                        pendingIndent = blockIndent;
                        lastWord = ''; i = spanEnd; continue;
                    }
                    startLine(blockIndent, blanks); emit(rendered, meta);
                    blocks.push({ type: 'case', head: blockIndent });
                    lastWord = w; continue;
                }
                if (blocks[blocks.length - 1]?.type === 'case') {
                    const f = blocks[blocks.length - 1];
                    if (w === 'when') {
                        startLine(f.head + 1, blanks); emit(rendered, meta);
                        lastWord = w; continue;
                    }
                    if (w === 'then') {
                        emit(rendered, meta); flush();
                        blockIndent = f.head + 2; pendingIndent = blockIndent;
                        lastWord = w; continue;
                    }
                    if (w === 'else') {
                        startLine(f.head + 1, blanks); emit(rendered, meta); flush();
                        blockIndent = f.head + 2; pendingIndent = blockIndent;
                        lastWord = w; continue;
                    }
                    if (w === 'end') {
                        blocks.pop();
                        blockIndent = f.head;
                        startLine(blockIndent, blanks); emit(rendered, meta);
                        const nx = toks[i + 1];
                        if (nx && nx.type === 'word' && nx.text.toLowerCase() === 'case') {
                            const rj = applyCase(nx.text, opt.keywordCase);
                            emit(rj, { text: rj, isKeyword: true, type: 'word' });
                            i++;
                        }
                        pendingIndent = blockIndent;
                        lastWord = w; continue;
                    }
                }
                // EXCEPTION block (start of an exception handler section)
                if (w === 'exception' && cur === '') {
                    const bf = nearestBegin();
                    if (bf) {
                        // Collapse a small exception section (`EXCEPTION WHEN … THEN …;`)
                        // onto one line when configured. The enclosing BEGIN's END stays
                        // on its own line and is handled by the normal END handler.
                        const sectionEnd = enclosingEnd(i) - 1;
                        if (wantsCollapse(countStmts(i + 1, sectionEnd), 'exceptionWhenThen')
                            && !rangeBlocksCollapse(i + 1, sectionEnd)) {
                            startLine(bf.head, blanks);
                            for (let k = i; k <= sectionEnd; k++) emitInline(toks[k]);
                            flush();
                            blockIndent = bf.head; pendingIndent = blockIndent;
                            lastWord = ''; i = sectionEnd; continue;
                        }
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
                    // Keep a fully single-line *simple* IF on one line (like single-line routines).
                    const endKw = caseMatchEnd(i);
                    let spanEnd = endKw;
                    if (toks[endKw + 1]?.type === 'word' && toks[endKw + 1].text.toLowerCase() === 'if') spanEnd = endKw + 1;
                    if (toks[spanEnd + 1]?.text === ';') spanEnd++;
                    if (opt.preserveSingleLineIfBlocks
                        && isSingleSourceLineRange(i, spanEnd)
                        && !ifHasTopLevelElseBranch(i, endKw)
                        && !rangeBlocksCollapse(i + 1, endKw - 1)) {
                        startLine(blockIndent, blanks);
                        for (let k = i; k <= spanEnd; k++) emitInline(toks[k]);
                        flush();
                        pendingIndent = blockIndent;
                        lastWord = ''; i = spanEnd; continue;
                    }
                    // Collapse a small `IF … END IF;` onto one line when configured.
                    if (wantsCollapse(countStmts(i + 1, endKw - 1), 'ifElse')
                        && !rangeBlocksCollapse(i + 1, endKw - 1)) {
                        startLine(blockIndent, blanks);
                        for (let k = i; k <= spanEnd; k++) emitInline(toks[k]);
                        flush();
                        pendingIndent = blockIndent;
                        lastWord = ''; i = spanEnd; continue;
                    }
                    startLine(blockIndent, blanks); emit(rendered, meta);
                    expectThen = true; ifCondBroke = false; blocks.push({ type: 'if', head: blockIndent });
                    lastWord = w; continue;
                }
                if ((w === 'elsif' || w === 'elseif') && nearestIf()) {
                    const f = nearestIf()!;
                    startLine(f.head, blanks); emit(rendered, meta);
                    expectThen = true; ifCondBroke = false; lastWord = w; continue;
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
                    const head = (f ? f.head : blockIndent);
                    // If the condition was broken across multiple lines (AND/OR on
                    // their own lines), put THEN on its own line at the IF level.
                    if (ifCondBroke) { startLine(head, blanks); emit(rendered, meta); flush(); }
                    else { emit(rendered, meta); flush(); }
                    blockIndent = head + 1; pendingIndent = blockIndent;
                    expectThen = false; ifCondBroke = false; lastWord = w; continue;
                }
                // Query `FOR … IN <SELECT …> LOOP`: keep `FOR … IN` on its own line and
                // indent the query (SELECT/FROM/WHERE/…) one level deeper. The matching
                // LOOP is dedented back to the FOR level by the LOOP handler below.
                if (w === 'for' && cur === '' && forLoopIsQuery(i)) {
                    startLine(blockIndent, blanks); emit(rendered, meta);
                    forHeaderIndent = blockIndent;
                    blockIndent++; pendingIndent = blockIndent;
                    lastWord = w; continue;
                }
                if (w === 'loop') {
                    if (forHeaderIndent !== null) {
                        // Query `FOR … IN <SELECT …> LOOP`: dedent LOOP back to the
                        // FOR level and put it on its own line (the query above it was
                        // indented one level deeper).
                        blockIndent = forHeaderIndent;
                        startLine(blockIndent, blanks); emit(rendered, meta); flush();
                        blocks.push({ type: 'loop', head: blockIndent });
                        blockIndent++; pendingIndent = blockIndent;
                        forHeaderIndent = null;
                        lastWord = w; continue;
                    }
                    emit(rendered, meta); flush();
                    blocks.push({ type: 'loop', head: blockIndent });
                    blockIndent++; pendingIndent = blockIndent; lastWord = w; continue;
                }
            }

            // JOINs (only inside an actual SQL context)
            if (JOIN_WORDS.has(w) && inSql) {
                joinRiver = false;
                popLists(pd);
                if (JOIN_WORDS.has(lastWord) || lastWord === 'outer') emit(rendered, meta);
                else { startLine(blockIndent + pd, blanks); emit(rendered, meta); }
                lastWord = w; continue;
            }

            // SQL clause keywords (only inside an actual SQL context)
            if (CLAUSE_NEWLINE.has(w) && inSql) {
                joinRiver = false;
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
                    const selInfo = clauseListInfo(i, true);
                    if (!wantsMultiline(selInfo.count, selInfo.srcMulti, 'selectColumns')) {
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

                // Old-style comma FROM list (FROM a, b, c): keep it broken across
                // lines only if the author already spread it over several source
                // lines; a single-line list stays on one line.
                if (w === 'from') {
                    const info = clauseListInfo(i);
                    if (wantsMultiline(info.count, info.srcMulti, 'fromTables')) {
                        lists.push({ depth: pd, indent: clauseIndent + 1 });
                        pendingIndent = clauseIndent + 1;
                        flush();
                        lastWord = w; continue;
                    }
                }

                // GROUP BY / ORDER BY enumerations: consume the BY keyword and wrap
                // the item list per its own threshold (groupByColumns / orderByColumns).
                if (w === 'group' || w === 'order') {
                    const by = toks[i + 1];
                    if (by && by.type === 'word' && by.text.toLowerCase() === 'by') {
                        emit(applyCase(by.text, opt.keywordCase), { text: by.text, isKeyword: true, type: 'word' });
                        i++;
                    }
                    const key: ConstructKey = w === 'group' ? 'groupByColumns' : 'orderByColumns';
                    const info = clauseListInfo(i);
                    if (wantsMultiline(info.count, info.srcMulti, key)) {
                        lists.push({ depth: pd, indent: clauseIndent + 1 });
                        pendingIndent = clauseIndent + 1;
                        flush();
                        lastWord = w; continue;
                    }
                    pendingIndent = clauseIndent + 1;
                    lastWord = w; continue;
                }

                pendingIndent = clauseIndent + 1;
                lastWord = w; continue;
            }

            if (w === 'into' && inSql && lastWord !== 'insert') {
                // SELECT ... INTO / RETURNING ... INTO: INTO starts its own line.
                joinRiver = false;
                const clauseIndent = blockIndent + pd;
                popLists(pd);
                betweenPending = 0;
                startLine(clauseIndent, blanks); emit(rendered, meta);
                const nx = toks[i + 1];
                if (nx && nx.type === 'word' && nx.text.toLowerCase() === 'strict') {
                    emit(applyCase(nx.text, opt.keywordCase), { text: nx.text, isKeyword: true, type: 'word' });
                    i++;
                }
                const intoInfo = clauseListInfo(i, true);
                if (wantsMultiline(intoInfo.count, intoInfo.srcMulti, 'selectColumns')) {
                    lists.push({ depth: pd, indent: clauseIndent + 1 });
                    pendingIndent = clauseIndent + 1;
                    flush();
                } else {
                    pendingIndent = clauseIndent + 1;
                }
                lastWord = 'into'; continue;
            }
            if (w === 'into' && inSql) popLists(pd);

            // ON of a multi-line JOIN condition: put it on its own line and
            // right-align the ON / AND / OR keywords so the conditions line up
            // underneath (river style). The leading space makes the 2-char "ON"
            // align with the 3-char "AND" used by the following conditions.
            if (w === 'on' && inSql && joinOnBreakSet.has(i)) {
                startLine(blockIndent + pd + 1, blanks);
                emit(' ' + rendered, meta);
                joinRiver = true;
                lastWord = w; continue;
            }

            // AND on its own line within a SQL condition (except the AND that belongs to BETWEEN).
            if (w === 'and' && inSql) {
                if (betweenPending > 0) {
                    betweenPending--;
                    emit(rendered, meta); lastWord = w; continue;
                }
                if (condInlineSet.has(i)) { emit(rendered, meta); lastWord = w; continue; }
                if (expectThen) ifCondBroke = true;
                // In a scope that mixes AND and OR, indent the AND one level deeper
                // than the OR so it hangs under its OR alternative. This now also
                // applies inside JOIN ... ON conditions.
                const andExtra = andDeepSet.has(i) ? 1 : 0;
                startLine(blockIndent + pd + 1 + andExtra, blanks); emit(rendered, meta);
                lastWord = w; continue;
            }
            // OR on its own line within a SQL condition (but not in CREATE OR REPLACE).
            if (w === 'or' && inSql && lastWord !== 'create') {
                if (condInlineSet.has(i)) { emit(rendered, meta); lastWord = w; continue; }
                if (expectThen) ifCondBroke = true;
                startLine(blockIndent + pd + 1, blanks);
                emit(joinRiver ? ' ' + rendered : rendered, meta);
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
            if (top && top.depth === pd && (top.bdepth ?? 0) === bracketDepth) {
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
            joinRiver = false;
            if (mergeIndent !== null && pd === 0) {
                // Close the MERGE statement: the `;` gets its own line at the MERGE level.
                flush();
                blockIndent = mergeIndent;
                lineIndent = mergeIndent;
                pendingIndent = mergeIndent;
                emit(';', { text: ';', isKeyword: false, type: 'punct' });
                flush();
                pendingIndent = blockIndent;
                lastWord = '';
                inRoutineTrailer = false;
                mergeIndent = null;
                continue;
            }
            emit(';', { text: ';', isKeyword: false, type: 'punct' });
            if (pd === 0) {
                flush();
                pendingIndent = blockIndent;
                lastWord = '';
                inRoutineTrailer = false;
            }
            continue;
        }

        if (t.text === '[') {
            const info = bracketInfo.get(i);
            const multiline = info ? info.multiline : false;
            emit('[', { text: '[', isKeyword: false, type: 'punct' });
            bracketDepth++;
            const openIndent = lineIndent;
            bracketStack.push({ multiline, openIndent });
            if (multiline) {
                flush();
                pendingIndent = openIndent + 1;
                lists.push({ depth: pd, indent: openIndent + 1, bdepth: bracketDepth });
            }
            continue;
        }
        if (t.text === ']') {
            const frame = bracketStack.pop();
            while (lists.length && (lists[lists.length - 1].bdepth ?? 0) === bracketDepth) lists.pop();
            bracketDepth = Math.max(0, bracketDepth - 1);
            if (frame && frame.multiline) {
                startLine(frame.openIndent, 0);
                emit(']', { text: ']', isKeyword: false, type: 'punct' });
            } else {
                emit(']', { text: ']', isKeyword: false, type: 'punct' });
            }
            continue;
        }

        if (t.text === '(') {
            const info = parenInfo.get(i);
            const kind: ParenKind = info ? info.kind : 'group';
            const multiline = info ? info.multiline : false;
            if ((kind === 'typemod' || returnsTableParenSet.has(i)) && cur !== '') {
                // No space between a data type and its modifier, e.g. VARCHAR(500),
                // nor between TABLE and its column list in `RETURNS TABLE(...)`.
                cur += '(';
                prev = { text: '(', isKeyword: false, type: 'punct' };
            } else {
                emit('(', { text: '(', isKeyword: false, type: 'punct' });
            }
            const openIndent = lineIndent;
            // For subqueries, adjust blockIndent so that clause keywords inside
            // (SELECT, FROM, WHERE …) are indented one level deeper than the opening `(`.
            // The formula blockIndent = openIndent - depths[i] ensures that
            // clauseIndent = blockIndent + pd_inside = openIndent + 1.
            const savedBlockIndent = kind === 'subquery' ? blockIndent : undefined;
            if (kind === 'subquery') blockIndent = openIndent - depths[i];
            parenStack.push({ kind, multiline, openIndent, savedBlockIndent });
            if (multiline) {
                if (kind === 'subquery') {
                    flush(); pendingIndent = openIndent + 1;
                } else if (kind === 'boolgroup') {
                    // Boolean group: operands/operators break onto their own lines,
                    // indented one level under the opening parenthesis.
                    flush(); pendingIndent = openIndent + 1;
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
            if (frame && frame.savedBlockIndent !== undefined) blockIndent = frame.savedBlockIndent;
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
        if (opChainBreak.has(i)) {
            // Break a long operator chain so each operator leads its own line.
            startLine(blockIndent + pd + 1, 0);
            emit(t.text, { text: t.text, isKeyword: false, type: t.type });
            continue;
        }
        emit(t.text, { text: t.text, isKeyword: false, type: t.type });
        continue;
    }

    flush();

    /** Emit a raw token inline (used while greedily consuming sub-runs). */
    function emitInline(tk: Tok): void {
        if (tk.type === 'lineComment') {
            // A line comment runs to the end of its physical line, so anything
            // emitted after it on the same output line would be swallowed by the
            // comment. Append it to the current line, then force a newline so the
            // following tokens continue on a fresh line at the same indent.
            emit(tk.text, { text: tk.text, isKeyword: false, type: 'comment' });
            pendingIndent = lineIndent;
            flush();
            return;
        }
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

    let result = stripTrailingWhitespacePreservingLiterals(out.join('\n'));
    if (opt.blankLines === 'collapse') result = result.replace(/\n{3,}/g, '\n\n');
    result = result.replace(/^\n+/, '').replace(/\n+$/, '');
    return trailingNewline ? result + '\n' : result;
}
