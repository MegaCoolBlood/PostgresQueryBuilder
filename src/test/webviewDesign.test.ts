import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getIconSprite, getSharedStyles } from '../webviewAssets';

const ROOT = path.join(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src');
const WEBVIEW = path.join(SRC, 'webview');

/** Files that carry the styling of a webview surface. */
const STYLE_OWNERS = [
    'joinDialog.ts',
    'manageMappingsPanel.ts',
    'sqlEditor.ts',
    'modifyHistoryViewProvider.ts',
    'searchViewProvider.ts',
    'viewDataFromSelect.ts',
    'connectionManager.ts'
];

/** Literal colours. Everything must come from a --vscode- or --c- variable instead. */
const LITERAL_COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/g;

/** Extracts the contents of every `const styles = \`...\`;` block of a TS webview. */
function extractStyleBlocks(source: string): string[] {
    const blocks: string[] = [];
    const re = /const styles = `([\s\S]*?)`;/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
        blocks.push(m[1]);
    }
    return blocks;
}

test('shared.css defines no literal colour', () => {
    assert.deepEqual(getSharedStyles().match(LITERAL_COLOUR), null);
});

test('tableView.css defines no literal colour', () => {
    const css = fs.readFileSync(path.join(WEBVIEW, 'tableView.css'), 'utf8');
    assert.deepEqual(css.match(LITERAL_COLOUR), null);
});

test('every webview stylesheet in TypeScript defines no literal colour', () => {
    for (const file of STYLE_OWNERS) {
        const source = fs.readFileSync(path.join(SRC, file), 'utf8');
        const blocks = extractStyleBlocks(source);
        assert.ok(blocks.length > 0, `${file} no longer contains a styles block`);
        for (const block of blocks) {
            assert.deepEqual(block.match(LITERAL_COLOUR), null, `${file} contains a literal colour`);
        }
    }
});

test('no webview stylesheet uses a raw z-index; the shared tokens define the stacking order', () => {
    const sheets = [getSharedStyles(), fs.readFileSync(path.join(WEBVIEW, 'tableView.css'), 'utf8')];
    for (const file of STYLE_OWNERS) {
        sheets.push(...extractStyleBlocks(fs.readFileSync(path.join(SRC, file), 'utf8')));
    }
    for (const sheet of sheets) {
        assert.deepEqual(sheet.match(/z-index:\s*-?\d/g), null);
    }
});

test('the data viewer markup and script reference no colour or spacing via inline style', () => {
    const files = ['tableView.html', 'tableView.js'].map(f => fs.readFileSync(path.join(WEBVIEW, f), 'utf8'));
    for (const content of files) {
        const inline = content.match(/style="[^"]*"/g) || [];
        for (const decl of inline) {
            assert.deepEqual(decl.match(LITERAL_COLOUR), null, `inline colour in ${decl}`);
            assert.equal(/\bpadding\s*:/.test(decl), false, `inline padding in ${decl}`);
            assert.equal(/\bfont-size\s*:/.test(decl), false, `inline font-size in ${decl}`);
        }
    }
});

test('the data viewer no longer uses the old ad-hoc button classes', () => {
    const files = ['tableView.html', 'tableView.js', 'tableView.css'];
    for (const file of files) {
        const content = fs.readFileSync(path.join(WEBVIEW, file), 'utf8');
        for (const legacy of ['btn-default', 'btn-success', 'btn-warning', 'btn-duplicate']) {
            assert.equal(content.includes(legacy), false, `${file} still uses ${legacy}`);
        }
    }
});

test('every referenced icon exists in the sprite', () => {
    const sprite = getIconSprite();
    const available = new Set((sprite.match(/id="icon-([a-z0-9-]+)"/g) || [])
        .map(m => m.replace(/^id="/, '').replace(/"$/, '')));

    const sources: string[] = [
        fs.readFileSync(path.join(WEBVIEW, 'tableView.html'), 'utf8'),
        fs.readFileSync(path.join(WEBVIEW, 'tableView.js'), 'utf8')
    ];
    for (const file of [...STYLE_OWNERS, 'tableWebView.ts']) {
        sources.push(fs.readFileSync(path.join(SRC, file), 'utf8'));
    }

    let referenced = 0;
    for (const source of sources) {
        for (const ref of source.match(/#icon-[a-z0-9-]+/g) || []) {
            referenced++;
            assert.ok(available.has(ref.slice(1)), `sprite has no ${ref}`);
        }
        for (const call of source.match(/\bicon\('([a-z0-9-]+)'\)/g) || []) {
            const name = call.replace(/^icon\('/, '').replace(/'\)$/, '');
            referenced++;
            assert.ok(available.has('icon-' + name), `sprite has no icon-${name}`);
        }
    }
    assert.ok(referenced > 20, 'expected the surfaces to reference icons');
});

test('the sprite contains no unused symbol', () => {
    const sprite = getIconSprite();
    const available = (sprite.match(/id="icon-([a-z0-9-]+)"/g) || [])
        .map(m => m.replace(/^id="icon-/, '').replace(/"$/, ''));

    let all = '';
    for (const file of ['tableView.html', 'tableView.js']) {
        all += fs.readFileSync(path.join(WEBVIEW, file), 'utf8');
    }
    for (const file of [...STYLE_OWNERS, 'tableWebView.ts']) {
        all += fs.readFileSync(path.join(SRC, file), 'utf8');
    }

    const unused = available.filter(name => !all.includes(`#icon-${name}`) && !all.includes(`icon('${name}')`));
    assert.deepEqual(unused, [], `unused sprite symbols: ${unused.join(', ')}`);
});

// ===== The loading overlay must never swallow the filter row =====

const VIEW_HTML = fs.readFileSync(path.join(WEBVIEW, 'tableView.html'), 'utf8');
const VIEW_CSS = fs.readFileSync(path.join(WEBVIEW, 'tableView.css'), 'utf8');
const VIEW_JS = fs.readFileSync(path.join(WEBVIEW, 'tableView.js'), 'utf8');

test('the loading overlay sits next to the scrolling table inside one positioned area', () => {
    const area = VIEW_HTML.match(/<div class="table-area">([\s\S]*?)<\/div>\s*<div class="status-bar"/);
    assert.ok(area, 'the table is no longer wrapped in a positioned .table-area');
    assert.ok(area[1].includes('id="tableWrapper"'), 'the scrolling table left the .table-area');
    assert.ok(area[1].includes('id="dataLoadingOverlay"'), 'the overlay left the .table-area');
    assert.match(VIEW_CSS, /\.table-area\s*\{[^}]*position:\s*relative/);
});

test('the overlay starts below the pinned header so the filters stay reachable', () => {
    const rule = VIEW_CSS.match(/\.data-loading-overlay\s*\{([^}]*)\}/);
    assert.ok(rule, 'tableView.css has no .data-loading-overlay rule');
    assert.match(rule[1], /position:\s*absolute/);
    assert.match(rule[1], /top:\s*var\(--data-overlay-top/);
    assert.match(rule[1], /display:\s*none/);
    assert.match(VIEW_CSS, /\.data-loading-overlay\.visible\s*\{\s*display:\s*flex/);
    assert.ok(
        VIEW_JS.includes("dataLoadingOverlay.style.setProperty('--data-overlay-top'"),
        'the offset is no longer measured from the header'
    );
});

test('the overlay spinner is bigger than the inline one', () => {
    const small = VIEW_CSS.match(/\.spinner\s*\{([^}]*)\}/);
    const large = VIEW_CSS.match(/\.spinner-lg\s*\{([^}]*)\}/);
    assert.ok(small && large, 'tableView.css lost one of the spinner rules');
    const px = (block: string, prop: string) => Number((block.match(new RegExp(prop + ':\\s*(\\d+)px')) || [])[1]);
    assert.ok(px(large[1], 'width') > px(small[1], 'width'), 'the overlay spinner is not larger');
    assert.ok(px(large[1], 'border-width') > 2, 'the overlay spinner is not thicker');
    assert.ok(VIEW_HTML.includes('<span class="spinner spinner-lg"></span>'));
});

test('every load path goes through the shared loading switch', () => {
    assert.equal(
        /dataLoading\.classList\.(add|remove)\(/.test(VIEW_JS),
        false,
        'a load path still toggles the small indicator on its own, so the overlay would stay behind'
    );
    assert.ok((VIEW_JS.match(/setDataLoading\(true\)/g) || []).length >= 3);
    assert.ok((VIEW_JS.match(/setDataLoading\(false\)/g) || []).length >= 3);
});

// ===== The style guide must keep describing the code it documents =====

const STYLEGUIDE = fs.readFileSync(path.join(ROOT, 'STYLEGUIDE.md'), 'utf8');

test('the style guide documents every design token', () => {
    const defined = (getSharedStyles().match(/^\s{4}(--[a-z0-9-]+):/gm) || [])
        .map(m => m.trim().replace(/:$/, ''));
    assert.ok(defined.length >= 20, 'expected shared.css to define the token block');
    const undocumented = defined.filter(token => !STYLEGUIDE.includes(token));
    assert.deepEqual(undocumented, [], `tokens missing from STYLEGUIDE.md: ${undocumented.join(', ')}`);
});

test('the style guide describes no token that no longer exists', () => {
    const css = getSharedStyles();
    const mentioned = [...new Set(STYLEGUIDE.match(/--(?:sp|fs|c|z|radius|font)-[a-z0-9-]+/g) || [])];
    assert.ok(mentioned.length >= 20, 'expected the guide to list the tokens');
    const stale = mentioned.filter(token => !css.includes(token + ':'));
    assert.deepEqual(stale, [], `tokens documented but not defined: ${stale.join(', ')}`);
});

test('the style guide describes every button modifier that exists', () => {
    const modifiers = [...new Set((getSharedStyles().match(/^\.btn[a-z-]*/gm) || []))];
    const undocumented = modifiers.filter(cls => !STYLEGUIDE.includes(cls));
    assert.deepEqual(undocumented, [], `button classes missing from STYLEGUIDE.md: ${undocumented.join(', ')}`);
});

test('the placeholders named by the style guide exist in the data viewer template', () => {
    const html = fs.readFileSync(path.join(WEBVIEW, 'tableView.html'), 'utf8');
    for (const placeholder of [
        '/* SHARED_CSS_PLACEHOLDER */',
        '/* CSS_PLACEHOLDER */',
        '/* JS_PLACEHOLDER */',
        '<!-- ICON_SPRITE_PLACEHOLDER -->'
    ]) {
        assert.ok(STYLEGUIDE.includes(placeholder), `${placeholder} is not documented`);
        assert.ok(html.includes(placeholder), `${placeholder} is documented but absent from tableView.html`);
    }
});
