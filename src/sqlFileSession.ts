import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { QueryArrayResult, QueryResult } from 'pg';
import type { ConnectionManager } from './connectionManager';
import type { DbSession, DbSessionManager, DbSessionRef, SessionNotice } from './dbSession';
import { isModifyingSql, type ModifyHistoryStore } from './modifyHistoryStore';
import { getErrorMessage, Logger } from './logger';
import { uniqueFieldNames } from './queryRunner';
import {
    EXPORT_FILE_EXTENSIONS,
    defaultExportFileName,
    exportChoiceProblem,
    exportPlaceholders,
    exportSettingsFor,
    exportTargetErrors,
    formatExportMessage,
    planExportInstructions,
    resolveExportTarget,
    type ExportFormat,
    type ExportInstruction,
    type ExportSettings,
    type InstructionError,
    type PlannedStatement,
    type QueryExporter
} from './exportInstructions';

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

/** A query of a run that went to a file instead of the Data Viewer. */
export interface ExportedQuery {
    rows: number;
    path: string;
}

/**
 * One line telling what "Execute File" did, e.g. `Ran all 12 statements of
 * payroll.sql in 1.2 s; 2 queries opened in the Data Viewer.` A single export
 * names its file; several are listed in the messages output.
 */
export function summarizeFileRun(label: string, total: number, opened: number, ms: number, exported: ReadonlyArray<ExportedQuery> = []): string {
    const all = total === 1 ? 'the statement' : `all ${total} statements`;
    const viewers = opened === 0 ? '' : `; ${opened} ${opened === 1 ? 'query' : 'queries'} opened in the Data Viewer`;
    const files = exported.length === 0 ? ''
        : exported.length === 1 ? `; ${rowsText(exported[0].rows)} exported to ${exported[0].path}`
        : `; ${exported.length} queries exported, listed in the "${MESSAGES_CHANNEL_NAME}" output`;
    return `Ran ${all} of ${label} in ${durationText(ms)}${viewers}${files}.`;
}

/**
 * The value a single statement returned when it is one row of one column —
 * such as the `true` of `SELECT pg_terminate_backend(…)` — or undefined.
 */
export function resultValueText(results: ReadonlyArray<{ rows?: unknown[]; fields?: ReadonlyArray<{ name: string }> }>): string | undefined {
    if (results.length !== 1) return undefined;
    const { rows, fields } = results[0];
    if (!Array.isArray(rows) || rows.length !== 1 || !Array.isArray(fields) || fields.length !== 1) return undefined;
    const value = (rows[0] as Record<string, unknown> | null)?.[fields[0].name];
    if (value === null || value === undefined) return 'NULL';
    const text = value instanceof Date ? value.toISOString()
        : typeof value === 'object' ? JSON.stringify(value)
        : String(value);
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** How a statement run for a Data Viewer ended; see {@link SqlFileSessions.executeOnSession}. */
export type StatementOutcome =
    | { status: 'executed'; message: string }
    | { status: 'cancelled' }
    | { status: 'failed'; message: string };

/** The error of a failed statement for a message, with the first line of its context. */
export function statementErrorText(err: unknown): string {
    const where = (err as { where?: unknown } | null)?.where;
    const context = typeof where === 'string' ? where.split('\n')[0] : '';
    return `${getErrorMessage(err)}${context ? ` (${context})` : ''}`;
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

/** How the first query of a Data Viewer opened by a script ended. */
export type QueryViewLoad = { status: 'loaded' } | { status: 'failed'; error: string } | { status: 'closed' };

/** Where a Data Viewer opened by a script goes, and whether the editor keeps the focus. */
export interface ViewerPlacement {
    viewColumn?: vscode.ViewColumn;
    preserveFocus?: boolean;
}

/**
 * Opens a Data Viewer for `sql` on the session `ref`; `loaded` settles once its
 * first query has run, and `viewColumn()` names the editor group it is in.
 * Undefined when no connection could be made.
 */
export type OpenQueryView = (
    sql: string,
    title: string,
    ref: DbSessionRef,
    placement?: ViewerPlacement
) => Promise<{ loaded: Promise<QueryViewLoad>; viewColumn?: () => vscode.ViewColumn | undefined } | undefined>;

/** Thrown inside the session when Cancel was pressed before the statement got its turn. */
class CancelledBeforeStart extends Error {}

/**
 * Runs statements of one command on a session, so that Cancel only ever
 * reaches them: a statement that has not had its turn yet is skipped, the one
 * running has its server process asked to cancel, and the session does not go
 * on to the next statement before that request has been handled.
 */
class CancellableRun {
    cancelled = false;
    /** Settles when Cancel is pressed. */
    readonly whenCancelled: Promise<void>;
    private markCancelled: () => void = () => undefined;
    private runningPid: number | null = null;
    private cancelRequest: Promise<void> | null = null;

    constructor(private readonly cancelBackend: (pid: number) => Promise<void>) {
        this.whenCancelled = new Promise((resolve) => { this.markCancelled = resolve; });
    }

    cancel(): void {
        this.cancelled = true;
        this.markCancelled();
        if (this.runningPid !== null && !this.cancelRequest) {
            this.cancelRequest = this.cancelBackend(this.runningPid);
        }
    }

    run(session: DbSession, sql: string, notices: SessionNotice[]): Promise<QueryResult | QueryResult[]>;
    run(session: DbSession, sql: { text: string; rowMode: 'array' }, notices: SessionNotice[]): Promise<QueryArrayResult>;
    run(session: DbSession, sql: string | { text: string; rowMode: 'array' }, notices: SessionNotice[]): Promise<QueryResult | QueryResult[] | QueryArrayResult> {
        return session.run(async (client) => {
            if (this.cancelled) {
                throw new CancelledBeforeStart();
            }
            const collect = (notice: SessionNotice): void => { notices.push(notice); };
            client.on('notice', collect);
            this.runningPid = client.processID ?? null;
            try {
                return typeof sql === 'string'
                    ? await client.query(sql) as QueryResult | QueryResult[]
                    : await client.query(sql);
            } finally {
                this.runningPid = null;
                client.removeListener('notice', collect);
                // The statement may end before a slow cancel request reaches
                // the server; the session's next statement must not start
                // until it has, or it gets cancelled instead.
                if (this.cancelRequest) {
                    await this.cancelRequest;
                    this.cancelRequest = null;
                }
            }
        });
    }
}

/**
 * The database sessions of SQL files. A file gets its session with the first
 * "Execute Selection", "Execute File" or "View Data", the Data Viewers opened
 * from it share that session, and it ends once the file and all those Data
 * Viewers are closed.
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
        private readonly openQueryView?: OpenQueryView,
        private readonly exporter?: QueryExporter
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
        const text = document.getText();
        const target = statementToExecute(
            text,
            document.offsetAt(editor.selection.start),
            document.offsetAt(editor.selection.end)
        );
        if (!target) {
            vscode.window.showWarningMessage('Select the statements to execute: Execute Selection runs exactly the selected text.');
            return;
        }
        const plan = this.planSelection(document, text, target);
        if (plan.errors.length > 0) {
            this.reportInstructionErrors(editor, 'Execute Selection', plan.errors);
            return;
        }
        if (!await this.connectionManager.ensureConnected()) {
            return;
        }
        // A selection holding an export instruction runs statement by
        // statement, like Execute File, so each query can go where it is told.
        if (plan.statements.some((statement) => statement.instruction)) {
            await this.runStepwise(editor, plan.statements, 'Execute Selection');
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
                    const runner = new CancellableRun((pid) => this.cancelBackend(pid));
                    token.onCancellationRequested(() => runner.cancel());
                    return runner.run(session, target.sql, notices);
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
            message += this.noticesText(notices.length);
        }
        vscode.window.showInformationMessage(message);
    }

    /**
     * Run the whole file from top to bottom, one statement after the other, in
     * the file's session. A query returning rows opens in the Data Viewer on
     * that session, and the run goes on only once its first page has loaded,
     * so it sees the data exactly as the statements above left it; a query
     * under an `-- @export` instruction is written to a file instead. Every
     * instruction is checked before the first statement runs, and the run
     * stops at the first statement that fails.
     */
    async executeFile(editor: vscode.TextEditor | undefined): Promise<void> {
        if (!editor) {
            vscode.window.showWarningMessage('Open the SQL file to execute.');
            return;
        }
        const document = editor.document;
        const text = document.getText();
        const ranges = statementRanges(text).filter((range): range is { start: number; end: number } => range !== null);
        if (ranges.length === 0) {
            vscode.window.showWarningMessage('The file holds no statement to execute.');
            return;
        }
        const plan = planExportInstructions(text, ranges, isResultQuery);
        const errors = [...plan.errors, ...this.targetErrors(document, plan.statements)];
        if (errors.length > 0) {
            this.reportInstructionErrors(editor, 'Execute File', errors);
            return;
        }
        if (!await this.connectionManager.ensureConnected()) {
            return;
        }
        await this.runStepwise(editor, plan.statements, 'Execute File');
    }

    /**
     * The statements of a selection with their export instructions. The
     * instruction of the first one may stand above the selection, on the
     * comment lines between it and the statement before it in the file.
     */
    private planSelection(
        document: vscode.TextDocument,
        text: string,
        target: StatementTarget
    ): { statements: PlannedStatement[]; errors: InstructionError[] } {
        const ranges = statementRanges(target.sql)
            .filter((range): range is { start: number; end: number } => range !== null)
            .map((range) => ({ start: range.start + target.start, end: range.end + target.start }));
        const firstStart = ranges.length > 0 ? ranges[0].start : target.start;
        const firstGapStart = statementRanges(text)
            .filter((range): range is { start: number; end: number } => range !== null && range.end <= firstStart)
            .reduce((last, range) => Math.max(last, range.end), 0);
        const plan = planExportInstructions(text, ranges, isResultQuery, {
            firstGapStart: Math.min(firstGapStart, target.start),
            trailingEnd: target.start + target.sql.length
        });
        return { statements: plan.statements, errors: [...plan.errors, ...this.targetErrors(document, plan.statements)] };
    }

    /** A `file=` that cannot name a file — a wrong placeholder, a relative path in an unsaved file — before anything runs. */
    private targetErrors(document: vscode.TextDocument, statements: ReadonlyArray<PlannedStatement>): InstructionError[] {
        return exportTargetErrors(statements, this.documentFolder(document), exportPlaceholders(new Date(), document.fileName));
    }

    /** Say why a run did not start and put the cursor on the first wrong instruction. */
    private reportInstructionErrors(editor: vscode.TextEditor, command: string, errors: ReadonlyArray<InstructionError>): void {
        const first = errors[0];
        const more = errors.length > 1 ? ` (${errors.length - 1} more ${errors.length === 2 ? 'instruction is' : 'instructions are'} wrong as well)` : '';
        const position = new vscode.Position(first.line, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        vscode.window.showErrorMessage(`${command} did not start, nothing ran. The @export instruction on line ${first.line + 1}: ${first.message}${more}`);
    }

    /** The folder of a saved SQL file; undefined for one never saved. */
    private documentFolder(document: vscode.TextDocument): string | undefined {
        return document.isUntitled ? undefined : path.dirname(document.fileName);
    }

    /**
     * Run `statements` of the document from top to bottom, one after the
     * other, in the file's session. A query returning rows opens in the Data
     * Viewer on that session, and the run goes on only once its first page has
     * loaded; a query under an `-- @export` instruction is written to a file
     * instead. The run stops at the first statement that fails and at a Cancel
     * — in its notification or in a dialog of an export.
     */
    private async runStepwise(
        editor: vscode.TextEditor,
        statements: ReadonlyArray<PlannedStatement>,
        command: 'Execute File' | 'Execute Selection'
    ): Promise<void> {
        const document = editor.document;
        const text = document.getText();
        const { ref, session } = this.acquire(document);
        const label = command === 'Execute File' ? ref.label : `the selection in ${ref.label}`;
        const notices: SessionNotice[] = [];
        const started = Date.now();
        const total = statements.length;
        type Stop = { reason: 'failed'; index: number; error: unknown; inViewer: boolean } | { reason: 'cancelled'; index: number };
        let opened = 0;
        const exported: ExportedQuery[] = [];

        const stop = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Executing ${label}`,
                cancellable: true
            },
            async (progress, token): Promise<Stop | null> => {
                const runner = new CancellableRun((pid) => this.cancelBackend(pid));
                token.onCancellationRequested(() => runner.cancel());
                // All Data Viewers of the run go into one group beside the
                // file, as tabs: the file keeps the focus, so "beside" stays
                // the same group, and once the first one is placed, the others
                // follow it there even if the focus moved meanwhile.
                let viewerColumn: vscode.ViewColumn | undefined;
                for (let index = 0; index < total; index++) {
                    if (runner.cancelled) {
                        return { reason: 'cancelled', index };
                    }
                    progress.report({ message: `statement ${index + 1} of ${total}`, increment: 100 / total });
                    const statement = statements[index];
                    const sql = text.slice(statement.start, statement.end);

                    if (statement.instruction) {
                        const line = document.positionAt(statement.start).line;
                        const outcome = await this.exportQuery(statement.instruction, sql, line, document, ref, session, runner, notices);
                        if (outcome.status === 'cancelled') {
                            return { reason: 'cancelled', index };
                        }
                        if (outcome.status === 'failed') {
                            return { reason: 'failed', index, error: outcome.error, inViewer: false };
                        }
                        exported.push(outcome.query);
                        continue;
                    }

                    if (this.openQueryView && isResultQuery(sql)) {
                        const view = await this.openQueryView(sql, queryViewTitle(sql), ref, {
                            viewColumn: viewerColumn ?? vscode.ViewColumn.Beside,
                            preserveFocus: true
                        });
                        if (!view) {
                            return { reason: 'cancelled', index };
                        }
                        opened++;
                        const load = await Promise.race([view.loaded, runner.whenCancelled.then(() => null)]);
                        // Known for sure only once the panel has shown itself.
                        const column = view.viewColumn?.();
                        if (viewerColumn === undefined && column !== undefined && column > 0) {
                            viewerColumn = column;
                        }
                        if (load === null) {
                            return { reason: 'cancelled', index: index + 1 };
                        }
                        if (load.status === 'failed') {
                            return { reason: 'failed', index, error: new Error(load.error), inViewer: true };
                        }
                        continue;
                    }

                    try {
                        await runner.run(session, sql, notices);
                    } catch (err: unknown) {
                        // A statement stopped by Cancel fails with "canceling
                        // statement due to user request"; that is no error.
                        if (err instanceof CancelledBeforeStart || runner.cancelled) {
                            return { reason: 'cancelled', index };
                        }
                        return { reason: 'failed', index, error: err, inViewer: false };
                    }
                    this.recordModifyHistory(sql);
                }
                return null;
            }
        );

        const noticeText = notices.length > 0 ? this.noticesText(notices.length) : '';
        if (exported.length > 1) {
            this.messages.show(true);
        }
        if (!stop) {
            vscode.window.showInformationMessage(summarizeFileRun(label, total, opened, Date.now() - started, exported) + noticeText);
            return;
        }
        if (stop.reason === 'cancelled') {
            vscode.window.showInformationMessage(
                `${command} was cancelled after ${stop.index} of ${total} statements; the rest did not run.${noticeText}`
            );
            return;
        }
        const failed = statements[stop.index];
        const line = document.positionAt(failed.start).line + 1;
        const before = stop.index === 0
            ? 'nothing before it ran'
            : `the ${stop.index === 1 ? 'statement' : `${stop.index} statements`} before it ran`;
        const failedIn = stop.inViewer ? ', whose query failed in the Data Viewer' : '';
        this.reportFailure(
            editor,
            { sql: text.slice(failed.start, failed.end), start: failed.start },
            ref.label,
            stop.error,
            {
                prefix: `${command} stopped at statement ${stop.index + 1} of ${total} (line ${line})${failedIn}; ${before}`,
                revealStatement: true
            }
        );
    }

    /**
     * Write the result of `sql` — the query starting on 0-based `line` — to
     * the file its instruction names, instead of showing it. With `dialog` the
     * export dialog of the Data Viewer chooses format, file and options first;
     * without `file=` a save dialog asks for the target, and an existing file
     * is only overwritten after asking. Every Cancel cancels the run.
     */
    private async exportQuery(
        instruction: ExportInstruction,
        sql: string,
        line: number,
        document: vscode.TextDocument,
        ref: DbSessionRef,
        session: DbSession,
        runner: CancellableRun,
        notices: SessionNotice[]
    ): Promise<{ status: 'exported'; query: ExportedQuery } | { status: 'cancelled' } | { status: 'failed'; error: unknown }> {
        const exporter = this.exporter;
        if (!exporter) {
            return { status: 'failed', error: new Error('Exporting is not available.') };
        }
        const values = exportPlaceholders(new Date(), document.fileName);
        const folder = this.documentFolder(document);
        const fallbackFolder = folder ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

        let settings: ExportSettings;
        let target: string | undefined;
        if (instruction.dialog) {
            const format = instruction.format ?? 'csv';
            let fileName = defaultExportFileName(values, line, format);
            let dialogFolder = fallbackFolder;
            if (instruction.file) {
                const resolved = resolveExportTarget(instruction.file, format, folder, values);
                if ('error' in resolved) {
                    return { status: 'failed', error: new Error(resolved.error) };
                }
                fileName = path.basename(resolved.path);
                dialogFolder = path.dirname(resolved.path);
            }
            const choice = await exporter.chooseSettings({
                title: `Export: line ${line + 1} of ${ref.label}`,
                format,
                fileName,
                folder: dialogFolder,
                options: instruction.options,
                sql,
                sessionRef: ref,
                validate: exportChoiceProblem
            });
            if (!choice) {
                return { status: 'cancelled' };
            }
            settings = { ...choice.settings };
            if (settings.format === 'excel') {
                settings.excelSqlStatement = sql;
            }
            // As in the Data Viewer, the save dialog has the last word on the file.
            target = await this.askExportTarget(path.join(choice.folder || dialogFolder, choice.fileName), settings.format);
        } else {
            const format = instruction.format as ExportFormat;
            settings = exportSettingsFor(format, exporter.savedDefaults(format), instruction.options, sql);
            if (instruction.file) {
                const resolved = resolveExportTarget(instruction.file, format, folder, values);
                if ('error' in resolved) {
                    return { status: 'failed', error: new Error(resolved.error) };
                }
                target = fs.existsSync(resolved.path) && !await this.confirmOverwrite(resolved.path) ? undefined : resolved.path;
            } else {
                target = await this.askExportTarget(path.join(fallbackFolder, defaultExportFileName(values, line, format)), format);
            }
        }
        if (!target) {
            return { status: 'cancelled' };
        }

        let result: QueryArrayResult;
        try {
            result = await runner.run(session, { text: sql, rowMode: 'array' }, notices);
        } catch (err: unknown) {
            if (err instanceof CancelledBeforeStart || runner.cancelled) {
                return { status: 'cancelled' };
            }
            return { status: 'failed', error: err };
        }
        const fields = uniqueFieldNames(result.fields ?? [], sql);
        const types = await this.typeNames(fields.map((field) => field.dataTypeID));
        const columns = fields.map((field) => ({ name: field.name, dataType: types.get(field.dataTypeID) ?? '' }));
        const rows = ((result.rows ?? []) as unknown[][]).map((values) => {
            const row: Record<string, unknown> = {};
            fields.forEach((field, i) => { row[field.name] = values[i]; });
            return row;
        });
        try {
            await exporter.write(rows, columns, { ...settings, filePath: target });
        } catch (err: unknown) {
            return { status: 'failed', error: new Error(`Writing ${target} failed: ${getErrorMessage(err)}`) };
        }
        this.messages.appendLine(formatExportMessage(ref.label, line, rows.length, target));
        return { status: 'exported', query: { rows: rows.length, path: target } };
    }

    /** Ask where an export goes, starting at `suggested`; undefined when cancelled. */
    private async askExportTarget(suggested: string, format: ExportFormat): Promise<string | undefined> {
        const extension = EXPORT_FILE_EXTENSIONS[format].slice(1);
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(suggested),
            filters: { [`${extension.toUpperCase()} Files`]: [extension] },
            title: 'Export Query Result'
        });
        return uri?.fsPath;
    }

    private async confirmOverwrite(filePath: string): Promise<boolean> {
        const overwrite = 'Overwrite';
        const answer = await vscode.window.showWarningMessage(
            `"${path.basename(filePath)}" already exists in ${path.dirname(filePath)}. Overwrite it?`,
            { modal: true },
            overwrite
        );
        return answer === overwrite;
    }

    /** The type names of the result columns, which decide how an export writes their values. */
    private async typeNames(oids: ReadonlyArray<number>): Promise<Map<number, string>> {
        const names = new Map<number, string>();
        const wanted = Array.from(new Set(oids.filter((oid) => oid > 0)));
        if (wanted.length === 0) {
            return names;
        }
        try {
            const result = await this.connectionManager.query('SELECT oid, typname FROM pg_catalog.pg_type WHERE oid = ANY($1::oid[])', [wanted]);
            for (const row of result.rows) {
                names.set(Number(row.oid), String(row.typname));
            }
        } catch (err: unknown) {
            // Without type names every value is written as text.
            Logger.error('SqlFileSessions.typeNames', err);
        }
        return names;
    }

    /**
     * Run `sql` in `session` — the session of a Data Viewer — the way Execute
     * Selection runs a selection: cancellable from its notification, the
     * messages of the server in the "PostgreSQL Messages" output, data changes
     * in the Modify History. It reports nothing itself; the outcome says how
     * the statement ended.
     */
    async executeOnSession(session: DbSession, label: string, sql: string): Promise<StatementOutcome> {
        const notices: SessionNotice[] = [];
        const started = Date.now();
        let outcome: QueryResult | QueryResult[];
        try {
            outcome = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Running in the database session of "${label}"`,
                    cancellable: true
                },
                (_progress, token) => {
                    const runner = new CancellableRun((pid) => this.cancelBackend(pid));
                    token.onCancellationRequested(() => runner.cancel());
                    return runner.run(session, sql, notices);
                }
            );
        } catch (err: unknown) {
            if (err instanceof CancelledBeforeStart) {
                return { status: 'cancelled' };
            }
            this.logServerError(label, err);
            return { status: 'failed', message: statementErrorText(err) };
        }

        this.recordModifyHistory(sql);
        const results = Array.isArray(outcome) ? outcome : [outcome];
        let message = summarizeExecution(results, Date.now() - started);
        const value = resultValueText(results);
        if (value !== undefined) {
            message += ` Result: ${value}.`;
        }
        if (notices.length > 0) {
            message += this.noticesText(notices.length);
        }
        return { status: 'executed', message };
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

    /** Text telling where the messages of the server are, which also shows them. */
    private noticesText(count: number): string {
        this.messages.show(true);
        return ` The server sent ${count} ${count === 1 ? 'message' : 'messages'}, shown in the "${MESSAGES_CHANNEL_NAME}" output.`;
    }

    private reportFailure(
        editor: vscode.TextEditor,
        target: StatementTarget,
        label: string,
        err: unknown,
        options: { prefix?: string; revealStatement?: boolean } = {}
    ): void {
        this.logServerError(label, err);
        // A syntax error points at its position: put the cursor there, or at
        // the start of the failed statement of a file.
        const offset = errorOffset(err, target.start, target.sql.length) ?? (options.revealStatement ? target.start : null);
        if (offset !== null && !editor.document.isClosed) {
            const position = editor.document.positionAt(offset);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
        vscode.window.showErrorMessage(`${options.prefix ?? 'Execute Selection failed'}: ${statementErrorText(err)}`);
    }

    /** Write a failed statement's error with its detail, hint and context to the messages output. */
    private logServerError(label: string, err: unknown): void {
        const details = (err ?? {}) as { detail?: string; hint?: string; where?: string };
        this.messages.appendLine(formatServerMessage(label, {
            severity: 'ERROR',
            message: getErrorMessage(err),
            detail: details.detail,
            hint: details.hint,
            where: details.where
        }));
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
