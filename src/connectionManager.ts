import * as vscode from 'vscode';
import { Pool, PoolConfig } from 'pg';

export interface ConnectionConfig {
    name: string;
    host: string;
    port: number;
    database: string;
    user: string;
}

export class ConnectionManager {
    private pool: Pool | null = null;
    private activeConfig: ConnectionConfig | null = null;
    private context: vscode.ExtensionContext;
    private _onConnectionChanged = new vscode.EventEmitter<void>();
    public readonly onConnectionChanged = this._onConnectionChanged.event;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    isConnected(): boolean {
        return this.pool !== null;
    }

    getActiveConnectionConfig(): ConnectionConfig | null {
        return this.activeConfig;
    }

    getPool(): Pool | null {
        return this.pool;
    }

    getSavedConnections(): ConnectionConfig[] {
        const config = vscode.workspace.getConfiguration('postgresQueryBuilder');
        return config.get<ConnectionConfig[]>('savedConnections', []);
    }

    async getPassword(name: string): Promise<string | undefined> {
        return this.context.secrets.get(`pgqb_password_${name}`);
    }

    async connectByConfig(config: ConnectionConfig, password: string): Promise<void> {
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
        }

        const poolConfig: PoolConfig = {
            host: config.host,
            port: config.port,
            database: config.database,
            user: config.user,
            password: password,
            max: 10,
            connectionTimeoutMillis: 5000
        };

        const newPool = new Pool(poolConfig);

        // Test the connection before committing
        const client = await newPool.connect();
        client.release();

        this.pool = newPool;
        this.activeConfig = config;
        this._onConnectionChanged.fire();
    }

    async saveConnection(config: ConnectionConfig, password: string): Promise<void> {
        await this.context.secrets.store(`pgqb_password_${config.name}`, password);

        const vsConfig = vscode.workspace.getConfiguration('postgresQueryBuilder');
        const saved = vsConfig.get<ConnectionConfig[]>('savedConnections', []);

        const existing = saved.findIndex(c => c.name === config.name);
        if (existing >= 0) {
            saved[existing] = config;
        } else {
            saved.push(config);
        }

        await vsConfig.update('savedConnections', saved, vscode.ConfigurationTarget.Global);
    }

    async deleteConnection(name: string): Promise<void> {
        if (this.activeConfig?.name === name) {
            if (this.pool) {
                await this.pool.end();
                this.pool = null;
            }
            this.activeConfig = null;
            this._onConnectionChanged.fire();
        }
        await this.context.secrets.delete(`pgqb_password_${name}`);

        const vsConfig = vscode.workspace.getConfiguration('postgresQueryBuilder');
        const saved = vsConfig.get<ConnectionConfig[]>('savedConnections', []);
        await vsConfig.update(
            'savedConnections',
            saved.filter(c => c.name !== name),
            vscode.ConfigurationTarget.Global
        );
    }

    async disconnect(): Promise<void> {
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
            this.activeConfig = null;
            this._onConnectionChanged.fire();
            vscode.window.showInformationMessage('Disconnected from PostgreSQL');
        }
    }

    async query(sql: string, params?: any[]): Promise<any> {
        if (!this.pool) {
            throw new Error('Not connected to a database');
        }
        return this.pool.query(sql, params);
    }

    dispose(): void {
        if (this.pool) {
            this.pool.end();
            this.pool = null;
        }
        this._onConnectionChanged.dispose();
    }
}
