import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';

interface SchemaNode {
    type: 'schema';
    schema: string;
}

interface TableNode {
    type: 'table';
    schema: string;
    table: string;
}

type TreeNode = SchemaNode | TableNode;

export class TableExplorerProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private connectionManager: ConnectionManager;

    constructor(connectionManager: ConnectionManager) {
        this.connectionManager = connectionManager;
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        if (element.type === 'schema') {
            const item = new vscode.TreeItem(element.schema, vscode.TreeItemCollapsibleState.Expanded);
            item.iconPath = new vscode.ThemeIcon('symbol-namespace');
            item.contextValue = 'schema';
            return item;
        } else {
            const item = new vscode.TreeItem(element.table, vscode.TreeItemCollapsibleState.None);
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
                const result = await this.connectionManager.query(
                    `SELECT schema_name FROM information_schema.schemata
                     WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                     ORDER BY schema_name`
                );

                return result.rows.map((row: any) => ({
                    type: 'schema' as const,
                    schema: row.schema_name
                }));
            } else if (element.type === 'schema') {
                const result = await this.connectionManager.query(
                    `SELECT table_name FROM information_schema.tables
                     WHERE table_schema = $1 AND table_type = 'BASE TABLE'
                     ORDER BY table_name`,
                    [element.schema]
                );

                return result.rows.map((row: any) => ({
                    type: 'table' as const,
                    schema: element.schema,
                    table: row.table_name
                }));
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to load tables: ${err.message}`);
        }

        return [];
    }
}
