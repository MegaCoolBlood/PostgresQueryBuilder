import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionConfig, ConnectionManager } from './connectionManager';
import { Logger, getErrorMessage } from './logger';

/** Shown to the server as `application_name`, so the session is recognisable in `pg_stat_activity`. */
export const PSQL_APPLICATION_NAME = 'PostgreSQL Query Booster console';

/**
 * Escape a value for `PGOPTIONS`, which libpq splits at unescaped whitespace;
 * a backslash escapes the next character.
 */
export function escapePgOption(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/\s/g, m => `\\${m}`);
}

/**
 * The libpq environment that connects `psql` to the given connection. The
 * password travels as `PGPASSWORD`, so it never appears on the command line or
 * in the terminal; a `search_path` override of the active connection is applied
 * through `PGOPTIONS` so the console resolves names like the rest of the
 * extension does.
 */
export function buildPsqlEnvironment(
    config: ConnectionConfig,
    password: string | undefined,
    searchPath?: string | null
): Record<string, string> {
    const env: Record<string, string> = {
        PGHOST: config.host,
        PGPORT: String(config.port),
        PGDATABASE: config.database,
        PGUSER: config.user,
        PGAPPNAME: PSQL_APPLICATION_NAME
    };
    if (password) {
        env.PGPASSWORD = password;
    }
    if (searchPath && searchPath.trim() !== '') {
        env.PGOPTIONS = `-c search_path=${escapePgOption(searchPath.trim())}`;
    }
    return env;
}

/** The title of the terminal tab, naming the connection it talks to. */
export function psqlTerminalName(config: ConnectionConfig): string {
    return `psql: ${config.name}`;
}

/** File-system access needed to locate psql, injectable for tests. */
export interface PsqlLocatorHost {
    platform: NodeJS.Platform;
    env: Record<string, string | undefined>;
    isFile(p: string): boolean;
    listDirectory(p: string): string[];
}

/** Sort PostgreSQL installation folders (`17`, `9.6`, `16beta1`) newest first. */
export function sortVersionsDescending(names: string[]): string[] {
    const key = (n: string) => n.split(/[^0-9]+/).filter(Boolean).map(Number);
    return [...names].sort((a, b) => {
        const ka = key(a), kb = key(b);
        for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
            const d = (kb[i] ?? -1) - (ka[i] ?? -1);
            if (d !== 0) return d;
        }
        return b.localeCompare(a);
    });
}

/**
 * Find the psql executable. A configured path wins (a folder is completed with
 * the executable name); otherwise every `PATH` entry is searched, and on Windows
 * the default installer locations `%ProgramFiles%\PostgreSQL\<version>\bin`,
 * newest version first. Returns `null` when psql cannot be found.
 */
export function locatePsql(configuredPath: string, host: PsqlLocatorHost): string | null {
    const win = host.platform === 'win32';
    const pathApi = win ? path.win32 : path.posix;
    const exe = win ? 'psql.exe' : 'psql';
    const configured = (configuredPath || '').trim().replace(/^"(.*)"$/, '$1');
    if (configured) {
        if (host.isFile(configured)) return configured;
        const inFolder = pathApi.join(configured, exe);
        return host.isFile(inFolder) ? inFolder : null;
    }
    const pathVar = host.env.PATH ?? host.env.Path ?? '';
    for (const dir of pathVar.split(win ? ';' : ':')) {
        const clean = dir.trim().replace(/^"(.*)"$/, '$1');
        if (!clean) continue;
        const candidate = pathApi.join(clean, exe);
        if (host.isFile(candidate)) return candidate;
    }
    if (win) {
        const roots = [host.env.ProgramFiles, host.env['ProgramFiles(x86)']].filter((r): r is string => !!r);
        for (const root of roots) {
            const base = pathApi.join(root, 'PostgreSQL');
            for (const version of sortVersionsDescending(host.listDirectory(base))) {
                const candidate = pathApi.join(base, version, 'bin', exe);
                if (host.isFile(candidate)) return candidate;
            }
        }
    }
    return null;
}

const nodeLocatorHost: PsqlLocatorHost = {
    platform: process.platform,
    env: process.env,
    isFile: (p) => {
        try { return fs.statSync(p).isFile(); } catch { return false; }
    },
    listDirectory: (p) => {
        try { return fs.readdirSync(p); } catch { return []; }
    }
};

/** Opens `psql` for the active connection in a VS Code terminal. */
export class PsqlConsole {
    constructor(
        private readonly connectionManager: ConnectionManager,
        private readonly locatorHost: PsqlLocatorHost = nodeLocatorHost
    ) {}

    async open(): Promise<vscode.Terminal | undefined> {
        if (!(await this.connectionManager.ensureConnected())) return undefined;
        const config = this.connectionManager.getActiveConnectionConfig();
        if (!config) return undefined;

        const configured = vscode.workspace.getConfiguration('postgresQueryBuilder').get<string>('psqlPath', '');
        const psqlPath = locatePsql(configured, this.locatorHost);
        if (!psqlPath) {
            const message = configured
                ? `psql was not found at "${configured}". Check the setting postgresQueryBuilder.psqlPath.`
                : 'psql was not found on PATH or in the default PostgreSQL installation folders. Install the PostgreSQL client tools or set postgresQueryBuilder.psqlPath.';
            const choice = await vscode.window.showErrorMessage(message, 'Open Settings');
            if (choice === 'Open Settings') {
                await vscode.commands.executeCommand('workbench.action.openSettings', 'postgresQueryBuilder.psqlPath');
            }
            return undefined;
        }

        let password: string | undefined;
        try {
            password = await this.connectionManager.getStoredPassword(config.name);
        } catch (err: unknown) {
            Logger.error('PsqlConsole.open', err);
            vscode.window.showWarningMessage(`The stored password could not be read, psql will ask for it: ${getErrorMessage(err)}`);
        }

        Logger.log('psqlConsole', `Opening ${psqlPath} for connection "${config.name}"`);
        const terminal = vscode.window.createTerminal({
            name: psqlTerminalName(config),
            shellPath: psqlPath,
            env: buildPsqlEnvironment(config, password, this.connectionManager.getSearchPathOverride()),
            iconPath: new vscode.ThemeIcon('terminal'),
            // Never restore the session after a reload: its environment holds the password.
            isTransient: true
        });
        terminal.show();
        return terminal;
    }
}
