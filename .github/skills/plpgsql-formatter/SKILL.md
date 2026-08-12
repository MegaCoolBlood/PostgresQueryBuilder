---
name: plpgsql-formatter
description: "Work on the SQL / PL/pgSQL formatter in src/plpgsqlFormatter.ts — changing indentation, line breaking, keyword casing, list thresholds, tokenization or the semantic safety net; investigating why a file is left unformatted or 'formatting skipped'; adding formatter settings or .pgformat.json keys."
argument-hint: "What the formatter should do differently"
---

# PL/pgSQL formatter

`src/plpgsqlFormatter.ts` (~2500 lines) is the whole formatter: tokenizer,
renderer, options and safety net. It has no dependency on `vscode`, which is why
it is also used by the CLI and the language server.

## Consumers

| Caller | Path |
| --- | --- |
| Format command, `DocumentFormattingEditProvider`, `DocumentRangeFormattingEditProvider`, format-on-save | [src/extension.ts](../../../src/extension.ts) (lines ~239, ~331, ~362) |
| Standalone `pgformat` CLI | [cli/format-cli.ts](../../../cli/format-cli.ts) |
| Language server | [server/language-server.ts](../../../server/language-server.ts) |
| Settings resolution (VS Code settings + `.pgformat.json`) | [src/formatConfig.ts](../../../src/formatConfig.ts), [src/repoFormatConfig.ts](../../../src/repoFormatConfig.ts) |

Every caller uses `formatSqlChecked()` and must handle `ok: false` by leaving
the document untouched and surfacing `reason`. Never swap one back to
`formatSql()`.

## Architecture

```
formatSql(input, options)
└── formatSqlChecked(input, options) : { text, ok, reason? }
    ├── normalise CRLF → LF
    ├── formatSqlOnce(...) repeatedly (max 10) until the output stabilises
    ├── signatureDiff(source, result) — the safety net
    └── restore CRLF
```

`formatSqlOnce` (line ~938) has two phases:

1. **Pre-pass** over the token array, filling decision sets and maps
   (`condInlineSet`, `joinOnBreakSet`, `parenInfo`, `bracketInfo`, `andDeepSet`, …).
   All "will this construct wrap?" decisions are made here.
2. **Render loop** (`for i` over the tokens) emitting lines through
   `emit()` / `startLine()` / `flush()`.

Indentation is stored as **levels** (integers) in `lineIndent` / `pendingIndent`;
`indentStr(level)` expands them. For sub-level alignment, prepend literal spaces
to the emitted text — leading spaces survive `flush()`, only trailing ones are
stripped.

Wrapping is driven by `wantsMultiline(count, srcMulti, key)` against
`DEFAULT_THRESHOLDS` (line ~66), keyed by the `ConstructKey` union (line ~36).
`srcMulti` means "the author wrote it across several lines".

## The safety net — do not weaken it

`semanticTokens()` (line ~385) builds a whitespace-independent signature of the
token stream: word tokens are lower-cased, comments have their whitespace
collapsed, everything else is compared verbatim, and dollar-quoted bodies are
recursed into. `signatureDiff()` (line ~429) returns the first divergence.

If the signature changes, `formatSqlChecked` returns the **original input**. A
formatter bug can therefore leave code unformatted, but never corrupt it. When a
change makes files "skip" formatting, the bug is almost always in the renderer —
fix the renderer, do not relax the comparison.

## Known traps

- **Literals are byte-exact.** Any pass that rewrites lines must skip positions
  inside string, dollar-quoted and quoted-identifier literals — use
  `literalMask()` (line ~814) / `stripTrailingWhitespacePreservingLiterals()`
  (line ~918). Re-indenting a dollar body must skip continuation lines that
  start inside a literal.
- **CRLF.** The renderer joins with `\n`; CRLF is normalised on the way in and
  restored on the way out. Never compare signatures on un-normalised input.
- **`format()` specifiers.** `%L`, `%I`, `%s` are tokenized as one operator in
  `tokenize()` (line ~560) so a space is never inserted. `%TYPE` / `%ROWTYPE`
  and modulo are handled separately.
- **Dollar-quoted bodies.** `dollarBodyIsCode()` (line ~517) decides whether a
  body is reformatted: `begin`/`declare` present, or the body is multi-line and
  starts with a statement keyword. Single-line bodies stay inline on purpose —
  three tests depend on it.
- **Thresholds clamp at 1**, not 2, so `"0, 1"` really means "always wrap".

## Procedure

1. Reproduce first: write the failing SQL into a test in
   [src/test/plpgsqlFormatter.test.ts](../../../src/test/plpgsqlFormatter.test.ts)
   and confirm it fails.
2. Decide which phase owns the change — a wrapping decision belongs in the
   pre-pass, spacing and indentation in the render loop, character handling in
   `tokenize()`.
3. Make the change as narrow as possible: gate it on the construct kind, on
   `srcMulti`, or on a threshold, so unrelated shapes keep their output.
4. Assert **idempotency** in the test: formatting the output again must produce
   the same text.
5. Run `npm test`. The formatter tests are the largest group in the suite; a
   regression elsewhere in that file means the change was too broad.
6. Rebuild before trying it in the editor: `npm test` only refreshes `out/`,
   while the installed extension runs the bundled `dist/extension.js`
   (`npm run package`, then reload the window).

## Adding an option

1. Add the field to `FormatOptions` and a default to `DEFAULT_FORMAT_OPTIONS`.
2. Accept and clamp it in `coerceFormatOptions()` (line ~184).
3. Register `postgresQueryBuilder.format.<name>` under
   `contributes.configuration` in `package.json`, with an **English**
   description, and read it in `resolveFormatOptions()`.
4. The `.pgformat.json` key is the setting name without the
   `postgresQueryBuilder.format.` prefix — repo values win over user settings.
5. Cover both the default and the non-default behaviour with tests.

## Debugging a rejected file

`formatSqlChecked` returns the reason, but the displayed token text collapses
whitespace, so two "identical" tokens can still differ. To diff at token level,
build with `npx tsc -p ./`, copy `out/src/plpgsqlFormatter.js`, append
`exports.__semanticTokens = semanticTokens;` and compare the arrays of input and
output directly.
