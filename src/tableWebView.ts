import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { QueryRunner } from './queryRunner';
import * as path from 'path';
import * as fs from 'fs';

export class TableWebViewManager {
    private panels: Map<string, vscode.WebviewPanel> = new Map();
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

        // Handle messages from webview
        panel.webview.onDidReceiveMessage(async (message) => {
            const queryRunner = new QueryRunner(this.connectionManager);

            try {
                switch (message.command) {
                    case 'loadData': {
                        const data = await queryRunner.fetchRows(
                            schema, table, message.offset || 0, message.limit || 50
                        );
                        const totalCount = await queryRunner.getRowCount(schema, table);
                        const columns = await queryRunner.getColumns(schema, table);
                        const primaryKeys = await queryRunner.getPrimaryKeys(schema, table);

                        panel.webview.postMessage({
                            command: 'dataLoaded',
                            data: data,
                            totalCount: totalCount,
                            columns: columns,
                            primaryKeys: primaryKeys,
                            schema: schema,
                            table: table
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
}
