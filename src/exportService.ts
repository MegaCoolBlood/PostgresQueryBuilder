import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface ExportOptions {
    format: 'insert' | 'csv' | 'json' | 'xml' | 'excel';
    filePath: string;
    // CSV options
    csvSeparator?: string;
    csvQuoteStrings?: boolean;
    csvIncludeHeaders?: boolean;
    csvLineEnding?: 'crlf' | 'lf';
    // Insert options
    insertTableName?: string;
    insertBatchSize?: number;
    // JSON options
    jsonPretty?: boolean;
    jsonArrayWrapper?: boolean;
    // XML options
    xmlRootElement?: string;
    xmlRowElement?: string;
    // Excel options
    excelIncludeHeaders?: boolean;
    excelSheetName?: string;
    excelIncludeSqlSheet?: boolean;
    excelSqlStatement?: string;
}

export interface ExportDefaultsMap {
    insert?: Partial<ExportOptions>;
    csv?: Partial<ExportOptions>;
    json?: Partial<ExportOptions>;
    xml?: Partial<ExportOptions>;
    excel?: Partial<ExportOptions>;
}

export class ExportService {
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    getDefaults(): ExportDefaultsMap & { _saveLocation?: string } {
        const defaults = this.context.globalState.get<ExportDefaultsMap>('exportDefaults', {});
        const saveLocation = this.getSaveLocation();
        return { ...defaults, _saveLocation: saveLocation };
    }

    saveDefaults(format: string, options: Partial<ExportOptions>): void {
        const defaults = this.context.globalState.get<ExportDefaultsMap>('exportDefaults', {});
        (defaults as any)[format] = options;
        this.context.globalState.update('exportDefaults', defaults);
    }

    getSaveLocation(): string {
        return this.context.globalState.get<string>('exportSaveLocation', '');
    }

    saveSaveLocation(location: string): void {
        this.context.globalState.update('exportSaveLocation', location);
    }

    async exportData(rows: any[], columns: { name: string; dataType: string }[], options: ExportOptions): Promise<void> {
        switch (options.format) {
            case 'csv':
                await this.exportCsv(rows, columns, options);
                break;
            case 'json':
                await this.exportJson(rows, columns, options);
                break;
            case 'xml':
                await this.exportXml(rows, columns, options);
                break;
            case 'insert':
                await this.exportInsert(rows, columns, options);
                break;
            case 'excel':
                await this.exportExcel(rows, columns, options);
                break;
        }
    }

    private async exportCsv(rows: any[], columns: { name: string; dataType: string }[], options: ExportOptions): Promise<void> {
        const separator = options.csvSeparator || ',';
        const quoteStrings = options.csvQuoteStrings !== false;
        const includeHeaders = options.csvIncludeHeaders !== false;
        const lineEnding = options.csvLineEnding === 'lf' ? '\n' : '\r\n';

        const lines: string[] = [];

        if (includeHeaders) {
            lines.push(columns.map(c => this.csvEscape(c.name, separator, quoteStrings)).join(separator));
        }

        for (const row of rows) {
            const values = columns.map(col => {
                const val = row[col.name];
                if (val === null || val === undefined) return '';
                return this.csvEscape(String(val), separator, quoteStrings);
            });
            lines.push(values.join(separator));
        }

        fs.writeFileSync(options.filePath, lines.join(lineEnding), 'utf8');
    }

    private csvEscape(value: string, separator: string, quoteStrings: boolean): string {
        if (quoteStrings && (value.includes(separator) || value.includes('"') || value.includes('\n') || value.includes('\r'))) {
            return '"' + value.replace(/"/g, '""') + '"';
        }
        return value;
    }

    private async exportJson(rows: any[], columns: { name: string; dataType: string }[], options: ExportOptions): Promise<void> {
        const pretty = options.jsonPretty !== false;
        const arrayWrapper = options.jsonArrayWrapper !== false;

        let data: any;
        if (arrayWrapper) {
            data = rows.map(row => {
                const obj: any = {};
                columns.forEach(col => { obj[col.name] = row[col.name] ?? null; });
                return obj;
            });
        } else {
            data = rows.map(row => {
                const obj: any = {};
                columns.forEach(col => { obj[col.name] = row[col.name] ?? null; });
                return obj;
            });
        }

        const content = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
        fs.writeFileSync(options.filePath, content, 'utf8');
    }

    private async exportXml(rows: any[], columns: { name: string; dataType: string }[], options: ExportOptions): Promise<void> {
        const rootElement = options.xmlRootElement || 'data';
        const rowElement = options.xmlRowElement || 'row';

        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        xml += `<${rootElement}>\n`;

        for (const row of rows) {
            xml += `  <${rowElement}>\n`;
            for (const col of columns) {
                const val = row[col.name];
                const escaped = this.xmlEscape(val === null || val === undefined ? '' : String(val));
                const tagName = this.xmlSafeTag(col.name);
                xml += `    <${tagName}>${escaped}</${tagName}>\n`;
            }
            xml += `  </${rowElement}>\n`;
        }

        xml += `</${rootElement}>\n`;
        fs.writeFileSync(options.filePath, xml, 'utf8');
    }

    private xmlEscape(value: string): string {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    private xmlSafeTag(name: string): string {
        // XML tag names cannot start with numbers or contain spaces
        let tag = name.replace(/[^a-zA-Z0-9_.-]/g, '_');
        if (/^[0-9]/.test(tag)) {
            tag = '_' + tag;
        }
        return tag;
    }

    private async exportInsert(rows: any[], columns: { name: string; dataType: string }[], options: ExportOptions): Promise<void> {
        const tableName = options.insertTableName || 'table_name';
        const batchSize = options.insertBatchSize || 1;

        const colNames = columns.map(c => this.quoteIdentifier(c.name)).join(', ');
        const lines: string[] = [];

        if (batchSize > 1) {
            for (let i = 0; i < rows.length; i += batchSize) {
                const batch = rows.slice(i, i + batchSize);
                const valuesList = batch.map(row => {
                    const values = columns.map(col => this.formatSqlValue(row[col.name]));
                    return `(${values.join(', ')})`;
                });
                lines.push(`INSERT INTO ${tableName} (${colNames}) VALUES\n${valuesList.join(',\n')};\n`);
            }
        } else {
            for (const row of rows) {
                const values = columns.map(col => this.formatSqlValue(row[col.name]));
                lines.push(`INSERT INTO ${tableName} (${colNames}) VALUES (${values.join(', ')});`);
            }
        }

        fs.writeFileSync(options.filePath, lines.join('\n'), 'utf8');
    }

    private quoteIdentifier(name: string): string {
        if (/^[a-z_][a-z0-9_$]*$/.test(name)) {
            return name;
        }
        return '"' + name.replace(/"/g, '""') + '"';
    }

    private formatSqlValue(value: any): string {
        if (value === null || value === undefined) return 'NULL';
        if (typeof value === 'number') return String(value);
        if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
        return "'" + String(value).replace(/'/g, "''") + "'";
    }

    private async exportExcel(rows: any[], columns: { name: string; dataType: string }[], options: ExportOptions): Promise<void> {
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        const sheetName = options.excelSheetName || 'Data';
        const worksheet = workbook.addWorksheet(sheetName);

        if (options.excelIncludeHeaders !== false) {
            worksheet.addRow(columns.map(c => c.name));
            const headerRow = worksheet.getRow(1);
            headerRow.font = { bold: true };
        }

        for (const row of rows) {
            const values = columns.map(col => {
                const val = row[col.name];
                if (val === null || val === undefined) return '';
                return val;
            });
            worksheet.addRow(values);
        }

        worksheet.columns.forEach((column: any) => {
            let maxLength = 10;
            column.eachCell({ includeEmpty: true }, (cell: any) => {
                const cellLength = cell.value ? String(cell.value).length : 0;
                if (cellLength > maxLength) maxLength = cellLength;
            });
            column.width = Math.min(maxLength + 2, 50);
        });

        if (options.excelIncludeSqlSheet && options.excelSqlStatement) {
            const sqlSheet = workbook.addWorksheet('SQL');
            sqlSheet.addRow(['SQL Statement']);
            sqlSheet.addRow([options.excelSqlStatement]);
            sqlSheet.getColumn(1).width = 100;
        }

        await workbook.xlsx.writeFile(options.filePath);
    }
}
