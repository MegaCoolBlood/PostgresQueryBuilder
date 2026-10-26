import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as esbuild from 'esbuild';

const ROOT = path.join(__dirname, '..', '..', '..');
const { dompurifyFromPackage, DOMPURIFY_ESM, MONACO_ESM } = require(path.join(ROOT, 'esbuild.js'));

/** The files esbuild reads to bundle Monaco's sanitizer, with or without the plugin. */
async function sanitizerInputs(plugins: esbuild.Plugin[]): Promise<string[]> {
    const result = await esbuild.build({
        stdin: { contents: `import { sanitizeHtml } from '${MONACO_ESM}/base/browser/domSanitize.js'; console.log(sanitizeHtml);`, resolveDir: ROOT },
        bundle: true,
        write: false,
        metafile: true,
        format: 'esm',
        logLevel: 'silent',
        plugins
    });
    return Object.keys(result.metafile!.inputs).map((input) => input.replace(/\\/g, '/'));
}

const isMonacoCopy = (input: string) => input.endsWith('monaco-editor/esm/vs/base/browser/dompurify/dompurify.js');
const isPackage = (input: string) => input.endsWith('node_modules/dompurify/dist/purify.es.mjs');

test('the Monaco bundle takes DOMPurify from the dompurify package instead of Monaco\'s own copy', async () => {
    const inputs = await sanitizerInputs([dompurifyFromPackage]);
    assert.ok(inputs.some(isPackage), 'the dompurify package is bundled');
    assert.equal(inputs.some(isMonacoCopy), false, 'Monaco\'s own copy is left out');

    // Without the plugin Monaco's own copy would be the one shipped.
    const plain = await sanitizerInputs([]);
    assert.ok(plain.some(isMonacoCopy));
});

test('the bundled DOMPurify has none of the published sanitizer bypasses (fixed in 3.4.17)', () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(path.dirname(DOMPURIFY_ESM), '..', 'package.json'), 'utf8'));
    const [major, minor, patch] = String(version).split('.').map((part) => parseInt(part, 10));
    const atLeast = major > 3 || (major === 3 && (minor > 4 || (minor === 4 && patch >= 17)));
    assert.ok(atLeast, `dompurify ${version} is installed; the "overrides" entry in package.json has to keep it at 3.4.17 or newer`);
    assert.match(fs.readFileSync(DOMPURIFY_ESM, 'utf8'), new RegExp(`^/\\*! @license DOMPurify ${version.replace(/\./g, '\\.')} `));
});
