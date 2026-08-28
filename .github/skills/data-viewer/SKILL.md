---
name: data-viewer
description: "Add or change a feature of the Data Viewer webview (the Excel-like grid) of the PostgreSQL Query Booster — toolbar buttons, dialogs, context menu, filters, cell editing, export, or any new message between src/webview/tableView.js and src/tableWebView.ts."
argument-hint: "What the Data Viewer should do"
---

# Data Viewer

The grid is four files that must stay in agreement:

| File | Role |
| --- | --- |
| [src/webview/tableView.html](../../../src/webview/tableView.html) | skeleton + one template per dialog, plus four placeholders |
| [src/webview/tableView.css](../../../src/webview/tableView.css) | surface-specific styling only (base styling lives in `shared.css`) |
| [src/webview/tableView.js](../../../src/webview/tableView.js) | ~4900 lines of browser code |
| [src/tableWebView.ts](../../../src/tableWebView.ts) | extension host: panels, message handlers, database access |

Follow [STYLEGUIDE.md](../../../STYLEGUIDE.md) for anything visual — no literal
colours, no raw `z-index`, `.btn` classes, `icon()` for glyphs.

## How the host side is organised

One open panel is a `PanelSession` (`{ id, panel, origin, schema, table, historyKey, columns, disposed }`),
created by `createSession()` and kept in the `sessions` map. `origin` is
`'table'` (opened from the tree) or `'query'` (ad-hoc SELECT / bookmarked
query); for `'query'` panels **`schema` and `table` are empty strings**.

Both origins share one `messageHandlers` record (line ~341) mapping a command
name to a `(ctx: MessageContext) => …` method, where
`ctx = { session, message, queryRunner }`. An unknown command is dropped with a
console warning, and anything a handler throws is caught centrally: the host
posts `{ command: 'error' }` and shows an error message.

Send to the webview only through `this.post(session, …)` — it checks
`session.disposed`, so a late answer to a closed panel is not an error.

`getWebviewContent()` (line ~929) substitutes four placeholders and always uses
the function form of `replace`, so `$&` inside injected SQL cannot expand:

```ts
html = html.replace('/* SHARED_CSS_PLACEHOLDER */', () => getSharedStyles());
html = html.replace('<!-- ICON_SPRITE_PLACEHOLDER -->', () => getIconSprite());
html = html.replace('/* CSS_PLACEHOLDER */', () => css);
html = html.replace('/* JS_PLACEHOLDER */', () => js);
```

## How the browser side is organised

```
lines    1–1453   top-level pure functions        ← testable, no DOM
line     1454     if (typeof window !== 'undefined' && typeof document !== 'undefined') {
line     1456         const vscode = acquireVsCodeApi();
line     2053         window.addEventListener('message', …)   ← inbound commands
line     2532         renderTable() → renderHeader() (2600) + renderBody() (3147)
line     4499         escapeHtml() / escapeAttr()
                  }
bottom            module.exports guard             ← what the tests require()
```

There is no bundler: the file cannot `import` from `src/`, so a small duplicate
of a TypeScript helper is accepted. Markup is built by string concatenation —
**every interpolated value goes through `escapeAttr()` (attributes) or
`escapeHtml()` (text)**, no exceptions.

## Adding a round trip

1. **Markup** — extend `tableView.html`, or build it in the render function that
   owns that region. A new dialog follows the existing `.sql-dialog-overlay`
   template.
2. **Style** — add only what is specific to this surface to `tableView.css`,
   using the tokens from `shared.css`.
3. **Wire the event** — inside the DOM block. Prefer a `data-*` attribute plus
   delegation; `window.fn = …` globals exist only for the legacy row-action
   `onclick` buttons and should not grow.
4. **Ask the host** — `vscode.postMessage({ command: 'myThing', … })`.
5. **Handle it** — add `myThing: this.handleMyThing` to `messageHandlers` and a
   `private async handleMyThing(ctx: MessageContext)`. Read `ctx.message`, use
   `ctx.queryRunner`, answer with `this.post(ctx.session, { command: 'myThingDone', … })`.
   Let errors throw — the central catch reports them.
6. **Consume the answer** — add a branch to the `message` listener.
7. **Test** — move the decision logic into a top-level pure function, add it to
   `module.exports`, and cover it in
   [src/test/tableViewFilterLogic.test.ts](../../../src/test/tableViewFilterLogic.test.ts)
   or a sibling; test host helpers in
   [src/test/tableWebView.test.ts](../../../src/test/tableWebView.test.ts).

## Rules that are easy to get wrong

- **Both origins must survive.** A handler that reads `session.schema` /
  `session.table` breaks on a `'query'` panel — guard it, or derive the table
  from `message.sql` as the export handler does.
- **The command name is a contract** in two files. A typo fails silently as a
  console warning inside the webview host.
- **Always release the loading state.** Every path out of a handler that started
  a spinner must post a terminating message (`loadingFinished`, a result, or an
  error), otherwise the grid spins forever.
- **Call `ensureConnected()`** before a query in any handler a user can trigger,
  and post the terminating message when it returns `false`.
- **Values never reach SQL by concatenation** on the host: use parameters, or
  `escapeSqlLiteral` when a literal is unavoidable. In the browser, build
  clauses with the existing `buildFilterClause` / `escapeSqlString` helpers.
- `renderBody()` rebuilds the tbody and clears transient state such as the cell
  range selection — re-apply anything that must survive a reload.

## Seeing the change

`npm test` rebuilds only `out/`. The webview assets are read from disk at
runtime through `context.extensionPath`, so a debug session (F5) picks them up
after reloading the panel, while the **installed** extension needs
`npm run package` / `npm run deploy` and a window reload.
