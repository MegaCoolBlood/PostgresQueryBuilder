import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import * as fs from 'fs';

const ROOT = path.join(__dirname, '..', '..', '..');
const { tagRelease } = require(path.join(ROOT, 'release-tag.js'));

const HEAD = 'abc1234def5678';

/** A git that answers like a repository whose last commit is HEAD, recording what it is asked to do. */
function fakeGit(options: { committedVersion?: string; taggedAt?: string; dirty?: boolean; failPush?: boolean } = {}) {
    const calls: string[] = [];
    const git = (args: string[]): string => {
        const command = args.join(' ');
        calls.push(command);
        if (command === 'show HEAD:package.json') return JSON.stringify({ version: options.committedVersion ?? '3.5.4' });
        if (command === 'rev-parse HEAD') return `${HEAD}\n`;
        if (args[0] === 'rev-parse') {
            if (!options.taggedAt) throw new Error('exit code 1');
            return `${options.taggedAt}\n`;
        }
        if (command === 'status --porcelain') return options.dirty ? ' M README.md\n' : '';
        if (args[0] === 'push' && options.failPush) throw new Error('rejected');
        return '';
    };
    return { git, calls, log: [] as string[] };
}

const changes = (calls: string[]) => calls.filter((c) => /^(tag|push)\b/.test(c));

test('npm run d tags the last commit with the version and pushes only that tag', () => {
    const repo = fakeGit();
    const tag = tagRelease(repo.git, '3.5.4', { log: (m: string) => repo.log.push(m) });

    assert.equal(tag, 'v3.5.4', 'named like the earlier release tags');
    assert.deepEqual(changes(repo.calls), ['tag v3.5.4', 'push origin refs/tags/v3.5.4']);
    assert.deepEqual(repo.log, ['Created tag v3.5.4 on abc1234.', 'Pushed v3.5.4 to origin.']);

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.d, 'npm run deploy && npm run tag', 'tagged only once the package is built');
    assert.equal(pkg.scripts.tag, 'node release-tag.js');
});

test('a tag of the version on the last commit is pushed again instead of failing', () => {
    const repo = fakeGit({ taggedAt: HEAD });
    tagRelease(repo.git, '3.5.4', { log: (m: string) => repo.log.push(m) });
    assert.deepEqual(changes(repo.calls), ['push origin refs/tags/v3.5.4']);
    assert.equal(repo.log[0], 'v3.5.4 already marks the last commit.');
});

test('nothing is tagged when the version is not committed or its tag marks another commit', () => {
    const uncommitted = fakeGit({ committedVersion: '3.5.3' });
    assert.throws(() => tagRelease(uncommitted.git, '3.5.4', { log: () => undefined }),
        /package\.json says 3\.5\.4, but the last commit says 3\.5\.3: commit the version before tagging v3\.5\.4\./);
    assert.deepEqual(changes(uncommitted.calls), []);

    const elsewhere = fakeGit({ taggedAt: '9999999aaaa' });
    assert.throws(() => tagRelease(elsewhere.git, '3.5.4', { log: () => undefined }),
        /v3\.5\.4 already marks commit 9999999, not the last commit abc1234\./);
    assert.deepEqual(changes(elsewhere.calls), []);
});

test('uncommitted changes are pointed out, and a failed push fails the release', () => {
    const dirty = fakeGit({ dirty: true });
    tagRelease(dirty.git, '3.5.4', { log: (m: string) => dirty.log.push(m) });
    assert.ok(dirty.log.includes('Warning: uncommitted changes are not part of v3.5.4.'));

    const rejected = fakeGit({ failPush: true });
    assert.throws(() => tagRelease(rejected.git, '3.5.4', { log: () => undefined }), /rejected/);
});
