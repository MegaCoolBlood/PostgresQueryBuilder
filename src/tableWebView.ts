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

/** Minimal shape of a `pg` field descriptor used to build result columns. */
export interface ResultFieldInfo {
    name: string;
    dataTypeID: number;
    tableID?: number;
    columnID?: number;
}

/** A Data Viewer column as posted to the webview. */
export interface ResultColumn {
    name: string;
    dataType: string;
    isNullable: boolean;
    columnDefault: null;
    comment: string | null;
}

/**
 * Map raw `pg` field descriptors to Data Viewer column objects, resolving the
 * type name (via `typeMap`, keyed by data-type OID) and the column comment (via
 * `commentMap`, keyed by `"tableOID:columnNumber"`). Fields that do not
 * originate from a table column (`tableID`/`columnID` <= 0, e.g. computed
 * expressions or literals in a custom SELECT) get no comment.
 */
export function buildCustomResultColumns(
    fields: ReadonlyArray<ResultFieldInfo>,
    typeMap: Record<number, string>,
    commentMap: Record<string, string>
): ResultColumn[] {
    return fields.map((f) => {
        const tableId = f.tableID ?? 0;
        const columnId = f.columnID ?? 0;
        const comment = (tableId > 0 && columnId > 0)
            ? (commentMap[`${tableId}:${columnId}`] ?? null)
            : null;
        return {
            name: f.name,
            dataType: typeMap[f.dataTypeID] || '',
            isNullable: true,
            columnDefault: null,
            comment
        };
    });
}

/**
 * Build a fast "describe" probe query that returns the result columns of a
 * custom SELECT without fetching any rows, so the Data Viewer can render the
 * header and filter row immediately while the real query is still running.
 *
 * Only a single-statement `SELECT`/`WITH` query can be safely wrapped this way;
 * anything else (DML, multiple statements, empty input) returns `null` so the
 * caller skips the early render and falls back to rendering columns from the
 * full result. `singleStatement` must already be a single SQL statement.
 */
export function buildColumnProbeSql(singleStatement: string): string | null {
    if (typeof singleStatement !== 'string') {
        return null;
    }
    const trimmed = singleStatement.trim().replace(/;+\s*$/, '').trim();
    if (!trimmed) {
        return null;
    }
    if (!/^(select|with)\b/i.test(trimmed)) {
        return null;
    }
    return `SELECT * FROM (${trimmed}) AS _pqb_cols LIMIT 0`;
}

export class TableWebViewManager {
    private panels: Map<string, vscode.WebviewPanel> = new Map();
    private pendingFilters: Map<string, { column: string; value: string; conditions?: any[] }> = new Map();
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

        // Opening a table requires a live connection to load its data. If none
        // is active, prompt the user to pick one before creating the panel.
        if (!await this.connectionManager.ensureConnected()) {
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
        exportData: this.handleExportData,
        selectConnection: this.handleSelectConnection
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

        // Push the column list to the webview as soon as it is available so the
        // table header renders immediately — even while the (potentially slow)
        // row and count queries are still running. This lets the user add a
        // permanent constraint before the data has finished loading.
        panel.webview.postMessage({
            command: 'columnsLoaded',
            columns: columns,
            schema: schema,
            table: table,
            alwaysQuote: selectBuildInfo.alwaysQuote,
            tableReference: selectBuildInfo.tableReference,
            offset: message.offset || 0
        });

        const fetchStart = Date.now();
        const data = await queryRunner.fetchRows(
            schema, table, message.offset || 0, message.limit || 50, where
        );
        const durationMs = Date.now() - fetchStart;
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
            connectionName: this.getConnectionName(),
            durationMs: durationMs
        });

        // Send pending filter after data is loaded
        const pendingFilter = this.pendingFilters.get(key);
        if (pendingFilter) {
            this.pendingFilters.delete(key);
            panel.webview.postMessage({
                command: 'applyFilter',
                column: pendingFilter.column,
                value: pendingFilter.value,
                conditions: pendingFilter.conditions || []
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

    /**
     * Resolve the columns of a custom-query result: map each field's type OID to
     * a type name and look up the column comment for fields that come straight
     * from a table column (`tableID`/`columnID`). This makes the column-comment
     * tooltip work for custom SELECTs too, not just the default table view.
     */
    private async resolveResultColumns(fields: ReadonlyArray<ResultFieldInfo>): Promise<ResultColumn[]> {
        // Resolve field type OIDs to type names.
        const oids = fields.map((f) => f.dataTypeID).filter((id: number) => id > 0);
        const typeMap: Record<number, string> = {};
        if (oids.length > 0) {
            const typeRows = await this.connectionManager.query(
                `SELECT oid, typname FROM pg_type WHERE oid = ANY($1)`,
                [oids]
            );
            for (const row of typeRows.rows) {
                typeMap[row.oid] = row.typname;
            }
        }

        // Resolve column comments for fields that originate from a table column.
        const commentMap: Record<string, string> = {};
        const tableIds = Array.from(new Set(fields.map((f) => f.tableID).filter((id): id is number => typeof id === 'number' && id > 0)));
        const columnIds = Array.from(new Set(fields.map((f) => f.columnID).filter((id): id is number => typeof id === 'number' && id > 0)));
        if (tableIds.length > 0 && columnIds.length > 0) {
            const descRows = await this.connectionManager.queryMetadata(
                `SELECT objoid, objsubid, description
                 FROM pg_catalog.pg_description
                 WHERE classoid = 'pg_catalog.pg_class'::regclass
                   AND objoid = ANY($1) AND objsubid = ANY($2)`,
                [tableIds, columnIds]
            );
            for (const row of descRows) {
                commentMap[`${row.objoid}:${row.objsubid}`] = row.description;
            }
        }

        return buildCustomResultColumns(fields, typeMap, commentMap);
    }

    /**
     * Try to resolve the columns of a custom SELECT quickly (without fetching
     * its rows) and post them to the webview so the header and filter row render
     * immediately, before the full query returns. Failures are ignored: the real
     * result still renders the columns afterwards.
     */
    private async tryPostEarlyQueryColumns(panel: vscode.WebviewPanel, sql: string): Promise<void> {
        try {
            const statements = splitSqlStatements(sql).map((s) => s.trim()).filter((s) => s.length > 0);
            if (statements.length !== 1) {
                return;
            }
            const probeSql = buildColumnProbeSql(statements[0]);
            if (!probeSql) {
                return;
            }
            const probe = await this.connectionManager.query(probeSql);
            if (!probe.fields || probe.fields.length === 0) {
                return;
            }
            const cols = await this.resolveResultColumns(probe.fields);
            panel.webview.postMessage({ command: 'queryColumns', columns: cols });
        } catch {
            // Ignore probe failures (non-SELECT, multi-statement, invalid wrap,
            // etc.); the full query result will render the columns as before.
        }
    }

    private async handleRunCustomQuery(ctx: MessageContext): Promise<void> {
        const { panel, schema, table, message, queryRunner } = ctx;
        if (!await this.connectionManager.ensureConnected()) {
            return;
        }
        // Render the columns + filter row immediately while the full query runs.
        await this.tryPostEarlyQueryColumns(panel, message.sql);
        const execStart = Date.now();
        const result = await queryRunner.executeSQL(message.sql);
        const durationMs = Date.now() - execStart;
        if (this.modifyHistoryStore) {
            for (const stmt of splitSqlStatements(message.sql)) {
                if (isModifyingSql(stmt)) {
                    this.modifyHistoryStore.add({ sql: stmt, schema, table });
                }
            }
        }
        const cols = await this.resolveResultColumns(result.fields);
        panel.webview.postMessage({
            command: 'queryResult',
            rows: result.rows,
            columns: cols,
            connectionName: this.getConnectionName(),
            durationMs: durationMs
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

    private async handleSelectConnection(): Promise<void> {
        // Opens the connection picker. Switching fires onConnectionChanged,
        // which pushes a `connectionChanged` message back to every open panel.
        await this.connectionManager.selectConnection();
    }

    private async handleOpenForeignKey(ctx: MessageContext): Promise<void> {
        const { message } = ctx;
        const fkSchema = message.refSchema;
        const fkTable = message.refTable;
        const fkColumn = message.refColumn;
        const fkValue = message.value;
        const conditions = Array.isArray(message.conditions) ? message.conditions : [];
        await this.openTableViewWithFilter(fkSchema, fkTable, fkColumn, fkValue, conditions);
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

    async openTableViewWithFilter(schema: string, table: string, column: string, value: any, conditions: any[] = []): Promise<void> {
        const key = `${schema}.${table}`;
        const existingPanel = this.panels.get(key);

        if (existingPanel) {
            // Panel already exists and has data loaded — send filter directly
            existingPanel.reveal();
            existingPanel.webview.postMessage({
                command: 'applyFilter',
                column: column,
                value: String(value),
                conditions: conditions || []
            });
        } else {
            // Panel will be created — store filter to send after first dataLoaded
            this.pendingFilters.set(key, { column, value: String(value), conditions: conditions || [] });
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
                        if (!await this.connectionManager.ensureConnected()) {
                            break;
                        }
                        // Render columns + filter row immediately while running.
                        if (!disposed) {
                            await this.tryPostEarlyQueryColumns(panel, message.sql);
                        }
                        const execStart = Date.now();
                        const result = await queryRunner.executeSQL(message.sql);
                        const durationMs = Date.now() - execStart;
                        if (this.modifyHistoryStore) {
                            for (const stmt of splitSqlStatements(message.sql)) {
                                if (isModifyingSql(stmt)) {
                                    this.modifyHistoryStore.add({ sql: stmt });
                                }
                            }
                        }
                        const cols = await this.resolveResultColumns(result.fields);
                        if (!disposed) {
                            panel.webview.postMessage({
                                command: 'queryResult',
                                rows: result.rows,
                                columns: cols,
                                connectionName: this.getConnectionName(),
                                durationMs: durationMs
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
                    case 'selectConnection': {
                        await this.connectionManager.selectConnection();
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
