import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';

export interface SchemaNode {
    type: 'schema';
    schema: string;
}

export interface TableNode {
    type: 'table';
    schema: string;
    table: string;
}

export type TreeNode = SchemaNode | TableNode;

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
        } else {
            const highlights = this.computeHighlights(element.table);
            const label: vscode.TreeItemLabel = { label: element.table, highlights };
            const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('symbol-class');
            item.contextValue = 'table';
            item.command = {
                command: 'postgresQueryBuilder.openTable',
                title: 'Open Table',
                arguments: [element.schema, element.table]
            };
            item.tooltip = `${element.schema}.${element.table}`;
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
                            `SELECT table_name FROM information_schema.tables
                             WHERE table_schema = $1 AND table_type IN ('BASE TABLE', 'FOREIGN')
                             ORDER BY table_name`,
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
                const rows = await this.connectionManager.queryMetadata(
                    `SELECT table_name FROM information_schema.tables
                     WHERE table_schema = $1 AND table_type IN ('BASE TABLE', 'FOREIGN')
                     ORDER BY table_name`,
                    [element.schema]
                );

                let tables = rows.map((row: any) => ({
                    type: 'table' as const,
                    schema: element.schema,
                    table: row.table_name
                }));

                if (this._filterTerms.length > 0) {
                    const scored = tables
                        .map((t: TableNode) => ({ t, score: this.scoreString(`${t.schema}.${t.table}`) }))
                        .filter((x: { t: TableNode; score: number }) => x.score > 0)
                        .sort((a: { score: number }, b: { score: number }) => b.score - a.score);
                    tables = scored.map((x: { t: TableNode }) => x.t);
                }

                return tables;
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to load tables: ${err.message}`);
        }

        return [];
    }
}
