import * as fs from 'fs';
import * as path from 'path';
import { Logger, getErrorMessage } from './logger';
import { DEFAULT_ARGUMENT_GROUPS, FormatOptions } from './plpgsqlFormatter';

/** File name that is searched for in the workspace root. */
export const REPO_FORMAT_CONFIG_FILENAME = '.pgformat.json';

/**
 * Read formatter settings from an explicit config file path.
 *
 * Returns an empty object when the file does not exist.
 * Logs a warning (via {@link Logger}) and returns an empty object when the
 * file cannot be parsed.
 */
export function readFormatConfigFile(filePath: string): Record<string, unknown> {
    let raw: string;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            Logger.log('repoFormatConfig', `Could not read ${path.basename(filePath)}: ${getErrorMessage(err)}`);
        }
        return {};
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        Logger.log('repoFormatConfig', `${path.basename(filePath)} contains invalid JSON: ${getErrorMessage(err)}`);
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        Logger.log('repoFormatConfig', `${path.basename(filePath)} must be a JSON object — ignored.`);
        return {};
    }
    return parsed as Record<string, unknown>;
}

/**
 * Read formatter settings from a `.pgformat.json` file in `folderPath`.
 *
 * The file must contain a JSON object whose keys mirror the VS Code setting
 * names without the `postgresQueryBuilder.format.` prefix, e.g.:
 *
 * ```json
 * {
 *   "keywordCase": "lower",
 *   "indentSize": 4,
 *   "listThresholds": { "selectColumns": "3, 5" }
 * }
 * ```
 *
 * Returns an empty object when the file does not exist.
 * Logs a warning (via {@link Logger}) and returns an empty object when the
 * file cannot be parsed.
 */
export function readRepoFormatConfig(folderPath: string): Record<string, unknown> {
    return readFormatConfigFile(path.join(folderPath, REPO_FORMAT_CONFIG_FILENAME));
}

/**
 * Resolve the file path the formatter should read its settings from.
 *
 * - When `configPath` is a non-empty string: an absolute path is used verbatim;
 *   a relative path is resolved against `workspaceFolderPath` (or the process
 *   working directory when no folder is given).
 * - Otherwise it falls back to `.pgformat.json` in `workspaceFolderPath`.
 *
 * Returns `undefined` when there is neither a `configPath` nor a
 * `workspaceFolderPath` to anchor a file name to.
 */
export function resolveFormatConfigPath(workspaceFolderPath?: string, configPath?: string): string | undefined {
    const trimmed = typeof configPath === 'string' ? configPath.trim() : '';
    if (trimmed) {
        return path.isAbsolute(trimmed) ? trimmed : path.join(workspaceFolderPath ?? process.cwd(), trimmed);
    }
    return workspaceFolderPath ? path.join(workspaceFolderPath, REPO_FORMAT_CONFIG_FILENAME) : undefined;
}

/**
 * Serialize a {@link FormatOptions} object into the `.pgformat.json` record
 * format — the inverse of passing the result through {@link readRepoFormatConfig}
 * + `coerceFormatOptions`.
 *
 * `thresholds` are written as `"inlineMax, multilineMin"` strings (matching the
 * VS Code settings table format) under the `listThresholds` key.
 */
export function formatOptionsToRepoConfig(opts: FormatOptions): Record<string, unknown> {
    const listThresholds: Record<string, string> = {};
    for (const [key, threshold] of Object.entries(opts.thresholds)) {
        listThresholds[key] = `${threshold.inlineMax}, ${threshold.multilineMin}`;
    }
    const argumentGroups: Record<string, string> = { ...opts.argumentGroups };
    for (const fn of Object.keys(DEFAULT_ARGUMENT_GROUPS)) {
        // A built-in the user switched off has to be written as "0", or reading
        // the file back would restore it from the defaults.
        if (!(fn in argumentGroups)) { argumentGroups[fn] = '0'; }
    }
    return {
        keywordCase: opts.keywordCase,
        identifierCase: opts.identifierCase,
        dataTypeCase: opts.dataTypeCase,
        indentStyle: opts.indentStyle,
        indentSize: opts.indentSize,
        commaStyle: opts.commaStyle,
        blankLines: opts.blankLines,
        simpleSelectSingleLine: opts.simpleSelectSingleLine,
        preserveSingleLineRoutineHeaders: opts.preserveSingleLineRoutineHeaders,
        preserveSingleLineIfBlocks: opts.preserveSingleLineIfBlocks,
        normalizeDataTypes: opts.normalizeDataTypes,
        dataTypeAliases: { ...opts.dataTypeAliases },
        argumentGroups,
        listThresholds
    };
}
