import * as vscode from 'vscode';
import { SavedQueryStore, SavedQuery, SavedQueryScope, collectTags, compareTags, normalizeTag, sortSavedQueries } from './savedQueryStore';

/** A tag folder; `path` is the full tag (`Reports/Monthly`) as first spelled. */
export interface SavedQueryTagNode {
    type: 'tag';
    path: string;
}

/** The folder of queries that carry no tag. */
export interface SavedQueryUntaggedNode {
    type: 'untagged';
}

export interface SavedQueryNode {
    type: 'query';
    query: SavedQuery;
    /** The tag folder the query is listed in, '' for "Untagged". */
    parent?: string;
    /** Name the scope next to the query (only when both scopes are in use). */
    showScope?: boolean;
}

export type SavedQueryTreeNode = SavedQueryTagNode | SavedQueryUntaggedNode | SavedQueryNode;

export const UNTAGGED_LABEL = 'Untagged';

const SCOPE_LABEL: Record<SavedQueryScope, string> = {
    workspace: 'Workspace',
    global: 'Personal'
};

/** One-line preview of a query, used as the tooltip in the tree. */
export function describeSavedQuery(query: SavedQuery): string {
    const oneLine = query.sql.replace(/\s+/g, ' ').trim();
    return oneLine.length > 200 ? oneLine.slice(0, 200) + '…' : oneLine;
}

/** The `:name` list shown next to a query's name, or '' when it takes none. */
export function describeParameters(query: SavedQuery): string {
    const params = Array.isArray(query.parameters) ? query.parameters : [];
    return params.map(p => `:${p.name}`).join(', ');
}

/** Context value carrying the scope, so the menu can offer only the move that applies. */
export function savedQueryContextValue(query: SavedQuery): string {
    return `savedQuery.${query.scope === 'workspace' ? 'workspace' : 'global'}`;
}

/** The last level of a tag path — the label of its folder. */
export function tagFolderLabel(path: string): string {
    const parts = path.split('/');
    return parts[parts.length - 1];
}

const lower = (s: string) => s.toLowerCase();

/** Whether `query` carries `path` exactly (case-insensitively). */
function hasTag(query: SavedQuery, path: string): boolean {
    const key = lower(path);
    return (query.tags ?? []).some(t => lower(normalizeTag(t)) === key);
}

/**
 * The folders directly below `parent` ('' for the top level), as full paths.
 * A tag `Reports/Monthly` yields the folder `Reports` at the top level and
 * `Reports/Monthly` inside it, even when no query carries `Reports` alone.
 * Folders are matched case-insensitively and spelled as they first appear.
 */
export function childTagFolders(queries: SavedQuery[], parent: string): string[] {
    const depth = parent ? parent.split('/').length : 0;
    const prefix = parent ? lower(parent) + '/' : '';
    const folders = new Map<string, string>();
    for (const tag of collectTags(queries)) {
        const parts = tag.split('/');
        if (parts.length <= depth) continue;
        const path = parts.slice(0, depth + 1).join('/');
        if (parent && !lower(path).startsWith(prefix)) continue;
        if (!folders.has(lower(path))) folders.set(lower(path), path);
    }
    return [...folders.values()].sort(compareTags);
}

/** The queries listed in the folder `path`: those carrying exactly that tag. */
export function queriesInTagFolder(queries: SavedQuery[], path: string): SavedQuery[] {
    return sortSavedQueries(queries.filter(q => hasTag(q, path)));
}

/** How many queries a folder holds, its subfolders included. */
export function countInTagFolder(queries: SavedQuery[], path: string): number {
    const key = lower(path);
    return queries.filter(q => (q.tags ?? []).some(t => {
        const tag = lower(normalizeTag(t));
        return tag === key || tag.startsWith(key + '/');
    })).length;
}

/** Queries without any tag, listed in the "Untagged" folder. */
export function untaggedQueries(queries: SavedQuery[]): SavedQuery[] {
    return sortSavedQueries(queries.filter(q => !(q.tags && q.tags.length)));
}

/**
 * Lists the bookmarked queries in the activity bar, in one folder per tag. A
 * query with several tags appears in each of their folders; a `/` in a tag
 * nests folders; queries without a tag are listed under "Untagged".
 */
export class SavedQueryExplorerProvider implements vscode.TreeDataProvider<SavedQueryTreeNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<SavedQueryTreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly store: SavedQueryStore) {
        this.store.onDidChange(() => this.refresh());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SavedQueryTreeNode): vscode.TreeItem {
        const all = this.store.getAll();
        if (element.type === 'tag') {
            const item = new vscode.TreeItem(tagFolderLabel(element.path), vscode.TreeItemCollapsibleState.Collapsed);
            const count = countInTagFolder(all, element.path);
            item.iconPath = new vscode.ThemeIcon('tag');
            item.contextValue = 'savedQueryTag';
            item.description = String(count);
            item.tooltip = `Tag "${element.path}" — ${count} quer${count === 1 ? 'y' : 'ies'}`;
            return item;
        }
        if (element.type === 'untagged') {
            const onlyFolder = childTagFolders(all, '').length === 0;
            const item = new vscode.TreeItem(
                UNTAGGED_LABEL,
                onlyFolder ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
            );
            const count = untaggedQueries(all).length;
            item.iconPath = new vscode.ThemeIcon('inbox');
            item.contextValue = 'savedQueryUntagged';
            item.description = String(count);
            item.tooltip = 'Queries without a tag. Drag a query onto a tag folder to tag it.';
            return item;
        }

        const query = element.query;
        const scope = SCOPE_LABEL[query.scope === 'workspace' ? 'workspace' : 'global'];
        const item = new vscode.TreeItem(query.name, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('bookmark');
        item.contextValue = savedQueryContextValue(query);
        item.description = [element.showScope ? scope : '', describeParameters(query)].filter(Boolean).join(' · ');
        const tags = query.tags && query.tags.length ? `\nTags: ${query.tags.join(', ')}` : '';
        item.tooltip = `${scope}${tags}\n${describeSavedQuery(query)}`;
        // Single click only selects; the command gates on a second click.
        item.command = {
            command: 'postgresQueryBuilder.openSavedQuery',
            title: 'Open Bookmarked Query',
            arguments: [query.id]
        };
        return item;
    }

    getChildren(element?: SavedQueryTreeNode): SavedQueryTreeNode[] {
        const all = this.store.getAll();
        const showScope = all.some(q => q.scope === 'workspace') && all.some(q => q.scope !== 'workspace');
        const asNodes = (queries: SavedQuery[], parent: string): SavedQueryTreeNode[] =>
            queries.map(query => ({ type: 'query' as const, query, parent, showScope }));
        if (!element) {
            const folders: SavedQueryTreeNode[] = childTagFolders(all, '').map(path => ({ type: 'tag' as const, path }));
            return untaggedQueries(all).length ? [...folders, { type: 'untagged' as const }] : folders;
        }
        if (element.type === 'tag') {
            return [
                ...childTagFolders(all, element.path).map(path => ({ type: 'tag' as const, path })),
                ...asNodes(queriesInTagFolder(all, element.path), element.path)
            ];
        }
        if (element.type === 'untagged') {
            return asNodes(untaggedQueries(all), '');
        }
        return [];
    }
}
