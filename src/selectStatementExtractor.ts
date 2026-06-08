/**
 * Pure helpers to extract a runnable SELECT statement from a PL/pgSQL
 * procedure/function body and to find the "variables" used in it.
 *
 * These functions contain no `vscode` dependency so they can be unit tested
 * with plain `node --test`.
 *
 * The general strategy is:
 *  1. Build a "masked" copy of the SQL where comments and string / dollar-quoted
 *     literals are replaced by spaces (length preserved). Scanning happens on the
 *     masked text so semicolons / keywords / identifiers inside literals are
 *     ignored, while names are read back from the same indices (identifiers are
 *     never masked, so masked === original for identifier spans).
 *  2. Tokenize the masked text into words / params / punctuation / operators,
 *     tracking parenthesis depth.
 *  3. Use the token stream to locate statement boundaries, the SELECT/WITH start,
 *     strip the INTO clause, and classify which identifiers are value
 *     "variables" (as opposed to keywords, columns qualified by a dot, function
 *     calls or table names).
 */

/** Session value keywords that should always be offered for substitution. */
const BUILTIN_VALUE_KEYWORDS = new Set([
    'current_user',
    'user',
    'session_user',
    'current_role',
    'current_catalog'
]);

/** SQL keywords / type names that are never treated as substitutable variables. */
const SQL_KEYWORDS = new Set([
    'select', 'from', 'where', 'and', 'or', 'not', 'null', 'true', 'false',
    'join', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'on', 'using',
    'group', 'by', 'having', 'order', 'asc', 'desc', 'nulls', 'last',
    'limit', 'offset', 'fetch', 'first', 'next', 'row', 'rows', 'only',
    'union', 'all', 'intersect', 'except', 'as', 'distinct',
    'case', 'when', 'then', 'else', 'end', 'in', 'is', 'like', 'ilike',
    'similar', 'to', 'between', 'exists', 'any', 'some',
    'with', 'recursive', 'into', 'strict', 'values', 'returning',
    'insert', 'update', 'delete', 'set', 'lateral', 'for', 'of', 'nowait',
    'share', 'at', 'time', 'zone', 'local', 'collate', 'over', 'partition',
    'window', 'filter', 'within', 'cast', 'interval',
    'date', 'timestamp', 'timestamptz', 'boolean', 'bool',
    'int', 'int2', 'int4', 'int8', 'integer', 'bigint', 'smallint',
    'numeric', 'decimal', 'real', 'double', 'precision', 'float',
    'text', 'varchar', 'char', 'character', 'varying', 'json', 'jsonb',
    'uuid', 'bytea', 'money', 'serial', 'array'
]);

/** Clause keywords that terminate an INTO target list. */
const INTO_TERMINATORS = new Set([
    'from', 'where', 'group', 'having', 'window', 'order', 'limit',
    'offset', 'fetch', 'for', 'union', 'intersect', 'except', 'returning'
]);

interface Token {
    /** Token text (read from the masked string; identical to the original for words). */
    text: string;
    /** 'word' | 'param' | 'punct' | 'op' */
    type: 'word' | 'param' | 'punct' | 'op';
    start: number;
    end: number;
    /** Parenthesis nesting depth at the token's position. */
    depth: number;
}

export interface VariableOccurrence {
    /** Original-cased identifier text. */
    name: string;
    /** Lower-cased key used for de-duplication and value lookup. */
    key: string;
    start: number;
    end: number;
}

export interface SelectExtraction {
    /** The runnable SELECT/WITH statement, INTO clause stripped, trimmed. */
    sql: string;
    /** Distinct variable names (in order of first appearance). */
    variables: string[];
}

/**
 * Produce a copy of `text` where comments and string / dollar-quoted literals
 * are replaced by spaces. Length and newlines are preserved so character
 * offsets stay aligned with the original.
 */
export function maskSql(text: string): string {
    const out = text.split('');
    const n = text.length;
    let i = 0;
    const blank = (from: number, to: number) => {
        for (let k = from; k < to && k < n; k++) {
            if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
        }
    };
    while (i < n) {
        const c = text[i];
        const c2 = text[i + 1];
        // Line comment
        if (c === '-' && c2 === '-') {
            let j = i + 2;
            while (j < n && text[j] !== '\n') j++;
            blank(i, j);
            i = j;
            continue;
        }
        // Block comment (PostgreSQL allows nesting)
        if (c === '/' && c2 === '*') {
            let j = i + 2;
            let depth = 1;
            while (j < n && depth > 0) {
                if (text[j] === '/' && text[j + 1] === '*') { depth++; j += 2; }
                else if (text[j] === '*' && text[j + 1] === '/') { depth--; j += 2; }
                else j++;
            }
            blank(i, j);
            i = j;
            continue;
        }
        // Single-quoted string (handles '' and backslash escapes)
        if (c === "'") {
            let j = i + 1;
            while (j < n) {
                if (text[j] === '\\') { j += 2; continue; }
                if (text[j] === "'") {
                    if (text[j + 1] === "'") { j += 2; continue; }
                    j++;
                    break;
                }
                j++;
            }
            blank(i, j);
            i = j;
            continue;
        }
        // Dollar-quoted string: $tag$ ... $tag$ (tag optional)
        if (c === '$') {
            const tagMatch = /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/.exec(text.slice(i));
            if (tagMatch) {
                const tag = tagMatch[0];
                const close = text.indexOf(tag, i + tag.length);
                const j = close === -1 ? n : close + tag.length;
                blank(i, j);
                i = j;
                continue;
            }
        }
        i++;
    }
    return out.join('');
}

/** Tokenize a masked SQL string into words / params / punctuation / operators. */
function tokenize(masked: string): Token[] {
    const tokens: Token[] = [];
    const n = masked.length;
    let i = 0;
    let depth = 0;
    const opChars = new Set(['=', '<', '>', '!', '+', '-', '*', '/', '%', '|', '~', '@', '#', '&', '^', ':']);
    while (i < n) {
        const c = masked[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
        // $n positional parameter
        if (c === '$' && /\d/.test(masked[i + 1] || '')) {
            let j = i + 1;
            while (j < n && /\d/.test(masked[j])) j++;
            tokens.push({ text: masked.slice(i, j), type: 'param', start: i, end: j, depth });
            i = j;
            continue;
        }
        // Identifier / keyword
        if (/[A-Za-z_]/.test(c)) {
            let j = i + 1;
            while (j < n && /[A-Za-z0-9_]/.test(masked[j])) j++;
            tokens.push({ text: masked.slice(i, j), type: 'word', start: i, end: j, depth });
            i = j;
            continue;
        }
        // Punctuation that affects parsing
        if (c === '(') { tokens.push({ text: c, type: 'punct', start: i, end: i + 1, depth }); depth++; i++; continue; }
        if (c === ')') { depth = Math.max(0, depth - 1); tokens.push({ text: c, type: 'punct', start: i, end: i + 1, depth }); i++; continue; }
        if (c === ',' || c === '.' || c === ';') {
            tokens.push({ text: c, type: 'punct', start: i, end: i + 1, depth });
            i++;
            continue;
        }
        // Operator run
        if (opChars.has(c)) {
            let j = i + 1;
            while (j < n && opChars.has(masked[j])) j++;
            tokens.push({ text: masked.slice(i, j), type: 'op', start: i, end: j, depth });
            i = j;
            continue;
        }
        i++;
    }
    return tokens;
}

/**
 * Find the [start, end) bounds of the statement that contains `offset`, using
 * top-level (string/comment-ignoring) semicolons as separators.
 */
function enclosingStatementBounds(masked: string, offset: number): { start: number; end: number } {
    let start = 0;
    let end = masked.length;
    for (let i = 0; i < masked.length; i++) {
        if (masked[i] !== ';') continue;
        if (i < offset) start = i + 1;
        else { end = i; break; }
    }
    return { start, end };
}

/** Index of the first top-level SELECT or WITH keyword, or -1. */
function firstSelectOrWithIndex(tokens: Token[]): number {
    for (const t of tokens) {
        if (t.type === 'word' && t.depth === 0) {
            const w = t.text.toLowerCase();
            if (w === 'select' || w === 'with') return t.start;
        }
    }
    return -1;
}

/** Remove a top-level `INTO [STRICT] target, ...` clause from a SELECT. */
function stripIntoClause(sql: string): string {
    const masked = maskSql(sql);
    const tokens = tokenize(masked);
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type !== 'word' || t.depth !== 0) continue;
        if (t.text.toLowerCase() !== 'into') continue;
        // Skip `INSERT INTO`
        const prev = tokens[i - 1];
        if (prev && prev.type === 'word' && prev.text.toLowerCase() === 'insert') continue;
        // Find where the target list ends (next top-level clause keyword or end).
        let endIdx = sql.length;
        for (let j = i + 1; j < tokens.length; j++) {
            const tj = tokens[j];
            if (tj.depth !== 0) continue;
            if (tj.type === 'word' && INTO_TERMINATORS.has(tj.text.toLowerCase())) {
                endIdx = tj.start;
                break;
            }
            if (tj.type === 'punct' && tj.text === ';') {
                endIdx = tj.start;
                break;
            }
        }
        return (sql.slice(0, t.start) + ' ' + sql.slice(endIdx)).replace(/\s+/g, ' ').trim();
    }
    return sql;
}

/**
 * Return every occurrence of an identifier that should be treated as a
 * substitutable value variable. Order follows appearance in the SQL.
 *
 * An identifier is considered a variable when it appears in a "value position"
 * — i.e. on the value side of a comparison/arithmetic operator, inside an
 * `IN (...)` / `VALUES (...)` list, or after `LIKE` / `ILIKE` / `BETWEEN`. The
 * session value keywords (`current_user`, `user`, ...) and positional
 * parameters (`$1`) are always included. Keywords, qualified columns
 * (`a.col`), table/alias qualifiers and function names are excluded.
 */
export function findVariableTokens(sql: string): VariableOccurrence[] {
    const masked = maskSql(sql);
    const tokens = tokenize(masked);
    const result: VariableOccurrence[] = [];

    const VALUE_OPS = new Set(['=', '<', '>', '<=', '>=', '<>', '!=', '+', '-', '*', '/', '%', '||', ':=']);
    const VALUE_KEYWORDS = new Set(['in', 'like', 'ilike', 'similar', 'values']);

    let expectValue = false;
    const betweenStack: number[] = [];
    const valueListDepths: number[] = [];

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        const inValue = expectValue;
        const prev = tokens[i - 1];
        const next = tokens[i + 1];

        // ----- Decide whether this token is a substitutable variable -----
        if (t.type === 'param') {
            result.push({ name: t.text, key: t.text.toLowerCase(), start: t.start, end: t.end });
        } else if (t.type === 'word') {
            const lower = t.text.toLowerCase();
            if (BUILTIN_VALUE_KEYWORDS.has(lower)) {
                result.push({ name: t.text, key: lower, start: t.start, end: t.end });
            } else if (!SQL_KEYWORDS.has(lower) && inValue) {
                const prevDot = prev && prev.type === 'punct' && prev.text === '.';
                const nextDot = next && next.type === 'punct' && next.text === '.';
                const nextParen = next && next.type === 'punct' && next.text === '(';
                if (!prevDot && !nextDot && !nextParen) {
                    result.push({ name: t.text, key: lower, start: t.start, end: t.end });
                }
            }
        }

        // ----- Compute whether the NEXT token is in a value position -----
        expectValue = computeNextValueExpectation(t, tokens, i, betweenStack, valueListDepths, expectValue, VALUE_OPS, VALUE_KEYWORDS);
    }
    return result;
}

function computeNextValueExpectation(
    t: Token,
    tokens: Token[],
    i: number,
    betweenStack: number[],
    valueListDepths: number[],
    expectValue: boolean,
    VALUE_OPS: Set<string>,
    VALUE_KEYWORDS: Set<string>
): boolean {
    if (t.type === 'op') {
        return VALUE_OPS.has(t.text);
    }
    if (t.type === 'word') {
        const lw = t.text.toLowerCase();
        if (lw === 'between') { betweenStack.push(t.depth); return true; }
        if (lw === 'and') {
            if (betweenStack.length && betweenStack[betweenStack.length - 1] === t.depth) {
                betweenStack.pop();
                return true;
            }
            return false;
        }
        if (VALUE_KEYWORDS.has(lw)) return true;
        return false;
    }
    if (t.type === 'punct') {
        if (t.text === '(') {
            const prev = tokens[i - 1];
            const next = tokens[i + 1];
            const afterValueKw = prev && prev.type === 'word'
                && (prev.text.toLowerCase() === 'in' || prev.text.toLowerCase() === 'values');
            if (afterValueKw) {
                const opensSubquery = next && next.type === 'word'
                    && (next.text.toLowerCase() === 'select' || next.text.toLowerCase() === 'with');
                if (!opensSubquery) valueListDepths.push(t.depth + 1);
                return true;
            }
            // Plain grouping: a value context carries into the parentheses.
            return expectValue;
        }
        if (t.text === ',') {
            return valueListDepths.includes(t.depth);
        }
        if (t.text === ')') {
            if (valueListDepths.length && valueListDepths[valueListDepths.length - 1] === t.depth + 1) {
                valueListDepths.pop();
            }
            return false;
        }
    }
    return false;
}

/**
 * Extract a runnable SELECT statement around `cursorOffset` (or from an explicit
 * selection) together with the distinct variable names found in it.
 *
 * When `selection` is provided and non-empty it is used verbatim (so a manually
 * selected sub-select or WITH clause is not expanded to the full statement).
 */
export function extractSelect(
    fullText: string,
    cursorOffset: number,
    selection?: { start: number; end: number }
): SelectExtraction | null {
    let stmt: string;

    if (selection && selection.end > selection.start) {
        stmt = fullText.slice(selection.start, selection.end);
    } else {
        const masked = maskSql(fullText);
        const bounds = enclosingStatementBounds(masked, cursorOffset);
        stmt = fullText.slice(bounds.start, bounds.end);
        // Trim down to the SELECT / WITH start if the statement has a prefix
        // (e.g. `RETURN QUERY SELECT ...`).
        const stmtMasked = maskSql(stmt);
        const selIdx = firstSelectOrWithIndex(tokenize(stmtMasked));
        if (selIdx > 0) stmt = stmt.slice(selIdx);
    }

    // Drop a trailing semicolon and surrounding whitespace.
    stmt = stmt.trim().replace(/;\s*$/, '').trim();
    if (!stmt) return null;

    stmt = stripIntoClause(stmt).trim();
    if (!stmt) return null;

    const occurrences = findVariableTokens(stmt);
    const seen = new Set<string>();
    const variables: string[] = [];
    for (const occ of occurrences) {
        if (seen.has(occ.key)) continue;
        seen.add(occ.key);
        variables.push(occ.name);
    }

    return { sql: stmt, variables };
}

/**
 * Replace variable occurrences in `sql` with the provided values. Keys are
 * matched case-insensitively. Empty / missing values leave the identifier
 * untouched. Values are inserted verbatim (callers are responsible for quoting).
 */
export function substituteVariables(sql: string, values: Record<string, string>): string {
    // Normalize lookup map to lower-case keys.
    const lookup = new Map<string, string>();
    for (const [k, v] of Object.entries(values)) {
        if (v !== undefined && v !== null && String(v).length > 0) {
            lookup.set(k.toLowerCase(), String(v));
        }
    }
    if (lookup.size === 0) return sql;

    const occurrences = findVariableTokens(sql);
    // Apply right-to-left so earlier spans keep their offsets.
    let result = sql;
    for (let i = occurrences.length - 1; i >= 0; i--) {
        const occ = occurrences[i];
        const value = lookup.get(occ.key);
        if (value === undefined) continue;
        result = result.slice(0, occ.start) + value + result.slice(occ.end);
    }
    return result;
}
