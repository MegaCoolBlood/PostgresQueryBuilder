import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { QueryRunner } from './queryRunner';
import * as path from 'path';
import * as fs from 'fs';

export class TableWebViewManager {
    private panels: Map<string, vscode.WebviewPanel> = new Map();
    private pendingFilters: Map<string, { column: string; value: string }> = new Map();
    private context: vscode.ExtensionContext;
    private connectionManager: ConnectionManager;

    constructor(context: vscode.ExtensionContext, connectionManager: ConnectionManager) {
        this.context = context;
        this.connectionManager = connectionManager;
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
        panel.webview.postMessage({
            command: 'init',
            schema: schema,
            table: table,
            alwaysQuote: vscode.workspace.getConfiguration('postgresQueryBuilder').get<boolean>('alwaysQuote', false)
        });

        // Handle messages from webview
        panel.webview.onDidReceiveMessage(async (message) => {
            const queryRunner = new QueryRunner(this.connectionManager);

            try {
                switch (message.command) {
                    case 'loadData': {
                        const selectBuildInfo = await queryRunner.getSelectBuildInfo(schema, table);
                        // First: fetch and send rows + columns (fast essentials)
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

                        // Fetch metadata independently in parallel
                        queryRunner.getPrimaryKeys(schema, table).then(primaryKeys => {
                            panel.webview.postMessage({
                                command: 'primaryKeysLoaded',
                                primaryKeys: primaryKeys
                            });
                        }).catch(err => console.warn(`Failed to load PKs: ${err.message}`));

                        queryRunner.getForeignKeys(schema, table).then(foreignKeys => {
                            panel.webview.postMessage({
                                command: 'foreignKeysLoaded',
                                foreignKeys: foreignKeys
                            });
                        }).catch(err => console.warn(`Failed to load FKs: ${err.message}`));

                        queryRunner.getReferencingTables(schema, table).then(referencingTables => {
                            panel.webview.postMessage({
                                command: 'referencingTablesLoaded',
                                referencingTables: referencingTables
                            });
                        }).catch(err => console.warn(`Failed to load referencing tables: ${err.message}`));

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
                        const cols = result.fields.map((f: any) => ({
                            name: f.name,
                            dataType: '',
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
                    case 'openForeignKey': {
                        const fkSchema = message.refSchema;
                        const fkTable = message.refTable;
                        const fkColumn = message.refColumn;
                        const fkValue = message.value;
                        await this.openTableViewWithFilter(fkSchema, fkTable, fkColumn, fkValue);
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
