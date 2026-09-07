/**
 * Resolve where the columns of a query result come from and what can be done
 * with them.
 *
 * PostgreSQL reports the source relation (`tableID`) and column (`columnID`)
 * for every result field that maps 1:1 onto a table column — even through
 * aliases, joins and sub-selects. That makes it possible to offer editing,
 * relation metadata and navigation for an ad-hoc `SELECT` result just like for
 * a table opened from the tree, instead of deciding by how the view was opened.
 */

/** Minimal shape of a `pg` field descriptor used to resolve a result column. */
export interface ResultFieldInfo {
    name: string;
    dataTypeID: number;
    tableID?: number;
    columnID?: number;
}

/** A relation resolved from `pg_class`/`pg_namespace`, keyed by its OID. */
export interface RelationInfo {
    schema: string;
    table: string;
    /** `pg_class.relkind`, e.g. `'r'` for an ordinary table. */
    relkind?: string;
}

/**
 * Relation kinds rows can be written back to: ordinary tables, partitioned
 * tables and foreign tables. Views and materialized views are shown read-only
 * because an UPDATE against them is not generally supported.
 */
export const WRITABLE_RELKINDS = ['r', 'p', 'f'] as const;

export function isWritableRelkind(relkind: string | undefined): boolean {
    return !relkind || (WRITABLE_RELKINDS as ReadonlyArray<string>).includes(relkind);
}

/** The table column a result column originates from. */
export interface ColumnSource {
    /** Result column name — may be an alias. */
    name: string;
    tableOid: number;
    schema: string;
    table: string;
    /** Real column name in the source table. */
    sourceColumn: string;
    /**
     * Table alias this column is selected through. Set only when the query
     * joins the same table in more than once.
     */
    qualifier?: string;
}

/**
 * Key of the table occurrence a column belongs to. Two joins of the same table
 * are two different rows, so they must not share one identity.
 */
export function sourceInstanceKey(source: { tableOid: number; qualifier?: string }): string {
    return source.qualifier ? `${source.tableOid}:${source.qualifier}` : String(source.tableOid);
}

/**
 * Mark the columns of a table the query uses under several aliases with the
 * alias they come from. PostgreSQL reports only the relation of a field, never
 * the alias, so without this both occurrences would be treated as one row.
 * Columns whose alias cannot be recognised leave their table untouched.
 */
export function splitAliasedSources(
    sources: ReadonlyArray<ColumnSource | null>,
    qualifiers: ReadonlyMap<string, string>
): Array<ColumnSource | null> {
    const perTable = new Map<number, Set<string>>();
    for (const source of sources) {
        if (!source) {
            continue;
        }
        const seen = perTable.get(source.tableOid) ?? new Set<string>();
        seen.add(qualifiers.get(source.name) ?? '');
        perTable.set(source.tableOid, seen);
    }
    return sources.map((source) => {
        if (!source) {
            return source;
        }
        const seen = perTable.get(source.tableOid);
        const qualifier = qualifiers.get(source.name);
        if (!qualifier || !seen || seen.size < 2 || seen.has('')) {
            return source;
        }
        return { ...source, qualifier };
    });
}

/**
 * How a displayed row can be matched back to its database row:
 * - `pk`   — the result carries every primary-key column: exact match.
 * - `row`  — matched by all displayed columns of that table; may be ambiguous,
 *            so a commit must verify that each statement hits exactly one row.
 * - `none` — no column of that table is in the result: not editable.
 */
export type IdentityStrategy = 'pk' | 'row' | 'none';

/** What can be written back to one source table of the current result. */
export interface TableEditPlan {
    tableOid: number;
    schema: string;
    table: string;
    /** Alias of this occurrence, when the table is joined in several times. */
    qualifier?: string;
    identityStrategy: IdentityStrategy;
    /** Columns forming the WHERE clause that identifies a row. */
    identityColumns: ColumnSource[];
    /** Every result column that belongs to this table. */
    columns: ColumnSource[];
    /** Primary-key columns the result does not expose, if any. */
    missingKeyColumns: string[];
}

/** What the Data Viewer may offer for the current result. */
export interface ViewCapabilities {
    canEdit: boolean;
    canInsert: boolean;
    canDelete: boolean;
    canConstrain: boolean;
    canMap: boolean;
    /** The single source table, or null when the result spans several/none. */
    schema: string | null;
    table: string | null;
    identityStrategy: IdentityStrategy;
    /** Every source table the result columns belong to. */
    tables: TableEditPlan[];
    /** Result column name -> its source, for columns that have one. */
    columnSources: Record<string, ColumnSource>;
    /** Result column names that can be edited. */
    editableColumns: string[];
    warning: string | null;
}

/** Key used for the `pg_attribute` lookup map: `<relation oid>:<attnum>`. */
export function attributeKey(tableOid: number, attnum: number): string {
    return `${tableOid}:${attnum}`;
}

/**
 * Map every result field to its source table column, or to `null` for computed
 * columns, literals and aggregates (which PostgreSQL reports with a zero
 * `tableID`/`columnID`).
 */
export function resolveFieldSources(
    fields: ReadonlyArray<ResultFieldInfo>,
    relations: Record<number, RelationInfo>,
    attributes: Record<string, string>
): Array<ColumnSource | null> {
    return fields.map((field) => {
        const tableOid = field.tableID;
        const attnum = field.columnID;
        if (!tableOid || !attnum || attnum <= 0) {
            return null;
        }
        const relation = relations[tableOid];
        const sourceColumn = attributes[attributeKey(tableOid, attnum)];
        if (!relation || !sourceColumn) {
            return null;
        }
        return {
            name: field.name,
            tableOid,
            schema: relation.schema,
            table: relation.table,
            sourceColumn
        };
    });
}

/**
 * Pick the identity strategy for one source table: the primary key when the
 * result exposes all of its columns, otherwise every displayed column of that
 * table.
 */
export function chooseIdentity(
    primaryKeys: ReadonlyArray<string>,
    columns: ReadonlyArray<ColumnSource>
): { strategy: IdentityStrategy; identityColumns: ColumnSource[] } {
    if (columns.length === 0) {
        return { strategy: 'none', identityColumns: [] };
    }
    if (primaryKeys.length > 0) {
        const pkColumns: ColumnSource[] = [];
        for (const pk of primaryKeys) {
            const match = columns.find((c) => c.sourceColumn === pk);
            if (!match) {
                pkColumns.length = 0;
                break;
            }
            pkColumns.push(match);
        }
        if (pkColumns.length === primaryKeys.length) {
            return { strategy: 'pk', identityColumns: pkColumns };
        }
    }
    // Duplicate source columns (`SELECT id, id AS id2`) would repeat the same
    // condition, so identify by each distinct source column once.
    const seen = new Set<string>();
    const identityColumns = columns.filter((c) => {
        if (seen.has(c.sourceColumn)) {
            return false;
        }
        seen.add(c.sourceColumn);
        return true;
    });
    return { strategy: 'row', identityColumns };
}

/** Names of the given tables, each one only once even if it is joined twice. */
function tableNames(tables: ReadonlyArray<TableEditPlan>): string {
    return [...new Set(tables.map((t) => `${t.schema}.${t.table}`))].join(', ');
}

/** Human-readable reason shown in the Data Viewer when editing is limited. */
export function identityWarning(tables: ReadonlyArray<TableEditPlan>): string | null {
    if (tables.length === 0) {
        return 'This result is not editable: none of its columns could be traced back to a table column.';
    }
    if (tables.every((t) => t.identityStrategy === 'none')) {
        const names = tableNames(tables);
        return `This result is not editable: rows of ${names} cannot be identified or written back.`;
    }
    const weak = tables.filter((t) => t.identityStrategy === 'row');
    if (weak.length === 0) {
        return null;
    }
    const names = tableNames(weak);
    return `No primary key available for ${names}. Rows are matched by all of their displayed values — `
        + 'a change is rejected if it would not affect exactly one row. '
        + 'Add the key columns to the query to edit safely.';
}

/**
 * Source column -> the result columns that expose it. Relation metadata is
 * keyed by the real column names, the grid by the names of the result, which
 * differ as soon as a query aliases a column.
 */
export function resultColumnAliases(plan: TableEditPlan): Map<string, string[]> {
    const aliases = new Map<string, string[]>();
    for (const column of plan.columns) {
        const names = aliases.get(column.sourceColumn);
        if (names) {
            names.push(column.name);
        } else {
            aliases.set(column.sourceColumn, [column.name]);
        }
    }
    return aliases;
}

/**
 * Derive the per-table write plan and the resulting view capabilities from the
 * resolved column sources.
 */
export function buildEditPlan(
    sources: ReadonlyArray<ColumnSource | null>,
    primaryKeys: Record<number, ReadonlyArray<string>>,
    readOnlyTables?: ReadonlySet<number>
): ViewCapabilities {
    const byTable = new Map<string, ColumnSource[]>();
    for (const source of sources) {
        if (!source) {
            continue;
        }
        const list = byTable.get(sourceInstanceKey(source));
        if (list) {
            list.push(source);
        } else {
            byTable.set(sourceInstanceKey(source), [source]);
        }
    }

    const tables: TableEditPlan[] = [];
    for (const columns of byTable.values()) {
        const tableOid = columns[0].tableOid;
        const readOnly = !!readOnlyTables?.has(tableOid);
        const keys = primaryKeys[tableOid] || [];
        const { strategy, identityColumns } = readOnly
            ? { strategy: 'none' as IdentityStrategy, identityColumns: [] }
            : chooseIdentity(keys, columns);
        tables.push({
            tableOid,
            schema: columns[0].schema,
            table: columns[0].table,
            qualifier: columns[0].qualifier,
            identityStrategy: strategy,
            identityColumns,
            columns,
            missingKeyColumns: strategy === 'row'
                ? keys.filter((pk) => !columns.some((c) => c.sourceColumn === pk))
                : []
        });
    }

    const editableTables = tables.filter((t) => t.identityStrategy !== 'none');
    const single = tables.length === 1 ? tables[0] : null;
    const columnSources: Record<string, ColumnSource> = {};
    const editableColumns: string[] = [];
    for (const source of sources) {
        if (!source) {
            continue;
        }
        columnSources[source.name] = source;
        const plan = tables.find((t) => sourceInstanceKey(t) === sourceInstanceKey(source));
        if (plan && plan.identityStrategy !== 'none') {
            editableColumns.push(source.name);
        }
    }

    return {
        canEdit: editableTables.length > 0,
        canInsert: !!single && single.identityStrategy !== 'none',
        canDelete: !!single && single.identityStrategy !== 'none',
        canConstrain: !!single,
        canMap: !!single,
        schema: single ? single.schema : null,
        table: single ? single.table : null,
        identityStrategy: tables.some((t) => t.identityStrategy === 'row')
            ? 'row'
            : (editableTables.length > 0 ? 'pk' : 'none'),
        tables,
        columnSources,
        editableColumns,
        warning: identityWarning(tables)
    };
}
