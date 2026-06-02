import * as vscode from 'vscode';

export interface ModifyHistoryEntry {
    sql: string;
    schema?: string;
    table?: string;
    timestamp: number;
}

const STORAGE_KEY = 'modifyStatementHistory';
const MAX_ENTRIES = 500;

export class ModifyHistoryStore {
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    constructor(private context: vscode.ExtensionContext) {}

    getAll(): ModifyHistoryEntry[] {
        return this.context.globalState.get<ModifyHistoryEntry[]>(STORAGE_KEY, []);
    }

    add(entry: Omit<ModifyHistoryEntry, 'timestamp'> | ModifyHistoryEntry): void {
        const sql = (entry.sql || '').trim();
        if (!sql) return;
        const full: ModifyHistoryEntry = {
            sql,
            schema: entry.schema,
            table: entry.table,
            timestamp: 'timestamp' in entry && entry.timestamp ? entry.timestamp : Date.now()
        };
        const history = this.getAll();
        history.unshift(full);
        if (history.length > MAX_ENTRIES) history.length = MAX_ENTRIES;
        this.context.globalState.update(STORAGE_KEY, history);
        this._onDidChange.fire();
    }

    addMany(entries: Array<Omit<ModifyHistoryEntry, 'timestamp'>>): void {
        if (!entries || entries.length === 0) return;
        const now = Date.now();
        const history = this.getAll();
        for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i];
            const sql = (e.sql || '').trim();
            if (!sql) continue;
            history.unshift({ sql, schema: e.schema, table: e.table, timestamp: now });
        }
        if (history.length > MAX_ENTRIES) history.length = MAX_ENTRIES;
        this.context.globalState.update(STORAGE_KEY, history);
        this._onDidChange.fire();
    }

    clear(): void {
        this.context.globalState.update(STORAGE_KEY, []);
        this._onDidChange.fire();
    }
}

const MODIFYING_KEYWORDS = new Set([
    'insert', 'update', 'delete', 'merge', 'truncate',
    'create', 'drop', 'alter', 'grant', 'revoke',
    'comment', 'refresh', 'call'
]);

/** Returns true if the SQL begins with a data/structure-modifying statement. */
export function isModifyingSql(sql: string): boolean {
    if (!sql) return false;
    // Strip leading whitespace, line comments, and block comments
    let s = sql;
    let changed = true;
    while (changed) {
        changed = false;
        const trimmed = s.replace(/^\s+/, '');
        if (trimmed !== s) { s = trimmed; changed = true; }
        if (s.startsWith('--')) {
            const nl = s.indexOf('\n');
            s = nl === -1 ? '' : s.substring(nl + 1);
            changed = true;
        } else if (s.startsWith('/*')) {
            const end = s.indexOf('*/');
            s = end === -1 ? '' : s.substring(end + 2);
            changed = true;
        }
    }
    const m = s.match(/^([a-zA-Z]+)/);
    if (!m) return false;
    return MODIFYING_KEYWORDS.has(m[1].toLowerCase());
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
