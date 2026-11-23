/**
 * The graphical Query Builder panel: a diagram of tables and joins, a column
 * grid and the SQL text, all views of one {@link QueryModel}.
 *
 * The model lives here, on the extension host. The webview
 * (`src/webview/queryBuilder.js`) renders the model it receives and posts the
 * user's intents; the host applies the pure edit helpers of
 * `queryBuilderModel.ts`, keeps the undo/redo history, regenerates the SQL and
 * posts the new state back. SQL typed by the user is read back into a model
 * with the PostgreSQL parser; a syntax error keeps the previous diagram.
 *
 * A builder opened from a Data Viewer or from a SELECT in a SQL file has a
 * {@link QueryBuilderTarget}: *Apply* writes the query back there.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    QB_AGGREGATES,
    addColumn,
    addTable,
    connectColumns,
    createEmptyModel,
    generateSql,
    moveColumn,
    moveTable,
    removeColumn,
    removeJoin,
    removeTable,
    resolveColumnTables,
    setCriteria,
    setSort,
    setTableAlias,
    toggleColumn,
    tokenizeSql,
    updateColumn,
    updateJoin,
    type QbAggregate,
    type QbColumn,
    type QbCte,
    type QbJoin,
    type QbJoinPair,
    type QbJoinType,
    type QbTable,
    type QueryModel
} from './queryBuilderModel';
import { parseSelect, SqlParseError } from './queryBuilderParser';
import { listColumns, listForeignKeys, mappingJoinEdges, type CatalogQueryFn, type QbCatalogColumn } from './queryBuilderCatalog';
import type { CustomColumnMapping } from './columnMappingManager';
import { queryVariableNames, selectStatementForEditing } from './selectStatementExtractor';
import { buildHtmlDocument, getNonce } from './webviewUtils';
import { icon } from './webviewAssets';
import { buildDataViewerCsp, queryEditorAssets } from './tableWebView';
import { getErrorMessage, Logger } from './logger';

/** How many rows the Results tab shows. */
export const QB_PREVIEW_ROWS = 100;
/** How many steps Undo can go back. */
export const QB_HISTORY_LIMIT = 100;

// ===== Undo / redo ============================================================

function sameModel(a: QueryModel, b: QueryModel): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/** The current model with its undo and redo stacks. */
export class ModelHistory {
    private undoStack: QueryModel[] = [];
    private redoStack: QueryModel[] = [];

    constructor(private model: QueryModel, private readonly limit = QB_HISTORY_LIMIT) {}

    get current(): QueryModel {
        return this.model;
    }

    get canUndo(): boolean {
        return this.undoStack.length > 0;
    }

    get canRedo(): boolean {
        return this.redoStack.length > 0;
    }

    /** Make `next` current as one undo step; false (and nothing recorded) when it changes nothing. */
    commit(next: QueryModel): boolean {
        if (sameModel(next, this.model)) return false;
        this.undoStack.push(this.model);
        if (this.undoStack.length > this.limit) this.undoStack.shift();
        this.redoStack = [];
        this.model = next;
        return true;
    }

    /** Make `next` current without an undo step (e.g. the first placement of new tables). */
    replace(next: QueryModel): void {
        this.model = next;
    }

    undo(): boolean {
        const previous = this.undoStack.pop();
        if (!previous) return false;
        this.redoStack.push(this.model);
        this.model = previous;
        return true;
    }

    redo(): boolean {
        const next = this.redoStack.pop();
        if (!next) return false;
        this.undoStack.push(this.model);
        this.model = next;
        return true;
    }
}

// ===== Intents that only change the model =====================================

/** A model change the webview asked for that cannot be made; the message is shown to the user. */
export class QbIntentError extends Error {}

type Message = Record<string, unknown>;

function text(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function finite(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function textList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function tableOf(model: QueryModel, id: unknown): QbTable {
    const table = model.tables.find((t) => t.id === id);
    if (!table) throw new QbIntentError('That table is no longer part of the query.');
    return table;
}

function columnOf(model: QueryModel, id: unknown): QbColumn {
    const column = model.columns.find((c) => c.id === id);
    if (!column) throw new QbIntentError('That column is no longer part of the query.');
    return column;
}

function joinOf(model: QueryModel, id: unknown): QbJoin {
    const join = model.joins.find((j) => j.id === id);
    if (!join) throw new QbIntentError('That join is no longer part of the query.');
    return join;
}

const JOIN_TYPES: readonly QbJoinType[] = ['INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS'];

function identifierName(token: { type: string; text: string }): string | undefined {
    if (token.type === 'word') return token.text.toLowerCase();
    if (token.type === 'qident' && token.text.startsWith('"')) return token.text.slice(1, -1).replace(/""/g, '"');
    return undefined;
}

/**
 * The table column an expression names, when it is a plain `qualifier.column`
 * of a table of the model — so a typed `c.name` is ticked in the diagram.
 */
export function bindExpression(model: QueryModel, expression: string): { tableId: string; column: string } | undefined {
    const tokens = tokenizeSql(expression).filter((t) => t.type !== 'comment');
    if (tokens.length !== 3 || tokens[1].text !== '.') return undefined;
    const qualifier = identifierName(tokens[0]);
    const column = identifierName(tokens[2]);
    if (!qualifier || !column) return undefined;
    const owners = model.tables.filter((t) => (t.alias ?? t.name ?? '').toLowerCase() === qualifier.toLowerCase() || (t.alias ?? t.name) === qualifier);
    return owners.length === 1 ? { tableId: owners[0].id, column } : undefined;
}

function aliasTaken(model: QueryModel, tableId: string, alias: string): boolean {
    return model.tables.some((t) => t.id !== tableId && (t.alias ?? t.name ?? '').toLowerCase() === alias.toLowerCase());
}

function editTable(model: QueryModel, msg: Message): QueryModel {
    const table = tableOf(model, msg.tableId);
    let next = model;
    const alias = text(msg.alias);
    if (alias !== undefined && alias.trim() !== (table.alias ?? '')) {
        const trimmed = alias.trim();
        if (!trimmed && table.kind !== 'relation') throw new QbIntentError('A subquery or function in FROM needs an alias.');
        if (trimmed && aliasTaken(model, table.id, trimmed)) throw new QbIntentError(`Another table already uses the alias "${trimmed}".`);
        next = setTableAlias(next, table.id, trimmed || undefined);
    }
    const sql = text(msg.sql);
    if (sql !== undefined && table.kind !== 'relation' && sql.trim() !== (table.sql ?? '').trim()) {
        if (!sql.trim()) throw new QbIntentError('The SQL of a subquery or function cannot be empty.');
        next = JSON.parse(JSON.stringify(next)) as QueryModel;
        const edited = next.tables.find((t) => t.id === table.id) as QbTable;
        edited.sql = sql.trim();
    }
    return next;
}

function placeTables(model: QueryModel, msg: Message): QueryModel {
    const positions = Array.isArray(msg.positions) ? msg.positions : [];
    let next = model;
    for (const entry of positions) {
        if (!entry || typeof entry !== 'object') continue;
        const p = entry as Message;
        const x = finite(p.x);
        const y = finite(p.y);
        if (x === undefined || y === undefined || !model.tables.some((t) => t.id === p.tableId)) continue;
        next = moveTable(next, String(p.tableId), Math.max(0, Math.round(x)), Math.max(0, Math.round(y)));
    }
    return next;
}

function joinPairs(value: unknown): QbJoinPair[] {
    if (!Array.isArray(value)) throw new QbIntentError('The join columns are missing.');
    const pairs: QbJoinPair[] = [];
    for (const entry of value) {
        if (!entry || typeof entry !== 'object') continue;
        const p = entry as Message;
        const leftColumn = text(p.leftColumn);
        const rightColumn = text(p.rightColumn);
        if (!leftColumn || !rightColumn) continue;
        const operator = text(p.operator)?.trim();
        pairs.push(operator && operator !== '=' ? { leftColumn, rightColumn, operator } : { leftColumn, rightColumn });
    }
    return pairs;
}

function editJoin(model: QueryModel, msg: Message): QueryModel {
    const join = joinOf(model, msg.joinId);
    const patch: Partial<Omit<QbJoin, 'id'>> = {};
    if (msg.type !== undefined) {
        const type = text(msg.type)?.toUpperCase() as QbJoinType | undefined;
        if (!type || !JOIN_TYPES.includes(type)) throw new QbIntentError(`Unknown join type: ${String(msg.type)}`);
        patch.type = type;
    }
    if (msg.pairs !== undefined) {
        patch.pairs = joinPairs(msg.pairs);
        // A NATURAL join ignores its pairs, so edited pairs end it.
        patch.natural = undefined;
        if (!patch.pairs.every((p) => p.leftColumn === p.rightColumn && !p.operator)) patch.using = undefined;
    }
    if (msg.condition !== undefined) {
        const condition = (text(msg.condition) ?? '').trim();
        patch.condition = condition || undefined;
        if (condition) patch.natural = undefined;
    }
    return updateJoin(model, join.id, patch);
}

function editColumn(model: QueryModel, msg: Message): QueryModel {
    const column = columnOf(model, msg.columnId);
    const raw = msg.patch && typeof msg.patch === 'object' ? (msg.patch as Message) : {};
    const patch: Partial<Omit<QbColumn, 'id'>> = {};
    if ('expression' in raw) {
        const expression = (text(raw.expression) ?? '').trim();
        if (!expression) throw new QbIntentError('The expression cannot be empty; delete the row instead.');
        if (expression !== column.expression) {
            patch.expression = expression;
            const bound = bindExpression(model, expression);
            patch.tableId = bound?.tableId;
            patch.column = bound?.column;
        }
    }
    if ('alias' in raw) patch.alias = (text(raw.alias) ?? '').trim() || undefined;
    if ('output' in raw) patch.output = raw.output === true;
    if ('groupBy' in raw) patch.groupBy = raw.groupBy === true;
    if ('having' in raw) patch.having = (text(raw.having) ?? '').trim() || undefined;
    if ('aggregate' in raw) {
        const aggregate = (text(raw.aggregate) ?? '').toUpperCase();
        if (aggregate && !(QB_AGGREGATES as readonly string[]).includes(aggregate)) throw new QbIntentError(`Unknown aggregate: ${aggregate}`);
        patch.aggregate = (aggregate || undefined) as QbAggregate | undefined;
    }
    return updateColumn(model, column.id, patch);
}

function sortColumn(model: QueryModel, msg: Message): QueryModel {
    const column = columnOf(model, msg.columnId);
    const sortType = (text(msg.sortType) ?? '').toUpperCase();
    if (sortType && sortType !== 'ASC' && sortType !== 'DESC') throw new QbIntentError(`Unknown sort type: ${sortType}`);
    const order = finite(msg.sortOrder);
    const nulls = (text(msg.nulls) ?? '').toUpperCase();
    return setSort(
        model,
        column.id,
        (sortType || undefined) as 'ASC' | 'DESC' | undefined,
        order !== undefined && order >= 1 ? Math.trunc(order) : undefined,
        nulls === 'FIRST' || nulls === 'LAST' ? nulls : undefined
    );
}

function rawParts(model: QueryModel, msg: Message): QueryModel {
    const next = JSON.parse(JSON.stringify(model)) as QueryModel;
    if (msg.ctes !== undefined) {
        const ctes: QbCte[] = [];
        const names = new Set<string>();
        for (const entry of Array.isArray(msg.ctes) ? msg.ctes : []) {
            if (!entry || typeof entry !== 'object') continue;
            const e = entry as Message;
            const name = (text(e.name) ?? '').trim();
            const sql = (text(e.sql) ?? '').trim();
            if (!name && !sql) continue;
            if (!name) throw new QbIntentError('Every WITH query needs a name.');
            if (!sql) throw new QbIntentError(`The WITH query "${name}" has no SQL.`);
            if (names.has(name.toLowerCase())) throw new QbIntentError(`The name "${name}" is used by two WITH queries.`);
            names.add(name.toLowerCase());
            const index = finite(e.index);
            const original = index !== undefined ? model.ctes[index] : undefined;
            const cte: QbCte = { ...(original ?? {}), name, sql };
            if (original && original.sql.trim() !== sql) delete cte.columns;
            ctes.push(cte);
        }
        next.ctes = ctes;
        if (ctes.length === 0) delete next.recursive;
    }
    if (msg.whereExtra !== undefined) {
        const items = textList(msg.whereExtra).map((s) => s.trim()).filter((s) => s);
        if (items.length) next.whereExtra = items;
        else delete next.whereExtra;
    }
    if (msg.havingExtra !== undefined) {
        const items = textList(msg.havingExtra).map((s) => s.trim()).filter((s) => s);
        if (items.length) next.havingExtra = items;
        else delete next.havingExtra;
    }
    return next;
}

/**
 * Every webview intent that is a pure model change, mapped to its reducer.
 * A reducer returns the new model or throws {@link QbIntentError}.
 */
export const MODEL_INTENTS: Readonly<Record<string, (model: QueryModel, msg: Message) => QueryModel>> = {
    removeTable: (m, msg) => removeTable(m, tableOf(m, msg.tableId).id),
    moveTable: (m, msg) => placeTables(m, { positions: [{ tableId: msg.tableId, x: msg.x, y: msg.y }] }),
    placeTables,
    editTable,
    toggleColumn: (m, msg) => {
        const table = tableOf(m, msg.tableId);
        const column = text(msg.column);
        if (!column) throw new QbIntentError('No column was given.');
        return toggleColumn(m, table.id, column, typeof msg.output === 'boolean' ? msg.output : undefined);
    },
    setAllColumns: (m, msg) => {
        const table = tableOf(m, msg.tableId);
        const output = msg.output === true;
        return textList(msg.columns).reduce((model, column) => toggleColumn(model, table.id, column, output), m);
    },
    connectColumns: (m, msg) => {
        const left = tableOf(m, msg.leftTableId);
        const right = tableOf(m, msg.rightTableId);
        const leftColumn = text(msg.leftColumn);
        const rightColumn = text(msg.rightColumn);
        if (left.id === right.id) throw new QbIntentError('A join needs two different tables.');
        if (!leftColumn || !rightColumn) throw new QbIntentError('No column was given.');
        return connectColumns(m, left.id, leftColumn, right.id, rightColumn);
    },
    updateJoin: editJoin,
    removeJoin: (m, msg) => removeJoin(m, joinOf(m, msg.joinId).id),
    addExpression: (m, msg) => {
        const expression = (text(msg.expression) ?? '').trim();
        if (!expression) throw new QbIntentError('Enter an expression first.');
        const bound = bindExpression(m, expression);
        return addColumn(m, bound ? { expression, ...bound } : { expression }).model;
    },
    updateColumn: editColumn,
    removeColumn: (m, msg) => removeColumn(m, columnOf(m, msg.columnId).id),
    moveColumn: (m, msg) => {
        const index = finite(msg.toIndex);
        if (index === undefined) throw new QbIntentError('No position was given.');
        return moveColumn(m, columnOf(m, msg.columnId).id, index);
    },
    setSort: sortColumn,
    setCriteria: (m, msg) => {
        const row = finite(msg.row);
        if (row === undefined || row < 0) throw new QbIntentError('No criteria row was given.');
        return setCriteria(m, columnOf(m, msg.columnId).id, Math.trunc(row), text(msg.text) ?? '');
    },
    setDistinct: (m, msg) => {
        const next = JSON.parse(JSON.stringify(m)) as QueryModel;
        next.distinct = msg.distinct === true;
        if (!next.distinct) delete next.distinctOn;
        return next;
    },
    setRawParts: rawParts
};

// ===== Reading SQL back ======================================================

function sameRelation(a: QbTable, b: QbTable): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'relation') {
        return (a.name ?? '') === (b.name ?? '') && (a.schema === undefined || b.schema === undefined || a.schema === b.schema);
    }
    return (a.sql ?? '').trim() === (b.sql ?? '').trim();
}

/**
 * Keep the diagram positions when the SQL text is read into a new model: a
 * table keeps the place of the previous table with the same alias, else of
 * the previous one naming the same relation (or the same subquery text).
 */
export function carryOverPositions(previous: QueryModel, next: QueryModel): QueryModel {
    const result = JSON.parse(JSON.stringify(next)) as QueryModel;
    const placed = previous.tables.filter((t) => t.x !== undefined && t.y !== undefined);
    const used = new Set<string>();
    const take = (table: QbTable, match: QbTable | undefined): boolean => {
        if (!match) return false;
        used.add(match.id);
        table.x = match.x;
        table.y = match.y;
        return true;
    };
    const pending = result.tables.filter((t) => t.x === undefined || t.y === undefined);
    const rest: QbTable[] = [];
    for (const table of pending) {
        const alias = (table.alias ?? '').toLowerCase();
        const byAlias = alias ? placed.find((p) => !used.has(p.id) && (p.alias ?? '').toLowerCase() === alias && sameRelation(p, table)) : undefined;
        if (!take(table, byAlias)) rest.push(table);
    }
    for (const table of rest) {
        take(table, placed.find((p) => !used.has(p.id) && sameRelation(p, table)));
    }
    return result;
}

/** 1-based line and column of a 0-based offset. */
export function offsetToLineColumn(source: string, offset: number): { line: number; column: number } {
    const before = source.slice(0, Math.max(0, Math.min(offset, source.length)));
    const lines = before.split('\n');
    return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

// ===== Writing back into a SQL file ==========================================

/**
 * Where the statement the builder was opened on stands now: at the offset it
 * was read from, or — after edits above it — at its only other occurrence.
 * Anything else is refused, so Apply never overwrites code it did not read.
 */
export function locateApplyRange(currentText: string, expectedStart: number, originalText: string): { start: number; end: number } | { error: string } {
    if (currentText.slice(expectedStart, expectedStart + originalText.length) === originalText) {
        return { start: expectedStart, end: expectedStart + originalText.length };
    }
    const first = currentText.indexOf(originalText);
    if (first >= 0 && currentText.indexOf(originalText, first + 1) < 0) {
        return { start: first, end: first + originalText.length };
    }
    return {
        error: first < 0
            ? 'The SELECT statement was changed in the editor since the Query Builder was opened, so it cannot be replaced safely. Copy the SQL instead, or open the Query Builder on the statement again.'
            : 'The SELECT statement now occurs more than once in the file, so it is unclear which one to replace. Copy the SQL instead.'
    };
}

/** The whitespace that starts the line `offset` is on. */
export function lineIndentAt(source: string, offset: number): string {
    const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
    return /^[ \t]*/.exec(source.slice(lineStart))?.[0] ?? '';
}

/**
 * Indent every line after the first, so a statement written back into an
 * indented function body lines up. A string literal or quoted identifier
 * spanning lines would change its value, so such SQL is left as it is.
 */
export function indentContinuationLines(sql: string, indent: string): string {
    if (!indent) return sql;
    if (tokenizeSql(sql).some((t) => (t.type === 'string' || t.type === 'qident') && t.text.includes('\n'))) return sql;
    return sql.split('\n').map((line, i) => (i === 0 || line.trim() === '' ? line : indent + line)).join('\n');
}

/** What the Query Builder opens on for the SELECT at the cursor of a SQL file, or why it cannot. */
export interface EditorSelectSource {
    sql: string;
    start: number;
    end: number;
    /** Set when Apply must not write back; the reason is shown to the user. */
    readOnlyReason?: string;
}

export function selectSourceFromText(
    fullText: string,
    cursorOffset: number,
    selection?: { start: number; end: number }
): EditorSelectSource | undefined {
    const found = selectStatementForEditing(fullText, cursorOffset, selection);
    if (!found) return undefined;
    if (found.isUpdate) return undefined;
    if (found.hasInto) {
        return {
            ...found,
            readOnlyReason: 'The SELECT has an INTO clause, which the Query Builder cannot show. It opens without Apply; copy the SQL back by hand and keep the INTO.'
        };
    }
    return found;
}

// ===== Results preview =======================================================

export interface PreviewResult {
    columns: string[];
    rows: Array<Array<string | null>>;
    /** More rows exist than are shown. */
    truncated: boolean;
    durationMs: number;
}

/** The part of a pooled `pg` client the preview needs. */
export interface PreviewClient {
    query(config: string | { text: string; rowMode: 'array' }): Promise<{ rows: unknown[]; fields?: Array<{ name: string }> }>;
    release(err?: Error | boolean): void;
}

/** A result value as text for the Results tab; null stays null. */
export function formatPreviewValue(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
    if (Buffer.isBuffer(value)) return '\\x' + value.toString('hex');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

/**
 * Run `sql` in a read-only transaction through a cursor and fetch the first
 * `maxRows` rows; the transaction is always rolled back, so not even a
 * function with side effects can change data.
 */
export async function runPreviewQuery(connect: () => Promise<PreviewClient>, sql: string, maxRows = QB_PREVIEW_ROWS): Promise<PreviewResult> {
    const client = await connect();
    const started = Date.now();
    let broken: Error | undefined;
    try {
        await client.query('BEGIN READ ONLY');
        try {
            await client.query(`DECLARE qb_preview NO SCROLL CURSOR FOR\n${sql}`);
            const result = await client.query({ text: `FETCH ${maxRows + 1} FROM qb_preview`, rowMode: 'array' });
            const rows = (result.rows as unknown[][]).map((row) => row.map(formatPreviewValue));
            return {
                columns: (result.fields ?? []).map((f) => f.name),
                rows: rows.slice(0, maxRows),
                truncated: rows.length > maxRows,
                durationMs: Date.now() - started
            };
        } finally {
            await client.query('ROLLBACK').catch((err: unknown) => {
                broken = err instanceof Error ? err : new Error(String(err));
            });
        }
    } finally {
        client.release(broken);
    }
}

// ===== The panel =============================================================

/** Where *Apply* writes the query: the Data Viewer or SQL file the builder was opened from. */
export interface QueryBuilderTarget {
    /** Tooltip of the Apply button. */
    description: string;
    apply(sql: string): Promise<{ ok: boolean; message: string }>;
}

/** What the Query Builder needs from the rest of the extension. */
export interface QueryBuilderServices {
    extensionPath: string;
    ensureConnected(): Promise<boolean>;
    isConnected(): boolean;
    catalogQuery: CatalogQueryFn;
    /** The custom column mappings; they join tables like foreign keys. */
    mappings(): readonly CustomColumnMapping[];
    /** The tables last dragged from the Tables view, forgotten once taken. */
    takeDraggedTables(): Array<{ schema: string; name: string }>;
    onConnectionChanged(listener: () => void): vscode.Disposable;
    runPreview(sql: string): Promise<PreviewResult>;
    openInDataViewer(sql: string, title: string): Promise<void>;
    /**
     * Ask for the values of the placeholders and variables of `sql` (the View
     * Data form) and return the SQL with them filled in; undefined when the
     * user cancels. Without it the SQL runs as written.
     */
    askForVariables?(sql: string, actionLabel: string): Promise<string | undefined>;
    /** Answers the SQL editor's autocomplete and format requests (see queryEditor.js). */
    editorRequest(kind: string, message: Message): Promise<unknown>;
}

export interface QueryBuilderOpenOptions {
    /** SELECT to start from. */
    sql?: string;
    /** Relations to put on the canvas, joined along their foreign keys and custom mappings. */
    tables?: ReadonlyArray<{ schema: string; name: string }>;
    target?: QueryBuilderTarget;
    /** Panel title; derived from the first table when omitted. */
    title?: string;
}

/** The commands the webview posts that the panel handles besides {@link MODEL_INTENTS}. */
export const PANEL_COMMANDS = [
    'ready', 'requestDroppedTables', 'undo', 'redo', 'sqlEdited', 'runPreview', 'apply',
    'openInDataViewer', 'copySql', 'queryEditorRequest'
] as const;
type PanelCommand = typeof PANEL_COMMANDS[number];
/** Commands that may take long or never change the model; they do not block the queue. */
const CONCURRENT_COMMANDS: readonly PanelCommand[] = ['runPreview', 'apply', 'openInDataViewer', 'copySql', 'queryEditorRequest'];

/** The panel title: "Query Builder" plus the first relation of the query. */
export function builderTitle(model: QueryModel): string {
    const first = model.tables.find((t) => t.kind === 'relation' && t.name);
    return first ? `Query Builder: ${first.name}` : 'Query Builder';
}

/** Read one webview asset from `src/webview`. */
function readAsset(extensionPath: string, name: string): string {
    return fs.readFileSync(path.join(extensionPath, 'src', 'webview', name), 'utf8');
}

/** The webview document of the Query Builder. */
export function buildQueryBuilderHtml(
    webview: Pick<vscode.Webview, 'cspSource'> & Partial<Pick<vscode.Webview, 'asWebviewUri'>>,
    extensionPath: string,
    options: { applyTitle?: string }
): string {
    const assets = queryEditorAssets(
        extensionPath,
        typeof webview.asWebviewUri === 'function' ? (file) => (webview.asWebviewUri as (uri: vscode.Uri) => vscode.Uri)(vscode.Uri.file(file)).toString() : undefined
    );
    const config = {
        aggregates: QB_AGGREGATES,
        canApply: !!options.applyTitle,
        previewRows: QB_PREVIEW_ROWS
    };
    const script = [
        `window.QUERY_EDITOR_ASSETS = ${JSON.stringify(assets)};`,
        `window.QB_CONFIG = ${JSON.stringify(config).replace(/</g, '\\u003c')};`,
        readAsset(extensionPath, 'queryEditor.js'),
        readAsset(extensionPath, 'queryBuilder.js')
    ].join('\n');
    return buildHtmlDocument({
        webview: webview as vscode.Webview,
        nonce: getNonce(),
        csp: buildDataViewerCsp,
        title: 'Query Builder',
        styles: readAsset(extensionPath, 'queryBuilder.css'),
        body: queryBuilderBody(options.applyTitle),
        script
    });
}

function escapeAttribute(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function queryBuilderBody(applyTitle: string | undefined): string {
    const apply = applyTitle
        ? `<span class="toolbar-sep"></span>
            <div class="toolbar-group">
                <button class="btn btn-primary" data-action="apply" title="${escapeAttribute(applyTitle)}">${icon('check')}Apply</button>
            </div>`
        : '';
    return `
<div class="qb">
    <main class="qb-main">
        <div class="toolbar qb-toolbar">
            <div class="qb-tabs" role="tablist">
                <button class="btn btn-ghost qb-tab-btn" role="tab" data-tab="diagram" aria-selected="true" title="Tables, joins and the column grid">${icon('diagram')}Diagram</button>
                <button class="btn btn-ghost qb-tab-btn" role="tab" data-tab="sql" aria-selected="false" title="The SQL of the query; edits update the diagram">${icon('braces')}SQL</button>
                <button class="btn btn-ghost qb-tab-btn" role="tab" data-tab="results" aria-selected="false" title="The first rows the query returns">${icon('table')}Results</button>
            </div>
            <span class="toolbar-sep"></span>
            <div class="toolbar-group">
                <label class="qb-distinct" title="SELECT DISTINCT: leave out duplicate rows"><input type="checkbox" id="distinctToggle">DISTINCT</label>
                <button class="btn btn-icon" data-action="addDraggedTables" title="Add Dragged Tables: add the tables last dragged from the Tables view (or right-click tables there and choose Add to Query Builder)">${icon('add')}</button>
                <button class="btn btn-icon" data-action="layout" title="Arrange the tables automatically">${icon('layout')}</button>
                <button class="btn btn-icon" data-action="rawParts" title="Edit the WITH queries and the conditions the grid cannot show">${icon('params')}</button>
            </div>
            <span class="toolbar-sep"></span>
            <div class="toolbar-group">
                <button class="btn btn-icon" data-action="undo" title="Undo (Ctrl+Z)" disabled>${icon('undo')}</button>
                <button class="btn btn-icon" data-action="redo" title="Redo (Ctrl+Y)" disabled>${icon('redo')}</button>
            </div>
            <span class="toolbar-sep"></span>
            <div class="toolbar-group">
                <button class="btn btn-icon" data-action="copySql" title="Copy the SQL to the clipboard">${icon('copy')}</button>
                <button class="btn btn-icon" data-action="openInDataViewer" title="Open the query in a Data Viewer">${icon('goto')}</button>
                <button class="btn btn-primary" data-action="run" title="Run the query and show the first rows (Ctrl+Enter)">${icon('run')}Run</button>
            </div>
            ${apply}
            <span class="qb-notice" id="notice" role="status" aria-live="polite"></span>
        </div>
        <div class="qb-infobar" id="warnings" hidden>
            ${icon('warning')}
            <span class="qb-infobar-text" id="warningsText"></span>
            <button class="btn btn-ghost btn-icon btn-sm" data-action="dismissWarnings" title="Hide this note">${icon('close')}</button>
        </div>
        <section class="qb-panel" id="tabDiagram" role="tabpanel">
            <div class="qb-canvas-wrap" id="canvasWrap">
                <div class="qb-canvas" id="canvas"></div>
            </div>
            <div class="qb-splitter" id="gridSplitter" role="separator" aria-orientation="horizontal" title="Drag to share the space between the diagram and the grid"></div>
            <div class="qb-grid-wrap" id="gridWrap">
                <table class="qb-grid">
                    <thead id="gridHead"></thead>
                    <tbody id="gridBody"></tbody>
                </table>
                <div class="qb-grid-foot">
                    <input type="text" id="newExpression" class="mono" placeholder="Expression, e.g. upper(c.name) or count(*)" aria-label="New expression" spellcheck="false">
                    <button class="btn btn-sm" data-action="addExpression" title="Add the expression as a new row of the grid">${icon('add')}Expression</button>
                </div>
            </div>
        </section>
        <section class="qb-panel" id="tabSql" role="tabpanel" hidden>
            <div class="qb-sql">
                <textarea id="sqlInput" class="qb-sql-input" spellcheck="false" wrap="off" aria-label="SQL of the query"></textarea>
                <div class="qb-sql-error" id="sqlError" role="alert" hidden>${icon('error')}<span id="sqlErrorText"></span></div>
            </div>
        </section>
        <section class="qb-panel" id="tabResults" role="tabpanel" hidden>
            <div class="qb-results-status hint" id="resultStatus">Run the query to see its first rows.</div>
            <div class="qb-results-wrap"><table class="qb-results" id="resultTable"></table></div>
        </section>
    </main>
</div>

<div class="dlg-overlay" id="joinDlg" role="dialog" aria-modal="true" aria-labelledby="joinDlgTitle">
    <div class="dlg qb-join-dlg">
        <div class="dlg-header"><span id="joinDlgTitle">Join</span><button class="btn btn-ghost btn-icon" data-dlg-close title="Close">${icon('close')}</button></div>
        <div class="dlg-body">
            <div class="qb-join-types" id="joinTypes" role="radiogroup" aria-label="Join type"></div>
            <h4>Matching columns</h4>
            <div id="joinPairs"></div>
            <button class="btn btn-sm" data-join-action="addPair" title="Add a pair of columns that must match">${icon('add')}Pair</button>
            <h4 class="qb-dlg-section">Further condition</h4>
            <textarea id="joinCondition" class="qb-dlg-sql" rows="3" spellcheck="false" placeholder="Optional, e.g. o.valid_to IS NULL" aria-label="Further join condition"></textarea>
        </div>
        <div class="dlg-footer">
            <button class="btn btn-primary" data-join-action="save" title="Apply the join settings">${icon('check')}Save</button>
            <button class="btn btn-danger" data-join-action="delete" title="Remove the join from the query">${icon('trash')}Delete</button>
            <button class="btn" data-dlg-close title="Close without changes">Cancel</button>
        </div>
    </div>
</div>

<div class="dlg-overlay" id="tableDlg" role="dialog" aria-modal="true" aria-labelledby="tableDlgTitle">
    <div class="dlg">
        <div class="dlg-header"><span id="tableDlgTitle">Table</span><button class="btn btn-ghost btn-icon" data-dlg-close title="Close">${icon('close')}</button></div>
        <div class="dlg-body">
            <div class="field"><label for="tableAlias">Alias</label><input type="text" id="tableAlias" spellcheck="false"></div>
            <div id="tableSqlField">
                <label for="tableSql">SQL</label>
                <textarea id="tableSql" class="qb-dlg-sql" rows="10" spellcheck="false"></textarea>
            </div>
        </div>
        <div class="dlg-footer">
            <button class="btn btn-primary" data-table-action="save" title="Apply the changes">${icon('check')}Save</button>
            <button class="btn" data-dlg-close title="Close without changes">Cancel</button>
        </div>
    </div>
</div>

<div class="dlg-overlay" id="rawDlg" role="dialog" aria-modal="true" aria-labelledby="rawDlgTitle">
    <div class="dlg qb-raw-dlg">
        <div class="dlg-header"><span id="rawDlgTitle">WITH queries and raw conditions</span><button class="btn btn-ghost btn-icon" data-dlg-close title="Close">${icon('close')}</button></div>
        <div class="dlg-body">
            <p class="hint">Parts of the query the diagram and the grid cannot show. Conditions are combined with AND.</p>
            <h4>WITH queries</h4>
            <div id="rawCtes"></div>
            <button class="btn btn-sm" data-raw-action="add" data-raw-kind="ctes" title="Add a WITH query">${icon('add')}WITH query</button>
            <h4 class="qb-dlg-section">WHERE conditions</h4>
            <div id="rawWhere"></div>
            <button class="btn btn-sm" data-raw-action="add" data-raw-kind="where" title="Add a WHERE condition">${icon('add')}Condition</button>
            <h4 class="qb-dlg-section">HAVING conditions</h4>
            <div id="rawHaving"></div>
            <button class="btn btn-sm" data-raw-action="add" data-raw-kind="having" title="Add a HAVING condition">${icon('add')}Condition</button>
        </div>
        <div class="dlg-footer">
            <button class="btn btn-primary" data-raw-action="save" title="Apply the changes">${icon('check')}Save</button>
            <button class="btn" data-dlg-close title="Close without changes">Cancel</button>
        </div>
    </div>
</div>`;
}

/** One open Query Builder. */
export class QueryBuilderPanel implements vscode.Disposable {
    readonly panel: vscode.WebviewPanel;
    private readonly history: ModelHistory;
    private readonly disposables: vscode.Disposable[] = [];
    /** Catalog columns per `schema.name`; a relation without schema is resolved on the search_path. */
    private readonly columnCache = new Map<string, QbCatalogColumn[]>();
    private readonly schemaCache = new Map<string, string | null>();
    /** The syntax error of the SQL text, while the text cannot be read into a model. */
    private sqlError: string | undefined;
    /** The error of the SQL the builder was opened with, re-sent once the webview is ready. */
    private initialSqlStatus: Message | undefined;
    private disposed = false;
    /** The model changes still being handled, see {@link receive}. */
    private queue: Promise<void> = Promise.resolve();
    private readonly handlers: Record<PanelCommand, (msg: Message) => Promise<void> | void>;

    constructor(
        private readonly services: QueryBuilderServices,
        private readonly target: QueryBuilderTarget | undefined,
        title: string,
        onDispose: () => void
    ) {
        this.history = new ModelHistory(createEmptyModel());
        this.handlers = {
            ready: () => this.handleReady(),
            requestDroppedTables: (msg) => this.handleRequestDroppedTables(msg),
            undo: () => this.step(() => this.history.undo()),
            redo: () => this.step(() => this.history.redo()),
            sqlEdited: (msg) => this.handleSqlEdited(msg),
            runPreview: () => this.handleRunPreview(),
            apply: () => this.handleApply(),
            openInDataViewer: () => this.handleOpenInDataViewer(),
            copySql: () => this.handleCopySql(),
            queryEditorRequest: (msg) => this.handleEditorRequest(msg)
        };
        this.panel = vscode.window.createWebviewPanel(
            'postgresQueryBuilder.queryBuilder',
            title,
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.file(path.join(services.extensionPath, 'dist', 'monaco'))]
            }
        );
        this.panel.webview.html = buildQueryBuilderHtml(this.panel.webview, services.extensionPath, { applyTitle: target?.description });
        this.disposables.push(
            this.panel.webview.onDidReceiveMessage((msg: unknown) => {
                void this.receive(msg);
            }),
            services.onConnectionChanged(() => {
                void this.enqueue(() => this.handleConnectionChanged(), 'handleConnectionChanged');
            })
        );
        this.panel.onDidDispose(() => {
            this.disposed = true;
            for (const d of this.disposables) d.dispose();
            onDispose();
        });
    }

    get model(): QueryModel {
        return this.history.current;
    }

    /** Start from a SELECT and/or a set of relations, before any message of the webview is handled. */
    initialize(options: QueryBuilderOpenOptions): Promise<void> {
        const run = this.queue.then(() => this.load(options));
        this.queue = run.catch(() => undefined);
        return run;
    }

    private async load(options: QueryBuilderOpenOptions): Promise<void> {
        if (options.sql && options.sql.trim()) {
            try {
                const model = await this.withCatalog(await parseSelect(options.sql));
                this.history.replace(model);
            } catch (err: unknown) {
                // The text stays readable in the SQL tab, with its error.
                const details = this.errorDetails(options.sql, err);
                this.sqlError = `The SQL cannot be read: ${details.message as string}`;
                this.initialSqlStatus = { command: 'sqlStatus', seq: 0, ok: false, sql: options.sql, ...details };
                this.post(this.initialSqlStatus);
            }
        }
        for (const table of options.tables ?? []) {
            const model = await this.modelWithTable(this.history.current, table.schema, table.name);
            this.history.replace(model);
        }
        if (!options.title) this.panel.title = builderTitle(this.history.current);
        this.postState('init');
    }

    reveal(): void {
        this.panel.reveal();
    }

    /**
     * Add relations of the Tables view next to the boxes on the canvas (the
     * first one at `at`, when given), joined to them, as one undo step. Runs
     * in turn with the changes the webview posted.
     */
    addTables(tables: ReadonlyArray<{ schema: string; name: string }>, at?: { x: number; y: number }): Promise<void> {
        return this.enqueue(() => this.handleAddTables(tables, at), 'addTables');
    }

    dispose(): void {
        this.panel.dispose();
    }

    private post(message: Message): void {
        if (this.disposed) return;
        try {
            void this.panel.webview.postMessage(message);
        } catch {
            // The panel went away between the check and the post.
        }
    }

    private notice(textValue: string, kind: 'info' | 'error' = 'info'): void {
        this.post({ command: 'notice', text: textValue, kind });
    }

    /**
     * Take a message of the webview. Changes to the model are handled one
     * after the other, in the order they were posted; running, applying or
     * copying the query waits for the changes posted before it (so Run right
     * after typing runs what was typed) without holding up later edits.
     */
    receive(raw: unknown): Promise<void> {
        const command = raw && typeof raw === 'object' ? (raw as Message).command : undefined;
        if (typeof command === 'string' && (CONCURRENT_COMMANDS as readonly string[]).includes(command)) {
            return this.queue.then(() => this.handleMessage(raw));
        }
        this.queue = this.queue.then(() => this.handleMessage(raw));
        return this.queue;
    }

    /** Run a change that does not come from the webview in the queue of model changes. */
    private enqueue(work: () => Promise<void>, scope: string): Promise<void> {
        this.queue = this.queue.then(work).catch((err: unknown) => Logger.error(`QueryBuilderPanel.${scope}`, err));
        return this.queue;
    }

    async handleMessage(raw: unknown): Promise<void> {
        const msg = raw && typeof raw === 'object' ? (raw as Message) : {};
        const command = typeof msg.command === 'string' ? msg.command : '';
        try {
            if (Object.prototype.hasOwnProperty.call(MODEL_INTENTS, command)) {
                this.applyIntent(command, msg);
                return;
            }
            if (!(PANEL_COMMANDS as readonly string[]).includes(command)) {
                Logger.log('QueryBuilderPanel.handleMessage', `Unhandled webview message "${command}"`);
                return;
            }
            await this.handlers[command as PanelCommand](msg);
        } catch (err: unknown) {
            if (!(err instanceof QbIntentError)) Logger.error(`QueryBuilderPanel.${command || 'handleMessage'}`, err);
            this.notice(getErrorMessage(err), 'error');
            // A request the webview waits for is always answered.
            if (command === 'runPreview') this.post({ command: 'previewResult', error: getErrorMessage(err) });
            if (command === 'sqlEdited') this.post({ command: 'sqlStatus', seq: msg.seq, ok: false, message: getErrorMessage(err) });
            if (command === 'queryEditorRequest') this.post({ command: 'queryEditorResponse', requestId: msg.requestId, result: null });
            if (Object.prototype.hasOwnProperty.call(MODEL_INTENTS, command)) this.postState('rejected');
        }
    }

    private applyIntent(command: string, msg: Message): void {
        const next = MODEL_INTENTS[command](this.history.current, msg);
        // The first placement of tables the diagram laid out is no step of its own.
        const silent = command === 'placeTables' && msg.record === false;
        if (silent) this.history.replace(next);
        else if (this.history.commit(next)) this.sqlError = undefined;
        this.postState(silent ? 'place' : command);
    }

    private step(move: () => boolean): void {
        // Only a step that changes the model replaces the SQL text that cannot be read.
        if (move()) this.sqlError = undefined;
        this.postState('history');
    }

    private postState(origin: string, seq?: unknown): void {
        const model = this.history.current;
        this.post({
            command: 'state',
            origin,
            seq,
            model,
            sql: generateSql(model),
            // The SQL tab keeps a text the model could not be read from.
            sqlError: this.sqlError !== undefined,
            columns: this.columnsForModel(model),
            canUndo: this.history.canUndo,
            canRedo: this.history.canRedo
        });
    }

    private handleReady(): void {
        this.postState('init');
        // The SQL the builder was opened with could not be read: show it with its error.
        if (this.initialSqlStatus && this.sqlError !== undefined) this.post(this.initialSqlStatus);
    }

    private async handleConnectionChanged(): Promise<void> {
        this.columnCache.clear();
        this.schemaCache.clear();
        this.history.replace(await this.withCatalog(this.history.current));
        this.postState('catalog');
    }

    /** Schema a relation named without one resolves to on the search_path, or null. */
    private async resolveSchema(name: string): Promise<string | null> {
        if (this.schemaCache.has(name)) return this.schemaCache.get(name) as string | null;
        let schema: string | null = null;
        try {
            const rows = await this.services.catalogQuery(
                `SELECT n.nspname AS schema_name
                 FROM pg_catalog.pg_class c
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.oid = pg_catalog.to_regclass(pg_catalog.quote_ident($1))`,
                [name]
            );
            schema = rows.length > 0 ? String(rows[0].schema_name) : null;
        } catch (err: unknown) {
            Logger.error('QueryBuilderPanel.resolveSchema', err);
        }
        this.schemaCache.set(name, schema);
        return schema;
    }

    private async loadColumns(schema: string, name: string): Promise<QbCatalogColumn[]> {
        const key = `${schema}.${name}`;
        const cached = this.columnCache.get(key);
        if (cached) return cached;
        let columns: QbCatalogColumn[] = [];
        try {
            columns = await listColumns(this.services.catalogQuery, schema, name);
        } catch (err: unknown) {
            Logger.error('QueryBuilderPanel.loadColumns', err);
        }
        this.columnCache.set(key, columns);
        return columns;
    }

    /** Catalog columns of a relation table of the model, loaded when connected. */
    private async catalogColumnsOf(model: QueryModel, table: QbTable): Promise<QbCatalogColumn[] | undefined> {
        if (table.kind !== 'relation' || !table.name) return undefined;
        if (!table.schema && model.ctes.some((c) => c.name === table.name)) return undefined;
        if (!this.services.isConnected()) return undefined;
        const schema = table.schema ?? await this.resolveSchema(table.name);
        return schema ? this.loadColumns(schema, table.name) : undefined;
    }

    /** Load the columns of every table and assign unqualified grid columns to their table. */
    private async withCatalog(model: QueryModel): Promise<QueryModel> {
        const byTable: Record<string, string[]> = {};
        for (const table of model.tables) {
            const columns = await this.catalogColumnsOf(model, table);
            if (columns) byTable[table.id] = columns.map((c) => c.name);
        }
        return Object.keys(byTable).length > 0 ? resolveColumnTables(model, byTable) : model;
    }

    /** Column lists of the boxes, by table id, from the cache (never queries). */
    private columnsForModel(model: QueryModel): Record<string, Array<{ name: string; dataType: string; isPrimaryKey: boolean }>> {
        const out: Record<string, Array<{ name: string; dataType: string; isPrimaryKey: boolean }>> = {};
        for (const table of model.tables) {
            if (table.kind === 'relation' && table.name) {
                const cte = !table.schema ? model.ctes.find((c) => c.name === table.name) : undefined;
                if (cte) {
                    out[table.id] = (cte.columns ?? []).filter((c) => c !== '*').map((name) => ({ name, dataType: '', isPrimaryKey: false }));
                    continue;
                }
                const schema = table.schema ?? this.schemaCache.get(table.name);
                const cached = schema ? this.columnCache.get(`${schema}.${table.name}`) : undefined;
                if (cached) out[table.id] = cached.map((c) => ({ name: c.name, dataType: c.dataType, isPrimaryKey: c.isPrimaryKey }));
            } else {
                out[table.id] = (table.columns ?? []).filter((c) => c !== '*').map((name) => ({ name, dataType: '', isPrimaryKey: false }));
            }
        }
        return out;
    }

    /** The mapping edges between a new relation and the relations of the model. */
    private mappingEdges(model: QueryModel, schema: string, name: string): ReturnType<typeof mappingJoinEdges> {
        let mappings: readonly CustomColumnMapping[];
        try {
            mappings = this.services.mappings();
        } catch (err: unknown) {
            Logger.error('QueryBuilderPanel.mappingEdges', err);
            return [];
        }
        if (mappings.length === 0) return [];
        const tables = [{ schema, name }];
        for (const t of model.tables) {
            const tableSchema = t.kind === 'relation' && t.name ? t.schema ?? this.schemaCache.get(t.name) : undefined;
            if (tableSchema && t.name) tables.push({ schema: tableSchema, name: t.name });
        }
        return mappingJoinEdges(mappings, tables);
    }

    private async modelWithTable(model: QueryModel, schema: string, name: string, x?: number, y?: number): Promise<QueryModel> {
        const columns = await this.loadColumns(schema, name);
        let foreignKeys: Awaited<ReturnType<typeof listForeignKeys>> = [];
        try {
            foreignKeys = await listForeignKeys(this.services.catalogQuery, { tables: [{ schema, name }] });
        } catch (err: unknown) {
            Logger.error('QueryBuilderPanel.modelWithTable', err);
        }
        const edges = [...foreignKeys, ...this.mappingEdges(model, schema, name)];
        return addTable(model, { schema, name, columns: columns.map((c) => c.name), x, y }, edges).model;
    }

    private async handleAddTables(tables: ReadonlyArray<{ schema: string; name: string }>, at?: { x: number; y: number }): Promise<void> {
        if (tables.length === 0) return;
        if (!await this.services.ensureConnected()) {
            this.notice('Connect to a database to add tables.', 'error');
            return;
        }
        let next = this.history.current;
        for (const [i, table] of tables.entries()) {
            // Only the first table goes to the drop point; the diagram places the others next to the boxes.
            const point = i === 0 && at ? { x: Math.max(0, Math.round(at.x)), y: Math.max(0, Math.round(at.y)) } : undefined;
            next = await this.modelWithTable(next, table.schema, table.name, point?.x, point?.y);
        }
        if (this.history.commit(next)) this.sqlError = undefined;
        this.postState('addTable');
    }

    private async handleRequestDroppedTables(msg: Message): Promise<void> {
        const tables = this.services.takeDraggedTables();
        if (tables.length === 0) {
            this.notice('Drag tables from the Tables view onto the canvas, or right-click them and choose Add to Query Builder.');
            return;
        }
        const x = finite(msg.x);
        const y = finite(msg.y);
        await this.handleAddTables(tables, x !== undefined && y !== undefined ? { x, y } : undefined);
    }

    private errorDetails(sql: string, err: unknown): Message {
        const position = err instanceof SqlParseError ? err.position : undefined;
        const at = position !== undefined ? offsetToLineColumn(sql, position) : undefined;
        return { message: getErrorMessage(err), offset: position, line: at?.line, column: at?.column };
    }

    private async handleSqlEdited(msg: Message): Promise<void> {
        const seq = msg.seq;
        const sql = text(msg.sql) ?? '';
        if (!sql.trim()) {
            this.history.commit(createEmptyModel());
            this.sqlError = undefined;
            this.post({ command: 'sqlStatus', seq, ok: true });
            this.postState('sql', seq);
            return;
        }
        let parsed: QueryModel;
        try {
            parsed = await parseSelect(sql);
        } catch (err: unknown) {
            const details = this.errorDetails(sql, err);
            const where = details.line !== undefined ? ` (line ${details.line}, column ${details.column})` : '';
            this.sqlError = `The SQL cannot be read${where}: ${details.message as string}`;
            this.post({ command: 'sqlStatus', seq, ok: false, ...details });
            return;
        }
        const model = await this.withCatalog(carryOverPositions(this.history.current, parsed));
        this.history.commit(model);
        this.sqlError = undefined;
        this.post({ command: 'sqlStatus', seq, ok: true });
        this.postState('sql', seq);
    }

    /** The SQL to run, copy or apply; undefined (and the reason shown) while the SQL text has an error. */
    private currentSql(): string | undefined {
        if (this.sqlError !== undefined) {
            this.notice(`${this.sqlError} Fix it in the SQL tab or undo the change first.`, 'error');
            return undefined;
        }
        return generateSql(this.history.current);
    }

    private async handleRunPreview(): Promise<void> {
        const sql = this.currentSql();
        if (sql === undefined) {
            this.post({ command: 'previewResult', error: this.sqlError });
            return;
        }
        if (!await this.services.ensureConnected()) {
            this.post({ command: 'previewResult', error: 'Not connected to a database.' });
            return;
        }
        try {
            const runnable = await this.withVariableValues(sql, 'Run');
            if (runnable === undefined) {
                this.post({ command: 'previewResult', error: 'The query was not run: no values were entered for its placeholders.' });
                return;
            }
            const result = await this.services.runPreview(runnable);
            this.post({ command: 'previewResult', ...result });
        } catch (err: unknown) {
            this.post({ command: 'previewResult', error: getErrorMessage(err) });
        }
    }

    /**
     * The SQL with the values of its placeholders and variables (`:name`, `$1`,
     * PL/pgSQL variables) the user entered; the SQL itself when it has none,
     * undefined when the user cancels.
     */
    private async withVariableValues(sql: string, actionLabel: string): Promise<string | undefined> {
        if (!this.services.askForVariables || queryVariableNames(sql).length === 0) return sql;
        return this.services.askForVariables(sql, actionLabel);
    }

    private async handleApply(): Promise<void> {
        if (!this.target) {
            this.notice('This Query Builder was not opened from a Data Viewer or a SQL file, so there is nothing to apply to. Copy the SQL instead.', 'error');
            return;
        }
        const sql = this.currentSql();
        if (sql === undefined) return;
        const outcome = await this.target.apply(sql);
        this.notice(outcome.message, outcome.ok ? 'info' : 'error');
    }

    private async handleOpenInDataViewer(): Promise<void> {
        const sql = this.currentSql();
        if (sql === undefined) return;
        const runnable = await this.withVariableValues(sql, 'View Data');
        if (runnable === undefined) return;
        await this.services.openInDataViewer(runnable, builderTitle(this.history.current));
    }

    private async handleCopySql(): Promise<void> {
        const sql = this.currentSql();
        if (sql === undefined) return;
        await vscode.env.clipboard.writeText(sql);
        this.notice('The SQL was copied to the clipboard.');
    }

    private async handleEditorRequest(msg: Message): Promise<void> {
        let result: unknown = null;
        try {
            result = await this.services.editorRequest(String(msg.kind ?? ''), msg);
        } catch (err: unknown) {
            Logger.error('QueryBuilderPanel.handleEditorRequest', err);
        }
        this.post({ command: 'queryEditorResponse', requestId: msg.requestId, result });
    }
}

/** Opens Query Builder panels; several can be open at once. */
export class QueryBuilderManager implements vscode.Disposable {
    /** The open panels, the most recently active last. */
    private readonly panels: QueryBuilderPanel[] = [];

    constructor(private readonly services: QueryBuilderServices) {}

    async open(options: QueryBuilderOpenOptions = {}): Promise<QueryBuilderPanel> {
        const created: { panel?: QueryBuilderPanel; viewState?: vscode.Disposable } = {};
        const panel = new QueryBuilderPanel(this.services, options.target, options.title ?? 'Query Builder', () => {
            created.viewState?.dispose();
            if (created.panel) this.forget(created.panel);
        });
        created.panel = panel;
        created.viewState = panel.panel.onDidChangeViewState((e) => {
            if (e.webviewPanel.active) this.markActive(panel);
        });
        this.panels.push(panel);
        await panel.initialize(options);
        return panel;
    }

    /** The Query Builder the user worked in last, if one is open. */
    get lastActive(): QueryBuilderPanel | undefined {
        return this.panels[this.panels.length - 1];
    }

    /**
     * *Add to Query Builder*: add the relations to the Query Builder used last
     * and show it; without an open builder a new one opens with them.
     */
    async addTables(tables: ReadonlyArray<{ schema: string; name: string }>): Promise<QueryBuilderPanel> {
        const panel = this.lastActive;
        if (!panel) return this.open({ tables });
        panel.reveal();
        await panel.addTables(tables);
        return panel;
    }

    private markActive(panel: QueryBuilderPanel): void {
        const index = this.panels.indexOf(panel);
        if (index < 0) return;
        this.panels.splice(index, 1);
        this.panels.push(panel);
    }

    private forget(panel: QueryBuilderPanel): void {
        const index = this.panels.indexOf(panel);
        if (index >= 0) this.panels.splice(index, 1);
    }

    get openPanels(): number {
        return this.panels.length;
    }

    dispose(): void {
        for (const panel of [...this.panels]) panel.dispose();
        this.panels.length = 0;
    }
}

// ===== Entry points ==========================================================

/** The relations of the Tables view selection that the Query Builder can open. */
export function relationsFromNodes(node: unknown, nodes: unknown): Array<{ schema: string; name: string }> {
    const list = Array.isArray(nodes) && nodes.length > 0 ? nodes : node ? [node] : [];
    const out: Array<{ schema: string; name: string }> = [];
    for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const n = entry as Message;
        if (n.type !== 'table' || n.status === 'repoOnly') continue;
        const schema = text(n.schema);
        const name = text(n.table);
        if (schema && name && !out.some((t) => t.schema === schema && t.name === name)) out.push({ schema, name });
    }
    return out;
}

/**
 * Apply into a SQL file: replace the statement the builder was opened on,
 * provided it still stands there unchanged.
 */
export function documentTarget(uri: vscode.Uri, label: string, start: number, original: string): QueryBuilderTarget {
    let expectedStart = start;
    let expectedText = original;
    return {
        description: `Replace the SELECT statement in ${label} with this query`,
        async apply(sql: string) {
            let document: vscode.TextDocument;
            try {
                document = await vscode.workspace.openTextDocument(uri);
            } catch (err: unknown) {
                return { ok: false, message: `${label} cannot be opened: ${getErrorMessage(err)}` };
            }
            const current = document.getText();
            const located = locateApplyRange(current, expectedStart, expectedText);
            if ('error' in located) return { ok: false, message: located.error };
            let replacement = indentContinuationLines(sql, lineIndentAt(current, located.start));
            if (current.includes('\r\n')) replacement = replacement.replace(/\r?\n/g, '\r\n');
            const edit = new vscode.WorkspaceEdit();
            edit.replace(uri, new vscode.Range(document.positionAt(located.start), document.positionAt(located.end)), replacement);
            if (!await vscode.workspace.applyEdit(edit)) {
                return { ok: false, message: `VS Code did not accept the change to ${label}.` };
            }
            expectedStart = located.start;
            expectedText = replacement;
            return { ok: true, message: `The SELECT statement in ${label} was replaced.` };
        }
    };
}

/** "Edit SELECT in Query Builder": open the builder on the SELECT at the cursor of a SQL file. */
export async function editSelectInQueryBuilder(
    manager: QueryBuilderManager,
    editor: vscode.TextEditor | undefined,
    ensureConnected: () => Promise<boolean>
): Promise<void> {
    if (!editor) {
        vscode.window.showWarningMessage('Open a SQL file and place the cursor inside a SELECT statement.');
        return;
    }
    const document = editor.document;
    const fullText = document.getText();
    const selection = editor.selection.isEmpty
        ? undefined
        : { start: document.offsetAt(editor.selection.start), end: document.offsetAt(editor.selection.end) };
    const source = selectSourceFromText(fullText, document.offsetAt(editor.selection.active), selection);
    if (!source) {
        vscode.window.showWarningMessage('No SELECT statement found at the cursor.');
        return;
    }
    // The catalog fills the diagram; without a connection the SQL still opens.
    await ensureConnected();
    const label = path.basename(document.uri.fsPath || document.uri.path || 'the file');
    const target = source.readOnlyReason ? undefined : documentTarget(document.uri, label, source.start, source.sql);
    if (source.readOnlyReason) vscode.window.showInformationMessage(source.readOnlyReason);
    await manager.open({ sql: source.sql, target });
}
