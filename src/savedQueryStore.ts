import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { maskSql } from './selectStatementExtractor';
import { getErrorMessage } from './logger';

/** How a placeholder value is turned into SQL text. */
export type SavedQueryParameterKind = 'text' | 'number' | 'identifier' | 'raw';

export interface SavedQueryParameter {
    name: string;
    label?: string;
    kind: SavedQueryParameterKind;
    defaultValue?: string;
}

export type SavedQueryScope = 'workspace' | 'global';

/** A reusable SELECT with `:name` placeholders. */
export interface SavedQuery {
    id: string;
    name: string;
    sql: string;
    parameters: SavedQueryParameter[];
    /** Table the query was saved from, kept for display only. */
    schema?: string;
    table?: string;
    lastUsed?: number;
    scope?: SavedQueryScope;
    /** Folder-like labels; a `/` nests them (`Reports/Monthly`). */
    tags?: string[];
}

interface WorkspaceQueriesFile {
    $schema?: string;
    version: number;
    queries: SavedQuery[];
}

const DEFAULT_WORKSPACE_FILE = 'postgres-query-builder.queries.json';
const FILE_VERSION = 1;
const PARAMETER_KINDS: SavedQueryParameterKind[] = ['text', 'number', 'identifier', 'raw'];

export interface PlaceholderOccurrence {
    name: string;
    start: number;
    end: number;
}

/**
 * Find every `:name` placeholder in `sql`. Scanning happens on a masked copy so
 * placeholders inside string literals, dollar-quoted bodies and comments are
 * ignored; `::cast` and `:=` are not placeholders either. Offsets refer to the
 * original string.
 */
export function parseQueryPlaceholders(sql: string): PlaceholderOccurrence[] {
    if (typeof sql !== 'string' || !sql) {
        return [];
    }
    const masked = maskSql(sql);
    const result: PlaceholderOccurrence[] = [];
    const re = /:([A-Za-z_][A-Za-z0-9_]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
        // The character before a placeholder must not be another colon (`::cast`).
        if (m.index > 0 && masked[m.index - 1] === ':') {
            continue;
        }
        result.push({ name: m[1], start: m.index, end: m.index + m[0].length });
    }
    return result;
}

/** Distinct placeholder names in the order of their first occurrence. */
export function placeholderNames(sql: string): string[] {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const occ of parseQueryPlaceholders(sql)) {
        const key = occ.name.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        names.push(occ.name);
    }
    return names;
}

/**
 * Reconcile a parameter list with the placeholders actually used in `sql`:
 * settings of still-used parameters are kept, new placeholders are added as
 * `text` and vanished ones are dropped.
 */
export function mergeParameters(sql: string, existing: unknown): SavedQueryParameter[] {
    const known = new Map<string, SavedQueryParameter>();
    for (const p of normalizeParameters(existing)) {
        known.set(p.name.toLowerCase(), p);
    }
    return placeholderNames(sql).map(name => {
        const prev = known.get(name.toLowerCase());
        return prev ? { ...prev, name } : { name, kind: 'text' as const };
    });
}

/** Render a single value as SQL text according to its declared kind. */
export function renderParameterValue(value: string, kind: SavedQueryParameterKind): string {
    const text = value === null || value === undefined ? '' : String(value);
    switch (kind) {
        case 'number':
            if (!/^-?\d+(\.\d+)?$/.test(text.trim())) {
                throw new Error(`"${text}" is not a valid number.`);
            }
            return text.trim();
        case 'identifier':
            return `"${text.replace(/"/g, '""')}"`;
        case 'raw':
            return text;
        default:
            return `'${text.replace(/'/g, "''")}'`;
    }
}

/**
 * Replace every placeholder in `sql` with its rendered value. Occurrences are
 * resolved up front and spliced in from right to left, so an inserted value that
 * itself contains `:name` is never substituted again.
 */
export function applyQueryParameters(
    sql: string,
    values: Record<string, string>,
    parameters: SavedQueryParameter[]
): string {
    const occurrences = parseQueryPlaceholders(sql);
    if (occurrences.length === 0) {
        return sql;
    }
    const byName = new Map<string, SavedQueryParameter>();
    for (const p of normalizeParameters(parameters)) {
        byName.set(p.name.toLowerCase(), p);
    }
    const lookup = new Map<string, string>();
    for (const [k, v] of Object.entries(values || {})) {
        if (v !== undefined && v !== null) {
            lookup.set(k.toLowerCase(), String(v));
        }
    }

    let result = sql;
    for (let i = occurrences.length - 1; i >= 0; i--) {
        const occ = occurrences[i];
        const key = occ.name.toLowerCase();
        const param = byName.get(key) || { name: occ.name, kind: 'text' as const };
        let value = lookup.get(key);
        if (value === undefined || value === '') {
            value = param.defaultValue;
        }
        if (value === undefined || value === '') {
            throw new Error(`No value supplied for :${occ.name}.`);
        }
        result = result.slice(0, occ.start) + renderParameterValue(value, param.kind) + result.slice(occ.end);
    }
    return result;
}

/** Keep only parameters with a usable name and a known kind. */
export function normalizeParameters(parameters: unknown): SavedQueryParameter[] {
    if (!Array.isArray(parameters)) {
        return [];
    }
    const result: SavedQueryParameter[] = [];
    const seen = new Set<string>();
    for (const p of parameters) {
        const name = typeof p?.name === 'string' ? p.name.trim() : '';
        if (!name || seen.has(name.toLowerCase())) {
            continue;
        }
        seen.add(name.toLowerCase());
        const kind: SavedQueryParameterKind = PARAMETER_KINDS.includes(p?.kind) ? p.kind : 'text';
        const param: SavedQueryParameter = { name, kind };
        if (typeof p?.label === 'string' && p.label.trim()) {
            param.label = p.label.trim();
        }
        if (typeof p?.defaultValue === 'string' && p.defaultValue !== '') {
            param.defaultValue = p.defaultValue;
        }
        result.push(param);
    }
    return result;
}

/** Sanitize one stored/imported entry, or drop it when unusable. */
export function normalizeSavedQuery(raw: unknown): SavedQuery | undefined {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    const sql = typeof r.sql === 'string' ? r.sql.trim() : '';
    if (!id || !name || !sql) {
        return undefined;
    }
    const query: SavedQuery = { id, name, sql, parameters: normalizeParameters(r.parameters) };
    if (typeof r.schema === 'string' && r.schema) {
        query.schema = r.schema;
    }
    if (typeof r.table === 'string' && r.table) {
        query.table = r.table;
    }
    if (typeof r.lastUsed === 'number') {
        query.lastUsed = r.lastUsed;
    }
    const tags = normalizeTags(r.tags);
    if (tags.length) {
        query.tags = tags;
    }
    return query;
}

/**
 * Tidy one tag: surrounding and repeated whitespace is dropped, and each `/`
 * separated level is trimmed with empty levels removed, so ` Reports / Monthly/`
 * becomes `Reports/Monthly`. Returns '' for a tag with no content.
 */
export function normalizeTag(raw: unknown): string {
    if (typeof raw !== 'string') {
        return '';
    }
    return raw
        .split('/')
        .map(part => part.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('/');
}

/**
 * A clean tag list: tidied, without duplicates (compared case-insensitively,
 * the first spelling wins) and sorted, so the stored file stays stable.
 * Accepts an array or a comma-separated string.
 */
export function normalizeTags(raw: unknown): string[] {
    const items = typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) ? raw : [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of items) {
        const tag = normalizeTag(item);
        const key = tag.toLowerCase();
        if (tag && !seen.has(key)) {
            seen.add(key);
            result.push(tag);
        }
    }
    return result.sort(compareTags);
}

/** Case-insensitive, level-aware order: `A`, `A/B`, `A B`. */
export function compareTags(a: string, b: string): number {
    const pa = a.split('/'), pb = b.split('/');
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
        const d = pa[i].localeCompare(pb[i], undefined, { sensitivity: 'base' });
        if (d !== 0) return d;
    }
    return pa.length - pb.length;
}

/** Every tag in use, each spelled the way it first appears, sorted. */
export function collectTags(queries: SavedQuery[]): string[] {
    return normalizeTags(queries.flatMap(q => q.tags ?? []));
}

/** `tags` plus `tag`, unless it is already there (case-insensitively). */
export function withTag(tags: string[] | undefined, tag: string): string[] {
    return normalizeTags([...(tags ?? []), tag]);
}

/** `tags` without `tag` (case-insensitively). */
export function withoutTag(tags: string[] | undefined, tag: string): string[] {
    const key = normalizeTag(tag).toLowerCase();
    return normalizeTags((tags ?? []).filter(t => normalizeTag(t).toLowerCase() !== key));
}

/**
 * Strip volatile fields before writing a query to the committable workspace
 * file. `lastUsed` changes on every run and would otherwise create noisy git
 * diffs; `scope` is implied by where the query is stored.
 */
export function serializeWorkspaceQuery(query: SavedQuery): SavedQuery {
    const clean: SavedQuery = { ...query };
    delete clean.lastUsed;
    delete clean.scope;
    return clean;
}

export function normalizeSavedQueries(raw: unknown): SavedQuery[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const result: SavedQuery[] = [];
    for (const entry of raw) {
        const normalized = normalizeSavedQuery(entry);
        if (normalized) {
            result.push(normalized);
        }
    }
    return result;
}

/** Sort by name, case-insensitively, so the tree order is stable. */
export function sortSavedQueries(queries: SavedQuery[]): SavedQuery[] {
    return [...queries].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** Store a normalized tag list on `query`, or drop the field when it is empty. */
function applyTags(query: SavedQuery, tags: unknown): void {
    const clean = normalizeTags(tags);
    if (clean.length) {
        query.tags = clean;
    } else {
        delete query.tags;
    }
}

/**
 * Persists reusable SELECT statements. Personal queries live in the extension's
 * global state; workspace queries live in a JSON file that can be committed, so
 * a team shares the same set.
 */
export class SavedQueryStore {
    private static readonly STORAGE_KEY = 'savedQueries';
    private static readonly VALUES_KEY = 'savedQueryParameterValues';
    private readonly context: vscode.ExtensionContext;
    private workspaceQueries: SavedQuery[] = [];
    private workspaceFileUri: vscode.Uri | undefined;
    private fileWatcher: vscode.FileSystemWatcher | undefined;
    private suppressWatcher = false;
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.refreshWorkspaceFileUri();
        this.loadWorkspaceQueriesSync();
        this.setupWatcher();

        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('postgresQueryBuilder.savedQueriesFile')) {
                    this.reloadWorkspaceSource();
                }
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.reloadWorkspaceSource()),
            this._onDidChange
        );
    }

    dispose(): void {
        this.fileWatcher?.dispose();
    }

    getWorkspaceFileUri(): vscode.Uri | undefined {
        return this.workspaceFileUri;
    }

    hasWorkspaceFile(): boolean {
        return !!this.workspaceFileUri && fs.existsSync(this.workspaceFileUri.fsPath);
    }

    /** All queries, workspace entries first, each tagged with its scope. */
    getAll(): SavedQuery[] {
        return [
            ...sortSavedQueries(this.workspaceQueries).map(q => ({ ...q, scope: 'workspace' as const })),
            ...sortSavedQueries(this.getGlobalQueries()).map(q => ({ ...q, scope: 'global' as const }))
        ];
    }

    get(id: string): SavedQuery | undefined {
        return this.getAll().find(q => q.id === id);
    }

    async add(query: Omit<SavedQuery, 'id'>, scope: SavedQueryScope = 'global'): Promise<SavedQuery> {
        const created: SavedQuery = {
            ...query,
            id: generateId(),
            parameters: normalizeParameters(query.parameters),
            lastUsed: Date.now()
        };
        delete created.scope;
        applyTags(created, query.tags);
        await this.insert(created, scope);
        this._onDidChange.fire();
        return { ...created, scope };
    }

    async update(id: string, patch: Partial<Omit<SavedQuery, 'id'>>): Promise<void> {
        const scope = this.findScope(id);
        if (!scope) {
            return;
        }
        const clean: Partial<SavedQuery> = { ...patch };
        delete clean.scope;
        delete clean.tags;
        if (patch.parameters !== undefined) {
            clean.parameters = normalizeParameters(patch.parameters);
        }
        const merge = (q: SavedQuery): SavedQuery => {
            const next = { ...q, ...clean };
            if (patch.tags !== undefined) {
                applyTags(next, patch.tags);
            }
            return next;
        };
        if (scope === 'workspace') {
            const idx = this.workspaceQueries.findIndex(q => q.id === id);
            if (idx >= 0) {
                this.workspaceQueries[idx] = merge(this.workspaceQueries[idx]);
                await this.persistWorkspaceFile();
            }
        } else {
            const all = this.getGlobalQueries();
            const idx = all.findIndex(q => q.id === id);
            if (idx >= 0) {
                all[idx] = merge(all[idx]);
                await this.context.globalState.update(SavedQueryStore.STORAGE_KEY, all);
            }
        }
        this._onDidChange.fire();
    }

    /** Add `tag` to every listed query that does not carry it yet. */
    async addTag(ids: string[], tag: string): Promise<void> {
        if (!normalizeTag(tag)) {
            return;
        }
        for (const id of ids) {
            const query = this.get(id);
            if (query) {
                await this.update(id, { tags: withTag(query.tags, tag) });
            }
        }
    }

    /** Remove `tag` from every listed query; `undefined` removes all their tags. */
    async removeTag(ids: string[], tag?: string): Promise<void> {
        for (const id of ids) {
            const query = this.get(id);
            if (query) {
                await this.update(id, { tags: tag === undefined ? [] : withoutTag(query.tags, tag) });
            }
        }
    }

    async delete(id: string): Promise<void> {
        const scope = this.findScope(id);
        if (!scope) {
            return;
        }
        await this.removeFrom(id, scope);
        this._onDidChange.fire();
    }

    /** Move a query between the personal store and the workspace file. */
    async move(id: string, scope: SavedQueryScope): Promise<boolean> {
        const current = this.findScope(id);
        if (!current || current === scope) {
            return false;
        }
        const existing = this.get(id);
        if (!existing) {
            return false;
        }
        if (scope === 'workspace' && !await this.ensureWorkspaceFile()) {
            return false;
        }
        const moved: SavedQuery = { ...existing };
        delete moved.scope;
        await this.removeFrom(id, current);
        await this.insert(moved, scope);
        this._onDidChange.fire();
        return true;
    }

    /** Remember that a query was just run, for "recently used" ordering. */
    async touch(id: string): Promise<void> {
        await this.update(id, { lastUsed: Date.now() });
    }

    getParameterValues(id: string): Record<string, string> {
        const all = this.context.globalState.get<Record<string, Record<string, string>>>(
            SavedQueryStore.VALUES_KEY, {}
        );
        const values = all[id];
        return values && typeof values === 'object' ? values : {};
    }

    async setParameterValues(id: string, values: Record<string, string>): Promise<void> {
        const all = {
            ...this.context.globalState.get<Record<string, Record<string, string>>>(SavedQueryStore.VALUES_KEY, {})
        };
        const sanitized: Record<string, string> = {};
        for (const [k, v] of Object.entries(values || {})) {
            if (typeof k === 'string' && k && v !== undefined && v !== null) {
                sanitized[k] = String(v);
            }
        }
        if (Object.keys(sanitized).length === 0) {
            delete all[id];
        } else {
            all[id] = sanitized;
        }
        await this.context.globalState.update(SavedQueryStore.VALUES_KEY, all);
    }

    // ===== Internal =====

    private getGlobalQueries(): SavedQuery[] {
        return normalizeSavedQueries(
            this.context.globalState.get<SavedQuery[]>(SavedQueryStore.STORAGE_KEY, [])
        );
    }

    private findScope(id: string): SavedQueryScope | undefined {
        if (this.workspaceQueries.some(q => q.id === id)) {
            return 'workspace';
        }
        if (this.getGlobalQueries().some(q => q.id === id)) {
            return 'global';
        }
        return undefined;
    }

    private async insert(query: SavedQuery, scope: SavedQueryScope): Promise<void> {
        if (scope === 'workspace' && await this.ensureWorkspaceFile()) {
            this.workspaceQueries.push(query);
            await this.persistWorkspaceFile();
            return;
        }
        const all = this.getGlobalQueries();
        all.push(query);
        await this.context.globalState.update(SavedQueryStore.STORAGE_KEY, all);
    }

    private async removeFrom(id: string, scope: SavedQueryScope): Promise<void> {
        if (scope === 'workspace') {
            this.workspaceQueries = this.workspaceQueries.filter(q => q.id !== id);
            await this.persistWorkspaceFile();
        } else {
            await this.context.globalState.update(
                SavedQueryStore.STORAGE_KEY, this.getGlobalQueries().filter(q => q.id !== id)
            );
        }
    }

    private reloadWorkspaceSource(): void {
        this.refreshWorkspaceFileUri();
        this.loadWorkspaceQueriesSync();
        this.setupWatcher();
        this._onDidChange.fire();
    }

    // ===== Workspace file handling =====

    private configuredRelativePath(): string {
        return vscode.workspace.getConfiguration('postgresQueryBuilder')
            .get<string>('savedQueriesFile', DEFAULT_WORKSPACE_FILE) || DEFAULT_WORKSPACE_FILE;
    }

    private refreshWorkspaceFileUri(): void {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            this.workspaceFileUri = undefined;
            return;
        }
        this.workspaceFileUri = vscode.Uri.joinPath(folders[0].uri, this.configuredRelativePath());
    }

    private loadWorkspaceQueriesSync(): void {
        this.workspaceQueries = [];
        const uri = this.workspaceFileUri;
        if (!uri) {
            return;
        }
        try {
            if (!fs.existsSync(uri.fsPath)) {
                return;
            }
            const parsed = JSON.parse(fs.readFileSync(uri.fsPath, 'utf8'));
            this.workspaceQueries = normalizeSavedQueries(
                Array.isArray(parsed) ? parsed : parsed?.queries
            );
        } catch (err: unknown) {
            vscode.window.showWarningMessage(
                `PostgreSQL Query Booster: could not read bookmarked queries file: ${getErrorMessage(err)}`
            );
        }
    }

    private async ensureWorkspaceFile(): Promise<boolean> {
        if (!this.workspaceFileUri) {
            return false;
        }
        const dir = path.dirname(this.workspaceFileUri.fsPath);
        try {
            if (!fs.existsSync(dir)) {
                await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
            }
            return true;
        } catch {
            return false;
        }
    }

    private async persistWorkspaceFile(): Promise<void> {
        if (!this.workspaceFileUri) {
            return;
        }
        const payload: WorkspaceQueriesFile = {
            $schema: 'postgres-query-builder.saved-queries/v1',
            version: FILE_VERSION,
            queries: this.workspaceQueries.map(serializeWorkspaceQuery)
        };
        const json = JSON.stringify(payload, null, 2) + '\n';
        this.suppressWatcher = true;
        try {
            await vscode.workspace.fs.writeFile(this.workspaceFileUri, Buffer.from(json, 'utf8'));
        } finally {
            setTimeout(() => { this.suppressWatcher = false; }, 250);
        }
    }

    private setupWatcher(): void {
        this.fileWatcher?.dispose();
        this.fileWatcher = undefined;
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0 || !this.workspaceFileUri) {
            return;
        }
        const pattern = new vscode.RelativePattern(folders[0], this.configuredRelativePath());
        this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);
        const handler = () => {
            if (this.suppressWatcher) {
                return;
            }
            this.loadWorkspaceQueriesSync();
            this._onDidChange.fire();
        };
        this.fileWatcher.onDidCreate(handler);
        this.fileWatcher.onDidChange(handler);
        this.fileWatcher.onDidDelete(() => {
            if (this.suppressWatcher) {
                return;
            }
            this.workspaceQueries = [];
            this._onDidChange.fire();
        });
        this.context.subscriptions.push(this.fileWatcher);
    }
}

function generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}
