import { ConnectionManager } from './connectionManager';

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
        const shouldQualify = alwaysQualifySchema || !(await this.isSchemaInSearchPath(schema));
        const tableName = this.formatIdentifier(table, alwaysQuote);

        if (!shouldQualify) {
            return tableName;
        }

        return `${this.formatIdentifier(schema, alwaysQuote)}.${tableName}`;
    }

    private async isSchemaInSearchPath(schema: string): Promise<boolean> {
        const lowerSchema = schema.toLowerCase();

        // Check schemas configured in the connection settings
        const connConfig = this.connectionManager.getActiveConnectionConfig();
        if (connConfig?.schemas?.length) {
            const configSchemas = new Set(connConfig.schemas.map((s: string) => s.toLowerCase()));
            if (configSchemas.has(lowerSchema)) {
                return true;
            }
        }

        // Fall back to PostgreSQL's runtime search path
        const result = await this.connectionManager.query('SELECT current_schemas(false) AS schemas');
        const schemas = result.rows[0]?.schemas;
        const schemaSet = new Set(
            Array.isArray(schemas) ? schemas.map((s: string) => s.toLowerCase()) : []
        );
        return schemaSet.has(lowerSchema);
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
