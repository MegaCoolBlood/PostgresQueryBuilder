import { randomBytes } from 'crypto';
import type * as vscode from 'vscode';

/**
 * Generate a cryptographically strong nonce for use with a webview
 * Content-Security-Policy `script-src 'nonce-...'` directive.
 *
 * Uses `crypto.randomBytes` rather than `Math.random()` so the value is not
 * predictable.
 */
export function getNonce(): string {
    return randomBytes(16).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
}

/**
 * Build the Content-Security-Policy string for a webview that allows only:
 * nothing by default, inline styles from the webview origin, and scripts
 * carrying the given nonce.
 */
export function buildCsp(webview: vscode.Webview, nonce: string): string {
    return `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
}
