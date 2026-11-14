import type { QueryArrayResult, QueryResult } from 'pg';

/**
 * A message the server sends alongside a result: `RAISE NOTICE` / `INFO` /
 * `WARNING` in PL/pgSQL, or a notice of the server itself.
 */
export interface SessionNotice {
    severity?: string;
    message?: string;
    detail?: string;
    hint?: string;
    where?: string;
}

/** The part of a `pg` client a session needs; tests pass a fake. */
export interface SessionClient {
    /** Backend process id, known once the connection is established. */
    readonly processID?: number | null;
    query(text: string, values?: unknown[]): Promise<QueryResult>;
    query(config: { text: string; rowMode: 'array'; values?: unknown[] }): Promise<QueryArrayResult>;
    end(): Promise<void>;
    on(event: 'error', listener: (err: Error) => void): unknown;
    on(event: 'end', listener: () => void): unknown;
    on(event: 'notice', listener: (notice: SessionNotice) => void): unknown;
    removeListener(event: 'error', listener: (err: Error) => void): unknown;
    removeListener(event: 'notice', listener: (notice: SessionNotice) => void): unknown;
    /** `I` idle, `T` inside a transaction, `E` inside a failed transaction (pg ≥ 8.20). */
    getTransactionStatus?(): string | null;
}

export type QueryFn = (sql: string, params?: unknown[]) => Promise<QueryResult>;

/**
 * When the work of a session becomes permanent:
 * - `auto`   — every statement is committed as soon as it has run.
 * - `manual` — Execute opens a transaction; nothing is permanent until the
 *              user commits it (the panel's *Commit*, or `COMMIT`).
 * - `run`    — each Execute File / Execute Selection is one transaction,
 *              committed when every statement succeeded and rolled back otherwise.
 */
export type CommitMode = 'auto' | 'manual' | 'run';

export const COMMIT_MODES: ReadonlyArray<CommitMode> = ['auto', 'manual', 'run'];

/** How a commit mode is offered to the user. */
export const COMMIT_MODE_LABELS: Readonly<Record<CommitMode, string>> = {
    auto: 'Auto-commit',
    manual: 'Manual commit',
    run: 'Commit per run'
};

/** What a commit mode does, for a tooltip. */
export const COMMIT_MODE_DESCRIPTIONS: Readonly<Record<CommitMode, string>> = {
    auto: 'Every statement is committed as soon as it has run.',
    manual: 'Execute opens a transaction; nothing is permanent until you press Commit or run COMMIT.',
    run: 'Each Execute File or Execute Selection is one transaction: committed when every statement succeeded, rolled back when one fails or is cancelled.'
};

/** The commit mode `value` names; `auto` for anything else, the behaviour before the choice existed. */
export function parseCommitMode(value: unknown): CommitMode {
    return COMMIT_MODES.includes(value as CommitMode) ? value as CommitMode : 'auto';
}

/**
 * Where the transaction of a session stands: `none` without a connection,
 * `idle` outside a transaction, `open` inside one that is not committed yet,
 * `failed` inside one a statement has aborted, which accepts only ROLLBACK.
 */
export type TransactionState = 'none' | 'idle' | 'open' | 'failed';

/**
 * Statements PostgreSQL refuses inside a transaction block, and those that
 * control the transaction themselves: no BEGIN is put in front of them.
 */
const OUTSIDE_TRANSACTION = new RegExp(
    '^(?:VACUUM|CHECKPOINT|DISCARD\\s+ALL|ALTER\\s+SYSTEM|(?:CREATE|DROP)\\s+(?:DATABASE|TABLESPACE)'
    + '|(?:CREATE|DROP)\\s+(?:UNIQUE\\s+)?INDEX\\s+CONCURRENTLY|REINDEX\\b[\\s\\S]*\\bCONCURRENTLY'
    + '|BEGIN|START\\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE\\s+TRANSACTION)\\b',
    'i'
);

/** Whether `sql` must run without a transaction opened for it; leading comments are skipped. */
export function runsOutsideTransaction(sql: string): boolean {
    const code = String(sql).replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, '');
    return OUTSIDE_TRANSACTION.test(code);
}

/**
 * Where the statements of a Data Viewer run: on any pooled connection, or on
 * the one connection of a {@link DbSession}.
 */
export interface QueryExecutor {
    query: QueryFn;
    queryPositional(sql: string, params?: unknown[]): Promise<QueryArrayResult>;
    /**
     * Run `work` as one unit that is applied completely or not at all. `joined`
     * is true when it ran inside a transaction the user had already opened, so
     * nothing is permanent before the user commits it.
     */
    transaction<T>(work: (query: QueryFn, joined: boolean) => Promise<T>): Promise<T>;
    /**
     * Run `work` on one connection that nothing else uses meanwhile, for
     * several statements that belong together (a cursor fetched in batches).
     */
    run?<T>(work: (client: SessionClient) => Promise<T>): Promise<T>;
}

/** Names a session: the key it is shared under and what it is shown as. */
export interface DbSessionRef {
    key: string;
    label: string;
}

/** What a session needs from the {@link DbSessionManager} that owns it. */
interface DbSessionHost {
    openClient(): Promise<SessionClient>;
    generation(): number;
    changed(session: DbSession): void;
    lost(session: DbSession, reason: string): void;
    notice(session: DbSession, notice: SessionNotice): void;
    commitMode(session: DbSession): CommitMode;
}

const noop = (): void => undefined;

/** The savepoint a save runs in when the user has a transaction open. */
const SAVEPOINT = 'pqb_save';

/** The transaction state of `client`; a client that cannot tell counts as idle. */
function transactionStatus(client: SessionClient): string {
    return client.getTransactionStatus?.() ?? 'I';
}

function transactionStateOf(client: SessionClient | null): TransactionState {
    if (!client) return 'none';
    const status = transactionStatus(client);
    return status === 'T' ? 'open' : status === 'E' ? 'failed' : 'idle';
}

/**
 * One database session that stays the same from one statement to the next:
 * settings made with `SET` or `set_config`, temporary tables and an open
 * transaction survive until the session is reset or closed. A pooled
 * connection cannot promise that, because every statement may get another one.
 *
 * The connection is opened with the first statement, not before. Statements run
 * strictly one after the other — a transaction is one unit, so nothing else
 * can slip into it. When the active connection is switched, the session
 * quietly reconnects on its next statement; when the server drops it, the next
 * statement opens a new one and the owner is told the old state is gone.
 */
export class DbSession implements QueryExecutor {
    private client: SessionClient | null = null;
    private clientGeneration = 0;
    private tail: Promise<void> = Promise.resolve();
    private lostReason: string | null = null;
    private closed = false;
    /** The transaction state last announced, so a change is announced once. */
    private announcedState: TransactionState = 'none';
    private interruptionCount = 0;

    constructor(
        readonly key: string,
        readonly label: string,
        /** The holder that created the session; see {@link DbSessionManager.acquire}. */
        readonly owner: string,
        private readonly host: DbSessionHost
    ) {}

    get isOpen(): boolean {
        return this.client !== null;
    }

    get isClosed(): boolean {
        return this.closed;
    }

    get processId(): number | null {
        return this.client?.processID ?? null;
    }

    /** Where the session's transaction stands now. */
    get transactionState(): TransactionState {
        return transactionStateOf(this.client);
    }

    /**
     * How often the session's connection was closed on purpose — by a reset,
     * a switch of the connection or the end of the session. A statement that
     * fails while this changes was cancelled rather than wrong.
     */
    get interruptions(): number {
        return this.interruptionCount;
    }

    /** When the work of this session becomes permanent; see {@link CommitMode}. */
    get commitMode(): CommitMode {
        return this.host.commitMode(this);
    }

    /** Run `work` on the session's connection once every earlier statement is done. */
    run<T>(work: (client: SessionClient) => Promise<T>): Promise<T> {
        const result = this.tail.then(async () => {
            const client = await this.connection();
            try {
                return await work(client);
            } finally {
                this.announceTransactionState();
            }
        });
        this.tail = result.then(noop, noop);
        return result;
    }

    /**
     * Before a statement of Execute in `manual` or `run` mode: open a
     * transaction unless one is open, or the statement may not run in one.
     * Returns true when it opened one. Waits for the session's turn; inside
     * {@link run} use {@link beginOn} instead.
     */
    beginForStatement(sql: string): Promise<boolean> {
        if (this.commitMode === 'auto' || runsOutsideTransaction(sql)) return Promise.resolve(false);
        return this.run((client) => this.beginOn(client, sql));
    }

    /** {@link beginForStatement} on `client`, from inside {@link run}. */
    async beginOn(client: SessionClient, sql: string): Promise<boolean> {
        if (this.commitMode === 'auto' || transactionStatus(client) !== 'I' || runsOutsideTransaction(sql)) {
            return false;
        }
        await client.query('BEGIN');
        return true;
    }

    /** End the open transaction with COMMIT; false when none was open. */
    commit(): Promise<boolean> {
        return this.endTransaction('COMMIT');
    }

    /** End the open — or failed — transaction with ROLLBACK; false when none was open. */
    rollback(): Promise<boolean> {
        return this.endTransaction('ROLLBACK');
    }

    private endTransaction(command: 'COMMIT' | 'ROLLBACK'): Promise<boolean> {
        if (!this.client) return Promise.resolve(false);
        return this.run(async (client) => {
            if (transactionStatus(client) === 'I') return false;
            await client.query(command);
            return true;
        });
    }

    private announceTransactionState(): void {
        const state = this.transactionState;
        if (state === this.announcedState) return;
        this.announcedState = state;
        this.host.changed(this);
    }

    query(sql: string, params?: unknown[]): Promise<QueryResult> {
        return this.run((client) => client.query(sql, params));
    }

    queryPositional(sql: string, params?: unknown[]): Promise<QueryArrayResult> {
        return this.run((client) => client.query({ text: sql, rowMode: 'array', values: params }));
    }

    /**
     * Run `sql` only while the session is outside a transaction, and return
     * null otherwise: inside a transaction a statement that fails would abort
     * the user's open work.
     */
    queryOutsideTransaction(sql: string): Promise<QueryResult | null> {
        return this.run(async (client) => (transactionStatus(client) === 'I' ? client.query(sql) : null));
    }

    /**
     * Inside a transaction the user opened, the work becomes a savepoint of it
     * instead: BEGIN would be ignored and COMMIT or ROLLBACK would end the
     * user's own transaction. A failed transaction accepts nothing until the
     * user ends it, so the work is refused. In `manual` mode the work opens a
     * transaction of its own that stays open for the user to commit.
     */
    transaction<T>(work: (query: QueryFn, joined: boolean) => Promise<T>): Promise<T> {
        return this.run(async (client) => {
            let status = transactionStatus(client);
            if (status === 'E') {
                throw new Error(
                    `The open transaction of the database session of ${this.label} has failed, so nothing can be saved in it. `
                    + 'End it with ROLLBACK or reset the session.'
                );
            }
            // Manual commit: the work goes into a transaction left open for the user.
            const opened = status === 'I' && this.commitMode === 'manual';
            if (opened) {
                await client.query('BEGIN');
                status = 'T';
            }
            const joined = status === 'T';
            await client.query(joined ? `SAVEPOINT ${SAVEPOINT}` : 'BEGIN');
            try {
                const result = await work((sql, params) => client.query(sql, params), joined);
                await client.query(joined ? `RELEASE SAVEPOINT ${SAVEPOINT}` : 'COMMIT');
                return result;
            } catch (err) {
                try {
                    if (opened) {
                        // Nothing else is in the transaction opened for this work.
                        await client.query('ROLLBACK');
                    } else if (joined) {
                        // Back to where the user's transaction stood, savepoint gone.
                        await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
                        await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
                    } else {
                        await client.query('ROLLBACK');
                    }
                } catch {
                    // The statement's own error is the one worth reporting.
                }
                throw err;
            }
        });
    }

    /**
     * Throw the session's state away: the connection is closed (cancelling a
     * statement that is still running) and the next statement opens a new one.
     * Returns false when no connection was open.
     */
    reset(): boolean {
        this.lostReason = null;
        if (!this.client) return false;
        this.drop();
        this.host.changed(this);
        return true;
    }

    /**
     * Close a connection opened for a connection that has since been switched;
     * the next statement reconnects. One opened for the active connection —
     * by a statement that ran while the switch was announced — stays.
     */
    disconnect(): void {
        if (!this.client || this.clientGeneration === this.host.generation()) return;
        this.drop();
        this.host.changed(this);
    }

    /** Close the session for good; any later statement fails. */
    close(): void {
        this.closed = true;
        this.lostReason = null;
        this.drop();
    }

    private async connection(): Promise<SessionClient> {
        if (this.closed) {
            throw new Error(`The database session of ${this.label} has been closed.`);
        }
        if (this.client && this.clientGeneration !== this.host.generation()) {
            // Opened for a connection that has since been switched.
            this.drop();
        }
        if (this.client) {
            return this.client;
        }
        const generation = this.host.generation();
        const client = await this.host.openClient();
        if (this.closed || generation !== this.host.generation()) {
            client.end().catch(noop);
            return this.connection();
        }
        client.on('error', (err: Error) => this.broken(client, err.message));
        client.on('end', () => this.broken(client, 'the server closed the connection'));
        client.on('notice', (notice: SessionNotice) => this.host.notice(this, notice));
        this.client = client;
        this.clientGeneration = generation;
        this.announcedState = transactionStateOf(client);
        const lost = this.lostReason;
        this.lostReason = null;
        if (lost) {
            this.host.lost(this, lost);
        }
        this.host.changed(this);
        return client;
    }

    /** The connection failed or was closed by the server; remember why for the next statement. */
    private broken(client: SessionClient, reason: string): void {
        if (this.client !== client) return;
        this.client = null;
        this.announcedState = 'none';
        this.lostReason = reason;
        client.end().catch(noop);
        this.host.changed(this);
    }

    private drop(): void {
        const client = this.client;
        this.client = null;
        this.announcedState = 'none';
        if (client) {
            this.interruptionCount++;
            client.end().catch(noop);
        }
    }
}

export interface DbSessionManagerOptions {
    /** Open a new, connected client for the active connection. */
    openClient(): Promise<SessionClient>;
    /** Changes whenever the active connection is replaced. */
    generation(): number;
    /** A session lost its connection unexpectedly and has just opened a new one. */
    onLost?(session: DbSession, reason: string): void;
    onNotice?(session: DbSession, notice: SessionNotice): void;
    /** The commit mode of a session nobody chose one for: that of the active connection. */
    defaultCommitMode?(): CommitMode;
}

/**
 * The sessions in use, each shared by the holders that acquired it — a Data
 * Viewer tab, the tabs opened from it, a SQL file. A session lives until its
 * last holder releases it.
 */
export class DbSessionManager {
    private readonly entries = new Map<string, { session: DbSession; holders: Set<string> }>();
    private readonly listeners = new Set<(key: string) => void>();
    private readonly host: DbSessionHost;
    /** Commit modes chosen for a session, by its key; also before the session exists. */
    private readonly commitModes = new Map<string, CommitMode>();
    private readonly defaultCommitMode: () => CommitMode;

    constructor(options: DbSessionManagerOptions) {
        this.defaultCommitMode = () => parseCommitMode(options.defaultCommitMode?.());
        this.host = {
            openClient: () => options.openClient(),
            generation: () => options.generation(),
            changed: (session) => this.emit(session.key),
            lost: (session, reason) => options.onLost?.(session, reason),
            notice: (session, notice) => options.onNotice?.(session, notice),
            commitMode: (session) => this.commitModeOf(session.key)
        };
    }

    /** The commit mode of the session `key`: the one chosen for it, else that of the active connection. */
    commitModeOf(key: string): CommitMode {
        return this.commitModes.get(key) ?? this.defaultCommitMode();
    }

    /** Choose the commit mode of the session `key` until it ends. */
    setCommitMode(key: string, mode: CommitMode): void {
        if (this.commitModeOf(key) === mode && this.commitModes.has(key)) return;
        this.commitModes.set(key, parseCommitMode(mode));
        this.emit(key);
    }

    /** The session of `ref`, created on first use; `holder` keeps it alive until released. */
    acquire(ref: DbSessionRef, holder: string): DbSession {
        let entry = this.entries.get(ref.key);
        if (!entry) {
            entry = { session: new DbSession(ref.key, ref.label, holder, this.host), holders: new Set() };
            this.entries.set(ref.key, entry);
        }
        const added = !entry.holders.has(holder);
        entry.holders.add(holder);
        if (added && entry.holders.size > 1) {
            this.emit(ref.key);
        }
        return entry.session;
    }

    release(key: string, holder: string): void {
        const entry = this.entries.get(key);
        if (!entry || !entry.holders.delete(holder)) return;
        if (entry.holders.size === 0) {
            this.entries.delete(key);
            this.commitModes.delete(key);
            entry.session.close();
        }
        this.emit(key);
    }

    get(key: string): DbSession | undefined {
        return this.entries.get(key)?.session;
    }

    holderCount(key: string): number {
        return this.entries.get(key)?.holders.size ?? 0;
    }

    /** Close every open connection, e.g. because the active connection was switched. */
    disconnectAll(): void {
        for (const { session } of this.entries.values()) {
            session.disconnect();
        }
    }

    onDidChange(listener: (key: string) => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
    }

    dispose(): void {
        for (const { session } of this.entries.values()) {
            session.close();
        }
        this.entries.clear();
        this.commitModes.clear();
        this.listeners.clear();
    }

    private emit(key: string): void {
        for (const listener of [...this.listeners]) {
            listener(key);
        }
    }
}
