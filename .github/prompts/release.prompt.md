---
description: "Cut a release of the PostgreSQL Query Builder extension: run the tests, write the CHANGELOG entry in house style, refresh the README, bump the version and package the VSIX."
argument-hint: "patch | minor | major"
agent: "agent"
---

Release the extension. The argument selects the bump level (`patch` when omitted).

Work through the steps in order and stop at the checkpoint.

## 1. Verify

- Run `npm test`. Every test must pass — do not continue otherwise, and do not
  weaken a test to get there.
- Run `git status --short`. Report anything uncommitted so the user can decide
  whether it belongs in this release.

## 2. Collect what changed

- Read the top heading of [CHANGELOG.md](../../CHANGELOG.md) to get the last
  released version.
- Run `git log --oneline <last-version-tag-or-first-commit>..HEAD` and
  `git diff --stat` against that point. If no tag exists, use the commit that
  last touched the changelog heading.
- Group the commits into **user-visible changes**. Drop pure refactors,
  test-only work and formatting churn — they do not get an entry.

## 3. Draft the entry

Write the new `## <version>` section at the top of CHANGELOG.md, following
[.github/instructions/changelog.instructions.md](../instructions/changelog.instructions.md):
bold claim, then what was wrong before, then what happens now. English, no
dates, no sections, no issue references.

## 4. Refresh the docs

Check whether the release changed anything documented in
[README.md](../../README.md) — *Features*, *Commands*, *Keyboard Shortcuts*,
*Extension Settings* — and update those sections. A new command in
`contributes.commands` or a new `postgresQueryBuilder.*` setting always needs a
README line.

## 5. Checkpoint

Show the user the drafted changelog entry and the README diff, and state which
bump level you are about to apply. **Wait for approval.**

## 6. Ship

After approval run the matching script from [package.json](../../package.json):

| Level | Command |
| --- | --- |
| patch | `npm run d1` |
| minor | `npm run d2` |
| major | `npm run d3` |

Each one bumps the version in `package.json`, runs `vsce package` and builds the
CLI executable. Report the resulting `.vsix` file name and remind the user that
the installed extension only picks up the change after reloading the window.

Do not commit, tag or push unless the user asks.
