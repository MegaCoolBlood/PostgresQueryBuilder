import * as fs from 'fs';
import * as path from 'path';

/**
 * Read a file from `src/webview`, which ships as plain files next to the
 * bundle. Two layouts have to be supported: the bundled extension lives in
 * `dist/`, the `tsc` build used by the tests in `out/src/`, so the asset
 * directory sits one or two levels above this module.
 */
function readWebviewAsset(name: string): string {
    for (const up of ['..', path.join('..', '..')]) {
        const file = path.join(__dirname, up, 'src', 'webview', name);
        if (fs.existsSync(file)) {
            return fs.readFileSync(file, 'utf8');
        }
    }
    throw new Error(`Webview asset not found: ${name}`);
}

let sharedStyles: string | undefined;
let iconSprite: string | undefined;

/**
 * Design tokens and base styles every webview starts from. Read once and
 * cached; the file never changes while the extension host runs.
 */
export function getSharedStyles(): string {
    if (sharedStyles === undefined) {
        sharedStyles = readWebviewAsset('shared.css');
    }
    return sharedStyles;
}

/**
 * The `<symbol>` sprite backing {@link icon}. Must be present in a document
 * before any `<use>` reference in it can resolve.
 */
export function getIconSprite(): string {
    if (iconSprite === undefined) {
        iconSprite = readWebviewAsset('icons.svg');
    }
    return iconSprite;
}

/**
 * Markup for one icon of the sprite. The icon inherits the surrounding text
 * colour, so it needs no per-theme handling.
 */
export function icon(name: string): string {
    return `<svg class="ico" aria-hidden="true"><use href="#icon-${name}"/></svg>`;
}
