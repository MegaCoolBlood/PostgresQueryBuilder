import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readFormatConfigFile, readRepoFormatConfig, formatOptionsToRepoConfig, REPO_FORMAT_CONFIG_FILENAME, resolveFormatConfigPath } from '../repoFormatConfig';
import { coerceFormatOptions, DEFAULT_FORMAT_OPTIONS, formatSql, formatSqlChecked } from '../plpgsqlFormatter';

function withTempDir(fn: (dir: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgformat-test-'));
    try {
        fn(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------
// readRepoFormatConfig
// ---------------------------------------------------------------------------

test('readRepoFormatConfig returns an empty object when the file is absent', () => {
    withTempDir(dir => {
        assert.deepEqual(readRepoFormatConfig(dir), {});
    });
});

test('readRepoFormatConfig parses a valid JSON object', () => {
    withTempDir(dir => {
        const config = { keywordCase: 'lower', indentSize: 4 };
        fs.writeFileSync(path.join(dir, REPO_FORMAT_CONFIG_FILENAME), JSON.stringify(config));
        assert.deepEqual(readRepoFormatConfig(dir), config);
    });
});

test('readRepoFormatConfig returns empty object for invalid JSON and does not throw', () => {
    withTempDir(dir => {
        fs.writeFileSync(path.join(dir, REPO_FORMAT_CONFIG_FILENAME), 'NOT { valid json }');
        assert.doesNotThrow(() => {
            const result = readRepoFormatConfig(dir);
            assert.deepEqual(result, {});
        });
    });
});

test('readRepoFormatConfig returns empty object when file contains a JSON array', () => {
    withTempDir(dir => {
        fs.writeFileSync(path.join(dir, REPO_FORMAT_CONFIG_FILENAME), '[1, 2, 3]');
        assert.deepEqual(readRepoFormatConfig(dir), {});
    });
});

test('readRepoFormatConfig returns empty object when file contains a JSON primitive', () => {
    withTempDir(dir => {
        fs.writeFileSync(path.join(dir, REPO_FORMAT_CONFIG_FILENAME), '"just a string"');
        assert.deepEqual(readRepoFormatConfig(dir), {});
    });
});

test('readRepoFormatConfig returns empty object for an unreadable file path (not just ENOENT)', () => {
    // A path that is a directory, not a file, causes a read error other than ENOENT.
    withTempDir(dir => {
        // Create a sub-directory with the config file name so readFileSync fails.
        const fakePath = path.join(dir, REPO_FORMAT_CONFIG_FILENAME);
        fs.mkdirSync(fakePath);
        assert.doesNotThrow(() => {
            assert.deepEqual(readRepoFormatConfig(dir), {});
        });
    });
});

test('readFormatConfigFile parses a valid JSON object from an explicit path', () => {
    withTempDir(dir => {
        const filePath = path.join(dir, 'custom-format.json');
        const config = { keywordCase: 'lower', indentSize: 3 };
        fs.writeFileSync(filePath, JSON.stringify(config));
        assert.deepEqual(readFormatConfigFile(filePath), config);
    });
});

// ---------------------------------------------------------------------------
// Integration: repo config values flow through coerceFormatOptions correctly
// ---------------------------------------------------------------------------

test('repo keywordCase lower overrides default upper when merged via coerceFormatOptions', () => {
    withTempDir(dir => {
        fs.writeFileSync(path.join(dir, REPO_FORMAT_CONFIG_FILENAME), JSON.stringify({ keywordCase: 'lower' }));
        const repo = readRepoFormatConfig(dir);
        const opts = coerceFormatOptions({ keywordCase: repo['keywordCase'] });
        assert.equal(opts.keywordCase, 'lower');
    });
});

test('repo indentSize 4 is accepted by coerceFormatOptions', () => {
    withTempDir(dir => {
        fs.writeFileSync(path.join(dir, REPO_FORMAT_CONFIG_FILENAME), JSON.stringify({ indentSize: 4 }));
        const repo = readRepoFormatConfig(dir);
        const opts = coerceFormatOptions({ indentSize: repo['indentSize'] });
        assert.equal(opts.indentSize, 4);
    });
});

test('repo listThresholds string is parsed by coerceFormatOptions', () => {
    withTempDir(dir => {
        fs.writeFileSync(
            path.join(dir, REPO_FORMAT_CONFIG_FILENAME),
            JSON.stringify({ listThresholds: { selectColumns: '2, 4' } })
        );
        const repo = readRepoFormatConfig(dir);
        const opts = coerceFormatOptions({ listThresholds: repo['listThresholds'] });
        assert.equal(opts.thresholds.selectColumns?.inlineMax, 2);
        assert.equal(opts.thresholds.selectColumns?.multilineMin, 4);
    });
});

test('unknown keys in repo config are silently ignored by coerceFormatOptions', () => {
    withTempDir(dir => {
        fs.writeFileSync(
            path.join(dir, REPO_FORMAT_CONFIG_FILENAME),
            JSON.stringify({ unknownKey: 'value', keywordCase: 'preserve' })
        );
        const repo = readRepoFormatConfig(dir);
        assert.doesNotThrow(() => {
            const opts = coerceFormatOptions({ keywordCase: repo['keywordCase'] });
            assert.equal(opts.keywordCase, 'preserve');
        });
    });
});

// ---------------------------------------------------------------------------
// formatOptionsToRepoConfig
// ---------------------------------------------------------------------------

test('formatOptionsToRepoConfig includes all scalar format fields', () => {
    const opts = coerceFormatOptions({ keywordCase: 'lower', indentSize: 4, commaStyle: 'leading' });
    const record = formatOptionsToRepoConfig(opts);
    assert.equal(record['keywordCase'], 'lower');
    assert.equal(record['indentSize'], 4);
    assert.equal(record['commaStyle'], 'leading');
    assert.equal(record['identifierCase'], DEFAULT_FORMAT_OPTIONS.identifierCase);
    assert.equal(record['normalizeDataTypes'], DEFAULT_FORMAT_OPTIONS.normalizeDataTypes);
});

test('formatOptionsToRepoConfig serializes thresholds as "inlineMax, multilineMin" strings', () => {
    const opts = coerceFormatOptions({ listThresholds: { selectColumns: '3, 6' } });
    const record = formatOptionsToRepoConfig(opts);
    const thresholds = record['listThresholds'] as Record<string, string>;
    assert.equal(typeof thresholds, 'object');
    assert.equal(thresholds['selectColumns'], '3, 6');
});

test('formatOptionsToRepoConfig round-trips through readRepoFormatConfig + coerceFormatOptions', () => {
    const original = coerceFormatOptions({
        keywordCase: 'lower',
        indentSize: 4,
        listThresholds: { selectColumns: '2, 5', fromTables: '1, 3' }
    });
    withTempDir(dir => {
        const record = formatOptionsToRepoConfig(original);
        fs.writeFileSync(path.join(dir, REPO_FORMAT_CONFIG_FILENAME), JSON.stringify(record, null, 2));
        const repo = readRepoFormatConfig(dir);
        const restored = coerceFormatOptions(repo);
        assert.equal(restored.keywordCase, original.keywordCase);
        assert.equal(restored.indentSize, original.indentSize);
        assert.equal(restored.thresholds.selectColumns?.inlineMax, original.thresholds.selectColumns?.inlineMax);
        assert.equal(restored.thresholds.selectColumns?.multilineMin, original.thresholds.selectColumns?.multilineMin);
        assert.equal(restored.thresholds.fromTables?.inlineMax, original.thresholds.fromTables?.inlineMax);
    });
});

test('formatOptionsToRepoConfig includes dataTypeAliases as a plain object', () => {
    const opts = coerceFormatOptions({ dataTypeAliases: { 'character varying': 'varchar' } });
    const record = formatOptionsToRepoConfig(opts);
    const aliases = record['dataTypeAliases'] as Record<string, string>;
    assert.equal(typeof aliases, 'object');
    assert.equal(aliases['character varying'], 'varchar');
});

// ---------------------------------------------------------------------------
// End-to-end: a .pgformat.json actually changes CREATE FUNCTION formatting
// (this mirrors the exact code path the CLI uses:
//  readRepoFormatConfig -> coerceFormatOptions -> formatSqlChecked)
// ---------------------------------------------------------------------------

/** The single-line CREATE FUNCTION with two parameters used across the tests below. */
const CREATE_FN_TWO_PARAMS =
    'CREATE FUNCTION s.f(a integer, b text) RETURNS void LANGUAGE sql AS $$ SELECT 1; $$;';

test('.pgformat.json createFunction "9, 20" keeps a 2-param function inline, unlike the default', () => {
    withTempDir(dir => {
        // Sanity: with the built-in default (createFunction {0,1}) a 2-param header wraps.
        const defaultOut = formatSql(CREATE_FN_TWO_PARAMS);
        assert.ok(defaultOut.includes('\n'), `default should wrap, got: ${defaultOut}`);
        assert.ok(defaultOut.includes('CREATE FUNCTION s.f('), defaultOut);

        // Write a repo config that raises the threshold so 2 params stay inline.
        fs.writeFileSync(
            path.join(dir, REPO_FORMAT_CONFIG_FILENAME),
            JSON.stringify({ listThresholds: { createFunction: '9, 20' } })
        );

        // Exact CLI path: read file -> coerce -> format.
        const repo = readRepoFormatConfig(dir);
        const opts = coerceFormatOptions(repo);
        const configuredOut = formatSql(CREATE_FN_TWO_PARAMS, opts);

        // The configured output must differ from the default and stay on one line.
        assert.notEqual(configuredOut, defaultOut);
        assert.equal(
            configuredOut,
            'CREATE FUNCTION s.f(a INTEGER, b TEXT) RETURNS VOID LANGUAGE sql AS $$ SELECT 1; $$;'
        );
    });
});

test('.pgformat.json createFunction "0, 1" wraps a 2-param function that the source wrote inline', () => {
    withTempDir(dir => {
        fs.writeFileSync(
            path.join(dir, REPO_FORMAT_CONFIG_FILENAME),
            JSON.stringify({ listThresholds: { createFunction: '0, 1' } })
        );
        const repo = readRepoFormatConfig(dir);
        const opts = coerceFormatOptions(repo);
        const out = formatSqlChecked(CREATE_FN_TWO_PARAMS, opts);

        assert.equal(out.ok, true, out.reason);
        assert.equal(
            out.text,
            [
                'CREATE FUNCTION s.f(',
                '  a INTEGER,',
                '  b TEXT',
                ') RETURNS VOID',
                '  LANGUAGE sql',
                'AS $$ SELECT 1; $$;'
            ].join('\n')
        );
    });
});

test('an explicit --config path (readFormatConfigFile) changes CREATE FUNCTION formatting', () => {
    withTempDir(dir => {
        // Mirrors `pgformat --config custom.json`: a config file at an arbitrary path.
        const configPath = path.join(dir, 'my-format.json');
        fs.writeFileSync(configPath, JSON.stringify({ listThresholds: { createFunction: '9, 20' } }));

        const config = readFormatConfigFile(configPath);
        const opts = coerceFormatOptions(config);
        const out = formatSql(CREATE_FN_TWO_PARAMS, opts);

        assert.equal(
            out,
            'CREATE FUNCTION s.f(a INTEGER, b TEXT) RETURNS VOID LANGUAGE sql AS $$ SELECT 1; $$;'
        );
    });
});

test('.pgformat.json keywordCase lower reaches CREATE FUNCTION output via the CLI path', () => {
    withTempDir(dir => {
        fs.writeFileSync(
            path.join(dir, REPO_FORMAT_CONFIG_FILENAME),
            JSON.stringify({ keywordCase: 'lower', listThresholds: { createFunction: '9, 20' } })
        );
        const repo = readRepoFormatConfig(dir);
        const opts = coerceFormatOptions(repo);
        const out = formatSql(CREATE_FN_TWO_PARAMS, opts);

        // Keywords are lower-cased; data types keep the default upper case, and the
        // raised threshold keeps the header inline.
        assert.equal(
            out,
            'create function s.f(a INTEGER, b TEXT) returns VOID language sql as $$ SELECT 1; $$;'
        );
    });
});

// ---------------------------------------------------------------------------
// resolveFormatConfigPath
// ---------------------------------------------------------------------------

test('resolveFormatConfigPath returns <folder>/.pgformat.json when no configPath is given', () => {
    assert.equal(
        resolveFormatConfigPath(path.join('root', 'ws')),
        path.join('root', 'ws', REPO_FORMAT_CONFIG_FILENAME)
    );
});

test('resolveFormatConfigPath returns undefined without a folder or configPath', () => {
    assert.equal(resolveFormatConfigPath(undefined, undefined), undefined);
    assert.equal(resolveFormatConfigPath(undefined, '   '), undefined);
});

test('resolveFormatConfigPath uses an absolute configPath verbatim', () => {
    const abs = path.resolve(path.sep, 'etc', 'pgformat', 'rules.json');
    assert.equal(resolveFormatConfigPath(path.join('root', 'ws'), abs), abs);
    // Even with no workspace folder the absolute path is honoured.
    assert.equal(resolveFormatConfigPath(undefined, abs), abs);
});

test('resolveFormatConfigPath resolves a relative configPath against the workspace folder', () => {
    assert.equal(
        resolveFormatConfigPath(path.join('root', 'ws'), path.join('config', 'fmt.json')),
        path.join('root', 'ws', 'config', 'fmt.json')
    );
});

test('resolveFormatConfigPath trims surrounding whitespace from configPath', () => {
    assert.equal(
        resolveFormatConfigPath(path.join('root', 'ws'), '  sub/fmt.json  '),
        path.join('root', 'ws', 'sub', 'fmt.json')
    );
});
