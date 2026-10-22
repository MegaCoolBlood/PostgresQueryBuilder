import * as vscode from 'vscode';
import * as path from 'path';
import type { QueryResult } from 'pg';
import type { ConnectionManager } from './connectionManager';
import type { DbSession, DbSessionManager, DbSessionRef, SessionNotice } from './dbSession';
import { isModifyingSql, type ModifyHistoryStore } from './modifyHistoryStore';
import { getErrorMessage, Logger } from './logger';

/** The output channel that shows what the server says besides results. */
export const MESSAGES_CHANNEL_NAME = 'PostgreSQL Messages';

/** How an open SQL file holds its session. */
const FILE_HOLDER = 'file';

/** The session of a SQL file, shared by the Data Viewers opened from it. */
export function fileSessionRef(uri: { toString(): string }, fileName: string): DbSessionRef {
    return { key: `file:${uri.toString()}`, label: path.basename(fileName) };
}

/** Bounds of the text in `[start, end)` without surrounding blanks, or null when it is blank. */
function trimmedRange(masked: string, start: number, end: number): { start: number; end: number } | null {
    while (start < end && /\s/.test(masked[start])) start++;
    while (end > start && /\s/.test(masked[end - 1])) end--;
    return start < end ? { start, end } : null;
}

/**
 * A copy of `text` in which comments are blanked and strings, quoted names and
 * dollar-quoted bodies are filled with `_`, so a semicolon is left only where
 * it ends a statement and a statement still ends at its closing quote.
 * Offsets and line breaks are kept.
 */
export function codeMask(text: string): string {
    const out = text.split('');
    const n = text.length;
    const fill = (from: number, to: number, ch: string): void => {
        for (let k = from; k < to && k < n; k++) {
            if (out[k] !== '\n' && out[k] !== '\r') out[k] = ch;
        }
    };
    let i = 0;
    while (i < n) {
        const c = text[i];
        const c2 = text[i + 1];
        if (c === '-' && c2 === '-') {
            let j = i + 2;
            while (j < n && text[j] !== '\n') j++;
            fill(i, j, ' ');
            i = j;
            continue;
        }
        // Block comments nest in PostgreSQL.
        if (c === '/' && c2 === '*') {
            let j = i + 2;
            let depth = 1;
            while (j < n && depth > 0) {
                if (text[j] === '/' && text[j + 1] === '*') { depth++; j += 2; }
                else if (text[j] === '*' && text[j + 1] === '/') { depth--; j += 2; }
                else j++;
            }
            fill(i, j, ' ');
            i = j;
            continue;
        }
        if (c === "'" || c === '"') {
            // Only an E'…' string knows backslash escapes.
            const escapes = c === "'" && /[eE]/.test(text[i - 1] ?? '') && !/[A-Za-z0-9_]/.test(text[i - 2] ?? '');
            let j = i + 1;
            while (j < n) {
                if (escapes && text[j] === '\\') { j += 2; continue; }
                if (text[j] === c) {
                    if (text[j + 1] === c) { j += 2; continue; }
                    j++;
                    break;
                }
                j++;
            }
            fill(i, j, '_');
            i = j;
            continue;
        }
        // A `$` inside a name (`a$b$c`) or a positional parameter (`$1`) does
        // not start a dollar quote, and a tag never starts with a digit.
        if (c === '$' && !/[A-Za-z0-9_$\u0080-\uffff]/.test(text[i - 1] ?? '')) {
            const tag = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/.exec(text.slice(i, i + 64));
            if (tag) {
                const close = text.indexOf(tag[0], i + tag[0].length);
                const j = close === -1 ? n : close + tag[0].length;
                fill(i, j, '_');
                i = j;
                continue;
            }
        }
        i++;
    }
    return out.join('');
}

/**
 * Positions of the semicolons that end a statement, followed by the end of the
 * text. The body of a `BEGIN ATOMIC … END` function or procedure separates its
 * statements with semicolons too; like psql, those do not end the statement.
 */
function statementEnds(masked: string): number[] {
    const ends: number[] = [];
    let depth = 0;
    let previous = '';
    for (const match of masked.matchAll(/[A-Za-z_][A-Za-z0-9_$]*|;/g)) {
        const token = match[0].toLowerCase();
        if (token === ';') {
            if (depth === 0) ends.push(match.index ?? 0);
        } else if (token === 'atomic' && previous === 'begin') {
            depth++;
        } else if (depth > 0 && token === 'case') {
            depth++;
        } else if (depth > 0 && token === 'end') {
            depth--;
        }
        previous = token;
    }
    ends.push(masked.length);
    return ends;
}

/**
 * The top-level statements of `text` as `[start, end)` ranges without their
 * semicolon and without leading or trailing comments. A semicolon inside a
 * string, a quoted name, a comment, a dollar-quoted body (a `DO` block, a
 * function body) or a `BEGIN ATOMIC` body does not end a statement.
 */
export function statementRanges(text: string): Array<{ start: number; end: number } | null> {
    const masked = codeMask(text);
    let from = 0;
    return statementEnds(masked).map((end) => {
        const range = trimmedRange(masked, from, end);
        from = end + 1;
        return range;
    });
}

/** The SQL to execute and where it starts in the document. */
export interface StatementTarget {
    sql: string;
    start: number;
}

/**
 * Exactly the selected text, or null when nothing (or only blanks and
 * comments) is selected. Nothing is guessed from the cursor position: what
 * runs is what the user marked.
 */
export function statementToExecute(text: string, selectionStart: number, selectionEnd: number): StatementTarget | null {
    if (selectionEnd <= selectionStart) {
        return null;
    }
    const sql = text.slice(selectionStart, selectionEnd);
    return codeMask(sql).trim() ? { sql, start: selectionStart } : null;
}

/** The statements of a script, split like {@link statementRanges}. */
export function splitStatements(sql: string): string[] {
    return statementRanges(sql)
        .filter((range): range is { start: number; end: number } => range !== null)
        .map((range) => sql.slice(range.start, range.end));
}

/**
 * True for a statement whose result is rows to look at — a `SELECT`, `VALUES`
 * or `TABLE`, or a `WITH` query ending in one — and that is better shown in
 * the Data Viewer than counted. Not a `WITH` that writes data, and not
 * `SELECT … INTO`, which creates a table.
 */
export function isResultQuery(statement: string): boolean {
    const code = codeMask(statement)
        .toLowerCase()
        .replace(/\bfor\s+(no\s+key\s+)?update\b/g, ' ')
        .trim();
    if (!/^(select|values|table|with)\b/.test(code)) {
        return false;
    }
    return !/\b(insert|update|delete|merge|into)\b/.test(code);
}

/** The tab title of a Data Viewer opened for `sql`, as "View Data" names it. */
export function queryViewTitle(sql: string): string {
    const oneLine = sql.replace(/\s+/g, ' ').trim();
    return 'View Data: ' + (oneLine.length > 40 ? oneLine.slice(0, 40) + '…' : oneLine);
}

const ROW_COUNT_COMMANDS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY', 'FETCH', 'MOVE']);

function rowsText(count: number): string {
    return `${count} ${count === 1 ? 'row' : 'rows'}`;
}

function durationText(ms: number): string {
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** What `pg` reports for one statement. */
export interface ExecutionResult {
    command?: string | null;
    rowCount?: number | null;
}

/** One line telling what the executed statements did, e.g. `UPDATE affected 3 rows in 12 ms.` */
export function summarizeExecution(results: ReadonlyArray<ExecutionResult>, ms: number): string {
    const time = durationText(ms);
    const counted = (r: ExecutionResult): number | null => {
        const command = (r.command ?? '').toUpperCase();
        return ROW_COUNT_COMMANDS.has(command) && typeof r.rowCount === 'number' ? r.rowCount : null;
    };
    if (results.length === 1) {
        const command = (results[0].command ?? '').toUpperCase();
        const count = counted(results[0]);
        if (count !== null) {
            return command === 'SELECT'
                ? `SELECT returned ${rowsText(count)} in ${time}.`
                : `${command} affected ${rowsText(count)} in ${time}.`;
        }
        return `${command || 'The statement'} completed in ${time}.`;
    }
    const parts = results.map((r) => {
        const command = (r.command ?? '').toUpperCase() || 'empty statement';
        const count = counted(r);
        return count === null ? command : `${command} (${rowsText(count)})`;
    });
    return `${results.length} statements completed in ${time}: ${parts.join(', ')}.`;
}

/** A server message as a line (plus its detail lines) for the messages output. */
export function formatServerMessage(label: string, notice: SessionNotice, now: Date = new Date()): string {
    const time = now.toTimeString().slice(0, 8);
    const lines = [`[${time}] ${label} — ${notice.severity || 'NOTICE'}: ${notice.message ?? ''}`];
    if (notice.detail) lines.push(`    DETAIL: ${notice.detail}`);
    if (notice.hint) lines.push(`    HINT: ${notice.hint}`);
    if (notice.where) lines.push(`    CONTEXT: ${notice.where.replace(/\n/g, '\n             ')}`);
    return lines.join('\n');
}

/**
 * Where in the document a failed statement went wrong: PostgreSQL reports the
 * 1-based character position of a syntax error in the statement it got.
 */
export function errorOffset(err: unknown, start: number, length: number): number | null {
    const position = Number((err as { position?: unknown } | null)?.position);
    if (!Number.isInteger(position) || position < 1 || position > length + 1) {
        return null;
    }
    return start + position - 1;
}

/** True when an editor tab with this input shows the document `uri`. */
export function tabShowsUri(input: unknown, uri: string): boolean {
    if (!input || typeof input !== 'object') {
        return false;
    }
    const candidate = input as { uri?: unknown; modified?: unknown; original?: unknown };
    return [candidate.uri, candidate.modified, candidate.original]
        .some((value) => value !== undefined && value !== null && String(value) === uri);
}

/**
 * Ask before throwing a session's state away, then reset it. A session whose
 * connection is not open has nothing to lose, which the user is told instead.
 */
export async function resetSessionWithConfirmation(session: DbSession, sharedWith: number): Promise<boolean> {
    if (!session.isOpen) {
        vscode.window.showInformationMessage(
            `No database session is open for "${session.label}" yet; the next statement opens one.`
        );
        return false;
    }
    const resetLabel = 'Reset Session';
    const shared = sharedWith > 0
        ? ` ${sharedWith} other ${sharedWith === 1 ? 'tab uses' : 'tabs use'} this session as well.`
        : '';
    const answer = await vscode.window.showWarningMessage(
        `Reset the database session of "${session.label}"?`,
        {
            modal: true,
            detail: 'Settings made with SET or set_config, temporary tables and an open transaction are discarded, '
                + `and a running statement is cancelled. The next statement opens a new session.${shared}`
        },
        resetLabel
    );
    if (answer !== resetLabel) {
        return false;
    }
    session.reset();
    vscode.window.setStatusBarMessage(`The database session of "${session.label}" was reset.`, 5000);
    return true;
}

/** Opens a Data Viewer for `sql` on the session `ref`. */
export type OpenQueryView = (sql: string, title: string, ref: DbSessionRef) => Promise<void>;

/** Thrown inside the session when Cancel was pressed before the statement got its turn. */
class CancelledBeforeStart extends Error {}

/**
 * The database sessions of SQL files. A file gets its session with the first
 * "Execute Selection" or "View Data", the Data Viewers opened from it share
 * that session, and it ends once the file and all those Data Viewers are
 * closed.
 */
export class SqlFileSessions implements vscode.Disposable {
    /** Sessions held by an open SQL file: session key → document URI. */
    private readonly held = new Map<string, string>();
    private readonly subscriptions: vscode.Disposable[] = [];

    constructor(
        private readonly sessions: DbSessionManager,
        private readonly connectionManager: ConnectionManager,
        private readonly messages: vscode.OutputChannel,
        private readonly modifyHistoryStore?: ModifyHistoryStore,
        private readonly openQueryView?: OpenQueryView
    ) {
        this.subscriptions.push(
            vscode.workspace.onDidCloseTextDocument(() => this.releaseClosedFiles()),
            vscode.window.tabGroups.onDidChangeTabs(() => this.releaseClosedFiles())
        );
    }

    /** The session of `document`, kept until the file's last tab is closed. */
    acquire(document: vscode.TextDocument): { ref: DbSessionRef; session: DbSession } {
        const ref = fileSessionRef(document.uri, document.fileName);
        const session = this.sessions.acquire(ref, FILE_HOLDER);
        this.held.set(ref.key, document.uri.toString());
        return { ref, session };
    }

    /**
     * Run exactly the selected text in the file's session. Meant for what has
     * no result to show — a `DO` block, a `CALL`, `SET`, `set_config(…)` —
     * before looking at data with "View Data". A selection that is a single
     * query returning rows is opened in the Data Viewer on the same session
     * instead of being counted.
     */
    async execute(editor: vscode.TextEditor | undefined): Promise<void> {
        if (!editor) {
            vscode.window.showWarningMessage('Open a SQL file and select the statements to execute.');
            return;
        }
        const document = editor.document;
        const target = statementToExecute(
            document.getText(),
            document.offsetAt(editor.selection.start),
            document.offsetAt(editor.selection.end)
        );
        if (!target) {
            vscode.window.showWarningMessage('Select the statements to execute: Execute Selection runs exactly the selected text.');
            return;
        }
        if (!await this.connectionManager.ensureConnected()) {
            return;
        }

        const { ref, session } = this.acquire(document);
        const statements = splitStatements(target.sql);
        if (this.openQueryView && statements.length === 1 && isResultQuery(statements[0])) {
            await this.openQueryView(statements[0], queryViewTitle(statements[0]), ref);
            return;
        }

        const notices: SessionNotice[] = [];
        const started = Date.now();
        let outcome: QueryResult | QueryResult[];
        try {
            outcome = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Executing in the database session of "${ref.label}"`,
                    cancellable: true
                },
                (_progress, token) => {
                    // Cancel must only ever reach this statement: before it got
                    // its turn in the session it is skipped, while it runs its
                    // server process is asked to cancel, afterwards nothing.
                    let cancelled = false;
                    let runningPid: number | null = null;
                    let cancelRequest: Promise<void> | null = null;
                    token.onCancellationRequested(() => {
                        cancelled = true;
                        if (runningPid !== null) {
                            cancelRequest = this.cancelBackend(runningPid);
                        }
                    });
                    return session.run(async (client) => {
                        if (cancelled) {
                            throw new CancelledBeforeStart();
                        }
                        const collect = (notice: SessionNotice): void => { notices.push(notice); };
                        client.on('notice', collect);
                        runningPid = client.processID ?? null;
                        try {
                            return await client.query(target.sql) as QueryResult | QueryResult[];
                        } finally {
                            runningPid = null;
                            client.removeListener('notice', collect);
                            // The statement may end before a slow cancel request
                            // reaches the server; the session's next statement
                            // must not start until it has, or it gets cancelled.
                            if (cancelRequest) {
                                await cancelRequest;
                            }
                        }
                    });
                }
            );
        } catch (err: unknown) {
            if (err instanceof CancelledBeforeStart) {
                vscode.window.showInformationMessage('Execute Selection was cancelled before it started; nothing ran.');
                return;
            }
            this.reportFailure(editor, target, ref.label, err);
            return;
        }

        this.recordModifyHistory(target.sql);
        let message = summarizeExecution(Array.isArray(outcome) ? outcome : [outcome], Date.now() - started);
        if (notices.length > 0) {
            message += ` The server sent ${notices.length} ${notices.length === 1 ? 'message' : 'messages'}, `
                + `shown in the "${MESSAGES_CHANNEL_NAME}" output.`;
            this.messages.show(true);
        }
        vscode.window.showInformationMessage(message);
    }

    /** Throw away the session of the file in `editor`, after asking. */
    async reset(editor: vscode.TextEditor | undefined): Promise<void> {
        if (!editor) {
            vscode.window.showWarningMessage('Open the SQL file whose database session should be reset.');
            return;
        }
        const ref = fileSessionRef(editor.document.uri, editor.document.fileName);
        const session = this.sessions.get(ref.key);
        if (!session) {
            vscode.window.showInformationMessage(
                `No database session is open for "${ref.label}" yet; the next statement opens one.`
            );
            return;
        }
        await resetSessionWithConfirmation(session, Math.max(0, this.sessions.holderCount(ref.key) - 1));
    }

    dispose(): void {
        for (const subscription of this.subscriptions) {
            subscription.dispose();
        }
        for (const key of this.held.keys()) {
            this.sessions.release(key, FILE_HOLDER);
        }
        this.held.clear();
    }

    /** Ask the server, from another connection, to cancel what the process `pid` is running. */
    private async cancelBackend(pid: number): Promise<void> {
        try {
            await this.connectionManager.query('SELECT pg_cancel_backend($1)', [pid]);
        } catch (err: unknown) {
            Logger.error('SqlFileSessions.cancelBackend', err);
        }
    }

    private reportFailure(editor: vscode.TextEditor, target: StatementTarget, label: string, err: unknown): void {
        const details = (err ?? {}) as { detail?: string; hint?: string; where?: string };
        this.messages.appendLine(formatServerMessage(label, {
            severity: 'ERROR',
            message: getErrorMessage(err),
            detail: details.detail,
            hint: details.hint,
            where: details.where
        }));
        // A syntax error points at its position: put the cursor there.
        const offset = errorOffset(err, target.start, target.sql.length);
        if (offset !== null && !editor.document.isClosed) {
            const position = editor.document.positionAt(offset);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
        const where = typeof details.where === 'string' ? details.where.split('\n')[0] : '';
        vscode.window.showErrorMessage(`Execute Selection failed: ${getErrorMessage(err)}${where ? ` (${where})` : ''}`);
    }

    private recordModifyHistory(sql: string): void {
        if (!this.modifyHistoryStore) {
            return;
        }
        try {
            const entries = splitStatements(sql).filter(isModifyingSql).map((statement) => ({ sql: statement }));
            if (entries.length > 0) {
                this.modifyHistoryStore.addMany(entries);
            }
        } catch (err: unknown) {
            Logger.error('SqlFileSessions.recordModifyHistory', err);
        }
    }

    /** Release the session of every file no editor tab shows any more. */
    private releaseClosedFiles(): void {
        for (const [key, uri] of [...this.held]) {
            const shown = vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => tabShowsUri(tab.input, uri)));
            if (!shown) {
                this.held.delete(key);
                this.sessions.release(key, FILE_HOLDER);
            }
        }
    }
}
