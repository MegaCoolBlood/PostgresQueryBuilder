/**
 * The SQL editor features as VS Code providers: Go to Definition, Find All
 * References, outline and workspace symbols, hover, signature help,
 * completion of the user's routines and of doc comments, CodeLens above
 * CREATE statements, diagnostics and their quick fixes. The answers come from
 * `sqlCodeIntel.ts`; this module only loads the sources and converts.
 *
 * Nothing is loaded at activation: the catalog is read the first time a
 * feature asks while connected, the repository scan starts the same way.
 */
import * as vscode from 'vscode';
import { MatcherCache, type RepositorySnapshot } from './repositoryComparison';
import type { DatabaseCatalog } from './databaseCatalog';
import type { RepoObjectKind, SourcePosition } from './repositoryScanner';
import {
    HOVER_COMMANDS,
    addDocCommentEdit,
    addMissingParamsEdit,
    codeLensesFor,
    definitionForFinding,
    definitionRanges,
    docFindings,
    docMarkdown,
    docOf,
    docTemplateAt,
    documentSymbols,
    findReferences,
    hoverMarkdown,
    objectSignature,
    objectStatus,
    objectsAt,
    paramsOf,
    qualifiedName,
    removeEntryEdit,
    routineCompletions,
    routineFindings,
    signatureHelpAt,
    workspaceSymbols,
    commandNode,
    type SymbolInfo,
    type CodeFinding,
    type FileRange,
    type IntelSources,
    type ObjectsAt,
    type TextEditInfo
} from './sqlCodeIntel';
import type { ResolvedObject } from './sqlResolution';
import { readRepositorySettings } from './repositoryIndex';
import { Logger } from './logger';
import { debugAvailability } from './plpgsqlDebugger';

/** The part of the repository index the features need. */
export interface IntelRepository {
    snapshot(): RepositorySnapshot | null;
    ensureScanned(): void;
    filesContaining(word: string): Promise<Array<{ uri: string; text: string }>>;
    readonly onDidChange: vscode.Event<void>;
}

export type ColumnSource = (schema: string, table: string) => Promise<Array<{ name: string; type: string }>>;

const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('postgresQueryBuilder');

export function toPosition(p: SourcePosition): vscode.Position {
    return new vscode.Position(p.line, p.character);
}

export function toRange(start: SourcePosition, end: SourcePosition): vscode.Range {
    return new vscode.Range(start.line, start.character, end.line, end.character);
}

export function toLocation(r: FileRange): vscode.Location {
    return new vscode.Location(vscode.Uri.parse(r.uri), toRange(r.start, r.end));
}

/**
 * The sources every feature resolves names with: the repository's
 * definitions and, while connected, the catalog of the database.
 */
export class SqlIntel {
    private readonly matchers = new MatcherCache();

    constructor(readonly catalog: DatabaseCatalog, readonly repository: IntelRepository) {}

    /** With `builtins`, also the names of built-in functions and types (for diagnostics). */
    async sources(options: { builtins?: boolean } = {}): Promise<IntelSources> {
        this.repository.ensureScanned();
        let defaultSchema = 'public';
        const sources: IntelSources = { matcher: null, db: null, searchPath: null, allowedSchema: (s) => this.catalog.allowedSchema(s), bodies: this.catalog.bodies };
        if (this.catalog.isConnected()) {
            try {
                const data = await this.catalog.load();
                defaultSchema = data.defaultSchema;
                const [db, unmarked, builtins] = await Promise.all([
                    this.catalog.index(),
                    this.catalog.unmarked(),
                    options.builtins ? this.catalog.builtins() : Promise.resolve(null)
                ]);
                Object.assign(sources, { db, unmarked, builtins, searchPath: data.searchPath });
            } catch (err: unknown) {
                Logger.error('SqlIntel.sources', err);
            }
        }
        sources.matcher = this.matchers.get(this.repository.snapshot(), defaultSchema);
        return sources;
    }

    /** What the name at `position` stands for. */
    async objectsAt(document: vscode.TextDocument, position: vscode.Position): Promise<{ at: ObjectsAt | undefined; sources: IntelSources }> {
        const sources = await this.sources();
        return { at: objectsAt(document.getText(), document.offsetAt(position), document.uri.toString(), sources), sources };
    }

    /** Every reference to the objects in the repository and in the open document. */
    async references(targets: readonly ResolvedObject[], includeDeclaration: boolean, document?: vscode.TextDocument): Promise<FileRange[]> {
        const sources = await this.sources();
        const files = new Map<string, { uri: string; text: string }>();
        for (const name of new Set(targets.map(t => t.name))) {
            for (const file of await this.repository.filesContaining(name)) files.set(file.uri, file);
        }
        if (document && !files.has(document.uri.toString())) files.set(document.uri.toString(), { uri: document.uri.toString(), text: document.getText() });
        return findReferences(targets, [...files.values()], sources, includeDeclaration);
    }
}

// ===== Go to Definition =====

export class SqlDefinitionProvider implements vscode.DefinitionProvider {
    private lastMessage = { key: '', at: 0 };

    constructor(private readonly intel: SqlIntel, private readonly now: () => number = Date.now) {}

    async provideDefinition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Location[] | undefined> {
        if (!readRepositorySettings().compare) return undefined;
        const { at } = await this.intel.objectsAt(document, position);
        if (!at) return undefined;
        const ranges = definitionRanges(at.objects);
        if (ranges.length > 0) return ranges.map(toLocation);
        if (!this.intel.repository.snapshot()) {
            this.status('scanning', 'The repository is still being scanned for CREATE statements');
        } else {
            const inDb = at.objects.find(o => o.db);
            if (inDb) this.status(qualifiedName(inDb), `${qualifiedName(inDb)} exists in the database but not in the repository`);
        }
        return undefined;
    }

    /** VS Code asks on Ctrl+hover too, so the same message is repeated only after a pause. */
    private status(key: string, message: string): void {
        const now = this.now();
        if (this.lastMessage.key === key && now - this.lastMessage.at < 5000) return;
        this.lastMessage = { key, at: now };
        vscode.window.setStatusBarMessage(`$(info) ${message}`, 5000);
    }
}

// ===== References =====

export class SqlReferenceProvider implements vscode.ReferenceProvider {
    constructor(private readonly intel: SqlIntel) {}

    async provideReferences(document: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext, token: vscode.CancellationToken): Promise<vscode.Location[] | undefined> {
        if (!readRepositorySettings().compare) return undefined;
        const { at } = await this.intel.objectsAt(document, position);
        if (!at || at.objects.length === 0 || token.isCancellationRequested) return undefined;
        const refs = await this.intel.references(at.objects, context.includeDeclaration, document);
        return token.isCancellationRequested ? undefined : refs.map(toLocation);
    }
}

// ===== Symbols =====

export const SYMBOL_KINDS: Record<RepoObjectKind, vscode.SymbolKind> = {
    function: vscode.SymbolKind.Function,
    procedure: vscode.SymbolKind.Method,
    aggregate: vscode.SymbolKind.Function,
    table: vscode.SymbolKind.Struct,
    type: vscode.SymbolKind.Struct,
    foreign: vscode.SymbolKind.Struct,
    view: vscode.SymbolKind.Interface,
    matview: vscode.SymbolKind.Interface,
    domain: vscode.SymbolKind.TypeParameter,
    sequence: vscode.SymbolKind.Number,
    trigger: vscode.SymbolKind.Event,
    schema: vscode.SymbolKind.Namespace,
    extension: vscode.SymbolKind.Package
};

export class SqlDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
    provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
        const groupBySchema = config().get<boolean>('editor.outlineGroupBySchema', true);
        const toSymbol = (s: SymbolInfo): vscode.DocumentSymbol => {
            const symbol = new vscode.DocumentSymbol(s.name, s.detail, SYMBOL_KINDS[s.kind], toRange(s.start, s.end), toRange(s.selectionStart, s.selectionEnd));
            if (s.children) symbol.children = s.children.map(toSymbol);
            return symbol;
        };
        return documentSymbols(document.getText(), { groupBySchema }).map(toSymbol);
    }
}

export class SqlWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
    constructor(private readonly repository: IntelRepository) {}

    provideWorkspaceSymbols(query: string): vscode.SymbolInformation[] {
        this.repository.ensureScanned();
        const snapshot = this.repository.snapshot();
        if (!snapshot) return [];
        return workspaceSymbols(snapshot.definitions, query).map(({ def, name }) =>
            new vscode.SymbolInformation(name, SYMBOL_KINDS[def.kind], def.schema ?? '', toLocation({ uri: def.uri, start: def.start, end: def.end })));
    }
}

// ===== Hover =====

const MAX_HOVER_COLUMNS = 20;

export class SqlHoverProvider implements vscode.HoverProvider {
    constructor(private readonly intel: SqlIntel, private readonly columns: ColumnSource) {}

    async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
        if (!config().get<boolean>('editor.hover', true)) return undefined;
        const { at, sources } = await this.intel.objectsAt(document, position);
        if (!at || at.objects.length === 0) return undefined;
        const parts: string[] = [];
        for (const object of at.objects.slice(0, 5)) {
            let columns: Array<{ name: string; type: string }> | undefined;
            if (object.db?.relation) {
                try {
                    columns = await this.columns(object.schema, object.name);
                } catch (err: unknown) {
                    Logger.error('SqlHoverProvider.columns', err);
                }
            }
            parts.push(hoverMarkdown({
                object,
                status: objectStatus(object, sources),
                columns: columns?.slice(0, MAX_HOVER_COLUMNS),
                columnCount: columns?.length
            }));
        }
        if (at.objects.length > 5) parts.push(`… and ${at.objects.length - 5} more overloads`);
        const markdown = new vscode.MarkdownString(parts.join('\n\n---\n\n'));
        markdown.isTrusted = { enabledCommands: [...HOVER_COMMANDS] };
        return new vscode.Hover(markdown, new vscode.Range(document.positionAt(at.reference.start), document.positionAt(at.reference.end)));
    }
}

// ===== Signature help =====

export class SqlSignatureHelpProvider implements vscode.SignatureHelpProvider {
    constructor(private readonly intel: SqlIntel) {}

    async provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.SignatureHelp | undefined> {
        if (!config().get<boolean>('editor.signatureHelp', true)) return undefined;
        const sources = await this.intel.sources();
        const info = signatureHelpAt(document.getText(), document.offsetAt(position), sources);
        if (!info) return undefined;
        const help = new vscode.SignatureHelp();
        help.signatures = info.signatures.map(s => {
            const sig = new vscode.SignatureInformation(s.label, s.documentation ? new vscode.MarkdownString(s.documentation) : undefined);
            sig.parameters = s.parameters.map(p => new vscode.ParameterInformation(p.label, p.documentation));
            return sig;
        });
        help.activeSignature = info.activeSignature;
        help.activeParameter = info.activeParameter;
        return help;
    }
}

// ===== Completion =====

export class SqlRoutineCompletionProvider implements vscode.CompletionItemProvider {
    private readonly objects = new WeakMap<vscode.CompletionItem, ResolvedObject>();

    constructor(private readonly intel: SqlIntel) {}

    async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[] | undefined> {
        if (!config().get<boolean>('completion.enable', true)) return undefined;
        const text = document.getText();
        const offset = document.offsetAt(position);
        const template = docTemplateAt(text, offset);
        if (template) {
            const item = new vscode.CompletionItem('/** */', vscode.CompletionItemKind.Snippet);
            item.detail = 'Doc comment';
            item.documentation = 'A doc comment for the function or procedure below, with one entry per parameter.';
            item.insertText = new vscode.SnippetString(template.snippet);
            item.range = new vscode.Range(document.positionAt(template.replaceStart), document.positionAt(template.replaceEnd));
            item.filterText = '/**';
            item.sortText = '\u0000';
            return [item];
        }
        if (!this.intel.catalog.isConnected() && !this.intel.repository.snapshot()) return undefined;
        const sources = await this.intel.sources();
        return routineCompletions(text, offset, sources).map(c => {
            const item = new vscode.CompletionItem(
                { label: c.label, detail: c.labelDetail, description: c.description },
                c.object.kind === 'procedure' ? vscode.CompletionItemKind.Method : vscode.CompletionItemKind.Function
            );
            item.insertText = new vscode.SnippetString(c.insertText);
            item.range = new vscode.Range(document.positionAt(c.replaceStart), document.positionAt(c.replaceEnd));
            item.filterText = c.label;
            if (c.deprecated) item.tags = [vscode.CompletionItemTag.Deprecated];
            this.objects.set(item, c.object);
            return item;
        });
    }

    resolveCompletionItem(item: vscode.CompletionItem): vscode.CompletionItem {
        const object = this.objects.get(item);
        if (!object) return item;
        item.detail = objectSignature(object);
        const doc = docOf(object);
        if (doc) item.documentation = new vscode.MarkdownString(docMarkdown(doc, paramsOf(object)));
        return item;
    }
}

// ===== CodeLens =====

const LENS_TITLES = {
    both: '$(check) In database',
    differs: '$(diff) Differs from database',
    repoOnly: '$(circle-slash) Not in database',
    dbOnly: '$(question) Not in repository'
} as const;

export class SqlCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
    private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    constructor(private readonly intel: SqlIntel) {}

    /** The catalog or the repository changed. */
    refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }

    async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
        const settings = readRepositorySettings();
        if (!settings.compare || !config().get<boolean>('repository.codeLens', true) || !this.intel.catalog.isConnected()) return [];
        const sources = await this.intel.sources();
        if (!sources.matcher) return [];
        const lenses: vscode.CodeLens[] = [];
        for (const lens of codeLensesFor(document.getText(), document.uri.toString(), sources)) {
            if (!lens.status) continue;
            const range = toRange(lens.start, lens.start);
            const node = commandNode(lens.object);
            lenses.push(new vscode.CodeLens(range, { title: LENS_TITLES[lens.status], command: '' }));
            if (!node) continue;
            const at = { uri: document.uri.toString(), line: lens.start.line };
            if (lens.object.db && (lens.status === 'both' || lens.status === 'differs')) {
                lenses.push(new vscode.CodeLens(range, { title: 'Compare with Database', command: 'postgresQueryBuilder.compareWithDatabase', arguments: [node, at] }));
            }
            lenses.push(new vscode.CodeLens(range, { title: 'Reveal in Objects View', command: 'postgresQueryBuilder.revealInObjectView', arguments: [node] }));
            const routine = lens.object.db?.object;
            if (debugAvailability.available && routine && (routine.kind === 'function' || routine.kind === 'procedure') && routine.language === 'plpgsql') {
                lenses.push(new vscode.CodeLens(range, { title: '$(debug-alt) Debug', command: 'postgresQueryBuilder.debugFunction', arguments: [node] }));
            }
        }
        return lenses;
    }

    dispose(): void {
        this._onDidChangeCodeLenses.dispose();
    }
}

// ===== Diagnostics =====

export const DIAGNOSTIC_SOURCE = 'PostgreSQL Query Booster';

/** Diagnostics of open SQL files: unknown routines (needs a connection) and doc comment checks; both opt-in. */
export class SqlDiagnostics implements vscode.Disposable {
    private readonly collection: vscode.DiagnosticCollection;
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly intel: SqlIntel, private readonly languages: readonly string[], private readonly delayMs = 600) {
        this.collection = vscode.languages.createDiagnosticCollection('postgresQueryBuilder');
        this.disposables.push(
            this.collection,
            vscode.workspace.onDidOpenTextDocument(doc => this.schedule(doc)),
            vscode.workspace.onDidChangeTextDocument(e => this.schedule(e.document)),
            vscode.workspace.onDidCloseTextDocument(doc => this.collection.delete(doc.uri)),
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('postgresQueryBuilder.diagnostics')) this.refreshAll();
            })
        );
    }

    private enabled(): { routines: boolean; docs: boolean } {
        return {
            routines: config().get<boolean>('diagnostics.unknownRoutines', false),
            docs: config().get<boolean>('diagnostics.docComments', false)
        };
    }

    /** Check every open SQL file again (connection, catalog or repository changed). */
    refreshAll(): void {
        for (const doc of vscode.workspace.textDocuments) this.schedule(doc, 0);
    }

    private schedule(doc: vscode.TextDocument, delay = this.delayMs): void {
        if (!this.languages.includes(doc.languageId)) return;
        const key = doc.uri.toString();
        const pending = this.timers.get(key);
        if (pending) clearTimeout(pending);
        this.timers.set(key, setTimeout(() => {
            this.timers.delete(key);
            this.check(doc).catch((err: unknown) => Logger.error('SqlDiagnostics.check', err));
        }, delay));
    }

    async check(doc: vscode.TextDocument): Promise<void> {
        const { routines, docs } = this.enabled();
        const version = doc.version;
        const text = doc.getText();
        const diagnostics: vscode.Diagnostic[] = [];
        if (docs) diagnostics.push(...docFindings(text).map(f => toDiagnostic(f, vscode.DiagnosticSeverity.Information)));
        if (routines && this.intel.catalog.isConnected()) {
            const sources = await this.intel.sources({ builtins: true });
            diagnostics.push(...routineFindings(text, sources).map(f => toDiagnostic(f, vscode.DiagnosticSeverity.Warning)));
        }
        if (doc.isClosed || doc.version !== version) return;
        this.collection.set(doc.uri, diagnostics);
    }

    dispose(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        for (const d of this.disposables) d.dispose();
    }
}

export function toDiagnostic(finding: CodeFinding, severity: vscode.DiagnosticSeverity): vscode.Diagnostic {
    const diagnostic = new vscode.Diagnostic(toRange(finding.start, finding.end), finding.message, severity);
    diagnostic.source = DIAGNOSTIC_SOURCE;
    diagnostic.code = finding.code;
    return diagnostic;
}

// ===== Quick fixes =====

function workspaceEdit(uri: vscode.Uri, edit: TextEditInfo): vscode.WorkspaceEdit {
    const we = new vscode.WorkspaceEdit();
    we.replace(uri, toRange(edit.start, edit.end), edit.text);
    return we;
}

function codeOf(d: vscode.Diagnostic): string | undefined {
    const code = d.code;
    if (typeof code === 'string') return code;
    if (code && typeof code === 'object') return String(code.value);
    return undefined;
}

/** Add doc comment, Add missing parameters to the doc comment, Remove entry. */
export class SqlDocCodeActionProvider implements vscode.CodeActionProvider {
    static readonly metadata: vscode.CodeActionProviderMetadata = { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] };

    provideCodeActions(document: vscode.TextDocument, range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
        const text = document.getText();
        const actions: vscode.CodeAction[] = [];
        const add = (title: string, edit: TextEditInfo | undefined, diagnostic?: vscode.Diagnostic): void => {
            if (!edit) return;
            const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
            action.edit = workspaceEdit(document.uri, edit);
            if (diagnostic) action.diagnostics = [diagnostic];
            actions.push(action);
        };
        for (const diagnostic of context.diagnostics) {
            if (diagnostic.source !== DIAGNOSTIC_SOURCE) continue;
            const code = codeOf(diagnostic);
            const def = definitionForFinding(text, { line: diagnostic.range.start.line, character: diagnostic.range.start.character });
            if (!def) continue;
            if (code === 'missingDoc') add('Add doc comment', addDocCommentEdit(text, def), diagnostic);
            if (code === 'undocumentedParam') add('Add missing parameters to the doc comment', addMissingParamsEdit(def), diagnostic);
            if (code === 'unknownParam') {
                const name = document.getText(diagnostic.range);
                add(`Remove entry for ${name}`, removeEntryEdit(def, name), diagnostic);
            }
        }
        // Also without the checks turned on: on the name of a CREATE FUNCTION or PROCEDURE without a doc comment.
        if (actions.length === 0) {
            const def = definitionForFinding(text, { line: range.start.line, character: range.start.character });
            const onName = def && range.start.line >= def.start.line && range.start.line <= def.end.line;
            if (def && onName && !def.doc && (def.kind === 'function' || def.kind === 'procedure')) add('Add doc comment', addDocCommentEdit(text, def));
        }
        return actions;
    }
}

/** Register every provider for the SQL languages. */
export function registerSqlLanguageFeatures(intel: SqlIntel, languages: readonly string[], columns: ColumnSource): vscode.Disposable[] {
    const codeLens = new SqlCodeLensProvider(intel);
    const diagnostics = new SqlDiagnostics(intel, languages);
    const disposables: vscode.Disposable[] = [
        codeLens,
        diagnostics,
        vscode.languages.registerWorkspaceSymbolProvider(new SqlWorkspaceSymbolProvider(intel.repository)),
        intel.catalog.onDidReset(() => {
            codeLens.refresh();
            diagnostics.refreshAll();
        }),
        intel.catalog.bodies.onDidChange(() => codeLens.refresh()),
        debugAvailability.onDidChange(() => codeLens.refresh()),
        intel.repository.onDidChange(() => {
            codeLens.refresh();
            diagnostics.refreshAll();
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('postgresQueryBuilder.repository')) codeLens.refresh();
        })
    ];
    const definition = new SqlDefinitionProvider(intel);
    const references = new SqlReferenceProvider(intel);
    const symbols = new SqlDocumentSymbolProvider();
    const hover = new SqlHoverProvider(intel, columns);
    const signature = new SqlSignatureHelpProvider(intel);
    const completion = new SqlRoutineCompletionProvider(intel);
    const actions = new SqlDocCodeActionProvider();
    for (const language of languages) {
        disposables.push(
            vscode.languages.registerDefinitionProvider(language, definition),
            vscode.languages.registerReferenceProvider(language, references),
            vscode.languages.registerDocumentSymbolProvider(language, symbols),
            vscode.languages.registerHoverProvider(language, hover),
            vscode.languages.registerSignatureHelpProvider(language, signature, '(', ','),
            vscode.languages.registerCompletionItemProvider(language, completion, '.', '*'),
            vscode.languages.registerCodeLensProvider(language, codeLens),
            vscode.languages.registerCodeActionsProvider(language, actions, SqlDocCodeActionProvider.metadata)
        );
    }
    diagnostics.refreshAll();
    return disposables;
}
