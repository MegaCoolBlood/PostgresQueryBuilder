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

// vsce rewrites the relative links of README.md against the repository URL and
// refuses to package while it cannot find one.
test('the manifest names the repository the README links are resolved against', () => {
    assert.ok(manifest.repository, 'package.json has no repository');
    assert.match(manifest.repository.url, /^https:\/\/.+\.git$/, 'the repository URL must be an https clone URL');
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const relativeLinks = readme.match(/\]\((?!https?:|#)[^)]+\)/g) || [];
    for (const link of relativeLinks) {
        const target = link.slice(2, -1).split('#')[0];
        assert.ok(fs.existsSync(path.join(ROOT, target)), `README.md links to the missing file ${target}`);
    }
});

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
 * The same action has to carry the same label everywhere it is offered, and
 * connecting is offered in the Tables view only: its title bar and its welcome
 * content. Any other sidebar repeating it would blur what that sidebar is for.
 */
const CONNECTION_ACTIONS = [
    { command: 'postgresQueryBuilder.selectConnection', label: 'Select Connection', codicon: 'database' },
    { command: 'postgresQueryBuilder.connect', label: 'New Connection', codicon: 'add' }
];

const TITLE_BAR_ACTIONS = [
    ...CONNECTION_ACTIONS,
    { command: 'postgresQueryBuilder.disconnect', label: 'Disconnect', codicon: 'plug' }
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

test('the table explorer title bar offers every connection action as an icon', () => {
    const commands: Array<{ command: string; title: string; icon?: string }> = manifest.contributes.commands;
    const titleMenu: Array<{ command: string; when: string; group: string }> = manifest.contributes.menus['view/title'];
    for (const action of TITLE_BAR_ACTIONS) {
        const entry = titleMenu.find(m => m.command === action.command && m.when === 'view == postgresTableExplorer');
        assert.ok(entry, `"${action.label}" is missing from the Tables title bar`);
        assert.match(entry.group, /^navigation/, `"${action.label}" would hide in the overflow menu`);
        const contributed = commands.find(c => c.command === action.command);
        assert.ok(contributed, `${action.command} is not contributed`);
        assert.equal(contributed.icon, `$(${action.codicon})`, `"${action.label}" has no icon, so the title bar shows nothing`);
        assert.equal(contributed.title, action.label, `"${action.command}" uses a second wording`);
    }
});

test('the search sidebar says nothing about connections', () => {
    const source = fs.readFileSync(path.join(SRC, 'searchViewProvider.ts'), 'utf8');
    for (const marker of ['selectConnection', 'newConnection', 'Select Connection', 'New Connection', 'Disconnect', 'postgresQueryBuilder.connect']) {
        assert.ok(!source.includes(marker), `the search sidebar still mentions ${marker}`);
    }
});

test('the search sidebar starts with the search field', () => {
    const source = fs.readFileSync(path.join(SRC, 'searchViewProvider.ts'), 'utf8');
    const body = source.slice(source.indexOf('const body ='));
    assert.ok(
        body.indexOf('id="searchInput"') < body.indexOf('class="button-row"'),
        'the search field is not the first element of the search sidebar'
    );
});

test('the select connection action carries one single label on every surface', () => {
    const content = fs.readFileSync(path.join(SRC, 'webview', 'tableView.js'), 'utf8');
    assert.ok(content.includes('Select Connection'), 'the Data Viewer lost the shared label');
    assert.ok(
        !/Select connection/.test(content),
        'the Data Viewer still uses a differently written label'
    );
});

/**
 * The feature is called "Bookmarked Queries" everywhere the user can read it:
 * it is stored with a star, behaves like a bookmark, and must not fall back to
 * the older "Saved Queries" wording in a single corner of the UI.
 */
const OLD_QUERY_WORDING = /saved quer|save query|saved-quer/i;

/** Every quoted literal of a source file, so comments are left out of the check. */
function stringLiterals(content: string): string[] {
    return content.match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) || [];
}

const BOOKMARK_COMMANDS = [
    'postgresQueryBuilder.runSavedQuery',
    'postgresQueryBuilder.refreshSavedQueries',
    'postgresQueryBuilder.renameSavedQuery',
    'postgresQueryBuilder.editSavedQuerySql',
    'postgresQueryBuilder.duplicateSavedQuery',
    'postgresQueryBuilder.deleteSavedQuery',
    'postgresQueryBuilder.moveSavedQueryToWorkspace',
    'postgresQueryBuilder.moveSavedQueryToGlobal',
    'postgresQueryBuilder.openSavedQueriesFile',
    'postgresQueryBuilder.saveQueryFromEditor'
];

test('the manifest calls the feature "Bookmarked Queries" and never "Saved Queries"', () => {
    const strings: Array<[string, string]> = [];
    collectUserVisibleStrings(manifest.contributes, ['contributes'], strings);
    for (const [where, value] of strings) {
        assert.ok(
            !OLD_QUERY_WORDING.test(value),
            `${where} still uses the old wording: ${value}`
        );
    }
    const view = manifest.contributes.views.postgresQueryBuilderExplorer.find(
        (v: { id: string }) => v.id === 'postgresSavedQueries'
    );
    assert.equal(view.name, 'Bookmarked Queries');
});

test('every bookmark command title speaks of bookmarks while its id stays stable', () => {
    for (const command of BOOKMARK_COMMANDS) {
        const entry = manifest.contributes.commands.find(
            (c: { command: string }) => c.command === command
        );
        assert.ok(entry, `${command} is no longer contributed`);
        assert.ok(
            /Bookmark/.test(entry.title),
            `${command} is titled "${entry.title}" instead of naming a bookmark`
        );
    }
});

test('the bookmark view welcome content points at the renamed button', () => {
    const welcome = manifest.contributes.viewsWelcome.find(
        (w: { view: string }) => w.view === 'postgresSavedQueries'
    );
    assert.ok(welcome, 'the bookmark view has no welcome content');
    assert.ok(welcome.contents.startsWith('No bookmarked queries yet.'));
    assert.ok(welcome.contents.includes('"Bookmark Query"'));
});

test('no user visible string of the bookmark surfaces uses the old wording', () => {
    const files = [
        path.join(SRC, 'extension.ts'),
        path.join(SRC, 'savedQueryEditor.ts'),
        path.join(SRC, 'savedQueryExplorer.ts'),
        path.join(SRC, 'savedQueryStore.ts'),
        path.join(SRC, 'savedQueryDrop.ts'),
        path.join(SRC, 'tableWebView.ts'),
        path.join(SRC, 'webview', 'tableView.js')
    ];
    for (const file of files) {
        for (const literal of stringLiterals(fs.readFileSync(file, 'utf8'))) {
            // The persisted file format keeps its identifier; only labels change.
            if (literal.includes('saved-queries/v1')) { continue; }
            assert.ok(
                !OLD_QUERY_WORDING.test(literal),
                `${path.basename(file)} still shows ${literal}`
            );
        }
    }
});

test('the data viewer dialog is titled Bookmark Query', () => {
    const html = fs.readFileSync(path.join(SRC, 'webview', 'tableView.html'), 'utf8');
    assert.ok(html.includes('<span id="saveQueryDialogTitle">Bookmark Query</span>'));
    assert.ok(html.includes('title="Bookmark this query for reuse"'));
    assert.ok(!OLD_QUERY_WORDING.test(html), 'the data viewer markup still uses the old wording');

    const script = fs.readFileSync(path.join(SRC, 'webview', 'tableView.js'), 'utf8');
    assert.ok(
        script.includes("saveQueryEditId ? 'Update Bookmarked Query' : 'Bookmark Query'"),
        'the dialog title is no longer switched between the bookmark labels'
    );
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
