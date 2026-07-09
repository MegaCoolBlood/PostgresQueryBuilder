import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveFormatOptions } from '../formatConfig';
import { REPO_FORMAT_CONFIG_FILENAME } from '../repoFormatConfig';
import { formatSql } from '../plpgsqlFormatter';

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

test('resolveFormatOptions reads an absolute configPath instead of .pgformat.json', () => {
    withTempDir(dir => {
        // The default file name says one thing...
        fs.writeFileSync(
            path.join(dir, REPO_FORMAT_CONFIG_FILENAME),
            JSON.stringify({ keywordCase: 'upper' })
        );
        // ...but the explicit configPath points at a different file that wins.
        const customPath = path.join(dir, 'rules.json');
        fs.writeFileSync(customPath, JSON.stringify({ keywordCase: 'lower', indentSize: 5 }));

        const options = resolveFormatOptions(
            () => undefined,
            dir,
            customPath
        );

        assert.equal(options.keywordCase, 'lower');
        assert.equal(options.indentSize, 5);
    });
});

test('resolveFormatOptions resolves a relative configPath against the workspace folder', () => {
    withTempDir(dir => {
        const sub = path.join(dir, 'config');
        fs.mkdirSync(sub);
        fs.writeFileSync(path.join(sub, 'fmt.json'), JSON.stringify({ commaStyle: 'leading' }));

        const options = resolveFormatOptions(
            () => undefined,
            dir,
            path.join('config', 'fmt.json')
        );

        assert.equal(options.commaStyle, 'leading');
    });
});

test('resolveFormatOptions with configPath overrides createFunction threshold for CREATE FUNCTION output', () => {
    withTempDir(dir => {
        const customPath = path.join(dir, 'my-rules.json');
        fs.writeFileSync(customPath, JSON.stringify({ listThresholds: { createFunction: '9, 20' } }));

        const options = resolveFormatOptions(() => undefined, dir, customPath);
        const out = formatSql('CREATE FUNCTION s.f(a integer, b text) RETURNS void LANGUAGE sql AS $$ SELECT 1; $$;', options);

        // The raised threshold from the custom-path file keeps the 2-param header inline.
        assert.equal(
            out,
            'CREATE FUNCTION s.f(a INTEGER, b TEXT) RETURNS VOID LANGUAGE sql AS $$ SELECT 1; $$;'
        );
    });
});

test('resolveFormatOptions ignores an empty/whitespace configPath and uses .pgformat.json', () => {
    withTempDir(dir => {
        fs.writeFileSync(
            path.join(dir, REPO_FORMAT_CONFIG_FILENAME),
            JSON.stringify({ keywordCase: 'lower' })
        );

        const options = resolveFormatOptions(() => 'upper', dir, '   ');
        assert.equal(options.keywordCase, 'lower');
    });
});