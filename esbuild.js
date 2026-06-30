// Bundles the extension into a single CommonJS file for packaging.
//
// The webview assets in `src/webview/**` are loaded from disk at runtime
// (via `context.extensionPath` / `__dirname/../src/webview`), so they are NOT
// bundled here — they ship as plain files (kept in `.vscodeignore`). Tests keep
// using the plain `tsc` build in `out/` (see the `compile` script).
const esbuild = require('esbuild');

const production = process.argv.includes('--minify');
const watch = process.argv.includes('--watch');

async function main() {
    const ctx = await esbuild.context({
        entryPoints: ['src/extension.ts'],
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node18',
        outfile: 'dist/extension.js',
        // `vscode` is provided by the host. `pg-native` is an optional native
        // driver that pg requires lazily; it is not a dependency of this
        // extension, so keep it external instead of trying to bundle it.
        external: ['vscode', 'pg-native'],
        sourcemap: !production,
        minify: production,
        logLevel: 'info'
    });
    if (watch) {
        await ctx.watch();
    } else {
        await ctx.rebuild();
        await ctx.dispose();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
