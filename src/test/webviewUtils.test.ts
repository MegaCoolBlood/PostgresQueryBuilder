import test from 'node:test';
import assert from 'node:assert/strict';
import { getNonce, buildCsp, buildHtmlDocument, WEBVIEW_ESCAPE_HTML_JS } from '../webviewUtils';

test('getNonce returns an alphanumeric string', () => {
    const nonce = getNonce();
    assert.match(nonce, /^[a-zA-Z0-9]+$/);
    assert.ok(nonce.length >= 16);
});

test('getNonce returns a different value each call', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
        seen.add(getNonce());
    }
    assert.equal(seen.size, 100);
});

test('buildCsp embeds the nonce and cspSource', () => {
    const fakeWebview = { cspSource: 'vscode-resource://abc' } as any;
    const csp = buildCsp(fakeWebview, 'NONCE123');
    assert.ok(csp.includes("default-src 'none'"));
    assert.ok(csp.includes("style-src vscode-resource://abc 'unsafe-inline'"));
    assert.ok(csp.includes("script-src 'nonce-NONCE123'"));
});

test('buildHtmlDocument wraps body and embeds styles and script', () => {
    const html = buildHtmlDocument({
        body: '<h1>Hello</h1>',
        styles: 'body { color: red; }',
        script: 'console.log(1);',
    });
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('<style>'));
    assert.ok(html.includes('body { color: red; }'));
    assert.ok(html.includes('<h1>Hello</h1>'));
    assert.ok(html.includes('console.log(1);'));
});

test('buildHtmlDocument emits CSP meta and nonce when a webview is provided', () => {
    const fakeWebview = { cspSource: 'vscode-resource://abc' } as any;
    const html = buildHtmlDocument({
        webview: fakeWebview,
        nonce: 'NONCE123',
        body: '<div></div>',
        script: 'noop();',
    });
    assert.ok(html.includes('http-equiv="Content-Security-Policy"'));
    assert.ok(html.includes("script-src 'nonce-NONCE123'"));
    assert.ok(html.includes('<script nonce="NONCE123">'));
});

test('buildHtmlDocument generates a nonce for the script when none is given', () => {
    const fakeWebview = { cspSource: 'vscode-resource://abc' } as any;
    const html = buildHtmlDocument({ webview: fakeWebview, body: '', script: 'x();' });
    const match = html.match(/<script nonce="([a-zA-Z0-9]+)">/);
    assert.ok(match, 'expected a nonce-bearing script tag');
    assert.ok(match![1].length >= 16);
});

test('buildHtmlDocument omits the script tag when no script is provided', () => {
    const html = buildHtmlDocument({ body: '<p>x</p>' });
    assert.ok(!html.includes('<script'));
});

test('buildHtmlDocument applies custom title and lang', () => {
    const html = buildHtmlDocument({ body: '', title: 'My Title', lang: 'de' });
    assert.ok(html.includes('<html lang="de">'));
    assert.ok(html.includes('<title>My Title</title>'));
});

test('WEBVIEW_ESCAPE_HTML_JS escapes the five HTML-sensitive characters at runtime', () => {
    const factory = new Function(`${WEBVIEW_ESCAPE_HTML_JS}; return escapeHtml;`);
    const escapeHtml = factory();
    assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
});
