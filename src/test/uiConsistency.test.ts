import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src');

/**
 * German is the language this extension was started in. Every string the user
 * can read has to be English, so these markers must not appear anywhere in the
 * shipped manifest or in a surface.
 */
const UMLAUT = /[äöüÄÖÜß]/g;
const GERMAN_WORD = /\b(und|oder|nicht|eine|einen|einer|einem|wird|werden|wenn|kann|muss|keine|neue|dazwischen|mit|für|bei|nur|auch|Verbindung|Spalten|Zeile|einzeilig|mehrzeilig)\b/g;

function germanMarkers(text: string): string[] {
    return [...(text.match(UMLAUT) || []), ...(text.match(GERMAN_WORD) || [])];
}

/** Keys of the manifest whose values end up in front of the user. */
const USER_VISIBLE_KEYS = new Set([
    'title',
    'description',
    'markdownDescription',
    'markdownDeprecationMessage',
    'deprecationMessage',
    'contents',
    'label',
    'category',
    'placeHolder',
    'name',
    'contextualTitle'
]);

function collectUserVisibleStrings(node: unknown, trail: string[], out: Array<[string, string]>): void {
    if (Array.isArray(node)) {
        node.forEach((item, i) => collectUserVisibleStrings(item, [...trail, String(i)], out));
        return;
    }
    if (node === null || typeof node !== 'object') { return; }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        const here = [...trail, key];
        if (typeof value === 'string') {
            if (USER_VISIBLE_KEYS.has(key)) { out.push([here.join('.'), value]); }
        } else if (key === 'enumDescriptions' || key === 'markdownEnumDescriptions') {
            (value as string[]).forEach((s, i) => out.push([`${here.join('.')}.${i}`, s]));
        } else {
            collectUserVisibleStrings(value, here, out);
        }
    }
}

function listSourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'test') { continue; }
            listSourceFiles(full, out);
        } else if (/\.(ts|js|html|css)$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('every user visible string in the manifest is English', () => {
    const strings: Array<[string, string]> = [];
    collectUserVisibleStrings(manifest.contributes, ['contributes'], strings);
    assert.ok(strings.length > 50, 'the manifest scan found suspiciously few strings');
    for (const [where, value] of strings) {
        assert.deepEqual(germanMarkers(value), [], `${where} is not English: ${value}`);
    }
});

test('no source file outside the tests contains German text', () => {
    for (const file of listSourceFiles(SRC)) {
        const content = fs.readFileSync(file, 'utf8');
        assert.deepEqual(
            germanMarkers(content),
            [],
            `${path.relative(ROOT, file)} contains German text`
        );
    }
});

/**
 * The same action has to carry the same label everywhere it is offered, so that
 * the tree view welcome content and the search sidebar do not look like two
 * different extensions.
 */
const CONNECTION_ACTIONS = [
    { command: 'postgresQueryBuilder.selectConnection', label: 'Select Connection', codicon: 'database' },
    { command: 'postgresQueryBuilder.connect', label: 'New Connection', codicon: 'add' }
];

test('the table explorer welcome content offers the connection actions with the shared labels and icons', () => {
    const welcome = manifest.contributes.viewsWelcome.find(
        (w: { view: string }) => w.view === 'postgresTableExplorer'
    );
    assert.ok(welcome, 'the table explorer has no welcome content');
    for (const action of CONNECTION_ACTIONS) {
        assert.ok(
            welcome.contents.includes(`[$(${action.codicon}) ${action.label}](command:${action.command})`),
            `the welcome content does not offer "${action.label}" with the $(${action.codicon}) icon`
        );
    }
});

test('the search sidebar offers the connection actions with the same labels and icons', () => {
    const source = fs.readFileSync(path.join(SRC, 'searchViewProvider.ts'), 'utf8');
    for (const action of CONNECTION_ACTIONS) {
        assert.ok(
            source.includes(`${'${'}icon('${action.codicon}')}${action.label}<`),
            `the sidebar button for "${action.label}" changed`
        );
    }
    assert.ok(source.includes(`${'${'}icon('plug')}Disconnect<`), 'the disconnect button changed');
});

test('the select connection action carries one single label on every surface', () => {
    const surfaces = [
        path.join(SRC, 'searchViewProvider.ts'),
        path.join(SRC, 'webview', 'tableView.js')
    ];
    for (const file of surfaces) {
        const content = fs.readFileSync(file, 'utf8');
        assert.ok(content.includes('Select Connection'), `${path.basename(file)} lost the shared label`);
        assert.ok(
            !/Select connection/.test(content),
            `${path.basename(file)} still uses a differently written label`
        );
    }
});

test('no button label ends in an ellipsis; the tree view welcome cannot render one', () => {
    const files = [
        path.join(SRC, 'searchViewProvider.ts'),
        path.join(SRC, 'manageMappingsPanel.ts'),
        path.join(SRC, 'modifyHistoryViewProvider.ts'),
        path.join(SRC, 'sqlEditor.ts'),
        path.join(SRC, 'viewDataFromSelect.ts'),
        path.join(SRC, 'joinDialog.ts')
    ];
    for (const file of files) {
        const content = fs.readFileSync(file, 'utf8');
        const labels = content.match(/…\s*<\/button>/g) || [];
        assert.deepEqual(labels, [], `${path.basename(file)} has a button label ending in an ellipsis`);
    }
});
