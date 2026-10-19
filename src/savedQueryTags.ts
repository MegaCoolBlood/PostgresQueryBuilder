import * as vscode from 'vscode';
import { SavedQuery, SavedQueryStore, collectTags, normalizeTag, normalizeTags } from './savedQueryStore';

/** How the tags of a selection of queries are offered in the tag picker. */
export interface TagSelectionSummary {
    /** Every tag that can be picked: all tags in use, sorted. */
    offered: string[];
    /** Tags every selected query carries — shown ticked. */
    onAll: string[];
    /** Tags only some of the selected queries carry, with how many. */
    partial: Array<{ tag: string; count: number }>;
}

const key = (tag: string) => normalizeTag(tag).toLowerCase();

export function summarizeTagSelection(allQueries: SavedQuery[], selected: SavedQuery[]): TagSelectionSummary {
    const offered = collectTags(allQueries);
    const onAll: string[] = [];
    const partial: Array<{ tag: string; count: number }> = [];
    for (const tag of offered) {
        const count = selected.filter(q => (q.tags ?? []).some(t => key(t) === key(tag))).length;
        if (selected.length > 0 && count === selected.length) {
            onAll.push(tag);
        } else if (count > 0) {
            partial.push({ tag, count });
        }
    }
    return { offered, onAll, partial };
}

/**
 * The tags of one query after the picker closed: every picked tag is added, a
 * tag all selected queries carried and that was unticked is removed, and a tag
 * only some of them carried stays as it was unless it was picked.
 */
export function applyTagSelection(current: string[] | undefined, summary: TagSelectionSummary, picked: string[]): string[] {
    const pickedKeys = new Set(picked.map(key));
    const removed = new Set(summary.onAll.map(key).filter(k => !pickedKeys.has(k)));
    return normalizeTags([...(current ?? []).filter(t => !removed.has(key(t))), ...picked]);
}

interface TagPickItem extends vscode.QuickPickItem {
    tag: string;
}

/**
 * Let the user tick the tags of the given queries. Existing tags are listed;
 * typing a name that does not exist yet offers it as a new tag. Returns false
 * when the picker was cancelled.
 */
export async function editSavedQueryTags(store: SavedQueryStore, ids: string[]): Promise<boolean> {
    const selected = ids.map(id => store.get(id)).filter((q): q is SavedQuery => !!q);
    if (selected.length === 0) {
        return false;
    }
    const summary = summarizeTagSelection(store.getAll(), selected);
    const partialCount = new Map(summary.partial.map(p => [key(p.tag), p.count]));
    const picked = new Set(summary.onAll.map(key));
    const chosen = new Map<string, string>(summary.onAll.map(t => [key(t), t]));

    const quickPick = vscode.window.createQuickPick<TagPickItem>();
    quickPick.canSelectMany = true;
    quickPick.title = selected.length === 1
        ? `Tags of "${selected[0].name}"`
        : `Tags of ${selected.length} bookmarked queries`;
    quickPick.placeholder = 'Tick tags, or type a new one (use / to nest, e.g. Reports/Monthly)';

    const build = (typed: string) => {
        const items: TagPickItem[] = summary.offered.map(tag => ({
            label: tag,
            tag,
            description: partialCount.has(key(tag)) ? `on ${partialCount.get(key(tag))} of ${selected.length}` : undefined
        }));
        // Tags typed earlier in this picker stay listed so they remain ticked.
        for (const [k, tag] of chosen) {
            if (!items.some(i => key(i.tag) === k)) items.push({ label: tag, tag, description: 'new tag' });
        }
        const newTag = normalizeTag(typed);
        if (newTag && !items.some(i => key(i.tag) === key(newTag))) {
            items.unshift({ label: newTag, tag: newTag, description: 'new tag', alwaysShow: true });
        }
        quickPick.items = items;
        quickPick.selectedItems = items.filter(i => picked.has(key(i.tag)));
    };
    build('');

    const disposables: vscode.Disposable[] = [];
    const result = await new Promise<string[] | undefined>(resolve => {
        disposables.push(
            quickPick.onDidChangeValue(value => build(value)),
            quickPick.onDidChangeSelection(items => {
                // The selection only covers the visible items; keep ticks of hidden ones.
                const visible = new Set(quickPick.items.map(i => key(i.tag)));
                for (const k of [...picked]) {
                    if (visible.has(k)) picked.delete(k);
                }
                for (const item of items) {
                    picked.add(key(item.tag));
                    chosen.set(key(item.tag), item.tag);
                }
            }),
            quickPick.onDidAccept(() => {
                // Typing a new name and pressing Enter creates it without ticking it first.
                const typed = normalizeTag(quickPick.value);
                if (typed && !summary.offered.some(t => key(t) === key(typed))) {
                    picked.add(key(typed));
                    if (!chosen.has(key(typed))) chosen.set(key(typed), typed);
                }
                resolve([...picked].map(k => chosen.get(k) ?? k));
                quickPick.hide();
            }),
            quickPick.onDidHide(() => resolve(undefined))
        );
        quickPick.show();
    });
    disposables.forEach(d => d.dispose());
    quickPick.dispose();
    if (!result) {
        return false;
    }
    for (const query of selected) {
        await store.update(query.id, { tags: applyTagSelection(query.tags, summary, result) });
    }
    return true;
}
