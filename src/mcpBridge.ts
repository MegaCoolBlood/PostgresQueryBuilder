/**
 * The stdio MCP server that GitHub Copilot CLI and Copilot SDK agents start
 * (see `mcpDiscovery`): it reads newline-delimited JSON-RPC from stdin, posts
 * every message to the MCP server of a running VS Code window, found through
 * its discovery file, and writes the answers to stdout. It holds no state, so
 * it keeps working when VS Code is started, restarted or closed meanwhile.
 *
 * Bundled to `dist/mcp-bridge.js`; Node built-ins only, no `vscode`.
 * Usage: `node mcp-bridge.js <discovery folder>`.
 */
import * as http from 'http';
import * as readline from 'readline';
import type { Readable, Writable } from 'stream';
import {
    DISCOVERY_DIR_ENV,
    NOT_RUNNING_MESSAGE,
    isPidAlive,
    orderEndpoints,
    readDiscoveryRecords,
    type DiscoveryRecord
} from './mcpDiscovery';

const MCP_PATH = '/mcp';
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';

export interface BridgeOptions {
    /** The folder holding the discovery files of the running VS Code windows. */
    discoveryDir: string;
    /** Prefer the window whose workspace contains this folder; default process.cwd(). */
    cwd?: string;
    /** Diagnostics; stdout is reserved for JSON-RPC. */
    log?: (message: string) => void;
    isAlive?: (pid: number) => boolean;
}

type JsonRpcId = string | number | null;

interface JsonRpcMessage {
    jsonrpc?: string;
    id?: JsonRpcId;
    method?: string;
    params?: Record<string, unknown>;
    result?: Record<string, unknown>;
    error?: { code?: number; message?: string };
}

interface HttpAnswer {
    status: number;
    contentType: string;
    body: string;
}

class Unreachable extends Error {}

function isRequest(message: JsonRpcMessage): boolean {
    return typeof message.method === 'string' && message.id !== undefined;
}

function errorReply(id: JsonRpcId, message: string, code = -32000): JsonRpcMessage {
    return { jsonrpc: '2.0', id, error: { code, message } };
}

function post(endpoint: DiscoveryRecord, body: string, headers: Record<string, string>): Promise<HttpAnswer> {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port: endpoint.port,
            path: MCP_PATH,
            method: 'POST',
            headers: {
                Authorization: `Bearer ${endpoint.token}`,
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                'Content-Length': Buffer.byteLength(body),
                ...headers
            }
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => resolve({
                status: res.statusCode ?? 0,
                contentType: String(res.headers['content-type'] ?? ''),
                body: Buffer.concat(chunks).toString('utf8')
            }));
            res.on('error', reject);
        });
        // Only a refused connection proves the request never arrived and may go to another window.
        req.on('error', (err: NodeJS.ErrnoException) => reject(err.code === 'ECONNREFUSED' ? new Unreachable(err.message) : err));
        req.end(body);
    });
}

/** The JSON-RPC messages of a response body: JSON, or the data lines of an event stream. */
function parseAnswer(answer: HttpAnswer): JsonRpcMessage[] {
    const text = answer.body.trim();
    if (!text) return [];
    const parsed: unknown[] = [];
    if (answer.contentType.includes('text/event-stream')) {
        for (const event of text.split(/\r?\n\r?\n/)) {
            const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
            if (data) parsed.push(JSON.parse(data));
        }
    } else {
        parsed.push(JSON.parse(text));
    }
    return parsed.flatMap((p) => (Array.isArray(p) ? p : [p])) as JsonRpcMessage[];
}

/** What the bridge answers itself while no VS Code window is reachable. */
function localReply(message: JsonRpcMessage): JsonRpcMessage | undefined {
    if (!isRequest(message)) return undefined;
    if (message.method === 'initialize') {
        const requested = message.params?.protocolVersion;
        return {
            jsonrpc: '2.0',
            id: message.id!,
            result: {
                protocolVersion: typeof requested === 'string' ? requested : FALLBACK_PROTOCOL_VERSION,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'postgres-query-booster', title: 'PostgreSQL Query Booster', version: 'bridge' },
                instructions: NOT_RUNNING_MESSAGE
            }
        };
    }
    if (message.method === 'ping') return { jsonrpc: '2.0', id: message.id!, result: {} };
    return errorReply(message.id!, NOT_RUNNING_MESSAGE);
}

/**
 * Serve MCP over the streams until the input ends; resolves once every
 * pending answer is written.
 */
export function runBridge(input: Readable, output: Writable, options: BridgeOptions): Promise<void> {
    const log = options.log ?? ((m: string) => process.stderr.write(`[postgres-query-booster bridge] ${m}\n`));
    const alive = options.isAlive ?? isPidAlive;
    const cwd = options.cwd ?? process.cwd();
    /** The version negotiated with a real server, sent on later requests as the HTTP transport asks. */
    let protocolVersion: string | undefined;
    const pending = new Set<Promise<void>>();

    const write = (messages: JsonRpcMessage[]): void => {
        if (messages.length === 0) return;
        output.write(`${JSON.stringify(messages.length === 1 ? messages[0] : messages)}\n`);
    };

    async function forward(payload: JsonRpcMessage | JsonRpcMessage[]): Promise<JsonRpcMessage[] | undefined> {
        const body = JSON.stringify(payload);
        const headers: Record<string, string> = protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {};
        for (const endpoint of orderEndpoints(readDiscoveryRecords(options.discoveryDir), cwd, alive)) {
            let answer: HttpAnswer;
            try {
                answer = await post(endpoint, body, headers);
            } catch (err: unknown) {
                if (err instanceof Unreachable) {
                    log(`VS Code window ${endpoint.pid} (port ${endpoint.port}) is not reachable: ${err.message}`);
                    continue;
                }
                throw err;
            }
            if (answer.status >= 200 && answer.status < 300) return parseAnswer(answer);
            let reason = `HTTP ${answer.status}`;
            try {
                const [first] = parseAnswer(answer);
                if (first?.error?.message) reason = first.error.message;
            } catch {
                // Not JSON; the status says enough.
            }
            throw new Error(`The MCP server of VS Code refused the request: ${reason}`);
        }
        return undefined;
    }

    async function handle(payload: JsonRpcMessage | JsonRpcMessage[]): Promise<void> {
        const messages = Array.isArray(payload) ? payload : [payload];
        let replies: JsonRpcMessage[] | undefined;
        try {
            replies = await forward(payload);
        } catch (err: unknown) {
            const reason = err instanceof Error ? err.message : String(err);
            log(reason);
            write(messages.filter(isRequest).map((m) => errorReply(m.id!, reason)));
            return;
        }
        if (replies === undefined) {
            write(messages.map(localReply).filter((r): r is JsonRpcMessage => r !== undefined));
            return;
        }
        const initialize = messages.find((m) => m.method === 'initialize' && isRequest(m));
        const initialized = initialize && replies.find((r) => r.id === initialize.id);
        const negotiated = initialized?.result?.protocolVersion;
        if (typeof negotiated === 'string') protocolVersion = negotiated;
        write(replies);
    }

    return new Promise((resolve) => {
        const lines = readline.createInterface({ input, crlfDelay: Infinity });
        lines.on('line', (line) => {
            if (!line.trim()) return;
            let payload: JsonRpcMessage | JsonRpcMessage[];
            try {
                payload = JSON.parse(line);
            } catch {
                write([errorReply(null, 'Parse error', -32700)]);
                return;
            }
            const job = handle(payload).catch((err: unknown) => log(err instanceof Error ? err.message : String(err)));
            pending.add(job);
            job.finally(() => pending.delete(job));
        });
        lines.on('close', () => {
            Promise.allSettled([...pending]).then(() => resolve());
        });
    });
}

function main(): void {
    const discoveryDir = process.argv[2] || process.env[DISCOVERY_DIR_ENV];
    if (!discoveryDir) {
        process.stderr.write(`Usage: mcp-bridge <discovery folder> (or set ${DISCOVERY_DIR_ENV})\n`);
        process.exit(2);
    }
    process.stdout.on('error', () => process.exit(0));
    runBridge(process.stdin, process.stdout, { discoveryDir }).then(() => process.stdout.write('', () => process.exit(0)));
}

if (require.main === module) main();
