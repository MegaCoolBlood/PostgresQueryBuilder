import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ExportCancelledError,
    ExportTracker,
    describeExportProgress,
    exportBatchSize,
    exportProgressPercent,
    fetchRowsInBatches,
    notificationProgress,
    type ExportProgressState
} from '../exportProgress';

// ===== what the bar shows =====

test('the bar fills while the rows are fetched, then while they are written', () => {
    assert.equal(exportProgressPercent({ phase: 'counting' }), null, 'nothing to tell while counting');
    assert.equal(exportProgressPercent({ phase: 'fetching', done: 0, total: 1000 }), 0);
    assert.equal(exportProgressPercent({ phase: 'fetching', done: 500, total: 1000 }), 30);
    assert.equal(exportProgressPercent({ phase: 'fetching', done: 1000, total: 1000 }), 60);
    assert.equal(exportProgressPercent({ phase: 'fetching', done: 500, total: null }), null, 'a query that could not be counted');
    assert.equal(exportProgressPercent({ phase: 'fetching', done: 0, total: 0 }), 60, 'an empty result is fetched at once');
    assert.equal(exportProgressPercent({ phase: 'writing', done: 0, total: 1000 }), 60);
    assert.equal(exportProgressPercent({ phase: 'writing', done: 500, total: 1000 }), 77.5);
    assert.equal(exportProgressPercent({ phase: 'writing', done: 2000, total: 1000 }), 95, 'never past the end of its step');
    assert.equal(exportProgressPercent({ phase: 'saving' }), 95);
});

test('the line next to the bar names the step and the rows', () => {
    assert.equal(describeExportProgress({ phase: 'counting' }), 'Counting rows…');
    assert.equal(describeExportProgress({ phase: 'fetching', done: 12000, total: 30000 }), 'Fetching rows: 12,000 of 30,000');
    assert.equal(describeExportProgress({ phase: 'fetching', done: 4000, total: null }), 'Fetching rows: 4,000');
    assert.equal(describeExportProgress({ phase: 'writing', done: 1500, total: 1500 }), 'Writing rows: 1,500 of 1,500');
    assert.equal(describeExportProgress({ phase: 'saving' }), 'Saving the file…');
});

test('the rows are fetched in about a hundred batches, within bounds', () => {
    assert.equal(exportBatchSize(null), 2000);
    assert.equal(exportBatchSize(0), 500);
    assert.equal(exportBatchSize(30000), 500);
    assert.equal(exportBatchSize(250000), 2500);
    assert.equal(exportBatchSize(50_000_000), 10000);
});

test('the tracker tells only of changes, and its bar never moves backwards', () => {
    const states: ExportProgressState[] = [];
    const tracker = new ExportTracker({ onChange: (s) => states.push(s) });
    tracker.report({ phase: 'counting' });
    tracker.report({ phase: 'fetching', done: 0, total: 1000 });
    tracker.report({ phase: 'fetching', done: 1, total: 1000 }); // still 0 %
    tracker.report({ phase: 'fetching', done: 500, total: 1000 });
    tracker.report({ phase: 'fetching', done: 400, total: 1000 }); // a lower value is not shown
    tracker.report({ phase: 'writing', done: 0, total: 1000 });
    tracker.report({ phase: 'saving' });
    assert.deepEqual(states, [
        { phase: 'counting', percent: null, message: 'Counting rows…' },
        { phase: 'fetching', percent: 0, message: 'Fetching rows: 0 of 1,000' },
        { phase: 'fetching', percent: 30, message: 'Fetching rows: 500 of 1,000' },
        { phase: 'writing', percent: 60, message: 'Writing rows: 0 of 1,000' },
        { phase: 'saving', percent: 95, message: 'Saving the file…' }
    ]);
});

test('without a count every fetched batch is told, as the bar cannot move', () => {
    const states: ExportProgressState[] = [];
    const tracker = new ExportTracker({ onChange: (s) => states.push(s) });
    tracker.report({ phase: 'fetching', done: 2000, total: null });
    tracker.report({ phase: 'fetching', done: 4000, total: null });
    assert.deepEqual(states.map((s) => s.message), ['Fetching rows: 2,000', 'Fetching rows: 4,000']);
});

test('a VS Code notification is fed the growth of the bar', () => {
    const reported: any[] = [];
    const feed = notificationProgress({ report: (v) => reported.push(v) });
    feed({ phase: 'counting', percent: null, message: 'Counting rows…' });
    feed({ phase: 'fetching', percent: 30, message: 'a' });
    feed({ phase: 'fetching', percent: 45, message: 'b' });
    feed({ phase: 'saving', percent: 95, message: 'c' });
    assert.deepEqual(reported, [
        { message: 'Counting rows…' },
        { message: 'a', increment: 30 },
        { message: 'b', increment: 15 },
        { message: 'c', increment: 50 }
    ]);
});

// ===== fetching in batches =====

/** A client that answers the count and serves `rows` through the cursor. */
function cursorClient(rows: unknown[][], options: { status?: string; countFails?: boolean; onQuery?: (sql: string) => unknown } = {}) {
    const fields = [{ name: 'id', dataTypeID: 23 }];
    let position = 0;
    const client = {
        processID: 99,
        queries: [] as string[],
        getTransactionStatus: () => options.status ?? 'I',
        async query(textOrConfig: string | { text: string; rowMode: string }): Promise<any> {
            const sql = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text;
            client.queries.push(sql);
            const custom = options.onQuery ? await options.onQuery(sql) : undefined;
            if (custom !== undefined) return custom;
            if (sql.startsWith('SELECT count(*)')) {
                if (options.countFails) throw new Error('cannot count');
                return { rows: [[String(rows.length)]], fields: [] };
            }
            const fetch = /^FETCH FORWARD (\d+)/.exec(sql);
            if (fetch) {
                const batch = rows.slice(position, position + Number(fetch[1]));
                position += batch.length;
                return { rows: batch, fields };
            }
            return { rows: [], fields: [] };
        }
    };
    return client;
}

const range = (n: number) => Array.from({ length: n }, (_, i) => [i + 1]);

test('the rows are counted, then fetched batch by batch in a transaction of their own', async () => {
    const client = cursorClient(range(1200));
    const states: ExportProgressState[] = [];
    const result = await fetchRowsInBatches(client as any, 'SELECT id FROM t ;\n', new ExportTracker({ onChange: (s) => states.push(s) }));
    assert.equal(result.rows.length, 1200);
    assert.deepEqual(result.rows[1199], [1200]);
    assert.deepEqual(result.fields.map((f) => f.name), ['id']);
    assert.deepEqual(client.queries, [
        'BEGIN',
        'SET LOCAL cursor_tuple_fraction = 1',
        'SAVEPOINT pqb_export_count',
        'SELECT count(*) FROM (\nSELECT id FROM t\n) AS _pqb_export_count',
        'RELEASE SAVEPOINT pqb_export_count',
        'DECLARE pqb_export NO SCROLL CURSOR FOR\nSELECT id FROM t\n',
        'FETCH FORWARD 500 FROM pqb_export',
        'FETCH FORWARD 500 FROM pqb_export',
        'FETCH FORWARD 500 FROM pqb_export',
        'CLOSE pqb_export',
        'COMMIT'
    ]);
    assert.deepEqual(states.map((s) => s.percent), [null, 0, 25, 50, 60]);
});

test('a trailing line comment cannot swallow the end of the wrapped query', async () => {
    const client = cursorClient(range(1));
    await fetchRowsInBatches(client as any, 'SELECT 1 -- the one', new ExportTracker());
    assert.ok(client.queries.includes('SELECT count(*) FROM (\nSELECT 1 -- the one\n) AS _pqb_export_count'));
    assert.ok(client.queries.includes('DECLARE pqb_export NO SCROLL CURSOR FOR\nSELECT 1 -- the one\n'));
});

test('inside a transaction the user opened, the export runs in a savepoint of it', async () => {
    const client = cursorClient(range(3), { status: 'T' });
    const result = await fetchRowsInBatches(client as any, 'SELECT id FROM t', new ExportTracker());
    assert.equal(result.rows.length, 3);
    assert.equal(client.queries[0], 'SAVEPOINT pqb_export');
    assert.ok(!client.queries.includes('BEGIN') && !client.queries.includes('COMMIT'), 'the user\'s transaction is not ended');
    assert.ok(!client.queries.some((q) => q.startsWith('SET LOCAL')), 'nothing is left set in the user\'s transaction');
    assert.equal(client.queries.at(-1), 'RELEASE SAVEPOINT pqb_export');
});

test('a query that cannot be counted is fetched all the same, without a percentage', async () => {
    const client = cursorClient(range(2500), { countFails: true });
    const states: ExportProgressState[] = [];
    const result = await fetchRowsInBatches(client as any, 'SELECT id FROM t', new ExportTracker({ onChange: (s) => states.push(s) }));
    assert.equal(result.rows.length, 2500);
    assert.deepEqual(client.queries.slice(3, 6), [
        'SELECT count(*) FROM (\nSELECT id FROM t\n) AS _pqb_export_count',
        'ROLLBACK TO SAVEPOINT pqb_export_count',
        'RELEASE SAVEPOINT pqb_export_count'
    ]);
    assert.ok(client.queries.includes('FETCH FORWARD 2000 FROM pqb_export'));
    assert.deepEqual(states.slice(1).map((s) => [s.percent, s.message]), [
        [null, 'Fetching rows: 0'],
        [null, 'Fetching rows: 2,000'],
        [null, 'Fetching rows: 2,500']
    ]);
});

test('a failing query rolls the export back and reports the error of the server', async () => {
    const client = cursorClient([], { onQuery: (sql) => { if (sql.startsWith('DECLARE')) throw new Error('relation "t" does not exist'); return undefined; } });
    await assert.rejects(fetchRowsInBatches(client as any, 'SELECT id FROM t', new ExportTracker()), /relation "t" does not exist/);
    assert.equal(client.queries.at(-1), 'ROLLBACK');

    const joined = cursorClient([], { status: 'T', onQuery: (sql) => { if (sql.startsWith('DECLARE')) throw new Error('boom'); return undefined; } });
    await assert.rejects(fetchRowsInBatches(joined as any, 'SELECT id FROM t', new ExportTracker()), /boom/);
    assert.deepEqual(joined.queries.slice(-2), ['ROLLBACK TO SAVEPOINT pqb_export', 'RELEASE SAVEPOINT pqb_export'], 'the user\'s transaction stays usable');
});

test('in a failed transaction the query runs as it is, so the server says why it refuses', async () => {
    const client = cursorClient([], { status: 'E', onQuery: () => { throw new Error('current transaction is aborted'); } });
    await assert.rejects(fetchRowsInBatches(client as any, 'SELECT id FROM t', new ExportTracker()), /current transaction is aborted/);
    assert.deepEqual(client.queries, ['SELECT id FROM t']);
});

test('Cancel between two batches stops the fetch and rolls it back', async () => {
    const tracker = new ExportTracker();
    const client = cursorClient(range(2000), {
        onQuery: (sql) => { if (sql.startsWith('FETCH') && client.queries.filter((q) => q.startsWith('FETCH')).length === 2) tracker.cancel(); return undefined; }
    });
    await assert.rejects(fetchRowsInBatches(client as any, 'SELECT id FROM t', tracker), ExportCancelledError);
    assert.equal(client.queries.filter((q) => q.startsWith('FETCH')).length, 2);
    assert.equal(client.queries.at(-1), 'ROLLBACK');
});

test('Cancel during a statement asks the server to cancel it, and waits for that before rolling back', async () => {
    const order: string[] = [];
    let finishCancel: () => void = () => undefined;
    let failFetch: (err: Error) => void = () => undefined;
    const tracker = new ExportTracker({
        cancelBackend: (pid) => {
            order.push(`cancel ${pid}`);
            return new Promise<void>((resolve) => { finishCancel = () => { order.push('cancel done'); resolve(); }; });
        }
    });
    const client = cursorClient(range(10), {
        onQuery: (sql) => {
            order.push(sql.split(' ')[0]);
            return sql.startsWith('FETCH') ? new Promise((_resolve, reject) => { failFetch = reject; }) : undefined;
        }
    });
    const fetching = fetchRowsInBatches(client as any, 'SELECT id FROM t', tracker);
    while (!order.includes('FETCH')) await new Promise((resolve) => setImmediate(resolve));
    tracker.cancel();
    failFetch(new Error('canceling statement due to user request'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(!order.includes('ROLLBACK'), 'the rollback waits for the cancel request');
    finishCancel();
    await assert.rejects(fetching, ExportCancelledError);
    assert.deepEqual(order.slice(-3), ['cancel 99', 'cancel done', 'ROLLBACK']);
});

test('a cancelled tracker refuses to start another statement', async () => {
    const tracker = new ExportTracker();
    tracker.cancel();
    assert.throws(() => tracker.throwIfCancelled(), ExportCancelledError);
    await assert.rejects(tracker.during({ processID: 1 }, async () => 'ran'), ExportCancelledError);
    const client = cursorClient(range(3));
    await assert.rejects(fetchRowsInBatches(client as any, 'SELECT 1', tracker), ExportCancelledError);
    assert.deepEqual(client.queries, [], 'not even BEGIN');
});
