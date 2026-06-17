import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getErrorMessage } from './logger';

export interface MappingCondition {
    column: string;
    operator: string;
    value: string;
}

/** An additional source-column/target-column equality used for composite-key matches. */
export interface ColumnPair {
    sourceColumn: string;
    targetColumn: string;
}

export type MappingScope = 'workspace' | 'global';

export interface CustomColumnMapping {
    id: string;
    sourceSchema: string;
    sourceTable: string;
    sourceColumn: string;
    targetSchema: string;
    targetTable: string;
    targetColumn: string;
    conditions: MappingCondition[];
    isDefault: boolean;
    label?: string;
    /**
     * Extra source/target column equalities for multi-column (composite-key)
     * matches. The primary pair lives in `sourceColumn`/`targetColumn`; these are
     * ANDed onto it when deriving joins.
     */
    additionalColumnPairs?: ColumnPair[];
    /** Storage scope. 'workspace' mappings live in a JSON file committed to git. */
    scope?: MappingScope;
    /** True when this mapping is a synthesized reverse view of a user-defined mapping. */
    reversed?: boolean;
    /** When reversed, the id of the original (forward) mapping for reference. */
    originalId?: string;
}

interface WorkspaceMappingsFile {
    $schema?: string;
    version: number;
    mappings: CustomColumnMapping[];
}

const DEFAULT_WORKSPACE_FILE = '.vscode/postgres-query-builder.mappings.json';
const FILE_VERSION = 1;

/**
 * Sanitize the additional column pairs of a mapping: keep only well-formed
 * entries where both the source and target column are non-empty strings.
 */
export function normalizeColumnPairs(pairs: unknown): ColumnPair[] {
    if (!Array.isArray(pairs)) {
        return [];
    }
    const result: ColumnPair[] = [];
    for (const p of pairs) {
        const sourceColumn = typeof p?.sourceColumn === 'string' ? p.sourceColumn.trim() : '';
        const targetColumn = typeof p?.targetColumn === 'string' ? p.targetColumn.trim() : '';
        if (sourceColumn && targetColumn) {
            result.push({ sourceColumn, targetColumn });
        }
    }
    return result;
}

export class ColumnMappingManager {
    private static readonly STORAGE_KEY = 'customColumnMappings';
    private context: vscode.ExtensionContext;
    private workspaceMappings: CustomColumnMapping[] = [];
    private workspaceFileUri: vscode.Uri | undefined;
    private fileWatcher: vscode.FileSystemWatcher | undefined;
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange: vscode.Event<void> = this._onDidChange.event;
    private suppressWatcher = false;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.refreshWorkspaceFileUri();
        this.loadWorkspaceMappingsSync();
        this.setupWatcher();

        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('postgresQueryBuilder.customMappingsFile')) {
                    this.refreshWorkspaceFileUri();
                    this.loadWorkspaceMappingsSync();
                    this.setupWatcher();
                    this._onDidChange.fire();
                }
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                this.refreshWorkspaceFileUri();
                this.loadWorkspaceMappingsSync();
                this.setupWatcher();
                this._onDidChange.fire();
            }),
            this._onDidChange
        );
    }

    dispose(): void {
        this.fileWatcher?.dispose();
    }

    // ===== Public API =====

    getWorkspaceFileUri(): vscode.Uri | undefined {
        return this.workspaceFileUri;
    }

    hasWorkspaceFile(): boolean {
        return !!this.workspaceFileUri && fs.existsSync(this.workspaceFileUri.fsPath);
    }

    getAllMappings(): CustomColumnMapping[] {
        const personal = this.getGlobalMappings().map(m => ({ ...m, scope: 'global' as const }));
        const workspace = this.workspaceMappings.map(m => ({ ...m, scope: 'workspace' as const }));
        return [...workspace, ...personal];
    }

    getMappingsForTable(schema: string, table: string): CustomColumnMapping[] {
        const all = this.getAllMappings();
        const forward = all.filter(m => m.sourceSchema === schema && m.sourceTable === table);
        const reverse = all
            .filter(m => m.targetSchema === schema && m.targetTable === table
                && !(m.sourceSchema === schema && m.sourceTable === table))
            .map(m => this.reverseMapping(m));
        return [...forward, ...reverse];
    }

    getMappingsForColumn(schema: string, table: string, column: string): CustomColumnMapping[] {
        const all = this.getAllMappings();
        const forward = all.filter(m => m.sourceSchema === schema && m.sourceTable === table && m.sourceColumn === column);
        const reverse = all
            .filter(m => m.targetSchema === schema && m.targetTable === table && m.targetColumn === column
                && !(m.sourceSchema === schema && m.sourceTable === table && m.sourceColumn === column))
            .map(m => this.reverseMapping(m));
        return [...forward, ...reverse];
    }

    getApplicableMappings(schema: string, table: string, column: string, rowData: Record<string, any>): CustomColumnMapping[] {
        const mappings = this.getMappingsForColumn(schema, table, column);
        return mappings.filter(m => this.evaluateConditions(m.conditions, rowData));
    }

    async addMapping(mapping: Omit<CustomColumnMapping, 'id'>, scope: MappingScope = 'global'): Promise<CustomColumnMapping> {
        const newMapping: CustomColumnMapping = {
            ...mapping,
            id: this.generateId(),
            scope
        };
        const stored: CustomColumnMapping = { ...newMapping };
        delete stored.scope;
        delete stored.reversed;
        delete stored.originalId;

        if (scope === 'workspace') {
            const ensured = await this.ensureWorkspaceFile();
            if (!ensured) {
                return this.addMapping(mapping, 'global');
            }
            this.workspaceMappings.push(stored);
            await this.persistWorkspaceFile();
        } else {
            const all = this.getGlobalMappings();
            all.push(stored);
            await this.context.globalState.update(ColumnMappingManager.STORAGE_KEY, all);
        }
        this._onDidChange.fire();
        return newMapping;
    }

    async updateMapping(id: string, updates: Partial<Omit<CustomColumnMapping, 'id'>>): Promise<void> {
        if (id.startsWith('rev:')) {
            const realId = id.substring(4);
            return this.updateMapping(realId, updates);
        }
        const targetScope: MappingScope | undefined = updates.scope;
        const cleanUpdates: any = { ...updates };
        delete cleanUpdates.scope;
        delete cleanUpdates.reversed;
        delete cleanUpdates.originalId;

        const currentScope = this.findScope(id);
        if (!currentScope) return;

        if (targetScope && targetScope !== currentScope) {
            const existing = this.findMapping(id);
            if (!existing) return;
            const moved: CustomColumnMapping = { ...existing, ...cleanUpdates };
            delete moved.scope;
            delete moved.reversed;
            delete moved.originalId;
            await this.deleteMappingInternal(id, currentScope);
            if (targetScope === 'workspace') {
                const ensured = await this.ensureWorkspaceFile();
                if (!ensured) {
                    const arr = this.getGlobalMappings();
                    arr.push(moved);
                    await this.context.globalState.update(ColumnMappingManager.STORAGE_KEY, arr);
                } else {
                    this.workspaceMappings.push(moved);
                    await this.persistWorkspaceFile();
                }
            } else {
                const arr = this.getGlobalMappings();
                arr.push(moved);
                await this.context.globalState.update(ColumnMappingManager.STORAGE_KEY, arr);
            }
        } else if (currentScope === 'workspace') {
            const idx = this.workspaceMappings.findIndex(m => m.id === id);
            if (idx >= 0) {
                this.workspaceMappings[idx] = { ...this.workspaceMappings[idx], ...cleanUpdates };
                await this.persistWorkspaceFile();
            }
        } else {
            const all = this.getGlobalMappings();
            const idx = all.findIndex(m => m.id === id);
            if (idx >= 0) {
                all[idx] = { ...all[idx], ...cleanUpdates };
                await this.context.globalState.update(ColumnMappingManager.STORAGE_KEY, all);
            }
        }
        this._onDidChange.fire();
    }

    async deleteMapping(id: string): Promise<void> {
        if (id.startsWith('rev:')) {
            const realId = id.substring(4);
            return this.deleteMapping(realId);
        }
        const scope = this.findScope(id);
        if (!scope) return;
        await this.deleteMappingInternal(id, scope);
        this._onDidChange.fire();
    }

    async exportToFile(uri: vscode.Uri): Promise<number> {
        const all = [...this.workspaceMappings, ...this.getGlobalMappings()];
        const payload: WorkspaceMappingsFile = {
            $schema: 'postgres-query-builder.custom-mappings/v1',
            version: FILE_VERSION,
            mappings: all
        };
        const json = JSON.stringify(payload, null, 2) + '\n';
        await vscode.workspace.fs.writeFile(uri, Buffer.from(json, 'utf8'));
        return all.length;
    }

    async importFromFile(uri: vscode.Uri, scope: MappingScope, overwrite: boolean): Promise<{ added: number; replaced: number; skipped: number }> {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString('utf8');
        let parsed: any;
        try {
            parsed = JSON.parse(text);
        } catch (err: unknown) {
            throw new Error(`Could not parse JSON: ${getErrorMessage(err)}`);
        }
        const incoming: CustomColumnMapping[] = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.mappings) ? parsed.mappings : [];
        if (!incoming.length) {
            throw new Error('File contains no mappings.');
        }

        let added = 0, replaced = 0, skipped = 0;
        if (scope === 'workspace') {
            const ensured = await this.ensureWorkspaceFile();
            if (!ensured) {
                throw new Error('No workspace folder available to write the mappings file.');
            }
            for (const m of incoming) {
                const norm = this.normalizeIncoming(m);
                const idx = this.workspaceMappings.findIndex(x => x.id === norm.id);
                if (idx >= 0) {
                    if (overwrite) {
                        this.workspaceMappings[idx] = norm;
                        replaced++;
                    } else {
                        skipped++;
                    }
                } else {
                    this.workspaceMappings.push(norm);
                    added++;
                }
            }
            await this.persistWorkspaceFile();
        } else {
            const all = this.getGlobalMappings();
            for (const m of incoming) {
                const norm = this.normalizeIncoming(m);
                const idx = all.findIndex(x => x.id === norm.id);
                if (idx >= 0) {
                    if (overwrite) {
                        all[idx] = norm;
                        replaced++;
                    } else {
                        skipped++;
                    }
                } else {
                    all.push(norm);
                    added++;
                }
            }
            await this.context.globalState.update(ColumnMappingManager.STORAGE_KEY, all);
        }
        this._onDidChange.fire();
        return { added, replaced, skipped };
    }

    // ===== Internal =====

    private getGlobalMappings(): CustomColumnMapping[] {
        return this.context.globalState.get<CustomColumnMapping[]>(ColumnMappingManager.STORAGE_KEY, []);
    }

    private findScope(id: string): MappingScope | undefined {
        if (this.workspaceMappings.some(m => m.id === id)) return 'workspace';
        if (this.getGlobalMappings().some(m => m.id === id)) return 'global';
        return undefined;
    }

    private findMapping(id: string): CustomColumnMapping | undefined {
        return this.workspaceMappings.find(m => m.id === id)
            || this.getGlobalMappings().find(m => m.id === id);
    }

    private async deleteMappingInternal(id: string, scope: MappingScope): Promise<void> {
        if (scope === 'workspace') {
            this.workspaceMappings = this.workspaceMappings.filter(m => m.id !== id);
            await this.persistWorkspaceFile();
        } else {
            const all = this.getGlobalMappings().filter(m => m.id !== id);
            await this.context.globalState.update(ColumnMappingManager.STORAGE_KEY, all);
        }
    }

    private normalizeIncoming(m: CustomColumnMapping): CustomColumnMapping {
        const normalized: CustomColumnMapping = {
            id: m.id || this.generateId(),
            sourceSchema: m.sourceSchema,
            sourceTable: m.sourceTable,
            sourceColumn: m.sourceColumn,
            targetSchema: m.targetSchema,
            targetTable: m.targetTable,
            targetColumn: m.targetColumn,
            conditions: Array.isArray(m.conditions) ? m.conditions : [],
            isDefault: !!m.isDefault,
            label: m.label
        };
        const pairs = normalizeColumnPairs(m.additionalColumnPairs);
        if (pairs.length) {
            normalized.additionalColumnPairs = pairs;
        }
        return normalized;
    }

    private reverseMapping(m: CustomColumnMapping): CustomColumnMapping {
        const reversed: CustomColumnMapping = {
            id: `rev:${m.id}`,
            sourceSchema: m.targetSchema,
            sourceTable: m.targetTable,
            sourceColumn: m.targetColumn,
            targetSchema: m.sourceSchema,
            targetTable: m.sourceTable,
            targetColumn: m.sourceColumn,
            conditions: [],
            isDefault: false,
            label: m.label,
            scope: m.scope,
            reversed: true,
            originalId: m.id
        };
        const pairs = normalizeColumnPairs(m.additionalColumnPairs);
        if (pairs.length) {
            reversed.additionalColumnPairs = pairs.map(p => ({
                sourceColumn: p.targetColumn,
                targetColumn: p.sourceColumn
            }));
        }
        return reversed;
    }

    private evaluateConditions(conditions: MappingCondition[], rowData: Record<string, any>): boolean {
        if (!conditions || conditions.length === 0) return true;
        return conditions.every(cond => {
            const cellValue = rowData[cond.column];
            if (cellValue === null || cellValue === undefined) return false;
            const strVal = String(cellValue);
            switch (cond.operator) {
                case '=': return strVal === cond.value;
                case '!=': return strVal !== cond.value;
                case '>': return strVal > cond.value;
                case '<': return strVal < cond.value;
                case '>=': return strVal >= cond.value;
                case '<=': return strVal <= cond.value;
                case 'LIKE': return strVal.includes(cond.value);
                case 'ILIKE': return strVal.toLowerCase().includes(cond.value.toLowerCase());
                default: return strVal === cond.value;
            }
        });
    }

    private generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
    }

    // ===== Workspace file handling =====

    private refreshWorkspaceFileUri(): void {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            this.workspaceFileUri = undefined;
            return;
        }
        const rel = vscode.workspace.getConfiguration('postgresQueryBuilder')
            .get<string>('customMappingsFile', DEFAULT_WORKSPACE_FILE) || DEFAULT_WORKSPACE_FILE;
        this.workspaceFileUri = vscode.Uri.joinPath(folders[0].uri, rel);
    }

    private loadWorkspaceMappingsSync(): void {
        this.workspaceMappings = [];
        const uri = this.workspaceFileUri;
        if (!uri) return;
        try {
            if (!fs.existsSync(uri.fsPath)) return;
            const text = fs.readFileSync(uri.fsPath, 'utf8');
            const parsed = JSON.parse(text);
            const arr: CustomColumnMapping[] = Array.isArray(parsed)
                ? parsed
                : Array.isArray(parsed?.mappings) ? parsed.mappings : [];
            this.workspaceMappings = arr.map(m => this.normalizeIncoming(m));
        } catch (err: unknown) {
            vscode.window.showWarningMessage(`PostgreSQL Query Builder: could not read custom mappings file: ${getErrorMessage(err)}`);
        }
    }

    private async ensureWorkspaceFile(): Promise<boolean> {
        if (!this.workspaceFileUri) return false;
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
        if (!this.workspaceFileUri) return;
        const payload: WorkspaceMappingsFile = {
            $schema: 'postgres-query-builder.custom-mappings/v1',
            version: FILE_VERSION,
            mappings: this.workspaceMappings
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
        if (!folders || folders.length === 0 || !this.workspaceFileUri) return;
        const rel = vscode.workspace.getConfiguration('postgresQueryBuilder')
            .get<string>('customMappingsFile', DEFAULT_WORKSPACE_FILE) || DEFAULT_WORKSPACE_FILE;
        const pattern = new vscode.RelativePattern(folders[0], rel);
        this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);
        const handler = () => {
            if (this.suppressWatcher) return;
            this.loadWorkspaceMappingsSync();
            this._onDidChange.fire();
        };
        this.fileWatcher.onDidCreate(handler);
        this.fileWatcher.onDidChange(handler);
        this.fileWatcher.onDidDelete(() => {
            if (this.suppressWatcher) return;
            this.workspaceMappings = [];
            this._onDidChange.fire();
        });
        this.context.subscriptions.push(this.fileWatcher);
    }
}
