import * as vscode from 'vscode';
import { SavedQueryStore, SavedQuery, SavedQueryScope } from './savedQueryStore';

export interface SavedQueryGroupNode {
    type: 'group';
    scope: SavedQueryScope;
}

export interface SavedQueryNode {
    type: 'query';
    query: SavedQuery;
}

export type SavedQueryTreeNode = SavedQueryGroupNode | SavedQueryNode;

const GROUP_LABEL: Record<SavedQueryScope, string> = {
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

/**
 * Lists the saved queries in the activity bar. Queries are grouped by scope as
 * soon as both scopes are in use, so a shared workspace file is visibly
 * separate from personal queries.
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
        if (element.type === 'group') {
            const item = new vscode.TreeItem(GROUP_LABEL[element.scope], vscode.TreeItemCollapsibleState.Expanded);
            item.iconPath = new vscode.ThemeIcon(element.scope === 'workspace' ? 'folder' : 'account');
            item.contextValue = `savedQueryGroup:${element.scope}`;
            item.tooltip = element.scope === 'workspace'
                ? 'Queries stored with this workspace'
                : 'Queries stored in your personal settings';
            return item;
        }

        const query = element.query;
        const item = new vscode.TreeItem(query.name, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('bookmark');
        item.contextValue = savedQueryContextValue(query);
        item.description = describeParameters(query);
        item.tooltip = `${GROUP_LABEL[query.scope === 'workspace' ? 'workspace' : 'global']}\n${describeSavedQuery(query)}`;
        item.command = {
            command: 'postgresQueryBuilder.runSavedQuery',
            title: 'Run Saved Query',
            arguments: [query.id]
        };
        return item;
    }

    getChildren(element?: SavedQueryTreeNode): SavedQueryTreeNode[] {
        const all = this.store.getAll();
        if (element?.type === 'group') {
            return all.filter(q => q.scope === element.scope).map(query => ({ type: 'query' as const, query }));
        }
        if (element) {
            return [];
        }
        const scopes: SavedQueryScope[] = ['workspace', 'global'];
        const used = scopes.filter(scope => all.some(q => q.scope === scope));
        if (used.length > 1) {
            return used.map(scope => ({ type: 'group' as const, scope }));
        }
        return all.map(query => ({ type: 'query' as const, query }));
    }
}
