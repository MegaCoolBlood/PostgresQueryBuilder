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

export { splitSqlStatements } from './sqlUtils';
