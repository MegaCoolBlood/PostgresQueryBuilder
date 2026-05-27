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

    async connectWithInputFlow(): Promise<void> {
        const config = vscode.workspace.getConfiguration('postgresQueryBuilder');
        const defaultHost = config.get<string>('defaultHost', 'localhost');
        const defaultPort = config.get<number>('defaultPort', 5432);
        const defaultDatabase = config.get<string>('defaultDatabase', 'postgres');

        const name = await vscode.window.showInputBox({
            prompt: 'Connection name',
            placeHolder: 'My Database',
            value: 'My Database'
        });
        if (!name) { return; }

        const host = await vscode.window.showInputBox({
            prompt: 'Host',
            placeHolder: defaultHost,
            value: defaultHost
        });
        if (!host) { return; }

        const portStr = await vscode.window.showInputBox({
            prompt: 'Port',
            placeHolder: String(defaultPort),
            value: String(defaultPort)
        });
        if (!portStr) { return; }
        const port = parseInt(portStr, 10);

        const database = await vscode.window.showInputBox({
            prompt: 'Database name',
            placeHolder: defaultDatabase,
            value: defaultDatabase
        });
        if (!database) { return; }

        const user = await vscode.window.showInputBox({
            prompt: 'Username',
            placeHolder: 'postgres',
            value: 'postgres'
        });
        if (!user) { return; }

        const password = await vscode.window.showInputBox({
            prompt: 'Password',
            password: true
        });
        if (password === undefined) { return; }

        const connConfig: ConnectionConfig = { name, host, port, database, user };

        try {
            await this.connect(connConfig, password);
            await this.saveConnection(connConfig, password);
            vscode.window.showInformationMessage(`Connected to ${database} on ${host}:${port}`);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Connection failed: ${err.message}`);
        }
    }

    async selectConnection(): Promise<void> {
        const savedConnections = this.getSavedConnections();

        if (savedConnections.length === 0) {
            const choice = await vscode.window.showQuickPick(
                ['Create new connection'],
                { placeHolder: 'No saved connections. Create one?' }
            );
            if (choice) {
                await this.connectWithInputFlow();
            }
            return;
        }

        const items: vscode.QuickPickItem[] = [
            ...savedConnections.map(c => ({
                label: c.name,
                description: `${c.host}:${c.port}/${c.database}`,
                detail: `User: ${c.user}`
            })),
            { label: '$(add) New Connection', description: 'Create a new connection' }
        ];

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a database connection'
        });

        if (!selected) { return; }

        if (selected.label === '$(add) New Connection') {
            await this.connectWithInputFlow();
            return;
        }

        const conn = savedConnections.find(c => c.name === selected.label);
        if (!conn) { return; }

        const password = await this.context.secrets.get(`pgqb_password_${conn.name}`);
        if (password === undefined) {
            const pwd = await vscode.window.showInputBox({
                prompt: `Password for ${conn.name}`,
                password: true
            });
            if (pwd === undefined) { return; }
            try {
                await this.connect(conn, pwd);
                await this.context.secrets.store(`pgqb_password_${conn.name}`, pwd);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Connection failed: ${err.message}`);
            }
        } else {
            try {
                await this.connect(conn, password);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Connection failed: ${err.message}`);
            }
        }
    }

    private async connect(config: ConnectionConfig, password: string): Promise<void> {
        if (this.pool) {
            await this.pool.end();
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

        this.pool = new Pool(poolConfig);

        // Test the connection
        const client = await this.pool.connect();
        client.release();

        this.activeConfig = config;
        this._onConnectionChanged.fire();
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

    private getSavedConnections(): ConnectionConfig[] {
        const config = vscode.workspace.getConfiguration('postgresQueryBuilder');
        return config.get<ConnectionConfig[]>('savedConnections', []);
    }

    private async saveConnection(connConfig: ConnectionConfig, password: string): Promise<void> {
        await this.context.secrets.store(`pgqb_password_${connConfig.name}`, password);

        const config = vscode.workspace.getConfiguration('postgresQueryBuilder');
        const saved = config.get<ConnectionConfig[]>('savedConnections', []);

        const existing = saved.findIndex(c => c.name === connConfig.name);
        if (existing >= 0) {
            saved[existing] = connConfig;
        } else {
            saved.push(connConfig);
        }

        await config.update('savedConnections', saved, vscode.ConfigurationTarget.Global);
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
