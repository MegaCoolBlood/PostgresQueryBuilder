import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	TextDocumentSyncKind,
	InitializeResult,
	DocumentFormattingParams,
	TextEdit,
	DocumentRangeFormattingParams,
	DidChangeConfigurationParams,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'fs';
import * as path from 'path';
import { formatSqlChecked, FormatOptions, coerceFormatOptions } from '../src/plpgsqlFormatter';
import { readRepoFormatConfig } from '../src/repoFormatConfig';

// Create a connection for the server, using Node's IPC as a transport.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let workspaceFolder: string | null = null;
let globalSettings: Partial<FormatOptions> = {};
const documentSettings: Map<string, FormatOptions> = new Map();

connection.onInitialize((params: InitializeParams) => {
	const capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);

	// Extract workspace folder from initialization params
	if (params.workspaceFolders && params.workspaceFolders.length > 0) {
		const folderUri = params.workspaceFolders[0].uri;
		// Convert file:// URI to filesystem path
		workspaceFolder = decodeURIComponent(
			folderUri.replace(/^file:\/\//, '').replace(/^\d:/, (m) => m[0] + ':')
		);
	}

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Full,
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
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}

	// Load initial workspace configuration
	loadWorkspaceConfig();
});

// Handle configuration changes
connection.onDidChangeConfiguration((change: DidChangeConfigurationParams) => {
	// Clear document settings so they get re-read
	documentSettings.clear();
	loadWorkspaceConfig();
});

function loadWorkspaceConfig(): void {
	if (hasConfigurationCapability) {
		connection.workspace.getConfiguration('postgresQueryBuilder.format').then((config: unknown) => {
			globalSettings = coerceFormatOptions(config as Record<string, unknown> || {});
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
				globalSettings = coerceFormatOptions({ ...globalSettings, ...repoConfig });
			}
		} catch (e) {
			connection.console.error(`Error reading .pgformat.json: ${e}`);
		}
	}
}

async function getDocumentSettings(resource: string): Promise<FormatOptions> {
	if (!hasConfigurationCapability) {
		return coerceFormatOptions(globalSettings);
	}

	let result = documentSettings.get(resource);
	if (!result) {
		const config = (await connection.workspace.getConfiguration('postgresQueryBuilder.format')) as unknown;
		result = coerceFormatOptions(config as Record<string, unknown> || {});

		// Overlay repo config if available
		if (workspaceFolder) {
			const configPath = path.join(workspaceFolder, '.pgformat.json');
			try {
				if (fs.existsSync(configPath)) {
					const content = fs.readFileSync(configPath, 'utf-8');
					const repoConfig = JSON.parse(content);
					result = coerceFormatOptions({ ...result, ...repoConfig });
				}
			} catch (e) {
				connection.console.error(`Error reading .pgformat.json: ${e}`);
			}
		}

		documentSettings.set(resource, result);
	}

	return result;
}

// Handle document formatting
connection.onDocumentFormatting(
	async (params: DocumentFormattingParams): Promise<TextEdit[]> => {
		const document = documents.get(params.textDocument.uri);
		if (!document) {
			return [];
		}

		const settings = await getDocumentSettings(params.textDocument.uri);
		const text = document.getText();

		try {
			const result = formatSqlChecked(text, settings);

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
				TextEdit.replace(
					{
						start: document.positionAt(0),
						end: document.positionAt(text.length),
					},
					result.text
				),
			];
		} catch (e) {
			connection.sendNotification('window/showMessage', {
				type: 1, // Error
				message: `Formatting error: ${e instanceof Error ? e.message : String(e)}`,
			});
			return [];
		}
	}
);

// Handle range formatting
connection.onDocumentRangeFormatting(
	async (params: DocumentRangeFormattingParams): Promise<TextEdit[]> => {
		const document = documents.get(params.textDocument.uri);
		if (!document) {
			return [];
		}

		const settings = await getDocumentSettings(params.textDocument.uri);
		const text = document.getText(params.range);

		try {
			const result = formatSqlChecked(text, settings);

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
				TextEdit.replace(params.range, result.text)
			];
		} catch (e) {
			connection.sendNotification('window/showMessage', {
				type: 1, // Error
				message: `Formatting error: ${e instanceof Error ? e.message : String(e)}`,
			});
			return [];
		}
	}
);

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
