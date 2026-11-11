import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DbSessionRef, SessionNotice } from './dbSession';
import { getErrorMessage, Logger } from './logger';
import { buildHtmlDocument, WEBVIEW_ESCAPE_HTML_JS } from './webviewUtils';
import { icon } from './webviewAssets';

/** The panel that shows what the server said besides results, one log per database session. */
export const MESSAGES_PANEL_NAME = 'PostgreSQL Messages';

/** The webview view of that panel. */
export const MESSAGES_VIEW_ID = 'postgresSessionMessages';

/** The panel keeps this many messages of a log; *Save* writes all of them. */
export const MAX_MESSAGES_PER_LOG = 2000;

/** *Copy* puts at most this much text on the clipboard; a larger log is saved to a file instead. */
export const MAX_COPY_BYTES = 20 * 1024 * 1024;

/**
 * The panel keeps and shows at most this many characters of a message and of
 * each of its detail lines; *Save* and *Copy* write them in full.
 */
export const MAX_KEPT_TEXT = 4000;

/** `text` cut to {@link MAX_KEPT_TEXT} characters, saying how much is left out. */
export function keptText(text: string, max: number = MAX_KEPT_TEXT): string {
    return text.length <= max ? text : `${text.slice(0, max)}… (${text.length - max} more characters; Save writes them all)`;
}

/** The copy of a message the panel keeps: its text and details cut to {@link MAX_KEPT_TEXT}. */
function keptMessage(message: SessionMessage): SessionMessage {
    if (message.text.length <= MAX_KEPT_TEXT && message.details.every((d) => d.length <= MAX_KEPT_TEXT)) return message;
    return { ...message, text: keptText(message.text), details: message.details.map((d) => keptText(d)) };
}

/** A size such as `1.5 MB` for a message. */
export function byteSizeText(bytes: number): string {
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** A place in a document, 0-based. */
export interface MessagePosition {
    line: number;
    character: number;
}

/** Where an entry leads: a statement in its file. */
export interface MessageLink {
    /** The part of the entry's text that is the link, e.g. `line 12`. */
    text: string;
    /** The document, as `Uri.toString()` gives it. */
    uri: string;
    start: MessagePosition;
    end: MessagePosition;
}

/** How a statement whose entry counts its running time has ended, if it has. */
export type TimerStatus = 'running' | 'done' | 'failed' | 'cancelled';

/** The running time of the statement of an entry. */
export interface MessageTimer {
    /** When the statement started, in milliseconds since the epoch. */
    started: number;
    status: TimerStatus;
    /** How long it ran, once it has ended. */
    ms?: number;
}

/** One entry of a session's log. */
export interface SessionMessage {
    /** Local time it arrived, `HH:MM:SS`. */
    time: string;
    /** What it came from: the file or tab whose statement caused it. */
    source: string;
    /** `NOTICE`, `INFO`, `WARNING`, `ERROR`, … as the server sent it, `EXPORT`, or `RUN` for a statement of a run. */
    severity: string;
    text: string;
    /** Further lines such as `DETAIL: …`, `HINT: …`, `CONTEXT: …`. */
    details: string[];
    /** Set on an entry that is changed after it was added or that the panel can act on; unique among all logs. */
    id?: number;
    link?: MessageLink;
    timer?: MessageTimer;
}

/** The colour token a message is shown in. */
export type MessageTone = 'danger' | 'warning' | 'success' | 'info';

function clockTime(now: Date): string {
    return now.toTimeString().slice(0, 8);
}

/** A message of the server — `RAISE NOTICE`, a warning, the error of a failed statement — as a log entry. */
export function noticeMessage(source: string, notice: SessionNotice, now: Date = new Date()): SessionMessage {
    const details: string[] = [];
    if (notice.detail) details.push(`DETAIL: ${notice.detail}`);
    if (notice.hint) details.push(`HINT: ${notice.hint}`);
    if (notice.where) details.push(`CONTEXT: ${notice.where.replace(/\n/g, '\n         ')}`);
    return { time: clockTime(now), source, severity: notice.severity || 'NOTICE', text: notice.message ?? '', details };
}

/** An `-- @export` of the query on 0-based `line` that wrote `rows` rows to `filePath`. */
export function exportMessage(source: string, line: number, rows: number, filePath: string, now: Date = new Date()): SessionMessage {
    return {
        time: clockTime(now),
        source,
        severity: 'EXPORT',
        text: `line ${line + 1}, ${rows} ${rows === 1 ? 'row' : 'rows'} to ${filePath}`,
        details: []
    };
}

/** How long a run has been going, in whole seconds: `42 s`, `1 min 05 s`, `1 h 02 min`. */
export function elapsedText(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`;
    return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** How long a statement took: `12 ms`, `3.2 s`, or as {@link elapsedText} from a minute on. */
export function runTimeText(ms: number): string {
    if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
    return elapsedText(ms);
}

/** What the timer of an entry shows at `now`: `running for 5 s`, `done in 3.2 s`, `failed after …`, `cancelled after …`. */
export function timerText(timer: MessageTimer, now: number): string {
    if (timer.status === 'running') return `running for ${elapsedText(now - timer.started)}`;
    const took = runTimeText(timer.ms ?? 0);
    if (timer.status === 'failed') return `failed after ${took}`;
    if (timer.status === 'cancelled') return `cancelled after ${took}`;
    return `done in ${took}`;
}

/**
 * The panel's copy of {@link elapsedText}, {@link runTimeText} and
 * {@link timerText}, which renews a running timer every second; a test keeps
 * the two in step.
 */
export const TIMER_TEXT_JS = `
function elapsedText(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return seconds + ' s';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + ' min ' + String(seconds % 60).padStart(2, '0') + ' s';
    return Math.floor(minutes / 60) + ' h ' + String(minutes % 60).padStart(2, '0') + ' min';
}
function runTimeText(ms) {
    if (ms < 1000) return Math.max(0, Math.round(ms)) + ' ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
    return elapsedText(ms);
}
function timerText(timer, now) {
    if (timer.status === 'running') return 'running for ' + elapsedText(now - timer.started);
    const took = runTimeText(timer.ms == null ? 0 : timer.ms);
    if (timer.status === 'failed') return 'failed after ' + took;
    if (timer.status === 'cancelled') return 'cancelled after ' + took;
    return 'done in ' + took;
}`;

let entryCounter = 0;

/**
 * The entry a run adds when it starts a statement: `Started executing query
 * at line 12`, whose `line 12` leads to the statement and whose timer runs
 * until {@link SessionMessageSink.finish} stops it.
 */
export function statementStartedMessage(
    source: string,
    statement: { uri: string; start: MessagePosition; end: MessagePosition },
    now: Date = new Date()
): SessionMessage {
    const lineText = `line ${statement.start.line + 1}`;
    return {
        id: ++entryCounter,
        time: clockTime(now),
        source,
        severity: 'RUN',
        text: `Started executing query at ${lineText}`,
        details: [],
        link: {
            text: lineText,
            uri: statement.uri,
            start: { line: statement.start.line, character: statement.start.character },
            end: { line: statement.end.line, character: statement.end.character }
        },
        timer: { started: now.getTime(), status: 'running' }
    };
}

/** The entry of a statement once it has ended: its timer stopped at how long the statement ran. */
export function statementEndedMessage(started: SessionMessage, status: Exclude<TimerStatus, 'running'>, ms: number): SessionMessage {
    return { ...started, timer: { started: started.timer?.started ?? 0, status, ms } };
}

/**
 * The line a log file gets when a statement has ended — `Query at line 12
 * done in 3.2 s` — as a file cannot change the line written when it started.
 */
export function statementEndedLine(ended: SessionMessage, now: Date = new Date()): string {
    const where = ended.link ? `Query at ${ended.link.text}` : 'Query';
    const timer = ended.timer ? ` ${timerText(ended.timer, now.getTime())}` : '';
    return formatSessionMessage({ time: clockTime(now), source: ended.source, severity: ended.severity, text: `${where}${timer}`, details: [] });
}

/**
 * A log entry as plain text, e.g. for the clipboard: one line plus its
 * indented detail lines. A statement that has ended says how long it ran.
 */
export function formatSessionMessage(message: SessionMessage): string {
    const timer = message.timer && message.timer.status !== 'running' ? ` · ${timerText(message.timer, 0)}` : '';
    const lines = [`[${message.time}] ${message.source} — ${message.severity}: ${message.text}${timer}`];
    for (const detail of message.details) {
        lines.push(`    ${detail.replace(/\n/g, '\n    ')}`);
    }
    return lines.join('\n');
}

export function messageTone(severity: string): MessageTone {
    switch (severity.toUpperCase()) {
        case 'ERROR':
        case 'FATAL':
        case 'PANIC':
            return 'danger';
        case 'WARNING':
            return 'warning';
        case 'EXPORT':
            return 'success';
        default:
            return 'info';
    }
}

/** The messages of one database session. */
export interface SessionLog {
    key: string;
    label: string;
    /** The newest messages, at most the limit of the log. */
    messages: SessionMessage[];
    /** Every message since the log began or was cleared, including those no longer kept. */
    total: number;
    /** How many of `total` are errors. */
    errors: number;
    /** Unique per log and renewed by Clear, so the panel can tell new messages from a new log. */
    id: number;
}

type SpoolOperation = { kind: 'append'; text: string } | { kind: 'truncate' } | { kind: 'remove' };

/**
 * A file that receives every message of one log, so *Save* can write more of
 * them than the panel keeps. Writes are queued and run one after the other,
 * consecutive messages in one write, so a flood of `RAISE NOTICE` neither
 * blocks the extension host nor reorders the file.
 */
export class MessageSpool {
    private operations: SpoolOperation[] = [];
    private running?: Promise<void>;
    private removed = false;

    constructor(readonly filePath: string) {}

    write(text: string): void {
        if (this.removed) return;
        const last = this.operations[this.operations.length - 1];
        if (last?.kind === 'append') {
            last.text += text;
        } else {
            this.operations.push({ kind: 'append', text });
        }
        this.pump();
    }

    /** Empty the file; what was still waiting to be written is dropped as well. */
    truncate(): void {
        if (this.removed) return;
        this.operations = [{ kind: 'truncate' }];
        this.pump();
    }

    /** Delete the file; nothing is written to it any more. */
    remove(): void {
        if (this.removed) return;
        this.removed = true;
        this.operations = [{ kind: 'remove' }];
        this.pump();
    }

    /** Settles once everything queued so far has reached the file. */
    async idle(): Promise<void> {
        while (this.running) {
            await this.running;
        }
    }

    /** Write the whole file to `target`, after everything queued has reached it. */
    async copyTo(target: string): Promise<void> {
        await this.idle();
        if (fs.existsSync(this.filePath)) {
            await fs.promises.copyFile(this.filePath, target);
        } else {
            await fs.promises.writeFile(target, '', 'utf8');
        }
    }

    /** The whole file, after everything queued has reached it. */
    async read(): Promise<string> {
        await this.idle();
        return fs.existsSync(this.filePath) ? fs.promises.readFile(this.filePath, 'utf8') : '';
    }

    /** How many bytes the file holds, after everything queued has reached it. */
    async size(): Promise<number> {
        await this.idle();
        try {
            return (await fs.promises.stat(this.filePath)).size;
        } catch {
            return 0;
        }
    }

    private pump(): void {
        if (this.running) return;
        this.running = (async () => {
            while (this.operations.length > 0) {
                const operation = this.operations.shift() as SpoolOperation;
                try {
                    if (operation.kind === 'append') {
                        await fs.promises.appendFile(this.filePath, operation.text, 'utf8');
                    } else if (operation.kind === 'truncate') {
                        await fs.promises.writeFile(this.filePath, '', 'utf8');
                    } else {
                        await fs.promises.rm(this.filePath, { force: true });
                    }
                } catch (err: unknown) {
                    Logger.error('MessageSpool.pump', err);
                }
            }
        })().finally(() => {
            this.running = undefined;
            if (this.operations.length > 0) this.pump();
        });
    }
}

export interface SessionMessageLogOptions {
    /** How many messages a log keeps for the panel; default {@link MAX_MESSAGES_PER_LOG}. */
    limit?: number;
    /**
     * The folder in which a temporary folder for the spool files is made on
     * the first message, e.g. `os.tmpdir()`. Without it nothing is spooled and
     * *Save* writes only the messages the log keeps.
     */
    spoolRoot?: string;
}

/**
 * One log per database session, under the session's key: the tabs and files
 * sharing a session share its log. A log is created by its first message and
 * lives until it is discarded — when the session ends. It keeps the newest
 * messages for the panel and spools every message to a file of its own.
 */
export class SessionMessageLog {
    private readonly logs = new Map<string, SessionLog>();
    private readonly spools = new Map<string, MessageSpool>();
    /** Spools of discarded logs whose file is still being deleted. */
    private readonly retiring = new Set<MessageSpool>();
    private readonly listeners = new Set<(key: string, updated?: SessionMessage) => void>();
    private readonly limit: number;
    private readonly spoolRoot?: string;
    private spoolDir?: string;
    private spoolCounter = 0;
    private logCounter = 0;

    constructor(options: SessionMessageLogOptions = {}) {
        this.limit = options.limit ?? MAX_MESSAGES_PER_LOG;
        this.spoolRoot = options.spoolRoot;
    }

    /** How many messages a log keeps for the panel. */
    get keptLimit(): number {
        return this.limit;
    }

    append(ref: DbSessionRef, message: SessionMessage): void {
        let log = this.logs.get(ref.key);
        if (!log) {
            log = { key: ref.key, label: ref.label, messages: [], total: 0, errors: 0, id: ++this.logCounter };
            this.logs.set(ref.key, log);
        }
        log.messages.push(keptMessage(message));
        log.total++;
        if (messageTone(message.severity) === 'danger') {
            log.errors++;
        }
        if (log.messages.length > this.limit) {
            log.messages.splice(0, log.messages.length - this.limit);
        }
        this.spoolOf(ref.key)?.write(`${formatSessionMessage(message)}\n`);
        this.emit(ref.key);
    }

    /**
     * Stop the timer of the entry `started` of the log of `ref`: the entry
     * the panel keeps shows how the statement ended, and the log file gets a
     * line saying so. Nothing happens once the log has ended or the entry
     * has ended before.
     */
    finish(ref: DbSessionRef, started: SessionMessage, status: Exclude<TimerStatus, 'running'>, ms: number, now: Date = new Date()): void {
        const log = this.logs.get(ref.key);
        if (!log || started.id === undefined) return;
        const ended = statementEndedMessage(started, status, ms);
        let updated: SessionMessage | undefined;
        for (let i = log.messages.length - 1; i >= 0; i--) {
            if (log.messages[i].id !== started.id) continue;
            if (log.messages[i].timer?.status !== 'running') return;
            updated = keptMessage(ended);
            log.messages[i] = updated;
            break;
        }
        this.spools.get(ref.key)?.write(`${statementEndedLine(ended, now)}\n`);
        if (updated) {
            this.emit(ref.key, updated);
        }
    }

    get(key: string): SessionLog | undefined {
        return this.logs.get(key);
    }

    /** Empty the log of `key`, which stays for further messages. */
    clear(key: string): void {
        const log = this.logs.get(key);
        if (!log || log.total === 0) return;
        log.messages = [];
        log.total = 0;
        log.errors = 0;
        log.id = ++this.logCounter;
        this.spools.get(key)?.truncate();
        this.emit(key);
    }

    /** Forget the log of `key` entirely, because its session has ended. */
    discard(key: string): void {
        const spool = this.spools.get(key);
        if (spool) {
            spool.remove();
            this.spools.delete(key);
            this.retiring.add(spool);
            void spool.idle().then(() => this.retiring.delete(spool));
        }
        if (this.logs.delete(key)) {
            this.emit(key);
        }
    }

    /**
     * Write every message of the log of `key` — not only those it keeps — to
     * `target`, one per line as they are copied. Returns how many were written.
     */
    async saveTo(key: string, target: string): Promise<number> {
        const log = this.logs.get(key);
        const spool = this.spools.get(key);
        if (spool) {
            await spool.copyTo(target);
        } else {
            await fs.promises.writeFile(target, this.keptText(log), 'utf8');
        }
        return log?.total ?? 0;
    }

    /**
     * Every message of the log of `key` — not only those it keeps — as text,
     * one per line as *Save* writes them. A log of more than `maxBytes` is
     * not read at all: the text would have to be held in memory at once, and
     * on the clipboard it also goes through the window of VS Code.
     */
    async readAll(key: string, maxBytes: number = MAX_COPY_BYTES): Promise<{ text: string; count: number } | { tooLarge: true; bytes: number; count: number }> {
        const log = this.logs.get(key);
        const count = log?.total ?? 0;
        const spool = this.spools.get(key);
        if (!spool) {
            return { text: this.keptText(log), count };
        }
        const bytes = await spool.size();
        if (bytes > maxBytes) {
            return { tooLarge: true, bytes, count };
        }
        return { text: await spool.read(), count };
    }

    private keptText(log: SessionLog | undefined): string {
        return (log?.messages ?? []).map((m) => `${formatSessionMessage(m)}\n`).join('');
    }

    /** Settles once every spool — also one being deleted — has done what it was given. */
    async idle(): Promise<void> {
        await Promise.all([...this.spools.values(), ...this.retiring].map((spool) => spool.idle()));
    }

    /** `updated` is the entry that changed in place, for a change that added or removed none. */
    onDidChange(listener: (key: string, updated?: SessionMessage) => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
    }

    /** Forget every log and delete the spool files. */
    dispose(): void {
        for (const spool of this.spools.values()) {
            spool.remove();
        }
        this.logs.clear();
        this.spools.clear();
        this.retiring.clear();
        this.listeners.clear();
        if (this.spoolDir) {
            try {
                fs.rmSync(this.spoolDir, { recursive: true, force: true });
            } catch (err: unknown) {
                Logger.error('SessionMessageLog.dispose', err);
            }
            this.spoolDir = undefined;
        }
    }

    private spoolOf(key: string): MessageSpool | undefined {
        const existing = this.spools.get(key);
        if (existing || !this.spoolRoot) return existing;
        try {
            this.spoolDir ??= fs.mkdtempSync(path.join(this.spoolRoot, 'pqb-messages-'));
        } catch (err: unknown) {
            // Without a spool the log still shows and saves what it keeps.
            Logger.error('SessionMessageLog.spoolOf', err);
            return undefined;
        }
        const spool = new MessageSpool(path.join(this.spoolDir, `session-${++this.spoolCounter}.log`));
        this.spools.set(key, spool);
        return spool;
    }

    private emit(key: string, updated?: SessionMessage): void {
        for (const listener of [...this.listeners]) {
            listener(key, updated);
        }
    }
}

/**
 * The name *Save* suggests for the log of the session `label`, e.g.
 * `payroll-messages-2026-11-03.log` for `payroll.sql`.
 */
export function messagesFileName(label: string, now: Date = new Date()): string {
    const base = label
        .replace(/\.(sql|pgsql|psql)$/i, '')
        .replace(/[\\/:*?"<>|\s]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60) || 'session';
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${base}-messages-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.log`;
}

/** Where the statements of a session report what the server said. */
export interface SessionMessageSink {
    append(ref: DbSessionRef, message: SessionMessage): void;
    /** Stop the timer of the entry `started` once its statement has ended; see {@link SessionMessageLog.finish}. */
    finish(ref: DbSessionRef, started: SessionMessage, status: Exclude<TimerStatus, 'running'>, ms: number): void;
    /** Execute File or Execute Selection is about to run in the session of `ref`; its log is cleared first if the user asked for that. */
    runStarting(ref: DbSessionRef): void;
    /** Show the log of `ref` and bring the panel into view without taking the focus. */
    reveal(ref: DbSessionRef): void;
}

/** The section of this extension's settings. */
const SETTINGS_SECTION = 'postgresQueryBuilder';

/** Whether Execute File and Execute Selection clear the log of their session first; the panel's "Clear on Execute". */
export const CLEAR_ON_EXECUTE_SETTING = 'messages.clearOnExecute';

/** What the panel is told to show. */
export interface MessagesViewState {
    /** The session shown, or null while no SQL file or Data Viewer has been active. */
    label: string | null;
    messages: Array<SessionMessage & { tone: MessageTone }>;
    /** Every message of the log, of which `messages` are the newest. */
    total: number;
    /** E.g. `12 messages`, or `last 2000 of 5234 messages` once the panel no longer shows them all. */
    countText: string;
    /** How many errors the session sent, e.g. `3 errors`; empty without any. */
    errorsText: string;
}

/** The errors of a log for the header of the panel; empty when there are none. */
export function errorsCountText(errors: number): string {
    return errors === 0 ? '' : `${errors} ${errors === 1 ? 'error' : 'errors'}`;
}

/** How many messages the panel shows, and of how many when it no longer shows all of them. */
export function messagesCountText(shown: number, total: number): string {
    const noun = total === 1 ? 'message' : 'messages';
    return shown < total ? `last ${shown} of ${total} ${noun}` : `${total} ${noun}`;
}

export function messagesViewState(shown: DbSessionRef | undefined, log: SessionLog | undefined): MessagesViewState {
    const messages = log?.messages ?? [];
    const total = log?.total ?? 0;
    return {
        label: shown ? shown.label : null,
        messages: messages.map((message) => ({ ...message, tone: messageTone(message.severity) })),
        total,
        countText: shown ? messagesCountText(messages.length, total) : '',
        errorsText: shown ? errorsCountText(log?.errors ?? 0) : ''
    };
}

/** What the panel was last sent: which log, and how many of its messages. */
export interface SentLog {
    key: string | null;
    label: string | null;
    /** {@link SessionLog.id}, or null when there was no log. */
    id: number | null;
    total: number;
}

/** A message to the panel: the whole log, only the messages that came since the last one, or entries that changed. */
export type MessagesUpdate =
    | { type: 'log'; key: string | null; state: MessagesViewState }
    | {
        type: 'append';
        key: string;
        messages: Array<SessionMessage & { tone: MessageTone }>;
        total: number;
        countText: string;
        errorsText: string;
        /** The panel drops its oldest lines beyond this many. */
        limit: number;
    }
    /** Entries the panel already shows, changed in place: a statement that has ended. */
    | { type: 'update'; key: string; messages: Array<SessionMessage & { tone: MessageTone }> };

/**
 * What to send the panel so it shows `log` of `shown`, given what it was sent
 * last. Only the new messages are sent while the same log grows by no more
 * than it keeps; anything else — another session, Clear, a log that ended,
 * a first message — sends the whole log. Null when nothing changed.
 */
export function messagesUpdate(
    shown: DbSessionRef | undefined,
    log: SessionLog | undefined,
    sent: SentLog | undefined,
    limit: number
): { update: MessagesUpdate | null; sent: SentLog } {
    const current: SentLog = { key: shown?.key ?? null, label: shown?.label ?? null, id: log?.id ?? null, total: log?.total ?? 0 };
    const sameLog = sent !== undefined && sent.key === current.key && sent.label === current.label && sent.id === current.id;
    if (sameLog && sent.total === current.total) {
        return { update: null, sent: current };
    }
    const added = current.total - (sent?.total ?? 0);
    if (sameLog && log && shown && sent.total > 0 && added > 0 && added <= log.messages.length) {
        return {
            update: {
                type: 'append',
                key: shown.key,
                messages: log.messages.slice(log.messages.length - added).map((message) => ({ ...message, tone: messageTone(message.severity) })),
                total: log.total,
                countText: messagesCountText(log.messages.length, log.total),
                errorsText: errorsCountText(log.errors),
                limit
            },
            sent: current
        };
    }
    return { update: { type: 'log', key: current.key, state: messagesViewState(shown, log) }, sent: current };
}

/** How often at most the panel is updated while messages keep coming. */
export const MESSAGES_RENDER_INTERVAL_MS = 100;

export interface SessionMessagesViewOptions {
    /** Run `render` a little later; tests run it at once. */
    schedule?: (render: () => void) => void;
    /** The most text *Copy* puts on the clipboard; default {@link MAX_COPY_BYTES}. */
    maxCopyBytes?: number;
}

/**
 * The *PostgreSQL Messages* panel. It shows the log of one session at a time:
 * that of the SQL file or Data Viewer tab that was active last.
 */
export class SessionMessagesView implements vscode.WebviewViewProvider, SessionMessageSink, vscode.Disposable {
    static readonly viewType = MESSAGES_VIEW_ID;

    private view?: vscode.WebviewView;
    private shown?: DbSessionRef;
    private readonly subscription: { dispose(): void };
    private readonly configSubscription: { dispose(): void };
    /** What the panel was sent last; undefined when it needs the whole log. */
    private sent?: SentLog;
    private renderPending = false;
    /** Entries of the shown log that changed in place since the last render, by id. */
    private readonly updated = new Map<number, SessionMessage>();
    private readonly schedule: (render: () => void) => void;
    private readonly maxCopyBytes: number;

    constructor(readonly log: SessionMessageLog, options: SessionMessagesViewOptions = {}) {
        this.schedule = options.schedule ?? ((render) => { setTimeout(render, MESSAGES_RENDER_INTERVAL_MS); });
        this.maxCopyBytes = options.maxCopyBytes ?? MAX_COPY_BYTES;
        // A flood of messages becomes one update every few milliseconds, not one per message.
        this.subscription = log.onDidChange((key, updated) => {
            if (key !== this.shown?.key) return;
            if (updated?.id !== undefined) this.updated.set(updated.id, updated);
            this.scheduleRender();
        });
        // The checkbox follows the setting, also when it is changed in the settings.
        this.configSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(`${SETTINGS_SECTION}.${CLEAR_ON_EXECUTE_SETTING}`)) this.postOptions();
        });
    }

    /** The session whose log is shown, if any. */
    get shownSession(): DbSessionRef | undefined {
        return this.shown;
    }

    /** Whether Execute File and Execute Selection clear the log of their session first. */
    get clearOnExecute(): boolean {
        return vscode.workspace.getConfiguration(SETTINGS_SECTION).get<boolean>(CLEAR_ON_EXECUTE_SETTING, false) === true;
    }

    append(ref: DbSessionRef, message: SessionMessage): void {
        this.log.append(ref, message);
    }

    finish(ref: DbSessionRef, started: SessionMessage, status: Exclude<TimerStatus, 'running'>, ms: number): void {
        this.log.finish(ref, started, status, ms);
    }

    runStarting(ref: DbSessionRef): void {
        if (this.clearOnExecute) this.log.clear(ref.key);
    }

    /** Switch the panel to the log of `ref`. */
    show(ref: DbSessionRef): void {
        if (this.shown && this.shown.key === ref.key && this.shown.label === ref.label) return;
        this.shown = { key: ref.key, label: ref.label };
        this.render();
    }

    reveal(ref: DbSessionRef): void {
        this.show(ref);
        if (this.view) {
            this.view.show(true);
            return;
        }
        // Not resolved yet: open it through the command every view gets.
        Promise.resolve(vscode.commands.executeCommand(`${MESSAGES_VIEW_ID}.focus`, { preserveFocus: true }))
            .catch((err: unknown) => Logger.error('SessionMessagesView.reveal', err));
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;
        this.sent = undefined;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml(webviewView.webview);
        webviewView.onDidDispose?.(() => {
            if (this.view === webviewView) this.view = undefined;
        });
        // A hidden panel is sent nothing; shown again, it gets the whole log once.
        webviewView.onDidChangeVisibility?.(() => {
            if (webviewView.visible) {
                this.sent = undefined;
                this.render();
            }
        });
        webviewView.webview.onDidReceiveMessage((message: { type?: string; id?: unknown; value?: unknown }) => {
            if (message.type === 'ready') {
                this.sent = undefined;
                this.postOptions();
                this.render();
            } else if (message.type === 'clear') {
                if (this.shown) this.log.clear(this.shown.key);
            } else if (message.type === 'copy') {
                void this.copy();
            } else if (message.type === 'save') {
                void this.save();
            } else if (message.type === 'openLink') {
                void this.openLink(Number(message.id));
            } else if (message.type === 'clearOnExecute') {
                void this.setClearOnExecute(message.value === true);
            }
        });
    }

    dispose(): void {
        this.subscription.dispose();
        this.configSubscription.dispose();
        this.view = undefined;
        this.log.dispose();
    }

    /** Store the checkbox "Clear on Execute" as the user's setting, for every window. */
    private async setClearOnExecute(value: boolean): Promise<void> {
        try {
            await vscode.workspace.getConfiguration(SETTINGS_SECTION).update(CLEAR_ON_EXECUTE_SETTING, value, vscode.ConfigurationTarget.Global);
        } catch (err: unknown) {
            Logger.error('SessionMessagesView.setClearOnExecute', err);
            vscode.window.showErrorMessage(`"Clear on Execute" could not be saved: ${getErrorMessage(err)}`);
            this.postOptions();
        }
    }

    /** Tell the panel how its checkbox is set. */
    private postOptions(): void {
        const view = this.view;
        if (!view) return;
        Promise.resolve(view.webview.postMessage({ type: 'options', clearOnExecute: this.clearOnExecute })).catch(() => undefined);
    }

    /**
     * Open the file of the entry `id` of the shown log and select the
     * statement it leads to. The place comes from the log, never from the
     * panel, which only names the entry.
     */
    private async openLink(id: number): Promise<void> {
        const shown = this.shown;
        const link = shown ? this.log.get(shown.key)?.messages.find((m) => m.id === id)?.link : undefined;
        if (!link) return;
        try {
            const range = new vscode.Range(link.start.line, link.start.character, link.end.line, link.end.character);
            const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(link.uri));
            // The file stays in the group it is already shown in.
            const visible = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === link.uri);
            const editor = await vscode.window.showTextDocument(document, {
                viewColumn: visible?.viewColumn,
                selection: new vscode.Selection(range.start, range.end),
                preview: false
            });
            editor?.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        } catch (err: unknown) {
            Logger.error('SessionMessagesView.openLink', err);
            vscode.window.showErrorMessage(`The statement at ${link.text} cannot be shown: ${getErrorMessage(err)}`);
        }
    }

    /** Write every message of the shown log to a file the user picks. */
    private async save(): Promise<void> {
        const shown = this.shown;
        if (!shown || !this.log.get(shown.key)?.total) return;
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(folder, messagesFileName(shown.label))),
            filters: { 'Log Files': ['log', 'txt'] },
            title: `Save the Messages of ${shown.label}`
        });
        if (!uri) return;
        try {
            const count = await this.log.saveTo(shown.key, uri.fsPath);
            vscode.window.setStatusBarMessage(`Saved ${count} ${count === 1 ? 'message' : 'messages'} to ${uri.fsPath}.`, 5000);
        } catch (err: unknown) {
            Logger.error('SessionMessagesView.save', err);
            vscode.window.showErrorMessage(`Saving the messages failed: ${getErrorMessage(err)}`);
        }
    }

    /**
     * Put every message of the shown log on the clipboard, as *Save* writes
     * them. A log too large for the clipboard is offered to *Save* instead.
     */
    private async copy(): Promise<void> {
        const shown = this.shown;
        if (!shown || !this.log.get(shown.key)?.total) return;
        try {
            const all = await this.log.readAll(shown.key, this.maxCopyBytes);
            if ('tooLarge' in all) {
                const saveLabel = 'Save';
                const answer = await vscode.window.showWarningMessage(
                    `The session of ${shown.label} sent ${all.count} messages (${byteSizeText(all.bytes)}), `
                    + `more than the clipboard can take safely (${byteSizeText(this.maxCopyBytes)}). Save them to a file instead?`,
                    saveLabel
                );
                if (answer === saveLabel) await this.save();
                return;
            }
            await vscode.env.clipboard.writeText(all.text.replace(/\n$/, ''));
            vscode.window.setStatusBarMessage(`Copied ${all.count} ${all.count === 1 ? 'message' : 'messages'}.`, 3000);
        } catch (err: unknown) {
            Logger.error('SessionMessagesView.copy', err);
            vscode.window.showErrorMessage(`Copying the messages failed: ${getErrorMessage(err)}`);
        }
    }

    private scheduleRender(): void {
        if (this.renderPending) return;
        this.renderPending = true;
        this.schedule(() => {
            this.renderPending = false;
            this.render();
        });
    }

    private render(): void {
        const view = this.view;
        const updated = [...this.updated.values()];
        this.updated.clear();
        if (!view) return;
        if (view.visible === false) {
            this.sent = undefined;
            return;
        }
        const { update, sent } = messagesUpdate(
            this.shown,
            this.shown ? this.log.get(this.shown.key) : undefined,
            this.sent,
            this.log.keptLimit
        );
        this.sent = sent;
        if (update) {
            Promise.resolve(view.webview.postMessage(update)).catch(() => undefined);
        }
        // The whole log already shows every entry as it is now.
        if (updated.length > 0 && this.shown && update?.type !== 'log') {
            const changed: MessagesUpdate = {
                type: 'update',
                key: this.shown.key,
                messages: updated.map((message) => ({ ...message, tone: messageTone(message.severity) }))
            };
            Promise.resolve(view.webview.postMessage(changed)).catch(() => undefined);
        }
    }

    private getHtml(webview: vscode.Webview): string {
        const styles = `
html, body { height: 100%; }
body { padding: 0; display: flex; flex-direction: column; }
.toolbar { justify-content: space-between; flex-wrap: nowrap; padding: var(--sp-1) var(--sp-2); border-bottom: 1px solid var(--c-border); }
.session { display: flex; align-items: baseline; gap: var(--sp-2); min-width: 0; }
.session-label { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count { font-size: var(--fs-xs); color: var(--c-muted); white-space: nowrap; }
.list { flex: 1; position: relative; overflow-y: auto; padding: var(--sp-1) 0; font-family: var(--font-mono); font-size: var(--fs-sm); }
.empty { padding: var(--sp-3); font-family: inherit; color: var(--c-muted); }
.msg { padding: 1px var(--sp-2); white-space: pre-wrap; word-break: break-word; user-select: text; }
.msg-time, .msg-source { color: var(--c-muted); }
.msg-sev { font-weight: 600; }
.msg-sev .ico { vertical-align: text-bottom; margin-right: 2px; }
.msg.tone-danger .msg-sev { color: var(--c-danger); }
.msg.tone-warning .msg-sev { color: var(--c-warning); }
.msg.tone-success .msg-sev { color: var(--c-success); }
.msg.tone-info .msg-sev { color: var(--c-info); }
/* Errors and warnings stand out by a wash, a stripe and an icon, never by hue alone. */
.msg.tone-danger { padding-top: 2px; padding-bottom: 2px; background: color-mix(in srgb, var(--c-danger) 14%, transparent); box-shadow: inset 3px 0 0 var(--c-danger); }
.msg.tone-danger .msg-text { color: var(--c-danger); font-weight: 600; }
.msg.tone-danger .msg-detail { color: var(--c-fg); }
.msg.tone-warning { background: color-mix(in srgb, var(--c-warning) 8%, transparent); box-shadow: inset 3px 0 0 var(--c-warning); }
.msg.tone-danger.current { background: color-mix(in srgb, var(--c-danger) 30%, transparent); box-shadow: inset 6px 0 0 var(--c-danger), inset 0 0 0 1px var(--c-danger); }
.msg-detail { padding-left: var(--sp-5); color: var(--c-muted); }
.msg-link { color: var(--vscode-textLink-foreground); text-decoration: underline; cursor: pointer; }
.msg-link:hover { color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground)); }
.msg-timer { color: var(--c-muted); }
/* How a statement ended is said in words as well, never by hue alone. */
.msg-timer.status-failed { color: var(--c-danger); font-weight: 600; }
.msg-timer.status-cancelled { color: var(--c-warning); }
.errors-btn { color: var(--c-danger); font-weight: 600; }
.errors-btn[hidden] { display: none; }
.clear-on-execute { display: inline-flex; align-items: center; gap: var(--sp-1); white-space: nowrap; cursor: pointer; }`;
        const body = `
<div class="toolbar">
    <div class="session">
        <span class="session-label" id="label"></span><span class="count" id="count"></span>
        <button class="btn btn-sm btn-ghost errors-btn" id="errorsBtn" hidden title="Go to the next error shown in the panel">${icon('error')}<span id="errorsText"></span></button>
    </div>
    <div class="toolbar-group">
        <label class="clear-on-execute" title="Clear the messages of a session each time Execute File or Execute Selection starts in it"><input type="checkbox" id="clearOnExecute">Clear on Execute</label>
        <button class="btn btn-sm" id="copyBtn" title="Copy every message of this session to the clipboard, including those the panel no longer shows">${icon('copy')}Copy</button>
        <button class="btn btn-sm" id="saveBtn" title="Save every message of this session to a file, including those the panel no longer shows">${icon('save')}Save</button>
        <button class="btn btn-sm" id="clearBtn" title="Clear the messages of this session">${icon('trash')}Clear</button>
    </div>
</div>
<div class="list" id="list"></div>`;
        const script = `
const vscode = acquireVsCodeApi();
const listEl = document.getElementById('list');
const labelEl = document.getElementById('label');
const countEl = document.getElementById('count');
const copyBtn = document.getElementById('copyBtn');
const saveBtn = document.getElementById('saveBtn');
const clearBtn = document.getElementById('clearBtn');
const errorsBtn = document.getElementById('errorsBtn');
const errorsTextEl = document.getElementById('errorsText');
const clearOnExecuteBox = document.getElementById('clearOnExecute');
const TONE_ICONS = { danger: ${JSON.stringify(icon('error'))}, warning: ${JSON.stringify(icon('warning'))} };
copyBtn.addEventListener('click', () => vscode.postMessage({ type: 'copy' }));
saveBtn.addEventListener('click', () => vscode.postMessage({ type: 'save' }));
clearBtn.addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
errorsBtn.addEventListener('click', () => goToNextError());
clearOnExecuteBox.addEventListener('change', () => vscode.postMessage({ type: 'clearOnExecute', value: clearOnExecuteBox.checked === true }));

${WEBVIEW_ESCAPE_HTML_JS}
${TIMER_TEXT_JS}

let shownKey = null;
let shownLabel = null;

// The text of an entry, with the part that leads to a statement as a link.
function textHtml(m) {
    const link = m.link;
    const at = link && m.id != null ? m.text.lastIndexOf(link.text) : -1;
    if (at < 0) return escapeHtml(m.text);
    return escapeHtml(m.text.slice(0, at))
        + '<a href="#" class="msg-link" data-link-id="' + escapeHtml(String(m.id)) + '" title="Go to the statement and select it">'
        + escapeHtml(link.text) + '</a>'
        + escapeHtml(m.text.slice(at + link.text.length));
}

function timerHtml(m) {
    const t = m.timer;
    if (!t) return '';
    const running = t.status === 'running';
    return ' · <span class="msg-timer status-' + escapeHtml(t.status) + '"'
        + (running ? ' data-running data-started="' + escapeHtml(String(Number(t.started))) + '"' : '')
        + '>' + escapeHtml(timerText(t, Date.now())) + '</span>';
}

function messageHtml(m) {
    let html = '<div class="msg tone-' + escapeHtml(m.tone) + '"'
        + (m.id != null ? ' data-id="' + escapeHtml(String(m.id)) + '"' : '') + '>'
        + '<span class="msg-time">[' + escapeHtml(m.time) + ']</span> '
        + (m.source && m.source !== shownLabel ? '<span class="msg-source">' + escapeHtml(m.source) + ' — </span>' : '')
        + '<span class="msg-sev">' + (TONE_ICONS[m.tone] || '') + escapeHtml(m.severity) + ':</span> '
        + '<span class="msg-text">' + textHtml(m) + '</span>' + timerHtml(m);
    for (const d of m.details || []) {
        html += '<div class="msg-detail">' + escapeHtml(d) + '</div>';
    }
    return html + '</div>';
}

// A running timer is renewed every second, and only while one is shown.
let timerHandle = null;
function tickTimers() {
    const running = listEl.querySelectorAll('.msg-timer[data-running]');
    if (running.length === 0) {
        clearInterval(timerHandle);
        timerHandle = null;
        return;
    }
    const now = Date.now();
    running.forEach((el) => {
        el.textContent = timerText({ status: 'running', started: Number(el.dataset.started) }, now);
    });
}
function watchTimers() {
    if (timerHandle === null && listEl.querySelectorAll('.msg-timer[data-running]').length > 0) {
        timerHandle = setInterval(tickTimers, 1000);
    }
}

listEl.addEventListener('click', (e) => {
    const link = e && e.target && e.target.closest ? e.target.closest('.msg-link') : null;
    if (!link) return;
    e.preventDefault();
    vscode.postMessage({ type: 'openLink', id: Number(link.dataset.linkId) });
});

function isAtBottom() {
    return listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 4;
}

function updateHeader(countText, total, errorsText) {
    countEl.textContent = countText || '';
    errorsTextEl.textContent = errorsText || '';
    errorsBtn.hidden = !errorsText;
    copyBtn.disabled = !total;
    saveBtn.disabled = !total;
    clearBtn.disabled = !total;
}

// From the marked error to the next one, round to the first; without a mark,
// to the first error from where the list is scrolled to.
function goToNextError() {
    const errors = Array.from(listEl.querySelectorAll('.msg.tone-danger'));
    if (errors.length === 0) return;
    const at = errors.findIndex((el) => el.classList.contains('current'));
    const next = at >= 0
        ? errors[(at + 1) % errors.length]
        : errors.find((el) => el.offsetTop >= listEl.scrollTop) || errors[0];
    if (at >= 0) errors[at].classList.remove('current');
    next.classList.add('current');
    listEl.scrollTop = next.offsetTop;
}

function render(key, state) {
    const switched = key !== shownKey;
    shownKey = key;
    shownLabel = state.label;
    const atBottom = isAtBottom();
    const messages = state.messages || [];
    labelEl.textContent = state.label ? 'Session of ' + state.label : 'No session';
    labelEl.title = state.label ? 'The database session of ' + state.label + ' and every tab sharing it' : '';
    updateHeader(state.countText, state.total, state.errorsText);
    if (!state.label) {
        listEl.innerHTML = '<div class="empty">Open a SQL file or a Data Viewer tab to see the messages of its database session.</div>';
        return;
    }
    if (messages.length === 0) {
        listEl.innerHTML = '<div class="empty">No messages from the database session of ' + escapeHtml(state.label) + ' yet.</div>';
        return;
    }
    listEl.innerHTML = messages.map(messageHtml).join('');
    if (switched || atBottom) {
        listEl.scrollTop = listEl.scrollHeight;
    }
    watchTimers();
}

// New messages are added below and the oldest beyond the limit removed, so
// the list is never rebuilt while a session keeps sending.
function append(update) {
    if (update.key !== shownKey) return;
    const atBottom = isAtBottom();
    const empty = listEl.querySelector('.empty');
    if (empty) empty.remove();
    listEl.insertAdjacentHTML('beforeend', update.messages.map(messageHtml).join(''));
    let excess = listEl.childElementCount - update.limit;
    while (excess-- > 0 && listEl.firstElementChild) {
        listEl.firstElementChild.remove();
    }
    updateHeader(update.countText, update.total, update.errorsText);
    if (atBottom) {
        listEl.scrollTop = listEl.scrollHeight;
    }
    watchTimers();
}

// An entry that changed in place — a statement that ended — is drawn anew
// where it is; one the panel no longer shows is left alone.
function replace(update) {
    if (update.key !== shownKey) return;
    for (const m of update.messages) {
        const el = listEl.querySelector('.msg[data-id="' + Number(m.id) + '"]');
        if (el) el.outerHTML = messageHtml(m);
    }
}

window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg && msg.type === 'log') {
        render(msg.key, msg.state);
    } else if (msg && msg.type === 'append') {
        append(msg);
    } else if (msg && msg.type === 'update') {
        replace(msg);
    } else if (msg && msg.type === 'options') {
        clearOnExecuteBox.checked = msg.clearOnExecute === true;
    }
});

vscode.postMessage({ type: 'ready' });`;
        return buildHtmlDocument({ webview, title: MESSAGES_PANEL_NAME, styles, body, script });
    }
}
