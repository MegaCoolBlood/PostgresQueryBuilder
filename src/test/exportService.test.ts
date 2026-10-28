import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ExportService, ExportOptions, excelCellValue, excelNumberFormat, EXCEL_DATE_FORMAT, EXCEL_TIMESTAMP_FORMAT } from '../exportService';

function createMockContext() {
    const store: Record<string, any> = {};
    return {
        globalState: {
            get<T>(key: string, defaultValue?: T): T {
                return store[key] !== undefined ? store[key] : defaultValue as T;
            },
            update(key: string, value: any) {
                store[key] = value;
                return Promise.resolve();
            }
        }
    } as any;
}

function getTempFile(ext: string): string {
    return path.join(os.tmpdir(), `export-test-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
}

const sampleColumns = [
    { name: 'id', dataType: 'integer' },
    { name: 'name', dataType: 'text' },
    { name: 'amount', dataType: 'numeric' }
];

const sampleRows = [
    { id: 1, name: 'Alice', amount: 100.5 },
    { id: 2, name: 'Bob', amount: 200.75 },
    { id: 3, name: null, amount: null }
];

// ===== CSV Export Tests =====

test('an export into a folder that does not exist yet creates the folder', async () => {
    const service = new ExportService(createMockContext());
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-test-dir-'));
    const filePath = path.join(root, 'exports', '2026', 'orders.csv');
    try {
        await service.exportData(sampleRows, sampleColumns, { format: 'csv', filePath, csvLineEnding: 'lf' });
        assert.equal(fs.readFileSync(filePath, 'utf8').split('\n')[0], 'id,name,amount');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('CSV export with default options includes headers and comma separator', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.csv');
    try {
        await service.exportData(sampleRows, sampleColumns, {
            format: 'csv',
            filePath,
            csvSeparator: ',',
            csvIncludeHeaders: true,
            csvQuoteStrings: true,
            csvLineEnding: 'lf'
        });
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        assert.equal(lines[0], 'id,name,amount');
        assert.equal(lines[1], '1,Alice,100.5');
        assert.equal(lines[2], '2,Bob,200.75');
        assert.equal(lines[3], '3,,');
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('CSV export without headers', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.csv');
    try {
        await service.exportData(sampleRows, sampleColumns, {
            format: 'csv',
            filePath,
            csvSeparator: ',',
            csvIncludeHeaders: false,
            csvQuoteStrings: true,
            csvLineEnding: 'lf'
        });
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        assert.equal(lines[0], '1,Alice,100.5');
        assert.equal(lines.length, 3);
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('CSV export with semicolon separator', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.csv');
    try {
        await service.exportData(sampleRows, sampleColumns, {
            format: 'csv',
            filePath,
            csvSeparator: ';',
            csvIncludeHeaders: true,
            csvQuoteStrings: true,
            csvLineEnding: 'lf'
        });
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        assert.equal(lines[0], 'id;name;amount');
        assert.equal(lines[1], '1;Alice;100.5');
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('CSV export with custom separator', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.csv');
    try {
        await service.exportData(sampleRows, sampleColumns, {
            format: 'csv',
            filePath,
            csvSeparator: '::',
            csvIncludeHeaders: true,
            csvQuoteStrings: true,
            csvLineEnding: 'lf'
        });
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        assert.equal(lines[0], 'id::name::amount');
        assert.equal(lines[1], '1::Alice::100.5');
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('CSV export quotes values containing separator', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.csv');
    const rows = [{ id: 1, name: 'Hello, World', amount: 50 }];
    try {
        await service.exportData(rows, sampleColumns, {
            format: 'csv',
            filePath,
            csvSeparator: ',',
            csvIncludeHeaders: false,
            csvQuoteStrings: true,
            csvLineEnding: 'lf'
        });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.equal(content, '1,"Hello, World",50');
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('CSV export quotes values containing double quotes', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.csv');
    const rows = [{ id: 1, name: 'She said "hi"', amount: 10 }];
    try {
        await service.exportData(rows, sampleColumns, {
            format: 'csv',
            filePath,
            csvSeparator: ',',
            csvIncludeHeaders: false,
            csvQuoteStrings: true,
            csvLineEnding: 'lf'
        });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.equal(content, '1,"She said ""hi""",10');
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('CSV export does not quote when quoteStrings is false', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.csv');
    const rows = [{ id: 1, name: 'Hello, World', amount: 50 }];
    try {
        await service.exportData(rows, sampleColumns, {
            format: 'csv',
            filePath,
            csvSeparator: ',',
            csvIncludeHeaders: false,
            csvQuoteStrings: false,
            csvLineEnding: 'lf'
        });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.equal(content, '1,Hello, World,50');
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('CSV export with CRLF line endings', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.csv');
    try {
        await service.exportData(sampleRows.slice(0, 2), sampleColumns, {
            format: 'csv',
            filePath,
            csvSeparator: ',',
            csvIncludeHeaders: true,
            csvQuoteStrings: true,
            csvLineEnding: 'crlf'
        });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.ok(content.includes('\r\n'));
        const lines = content.split('\r\n');
        assert.equal(lines[0], 'id,name,amount');
        assert.equal(lines[1], '1,Alice,100.5');
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('CSV export with tab separator', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.csv');
    try {
        await service.exportData(sampleRows.slice(0, 1), sampleColumns, {
            format: 'csv',
            filePath,
            csvSeparator: '\t',
            csvIncludeHeaders: true,
            csvQuoteStrings: true,
            csvLineEnding: 'lf'
        });
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        assert.equal(lines[0], 'id\tname\tamount');
        assert.equal(lines[1], '1\tAlice\t100.5');
    } finally {
        fs.unlinkSync(filePath);
    }
});

// ===== JSON Export Tests =====

test('JSON export with pretty print and array wrapper', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.json');
    try {
        await service.exportData(sampleRows, sampleColumns, {
            format: 'json',
            filePath,
            jsonPretty: true,
            jsonArrayWrapper: true
        });
        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(content);
        assert.equal(parsed.length, 3);
        assert.equal(parsed[0].id, 1);
        assert.equal(parsed[0].name, 'Alice');
        assert.equal(parsed[2].name, null);
        // Verify pretty printed (has newlines/indentation)
        assert.ok(content.includes('\n'));
        assert.ok(content.includes('  '));
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('JSON export without pretty print', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.json');
    try {
        await service.exportData(sampleRows.slice(0, 1), sampleColumns, {
            format: 'json',
            filePath,
            jsonPretty: false,
            jsonArrayWrapper: true
        });
        const content = fs.readFileSync(filePath, 'utf8');
        // Should be single line
        assert.ok(!content.includes('\n'));
        const parsed = JSON.parse(content);
        assert.equal(parsed[0].id, 1);
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('JSON export maps null values correctly', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.json');
    try {
        await service.exportData([sampleRows[2]], sampleColumns, {
            format: 'json',
            filePath,
            jsonPretty: true,
            jsonArrayWrapper: true
        });
        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(content);
        assert.equal(parsed[0].id, 3);
        assert.equal(parsed[0].name, null);
        assert.equal(parsed[0].amount, null);
    } finally {
        fs.unlinkSync(filePath);
    }
});

// ===== XML Export Tests =====

test('XML export with default element names', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.xml');
    try {
        await service.exportData(sampleRows.slice(0, 1), sampleColumns, {
            format: 'xml',
            filePath,
            xmlRootElement: 'data',
            xmlRowElement: 'row'
        });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.ok(content.includes('<?xml version="1.0" encoding="UTF-8"?>'));
        assert.ok(content.includes('<data>'));
        assert.ok(content.includes('</data>'));
        assert.ok(content.includes('<row>'));
        assert.ok(content.includes('</row>'));
        assert.ok(content.includes('<id>1</id>'));
        assert.ok(content.includes('<name>Alice</name>'));
        assert.ok(content.includes('<amount>100.5</amount>'));
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('XML export with custom element names', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.xml');
    try {
        await service.exportData(sampleRows.slice(0, 1), sampleColumns, {
            format: 'xml',
            filePath,
            xmlRootElement: 'resultset',
            xmlRowElement: 'record'
        });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.ok(content.includes('<resultset>'));
        assert.ok(content.includes('<record>'));
        assert.ok(content.includes('</resultset>'));
        assert.ok(content.includes('</record>'));
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('XML export escapes special characters', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.xml');
    const rows = [{ id: 1, name: '<script>alert("xss")</script>', amount: 5 }];
    try {
        await service.exportData(rows, sampleColumns, {
            format: 'xml',
            filePath,
            xmlRootElement: 'data',
            xmlRowElement: 'row'
        });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.ok(content.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'));
        assert.ok(!content.includes('<script>'));
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('XML export handles column names starting with numbers', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.xml');
    const columns = [{ name: '1st_col', dataType: 'text' }];
    const rows = [{ '1st_col': 'value' }];
    try {
        await service.exportData(rows, columns, {
            format: 'xml',
            filePath,
            xmlRootElement: 'data',
            xmlRowElement: 'row'
        });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.ok(content.includes('<_1st_col>'));
        assert.ok(content.includes('</_1st_col>'));
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('XML export handles column names with spaces', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.xml');
    const columns = [{ name: 'first name', dataType: 'text' }];
    const rows = [{ 'first name': 'Alice' }];
    try {
        await service.exportData(rows, columns, {
            format: 'xml',
            filePath,
            xmlRootElement: 'data',
            xmlRowElement: 'row'
        });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.ok(content.includes('<first_name>Alice</first_name>'));
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('XML export renders null values as empty elements', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.xml');
    try {
        await service.exportData([sampleRows[2]], sampleColumns, {
            format: 'xml',
            filePath,
            xmlRootElement: 'data',
            xmlRowElement: 'row'
        });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.ok(content.includes('<name></name>'));
        assert.ok(content.includes('<amount></amount>'));
    } finally {
        fs.unlinkSync(filePath);
    }
});

// ===== INSERT Export Tests =====

test('INSERT export generates single-row inserts', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.sql');
    try {
        await service.exportData(sampleRows.slice(0, 2), sampleColumns, {
            format: 'insert',
            filePath,
            insertTableName: 'public.users',
            insertBatchSize: 1
        });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.ok(content.includes("INSERT INTO public.users (id, name, amount) VALUES (1, 'Alice', 100.5);"));
        assert.ok(content.includes("INSERT INTO public.users (id, name, amount) VALUES (2, 'Bob', 200.75);"));
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('INSERT export generates batched inserts', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.sql');
    try {
        await service.exportData(sampleRows.slice(0, 2), sampleColumns, {
            format: 'insert',
            filePath,
            insertTableName: 'my_table',
            insertBatchSize: 2
        });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.ok(content.includes('INSERT INTO my_table (id, name, amount) VALUES'));
        assert.ok(content.includes("(1, 'Alice', 100.5),"));
        assert.ok(content.includes("(2, 'Bob', 200.75);"));
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('INSERT export handles NULL values', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.sql');
    try {
        await service.exportData([sampleRows[2]], sampleColumns, {
            format: 'insert',
            filePath,
            insertTableName: 'test_table',
            insertBatchSize: 1
        });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.ok(content.includes('(3, NULL, NULL)'));
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('INSERT export escapes single quotes in values', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.sql');
    const rows = [{ id: 1, name: "O'Reilly", amount: 10 }];
    try {
        await service.exportData(rows, sampleColumns, {
            format: 'insert',
            filePath,
            insertTableName: 'books',
            insertBatchSize: 1
        });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.ok(content.includes("'O''Reilly'"));
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('INSERT export quotes identifiers that need quoting', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.sql');
    const columns = [
        { name: 'id', dataType: 'integer' },
        { name: 'First Name', dataType: 'text' }
    ];
    const rows = [{ id: 1, 'First Name': 'Alice' }];
    try {
        await service.exportData(rows, columns, {
            format: 'insert',
            filePath,
            insertTableName: 'people',
            insertBatchSize: 1
        });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.ok(content.includes('"First Name"'));
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('INSERT export handles boolean values', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.sql');
    const columns = [{ name: 'active', dataType: 'boolean' }];
    const rows = [{ active: true }, { active: false }];
    try {
        await service.exportData(rows, columns, {
            format: 'insert',
            filePath,
            insertTableName: 'flags',
            insertBatchSize: 1
        });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.ok(content.includes('VALUES (TRUE);'));
        assert.ok(content.includes('VALUES (FALSE);'));
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('INSERT export uses default table name when not specified', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.sql');
    try {
        await service.exportData(sampleRows.slice(0, 1), sampleColumns, {
            format: 'insert',
            filePath,
            insertBatchSize: 1
        });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.ok(content.includes('INSERT INTO table_name'));
    } finally {
        fs.unlinkSync(filePath);
    }
});

// ===== INSERT ON CONFLICT Tests =====

test('buildOnConflictClause returns no clause for mode none', () => {
    const service = new ExportService(createMockContext());
    assert.equal(service.buildOnConflictClause('none', ['id'], ['id', 'name']), '');
});

test('buildOnConflictClause emits DO NOTHING', () => {
    const service = new ExportService(createMockContext());
    assert.equal(service.buildOnConflictClause('nothing', ['id'], ['id', 'name']), ' ON CONFLICT DO NOTHING');
});

test('buildOnConflictClause: DO UPDATE conflicts on the key and rewrites every other column', () => {
    const service = new ExportService(createMockContext());
    assert.equal(
        service.buildOnConflictClause('update', ['id'], ['id', 'name', 'amount']),
        ' ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, amount = EXCLUDED.amount'
    );
});

test('buildOnConflictClause: DO UPDATE supports a composite key and quotes identifiers', () => {
    const service = new ExportService(createMockContext());
    assert.equal(
        service.buildOnConflictClause('update', ['org id', 'id'], ['org id', 'id', 'First Name']),
        ' ON CONFLICT ("org id", id) DO UPDATE SET "First Name" = EXCLUDED."First Name"'
    );
});

test('buildOnConflictClause: DO UPDATE ignores conflict columns that are not exported', () => {
    const service = new ExportService(createMockContext());
    assert.equal(
        service.buildOnConflictClause('update', ['id', 'missing'], ['id', 'name']),
        ' ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name'
    );
});

test('buildOnConflictClause: DO UPDATE degrades to DO NOTHING without a usable key', () => {
    const service = new ExportService(createMockContext());
    assert.equal(service.buildOnConflictClause('update', [], ['id', 'name']), ' ON CONFLICT DO NOTHING');
});

test('buildOnConflictClause: DO UPDATE degrades to DO NOTHING when every column is a key', () => {
    const service = new ExportService(createMockContext());
    assert.equal(service.buildOnConflictClause('update', ['id', 'name'], ['id', 'name']), ' ON CONFLICT DO NOTHING');
});

test('INSERT export appends ON CONFLICT DO NOTHING to each statement', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.sql');
    try {
        await service.exportData(sampleRows.slice(0, 1), sampleColumns, {
            format: 'insert',
            filePath,
            insertTableName: 'public.users',
            insertBatchSize: 1,
            insertOnConflict: 'nothing'
        });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.ok(content.includes("VALUES (1, 'Alice', 100.5) ON CONFLICT DO NOTHING;"));
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('INSERT export appends ON CONFLICT DO UPDATE for non-key columns', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.sql');
    try {
        await service.exportData(sampleRows.slice(0, 1), sampleColumns, {
            format: 'insert',
            filePath,
            insertTableName: 'public.users',
            insertBatchSize: 1,
            insertOnConflict: 'update',
            insertConflictColumns: ['id']
        });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.ok(content.includes(
            "VALUES (1, 'Alice', 100.5) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, amount = EXCLUDED.amount;"
        ));
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('INSERT export places the ON CONFLICT clause once at the end of a batch', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.sql');
    try {
        await service.exportData(sampleRows.slice(0, 2), sampleColumns, {
            format: 'insert',
            filePath,
            insertTableName: 'my_table',
            insertBatchSize: 2,
            insertOnConflict: 'update',
            insertConflictColumns: ['id']
        });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.ok(content.includes(
            "(2, 'Bob', 200.75) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, amount = EXCLUDED.amount;"
        ));
        // Only the final VALUES tuple carries the clause, not the first.
        assert.ok(content.includes("(1, 'Alice', 100.5),\n"));
    } finally {
        fs.unlinkSync(filePath);
    }
});

// ===== Excel Export Tests =====

test('Excel export creates a valid xlsx file with headers', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.xlsx');
    try {
        await service.exportData(sampleRows.slice(0, 2), sampleColumns, {
            format: 'excel',
            filePath,
            excelIncludeHeaders: true,
            excelSheetName: 'TestData',
            excelIncludeSqlSheet: false
        });
        assert.ok(fs.existsSync(filePath));
        const stat = fs.statSync(filePath);
        assert.ok(stat.size > 0);

        // Verify content using exceljs
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(filePath);
        const sheet = workbook.getWorksheet('TestData');
        assert.ok(sheet);
        // Header row
        assert.equal(sheet.getRow(1).getCell(1).value, 'id');
        assert.equal(sheet.getRow(1).getCell(2).value, 'name');
        assert.equal(sheet.getRow(1).getCell(3).value, 'amount');
        // Data rows
        assert.equal(sheet.getRow(2).getCell(1).value, 1);
        assert.equal(sheet.getRow(2).getCell(2).value, 'Alice');
        assert.equal(sheet.getRow(2).getCell(3).value, 100.5);
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('Excel export without headers starts data at row 1', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.xlsx');
    try {
        await service.exportData(sampleRows.slice(0, 1), sampleColumns, {
            format: 'excel',
            filePath,
            excelIncludeHeaders: false,
            excelSheetName: 'Data',
            excelIncludeSqlSheet: false
        });
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(filePath);
        const sheet = workbook.getWorksheet('Data');
        assert.ok(sheet);
        assert.equal(sheet.getRow(1).getCell(1).value, 1);
        assert.equal(sheet.getRow(1).getCell(2).value, 'Alice');
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('Excel export includes SQL sheet when requested', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.xlsx');
    const sql = 'SELECT * FROM users WHERE active = true';
    try {
        await service.exportData(sampleRows.slice(0, 1), sampleColumns, {
            format: 'excel',
            filePath,
            excelIncludeHeaders: true,
            excelSheetName: 'Data',
            excelIncludeSqlSheet: true,
            excelSqlStatement: sql
        });
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(filePath);
        const sqlSheet = workbook.getWorksheet('SQL');
        assert.ok(sqlSheet);
        assert.equal(sqlSheet.getRow(1).getCell(1).value, 'SQL Statement');
        assert.equal(sqlSheet.getRow(2).getCell(1).value, sql);
    } finally {
        fs.unlinkSync(filePath);
    }
});

// ===== excelCellValue (3.3.0: dates arrive as raw text) =====

test('excelCellValue turns a raw date into a UTC-midnight Excel date', () => {
    const v = excelCellValue('2024-01-31', 'date');
    assert.ok(v instanceof Date);
    assert.equal((v as Date).toISOString(), '2024-01-31T00:00:00.000Z');
});

test('excelCellValue keeps years below 100 and rejects impossible dates', () => {
    assert.equal((excelCellValue('0099-12-31', 'date') as Date).toISOString(), '0099-12-31T00:00:00.000Z');
    assert.equal(excelCellValue('2024-02-30', 'date'), '2024-02-30');
    assert.equal(excelCellValue('infinity', 'date'), 'infinity');
});

test('excelCellValue leaves other columns and NULLs alone', () => {
    assert.equal(excelCellValue('2024-01-31', 'text'), '2024-01-31');
    assert.equal(excelCellValue('2024-01-31 10:00:00', 'timestamp without time zone'), '2024-01-31 10:00:00');
    assert.equal(excelCellValue(42, 'integer'), 42);
    assert.equal(excelCellValue(null, 'date'), '');
    assert.equal(excelCellValue(undefined, 'date'), '');
});

test('Excel export writes a date column as real date cells on the right day', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.xlsx');
    try {
        await service.exportData(
            [{ id: 1, due: '2024-01-31' }, { id: 2, due: null }],
            [{ name: 'id', dataType: 'integer' }, { name: 'due', dataType: 'date' }],
            { format: 'excel', filePath, excelIncludeHeaders: true, excelSheetName: 'Data', excelIncludeSqlSheet: false }
        );
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(filePath);
        const cell = workbook.getWorksheet('Data').getRow(2).getCell(2);
        assert.ok(cell.value instanceof Date, 'expected a date cell, not text');
        assert.equal(cell.value.toISOString(), '2024-01-31T00:00:00.000Z');
        assert.equal(cell.numFmt, EXCEL_DATE_FORMAT);
        assert.equal(workbook.getWorksheet('Data').getRow(2).getCell(1).numFmt, undefined);
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('CSV and INSERT exports write a raw date as written in the database', async () => {
    const service = new ExportService(createMockContext());
    const csvPath = getTempFile('.csv');
    const sqlPath = getTempFile('.sql');
    const rows = [{ due: '2024-01-31' }];
    const cols = [{ name: 'due', dataType: 'date' }];
    try {
        await service.exportData(rows, cols, { format: 'csv', filePath: csvPath, csvIncludeHeaders: false, csvQuoteStrings: false });
        assert.equal(fs.readFileSync(csvPath, 'utf8').trim(), '2024-01-31');
        await service.exportData(rows, cols, { format: 'insert', filePath: sqlPath, insertTableName: 't' });
        assert.ok(fs.readFileSync(sqlPath, 'utf8').includes("('2024-01-31')"));
    } finally {
        fs.unlinkSync(csvPath);
        fs.unlinkSync(sqlPath);
    }
});

// ===== Defaults Persistence Tests =====

test('saveDefaults and getDefaults persist format options', () => {
    const service = new ExportService(createMockContext());
    service.saveDefaults('csv', { csvSeparator: ';', csvIncludeHeaders: false });
    const defaults = service.getDefaults();
    assert.equal((defaults.csv as any).csvSeparator, ';');
    assert.equal((defaults.csv as any).csvIncludeHeaders, false);
});

test('saveSaveLocation and getSaveLocation persist the directory', () => {
    const service = new ExportService(createMockContext());
    assert.equal(service.getSaveLocation(), '');
    service.saveSaveLocation('C:\\Users\\test\\exports');
    assert.equal(service.getSaveLocation(), 'C:\\Users\\test\\exports');
});

test('getDefaults includes _saveLocation', () => {
    const ctx = createMockContext();
    const service = new ExportService(ctx);
    service.saveSaveLocation('/home/user/exports');
    const defaults = service.getDefaults();
    assert.equal((defaults as any)._saveLocation, '/home/user/exports');
});

test('saveDefaults for multiple formats does not overwrite each other', () => {
    const service = new ExportService(createMockContext());
    service.saveDefaults('csv', { csvSeparator: '|' });
    service.saveDefaults('json', { jsonPretty: false });
    const defaults = service.getDefaults();
    assert.equal((defaults.csv as any).csvSeparator, '|');
    assert.equal((defaults.json as any).jsonPretty, false);
});

// ===== Edge Cases =====

test('CSV export handles empty rows array', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.csv');
    try {
        await service.exportData([], sampleColumns, {
            format: 'csv',
            filePath,
            csvSeparator: ',',
            csvIncludeHeaders: true,
            csvQuoteStrings: true,
            csvLineEnding: 'lf'
        });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.equal(content, 'id,name,amount');
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('JSON export handles empty rows array', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.json');
    try {
        await service.exportData([], sampleColumns, {
            format: 'json',
            filePath,
            jsonPretty: true,
            jsonArrayWrapper: true
        });
        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(content);
        assert.deepEqual(parsed, []);
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('INSERT export handles empty rows array', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.sql');
    try {
        await service.exportData([], sampleColumns, {
            format: 'insert',
            filePath,
            insertTableName: 'empty_table',
            insertBatchSize: 1
        });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.equal(content, '');
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('CSV export with newline in value quotes correctly', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.csv');
    const rows = [{ id: 1, name: 'Line1\nLine2', amount: 5 }];
    try {
        await service.exportData(rows, sampleColumns, {
            format: 'csv',
            filePath,
            csvSeparator: ',',
            csvIncludeHeaders: false,
            csvQuoteStrings: true,
            csvLineEnding: 'lf'
        });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.ok(content.includes('"Line1\nLine2"'));
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('XML export with ampersand in value escapes correctly', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.xml');
    const rows = [{ id: 1, name: 'Tom & Jerry', amount: 0 }];
    try {
        await service.exportData(rows, sampleColumns, {
            format: 'xml',
            filePath,
            xmlRootElement: 'data',
            xmlRowElement: 'row'
        });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.ok(content.includes('Tom &amp; Jerry'));
    } finally {
        fs.unlinkSync(filePath);
    }
});

// ===== parsed PostgreSQL values (json/jsonb, arrays, timestamptz, bytea) =====

const typedColumns = [
    { name: 'doc', dataType: 'jsonb' },
    { name: 'tags', dataType: 'text[]' },
    { name: 'grid', dataType: 'integer[]' },
    { name: 'at', dataType: 'timestamp with time zone' },
    { name: 'raw', dataType: 'bytea' },
    { name: 'note', dataType: 'text' }
];

const typedRow = {
    doc: { a: 1, b: ['x', null] },
    tags: ['plain', 'a,b', 'say "hi"', '', null],
    grid: [[1, 2], [3, 4]],
    at: '2024-01-31 10:15:00.123456+01',
    raw: Buffer.from([0xde, 0xad]),
    note: null
};

test('CSV export writes json, arrays, timestamptz and bytea in their PostgreSQL text form', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.csv');
    try {
        await service.exportData([typedRow], typedColumns, {
            format: 'csv', filePath, csvSeparator: ';', csvIncludeHeaders: false, csvQuoteStrings: true, csvLineEnding: 'lf'
        });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.equal(
            content,
            '"{""a"":1,""b"":[""x"",null]}";'
            + '"{plain,""a,b"",""say \\""hi\\"""","""",NULL}";'
            + '{{1,2},{3,4}};'
            + '2024-01-31 10:15:00.123456+01;'
            + '\\xdead;'
        );
        assert.ok(!content.includes('[object Object]'));
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('XML export writes json and arrays in their PostgreSQL text form', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.xml');
    try {
        await service.exportData([typedRow], typedColumns, { format: 'xml', filePath });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.ok(content.includes('<doc>{&quot;a&quot;:1,&quot;b&quot;:[&quot;x&quot;,null]}</doc>'));
        assert.ok(content.includes('<grid>{{1,2},{3,4}}</grid>'));
        assert.ok(content.includes('<at>2024-01-31 10:15:00.123456+01</at>'));
        assert.ok(content.includes('<raw>\\xdead</raw>'));
        assert.ok(content.includes('<note></note>'));
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('INSERT export writes json, arrays, timestamptz, bytea and NULL as valid literals', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.sql');
    try {
        await service.exportData([typedRow], typedColumns, { format: 'insert', filePath, insertTableName: 't' });
        const content = fs.readFileSync(filePath, 'utf8');
        assert.equal(
            content,
            'INSERT INTO t (doc, tags, grid, at, raw, note) VALUES ('
            + `'{"a":1,"b":["x",null]}', `
            + `'{plain,"a,b","say \\"hi\\"","",NULL}', `
            + `'{{1,2},{3,4}}', `
            + `'2024-01-31 10:15:00.123456+01', `
            + `'\\xdead', `
            + 'NULL);'
        );
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('JSON export keeps json objects and arrays native and writes bytea as hex text', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.json');
    try {
        await service.exportData([typedRow], typedColumns, { format: 'json', filePath, jsonPretty: false });
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        assert.deepEqual(parsed[0].doc, { a: 1, b: ['x', null] });
        assert.deepEqual(parsed[0].grid, [[1, 2], [3, 4]]);
        assert.equal(parsed[0].at, '2024-01-31 10:15:00.123456+01');
        assert.equal(parsed[0].raw, '\\xdead');
        assert.equal(parsed[0].note, null);
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('excelCellValue writes json objects and arrays as their text instead of an object', () => {
    assert.equal(excelCellValue({ a: 1 }, 'jsonb'), '{"a":1}');
    assert.equal(excelCellValue([1, 2], 'integer[]'), '{1,2}');
    assert.equal(excelCellValue(Buffer.from([1]), 'bytea'), '\\x01');
});

// ===== json/jsonb arrays and scalars, interval, Excel timestamptz =====

const jsonColumns = [
    { name: 'list', dataType: 'jsonb' },
    { name: 'word', dataType: 'jsonb' },
    { name: 'num', dataType: 'json' },
    { name: 'flag', dataType: 'jsonb' },
    { name: 'docs', dataType: '_jsonb' }
];
// What the driver returns for '["a","b"]', '"abc"', '5', 'true' and '{"\"x\"","{\"k\":1}"}'.
const jsonRow = { list: ['a', 'b'], word: 'abc', num: 5, flag: true, docs: ['x', { k: 1 }] };

test('CSV export writes jsonb arrays and scalars as JSON, not as PostgreSQL arrays or bare text', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.csv');
    try {
        await service.exportData([jsonRow], jsonColumns, {
            format: 'csv', filePath, csvSeparator: ';', csvIncludeHeaders: false, csvQuoteStrings: true, csvLineEnding: 'lf'
        });
        assert.equal(
            fs.readFileSync(filePath, 'utf8'),
            '"[""a"",""b""]";"""abc""";5;true;"{""\\""x\\"""",""{\\""k\\"":1}""}"'
        );
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('INSERT export quotes every json value as JSON text so the script loads again', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.sql');
    try {
        await service.exportData([jsonRow], jsonColumns, { format: 'insert', filePath, insertTableName: 't' });
        assert.equal(
            fs.readFileSync(filePath, 'utf8'),
            `INSERT INTO t (list, word, num, flag, docs) VALUES ('["a","b"]', '"abc"', '5', 'true', '{"\\"x\\"","{\\"k\\":1}"}');`
        );
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('excelCellValue writes jsonb arrays and scalars as JSON text', () => {
    assert.equal(excelCellValue(['a', 'b'], 'jsonb'), '["a","b"]');
    assert.equal(excelCellValue('abc', 'jsonb'), '"abc"');
    assert.equal(excelCellValue(5, 'json'), '5');
});

test('export text of a driver object uses its own PostgreSQL text form', async () => {
    const interval = { days: 1, hours: 2, toPostgres: () => '2 hours 1 days' };
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.csv');
    try {
        await service.exportData([{ span: interval }], [{ name: 'span', dataType: 'interval' }], {
            format: 'csv', filePath, csvIncludeHeaders: false
        });
        assert.equal(fs.readFileSync(filePath, 'utf8'), '2 hours 1 days');
    } finally {
        fs.unlinkSync(filePath);
    }
});

test('excelCellValue turns timestamptz text into a date cell with the displayed wall-clock time', () => {
    const v = excelCellValue('2024-01-31 10:15:00.123456+01', 'timestamptz');
    assert.ok(v instanceof Date);
    assert.equal((v as Date).toISOString(), '2024-01-31T10:15:00.123Z');
    assert.equal(excelNumberFormat(v, 'timestamp with time zone'), EXCEL_TIMESTAMP_FORMAT);
    assert.equal(excelCellValue('infinity', 'timestamptz'), 'infinity');
    assert.equal(excelCellValue('2024-01-31 10:15:00+01 BC', 'timestamptz'), '2024-01-31 10:15:00+01 BC');
});

test('Excel export writes a timestamptz column as date cells with a timestamp format', async () => {
    const service = new ExportService(createMockContext());
    const filePath = getTempFile('.xlsx');
    try {
        await service.exportData(
            [{ at: '2024-01-31 10:15:00+01' }],
            [{ name: 'at', dataType: 'timestamptz' }],
            { format: 'excel', filePath, excelIncludeHeaders: false, excelSheetName: 'Data', excelIncludeSqlSheet: false }
        );
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(filePath);
        const cell = workbook.getWorksheet('Data').getRow(1).getCell(1);
        assert.ok(cell.value instanceof Date, 'expected a date cell, not text');
        assert.equal(cell.numFmt, EXCEL_TIMESTAMP_FORMAT);
    } finally {
        fs.unlinkSync(filePath);
    }
});
