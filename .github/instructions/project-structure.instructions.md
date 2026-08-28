---
description: "Use when adding, moving or renaming files in the PostgreSQL Query Booster extension, wiring a new command, view or webview surface, or running the build, test, package and deploy scripts."
applyTo: "src/**, server/**, cli/**, package.json, esbuild.js"
---

# Project structure

## Where code goes

| Path | Contents |
| --- | --- |
| `src/extension.ts` | `activate`/`deactivate`, command registration, providers |
| `src/*.ts` | one module per feature (`queryRunner`, `connectionManager`, `tableWebView`, `plpgsqlFormatter`, …) — flat, no sub-folders |
| `src/webview/**` | browser assets: `*.js`, `*.css`, `tableView.html`, `icons.svg` — plain files, **not** bundled, read from disk at runtime |
| `src/test/**` | `<module>.test.ts`, one per source module; shared stubs in `src/test/helpers/` |
| `server/language-server.ts` | LSP server entry point |
| `cli/format-cli.ts` | `pgformat` CLI entry point |

Do not create new top-level folders or `src/` sub-folders. A new feature is a
new flat `src/<feature>.ts` plus `src/test/<feature>.test.ts`.

Committed `.js` siblings of `server/*.ts` and `cli/*.ts` are build leftovers —
edit only the `.ts` file.

## Build outputs — two of them

- `npm run compile` → esbuild bundles `src/extension.ts`, `server/language-server.ts`
  and `cli/format-cli.ts` into `dist/`. This is what the installed extension runs.
- `npm run compile:test` → `tsc -p ./` emits `out/`. This is what the tests run.

A change is only visible in an installed VSIX after `npm run package` /
`npm run deploy`; `npm test` alone rebuilds `out/` only.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm test` | `tsc -p ./` then `node --test out/src/test/**/*.test.js` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | `eslint src server cli` (flat config, no type-aware rules) |
| `npm run compile` / `watch` | esbuild dev build |
| `npm run package` | minified bundle |
| `npm run deploy` (`d`) | `vsce package` + CLI exe |

Run `npm test` after every source change.

## Wiring a new command

A command is only complete when all of these agree:

1. `contributes.commands` in `package.json` — `command`, `title`, `category: "PostgreSQL Query Booster"`, `icon`.
2. `contributes.menus` / view title placement, if it is reachable from the UI.
3. `vscode.commands.registerCommand` in `src/extension.ts`, pushed into `context.subscriptions`.
4. The same label and icon as every other surface offering it — see [STYLEGUIDE.md](STYLEGUIDE.md) §4.

New user-facing settings go under the `postgresQueryBuilder.*` prefix in
`contributes.configuration`.

## Do not rename stored-state identifiers

Command ids, view ids (`postgresSavedQueries`), setting keys and file formats
(`postgres-query-builder.saved-queries/v1`) are part of the user's persisted
state. The historic `savedQuery` spelling stays even though the feature is
called *Bookmarked Queries* in the UI.
