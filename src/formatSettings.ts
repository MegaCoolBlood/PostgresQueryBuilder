import * as vscode from 'vscode';
import { FormatOptions } from './plpgsqlFormatter';
import { resolveFormatOptions } from './formatConfig';

/**
 * The formatter settings in effect: VS Code settings, overridden by a
 * repository-level `.pgformat.json` of the first workspace folder.
 */
export function getFormatOptions(): FormatOptions {
    const cfg = vscode.workspace.getConfiguration('postgresQueryBuilder');
    const folders = vscode.workspace.workspaceFolders;
    return resolveFormatOptions(
        (configKey) => cfg.get(configKey),
        folders && folders.length > 0 ? folders[0].uri.fsPath : undefined,
        cfg.get<string>('format.configPath')
    );
}

/** Whether the formatter is enabled (master toggle). */
export function isFormatterEnabled(): boolean {
    return vscode.workspace.getConfiguration('postgresQueryBuilder').get<boolean>('format.enable', true);
}
