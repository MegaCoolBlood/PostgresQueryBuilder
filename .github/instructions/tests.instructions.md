---
description: "Use when writing or fixing tests for the PostgreSQL Query Booster extension — node:test conventions, the vscode stub, testing browser assets in src/webview, and running npm test."
applyTo: "src/test/**/*.ts"
---

# Tests

Runner is the built-in Node test runner. `npm test` runs `tsc -p ./` and then
`node --test out/src/test/**/*.test.js`. There is no Mocha, Jest or Chai — do
not introduce one.

## Shape of a test file

One file per source module, named `<module>.test.ts`, flat `test()` calls (no
`describe`), each with a sentence-style name describing the behaviour:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeSqlLiteral } from '../sqlUtils';

test('escapeSqlLiteral doubles embedded single quotes', () => {
    assert.equal(escapeSqlLiteral("O'Reilly"), "'O''Reilly'");
});
```

Always import `node:assert/strict`; group related tests under a
`// ===== functionName =====` banner comment.

## Modules that import `vscode`

`vscode` does not resolve outside the extension host. Put
`import './helpers/vscodeMock';` on the **first line**, before the module under
test — it installs a stub into the CommonJS module cache. Extend that stub when
a new API is needed instead of writing a second one.

## Browser assets

`src/webview/*.js` is not bundled, so tests load it from source:

```ts
const { buildFilterClause } = require(path.join(__dirname, '../../../src/webview/tableView.js'));
```

That requires the helper to be a top-level pure function exported under the
`typeof module !== 'undefined' && module.exports` guard at the bottom of the file.

## Rules

- Every bug fix gets a test that fails without the fix.
- Tests are deterministic and offline — no live database, no network. Stub the
  connection/query layer.
- Clean up temp files in a `finally` block.
- Assert on observable behaviour, not on internal call order.
- Style and structure guarantees are themselves tests
  (`webviewDesign.test.ts`, `webviewAssets.test.ts`, `uiConsistency.test.ts`,
  `reservedKeywords.test.ts`) — never relax one of these to make a change pass;
  fix the change.
