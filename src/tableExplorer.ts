import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { buildSchemaRelationListQuery } from './queryRunner';

export interface SchemaNode {
    type: 'schema';
    schema: string;
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
}

export type TreeNode = SchemaNode | CategoryNode | TableNode;

/**
 * Display metadata for each relation kind: the category label shown in the
 * tree, the icon for category and leaf nodes, and the order in which the
 * categories appear under a schema.
 */
const RELATION_KIND_META: Record<RelationKind, { label: string; categoryIcon: string; itemIcon: string; order: number }> = {
    table: { label: 'Tables', categoryIcon: 'folder', itemIcon: 'symbol-class', order: 0 },
    view: { label: 'Views', categoryIcon: 'folder', itemIcon: 'eye', order: 1 },
    matview: { label: 'Materialized Views', categoryIcon: 'folder', itemIcon: 'layers', order: 2 },
    foreign: { label: 'Foreign Tables', categoryIcon: 'folder', itemIcon: 'plug', order: 3 }
};

/** Normalize the raw `rel_kind` value returned by the relation queries. */
function toRelationKind(raw: unknown): RelationKind {
    return raw === 'view' || raw === 'matview' || raw === 'foreign' ? raw : 'table';
}

export class TableExplorerProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private connectionManager: ConnectionManager;
    private _filterText = '';
    private _filterTerms: string[] = [];

    constructor(connectionManager: ConnectionManager) {
        this.connectionManager = connectionManager;
    }

    setFilter(filterText: string): void {
        this._filterText = filterText.toLowerCase();
        this._filterTerms = this._filterText
            .split(/\s+/)
            .map(t => t.trim())
            .filter(t => t.length > 0);
        this._onDidChangeTreeData.fire();
    }

    private scoreString(s: string): number {
        if (this._filterTerms.length === 0) return 0;
        const lower = s.toLowerCase();
        let score = 0;
        for (const term of this._filterTerms) {
            if (lower.includes(term)) score++;
        }
        return score;
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
        if (this._filterTerms.length === 0) return [];
        const lower = s.toLowerCase();
        const ranges: Array<[number, number]> = [];
        for (const term of this._filterTerms) {
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

    refresh(): void {
        this.connectionManager.clearMetadataCache();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        if (element.type === 'schema') {
            const highlights = this.computeHighlights(element.schema);
            const label: vscode.TreeItemLabel = { label: element.schema, highlights };
            const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
            item.iconPath = new vscode.ThemeIcon('symbol-namespace');
            item.contextValue = 'schema';
            return item;
        } else if (element.type === 'category') {
            const meta = RELATION_KIND_META[element.kind];
            // Categories are auto-expanded so the relations are visible immediately.
            const item = new vscode.TreeItem(meta.label, vscode.TreeItemCollapsibleState.Expanded);
            item.iconPath = new vscode.ThemeIcon(meta.categoryIcon);
            item.contextValue = `category:${element.kind}`;
            return item;
        } else {
            const meta = RELATION_KIND_META[element.kind];
            const highlights = this.computeHighlights(element.table);
            const label: vscode.TreeItemLabel = { label: element.table, highlights };
            const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon(meta.itemIcon);
            item.contextValue = 'table';
            item.command = {
                command: 'postgresQueryBuilder.openTable',
                title: 'Open Table',
                arguments: [element.schema, element.table]
            };
            item.tooltip = `${element.schema}.${element.table} (${meta.label})`;
            return item;
        }
    }

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        if (!this.connectionManager.isConnected()) {
            return [];
        }

        try {
            if (!element) {
                const configSchemas = this.connectionManager.getActiveConnectionConfig()?.schemas;
                let query: string;
                let params: any[] | undefined;

                if (configSchemas && configSchemas.length > 0) {
                    const placeholders = configSchemas.map((_, i) => `$${i + 1}`).join(', ');
                    query = `SELECT schema_name FROM information_schema.schemata
                             WHERE schema_name IN (${placeholders})
                             ORDER BY schema_name`;
                    params = configSchemas;
                } else {
                    query = `SELECT schema_name FROM information_schema.schemata
                             WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                             ORDER BY schema_name`;
                }

                const rows = await this.connectionManager.queryMetadata(query, params);

                const schemas = rows.map((row: any) => ({
                    type: 'schema' as const,
                    schema: row.schema_name
                }));

                if (this._filterTerms.length > 0) {
                    // Score each schema by the best-matching table inside it.
                    // A table's score = number of filter terms (whitespace-separated)
                    // found as substrings in its qualified name "schema.table".
                    // Schemas with score > 0 are kept and sorted by score desc.
                    const scored: Array<{ schema: SchemaNode; score: number }> = [];
                    for (const schema of schemas) {
                        const rows = await this.connectionManager.queryMetadata(
                            buildSchemaRelationListQuery(),
                            [schema.schema]
                        );
                        let best = this.scoreString(schema.schema);
                        for (const row of rows) {
                            const s = this.scoreString(`${schema.schema}.${row.table_name}`);
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
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to load tables: ${err.message}`);
        }

        return [];
    }

    /** Fetch all relations of a schema as `TableNode`s, tagged with their kind. */
    private async getSchemaRelations(schema: string): Promise<TableNode[]> {
        const rows = await this.connectionManager.queryMetadata(
            buildSchemaRelationListQuery(),
            [schema]
        );
        return rows.map((row: any) => ({
            type: 'table' as const,
            schema,
            table: row.table_name,
            kind: toRelationKind(row.rel_kind)
        }));
    }
}
