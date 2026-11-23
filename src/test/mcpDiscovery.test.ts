import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    COPILOT_SERVER_NAME,
    copilotConfigFile,
    copilotServerEntry,
    copilotServerName,
    discoveryFilePath,
    editCopilotConfig,
    installBridgeFile,
    isInsideFolder,
    isPidAlive,
    orderEndpoints,
    readDiscoveryRecords,
    removeDiscoveryFile,
    removeStaleDiscoveryFiles,
    updateCopilotConfigFile,
    writeDiscoveryFile,
    writeFileAtomic,
    type ConfigFileIo,
    type DiscoveryRecord
} from '../mcpDiscovery';

function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pgqb-mcp-discovery-'));
}

const entry = copilotServerEntry('/opt/code/code', '/home/u/storage/mcp/mcp-bridge.js', '/home/u/storage/mcp/endpoints');

// ===== editCopilotConfig =====

test('editCopilotConfig creates the configuration when the file is missing or empty', () => {
    for (const text of [undefined, '', '  \n']) {
        const edit = editCopilotConfig(text, entry);
        assert.equal(edit.kind, 'write');
        assert.deepEqual(JSON.parse((edit as { text: string }).text), { mcpServers: { [COPILOT_SERVER_NAME]: entry } });
    }
    assert.deepEqual(editCopilotConfig(undefined, undefined), { kind: 'unchanged' }, 'nothing to remove from a missing file');
});

test('editCopilotConfig keeps every other server and unknown top-level key', () => {
    const text = JSON.stringify({ theme: 'dark', mcpServers: { playwright: { type: 'local', command: 'npx', args: ['@playwright/mcp'] } } });
    const edit = editCopilotConfig(text, entry);
    assert.equal(edit.kind, 'write');
    const written = JSON.parse((edit as { text: string }).text);
    assert.equal(written.theme, 'dark');
    assert.deepEqual(written.mcpServers.playwright, { type: 'local', command: 'npx', args: ['@playwright/mcp'] });
    assert.deepEqual(written.mcpServers[COPILOT_SERVER_NAME], entry);
    assert.ok((edit as { text: string }).text.includes('\n  "mcpServers"'), 'indented with two spaces');
});

test('editCopilotConfig writes nothing when the entry is already there, even with other key order', () => {
    const reordered = { tools: ['*'], env: { ELECTRON_RUN_AS_NODE: '1' }, args: entry.args, command: entry.command, type: 'local' };
    assert.deepEqual(editCopilotConfig(JSON.stringify({ mcpServers: { [COPILOT_SERVER_NAME]: reordered } }), entry), { kind: 'unchanged' });
});

test('editCopilotConfig updates an entry whose bridge path changed', () => {
    const old = { ...entry, args: ['/old/mcp-bridge.js', '/old/endpoints'] };
    const edit = editCopilotConfig(JSON.stringify({ mcpServers: { [COPILOT_SERVER_NAME]: old } }), entry);
    assert.equal(edit.kind, 'write');
    assert.deepEqual(JSON.parse((edit as { text: string }).text).mcpServers[COPILOT_SERVER_NAME].args, entry.args);
});

test('editCopilotConfig removes only its own entry', () => {
    const text = JSON.stringify({ mcpServers: { other: { type: 'http', url: 'https://x' }, [COPILOT_SERVER_NAME]: entry } });
    const edit = editCopilotConfig(text, undefined);
    assert.equal(edit.kind, 'write');
    assert.deepEqual(JSON.parse((edit as { text: string }).text), { mcpServers: { other: { type: 'http', url: 'https://x' } } });
    assert.deepEqual(editCopilotConfig(JSON.stringify({ mcpServers: { other: {} } }), undefined), { kind: 'unchanged' });
});

test('editCopilotConfig leaves malformed files alone', () => {
    assert.equal(editCopilotConfig('{ "mcpServers": { ', entry).kind, 'malformed');
    assert.equal(editCopilotConfig('[1, 2]', entry).kind, 'malformed');
    assert.equal(editCopilotConfig('{ "mcpServers": [] }', entry).kind, 'malformed');
    assert.equal(editCopilotConfig('{ "mcpServers": { } ', undefined).kind, 'malformed');
});

test('updateCopilotConfigFile creates the folder, is idempotent and never touches a malformed file', async () => {
    const dir = tempDir();
    try {
        const file = path.join(dir, '.copilot', 'mcp-config.json');
        assert.equal((await updateCopilotConfigFile(file, entry)).kind, 'write');
        const first = fs.statSync(file).mtimeMs;
        assert.equal((await updateCopilotConfigFile(file, entry)).kind, 'unchanged');
        assert.equal(fs.statSync(file).mtimeMs, first);
        assert.equal((await updateCopilotConfigFile(file, undefined)).kind, 'write');
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { mcpServers: {} });

        fs.writeFileSync(file, '{ broken');
        assert.equal((await updateCopilotConfigFile(file, entry)).kind, 'malformed');
        assert.equal(fs.readFileSync(file, 'utf8'), '{ broken');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/** Real file access whose `read` lets a test act as another program between two reads. */
function scriptedIo(onRead: (file: string, count: number) => void): ConfigFileIo & { reads: number; delays: number[] } {
    const io = {
        reads: 0,
        delays: [] as number[],
        read(file: string): string | undefined {
            onRead(file, ++io.reads);
            return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
        },
        delay(ms: number): Promise<void> {
            io.delays.push(ms);
            return Promise.resolve();
        }
    };
    return io;
}

test('updateCopilotConfigFile redoes its edit when another program changed the file after it was read', async () => {
    const dir = tempDir();
    try {
        const file = path.join(dir, 'mcp-config.json');
        fs.writeFileSync(file, JSON.stringify({ mcpServers: { a: { type: 'http', url: 'https://a' } } }));
        const io = scriptedIo((f, count) => {
            if (count === 2) fs.writeFileSync(f, JSON.stringify({ mcpServers: { a: { type: 'http', url: 'https://a' }, b: { type: 'http', url: 'https://b' } } }));
        });
        assert.equal((await updateCopilotConfigFile(file, entry, COPILOT_SERVER_NAME, undefined, io)).kind, 'write');
        const written = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.deepEqual(Object.keys(written.mcpServers).sort(), ['a', 'b', COPILOT_SERVER_NAME].sort(), 'the newer server b is kept');
        assert.deepEqual(written.mcpServers[COPILOT_SERVER_NAME], entry);
        assert.deepEqual(fs.readdirSync(dir), ['mcp-config.json'], 'no temporary file is left behind');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('updateCopilotConfigFile reads an empty file once more before it counts as empty', async () => {
    const dir = tempDir();
    try {
        const file = path.join(dir, 'mcp-config.json');
        const other = { mcpServers: { other: { type: 'http', url: 'https://x' } } };
        // Another program is half way through a non-atomic write: empty at first, complete a moment later.
        fs.writeFileSync(file, '');
        const io = scriptedIo((f, count) => { if (count === 2) fs.writeFileSync(f, JSON.stringify(other)); });
        assert.equal((await updateCopilotConfigFile(file, entry, COPILOT_SERVER_NAME, undefined, io)).kind, 'write');
        assert.equal(io.delays.filter((ms) => ms >= 150).length, 1, 'waited once before reading again');
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.other, other.mcpServers.other, 'the other server survives');

        // A file that stays empty is a configuration without servers.
        fs.writeFileSync(file, '  \n');
        const stays = scriptedIo(() => undefined);
        assert.equal((await updateCopilotConfigFile(file, entry, COPILOT_SERVER_NAME, undefined, stays)).kind, 'write');
        assert.equal(stays.delays.filter((ms) => ms >= 150).length, 1, 'waited once, then took the file as empty');
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { mcpServers: { [COPILOT_SERVER_NAME]: entry } });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('updateCopilotConfigFile does not rewrite a file whose text would stay the same', async () => {
    const dir = tempDir();
    try {
        const file = path.join(dir, 'mcp-config.json');
        const text = `${JSON.stringify({ mcpServers: { [COPILOT_SERVER_NAME]: entry } }, null, 2)}\n`;
        fs.writeFileSync(file, text);
        const before = fs.statSync(file).mtimeMs;
        assert.equal((await updateCopilotConfigFile(file, entry)).kind, 'unchanged');
        const removedElsewhere = await updateCopilotConfigFile(file, undefined, 'not-there');
        assert.equal(removedElsewhere.kind, 'unchanged');
        assert.equal(fs.readFileSync(file, 'utf8'), text);
        assert.equal(fs.statSync(file).mtimeMs, before);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('writeFileAtomic replaces an existing file in one step and leaves no temporary file', async () => {
    const dir = tempDir();
    try {
        const file = path.join(dir, 'sub', 'mcp-config.json');
        await writeFileAtomic(file, 'one');
        await writeFileAtomic(file, 'two');
        assert.equal(fs.readFileSync(file, 'utf8'), 'two');
        assert.deepEqual(fs.readdirSync(path.dirname(file)), ['mcp-config.json']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ===== installation names and ownership =====

test('copilotServerName keeps the documented name for Stable and gives other installations their own', () => {
    assert.equal(copilotServerName('vscode'), COPILOT_SERVER_NAME);
    assert.equal(copilotServerName(undefined), COPILOT_SERVER_NAME);
    assert.equal(copilotServerName('vscode-insiders'), 'postgres-query-booster-insiders');
    assert.equal(copilotServerName('vscodium'), 'postgres-query-booster-vscodium');
    assert.equal(copilotServerName('Cursor'), 'postgres-query-booster-cursor');
});

test('editCopilotConfig removes an entry only when it is exactly the given own entry', () => {
    const foreign = { ...entry, command: '/opt/code-insiders/code-insiders' };
    const text = JSON.stringify({ mcpServers: { [COPILOT_SERVER_NAME]: foreign } });
    assert.deepEqual(editCopilotConfig(text, undefined, COPILOT_SERVER_NAME, entry), { kind: 'unchanged' });
    const own = editCopilotConfig(JSON.stringify({ mcpServers: { [COPILOT_SERVER_NAME]: entry } }), undefined, COPILOT_SERVER_NAME, entry);
    assert.equal(own.kind, 'write');
    assert.deepEqual(JSON.parse((own as { text: string }).text), { mcpServers: {} });
});

test('copilotConfigFile honours COPILOT_HOME and defaults to ~/.copilot', () => {
    assert.equal(copilotConfigFile({}, path.resolve('/home/u')), path.join(path.resolve('/home/u'), '.copilot', 'mcp-config.json'));
    assert.equal(copilotConfigFile({ COPILOT_HOME: path.resolve('/cfg') }, path.resolve('/home/u')), path.join(path.resolve('/cfg'), 'mcp-config.json'));
});

// ===== endpoint selection =====

function record(pid: number, startedAt: string, workspaceFolders: string[] = []): DiscoveryRecord {
    return { pid, port: 1000 + pid, token: `t${pid}`, startedAt, workspaceFolders, version: '1' };
}

test('isInsideFolder matches the folder and below, without case on Windows', () => {
    assert.equal(isInsideFolder('C:\\Work\\Repo\\sql', 'c:\\work\\repo', 'win32'), true);
    assert.equal(isInsideFolder('C:\\Work\\Repo', 'C:\\Work\\Repo\\', 'win32'), true);
    assert.equal(isInsideFolder('C:\\Work\\Repo2', 'C:\\Work\\Repo', 'win32'), false);
    assert.equal(isInsideFolder('/work/Repo/sql', '/work/repo', 'linux'), false, 'case matters on POSIX');
    assert.equal(isInsideFolder('/work/repo/sql', '/work/repo', 'linux'), true);
    assert.equal(isInsideFolder('/work', '/work/repo', 'linux'), false);
});

test('orderEndpoints prefers the window whose workspace holds cwd, then the newest; dead pids are left out', () => {
    const records = [
        record(1, '2026-01-01T10:00:00Z', ['/work/a']),
        record(2, '2026-01-01T12:00:00Z', ['/work/b']),
        record(3, '2026-01-01T11:00:00Z', ['/work/c']),
        record(4, '2026-01-01T13:00:00Z', ['/work/a'])
    ];
    const alive = (pid: number) => pid !== 4;
    assert.deepEqual(orderEndpoints(records, '/work/a/sql', alive, 'linux').map((r) => r.pid), [1, 2, 3]);
    assert.deepEqual(orderEndpoints(records, '/elsewhere', alive, 'linux').map((r) => r.pid), [2, 3, 1]);
    assert.deepEqual(orderEndpoints(records, '/work/a', () => false, 'linux'), []);
});

test('isPidAlive knows the running process', () => {
    assert.equal(isPidAlive(process.pid), true);
    assert.equal(isPidAlive(0), false);
    assert.equal(isPidAlive(-5), false);
});

// ===== discovery files =====

test('discovery files are written, read, cleaned up for dead processes and removed', () => {
    const dir = path.join(tempDir(), 'endpoints');
    try {
        const file = writeDiscoveryFile(dir, record(process.pid, '2026-01-01T10:00:00Z', ['/w']));
        assert.equal(file, discoveryFilePath(dir, process.pid));
        writeDiscoveryFile(dir, record(424242, '2026-01-01T09:00:00Z'));
        fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
        fs.writeFileSync(path.join(dir, '7.json'), '{ half');
        if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

        assert.deepEqual(readDiscoveryRecords(dir).map((r) => r.pid).sort((a, b) => a - b), [424242, process.pid].sort((a, b) => a - b));
        assert.equal(removeStaleDiscoveryFiles(dir, (pid) => pid === process.pid), 1);
        assert.deepEqual(readDiscoveryRecords(dir).map((r) => r.pid), [process.pid]);

        removeDiscoveryFile(dir, process.pid);
        removeDiscoveryFile(dir, process.pid);
        assert.equal(fs.existsSync(file), false);
        assert.deepEqual(readDiscoveryRecords(path.join(dir, 'missing')), []);
    } finally {
        fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    }
});

test('installBridgeFile copies the bridge only when it changed', () => {
    const dir = tempDir();
    try {
        const source = path.join(dir, 'dist', 'mcp-bridge.js');
        const target = path.join(dir, 'storage', 'mcp', 'mcp-bridge.js');
        fs.mkdirSync(path.dirname(source), { recursive: true });
        fs.writeFileSync(source, 'one');
        assert.equal(installBridgeFile(source, target), true);
        assert.equal(installBridgeFile(source, target), false);
        fs.writeFileSync(source, 'two');
        assert.equal(installBridgeFile(source, target), true);
        assert.equal(fs.readFileSync(target, 'utf8'), 'two');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
