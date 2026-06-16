import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as dns from 'dns';
import { promisify } from 'util';
import { Pool, PoolConfig, types as pgTypes } from 'pg';
import { createHash } from 'crypto';

const dnsLookup = promisify(dns.lookup);

// PostgreSQL OID 1114 = TIMESTAMP WITHOUT TIME ZONE.
// By default, node-postgres parses these as JS Date objects using the local timezone,
// which then get serialized to UTC ISO strings — causing the displayed value to shift
// from what is actually stored in the database. We override the parser to return the
// raw string from the server so the value is shown 1:1 as stored.
pgTypes.setTypeParser(1114, (val: string) => val);

export interface ConnectionConfig {
    name: string;
    host: string;
    port: number;
    database: string;
    user: string;
    schemas?: string[];
}

export class ConnectionManager {
    private pool: Pool | null = null;
    private activeConfig: ConnectionConfig | null = null;
    private metadataQueryCache = new Map<string, any[]>();
    private context: vscode.ExtensionContext;
    private _onConnectionChanged = new vscode.EventEmitter<void>();
    public readonly onConnectionChanged = this._onConnectionChanged.event;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    /**
     * Determines which password to use when saving/connecting from the connection
     * form. When editing an existing connection and the password field is left
     * empty, the previously stored password is reused instead of overwriting it
     * with an empty value. For new connections (no existing config) the provided
     * password is used as-is.
     */
    static async resolvePassword(
        providedPassword: string,
        existingConfig: ConnectionConfig | undefined,
        getStoredPassword: (name: string) => PromiseLike<string | undefined>
    ): Promise<string> {
        let password = providedPassword;
        if (existingConfig && (password === undefined || password === '')) {
            const storedPassword = await getStoredPassword(existingConfig.name);
            if (storedPassword !== undefined) {
                password = storedPassword;
            }
        }
        return password;
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
            ? { ...existingConfig, port: String(existingConfig.port), schemas: (existingConfig.schemas || []).join(', '), title: `Edit: ${existingConfig.name}` }
            : { name: 'My Database', host: defaultHost, port: String(defaultPort), database: defaultDatabase, user: 'postgres', schemas: '', title: 'New Connection' };

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
                    const schemas = msg.schemas
                        ? msg.schemas.split(',').map((s: string) => s.trim()).filter((s: string) => s)
                        : undefined;
                    const connConfig: ConnectionConfig = {
                        name: msg.name,
                        host: msg.host,
                        port: msg.port,
                        database: msg.database,
                        user: msg.user,
                        schemas: schemas
                    };
                    // When editing an existing connection and the password field is left
                    // empty, reuse the previously stored password instead of overwriting
                    // it with an empty value.
                    const password = await ConnectionManager.resolvePassword(
                        msg.password,
                        existingConfig,
                        (name) => this.context.secrets.get(`pgqb_password_${name}`)
                    );
                    try {
                        await this.connect(connConfig, password);
                        await this.saveConnection(connConfig, password);
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
                detail: `User: ${c.user}` + (c.schemas?.length ? ` | Schemas: ${c.schemas.join(', ')}` : '')
            })),
            { label: '$(add) New Connection', description: 'Create a new connection' },
            { label: '$(edit) Edit Connection', description: 'Edit an existing connection' },
            { label: '$(trash) Delete Connection', description: 'Remove a saved connection' }
        ];

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a database connection'
        });

        if (!selected) { return; }

        if (selected.label === '$(add) New Connection') {
            await this.connectWithInputFlow();
            return;
        }

        if (selected.label === '$(edit) Edit Connection') {
            await this.editConnection(savedConnections);
            return;
        }

        if (selected.label === '$(trash) Delete Connection') {
            await this.deleteConnection(savedConnections);
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
        this.clearMetadataCache();

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

        try {
            const client = await this.pool.connect();
            client.release();
        } catch (err: any) {
            // If SSL is not supported, retry without SSL
            if (err.message && err.message.includes('does not support SSL')) {
                console.log(`[PG] SSL not supported, retrying without SSL`);
                await this.pool.end();
                delete poolConfig.ssl;
                this.pool = new Pool(poolConfig);
                const client = await this.pool.connect();
                client.release();
            } else {
                throw err;
            }
        }

        this.activeConfig = config;
        this._onConnectionChanged.fire();
    }

    async disconnect(): Promise<void> {
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
            this.activeConfig = null;
            this.clearMetadataCache();
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

    async queryMetadata(sql: string, params?: any[]): Promise<any[]> {
        const normalizedParams = (params ?? []).map(param =>
            `${param === null ? 'null' : typeof param}:${this.stableSerialize(param)}`
        );
        const cacheKey = createHash('sha256')
            .update(sql)
            .update('\u0000')
            .update(normalizedParams.join('\u0001'))
            .digest('hex');
        const cachedRows = this.metadataQueryCache.get(cacheKey);
        if (cachedRows) {
            return cachedRows;
        }

        const result = await this.query(sql, params);
        const rows = result.rows;
        this.metadataQueryCache.set(cacheKey, rows);
        return rows;
    }

    clearMetadataCache(): void {
        this.metadataQueryCache.clear();
    }

    private stableSerialize(value: any): string {
        if (value === null || value === undefined) {
            return String(value);
        }
        if (Array.isArray(value)) {
            return `[${value.map(v => this.stableSerialize(v)).join(',')}]`;
        }
        if (typeof value === 'object') {
            const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
            return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${this.stableSerialize(v)}`).join(',')}}`;
        }
        return JSON.stringify(value);
    }

    private async editConnection(savedConnections: ConnectionConfig[]): Promise<void> {
        const items = savedConnections.map(c => ({
            label: c.name,
            description: `${c.host}:${c.port}/${c.database}`
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select connection to edit'
        });

        if (!selected) { return; }

        const conn = savedConnections.find(c => c.name === selected.label);
        if (conn) {
            await this.connectWithInputFlow(conn);
        }
    }

    private async deleteConnection(savedConnections: ConnectionConfig[]): Promise<void> {
        const items = savedConnections.map(c => ({
            label: c.name,
            description: `${c.host}:${c.port}/${c.database}`
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select connection to delete'
        });

        if (!selected) { return; }

        const config = vscode.workspace.getConfiguration('postgresQueryBuilder');
        const saved = config.get<ConnectionConfig[]>('savedConnections', []);
        const filtered = saved.filter(c => c.name !== selected.label);
        await config.update('savedConnections', filtered, vscode.ConfigurationTarget.Global);
        await this.context.secrets.delete(`pgqb_password_${selected.label}`);
        vscode.window.showInformationMessage(`Connection "${selected.label}" deleted.`);
    }

    dispose(): void {
        if (this.pool) {
            this.pool.end();
            this.pool = null;
        }
        this.clearMetadataCache();
        this._onConnectionChanged.dispose();
    }
}
