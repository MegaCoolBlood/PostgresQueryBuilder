/**
 * How agents outside VS Code (GitHub Copilot CLI, Copilot SDK agents) reach
 * the extension's MCP server. The server listens on a random port with a token
 * made anew in every VS Code session, so each extension host writes a
 * discovery file (`<pid>.json`, readable by the user only) that the stdio
 * bridge `mcpBridge` reads to find it; and the bridge is entered once into
 * Copilot CLI's `mcp-config.json`, which holds no secret.
 *
 * Node built-ins only: the bridge bundles this module and runs without VS Code.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';

/** The name of the server in Copilot CLI's `mcp-config.json` (VS Code Stable's; see {@link copilotServerName}). */
export const COPILOT_SERVER_NAME = 'postgres-query-booster';

/**
 * The entry name of one VS Code installation, from its URI scheme
 * (`vscode.env.uriScheme`): Stable keeps {@link COPILOT_SERVER_NAME}, Insiders
 * gets `postgres-query-booster-insiders`, any other editor
 * `postgres-query-booster-<scheme>`. Each installation has its own bridge
 * and discovery folder, so the entries must not overwrite each other.
 */
export function copilotServerName(uriScheme: string | undefined): string {
    const scheme = (uriScheme ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!scheme || scheme === 'vscode') return COPILOT_SERVER_NAME;
    const suffix = scheme.startsWith('vscode-') ? scheme.slice('vscode-'.length) : scheme;
    return `${COPILOT_SERVER_NAME}-${suffix}`;
}
/** Environment variable naming the discovery folder, when the bridge gets no argument. */
export const DISCOVERY_DIR_ENV = 'PGQB_MCP_DISCOVERY_DIR';
export const NOT_RUNNING_MESSAGE = 'PostgreSQL Query Booster is not running: open VS Code with the extension and postgresQueryBuilder.mcp.enabled turned on.';

/** What an extension host publishes about its running MCP server. */
export interface DiscoveryRecord {
    port: number;
    token: string;
    pid: number;
    workspaceFolders: string[];
    startedAt: string;
    version: string;
}

// ===== Discovery files =====

/** True while a process with this id exists; a process of another user (EPERM) counts as alive. */
export function isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err: unknown) {
        return (err as NodeJS.ErrnoException)?.code === 'EPERM';
    }
}

export function discoveryFilePath(dir: string, pid: number): string {
    return path.join(dir, `${pid}.json`);
}

/** Write the record as `<pid>.json`, readable by the user only, replacing it in one step. */
export function writeDiscoveryFile(dir: string, record: DiscoveryRecord): string {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = discoveryFilePath(dir, record.pid);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(record, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
    return file;
}

export function removeDiscoveryFile(dir: string, pid: number): void {
    fs.rmSync(discoveryFilePath(dir, pid), { force: true });
}

function asRecord(value: unknown): DiscoveryRecord | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const r = value as Partial<DiscoveryRecord>;
    if (!Number.isInteger(r.port) || !Number.isInteger(r.pid) || typeof r.token !== 'string' || !r.token) return undefined;
    return {
        port: r.port!,
        token: r.token,
        pid: r.pid!,
        workspaceFolders: Array.isArray(r.workspaceFolders) ? r.workspaceFolders.filter((f): f is string => typeof f === 'string') : [],
        startedAt: typeof r.startedAt === 'string' ? r.startedAt : '',
        version: typeof r.version === 'string' ? r.version : ''
    };
}

/** Every readable discovery record of the folder; unreadable or foreign files are skipped. */
export function readDiscoveryRecords(dir: string): DiscoveryRecord[] {
    let names: string[];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];
    }
    const records: DiscoveryRecord[] = [];
    for (const name of names) {
        if (!/^\d+\.json$/.test(name)) continue;
        try {
            const record = asRecord(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
            if (record) records.push(record);
        } catch {
            // Being written by another window or damaged; the next read tries again.
        }
    }
    return records;
}

/** Delete the discovery files of processes that are gone; returns how many. */
export function removeStaleDiscoveryFiles(dir: string, alive: (pid: number) => boolean = isPidAlive): number {
    let removed = 0;
    for (const record of readDiscoveryRecords(dir)) {
        if (alive(record.pid)) continue;
        removeDiscoveryFile(dir, record.pid);
        removed++;
    }
    return removed;
}

/** True when `cwd` is `folder` or lies below it; Windows paths compare without case. */
export function isInsideFolder(cwd: string, folder: string, platform: NodeJS.Platform = process.platform): boolean {
    const p = platform === 'win32' ? path.win32 : path.posix;
    const fold = (s: string) => (platform === 'win32' ? s.toLowerCase() : s);
    const relative = p.relative(fold(p.resolve(folder)), fold(p.resolve(cwd)));
    return relative === '' || (!relative.startsWith('..') && !p.isAbsolute(relative));
}

/**
 * The live endpoints in the order the bridge tries them: those with a
 * workspace folder containing `cwd` first, then the others; newest first in each.
 */
export function orderEndpoints(
    records: readonly DiscoveryRecord[],
    cwd: string,
    alive: (pid: number) => boolean = isPidAlive,
    platform: NodeJS.Platform = process.platform
): DiscoveryRecord[] {
    const matches = (r: DiscoveryRecord) => r.workspaceFolders.some((f) => isInsideFolder(cwd, f, platform));
    return records
        .filter((r) => alive(r.pid))
        .map((r) => ({ r, match: matches(r) }))
        .sort((a, b) => Number(b.match) - Number(a.match) || b.r.startedAt.localeCompare(a.r.startedAt))
        .map((x) => x.r);
}

// ===== Copilot CLI configuration =====

export interface CopilotServerEntry {
    type: 'local';
    command: string;
    args: string[];
    env: Record<string, string>;
    tools: string[];
}

/** Copilot CLI's configuration folder: `$COPILOT_HOME`, else `~/.copilot`. */
export function copilotHome(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
    const configured = env.COPILOT_HOME?.trim();
    return configured ? configured : path.join(home, '.copilot');
}

export function copilotConfigFile(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
    return path.join(copilotHome(env, home), 'mcp-config.json');
}

/** The entry that starts the bridge with VS Code's own executable running as Node. */
export function copilotServerEntry(nodeCommand: string, bridgeFile: string, discoveryDir: string): CopilotServerEntry {
    return {
        type: 'local',
        command: nodeCommand,
        args: [bridgeFile, discoveryDir],
        env: { ELECTRON_RUN_AS_NODE: '1' },
        tools: ['*']
    };
}

export type ConfigEdit =
    | { kind: 'unchanged' }
    | { kind: 'write'; text: string }
    | { kind: 'malformed'; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Set (or with `entry` undefined, remove) our server in the text of an
 * `mcp-config.json`, `undefined` for a missing file. Every other server and
 * key is kept; text that is not a JSON object is left alone. With `ownEntry`
 * given, a removal only takes an entry that equals it, so the entry another
 * installation wrote under the same name stays.
 */
export function editCopilotConfig(
    text: string | undefined,
    entry: CopilotServerEntry | undefined,
    name: string = COPILOT_SERVER_NAME,
    ownEntry?: CopilotServerEntry
): ConfigEdit {
    let config: Record<string, unknown> = {};
    if (text !== undefined && text.trim() !== '') {
        let parsed: unknown;
        try {
            parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
        } catch (err: unknown) {
            return { kind: 'malformed', error: err instanceof Error ? err.message : String(err) };
        }
        if (!isPlainObject(parsed)) return { kind: 'malformed', error: 'the file does not hold a JSON object' };
        config = parsed;
    }
    if (config.mcpServers !== undefined && !isPlainObject(config.mcpServers)) {
        return { kind: 'malformed', error: '"mcpServers" is not an object' };
    }
    const servers: Record<string, unknown> = { ...(config.mcpServers as Record<string, unknown> | undefined) };
    if (entry === undefined) {
        if (!(name in servers)) return { kind: 'unchanged' };
        if (ownEntry !== undefined && !isDeepStrictEqual(servers[name], ownEntry)) return { kind: 'unchanged' };
        delete servers[name];
    } else {
        if (isDeepStrictEqual(servers[name], entry)) return { kind: 'unchanged' };
        servers[name] = entry;
    }
    return { kind: 'write', text: `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n` };
}

/** File access of {@link updateCopilotConfigFile}; tests replace it to simulate a concurrent writer. */
export interface ConfigFileIo {
    /** The file's text, `undefined` when it does not exist. */
    read(file: string): string | undefined;
    delay(ms: number): Promise<void>;
}

const defaultConfigIo: ConfigFileIo = {
    read: (file) => {
        try {
            return fs.readFileSync(file, 'utf8');
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
            throw err;
        }
    },
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};

/** How long to wait before reading an empty file again: it may be in the middle of a non-atomic write. */
const EMPTY_FILE_RETRY_MS = 150;
/** How often the edit is redone when the file changes between reading and writing. */
const MAX_EDIT_ATTEMPTS = 5;

/**
 * Replace `file` with `text` in one step: write a temporary file in the same
 * folder and rename it over the target, so a concurrent reader sees the old or
 * the new content, never a truncated file. On Windows the rename fails while
 * another process has the file open; it is retried briefly.
 */
export async function writeFileAtomic(file: string, text: string, delay: (ms: number) => Promise<void> = defaultConfigIo.delay): Promise<void> {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let mode: number | undefined;
    try {
        if (process.platform !== 'win32') mode = fs.statSync(file).mode & 0o777;
    } catch {
        // A new file gets the default permissions.
    }
    const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    fs.writeFileSync(temp, text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
    try {
        for (let attempt = 1; ; attempt++) {
            try {
                fs.renameSync(temp, file);
                return;
            } catch (err: unknown) {
                const code = (err as NodeJS.ErrnoException)?.code;
                if (attempt >= 6 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
                await delay(25 * attempt);
            }
        }
    } finally {
        fs.rmSync(temp, { force: true });
    }
}

/**
 * Apply {@link editCopilotConfig} to the file, creating it and its folder when
 * needed. Other programs (Copilot CLI, other VS Code windows) share the file,
 * so it is replaced atomically, an edit is redone when the file changed since
 * it was read, an empty file is read once more before it counts as `{}`, and
 * nothing is written when the text would stay the same.
 */
export async function updateCopilotConfigFile(
    file: string,
    entry: CopilotServerEntry | undefined,
    name: string = COPILOT_SERVER_NAME,
    ownEntry?: CopilotServerEntry,
    io: ConfigFileIo = defaultConfigIo
): Promise<ConfigEdit> {
    const readSettled = async (): Promise<string | undefined> => {
        const first = io.read(file);
        if (first === undefined || first.trim() !== '') return first;
        await io.delay(EMPTY_FILE_RETRY_MS);
        return io.read(file);
    };
    let text = await readSettled();
    for (let attempt = 1; ; attempt++) {
        const edit = editCopilotConfig(text, entry, name, ownEntry);
        if (edit.kind !== 'write') return edit;
        if (edit.text === text) return { kind: 'unchanged' };
        if (io.read(file) === text) {
            await writeFileAtomic(file, edit.text, io.delay);
            return edit;
        }
        if (attempt >= MAX_EDIT_ATTEMPTS) throw new Error(`${file} keeps changing; it was left unchanged.`);
        text = await readSettled();
    }
}

/** Our entry of the file, if it has one. */
export function readCopilotServerEntry(file: string, name: string = COPILOT_SERVER_NAME): unknown {
    try {
        const config: unknown = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        return isPlainObject(config) && isPlainObject(config.mcpServers) ? config.mcpServers[name] : undefined;
    } catch {
        return undefined;
    }
}

/** Copy the bundled bridge to its stable place unless the copy there is identical; true when written. */
export function installBridgeFile(source: string, target: string): boolean {
    const content = fs.readFileSync(source);
    try {
        if (content.equals(fs.readFileSync(target))) return false;
    } catch {
        // Not installed yet.
    }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, content);
    fs.renameSync(temp, target);
    return true;
}
