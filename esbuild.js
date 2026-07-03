// Bundles the extension, language server, and CLI into CommonJS files.
//
// The webview assets in `src/webview/**` are loaded from disk at runtime
// (via `context.extensionPath` / `__dirname/../src/webview`), so they are NOT
// bundled here — they ship as plain files (kept in `.vscodeignore`). Tests keep
// using the plain `tsc` build in `out/` (see the `compile` script).
const esbuild = require('esbuild');

const production = process.argv.includes('--minify');
const watch = process.argv.includes('--watch');

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
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
