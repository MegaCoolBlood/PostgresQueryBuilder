/**
 * The catalog of the active connection, shared by the Objects view and the
 * SQL editor features (definition, references, hover, signature help,
 * completion, CodeLens, diagnostics).
 *
 * Nothing is loaded at activation. The first consumer triggers one catalog
 * query (through the metadata cache); further light queries — relations,
 * extension members, built-in names — run only when a feature needs them.
 * Everything is forgotten when the connection changes or on Refresh.
 */
import * as vscode from 'vscode';
import { buildSchemaListQuery, toRelationKind, type RelationKind } from './tableExplorer';
import { buildRelationListQuery } from './queryRunner';
import { CURRENT_SCHEMAS_QUERY, EXTENSION_MEMBERS_QUERY, UnmarkedObjects, routineStatus, type LocatedDefinition, type ObjectIdentity, type RepoStatus } from './repositoryComparison';
import { SERVER_VERSION_QUERY } from './ddlGenerator';
import { routineBodyHash, routineTokenHash, type ArgCount, type RepoObjectKind } from './repositoryScanner';
import { Logger } from './logger';

export type NavigatorKind = 'function' | 'procedure' | 'aggregate' | 'type' | 'domain' | 'sequence' | 'trigger' | 'extension';

/** Every kind, in the order the categories appear under a schema. */
export const NAVIGATOR_KINDS: readonly NavigatorKind[] = ['function', 'procedure', 'aggregate', 'type', 'domain', 'sequence', 'trigger', 'extension'];

/** An object as the catalog query returns it. */
export interface DbObject {
    kind: NavigatorKind;
    oid: number;
    schema: string;
    name: string;
    /** Identity arguments of a routine (`pg_get_function_identity_arguments`). */
    args: string | null;
    /** `format_type` of each identity argument of a routine. */
    argTypes: string[] | null;
    /** All parameters of a routine with modes and defaults (`pg_get_function_arguments`). */
    fullArgs?: string | null;
    /** How many arguments a call may pass. */
    argCount?: ArgCount;
    /** md5 of the normalised body of a SQL or PL/pgSQL routine. */
    bodyHash?: string | null;
    /** Result type, type flavour, base type, data type or version, depending on the kind. */
    detail: string | null;
    /** Table of a trigger; table and column a sequence is owned by. */
    relSchema: string | null;
    relName: string | null;
    relColumn: string | null;
    owner: string | null;
    language: string | null;
    comment: string | null;
    /** The object belongs to an extension (PostGIS functions and the like). */
    fromExtension: boolean;
}

/** A relation of the database, as the Tables view lists it. */
export interface DbRelation {
    schema: string;
    name: string;
    kind: RelationKind;
}

/** The part of the connection manager the catalog needs. */
export interface CatalogConnection {
    isConnected(): boolean;
    getActiveConnectionConfig(): { schemas?: string[] } | null | undefined;
    queryMetadata(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
    clearMetadataCache(): void;
    /** An uncached query, for large results that should not stay in the metadata cache. */
    query?(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface CatalogData {
    objects: DbObject[];
    /** Schemas of the database that the views may show. */
    schemas: Set<string>;
    /** Where an unqualified CREATE ends up: the first schema of the search_path. */
    defaultSchema: string;
    /** The effective search_path of the connection. */
    searchPath: string[];
    serverVersion: number;
}

const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema', 'pg_toast']);

/**
 * The body of a routine normalised in SQL the way {@link normalizeRoutineBody}
 * does it in the scanner: ASCII whitespace removed (regex escapes, so the
 * setting standard_conforming_strings does not matter), ASCII letters folded.
 */
const BODY_HASH_SQL = `CASE WHEN l.lanname IN ('sql', 'plpgsql') AND p.prosrc <> ''
                THEN md5(translate(regexp_replace(p.prosrc, E'[ \\\\t\\\\n\\\\r\\\\f\\\\v]+', '', 'g'),
                                   'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')) END`;

/**
 * The one catalog query. Light columns only — no DDL — and extension members
 * are always read but flagged, so hiding them is a filter in memory and a
 * repository definition of such an object is never mistaken for one that
 * exists only in the repository.
 */
export function buildObjectCatalogQuery(serverVersion: number, restrictToSchemas: boolean): string {
    const inSchemas = (col: string): string => (restrictToSchemas
        ? `${col} = ANY($1::text[])`
        : `${col} NOT IN ('pg_catalog', 'information_schema') AND ${col} NOT LIKE 'pg\\_%'`);
    const member = (catalog: string, oidCol: string): string =>
        `EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.${catalog}'::regclass AND d.objid = ${oidCol} AND d.deptype = 'e')`;
    const routineKind = serverVersion >= 110000
        ? `CASE p.prokind WHEN 'p' THEN 'procedure' WHEN 'a' THEN 'aggregate' ELSE 'function' END`
        : `CASE WHEN p.proisagg THEN 'aggregate' ELSE 'function' END`;
    const isProcedure = serverVersion >= 110000 ? `p.prokind = 'p'` : 'false';
    const triggerFilter = serverVersion >= 130000 ? 'NOT tg.tgisinternal AND tg.tgparentid = 0' : 'NOT tg.tgisinternal';
    // A procedure's CALL passes its OUT parameters too (PostgreSQL 14 and later).
    const allArgs = 'COALESCE(array_length(p.proallargtypes, 1), p.pronargs)';
    return `SELECT kind, oid, schema_name, name, args, arg_types, full_args, min_args, max_args, body_hash, detail,
       rel_schema, rel_name, rel_column, owner, language, comment, from_extension FROM (
    SELECT ${routineKind} AS kind, p.oid, n.nspname::text AS schema_name, p.proname::text AS name,
           pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
           ARRAY(SELECT pg_catalog.format_type(u.t, NULL) FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS u(t, i) ORDER BY u.i) AS arg_types,
           pg_catalog.pg_get_function_arguments(p.oid) AS full_args,
           CASE WHEN ${isProcedure} THEN ${allArgs} - p.pronargdefaults ELSE p.pronargs - p.pronargdefaults END AS min_args,
           CASE WHEN p.provariadic <> 0 THEN -1 WHEN ${isProcedure} THEN ${allArgs} ELSE p.pronargs END AS max_args,
           ${BODY_HASH_SQL} AS body_hash,
           CASE WHEN ${isProcedure} THEN NULL ELSE pg_catalog.pg_get_function_result(p.oid) END AS detail,
           NULL::text AS rel_schema, NULL::text AS rel_name, NULL::text AS rel_column,
           pg_catalog.pg_get_userbyid(p.proowner)::text AS owner, l.lanname::text AS language,
           pg_catalog.obj_description(p.oid, 'pg_proc') AS comment,
           ${member('pg_proc', 'p.oid')} AS from_extension
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    LEFT JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    WHERE ${inSchemas('n.nspname')}
      -- The constructors PostgreSQL creates with a range type are part of that type.
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend di
                      WHERE di.classid = 'pg_catalog.pg_proc'::regclass AND di.objid = p.oid AND di.deptype = 'i')
    UNION ALL
    SELECT CASE t.typtype WHEN 'd' THEN 'domain' ELSE 'type' END, t.oid, n.nspname::text, t.typname::text,
           NULL::text, NULL::text[], NULL::text, NULL::int, NULL::int, NULL::text,
           CASE t.typtype WHEN 'e' THEN 'enum' WHEN 'r' THEN 'range' WHEN 'c' THEN 'composite'
                ELSE pg_catalog.format_type(t.typbasetype, t.typtypmod) END,
           NULL::text, NULL::text, NULL::text,
           pg_catalog.pg_get_userbyid(t.typowner)::text, NULL::text,
           pg_catalog.obj_description(t.oid, 'pg_type'),
           ${member('pg_type', 't.oid')}
    FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    LEFT JOIN pg_catalog.pg_class c ON c.oid = t.typrelid
    WHERE (t.typtype IN ('e', 'r', 'd') OR (t.typtype = 'c' AND c.relkind = 'c')) AND ${inSchemas('n.nspname')}
    UNION ALL
    SELECT 'sequence', c.oid, n.nspname::text, c.relname::text, NULL::text, NULL::text[], NULL::text, NULL::int, NULL::int, NULL::text,
           pg_catalog.format_type(s.seqtypid, NULL),
           tn.nspname::text, tc.relname::text, ta.attname::text,
           pg_catalog.pg_get_userbyid(c.relowner)::text, NULL::text,
           pg_catalog.obj_description(c.oid, 'pg_class'),
           ${member('pg_class', 'c.oid')}
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_sequence s ON s.seqrelid = c.oid
    LEFT JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid
         AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.deptype = 'a'
    LEFT JOIN pg_catalog.pg_class tc ON tc.oid = d.refobjid
    LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
    LEFT JOIN pg_catalog.pg_attribute ta ON ta.attrelid = d.refobjid AND ta.attnum = d.refobjsubid
    WHERE c.relkind = 'S' AND ${inSchemas('n.nspname')}
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend di
                      WHERE di.classid = 'pg_catalog.pg_class'::regclass AND di.objid = c.oid AND di.deptype = 'i')
    UNION ALL
    SELECT 'trigger', tg.oid, n.nspname::text, tg.tgname::text, NULL::text, NULL::text[], NULL::text, NULL::int, NULL::int, NULL::text,
           NULL::text, n.nspname::text, c.relname::text, NULL::text, NULL::text, NULL::text,
           pg_catalog.obj_description(tg.oid, 'pg_trigger'),
           ${member('pg_class', 'c.oid')}
    FROM pg_catalog.pg_trigger tg
    JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE ${triggerFilter} AND ${inSchemas('n.nspname')}
    UNION ALL
    SELECT 'extension', e.oid, n.nspname::text, e.extname::text, NULL::text, NULL::text[], NULL::text, NULL::int, NULL::int, NULL::text,
           e.extversion::text, NULL::text, NULL::text, NULL::text,
           pg_catalog.pg_get_userbyid(e.extowner)::text, NULL::text,
           pg_catalog.obj_description(e.oid, 'pg_extension'), false
    FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
) objects
ORDER BY schema_name, name`;
}

/** Names of the functions PostgreSQL and the extensions bring along, and of every type. */
export const BUILTIN_NAMES_QUERY =
    `SELECT DISTINCT 'function' AS name_kind, p.proname::text AS name
     FROM pg_catalog.pg_proc p
     WHERE p.pronamespace IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
     UNION
     SELECT DISTINCT 'type', t.typname::text FROM pg_catalog.pg_type t`;

function text(row: Record<string, unknown>, key: string): string | null {
    const v = row[key];
    return v === null || v === undefined ? null : String(v);
}

/** One catalog row as a {@link DbObject}. */
export function toDbObject(row: Record<string, unknown>): DbObject | null {
    const kind = String(row.kind) as NavigatorKind;
    if (!NAVIGATOR_KINDS.includes(kind)) return null;
    const argTypes = row.arg_types;
    const obj: DbObject = {
        kind,
        oid: Number(row.oid),
        schema: String(row.schema_name),
        name: String(row.name),
        args: text(row, 'args'),
        argTypes: Array.isArray(argTypes) ? argTypes.map(String) : null,
        detail: text(row, 'detail'),
        relSchema: text(row, 'rel_schema'),
        relName: text(row, 'rel_name'),
        relColumn: text(row, 'rel_column'),
        owner: text(row, 'owner'),
        language: text(row, 'language'),
        comment: text(row, 'comment'),
        fromExtension: row.from_extension === true || row.from_extension === 't'
    };
    if (row.full_args !== undefined) obj.fullArgs = text(row, 'full_args');
    if (row.body_hash !== undefined) obj.bodyHash = text(row, 'body_hash');
    if (row.min_args !== null && row.min_args !== undefined) {
        const max = Number(row.max_args);
        obj.argCount = { min: Number(row.min_args), max: max < 0 ? Infinity : max };
    }
    return obj;
}

/** How the object is matched against the repository. */
export function dbObjectIdentity(obj: DbObject): ObjectIdentity {
    if (obj.kind === 'extension') return { kind: 'extension', schema: '', name: obj.name };
    if (obj.kind === 'trigger') return { kind: 'trigger', schema: obj.schema, name: obj.name, table: obj.relName ?? '' };
    return { kind: obj.kind, schema: obj.schema, name: obj.name, argTypes: obj.argTypes };
}

/** An object or relation of the database, as the editor features look it up. */
export interface DbEntry {
    kind: RepoObjectKind;
    schema: string;
    name: string;
    argCount?: ArgCount;
    /** The table of a trigger. */
    table?: string;
    object?: DbObject;
    relation?: DbRelation;
}

/** The objects and relations of the database by kind and name. */
export class DbIndex {
    private readonly byName = new Map<string, DbEntry[]>();

    constructor(objects: readonly DbObject[], relations: readonly DbRelation[], schemas: Iterable<string>) {
        for (const object of objects) {
            this.add({
                kind: object.kind,
                schema: object.kind === 'extension' ? '' : object.schema,
                name: object.name,
                argCount: object.argCount,
                table: object.kind === 'trigger' ? object.relName ?? undefined : undefined,
                object
            });
        }
        for (const relation of relations) this.add({ kind: relation.kind, schema: relation.schema, name: relation.name, relation });
        for (const schema of schemas) this.add({ kind: 'schema', schema: '', name: schema });
    }

    private add(entry: DbEntry): void {
        const key = `${entry.kind}:${entry.name}`;
        const list = this.byName.get(key);
        if (list) list.push(entry);
        else this.byName.set(key, [entry]);
    }

    /** The entries of a kind and name in a schema — any schema when null. */
    lookup(kind: RepoObjectKind, schema: string | null, name: string): DbEntry[] {
        const list = this.byName.get(`${kind}:${name}`) ?? [];
        return schema === null || kind === 'schema' || kind === 'extension' ? list : list.filter(e => e.schema === schema);
    }

    /** True when some object of any listed kind has this name, in any schema. */
    hasName(kinds: readonly RepoObjectKind[], name: string): boolean {
        return kinds.some(k => (this.byName.get(`${k}:${name}`)?.length ?? 0) > 0);
    }

    /** Every entry of the given kinds. */
    *entries(kinds: ReadonlySet<RepoObjectKind>): IterableIterator<DbEntry> {
        for (const list of this.byName.values()) {
            if (list.length > 0 && kinds.has(list[0].kind)) yield* list;
        }
    }
}

export class DatabaseCatalog implements vscode.Disposable {
    private data?: Promise<CatalogData>;
    private relationList?: Promise<DbRelation[]>;
    private unmarkedObjects?: Promise<UnmarkedObjects>;
    private builtinNames?: Promise<{ functions: Set<string>; types: Set<string> }>;
    private dbIndex?: Promise<DbIndex>;
    private readonly _onDidReset = new vscode.EventEmitter<void>();
    /** Fires when everything loaded was forgotten (connection changed, Refresh). */
    readonly onDidReset = this._onDidReset.event;
    /** The exact comparison of routine bodies, filled in the background. */
    readonly bodies: RoutineBodies;

    constructor(private readonly connection: CatalogConnection) {
        this.bodies = new RoutineBodies(connection);
    }

    isConnected(): boolean {
        return this.connection.isConnected();
    }

    /** Forget everything loaded; the next consumer loads again. */
    reset(): void {
        this.data = undefined;
        this.relationList = undefined;
        this.unmarkedObjects = undefined;
        this.builtinNames = undefined;
        this.dbIndex = undefined;
        this.bodies.clear();
        this._onDidReset.fire();
    }

    /** Reload from the database, bypassing the metadata cache. */
    refresh(): void {
        this.connection.clearMetadataCache();
        this.reset();
    }

    /** A promise kept until reset; a failed load is not kept, so the next call tries again. */
    private keep<T>(get: () => Promise<T> | undefined, set: (p: Promise<T> | undefined) => void, load: () => Promise<T>): Promise<T> {
        const existing = get();
        if (existing) return existing;
        const promise = load();
        set(promise);
        promise.catch(() => { if (get() === promise) set(undefined); });
        return promise;
    }

    allowedSchema(schema: string): boolean {
        const configSchemas = this.connection.getActiveConnectionConfig()?.schemas;
        if (configSchemas && configSchemas.length > 0) return configSchemas.includes(schema);
        return !SYSTEM_SCHEMAS.has(schema) && !schema.startsWith('pg_');
    }

    load(): Promise<CatalogData> {
        return this.keep(() => this.data, (p) => { this.data = p; }, () => this.fetch());
    }

    private async fetch(): Promise<CatalogData> {
        const started = Date.now();
        const configSchemas = this.connection.getActiveConnectionConfig()?.schemas;
        const restrict = !!configSchemas && configSchemas.length > 0;
        const schemaQuery = buildSchemaListQuery(configSchemas);
        const [versionRows, schemaRows, searchPathRows] = await Promise.all([
            this.connection.queryMetadata(SERVER_VERSION_QUERY),
            this.connection.queryMetadata(schemaQuery.sql, schemaQuery.params),
            this.connection.queryMetadata(CURRENT_SCHEMAS_QUERY)
        ]);
        const serverVersion = Number(versionRows[0]?.server_version_num ?? 0);
        const rows = await this.connection.queryMetadata(
            buildObjectCatalogQuery(serverVersion, restrict),
            restrict ? [configSchemas] : undefined
        );
        const objects = rows.map(toDbObject).filter((o): o is DbObject => o !== null);
        const schemas = new Set(schemaRows.map(r => String(r.schema_name)));
        for (const o of objects) {
            if (o.kind !== 'extension') schemas.add(o.schema);
        }
        const searchPath = searchPathRows.map(r => String(r.schema_name));
        Logger.log('DatabaseCatalog.fetch', `${objects.length} objects in ${Date.now() - started} ms`);
        return { objects, schemas, defaultSchema: searchPath[0] ?? 'public', searchPath, serverVersion };
    }

    /** Every relation the Tables view may show; one cached query across all schemas. */
    relations(): Promise<DbRelation[]> {
        return this.keep(() => this.relationList, (p) => { this.relationList = p; }, async () => {
            const rows = await this.connection.queryMetadata(buildRelationListQuery());
            return rows
                .filter(row => this.allowedSchema(String(row.table_schema)))
                .map(row => ({ schema: String(row.table_schema), name: String(row.table_name), kind: toRelationKind(row.rel_kind) }));
        });
    }

    /** What extensions and PostgreSQL provide, which is never compared with the repository. */
    unmarked(): Promise<UnmarkedObjects> {
        return this.keep(() => this.unmarkedObjects, (p) => { this.unmarkedObjects = p; },
            async () => new UnmarkedObjects(await this.connection.queryMetadata(EXTENSION_MEMBERS_QUERY)));
    }

    /** Names of built-in and extension functions, and of all types. */
    builtins(): Promise<{ functions: Set<string>; types: Set<string> }> {
        return this.keep(() => this.builtinNames, (p) => { this.builtinNames = p; }, async () => {
            const rows = await this.connection.queryMetadata(BUILTIN_NAMES_QUERY);
            const functions = new Set<string>();
            const types = new Set<string>();
            for (const row of rows) (row.name_kind === 'type' ? types : functions).add(String(row.name));
            return { functions, types };
        });
    }

    /** The objects and relations of the database by kind and name. */
    index(): Promise<DbIndex> {
        return this.keep(() => this.dbIndex, (p) => { this.dbIndex = p; }, async () => {
            const [data, relations] = await Promise.all([this.load(), this.relations()]);
            return new DbIndex(data.objects, relations, data.schemas);
        });
    }

    dispose(): void {
        this._onDidReset.dispose();
        this.bodies.dispose();
    }
}

/** Reads the bodies of routines by oid; `$1` is an `oid[]`. */
export const ROUTINE_BODIES_QUERY = 'SELECT p.oid::bigint AS oid, p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = ANY($1::oid[])';

/** How many bodies one query reads. */
const BODY_BATCH = 200;

/**
 * The exact comparison of routine bodies, the second of two stages. The
 * catalog query's hash ignores whitespace and letter case only; a routine it
 * calls different may still differ in comments alone, e.g. a `-- note` that a
 * migration tool turned into `/* note *\/`. Only for those routines the bodies
 * are read — in batches, in the background, without the metadata cache — and
 * compared token by token without comments. Until the answer is in, such a
 * routine counts as the same, so nothing is marked that turns out equal.
 */
export class RoutineBodies implements vscode.Disposable {
    private readonly hashes = new Map<number, { bodyHash: string; tokenHash: string }>();
    private readonly pending = new Set<number>();
    private readonly failed = new Set<number>();
    private running?: Promise<void>;
    private generation = 0;
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    /** Fires after a batch of bodies was compared. */
    readonly onDidChange = this._onDidChange.event;

    constructor(private readonly connection: CatalogConnection, private readonly batchSize = BODY_BATCH) {}

    /** Where a database routine exists, with comments and whitespace of its body ignored. */
    status(db: DbObject, definitions: readonly LocatedDefinition[]): RepoStatus {
        const fast = routineStatus(db, definitions);
        if (fast !== 'differs' || !db.bodyHash) return fast;
        const known = this.hashes.get(db.oid);
        if (known && known.bodyHash === db.bodyHash) {
            const tokens = definitions.map(d => d.tokenHash).filter((h): h is string => !!h);
            return tokens.length === 0 || tokens.includes(known.tokenHash) ? 'both' : 'differs';
        }
        if (this.failed.has(db.oid)) return fast;
        this.request(db.oid);
        return 'both';
    }

    /** True while bodies are waiting to be compared. */
    get busy(): boolean {
        return this.pending.size > 0 || this.running !== undefined;
    }

    /** The comment-insensitive hash of a body read so far, while it still matches the catalog's hash. */
    tokenHashOf(db: Pick<DbObject, 'oid' | 'bodyHash'>): string | undefined {
        const known = this.hashes.get(db.oid);
        return known && known.bodyHash === db.bodyHash ? known.tokenHash : undefined;
    }

    /** Wait until every requested body has been compared (tests, the full comparison). */
    async settled(): Promise<void> {
        while (this.running) await this.running;
    }

    clear(): void {
        this.generation++;
        this.hashes.clear();
        this.pending.clear();
        this.failed.clear();
    }

    private request(oid: number): void {
        this.pending.add(oid);
        if (!this.running) {
            this.running = this.drain().finally(() => { this.running = undefined; });
        }
    }

    private async drain(): Promise<void> {
        // Collect what the current render asks for before the first query.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        const generation = this.generation;
        while (this.pending.size > 0 && generation === this.generation) {
            const batch = [...this.pending].slice(0, this.batchSize);
            batch.forEach(oid => this.pending.delete(oid));
            try {
                const rows = this.connection.query
                    ? (await this.connection.query(ROUTINE_BODIES_QUERY, [batch])).rows
                    : await this.connection.queryMetadata(ROUTINE_BODIES_QUERY, [batch]);
                if (generation !== this.generation) return;
                for (const row of rows) {
                    const source = String(row.prosrc ?? '');
                    this.hashes.set(Number(row.oid), { bodyHash: routineBodyHash(source), tokenHash: routineTokenHash(source) });
                }
                // A routine dropped meanwhile has no row; it is not asked for again.
                for (const oid of batch) if (!this.hashes.has(oid)) this.failed.add(oid);
            } catch (err: unknown) {
                Logger.error('RoutineBodies.drain', err);
                batch.forEach(oid => this.failed.add(oid));
            }
            this._onDidChange.fire();
        }
    }

    dispose(): void {
        this.clear();
        this._onDidChange.dispose();
    }
}
