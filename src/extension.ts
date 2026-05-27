import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { TableExplorerProvider } from './tableExplorer';
import { TableWebViewManager } from './tableWebView';
import { SqlEditorManager } from './sqlEditor';
import { showConnectionForm } from './connectionFormView';

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

    // Commands
    context.subscriptions.push(
        // Open the WebView form to create a new connection
        vscode.commands.registerCommand('postgresQueryBuilder.connect', async () => {
            const vsConfig = vscode.workspace.getConfiguration('postgresQueryBuilder');
            const result = await showConnectionForm(context, {
                name: 'My Database',
                host: vsConfig.get<string>('defaultHost', 'localhost'),
                port: vsConfig.get<number>('defaultPort', 5432),
                database: vsConfig.get<string>('defaultDatabase', 'postgres'),
                user: 'postgres',
                password: ''
            });
            if (!result) { return; }
            try {
                await connectionManager.connectByConfig(result, result.password);
                await connectionManager.saveConnection(result, result.password);
                vscode.window.showInformationMessage(`Connected to ${result.database} on ${result.host}:${result.port}`);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Connection failed: ${err.message}`);
            }
        }),

        // Connect to a saved connection by name (from TreeView click)
        vscode.commands.registerCommand('postgresQueryBuilder.connectToSaved', async (name: string) => {
            const saved = connectionManager.getSavedConnections();
            const config = saved.find(c => c.name === name);
            if (!config) { return; }

            let password = await connectionManager.getPassword(name);
            if (password === undefined) {
                password = await vscode.window.showInputBox({
                    prompt: `Password for "${name}"`,
                    password: true
                });
                if (password === undefined) { return; }
            }
            try {
                await connectionManager.connectByConfig(config, password);
                vscode.window.showInformationMessage(`Connected to ${config.database}`);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Connection failed: ${err.message}`);
            }
        }),

        // Edit an existing connection via form
        vscode.commands.registerCommand('postgresQueryBuilder.editConnection', async (nameOrNode: any) => {
            const name = typeof nameOrNode === 'string' ? nameOrNode : nameOrNode?.config?.name;
            if (!name) { return; }
            const saved = connectionManager.getSavedConnections();
            const config = saved.find(c => c.name === name);
            if (!config) { return; }

            const existingPassword = await connectionManager.getPassword(name) ?? '';
            const result = await showConnectionForm(context, {
                name: config.name,
                host: config.host,
                port: config.port,
                database: config.database,
                user: config.user,
                password: existingPassword
            }, `Edit: ${config.name}`);

            if (!result) { return; }

            // If name changed, delete the old entry
            if (result.name !== name) {
                await connectionManager.deleteConnection(name);
            }
            try {
                await connectionManager.connectByConfig(result, result.password);
                await connectionManager.saveConnection(result, result.password);
                vscode.window.showInformationMessage(`Reconnected to ${result.database}`);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Connection failed: ${err.message}`);
            }
        }),

        // Delete a saved connection
        vscode.commands.registerCommand('postgresQueryBuilder.deleteConnection', async (nameOrNode: any) => {
            const name = typeof nameOrNode === 'string' ? nameOrNode : nameOrNode?.config?.name;
            if (!name) { return; }
            const choice = await vscode.window.showWarningMessage(
                `Delete connection "${name}"?`,
                { modal: true },
                'Delete'
            );
            if (choice !== 'Delete') { return; }
            await connectionManager.deleteConnection(name);
            vscode.window.showInformationMessage(`Connection "${name}" deleted`);
        }),

        vscode.commands.registerCommand('postgresQueryBuilder.disconnect', async () => {
            await connectionManager.disconnect();
        }),

        vscode.commands.registerCommand('postgresQueryBuilder.refreshExplorer', () => {
            tableExplorer.refresh();
        }),

        vscode.commands.registerCommand('postgresQueryBuilder.openTable', (schema: string, table: string) => {
            tableWebViewManager.openTableView(schema, table);
        }),

        vscode.commands.registerCommand('postgresQueryBuilder.selectConnection', async () => {
            const saved = connectionManager.getSavedConnections();
            const active = connectionManager.getActiveConnectionConfig();

            const items: vscode.QuickPickItem[] = [
                ...saved.map(c => ({
                    label: c.name,
                    description: `${c.host}:${c.port}/${c.database}`,
                    detail: active?.name === c.name ? '$(circle-filled) Active' : undefined
                })),
                { label: '$(add) New Connection', description: 'Create a new connection' }
            ];

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a database connection'
            });
            if (!selected) { return; }

            if (selected.label === '$(add) New Connection') {
                vscode.commands.executeCommand('postgresQueryBuilder.connect');
                return;
            }

            vscode.commands.executeCommand('postgresQueryBuilder.connectToSaved', selected.label);
        }),

        vscode.commands.registerCommand('postgresQueryBuilder.openSqlEditor', () => {
            sqlEditorManager.openSqlEditor();
        })
    );

    // Listen for connection changes
    connectionManager.onConnectionChanged(() => {
        updateStatusBar();
        tableExplorer.refresh();
    });

    function updateStatusBar() {
        if (connectionManager.isConnected()) {
            const config = connectionManager.getActiveConnectionConfig();
            statusBarItem.text = `$(database) ${config?.database || 'PostgreSQL'}`;
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
