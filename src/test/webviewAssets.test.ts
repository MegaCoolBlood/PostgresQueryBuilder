import test from 'node:test';
import assert from 'node:assert/strict';
import { getIconSprite, getSharedStyles, icon } from '../webviewAssets';

test('getSharedStyles exposes the design tokens', () => {
    const css = getSharedStyles();
    assert.ok(css.includes(':root'));
    for (const token of [
        '--sp-1', '--sp-6', '--fs-xs', '--fs-lg', '--radius',
        '--z-sticky', '--z-dropdown', '--z-dialog', '--z-menu',
        '--c-fg', '--c-bg', '--c-surface', '--c-border', '--c-muted',
        '--c-accent', '--c-hover', '--c-danger', '--c-warning',
        '--c-success', '--c-info', '--c-code-bg', '--font-mono'
    ]) {
        assert.ok(css.includes(token + ':'), `token ${token} is missing from shared.css`);
    }
});

test('getSharedStyles provides the shared button and dialog primitives', () => {
    const css = getSharedStyles();
    for (const cls of ['.btn', '.btn-primary', '.btn-danger', '.btn-ghost', '.btn-icon', '.btn-sm',
        '.toolbar', '.toolbar-group', '.toolbar-sep', '.badge',
        '.dlg-overlay', '.dlg', '.dlg-header', '.dlg-body', '.dlg-footer', '.field', '.hint', '.mono']) {
        assert.ok(css.includes(cls + ' ') || css.includes(cls + ','), `class ${cls} is missing from shared.css`);
    }
});

test('getSharedStyles never styles bare buttons, so inline affordances keep their size', () => {
    const css = getSharedStyles();
    assert.equal(/^\s*button\s*[,{]/m.test(css), false);
});

test('getSharedStyles is cached and returns the identical string', () => {
    assert.equal(getSharedStyles(), getSharedStyles());
});

test('getIconSprite returns a hidden inline sprite with symbols', () => {
    const sprite = getIconSprite();
    assert.ok(sprite.includes('class="icon-sprite"'));
    assert.ok(sprite.includes('<symbol'));
    assert.ok(sprite.trimEnd().endsWith('</svg>'));
});

test('getIconSprite is cached and returns the identical string', () => {
    assert.equal(getIconSprite(), getIconSprite());
});

test('the icon sprite carries no script', () => {
    assert.equal(getIconSprite().includes('<script'), false);
    assert.equal(/on[a-z]+=/.test(getIconSprite()), false);
});

test('every sprite symbol uses the same 16x16 viewBox', () => {
    const symbols = getIconSprite().match(/<symbol[^>]*>/g) || [];
    assert.ok(symbols.length >= 20);
    for (const s of symbols) {
        assert.match(s, /viewBox="0 0 16 16"/);
        assert.match(s, /id="icon-[a-z0-9-]+"/);
    }
});

test('icon() renders a decorative reference into the sprite', () => {
    assert.equal(icon('run'), '<svg class="ico" aria-hidden="true"><use href="#icon-run"/></svg>');
});

test('icon() output contains no single quotes, so it can be embedded in generated JS strings', () => {
    assert.equal(icon('close').includes("'"), false);
});
