import * as vscode from 'vscode';
import { ConnectionManager, ConnectionConfig } from './connectionManager';

interface ConnectionNode {
    type: 'connection';
    config: ConnectionConfig;
    isActive: boolean;
}

interface SchemaNode {
    type: 'schema';
    schema: string;
}

interface TableNode {
    type: 'table';
    schema: string;
    table: string;
}

interface AddConnectionNode {
    type: 'addConnection';
}

type TreeNode = ConnectionNode | SchemaNode | TableNode | AddConnectionNode;

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
        if (element.type === 'addConnection') {
            const item = new vscode.TreeItem('Add Connection...', vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('add');
            item.contextValue = 'addConnection';
            item.command = { command: 'postgresQueryBuilder.connect', title: 'Add Connection' };
            return item;
        }

        if (element.type === 'connection') {
            const { config, isActive } = element;
            const item = new vscode.TreeItem(
                config.name,
                isActive ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
            );
            item.description = `${config.host}:${config.port}/${config.database}`;
            item.tooltip = `${config.user}@${config.host}:${config.port}/${config.database}`;
            item.contextValue = isActive ? 'connectionActive' : 'connectionInactive';
            item.iconPath = isActive
                ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'))
                : new vscode.ThemeIcon('circle-outline');
            if (!isActive) {
                item.command = {
                    command: 'postgresQueryBuilder.connectToSaved',
                    title: 'Connect',
                    arguments: [config.name]
                };
            }
            return item;
        }

        if (element.type === 'schema') {
            const item = new vscode.TreeItem(element.schema, vscode.TreeItemCollapsibleState.Expanded);
            item.iconPath = new vscode.ThemeIcon('symbol-namespace');
            item.contextValue = 'schema';
            return item;
        }

        // table
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

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        if (!element) {
            // Root: all saved connections + Add Connection node
            const saved = this.connectionManager.getSavedConnections();
            const activeConfig = this.connectionManager.getActiveConnectionConfig();
            const nodes: TreeNode[] = saved.map(config => ({
                type: 'connection' as const,
                config,
                isActive: activeConfig?.name === config.name
            }));
            nodes.push({ type: 'addConnection' });
            return nodes;
        }

        if (element.type === 'connection') {
            if (!element.isActive) { return []; }
            try {
                const result = await this.connectionManager.query(
                    `SELECT schema_name FROM information_schema.schemata
                     WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                     ORDER BY schema_name`
                );
                return result.rows.map((row: any) => ({
                    type: 'schema' as const,
                    schema: row.schema_name
                }));
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to load schemas: ${err.message}`);
                return [];
            }
        }

        if (element.type === 'schema') {
            try {
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
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to load tables: ${err.message}`);
                return [];
            }
        }

        return [];
    }
}
