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
        // Single-quoted string. A backslash is an ordinary character here
        // (standard_conforming_strings); only a doubled quote continues it.
        if (c === "'") {
            let j = i + 1;
            while (j < n) {
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

/**
 * If `offset` falls inside the contents of a dollar-quoted block
 * (`$tag$ ... $tag$`, e.g. a PL/pgSQL function body), return the `[start, end)`
 * bounds of that inner content (excluding the tags). Otherwise return null.
 *
 * Comments and single-quoted strings are skipped while scanning so a `$tag$`
 * sequence inside them is not mistaken for a real opening tag. Returns the
 * outermost block that encloses the offset.
 */
export function findEnclosingDollarBody(text: string, offset: number): { start: number; end: number } | null {
    const n = text.length;
    let i = 0;
    while (i < n) {
        const c = text[i];
        const c2 = text[i + 1];
        // Line comment
        if (c === '-' && c2 === '-') {
            let j = i + 2;
            while (j < n && text[j] !== '\n') j++;
            i = j;
            continue;
        }
        // Block comment (nesting allowed)
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
        // Single-quoted string
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
            i = j;
            continue;
        }
        // Dollar-quoted string
        if (c === '$') {
            const tagMatch = /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/.exec(text.slice(i));
            if (tagMatch) {
                const tag = tagMatch[0];
                const close = text.indexOf(tag, i + tag.length);
                const innerStart = i + tag.length;
                const innerEnd = close === -1 ? n : close;
                if (offset >= innerStart && offset <= innerEnd) {
                    return { start: innerStart, end: innerEnd };
                }
                i = close === -1 ? n : close + tag.length;
                continue;
            }
        }
        i++;
    }
    return null;
}

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
        // :name placeholder. A `::` cast starts with a second colon and a `:=`
        // assignment with a non-word character, so neither is caught here.
        if (c === ':' && /[A-Za-z_]/.test(masked[i + 1] || '')) {
            let j = i + 1;
            while (j < n && /[A-Za-z0-9_]/.test(masked[j])) j++;
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
            while (j < n && opChars.has(masked[j])) {
                // End the run before a `:name` placeholder (`a=:from`) so it is
                // not swallowed; a `::` cast keeps its two colons together.
                if (masked[j] === ':' && masked[j - 1] !== ':' && /[A-Za-z_]/.test(masked[j + 1] || '')) break;
                j++;
            }
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

/**
 * If `stmt` begins with a PL/pgSQL `FOR <target> IN (query) LOOP` (or
 * `FOR <target> IN query LOOP`) construct, return just the inner query
 * (`SELECT ...` / `WITH ...`). Otherwise return null.
 *
 * This keeps the surrounding loop scaffolding (`FOR r IN (`, `) LOOP ...`)
 * out of the extracted statement when the cursor sits on the loop's query.
 */
function extractForLoopQuery(stmt: string, tokens: Token[]): string | null {
    // Locate the loop's `FOR` keyword at the top level.
    const firstIdx = tokens.findIndex(
        (t) => t.type === 'word' && t.depth === 0 && t.text.toLowerCase() === 'for'
    );
    if (firstIdx === -1) return null;

    // Find the `IN` keyword that introduces the loop query (same depth as FOR).
    let inIdx = -1;
    for (let i = firstIdx + 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type === 'word' && t.depth === 0) {
            const w = t.text.toLowerCase();
            if (w === 'in') { inIdx = i; break; }
            if (w === 'loop') return null;
        }
    }
    if (inIdx === -1) return null;

    const after = tokens[inIdx + 1];
    if (!after) return null;

    /** First SELECT/WITH token at `depth` within tokens[from..to), or -1. */
    const findQueryStart = (from: number, to: number, depth: number): number => {
        for (let j = from; j < to; j++) {
            const t = tokens[j];
            if (t.type === 'word' && t.depth === depth) {
                const w = t.text.toLowerCase();
                if (w === 'select' || w === 'with') return t.start;
            }
        }
        return -1;
    };

    // Parenthesized query: `FOR r IN ( SELECT ... ) LOOP`. Inner tokens sit one
    // level deeper than the opening paren; leading comments are skipped.
    if (after.type === 'punct' && after.text === '(') {
        const openDepth = after.depth;
        for (let j = inIdx + 2; j < tokens.length; j++) {
            const t = tokens[j];
            if (t.type === 'punct' && t.text === ')' && t.depth === openDepth) {
                const queryStart = findQueryStart(inIdx + 2, j, openDepth + 1);
                if (queryStart === -1) return null;
                return stmt.slice(queryStart, t.start).trim();
            }
        }
        return null;
    }

    // Unparenthesized query: `FOR r IN SELECT ... LOOP`.
    let loopIdx = tokens.length;
    let loopStart = stmt.length;
    for (let j = inIdx + 1; j < tokens.length; j++) {
        const t = tokens[j];
        if (t.type === 'word' && t.depth === after.depth && t.text.toLowerCase() === 'loop') {
            loopIdx = j;
            loopStart = t.start;
            break;
        }
    }
    const queryStart = findQueryStart(inIdx + 1, loopIdx, after.depth);
    if (queryStart === -1) return null;
    return stmt.slice(queryStart, loopStart).trim();
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
        // Splice out only the INTO clause itself. Whitespace (and especially
        // newlines) in the rest of the statement must be preserved verbatim:
        // collapsing them would let a `--` line comment swallow the code that
        // followed it on the next line, corrupting the query. A separating
        // space is inserted only when neither side already supplies whitespace.
        const before = sql.slice(0, t.start);
        const after = sql.slice(endIdx);
        const needsSpace = before.length > 0 && !/\s$/.test(before) && after.length > 0 && !/^\s/.test(after);
        return (before + (needsSpace ? ' ' : '') + after).trim();
    }
    return sql;
}

/**
 * Convert a top-level `UPDATE <table> SET ... [FROM ...] WHERE ...` statement
 * into an equivalent `SELECT * FROM <table> [, <from list>] WHERE ...` so the
 * affected rows can be previewed. The `SET` assignment list and any
 * `RETURNING` clause are dropped. Returns null when `sql` is not an UPDATE.
 */
function convertUpdateToSelect(sql: string): string | null {
    const masked = maskSql(sql);
    const tokens = tokenize(masked);

    const firstWord = tokens.find((t) => t.type === 'word');
    if (!firstWord || firstWord.depth !== 0 || firstWord.text.toLowerCase() !== 'update') {
        return null;
    }

    // Locate the top-level clause keywords that delimit an UPDATE.
    let setIdx = -1;
    let fromIdx = -1;
    let whereIdx = -1;
    let returningIdx = -1;
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type !== 'word' || t.depth !== 0) continue;
        const w = t.text.toLowerCase();
        if (w === 'set' && setIdx === -1) setIdx = i;
        else if (w === 'from' && fromIdx === -1 && setIdx !== -1 && whereIdx === -1) fromIdx = i;
        else if (w === 'where' && whereIdx === -1 && setIdx !== -1) whereIdx = i;
        else if (w === 'returning' && returningIdx === -1) returningIdx = i;
    }
    if (setIdx === -1) return null;

    const tailStart =
        returningIdx !== -1 ? tokens[returningIdx].start : sql.length;

    // Target table (and optional alias) between UPDATE and SET, minus `ONLY`.
    let tablePart = sql.slice(firstWord.end, tokens[setIdx].start).trim();
    tablePart = tablePart.replace(/^only\s+/i, '').trim();
    if (!tablePart) return null;

    // Optional UPDATE ... FROM <list> (additional relations).
    let fromClause = '';
    if (fromIdx !== -1) {
        const fromEnd = whereIdx !== -1 ? tokens[whereIdx].start : tailStart;
        fromClause = sql.slice(tokens[fromIdx].end, fromEnd).trim();
    }

    // Optional WHERE condition.
    let wherePart = '';
    if (whereIdx !== -1) {
        wherePart = sql.slice(tokens[whereIdx].end, tailStart).trim();
    }

    let out = `SELECT * FROM ${tablePart}`;
    if (fromClause) out += `, ${fromClause}`;
    if (wherePart) out += ` WHERE ${wherePart}`;
    return out.trim();
}


/**
 * Return every occurrence of an identifier that should be treated as a
 * substitutable value variable. Order follows appearance in the SQL.
 *
 * An identifier is considered a variable when it appears in a "value position"
 * — i.e. on the value side of a comparison/arithmetic operator, inside an
 * `IN (...)` / `VALUES (...)` list, after `LIKE` / `ILIKE` / `BETWEEN`, or as
 * the value of `LIMIT` / `OFFSET`. The session value keywords (`current_user`,
 * `user`, ...) and parameters (`$1`, `:name`) are always included — a `:name`
 * placeholder is the way to mark a variable that sits somewhere no heuristic
 * can tell apart from a column, such as a select-list entry. Keywords,
 * table/alias-qualified columns (`a.col`) and function names are excluded.
 *
 * A dotted identifier `head.tail` is, by default, treated as a qualified column
 * and excluded. When `tableQualifiers` is supplied, a dotted identifier whose
 * `head` is **not** one of the query's table names/aliases (and which is not a
 * function call `head.tail(...)` nor a longer chain `head.a.b`) is instead
 * treated as a PL/pgSQL record-field access (e.g. `pi_employeeObj.emplId`) and
 * reported as a single substitutable variable.
 */
export function findVariableTokens(sql: string, tableQualifiers?: Set<string>, definedNames?: Set<string>): VariableOccurrence[] {
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
            const isDefined = definedNames ? definedNames.has(lower) : false;
            if (BUILTIN_VALUE_KEYWORDS.has(lower)) {
                result.push({ name: t.text, key: lower, start: t.start, end: t.end });
            } else if (!SQL_KEYWORDS.has(lower) && inValue && !isDefined) {
                const prevDot = prev && prev.type === 'punct' && prev.text === '.';
                const nextDot = next && next.type === 'punct' && next.text === '.';
                const nextParen = next && next.type === 'punct' && next.text === '(';
                const tail = tokens[i + 2];
                const afterTail = tokens[i + 3];
                if (prevDot) {
                    // Tail of a dotted chain — handled (or excluded) at the head.
                } else if (nextDot && tail && tail.type === 'word') {
                    // Dotted identifier `head.tail`. Treat it as a record-field
                    // access (a variable) only when the head is not a known
                    // table qualifier, it is not a function call (`head.tail(`)
                    // and it is not a longer chain (`head.tail.more`).
                    const tailIsCall = afterTail && afterTail.type === 'punct' && afterTail.text === '(';
                    const tailIsChain = afterTail && afterTail.type === 'punct' && afterTail.text === '.';
                    if (tableQualifiers && !tableQualifiers.has(lower) && !tailIsCall && !tailIsChain) {
                        const full = `${t.text}.${tail.text}`;
                        result.push({ name: full, key: full.toLowerCase(), start: t.start, end: tail.end });
                    }
                    // Otherwise it is a qualified column / function call → excluded.
                } else if (!nextParen) {
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
        // `LIMIT <value>` / `OFFSET <value>` introduce a value position, so a
        // variable used as the row count (e.g. `LIMIT pi_max_history`) is found.
        if (lw === 'limit' || lw === 'offset') return true;
        // A function call sitting in a value position propagates the value
        // context into its argument list, so variables used as arguments are
        // detected too (e.g. `DATE_TRUNC('day', v_von)` or `LAST_DAY(v_bis)`).
        const next = tokens[i + 1];
        if (expectValue && !SQL_KEYWORDS.has(lw) && next && next.type === 'punct' && next.text === '(') {
            valueListDepths.push(next.depth + 1);
            return true;
        }
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
        // When the cursor sits inside a dollar-quoted body (e.g. a PL/pgSQL
        // function body), restrict the search to that body's contents.
        // Otherwise the whole `CREATE FUNCTION ... $body$;` would be treated as
        // a single statement (its inner semicolons are masked away).
        const body = findEnclosingDollarBody(fullText, cursorOffset);
        const searchText = body ? fullText.slice(body.start, body.end) : fullText;
        const localOffset = body ? cursorOffset - body.start : cursorOffset;

        const masked = maskSql(searchText);
        const bounds = enclosingStatementBounds(masked, localOffset);
        stmt = searchText.slice(bounds.start, bounds.end);
        // Trim down to the SELECT / WITH start if the statement has a prefix
        // (e.g. `IF ... THEN SELECT ...` or `RETURN QUERY SELECT ...`).
        const stmtMasked = maskSql(stmt);
        const stmtTokens = tokenize(stmtMasked);
        // A PL/pgSQL `FOR r IN (SELECT ...) LOOP` wraps the query in parens, so
        // peel off the loop scaffolding and keep only the inner SELECT/WITH.
        const forQuery = extractForLoopQuery(stmt, stmtTokens);
        if (forQuery !== null) {
            stmt = forQuery;
        } else {
            const selIdx = firstSelectOrWithIndex(stmtTokens);
            if (selIdx > 0) stmt = stmt.slice(selIdx);
        }
    }

    // Drop a trailing semicolon and surrounding whitespace.
    stmt = stmt.trim().replace(/;\s*$/, '').trim();
    if (!stmt) return null;

    // Turn an UPDATE into an equivalent SELECT so its rows can be previewed.
    const asSelect = convertUpdateToSelect(stmt);
    if (asSelect) stmt = asSelect;

    stmt = stripIntoClause(stmt).trim();
    if (!stmt) return null;

    const occurrences = findVariableTokens(stmt, extractTableQualifiers(stmt), extractDefinedNames(stmt));
    const seen = new Set<string>();
    const variables: string[] = [];
    for (const occ of occurrences) {
        if (seen.has(occ.key)) continue;
        seen.add(occ.key);
        variables.push(occ.name);
    }

    return { sql: stmt, variables };
}

/** Keywords that end a `FROM`/`JOIN` table reference (alias or list). */
const TABLE_REF_STOP = new Set([
    'where', 'group', 'having', 'window', 'order', 'limit', 'offset', 'fetch',
    'for', 'union', 'intersect', 'except', 'on', 'using', 'join', 'inner',
    'left', 'right', 'full', 'cross', 'natural', 'lateral', 'returning',
    'set', 'as', 'and', 'or'
]);

/**
 * Return the distinct base-table names referenced after a `FROM` or `JOIN`
 * keyword (at any nesting depth, so tables inside subqueries are included).
 *
 * Schema-qualified names (`schema.table`) yield the table part. Derived tables
 * / subqueries (`FROM (SELECT ...) alias`) and aliases are skipped. The result
 * is used to look up real column names so that columns are not mistaken for
 * substitutable variables.
 */
export function extractTableNames(sql: string): string[] {
    const masked = maskSql(sql);
    const tokens = tokenize(masked);
    const names: string[] = [];
    const seen = new Set<string>();
    const add = (name: string) => {
        const key = name.toLowerCase();
        if (!seen.has(key)) { seen.add(key); names.push(name); }
    };

    // Consume a single table reference (plus optional alias) starting at `start`.
    // Returns the index just after the reference and any alias.
    const consumeRef = (start: number): number => {
        let k = start;
        if (k >= tokens.length) return k;
        const tk = tokens[k];
        if (tk.type === 'punct' && tk.text === '(') {
            // Derived table / subquery: skip to the matching close paren.
            const depth = tk.depth;
            k++;
            while (k < tokens.length &&
                !(tokens[k].type === 'punct' && tokens[k].text === ')' && tokens[k].depth === depth)) {
                k++;
            }
            if (k < tokens.length) k++;
        } else if (tk.type === 'word') {
            // Dotted chain: keep the last identifier as the table name.
            let lastName = tk.text;
            k++;
            while (k + 1 < tokens.length &&
                tokens[k].type === 'punct' && tokens[k].text === '.' &&
                tokens[k + 1].type === 'word') {
                lastName = tokens[k + 1].text;
                k += 2;
            }
            // A function call in table position (`FROM fn(...)`) is not a table.
            if (!(k < tokens.length && tokens[k].type === 'punct' && tokens[k].text === '(')) {
                add(lastName);
            }
        } else {
            return k;
        }
        // Optional alias: `AS name` or a bare identifier that is not a keyword.
        if (k < tokens.length && tokens[k].type === 'word' && tokens[k].text.toLowerCase() === 'as') {
            k++;
            if (k < tokens.length && tokens[k].type === 'word') k++;
        } else if (k < tokens.length && tokens[k].type === 'word' &&
            !TABLE_REF_STOP.has(tokens[k].text.toLowerCase())) {
            k++;
        }
        return k;
    };

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type !== 'word') continue;
        const w = t.text.toLowerCase();
        if (w !== 'from' && w !== 'join') continue;

        let j = consumeRef(i + 1);
        // `FROM a, b, c` — keep reading comma-separated table references.
        if (w === 'from') {
            while (j < tokens.length && tokens[j].type === 'punct' && tokens[j].text === ',') {
                j = consumeRef(j + 1);
            }
        }
    }
    return names;
}

/**
 * Return the set of lower-cased identifiers that may legitimately appear as the
 * qualifier of a column reference (`qualifier.column`) — i.e. every table
 * name and every alias introduced in a `FROM` / `JOIN` clause (at any nesting
 * depth). This lets {@link findVariableTokens} tell a real qualified column
 * (`lbe.lbe_mit_id`) apart from a PL/pgSQL record-field access
 * (`pi_employeeObj.emplId`), the latter being a substitutable variable.
 */
export function extractTableQualifiers(sql: string): Set<string> {
    const masked = maskSql(sql);
    const tokens = tokenize(masked);
    const qualifiers = new Set<string>();

    // Consume one table reference; record its table name and optional alias.
    const consumeRef = (start: number): number => {
        let k = start;
        if (k >= tokens.length) return k;
        const tk = tokens[k];
        if (tk.type === 'punct' && tk.text === '(') {
            const depth = tk.depth;
            k++;
            while (k < tokens.length &&
                !(tokens[k].type === 'punct' && tokens[k].text === ')' && tokens[k].depth === depth)) {
                k++;
            }
            if (k < tokens.length) k++;
        } else if (tk.type === 'word') {
            let lastName = tk.text;
            k++;
            while (k + 1 < tokens.length &&
                tokens[k].type === 'punct' && tokens[k].text === '.' &&
                tokens[k + 1].type === 'word') {
                lastName = tokens[k + 1].text;
                k += 2;
            }
            // A function call in table position (`FROM fn(...)`) is not a table.
            if (!(k < tokens.length && tokens[k].type === 'punct' && tokens[k].text === '(')) {
                qualifiers.add(lastName.toLowerCase());
            }
        } else {
            return k;
        }
        // Optional alias: `AS name` or a bare non-keyword identifier.
        if (k < tokens.length && tokens[k].type === 'word' && tokens[k].text.toLowerCase() === 'as') {
            k++;
            if (k < tokens.length && tokens[k].type === 'word') { qualifiers.add(tokens[k].text.toLowerCase()); k++; }
        } else if (k < tokens.length && tokens[k].type === 'word' &&
            !TABLE_REF_STOP.has(tokens[k].text.toLowerCase())) {
            qualifiers.add(tokens[k].text.toLowerCase());
            k++;
        }
        return k;
    };

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type !== 'word') continue;
        const w = t.text.toLowerCase();
        if (w !== 'from' && w !== 'join') continue;
        let j = consumeRef(i + 1);
        if (w === 'from') {
            while (j < tokens.length && tokens[j].type === 'punct' && tokens[j].text === ',') {
                j = consumeRef(j + 1);
            }
        }
    }
    return qualifiers;
}


/**
 * Return the set of lower-cased identifiers that the query itself *defines* as
 * output names — i.e. column aliases (`expr AS alias`) and common-table-
 * expression names (`WITH name AS (...)`, `, name AS (...)`). Such names are
 * authored by the user and reference query output, so they must never be
 * offered as substitutable PL/pgSQL variables even when they happen to appear
 * in a value position (e.g. `schema_name || '.' || function_name`).
 */
export function extractDefinedNames(sql: string): Set<string> {
    const masked = maskSql(sql);
    const tokens = tokenize(masked);
    const defined = new Set<string>();

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type !== 'word' || t.text.toLowerCase() !== 'as') continue;
        const prev = tokens[i - 1];
        // `name AS [NOT] MATERIALIZED (...)` — a CTE definition; the name precedes `AS`.
        let k = i + 1;
        if (tokens[k] && tokens[k].type === 'word' && tokens[k].text.toLowerCase() === 'not') k++;
        if (tokens[k] && tokens[k].type === 'word' && tokens[k].text.toLowerCase() === 'materialized') k++;
        const body = tokens[k];
        const next = tokens[i + 1];
        if (body && body.type === 'punct' && body.text === '(' &&
            prev && prev.type === 'word' && !SQL_KEYWORDS.has(prev.text.toLowerCase())) {
            defined.add(prev.text.toLowerCase());
        } else if (next && next.type === 'word' && !SQL_KEYWORDS.has(next.text.toLowerCase())) {
            // `expr AS alias` (column or table alias) / `CAST(x AS type)`.
            defined.add(next.text.toLowerCase());
        }
    }
    return defined;
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

    const occurrences = findVariableTokens(sql, extractTableQualifiers(sql), extractDefinedNames(sql));
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
