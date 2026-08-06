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

const vscodeStub = {
    EventEmitter,
    ThemeIcon,
    TreeItem,
    DataTransferItem,
    DocumentDropEdit,
    TreeItemCollapsibleState,
    workspace: {
        workspaceFolders: undefined as any,
        textDocuments: [] as any[],
        onDidChangeConfiguration: (_listener: any) => ({ dispose() {} }),
        onDidChangeWorkspaceFolders: (_listener: any) => ({ dispose() {} }),
        onDidSaveTextDocument: (_listener: any) => ({ dispose() {} }),
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
        createWebviewPanel: (..._args: any[]): any => undefined
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

// Install on import so that `import './helpers/vscodeMock';` as the first import
// of a test file patches the loader before any vscode-dependent module loads.
installVscodeMock();
