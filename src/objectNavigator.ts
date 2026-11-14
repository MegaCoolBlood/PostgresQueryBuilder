/**
 * The Objects view: functions, procedures, aggregates, types, domains,
 * sequences, triggers and extensions — everything that is not a relation and
 * so not part of the Tables view.
 *
 * Fetch time: nothing is queried until the view is first expanded. Then one
 * catalog query (through the metadata cache) loads every object of every
 * allowed schema; grouping, the Search filter and the repository comparison
 * all work on that result in memory. DDL is fetched per object, on demand.
 */
import * as vscode from 'vscode';
import { buildSchemaListQuery, filterHighlights, parseFilterTerms, scoreFilterText } from './tableExplorer';
import {
    CURRENT_SCHEMAS_QUERY,
    EXTENSION_MEMBERS_QUERY,
    MatcherCache,
    UnmarkedObjects,
    databaseObjectStatus,
    type DefinitionMatcher,
    type LocatedDefinition,
    type ObjectIdentity,
    type RepoStatus,
    type RepositorySource
} from './repositoryComparison';
import { statusHint, statusUri } from './objectDecorations';
import { SERVER_VERSION_QUERY } from './ddlGenerator';
import { Logger, getErrorMessage } from './logger';

export type NavigatorKind = 'function' | 'procedure' | 'aggregate' | 'type' | 'domain' | 'sequence' | 'trigger' | 'extension';

/** Every kind, in the order the categories appear under a schema. */
export const NAVIGATOR_KINDS: readonly NavigatorKind[] = ['function', 'procedure', 'aggregate', 'type', 'domain', 'sequence', 'trigger', 'extension'];

export const KIND_META: Record<NavigatorKind, { label: string; singular: string; icon: string }> = {
    function: { label: 'Functions', singular: 'Function', icon: 'symbol-method' },
    procedure: { label: 'Procedures', singular: 'Procedure', icon: 'gear' },
    aggregate: { label: 'Aggregates', singular: 'Aggregate', icon: 'symbol-operator' },
    type: { label: 'Types', singular: 'Type', icon: 'symbol-structure' },
    domain: { label: 'Domains', singular: 'Domain', icon: 'symbol-type-parameter' },
    sequence: { label: 'Sequences', singular: 'Sequence', icon: 'symbol-numeric' },
    trigger: { label: 'Triggers', singular: 'Trigger', icon: 'symbol-event' },
    extension: { label: 'Extensions', singular: 'Extension', icon: 'extensions' }
};

const TYPE_ICONS: Record<string, string> = { enum: 'symbol-enum', composite: 'symbol-structure', range: 'symbol-ruler' };

/** Passed as second argument by a tree item's click, so the command can tell a click from a menu entry. */
export const CLICK_ARGUMENT = 'click';

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

export interface ObjectSchemaNode {
    type: 'schema';
    schema: string;
    status?: RepoStatus;
    definitions: LocatedDefinition[];
}

export interface ObjectCategoryNode {
    type: 'category';
    schema: string;
    kind: NavigatorKind;
}

export interface ExtensionsNode {
    type: 'extensions';
}

export interface ObjectNode {
    type: 'object';
    kind: NavigatorKind;
    schema: string;
    name: string;
    /** Arguments shown in the label of a routine. */
    args: string | null;
    /** Set for an object of the database; missing for one that exists only in the repository. */
    db?: DbObject;
    /** Identity argument types of a routine that exists only in the repository. */
    repoArgTypes?: string[] | null;
    /** Table of a trigger that exists only in the repository. */
    repoTable?: string;
    status?: RepoStatus;
    definitions: LocatedDefinition[];
}

export type NavigatorNode = ObjectSchemaNode | ObjectCategoryNode | ExtensionsNode | ObjectNode;

export interface NavigatorSettings {
    /** Kinds to show; unknown values are ignored. */
    objectKinds: readonly string[];
    showExtensionObjects: boolean;
}

/** The part of the connection manager the view needs. */
export interface NavigatorConnection {
    isConnected(): boolean;
    getActiveConnectionConfig(): { schemas?: string[] } | null | undefined;
    queryMetadata(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
    clearMetadataCache(): void;
}

/** Where the Show Only Differences state is kept (the workspace state). */
export interface NavigatorState {
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Thenable<void>;
}

export const ONLY_DIFFERENCES_KEY = 'postgresQueryBuilder.objectNavigator.onlyDifferences';

export function readNavigatorSettings(): NavigatorSettings {
    const cfg = vscode.workspace.getConfiguration('postgresQueryBuilder');
    const kinds = cfg.get<unknown>('objectNavigator.objectKinds', NAVIGATOR_KINDS);
    return {
        objectKinds: Array.isArray(kinds) ? kinds.map(String) : [...NAVIGATOR_KINDS],
        showExtensionObjects: cfg.get<boolean>('objectNavigator.showExtensionObjects', false)
    };
}

const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema', 'pg_toast']);

/**
 * The one catalog query of the view. Light columns only — no DDL — and
 * extension members are always read but flagged, so hiding them is a filter in
 * memory and a repository definition of such an object is never mistaken for
 * one that exists only in the repository.
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
    return `SELECT kind, oid, schema_name, name, args, arg_types, detail, rel_schema, rel_name, rel_column, owner, language, comment, from_extension FROM (
    SELECT ${routineKind} AS kind, p.oid, n.nspname::text AS schema_name, p.proname::text AS name,
           pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
           ARRAY(SELECT pg_catalog.format_type(u.t, NULL) FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS u(t, i) ORDER BY u.i) AS arg_types,
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
           NULL::text, NULL::text[],
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
    SELECT 'sequence', c.oid, n.nspname::text, c.relname::text, NULL::text, NULL::text[],
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
    SELECT 'trigger', tg.oid, n.nspname::text, tg.tgname::text, NULL::text, NULL::text[], NULL::text,
           n.nspname::text, c.relname::text, NULL::text, NULL::text, NULL::text,
           pg_catalog.obj_description(tg.oid, 'pg_trigger'),
           ${member('pg_class', 'c.oid')}
    FROM pg_catalog.pg_trigger tg
    JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE ${triggerFilter} AND ${inSchemas('n.nspname')}
    UNION ALL
    SELECT 'extension', e.oid, n.nspname::text, e.extname::text, NULL::text, NULL::text[], e.extversion::text,
           NULL::text, NULL::text, NULL::text,
           pg_catalog.pg_get_userbyid(e.extowner)::text, NULL::text,
           pg_catalog.obj_description(e.oid, 'pg_extension'), false
    FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
) objects
ORDER BY schema_name, name`;
}

/**
 * PL/pgSQL is installed into every database, so the view does not list it; it
 * stays in the catalog result so a repository that creates it still matches.
 */
function isBuiltInExtension(obj: DbObject): boolean {
    return obj.kind === 'extension' && obj.name === 'plpgsql';
}

function text(row: Record<string, unknown>, key: string): string | null {
    const v = row[key];
    return v === null || v === undefined ? null : String(v);
}

/** One catalog row as a {@link DbObject}. */
export function toDbObject(row: Record<string, unknown>): DbObject | null {
    const kind = String(row.kind) as NavigatorKind;
    if (!NAVIGATOR_KINDS.includes(kind)) return null;
    const argTypes = row.arg_types;
    return {
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
}

/** How the object is matched against the repository. */
export function dbObjectIdentity(obj: DbObject): ObjectIdentity {
    if (obj.kind === 'extension') return { kind: 'extension', schema: '', name: obj.name };
    if (obj.kind === 'trigger') return { kind: 'trigger', schema: obj.schema, name: obj.name, table: obj.relName ?? '' };
    return { kind: obj.kind, schema: obj.schema, name: obj.name, argTypes: obj.argTypes };
}

const ROUTINE_KINDS = new Set<NavigatorKind>(['function', 'procedure', 'aggregate']);

/** Label of an object entry: routines carry their signature, e.g. `add_tax(amount numeric)`. */
export function objectLabel(node: ObjectNode): string {
    return ROUTINE_KINDS.has(node.kind) ? `${node.name}(${node.args ?? ''})` : node.name;
}

/** The short secondary text after the label. */
export function objectDescription(node: ObjectNode): string | undefined {
    if (!node.db) return node.kind === 'trigger' && node.repoTable ? `on ${node.repoTable}` : undefined;
    const db = node.db;
    switch (node.kind) {
        case 'function':
        case 'aggregate':
            return db.detail ? `→ ${db.detail}` : undefined;
        case 'type':
        case 'domain':
            return db.detail ?? undefined;
        case 'sequence':
            return db.relName && db.relColumn ? `${db.detail ?? ''} · owned by ${db.relName}.${db.relColumn}` : db.detail ?? undefined;
        case 'trigger':
            return db.relName ? `on ${db.relName}` : undefined;
        case 'extension':
            return `${db.detail ?? ''} · ${db.schema}`;
        default:
            return undefined;
    }
}

/** The text the Search filter is matched against. */
function filterText(node: ObjectNode): string {
    return node.kind === 'extension' ? node.name : `${node.schema}.${node.name}`;
}

function objectKey(node: ObjectNode): string {
    if (node.db) return `${node.kind}:${node.db.oid}`;
    return `repo:${node.kind}:${node.schema}.${node.repoTable ?? ''}.${node.name}(${(node.repoArgTypes ?? []).join(',')})`;
}

interface Catalog {
    objects: DbObject[];
    /** Schemas of the database that the view may show. */
    schemas: Set<string>;
    defaultSchema: string;
}

interface Model {
    roots: NavigatorNode[];
    schemaNodes: Map<string, ObjectSchemaNode>;
    categories: Map<string, ObjectCategoryNode[]>;
    objects: Map<string, ObjectNode[]>;
    extensions: ObjectNode[];
}

interface AllNodes {
    objects: ObjectNode[];
    repoSchemas: ObjectSchemaNode[];
    matcher: DefinitionMatcher | null;
    unmarked: UnmarkedObjects | null;
}

const groupKey = (schema: string, kind: NavigatorKind): string => `${schema}\u0000${kind}`;

export class ObjectNavigatorProvider implements vscode.TreeDataProvider<NavigatorNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<NavigatorNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private filterText = '';
    private filterTerms: string[] = [];
    private catalog?: Promise<Catalog>;
    private allNodes?: AllNodes;
    private model?: Model;
    private readonly matchers = new MatcherCache();
    private onlyDifferences: boolean;

    constructor(
        private readonly connection: NavigatorConnection,
        private readonly settings: () => NavigatorSettings,
        private readonly repository?: RepositorySource,
        private readonly state?: NavigatorState
    ) {
        this.onlyDifferences = state?.get<boolean>(ONLY_DIFFERENCES_KEY, false) ?? false;
    }

    // ===== State changes =====

    setFilter(filterText: string): void {
        this.filterText = filterText.toLowerCase();
        this.filterTerms = parseFilterTerms(filterText);
        this.model = undefined;
        this._onDidChangeTreeData.fire();
    }

    get showsOnlyDifferences(): boolean {
        return this.onlyDifferences;
    }

    async setOnlyDifferences(value: boolean): Promise<void> {
        this.onlyDifferences = value;
        this.model = undefined;
        await this.state?.update(ONLY_DIFFERENCES_KEY, value);
        this._onDidChangeTreeData.fire();
    }

    /** Re-render from what is loaded: the settings, the repository or the filter changed. */
    rerender(): void {
        this.allNodes = undefined;
        this.model = undefined;
        this._onDidChangeTreeData.fire();
    }

    /** Forget the loaded catalog; the next render queries it again (connection changed). */
    reset(): void {
        this.catalog = undefined;
        this.rerender();
    }

    /** Reload from the database, bypassing the metadata cache. */
    refresh(): void {
        this.connection.clearMetadataCache();
        this.reset();
    }

    // ===== Loading =====

    private allowedSchema(schema: string, configSchemas: readonly string[] | undefined): boolean {
        if (configSchemas && configSchemas.length > 0) return configSchemas.includes(schema);
        return !SYSTEM_SCHEMAS.has(schema) && !schema.startsWith('pg_');
    }

    private loadCatalog(): Promise<Catalog> {
        if (!this.catalog) {
            this.catalog = this.fetchCatalog();
            // A failed load is not kept, so the next expand tries again.
            this.catalog.catch(() => { this.catalog = undefined; });
        }
        return this.catalog;
    }

    private async fetchCatalog(): Promise<Catalog> {
        const started = Date.now();
        const configSchemas = this.connection.getActiveConnectionConfig()?.schemas;
        const restrict = !!configSchemas && configSchemas.length > 0;
        const schemaQuery = buildSchemaListQuery(configSchemas);
        const [versionRows, schemaRows, searchPathRows] = await Promise.all([
            this.connection.queryMetadata(SERVER_VERSION_QUERY),
            this.connection.queryMetadata(schemaQuery.sql, schemaQuery.params),
            this.connection.queryMetadata(CURRENT_SCHEMAS_QUERY)
        ]);
        const version = Number(versionRows[0]?.server_version_num ?? 0);
        const rows = await this.connection.queryMetadata(
            buildObjectCatalogQuery(version, restrict),
            restrict ? [configSchemas] : undefined
        );
        const objects = rows.map(toDbObject).filter((o): o is DbObject => o !== null);
        const schemas = new Set(schemaRows.map(r => String(r.schema_name)));
        for (const o of objects) {
            if (o.kind !== 'extension') schemas.add(o.schema);
        }
        Logger.log('ObjectNavigator.fetchCatalog', `${objects.length} objects in ${Date.now() - started} ms`);
        return {
            objects,
            schemas,
            defaultSchema: searchPathRows.length > 0 ? String(searchPathRows[0].schema_name) : 'public'
        };
    }

    private enabledKinds(): Set<NavigatorKind> {
        const configured = this.settings().objectKinds;
        return new Set(NAVIGATOR_KINDS.filter(k => configured.includes(k)));
    }

    /** Every entry the view can show, before the filter: database objects and repository-only ones. */
    private async getAllNodes(): Promise<AllNodes> {
        if (this.allNodes) return this.allNodes;
        const catalog = await this.loadCatalog();
        const kinds = this.enabledKinds();
        const { showExtensionObjects } = this.settings();
        const configSchemas = this.connection.getActiveConnectionConfig()?.schemas;
        const matcher = this.matchers.get(this.repository?.snapshot() ?? null, catalog.defaultSchema);
        const unmarked = matcher ? new UnmarkedObjects(await this.connection.queryMetadata(EXTENSION_MEMBERS_QUERY)) : null;
        const objects: ObjectNode[] = [];
        for (const db of catalog.objects) {
            if (!kinds.has(db.kind) || isBuiltInExtension(db)) continue;
            if (db.fromExtension && !showExtensionObjects) continue;
            const node: ObjectNode = {
                type: 'object',
                kind: db.kind,
                schema: db.schema,
                name: db.name,
                args: db.args,
                db,
                definitions: []
            };
            // What an extension brings along is the extension's, not the repository's.
            if (matcher && !db.fromExtension) {
                let definitions = matcher.find(dbObjectIdentity(db));
                // A sequence a serial column created is defined by its table's CREATE TABLE.
                if (definitions.length === 0 && db.kind === 'sequence' && db.relSchema && db.relName) {
                    definitions = matcher.find({ kind: 'table', schema: db.relSchema, name: db.relName });
                }
                node.definitions = definitions;
                node.status = databaseObjectStatus(definitions);
            }
            objects.push(node);
        }
        const repoSchemas: ObjectSchemaNode[] = [];
        if (matcher) {
            const identities = catalog.objects.map(dbObjectIdentity);
            for (const repo of matcher.unmatched(identities, kinds)) {
                const id = repo.identity;
                if (id.kind !== 'extension' && !this.allowedSchema(id.schema, configSchemas)) continue;
                const routine = ROUTINE_KINDS.has(id.kind as NavigatorKind);
                objects.push({
                    type: 'object',
                    kind: id.kind as NavigatorKind,
                    schema: id.schema,
                    name: id.name,
                    args: routine ? (id.argTypes ?? []).join(', ') : null,
                    repoArgTypes: routine ? id.argTypes ?? null : undefined,
                    repoTable: id.kind === 'trigger' ? id.table : undefined,
                    status: 'repoOnly',
                    definitions: repo.definitions
                });
            }
            for (const repo of matcher.unmatched(
                [...catalog.schemas].map(s => ({ kind: 'schema' as const, schema: '', name: s })),
                new Set(['schema'] as const)
            )) {
                if (!this.allowedSchema(repo.identity.name, configSchemas)) continue;
                repoSchemas.push({ type: 'schema', schema: repo.identity.name, status: 'repoOnly', definitions: repo.definitions });
            }
        }
        this.allNodes = { objects, repoSchemas, matcher, unmarked };
        return this.allNodes;
    }

    private schemaNode(schema: string, catalog: Catalog, all: AllNodes): ObjectSchemaNode {
        const { matcher, unmarked } = all;
        if (!matcher) return { type: 'schema', schema, definitions: [] };
        if (!catalog.schemas.has(schema)) return { type: 'schema', schema, status: 'repoOnly', definitions: [] };
        const definitions = matcher.find({ kind: 'schema', schema: '', name: schema });
        if (unmarked?.schema(schema)) return { type: 'schema', schema, definitions };
        // Every database has the public schema; no repository has to create it.
        const status = definitions.length === 0 && schema === 'public' ? undefined : databaseObjectStatus(definitions);
        return { type: 'schema', schema, status, definitions };
    }

    private visible(node: ObjectNode, matcherActive: boolean): boolean {
        if (this.filterTerms.length > 0 && scoreFilterText(filterText(node), this.filterTerms) === 0) return false;
        if (this.onlyDifferences && matcherActive && node.status === 'both') return false;
        return true;
    }

    private async getModel(): Promise<Model> {
        if (this.model) return this.model;
        const catalog = await this.loadCatalog();
        const all = await this.getAllNodes();
        const filtering = this.filterTerms.length > 0;
        const score = (n: ObjectNode): number => scoreFilterText(filterText(n), this.filterTerms);
        const argCount = (n: ObjectNode): number => (n.args && n.args.trim() !== '' ? n.args.split(',').length : 0);
        const order = (a: ObjectNode, b: ObjectNode): number =>
            (filtering ? score(b) - score(a) : 0)
            || a.name.localeCompare(b.name)
            || argCount(a) - argCount(b)
            || (a.args ?? '').localeCompare(b.args ?? '');

        const objects = new Map<string, ObjectNode[]>();
        const extensions: ObjectNode[] = [];
        const schemaScore = new Map<string, number>();
        for (const node of all.objects) {
            if (!this.visible(node, !!all.matcher)) continue;
            if (node.kind === 'extension') {
                extensions.push(node);
                continue;
            }
            const key = groupKey(node.schema, node.kind);
            const list = objects.get(key);
            if (list) list.push(node);
            else objects.set(key, [node]);
            schemaScore.set(node.schema, Math.max(schemaScore.get(node.schema) ?? 0, score(node)));
        }
        for (const list of objects.values()) list.sort(order);
        extensions.sort(order);

        const schemaNodes = new Map<string, ObjectSchemaNode>();
        const categories = new Map<string, ObjectCategoryNode[]>();
        for (const schema of schemaScore.keys()) {
            schemaNodes.set(schema, this.schemaNode(schema, catalog, all));
            categories.set(schema, NAVIGATOR_KINDS
                .filter(kind => kind !== 'extension' && objects.has(groupKey(schema, kind)))
                .map(kind => ({ type: 'category' as const, schema, kind })));
        }
        for (const repoSchema of all.repoSchemas) {
            if (schemaNodes.has(repoSchema.schema)) {
                schemaNodes.set(repoSchema.schema, { ...schemaNodes.get(repoSchema.schema)!, status: 'repoOnly', definitions: repoSchema.definitions });
                continue;
            }
            if (filtering && scoreFilterText(repoSchema.schema, this.filterTerms) === 0) continue;
            schemaNodes.set(repoSchema.schema, repoSchema);
            categories.set(repoSchema.schema, []);
            schemaScore.set(repoSchema.schema, scoreFilterText(repoSchema.schema, this.filterTerms));
        }
        const roots: NavigatorNode[] = [...schemaNodes.values()].sort((a, b) =>
            (filtering ? (schemaScore.get(b.schema) ?? 0) - (schemaScore.get(a.schema) ?? 0) : 0) || a.schema.localeCompare(b.schema));
        if (extensions.length > 0) roots.push({ type: 'extensions' });
        this.model = { roots, schemaNodes, categories, objects, extensions };
        return this.model;
    }

    // ===== TreeDataProvider =====

    async getChildren(element?: NavigatorNode): Promise<NavigatorNode[]> {
        if (!this.connection.isConnected()) return [];
        this.repository?.ensureScanned();
        try {
            const model = await this.getModel();
            if (!element) return model.roots;
            switch (element.type) {
                case 'schema':
                    return model.categories.get(element.schema) ?? [];
                case 'category':
                    return model.objects.get(groupKey(element.schema, element.kind)) ?? [];
                case 'extensions':
                    return model.extensions;
                default:
                    return [];
            }
        } catch (err: unknown) {
            Logger.error('ObjectNavigatorProvider.getChildren', err);
            vscode.window.showErrorMessage(`Failed to load the database objects: ${getErrorMessage(err)}`);
            return [];
        }
    }

    getParent(element: NavigatorNode): NavigatorNode | undefined {
        switch (element.type) {
            case 'object':
                return element.kind === 'extension'
                    ? { type: 'extensions' }
                    : { type: 'category', schema: element.schema, kind: element.kind };
            case 'category':
                return this.model?.schemaNodes.get(element.schema) ?? { type: 'schema', schema: element.schema, definitions: [] };
            default:
                return undefined;
        }
    }

    /** Part of every id: a filtered tree gets ids of its own, so VS Code shows it expanded. */
    private idPrefix(): string {
        return this.filterTerms.length > 0 ? `objects?${this.filterText}` : 'objects';
    }

    private expandedState(): vscode.TreeItemCollapsibleState {
        return this.filterTerms.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
    }

    private decorate(item: vscode.TreeItem, id: string, status: RepoStatus | undefined, tooltip: string[]): void {
        if (status === 'dbOnly' || status === 'repoOnly') item.resourceUri = statusUri(id, status);
        if (status) tooltip.push('', statusHint(status));
        item.tooltip = tooltip.join('\n');
    }

    getTreeItem(element: NavigatorNode): vscode.TreeItem {
        const prefix = this.idPrefix();
        if (element.type === 'schema') {
            const item = new vscode.TreeItem({ label: element.schema, highlights: filterHighlights(element.schema, this.filterTerms) }, this.expandedState());
            item.id = `${prefix}/schema/${element.schema}`;
            item.iconPath = new vscode.ThemeIcon('symbol-namespace');
            item.contextValue = element.status === 'repoOnly' ? 'objectSchema.repoOnly' : 'objectSchema';
            this.decorate(item, item.id, element.status, [`Schema ${element.schema}`]);
            return item;
        }
        if (element.type === 'category') {
            const meta = KIND_META[element.kind];
            const item = new vscode.TreeItem(meta.label, this.expandedState());
            item.id = `${prefix}/category/${element.schema}/${element.kind}`;
            item.iconPath = new vscode.ThemeIcon('folder');
            item.contextValue = 'objectCategory';
            item.tooltip = `${meta.label} in ${element.schema}`;
            return item;
        }
        if (element.type === 'extensions') {
            const item = new vscode.TreeItem(KIND_META.extension.label, this.expandedState());
            item.id = `${prefix}/extensions`;
            item.iconPath = new vscode.ThemeIcon('folder');
            item.contextValue = 'objectCategory';
            item.tooltip = 'Extensions installed in the database';
            return item;
        }
        const label = objectLabel(element);
        const item = new vscode.TreeItem({ label, highlights: filterHighlights(label, this.filterTerms) }, vscode.TreeItemCollapsibleState.None);
        item.id = `${prefix}/object/${objectKey(element)}`;
        const typeIcon = element.kind === 'type' && element.db?.detail ? TYPE_ICONS[element.db.detail] : undefined;
        item.iconPath = new vscode.ThemeIcon(typeIcon ?? KIND_META[element.kind].icon);
        item.description = element.db ? objectDescription(element) : 'only in repository';
        item.contextValue = `${element.db ? 'dbObject' : 'repoObject'}.${element.kind}`;
        item.command = {
            command: 'postgresQueryBuilder.goToRepositoryDefinition',
            title: 'Go to Definition in Repository',
            arguments: [element, CLICK_ARGUMENT]
        };
        this.decorate(item, item.id, element.status, this.tooltipLines(element));
        return item;
    }

    private tooltipLines(node: ObjectNode): string[] {
        const meta = KIND_META[node.kind];
        const qualified = node.kind === 'extension' ? node.name : `${node.schema}.${objectLabel(node)}`;
        const lines = [`${meta.singular} ${qualified}`];
        const db = node.db;
        if (db) {
            if ((node.kind === 'function' || node.kind === 'aggregate') && db.detail) lines.push(`Returns: ${db.detail}`);
            if (node.kind === 'domain' && db.detail) lines.push(`Base type: ${db.detail}`);
            if (node.kind === 'type' && db.detail) lines.push(`Kind: ${db.detail}`);
            if (node.kind === 'sequence' && db.detail) lines.push(`Data type: ${db.detail}`);
            if (node.kind === 'sequence' && db.relName && db.relColumn) lines.push(`Owned by: ${db.relSchema}.${db.relName}.${db.relColumn}`);
            if (node.kind === 'trigger' && db.relName) lines.push(`On table: ${db.relSchema}.${db.relName}`);
            if (node.kind === 'extension' && db.detail) lines.push(`Version: ${db.detail}`, `Schema: ${db.schema}`);
            if (db.language) lines.push(`Language: ${db.language}`);
            if (db.owner) lines.push(`Owner: ${db.owner}`);
            if (db.fromExtension) lines.push('Belongs to an extension');
            if (db.comment) lines.push('', db.comment);
        } else if (node.kind === 'trigger' && node.repoTable) {
            lines.push(`On table: ${node.schema}.${node.repoTable}`);
        }
        return lines;
    }

    // ===== Go to Database Object =====

    /** Every entry the view can show, ignoring the Search filter and Show Only Differences. */
    async allObjectNodes(): Promise<ObjectNode[]> {
        if (!this.connection.isConnected()) return [];
        this.repository?.ensureScanned();
        return (await this.getAllNodes()).objects;
    }

    /** True when the Search filter or Show Only Differences hides the entry. */
    isHidden(node: ObjectNode): boolean {
        const matcherActive = !!this.allNodes?.matcher;
        return !this.visible(node, matcherActive);
    }

    /** True when the Search filter alone hides the entry. */
    isFilteredOut(node: ObjectNode): boolean {
        return this.filterTerms.length > 0 && scoreFilterText(filterText(node), this.filterTerms) === 0;
    }
}
