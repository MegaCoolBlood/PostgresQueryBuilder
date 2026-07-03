"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const node_1 = require("vscode-languageserver/node");
const vscode_languageserver_textdocument_1 = require("vscode-languageserver-textdocument");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const plpgsqlFormatter_1 = require("../src/plpgsqlFormatter");
// Create a connection for the server, using Node's IPC as a transport.
const connection = (0, node_1.createConnection)(node_1.ProposedFeatures.all);
// Create a simple text document manager.
const documents = new node_1.TextDocuments(vscode_languageserver_textdocument_1.TextDocument);
let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let workspaceFolder = null;
let globalSettings = {};
const documentSettings = new Map();
connection.onInitialize((params) => {
    const capabilities = params.capabilities;
    // Does the client support the `workspace/configuration` request?
    // If not, we fall back using global settings.
    hasConfigurationCapability = !!(capabilities.workspace && !!capabilities.workspace.configuration);
    hasWorkspaceFolderCapability = !!(capabilities.workspace && !!capabilities.workspace.workspaceFolders);
    // Extract workspace folder from initialization params
    if (params.workspaceFolders && params.workspaceFolders.length > 0) {
        const folderUri = params.workspaceFolders[0].uri;
        // Convert file:// URI to filesystem path
        workspaceFolder = decodeURIComponent(folderUri.replace(/^file:\/\//, '').replace(/^\d:/, (m) => m[0] + ':'));
    }
    const result = {
        capabilities: {
            textDocumentSync: node_1.TextDocumentSyncKind.Full,
            documentFormattingProvider: true,
            documentRangeFormattingProvider: true,
            workspace: {
                workspaceFolders: {
                    supported: true,
                    changeNotifications: true,
                },
            },
        },
    };
    if (hasWorkspaceFolderCapability) {
        result.capabilities.workspace = {
            workspaceFolders: {
                supported: true,
                changeNotifications: true,
            },
        };
    }
    return result;
});
connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        // Register for all configuration changes.
        connection.client.register(node_1.DidChangeConfigurationNotification.type, undefined);
    }
    // Load initial workspace configuration
    loadWorkspaceConfig();
});
// Handle configuration changes
connection.onDidChangeConfiguration((change) => {
    // Clear document settings so they get re-read
    documentSettings.clear();
    loadWorkspaceConfig();
});
function loadWorkspaceConfig() {
    if (hasConfigurationCapability) {
        connection.workspace.getConfiguration('postgresQueryBuilder.format').then((config) => {
            globalSettings = (0, plpgsqlFormatter_1.coerceFormatOptions)(config || {});
        });
    }
    // Try to load .pgformat.json from workspace root
    if (workspaceFolder) {
        const configPath = path.join(workspaceFolder, '.pgformat.json');
        try {
            if (fs.existsSync(configPath)) {
                const content = fs.readFileSync(configPath, 'utf-8');
                const repoConfig = JSON.parse(content);
                // Merge repo config on top of global settings
                globalSettings = (0, plpgsqlFormatter_1.coerceFormatOptions)({ ...globalSettings, ...repoConfig });
            }
        }
        catch (e) {
            connection.console.error(`Error reading .pgformat.json: ${e}`);
        }
    }
}
async function getDocumentSettings(resource) {
    if (!hasConfigurationCapability) {
        return globalSettings;
    }
    let result = documentSettings.get(resource);
    if (!result) {
        result = (0, plpgsqlFormatter_1.coerceFormatOptions)((await connection.workspace.getConfiguration('postgresQueryBuilder.format', resource)) || {});
        // Overlay repo config if available
        if (workspaceFolder) {
            const configPath = path.join(workspaceFolder, '.pgformat.json');
            try {
                if (fs.existsSync(configPath)) {
                    const content = fs.readFileSync(configPath, 'utf-8');
                    const repoConfig = JSON.parse(content);
                    result = (0, plpgsqlFormatter_1.coerceFormatOptions)({ ...result, ...repoConfig });
                }
            }
            catch (e) {
                connection.console.error(`Error reading .pgformat.json: ${e}`);
            }
        }
        documentSettings.set(resource, result);
    }
    return result;
}
// Handle document formatting
connection.onDocumentFormatting(async (params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return [];
    }
    const settings = await getDocumentSettings(params.textDocument.uri);
    const text = document.getText();
    try {
        const result = (0, plpgsqlFormatter_1.formatSqlChecked)(text, settings);
        if (!result.ok) {
            connection.sendNotification('window/showMessage', {
                type: 2, // Warning
                message: `Formatting skipped to protect your code: ${result.reason}`,
            });
            return [];
        }
        if (result.text === text) {
            return [];
        }
        return [
            node_1.TextEdit.replace({
                start: document.positionAt(0),
                end: document.positionAt(text.length),
            }, result.text),
        ];
    }
    catch (e) {
        connection.sendNotification('window/showMessage', {
            type: 1, // Error
            message: `Formatting error: ${e instanceof Error ? e.message : String(e)}`,
        });
        return [];
    }
});
// Handle range formatting
connection.onDocumentRangeFormatting(async (params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return [];
    }
    const settings = await getDocumentSettings(params.textDocument.uri);
    const text = document.getText(params.range);
    try {
        const result = (0, plpgsqlFormatter_1.formatSqlChecked)(text, settings);
        if (!result.ok) {
            connection.sendNotification('window/showMessage', {
                type: 2, // Warning
                message: `Formatting skipped to protect your code: ${result.reason}`,
            });
            return [];
        }
        if (result.text === text) {
            return [];
        }
        return [
            node_1.TextEdit.replace(params.range, result.text)
        ];
    }
    catch (e) {
        connection.sendNotification('window/showMessage', {
            type: 1, // Error
            message: `Formatting error: ${e instanceof Error ? e.message : String(e)}`,
        });
        return [];
    }
});
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);
// Listen on the connection
connection.listen();
//# sourceMappingURL=language-server.js.map