import * as vscode from 'vscode';
import * as dns from 'dns';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { promisify } from 'util';
import { Client, ClientConfig, Pool, PoolConfig, QueryArrayResult, QueryResult, QueryResultRow, types as pgTypes } from 'pg';
import { createHash } from 'crypto';
import { Logger, getErrorMessage } from './logger';
import type { SessionClient } from './dbSession';
import { buildHtmlDocument } from './webviewUtils';
import { icon } from './webviewAssets';

const dnsLookup = promisify(dns.lookup);

// PostgreSQL OID 1114 = TIMESTAMP WITHOUT TIME ZONE.
// By default, node-postgres parses these as JS Date objects using the local timezone,
// which then get serialized to UTC ISO strings — causing the displayed value to shift
// from what is actually stored in the database. We override the parser to return the
// raw string from the server so the value is shown 1:1 as stored.
pgTypes.setTypeParser(1114, (val: string) => val);
// PostgreSQL OID 1082 = DATE. Parsed into a Date at local midnight, a date would
// reach the Data Viewer and every export as a UTC timestamp — one day early in a
// timezone east of UTC (`2024-01-31` → `2024-01-30T23:00:00.000Z`). Keep the raw
// `YYYY-MM-DD` instead; the Excel export turns it back into a real date cell.
pgTypes.setTypeParser(1082, (val: string) => val);
// PostgreSQL OID 1184 = TIMESTAMP WITH TIME ZONE. A JS Date drops the
// microseconds and is rendered in the local timezone, so exports and edits
// would write back a different value than the stored one — and a row matched
// by all of its values would no longer be found. Keep the server's text.
pgTypes.setTypeParser(1184, (val: string) => val);
// The array forms of the three types above (timestamp[] 1115, date[] 1182,
// timestamptz[] 1185) would otherwise be parsed element-wise into Dates with
// the same problems; parse them like text[] so every element stays raw text.
// The pg typings only list scalar OIDs, hence the widened signatures.
const getTextParser = pgTypes.getTypeParser as unknown as (oid: number, format: 'text') => (val: string) => unknown;
const setTextParser = pgTypes.setTypeParser as unknown as (oid: number, parser: (val: string) => unknown) => void;
const parseTextArray = getTextParser(1009, 'text');
setTextParser(1115, parseTextArray);
setTextParser(1182, parseTextArray);
setTextParser(1185, parseTextArray);
// interval (1186), point (600) and circle (718) are parsed into JS objects
// (`{days: 1, hours: 2}`, `{x, y}`, `{x, y, radius}`) whose JSON is neither
// readable in the grid nor valid input when written back or exported. Keep the
// server's text for them and their arrays (1187, 1017, 719) as well.
const keepText = (val: string) => val;
setTextParser(1186, keepText);
setTextParser(600, keepText);
setTextParser(718, keepText);
setTextParser(1187, parseTextArray);
setTextParser(1017, parseTextArray);
setTextParser(719, parseTextArray);

/**
 * How a saved connection uses TLS:
 * - `disable`     — never use TLS.
 * - `prefer`      — try TLS without verifying the certificate and fall back to
 *                   an unencrypted connection when the server has no TLS. This
 *                   is what every connection did before `sslMode` existed, so a
 *                   saved connection without the field keeps behaving this way.
 * - `require`     — TLS is mandatory, the certificate is not verified.
 * - `verify-full` — TLS is mandatory and the certificate chain and host name
 *                   are verified (against `caFile` when given, otherwise the
 *                   system's trusted CAs). Default for new connections.
 */
export type SslMode = 'disable' | 'prefer' | 'require' | 'verify-full';

export const SSL_MODES: ReadonlyArray<SslMode> = ['disable', 'prefer', 'require', 'verify-full'];

export interface ConnectionConfig {
    name: string;
    host: string;
    port: number;
    database: string;
    user: string;
    schemas?: string[];
    /** TLS mode; missing means `prefer` (the behaviour before this setting existed). */
    sslMode?: SslMode;
    /** PEM file with the CA certificate(s) used by `verify-full`. */
    caFile?: string;
    /** Sent to the server as `application_name`; {@link DEFAULT_APPLICATION_NAME} when missing. */
    applicationName?: string;
}

/** The `application_name` of a connection that has none of its own. */
export const DEFAULT_APPLICATION_NAME = 'PostgreSQL Query Booster';

/** The application name entered for a connection, trimmed; undefined when there is none. */
export function customApplicationName(config: Pick<ConnectionConfig, 'applicationName'>): string | undefined {
    const name = typeof config.applicationName === 'string' ? config.applicationName.trim() : '';
    return name === '' ? undefined : name;
}

/**
 * The `application_name` options handed to `pg`. A name entered for the
 * connection is always sent; without one, `PGAPPNAME` from the environment
 * still wins over {@link DEFAULT_APPLICATION_NAME}, as libpq resolves its
 * fallback name.
 */
export function applicationNameOptions(
    config: Pick<ConnectionConfig, 'applicationName'>
): Pick<PoolConfig, 'application_name' | 'fallback_application_name'> {
    const name = customApplicationName(config);
    const options: Pick<PoolConfig, 'application_name' | 'fallback_application_name'> = {
        fallback_application_name: DEFAULT_APPLICATION_NAME
    };
    if (name !== undefined) options.application_name = name;
    return options;
}

/** The fields the connection form posts with its `connect` message. */
export interface ConnectionFormMessage {
    name: string;
    host: string;
    port: number;
    database: string;
    user: string;
    schemas?: string;
    sslMode?: string;
    caFile?: string;
    applicationName?: string;
}

/** The connection the connection form describes; optional fields left empty are not stored. */
export function connectionConfigFromForm(msg: ConnectionFormMessage): ConnectionConfig {
    const schemas = msg.schemas
        ? msg.schemas.split(',').map((s) => s.trim()).filter((s) => s)
        : undefined;
    const config: ConnectionConfig = {
        name: msg.name,
        host: msg.host,
        port: msg.port,
        database: msg.database,
        user: msg.user,
        schemas: schemas,
        sslMode: SSL_MODES.includes(msg.sslMode as SslMode) ? msg.sslMode as SslMode : 'verify-full'
    };
    const caFile = typeof msg.caFile === 'string' ? msg.caFile.trim() : '';
    if (caFile) {
        config.caFile = caFile;
    }
    const applicationName = customApplicationName(msg);
    if (applicationName !== undefined) {
        config.applicationName = applicationName;
    }
    return config;
}

/** The `sslMode` as written, normalised; '' when it is missing. */
function rawSslMode(config: Pick<ConnectionConfig, 'sslMode'>): string {
    return String(config.sslMode ?? '').trim().toLowerCase();
}

/**
 * The SSL mode of a saved connection. A missing value means `prefer`, the
 * behaviour before the setting existed. An unknown value (a typo, or a libpq
 * mode such as `verify-ca` that is not offered) fails closed as `verify-full`
 * rather than silently weakening the connection; {@link sslModeError} reports it.
 */
export function effectiveSslMode(config: Pick<ConnectionConfig, 'sslMode'>): SslMode {
    const mode = rawSslMode(config);
    if (mode === '') return 'prefer';
    return SSL_MODES.includes(mode as SslMode) ? mode as SslMode : 'verify-full';
}

/** Why the `sslMode` of a saved connection cannot be used, or null. */
export function sslModeError(config: Pick<ConnectionConfig, 'name' | 'sslMode'>): string | null {
    const mode = rawSslMode(config);
    if (mode === '' || SSL_MODES.includes(mode as SslMode)) return null;
    return `Unknown SSL mode "${String(config.sslMode)}" in connection "${config.name}". Use one of: ${SSL_MODES.join(', ')}.`;
}

/**
 * The `ssl` option handed to `pg` for a connection. `servername` is the host
 * name the user entered: the pool connects to the pre-resolved IP address, so
 * without it the certificate could not be matched against the host name.
 */
export function buildSslOptions(
    mode: SslMode,
    host: string,
    ca?: string
): PoolConfig['ssl'] {
    switch (mode) {
        case 'disable':
            return false;
        case 'verify-full': {
            const options: { rejectUnauthorized: true; servername?: string; ca?: string } = { rejectUnauthorized: true };
            if (host && net.isIP(host) === 0) options.servername = host;
            if (ca) options.ca = ca;
            return options;
        }
        case 'require':
        case 'prefer':
        default:
            return { rejectUnauthorized: false };
    }
}

/** Only `prefer` may silently fall back to an unencrypted connection. */
export function allowsPlainFallback(mode: SslMode): boolean {
    return mode === 'prefer';
}

/**
 * The target a stored password belongs to. A password is only ever sent to the
 * host, port, database and user it was saved for, so a connection that keeps
 * its name but now points somewhere else cannot obtain it.
 */
export function connectionFingerprint(config: Pick<ConnectionConfig, 'host' | 'port' | 'database' | 'user'>): string {
    return JSON.stringify([String(config.host ?? '').trim().toLowerCase(), Number(config.port), String(config.database ?? ''), String(config.user ?? '')]);
}

/**
 * Decide whether a stored password may be used for `target`.
 *
 * Secrets saved before passwords were bound to their target have no recorded
 * fingerprint. Such a legacy secret is trusted for the connection it is saved
 * under (`legacyOwner`, the saved settings entry) on its first use and then
 * bound to it ("trust on first use"), so existing users are not asked again.
 * Since `savedConnections` is an application-scoped setting a workspace cannot
 * inject a look-alike entry to capture that first use.
 */
export function decideStoredPassword(
    storedPassword: string | undefined,
    recordedFingerprint: string | undefined,
    target: Pick<ConnectionConfig, 'host' | 'port' | 'database' | 'user'>,
    legacyOwner: Pick<ConnectionConfig, 'host' | 'port' | 'database' | 'user'> = target
): { password: string | undefined; bindFingerprint: string | undefined } {
    if (storedPassword === undefined) {
        return { password: undefined, bindFingerprint: undefined };
    }
    const expected = connectionFingerprint(target);
    if (recordedFingerprint === undefined || recordedFingerprint === '') {
        const owner = connectionFingerprint(legacyOwner);
        return {
            password: owner === expected ? storedPassword : undefined,
            bindFingerprint: owner
        };
    }
    return {
        password: recordedFingerprint === expected ? storedPassword : undefined,
        bindFingerprint: undefined
    };
}

const PASSWORD_KEY_PREFIX = 'pgqb_password_';
// Deliberately not under PASSWORD_KEY_PREFIX: a connection named `target_x`
// must not collide with the binding of a connection named `x`.
const PASSWORD_BINDING_KEY_PREFIX = 'pgqb_target_';

/**
 * Settings a workspace may no longer set: a repository could otherwise point a
 * saved connection name at its own server (and receive the stored password)
 * or run any program as `psql`.
 */
export const USER_ONLY_SETTINGS: ReadonlyArray<string> = [
    'postgresQueryBuilder.savedConnections',
    'postgresQueryBuilder.psqlPath'
];

/** The {@link USER_ONLY_SETTINGS} that a workspace settings file's text sets. */
export function findUserOnlySettings(settingsText: string): string[] {
    return USER_ONLY_SETTINGS.filter((key) => new RegExp(`"${key.replace(/\./g, '\\.')}"\\s*:`).test(settingsText));
}

const IGNORED_SETTINGS_NOTICE_KEY = 'pgqb_ignoredWorkspaceSettingsNotice';

/** Creates the connection pool; replaceable so tests can simulate a server. */
export type PoolFactory = (config: PoolConfig) => Pool;

/** A session client before it is connected. */
export interface ConnectableSessionClient extends SessionClient {
    connect(): Promise<unknown>;
}

/** Creates the dedicated client of a database session; replaceable for tests. */
export type SessionClientFactory = (config: ClientConfig) => ConnectableSessionClient;

/** Options only the pool understands; a single client is created without them. */
const POOL_ONLY_OPTIONS = [
    'max', 'min', 'idleTimeoutMillis', 'log', 'Promise', 'allowExitOnIdle',
    'maxUses', 'maxLifetimeSeconds', 'Client', 'onConnect'
] as const;

/**
 * The configuration of a session's own client: the pool's connection settings
 * without the pool options. TCP keep-alive is on, so a connection that died
 * while the session sat idle (a sleeping laptop, a dropped VPN) is noticed.
 */
export function sessionClientConfig(poolConfig: PoolConfig): ClientConfig {
    const config: Record<string, unknown> = { ...poolConfig };
    for (const key of POOL_ONLY_OPTIONS) {
        delete config[key];
    }
    return { ...(config as ClientConfig), keepAlive: true, keepAliveInitialDelayMillis: 30000 };
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

    private readonly poolFactory: PoolFactory;
    private readonly sessionClientFactory: SessionClientFactory;
    /** Counts the pools installed so far; a database session opened under another value is stale. */
    private connectionGeneration = 0;

    constructor(
        context: vscode.ExtensionContext,
        poolFactory: PoolFactory = (config) => new Pool(config),
        sessionClientFactory: SessionClientFactory = (config) => new Client(config) as unknown as ConnectableSessionClient
    ) {
        this.context = context;
        this.poolFactory = poolFactory;
        this.sessionClientFactory = sessionClientFactory;
    }

    /** Changes whenever the active connection is replaced, closed or gets another `search_path`. */
    getConnectionGeneration(): number {
        return this.connectionGeneration;
    }

    /**
     * Open a dedicated client for a database session, outside the pool, with
     * the settings of the active connection (including a `search_path`
     * override). It belongs to the caller, who has to end it.
     */
    async openSessionClient(): Promise<ConnectableSessionClient> {
        if (!this.currentPoolConfig) {
            throw new Error('Not connected to a database');
        }
        const override = this.searchPathOverride;
        const client = this.sessionClientFactory(sessionClientConfig(this.currentPoolConfig));
        // An unhandled 'error' event would take the extension host down; the
        // session attaches its own listener once the client is handed over.
        const onEarlyError = (err: Error) => Logger.error('ConnectionManager.openSessionClient', err);
        client.on('error', onEarlyError);
        try {
            await client.connect();
            if (override) {
                await client.query("SELECT set_config('search_path', $1, false)", [override]);
            }
        } catch (err: unknown) {
            client.end().catch(() => undefined);
            throw err;
        } finally {
            client.removeListener('error', onEarlyError);
        }
        Logger.log('session', `Opened a database session (backend PID ${client.processID ?? 'unknown'})`);
        return client;
    }

    /**
     * Tell the user once per workspace when its settings still hold
     * connections or a psql path: those are now read from user settings only,
     * so they would otherwise just disappear without a word.
     */
    async warnAboutIgnoredWorkspaceSettings(): Promise<void> {
        const state = this.context.workspaceState;
        if (!state || state.get<boolean>(IGNORED_SETTINGS_NOTICE_KEY)) return;
        const files: string[] = (vscode.workspace.workspaceFolders ?? [])
            .map((folder) => path.join(folder.uri.fsPath, '.vscode', 'settings.json'));
        const workspaceFile = vscode.workspace.workspaceFile;
        if (workspaceFile && workspaceFile.scheme === 'file') files.push(workspaceFile.fsPath);
        const found = new Set<string>();
        for (const file of files) {
            try {
                findUserOnlySettings(await fs.promises.readFile(file, 'utf8')).forEach((key) => found.add(key));
            } catch {
                // No settings file in this folder.
            }
        }
        if (found.size === 0) return;
        await state.update(IGNORED_SETTINGS_NOTICE_KEY, true);
        const open = 'Open Workspace Settings';
        const answer = await vscode.window.showWarningMessage(
            `This workspace sets ${[...found].join(' and ')}. These settings are now read from your user settings only, `
            + 'so a repository cannot redirect your stored passwords or run another program as psql. '
            + 'Add your connections again with "New Connection" or in your user settings.',
            open
        );
        if (answer === open) {
            await vscode.commands.executeCommand('workbench.action.openWorkspaceSettingsFile');
        }
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
    private createPool(poolConfig: PoolConfig, override: string | null = this.searchPathOverride): Pool {
        const pool = this.poolFactory(poolConfig);
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

    /**
     * The password stored in SecretStorage for a saved connection, but only
     * when it was saved for the same host, port, database and user as `config`;
     * otherwise `undefined`, so the caller asks for it again. `legacyOwner` is
     * the saved entry a secret without a recorded target belongs to (see
     * {@link decideStoredPassword}); it defaults to `config`.
     */
    async getStoredPassword(config: ConnectionConfig, legacyOwner: ConnectionConfig = config): Promise<string | undefined> {
        const name = legacyOwner.name;
        const stored = await this.context.secrets.get(PASSWORD_KEY_PREFIX + name);
        if (stored === undefined) return undefined;
        const recorded = await this.context.secrets.get(PASSWORD_BINDING_KEY_PREFIX + name);
        const decision = decideStoredPassword(stored, recorded, config, legacyOwner);
        if (decision.bindFingerprint !== undefined) {
            await this.context.secrets.store(PASSWORD_BINDING_KEY_PREFIX + name, decision.bindFingerprint);
            Logger.log('connection', `Bound the stored password of "${name}" to its host, port, database and user`);
        }
        if (decision.password === undefined) {
            Logger.log('connection', `The stored password of "${name}" was saved for a different host, port, database or user; not using it`);
        }
        return decision.password;
    }

    /** Store a password together with the target it is valid for. */
    private async storePassword(config: ConnectionConfig, password: string): Promise<void> {
        await this.context.secrets.store(PASSWORD_KEY_PREFIX + config.name, password);
        await this.context.secrets.store(PASSWORD_BINDING_KEY_PREFIX + config.name, connectionFingerprint(config));
    }

    /** The `search_path` override of the active connection, or `null` for the server default. */
    getSearchPathOverride(): string | null {
        return this.searchPathOverride;
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
            ? {
                ...existingConfig,
                port: String(existingConfig.port),
                schemas: (existingConfig.schemas || []).join(', '),
                sslMode: effectiveSslMode(existingConfig),
                caFile: existingConfig.caFile ?? '',
                applicationName: customApplicationName(existingConfig) ?? '',
                title: `Edit: ${existingConfig.name}`
            }
            : {
                name: 'My Database', host: defaultHost, port: String(defaultPort), database: defaultDatabase,
                user: 'postgres', schemas: '', sslMode: 'verify-full' as SslMode, caFile: '', applicationName: '',
                title: 'New Connection'
            };

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
                    const connConfig = connectionConfigFromForm(msg);
                    // When editing an existing connection and the password field is left
                    // empty, reuse the previously stored password instead of overwriting
                    // it with an empty value — but only while host, port, database and
                    // user still match what that password was saved for.
                    let storedPasswordRejected = false;
                    const password = await ConnectionManager.resolvePassword(
                        msg.password,
                        existingConfig,
                        async (name) => {
                            const stored = await this.getStoredPassword(connConfig, existingConfig);
                            if (stored === undefined && await this.context.secrets.get(PASSWORD_KEY_PREFIX + name) !== undefined) {
                                storedPasswordRejected = true;
                            }
                            return stored;
                        }
                    );
                    if (storedPasswordRejected) {
                        panel.webview.postMessage({
                            type: 'error',
                            message: 'Host, port, database or user changed. Enter the password for the new target.'
                        });
                        return;
                    }
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
        input, select { width: 100%; max-width: 400px; }
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
        <div class="form-group">
            <label for="sslMode">SSL</label>
            <select id="sslMode">
                <option value="verify-full">Verify certificate and host name</option>
                <option value="require">Require SSL, do not verify the certificate</option>
                <option value="prefer">Prefer SSL, fall back to unencrypted</option>
                <option value="disable">Disable SSL</option>
            </select>
        </div>
        <div class="form-group">
            <label for="caFile">CA certificate file (optional, PEM)</label>
            <input type="text" id="caFile" placeholder="Uses the system's trusted certificates when empty" />
        </div>
        <div class="form-group">
            <label for="applicationName">Application name (optional, shown in pg_stat_activity)</label>
            <input type="text" id="applicationName" placeholder="${DEFAULT_APPLICATION_NAME}" />
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
                if (msg.sslMode) document.getElementById('sslMode').value = msg.sslMode;
                if (msg.caFile) document.getElementById('caFile').value = msg.caFile;
                if (msg.applicationName) document.getElementById('applicationName').value = msg.applicationName;
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
            const sslMode = document.getElementById('sslMode').value;
            const caFile = document.getElementById('caFile').value.trim();
            const applicationName = document.getElementById('applicationName').value.trim();

            if (!name || !host || !port || !database || !user) {
                const el = document.getElementById('error');
                el.textContent = 'Name, host, port, database and user are required.';
                el.style.display = 'block';
                return;
            }

            document.getElementById('error').style.display = 'none';
            vscode.postMessage({
                type: 'connect',
                name, host, port: parseInt(port, 10), database, user, password, schemas, sslMode, caFile, applicationName
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

        const password = await this.getStoredPassword(conn);
        if (password === undefined) {
            const pwd = await vscode.window.showInputBox({
                prompt: `Password for ${conn.name}`,
                password: true
            });
            if (pwd === undefined) { return; }
            try {
                await this.connect(conn, pwd);
                await this.storePassword(conn, pwd);
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

    /**
     * Open a connection pool for `config` and make it the active connection.
     * The new pool is verified with a test connection first; only when that
     * succeeds does it replace the current pool. A failed attempt therefore
     * leaves the previous connection (if any) fully intact.
     */
    private async connect(config: ConnectionConfig, password: string): Promise<void> {
        // Resolve hostname via OS resolver (respects hosts file)
        let resolvedHost = config.host;
        try {
            const { address } = await dnsLookup(config.host);
            resolvedHost = address;
        } catch {
            // Fall back to original hostname if lookup fails
        }

        const sslModeProblem = sslModeError(config);
        if (sslModeProblem) {
            throw new Error(sslModeProblem);
        }
        const sslMode = effectiveSslMode(config);
        const applicationName = customApplicationName(config);
        Logger.log(
            'connection',
            `Connecting to ${config.host}:${config.port} (resolved host ${resolvedHost}), ` +
            `database "${config.database}", user "${config.user}", SSL ${sslMode}` +
            (config.schemas?.length ? `, display schemas [${config.schemas.join(', ')}]` : '') +
            (applicationName !== undefined ? `, application name "${applicationName}"` : '')
        );

        let ca: string | undefined;
        if (sslMode === 'verify-full' && config.caFile) {
            try {
                ca = fs.readFileSync(config.caFile, 'utf8');
            } catch (err: unknown) {
                throw new Error(`Could not read the CA certificate file "${config.caFile}": ${getErrorMessage(err)}`);
            }
        }

        const poolConfig: PoolConfig = {
            host: resolvedHost,
            port: config.port,
            database: config.database,
            user: config.user,
            password: password,
            ssl: buildSslOptions(sslMode, config.host, ca),
            ...applicationNameOptions(config),
            max: 10,
            connectionTimeoutMillis: 5000
        };

        // A new connection starts with the server's default search_path.
        let activePoolConfig = poolConfig;
        let pool = this.createPool(activePoolConfig, null);
        try {
            await this.verifyPool(pool);
        } catch (err: unknown) {
            await this.endQuietly(pool);
            if (!allowsPlainFallback(sslMode) || !getErrorMessage(err).includes('does not support SSL')) {
                throw err;
            }
            Logger.log('connection', 'The server does not support SSL, retrying without SSL');
            activePoolConfig = { ...poolConfig };
            delete activePoolConfig.ssl;
            pool = this.createPool(activePoolConfig, null);
            try {
                await this.verifyPool(pool);
            } catch (retryErr: unknown) {
                await this.endQuietly(pool);
                throw retryErr;
            }
        }

        const oldPool = this.pool;
        this.pool = pool;
        this.connectionGeneration++;
        this.activeConfig = config;
        this.currentPoolConfig = activePoolConfig;
        this.searchPathOverride = null;
        this.clearMetadataCache();
        if (oldPool) {
            await this.endQuietly(oldPool);
        }
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

    private async verifyPool(pool: Pool): Promise<void> {
        const client = await pool.connect();
        client.release();
    }

    private async endQuietly(pool: Pool): Promise<void> {
        try {
            await pool.end();
        } catch (err: unknown) {
            Logger.error('ConnectionManager.endPool', err);
        }
    }

    async disconnect(): Promise<void> {
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
            this.connectionGeneration++;
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
        this.connectionGeneration++;
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
        await this.storePassword(connConfig, password);

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

    /**
     * Run a query and return each row as an array of values in column order.
     * A row object is keyed by column name, so a result that names two columns
     * alike (`SELECT a.x, b.x`) would lose one of them; reading the values by
     * position keeps every column of such a result intact.
     */
    async queryPositional(sql: string, params?: unknown[]): Promise<QueryArrayResult> {
        if (!this.pool) {
            throw new Error('Not connected to a database');
        }
        return this.pool.query({ text: sql, rowMode: 'array', values: params as unknown[] | undefined });
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
        await this.context.secrets.delete(PASSWORD_KEY_PREFIX + selected.label);
        await this.context.secrets.delete(PASSWORD_BINDING_KEY_PREFIX + selected.label);
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
