// Bundles the extension, language server, and CLI into CommonJS files.
//
// The webview assets in `src/webview/**` are loaded from disk at runtime
// (via `context.extensionPath` / `__dirname/../src/webview`), so they are NOT
// bundled here — they ship as plain files (kept in `.vscodeignore`). Tests keep
// using the plain `tsc` build in `out/` (see the `compile` script).
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--minify');
const watch = process.argv.includes('--watch');
const sea = process.argv.includes('--sea');

// The SQL editor of the Data Viewer is Monaco, the editor VS Code is built on.
// It is bundled once into dist/monaco/ (script, stylesheet, codicon font and the
// editor worker) and loaded by the webview at runtime. Only the editor core and
// the PostgreSQL grammar are included — none of Monaco's other languages.
const MONACO_OUT = path.join(__dirname, 'dist', 'monaco');
const MONACO_DIR = path.join(__dirname, 'node_modules', 'monaco-editor');
// Monaco's package "exports" hide the deep ESM paths, so they are imported by file.
const MONACO_ESM = path.join(MONACO_DIR, 'esm', 'vs').replace(/\\/g, '/');
// Everything editor.main pulls in, minus the diff editor, language services of
// other languages, GPU rendering and touch-device helpers.
const MONACO_CONTRIBS = [
    'anchorSelect/browser/anchorSelect', 'bracketMatching/browser/bracketMatching',
    'caretOperations/browser/transpose', 'caretOperations/browser/caretOperations',
    'clipboard/browser/clipboard', 'codeAction/browser/codeActionContributions',
    'comment/browser/comment', 'contextmenu/browser/contextmenu', 'cursorUndo/browser/cursorUndo',
    'dnd/browser/dnd', 'dropOrPasteInto/browser/copyPasteContribution',
    'dropOrPasteInto/browser/dropIntoEditorContribution', 'find/browser/findController',
    'folding/browser/folding', 'fontZoom/browser/fontZoom', 'format/browser/formatActions',
    'hover/browser/hoverContribution', 'indentation/browser/indentation',
    'inPlaceReplace/browser/inPlaceReplace', 'lineSelection/browser/lineSelection',
    'linesOperations/browser/linesOperations', 'linkedEditing/browser/linkedEditing',
    'longLinesHelper/browser/longLinesHelper', 'multicursor/browser/multicursor',
    'parameterHints/browser/parameterHints', 'placeholderText/browser/placeholderText.contribution',
    'readOnlyMessage/browser/contribution', 'smartSelect/browser/smartSelect',
    'snippet/browser/snippetController2', 'suggest/browser/suggestController',
    'suggest/browser/suggestInlineCompletions', 'tokenization/browser/tokenization',
    'unicodeHighlighter/browser/unicodeHighlighter', 'wordHighlighter/browser/wordHighlighter',
    'wordOperations/browser/wordOperations', 'wordPartOperations/browser/wordPartOperations'
];
const MONACO_ENTRY = [
    `export * from '${MONACO_ESM}/editor/editor.api.js';`,
    `import '${MONACO_ESM}/editor/browser/coreCommands.js';`,
    `import '${MONACO_ESM}/editor/browser/widget/codeEditor/codeEditorWidget.js';`,
    `import '${MONACO_ESM}/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js';`,
    `import '${MONACO_ESM}/editor/standalone/browser/quickAccess/standaloneHelpQuickAccess.js';`,
    `import '${MONACO_ESM}/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js';`,
    `import '${MONACO_ESM}/editor/common/standaloneStrings.js';`,
    `import '${MONACO_ESM}/base/browser/ui/codicons/codicon/codicon.css';`,
    `import '${MONACO_ESM}/base/browser/ui/codicons/codicon/codicon-modifiers.css';`,
    ...MONACO_CONTRIBS.map(c => `import '${MONACO_ESM}/editor/contrib/${c}.js';`),
    `import '${MONACO_ESM}/languages/definitions/pgsql/register.js';`,
    // The keyword and built-in function lists of the grammar feed the autocomplete
    // (and, through dist/monaco/pgsql-words.json, the one of SQL files).
    `export { language as pgsqlLanguage } from '${MONACO_ESM}/languages/definitions/pgsql/pgsql.js';`
].join('\n');

/** Build dist/monaco/ unless it is newer than the installed Monaco and this script. */
async function buildMonaco() {
    const monacoPkg = path.join(MONACO_DIR, 'package.json');
    if (!fs.existsSync(monacoPkg)) {
        console.warn('[monaco] monaco-editor is not installed; the Data Viewer falls back to a plain text box.');
        return;
    }
    const marker = path.join(MONACO_OUT, 'monaco.js');
    if (fs.existsSync(marker)) {
        const built = fs.statSync(marker).mtimeMs;
        if (built > fs.statSync(monacoPkg).mtimeMs && built > fs.statSync(__filename).mtimeMs) {
            return;
        }
    }
    const vendor = { bundle: true, minify: true, sourcemap: false, target: 'chrome110', logLevel: 'warning' };
    await esbuild.build({
        ...vendor,
        stdin: { contents: MONACO_ENTRY, resolveDir: __dirname, sourcefile: 'monaco-entry.js' },
        format: 'iife',
        globalName: 'monaco',
        outfile: marker,
        loader: { '.ttf': 'file' },
        assetNames: '[name]'
    });
    await esbuild.build({
        ...vendor,
        entryPoints: [`${MONACO_ESM}/editor/editor.worker.js`],
        format: 'iife',
        outfile: path.join(MONACO_OUT, 'editor.worker.js')
    });
    console.log('[monaco] built dist/monaco/');
}

/**
 * Write the keyword and built-in function lists of Monaco's PostgreSQL grammar
 * to dist/monaco/pgsql-words.json. The autocomplete of SQL files runs in the
 * extension host, which cannot load the Monaco bundle, and reads them from
 * there — so it offers the same words as the query bar of the Data Viewer.
 */
async function buildPgsqlWords() {
    const grammarFile = `${MONACO_ESM}/languages/definitions/pgsql/pgsql.js`;
    if (!fs.existsSync(grammarFile)) {
        return;
    }
    // Built in memory only; the named output makes outputFiles hold exactly this file.
    const outfile = path.join(MONACO_OUT, 'pgsql-grammar.cjs');
    const result = await esbuild.build({
        entryPoints: [grammarFile], bundle: true, format: 'cjs', platform: 'node',
        write: false, outfile, logLevel: 'warning'
    });
    const output = (result.outputFiles || []).find((f) => f.path === outfile);
    if (!output) {
        throw new Error('[monaco] bundling the PostgreSQL grammar produced no output');
    }
    const mod = { exports: {} };
    new Function('module', 'exports', output.text)(mod, mod.exports);
    const { language } = mod.exports;
    if (!language) {
        throw new Error('[monaco] the PostgreSQL grammar exports no `language`');
    }
    const json = JSON.stringify({
        keywords: language.keywords || [],
        operators: language.operators || [],
        builtinFunctions: language.builtinFunctions || []
    });
    const out = path.join(MONACO_OUT, 'pgsql-words.json');
    if (fs.existsSync(out) && fs.readFileSync(out, 'utf8') === json) {
        return;
    }
    fs.mkdirSync(MONACO_OUT, { recursive: true });
    fs.writeFileSync(out, json);
    console.log('[monaco] wrote dist/monaco/pgsql-words.json');
}

const commonOptions = {
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    // `vscode` is provided by the host. `pg-native` is an optional native
    // driver that pg requires lazily; it is not a dependency of this
    // extension, so keep it external instead of trying to bundle it.
    external: ['vscode', 'pg-native'],
    sourcemap: !production,
    minify: production,
    logLevel: 'info'
};

async function main() {
    await buildMonaco();
    await buildPgsqlWords();

    const entries = [
        { entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' },
        { entryPoints: ['server/language-server.ts'], outfile: 'dist/server.js' },
        { entryPoints: ['cli/format-cli.ts'], outfile: 'dist/cli.js' },
    ];

    if (watch) {
        // In watch mode, create one context with all entry points
        const ctx = await esbuild.context({
            ...commonOptions,
            entryPoints: entries.flatMap(e => e.entryPoints),
            outdir: 'dist'
        });
        await ctx.watch();
    } else {
        // In build mode, rebuild each entry point
        for (const entry of entries) {
            const ctx = await esbuild.context({
                ...commonOptions,
                ...entry
            });
            await ctx.rebuild();
            await ctx.dispose();
        }
        if (sea) {
            buildSea();
        }
    }
}

/**
 * Turn dist/cli.js into the standalone dist/pgformat.exe (see sea-config.json),
 * a Node single executable for the platform of the running Node.js. The
 * executable is started via process.execPath because `--build-sea` locates the
 * Node binary from argv[0], which is a bare `node` when run through npm.
 */
function buildSea() {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 25 || (major === 25 && minor < 5)) {
        throw new Error(`[sea] building dist/pgformat.exe needs Node.js 25.5 or newer (running ${process.versions.node})`);
    }
    require('child_process').execFileSync(process.execPath, ['--build-sea', 'sea-config.json'], {
        cwd: __dirname,
        stdio: 'inherit'
    });
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
