/**
 * CREATE and DROP scripts of database objects, read from the catalog.
 *
 * The fetchers run parameterised catalog queries (`$1` is always an oid); the
 * builders that turn the rows into SQL are pure and exported, so they are
 * tested without a database. A DROP statement is built from what the tree
 * already knows and needs no query at all. Nothing here ever executes the DDL
 * it generates.
 */
import { escapeSqlLiteral } from './sqlUtils';
import { POSTGRES_RESERVED_KEYWORDS } from './reservedKeywords';

export type DdlKind =
    | 'function' | 'procedure' | 'aggregate'
    | 'type' | 'domain' | 'sequence' | 'trigger' | 'extension' | 'schema'
    | 'table' | 'view' | 'matview' | 'foreign';

export interface DdlTarget {
    kind: DdlKind;
    /** Schema of the object; for a trigger the schema of its table; for a schema the schema itself. */
    schema: string;
    name: string;
    /** Identity arguments of a routine as `pg_get_function_identity_arguments` writes them. */
    args?: string | null;
    /** The table of a trigger. */
    table?: string;
    /** Catalog oid; looked up by name when missing. */
    oid?: number;
}

export interface DdlOptions {
    includeComments: boolean;
    includeOwner: boolean;
    includeGrants: boolean;
}

type Row = Record<string, unknown>;

/** Runs one parameterised catalog query. */
export type DdlQuery = (sql: string, params: unknown[]) => Promise<Row[]>;

export interface DdlContext {
    query: DdlQuery;
    options: DdlOptions;
    /** `server_version_num` of the server, e.g. 160002. */
    serverVersion: number;
}

export const SERVER_VERSION_QUERY = `SELECT current_setting('server_version_num')::int AS server_version_num`;

/** The part of a database client the DDL needs. */
export interface CatalogClient {
    query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

/**
 * Run the catalog queries of a script the way pg_dump does: in a read-only
 * transaction with an empty search_path. PostgreSQL then writes every name
 * outside `pg_catalog` with its schema — in function definitions, types,
 * defaults, view and trigger definitions — so the script does not depend on
 * the search_path of the session it was read with.
 */
export async function withQualifiedNames<T>(client: CatalogClient, run: (query: DdlQuery) => Promise<T>): Promise<T> {
    await client.query('BEGIN READ ONLY');
    try {
        await client.query(`SELECT pg_catalog.set_config('search_path', '', true)`);
        return await run(async (sql, params) => (await client.query(sql, params)).rows);
    } finally {
        await client.query('ROLLBACK');
    }
}

// ===== Names ==================================================================

/** Quote an identifier when PostgreSQL needs it quoted: upper case, special characters or a reserved word. */
export function quoteIdentifier(name: string): string {
    return /^[a-z_][a-z0-9_$]*$/.test(name) && !POSTGRES_RESERVED_KEYWORDS.has(name)
        ? name
        : `"${name.replace(/"/g, '""')}"`;
}

export function qualifiedName(schema: string, name: string): string {
    return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

const SQL_KIND: Record<DdlKind, string> = {
    function: 'FUNCTION',
    procedure: 'PROCEDURE',
    aggregate: 'AGGREGATE',
    type: 'TYPE',
    domain: 'DOMAIN',
    sequence: 'SEQUENCE',
    trigger: 'TRIGGER',
    extension: 'EXTENSION',
    schema: 'SCHEMA',
    table: 'TABLE',
    view: 'VIEW',
    matview: 'MATERIALIZED VIEW',
    foreign: 'FOREIGN TABLE'
};

/** Object types `GRANT … ON <type>` is written with. */
const GRANT_KIND: Partial<Record<DdlKind, string>> = {
    function: 'FUNCTION',
    procedure: 'PROCEDURE',
    aggregate: 'FUNCTION',
    type: 'TYPE',
    domain: 'DOMAIN',
    sequence: 'SEQUENCE',
    schema: 'SCHEMA',
    table: 'TABLE',
    view: 'TABLE',
    matview: 'TABLE',
    foreign: 'TABLE'
};

/** Privileges PUBLIC holds on a new object of these kinds without any GRANT. */
const PUBLIC_DEFAULTS: Partial<Record<DdlKind, string>> = {
    function: 'EXECUTE',
    procedure: 'EXECUTE',
    aggregate: 'EXECUTE',
    type: 'USAGE',
    domain: 'USAGE'
};

const ROUTINES = new Set<DdlKind>(['function', 'procedure', 'aggregate']);

/** How the object is named in DROP, COMMENT ON and ALTER … OWNER TO, after its kind keyword. */
export function objectReference(target: DdlTarget): string {
    if (target.kind === 'schema' || target.kind === 'extension') return quoteIdentifier(target.name);
    if (target.kind === 'trigger') return `${quoteIdentifier(target.name)} ON ${qualifiedName(target.schema, target.table ?? '')}`;
    const name = qualifiedName(target.schema, target.name);
    if (!ROUTINES.has(target.kind)) return name;
    const args = target.args ?? '';
    // An aggregate without arguments is written aggregate(*).
    return `${name}(${target.kind === 'aggregate' && args.trim() === '' ? '*' : args})`;
}

/** `DROP <kind> IF EXISTS <object>;` — only generated, never executed. */
export function buildDropStatement(target: DdlTarget): string {
    return `DROP ${SQL_KIND[target.kind]} IF EXISTS ${objectReference(target)};`;
}

/**
 * One script of several statements: CREATE scripts in the given order,
 * separated by a blank line. `ALTER SEQUENCE … OWNED BY` moves to the end, as
 * in pg_dump: the table of a serial column needs its sequence first, and the
 * sequence can only be owned by the table once the table exists.
 */
export function combineScripts(parts: readonly string[]): string {
    const ownedBy: string[] = [];
    const isOwnedBy = (line: string): boolean => /^ALTER SEQUENCE .+ OWNED BY .+;$/.test(line);
    const bodies = parts.map(p => {
        const lines = p.trimEnd().split('\n');
        if (parts.length > 1) ownedBy.push(...lines.filter(isOwnedBy));
        return (parts.length > 1 ? lines.filter(l => !isOwnedBy(l)) : lines).join('\n').trimEnd();
    }).filter(p => p.length > 0);
    if (ownedBy.length > 0) bodies.push(ownedBy.join('\n'));
    return bodies.join('\n\n') + '\n';
}

// ===== Options, comments, owner and privileges ================================

/** `fillfactor=70, security_barrier=true` from a `reloptions` array. */
export function formatStorageOptions(options: readonly string[]): string {
    return options.map(opt => {
        const eq = opt.indexOf('=');
        if (eq < 0) return opt;
        const key = opt.slice(0, eq);
        const value = opt.slice(eq + 1);
        return `${key}=${/^[A-Za-z0-9_.-]+$/.test(value) ? value : escapeSqlLiteral(value)}`;
    }).join(', ');
}

/** `schema_name 'public', table_name 'orders'` from the options of a foreign table or column. */
export function formatFdwOptions(options: readonly string[]): string {
    return options.map(opt => {
        const eq = opt.indexOf('=');
        const key = eq < 0 ? opt : opt.slice(0, eq);
        const value = eq < 0 ? '' : opt.slice(eq + 1);
        return `${quoteIdentifier(key)} ${escapeSqlLiteral(value)}`;
    }).join(', ');
}

export interface AclEntry {
    /** Role name, or `PUBLIC`. */
    grantee: string;
    privilege: string;
    grantable: boolean;
}

const PRIVILEGE_ORDER = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN', 'USAGE', 'CREATE', 'EXECUTE', 'CONNECT', 'TEMPORARY'];

function roleName(role: string): string {
    return role === 'PUBLIC' ? 'PUBLIC' : quoteIdentifier(role);
}

/**
 * The GRANT statements that give the object its privileges. `acl` is null
 * when the object still has its built-in default privileges: then nothing has
 * to be granted. The owner's own privileges come with the ownership and are
 * not repeated; PUBLIC's default privilege on functions and types is revoked
 * first when the object no longer grants it.
 */
export function buildGrantStatements(kind: DdlKind, reference: string, owner: string | null, acl: readonly AclEntry[] | null): string[] {
    const grantKind = GRANT_KIND[kind];
    if (!grantKind || acl === null) return [];
    const on = `${grantKind} ${reference}`;
    const lines: string[] = [];
    const publicDefault = PUBLIC_DEFAULTS[kind];
    const publicKeepsDefault = publicDefault !== undefined
        && acl.some(e => e.grantee === 'PUBLIC' && e.privilege === publicDefault);
    if (publicDefault !== undefined && !publicKeepsDefault) {
        lines.push(`REVOKE ALL ON ${on} FROM PUBLIC;`);
    }
    const groups = new Map<string, { grantee: string; grantable: boolean; privileges: string[] }>();
    for (const entry of acl) {
        if (owner !== null && entry.grantee === owner) continue;
        if (entry.grantee === 'PUBLIC' && entry.privilege === publicDefault) continue;
        const key = `${entry.grantee}\u0000${entry.grantable}`;
        const group = groups.get(key) ?? { grantee: entry.grantee, grantable: entry.grantable, privileges: [] };
        if (!group.privileges.includes(entry.privilege)) group.privileges.push(entry.privilege);
        groups.set(key, group);
    }
    for (const group of groups.values()) {
        const privileges = [...group.privileges].sort((a, b) => PRIVILEGE_ORDER.indexOf(a) - PRIVILEGE_ORDER.indexOf(b));
        lines.push(`GRANT ${privileges.join(', ')} ON ${on} TO ${roleName(group.grantee)}${group.grantable ? ' WITH GRANT OPTION' : ''};`);
    }
    return lines;
}

export interface ObjectExtras {
    owner: string | null;
    comment: string | null;
    /** null: default privileges; see {@link buildGrantStatements}. */
    acl: AclEntry[] | null;
    /** Comments of the columns of a relation, in column order. */
    columnComments?: Array<{ column: string; comment: string }>;
}

/** COMMENT ON, ALTER … OWNER TO and GRANT statements for an object, as far as the options ask for them. */
export function buildExtras(target: DdlTarget, extras: ObjectExtras, options: DdlOptions): string[] {
    const reference = objectReference(target);
    const lines: string[] = [];
    if (options.includeComments) {
        if (extras.comment !== null && extras.comment !== '') {
            lines.push(`COMMENT ON ${SQL_KIND[target.kind]} ${reference} IS ${escapeSqlLiteral(extras.comment)};`);
        }
        for (const c of extras.columnComments ?? []) {
            lines.push(`COMMENT ON COLUMN ${qualifiedName(target.schema, target.name)}.${quoteIdentifier(c.column)} IS ${escapeSqlLiteral(c.comment)};`);
        }
    }
    if (options.includeOwner && extras.owner && target.kind !== 'trigger' && target.kind !== 'extension') {
        lines.push(`ALTER ${SQL_KIND[target.kind]} ${reference} OWNER TO ${quoteIdentifier(extras.owner)};`);
    }
    if (options.includeGrants) {
        // GRANT names a function by its argument types only: an ordered-set
        // aggregate's `x ORDER BY y` becomes `x, y` there.
        const grantReference = target.kind === 'aggregate'
            ? `${qualifiedName(target.schema, target.name)}(${(target.args ?? '').replace(/ ORDER BY /g, ', ')})`
            : reference;
        lines.push(...buildGrantStatements(target.kind, grantReference, extras.owner, extras.acl));
    }
    return lines;
}

/** The main statement(s), then a blank line and the extras. */
function withExtras(main: string, extras: string[]): string {
    return extras.length > 0 ? `${main}\n\n${extras.join('\n')}` : main;
}

/** A definition the server returns, closed by exactly one semicolon. */
export function terminate(definition: string): string {
    return definition.trimEnd().replace(/;+$/, '').trimEnd() + ';';
}

// ===== Builders ===============================================================

export interface AggregateInfo {
    schema: string;
    name: string;
    /** `pg_get_function_arguments`; empty for an aggregate over `*`. */
    arguments: string;
    /** `n` normal, `o` ordered-set, `h` hypothetical-set. */
    aggKind: string;
    sfunc: string;
    stype: string;
    sspace: number;
    finalfunc: string | null;
    finalExtra: boolean;
    /** `r` READ_ONLY, `s` SHAREABLE, `w` READ_WRITE; null on servers before 11. */
    finalModify: string | null;
    combinefunc: string | null;
    serialfunc: string | null;
    deserialfunc: string | null;
    initcond: string | null;
    msfunc: string | null;
    minvfunc: string | null;
    mstype: string | null;
    msspace: number;
    mfinalfunc: string | null;
    mfinalExtra: boolean;
    mfinalModify: string | null;
    minitcond: string | null;
    sortop: string | null;
    /** `s` safe, `r` restricted, `u` unsafe. */
    parallel: string;
}

const MODIFY_WORD: Record<string, string> = { r: 'READ_ONLY', s: 'SHAREABLE', w: 'READ_WRITE' };

export function buildCreateAggregate(info: AggregateInfo): string {
    const opts: string[] = [`SFUNC = ${info.sfunc}`, `STYPE = ${info.stype}`];
    if (info.sspace > 0) opts.push(`SSPACE = ${info.sspace}`);
    if (info.finalfunc) opts.push(`FINALFUNC = ${info.finalfunc}`);
    if (info.finalExtra) opts.push('FINALFUNC_EXTRA');
    const defaultModify = info.aggKind === 'n' ? 'r' : 'w';
    if (info.finalModify && info.finalModify !== defaultModify) opts.push(`FINALFUNC_MODIFY = ${MODIFY_WORD[info.finalModify]}`);
    if (info.combinefunc) opts.push(`COMBINEFUNC = ${info.combinefunc}`);
    if (info.serialfunc) opts.push(`SERIALFUNC = ${info.serialfunc}`);
    if (info.deserialfunc) opts.push(`DESERIALFUNC = ${info.deserialfunc}`);
    if (info.initcond !== null) opts.push(`INITCOND = ${escapeSqlLiteral(info.initcond)}`);
    if (info.msfunc) opts.push(`MSFUNC = ${info.msfunc}`);
    if (info.minvfunc) opts.push(`MINVFUNC = ${info.minvfunc}`);
    if (info.mstype) opts.push(`MSTYPE = ${info.mstype}`);
    if (info.msspace > 0) opts.push(`MSSPACE = ${info.msspace}`);
    if (info.mfinalfunc) opts.push(`MFINALFUNC = ${info.mfinalfunc}`);
    if (info.mfinalExtra) opts.push('MFINALFUNC_EXTRA');
    if (info.mfinalModify && info.mstype && info.mfinalModify !== 'r') opts.push(`MFINALFUNC_MODIFY = ${MODIFY_WORD[info.mfinalModify]}`);
    if (info.minitcond !== null) opts.push(`MINITCOND = ${escapeSqlLiteral(info.minitcond)}`);
    if (info.sortop) opts.push(`SORTOP = ${info.sortop}`);
    if (info.parallel === 's') opts.push('PARALLEL = SAFE');
    else if (info.parallel === 'r') opts.push('PARALLEL = RESTRICTED');
    if (info.aggKind === 'h') opts.push('HYPOTHETICAL');
    const args = info.arguments.trim() === '' ? '*' : info.arguments;
    return `CREATE AGGREGATE ${qualifiedName(info.schema, info.name)} (${args}) (\n    ${opts.join(',\n    ')}\n);`;
}

export function buildCreateEnum(schema: string, name: string, labels: readonly string[]): string {
    if (labels.length === 0) return `CREATE TYPE ${qualifiedName(schema, name)} AS ENUM ();`;
    return `CREATE TYPE ${qualifiedName(schema, name)} AS ENUM (\n    ${labels.map(escapeSqlLiteral).join(',\n    ')}\n);`;
}

export interface CompositeAttribute {
    name: string;
    type: string;
    collation: string | null;
}

export function buildCreateComposite(schema: string, name: string, attributes: readonly CompositeAttribute[]): string {
    if (attributes.length === 0) return `CREATE TYPE ${qualifiedName(schema, name)} AS ();`;
    const lines = attributes.map(a => `${quoteIdentifier(a.name)} ${a.type}${a.collation ? ` COLLATE ${a.collation}` : ''}`);
    return `CREATE TYPE ${qualifiedName(schema, name)} AS (\n    ${lines.join(',\n    ')}\n);`;
}

export interface RangeInfo {
    subtype: string;
    opclass: string | null;
    collation: string | null;
    canonical: string | null;
    subdiff: string | null;
    /** Name of the multirange type (PostgreSQL 14+), null before. */
    multirange: string | null;
}

/** The multirange name PostgreSQL derives from a range type name when none is given. */
export function defaultMultirangeName(rangeName: string): string {
    return rangeName.includes('range') ? rangeName.replace('range', 'multirange') : `${rangeName}_multirange`;
}

export function buildCreateRange(schema: string, name: string, info: RangeInfo): string {
    const opts = [`SUBTYPE = ${info.subtype}`];
    if (info.opclass) opts.push(`SUBTYPE_OPCLASS = ${info.opclass}`);
    if (info.collation) opts.push(`COLLATION = ${info.collation}`);
    if (info.canonical) opts.push(`CANONICAL = ${info.canonical}`);
    if (info.subdiff) opts.push(`SUBTYPE_DIFF = ${info.subdiff}`);
    if (info.multirange && info.multirange !== defaultMultirangeName(name)) {
        opts.push(`MULTIRANGE_TYPE_NAME = ${qualifiedName(schema, info.multirange)}`);
    }
    return `CREATE TYPE ${qualifiedName(schema, name)} AS RANGE (\n    ${opts.join(',\n    ')}\n);`;
}

export interface DomainInfo {
    baseType: string;
    collation: string | null;
    defaultValue: string | null;
    notNull: boolean;
    constraints: Array<{ name: string; definition: string }>;
}

export function buildCreateDomain(schema: string, name: string, info: DomainInfo): string {
    const parts = [`CREATE DOMAIN ${qualifiedName(schema, name)} AS ${info.baseType}`];
    if (info.collation) parts.push(`COLLATE ${info.collation}`);
    if (info.defaultValue !== null) parts.push(`DEFAULT ${info.defaultValue}`);
    if (info.notNull) parts.push('NOT NULL');
    for (const c of info.constraints) parts.push(`CONSTRAINT ${quoteIdentifier(c.name)} ${c.definition}`);
    return parts.join('\n    ') + ';';
}

export interface SequenceInfo {
    dataType: string;
    start: string;
    increment: string;
    min: string;
    max: string;
    cache: string;
    cycle: boolean;
    unlogged: boolean;
    ownedBy: { schema: string; table: string; column: string } | null;
}

export function buildCreateSequence(schema: string, name: string, info: SequenceInfo): string {
    const seq = qualifiedName(schema, name);
    const lines = [
        `CREATE ${info.unlogged ? 'UNLOGGED ' : ''}SEQUENCE ${seq}`,
        `    AS ${info.dataType}`,
        `    INCREMENT BY ${info.increment}`,
        `    MINVALUE ${info.min}`,
        `    MAXVALUE ${info.max}`,
        `    START WITH ${info.start}`,
        `    CACHE ${info.cache}`,
        `    ${info.cycle ? 'CYCLE' : 'NO CYCLE'};`
    ];
    if (info.ownedBy) {
        lines.push(`ALTER SEQUENCE ${seq} OWNED BY ${qualifiedName(info.ownedBy.schema, info.ownedBy.table)}.${quoteIdentifier(info.ownedBy.column)};`);
    }
    return lines.join('\n');
}

export interface TriggerInfo {
    name: string;
    /** `pg_get_triggerdef(oid, true)`. */
    definition: string;
    /** `O` origin (enabled), `D` disabled, `R` replica, `A` always. */
    enabled: string;
}

/** A trigger's CREATE statement, plus the ALTER TABLE that restores a non-default firing state. */
export function buildTriggerStatements(schema: string, table: string, trigger: TriggerInfo): string[] {
    const lines = [terminate(trigger.definition)];
    const state: Record<string, string> = { D: 'DISABLE TRIGGER', R: 'ENABLE REPLICA TRIGGER', A: 'ENABLE ALWAYS TRIGGER' };
    if (state[trigger.enabled]) {
        lines.push(`ALTER TABLE ${qualifiedName(schema, table)} ${state[trigger.enabled]} ${quoteIdentifier(trigger.name)};`);
    }
    return lines;
}

export function buildCreateExtension(name: string, schema: string, version: string): string {
    return `CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(name)} WITH SCHEMA ${quoteIdentifier(schema)} VERSION ${escapeSqlLiteral(version)};`;
}

export interface ViewInfo {
    /** `pg_get_viewdef(oid, true)`. */
    definition: string;
    options: string[] | null;
}

export function buildCreateView(schema: string, name: string, info: ViewInfo): string {
    const options = (info.options ?? []).filter(o => !o.startsWith('check_option='));
    const check = (info.options ?? []).find(o => o.startsWith('check_option='))?.slice('check_option='.length);
    const withClause = options.length > 0 ? ` WITH (${formatStorageOptions(options)})` : '';
    const body = info.definition.trimEnd().replace(/;+$/, '').trimEnd();
    const checkClause = check ? `\n  WITH ${check.toUpperCase()} CHECK OPTION` : '';
    return `CREATE OR REPLACE VIEW ${qualifiedName(schema, name)}${withClause} AS\n${body}${checkClause};`;
}

export interface MaterializedViewInfo extends ViewInfo {
    populated: boolean;
    indexes: string[];
}

export function buildCreateMaterializedView(schema: string, name: string, info: MaterializedViewInfo): string {
    const withClause = info.options && info.options.length > 0 ? ` WITH (${formatStorageOptions(info.options)})` : '';
    const body = info.definition.trimEnd().replace(/;+$/, '').trimEnd();
    const lines = [`CREATE MATERIALIZED VIEW ${qualifiedName(schema, name)}${withClause} AS\n${body}\nWITH ${info.populated ? '' : 'NO '}DATA;`];
    for (const index of info.indexes) lines.push(terminate(index));
    return lines.join('\n');
}

export interface TableColumn {
    name: string;
    type: string;
    notNull: boolean;
    defaultExpr: string | null;
    /** `a` ALWAYS, `d` BY DEFAULT, `` none. */
    identity: string;
    /** `s` stored, `v` virtual, `` none. */
    generated: string;
    collation: string | null;
    /** Inherited columns are not repeated in the CREATE TABLE of a child. */
    isLocal: boolean;
    fdwOptions: string[] | null;
}

export interface PolicyInfo {
    name: string;
    permissive: boolean;
    roles: string[];
    command: string;
    using: string | null;
    withCheck: string | null;
}

export interface TableInfo {
    kind: 'table' | 'foreign';
    schema: string;
    name: string;
    unlogged: boolean;
    /** `pg_get_partkeydef` of a partitioned table. */
    partitionKey: string | null;
    /** Parent and bound (`FOR VALUES …` or `DEFAULT`) of a partition. */
    partitionOf: { schema: string; name: string; bound: string } | null;
    inherits: Array<{ schema: string; name: string }>;
    options: string[] | null;
    foreignServer: string | null;
    foreignOptions: string[] | null;
    columns: TableColumn[];
    /** Local constraints with `pg_get_constraintdef`, primary key first. */
    constraints: Array<{ name: string; definition: string }>;
    indexes: string[];
    triggers: TriggerInfo[];
    rowSecurity: boolean;
    forceRowSecurity: boolean;
    policies: PolicyInfo[];
}

function columnDefinition(c: TableColumn, foreign: boolean): string {
    let line = `${quoteIdentifier(c.name)} ${c.type}`;
    if (foreign && c.fdwOptions && c.fdwOptions.length > 0) line += ` OPTIONS (${formatFdwOptions(c.fdwOptions)})`;
    if (c.collation) line += ` COLLATE ${c.collation}`;
    if (c.generated && c.defaultExpr !== null) {
        line += ` GENERATED ALWAYS AS (${c.defaultExpr}) ${c.generated === 'v' ? 'VIRTUAL' : 'STORED'}`;
    } else if (c.identity === 'a' || c.identity === 'd') {
        line += ` GENERATED ${c.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
    } else if (c.defaultExpr !== null) {
        line += ` DEFAULT ${c.defaultExpr}`;
    }
    if (c.notNull) line += ' NOT NULL';
    return line;
}

export function buildPolicyStatement(schema: string, table: string, p: PolicyInfo): string {
    let sql = `CREATE POLICY ${quoteIdentifier(p.name)} ON ${qualifiedName(schema, table)}`;
    if (!p.permissive) sql += ' AS RESTRICTIVE';
    if (p.command && p.command.toUpperCase() !== 'ALL') sql += ` FOR ${p.command.toUpperCase()}`;
    const roles = p.roles.filter(r => r.length > 0);
    if (roles.length > 0 && !(roles.length === 1 && roles[0].toLowerCase() === 'public')) {
        sql += ` TO ${roles.map(r => (r.toLowerCase() === 'public' ? 'PUBLIC' : quoteIdentifier(r))).join(', ')}`;
    }
    if (p.using) sql += ` USING (${p.using})`;
    if (p.withCheck) sql += ` WITH CHECK (${p.withCheck})`;
    return sql + ';';
}

/**
 * CREATE TABLE (or CREATE FOREIGN TABLE) with columns, identity and generated
 * columns, local constraints, inheritance and partitioning, followed by the
 * table's indexes, triggers, row level security and policies.
 */
export function buildCreateTable(info: TableInfo): string {
    const foreign = info.kind === 'foreign';
    const table = qualifiedName(info.schema, info.name);
    const constraintLines = info.constraints.map(c => `CONSTRAINT ${quoteIdentifier(c.name)} ${c.definition}`);
    let sql = `CREATE ${foreign ? 'FOREIGN ' : ''}${info.unlogged ? 'UNLOGGED ' : ''}TABLE ${table}`;
    if (info.partitionOf) {
        sql += ` PARTITION OF ${qualifiedName(info.partitionOf.schema, info.partitionOf.name)}`;
        if (constraintLines.length > 0) sql += ` (\n    ${constraintLines.join(',\n    ')}\n)`;
        sql += `\n${info.partitionOf.bound}`;
    } else {
        const columnLines = info.columns.filter(c => c.isLocal || info.inherits.length === 0).map(c => columnDefinition(c, foreign));
        const body = [...columnLines, ...constraintLines];
        sql += body.length > 0 ? ` (\n    ${body.join(',\n    ')}\n)` : ' ()';
        if (info.inherits.length > 0) {
            sql += `\nINHERITS (${info.inherits.map(p => qualifiedName(p.schema, p.name)).join(', ')})`;
        }
    }
    if (info.partitionKey) sql += `\nPARTITION BY ${info.partitionKey}`;
    if (foreign && info.foreignServer) {
        sql += `\nSERVER ${quoteIdentifier(info.foreignServer)}`;
        if (info.foreignOptions && info.foreignOptions.length > 0) sql += `\nOPTIONS (${formatFdwOptions(info.foreignOptions)})`;
    }
    if (info.options && info.options.length > 0) sql += `\nWITH (${formatStorageOptions(info.options)})`;
    const lines = [sql + ';'];
    const after: string[] = [];
    for (const index of info.indexes) after.push(terminate(index));
    for (const trigger of info.triggers) after.push(...buildTriggerStatements(info.schema, info.name, trigger));
    if (info.rowSecurity) after.push(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
    if (info.forceRowSecurity) after.push(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
    for (const policy of info.policies) after.push(buildPolicyStatement(info.schema, info.name, policy));
    if (after.length > 0) lines.push('', ...after);
    return lines.join('\n');
}

// ===== Fetchers ===============================================================

function str(row: Row | undefined, key: string): string | null {
    const v = row?.[key];
    return v === null || v === undefined ? null : String(v);
}

function bool(row: Row | undefined, key: string): boolean {
    const v = row?.[key];
    return v === true || v === 't' || v === 'true';
}

function strArray(row: Row | undefined, key: string): string[] | null {
    const v = row?.[key];
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return v.map(String);
    // An array the driver did not parse: {a=1,"b=c d"}.
    const text = String(v).replace(/^\{|\}$/g, '');
    if (text === '') return [];
    return text.split(',').map(s => s.replace(/^"|"$/g, '').replace(/\\"/g, '"'));
}

async function one(ctx: DdlContext, sql: string, oid: number, what: string): Promise<Row> {
    const rows = await ctx.query(sql, [oid]);
    if (rows.length === 0) throw new Error(`The ${what} no longer exists in the database.`);
    return rows[0];
}

/** The catalog an oid of each kind lives in, with its ACL column. */
const ACL_SOURCE: Partial<Record<DdlKind, { table: string; column: string }>> = {
    function: { table: 'pg_proc', column: 'proacl' },
    procedure: { table: 'pg_proc', column: 'proacl' },
    aggregate: { table: 'pg_proc', column: 'proacl' },
    type: { table: 'pg_type', column: 'typacl' },
    domain: { table: 'pg_type', column: 'typacl' },
    sequence: { table: 'pg_class', column: 'relacl' },
    schema: { table: 'pg_namespace', column: 'nspacl' },
    table: { table: 'pg_class', column: 'relacl' },
    view: { table: 'pg_class', column: 'relacl' },
    matview: { table: 'pg_class', column: 'relacl' },
    foreign: { table: 'pg_class', column: 'relacl' }
};

async function fetchAcl(ctx: DdlContext, kind: DdlKind, oid: number): Promise<AclEntry[] | null> {
    const source = ACL_SOURCE[kind];
    if (!source || !ctx.options.includeGrants) return null;
    const rows = await ctx.query(
        `SELECT x.acl IS NULL AS is_default,
                CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END AS grantee,
                a.privilege_type, a.is_grantable
         FROM (SELECT ${source.column} AS acl FROM pg_catalog.${source.table} WHERE oid = $1) x
         LEFT JOIN LATERAL pg_catalog.aclexplode(x.acl) a ON true`,
        [oid]
    );
    if (rows.length === 0 || bool(rows[0], 'is_default')) return null;
    return rows
        .filter(r => r.privilege_type !== null && r.privilege_type !== undefined)
        .map(r => ({ grantee: String(r.grantee), privilege: String(r.privilege_type), grantable: bool(r, 'is_grantable') }));
}

async function fetchColumnComments(ctx: DdlContext, oid: number): Promise<Array<{ column: string; comment: string }>> {
    if (!ctx.options.includeComments) return [];
    const rows = await ctx.query(
        `SELECT a.attname, pg_catalog.col_description(a.attrelid, a.attnum) AS comment
         FROM pg_catalog.pg_attribute a
         WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
           AND pg_catalog.col_description(a.attrelid, a.attnum) IS NOT NULL
         ORDER BY a.attnum`,
        [oid]
    );
    return rows.map(r => ({ column: String(r.attname), comment: String(r.comment) }));
}

async function fetchTriggers(ctx: DdlContext, relationOid: number): Promise<TriggerInfo[]> {
    const rows = await ctx.query(
        `SELECT t.tgname, pg_catalog.pg_get_triggerdef(t.oid, true) AS def, t.tgenabled
         FROM pg_catalog.pg_trigger t
         WHERE t.tgrelid = $1 AND NOT t.tgisinternal${ctx.serverVersion >= 130000 ? ' AND t.tgparentid = 0' : ''}
         ORDER BY t.tgname`,
        [relationOid]
    );
    return rows.map(r => ({ name: String(r.tgname), definition: String(r.def), enabled: String(r.tgenabled ?? 'O') }));
}

async function fetchIndexes(ctx: DdlContext, relationOid: number): Promise<string[]> {
    const rows = await ctx.query(
        `SELECT pg_catalog.pg_get_indexdef(i.indexrelid) AS def
         FROM pg_catalog.pg_index i
         JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
         WHERE i.indrelid = $1
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint co
                           WHERE co.conindid = i.indexrelid AND co.conrelid = i.indrelid AND co.contype IN ('p', 'u', 'x'))
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits ih WHERE ih.inhrelid = i.indexrelid)
         ORDER BY ic.relname`,
        [relationOid]
    );
    // A partitioned table's index is written ON ONLY, which would leave it
    // invalid when replayed; without ONLY it is created on the partitions too.
    return rows.map(r => String(r.def).replace(' ON ONLY ', ' ON '));
}

/** The oid of the object a target names, read from the catalog when the tree did not know it. */
async function resolveOid(ctx: DdlContext, target: DdlTarget): Promise<number> {
    if (target.oid !== undefined) return target.oid;
    let rows: Row[];
    if (target.kind === 'schema') {
        rows = await ctx.query('SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1', [target.name]);
    } else if (target.kind === 'table' || target.kind === 'view' || target.kind === 'matview' || target.kind === 'foreign' || target.kind === 'sequence') {
        rows = await ctx.query(
            `SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relname = $2`,
            [target.schema, target.name]
        );
    } else {
        throw new Error(`No catalog lookup for a ${target.kind} by name.`);
    }
    if (rows.length === 0) throw new Error(`${target.schema}.${target.name} no longer exists in the database.`);
    return Number(rows[0].oid);
}

async function createRoutine(ctx: DdlContext, target: DdlTarget, oid: number): Promise<string> {
    const row = await one(ctx,
        `SELECT pg_catalog.pg_get_functiondef(p.oid) AS def,
                pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
                pg_catalog.pg_get_userbyid(p.proowner) AS owner,
                pg_catalog.obj_description(p.oid, 'pg_proc') AS comment
         FROM pg_catalog.pg_proc p WHERE p.oid = $1`, oid, target.kind);
    const t = { ...target, args: str(row, 'args') ?? target.args };
    const extras = buildExtras(t, { owner: str(row, 'owner'), comment: str(row, 'comment'), acl: await fetchAcl(ctx, target.kind, oid) }, ctx.options);
    return withExtras(terminate(str(row, 'def') ?? ''), extras);
}

async function createAggregate(ctx: DdlContext, target: DdlTarget, oid: number): Promise<string> {
    const v11 = ctx.serverVersion >= 110000;
    const regproc = (col: string): string => `CASE WHEN a.${col} = 0 THEN NULL ELSE a.${col}::regproc::text END`;
    const row = await one(ctx,
        `SELECT n.nspname, p.proname,
                pg_catalog.pg_get_function_arguments(p.oid) AS arguments,
                pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_args,
                a.aggkind, ${regproc('aggtransfn')} AS sfunc,
                pg_catalog.format_type(a.aggtranstype, NULL) AS stype, a.aggtransspace,
                ${regproc('aggfinalfn')} AS finalfunc, a.aggfinalextra,
                ${v11 ? 'a.aggfinalmodify::text' : 'NULL::text'} AS finalmodify,
                ${regproc('aggcombinefn')} AS combinefunc, ${regproc('aggserialfn')} AS serialfunc,
                ${regproc('aggdeserialfn')} AS deserialfunc, a.agginitval,
                ${regproc('aggmtransfn')} AS msfunc, ${regproc('aggminvtransfn')} AS minvfunc,
                CASE WHEN a.aggmtranstype = 0 THEN NULL ELSE pg_catalog.format_type(a.aggmtranstype, NULL) END AS mstype,
                a.aggmtransspace, ${regproc('aggmfinalfn')} AS mfinalfunc, a.aggmfinalextra,
                ${v11 ? 'a.aggmfinalmodify::text' : 'NULL::text'} AS mfinalmodify, a.aggminitval,
                CASE WHEN a.aggsortop = 0 THEN NULL
                     WHEN opn.nspname = 'pg_catalog' THEN op.oprname
                     ELSE 'OPERATOR(' || pg_catalog.quote_ident(opn.nspname) || '.' || op.oprname || ')' END AS sortop,
                p.proparallel, pg_catalog.pg_get_userbyid(p.proowner) AS owner,
                pg_catalog.obj_description(p.oid, 'pg_proc') AS comment
         FROM pg_catalog.pg_aggregate a
         JOIN pg_catalog.pg_proc p ON p.oid = a.aggfnoid
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         LEFT JOIN pg_catalog.pg_operator op ON op.oid = a.aggsortop
         LEFT JOIN pg_catalog.pg_namespace opn ON opn.oid = op.oprnamespace
         WHERE a.aggfnoid = $1`, oid, 'aggregate');
    const main = buildCreateAggregate({
        schema: String(row.nspname),
        name: String(row.proname),
        arguments: str(row, 'arguments') ?? '',
        aggKind: str(row, 'aggkind') ?? 'n',
        sfunc: str(row, 'sfunc') ?? '',
        stype: str(row, 'stype') ?? '',
        sspace: Number(row.aggtransspace ?? 0),
        finalfunc: str(row, 'finalfunc'),
        finalExtra: bool(row, 'aggfinalextra'),
        finalModify: str(row, 'finalmodify'),
        combinefunc: str(row, 'combinefunc'),
        serialfunc: str(row, 'serialfunc'),
        deserialfunc: str(row, 'deserialfunc'),
        initcond: str(row, 'agginitval'),
        msfunc: str(row, 'msfunc'),
        minvfunc: str(row, 'minvfunc'),
        mstype: str(row, 'mstype'),
        msspace: Number(row.aggmtransspace ?? 0),
        mfinalfunc: str(row, 'mfinalfunc'),
        mfinalExtra: bool(row, 'aggmfinalextra'),
        mfinalModify: str(row, 'mfinalmodify'),
        minitcond: str(row, 'aggminitval'),
        sortop: str(row, 'sortop'),
        parallel: str(row, 'proparallel') ?? 'u'
    });
    const t = { ...target, args: str(row, 'identity_args') ?? target.args };
    const extras = buildExtras(t, { owner: str(row, 'owner'), comment: str(row, 'comment'), acl: await fetchAcl(ctx, 'aggregate', oid) }, ctx.options);
    return withExtras(main, extras);
}

async function createType(ctx: DdlContext, target: DdlTarget, oid: number): Promise<string> {
    const row = await one(ctx,
        `SELECT t.typtype, t.typrelid, n.nspname, t.typname,
                pg_catalog.pg_get_userbyid(t.typowner) AS owner,
                pg_catalog.obj_description(t.oid, 'pg_type') AS comment
         FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
         WHERE t.oid = $1`, oid, 'type');
    const schema = String(row.nspname);
    const name = String(row.typname);
    const typtype = str(row, 'typtype');
    let main: string;
    if (typtype === 'e') {
        const labels = await ctx.query('SELECT enumlabel FROM pg_catalog.pg_enum WHERE enumtypid = $1 ORDER BY enumsortorder', [oid]);
        main = buildCreateEnum(schema, name, labels.map(r => String(r.enumlabel)));
    } else if (typtype === 'c') {
        const attrs = await ctx.query(
            `SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
                    CASE WHEN a.attcollation <> 0 AND a.attcollation <> at.typcollation
                         THEN pg_catalog.quote_ident(cn.nspname) || '.' || pg_catalog.quote_ident(co.collname) END AS collation
             FROM pg_catalog.pg_attribute a
             JOIN pg_catalog.pg_type at ON at.oid = a.atttypid
             LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation
             LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace
             WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY a.attnum`, [Number(row.typrelid)]);
        main = buildCreateComposite(schema, name, attrs.map(r => ({ name: String(r.attname), type: String(r.type), collation: str(r, 'collation') })));
    } else if (typtype === 'r') {
        const r = await one(ctx,
            `SELECT pg_catalog.format_type(r.rngsubtype, NULL) AS subtype,
                    CASE WHEN oc.opcdefault THEN NULL
                         ELSE pg_catalog.quote_ident(ocn.nspname) || '.' || pg_catalog.quote_ident(oc.opcname) END AS opclass,
                    CASE WHEN r.rngcollation = 0 OR r.rngcollation = st.typcollation THEN NULL
                         ELSE pg_catalog.quote_ident(cn.nspname) || '.' || pg_catalog.quote_ident(co.collname) END AS collation,
                    CASE WHEN r.rngcanonical = 0 THEN NULL ELSE r.rngcanonical::regproc::text END AS canonical,
                    CASE WHEN r.rngsubdiff = 0 THEN NULL ELSE r.rngsubdiff::regproc::text END AS subdiff,
                    ${ctx.serverVersion >= 140000 ? '(SELECT mt.typname FROM pg_catalog.pg_type mt WHERE mt.oid = r.rngmultitypid)' : 'NULL::name'} AS multirange
             FROM pg_catalog.pg_range r
             JOIN pg_catalog.pg_type st ON st.oid = r.rngsubtype
             JOIN pg_catalog.pg_opclass oc ON oc.oid = r.rngsubopc
             JOIN pg_catalog.pg_namespace ocn ON ocn.oid = oc.opcnamespace
             LEFT JOIN pg_catalog.pg_collation co ON co.oid = r.rngcollation
             LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace
             WHERE r.rngtypid = $1`, oid, 'range type');
        main = buildCreateRange(schema, name, {
            subtype: String(r.subtype),
            opclass: str(r, 'opclass'),
            collation: str(r, 'collation'),
            canonical: str(r, 'canonical'),
            subdiff: str(r, 'subdiff'),
            multirange: str(r, 'multirange')
        });
    } else if (typtype === 'd') {
        return createDomain(ctx, { ...target, kind: 'domain' }, oid);
    } else {
        throw new Error(`${schema}.${name} is a base type; its CREATE TYPE needs the C functions of its extension and cannot be generated.`);
    }
    const extras = buildExtras(target, { owner: str(row, 'owner'), comment: str(row, 'comment'), acl: await fetchAcl(ctx, 'type', oid) }, ctx.options);
    return withExtras(main, extras);
}

async function createDomain(ctx: DdlContext, target: DdlTarget, oid: number): Promise<string> {
    const row = await one(ctx,
        `SELECT n.nspname, t.typname,
                pg_catalog.format_type(t.typbasetype, t.typtypmod) AS base_type,
                t.typnotnull, t.typdefault,
                CASE WHEN t.typcollation <> 0 AND t.typcollation <> bt.typcollation
                     THEN pg_catalog.quote_ident(cn.nspname) || '.' || pg_catalog.quote_ident(co.collname) END AS collation,
                pg_catalog.pg_get_userbyid(t.typowner) AS owner,
                pg_catalog.obj_description(t.oid, 'pg_type') AS comment
         FROM pg_catalog.pg_type t
         JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
         JOIN pg_catalog.pg_type bt ON bt.oid = t.typbasetype
         LEFT JOIN pg_catalog.pg_collation co ON co.oid = t.typcollation
         LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace
         WHERE t.oid = $1`, oid, 'domain');
    const constraints = await ctx.query(
        `SELECT conname, pg_catalog.pg_get_constraintdef(oid, true) AS def
         FROM pg_catalog.pg_constraint WHERE contypid = $1 AND contype = 'c' ORDER BY conname`, [oid]);
    const main = buildCreateDomain(String(row.nspname), String(row.typname), {
        baseType: String(row.base_type),
        collation: str(row, 'collation'),
        defaultValue: str(row, 'typdefault'),
        notNull: bool(row, 'typnotnull'),
        constraints: constraints.map(c => ({ name: String(c.conname), definition: String(c.def) }))
    });
    const extras = buildExtras(target, { owner: str(row, 'owner'), comment: str(row, 'comment'), acl: await fetchAcl(ctx, 'domain', oid) }, ctx.options);
    return withExtras(main, extras);
}

async function createSequence(ctx: DdlContext, target: DdlTarget, oid: number): Promise<string> {
    const row = await one(ctx,
        `SELECT n.nspname, c.relname, pg_catalog.format_type(s.seqtypid, NULL) AS data_type,
                s.seqstart::text AS seqstart, s.seqincrement::text AS seqincrement, s.seqmax::text AS seqmax,
                s.seqmin::text AS seqmin, s.seqcache::text AS seqcache, s.seqcycle, c.relpersistence,
                tn.nspname AS owned_schema, tc.relname AS owned_table, ta.attname AS owned_column,
                pg_catalog.pg_get_userbyid(c.relowner) AS owner,
                pg_catalog.obj_description(c.oid, 'pg_class') AS comment
         FROM pg_catalog.pg_sequence s
         JOIN pg_catalog.pg_class c ON c.oid = s.seqrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid
              AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.deptype = 'a'
         LEFT JOIN pg_catalog.pg_class tc ON tc.oid = d.refobjid
         LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
         LEFT JOIN pg_catalog.pg_attribute ta ON ta.attrelid = d.refobjid AND ta.attnum = d.refobjsubid
         WHERE s.seqrelid = $1`, oid, 'sequence');
    const ownedTable = str(row, 'owned_table');
    const main = buildCreateSequence(String(row.nspname), String(row.relname), {
        dataType: String(row.data_type),
        start: String(row.seqstart),
        increment: String(row.seqincrement),
        min: String(row.seqmin),
        max: String(row.seqmax),
        cache: String(row.seqcache),
        cycle: bool(row, 'seqcycle'),
        unlogged: str(row, 'relpersistence') === 'u',
        ownedBy: ownedTable ? { schema: String(row.owned_schema), table: ownedTable, column: String(row.owned_column) } : null
    });
    const extras = buildExtras(target, { owner: str(row, 'owner'), comment: str(row, 'comment'), acl: await fetchAcl(ctx, 'sequence', oid) }, ctx.options);
    return withExtras(main, extras);
}

async function createTrigger(ctx: DdlContext, target: DdlTarget, oid: number): Promise<string> {
    const row = await one(ctx,
        `SELECT t.tgname, pg_catalog.pg_get_triggerdef(t.oid, true) AS def, t.tgenabled, n.nspname, c.relname,
                pg_catalog.obj_description(t.oid, 'pg_trigger') AS comment
         FROM pg_catalog.pg_trigger t
         JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE t.oid = $1`, oid, 'trigger');
    const schema = String(row.nspname);
    const table = String(row.relname);
    const main = buildTriggerStatements(schema, table, {
        name: String(row.tgname), definition: String(row.def), enabled: str(row, 'tgenabled') ?? 'O'
    }).join('\n');
    const extras = buildExtras({ ...target, schema, table }, { owner: null, comment: str(row, 'comment'), acl: null }, ctx.options);
    return withExtras(main, extras);
}

async function createExtension(ctx: DdlContext, target: DdlTarget, oid: number): Promise<string> {
    const row = await one(ctx,
        `SELECT e.extname, n.nspname, e.extversion, pg_catalog.obj_description(e.oid, 'pg_extension') AS comment
         FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
         WHERE e.oid = $1`, oid, 'extension');
    const main = buildCreateExtension(String(row.extname), String(row.nspname), String(row.extversion));
    const extras = buildExtras(target, { owner: null, comment: str(row, 'comment'), acl: null }, ctx.options);
    return withExtras(main, extras);
}

async function createSchema(ctx: DdlContext, target: DdlTarget, oid: number): Promise<string> {
    const row = await one(ctx,
        `SELECT n.nspname, pg_catalog.pg_get_userbyid(n.nspowner) AS owner,
                pg_catalog.obj_description(n.oid, 'pg_namespace') AS comment
         FROM pg_catalog.pg_namespace n WHERE n.oid = $1`, oid, 'schema');
    const main = `CREATE SCHEMA ${quoteIdentifier(String(row.nspname))};`;
    const extras = buildExtras(target, { owner: str(row, 'owner'), comment: str(row, 'comment'), acl: await fetchAcl(ctx, 'schema', oid) }, ctx.options);
    return withExtras(main, extras);
}

async function relationHeader(ctx: DdlContext, oid: number, what: string): Promise<Row> {
    return one(ctx,
        `SELECT n.nspname, c.relname, c.relkind, c.relpersistence, c.reloptions::text[] AS reloptions,
                c.relrowsecurity, c.relforcerowsecurity, c.relispopulated,
                pg_catalog.pg_get_userbyid(c.relowner) AS owner,
                pg_catalog.obj_description(c.oid, 'pg_class') AS comment,
                CASE WHEN c.relkind = 'p' THEN pg_catalog.pg_get_partkeydef(c.oid) END AS partition_key,
                CASE WHEN c.relispartition THEN pg_catalog.pg_get_expr(c.relpartbound, c.oid) END AS partition_bound,
                fs.srvname AS foreign_server, ft.ftoptions::text[] AS foreign_options
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_catalog.pg_foreign_table ft ON ft.ftrelid = c.oid
         LEFT JOIN pg_catalog.pg_foreign_server fs ON fs.oid = ft.ftserver
         WHERE c.oid = $1`, oid, what);
}

async function relationExtras(ctx: DdlContext, target: DdlTarget, row: Row, oid: number): Promise<string[]> {
    return buildExtras(target, {
        owner: str(row, 'owner'),
        comment: str(row, 'comment'),
        acl: await fetchAcl(ctx, target.kind, oid),
        columnComments: await fetchColumnComments(ctx, oid)
    }, ctx.options);
}

async function createView(ctx: DdlContext, target: DdlTarget, oid: number): Promise<string> {
    const row = await relationHeader(ctx, oid, target.kind === 'matview' ? 'materialized view' : 'view');
    const defRow = await one(ctx, 'SELECT pg_catalog.pg_get_viewdef($1::oid, true) AS def', oid, 'view');
    const schema = String(row.nspname);
    const name = String(row.relname);
    const definition = String(defRow.def);
    let main: string;
    if (target.kind === 'matview') {
        main = buildCreateMaterializedView(schema, name, {
            definition,
            options: strArray(row, 'reloptions'),
            populated: bool(row, 'relispopulated'),
            indexes: await fetchIndexes(ctx, oid)
        });
    } else {
        main = buildCreateView(schema, name, { definition, options: strArray(row, 'reloptions') });
        const triggers = await fetchTriggers(ctx, oid);
        if (triggers.length > 0) main += '\n\n' + triggers.flatMap(t => buildTriggerStatements(schema, name, t)).join('\n');
    }
    return withExtras(main, await relationExtras(ctx, { ...target, schema, name }, row, oid));
}

async function createTable(ctx: DdlContext, target: DdlTarget, oid: number): Promise<string> {
    const row = await relationHeader(ctx, oid, 'table');
    const schema = String(row.nspname);
    const name = String(row.relname);
    const columns = await ctx.query(
        `SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull, a.attislocal,
                pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expr,
                a.attidentity::text AS attidentity,
                ${ctx.serverVersion >= 120000 ? 'a.attgenerated::text' : "''::text"} AS attgenerated,
                CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation
                     THEN pg_catalog.quote_ident(cn.nspname) || '.' || pg_catalog.quote_ident(co.collname) END AS collation,
                a.attfdwoptions::text[] AS fdw_options
         FROM pg_catalog.pg_attribute a
         JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
         LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation
         LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace
         WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum`, [oid]);
    const constraints = await ctx.query(
        `SELECT conname, pg_catalog.pg_get_constraintdef(oid, true) AS def
         FROM pg_catalog.pg_constraint
         WHERE conrelid = $1 AND conislocal AND contype IN ('p', 'u', 'c', 'f', 'x')
         ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 WHEN 'x' THEN 3 ELSE 4 END, conname`, [oid]);
    const parents = await ctx.query(
        `SELECT n.nspname, p.relname FROM pg_catalog.pg_inherits i
         JOIN pg_catalog.pg_class p ON p.oid = i.inhparent
         JOIN pg_catalog.pg_namespace n ON n.oid = p.relnamespace
         WHERE i.inhrelid = $1 ORDER BY i.inhseqno`, [oid]);
    const policies = await ctx.query(
        `SELECT policyname, permissive, roles::text[] AS roles, cmd, qual, with_check
         FROM pg_catalog.pg_policies WHERE schemaname = $1 AND tablename = $2 ORDER BY policyname`, [schema, name]);
    const bound = str(row, 'partition_bound');
    const parentList = parents.map(p => ({ schema: String(p.nspname), name: String(p.relname) }));
    const main = buildCreateTable({
        kind: str(row, 'relkind') === 'f' ? 'foreign' : 'table',
        schema,
        name,
        unlogged: str(row, 'relpersistence') === 'u',
        partitionKey: str(row, 'partition_key'),
        partitionOf: bound && parentList.length > 0 ? { ...parentList[0], bound } : null,
        inherits: bound ? [] : parentList,
        options: strArray(row, 'reloptions'),
        foreignServer: str(row, 'foreign_server'),
        foreignOptions: strArray(row, 'foreign_options'),
        columns: columns.map(c => ({
            name: String(c.attname),
            type: String(c.type),
            notNull: bool(c, 'attnotnull'),
            defaultExpr: str(c, 'default_expr'),
            identity: str(c, 'attidentity') ?? '',
            generated: str(c, 'attgenerated') ?? '',
            collation: str(c, 'collation'),
            isLocal: bool(c, 'attislocal'),
            fdwOptions: strArray(c, 'fdw_options')
        })),
        constraints: constraints.map(c => ({ name: String(c.conname), definition: String(c.def) })),
        indexes: await fetchIndexes(ctx, oid),
        triggers: await fetchTriggers(ctx, oid),
        rowSecurity: bool(row, 'relrowsecurity'),
        forceRowSecurity: bool(row, 'relforcerowsecurity'),
        policies: policies.map(p => ({
            name: String(p.policyname),
            permissive: str(p, 'permissive') !== 'RESTRICTIVE',
            roles: strArray(p, 'roles') ?? [],
            command: str(p, 'cmd') ?? 'ALL',
            using: str(p, 'qual'),
            withCheck: str(p, 'with_check')
        }))
    });
    const kind: DdlKind = str(row, 'relkind') === 'f' ? 'foreign' : 'table';
    return withExtras(main, await relationExtras(ctx, { ...target, kind, schema, name }, row, oid));
}

/** The CREATE script of one object, with the comments, owner and grants the options ask for. */
export async function fetchCreateScript(ctx: DdlContext, target: DdlTarget): Promise<string> {
    const oid = await resolveOid(ctx, target);
    switch (target.kind) {
        case 'function':
        case 'procedure':
            return createRoutine(ctx, target, oid);
        case 'aggregate':
            return createAggregate(ctx, target, oid);
        case 'type':
            return createType(ctx, target, oid);
        case 'domain':
            return createDomain(ctx, target, oid);
        case 'sequence':
            return createSequence(ctx, target, oid);
        case 'trigger':
            return createTrigger(ctx, target, oid);
        case 'extension':
            return createExtension(ctx, target, oid);
        case 'schema':
            return createSchema(ctx, target, oid);
        case 'view':
        case 'matview':
            return createView(ctx, target, oid);
        case 'table':
        case 'foreign':
            return createTable(ctx, target, oid);
    }
}
