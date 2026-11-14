'use strict';

// Tags the commit of a release with its version (v<version>, like the earlier
// release tags) and pushes the tag; run by `npm run d` after packaging.

const { execFileSync } = require('child_process');
const path = require('path');

function releaseTagName(version) {
    return `v${version}`;
}

/**
 * Creates the tag of `version` on HEAD and pushes it to `remote`. `git(args)`
 * runs git and returns its output, throwing when git fails.
 */
function tagRelease(git, version, { remote = 'origin', log = console.log } = {}) {
    const tag = releaseTagName(version);
    const committed = JSON.parse(git(['show', 'HEAD:package.json'])).version;
    if (committed !== version) {
        throw new Error(`package.json says ${version}, but the last commit says ${committed}: commit the version before tagging ${tag}.`);
    }

    const head = git(['rev-parse', 'HEAD']).trim();
    let tagged;
    try {
        tagged = git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]).trim();
    } catch {
        tagged = undefined;
    }
    if (tagged && tagged !== head) {
        throw new Error(`${tag} already marks commit ${tagged.slice(0, 7)}, not the last commit ${head.slice(0, 7)}.`);
    }
    if (tagged) {
        log(`${tag} already marks the last commit.`);
    } else {
        git(['tag', tag]);
        log(`Created tag ${tag} on ${head.slice(0, 7)}.`);
    }
    if (git(['status', '--porcelain']).trim()) {
        log(`Warning: uncommitted changes are not part of ${tag}.`);
    }

    git(['push', remote, `refs/tags/${tag}`]);
    log(`Pushed ${tag} to ${remote}.`);
    return tag;
}

if (require.main === module) {
    const git = (args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    try {
        tagRelease(git, require(path.join(__dirname, 'package.json')).version);
    } catch (error) {
        const stderr = error && error.stderr ? String(error.stderr).trim() : '';
        console.error(`Release tag failed: ${stderr || (error instanceof Error ? error.message : String(error))}`);
        process.exitCode = 1;
    }
}

module.exports = { releaseTagName, tagRelease };
