import * as vscode from 'vscode';
import { buildHtmlDocument } from './webviewUtils';

/** How the last run of a query ended; `running` while it runs. */
export type SelectRunStatus = 'running' | 'done' | 'failed' | 'cancelled';

/**
 * The SELECTs run in a Data Viewer that does not show one table — opened by
 * View Data, Execute, a bookmark or a related join. A Data Viewer of a table
 * keeps its own history per table; these queries had none worth the name.
 */
export interface SelectHistoryEntry {
    /** The statement as it ran, trimmed. */
    sql: string;
    /** When it ran last, in milliseconds since the epoch. */
    lastRun: number;
    /** How often it ran. */
    runs: number;
    /** The title of the Data Viewer it ran in last, e.g. `payroll.sql: SELECT …`. */
    source?: string;
    /** The connection it ran on last. */
    connection?: string;
    /** How its last run ended; missing for entries from before the status was kept. */
    status?: SelectRunStatus;
    /** How long its last run took, once it has ended. */
    durationMs?: number;
    /** Why its last run failed or was cancelled. */
    detail?: string;
}

/** globalState key of the history. */
export const SELECT_HISTORY_KEY = 'selectHistory';
/** The setting that limits the history. */
export const SELECT_HISTORY_SIZE_SETTING = 'selectHistory.maxEntries';
export const DEFAULT_SELECT_HISTORY_SIZE = 500;
export const MIN_SELECT_HISTORY_SIZE = 10;
export const MAX_SELECT_HISTORY_SIZE = 10000;

/** Custom MIME type that carries the statements of dragged history entries into an editor. */
export const SELECT_HISTORY_DRAG_MIME = 'application/vnd.postgresquerybuilder.selecthistory';

/** How many entries the history keeps, from the setting; the default for anything unusable. */
export function selectHistoryLimit(value: unknown): number {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : DEFAULT_SELECT_HISTORY_SIZE;
    return Math.min(MAX_SELECT_HISTORY_SIZE, Math.max(MIN_SELECT_HISTORY_SIZE, n));
}

/** The statement as the history compares it: trimmed, without a closing semicolon. */
export function normalizeHistorySql(sql: string): string {
    return String(sql ?? '').trim().replace(/;+\s*$/, '').trim();
}

/**
 * The history after `sql` started to run: an entry for the same statement
 * moves to the top and counts the run, a new one is added there, and the
 * oldest entries beyond `limit` are dropped. The run is `running` until
 * {@link finishSelect} ends it.
 */
export function recordSelect(
    history: ReadonlyArray<SelectHistoryEntry>,
    run: { sql: string; source?: string; connection?: string },
    now: number,
    limit: number
): SelectHistoryEntry[] {
    const sql = normalizeHistorySql(run.sql);
    if (!sql) return history.slice(0, limit);
    const before = history.find((entry) => entry.sql === sql);
    const entry: SelectHistoryEntry = { sql, lastRun: now, runs: (before?.runs ?? 0) + 1, status: 'running' };
    if (run.source) entry.source = run.source;
    if (run.connection) entry.connection = run.connection;
    return [entry, ...history.filter((e) => e.sql !== sql)].slice(0, limit);
}

/**
 * The history once the run of `sql` that started at `startedAt` has ended.
 * A later run of the same statement has replaced that run and is left alone.
 */
export function finishSelect(
    history: ReadonlyArray<SelectHistoryEntry>,
    run: { sql: string; startedAt: number; status: Exclude<SelectRunStatus, 'running'>; durationMs?: number; detail?: string }
): SelectHistoryEntry[] {
    const sql = normalizeHistorySql(run.sql);
    return history.map((entry) => {
        if (entry.sql !== sql || entry.lastRun !== run.startedAt) return entry;
        const ended: SelectHistoryEntry = { ...entry, status: run.status };
        delete ended.detail;
        delete ended.durationMs;
        if (run.durationMs !== undefined) ended.durationMs = Math.max(0, Math.round(run.durationMs));
        if (run.detail) ended.detail = run.detail;
        return ended;
    });
}

/** Runs still `running` from an earlier window of VS Code never ended there; they count as cancelled. */
export function settleInterruptedRuns(history: ReadonlyArray<SelectHistoryEntry>): SelectHistoryEntry[] {
    return history.map((entry) => (entry.status === 'running'
        ? { ...entry, status: 'cancelled' as const, detail: 'VS Code was closed while the query ran.' }
        : entry));
}

/** The words of a search, lower-cased, as the Tables view splits them. */
export function searchTerms(search: string): string[] {
    return String(search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
}

/** How many of `terms` occur in an entry: in its statement, the title of its Data Viewer or its connection. */
export function searchScore(entry: SelectHistoryEntry, terms: ReadonlyArray<string>): number {
    const haystack = [entry.sql, entry.source ?? '', entry.connection ?? ''].join('\n').toLowerCase();
    return terms.filter((term) => haystack.includes(term)).length;
}

/**
 * The entries `search` finds, as the Tables view finds tables: every entry in
 * which at least one of its words occurs, those with the most words first,
 * newest first among equals.
 */
export function filterSelectHistory(history: ReadonlyArray<SelectHistoryEntry>, search: string): SelectHistoryEntry[] {
    const terms = searchTerms(search);
    if (terms.length === 0) return history.slice();
    return history
        .map((entry, index) => ({ entry, index, score: searchScore(entry, terms) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map((x) => x.entry);
}

/** Where `terms` occur in `text`, as merged [start, end) ranges for highlighting. */
export function searchHighlights(text: string, terms: ReadonlyArray<string>): Array<[number, number]> {
    const lower = text.toLowerCase();
    const ranges: Array<[number, number]> = [];
    for (const term of terms) {
        for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) {
            ranges.push([at, at + term.length]);
        }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const range of ranges) {
        const last = merged[merged.length - 1];
        if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
        else merged.push([range[0], range[1]]);
    }
    return merged;
}

/** How a run ended, in words, for the description and the tooltip of its entry. */
export const SELECT_STATUS_TEXT: Record<SelectRunStatus, string> = {
    running: 'Running',
    done: 'Succeeded',
    failed: 'Failed',
    cancelled: 'Cancelled'
};

/** The icon of an entry by how its last run ended, coloured from the theme. */
export function selectStatusIcon(status: SelectRunStatus | undefined): vscode.ThemeIcon {
    switch (status) {
        case 'running': return new vscode.ThemeIcon('loading~spin');
        case 'done': return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
        case 'failed': return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
        case 'cancelled': return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('editorWarning.foreground'));
        default: return new vscode.ThemeIcon('history');
    }
}

/** The statement on one line, shortened for the label of its entry. */
export function selectHistoryLabel(sql: string, max = 120): string {
    const line = sql.replace(/\s+/g, ' ').trim();
    return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** When an entry ran last: `14:03` today, `2026-11-12 14:03` before. */
export function lastRunText(lastRun: number, now: number = Date.now()): string {
    const at = new Date(lastRun);
    const today = new Date(now);
    const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
    const sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
    return sameDay ? time : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`;
}

/** What dropping history entries into an editor inserts: each statement closed by a semicolon. */
export function droppedSelectText(statements: ReadonlyArray<string>): string {
    return statements
        .map((sql) => normalizeHistorySql(sql))
        .filter((sql) => sql.length > 0)
        .map((sql) => `${sql};`)
        .join('\n\n');
}

/** The history of SELECTs, kept for the user across workspaces. */
export class SelectHistoryStore {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changed.event;
    /** Changes are applied one after the other, so the end of a run never overtakes its start. */
    private queue: Promise<void> = Promise.resolve();

    constructor(
        private readonly state: vscode.Memento,
        /** How many entries to keep; read on every change, so the setting applies at once. */
        private readonly limit: () => number = () => DEFAULT_SELECT_HISTORY_SIZE
    ) {}

    getAll(): SelectHistoryEntry[] {
        const stored = this.state.get<SelectHistoryEntry[]>(SELECT_HISTORY_KEY, []);
        return Array.isArray(stored) ? stored : [];
    }

    /** `sql` starts to run now (`startedAt`); the entry shows it running until {@link finish}. */
    record(sql: string, source?: string, connection?: string, startedAt: number = Date.now()): Promise<void> {
        return this.change((all) => recordSelect(all, { sql, source, connection }, startedAt, this.limit()));
    }

    /** The run of `sql` that started at `startedAt` has ended. */
    finish(sql: string, startedAt: number, status: Exclude<SelectRunStatus, 'running'>, durationMs?: number, detail?: string): Promise<void> {
        return this.change((all) => finishSelect(all, { sql, startedAt, status, durationMs, detail }));
    }

    remove(statements: ReadonlyArray<string>): Promise<void> {
        const gone = new Set(statements.map(normalizeHistorySql));
        return this.change((all) => all.filter((entry) => !gone.has(entry.sql)));
    }

    clear(): Promise<void> {
        return this.change(() => []);
    }

    /** Drop the oldest entries beyond the limit, e.g. after the setting was lowered. */
    trim(): Promise<void> {
        return this.change((all) => (all.length > this.limit() ? all.slice(0, this.limit()) : all));
    }

    /** Runs a closed window of VS Code left `running` end as cancelled. */
    settleInterrupted(): Promise<void> {
        return this.change(settleInterruptedRuns);
    }

    private change(next: (all: SelectHistoryEntry[]) => SelectHistoryEntry[]): Promise<void> {
        const done = this.queue.then(async () => {
            const before = this.getAll();
            const after = next(before);
            if (after.length === before.length && after.every((entry, i) => entry === before[i])) return;
            await this.state.update(SELECT_HISTORY_KEY, after);
            this.changed.fire();
        });
        this.queue = done.catch(() => undefined);
        return done;
    }
}

/** The "Select History" view: newest first, narrowed down by the search above it. */
export class SelectHistoryProvider implements vscode.TreeDataProvider<SelectHistoryEntry> {
    private readonly changed = new vscode.EventEmitter<SelectHistoryEntry | undefined | void>();
    readonly onDidChangeTreeData = this.changed.event;
    private search = '';
    private terms: string[] = [];

    constructor(private readonly store: SelectHistoryStore, private readonly now: () => number = Date.now) {
        store.onDidChange(() => this.changed.fire());
    }

    /** The current search; '' shows every entry. */
    get searchText(): string {
        return this.search;
    }

    setSearch(text: string): void {
        const search = String(text ?? '').trim();
        if (search === this.search) return;
        this.search = search;
        this.terms = searchTerms(search);
        this.changed.fire();
    }

    /** E.g. `12 of 340 queries match "orders"`, or undefined without a search. */
    searchMessage(): string | undefined {
        if (!this.search) return undefined;
        const shown = this.getChildren().length;
        const total = this.store.getAll().length;
        return `${shown} of ${total} ${total === 1 ? 'query matches' : 'queries match'} "${this.search}"`;
    }

    getChildren(element?: SelectHistoryEntry): SelectHistoryEntry[] {
        return element ? [] : filterSelectHistory(this.store.getAll(), this.search);
    }

    getTreeItem(entry: SelectHistoryEntry): vscode.TreeItem {
        const label = selectHistoryLabel(entry.sql);
        const highlights = searchHighlights(label, this.terms);
        const item = new vscode.TreeItem(highlights.length ? { label, highlights } : label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = selectStatusIcon(entry.status);
        item.contextValue = 'selectHistoryEntry';
        // How it ended is said in words too, never by the icon alone.
        const ended = entry.status === 'failed' || entry.status === 'cancelled' || entry.status === 'running'
            ? ` · ${SELECT_STATUS_TEXT[entry.status]}`
            : '';
        item.description = lastRunText(entry.lastRun, this.now()) + (entry.runs > 1 ? ` · ${entry.runs}×` : '') + ended;
        const status = entry.status
            ? `${SELECT_STATUS_TEXT[entry.status]}${entry.durationMs !== undefined ? ` after ${durationText(entry.durationMs)}` : ''}`
            : '';
        const details = [
            `Last run ${lastRunText(entry.lastRun, this.now())}${entry.runs > 1 ? `, ${entry.runs} runs` : ''}`,
            entry.source ? `in ${entry.source}` : '',
            entry.connection ? `on ${entry.connection}` : ''
        ].filter(Boolean).join(' ');
        const outcome = [status, entry.detail ?? ''].filter(Boolean).join(': ');
        const tooltip = new vscode.MarkdownString(
            `${details}${outcome ? `\n\n**${escapeMarkdown(outcome)}**` : ''}\n\n\`\`\`sql\n${entry.sql}\n\`\`\`\n\nDouble-click to run it in the Data Viewer, drag it into an editor to insert it.`
        );
        item.tooltip = tooltip;
        // A single click only selects; the command runs the query on the second click.
        item.command = {
            command: 'postgresQueryBuilder.openSelectHistoryEntry',
            title: 'Run in the Data Viewer',
            arguments: [entry]
        };
        return item;
    }
}

/** How long a run took: `420 ms`, `3.2 s`, `2 min 05 s`. */
export function durationText(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
    const seconds = Math.floor(ms / 1000);
    return `${Math.floor(seconds / 60)} min ${pad(seconds % 60)} s`;
}

/** `text` as plain Markdown text, so an error message cannot format the tooltip. */
function escapeMarkdown(text: string): string {
    return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

/**
 * The search field above the "Select History", like the one above the
 * tables: the history is filtered while typing, by every word entered.
 */
export class SelectHistorySearchView implements vscode.WebviewViewProvider {
    static readonly viewType = 'postgresSelectHistorySearch';
    private view?: vscode.WebviewView;

    constructor(private readonly provider: SelectHistoryProvider) {}

    resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken): void {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml(webviewView.webview);
        webviewView.webview.onDidReceiveMessage((message: { type?: string; value?: unknown }) => {
            if (message.type === 'filter') {
                this.provider.setSearch(String(message.value ?? ''));
            } else if (message.type === 'ready') {
                // A view opened again shows the search the history is filtered by.
                void webviewView.webview.postMessage({ type: 'value', value: this.provider.searchText });
            }
        });
    }

    private getHtml(webview: vscode.Webview): string {
        const styles = `
body { padding: var(--sp-2); }
#searchInput { width: 100%; }
.hint { margin-top: var(--sp-1); }`;
        const body = `
<input type="text" id="searchInput" placeholder="Filter queries... (several terms)" aria-label="Filter the Select History" />
<div class="hint">Several terms separated by spaces: the queries with the most hits come first. Searches the query, the file or Data Viewer it ran in and its connection.</div>`;
        const script = `
const vscode = acquireVsCodeApi();
const input = document.getElementById('searchInput');
let debounceTimer;
input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => vscode.postMessage({ type: 'filter', value: input.value }), 200);
});
input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
        input.value = '';
        vscode.postMessage({ type: 'filter', value: '' });
    }
});
window.addEventListener('message', (ev) => {
    if (ev.data && ev.data.type === 'value' && typeof ev.data.value === 'string') input.value = ev.data.value;
});
vscode.postMessage({ type: 'ready' });`;
        return buildHtmlDocument({ webview, styles, body, script });
    }
}

/** Drag controller of the "Select History" view: entries dragged into an editor insert their statements. */
export class SelectHistoryDragController implements vscode.TreeDragAndDropController<SelectHistoryEntry> {
    readonly dropMimeTypes: string[] = [];
    readonly dragMimeTypes: string[] = [SELECT_HISTORY_DRAG_MIME];

    handleDrag(source: readonly SelectHistoryEntry[], dataTransfer: vscode.DataTransfer, _token: vscode.CancellationToken): void {
        const statements = source.map((entry) => entry.sql).filter(Boolean);
        if (statements.length > 0) {
            dataTransfer.set(SELECT_HISTORY_DRAG_MIME, new vscode.DataTransferItem(JSON.stringify(statements)));
        }
    }
}

/** Inserts the statements of history entries dropped into a text editor at the drop position. */
export class SelectHistoryDropProvider implements vscode.DocumentDropEditProvider {
    async provideDocumentDropEdits(
        _document: vscode.TextDocument,
        _position: vscode.Position,
        dataTransfer: vscode.DataTransfer,
        _token: vscode.CancellationToken
    ): Promise<vscode.DocumentDropEdit | undefined> {
        const item = dataTransfer.get(SELECT_HISTORY_DRAG_MIME);
        if (!item) return undefined;
        let statements: unknown;
        try {
            statements = JSON.parse(await item.asString());
        } catch {
            return undefined;
        }
        if (!Array.isArray(statements)) return undefined;
        const text = droppedSelectText(statements.map(String));
        return text ? new vscode.DocumentDropEdit(text) : undefined;
    }
}
