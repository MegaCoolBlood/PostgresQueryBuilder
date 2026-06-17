import { ConnectionManager } from './connectionManager';
import { Logger } from './logger';
import { escapeSqlLiteral } from './sqlUtils';
import { POSTGRES_RESERVED_KEYWORDS } from './reservedKeywords';
import type { QueryResultRow, FieldDef } from 'pg';

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
}

export interface ChangeSet {
    updates: Array<{ primaryKey: Record<string, any>; changes: Record<string, any> }>;
    inserts: Array<Record<string, any>>;
    deletes: Array<Record<string, any>>;
}

export interface ForeignKeyInfo {
    column: string;
    refSchema: string;
    refTable: string;
    refColumn: string;
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

    constructor(
        connectionManager: ConnectionManager,
        selectOptionsProvider?: () => { alwaysQualifySchema: boolean; alwaysQuote: boolean }
    ) {
        this.connectionManager = connectionManager;
        this.selectOptionsProvider = selectOptionsProvider ?? this.getDefaultSelectOptions;
    }

    async fetchRows(schema: string, table: string, offset: number, limit: number): Promise<QueryResultRow[]> {
        const tableReference = await this.getSelectTableReference(schema, table);
        const result = await this.connectionManager.query(
            `SELECT * FROM ${tableReference} LIMIT $1 OFFSET $2`,
            [limit, offset]
        );
        return result.rows;
    }

    async getRowCount(schema: string, table: string): Promise<number> {
        const tableReference = await this.getSelectTableReference(schema, table);
        const result = await this.connectionManager.query(
            `SELECT COUNT(*) as count FROM ${tableReference}`
        );
        return parseInt(result.rows[0].count, 10);
    }

    async getSelectBuildInfo(schema: string, table: string): Promise<{ alwaysQuote: boolean; tableReference: string }> {
        const { alwaysQuote } = this.getSelectOptions();
        const tableReference = await this.getSelectTableReference(schema, table);
        return { alwaysQuote, tableReference };
    }

    async getColumns(schema: string, table: string): Promise<ColumnInfo[]> {
        const rows = await this.connectionManager.queryMetadata(
            `SELECT column_name, data_type, is_nullable, column_default
             FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2
             ORDER BY ordinal_position`,
            [schema, table]
        );
        return rows.map((row) => ({
            name: row.column_name,
            dataType: row.data_type,
            isNullable: row.is_nullable === 'YES',
            columnDefault: row.column_default
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
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
             WHERE i.indrelid = '"${schema}"."${table}"'::regclass
             AND i.indisprimary`,
        );
        return rows.map((row) => row.attname);
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

    async commitChanges(schema: string, table: string, changes: ChangeSet): Promise<void> {
        const pool = this.connectionManager.getPool();
        if (!pool) {
            throw new Error('Not connected to database');
        }

        const { alwaysQuote } = this.getSelectOptions();
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const tableRef = `${this.formatIdentifier(schema, alwaysQuote)}.${this.formatIdentifier(table, alwaysQuote)}`;

            for (const update of changes.updates) {
                const setClauses: string[] = [];
                const values: unknown[] = [];
                let paramIndex = 1;

                for (const [col, val] of Object.entries(update.changes)) {
                    setClauses.push(`${this.formatIdentifier(col, alwaysQuote)} = $${paramIndex}`);
                    values.push(val);
                    paramIndex++;
                }

                const whereClauses: string[] = [];
                for (const [col, val] of Object.entries(update.primaryKey)) {
                    if (val === null || val === undefined) {
                        whereClauses.push(`${this.formatIdentifier(col, alwaysQuote)} IS NULL`);
                    } else {
                        whereClauses.push(`${this.formatIdentifier(col, alwaysQuote)} = $${paramIndex}`);
                        values.push(val);
                        paramIndex++;
                    }
                }

                if (whereClauses.length === 0) {
                    throw new Error(
                        `Cannot UPDATE rows in ${schema}.${table}: no columns available to identify the row.`
                    );
                }

                await client.query(
                    `UPDATE ${tableRef} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`,
                    values
                );
            }

            for (const insert of changes.inserts) {
                const columns = Object.keys(insert).filter(k => insert[k] !== null && insert[k] !== '');
                if (columns.length === 0) { continue; }

                const values = columns.map(c => insert[c]);
                const placeholders = columns.map((_, i) => `$${i + 1}`);

                await client.query(
                    `INSERT INTO ${tableRef} (${columns.map(c => this.formatIdentifier(c, alwaysQuote)).join(', ')}) VALUES (${placeholders.join(', ')})`,
                    values
                );
            }

            for (const del of changes.deletes) {
                const whereClauses: string[] = [];
                const values: unknown[] = [];
                let paramIndex = 1;

                for (const [col, val] of Object.entries(del)) {
                    if (val === null || val === undefined) {
                        whereClauses.push(`${this.formatIdentifier(col, alwaysQuote)} IS NULL`);
                    } else {
                        whereClauses.push(`${this.formatIdentifier(col, alwaysQuote)} = $${paramIndex}`);
                        values.push(val);
                        paramIndex++;
                    }
                }

                if (whereClauses.length === 0) {
                    throw new Error(
                        `Cannot DELETE rows from ${schema}.${table}: no columns available to identify the row.`
                    );
                }

                await client.query(
                    `DELETE FROM ${tableRef} WHERE ${whereClauses.join(' AND ')}`,
                    values
                );
            }

            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async executeSQL(sql: string): Promise<{ rows: QueryResultRow[]; fields: FieldDef[]; rowCount: number }> {
        const result = await this.connectionManager.query(sql);
        return {
            rows: result.rows || [],
            fields: result.fields || [],
            rowCount: result.rowCount || 0
        };
    }

    generateSQL(schema: string, table: string, changes: ChangeSet): string {
        const { alwaysQuote } = this.getSelectOptions();
        const tableRef = `${this.formatIdentifier(schema, alwaysQuote)}.${this.formatIdentifier(table, alwaysQuote)}`;
        const statements: string[] = [];

        for (const update of changes.updates) {
            const setClauses: string[] = [];
            for (const [col, val] of Object.entries(update.changes)) {
                setClauses.push(`${this.formatIdentifier(col, alwaysQuote)} = ${this.formatValue(val)}`);
            }

            const whereClauses: string[] = [];
            for (const [col, val] of Object.entries(update.primaryKey)) {
                if (val === null || val === undefined) {
                    whereClauses.push(`${this.formatIdentifier(col, alwaysQuote)} IS NULL`);
                } else {
                    whereClauses.push(`${this.formatIdentifier(col, alwaysQuote)} = ${this.formatValue(val)}`);
                }
            }

            statements.push(
                `UPDATE ${tableRef} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')};`
            );
        }

        for (const insert of changes.inserts) {
            const columns = Object.keys(insert).filter(k => insert[k] !== null && insert[k] !== '');
            if (columns.length === 0) { continue; }

            const values = columns.map(c => this.formatValue(insert[c]));
            statements.push(
                `INSERT INTO ${tableRef} (${columns.map(c => this.formatIdentifier(c, alwaysQuote)).join(', ')}) VALUES (${values.join(', ')});`
            );
        }

        for (const del of changes.deletes) {
            const whereClauses: string[] = [];
            for (const [col, val] of Object.entries(del)) {
                if (val === null || val === undefined) {
                    whereClauses.push(`${this.formatIdentifier(col, alwaysQuote)} IS NULL`);
                } else {
                    whereClauses.push(`${this.formatIdentifier(col, alwaysQuote)} = ${this.formatValue(val)}`);
                }
            }
            statements.push(
                `DELETE FROM ${tableRef} WHERE ${whereClauses.join(' AND ')};`
            );
        }

        return statements.join('\n\n');
    }

    private formatValue(val: unknown): string {
        if (val === null || val === undefined) {
            return 'NULL';
        }
        if (typeof val === 'number') {
            return String(val);
        }
        if (typeof val === 'boolean') {
            return val ? 'TRUE' : 'FALSE';
        }
        return escapeSqlLiteral(String(val));
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
