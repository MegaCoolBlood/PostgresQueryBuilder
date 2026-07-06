import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveFormatOptions } from '../formatConfig';
import { REPO_FORMAT_CONFIG_FILENAME } from '../repoFormatConfig';

function withTempDir(fn: (dir: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'format-config-test-'));
    try {
        fn(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('resolveFormatOptions prefers repo config over VS Code settings', () => {
    withTempDir(dir => {
        fs.writeFileSync(
            path.join(dir, REPO_FORMAT_CONFIG_FILENAME),
            JSON.stringify({ keywordCase: 'lower', indentSize: 6 })
        );

        const options = resolveFormatOptions((configKey) => {
            if (configKey === 'format.keywordCase') return 'upper';
            if (configKey === 'format.indentSize') return 2;
            return undefined;
        }, dir);

        assert.equal(options.keywordCase, 'lower');
        assert.equal(options.indentSize, 6);
    });
});

test('resolveFormatOptions falls back to settings when no repo config exists', () => {
    const options = resolveFormatOptions((configKey) => {
        if (configKey === 'format.commaStyle') return 'leading';
        if (configKey === 'format.simpleSelectSingleLine') return false;
        return undefined;
    });

    assert.equal(options.commaStyle, 'leading');
    assert.equal(options.simpleSelectSingleLine, false);
});