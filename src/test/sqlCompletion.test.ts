import './helpers/vscodeMock';
import { vscodeStub } from './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import {
    completionScope,
    sqlFileSuggestions,
    CompletionCatalogCache,
    loadSqlCompletionApi,
    loadSqlWords,
    quoteCompletionIdentifier,
    completionTableAlias,
    loadCompletionCatalog,
    SqlFileCompletionProvider,
    type CatalogSource,
    type SqlWords
} from '../sqlCompletion';

/** Repo root: the extension loads the helpers from src/webview at runtime. */
const EXTENSION_PATH = path.join(__dirname, '..', '..', '..');
const api = loadSqlCompletionApi(EXTENSION_PATH);
const WORDS: SqlWords = { keywords: ['FROM', 'SELECT', 'WHERE'], functions: ['coalesce', 'now'] };
const quote = (name: string) => quoteCompletionIdentifier(name, false);

const COLUMNS: Record<string, Array<{ column_name: string; data_type: string }>> = {
    'public.orders': [{ column_name: 'id', data_type: 'integer' }, { column_name: 'customer_id', data_type: 'integer' }],
    'public.customers': [{ column_name: 'id', data_type: 'integer' }, { column_name: 'name', data_type: 'text' }],
    'sales.invoices': [{ column_name: 'total', data_type: 'numeric(10,2)' }]
};

/** A catalog source with two schemas; records every query it answers. */
function fakeSource(options: { connected?: boolean; fail?: boolean } = {}) {
    const queries: string[] = [];
    const source: CatalogSource = {
        isConnected: () => options.connected !== false,
        queryMetadata: async (sql: string, params?: unknown[]) => {
            queries.push(sql);
            if (options.fail) throw new Error('connection lost');
            if (sql.includes('first_column')) {
                return [
                    { table_schema: 'public', table_name: 'orders', first_column: 'ord_id' },
                    { table_schema: 'public', table_name: 'customers', first_column: 'id' },
                    { table_schema: 'sales', table_name: 'invoices', first_column: 'inv_total' }
                ];
            }
            if (sql.includes('pg_namespace') && sql.includes('nspname NOT IN')) {
                return [{ nspname: 'public' }, { nspname: 'sales' }];
            }
            if (sql.includes('current_schemas')) {
                return [{ schema_name: 'public' }];
            }
            if (sql.includes('pg_attribute')) {
                return COLUMNS[`${params?.[0]}.${params?.[1]}`] ?? [];
            }
            return [
                { table_schema: 'public', table_name: 'orders', rel_kind: 'table' },
                { table_schema: 'public', table_name: 'customers', rel_kind: 'table' },
                { table_schema: 'sales', table_name: 'invoices', rel_kind: 'view' }
            ];
        }
    };
    return { source, queries };
}

/** Suggestions at the `|` in `marked`. */
async function suggest(marked: string, cache = new CompletionCatalogCache(fakeSource().source), addTableAlias = false) {
    const offset = marked.indexOf('|');
    const text = marked.slice(0, offset) + marked.slice(offset + 1);
    return sqlFileSuggestions(api, cache, WORDS, text, offset, quote, addTableAlias);
}

/** The text a table suggestion inserts at the `|`, with the table alias option on. */
async function insertedTable(marked: string, table: string, cache?: CompletionCatalogCache) {
    const items = await suggest(marked, cache, true);
    return items!.find((i) => i.label === table)!.insertText;
}

const labels = (items: any[] | null, kind?: string) =>
    (items || []).filter((i) => !kind || i.kind === kind).map((i) => i.label);

// ===== loadSqlCompletionApi =====

test('loadSqlCompletionApi loads the very helpers the Data Viewer query bar uses', () => {
    const webview = require(path.join(EXTENSION_PATH, 'src', 'webview', 'queryEditor.js'));
    assert.equal(api.buildSuggestions, webview.buildSuggestions);
    assert.equal(api.completionContext, webview.completionContext);
});

// ===== completionScope =====

/** The scope at the `|` in `marked`. */
function scopeAt(marked: string) {
    const offset = marked.indexOf('|');
    return completionScope(api, marked.slice(0, offset) + marked.slice(offset + 1), offset);
}

test('completionScope takes the statement between the semicolons around the cursor', () => {
    const scope = scopeAt('SELECT 1 FROM a;\nSELECT o.| FROM orders o;\nSELECT 2 FROM b;');
    assert.equal(scope!.statement, '\nSELECT o. FROM orders o');
    assert.equal(scope!.before, '\nSELECT o.');
});

test('completionScope runs to the end of the file after the last semicolon', () => {
    const scope = scopeAt('SELECT 1;\nSELECT * FROM |');
    assert.equal(scope!.statement, '\nSELECT * FROM ');
});

test('completionScope ignores semicolons in strings and comments', () => {
    const scope = scopeAt("SELECT ';' AS x, -- ;\n| FROM t");
    assert.equal(scope!.statement, "SELECT ';' AS x, -- ;\n FROM t");
});

test('completionScope steps into the function body that holds the cursor', () => {
    const scope = scopeAt([
        'CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$',
        'DECLARE v int;',
        'BEGIN',
        '  SELECT c.| INTO v FROM customers c;',
        '  DELETE FROM orders;',
        'END;',
        '$$;'
    ].join('\n'));
    // BEGIN ends with no semicolon, so it opens the first statement of the block.
    assert.equal(scope!.statement, '\nBEGIN\n  SELECT c. INTO v FROM customers c');
    assert.equal(scope!.before, '\nBEGIN\n  SELECT c.');
});

test('completionScope works in a body that is still being typed', () => {
    const scope = scopeAt('CREATE FUNCTION f() RETURNS void AS $fn$\nBEGIN\n  PERFORM 1 FROM orders o WHERE o.|');
    assert.equal(scope!.before, '\nBEGIN\n  PERFORM 1 FROM orders o WHERE o.');
});

test('completionScope steps into an empty body and into nested dollar quotes', () => {
    assert.equal(scopeAt('CREATE FUNCTION f() RETURNS int AS $$|$$ LANGUAGE sql;')!.statement, '');
    const nested = scopeAt("DO $do$ BEGIN EXECUTE $q$ SELECT | FROM orders $q$; END $do$;");
    assert.equal(nested!.statement, ' SELECT  FROM orders ');
});

test('completionScope offers nothing inside a dollar-quoted text', () => {
    assert.equal(scopeAt('SELECT $$hello |world$$;'), null);
});

// ===== sqlFileSuggestions =====

test('sqlFileSuggestions offers the columns of an alias in the current statement', async () => {
    const items = await suggest('SELECT 1 FROM sales.invoices;\nSELECT o.| FROM orders o;');
    assert.deepEqual(labels(items), ['id', 'customer_id']);
    assert.equal(items![0].kind, 'column');
    assert.equal(items![0].detail, 'integer — public.orders');
});

test('sqlFileSuggestions offers tables, views and schemas after FROM', async () => {
    const items = await suggest('SELECT * FROM |');
    assert.deepEqual(labels(items, 'table'), ['orders', 'customers']);
    assert.deepEqual(labels(items, 'view'), ['invoices']);
    assert.deepEqual(labels(items, 'schema'), ['public', 'sales']);
    const invoices = items!.find((i) => i.label === 'invoices')!;
    assert.equal(invoices.insertText, 'sales.invoices', 'a table off the search_path is inserted with its schema');
});

test('sqlFileSuggestions offers only the tables of the statement the cursor is in', async () => {
    const items = await suggest('SELECT * FROM sales.invoices i;\nSELECT | FROM customers c;');
    const columns = labels(items, 'column');
    assert.deepEqual(columns, ['id', 'name']);
    assert.ok(!labels(items, 'alias').includes('i'), 'an alias of another statement is not offered');
    assert.deepEqual(labels(items, 'alias'), ['c']);
    assert.ok(labels(items, 'function').includes('coalesce'));
    assert.ok(labels(items, 'keyword').includes('SELECT'));
});

test('sqlFileSuggestions completes inside a PL/pgSQL function body', async () => {
    const items = await suggest('CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n  UPDATE customers c SET name = 1 WHERE c.|;\nEND;\n$$;');
    assert.deepEqual(labels(items), ['id', 'name']);
});

test('sqlFileSuggestions offers the relations of a schema after its name', async () => {
    const items = await suggest('SELECT * FROM sales.|');
    assert.deepEqual(labels(items), ['invoices']);
});

test('sqlFileSuggestions offers nothing inside a comment, a string or a quoted name', async () => {
    assert.equal(await suggest('SELECT 1 -- FROM |'), null);
    assert.equal(await suggest("SELECT 'FROM |"), null);
    assert.equal(await suggest('SELECT "Ord|'), null);
});

test('sqlFileSuggestions offers keywords and functions without a connection, and never asks the database', async () => {
    const { source, queries } = fakeSource({ connected: false });
    const items = await suggest('SELECT * FROM orders o WHERE |', new CompletionCatalogCache(source));
    assert.deepEqual(labels(items, 'column'), []);
    assert.ok(labels(items, 'keyword').includes('WHERE'));
    assert.deepEqual(queries, []);
});

// ===== Table alias on completion =====

test('a table completed after FROM brings the alias of its first column', async () => {
    assert.equal(await insertedTable('SELECT * FROM |', 'orders'), 'orders ord');
    assert.equal(await insertedTable('SELECT * FROM |', 'invoices'), 'sales.invoices inv', 'after a qualified name too');
});

test('a table completed after JOIN or a comma in the FROM list brings its alias', async () => {
    assert.equal(await insertedTable('SELECT * FROM customers c JOIN |', 'orders'), 'orders ord');
    assert.equal(await insertedTable('SELECT * FROM customers c LEFT OUTER JOIN |', 'orders'), 'orders ord');
    assert.equal(await insertedTable('SELECT * FROM customers c, |', 'orders'), 'orders ord');
    assert.equal(await insertedTable('SELECT * FROM ONLY |', 'orders'), 'orders ord');
});

test('a table completed after its schema brings its alias', async () => {
    assert.equal(await insertedTable('SELECT * FROM sales.|', 'invoices'), 'invoices inv');
});

test('the half-typed table name does not count as a name the statement already uses', async () => {
    assert.equal(await insertedTable('SELECT * FROM ord|', 'orders'), 'orders ord');
});

test('an alias the statement already uses is numbered', async () => {
    assert.equal(await insertedTable('SELECT * FROM orders ord JOIN |', 'orders'), 'orders ord2');
    assert.equal(await insertedTable('SELECT * FROM orders ord JOIN orders ord2 ON true JOIN |', 'orders'), 'orders ord3');
    assert.equal(await insertedTable('SELECT * FROM ord JOIN |', 'orders'), 'orders ord2', 'a table named like the alias counts too');
});

test('no alias where the table already has one or is followed by a dot or a parenthesis', async () => {
    assert.equal(await insertedTable('SELECT * FROM ord| o WHERE o.id = 1', 'orders'), 'orders');
    assert.equal(await insertedTable('SELECT * FROM ord| AS o', 'orders'), 'orders');
    assert.equal(await insertedTable('SELECT * FROM ord|.x', 'orders'), 'orders');
    assert.equal(await insertedTable('SELECT * FROM ord|\nWHERE id = 1', 'orders'), 'orders ord', 'a clause keyword is no alias');
    assert.equal(await insertedTable('SELECT * FROM ord|ers JOIN customers c ON true', 'orders'), 'orders ord', 'the rest of the word is replaced');
});

test('no alias outside FROM and JOIN', async () => {
    assert.equal(await insertedTable('UPDATE |', 'orders'), 'orders');
    assert.equal(await insertedTable('INSERT INTO |', 'orders'), 'orders');
    assert.equal(await insertedTable('TRUNCATE TABLE |', 'orders'), 'orders');
});

test('no alias where it would only repeat the table name', async () => {
    assert.equal(await insertedTable('SELECT * FROM |', 'customers'), 'customers');
});

test('no alias with the option turned off', async () => {
    const items = await suggest('SELECT * FROM |');
    assert.equal(items!.find((i) => i.label === 'orders')!.insertText, 'orders');
});

test('the alias saved for a table when dragging it into an editor wins', async () => {
    const cache = new CompletionCatalogCache(fakeSource().source, {
        savedAlias: (schema, table) => (schema === 'public' && table === 'customers' ? 'kd' : undefined)
    });
    assert.equal(await insertedTable('SELECT * FROM |', 'customers', cache), 'customers kd');
    assert.equal(await insertedTable('SELECT * FROM |', 'orders', cache), 'orders ord');
});

test('an alias inside a function body is numbered against that statement only', async () => {
    const text = 'SELECT * FROM orders ord;\nCREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n  PERFORM 1 FROM |;\nEND;\n$$;';
    assert.equal(await insertedTable(text, 'orders'), 'orders ord');
});

test('completionTableAlias follows the alias rule of the rest of the extension', () => {
    assert.equal(completionTableAlias('public', 'mitarbeiter_tag', 'mtd_id'), 'mtd');
    assert.equal(completionTableAlias('public', 'users', 'id'), undefined, 'the rule would only repeat the table name');
    assert.equal(completionTableAlias('public', 'users', null), undefined);
    assert.equal(completionTableAlias('public', 'users', 'id', () => 'u'), 'u');
    assert.equal(completionTableAlias('public', 'users', 'usr_id', () => undefined), 'usr');
});

test('loadCompletionCatalog still lists the relations when their first columns cannot be read', async () => {
    const { source } = fakeSource();
    const failing: CatalogSource = {
        isConnected: () => true,
        queryMetadata: (sql, params) => (sql.includes('first_column') ? Promise.reject(new Error('denied')) : source.queryMetadata(sql, params))
    };
    const catalog = await loadCompletionCatalog(failing);
    assert.deepEqual(catalog.relations.map((r) => [r.name, r.alias]), [
        ['orders', undefined], ['customers', undefined], ['invoices', undefined]
    ]);
});

// ===== CompletionCatalogCache =====

test('CompletionCatalogCache keeps the catalog and columns for a minute', async () => {
    let now = 1000;
    const { source, queries } = fakeSource();
    const cache = new CompletionCatalogCache(source, { ttlMs: 60000, now: () => now });
    await cache.getCatalog();
    await cache.loadColumns([{ schema: 'public', table: 'orders' }]);
    await cache.loadColumns([{ schema: 'public', table: 'orders' }]);
    now += 59000;
    await cache.getCatalog();
    assert.equal(queries.length, 5, 'four catalog queries and one column query');
    assert.deepEqual(cache.columnsOf('public', 'orders')!.map((c) => c.name), ['id', 'customer_id']);

    now += 2000;
    await cache.getCatalog();
    assert.equal(queries.length, 9, 'the catalog is read again after a minute');
    assert.equal(cache.columnsOf('public', 'orders'), undefined, 'and the columns with it');
});

test('CompletionCatalogCache starts over when cleared, e.g. on a connection change', async () => {
    const { source, queries } = fakeSource();
    const cache = new CompletionCatalogCache(source);
    await cache.getCatalog();
    cache.clear();
    await cache.getCatalog();
    assert.equal(queries.length, 8);
});

test('CompletionCatalogCache drops what it knows as soon as the connection is gone, even without a change event', async () => {
    const state = { connected: true };
    const { source, queries } = fakeSource(state);
    const cache = new CompletionCatalogCache(source);
    assert.equal((await cache.getCatalog()).relations.length, 3);
    await cache.loadColumns([{ schema: 'public', table: 'orders' }]);
    assert.ok(cache.columnsOf('public', 'orders'));

    state.connected = false;
    assert.equal(cache.columnsOf('public', 'orders'), undefined, 'no stale columns while disconnected');
    assert.deepEqual(await cache.getCatalog(), { schemas: [], relations: [], searchPath: [] }, 'no stale catalog within the minute');

    // Back online, everything is read anew instead of coming from the old connection.
    state.connected = true;
    const asked = queries.length;
    await cache.getCatalog();
    assert.equal(queries.length, asked + 4);
    assert.equal(cache.columnsOf('public', 'orders'), undefined, 'the old columns were dropped');
});

test('CompletionCatalogCache keeps no empty columns from a lookup made while disconnected', async () => {
    const state = { connected: false };
    const { source } = fakeSource(state);
    const cache = new CompletionCatalogCache(source);
    await cache.loadColumns([{ schema: 'public', table: 'orders' }]);
    state.connected = true;
    await cache.loadColumns([{ schema: 'public', table: 'orders' }]);
    assert.deepEqual(cache.columnsOf('public', 'orders')!.map((c) => c.name), ['id', 'customer_id']);
});

test('sqlFileSuggestions offers no tables or columns of a connection that dropped silently', async () => {
    const state = { connected: true };
    const cache = new CompletionCatalogCache(fakeSource(state).source);
    assert.deepEqual(labels(await suggest('SELECT o.| FROM orders o', cache)), ['id', 'customer_id']);
    state.connected = false;
    assert.deepEqual(labels(await suggest('SELECT o.| FROM orders o', cache)), []);
    const from = await suggest('SELECT * FROM |', cache);
    assert.deepEqual(labels(from, 'table'), []);
    assert.ok(labels(from, 'keyword').length > 0, 'keywords are still offered');
});

test('CompletionCatalogCache answers a failing lookup with nothing instead of an error', async () => {
    const cache = new CompletionCatalogCache(fakeSource({ fail: true }).source);
    assert.deepEqual(await cache.getCatalog(), { schemas: [], relations: [], searchPath: [] });
    await cache.loadColumns([{ schema: 'public', table: 'orders' }]);
    assert.equal(cache.columnsOf('public', 'orders'), undefined);
});

// ===== loadSqlWords / quoteCompletionIdentifier =====

test('loadSqlWords reads the grammar words the build writes', () => {
    const words = loadSqlWords(EXTENSION_PATH, api, () => JSON.stringify({
        keywords: ['select', 'FROM'], operators: ['AND'], builtinFunctions: ['NOW', 'coalesce', 'now']
    }));
    assert.ok(words.keywords.includes('SELECT') && words.keywords.includes('AND') && words.keywords.includes('FROM'));
    assert.deepEqual(words.functions, ['coalesce', 'now']);
});

test('loadSqlWords falls back to the clause keywords when the file was not built', () => {
    const words = loadSqlWords(EXTENSION_PATH, api, () => { throw new Error('ENOENT'); });
    assert.ok(words.keywords.includes('JOIN'));
    assert.deepEqual(words.functions, []);
});

test('quoteCompletionIdentifier quotes like the Data Viewer', () => {
    assert.equal(quoteCompletionIdentifier('orders', false), 'orders');
    assert.equal(quoteCompletionIdentifier('Orders', false), '"Orders"');
    assert.equal(quoteCompletionIdentifier('user', false), '"user"');
    assert.equal(quoteCompletionIdentifier('my"col', false), '"my""col"');
    assert.equal(quoteCompletionIdentifier('orders', true), '"orders"');
});

// ===== SqlFileCompletionProvider =====

/** A minimal text document over `text`, enough for the provider. */
function fakeDocument(text: string) {
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
    const positionAt = (offset: number) => {
        let line = 0;
        while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) line++;
        return new vscodeStub.Position(line, offset - lineStarts[line]);
    };
    const offsetAt = (p: any) => lineStarts[p.line] + p.character;
    return {
        getText: () => text,
        offsetAt,
        positionAt,
        getWordRangeAtPosition: (p: any, re: RegExp) => {
            const offset = offsetAt(p);
            const lineStart = lineStarts[p.line];
            const lineEnd = p.line + 1 < lineStarts.length ? lineStarts[p.line + 1] - 1 : text.length;
            const line = text.slice(lineStart, lineEnd);
            const g = new RegExp(re.source, 'g');
            let m: RegExpExecArray | null;
            while ((m = g.exec(line))) {
                const s = lineStart + m.index, e = s + m[0].length;
                if (s <= offset && offset <= e) return new vscodeStub.Range(positionAt(s), positionAt(e));
            }
            return undefined;
        }
    };
}

async function provide(marked: string, config: Record<string, unknown> = {}, cancelled = false) {
    const offset = marked.indexOf('|');
    const doc = fakeDocument(marked.slice(0, offset) + marked.slice(offset + 1));
    const provider = new SqlFileCompletionProvider(api, new CompletionCatalogCache(fakeSource().source), WORDS);
    const original = vscodeStub.workspace.getConfiguration;
    vscodeStub.workspace.getConfiguration = () => ({ get: <T>(key: string, def?: T) => (key in config ? config[key] : def) as T });
    try {
        return await provider.provideCompletionItems(doc as any, doc.positionAt(offset) as any, { isCancellationRequested: cancelled } as any);
    } finally {
        vscodeStub.workspace.getConfiguration = original;
    }
}

test('SqlFileCompletionProvider turns the suggestions into VS Code items', async () => {
    const items = (await provide('SELECT c.na| FROM customers c'))!;
    const name = items.find((i) => i.label === 'name')!;
    assert.equal(name.kind, vscodeStub.CompletionItemKind.Field);
    assert.equal(name.insertText, 'name');
    assert.equal(name.detail, 'text — public.customers');
    // The typed word `na` is replaced.
    const range: any = name.range;
    assert.equal(range.inserting.start.character, 9);
    assert.equal(range.inserting.end.character, 11);
    assert.equal(range.replacing.end.character, 11);
});

test('SqlFileCompletionProvider inserts functions as snippets with the cursor between the parentheses', async () => {
    const items = (await provide('SELECT | FROM customers'))!;
    const fn: any = items.find((i) => i.label === 'coalesce')!;
    assert.equal(fn.kind, vscodeStub.CompletionItemKind.Function);
    assert.ok(fn.insertText instanceof vscodeStub.SnippetString);
    assert.equal(fn.insertText.value, 'coalesce($0)');
    assert.equal(items.find((i) => i.label === 'SELECT')!.kind, vscodeStub.CompletionItemKind.Keyword);
});

test('SqlFileCompletionProvider quotes every name when alwaysQuote is set', async () => {
    const items = (await provide('SELECT c.| FROM customers c', { alwaysQuote: true }))!;
    assert.equal(items.find((i) => i.label === 'name')!.insertText, '"name"');
});

test('SqlFileCompletionProvider is silent when turned off, cancelled or inside a comment', async () => {
    assert.equal(await provide('SELECT c.| FROM customers c', { 'completion.enable': false }), undefined);
    assert.equal(await provide('SELECT c.| FROM customers c', {}, true), undefined);
    assert.equal(await provide('-- SELECT c.| FROM customers c'), undefined);
});

test('SqlFileCompletionProvider writes the table alias by default and not when the setting is off', async () => {
    const on = (await provide('SELECT * FROM ord|'))!;
    assert.equal(on.find((i) => i.label === 'orders')!.insertText, 'orders ord');
    const off = (await provide('SELECT * FROM ord|', { 'completion.tableAlias': false }))!;
    assert.equal(off.find((i) => i.label === 'orders')!.insertText, 'orders');
});