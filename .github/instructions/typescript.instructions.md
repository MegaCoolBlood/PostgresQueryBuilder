---
description: "Use when writing or changing TypeScript in the PostgreSQL Query Builder extension host, language server or CLI — error handling, logging, typing, SQL construction and database access."
applyTo: "src/*.ts, server/**/*.ts, cli/**/*.ts"
---

# TypeScript conventions

Target ES2022, CommonJS, `strict: true`. 4-space indent, single quotes,
semicolons. One-line guards (`if (!x) return;`) are idiomatic here; a body on
its own line always gets braces.

## Errors and logging

Never `catch (err: any)`. Catch `unknown` and use the helpers from
`src/logger.ts`:

```ts
try {
    await this.connectionManager.query(sql, params);
} catch (err: unknown) {
    Logger.error('QueryRunner.updateRow', err);
    vscode.window.showErrorMessage(`Update failed: ${getErrorMessage(err)}`);
}
```

- `Logger.log(scope, message)` / `Logger.error(scope, err)` — scope is
  `Class.method`. Logging is a safe no-op before `Logger.init`, so it works in tests.
- `getErrorMessage(err)` for user-facing text, `getErrorStack(err)` for diagnostics.
- Do not use `console.log` in extension code.

## Typing

Avoid `any`. It is tolerated only at message boundaries (`postMessage` payloads),
for third-party shapes and in test mocks. Prefer a narrow interface over
`Record<string, any>`.

## SQL construction

- **Values are parameters**: `query('SELECT … WHERE id = $1', [id])`. Never
  interpolate user input into SQL.
- Where a literal is unavoidable (generated scripts, exports, `IN` lists built
  from result data), use `escapeSqlLiteral` from `src/sqlUtils.ts` — do not
  hand-roll `.replace(/'/g, "''")`.
- Identifiers go through `formatIdentifier` / the reserved-word list in
  `src/reservedKeywords.ts`, which is the single source of truth; the copy in
  `src/webview/tableView.js` is guarded by a drift test and must stay in sync.

## Database access

Call `await connectionManager.ensureConnected()` at user-facing entry points
(commands, webview message handlers) and bail out when it returns `false`. Do
not add it to low-level `query()`.

## Formatter changes

`src/plpgsqlFormatter.ts` has a token-signature safety net: if formatting alters
the token stream, the original text is returned. Keep it intact, and verify new
formatting rules are **idempotent** (formatting twice equals formatting once).

## Testability

Extract decision logic into exported pure functions and test those, rather than
reaching for `vscode` API mocks. Keep VS Code interaction in thin wrappers.
