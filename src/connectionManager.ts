import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as dns from 'dns';
import { promisify } from 'util';
import { Pool, PoolConfig } from 'pg';

const dnsLookup = promisify(dns.lookup);

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

    async connectWithInputFlow(existingConfig?: ConnectionConfig): Promise<void> {
        const config = vscode.workspace.getConfiguration('postgresQueryBuilder');
        const defaultHost = config.get<string>('defaultHost', 'localhost');
        const defaultPort = config.get<number>('defaultPort', 5432);
        const defaultDatabase = config.get<string>('defaultDatabase', 'postgres');

        const panel = vscode.window.createWebviewPanel(
            'pgConnectionForm',
            existingConfig ? `Edit: ${existingConfig.name}` : 'New Connection',
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        const htmlPath = path.join(this.context.extensionPath, 'src', 'webview', 'connectionForm.html');
        panel.webview.html = fs.readFileSync(htmlPath, 'utf8');

        // Prefill with defaults or existing config
        const prefill = existingConfig
            ? { ...existingConfig, port: String(existingConfig.port), title: `Edit: ${existingConfig.name}` }
            : { name: 'My Database', host: defaultHost, port: String(defaultPort), database: defaultDatabase, user: 'postgres', title: 'New Connection' };

        // Send prefill after webview is ready
        setTimeout(() => panel.webview.postMessage({ type: 'prefill', ...prefill }), 100);

        return new Promise<void>((resolve) => {
            panel.onDidDispose(() => resolve());
            panel.webview.onDidReceiveMessage(async (msg) => {
                if (msg.type === 'cancel') {
                    panel.dispose();
                    return;
                }
                if (msg.type === 'connect') {
                    const connConfig: ConnectionConfig = {
                        name: msg.name,
                        host: msg.host,
                        port: msg.port,
                        database: msg.database,
                        user: msg.user
                    };
                    try {
                        await this.connect(connConfig, msg.password);
                        await this.saveConnection(connConfig, msg.password);
                        vscode.window.showInformationMessage(`Connected to ${msg.database} on ${msg.host}:${msg.port}`);
                        panel.dispose();
                    } catch (err: any) {
                        panel.webview.postMessage({ type: 'error', message: `Connection failed: ${err.message}` });
                    }
                }
            });
        });
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

        // Resolve hostname via OS resolver (respects hosts file)
        let resolvedHost = config.host;
        try {
            const { address } = await dnsLookup(config.host);
            resolvedHost = address;
        } catch {
            // Fall back to original hostname if lookup fails
        }

        console.log(`[PG] Connecting to ${resolvedHost}:${config.port} (resolved from ${config.host})`);

        const poolConfig: PoolConfig = {
            host: resolvedHost,
            port: config.port,
            database: config.database,
            user: config.user,
            password: password,
            ssl: { rejectUnauthorized: false },
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
