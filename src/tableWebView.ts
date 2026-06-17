import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { QueryRunner, buildRelationListQuery } from './queryRunner';
import { ExportService } from './exportService';
import { ColumnMappingManager } from './columnMappingManager';
import { PermanentConstraintManager } from './permanentConstraintManager';
import { ModifyHistoryStore, isModifyingSql, splitSqlStatements } from './modifyHistoryStore';
import { getErrorMessage } from './logger';
import * as path from 'path';
import * as fs from 'fs';

/** Shared context passed to each webview message handler. */
interface MessageContext {
    panel: vscode.WebviewPanel;
    schema: string;
    table: string;
    key: string;
    message: any;
    queryRunner: QueryRunner;
}

export class TableWebViewManager {
    private panels: Map<string, vscode.WebviewPanel> = new Map();
    private pendingFilters: Map<string, { column: string; value: string }> = new Map();
    private context: vscode.ExtensionContext;
    private connectionManager: ConnectionManager;
    private exportService: ExportService;
    private columnMappingManager: ColumnMappingManager;
    private permanentConstraintManager: PermanentConstraintManager;
    private modifyHistoryStore?: ModifyHistoryStore;

    constructor(context: vscode.ExtensionContext, connectionManager: ConnectionManager, columnMappingManager: ColumnMappingManager, permanentConstraintManager: PermanentConstraintManager, modifyHistoryStore?: ModifyHistoryStore) {
        this.context = context;
        this.connectionManager = connectionManager;
        this.exportService = new ExportService(context);
        this.columnMappingManager = columnMappingManager;
        this.permanentConstraintManager = permanentConstraintManager;
        this.modifyHistoryStore = modifyHistoryStore;

        // Push refreshed mappings to every open panel when the underlying store
        // changes (e.g. workspace file edit, import, scope move).
        context.subscriptions.push(
            this.columnMappingManager.onDidChange(() => this.broadcastMappings())
        );
    }

    private broadcastMappings(): void {
        for (const [key, panel] of this.panels.entries()) {
            const dot = key.indexOf('.');
            if (dot < 0) continue;
            const schema = key.substring(0, dot);
            const table = key.substring(dot + 1);
            const mappings = this.columnMappingManager.getMappingsForTable(schema, table);
            try {
                panel.webview.postMessage({ command: 'customMappingsLoaded', mappings });
            } catch {
                // Panel may be disposed; ignore.
            }
        }
    }

    async openTableView(schema: string, table: string): Promise<void> {
        const key = `${schema}.${table}`;

        const existingPanel = this.panels.get(key);
        if (existingPanel) {
            existingPanel.reveal();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'postgresTableView',
            `${schema}.${table}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.file(path.join(this.context.extensionPath, 'src', 'webview'))
                ]
            }
        );

        this.panels.set(key, panel);

        // Tracks whether the panel has been disposed so async work that resolves
        // after the user closed the view does not post to a dead webview.
        let disposed = false;
        panel.onDidDispose(() => {
            disposed = true;
            this.panels.delete(key);
        });

        panel.webview.html = this.getWebviewContent(panel.webview);

        // Send initial info immediately so the webview can show query + loading state
        const alwaysQuote = vscode.workspace.getConfiguration('postgresQueryBuilder').get<boolean>('alwaysQuote', false);
        const thousandSeparator = vscode.workspace.getConfiguration('postgresQueryBuilder').get<string>('thousandSeparator', ' ');
        let tableReference = `${schema}.${table}`;
        try {
            const initQueryRunner = new QueryRunner(this.connectionManager);
            const initSelectBuildInfo = await initQueryRunner.getSelectBuildInfo(schema, table);
            tableReference = initSelectBuildInfo.tableReference;
        } catch {
            // Ignore init formatting errors; loadData will provide the authoritative value
        }
        panel.webview.postMessage({
            command: 'init',
            schema: schema,
            table: table,
            alwaysQuote: alwaysQuote,
            tableReference: tableReference,
            thousandSeparator: thousandSeparator,
            connectionName: this.getConnectionName(),
            permanentConstraints: this.permanentConstraintManager.getConstraints(schema, table)
        });

        // Push connection updates to the webview while it's open
        const connSub = this.connectionManager.onConnectionChanged(() => {
            if (disposed) {
                return;
            }
            panel.webview.postMessage({
                command: 'connectionChanged',
                connectionName: this.getConnectionName()
            });
        });
        panel.onDidDispose(() => connSub.dispose());

        panel.webview.onDidReceiveMessage(async (message) => {
            const handler = this.messageHandlers[message.command];
            if (!handler) {
                return;
            }
            const queryRunner = new QueryRunner(this.connectionManager);
            const ctx: MessageContext = { panel, schema, table, key, message, queryRunner };

            try {
                await handler.call(this, ctx);
            } catch (err: unknown) {
                if (!disposed) {
                    panel.webview.postMessage({
                        command: 'error',
                        text: getErrorMessage(err)
                    });
                }
                vscode.window.showErrorMessage(`Query error: ${getErrorMessage(err)}`);
            }
        });
    }

    /** Maps each webview message command to its handler method. */
    private readonly messageHandlers: Record<string, (ctx: MessageContext) => Promise<void> | void> = {
        loadData: this.handleLoadData,
        previewSQL: this.handlePreviewSQL,
        commitChanges: this.handleCommitChanges,
        showError: this.handleShowError,
        runCustomQuery: this.handleRunCustomQuery,
        saveQueryHistory: this.handleSaveQueryHistory,
        getQueryHistory: this.handleGetQueryHistory,
        openForeignKey: this.handleOpenForeignKey,
        addCustomMapping: this.handleAddCustomMapping,
        updateCustomMapping: this.handleUpdateCustomMapping,
        deleteCustomMapping: this.handleDeleteCustomMapping,
        savePermanentConstraints: this.handleSavePermanentConstraints,
        getTablesForTypeahead: this.handleGetTablesForTypeahead,
        getColumnsForTypeahead: this.handleGetColumnsForTypeahead,
        browseExportLocation: this.handleBrowseExportLocation,
        getExportDefaults: this.handleGetExportDefaults,
        saveExportDefaults: this.handleSaveExportDefaults,
        exportData: this.handleExportData
    };

    private async handleLoadData(ctx: MessageContext): Promise<void> {
        const { panel, schema, table, key, message, queryRunner } = ctx;
        const selectBuildInfo = await queryRunner.getSelectBuildInfo(schema, table);

        // Optional permanent WHERE constraint applied to the default table view.
        const where = typeof message.where === 'string' ? message.where : '';

        // Start metadata fetches in parallel with data fetch
        const pkPromise = queryRunner.getPrimaryKeys(schema, table);
        const fkPromise = queryRunner.getForeignKeys(schema, table);
        const refsPromise = queryRunner.getReferencingTables(schema, table);

        // Fetch rows + columns (fast essentials)
        const columns = await queryRunner.getColumns(schema, table);
        const data = await queryRunner.fetchRows(
            schema, table, message.offset || 0, message.limit || 50, where
        );
        const totalCount = await queryRunner.getRowCount(schema, table, where);

        panel.webview.postMessage({
            command: 'dataLoaded',
            data: data,
            totalCount: totalCount,
            columns: columns,
            schema: schema,
            table: table,
            alwaysQuote: selectBuildInfo.alwaysQuote,
            tableReference: selectBuildInfo.tableReference,
            connectionName: this.getConnectionName()
        });

        // Send pending filter after data is loaded
        const pendingFilter = this.pendingFilters.get(key);
        if (pendingFilter) {
            this.pendingFilters.delete(key);
            panel.webview.postMessage({
                command: 'applyFilter',
                column: pendingFilter.column,
                value: pendingFilter.value
            });
        }

        // Deliver metadata results as they resolve
        pkPromise.then(primaryKeys => {
            panel.webview.postMessage({
                command: 'primaryKeysLoaded',
                primaryKeys: primaryKeys
            });
        }).catch(err => console.warn(`Failed to load PKs: ${err.message}`));

        fkPromise.then(foreignKeys => {
            panel.webview.postMessage({
                command: 'foreignKeysLoaded',
                foreignKeys: foreignKeys
            });
        }).catch(err => console.warn(`Failed to load FKs: ${err.message}`));

        refsPromise.then(referencingTables => {
            panel.webview.postMessage({
                command: 'referencingTablesLoaded',
                referencingTables: referencingTables
            });
        }).catch(err => console.warn(`Failed to load referencing tables: ${err.message}`));

        // Send custom column mappings
        const customMappings = this.columnMappingManager.getMappingsForTable(schema, table);
        panel.webview.postMessage({
            command: 'customMappingsLoaded',
            mappings: customMappings
        });
    }

    private async handlePreviewSQL(ctx: MessageContext): Promise<void> {
        const { panel, schema, table, message, queryRunner } = ctx;
        const sql = queryRunner.generateSQL(
            schema,
            table,
            message.changes
        );
        panel.webview.postMessage({
            command: 'sqlPreview',
            sql,
            connectionName: this.getConnectionName()
        });
    }

    private async handleCommitChanges(ctx: MessageContext): Promise<void> {
        const { panel, schema, table, message, queryRunner } = ctx;
        await queryRunner.commitChanges(
            schema,
            table,
            message.changes
        );
        if (this.modifyHistoryStore) {
            try {
                const sqlText = queryRunner.generateSQL(schema, table, message.changes);
                const stmts = splitSqlStatements(sqlText).map(sql => ({ sql, schema, table }));
                if (stmts.length > 0) this.modifyHistoryStore.addMany(stmts);
            } catch { /* ignore history failures */ }
        }
        panel.webview.postMessage({ command: 'commitSuccess' });
        vscode.window.showInformationMessage(
            `Changes committed to ${schema}.${table}`
        );
    }

    private handleShowError(ctx: MessageContext): void {
        vscode.window.showErrorMessage(ctx.message.text);
    }

    private async handleRunCustomQuery(ctx: MessageContext): Promise<void> {
        const { panel, schema, table, message, queryRunner } = ctx;
        const result = await queryRunner.executeSQL(message.sql);
        if (this.modifyHistoryStore) {
            for (const stmt of splitSqlStatements(message.sql)) {
                if (isModifyingSql(stmt)) {
                    this.modifyHistoryStore.add({ sql: stmt, schema, table });
                }
            }
        }
        // Resolve field OIDs to type names
        const oids = result.fields.map((f) => f.dataTypeID).filter((id: number) => id > 0);
        let typeMap: Record<number, string> = {};
        if (oids.length > 0) {
            const typeRows = await this.connectionManager.query(
                `SELECT oid, typname FROM pg_type WHERE oid = ANY($1)`,
                [oids]
            );
            for (const row of typeRows.rows) {
                typeMap[row.oid] = row.typname;
            }
        }
        const cols = result.fields.map((f) => ({
            name: f.name,
            dataType: typeMap[f.dataTypeID] || '',
            isNullable: true,
            columnDefault: null
        }));
        panel.webview.postMessage({
            command: 'queryResult',
            rows: result.rows,
            columns: cols,
            connectionName: this.getConnectionName()
        });
    }

    private handleSaveQueryHistory(ctx: MessageContext): void {
        const { panel, schema, table, message } = ctx;
        this.saveQueryToHistory(schema, table, message.sql);
        panel.webview.postMessage({
            command: 'queryHistoryUpdated',
            history: this.getQueryHistory(schema, table)
        });
    }

    private handleGetQueryHistory(ctx: MessageContext): void {
        const { panel, schema, table } = ctx;
        panel.webview.postMessage({
            command: 'queryHistoryUpdated',
            history: this.getQueryHistory(schema, table)
        });
    }

    private async handleOpenForeignKey(ctx: MessageContext): Promise<void> {
        const { message } = ctx;
        const fkSchema = message.refSchema;
        const fkTable = message.refTable;
        const fkColumn = message.refColumn;
        const fkValue = message.value;
        await this.openTableViewWithFilter(fkSchema, fkTable, fkColumn, fkValue);
    }

    private async handleAddCustomMapping(ctx: MessageContext): Promise<void> {
        const { message } = ctx;
        const scope = message.scope === 'workspace' ? 'workspace' : 'global';
        await this.columnMappingManager.addMapping(message.mapping, scope);
        // onDidChange will broadcast to all panels.
    }

    private async handleUpdateCustomMapping(ctx: MessageContext): Promise<void> {
        await this.columnMappingManager.updateMapping(ctx.message.mappingId, ctx.message.mapping);
    }

    private async handleDeleteCustomMapping(ctx: MessageContext): Promise<void> {
        await this.columnMappingManager.deleteMapping(ctx.message.mappingId);
    }

    private async handleSavePermanentConstraints(ctx: MessageContext): Promise<void> {
        const { schema, table, message } = ctx;
        await this.permanentConstraintManager.setConstraints(
            schema, table, Array.isArray(message.conditions) ? message.conditions : []
        );
    }

    private async handleGetTablesForTypeahead(ctx: MessageContext): Promise<void> {
        const { panel } = ctx;
        try {
            const tables = await this.connectionManager.queryMetadata(
                buildRelationListQuery()
            );
            panel.webview.postMessage({
                command: 'tablesForTypeahead',
                tables: tables.map((r) => ({ schema: r.table_schema, table: r.table_name }))
            });
        } catch (err: unknown) {
            console.warn(`Failed to load tables for typeahead: ${getErrorMessage(err)}`);
        }
    }

    private async handleGetColumnsForTypeahead(ctx: MessageContext): Promise<void> {
        const { panel, message } = ctx;
        try {
            const cols = await this.connectionManager.queryMetadata(
                `SELECT column_name FROM information_schema.columns
                 WHERE table_schema = $1 AND table_name = $2
                 ORDER BY ordinal_position`,
                [message.schema, message.table]
            );
            panel.webview.postMessage({
                command: 'columnsForTypeahead',
                columns: cols.map((r) => r.column_name),
                forSchema: message.schema,
                forTable: message.table
            });
        } catch (err: unknown) {
            console.warn(`Failed to load columns for typeahead: ${getErrorMessage(err)}`);
        }
    }

    private async handleBrowseExportLocation(ctx: MessageContext): Promise<void> {
        const { panel } = ctx;
        const folderUri = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select Export Folder'
        });
        if (folderUri && folderUri.length > 0) {
            panel.webview.postMessage({
                command: 'exportLocationSelected',
                path: folderUri[0].fsPath
            });
        }
    }

    private handleGetExportDefaults(ctx: MessageContext): void {
        const defaults = this.exportService.getDefaults();
        ctx.panel.webview.postMessage({
            command: 'exportDefaultsLoaded',
            defaults: defaults
        });
    }

    private handleSaveExportDefaults(ctx: MessageContext): void {
        const { message } = ctx;
        this.exportService.saveDefaults(message.format, message.options);
        if (message.saveLocation) {
            this.exportService.saveSaveLocation(message.saveLocation);
        }
        vscode.window.showInformationMessage(`Export defaults saved for ${message.format.toUpperCase()}`);
    }

    private async handleExportData(ctx: MessageContext): Promise<void> {
        const { panel, schema, table, message, queryRunner } = ctx;
        const opts = message.options;
        const extensions: Record<string, string> = { csv: '.csv', json: '.json', xml: '.xml', insert: '.sql', excel: '.xlsx' };
        const ext = extensions[opts.format] || '';
        const filterMap: Record<string, { [key: string]: string[] }> = {
            csv: { 'CSV Files': ['csv'] },
            json: { 'JSON Files': ['json'] },
            xml: { 'XML Files': ['xml'] },
            insert: { 'SQL Files': ['sql'] },
            excel: { 'Excel Files': ['xlsx'] }
        };

        // Determine default directory from saved location or workspace
        const savedLocation = opts.saveLocation || this.exportService.getSaveLocation();
        const defaultDir = savedLocation || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(defaultDir, opts.filename)),
            filters: filterMap[opts.format] || {}
        });

        if (!uri) return;

        try {
            // Fetch ALL rows from database (not limited by page size)
            let exportRows: any[];
            if (message.sql) {
                // Strip any existing LIMIT/OFFSET from the query for full export
                let sql = message.sql.replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$/i, '');
                const result = await queryRunner.executeSQL(sql);
                exportRows = result.rows;
            } else {
                // Fallback: fetch all from table
                const totalCount = await queryRunner.getRowCount(schema, table);
                exportRows = await queryRunner.fetchRows(schema, table, 0, totalCount);
            }

            await this.exportService.exportData(
                exportRows,
                message.columns,
                { ...opts, filePath: uri.fsPath }
            );
            panel.webview.postMessage({
                command: 'exportSuccess',
                filePath: uri.fsPath
            });
            vscode.window.showInformationMessage(`Exported ${exportRows.length} rows to ${path.basename(uri.fsPath)}`);
        } catch (exportErr: unknown) {
            vscode.window.showErrorMessage(`Export failed: ${getErrorMessage(exportErr)}`);
        }
    }

    private getWebviewContent(webview: vscode.Webview): string {
        const htmlPath = path.join(this.context.extensionPath, 'src', 'webview', 'tableView.html');
        const cssPath = path.join(this.context.extensionPath, 'src', 'webview', 'tableView.css');
        const jsPath = path.join(this.context.extensionPath, 'src', 'webview', 'tableView.js');

        let html = fs.readFileSync(htmlPath, 'utf8');
        const css = fs.readFileSync(cssPath, 'utf8');
        const js = fs.readFileSync(jsPath, 'utf8');

        // Inject CSS and JS inline for simplicity
        html = html.replace('/* CSS_PLACEHOLDER */', css);
        html = html.replace('/* JS_PLACEHOLDER */', js);

        return html;
    }

    private getConnectionName(): string {
        const cfg = this.connectionManager.getActiveConnectionConfig();
        if (!cfg) return '';
        return cfg.name || `${cfg.host}:${cfg.port}/${cfg.database}`;
    }

    private getQueryHistory(schema: string, table: string): { sql: string; lastUsed: number }[] {
        const key = `queryHistory:${schema}.${table}`;
        const history = this.context.globalState.get<{ sql: string; lastUsed: number }[]>(key, []);
        return history.sort((a, b) => b.lastUsed - a.lastUsed);
    }

    private saveQueryToHistory(schema: string, table: string, sql: string): void {
        const key = `queryHistory:${schema}.${table}`;
        let history = this.context.globalState.get<{ sql: string; lastUsed: number }[]>(key, []);
        // Remove existing entry for same SQL
        history = history.filter(h => h.sql !== sql);
        // Add at front with current timestamp
        history.unshift({ sql, lastUsed: Date.now() });
        // Keep max 50 entries
        if (history.length > 50) {
            history = history.slice(0, 50);
        }
        this.context.globalState.update(key, history);
    }

    async openTableViewWithFilter(schema: string, table: string, column: string, value: any): Promise<void> {
        const key = `${schema}.${table}`;
        const existingPanel = this.panels.get(key);

        if (existingPanel) {
            // Panel already exists and has data loaded — send filter directly
            existingPanel.reveal();
            existingPanel.webview.postMessage({
                command: 'applyFilter',
                column: column,
                value: String(value)
            });
        } else {
            // Panel will be created — store filter to send after first dataLoaded
            this.pendingFilters.set(key, { column, value: String(value) });
            await this.openTableView(schema, table);
        }
    }

    /**
     * Open the data viewer in read-only "custom query" mode for an ad-hoc SELECT
     * (e.g. the "View Data" command run inside a procedure body). The panel runs
     * the given SQL and renders the result grid; table editing is disabled.
     *
     * @param sql The runnable SELECT statement.
     * @param title A short label shown in the toolbar.
     * @param viewColumn Where to place the panel (defaults to a side-by-side split).
     */
    openCustomQueryView(sql: string, title: string, viewColumn: vscode.ViewColumn = vscode.ViewColumn.Beside): void {
        const panel = vscode.window.createWebviewPanel(
            'postgresTableView',
            title,
            viewColumn,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.file(path.join(this.context.extensionPath, 'src', 'webview'))
                ]
            }
        );

        let disposed = false;
        panel.onDidDispose(() => { disposed = true; });

        panel.webview.html = this.getWebviewContent(panel.webview);

        const thousandSeparator = vscode.workspace.getConfiguration('postgresQueryBuilder').get<string>('thousandSeparator', ' ');
        panel.webview.postMessage({
            command: 'init',
            schema: '',
            table: '',
            customQuery: sql,
            viewTitle: title,
            thousandSeparator,
            connectionName: this.getConnectionName()
        });

        const connSub = this.connectionManager.onConnectionChanged(() => {
            if (disposed) return;
            panel.webview.postMessage({
                command: 'connectionChanged',
                connectionName: this.getConnectionName()
            });
        });
        panel.onDidDispose(() => connSub.dispose());

        const customHistoryKey = 'customQuery';
        panel.webview.onDidReceiveMessage(async (message) => {
            const queryRunner = new QueryRunner(this.connectionManager);
            try {
                switch (message.command) {
                    case 'runCustomQuery': {
                        const result = await queryRunner.executeSQL(message.sql);
                        if (this.modifyHistoryStore) {
                            for (const stmt of splitSqlStatements(message.sql)) {
                                if (isModifyingSql(stmt)) {
                                    this.modifyHistoryStore.add({ sql: stmt });
                                }
                            }
                        }
                        // Resolve field OIDs to type names
                        const oids = result.fields.map((f) => f.dataTypeID).filter((id: number) => id > 0);
                        let typeMap: Record<number, string> = {};
                        if (oids.length > 0) {
                            const typeRows = await this.connectionManager.query(
                                `SELECT oid, typname FROM pg_type WHERE oid = ANY($1)`,
                                [oids]
                            );
                            for (const row of typeRows.rows) {
                                typeMap[row.oid] = row.typname;
                            }
                        }
                        const cols = result.fields.map((f) => ({
                            name: f.name,
                            dataType: typeMap[f.dataTypeID] || '',
                            isNullable: true,
                            columnDefault: null
                        }));
                        if (!disposed) {
                            panel.webview.postMessage({
                                command: 'queryResult',
                                rows: result.rows,
                                columns: cols,
                                connectionName: this.getConnectionName()
                            });
                        }
                        break;
                    }
                    case 'saveQueryHistory': {
                        this.saveQueryToHistory('', customHistoryKey, message.sql);
                        if (!disposed) {
                            panel.webview.postMessage({
                                command: 'queryHistoryUpdated',
                                history: this.getQueryHistory('', customHistoryKey)
                            });
                        }
                        break;
                    }
                    case 'getQueryHistory': {
                        if (!disposed) {
                            panel.webview.postMessage({
                                command: 'queryHistoryUpdated',
                                history: this.getQueryHistory('', customHistoryKey)
                            });
                        }
                        break;
                    }
                    case 'showError': {
                        vscode.window.showErrorMessage(message.text);
                        break;
                    }
                }
            } catch (err: unknown) {
                if (!disposed) {
                    panel.webview.postMessage({ command: 'error', text: getErrorMessage(err) });
                }
                vscode.window.showErrorMessage(`Query error: ${getErrorMessage(err)}`);
            }
        });
    }
}
