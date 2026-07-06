import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { POSTGRES_RESERVED_KEYWORDS_LIST } from '../reservedKeywords';

// Extract the keyword string literals from the `POSTGRES_RESERVED_KEYWORDS`
// Set defined inside the browser webview script. That file is injected as a
// plain string and cannot import the shared module, so this test enforces the
// two lists stay identical.
function readWebviewKeywords(): string[] {
    const src = fs.readFileSync(
        path.join(__dirname, '../../../src/webview/tableView.js'),
        'utf8'
    );
    const marker = 'const POSTGRES_RESERVED_KEYWORDS = new Set([';
    const start = src.indexOf(marker);
    assert.ok(start !== -1, 'POSTGRES_RESERVED_KEYWORDS not found in tableView.js');
    const end = src.indexOf(']);', start);
    assert.ok(end !== -1, 'Unterminated POSTGRES_RESERVED_KEYWORDS array in tableView.js');
    const body = src.slice(start + marker.length, end);
    return Array.from(body.matchAll(/'([^']+)'/g)).map(m => m[1]);
}

test('webview keyword list matches the canonical reservedKeywords.ts list', () => {
    const webviewKeywords = readWebviewKeywords();
    assert.deepEqual(
        [...webviewKeywords].sort(),
        [...POSTGRES_RESERVED_KEYWORDS_LIST].sort(),
        'tableView.js POSTGRES_RESERVED_KEYWORDS is out of sync with src/reservedKeywords.ts'
    );
});

test('canonical reserved keyword list has no duplicates', () => {
    const set = new Set(POSTGRES_RESERVED_KEYWORDS_LIST);
    assert.equal(set.size, POSTGRES_RESERVED_KEYWORDS_LIST.length);
});
