/**
 * What AI assistants may do with a saved connection through the MCP server.
 * Every capability is granted per connection in the connection form and is
 * off until the user ticks it; asking before a write is on until the user
 * unticks it. Custom column mappings and bookmarked queries belong to no
 * connection — they are shared by all of them — so they need no capability.
 * Kept free of the `vscode` API so it is tested directly.
 */
import type { AiAccess, ConnectionConfig } from './connectionManager';

export type AiCapability = 'metadata' | 'readData' | 'writeData' | 'ddl';

/** Every capability, in the order the connection form lists them. */
export const AI_CAPABILITIES: readonly AiCapability[] = ['metadata', 'readData', 'writeData', 'ddl'];

/** The checkbox labels of the connection form; refusals name the same words. */
export const AI_CAPABILITY_LABELS: Record<AiCapability, string> = {
    metadata: 'Read the database structure',
    readData: 'Read data',
    writeData: 'Change data',
    ddl: 'Change the database structure'
};

/** What each capability covers, shown next to its checkbox. */
export const AI_CAPABILITY_HINTS: Record<AiCapability, string> = {
    metadata: 'schemas, tables, CREATE scripts, dependencies, EXPLAIN, plpgsql_check, comparison with the repository',
    readData: 'SELECT queries in a read-only transaction, EXPLAIN ANALYZE, the Data Viewer, running bookmarked queries',
    writeData: 'INSERT, UPDATE, DELETE, MERGE and function calls',
    ddl: 'CREATE, ALTER, DROP, TRUNCATE, GRANT and REVOKE'
};

export const AI_ACCESS_HEADING = 'AI access (Copilot / MCP)';
export const CONFIRM_WRITES_LABEL = 'Ask before AI writes';

/** The command a user edits a connection with: its quick pick offers "Edit Connection". */
export const EDIT_CONNECTION_COMMAND_TITLE = 'PostgreSQL Query Booster: Select Connection';

type AiConfig = Pick<ConnectionConfig, 'ai'>;

/** The capabilities granted to AI assistants for a connection; none by default. */
export function aiCapabilities(config: AiConfig | null | undefined): AiCapability[] {
    const access: AiAccess | undefined = config?.ai;
    if (!access || typeof access !== 'object') return [];
    return AI_CAPABILITIES.filter((capability) => access[capability] === true);
}

/** True when the connection grants `capability` to AI assistants. */
export function isAllowed(config: AiConfig | null | undefined, capability: AiCapability): boolean {
    return config?.ai?.[capability] === true;
}

/** True unless the user turned off "Ask before AI writes" for the connection. */
export function confirmsWrites(config: AiConfig | null | undefined): boolean {
    return config?.ai?.confirmWrites !== false;
}

/** Why a tool was refused, and how the user grants the capability. */
export function refusalMessage(connectionName: string, capability: AiCapability): string {
    const label = AI_CAPABILITY_LABELS[capability];
    return `The connection "${connectionName}" does not allow AI assistants to ${label.charAt(0).toLowerCase()}${label.slice(1)} (${capability}). `
        + `Nothing is allowed until the user enables it: run "${EDIT_CONNECTION_COMMAND_TITLE}", choose "Edit Connection", pick "${connectionName}" `
        + `and tick "${label}" under "${AI_ACCESS_HEADING}".`;
}
