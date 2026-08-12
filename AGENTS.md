# PostgreSQL Query Builder — agent guide

VS Code extension (TypeScript, CommonJS, `strict`, VS Code ≥ 1.85, Node ≥ 18)
for browsing, editing and querying PostgreSQL: tree views, an Excel-like Data
Viewer webview, an export service and a PL/pgSQL formatter that is also shipped
as a CLI and a language server.

## Before you start

- `npm test` — `tsc -p ./` into `out/`, then `node --test`. ~1000 tests, fast,
  offline. Run it after every source change.
- `npm run typecheck` — `tsc --noEmit`; `npm run lint` — eslint 9 flat config
  ([eslint.config.js](eslint.config.js)), warnings are tolerated, errors are not.
- **Two build outputs.** Tests run `out/` (tsc); the installed extension runs
  the bundled `dist/extension.js` (esbuild). A change is only visible in the
  running extension after `npm run package` / `npm run deploy` and a window
  reload — this is the most common source of "my fix does nothing".
- `src/webview/**` is read from disk at runtime and is deliberately not bundled,
  so it cannot import from `src/`.

## Non-negotiables

- Every user-visible string is **English**. The German text in `CHANGELOG.md`
  (version 1.3.0 and older) is a historical record — never translate it.
- No literal colours or raw `z-index` in any webview; [STYLEGUIDE.md](STYLEGUIDE.md)
  is binding and enforced by tests.
- Command ids, view ids, setting keys and stored file formats are the user's
  persisted state — rename labels, never identifiers.
- Values reach the database as parameters (`$1`), never by string interpolation.
- Do not relax or delete a guard test to make a change pass.

## Detailed rules

`.github/instructions/` holds the per-area rules (project structure, TypeScript,
tests, webview UI, changelog); `.github/skills/` holds the deep dives on the
formatter and on the Data Viewer webview. They load automatically when relevant
— read them rather than guessing.
