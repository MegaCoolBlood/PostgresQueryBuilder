const DEFAULT_THOUSAND_SEPARATOR = ' ';

// Markup for one icon of the sprite inlined at the top of the document.
// The icon inherits the surrounding text colour, so it needs no theme handling.
function icon(name) {
    return `<svg class="ico" aria-hidden="true"><use href="#icon-${name}"/></svg>`;
}

// Convert a raw cell value to its canonical string representation.
// JSON/JSONB columns are parsed by the pg driver into JS objects/arrays;
// String() would render them as "[object Object]", so stringify them as JSON.
function cellToString(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
}

function escapeSqlString(value) {
    return String(value).replace(/'/g, "''");
}

// NOTE: Keep in sync with maskSql in src/selectStatementExtractor.ts.
// Replaces comments and string literals by spaces while preserving offsets so
// the placeholder scanner never matches a `:name` inside a literal or comment.
function maskSqlForPlaceholders(text) {
    const out = String(text).split('');
    const n = out.length;
    const src = String(text);
    let i = 0;
    const blank = (from, to) => {
        for (let k = from; k < to && k < n; k++) {
            if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
        }
    };
    while (i < n) {
        const c = src[i], c2 = src[i + 1];
        if (c === '-' && c2 === '-') {
            let j = i + 2;
            while (j < n && src[j] !== '\n') j++;
            blank(i, j); i = j; continue;
        }
        if (c === '/' && c2 === '*') {
            let j = i + 2, depth = 1;
            while (j < n && depth > 0) {
                if (src[j] === '/' && src[j + 1] === '*') { depth++; j += 2; }
                else if (src[j] === '*' && src[j + 1] === '/') { depth--; j += 2; }
                else j++;
            }
            blank(i, j); i = j; continue;
        }
        if (c === "'") {
            let j = i + 1;
            while (j < n) {
                if (src[j] === "'") {
                    if (src[j + 1] === "'") { j += 2; continue; }
                    j++; break;
                }
                j++;
            }
            blank(i, j); i = j; continue;
        }
        if (c === '$') {
            const tagMatch = /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/.exec(src.slice(i));
            if (tagMatch) {
                const tag = tagMatch[0];
                const end = src.indexOf(tag, i + tag.length);
                const j = end === -1 ? n : end + tag.length;
                blank(i, j); i = j; continue;
            }
        }
        if (c === '"') {
            let j = i + 1;
            while (j < n) {
                if (src[j] === '"') {
                    if (src[j + 1] === '"') { j += 2; continue; }
                    j++; break;
                }
                j++;
            }
            i = j; continue;
        }
        i++;
    }
    return out.join('');
}

// NOTE: Keep in sync with parseQueryPlaceholders in src/savedQueryStore.ts.
function parseQueryPlaceholders(sql) {
    if (typeof sql !== 'string' || !sql) return [];
    const masked = maskSqlForPlaceholders(sql);
    const result = [];
    const re = /:([A-Za-z_][A-Za-z0-9_]*)/g;
    let m;
    while ((m = re.exec(masked)) !== null) {
        if (m.index > 0 && masked[m.index - 1] === ':') continue;
        result.push({ name: m[1], start: m.index, end: m.index + m[0].length });
    }
    return result;
}

// NOTE: Keep in sync with placeholderNames in src/savedQueryStore.ts.
function placeholderNames(sql) {
    const seen = new Set();
    const names = [];
    for (const occ of parseQueryPlaceholders(sql)) {
        const key = occ.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(occ.name);
    }
    return names;
}

// NOTE: Keep in sync with renderParameterValue in src/savedQueryStore.ts.
function renderParameterValue(value, kind) {
    const text = value === null || value === undefined ? '' : String(value);
    if (kind === 'number') {
        if (!/^-?\d+(\.\d+)?$/.test(text.trim())) {
            throw new Error('"' + text + '" is not a valid number.');
        }
        return text.trim();
    }
    if (kind === 'identifier') return '"' + text.replace(/"/g, '""') + '"';
    if (kind === 'raw') return text;
    return "'" + escapeSqlString(text) + "'";
}

// NOTE: Keep in sync with applyQueryParameters in src/savedQueryStore.ts.
// Occurrences are spliced in from right to left so a value that itself contains
// `:name` is never substituted again.
function applyQueryParameters(sql, values, parameters) {
    const occurrences = parseQueryPlaceholders(sql);
    if (occurrences.length === 0) return sql;
    const byName = new Map();
    for (const p of Array.isArray(parameters) ? parameters : []) {
        if (p && typeof p.name === 'string') byName.set(p.name.toLowerCase(), p);
    }
    const lookup = new Map();
    for (const key of Object.keys(values || {})) {
        const v = values[key];
        if (v !== undefined && v !== null) lookup.set(key.toLowerCase(), String(v));
    }
    let result = sql;
    for (let i = occurrences.length - 1; i >= 0; i--) {
        const occ = occurrences[i];
        const key = occ.name.toLowerCase();
        const param = byName.get(key) || { name: occ.name, kind: 'text' };
        let value = lookup.get(key);
        if (value === undefined || value === '') value = param.defaultValue;
        if (value === undefined || value === '') {
            throw new Error('No value supplied for :' + occ.name + '.');
        }
        result = result.slice(0, occ.start)
            + renderParameterValue(value, param.kind || 'text')
            + result.slice(occ.end);
    }
    return result;
}

// NOTE: Keep in sync with mergeParameters in src/savedQueryStore.ts.
function mergeQueryParameters(sql, existing) {
    const known = new Map();
    for (const p of Array.isArray(existing) ? existing : []) {
        if (p && typeof p.name === 'string') known.set(p.name.toLowerCase(), p);
    }
    return placeholderNames(sql).map(name => {
        const prev = known.get(name.toLowerCase());
        return prev
            ? { name, kind: prev.kind || 'text', label: prev.label, defaultValue: prev.defaultValue }
            : { name, kind: 'text' };
    });
}

function normalizeNumericInput(value, thousandSeparator = DEFAULT_THOUSAND_SEPARATOR) {
    if (value === null || value === undefined) return value;
    const str = String(value).trim();
    if (str === '') return str;
    let cleaned = str;
    if (thousandSeparator) {
        cleaned = cleaned.split(thousandSeparator).join('');
    }
    cleaned = cleaned.replace(/,/g, '.');
    if (!isNaN(Number(cleaned))) {
        return cleaned;
    }
    return str;
}

/**
 * Remove thousand separators from a displayed numeric string for copying,
 * while preserving the decimal separator exactly as shown (e.g. the German
 * decimal comma). "9 999 999,99" -> "9999999,99". Non-numeric text or an empty
 * separator is returned unchanged.
 */
function stripThousandSeparators(value, thousandSeparator = DEFAULT_THOUSAND_SEPARATOR) {
    if (value === null || value === undefined) return value;
    if (!thousandSeparator) return String(value);
    return String(value).split(thousandSeparator).join('');
}

/**
 * Join a rectangular block of already-stringified cell values into
 * clipboard text: columns separated by a TAB, rows separated by CRLF, so it
 * pastes into Excel (and other spreadsheets) as a proper cell grid.
 */
function cellRangeToTsv(rows) {
    if (!Array.isArray(rows)) return '';
    return rows
        .map(row => (Array.isArray(row) ? row.join('\t') : ''))
        .join('\r\n');
}

function formatNumberDisplay(value, thousandSeparator = DEFAULT_THOUSAND_SEPARATOR) {
    if (value === null || value === undefined) return null;
    const num = Number(value);
    if (isNaN(num)) return String(value);
    const parts = String(value).split('.');
    const intPart = parts[0].replace(/^-/, '');
    const sign = num < 0 ? '-' : '';
    let formatted = '';
    for (let i = 0; i < intPart.length; i++) {
        if (i > 0 && (intPart.length - i) % 3 === 0) {
            formatted += thousandSeparator;
        }
        formatted += intPart[i];
    }
    if (parts.length > 1) {
        formatted += ',' + parts[1];
    }
    return sign + formatted;
}

function formatExactMatchValue(value, filterType, thousandSeparator = DEFAULT_THOUSAND_SEPARATOR) {
    if (filterType === 'numeric') {
        const normalized = normalizeNumericInput(value, thousandSeparator);
        return `'${escapeSqlString(normalized)}'`;
    }
    return `'${escapeSqlString(value)}'`;
}

function normalizeFilterInputValue(value, filterType, thousandSeparator = DEFAULT_THOUSAND_SEPARATOR) {
    if (value === null || value === undefined) return value;
    if (filterType === 'numeric') {
        return normalizeNumericInput(value, thousandSeparator);
    }
    return String(value);
}

/**
 * Core live-formatting logic for numeric values.
 * Takes current text, cursor position (as digit count before cursor), and thousand separator.
 * Returns { formatted, normalized, newCursor } or null if no formatting needed.
 */
function liveFormatNumeric(text, digitCursorPos, thousandSeparator = DEFAULT_THOUSAND_SEPARATOR) {
    if (!text || text === '') return null;
    const normalized = normalizeNumericInput(text, thousandSeparator);
    if (!normalized || isNaN(Number(normalized))) return null;
    const formatted = formatNumberDisplay(normalized, thousandSeparator);
    if (formatted === null || formatted === text) return null;

    // Compute new cursor offset by counting digits in formatted string
    let charCount = 0;
    let newCursor = formatted.length;
    for (let i = 0; i < formatted.length; i++) {
        if (formatted[i] !== thousandSeparator) {
            charCount++;
        }
        if (charCount >= digitCursorPos) {
            newCursor = i + 1;
            break;
        }
    }
    return { formatted, normalized, newCursor };
}

// ===== SQL query helpers (pure; shared with the webview IIFE and unit tests) =====

// Detect and strip a trailing LIMIT [n] [OFFSET m] clause that is not
// inside parentheses or string literals. Returns { base, hadLimit }.
function stripTrailingLimitOffset(sql) {
    const len = sql.length;
    let depth = 0;
    let inSingle = false, inDouble = false, inLineComment = false, inBlockComment = false;
    const tokens = []; // [{kw, start}] for top-level LIMIT/OFFSET
    let i = 0;
    while (i < len) {
        const ch = sql[i];
        const next = sql[i + 1];
        if (inLineComment) { if (ch === '\n') inLineComment = false; i++; continue; }
        if (inBlockComment) { if (ch === '*' && next === '/') { inBlockComment = false; i += 2; continue; } i++; continue; }
        if (inSingle) { if (ch === "'") { if (next === "'") { i += 2; continue; } inSingle = false; } i++; continue; }
        if (inDouble) { if (ch === '"') { if (next === '"') { i += 2; continue; } inDouble = false; } i++; continue; }
        if (ch === '-' && next === '-') { inLineComment = true; i += 2; continue; }
        if (ch === '/' && next === '*') { inBlockComment = true; i += 2; continue; }
        if (ch === "'") { inSingle = true; i++; continue; }
        if (ch === '"') { inDouble = true; i++; continue; }
        if (ch === '(') { depth++; i++; continue; }
        if (ch === ')') { depth--; i++; continue; }
        if (depth === 0 && /[A-Za-z_]/.test(ch)) {
            let j = i;
            while (j < len && /[A-Za-z0-9_]/.test(sql[j])) j++;
            const word = sql.substring(i, j).toLowerCase();
            const before = i === 0 ? ' ' : sql[i - 1];
            if ((word === 'limit' || word === 'offset' || word === 'fetch') && /[\s);]/.test(before)) {
                tokens.push({ kw: word, start: i });
            }
            i = j;
            continue;
        }
        i++;
    }
    if (tokens.length === 0) return { base: sql.replace(/[\s;]+$/, ''), hadLimit: false };
    // Pick the earliest LIMIT/FETCH token among the trailing run
    // (allow OFFSET to come before LIMIT too).
    const trailing = tokens[tokens.length - 1];
    // Walk back to the first contiguous LIMIT/OFFSET/FETCH that all belong
    // to the same trailing clause group.
    let firstIdx = trailing.start;
    for (let t = tokens.length - 1; t >= 0; t--) {
        firstIdx = tokens[t].start;
        if (t === 0) break;
        const prev = tokens[t - 1];
        // Only keep walking back if the previous token is also LIMIT/OFFSET
        // and only whitespace/numbers/parens between them.
        const between = sql.substring(prev.start, firstIdx);
        if (!/^\s*(limit|offset|fetch)\b[^A-Za-z_]*$/i.test(between)) break;
    }
    return {
        base: sql.substring(0, firstIdx).replace(/[\s;]+$/, ''),
        hadLimit: true
    };
}

function findTopLevelKeywordIndex(sql, keyword) {
    const upper = keyword.toUpperCase();
    let depth = 0;
    let inStr = false;
    let strCh = '';
    let i = 0;
    while (i < sql.length) {
        const ch = sql[i];
        if (inStr) {
            if (ch === strCh) {
                if (strCh === "'" && sql[i + 1] === "'") { i += 2; continue; }
                inStr = false;
            }
            i++;
            continue;
        }
        if (ch === "'" || ch === '"') { inStr = true; strCh = ch; i++; continue; }
        if (ch === '(') { depth++; i++; continue; }
        if (ch === ')') { depth--; i++; continue; }
        if (depth === 0) {
            // Word boundary on left (whitespace), and matches keyword followed by whitespace
            if ((i === 0 || /\s/.test(sql[i - 1])) &&
                sql.substring(i, i + upper.length).toUpperCase() === upper &&
                /\s/.test(sql[i + upper.length] || '')) {
                return i;
            }
        }
        i++;
    }
    return -1;
}

function parseSqlForWhere(sql) {
    let s = String(sql || '').trim().replace(/;\s*$/, '').trim();
    // Strip trailing LIMIT/OFFSET that we may have appended previously
    s = s.replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$/i, '');
    // Strip trailing ORDER BY ...
    let orderBy = '';
    const ordRe = /\s+ORDER\s+BY\s+([\s\S]+)$/i;
    const ordMatch = s.match(ordRe);
    if (ordMatch) {
        orderBy = ordMatch[1].trim();
        s = s.substring(0, ordMatch.index);
    }
    // Find top-level WHERE (best-effort: first WHERE at paren depth 0, outside strings)
    const whereIdx = findTopLevelKeywordIndex(s, 'WHERE');
    let base = s;
    let where = '';
    if (whereIdx !== -1) {
        const after = s.substring(whereIdx);
        const m = after.match(/^\s*WHERE\s+/i);
        base = s.substring(0, whereIdx).replace(/\s+$/, '');
        where = after.substring(m[0].length).trim();
    }
    return { base, where, orderBy };
}

function splitWhereByAnd(whereClause) {
    const parts = [];
    let buf = '';
    let depth = 0;
    let inStr = false;
    let strCh = '';
    let i = 0;
    while (i < whereClause.length) {
        const ch = whereClause[i];
        if (inStr) {
            buf += ch;
            if (ch === strCh) {
                if (strCh === "'" && whereClause[i + 1] === "'") { buf += "'"; i += 2; continue; }
                inStr = false;
            }
            i++;
            continue;
        }
        if (ch === "'" || ch === '"') { inStr = true; strCh = ch; buf += ch; i++; continue; }
        if (ch === '(') { depth++; buf += ch; i++; continue; }
        if (ch === ')') { depth--; buf += ch; i++; continue; }
        if (depth === 0) {
            const rest = whereClause.substring(i);
            const m = rest.match(/^\s+AND\s+/i);
            if (m && /\s/.test(whereClause[i] || '')) {
                parts.push(buf.trim());
                buf = '';
                i += m[0].length;
                continue;
            }
        }
        buf += ch;
        i++;
    }
    if (buf.trim()) parts.push(buf.trim());
    return parts;
}

function whereClauseTargetsColumn(clause, colName) {
    // Match an optional schema/table prefix then the column identifier (quoted or bare)
    const m = clause.match(/^\s*(?:(?:"[^"]+"|[A-Za-z_][\w$]*)\s*\.\s*)*("[^"]+"|[A-Za-z_][\w$]*)/);
    if (!m) return false;
    let tok = m[1];
    if (tok.startsWith('"') && tok.endsWith('"')) tok = tok.substring(1, tok.length - 1);
    return tok.toLowerCase() === colName.toLowerCase();
}

// Replace the WHERE clauses of the listed columns, keeping every other clause
// (including hand-written ones) untouched. An empty clause drops the column's
// condition, which is how clearing a column filter removes it from the query.
function mergeWhereClauses(existing, clausesByCol) {
    const clauses = existing || [];
    const targetCols = Object.keys(clausesByCol || {});
    if (targetCols.length === 0) return clauses.slice();
    const merged = clauses.filter(c => !targetCols.some(col => whereClauseTargetsColumn(c, col)));
    for (const col of targetCols) {
        if (clausesByCol[col]) merged.push(clausesByCol[col]);
    }
    return merged;
}

function parseSqlForOrder(sql) {
    let s = String(sql || '').trim().replace(/;\s*$/, '').trim();
    // Strip trailing LIMIT [OFFSET] (numeric only — generated by us)
    s = s.replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$/i, '');
    // Extract trailing ORDER BY ... up to end
    const orderRe = /\s+ORDER\s+BY\s+([\s\S]+)$/i;
    const m = s.match(orderRe);
    if (m) {
        return { base: s.substring(0, m.index), orderBy: m[1].trim() };
    }
    return { base: s, orderBy: '' };
}

// --- SQL pretty-printer for the query bar -------------------------------------
// Produces a readable, multi-line layout for plain SELECT statements: each
// top-level clause (FROM/WHERE/JOIN/GROUP BY/ORDER BY/...) starts on its own
// line, SELECT columns are listed one per indented line and WHERE/HAVING
// conditions are split on top-level AND. The function is intentionally
// conservative: statements it cannot safely reformat (CTEs, statements with
// comments, non-SELECT statements) are returned trimmed but otherwise as-is.

// True when the SQL contains a -- line comment or /* */ block comment at the
// top level (outside string/identifier literals).
function hasSqlComment(s) {
    let inSingle = false, inDouble = false, i = 0;
    while (i < s.length) {
        const ch = s[i], nx = s[i + 1];
        if (inSingle) { if (ch === "'") { if (nx === "'") { i += 2; continue; } inSingle = false; } i++; continue; }
        if (inDouble) { if (ch === '"') { if (nx === '"') { i += 2; continue; } inDouble = false; } i++; continue; }
        if (ch === "'") { inSingle = true; i++; continue; }
        if (ch === '"') { inDouble = true; i++; continue; }
        if (ch === '-' && nx === '-') return true;
        if (ch === '/' && nx === '*') return true;
        i++;
    }
    return false;
}

// Collapse every run of whitespace outside string/identifier literals to a
// single space so the keyword scanner can rely on single-space separators.
function collapseSqlWhitespace(s) {
    let out = '', inSingle = false, inDouble = false, i = 0;
    while (i < s.length) {
        const ch = s[i];
        if (inSingle) { out += ch; if (ch === "'") { if (s[i + 1] === "'") { out += "'"; i += 2; continue; } inSingle = false; } i++; continue; }
        if (inDouble) { out += ch; if (ch === '"') { if (s[i + 1] === '"') { out += '"'; i += 2; continue; } inDouble = false; } i++; continue; }
        if (ch === "'") { inSingle = true; out += ch; i++; continue; }
        if (ch === '"') { inDouble = true; out += ch; i++; continue; }
        if (/\s/.test(ch)) { out += ' '; i++; while (i < s.length && /\s/.test(s[i])) i++; continue; }
        out += ch; i++;
    }
    return out.trim();
}

// Split a list on top-level commas (ignoring commas inside parentheses or
// string/identifier literals).
function splitTopLevelCommas(s) {
    const parts = [];
    let buf = '', depth = 0, inSingle = false, inDouble = false, i = 0;
    while (i < s.length) {
        const ch = s[i];
        if (inSingle) { buf += ch; if (ch === "'") { if (s[i + 1] === "'") { buf += "'"; i += 2; continue; } inSingle = false; } i++; continue; }
        if (inDouble) { buf += ch; if (ch === '"') { if (s[i + 1] === '"') { buf += '"'; i += 2; continue; } inDouble = false; } i++; continue; }
        if (ch === "'") { inSingle = true; buf += ch; i++; continue; }
        if (ch === '"') { inDouble = true; buf += ch; i++; continue; }
        if (ch === '(') { depth++; buf += ch; i++; continue; }
        if (ch === ')') { depth--; buf += ch; i++; continue; }
        if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; i++; continue; }
        buf += ch; i++;
    }
    if (buf.trim()) parts.push(buf);
    return parts;
}

// Clause keywords that start a new top-level line. Multi-word entries must
// precede their single-word prefixes so the scanner matches the longest form.
const SQL_CLAUSE_KEYWORDS = [
    'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN',
    'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'INNER JOIN',
    'GROUP BY', 'ORDER BY', 'UNION ALL',
    'SELECT', 'FROM', 'WHERE', 'HAVING', 'WINDOW', 'LIMIT', 'OFFSET',
    'FETCH', 'UNION', 'INTERSECT', 'EXCEPT', 'JOIN', 'RETURNING'
];

// Break a (whitespace-collapsed) statement into ordered { kw, content }
// segments at top-level clause keywords.
function splitTopLevelClauses(s) {
    const U = s.toUpperCase();
    const segs = [];
    let i = 0, depth = 0, inSingle = false, inDouble = false;
    let segStart = 0, segKw = '';
    while (i < s.length) {
        const ch = s[i];
        if (inSingle) { if (ch === "'") { if (s[i + 1] === "'") { i += 2; continue; } inSingle = false; } i++; continue; }
        if (inDouble) { if (ch === '"') { if (s[i + 1] === '"') { i += 2; continue; } inDouble = false; } i++; continue; }
        if (ch === "'") { inSingle = true; i++; continue; }
        if (ch === '"') { inDouble = true; i++; continue; }
        if (ch === '(') { depth++; i++; continue; }
        if (ch === ')') { depth--; i++; continue; }
        if (depth === 0 && (i === 0 || /[\s(,]/.test(s[i - 1]))) {
            let matched = null;
            for (const kw of SQL_CLAUSE_KEYWORDS) {
                if (U.startsWith(kw, i)) {
                    const after = s[i + kw.length];
                    if (after === undefined || /[\s(]/.test(after)) { matched = kw; break; }
                }
            }
            if (matched) {
                segs.push({ kw: segKw, content: s.slice(segStart, i).trim() });
                segKw = matched;
                i += matched.length;
                segStart = i;
                continue;
            }
        }
        i++;
    }
    segs.push({ kw: segKw, content: s.slice(segStart).trim() });
    return segs.filter((seg, idx) => !(idx === 0 && seg.kw === '' && seg.content === ''));
}

function formatSql(sql) {
    if (sql == null) return sql;
    const raw = String(sql).trim().replace(/;+\s*$/, '').trim();
    if (!raw) return String(sql);
    // Only reformat plain SELECT statements; leave CTEs/DML/commented SQL alone.
    if (!/^SELECT\b/i.test(raw)) return raw;
    if (hasSqlComment(raw)) return raw;

    const s = collapseSqlWhitespace(raw);
    const segs = splitTopLevelClauses(s);
    if (segs.length === 0 || segs[0].kw.toUpperCase() !== 'SELECT') return raw;

    const INDENT = '    ';
    const lines = [];
    for (const seg of segs) {
        const kw = seg.kw.toUpperCase();
        const content = seg.content;
        if (kw === 'SELECT') {
            let prefix = '';
            let body = content;
            const distinct = body.match(/^DISTINCT(\s+ON\s*\([\s\S]*?\))?\s+/i);
            if (distinct) { prefix = body.slice(0, distinct[0].length).trim(); body = body.slice(distinct[0].length); }
            const cols = splitTopLevelCommas(body);
            const header = prefix ? `SELECT ${prefix}` : 'SELECT';
            if (cols.length <= 1) {
                lines.push(`${header} ${body}`.trimEnd());
            } else {
                lines.push(header);
                cols.forEach((c, idx) => {
                    lines.push(INDENT + c.trim() + (idx < cols.length - 1 ? ',' : ''));
                });
            }
        } else if (kw === 'WHERE' || kw === 'HAVING') {
            const conds = splitWhereByAnd(content);
            if (conds.length <= 1) {
                lines.push(`${kw} ${content}`.trimEnd());
            } else {
                lines.push(`${kw} ${conds[0].trim()}`);
                for (let k = 1; k < conds.length; k++) lines.push(`${INDENT}AND ${conds[k].trim()}`);
            }
        } else {
            lines.push(content ? `${kw} ${content}` : kw);
        }
    }
    return lines.join('\n');
}

// Map a filter mode keyword to its SQL comparison operator.
function filterOperatorForMode(mode) {
    switch (mode) {
        case 'not_equals': return '!=';
        case 'gt': return '>';
        case 'gte': return '>=';
        case 'lt': return '<';
        case 'lte': return '<=';
        default: return '=';
    }
}

// Build the SQL WHERE-clause fragment for a single column filter, or return
// null when the filter does not constrain the query. `fmtCol` is the already
// quoted/qualified column identifier and `operator` is the comparison operator
// for single-value numeric/date filters.
function buildFilterClause(fmtCol, val, filterType, isExact, operator, thousandSeparator) {
    if (val === null || val === undefined || val === '') return null;

    if (isExact) {
        return `${fmtCol} = ${formatExactMatchValue(val, filterType, thousandSeparator)}`;
    }

    if (typeof val === 'object' && val.from !== undefined) {
        const fromRaw = val.from ? normalizeFilterInputValue(val.from, filterType, thousandSeparator) : '';
        const toRaw = val.to ? normalizeFilterInputValue(val.to, filterType, thousandSeparator) : '';
        if (filterType === 'numeric') {
            const fromNum = fromRaw !== '' ? Number(fromRaw) : null;
            const toNum = toRaw !== '' ? Number(toRaw) : null;
            const from = fromNum !== null && !isNaN(fromNum) ? String(fromNum) : '';
            const to = toNum !== null && !isNaN(toNum) ? String(toNum) : '';
            if (from && to) return `${fmtCol} BETWEEN ${from} AND ${to}`;
            if (from) return `${fmtCol} >= ${from}`;
            if (to) return `${fmtCol} <= ${to}`;
            return null;
        }
        const from = escapeSqlString(fromRaw);
        const to = escapeSqlString(toRaw);
        if (from && to) return `${fmtCol} BETWEEN '${from}' AND '${to}'`;
        if (from) return `${fmtCol} >= '${from}'`;
        if (to) return `${fmtCol} <= '${to}'`;
        return null;
    }

    if (filterType === 'numeric') {
        const numericValue = Number(normalizeFilterInputValue(val, filterType, thousandSeparator));
        if (isNaN(numericValue)) return null;
        return `${fmtCol} ${operator} ${numericValue}`;
    }

    if (filterType === 'date') {
        return `${fmtCol} ${operator} '${escapeSqlString(val)}'`;
    }

    return `${fmtCol}::text ILIKE '%${escapeSqlString(val)}%'`;
}

// Build an `IS NULL` / `IS NOT NULL` WHERE clause for an already-formatted
// column identifier. `isNull` true yields `<col> IS NULL`, false yields
// `<col> IS NOT NULL`.
function buildNullConstraintClause(fmtCol, isNull) {
    return `${fmtCol} IS ${isNull ? 'NULL' : 'NOT NULL'}`;
}

// Decide whether the in-viewer error dialog should be shown for a given error
// text and what message it should display. A missing/blank message falls back
// to a generic text; surrounding whitespace is trimmed. Returns
// { visible, message }.
function buildErrorDialogState(text) {
    const message = (text === null || text === undefined) ? '' : String(text).trim();
    if (!message) {
        return { visible: true, message: 'An unknown error occurred.' };
    }
    return { visible: true, message };
}

// Turn a custom-mapping condition ({column, operator, value}) into a SQL WHERE
// clause for an already-formatted column identifier. LIKE/ILIKE use a
// "contains" match (wrapped in %…%) to mirror evaluateMappingConditions; every
// other operator emits `<col> <op> <quoted-value>`. Returns '' for an
// incomplete condition.
function mappingConditionToClause(cond, fmtCol, filterType, thousandSeparator) {
    if (!cond || !cond.column || !cond.operator) return '';
    const raw = (cond.value === null || cond.value === undefined) ? '' : String(cond.value);
    if (cond.operator === 'LIKE' || cond.operator === 'ILIKE') {
        return `${fmtCol} ${cond.operator} '${escapeSqlString('%' + raw + '%')}'`;
    }
    return `${fmtCol} ${cond.operator} ${formatExactMatchValue(raw, filterType, thousandSeparator)}`;
}

// Operators offered in the permanent-constraint editor. Mirrors the Join
// dialog's fixed-condition operators so both editors behave identically.
const CONSTRAINT_OPERATORS = ['=', '<>', '<', '<=', '>', '>=', 'LIKE', 'ILIKE', 'BETWEEN', 'IS NULL', 'IS NOT NULL'];

// True for operators that take no right-hand operand.
function constraintIsUnary(operator) {
    const op = (operator || '').toUpperCase();
    return op === 'IS NULL' || op === 'IS NOT NULL';
}

// True for the BETWEEN operator (two right-hand operands joined by AND).
function constraintIsBetween(operator) {
    return (operator || '').toUpperCase() === 'BETWEEN';
}

// Render a single constraint operand to SQL text. A `column` operand is quoted
// via the supplied `formatCol` callback; a `raw` operand is emitted verbatim.
function formatConstraintOperand(op, formatCol) {
    if (!op) {
        return '';
    }
    if (op.kind === 'column') {
        const col = (op.column || '').trim();
        if (!col) {
            return '';
        }
        return formatCol ? formatCol(col) : col;
    }
    return (op.text || '').trim();
}

// Build the SQL text for one permanent constraint condition. Returns an empty
// string when required operands are missing, so incomplete rows are skipped.
function formatConstraintCondition(cond, formatCol) {
    if (!cond) {
        return '';
    }
    const op = (cond.operator || '').toUpperCase();
    const left = formatConstraintOperand(cond.left, formatCol);
    if (!left) {
        return '';
    }
    if (constraintIsUnary(op)) {
        return `${left} ${op}`;
    }
    if (constraintIsBetween(op)) {
        const r1 = formatConstraintOperand(cond.right, formatCol);
        const r2 = formatConstraintOperand(cond.right2, formatCol);
        if (!r1 || !r2) {
            return '';
        }
        return `${left} BETWEEN ${r1} AND ${r2}`;
    }
    const right = formatConstraintOperand(cond.right, formatCol);
    if (!right) {
        return '';
    }
    return `${left} ${op} ${right}`;
}

// Join all permanent constraint conditions into a single WHERE clause body.
function buildConstraintWhere(conditions, formatCol) {
    if (!Array.isArray(conditions)) {
        return '';
    }
    return conditions
        .map((c) => formatConstraintCondition(c, formatCol))
        .filter((s) => s)
        .join(' AND ');
}

// Directions offered in the permanent-sort editor.
const CONSTRAINT_SORT_DIRECTIONS = ['ASC', 'DESC'];

// Render one permanent sort entry to SQL text. Returns '' when no column is
// selected, so incomplete rows are skipped.
function formatConstraintSort(sort, formatCol) {
    if (!sort) {
        return '';
    }
    const col = (sort.column || '').trim();
    if (!col) {
        return '';
    }
    const direction = String(sort.direction || '').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    const left = formatCol ? formatCol(col) : col;
    return `${left} ${direction}`;
}

// Join all permanent sort entries into a single ORDER BY clause body.
function buildConstraintOrderBy(sorts, formatCol) {
    if (!Array.isArray(sorts)) {
        return '';
    }
    return sorts
        .map((s) => formatConstraintSort(s, formatCol))
        .filter((s) => s)
        .join(', ');
}

// Build the explicit column list used by the default table-view query. Instead
// of a `*` wildcard the query bar lists every column by name. When the columns
// are not yet known (empty list) it falls back to `*` so the query bar still
// shows a valid statement while metadata is loading.
function buildSelectColumnList(columns, formatCol) {
    if (!Array.isArray(columns) || columns.length === 0) {
        return '*';
    }
    const fmt = typeof formatCol === 'function' ? formatCol : (c) => c;
    const names = columns
        .map((col) => (col && col.name !== undefined && col.name !== null) ? fmt(col.name) : '')
        .filter((s) => s !== '');
    return names.length > 0 ? names.join(', ') : '*';
}

// Return a new array with the column at `fromIndex` moved so it sits at
// `toIndex` (drag-and-drop reordering of the Data Viewer header). The original
// array is left untouched. Out-of-range or no-op moves return a shallow copy of
// the input so callers can treat the result uniformly.
function reorderColumns(columns, fromIndex, toIndex) {
    if (!Array.isArray(columns)) {
        return [];
    }
    const result = columns.slice();
    const len = result.length;
    if (
        !Number.isInteger(fromIndex) || !Number.isInteger(toIndex) ||
        fromIndex < 0 || fromIndex >= len ||
        toIndex < 0 || toIndex >= len ||
        fromIndex === toIndex
    ) {
        return result;
    }
    const [moved] = result.splice(fromIndex, 1);
    result.splice(toIndex, 0, moved);
    return result;
}

// Build the tooltip text shown when hovering a Data Viewer column header.
// Returns the column's comment (trimmed) or '' when the column has no comment,
// so the caller can omit the `title` attribute entirely.
function buildColumnHeaderTitle(col) {
    if (!col || col.comment === null || col.comment === undefined) {
        return '';
    }
    return String(col.comment).trim();
}

function formatColumnTypeLabel(col) {
    if (!col) return '';
    const dataType = String(col.dataType || '').trim();
    const fullType = String(col.fullType || '').trim();
    if (!dataType) return fullType;
    const normalized = dataType.toLowerCase();
    if (['char', 'character', 'bpchar', 'varchar', 'character varying'].includes(normalized)) {
        const modifier = fullType.match(/\((\d+)\)/);
        if (modifier) return `${dataType}(${modifier[1]})`;
        return dataType;
    }
    return fullType || dataType;
}

// Next sort state for a click on `column`. A column cycles ascending →
// descending → off, and switching it off restores the sort that was active
// before it was first clicked, so looking at one column does not throw away the
// order the user had set up before.
function nextSortState(current, column) {
    const now = current || {};
    if (now.column !== column) {
        return {
            column,
            direction: 'asc',
            previous: { column: now.column || null, direction: now.direction || 'asc' }
        };
    }
    if (now.direction !== 'desc') {
        return { column, direction: 'desc', previous: now.previous || null };
    }
    const restored = now.previous || {};
    return { column: restored.column || null, direction: restored.direction || 'asc', previous: null };
}

// Compute the new per-row content height while dragging the row-resize handle.
// `startHeight` is the height (px) when the drag began, `deltaY` the vertical
// mouse movement (px, positive = downward = taller). The result is clamped to
// [minHeight, maxHeight] so a row can never shrink below a single line nor grow
// unbounded.
function computeResizedRowHeight(startHeight, deltaY, minHeight, maxHeight) {
    let h = (Number(startHeight) || 0) + (Number(deltaY) || 0);
    if (h < minHeight) {
        h = minHeight;
    }
    if (maxHeight != null && h > maxHeight) {
        h = maxHeight;
    }
    return h;
}

// Compute the new column width while dragging the handle on a header's right
// edge. `deltaX` is positive when the mouse moves right (= wider); the result is
// clamped so a column stays grabbable and cannot swallow the whole viewport.
function computeResizedColumnWidth(startWidth, deltaX, minWidth, maxWidth) {
    let w = (Number(startWidth) || 0) + (Number(deltaX) || 0);
    if (w < minWidth) {
        w = minWidth;
    }
    if (maxWidth != null && w > maxWidth) {
        w = maxWidth;
    }
    return Math.round(w);
}

// Quote a column name for use inside a CSS attribute selector.
function cssStringLiteral(value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Build the stylesheet that pins the columns the user has resized. The auto
// table layout only honours a width when every cell of the column carries it,
// so header, filter and body cells are all addressed; the filter input has to
// be allowed to shrink as well, or its own min-width would hold the column open.
function buildColumnWidthCss(widths) {
    const rules = [];
    Object.keys(widths || {}).forEach(name => {
        const w = Math.round(Number(widths[name]) || 0);
        if (!(w > 0)) return;
        const sel = `[data-col=${cssStringLiteral(name)}]`;
        rules.push(`#dataTable th${sel}, #dataTable td${sel} { width: ${w}px; min-width: ${w}px; max-width: ${w}px; }`);
        rules.push(`#dataTable th${sel} .filter-input, #dataTable th${sel} .filter-input-range { width: 100%; min-width: 0; }`);
    });
    return rules.join('\n');
}

// Number of rows still to load given how many are already loaded and the total.
// Never negative; used by the "Load All" button and the pagination indicator.
function remainingRowCount(loaded, total) {
    const n = (Number(total) || 0) - (Number(loaded) || 0);
    return n > 0 ? n : 0;
}

// Format a query execution time (milliseconds) for the row-count indicator.
// Returns '' for a missing/invalid value; sub-second times show as whole
// milliseconds, longer times as seconds with two decimals.
function formatExecutionTime(ms) {
    if (ms === null || ms === undefined || typeof ms !== 'number' || !isFinite(ms) || ms < 0) {
        return '';
    }
    if (ms < 1000) {
        return `${Math.round(ms)}\u00A0ms`;
    }
    return `${(ms / 1000).toFixed(2)}\u00A0s`;
}

// Reorder the column expressions of the SELECT clause in `sql` by moving the
// expression at `fromIndex` to `toIndex`, while preserving the rest of the
// statement (aliases, DISTINCT prefix, WHERE/ORDER BY/... clauses). This keeps a
// manually edited query bar (e.g. a column alias, a removed column) intact when
// the user reorders columns by drag-and-drop, instead of regenerating the query
// from scratch. Returns the rebuilt SQL, or null when the SELECT list cannot be
// safely reordered by column index (empty input, no SELECT clause, a `*`
// wildcard, or an out-of-range index) so callers can fall back.
function reorderSelectColumns(sql, fromIndex, toIndex) {
    if (typeof sql !== 'string' || sql.trim() === '') return null;
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex === toIndex) return null;
    const clauses = splitTopLevelClauses(collapseSqlWhitespace(sql));
    if (clauses.length === 0 || String(clauses[0].kw).toUpperCase() !== 'SELECT') return null;
    let body = clauses[0].content;
    let prefix = '';
    const distinct = body.match(/^DISTINCT(\s+ON\s*\([\s\S]*?\))?\s+/i);
    if (distinct) { prefix = body.slice(0, distinct[0].length); body = body.slice(distinct[0].length); }
    const exprs = splitTopLevelCommas(body).map(e => e.trim()).filter(e => e !== '');
    if (exprs.length === 0) return null;
    // A `*` / `table.*` wildcard has no 1:1 mapping to grid column indices.
    if (exprs.some(e => e === '*' || /\.\*$/.test(e))) return null;
    if (fromIndex < 0 || fromIndex >= exprs.length || toIndex < 0 || toIndex >= exprs.length) return null;
    const [moved] = exprs.splice(fromIndex, 1);
    exprs.splice(toIndex, 0, moved);
    clauses[0] = { kw: clauses[0].kw, content: prefix + exprs.join(', ') };
    return clauses.map(c => (c.content ? `${c.kw} ${c.content}` : c.kw)).join(' ').trim();
}

// Decide whether a data-load message replaces the current rows wholesale (a
// fresh first page or a re-run query) rather than appending a "Load More" page.
// Fresh loads must discard pending edits, since those edits are keyed by a
// 0-based row index that would otherwise be re-applied to unrelated new rows.
function isFreshRowLoad(offset, isAppend) {
    if (isAppend) {
        return false;
    }
    return (offset || 0) <= 0;
}

// The `readonly` attribute for a Single Record View field. A field is
// non-editable when its row is marked for deletion or when the whole view is
// read-only (e.g. an ad-hoc custom-query result that cannot be written back).
function recordFieldReadonlyAttr(isDeleted, readOnly) {
    return (isDeleted || readOnly) ? 'readonly' : '';
}

// What to do with a value that comes back from an editor tab a cell was opened
// in. The result may arrive long after the tab was opened, so the target cell
// can have disappeared (data reloaded, column removed) or have become
// non-editable in the meantime.
function cellEditorTargetState(hasRow, hasColumn, isEditable) {
    if (!hasRow || !hasColumn) return 'stale';
    if (!isEditable) return 'readonly';
    return 'apply';
}

// True when WHERE clauses can be merged into the current view's query and the
// query re-run. The query bar always holds the SQL that produced the current
// result, so this only requires a non-empty query.
function canApplyQueryFilters(sql) {
    return !!(sql && String(sql).trim());
}

// True when actions bound to a concrete table (permanent constraints, custom
// column mappings) are available. A result that cannot be traced back to a
// single table has nothing to attach them to, so those affordances are hidden.
function canManageTableMetadata(schema, table, readOnly) {
    return !readOnly && !!schema && !!table;
}

// Table name pre-filled for the INSERT export. A custom-query result has no
// source table, so a neutral placeholder is used instead of an empty name.
function defaultInsertTableName(tableReference) {
    return tableReference || 'exported_data';
}

// Compute the connection badge state shown in the Data Viewer toolbar. The
// badge is always clickable (to switch connection); `lastUsedConnection` is the
// connection the displayed rows came from and `currentConnection` is the now
// active one. Returns { text, warn, title }.
function buildConnectionBadge(lastUsedConnection, currentConnection) {
    const hint = ' (click to switch connection)';
    if (!lastUsedConnection && !currentConnection) {
        return {
            text: 'Select Connection',
            warn: false,
            title: 'Click to choose a database connection'
        };
    }
    const last = lastUsedConnection || '(none)';
    if (currentConnection && lastUsedConnection && currentConnection !== lastUsedConnection) {
        return {
            text: `⚠ ${last} → ${currentConnection}`,
            warn: true,
            title: `Data was loaded from "${last}". Active connection is now "${currentConnection}".` + hint
        };
    }
    return {
        text: last,
        warn: false,
        title: `Connection used for the currently displayed data: ${last}` + hint
    };
}

// Predicate for local (in-memory) row filtering. Returns true when `cellVal`
// passes the given column filter. A filter that cannot constrain the data
// (empty range, invalid number) matches every row.
function rowValueMatchesFilter(cellVal, filterVal, filterType, mode, thousandSeparator) {
    if (typeof filterVal === 'object' && filterVal !== null && filterVal.from !== undefined) {
        const from = filterVal.from;
        const to = filterVal.to;
        if (!from && !to) return true;
        if (filterType === 'numeric') {
            const fromNum = from ? Number(normalizeFilterInputValue(from, 'numeric', thousandSeparator)) : null;
            const toNum = to ? Number(normalizeFilterInputValue(to, 'numeric', thousandSeparator)) : null;
            if ((fromNum !== null && isNaN(fromNum)) || (toNum !== null && isNaN(toNum))) return true;
            const cell = Number(cellVal);
            if (isNaN(cell)) return false;
            if (fromNum !== null && toNum !== null) return cell >= fromNum && cell <= toNum;
            if (fromNum !== null) return cell >= fromNum;
            return cell <= toNum;
        }
        if (cellVal === null || cellVal === undefined) return false;
        const val = String(cellVal);
        if (from && to) return val >= from && val <= to;
        if (from) return val >= from;
        return val <= to;
    }

    if ((filterType === 'numeric' || filterType === 'date') && mode && mode !== 'equals') {
        if (cellVal === null || cellVal === undefined) return false;
        const a = filterType === 'numeric' ? Number(cellVal) : String(cellVal);
        const normalizedFilterVal = normalizeFilterInputValue(filterVal, filterType, thousandSeparator);
        const b = filterType === 'numeric' ? Number(normalizedFilterVal) : String(normalizedFilterVal);
        switch (mode) {
            case 'not_equals': return a !== b;
            case 'gt': return a > b;
            case 'gte': return a >= b;
            case 'lt': return a < b;
            case 'lte': return a <= b;
            default: return a === b;
        }
    }

    if (cellVal === null || cellVal === undefined) return false;
    return String(cellVal).toLowerCase().includes(String(filterVal).toLowerCase());
}

// Comparator for sorting two cell values. Nulls always sort last. `direction`
// is 'asc' or 'desc'.
function compareCellValues(valA, valB, direction) {
    if (valA === null) return 1;
    if (valB === null) return -1;
    if (typeof valA === 'number' && typeof valB === 'number') {
        return direction === 'asc' ? valA - valB : valB - valA;
    }
    const cmp = String(valA).localeCompare(String(valB));
    return direction === 'asc' ? cmp : -cmp;
}

// Normalize a raw edited cell value into the canonical string stored in the
// change set. Numeric columns are trimmed and reformatted; text columns keep
// their leading/trailing whitespace so that values with significant spaces
// (e.g. " foo") are not silently altered merely by focusing and blurring a cell.
function normalizeCellInput(rawText, isNumeric, thousandSeparator) {
    const raw = rawText || '';
    if (isNumeric) {
        const trimmed = raw.trim();
        return trimmed === '' ? '' : normalizeNumericInput(trimmed, thousandSeparator);
    }
    return raw;
}

// Value range of the Postgres integer types, as strings because bigint does
// not fit into a JS number.
const PG_INTEGER_RANGES = {
    'smallint': ['-32768', '32767'],
    'int2': ['-32768', '32767'],
    'integer': ['-2147483648', '2147483647'],
    'int': ['-2147483648', '2147483647'],
    'int4': ['-2147483648', '2147483647'],
    'bigint': ['-9223372036854775808', '9223372036854775807'],
    'int8': ['-9223372036854775808', '9223372036854775807']
};

// Split a type as reported by the database (`format_type`) into the parts a
// value has to satisfy: 'character varying(5)' -> { base: 'character varying',
// length: 5 }, 'numeric(10,2)' -> { base: 'numeric', precision: 10, scale: 2 }.
function parsePgType(fullType) {
    const raw = String(fullType || '').trim().toLowerCase();
    if (!raw) return { base: '', isArray: false };
    const isArray = /\[\s*\]\s*$/.test(raw);
    const withoutArray = raw.replace(/(\s*\[\s*\])+\s*$/, '');
    const match = withoutArray.match(/^(.*?)\s*\((\d+)(?:\s*,\s*(\d+))?\)\s*$/);
    if (!match) {
        return { base: withoutArray, isArray };
    }
    const base = match[1];
    const first = parseInt(match[2], 10);
    const second = match[3] === undefined ? undefined : parseInt(match[3], 10);
    if (base === 'numeric' || base === 'decimal') {
        return { base, isArray, precision: first, scale: second === undefined ? 0 : second };
    }
    return { base, isArray, length: first };
}

// Compare two integers given as digit strings (may exceed Number precision).
function compareIntegerStrings(a, b) {
    const left = BigInt(a);
    const right = BigInt(b);
    return left < right ? -1 : (left > right ? 1 : 0);
}

// Check an entered cell value against the column type the database reported.
// Returns 'valid', 'invalid' (with a reason to show on the cell) or 'unknown'
// for every type whose text format only Postgres itself can judge (dates,
// timestamps, intervals, JSON, enums, domains, ...) - the caller then asks the
// database. Arrays and NULL are never judged here.
function validateCellValue(value, fullType) {
    if (value === null || value === undefined || value === '') {
        return { state: 'valid' };
    }
    const text = String(value);
    const type = parsePgType(fullType);
    if (!type.base || type.isArray) {
        return { state: 'unknown' };
    }

    const range = PG_INTEGER_RANGES[type.base];
    if (range) {
        if (!/^[+-]?\d+$/.test(text.trim())) {
            return { state: 'invalid', reason: `"${text}" is not a whole number (${type.base})` };
        }
        const digits = text.trim();
        if (compareIntegerStrings(digits, range[0]) < 0 || compareIntegerStrings(digits, range[1]) > 0) {
            return { state: 'invalid', reason: `${digits} is out of range for ${type.base} (${range[0]} … ${range[1]})` };
        }
        return { state: 'valid' };
    }

    if (type.base === 'numeric' || type.base === 'decimal') {
        const trimmed = text.trim();
        if (/^[+-]?(nan|infinity)$/i.test(trimmed)) {
            return { state: 'valid' };
        }
        const num = trimmed.match(/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/);
        if (!num) {
            return { state: 'invalid', reason: `"${text}" is not a valid ${type.base} value` };
        }
        if (type.precision !== undefined && !/[eE]/.test(trimmed)) {
            const intDigits = trimmed.replace(/^[+-]/, '').split('.')[0].replace(/^0+(?=\d)/, '');
            const allowed = type.precision - (type.scale || 0);
            if (intDigits !== '0' && intDigits.length > allowed) {
                return { state: 'invalid', reason: `Too large for numeric(${type.precision},${type.scale || 0}): at most ${allowed} digit(s) before the decimal point` };
            }
        }
        return { state: 'valid' };
    }

    if (type.base === 'real' || type.base === 'double precision' || type.base === 'float4' || type.base === 'float8') {
        const trimmed = text.trim();
        if (/^[+-]?(nan|infinity)$/i.test(trimmed)) {
            return { state: 'valid' };
        }
        if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
            return { state: 'invalid', reason: `"${text}" is not a valid ${type.base} value` };
        }
        return { state: 'valid' };
    }

    if (type.base === 'character varying' || type.base === 'varchar' ||
        type.base === 'character' || type.base === 'char' || type.base === 'bpchar') {
        if (type.length !== undefined && Array.from(text).length > type.length) {
            return { state: 'invalid', reason: `Too long for ${type.base}(${type.length}): ${Array.from(text).length} characters` };
        }
        return { state: 'valid' };
    }

    if (type.base === 'text' || type.base === 'name' || type.base === 'citext') {
        return { state: 'valid' };
    }

    if (type.base === 'boolean' || type.base === 'bool') {
        if (!/^(t|f|true|false|y|n|yes|no|on|off|1|0)$/i.test(text.trim())) {
            return { state: 'invalid', reason: `"${text}" is not a boolean value` };
        }
        return { state: 'valid' };
    }

    if (type.base === 'uuid') {
        if (!/^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i.test(text.trim())) {
            return { state: 'invalid', reason: `"${text}" is not a valid uuid` };
        }
        return { state: 'valid' };
    }

    return { state: 'unknown' };
}

// Share of the length a value may reach before the counter warns.
const CHAR_BUDGET_WARNING_RATIO = 0.8;

// How much of a length-limited column a value uses, for the counter shown
// while editing. Returns null for every type without a character limit
// (`text`, `varchar` without length, numbers, arrays), so the caller can omit
// the counter entirely. Characters are counted the way Postgres counts them
// for the length limit, not bytes.
function describeCharacterBudget(value, fullType) {
    const type = parsePgType(fullType);
    const limited = ['character varying', 'varchar', 'character', 'char', 'bpchar'];
    if (type.isArray || type.length === undefined || limited.indexOf(type.base) === -1) {
        return null;
    }
    const used = (value === null || value === undefined) ? 0 : Array.from(String(value)).length;
    const limit = type.length;
    const remaining = limit - used;
    if (remaining < 0) {
        return { used, limit, remaining, state: 'exceeded', text: `${used} / ${limit} · ${-remaining} over` };
    }
    const state = used >= limit * CHAR_BUDGET_WARNING_RATIO ? 'warning' : 'normal';
    return { used, limit, remaining, state, text: `${used} / ${limit} · ${remaining} left` };
}

// CSS class suffix for the character counter, so a value close to or beyond
// the column length stands out.
function charBudgetStateClass(budget) {
    if (!budget || budget.state === 'normal') return '';
    return budget.state === 'exceeded' ? ' is-exceeded' : ' is-warning';
}

// Context-dependent keywords that stand on their own, without parentheses.
const VOLATILE_DEFAULT_KEYWORDS = /\b(current_date|current_time|current_timestamp|localtime|localtimestamp|current_user|session_user|current_role|user)\b/i;

// Any call, qualified or not: now(), nextval(...), oracle.sysdate().
const FUNCTION_CALL_PATTERN = /[A-Za-z_][A-Za-z0-9_$]*\s*(?:\.\s*[A-Za-z_][A-Za-z0-9_$]*\s*)*\(/;

// Drop string literals and casts before looking for a call — 'user'::text and
// '0'::numeric(10,2) would otherwise read as a keyword and as a call.
function stripDefaultNoise(expression) {
    return expression
        .replace(/'(?:[^']|'')*'/g, "''")
        .replace(/::\s*[A-Za-z_][A-Za-z0-9_ ]*(\s*\([^)]*\))?(\s*\[\s*\])*/g, '');
}

// 'generated' (identity / GENERATED ALWAYS AS), 'volatile' (a new value per
// row), 'constant' (a fixed default worth copying) or null when the column has
// no default at all.
function classifyColumnDefault(info) {
    if (!info) return null;
    if (info.isIdentity || info.isGenerated) return 'generated';
    const expression = typeof info.defaultExpression === 'string' ? info.defaultExpression.trim() : '';
    if (!expression) return null;
    const bare = stripDefaultNoise(expression);
    const isVolatile = VOLATILE_DEFAULT_KEYWORDS.test(bare) || FUNCTION_CALL_PATTERN.test(bare);
    return isVolatile ? 'volatile' : 'constant';
}

// Which columns a duplicated row leaves to the database, for the configured
// mode: 'volatile' (default), 'all' or 'none'.
function defaultResetColumns(columnDefaults, mode) {
    if (mode === 'none' || !Array.isArray(columnDefaults)) return [];
    return columnDefaults
        .filter(info => {
            const kind = classifyColumnDefault(info);
            return kind !== null && (mode === 'all' || kind !== 'constant');
        })
        .map(info => info.column);
}

// Tooltip explaining why a duplicated cell was not copied.
function defaultCellTitle(info) {
    const kind = classifyColumnDefault(info);
    if (kind === 'generated') {
        return 'Generated by the database on save';
    }
    const expression = info && typeof info.defaultExpression === 'string' ? info.defaultExpression.trim() : '';
    return expression
        ? `Filled by the database on save (${expression})`
        : 'Filled by the database on save';
}

// Text and button state of the pending-changes indicator. Saving is blocked
// while a cell holds a value the column cannot store.
function describePendingChanges(counts, invalidCount) {
    const c = counts || {};
    const parts = [];
    if (c.modified > 0) parts.push(`${c.modified} modified`);
    if (c.inserted > 0) parts.push(`${c.inserted} inserted`);
    if (c.duplicated > 0) parts.push(`${c.duplicated} duplicated`);
    if (c.deleted > 0) parts.push(`${c.deleted} deleted`);
    const invalid = invalidCount || 0;
    if (parts.length === 0) {
        return { text: 'No pending changes', canCommit: false, canDiscard: false };
    }
    if (invalid > 0) {
        return {
            text: `Pending: ${parts.join(', ')} — ${invalid} invalid value${invalid === 1 ? '' : 's'}`,
            canCommit: false,
            canDiscard: true
        };
    }
    return { text: `Pending: ${parts.join(', ')}`, canCommit: true, canDiscard: true };
}

// Build the set of column/value pairs that uniquely identifies a row for an
// UPDATE/DELETE WHERE clause. Tables with a primary key use only the PK
// columns. Tables WITHOUT a primary key fall back to matching every column of
// the row, so edits and deletes still target the correct row(s) instead of
// producing an empty WHERE clause (which would fail or affect all rows).
//
// `columnNames` is the ordered list of all column names; `row` is the source
// row object. NULL values are kept in the identity so the caller can emit
// `IS NULL` for them.
function buildRowIdentity(primaryKeys, columnNames, row) {
    const id = {};
    const keys = (primaryKeys && primaryKeys.length > 0) ? primaryKeys : (columnNames || []);
    keys.forEach(col => {
        id[col] = row ? row[col] : undefined;
    });
    return id;
}

// Capabilities of a result that could not be traced back to any table: the
// grid is shown read-only until the extension reports something better.
function emptyCapabilities() {
    return {
        canEdit: false,
        canInsert: false,
        canDelete: false,
        canConstrain: false,
        canMap: false,
        schema: null,
        table: null,
        identityStrategy: 'none',
        tables: [],
        columnSources: {},
        editableColumns: [],
        warning: null
    };
}

// Merge the capabilities reported by the extension with the defaults so a
// partial or missing payload cannot leave the view in an inconsistent state.
function normalizeCapabilities(raw) {
    const base = emptyCapabilities();
    if (!raw || typeof raw !== 'object') {
        return base;
    }
    return {
        canEdit: !!raw.canEdit,
        canInsert: !!raw.canInsert,
        canDelete: !!raw.canDelete,
        canConstrain: !!raw.canConstrain,
        canMap: !!raw.canMap,
        schema: raw.schema || null,
        table: raw.table || null,
        identityStrategy: raw.identityStrategy || 'none',
        tables: Array.isArray(raw.tables) ? raw.tables : [],
        columnSources: raw.columnSources || {},
        editableColumns: Array.isArray(raw.editableColumns) ? raw.editableColumns : [],
        warning: raw.warning || null
    };
}

// Group the pending edits of the grid by the table each edited column really
// belongs to, so a result joined from several tables writes every change back
// to its own table within one transaction.
//
// `edits.updates` is a list of `[rowIndex, { resultColumn: newValue }]` pairs,
// `edits.deletes` a list of row indices and `edits.inserts` a list of new row
// objects keyed by result column name. Rows are identified through the identity
// columns of the respective table (its primary key when available).
function buildCommitTargets(caps, rows, edits) {
    const capabilities = normalizeCapabilities(caps);
    const sources = capabilities.columnSources;
    const tables = capabilities.tables;
    const planFor = (tableOid) => tables.find(t => t.tableOid === tableOid) || null;
    const targets = new Map();

    function targetFor(plan) {
        if (!targets.has(plan.tableOid)) {
            targets.set(plan.tableOid, {
                tableOid: plan.tableOid,
                schema: plan.schema,
                table: plan.table,
                identityStrategy: plan.identityStrategy,
                changes: { updates: [], inserts: [], deletes: [] }
            });
        }
        return targets.get(plan.tableOid);
    }

    function identityFor(plan, row) {
        const id = {};
        (plan.identityColumns || []).forEach(col => {
            id[col.sourceColumn] = row ? row[col.name] : undefined;
        });
        return id;
    }

    (edits.updates || []).forEach(([rowIdx, changed]) => {
        const row = (rows || [])[rowIdx];
        const perTable = new Map();
        Object.keys(changed || {}).forEach(colName => {
            const source = sources[colName];
            if (!source) { return; }
            if (!perTable.has(source.tableOid)) { perTable.set(source.tableOid, {}); }
            perTable.get(source.tableOid)[source.sourceColumn] = changed[colName];
        });
        perTable.forEach((changes, tableOid) => {
            const plan = planFor(tableOid);
            if (!plan || plan.identityStrategy === 'none') { return; }
            targetFor(plan).changes.updates.push({ primaryKey: identityFor(plan, row), changes });
        });
    });

    // Inserting or deleting a row is only meaningful when the whole result
    // comes from exactly one table.
    const single = tables.length === 1 ? tables[0] : null;
    if (single && single.identityStrategy !== 'none') {
        (edits.deletes || []).forEach(rowIdx => {
            targetFor(single).changes.deletes.push(identityFor(single, (rows || [])[rowIdx]));
        });
        (edits.inserts || []).forEach(row => {
            const clean = {};
            Object.keys(row || {}).forEach(colName => {
                const source = sources[colName];
                const value = row[colName];
                if (!source || source.tableOid !== single.tableOid) { return; }
                if (value === '' || value === null || value === undefined) { return; }
                clean[source.sourceColumn] = value;
            });
            if (Object.keys(clean).length > 0) {
                targetFor(single).changes.inserts.push(clean);
            }
        });
    }

    return Array.from(targets.values()).filter(t =>
        t.changes.updates.length > 0 || t.changes.inserts.length > 0 || t.changes.deletes.length > 0
    );
}

// Text for the row-count indicator. An exact total is only known when it was
// counted (always for the default table view, on demand for other queries);
// until then the loaded row count is shown instead.
function describeRowCount(showing, totalCount, moreAvailable) {
    if (typeof totalCount === 'number') {
        return `Showing ${showing} of ${totalCount} rows`;
    }
    return `${showing} rows loaded` + (moreAvailable ? ' (more available)' : '');
}

// How trustworthy writing back a column is, used to colour its header:
// 'editable' (traced to a table column identified by a primary key),
// 'unsafe' (traced to a table column, but rows are matched by their values)
// and 'readonly' (computed column with no source table).
function columnWriteMode(caps, colName) {
    const capabilities = normalizeCapabilities(caps);
    const source = capabilities.columnSources[colName];
    if (!source) {
        return 'readonly';
    }
    const plan = capabilities.tables.find(t => t.tableOid === source.tableOid);
    return (plan && plan.identityStrategy === 'pk') ? 'editable' : 'unsafe';
}

// True when the statements in the commit preview were changed by the user.
// Pure whitespace differences are ignored so re-indenting is not treated as
// an edit.
function isSqlEdited(generated, edited) {
    return collapseSqlWhitespace(String(edited || '')).trim()
        !== collapseSqlWhitespace(String(generated || '')).trim();
}

// Warnings shown in the commit preview: how reliably the rows can be matched
// and whether the connection changed since the data was loaded.
function buildCommitWarnings(capabilityWarning, currentConnection, loadedConnection) {
    const warnings = [];
    if (capabilityWarning) {
        warnings.push(capabilityWarning);
    }
    if (currentConnection && loadedConnection && currentConnection !== loadedConnection) {
        warnings.push(
            `The active connection (${currentConnection}) differs from the connection the data was loaded with `
            + `(${loadedConnection}). Executing will run against "${currentConnection}".`
        );
    }
    return warnings;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
(function() {
    const vscode = acquireVsCodeApi();

    let columns = [];
    let primaryKeys = [];
    let foreignKeys = []; // [{column, refSchema, refTable, refColumn}]
    let columnDefaults = []; // [{column, defaultExpression, isIdentity, isGenerated}]
    let duplicateResetMode = 'volatile';
    let referencingTables = []; // [{fkSchema, fkTable, fkColumn, localColumn}]
    let customMappings = []; // [{id, sourceColumn, targetSchema, targetTable, targetColumn, conditions, isDefault, label}]
    let allRows = [];
    let displayedRows = [];
    let schema = '';
    let table = '';
    let tableReference = '';
    let alwaysQuote = false;
    let thousandSeparator = ' ';
    // Exact number of rows the current query returns, or null while unknown
    // (counting an arbitrary query is only done on request).
    let totalCount = null;
    let currentOffset = 0;
    // Permanent per-table WHERE constraints (array of ConstraintCondition).
    // Applied to the default table view's query every time it loads.
    let permanentConstraints = [];
    // Permanent per-table ORDER BY entries ({ column, direction }), applied to
    // the default table view's query alongside the constraints.
    let permanentSorts = [];
    // Saved query the panel currently runs: the template still holds the
    // `:name` placeholders, while the query bar shows the substituted SQL.
    let savedQueryId = '';
    let savedQueryTemplate = '';
    let savedQueryParameters = [];
    let savedQueryValues = {};
    // All stored queries, kept for the overwrite list in the Save dialog.
    let savedQueries = [];
    // SQL/parameters sent to the extension, adopted once the save is confirmed.
    let savedQueryPending = null;
    // True while the initial parameter prompt of a saved query is open.
    let queryParamsPendingInitialRun = false;
    let lastUsedConnection = '';
    let currentConnection = '';
    // What the current result allows. Derived by the extension from the source
    // tables of the displayed columns, so an ad-hoc SELECT gets the same
    // features as a table opened from the tree whenever that is possible.
    let caps = emptyCapabilities();
    // Pagination state of the query currently displayed. `currentSql` is the
    // query without a trailing LIMIT/OFFSET so Load More can page through it.
    let currentSql = '';           // SQL without trailing LIMIT/OFFSET clause
    let userPaged = false;         // true when the user wrote an explicit LIMIT/OFFSET
    let appendPending = false;
    let moreAvailable = false;
    // Set when the user pressed "Load All": the next result has fetched every
    // remaining row, so pagination buttons stay disabled even though the
    // heuristic (a full last batch) cannot tell there is no more.
    let allLoaded = false;
    // Execution time (ms) of the most recent data/custom query, shown next to
    // the row-count indicator. null when not yet known.
    let lastQueryDurationMs = null;
    const PAGE_SIZE = 50;
    // NOTE: Single source of truth is src/reservedKeywords.ts. This browser
    // script is injected as a plain string and cannot import it at runtime;
    // src/test/reservedKeywords.test.ts enforces that this copy stays in sync.
    const POSTGRES_RESERVED_KEYWORDS = new Set([
        'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric',
        'authorization', 'between', 'binary', 'both', 'case', 'cast', 'check', 'collate',
        'column', 'concurrently', 'constraint', 'create', 'cross', 'current_catalog',
        'current_date', 'current_role', 'current_schema', 'current_time', 'current_timestamp',
        'current_user', 'default', 'deferrable', 'desc', 'distinct', 'do', 'else', 'end',
        'except', 'false', 'fetch', 'for', 'foreign', 'from', 'freeze', 'full', 'grant',
        'group', 'having', 'ilike', 'in', 'initially', 'inner', 'intersect', 'into', 'is',
        'isnull', 'join', 'lateral', 'leading', 'left', 'like', 'limit', 'localtime',
        'localtimestamp', 'natural', 'not', 'notnull', 'null', 'offset', 'on', 'only', 'or',
        'order', 'outer', 'overlaps', 'placing', 'primary', 'references', 'returning', 'right',
        'select', 'session_user', 'similar', 'some', 'symmetric', 'table', 'then', 'to',
        'trailing', 'true', 'union', 'unique', 'user', 'using', 'variadic', 'verbose', 'when',
        'where', 'window', 'with'
    ]);

    let modifiedCells = new Map(); // "rowIndex:colName" -> newValue
    let deletedRows = new Set();   // rowIndex
    let insertedRows = [];          // [{ row: {col: val, ...}, anchor: number|null }]
    let duplicatedRows = [];        // [{ row: {col: val, ...}, anchor: number|null }]
    let invalidCells = new Map();  // cell key -> why the column cannot store the value

    // Drop every pending (uncommitted) edit. Called whenever a fresh page of
    // data replaces the current rows, so that per-row-index changes are never
    // re-applied to unrelated rows after a reload.
    function resetPendingChanges() {
        modifiedCells.clear();
        deletedRows.clear();
        insertedRows = [];
        duplicatedRows = [];
        invalidCells.clear();
        selectedRowIdx = null;
    }

    // Index of the currently "selected" existing row (the one most recently
    // clicked). New / duplicated rows are inserted directly below this row.
    // null means no row is selected -> new rows appear at the very top.
    let selectedRowIdx = null;

    // Active sort plus the one it replaced, so a third click can go back to it.
    let sortState = { column: null, direction: 'asc', previous: null };

    // Name of the column currently being dragged in the header (drag-and-drop
    // reordering), or null when no drag is in progress.
    let dragSourceCol = null;

    // Row-height resize: the default (single-line) content height in px must
    // match the CSS fallback for --row-content-max-h; MAX bounds how far a row
    // can be dragged open. `rowResizeState` holds the in-flight drag.
    const DEFAULT_ROW_CONTENT_H = 20;
    const MAX_ROW_CONTENT_H = 600;
    let rowResizeState = null;

    function startRowResize(e) {
        const tr = e.target.closest('tr');
        if (!tr) return;
        e.preventDefault();
        e.stopPropagation();
        const startVar = tr.style.getPropertyValue('--row-content-max-h');
        const startHeight = startVar ? parseFloat(startVar) : DEFAULT_ROW_CONTENT_H;
        rowResizeState = { tr, startY: e.clientY, startHeight };
        document.addEventListener('mousemove', onRowResizeMove);
        document.addEventListener('mouseup', endRowResize);
        document.body.classList.add('row-resizing');
    }

    function onRowResizeMove(e) {
        if (!rowResizeState) return;
        const delta = e.clientY - rowResizeState.startY;
        const h = computeResizedRowHeight(rowResizeState.startHeight, delta, DEFAULT_ROW_CONTENT_H, MAX_ROW_CONTENT_H);
        rowResizeState.tr.style.setProperty('--row-content-max-h', h + 'px');
    }

    function endRowResize() {
        rowResizeState = null;
        document.removeEventListener('mousemove', onRowResizeMove);
        document.removeEventListener('mouseup', endRowResize);
        document.body.classList.remove('row-resizing');
    }

    // Column-width resize: widths the user dragged, keyed by column name so they
    // survive re-renders and column reordering. They are applied through one
    // generated stylesheet instead of inline styles, because every cell of a
    // column must carry the width for the table layout to honour it.
    const MIN_COL_W = 40;
    const MAX_COL_W = 1200;
    let columnWidths = {};
    let colResizeState = null;
    // A finished drag is followed by a click on the header, which would sort it.
    // Timestamp instead of a flag, so a release outside the header expires too.
    let colResizeEndedAt = 0;
    const columnWidthStyle = document.createElement('style');
    document.head.appendChild(columnWidthStyle);

    function applyColumnWidths() {
        columnWidthStyle.textContent = buildColumnWidthCss(columnWidths);
    }

    function startColumnResize(e) {
        const th = e.target.closest('th');
        if (!th) return;
        e.preventDefault();
        e.stopPropagation();
        const col = th.getAttribute('data-col');
        // The header is draggable for reordering; that must not start here.
        th.draggable = false;
        colResizeState = { col, th, startX: e.clientX, startWidth: th.getBoundingClientRect().width };
        document.addEventListener('mousemove', onColumnResizeMove);
        document.addEventListener('mouseup', endColumnResize);
        document.body.classList.add('col-resizing');
    }

    function onColumnResizeMove(e) {
        if (!colResizeState) return;
        const delta = e.clientX - colResizeState.startX;
        columnWidths[colResizeState.col] = computeResizedColumnWidth(colResizeState.startWidth, delta, MIN_COL_W, MAX_COL_W);
        applyColumnWidths();
    }

    function endColumnResize() {
        if (colResizeState) {
            colResizeState.th.draggable = true;
            colResizeEndedAt = Date.now();
        }
        colResizeState = null;
        document.removeEventListener('mousemove', onColumnResizeMove);
        document.removeEventListener('mouseup', endColumnResize);
        document.body.classList.remove('col-resizing');
    }

    let filters = {};
    let exactFilters = {}; // FK filters that use exact match
    let filterModes = {}; // 'contains' | 'between' per column

    const tableHead = document.getElementById('tableHead');
    const dataTable = document.getElementById('dataTable');
    const tableBody = document.getElementById('tableBody');
    const tableName = document.getElementById('tableName');
    const rowCount = document.getElementById('rowCount');
    const commitBtn = document.getElementById('commitBtn');
    const discardBtn = document.getElementById('discardBtn');
    const insertRowBtn = document.getElementById('insertRowBtn');
    const loadMoreBtn = document.getElementById('loadMoreBtn');
    const loadAllBtn = document.getElementById('loadAllBtn');
    const changeCount = document.getElementById('changeCount');
    const sqlDialogOverlay = document.getElementById('sqlDialogOverlay');
    const sqlDialogContent = document.getElementById('sqlDialogContent');
    const sqlDialogExecute = document.getElementById('sqlDialogExecute');
    const sqlDialogCancel = document.getElementById('sqlDialogCancel');
    const sqlDialogClose = document.getElementById('sqlDialogClose');
    const sqlDialogReset = document.getElementById('sqlDialogReset');
    const queryInput = document.getElementById('queryInput');
    const queryRunBtn = document.getElementById('queryRunBtn');
    const queryFormatBtn = document.getElementById('queryFormatBtn');
    const queryHistoryContainer = document.getElementById('queryHistoryContainer');
    const queryHistoryToggle = document.getElementById('queryHistoryToggle');
    const queryHistoryPanel = document.getElementById('queryHistoryPanel');
    const queryHistorySearch = document.getElementById('queryHistorySearch');
    const queryHistoryList = document.getElementById('queryHistoryList');
    const queryHistoryEmpty = document.getElementById('queryHistoryEmpty');
    let queryHistoryEntries = [];
    let queryHistoryActiveIdx = -1;
    const contextMenu = document.getElementById('contextMenu');
    const contextMenuItems = document.getElementById('contextMenuItems');
    const contextMenuSearch = document.getElementById('contextMenuSearch');
    const contextMenuEmpty = document.getElementById('contextMenuEmpty');
    const charBudgetBadge = document.getElementById('charBudgetBadge');
    const dataLoading = document.getElementById('dataLoading');
    const dataLoadingOverlay = document.getElementById('dataLoadingOverlay');
    const metaLoading = document.getElementById('metaLoading');
    const connectionInfo = document.getElementById('connectionInfo');
    const sqlDialogConnection = document.getElementById('sqlDialogConnection');
    const sqlDialogWarning = document.getElementById('sqlDialogWarning');

    // The overlay only veils the rows: it starts below the pinned header and
    // filter rows so a filter can still be typed while the data is on its way.
    function setDataLoading(active) {
        dataLoading.classList.toggle('hidden', !active);
        if (!dataLoadingOverlay) return;
        if (active) {
            const head = Math.round(tableHead.getBoundingClientRect().height);
            dataLoadingOverlay.style.setProperty('--data-overlay-top', head + 'px');
        }
        dataLoadingOverlay.classList.toggle('visible', active);
    }

    // Show data loading spinner. The actual initial load is kicked off from
    // handleInit() once the extension tells us whether this is a normal table
    // view or a read-only custom query.
    setDataLoading(true);

    // Set the query bar text, pretty-printed as a formatted multi-line SELECT,
    // and resize the textarea to fit.
    function setQueryText(sql) {
        queryInput.value = formatSql(sql == null ? '' : String(sql));
        autoSizeQueryInput();
    }

    // Grow/shrink the query textarea to fit its content (bounded by the CSS
    // max-height).
    function autoSizeQueryInput() {
        if (!queryInput) return;
        queryInput.style.height = 'auto';
        queryInput.style.height = (queryInput.scrollHeight + 2) + 'px';
    }

    commitBtn.addEventListener('click', commitChanges);
    discardBtn.addEventListener('click', discardChanges);
    insertRowBtn.addEventListener('click', insertRow);
    loadMoreBtn.addEventListener('click', loadMore);
    loadAllBtn.addEventListener('click', loadAll);
    // Counting all rows of an arbitrary query can be expensive, so it only runs
    // when the user asks for it by clicking the row-count indicator.
    if (rowCount) {
        rowCount.addEventListener('click', () => {
            if (typeof totalCount === 'number' || !currentSql) return;
            rowCount.textContent = 'Counting rows…';
            vscode.postMessage({ command: 'getTotalCount', sql: currentSql });
        });
    }
    // Clicking the connection badge lets the user switch to another saved
    // connection (handled by the extension host).
    if (connectionInfo) {
        connectionInfo.addEventListener('click', () => {
            vscode.postMessage({ command: 'selectConnection' });
        });
    }
    // Recompute the sticky filter-row offset when the header may rewrap.
    window.addEventListener('resize', updateStickyFilterOffset);
    sqlDialogCancel.addEventListener('click', closeSqlDialog);
    sqlDialogClose.addEventListener('click', closeSqlDialog);
    sqlDialogExecute.addEventListener('click', executePendingChanges);
    if (sqlDialogReset) {
        sqlDialogReset.addEventListener('click', () => {
            sqlDialogContent.value = generatedSql;
            sqlDialogContent.focus();
        });
    }
    queryRunBtn.addEventListener('click', runQuery);
    if (queryFormatBtn) {
        queryFormatBtn.addEventListener('click', () => {
            setQueryText(queryInput.value);
            queryInput.focus();
        });
    }
    queryInput.addEventListener('keydown', (e) => {
        // The query input is a multi-line textarea: plain Enter inserts a new
        // line, Ctrl/Cmd+Enter runs the query.
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            runQuery();
        }
    });
    queryInput.addEventListener('input', autoSizeQueryInput);

    queryHistoryToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleQueryHistoryPanel();
    });
    queryHistorySearch.addEventListener('input', () => {
        queryHistoryActiveIdx = -1;
        renderQueryHistoryList();
    });
    queryHistorySearch.addEventListener('keydown', (e) => {
        const items = queryHistoryList.querySelectorAll('li');
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (items.length === 0) return;
            queryHistoryActiveIdx = (queryHistoryActiveIdx + 1) % items.length;
            highlightActiveHistoryItem(items);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (items.length === 0) return;
            queryHistoryActiveIdx = (queryHistoryActiveIdx - 1 + items.length) % items.length;
            highlightActiveHistoryItem(items);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (queryHistoryActiveIdx >= 0 && items[queryHistoryActiveIdx]) {
                selectQueryHistoryItem(items[queryHistoryActiveIdx].getAttribute('data-sql'));
            } else if (items.length > 0) {
                selectQueryHistoryItem(items[0].getAttribute('data-sql'));
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeQueryHistoryPanel();
            queryHistoryToggle.focus();
        }
    });
    queryHistoryPanel.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    document.addEventListener('click', () => {
        hideContextMenu();
        closeQueryHistoryPanel();
    });

    // Typing in the menu's search box must not count as a click beside it.
    contextMenu.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    contextMenuSearch.addEventListener('input', filterContextMenu);
    contextMenuSearch.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            hideContextMenu();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const first = contextMenuItems.querySelector('li[data-action-idx]:not(.hidden)');
            if (first) { first.click(); }
        }
    });

    // Strip thousand separators from numeric cells when copying from the grid,
    // so a displayed "9 999 999,99" lands on the clipboard as "9999999,99".
    document.addEventListener('copy', handleGridCopy);

    // --- Excel-like rectangular cell selection ------------------------------
    // Drag across data cells (or Shift+click) to select a rectangle spanning any
    // number of columns and rows, then Ctrl/Cmd+C copies it as TAB-separated
    // columns and CRLF-separated rows (pastes straight into Excel). A plain
    // single click keeps the normal edit/focus behaviour.
    let rangeAnchor = null;   // {r, c} first corner of the selection
    let rangeFocus = null;    // {r, c} opposite corner
    let rangeMouseDown = null; // candidate anchor recorded on mousedown
    let rangeDragging = false;

    function cellCoords(td) {
        const tr = td.closest('tr');
        if (!tr || tr.parentElement !== tableBody) return null;
        const dataCells = tr.querySelectorAll(':scope > td[data-col]');
        const c = Array.prototype.indexOf.call(dataCells, td);
        if (c < 0) return null;
        return { r: tr.sectionRowIndex, c };
    }

    function clearNativeTextSelection() {
        const s = window.getSelection();
        if (s && s.rangeCount) s.removeAllRanges();
    }

    function clearCellRangeSelection() {
        rangeAnchor = null;
        rangeFocus = null;
        tableBody.querySelectorAll('td.cell-range-selected')
            .forEach(td => td.classList.remove('cell-range-selected'));
    }

    function rangeBounds() {
        return {
            minR: Math.min(rangeAnchor.r, rangeFocus.r),
            maxR: Math.max(rangeAnchor.r, rangeFocus.r),
            minC: Math.min(rangeAnchor.c, rangeFocus.c),
            maxC: Math.max(rangeAnchor.c, rangeFocus.c)
        };
    }

    function applyCellRangeHighlight() {
        tableBody.querySelectorAll('td.cell-range-selected')
            .forEach(td => td.classList.remove('cell-range-selected'));
        if (!rangeAnchor || !rangeFocus) return;
        const { minR, maxR, minC, maxC } = rangeBounds();
        const rows = tableBody.rows;
        for (let r = minR; r <= maxR; r++) {
            const tr = rows[r];
            if (!tr) continue;
            const dataCells = tr.querySelectorAll(':scope > td[data-col]');
            for (let c = minC; c <= maxC && c < dataCells.length; c++) {
                dataCells[c].classList.add('cell-range-selected');
            }
        }
    }

    // Collect the selected rectangle as a matrix of display strings, stripping
    // thousand separators from numeric columns just like a native grid copy.
    function collectCellRangeMatrix() {
        if (!rangeAnchor || !rangeFocus) return null;
        const { minR, maxR, minC, maxC } = rangeBounds();
        const rows = tableBody.rows;
        const matrix = [];
        for (let r = minR; r <= maxR; r++) {
            const tr = rows[r];
            if (!tr) continue;
            const dataCells = tr.querySelectorAll(':scope > td[data-col]');
            const parts = [];
            for (let c = minC; c <= maxC && c < dataCells.length; c++) {
                const td = dataCells[c];
                const text = getCellTextContent(td);
                parts.push(isNumericColumn(td.getAttribute('data-col'))
                    ? stripThousandSeparators(text, thousandSeparator)
                    : text);
            }
            matrix.push(parts);
        }
        return matrix;
    }

    function copyCellRangeToClipboard() {
        const matrix = collectCellRangeMatrix();
        if (!matrix || matrix.length === 0) return false;
        const tsv = cellRangeToTsv(matrix);
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(tsv).catch(() => fallbackClipboardCopy(tsv));
        } else {
            fallbackClipboardCopy(tsv);
        }
        return true;
    }

    function fallbackClipboardCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (_) { /* ignore */ }
        document.body.removeChild(ta);
    }

    tableBody.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        const td = e.target.closest('td[data-col]');
        if (!td || td.parentElement.parentElement !== tableBody) return;
        const coords = cellCoords(td);
        if (!coords) return;
        if (e.shiftKey && rangeAnchor) {
            rangeFocus = coords;
            applyCellRangeHighlight();
            clearNativeTextSelection();
            e.preventDefault();
            return;
        }
        // Record a potential drag anchor; a plain click still edits/focuses the cell.
        rangeMouseDown = { td, r: coords.r, c: coords.c };
        rangeDragging = false;
    });

    document.addEventListener('mousemove', (e) => {
        if (!rangeMouseDown) return;
        if (e.buttons === 0) { rangeMouseDown = null; return; }
        const td = e.target && e.target.closest ? e.target.closest('td[data-col]') : null;
        if (!td || td.parentElement.parentElement !== tableBody) return;
        const coords = cellCoords(td);
        if (!coords) return;
        if (!rangeDragging) {
            if (coords.r === rangeMouseDown.r && coords.c === rangeMouseDown.c) return;
            rangeDragging = true;
            rangeAnchor = { r: rangeMouseDown.r, c: rangeMouseDown.c };
            tableBody.classList.add('range-dragging');
            if (document.activeElement && typeof document.activeElement.blur === 'function') {
                document.activeElement.blur();
            }
        }
        rangeFocus = coords;
        applyCellRangeHighlight();
        clearNativeTextSelection();
        e.preventDefault();
    });

    document.addEventListener('mouseup', () => {
        if (rangeMouseDown && !rangeDragging) {
            // Plain click (no drag): drop any previous rectangle so single-cell
            // editing/selection behaves normally.
            clearCellRangeSelection();
        }
        rangeMouseDown = null;
        rangeDragging = false;
        tableBody.classList.remove('range-dragging');
    });

    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C') && rangeAnchor && rangeFocus) {
            const sel = window.getSelection();
            const hasInCellText = sel && !sel.isCollapsed && sel.toString().length > 0;
            if (!hasInCellText && copyCellRangeToClipboard()) {
                e.preventDefault();
            }
        } else if (e.key === 'Escape' && rangeAnchor) {
            clearCellRangeSelection();
        }
    });

    function isNumericColumn(colName) {
        const colMeta = columns.find(c => c.name === colName);
        return colMeta ? getColumnFilterType(colMeta.dataType) === 'numeric' : false;
    }

    function handleGridCopy(e) {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;

        // Only act on selections that cover data cells in the grid.
        const cells = Array.from(tableBody.querySelectorAll('td[data-col]'))
            .filter(td => sel.containsNode(td, true));
        if (cells.length === 0) return;

        // Leave native copy untouched unless at least one numeric cell is involved.
        if (!cells.some(td => isNumericColumn(td.getAttribute('data-col')))) return;

        // Single cell: respect a partial in-cell text selection; only normalize
        // when the column is numeric.
        if (cells.length === 1) {
            const td = cells[0];
            if (!isNumericColumn(td.getAttribute('data-col'))) return;
            const selectedText = sel.toString();
            const fullText = getCellTextContent(td);
            const source = (selectedText && selectedText.trim() && selectedText.trim() !== fullText)
                ? selectedText.trim()
                : fullText;
            e.clipboardData.setData('text/plain', stripThousandSeparators(source, thousandSeparator));
            e.preventDefault();
            return;
        }

        // Multiple cells: rebuild tab/newline separated text, normalizing the
        // numeric columns and leaving everything else as displayed.
        const rowMap = new Map();
        for (const td of cells) {
            const tr = td.closest('tr');
            if (!rowMap.has(tr)) rowMap.set(tr, []);
            rowMap.get(tr).push(td);
        }
        const lines = [];
        for (const rowCells of rowMap.values()) {
            const parts = rowCells.map(td => {
                const text = getCellTextContent(td);
                return isNumericColumn(td.getAttribute('data-col'))
                    ? stripThousandSeparators(text, thousandSeparator)
                    : text;
            });
            lines.push(parts.join('\t'));
        }
        e.clipboardData.setData('text/plain', lines.join('\n'));
        e.preventDefault();
    }

    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.command) {
            case 'init':
                handleInit(msg);
                break;
            case 'rowsLoaded':
                handleRowsLoaded(msg);
                break;
            case 'columnsLoaded':
                handleColumnsLoaded(msg);
                break;
            case 'totalCountLoaded':
                totalCount = msg.totalCount;
                updateRowCount();
                break;
            case 'loadingFinished':
                setDataLoading(false);
                break;
            case 'primaryKeysLoaded':
                handlePrimaryKeysLoaded(msg);
                break;
            case 'foreignKeysLoaded':
                handleForeignKeysLoaded(msg);
                break;
            case 'columnDefaultsLoaded':
                columnDefaults = msg.columnDefaults || [];
                break;
            case 'referencingTablesLoaded':
                handleReferencingTablesLoaded(msg);
                break;
            case 'customMappingsLoaded':
                handleCustomMappingsLoaded(msg);
                break;
            case 'cellEditorValue':
                handleCellEditorValue(msg);
                break;
            case 'savedQueriesLoaded':
                handleSavedQueriesLoaded(msg);
                break;
            case 'savedQuerySaved':
                handleSavedQuerySaved(msg);
                break;
            case 'tablesForTypeahead':
                handleTablesForTypeahead(msg);
                break;
            case 'columnsForTypeahead':
                handleColumnsForTypeahead(msg);
                break;

            case 'queryHistoryUpdated':
                updateQueryHistoryDropdown(msg.history);
                break;
            case 'sqlPreview':
                showSqlDialog(msg.sql, msg.connectionName);
                break;
            case 'commitSuccess':
                handleCommitSuccess();
                break;
            case 'applyFilter':
                handleApplyFilter(msg);
                break;
            case 'exportDefaultsLoaded':
                applyExportDefaults(msg.defaults);
                break;
            case 'exportSuccess':
                changeCount.textContent = `Exported to ${msg.filePath}`;
                setTimeout(() => { updateChangeIndicator(); }, 3000);
                break;
            case 'exportLocationSelected':
                if (msg.path) {
                    document.getElementById('exportSaveLocation').value = msg.path;
                }
                break;
            case 'error':
                showError(msg.text);
                break;
            case 'validationResult':
                handleValidationResult(msg);
                break;
            case 'connectionChanged':
                currentConnection = msg.connectionName || '';
                updateConnectionDisplay();
                break;
        }
    });

    function handleInit(msg) {
        schema = msg.schema || '';
        table = msg.table || '';
        tableReference = msg.tableReference || '';
        alwaysQuote = Boolean(msg.alwaysQuote);
        permanentConstraints = Array.isArray(msg.permanentConstraints) ? msg.permanentConstraints : [];
        permanentSorts = Array.isArray(msg.permanentSorts) ? msg.permanentSorts : [];
        if (msg.thousandSeparator !== undefined) { thousandSeparator = msg.thousandSeparator; }
        if (typeof msg.duplicateRowResetDefaults === 'string') { duplicateResetMode = msg.duplicateRowResetDefaults; }
        if (typeof msg.connectionName === 'string') {
            currentConnection = msg.connectionName;
            updateConnectionDisplay();
        }

        tableName.textContent = msg.title || (table ? `${schema}.${table}` : 'Query result');
        savedQueryId = typeof msg.savedQueryId === 'string' ? msg.savedQueryId : '';
        savedQueryParameters = Array.isArray(msg.savedQueryParameters) ? msg.savedQueryParameters : [];
        savedQueryValues = msg.savedQueryValues && typeof msg.savedQueryValues === 'object' ? msg.savedQueryValues : {};
        savedQueryTemplate = msg.sql || '';
        updateQueryParamsButton();
        // Both entry points start by running a query: a table view simply starts
        // with the default query for that table.
        setQueryText(msg.sql || getDefaultQuery());
        applyCapabilities(caps);
        if (table) { metaLoading.classList.remove('hidden'); }
        if (msg.awaitParameters && savedQueryParameters.length) {
            // The template cannot run as-is: ask for the placeholder values and
            // let the dialog trigger the first query.
            openQueryParamsDialog(true);
        } else {
            runQuery();
        }
        vscode.postMessage({ command: 'getQueryHistory' });
        vscode.postMessage({ command: 'getSavedQueries' });
    }

    // The "Parameters…" button only makes sense while a parameterized template
    // is loaded in this panel.
    function updateQueryParamsButton() {
        if (!queryParamsBtn) return;
        queryParamsBtn.style.display = savedQueryParameters.length ? '' : 'none';
    }

    // Enable/disable the affordances that depend on what the current result
    // allows: editing needs rows that can be traced back to a table, while
    // inserting, deleting, constraints and mappings need a single source table.
    function applyCapabilities(next) {
        caps = normalizeCapabilities(next);
        const toggle = (btn, enabled) => {
            if (btn) { btn.style.display = enabled ? '' : 'none'; }
        };
        toggle(insertRowBtn, caps.canInsert);
        toggle(commitBtn, caps.canEdit || caps.canInsert || caps.canDelete);
        toggle(discardBtn, caps.canEdit || caps.canInsert || caps.canDelete);
        toggle(constraintsBtn, caps.canConstrain);
        // Relation metadata is only fetched for a single source table; without
        // one nothing will arrive and the indicator must not keep spinning.
        if (caps.table) {
            metaLoading.classList.remove('hidden');
        } else {
            metaLoading.classList.add('hidden');
        }
    }

    // True when a specific result column can be written back to its table.
    function isColumnEditable(colName) {
        return caps.canEdit && caps.editableColumns.indexOf(colName) !== -1;
    }

    function handleColumnsLoaded(msg) {
        // Columns arrive before the (possibly slow) row query finishes. Render
        // the header right away so the grid structure and the "Constraints"
        // editor become usable while data is still loading.
        const wasDefaultQuery = isDefaultQueryText(queryInput.value);
        columns = msg.columns || [];
        applyCapabilities(msg.capabilities);
        adoptSourceTable(msg);
        renderHeader();
        // Now that the columns are known, refresh an untouched default query so
        // it lists all columns explicitly instead of the `*` placeholder.
        if (wasDefaultQuery) {
            setQueryText(getDefaultQuery());
        }
    }

    // Take over the table a result originates from, so table-bound features
    // (default query, constraints, mappings) work for ad-hoc queries too.
    function adoptSourceTable(msg) {
        if (!msg.table) { return; }
        schema = msg.schema || '';
        table = msg.table;
        tableReference = msg.tableReference || '';
        if (msg.alwaysQuote !== undefined) { alwaysQuote = Boolean(msg.alwaysQuote); }
        if (Array.isArray(msg.permanentConstraints)) { permanentConstraints = msg.permanentConstraints; }
        if (Array.isArray(msg.permanentSorts)) { permanentSorts = msg.permanentSorts; }
    }

    function handleRowsLoaded(msg) {
        const incoming = msg.rows || [];
        const isAppend = !!msg.append;
        appendPending = false;
        if (isFreshRowLoad(currentOffset, isAppend)) {
            allRows = incoming;
            // A fresh load replaces the row set entirely; any pending edits
            // refer to the previous rows and must not leak onto the newly loaded
            // ones (which share the same 0-based indices).
            resetPendingChanges();
        } else {
            allRows = allRows.concat(incoming);
        }
        columns = msg.columns || columns;
        if (!isAppend) {
            applyCapabilities(msg.capabilities);
            adoptSourceTable(msg);
            // Without an explicit count the total is unknown until requested.
            totalCount = null;
        }
        if (typeof msg.connectionName === 'string') {
            lastUsedConnection = msg.connectionName;
            if (!currentConnection) { currentConnection = msg.connectionName; }
            updateConnectionDisplay();
        }

        if (table) {
            tableName.textContent = `${schema}.${table}`;
        }
        // A full last batch means there may be more rows to page through.
        moreAvailable = !userPaged && !allLoaded && incoming.length >= PAGE_SIZE;
        lastQueryDurationMs = (typeof msg.durationMs === 'number') ? msg.durationMs : null;
        setDataLoading(false);
        updateRowCount();
        renderTable();
    }

    let fkLoaded = false;
    let refsLoaded = false;

    function handlePrimaryKeysLoaded(msg) {
        primaryKeys = msg.primaryKeys || [];
    }

    function handleForeignKeysLoaded(msg) {
        foreignKeys = msg.foreignKeys || [];
        fkLoaded = true;
        checkMetaComplete();
        renderBody();
    }

    function handleReferencingTablesLoaded(msg) {
        referencingTables = msg.referencingTables || [];
        refsLoaded = true;
        checkMetaComplete();
        renderBody();
    }

    function handleCustomMappingsLoaded(msg) {
        customMappings = msg.mappings || [];
        renderBody();
    }

    function checkMetaComplete() {
        if (fkLoaded && refsLoaded) {
            metaLoading.classList.add('hidden');
        }
    }

    function updateQueryHistoryDropdown(history) {
        queryHistoryEntries = Array.isArray(history) ? history.slice() : [];
        if (queryHistoryPanel.style.display !== 'none') {
            renderQueryHistoryList();
        }
    }

    function toggleQueryHistoryPanel() {
        if (queryHistoryPanel.style.display === 'none') {
            openQueryHistoryPanel();
        } else {
            closeQueryHistoryPanel();
        }
    }

    function openQueryHistoryPanel() {
        queryHistorySearch.value = '';
        queryHistoryActiveIdx = -1;
        renderQueryHistoryList();
        queryHistoryPanel.style.display = 'flex';
        // Focus search input after layout
        setTimeout(() => queryHistorySearch.focus(), 0);
    }

    function closeQueryHistoryPanel() {
        queryHistoryPanel.style.display = 'none';
    }

    function renderQueryHistoryList() {
        const term = queryHistorySearch.value.trim().toLowerCase();
        const filtered = term
            ? queryHistoryEntries.filter(e => e.sql.toLowerCase().includes(term))
            : queryHistoryEntries;

        if (!filtered.length) {
            queryHistoryList.innerHTML = '';
            queryHistoryEmpty.style.display = 'block';
            queryHistoryEmpty.textContent = queryHistoryEntries.length === 0
                ? 'No history yet'
                : 'No matching history';
            return;
        }
        queryHistoryEmpty.style.display = 'none';

        let html = '';
        filtered.forEach(entry => {
            html += `<li data-sql="${escapeAttr(entry.sql)}" title="${escapeAttr(entry.sql)}">${highlightMatch(entry.sql, term)}</li>`;
        });
        queryHistoryList.innerHTML = html;

        queryHistoryList.querySelectorAll('li').forEach(li => {
            li.addEventListener('click', () => {
                selectQueryHistoryItem(li.getAttribute('data-sql'));
            });
            li.addEventListener('mouseenter', () => {
                const items = Array.from(queryHistoryList.querySelectorAll('li'));
                queryHistoryActiveIdx = items.indexOf(li);
                highlightActiveHistoryItem(items);
            });
        });
    }

    function highlightMatch(text, term) {
        if (!term) return escapeHtml(text);
        const lower = text.toLowerCase();
        let out = '';
        let i = 0;
        while (i < text.length) {
            const idx = lower.indexOf(term, i);
            if (idx === -1) {
                out += escapeHtml(text.substring(i));
                break;
            }
            out += escapeHtml(text.substring(i, idx));
            out += '<mark>' + escapeHtml(text.substring(idx, idx + term.length)) + '</mark>';
            i = idx + term.length;
        }
        return out;
    }

    function highlightActiveHistoryItem(items) {
        items.forEach((li, i) => {
            li.classList.toggle('active', i === queryHistoryActiveIdx);
        });
        if (queryHistoryActiveIdx >= 0 && items[queryHistoryActiveIdx]) {
            items[queryHistoryActiveIdx].scrollIntoView({ block: 'nearest' });
        }
    }

    function selectQueryHistoryItem(sql) {
        if (sql == null) return;
        setQueryText(sql);
        closeQueryHistoryPanel();
        queryInput.focus();
    }

    // Run the query currently shown in the query bar. This is the single data
    // path of the viewer: the default table view is just the query the panel
    // was opened with.
    function runQuery() {
        const raw = queryInput.value.trim();
        if (!raw) return;
        // Save to history (raw, user-entered form)
        vscode.postMessage({ command: 'saveQueryHistory', sql: raw });
        const stripped = stripTrailingLimitOffset(raw);
        currentSql = stripped.base;
        userPaged = stripped.hadLimit;
        currentOffset = 0;
        appendPending = false;
        allLoaded = false;
        moreAvailable = false;
        const sql = userPaged ? raw : (currentSql + ' LIMIT ' + PAGE_SIZE + ' OFFSET 0');
        setDataLoading(true);
        // An exact row count is cheap and expected for the plain table view, but
        // can be very expensive for an arbitrary query — there it is only
        // counted when the user asks for it.
        vscode.postMessage({
            command: 'loadRows',
            sql,
            baseSql: currentSql,
            append: false,
            wantTotal: !userPaged && isDefaultQueryText(raw)
        });
    }

    // True when the query bar still shows the untouched default query of the
    // current table.
    function isDefaultQueryText(sql) {
        if (!table) return false;
        return collapseSqlWhitespace(String(sql || '')).trim().toLowerCase()
            === collapseSqlWhitespace(getDefaultQuery()).trim().toLowerCase();
    }

    function handleApplyFilter(msg) {
        // When opening a related table via FK/PK/custom mapping, only prefilter via
        // the SELECT clause and leave the column filter row empty.
        applyExactMatchToQuery(msg.column, msg.value, msg.conditions);
    }

    function applyExactMatchToQuery(colName, value, extraConditions) {
        if (!canApplyQueryFilters(queryInput.value)) return;
        if (value === null || value === undefined) return;
        const colMeta = columns.find(c => c.name === colName);
        const filterType = colMeta ? getColumnFilterType(colMeta.dataType) : 'text';
        const fmtCol = formatIdentifier(colName);
        const formatted = formatExactMatchValue(String(value), filterType, thousandSeparator);
        const clausesByCol = { [colName]: `${fmtCol} = ${formatted}` };
        // Append any custom-mapping conditions (e.g. from a reverse mapping) so
        // the navigation target is filtered by the full mapping definition.
        (extraConditions || []).forEach(cond => {
            if (!cond || !cond.column || cond.column === colName) return;
            const clause = buildMappingConditionClause(cond);
            if (clause) clausesByCol[cond.column] = clause;
        });
        mergeWhereClausesIntoQuery(clausesByCol);
        runQuery();
    }

    function buildMappingConditionClause(cond) {
        if (!cond || !cond.column) return '';
        const fmtCol = formatIdentifier(cond.column);
        const colMeta = columns.find(c => c.name === cond.column);
        const filterType = colMeta ? getColumnFilterType(colMeta.dataType) : 'text';
        return mappingConditionToClause(cond, fmtCol, filterType, thousandSeparator);
    }

    function applyNullConstraint(colName, isNull) {
        const fmtCol = formatIdentifier(colName);
        const clause = buildNullConstraintClause(fmtCol, isNull);
        mergeWhereClausesIntoQuery({ [colName]: clause });
        runQuery();
    }

    function mergeWhereClausesIntoQuery(clausesByCol) {
        const baseSql = (queryInput.value || '').trim() || `SELECT * FROM ${getDefaultTableReference()}`;
        const parsed = parseSqlForWhere(baseSql);
        const existing = mergeWhereClauses(parsed.where ? splitWhereByAnd(parsed.where) : [], clausesByCol);
        let sql = parsed.base;
        if (existing.length > 0) sql += ` WHERE ${existing.join(' AND ')}`;
        if (parsed.orderBy) sql += ` ORDER BY ${parsed.orderBy}`;
        setQueryText(sql);
    }

    function updateRowCount() {
        const showing = allRows.length + insertedRows.length + duplicatedRows.length;
        const time = formatExecutionTime(lastQueryDurationMs);
        const known = typeof totalCount === 'number';
        rowCount.textContent = describeRowCount(showing, totalCount, moreAvailable) + (time ? ` · ${time}` : '');
        rowCount.classList.toggle('clickable', !known);
        rowCount.title = known ? '' : 'Click to count all rows of this query';
        const noMore = known ? remainingRowCount(allRows.length, totalCount) === 0 : !moreAvailable;
        loadMoreBtn.disabled = noMore;
        loadAllBtn.disabled = noMore;
    }

    function getColumnFilterType(dataType) {
        if (!dataType) return 'text';
        const dt = dataType.toLowerCase();
        if (dt.includes('timestamp') || dt === 'date') return 'date';
        if (dt.includes('int') || dt === 'numeric' || dt === 'decimal' ||
            dt === 'real' || dt === 'double precision' || dt === 'smallint' ||
            dt === 'bigint' || dt.includes('float') || dt === 'money') return 'numeric';
        return 'text';
    }

    function getInputTypeForColumn(col) {
        const filterType = getColumnFilterType(col.dataType);
        if (filterType === 'date') {
            const dt = col.dataType.toLowerCase();
            if (dt.includes('timestamp')) return 'datetime-local';
            return 'date';
        }
        if (filterType === 'numeric') return 'text';
        return 'text';
    }

    function getMaxFormattedWidth(colName) {
        let maxLen = 5; // minimum width in characters
        for (const row of allRows) {
            const val = row[colName];
            if (val === null || val === undefined) continue;
            const formatted = formatNumberDisplay(val, thousandSeparator);
            if (formatted && formatted.length > maxLen) {
                maxLen = formatted.length;
            }
        }
        return maxLen;
    }

    function getFilterOperator(col) {
        return filterOperatorForMode(filterModes[col] || 'equals');
    }

    function renderTable() {
        renderHeader();
        renderBody();
        updateChangeIndicator();
    }

    // Wire up drag-and-drop reordering for a header cell. Dragging a column
    // header onto another column moves it to that position; the change is
    // reflected both in the grid and in the SELECT column order in the query
    // bar (for the standard table view).
    function attachColumnDragHandlers(th) {
        th.addEventListener('dragstart', (e) => {
            dragSourceCol = th.getAttribute('data-col');
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'move';
                // Firefox requires some data to be set for the drag to start.
                try { e.dataTransfer.setData('text/plain', dragSourceCol); } catch (_) { /* ignore */ }
            }
            th.classList.add('col-dragging');
        });
        th.addEventListener('dragover', (e) => {
            if (dragSourceCol === null) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
            if (th.getAttribute('data-col') !== dragSourceCol) {
                th.classList.add('col-drop-target');
            }
        });
        th.addEventListener('dragleave', () => {
            th.classList.remove('col-drop-target');
        });
        th.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            th.classList.remove('col-drop-target');
            moveColumn(dragSourceCol, th.getAttribute('data-col'));
            dragSourceCol = null;
        });
        th.addEventListener('dragend', () => {
            dragSourceCol = null;
            tableHead.querySelectorAll('.col-dragging, .col-drop-target').forEach(el => {
                el.classList.remove('col-dragging', 'col-drop-target');
            });
        });
    }

    // Move column `fromCol` in front of / onto `toCol`, update the grid and
    // reflect the new order in the query bar. The SELECT column expressions in
    // the current query text are reordered in place, so manual edits (aliases,
    // removed columns, custom WHERE/ORDER BY, a run custom query) are preserved.
    // Only when the current text cannot be reordered by column index (e.g. a
    // `SELECT *` fallback) does the standard table view regenerate its default
    // query.
    function moveColumn(fromCol, toCol) {
        if (!fromCol || !toCol || fromCol === toCol) return;
        const fromIndex = columns.findIndex(c => c.name === fromCol);
        const toIndex = columns.findIndex(c => c.name === toCol);
        if (fromIndex < 0 || toIndex < 0) return;
        columns = reorderColumns(columns, fromIndex, toIndex);
        renderTable();
        const reordered = reorderSelectColumns((queryInput.value || '').trim(), fromIndex, toIndex);
        if (reordered) {
            setQueryText(reordered);
        } else if (table) {
            setQueryText(getDefaultQuery());
        }
    }

    function renderHeader() {
        let html = '<tr>';
        html += '<th class="row-num-cell">#</th>';
        html += '<th class="actions-cell">Actions</th>';
        columns.forEach(col => {
            let cls = '';
            if (sortState.column === col.name) {
                cls = sortState.direction === 'asc' ? 'sorted-asc' : 'sorted-desc';
            }
            cls += ` col-${columnWriteMode(caps, col.name)}`;
            const commentTitle = buildColumnHeaderTitle(col);
            const titleAttr = commentTitle ? ` title="${escapeAttr(commentTitle)}"` : '';
            const commentMark = commentTitle ? ' <span class="col-comment-indicator" aria-hidden="true">🛈</span>' : '';
            html += `<th class="${cls}" draggable="true" data-col="${escapeAttr(col.name)}"${titleAttr}>${escapeHtml(col.name)}${commentMark}<br><small class="col-type">${escapeHtml(formatColumnTypeLabel(col))}</small><div class="col-resize-handle" title="Drag to change column width"></div></th>`;
        });
        html += '</tr>';

        html += '<tr class="filter-row">';
        html += '<th class="row-num-cell"></th>';
        html += '<th class="actions-cell"></th>';
        columns.forEach(col => {
            const filterType = getColumnFilterType(col.dataType);
            const inputType = getInputTypeForColumn(col);
            const mode = filterModes[col.name] || (filterType === 'text' ? 'contains' : 'equals');
            const val = filters[col.name] || '';

            html += `<th data-col="${escapeAttr(col.name)}"><div class="filter-cell">`;

            if (filterType === 'date' || filterType === 'numeric') {
                html += `<select class="filter-mode-select" data-col="${escapeAttr(col.name)}">`;
                html += `<option value="equals"${mode === 'equals' ? ' selected' : ''}>=</option>`;
                html += `<option value="not_equals"${mode === 'not_equals' ? ' selected' : ''}>!=</option>`;
                html += `<option value="gt"${mode === 'gt' ? ' selected' : ''}>&gt;</option>`;
                html += `<option value="gte"${mode === 'gte' ? ' selected' : ''}>&gt;=</option>`;
                html += `<option value="lt"${mode === 'lt' ? ' selected' : ''}>&lt;</option>`;
                html += `<option value="lte"${mode === 'lte' ? ' selected' : ''}>&lt;=</option>`;
                html += `<option value="between"${mode === 'between' ? ' selected' : ''}>Between</option>`;
                html += `</select>`;

                const numWidthStyle = (filterType === 'numeric') ? ` style="--col-w:${getMaxFormattedWidth(col.name) + 2}ch"` : '';

                if (mode === 'between') {
                    const rangeVal = (typeof val === 'object' && val !== null) ? val : { from: '', to: '' };
                    const langAttr = (filterType === 'date') ? ' lang="en-GB"' : '';
                    const fromDisplay = (filterType === 'numeric' && rangeVal.from) ? escapeAttr(formatNumberDisplay(rangeVal.from, thousandSeparator) || rangeVal.from) : escapeAttr(rangeVal.from || '');
                    const toDisplay = (filterType === 'numeric' && rangeVal.to) ? escapeAttr(formatNumberDisplay(rangeVal.to, thousandSeparator) || rangeVal.to) : escapeAttr(rangeVal.to || '');
                    html += `<input class="filter-input filter-input-range" type="${inputType}"${langAttr} data-col="${escapeAttr(col.name)}" data-range="from" placeholder="From" value="${fromDisplay}"${numWidthStyle}${inputType === 'number' ? ' step="any"' : ''}>`;
                    html += `<input class="filter-input filter-input-range" type="${inputType}"${langAttr} data-col="${escapeAttr(col.name)}" data-range="to" placeholder="To" value="${toDisplay}"${numWidthStyle}${inputType === 'number' ? ' step="any"' : ''}>`;
                } else {
                    const singleVal = (typeof val === 'string') ? val : '';
                    const langAttr = (filterType === 'date') ? ' lang="en-GB"' : '';
                    const displayVal = (filterType === 'numeric' && singleVal) ? escapeAttr(formatNumberDisplay(singleVal, thousandSeparator) || singleVal) : escapeAttr(singleVal);
                    html += `<input class="filter-input" type="${inputType}"${langAttr} data-col="${escapeAttr(col.name)}" placeholder="Filter..." value="${displayVal}"${numWidthStyle}${inputType === 'number' ? ' step="any"' : ''}>`;
                }
            } else {
                // Text filter (ILIKE)
                const singleVal = (typeof val === 'string') ? val : '';
                html += `<input class="filter-input" type="text" data-col="${escapeAttr(col.name)}" placeholder="Filter..." value="${escapeAttr(singleVal)}">`;
            }

            html += '</div></th>';
        });
        html += '</tr>';

        tableHead.innerHTML = html;
        updateStickyFilterOffset();

        tableHead.querySelectorAll('tr:first-child th[data-col]').forEach(th => {
            th.addEventListener('click', () => {
                if (Date.now() - colResizeEndedAt < 200) return;
                sortState = nextSortState(sortState, th.getAttribute('data-col'));
                renderTable();
            });
            th.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                showHeaderContextMenu(e, th.getAttribute('data-col'));
            });
            const resizeHandle = th.querySelector('.col-resize-handle');
            if (resizeHandle) {
                resizeHandle.addEventListener('mousedown', startColumnResize);
            }
            attachColumnDragHandlers(th);
        });

        tableHead.querySelectorAll('.filter-input').forEach(input => {
            const col = input.getAttribute('data-col');
            const colMeta = columns.find(c => c.name === col);
            const filterType = colMeta ? getColumnFilterType(colMeta.dataType) : 'text';

            input.addEventListener('input', (e) => {
                const range = e.target.getAttribute('data-range');
                delete exactFilters[col]; // Manual input = not exact

                // For numeric inputs: live-format with thousand separators
                if (filterType === 'numeric') {
                    const cursorPos = e.target.selectionStart;
                    const oldVal = e.target.value;
                    // Count digits (non-separator chars) before cursor
                    const digitsBefore = oldVal.substring(0, cursorPos).split(thousandSeparator).join('').length;
                    const result = liveFormatNumeric(oldVal, digitsBefore, thousandSeparator);
                    if (result) {
                        e.target.value = result.formatted;
                        e.target.setSelectionRange(result.newCursor, result.newCursor);
                    }
                    // Store the normalized (raw) value in filters
                    const normalized = result ? result.normalized : normalizeNumericInput(oldVal, thousandSeparator);
                    if (range) {
                        if (typeof filters[col] !== 'object' || filters[col] === null) {
                            filters[col] = { from: '', to: '' };
                        }
                        filters[col][range] = normalized;
                    } else {
                        filters[col] = normalized;
                    }
                } else {
                    if (range) {
                        // Between mode - store as object
                        if (typeof filters[col] !== 'object' || filters[col] === null) {
                            filters[col] = { from: '', to: '' };
                        }
                        filters[col][range] = e.target.value;
                    } else {
                        filters[col] = e.target.value;
                    }
                }
                renderBody();
            });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    applyFiltersToQuery();
                }
            });
        });

        tableHead.querySelectorAll('.filter-mode-select').forEach(select => {
            select.addEventListener('change', (e) => {
                const col = e.target.getAttribute('data-col');
                const oldMode = filterModes[col] || 'equals';
                const newMode = e.target.value;
                filterModes[col] = newMode;

                // Preserve value when switching between single-value modes
                if (newMode === 'between' && oldMode !== 'between') {
                    const oldVal = (typeof filters[col] === 'string') ? filters[col] : '';
                    filters[col] = { from: oldVal, to: '' };
                } else if (newMode !== 'between' && oldMode === 'between') {
                    const oldRange = (typeof filters[col] === 'object' && filters[col] !== null) ? filters[col] : { from: '' };
                    filters[col] = oldRange.from || '';
                }
                // Otherwise keep filters[col] as-is

                delete exactFilters[col];
                renderHeader();
            });
        });
    }

    // Pin the sticky filter row directly below the (variable-height, two-line)
    // column header row. The header height isn't fixed — it depends on the
    // column name/data-type text and wrapping — so measure the first header row
    // and expose its height as a CSS variable that the filter row's `top` uses.
    function updateStickyFilterOffset() {
        const headerRow = tableHead.querySelector('tr:first-child');
        if (!headerRow) return;
        const height = headerRow.getBoundingClientRect().height;
        if (height > 0) {
            tableHead.style.setProperty('--header-row-height', `${Math.round(height)}px`);
        }
        // The action column pins right behind the row numbers, whose width grows
        // with the highest row number on screen.
        const numCell = headerRow.querySelector('th.row-num-cell');
        const numWidth = numCell ? numCell.getBoundingClientRect().width : 0;
        if (numWidth > 0) {
            dataTable.style.setProperty('--row-num-width', `${Math.round(numWidth)}px`);
        }
        // The header can appear or rewrap while a load is still running.
        if (dataLoadingOverlay && dataLoadingOverlay.classList.contains('visible')) {
            setDataLoading(true);
        }
    }

    function applyFiltersToQuery() {
        if (!canApplyQueryFilters(queryInput.value)) return;

        const newClausesByCol = {};
        for (const col of columns) {
            const val = filters[col.name];
            if (val === undefined) continue; // never filtered -> leave the query as it is
            const filterType = getColumnFilterType(col.dataType);
            // An emptied filter box yields no clause, which removes the column
            // from the WHERE clause on merge.
            newClausesByCol[col.name] = val
                ? buildFilterClause(
                    formatIdentifier(col.name), val, filterType,
                    !!exactFilters[col.name], getFilterOperator(col.name), thousandSeparator
                )
                : '';
        }

        // Merge into the existing SQL, preserving user-written clauses.
        mergeWhereClausesIntoQuery(newClausesByCol);
        runQuery();
    }

    function showCellContextMenu(e, td) {
        const colName = td.getAttribute('data-col');
        const rowIdx = td.getAttribute('data-row');
        let cellValue = null;
        if (rowIdx !== null) {
            const idx = parseInt(rowIdx);
            const modKey = `${idx}:${colName}`;
            cellValue = modifiedCells.has(modKey) ? modifiedCells.get(modKey) : allRows[idx][colName];
        }

        const items = [];

        // 0a. Per-cell control over what a duplicated row leaves to the database
        const dupAttr = td.getAttribute('data-dup');
        if (dupAttr !== null) {
            const dIdx = parseInt(dupAttr);
            const entry = duplicatedRows[dIdx];
            if (entry) {
                const atDefault = !!entry.defaults && entry.defaults.has(colName);
                const sourceValue = entry.source ? entry.source[colName] : undefined;
                if (atDefault && sourceValue !== null && sourceValue !== undefined) {
                    items.push({
                        label: 'Copy Value From Source Row',
                        action: () => copyDuplicateValueFromSource(dIdx, colName)
                    });
                }
                if (!atDefault && columnDefaults.some(d => d.column === colName)) {
                    items.push({
                        label: 'Reset to Default',
                        action: () => resetDuplicateCellToDefault(dIdx, colName)
                    });
                }
                if (items.length > 0) {
                    items.push({ separator: true });
                }
            }
        }

        // 0. View full record (only for existing rows)
        if (rowIdx !== null) {
            items.push({
                label: 'View Full Record...',
                action: () => {
                    openRecordDialog(parseInt(rowIdx));
                }
            });
            items.push({
                label: 'Open Value in Editor',
                action: () => {
                    openCellInEditor(parseInt(rowIdx), colName);
                }
            });
            if (caps.canDelete && !deletedRows.has(parseInt(rowIdx))) {
                items.push({
                    label: 'Duplicate Row',
                    action: () => addDuplicateRow(parseInt(rowIdx), defaultResetColumns(columnDefaults, duplicateResetMode))
                });
                items.push({
                    label: 'Duplicate Row Exactly',
                    action: () => addDuplicateRow(parseInt(rowIdx), [])
                });
            }
            items.push({ separator: true });
        }

        // 1. Add as exact match
        if (cellValue !== null && cellValue !== undefined) {
            items.push({
                label: 'Add as Exact Match to Query',
                action: () => {
                    applyExactMatchToQuery(colName, String(cellValue));
                }
            });
        }

        // 2. Exclude from query
        if (cellValue !== null && cellValue !== undefined) {
            items.push({
                label: 'Exclude this Value from Query',
                action: () => {
                    if (!canApplyQueryFilters(queryInput.value)) return;
                    const escaped = escapeSqlString(cellValue);
                    const fmtCol = formatIdentifier(colName);
                    const colMeta = columns.find(c => c.name === colName);
                    const filterType = colMeta ? getColumnFilterType(colMeta.dataType) : 'text';
                    let excludeClause;
                    if (filterType === 'numeric') {
                        excludeClause = `${fmtCol} != ${escaped}`;
                    } else {
                        excludeClause = `${fmtCol} != '${escaped}'`;
                    }
                    const parsed = parseSqlForWhere(
                        queryInput.value.trim() || `SELECT * FROM ${getDefaultTableReference()}`
                    );
                    const clauses = parsed.where ? splitWhereByAnd(parsed.where) : [];
                    clauses.push(excludeClause);
                    let sql = parsed.base + ` WHERE ${clauses.join(' AND ')}`;
                    if (parsed.orderBy) sql += ` ORDER BY ${parsed.orderBy}`;
                    setQueryText(sql);
                    runQuery();
                }
            });
        }

        // 3. Open Primary Key (if this column is a FK)
        const fk = foreignKeys.find(f => f.column === colName);
        if (fk && cellValue !== null && cellValue !== undefined) {
            items.push({ separator: true });
            items.push({
                label: `Open Primary Key (${fk.refSchema}.${fk.refTable}.${fk.refColumn})`,
                action: () => {
                    vscode.postMessage({
                        command: 'openForeignKey',
                        refSchema: fk.refSchema,
                        refTable: fk.refTable,
                        refColumn: fk.refColumn,
                        value: String(cellValue)
                    });
                }
            });
        }

        // 4. Open Foreign Keys (tables referencing this column)
        const refs = referencingTables.filter(r => r.localColumn === colName);
        if (refs.length > 0 && cellValue !== null && cellValue !== undefined) {
            if (!fk) { items.push({ separator: true }); }
            refs.forEach(ref => {
                items.push({
                    label: `Open Foreign Key (${ref.fkSchema}.${ref.fkTable}.${ref.fkColumn})`,
                    action: () => {
                        vscode.postMessage({
                            command: 'openForeignKey',
                            refSchema: ref.fkSchema,
                            refTable: ref.fkTable,
                            refColumn: ref.fkColumn,
                            value: String(cellValue)
                        });
                    }
                });
            });
        }

        // 5. Custom column mappings
        const rowIdx2 = rowIdx !== null ? parseInt(rowIdx) : null;
        const rowData = rowIdx2 !== null ? allRows[rowIdx2] : {};
        const applicableMappings = customMappings.filter(m =>
            m.sourceColumn === colName && evaluateMappingConditions(m, rowData)
        );
        if (applicableMappings.length > 0 && cellValue !== null && cellValue !== undefined) {
            items.push({ separator: true });
            applicableMappings.forEach(mapping => {
                const baseLabel = mapping.label || `${mapping.targetSchema}.${mapping.targetTable}.${mapping.targetColumn}`;
                const label = mapping.reversed ? `${baseLabel} (reverse)` : baseLabel;
                items.push({
                    label: `Jump to ${label}`,
                    action: () => {
                        vscode.postMessage({
                            command: 'openForeignKey',
                            refSchema: mapping.targetSchema,
                            refTable: mapping.targetTable,
                            refColumn: mapping.targetColumn,
                            value: String(cellValue),
                            conditions: mapping.targetConditions || []
                        });
                    }
                });
            });
        }

        // 6. Create/Manage custom mapping
        if (canManageTableMetadata(schema, table, !caps.canMap)) {
            items.push({ separator: true });
            items.push({
                label: 'Create Custom Mapping...',
                action: () => {
                    openMappingDialog(colName);
                }
            });
            items.push({
                label: 'Manage Mappings...',
                action: () => {
                    openManageMappingsDialog();
                }
            });
        }

        if (items.length === 0) return;

        showContextMenu(e, items);
    }

    function showHeaderContextMenu(e, colName) {
        const fmtCol = formatIdentifier(colName);
        const currentSql = (queryInput.value || '').trim();
        const parsed = parseSqlForOrder(currentSql || `SELECT * FROM ${getDefaultTableReference()}`);
        const hasOrderBy = !!parsed.orderBy;
        const colInOrderBy = hasOrderBy && orderByContainsColumn(parsed.orderBy, colName);

        const items = [
            { label: `Order by ${colName} ASC (replace)`, action: () => applyOrderBy(colName, 'ASC', 'replace') },
            { label: `Order by ${colName} DESC (replace)`, action: () => applyOrderBy(colName, 'DESC', 'replace') },
            { separator: true },
            { label: `Add ${colName} ASC to ORDER BY`, action: () => applyOrderBy(colName, 'ASC', 'add') },
            { label: `Add ${colName} DESC to ORDER BY`, action: () => applyOrderBy(colName, 'DESC', 'add') },
        ];
        if (colInOrderBy) {
            items.push({ separator: true });
            items.push({ label: `Remove ${colName} from ORDER BY`, action: () => removeColumnFromOrderBy(colName) });
        }
        if (hasOrderBy) {
            if (!colInOrderBy) items.push({ separator: true });
            items.push({ label: 'Remove ORDER BY', action: clearOrderBy });
        }

        items.push({ separator: true });
        items.push({ label: `Add ${colName} IS NULL to WHERE`, action: () => applyNullConstraint(colName, true) });
        items.push({ label: `Add ${colName} IS NOT NULL to WHERE`, action: () => applyNullConstraint(colName, false) });

        showContextMenu(e, items);
    }

    function orderByMatchesColumn(part, colName) {
        if (!part) return false;
        const colPart = part.split(/\s+/)[0];
        const lower = colPart.toLowerCase();
        const fmtLower = formatIdentifier(colName).toLowerCase();
        return lower === fmtLower
            || lower === `"${colName.toLowerCase()}"`
            || lower === colName.toLowerCase();
    }

    function orderByContainsColumn(orderByClause, colName) {
        return orderByClause.split(',').map(p => p.trim()).some(p => orderByMatchesColumn(p, colName));
    }

    function removeColumnFromOrderBy(colName) {
        const baseSql = (queryInput.value || '').trim();
        if (!baseSql) return;
        const parsed = parseSqlForOrder(baseSql);
        if (!parsed.orderBy) return;
        const parts = parsed.orderBy
            .split(',')
            .map(p => p.trim())
            .filter(p => p && !orderByMatchesColumn(p, colName));
        setQueryText(parts.length > 0
            ? `${parsed.base} ORDER BY ${parts.join(', ')}`
            : parsed.base);
        runQuery();
    }

    function applyOrderBy(colName, direction, mode) {
        const fmtCol = formatIdentifier(colName);
        const baseSql = (queryInput.value || '').trim() || `SELECT * FROM ${getDefaultTableReference()}`;
        const parsed = parseSqlForOrder(baseSql);
        let newOrder;
        if (mode === 'replace' || !parsed.orderBy) {
            newOrder = `${fmtCol} ${direction}`;
        } else {
            // Drop any existing entry that targets the same column
            const parts = parsed.orderBy
                .split(',')
                .map(p => p.trim())
                .filter(p => p && !orderByMatchesColumn(p, colName));
            parts.push(`${fmtCol} ${direction}`);
            newOrder = parts.join(', ');
        }
        setQueryText(`${parsed.base} ORDER BY ${newOrder}`);
        runQuery();
    }

    function clearOrderBy() {
        const baseSql = (queryInput.value || '').trim();
        if (!baseSql) return;
        const parsed = parseSqlForOrder(baseSql);
        setQueryText(parsed.base);
        runQuery();
    }

    // A table with many foreign keys produces a menu nobody can scan, so from
    // this many entries on it gets a filter box.
    const CONTEXT_MENU_SEARCH_FROM = 10;

    function hideContextMenu() {
        contextMenu.style.display = 'none';
    }

    function filterContextMenu() {
        const needle = contextMenuSearch.value.trim().toLowerCase();
        let visible = 0;
        contextMenuItems.querySelectorAll('li').forEach(li => {
            // While filtering, a separator no longer separates anything.
            if (li.classList.contains('separator')) {
                li.classList.toggle('hidden', !!needle);
                return;
            }
            const match = !needle || li.textContent.toLowerCase().includes(needle);
            li.classList.toggle('hidden', !match);
            if (match) visible++;
        });
        contextMenuEmpty.classList.toggle('hidden', visible > 0);
    }

    function showContextMenu(e, items) {
        if (!items || items.length === 0) return;

        let html = '';
        items.forEach((item, i) => {
            if (item.separator) {
                html += '<li class="separator"></li>';
            } else {
                html += `<li data-action-idx="${i}">${escapeHtml(item.label)}</li>`;
            }
        });
        contextMenuItems.innerHTML = html;

        const searchable = items.filter(item => !item.separator).length >= CONTEXT_MENU_SEARCH_FROM;
        contextMenuSearch.value = '';
        contextMenuSearch.classList.toggle('hidden', !searchable);
        contextMenuEmpty.classList.add('hidden');

        // Show first (offscreen) to measure size, then clamp into viewport
        contextMenu.style.visibility = 'hidden';
        contextMenu.style.left = '0px';
        contextMenu.style.top = '0px';
        contextMenu.style.maxHeight = '';
        contextMenu.style.display = 'flex';

        const margin = 8;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const menuWidth = contextMenu.offsetWidth;

        // Decide whether to open above or below the cursor
        const spaceBelow = vh - e.clientY - margin;
        const spaceAbove = e.clientY - margin;
        const openUpwards = spaceBelow < 120 && spaceAbove > spaceBelow;
        const availableHeight = Math.max(80, openUpwards ? spaceAbove : spaceBelow);
        contextMenu.style.maxHeight = availableHeight + 'px';

        const menuHeight = contextMenu.offsetHeight;
        let left = e.clientX;
        let top = openUpwards ? e.clientY - menuHeight : e.clientY;
        if (left + menuWidth + margin > vw) left = Math.max(margin, vw - menuWidth - margin);
        if (top + menuHeight + margin > vh) top = Math.max(margin, vh - menuHeight - margin);
        if (top < margin) top = margin;
        if (left < margin) left = margin;

        contextMenu.style.left = left + 'px';
        contextMenu.style.top = top + 'px';
        contextMenu.style.visibility = '';
        if (searchable) { contextMenuSearch.focus(); }

        contextMenuItems.querySelectorAll('li[data-action-idx]').forEach(li => {
            li.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const idx = parseInt(li.getAttribute('data-action-idx'));
                hideContextMenu();
                if (items[idx] && items[idx].action) {
                    items[idx].action();
                }
            });
        });
    }

    function getFilteredAndSortedRows() {
        let rows = allRows.map((row, idx) => ({ ...row, _originalIndex: idx }));

        for (const [col, filterVal] of Object.entries(filters)) {
            if (!filterVal) continue;
            const colMeta = columns.find(c => c.name === col);
            const filterType = colMeta ? getColumnFilterType(colMeta.dataType) : 'text';
            const mode = filterModes[col];
            rows = rows.filter(row =>
                rowValueMatchesFilter(row[col], filterVal, filterType, mode, thousandSeparator)
            );
        }

        if (sortState.column) {
            rows.sort((a, b) => compareCellValues(a[sortState.column], b[sortState.column], sortState.direction));
        }

        return rows;
    }

    function renderBody() {
        displayedRows = getFilteredAndSortedRows();
        tableBody.innerHTML = buildTableHtml();
        wireTableListeners();
        updateChangeIndicator();
        // The row-number column widens with the digits of the last row.
        updateStickyFilterOffset();
        // The tbody was rebuilt, so any cell-range selection now points at stale
        // DOM; drop it to avoid copying the wrong cells.
        clearCellRangeSelection();
    }

    // Build the full <tbody> HTML for the current displayedRows plus any
    // inserted/duplicated rows, interleaving them next to their anchor rows.
    function buildTableHtml() {
        let html = '';
        let rowNum = 0;

        // Build a render plan that interleaves inserted/duplicated rows
        // directly below the existing row they were anchored to. Inserts
        // with no anchor (selectedRowIdx was null) go at the very top;
        // inserts whose anchor row is no longer in the displayed set fall
        // back to the bottom so the user doesn't lose them.
        const insertsByAnchor = new Map();
        const topInserts = [];
        const orphanInserts = [];
        const displayedIdxSet = new Set(displayedRows.map(r => r._originalIndex));
        const placeWrapped = (entry, wrapped) => {
            if (entry.anchor == null) topInserts.push(wrapped);
            else if (displayedIdxSet.has(entry.anchor)) {
                if (!insertsByAnchor.has(entry.anchor)) insertsByAnchor.set(entry.anchor, []);
                insertsByAnchor.get(entry.anchor).push(wrapped);
            } else orphanInserts.push(wrapped);
        };
        insertedRows.forEach((entry, iIdx) => placeWrapped(entry, { kind: 'insert', iIdx }));
        duplicatedRows.forEach((entry, dIdx) => placeWrapped(entry, { kind: 'dup', dIdx }));

        function emitInsertRow(w) {
            rowNum++;
            if (w.kind === 'insert') {
                const row = insertedRows[w.iIdx].row;
                html += `<tr class="row-inserted" data-insert-index="${w.iIdx}">`;
                html += `<td class="row-num-cell">${rowNum}</td>`;
                html += `<td class="actions-cell"><button class="btn btn-danger btn-sm btn-icon" onclick="removeInsertedRow(${w.iIdx})" title="Remove this new row">${icon('close')}</button></td>`;
                columns.forEach(col => {
                    const val = row[col.name] || '';
                    const invalid = invalidCells.get(`ins:${w.iIdx}:${col.name}`);
                    html += `<td class="${invalid ? 'cell-invalid' : ''}" ${invalid ? `title="${escapeAttr(invalid)}"` : ''} contenteditable="true" data-insert="${w.iIdx}" data-col="${escapeAttr(col.name)}">${escapeHtml(val)}</td>`;
                });
                html += '</tr>';
            } else {
                const entry = duplicatedRows[w.dIdx];
                const row = entry.row;
                html += `<tr class="row-duplicated" data-dup-index="${w.dIdx}">`;
                html += `<td class="row-num-cell">${rowNum}</td>`;
                html += `<td class="actions-cell"><button class="btn btn-danger btn-sm btn-icon" onclick="removeDuplicatedRow(${w.dIdx})" title="Remove this duplicate">${icon('close')}</button></td>`;
                columns.forEach(col => {
                    const atDefault = !!entry.defaults && entry.defaults.has(col.name);
                    const val = row[col.name] !== null && row[col.name] !== undefined ? cellToString(row[col.name]) : '';
                    const invalid = invalidCells.get(`dup:${w.dIdx}:${col.name}`);
                    const content = atDefault ? defaultMarkerHtml(col.name) : escapeHtml(val);
                    html += `<td class="${invalid ? 'cell-invalid' : ''}" ${invalid ? `title="${escapeAttr(invalid)}"` : ''} contenteditable="true" data-dup="${w.dIdx}" data-col="${escapeAttr(col.name)}">${content}</td>`;
                });
                html += '</tr>';
            }
        }

        // Top inserts (above all existing rows)
        topInserts.forEach(emitInsertRow);

        // Existing rows, with anchored inserts emitted right after each row
        displayedRows.forEach(row => {
            const idx = row._originalIndex;
            const isDeleted = deletedRows.has(idx);
            const isModified = hasModifications(idx);
            const isSelected = selectedRowIdx === idx;
            let rowClass = '';
            if (isDeleted) rowClass = 'row-deleted';
            else if (isModified) rowClass = 'row-modified';
            if (isSelected) rowClass = (rowClass ? rowClass + ' ' : '') + 'row-selected';

            rowNum++;
            html += `<tr class="${rowClass}" data-row-index="${idx}">`;
            html += `<td class="row-num-cell">${rowNum}<div class="row-resize-handle" title="Drag to change row height"></div></td>`;
            html += `<td class="actions-cell">`;
            if (!caps.canDelete) {
                html += `<button class="btn-view-record" onclick="openRecordDialog(${idx})" title="View full record">&#128065;</button>`;
            } else if (!isDeleted) {
                html += `<button class="btn-view-record" onclick="openRecordDialog(${idx})" title="View full record">&#128065;</button>`;
                html += `<button class="btn btn-sm btn-icon" onclick="duplicateRow(${idx})" title="Duplicate row">${icon('copy')}</button>`;
                html += `<button class="btn btn-danger btn-sm btn-icon" onclick="deleteRow(${idx})" title="Delete row">${icon('trash')}</button>`;
            } else {
                html += `<button class="btn-view-record" onclick="openRecordDialog(${idx})" title="View full record">&#128065;</button>`;
                html += `<button class="btn btn-sm btn-icon" onclick="undeleteRow(${idx})" title="Restore row">${icon('undo')}</button>`;
            }
            html += `</td>`;

            columns.forEach(col => {
                const originalVal = allRows[idx][col.name];
                const modKey = `${idx}:${col.name}`;
                const currentVal = modifiedCells.has(modKey) ? modifiedCells.get(modKey) : originalVal;
                const isModifiedCell = modifiedCells.has(modKey);
                const invalidReason = invalidCells.get(modKey);
                const cellClass = `${isModifiedCell ? 'cell-modified' : ''}${invalidReason ? ' cell-invalid' : ''}`;
                const displayVal = currentVal === null ? '<span class="null-value">NULL</span>' : (
                    getColumnFilterType(col.dataType) === 'numeric'
                        ? escapeHtml(formatNumberDisplay(currentVal, thousandSeparator))
                        : escapeHtml(cellToString(currentVal))
                );

                const fk = foreignKeys.find(f => f.column === col.name);
                const defaultCustomMapping = customMappings.find(m => m.isDefault && m.sourceColumn === col.name && evaluateMappingConditions(m, allRows[idx]));
                let fkBtn = '';
                if (defaultCustomMapping && currentVal !== null && currentVal !== undefined) {
                    // Custom mapping overrides or supplements FK button
                    fkBtn = `<button class="fk-btn custom-fk-btn" data-ref-schema="${escapeAttr(defaultCustomMapping.targetSchema)}" data-ref-table="${escapeAttr(defaultCustomMapping.targetTable)}" data-ref-column="${escapeAttr(defaultCustomMapping.targetColumn)}" data-value="${escapeAttr(cellToString(currentVal))}" title="${escapeAttr(defaultCustomMapping.label || defaultCustomMapping.targetSchema + '.' + defaultCustomMapping.targetTable)}">&#8599;</button>`;
                } else if (fk && currentVal !== null && currentVal !== undefined) {
                    fkBtn = `<button class="fk-btn" data-ref-schema="${escapeAttr(fk.refSchema)}" data-ref-table="${escapeAttr(fk.refTable)}" data-ref-column="${escapeAttr(fk.refColumn)}" data-value="${escapeAttr(cellToString(currentVal))}" title="Open ${fk.refSchema}.${fk.refTable}">&#8599;</button>`;
                }
                const editableAttr = !isDeleted && isColumnEditable(col.name) ? 'true' : 'false';
                const cellExtraClass = fkBtn ? ' has-fk-btn' : '';
                html += `<td class="${cellClass}${cellExtraClass}" ${invalidReason ? `title="${escapeAttr(invalidReason)}"` : ''} data-row="${idx}" data-col="${escapeAttr(col.name)}" data-original="${escapeAttr(originalVal === null ? '__NULL__' : cellToString(originalVal))}"><span class="cell-content" contenteditable="${editableAttr}">${displayVal}</span>${fkBtn}</td>`;
            });
            html += '</tr>';

            // Emit any inserts/duplicates anchored to this row
            const anchored = insertsByAnchor.get(idx);
            if (anchored) anchored.forEach(emitInsertRow);
        });

        // Orphan inserts whose anchor row is filtered out
        orphanInserts.forEach(emitInsertRow);

        return html;
    }

    // Fill a counter element from a budget, or blank it out when the column has
    // no character limit.
    function applyCharBudget(el, budget) {        if (!el) return;
        el.textContent = budget ? budget.text : '';
        el.classList.toggle('is-warning', !!budget && budget.state === 'warning');
        el.classList.toggle('is-exceeded', !!budget && budget.state === 'exceeded');
    }

    // The cell the floating counter currently belongs to, so scrolling can move
    // it along instead of leaving it behind.
    let charBudgetTarget = null;

    function hideCharBudgetBadge() {
        charBudgetTarget = null;
        if (charBudgetBadge) charBudgetBadge.style.display = 'none';
    }

    // Show the remaining characters underneath the cell being edited.
    function showCharBudgetBadge(editable) {
        const td = editable ? editable.closest('td') : null;
        if (!charBudgetBadge || !td) return;
        const colMeta = columns.find(c => c.name === td.getAttribute('data-col'));
        const budget = colMeta
            ? describeCharacterBudget(editable.textContent, colMeta.fullType || colMeta.dataType)
            : null;
        if (!budget) {
            hideCharBudgetBadge();
            return;
        }
        charBudgetTarget = editable;
        applyCharBudget(charBudgetBadge, budget);
        charBudgetBadge.style.display = 'block';
        const cell = td.getBoundingClientRect();
        const badge = charBudgetBadge.getBoundingClientRect();
        const below = cell.bottom + 2;
        const top = below + badge.height > window.innerHeight ? cell.top - badge.height - 2 : below;
        charBudgetBadge.style.top = Math.max(0, top) + 'px';
        charBudgetBadge.style.left = Math.max(0, cell.right - badge.width) + 'px';
    }

    document.addEventListener('scroll', () => {
        if (charBudgetTarget) showCharBudgetBadge(charBudgetTarget);
    }, true);

    // Attach all event listeners for the freshly-rendered <tbody>.
    function wireTableListeners() {
        // Live formatting for numeric cells during editing.
        // `editable` is the contenteditable element (a .cell-content span for existing rows,
        // or the td itself for inserted/duplicated rows).
        function handleNumericCellInput(editable) {
            const td = editable.closest('td');
            if (!td) return;
            const colName = td.getAttribute('data-col');
            const colMeta = columns.find(c => c.name === colName);
            if (!colMeta || getColumnFilterType(colMeta.dataType) !== 'numeric') return;

            const text = editable.textContent;

            // Get cursor position as digit count
            const sel = window.getSelection();
            let digitsBefore = 0;
            if (sel && sel.rangeCount > 0) {
                const range = sel.getRangeAt(0);
                const beforeCursor = text.substring(0, range.startOffset);
                digitsBefore = beforeCursor.split(thousandSeparator).join('').length;
            }

            const result = liveFormatNumeric(text, digitsBefore, thousandSeparator);
            if (!result) return;

            editable.textContent = result.formatted;

            // Restore cursor position
            if (sel && editable.firstChild) {
                const newRange = document.createRange();
                newRange.setStart(editable.firstChild, Math.min(result.newCursor, result.formatted.length));
                newRange.collapse(true);
                sel.removeAllRanges();
                sel.addRange(newRange);
            }
        }

        // Clear the "NULL" placeholder when the user focuses a NULL cell so
        // they can immediately type a new value. Leaving the cell empty on
        // blur restores NULL via handleCellEdit (which converts '' -> null).
        function handleNullCellFocus(span) {
            if (span.querySelector('.null-value')) {
                span.textContent = '';
            }
        }

        // Attach focus/blur/input listeners for editable cell-content spans (existing rows)
        tableBody.querySelectorAll('td[data-row] .cell-content[contenteditable="true"]').forEach(span => {
            span.addEventListener('focus', () => { handleNullCellFocus(span); showCharBudgetBadge(span); });
            span.addEventListener('blur', (e) => { hideCharBudgetBadge(); handleCellEdit(e); });
            span.addEventListener('input', () => { handleNumericCellInput(span); showCharBudgetBadge(span); });
        });

        // Attach blur listeners for inserted rows
        tableBody.querySelectorAll('td[data-insert][contenteditable="true"]').forEach(td => {
            td.addEventListener('focus', () => showCharBudgetBadge(td));
            td.addEventListener('blur', (e) => { hideCharBudgetBadge(); handleInsertCellEdit(e); });
            td.addEventListener('input', () => { handleNumericCellInput(td); showCharBudgetBadge(td); });
        });

        // Attach blur listeners for duplicated rows
        tableBody.querySelectorAll('td[data-dup][contenteditable="true"]').forEach(td => {
            td.addEventListener('focus', () => { clearDefaultMarker(td); showCharBudgetBadge(td); });
            td.addEventListener('blur', (e) => { hideCharBudgetBadge(); handleDupCellEdit(e); });
            td.addEventListener('input', () => { handleNumericCellInput(td); showCharBudgetBadge(td); });
        });

        // Row-height resize handles (drag the bottom of the row-number cell).
        tableBody.querySelectorAll('.row-resize-handle').forEach(handle => {
            handle.addEventListener('mousedown', startRowResize);
        });

        tableBody.querySelectorAll('.fk-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const refSchema = btn.getAttribute('data-ref-schema');
                const refTable = btn.getAttribute('data-ref-table');
                const refColumn = btn.getAttribute('data-ref-column');
                const value = btn.getAttribute('data-value');
                vscode.postMessage({
                    command: 'openForeignKey',
                    refSchema, refTable, refColumn, value
                });
            });
        });

        tableBody.querySelectorAll('td[data-col]').forEach(td => {
            td.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                showCellContextMenu(e, td);
            });
        });

        // Row selection: clicking anywhere in an existing row marks it as
        // selected so that subsequent Insert Row / Duplicate Row place new
        // rows directly below it. Clicking on action buttons (which stop
        // propagation or trigger their own handler) still updates selection
        // because the click bubbles up before button work.
        tableBody.querySelectorAll('tr[data-row-index]').forEach(tr => {
            tr.addEventListener('click', (e) => {
                // Ignore clicks inside the FK button (it opens another view)
                if (e.target.closest('.fk-btn')) return;
                const idxStr = tr.getAttribute('data-row-index');
                const idx = parseInt(idxStr);
                if (selectedRowIdx === idx) return;
                // Update class on previously selected row without full
                // re-render to avoid clobbering an in-progress edit.
                tableBody.querySelectorAll('tr.row-selected').forEach(prev => prev.classList.remove('row-selected'));
                tr.classList.add('row-selected');
                selectedRowIdx = idx;
            });
        });
    }

    function handleCellEdit(e) {
        const span = e.target;
        const td = span.closest('td');
        if (!td) return;
        const rowIdx = parseInt(td.getAttribute('data-row'));
        const colName = td.getAttribute('data-col');
        const originalStr = td.getAttribute('data-original');
        const original = originalStr === '__NULL__' ? null : originalStr;

        const colMeta = columns.find(c => c.name === colName);
        const isNumeric = !!colMeta && getColumnFilterType(colMeta.dataType) === 'numeric';
        let newValue = normalizeCellInput(span.textContent, isNumeric, thousandSeparator);

        if (newValue === '' && original === null) {
            newValue = null;
        }

        const modKey = `${rowIdx}:${colName}`;

        if (newValue === original || (newValue === '' && original === null)) {
            modifiedCells.delete(modKey);
            td.classList.remove('cell-modified');
            setCellValidity(td, modKey, null);
        } else {
            modifiedCells.set(modKey, newValue === '' ? null : newValue);
            td.classList.add('cell-modified');
            checkCellValue(td, modKey, newValue === '' ? null : newValue);
        }

        // Re-format display for numeric columns
        if (isNumeric) {
            const displayValue = modifiedCells.has(modKey) ? modifiedCells.get(modKey) : (original === null ? null : original);
            if (displayValue !== null) {
                span.textContent = formatNumberDisplay(displayValue, thousandSeparator);
            }
        }

        // Restore the NULL placeholder when the cell ends up null (either
        // because the user cleared a NULL cell without typing anything, or
        // because they emptied a previously non-null cell -> we treat empty
        // as NULL on commit, so the display should reflect that).
        const finalValue = modifiedCells.has(modKey) ? modifiedCells.get(modKey) : original;
        if (finalValue === null) {
            span.innerHTML = '<span class="null-value">NULL</span>';
        }

        updateChangeIndicator();
    }

    // Shared handler for editable cells in inserted/duplicated rows. `rows` is
    // the backing array and `idxAttr` the data attribute holding its index.
    function applyDataRowCellEdit(e, rows, idxAttr) {
        const td = e.target;
        const idx = parseInt(td.getAttribute(idxAttr));
        const colName = td.getAttribute('data-col');
        const colMeta = columns.find(c => c.name === colName);
        const isNumeric = !!colMeta && getColumnFilterType(colMeta.dataType) === 'numeric';
        const value = normalizeCellInput(td.textContent, isNumeric, thousandSeparator);
        rows[idx].row[colName] = value;
        const defaults = rows[idx].defaults;
        if (defaults) {
            // An emptied cell is left to the database, so say so instead of
            // showing a blank that behaves like a default anyway.
            if (value === null && hasResettableDefault(colName)) {
                defaults.add(colName);
                td.innerHTML = defaultMarkerHtml(colName);
            } else {
                defaults.delete(colName);
            }
        }
        checkCellValue(td, `${idxAttr === 'data-insert' ? 'ins' : 'dup'}:${idx}:${colName}`, value);
        updateChangeIndicator();
    }

    function handleInsertCellEdit(e) {
        applyDataRowCellEdit(e, insertedRows, 'data-insert');
    }

    function handleDupCellEdit(e) {
        applyDataRowCellEdit(e, duplicatedRows, 'data-dup');
    }

    // Markup of a duplicated cell the database will fill in on save.
    function defaultMarkerHtml(colName) {
        const info = columnDefaults.find(d => d.column === colName);
        return `<span class="default-value" title="${escapeAttr(defaultCellTitle(info))}">DEFAULT</span>`;
    }

    // Typing into a cell replaces the marker, so remove it as soon as the cell
    // is focused.
    function clearDefaultMarker(td) {
        if (td.querySelector('.default-value')) {
            td.textContent = '';
        }
    }

    // Whether a column is one the database refills when the INSERT omits it.
    function hasResettableDefault(colName) {
        return defaultResetColumns(columnDefaults, duplicateResetMode).indexOf(colName) !== -1;
    }

    // Undo a reset for a single cell: take the source row's value after all.
    function copyDuplicateValueFromSource(dIdx, colName) {
        const entry = duplicatedRows[dIdx];
        if (!entry) return;
        entry.row[colName] = entry.source ? entry.source[colName] : null;
        if (entry.defaults) entry.defaults.delete(colName);
        renderBody();
        updateChangeIndicator();
    }

    // Leave a single cell of a duplicate to the database.
    function resetDuplicateCellToDefault(dIdx, colName) {
        const entry = duplicatedRows[dIdx];
        if (!entry) return;
        entry.row[colName] = null;
        if (!entry.defaults) entry.defaults = new Set();
        entry.defaults.add(colName);
        invalidCells.delete(`dup:${dIdx}:${colName}`);
        renderBody();
        updateChangeIndicator();
    }

    // Pending database checks, keyed by request id, so a late answer for a cell
    // that has been edited again in the meantime can be discarded.
    let validationSeq = 0;
    const pendingValidations = new Map();

    // Check an edited value against its column type and mark the cell when the
    // column cannot store it. Types whose text format only Postgres can judge
    // (timestamps, JSON, enums, ...) are sent to the database for a cast test.
    function checkCellValue(td, key, value) {
        const colMeta = columns.find(c => c.name === td.getAttribute('data-col'));
        const result = colMeta ? validateCellValue(value, colMeta.fullType || colMeta.dataType) : { state: 'valid' };
        if (result.state === 'unknown') {
            const requestId = ++validationSeq;
            pendingValidations.set(requestId, { key, value });
            vscode.postMessage({ command: 'validateValue', requestId, column: colMeta.name, value });
            return;
        }
        setCellValidity(td, key, result.state === 'invalid' ? result.reason : null);
    }

    function setCellValidity(td, key, reason) {
        if (reason) {
            invalidCells.set(key, reason);
        } else {
            invalidCells.delete(key);
        }
        if (td) {
            td.classList.toggle('cell-invalid', !!reason);
            if (reason) td.setAttribute('title', reason);
            else td.removeAttribute('title');
        }
        updateChangeIndicator();
    }

    function handleValidationResult(msg) {
        const pending = pendingValidations.get(msg.requestId);
        pendingValidations.delete(msg.requestId);
        if (!pending || currentCellValue(pending.key) !== pending.value) {
            return; // the cell was edited again; a newer check is on its way
        }
        setCellValidity(findCellByKey(pending.key), pending.key, msg.valid ? null : (msg.reason || 'Invalid value'));
    }

    // The value a cell key currently holds, or undefined when the edit was
    // reverted or the row is gone.
    function currentCellValue(key) {
        const parts = key.split(':');
        if (parts[0] === 'ins' || parts[0] === 'dup') {
            const rows = parts[0] === 'ins' ? insertedRows : duplicatedRows;
            const entry = rows[parseInt(parts[1])];
            return entry ? entry.row[parts.slice(2).join(':')] : undefined;
        }
        return modifiedCells.has(key) ? modifiedCells.get(key) : undefined;
    }

    function findCellByKey(key) {
        const parts = key.split(':');
        const colName = parts[0] === 'ins' || parts[0] === 'dup' ? parts.slice(2).join(':') : parts.slice(1).join(':');
        const rowSelector = parts[0] === 'ins' ? `[data-insert="${parts[1]}"]`
            : parts[0] === 'dup' ? `[data-dup="${parts[1]}"]`
            : `[data-row="${parts[0]}"]`;
        return tableBody.querySelector(`td${rowSelector}[data-col="${cssEscape(colName)}"]`);
    }

    function cssEscape(value) {
        return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : String(value).replace(/"/g, '\\"');
    }

    // Keep the invalid-cell keys of inserted/duplicated rows aligned after one
    // of those rows was removed from its backing array.
    function reindexInvalidRowKeys(prefix, removedIdx) {
        const next = new Map();
        for (const [key, reason] of invalidCells.entries()) {
            const parts = key.split(':');
            if (parts[0] !== prefix) { next.set(key, reason); continue; }
            const idx = parseInt(parts[1]);
            if (idx === removedIdx) { continue; }
            const shifted = idx > removedIdx ? idx - 1 : idx;
            next.set(`${prefix}:${shifted}:${parts.slice(2).join(':')}`, reason);
        }
        invalidCells = next;
    }

    function hasModifications(rowIdx) {
        for (const key of modifiedCells.keys()) {
            if (key.startsWith(`${rowIdx}:`)) return true;
        }
        return false;
    }

    // Global functions for inline handlers
    window.deleteRow = function(idx) {
        deletedRows.add(idx);
        renderBody();
    };

    window.undeleteRow = function(idx) {
        deletedRows.delete(idx);
        renderBody();
    };

    window.duplicateRow = function(idx) {
        addDuplicateRow(idx, defaultResetColumns(columnDefaults, duplicateResetMode));
    };

    // Duplicate without letting the database refill anything.
    window.duplicateRowExactly = function(idx) {
        addDuplicateRow(idx, []);
    };

    function addDuplicateRow(idx, resetColumns) {
        const rowData = {};
        const source = {};
        columns.forEach(col => {
            const modKey = `${idx}:${col.name}`;
            const value = modifiedCells.has(modKey) ? modifiedCells.get(modKey) : allRows[idx][col.name];
            rowData[col.name] = value;
            source[col.name] = value;
        });
        const defaults = new Set(resetColumns.filter(name => columns.some(col => col.name === name)));
        defaults.forEach(name => { rowData[name] = null; });
        // Anchor the duplicate directly below the source row.
        duplicatedRows.push({ row: rowData, anchor: idx, defaults, source });
        selectedRowIdx = idx;
        renderBody();
        updateRowCount();
    }

    window.removeInsertedRow = function(idx) {
        insertedRows.splice(idx, 1);
        reindexInvalidRowKeys('ins', idx);
        renderBody();
        updateRowCount();
    };

    window.removeDuplicatedRow = function(idx) {
        duplicatedRows.splice(idx, 1);
        reindexInvalidRowKeys('dup', idx);
        renderBody();
        updateRowCount();
    };

    function insertRow() {
        const newRow = {};
        columns.forEach(col => { newRow[col.name] = ''; });
        // Anchor below the currently selected row, or at the top if none.
        const anchor = (selectedRowIdx != null && allRows[selectedRowIdx]) ? selectedRowIdx : null;
        insertedRows.push({ row: newRow, anchor: anchor });
        renderBody();
        updateRowCount();

        const selector = anchor == null
            ? 'tr.row-inserted'
            : `tr.row-inserted[data-insert-index="${insertedRows.length - 1}"]`;
        const newTr = tableBody.querySelector(selector);
        if (newTr && newTr.scrollIntoView) {
            newTr.scrollIntoView({ block: 'nearest', behavior: 'auto' });
        }
    }

    function loadMore() {
        if (userPaged || !currentSql) return;
        currentOffset += PAGE_SIZE;
        appendPending = true;
        postLoadRows(currentSql + ' LIMIT ' + PAGE_SIZE + ' OFFSET ' + currentOffset, true);
    }

    // Load every remaining row in a single request (the "Load All" button).
    function loadAll() {
        if (userPaged || !currentSql) return;
        if (typeof totalCount === 'number' && remainingRowCount(allRows.length, totalCount) <= 0) return;
        currentOffset = allRows.length;
        appendPending = true;
        allLoaded = true;
        loadMoreBtn.disabled = true;
        loadAllBtn.disabled = true;
        // No LIMIT -> fetch all rows from the current offset onward.
        postLoadRows(currentSql + ' OFFSET ' + currentOffset, true);
    }

    function postLoadRows(sql, append) {
        setDataLoading(true);
        vscode.postMessage({ command: 'loadRows', sql, baseSql: currentSql, append: !!append });
    }

    function updateChangeIndicator() {
        const state = describePendingChanges({
            modified: modifiedCells.size,
            inserted: insertedRows.length,
            duplicated: duplicatedRows.length,
            deleted: deletedRows.size
        }, invalidCells.size);
        changeCount.textContent = state.text;
        commitBtn.disabled = !state.canCommit;
        discardBtn.disabled = !state.canDiscard;
    }

    let pendingChanges = null;
    // The statements as generated for the pending changes, so a manual edit in
    // the preview dialog can be detected (and undone).
    let generatedSql = '';

    function commitChanges() {
        const totalChanges = modifiedCells.size + deletedRows.size + insertedRows.length + duplicatedRows.length;
        if (totalChanges === 0) return;
        if (invalidCells.size > 0) {
            showError('Some cells hold a value their column cannot store. Fix the cells marked in red first.');
            return;
        }

        // Build updates grouped by row
        const rowUpdates = new Map();
        for (const [key, value] of modifiedCells.entries()) {
            const [rowIdxStr, colName] = key.split(':');
            const rowIdx = parseInt(rowIdxStr);
            if (deletedRows.has(rowIdx)) continue; // Skip if row is also deleted

            if (!rowUpdates.has(rowIdx)) {
                rowUpdates.set(rowIdx, {});
            }
            rowUpdates.get(rowIdx)[colName] = value;
        }

        // Each edited column is written back to the table it really came from,
        // so a result joined from several tables commits correctly.
        const targets = buildCommitTargets(caps, allRows, {
            updates: Array.from(rowUpdates.entries()),
            deletes: Array.from(deletedRows),
            inserts: [...insertedRows, ...duplicatedRows].map(entry => entry.row)
        });

        if (targets.length === 0) {
            showError('Nothing can be written back: the edited columns cannot be traced to a table row.');
            return;
        }

        pendingChanges = targets;
        vscode.postMessage({ command: 'previewSQL', targets });
    }

    function showSqlDialog(sql, connectionName) {
        generatedSql = sql;
        sqlDialogContent.value = sql;
        const curr = (typeof connectionName === 'string' && connectionName) ? connectionName : currentConnection;
        if (curr) currentConnection = curr;
        const last = lastUsedConnection || '(none)';
        const currLabel = curr || '(none)';
        if (sqlDialogConnection) {
            sqlDialogConnection.textContent = `Current connection: ${currLabel}  |  Data loaded with: ${last}`;
        }
        if (sqlDialogWarning) {
            const warnings = buildCommitWarnings(caps.warning, curr, lastUsedConnection);
            sqlDialogWarning.textContent = warnings.map(w => `⚠ ${w}`).join('\n');
            sqlDialogWarning.style.display = warnings.length > 0 ? 'block' : 'none';
        }
        updateConnectionDisplay();
        sqlDialogOverlay.style.display = 'flex';
    }

    function updateConnectionDisplay() {
        if (!connectionInfo) return;
        const badge = buildConnectionBadge(lastUsedConnection, currentConnection);
        connectionInfo.textContent = badge.text;
        connectionInfo.classList.toggle('warn', badge.warn);
        connectionInfo.title = badge.title;
    }

    function closeSqlDialog() {
        sqlDialogOverlay.style.display = 'none';
        pendingChanges = null;
        generatedSql = '';
    }

    function executePendingChanges() {
        if (!pendingChanges) return;
        const edited = sqlDialogContent.value;
        // Only a manually edited script is executed verbatim; otherwise the
        // extension commits the parameterized statements it generated.
        const message = isSqlEdited(generatedSql, edited)
            ? { command: 'commitChanges', targets: pendingChanges, sql: edited }
            : { command: 'commitChanges', targets: pendingChanges };
        vscode.postMessage(message);
        sqlDialogOverlay.style.display = 'none';
        pendingChanges = null;
        generatedSql = '';
    }

    function handleCommitSuccess() {
        // Reset state and re-run the query the grid currently shows, so a
        // filtered or custom view is not silently replaced by the default one.
        resetPendingChanges();
        runQuery();
    }

    function discardChanges() {
        resetPendingChanges();
        runQuery();
        updateChangeIndicator();
    }

    function showError(text) {
        // A failed query leaves the grid in its loading state; release it so the
        // view does not keep spinning forever.
        setDataLoading(false);
        changeCount.textContent = `Error: ${text}`;
        changeCount.classList.add('status-error');
        setTimeout(() => {
            changeCount.classList.remove('status-error');
            updateChangeIndicator();
        }, 5000);
        showErrorDialog(text);
    }

    // Modal error dialog shown inside the Data Viewer so a failing query is not
    // only reported through the small VS Code notification.
    const errorDialogOverlay = document.getElementById('errorDialogOverlay');
    const errorDialogMessage = document.getElementById('errorDialogMessage');
    const errorDialogClose = document.getElementById('errorDialogClose');
    const errorDialogOk = document.getElementById('errorDialogOk');

    function showErrorDialog(text) {
        if (!errorDialogOverlay || !errorDialogMessage) {
            return;
        }
        const state = buildErrorDialogState(text);
        if (!state.visible) {
            return;
        }
        errorDialogMessage.textContent = state.message;
        errorDialogOverlay.style.display = 'flex';
    }

    function closeErrorDialog() {
        if (errorDialogOverlay) {
            errorDialogOverlay.style.display = 'none';
        }
    }

    if (errorDialogClose) errorDialogClose.addEventListener('click', closeErrorDialog);
    if (errorDialogOk) errorDialogOk.addEventListener('click', closeErrorDialog);
    if (errorDialogOverlay) errorDialogOverlay.addEventListener('click', (e) => {
        if (e.target === errorDialogOverlay) closeErrorDialog();
    });

    // ===== Permanent Constraints Dialog Logic =====
    const constraintsBtn = document.getElementById('constraintsBtn');
    const constraintsDialogOverlay = document.getElementById('constraintsDialogOverlay');
    const constraintsDialogClose = document.getElementById('constraintsDialogClose');
    const constraintsList = document.getElementById('constraintsList');
    const constraintsAdd = document.getElementById('constraintsAdd');
    const constraintSortsList = document.getElementById('constraintSortsList');
    const constraintSortsAdd = document.getElementById('constraintSortsAdd');
    const constraintsSave = document.getElementById('constraintsSave');
    const constraintsCancel = document.getElementById('constraintsCancel');
    const constraintsPreview = document.getElementById('constraintsPreview');

    // Working copy edited in the dialog; committed to permanentConstraints on Save.
    let constraintDraft = [];
    // Working copy of the permanent ORDER BY entries, committed on Save.
    let constraintSortDraft = [];

    if (constraintsBtn) constraintsBtn.addEventListener('click', openConstraintsDialog);
    if (constraintsDialogClose) constraintsDialogClose.addEventListener('click', closeConstraintsDialog);
    if (constraintsCancel) constraintsCancel.addEventListener('click', closeConstraintsDialog);
    if (constraintsAdd) constraintsAdd.addEventListener('click', () => {
        const cols = columns || [];
        const left = cols.length ? { kind: 'column', column: cols[0].name } : { kind: 'raw', text: '' };
        constraintDraft.push({ operator: '=', left, right: { kind: 'raw', text: '' } });
        renderConstraintRows();
    });
    if (constraintSortsAdd) constraintSortsAdd.addEventListener('click', () => {
        const cols = columns || [];
        constraintSortDraft.push({ column: cols.length ? cols[0].name : '', direction: 'ASC' });
        renderConstraintSortRows();
    });
    if (constraintsSave) constraintsSave.addEventListener('click', saveConstraints);

    function openConstraintsDialog() {
        // Deep-clone current constraints into a draft so Cancel discards edits.
        constraintDraft = JSON.parse(JSON.stringify(permanentConstraints || []));
        constraintSortDraft = JSON.parse(JSON.stringify(permanentSorts || []));
        renderConstraintRows();
        renderConstraintSortRows();
        constraintsDialogOverlay.style.display = 'flex';
    }

    function closeConstraintsDialog() {
        constraintsDialogOverlay.style.display = 'none';
    }

    // Render the dropdown + optional text input for one operand of a constraint.
    // Mirrors the Join dialog's fixed-condition operandControls design.
    function constraintOperandControls(ci, side, operand) {
        const cols = columns || [];
        const op = operand || { kind: 'raw', text: '' };
        const colOpts = cols.map(c => {
            const sel = op.kind === 'column' && op.column === c.name;
            return '<option value="c\u0001' + escapeAttr(c.name) + '" ' + (sel ? 'selected' : '') + '>' + escapeHtml(c.name) + '</option>';
        }).join('');
        const rawSel = op.kind === 'raw' ? 'selected' : '';
        const sel = '<select class="operand-kind" data-cons-op="' + ci + ':' + side + '">' +
            colOpts +
            '<option value="__raw__" ' + rawSel + '>Custom value…</option>' +
            '</select>';
        const rawInput = op.kind === 'raw'
            ? '<input class="cust-raw" data-cons-raw="' + ci + ':' + side + '" value="' + escapeAttr(op.text || '') + '" placeholder="value / expression">'
            : '';
        return sel + rawInput;
    }

    function renderConstraintRows() {
        let html = '';
        constraintDraft.forEach((c, ci) => {
            const operatorOpts = CONSTRAINT_OPERATORS.map(o =>
                '<option ' + (o === c.operator ? 'selected' : '') + '>' + o + '</option>'
            ).join('');
            let row = '<div class="cond-row">' +
                constraintOperandControls(ci, 'left', c.left) +
                '<select class="operand-operator" data-cons-operator="' + ci + '">' + operatorOpts + '</select>';
            if (constraintIsBetween(c.operator)) {
                row += constraintOperandControls(ci, 'right', c.right) +
                    '<span>AND</span>' +
                    constraintOperandControls(ci, 'right2', c.right2);
            } else if (!constraintIsUnary(c.operator)) {
                row += constraintOperandControls(ci, 'right', c.right);
            }
            row += '<button class="btn" data-cons-rm="' + ci + '">Remove</button></div>';
            html += row;
        });
        constraintsList.innerHTML = html;
        bindConstraintRows();
        updateConstraintPreview();
    }

    function bindConstraintRows() {
        constraintsList.querySelectorAll('[data-cons-operator]').forEach(seln => {
            seln.onchange = () => {
                const ci = Number(seln.dataset.consOperator);
                const c = constraintDraft[ci];
                c.operator = seln.value;
                if (constraintIsUnary(c.operator)) {
                    delete c.right; delete c.right2;
                } else if (constraintIsBetween(c.operator)) {
                    if (!c.right) c.right = { kind: 'raw', text: '' };
                    if (!c.right2) c.right2 = { kind: 'raw', text: '' };
                } else {
                    if (!c.right) c.right = { kind: 'raw', text: '' };
                    delete c.right2;
                }
                renderConstraintRows();
            };
        });
        constraintsList.querySelectorAll('[data-cons-op]').forEach(seln => {
            seln.onchange = () => {
                const parts = seln.dataset.consOp.split(':');
                const c = constraintDraft[Number(parts[0])];
                const side = parts[1];
                const raw = seln.value;
                let operand;
                if (raw === '__raw__') {
                    operand = { kind: 'raw', text: '' };
                } else {
                    const si = raw.indexOf('\u0001');
                    operand = { kind: 'column', column: raw.slice(si + 1) };
                }
                c[side] = operand;
                renderConstraintRows();
            };
        });
        constraintsList.querySelectorAll('[data-cons-raw]').forEach(inp => {
            inp.oninput = () => {
                const parts = inp.dataset.consRaw.split(':');
                const c = constraintDraft[Number(parts[0])];
                const side = parts[1];
                if (!c[side] || c[side].kind !== 'raw') c[side] = { kind: 'raw', text: '' };
                c[side].text = inp.value;
                updateConstraintPreview();
            };
        });
        constraintsList.querySelectorAll('[data-cons-rm]').forEach(b => {
            b.onclick = () => {
                constraintDraft.splice(Number(b.dataset.consRm), 1);
                renderConstraintRows();
            };
        });
    }

    function updateConstraintPreview() {
        const where = buildConstraintWhere(constraintDraft, formatIdentifier);
        const orderBy = buildConstraintOrderBy(constraintSortDraft, formatIdentifier);
        constraintsPreview.textContent = `SELECT * FROM ${getDefaultTableReference()}`
            + (where ? ` WHERE ${where}` : '')
            + (orderBy ? ` ORDER BY ${orderBy}` : '');
    }

    function renderConstraintSortRows() {
        if (!constraintSortsList) return;
        const cols = columns || [];
        let html = '';
        constraintSortDraft.forEach((s, si) => {
            const known = cols.some(c => c.name === s.column);
            const colOpts = cols.map(c =>
                '<option value="' + escapeAttr(c.name) + '" ' + (c.name === s.column ? 'selected' : '') + '>' + escapeHtml(c.name) + '</option>'
            ).join('');
            // Keep a stored column that is not part of the current result, so
            // switching queries does not silently drop it.
            const missingOpt = (!known && s.column)
                ? '<option value="' + escapeAttr(s.column) + '" selected>' + escapeHtml(s.column) + '</option>'
                : '';
            const dirOpts = CONSTRAINT_SORT_DIRECTIONS.map(d =>
                '<option ' + (d === String(s.direction || '').toUpperCase() ? 'selected' : '') + '>' + d + '</option>'
            ).join('');
            html += '<div class="cond-row">' +
                '<select class="operand-kind" data-sort-col="' + si + '">' + missingOpt + colOpts + '</select>' +
                '<select class="operand-operator" data-sort-dir="' + si + '">' + dirOpts + '</select>' +
                '<button class="btn" data-sort-rm="' + si + '">Remove</button>' +
                '</div>';
        });
        constraintSortsList.innerHTML = html;
        bindConstraintSortRows();
        updateConstraintPreview();
    }

    function bindConstraintSortRows() {
        constraintSortsList.querySelectorAll('[data-sort-col]').forEach(seln => {
            seln.onchange = () => {
                constraintSortDraft[Number(seln.dataset.sortCol)].column = seln.value;
                updateConstraintPreview();
            };
        });
        constraintSortsList.querySelectorAll('[data-sort-dir]').forEach(seln => {
            seln.onchange = () => {
                constraintSortDraft[Number(seln.dataset.sortDir)].direction = seln.value;
                updateConstraintPreview();
            };
        });
        constraintSortsList.querySelectorAll('[data-sort-rm]').forEach(b => {
            b.onclick = () => {
                constraintSortDraft.splice(Number(b.dataset.sortRm), 1);
                renderConstraintSortRows();
            };
        });
    }

    function saveConstraints() {
        // Drop incomplete rows so persisted constraints always format to SQL.
        permanentConstraints = constraintDraft.filter(c => formatConstraintCondition(c, formatIdentifier));
        permanentSorts = constraintSortDraft.filter(s => formatConstraintSort(s, formatIdentifier));
        vscode.postMessage({
            command: 'savePermanentConstraints',
            conditions: permanentConstraints,
            sorts: permanentSorts
        });
        closeConstraintsDialog();
        setQueryText(getDefaultQuery());
        runQuery();
    }

    // ===== Saved Queries Logic =====
    const querySaveBtn = document.getElementById('querySaveBtn');
    const queryParamsBtn = document.getElementById('queryParamsBtn');
    const saveQueryDialogOverlay = document.getElementById('saveQueryDialogOverlay');
    const saveQueryDialogTitle = document.getElementById('saveQueryDialogTitle');
    const saveQueryDialogClose = document.getElementById('saveQueryDialogClose');
    const saveQueryName = document.getElementById('saveQueryName');
    const saveQueryScope = document.getElementById('saveQueryScope');
    const saveQuerySql = document.getElementById('saveQuerySql');
    const saveQueryParamsList = document.getElementById('saveQueryParamsList');
    const saveQueryExisting = document.getElementById('saveQueryExisting');
    const saveQuerySave = document.getElementById('saveQuerySave');
    const saveQueryCancel = document.getElementById('saveQueryCancel');
    const queryParamsDialogOverlay = document.getElementById('queryParamsDialogOverlay');
    const queryParamsDialogTitle = document.getElementById('queryParamsDialogTitle');
    const queryParamsDialogClose = document.getElementById('queryParamsDialogClose');
    const queryParamsList = document.getElementById('queryParamsList');
    const queryParamsPreview = document.getElementById('queryParamsPreview');
    const queryParamsRun = document.getElementById('queryParamsRun');
    const queryParamsCancel = document.getElementById('queryParamsCancel');

    const PARAMETER_KINDS = [
        { value: 'text', label: 'Text (quoted)' },
        { value: 'number', label: 'Number' },
        { value: 'identifier', label: 'Identifier (quoted)' },
        { value: 'raw', label: 'Raw SQL (unchecked!)' }
    ];

    // Working copy of the parameter list edited in the Bookmark Query dialog.
    let saveQueryDraft = [];
    // Id of the saved query being overwritten, or '' when saving a new one.
    let saveQueryEditId = '';
    // Values entered in the parameter dialog before they are applied.
    let queryParamsDraft = {};

    if (querySaveBtn) querySaveBtn.addEventListener('click', openSaveQueryDialog);
    if (saveQueryDialogClose) saveQueryDialogClose.addEventListener('click', closeSaveQueryDialog);
    if (saveQueryCancel) saveQueryCancel.addEventListener('click', closeSaveQueryDialog);
    if (saveQuerySave) saveQuerySave.addEventListener('click', submitSaveQuery);
    if (saveQuerySql) saveQuerySql.addEventListener('input', () => {
        saveQueryDraft = mergeQueryParameters(saveQuerySql.value, saveQueryDraft);
        renderSaveQueryParams();
    });
    if (queryParamsBtn) queryParamsBtn.addEventListener('click', () => openQueryParamsDialog(false));
    if (queryParamsDialogClose) queryParamsDialogClose.addEventListener('click', closeQueryParamsDialog);
    if (queryParamsCancel) queryParamsCancel.addEventListener('click', closeQueryParamsDialog);
    if (queryParamsRun) queryParamsRun.addEventListener('click', applyQueryParamsDialog);

    function openSaveQueryDialog() {
        const sql = (queryInput.value || '').trim();
        // Editing a running saved query starts from its template, so the
        // placeholders are preserved instead of the values already filled in.
        const source = savedQueryId && savedQueryTemplate ? savedQueryTemplate : sql;
        saveQueryEditId = savedQueryId || '';
        saveQuerySql.value = source;
        saveQueryName.value = saveQueryEditId
            ? (savedQueries.find(q => q.id === saveQueryEditId) || {}).name || ''
            : (table ? schema + '.' + table : '');
        saveQueryScope.value = 'global';
        saveQueryDraft = mergeQueryParameters(source, savedQueryParameters);
        updateSaveQueryTitle();
        renderSaveQueryParams();
        renderSaveQueryExisting();
        saveQueryDialogOverlay.style.display = 'flex';
        saveQueryName.focus();
        vscode.postMessage({ command: 'getSavedQueries' });
    }

    function closeSaveQueryDialog() {
        saveQueryDialogOverlay.style.display = 'none';
    }

    function updateSaveQueryTitle() {
        saveQueryDialogTitle.textContent = saveQueryEditId ? 'Update Bookmarked Query' : 'Bookmark Query';
        saveQuerySave.textContent = saveQueryEditId ? 'Update' : 'Save';
        saveQueryScope.disabled = Boolean(saveQueryEditId);
    }

    function renderSaveQueryParams() {
        if (saveQueryDraft.length === 0) {
            saveQueryParamsList.innerHTML =
                '<p class="mapping-hint">No placeholders. Add <code>:name</code> to the SQL to create one.</p>';
            return;
        }
        saveQueryParamsList.innerHTML = saveQueryDraft.map((p, i) => {
            const kindOpts = PARAMETER_KINDS.map(k =>
                '<option value="' + k.value + '"' + (k.value === p.kind ? ' selected' : '') + '>' + k.label + '</option>'
            ).join('');
            return '<div class="cond-row">' +
                '<span><code>:' + escapeHtml(p.name) + '</code></span>' +
                '<select class="operand-kind" data-param-kind="' + i + '">' + kindOpts + '</select>' +
                '<input class="cust-raw" data-param-label="' + i + '" value="' + escapeAttr(p.label || '') + '" placeholder="label (optional)">' +
                '<input class="cust-raw" data-param-default="' + i + '" value="' + escapeAttr(p.defaultValue || '') + '" placeholder="default (optional)">' +
                '</div>';
        }).join('');
        saveQueryParamsList.querySelectorAll('[data-param-kind]').forEach(el => {
            el.onchange = () => { saveQueryDraft[Number(el.dataset.paramKind)].kind = el.value; };
        });
        saveQueryParamsList.querySelectorAll('[data-param-label]').forEach(el => {
            el.oninput = () => { saveQueryDraft[Number(el.dataset.paramLabel)].label = el.value; };
        });
        saveQueryParamsList.querySelectorAll('[data-param-default]').forEach(el => {
            el.oninput = () => { saveQueryDraft[Number(el.dataset.paramDefault)].defaultValue = el.value; };
        });
    }

    // List the stored queries so one of them can be overwritten instead of
    // piling up near-identical copies.
    function renderSaveQueryExisting() {
        if (!savedQueries.length) {
            saveQueryExisting.innerHTML = '<p class="mapping-hint">None yet.</p>';
            return;
        }
        saveQueryExisting.innerHTML = savedQueries.map(q =>
            '<div class="cond-row">' +
            '<span>' + escapeHtml(q.name) + '</span>' +
            '<span class="mapping-hint">' + (q.scope === 'workspace' ? 'Workspace' : 'Personal') + '</span>' +
            '<button class="btn" data-saved-overwrite="' + escapeAttr(q.id) + '">Overwrite</button>' +
            '</div>'
        ).join('');
        saveQueryExisting.querySelectorAll('[data-saved-overwrite]').forEach(b => {
            b.onclick = () => {
                const q = savedQueries.find(x => x.id === b.dataset.savedOverwrite);
                if (!q) return;
                saveQueryEditId = q.id;
                saveQueryName.value = q.name;
                saveQueryDraft = mergeQueryParameters(saveQuerySql.value, q.parameters);
                updateSaveQueryTitle();
                renderSaveQueryParams();
            };
        });
    }

    function submitSaveQuery() {
        const name = (saveQueryName.value || '').trim();
        const sql = (saveQuerySql.value || '').trim();
        if (!name || !sql) {
            showError('A bookmarked query needs a name and a SELECT statement.');
            return;
        }
        const parameters = mergeQueryParameters(sql, saveQueryDraft);
        // Remember what was sent so the panel can adopt it once the extension
        // confirms the id of the stored query.
        savedQueryPending = { sql, parameters };
        vscode.postMessage({
            command: 'saveSavedQuery',
            id: saveQueryEditId,
            name,
            sql,
            scope: saveQueryScope.value,
            parameters
        });
        closeSaveQueryDialog();
    }

    /**
     * Ask for the placeholder values of the running saved query.
     * @param {boolean} initial true when the panel just opened and must not
     *   show a result until the values are known.
     */
    function openQueryParamsDialog(initial) {
        queryParamsPendingInitialRun = Boolean(initial);
        queryParamsDraft = {};
        savedQueryParameters.forEach(p => {
            const stored = savedQueryValues[p.name];
            queryParamsDraft[p.name] = stored !== undefined && stored !== null && stored !== ''
                ? String(stored)
                : (p.defaultValue || '');
        });
        queryParamsDialogTitle.textContent = 'Parameters for "' + (tableName.textContent || 'query') + '"';
        renderQueryParamRows();
        queryParamsDialogOverlay.style.display = 'flex';
        const first = queryParamsList.querySelector('input');
        if (first) first.focus();
    }

    function closeQueryParamsDialog() {
        queryParamsDialogOverlay.style.display = 'none';
        if (queryParamsPendingInitialRun) {
            // The panel opened for a saved query but the values were dismissed,
            // so nothing was ever run — say so instead of showing an empty grid.
            queryParamsPendingInitialRun = false;
            rowCount.textContent = 'Waiting for parameters — press "Parameters…" to run the query.';
        }
    }

    function renderQueryParamRows() {
        queryParamsList.innerHTML = savedQueryParameters.map((p, i) => {
            const kind = PARAMETER_KINDS.find(k => k.value === p.kind) || PARAMETER_KINDS[0];
            const warn = p.kind === 'raw'
                ? '<span class="mapping-hint">inserted unchanged</span>'
                : '<span class="mapping-hint">' + escapeHtml(kind.label) + '</span>';
            return '<div class="cond-row">' +
                '<label for="queryParamInput' + i + '">' + escapeHtml(p.label || (':' + p.name)) + '</label>' +
                '<input class="cust-raw" id="queryParamInput' + i + '" data-query-param="' + escapeAttr(p.name) + '" value="' +
                escapeAttr(queryParamsDraft[p.name] || '') + '">' +
                warn +
                '</div>';
        }).join('');
        queryParamsList.querySelectorAll('[data-query-param]').forEach(el => {
            el.oninput = () => {
                queryParamsDraft[el.dataset.queryParam] = el.value;
                updateQueryParamsPreview();
            };
            el.onkeydown = (e) => {
                if (e.key === 'Enter') { e.preventDefault(); applyQueryParamsDialog(); }
            };
        });
        updateQueryParamsPreview();
    }

    function updateQueryParamsPreview() {
        try {
            queryParamsPreview.textContent =
                applyQueryParameters(savedQueryTemplate, queryParamsDraft, savedQueryParameters);
        } catch (err) {
            queryParamsPreview.textContent = err && err.message ? err.message : String(err);
        }
    }

    function applyQueryParamsDialog() {
        let sql;
        try {
            sql = applyQueryParameters(savedQueryTemplate, queryParamsDraft, savedQueryParameters);
        } catch (err) {
            showError(err && err.message ? err.message : String(err));
            return;
        }
        savedQueryValues = Object.assign({}, queryParamsDraft);
        if (savedQueryId) {
            vscode.postMessage({
                command: 'saveSavedQueryValues',
                id: savedQueryId,
                values: savedQueryValues
            });
        }
        queryParamsPendingInitialRun = false;
        closeQueryParamsDialog();
        setQueryText(sql);
        runQuery();
    }

    function handleSavedQueriesLoaded(msg) {
        savedQueries = Array.isArray(msg.queries) ? msg.queries : [];
        if (saveQueryDialogOverlay && saveQueryDialogOverlay.style.display === 'flex') {
            renderSaveQueryExisting();
        }
    }

    // Reflect the identity of a freshly stored query so a second "Bookmark Query"
    // updates it instead of creating another copy.
    function handleSavedQuerySaved(msg) {
        if (typeof msg.id !== 'string' || !msg.id) return;
        savedQueryId = msg.id;
        if (savedQueryPending) {
            savedQueryTemplate = savedQueryPending.sql;
            savedQueryParameters = savedQueryPending.parameters;
            savedQueryPending = null;
            updateQueryParamsButton();
        }
    }

    // ===== Export Dialog Logic =====
    const exportBtn = document.getElementById('exportBtn');
    const exportDialogOverlay = document.getElementById('exportDialogOverlay');
    const exportDialogClose = document.getElementById('exportDialogClose');
    const exportFormat = document.getElementById('exportFormat');
    const exportFilename = document.getElementById('exportFilename');
    const exportExecute = document.getElementById('exportExecute');
    const exportCancel = document.getElementById('exportCancel');
    const exportSaveDefault = document.getElementById('exportSaveDefault');

    const exportOptGroups = {
        csv: document.getElementById('exportOptsCsv'),
        json: document.getElementById('exportOptsJson'),
        xml: document.getElementById('exportOptsXml'),
        insert: document.getElementById('exportOptsInsert'),
        excel: document.getElementById('exportOptsExcel')
    };

    let exportDefaults = {};

    const csvSeparatorSelect = document.getElementById('csvSeparator');
    const csvCustomSeparatorField = document.getElementById('csvCustomSeparatorField');
    const exportSaveLocation = document.getElementById('exportSaveLocation');

    exportBtn.addEventListener('click', openExportDialog);
    exportDialogClose.addEventListener('click', closeExportDialog);
    exportCancel.addEventListener('click', closeExportDialog);
    exportExecute.addEventListener('click', executeExport);
    exportSaveDefault.addEventListener('click', saveExportDefault);
    exportFormat.addEventListener('change', onExportFormatChange);
    csvSeparatorSelect.addEventListener('change', () => {
        csvCustomSeparatorField.style.display = csvSeparatorSelect.value === '__custom__' ? 'flex' : 'none';
    });
    document.getElementById('exportBrowseLocation').addEventListener('click', () => {
        vscode.postMessage({ command: 'browseExportLocation' });
    });

    function openExportDialog() {
        vscode.postMessage({ command: 'getExportDefaults' });
        exportFilename.value = table || 'export';
        const insertTableName = document.getElementById('insertTableName');
        if (insertTableName) {
            insertTableName.value = defaultInsertTableName(getDefaultTableReference());
        }
        onExportFormatChange();
        exportDialogOverlay.style.display = 'flex';
    }

    function closeExportDialog() {
        exportDialogOverlay.style.display = 'none';
    }

    function onExportFormatChange() {
        const fmt = exportFormat.value;
        Object.keys(exportOptGroups).forEach(key => {
            exportOptGroups[key].style.display = key === fmt ? 'block' : 'none';
        });
        const extensions = { csv: '.csv', json: '.json', xml: '.xml', insert: '.sql', excel: '.xlsx' };
        const base = exportFilename.value.replace(/\.(csv|json|xml|sql|xlsx)$/, '');
        exportFilename.value = base;
        exportFilename.placeholder = `filename (${extensions[fmt]})`;
    }

    function applyExportDefaults(defaults) {
        exportDefaults = defaults || {};
        if (exportDefaults._saveLocation) {
            exportSaveLocation.value = exportDefaults._saveLocation;
        }
        const fmt = exportFormat.value;
        const defs = exportDefaults[fmt];
        if (!defs) return;

        if (fmt === 'csv') {
            if (defs.csvSeparator) {
                // Check if the separator matches a preset
                const presets = [',', ';', '\t', '|'];
                if (presets.includes(defs.csvSeparator)) {
                    csvSeparatorSelect.value = defs.csvSeparator;
                    csvCustomSeparatorField.style.display = 'none';
                } else {
                    csvSeparatorSelect.value = '__custom__';
                    document.getElementById('csvCustomSeparator').value = defs.csvSeparator;
                    csvCustomSeparatorField.style.display = 'flex';
                }
            }
            if (defs.csvIncludeHeaders !== undefined) document.getElementById('csvIncludeHeaders').checked = defs.csvIncludeHeaders;
            if (defs.csvQuoteStrings !== undefined) document.getElementById('csvQuoteStrings').checked = defs.csvQuoteStrings;
            if (defs.csvLineEnding) document.getElementById('csvLineEnding').value = defs.csvLineEnding;
        } else if (fmt === 'json') {
            if (defs.jsonPretty !== undefined) document.getElementById('jsonPretty').checked = defs.jsonPretty;
            if (defs.jsonArrayWrapper !== undefined) document.getElementById('jsonArrayWrapper').checked = defs.jsonArrayWrapper;
        } else if (fmt === 'xml') {
            if (defs.xmlRootElement) document.getElementById('xmlRootElement').value = defs.xmlRootElement;
            if (defs.xmlRowElement) document.getElementById('xmlRowElement').value = defs.xmlRowElement;
        } else if (fmt === 'insert') {
            if (defs.insertBatchSize) document.getElementById('insertBatchSize').value = defs.insertBatchSize;
        } else if (fmt === 'excel') {
            if (defs.excelIncludeHeaders !== undefined) document.getElementById('excelIncludeHeaders').checked = defs.excelIncludeHeaders;
            if (defs.excelSheetName) document.getElementById('excelSheetName').value = defs.excelSheetName;
            if (defs.excelIncludeSqlSheet !== undefined) document.getElementById('excelIncludeSqlSheet').checked = defs.excelIncludeSqlSheet;
        }
    }

    function gatherExportOptions() {
        const fmt = exportFormat.value;
        const filename = exportFilename.value.trim() || 'export';
        const extensions = { csv: '.csv', json: '.json', xml: '.xml', insert: '.sql', excel: '.xlsx' };
        const ext = extensions[fmt];
        const fullFilename = filename.endsWith(ext) ? filename : filename + ext;

        const opts = {
            format: fmt,
            filename: fullFilename
        };

        if (fmt === 'csv') {
            const sepVal = csvSeparatorSelect.value;
            opts.csvSeparator = sepVal === '__custom__' ? (document.getElementById('csvCustomSeparator').value || ',') : sepVal;
            opts.csvIncludeHeaders = document.getElementById('csvIncludeHeaders').checked;
            opts.csvQuoteStrings = document.getElementById('csvQuoteStrings').checked;
            opts.csvLineEnding = document.getElementById('csvLineEnding').value;
        } else if (fmt === 'json') {
            opts.jsonPretty = document.getElementById('jsonPretty').checked;
            opts.jsonArrayWrapper = document.getElementById('jsonArrayWrapper').checked;
        } else if (fmt === 'xml') {
            opts.xmlRootElement = document.getElementById('xmlRootElement').value || 'data';
            opts.xmlRowElement = document.getElementById('xmlRowElement').value || 'row';
        } else if (fmt === 'insert') {
            opts.insertTableName = document.getElementById('insertTableName').value || defaultInsertTableName(getDefaultTableReference());
            opts.insertBatchSize = parseInt(document.getElementById('insertBatchSize').value) || 1;
        } else if (fmt === 'excel') {
            opts.excelIncludeHeaders = document.getElementById('excelIncludeHeaders').checked;
            opts.excelSheetName = document.getElementById('excelSheetName').value || 'Data';
            opts.excelIncludeSqlSheet = document.getElementById('excelIncludeSqlSheet').checked;
            opts.excelSqlStatement = queryInput.value;
        }

        return opts;
    }

    function executeExport() {
        const opts = gatherExportOptions();
        opts.saveLocation = exportSaveLocation.value.trim() || '';
        // Send the current SQL query so backend can fetch ALL rows (not limited to page)
        const currentSql = queryInput.value.trim();
        vscode.postMessage({
            command: 'exportData',
            options: opts,
            sql: currentSql,
            schema: schema,
            table: table,
            columns: columns
        });
        closeExportDialog();
    }

    function saveExportDefault() {
        const opts = gatherExportOptions();
        const saveLocation = exportSaveLocation.value.trim();
        vscode.postMessage({
            command: 'saveExportDefaults',
            format: opts.format,
            options: opts,
            saveLocation: saveLocation
        });
    }

    function getCellTextContent(td) {
        let text = '';
        td.childNodes.forEach(node => {
            if (node.nodeType === Node.TEXT_NODE) {
                text += node.textContent;
            } else if (node.nodeType === Node.ELEMENT_NODE && !node.classList.contains('fk-btn')) {
                text += node.textContent;
            }
        });
        return text.trim();
    }

    function getDefaultTableReference() {
        if (tableReference) {
            return tableReference;
        }
        if (!table) {
            return '';
        }

        const formattedTable = formatIdentifier(table);
        if (!schema) {
            return formattedTable;
        }

        return `${formatIdentifier(schema)}.${formattedTable}`;
    }

    // SQL WHERE body for the permanent constraints, or '' when none apply.
    function getDefaultWhere() {
        return buildConstraintWhere(permanentConstraints, formatIdentifier);
    }

    // SQL ORDER BY body for the permanent sorts, or '' when none apply.
    function getDefaultOrderBy() {
        return buildConstraintOrderBy(permanentSorts, formatIdentifier);
    }

    // The default table-view query including any permanent WHERE constraints
    // and ORDER BY entries. Lists all known columns explicitly instead of `*`
    // (falls back to `*` while column metadata is still loading).
    function getDefaultQuery() {
        const where = getDefaultWhere();
        const orderBy = getDefaultOrderBy();
        const columnList = buildSelectColumnList(columns, formatIdentifier);
        return `SELECT ${columnList} FROM ${getDefaultTableReference()}`
            + (where ? ` WHERE ${where}` : '')
            + (orderBy ? ` ORDER BY ${orderBy}` : '');
    }

    // NOTE: Keep in sync with formatIdentifier/needsQuoting in src/queryRunner.ts
    function formatIdentifier(identifier) {
        if (alwaysQuote || needsQuoting(identifier)) {
            return `"${String(identifier).replace(/"/g, '""')}"`;
        }
        return identifier;
    }

    function needsQuoting(identifier) {
        return !/^[a-z_][a-z0-9_$]*$/.test(identifier) || POSTGRES_RESERVED_KEYWORDS.has(String(identifier).toLowerCase());
    }

    function escapeHtml(text) {
        if (text === null || text === undefined) return '';
        const div = document.createElement('div');
        div.textContent = String(text);
        return div.innerHTML;
    }

    function escapeAttr(text) {
        if (text === null || text === undefined) return '';
        return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ===== Custom Column Mapping Logic =====

    function evaluateMappingConditions(mapping, rowData) {
        if (!mapping.conditions || mapping.conditions.length === 0) return true;
        if (!rowData) return false;
        return mapping.conditions.every(cond => {
            const cellValue = rowData[cond.column];
            if (cellValue === null || cellValue === undefined) return false;
            const strVal = String(cellValue);
            switch (cond.operator) {
                case '=': return strVal === cond.value;
                case '!=': return strVal !== cond.value;
                case '>': return strVal > cond.value;
                case '<': return strVal < cond.value;
                case '>=': return strVal >= cond.value;
                case '<=': return strVal <= cond.value;
                case 'LIKE': return strVal.includes(cond.value);
                case 'ILIKE': return strVal.toLowerCase().includes(cond.value.toLowerCase());
                default: return strVal === cond.value;
            }
        });
    }

    // Mapping dialog DOM refs
    const mappingDialogOverlay = document.getElementById('mappingDialogOverlay');
    const mappingDialogTitle = document.getElementById('mappingDialogTitle');
    const mappingDialogClose = document.getElementById('mappingDialogClose');
    const mappingDialogSave = document.getElementById('mappingDialogSave');
    const mappingDialogDelete = document.getElementById('mappingDialogDelete');
    const mappingDialogCancel = document.getElementById('mappingDialogCancel');
    const mappingLabel = document.getElementById('mappingLabel');
    const mappingSourceSchema = document.getElementById('mappingSourceSchema');
    const mappingSourceTable = document.getElementById('mappingSourceTable');
    const mappingSourceColumn = document.getElementById('mappingSourceColumn');
    const mappingTargetSchema = document.getElementById('mappingTargetSchema');
    const mappingTargetTable = document.getElementById('mappingTargetTable');
    const mappingTargetColumn = document.getElementById('mappingTargetColumn');
    const mappingConditions = document.getElementById('mappingConditions');
    const mappingAddCondition = document.getElementById('mappingAddCondition');
    const mappingColumnPairs = document.getElementById('mappingColumnPairs');
    const mappingAddColumnPair = document.getElementById('mappingAddColumnPair');
    const mappingIsDefault = document.getElementById('mappingIsDefault');
    const mappingShareWorkspace = document.getElementById('mappingShareWorkspace');

    // Manage mappings dialog DOM refs
    const manageMappingsOverlay = document.getElementById('manageMappingsOverlay');
    const manageMappingsClose = document.getElementById('manageMappingsClose');
    const manageMappingsCloseBtn = document.getElementById('manageMappingsCloseBtn');
    const manageMappingsAdd = document.getElementById('manageMappingsAdd');
    const mappingsList = document.getElementById('mappingsList');
    const noMappingsMsg = document.getElementById('noMappingsMsg');

    let editingMappingId = null;
    let typeaheadTables = []; // [{schema, table}]
    let typeaheadColumns = []; // column names for currently selected target table

    function handleTablesForTypeahead(msg) {
        typeaheadTables = msg.tables || [];
        updateTableTypeahead();
    }

    function handleColumnsForTypeahead(msg) {
        typeaheadColumns = msg.columns || [];
        updateColumnTypeahead();
    }

    function requestTablesForTypeahead() {
        vscode.postMessage({ command: 'getTablesForTypeahead' });
    }

    function requestColumnsForTypeahead(targetSchema, targetTable) {
        if (!targetSchema || !targetTable) {
            typeaheadColumns = [];
            updateColumnTypeahead();
            return;
        }
        vscode.postMessage({ command: 'getColumnsForTypeahead', schema: targetSchema, table: targetTable });
    }

    function setupTypeahead(input, getSuggestions, onSelect) {
        const wrapper = input.closest('.typeahead-wrapper') || input.parentElement;
        let dropdown = wrapper.querySelector('.typeahead-dropdown');
        if (!dropdown) {
            dropdown = document.createElement('div');
            dropdown.className = 'typeahead-dropdown';
            wrapper.appendChild(dropdown);
        }

        function showSuggestions() {
            const val = input.value.toLowerCase().trim();
            const suggestions = getSuggestions(val);
            if (suggestions.length === 0 || (suggestions.length === 1 && suggestions[0].value.toLowerCase() === val)) {
                dropdown.style.display = 'none';
                return;
            }
            let html = '';
            suggestions.slice(0, 20).forEach(s => {
                html += `<div class="typeahead-item" data-value="${escapeAttr(s.value)}">${escapeHtml(s.label)}</div>`;
            });
            dropdown.innerHTML = html;
            dropdown.style.display = 'block';

            dropdown.querySelectorAll('.typeahead-item').forEach(item => {
                item.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    const value = item.getAttribute('data-value');
                    input.value = value;
                    dropdown.style.display = 'none';
                    suppressNext = true;
                    if (onSelect) onSelect(value);
                });
            });
        }

        let suppressNext = false;
        input.addEventListener('input', () => {
            if (suppressNext) { suppressNext = false; return; }
            showSuggestions();
        });
        input.addEventListener('focus', () => {
            if (suppressNext) { suppressNext = false; return; }
            showSuggestions();
        });
        input.addEventListener('blur', () => {
            setTimeout(() => { dropdown.style.display = 'none'; }, 150);
        });
    }

    function getUniqueSchemas() {
        const schemas = new Set(typeaheadTables.map(t => t.schema));
        return [...schemas].sort();
    }

    function updateTableTypeahead() {
        // Re-trigger suggestions if dialog is open
        if (mappingDialogOverlay.style.display === 'flex') {
            mappingTargetTable.dispatchEvent(new Event('focus'));
        }
    }

    function updateColumnTypeahead() {
        if (mappingDialogOverlay.style.display === 'flex') {
            mappingTargetColumn.dispatchEvent(new Event('focus'));
        }
    }

    mappingDialogClose.addEventListener('click', closeMappingDialog);
    mappingDialogCancel.addEventListener('click', closeMappingDialog);
    mappingDialogSave.addEventListener('click', saveMappingFromDialog);
    mappingDialogDelete.addEventListener('click', deleteCurrentMapping);
    mappingAddCondition.addEventListener('click', addConditionRow);
    mappingAddColumnPair.addEventListener('click', () => addColumnPairRow());

    manageMappingsClose.addEventListener('click', closeManageMappingsDialog);
    manageMappingsCloseBtn.addEventListener('click', closeManageMappingsDialog);
    manageMappingsAdd.addEventListener('click', () => {
        closeManageMappingsDialog();
        openMappingDialog(null);
    });

    // -------- Single Record View Dialog --------
    const recordDialogOverlay = document.getElementById('recordDialogOverlay');
    const recordDialogClose = document.getElementById('recordDialogClose');
    const recordDialogCloseBtn = document.getElementById('recordDialogCloseBtn');
    const recordDialogPrev = document.getElementById('recordDialogPrev');
    const recordDialogNext = document.getElementById('recordDialogNext');
    const recordDialogBody = document.getElementById('recordDialogBody');
    const recordDialogIndex = document.getElementById('recordDialogIndex');
    const recordDialogTitle = document.getElementById('recordDialogTitle');
    const recordDialogStatus = document.getElementById('recordDialogStatus');

    // Index into allRows for the record currently shown (-1 = closed)
    let recordDialogRowIdx = -1;

    // Per-column textarea heights the user has dragged-to-resize. Kept while the
    // dialog stays open so a re-render (e.g. on blur) does not reset them.
    let recordTextareaHeights = {};

    function openRecordDialog(rowIdx) {
        if (rowIdx == null || rowIdx < 0 || !allRows[rowIdx]) return;
        recordDialogRowIdx = rowIdx;
        recordTextareaHeights = {};
        renderRecordDialog();
        recordDialogOverlay.style.display = 'flex';
    }

    function closeRecordDialog() {
        recordDialogOverlay.style.display = 'none';
        recordDialogRowIdx = -1;
        recordTextareaHeights = {};
    }

    function getDisplayedRowIndices() {
        // Returns array of original row indices in current display order
        if (Array.isArray(displayedRows) && displayedRows.length > 0) {
            return displayedRows.map(r => r._originalIndex);
        }
        return allRows.map((_, i) => i);
    }

    function navigateRecord(delta) {
        const order = getDisplayedRowIndices();
        const pos = order.indexOf(recordDialogRowIdx);
        if (pos < 0) return;
        const nextPos = pos + delta;
        if (nextPos < 0 || nextPos >= order.length) return;
        recordDialogRowIdx = order[nextPos];
        // Preserve the scroll position when paging through records so the
        // user stays at the same logical column instead of being yanked
        // back to the top each time.
        renderRecordDialog({ preserveScroll: true });
    }

    function renderRecordDialog(opts) {
        const preserveScroll = !!(opts && opts.preserveScroll);
        const savedScrollTop = preserveScroll ? recordDialogBody.scrollTop : 0;
        const idx = recordDialogRowIdx;
        if (idx < 0 || !allRows[idx]) { closeRecordDialog(); return; }

        const order = getDisplayedRowIndices();
        const pos = order.indexOf(idx);
        recordDialogIndex.textContent = (pos >= 0 ? (pos + 1) : '?') + ' / ' + order.length;
        recordDialogTitle.textContent = (schema && table) ? (schema + '.' + table) : '';
        recordDialogPrev.disabled = pos <= 0;
        recordDialogNext.disabled = pos < 0 || pos >= order.length - 1;

        const isDeleted = deletedRows.has(idx);
        const rowData = allRows[idx];

        // Remember any heights the user dragged before we replace the DOM.
        captureRecordTextareaHeights();

        recordDialogBody.innerHTML = buildRecordRowsHtml(idx, isDeleted, rowData);

        // Restore the scroll position captured at the start of this render.
        // We do this synchronously (innerHTML assignment is synchronous and
        // the body has a fixed height, so the scroll range is already valid).
        recordDialogBody.scrollTop = savedScrollTop;

        // Reapply user-resized heights so a re-render keeps the layout stable.
        applyRecordTextareaHeights();

        const parts = [];
        if (isDeleted) parts.push('row marked for deletion (read-only)');
        if (Array.from(modifiedCells.keys()).some(k => k.startsWith(idx + ':'))) {
            const count = Array.from(modifiedCells.keys()).filter(k => k.startsWith(idx + ':')).length;
            parts.push(count + ' field' + (count === 1 ? '' : 's') + ' modified');
        }
        recordDialogStatus.textContent = parts.join(' \u2014 ');

        wireRecordDialogListeners(idx);
    }

    // Build the per-field HTML for the record dialog body.
    function buildRecordRowsHtml(idx, isDeleted, rowData) {
        let html = '';

        columns.forEach(col => {
            const modKey = idx + ':' + col.name;
            const isModified = modifiedCells.has(modKey);
            const originalVal = rowData[col.name];
            const currentVal = isModified ? modifiedCells.get(modKey) : originalVal;
            const isNull = currentVal === null || currentVal === undefined;

            const isPk = primaryKeys.includes(col.name);
            const fk = foreignKeys.find(f => f.column === col.name);
            const defaultMapping = customMappings.find(m =>
                m.isDefault && m.sourceColumn === col.name && evaluateMappingConditions(m, rowData)
            );

            let labelBadges = '';
            if (isPk) labelBadges += '<span class="record-label-pk" title="Primary Key">PK</span>';
            if (fk) labelBadges += '<span class="record-label-fk" title="Foreign Key &rarr; ' + escapeAttr(fk.refSchema + '.' + fk.refTable + '.' + fk.refColumn) + '">FK</span>';

            const dataType = col.dataType || '';
            const filterType = getColumnFilterType(dataType);

            // Display value: numeric columns get thousand separator format
            let displayVal;
            if (isNull) {
                displayVal = '';
            } else if (filterType === 'numeric') {
                displayVal = formatNumberDisplay(currentVal, thousandSeparator);
            } else {
                displayVal = cellToString(currentVal);
            }

            const lineCount = isNull ? 1 : Math.min(15, Math.max(1, displayVal.split('\n').length));
            const charInfo = isNull ? '(NULL)' : (displayVal.length + ' chars');
            const budget = describeCharacterBudget(isNull ? '' : displayVal, col.fullType || col.dataType);
            const budgetHtml = budget
                ? '<span class="record-value-budget' + charBudgetStateClass(budget) + '">' + escapeHtml(budget.text) + '</span>'
                : '';

            const editableAttr = recordFieldReadonlyAttr(isDeleted, !isColumnEditable(col.name));
            const valueClass = 'record-value' + (isNull ? ' is-null' : '');
            const rowClass = 'record-row' + (isModified ? ' record-row-modified' : '');

            let actions = '';
            actions += '<button class="btn btn-sm btn-icon record-editor-btn"' +
                ' title="Open this value in an editor tab; saving there writes it back">' +
                icon('edit') + '</button>';
            if (defaultMapping && !isNull) {
                actions += '<button class="btn btn-sm record-fk-btn"' +
                    ' data-ref-schema="' + escapeAttr(defaultMapping.targetSchema) + '"' +
                    ' data-ref-table="' + escapeAttr(defaultMapping.targetTable) + '"' +
                    ' data-ref-column="' + escapeAttr(defaultMapping.targetColumn) + '"' +
                    ' data-value="' + escapeAttr(cellToString(currentVal)) + '"' +
                    ' title="' + escapeAttr(defaultMapping.label || (defaultMapping.targetSchema + '.' + defaultMapping.targetTable)) + '"' +
                    '>&#8599; Jump</button>';
            } else if (fk && !isNull) {
                actions += '<button class="btn btn-sm record-fk-btn"' +
                    ' data-ref-schema="' + escapeAttr(fk.refSchema) + '"' +
                    ' data-ref-table="' + escapeAttr(fk.refTable) + '"' +
                    ' data-ref-column="' + escapeAttr(fk.refColumn) + '"' +
                    ' data-value="' + escapeAttr(cellToString(currentVal)) + '"' +
                    ' title="Open ' + escapeAttr(fk.refSchema + '.' + fk.refTable) + '"' +
                    '>&#8599; Open</button>';
            }
            if (isModified) {
                actions += '<button class="btn btn-sm record-reset-btn" title="Reset to original">&#8634; Reset</button>';
            }

            html += '<div class="' + rowClass + '" data-col="' + escapeAttr(col.name) + '">' +
                '<div class="record-label">' + labelBadges + escapeHtml(col.name) +
                    '<span class="record-label-type">' + escapeHtml(dataType) + '</span>' +
                '</div>' +
                '<div class="record-value-wrapper">' +
                    '<textarea class="' + valueClass + '" rows="' + lineCount + '" ' + editableAttr +
                        ' placeholder="NULL">' + escapeHtml(displayVal) + '</textarea>' +
                    '<div class="record-value-meta">' +
                        '<span class="record-value-info">' + charInfo + (isModified ? ' &middot; modified' : '') + '</span>' +
                        budgetHtml +
                    '</div>' +
                '</div>' +
                '<div class="record-row-actions">' + actions + '</div>' +
            '</div>';
        });

        return html;
    }

    // Read the current textarea heights from the DOM into recordTextareaHeights,
    // keyed by column name, so a re-render can restore them.
    function captureRecordTextareaHeights() {
        recordDialogBody.querySelectorAll('.record-row').forEach(rowEl => {
            const colName = rowEl.getAttribute('data-col');
            const textarea = rowEl.querySelector('.record-value');
            if (textarea && textarea.style.height) {
                recordTextareaHeights[colName] = textarea.style.height;
            }
        });
    }

    // Reapply previously captured textarea heights after a re-render.
    function applyRecordTextareaHeights() {
        recordDialogBody.querySelectorAll('.record-row').forEach(rowEl => {
            const colName = rowEl.getAttribute('data-col');
            const saved = recordTextareaHeights[colName];
            const textarea = rowEl.querySelector('.record-value');
            if (textarea && saved) {
                textarea.style.height = saved;
            }
        });
    }

    // Wire textarea edit / reset / FK-jump listeners for the record dialog body.
    function wireRecordDialogListeners(idx) {
        recordDialogBody.querySelectorAll('.record-row').forEach(rowEl => {
            const colName = rowEl.getAttribute('data-col');
            const textarea = rowEl.querySelector('.record-value');
            if (!textarea) return;

            textarea.addEventListener('focus', () => {
                textarea.classList.remove('is-null');
            });

            textarea.addEventListener('input', () => {
                // Auto-grow as user types
                textarea.style.height = 'auto';
                textarea.style.height = Math.min(400, textarea.scrollHeight) + 'px';
                recordTextareaHeights[colName] = textarea.style.height;
                const colMeta = columns.find(c => c.name === colName);
                applyCharBudget(
                    rowEl.querySelector('.record-value-budget'),
                    colMeta ? describeCharacterBudget(textarea.value, colMeta.fullType || colMeta.dataType) : null
                );
            });

            // Persist a manual drag-resize so it survives the next re-render.
            textarea.addEventListener('mouseup', () => {
                if (textarea.style.height) recordTextareaHeights[colName] = textarea.style.height;
            });

            textarea.addEventListener('blur', () => {
                applyRecordEdit(idx, colName, textarea.value);
                // Re-render to refresh modified badges, reset buttons, displayed value
                renderRecordDialog({ preserveScroll: true });
                renderBody();
            });

            const resetBtn = rowEl.querySelector('.record-reset-btn');
            if (resetBtn) {
                resetBtn.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    modifiedCells.delete(idx + ':' + colName);
                    renderRecordDialog({ preserveScroll: true });
                    renderBody();
                    updateChangeIndicator();
                });
            }

            const fkBtn = rowEl.querySelector('.record-fk-btn');
            if (fkBtn) {
                fkBtn.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    vscode.postMessage({
                        command: 'openForeignKey',
                        refSchema: fkBtn.getAttribute('data-ref-schema'),
                        refTable: fkBtn.getAttribute('data-ref-table'),
                        refColumn: fkBtn.getAttribute('data-ref-column'),
                        value: fkBtn.getAttribute('data-value')
                    });
                });
            }

            const editorBtn = rowEl.querySelector('.record-editor-btn');
            if (editorBtn) {
                editorBtn.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    openCellInEditor(idx, colName);
                });
            }
        });
    }

    // Hand one cell value to the extension host, which opens it in an editor
    // tab. Saving that tab posts the value back as `cellEditorValue`.
    function openCellInEditor(rowIdx, colName) {
        if (rowIdx == null || rowIdx < 0 || !allRows[rowIdx]) return;
        const modKey = rowIdx + ':' + colName;
        const value = modifiedCells.has(modKey) ? modifiedCells.get(modKey) : allRows[rowIdx][colName];
        const colMeta = columns.find(c => c.name === colName);
        vscode.postMessage({
            command: 'openCellInEditor',
            rowIdx: rowIdx,
            column: colName,
            dataType: colMeta ? (colMeta.dataType || '') : '',
            value: cellToString(value),
            readOnly: !isColumnEditable(colName) || deletedRows.has(rowIdx)
        });
    }

    // A cell opened in an editor tab was saved: apply the text as a pending
    // change, exactly as if it had been typed into the cell.
    function handleCellEditorValue(msg) {
        const idx = Number(msg.rowIdx);
        const state = cellEditorTargetState(
            !!allRows[idx],
            columns.some(c => c.name === msg.column),
            isColumnEditable(msg.column) && !deletedRows.has(idx)
        );
        if (state === 'stale') {
            vscode.postMessage({
                command: 'showError',
                text: 'The edited cell is no longer part of the loaded result. Reload the data and open it again.'
            });
            return;
        }
        if (state === 'readonly') {
            vscode.postMessage({ command: 'showError', text: `Column "${msg.column}" cannot be edited here.` });
            return;
        }
        applyRecordEdit(idx, msg.column, msg.value);
        renderBody();
        if (recordDialogRowIdx === idx) {
            renderRecordDialog({ preserveScroll: true });
        }
    }

    // Mirrors handleCellEdit: writes to modifiedCells / clears it if equal to original
    function applyRecordEdit(rowIdx, colName, rawText) {
        if (!isColumnEditable(colName)) return;
        if (deletedRows.has(rowIdx)) return;
        const originalVal = allRows[rowIdx][colName];
        const colMeta = columns.find(c => c.name === colName);
        const isNumeric = !!colMeta && getColumnFilterType(colMeta.dataType) === 'numeric';
        const newValue = normalizeCellInput(rawText, isNumeric, thousandSeparator);

        // Empty -> NULL
        const finalValue = newValue === '' ? null : newValue;

        // Compare against original, accounting for stringification
        const originalStr = (originalVal === null || originalVal === undefined) ? null : cellToString(originalVal);
        const finalStr = finalValue === null ? null : String(finalValue);

        const modKey = rowIdx + ':' + colName;
        if (finalStr === originalStr) {
            modifiedCells.delete(modKey);
        } else {
            modifiedCells.set(modKey, finalValue);
        }
        updateChangeIndicator();
    }

    // Wire dialog buttons
    recordDialogClose.addEventListener('click', closeRecordDialog);
    recordDialogCloseBtn.addEventListener('click', closeRecordDialog);
    recordDialogPrev.addEventListener('click', () => navigateRecord(-1));
    recordDialogNext.addEventListener('click', () => navigateRecord(1));

    recordDialogOverlay.addEventListener('click', (e) => {
        if (e.target === recordDialogOverlay) closeRecordDialog();
    });

    document.addEventListener('keydown', (e) => {
        if (recordDialogOverlay.style.display !== 'flex') return;
        // Don't hijack typing inside the textareas
        const inField = document.activeElement && document.activeElement.tagName === 'TEXTAREA';
        if (e.key === 'Escape') { e.preventDefault(); closeRecordDialog(); return; }
        if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); navigateRecord(-1); return; }
        if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); navigateRecord(1); return; }
        if (!inField && e.key === 'ArrowLeft') { e.preventDefault(); navigateRecord(-1); return; }
        if (!inField && e.key === 'ArrowRight') { e.preventDefault(); navigateRecord(1); return; }
    });

    window.openRecordDialog = openRecordDialog;

    // Setup typeahead on target schema field
    setupTypeahead(mappingTargetSchema, (val) => {
        const schemas = getUniqueSchemas();
        return schemas
            .filter(s => s.toLowerCase().includes(val))
            .map(s => ({ value: s, label: s }));
    }, (selectedSchema) => {
        // When schema changes, clear table and column
        mappingTargetTable.value = '';
        mappingTargetColumn.value = '';
        typeaheadColumns = [];
    });

    // Setup typeahead on target table field
    setupTypeahead(mappingTargetTable, (val) => {
        const selectedSchema = mappingTargetSchema.value.trim().toLowerCase();
        return typeaheadTables
            .filter(t => {
                const matchesSchema = !selectedSchema || t.schema.toLowerCase() === selectedSchema;
                const matchesTable = t.table.toLowerCase().includes(val);
                return matchesSchema && matchesTable;
            })
            .map(t => ({
                value: t.table,
                label: selectedSchema ? t.table : `${t.schema}.${t.table}`
            }));
    }, (selectedTable) => {
        // Auto-fill schema if not set
        if (!mappingTargetSchema.value.trim()) {
            const match = typeaheadTables.find(t => t.table === selectedTable);
            if (match) {
                mappingTargetSchema.value = match.schema;
            }
        }
        // Request columns for the selected table
        const targetSchema = mappingTargetSchema.value.trim();
        requestColumnsForTypeahead(targetSchema, selectedTable);
    });

    // Setup typeahead on target column field
    setupTypeahead(mappingTargetColumn, (val) => {
        return typeaheadColumns
            .filter(c => c.toLowerCase().includes(val))
            .map(c => ({ value: c, label: c }));
    }, null);

    // When table input loses focus, also request columns
    mappingTargetTable.addEventListener('change', () => {
        const targetSchema = mappingTargetSchema.value.trim() || schema;
        const targetTable = mappingTargetTable.value.trim();
        if (targetTable) {
            requestColumnsForTypeahead(targetSchema, targetTable);
        }
    });

    function openMappingDialog(preselectedColumn, existingMapping) {
        editingMappingId = existingMapping ? existingMapping.id : null;
        mappingDialogTitle.textContent = existingMapping ? 'Edit Custom Column Mapping' : 'Create Custom Column Mapping';
        mappingDialogDelete.style.display = existingMapping ? 'inline-block' : 'none';

        // Populate source fields
        mappingSourceSchema.value = schema;
        mappingSourceTable.value = table;

        // Populate source column dropdown
        let colHtml = '';
        columns.forEach(col => {
            const selected = (existingMapping && existingMapping.sourceColumn === col.name) ||
                             (!existingMapping && col.name === preselectedColumn);
            colHtml += `<option value="${escapeAttr(col.name)}"${selected ? ' selected' : ''}>${escapeHtml(col.name)}</option>`;
        });
        mappingSourceColumn.innerHTML = colHtml;

        // Populate target fields
        mappingTargetSchema.value = existingMapping ? existingMapping.targetSchema : schema;
        mappingTargetTable.value = existingMapping ? existingMapping.targetTable : '';
        mappingTargetColumn.value = existingMapping ? existingMapping.targetColumn : '';
        mappingLabel.value = existingMapping ? (existingMapping.label || '') : '';
        mappingIsDefault.checked = existingMapping ? existingMapping.isDefault : true;
        if (mappingShareWorkspace) {
            mappingShareWorkspace.checked = existingMapping ? (existingMapping.scope === 'workspace') : false;
        }

        // Populate conditions
        mappingConditions.innerHTML = '';
        if (existingMapping && existingMapping.conditions && existingMapping.conditions.length > 0) {
            existingMapping.conditions.forEach(cond => {
                addConditionRow(null, cond);
            });
        }

        // Populate additional column matches (composite key)
        mappingColumnPairs.innerHTML = '';
        if (existingMapping && Array.isArray(existingMapping.additionalColumnPairs)) {
            existingMapping.additionalColumnPairs.forEach(pair => {
                addColumnPairRow(pair);
            });
        }

        // Request tables for typeahead
        requestTablesForTypeahead();

        // If existing mapping has a target table, load its columns
        if (existingMapping && existingMapping.targetSchema && existingMapping.targetTable) {
            requestColumnsForTypeahead(existingMapping.targetSchema, existingMapping.targetTable);
        } else {
            typeaheadColumns = [];
        }

        mappingDialogOverlay.style.display = 'flex';
    }

    function closeMappingDialog() {
        mappingDialogOverlay.style.display = 'none';
        editingMappingId = null;
    }

    function addConditionRow(e, existing) {
        const row = document.createElement('div');
        row.className = 'mapping-condition-row';

        // Column selector from current table columns
        let colOpts = '';
        columns.forEach(col => {
            const selected = existing && existing.column === col.name;
            colOpts += `<option value="${escapeAttr(col.name)}"${selected ? ' selected' : ''}>${escapeHtml(col.name)}</option>`;
        });

        const operatorVal = existing ? existing.operator : '=';
        const valueVal = existing ? existing.value : '';

        row.innerHTML = `
            <select class="condition-column">${colOpts}</select>
            <select class="condition-operator">
                <option value="="${operatorVal === '=' ? ' selected' : ''}>=</option>
                <option value="!="${operatorVal === '!=' ? ' selected' : ''}>!=</option>
                <option value=">"${operatorVal === '>' ? ' selected' : ''}>&gt;</option>
                <option value="<"${operatorVal === '<' ? ' selected' : ''}>&lt;</option>
                <option value=">="${operatorVal === '>=' ? ' selected' : ''}>&gt;=</option>
                <option value="<="${operatorVal === '<=' ? ' selected' : ''}>&lt;=</option>
                <option value="LIKE"${operatorVal === 'LIKE' ? ' selected' : ''}>LIKE</option>
                <option value="ILIKE"${operatorVal === 'ILIKE' ? ' selected' : ''}>ILIKE</option>
            </select>
            <input type="text" class="condition-value" placeholder="value" value="${escapeAttr(valueVal)}" />
            <button class="btn-remove-condition" title="Remove condition">&times;</button>
        `;

        row.querySelector('.btn-remove-condition').addEventListener('click', () => {
            row.remove();
        });

        mappingConditions.appendChild(row);
    }

    // Add a source-column/target-column equality row (composite-key match).
    // Reuses the same constraint-row style as the Build JOIN dialog.
    function addColumnPairRow(existing) {
        const row = document.createElement('div');
        row.className = 'mapping-condition-row';

        let colOpts = '';
        columns.forEach(col => {
            const selected = existing && existing.sourceColumn === col.name;
            colOpts += `<option value="${escapeAttr(col.name)}"${selected ? ' selected' : ''}>${escapeHtml(col.name)}</option>`;
        });

        const targetVal = existing ? existing.targetColumn : '';
        row.innerHTML = `
            <select class="pair-source-column">${colOpts}</select>
            <span class="pair-eq">=</span>
            <span class="typeahead-wrapper"><input type="text" class="pair-target-column" placeholder="target column" autocomplete="off" value="${escapeAttr(targetVal)}" /></span>
            <button class="btn-remove-condition" title="Remove column match">&times;</button>
        `;

        row.querySelector('.btn-remove-condition').addEventListener('click', () => {
            row.remove();
        });

        // Typeahead on the target column, fed by the selected target table's columns.
        const targetInput = row.querySelector('.pair-target-column');
        setupTypeahead(targetInput, (val) => {
            return typeaheadColumns
                .filter(c => c.toLowerCase().includes(val))
                .map(c => ({ value: c, label: c }));
        }, null);

        mappingColumnPairs.appendChild(row);
    }

    function gatherMappingFromDialog() {
        const conditions = [];
        mappingConditions.querySelectorAll('.mapping-condition-row').forEach(row => {
            const col = row.querySelector('.condition-column').value;
            const op = row.querySelector('.condition-operator').value;
            const val = row.querySelector('.condition-value').value;
            if (col && val !== '') {
                conditions.push({ column: col, operator: op, value: val });
            }
        });

        const additionalColumnPairs = [];
        mappingColumnPairs.querySelectorAll('.mapping-condition-row').forEach(row => {
            const sourceColumn = row.querySelector('.pair-source-column').value;
            const targetColumn = row.querySelector('.pair-target-column').value.trim();
            if (sourceColumn && targetColumn) {
                additionalColumnPairs.push({ sourceColumn, targetColumn });
            }
        });

        const mapping = {
            sourceSchema: mappingSourceSchema.value.trim(),
            sourceTable: mappingSourceTable.value.trim(),
            sourceColumn: mappingSourceColumn.value,
            targetSchema: mappingTargetSchema.value.trim(),
            targetTable: mappingTargetTable.value.trim(),
            targetColumn: mappingTargetColumn.value.trim(),
            conditions: conditions,
            isDefault: mappingIsDefault.checked,
            label: mappingLabel.value.trim() || undefined
        };
        if (additionalColumnPairs.length > 0) {
            mapping.additionalColumnPairs = additionalColumnPairs;
        }
        return mapping;
    }

    function saveMappingFromDialog() {
        const data = gatherMappingFromDialog();
        if (!data.targetTable || !data.targetColumn) {
            alert('Target table and column are required.');
            return;
        }
        if (!data.targetSchema) {
            data.targetSchema = 'public';
        }
        const scope = (mappingShareWorkspace && mappingShareWorkspace.checked) ? 'workspace' : 'global';
        if (editingMappingId) {
            data.scope = scope;
        }

        vscode.postMessage({
            command: editingMappingId ? 'updateCustomMapping' : 'addCustomMapping',
            mappingId: editingMappingId,
            scope: scope,
            mapping: data
        });
        closeMappingDialog();
    }

    function deleteCurrentMapping() {
        if (!editingMappingId) return;
        if (!confirm('Delete this custom mapping?')) return;
        vscode.postMessage({
            command: 'deleteCustomMapping',
            mappingId: editingMappingId
        });
        closeMappingDialog();
    }

    function openManageMappingsDialog() {
        renderMappingsList();
        manageMappingsOverlay.style.display = 'flex';
    }

    function closeManageMappingsDialog() {
        manageMappingsOverlay.style.display = 'none';
    }

    function renderMappingsList() {
        if (customMappings.length === 0) {
            mappingsList.innerHTML = '';
            noMappingsMsg.style.display = 'block';
            return;
        }
        noMappingsMsg.style.display = 'none';

        let html = '';
        customMappings.forEach(mapping => {
            const label = mapping.label || `${mapping.sourceColumn} → ${mapping.targetSchema}.${mapping.targetTable}.${mapping.targetColumn}`;
            const detail = `${mapping.sourceColumn} → ${mapping.targetSchema}.${mapping.targetTable}.${mapping.targetColumn}`;
            let badges = '';
            if (mapping.reversed) {
                badges += '<span class="mapping-badge mapping-badge-reverse" title="Synthesized from a mapping defined on the target table">Reverse</span>';
            }
            if (mapping.scope === 'workspace') {
                badges += '<span class="mapping-badge mapping-badge-workspace" title="Shared via the workspace mappings file (committed to git)">Workspace</span>';
            } else if (mapping.scope === 'global') {
                badges += '<span class="mapping-badge mapping-badge-personal" title="Personal mapping, stored in VS Code global state only">Personal</span>';
            }
            if (mapping.isDefault) {
                badges += '<span class="mapping-badge">Default</span>';
            }
            if (mapping.conditions && mapping.conditions.length > 0) {
                const condStr = mapping.conditions.map(c => `${c.column} ${c.operator} '${c.value}'`).join(', ');
                badges += `<span class="mapping-badge">IF ${condStr}</span>`;
            }
            if (Array.isArray(mapping.additionalColumnPairs) && mapping.additionalColumnPairs.length > 0) {
                const pairStr = mapping.additionalColumnPairs.map(p => `${p.sourceColumn} = ${p.targetColumn}`).join(' AND ');
                badges += `<span class="mapping-badge" title="Composite-key match: ${escapeAttr(pairStr)}">+${mapping.additionalColumnPairs.length} col</span>`;
            }
            const actions = mapping.reversed
                ? '<span class="mapping-item-note" title="Edit this mapping on the originating table">read-only</span>'
                : '<button class="btn btn-sm mapping-edit-btn">Edit</button>' +
                  '<button class="btn btn-danger btn-sm mapping-delete-btn">Delete</button>';
            html += `<div class="mapping-item${mapping.reversed ? ' mapping-item-reverse' : ''}" data-mapping-id="${escapeAttr(mapping.id)}">
                <div class="mapping-item-info">
                    <div class="mapping-item-label">${escapeHtml(label)}</div>
                    <div class="mapping-item-detail">${escapeHtml(detail)}</div>
                    ${badges ? '<div class="mapping-item-badges">' + badges + '</div>' : ''}
                </div>
                <div class="mapping-item-actions">
                    ${actions}
                </div>
            </div>`;
        });
        mappingsList.innerHTML = html;

        // Attach event listeners
        mappingsList.querySelectorAll('.mapping-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.closest('.mapping-item').getAttribute('data-mapping-id');
                const mapping = customMappings.find(m => m.id === id);
                if (mapping) {
                    closeManageMappingsDialog();
                    openMappingDialog(mapping.sourceColumn, mapping);
                }
            });
        });
        mappingsList.querySelectorAll('.mapping-delete-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.closest('.mapping-item').getAttribute('data-mapping-id');
                if (confirm('Delete this custom mapping?')) {
                    vscode.postMessage({ command: 'deleteCustomMapping', mappingId: id });
                }
            });
        });
    }
})();
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        cellToString,
        normalizeNumericInput,
        formatNumberDisplay,
        formatExactMatchValue,
        normalizeFilterInputValue,
        escapeSqlString,
        parseQueryPlaceholders,
        placeholderNames,
        renderParameterValue,
        applyQueryParameters,
        mergeQueryParameters,
        liveFormatNumeric,
        stripThousandSeparators,
        cellRangeToTsv,
        stripTrailingLimitOffset,
        parseSqlForWhere,
        findTopLevelKeywordIndex,
        splitWhereByAnd,
        whereClauseTargetsColumn,
        mergeWhereClauses,
        parseSqlForOrder,
        hasSqlComment,
        collapseSqlWhitespace,
        splitTopLevelCommas,
        splitTopLevelClauses,
        formatSql,
        filterOperatorForMode,
        buildFilterClause,
        buildNullConstraintClause,
        buildErrorDialogState,
        mappingConditionToClause,
        CONSTRAINT_OPERATORS,
        constraintIsUnary,
        constraintIsBetween,
        formatConstraintOperand,
        formatConstraintCondition,
        buildConstraintWhere,
        CONSTRAINT_SORT_DIRECTIONS,
        formatConstraintSort,
        buildConstraintOrderBy,
        buildSelectColumnList,
        buildColumnHeaderTitle,
        formatColumnTypeLabel,
        nextSortState,
        computeResizedRowHeight,
        computeResizedColumnWidth,
        cssStringLiteral,
        buildColumnWidthCss,
        remainingRowCount,
        formatExecutionTime,
        reorderColumns,
        reorderSelectColumns,
        isFreshRowLoad,
        recordFieldReadonlyAttr,
        cellEditorTargetState,
        buildConnectionBadge,
        canApplyQueryFilters,
        canManageTableMetadata,
        defaultInsertTableName,
        rowValueMatchesFilter,
        compareCellValues,
        normalizeCellInput,
        buildRowIdentity,
        emptyCapabilities,
        normalizeCapabilities,
        buildCommitTargets,
        describeRowCount,
        columnWriteMode,
        buildCommitWarnings,
        isSqlEdited,
        parsePgType,
        validateCellValue,
        describeCharacterBudget,
        charBudgetStateClass,
        classifyColumnDefault,
        defaultResetColumns,
        defaultCellTitle,
        describePendingChanges
    };
}
