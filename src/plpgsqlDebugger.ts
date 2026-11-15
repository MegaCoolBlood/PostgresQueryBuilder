/**
 * Debugging PL/pgSQL with the pldbgapi extension (pldebugger), in direct
 * mode: the statement to debug — a `CALL` or `SELECT` — runs in a session of
 * its own (the target), a second session (the proxy) attaches to it through
 * `pldbg_attach_to_port` and drives it.
 *
 * The statement runs in a transaction that is rolled back at the end unless
 * the launch configuration says `"rollback": false`. Breakpoints and the
 * current line are shown in the repository file whose body is the body in the
 * database, otherwise in a read-only document with the database's source.
 *
 * The adapter speaks the Debug Adapter Protocol directly (VS Code's inline
 * adapter), so it needs no library. Line numbers of pldbgapi: the stack and
 * `pldbg_set_breakpoint` count the lines of `prosrc` from 1, the first line
 * being the rest of the line after `AS $$` — the numbering plpgsql_check uses.
 */
import * as vscode from 'vscode';
import { checkTargets, type CheckTarget } from './plpgsqlCheck';
import { argumentTypesMatch, type LocatedDefinition, type RepositorySnapshot } from './repositoryComparison';
import { normalizeTypeName, type RepoParam } from './repositoryScanner';
import { callableParams } from './sqlCodeIntel';
import { Logger, getErrorMessage } from './logger';

export const DEBUG_TYPE = 'pgqb-plpgsql';
export const DEBUG_AVAILABLE_CONTEXT = 'postgresQueryBuilder.debugAvailable';
export const PLDBGAPI_QUERY = `SELECT extversion FROM pg_catalog.pg_extension WHERE extname = 'pldbgapi'`;

const availabilityChanged = new vscode.EventEmitter<boolean>();

/** Whether the active connection can debug PL/pgSQL; the CodeLens reads it. */
export const debugAvailability = { available: false, onDidChange: availabilityChanged.event };

export interface DebugLaunchArguments {
    /** The statement to run, e.g. `CALL pk.p(1)`. */
    statement: string;
    /** The oid of the function the debugger stops in first. */
    functionOid?: number;
    /** Or its signature, e.g. `leda.f_x(integer)`. */
    function?: string;
    /** Stop at the first statement of the function (default true). */
    stopOnEntry?: boolean;
    /** Roll the statement's transaction back at the end (default true). */
    rollback?: boolean;
}

// ===== Pure helpers =====

/** A statement that calls the routine with its required parameters as NULL, to be filled in. */
export function callTemplate(kind: 'function' | 'procedure', qualifiedName: string, params: readonly RepoParam[]): string {
    const passed = callableParams(kind, params).filter(p => p.defaultValue === null && p.mode !== 'variadic');
    const named = passed.every(p => p.name);
    const args = passed.map(p => (named ? `${p.name} => NULL` : 'NULL')).join(', ');
    return kind === 'procedure' ? `CALL ${qualifiedName}(${args})` : `SELECT * FROM ${qualifiedName}(${args})`;
}

/** The function and line of a repository file line, when the line is in the body of a PL/pgSQL routine. */
export function targetAtLine(targets: readonly CheckTarget[], line: number): { target: CheckTarget; lineno: number } | undefined {
    for (const target of targets) {
        const lines = target.body.split('\n').length;
        const lineno = line - target.bodyStart.line + 1;
        if (lineno >= 1 && lineno <= lines) return { target, lineno };
    }
    return undefined;
}

/**
 * Two bodies show the same code on the same lines — what the debugger needs
 * to show the database's lines in the repository file. Line ends, white
 * space, letter case and comments within a line do not count; a line more or
 * less does.
 */
export function sameSource(a: string, b: string): boolean {
    const lines = (s: string): string[] => s.replace(/\r\n?/g, '\n').split('\n')
        .map(l => l.replace(/\/\*.*?\*\//g, '').replace(/--.*$/, '').replace(/\s+/g, '').replace(/[A-Z]+/g, x => x.toLowerCase()));
    const x = lines(a);
    const y = lines(b);
    return x.length === y.length && x.every((l, i) => l === y[i]);
}

/** pldbgapi's variable classes as scopes. */
export const SCOPES: Array<{ name: string; classes: string[] }> = [
    { name: 'Arguments', classes: ['A'] },
    { name: 'Locals', classes: ['L', 'T'] }
];

// ===== Environment =====

export interface DebugClient {
    query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
    end(): Promise<void>;
    on(event: 'notice', listener: (notice: { message?: string }) => void): unknown;
    on(event: 'error', listener: (err: Error) => void): unknown;
    readonly processID?: number | null;
}

export interface DebugEnvironment {
    /** A new session with the settings of the active connection. */
    openClient(): Promise<DebugClient>;
    /** A catalog query on the active connection (not the debug sessions). */
    query(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
    snapshot(): RepositorySnapshot | null;
    /** The text of a repository file: the editor's when open. */
    readFile(uri: string): Promise<string>;
    /** The file system path of a file URI, for DAP sources. */
    toPath(uri: string): string;
    /** The file URI of a path from a DAP source. */
    toUri(path: string): string;
}

interface FunctionInfo {
    oid: number;
    schema: string;
    name: string;
    args: string;
    argTypes: string[];
    source: string;
}

/** Where the lines of a function are shown. */
type SourceMapping =
    | { kind: 'file'; uri: string; path: string; bodyLine: number }
    | { kind: 'db'; reference: number; name: string };

const FUNCTION_QUERY = `SELECT p.oid::bigint AS oid, n.nspname::text AS schema_name, p.proname::text AS name,
       pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
       ARRAY(SELECT pg_catalog.format_type(u.t, NULL) FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS u(t, i) ORDER BY u.i) AS arg_types,
       p.prosrc
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE p.oid = $1`;

const FUNCTIONS_BY_NAME_QUERY = `SELECT p.oid::bigint AS oid, n.nspname::text AS schema_name,
       ARRAY(SELECT pg_catalog.format_type(u.t, NULL) FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS u(t, i) ORDER BY u.i) AS arg_types,
       p.prosrc
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
JOIN pg_catalog.pg_language l ON l.oid = p.prolang
WHERE p.proname = $1 AND l.lanname = 'plpgsql' AND (n.nspname = $2::text OR ($2::text IS NULL AND n.nspname = ANY(pg_catalog.current_schemas(false))))`;

// ===== DAP =====

type DapMessage = { seq: number; type: string; command?: string; arguments?: Record<string, unknown>; [key: string]: unknown };

interface UserBreakpoint {
    id: number;
    line: number;
    verified: boolean;
    message?: string;
    /** The function and line it was set at in pldbgapi. */
    placed?: { oid: number; lineno: number };
    /** It could not be placed; not tried again until it is set anew. */
    failed?: boolean;
}

const THREAD_ID = 1;

/**
 * The inline debug adapter. One instance per debug session; it owns the two
 * database sessions and ends both when the session ends.
 */
export class PlpgsqlDebugSession implements vscode.DebugAdapter {
    private readonly _onDidSendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
    readonly onDidSendMessage = this._onDidSendMessage.event;
    private seq = 1;
    private target?: DebugClient;
    private proxy?: DebugClient;
    private session?: number;
    private targetDone?: Promise<void>;
    private finished = false;
    private launchArgs?: DebugLaunchArguments;
    private configured!: () => void;
    private readonly configurationDone = new Promise<void>(resolve => { this.configured = resolve; });
    /** Breakpoints by source key (`file:<uri>` or `db:<reference>`). */
    private readonly breakpoints = new Map<string, UserBreakpoint[]>();
    private nextBreakpointId = 1;
    private readonly functions = new Map<number, FunctionInfo>();
    private readonly mappings = new Map<number, SourceMapping>();
    private readonly references = new Map<number, number>();
    /** Proxy calls run one at a time. */
    private proxyChain: Promise<unknown> = Promise.resolve();
    private running = false;

    constructor(private readonly env: DebugEnvironment) {}

    // ----- Messages -----

    private send(message: Record<string, unknown>): void {
        this._onDidSendMessage.fire({ seq: this.seq++, ...message } as vscode.DebugProtocolMessage);
    }

    private respond(request: DapMessage, body: Record<string, unknown> = {}, error?: string): void {
        this.send({ type: 'response', request_seq: request.seq, command: request.command, success: !error, ...(error ? { message: error } : {}), body });
    }

    private event(event: string, body: Record<string, unknown> = {}): void {
        this.send({ type: 'event', event, body });
    }

    private output(text: string, category: 'console' | 'stdout' | 'stderr' = 'console'): void {
        this.event('output', { category, output: text.endsWith('\n') ? text : `${text}\n` });
    }

    handleMessage(message: vscode.DebugProtocolMessage): void {
        const request = message as unknown as DapMessage;
        if (request.type !== 'request') return;
        this.dispatch(request).catch((err: unknown) => {
            Logger.error(`PlpgsqlDebugSession.${request.command}`, err);
            this.respond(request, {}, getErrorMessage(err));
        });
    }

    private async dispatch(request: DapMessage): Promise<void> {
        const args = request.arguments ?? {};
        switch (request.command) {
            case 'initialize':
                this.respond(request, {
                    supportsConfigurationDoneRequest: true,
                    supportsSetVariable: true,
                    supportsTerminateRequest: true
                });
                this.event('initialized');
                return;
            case 'launch':
                await this.launch(request, args as unknown as DebugLaunchArguments);
                return;
            case 'setBreakpoints':
                this.respond(request, { breakpoints: await this.setBreakpoints(args) });
                return;
            case 'setExceptionBreakpoints':
                this.respond(request);
                return;
            case 'configurationDone':
                this.configured();
                this.respond(request);
                return;
            case 'threads':
                this.respond(request, { threads: [{ id: THREAD_ID, name: `PostgreSQL backend ${this.target?.processID ?? ''}`.trim() }] });
                return;
            case 'stackTrace':
                this.respond(request, await this.stackTrace());
                return;
            case 'scopes':
                this.respond(request, {
                    scopes: SCOPES.map((s, i) => ({ name: s.name, variablesReference: Number(args.frameId) * 10 + i + 1, expensive: false }))
                });
                return;
            case 'variables':
                this.respond(request, { variables: await this.variables(Number(args.variablesReference)) });
                return;
            case 'setVariable':
                this.respond(request, await this.setVariable(Number(args.variablesReference), String(args.name), String(args.value)));
                return;
            case 'source':
                this.respond(request, await this.source(Number((args.source as { sourceReference?: number } | undefined)?.sourceReference ?? args.sourceReference)));
                return;
            case 'continue':
                this.respond(request, { allThreadsContinued: true });
                void this.resume('pldbg_continue', 'breakpoint');
                return;
            case 'next':
                this.respond(request);
                void this.resume('pldbg_step_over', 'step');
                return;
            case 'stepIn':
                this.respond(request);
                void this.resume('pldbg_step_into', 'step');
                return;
            case 'stepOut':
                this.respond(request);
                void this.stepOut();
                return;
            case 'pause':
                this.respond(request, {}, 'pldbgapi cannot interrupt a running function; set a breakpoint instead.');
                return;
            case 'evaluate':
                this.respond(request, {}, 'Expressions cannot be evaluated; the Variables view shows the values.');
                return;
            case 'disconnect':
            case 'terminate':
                await this.shutdown();
                this.respond(request);
                return;
            default:
                this.respond(request, {}, `${request.command} is not supported`);
        }
    }

    // ----- Launch -----

    private async launch(request: DapMessage, args: DebugLaunchArguments): Promise<void> {
        this.launchArgs = args;
        if (!args.statement || !args.statement.trim()) {
            this.respond(request, {}, 'The launch configuration names no "statement" to run.');
            return;
        }
        const oid = args.functionOid ?? await this.oidOf(args.function);
        if (!oid) {
            this.respond(request, {}, 'The launch configuration names no function to debug ("function" or "functionOid").');
            return;
        }
        await this.configurationDone;
        try {
            await this.start(oid, args);
        } catch (err: unknown) {
            await this.shutdown();
            this.respond(request, {}, `Debugging could not start: ${getErrorMessage(err)}`);
            return;
        }
        this.respond(request);
        if (this.finished) return;
        await this.applyBreakpoints();
        if (args.stopOnEntry === false) {
            void this.resume('pldbg_continue', 'breakpoint');
        } else {
            this.event('stopped', { reason: 'entry', threadId: THREAD_ID, allThreadsStopped: true });
        }
    }

    private async oidOf(signature: string | undefined): Promise<number | undefined> {
        if (!signature) return undefined;
        const rows = await this.env.query('SELECT to_regprocedure($1)::oid::bigint AS oid', [signature]);
        const oid = rows[0]?.oid;
        return oid === null || oid === undefined ? undefined : Number(oid);
    }

    private async start(oid: number, args: DebugLaunchArguments): Promise<void> {
        this.target = await this.env.openClient();
        this.target.on('error', (err: Error) => Logger.error('PlpgsqlDebugSession.target', err));
        const port = new Promise<number>((resolve) => {
            this.target!.on('notice', (notice) => {
                const message = notice.message ?? '';
                const m = /^PLDBGBREAK:(\d+)/.exec(message);
                if (m) resolve(Number(m[1]));
                else this.output(message, 'stdout');
            });
        });
        const preloaded = String((await this.target.query('SHOW shared_preload_libraries')).rows[0]?.shared_preload_libraries ?? '');
        if (!/plugin_debugger/.test(preloaded)) {
            try {
                await this.target.query(`LOAD 'plugin_debugger'`);
            } catch (err: unknown) {
                throw new Error(`the server does not load plugin_debugger (shared_preload_libraries), and loading it failed: ${getErrorMessage(err)}`);
            }
        }
        await this.target.query('SELECT pldbg_oid_debug($1)', [oid]);
        await this.target.query('BEGIN');
        this.output(`Running: ${args.statement.trim()}`);
        this.targetDone = this.target.query(args.statement).then(
            async (result) => {
                for (const row of result.rows.slice(0, 20)) this.output(JSON.stringify(row), 'stdout');
                if (result.rows.length > 20) this.output(`… ${result.rows.length - 20} more rows`, 'stdout');
                await this.target?.query(args.rollback === false ? 'COMMIT' : 'ROLLBACK').catch(() => undefined);
                this.output(args.rollback === false ? 'Committed.' : 'Rolled back: the statement changed nothing.');
            },
            async (err: unknown) => {
                this.output(`The statement failed: ${getErrorMessage(err)}`, 'stderr');
                await this.target?.query('ROLLBACK').catch(() => undefined);
            }
        ).finally(() => { this.finished = true; });
        const attached = await Promise.race([port, this.targetDone.then(() => null)]);
        if (attached === null) {
            this.output('The statement finished without calling the function that was to be debugged.');
            await this.end();
            return;
        }
        this.proxy = await this.env.openClient();
        this.proxy.on('error', (err: Error) => Logger.error('PlpgsqlDebugSession.proxy', err));
        this.session = Number((await this.proxy.query('SELECT pldbg_attach_to_port($1) AS session', [attached])).rows[0].session);
        await this.proxyCall('SELECT * FROM pldbg_wait_for_breakpoint($1)');
    }

    /** One pldbgapi call of the proxy; null when the target finished first. */
    private proxyCall(sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>> | null> {
        const run = async (): Promise<Array<Record<string, unknown>> | null> => {
            if (!this.proxy || this.session === undefined || this.finished) return null;
            const call = this.proxy.query(sql, [this.session, ...params]).then(r => r.rows);
            const done = this.targetDone ? this.targetDone.then(() => null) : new Promise<null>(() => undefined);
            const result = await Promise.race([call, done]);
            call.catch(() => undefined);
            return result;
        };
        const next = this.proxyChain.then(run, run);
        this.proxyChain = next.catch(() => undefined);
        return next;
    }

    private async resume(fn: 'pldbg_continue' | 'pldbg_step_over' | 'pldbg_step_into', reason: string): Promise<void> {
        this.running = true;
        try {
            const rows = await this.proxyCall(`SELECT * FROM ${fn}($1)`);
            this.running = false;
            if (rows === null || this.finished) {
                await this.end();
                return;
            }
            await this.applyBreakpoints();
            this.event('stopped', { reason, threadId: THREAD_ID, allThreadsStopped: true });
        } catch (err: unknown) {
            this.running = false;
            this.output(`The debugger lost the target: ${getErrorMessage(err)}`, 'stderr');
            await this.end();
        }
    }

    /** pldbgapi has no step out: step over until the current frame is gone. */
    private async stepOut(): Promise<void> {
        this.running = true;
        try {
            const depth = (await this.proxyCall('SELECT level FROM pldbg_get_stack($1)'))?.length ?? 0;
            for (let i = 0; i < 100000; i++) {
                const rows = await this.proxyCall('SELECT * FROM pldbg_step_over($1)');
                if (rows === null || this.finished) {
                    this.running = false;
                    await this.end();
                    return;
                }
                const now = (await this.proxyCall('SELECT level FROM pldbg_get_stack($1)'))?.length ?? 0;
                if (now < depth) break;
            }
            this.running = false;
            this.event('stopped', { reason: 'step', threadId: THREAD_ID, allThreadsStopped: true });
        } catch (err: unknown) {
            this.running = false;
            this.output(`The debugger lost the target: ${getErrorMessage(err)}`, 'stderr');
            await this.end();
        }
    }

    private ended = false;

    /** The statement finished or failed: tell VS Code and close both sessions. */
    private async end(): Promise<void> {
        if (this.ended) return;
        this.ended = true;
        await this.targetDone?.catch(() => undefined);
        await this.closeClients();
        this.event('terminated');
    }

    private async closeClients(): Promise<void> {
        const proxy = this.proxy;
        const target = this.target;
        this.proxy = undefined;
        this.target = undefined;
        await proxy?.end().catch(() => undefined);
        // Ending the target rolls back what it did not commit.
        await target?.end().catch(() => undefined);
    }

    private async shutdown(): Promise<void> {
        if (this.proxy && this.session !== undefined && !this.finished && !this.running) {
            await this.proxy.query('SELECT pldbg_abort_target($1)', [this.session]).catch(() => undefined);
        }
        this.ended = true;
        await this.closeClients();
    }

    // ----- Stack, variables, sources -----

    private async functionInfo(oid: number): Promise<FunctionInfo> {
        const known = this.functions.get(oid);
        if (known) return known;
        const row = (await this.env.query(FUNCTION_QUERY, [oid]))[0];
        if (!row) throw new Error(`function ${oid} not found`);
        const info: FunctionInfo = {
            oid,
            schema: String(row.schema_name),
            name: String(row.name),
            args: String(row.args ?? ''),
            argTypes: Array.isArray(row.arg_types) ? row.arg_types.map(String) : [],
            source: String(row.prosrc ?? '')
        };
        this.functions.set(oid, info);
        return info;
    }

    /** The repository definitions of a function whose body is the database's body. */
    private async repositorySource(info: FunctionInfo): Promise<SourceMapping | undefined> {
        const snapshot = this.env.snapshot();
        if (!snapshot) return undefined;
        const dbArgs = info.argTypes.map(normalizeTypeName);
        const candidates = snapshot.definitions.filter((d: LocatedDefinition) =>
            (d.kind === 'function' || d.kind === 'procedure') && d.name === info.name
            && (d.schema === null || d.schema === info.schema)
            && (!d.argTypes || argumentTypesMatch(d.argTypes, dbArgs)));
        for (const def of candidates) {
            try {
                const text = await this.env.readFile(def.uri);
                const target = checkTargets(text).find(t => t.def.start.line === def.start.line && t.def.start.character === def.start.character);
                if (target && sameSource(target.body, info.source)) {
                    return { kind: 'file', uri: def.uri, path: this.env.toPath(def.uri), bodyLine: target.bodyStart.line };
                }
            } catch (err: unknown) {
                Logger.error('PlpgsqlDebugSession.repositorySource', err);
            }
        }
        return undefined;
    }

    private async mappingOf(oid: number): Promise<SourceMapping> {
        const known = this.mappings.get(oid);
        if (known) return known;
        const info = await this.functionInfo(oid);
        let mapping = await this.repositorySource(info);
        if (!mapping) {
            const reference = this.references.size + 1;
            this.references.set(reference, oid);
            mapping = { kind: 'db', reference, name: `${info.schema}.${info.name}(${info.args}).sql` };
        }
        this.mappings.set(oid, mapping);
        return mapping;
    }

    private sourceOf(mapping: SourceMapping): Record<string, unknown> {
        return mapping.kind === 'file'
            ? { name: mapping.path.split(/[\\/]/).pop(), path: mapping.path }
            : { name: mapping.name, sourceReference: mapping.reference, presentationHint: 'deemphasize', origin: 'database' };
    }

    /** The DAP line (1-based) of line `lineno` of a function. */
    private lineOf(mapping: SourceMapping, lineno: number): number {
        return mapping.kind === 'file' ? mapping.bodyLine + lineno : lineno;
    }

    private async stackTrace(): Promise<Record<string, unknown>> {
        const rows = await this.proxyCall('SELECT * FROM pldbg_get_stack($1)');
        if (!rows) return { stackFrames: [], totalFrames: 0 };
        const frames = [];
        for (const row of rows) {
            const oid = Number(row.func);
            const lineno = Number(row.linenumber);
            const mapping = await this.mappingOf(oid);
            frames.push({
                id: Number(row.level),
                name: `${String(row.targetname)}${row.args ? ` — ${String(row.args)}` : ''}`,
                source: this.sourceOf(mapping),
                line: this.lineOf(mapping, lineno),
                column: 1
            });
        }
        return { stackFrames: frames, totalFrames: frames.length };
    }

    private async frameVariables(frame: number): Promise<Array<Record<string, unknown>>> {
        if (frame > 0) await this.proxyCall('SELECT * FROM pldbg_select_frame($1, $2)', [frame]);
        const rows = (await this.proxyCall('SELECT * FROM pldbg_get_variables($1)')) ?? [];
        if (frame > 0) await this.proxyCall('SELECT * FROM pldbg_select_frame($1, 0)');
        return rows;
    }

    private async variables(reference: number): Promise<Array<Record<string, unknown>>> {
        const frame = Math.floor((reference - 1) / 10);
        const scope = SCOPES[(reference - 1) % 10];
        if (!scope) return [];
        const rows = await this.frameVariables(frame);
        return rows
            .filter(r => scope.classes.includes(String(r.varclass)))
            .map(r => ({ name: String(r.name), value: r.value === null ? 'NULL' : String(r.value), variablesReference: 0 }));
    }

    private async setVariable(reference: number, name: string, value: string): Promise<Record<string, unknown>> {
        const frame = Math.floor((reference - 1) / 10);
        const rows = await this.frameVariables(frame);
        const variable = rows.find(r => String(r.name) === name);
        if (!variable) throw new Error(`${name} is not a variable of this frame`);
        if (frame > 0) await this.proxyCall('SELECT * FROM pldbg_select_frame($1, $2)', [frame]);
        const ok = (await this.proxyCall('SELECT pldbg_deposit_value($1, $2, $3, $4) AS ok', [name, Number(variable.linenumber), value]))?.[0]?.ok;
        if (frame > 0) await this.proxyCall('SELECT * FROM pldbg_select_frame($1, 0)');
        if (ok !== true && ok !== 't') throw new Error(`${value} cannot be assigned to ${name}`);
        const updated = (await this.frameVariables(frame)).find(r => String(r.name) === name);
        return { value: updated?.value === null || updated === undefined ? 'NULL' : String(updated.value) };
    }

    private async source(reference: number): Promise<Record<string, unknown>> {
        const oid = this.references.get(reference);
        if (oid === undefined) throw new Error('Unknown source');
        const info = await this.functionInfo(oid);
        // Line 1 of the document is line 1 of the body.
        return { content: info.source.replace(/\r\n?/g, '\n'), mimeType: 'text/x-sql' };
    }

    // ----- Breakpoints -----

    private async setBreakpoints(args: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
        const source = (args.source ?? {}) as { path?: string; sourceReference?: number };
        const key = source.sourceReference ? `db:${source.sourceReference}` : `file:${source.path ?? ''}`;
        const lines = ((args.breakpoints as Array<{ line: number }> | undefined) ?? []).map(b => b.line);
        const old = this.breakpoints.get(key) ?? [];
        const list: UserBreakpoint[] = lines.map(line => old.find(b => b.line === line) ?? { id: this.nextBreakpointId++, line, verified: false, message: 'Set when the debugger stops' });
        // Removed breakpoints go at the next stop.
        for (const b of old) {
            if (!list.includes(b) && b.placed) this.toDrop.push(b.placed);
        }
        this.breakpoints.set(key, list);
        if (this.session !== undefined && !this.running && !this.finished) await this.applyBreakpoints();
        return list.map(b => this.breakpointBody(b, source));
    }

    private readonly toDrop: Array<{ oid: number; lineno: number }> = [];

    private breakpointBody(b: UserBreakpoint, source: Record<string, unknown>): Record<string, unknown> {
        return { id: b.id, verified: b.verified, line: b.line, source, ...(b.message ? { message: b.message } : {}) };
    }

    /** Where a breakpoint of a source goes in pldbgapi; a message when it cannot go anywhere. */
    private async placement(key: string, line: number): Promise<{ oid: number; lineno: number } | string> {
        if (key.startsWith('db:')) {
            const oid = this.references.get(Number(key.slice(3)));
            return oid === undefined ? 'Unknown source' : { oid, lineno: line };
        }
        const uri = this.env.toUri(key.slice(5));
        const text = await this.env.readFile(uri);
        const at = targetAtLine(checkTargets(text), line - 1);
        if (!at) return 'Not inside the body of a PL/pgSQL function or procedure';
        const def = at.target.def;
        const rows = await this.env.query(FUNCTIONS_BY_NAME_QUERY, [def.name, def.schema]);
        const match = rows.find(r => !def.argTypes || argumentTypesMatch(def.argTypes, (Array.isArray(r.arg_types) ? r.arg_types : []).map(t => normalizeTypeName(String(t)))));
        if (!match) return 'The database has no such function';
        if (!sameSource(String(match.prosrc ?? ''), at.target.body)) return 'The database has another version of this function';
        const oid = Number(match.oid);
        if (!this.mappings.has(oid)) this.mappings.set(oid, { kind: 'file', uri, path: key.slice(5), bodyLine: at.target.bodyStart.line });
        return { oid, lineno: at.lineno };
    }

    /** Set and drop breakpoints in pldbgapi while the target is stopped, and report which hold. */
    private async applyBreakpoints(): Promise<void> {
        if (this.session === undefined || this.finished) return;
        for (const drop of this.toDrop.splice(0)) {
            await this.proxyCall('SELECT pldbg_drop_breakpoint($1, $2, $3)', [drop.oid, drop.lineno]).catch(() => undefined);
        }
        for (const [key, list] of this.breakpoints) {
            for (const b of list) {
                if (b.placed || b.failed) continue;
                const where = await this.placement(key, b.line).catch((err: unknown) => getErrorMessage(err));
                if (typeof where === 'string') {
                    b.verified = false;
                    b.message = where;
                    b.failed = true;
                } else {
                    const ok = (await this.proxyCall('SELECT pldbg_set_breakpoint($1, $2, $3) AS ok', [where.oid, where.lineno]))?.[0]?.ok;
                    b.verified = ok === true || ok === 't';
                    b.message = b.verified ? undefined : 'pldbgapi did not accept a breakpoint on this line';
                    b.failed = !b.verified;
                    if (b.verified) b.placed = where;
                }
                const source = key.startsWith('db:') ? { sourceReference: Number(key.slice(3)) } : { path: key.slice(5) };
                this.event('breakpoint', { reason: 'changed', breakpoint: this.breakpointBody(b, source) });
            }
        }
    }

    dispose(): void {
        void this.shutdown();
        this._onDidSendMessage.dispose();
    }
}

// ===== Commands and registration =====

export interface DebugDeps {
    env: DebugEnvironment;
    isConnected(): boolean;
    /** A routine of the database for a node or the name under the cursor. */
    pickRoutine(arg: unknown): Promise<{ oid: number; kind: 'function' | 'procedure'; qualifiedName: string; params: RepoParam[]; language: string | null } | undefined>;
    /** The PL/pgSQL routine a statement calls first. */
    entryOfStatement(statement: string): Promise<{ oid: number; qualifiedName: string } | undefined>;
    state: vscode.Memento;
    onDidChangeConnection: vscode.Event<void>;
}

const TEMPLATE_KEY = 'postgresQueryBuilder.debug.statements';

/** The statement at the cursor, or the selection. */
function statementAtCursor(editor: vscode.TextEditor): string {
    if (!editor.selection.isEmpty) return editor.document.getText(editor.selection).trim();
    const text = editor.document.getText();
    const offset = editor.document.offsetAt(editor.selection.active);
    const start = text.lastIndexOf(';', offset - 1) + 1;
    const end = text.indexOf(';', offset);
    return text.slice(start, end < 0 ? text.length : end).trim();
}

export function registerDebugger(context: vscode.ExtensionContext, deps: DebugDeps, languages: readonly string[]): void {
    let available = false;
    const refreshAvailability = async (): Promise<void> => {
        available = false;
        if (deps.isConnected()) {
            try {
                available = (await deps.env.query(PLDBGAPI_QUERY)).length > 0;
            } catch (err: unknown) {
                Logger.error('Debugger.availability', err);
            }
        }
        if (debugAvailability.available !== available) {
            debugAvailability.available = available;
            availabilityChanged.fire(available);
        }
        await vscode.commands.executeCommand('setContext', DEBUG_AVAILABLE_CONTEXT, available);
    };

    const ensureAvailable = async (): Promise<boolean> => {
        if (!deps.isConnected()) {
            vscode.window.showInformationMessage('Connect to a database to debug PL/pgSQL.');
            return false;
        }
        await refreshAvailability();
        if (!available) vscode.window.showInformationMessage('The database has no pldbgapi extension, which debugging needs (CREATE EXTENSION pldbgapi; the server must load plugin_debugger).');
        return available;
    };

    const launch = (statement: string, functionOid: number, name: string): Thenable<boolean> =>
        vscode.debug.startDebugging(undefined, { type: DEBUG_TYPE, request: 'launch', name: `Debug ${name}`, statement, functionOid, stopOnEntry: true, rollback: true });

    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
            createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation(new PlpgsqlDebugSession(deps.env))
        }),
        vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, {
            async resolveDebugConfiguration(_folder, config) {
                const editor = vscode.window.activeTextEditor;
                if (!config.type && editor && languages.includes(editor.document.languageId)) {
                    Object.assign(config, { type: DEBUG_TYPE, request: 'launch', name: 'Debug Statement', statement: statementAtCursor(editor), stopOnEntry: true, rollback: true });
                }
                if (config.type !== DEBUG_TYPE) return config;
                if (!(await ensureAvailable())) return undefined;
                if (!config.functionOid && !config.function && typeof config.statement === 'string') {
                    const entry = await deps.entryOfStatement(config.statement);
                    if (!entry) {
                        vscode.window.showErrorMessage('The statement calls no PL/pgSQL function or procedure of the database.');
                        return undefined;
                    }
                    config.functionOid = entry.oid;
                }
                return config;
            }
        }),
        vscode.commands.registerCommand('postgresQueryBuilder.debugFunction', async (arg?: unknown) => {
            if (!(await ensureAvailable())) return;
            const routine = await deps.pickRoutine(arg);
            if (!routine) return;
            if (routine.language && routine.language !== 'plpgsql') {
                vscode.window.showInformationMessage(`${routine.qualifiedName} is written in ${routine.language}; only PL/pgSQL can be debugged.`);
                return;
            }
            const saved = deps.state.get<Record<string, string>>(TEMPLATE_KEY, {});
            const statement = await vscode.window.showInputBox({
                title: `Debug ${routine.qualifiedName}`,
                prompt: 'The statement to run; it runs in a transaction that is rolled back at the end',
                value: saved[String(routine.oid)] ?? callTemplate(routine.kind, routine.qualifiedName, routine.params),
                ignoreFocusOut: true
            });
            if (!statement) return;
            await deps.state.update(TEMPLATE_KEY, { ...saved, [String(routine.oid)]: statement });
            await launch(statement, routine.oid, routine.qualifiedName);
        }),
        vscode.commands.registerCommand('postgresQueryBuilder.debugStatement', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !languages.includes(editor.document.languageId)) return;
            if (!(await ensureAvailable())) return;
            const statement = statementAtCursor(editor);
            const entry = await deps.entryOfStatement(statement);
            if (!entry) {
                vscode.window.showErrorMessage('The statement calls no PL/pgSQL function or procedure of the database.');
                return;
            }
            await launch(statement, entry.oid, entry.qualifiedName);
        }),
        deps.onDidChangeConnection(() => { void refreshAvailability(); })
    );
    void refreshAvailability();
}
