import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { buildRelationListQuery, buildSchemaRelationListQuery } from './queryRunner';
import { getErrorMessage, Logger } from './logger';
import {
    CURRENT_SCHEMAS_QUERY,
    EXTENSION_MEMBERS_QUERY,
    MatcherCache,
    UnmarkedObjects,
    databaseObjectStatus,
    type DefinitionMatcher,
    type LocatedDefinition,
    type RepoStatus,
    type RepositorySource
} from './repositoryComparison';
import type { RepoObjectKind } from './repositoryScanner';
import { statusHint, statusUri } from './objectDecorations';

export interface SchemaNode {
    type: 'schema';
    schema: string;
    status?: RepoStatus;
    definitions?: LocatedDefinition[];
}

/** The kind of a relation, used to group relations under a schema. */
export type RelationKind = 'table' | 'view' | 'matview' | 'foreign';

export interface CategoryNode {
    type: 'category';
    schema: string;
    kind: RelationKind;
}

export interface TableNode {
    type: 'table';
    schema: string;
    table: string;
    kind: RelationKind;
    /** Where the relation exists; unset while there is no repository to compare with. */
    status?: RepoStatus;
    /** Its CREATE statements in the repository. */
    definitions?: LocatedDefinition[];
}

export type TreeNode = SchemaNode | CategoryNode | TableNode;

interface Comparison {
    matcher: DefinitionMatcher;
    unmarked: UnmarkedObjects;
}

const RELATION_KINDS: ReadonlySet<RepoObjectKind> = new Set<RepoObjectKind>(['table', 'view', 'matview', 'foreign']);

/** Passed as second argument by a tree item's click, so the command can tell a click from a menu entry. */
const CLICK_ARGUMENT = 'click';

/**
 * Display metadata for each relation kind: the category label shown in the
 * tree, the icon for category and leaf nodes, and the order in which the
 * categories appear under a schema.
 */
export const RELATION_KIND_META: Record<RelationKind, { label: string; singular: string; categoryIcon: string; itemIcon: string; order: number }> = {
    table: { label: 'Tables', singular: 'Table', categoryIcon: 'folder', itemIcon: 'table', order: 0 },
    view: { label: 'Views', singular: 'View', categoryIcon: 'folder', itemIcon: 'eye', order: 1 },
    matview: { label: 'Materialized Views', singular: 'Materialized View', categoryIcon: 'folder', itemIcon: 'layers', order: 2 },
    foreign: { label: 'Foreign Tables', singular: 'Foreign Table', categoryIcon: 'folder', itemIcon: 'plug', order: 3 }
};

/** Normalize the raw `rel_kind` value returned by the relation queries. */
export function toRelationKind(raw: unknown): RelationKind {
    return raw === 'view' || raw === 'matview' || raw === 'foreign' ? raw : 'table';
}

/**
 * The schema list of the Tables view: the schemas a connection names, else
 * every schema but the system ones. The Objects view sends the very same SQL,
 * so the metadata cache answers it for both views with one round-trip.
 */
export function buildSchemaListQuery(configSchemas: readonly string[] | undefined): { sql: string; params?: string[] } {
    if (configSchemas && configSchemas.length > 0) {
        const placeholders = configSchemas.map((_, i) => `$${i + 1}`).join(', ');
        return {
            sql: `SELECT schema_name FROM information_schema.schemata
                             WHERE schema_name IN (${placeholders})
                             ORDER BY schema_name`,
            params: [...configSchemas]
        };
    }
    return {
        sql: `SELECT schema_name FROM information_schema.schemata
                             WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                             ORDER BY schema_name`
    };
}

// ===== Search filter shared by the Tables and the Objects view =====

/** Split the text of the Search field into lower-case, whitespace-separated terms. */
export function parseFilterTerms(filterText: string): string[] {
    return filterText
        .toLowerCase()
        .split(/\s+/)
        .map(t => t.trim())
        .filter(t => t.length > 0);
}

/** How many of the filter terms occur in `s` (case-insensitive); 0 without terms. */
export function scoreFilterText(s: string, terms: readonly string[]): number {
    if (terms.length === 0) return 0;
    const lower = s.toLowerCase();
    let score = 0;
    for (const term of terms) {
        if (lower.includes(term)) score++;
    }
    return score;
}

/**
 * Non-overlapping [start, end) ranges in `s` that match any of the filter terms
 * (case-insensitive). VS Code renders them in the theme's list highlight colour.
 */
export function filterHighlights(s: string, terms: readonly string[]): Array<[number, number]> {
    if (terms.length === 0) return [];
    const lower = s.toLowerCase();
    const ranges: Array<[number, number]> = [];
    for (const term of terms) {
        if (!term) continue;
        let from = 0;
        while (true) {
            const idx = lower.indexOf(term, from);
            if (idx < 0) break;
            ranges.push([idx, idx + term.length]);
            from = idx + term.length;
        }
    }
    if (ranges.length <= 1) return ranges;
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [ranges[0]];
    for (let i = 1; i < ranges.length; i++) {
        const last = merged[merged.length - 1];
        const cur = ranges[i];
        if (cur[0] <= last[1]) {
            last[1] = Math.max(last[1], cur[1]);
        } else {
            merged.push(cur);
        }
    }
    return merged;
}

export class TableExplorerProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private connectionManager: ConnectionManager;
    private _filterText = '';
    private _filterTerms: string[] = [];
    private repository?: RepositorySource;
    private readonly matchers = new MatcherCache();
    private repoOnlyCache?: { matcher: DefinitionMatcher; nodes: Promise<TableNode[]> };
    private unmarkedCache?: { rows: unknown; unmarked: UnmarkedObjects };

    constructor(connectionManager: ConnectionManager) {
        this.connectionManager = connectionManager;
    }

    /** Compare the relations with the CREATE statements of the repository. */
    setRepository(repository: RepositorySource): void {
        this.repository = repository;
    }

    /** Re-render without reloading, e.g. after the repository changed. */
    rerender(): void {
        this.repoOnlyCache = undefined;
        this._onDidChangeTreeData.fire();
    }

    setFilter(filterText: string): void {
        this._filterText = filterText.toLowerCase();
        this._filterTerms = parseFilterTerms(filterText);
        this._onDidChangeTreeData.fire();
    }

    private scoreString(s: string): number {
        return scoreFilterText(s, this._filterTerms);
    }

    /**
     * Keep only items with a positive score and return them ordered by score
     * descending. Shared by the schema- and category-level filtering branches.
     */
    private sortByScoreDesc<T>(items: T[], score: (item: T) => number): T[] {
        return items
            .map(item => ({ item, score: score(item) }))
            .filter(x => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .map(x => x.item);
    }

    /**
     * Compute non-overlapping [start, end) ranges in `s` that match any of
     * the current filter terms (case-insensitive). Used to highlight matches
     * in tree item labels (VS Code renders these with the list highlight
     * foreground color from the active theme).
     */
    private computeHighlights(s: string): Array<[number, number]> {
        return filterHighlights(s, this._filterTerms);
    }

    refresh(): void {
        this.connectionManager.clearMetadataCache();
        this.repoOnlyCache = undefined;
        this._onDidChangeTreeData.fire();
    }

    /** Ids are stable so a node can be revealed; they are not stored anywhere. */
    private nodeId(element: TreeNode): string {
        if (element.type === 'schema') return `tables/schema/${element.schema}`;
        if (element.type === 'category') return `tables/category/${element.schema}/${element.kind}`;
        return `tables/table/${element.schema}/${element.kind}/${element.table}`;
    }

    private decorate(item: vscode.TreeItem, status: RepoStatus | undefined, tooltip: string): void {
        if (status === 'dbOnly' || status === 'repoOnly') item.resourceUri = statusUri(item.id ?? '', status);
        item.tooltip = status ? `${tooltip}\n\n${statusHint(status)}` : tooltip;
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        if (element.type === 'schema') {
            const highlights = this.computeHighlights(element.schema);
            const label: vscode.TreeItemLabel = { label: element.schema, highlights };
            const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
            item.id = this.nodeId(element);
            item.iconPath = new vscode.ThemeIcon('symbol-namespace');
            item.contextValue = element.status === 'repoOnly' ? 'schema.repoOnly' : 'schema';
            this.decorate(item, element.status, `Schema ${element.schema}`);
            return item;
        } else if (element.type === 'category') {
            const meta = RELATION_KIND_META[element.kind];
            // Categories are auto-expanded so the relations are visible immediately.
            const item = new vscode.TreeItem(meta.label, vscode.TreeItemCollapsibleState.Expanded);
            item.id = this.nodeId(element);
            item.iconPath = new vscode.ThemeIcon(meta.categoryIcon);
            item.contextValue = `category:${element.kind}`;
            item.tooltip = `${meta.label} in ${element.schema}`;
            return item;
        } else {
            const meta = RELATION_KIND_META[element.kind];
            const highlights = this.computeHighlights(element.table);
            const label: vscode.TreeItemLabel = { label: element.table, highlights };
            const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
            item.id = this.nodeId(element);
            item.iconPath = new vscode.ThemeIcon(meta.itemIcon);
            if (element.status === 'repoOnly') {
                // Nothing to open in the Data Viewer: a double click goes to its CREATE statement.
                item.contextValue = 'table.repoOnly';
                item.description = 'only in repository';
                item.command = {
                    command: 'postgresQueryBuilder.goToRepositoryDefinition',
                    title: 'Go to Definition in Repository',
                    arguments: [element, CLICK_ARGUMENT]
                };
            } else {
                item.contextValue = 'table';
                item.command = {
                    command: 'postgresQueryBuilder.openTable',
                    title: 'Open Table',
                    arguments: [element.schema, element.table]
                };
            }
            this.decorate(item, element.status, `${element.schema}.${element.table} (${meta.label})`);
            return item;
        }
    }

    getParent(element: TreeNode): TreeNode | undefined {
        if (element.type === 'table') return { type: 'category', schema: element.schema, kind: element.kind };
        if (element.type === 'category') return { type: 'schema', schema: element.schema };
        return undefined;
    }

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        if (!this.connectionManager.isConnected()) {
            return [];
        }

        try {
            if (!element) {
                this.repository?.ensureScanned();
                const configSchemas = this.connectionManager.getActiveConnectionConfig()?.schemas;
                const { sql, params } = buildSchemaListQuery(configSchemas);
                const rows = await this.connectionManager.queryMetadata(sql, params);
                const comparison = await this.getComparison();

                const schemas: SchemaNode[] = rows.map((row) => this.schemaNode(row.schema_name, true, comparison));
                if (comparison) {
                    const inDatabase = new Set(schemas.map(s => s.schema));
                    for (const schema of await this.repoOnlySchemas(comparison.matcher, inDatabase)) {
                        schemas.push(this.schemaNode(schema, false, comparison));
                    }
                    schemas.sort((a, b) => a.schema.localeCompare(b.schema));
                }

                if (this._filterTerms.length > 0) {
                    // Score each schema by the best-matching relation inside it.
                    // A relation's score = number of filter terms (whitespace-separated)
                    // found as substrings in its qualified name "schema.table".
                    // Schemas with score > 0 are kept and sorted by score desc.
                    const scored: Array<{ schema: SchemaNode; score: number }> = [];
                    for (const schema of schemas) {
                        let best = this.scoreString(schema.schema);
                        for (const relation of await this.getSchemaRelations(schema.schema)) {
                            const s = this.scoreString(`${schema.schema}.${relation.table}`);
                            if (s > best) best = s;
                        }
                        if (best > 0) {
                            scored.push({ schema, score: best });
                        }
                    }
                    scored.sort((a, b) => b.score - a.score);
                    return scored.map(s => s.schema);
                }

                return schemas;
            } else if (element.type === 'schema') {
                // Group the schema's relations into auto-expanded category nodes
                // (Tables / Views / Materialized Views / Foreign Tables). Only
                // categories that contain at least one (matching) relation are shown.
                const relations = await this.getSchemaRelations(element.schema);
                const matching = this._filterTerms.length > 0
                    ? relations.filter(r => this.scoreString(`${r.schema}.${r.table}`) > 0)
                    : relations;

                const kindsPresent = new Set<RelationKind>(matching.map(r => r.kind));
                return (Object.keys(RELATION_KIND_META) as RelationKind[])
                    .filter(kind => kindsPresent.has(kind))
                    .sort((a, b) => RELATION_KIND_META[a].order - RELATION_KIND_META[b].order)
                    .map(kind => ({ type: 'category' as const, schema: element.schema, kind }));
            } else if (element.type === 'category') {
                const relations = await this.getSchemaRelations(element.schema);
                let tables = relations.filter(r => r.kind === element.kind);

                if (this._filterTerms.length > 0) {
                    tables = this.sortByScoreDesc(
                        tables,
                        t => this.scoreString(`${t.schema}.${t.table}`)
                    );
                }

                return tables;
            }
        } catch (err: unknown) {
            Logger.error('TableExplorerProvider.getChildren', err);
            vscode.window.showErrorMessage(`Failed to load tables: ${getErrorMessage(err)}`);
        }

        return [];
    }

    /**
     * All relations of a schema as `TableNode`s, tagged with their kind and ?
     * while there is a repository to compare with — their status, followed by
     * the relations only the repository creates in that schema.
     */
    private async getSchemaRelations(schema: string): Promise<TableNode[]> {
        const rows = await this.connectionManager.queryMetadata(
            buildSchemaRelationListQuery(),
            [schema]
        );
        const comparison = await this.getComparison();
        const relations: TableNode[] = rows.map((row) => {
            const node: TableNode = {
                type: 'table' as const,
                schema,
                table: row.table_name,
                kind: toRelationKind(row.rel_kind)
            };
            if (comparison) this.compare(node, comparison);
            return node;
        });
        if (comparison) {
            relations.push(...(await this.repoOnlyRelations(comparison.matcher)).filter(r => r.schema === schema));
        }
        return relations;
    }

    // ===== Repository comparison =====

    /** The matcher for the current repository snapshot and what is never marked; null while there is nothing to compare with. */
    private async getComparison(): Promise<Comparison | null> {
        const snapshot = this.repository?.snapshot() ?? null;
        if (!snapshot || snapshot.definitions.length === 0) return null;
        const [searchPath, members] = await Promise.all([
            this.connectionManager.queryMetadata(CURRENT_SCHEMAS_QUERY),
            this.connectionManager.queryMetadata(EXTENSION_MEMBERS_QUERY)
        ]);
        const matcher = this.matchers.get(snapshot, searchPath.length > 0 ? String(searchPath[0].schema_name) : 'public');
        if (!matcher) return null;
        if (this.unmarkedCache?.rows !== members) this.unmarkedCache = { rows: members, unmarked: new UnmarkedObjects(members) };
        return { matcher, unmarked: this.unmarkedCache.unmarked };
    }

    /** Give a relation of the database its definitions and status, unless an extension provides it. */
    private compare(node: TableNode, comparison: Comparison): void {
        if (comparison.unmarked.relation(node.schema, node.table)) return;
        node.definitions = comparison.matcher.find({ kind: node.kind, schema: node.schema, name: node.table });
        node.status = databaseObjectStatus(node.definitions);
    }

    private allowedSchema(schema: string): boolean {
        const configSchemas = this.connectionManager.getActiveConnectionConfig()?.schemas;
        if (configSchemas && configSchemas.length > 0) return configSchemas.includes(schema);
        return schema !== 'pg_catalog' && schema !== 'information_schema' && !schema.startsWith('pg_');
    }

    private schemaNode(schema: string, inDatabase: boolean, comparison: Comparison | null): SchemaNode {
        if (!comparison) return { type: 'schema', schema };
        const definitions = comparison.matcher.find({ kind: 'schema', schema: '', name: schema });
        if (!inDatabase) return { type: 'schema', schema, status: 'repoOnly', definitions };
        if (comparison.unmarked.schema(schema)) return { type: 'schema', schema, definitions };
        // Every database has the public schema; no repository has to create it.
        const status = definitions.length === 0 && schema === 'public' ? undefined : databaseObjectStatus(definitions);
        return { type: 'schema', schema, status, definitions };
    }

    /** Every relation of the database the view may show; one cached query across all schemas. */
    private async databaseRelations(): Promise<TableNode[]> {
        const rows = await this.connectionManager.queryMetadata(buildRelationListQuery());
        return rows
            .filter(row => this.allowedSchema(String(row.table_schema)))
            .map(row => ({
                type: 'table' as const,
                schema: String(row.table_schema),
                table: String(row.table_name),
                kind: toRelationKind(row.rel_kind)
            }));
    }

    private async repoOnlyRelations(matcher: DefinitionMatcher): Promise<TableNode[]> {
        if (this.repoOnlyCache?.matcher === matcher) return this.repoOnlyCache.nodes;
        const nodes = this.computeRepoOnlyRelations(matcher);
        this.repoOnlyCache = { matcher, nodes };
        nodes.catch(() => { this.repoOnlyCache = undefined; });
        return nodes;
    }

    private async computeRepoOnlyRelations(matcher: DefinitionMatcher): Promise<TableNode[]> {
        const identities = (await this.databaseRelations()).map(r => ({ kind: r.kind, schema: r.schema, name: r.table }));
        return matcher.unmatched(identities, RELATION_KINDS)
            .filter(r => this.allowedSchema(r.identity.schema))
            .map(r => ({
                type: 'table' as const,
                schema: r.identity.schema,
                table: r.identity.name,
                kind: r.identity.kind as RelationKind,
                status: 'repoOnly' as const,
                definitions: r.definitions
            }));
    }

    /** Schemas that exist only in the repository: created there, or holding relations only created there. */
    private async repoOnlySchemas(matcher: DefinitionMatcher, inDatabase: ReadonlySet<string>): Promise<string[]> {
        const schemas = new Set<string>();
        const dbSchemas = [...inDatabase].map(s => ({ kind: 'schema' as const, schema: '', name: s }));
        for (const r of matcher.unmatched(dbSchemas, new Set<RepoObjectKind>(['schema']))) schemas.add(r.identity.name);
        for (const r of await this.repoOnlyRelations(matcher)) schemas.add(r.schema);
        return [...schemas].filter(s => !inDatabase.has(s) && this.allowedSchema(s)).sort();
    }

    /**
     * The CREATE statements of a node in the repository; null while there is no
     * repository to compare with (comparison off, scan not finished, no SQL files).
     */
    async definitionsFor(element: TreeNode): Promise<LocatedDefinition[] | null> {
        if (element.type !== 'category' && element.definitions) return element.definitions;
        const comparison = await this.getComparison();
        if (!comparison) return null;
        const { matcher } = comparison;
        if (element.type === 'schema') return matcher.find({ kind: 'schema', schema: '', name: element.schema });
        if (element.type === 'table') return matcher.find({ kind: element.kind, schema: element.schema, name: element.table });
        return [];
    }

    // ===== Go to Database Object =====

    /** Every relation the view can show — of the database and of the repository — ignoring the filter. */
    async allRelationNodes(): Promise<TableNode[]> {
        if (!this.connectionManager.isConnected()) return [];
        this.repository?.ensureScanned();
        const relations = await this.databaseRelations();
        const comparison = await this.getComparison();
        if (!comparison) return relations;
        for (const r of relations) this.compare(r, comparison);
        return [...relations, ...(await this.repoOnlyRelations(comparison.matcher))];
    }

    /** True when the Search filter hides the relation. */
    isFilteredOut(node: TableNode): boolean {
        return this._filterTerms.length > 0 && this.scoreString(`${node.schema}.${node.table}`) === 0;
    }
}
