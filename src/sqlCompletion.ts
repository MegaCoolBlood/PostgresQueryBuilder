import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { buildRelationListQuery } from './queryRunner';
import { POSTGRES_RESERVED_KEYWORDS } from './reservedKeywords';
import { Logger } from './logger';

/**
 * Autocomplete for SQL files. It is the autocomplete of the Data Viewer's query
 * bar: the parsing and the suggestions come from the same pure helpers in
 * `src/webview/queryEditor.js`, which the extension loads from disk at runtime
 * (that file ships with the extension), so both offer exactly the same items.
 * This module adds what a file needs on top: finding the statement around the
 * cursor — also inside a function body — and the catalog of the connection.
 */

/** What the autocomplete knows about the active connection. */
export interface CompletionCatalog {
    schemas: string[];
    relations: Array<{ schema: string; name: string; kind: string }>;
    searchPath: string[];
}

export interface CompletionColumn {
    name: string;
    type: string;
}

/** A table the statement reads or writes, as written. */
export interface TableReference {
    schema: string | null;
    table: string;
    alias: string | null;
}

export interface CompletionContext {
    kind: 'none' | 'member' | 'relation' | 'any';
    path?: string[];
    prefix?: string;
}

/** One suggestion as built by the shared helpers. */
export interface CompletionSuggestion {
    label: string;
    kind: 'column' | 'table' | 'view' | 'schema' | 'alias' | 'function' | 'keyword';
    insertText: string;
    detail?: string;
    sortText: string;
    isSnippet?: boolean;
}

interface SqlToken {
    type: string;
    text: string;
    start: number;
    end: number;
    closed?: boolean;
}

/** The pure helpers exported by `src/webview/queryEditor.js`. */
export interface SqlCompletionApi {
    tokenizeSql(text: string): SqlToken[];
    extractTableReferences(text: string): TableReference[];
    completionContext(textBefore: string): CompletionContext;
    tablesNeedingColumns(ctx: CompletionContext, refs: TableReference[], catalog: CompletionCatalog): Array<{ schema: string; table: string }>;
    buildSuggestions(ctx: CompletionContext, data: {
        catalog: CompletionCatalog;
        refs: TableReference[];
        columnsOf: (schema: string, table: string) => CompletionColumn[] | undefined;
        keywords: string[];
        functions: string[];
        quoteIdent: (name: string) => string;
    }): CompletionSuggestion[];
    completionKeywords(grammar: { keywords?: string[]; operators?: string[] }): string[];
}

/** Keyword and built-in function lists of the PostgreSQL grammar the query bar's editor uses. */
export interface SqlWords {
    keywords: string[];
    functions: string[];
}

/** Load the shared completion helpers from the extension's webview folder. */
export function loadSqlCompletionApi(extensionPath: string): SqlCompletionApi {
    return require(path.join(extensionPath, 'src', 'webview', 'queryEditor.js')) as SqlCompletionApi;
}

/**
 * The grammar's words, written to `dist/monaco/pgsql-words.json` by the build
 * from the same Monaco grammar the query bar highlights with. Without that file
 * the clause keywords of the shared helpers are offered and no functions.
 */
export function loadSqlWords(extensionPath: string, api: SqlCompletionApi, readFile: (file: string) => string = (f) => fs.readFileSync(f, 'utf8')): SqlWords {
    let grammar: { keywords?: string[]; operators?: string[]; builtinFunctions?: string[] } = {};
    try {
        grammar = JSON.parse(readFile(path.join(extensionPath, 'dist', 'monaco', 'pgsql-words.json')));
    } catch {
        // Not built: fall back to the clause keywords alone.
    }
    return {
        keywords: api.completionKeywords(grammar),
        functions: Array.from(new Set((grammar.builtinFunctions || []).map((f) => String(f).toLowerCase()))).sort()
    };
}

/** Quote a name the way the Data Viewer does: when it has to be, or always with `alwaysQuote`. */
export function quoteCompletionIdentifier(name: string, alwaysQuote: boolean): string {
    const needs = !/^[a-z_][a-z0-9_$]*$/.test(name) || POSTGRES_RESERVED_KEYWORDS.has(name.toLowerCase());
    return alwaysQuote || needs ? `"${name.replace(/"/g, '""')}"` : name;
}

// ===== Catalog ================================================================

/** The part of the connection manager the catalog needs. */
export interface CatalogSource {
    isConnected(): boolean;
    queryMetadata(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
}

/** Schemas, relations and search_path of the active connection; empty when not connected. */
export async function loadCompletionCatalog(source: CatalogSource): Promise<CompletionCatalog> {
    if (!source.isConnected()) {
        return { schemas: [], relations: [], searchPath: [] };
    }
    const [relations, schemas, searchPath] = await Promise.all([
        source.queryMetadata(buildRelationListQuery()),
        source.queryMetadata(
            `SELECT nspname FROM pg_catalog.pg_namespace
             WHERE nspname NOT IN ('pg_catalog', 'information_schema') AND nspname NOT LIKE 'pg\\_%'
             ORDER BY nspname`
        ),
        source.queryMetadata('SELECT unnest(current_schemas(false)) AS schema_name')
    ]);
    return {
        schemas: schemas.map((r) => String(r.nspname)),
        relations: relations.map((r) => ({ schema: String(r.table_schema), name: String(r.table_name), kind: String(r.rel_kind) })),
        searchPath: searchPath.map((r) => String(r.schema_name))
    };
}

/** Columns of one relation with their types, in table order; empty when not connected. */
export async function loadCompletionColumns(source: CatalogSource, schema: string, table: string): Promise<CompletionColumn[]> {
    if (!source.isConnected() || !schema || !table) {
        return [];
    }
    const rows = await source.queryMetadata(
        `SELECT a.attname AS column_name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type
         FROM pg_catalog.pg_attribute a
         JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum`,
        [schema, table]
    );
    return rows.map((r) => ({ name: String(r.column_name), type: String(r.data_type) }));
}

/**
 * The catalog and columns for SQL files, kept for a minute so typing does not
 * query the database on every key, and dropped when the connection changes.
 * Every lookup checks the connection first, so a connection that dropped
 * without a change event never serves stale names. A failed lookup is logged
 * and answered with nothing, never with an error.
 */
export class CompletionCatalogCache {
    private catalog: CompletionCatalog | null = null;
    private catalogAt = 0;
    private readonly columns = new Map<string, CompletionColumn[]>();

    constructor(
        private readonly source: CatalogSource,
        private readonly ttlMs = 60000,
        private readonly now: () => number = Date.now
    ) {}

    clear(): void {
        this.catalog = null;
        this.catalogAt = 0;
        this.columns.clear();
    }

    async getCatalog(): Promise<CompletionCatalog> {
        if (!this.source.isConnected()) {
            this.clear();
            return { schemas: [], relations: [], searchPath: [] };
        }
        if (this.catalog && this.now() - this.catalogAt <= this.ttlMs) {
            return this.catalog;
        }
        try {
            this.catalog = await loadCompletionCatalog(this.source);
            this.catalogAt = this.now();
            // Columns may have changed together with the relations.
            this.columns.clear();
        } catch (err: unknown) {
            Logger.error('CompletionCatalogCache.getCatalog', err);
            this.clear();
            return { schemas: [], relations: [], searchPath: [] };
        }
        return this.catalog;
    }

    async loadColumns(relations: Array<{ schema: string; table: string }>): Promise<void> {
        // Without a connection there is nothing to read, and an empty answer
        // must not be kept as the columns of the table.
        if (!this.source.isConnected()) {
            this.clear();
            return;
        }
        await Promise.all(relations.map(async (rel) => {
            const key = `${rel.schema}.${rel.table}`;
            if (this.columns.has(key)) return;
            try {
                this.columns.set(key, await loadCompletionColumns(this.source, rel.schema, rel.table));
            } catch (err: unknown) {
                Logger.error('CompletionCatalogCache.loadColumns', err);
            }
        }));
    }

    columnsOf(schema: string, table: string): CompletionColumn[] | undefined {
        if (!this.source.isConnected()) return undefined;
        return this.columns.get(`${schema}.${table}`);
    }
}

// ===== The statement around the cursor ========================================

const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;
// A dollar-quoted body counts as code (a function body, a DO block, an EXECUTE
// template) when it contains a statement word or is still empty.
const CODE_WORD = /\b(select|insert|update|delete|merge|with|begin|declare|perform|return|raise|if|loop|call|execute|values)\b/i;

/**
 * The statement the cursor at `offset` is in: the text between the `;` before
 * and after it, inside the innermost function body (or other dollar-quoted code)
 * that holds the cursor. `before` is the statement up to the cursor. Null when
 * the cursor is inside a dollar-quoted string that is plain text.
 */
export function completionScope(api: SqlCompletionApi, text: string, offset: number): { statement: string; before: string } | null {
    let scope = String(text ?? '');
    let cursor = Math.max(0, Math.min(scope.length, offset));
    for (;;) {
        const tokens = api.tokenizeSql(scope);
        const body = tokens.find((t) => {
            if (t.type !== 'string' || !t.text.startsWith('$')) return false;
            const tag = DOLLAR_TAG.exec(t.text);
            if (!tag) return false;
            const start = t.start + tag[0].length;
            const end = t.closed ? t.end - tag[0].length : t.end;
            return cursor >= start && cursor <= end;
        });
        if (!body) {
            let start = 0;
            let end = scope.length;
            for (const t of tokens) {
                if (t.type !== 'punct' || t.text !== ';') continue;
                if (t.end <= cursor) start = t.end;
                else if (t.start >= cursor) { end = t.start; break; }
            }
            return { statement: scope.slice(start, end), before: scope.slice(start, cursor) };
        }
        const tag = DOLLAR_TAG.exec(body.text)![0];
        const start = body.start + tag.length;
        const end = body.closed ? body.end - tag.length : body.end;
        const inner = scope.slice(start, end);
        if (inner.trim() !== '' && !CODE_WORD.test(inner)) return null;
        scope = inner;
        cursor -= start;
    }
}

/**
 * The suggestions for the cursor at `offset` in a SQL file — the same items the
 * Data Viewer's query bar offers for that statement. Null when nothing should
 * be suggested (inside a comment, a string or a quoted name).
 */
export async function sqlFileSuggestions(
    api: SqlCompletionApi,
    cache: CompletionCatalogCache,
    words: SqlWords,
    text: string,
    offset: number,
    quoteIdent: (name: string) => string
): Promise<CompletionSuggestion[] | null> {
    const scope = completionScope(api, text, offset);
    if (!scope) return null;
    const ctx = api.completionContext(scope.before);
    if (ctx.kind === 'none') return null;
    const catalog = await cache.getCatalog();
    const refs = api.extractTableReferences(scope.statement);
    await cache.loadColumns(api.tablesNeedingColumns(ctx, refs, catalog));
    return api.buildSuggestions(ctx, {
        catalog,
        refs,
        columnsOf: (schema, table) => cache.columnsOf(schema, table),
        keywords: words.keywords,
        functions: words.functions,
        quoteIdent
    });
}

// ===== VS Code provider ========================================================

const ITEM_KINDS: Record<CompletionSuggestion['kind'], vscode.CompletionItemKind> = {
    column: vscode.CompletionItemKind.Field,
    table: vscode.CompletionItemKind.Class,
    view: vscode.CompletionItemKind.Interface,
    schema: vscode.CompletionItemKind.Module,
    alias: vscode.CompletionItemKind.Variable,
    function: vscode.CompletionItemKind.Function,
    keyword: vscode.CompletionItemKind.Keyword
};

const WORD_PATTERN = /[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*/;

/** Autocomplete for SQL files: tables, columns, aliases, schemas, functions and keywords. */
export class SqlFileCompletionProvider implements vscode.CompletionItemProvider {
    constructor(
        private readonly api: SqlCompletionApi,
        private readonly cache: CompletionCatalogCache,
        private readonly words: SqlWords
    ) {}

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.CompletionItem[] | undefined> {
        const config = vscode.workspace.getConfiguration('postgresQueryBuilder');
        if (!config.get<boolean>('completion.enable', true)) return undefined;
        const alwaysQuote = config.get<boolean>('alwaysQuote', false);
        const items = await sqlFileSuggestions(
            this.api, this.cache, this.words,
            document.getText(), document.offsetAt(position),
            (name) => quoteCompletionIdentifier(name, alwaysQuote)
        );
        if (!items || token.isCancellationRequested) return undefined;

        const word = document.getWordRangeAtPosition(position, WORD_PATTERN);
        const range = word
            ? { inserting: new vscode.Range(word.start, position), replacing: word }
            : undefined;
        return items.map((item) => {
            const ci = new vscode.CompletionItem(item.label, ITEM_KINDS[item.kind] ?? vscode.CompletionItemKind.Text);
            ci.insertText = item.isSnippet ? new vscode.SnippetString(item.insertText) : item.insertText;
            ci.detail = item.detail;
            ci.sortText = item.sortText;
            if (range) ci.range = range;
            return ci;
        });
    }
}
