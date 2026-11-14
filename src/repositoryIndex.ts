/**
 * Keeps the CREATE statements of the workspace's SQL files, for the comparison
 * of the database with the repository.
 *
 * The scan is lazy and never blocks: it starts in the background when a tree
 * first asks for it, the trees render without marks meanwhile and once more
 * when it is done. Afterwards a file watcher rescans only the file that
 * changed. Only saved files are read; unsaved editor content is not considered.
 */
import * as vscode from 'vscode';
import { scanSqlText } from './repositoryScanner';
import type { LocatedDefinition, RepositorySnapshot, RepositorySource } from './repositoryComparison';
import { Logger } from './logger';

export const DEFAULT_INCLUDE = ['**/*.sql', '**/*.pgsql', '**/*.psql'];
export const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/.git/**'];
const DEFAULT_MAX_FILE_SIZE_KB = 5120;
const CONCURRENCY = 8;
const RESCAN_DELAY_MS = 300;

export interface RepositorySettings {
    compare: boolean;
    include: string[];
    exclude: string[];
    maxFileSizeKb: number;
}

export function readRepositorySettings(): RepositorySettings {
    const cfg = vscode.workspace.getConfiguration('postgresQueryBuilder');
    const list = (key: string, fallback: string[]): string[] => {
        const value = cfg.get<unknown>(key, fallback);
        return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : fallback;
    };
    return {
        compare: cfg.get<boolean>('repository.compare', true),
        include: list('repository.include', DEFAULT_INCLUDE),
        exclude: list('repository.exclude', DEFAULT_EXCLUDE),
        maxFileSizeKb: cfg.get<number>('repository.maxFileSizeKb', DEFAULT_MAX_FILE_SIZE_KB)
    };
}

/** One glob for a list of globs: `{a,b}`; undefined for an empty list. */
export function combineGlobs(globs: readonly string[]): string | undefined {
    if (globs.length === 0) return undefined;
    return globs.length === 1 ? globs[0] : `{${globs.join(',')}}`;
}

/** A regular expression for a workspace-relative glob with `**`, `*`, `?` and `{a,b}`. */
export function globToRegExp(glob: string): RegExp {
    let re = '';
    let braces = 0;
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                if (glob[i + 2] === '/') {
                    re += '(?:.*/)?';
                    i += 2;
                } else {
                    re += '.*';
                    i += 1;
                }
            } else {
                re += '[^/]*';
            }
        } else if (c === '?') {
            re += '[^/]';
        } else if (c === '{') {
            braces++;
            re += '(?:';
        } else if (c === '}' && braces > 0) {
            braces--;
            re += ')';
        } else if (c === ',' && braces > 0) {
            re += '|';
        } else if (c === '\\' || c === '/') {
            re += '/';
        } else {
            re += c.replace(/[.+^$()|[\]]/g, '\\$&');
        }
    }
    return new RegExp(`^${re}$`, 'i');
}

/** True when the workspace-relative path matches one of the globs. */
export function matchesAnyGlob(relativePath: string, globs: readonly string[]): boolean {
    const normalized = relativePath.replace(/\\/g, '/');
    return globs.some(g => globToRegExp(g).test(normalized));
}

async function forEachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < items.length) {
            const item = items[next++];
            await fn(item);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export class RepositoryIndex implements RepositorySource, vscode.Disposable {
    private files = new Map<string, LocatedDefinition[]>();
    private version = 0;
    private started = false;
    private ready = false;
    /**
     * Grows whenever earlier work becomes stale (restart, full rescan,
     * dispose); a scan only writes its result when its generation is current.
     */
    private generation = 0;
    private scanning?: Promise<void>;
    private watchers: vscode.Disposable[] = [];
    private cached: RepositorySnapshot | null = null;
    private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;
    private readonly disposables: vscode.Disposable[] = [];

    /** `progressViewId`: the view that shows the progress of the scan. */
    constructor(private readonly progressViewId: string, private readonly settings: () => RepositorySettings = readRepositorySettings) {
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('postgresQueryBuilder.repository')) this.restart();
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.restart())
        );
    }

    snapshot(): RepositorySnapshot | null {
        if (!this.settings().compare || !this.ready) return null;
        if (!this.cached) {
            this.cached = { version: this.version, definitions: [...this.files.values()].flat() };
        }
        return this.cached;
    }

    ensureScanned(): void {
        if (this.started || !this.settings().compare) return;
        this.started = true;
        this.watch();
        this.startFullScan();
    }

    /** Throw everything away and scan again (the *Rescan Repository* command). */
    async rescan(): Promise<void> {
        this.restart();
        this.ensureScanned();
        await this.scanning;
    }

    private restart(): void {
        this.generation++;
        this.started = false;
        this.ready = false;
        this.files = new Map();
        this.disposeWatchers();
        this.changed();
    }

    private changed(): void {
        this.version++;
        this.cached = null;
        this._onDidChange.fire();
    }

    /** Scan every file again; the current definitions stay until the new ones are complete. */
    private startFullScan(): void {
        const generation = ++this.generation;
        this.scanning = this.fullScan(generation).catch((err: unknown) => Logger.error('RepositoryIndex.fullScan', err));
    }

    private async fullScan(generation: number): Promise<void> {
        // Yield first, so whatever asked for the scan renders before it starts.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (generation !== this.generation) return;
        const settings = this.settings();
        const include = combineGlobs(settings.include);
        const next = new Map<string, LocatedDefinition[]>();
        if (include && vscode.workspace.workspaceFolders?.length) {
            const started = Date.now();
            await vscode.window.withProgress(
                { location: { viewId: this.progressViewId }, title: 'Scanning the repository for CREATE statements' },
                async () => {
                    const uris = await vscode.workspace.findFiles(include, combineGlobs(settings.exclude) ?? null);
                    await forEachLimited(uris, CONCURRENCY, async (uri) => {
                        if (generation !== this.generation) return;
                        const definitions = await this.readDefinitions(uri, settings.maxFileSizeKb);
                        if (definitions.length > 0) next.set(uri.toString(), definitions);
                    });
                    Logger.log('RepositoryIndex.fullScan', `${uris.length} files scanned in ${Date.now() - started} ms`);
                }
            );
        }
        if (generation !== this.generation) return;
        this.files = next;
        this.ready = true;
        this.changed();
    }

    /** The definitions of one file; none when it is too large or cannot be read. */
    private async readDefinitions(uri: vscode.Uri, maxFileSizeKb: number): Promise<LocatedDefinition[]> {
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.size > maxFileSizeKb * 1024) return [];
            const text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
            const key = uri.toString();
            return scanSqlText(text).map(d => ({ ...d, uri: key }));
        } catch (err: unknown) {
            Logger.error('RepositoryIndex.readDefinitions', err);
            return [];
        }
    }

    private isExcluded(uri: vscode.Uri): boolean {
        return matchesAnyGlob(vscode.workspace.asRelativePath(uri, false), this.settings().exclude);
    }

    private isIncluded(uri: vscode.Uri): boolean {
        return matchesAnyGlob(vscode.workspace.asRelativePath(uri, false), this.settings().include);
    }

    private schedule(key: string, run: () => void): void {
        clearTimeout(this.pending.get(key));
        this.pending.set(key, setTimeout(() => {
            this.pending.delete(key);
            run();
        }, RESCAN_DELAY_MS));
    }

    private rescanFile(uri: vscode.Uri): void {
        if (this.isExcluded(uri)) return;
        this.schedule(uri.toString(), () => {
            const generation = this.generation;
            void this.readDefinitions(uri, this.settings().maxFileSizeKb).then((definitions) => {
                if (generation !== this.generation || !this.ready) return;
                if (definitions.length > 0) this.files.set(uri.toString(), definitions);
                else this.files.delete(uri.toString());
                this.changed();
            });
        });
    }

    /** Forget a deleted file, or every file of a deleted folder (which reports one event for itself). */
    private forget(uri: vscode.Uri): void {
        const key = uri.toString();
        const prefix = key.endsWith('/') ? key : `${key}/`;
        let removed = false;
        for (const file of [...this.files.keys()]) {
            if (file === key || file.startsWith(prefix)) {
                this.files.delete(file);
                removed = true;
            }
        }
        if (removed && this.ready) this.changed();
    }

    private watch(): void {
        const include = combineGlobs(this.settings().include);
        if (!include) return;
        const files = vscode.workspace.createFileSystemWatcher(include);
        files.onDidCreate((uri) => this.rescanFile(uri));
        files.onDidChange((uri) => this.rescanFile(uri));
        files.onDidDelete((uri) => this.forget(uri));
        // A folder that is deleted, moved or renamed reports only itself, which
        // the include globs do not match.
        const folders = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
        folders.onDidDelete((uri) => {
            if (!this.isIncluded(uri)) this.forget(uri);
        });
        folders.onDidCreate((uri) => {
            if (this.isIncluded(uri) || this.isExcluded(uri)) return;
            void Promise.resolve(vscode.workspace.fs.stat(uri)).then((stat) => {
                if (stat.type === vscode.FileType.Directory && this.ready) {
                    this.schedule('\u0000folders', () => this.startFullScan());
                }
            }, () => undefined);
        });
        this.watchers = [files, folders];
    }

    private disposeWatchers(): void {
        for (const watcher of this.watchers) watcher.dispose();
        this.watchers = [];
        for (const timer of this.pending.values()) clearTimeout(timer);
        this.pending.clear();
    }

    dispose(): void {
        this.generation++;
        this.disposeWatchers();
        this._onDidChange.dispose();
        for (const d of this.disposables) d.dispose();
    }
}
