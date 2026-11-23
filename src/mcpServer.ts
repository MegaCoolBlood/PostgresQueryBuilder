/**
 * The MCP server of the extension: an in-process Streamable HTTP endpoint on
 * 127.0.0.1 that VS Code learns about through an MCP server definition
 * provider, so Copilot can use the tools of `mcpTools` with the user's saved
 * connections. A random bearer token, made anew in every VS Code session, is
 * required on every request; requests for another host name or from a web
 * page are refused, so a page in a browser cannot reach the server through
 * DNS rebinding.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { randomBytes, timingSafeEqual } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ConnectableSessionClient, ConnectionManager } from './connectionManager';
import type { TableWebViewManager } from './tableWebView';
import type { SavedQueryStore } from './savedQueryStore';
import type { ColumnMappingManager } from './columnMappingManager';
import { MCP_TOOLS, callTool, type McpDbClient, type McpServices, type McpTool } from './mcpTools';
import { CHECK_PARAMETERS_QUERY, readSettings as readCheckSettings, runCheck } from './plpgsqlCheck';
import { readDdlOptions } from './databaseObjectCommands';
import { getFormatOptions } from './formatSettings';
import { Logger, getErrorMessage } from './logger';
import {
    COPILOT_SERVER_NAME,
    copilotConfigFile,
    copilotServerEntry,
    copilotServerName,
    discoveryFilePath,
    installBridgeFile,
    orderEndpoints,
    readCopilotServerEntry,
    readDiscoveryRecords,
    removeDiscoveryFile,
    removeStaleDiscoveryFiles,
    updateCopilotConfigFile,
    writeDiscoveryFile,
    type ConfigEdit,
    type CopilotServerEntry
} from './mcpDiscovery';

export const MCP_PROVIDER_ID = 'postgresQueryBuilder.mcp';
export const MCP_SERVER_LABEL = 'PostgreSQL Query Booster';
export const MCP_PATH = '/mcp';
/** Largest request body accepted. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const INSTRUCTIONS = 'Tools for the PostgreSQL databases the user saved in the PostgreSQL Query Booster extension. '
    + 'Call list_connections first: it names the connections and what the user allows AI assistants to do with each '
    + '(metadata, readData, writeData, ddl). Nothing is allowed until the user grants it; when a tool is refused, '
    + 'tell the user which permission to enable instead of trying another way. Bookmarked queries and custom column mappings '
    + 'are shared by all connections and need no permission. Prefer describe_table and list_objects to guessing names, '
    + 'run_query for reading (read-only, row-limited) and execute_sql only for changes the user asked for.';

// ===== Request checks =====

export interface RequestHeaders {
    host?: string;
    origin?: string;
    authorization?: string;
}

export interface Denial {
    status: number;
    message: string;
}

/** VS Code's own window is the one origin accepted; requests from web pages are not. */
export function isAllowedOrigin(origin: string | undefined): boolean {
    return origin === undefined || origin.trim().toLowerCase() === 'vscode-file://vscode-app';
}

/** True when the Authorization header carries exactly the bearer token. */
export function hasBearerToken(authorization: string | undefined, token: string): boolean {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? '');
    if (!match) return false;
    const given = Buffer.from(match[1]);
    const expected = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Why a request must be refused, or null. The Host header must name the
 * loopback address or localhost with the server's port (DNS rebinding), a
 * browser Origin is refused, and the bearer token must match.
 */
export function checkRequestAccess(headers: RequestHeaders, token: string, port: number): Denial | null {
    const host = (headers.host ?? '').trim().toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        return { status: 403, message: 'Forbidden: unexpected Host header.' };
    }
    if (!isAllowedOrigin(headers.origin)) {
        return { status: 403, message: 'Forbidden: requests from web pages are not accepted.' };
    }
    if (!hasBearerToken(headers.authorization, token)) {
        return { status: 401, message: 'Unauthorized: missing or wrong bearer token.' };
    }
    return null;
}

function sendJsonError(res: http.ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
    if (res.headersSent) {
        res.end();
        return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) {
                reject(new Error('too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

// ===== The server =====

/** Build the MCP server with every tool; one per request, as the stateless transport wants it. */
export function createMcpServer(services: McpServices, version: string, tools: readonly McpTool[] = MCP_TOOLS): McpServer {
    const server = new McpServer(
        { name: 'postgres-query-booster', title: MCP_SERVER_LABEL, version },
        { instructions: INSTRUCTIONS }
    );
    for (const tool of tools) {
        server.registerTool(tool.name, {
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: { title: tool.title, ...tool.annotations }
        }, async (args) => {
            const result = await callTool(tool, args, services);
            return { content: result.content, isError: result.isError };
        });
    }
    return server;
}

export interface McpEndpoint {
    url: string;
    port: number;
    token: string;
}

/** The HTTP listener on 127.0.0.1; started on first use, on a free port. */
export class McpHttpServer {
    readonly token = randomBytes(32).toString('hex');
    private server: http.Server | undefined;
    private starting: Promise<McpEndpoint> | undefined;
    private port = 0;

    constructor(private readonly create: () => McpServer) {}

    get endpoint(): McpEndpoint | undefined {
        return this.server ? { url: `http://127.0.0.1:${this.port}${MCP_PATH}`, port: this.port, token: this.token } : undefined;
    }

    start(): Promise<McpEndpoint> {
        if (!this.starting) {
            const starting = this.listen();
            this.starting = starting;
            starting.catch(() => { if (this.starting === starting) this.starting = undefined; });
        }
        return this.starting;
    }

    private listen(): Promise<McpEndpoint> {
        return new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => {
                this.handle(req, res).catch((err: unknown) => {
                    Logger.error('McpHttpServer.handle', err);
                    sendJsonError(res, 500, 'Internal server error');
                });
            });
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                server.removeListener('error', reject);
                server.on('error', (err: Error) => Logger.error('McpHttpServer', err));
                this.server = server;
                this.port = (server.address() as AddressInfo).port;
                Logger.log('mcp', `MCP server listening on 127.0.0.1:${this.port}`);
                resolve(this.endpoint!);
            });
        });
    }

    async stop(): Promise<void> {
        const server = this.server;
        this.server = undefined;
        this.starting = undefined;
        if (!server) return;
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
        });
        Logger.log('mcp', 'MCP server stopped');
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const denial = checkRequestAccess({
            host: req.headers.host,
            origin: req.headers.origin,
            authorization: req.headers.authorization
        }, this.token, this.port);
        if (denial) {
            Logger.log('mcp', `Refused a request: ${denial.message}`);
            sendJsonError(res, denial.status, denial.message, denial.status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {});
            return;
        }
        const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        if (pathname !== MCP_PATH) {
            sendJsonError(res, 404, 'Not found');
            return;
        }
        // Stateless: no session and no server-initiated stream, so only POST is served.
        if (req.method !== 'POST') {
            sendJsonError(res, 405, 'Method not allowed', { Allow: 'POST' });
            return;
        }
        let body: unknown;
        try {
            body = JSON.parse(await readBody(req, MAX_BODY_BYTES));
        } catch (err: unknown) {
            sendJsonError(res, getErrorMessage(err) === 'too large' ? 413 : 400, 'The request body is not valid JSON or too large.');
            return;
        }
        const server = this.create();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => {
            transport.close().catch(() => undefined);
            server.close().catch(() => undefined);
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
    }
}

// ===== Services of the extension =====

export interface McpServiceDeps {
    connectionManager: ConnectionManager;
    tableWebViewManager: TableWebViewManager;
    savedQueryStore: SavedQueryStore;
    columnMappingManager: ColumnMappingManager;
    /** Compare Repository with Database on the active connection, as a Markdown report. */
    compareRepository(): Promise<string>;
}

function readMcpSettings(): { enabled: boolean; maxRows: number; statementTimeoutSeconds: number } {
    const cfg = vscode.workspace.getConfiguration('postgresQueryBuilder');
    const clamp = (value: number, min: number, max: number, fallback: number) =>
        Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
    return {
        enabled: cfg.get<boolean>('mcp.enabled', true),
        maxRows: clamp(Number(cfg.get<number>('mcp.maxRows', 500)), 1, 100000, 500),
        statementTimeoutSeconds: clamp(Number(cfg.get<number>('mcp.statementTimeout', 30)), 1, 86400, 30)
    };
}

/** A tool's view of a session client: plain queries, and single statements over the extended protocol. */
export function adaptClient(client: Pick<ConnectableSessionClient, 'query'>): McpDbClient {
    type ExtendedQuery = (config: { text: string; values: unknown[]; rowMode: 'array'; queryMode: 'extended' }) =>
        Promise<{ fields: Array<{ name: string }>; rows: unknown[][]; rowCount: number | null; command: string }>;
    const extended = client.query.bind(client) as unknown as ExtendedQuery;
    return {
        async query(sql, params) {
            const result = await client.query(sql, params);
            return { rows: result.rows, rowCount: result.rowCount, command: result.command };
        },
        async runStatement(sql) {
            const result = await extended({ text: sql, values: [], rowMode: 'array', queryMode: 'extended' });
            return { fields: (result.fields ?? []).map((f) => f.name), rows: result.rows ?? [], rowCount: result.rowCount, command: result.command };
        }
    };
}

/** The file a tool names, if it lies inside a workspace folder. */
export function workspaceFilePath(requested: string, folders: readonly string[]): string | undefined {
    for (const folder of folders) {
        const full = path.resolve(folder, requested);
        const relative = path.relative(folder, full);
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return full;
    }
    return undefined;
}

export function createMcpServices(deps: McpServiceDeps): McpServices {
    const cm = deps.connectionManager;
    return {
        savedConnections: () => cm.getSavedConnections(),
        activeConnection: () => (cm.isConnected() ? cm.getActiveConnectionConfig() : null),
        async withClient(connection, work) {
            const client = connection.active ? await cm.openSessionClient() : await cm.openClientFor(connection.config);
            const onError = (err: Error) => Logger.error('Mcp.client', err);
            client.on('error', onError);
            try {
                // The client is the tool call's own and closed afterwards, so a session setting is enough.
                await client.query("SELECT pg_catalog.set_config('statement_timeout', $1, false)", [`${readMcpSettings().statementTimeoutSeconds}s`]);
                return await work(adaptClient(client));
            } finally {
                await client.end().catch(() => undefined);
                client.removeListener('error', onError);
            }
        },
        settings: () => readMcpSettings(),
        async askToProceed(message, detail, action) {
            const answer = await vscode.window.showWarningMessage(message, { modal: true, detail }, action);
            return answer === action;
        },
        openInDataViewer: (sql, title) => deps.tableWebViewManager.openQueryView(sql, title),
        formatOptions: () => getFormatOptions(),
        ddlOptions: () => readDdlOptions(),
        async plpgsqlCheck(client, text) {
            const parameters = (await client.query(CHECK_PARAMETERS_QUERY)).rows;
            if (parameters.length === 0) {
                throw new Error('The database has no plpgsql_check extension. It is installed with CREATE EXTENSION plpgsql_check.');
            }
            const s = readCheckSettings();
            return runCheck(client, text, {
                settings: s.settings,
                extraSeverity: s.extraSeverity,
                timeoutMs: s.timeoutMs,
                knownParameters: new Set(parameters.map((r) => String(r.name))),
                functionSchema: String(parameters[0].schema_name),
                replaceExisting: s.replaceExisting
            });
        },
        async readWorkspaceFile(requested) {
            const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
            const candidates = folders.map((folder) => workspaceFilePath(requested, [folder])).filter((p): p is string => p !== undefined);
            const file = candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
            if (!file) throw new Error(`"${requested}" is not a file of the workspace.`);
            const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && path.resolve(d.uri.fsPath) === file);
            if (open) return open.getText();
            const stat = await fs.promises.stat(file);
            if (stat.size > MAX_BODY_BYTES) throw new Error(`"${requested}" is larger than ${MAX_BODY_BYTES / 1024 / 1024} MB.`);
            return fs.promises.readFile(file, 'utf8');
        },
        compareRepository: () => deps.compareRepository(),
        savedQueries: {
            list: () => deps.savedQueryStore.getAll(),
            add: (query, scope) => deps.savedQueryStore.add(query, scope)
        },
        mappings: {
            list: () => deps.columnMappingManager.getAllMappings(),
            add: (mapping, scope) => deps.columnMappingManager.addMapping(mapping, scope),
            update: (id, patch) => deps.columnMappingManager.updateMapping(id, patch),
            remove: (id) => deps.columnMappingManager.deleteMapping(id)
        }
    };
}

// ===== Registration =====

/** True when the editor lets an extension offer MCP servers to its chat (VS Code 1.101+). */
export function hasMcpServerApi(): boolean {
    const lm = (vscode as { lm?: Partial<typeof vscode.lm> }).lm;
    return typeof lm?.registerMcpServerDefinitionProvider === 'function' && typeof vscode.McpHttpServerDefinition === 'function';
}

/**
 * Offer the MCP server to VS Code. The HTTP listener starts when VS Code first
 * starts the server (or when {@link registerMcpCliAccess} publishes it) and
 * stops when `postgresQueryBuilder.mcp.enabled` is turned off or the extension
 * is deactivated. Without the editor's MCP API the server is still returned,
 * for agents outside the editor.
 */
export function registerMcpServer(context: vscode.ExtensionContext, services: McpServices, version: string): McpHttpServer {
    const http = new McpHttpServer(() => createMcpServer(services, version));
    const enabled = (): boolean => readMcpSettings().enabled;
    const stopServer = { dispose: () => { http.stop().catch((err: unknown) => Logger.error('McpHttpServer.stop', err)); } };
    if (!hasMcpServerApi()) {
        Logger.log('mcp', 'This editor offers no MCP server API; the MCP server is not registered with its chat.');
        context.subscriptions.push(stopServer, vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('postgresQueryBuilder.mcp.enabled') && !enabled()) stopServer.dispose();
        }));
        return http;
    }
    const lm = vscode.lm;
    const changed = new vscode.EventEmitter<void>();
    const provider: vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition> = {
        onDidChangeMcpServerDefinitions: changed.event,
        provideMcpServerDefinitions: () => {
            if (!enabled()) return [];
            const uri = vscode.Uri.parse(http.endpoint?.url ?? `http://127.0.0.1${MCP_PATH}`);
            return [new vscode.McpHttpServerDefinition(MCP_SERVER_LABEL, uri, {}, version)];
        },
        resolveMcpServerDefinition: async (definition) => {
            if (!enabled()) return undefined;
            const endpoint = await http.start();
            definition.uri = vscode.Uri.parse(endpoint.url);
            definition.headers = { ...definition.headers, Authorization: `Bearer ${endpoint.token}` };
            return definition;
        }
    };
    context.subscriptions.push(
        lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, provider),
        changed,
        stopServer,
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (!e.affectsConfiguration('postgresQueryBuilder.mcp.enabled')) return;
            if (!enabled()) stopServer.dispose();
            changed.fire();
        })
    );
    return http;
}

// ===== Agents outside VS Code (Copilot CLI / SDK) =====

export interface McpCliPaths {
    /** The extension's global storage folder. */
    storageDir: string;
    /** dist/mcp-bridge.js of the installed extension. */
    bundledBridge: string;
    /** Copilot CLI's mcp-config.json. */
    copilotConfigFile: string;
}

function readCliSettings(): { enabled: boolean; copilotCli: boolean } {
    const cfg = vscode.workspace.getConfiguration('postgresQueryBuilder');
    return { enabled: cfg.get<boolean>('mcp.enabled', true), copilotCli: cfg.get<boolean>('mcp.copilotCli', true) };
}

/**
 * Publishes the running MCP server to agents outside VS Code: a discovery file
 * per extension host, the stdio bridge at a path that survives extension
 * updates, and the bridge's entry in Copilot CLI's mcp-config.json. Every VS
 * Code installation (Stable, Insiders, …) has an entry of its own
 * ({@link copilotServerName}) and only ever removes an entry that is exactly its own.
 */
export class McpCliAccess implements vscode.Disposable {
    private readonly startedAt = new Date().toISOString();
    private published = false;
    private queue: Promise<void> = Promise.resolve();
    private warnedMalformed = false;

    constructor(
        private readonly http: McpHttpServer,
        private readonly paths: McpCliPaths,
        private readonly version: string,
        private readonly workspaceFolders: () => string[],
        private readonly nodeCommand: string = process.execPath,
        private readonly pid: number = process.pid,
        /** This installation's entry name in mcp-config.json. */
        readonly serverName: string = copilotServerName(vscode.env.uriScheme)
    ) {}

    get discoveryDir(): string {
        return path.join(this.paths.storageDir, 'mcp', 'endpoints');
    }

    get discoveryFile(): string {
        return discoveryFilePath(this.discoveryDir, this.pid);
    }

    get bridgeFile(): string {
        return path.join(this.paths.storageDir, 'mcp', 'mcp-bridge.js');
    }

    /** The mcp-config.json entry this installation wants; it holds no secret. */
    get copilotEntry(): CopilotServerEntry {
        return copilotServerEntry(this.nodeCommand, this.bridgeFile, this.discoveryDir);
    }

    /** Bring server, discovery file, bridge and Copilot CLI entry in line with the settings. */
    sync(): Promise<void> {
        const next = this.queue.then(() => this.apply()).catch((err: unknown) => Logger.error('McpCliAccess.sync', err));
        this.queue = next;
        return next;
    }

    private async apply(): Promise<void> {
        const settings = readCliSettings();
        if (!settings.enabled) {
            this.unpublish();
            await this.removeCopilotEntries();
            return;
        }
        const stale = removeStaleDiscoveryFiles(this.discoveryDir);
        if (stale > 0) Logger.log('mcp', `Removed ${stale} discovery file(s) of closed VS Code windows.`);
        await this.http.start();
        this.publish();
        if (!settings.copilotCli) {
            await this.removeCopilotEntries();
            return;
        }
        if (!this.installBridge()) return;
        await this.updateCopilotConfig(this.serverName, this.copilotEntry);
        // Older versions entered every installation as "postgres-query-booster".
        if (this.serverName !== COPILOT_SERVER_NAME) await this.updateCopilotConfig(COPILOT_SERVER_NAME, undefined);
    }

    /** Remove this installation's entry, and nothing another installation or the user put there. */
    private async removeCopilotEntries(): Promise<void> {
        await this.updateCopilotConfig(this.serverName, undefined);
        if (this.serverName !== COPILOT_SERVER_NAME) await this.updateCopilotConfig(COPILOT_SERVER_NAME, undefined);
    }

    /** Rewrite the discovery file, e.g. after the workspace folders changed. */
    publish(): void {
        const endpoint = this.http.endpoint;
        if (!endpoint || !readCliSettings().enabled) return;
        writeDiscoveryFile(this.discoveryDir, {
            port: endpoint.port,
            token: endpoint.token,
            pid: this.pid,
            workspaceFolders: this.workspaceFolders(),
            startedAt: this.startedAt,
            version: this.version
        });
        if (!this.published) Logger.log('mcp', `Published the MCP server for agents outside VS Code in ${this.discoveryFile}`);
        this.published = true;
    }

    private unpublish(): void {
        try {
            removeDiscoveryFile(this.discoveryDir, this.pid);
        } catch (err: unknown) {
            Logger.error('McpCliAccess.unpublish', err);
        }
        this.published = false;
    }

    private installBridge(): boolean {
        if (!fs.existsSync(this.paths.bundledBridge)) {
            Logger.log('mcp', `The bundled bridge ${this.paths.bundledBridge} is missing; Copilot CLI is not set up.`);
            return fs.existsSync(this.bridgeFile);
        }
        if (installBridgeFile(this.paths.bundledBridge, this.bridgeFile)) Logger.log('mcp', `Installed the MCP bridge at ${this.bridgeFile}`);
        return true;
    }

    /** Set `name` to `entry`, or with `entry` undefined remove it when it is exactly this installation's entry. */
    private async updateCopilotConfig(name: string, entry: CopilotServerEntry | undefined): Promise<void> {
        const file = this.paths.copilotConfigFile;
        let edit: ConfigEdit;
        try {
            edit = await updateCopilotConfigFile(file, entry, name, this.copilotEntry);
        } catch (err: unknown) {
            Logger.error('McpCliAccess.updateCopilotConfig', err);
            return;
        }
        if (edit.kind === 'write') {
            Logger.log('mcp', entry ? `Entered "${name}" in ${file}` : `Removed "${name}" from ${file}`);
        } else if (edit.kind === 'malformed') {
            Logger.log('mcp', `${file} is not valid JSON (${edit.error}); it was left unchanged.`);
            if (!this.warnedMalformed) {
                this.warnedMalformed = true;
                void vscode.window.showWarningMessage(`PostgreSQL Query Booster could not set up GitHub Copilot CLI: ${file} is not valid JSON, so it was left unchanged.`);
            }
        }
    }

    /** What an agent outside VS Code would find, line by line. */
    statusLines(): string[] {
        const settings = readCliSettings();
        const endpoint = this.http.endpoint;
        const exists = (file: string) => (fs.existsSync(file) ? 'exists' : 'missing');
        const lines = [
            `Extension version: ${this.version}`,
            `postgresQueryBuilder.mcp.enabled: ${settings.enabled}; postgresQueryBuilder.mcp.copilotCli: ${settings.copilotCli}`,
            `VS Code chat registration: ${hasMcpServerApi() ? `available (provider ${MCP_PROVIDER_ID})` : 'not available in this editor'}`,
            `Server: ${endpoint ? `running on 127.0.0.1:${endpoint.port}` : 'not running'}`,
            `Discovery file: ${this.discoveryFile} (${exists(this.discoveryFile)})`
        ];
        const live = orderEndpoints(readDiscoveryRecords(this.discoveryDir), process.cwd());
        lines.push(`VS Code windows with a published server: ${live.length} (pids ${live.map((r) => r.pid).join(', ') || 'none'})`);
        lines.push(`Bridge: ${this.bridgeFile} (${exists(this.bridgeFile)})`);
        const entry = readCopilotServerEntry(this.paths.copilotConfigFile, this.serverName) as Partial<CopilotServerEntry> | undefined;
        const file = this.paths.copilotConfigFile;
        if (!entry) {
            lines.push(`Copilot CLI config: ${file} (${exists(file)}) has no "${this.serverName}" entry`);
        } else {
            const bridge = Array.isArray(entry.args) ? String(entry.args[0]) : '';
            lines.push(`Copilot CLI config: ${file} has the "${this.serverName}" entry`);
            lines.push(`  command: ${entry.command} (${exists(String(entry.command))})`);
            lines.push(`  bridge: ${bridge} (${exists(bridge)})`);
            lines.push(`  up to date: ${isDeepStrictEqual(entry, this.copilotEntry) ? 'yes' : 'no'}`);
        }
        return lines;
    }

    showStatus(): void {
        for (const line of this.statusLines()) Logger.log('mcp status', line);
        Logger.show();
    }

    dispose(): void {
        this.unpublish();
    }
}

/**
 * Publish the MCP server for Copilot CLI and SDK agents while
 * `postgresQueryBuilder.mcp.enabled` is on; see {@link McpCliAccess}.
 */
export function registerMcpCliAccess(context: vscode.ExtensionContext, http: McpHttpServer, version: string): McpCliAccess {
    const folders = () => (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
    const access = new McpCliAccess(http, {
        storageDir: context.globalStorageUri.fsPath,
        bundledBridge: path.join(context.extensionPath, 'dist', 'mcp-bridge.js'),
        copilotConfigFile: copilotConfigFile()
    }, version, folders);
    context.subscriptions.push(
        access,
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('postgresQueryBuilder.mcp.enabled') || e.affectsConfiguration('postgresQueryBuilder.mcp.copilotCli')) {
                void access.sync();
            }
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            try {
                access.publish();
            } catch (err: unknown) {
                Logger.error('McpCliAccess.publish', err);
            }
        })
    );
    void access.sync();
    return access;
}
