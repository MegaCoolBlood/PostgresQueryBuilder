import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { TableExplorerProvider } from './tableExplorer';
import { TableWebViewManager } from './tableWebView';
import { SqlEditorManager } from './sqlEditor';
import { SearchViewProvider } from './searchViewProvider';
import { ModifyHistoryStore } from './modifyHistoryStore';
import { ModifyHistoryViewProvider } from './modifyHistoryViewProvider';
import { ColumnMappingManager } from './columnMappingManager';
import { ManageMappingsPanel } from './manageMappingsPanel';
import { QueryRunner } from './queryRunner';
import { TableDragAndDropController, TableStatementDropProvider, QualifierStore } from './tableStatementDrop';
let connectionManager: ConnectionManager;
let tableExplorer: TableExplorerProvider;
let tableWebViewManager: TableWebViewManager;
let sqlEditorManager: SqlEditorManager;
let modifyHistoryStore: ModifyHistoryStore;
let columnMappingManager: ColumnMappingManager;
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
            }),
            vscode.commands.registerCommand('postgresQueryBuilder.exportCustomMappings', async () => {
                try {
                    const defaultUri = columnMappingManager.getWorkspaceFileUri()
                        ?? (vscode.workspace.workspaceFolders?.[0]
                            ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'postgres-query-builder.mappings.json')
                            : undefined);
                    const target = await vscode.window.showSaveDialog({
                        title: 'Export Custom Column Mappings',
                        defaultUri,
                        filters: { 'JSON': ['json'] }
                    });
                    if (!target) return;
                    const n = await columnMappingManager.exportToFile(target);
                    vscode.window.showInformationMessage(`Exported ${n} custom mapping(s).`);
                } catch (err: any) {
                    vscode.window.showErrorMessage(`Export failed: ${err?.message || err}`);
                }
            }),
            vscode.commands.registerCommand('postgresQueryBuilder.importCustomMappings', async () => {
                try {
                    const picked = await vscode.window.showOpenDialog({
                        title: 'Import Custom Column Mappings',
                        canSelectMany: false,
                        filters: { 'JSON': ['json'] }
                    });
                    if (!picked || picked.length === 0) return;
                    const scopePick = await vscode.window.showQuickPick(
                        [
                            { label: 'Workspace (shared via git)', value: 'workspace' as const, description: 'Write to the workspace mappings file' },
                            { label: 'Personal (this user only)', value: 'global' as const, description: 'Stored in VS Code global state' }
                        ],
                        { title: 'Where should the imported mappings be stored?', placeHolder: 'Select target scope' }
                    );
                    if (!scopePick) return;
                    const modePick = await vscode.window.showQuickPick(
                        [
                            { label: 'Merge — skip mappings whose id already exists', value: false },
                            { label: 'Overwrite — replace mappings with the same id', value: true }
                        ],
                        { title: 'How should existing mappings be handled?', placeHolder: 'Select merge mode' }
                    );
                    if (!modePick) return;
                    const res = await columnMappingManager.importFromFile(picked[0], scopePick.value, modePick.value);
                    vscode.window.showInformationMessage(
                        `Import done: ${res.added} added, ${res.replaced} replaced, ${res.skipped} skipped.`
                    );
                } catch (err: any) {
                    vscode.window.showErrorMessage(`Import failed: ${err?.message || err}`);
                }
            }),
            vscode.commands.registerCommand('postgresQueryBuilder.openCustomMappingsFile', async () => {
                const uri = columnMappingManager.getWorkspaceFileUri();
                if (!uri) {
                    vscode.window.showWarningMessage('No workspace folder is open.');
                    return;
                }
                try {
                    const doc = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(doc);
                } catch (err: any) {
                    const create = 'Create file';
                    const choice = await vscode.window.showInformationMessage(
                        `Workspace mappings file does not exist yet (${vscode.workspace.asRelativePath(uri)}). Create it?`,
                        create
                    );
                    if (choice === create) {
                        await columnMappingManager.exportToFile(uri);
                        const doc = await vscode.workspace.openTextDocument(uri);
                        await vscode.window.showTextDocument(doc);
                    }
                }
            }),
            vscode.commands.registerCommand('postgresQueryBuilder.manageCustomMappings', () => {
                ManageMappingsPanel.show(context, columnMappingManager);
            })
        );

        connectionManager = new ConnectionManager(context);
        tableExplorer = new TableExplorerProvider(connectionManager);
        modifyHistoryStore = new ModifyHistoryStore(context);
        columnMappingManager = new ColumnMappingManager(context);
        tableWebViewManager = new TableWebViewManager(context, connectionManager, columnMappingManager, modifyHistoryStore);
        sqlEditorManager = new SqlEditorManager(context, connectionManager, modifyHistoryStore);

        // Status bar
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        statusBarItem.command = 'postgresQueryBuilder.selectConnection';
        updateStatusBar();
        statusBarItem.show();
        context.subscriptions.push(statusBarItem);

        // Tree view
        const treeView = vscode.window.createTreeView('postgresTableExplorer', {
            treeDataProvider: tableExplorer,
            showCollapseAll: true,
            canSelectMany: true,
            dragAndDropController: new TableDragAndDropController()
        });
        context.subscriptions.push(treeView);

        // Allow dropping a table from the tree view into any text editor to
        // insert a generated SQL statement at the drop position.
        const qualifierStore = new QualifierStore(context.globalState);
        const dropQueryRunner = new QueryRunner(connectionManager);
        context.subscriptions.push(
            vscode.languages.registerDocumentDropEditProvider(
                '*',
                new TableStatementDropProvider(dropQueryRunner, qualifierStore)
            )
        );

        // Search view
        const searchViewProvider = new SearchViewProvider();
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(SearchViewProvider.viewType, searchViewProvider)
        );
        searchViewProvider.onDidChangeFilter((filter) => {
            tableExplorer.setFilter(filter);
        });
        searchViewProvider.onDidRequestManageMappings(() => {
            ManageMappingsPanel.show(context, columnMappingManager);
        });

        // Modify history view
        const modifyHistoryProvider = new ModifyHistoryViewProvider(modifyHistoryStore);
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(ModifyHistoryViewProvider.viewType, modifyHistoryProvider)
        );

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
