/**
 * Commands of the Objects and Tables views around database objects: their
 * CREATE and DROP scripts, *Go to Database Object*, *Go to Definition in
 * Repository*, *Show Only Differences* and *Rescan Repository*.
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

/** A node of either view. */
export type DatabaseNode = NavigatorNode | TreeNode;

export const ONLY_DIFFERENCES_CONTEXT = 'postgresQueryBuilder.objectNavigator.onlyDifferences';

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

    const goToRepositoryDefinition = async (node: DatabaseNode | undefined, arg?: unknown): Promise<void> => {
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
            const reveal = { select: true, focus: true, expand: true };
            if (pick.target.view === 'objects') {
                const node = pick.target.node;
                if (objectNavigator.isFilteredOut(node)) deps.clearSearchFilter();
                if (objectNavigator.isHidden(node)) await setOnlyDifferences(false);
                await deps.objectsTreeView.reveal(node, reveal);
            } else {
                const node = pick.target.node;
                if (tableExplorer.isFilteredOut(node)) deps.clearSearchFilter();
                await deps.tablesTreeView.reveal(node, reveal);
            }
        } catch (err: unknown) {
            Logger.error('DatabaseObjects.goToDatabaseObject', err);
            vscode.window.showErrorMessage(`Go to Database Object failed: ${getErrorMessage(err)}`);
        }
    };

    const withConnection = (run: (targets: DdlTarget[]) => Promise<void>) =>
        async (node?: DatabaseNode, selection?: DatabaseNode[]): Promise<void> => {
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
}
