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
