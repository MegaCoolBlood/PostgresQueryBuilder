import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { TableExplorerProvider } from './tableExplorer';
import { TableWebViewManager } from './tableWebView';
import { SqlEditorManager } from './sqlEditor';
import { SearchViewProvider } from './searchViewProvider';
import { ModifyHistoryStore } from './modifyHistoryStore';
import { ModifyHistoryViewProvider } from './modifyHistoryViewProvider';
import { ColumnMappingManager } from './columnMappingManager';
import { PermanentConstraintManager } from './permanentConstraintManager';
import { ManageMappingsPanel } from './manageMappingsPanel';
import { QueryRunner } from './queryRunner';
import { TableDragAndDropController, TableStatementDropProvider, QualifierStore } from './tableStatementDrop';
import { ViewDataFromSelect } from './viewDataFromSelect';
import { Logger, getErrorMessage, getErrorStack } from './logger';
import { formatSqlChecked, coerceFormatOptions, FormatOptions } from './plpgsqlFormatter';
let connectionManager: ConnectionManager;
let tableExplorer: TableExplorerProvider;
let tableWebViewManager: TableWebViewManager;
let sqlEditorManager: SqlEditorManager;
let modifyHistoryStore: ModifyHistoryStore;
let columnMappingManager: ColumnMappingManager;
let permanentConstraintManager: PermanentConstraintManager;
let viewDataFromSelect: ViewDataFromSelect;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;

/** Max delay (ms) between two clicks on the same table to count as a double click. */
const DOUBLE_CLICK_MS = 500;
/** Tracks the last table click to detect double clicks in the explorer. */
let lastTableClick: { key: string; time: number } = { key: '', time: 0 };

/** Language IDs the PL/pgSQL formatter applies to. */
const FORMATTER_LANGUAGES = ['sql', 'postgres', 'pgsql'];

/** Read the formatter settings from configuration. */
function getFormatOptions(): FormatOptions {
    const cfg = vscode.workspace.getConfiguration('postgresQueryBuilder');
    return coerceFormatOptions({
        keywordCase: cfg.get('format.keywordCase'),
        identifierCase: cfg.get('format.identifierCase'),
        dataTypeCase: cfg.get('format.dataTypeCase'),
        indentStyle: cfg.get('format.indentStyle'),
        indentSize: cfg.get('format.indentSize'),
        commaStyle: cfg.get('format.commaStyle'),
        blankLines: cfg.get('format.blankLines'),
        simpleSelectSingleLine: cfg.get('format.simpleSelectSingleLine'),
        listThresholds: cfg.get('format.listThresholds'),
        normalizeDataTypes: cfg.get('format.normalizeDataTypes')
    });
}

/** Whether the formatter is enabled (master toggle). */
function isFormatterEnabled(): boolean {
    return vscode.workspace.getConfiguration('postgresQueryBuilder').get<boolean>('format.enable', true);
}

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('PostgreSQL Query Builder');
    context.subscriptions.push(outputChannel);
    Logger.init(outputChannel);
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
                } catch (err: unknown) {
                    outputChannel.appendLine(`[connect] ${getErrorStack(err)}`);
                    vscode.window.showErrorMessage(`Connect failed: ${getErrorMessage(err)}`);
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
            vscode.commands.registerCommand('postgresQueryBuilder.editSearchPath', async () => {
                if (!connectionManager.isConnected()) {
                    vscode.window.showWarningMessage('No active PostgreSQL connection.');
                    return;
                }
                try {
                    const current = await connectionManager.getSearchPath();
                    const input = await vscode.window.showInputBox({
                        title: 'PostgreSQL search_path',
                        prompt: 'Edit the search_path for the active connection (comma-separated schemas). Leave empty to restore the server default.',
                        value: current,
                        ignoreFocusOut: true
                    });
                    if (input === undefined) {
                        return; // cancelled
                    }
                    await connectionManager.setSearchPath(input);
                    const effective = await connectionManager.getSearchPath();
                    tableExplorer.refresh();
                    vscode.window.showInformationMessage(`search_path is now: ${effective}`);
                } catch (err: unknown) {
                    outputChannel.appendLine(`[editSearchPath] ${getErrorStack(err)}`);
                    vscode.window.showErrorMessage(`Failed to update search_path: ${getErrorMessage(err)}`);
                }
            }),
            vscode.commands.registerCommand('postgresQueryBuilder.openTable', (schema: string, table: string) => {
                // VS Code fires a tree item's command on a single click, but the
                // data view should only open on a double click. Detect a second
                // click on the same table within a short window.
                const now = Date.now();
                const key = `${schema}.${table}`;
                if (lastTableClick.key === key && now - lastTableClick.time < DOUBLE_CLICK_MS) {
                    lastTableClick = { key: '', time: 0 };
                    tableWebViewManager.openTableView(schema, table);
                } else {
                    lastTableClick = { key, time: now };
                }
            }),
            vscode.commands.registerCommand('postgresQueryBuilder.selectConnection', async () => {
                try {
                    await connectionManager.selectConnection();
                    updateStatusBar();
                    tableExplorer.refresh();
                } catch (err: unknown) {
                    outputChannel.appendLine(`[selectConnection] ${getErrorStack(err)}`);
                    vscode.window.showErrorMessage(`Select connection failed: ${getErrorMessage(err)}`);
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
                } catch (err: unknown) {
                    vscode.window.showErrorMessage(`Export failed: ${getErrorMessage(err)}`);
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
                } catch (err: unknown) {
                    vscode.window.showErrorMessage(`Import failed: ${getErrorMessage(err)}`);
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
                } catch {
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
            }),
            vscode.commands.registerCommand('postgresQueryBuilder.viewDataFromSelect', async () => {
                try {
                    await viewDataFromSelect.run(vscode.window.activeTextEditor);
                } catch (err: unknown) {
                    outputChannel.appendLine(`[viewDataFromSelect] ${getErrorStack(err)}`);
                    vscode.window.showErrorMessage(`View Data failed: ${getErrorMessage(err)}`);
                }
            }),
            vscode.commands.registerCommand('postgresQueryBuilder.formatSql', async () => {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    vscode.window.showWarningMessage('No active editor to format.');
                    return;
                }
                if (!isFormatterEnabled()) {
                    vscode.window.showWarningMessage('The PL/pgSQL formatter is disabled (postgresQueryBuilder.format.enable).');
                    return;
                }
                try {
                    const opts = getFormatOptions();
                    const sel = editor.selection;
                    const hasSelection = !sel.isEmpty;
                    const range = hasSelection
                        ? new vscode.Range(sel.start, sel.end)
                        : new vscode.Range(
                            editor.document.positionAt(0),
                            editor.document.positionAt(editor.document.getText().length)
                        );
                    const outcome = formatSqlChecked(editor.document.getText(range), opts);
                    if (!outcome.ok) {
                        outputChannel.appendLine(`[formatSql] skipped: ${outcome.reason}`);
                        vscode.window.showWarningMessage(`Formatting skipped to protect your code: ${outcome.reason}`);
                        return;
                    }
                    await editor.edit((b) => b.replace(range, outcome.text));
                } catch (err: unknown) {
                    outputChannel.appendLine(`[formatSql] ${getErrorStack(err)}`);
                    vscode.window.showErrorMessage(`Format failed: ${getErrorMessage(err)}`);
                }
            })
        );

        connectionManager = new ConnectionManager(context);
        tableExplorer = new TableExplorerProvider(connectionManager);
        modifyHistoryStore = new ModifyHistoryStore(context);
        columnMappingManager = new ColumnMappingManager(context);
        permanentConstraintManager = new PermanentConstraintManager(context);
        tableWebViewManager = new TableWebViewManager(context, connectionManager, columnMappingManager, permanentConstraintManager, modifyHistoryStore);
        sqlEditorManager = new SqlEditorManager(context, connectionManager, modifyHistoryStore);
        viewDataFromSelect = new ViewDataFromSelect(context, connectionManager, tableWebViewManager);

        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        statusBarItem.command = 'postgresQueryBuilder.selectConnection';
        updateStatusBar();
        statusBarItem.show();
        context.subscriptions.push(statusBarItem);

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
                new TableStatementDropProvider(dropQueryRunner, qualifierStore, columnMappingManager)
            )
        );

        // PL/pgSQL document formatter (full document + selection range).
        const applyChecked = (document: vscode.TextDocument, range: vscode.Range, source: string): vscode.TextEdit[] => {
            const outcome = formatSqlChecked(document.getText(range), getFormatOptions());
            if (!outcome.ok) {
                outputChannel.appendLine(`[${source}] skipped: ${outcome.reason}`);
                vscode.window.showWarningMessage(`Formatting skipped to protect your code: ${outcome.reason}`);
                return [];
            }
            return [vscode.TextEdit.replace(range, outcome.text)];
        };
        const formattingProvider: vscode.DocumentFormattingEditProvider & vscode.DocumentRangeFormattingEditProvider = {
            provideDocumentFormattingEdits(document) {
                if (!isFormatterEnabled()) return [];
                const fullRange = new vscode.Range(
                    document.positionAt(0),
                    document.positionAt(document.getText().length)
                );
                return applyChecked(document, fullRange, 'format');
            },
            provideDocumentRangeFormattingEdits(document, range) {
                if (!isFormatterEnabled()) return [];
                return applyChecked(document, range, 'formatRange');
            }
        };
        for (const lang of FORMATTER_LANGUAGES) {
            context.subscriptions.push(
                vscode.languages.registerDocumentFormattingEditProvider(lang, formattingProvider),
                vscode.languages.registerDocumentRangeFormattingEditProvider(lang, formattingProvider)
            );
        }

        // Optional format-on-save, controlled by our own setting (default off).
        context.subscriptions.push(
            vscode.workspace.onWillSaveTextDocument((e) => {
                const cfg = vscode.workspace.getConfiguration('postgresQueryBuilder');
                if (!cfg.get<boolean>('format.enable', true)) return;
                if (!cfg.get<boolean>('format.formatOnSave', false)) return;
                if (!FORMATTER_LANGUAGES.includes(e.document.languageId)) return;
                e.waitUntil(Promise.resolve().then(() => {
                    try {
                        const fullRange = new vscode.Range(
                            e.document.positionAt(0),
                            e.document.positionAt(e.document.getText().length)
                        );
                        const outcome = formatSqlChecked(e.document.getText(), getFormatOptions());
                        if (!outcome.ok) {
                            outputChannel.appendLine(`[formatOnSave] skipped: ${outcome.reason}`);
                            vscode.window.showWarningMessage(`Formatting skipped to protect your code: ${outcome.reason}`);
                            return [];
                        }
                        return [vscode.TextEdit.replace(fullRange, outcome.text)];
                    } catch (err: unknown) {
                        outputChannel.appendLine(`[formatOnSave] ${getErrorStack(err)}`);
                        return [];
                    }
                }));
            })
        );

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

        const modifyHistoryProvider = new ModifyHistoryViewProvider(modifyHistoryStore);
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(ModifyHistoryViewProvider.viewType, modifyHistoryProvider)
        );

        connectionManager.onConnectionChanged(() => {
            updateStatusBar();
            tableExplorer.refresh();
        });

        outputChannel.appendLine('[activate] done');
    } catch (err: unknown) {
        outputChannel.appendLine(`[activate] FAILED: ${getErrorStack(err)}`);
        vscode.window.showErrorMessage(`PostgreSQL Query Builder failed to activate: ${getErrorMessage(err)}`);
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
