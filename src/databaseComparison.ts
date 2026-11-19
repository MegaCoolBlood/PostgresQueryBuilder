/**
 * *Compare Repository with Database*: every function, procedure, table, view,
 * type, domain, sequence and trigger of the database compared with the
 * repository — whether it exists on both sides, and what differs.
 *
 * The database is read with a handful of catalog queries for all objects at
 * once, inside one transaction that is always rolled back. Views are the
 * exception: PostgreSQL stores a view's query rewritten, so the repository's
 * query is created as a temporary view in that transaction and both are
 * printed by `pg_get_viewdef` — the temporary view is gone with the rollback.
 */
import { dbObjectIdentity, definitionTokenHash, type CatalogData, type DbObject, type DbRelation } from './databaseCatalog';
import type { DefinitionMatcher, LocatedDefinition, ObjectIdentity, UnmarkedObjects } from './repositoryComparison';
import { ROUTINE_KINDS, type RepoObjectKind } from './repositoryScanner';
import { parseArgumentList } from './sqlCodeIntel';
import {
    applyAlterType,
    columnType,
    compareSequences,
    compareSignatures,
    compareTables,
    compareTriggers,
    compareTypes,
    parseConstraint,
    parseCreateIndex,
    parseCreateTrigger,
    parseCreateType,
    parseSequenceOptions,
    normalizeExpression,
    sameViewDefinition,
    sequenceModel,
    statementTokens,
    tableModels,
    viewQuery,
    type ConstraintModel,
    type Difference,
    type IndexModel,
    type StructureStatement,
    type TableModel,
    type TableStatement,
    type TypeModel
} from './ddlCompare';
import { getErrorMessage } from './logger';

export type ComparisonStatus = 'differs' | 'dbOnly' | 'repoOnly';

export interface ComparisonEntry {
    kind: RepoObjectKind;
    /** Empty for extensions. */
    schema: string;
    name: string;
    /** The table of a trigger. */
    table?: string;
    /** The identity arguments of a routine. */
    args?: string | null;
    status: ComparisonStatus;
    differences: Difference[];
    definitions: LocatedDefinition[];
    db?: DbObject;
    relation?: DbRelation;
    /** For a table that differs: what the repository makes of it and what the database has, for the ALTER TABLE script. */
    tables?: { repo: TableModel; db: TableModel; searchPath: string[] | null };
}

export interface ComparisonResult {
    entries: ComparisonEntry[];
    /** Objects found equal on both sides. */
    equal: number;
    finishedAt: number;
    durationMs: number;
    /** Problems that left parts uncompared, e.g. a catalog query that failed. */
    problems: string[];
    cancelled: boolean;
}

export type ComparisonKind = 'routines' | 'tables' | 'views' | 'types' | 'sequences' | 'triggers';

export const COMPARISON_KINDS: readonly ComparisonKind[] = ['routines', 'tables', 'views', 'types', 'sequences', 'triggers'];

/** The object kinds each kind of the comparison covers. */
export const COMPARISON_KIND_MEMBERS: Record<ComparisonKind, readonly RepoObjectKind[]> = {
    routines: ['function', 'procedure', 'aggregate'],
    tables: ['table'],
    views: ['view', 'matview'],
    types: ['type', 'domain'],
    sequences: ['sequence'],
    triggers: ['trigger']
};

/** A located statement of the repository. */
export interface LocatedStatement extends StructureStatement {
    uri: string;
}

export interface ComparisonClient {
    query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface ComparisonInput {
    client: ComparisonClient;
    catalog: CatalogData;
    relations: readonly DbRelation[];
    unmarked: UnmarkedObjects;
    allowedSchema(schema: string): boolean;
    matcher: DefinitionMatcher;
    statements: readonly LocatedStatement[];
    /** The exact body comparison: the comment-insensitive hash of a database body, once read. */
    bodies: {
        status(db: DbObject, definitions: readonly LocatedDefinition[]): unknown;
        settled(): Promise<void>;
        tokenHashOf(db: DbObject): string | undefined;
        /** Whether `varchar` and `character varying` and the like count as the same; true when missing. */
        readonly ignoreTypeSpelling?: boolean;
    };
    kinds?: readonly ComparisonKind[];
    columnOrder?: boolean;
    isCancelled?(): boolean;
    report?(message: string): void;
}

// ===== Catalog queries =====

const SCHEMA_FILTER = (col: string): string => `${col} NOT IN ('pg_catalog', 'information_schema') AND ${col} NOT LIKE 'pg\\_%'`;

export const TABLE_COLUMNS_QUERY = `SELECT n.nspname::text AS schema_name, c.relname::text AS table_name, a.attname::text AS column_name,
       pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type, a.attnotnull AS not_null,
       pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expr, a.attidentity::text AS identity, a.attgenerated::text AS generated
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped AND ${SCHEMA_FILTER('n.nspname')}
ORDER BY n.nspname, c.relname, a.attnum`;

export const TABLE_CONSTRAINTS_QUERY = `SELECT n.nspname::text AS schema_name, c.relname::text AS table_name, con.conname::text AS constraint_name,
       pg_catalog.pg_get_constraintdef(con.oid) AS definition
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND con.contype IN ('p', 'u', 'f', 'c', 'x') AND con.conislocal AND ${SCHEMA_FILTER('n.nspname')}`;

/** Indexes of tables and materialized views, without those a constraint owns. */
export const INDEXES_QUERY = `SELECT n.nspname::text AS schema_name, t.relname::text AS table_name, i.relname::text AS index_name,
       pg_catalog.pg_get_indexdef(ix.indexrelid) AS definition
FROM pg_catalog.pg_index ix
JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
WHERE t.relkind IN ('r', 'p', 'm') AND ${SCHEMA_FILTER('n.nspname')}
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con
                  WHERE con.conindid = ix.indexrelid AND con.conrelid = ix.indrelid AND con.contype IN ('p', 'u', 'x'))`;

export const ENUMS_QUERY = `SELECT n.nspname::text AS schema_name, t.typname::text AS type_name,
       array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
FROM pg_catalog.pg_type t
JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
WHERE ${SCHEMA_FILTER('n.nspname')}
GROUP BY n.nspname, t.typname`;

export const COMPOSITES_QUERY = `SELECT n.nspname::text AS schema_name, t.typname::text AS type_name, a.attname::text AS attribute_name,
       pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type
FROM pg_catalog.pg_type t
JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
JOIN pg_catalog.pg_class c ON c.oid = t.typrelid AND c.relkind = 'c'
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
WHERE ${SCHEMA_FILTER('n.nspname')}
ORDER BY n.nspname, t.typname, a.attnum`;

export const RANGES_QUERY = `SELECT n.nspname::text AS schema_name, t.typname::text AS type_name, pg_catalog.format_type(r.rngsubtype, NULL) AS subtype
FROM pg_catalog.pg_range r
JOIN pg_catalog.pg_type t ON t.oid = r.rngtypid
JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
WHERE ${SCHEMA_FILTER('n.nspname')}`;

export const DOMAINS_QUERY = `SELECT n.nspname::text AS schema_name, t.typname::text AS type_name,
       pg_catalog.format_type(t.typbasetype, t.typtypmod) AS base_type, t.typnotnull AS not_null, t.typdefault AS default_expr,
       ARRAY(SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c
             WHERE c.contypid = t.oid AND c.contype = 'c' ORDER BY c.conname) AS checks
FROM pg_catalog.pg_type t
JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
WHERE t.typtype = 'd' AND ${SCHEMA_FILTER('n.nspname')}`;

export const SEQUENCES_QUERY = `SELECT n.nspname::text AS schema_name, c.relname::text AS sequence_name,
       pg_catalog.format_type(s.seqtypid, NULL) AS data_type, s.seqstart::text AS start_value, s.seqincrement::text AS increment,
       s.seqmax::text AS max_value, s.seqmin::text AS min_value, s.seqcache::text AS cache, s.seqcycle AS cycle
FROM pg_catalog.pg_sequence s
JOIN pg_catalog.pg_class c ON c.oid = s.seqrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE ${SCHEMA_FILTER('n.nspname')}`;

export const TRIGGERS_QUERY = `SELECT n.nspname::text AS schema_name, c.relname::text AS table_name, tg.tgname::text AS trigger_name,
       pg_catalog.pg_get_triggerdef(tg.oid) AS definition
FROM pg_catalog.pg_trigger tg
JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE NOT tg.tgisinternal AND ${SCHEMA_FILTER('n.nspname')}`;

const VIEW_NAME = 'pqb_compare_view';

// ===== Helpers =====

const key = (schema: string, name: string): string => `${schema}.${name}`;

function group<T>(rows: Array<Record<string, unknown>>, keyOf: (r: Record<string, unknown>) => string, map: (r: Record<string, unknown>) => T): Map<string, T[]> {
    const out = new Map<string, T[]>();
    for (const row of rows) {
        const k = keyOf(row);
        const list = out.get(k);
        if (list) list.push(map(row));
        else out.set(k, [map(row)]);
    }
    return out;
}

const rowKey = (col: string) => (r: Record<string, unknown>): string => key(String(r.schema_name), String(r[col]));

/** The natural order of the files (`58_…` before `105_…`), then the place in the file. */
export function statementOrder(a: LocatedStatement, b: LocatedStatement): number {
    return a.uri.localeCompare(b.uri, undefined, { numeric: true }) || a.offset - b.offset;
}

/** The schema an unqualified statement ends up in. */
function schemaOf(stmt: { schema: string | null; searchPath: string[] | null }, defaultSchema: string): string {
    return stmt.schema ?? stmt.searchPath?.[0] ?? defaultSchema;
}

/** The repository statements grouped by the object they shape. */
export class StatementIndex {
    private readonly byKey = new Map<string, LocatedStatement[]>();
    private readonly dropIndexes = new Map<string, LocatedStatement[]>();

    constructor(statements: readonly LocatedStatement[], private readonly defaultSchema: string) {
        for (const s of [...statements].sort(statementOrder)) {
            let k: string;
            switch (s.type) {
                case 'createTable':
                case 'alterTable':
                    k = `table:${key(schemaOf(s, defaultSchema), s.name)}`;
                    break;
                case 'createIndex':
                    k = `table:${key(schemaOf({ schema: s.table!.schema, searchPath: s.searchPath }, defaultSchema), s.table!.name)}`;
                    break;
                case 'dropIndex': {
                    const dk = key(schemaOf(s, defaultSchema), s.name);
                    const list = this.dropIndexes.get(dk);
                    if (list) list.push(s);
                    else this.dropIndexes.set(dk, [s]);
                    continue;
                }
                case 'createView':
                    k = `view:${key(schemaOf(s, defaultSchema), s.name)}`;
                    break;
                case 'createType':
                case 'alterType':
                    k = `type:${key(schemaOf(s, defaultSchema), s.name)}`;
                    break;
                case 'createSequence':
                case 'alterSequence':
                    k = `sequence:${key(schemaOf(s, defaultSchema), s.name)}`;
                    break;
                case 'createTrigger':
                    k = `trigger:${key(schemaOf({ schema: s.table!.schema, searchPath: s.searchPath }, defaultSchema), s.table!.name)}.${s.name}`;
                    break;
                default:
                    continue;
            }
            const list = this.byKey.get(k);
            if (list) list.push(s);
            else this.byKey.set(k, [s]);
        }
    }

    get(k: string): LocatedStatement[] {
        return this.byKey.get(k) ?? [];
    }

    /** The statements of a table in order, with the DROP INDEX of its indexes merged in. */
    tableStatements(schema: string, table: string): TableStatement[] {
        const own = this.get(`table:${key(schema, table)}`);
        const indexNames = new Set(own.filter(s => s.type === 'createIndex').map(s => key(schema, s.name)));
        const drops = [...indexNames].flatMap(n => this.dropIndexes.get(n) ?? []);
        return [...own, ...drops].sort(statementOrder).map((s): TableStatement => (s.type === 'dropIndex'
            ? { type: 'dropIndex', name: s.name }
            : { type: s.type as 'createTable' | 'alterTable' | 'createIndex', toks: statementTokens(s.text) }));
    }
}

/** The models of a type the repository allows: one per `CREATE`, folded with the following `ALTER`s. */
function typeModels(statements: readonly LocatedStatement[]): TypeModel[] {
    const models: TypeModel[] = [];
    let current: TypeModel | null = null;
    for (const s of statements) {
        if (s.type === 'createType') {
            if (current) models.push(current);
            current = parseCreateType(statementTokens(s.text));
        } else if (current) {
            current = applyAlterType(current, statementTokens(s.text));
        }
    }
    if (current) models.push(current);
    return models;
}

/** The smallest list of differences, empty as soon as one candidate matches. */
function best(candidates: Difference[][]): Difference[] {
    return candidates[bestIndex(candidates)] ?? [];
}

/** Which candidate {@link best} picks; -1 without any. */
function bestIndex(candidates: Difference[][]): number {
    let found = -1;
    for (const [i, c] of candidates.entries()) {
        if (c.length === 0) return i;
        if (found < 0 || c.length < candidates[found].length) found = i;
    }
    return found;
}

// ===== The run =====

export async function runComparison(input: ComparisonInput): Promise<ComparisonResult> {
    const started = Date.now();
    const kinds = new Set((input.kinds ?? COMPARISON_KINDS).flatMap(k => COMPARISON_KIND_MEMBERS[k]));
    const { matcher, catalog, client } = input;
    const cancelled = (): boolean => input.isCancelled?.() ?? false;
    const report = (message: string): void => input.report?.(message);
    const problems: string[] = [];
    const entries: ComparisonEntry[] = [];
    let equal = 0;
    const statements = new StatementIndex(input.statements, catalog.defaultSchema);

    const query = async (sql: string, label: string, params?: unknown[]): Promise<Array<Record<string, unknown>>> => {
        try {
            return (await client.query(sql, params)).rows;
        } catch (err: unknown) {
            problems.push(`${label}: ${getErrorMessage(err)}`);
            return [];
        }
    };

    // --- What exists where ---
    const dbObjects = catalog.objects.filter(o =>
        kinds.has(o.kind) && !o.fromExtension && o.kind !== 'extension'
        && input.allowedSchema(o.schema) && !input.unmarked.schema(o.schema));
    const dbRelations = input.relations.filter(r =>
        kinds.has(r.kind) && input.allowedSchema(r.schema) && !input.unmarked.relation(r.schema, r.name));
    const identities: ObjectIdentity[] = [
        ...dbObjects.map(dbObjectIdentity),
        ...dbRelations.map(r => ({ kind: r.kind, schema: r.schema, name: r.name }))
    ];

    const both: Array<{ db?: DbObject; relation?: DbRelation; definitions: LocatedDefinition[] }> = [];
    for (const db of dbObjects) {
        let definitions = matcher.find(dbObjectIdentity(db));
        // A sequence a serial column created is defined by its table.
        if (definitions.length === 0 && db.kind === 'sequence' && db.relSchema && db.relName) {
            definitions = matcher.find({ kind: 'table', schema: db.relSchema, name: db.relName });
            if (definitions.length > 0) {
                equal++;
                continue;
            }
        }
        if (definitions.length === 0) {
            entries.push({ kind: db.kind, schema: db.schema, name: db.name, table: db.relName ?? undefined, args: db.args, status: 'dbOnly', differences: [], definitions: [], db });
        } else {
            both.push({ db, definitions });
        }
    }
    for (const relation of dbRelations) {
        const definitions = matcher.find({ kind: relation.kind, schema: relation.schema, name: relation.name });
        if (definitions.length === 0) entries.push({ kind: relation.kind, schema: relation.schema, name: relation.name, status: 'dbOnly', differences: [], definitions: [], relation });
        else both.push({ relation, definitions });
    }
    for (const repo of matcher.unmatched(identities, kinds)) {
        const id = repo.identity;
        if (!input.allowedSchema(id.schema)) continue;
        entries.push({
            kind: id.kind, schema: id.schema, name: id.name, table: id.table,
            args: ROUTINE_KINDS.has(id.kind) ? (id.argTypes ?? []).join(', ') : undefined,
            status: 'repoOnly', differences: [], definitions: repo.definitions
        });
    }

    // --- Routine bodies: read the ones the fast hash calls different ---
    if (kinds.has('function') || kinds.has('procedure')) {
        report('Comparing function bodies');
        for (const { db, definitions } of both) {
            if (db && (db.kind === 'function' || db.kind === 'procedure')) input.bodies.status(db, definitions);
        }
        await input.bodies.settled();
    }

    // --- Catalog of the structure, all objects at once ---
    const load = async <T>(needed: boolean, sql: string, label: string, map: (rows: Array<Record<string, unknown>>) => T, empty: T): Promise<T> =>
        needed && !cancelled() ? map(await query(sql, label)) : empty;
    report('Reading the structure of the database');
    const needTables = kinds.has('table');
    const columns = await load(needTables, TABLE_COLUMNS_QUERY, 'columns', rows => group(rows, rowKey('table_name'), r => ({
        name: String(r.column_name),
        type: columnType(String(r.data_type)),
        notNull: r.not_null === true || r.not_null === 't',
        default: r.identity ? 'identity' : r.generated === 's' ? `generated ${normalizeExpression(String(r.default_expr ?? ''))}` : r.default_expr === null || r.default_expr === undefined ? null : normalizeExpression(String(r.default_expr))
    })), new Map());
    const constraints = await load(needTables, TABLE_CONSTRAINTS_QUERY, 'constraints', rows => group(rows, rowKey('table_name'), r => {
        const c = parseConstraint(statementTokens(String(r.definition)));
        if (c) c.name = String(r.constraint_name);
        return c;
    }), new Map<string, Array<ConstraintModel | null>>());
    const indexes = await load(needTables || kinds.has('matview'), INDEXES_QUERY, 'indexes', rows => group(rows, rowKey('table_name'), r => {
        const index = parseCreateIndex(statementTokens(String(r.definition)));
        if (!index) return null;
        const { table: _table, ...model } = index;
        return model;
    }), new Map<string, Array<IndexModel | null>>());
    const needTypes = kinds.has('type') || kinds.has('domain');
    const typeRows = needTypes ? {
        enums: await load(true, ENUMS_QUERY, 'enums', rows => new Map(rows.map(r => [rowKey('type_name')(r), Array.isArray(r.labels) ? r.labels.map(String) : String(r.labels ?? '').replace(/^\{|\}$/g, '').split(',')])), new Map<string, string[]>()),
        composites: await load(true, COMPOSITES_QUERY, 'composite types', rows => group(rows, rowKey('type_name'), r => ({ name: String(r.attribute_name), type: columnType(String(r.data_type)) })), new Map()),
        ranges: await load(true, RANGES_QUERY, 'range types', rows => new Map(rows.map(r => [rowKey('type_name')(r), columnType(String(r.subtype))])), new Map<string, string>()),
        domains: await load(true, DOMAINS_QUERY, 'domains', rows => new Map(rows.map(r => [rowKey('type_name')(r), {
            flavour: 'domain' as const,
            base: columnType(String(r.base_type)),
            notNull: r.not_null === true || r.not_null === 't',
            default: r.default_expr === null || r.default_expr === undefined ? null : normalizeExpression(String(r.default_expr)),
            checks: (Array.isArray(r.checks) ? r.checks : []).map(c => normalizeExpression(String(c).replace(/^CHECK\s*/i, '')))
        }])), new Map<string, TypeModel>())
    } : null;
    const sequences = await load(kinds.has('sequence'), SEQUENCES_QUERY, 'sequences', rows => new Map(rows.map(r => [rowKey('sequence_name')(r), {
        type: String(r.data_type), increment: String(r.increment), min: String(r.min_value), max: String(r.max_value),
        start: String(r.start_value), cache: String(r.cache), cycle: r.cycle === true || r.cycle === 't'
    }])), new Map());
    const triggers = await load(kinds.has('trigger'), TRIGGERS_QUERY, 'triggers', rows => new Map(rows.map(r => [
        `${key(String(r.schema_name), String(r.table_name))}.${String(r.trigger_name)}`, parseCreateTrigger(statementTokens(String(r.definition)))
    ])), new Map());

    // --- Compare what both sides have ---
    let done = 0;
    for (const item of both) {
        if (cancelled()) break;
        if (++done % 200 === 0) report(`Comparing ${done} of ${both.length}`);
        const kind = item.db?.kind ?? item.relation!.kind;
        const schema = item.db?.schema ?? item.relation!.schema;
        const name = item.db?.name ?? item.relation!.name;
        let differences: Difference[] = [];
        let tables: ComparisonEntry['tables'];
        try {
            switch (kind) {
                case 'function':
                case 'procedure':
                    differences = routineDifferences(item.db!, item.definitions, input.bodies.tokenHashOf(item.db!), input.bodies.ignoreTypeSpelling ?? true);
                    break;
                case 'table': {
                    const db: TableModel = {
                        columns: columns.get(key(schema, name)) ?? [],
                        constraints: (constraints.get(key(schema, name)) ?? []).filter((c): c is ConstraintModel => c !== null),
                        indexes: (indexes.get(key(schema, name)) ?? []).filter((i): i is IndexModel => i !== null),
                        partial: false,
                        opaque: false
                    };
                    const models = tableModels(statements.tableStatements(schema, name), name);
                    if (models.length > 0) {
                        const candidates = models.map(m => compareTables(m, db, { columnOrder: input.columnOrder }));
                        const chosen = bestIndex(candidates);
                        differences = candidates[chosen];
                        const created = statements.get(`table:${key(schema, name)}`).find(s => s.type === 'createTable');
                        tables = { repo: models[chosen], db, searchPath: created?.searchPath ?? null };
                    }
                    break;
                }
                case 'type':
                case 'domain': {
                    const k = key(schema, name);
                    const db: TypeModel | undefined = typeRows?.domains.get(k)
                        ?? (typeRows?.enums.has(k) ? { flavour: 'enum', labels: typeRows.enums.get(k)! } : undefined)
                        ?? (typeRows?.composites.has(k) ? { flavour: 'composite', attributes: typeRows.composites.get(k)! } : undefined)
                        ?? (typeRows?.ranges.has(k) ? { flavour: 'range', subtype: typeRows.ranges.get(k)! } : undefined);
                    const models = typeModels(statements.get(`type:${k}`));
                    if (db && models.length > 0) differences = best(models.map(m => compareTypes(m, db)));
                    break;
                }
                case 'sequence': {
                    const db = sequences.get(key(schema, name));
                    const own = statements.get(`sequence:${key(schema, name)}`);
                    const chains: Array<Array<ReturnType<typeof parseSequenceOptions>>> = [];
                    for (const s of own) {
                        const toks = statementTokens(s.text);
                        const nameEnd = toks.findIndex(t => t.value === s.name) + 1;
                        const options = parseSequenceOptions(toks, nameEnd);
                        if (s.type === 'createSequence') chains.push([options]);
                        else chains[chains.length - 1]?.push(options);
                    }
                    if (db && chains.length > 0) differences = best(chains.map(c => compareSequences(sequenceModel(c), db)));
                    break;
                }
                case 'trigger': {
                    const table = item.db!.relName ?? '';
                    const tableSchema = item.db!.relSchema ?? schema;
                    const db = triggers.get(`${key(tableSchema, table)}.${name}`);
                    const repo = statements.get(`trigger:${key(tableSchema, table)}.${name}`)
                        .map(s => parseCreateTrigger(statementTokens(s.text)))
                        .filter((t): t is NonNullable<typeof t> => t !== null);
                    if (db && repo.length > 0) differences = best(repo.map(r => compareTriggers(r, db)));
                    break;
                }
                default:
                    break;
            }
        } catch (err: unknown) {
            problems.push(`${kind} ${key(schema, name)}: ${getErrorMessage(err)}`);
        }
        if (differences.length > 0) {
            entries.push({
                kind, schema, name, table: item.db?.relName ?? undefined, args: item.db?.args,
                status: 'differs', differences, definitions: item.definitions, db: item.db, relation: item.relation,
                ...(tables ? { tables } : {})
            });
        } else if (!['view', 'matview'].includes(kind)) {
            equal++;
        }
    }

    // --- Views: canonicalised by PostgreSQL itself ---
    const views = both.filter(b => b.relation && (b.relation.kind === 'view' || b.relation.kind === 'matview'));
    if (views.length > 0 && !cancelled()) {
        report(`Comparing ${views.length} views`);
        const searchPath = catalog.searchPath.map(s => `"${s.replace(/"/g, '""')}"`).join(', ') || 'public';
        for (const item of views) {
            if (cancelled()) break;
            const { schema, name, kind } = item.relation!;
            const differences = await viewDifferences(client, statements.get(`view:${key(schema, name)}`), schema, name, searchPath);
            if (differences.length > 0) {
                entries.push({ kind, schema, name, status: 'differs', differences, definitions: item.definitions, relation: item.relation });
            } else {
                equal++;
            }
        }
    }

    entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name));
    return { entries, equal, finishedAt: Date.now(), durationMs: Date.now() - started, problems, cancelled: cancelled() };
}

/** Signature and body of a routine against its best-matching definition. */
export function routineDifferences(db: DbObject, definitions: readonly LocatedDefinition[], dbTokenHash: string | undefined, ignoreTypeSpelling = true): Difference[] {
    const dbParams = db.fullArgs !== undefined && db.fullArgs !== null ? parseArgumentList(db.kind, db.fullArgs) : null;
    return best(definitions.map(def => {
        const out: Difference[] = [];
        if (dbParams && def.params) {
            out.push(...compareSignatures(
                { params: def.params, returns: db.kind === 'function' ? def.returns : undefined },
                { params: dbParams, returns: db.kind === 'function' ? db.detail : undefined }
            ));
        }
        if (db.bodyHash && def.bodyHash && def.bodyHash !== db.bodyHash && !(dbTokenHash && definitionTokenHash(def, ignoreTypeSpelling) === dbTokenHash)) {
            out.push({ path: 'body', message: ignoreTypeSpelling ? 'the code differs (comments, white space and type spellings ignored)' : 'the code differs (comments and white space ignored)' });
        }
        return out;
    }));
}

/**
 * Create each repository query of the view as a temporary view and compare
 * what PostgreSQL makes of it with the real view; a query that fails against
 * the database is a difference of its own.
 */
async function viewDifferences(client: ComparisonClient, statements: readonly LocatedStatement[], schema: string, name: string, searchPath: string): Promise<Difference[]> {
    const queries = new Map<string, { columns: string | null; query: string; searchPath: string[] | null }>();
    for (const s of statements) {
        const q = viewQuery(s.text);
        if (q) queries.set(`${q.columns ?? ''}\u0000${q.query}`, { ...q, searchPath: s.searchPath });
    }
    // The newest few definitions; older migrations rarely matter.
    const candidates = [...queries.values()].slice(-5).reverse();
    if (candidates.length === 0) return [];
    const quote = (s: string): string => `"${s.replace(/"/g, '""')}"`;
    let real: string;
    try {
        await client.query(`SELECT pg_catalog.set_config('search_path', $1, true)`, [searchPath]);
        real = String((await client.query(`SELECT pg_catalog.pg_get_viewdef(($1)::regclass) AS def`, [`${quote(schema)}.${quote(name)}`])).rows[0]?.def ?? '');
    } catch (err: unknown) {
        return [{ path: 'definition', message: `could not be read: ${getErrorMessage(err)}` }];
    }
    let lastError: string | null = null;
    for (const candidate of candidates) {
        await client.query('SAVEPOINT pqb_compare');
        try {
            const path = candidate.searchPath && candidate.searchPath.length > 0 ? candidate.searchPath.map(quote).join(', ') : searchPath;
            await client.query(`SELECT pg_catalog.set_config('search_path', $1, true)`, [path]);
            await client.query(`CREATE TEMPORARY VIEW ${VIEW_NAME}${candidate.columns ? ` ${candidate.columns}` : ''} AS ${candidate.query}`);
            await client.query(`SELECT pg_catalog.set_config('search_path', $1, true)`, [searchPath]);
            const mine = String((await client.query(`SELECT pg_catalog.pg_get_viewdef('pg_temp.${VIEW_NAME}'::regclass) AS def`)).rows[0]?.def ?? '');
            await client.query('ROLLBACK TO SAVEPOINT pqb_compare');
            if (sameViewDefinition(mine, real)) return [];
            lastError = null;
        } catch (err: unknown) {
            await client.query('ROLLBACK TO SAVEPOINT pqb_compare').catch(() => undefined);
            lastError = getErrorMessage(err);
        }
    }
    await client.query(`SELECT pg_catalog.set_config('search_path', $1, true)`, [searchPath]).catch(() => undefined);
    return lastError
        ? [{ path: 'query', message: `the repository's query fails against the database: ${lastError}` }]
        : [{ path: 'query', message: 'the query differs' }];
}
