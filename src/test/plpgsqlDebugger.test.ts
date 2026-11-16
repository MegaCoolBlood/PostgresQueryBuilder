import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSqlText } from '../repositoryScanner';
import { checkTargets } from '../plpgsqlCheck';
import { PlpgsqlDebugSession, callTemplate, sameSource, targetAtLine, type DebugClient, type DebugEnvironment } from '../plpgsqlDebugger';

// ===== pure helpers =====

test('the call template passes the required parameters as NULL, by name', () => {
    const [p] = scanSqlText("CREATE PROCEDURE app.p(p_a int, p_b text DEFAULT 'x', OUT p_c int) LANGUAGE plpgsql AS $$ BEGIN NULL; END $$;");
    assert.equal(callTemplate('procedure', 'app.p', p.params!), 'CALL app.p(p_a => NULL, p_c => NULL)');
    const [f] = scanSqlText('CREATE FUNCTION app.f(integer, OUT r int) RETURNS int LANGUAGE plpgsql AS $$ BEGIN r := 1; END $$;');
    assert.equal(callTemplate('function', 'app.f', f.params!), 'SELECT * FROM app.f(NULL)');
});

test('targetAtLine finds the routine whose body holds a file line, and the line of the body', () => {
    const text = 'CREATE FUNCTION app.f() RETURNS int LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN 1;\nEND\n$$;';
    const targets = checkTargets(text);
    assert.deepEqual(targetAtLine(targets, 2) && { name: targetAtLine(targets, 2)!.target.def.name, lineno: targetAtLine(targets, 2)!.lineno }, { name: 'f', lineno: 3 });
    assert.equal(targetAtLine(targets, 6), undefined);
});

test('two bodies are the same source when their lines match apart from white space, case and comments', () => {
    assert.equal(sameSource('\r\nBEGIN\r\n    RETURN 1; -- one\r\nEND;', '\nbegin\n  return 1;\nEND; /* x */'), true);
    assert.equal(sameSource('BEGIN\nRETURN 1;\nEND;', 'BEGIN RETURN 1;\nEND;'), false, 'a line more or less moves every line');
    assert.equal(sameSource('RETURN 1;', 'RETURN 2;'), false);
});

// ===== the session =====

const BODY = '\nDECLARE\n  v_sum integer := 0;\nBEGIN\n  v_sum := p_n * 2;\n  RETURN v_sum;\nEND;\n';
const REPO_FILE = `CREATE FUNCTION app.f(p_n integer) RETURNS integer LANGUAGE plpgsql AS $$${BODY}$$;`;

interface Fake {
    env: DebugEnvironment;
    target: { sent: string[]; ended: boolean };
    proxy: { sent: string[]; ended: boolean };
    /** The backends cancelled with pg_cancel_backend. */
    cancelled: number[];
    finish(): void;
}

/** Target and proxy sessions that behave as pldbgapi does: the target stops at line 2 and steps line by line. */
function fake(options: { repoBody?: string; callsFunction?: boolean; stepHangs?: boolean } = {}): Fake {
    let line = 2;
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const target = { sent: [] as string[], ended: false };
    const proxy = { sent: [] as string[], ended: false };
    const cancelled: number[] = [];
    let opened = 0;
    const never = new Promise<{ rows: Array<Record<string, unknown>> }>(() => undefined);
    const makeTarget = (): DebugClient => {
        let notice: (n: { message?: string }) => void = () => undefined;
        return {
            processID: 4711,
            on(event: string, listener: (x: never) => void) {
                if (event === 'notice') notice = listener as unknown as typeof notice;
                return this;
            },
            async end() { target.ended = true; },
            query: async (sql: string) => {
                target.sent.push(sql);
                if (sql === 'SHOW shared_preload_libraries') return { rows: [{ shared_preload_libraries: 'plugin_debugger' }] };
                if (/^(SELECT|CALL) .*app\.f/.test(sql)) {
                    if (options.callsFunction === false) return { rows: [{ r: 0 }] };
                    notice({ message: 'PLDBGBREAK:7' });
                    notice({ message: 'hello from the function' });
                    await finished;
                    return { rows: [{ f: 6 }] };
                }
                return { rows: [] };
            }
        } as DebugClient;
    };
    const makeProxy = (): DebugClient => ({
        processID: 4712,
        on() { return this; },
        async end() { proxy.ended = true; },
        query: async (sql: string) => {
            proxy.sent.push(sql);
            const rows = (r: Array<Record<string, unknown>>) => ({ rows: r });
            if (sql.includes('pldbg_attach_to_port')) return rows([{ session: 1 }]);
            if (sql.includes('pldbg_wait_for_breakpoint')) return rows([{ func: 100, linenumber: line + 1 }]);
            if (sql.includes('pldbg_get_stack')) return rows([{ level: 0, func: 100, linenumber: line, targetname: 'f(integer)', args: 'p_n=3' }]);
            if (sql.includes('pldbg_get_variables')) return rows([{ name: 'p_n', varclass: 'A', linenumber: 0, value: '3' }, { name: 'v_sum', varclass: 'L', linenumber: 3, value: String(line > 5 ? 6 : 0) }]);
            if (sql.includes('pldbg_set_breakpoint')) return rows([{ ok: true }]);
            if (sql.includes('pldbg_step_over')) {
                if (options.stepHangs) return never;
                line++;
                if (line > 6) {
                    finish();
                    return never;
                }
                return rows([{ func: 100, linenumber: line + 1 }]);
            }
            if (sql.includes('pldbg_continue')) {
                finish();
                return never;
            }
            return rows([]);
        }
    }) as DebugClient;
    const definitions = scanSqlText(REPO_FILE.replace(BODY, options.repoBody ?? BODY)).map(d => ({ ...d, uri: 'file:///repo/f.sql' }));
    const env: DebugEnvironment = {
        openClient: async () => (opened++ === 0 ? makeTarget() : makeProxy()),
        query: async (sql: string, params?: unknown[]) => {
            if (sql.includes('pg_cancel_backend')) {
                cancelled.push(Number(params![0]));
                finish();
                return [{ pg_cancel_backend: true }];
            }
            if (sql.includes('to_regprocedure')) return [{ oid: 100 }];
            if (sql.includes('WHERE p.oid = $1')) return [{ oid: 100, schema_name: 'app', name: 'f', args: 'p_n integer', arg_types: ['integer'], prosrc: BODY }];
            if (sql.includes('p.proname = $1')) return [{ oid: 100, schema_name: 'app', arg_types: ['integer'], prosrc: BODY }];
            return [];
        },
        snapshot: () => ({ version: 1, definitions }),
        readFile: async () => REPO_FILE.replace(BODY, options.repoBody ?? BODY),
        toPath: (uri) => uri.replace('file://', ''),
        toUri: (path) => `file://${path}`
    };
    return { env, target, proxy, cancelled, finish };
}

type Message = Record<string, unknown> & { type: string; event?: string; body?: Record<string, any>; success?: boolean; message?: string };

function drive(session: PlpgsqlDebugSession) {
    const messages: Message[] = [];
    const waiters: Array<{ match: (m: Message) => boolean; resolve: (m: Message) => void }> = [];
    session.onDidSendMessage(raw => {
        const m = raw as unknown as Message;
        messages.push(m);
        for (const w of [...waiters]) {
            if (w.match(m)) {
                waiters.splice(waiters.indexOf(w), 1);
                w.resolve(m);
            }
        }
    });
    let seq = 1;
    const wait = (match: (m: Message) => boolean): Promise<Message> => {
        const found = messages.find(match);
        return found ? Promise.resolve(found) : new Promise(resolve => waiters.push({ match, resolve }));
    };
    const request = (command: string, args: Record<string, unknown> = {}): Promise<Message> => {
        const n = seq++;
        const response = wait(m => m.type === 'response' && m.request_seq === n);
        session.handleMessage({ seq: n, type: 'request', command, arguments: args } as never);
        return response;
    };
    const event = (name: string): Promise<Message> => wait(m => m.type === 'event' && m.event === name);
    /** The n-th event of a name (1-based). */
    const nth = (name: string, n: number): Promise<Message> =>
        wait(m => m.type === 'event' && m.event === name && messages.filter(x => x.event === name).indexOf(m) === n - 1);
    return { messages, request, event, nth, wait };
}

test('a session stops on entry in the repository file, shows variables, steps, and ends with a rollback', async () => {
    const f = fake();
    const session = new PlpgsqlDebugSession(f.env);
    const d = drive(session);
    assert.equal((await d.request('initialize')).success, true);
    await d.event('initialized');
    const launch = d.request('launch', { statement: 'SELECT app.f(3)', functionOid: 100 });
    await d.request('configurationDone');
    assert.equal((await launch).success, true);
    await d.event('stopped');
    const stack = (await d.request('stackTrace', { threadId: 1 })).body!;
    assert.deepEqual(stack.stackFrames[0].source, { name: 'f.sql', path: '/repo/f.sql' });
    assert.equal(stack.stackFrames[0].line, 2, 'body line 2 is file line 2 (DECLARE)');
    const variables = (await d.request('variables', { variablesReference: 2 })).body!.variables;
    assert.deepEqual(variables.map((v: { name: string }) => v.name), ['v_sum']);
    assert.deepEqual((await d.request('variables', { variablesReference: 1 })).body!.variables.map((v: { value: string }) => v.value), ['3']);
    await d.request('next', { threadId: 1 });
    assert.equal((await d.nth('stopped', 2)).body!.reason, 'step');
    assert.equal((await d.request('stackTrace', { threadId: 1 })).body!.stackFrames[0].line, 3);
    const terminated = d.event('terminated');
    await d.request('continue', { threadId: 1 });
    await terminated;
    assert.ok(f.target.sent.includes('BEGIN'));
    assert.ok(f.target.sent.includes('ROLLBACK'));
    assert.ok(!f.target.sent.includes('COMMIT'));
    assert.equal(f.target.ended && f.proxy.ended, true);
    const output = d.messages.filter(m => m.event === 'output').map(m => String(m.body!.output).trim());
    assert.ok(output.includes('hello from the function'));
    assert.ok(output.includes('{"f":6}'));
});

test('a function whose repository body differs is shown from the database; a breakpoint in the file is refused', async () => {
    const f = fake({ repoBody: '\nBEGIN\n  RETURN 0;\nEND;\n' });
    const session = new PlpgsqlDebugSession(f.env);
    const d = drive(session);
    await d.request('initialize');
    const launch = d.request('launch', { statement: 'SELECT app.f(3)', function: 'app.f(integer)', stopOnEntry: true });
    await d.request('setBreakpoints', { source: { path: '/repo/f.sql' }, breakpoints: [{ line: 3 }] });
    await d.request('configurationDone');
    await launch;
    await d.event('stopped');
    const frame = (await d.request('stackTrace', { threadId: 1 })).body!.stackFrames[0];
    assert.equal(frame.source.origin, 'database');
    assert.equal(frame.line, 2);
    const source = (await d.request('source', { source: { sourceReference: frame.source.sourceReference } })).body!;
    assert.equal(source.content, BODY);
    const changed = d.messages.find(m => m.event === 'breakpoint')!;
    assert.deepEqual([changed.body!.breakpoint.verified, changed.body!.breakpoint.message], [false, 'The database has another version of this function']);
    await d.request('disconnect');
    assert.equal(f.target.ended, true);
});

test('without stopping on entry the session runs to the breakpoint, which is set in the function and line of the file', async () => {
    const f = fake();
    const session = new PlpgsqlDebugSession(f.env);
    const d = drive(session);
    await d.request('initialize');
    const launch = d.request('launch', { statement: 'SELECT app.f(3)', functionOid: 100, stopOnEntry: false, rollback: false });
    const bps = await d.request('setBreakpoints', { source: { path: '/repo/f.sql' }, breakpoints: [{ line: 5 }] });
    assert.equal(bps.body!.breakpoints[0].verified, false, 'not set before the session starts');
    await d.request('configurationDone');
    await launch;
    await d.event('terminated');
    assert.ok(f.proxy.sent.some(s => s.includes('pldbg_set_breakpoint')));
    const placed = d.messages.find(m => m.event === 'breakpoint')!;
    assert.equal(placed.body!.breakpoint.verified, true);
    assert.ok(f.target.sent.includes('COMMIT'), '"rollback": false commits');
});

test('a statement that never calls the function ends the session with a message; a launch without a statement fails', async () => {
    const f = fake({ callsFunction: false });
    const d = drive(new PlpgsqlDebugSession(f.env));
    await d.request('initialize');
    const launch = d.request('launch', { statement: 'SELECT app.f(3)', functionOid: 100 });
    await d.request('configurationDone');
    await launch;
    await d.event('terminated');
    assert.ok(d.messages.some(m => m.event === 'output' && /finished without calling/.test(String(m.body!.output))));
    const bad = drive(new PlpgsqlDebugSession(fake().env));
    const response = await bad.request('launch', { statement: ' ' });
    assert.equal(response.success, false);
    assert.match(String(response.message), /no "statement"/);
});

test('a step that takes long is reported, and Stop cancels the running statement on the server instead of leaving it running', async () => {
    const f = fake({ stepHangs: true });
    const d = drive(new PlpgsqlDebugSession(f.env, { slowStepMs: 10 }));
    await d.request('initialize');
    const launch = d.request('launch', { statement: 'SELECT app.f(3)', functionOid: 100 });
    await d.request('configurationDone');
    await launch;
    await d.event('stopped');
    await d.request('next', { threadId: 1 });
    const slow = await d.wait(m => m.event === 'output' && /has been running for/.test(String(m.body!.output)));
    assert.match(String(slow.body!.output), /Stop cancels it/);
    await d.request('disconnect');
    assert.deepEqual(f.cancelled, [4711, 4712], 'the target and the waiting proxy call are cancelled');
    assert.ok(!f.proxy.sent.some(s => s.includes('pldbg_abort_target')), 'a running target cannot be aborted through pldbgapi');
    assert.equal(f.target.ended && f.proxy.ended, true);
    assert.ok(!d.messages.some(m => m.event === 'output' && /lost the target/.test(String(m.body!.output))));
});
