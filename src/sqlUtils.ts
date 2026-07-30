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
