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
