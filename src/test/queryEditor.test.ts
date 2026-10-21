import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const editor = require(path.join(__dirname, '../../../src/webview/queryEditor.js'));
const {
    tokenizeSql,
    extractTableReferences,
    completionContext,
    resolveQualifier,
    resolveRelation,
    relationInsertText,
    tablesNeedingColumns,
    buildSuggestions,
    completionKeywords,
    cssColorToHex,
    monacoBaseTheme,
    themeColorsFrom,
    editorHeight,
    createWorkerUrlProvider
} = editor;

// ===== createWorkerUrlProvider =====

/** Stand-in for the browser's URL.createObjectURL / revokeObjectURL. */
function fakeUrlApi() {
    const created: Blob[] = [];
    const revoked: string[] = [];
    return {
        created,
        revoked,
        createObjectURL: (blob: Blob) => { created.push(blob); return `blob:vscode-webview/${created.length}`; },
        revokeObjectURL: (url: string) => { revoked.push(url); }
    };
}

test('createWorkerUrlProvider creates one blob URL and shares it between all workers', () => {
    const urls = fakeUrlApi();
    const provider = createWorkerUrlProvider('https://file.vscode-resource/dist/monaco/editor.worker.js', urls);
    assert.equal(urls.created.length, 0, 'nothing is created before a worker is needed');
    const first = provider.get();
    const second = provider.get();
    assert.equal(first, second);
    assert.equal(urls.created.length, 1, 'starting more workers creates no further blob URLs');
});

test('createWorkerUrlProvider wraps the worker script in an importScripts call', async () => {
    const urls = fakeUrlApi();
    createWorkerUrlProvider('https://x/editor "worker".js', urls).get();
    assert.equal(await urls.created[0].text(), 'importScripts("https://x/editor \\"worker\\".js");');
    assert.equal(urls.created[0].type, 'text/javascript');
});

test('createWorkerUrlProvider revokes its URL once on release and creates a fresh one if needed again', () => {
    const urls = fakeUrlApi();
    const provider = createWorkerUrlProvider('w.js', urls);
    provider.release();
    assert.deepEqual(urls.revoked, [], 'nothing to revoke before first use');
    const url = provider.get();
    provider.release();
    provider.release();
    assert.deepEqual(urls.revoked, [url], 'revoked exactly once');
    assert.notEqual(provider.get(), url);
    assert.equal(urls.created.length, 2);
});

const CATALOG = {
    schemas: ['public', 'sales', 'Archive'],
    searchPath: ['public'],
    relations: [
        { schema: 'public', name: 'orders', kind: 'table' },
        { schema: 'public', name: 'customers', kind: 'table' },
        { schema: 'sales', name: 'orders', kind: 'table' },
        { schema: 'sales', name: 'invoices', kind: 'table' },
        { schema: 'sales', name: 'totals', kind: 'matview' },
        { schema: 'Archive', name: 'Old Orders', kind: 'view' }
    ]
};
const quote = (n: string) => (/^[a-z_][a-z0-9_$]*$/.test(n) ? n : `"${n.replace(/"/g, '""')}"`);

// ===== tokenizeSql =====

test('tokenizeSql folds unquoted names and keeps quoted ones exactly', () => {
    const tokens = tokenizeSql('SELECT "My ""Col""" FROM Orders').filter((t: any) => t.type !== 'ws');
    assert.deepEqual(tokens.map((t: any) => [t.type, t.name ?? t.text]), [
        ['word', 'select'], ['qident', 'My "Col"'], ['word', 'from'], ['word', 'orders']
    ]);
});

test('tokenizeSql marks comments, strings and dollar quotes that are still open', () => {
    const open = (sql: string) => { const t = tokenizeSql(sql); return [t[t.length - 1].type, t[t.length - 1].closed]; };
    assert.deepEqual(open("SELECT 'abc"), ['string', false]);
    assert.deepEqual(open("SELECT 'it''s'"), ['string', true]);
    assert.deepEqual(open('SELECT 1 -- note'), ['comment', false]);
    assert.deepEqual(open('SELECT /* a'), ['comment', false]);
    assert.deepEqual(open('SELECT $f$ body'), ['string', false]);
    assert.deepEqual(open('SELECT $1'), ['param', undefined]);
});

// ===== extractTableReferences =====

test('extractTableReferences finds tables with and without schema and alias', () => {
    assert.deepEqual(extractTableReferences('SELECT * FROM public.orders o JOIN customers AS c ON c.id = o.customer_id'), [
        { schema: 'public', table: 'orders', alias: 'o' },
        { schema: null, table: 'customers', alias: 'c' }
    ]);
});

test('extractTableReferences reads a comma list, quoted names and UPDATE / INSERT targets', () => {
    assert.deepEqual(extractTableReferences('SELECT 1 FROM a, "Archive"."Old Orders" x WHERE true'), [
        { schema: null, table: 'a', alias: null },
        { schema: 'Archive', table: 'Old Orders', alias: 'x' }
    ]);
    assert.deepEqual(extractTableReferences('UPDATE t SET a = 1'), [{ schema: null, table: 't', alias: null }]);
    assert.deepEqual(extractTableReferences('INSERT INTO s.t (a) VALUES (1)'), [{ schema: 's', table: 't', alias: null }]);
});

test('extractTableReferences does not take a clause keyword for an alias', () => {
    assert.deepEqual(extractTableReferences('SELECT * FROM orders WHERE id = 1'), [{ schema: null, table: 'orders', alias: null }]);
    assert.deepEqual(extractTableReferences('SELECT * FROM orders LEFT JOIN items i USING (id)'), [
        { schema: null, table: 'orders', alias: null },
        { schema: null, table: 'items', alias: 'i' }
    ]);
});

test('extractTableReferences skips sub-selects and table functions but reads tables inside them', () => {
    assert.deepEqual(extractTableReferences('SELECT * FROM (SELECT * FROM inner_t it) s, generate_series(1, 3) g'), [
        { schema: null, table: 'inner_t', alias: 'it' }
    ]);
});

test('extractTableReferences ignores a name whose schema is still being typed', () => {
    assert.deepEqual(extractTableReferences('SELECT * FROM sales.'), []);
});

test('extractTableReferences ignores keywords inside strings and comments', () => {
    assert.deepEqual(extractTableReferences("SELECT 'from x' -- join y\nFROM z"), [{ schema: null, table: 'z', alias: null }]);
});

// ===== completionContext =====

test('completionContext offers nothing inside a string, a comment or a quoted name', () => {
    assert.equal(completionContext("SELECT 'abc").kind, 'none');
    assert.equal(completionContext('SELECT 1 -- abc').kind, 'none');
    assert.equal(completionContext('SELECT "Ab').kind, 'none');
});

test('completionContext recognises a qualified name being completed', () => {
    assert.deepEqual(completionContext('SELECT o.'), { kind: 'member', path: ['o'], prefix: '' });
    assert.deepEqual(completionContext('SELECT o.cu'), { kind: 'member', path: ['o'], prefix: 'cu' });
    assert.deepEqual(completionContext('SELECT sales.invoices.am'), { kind: 'member', path: ['sales', 'invoices'], prefix: 'am' });
    assert.deepEqual(completionContext('SELECT "Archive".'), { kind: 'member', path: ['Archive'], prefix: '' });
});

test('completionContext recognises where a table name belongs', () => {
    assert.equal(completionContext('SELECT * FROM ').kind, 'relation');
    assert.equal(completionContext('SELECT * FROM ord').kind, 'relation');
    assert.equal(completionContext('SELECT * FROM a LEFT JOIN ').kind, 'relation');
    assert.equal(completionContext('SELECT * FROM a, ').kind, 'relation');
    assert.equal(completionContext('UPDATE ').kind, 'relation');
});

test('completionContext treats a comma outside FROM as an expression list', () => {
    assert.equal(completionContext('SELECT a, ').kind, 'any');
    assert.equal(completionContext('SELECT * FROM t WHERE x IN (1, ').kind, 'any');
    assert.equal(completionContext('SELECT * FROM t ORDER BY a, ').kind, 'any');
});

// ===== resolving names =====

test('resolveQualifier prefers an alias, then a table of the statement, then a schema', () => {
    const refs = [{ schema: 'sales', table: 'orders', alias: 'o' }, { schema: null, table: 'customers', alias: null }];
    assert.deepEqual(resolveQualifier(['o'], refs, CATALOG), { type: 'table', schema: 'sales', table: 'orders' });
    assert.deepEqual(resolveQualifier(['customers'], refs, CATALOG), { type: 'table', schema: null, table: 'customers' });
    assert.deepEqual(resolveQualifier(['sales'], refs, CATALOG), { type: 'schema', schema: 'sales' });
    assert.deepEqual(resolveQualifier(['invoices'], [], CATALOG), { type: 'table', schema: null, table: 'invoices' });
    assert.deepEqual(resolveQualifier(['sales', 'invoices'], [], CATALOG), { type: 'table', schema: 'sales', table: 'invoices' });
    assert.equal(resolveQualifier(['nope'], [], CATALOG), null);
});

test('resolveRelation follows the search_path like PostgreSQL', () => {
    assert.deepEqual(resolveRelation({ schema: null, table: 'orders' }, CATALOG), { schema: 'public', table: 'orders' });
    assert.deepEqual(resolveRelation({ schema: null, table: 'invoices' }, CATALOG), { schema: 'sales', table: 'invoices' });
    assert.deepEqual(resolveRelation({ schema: 'sales', table: 'orders' }, CATALOG), { schema: 'sales', table: 'orders' });
    assert.equal(resolveRelation({ schema: null, table: 'missing' }, CATALOG), null);
});

test('relationInsertText qualifies only what the search_path would not find', () => {
    assert.equal(relationInsertText({ schema: 'public', name: 'orders' }, CATALOG, quote), 'orders');
    assert.equal(relationInsertText({ schema: 'sales', name: 'orders' }, CATALOG, quote), 'sales.orders');
    assert.equal(relationInsertText({ schema: 'sales', name: 'invoices' }, CATALOG, quote), 'sales.invoices');
    assert.equal(relationInsertText({ schema: 'Archive', name: 'Old Orders' }, CATALOG, quote), '"Archive"."Old Orders"');
});

test('tablesNeedingColumns asks once per table for what the suggestions show', () => {
    const refs = extractTableReferences('SELECT * FROM orders o JOIN sales.invoices i ON true JOIN orders o2 ON true');
    assert.deepEqual(tablesNeedingColumns({ kind: 'any' }, refs, CATALOG), [
        { schema: 'public', table: 'orders' }, { schema: 'sales', table: 'invoices' }
    ]);
    assert.deepEqual(tablesNeedingColumns({ kind: 'member', path: ['i'] }, refs, CATALOG), [{ schema: 'sales', table: 'invoices' }]);
    assert.deepEqual(tablesNeedingColumns({ kind: 'relation' }, refs, CATALOG), []);
});

// ===== buildSuggestions =====

const COLUMNS: Record<string, Array<{ name: string; type: string }>> = {
    'public.orders': [{ name: 'id', type: 'integer' }, { name: 'Order Date', type: 'date' }],
    'sales.invoices': [{ name: 'amount', type: 'numeric' }]
};
const data = (refs: any[]) => ({
    catalog: CATALOG,
    refs,
    columnsOf: (s: string, t: string) => COLUMNS[`${s}.${t}`],
    keywords: ['SELECT', 'WHERE'],
    functions: ['coalesce', 'now'],
    quoteIdent: quote
});

test('buildSuggestions after an alias lists that table\'s columns in table order, quoted where needed', () => {
    const refs = extractTableReferences('SELECT FROM orders o');
    const items = buildSuggestions({ kind: 'member', path: ['o'] }, data(refs));
    assert.deepEqual(items.map((i: any) => [i.label, i.insertText, i.kind]), [
        ['id', 'id', 'column'], ['Order Date', '"Order Date"', 'column']
    ]);
    assert.equal(items[0].detail, 'integer — public.orders');
});

test('buildSuggestions after a schema lists that schema\'s tables and views', () => {
    const items = buildSuggestions({ kind: 'member', path: ['sales'] }, data([]));
    assert.deepEqual(items.map((i: any) => [i.label, i.kind]), [['orders', 'table'], ['invoices', 'table'], ['totals', 'view']]);
});

test('buildSuggestions where a table belongs puts reachable tables before qualified ones and schemas last', () => {
    const items = buildSuggestions({ kind: 'relation' }, data([]));
    const sorted = [...items].sort((a: any, b: any) => (a.sortText < b.sortText ? -1 : 1)).map((i: any) => i.insertText);
    assert.deepEqual(sorted.slice(0, 2), ['customers', 'orders']);
    assert.ok(sorted.indexOf('sales.orders') > sorted.indexOf('orders'));
    assert.ok(sorted.indexOf('sales') > sorted.indexOf('sales.orders'), 'schemas after the tables');
    assert.ok(sorted.indexOf('SELECT') > sorted.indexOf('sales'), 'keywords last');
});

test('buildSuggestions in an expression offers columns, aliases, functions and keywords in that order', () => {
    const refs = extractTableReferences('SELECT  FROM orders o JOIN sales.invoices i ON true');
    const items = buildSuggestions({ kind: 'any' }, data(refs));
    const sorted = [...items].sort((a: any, b: any) => (a.sortText < b.sortText ? -1 : 1));
    assert.deepEqual(sorted.map((i: any) => i.kind), [
        'column', 'column', 'column', 'alias', 'alias', 'function', 'function', 'keyword', 'keyword'
    ]);
    const fn = items.find((i: any) => i.label === 'coalesce');
    assert.equal(fn.insertText, 'coalesce($0)');
    assert.equal(fn.isSnippet, true);
    assert.equal(items.find((i: any) => i.label === 'amount').detail, 'numeric — i');
});

test('buildSuggestions offers nothing inside a string or comment', () => {
    assert.deepEqual(buildSuggestions({ kind: 'none' }, data([])), []);
});

test('completionKeywords merges the grammar lists with clause keywords, upper case and unique', () => {
    const words = completionKeywords({ keywords: ['SELECT', 'from'], operators: ['AND', '+'] });
    assert.ok(words.includes('SELECT') && words.includes('FROM') && words.includes('AND'));
    assert.ok(words.includes('JOIN') && words.includes('BY'), 'clause keywords that are not reserved words');
    assert.ok(!words.includes('+'));
    assert.equal(new Set(words).size, words.length);
});

// ===== theme =====

test('cssColorToHex converts the colour notations of VS Code theme variables', () => {
    assert.equal(cssColorToHex('#ABC'), '#aabbcc');
    assert.equal(cssColorToHex('#1e1e1e'), '#1e1e1e');
    assert.equal(cssColorToHex('#1e1e1e80'), '#1e1e1e80');
    assert.equal(cssColorToHex(' rgb(38, 79, 120) '), '#264f78');
    assert.equal(cssColorToHex('rgba(255, 255, 255, 0.5)'), '#ffffff80');
    assert.equal(cssColorToHex('rgba(0, 0, 0, 1)'), '#000000');
    assert.equal(cssColorToHex('transparent'), null);
    assert.equal(cssColorToHex(''), null);
});

test('monacoBaseTheme follows the theme kind VS Code puts on the body', () => {
    assert.equal(monacoBaseTheme('vscode-light'), 'vs');
    assert.equal(monacoBaseTheme('vscode-dark'), 'vs-dark');
    assert.equal(monacoBaseTheme('vscode-high-contrast'), 'hc-black');
    assert.equal(monacoBaseTheme('vscode-high-contrast vscode-high-contrast-light'), 'hc-light');
    assert.equal(monacoBaseTheme(''), 'vs-dark');
});

test('themeColorsFrom takes the first theme variable that is set and skips the rest', () => {
    const vars: Record<string, string> = {
        '--vscode-editor-background': '#1e1e1e',
        '--vscode-input-foreground': 'rgb(204, 204, 204)',
        '--vscode-focusBorder': 'not a colour'
    };
    const colors = themeColorsFrom((name: string) => vars[name] || '');
    assert.equal(colors['editor.background'], '#1e1e1e', 'falls back from the input to the editor background');
    assert.equal(colors['editor.foreground'], '#cccccc');
    assert.equal('focusBorder' in colors, false);
});

test('editorHeight keeps the editor between one line and the maximum', () => {
    assert.equal(editorHeight(10, 26, 320), 26);
    assert.equal(editorHeight(57.4, 26, 320), 58);
    assert.equal(editorHeight(900, 26, 320), 320);
    assert.equal(editorHeight(NaN, 26, 320), 26);
});
