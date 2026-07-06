import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readFormatConfigFile, readRepoFormatConfig, formatOptionsToRepoConfig, REPO_FORMAT_CONFIG_FILENAME } from '../repoFormatConfig';
import { coerceFormatOptions, DEFAULT_FORMAT_OPTIONS } from '../plpgsqlFormatter';

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
