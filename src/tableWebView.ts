import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { QueryRunner, buildRelationListQuery, type CommitTarget } from './queryRunner';
import { ExportService } from './exportService';
import { ColumnMappingManager } from './columnMappingManager';
import { PermanentConstraintManager } from './permanentConstraintManager';
import { SavedQueryStore, SavedQueryParameter, mergeParameters } from './savedQueryStore';
import { ModifyHistoryStore, isModifyingSql, splitSqlStatements } from './modifyHistoryStore';
import { getErrorMessage } from './logger';
import type { ViewCapabilities } from './resultSource';
import * as path from 'path';
import * as fs from 'fs';

/**
 * One open Data Viewer panel. Both entry points — a table opened from the tree
 * and an ad-hoc SELECT opened via "View Data" — create the same kind of
 * session, so every feature is available in both. The difference is only the
 * SQL the panel starts with; what the panel may do with the result is derived
 * from the result itself (see {@link ViewCapabilities}).
 */
interface PanelSession {
    /** Unique key in {@link TableWebViewManager.sessions}. */
    id: string;
    panel: vscode.WebviewPanel;
    origin: 'table' | 'query';
    /** Source table of the current result, once known. */
    schema: string;
    table: string;
    /** Bucket used to store this panel's query history. */
    historyKey: string;
    /** Columns of the result currently shown, used to check entered values. */
    columns: ResultColumn[];
    disposed: boolean;
}

/** Shared context passed to each webview message handler. */
interface MessageContext {
    session: PanelSession;
    message: any;
    queryRunner: QueryRunner;
}

/** Minimal shape of a `pg` field descriptor used to build result columns. */
export interface ResultFieldInfo {
    name: string;
    dataTypeID: number;
    /** Postgres type modifier (`varchar(5)` -> 9, no modifier -> -1). */
    dataTypeModifier?: number;
    tableID?: number;
    columnID?: number;
}

/** A Data Viewer column as posted to the webview. */
export interface ResultColumn {
    name: string;
    dataType: string;
    /** Type including its modifier, e.g. `character varying(5)`, `numeric(10,2)`. */
    fullType: string;
    isNullable: boolean;
    columnDefault: null;
    comment: string | null;
}

/**
 * Map raw `pg` field descriptors to Data Viewer column objects, resolving the
 * type name (via `typeMap`, keyed by data-type OID), the type including its
 * modifier (via `fullTypeMap`, keyed by `"typeOID:typeModifier"`) and the
 * column comment (via `commentMap`, keyed by `"tableOID:columnNumber"`). Fields
 * that do not originate from a table column (`tableID`/`columnID` <= 0, e.g.
 * computed expressions or literals in a custom SELECT) get no comment.
 */
export function buildCustomResultColumns(
    fields: ReadonlyArray<ResultFieldInfo>,
    typeMap: Record<number, string>,
    commentMap: Record<string, string>,
    fullTypeMap: Record<string, string> = {}
): ResultColumn[] {
    return fields.map((f) => {
        const tableId = f.tableID ?? 0;
        const columnId = f.columnID ?? 0;
        const comment = (tableId > 0 && columnId > 0)
            ? (commentMap[`${tableId}:${columnId}`] ?? null)
            : null;
        const dataType = typeMap[f.dataTypeID] || '';
        return {
            name: f.name,
            dataType,
            fullType: fullTypeMap[`${f.dataTypeID}:${f.dataTypeModifier ?? -1}`] || dataType,
            isNullable: true,
            columnDefault: null,
            comment
        };
    });
}

/**
 * Build a fast "describe" probe query that returns the result columns of a
 * custom SELECT without fetching any rows, so the Data Viewer can render the
 * header and filter row immediately while the real query is still running.
 *
 * Only a single-statement `SELECT`/`WITH` query can be safely wrapped this way;
 * anything else (DML, multiple statements, empty input) returns `null` so the
 * caller skips the early render and falls back to rendering columns from the
 * full result. `singleStatement` must already be a single SQL statement.
 */
export function buildColumnProbeSql(singleStatement: string): string | null {
    if (typeof singleStatement !== 'string') {
        return null;
    }
    const trimmed = singleStatement.trim().replace(/;+\s*$/, '').trim();
    if (!trimmed) {
        return null;
    }
    if (!/^(select|with)\b/i.test(trimmed)) {
        return null;
    }
    return `SELECT * FROM (${trimmed}) AS _pqb_cols LIMIT 0`;
}

export class TableWebViewManager {
    private sessions: Map<string, PanelSession> = new Map();
    private pendingFilters: Map<string, { column: string; value: string; conditions?: any[] }> = new Map();
    private context: vscode.ExtensionContext;
    private connectionManager: ConnectionManager;
    private exportService: ExportService;
    private columnMappingManager: ColumnMappingManager;
    private permanentConstraintManager: PermanentConstraintManager;
    private savedQueryStore?: SavedQueryStore;
    private modifyHistoryStore?: ModifyHistoryStore;
    private querySessionCounter = 0;

    constructor(context: vscode.ExtensionContext, connectionManager: ConnectionManager, columnMappingManager: ColumnMappingManager, permanentConstraintManager: PermanentConstraintManager, modifyHistoryStore?: ModifyHistoryStore, savedQueryStore?: SavedQueryStore) {
        this.context = context;
        this.connectionManager = connectionManager;
        this.exportService = new ExportService(context);
        this.columnMappingManager = columnMappingManager;
        this.permanentConstraintManager = permanentConstraintManager;
        this.modifyHistoryStore = modifyHistoryStore;
        this.savedQueryStore = savedQueryStore;

        // Push refreshed mappings to every open panel when the underlying store
        // changes (e.g. workspace file edit, import, scope move).
        context.subscriptions.push(
            this.columnMappingManager.onDidChange(() => this.broadcastMappings())
        );
        if (this.savedQueryStore) {
            context.subscriptions.push(
                this.savedQueryStore.onDidChange(() => this.broadcastSavedQueries())
            );
        }
    }

    private broadcastSavedQueries(): void {
        const queries = this.savedQueryStore?.getAll() ?? [];
        for (const session of this.sessions.values()) {
            this.post(session, { command: 'savedQueriesLoaded', queries });
        }
    }

    private broadcastMappings(): void {
        for (const session of this.sessions.values()) {
            if (session.disposed || !session.schema || !session.table) {
                continue;
            }
            const mappings = this.columnMappingManager.getMappingsForTable(session.schema, session.table);
            this.post(session, { command: 'customMappingsLoaded', mappings });
        }
    }

    /** Post a message to a panel unless it has already been disposed. */
    private post(session: PanelSession, message: any): void {
        if (session.disposed) {
            return;
        }
        try {
            session.panel.webview.postMessage(message);
        } catch {
            // Panel may have been disposed between the check and the post.
        }
    }

    /**
     * Create a Data Viewer panel and wire it to the shared message handlers.
     * Used for both entry points so a panel opened for an ad-hoc SELECT behaves
     * exactly like one opened for a table.
     */
    private createSession(
        id: string,
        title: string,
        origin: 'table' | 'query',
        schema: string,
        table: string,
        historyKey: string,
        viewColumn: vscode.ViewColumn
    ): PanelSession {
        const panel = vscode.window.createWebviewPanel(
            'postgresTableView',
            title,
            viewColumn,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.file(path.join(this.context.extensionPath, 'src', 'webview'))
                ]
            }
        );

        const session: PanelSession = { id, panel, origin, schema, table, historyKey, columns: [], disposed: false };
        this.sessions.set(id, session);

        panel.onDidDispose(() => {
            session.disposed = true;
            this.sessions.delete(id);
        });

        panel.webview.html = this.getWebviewContent(panel.webview);

        // Push connection updates to the webview while it's open.
        const connSub = this.connectionManager.onConnectionChanged(() => {
            this.post(session, {
                command: 'connectionChanged',
                connectionName: this.getConnectionName()
            });
        });
        panel.onDidDispose(() => connSub.dispose());

        panel.webview.onDidReceiveMessage(async (message) => {
            const handler = this.messageHandlers[message.command];
            if (!handler) {
                console.warn(`Data Viewer: unhandled webview message "${message.command}"`);
                return;
            }
            const queryRunner = new QueryRunner(this.connectionManager);
            try {
                await handler.call(this, { session, message, queryRunner });
            } catch (err: unknown) {
                // Always release the loading state, otherwise the grid keeps
                // showing a spinner for a query that already failed.
                this.post(session, { command: 'error', text: getErrorMessage(err) });
                vscode.window.showErrorMessage(`Query error: ${getErrorMessage(err)}`);
            }
        });

        return session;
    }

    async openTableView(schema: string, table: string): Promise<void> {
        const id = `table:${schema}.${table}`;

        const existing = this.sessions.get(id);
        if (existing) {
            existing.panel.reveal();
            return;
        }

        // Opening a table requires a live connection to load its data. If none
        // is active, prompt the user to pick one before creating the panel.
        if (!await this.connectionManager.ensureConnected()) {
            return;
        }

        let tableReference = `${schema}.${table}`;
        try {
            const initQueryRunner = new QueryRunner(this.connectionManager);
            tableReference = (await initQueryRunner.getSelectBuildInfo(schema, table)).tableReference;
        } catch {
            // Ignore init formatting errors; the first load provides the
            // authoritative value.
        }

        const session = this.createSession(
            id, `${schema}.${table}`, 'table', schema, table, `${schema}.${table}`, vscode.ViewColumn.One
        );

        this.post(session, {
            command: 'init',
            origin: 'table',
            schema,
            table,
            title: `${schema}.${table}`,
            tableReference,
            alwaysQuote: vscode.workspace.getConfiguration('postgresQueryBuilder').get<boolean>('alwaysQuote', false),
            thousandSeparator: vscode.workspace.getConfiguration('postgresQueryBuilder').get<string>('thousandSeparator', ' '),
            connectionName: this.getConnectionName(),
            permanentConstraints: this.permanentConstraintManager.getConstraints(schema, table),
            permanentSorts: this.permanentConstraintManager.getSorts(schema, table)
        });
    }

    /**
     * Open the Data Viewer for an ad-hoc SELECT (e.g. the "View Data" command
     * run inside a procedure body). The panel offers the same features as one
     * opened from the table tree — editing, constraints, mappings and export
     * are enabled as far as the result's source columns allow.
     *
     * @param sql The runnable SELECT statement.
     * @param title A short label shown in the toolbar.
     * @param viewColumn Where to place the panel (defaults to a side-by-side split).
     * @param savedQuery A saved query whose `:name` placeholders the panel asks for before running.
     */
    async openQueryView(
        sql: string,
        title: string,
        viewColumn: vscode.ViewColumn = vscode.ViewColumn.Beside,
        savedQuery?: { id: string; parameters: SavedQueryParameter[]; values: Record<string, string> }
    ): Promise<void> {
        // Running the query needs a connection; without this the panel would
        // open and spin forever.
        if (!await this.connectionManager.ensureConnected()) {
            return;
        }

        const id = `query:${++this.querySessionCounter}`;
        const session = this.createSession(id, title, 'query', '', '', `query:${title}`, viewColumn);
        const parameters = savedQuery?.parameters ?? [];

        this.post(session, {
            command: 'init',
            origin: 'query',
            schema: '',
            table: '',
            title,
            sql,
            tableReference: '',
            alwaysQuote: vscode.workspace.getConfiguration('postgresQueryBuilder').get<boolean>('alwaysQuote', false),
            thousandSeparator: vscode.workspace.getConfiguration('postgresQueryBuilder').get<string>('thousandSeparator', ' '),
            connectionName: this.getConnectionName(),
            permanentConstraints: [],
            permanentSorts: [],
            savedQueryId: savedQuery?.id || '',
            savedQueryParameters: parameters,
            savedQueryValues: savedQuery?.values ?? {},
            // With placeholders the panel must collect values before it can run.
            awaitParameters: parameters.length > 0
        });
    }

    /** Maps each webview message command to its handler method. */
    private readonly messageHandlers: Record<string, (ctx: MessageContext) => Promise<void> | void> = {
        loadRows: this.handleLoadRows,
        getTotalCount: this.handleGetTotalCount,
        previewSQL: this.handlePreviewSQL,
        commitChanges: this.handleCommitChanges,
        showError: this.handleShowError,
        saveQueryHistory: this.handleSaveQueryHistory,
        getQueryHistory: this.handleGetQueryHistory,
        openForeignKey: this.handleOpenForeignKey,
        addCustomMapping: this.handleAddCustomMapping,
        updateCustomMapping: this.handleUpdateCustomMapping,
        deleteCustomMapping: this.handleDeleteCustomMapping,
        savePermanentConstraints: this.handleSavePermanentConstraints,
        getSavedQueries: this.handleGetSavedQueries,
        saveSavedQuery: this.handleSaveSavedQuery,
        deleteSavedQuery: this.handleDeleteSavedQuery,
        saveSavedQueryValues: this.handleSaveSavedQueryValues,
        getTablesForTypeahead: this.handleGetTablesForTypeahead,
        getColumnsForTypeahead: this.handleGetColumnsForTypeahead,
        browseExportLocation: this.handleBrowseExportLocation,
        getExportDefaults: this.handleGetExportDefaults,
        saveExportDefaults: this.handleSaveExportDefaults,
        exportData: this.handleExportData,
        selectConnection: this.handleSelectConnection,
        validateValue: this.handleValidateValue
    };

    /**
     * Run the SQL currently shown in a panel and push rows, columns and the
     * resulting capabilities back. This is the single data path of the Data
     * Viewer: the default table view is simply the query the panel starts with.
     */
    private async handleLoadRows(ctx: MessageContext): Promise<void> {
        const { session, message, queryRunner } = ctx;
        const sql: string = message.sql;
        const baseSql: string = message.baseSql || sql;
        const append = !!message.append;

        if (!sql || !sql.trim()) {
            this.post(session, { command: 'loadingFinished' });
            return;
        }
        if (!await this.connectionManager.ensureConnected()) {
            this.post(session, { command: 'loadingFinished' });
            return;
        }

        // Render columns + filter row immediately while the full query runs.
        let capabilities = append ? undefined : await this.tryPostEarlyColumns(session, baseSql);

        const execStart = Date.now();
        const result = await queryRunner.executeSQL(sql);
        const durationMs = Date.now() - execStart;

        if (this.modifyHistoryStore) {
            for (const stmt of splitSqlStatements(sql)) {
                if (isModifyingSql(stmt)) {
                    this.modifyHistoryStore.add({ sql: stmt, schema: session.schema, table: session.table });
                }
            }
        }

        const columns = await this.resolveResultColumns(result.fields || []);
        session.columns = columns;
        if (!append && !capabilities) {
            capabilities = await queryRunner.resolveEditPlan(result.fields || []);
        }

        const tableInfo = capabilities ? await this.adoptSourceTable(session, capabilities, queryRunner) : undefined;

        this.post(session, {
            command: 'rowsLoaded',
            rows: result.rows,
            columns,
            capabilities,
            append,
            connectionName: this.getConnectionName(),
            durationMs,
            ...tableInfo
        });

        if (append) {
            return;
        }

        if (message.wantTotal) {
            const totalCount = await queryRunner.getQueryRowCount(baseSql);
            this.post(session, { command: 'totalCountLoaded', totalCount });
        }

        // Deliver relation metadata for the single source table (if any) as it
        // resolves, so foreign-key navigation and mappings work for ad-hoc
        // queries too.
        if (capabilities && capabilities.schema && capabilities.table) {
            this.loadRelationMetadata(session, capabilities.schema, capabilities.table, queryRunner);
        }

        const pendingFilter = this.pendingFilters.get(session.id);
        if (pendingFilter) {
            this.pendingFilters.delete(session.id);
            this.post(session, {
                command: 'applyFilter',
                column: pendingFilter.column,
                value: pendingFilter.value,
                conditions: pendingFilter.conditions || []
            });
        }
    }

    /**
     * Remember the table a result came from and return the extra fields the
     * webview needs to treat it as that table's view (constraints, mappings,
     * default query).
     */
    private async adoptSourceTable(
        session: PanelSession,
        capabilities: ViewCapabilities,
        queryRunner: QueryRunner
    ): Promise<{ schema: string; table: string; tableReference: string; alwaysQuote: boolean; permanentConstraints: any[]; permanentSorts: any[] } | undefined> {
        if (!capabilities.schema || !capabilities.table) {
            return undefined;
        }
        session.schema = capabilities.schema;
        session.table = capabilities.table;
        const info = await queryRunner.getSelectBuildInfo(capabilities.schema, capabilities.table);
        return {
            schema: capabilities.schema,
            table: capabilities.table,
            tableReference: info.tableReference,
            alwaysQuote: info.alwaysQuote,
            permanentConstraints: this.permanentConstraintManager.getConstraints(capabilities.schema, capabilities.table),
            permanentSorts: this.permanentConstraintManager.getSorts(capabilities.schema, capabilities.table)
        };
    }

    /** Load primary keys, foreign keys, referencing tables and mappings. */
    private loadRelationMetadata(session: PanelSession, schema: string, table: string, queryRunner: QueryRunner): void {
        queryRunner.getPrimaryKeys(schema, table)
            .then(primaryKeys => this.post(session, { command: 'primaryKeysLoaded', primaryKeys }))
            .catch(err => console.warn(`Failed to load PKs: ${getErrorMessage(err)}`));

        queryRunner.getForeignKeys(schema, table)
            .then(foreignKeys => this.post(session, { command: 'foreignKeysLoaded', foreignKeys }))
            .catch(err => console.warn(`Failed to load FKs: ${getErrorMessage(err)}`));

        queryRunner.getReferencingTables(schema, table)
            .then(referencingTables => this.post(session, { command: 'referencingTablesLoaded', referencingTables }))
            .catch(err => console.warn(`Failed to load referencing tables: ${getErrorMessage(err)}`));

        this.post(session, {
            command: 'customMappingsLoaded',
            mappings: this.columnMappingManager.getMappingsForTable(schema, table)
        });
    }

    /**
     * Count all rows the current query returns. Requested explicitly (by
     * clicking the row-count indicator) because counting an arbitrary query can
     * be expensive.
     */
    private async handleGetTotalCount(ctx: MessageContext): Promise<void> {
        const { session, message, queryRunner } = ctx;
        const sql: string = message.sql;
        if (!sql || !sql.trim()) {
            return;
        }
        const totalCount = await queryRunner.getQueryRowCount(sql);
        this.post(session, { command: 'totalCountLoaded', totalCount });
    }

    /**
     * Normalize the write targets sent by the webview. Each target names the
     * source table its changes belong to, so a result joined from several
     * tables can be committed in one go.
     */
    private toCommitTargets(message: any): CommitTarget[] {
        const targets = Array.isArray(message.targets) ? message.targets : [];
        return targets
            .filter((t: any) => t && t.schema && t.table && t.changes)
            .map((t: any) => ({
                schema: String(t.schema),
                table: String(t.table),
                identityStrategy: t.identityStrategy,
                changes: {
                    updates: Array.isArray(t.changes.updates) ? t.changes.updates : [],
                    inserts: Array.isArray(t.changes.inserts) ? t.changes.inserts : [],
                    deletes: Array.isArray(t.changes.deletes) ? t.changes.deletes : []
                }
            }));
    }

    private async handlePreviewSQL(ctx: MessageContext): Promise<void> {
        const { session, message, queryRunner } = ctx;
        const sql = queryRunner.generateSQL(this.toCommitTargets(message));
        this.post(session, {
            command: 'sqlPreview',
            sql,
            connectionName: this.getConnectionName()
        });
    }

    private async handleCommitChanges(ctx: MessageContext): Promise<void> {
        const { session, message, queryRunner } = ctx;
        // The user may edit the statements in the preview dialog; then that
        // script is executed verbatim instead of the generated parameterized
        // statements.
        const editedSql: string = typeof message.sql === 'string' ? message.sql.trim() : '';
        if (editedSql) {
            await queryRunner.executeStatements(editedSql);
            this.recordModifyHistory(splitSqlStatements(editedSql).map(sql => ({
                sql,
                schema: session.schema,
                table: session.table
            })));
            this.post(session, { command: 'commitSuccess' });
            vscode.window.showInformationMessage('Edited statements committed');
            return;
        }

        const targets = this.toCommitTargets(message);
        if (targets.length === 0) {
            // Nothing could be mapped back to a table (e.g. computed columns
            // only) - tell the user instead of silently dropping the changes.
            throw new Error('These changes cannot be saved: no writable source table could be determined for them.');
        }
        await queryRunner.commitChanges(targets);
        this.recordModifyHistory(targets.flatMap(target =>
            splitSqlStatements(queryRunner.generateSQL([target]))
                .map(sql => ({ sql, schema: target.schema, table: target.table }))
        ));
        this.post(session, { command: 'commitSuccess' });
        const names = [...new Set(targets.map(t => `${t.schema}.${t.table}`))].join(', ');
        vscode.window.showInformationMessage(`Changes committed to ${names}`);
    }

    private recordModifyHistory(entries: Array<{ sql: string; schema?: string; table?: string }>): void {
        if (!this.modifyHistoryStore || entries.length === 0) {
            return;
        }
        try {
            this.modifyHistoryStore.addMany(entries);
        } catch { /* ignore history failures */ }
    }

    private handleShowError(ctx: MessageContext): void {
        vscode.window.showErrorMessage(ctx.message.text);
    }

    /**
     * Let the database decide whether an entered value fits its column. The
     * grid only asks for types it cannot judge itself (timestamps, enums, JSON,
     * custom types), so this costs one cheap round trip per such edit.
     */
    private async handleValidateValue(ctx: MessageContext): Promise<void> {
        const { session, message, queryRunner } = ctx;
        const column = session.columns.find((c) => c.name === message.column);
        const result = column
            ? await queryRunner.checkValueCast(column.fullType, message.value)
            : { valid: true };
        this.post(session, {
            command: 'validationResult',
            requestId: message.requestId,
            valid: result.valid,
            reason: (result as { reason?: string }).reason
        });
    }

    /**
     * Resolve the columns of a custom-query result: map each field's type OID to
     * a type name and look up the column comment for fields that come straight
     * from a table column (`tableID`/`columnID`). This makes the column-comment
     * tooltip work for custom SELECTs too, not just the default table view.
     */
    private async resolveResultColumns(fields: ReadonlyArray<ResultFieldInfo>): Promise<ResultColumn[]> {
        // Resolve field type OIDs to type names, and (OID, modifier) pairs to the
        // type as it is written in DDL: `format_type` is what tells the client
        // about `varchar(5)` or `numeric(10,2)`, so it can check entered values.
        const typed = fields.filter((f) => f.dataTypeID > 0);
        const typeMap: Record<number, string> = {};
        const fullTypeMap: Record<string, string> = {};
        if (typed.length > 0) {
            const typeRows = await this.connectionManager.query(
                `SELECT u.oid, u.typmod, t.typname, format_type(u.oid, u.typmod) AS full_type
                 FROM unnest($1::oid[], $2::int4[]) AS u(oid, typmod)
                 JOIN pg_type t ON t.oid = u.oid`,
                [typed.map((f) => f.dataTypeID), typed.map((f) => f.dataTypeModifier ?? -1)]
            );
            for (const row of typeRows.rows) {
                typeMap[row.oid] = row.typname;
                if (row.full_type) {
                    fullTypeMap[`${row.oid}:${row.typmod}`] = row.full_type;
                }
            }
        }

        // Resolve column comments for fields that originate from a table column.
        const commentMap: Record<string, string> = {};
        const tableIds = Array.from(new Set(fields.map((f) => f.tableID).filter((id): id is number => typeof id === 'number' && id > 0)));
        const columnIds = Array.from(new Set(fields.map((f) => f.columnID).filter((id): id is number => typeof id === 'number' && id > 0)));
        if (tableIds.length > 0 && columnIds.length > 0) {
            const descRows = await this.connectionManager.queryMetadata(
                `SELECT objoid, objsubid, description
                 FROM pg_catalog.pg_description
                 WHERE classoid = 'pg_catalog.pg_class'::regclass
                   AND objoid = ANY($1) AND objsubid = ANY($2)`,
                [tableIds, columnIds]
            );
            for (const row of descRows) {
                commentMap[`${row.objoid}:${row.objsubid}`] = row.description;
            }
        }

        return buildCustomResultColumns(fields, typeMap, commentMap, fullTypeMap);
    }

    /**
     * Try to resolve the columns of a query quickly (without fetching its rows)
     * and post them to the webview so the header and filter row render
     * immediately, before the full query returns. Returns the capabilities
     * derived from the probe, or `undefined` when the query cannot be probed
     * (non-SELECT, multiple statements, ...).
     */
    private async tryPostEarlyColumns(session: PanelSession, sql: string): Promise<ViewCapabilities | undefined> {
        try {
            const statements = splitSqlStatements(sql).map((s) => s.trim()).filter((s) => s.length > 0);
            if (statements.length !== 1) {
                return undefined;
            }
            const probeSql = buildColumnProbeSql(statements[0]);
            if (!probeSql) {
                return undefined;
            }
            const probe = await this.connectionManager.query(probeSql);
            if (!probe.fields || probe.fields.length === 0) {
                return undefined;
            }
            const columns = await this.resolveResultColumns(probe.fields);
            session.columns = columns;
            const queryRunner = new QueryRunner(this.connectionManager);
            const capabilities = await queryRunner.resolveEditPlan(probe.fields);
            this.post(session, { command: 'columnsLoaded', columns, capabilities });
            return capabilities;
        } catch {
            // Ignore probe failures (non-SELECT, multi-statement, invalid wrap,
            // etc.); the full query result renders the columns afterwards.
            return undefined;
        }
    }

    private handleSaveQueryHistory(ctx: MessageContext): void {
        const { session, message } = ctx;
        this.saveQueryToHistory(session.historyKey, message.sql);
        this.post(session, {
            command: 'queryHistoryUpdated',
            history: this.getQueryHistory(session.historyKey)
        });
    }

    private handleGetQueryHistory(ctx: MessageContext): void {
        const { session } = ctx;
        this.post(session, {
            command: 'queryHistoryUpdated',
            history: this.getQueryHistory(session.historyKey)
        });
    }

    private async handleSelectConnection(): Promise<void> {
        // Opens the connection picker. Switching fires onConnectionChanged,
        // which pushes a `connectionChanged` message back to every open panel.
        await this.connectionManager.selectConnection();
    }

    private async handleOpenForeignKey(ctx: MessageContext): Promise<void> {
        const { message } = ctx;
        const fkSchema = message.refSchema;
        const fkTable = message.refTable;
        const fkColumn = message.refColumn;
        const fkValue = message.value;
        const conditions = Array.isArray(message.conditions) ? message.conditions : [];
        await this.openTableViewWithFilter(fkSchema, fkTable, fkColumn, fkValue, conditions);
    }

    private async handleAddCustomMapping(ctx: MessageContext): Promise<void> {
        const { message } = ctx;
        const scope = message.scope === 'workspace' ? 'workspace' : 'global';
        await this.columnMappingManager.addMapping(message.mapping, scope);
        // onDidChange will broadcast to all panels.
    }

    private async handleUpdateCustomMapping(ctx: MessageContext): Promise<void> {
        await this.columnMappingManager.updateMapping(ctx.message.mappingId, ctx.message.mapping);
    }

    private async handleDeleteCustomMapping(ctx: MessageContext): Promise<void> {
        await this.columnMappingManager.deleteMapping(ctx.message.mappingId);
    }

    private async handleSavePermanentConstraints(ctx: MessageContext): Promise<void> {
        const { session, message } = ctx;
        if (!session.schema || !session.table) {
            vscode.window.showErrorMessage('Constraints can only be saved for a result that comes from a single table.');
            return;
        }
        await this.permanentConstraintManager.setConstraints(
            session.schema, session.table, Array.isArray(message.conditions) ? message.conditions : []
        );
        await this.permanentConstraintManager.setSorts(
            session.schema, session.table, Array.isArray(message.sorts) ? message.sorts : []
        );
    }

    private handleGetSavedQueries(ctx: MessageContext): void {
        this.post(ctx.session, {
            command: 'savedQueriesLoaded',
            queries: this.savedQueryStore?.getAll() ?? []
        });
    }

    /** Create or update a saved query from the panel's "Save Query" dialog. */
    private async handleSaveSavedQuery(ctx: MessageContext): Promise<void> {
        const { session, message } = ctx;
        if (!this.savedQueryStore) {
            return;
        }
        const name = typeof message.name === 'string' ? message.name.trim() : '';
        const sql = typeof message.sql === 'string' ? message.sql.trim() : '';
        if (!name || !sql) {
            vscode.window.showErrorMessage('A saved query needs a name and a SELECT statement.');
            return;
        }
        // Reconcile against the placeholders actually present, so a parameter
        // list edited in the dialog can never drift away from the SQL.
        const parameters = mergeParameters(sql, message.parameters);
        const scope = message.scope === 'workspace' ? 'workspace' : 'global';

        if (typeof message.id === 'string' && message.id && this.savedQueryStore.get(message.id)) {
            await this.savedQueryStore.update(message.id, { name, sql, parameters });
            this.post(session, { command: 'savedQuerySaved', id: message.id });
            vscode.window.showInformationMessage(`Updated saved query "${name}".`);
            return;
        }
        const created = await this.savedQueryStore.add(
            { name, sql, parameters, schema: session.schema, table: session.table }, scope
        );
        this.post(session, { command: 'savedQuerySaved', id: created.id });
        vscode.window.showInformationMessage(`Saved query "${name}".`);
    }

    private async handleDeleteSavedQuery(ctx: MessageContext): Promise<void> {
        if (typeof ctx.message.id === 'string' && ctx.message.id) {
            await this.savedQueryStore?.delete(ctx.message.id);
        }
    }

    private async handleSaveSavedQueryValues(ctx: MessageContext): Promise<void> {
        const { message } = ctx;
        if (typeof message.id === 'string' && message.id) {
            await this.savedQueryStore?.setParameterValues(message.id, message.values || {});
            await this.savedQueryStore?.touch(message.id);
        }
    }

    private async handleGetTablesForTypeahead(ctx: MessageContext): Promise<void> {
        const { session } = ctx;
        try {
            const tables = await this.connectionManager.queryMetadata(
                buildRelationListQuery()
            );
            this.post(session, {
                command: 'tablesForTypeahead',
                tables: tables.map((r) => ({ schema: r.table_schema, table: r.table_name }))
            });
        } catch (err: unknown) {
            console.warn(`Failed to load tables for typeahead: ${getErrorMessage(err)}`);
        }
    }

    private async handleGetColumnsForTypeahead(ctx: MessageContext): Promise<void> {
        const { session, message } = ctx;
        try {
            const cols = await this.connectionManager.queryMetadata(
                `SELECT column_name FROM information_schema.columns
                 WHERE table_schema = $1 AND table_name = $2
                 ORDER BY ordinal_position`,
                [message.schema, message.table]
            );
            this.post(session, {
                command: 'columnsForTypeahead',
                columns: cols.map((r) => r.column_name),
                forSchema: message.schema,
                forTable: message.table
            });
        } catch (err: unknown) {
            console.warn(`Failed to load columns for typeahead: ${getErrorMessage(err)}`);
        }
    }

    private async handleBrowseExportLocation(ctx: MessageContext): Promise<void> {
        const { session } = ctx;
        const folderUri = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select Export Folder'
        });
        if (folderUri && folderUri.length > 0) {
            this.post(session, {
                command: 'exportLocationSelected',
                path: folderUri[0].fsPath
            });
        }
    }

    private handleGetExportDefaults(ctx: MessageContext): void {
        this.post(ctx.session, {
            command: 'exportDefaultsLoaded',
            defaults: this.exportService.getDefaults()
        });
    }

    private handleSaveExportDefaults(ctx: MessageContext): void {
        const { message } = ctx;
        this.exportService.saveDefaults(message.format, message.options);
        if (message.saveLocation) {
            this.exportService.saveSaveLocation(message.saveLocation);
        }
        vscode.window.showInformationMessage(`Export defaults saved for ${message.format.toUpperCase()}`);
    }

    private async handleExportData(ctx: MessageContext): Promise<void> {
        const { session, message, queryRunner } = ctx;
        const opts = message.options;
        const { schema, table } = session;
        // Without a query and without a source table there is nothing to export.
        if (!message.sql && !table) {
            vscode.window.showErrorMessage('Export failed: no query to export.');
            return;
        }
        const extensions: Record<string, string> = { csv: '.csv', json: '.json', xml: '.xml', insert: '.sql', excel: '.xlsx' };
        const ext = extensions[opts.format] || '';
        const filterMap: Record<string, { [key: string]: string[] }> = {
            csv: { 'CSV Files': ['csv'] },
            json: { 'JSON Files': ['json'] },
            xml: { 'XML Files': ['xml'] },
            insert: { 'SQL Files': ['sql'] },
            excel: { 'Excel Files': ['xlsx'] }
        };

        // Determine default directory from saved location or workspace
        const savedLocation = opts.saveLocation || this.exportService.getSaveLocation();
        const defaultDir = savedLocation || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(defaultDir, opts.filename)),
            filters: filterMap[opts.format] || {}
        });

        if (!uri) return;

        try {
            // Fetch ALL rows from database (not limited by page size)
            let exportRows: any[];
            if (message.sql) {
                // Strip any existing LIMIT/OFFSET from the query for full export
                let sql = message.sql.replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$/i, '');
                const result = await queryRunner.executeSQL(sql);
                exportRows = result.rows;
            } else {
                // Fallback: fetch all from table
                const totalCount = await queryRunner.getRowCount(schema, table);
                exportRows = await queryRunner.fetchRows(schema, table, 0, totalCount);
            }

            await this.exportService.exportData(
                exportRows,
                message.columns,
                { ...opts, filePath: uri.fsPath }
            );
            this.post(session, {
                command: 'exportSuccess',
                filePath: uri.fsPath
            });
            vscode.window.showInformationMessage(`Exported ${exportRows.length} rows to ${path.basename(uri.fsPath)}`);
        } catch (exportErr: unknown) {
            vscode.window.showErrorMessage(`Export failed: ${getErrorMessage(exportErr)}`);
        }
    }

    private getWebviewContent(webview: vscode.Webview): string {
        const htmlPath = path.join(this.context.extensionPath, 'src', 'webview', 'tableView.html');
        const cssPath = path.join(this.context.extensionPath, 'src', 'webview', 'tableView.css');
        const jsPath = path.join(this.context.extensionPath, 'src', 'webview', 'tableView.js');

        let html = fs.readFileSync(htmlPath, 'utf8');
        const css = fs.readFileSync(cssPath, 'utf8');
        const js = fs.readFileSync(jsPath, 'utf8');

        // Inject CSS and JS inline for simplicity. The replacement must be a
        // function: with a string replacement, `$'`/`$&` inside the script (e.g.
        // a comparison against a '$' character) would expand to parts of the
        // HTML and corrupt the injected code.
        html = html.replace('/* CSS_PLACEHOLDER */', () => css);
        html = html.replace('/* JS_PLACEHOLDER */', () => js);

        return html;
    }

    private getConnectionName(): string {
        const cfg = this.connectionManager.getActiveConnectionConfig();
        if (!cfg) return '';
        return cfg.name || `${cfg.host}:${cfg.port}/${cfg.database}`;
    }

    private getQueryHistory(historyKey: string): { sql: string; lastUsed: number }[] {
        const key = `queryHistory:${historyKey}`;
        const history = this.context.globalState.get<{ sql: string; lastUsed: number }[]>(key, []);
        return history.sort((a, b) => b.lastUsed - a.lastUsed);
    }

    private saveQueryToHistory(historyKey: string, sql: string): void {
        const key = `queryHistory:${historyKey}`;
        let history = this.context.globalState.get<{ sql: string; lastUsed: number }[]>(key, []);
        // Remove existing entry for same SQL
        history = history.filter(h => h.sql !== sql);
        // Add at front with current timestamp
        history.unshift({ sql, lastUsed: Date.now() });
        // Keep max 50 entries
        if (history.length > 50) {
            history = history.slice(0, 50);
        }
        this.context.globalState.update(key, history);
    }

    async openTableViewWithFilter(schema: string, table: string, column: string, value: any, conditions: any[] = []): Promise<void> {
        const id = `table:${schema}.${table}`;
        const existing = this.sessions.get(id);

        if (existing) {
            // Panel already exists and has data loaded — send filter directly
            existing.panel.reveal();
            this.post(existing, {
                command: 'applyFilter',
                column: column,
                value: String(value),
                conditions: conditions || []
            });
        } else {
            // Panel will be created — store filter to send after the first load
            this.pendingFilters.set(id, { column, value: String(value), conditions: conditions || [] });
            await this.openTableView(schema, table);
        }
    }
}
