/**
 * Wrap a value as a single-quoted SQL string literal, escaping any embedded
 * single quotes by doubling them (PostgreSQL's standard escaping).
 *
 * This is the security-sensitive core used when interpolating string values
 * into generated SQL. Keep all such escaping routed through this one helper so
 * the escaping rule lives in a single, tested place.
 */
export function escapeSqlLiteral(value: string): string {
    return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * The PostgreSQL text form of a value the `pg` driver returned, as used by the
 * text-based exports (CSV, XML, INSERT) and by generated SQL. `String()` would
 * corrupt the parsed types: a json/jsonb object becomes `[object Object]`, an
 * array `1,2,3` and a Date a local-time string without microseconds. Returns
 * `null` for SQL NULL so each caller can render it in its own way.
 *
 * - plain objects (json/jsonb) → JSON text
 * - arrays → a PostgreSQL array literal (see {@link formatPgArrayLiteral})
 * - Date → ISO 8601 text in UTC
 * - Buffer/Uint8Array (bytea) → `\x` followed by lower-case hex
 */
export function pgValueToText(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
    if (value instanceof Date) return isNaN(value.getTime()) ? String(value) : value.toISOString();
    if (value instanceof Uint8Array) return '\\x' + Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex');
    if (Array.isArray(value)) return formatPgArrayLiteral(value);
    // Driver objects that know their own PostgreSQL text form (e.g. an interval).
    const toPostgres = (value as { toPostgres?: unknown }).toPostgres;
    if (typeof toPostgres === 'function') return String(toPostgres.call(value));
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
}

/** The lower-case type name, accepting `pg_type.typname` and SQL spellings. */
function normalizedTypeName(dataType: string | undefined): string {
    return String(dataType ?? '').trim().toLowerCase();
}

/** Whether a column type (`json`, `jsonb`) holds JSON documents. */
export function isJsonColumnType(dataType: string | undefined): boolean {
    const t = normalizedTypeName(dataType);
    return t === 'json' || t === 'jsonb';
}

/** Whether a column type is an array of JSON documents (`_jsonb`, `jsonb[]`). */
export function isJsonArrayColumnType(dataType: string | undefined): boolean {
    const t = normalizedTypeName(dataType);
    return t === '_json' || t === '_jsonb' || t === 'json[]' || t === 'jsonb[]';
}

/**
 * {@link pgValueToText} for a value of a known column type. The driver parses
 * json/jsonb into plain JS values, so without the type a JSON array would
 * read as a PostgreSQL array (`{a,b}`) and a JSON string `"abc"` as bare
 * `abc`; for json columns every value is therefore written as JSON text.
 */
export function pgColumnValueToText(value: unknown, dataType: string | undefined): string | null {
    if (value === null || value === undefined) return null;
    if (isJsonColumnType(dataType)) return JSON.stringify(value) ?? null;
    if (isJsonArrayColumnType(dataType) && Array.isArray(value)) {
        return formatPgArrayLiteral(value.map((element) => (element === null || element === undefined ? null : JSON.stringify(element))));
    }
    return pgValueToText(value);
}

/**
 * Render an array as a PostgreSQL array literal (`{1,2,"a b",NULL,{3,4}}`).
 * Nested arrays become sub-arrays, null elements become `NULL`, and an element
 * is double-quoted (with `"` and `\` backslash-escaped) when it is empty, the
 * word NULL, or contains a brace, quote, comma, backslash or whitespace.
 */
export function formatPgArrayLiteral(values: ReadonlyArray<unknown>): string {
    const parts = values.map((element) => {
        if (element === null || element === undefined) return 'NULL';
        if (Array.isArray(element)) return formatPgArrayLiteral(element);
        const text = pgValueToText(element) ?? '';
        if (text === '' || /^null$/i.test(text) || /[{}",\\\s]/.test(text)) {
            return '"' + text.replace(/[\\"]/g, (ch) => '\\' + ch) + '"';
        }
        return text;
    });
    return '{' + parts.join(',') + '}';
}

/** Splits a SQL script into individual statements on top-level semicolons. */
export function splitSqlStatements(script: string): string[] {
    const out: string[] = [];
    let buf = '';
    let inStr = false;
    let strCh = '';
    let inLineComment = false;
    let inBlockComment = false;
    let i = 0;
    while (i < script.length) {
        const ch = script[i];
        const next = script[i + 1];
        if (inLineComment) {
            buf += ch;
            if (ch === '\n') inLineComment = false;
            i++;
            continue;
        }
        if (inBlockComment) {
            buf += ch;
            if (ch === '*' && next === '/') { buf += next; inBlockComment = false; i += 2; continue; }
            i++;
            continue;
        }
        if (inStr) {
            buf += ch;
            if (ch === strCh) {
                if (strCh === "'" && next === "'") { buf += next; i += 2; continue; }
                inStr = false;
            }
            i++;
            continue;
        }
        if (ch === '-' && next === '-') { inLineComment = true; buf += ch; i++; continue; }
        if (ch === '/' && next === '*') { inBlockComment = true; buf += ch; i++; continue; }
        if (ch === "'" || ch === '"') { inStr = true; strCh = ch; buf += ch; i++; continue; }
        if (ch === ';') {
            const stmt = buf.trim();
            if (stmt) out.push(stmt);
            buf = '';
            i++;
            continue;
        }
        buf += ch;
        i++;
    }
    const last = buf.trim();
    if (last) out.push(last);
    return out;
}
