---
description: "Use when building or changing any webview UI of the PostgreSQL Query Booster extension — HTML, CSS, icons, buttons, labels or the panels in src/webview and the TypeScript modules that generate webview HTML."
applyTo: "src/webview/**, src/webviewUtils.ts, src/webviewAssets.ts, src/tableWebView.ts, src/joinDialog.ts, src/sqlEditor.ts, src/searchViewProvider.ts, src/modifyHistoryViewProvider.ts, src/manageMappingsPanel.ts, src/viewDataFromSelect.ts"
---

# Webview UI

[STYLEGUIDE.md](STYLEGUIDE.md) is binding. Read it before changing a surface —
the rules below are the ones that break `npm test` (`webviewDesign.test.ts`,
`webviewAssets.test.ts`, `uiConsistency.test.ts`) when violated.

## Hard rules

- **No literal colour.** No `#rrggbb`, `rgb()`, `rgba()`, `white`, `black`.
  Use the semantic tokens (`--c-fg`, `--c-bg`, `--c-surface`, `--c-border`,
  `--c-muted`, `--c-accent`, `--c-hover`, `--c-danger`, `--c-warning`,
  `--c-success`, `--c-info`, `--c-code-bg`) from `src/webview/shared.css`.
  Derive tints with `color-mix(in srgb, var(--c-warning) 12%, transparent)`.
- **No raw `z-index`.** Use `--z-sticky`, `--z-dropdown`, `--z-dialog`, `--z-menu`.
- **No inline `style="…"`** carrying colour, padding or font-size. Runtime-computed
  values go in a custom property, everything else in a class.
- **Spacing and type come from tokens**: `--sp-1`…`--sp-6`, `--fs-xs`…`--fs-lg`,
  `--radius`, `--radius-lg`. Bare `0`/`1px`/`2px`/`3px` are allowed for hairlines.
- **No new base styling.** Buttons, inputs, tables, badges and dialogs already
  exist in `shared.css`; a surface stylesheet holds only surface-specific rules.
- **Every user-visible string is English.**
- **Never hide an action** behind an overflow menu — make it `.btn-sm` instead.

## Buttons

Only `.btn` is styled; a bare `<button>` is deliberately unstyled. Combine
`.btn` with `.btn-primary` (at most one per group), `.btn-danger`, `.btn-ghost`,
`.btn-icon`, `.btn-sm`. The classes `btn-default`, `btn-success`, `btn-warning`,
`btn-duplicate`, `button.primary` and `button.secondary` are removed and MUST
NOT return.

Labels are short (`Insert`, `Save`, `Export`); the sentence goes in `title`. No
leading `+`/`▶`/`☆` glyph in a label, and a label never ends in `…`.

## Building a surface

Regular webviews use `buildHtmlDocument()` from `src/webviewUtils.ts` and
**always** pass `webview` (that is what emits the CSP meta tag and script nonce):

```ts
return buildHtmlDocument({ webview, title: 'My Panel', styles, body, script });
```

The Data Viewer (`src/tableWebView.ts`, `getWebviewContent`) instead substitutes
four placeholders in `src/webview/tableView.html`. Always replace with a
**function** — `html.replace(p, () => css)` — never a string, or `$&` / `$'`
inside injected SQL will expand and corrupt the document.

## Icons

Reference icons through `icon('name')` from `src/webviewAssets.ts` (or the local
`icon()` in `tableView.js`), never by hand. New symbols in
`src/webview/icons.svg` use `viewBox="0 0 16 16"`, geometry only — no `fill`,
`stroke`, `width` or `color`; filled shapes get `class="f"`.

## Browser assets are not bundled

`src/webview/**` is read from disk at runtime and kept in `.vscodeignore`. It
has no bundler, so it cannot `import` from `src/`; a small duplicate of a helper
is accepted there. Keep pure logic at the top level of the file and export it
under the `typeof module !== 'undefined'` guard so tests can `require()` it.
