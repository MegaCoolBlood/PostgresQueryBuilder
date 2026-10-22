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
}

export type QueryFn = (sql: string, params?: unknown[]) => Promise<QueryResult>;

/**
 * Where the statements of a Data Viewer run: on any pooled connection, or on
 * the one connection of a {@link DbSession}.
 */
export interface QueryExecutor {
    query: QueryFn;
    queryPositional(sql: string, params?: unknown[]): Promise<QueryArrayResult>;
    /** Run `work` between BEGIN and COMMIT, rolling back when it throws. */
    transaction<T>(work: (query: QueryFn) => Promise<T>): Promise<T>;
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
}

const noop = (): void => undefined;

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

    /** Run `work` on the session's connection once every earlier statement is done. */
    run<T>(work: (client: SessionClient) => Promise<T>): Promise<T> {
        const result = this.tail.then(async () => work(await this.connection()));
        this.tail = result.then(noop, noop);
        return result;
    }

    query(sql: string, params?: unknown[]): Promise<QueryResult> {
        return this.run((client) => client.query(sql, params));
    }

    queryPositional(sql: string, params?: unknown[]): Promise<QueryArrayResult> {
        return this.run((client) => client.query({ text: sql, rowMode: 'array', values: params }));
    }

    transaction<T>(work: (query: QueryFn) => Promise<T>): Promise<T> {
        return this.run(async (client) => {
            await client.query('BEGIN');
            try {
                const result = await work((sql, params) => client.query(sql, params));
                await client.query('COMMIT');
                return result;
            } catch (err) {
                try {
                    await client.query('ROLLBACK');
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

    /** Close the connection because the active connection changed; the next statement reconnects. */
    disconnect(): void {
        if (!this.client) return;
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
        this.lostReason = reason;
        client.end().catch(noop);
        this.host.changed(this);
    }

    private drop(): void {
        const client = this.client;
        this.client = null;
        if (client) {
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

    constructor(options: DbSessionManagerOptions) {
        this.host = {
            openClient: () => options.openClient(),
            generation: () => options.generation(),
            changed: (session) => this.emit(session.key),
            lost: (session, reason) => options.onLost?.(session, reason),
            notice: (session, notice) => options.onNotice?.(session, notice)
        };
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
        this.listeners.clear();
    }

    private emit(key: string): void {
        for (const listener of [...this.listeners]) {
            listener(key);
        }
    }
}
