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
import { SavedQueryStore, SavedQuery } from './savedQueryStore';
import { SavedQueryExplorerProvider } from './savedQueryExplorer';
import { SavedQueryEditor } from './savedQueryEditor';
import { SavedQueryDragController, SavedQueryDropProvider } from './savedQueryDrop';
import { ManageMappingsPanel } from './manageMappingsPanel';
import { QueryRunner } from './queryRunner';
import { TableDragAndDropController, TableStatementDropProvider, QualifierStore } from './tableStatementDrop';
import { ViewDataFromSelect } from './viewDataFromSelect';
import { Logger, getErrorMessage, getErrorStack } from './logger';
import { formatSqlChecked, FormatOptions } from './plpgsqlFormatter';
import { formatOptionsToRepoConfig } from './repoFormatConfig';
import { resolveFormatOptions } from './formatConfig';
import { DoubleClickGate } from './doubleClick';
let connectionManager: ConnectionManager;
let tableExplorer: TableExplorerProvider;
let tableWebViewManager: TableWebViewManager;
let sqlEditorManager: SqlEditorManager;
let modifyHistoryStore: ModifyHistoryStore;
let columnMappingManager: ColumnMappingManager;
let permanentConstraintManager: PermanentConstraintManager;
let savedQueryStore: SavedQueryStore;
let savedQueryExplorer: SavedQueryExplorerProvider;
let savedQueryEditor: SavedQueryEditor;
let viewDataFromSelect: ViewDataFromSelect;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;

/** Detects the double click that opens a table in the Data Viewer. */
const tableClicks = new DoubleClickGate();
/** Detects the double click that opens a bookmarked query in the Data Viewer. */
const savedQueryClicks = new DoubleClickGate();

/** Language IDs the PL/pgSQL formatter applies to. */
const FORMATTER_LANGUAGES = ['sql', 'postgres', 'pgsql'];

/** Read the formatter settings from configuration.
 * Repository-level `.pgformat.json` takes precedence over VS Code settings. */
function getFormatOptions(): FormatOptions {
    const cfg = vscode.workspace.getConfiguration('postgresQueryBuilder');
    const folders = vscode.workspace.workspaceFolders;
    return resolveFormatOptions(
        (configKey) => cfg.get(configKey),
        folders && folders.length > 0 ? folders[0].uri.fsPath : undefined,
        cfg.get<string>('format.configPath')
    );
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
                // data view should only open on a double click.
                if (tableClicks.accept(`${schema}.${table}`)) {
                    tableWebViewManager.openTableView(schema, table);
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

        context.subscriptions.push(
            vscode.commands.registerCommand('postgresQueryBuilder.exportFormatConfig', async () => {
                const folders = vscode.workspace.workspaceFolders;
                if (!folders || folders.length === 0) {
                    vscode.window.showWarningMessage('No workspace folder open. Please open a folder first.');
                    return;
                }
                const targetPath = require('path').join(folders[0].uri.fsPath, '.pgformat.json');
                const fs = require('fs') as typeof import('fs');
                if (fs.existsSync(targetPath)) {
                    const answer = await vscode.window.showWarningMessage(
                        '.pgformat.json already exists. Overwrite with current settings?',
                        { modal: true },
                        'Overwrite'
                    );
                    if (answer !== 'Overwrite') { return; }
                }
                try {
                    const content = formatOptionsToRepoConfig(getFormatOptions());
                    fs.writeFileSync(targetPath, JSON.stringify(content, null, 2) + '\n', 'utf8');
                    const doc = await vscode.workspace.openTextDocument(targetPath);
                    await vscode.window.showTextDocument(doc);
                } catch (err: unknown) {
                    outputChannel.appendLine(`[exportFormatConfig] ${getErrorStack(err)}`);
                    vscode.window.showErrorMessage(`Could not write .pgformat.json: ${getErrorMessage(err)}`);
                }
            })
        );

        connectionManager = new ConnectionManager(context);
        tableExplorer = new TableExplorerProvider(connectionManager);
        modifyHistoryStore = new ModifyHistoryStore(context);
        columnMappingManager = new ColumnMappingManager(context);
        permanentConstraintManager = new PermanentConstraintManager(context);
        savedQueryStore = new SavedQueryStore(context);
        savedQueryExplorer = new SavedQueryExplorerProvider(savedQueryStore);
        savedQueryEditor = new SavedQueryEditor(context, savedQueryStore);
        tableWebViewManager = new TableWebViewManager(context, connectionManager, columnMappingManager, permanentConstraintManager, modifyHistoryStore, savedQueryStore);
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

        context.subscriptions.push(
            vscode.window.createTreeView('postgresSavedQueries', {
                treeDataProvider: savedQueryExplorer,
                canSelectMany: true,
                dragAndDropController: new SavedQueryDragController()
            }),
            vscode.languages.registerDocumentDropEditProvider('*', new SavedQueryDropProvider(savedQueryStore))
        );
        registerSavedQueryCommands(context);

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

/**
 * Ask the user to pick a saved query. Returns the picked query, or undefined
 * when nothing is stored or the pick was cancelled.
 */
async function pickSavedQuery(): Promise<SavedQuery | undefined> {
    const queries = savedQueryStore.getAll();
    if (queries.length === 0) {
        vscode.window.showInformationMessage(
            'No bookmarked queries yet. Use "Bookmark Query" in the Data Viewer to store one.'
        );
        return undefined;
    }
    const picked = await vscode.window.showQuickPick(
        queries.map(q => ({
            label: q.name,
            description: q.scope === 'workspace' ? 'Workspace' : 'Personal',
            detail: q.sql.replace(/\s+/g, ' ').trim(),
            query: q
        })),
        { placeHolder: 'Select a bookmarked query to run' }
    );
    return picked?.query;
}

/** Resolve the query a tree-view command was invoked on, or ask for one. */
async function resolveSavedQuery(arg: unknown): Promise<SavedQuery | undefined> {
    if (typeof arg === 'string') {
        return savedQueryStore.get(arg);
    }
    const node = arg as { query?: SavedQuery } | undefined;
    if (node?.query?.id) {
        return savedQueryStore.get(node.query.id);
    }
    return pickSavedQuery();
}

function registerSavedQueryCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('postgresQueryBuilder.runSavedQuery', async (arg?: unknown) => {
            const query = await resolveSavedQuery(arg);
            if (!query) {
                return;
            }
            await savedQueryStore.touch(query.id);
            await tableWebViewManager.openQueryView(
                query.sql,
                query.name,
                vscode.ViewColumn.Active,
                {
                    id: query.id,
                    parameters: query.parameters,
                    values: savedQueryStore.getParameterValues(query.id)
                }
            );
        }),

        // A bookmark opens on a double click, exactly like a table.
        vscode.commands.registerCommand('postgresQueryBuilder.openSavedQuery', async (id?: unknown) => {
            if (typeof id === 'string' && id && savedQueryClicks.accept(id)) {
                await vscode.commands.executeCommand('postgresQueryBuilder.runSavedQuery', id);
            }
        }),

        vscode.commands.registerCommand('postgresQueryBuilder.saveQueryFromEditor', async () => {
            await savedQueryEditor.saveFromEditor(vscode.window.activeTextEditor);
        }),

        vscode.commands.registerCommand('postgresQueryBuilder.refreshSavedQueries', () => {
            savedQueryExplorer.refresh();
        }),

        vscode.commands.registerCommand('postgresQueryBuilder.renameSavedQuery', async (arg?: unknown) => {
            const query = await resolveSavedQuery(arg);
            if (!query) {
                return;
            }
            const name = await vscode.window.showInputBox({
                prompt: 'New name for the bookmarked query',
                value: query.name,
                validateInput: v => v.trim() ? undefined : 'The name must not be empty.'
            });
            if (name === undefined) {
                return;
            }
            await savedQueryStore.update(query.id, { name: name.trim() });
        }),

        vscode.commands.registerCommand('postgresQueryBuilder.editSavedQuerySql', async (arg?: unknown) => {
            const query = await resolveSavedQuery(arg);
            if (!query) {
                return;
            }
            await savedQueryEditor.open(query.id);
        }),

        vscode.commands.registerCommand('postgresQueryBuilder.duplicateSavedQuery', async (arg?: unknown) => {
            const query = await resolveSavedQuery(arg);
            if (!query) {
                return;
            }
            await savedQueryStore.add(
                {
                    name: `${query.name} (copy)`,
                    sql: query.sql,
                    parameters: query.parameters,
                    schema: query.schema,
                    table: query.table
                },
                query.scope === 'workspace' ? 'workspace' : 'global'
            );
        }),

        vscode.commands.registerCommand('postgresQueryBuilder.deleteSavedQuery', async (arg?: unknown) => {
            const query = await resolveSavedQuery(arg);
            if (!query) {
                return;
            }
            const answer = await vscode.window.showWarningMessage(
                `Delete the bookmarked query "${query.name}"?`, { modal: true }, 'Delete'
            );
            if (answer === 'Delete') {
                await savedQueryStore.delete(query.id);
            }
        }),

        vscode.commands.registerCommand('postgresQueryBuilder.moveSavedQueryToWorkspace', async (arg?: unknown) => {
            const query = await resolveSavedQuery(arg);
            if (!query) {
                return;
            }
            if (!await savedQueryStore.move(query.id, 'workspace')) {
                vscode.window.showWarningMessage(
                    'Could not move the query: it is already shared, or no workspace folder is open.'
                );
            }
        }),

        vscode.commands.registerCommand('postgresQueryBuilder.moveSavedQueryToGlobal', async (arg?: unknown) => {
            const query = await resolveSavedQuery(arg);
            if (!query) {
                return;
            }
            if (!await savedQueryStore.move(query.id, 'global')) {
                vscode.window.showWarningMessage('The query is already stored personally.');
            }
        }),

        vscode.commands.registerCommand('postgresQueryBuilder.openSavedQueriesFile', async () => {
            const uri = savedQueryStore.getWorkspaceFileUri();
            if (!uri || !savedQueryStore.hasWorkspaceFile()) {
                vscode.window.showInformationMessage(
                    'No workspace bookmarked-queries file yet. Move a query to the workspace scope to create it.'
                );
                return;
            }
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
        })
    );
}
