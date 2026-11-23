/**
 * The Comparison view: the result of *Compare Repository with Database*,
 * grouped into what differs, what exists only in the database and what exists
 * only in the repository, then by kind. Every entry carries the node shape
 * of the Objects and Tables views, so their commands — Compare with Database,
 * Go to Definition in Repository, Reveal, the DDL scripts — work here too.
 */
import * as vscode from 'vscode';
import type { RepoObjectKind } from './repositoryScanner';
import { DefinitionMatcher, type ComparisonMarks } from './repositoryComparison';
import {
    COMPARISON_KINDS,
    COMPARISON_KIND_MEMBERS,
    runComparison,
    type ComparisonEntry,
    type ComparisonKind,
    type ComparisonResult,
    type ComparisonStatus,
    type LocatedStatement
} from './databaseComparison';
import { scanStructure } from './ddlCompare';
import { alterTableScript } from './alterTableScript';
import type { DatabaseCatalog } from './databaseCatalog';
import type { RepositoryIndex } from './repositoryIndex';
import { readRepositorySettings } from './repositoryIndex';
import { CLICK_ARGUMENT } from './objectNavigator';
import { Logger, getErrorMessage } from './logger';

export const COMPARISON_VIEW = 'postgresComparison';

const STATUS_ORDER: ComparisonStatus[] = ['differs', 'dbOnly', 'repoOnly'];
const STATUS_LABELS: Record<ComparisonStatus, string> = {
    differs: 'Differs',
    dbOnly: 'Only in the database',
    repoOnly: 'Only in the repository'
};
const KIND_LABELS: Partial<Record<RepoObjectKind, string>> = {
    function: 'Functions', procedure: 'Procedures', aggregate: 'Aggregates', table: 'Tables', view: 'Views',
    matview: 'Materialized Views', type: 'Types', domain: 'Domains', sequence: 'Sequences', trigger: 'Triggers'
};
const KIND_ICONS: Partial<Record<RepoObjectKind, string>> = {
    function: 'symbol-function', procedure: 'symbol-method', aggregate: 'symbol-operator', table: 'table', view: 'eye',
    matview: 'layers', type: 'symbol-class', domain: 'symbol-type-parameter', sequence: 'symbol-number', trigger: 'zap'
};
const RELATIONS = new Set<RepoObjectKind>(['table', 'view', 'matview', 'foreign']);

export type ComparisonNode =
    | { type: 'comparisonStatus'; status: ComparisonStatus }
    | { type: 'comparisonKind'; status: ComparisonStatus; kind: RepoObjectKind }
    | { type: 'comparisonEntry'; entry: ComparisonEntry }
    | { type: 'comparisonDifference'; path: string; message: string }
    | { type: 'comparisonMessage'; message: string };

/** The node of the Objects or Tables view an entry stands for, so their commands apply. */
export function entryNode(entry: ComparisonEntry): Record<string, unknown> {
    const definitions = entry.definitions;
    const status = entry.status === 'repoOnly' ? 'repoOnly' : entry.status === 'dbOnly' ? 'dbOnly' : 'differs';
    if (RELATIONS.has(entry.kind)) return { type: 'table', schema: entry.schema, table: entry.name, kind: entry.kind, status, definitions };
    if (entry.db) {
        return { type: 'object', kind: entry.db.kind, schema: entry.db.schema, name: entry.db.name, args: entry.db.args, db: entry.db, status, definitions };
    }
    const routine = entry.kind === 'function' || entry.kind === 'procedure' || entry.kind === 'aggregate';
    return {
        type: 'object', kind: entry.kind, schema: entry.schema, name: entry.name, args: entry.args ?? null,
        repoArgTypes: routine ? (entry.args ? entry.args.split(', ') : []) : undefined,
        repoTable: entry.kind === 'trigger' ? entry.table : undefined,
        status, definitions
    };
}

/** The context value of an entry, matching the views' menus. */
export function entryContextValue(entry: ComparisonEntry): string {
    if (RELATIONS.has(entry.kind)) {
        if (entry.status === 'repoOnly') return 'table.repoOnly';
        return entry.tables ? 'table.differs' : 'table';
    }
    return `${entry.db ? 'dbObject' : 'repoObject'}.${entry.kind}`;
}

/** The ALTER TABLE script of a differing table entry, or null when the entry has none. */
export function entryAlterScript(entry: ComparisonEntry | undefined, columnOrder = false, now?: Date): string | null {
    if (!entry?.tables) return null;
    return alterTableScript({ schema: entry.schema, table: entry.name, ...entry.tables, columnOrder, now });
}

const entryKey = (kind: RepoObjectKind, schema: string, name: string, table?: string): string =>
    `${kind}:${schema}.${table ? `${table}.` : ''}${name}`;

/** The marks the trees show for a result: the objects found differing, with what differs. */
export function marksOf(result: ComparisonResult): ComparisonMarks {
    const map = new Map<string, ComparisonEntry['differences']>();
    for (const e of result.entries) {
        if (e.status === 'differs') map.set(entryKey(e.kind, e.schema, e.name, e.kind === 'trigger' ? e.table : undefined), e.differences);
    }
    return { differences: (kind, schema, name, table) => map.get(entryKey(kind, schema, name, kind === 'trigger' ? table : undefined)) };
}

function entryLabel(entry: ComparisonEntry): string {
    if (entry.kind === 'trigger' && entry.table) return `${entry.schema}.${entry.table}.${entry.name}`;
    const routine = entry.kind === 'function' || entry.kind === 'procedure' || entry.kind === 'aggregate';
    return `${entry.schema}.${entry.name}${routine ? `(${entry.args ?? ''})` : ''}`;
}

/** The result as a Markdown report. */
export function comparisonReport(result: ComparisonResult, kinds: ReadonlySet<RepoObjectKind> | null): string {
    const shown = result.entries.filter(e => !kinds || kinds.has(e.kind));
    const lines = [
        '# Repository and database compared',
        '',
        `${new Date(result.finishedAt).toISOString()} · ${(result.durationMs / 1000).toFixed(1)} s · ${result.equal} equal`,
        ''
    ];
    for (const status of STATUS_ORDER) {
        const entries = shown.filter(e => e.status === status);
        lines.push(`## ${STATUS_LABELS[status]} (${entries.length})`, '');
        for (const e of entries) {
            lines.push(`- **${KIND_LABELS[e.kind] ?? e.kind}** \`${entryLabel(e)}\``);
            for (const d of e.differences) lines.push(`    - ${d.path}: ${d.message}`);
        }
        lines.push('');
    }
    if (result.problems.length > 0) lines.push('## Not compared', '', ...result.problems.map(p => `- ${p}`), '');
    return lines.join('\n');
}

export class ComparisonProvider implements vscode.TreeDataProvider<ComparisonNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<ComparisonNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private result: ComparisonResult | null = null;
    private kinds: Set<RepoObjectKind> | null = null;

    get current(): ComparisonResult | null {
        return this.result;
    }

    get kindFilter(): ReadonlySet<RepoObjectKind> | null {
        return this.kinds;
    }

    setResult(result: ComparisonResult | null): void {
        this.result = result;
        this._onDidChangeTreeData.fire();
    }

    setKindFilter(kinds: Set<RepoObjectKind> | null): void {
        this.kinds = kinds;
        this._onDidChangeTreeData.fire();
    }

    private entries(status: ComparisonStatus, kind?: RepoObjectKind): ComparisonEntry[] {
        return (this.result?.entries ?? []).filter(e => e.status === status && (!kind || e.kind === kind) && (!this.kinds || this.kinds.has(e.kind)));
    }

    getChildren(element?: ComparisonNode): ComparisonNode[] {
        if (!this.result) return [];
        if (!element) {
            const roots: ComparisonNode[] = STATUS_ORDER.map(status => ({ type: 'comparisonStatus' as const, status }));
            if (this.result.cancelled) roots.unshift({ type: 'comparisonMessage', message: 'The comparison was cancelled; the result is incomplete.' });
            for (const problem of this.result.problems) roots.push({ type: 'comparisonMessage', message: `Not compared: ${problem}` });
            return roots;
        }
        switch (element.type) {
            case 'comparisonStatus': {
                const kinds = [...new Set(this.entries(element.status).map(e => e.kind))];
                return kinds.map(kind => ({ type: 'comparisonKind' as const, status: element.status, kind }));
            }
            case 'comparisonKind':
                return this.entries(element.status, element.kind).map(entry => ({ type: 'comparisonEntry' as const, entry }));
            case 'comparisonEntry':
                return element.entry.differences.map(d => ({ type: 'comparisonDifference' as const, ...d }));
            default:
                return [];
        }
    }

    getTreeItem(element: ComparisonNode): vscode.TreeItem {
        const { Collapsed, Expanded, None } = vscode.TreeItemCollapsibleState;
        switch (element.type) {
            case 'comparisonStatus': {
                const count = this.entries(element.status).length;
                const item = new vscode.TreeItem(`${STATUS_LABELS[element.status]} (${count})`, count === 0 ? None : element.status === 'differs' ? Expanded : Collapsed);
                item.iconPath = new vscode.ThemeIcon(element.status === 'differs' ? 'diff' : element.status === 'dbOnly' ? 'database' : 'file-code');
                item.contextValue = 'comparisonStatus';
                if (element.status === 'differs' && this.result) {
                    item.description = `${this.result.equal} equal · ${(this.result.durationMs / 1000).toFixed(1)} s`;
                }
                return item;
            }
            case 'comparisonKind': {
                const count = this.entries(element.status, element.kind).length;
                const item = new vscode.TreeItem(`${KIND_LABELS[element.kind] ?? element.kind} (${count})`, Collapsed);
                item.iconPath = new vscode.ThemeIcon('folder');
                item.contextValue = 'comparisonKind';
                return item;
            }
            case 'comparisonEntry': {
                const { entry } = element;
                const item = new vscode.TreeItem(entryLabel(entry), entry.differences.length > 0 ? Collapsed : None);
                item.iconPath = new vscode.ThemeIcon(KIND_ICONS[entry.kind] ?? 'symbol-misc');
                item.description = entry.differences.length > 0 ? `${entry.differences.length} difference${entry.differences.length === 1 ? '' : 's'}` : undefined;
                item.contextValue = entryContextValue(entry);
                item.tooltip = [entryLabel(entry), STATUS_LABELS[entry.status], ...entry.differences.map(d => `• ${d.path}: ${d.message}`)].join('\n');
                if (entry.definitions.length > 0) {
                    item.command = {
                        command: 'postgresQueryBuilder.goToRepositoryDefinition',
                        title: 'Go to Definition in Repository',
                        arguments: [entryNode(entry), CLICK_ARGUMENT]
                    };
                }
                return item;
            }
            case 'comparisonDifference': {
                const item = new vscode.TreeItem(element.path, None);
                item.description = element.message;
                item.tooltip = `${element.path}: ${element.message}`;
                item.iconPath = new vscode.ThemeIcon('circle-small');
                item.contextValue = 'comparisonDifference';
                return item;
            }
            default: {
                const item = new vscode.TreeItem(element.message, None);
                item.iconPath = new vscode.ThemeIcon('warning');
                item.contextValue = 'comparisonMessage';
                return item;
            }
        }
    }
}

export interface ComparisonDeps {
    connectionManager: {
        ensureConnected(): Promise<boolean>;
        openSessionClient(): Promise<{
            query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
            end(): Promise<void>;
            on(event: 'error', listener: (err: Error) => void): unknown;
            removeListener(event: 'error', listener: (err: Error) => void): unknown;
        }>;
    };
    catalog: DatabaseCatalog;
    repositoryIndex: RepositoryIndex;
    /** The trees that show the marks. */
    trees: Array<{ setComparisonMarks(marks: ComparisonMarks | null): void }>;
}

const TIMEOUT = '300s';

/** How a comparison run reports its progress and learns that it was cancelled. */
export interface ComparisonRun {
    isCancelled(): boolean;
    report(message: string): void;
}

/**
 * Compare the repository with the database of the active connection. Resolves
 * to the result, to a message telling why nothing was compared, or to null when
 * the run was cancelled. Nothing of the run is kept in the database.
 */
export async function computeComparison(
    deps: Pick<ComparisonDeps, 'connectionManager' | 'catalog' | 'repositoryIndex'>,
    run: ComparisonRun,
    columnOrder: boolean
): Promise<ComparisonResult | string | null> {
    run.report('Scanning the repository');
    await deps.repositoryIndex.whenScanned();
    const snapshot = deps.repositoryIndex.snapshot();
    if (!snapshot || snapshot.definitions.length === 0) {
        return 'No CREATE statements were found in the SQL files of the workspace.';
    }
    const statements: LocatedStatement[] = [];
    await deps.repositoryIndex.readAll((uri, text) => {
        for (const s of scanStructure(text)) statements.push({ ...s, uri });
    }, () => run.isCancelled());
    if (run.isCancelled()) return null;
    run.report('Reading the database catalog');
    const [data, relations, unmarked] = await Promise.all([deps.catalog.load(), deps.catalog.relations(), deps.catalog.unmarked()]);
    const client = await deps.connectionManager.openSessionClient();
    const onError = (err: Error): void => Logger.error('Comparison.client', err);
    client.on('error', onError);
    try {
        // Nothing of the run is kept: the temporary views go with the rollback.
        await client.query('BEGIN');
        await client.query(`SET LOCAL statement_timeout = '${TIMEOUT}'`);
        await client.query(`SET LOCAL lock_timeout = '5s'`);
        return await runComparison({
            client,
            catalog: data,
            relations,
            unmarked,
            allowedSchema: (s) => deps.catalog.allowedSchema(s),
            matcher: new DefinitionMatcher(snapshot.definitions, data.defaultSchema),
            statements,
            bodies: deps.catalog.bodies,
            kinds: COMPARISON_KINDS,
            columnOrder,
            isCancelled: () => run.isCancelled(),
            report: (message) => run.report(message)
        });
    } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end().catch(() => undefined);
        client.removeListener('error', onError);
    }
}

export function registerComparison(context: vscode.ExtensionContext, provider: ComparisonProvider, deps: ComparisonDeps): void {
    const clear = (): void => {
        provider.setResult(null);
        deps.trees.forEach(t => t.setComparisonMarks(null));
    };

    const compare = async (): Promise<void> => {
        if (!readRepositorySettings().compare) {
            vscode.window.showInformationMessage('The comparison with the repository is turned off (postgresQueryBuilder.repository.compare).');
            return;
        }
        if (!(await deps.connectionManager.ensureConnected())) return;
        const columnOrder = vscode.workspace.getConfiguration('postgresQueryBuilder').get<boolean>('comparison.columnOrder', false);
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Comparing repository and database', cancellable: true },
            async (progress, token) => {
                const outcome = await computeComparison(deps, {
                    isCancelled: () => token.isCancellationRequested,
                    report: (message) => progress.report({ message })
                }, columnOrder);
                if (typeof outcome === 'string') {
                    vscode.window.showInformationMessage(outcome);
                    return null;
                }
                return outcome;
            }
        );
        if (!result) return;
        provider.setResult(result);
        deps.trees.forEach(t => t.setComparisonMarks(marksOf(result)));
        await vscode.commands.executeCommand(`${COMPARISON_VIEW}.focus`);
        const count = (s: ComparisonStatus): number => result.entries.filter(e => e.status === s).length;
        vscode.window.setStatusBarMessage(
            `$(git-compare) ${count('differs')} differ, ${count('dbOnly')} only in the database, ${count('repoOnly')} only in the repository, ${result.equal} equal`,
            10000
        );
    };

    const filter = async (): Promise<void> => {
        const current = provider.kindFilter;
        const picks = COMPARISON_KINDS.map((kind: ComparisonKind) => ({
            label: kind.charAt(0).toUpperCase() + kind.slice(1),
            value: kind,
            picked: !current || COMPARISON_KIND_MEMBERS[kind].some(k => current.has(k))
        }));
        const chosen = await vscode.window.showQuickPick(picks, { canPickMany: true, placeHolder: 'Show these kinds in the Comparison view' });
        if (!chosen) return;
        provider.setKindFilter(chosen.length === picks.length ? null : new Set(chosen.flatMap(c => COMPARISON_KIND_MEMBERS[c.value])));
    };

    const exportReport = async (): Promise<void> => {
        const result = provider.current;
        if (!result) {
            vscode.window.showInformationMessage('Run Compare Repository with Database first.');
            return;
        }
        const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: comparisonReport(result, provider.kindFilter) });
        await vscode.window.showTextDocument(doc, { preview: false });
    };

    /** The script of the entry a context menu was opened on; the node is what the tree hands to the command. */
    const alterScriptOf = (node: ComparisonNode | undefined): string | null => {
        const script = entryAlterScript(node?.type === 'comparisonEntry' ? node.entry : undefined,
            vscode.workspace.getConfiguration('postgresQueryBuilder').get<boolean>('comparison.columnOrder', false));
        if (!script) vscode.window.showInformationMessage('An ALTER TABLE script is offered for a table that exists in the database and the repository and differs.');
        return script;
    };
    const openAlterScript = async (node?: ComparisonNode): Promise<void> => {
        const script = alterScriptOf(node);
        if (!script) return;
        const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: script });
        await vscode.window.showTextDocument(doc, { preview: false });
    };
    const copyAlterScript = async (node?: ComparisonNode): Promise<void> => {
        const script = alterScriptOf(node);
        if (!script) return;
        await vscode.env.clipboard.writeText(script);
        vscode.window.setStatusBarMessage('$(copy) Copied the ALTER TABLE script', 3000);
    };

    context.subscriptions.push(
        vscode.window.createTreeView(COMPARISON_VIEW, { treeDataProvider: provider, showCollapseAll: true }),
        vscode.commands.registerCommand('postgresQueryBuilder.compareRepositoryWithDatabase', async () => {
            try {
                await compare();
            } catch (err: unknown) {
                Logger.error('Comparison.compare', err);
                vscode.window.showErrorMessage(`Compare Repository with Database failed: ${getErrorMessage(err)}`);
            }
        }),
        vscode.commands.registerCommand('postgresQueryBuilder.filterComparison', filter),
        vscode.commands.registerCommand('postgresQueryBuilder.exportComparison', exportReport),
        vscode.commands.registerCommand('postgresQueryBuilder.clearComparison', clear),
        vscode.commands.registerCommand('postgresQueryBuilder.openAlterTableScript', openAlterScript),
        vscode.commands.registerCommand('postgresQueryBuilder.copyAlterTableScript', copyAlterScript),
        deps.catalog.onDidReset(clear)
    );
}

