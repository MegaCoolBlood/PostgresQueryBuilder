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
import { filterHighlights, parseFilterTerms, scoreFilterText } from './tableExplorer';
import {
    MatcherCache,
    databaseObjectStatus,
    routineStatus,
    type DefinitionMatcher,
    type LocatedDefinition,
    type RepoStatus,
    type RepositorySource,
    type UnmarkedObjects
} from './repositoryComparison';
import { statusHint, statusUri } from './objectDecorations';
import { docSummary } from './docComments';
import { Logger, getErrorMessage } from './logger';
import {
    DatabaseCatalog,
    NAVIGATOR_KINDS,
    dbObjectIdentity,
    type CatalogConnection,
    type CatalogData,
    type DbObject,
    type NavigatorKind
} from './databaseCatalog';

export { NAVIGATOR_KINDS, buildObjectCatalogQuery, dbObjectIdentity, toDbObject } from './databaseCatalog';
export { routineStatus } from './repositoryComparison';
export type { DbObject, NavigatorKind } from './databaseCatalog';

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
export type NavigatorConnection = CatalogConnection;

/** Where the Show Only Differences state is kept (the workspace state). */
export interface NavigatorState {
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Thenable<void>;
}

export const ONLY_DIFFERENCES_KEY = 'postgresQueryBuilder.objectNavigator.onlyDifferences';
export const EMPTY_SCHEMAS_KEY = 'postgresQueryBuilder.objectNavigator.showEmptySchemas';

export function readNavigatorSettings(): NavigatorSettings {
    const cfg = vscode.workspace.getConfiguration('postgresQueryBuilder');
    const kinds = cfg.get<unknown>('objectNavigator.objectKinds', NAVIGATOR_KINDS);
    return {
        objectKinds: Array.isArray(kinds) ? kinds.map(String) : [...NAVIGATOR_KINDS],
        showExtensionObjects: cfg.get<boolean>('objectNavigator.showExtensionObjects', false)
    };
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

/**
 * PL/pgSQL is installed into every database, so the view does not list it; it
 * stays in the catalog result so a repository that creates it still matches.
 */
function isBuiltInExtension(obj: DbObject): boolean {
    return obj.kind === 'extension' && obj.name === 'plpgsql';
}

export class ObjectNavigatorProvider implements vscode.TreeDataProvider<NavigatorNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<NavigatorNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private filterText = '';
    private filterTerms: string[] = [];
    private allNodes?: AllNodes;
    private model?: Model;
    private readonly matchers = new MatcherCache();
    private onlyDifferences: boolean;
    private emptySchemas: boolean;
    /** The catalog of the connection, shared with the SQL editor features. */
    readonly catalog: DatabaseCatalog;

    constructor(
        private readonly connection: NavigatorConnection,
        private readonly settings: () => NavigatorSettings,
        private readonly repository?: RepositorySource,
        private readonly state?: NavigatorState,
        catalog?: DatabaseCatalog
    ) {
        this.catalog = catalog ?? new DatabaseCatalog(connection);
        this.onlyDifferences = state?.get<boolean>(ONLY_DIFFERENCES_KEY, false) ?? false;
        this.emptySchemas = state?.get<boolean>(EMPTY_SCHEMAS_KEY, false) ?? false;
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

    get showsEmptySchemas(): boolean {
        return this.emptySchemas;
    }

    async setShowEmptySchemas(value: boolean): Promise<void> {
        this.emptySchemas = value;
        this.model = undefined;
        await this.state?.update(EMPTY_SCHEMAS_KEY, value);
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
        this.catalog.reset();
        this.rerender();
    }

    /** Reload from the database, bypassing the metadata cache. */
    refresh(): void {
        this.catalog.refresh();
        this.rerender();
    }

    // ===== Loading =====

    private loadCatalog(): Promise<CatalogData> {
        return this.catalog.load();
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
        const matcher = this.matchers.get(this.repository?.snapshot() ?? null, catalog.defaultSchema);
        const unmarked = matcher ? await this.catalog.unmarked() : null;
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
                node.status = routineStatus(db, definitions);
            }
            objects.push(node);
        }
        const repoSchemas: ObjectSchemaNode[] = [];
        if (matcher) {
            const identities = catalog.objects.map(dbObjectIdentity);
            for (const repo of matcher.unmatched(identities, kinds)) {
                const id = repo.identity;
                if (id.kind !== 'extension' && !this.catalog.allowedSchema(id.schema)) continue;
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
                if (!this.catalog.allowedSchema(repo.identity.name)) continue;
                repoSchemas.push({ type: 'schema', schema: repo.identity.name, status: 'repoOnly', definitions: repo.definitions });
            }
        }
        this.allNodes = { objects, repoSchemas, matcher, unmarked };
        return this.allNodes;
    }

    private schemaNode(schema: string, catalog: CatalogData, all: AllNodes): ObjectSchemaNode {
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
        // Schemas with nothing to show in this view, only when asked for.
        if (this.emptySchemas && !filtering) {
            for (const schema of catalog.schemas) {
                if (schemaNodes.has(schema) || !this.catalog.allowedSchema(schema)) continue;
                schemaNodes.set(schema, this.schemaNode(schema, catalog, all));
                categories.set(schema, []);
            }
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
        if (status && status !== 'both') item.resourceUri = statusUri(id, status);
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
        const summary = docSummary(node.definitions);
        if (summary && summary !== db?.comment) lines.push('', summary);
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

    /** True while the Search filter is set. */
    get isFiltering(): boolean {
        return this.filterTerms.length > 0;
    }

    /** The entry of a schema while the view shows it; undefined when the filter or Show Empty Schemas hides it. */
    async shownSchema(schema: string): Promise<ObjectSchemaNode | undefined> {
        if (!this.connection.isConnected()) return undefined;
        return (await this.getModel()).schemaNodes.get(schema);
    }
}
