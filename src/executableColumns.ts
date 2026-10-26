import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { DbSession, DbSessionRef } from './dbSession';
import { isResultQuery, queryViewTitle, splitStatements, type StatementOutcome } from './sqlFileSession';
import { getErrorMessage, Logger } from './logger';

/** What a click on a value of an executable column does. */
export type ExecutableKind = 'dataViewer' | 'statement' | 'psql' | 'powershell' | 'url' | 'file' | 'copy';

/**
 * A kind of executable column: a result column whose name starts with `prefix`
 * gets a run button in each of its cells.
 *
 * NOTE: src/webview/tableView.js keeps a copy of this table, because the
 * webview cannot import from src/; src/test/executableColumns.test.ts keeps
 * the two in sync.
 */
export interface ExecutableColumnType {
    prefix: string;
    kind: ExecutableKind;
    /** What the run button does, as the context menus and the quick pick name it. */
    label: string;
    /** The tooltip of the run button. */
    action: string;
    /** Every run is confirmed first, showing the exact text that will run. */
    confirm: boolean;
}

export const EXECUTABLE_COLUMN_TYPES: ReadonlyArray<ExecutableColumnType> = [
    { prefix: 'sql_', kind: 'dataViewer', label: 'Open in Data Viewer', action: 'Open this query in a new Data Viewer', confirm: false },
    { prefix: 'pgsql_', kind: 'statement', label: 'Run as Statement', action: 'Run this statement in the database session of this Data Viewer', confirm: true },
    { prefix: 'psql_', kind: 'psql', label: 'Send to psql Console', action: 'Send this to the psql console of the connection', confirm: true },
    { prefix: 'ps_', kind: 'powershell', label: 'Run in PowerShell', action: 'Run this command in a PowerShell terminal', confirm: true },
    { prefix: 'url_', kind: 'url', label: 'Open in Browser', action: 'Open this link in the browser', confirm: false },
    { prefix: 'file_', kind: 'file', label: 'Open File in Editor', action: 'Open this file in the editor', confirm: false },
    { prefix: 'copy_', kind: 'copy', label: 'Copy to Clipboard', action: 'Copy this value to the clipboard', confirm: false }
];

/** The type a column name asks for through its prefix (in any letter case), or undefined. */
export function executableColumnType(name: string): ExecutableColumnType | undefined {
    const lower = String(name ?? '').toLowerCase();
    return EXECUTABLE_COLUMN_TYPES.find((type) => lower.startsWith(type.prefix) && lower.length > type.prefix.length);
}

/** An entry of the "Make Column Executable" quick pick; `prefix` is '' for "not executable". */
export interface ExecutableTypePick extends vscode.QuickPickItem {
    prefix: string;
}

/** The choices offered for a column whose current type is `current`. */
export function executableTypePickItems(current: ExecutableColumnType | undefined): ExecutableTypePick[] {
    const items: ExecutableTypePick[] = EXECUTABLE_COLUMN_TYPES.map((type) => ({
        label: type.label,
        description: `${type.prefix}…` + (current?.kind === type.kind ? ' (current)' : ''),
        detail: type.action + (type.confirm ? ', after asking every time' : ''),
        prefix: type.prefix
    }));
    if (current) {
        items.push({ label: 'Not Executable', description: `removes ${current.prefix}`, detail: 'Show the values as ordinary text again', prefix: '' });
    }
    return items;
}

/** How running a value ended, as the Data Viewer marks the cell. */
export type ExecutableOutcome =
    | StatementOutcome
    | { status: 'sent'; message: string }
    | { status: 'opened' }
    | { status: 'copied' };

/** At most `limit` characters of `text` for a dialog, saying how much was left out. */
export function clipText(text: string, limit = 2000): string {
    return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)` : text;
}

/** The question asked before a value runs, or null for a type that runs without asking. */
export function executableConfirmation(
    type: ExecutableColumnType,
    value: string,
    where: { session?: string; connection?: string }
): { message: string; detail: string; action: string } | null {
    if (!type.confirm) {
        return null;
    }
    const detail = `${clipText(value)}\n\nThis text comes from the query result. Run it only if you trust the data it was read from.`;
    switch (type.kind) {
        case 'statement':
            return { message: `Run this statement in the database session of "${where.session ?? 'this Data Viewer'}"?`, detail, action: 'Run' };
        case 'psql':
            return { message: `Send this to the psql console of "${where.connection ?? 'the active connection'}"?`, detail, action: 'Send' };
        case 'powershell':
            return { message: 'Run this command in PowerShell?', detail, action: 'Run' };
        default:
            return null;
    }
}

/** The link of a `url_` value when it is an http or https link, otherwise null. */
export function httpUrl(value: string): string | null {
    try {
        const url = new URL(String(value ?? '').trim());
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
        return null;
    }
}

/**
 * The file a `file_` value names: an absolute path, a `file:` URI, or a path
 * relative to the first workspace folder. Surrounding double quotes, as
 * Windows' "Copy as path" adds them, are dropped.
 */
export function resolveFileValue(
    value: string,
    workspaceFolders: ReadonlyArray<string>,
    pathApi: path.PlatformPath = path
): { path: string } | { error: string } {
    const text = String(value ?? '').trim().replace(/^"([\s\S]*)"$/, '$1').trim();
    if (text === '') {
        return { error: 'The value is empty.' };
    }
    if (/^file:/i.test(text)) {
        try {
            return { path: fileURLToPath(text) };
        } catch {
            return { error: `"${text}" is not a valid file URI.` };
        }
    }
    const scheme = /^([a-z][a-z0-9+.-]+):\/\//i.exec(text);
    if (scheme) {
        return { error: `Only file paths and file: URIs are opened, not ${scheme[1]}: links.` };
    }
    if (pathApi.isAbsolute(text)) {
        return { path: pathApi.normalize(text) };
    }
    if (workspaceFolders.length === 0) {
        return { error: `"${text}" is a relative path, which needs an open workspace folder.` };
    }
    return { path: pathApi.resolve(workspaceFolders[0], text) };
}

/**
 * What psql receives for a `psql_` value. A statement without a closing
 * semicolon gets one, or psql would sit waiting for the rest of it; a
 * backslash command is sent as it is.
 */
export function psqlInput(value: string): string {
    const text = String(value ?? '').trim();
    if (text === '' || text.startsWith('\\') || /;\s*$/.test(text)) {
        return text;
    }
    return `${text};`;
}

/** The PowerShell that runs `ps_` values: Windows PowerShell on Windows, PowerShell 7 elsewhere. */
export function powershellPath(platform: NodeJS.Platform): string {
    return platform === 'win32' ? 'powershell.exe' : 'pwsh';
}

export const POWERSHELL_TERMINAL_NAME = 'PowerShell: Data Viewer';

/** What the runner needs from the rest of the extension. */
export interface ExecutableValueHost {
    ensureConnected(): Promise<boolean>;
    connectionName(): string | undefined;
    /** Changes with every connect, disconnect and search_path change. */
    connectionGeneration(): number;
    openQueryView(sql: string, title: string, ref: DbSessionRef | undefined): Promise<void>;
    executeStatement(session: DbSession, label: string, sql: string): Promise<StatementOutcome>;
    openPsqlConsole(): Promise<vscode.Terminal | undefined>;
}

/** The Data Viewer a value comes from. */
export interface ExecutableTarget {
    session?: DbSession;
    ref?: DbSessionRef;
}

/** Types that need a database connection. */
const NEEDS_CONNECTION: ReadonlySet<ExecutableKind> = new Set(['dataViewer', 'statement', 'psql']);

/**
 * Runs the value of an executable column: opens it, runs it or sends it to a
 * terminal, according to the prefix of its column. The psql console and the
 * PowerShell terminal are reused while they are open.
 */
export class ExecutableValueRunner {
    private psql: { terminal: vscode.Terminal; generation: number } | undefined;
    private powershell: vscode.Terminal | undefined;

    constructor(
        private readonly host: ExecutableValueHost,
        private readonly platform: NodeJS.Platform = process.platform
    ) {}

    async run(type: ExecutableColumnType, value: string, target: ExecutableTarget): Promise<ExecutableOutcome> {
        const text = String(value ?? '');
        let outcome: ExecutableOutcome;
        if (text.trim() === '') {
            outcome = { status: 'failed', message: 'The cell is empty, so there is nothing to run.' };
        } else if (NEEDS_CONNECTION.has(type.kind) && !await this.host.ensureConnected()) {
            outcome = { status: 'cancelled' };
        } else {
            const question = executableConfirmation(type, text, {
                session: target.session?.label ?? target.ref?.label,
                connection: this.host.connectionName()
            });
            const answer = question
                ? await vscode.window.showWarningMessage(question.message, { modal: true, detail: question.detail }, question.action)
                : undefined;
            if (question && answer !== question.action) {
                outcome = { status: 'cancelled' };
            } else {
                try {
                    outcome = await this.perform(type, text, target);
                } catch (err: unknown) {
                    Logger.error('ExecutableValueRunner.run', err);
                    outcome = { status: 'failed', message: getErrorMessage(err) };
                }
            }
        }
        if (outcome.status === 'executed') {
            vscode.window.showInformationMessage(outcome.message);
        } else if (outcome.status === 'failed') {
            vscode.window.showErrorMessage(`${type.label} failed: ${outcome.message}`);
        }
        return outcome;
    }

    private async perform(type: ExecutableColumnType, text: string, target: ExecutableTarget): Promise<ExecutableOutcome> {
        switch (type.kind) {
            case 'dataViewer': {
                const statements = splitStatements(text);
                if (statements.length !== 1 || !isResultQuery(statements[0])) {
                    return {
                        status: 'failed',
                        message: 'A sql_ value has to be one query returning rows (SELECT, WITH … SELECT, VALUES or TABLE). '
                            + 'Use the pgsql_ prefix to run other statements.'
                    };
                }
                await this.host.openQueryView(statements[0], queryViewTitle(statements[0]), target.ref);
                return { status: 'opened' };
            }
            case 'statement':
                if (!target.session) {
                    return { status: 'failed', message: 'This Data Viewer has no database session to run the statement in.' };
                }
                return this.host.executeStatement(target.session, target.session.label, text);
            case 'psql': {
                const terminal = await this.psqlTerminal();
                if (!terminal) {
                    // The console has already said why it could not start.
                    return { status: 'cancelled' };
                }
                terminal.show();
                terminal.sendText(psqlInput(text), true);
                return { status: 'sent', message: `Sent to the psql console of "${this.host.connectionName() ?? 'the active connection'}".` };
            }
            case 'powershell': {
                if (!this.isOpen(this.powershell)) {
                    this.powershell = vscode.window.createTerminal({
                        name: POWERSHELL_TERMINAL_NAME,
                        shellPath: powershellPath(this.platform),
                        iconPath: new vscode.ThemeIcon('terminal-powershell')
                    });
                }
                this.powershell.show();
                this.powershell.sendText(text, true);
                return { status: 'sent', message: 'Sent to the PowerShell terminal.' };
            }
            case 'url': {
                const href = httpUrl(text);
                if (!href) {
                    return { status: 'failed', message: `Only http and https links are opened, and "${clipText(text.trim(), 200)}" is none.` };
                }
                const opened = await vscode.env.openExternal(vscode.Uri.parse(href, true));
                return opened ? { status: 'opened' } : { status: 'cancelled' };
            }
            case 'file': {
                const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
                const resolved = resolveFileValue(text, folders);
                if ('error' in resolved) {
                    return { status: 'failed', message: resolved.error };
                }
                let stat: fs.Stats;
                try {
                    stat = await fs.promises.stat(resolved.path);
                } catch {
                    return { status: 'failed', message: `The file "${resolved.path}" does not exist.` };
                }
                if (stat.isDirectory()) {
                    return { status: 'failed', message: `"${resolved.path}" is a folder, not a file.` };
                }
                await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(resolved.path));
                return { status: 'opened' };
            }
            case 'copy':
                await vscode.env.clipboard.writeText(text);
                vscode.window.setStatusBarMessage('Copied to the clipboard.', 3000);
                return { status: 'copied' };
        }
    }

    /** The psql console of the active connection, opened when there is none yet. */
    private async psqlTerminal(): Promise<vscode.Terminal | undefined> {
        const generation = this.host.connectionGeneration();
        if (this.psql && this.psql.generation === generation && this.isOpen(this.psql.terminal)) {
            return this.psql.terminal;
        }
        const terminal = await this.host.openPsqlConsole();
        this.psql = terminal ? { terminal, generation } : undefined;
        return terminal;
    }

    private isOpen(terminal: vscode.Terminal | undefined): terminal is vscode.Terminal {
        return !!terminal && terminal.exitStatus === undefined && vscode.window.terminals.includes(terminal);
    }
}
