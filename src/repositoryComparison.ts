/**
 * Compares the objects of the database with the CREATE statements found in the
 * repository. Pure: the caller hands in both sides and gets back which
 * definitions belong to an object and which definitions match no object.
 */
import { normalizeTypeName, ROUTINE_KINDS, type RepoDefinition, type RepoObjectKind } from './repositoryScanner';

export interface LocatedDefinition extends RepoDefinition {
    /** URI (string form) of the file the definition is in. */
    uri: string;
}

/** What identifies an object on both sides: in the database and in the repository. */
export interface ObjectIdentity {
    kind: RepoObjectKind;
    /** Schema of the object; for a trigger the schema of its table; empty for schemas and extensions. */
    schema: string;
    name: string;
    /** Identity argument types of a routine; normalised with {@link normalizeTypeName} before they are compared. */
    argTypes?: string[] | null;
    /** The table a trigger is defined on. */
    table?: string;
}

/**
 * Where an object exists: in both places, only in the database, or only in the
 * repository; `differs` when the body of a routine in the database matches
 * none of its definitions in the repository.
 */
export type RepoStatus = 'both' | 'dbOnly' | 'repoOnly' | 'differs';

/** Definitions in the repository that no object in the database answers to. */
export interface RepoOnlyObject {
    identity: ObjectIdentity;
    definitions: LocatedDefinition[];
}

/** Reads the schemas of the connection's search_path; its first entry is where an unqualified CREATE ends up. */
export const CURRENT_SCHEMAS_QUERY = 'SELECT unnest(current_schemas(false)) AS schema_name';

/**
 * Schemas and relations that belong to an extension, such as the `oracle` and
 * `dbms_*` schemas of orafce or the views of pg_stat_statements: the extension
 * creates them, so no repository has to, and they are never marked.
 */
export const EXTENSION_MEMBERS_QUERY =
    `SELECT CASE WHEN d.classid = 'pg_catalog.pg_namespace'::regclass THEN 'schema' ELSE 'relation' END AS member_kind,
            COALESCE(n.nspname, cn.nspname)::text AS schema_name, c.relname::text AS name
     FROM pg_catalog.pg_depend d
     LEFT JOIN pg_catalog.pg_namespace n ON d.classid = 'pg_catalog.pg_namespace'::regclass AND n.oid = d.objid
     LEFT JOIN pg_catalog.pg_class c ON d.classid = 'pg_catalog.pg_class'::regclass AND c.oid = d.objid
     LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid = c.relnamespace
     WHERE d.deptype = 'e' AND d.classid IN ('pg_catalog.pg_namespace'::regclass, 'pg_catalog.pg_class'::regclass)`;

/** What the database itself or an extension provides, and so is never compared with the repository. */
export class UnmarkedObjects {
    private readonly members = new Set<string>();

    constructor(extensionMembers: ReadonlyArray<Record<string, unknown>>) {
        for (const row of extensionMembers) {
            this.members.add(row.member_kind === 'schema'
                ? `schema:${String(row.schema_name)}`
                : `relation:${String(row.schema_name)}.${String(row.name)}`);
        }
    }

    /** The internal `pg_*` schemas (temporary and toast schemas) and the schemas of extensions. */
    schema(name: string): boolean {
        return name.startsWith('pg_') || this.members.has(`schema:${name}`);
    }

    /** A relation of an extension, or any relation in a schema that is never marked. */
    relation(schema: string, name: string): boolean {
        return this.schema(schema) || this.members.has(`relation:${schema}.${name}`);
    }
}

/** The definitions of the repository at one point in time. */
export interface RepositorySnapshot {
    /** Grows with every change, so a consumer can tell whether it has to match again. */
    version: number;
    definitions: readonly LocatedDefinition[];
}

/** Where the trees get the repository's definitions from. */
export interface RepositorySource {
    /** The current definitions; null while the comparison is turned off or the first scan has not finished. */
    snapshot(): RepositorySnapshot | null;
    /** Start the background scan unless it already runs or ran. Never waits for it. */
    ensureScanned(): void;
}

/**
 * Keeps one {@link DefinitionMatcher} for as long as neither the definitions
 * nor the default schema change. Returns null when there is nothing to compare
 * with: no snapshot yet, or a repository without a single CREATE statement —
 * then the trees mark nothing at all instead of marking everything red.
 */
export class MatcherCache {
    private last?: { version: number; defaultSchema: string; matcher: DefinitionMatcher };

    get(snapshot: RepositorySnapshot | null, defaultSchema: string): DefinitionMatcher | null {
        if (!snapshot || snapshot.definitions.length === 0) return null;
        if (this.last && this.last.version === snapshot.version && this.last.defaultSchema === defaultSchema) {
            return this.last.matcher;
        }
        const matcher = new DefinitionMatcher(snapshot.definitions, defaultSchema);
        this.last = { version: snapshot.version, defaultSchema, matcher };
        return matcher;
    }
}

/** The status of an object that exists in the database, given its definitions in the repository. */
export function databaseObjectStatus(definitions: readonly LocatedDefinition[]): RepoStatus {
    return definitions.length > 0 ? 'both' : 'dbOnly';
}

/**
 * Where a database object exists. A routine whose body matches none of its
 * repository definitions differs; matching any definition — also an older
 * migration — counts as the same.
 */
export function routineStatus(db: { kind: string; bodyHash?: string | null }, definitions: readonly LocatedDefinition[]): RepoStatus {
    const status = databaseObjectStatus(definitions);
    if (status !== 'both' || (db.kind !== 'function' && db.kind !== 'procedure') || !db.bodyHash) return status;
    const hashes = definitions.map(d => d.bodyHash).filter((h): h is string => !!h);
    return hashes.length > 0 && !hashes.includes(db.bodyHash) ? 'differs' : status;
}

/** The differences a full comparison found, by object; the trees mark these objects as differing. */
export interface ComparisonMarks {
    differences(kind: RepoObjectKind, schema: string, name: string, table?: string): ReadonlyArray<{ path: string; message: string }> | undefined;
}

/** A definition together with the identity it stands for. */
export interface IndexedDefinition {
    def: LocatedDefinition;
    identity: ObjectIdentity;
}

function baseKey(identity: ObjectIdentity): string {
    switch (identity.kind) {
        case 'schema':
        case 'extension':
            return `${identity.kind}:${identity.name}`;
        case 'trigger':
            return `trigger:${identity.schema}.${identity.table ?? ''}.${identity.name}`;
        default:
            return `${identity.kind}:${identity.schema}.${identity.name}`;
    }
}

/** Two argument lists are the same signature; `'?'` (a `%TYPE` argument) matches any type. */
export function argumentTypesMatch(repo: readonly string[], db: readonly string[]): boolean {
    if (repo.length !== db.length) return false;
    return repo.every((t, i) => t === '?' || t === db[i]);
}

/**
 * Matches database objects against the definitions of the repository.
 * `defaultSchema` is where an unqualified name ends up when its file sets no
 * search_path: the first schema of the connection's search_path.
 */
export class DefinitionMatcher {
    private readonly byBase = new Map<string, IndexedDefinition[]>();
    private readonly byName = new Map<string, IndexedDefinition[]>();
    private readonly count: number;

    constructor(definitions: readonly LocatedDefinition[], private readonly defaultSchema: string) {
        for (const def of definitions) {
            const identity = this.identityOf(def);
            const entry = { def, identity };
            const key = baseKey(identity);
            const list = this.byBase.get(key);
            if (list) list.push(entry);
            else this.byBase.set(key, [entry]);
            const nameKey = `${identity.kind}:${identity.name}`;
            const named = this.byName.get(nameKey);
            if (named) named.push(entry);
            else this.byName.set(nameKey, [entry]);
        }
        this.count = definitions.length;
    }

    /**
     * The definitions of a kind and name in a schema — any schema when
     * `schema` is null. A trigger's schema is the schema of its table;
     * schemas and extensions have none.
     */
    lookup(kind: RepoObjectKind, schema: string | null, name: string): IndexedDefinition[] {
        const list = this.byName.get(`${kind}:${name}`) ?? [];
        return schema === null || kind === 'schema' || kind === 'extension' ? list : list.filter(e => e.identity.schema === schema);
    }

    /** Every definition with its identity, for searches over all of them. */
    *entries(): IterableIterator<IndexedDefinition> {
        for (const list of this.byBase.values()) yield* list;
    }

    /** True when the repository has no definition at all — then nothing is marked. */
    get isEmpty(): boolean {
        return this.count === 0;
    }

    private resolveSchema(schema: string | null, searchPath: string[] | null): string {
        return schema ?? searchPath?.[0] ?? this.defaultSchema;
    }

    /** The identity a definition stands for, with its schema resolved. */
    identityOf(def: RepoDefinition): ObjectIdentity {
        if (def.kind === 'schema' || def.kind === 'extension') {
            return { kind: def.kind, schema: '', name: def.name };
        }
        if (def.kind === 'trigger') {
            return {
                kind: 'trigger',
                schema: this.resolveSchema(def.table?.schema ?? null, def.searchPath),
                name: def.name,
                table: def.table?.name ?? ''
            };
        }
        const identity: ObjectIdentity = { kind: def.kind, schema: this.resolveSchema(def.schema, def.searchPath), name: def.name };
        if (ROUTINE_KINDS.has(def.kind)) identity.argTypes = def.argTypes;
        return identity;
    }

    private candidates(object: ObjectIdentity): IndexedDefinition[] {
        const list = this.byBase.get(baseKey(object)) ?? [];
        if (!ROUTINE_KINDS.has(object.kind)) return list;
        const dbArgs = object.argTypes ? object.argTypes.map(normalizeTypeName) : null;
        return list.filter(({ identity }) => !identity.argTypes || !dbArgs || argumentTypesMatch(identity.argTypes, dbArgs));
    }

    /** Every definition of `object` in the repository, in the order they were handed in. */
    find(object: ObjectIdentity): LocatedDefinition[] {
        return this.candidates(object).map(c => c.def);
    }

    /**
     * The definitions of the given kinds that answer to none of `dbObjects`,
     * grouped by the object they define (one object may be created in several
     * files) and sorted by schema and name.
     */
    unmatched(dbObjects: readonly ObjectIdentity[], kinds: ReadonlySet<RepoObjectKind>): RepoOnlyObject[] {
        const matched = new Set<LocatedDefinition>();
        for (const object of dbObjects) {
            if (!kinds.has(object.kind)) continue;
            for (const c of this.candidates(object)) matched.add(c.def);
        }
        const groups = new Map<string, RepoOnlyObject>();
        for (const list of this.byBase.values()) {
            for (const { def, identity } of list) {
                if (!kinds.has(identity.kind) || matched.has(def)) continue;
                const key = `${baseKey(identity)}(${identity.argTypes ? identity.argTypes.join(',') : ''})`;
                const group = groups.get(key);
                if (group) group.definitions.push(def);
                else groups.set(key, { identity, definitions: [def] });
            }
        }
        return [...groups.values()].sort((a, b) =>
            a.identity.schema.localeCompare(b.identity.schema)
            || a.identity.name.localeCompare(b.identity.name)
            || (a.identity.table ?? '').localeCompare(b.identity.table ?? ''));
    }
}
