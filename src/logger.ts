import * as vscode from 'vscode';

/**
 * Thin wrapper around a single VS Code OutputChannel so that any module
 * (including ones that are unit-tested without the `vscode` runtime) can write
 * diagnostic messages to one shared "PostgreSQL Query Builder" output channel.
 *
 * The channel is injected once during extension activation via {@link Logger.init}.
 * Before initialization (e.g. in unit tests) all logging calls are safe no-ops.
 */
export class Logger {
    private static channel: vscode.OutputChannel | undefined;

    /** Wire the shared output channel. Called once from `activate`. */
    static init(channel: vscode.OutputChannel): void {
        Logger.channel = channel;
    }

    /** Append a single timestamped, optionally scoped line to the output channel. */
    static log(scope: string, message: string): void {
        if (!Logger.channel) {
            return;
        }
        const timestamp = new Date().toISOString();
        Logger.channel.appendLine(`[${timestamp}] [${scope}] ${message}`);
    }

    /** Log an error with its stack trace (or message) under the given scope. */
    static error(scope: string, err: unknown): void {
        const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
        Logger.log(scope, `ERROR: ${detail}`);
    }
}
