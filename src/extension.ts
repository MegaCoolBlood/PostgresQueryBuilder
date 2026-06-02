import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { TableExplorerProvider } from './tableExplorer';
import { TableWebViewManager } from './tableWebView';
import { SqlEditorManager } from './sqlEditor';
import { SearchViewProvider } from './searchViewProvider';

let connectionManager: ConnectionManager;
let tableExplorer: TableExplorerProvider;
let tableWebViewManager: TableWebViewManager;
let sqlEditorManager: SqlEditorManager;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('PostgreSQL Query Builder');
    context.subscriptions.push(outputChannel);
    outputChannel.appendLine(`[activate] starting (version ${context.extension?.packageJSON?.version ?? '?'})`);

    try {
        // Register commands FIRST so viewsWelcome / menu links always work,
        // even if later initialization throws.
        context.subscriptions.push(
            vscode.commands.registerCommand('postgresQueryBuilder.connect', async () => {
                try {
                    await connectionManager.connectWithInputFlow();
                    updateStatusBar();
                    tableExplorer.refresh();
                } catch (err: any) {
                    outputChannel.appendLine(`[connect] ${err?.stack || err}`);
                    vscode.window.showErrorMessage(`Connect failed: ${err?.message || err}`);
                }
            }),
            vscode.commands.registerCommand('postgresQueryBuilder.disconnect', async () => {
                await connectionManager.disconnect();
                updateStatusBar();
                tableExplorer.refresh();
            }),
            vscode.commands.registerCommand('postgresQueryBuilder.refreshExplorer', () => {
                tableExplorer?.refresh();
            }),
            vscode.commands.registerCommand('postgresQueryBuilder.openTable', (schema: string, table: string) => {
                tableWebViewManager.openTableView(schema, table);
            }),
            vscode.commands.registerCommand('postgresQueryBuilder.selectConnection', async () => {
                try {
                    await connectionManager.selectConnection();
                    updateStatusBar();
                    tableExplorer.refresh();
                } catch (err: any) {
                    outputChannel.appendLine(`[selectConnection] ${err?.stack || err}`);
                    vscode.window.showErrorMessage(`Select connection failed: ${err?.message || err}`);
                }
            }),
            vscode.commands.registerCommand('postgresQueryBuilder.openSqlEditor', () => {
                sqlEditorManager.openSqlEditor();
            })
        );

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

        // Listen for connection changes
        connectionManager.onConnectionChanged(() => {
            updateStatusBar();
            tableExplorer.refresh();
        });

        outputChannel.appendLine('[activate] done');
    } catch (err: any) {
        outputChannel.appendLine(`[activate] FAILED: ${err?.stack || err}`);
        vscode.window.showErrorMessage(`PostgreSQL Query Builder failed to activate: ${err?.message || err}`);
        throw err;
    }

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
