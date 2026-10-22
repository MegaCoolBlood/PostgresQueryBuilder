import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { escapeSqlLiteral, isJsonColumnType, pgColumnValueToText } from './sqlUtils';

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
    // ON CONFLICT clause appended to each INSERT. 'update' rewrites every column
    // that is not part of the conflict target (the primary key by default).
    insertOnConflict?: 'none' | 'nothing' | 'update';
    insertConflictColumns?: string[];
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

/** A single result row keyed by column name, as produced by the query layer. */
export type ExportRow = Record<string, unknown>;

/** Display format given to the date cells of an Excel export. */
export const EXCEL_DATE_FORMAT = 'yyyy-mm-dd';
/** Display format given to the timestamp cells of an Excel export. */
export const EXCEL_TIMESTAMP_FORMAT = 'yyyy-mm-dd hh:mm:ss';

function isTimestamptzType(dataType: string): boolean {
    const t = String(dataType || '').trim().toLowerCase();
    return t === 'timestamptz' || t === 'timestamp with time zone';
}

/**
 * The Date for a timestamptz text as the server sends it
 * (`2024-05-01 10:30:00.123456+02`), or null for anything else (infinity, BC).
 * The wall-clock time is kept and the offset dropped, so the cell shows the
 * same time as the grid and the CSV export; Excel serials carry no timezone.
 */
function parseTimestampText(text: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|[+-]\d{2}(?::?\d{2}){0,2})?$/.exec(text.trim());
    if (!m) return null;
    const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0;
    const d = new Date(Date.UTC(2000, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms));
    d.setUTCFullYear(Number(m[1]));
    return d.getUTCMonth() === Number(m[2]) - 1 ? d : null;
}

/** The number format an Excel cell of this column needs, if any. */
export function excelNumberFormat(value: unknown, dataType: string): string | undefined {
    if (!(value instanceof Date)) return undefined;
    if (String(dataType || '').trim().toLowerCase() === 'date') return EXCEL_DATE_FORMAT;
    return isTimestamptzType(dataType) ? EXCEL_TIMESTAMP_FORMAT : undefined;
}

/**
 * The value an Excel cell receives. A `date` column arrives as the raw
 * `YYYY-MM-DD` text and is turned into a real Excel date; the Date is built at
 * UTC midnight because Excel serials carry no timezone, so a local-midnight Date
 * would land on the previous day east of UTC. timestamptz text becomes a date
 * cell the same way (as it was while the driver still parsed it into a Date),
 * json is written as JSON text, and everything else as is.
 */
export function excelCellValue(value: unknown, dataType: string): unknown {
    if (value === null || value === undefined) return '';
    if (isJsonColumnType(dataType)) return pgColumnValueToText(value, dataType) ?? '';
    // Arrays, bytea and driver objects would not survive as a cell value.
    if (typeof value === 'object' && !(value instanceof Date)) return pgColumnValueToText(value, dataType) ?? '';
    if (String(dataType || '').trim().toLowerCase() === 'date' && typeof value === 'string') {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
        if (m) {
            const d = new Date(Date.UTC(2000, Number(m[2]) - 1, Number(m[3])));
            d.setUTCFullYear(Number(m[1]));
            if (d.getUTCMonth() === Number(m[2]) - 1) return d;
        }
    }
    if (isTimestamptzType(dataType) && typeof value === 'string') {
        return parseTimestampText(value) ?? value;
    }
    return value;
}

/**
 * A value as it appears in a JSON export. json/jsonb objects and arrays stay
 * native JSON; only bytea, which JSON.stringify would turn into
 * `{"type":"Buffer","data":[...]}`, is written as its `\x` hex text.
 */
export function jsonExportValue(value: unknown): unknown {
    if (value === null || value === undefined) return null;
    if (value instanceof Uint8Array) return pgColumnValueToText(value, undefined);
    return value;
}

/**
 * A value as a SQL literal for a generated INSERT script: NULL, a bare finite
 * number, TRUE/FALSE, or the quoted PostgreSQL text form of everything else
 * (arrays as array literals, bytea as `'\x...'`). A json/jsonb value is always
 * quoted JSON text, whatever JS type the driver parsed it into.
 */
export function formatSqlLiteralValue(value: unknown, dataType?: string): string {
    if (value === null || value === undefined) return 'NULL';
    if (isJsonColumnType(dataType)) return escapeSqlLiteral(pgColumnValueToText(value, dataType) ?? '');
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    return escapeSqlLiteral(pgColumnValueToText(value, dataType) ?? '');
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
        (defaults as Record<string, Partial<ExportOptions>>)[format] = options;
        this.context.globalState.update('exportDefaults', defaults);
    }

    getSaveLocation(): string {
        return this.context.globalState.get<string>('exportSaveLocation', '');
    }

    saveSaveLocation(location: string): void {
        this.context.globalState.update('exportSaveLocation', location);
    }

    async exportData(rows: ExportRow[], columns: { name: string; dataType: string }[], options: ExportOptions): Promise<void> {
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

    private async exportCsv(rows: ExportRow[], columns: { name: string; dataType: string }[], options: ExportOptions): Promise<void> {
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
                const text = pgColumnValueToText(row[col.name], col.dataType);
                if (text === null) return '';
                return this.csvEscape(text, separator, quoteStrings);
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

    private async exportJson(rows: ExportRow[], columns: { name: string; dataType: string }[], options: ExportOptions): Promise<void> {
        const pretty = options.jsonPretty !== false;

        const data = rows.map(row => {
            const obj: Record<string, unknown> = {};
            columns.forEach(col => { obj[col.name] = jsonExportValue(row[col.name]); });
            return obj;
        });

        const content = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
        fs.writeFileSync(options.filePath, content, 'utf8');
    }

    private async exportXml(rows: ExportRow[], columns: { name: string; dataType: string }[], options: ExportOptions): Promise<void> {
        const rootElement = options.xmlRootElement || 'data';
        const rowElement = options.xmlRowElement || 'row';

        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        xml += `<${rootElement}>\n`;

        for (const row of rows) {
            xml += `  <${rowElement}>\n`;
            for (const col of columns) {
                const escaped = this.xmlEscape(pgColumnValueToText(row[col.name], col.dataType) ?? '');
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

    private async exportInsert(rows: ExportRow[], columns: { name: string; dataType: string }[], options: ExportOptions): Promise<void> {
        const tableName = options.insertTableName || 'table_name';
        const batchSize = options.insertBatchSize || 1;

        const colNames = columns.map(c => this.quoteIdentifier(c.name)).join(', ');
        const onConflict = this.buildOnConflictClause(
            options.insertOnConflict || 'none',
            options.insertConflictColumns || [],
            columns.map(c => c.name)
        );
        const lines: string[] = [];

        if (batchSize > 1) {
            for (let i = 0; i < rows.length; i += batchSize) {
                const batch = rows.slice(i, i + batchSize);
                const valuesList = batch.map(row => {
                    const values = columns.map(col => this.formatSqlValue(row[col.name], col.dataType));
                    return `(${values.join(', ')})`;
                });
                lines.push(`INSERT INTO ${tableName} (${colNames}) VALUES\n${valuesList.join(',\n')}${onConflict};\n`);
            }
        } else {
            for (const row of rows) {
                const values = columns.map(col => this.formatSqlValue(row[col.name], col.dataType));
                lines.push(`INSERT INTO ${tableName} (${colNames}) VALUES (${values.join(', ')})${onConflict};`);
            }
        }

        fs.writeFileSync(options.filePath, lines.join('\n'), 'utf8');
    }

    /**
     * Build the ON CONFLICT clause (with a leading space) appended to an INSERT.
     * 'none' yields no clause; 'nothing' yields `ON CONFLICT DO NOTHING`; 'update'
     * conflicts on `conflictColumns` (the primary key) and rewrites every other
     * column from EXCLUDED. When no usable conflict target or no updatable column
     * is left, 'update' degrades to DO NOTHING, which is the only valid statement.
     */
    buildOnConflictClause(mode: 'none' | 'nothing' | 'update', conflictColumns: string[], allColumns: string[]): string {
        if (mode === 'none') {
            return '';
        }
        if (mode === 'nothing') {
            return ' ON CONFLICT DO NOTHING';
        }
        const target = (conflictColumns || []).filter(c => allColumns.includes(c));
        const setColumns = allColumns.filter(c => !target.includes(c));
        if (target.length === 0 || setColumns.length === 0) {
            return ' ON CONFLICT DO NOTHING';
        }
        const targetList = target.map(c => this.quoteIdentifier(c)).join(', ');
        const assignments = setColumns
            .map(c => `${this.quoteIdentifier(c)} = EXCLUDED.${this.quoteIdentifier(c)}`)
            .join(', ');
        return ` ON CONFLICT (${targetList}) DO UPDATE SET ${assignments}`;
    }

    private quoteIdentifier(name: string): string {
        if (/^[a-z_][a-z0-9_$]*$/.test(name)) {
            return name;
        }
        return '"' + name.replace(/"/g, '""') + '"';
    }

    private formatSqlValue(value: unknown, dataType?: string): string {
        return formatSqlLiteralValue(value, dataType);
    }

    private async exportExcel(rows: ExportRow[], columns: { name: string; dataType: string }[], options: ExportOptions): Promise<void> {
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
            const values = columns.map(col => excelCellValue(row[col.name], col.dataType));
            const added = worksheet.addRow(values);
            values.forEach((v, i) => {
                const numFmt = excelNumberFormat(v, columns[i].dataType);
                if (numFmt) {
                    added.getCell(i + 1).numFmt = numFmt;
                }
            });
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
