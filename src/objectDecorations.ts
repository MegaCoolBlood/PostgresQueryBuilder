/**
 * Colours the entries of the Objects and Tables views by where the object
 * exists: red when the repository has no CREATE statement for it, in the
 * theme's "untracked" colour when it exists only in the repository, in the
 * "modified" colour when the routine in the database differs.
 *
 * Tree items carry a `resourceUri` of a private scheme whose query is the
 * status; VS Code asks this provider for the decoration of that URI. Only
 * theme colour ids are used, never literal colours.
 */
import * as vscode from 'vscode';
import type { RepoStatus } from './repositoryComparison';

export const OBJECT_STATUS_SCHEME = 'pgqb-object';

const STATUS_HINT: Record<RepoStatus, string> = {
    both: 'Defined in the repository.',
    dbOnly: 'Not found in the repository.',
    repoOnly: 'Exists only in the repository, not in the database.',
    differs: 'The definition in the database differs from the repository.'
};

/** The sentence the tooltip of an entry ends with, telling where the object exists. */
export function statusHint(status: RepoStatus): string {
    return STATUS_HINT[status];
}

/** The URI a tree item carries so its label gets the colour of `status`. */
export function statusUri(id: string, status: RepoStatus): vscode.Uri {
    return vscode.Uri.parse(`${OBJECT_STATUS_SCHEME}:/${encodeURIComponent(id)}?${status}`);
}

/** The decoration of a status: theme colour, a badge so the state does not rely on hue alone, and the hint. */
export function statusDecoration(status: string): vscode.FileDecoration | undefined {
    if (status === 'dbOnly') {
        return { badge: '!', color: new vscode.ThemeColor('list.errorForeground'), tooltip: STATUS_HINT.dbOnly };
    }
    if (status === 'repoOnly') {
        return { badge: '+', color: new vscode.ThemeColor('gitDecoration.untrackedResourceForeground'), tooltip: STATUS_HINT.repoOnly };
    }
    if (status === 'differs') {
        return { badge: '~', color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'), tooltip: STATUS_HINT.differs };
    }
    return undefined;
}

export class ObjectStatusDecorationProvider implements vscode.FileDecorationProvider {
    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (uri.scheme !== OBJECT_STATUS_SCHEME) return undefined;
        return statusDecoration(uri.query);
    }
}

/** The first differences of a full comparison, for a tooltip. */
export function differenceLines(differences: ReadonlyArray<{ path: string; message: string }>, max = 6): string[] {
    const lines = differences.slice(0, max).map(d => `• ${d.path}: ${d.message}`);
    if (differences.length > max) lines.push(`… and ${differences.length - max} more`);
    return lines;
}
