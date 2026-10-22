import { isModifyingSql } from './modifyHistoryStore';
import { splitSqlStatements } from './sqlUtils';

/**
 * Auto refresh of the Data Viewer: the panel re-runs its last query every few
 * seconds. The timer lives in the webview; the host only asks for a custom
 * interval and refuses to re-run a statement that is not a plain read.
 */

export const AUTO_REFRESH_MIN_SECONDS = 1;
export const AUTO_REFRESH_MAX_SECONDS = 24 * 60 * 60;

const UNIT_SECONDS: Record<string, number> = {
    h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
    m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
    s: 1, sec: 1, secs: 1, second: 1, seconds: 1
};

/**
 * Read a duration typed by the user — `45`, `45s`, `2m`, `1h 30m`, `1 min 30 s`
 * or `1.5m` — as whole seconds. A bare number means seconds. Returns null for
 * anything else; the allowed range is checked by {@link autoRefreshIntervalError}.
 */
export function parseAutoRefreshInterval(text: string): number | null {
    const s = String(text ?? '').trim().toLowerCase();
    if (!s) return null;
    if (/^\d+(?:[.,]\d+)?$/.test(s)) return Math.round(Number(s.replace(',', '.')));
    const part = /\s*(\d+(?:[.,]\d+)?)\s*([a-z]+)\s*/y;
    let total = 0;
    let pos = 0;
    while (pos < s.length) {
        part.lastIndex = pos;
        const m = part.exec(s);
        if (!m) return null;
        const unit = UNIT_SECONDS[m[2]];
        if (unit === undefined) return null;
        total += Number(m[1].replace(',', '.')) * unit;
        pos = part.lastIndex;
    }
    return Math.round(total);
}

/** Validation message for the interval input box, or undefined when valid. */
export function autoRefreshIntervalError(text: string): string | undefined {
    const seconds = parseAutoRefreshInterval(text);
    if (seconds === null) return 'Enter a duration such as 45, 45s, 2m or 1h 30m.';
    if (seconds < AUTO_REFRESH_MIN_SECONDS) return 'The interval must be at least 1 second.';
    if (seconds > AUTO_REFRESH_MAX_SECONDS) return 'The interval can be at most 24 hours.';
    return undefined;
}

/**
 * Human-readable interval: `45 s`, `2 min`, `1 min 30 s`, `1 h`, `1 h 30 min`.
 * The same rule is duplicated in `src/webview/tableView.js`, which cannot import
 * from here; its output reads back through {@link parseAutoRefreshInterval}.
 */
export function formatAutoRefreshInterval(seconds: number): string {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const parts: string[] = [];
    if (h) parts.push(`${h} h`);
    if (m) parts.push(`${m} min`);
    if (s || parts.length === 0) parts.push(`${s} s`);
    return parts.join(' ');
}

/**
 * Blank out comments, string literals, dollar-quoted strings and quoted
 * identifiers, so a keyword inside them is not mistaken for SQL.
 */
function codeOnly(sql: string): string {
    let out = '';
    let i = 0;
    const n = sql.length;
    while (i < n) {
        const c = sql[i];
        const c2 = sql[i + 1];
        let end = -1;
        if (c === '-' && c2 === '-') {
            end = sql.indexOf('\n', i);
            if (end === -1) end = n;
        } else if (c === '/' && c2 === '*') {
            const close = sql.indexOf('*/', i + 2);
            end = close === -1 ? n : close + 2;
        } else if (c === "'" || c === '"') {
            let j = i + 1;
            while (j < n) {
                if (sql[j] === c) {
                    if (sql[j + 1] === c) { j += 2; continue; }
                    break;
                }
                j++;
            }
            end = Math.min(n, j + 1);
        } else if (c === '$') {
            const tag = /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/.exec(sql.slice(i));
            if (tag) {
                const close = sql.indexOf(tag[0], i + tag[0].length);
                end = close === -1 ? n : close + tag[0].length;
            }
        }
        if (end > i) {
            out += ' ';
            i = end;
        } else {
            out += c;
            i++;
        }
    }
    return out;
}

/**
 * Why `sql` must not be re-run automatically, or null when it is a plain read.
 * Auto refresh runs the statement again and again without asking, so anything
 * that writes data, changes the schema, advances a sequence, creates a table
 * (`SELECT … INTO`), takes row locks (`FOR UPDATE`) or takes an explicit lock
 * (`LOCK TABLE`, `pg_advisory_lock()`) is refused. A function called by the
 * query may still have side effects; that cannot be seen here.
 */
export function autoRefreshRefusal(sql: string): string | null {
    const statements = splitSqlStatements(String(sql ?? '')).map((s) => s.trim()).filter((s) => s.length > 0);
    for (const stmt of statements) {
        const code = codeOnly(stmt).toLowerCase();
        // Checked first: `LOCK` is not a write, but repeating it can block other
        // sessions, and a session-level advisory lock piles up on every run.
        if (/^\s*lock\b/.test(code) || /\bpg_(try_)?advisory_(xact_)?lock(_shared)?\s*\(/.test(code)) {
            return 'The query takes an explicit lock (LOCK TABLE / advisory lock), so it is not re-run automatically.';
        }
        if (isModifyingSql(stmt)
            || /\b(insert\s+into|delete\s+from|merge\s+into|update\s+(only\s+)?[\w".]+(\s+(as\s+)?[\w"]+)?\s+set)\b/.test(code)
            || /\b(nextval|setval)\s*\(/.test(code)
            || (/^\s*(select|with|table|values)\b/.test(code) && /\binto\b/.test(code))) {
            return 'The query changes data, so it is not re-run automatically.';
        }
        if (/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/.test(code)) {
            return 'The query locks rows (FOR UPDATE / FOR SHARE), so it is not re-run automatically.';
        }
    }
    return null;
}

/**
 * Why `sql` must not be run for a Data Viewer export, or null when it is a
 * single plain read. An export runs the query once more without showing it, so
 * it must never write, lock or run several statements.
 */
export function exportQueryRefusal(sql: string): string | null {
    const statements = splitSqlStatements(String(sql ?? '')).map((s) => s.trim()).filter((s) => s.length > 0);
    if (statements.length === 0) return 'There is no query to export.';
    if (statements.length > 1) return 'The query holds several statements; only a single SELECT can be exported.';
    if (!/^\s*(select|with|table|values)\b/.test(codeOnly(statements[0]).toLowerCase())) {
        return 'Only a SELECT query can be exported.';
    }
    if (autoRefreshRefusal(statements[0])) {
        return 'The query changes data or takes a lock, so it is not run for an export.';
    }
    return null;
}
