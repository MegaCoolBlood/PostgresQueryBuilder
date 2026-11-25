import * as vscode from 'vscode';
import * as path from 'path';
import { buildBuilderSql, type JoinBuilderState } from './statementBuilder';
import { formatJoinSql, initialJoinBuilderState, type JoinDialogAddPayload, type JoinDialogIdentityEdge } from './joinDialog';
import { chooseTablesToAdd, initialJoinsFor, loadJoinMetadata, type QualifierStore } from './tableStatementDrop';
import { documentApplyTarget, selectSourceForBuilder, type ApplyTarget } from './applyToDocument';
import type { QueryRunner } from './queryRunner';
import type { ColumnMappingManager } from './columnMappingManager';
import type { DbSessionRef } from './dbSession';
import { Logger } from './logger';

/**
 * The extension side of the Data Viewer's *Query Builder* tab and its entry
 * points. The tab is the shared join builder (src/webview/joinBuilder.js) on
 * the query of the query bar: the webview reads the query into a builder
 * state, asks here for what the database knows about its tables, and has each
 * change turned into formatted SQL here — the query runs only on Run.
 */

/** How a Data Viewer opens: on which tab, whether its query runs at once, where Apply to File writes. */
export interface QueryViewOptions {
    tab?: 'data' | 'builder';
    /** False: the query waits for Run (default true). */
    run?: boolean;
    applyTarget?: ApplyTarget;
}

/** A table of the builder as the webview names it; `schema` is '' when the query leaves it out. */
export interface BuilderTableRef {
    schema: string;
    table: string;
}

/** What the database knows about one table of the builder. */
export interface BuilderTableMetadata extends BuilderTableRef {
    /** The schema the table was found in — `schema`, or the first match on the search path. */
    resolvedSchema: string;
    /** Quoted column identifiers. */
    columns: string[];
    /** The data type of each of `columns`, when known. */
    columnTypes?: string[];
    savedAlias?: string;
}

export interface BuilderMetadataAnswer {
    /** One entry per requested table that was found. */
    tables: BuilderTableMetadata[];
    /** Foreign keys and custom column mappings among the found tables. */
    identityEdges: JoinDialogIdentityEdge[];
}

type MappingSource = Pick<ColumnMappingManager, 'getAllMappings'> | undefined;
type AliasSource = Pick<QualifierStore, 'get'> | undefined;

/** The `{ schema, table }` entries of a webview message, without anything malformed. */
export function builderTableRefs(value: unknown): BuilderTableRef[] {
    if (!Array.isArray(value)) return [];
    const refs: BuilderTableRef[] = [];
    for (const entry of value) {
        if (!entry || typeof entry !== 'object') continue;
        const { schema, table } = entry as { schema?: unknown; table?: unknown };
        if (typeof table !== 'string' || !table) continue;
        refs.push({ schema: typeof schema === 'string' ? schema : '', table });
    }
    return refs;
}

/**
 * Columns, saved aliases and join edges of the builder's tables. A table the
 * query names without a schema is looked up with `resolveSchema` (the search
 * path); one that cannot be found is left out.
 */
export async function loadBuilderMetadata(
    queryRunner: Pick<QueryRunner, 'getMultiTableJoinData'>,
    columnMappingManager: MappingSource,
    qualifierStore: AliasSource,
    tables: ReadonlyArray<BuilderTableRef>,
    resolveSchema: (table: string) => Promise<string | undefined>
): Promise<BuilderMetadataAnswer> {
    const located: Array<BuilderTableRef & { resolvedSchema: string }> = [];
    for (const t of tables) {
        let resolvedSchema = t.schema;
        if (!resolvedSchema) {
            try {
                resolvedSchema = (await resolveSchema(t.table)) ?? '';
            } catch (err: unknown) {
                Logger.error('dataViewerBuilder.resolveSchema', err);
                resolvedSchema = '';
            }
        }
        if (resolvedSchema) located.push({ schema: t.schema, table: t.table, resolvedSchema });
    }
    const meta = await loadJoinMetadata(
        queryRunner, columnMappingManager,
        located.map(t => ({ schema: t.resolvedSchema, table: t.table })),
        qualifierStore, { uniqueAliases: false }
    );
    const answer: BuilderTableMetadata[] = [];
    for (const t of located) {
        const found = meta.tables.find(m => m.schema === t.resolvedSchema && m.table === t.table);
        if (found && !answer.some(a => a.schema === t.schema && a.table === t.table)) {
            answer.push({
                ...t, columns: [...found.columns], savedAlias: found.savedAlias,
                ...(found.columnTypes ? { columnTypes: [...found.columnTypes] } : {})
            });
        }
    }
    return { tables: answer, identityEdges: meta.identityEdges };
}

/** The formatted SELECT of a builder state the webview sent, for the query bar; null when it cannot be built. */
export function builderSqlFromState(state: unknown): string | null {
    if (!state || typeof state !== 'object') return null;
    try {
        return formatJoinSql(buildBuilderSql(state as JoinBuilderState, { semicolon: false }));
    } catch (err: unknown) {
        Logger.error('dataViewerBuilder.builderSqlFromState', err);
        return null;
    }
}

/**
 * "Add tables" of the builder: the tables just dragged from the Tables view or
 * picked from a list, with their metadata and the join edges over the whole
 * set, so the builder can join them. Null when nothing was chosen.
 */
export async function addBuilderTables(
    queryRunner: Pick<QueryRunner, 'getMultiTableJoinData' | 'listAllTables'>,
    columnMappingManager: MappingSource,
    qualifierStore: AliasSource,
    current: ReadonlyArray<BuilderTableRef>,
    choose: typeof chooseTablesToAdd = chooseTablesToAdd
): Promise<JoinDialogAddPayload | null> {
    const known = current.filter(t => t.schema && t.table);
    const candidates = await choose(queryRunner, known);
    if (candidates.length === 0) return null;
    const requested = [...known, ...candidates];
    const combined = await loadJoinMetadata(queryRunner, columnMappingManager, requested, qualifierStore, { uniqueAliases: false });
    // The metadata lists the found tables in request order; walk both lists to
    // tell the added ones apart even when one of them was not found.
    const added: JoinDialogAddPayload['tables'] = [];
    let next = 0;
    requested.forEach((t, i) => {
        const entry = combined.tables[next];
        if (!entry || entry.schema !== t.schema || entry.table !== t.table) return;
        next++;
        if (i >= known.length) added.push(entry);
    });
    return added.length > 0 ? { tables: added, fkEdges: combined.identityEdges } : null;
}

/** The relations of the Tables view selection, once each, without repository-only ones. */
export function relationsFromNodes(node: unknown, nodes: unknown): BuilderTableRef[] {
    const list = Array.isArray(nodes) && nodes.length > 0 ? nodes : node ? [node] : [];
    const out: BuilderTableRef[] = [];
    for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const n = entry as { type?: unknown; status?: unknown; schema?: unknown; table?: unknown };
        if (n.type !== 'table' || n.status === 'repoOnly') continue;
        const schema = typeof n.schema === 'string' ? n.schema : '';
        const table = typeof n.table === 'string' ? n.table : '';
        if (schema && table && !out.some(t => t.schema === schema && t.table === table)) out.push({ schema, table });
    }
    return out;
}

/** Opens a Data Viewer — `TableWebViewManager.openQueryView`. */
export type OpenQueryView = (
    sql: string,
    title: string,
    viewColumn?: vscode.ViewColumn,
    savedQuery?: undefined,
    sessionRef?: DbSessionRef,
    options?: QueryViewOptions
) => Promise<void>;

/** The title of a Data Viewer opened on the builder tab for `names`. */
export function builderTitle(names: ReadonlyArray<string>): string {
    if (names.length === 0) return 'Query Builder';
    const list = names.join(', ');
    return `Query Builder: ${list.length > 40 ? `${list.slice(0, 40)}…` : list}`;
}

/** "New Query Builder": an empty Data Viewer on the builder tab. */
export async function openNewQueryBuilder(open: OpenQueryView): Promise<void> {
    await open('', builderTitle([]), vscode.ViewColumn.Active, undefined, undefined, { tab: 'builder', run: false });
}

/**
 * "Open in Query Builder": the selected tables joined by their foreign keys
 * and custom mappings, every column selected, on the builder tab of a new
 * Data Viewer. The query waits for Run.
 */
export async function openTablesInQueryBuilder(
    deps: { queryRunner: Pick<QueryRunner, 'getMultiTableJoinData'>; mappings: MappingSource; qualifiers: AliasSource; open: OpenQueryView },
    tables: ReadonlyArray<BuilderTableRef>
): Promise<void> {
    const meta = await loadJoinMetadata(deps.queryRunner, deps.mappings, tables, deps.qualifiers);
    if (meta.tables.length === 0) {
        vscode.window.showWarningMessage('The selected tables could not be read from the database.');
        return;
    }
    const state = initialJoinBuilderState(meta.tables, initialJoinsFor(meta.tables, meta.identityEdges));
    const sql = builderSqlFromState(state) ?? '';
    await deps.open(sql, builderTitle(meta.tables.map(t => t.table)), vscode.ViewColumn.Active, undefined, undefined, { tab: 'builder', run: false });
}

/**
 * "Edit SELECT in Query Builder": the SELECT at the cursor of a SQL file in a
 * Data Viewer on the file's database session, on the builder tab, with Apply
 * to File writing the query back over the statement. A `SELECT … INTO` or an
 * UPDATE opens without Apply, and the user is told why.
 */
export async function editSelectInQueryBuilder(
    deps: { open: OpenQueryView; sessionRefFor?: (document: vscode.TextDocument) => DbSessionRef | undefined },
    editor: vscode.TextEditor | undefined
): Promise<void> {
    if (!editor) {
        vscode.window.showWarningMessage('Open a SQL file and place the cursor inside a SELECT statement.');
        return;
    }
    const document = editor.document;
    const selection = editor.selection.isEmpty
        ? undefined
        : { start: document.offsetAt(editor.selection.start), end: document.offsetAt(editor.selection.end) };
    const source = selectSourceForBuilder(document.getText(), document.offsetAt(editor.selection.active), selection);
    if (!source) {
        vscode.window.showWarningMessage('No SELECT statement found at the cursor.');
        return;
    }
    const label = path.basename(document.uri.fsPath || document.uri.path || 'the file');
    const applyTarget = source.applyBlockedReason
        ? undefined
        : documentApplyTarget(document.uri, label, source.start, source.original);
    if (source.applyBlockedReason) {
        vscode.window.showInformationMessage(source.applyBlockedReason);
    }
    await deps.open(source.sql, builderTitle([label]), vscode.ViewColumn.Beside, undefined, deps.sessionRefFor?.(document), {
        tab: 'builder',
        run: false,
        applyTarget
    });
}
