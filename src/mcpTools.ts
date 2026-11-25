/**
 * The tools of the MCP server: what an AI assistant may ask the extension to
 * do with the user's saved connections. Each tool checks the capability the
 * user granted the connection (see `mcpPermissions`) before it touches the
 * database. Everything that talks to VS Code or opens a connection comes in
 * through {@link McpServices}, so the handlers are tested with fakes.
 */
// A namespace import: `import { z }` would keep every zod locale in the bundle.
import * as z from 'zod';
import type { ConnectionConfig } from './connectionManager';
import { aiCapabilities, confirmsWrites, isAllowed, refusalMessage, type AiCapability } from './mcpPermissions';
import { codeMask, splitStatements } from './sqlFileSession';
import { formatSqlChecked, type FormatOptions } from './plpgsqlFormatter';
import { SERVER_VERSION_QUERY, fetchCreateScript, withQualifiedNames, type DdlKind, type DdlOptions, type DdlTarget } from './ddlGenerator';
import { KIND_CLASS, USED_BY_QUERY, USES_QUERY, toDependencyRow } from './objectDependencies';
import { buildObjectCatalogQuery, toDbObject, type DbObject } from './databaseCatalog';
import { checkTargets, type CheckFinding } from './plpgsqlCheck';
import { pgValueToText } from './sqlUtils';
import { applyQueryParameters, mergeParameters, type SavedQuery, type SavedQueryScope } from './savedQueryStore';
import { normalizeColumnPairs, normalizeMappingConditions, type CustomColumnMapping, type MappingScope } from './columnMappingManager';
import { Logger, getErrorMessage } from './logger';

// ===== Services =====

export interface McpQueryResult {
    rows: Array<Record<string, unknown>>;
    rowCount: number | null;
    command?: string;
}

export interface McpStatementResult {
    fields: string[];
    rows: unknown[][];
    rowCount: number | null;
    command: string;
}

/** A client of its own for one tool call. */
export interface McpDbClient {
    query(sql: string, params?: unknown[]): Promise<McpQueryResult>;
    /** Exactly one statement, sent over the extended protocol (which refuses a second one); rows as arrays. */
    runStatement(sql: string): Promise<McpStatementResult>;
}

export interface McpSettings {
    maxRows: number;
    statementTimeoutSeconds: number;
}

export interface ResolvedConnection {
    config: ConnectionConfig;
    /** The connection VS Code is connected to; the Data Viewer and the comparison work on it only. */
    active: boolean;
}

export interface SavedQueryAccess {
    list(): SavedQuery[];
    add(query: Omit<SavedQuery, 'id'>, scope: SavedQueryScope): Promise<SavedQuery>;
}

export interface MappingAccess {
    list(): CustomColumnMapping[];
    add(mapping: Omit<CustomColumnMapping, 'id'>, scope: MappingScope): Promise<CustomColumnMapping>;
    update(id: string, patch: Partial<Omit<CustomColumnMapping, 'id'>>): Promise<void>;
    remove(id: string): Promise<void>;
}

export interface McpServices {
    savedConnections(): ConnectionConfig[];
    activeConnection(): ConnectionConfig | null;
    /** Open a client for the connection, with the statement timeout set, run `work` and close it. */
    withClient<T>(connection: ResolvedConnection, work: (client: McpDbClient) => Promise<T>): Promise<T>;
    settings(): McpSettings;
    /** A modal question; true when the user pressed `action`. */
    askToProceed(message: string, detail: string, action: string): Promise<boolean>;
    openInDataViewer(sql: string, title: string): Promise<void>;
    formatOptions(): Partial<FormatOptions>;
    ddlOptions(): DdlOptions;
    plpgsqlCheck(client: McpDbClient, text: string): Promise<CheckFinding[]>;
    /** The text of a file of the workspace (unsaved changes included); throws outside the workspace. */
    readWorkspaceFile(filePath: string): Promise<string>;
    /** Compare Repository with Database on the active connection, as a Markdown report. */
    compareRepository(): Promise<string>;
    savedQueries: SavedQueryAccess;
    mappings: MappingAccess;
}

// ===== Results =====

export interface ToolResult {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
}

/** A failure the assistant should read: a refusal, a missing object, bad input. */
export class ToolError extends Error {}

/** Longest text a tool returns before it is cut. */
export const MAX_TEXT_LENGTH = 60000;

/** `text`, cut at `max` characters with a note telling how much is missing. */
export function truncateText(text: string, max = MAX_TEXT_LENGTH): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n… [truncated: ${text.length - max} more characters not shown]`;
}

function textResult(text: string): ToolResult {
    return { content: [{ type: 'text', text: truncateText(text) }] };
}

function jsonResult(value: unknown): ToolResult {
    return textResult(JSON.stringify(value, null, 1));
}

function errorResult(message: string): ToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
}

// ===== Statements =====

/** `dml+ddl` is a `SELECT … INTO` whose `WITH` also changes data. */
export type StatementKind = 'read' | 'explain' | 'dml' | 'ddl' | 'dml+ddl' | 'routine' | 'session' | 'transaction' | 'unsupported';

const DDL_KEYWORDS = new Set(['create', 'alter', 'drop', 'truncate', 'grant', 'revoke', 'comment', 'reindex', 'cluster', 'refresh', 'security', 'import', 'analyze', 'analyse']);
const DML_KEYWORDS = new Set(['insert', 'update', 'delete', 'merge', 'lock']);
const TRANSACTION_KEYWORDS = new Set(['begin', 'start', 'commit', 'end', 'rollback', 'abort', 'savepoint', 'release']);

/** The first word of a statement in lower case, after comments and opening parentheses. */
export function firstKeyword(statement: string): string {
    return /^[\s(]*([a-z_]+)/.exec(codeMask(statement).toLowerCase())?.[1] ?? '';
}

const DATA_VERBS = new Set(['insert', 'update', 'delete', 'merge']);
const STATEMENT_VERBS = new Set(['select', 'values', 'table', ...DATA_VERBS]);
/** A nested parenthesised group in the token list of its enclosing group. */
const GROUP = '()';

/** True when `verb` at `own[k]` starts that statement: `INSERT INTO`, `DELETE FROM`, `MERGE INTO`, `UPDATE <table>`. */
function startsStatement(own: readonly string[], k: number): boolean {
    const next = own[k + 1] ?? '';
    switch (own[k]) {
        case 'insert':
        case 'merge':
            return next === 'into';
        case 'delete':
            return next === 'from';
        case 'update':
            return /^[a-z_\u0080-\uffff]/.test(next) && next !== 'as';
        default:
            return STATEMENT_VERBS.has(own[k]);
    }
}

/**
 * The verb of the statement made of the tokens `own` of one parenthesised
 * level: its first word, or after a `WITH` the first verb that is not the
 * name of a common table expression. Empty when the level is no statement.
 */
function mainVerb(own: readonly string[]): string {
    if (own[0] !== 'with') return startsStatement(own, 0) ? own[0] : '';
    for (let k = 1; k < own.length; k++) {
        if (['with', 'recursive', ','].includes(own[k - 1])) continue;
        if (STATEMENT_VERBS.has(own[k]) && startsStatement(own, k)) return own[k];
    }
    return '';
}

interface QueryShape {
    /** A statement on some level inserts, updates, deletes or merges: a data-modifying `WITH`. */
    writesData: boolean;
    /** A `SELECT … INTO`, which creates a table. */
    selectInto: boolean;
}

/**
 * Read the level of `tokens` starting at `start` up to its closing parenthesis
 * (or the end) into `shape`, the nested levels recursively. Returns the index
 * after the level.
 */
function readLevel(tokens: readonly string[], start: number, top: boolean, shape: QueryShape): number {
    const own: string[] = [];
    let i = start;
    while (i < tokens.length && tokens[i] !== ')') {
        if (tokens[i] === '(') {
            i = readLevel(tokens, i + 1, false, shape);
            own.push(GROUP);
        } else {
            own.push(tokens[i++]);
        }
    }
    const verb = mainVerb(own);
    if (DATA_VERBS.has(verb)) shape.writesData = true;
    else if (own.includes('into') && (verb !== '' || top || own[0] === 'with')) shape.selectInto = true;
    return i + 1;
}

/**
 * What a query (`SELECT`, `WITH`, `VALUES`, `TABLE`) does, judged by the
 * structure of its levels of parentheses rather than by words anywhere, so a
 * column alias such as `AS insert` changes nothing.
 */
function classifyQuery(statement: string): StatementKind {
    const tokens = codeMask(statement).toLowerCase().match(/[a-z_\u0080-\uffff][a-z0-9_$\u0080-\uffff]*|\S/g) ?? [];
    const shape: QueryShape = { writesData: false, selectInto: false };
    readLevel(tokens, 0, true, shape);
    if (shape.selectInto) return shape.writesData ? 'dml+ddl' : 'ddl';
    return shape.writesData ? 'dml' : 'read';
}

/**
 * What a statement does. A query (`SELECT`, `WITH`, `VALUES`, `TABLE`) that
 * writes — a data-modifying `WITH` or `SELECT … INTO`, which creates a table —
 * counts as the write. Comments, strings, quoted names and dollar-quoted bodies
 * are not looked at.
 */
export function classifyStatement(statement: string): StatementKind {
    const keyword = firstKeyword(statement);
    switch (keyword) {
        case 'select':
        case 'values':
        case 'table':
        case 'with':
            return classifyQuery(statement);
        case 'show':
            return 'read';
        case 'explain':
            return 'explain';
        case 'call':
        case 'do':
            return 'routine';
        case 'set':
        case 'reset':
            return 'session';
        default:
            if (DML_KEYWORDS.has(keyword)) return 'dml';
            if (DDL_KEYWORDS.has(keyword)) return 'ddl';
            if (TRANSACTION_KEYWORDS.has(keyword)) return 'transaction';
            return 'unsupported';
    }
}

export interface ClassifiedStatement {
    sql: string;
    kind: StatementKind;
}

/** The statements of a script with what each does. */
export function classifySql(sql: string): ClassifiedStatement[] {
    return splitStatements(sql).map((statement) => ({ sql: statement, kind: classifyStatement(statement) }));
}

/**
 * The capabilities `execute_sql` needs for statements of these kinds. A query
 * needs `writeData` too: the functions it calls may write. A routine call or
 * `DO` block may do anything, so it needs both.
 */
export function requiredCapabilities(kinds: readonly StatementKind[]): AiCapability[] {
    const needed = new Set<AiCapability>();
    for (const kind of kinds) {
        if (kind === 'read' || kind === 'dml' || kind === 'dml+ddl' || kind === 'routine') needed.add('writeData');
        if (kind === 'ddl' || kind === 'dml+ddl' || kind === 'routine') needed.add('ddl');
    }
    return (['writeData', 'ddl'] as const).filter((c) => needed.has(c));
}

/** The beginning of a statement on one line, for messages. */
function statementPreview(sql: string): string {
    const oneLine = sql.replace(/\s+/g, ' ').trim();
    return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

// ===== Connections and capabilities =====

/** The connection a tool runs on: the named saved connection, or the active one. */
export function resolveConnection(services: McpServices, name: string | undefined): ResolvedConnection {
    const saved = services.savedConnections();
    const active = services.activeConnection();
    const names = saved.length > 0 ? saved.map((c) => `"${c.name}"`).join(', ') : 'none';
    const wanted = name?.trim();
    if (!wanted || (active && active.name === wanted)) {
        if (!active) {
            throw new ToolError(`No connection is active in VS Code. Pass "connection" with the name of a saved connection (${names}), or ask the user to connect.`);
        }
        // The saved entry holds the permissions as the user last edited them.
        const entry = saved.find((c) => c.name === active.name);
        return { config: { ...active, ai: entry ? entry.ai : active.ai }, active: true };
    }
    const entry = saved.find((c) => c.name === wanted);
    if (!entry) throw new ToolError(`No saved connection is named "${wanted}". Saved connections: ${names}.`);
    return { config: entry, active: false };
}

function requireCapability(connection: ResolvedConnection, capability: AiCapability): void {
    if (!isAllowed(connection.config, capability)) throw new ToolError(refusalMessage(connection.config.name, capability));
}

/** Most characters of SQL one confirmation shows; more is refused rather than shown in part. */
export const MAX_CONFIRM_SQL_LENGTH = 4000;
/** Most statements one confirmation shows. */
export const MAX_CONFIRM_STATEMENTS = 20;

const KIND_LABELS: Record<StatementKind, string> = {
    read: 'Query', explain: 'EXPLAIN', dml: 'DML', ddl: 'DDL', 'dml+ddl': 'DML+DDL', routine: 'CALL/DO',
    session: 'SET', transaction: 'Transaction', unsupported: 'Other'
};

/** A statement on one line without its comments, as a confirmation shows it. */
export function confirmationText(sql: string): string {
    const masked = codeMask(sql);
    let out = '';
    for (let i = 0; i < sql.length; i++) out += masked[i] === ' ' && !/\s/.test(sql[i]) ? ' ' : sql[i];
    return out.replace(/\s+/g, ' ').trim();
}

export interface StatementConfirmation {
    /** How many statements of which kind, e.g. `3 statements (2 DML, 1 DDL)`. */
    summary: string;
    /** Every statement, numbered, with its kind and its whole text. */
    detail: string;
}

/**
 * The dialog text confirming `statements`. Every statement is shown in full
 * (comments, which could hide a statement behind padding, left out), so too
 * many or too long statements are refused instead of being shown in part.
 */
export function describeStatements(statements: readonly ClassifiedStatement[]): StatementConfirmation {
    const smaller = `Nothing was run. Send smaller batches: at most ${MAX_CONFIRM_STATEMENTS} statements and ${MAX_CONFIRM_SQL_LENGTH} characters (without comments) per call, so the user can read all of it before confirming.`;
    if (statements.length > MAX_CONFIRM_STATEMENTS) {
        throw new ToolError(`The SQL has ${statements.length} statements, too many to show them all in the confirmation dialog. ${smaller}`);
    }
    const counts = new Map<string, number>();
    for (const s of statements) counts.set(KIND_LABELS[s.kind], (counts.get(KIND_LABELS[s.kind]) ?? 0) + 1);
    const n = statements.length;
    const summary = `${n} statement${n === 1 ? '' : 's'} (${[...counts].map(([label, count]) => `${count} ${label}`).join(', ')})`;
    const detail = statements.map((s, i) => `${i + 1}. ${KIND_LABELS[s.kind]}: ${confirmationText(s.sql)}`).join('\n\n');
    if (detail.length > MAX_CONFIRM_SQL_LENGTH) {
        throw new ToolError(`The SQL is too long to show it completely in the confirmation dialog (${detail.length} characters without comments). ${smaller}`);
    }
    return { summary, detail };
}

/**
 * Ask the user to confirm running `statements`, each shown in full; `message`
 * builds the question from the summary. Throws the refusal when the
 * statements cannot be shown completely or the user declines.
 */
async function confirmStatements(services: McpServices, connection: ResolvedConnection, statements: readonly ClassifiedStatement[],
    message: (summary: string) => string, action: string): Promise<void> {
    if (!confirmsWrites(connection.config)) return;
    const { summary, detail } = describeStatements(statements);
    const question = message(summary);
    const accepted = await services.askToProceed(question, detail, action);
    if (!accepted) throw new ToolError(`The user declined: ${question} Nothing was changed.`);
}

// ===== Values =====

/** A database value as JSON: numbers and booleans stay, everything else becomes its PostgreSQL text. */
export function toJsonValue(value: unknown): unknown {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (typeof value === 'boolean' || typeof value === 'string') return value;
    return pgValueToText(value);
}

/** Drop the null and empty fields of an object, so the JSON stays short. */
function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
        if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
        out[key] = v;
    }
    return out as Partial<T>;
}

/**
 * A name filter: with `*` or `%` a wildcard pattern matching the whole name
 * (`?` stands for one character), otherwise a part of the name; both ignore case.
 */
export function nameMatcher(pattern: string | undefined): (name: string) => boolean {
    const p = (pattern ?? '').trim();
    if (!p) return () => true;
    if (!/[*%]/.test(p)) {
        const part = p.toLowerCase();
        return (name) => name.toLowerCase().includes(part);
    }
    const source = p.split('').map((ch) => {
        if (ch === '*' || ch === '%') return '.*';
        if (ch === '?') return '.';
        return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }).join('');
    const regex = new RegExp(`^${source}$`, 'i');
    return (name) => regex.test(name);
}

// ===== Queries =====

async function inTransaction<T>(client: McpDbClient, begin: string, work: () => Promise<T>): Promise<T> {
    await client.query(begin);
    try {
        return await work();
    } finally {
        await client.query('ROLLBACK').catch((err: unknown) => Logger.error('Mcp.rollback', err));
    }
}

export interface ReadResult {
    columns: string[];
    rows: unknown[][];
    truncated: boolean;
}

/**
 * Run one query in a read-only transaction that is rolled back, reading at
 * most `limit` rows through a cursor (one more tells that there are more).
 */
export async function runReadOnly(client: McpDbClient, statement: string, limit: number): Promise<ReadResult> {
    return inTransaction(client, 'BEGIN READ ONLY', async () => {
        let result: McpStatementResult;
        if (firstKeyword(statement) === 'show') {
            result = await client.runStatement(statement);
        } else {
            await client.runStatement(`DECLARE pqb_mcp_cursor NO SCROLL CURSOR FOR ${statement}\n`);
            result = await client.runStatement(`FETCH FORWARD ${Math.floor(limit) + 1} FROM pqb_mcp_cursor`);
        }
        return {
            columns: result.fields,
            rows: result.rows.slice(0, limit).map((row) => row.map(toJsonValue)),
            truncated: result.rows.length > limit
        };
    });
}

function readResultJson(result: ReadResult, limit: number): ToolResult {
    const body: Record<string, unknown> = { columns: result.columns, rows: result.rows, rowCount: result.rows.length };
    if (result.truncated) {
        body.truncated = true;
        body.note = `Only the first ${limit} rows are shown. Add a WHERE clause, an aggregate or a LIMIT to see what you need.`;
    }
    return jsonResult(body);
}

/** A row-locking clause, in code masked by `codeMask` and lower-cased. */
const LOCKING_CLAUSE = /\bfor\s+(no\s+key\s+update|update|key\s+share|share)\b/;

/** The one statement of `sql`, which must be a query; throws a helpful error otherwise. */
function singleQuery(sql: string, tool: string): string {
    const statements = classifySql(sql);
    if (statements.length === 0) throw new ToolError('The SQL is empty.');
    if (statements.length > 1) throw new ToolError(`${tool} runs exactly one statement, but the SQL has ${statements.length}. Send them one by one.`);
    const { sql: statement, kind } = statements[0];
    if (kind === 'read') return statement;
    if (kind === 'explain') throw new ToolError('Use explain_query to see a query plan; pass the query without EXPLAIN.');
    if (kind === 'dml' || kind === 'ddl' || kind === 'dml+ddl' || kind === 'routine') {
        throw new ToolError(`${tool} only reads, and this statement changes the database. Use execute_sql for it.`);
    }
    throw new ToolError(`${tool} only runs SELECT, WITH, VALUES, TABLE and SHOW statements.`);
}

function rowLimit(services: McpServices, requested: number | undefined): number {
    const max = Math.max(1, Math.floor(services.settings().maxRows));
    return requested === undefined ? max : Math.max(1, Math.min(Math.floor(requested), max));
}

// ===== Object targets =====

export const OBJECT_KINDS = [
    'table', 'view', 'materialized view', 'foreign table', 'function', 'procedure', 'aggregate',
    'type', 'domain', 'sequence', 'trigger', 'extension', 'schema'
] as const;
export type ObjectKind = typeof OBJECT_KINDS[number];

const DDL_KIND: Record<ObjectKind, DdlKind> = {
    table: 'table', view: 'view', 'materialized view': 'matview', 'foreign table': 'foreign',
    function: 'function', procedure: 'procedure', aggregate: 'aggregate', type: 'type', domain: 'domain',
    sequence: 'sequence', trigger: 'trigger', extension: 'extension', schema: 'schema'
};

const RELKINDS: Partial<Record<ObjectKind, string[]>> = {
    table: ['r', 'p'], view: ['v'], 'materialized view': ['m'], 'foreign table': ['f'], sequence: ['S']
};

/** Position of the schema in the search_path (null when not on it) — used to pick the object an unqualified name means. */
const PATH_POSITION = 'array_position(pg_catalog.current_schemas(false)::text[], n.nspname::text)';

export interface TargetInput {
    kind: ObjectKind;
    schema?: string;
    name: string;
    args?: string;
    table?: string;
}

function normalizeArgs(args: string): string {
    return args.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim().toLowerCase();
}

/** Find the object a tool input names; ambiguous names are reported with the candidates. */
export async function resolveTarget(client: McpDbClient, input: TargetInput): Promise<DdlTarget> {
    const schema = input.schema?.trim() || null;
    const kind = DDL_KIND[input.kind];
    let rows: Array<Record<string, unknown>>;
    if (input.kind === 'schema') {
        rows = (await client.query('SELECT n.oid::bigint AS oid, n.nspname::text AS schema_name, n.nspname::text AS name, 0 AS path_pos FROM pg_catalog.pg_namespace n WHERE n.nspname = $1', [input.name])).rows;
    } else if (input.kind === 'extension') {
        rows = (await client.query(
            `SELECT e.oid::bigint AS oid, n.nspname::text AS schema_name, e.extname::text AS name, 0 AS path_pos
             FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = $1`,
            [input.name]
        )).rows;
    } else if (RELKINDS[input.kind]) {
        rows = (await client.query(
            `SELECT c.oid::bigint AS oid, n.nspname::text AS schema_name, c.relname::text AS name, ${PATH_POSITION} AS path_pos
             FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relname = $1 AND c.relkind::text = ANY($2::text[]) AND ($3::text IS NULL OR n.nspname = $3::text)
             ORDER BY 4 NULLS LAST, 2`,
            [input.name, RELKINDS[input.kind], schema]
        )).rows;
    } else if (input.kind === 'function' || input.kind === 'procedure' || input.kind === 'aggregate') {
        const version = await serverVersion(client);
        const kindFilter = version >= 110000
            ? `p.prokind::text = ANY($3::text[])`
            : `(CASE WHEN p.proisagg THEN 'a' ELSE 'f' END) = ANY($3::text[])`;
        const prokinds = input.kind === 'function' ? ['f', 'w'] : input.kind === 'procedure' ? ['p'] : ['a'];
        rows = (await client.query(
            `SELECT p.oid::bigint AS oid, n.nspname::text AS schema_name, p.proname::text AS name,
                    pg_catalog.pg_get_function_identity_arguments(p.oid) AS args, ${PATH_POSITION} AS path_pos
             FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
             WHERE p.proname = $1 AND ($2::text IS NULL OR n.nspname = $2::text) AND ${kindFilter}
             ORDER BY 5 NULLS LAST, 2, 4`,
            [input.name, schema, prokinds]
        )).rows;
        if (input.args !== undefined) {
            const wanted = normalizeArgs(input.args);
            rows = rows.filter((r) => normalizeArgs(String(r.args ?? '')) === wanted);
        }
    } else if (input.kind === 'type' || input.kind === 'domain') {
        rows = (await client.query(
            `SELECT t.oid::bigint AS oid, n.nspname::text AS schema_name, t.typname::text AS name, ${PATH_POSITION} AS path_pos
             FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
             LEFT JOIN pg_catalog.pg_class c ON c.oid = t.typrelid
             WHERE t.typname = $1 AND ($2::text IS NULL OR n.nspname = $2::text)
               AND (CASE WHEN $3::boolean THEN t.typtype = 'd' ELSE t.typtype <> 'd' AND (t.typrelid = 0 OR c.relkind = 'c') END)
             ORDER BY 4 NULLS LAST, 2`,
            [input.name, schema, input.kind === 'domain']
        )).rows;
    } else {
        if (!input.table) throw new ToolError('Pass "table", the table the trigger belongs to.');
        rows = (await client.query(
            `SELECT tg.oid::bigint AS oid, n.nspname::text AS schema_name, tg.tgname::text AS name, c.relname::text AS table_name, ${PATH_POSITION} AS path_pos
             FROM pg_catalog.pg_trigger tg JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE tg.tgname = $1 AND c.relname = $2 AND ($3::text IS NULL OR n.nspname = $3::text) AND NOT tg.tgisinternal
             ORDER BY 5 NULLS LAST, 2`,
            [input.name, input.table, schema]
        )).rows;
    }
    const label = `${input.kind} ${schema ? `${schema}.` : ''}${input.name}${input.args !== undefined ? `(${input.args})` : ''}`;
    if (rows.length === 0) throw new ToolError(`There is no ${label} in the database.`);
    // Without a schema the name means what the search_path finds first, as in SQL.
    if (!schema && rows.length > 1) {
        const first = rows[0].path_pos;
        const onPath = rows.filter((r) => r.path_pos !== null && r.path_pos !== undefined && String(r.path_pos) === String(first));
        if (first !== null && first !== undefined) rows = onPath;
    }
    if (rows.length > 1) {
        const candidates = rows.slice(0, 20).map((r) => `${String(r.schema_name)}.${String(r.name)}${r.args !== undefined ? `(${String(r.args ?? '')})` : ''}`);
        const hint = rows[0].args !== undefined ? 'Pass "schema" and "args" (the identity arguments)' : 'Pass "schema"';
        throw new ToolError(`The ${label} is ambiguous: ${candidates.join(', ')}. ${hint} to choose one.`);
    }
    const row = rows[0];
    const target: DdlTarget = { kind, schema: String(row.schema_name), name: String(row.name), oid: Number(row.oid) };
    if (row.args !== undefined) target.args = String(row.args ?? '');
    if (row.table_name !== undefined) target.table = String(row.table_name);
    return target;
}

async function serverVersion(client: McpDbClient): Promise<number> {
    return Number((await client.query(SERVER_VERSION_QUERY)).rows[0]?.server_version_num ?? 0);
}

function describeTarget(target: DdlTarget): string {
    if (target.kind === 'schema' || target.kind === 'extension') return `${target.kind} ${target.name}`;
    const args = target.args !== undefined ? `(${target.args})` : '';
    const table = target.table ? ` on ${target.schema}.${target.table}` : '';
    return `${target.kind} ${target.schema}.${target.name}${args}${table}`;
}

// ===== Queries of the catalog tools =====

const SCHEMAS_QUERY = `SELECT n.nspname::text AS name, pg_catalog.pg_get_userbyid(n.nspowner)::text AS owner,
       pg_catalog.obj_description(n.oid, 'pg_namespace') AS comment
FROM pg_catalog.pg_namespace n
WHERE $1::boolean OR (n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%')
ORDER BY 1`;

export const RELATIONS_QUERY = `SELECT n.nspname::text AS schema_name, c.relname::text AS name, c.relkind::text AS relkind,
       pg_catalog.obj_description(c.oid, 'pg_class') AS comment
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND (CASE WHEN $1::text IS NULL
            THEN n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
            ELSE n.nspname = $1::text END)
ORDER BY 1, 2`;

const RELATION_KIND_NAMES: Record<string, ObjectKind> = { r: 'table', p: 'table', v: 'view', m: 'materialized view', f: 'foreign table' };
const RELATION_KINDS: ReadonlySet<ObjectKind> = new Set(Object.values(RELATION_KIND_NAMES));

const RELATION_QUERY = `SELECT c.oid::bigint AS oid, n.nspname::text AS schema_name, c.relname::text AS name, c.relkind::text AS relkind,
       pg_catalog.obj_description(c.oid, 'pg_class') AS comment, c.reltuples::bigint AS estimated_rows,
       ${PATH_POSITION} AS path_pos
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND ($2::text IS NULL OR n.nspname = $2::text)
ORDER BY 7 NULLS LAST, 2`;

function columnsQuery(version: number): string {
    return `SELECT a.attname::text AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
       pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_value, pg_catalog.col_description(a.attrelid, a.attnum) AS comment,
       ${version >= 100000 ? 'a.attidentity::text' : `''::text`} AS identity, ${version >= 120000 ? 'a.attgenerated::text' : `''::text`} AS generated
FROM pg_catalog.pg_attribute a
LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum`;
}

const CONSTRAINTS_QUERY = `SELECT con.conname::text AS name, con.contype::text AS type, pg_catalog.pg_get_constraintdef(con.oid, true) AS definition
FROM pg_catalog.pg_constraint con WHERE con.conrelid = $1::oid ORDER BY con.contype, con.conname`;

const REFERENCED_BY_QUERY = `SELECT con.conname::text AS name, con.conrelid::regclass::text AS from_table, pg_catalog.pg_get_constraintdef(con.oid, true) AS definition
FROM pg_catalog.pg_constraint con WHERE con.confrelid = $1::oid AND con.contype = 'f' ORDER BY 2, 1`;

const INDEXES_QUERY = `SELECT ic.relname::text AS name, pg_catalog.pg_get_indexdef(i.indexrelid) AS definition
FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
WHERE i.indrelid = $1::oid ORDER BY 1`;

// ===== Tool definitions =====

type Shape = Record<string, z.ZodType>;

export interface ToolAnnotations {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
}

export interface McpTool<S extends Shape = Shape> {
    name: string;
    title: string;
    description: string;
    inputSchema: S;
    annotations: ToolAnnotations;
    handler(args: z.output<z.ZodObject<S>>, services: McpServices): Promise<ToolResult>;
}

function defineTool<S extends Shape>(tool: McpTool<S>): McpTool {
    return tool as unknown as McpTool;
}

const connectionArg = z.string().optional()
    .describe('Name of a saved connection (see list_connections). The connection active in VS Code when omitted.');

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const targetShape = {
    connection: connectionArg,
    kind: z.enum(OBJECT_KINDS).describe('Kind of the object.'),
    schema: z.string().optional().describe('Schema of the object (for a trigger: of its table). When omitted, the object the search_path finds first.'),
    name: z.string().min(1).describe('Name of the object, unquoted.'),
    args: z.string().optional().describe('For a function, procedure or aggregate with overloads: its identity arguments, e.g. "integer, text".'),
    table: z.string().optional().describe('For a trigger: the table it belongs to.')
};

const mappingConditionShape = z.object({
    column: z.string(),
    operator: z.string().describe('One of =, !=, <>, >, <, >=, <=, LIKE, ILIKE.'),
    value: z.string()
});
const columnPairShape = z.object({ sourceColumn: z.string(), targetColumn: z.string() });

export const MCP_TOOLS: readonly McpTool[] = [
    defineTool({
        name: 'list_connections',
        title: 'List connections',
        description: 'Lists the saved PostgreSQL connections of the user: name, database, whether it is the active one, and what the user allows AI assistants to do with it. Call this first; every other tool takes the connection name.',
        inputSchema: {},
        annotations: READ_ONLY,
        async handler(_args, services) {
            const active = services.activeConnection();
            const saved = services.savedConnections();
            const describe = (c: ConnectionConfig) => ({
                name: c.name,
                database: c.database,
                active: active?.name === c.name,
                capabilities: aiCapabilities(c),
                askBeforeWrites: confirmsWrites(c)
            });
            const connections = saved.map(describe);
            if (active && !saved.some((c) => c.name === active.name)) connections.unshift(describe(active));
            return jsonResult({
                connections,
                note: 'Capabilities: metadata (structure), readData (queries), writeData (DML), ddl (schema changes). '
                    + 'Only the user can grant them, per connection, in the connection settings. '
                    + 'Bookmarked queries and custom column mappings are shared by all connections and need no capability.'
            });
        }
    }),
    defineTool({
        name: 'list_schemas',
        title: 'List schemas',
        description: 'Lists the schemas of the database with owner and comment. Needs the metadata capability.',
        inputSchema: {
            connection: connectionArg,
            includeSystem: z.boolean().optional().describe('Include pg_catalog, information_schema and the other pg_ schemas.')
        },
        annotations: READ_ONLY,
        async handler(args, services) {
            const connection = resolveConnection(services, args.connection);
            requireCapability(connection, 'metadata');
            const rows = await services.withClient(connection, async (client) =>
                (await client.query(SCHEMAS_QUERY, [args.includeSystem === true])).rows);
            return jsonResult(rows.map((r) => compact({ name: r.name, owner: r.owner, comment: r.comment })));
        }
    }),
    defineTool({
        name: 'list_objects',
        title: 'List database objects',
        description: 'Lists tables, views, materialized views, foreign tables, functions, procedures, aggregates, types, domains, sequences, triggers and extensions, optionally filtered by schema, kind and name. Needs the metadata capability.',
        inputSchema: {
            connection: connectionArg,
            schema: z.string().optional().describe('Only objects of this schema.'),
            kinds: z.array(z.enum(OBJECT_KINDS.filter((k) => k !== 'schema') as [ObjectKind, ...ObjectKind[]])).optional().describe('Only these kinds.'),
            name: z.string().optional().describe('Part of the name, or a pattern with * or % matching the whole name; case is ignored.'),
            includeExtensionObjects: z.boolean().optional().describe('Include the functions and types that extensions such as PostGIS bring along.'),
            limit: z.number().int().min(1).max(2000).optional().describe('At most this many objects (default 200).')
        },
        annotations: READ_ONLY,
        async handler(args, services) {
            const connection = resolveConnection(services, args.connection);
            requireCapability(connection, 'metadata');
            const kinds = new Set<ObjectKind>(args.kinds && args.kinds.length > 0 ? args.kinds : OBJECT_KINDS.filter((k) => k !== 'schema'));
            const schema = args.schema?.trim() || null;
            const matches = nameMatcher(args.name);
            const limit = args.limit ?? 200;
            const found: Array<Record<string, unknown>> = [];
            await services.withClient(connection, async (client) => {
                if ([...kinds].some((k) => RELATION_KINDS.has(k))) {
                    for (const r of (await client.query(RELATIONS_QUERY, [schema])).rows) {
                        const kind = RELATION_KIND_NAMES[String(r.relkind)];
                        if (!kind || !kinds.has(kind) || !matches(String(r.name))) continue;
                        found.push(compact({ kind, schema: r.schema_name, name: r.name, comment: r.comment }));
                    }
                }
                const objectKinds = new Set<ObjectKind>(['function', 'procedure', 'aggregate', 'type', 'domain', 'sequence', 'trigger', 'extension']);
                if ([...kinds].some((k) => objectKinds.has(k))) {
                    const version = await serverVersion(client);
                    const rows = (await client.query(buildObjectCatalogQuery(version, schema !== null), schema !== null ? [[schema]] : undefined)).rows;
                    for (const object of rows.map(toDbObject).filter((o): o is DbObject => o !== null)) {
                        if (!kinds.has(object.kind) || !matches(object.name)) continue;
                        if (object.fromExtension && args.includeExtensionObjects !== true) continue;
                        found.push(compact({
                            kind: object.kind,
                            schema: object.schema,
                            name: object.name,
                            args: object.kind === 'function' || object.kind === 'procedure' || object.kind === 'aggregate' ? object.args ?? '' : undefined,
                            table: object.kind === 'trigger' && object.relName ? `${object.relSchema ?? object.schema}.${object.relName}` : undefined,
                            detail: object.detail,
                            comment: object.comment
                        }));
                    }
                }
            });
            const shown = found.slice(0, limit);
            const body: Record<string, unknown> = { count: found.length, objects: shown };
            if (found.length > shown.length) body.note = `Only the first ${limit} of ${found.length} objects are shown; filter by schema, kind or name.`;
            return jsonResult(body);
        }
    }),
    defineTool({
        name: 'describe_table',
        title: 'Describe a table',
        description: 'Describes a table, view, materialized view or foreign table: columns with type, nullability, default and comment, primary key, unique and check constraints, foreign keys in both directions, indexes, comment and, for a view, its query. Needs the metadata capability.',
        inputSchema: {
            connection: connectionArg,
            schema: z.string().optional().describe('Schema of the table. When omitted, the table the search_path finds first.'),
            table: z.string().min(1).describe('Name of the table, unquoted.')
        },
        annotations: READ_ONLY,
        async handler(args, services) {
            const connection = resolveConnection(services, args.connection);
            requireCapability(connection, 'metadata');
            const schema = args.schema?.trim() || null;
            return services.withClient(connection, async (client) => {
                let candidates = (await client.query(RELATION_QUERY, [args.table, schema])).rows;
                if (candidates.length === 0) throw new ToolError(`There is no table or view ${schema ? `${schema}.` : ''}${args.table}.`);
                if (candidates.length > 1 && candidates[0].path_pos !== null && candidates[0].path_pos !== undefined) {
                    candidates = candidates.filter((r) => String(r.path_pos) === String(candidates[0].path_pos));
                }
                if (candidates.length > 1) {
                    throw new ToolError(`${args.table} exists in several schemas: ${candidates.map((r) => String(r.schema_name)).join(', ')}. Pass "schema".`);
                }
                const rel = candidates[0];
                const oid = String(rel.oid);
                const version = await serverVersion(client);
                const columns = (await client.query(columnsQuery(version), [oid])).rows.map((c) => compact({
                    name: c.name,
                    type: c.type,
                    nullable: c.not_null !== true,
                    default: c.default_value,
                    identity: c.identity === 'a' ? 'always' : c.identity === 'd' ? 'by default' : undefined,
                    generated: c.generated === 's' ? 'stored' : undefined,
                    comment: c.comment
                }));
                const constraints = (await client.query(CONSTRAINTS_QUERY, [oid])).rows;
                const ofType = (type: string) => constraints.filter((c) => c.type === type).map((c) => ({ name: c.name, definition: c.definition }));
                const relkind = String(rel.relkind);
                const viewDefinition = relkind === 'v' || relkind === 'm'
                    ? (await client.query('SELECT pg_catalog.pg_get_viewdef($1::oid, true) AS def', [oid])).rows[0]?.def
                    : undefined;
                return jsonResult(compact({
                    schema: rel.schema_name,
                    name: rel.name,
                    kind: RELATION_KIND_NAMES[relkind] ?? relkind,
                    comment: rel.comment,
                    estimatedRows: Number(rel.estimated_rows) >= 0 ? Number(rel.estimated_rows) : undefined,
                    columns,
                    primaryKey: ofType('p')[0],
                    unique: ofType('u'),
                    checks: ofType('c'),
                    exclusions: ofType('x'),
                    foreignKeys: ofType('f'),
                    referencedBy: (await client.query(REFERENCED_BY_QUERY, [oid])).rows.map((r) => ({ name: r.name, fromTable: r.from_table, definition: r.definition })),
                    indexes: (await client.query(INDEXES_QUERY, [oid])).rows.map((r) => ({ name: r.name, definition: r.definition })),
                    viewDefinition
                }));
            });
        }
    }),
    defineTool({
        name: 'get_ddl',
        title: 'Get the CREATE script',
        description: 'Returns the CREATE script of a database object as the extension\'s "Open CREATE Script" writes it (with comments, owner and grants as the user configured). Needs the metadata capability.',
        inputSchema: targetShape,
        annotations: READ_ONLY,
        async handler(args, services) {
            const connection = resolveConnection(services, args.connection);
            requireCapability(connection, 'metadata');
            return services.withClient(connection, async (client) => {
                const target = await resolveTarget(client, args);
                const version = await serverVersion(client);
                const script = await withQualifiedNames(client, (query) =>
                    fetchCreateScript({ query, options: services.ddlOptions(), serverVersion: version }, target));
                return textResult(script);
            });
        }
    }),
    defineTool({
        name: 'get_dependencies',
        title: 'Get dependencies',
        description: 'Lists what uses a database object and what it uses, as PostgreSQL records it in pg_depend (views, functions with SQL bodies, foreign keys, triggers, defaults, types). Calls inside PL/pgSQL bodies are not recorded by PostgreSQL. Needs the metadata capability.',
        inputSchema: {
            ...targetShape,
            direction: z.enum(['usedBy', 'uses', 'both']).optional().describe('Which direction (default both).')
        },
        annotations: READ_ONLY,
        async handler(args, services) {
            const connection = resolveConnection(services, args.connection);
            requireCapability(connection, 'metadata');
            const direction = args.direction ?? 'both';
            return services.withClient(connection, async (client) => {
                const target = await resolveTarget(client, args);
                const classid = `pg_catalog.${KIND_CLASS[target.kind]}`;
                const read = async (sql: string) => (await client.query(sql, [classid, target.oid])).rows
                    .map(toDependencyRow)
                    .map((row) => compact({ type: row.type, identity: row.identity }));
                const body: Record<string, unknown> = { object: describeTarget(target) };
                if (direction !== 'uses') body.usedBy = await read(USED_BY_QUERY);
                if (direction !== 'usedBy') body.uses = await read(USES_QUERY);
                return jsonResult(body);
            });
        }
    }),
    defineTool({
        name: 'explain_query',
        title: 'Explain a query',
        description: 'Shows the query plan of one statement (EXPLAIN, text format). With analyze the statement really runs, inside a transaction that is rolled back; that needs the readData capability, and for INSERT, UPDATE, DELETE or MERGE also writeData. Needs the metadata capability.',
        inputSchema: {
            connection: connectionArg,
            sql: z.string().min(1).describe('The statement, without EXPLAIN.'),
            analyze: z.boolean().optional().describe('EXPLAIN ANALYZE: run the statement and show real times and row counts.'),
            buffers: z.boolean().optional().describe('Add buffer usage (with analyze).'),
            verbose: z.boolean().optional().describe('Add output columns and schema-qualified names.')
        },
        annotations: { ...READ_ONLY, idempotentHint: false },
        async handler(args, services) {
            const connection = resolveConnection(services, args.connection);
            requireCapability(connection, 'metadata');
            const statements = classifySql(args.sql);
            if (statements.length !== 1) throw new ToolError(`Pass exactly one statement; the SQL has ${statements.length}.`);
            const { sql: statement, kind } = statements[0];
            if (kind === 'explain') throw new ToolError('Pass the statement without EXPLAIN; use analyze, buffers and verbose for the options.');
            if (kind !== 'read' && kind !== 'dml' && kind !== 'ddl') {
                throw new ToolError('EXPLAIN works on SELECT, INSERT, UPDATE, DELETE, MERGE, VALUES and CREATE TABLE AS.');
            }
            const analyze = args.analyze === true;
            const writes = kind !== 'read';
            if (analyze) {
                requireCapability(connection, 'readData');
                if (writes) {
                    requireCapability(connection, 'writeData');
                    if (kind === 'ddl') requireCapability(connection, 'ddl');
                    await confirmStatements(services, connection, statements,
                        (summary) => `An AI assistant wants to run EXPLAIN ANALYZE of ${summary} on "${connection.config.name}". The statement runs and is then rolled back.`,
                        'Run');
                }
            }
            const options = ['FORMAT TEXT'];
            if (analyze) options.unshift('ANALYZE');
            if (args.buffers === true) options.push('BUFFERS');
            if (args.verbose === true) options.push('VERBOSE');
            const plan = await services.withClient(connection, (client) =>
                inTransaction(client, analyze && writes ? 'BEGIN' : 'BEGIN READ ONLY', async () =>
                    (await client.runStatement(`EXPLAIN (${options.join(', ')}) ${statement}\n`)).rows.map((r) => String(r[0])).join('\n')));
            return textResult(analyze ? `${plan}\n\n(The statement ran inside a transaction that was rolled back.)` : plan);
        }
    }),
    defineTool({
        name: 'run_query',
        title: 'Run a query',
        description: 'Runs one SELECT, WITH, VALUES, TABLE or SHOW statement in a read-only transaction that is rolled back, and returns the columns and rows as JSON. At most the configured number of rows is returned (postgresQueryBuilder.mcp.maxRows); a note tells when there are more. Needs the readData capability.',
        inputSchema: {
            connection: connectionArg,
            sql: z.string().min(1).describe('One query. Placeholders are not supported; write the values into the SQL.'),
            maxRows: z.number().int().min(1).optional().describe('Return at most this many rows (never more than the user\'s limit).')
        },
        annotations: READ_ONLY,
        async handler(args, services) {
            const connection = resolveConnection(services, args.connection);
            requireCapability(connection, 'readData');
            const statement = singleQuery(args.sql, 'run_query');
            const limit = rowLimit(services, args.maxRows);
            const result = await services.withClient(connection, (client) => runReadOnly(client, statement, limit));
            return readResultJson(result, limit);
        }
    }),
    defineTool({
        name: 'execute_sql',
        title: 'Execute SQL',
        description: 'Executes SQL that changes the database: INSERT, UPDATE, DELETE, MERGE (needs writeData) and CREATE, ALTER, DROP, TRUNCATE, GRANT, REVOKE, COMMENT (needs ddl); CALL and DO need both. All statements run in one transaction that is committed when every statement succeeded and rolled back otherwise; leave out BEGIN and COMMIT. Unless the user turned it off for the connection, the user is asked to confirm first. Returns the affected row count of every statement.',
        inputSchema: {
            connection: connectionArg,
            sql: z.string().min(1).describe('One or more statements separated by semicolons.')
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        async handler(args, services) {
            const connection = resolveConnection(services, args.connection);
            const statements = classifySql(args.sql);
            if (statements.length === 0) throw new ToolError('The SQL is empty.');
            statements.forEach((s, i) => {
                const where = `Statement ${i + 1} (${statementPreview(s.sql)})`;
                if (s.kind === 'transaction') throw new ToolError(`${where}: execute_sql runs all statements in one transaction of its own; leave out BEGIN, COMMIT, ROLLBACK and SAVEPOINT.`);
                if (s.kind === 'explain') throw new ToolError(`${where}: use explain_query for query plans.`);
                if (s.kind === 'unsupported') throw new ToolError(`${where} is not supported by execute_sql. It runs INSERT, UPDATE, DELETE, MERGE, CREATE, ALTER, DROP, TRUNCATE, GRANT, REVOKE, COMMENT, CALL, DO, SET and queries.`);
            });
            if (statements.every((s) => s.kind === 'session')) throw new ToolError('Only SET and RESET statements: nothing to execute.');
            for (const capability of requiredCapabilities(statements.map((s) => s.kind))) requireCapability(connection, capability);
            await confirmStatements(services, connection, statements,
                (summary) => `An AI assistant wants to run ${summary} on "${connection.config.name}" (database ${connection.config.database}).`,
                'Run');
            const returnedRows = Math.min(rowLimit(services, undefined), 100);
            const results = await services.withClient(connection, async (client) => {
                await client.query('BEGIN');
                const done: Array<Record<string, unknown>> = [];
                for (let i = 0; i < statements.length; i++) {
                    let result: McpStatementResult;
                    try {
                        result = await client.runStatement(statements[i].sql);
                    } catch (err: unknown) {
                        await client.query('ROLLBACK').catch((e: unknown) => Logger.error('Mcp.executeSql', e));
                        throw new ToolError(`Statement ${i + 1} (${statementPreview(statements[i].sql)}) failed: ${getErrorMessage(err)}. Everything was rolled back.`);
                    }
                    const entry: Record<string, unknown> = { statement: i + 1, command: result.command, rowCount: result.rowCount };
                    if (result.fields.length > 0 && result.rows.length > 0) {
                        entry.columns = result.fields;
                        entry.rows = result.rows.slice(0, returnedRows).map((row) => row.map(toJsonValue));
                        if (result.rows.length > returnedRows) entry.note = `Only the first ${returnedRows} returned rows are shown.`;
                    }
                    done.push(entry);
                }
                try {
                    await client.query('COMMIT');
                } catch (err: unknown) {
                    throw new ToolError(`COMMIT failed: ${getErrorMessage(err)}. Nothing was changed.`);
                }
                return done;
            });
            Logger.log('mcp', `execute_sql committed ${statements.length} statement(s) on "${connection.config.name}"`);
            return jsonResult({ committed: true, statements: results });
        }
    }),
    defineTool({
        name: 'open_in_data_viewer',
        title: 'Open in the Data Viewer',
        description: 'Opens a query in the Data Viewer of VS Code, where the user can browse, filter, edit and export the result. The Data Viewer runs the query again in the user\'s own session, so the query is first run once in a read-only transaction that is rolled back; a query that writes (a function that changes data, setval, …) or takes row locks (FOR UPDATE, FOR SHARE) is refused — use execute_sql for those. Works on the active connection only. Needs the readData capability.',
        inputSchema: {
            connection: connectionArg,
            sql: z.string().min(1).describe('One SELECT, WITH, VALUES or TABLE query.'),
            title: z.string().optional().describe('Short title of the tab.')
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        async handler(args, services) {
            const connection = resolveConnection(services, args.connection);
            requireCapability(connection, 'readData');
            if (!connection.active) {
                const active = services.activeConnection();
                throw new ToolError(`The Data Viewer shows the connection active in VS Code${active ? ` ("${active.name}")` : ''} only. `
                    + `Ask the user to switch to "${connection.config.name}" with "Select Connection", or use run_query with that connection.`);
            }
            const statement = singleQuery(args.sql, 'open_in_data_viewer');
            if (firstKeyword(statement) === 'show') throw new ToolError('The Data Viewer shows SELECT, WITH, VALUES and TABLE queries; use run_query for SHOW.');
            if (LOCKING_CLAUSE.test(codeMask(statement).toLowerCase())) {
                throw new ToolError('The Data Viewer would hold the row locks of FOR UPDATE, FOR NO KEY UPDATE, FOR SHARE or FOR KEY SHARE in the user\'s session. Leave the locking clause out, or use run_query.');
            }
            // The viewer runs the query again in the user's own session, which may write; only a query that runs read-only is opened.
            try {
                await services.withClient(connection, (client) => runReadOnly(client, statement, rowLimit(services, undefined)));
            } catch (err: unknown) {
                const message = getErrorMessage(err);
                if (/read-only transaction/i.test(message)) {
                    throw new ToolError(`The query changes the database (${message}), and the Data Viewer would run it in the user's own session. `
                        + 'open_in_data_viewer only opens queries that read. Use execute_sql for it, which needs the writeData capability and the user\'s confirmation.');
                }
                throw new ToolError(`The query failed, so it was not opened: ${message}`);
            }
            const oneLine = statement.replace(/\s+/g, ' ').trim();
            const title = args.title?.trim() || `View Data: ${oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine}`;
            await services.openInDataViewer(statement, title);
            return textResult(`Opened the query in the Data Viewer of "${connection.config.name}".`);
        }
    }),
    defineTool({
        name: 'format_sql',
        title: 'Format SQL',
        description: 'Formats SQL and PL/pgSQL with the extension\'s formatter and the user\'s formatter settings (including a .pgformat.json of the workspace). Needs no connection.',
        inputSchema: {
            sql: z.string().min(1).describe('The SQL to format.')
        },
        annotations: { ...READ_ONLY },
        async handler(args, services) {
            const result = formatSqlChecked(args.sql, services.formatOptions());
            const notes: string[] = [];
            if (!result.ok) notes.push(`-- The formatter left the SQL unchanged: ${result.reason ?? 'formatting would have changed its meaning'}.`);
            for (const warning of result.checkWarnings ?? []) notes.push(`-- Check: ${warning}`);
            return textResult(notes.length > 0 ? `${notes.join('\n')}\n${result.text}` : result.text);
        }
    }),
    defineTool({
        name: 'plpgsql_check',
        title: 'Check PL/pgSQL with plpgsql_check',
        description: 'Checks the functions and procedures that SQL text or a SQL file of the workspace creates with the plpgsql_check extension of the database. They are created, checked and rolled back; nothing is kept. Returns the findings with line numbers. Needs the metadata capability and the plpgsql_check extension in the database.',
        inputSchema: {
            connection: connectionArg,
            sql: z.string().optional().describe('SQL text with CREATE FUNCTION or CREATE PROCEDURE statements.'),
            path: z.string().optional().describe('Instead of sql: a SQL file of the workspace, relative to the workspace folder or absolute.')
        },
        annotations: { ...READ_ONLY, idempotentHint: true },
        async handler(args, services) {
            const connection = resolveConnection(services, args.connection);
            requireCapability(connection, 'metadata');
            if ((args.sql === undefined) === (args.path === undefined)) throw new ToolError('Pass either sql or path.');
            const text = args.path !== undefined ? await services.readWorkspaceFile(args.path) : args.sql ?? '';
            if (checkTargets(text).length === 0) {
                return textResult('The SQL creates no PL/pgSQL function or procedure, so there is nothing for plpgsql_check to check.');
            }
            const findings = await services.withClient(connection, (client) => services.plpgsqlCheck(client, text));
            if (findings.length === 0) return textResult('plpgsql_check found no problems.');
            return jsonResult(findings.map((f) => compact({
                severity: f.severity,
                line: f.start.line + 1,
                column: f.start.character + 1,
                message: f.message,
                code: f.code
            })));
        }
    }),
    defineTool({
        name: 'compare_repository',
        title: 'Compare repository with database',
        description: 'Runs "Compare Repository with Database": compares the CREATE statements in the SQL files of the workspace with the active connection\'s database and reports what differs, what exists only in the database and what only in the repository. Works on the active connection only. Needs the metadata capability.',
        inputSchema: {
            connection: connectionArg
        },
        annotations: { ...READ_ONLY, idempotentHint: false },
        async handler(args, services) {
            const connection = resolveConnection(services, args.connection);
            requireCapability(connection, 'metadata');
            if (!connection.active) throw new ToolError('The comparison works on the connection active in VS Code only; ask the user to switch to it with "Select Connection".');
            return textResult(await services.compareRepository());
        }
    }),
    defineTool({
        name: 'list_saved_queries',
        title: 'List bookmarked queries',
        description: 'Lists the bookmarked queries of the user with their :name placeholders and tags. A placeholder shows its kind (text, number, date, timestamp, identifier, raw) and its default: a value, or defaultNull: true when it is NULL unless a value is given. Bookmarked queries belong to no connection, so no capability is needed.',
        inputSchema: {
            name: z.string().optional().describe('Part of the name, or a pattern with * or %.'),
            tag: z.string().optional().describe('Only queries with this tag.')
        },
        annotations: READ_ONLY,
        async handler(args, services) {
            const matches = nameMatcher(args.name);
            const tag = args.tag?.trim().toLowerCase();
            const queries = services.savedQueries.list()
                .filter((q) => matches(q.name) && (!tag || (q.tags ?? []).some((t) => t.toLowerCase() === tag)))
                .map((q) => compact({
                    id: q.id,
                    name: q.name,
                    sql: truncateText(q.sql, 4000),
                    parameters: q.parameters.map((p) => compact({ name: p.name, kind: p.kind, default: p.defaultValue, defaultNull: p.defaultNull })),
                    tags: q.tags,
                    scope: q.scope === 'workspace' ? 'workspace' : 'personal'
                }));
            return jsonResult(queries);
        }
    }),
    defineTool({
        name: 'run_saved_query',
        title: 'Run a bookmarked query',
        description: 'Runs a bookmarked query like run_query, after filling in its :name placeholders. A value null makes the placeholder NULL (not allowed for an identifier); a missing value uses the default. A date or timestamp is written as YYYY-MM-DD or YYYY-MM-DD HH:MM[:SS] (24-hour). Needs the readData capability of the connection it runs on.',
        inputSchema: {
            connection: connectionArg,
            id: z.string().optional().describe('Id of the query (see list_saved_queries).'),
            name: z.string().optional().describe('Instead of id: the exact name of the query.'),
            values: z.record(z.string(), z.string().nullable()).optional().describe('Values of the placeholders, by name; null for NULL.'),
            maxRows: z.number().int().min(1).optional().describe('Return at most this many rows (never more than the user\'s limit).')
        },
        annotations: READ_ONLY,
        async handler(args, services) {
            const connection = resolveConnection(services, args.connection);
            requireCapability(connection, 'readData');
            const all = services.savedQueries.list();
            let query: SavedQuery | undefined;
            if (args.id) {
                query = all.find((q) => q.id === args.id);
            } else if (args.name) {
                const named = all.filter((q) => q.name.toLowerCase() === args.name!.trim().toLowerCase());
                if (named.length > 1) throw new ToolError(`Several bookmarked queries are named "${args.name}"; pass the id.`);
                query = named[0];
            } else {
                throw new ToolError('Pass the id or the name of the bookmarked query.');
            }
            if (!query) throw new ToolError('No such bookmarked query; see list_saved_queries.');
            let sql: string;
            try {
                sql = applyQueryParameters(query.sql, args.values ?? {}, query.parameters);
            } catch (err: unknown) {
                const names = query.parameters.map((p) => p.name).join(', ');
                throw new ToolError(`${getErrorMessage(err)} The query takes: ${names || 'no placeholders'}.`);
            }
            const statement = singleQuery(sql, 'run_saved_query');
            const limit = rowLimit(services, args.maxRows);
            const result = await services.withClient(connection, (client) => runReadOnly(client, statement, limit));
            return readResultJson(result, limit);
        }
    }),
    defineTool({
        name: 'create_saved_query',
        title: 'Bookmark a query',
        description: 'Adds a bookmarked query, which the user then finds in the Bookmarked Queries view. Write :name placeholders for values asked for on every run. Bookmarked queries belong to no connection, so no capability is needed.',
        inputSchema: {
            name: z.string().min(1).describe('Name shown in the Bookmarked Queries view.'),
            sql: z.string().min(1).describe('The query, with optional :name placeholders.'),
            tags: z.array(z.string()).optional().describe('Tags; a / nests them, e.g. "Reports/Monthly".'),
            scope: z.enum(['personal', 'workspace']).optional().describe('personal (default) or workspace, which is shared through a file in the repository.')
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        async handler(args, services) {
            const saved = await services.savedQueries.add(
                { name: args.name.trim(), sql: args.sql, parameters: mergeParameters(args.sql, []), tags: args.tags },
                args.scope === 'workspace' ? 'workspace' : 'global'
            );
            return jsonResult({ id: saved.id, name: saved.name, parameters: saved.parameters.map((p) => p.name) });
        }
    }),
    defineTool({
        name: 'list_mappings',
        title: 'List custom column mappings',
        description: 'Lists the custom column mappings of the Data Viewer: which column refers to which column of another table, for navigation where no foreign key exists. Mappings belong to no connection, so no capability is needed.',
        inputSchema: {
            schema: z.string().optional().describe('Only mappings from or to tables of this schema.'),
            table: z.string().optional().describe('Only mappings from or to this table.')
        },
        annotations: READ_ONLY,
        async handler(args, services) {
            const fits = (schema: string, table: string) => (!args.schema || schema === args.schema) && (!args.table || table === args.table);
            const mappings = services.mappings.list()
                .filter((m) => fits(m.sourceSchema, m.sourceTable) || fits(m.targetSchema, m.targetTable))
                .map((m) => compact({
                    id: m.id,
                    label: m.label,
                    source: `${m.sourceSchema}.${m.sourceTable}.${m.sourceColumn}`,
                    target: `${m.targetSchema}.${m.targetTable}.${m.targetColumn}`,
                    additionalColumnPairs: m.additionalColumnPairs,
                    conditions: m.conditions,
                    isDefault: m.isDefault || undefined,
                    scope: m.scope === 'workspace' ? 'workspace' : 'personal'
                }));
            return jsonResult(mappings);
        }
    }),
    defineTool({
        name: 'create_mapping',
        title: 'Create a custom column mapping',
        description: 'Adds a custom column mapping: the source column refers to the target column, so the Data Viewer can navigate from a row to the rows it refers to. Mappings belong to no connection, so no capability is needed.',
        inputSchema: {
            sourceSchema: z.string().min(1),
            sourceTable: z.string().min(1),
            sourceColumn: z.string().min(1),
            targetSchema: z.string().min(1),
            targetTable: z.string().min(1),
            targetColumn: z.string().min(1),
            label: z.string().optional().describe('Name shown when navigating.'),
            isDefault: z.boolean().optional().describe('Use this mapping when the column has several.'),
            conditions: z.array(mappingConditionShape).optional().describe('Apply the mapping only to source rows meeting all of these.'),
            additionalColumnPairs: z.array(columnPairShape).optional().describe('More column pairs for a composite key.'),
            scope: z.enum(['personal', 'workspace']).optional().describe('personal (default) or workspace, which is shared through a file in the repository.')
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        async handler(args, services) {
            const description = `${args.sourceSchema}.${args.sourceTable}.${args.sourceColumn} → ${args.targetSchema}.${args.targetTable}.${args.targetColumn}`;
            const mapping: Omit<CustomColumnMapping, 'id'> = {
                sourceSchema: args.sourceSchema, sourceTable: args.sourceTable, sourceColumn: args.sourceColumn,
                targetSchema: args.targetSchema, targetTable: args.targetTable, targetColumn: args.targetColumn,
                conditions: normalizeMappingConditions(args.conditions ?? []),
                isDefault: args.isDefault === true
            };
            if (args.label?.trim()) mapping.label = args.label.trim();
            const pairs = normalizeColumnPairs(args.additionalColumnPairs ?? []);
            if (pairs.length > 0) mapping.additionalColumnPairs = pairs;
            const created = await services.mappings.add(mapping, args.scope === 'workspace' ? 'workspace' : 'global');
            return jsonResult({ id: created.id, mapping: description });
        }
    }),
    defineTool({
        name: 'update_mapping',
        title: 'Update a custom column mapping',
        description: 'Changes a custom column mapping; fields left out stay as they are. Mappings belong to no connection, so no capability is needed.',
        inputSchema: {
            id: z.string().min(1).describe('Id of the mapping (see list_mappings).'),
            sourceSchema: z.string().min(1).optional(),
            sourceTable: z.string().min(1).optional(),
            sourceColumn: z.string().min(1).optional(),
            targetSchema: z.string().min(1).optional(),
            targetTable: z.string().min(1).optional(),
            targetColumn: z.string().min(1).optional(),
            label: z.string().optional(),
            isDefault: z.boolean().optional(),
            conditions: z.array(mappingConditionShape).optional(),
            additionalColumnPairs: z.array(columnPairShape).optional()
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        async handler(args, services) {
            const existing = services.mappings.list().find((m) => m.id === args.id);
            if (!existing) throw new ToolError(`No custom column mapping has the id "${args.id}"; see list_mappings.`);
            const patch: Partial<Omit<CustomColumnMapping, 'id'>> = {};
            for (const key of ['sourceSchema', 'sourceTable', 'sourceColumn', 'targetSchema', 'targetTable', 'targetColumn', 'label', 'isDefault'] as const) {
                if (args[key] !== undefined) (patch as Record<string, unknown>)[key] = args[key];
            }
            if (args.conditions !== undefined) patch.conditions = normalizeMappingConditions(args.conditions);
            if (args.additionalColumnPairs !== undefined) patch.additionalColumnPairs = normalizeColumnPairs(args.additionalColumnPairs);
            if (Object.keys(patch).length === 0) throw new ToolError('Pass at least one field to change.');
            await services.mappings.update(args.id, patch);
            return textResult(`Updated the custom column mapping ${args.id}.`);
        }
    }),
    defineTool({
        name: 'delete_mapping',
        title: 'Delete a custom column mapping',
        description: 'Deletes a custom column mapping. Mappings belong to no connection, so no capability is needed.',
        inputSchema: {
            id: z.string().min(1).describe('Id of the mapping (see list_mappings).')
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        async handler(args, services) {
            const existing = services.mappings.list().find((m) => m.id === args.id);
            if (!existing) throw new ToolError(`No custom column mapping has the id "${args.id}"; see list_mappings.`);
            await services.mappings.remove(args.id);
            return textResult(`Deleted the custom column mapping ${args.id}.`);
        }
    })
];

/** Validate the arguments, run the tool and turn every failure into an error result. */
export async function callTool(tool: McpTool, rawArgs: unknown, services: McpServices): Promise<ToolResult> {
    const parsed = z.object(tool.inputSchema).safeParse(rawArgs ?? {});
    if (!parsed.success) return errorResult(`Invalid arguments for ${tool.name}: ${z.prettifyError(parsed.error)}`);
    try {
        const result = await tool.handler(parsed.data, services);
        Logger.log('mcp', `${tool.name}: ${result.isError ? 'failed' : 'done'}`);
        return result;
    } catch (err: unknown) {
        if (err instanceof ToolError) {
            Logger.log('mcp', `${tool.name}: ${err.message}`);
            return errorResult(err.message);
        }
        Logger.error(`Mcp.${tool.name}`, err);
        return errorResult(`${tool.name} failed: ${getErrorMessage(err)}`);
    }
}
