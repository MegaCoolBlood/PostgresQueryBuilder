import { vscodeStub } from './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
    MCP_PATH,
    MCP_PROVIDER_ID,
    McpCliAccess,
    McpHttpServer,
    checkRequestAccess,
    createMcpServer,
    hasBearerToken,
    registerMcpServer,
    workspaceFilePath
} from '../mcpServer';
import { COPILOT_SERVER_NAME, discoveryFilePath, writeDiscoveryFile } from '../mcpDiscovery';
import { EDIT_CONNECTION_COMMAND_TITLE } from '../mcpPermissions';
import type { McpServices } from '../mcpTools';

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'));

const TOKEN = 'a'.repeat(64);
const good = { host: '127.0.0.1:4711', authorization: `Bearer ${TOKEN}` };

// ===== checkRequestAccess =====

test('a request to the port with the token and no browser origin is accepted', () => {
    assert.equal(checkRequestAccess(good, TOKEN, 4711), null);
    assert.equal(checkRequestAccess({ ...good, host: 'localhost:4711' }, TOKEN, 4711), null);
    assert.equal(checkRequestAccess({ ...good, authorization: `bearer ${TOKEN}` }, TOKEN, 4711), null, 'the scheme ignores case');
    assert.equal(checkRequestAccess({ ...good, origin: 'vscode-file://vscode-app' }, TOKEN, 4711), null);
});

test('a request without the right bearer token is refused with 401', () => {
    assert.equal(checkRequestAccess({ host: good.host }, TOKEN, 4711)?.status, 401);
    assert.equal(checkRequestAccess({ ...good, authorization: 'Bearer wrong' }, TOKEN, 4711)?.status, 401);
    assert.equal(checkRequestAccess({ ...good, authorization: `Basic ${TOKEN}` }, TOKEN, 4711)?.status, 401);
    assert.equal(hasBearerToken(`Bearer ${TOKEN}x`, TOKEN), false);
});

test('a request for another host name or from a web page is refused with 403 (DNS rebinding)', () => {
    assert.equal(checkRequestAccess({ ...good, host: 'evil.example:4711' }, TOKEN, 4711)?.status, 403);
    assert.equal(checkRequestAccess({ ...good, host: '127.0.0.1:80' }, TOKEN, 4711)?.status, 403);
    assert.equal(checkRequestAccess({ ...good, host: undefined }, TOKEN, 4711)?.status, 403);
    assert.equal(checkRequestAccess({ ...good, origin: 'https://evil.example' }, TOKEN, 4711)?.status, 403);
    assert.equal(checkRequestAccess({ ...good, origin: 'null' }, TOKEN, 4711)?.status, 403);
});

// ===== workspaceFilePath =====

test('workspaceFilePath accepts files inside a workspace folder only', () => {
    const root = path.resolve('/work/repo');
    assert.equal(workspaceFilePath('sql/f.sql', [root]), path.join(root, 'sql', 'f.sql'));
    assert.equal(workspaceFilePath(path.join(root, 'a.sql'), [root]), path.join(root, 'a.sql'));
    assert.equal(workspaceFilePath('../other/secret.sql', [root]), undefined);
    assert.equal(workspaceFilePath(path.resolve('/etc/passwd'), [root]), undefined);
});

// ===== the server over HTTP =====

function services(): McpServices {
    const prod = { name: 'prod', host: 'h', port: 5432, database: 'app', user: 'u', ai: { metadata: true } };
    return {
        savedConnections: () => [prod],
        activeConnection: () => prod,
        withClient: async () => { throw new Error('no database in this test'); },
        settings: () => ({ maxRows: 10, statementTimeoutSeconds: 5 }),
        askToProceed: async () => false,
        openInDataViewer: async () => undefined,
        formatOptions: () => ({}),
        ddlOptions: () => ({ includeComments: true, includeOwner: true, includeGrants: true }),
        plpgsqlCheck: async () => [],
        readWorkspaceFile: async () => '',
        compareRepository: async () => '',
        savedQueries: { list: () => [], add: async () => { throw new Error('unused'); } },
        mappings: { list: () => [], add: async () => { throw new Error('unused'); }, update: async () => undefined, remove: async () => undefined }
    };
}

test('the server answers an MCP client on 127.0.0.1 with the token, and refuses requests without it', async () => {
    const server = new McpHttpServer(() => createMcpServer(services(), '1.2.3'));
    const endpoint = await server.start();
    try {
        assert.match(endpoint.url, new RegExp(`^http://127\\.0\\.0\\.1:\\d+${MCP_PATH}$`));
        assert.deepEqual(await server.start(), endpoint, 'started once');

        const client = new Client({ name: 'test', version: '1' });
        await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), {
            requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } }
        }));
        const tools = (await client.listTools()).tools.map((t) => t.name);
        for (const name of ['list_connections', 'run_query', 'execute_sql', 'describe_table', 'format_sql']) assert.ok(tools.includes(name), name);
        const execute = (await client.listTools()).tools.find((t) => t.name === 'execute_sql');
        assert.equal(execute?.annotations?.destructiveHint, true);
        const listed = await client.callTool({ name: 'list_connections', arguments: {} });
        const content = listed.content as Array<{ type: string; text: string }>;
        assert.deepEqual(JSON.parse(content[0].text).connections[0].capabilities, ['metadata']);
        const formatted = await client.callTool({ name: 'format_sql', arguments: { sql: 'select 1' } });
        assert.equal(formatted.isError, undefined);
        await client.close();

        const post = (headers: Record<string, string>) => fetch(endpoint.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        });
        assert.equal((await post({})).status, 401);
        assert.equal((await post({ Authorization: 'Bearer nope' })).status, 401);
        assert.equal((await post({ Authorization: `Bearer ${endpoint.token}`, Origin: 'https://evil.example' })).status, 403);
        assert.equal((await fetch(endpoint.url, { headers: { Authorization: `Bearer ${endpoint.token}` } })).status, 405);
    } finally {
        await server.stop();
    }
    assert.equal(server.endpoint, undefined);
});

// ===== registration =====

test('registerMcpServer offers the server to VS Code and starts it only when VS Code resolves it', async () => {
    const subscriptions: Array<{ dispose(): unknown }> = [];
    const registered = vscodeStub.lm.mcpServerDefinitionProviders;
    registered.length = 0;
    const http = registerMcpServer({ subscriptions } as never, services(), '9.9.9');
    try {
        assert.ok(http);
        assert.deepEqual(registered.map((r) => r.id), [MCP_PROVIDER_ID]);
        const provider = registered[0].provider;
        const [definition] = await provider.provideMcpServerDefinitions();
        assert.equal(definition.label, 'PostgreSQL Query Booster');
        assert.equal(definition.version, '9.9.9');
        assert.deepEqual(definition.headers, {}, 'no token before the server is started');
        assert.equal(http.endpoint === undefined, true, 'not started yet');

        const resolved = await provider.resolveMcpServerDefinition(definition);
        const started = http.endpoint as { url: string } | undefined;
        assert.equal(String(resolved.uri), started?.url);
        assert.equal(resolved.headers.Authorization, `Bearer ${http.token}`);
    } finally {
        subscriptions.forEach((s) => s.dispose());
        await http?.stop();
    }
});

// ===== manifest =====

test('the manifest contributes the Copilot CLI setting and the status command', () => {
    const group = manifest.contributes.configuration.find((g: { title: string }) => g.title === 'AI (MCP)');
    const setting = group.properties['postgresQueryBuilder.mcp.copilotCli'];
    assert.equal(setting.type, 'boolean');
    assert.equal(setting.default, true);
    const orders = Object.values(group.properties as Record<string, { order: number }>).map((p) => p.order);
    assert.equal(setting.order, Math.max(...orders), 'listed after the other MCP settings');
    const command = manifest.contributes.commands.find((c: { command: string }) => c.command === 'postgresQueryBuilder.showMcpStatus');
    assert.equal(command?.title, 'Show MCP Server Status');
    assert.equal(command?.category, 'PostgreSQL Query Booster');
});

// ===== Copilot CLI access =====

function withSettings(values: Record<string, unknown>): () => void {
    const original = vscodeStub.workspace.getConfiguration;
    vscodeStub.workspace.getConfiguration = (() => ({
        get: <T>(key: string, fallback?: T): T => (key in values ? values[key] as T : fallback as T)
    })) as never;
    return () => { vscodeStub.workspace.getConfiguration = original; };
}

test('McpCliAccess publishes the running server for Copilot CLI and withdraws it with the settings', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pgqb-mcp-cli-'));
    const server = new McpHttpServer(() => createMcpServer(services(), '1.0.0'));
    const paths = {
        storageDir: path.join(root, 'storage'),
        bundledBridge: path.join(root, 'ext', 'dist', 'mcp-bridge.js'),
        copilotConfigFile: path.join(root, '.copilot', 'mcp-config.json')
    };
    fs.mkdirSync(path.dirname(paths.bundledBridge), { recursive: true });
    fs.writeFileSync(paths.bundledBridge, '// bridge');
    fs.mkdirSync(path.dirname(paths.copilotConfigFile), { recursive: true });
    fs.writeFileSync(paths.copilotConfigFile, JSON.stringify({ mcpServers: { other: { type: 'http', url: 'https://x' } } }));
    let folders = [path.join(root, 'repo')];
    const access = new McpCliAccess(server, paths, '1.0.0', () => folders, '/opt/code/code');
    const restore: Array<() => void> = [];
    try {
        const deadPid = 0x7ffffff0;
        writeDiscoveryFile(access.discoveryDir, { port: 1, token: 't', pid: deadPid, workspaceFolders: [], startedAt: '', version: '' });

        await access.sync();
        const endpoint = server.endpoint!;
        assert.ok(endpoint, 'started at once, not only when VS Code asks');
        const published = JSON.parse(fs.readFileSync(access.discoveryFile, 'utf8'));
        assert.equal(published.port, endpoint.port);
        assert.equal(published.token, endpoint.token);
        assert.equal(published.pid, process.pid);
        assert.deepEqual(published.workspaceFolders, folders);
        assert.equal(published.version, '1.0.0');
        assert.equal(fs.existsSync(discoveryFilePath(access.discoveryDir, deadPid)), false, 'the file of a closed window is removed');
        assert.equal(fs.readFileSync(access.bridgeFile, 'utf8'), '// bridge');

        const configText = fs.readFileSync(paths.copilotConfigFile, 'utf8');
        const config = JSON.parse(configText);
        assert.deepEqual(config.mcpServers.other, { type: 'http', url: 'https://x' });
        assert.deepEqual(config.mcpServers[COPILOT_SERVER_NAME], {
            type: 'local',
            command: '/opt/code/code',
            args: [access.bridgeFile, access.discoveryDir],
            env: { ELECTRON_RUN_AS_NODE: '1' },
            tools: ['*']
        });
        assert.equal(configText.includes(endpoint.token), false, 'the token never reaches the Copilot CLI configuration');
        assert.ok(access.statusLines().some((l) => l.includes('up to date: yes')));

        folders = [path.join(root, 'other')];
        access.publish();
        assert.deepEqual(JSON.parse(fs.readFileSync(access.discoveryFile, 'utf8')).workspaceFolders, folders);

        restore.push(withSettings({ 'mcp.copilotCli': false }));
        await access.sync();
        assert.equal(JSON.parse(fs.readFileSync(paths.copilotConfigFile, 'utf8')).mcpServers[COPILOT_SERVER_NAME], undefined);
        assert.ok(fs.existsSync(access.discoveryFile), 'the server stays published for the VS Code window');
        restore.pop()!();

        restore.push(withSettings({ 'mcp.enabled': false }));
        await access.sync();
        assert.equal(fs.existsSync(access.discoveryFile), false);
        restore.pop()!();

        await access.sync();
        assert.ok(fs.existsSync(access.discoveryFile), 'published again when turned back on');
        assert.ok(JSON.parse(fs.readFileSync(paths.copilotConfigFile, 'utf8')).mcpServers[COPILOT_SERVER_NAME]);

        access.dispose();
        assert.equal(fs.existsSync(access.discoveryFile), false, 'withdrawn when the extension is deactivated');
    } finally {
        restore.forEach((r) => r());
        await server.stop();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('McpCliAccess leaves a malformed Copilot CLI configuration alone and warns once', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pgqb-mcp-cli-'));
    const server = new McpHttpServer(() => createMcpServer(services(), '1.0.0'));
    const paths = {
        storageDir: path.join(root, 'storage'),
        bundledBridge: path.join(root, 'mcp-bridge.js'),
        copilotConfigFile: path.join(root, 'mcp-config.json')
    };
    fs.writeFileSync(paths.bundledBridge, '// bridge');
    fs.writeFileSync(paths.copilotConfigFile, '{ "mcpServers": ');
    const warnings: string[] = [];
    const original = vscodeStub.window.showWarningMessage;
    vscodeStub.window.showWarningMessage = ((message: string) => { warnings.push(message); return Promise.resolve(undefined); }) as never;
    const access = new McpCliAccess(server, paths, '1.0.0', () => [], '/opt/code/code');
    try {
        await access.sync();
        await access.sync();
        assert.equal(fs.readFileSync(paths.copilotConfigFile, 'utf8'), '{ "mcpServers": ');
        assert.equal(warnings.length, 1);
        assert.ok(warnings[0].includes(paths.copilotConfigFile), 'the warning names the file');
    } finally {
        vscodeStub.window.showWarningMessage = original;
        access.dispose();
        await server.stop();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the manifest contributes the MCP server provider and its settings in the AI (MCP) group', () => {
    assert.deepEqual(manifest.contributes.mcpServerDefinitionProviders, [{ id: MCP_PROVIDER_ID, label: 'PostgreSQL Query Booster' }]);
    assert.match(manifest.engines.vscode, /^\^1\.(10[1-9]|1[1-9]\d)\./, 'the MCP server API needs VS Code 1.101');
    const group = manifest.contributes.configuration.find((g: { title: string }) => g.title === 'AI (MCP)');
    assert.ok(group, 'no AI (MCP) settings group');
    assert.equal(group.properties['postgresQueryBuilder.mcp.enabled'].default, true);
    assert.equal(group.properties['postgresQueryBuilder.mcp.maxRows'].default, 500);
    assert.equal(group.properties['postgresQueryBuilder.mcp.statementTimeout'].default, 30);
});

test('the settings that control the shared Copilot CLI entry apply to the whole installation, not one workspace', () => {
    const group = manifest.contributes.configuration.find((g: { title: string }) => g.title === 'AI (MCP)');
    assert.equal(group.properties['postgresQueryBuilder.mcp.enabled'].scope, 'application');
    assert.equal(group.properties['postgresQueryBuilder.mcp.copilotCli'].scope, 'application');
});

function cliFixture(configServers: Record<string, unknown>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pgqb-mcp-cli-'));
    const paths = {
        storageDir: path.join(root, 'storage'),
        bundledBridge: path.join(root, 'mcp-bridge.js'),
        copilotConfigFile: path.join(root, 'mcp-config.json')
    };
    fs.writeFileSync(paths.bundledBridge, '// bridge');
    fs.writeFileSync(paths.copilotConfigFile, JSON.stringify({ mcpServers: configServers }));
    const server = new McpHttpServer(() => createMcpServer(services(), '1.0.0'));
    const servers = () => JSON.parse(fs.readFileSync(paths.copilotConfigFile, 'utf8')).mcpServers;
    const cleanup = async () => {
        await server.stop();
        fs.rmSync(root, { recursive: true, force: true });
    };
    return { root, paths, server, servers, cleanup };
}

test('McpCliAccess does not remove a Copilot CLI entry that another installation wrote', async () => {
    const otherInstallation = { type: 'local', command: '/opt/other/code', args: ['/other/mcp-bridge.js', '/other/endpoints'], env: { ELECTRON_RUN_AS_NODE: '1' }, tools: ['*'] };
    const f = cliFixture({ [COPILOT_SERVER_NAME]: otherInstallation });
    const access = new McpCliAccess(f.server, f.paths, '1.0.0', () => [], '/opt/code/code');
    const restore = withSettings({ 'mcp.copilotCli': false });
    try {
        await access.sync();
        assert.deepEqual(f.servers()[COPILOT_SERVER_NAME], otherInstallation, 'kept with copilotCli off');
        restore();
        const restoreOff = withSettings({ 'mcp.enabled': false });
        try {
            await access.sync();
        } finally {
            restoreOff();
        }
        assert.deepEqual(f.servers()[COPILOT_SERVER_NAME], otherInstallation, 'kept with the MCP server off');
    } finally {
        restore();
        access.dispose();
        await f.cleanup();
    }
});

test('McpCliAccess enters each installation under its own name and keeps the others', async () => {
    const stable = { type: 'local', command: '/opt/code/code', args: ['/stable/mcp-bridge.js', '/stable/endpoints'], env: { ELECTRON_RUN_AS_NODE: '1' }, tools: ['*'] };
    const f = cliFixture({ [COPILOT_SERVER_NAME]: stable });
    const originalScheme = vscodeStub.env.uriScheme;
    vscodeStub.env.uriScheme = 'vscode-insiders';
    const access = new McpCliAccess(f.server, f.paths, '1.0.0', () => [], '/opt/insiders/code-insiders');
    vscodeStub.env.uriScheme = originalScheme;
    const restore: Array<() => void> = [];
    try {
        assert.equal(access.serverName, 'postgres-query-booster-insiders');
        await access.sync();
        assert.deepEqual(f.servers()[COPILOT_SERVER_NAME], stable, 'Stable keeps its entry');
        assert.deepEqual(f.servers()['postgres-query-booster-insiders'], access.copilotEntry);
        const status = access.statusLines();
        assert.ok(status.some((l) => l.includes('has the "postgres-query-booster-insiders" entry')), status.join('\n'));
        assert.ok(status.some((l) => l.includes('up to date: yes')));

        restore.push(withSettings({ 'mcp.copilotCli': false }));
        await access.sync();
        assert.equal(f.servers()['postgres-query-booster-insiders'], undefined, 'its own entry is removed');
        assert.deepEqual(f.servers()[COPILOT_SERVER_NAME], stable);
        assert.ok(access.statusLines().some((l) => l.includes('has no "postgres-query-booster-insiders" entry')));
        restore.pop()!();

        // An older version entered this installation as "postgres-query-booster"; that entry moves to the new name.
        fs.writeFileSync(f.paths.copilotConfigFile, JSON.stringify({ mcpServers: { [COPILOT_SERVER_NAME]: access.copilotEntry } }));
        await access.sync();
        assert.deepEqual(f.servers(), { 'postgres-query-booster-insiders': access.copilotEntry });
    } finally {
        restore.forEach((r) => r());
        access.dispose();
        await f.cleanup();
    }
});

test('the refusal message names the command that edits a connection as the Command Palette shows it', () => {
    const command = manifest.contributes.commands.find((c: { command: string }) => c.command === 'postgresQueryBuilder.selectConnection');
    assert.equal(`${command.category}: ${command.title}`, EDIT_CONNECTION_COMMAND_TITLE);
});
