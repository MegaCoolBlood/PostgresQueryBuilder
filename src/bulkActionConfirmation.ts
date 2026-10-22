import * as vscode from 'vscode';

/**
 * Bulk actions of the Manage Mappings and Bookmarked Queries panels that need
 * the user's consent. Webviews run without `allow-modals`, so `confirm()` in a
 * panel script returns `false` at once; the host asks instead.
 */
export type BulkAction = 'toWorkspace' | 'toPersonal' | 'delete';

/** What the panel calls one entry and several, e.g. `query` / `queries`. */
export interface BulkNoun {
    singular: string;
    plural: string;
}

export interface BulkConfirmation {
    message: string;
    detail: string;
    /** Label of the button that carries out the action. */
    confirmLabel: string;
}

/** The modal question asked before `action` is applied to `count` entries. */
export function describeBulkAction(action: BulkAction, count: number, noun: BulkNoun): BulkConfirmation {
    const what = `${count} ${count === 1 ? noun.singular : noun.plural}`;
    const they = count === 1 ? 'It' : 'They';
    switch (action) {
        case 'toWorkspace':
            return {
                message: `Move ${what} to the workspace file?`,
                detail: `${they} will be visible to everyone who clones this workspace once you commit the file.`,
                confirmLabel: 'Move to Workspace'
            };
        case 'toPersonal':
            return {
                message: `Move ${what} to your personal store?`,
                detail: `${they} will be removed from the workspace file (commit the change to share the removal).`,
                confirmLabel: 'Move to Personal'
            };
        case 'delete':
            return {
                message: `Delete ${what}?`,
                detail: 'This cannot be undone.',
                confirmLabel: 'Delete'
            };
    }
}

/**
 * Ask with a modal warning whether `action` may be applied to `count` entries.
 * Resolves `true` only when the user picked the action's button; nothing to
 * act on resolves `false` without asking.
 */
export async function confirmBulkAction(action: BulkAction, count: number, noun: BulkNoun): Promise<boolean> {
    if (count <= 0) return false;
    const { message, detail, confirmLabel } = describeBulkAction(action, count, noun);
    const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, confirmLabel);
    return choice === confirmLabel;
}
