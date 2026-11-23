import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { PassThrough } from 'stream';
import { runBridge } from '../mcpBridge';
import { NOT_RUNNING_MESSAGE, writeDiscoveryFile } from '../mcpDiscovery';
import { McpHttpServer, createMcpServer } from '../mcpServer';
import type { McpServices } from '../mcpTools';

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

/** Feed the lines to the bridge and collect what it writes to stdout. */
async function bridge(lines: unknown[], discoveryDir: string, cwd = process.cwd()): Promise<any[]> {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk: Buffer) => { written += chunk.toString('utf8'); });
    const logs: string[] = [];
    const done = runBridge(input, output, { discoveryDir, cwd, log: (m) => logs.push(m) });
    for (const line of lines) input.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
    input.end();
    await done;
    assert.ok(written === '' || written.endsWith('\n'), 'every message ends with a newline');
    return written.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cli', version: '1' } } };
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };

function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pgqb-mcp-bridge-'));
}

// ===== runBridge =====

test('the bridge forwards initialize, tools/list and tools/call to the MCP server of VS Code and stays silent on notifications', async () => {
    const server = new McpHttpServer(() => createMcpServer(services(), '7.7.7'));
    const endpoint = await server.start();
    const dir = tempDir();
    try {
        writeDiscoveryFile(dir, { port: endpoint.port, token: endpoint.token, pid: process.pid, workspaceFolders: [dir], startedAt: new Date().toISOString(), version: '7.7.7' });
        const replies = await bridge([
            initialize,
            initialized,
            { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
            { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'format_sql', arguments: { sql: 'select 1' } } }
        ], dir, dir);
        assert.equal(replies.length, 3, 'nothing is written for the notification');
        const byId = new Map(replies.map((r) => [r.id, r]));
        assert.equal(byId.get(1).result.serverInfo.version, '7.7.7', 'initialize reached the real server');
        assert.equal(byId.get(1).result.protocolVersion, '2025-06-18');
        assert.ok(byId.get(2).result.tools.some((t: { name: string }) => t.name === 'list_connections'));
        assert.equal(byId.get(3).result.isError, undefined);
        assert.match(byId.get(3).result.content[0].text, /SELECT/);
    } finally {
        await server.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the bridge answers initialize itself while VS Code is not running and explains why tools fail', async () => {
    const dir = tempDir();
    try {
        const replies = await bridge([
            initialize,
            initialized,
            { jsonrpc: '2.0', id: 'p', method: 'ping' },
            { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'format_sql', arguments: { sql: 'select 1' } } }
        ], path.join(dir, 'no-endpoints'));
        const byId = new Map(replies.map((r) => [r.id, r]));
        assert.equal(replies.length, 3);
        assert.equal(byId.get(1).result.protocolVersion, '2025-06-18');
        assert.deepEqual(byId.get(1).result.capabilities, { tools: { listChanged: false } });
        assert.deepEqual(byId.get('p').result, {});
        assert.equal(byId.get(3).error.code, -32000);
        assert.equal(byId.get(3).error.message, NOT_RUNNING_MESSAGE);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the bridge skips an endpoint that refuses the connection and reports bad input as a parse error', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const dir = tempDir();
    try {
        writeDiscoveryFile(dir, { port: deadPort, token: 'x', pid: process.pid, workspaceFolders: [], startedAt: new Date().toISOString(), version: '1' });
        const replies = await bridge(['{ not json', { jsonrpc: '2.0', id: 5, method: 'tools/list' }], dir);
        const byId = new Map(replies.map((r) => [r.id, r]));
        assert.equal(byId.get(null).error.code, -32700);
        assert.equal(byId.get(5).error.message, NOT_RUNNING_MESSAGE);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the bridge passes on a refusal of the server, such as a stale token, as the error of the request', async () => {
    const server = new McpHttpServer(() => createMcpServer(services(), '1'));
    const endpoint = await server.start();
    const dir = tempDir();
    try {
        writeDiscoveryFile(dir, { port: endpoint.port, token: 'stale', pid: process.pid, workspaceFolders: [], startedAt: new Date().toISOString(), version: '1' });
        const [reply] = await bridge([{ jsonrpc: '2.0', id: 9, method: 'tools/list' }], dir);
        assert.equal(reply.id, 9);
        assert.match(reply.error.message, /Unauthorized/);
    } finally {
        await server.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
