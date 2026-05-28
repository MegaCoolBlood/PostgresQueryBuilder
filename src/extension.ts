import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { TableExplorerProvider } from './tableExplorer';
import { TableWebViewManager } from './tableWebView';
import { SqlEditorManager } from './sqlEditor';
import { SearchViewProvider } from './searchViewProvider';
import { QueryRunner } from './queryRunner';

let connectionManager: ConnectionManager;
let tableExplorer: TableExplorerProvider;
let tableWebViewManager: TableWebViewManager;
let sqlEditorManager: SqlEditorManager;
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
    connectionManager = new ConnectionManager(context);
    tableExplorer = new TableExplorerProvider(connectionManager);
    tableWebViewManager = new TableWebViewManager(context, connectionManager);
    sqlEditorManager = new SqlEditorManager(context, connectionManager);

    // Status bar
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'postgresQueryBuilder.selectConnection';
    updateStatusBar();
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Tree view
    const treeView = vscode.window.createTreeView('postgresTableExplorer', {
        treeDataProvider: tableExplorer,
        showCollapseAll: true
    });
    context.subscriptions.push(treeView);

    // Search view
    const searchViewProvider = new SearchViewProvider();
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SearchViewProvider.viewType, searchViewProvider)
    );
    searchViewProvider.onDidChangeFilter((filter) => {
        tableExplorer.setFilter(filter);
    });

    // Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('postgresQueryBuilder.connect', async () => {
            await connectionManager.connectWithInputFlow();
            updateStatusBar();
            tableExplorer.refresh();
        }),
        vscode.commands.registerCommand('postgresQueryBuilder.disconnect', async () => {
            await connectionManager.disconnect();
            updateStatusBar();
            tableExplorer.refresh();
        }),
        vscode.commands.registerCommand('postgresQueryBuilder.refreshExplorer', () => {
            QueryRunner.clearMetadataCache();
            tableExplorer.refresh();
        }),
        vscode.commands.registerCommand('postgresQueryBuilder.openTable', (schema: string, table: string) => {
            tableWebViewManager.openTableView(schema, table);
        }),
        vscode.commands.registerCommand('postgresQueryBuilder.selectConnection', async () => {
            await connectionManager.selectConnection();
            updateStatusBar();
            tableExplorer.refresh();
        }),
        vscode.commands.registerCommand('postgresQueryBuilder.openSqlEditor', () => {
            sqlEditorManager.openSqlEditor();
        })
    );

    // Listen for connection changes
    connectionManager.onConnectionChanged(() => {
        QueryRunner.clearMetadataCache();
        updateStatusBar();
        tableExplorer.refresh();
    });

    function updateStatusBar() {
        if (connectionManager.isConnected()) {
            const config = connectionManager.getActiveConnectionConfig();
            statusBarItem.text = `$(database) ${config?.name || 'PostgreSQL'}`;
            statusBarItem.tooltip = `Connected to ${config?.host}:${config?.port}/${config?.database}`;
            statusBarItem.backgroundColor = undefined;
        } else {
            statusBarItem.text = '$(database) Disconnected';
            statusBarItem.tooltip = 'Click to select a PostgreSQL connection';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        }
    }
}

export function deactivate() {
    if (connectionManager) {
        connectionManager.dispose();
    }
}
