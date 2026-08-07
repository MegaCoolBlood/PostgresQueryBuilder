# UI Style Guide

Binding rules for every user interface of this extension, addressed to human
developers and to AI assistants alike. Anything marked **MUST** is enforced by
`src/test/webviewDesign.test.ts` and `src/test/webviewAssets.test.ts` — a change
that breaks it fails `npm test`.

---

## 1. Hard rules

1. **No literal colour, anywhere.** Not `#4caf50`, not `rgb(...)`, not `rgba(...)`,
   not `white`/`black`. Every colour MUST come from a `--vscode-*` theme variable,
   normally through one of the semantic tokens in section 3. This is what keeps
   Dark+, Light+ and High Contrast usable.
2. **No raw `z-index`.** Use one of the four layer tokens. Stacking bugs are
   otherwise impossible to reason about across eight surfaces.
3. **No inline `style="…"` carrying colour, `padding` or `font-size`.** Put it in
   a class. Inline styles are acceptable only for values computed at runtime, and
   then only as a custom property (see section 6).
4. **No new base styling.** Spacing, typography, buttons, inputs, tables, badges
   and dialogs already exist in `src/webview/shared.css`. A surface stylesheet
   contains only what is genuinely specific to that surface.
5. **Every visible action stays visible.** Make a rarely used button *smaller*,
   never hide it behind an overflow menu.
6. **Every user-visible string is English.** Manifest titles and descriptions,
   welcome content, button labels, tooltips, placeholders and messages. The only
   German left in the repository is the historical part of `CHANGELOG.md`, which
   is a record and is not translated.
7. **The same action carries the same label and the same icon everywhere.** If
   two surfaces offer the same command, they say the same word. See section 4.

---

## 2. How a surface is built

There are two kinds of surfaces and both receive the shared stylesheet and the
icon sprite automatically.

**Regular webviews** — build the document with `buildHtmlDocument()` from
[src/webviewUtils.ts](src/webviewUtils.ts):

```ts
import { buildHtmlDocument } from './webviewUtils';
import { icon } from './webviewAssets';

const styles = `.my-surface-only { … }`;           // surface-specific rules only
const body = `<button class="btn btn-primary">${icon('run')}Run</button>`;
const script = `const vscode = acquireVsCodeApi(); …`;
return buildHtmlDocument({ webview, title: 'My Panel', styles, body, script });
```

Passing `webview` is what emits the CSP `<meta>` and the script nonce — **always
pass it.** `includeSharedAssets: false` exists only for a document that must
stand entirely on its own; no current surface uses it.

**The Data Viewer** is assembled from files instead
([src/tableWebView.ts](src/tableWebView.ts), `getWebviewContent`). Its HTML
carries four placeholders that are replaced at runtime:

| Placeholder | Replaced with |
| --- | --- |
| `/* SHARED_CSS_PLACEHOLDER */` | `getSharedStyles()` |
| `/* CSS_PLACEHOLDER */` | `tableView.css` |
| `<!-- ICON_SPRITE_PLACEHOLDER -->` | `getIconSprite()` |
| `/* JS_PLACEHOLDER */` | `tableView.js` |

Always replace with a **function** (`html.replace(p, () => css)`), never a
string — `$&` and `$'` inside the injected SQL/JS would otherwise expand and
corrupt the document.

Assets live in `src/webview/**` and are read from disk at runtime; they are
deliberately not bundled, and `.vscodeignore` keeps them in the package.

---

## 3. Design tokens

Defined in `:root` in [src/webview/shared.css](src/webview/shared.css). Use the
token, not the raw value.

**Spacing** — `--sp-1` 4px · `--sp-2` 8px · `--sp-3` 12px · `--sp-4` 16px ·
`--sp-5` 20px · `--sp-6` 24px.
Literal `0`, `1px`, `2px` and `3px` are fine for hairlines and optical nudges;
anything larger uses the scale.

**Type** — `--fs-xs` 11px (meta, badges, `.btn-sm`) · `--fs-sm` 12px (controls,
tables) · `--fs-md` 13px (body) · `--fs-lg` 15px (headings).

**Shape** — `--radius` 3px (controls) · `--radius-lg` 5px (dialogs, cards).

**Layering** — `--z-sticky` 10 (sticky table headers) · `--z-dropdown` 100
(inline dropdowns, history panel) · `--z-dialog` 1000 (modal overlays) ·
`--z-menu` 2000 (context menus, typeahead — must beat a dialog).

**Colour** — always via these, never via `--vscode-*` directly unless no token
fits:

| Token | Meaning |
| --- | --- |
| `--c-fg` / `--c-bg` | default text / page background |
| `--c-surface` | raised surface (widget, dropdown, table header) |
| `--c-border` | every hairline and control border |
| `--c-muted` | secondary text, hints, meta |
| `--c-accent` | focus and active outline |
| `--c-hover` | hover background of a row or list item |
| `--c-danger` | destructive action, error text |
| `--c-warning` | modified / needs attention |
| `--c-success` | inserted / added |
| `--c-info` | informational / duplicated |
| `--c-code-bg` | inline and block code background |
| `--font-mono` | SQL, identifiers, values |

State tints are mixed from these, never hardcoded:
`background: color-mix(in srgb, var(--c-warning) 12%, transparent);`
(`color-mix` needs Chromium ≥ 111; the engine requirement is VS Code ≥ 1.85, so
it is safe.)

---

## 4. Buttons

Only `.btn` is styled — the bare `button` element deliberately is **not**,
because several surfaces use unstyled buttons as inline cell affordances that
must not inherit toolbar metrics. A button you want to look like a button MUST
carry `.btn`.

| Class | Use |
| --- | --- |
| `.btn` | the default; secondary/neutral action |
| `.btn .btn-primary` | the one action the surface is about (Run, Connect, Save) — at most one per group |
| `.btn .btn-danger` | destructive action; neutral surface with error-coloured text, not a red block |
| `.btn .btn-ghost` | transparent chrome, e.g. a dialog close cross |
| `.btn .btn-icon` | square padding, icon only — the tooltip carries the meaning |
| `.btn .btn-sm` | dense contexts: table rows, condition rows |

These combine: a close cross is `btn btn-ghost btn-icon`, a row delete is
`btn btn-danger btn-sm btn-icon`.

**Labels.** Icon plus a *short* label — `Insert`, `Save`, `Discard`,
`Constraints`, `Export`, `More`, `All`. The full sentence goes in `title`. Never
put a leading `+`, `▶` or `☆` in a label; that is the icon's job. Prefer `…`
over `...`, but a **button label never ends in an ellipsis** — reserve `…` for
status text such as `Counting rows…`.

**Shared labels.** A command offered on more than one surface uses one label and
one icon everywhere, including the tree-view welcome content in `package.json`
and the quick picks in [src/connectionManager.ts](src/connectionManager.ts):

| Command | Label | Icon |
| --- | --- | --- |
| `postgresQueryBuilder.selectConnection` | `Select Connection` | `database` / `$(database)` |
| `postgresQueryBuilder.connect` | `New Connection` | `add` / `$(add)` |
| `postgresQueryBuilder.disconnect` | `Disconnect` | `plug` |
| `postgresQueryBuilder.saveQueryFromEditor` | `Bookmark Query` | `star` / `$(add)` |

**Bookmarked queries.** The feature is named *Bookmarked Queries* in every
user-visible string: the noun is `Bookmarked Query` / `Bookmarked Queries`, the
action is `Bookmark Query`. The identifiers behind it keep the historic
`savedQuery` spelling — command ids, the `postgresSavedQueries` view id, the
`postgresQueryBuilder.savedQueriesFile` setting, the DOM ids in the Data Viewer
and the `postgres-query-builder.saved-queries/v1` file format MUST NOT be
renamed, because they are part of the user's stored state.

A tree-view welcome button is rendered by VS Code from a markdown command link
and cannot carry the SVG sprite, but it does render codicons: write the icon
into the link label as `[$(database) Select Connection](command:…)`.

The classes `btn-default`, `btn-success`, `btn-warning`, `btn-duplicate`,
`button.primary` and `button.secondary` were removed and MUST NOT come back.

---

## 5. Icons

`src/webview/icons.svg` is an inline `<symbol>` sprite, inlined at the top of
`<body>` so `<use href="#icon-…">` resolves in the same document — this is why
no `img-src` or `font-src` relaxation of the strict `default-src 'none'` CSP is
needed.

Reference an icon with the helper, never by hand:

```ts
import { icon } from './webviewAssets';
`<button class="btn">${icon('export')}Export</button>`
```

Inside `tableView.js` there is a local `icon(name)` with identical output.

Drawing a new symbol:

- `viewBox="0 0 16 16"`, geometry only — **no** `fill`, `stroke`, `width` or
  `color` attributes. `.ico` supplies stroke, `currentColor` and 14×14.
- Stroked by default. A shape that must be filled gets `class="f"`.
- Keep to the existing weight: strokes on the half-pixel grid, ~1.3px, round
  caps and joins, content inside roughly `2.5 … 13.5`.
- `id` is `icon-<kebab-case>`.
- **The sprite MUST contain no unused symbol** — a test lists them. Delete an
  icon when its last reference goes away.

---

## 6. Layout building blocks

**Toolbar.** `.toolbar` is the flex row. Related actions go into a
`.toolbar-group`, and groups are separated by `<span class="toolbar-sep">`.
The Data Viewer groups as: row editing · table settings and export · loading
more rows.

**Dialogs.** `.dlg-overlay` > `.dlg` > `.dlg-header` / `.dlg-body` /
`.dlg-footer`. The overlay is hidden until it gets `.open`, dims through the
theme's own scrim, and never uses a black wash. The header ends with a
`btn btn-ghost btn-icon` close cross; the footer holds the primary action first,
then Cancel. Override only `width` on `.dlg`.

**Forms.** `.field` is a labelled row (label column ≥ 180px). `.hint` is
secondary explanatory text. Inputs are styled by padding, never by a fixed
`height`, so a compact filter input can shrink itself.

**Tables.** `table`/`th`/`td` come from the shared sheet. A sticky header sets
`position: sticky; top: 0; z-index: var(--z-sticky);`.

**Runtime values.** Pass them as a custom property, not as a style declaration:

```js
`<input class="filter-input" style="--col-w:${width}ch">`   // ✔
`<input style="width:${width}ch">`                          // ✘
```

**Row states** in the grid use a light `color-mix` wash *plus* a 3px stripe on
the row-number cell (`box-shadow: inset 3px 0 0 …`): warning = modified,
success = inserted, danger = deleted, info = duplicated. State must never rely
on hue alone.

---

## 7. Tree views

TreeViews cannot be styled, so consistency is a matter of icon and label
discipline:

- Grouping node: `folder` (or `symbol-namespace` for a schema). Leaf: an icon
  describing the thing — `table`, `eye`, `layers`, `plug`, `bookmark`.
- Every node gets a `tooltip` saying what it is or where it is stored.
- `description` carries the short secondary detail, never the primary label.

---

## 8. Security

- `buildHtmlDocument({ webview, … })` for every surface — that is what emits
  the CSP and the nonce. There is no reason to hand-write a webview document.
- All interpolated data goes through `escapeHtml` (`WEBVIEW_ESCAPE_HTML_JS`).
- The sprite MUST stay script-free and attribute-handler-free.

---

## 9. Checklist

**Adding a surface**

- [ ] Built via `buildHtmlDocument()` with `webview` passed
- [ ] `styles` contains only surface-specific rules
- [ ] No literal colour, no raw `z-index`, no inline colour/padding/font-size
- [ ] Buttons use `.btn` + modifiers, icon + short label, full text in `title`
- [ ] Exactly one `.btn-primary` per action group
- [ ] Checked in Dark+, Light+ and High Contrast

**Adding an icon**

- [ ] 16×16 `viewBox`, geometry only, `id="icon-…"`
- [ ] Referenced through `icon(name)`
- [ ] Actually used somewhere (unused symbols fail the tests)

**Every change**

- [ ] `npm run compile` and `npm test` green
- [ ] Entry added to `CHANGELOG.md`
