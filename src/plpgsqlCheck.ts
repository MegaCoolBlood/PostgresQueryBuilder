/**
 * plpgsql_check for the open SQL file, against a database marked for it in
 * the connection form — which need not be the active connection.
 *
 * The file's `CREATE FUNCTION` and `CREATE PROCEDURE … LANGUAGE plpgsql`
 * statements are created in one transaction on that database, each checked
 * with `plpgsql_check_function_tb`, and the transaction is rolled back: the
 * unsaved code is checked, and nothing of it stays in the database. The
 * versions the database has of the file's routines are renamed out of the way
 * first; a routine that still exists is created with OR REPLACE, or under a
 * temporary name when that cannot replace it. At most
 * one check runs at a time; a file changed while it is checked is checked
 * once more afterwards, and a result for an older version is dropped.
 */
import * as vscode from 'vscode';
import {
    dollarContent,
    isWord,
    positionMapper,
    scanSqlText,
    tokenize,
    type RepoDefinition,
    type SourcePosition
} from './repositoryScanner';
import { parseCreateTrigger, scanStructure } from './ddlCompare';
import type { ConnectionConfig } from './connectionManager';
import { Logger, getErrorMessage } from './logger';

// ===== What is checked =====

export interface CheckTarget {
    def: RepoDefinition;
    /** The statement as sent to the server. */
    statement: string;
    /** Offset of the statement in the file. */
    statementOffset: number;
    /** The body exactly as `pg_proc.prosrc` will hold it. */
    body: string;
    /** Where line 1 of the body starts in the file. */
    bodyStart: SourcePosition;
    /** The search_path a `SET search_path` earlier in the file sets. */
    searchPath: string[] | null;
    /** A trigger function (`RETURNS trigger`), which needs a table to be checked. */
    trigger: boolean;
    /** The table a `CREATE TRIGGER` of the same file uses it for. */
    triggerTable?: { schema: string | null; name: string };
}

/** The offset of a position in `text`. */
export function offsetAt(text: string, position: SourcePosition): number {
    let offset = 0;
    for (let line = 0; line < position.line; line++) {
        const nl = text.indexOf('\n', offset);
        if (nl < 0) return text.length;
        offset = nl + 1;
    }
    return offset + position.character;
}

/** The PL/pgSQL functions and procedures of a file, with what the check needs to map its findings back. */
export function checkTargets(text: string): CheckTarget[] {
    const toPosition = positionMapper(text);
    const triggers = scanStructure(text)
        .filter(s => s.type === 'createTrigger')
        .map(s => parseCreateTrigger(tokenize(s.text)))
        .filter((t): t is NonNullable<typeof t> => t !== null);
    const out: CheckTarget[] = [];
    for (const def of scanSqlText(text)) {
        if ((def.kind !== 'function' && def.kind !== 'procedure') || !def.statementStart || !def.statementEnd) continue;
        const start = offsetAt(text, def.statementStart);
        const end = offsetAt(text, def.statementEnd);
        const statement = text.slice(start, end);
        const toks = tokenize(statement);
        const language = toks.findIndex((t, i) => isWord(t, 'language') && (isWord(toks[i + 1], 'plpgsql') || (toks[i + 1]?.type === 'string' && toks[i + 1].value.toLowerCase() === 'plpgsql')));
        if (language < 0) continue;
        const as = toks.findIndex((t, i) => isWord(t, 'as') && (toks[i + 1]?.type === 'dollar' || toks[i + 1]?.type === 'string'));
        if (as < 0) continue;
        const bodyTok = toks[as + 1];
        let body: string;
        let bodyOffset: number;
        if (bodyTok.type === 'dollar') {
            const inner = dollarContent(bodyTok.text);
            if (inner === null) continue;
            body = inner;
            bodyOffset = bodyTok.start + bodyTok.text.indexOf('$', 1) + 1;
        } else {
            body = bodyTok.value;
            bodyOffset = bodyTok.start + (/^[eE]/.test(bodyTok.text) ? 2 : 1);
        }
        const trigger = def.kind === 'function' && /^trigger$/i.test((def.returns ?? '').trim());
        const target: CheckTarget = {
            def, statement, statementOffset: start, body, bodyStart: toPosition(start + bodyOffset),
            searchPath: def.searchPath, trigger
        };
        if (trigger) {
            const used = triggers.find(t => t.func === def.name);
            if (used) target.triggerTable = used.table;
        }
        out.push(target);
    }
    return out;
}

/** The file line of line `lineno` (1-based) of a body. */
export function bodyLine(target: Pick<CheckTarget, 'bodyStart'>, lineno: number): number {
    return target.bodyStart.line + lineno - 1;
}

// ===== Options =====

export interface CheckSettings {
    fatalErrors: boolean;
    otherWarnings: boolean;
    extraWarnings: boolean;
    performanceWarnings: boolean;
    securityWarnings: boolean;
    compatibilityWarnings: boolean;
    constantTracing: boolean;
    useIncommentOptions: boolean;
    withoutWarnings: boolean;
}

export const DEFAULT_CHECK_SETTINGS: CheckSettings = {
    fatalErrors: false,
    otherWarnings: true,
    extraWarnings: true,
    performanceWarnings: false,
    securityWarnings: false,
    compatibilityWarnings: false,
    constantTracing: true,
    useIncommentOptions: true,
    withoutWarnings: false
};

const PARAMETER_NAMES: Record<keyof CheckSettings, string> = {
    fatalErrors: 'fatal_errors',
    otherWarnings: 'other_warnings',
    extraWarnings: 'extra_warnings',
    performanceWarnings: 'performance_warnings',
    securityWarnings: 'security_warnings',
    compatibilityWarnings: 'compatibility_warnings',
    constantTracing: 'constant_tracing',
    useIncommentOptions: 'use_incomment_options',
    withoutWarnings: 'without_warnings'
};

/** Reads the parameter names of the installed `plpgsql_check_function_tb(regprocedure, …)`. */
export const CHECK_PARAMETERS_QUERY = `SELECT n.nspname::text AS schema_name, unnest(p.proargnames)::text AS name FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname = 'plpgsql_check_function_tb' AND p.proargtypes[0] = 'pg_catalog.regprocedure'::pg_catalog.regtype`;

/**
 * The call of `plpgsql_check_function_tb` with every option as a named
 * parameter; options the installed version does not know are left out.
 */
export function buildCheckCall(settings: CheckSettings, known: ReadonlySet<string>, withTable: boolean, schema = 'public'): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const args: string[] = [];
    params.push(null);
    args.push('$1::pg_catalog.oid::pg_catalog.regprocedure');
    if (withTable) {
        params.push(null);
        args.push(`relid => $${params.length}::pg_catalog.regclass`);
    }
    for (const [key, name] of Object.entries(PARAMETER_NAMES) as Array<[keyof CheckSettings, string]>) {
        if (known.size > 0 && !known.has(name)) continue;
        params.push(settings[key]);
        args.push(`${name} => $${params.length}::boolean`);
    }
    // Qualified: a SET search_path of the file may hide the extension's schema.
    return { sql: `SELECT * FROM "${schema.replace(/"/g, '""')}".plpgsql_check_function_tb(${args.join(', ')})`, params };
}

// ===== Findings =====

export type CheckSeverity = 'error' | 'warning' | 'information';

export interface CheckFinding {
    severity: CheckSeverity;
    message: string;
    start: SourcePosition;
    end: SourcePosition;
    /** SQLSTATE, when the server sent one. */
    code?: string;
}

/** The severity of a plpgsql_check level; extra, performance and security warnings use `extraSeverity`. */
export function severityOf(level: string, extraSeverity: CheckSeverity): CheckSeverity {
    const l = level.toLowerCase();
    if (l === 'error') return 'error';
    if (l === 'warning') return 'warning';
    return extraSeverity;
}

/** The range of a whole line without its indentation. */
function lineRange(text: string, line: number): { start: SourcePosition; end: SourcePosition } {
    const lines = text.split('\n');
    const content = (lines[line] ?? '').replace(/\r$/, '');
    const indent = content.length - content.trimStart().length;
    return { start: { line, character: indent }, end: { line, character: Math.max(indent, content.length) } };
}

/** One row of `plpgsql_check_function_tb` as a finding in the file. */
export function findingOf(row: Record<string, unknown>, target: CheckTarget, text: string, extraSeverity: CheckSeverity): CheckFinding {
    const parts = [String(row.message ?? '')];
    if (row.detail) parts.push(`Detail: ${String(row.detail)}`);
    if (row.hint) parts.push(`Hint: ${String(row.hint)}`);
    const severity = severityOf(String(row.level ?? 'error'), extraSeverity);
    const code = row.sqlstate ? String(row.sqlstate) : undefined;
    const lineno = row.lineno === null || row.lineno === undefined ? null : Number(row.lineno);
    let range = { start: target.def.start, end: target.def.end };
    if (lineno !== null && lineno > 0) {
        const line = bodyLine(target, lineno);
        range = lineRange(text, line);
        // The query and its position, when the line holds the query as written.
        const query = row.query ? String(row.query) : null;
        const position = row.position === null || row.position === undefined ? null : Number(row.position);
        if (query && position && position > 0) {
            const lineStart = offsetAt(text, { line, character: 0 });
            const at = text.indexOf(query, lineStart);
            if (at >= 0 && at <= offsetAt(text, { line: line + 1, character: 0 })) {
                const toPosition = positionMapper(text);
                const from = at + position - 1;
                const word = /^[A-Za-z0-9_$."]+/.exec(text.slice(from))?.[0] ?? text.charAt(from);
                range = { start: toPosition(from), end: toPosition(from + Math.max(word.length, 1)) };
            }
        }
    }
    return { severity, message: parts.join('\n'), ...range, ...(code ? { code } : {}) };
}

/** A statement the server refused, at the position the error names. */
export function creationFinding(err: unknown, target: CheckTarget, text: string, attempt?: CreationAttempt): CheckFinding {
    const sent = Number((err as { position?: unknown }).position);
    const code = (err as { code?: unknown }).code;
    let range = { start: target.def.start, end: target.def.end };
    if (Number.isFinite(sent) && sent > 0) {
        const position = attempt ? attempt.toStatement(sent) : sent;
        const toPosition = positionMapper(text);
        const from = target.statementOffset + position - 1;
        const word = /^[A-Za-z0-9_$."]+/.exec(text.slice(from))?.[0] ?? text.charAt(from);
        range = { start: toPosition(from), end: toPosition(from + Math.max(word.length, 1)) };
    }
    const message = attempt ? withRealName(getErrorMessage(err), attempt, target) : getErrorMessage(err);
    return { severity: 'error', message, ...range, ...(typeof code === 'string' ? { code } : {}) };
}

// ===== Routines the database already has =====

/** One way of creating a routine of the file: as written, with OR REPLACE, or under a name of its own. */
export interface CreationAttempt {
    sql: string;
    /** The name the routine gets in the database. */
    name: string;
    /** The 1-based position in the file's statement of a 1-based position in `sql`. */
    toStatement(position: number): number;
}

const DUPLICATE_FUNCTION = '42723';
/** Why OR REPLACE cannot replace the routine the database has: another result type or parameter names, another kind, another owner. */
const CANNOT_REPLACE = new Set(['42P13', '42809', '42501']);
const MAX_IDENTIFIER_BYTES = 63;

function editedStatement(statement: string, from: number, to: number, insert: string, name: string): CreationAttempt {
    const shift = insert.length - (to - from);
    return {
        sql: statement.slice(0, from) + insert + statement.slice(to),
        name,
        toStatement: position => (position - 1 < from ? position : position - 1 < from + insert.length ? from + 1 : position - shift)
    };
}

/** `name` with `suffix`, shortened so that the server does not truncate it. */
function temporaryName(name: string, suffix: string): string {
    let base = name;
    while (base.length > 0 && Buffer.byteLength(base + suffix, 'utf8') > MAX_IDENTIFIER_BYTES) base = base.slice(0, -1);
    return base + suffix;
}

/**
 * The statement as written and, for a routine the database already has, the
 * ways around it: `CREATE OR REPLACE`, then a name of its own that no other
 * routine has. Nothing in the database is dropped or kept.
 */
export function creationAttempts(target: CheckTarget, text: string, index: number): CreationAttempt[] {
    const { statement } = target;
    const attempts = [editedStatement(statement, 0, 0, '', target.def.name)];
    const toks = tokenize(statement);
    if (!isWord(toks[0], 'create')) return attempts;
    if (!isWord(toks[1], 'or')) attempts.push(editedStatement(statement, toks[0].end, toks[0].end, ' OR REPLACE', target.def.name));
    const nameEnd = offsetAt(text, target.def.end) - target.statementOffset;
    const nameTok = toks.find(t => t.end === nameEnd && (t.type === 'word' || t.type === 'qident'));
    if (nameTok) {
        const name = temporaryName(target.def.name, `_pqb_check_${index + 1}`);
        attempts.push(editedStatement(statement, nameTok.start, nameTok.end, `"${name.replace(/"/g, '""')}"`, name));
    }
    return attempts;
}

/** Whether the next attempt can get past what the database refused. */
export function retryCreation(err: unknown, attempt: CreationAttempt): boolean {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === DUPLICATE_FUNCTION) return true;
    return typeof code === 'string' && CANNOT_REPLACE.has(code) && /^\s*create\s+or\s+replace\b/i.test(attempt.sql);
}

/** A message about the routine under its temporary name, with the name of the file. */
function withRealName(message: string, attempt: CreationAttempt, target: CheckTarget): string {
    return attempt.name === target.def.name ? message : message.split(attempt.name).join(target.def.name);
}

// ===== The run =====

export interface CheckClient {
    query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface CheckRunOptions {
    settings: CheckSettings;
    extraSeverity: CheckSeverity;
    timeoutMs: number;
    /** Parameter names of the installed function; empty means all are known. */
    knownParameters: ReadonlySet<string>;
    /** The schema plpgsql_check is installed in. */
    functionSchema?: string;
    /** Check a routine the database already has: with OR REPLACE, or else under a temporary name. */
    replaceExisting?: boolean;
    isCancelled?(): boolean;
}

const FIND_OID_QUERY = `SELECT p.oid::bigint AS oid FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname = $1 AND p.prosrc = $2 AND (n.nspname = $3::text OR ($3::text IS NULL AND n.nspname = ANY(pg_catalog.current_schemas(false))))
ORDER BY p.oid DESC LIMIT 1`;

const TRIGGER_TABLE_QUERY = `SELECT tg.tgrelid::bigint AS relid FROM pg_catalog.pg_trigger tg WHERE tg.tgfoid::bigint = ANY($1::bigint[]) AND NOT tg.tgisinternal LIMIT 1`;

/**
 * The versions the database has of a routine the file creates: plain
 * functions and procedures of that name in its schema — or, unqualified, in
 * the schema a CREATE would put it in — that no extension brings along.
 */
export const HIDE_CANDIDATES_QUERY = `SELECT p.oid::bigint AS oid, n.nspname::text AS schema_name, p.proname::text AS name,
       pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname = $1 AND n.nspname = COALESCE($2::text, pg_catalog.current_schema()) AND p.prokind IN ('f', 'p')
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                  WHERE d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND d.objid = p.oid AND d.deptype = 'e')
ORDER BY p.oid`;

/** The statement that moves a version the database has out of the way of the file's routines. */
export function hideStatement(row: Record<string, unknown>, index: number): { sql: string; name: string } {
    const quote = (s: string): string => `"${s.replace(/"/g, '""')}"`;
    const name = temporaryName(String(row.name), `_pqb_hidden_${index + 1}`);
    return { sql: `ALTER ROUTINE ${quote(String(row.schema_name))}.${quote(String(row.name))}(${String(row.args ?? '')}) RENAME TO ${quote(name)}`, name };
}

/** A routine of the file as it was created for the check. */
interface CreatedRoutine {
    target: CheckTarget;
    created: CreationAttempt;
    oid: unknown;
}

/**
 * Create, check and roll back the routines of a file. The transaction is
 * always rolled back, also when a statement or the check fails.
 *
 * With `replaceExisting`, the versions the database has of the routines the
 * file creates are first renamed out of the way — as a file that drops its
 * schema's routines before creating them expects —, so a call cannot match an
 * old overload. Then every routine is created before the first is checked, so
 * a call of a routine further down the file finds the file's version.
 */
export async function runCheck(client: CheckClient, text: string, options: CheckRunOptions): Promise<CheckFinding[]> {
    const targets = checkTargets(text);
    if (targets.length === 0) return [];
    const findings: CheckFinding[] = [];
    const quote = (s: string): string => `"${s.replace(/"/g, '""')}"`;
    const setSearchPath = async (target: CheckTarget): Promise<void> => {
        if (target.searchPath && target.searchPath.length > 0) {
            await client.query(`SELECT pg_catalog.set_config('search_path', $1, true)`, [target.searchPath.map(quote).join(', ')]);
        }
    };
    /** The oids the database's versions of a name had, by `schema.name` of the file. */
    const hidden = new Map<string, unknown[]>();
    const hiddenKey = (target: CheckTarget): string => `${target.def.schema ?? ''}.${target.def.name}`;
    await client.query('BEGIN');
    try {
        await client.query(`SELECT pg_catalog.set_config('statement_timeout', $1, true), pg_catalog.set_config('lock_timeout', $2, true)`,
            [`${options.timeoutMs}ms`, `${Math.min(options.timeoutMs, 5000)}ms`]);

        // --- Move the database's versions out of the way ---
        if (options.replaceExisting) {
            let renamed = 0;
            for (const target of targets) {
                if (options.isCancelled?.()) break;
                const k = hiddenKey(target);
                if (hidden.has(k)) continue;
                const oids: unknown[] = [];
                hidden.set(k, oids);
                await setSearchPath(target);
                for (const row of (await client.query(HIDE_CANDIDATES_QUERY, [target.def.name, target.def.schema])).rows) {
                    const hide = hideStatement(row, renamed++);
                    await client.query('SAVEPOINT pqb_hide');
                    try {
                        await client.query(hide.sql);
                        await client.query('RELEASE SAVEPOINT pqb_hide');
                        oids.push(row.oid);
                    } catch (err: unknown) {
                        // Not its owner, for example: it keeps its name, and OR REPLACE or a temporary name take over.
                        Logger.log('plpgsqlCheck.hide', `${hide.sql}: ${getErrorMessage(err)}`);
                        await client.query('ROLLBACK TO SAVEPOINT pqb_hide');
                    }
                }
            }
        }

        // --- Create every routine of the file ---
        const routines: CreatedRoutine[] = [];
        for (const [index, target] of targets.entries()) {
            if (options.isCancelled?.()) break;
            await client.query('SAVEPOINT pqb_check');
            const attempts = creationAttempts(target, text, index);
            let created: CreationAttempt | undefined;
            let refused: CheckFinding | undefined;
            for (const attempt of options.replaceExisting ? attempts : attempts.slice(0, 1)) {
                try {
                    // Set again for every attempt: a rollback to the savepoint undoes it.
                    await setSearchPath(target);
                    await client.query(attempt.sql);
                    created = attempt;
                    break;
                } catch (err: unknown) {
                    refused = creationFinding(err, target, text, attempt);
                    await client.query('ROLLBACK TO SAVEPOINT pqb_check');
                    if (!retryCreation(err, attempt)) break;
                }
            }
            if (!created) {
                if (refused) findings.push(refused);
                await client.query('RELEASE SAVEPOINT pqb_check');
                continue;
            }
            await client.query('RELEASE SAVEPOINT pqb_check');
            const oid = (await client.query(FIND_OID_QUERY, [created.name, target.body, target.def.schema])).rows[0]?.oid;
            if (oid !== undefined) routines.push({ target, created, oid });
        }

        // --- Check them ---
        for (const { target, created, oid } of routines) {
            if (options.isCancelled?.()) break;
            const named = (finding: CheckFinding): CheckFinding => ({ ...finding, message: withRealName(finding.message, created, target) });
            await client.query('SAVEPOINT pqb_check_run');
            try {
                await setSearchPath(target);
                let relid: unknown = null;
                if (target.trigger) {
                    if (target.triggerTable) {
                        const name = target.triggerTable.schema ? `${quote(target.triggerTable.schema)}.${quote(target.triggerTable.name)}` : quote(target.triggerTable.name);
                        relid = (await client.query(`SELECT to_regclass($1)::oid::bigint AS relid`, [name])).rows[0]?.relid ?? null;
                    }
                    // The triggers of the database still use the version that was moved aside.
                    relid ??= (await client.query(TRIGGER_TABLE_QUERY, [[oid, ...(hidden.get(hiddenKey(target)) ?? [])]])).rows[0]?.relid ?? null;
                    if (relid === null) {
                        findings.push({
                            severity: 'information',
                            message: `${target.def.name} was not checked by plpgsql_check: no trigger uses it, so the table it works on is unknown.`,
                            start: target.def.start,
                            end: target.def.end
                        });
                        await client.query('RELEASE SAVEPOINT pqb_check_run');
                        continue;
                    }
                }
                const call = buildCheckCall(options.settings, options.knownParameters, relid !== null, options.functionSchema);
                call.params[0] = oid;
                if (relid !== null) call.params[1] = relid;
                const rows = (await client.query(call.sql, call.params)).rows;
                for (const row of rows) findings.push(named(findingOf(row, target, text, options.extraSeverity)));
                await client.query('RELEASE SAVEPOINT pqb_check_run');
            } catch (err: unknown) {
                // fatal_errors = true raises the first error instead of returning it.
                findings.push(named({ severity: 'error', message: getErrorMessage(err), start: target.def.start, end: target.def.end }));
                await client.query('ROLLBACK TO SAVEPOINT pqb_check_run');
            }
        }
    } finally {
        await client.query('ROLLBACK').catch((err: unknown) => Logger.error('plpgsqlCheck.rollback', err));
    }
    return findings;
}

// ===== One check at a time =====

/**
 * Runs one job at a time. A key requested while it waits is not added twice;
 * a key requested while it runs runs once more afterwards.
 */
export class SingleFlightQueue {
    private readonly waiting: string[] = [];
    private readonly again = new Set<string>();
    private running: string | undefined;
    private idlePromise: Promise<void> = Promise.resolve();
    private resolveIdle: (() => void) | undefined;

    constructor(private readonly run: (key: string) => Promise<void>) {}

    get active(): string | undefined {
        return this.running;
    }

    request(key: string): void {
        if (this.running === key) {
            this.again.add(key);
            return;
        }
        if (!this.waiting.includes(key)) this.waiting.push(key);
        this.pump();
    }

    cancel(key: string): void {
        const i = this.waiting.indexOf(key);
        if (i >= 0) this.waiting.splice(i, 1);
        this.again.delete(key);
    }

    /** Resolves once nothing runs or waits. */
    idle(): Promise<void> {
        return this.idlePromise;
    }

    private pump(): void {
        if (this.running !== undefined) return;
        const next = this.waiting.shift();
        if (next === undefined) {
            this.resolveIdle?.();
            this.resolveIdle = undefined;
            return;
        }
        if (!this.resolveIdle) this.idlePromise = new Promise(resolve => { this.resolveIdle = resolve; });
        this.running = next;
        this.run(next)
            .catch((err: unknown) => Logger.error('SingleFlightQueue.run', err))
            .finally(() => {
                this.running = undefined;
                if (this.again.delete(next)) this.waiting.push(next);
                this.pump();
            });
    }
}

// ===== VS Code =====

export const CHECK_CONNECTION_KEY = 'postgresQueryBuilder.plpgsqlCheck.connection';
export const DIAGNOSTIC_SOURCE = 'plpgsql_check';

export interface CheckConnections {
    getPlpgsqlCheckConnections(): ConnectionConfig[];
    openClientFor(config: ConnectionConfig): Promise<CheckClient & {
        end(): Promise<void>;
        on(event: 'error', listener: (err: Error) => void): unknown;
    }>;
}

export function readSettings(): { settings: CheckSettings; extraSeverity: CheckSeverity; timeoutMs: number; onSave: boolean; onType: boolean; delayMs: number; replaceExisting: boolean } {
    const cfg = vscode.workspace.getConfiguration('postgresQueryBuilder');
    const settings = { ...DEFAULT_CHECK_SETTINGS };
    for (const key of Object.keys(settings) as Array<keyof CheckSettings>) {
        settings[key] = cfg.get<boolean>(`plpgsqlCheck.${key}`, DEFAULT_CHECK_SETTINGS[key]);
    }
    const extra = cfg.get<string>('plpgsqlCheck.extraSeverity', 'information');
    return {
        settings,
        extraSeverity: extra === 'warning' || extra === 'error' ? extra : 'information',
        timeoutMs: cfg.get<number>('plpgsqlCheck.timeoutMs', 10000),
        onSave: cfg.get<boolean>('plpgsqlCheck.onSave', true),
        onType: cfg.get<boolean>('plpgsqlCheck.onType', false),
        delayMs: cfg.get<number>('plpgsqlCheck.delayMs', 1500),
        replaceExisting: cfg.get<boolean>('plpgsqlCheck.replaceExisting', true)
    };
}

const SEVERITY: Record<CheckSeverity, vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    information: vscode.DiagnosticSeverity.Information
};

export function toDiagnostic(finding: CheckFinding): vscode.Diagnostic {
    const diagnostic = new vscode.Diagnostic(
        new vscode.Range(finding.start.line, finding.start.character, finding.end.line, finding.end.character),
        finding.message,
        SEVERITY[finding.severity]
    );
    diagnostic.source = DIAGNOSTIC_SOURCE;
    if (finding.code) diagnostic.code = finding.code;
    return diagnostic;
}

/** Checks open SQL files with plpgsql_check: on save, optionally while typing, and on request. */
export class PlpgsqlChecker implements vscode.Disposable {
    private readonly collection = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
    private readonly queue = new SingleFlightQueue(key => this.check(key));
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly documents = new Map<string, vscode.TextDocument>();
    private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    private readonly disposables: vscode.Disposable[] = [];
    private client?: { name: string; promise: Promise<Awaited<ReturnType<CheckConnections['openClientFor']>>> };
    private knownParameters = new Map<string, { schema: string; names: Set<string> }>();

    constructor(
        private readonly connections: CheckConnections,
        private readonly state: vscode.Memento,
        private readonly languages: readonly string[]
    ) {
        this.status.command = 'postgresQueryBuilder.selectPlpgsqlCheckConnection';
        this.disposables.push(
            this.collection,
            this.status,
            vscode.workspace.onDidSaveTextDocument(doc => {
                const s = readSettings();
                if (!s.onSave) return;
                const autoSave = vscode.workspace.getConfiguration('files').get<string>('autoSave', 'off');
                this.schedule(doc, autoSave === 'off' ? 0 : s.delayMs);
            }),
            vscode.workspace.onDidChangeTextDocument(e => {
                const s = readSettings();
                if (s.onType && e.contentChanges.length > 0) this.schedule(e.document, s.delayMs);
            }),
            vscode.workspace.onDidCloseTextDocument(doc => this.forget(doc)),
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('postgresQueryBuilder.savedConnections')) this.updateStatus();
            })
        );
        this.updateStatus();
    }

    /** The connection the checks run on: the chosen one while it is still marked, else the only marked one. */
    connection(): ConnectionConfig | undefined {
        const marked = this.connections.getPlpgsqlCheckConnections();
        const chosen = this.state.get<string>(CHECK_CONNECTION_KEY);
        return marked.find(c => c.name === chosen) ?? (marked.length === 1 ? marked[0] : undefined);
    }

    async selectConnection(): Promise<void> {
        const marked = this.connections.getPlpgsqlCheckConnections();
        if (marked.length === 0) {
            vscode.window.showInformationMessage('No connection is marked for plpgsql_check. Edit a connection and tick "Check SQL files with plpgsql_check in this database".');
            return;
        }
        const current = this.connection()?.name;
        const pick = await vscode.window.showQuickPick(
            marked.map(c => ({ label: c.name, description: `${c.host}:${c.port}/${c.database}${c.name === current ? ' · current' : ''}`, name: c.name })),
            { placeHolder: 'The database plpgsql_check checks the SQL files against' }
        );
        if (!pick) return;
        await this.state.update(CHECK_CONNECTION_KEY, pick.name);
        this.closeClient();
        this.collection.clear();
        this.updateStatus();
    }

    /** Check a document now (the command). */
    checkNow(doc: vscode.TextDocument | undefined): void {
        if (!doc || !this.languages.includes(doc.languageId)) {
            vscode.window.showInformationMessage('Open a SQL file to check it with plpgsql_check.');
            return;
        }
        if (!this.connection()) {
            void this.selectConnection();
            return;
        }
        this.schedule(doc, 0, true);
    }

    private updateStatus(): void {
        const connection = this.connection();
        const marked = this.connections.getPlpgsqlCheckConnections();
        if (marked.length === 0) {
            this.status.hide();
            this.collection.clear();
            this.closeClient();
            return;
        }
        this.status.text = connection ? `$(checklist) plpgsql_check: ${connection.name}` : '$(checklist) plpgsql_check: choose';
        this.status.tooltip = connection
            ? `SQL files are checked with plpgsql_check in ${connection.database} on ${connection.host}. Click to choose another database.`
            : 'Choose the database plpgsql_check checks the SQL files against';
        this.status.show();
        if (this.client && this.client.name !== connection?.name) this.closeClient();
    }

    private schedule(doc: vscode.TextDocument, delayMs: number, explicit = false): void {
        if (!this.languages.includes(doc.languageId) || !this.connection()) return;
        if (!explicit && !/plpgsql/i.test(doc.getText())) return;
        const key = doc.uri.toString();
        this.documents.set(key, doc);
        const pending = this.timers.get(key);
        if (pending) clearTimeout(pending);
        this.timers.set(key, setTimeout(() => {
            this.timers.delete(key);
            this.queue.request(key);
        }, delayMs));
    }

    private forget(doc: vscode.TextDocument): void {
        const key = doc.uri.toString();
        const pending = this.timers.get(key);
        if (pending) clearTimeout(pending);
        this.timers.delete(key);
        this.queue.cancel(key);
        this.documents.delete(key);
        this.collection.delete(doc.uri);
    }

    private clientFor(config: ConnectionConfig): Promise<Awaited<ReturnType<CheckConnections['openClientFor']>>> {
        if (this.client?.name === config.name) return this.client.promise;
        this.closeClient();
        const promise = this.connections.openClientFor(config).then(client => {
            client.on('error', (err: Error) => {
                Logger.error('PlpgsqlChecker.client', err);
                if (this.client?.promise === promise) this.client = undefined;
            });
            return client;
        });
        this.client = { name: config.name, promise };
        promise.catch(() => { if (this.client?.promise === promise) this.client = undefined; });
        return promise;
    }

    private closeClient(): void {
        const client = this.client;
        this.client = undefined;
        client?.promise.then(c => c.end()).catch(() => undefined);
    }

    private async check(key: string): Promise<void> {
        const doc = this.documents.get(key);
        const config = this.connection();
        if (!doc || doc.isClosed || !config) return;
        const version = doc.version;
        const text = doc.getText();
        const s = readSettings();
        let findings: CheckFinding[];
        try {
            const client = await this.clientFor(config);
            if (!this.knownParameters.has(config.name)) {
                const rows = (await client.query(CHECK_PARAMETERS_QUERY)).rows;
                if (rows.length === 0) {
                    vscode.window.showWarningMessage(`The database of "${config.name}" has no plpgsql_check extension.`);
                    return;
                }
                this.knownParameters.set(config.name, { schema: String(rows[0].schema_name), names: new Set(rows.map(r => String(r.name))) });
            }
            findings = await runCheck(client, text, {
                settings: s.settings,
                extraSeverity: s.extraSeverity,
                timeoutMs: s.timeoutMs,
                knownParameters: this.knownParameters.get(config.name)!.names,
                functionSchema: this.knownParameters.get(config.name)!.schema,
                replaceExisting: s.replaceExisting,
                isCancelled: () => doc.isClosed
            });
        } catch (err: unknown) {
            Logger.error('PlpgsqlChecker.check', err);
            this.closeClient();
            vscode.window.setStatusBarMessage(`$(error) plpgsql_check failed: ${getErrorMessage(err)}`, 8000);
            return;
        }
        // A result for an older version is dropped; the change brings its own check.
        if (doc.isClosed || doc.version !== version) return;
        this.collection.set(doc.uri, findings.map(toDiagnostic));
    }

    /** Resolves when no check runs or waits (tests). */
    idle(): Promise<void> {
        return this.queue.idle();
    }

    dispose(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        this.closeClient();
        for (const d of this.disposables) d.dispose();
    }
}

export function registerPlpgsqlCheck(context: vscode.ExtensionContext, connections: CheckConnections, languages: readonly string[]): PlpgsqlChecker {
    const checker = new PlpgsqlChecker(connections, context.workspaceState, languages);
    context.subscriptions.push(
        checker,
        vscode.commands.registerCommand('postgresQueryBuilder.checkFilePlpgsql', () => checker.checkNow(vscode.window.activeTextEditor?.document)),
        vscode.commands.registerCommand('postgresQueryBuilder.selectPlpgsqlCheckConnection', () => checker.selectConnection())
    );
    return checker;
}

