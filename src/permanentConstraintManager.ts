import * as vscode from 'vscode';

/** One operand of a permanent constraint condition. */
export interface ConstraintOperand {
    /** `column` references a column of the table; `raw` is a free value/expression. */
    kind: 'column' | 'raw';
    /** Column name when `kind === 'column'`. */
    column?: string;
    /** Verbatim value/expression when `kind === 'raw'`. */
    text?: string;
}

/**
 * A single permanent constraint, using the same operand/operator model as the
 * "+ Add fixed condition" feature of the Build JOIN dialog.
 */
export interface ConstraintCondition {
    operator: string;
    left: ConstraintOperand;
    right?: ConstraintOperand;
    right2?: ConstraintOperand;
}

/** One entry of a permanent ORDER BY clause. */
export interface ConstraintSort {
    column: string;
    direction: 'ASC' | 'DESC';
}

/**
 * Persists per-table permanent WHERE constraints and ORDER BY entries in the
 * extension's global state. When a table is opened in the Data View, its stored
 * constraints and sorts are automatically applied to the default query.
 */
export class PermanentConstraintManager {
    private static readonly STORAGE_KEY = 'permanentConstraints';
    private static readonly SORT_STORAGE_KEY = 'permanentSorts';
    private readonly context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    private static key(schema: string, table: string): string {
        return `${schema}.${table}`;
    }

    private getStore(): Record<string, ConstraintCondition[]> {
        return this.context.globalState.get<Record<string, ConstraintCondition[]>>(
            PermanentConstraintManager.STORAGE_KEY, {}
        );
    }

    /** Return the stored constraints for a table (empty array when none). */
    getConstraints(schema: string, table: string): ConstraintCondition[] {
        const store = this.getStore();
        const list = store[PermanentConstraintManager.key(schema, table)];
        return Array.isArray(list) ? list : [];
    }

    /** Replace the constraints for a table. An empty list removes the entry. */
    async setConstraints(schema: string, table: string, conditions: ConstraintCondition[]): Promise<void> {
        const store = { ...this.getStore() };
        const key = PermanentConstraintManager.key(schema, table);
        const sanitized = normalizeConstraints(conditions);
        if (sanitized.length === 0) {
            delete store[key];
        } else {
            store[key] = sanitized;
        }
        await this.context.globalState.update(PermanentConstraintManager.STORAGE_KEY, store);
    }

    private getSortStore(): Record<string, ConstraintSort[]> {
        return this.context.globalState.get<Record<string, ConstraintSort[]>>(
            PermanentConstraintManager.SORT_STORAGE_KEY, {}
        );
    }

    /** Return the stored sort entries for a table (empty array when none). */
    getSorts(schema: string, table: string): ConstraintSort[] {
        const store = this.getSortStore();
        const list = store[PermanentConstraintManager.key(schema, table)];
        return Array.isArray(list) ? list : [];
    }

    /** Replace the sort entries for a table. An empty list removes the entry. */
    async setSorts(schema: string, table: string, sorts: ConstraintSort[]): Promise<void> {
        const store = { ...this.getSortStore() };
        const key = PermanentConstraintManager.key(schema, table);
        const sanitized = normalizeSorts(sorts);
        if (sanitized.length === 0) {
            delete store[key];
        } else {
            store[key] = sanitized;
        }
        await this.context.globalState.update(PermanentConstraintManager.SORT_STORAGE_KEY, store);
    }
}

/** Keep only sort entries with a column name; default the direction to ASC. */
export function normalizeSorts(sorts: unknown): ConstraintSort[] {
    if (!Array.isArray(sorts)) {
        return [];
    }
    const result: ConstraintSort[] = [];
    for (const s of sorts) {
        const column = typeof s?.column === 'string' ? s.column.trim() : '';
        if (!column) {
            continue;
        }
        const direction = String(s?.direction || '').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
        result.push({ column, direction });
    }
    return result;
}

/** Keep only well-formed operands/conditions, dropping incomplete entries. */
export function normalizeConstraints(conditions: unknown): ConstraintCondition[] {
    if (!Array.isArray(conditions)) {
        return [];
    }
    const result: ConstraintCondition[] = [];
    for (const c of conditions) {
        const operator = typeof c?.operator === 'string' ? c.operator : '';
        const left = normalizeOperand(c?.left);
        if (!operator || !left) {
            continue;
        }
        const cond: ConstraintCondition = { operator, left };
        const right = normalizeOperand(c?.right);
        if (right) {
            cond.right = right;
        }
        const right2 = normalizeOperand(c?.right2);
        if (right2) {
            cond.right2 = right2;
        }
        result.push(cond);
    }
    return result;
}

function normalizeOperand(op: unknown): ConstraintOperand | undefined {
    if (!op || typeof op !== 'object') {
        return undefined;
    }
    const o = op as Record<string, unknown>;
    if (o.kind === 'column' && typeof o.column === 'string' && o.column.trim()) {
        return { kind: 'column', column: o.column };
    }
    if (o.kind === 'raw' && typeof o.text === 'string') {
        return { kind: 'raw', text: o.text };
    }
    return undefined;
}
