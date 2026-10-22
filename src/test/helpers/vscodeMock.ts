/**
 * Minimal `vscode` module stub for unit tests.
 *
 * Several production modules (e.g. modifyHistoryStore, tableExplorer) do
 * `import * as vscode from 'vscode'` purely to use lightweight helpers such as
 * `EventEmitter` or `TreeItem`. The `vscode` module is only available inside the
 * real extension host, so plain `node --test` runs cannot resolve it. This stub
 * installs a fake `vscode` into the CommonJS module cache so those modules load.
 */
import Module from 'node:module';

class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    readonly event = (listener: (e: T) => void): { dispose(): void } => {
        this.listeners.push(listener);
        return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
    };
    fire(data: T): void {
        for (const l of [...this.listeners]) {
            l(data);
        }
    }
    dispose(): void {
        this.listeners = [];
    }
}

const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };

class ThemeIcon {
    constructor(public id: string) {}
}

class TreeItem {
    label: any;
    collapsibleState: number;
    iconPath: any;
    contextValue?: string;
    command?: any;
    tooltip?: any;
    constructor(label: any, collapsibleState: number = 0) {
        this.label = label;
        this.collapsibleState = collapsibleState;
    }
}

class DataTransferItem {
    constructor(public value: any) {}
    asString(): Promise<string> {
        return Promise.resolve(String(this.value));
    }
}

class DocumentDropEdit {
    constructor(public insertText: any) {}
}

const CompletionItemKind = { Text: 0, Function: 2, Field: 4, Variable: 5, Class: 6, Interface: 7, Module: 8, Keyword: 13 };

class CompletionItem {
    insertText?: any;
    detail?: string;
    sortText?: string;
    range?: any;
    constructor(public label: string, public kind?: number) {}
}

class SnippetString {
    constructor(public value: string) {}
}

class Position {
    constructor(public line: number, public character: number) {}
}

class Range {
    constructor(public start: Position, public end: Position) {}
}

class Selection extends Range {
    constructor(public anchor: Position, public active: Position) {
        super(anchor, active);
    }
}

const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
const TextEditorRevealType = { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 };

/** Listeners registered for the document events the stub can replay. */
const documentListeners = {
    save: [] as Array<(doc: any) => void>,
    close: [] as Array<(doc: any) => void>,
    tabs: [] as Array<(event: any) => void>
};

function registerDocumentListener(bucket: Array<(doc: any) => void>, listener: (doc: any) => void) {
    bucket.push(listener);
    return {
        dispose() {
            const i = bucket.indexOf(listener);
            if (i >= 0) {
                bucket.splice(i, 1);
            }
        }
    };
}

/** Let a test replay a document save/close to everything that subscribed. */
export function fireDidSaveTextDocument(doc: any): void {
    for (const l of [...documentListeners.save]) {
        l(doc);
    }
}

export function fireDidCloseTextDocument(doc: any): void {
    for (const l of [...documentListeners.close]) {
        l(doc);
    }
}

/** Let a test replay a change of the editor tabs; set `window.tabGroups.all` first. */
export function fireDidChangeTabs(event: any = { opened: [], closed: [], changed: [] }): void {
    for (const l of [...documentListeners.tabs]) {
        l(event);
    }
}

const vscodeStub = {
    EventEmitter,
    ThemeIcon,
    TreeItem,
    DataTransferItem,
    DocumentDropEdit,
    CompletionItemKind,
    CompletionItem,
    SnippetString,
    Position,
    Range,
    Selection,
    ProgressLocation,
    TextEditorRevealType,
    TreeItemCollapsibleState,
    workspace: {
        workspaceFolders: undefined as any,
        textDocuments: [] as any[],
        onDidChangeConfiguration: (_listener: any) => ({ dispose() {} }),
        onDidChangeWorkspaceFolders: (_listener: any) => ({ dispose() {} }),
        onDidSaveTextDocument: (listener: any) => registerDocumentListener(documentListeners.save, listener),
        onDidCloseTextDocument: (listener: any) => registerDocumentListener(documentListeners.close, listener),
        openTextDocument: (uri: any): Promise<any> => Promise.resolve({ uri, getText: () => '' }),
        getConfiguration: (_section?: string) => ({
            get<T>(_key: string, defaultValue?: T): T {
                return defaultValue as T;
            }
        }),
        createFileSystemWatcher: (_glob: any) => ({
            onDidCreate: (_l: any) => ({ dispose() {} }),
            onDidChange: (_l: any) => ({ dispose() {} }),
            onDidDelete: (_l: any) => ({ dispose() {} }),
            dispose() {}
        }),
        fs: {
            async writeFile() {},
            async readFile() { return Buffer.from(''); },
            async createDirectory() {}
        }
    },
    window: {
        showWarningMessage: (..._args: any[]) => Promise.resolve(undefined),
        showInformationMessage: (..._args: any[]) => Promise.resolve(undefined),
        showErrorMessage: (..._args: any[]) => Promise.resolve(undefined),
        showTextDocument: (..._args: any[]): Promise<any> => Promise.resolve(undefined),
        setStatusBarMessage: (..._args: any[]) => ({ dispose() {} }),
        showOpenDialog: (_options?: any): Promise<any> => Promise.resolve(undefined),
        showSaveDialog: (_options?: any): Promise<any> => Promise.resolve(undefined),
        showInputBox: (_options?: any): Promise<any> => Promise.resolve(undefined),
        showQuickPick: (_items?: any, _options?: any): Promise<any> => Promise.resolve(undefined),
        createWebviewPanel: (..._args: any[]): any => undefined,
        createTerminal: (_options?: any): any => ({ show() {}, dispose() {} }),
        createQuickPick: (): any => undefined,
        withProgress: (_options: any, task: (progress: any, token: any) => any): Promise<any> => Promise.resolve(task(
            { report() {} },
            { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }
        )),
        tabGroups: {
            all: [] as any[],
            onDidChangeTabs: (listener: any) => registerDocumentListener(documentListeners.tabs, listener)
        }
    },
    // The namespace object must exist before a module under test copies it via
    // `import * as vscode`; tests replace the member, never the namespace.
    commands: {
        executeCommand: (..._args: any[]): Promise<any> => Promise.resolve(undefined)
    },
    ViewColumn: { One: 1, Two: 2, Three: 3, Beside: -2, Active: -1 },
    Uri: {
        file: (p: string) => ({ fsPath: p, path: p }),
        joinPath: (base: any, ...segs: string[]) => ({
            fsPath: [base?.fsPath ?? base?.path ?? '', ...segs].join('/'),
            path: [base?.path ?? '', ...segs].join('/')
        })
    },
    RelativePattern: class { constructor(public base: any, public pattern: string) {} }
};

let installed = false;

/** Install the `vscode` stub into the module loader. Idempotent. */
export function installVscodeMock(): void {
    if (installed) {
        return;
    }
    installed = true;
    const originalLoad = (Module as any)._load;
    (Module as any)._load = function (request: string, ...args: any[]) {
        if (request === 'vscode') {
            return vscodeStub;
        }
        return originalLoad.call(this, request, ...args);
    };
}

export { vscodeStub };

/**
 * Answer `window.showWarningMessage` for the rest of one test: `answer` gets the
 * offered items (everything after the message and options) and returns the
 * one the "user" picks, or `undefined` for Cancel. Returns every call made.
 */
export function stubWarningMessage(
    t: { after(fn: () => void): void },
    answer: (items: string[]) => string | undefined
): unknown[][] {
    const calls: unknown[][] = [];
    const original = vscodeStub.window.showWarningMessage;
    vscodeStub.window.showWarningMessage = ((...args: unknown[]) => {
        calls.push(args);
        const items = args.slice(1).filter((a): a is string => typeof a === 'string');
        return Promise.resolve(answer(items));
    }) as typeof original;
    t.after(() => { vscodeStub.window.showWarningMessage = original; });
    return calls;
}

// Install on import so that `import './helpers/vscodeMock';` as the first import
// of a test file patches the loader before any vscode-dependent module loads.
installVscodeMock();
