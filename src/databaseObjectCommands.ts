/**
 * Commands of the Objects and Tables views around database objects: their
 * CREATE and DROP scripts, *Go to Database Object*, *Go to Definition in
 * Repository*, *Show Only Differences*, *Show Empty Schemas*, *Rescan
 * Repository*, and the commands that also work from a SQL editor: *Reveal in
 * Objects View*, *Compare with Database*, *Find Usages* and *Show Dependencies*.
 *
 * The decisions — which DDL target a node stands for, the Quick Pick entries,
 * where a definition opens — are exported pure functions; the rest is the thin
 * VS Code wrapper around them.
 */
import * as vscode from 'vscode';
import type { ConnectionManager } from './connectionManager';
import {
    SERVER_VERSION_QUERY,
    buildDropStatement,
    combineScripts,
    fetchCreateScript,
    withQualifiedNames,
    type DdlContext,
    type DdlOptions,
    type DdlTarget
} from './ddlGenerator';
import {
    CLICK_ARGUMENT,
    KIND_META,
    objectDescription,
    objectLabel,
    type NavigatorNode,
    type ObjectNavigatorProvider,
    type ObjectNode
} from './objectNavigator';
import { RELATION_KIND_META, type TableExplorerProvider, type TableNode, type TreeNode } from './tableExplorer';
import type { LocatedDefinition, RepoStatus } from './repositoryComparison';
import { readRepositorySettings, type RepositoryIndex } from './repositoryIndex';
import { DoubleClickGate } from './doubleClick';
import { Logger, getErrorMessage } from './logger';
import { dbObjectIdentity, type DbEntry } from './databaseCatalog';
import type { ResolutionSources, ResolvedObject } from './sqlResolution';
import { commandNode, objectSignature, qualifiedName } from './sqlCodeIntel';
import { toLocation, toPosition, type SqlIntel } from './sqlLanguageFeatures';
import {
    KIND_CLASS,
    RELATION_OID_QUERY,
    SCHEMA_OID_QUERY,
    relationKindOf,
    type DependenciesProvider,
    type DependencyNode,
    type DependencyRow,
    type ViewNode
} from './objectDependencies';
import { formatSqlChecked } from './plpgsqlFormatter';
import { entryNode } from './comparisonView';
import type { ComparisonEntry } from './databaseComparison';
import { stripSqlComments, unifyTypeSpelling } from './repositoryScanner';
import { getFormatOptions } from './formatSettings';

/** A node of either view. */
export type DatabaseNode = NavigatorNode | TreeNode;

export const ONLY_DIFFERENCES_CONTEXT = 'postgresQueryBuilder.objectNavigator.onlyDifferences';
export const TABLES_EMPTY_SCHEMAS_CONTEXT = 'postgresQueryBuilder.tables.showEmptySchemas';
export const OBJECTS_EMPTY_SCHEMAS_CONTEXT = 'postgresQueryBuilder.objectNavigator.showEmptySchemas';
export const DDL_SCHEME = 'pgqb-ddl';

const RELATION_KINDS = new Set(['table', 'view', 'matview', 'foreign']);

/** The node of the Objects or Tables view behind an entry of the Dependencies view. */
export function unwrapNode(node: unknown): DatabaseNode | undefined {
    if (!node || typeof node !== 'object' || !('type' in node)) return undefined;
    const n = node as DatabaseNode | DependencyNode;
    if (n.type === 'dependency') return n.node as DatabaseNode | undefined;
    if (n.type === 'dependencyRoot') return n.root.node as DatabaseNode | undefined;
    if ((n as { type: string }).type === 'comparisonEntry') return entryNode((n as unknown as { entry: ComparisonEntry }).entry) as unknown as DatabaseNode;
    if (n.type === 'object' || n.type === 'table' || n.type === 'schema' || n.type === 'category' || n.type === 'extensions') return n;
    return undefined;
}

/** The object a node of the Objects or Tables view stands for, as the editor features resolve names. */
export function resolvedFromNode(node: DatabaseNode, sources: ResolutionSources): ResolvedObject | undefined {
    const { matcher, db } = sources;
    switch (node.type) {
        case 'object': {
            const definitions = (node.definitions ?? []).length > 0 ? node.definitions : undefined;
            if (node.db) {
                const obj = node.db;
                const schema = obj.kind === 'extension' ? '' : obj.schema;
                const table = obj.kind === 'trigger' ? obj.relName ?? undefined : undefined;
                const entry: DbEntry = db?.lookup(obj.kind, obj.kind === 'extension' ? null : obj.schema, obj.name).find(e => e.object?.oid === obj.oid)
                    ?? { kind: obj.kind, schema, name: obj.name, table, object: obj };
                return { kind: obj.kind, schema, name: obj.name, table, definitions: definitions ?? matcher?.find(dbObjectIdentity(obj)) ?? [], db: entry };
            }
            const identity = { kind: node.kind, schema: node.schema, name: node.name, argTypes: node.repoArgTypes, table: node.repoTable };
            return { kind: node.kind, schema: node.schema, name: node.name, table: node.repoTable, definitions: definitions ?? matcher?.find(identity) ?? [] };
        }
        case 'table': {
            const definitions = node.definitions && node.definitions.length > 0
                ? node.definitions
                : matcher?.find({ kind: node.kind, schema: node.schema, name: node.table }) ?? [];
            const entry: DbEntry | undefined = node.status === 'repoOnly' ? undefined
                : db?.lookup(node.kind, node.schema, node.table)[0]
                ?? { kind: node.kind, schema: node.schema, name: node.table, relation: { schema: node.schema, name: node.table, kind: node.kind } };
            return { kind: node.kind, schema: node.schema, name: node.table, definitions, db: entry };
        }
        case 'schema': {
            const definitions = node.definitions && node.definitions.length > 0
                ? node.definitions
                : matcher?.find({ kind: 'schema', schema: '', name: node.schema }) ?? [];
            const entry: DbEntry | undefined = node.status === 'repoOnly' ? undefined
                : db?.lookup('schema', null, node.schema)[0] ?? { kind: 'schema', schema: '', name: node.schema };
            return { kind: 'schema', schema: '', name: node.schema, definitions, db: entry };
        }
        default:
            return undefined;
    }
}

/** The repository side of *Compare with Database*: the statement, ending with a semicolon. */
export function statementText(text: string, def: LocatedDefinition): string {
    const lines = text.split('\n');
    const offset = (p: { line: number; character: number }): number =>
        lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
    const start = offset(def.statementStart ?? def.start);
    let end = offset(def.statementEnd ?? def.end);
    const semicolon = /^\s*;/.exec(text.slice(end));
    if (semicolon) end += semicolon[0].length;
    const statement = text.slice(start, end).trimEnd();
    return statement.endsWith(';') ? statement : `${statement};`;
}

/**
 * A script formatted with the user's formatter options, so a comparison shows
 * only real differences; as is when the formatter refuses. The options that
 * keep an author's one-line layout are off, so both sides get the same layout,
 * and blank lines go, as the formatter keeps them where the author left them.
 * With `ignoreComments`, comments are left out first: a migration tool that
 * turned line comments into block comments must not make every line differ.
 * With `ignoreTypeSpelling`, every spelling of a type is written the same way,
 * so `varchar` against `character varying` is no difference either.
 */
export function formatForCompare(script: string, ignoreComments = false, ignoreTypeSpelling = false): string {
    // Bodies saved from Windows keep CRLF in pg_proc; only the text is compared, not its line ends.
    const lf = script.replace(/\r\n?/g, '\n');
    const uncommented = ignoreComments ? stripSqlComments(lf) : lf;
    const text = ignoreTypeSpelling ? unifyTypeSpelling(uncommented) : uncommented;
    try {
        const outcome = formatSqlChecked(text, { ...getFormatOptions(), preserveSingleLineRoutineHeaders: false, preserveSingleLineIfBlocks: false });
        return outcome.ok ? withoutBlankLines(outcome.text) : text;
    } catch (err: unknown) {
        Logger.error('DatabaseObjects.formatForCompare', err);
        return text;
    }
}

function withoutBlankLines(text: string): string {
    return text.split('\n').filter(line => line.trim() !== '').join('\n');
}

/** Read-only documents for the two sides of *Compare with Database*. */
export class DdlContentProvider implements vscode.TextDocumentContentProvider {
    private readonly documents = new Map<string, string>();
    private next = 0;

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.documents.get(uri.toString()) ?? '';
    }

    /** A new document; old ones are dropped once there are many. */
    add(label: string, content: string): vscode.Uri {
        const uri = vscode.Uri.parse(`${DDL_SCHEME}:/${encodeURIComponent(label)}.sql?${++this.next}`);
        this.documents.set(uri.toString(), content);
        if (this.documents.size > 40) this.documents.delete(this.documents.keys().next().value!);
        return uri;
    }
}

/**
 * The object a node stands for when its DDL is asked for. Undefined for
 * groups and for objects that exist only in the repository: the database has
 * no DDL for those.
 */
export function ddlTargetOf(node: DatabaseNode): DdlTarget | undefined {
    switch (node.type) {
        case 'object': {
            const db = node.db;
            if (!db) return undefined;
            if (db.kind === 'trigger') {
                return { kind: 'trigger', schema: db.relSchema ?? db.schema, name: db.name, table: db.relName ?? '', oid: db.oid };
            }
            return { kind: db.kind, schema: db.schema, name: db.name, args: db.args, oid: db.oid };
        }
        case 'schema':
            return node.status === 'repoOnly' ? undefined : { kind: 'schema', schema: node.schema, name: node.schema };
        case 'table':
            return node.status === 'repoOnly' ? undefined : { kind: node.kind, schema: node.schema, name: node.table };
        default:
            return undefined;
    }
}

/** The targets of a command run on `node` with `selection` selected, without duplicates. */
export function ddlTargetsOf(node: DatabaseNode | undefined, selection: readonly DatabaseNode[] | undefined): DdlTarget[] {
    const nodes = selection && selection.length > 0 ? selection : node ? [node] : [];
    const seen = new Set<string>();
    const targets: DdlTarget[] = [];
    for (const n of nodes) {
        const target = ddlTargetOf(n);
        if (!target) continue;
        const key = `${target.kind}:${target.oid ?? `${target.schema}.${target.name}`}`;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push(target);
    }
    return targets;
}

/** One DROP script for all targets, in reverse order: what was created last is dropped first. */
export function buildDropScript(targets: readonly DdlTarget[]): string {
    return [...targets].reverse().map(buildDropStatement).join('\n') + '\n';
}

export function readDdlOptions(): DdlOptions {
    const cfg = vscode.workspace.getConfiguration('postgresQueryBuilder');
    return {
        includeComments: cfg.get<boolean>('ddl.includeComments', true),
        includeOwner: cfg.get<boolean>('ddl.includeOwner', true),
        includeGrants: cfg.get<boolean>('ddl.includeGrants', true)
    };
}

// ===== Go to Database Object =====

export interface GoToItem extends vscode.QuickPickItem {
    target: { view: 'objects'; node: ObjectNode } | { view: 'tables'; node: TableNode };
}

function statusSuffix(status: RepoStatus | undefined): string {
    if (status === 'repoOnly') return ' · only in repository';
    if (status === 'dbOnly') return ' · not in repository';
    return '';
}

/** The Quick Pick entries for every object and relation, sorted by name. */
export function buildGoToItems(objects: readonly ObjectNode[], relations: readonly TableNode[]): GoToItem[] {
    const items: Array<GoToItem & { sortKey: string }> = [];
    for (const node of objects) {
        const meta = KIND_META[node.kind];
        const label = objectLabel(node);
        const where = node.kind === 'extension' ? meta.singular : `${node.schema} · ${meta.singular}`;
        items.push({
            label: `$(${meta.icon}) ${label}`,
            description: where + statusSuffix(node.status),
            detail: node.db ? objectDescription(node) : undefined,
            target: { view: 'objects', node },
            sortKey: `${node.name}\u0000${node.schema}\u0000${label}`
        });
    }
    for (const node of relations) {
        const meta = RELATION_KIND_META[node.kind];
        items.push({
            label: `$(${meta.itemIcon}) ${node.table}`,
            description: `${node.schema} · ${meta.singular}${statusSuffix(node.status)}`,
            target: { view: 'tables', node },
            sortKey: `${node.table}\u0000${node.schema}\u0000${node.table}`
        });
    }
    items.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    return items.map(({ sortKey: _sortKey, ...item }) => item);
}

// ===== Go to Definition in Repository =====

/** A short name of the node for messages, e.g. `public.add_tax(numeric)`. */
export function nodeTitle(node: DatabaseNode): string {
    switch (node.type) {
        case 'object':
            return node.kind === 'extension' ? node.name : `${node.schema}.${objectLabel(node)}`;
        case 'schema':
            return node.schema;
        case 'table':
            return `${node.schema}.${node.table}`;
        case 'category':
            return node.schema;
        default:
            return 'Extensions';
    }
}

/** Definitions in a stable order: by file, then by line. */
export function sortDefinitions(definitions: readonly LocatedDefinition[]): LocatedDefinition[] {
    return [...definitions].sort((a, b) => a.uri.localeCompare(b.uri) || a.start.line - b.start.line);
}

export interface ObjectCommandDeps {
    connectionManager: ConnectionManager;
    objectNavigator: ObjectNavigatorProvider;
    tableExplorer: TableExplorerProvider;
    repositoryIndex: RepositoryIndex;
    objectsTreeView: vscode.TreeView<NavigatorNode>;
    tablesTreeView: vscode.TreeView<TreeNode>;
    /** Empty the Search field, which clears the filter of both views. */
    clearSearchFilter(): void;
    intel: SqlIntel;
    dependencies: DependenciesProvider;
}

/** The object a command is about: the node it was run on, else the name under the cursor of the SQL editor. */
export async function resolveCommandTarget(arg: unknown, intel: SqlIntel): Promise<ResolvedObject | undefined> {
    const sources = await intel.sources();
    const node = unwrapNode(arg);
    if (node) return resolvedFromNode(node, sources);
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage('Place the cursor on the name of a database object in a SQL file.');
        return undefined;
    }
    const { at } = await intel.objectsAt(editor.document, editor.selection.active);
    if (!at || at.objects.length === 0) {
        vscode.window.showInformationMessage(at
            ? `${at.reference.schema ? `${at.reference.schema}.` : ''}${at.reference.name} was found neither in the database nor in the repository.`
            : 'There is no name of a database object at the cursor.');
        return undefined;
    }
    if (at.objects.length === 1) return at.objects[0];
    const pick = await vscode.window.showQuickPick(
        at.objects.map(object => ({ label: objectSignature(object), object })),
        { placeHolder: `${at.reference.name} stands for ${at.objects.length} objects — choose one` }
    );
    return pick?.object;
}

export function registerDatabaseObjectCommands(context: vscode.ExtensionContext, deps: ObjectCommandDeps): void {
    const { connectionManager, objectNavigator, tableExplorer, repositoryIndex } = deps;
    const clicks = new DoubleClickGate();

    const targetsOrWarn = (node: DatabaseNode | undefined, selection: readonly DatabaseNode[] | undefined): DdlTarget[] => {
        const targets = ddlTargetsOf(node, selection);
        if (targets.length === 0) {
            vscode.window.showInformationMessage('Select an object of the database. Groups and objects that exist only in the repository have no DDL in the database.');
        }
        return targets;
    };

    const createScript = async (targets: DdlTarget[]): Promise<string | undefined> => {
        try {
            return await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: 'Reading the CREATE script' },
                async () => {
                    const versionRows = await connectionManager.queryMetadata(SERVER_VERSION_QUERY);
                    // A connection of its own: the empty search_path must hold for every query of the script.
                    const client = await connectionManager.openSessionClient();
                    const onError = (err: Error) => Logger.error('DatabaseObjects.createScript', err);
                    client.on('error', onError);
                    try {
                        return await withQualifiedNames(client, async (query) => {
                            const ctx: DdlContext = { query, options: readDdlOptions(), serverVersion: Number(versionRows[0]?.server_version_num ?? 0) };
                            const parts: string[] = [];
                            for (const target of targets) parts.push(await fetchCreateScript(ctx, target));
                            return combineScripts(parts);
                        });
                    } finally {
                        await client.end().catch(() => undefined);
                        client.removeListener('error', onError);
                    }
                }
            );
        } catch (err: unknown) {
            Logger.error('DatabaseObjects.createScript', err);
            vscode.window.showErrorMessage(`Could not read the CREATE script: ${getErrorMessage(err)}`);
            return undefined;
        }
    };

    const openScript = async (content: string): Promise<void> => {
        const doc = await vscode.workspace.openTextDocument({ language: 'sql', content });
        await vscode.window.showTextDocument(doc, { preview: false });
    };

    const copyScript = async (content: string, what: string): Promise<void> => {
        await vscode.env.clipboard.writeText(content);
        vscode.window.setStatusBarMessage(`${what} script copied to the clipboard`, 3000);
    };

    const definitionsOf = async (node: DatabaseNode): Promise<LocatedDefinition[]> => {
        if ('definitions' in node && Array.isArray(node.definitions)) return node.definitions;
        if (node.type === 'schema' || node.type === 'table') return (await tableExplorer.definitionsFor(node)) ?? [];
        return [];
    };

    const openDefinition = async (def: LocatedDefinition): Promise<void> => {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(def.uri));
        await vscode.window.showTextDocument(doc, {
            selection: new vscode.Range(def.start.line, def.start.character, def.end.line, def.end.character),
            preview: true
        });
    };

    const goToRepositoryDefinition = async (rawNode: unknown, arg?: unknown): Promise<void> => {
        const node = unwrapNode(rawNode);
        if (!node || node.type === 'category' || node.type === 'extensions') return;
        // A click on a tree item runs this command; only the second click of a double click jumps.
        if (arg === CLICK_ARGUMENT && !clicks.accept(`${node.type}:${nodeTitle(node)}:${node.type === 'object' ? node.kind : ''}`)) return;
        try {
            if (!readRepositorySettings().compare) {
                vscode.window.showInformationMessage('The comparison with the repository is turned off (postgresQueryBuilder.repository.compare).');
                return;
            }
            const snapshot = repositoryIndex.snapshot();
            if (!snapshot) {
                repositoryIndex.ensureScanned();
                vscode.window.showInformationMessage('The repository is still being scanned for CREATE statements. Try again in a moment.');
                return;
            }
            if (snapshot.definitions.length === 0) {
                vscode.window.showInformationMessage('No CREATE statements were found in the SQL files of the workspace.');
                return;
            }
            const definitions = sortDefinitions(await definitionsOf(node));
            if (definitions.length === 0) {
                vscode.window.showInformationMessage(`${nodeTitle(node)} was not found in the repository.`);
                return;
            }
            if (definitions.length === 1) {
                await openDefinition(definitions[0]);
                return;
            }
            const pick = await vscode.window.showQuickPick(
                definitions.map(def => ({
                    label: `${vscode.workspace.asRelativePath(vscode.Uri.parse(def.uri), true)}:${def.start.line + 1}`,
                    def
                })),
                { placeHolder: `${nodeTitle(node)} is created in ${definitions.length} places — choose one` }
            );
            if (pick) await openDefinition(pick.def);
        } catch (err: unknown) {
            Logger.error('DatabaseObjects.goToRepositoryDefinition', err);
            vscode.window.showErrorMessage(`Could not open the definition: ${getErrorMessage(err)}`);
        }
    };

    const setOnlyDifferences = async (value: boolean): Promise<void> => {
        await objectNavigator.setOnlyDifferences(value);
        await vscode.commands.executeCommand('setContext', ONLY_DIFFERENCES_CONTEXT, value);
    };

    const setTablesEmptySchemas = async (value: boolean): Promise<void> => {
        await tableExplorer.setShowEmptySchemas(value);
        await vscode.commands.executeCommand('setContext', TABLES_EMPTY_SCHEMAS_CONTEXT, value);
    };

    const setObjectsEmptySchemas = async (value: boolean): Promise<void> => {
        await objectNavigator.setShowEmptySchemas(value);
        await vscode.commands.executeCommand('setContext', OBJECTS_EMPTY_SCHEMAS_CONTEXT, value);
    };

    const revealOptions = { select: true, focus: true, expand: true };

    /** Reveal an entry, first clearing the Search filter or Show Only Differences when they hide it. */
    const revealDatabaseNode = async (target: GoToItem['target']): Promise<void> => {
        if (target.view === 'objects') {
            const node = target.node;
            if (objectNavigator.isFilteredOut(node)) deps.clearSearchFilter();
            if (objectNavigator.isHidden(node)) await setOnlyDifferences(false);
            await deps.objectsTreeView.reveal(node, revealOptions);
        } else {
            const node = target.node;
            if (tableExplorer.isFilteredOut(node)) deps.clearSearchFilter();
            await deps.tablesTreeView.reveal(node, revealOptions);
        }
    };

    /** Reveal a schema in the Objects view; one hidden only because it is empty turns Show Empty Schemas on. */
    const revealSchema = async (schema: string): Promise<boolean> => {
        let node = await objectNavigator.shownSchema(schema);
        if (!node && objectNavigator.isFiltering) {
            deps.clearSearchFilter();
            node = await objectNavigator.shownSchema(schema);
        }
        if (!node && !objectNavigator.showsEmptySchemas) {
            await setObjectsEmptySchemas(true);
            node = await objectNavigator.shownSchema(schema);
        }
        if (!node) return false;
        await deps.objectsTreeView.reveal(node, revealOptions);
        return true;
    };

    const targetObject = (arg: unknown): Promise<ResolvedObject | undefined> => resolveCommandTarget(arg, deps.intel);

    const revealInObjectView = async (arg?: unknown): Promise<void> => {
        try {
            const object = await targetObject(arg);
            if (!object || !(await connectionManager.ensureConnected())) return;
            if (object.kind === 'schema') {
                if (!(await revealSchema(object.name))) vscode.window.showInformationMessage(`The schema ${object.name} is not shown in the Objects view.`);
                return;
            }
            if (RELATION_KINDS.has(object.kind)) {
                const node = (await tableExplorer.allRelationNodes()).find(n => n.kind === object.kind && n.schema === object.schema && n.table === object.name);
                if (node) await revealDatabaseNode({ view: 'tables', node });
                else vscode.window.showInformationMessage(`${qualifiedName(object)} is not shown in the Tables view.`);
                return;
            }
            const oid = object.db?.object?.oid;
            const node = (await objectNavigator.allObjectNodes()).find(n => n.kind === object.kind && (oid !== undefined
                ? n.db?.oid === oid
                : !n.db && n.schema === object.schema && n.name === object.name && (n.repoTable ?? '') === (object.table ?? '')
                    && (n.repoArgTypes ?? []).join(',') === (object.definitions[0]?.argTypes ?? []).join(',')));
            if (node) await revealDatabaseNode({ view: 'objects', node });
            else vscode.window.showInformationMessage(`${qualifiedName(object)} is not shown in the Objects view; check the object kinds and extension settings of the view.`);
        } catch (err: unknown) {
            Logger.error('DatabaseObjects.revealInObjectView', err);
            vscode.window.showErrorMessage(`Reveal in Objects View failed: ${getErrorMessage(err)}`);
        }
    };

    const ddlDocuments = new DdlContentProvider();

    /** The definition to compare: the one the CodeLens sits on, the only one, or the one the user picks. */
    const pickDefinition = async (object: ResolvedObject, at: unknown): Promise<LocatedDefinition | undefined> => {
        const definitions = sortDefinitions(object.definitions);
        if (at && typeof at === 'object' && 'uri' in at && 'line' in at) {
            const { uri, line } = at as { uri: string; line: number };
            const found = definitions.find(d => d.uri === uri && (d.statementStart ?? d.start).line === line);
            if (found) return found;
        }
        if (definitions.length === 1) return definitions[0];
        const dbHash = object.db?.object?.bodyHash;
        const items = definitions.map(def => ({
            label: `${vscode.workspace.asRelativePath(vscode.Uri.parse(def.uri), true)}:${def.start.line + 1}`,
            description: dbHash && def.bodyHash === dbHash ? 'same body as the database' : undefined,
            def
        }));
        items.sort((a, b) => Number(!!b.description) - Number(!!a.description));
        const pick = await vscode.window.showQuickPick(items, { placeHolder: `${qualifiedName(object)} is created in ${definitions.length} places — choose the one to compare` });
        return pick?.def;
    };

    const compareWithDatabase = async (arg?: unknown, at?: unknown): Promise<void> => {
        try {
            const object = await targetObject(arg);
            if (!object) return;
            const node = commandNode(object);
            const target = node ? ddlTargetOf(node as unknown as DatabaseNode) : undefined;
            if (!object.db || !target) {
                vscode.window.showInformationMessage(`${qualifiedName(object)} does not exist in the database.`);
                return;
            }
            if (object.definitions.length === 0) {
                vscode.window.showInformationMessage(`${qualifiedName(object)} was not found in the repository.`);
                return;
            }
            const def = await pickDefinition(object, at);
            if (!def || !(await connectionManager.ensureConnected())) return;
            const repoDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse(def.uri));
            const config = vscode.workspace.getConfiguration('postgresQueryBuilder');
            const ignoreComments = config.get<boolean>('repository.compareIgnoresComments', true);
            const ignoreTypeSpelling = config.get<boolean>('repository.compareIgnoresTypeSpelling', true);
            const left = formatForCompare(statementText(repoDoc.getText(), def), ignoreComments, ignoreTypeSpelling);
            const script = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: 'Reading the CREATE script' },
                async () => {
                    const versionRows = await connectionManager.queryMetadata(SERVER_VERSION_QUERY);
                    // The connection's own search_path: names come out as unqualified as the repository writes them.
                    const client = await connectionManager.openSessionClient();
                    const onError = (err: Error) => Logger.error('DatabaseObjects.compareWithDatabase', err);
                    client.on('error', onError);
                    try {
                        const ctx: DdlContext = {
                            query: async (sql, params) => (await client.query(sql, params)).rows,
                            options: { includeComments: false, includeOwner: false, includeGrants: false },
                            serverVersion: Number(versionRows[0]?.server_version_num ?? 0)
                        };
                        return await fetchCreateScript(ctx, target);
                    } finally {
                        await client.end().catch(() => undefined);
                        client.removeListener('error', onError);
                    }
                }
            );
            const right = formatForCompare(script, ignoreComments, ignoreTypeSpelling);
            const name = qualifiedName(object);
            await vscode.commands.executeCommand(
                'vscode.diff',
                ddlDocuments.add(`${name} (repository)`, left),
                ddlDocuments.add(`${name} (database)`, right),
                `${name}: Repository ↔ Database`
            );
        } catch (err: unknown) {
            Logger.error('DatabaseObjects.compareWithDatabase', err);
            vscode.window.showErrorMessage(`Compare with Database failed: ${getErrorMessage(err)}`);
        }
    };

    const findUsages = async (arg?: unknown): Promise<void> => {
        try {
            if (!readRepositorySettings().compare) {
                vscode.window.showInformationMessage('The comparison with the repository is turned off (postgresQueryBuilder.repository.compare).');
                return;
            }
            const object = await targetObject(arg);
            if (!object) return;
            if (!repositoryIndex.snapshot()) {
                vscode.window.showInformationMessage('The repository is still being scanned for CREATE statements. Try again in a moment.');
                return;
            }
            const refs = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: `Searching the repository for ${qualifiedName(object)}` },
                () => deps.intel.references([object], true)
            );
            if (refs.length === 0) {
                vscode.window.showInformationMessage(`No references to ${qualifiedName(object)} were found in the repository.`);
                return;
            }
            const anchor = sortDefinitions(object.definitions)[0] ?? refs[0];
            await vscode.commands.executeCommand('editor.action.showReferences', vscode.Uri.parse(anchor.uri), toPosition(anchor.start), refs.map(toLocation));
        } catch (err: unknown) {
            Logger.error('DatabaseObjects.findUsages', err);
            vscode.window.showErrorMessage(`Find Usages failed: ${getErrorMessage(err)}`);
        }
    };

    const showDependencies = async (arg?: unknown): Promise<void> => {
        try {
            const object = await targetObject(arg);
            if (!object) return;
            if (!object.db) {
                vscode.window.showInformationMessage(`${qualifiedName(object)} exists only in the repository; the database records no dependencies for it.`);
                return;
            }
            if (!(await connectionManager.ensureConnected())) return;
            const classid = KIND_CLASS[object.kind];
            let oid = object.db.object?.oid;
            if (oid === undefined) {
                const rows = object.kind === 'schema'
                    ? await connectionManager.queryMetadata(SCHEMA_OID_QUERY, [object.name])
                    : await connectionManager.queryMetadata(RELATION_OID_QUERY, [object.schema, object.name]);
                if (rows.length === 0) {
                    vscode.window.showInformationMessage(`${qualifiedName(object)} was not found in the database.`);
                    return;
                }
                oid = Number(rows[0].oid);
            }
            const compare = readRepositorySettings().compare;
            deps.dependencies.setRoot({
                target: { classid, oid },
                title: objectSignature(object),
                icon: object.kind === 'schema' ? 'symbol-namespace' : RELATION_KINDS.has(object.kind) ? 'table' : 'symbol-misc',
                node: commandNode(object) as ViewNode | undefined,
                usages: compare ? () => deps.intel.references([object], false) : undefined
            });
            await vscode.commands.executeCommand('postgresObjectDependencies.focus');
        } catch (err: unknown) {
            Logger.error('DatabaseObjects.showDependencies', err);
            vscode.window.showErrorMessage(`Show Dependencies failed: ${getErrorMessage(err)}`);
        }
    };

    const goToDatabaseObject = async (): Promise<void> => {
        if (!(await connectionManager.ensureConnected())) return;
        try {
            const [objects, relations] = await Promise.all([objectNavigator.allObjectNodes(), tableExplorer.allRelationNodes()]);
            const items = buildGoToItems(objects, relations);
            if (items.length === 0) {
                vscode.window.showInformationMessage('The database has no objects to go to.');
                return;
            }
            const pick = await vscode.window.showQuickPick(items, {
                placeHolder: 'Go to a function, procedure, type, table or other database object',
                matchOnDescription: true,
                matchOnDetail: true
            });
            if (!pick) return;
            await revealDatabaseNode(pick.target);
        } catch (err: unknown) {
            Logger.error('DatabaseObjects.goToDatabaseObject', err);
            vscode.window.showErrorMessage(`Go to Database Object failed: ${getErrorMessage(err)}`);
        }
    };

    const withConnection = (run: (targets: DdlTarget[]) => Promise<void>) =>
        async (rawNode?: unknown, rawSelection?: unknown[]): Promise<void> => {
            const node = unwrapNode(rawNode);
            const selection = Array.isArray(rawSelection)
                ? rawSelection.map(unwrapNode).filter((n): n is DatabaseNode => n !== undefined)
                : undefined;
            const targets = targetsOrWarn(node, selection);
            if (targets.length === 0) return;
            if (!(await connectionManager.ensureConnected())) return;
            await run(targets);
        };

    context.subscriptions.push(
        vscode.commands.registerCommand('postgresQueryBuilder.openCreateScript', withConnection(async (targets) => {
            const script = await createScript(targets);
            if (script !== undefined) await openScript(script);
        })),
        vscode.commands.registerCommand('postgresQueryBuilder.copyCreateScript', withConnection(async (targets) => {
            const script = await createScript(targets);
            if (script !== undefined) await copyScript(script, 'CREATE');
        })),
        vscode.commands.registerCommand('postgresQueryBuilder.openDropScript', withConnection(async (targets) => {
            await openScript(buildDropScript(targets));
        })),
        vscode.commands.registerCommand('postgresQueryBuilder.copyDropScript', withConnection(async (targets) => {
            await copyScript(buildDropScript(targets), 'DROP');
        })),
        vscode.commands.registerCommand('postgresQueryBuilder.goToRepositoryDefinition', goToRepositoryDefinition),
        vscode.commands.registerCommand('postgresQueryBuilder.goToDatabaseObject', goToDatabaseObject),
        vscode.commands.registerCommand('postgresQueryBuilder.refreshObjectNavigator', () => objectNavigator.refresh()),
        vscode.commands.registerCommand('postgresQueryBuilder.showOnlyDifferences', () => setOnlyDifferences(true)),
        vscode.commands.registerCommand('postgresQueryBuilder.showAllObjects', () => setOnlyDifferences(false)),
        vscode.commands.registerCommand('postgresQueryBuilder.showEmptySchemas', () => setTablesEmptySchemas(true)),
        vscode.commands.registerCommand('postgresQueryBuilder.hideEmptySchemas', () => setTablesEmptySchemas(false)),
        vscode.commands.registerCommand('postgresQueryBuilder.showEmptyObjectSchemas', () => setObjectsEmptySchemas(true)),
        vscode.commands.registerCommand('postgresQueryBuilder.hideEmptyObjectSchemas', () => setObjectsEmptySchemas(false)),
        vscode.commands.registerCommand('postgresQueryBuilder.revealInObjectView', revealInObjectView),
        vscode.commands.registerCommand('postgresQueryBuilder.compareWithDatabase', compareWithDatabase),
        vscode.commands.registerCommand('postgresQueryBuilder.findUsages', findUsages),
        vscode.commands.registerCommand('postgresQueryBuilder.showDependencies', showDependencies),
        vscode.commands.registerCommand('postgresQueryBuilder.refreshDependencies', () => deps.dependencies.refresh()),
        vscode.commands.registerCommand('postgresQueryBuilder.clearDependencies', () => deps.dependencies.clear()),
        vscode.workspace.registerTextDocumentContentProvider(DDL_SCHEME, ddlDocuments),
        vscode.commands.registerCommand('postgresQueryBuilder.rescanRepository', async () => {
            try {
                await repositoryIndex.rescan();
            } catch (err: unknown) {
                Logger.error('DatabaseObjects.rescanRepository', err);
                vscode.window.showErrorMessage(`Rescanning the repository failed: ${getErrorMessage(err)}`);
            }
        })
    );
    void vscode.commands.executeCommand('setContext', ONLY_DIFFERENCES_CONTEXT, objectNavigator.showsOnlyDifferences);
    void vscode.commands.executeCommand('setContext', TABLES_EMPTY_SCHEMAS_CONTEXT, tableExplorer.showsEmptySchemas);
    void vscode.commands.executeCommand('setContext', OBJECTS_EMPTY_SCHEMAS_CONTEXT, objectNavigator.showsEmptySchemas);
}

/** The node of the Objects or Tables view a row of the Dependencies view stands for. */
export async function dependencyRowNode(row: DependencyRow, intel: SqlIntel): Promise<ViewNode | undefined> {
    if (row.classid === 'pg_class') {
        const kind = relationKindOf(row.relKind);
        if (kind && kind !== 'sequence' && row.schema && row.relName) return { type: 'table', schema: row.schema, table: row.relName, kind };
    }
    const sources = await intel.sources();
    const data = await intel.catalog.load();
    const obj = data.objects.find(o => o.oid === row.oid && KIND_CLASS[o.kind] === row.classid);
    if (!obj) return undefined;
    return { type: 'object', kind: obj.kind, schema: obj.schema, name: obj.name, args: obj.args, db: obj, definitions: sources.matcher?.find(dbObjectIdentity(obj)) ?? [] };
}
