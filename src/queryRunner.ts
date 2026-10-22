import { ConnectionManager } from './connectionManager';
import { Logger, getErrorMessage } from './logger';
import { escapeSqlLiteral, pgValueToText, splitSqlStatements } from './sqlUtils';
import { POSTGRES_RESERVED_KEYWORDS } from './reservedKeywords';
import {
    attributeKey,
    buildEditPlan,
    disambiguateColumnNames,
    hasEqualityOperator,
    isWritableRelkind,
    SPECIAL_TYPE_NAMES_BY_OID,
    resolveFieldSources,
    splitAliasedSources,
    type IdentityStrategy,
    type RelationInfo,
    type ResultFieldInfo,
    type ViewCapabilities
} from './resultSource';
import { resultColumnQualifiers, selectListQualifiers } from './hiddenKeyColumns';
import type { QueryResultRow, FieldDef } from 'pg';
import type { QueryExecutor, QueryFn } from './dbSession';

/**
 * Table types from `information_schema.tables` that the extension treats as
 * selectable relations shown in the table tree. PostgreSQL reports foreign
 * tables as `'FOREIGN'` (server versions >= 9.5) or `'FOREIGN TABLE'` (versions
 * < 9.5), so both spellings are accepted to make sure foreign tables always
 * show up. Regular views (`'VIEW'`) are included as well so they appear in the
 * tree alongside ordinary tables.
 */
export const SELECTABLE_TABLE_TYPES = ['BASE TABLE', 'FOREIGN', 'FOREIGN TABLE', 'VIEW'] as const;

/**
 * SQL value list for `SELECTABLE_TABLE_TYPES`, ready to be inlined into an
 * `table_type IN (...)` clause, e.g. `'BASE TABLE', 'FOREIGN', 'FOREIGN TABLE', 'VIEW'`.
 */
export const SELECTABLE_TABLE_TYPES_SQL = SELECTABLE_TABLE_TYPES.map(t => `'${t}'`).join(', ');

/** Schemas that should never appear in the table tree / pickers. */
const SYSTEM_SCHEMAS_SQL = `'pg_catalog', 'information_schema', 'pg_toast'`;

/**
 * The result fields with a name that is unique within the result. A name
 * PostgreSQL reports twice (`SELECT a.x, b.x`) is qualified with the alias the
 * column is selected through, read from the select list of `sql`. Every other
 * field is returned unchanged, so a result without duplicates is untouched.
 */
export function uniqueFieldNames<T extends { name: string }>(fields: ReadonlyArray<T>, sql?: string): T[] {
    const names = disambiguateColumnNames(
        fields.map((f) => f.name),
        sql ? selectListQualifiers(sql) : null
    );
    return fields.map((field, index) => (
        names[index] === field.name ? field : { ...field, name: names[index] }
    ));
}

/**
 * Build a query that lists all selectable relations as `(table_schema,
 * table_name, rel_kind)` across all non-system schemas.
 *
 * `rel_kind` is one of `'table'`, `'view'`, `'foreign'` or `'matview'` so
 * callers can group relations by type.
 *
 * In addition to the relations reported by `information_schema.tables` (tables,
 * foreign tables and regular views) it also includes **materialized views**,
 * which PostgreSQL does NOT expose through `information_schema` — they are read
 * from `pg_matviews` and merged in via `UNION`.
 */
export function buildRelationListQuery(): string {
    return `SELECT table_schema, table_name, rel_kind FROM (
                SELECT table_schema, table_name,
                       CASE table_type
                           WHEN 'BASE TABLE' THEN 'table'
                           WHEN 'VIEW' THEN 'view'
                           ELSE 'foreign'
                       END AS rel_kind
                FROM information_schema.tables
                WHERE table_type IN (${SELECTABLE_TABLE_TYPES_SQL})
                UNION
                SELECT schemaname AS table_schema, matviewname AS table_name, 'matview' AS rel_kind
                FROM pg_matviews
            ) rels
            WHERE table_schema NOT IN (${SYSTEM_SCHEMAS_SQL})
            ORDER BY table_schema, table_name`;
}

/**
 * Build a query that lists the selectable relations within a single schema
 * (bound to parameter `$1`) as `(table_name, rel_kind)`. Like
 * {@link buildRelationListQuery} it also includes materialized views from
 * `pg_matviews` and tags each relation with its `rel_kind`.
 */
export function buildSchemaRelationListQuery(): string {
    return `SELECT table_name, rel_kind FROM (
                SELECT table_name,
                       CASE table_type
                           WHEN 'BASE TABLE' THEN 'table'
                           WHEN 'VIEW' THEN 'view'
                           ELSE 'foreign'
                       END AS rel_kind
                FROM information_schema.tables
                WHERE table_schema = $1 AND table_type IN (${SELECTABLE_TABLE_TYPES_SQL})
                UNION
                SELECT matviewname AS table_name, 'matview' AS rel_kind
                FROM pg_matviews
                WHERE schemaname = $1
            ) rels
            ORDER BY table_name`;
}

export interface ColumnInfo {
    name: string;
    dataType: string;
    isNullable: boolean;
    columnDefault: string | null;
    comment: string | null;
}

export interface ChangeSet {
    updates: Array<{ primaryKey: Record<string, any>; changes: Record<string, any> }>;
    inserts: Array<Record<string, any>>;
    deletes: Array<Record<string, any>>;
}

/**
 * One source table a set of pending edits is written to. A single result can
 * span several tables (a join), so a commit applies a list of targets inside
 * one transaction.
 */
export interface CommitTarget {
    schema: string;
    table: string;
    /**
     * How the rows of this target are identified. `'row'` means the identity is
     * built from all displayed values and may be ambiguous, so every UPDATE and
     * DELETE must be proven to affect exactly one row.
     */
    identityStrategy?: IdentityStrategy;
    /**
     * Type name (`pg_type.typname`, e.g. `jsonb`, `_int4`) of each source
     * column. Optional: when missing, the types are looked up (commit) or taken
     * from what the last result of this table reported (SQL preview).
     */
    columnTypes?: Readonly<Record<string, string>>;
    changes: ChangeSet;
}

/** Whether `typeName` (a `pg_type.typname`) is `json` or `jsonb`. */
export function isJsonTypeName(typeName: string | undefined): boolean {
    const t = (typeName ?? '').trim().toLowerCase();
    return t === 'json' || t === 'jsonb';
}

function isJsonText(text: string): boolean {
    try {
        JSON.parse(text);
        return true;
    } catch {
        return false;
    }
}

/**
 * The value to send for a json/jsonb column. The `pg` driver parses json into
 * JS values, and would send them back wrongly: an array becomes a PostgreSQL
 * array literal `{...}` and a JSON string scalar `"abc"` arrives as bare `abc`,
 * both rejected as invalid json. So the value is sent as JSON text:
 *
 * - `stored` values (the identity of a loaded row) are always the parsed
 *   database value, so they are always `JSON.stringify`-ed.
 * - `edit` values (SET / INSERT) are either text the user typed in the grid
 *   (already JSON, validated against the column type before a commit) or a
 *   value copied by "Duplicate Row", which the Data Viewer sends as JSON text
 *   too. A string that parses as JSON is therefore taken as JSON text as is;
 *   anything else (objects, arrays, numbers, booleans, and strings that are no
 *   valid JSON) is `JSON.stringify`-ed.
 */
export function jsonColumnValue(value: unknown, origin: 'edit' | 'stored'): unknown {
    if (value === null || value === undefined) return value;
    if (origin === 'edit' && typeof value === 'string' && isJsonText(value)) return value;
    return JSON.stringify(value);
}

export interface ForeignKeyInfo {
    column: string;
    refSchema: string;
    refTable: string;
    refColumn: string;
}

/** What fills a column when an INSERT leaves it out. */
export interface ColumnDefaultInfo {
    column: string;
    defaultExpression: string | null;
    isIdentity: boolean;
    isGenerated: boolean;
}

export interface ReferencingTableInfo {
    fkSchema: string;
    fkTable: string;
    fkColumn: string;
    localColumn: string;
}

export class QueryRunner {
    private static vscodeModule: typeof import('vscode') | undefined;
    private connectionManager: ConnectionManager;
    private selectOptionsProvider: () => { alwaysQualifySchema: boolean; alwaysQuote: boolean };
    /**
     * Runs the statements whose result depends on the session — the user's
     * query, its row count, saving and export. Catalog lookups always use the
     * pool, so they never wait behind a long query of the session.
     */
    private executor: QueryExecutor;
    /** Column type names per table (see {@link loadColumnTypes}), keyed by {@link tableKey}. */
    private columnTypeMemory = new Map<string, Record<string, string>>();

    constructor(
        connectionManager: ConnectionManager,
        selectOptionsProvider?: () => { alwaysQualifySchema: boolean; alwaysQuote: boolean },
        executor?: QueryExecutor
    ) {
        this.connectionManager = connectionManager;
        this.selectOptionsProvider = selectOptionsProvider ?? this.getDefaultSelectOptions;
        this.executor = executor ?? this.poolExecutor();
    }

    /** Run every statement on whichever pooled connection is free. */
    private poolExecutor(): QueryExecutor {
        return {
            query: (sql, params) => this.connectionManager.query(sql, params),
            queryPositional: (sql, params) => this.connectionManager.queryPositional(sql, params),
            transaction: async <T>(work: (query: QueryFn) => Promise<T>): Promise<T> => {
                const pool = this.connectionManager.getPool();
                if (!pool) {
                    throw new Error('Not connected to database');
                }
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    const result = await work((sql, params) => client.query(sql, params));
                    await client.query('COMMIT');
                    return result;
                } catch (err) {
                    await client.query('ROLLBACK');
                    throw err;
                } finally {
                    client.release();
                }
            }
        };
    }

    async fetchRows(schema: string, table: string, offset: number, limit: number, where?: string): Promise<QueryResultRow[]> {
        const tableReference = await this.getSelectTableReference(schema, table);
        const whereSql = where && where.trim() ? ` WHERE ${where.trim()}` : '';
        const result = await this.executor.query(
            `SELECT * FROM ${tableReference}${whereSql} LIMIT $1 OFFSET $2`,
            [limit, offset]
        );
        return result.rows;
    }

    async getRowCount(schema: string, table: string, where?: string): Promise<number> {
        const tableReference = await this.getSelectTableReference(schema, table);
        const whereSql = where && where.trim() ? ` WHERE ${where.trim()}` : '';
        const result = await this.executor.query(
            `SELECT COUNT(*) as count FROM ${tableReference}${whereSql}`
        );
        return parseInt(result.rows[0].count, 10);
    }

    async getSelectBuildInfo(schema: string, table: string): Promise<{ alwaysQuote: boolean; tableReference: string }> {
        const { alwaysQuote } = this.getSelectOptions();
        const tableReference = await this.getSelectTableReference(schema, table);
        return { alwaysQuote, tableReference };
    }

    /**
     * Ask the database whether `value` can be stored in a column of `typeName`
     * by letting it cast the text — the only check that is right for every
     * type, including timestamps, enums, JSON and domains with constraints.
     */
    async checkValueCast(typeName: string, value: string | null): Promise<{ valid: boolean; reason?: string }> {
        if (value === null || value === undefined || !QueryRunner.isPlainTypeName(typeName)) {
            return { valid: true };
        }
        try {
            await this.connectionManager.query(`SELECT CAST($1::text AS ${typeName})`, [String(value)]);
            return { valid: true };
        } catch (err) {
            const message = getErrorMessage(err).split('\n')[0].trim();
            return { valid: false, reason: message || `Not a valid ${typeName} value` };
        }
    }

    /**
     * Accept only the shape `format_type()` produces for built-in and plain
     * user types (`numeric(10,2)`, `timestamp without time zone`, `text[]`), so
     * a type name can never smuggle SQL into the cast above.
     */
    static isPlainTypeName(typeName: string): boolean {
        return typeof typeName === 'string'
            && /^[a-z_][a-z0-9_ ]*(\(\d+(\s*,\s*\d+)?\))?(\s*\[\])*$/i.test(typeName.trim());
    }

    async getColumns(schema: string, table: string): Promise<ColumnInfo[]> {
        const rows = await this.connectionManager.queryMetadata(
            `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
                    pgd.description AS column_comment
             FROM information_schema.columns c
             LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = c.table_schema
             LEFT JOIN pg_catalog.pg_class cls ON cls.relname = c.table_name AND cls.relnamespace = n.oid
             LEFT JOIN pg_catalog.pg_description pgd ON pgd.objoid = cls.oid AND pgd.objsubid = c.ordinal_position
             WHERE c.table_schema = $1 AND c.table_name = $2
             ORDER BY c.ordinal_position`,
            [schema, table]
        );
        return rows.map((row) => ({
            name: row.column_name,
            dataType: row.data_type,
            isNullable: row.is_nullable === 'YES',
            columnDefault: row.column_default,
            comment: row.column_comment ?? null
        }));
    }

    /**
     * Collect the data required to build SQL statement skeletons (SELECT,
     * INSERT, ...) for a table: the (optionally schema-qualified) table
     * reference, the list of properly quoted column identifiers, the raw
     * name of the first column (used to derive a default table alias), and
     * the PostgreSQL data type of each column (used to cast values).
     */
    async getStatementBuildData(
        schema: string,
        table: string
    ): Promise<{ tableReference: string; columns: string[]; columnTypes: string[]; firstColumnRaw: string | null }> {
        const { alwaysQuote } = this.getSelectOptions();
        const tableReference = await this.getSelectTableReference(schema, table);
        const cols = await this.getColumns(schema, table);
        return {
            tableReference,
            columns: cols.map(c => this.formatIdentifier(c.name, alwaysQuote)),
            columnTypes: cols.map(c => c.dataType),
            firstColumnRaw: cols.length ? cols[0].name : null
        };
    }

    /**
     * Collect the data required to build a multi-table JOIN SELECT: for each
     * requested table its reference, quoted column list and raw column names,
     * plus all foreign-key edges that exist *between the requested tables*
     * (used to auto-suggest join conditions). Each edge points from the table
     * holding the FK column to the referenced table.
     */
    async getMultiTableJoinData(
        tables: Array<{ schema: string; table: string }>
    ): Promise<{
        tables: Array<{
            schema: string;
            table: string;
            tableReference: string;
            columns: string[];
            rawColumns: string[];
            firstColumnRaw: string | null;
        }>;
        foreignKeys: Array<{
            fromSchema: string;
            fromTable: string;
            fromColumn: string;
            toSchema: string;
            toTable: string;
            toColumn: string;
        }>;
    }> {
        const { alwaysQuote } = this.getSelectOptions();
        const inSet = (schema: string, table: string) =>
            tables.some(t => t.schema === schema && t.table === table);

        const tableData = [];
        const foreignKeys = [];
        for (const t of tables) {
            const tableReference = await this.getSelectTableReference(t.schema, t.table);
            const cols = await this.getColumns(t.schema, t.table);
            tableData.push({
                schema: t.schema,
                table: t.table,
                tableReference,
                columns: cols.map(c => this.formatIdentifier(c.name, alwaysQuote)),
                rawColumns: cols.map(c => c.name),
                firstColumnRaw: cols.length ? cols[0].name : null
            });

            const fks = await this.getForeignKeys(t.schema, t.table);
            for (const fk of fks) {
                if (inSet(fk.refSchema, fk.refTable)) {
                    foreignKeys.push({
                        fromSchema: t.schema,
                        fromTable: t.table,
                        fromColumn: this.formatIdentifier(fk.column, alwaysQuote),
                        toSchema: fk.refSchema,
                        toTable: fk.refTable,
                        toColumn: this.formatIdentifier(fk.refColumn, alwaysQuote)
                    });
                }
            }
        }

        return { tables: tableData, foreignKeys };
    }

    /**
     * List all selectable tables as `{ schema, table }`, optionally restricted
     * to the schemas configured for the table explorer. Used by the JOIN dialog
     * to let the user add more tables.
     */
    async listAllTables(): Promise<Array<{ schema: string; table: string }>> {
        const rows = await this.connectionManager.queryMetadata(buildRelationListQuery());
        return rows.map((row) => ({ schema: row.table_schema, table: row.table_name }));
    }

    async getPrimaryKeys(schema: string, table: string): Promise<string[]> {
        const rows = await this.connectionManager.queryMetadata(
            `SELECT a.attname
             FROM pg_index i
             JOIN pg_class c ON c.oid = i.indrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
             WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary
             ORDER BY array_position(i.indkey::int2[], a.attnum)`,
            [schema, table]
        );
        return rows.map((row) => row.attname);
    }

    /**
     * The default expression of every column that has one, plus whether the
     * column is an identity or a generated column. The Data Viewer uses this to
     * decide which values must not be carried over into a duplicated row.
     */
    async getColumnDefaults(schema: string, table: string): Promise<ColumnDefaultInfo[]> {
        const rows = await this.connectionManager.queryMetadata(
            `SELECT column_name, column_default, is_identity, is_generated
             FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2
             ORDER BY ordinal_position`,
            [schema, table]
        );
        return rows
            .map((row) => ({
                column: row.column_name as string,
                defaultExpression: (row.column_default ?? null) as string | null,
                isIdentity: row.is_identity === 'YES',
                isGenerated: typeof row.is_generated === 'string' && row.is_generated !== 'NEVER'
            }))
            .filter((info) => info.defaultExpression !== null || info.isIdentity || info.isGenerated);
    }

    /**
     * Resolve which table column each field of a query result came from and
     * derive what the Data Viewer may offer for it (editing, inserting, ...).
     *
     * PostgreSQL reports the source relation and column for every field that
     * maps 1:1 onto a table column, so this works for arbitrary SELECTs — only
     * computed columns, aggregates and literals stay unresolved. It does not
     * report the alias, so `sql` is needed to tell two joins of one table apart.
     */
    async resolveEditPlan(fields: ReadonlyArray<ResultFieldInfo>, sql?: string): Promise<ViewCapabilities> {
        const oids = [...new Set(fields.map(f => f.tableID).filter((id): id is number => !!id))];
        if (oids.length === 0) {
            return buildEditPlan([], {});
        }

        const relationRows = await this.connectionManager.queryMetadata(
            `SELECT c.oid, n.nspname, c.relname, c.relkind
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.oid = ANY($1)`,
            [oids]
        );
        const relations: Record<number, RelationInfo> = {};
        const readOnlyTables = new Set<number>();
        for (const row of relationRows) {
            const oid = Number(row.oid);
            relations[oid] = { schema: row.nspname, table: row.relname, relkind: row.relkind };
            if (!isWritableRelkind(row.relkind)) {
                readOnlyTables.add(oid);
            }
        }

        const attnums = [...new Set(fields.map(f => f.columnID).filter((n): n is number => !!n && n > 0))];
        const attributes: Record<string, string> = {};
        if (attnums.length > 0) {
            const attributeRows = await this.connectionManager.queryMetadata(
                `SELECT attrelid, attnum, attname
                 FROM pg_attribute
                 WHERE attrelid = ANY($1) AND attnum = ANY($2)`,
                [oids, attnums]
            );
            for (const row of attributeRows) {
                attributes[attributeKey(Number(row.attrelid), Number(row.attnum))] = row.attname;
            }
        }

        const resolved = resolveFieldSources(fields, relations, attributes);
        const sources = sql ? splitAliasedSources(resolved, resultColumnQualifiers(sql)) : resolved;
        for (const source of sources) {
            if (source && source.dataTypeID) {
                this.rememberColumnType(source.schema, source.table, source.sourceColumn,
                    SPECIAL_TYPE_NAMES_BY_OID[source.dataTypeID] ?? '');
            }
        }
        const primaryKeys: Record<number, string[]> = {};
        for (const oid of oids) {
            if (!relations[oid] || readOnlyTables.has(oid)) { continue; }
            const pkRows = await this.connectionManager.queryMetadata(
                `SELECT a.attname
                 FROM pg_index i
                 JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                 WHERE i.indrelid = $1 AND i.indisprimary`,
                [oid]
            );
            primaryKeys[oid] = pkRows.map((row) => row.attname);
        }

        return buildEditPlan(sources, primaryKeys, readOnlyTables);
    }

    /**
     * Count all rows an arbitrary SELECT would return, without fetching them.
     * Used for the exact total of an ad-hoc query, which is only determined on
     * demand because it can be expensive.
     */
    async getQueryRowCount(sql: string): Promise<number> {
        const trimmed = sql.trim().replace(/;\s*$/, '');
        const result = await this.executor.query(
            `SELECT COUNT(*) AS count FROM (${trimmed}) AS _pqb_count`
        );
        return parseInt(result.rows[0].count, 10);
    }

    async getForeignKeys(schema: string, table: string): Promise<ForeignKeyInfo[]> {
        const rows = await this.connectionManager.queryMetadata(
            `SELECT
                a1.attname AS fk_column,
                n2.nspname AS ref_schema,
                c2.relname AS ref_table,
                a2.attname AS ref_column
             FROM pg_constraint con
             JOIN pg_class c1 ON c1.oid = con.conrelid
             JOIN pg_namespace n1 ON n1.oid = c1.relnamespace
             JOIN pg_class c2 ON c2.oid = con.confrelid
             JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
             JOIN pg_attribute a1 ON a1.attrelid = con.conrelid AND a1.attnum = ANY(con.conkey)
             JOIN pg_attribute a2 ON a2.attrelid = con.confrelid AND a2.attnum = ANY(con.confkey)
             WHERE con.contype = 'f'
                AND n1.nspname = $1
                AND c1.relname = $2`,
            [schema, table]
        );
        return rows.map((row) => ({
            column: row.fk_column,
            refSchema: row.ref_schema,
            refTable: row.ref_table,
            refColumn: row.ref_column
        }));
    }

    async getReferencingTables(schema: string, table: string): Promise<ReferencingTableInfo[]> {
        const rows = await this.connectionManager.queryMetadata(
            `SELECT
                n2.nspname AS fk_schema,
                c2.relname AS fk_table,
                a2.attname AS fk_column,
                a1.attname AS local_column
             FROM pg_constraint con
             JOIN pg_class c1 ON c1.oid = con.confrelid
             JOIN pg_namespace n1 ON n1.oid = c1.relnamespace
             JOIN pg_class c2 ON c2.oid = con.conrelid
             JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
             JOIN pg_attribute a1 ON a1.attrelid = con.confrelid AND a1.attnum = ANY(con.confkey)
             JOIN pg_attribute a2 ON a2.attrelid = con.conrelid AND a2.attnum = ANY(con.conkey)
             WHERE con.contype = 'f'
                AND n1.nspname = $1
                AND c1.relname = $2`,
            [schema, table]
        );
        return rows.map((row) => ({
            fkSchema: row.fk_schema,
            fkTable: row.fk_table,
            fkColumn: row.fk_column,
            localColumn: row.local_column
        }));
    }

    /**
     * Run a SQL script the user edited in the commit preview as one
     * transaction: either every statement is applied or none.
     */
    async executeStatements(sql: string): Promise<void> {
        const statements = splitSqlStatements(sql).map(s => s.trim()).filter(s => s.length > 0);
        if (statements.length === 0) {
            throw new Error('There is no statement to execute.');
        }
        await this.executor.transaction(async (query) => {
            for (const statement of statements) {
                await query(statement);
            }
        });
    }

    async commitChanges(targets: ReadonlyArray<CommitTarget>): Promise<void> {
        const { alwaysQuote } = this.getSelectOptions();
        const typesByTarget = new Map<CommitTarget, Readonly<Record<string, string>>>();
        for (const target of targets) {
            typesByTarget.set(target, target.columnTypes ?? await this.loadColumnTypes(target.schema, target.table));
        }
        // Nothing but `query` may reach the database in here: on a session,
        // another statement would wait for this transaction to finish.
        await this.executor.transaction(async (query) => {
            for (const target of targets) {
                const { schema, table, changes } = target;
                const types = typesByTarget.get(target) ?? {};
                // A row identified by all of its values may match several rows,
                // so such a statement must be proven to hit exactly one.
                const verifyRowCount = target.identityStrategy === 'row';
                const tableRef = `${this.formatIdentifier(schema, alwaysQuote)}.${this.formatIdentifier(table, alwaysQuote)}`;

                for (const update of changes.updates) {
                    const setClauses: string[] = [];
                    const values: unknown[] = [];
                    let paramIndex = 1;

                    for (const [col, val] of Object.entries(update.changes)) {
                        setClauses.push(`${this.formatIdentifier(col, alwaysQuote)} = $${paramIndex}`);
                        values.push(QueryRunner.columnParam(val, types[col], 'edit'));
                        paramIndex++;
                    }

                    const identity = QueryRunner.identityEntries(update.primaryKey, types, verifyRowCount);
                    const whereClauses: string[] = [];
                    for (const [col, val] of identity.entries) {
                        if (val === null || val === undefined) {
                            whereClauses.push(`${this.formatIdentifier(col, alwaysQuote)} IS NULL`);
                        } else {
                            whereClauses.push(`${this.formatIdentifier(col, alwaysQuote)} = $${paramIndex}`);
                            values.push(QueryRunner.columnParam(val, types[col], 'stored'));
                            paramIndex++;
                        }
                    }

                    if (whereClauses.length === 0) {
                        throw new Error(QueryRunner.noIdentityMessage('UPDATE rows in', schema, table, identity.skipped));
                    }

                    const result = await query(
                        `UPDATE ${tableRef} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`,
                        values
                    );
                    this.assertSingleRow(verifyRowCount, result, 'UPDATE', schema, table);
                }

                for (const insert of changes.inserts) {
                    const columns = Object.keys(insert).filter(k => insert[k] !== null && insert[k] !== '');
                    if (columns.length === 0) { continue; }

                    const values = columns.map(c => QueryRunner.columnParam(insert[c], types[c], 'edit'));
                    const placeholders = columns.map((_, i) => `$${i + 1}`);

                    await query(
                        `INSERT INTO ${tableRef} (${columns.map(c => this.formatIdentifier(c, alwaysQuote)).join(', ')}) VALUES (${placeholders.join(', ')})`,
                        values
                    );
                }

                for (const del of changes.deletes) {
                    const whereClauses: string[] = [];
                    const values: unknown[] = [];
                    let paramIndex = 1;

                    const identity = QueryRunner.identityEntries(del, types, verifyRowCount);
                    for (const [col, val] of identity.entries) {
                        if (val === null || val === undefined) {
                            whereClauses.push(`${this.formatIdentifier(col, alwaysQuote)} IS NULL`);
                        } else {
                            whereClauses.push(`${this.formatIdentifier(col, alwaysQuote)} = $${paramIndex}`);
                            values.push(QueryRunner.columnParam(val, types[col], 'stored'));
                            paramIndex++;
                        }
                    }

                    if (whereClauses.length === 0) {
                        throw new Error(QueryRunner.noIdentityMessage('DELETE rows from', schema, table, identity.skipped));
                    }

                    const result = await query(
                        `DELETE FROM ${tableRef} WHERE ${whereClauses.join(' AND ')}`,
                        values
                    );
                    this.assertSingleRow(verifyRowCount, result, 'DELETE', schema, table);
                }
            }
        });
    }

    /**
     * A value as a query parameter for a column of `typeName`. json/jsonb
     * values become JSON text (see {@link jsonColumnValue}); everything else is
     * passed on for the `pg` driver to serialize.
     */
    static columnParam(value: unknown, typeName: string | undefined, origin: 'edit' | 'stored'): unknown {
        return isJsonTypeName(typeName) ? jsonColumnValue(value, origin) : value;
    }

    /**
     * The `column = value` pairs that identify a row. For a row identified by
     * all of its values (`skipIncomparable`), columns whose type has no
     * equality operator (json, xml, geometric types) are left out (`json = $1`
     * fails outright) and reported in `skipped`.
     */
    static identityEntries(
        identity: Record<string, unknown>,
        types: Readonly<Record<string, string>>,
        skipIncomparable: boolean
    ): { entries: Array<[string, unknown]>; skipped: string[] } {
        const entries: Array<[string, unknown]> = [];
        const skipped: string[] = [];
        for (const [col, val] of Object.entries(identity)) {
            if (skipIncomparable && !hasEqualityOperator(types[col])) {
                skipped.push(col);
            } else {
                entries.push([col, val]);
            }
        }
        return { entries, skipped };
    }

    private static noIdentityMessage(action: string, schema: string, table: string, skipped: string[]): string {
        const base = `Cannot ${action} ${schema}.${table}: no columns available to identify the row`;
        if (skipped.length === 0) {
            return base + '.';
        }
        return `${base}. The table has no primary key in this result, and ${skipped.join(', ')} cannot be `
            + 'compared for equality (json, xml and geometric types cannot). Nothing was changed.';
    }

    /** Key of the column type memory for one table. */
    private static tableKey(schema: string, table: string): string {
        return JSON.stringify([schema, table]);
    }

    private rememberColumnType(schema: string, table: string, column: string, typeName: string): void {
        const key = QueryRunner.tableKey(schema, table);
        const types = this.columnTypeMemory.get(key) ?? {};
        types[column] = typeName;
        this.columnTypeMemory.set(key, types);
    }

    /**
     * The type name (`pg_type.typname`; the base type for a domain, `_name`
     * for an array) of every column of a table. Remembered for the SQL
     * preview, which cannot wait for a lookup. A failed lookup is logged and
     * falls back to what is already known.
     */
    private async loadColumnTypes(schema: string, table: string): Promise<Readonly<Record<string, string>>> {
        const key = QueryRunner.tableKey(schema, table);
        try {
            const rows = await this.connectionManager.queryMetadata(
                `SELECT column_name, data_type, udt_name
                 FROM information_schema.columns
                 WHERE table_schema = $1 AND table_name = $2`,
                [schema, table]
            );
            if (rows.length > 0) {
                const types: Record<string, string> = {};
                for (const row of rows) {
                    types[row.column_name] = String(row.udt_name || row.data_type || '');
                }
                this.columnTypeMemory.set(key, types);
            }
        } catch (err: unknown) {
            Logger.error('QueryRunner.loadColumnTypes', err);
        }
        return this.columnTypeMemory.get(key) ?? {};
    }

    /**
     * Look up the column types of every target that does not carry them, so
     * {@link generateSQL} renders json values and the row identity exactly as
     * {@link commitChanges} sends them.
     */
    async preloadColumnTypes(targets: ReadonlyArray<CommitTarget>): Promise<void> {
        for (const target of targets) {
            if (!target.columnTypes) await this.loadColumnTypes(target.schema, target.table);
        }
    }

    /** Guard for rows that are only identified by their displayed values. */
    private assertSingleRow(
        verify: boolean,
        result: { rowCount?: number | null } | undefined,
        verb: string,
        schema: string,
        table: string
    ): void {
        if (!verify || !result || typeof result.rowCount !== 'number') {
            return;
        }
        if (result.rowCount !== 1) {
            throw new Error(
                `${verb} on ${schema}.${table} would have affected ${result.rowCount} rows instead of exactly one. `
                + 'The rows of this result have no primary key, so they are identified by all of their displayed '
                + 'values. Nothing was changed.'
            );
        }
    }

    async executeSQL(sql: string): Promise<{ rows: QueryResultRow[]; fields: FieldDef[]; rowCount: number }> {
        const result = await this.executor.queryPositional(sql);
        const fields = uniqueFieldNames(result.fields || [], sql);
        const values: unknown[][] = (result.rows as unknown[][]) || [];
        const rows = values.map((rowValues) => {
            const row: Record<string, unknown> = {};
            fields.forEach((field, index) => { row[field.name] = rowValues[index]; });
            return row as QueryResultRow;
        });
        return { rows, fields, rowCount: result.rowCount || 0 };
    }

    generateSQL(targets: ReadonlyArray<CommitTarget>): string {
        const { alwaysQuote } = this.getSelectOptions();
        const statements: string[] = [];

        for (const target of targets) {
            const { schema, table, changes } = target;
            const types = target.columnTypes ?? this.columnTypeMemory.get(QueryRunner.tableKey(schema, table)) ?? {};
            const skipIncomparable = target.identityStrategy === 'row';
            const tableRef = `${this.formatIdentifier(schema, alwaysQuote)}.${this.formatIdentifier(table, alwaysQuote)}`;
            const whereFor = (identity: Record<string, unknown>): string => QueryRunner
                .identityEntries(identity, types, skipIncomparable).entries
                .map(([col, val]) => (val === null || val === undefined)
                    ? `${this.formatIdentifier(col, alwaysQuote)} IS NULL`
                    : `${this.formatIdentifier(col, alwaysQuote)} = ${this.formatValue(val, types[col], 'stored')}`)
                .join(' AND ');

            for (const update of changes.updates) {
                const setClauses: string[] = [];
                for (const [col, val] of Object.entries(update.changes)) {
                    setClauses.push(`${this.formatIdentifier(col, alwaysQuote)} = ${this.formatValue(val, types[col], 'edit')}`);
                }

                statements.push(
                    `UPDATE ${tableRef} SET ${setClauses.join(', ')} WHERE ${whereFor(update.primaryKey)};`
                );
            }

            for (const insert of changes.inserts) {
                const columns = Object.keys(insert).filter(k => insert[k] !== null && insert[k] !== '');
                if (columns.length === 0) { continue; }

                const values = columns.map(c => this.formatValue(insert[c], types[c], 'edit'));
                statements.push(
                    `INSERT INTO ${tableRef} (${columns.map(c => this.formatIdentifier(c, alwaysQuote)).join(', ')}) VALUES (${values.join(', ')});`
                );
            }

            for (const del of changes.deletes) {
                statements.push(
                    `DELETE FROM ${tableRef} WHERE ${whereFor(del)};`
                );
            }
        }

        return statements.join('\n\n');
    }

    /**
     * A value as a SQL literal for the generated script, matching what
     * {@link commitChanges} sends as a parameter: json/jsonb as JSON text,
     * arrays as a PostgreSQL array literal, Dates as ISO text, bytea as `\x?`.
     */
    private formatValue(val: unknown, typeName?: string, origin: 'edit' | 'stored' = 'edit'): string {
        const value = QueryRunner.columnParam(val, typeName, origin);
        if (value === null || value === undefined) {
            return 'NULL';
        }
        if (typeof value === 'number' && Number.isFinite(value)) {
            return String(value);
        }
        if (typeof value === 'bigint') {
            return String(value);
        }
        if (typeof value === 'boolean') {
            return value ? 'TRUE' : 'FALSE';
        }
        return escapeSqlLiteral(pgValueToText(value) ?? '');
    }

    private getSelectOptions(): { alwaysQualifySchema: boolean; alwaysQuote: boolean } {
        return this.selectOptionsProvider();
    }

    private getDefaultSelectOptions(): { alwaysQualifySchema: boolean; alwaysQuote: boolean } {
        if (!QueryRunner.vscodeModule) {
            QueryRunner.vscodeModule = require('vscode') as typeof import('vscode');
        }

        const vscode = QueryRunner.vscodeModule;
        const config = vscode.workspace.getConfiguration('postgresQueryBuilder');
        return {
            alwaysQualifySchema: config.get<boolean>('alwaysQualifySchema', false),
            alwaysQuote: config.get<boolean>('alwaysQuote', false)
        };
    }

    private async getSelectTableReference(schema: string, table: string): Promise<string> {
        const { alwaysQualifySchema, alwaysQuote } = this.getSelectOptions();
        // Skip the search_path lookup when we already know we will qualify.
        const inSearchPath = alwaysQualifySchema ? false : await this.isSchemaInSearchPath(schema);
        const shouldQualify = alwaysQualifySchema || !inSearchPath;
        const tableName = this.formatIdentifier(table, alwaysQuote);
        const tableReference = shouldQualify
            ? `${this.formatIdentifier(schema, alwaysQuote)}.${tableName}`
            : tableName;

        Logger.log(
            'queryRunner',
            `Table reference for ${schema}.${table} -> "${tableReference}" ` +
            `(alwaysQualifySchema=${alwaysQualifySchema}, schemaInSearchPath=${alwaysQualifySchema ? 'n/a' : inSearchPath}, qualified=${shouldQualify})`
        );

        return tableReference;
    }

    private async isSchemaInSearchPath(schema: string): Promise<boolean> {
        const lowerSchema = schema.toLowerCase();

        // We read the configured search_path via `current_setting('search_path')`
        // (identical to `SHOW search_path`) instead of `current_schemas(false)`:
        // the latter only reflects the *currently executing* session's resolved
        // path and was observed to return an empty list on pooled connections
        // where the configured path had not (yet) been applied, even though the
        // schema clearly exists and is on the path.
        const result = await this.connectionManager.query(
            'SELECT current_setting(\'search_path\') AS search_path, current_user AS current_user'
        );
        const rawSearchPath: string = result.rows[0]?.search_path ?? '';
        const currentUser: string = result.rows[0]?.current_user ?? '';
        const schemaList = QueryRunner.parseSearchPath(rawSearchPath, currentUser);
        const schemaSet = new Set(schemaList.map((s: string) => s.toLowerCase()));
        const found = schemaSet.has(lowerSchema);

        Logger.log(
            'queryRunner',
            `Retrieved search_path = "${rawSearchPath}" (current_user="${currentUser}") -> [${schemaList.join(', ')}]; ` +
            `schema "${schema}" ${found ? 'is' : 'is NOT'} on the search_path`
        );

        return found;
    }

    /**
     * Parse a PostgreSQL `search_path` setting string (as returned by
     * `SHOW search_path` / `current_setting('search_path')`) into the list of
     * effective schema names.
     *
     * Handles:
     * - comma separation and surrounding whitespace,
     * - double-quoted identifiers (incl. escaped `""`), which preserve case,
     * - the special `$user` / `"$user"` entry, which is replaced with the
     *   current user name (dropped if no user is given),
     * - empty entries, which are skipped.
     */
    static parseSearchPath(rawSearchPath: string, currentUser: string): string[] {
        const result: string[] = [];
        for (let part of rawSearchPath.split(',')) {
            part = part.trim();
            if (part === '') {
                continue;
            }
            // Strip a single layer of surrounding double quotes and unescape "".
            let unquoted: string;
            if (part.startsWith('"') && part.endsWith('"') && part.length >= 2) {
                unquoted = part.slice(1, -1).replace(/""/g, '"');
            } else {
                unquoted = part;
            }
            if (unquoted === '$user') {
                if (currentUser) {
                    result.push(currentUser);
                }
                continue;
            }
            result.push(unquoted);
        }
        return result;
    }

    private formatIdentifier(identifier: string, alwaysQuote: boolean): string {
        if (alwaysQuote || this.needsQuoting(identifier)) {
            return `"${identifier.replace(/"/g, '""')}"`;
        }
        return identifier;
    }

    private needsQuoting(identifier: string): boolean {
        return !/^[a-z_][a-z0-9_$]*$/.test(identifier) || POSTGRES_RESERVED_KEYWORDS.has(identifier.toLowerCase());
    }
}
