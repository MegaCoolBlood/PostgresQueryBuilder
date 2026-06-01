import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { QueryRunner } from './queryRunner';
import { ExportService } from './exportService';
import { ColumnMappingManager } from './columnMappingManager';
import * as path from 'path';
import * as fs from 'fs';

export class TableWebViewManager {
    private panels: Map<string, vscode.WebviewPanel> = new Map();
    private pendingFilters: Map<string, { column: string; value: string }> = new Map();
    private context: vscode.ExtensionContext;
    private connectionManager: ConnectionManager;
    private exportService: ExportService;
    private columnMappingManager: ColumnMappingManager;

    constructor(context: vscode.ExtensionContext, connectionManager: ConnectionManager) {
        this.context = context;
        this.connectionManager = connectionManager;
        this.exportService = new ExportService(context);
        this.columnMappingManager = new ColumnMappingManager(context);
    }

    async openTableView(schema: string, table: string): Promise<void> {
        const key = `${schema}.${table}`;

        // If panel already exists, reveal it
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

        panel.onDidDispose(() => {
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
            thousandSeparator: thousandSeparator
        });

        // Handle messages from webview
        panel.webview.onDidReceiveMessage(async (message) => {
            const queryRunner = new QueryRunner(this.connectionManager);

            try {
                switch (message.command) {
                    case 'loadData': {
                        const selectBuildInfo = await queryRunner.getSelectBuildInfo(schema, table);

                        // Start metadata fetches in parallel with data fetch
                        const pkPromise = queryRunner.getPrimaryKeys(schema, table);
                        const fkPromise = queryRunner.getForeignKeys(schema, table);
                        const refsPromise = queryRunner.getReferencingTables(schema, table);

                        // Fetch rows + columns (fast essentials)
                        const columns = await queryRunner.getColumns(schema, table);
                        const data = await queryRunner.fetchRows(
                            schema, table, message.offset || 0, message.limit || 50
                        );
                        const totalCount = await queryRunner.getRowCount(schema, table);

                        panel.webview.postMessage({
                            command: 'dataLoaded',
                            data: data,
                            totalCount: totalCount,
                            columns: columns,
                            schema: schema,
                            table: table,
                            alwaysQuote: selectBuildInfo.alwaysQuote,
                            tableReference: selectBuildInfo.tableReference
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

                        break;
                    }
                    case 'previewSQL': {
                        const sql = queryRunner.generateSQL(
                            schema,
                            table,
                            message.changes
                        );
                        panel.webview.postMessage({ command: 'sqlPreview', sql });
                        break;
                    }
                    case 'commitChanges': {
                        await queryRunner.commitChanges(
                            schema,
                            table,
                            message.changes
                        );
                        panel.webview.postMessage({ command: 'commitSuccess' });
                        vscode.window.showInformationMessage(
                            `Changes committed to ${schema}.${table}`
                        );
                        break;
                    }
                    case 'showError': {
                        vscode.window.showErrorMessage(message.text);
                        break;
                    }
                    case 'runCustomQuery': {
                        const result = await queryRunner.executeSQL(message.sql);
                        // Resolve field OIDs to type names
                        const oids = result.fields.map((f: any) => f.dataTypeID).filter((id: number) => id > 0);
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
                        const cols = result.fields.map((f: any) => ({
                            name: f.name,
                            dataType: typeMap[f.dataTypeID] || '',
                            isNullable: true,
                            columnDefault: null
                        }));
                        panel.webview.postMessage({
                            command: 'queryResult',
                            rows: result.rows,
                            columns: cols
                        });
                        break;
                    }
                    case 'saveQueryHistory': {
                        this.saveQueryToHistory(schema, table, message.sql);
                        panel.webview.postMessage({
                            command: 'queryHistoryUpdated',
                            history: this.getQueryHistory(schema, table)
                        });
                        break;
                    }
                    case 'getQueryHistory': {
                        panel.webview.postMessage({
                            command: 'queryHistoryUpdated',
                            history: this.getQueryHistory(schema, table)
                        });
                        break;
                    }
                    case 'openForeignKey': {
                        const fkSchema = message.refSchema;
                        const fkTable = message.refTable;
                        const fkColumn = message.refColumn;
                        const fkValue = message.value;
                        await this.openTableViewWithFilter(fkSchema, fkTable, fkColumn, fkValue);
                        break;
                    }
                    case 'addCustomMapping': {
                        this.columnMappingManager.addMapping(message.mapping);
                        const mappings = this.columnMappingManager.getMappingsForTable(schema, table);
                        panel.webview.postMessage({
                            command: 'customMappingsLoaded',
                            mappings: mappings
                        });
                        break;
                    }
                    case 'updateCustomMapping': {
                        this.columnMappingManager.updateMapping(message.mappingId, message.mapping);
                        const mappingsAfterUpdate = this.columnMappingManager.getMappingsForTable(schema, table);
                        panel.webview.postMessage({
                            command: 'customMappingsLoaded',
                            mappings: mappingsAfterUpdate
                        });
                        break;
                    }
                    case 'deleteCustomMapping': {
                        this.columnMappingManager.deleteMapping(message.mappingId);
                        const mappingsAfterDelete = this.columnMappingManager.getMappingsForTable(schema, table);
                        panel.webview.postMessage({
                            command: 'customMappingsLoaded',
                            mappings: mappingsAfterDelete
                        });
                        break;
                    }
                    case 'getTablesForTypeahead': {
                        try {
                            const tables = await this.connectionManager.queryMetadata(
                                `SELECT table_schema, table_name FROM information_schema.tables
                                 WHERE table_type IN ('BASE TABLE', 'FOREIGN')
                                   AND table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                                 ORDER BY table_schema, table_name`
                            );
                            panel.webview.postMessage({
                                command: 'tablesForTypeahead',
                                tables: tables.map((r: any) => ({ schema: r.table_schema, table: r.table_name }))
                            });
                        } catch (err: any) {
                            console.warn(`Failed to load tables for typeahead: ${err.message}`);
                        }
                        break;
                    }
                    case 'getColumnsForTypeahead': {
                        try {
                            const cols = await this.connectionManager.queryMetadata(
                                `SELECT column_name FROM information_schema.columns
                                 WHERE table_schema = $1 AND table_name = $2
                                 ORDER BY ordinal_position`,
                                [message.schema, message.table]
                            );
                            panel.webview.postMessage({
                                command: 'columnsForTypeahead',
                                columns: cols.map((r: any) => r.column_name),
                                forSchema: message.schema,
                                forTable: message.table
                            });
                        } catch (err: any) {
                            console.warn(`Failed to load columns for typeahead: ${err.message}`);
                        }
                        break;
                    }
                    case 'browseExportLocation': {
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
                        break;
                    }
                    case 'getExportDefaults': {
                        const defaults = this.exportService.getDefaults();
                        panel.webview.postMessage({
                            command: 'exportDefaultsLoaded',
                            defaults: defaults
                        });
                        break;
                    }
                    case 'saveExportDefaults': {
                        this.exportService.saveDefaults(message.format, message.options);
                        if (message.saveLocation) {
                            this.exportService.saveSaveLocation(message.saveLocation);
                        }
                        vscode.window.showInformationMessage(`Export defaults saved for ${message.format.toUpperCase()}`);
                        break;
                    }
                    case 'exportData': {
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

                        if (!uri) break;

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
                        } catch (exportErr: any) {
                            vscode.window.showErrorMessage(`Export failed: ${exportErr.message}`);
                        }
                        break;
                    }
                }
            } catch (err: any) {
                panel.webview.postMessage({
                    command: 'error',
                    text: err.message
                });
                vscode.window.showErrorMessage(`Query error: ${err.message}`);
            }
        });
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
}
