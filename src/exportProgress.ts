import type { FieldDef, QueryArrayResult, QueryResult } from 'pg';

/**
 * The steps of an export: the rows of the query are counted, fetched in
 * batches, turned into the text of the file, and the file is saved.
 */
export type ExportPhase = 'counting' | 'fetching' | 'writing' | 'saving';

/** How far one step of an export has come; `total` is null while unknown. */
export interface ExportProgressUpdate {
    phase: ExportPhase;
    done?: number;
    total?: number | null;
}

/** What an export is shown as: `percent` is null while it cannot be told. */
export interface ExportProgressState {
    phase: ExportPhase;
    percent: number | null;
    message: string;
}

/** What the writing of a file needs: somewhere to report to, and a way to stop. */
export interface ExportProgressSink {
    report(update: ExportProgressUpdate): void;
    /** Throws {@link ExportCancelledError} once the export was cancelled. */
    throwIfCancelled(): void;
}

/** Thrown when an export is cancelled; nothing has been written by then. */
export class ExportCancelledError extends Error {
    constructor() {
        super('The export was cancelled.');
        this.name = 'ExportCancelledError';
    }
}

/** The share of the bar each step fills: fetching the rows takes the most time. */
const FETCH_END = 60;
const WRITE_END = 95;

function ratio(done: number | undefined, total: number | null | undefined): number | null {
    if (total === null || total === undefined) return null;
    if (total <= 0) return 1;
    return Math.min(1, Math.max(0, (done ?? 0) / total));
}

/**
 * The percentage of the whole export an update stands for, or null when it
 * cannot be told — while counting, or while fetching a query whose rows could
 * not be counted.
 */
export function exportProgressPercent(update: ExportProgressUpdate): number | null {
    switch (update.phase) {
        case 'counting':
            return null;
        case 'fetching': {
            const r = ratio(update.done, update.total);
            return r === null ? null : r * FETCH_END;
        }
        case 'writing': {
            const r = ratio(update.done, update.total);
            return r === null ? FETCH_END : FETCH_END + r * (WRITE_END - FETCH_END);
        }
        case 'saving':
            return WRITE_END;
    }
}

function count(n: number): string {
    return Math.max(0, Math.floor(n)).toLocaleString('en-US');
}

/** The line shown next to the bar, e.g. `Fetching rows: 12,000 of 30,000`. */
export function describeExportProgress(update: ExportProgressUpdate): string {
    const done = count(update.done ?? 0);
    const of = typeof update.total === 'number' ? ` of ${count(update.total)}` : '';
    switch (update.phase) {
        case 'counting':
            return 'Counting rows…';
        case 'fetching':
            return `Fetching rows: ${done}${of}`;
        case 'writing':
            return `Writing rows: ${done}${of}`;
        case 'saving':
            return 'Saving the file…';
    }
}

/**
 * Rows per FETCH: about a hundredth of the result, so the bar moves in small
 * steps, but never so few that the round trips cost more than the rows.
 */
export function exportBatchSize(total: number | null): number {
    if (total === null) return 2000;
    return Math.min(10000, Math.max(500, Math.ceil(total / 100)));
}

/** The client an export fetches through; a `pg` client or a session's client. */
export interface CursorClient {
    readonly processID?: number | null;
    query(text: string): Promise<QueryResult>;
    query(config: { text: string; rowMode: 'array' }): Promise<QueryArrayResult>;
    /** `I` idle, `T` inside a transaction, `E` inside a failed transaction. */
    getTransactionStatus?(): string | null;
}

/**
 * Follows one export: turns the updates of its steps into one growing
 * percentage and a line of text for whoever shows it, and cancels it — between
 * two steps, or by asking the server to cancel the statement that is running.
 */
export class ExportTracker implements ExportProgressSink {
    private isCancelled = false;
    private runningPid: number | null = null;
    private cancelRequest: Promise<void> | null = null;
    private last: ExportProgressState | null = null;
    private highest = 0;

    constructor(private readonly options: {
        /** Told whenever the shown percentage or step changes. */
        onChange?: (state: ExportProgressState) => void;
        /** Asks the server to cancel the statement of a backend process. */
        cancelBackend?: (pid: number) => Promise<void>;
    } = {}) {}

    get cancelled(): boolean {
        return this.isCancelled;
    }

    report(update: ExportProgressUpdate): void {
        const raw = exportProgressPercent(update);
        // The bar never moves backwards, even when a count was too low.
        const percent = raw === null ? null : Math.max(this.highest, Math.min(100, raw));
        if (percent !== null) this.highest = percent;
        const state: ExportProgressState = { phase: update.phase, percent, message: describeExportProgress(update) };
        const last = this.last;
        const changed = !last
            || last.phase !== state.phase
            || (state.percent === null ? last.percent !== null || last.message !== state.message
                : last.percent === null || Math.floor(last.percent) !== Math.floor(state.percent));
        if (!changed) return;
        this.last = state;
        this.options.onChange?.(state);
    }

    cancel(): void {
        if (this.isCancelled) return;
        this.isCancelled = true;
        if (this.runningPid !== null && this.options.cancelBackend) {
            this.cancelRequest = this.options.cancelBackend(this.runningPid).catch(() => undefined);
        }
    }

    throwIfCancelled(): void {
        if (this.isCancelled) throw new ExportCancelledError();
    }

    /**
     * Run one statement on `client` so that Cancel can reach it. The next
     * statement waits until a cancel request has been handled, or the server
     * would cancel that one instead.
     */
    async during<T>(client: { readonly processID?: number | null }, work: () => Promise<T>): Promise<T> {
        this.throwIfCancelled();
        this.runningPid = client.processID ?? null;
        try {
            return await work();
        } finally {
            this.runningPid = null;
            await this.settled();
        }
    }

    /** Settles once a cancel request sent to the server has been handled. */
    async settled(): Promise<void> {
        const request = this.cancelRequest;
        this.cancelRequest = null;
        if (request) await request;
    }
}

/**
 * Feed a VS Code progress notification: it only takes increments, so the
 * difference to the last percentage is reported.
 */
export function notificationProgress(progress: { report(value: { message?: string; increment?: number }): void }): (state: ExportProgressState) => void {
    let shown = 0;
    return (state) => {
        const increment = state.percent === null ? 0 : Math.max(0, state.percent - shown);
        shown += increment;
        progress.report(increment > 0 ? { message: state.message, increment } : { message: state.message });
    };
}

const EXPORT_CURSOR = 'pqb_export';
const EXPORT_SAVEPOINT = 'pqb_export';
const COUNT_SAVEPOINT = 'pqb_export_count';

/**
 * Fetch the rows of one query in batches, so an export can show how far it has
 * come and be cancelled between two batches. The rows are counted first; a
 * query that cannot be counted is fetched all the same, without a percentage.
 *
 * `sql` must be a single statement a cursor can be declared for (SELECT,
 * VALUES, TABLE or a WITH query that does not write). Outside a transaction it
 * runs in one of its own; inside one the user opened, in a savepoint of it,
 * so a failed or cancelled export leaves that transaction as it was.
 */
export async function fetchRowsInBatches(
    client: CursorClient,
    sql: string,
    tracker: ExportTracker
): Promise<{ fields: FieldDef[]; rows: unknown[][] }> {
    const status = client.getTransactionStatus?.() ?? 'I';
    if (status === 'E') {
        // A failed transaction accepts nothing; let the server say so.
        tracker.report({ phase: 'fetching', done: 0, total: null });
        const result = await tracker.during(client, () => client.query({ text: sql, rowMode: 'array' }));
        return { fields: result.fields ?? [], rows: (result.rows ?? []) as unknown[][] };
    }
    // On lines of its own, so a trailing line comment cannot swallow what follows.
    const body = sql.replace(/[\s;]+$/, '');
    const own = status === 'I';
    tracker.throwIfCancelled();
    await client.query(own ? 'BEGIN' : `SAVEPOINT ${EXPORT_SAVEPOINT}`);
    try {
        if (own) {
            // Plan for all rows, as the plain query would, not for the first few.
            await client.query('SET LOCAL cursor_tuple_fraction = 1');
        }
        tracker.report({ phase: 'counting' });
        let total: number | null = null;
        await client.query(`SAVEPOINT ${COUNT_SAVEPOINT}`);
        try {
            const counted = await tracker.during(client, () => client.query({
                text: `SELECT count(*) FROM (\n${body}\n) AS _pqb_export_count`,
                rowMode: 'array'
            }));
            total = Number((counted.rows as unknown[][])[0]?.[0]);
            if (!Number.isFinite(total)) total = null;
            await client.query(`RELEASE SAVEPOINT ${COUNT_SAVEPOINT}`);
        } catch (err) {
            if (tracker.cancelled) throw err;
            // Not every query can be counted; it is fetched without a percentage.
            await client.query(`ROLLBACK TO SAVEPOINT ${COUNT_SAVEPOINT}`);
            await client.query(`RELEASE SAVEPOINT ${COUNT_SAVEPOINT}`);
        }

        await tracker.during(client, () => client.query(`DECLARE ${EXPORT_CURSOR} NO SCROLL CURSOR FOR\n${body}\n`));
        const batch = exportBatchSize(total);
        const rows: unknown[][] = [];
        let fields: FieldDef[] | undefined;
        tracker.report({ phase: 'fetching', done: 0, total });
        for (;;) {
            const result = await tracker.during(client, () => client.query({
                text: `FETCH FORWARD ${batch} FROM ${EXPORT_CURSOR}`,
                rowMode: 'array'
            }));
            fields = fields ?? result.fields;
            // A FETCH the server finished despite Cancel still ends the export.
            tracker.throwIfCancelled();
            for (const row of (result.rows ?? []) as unknown[][]) rows.push(row);
            tracker.report({ phase: 'fetching', done: rows.length, total: total === null ? null : Math.max(total, rows.length) });
            if ((result.rows ?? []).length < batch) break;
        }
        await client.query(`CLOSE ${EXPORT_CURSOR}`);
        await client.query(own ? 'COMMIT' : `RELEASE SAVEPOINT ${EXPORT_SAVEPOINT}`);
        return { fields: fields ?? [], rows };
    } catch (err) {
        await tracker.settled();
        try {
            if (own) {
                await client.query('ROLLBACK');
            } else {
                await client.query(`ROLLBACK TO SAVEPOINT ${EXPORT_SAVEPOINT}`);
                await client.query(`RELEASE SAVEPOINT ${EXPORT_SAVEPOINT}`);
            }
        } catch {
            // The error of the export is the one worth reporting.
        }
        if (tracker.cancelled) throw new ExportCancelledError();
        throw err;
    }
}
