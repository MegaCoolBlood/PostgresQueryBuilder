import * as vscode from 'vscode';
import * as dns from 'dns';
import { promisify } from 'util';
import { Pool, PoolConfig, QueryResult, QueryResultRow, types as pgTypes } from 'pg';
import { createHash } from 'crypto';
import { Logger, getErrorMessage } from './logger';
import { buildHtmlDocument } from './webviewUtils';
import { icon } from './webviewAssets';

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
    private metadataQueryCache = new Map<string, QueryResultRow[]>();
    private context: vscode.ExtensionContext;
    private _onConnectionChanged = new vscode.EventEmitter<void>();
    public readonly onConnectionChanged = this._onConnectionChanged.event;

    /**
     * A user-selected `search_path` that overrides the server default for the
     * active connection. When set, it is (re)applied to every physical
     * connection the pool opens. `null` means "use the server default".
     */
    private searchPathOverride: string | null = null;
    /** The pool configuration of the active connection, kept so the pool can be
     *  rebuilt when the search_path override changes. */
    private currentPoolConfig: PoolConfig | null = null;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    /**
     * Normalize raw user input for a `search_path`. Returns the trimmed value,
     * or `null` when the input is empty/whitespace (meaning: use the server
     * default, i.e. no override).
     */
    static normalizeSearchPath(input: string): string | null {
        const trimmed = (input ?? '').trim();
        return trimmed === '' ? null : trimmed;
    }

    /**
     * Create a connection pool and, when a `search_path` override is active,
     * register a handler that applies it to every new physical connection.
     * `set_config('search_path', <value>, false)` is used with the value passed
     * as a bound parameter so the comma-separated schema list is handled safely
     * (no SQL injection, no manual quoting). Because queries are serialized per
     * client, the override runs before any query issued on that client.
     */
    private createPool(poolConfig: PoolConfig): Pool {
        const pool = new Pool(poolConfig);
        const override = this.searchPathOverride;
        if (override) {
            pool.on('connect', (client) => {
                client.query("SELECT set_config('search_path', $1, false)", [override])
                    .catch((err: unknown) => Logger.error('searchPath', err));
            });
        }
        return pool;
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

    /**
     * Ensure there is an active database connection. If none is active, prompt
     * the user to pick (or create) a connection. Returns true if a connection
     * is active afterwards, false if the user dismissed the prompt.
     */
    async ensureConnected(): Promise<boolean> {
        if (this.isConnected()) {
            return true;
        }
        await this.selectConnection();
        return this.isConnected();
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

        panel.webview.html = this.getConnectionFormHtml(panel.webview);

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
                    } catch (err: unknown) {
                        panel.webview.postMessage({ type: 'error', message: `Connection failed: ${getErrorMessage(err)}` });
                    }
                }
            });
        });
    }

    private getConnectionFormHtml(webview: vscode.Webview): string {
        const styles = `
        body { padding: var(--sp-5); }
        h2 { margin-top: 0; font-size: var(--fs-lg); }
        .form-group { margin-bottom: var(--sp-3); }
        label { display: block; margin-bottom: var(--sp-1); font-weight: 500; }
        input { width: 100%; max-width: 400px; }
        .button-row { margin-top: var(--sp-5); display: flex; gap: var(--sp-2); }
        .error {
            color: var(--c-danger);
            margin-top: var(--sp-3);
            display: none;
        }`;
        const body = `
    <h2 id="title">New Connection</h2>
    <form id="connectionForm">
        <div class="form-group">
            <label for="name">Connection Name</label>
            <input type="text" id="name" placeholder="My Database" autofocus />
        </div>
        <div class="form-group">
            <label for="host">Host</label>
            <input type="text" id="host" placeholder="localhost" />
        </div>
        <div class="form-group">
            <label for="port">Port</label>
            <input type="number" id="port" placeholder="5432" />
        </div>
        <div class="form-group">
            <label for="database">Database</label>
            <input type="text" id="database" placeholder="postgres" />
        </div>
        <div class="form-group">
            <label for="user">Username</label>
            <input type="text" id="user" placeholder="postgres" />
        </div>
        <div class="form-group">
            <label for="password">Password</label>
            <input type="password" id="password" placeholder="Password" />
        </div>
        <div class="form-group">
            <label for="schemas">Schemas (optional, comma-separated)</label>
            <input type="text" id="schemas" placeholder="public, myschema" />
        </div>
        <div class="error" id="error"></div>
        <div class="button-row">
            <button type="submit" class="btn btn-primary">${icon('plug')}Connect</button>
            <button type="button" class="btn" id="cancelBtn">Cancel</button>
        </div>
    </form>`;
        const script = `
        const vscode = acquireVsCodeApi();

        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.type === 'prefill') {
                if (msg.name) document.getElementById('name').value = msg.name;
                if (msg.host) document.getElementById('host').value = msg.host;
                if (msg.port) document.getElementById('port').value = msg.port;
                if (msg.database) document.getElementById('database').value = msg.database;
                if (msg.user) document.getElementById('user').value = msg.user;
                if (msg.schemas) document.getElementById('schemas').value = msg.schemas;
                if (msg.title) document.getElementById('title').textContent = msg.title;
            } else if (msg.type === 'error') {
                const el = document.getElementById('error');
                el.textContent = msg.message;
                el.style.display = 'block';
            }
        });

        document.getElementById('connectionForm').addEventListener('submit', e => {
            e.preventDefault();
            const name = document.getElementById('name').value.trim();
            const host = document.getElementById('host').value.trim();
            const port = document.getElementById('port').value.trim();
            const database = document.getElementById('database').value.trim();
            const user = document.getElementById('user').value.trim();
            const password = document.getElementById('password').value;
            const schemas = document.getElementById('schemas').value.trim();

            if (!name || !host || !port || !database || !user) {
                const el = document.getElementById('error');
                el.textContent = 'All fields except password are required.';
                el.style.display = 'block';
                return;
            }

            document.getElementById('error').style.display = 'none';
            vscode.postMessage({
                type: 'connect',
                name, host, port: parseInt(port, 10), database, user, password, schemas
            });
        });

        document.getElementById('cancelBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'cancel' });
        });`;
        return buildHtmlDocument({ webview, title: 'PostgreSQL Connection', styles, body, script });
    }

    async selectConnection(): Promise<void> {
        const savedConnections = this.getSavedConnections();

        if (savedConnections.length === 0) {
            const choice = await vscode.window.showQuickPick(
                ['$(add) New Connection'],
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
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Connection failed: ${getErrorMessage(err)}`);
            }
        } else {
            try {
                await this.connect(conn, password);
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Connection failed: ${getErrorMessage(err)}`);
            }
        }
    }

    private async connect(config: ConnectionConfig, password: string): Promise<void> {
        if (this.pool) {
            await this.pool.end();
        }
        this.clearMetadataCache();
        // A new connection starts with the server's default search_path.
        this.searchPathOverride = null;

        // Resolve hostname via OS resolver (respects hosts file)
        let resolvedHost = config.host;
        try {
            const { address } = await dnsLookup(config.host);
            resolvedHost = address;
        } catch {
            // Fall back to original hostname if lookup fails
        }

        console.log(`[PG] Connecting to ${resolvedHost}:${config.port} (resolved from ${config.host})`);
        Logger.log(
            'connection',
            `Connecting to ${config.host}:${config.port} (resolved host ${resolvedHost}), ` +
            `database "${config.database}", user "${config.user}"` +
            (config.schemas?.length ? `, display schemas [${config.schemas.join(', ')}]` : '')
        );

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

        this.pool = this.createPool(poolConfig);

        try {
            const client = await this.pool.connect();
            client.release();
        } catch (err: unknown) {
            // If SSL is not supported, retry without SSL
            const message = getErrorMessage(err);
            if (message.includes('does not support SSL')) {
                console.log(`[PG] SSL not supported, retrying without SSL`);
                await this.pool.end();
                delete poolConfig.ssl;
                this.pool = this.createPool(poolConfig);
                const client = await this.pool.connect();
                client.release();
            } else {
                throw err;
            }
        }

        this.activeConfig = config;
        this.currentPoolConfig = poolConfig;
        this._onConnectionChanged.fire();

        // Log the server's effective search_path so it is visible which schemas
        // are resolved without qualification for this connection.
        try {
            const spResult = await this.query('SHOW search_path');
            const searchPath = spResult.rows[0]?.search_path;
            Logger.log('connection', `Connected. Server search_path = ${searchPath ?? '(unknown)'}`);
        } catch (err) {
            Logger.error('connection', err);
        }
    }

    async disconnect(): Promise<void> {
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
            this.activeConfig = null;
            this.currentPoolConfig = null;
            this.searchPathOverride = null;
            this.clearMetadataCache();
            this._onConnectionChanged.fire();
            vscode.window.showInformationMessage('Disconnected from PostgreSQL');
        }
    }

    /** Return the effective `search_path` of the active connection (raw string). */
    async getSearchPath(): Promise<string> {
        const result = await this.query('SHOW search_path');
        return result.rows[0]?.search_path ?? '';
    }

    /**
     * Override the `search_path` for the active connection. An empty/whitespace
     * value clears the override and restores the server default. The pool is
     * rebuilt so the new value applies to every (current and future) connection;
     * the metadata cache is cleared because table resolution depends on it.
     */
    async setSearchPath(value: string): Promise<void> {
        if (!this.pool || !this.currentPoolConfig) {
            throw new Error('Not connected to a database');
        }
        this.searchPathOverride = ConnectionManager.normalizeSearchPath(value);

        const oldPool = this.pool;
        this.pool = this.createPool(this.currentPoolConfig);
        await oldPool.end();
        this.clearMetadataCache();

        // Open a fresh connection so the override is applied and verified, then
        // read back the effective search_path for logging.
        const effective = await this.getSearchPath();
        Logger.log(
            'searchPath',
            this.searchPathOverride === null
                ? `search_path override cleared; server default = ${effective}`
                : `search_path set to "${this.searchPathOverride}"; effective = ${effective}`
        );
        this._onConnectionChanged.fire();
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

    async query(sql: string, params?: unknown[]): Promise<QueryResult> {
        if (!this.pool) {
            throw new Error('Not connected to a database');
        }
        return this.pool.query(sql, params as unknown[] | undefined);
    }

    async queryMetadata(sql: string, params?: unknown[]): Promise<QueryResultRow[]> {
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

    private stableSerialize(value: unknown): string {
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
