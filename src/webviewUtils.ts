import { randomBytes } from 'crypto';
import type * as vscode from 'vscode';
import { getIconSprite, getSharedStyles } from './webviewAssets';

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

/**
 * JavaScript source (as a string) defining an `escapeHtml(value)` helper for
 * use inside a webview `<script>`. Escapes the five HTML-significant characters
 * (`&`, `<`, `>`, `"`, `'`) and treats `null`/`undefined` as an empty string.
 *
 * Include this in the `script` passed to {@link buildHtmlDocument} so each
 * webview does not redefine its own copy.
 */
export const WEBVIEW_ESCAPE_HTML_JS = `function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}`;

export interface WebviewHtmlOptions {
    /**
     * Webview used to derive the CSP source. When provided a
     * Content-Security-Policy `<meta>` tag is emitted and the `<script>` carries
     * the nonce.
     */
    webview?: vscode.Webview;
    /** Nonce for the CSP/script. Generated automatically when omitted. */
    nonce?: string;
    /** Raw CSS placed inside a `<style>` element (without the `<style>` tags). */
    styles?: string;
    /** Body markup placed inside `<body>` (without the `<body>` tags). */
    body: string;
    /**
     * Raw JS placed inside a `<script>` element (without the `<script>` tags).
     * The element automatically carries the nonce.
     */
    script?: string;
    /** Document `<title>`. */
    title?: string;
    /** `<html lang>` attribute. Defaults to `en`. */
    lang?: string;
    /**
     * Prepend the shared design tokens/base styles and inline the icon sprite.
     * Defaults to `true`; only turn it off for a document that must stand on
     * its own markup.
     */
    includeSharedAssets?: boolean;
}

/**
 * Build a complete webview HTML document with the standard `<!DOCTYPE html>`,
 * `<head>` (charset, optional CSP, viewport, optional title and styles) and
 * `<body>` (markup plus an optional nonce-bearing `<script>`).
 *
 * Centralizing this removes the boilerplate each webview otherwise repeats and
 * guarantees a CSP/nonce is applied whenever a `webview` is supplied.
 */
export function buildHtmlDocument(options: WebviewHtmlOptions): string {
    const nonce = options.nonce ?? getNonce();
    const lang = options.lang ?? 'en';
    const shared = options.includeSharedAssets !== false;
    const cspMeta = options.webview
        ? `\n<meta http-equiv="Content-Security-Policy" content="${buildCsp(options.webview, nonce)}">`
        : '';
    const titleTag = options.title ? `\n<title>${options.title}</title>` : '';
    const css = [shared ? getSharedStyles() : '', options.styles ?? ''].filter(Boolean).join('\n');
    const styleTag = css ? `\n<style>\n${css}\n</style>` : '';
    const sprite = shared ? `${getIconSprite()}\n` : '';
    const scriptTag = options.script ? `\n<script nonce="${nonce}">\n${options.script}\n</script>` : '';
    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">${cspMeta}
<meta name="viewport" content="width=device-width, initial-scale=1.0">${titleTag}${styleTag}
</head>
<body>
${sprite}${options.body}${scriptTag}
</body>
</html>`;
}
