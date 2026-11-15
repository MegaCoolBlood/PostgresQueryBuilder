/**
 * What a reference in SQL code resolves to, in the repository and in the
 * database — the one place every editor feature (definition, references,
 * hover, signature help, diagnostics, Reveal) resolves names.
 *
 * A qualified name is looked up in its schema. An unqualified one follows the
 * search_path the file sets, else the connection's; the first schema with a
 * hit wins, as in PostgreSQL. Without a connection any schema matches. Calls
 * are narrowed to the overloads that take as many arguments; when none does,
 * every overload is kept.
 */
import { acceptsArgCount, normalizeTypeName, type RepoObjectKind } from './repositoryScanner';
import { argumentTypesMatch, type DefinitionMatcher, type IndexedDefinition, type LocatedDefinition } from './repositoryComparison';
import { dbObjectIdentity, type DbEntry, type DbIndex } from './databaseCatalog';
import type { SqlReference } from './sqlReferences';

export interface ResolvedObject {
    kind: RepoObjectKind;
    /** '' for schemas and extensions. */
    schema: string;
    name: string;
    /** The table of a trigger. */
    table?: string;
    /** Its CREATE statements in the repository. */
    definitions: LocatedDefinition[];
    /** The object in the database, when it exists there. */
    db?: DbEntry;
}

export interface ResolutionSources {
    matcher: DefinitionMatcher | null;
    db: DbIndex | null;
    /** The connection's search_path; null when not connected. */
    searchPath: string[] | null;
}

const KIND_GROUPS: ReadonlyArray<readonly RepoObjectKind[]> = [
    ['table', 'view', 'matview', 'foreign'],
    ['function', 'procedure', 'aggregate'],
    ['type', 'domain'],
    ['sequence'],
    ['trigger'],
    ['schema'],
    ['extension']
];

/** The kinds of a reference in groups that share a namespace, most likely group first. */
function kindGroups(kinds: readonly RepoObjectKind[]): RepoObjectKind[][] {
    const groups: RepoObjectKind[][] = [];
    for (const kind of kinds) {
        const group = KIND_GROUPS.find(g => g.includes(kind))!;
        const existing = groups.find(g => group.includes(g[0]));
        if (existing) {
            if (!existing.includes(kind)) existing.push(kind);
        } else {
            groups.push([kind]);
        }
    }
    return groups;
}

/** The schemas a reference is looked up in, in order; `null` means any schema. */
export function candidateSchemas(ref: Pick<SqlReference, 'schema' | 'searchPath' | 'kinds'>, connectionSearchPath: string[] | null): Array<string | null> {
    if (ref.kinds.every(k => k === 'schema' || k === 'extension')) return [null];
    if (ref.schema !== null) return [ref.schema];
    const path = ref.searchPath ?? connectionSearchPath;
    if (!path || path.length === 0) return [null];
    return [...new Set(path)];
}

function routineKey(kind: RepoObjectKind, schema: string, name: string, args: readonly string[] | null | undefined): string {
    return `${kind}:${schema}.${name}(${(args ?? []).join(',')})`;
}

/** The objects a reference stands for; empty when neither the repository nor the database knows the name. */
export function resolveReference(ref: SqlReference, sources: ResolutionSources): ResolvedObject[] {
    const { matcher, db } = sources;
    for (const group of kindGroups(ref.kinds)) {
        const routine = group.some(k => k === 'function' || k === 'procedure' || k === 'aggregate');
        for (const schema of candidateSchemas({ ...ref, kinds: group }, sources.searchPath)) {
            let defs: IndexedDefinition[] = [];
            let dbs: DbEntry[] = [];
            for (const kind of group) {
                if (matcher) defs.push(...matcher.lookup(kind, schema, ref.name));
                if (db) dbs.push(...db.lookup(kind, schema, ref.name));
            }
            if (ref.table && group.includes('trigger')) {
                defs = defs.filter(d => d.identity.table === ref.table!.name);
                dbs = dbs.filter(d => d.table === ref.table!.name);
            }
            if (routine && ref.argCount !== null) {
                const count = ref.argCount;
                const fitDefs = defs.filter(d => acceptsArgCount(d.def.argCount, count));
                const fitDbs = dbs.filter(d => acceptsArgCount(d.argCount, count));
                if (fitDefs.length + fitDbs.length > 0) {
                    defs = fitDefs;
                    dbs = fitDbs;
                }
            }
            if (defs.length + dbs.length > 0) return combine(defs, dbs, matcher);
        }
    }
    return [];
}

/** One object per database entry with its definitions, then the definitions no database entry has. */
function combine(defs: IndexedDefinition[], dbs: DbEntry[], matcher: DefinitionMatcher | null): ResolvedObject[] {
    const result: ResolvedObject[] = [];
    const used = new Set<LocatedDefinition>();
    for (const entry of dbs) {
        const identity = entry.object
            ? dbObjectIdentity(entry.object)
            : { kind: entry.kind, schema: entry.schema, name: entry.name };
        const definitions = matcher?.find(identity) ?? [];
        definitions.forEach(d => used.add(d));
        result.push({ kind: entry.kind, schema: entry.schema, name: entry.name, table: entry.table, definitions, db: entry });
    }
    const repoOnly = new Map<string, ResolvedObject>();
    for (const { def, identity } of defs) {
        if (used.has(def)) continue;
        const key = routineKey(identity.kind, identity.schema, identity.name, identity.argTypes) + (identity.table ?? '');
        const existing = repoOnly.get(key);
        if (existing) existing.definitions.push(def);
        else repoOnly.set(key, { kind: identity.kind, schema: identity.schema, name: identity.name, table: identity.table, definitions: [def] });
    }
    return [...result, ...repoOnly.values()];
}

/** Two resolved objects are the same object (same kind group, schema, name and, for routines, signature). */
export function sameObject(a: ResolvedObject, b: ResolvedObject): boolean {
    const groupOf = (k: RepoObjectKind): number => KIND_GROUPS.findIndex(g => g.includes(k));
    if (groupOf(a.kind) !== groupOf(b.kind) || a.schema !== b.schema || a.name !== b.name) return false;
    if ((a.table ?? '') !== (b.table ?? '')) return false;
    if (a.db?.object && b.db?.object) return a.db.object.oid === b.db.object.oid;
    const argsOf = (o: ResolvedObject): string[] | null =>
        o.db?.object?.argTypes?.map(normalizeTypeName) ?? o.definitions[0]?.argTypes ?? null;
    const x = argsOf(a);
    const y = argsOf(b);
    return !x || !y || argumentTypesMatch(x, y) || argumentTypesMatch(y, x);
}
