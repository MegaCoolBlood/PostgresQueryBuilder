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
        if (c === '$') {
            const tag = /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/.exec(text.slice(i, i + 64));
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

/** Positions of the semicolons that end a statement, followed by the end of the text. */
function statementEnds(masked: string): number[] {
    const ends: number[] = [];
    for (let i = 0; i < masked.length; i++) {
        if (masked[i] === ';') ends.push(i);
    }
    ends.push(masked.length);
    return ends;
}

/**
 * The top-level statements of `text` as `[start, end)` ranges without their
 * semicolon and without leading or trailing comments. A semicolon inside a
 * string, a quoted name, a comment or a dollar-quoted body (a `DO` block, a
 * function body) does not end a statement.
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

/**
 * The statement the cursor at `offset` belongs to. A whole `DO` block counts as
 * one statement wherever the cursor sits in it. A cursor at the end of a line
 * behind a statement's semicolon means that statement, and one in the blank
 * space after the last statement means the last one.
 */
export function statementRangeAt(text: string, offset: number): { start: number; end: number } | null {
    const masked = codeMask(text);
    const ends = statementEnds(masked);
    const ranges = statementRanges(text);
    let index = ends.findIndex((end) => offset <= end);
    if (index === -1) index = ends.length - 1;

    if (index > 0) {
        const lineEnd = masked.indexOf('\n', offset);
        const before = masked.slice(ends[index - 1] + 1, offset);
        const after = masked.slice(offset, lineEnd === -1 ? masked.length : lineEnd);
        if (!before.includes('\n') && !before.trim() && !after.trim() && ranges[index - 1]) {
            return ranges[index - 1];
        }
    }
    for (let i = index; i >= 0; i--) {
        if (ranges[i]) return ranges[i];
    }
    return null;
}

/** The SQL to execute and where it starts in the document. */
export interface StatementTarget {
    sql: string;
    start: number;
}

/** The selected text, or the statement under the cursor when nothing is selected. */
export function statementToExecute(text: string, selectionStart: number, selectionEnd: number): StatementTarget | null {
    if (selectionEnd > selectionStart) {
        const sql = text.slice(selectionStart, selectionEnd);
        return codeMask(sql).trim() ? { sql, start: selectionStart } : null;
    }
    const range = statementRangeAt(text, selectionStart);
    return range ? { sql: text.slice(range.start, range.end), start: range.start } : null;
}

/** The statements of a script, split like {@link statementRanges}. */
export function splitStatements(sql: string): string[] {
    return statementRanges(sql)
        .filter((range): range is { start: number; end: number } => range !== null)
        .map((range) => sql.slice(range.start, range.end));
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

/**
 * The database sessions of SQL files. A file gets its session with the first
 * "Execute Statement" or "View Data", the Data Viewers opened from it share
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
        private readonly modifyHistoryStore?: ModifyHistoryStore
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
     * Run the selection, or the statement under the cursor, in the file's
     * session. Meant for what has no result to show — a `DO` block, a `CALL`,
     * `SET`, `set_config(…)` — before looking at data with "View Data".
     */
    async execute(editor: vscode.TextEditor | undefined): Promise<void> {
        if (!editor) {
            vscode.window.showWarningMessage('Open a SQL file and place the cursor inside the statement to execute.');
            return;
        }
        const document = editor.document;
        const target = statementToExecute(
            document.getText(),
            document.offsetAt(editor.selection.start),
            document.offsetAt(editor.selection.end)
        );
        if (!target) {
            vscode.window.showWarningMessage('There is no statement at the cursor to execute.');
            return;
        }
        if (!await this.connectionManager.ensureConnected()) {
            return;
        }

        const { ref, session } = this.acquire(document);
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
                    token.onCancellationRequested(() => { void this.cancel(session); });
                    return session.run(async (client) => {
                        const collect = (notice: SessionNotice): void => { notices.push(notice); };
                        client.on('notice', collect);
                        try {
                            return await client.query(target.sql) as QueryResult | QueryResult[];
                        } finally {
                            client.removeListener('notice', collect);
                        }
                    });
                }
            );
        } catch (err: unknown) {
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

    /** Ask the server to cancel what the session is running, from another connection. */
    private async cancel(session: DbSession): Promise<void> {
        const pid = session.processId;
        if (pid === null) {
            return;
        }
        try {
            await this.connectionManager.query('SELECT pg_cancel_backend($1)', [pid]);
        } catch (err: unknown) {
            Logger.error('SqlFileSessions.cancel', err);
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
        vscode.window.showErrorMessage(`Execute Statement failed: ${getErrorMessage(err)}${where ? ` (${where})` : ''}`);
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
