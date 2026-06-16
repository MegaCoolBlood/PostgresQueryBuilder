import test from 'node:test';
import assert from 'node:assert/strict';
import { getNonce, buildCsp } from '../webviewUtils';

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
