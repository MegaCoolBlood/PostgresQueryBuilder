import { ConnectionManager } from './connectionManager';
import { Logger } from './logger';

/**
 * Table types from `information_schema.tables` that the extension treats as
 * selectable tables. PostgreSQL reports foreign tables as `'FOREIGN'` (server
 * versions >= 9.5) or `'FOREIGN TABLE'` (versions < 9.5), so both spellings are
 * accepted to make sure foreign tables always show up.
 */
export const SELECTABLE_TABLE_TYPES = ['BASE TABLE', 'FOREIGN', 'FOREIGN TABLE'] as const;

/**
 * SQL value list for `SELECTABLE_TABLE_TYPES`, ready to be inlined into an
 * `table_type IN (...)` clause, e.g. `'BASE TABLE', 'FOREIGN', 'FOREIGN TABLE'`.
 */
export const SELECTABLE_TABLE_TYPES_SQL = SELECTABLE_TABLE_TYPES.map(t => `'${t}'`).join(', ');

// NOTE: Keep in sync with POSTGRES_RESERVED_KEYWORDS in src/webview/tableView.js
const POSTGRES_RESERVED_KEYWORDS = new Set([
    'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric',
    'authorization', 'between', 'binary', 'both', 'case', 'cast', 'check', 'collate',
    'column', 'concurrently', 'constraint', 'create', 'cross', 'current_catalog',
    'current_date', 'current_role', 'current_schema', 'current_time', 'current_timestamp',
    'current_user', 'default', 'deferrable', 'desc', 'distinct', 'do', 'else', 'end',
    'except', 'false', 'fetch', 'for', 'foreign', 'from', 'freeze', 'full', 'grant',
    'group', 'having', 'ilike', 'in', 'initially', 'inner', 'intersect', 'into', 'is',
    'isnull', 'join', 'lateral', 'leading', 'left', 'like', 'limit', 'localtime',
    'localtimestamp', 'natural', 'not', 'notnull', 'null', 'offset', 'on', 'only', 'or',
    'order', 'outer', 'overlaps', 'placing', 'primary', 'references', 'returning', 'right',
    'select', 'session_user', 'similar', 'some', 'symmetric', 'table', 'then', 'to',
    'trailing', 'true', 'union', 'unique', 'user', 'using', 'variadic', 'verbose', 'when',
    'where', 'window', 'with'
]);

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

    async fetchRows(schema: string, table: string, offset: number, limit: number): Promise<any[]> {
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
        return rows.map((row: any) => ({
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
        const rows = await this.connectionManager.queryMetadata(
            `SELECT table_schema, table_name
             FROM information_schema.tables
             WHERE table_type IN (${SELECTABLE_TABLE_TYPES_SQL})
               AND table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
             ORDER BY table_schema, table_name`
        );
        return rows.map((row: any) => ({ schema: row.table_schema, table: row.table_name }));
    }

    async getPrimaryKeys(schema: string, table: string): Promise<string[]> {
        const rows = await this.connectionManager.queryMetadata(
            `SELECT a.attname
             FROM pg_index i
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
             WHERE i.indrelid = '"${schema}"."${table}"'::regclass
             AND i.indisprimary`,
        );
        return rows.map((row: any) => row.attname);
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
        return rows.map((row: any) => ({
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
        return rows.map((row: any) => ({
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

            // Process updates
            for (const update of changes.updates) {
                const setClauses: string[] = [];
                const values: any[] = [];
                let paramIndex = 1;

                for (const [col, val] of Object.entries(update.changes)) {
                    setClauses.push(`${this.formatIdentifier(col, alwaysQuote)} = $${paramIndex}`);
                    values.push(val);
                    paramIndex++;
                }

                const whereClauses: string[] = [];
                for (const [col, val] of Object.entries(update.primaryKey)) {
                    whereClauses.push(`${this.formatIdentifier(col, alwaysQuote)} = $${paramIndex}`);
                    values.push(val);
                    paramIndex++;
                }

                await client.query(
                    `UPDATE ${tableRef} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`,
                    values
                );
            }

            // Process inserts
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

            // Process deletes
            for (const del of changes.deletes) {
                const whereClauses: string[] = [];
                const values: any[] = [];
                let paramIndex = 1;

                for (const [col, val] of Object.entries(del)) {
                    whereClauses.push(`${this.formatIdentifier(col, alwaysQuote)} = $${paramIndex}`);
                    values.push(val);
                    paramIndex++;
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

    async executeSQL(sql: string): Promise<{ rows: any[]; fields: any[]; rowCount: number }> {
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

        // Updates
        for (const update of changes.updates) {
            const setClauses: string[] = [];
            for (const [col, val] of Object.entries(update.changes)) {
                setClauses.push(`${this.formatIdentifier(col, alwaysQuote)} = ${this.formatValue(val)}`);
            }

            const whereClauses: string[] = [];
            for (const [col, val] of Object.entries(update.primaryKey)) {
                whereClauses.push(`${this.formatIdentifier(col, alwaysQuote)} = ${this.formatValue(val)}`);
            }

            statements.push(
                `UPDATE ${tableRef} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')};`
            );
        }

        // Inserts
        for (const insert of changes.inserts) {
            const columns = Object.keys(insert).filter(k => insert[k] !== null && insert[k] !== '');
            if (columns.length === 0) { continue; }

            const values = columns.map(c => this.formatValue(insert[c]));
            statements.push(
                `INSERT INTO ${tableRef} (${columns.map(c => this.formatIdentifier(c, alwaysQuote)).join(', ')}) VALUES (${values.join(', ')});`
            );
        }

        // Deletes
        for (const del of changes.deletes) {
            const whereClauses: string[] = [];
            for (const [col, val] of Object.entries(del)) {
                whereClauses.push(`${this.formatIdentifier(col, alwaysQuote)} = ${this.formatValue(val)}`);
            }
            statements.push(
                `DELETE FROM ${tableRef} WHERE ${whereClauses.join(' AND ')};`
            );
        }

        return statements.join('\n\n');
    }

    private formatValue(val: any): string {
        if (val === null || val === undefined) {
            return 'NULL';
        }
        if (typeof val === 'number') {
            return String(val);
        }
        if (typeof val === 'boolean') {
            return val ? 'TRUE' : 'FALSE';
        }
        // Escape single quotes for SQL strings
        return `'${String(val).replace(/'/g, "''")}'`;
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
