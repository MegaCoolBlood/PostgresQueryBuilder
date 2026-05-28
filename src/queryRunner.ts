import { ConnectionManager } from './connectionManager';

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

export class QueryRunner {
    private connectionManager: ConnectionManager;

    constructor(connectionManager: ConnectionManager) {
        this.connectionManager = connectionManager;
    }

    async fetchRows(schema: string, table: string, offset: number, limit: number): Promise<any[]> {
        const result = await this.connectionManager.query(
            `SELECT * FROM "${schema}"."${table}" LIMIT $1 OFFSET $2`,
            [limit, offset]
        );
        return result.rows;
    }

    async getRowCount(schema: string, table: string): Promise<number> {
        const result = await this.connectionManager.query(
            `SELECT COUNT(*) as count FROM "${schema}"."${table}"`
        );
        return parseInt(result.rows[0].count, 10);
    }

    async getColumns(schema: string, table: string): Promise<ColumnInfo[]> {
        const result = await this.connectionManager.query(
            `SELECT column_name, data_type, is_nullable, column_default
             FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2
             ORDER BY ordinal_position`,
            [schema, table]
        );
        return result.rows.map((row: any) => ({
            name: row.column_name,
            dataType: row.data_type,
            isNullable: row.is_nullable === 'YES',
            columnDefault: row.column_default
        }));
    }

    async getPrimaryKeys(schema: string, table: string): Promise<string[]> {
        const result = await this.connectionManager.query(
            `SELECT a.attname
             FROM pg_index i
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
             WHERE i.indrelid = '"${schema}"."${table}"'::regclass
             AND i.indisprimary`,
        );
        return result.rows.map((row: any) => row.attname);
    }

    async getForeignKeys(schema: string, table: string): Promise<ForeignKeyInfo[]> {
        const result = await this.connectionManager.query(
            `SELECT
                kcu.column_name AS fk_column,
                ccu.table_schema AS ref_schema,
                ccu.table_name AS ref_table,
                ccu.column_name AS ref_column
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name
                AND tc.table_schema = kcu.table_schema
             JOIN information_schema.constraint_column_usage ccu
                ON ccu.constraint_name = tc.constraint_name
                AND ccu.table_schema = tc.table_schema
             WHERE tc.constraint_type = 'FOREIGN KEY'
                AND tc.table_schema = $1
                AND tc.table_name = $2`,
            [schema, table]
        );
        return result.rows.map((row: any) => ({
            column: row.fk_column,
            refSchema: row.ref_schema,
            refTable: row.ref_table,
            refColumn: row.ref_column
        }));
    }

    async commitChanges(schema: string, table: string, changes: ChangeSet): Promise<void> {
        const pool = this.connectionManager.getPool();
        if (!pool) {
            throw new Error('Not connected to database');
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Process updates
            for (const update of changes.updates) {
                const setClauses: string[] = [];
                const values: any[] = [];
                let paramIndex = 1;

                for (const [col, val] of Object.entries(update.changes)) {
                    setClauses.push(`"${col}" = $${paramIndex}`);
                    values.push(val);
                    paramIndex++;
                }

                const whereClauses: string[] = [];
                for (const [col, val] of Object.entries(update.primaryKey)) {
                    whereClauses.push(`"${col}" = $${paramIndex}`);
                    values.push(val);
                    paramIndex++;
                }

                await client.query(
                    `UPDATE "${schema}"."${table}" SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`,
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
                    `INSERT INTO "${schema}"."${table}" (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders.join(', ')})`,
                    values
                );
            }

            // Process deletes
            for (const del of changes.deletes) {
                const whereClauses: string[] = [];
                const values: any[] = [];
                let paramIndex = 1;

                for (const [col, val] of Object.entries(del)) {
                    whereClauses.push(`"${col}" = $${paramIndex}`);
                    values.push(val);
                    paramIndex++;
                }

                await client.query(
                    `DELETE FROM "${schema}"."${table}" WHERE ${whereClauses.join(' AND ')}`,
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
        const statements: string[] = [];

        // Updates
        for (const update of changes.updates) {
            const setClauses: string[] = [];
            for (const [col, val] of Object.entries(update.changes)) {
                setClauses.push(`"${col}" = ${this.formatValue(val)}`);
            }

            const whereClauses: string[] = [];
            for (const [col, val] of Object.entries(update.primaryKey)) {
                whereClauses.push(`"${col}" = ${this.formatValue(val)}`);
            }

            statements.push(
                `UPDATE "${schema}"."${table}" SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')};`
            );
        }

        // Inserts
        for (const insert of changes.inserts) {
            const columns = Object.keys(insert).filter(k => insert[k] !== null && insert[k] !== '');
            if (columns.length === 0) { continue; }

            const values = columns.map(c => this.formatValue(insert[c]));
            statements.push(
                `INSERT INTO "${schema}"."${table}" (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${values.join(', ')});`
            );
        }

        // Deletes
        for (const del of changes.deletes) {
            const whereClauses: string[] = [];
            for (const [col, val] of Object.entries(del)) {
                whereClauses.push(`"${col}" = ${this.formatValue(val)}`);
            }
            statements.push(
                `DELETE FROM "${schema}"."${table}" WHERE ${whereClauses.join(' AND ')};`
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
}
