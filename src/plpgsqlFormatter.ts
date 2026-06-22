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
}

export const DEFAULT_FORMAT_OPTIONS: FormatOptions = {
    keywordCase: 'upper',
    identifierCase: 'preserve',
    dataTypeCase: 'upper',
    indentStyle: 'space',
    indentSize: 2,
    commaStyle: 'trailing'
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
}): FormatOptions {
    const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
        typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
    const size = typeof raw.indentSize === 'number' && raw.indentSize >= 1 && raw.indentSize <= 8
        ? Math.floor(raw.indentSize)
        : DEFAULT_FORMAT_OPTIONS.indentSize;
    return {
        keywordCase: pick(raw.keywordCase, ['upper', 'lower', 'preserve'], DEFAULT_FORMAT_OPTIONS.keywordCase),
        identifierCase: pick(raw.identifierCase, ['upper', 'lower', 'preserve'], DEFAULT_FORMAT_OPTIONS.identifierCase),
        dataTypeCase: pick(raw.dataTypeCase, ['upper', 'lower', 'preserve'], DEFAULT_FORMAT_OPTIONS.dataTypeCase),
        indentStyle: pick(raw.indentStyle, ['space', 'tab'], DEFAULT_FORMAT_OPTIONS.indentStyle),
        indentSize: size,
        commaStyle: pick(raw.commaStyle, ['trailing', 'leading'], DEFAULT_FORMAT_OPTIONS.commaStyle)
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
    'new', 'old', 'before', 'after', 'instead', 'each', 'statement'
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

/** Clause keywords that start a fresh line within a SQL statement. */
const CLAUSE_NEWLINE = new Set([
    'select', 'from', 'where', 'group', 'order', 'having', 'limit', 'offset',
    'fetch', 'window', 'returning', 'values', 'union', 'intersect', 'except',
    'with', 'set'
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

/**
 * Format a PL/pgSQL / SQL string according to `options`.
 */
export function formatSql(input: string, options?: Partial<FormatOptions>): string {
    const opt: FormatOptions = { ...DEFAULT_FORMAT_OPTIONS, ...(options || {}) };
    const trailingNewline = /\n\s*$/.test(input);
    const toks = tokenize(input);
    const depths = computeDepths(toks);

    const out: string[] = [];
    let cur = '';
    let prev: TokMeta | null = null;
    let lineIndent = 0;
    let pendingIndent = 0;
    let blockIndent = 0;
    let lastWord = '';
    let expectThen = false;
    const blocks: string[] = [];
    const lists: { depth: number; indent: number }[] = [];
    const parens: { subquery: boolean; indent: number }[] = [];

    const indentStr = (level: number): string =>
        opt.indentStyle === 'tab' ? '\t'.repeat(Math.max(0, level)) : ' '.repeat(Math.max(0, level) * opt.indentSize);

    const flush = (): void => {
        if (cur !== '') {
            out.push((indentStr(lineIndent) + cur).replace(/\s+$/, ''));
            cur = '';
            prev = null;
        }
    };

    const blankLine = (): void => {
        if (out.length === 0 || out[out.length - 1].trim() !== '') out.push('');
    };

    const startLine = (indent: number, blank: boolean): void => {
        flush();
        if (blank) blankLine();
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

    const nextSignificant = (idx: number): Tok | null => {
        let j = idx + 1;
        while (j < toks.length && (toks[j].type === 'lineComment' || toks[j].type === 'blockComment')) j++;
        return j < toks.length ? toks[j] : null;
    };

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

    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        const blank = t.nlBefore >= 2;
        const pd = depths[i];

        // --- Comments -------------------------------------------------------
        if (t.type === 'lineComment') {
            if (cur !== '') { cur += '  ' + t.text; flush(); }
            else { lineIndent = pendingIndent; out.push((indentStr(lineIndent) + t.text).replace(/\s+$/, '')); }
            prev = null;
            continue;
        }
        if (t.type === 'blockComment') {
            if (t.text.includes('\n')) {
                flush();
                if (blank) blankLine();
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
                const bodyIndent = blockIndent + 1;
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

            // PL/pgSQL block structure (top level only)
            if (pd === 0) {
                // Track CASE *expressions* so their WHEN/ELSE/END are not
                // mistaken for IF/block control flow.
                if (w === 'case') {
                    blocks.push('case');
                    emit(rendered, meta);
                    lastWord = w; continue;
                }
                if (blocks[blocks.length - 1] === 'case') {
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
                    // WHEN / THEN / ELSE inside a CASE expression stay inline.
                    if (w === 'when' || w === 'then' || w === 'else') {
                        emit(rendered, meta);
                        lastWord = w; continue;
                    }
                }
                if (w === 'declare') {
                    startLine(blockIndent, blank); emit(rendered, meta); flush();
                    blockIndent++; pendingIndent = blockIndent; blocks.push('declare');
                    lastWord = w; continue;
                }
                if (w === 'begin') {
                    if (blocks[blocks.length - 1] === 'declare') { blocks.pop(); blockIndent = Math.max(0, blockIndent - 1); }
                    startLine(blockIndent, blank); emit(rendered, meta); flush();
                    blockIndent++; pendingIndent = blockIndent; blocks.push('begin');
                    lists.length = 0; lastWord = w; continue;
                }
                if (w === 'end') {
                    blockIndent = Math.max(0, blockIndent - 1);
                    if (blocks.length) blocks.pop();
                    startLine(blockIndent, blank); emit(rendered, meta);
                    pendingIndent = blockIndent;
                    const nx = toks[i + 1];
                    if (nx && nx.type === 'word' && ['if', 'loop', 'case'].includes(nx.text.toLowerCase())) {
                        const rj = applyCase(nx.text, opt.keywordCase);
                        emit(rj, { text: rj, isKeyword: true, type: 'word' });
                        i++;
                    }
                    lastWord = w; continue;
                }
                if (w === 'if') {
                    startLine(blockIndent, blank); emit(rendered, meta);
                    expectThen = true; blocks.push('if'); lastWord = w; continue;
                }
                if (w === 'elsif' || w === 'elseif') {
                    blockIndent = Math.max(0, blockIndent - 1);
                    startLine(blockIndent, blank); emit(rendered, meta);
                    expectThen = true; lastWord = w; continue;
                }
                if (w === 'else') {
                    blockIndent = Math.max(0, blockIndent - 1);
                    startLine(blockIndent, blank); emit(rendered, meta); flush();
                    blockIndent++; pendingIndent = blockIndent; lastWord = w; continue;
                }
                if (w === 'then' && expectThen) {
                    emit(rendered, meta); flush();
                    blockIndent++; pendingIndent = blockIndent; expectThen = false; lastWord = w; continue;
                }
                if (w === 'loop') {
                    emit(rendered, meta); flush();
                    blockIndent++; pendingIndent = blockIndent; blocks.push('loop'); lastWord = w; continue;
                }
            }

            // JOINs
            if (JOIN_WORDS.has(w)) {
                popLists(pd);
                if (JOIN_WORDS.has(lastWord) || lastWord === 'outer') emit(rendered, meta);
                else { startLine(blockIndent + pd, blank); emit(rendered, meta); }
                lastWord = w; continue;
            }

            // SQL clause keywords
            if (CLAUSE_NEWLINE.has(w)) {
                const clauseIndent = blockIndent + pd;
                popLists(pd);
                startLine(clauseIndent, blank); emit(rendered, meta);

                if (w === 'select') {
                    // Keep DISTINCT / ALL (and DISTINCT ON (...)) on the SELECT line.
                    while (true) {
                        const nx = toks[i + 1];
                        if (nx && nx.type === 'word' && ['distinct', 'all'].includes(nx.text.toLowerCase())) {
                            const isDistinct = nx.text.toLowerCase() === 'distinct';
                            emit(applyCase(nx.text, opt.keywordCase), { text: nx.text, isKeyword: true, type: 'word' });
                            i++;
                            if (isDistinct && toks[i + 1] && toks[i + 1].type === 'word' && toks[i + 1].text.toLowerCase() === 'on') {
                                emit(applyCase(toks[i + 1].text, opt.keywordCase), { text: 'on', isKeyword: true, type: 'word' });
                                i++;
                                // consume balanced (...)
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
                    // `SELECT *` (bare star) stays on one line.
                    const star = toks[i + 1];
                    if (star && star.text === '*' && isClauseOrEnd(nextSignificant(i + 1))) {
                        emit('*', { text: '*', isKeyword: false, type: 'operator' });
                        i++;
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

            if (w === 'into') popLists(pd);

            emit(rendered, meta);
            lastWord = w;
            continue;
        }

        // --- Punctuation ----------------------------------------------------
        if (t.text === ',') {
            const top = lists[lists.length - 1];
            if (top && top.depth === pd) {
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
            emit(';', { text: ';', isKeyword: false, type: 'punct' });
            if (pd === 0) {
                flush();
                pendingIndent = blockIndent;
                lastWord = '';
            }
            continue;
        }

        if (t.text === '(') {
            const sub = (() => {
                const ns = nextSignificant(i);
                return !!(ns && ns.type === 'word' && ['select', 'with', 'values'].includes(ns.text.toLowerCase()));
            })();
            emit('(', { text: '(', isKeyword: false, type: 'punct' });
            const openIndent = lineIndent;
            parens.push({ subquery: sub, indent: openIndent });
            if (sub) { flush(); pendingIndent = openIndent; }
            continue;
        }

        if (t.text === ')') {
            const frame = parens.pop();
            popLists(pd + 1);
            if (frame && frame.subquery) {
                startLine(frame.indent, false);
                emit(')', { text: ')', isKeyword: false, type: 'punct' });
            } else {
                emit(')', { text: ')', isKeyword: false, type: 'punct' });
            }
            continue;
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
    // Collapse 3+ consecutive blank lines down to a single blank line.
    result = result.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '');
    return trailingNewline ? result + '\n' : result;
}
