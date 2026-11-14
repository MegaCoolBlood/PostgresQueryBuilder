import { fireDidChangeConfiguration, vscodeStub } from './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import { RepositoryIndex, combineGlobs, globToRegExp, matchesAnyGlob, type RepositorySettings } from '../repositoryIndex';

// ===== globs =====

test('combineGlobs joins several globs into one brace pattern', () => {
    assert.equal(combineGlobs([]), undefined);
    assert.equal(combineGlobs(['**/*.sql']), '**/*.sql');
    assert.equal(combineGlobs(['**/*.sql', '**/*.pgsql']), '{**/*.sql,**/*.pgsql}');
});

test('globToRegExp understands **, *, ? and braces', () => {
    assert.ok(globToRegExp('**/node_modules/**').test('node_modules/pkg/x.sql'));
    assert.ok(globToRegExp('**/node_modules/**').test('a/b/node_modules/x.sql'));
    assert.ok(!globToRegExp('**/node_modules/**').test('a/my_node_modules_x/x.sql'));
    assert.ok(globToRegExp('db/*.sql').test('db/a.sql'));
    assert.ok(!globToRegExp('db/*.sql').test('db/sub/a.sql'));
    assert.ok(globToRegExp('dumps/v?.sql').test('dumps/v1.sql'));
    assert.ok(globToRegExp('**/*.{sql,pgsql}').test('x/y.pgsql'));
    assert.ok(!globToRegExp('**/*.{sql,pgsql}').test('x/y.txt'));
});

test('matchesAnyGlob accepts Windows separators', () => {
    assert.equal(matchesAnyGlob('dumps\\full.sql', ['dumps/**']), true);
    assert.equal(matchesAnyGlob('src\\full.sql', ['dumps/**']), false);
});

// ===== RepositoryIndex =====

function stubWorkspace(t: { after(fn: () => void): void }, files: Record<string, string>): void {
    const ws = vscodeStub.workspace as any;
    const saved = { workspaceFolders: ws.workspaceFolders, findFiles: ws.findFiles, stat: ws.fs.stat, readFile: ws.fs.readFile, asRelativePath: ws.asRelativePath };
    ws.workspaceFolders = [{ uri: { fsPath: '/w' } }];
    const relative = (key: string): string => key.replace('file:///w/', '');
    ws.findFiles = async (_include: string, exclude: string | null) => Object.keys(files)
        .filter(key => !exclude || !globToRegExp(exclude).test(relative(key)))
        .map(key => ({ toString: () => key }));
    ws.fs.stat = async (uri: { toString(): string }) => ({ size: Buffer.byteLength(files[uri.toString()]) });
    ws.fs.readFile = async (uri: { toString(): string }) => Buffer.from(files[uri.toString()]);
    ws.asRelativePath = (uri: { toString(): string }) => relative(uri.toString());
    t.after(() => {
        ws.workspaceFolders = saved.workspaceFolders;
        ws.findFiles = saved.findFiles;
        ws.fs.stat = saved.stat;
        ws.fs.readFile = saved.readFile;
        ws.asRelativePath = saved.asRelativePath;
    });
}

const SETTINGS: RepositorySettings = { compare: true, include: ['**/*.sql'], exclude: [], maxFileSizeKb: 1 };

test('RepositoryIndex scans in the background and offers the definitions once the scan is done', async (t) => {
    stubWorkspace(t, {
        'file:///w/a.sql': 'CREATE TABLE app.a (id int);\nCREATE FUNCTION app.f() RETURNS int AS $$ select 1 $$ LANGUAGE sql;',
        'file:///w/none.sql': 'SELECT 1;',
        'file:///w/dump.sql': `CREATE TABLE app.huge (id int);${' '.repeat(2048)}`
    });
    const index = new RepositoryIndex('postgresObjectNavigator', () => SETTINGS);
    t.after(() => index.dispose());
    const done = new Promise<void>(resolve => index.onDidChange(() => resolve()));
    index.ensureScanned();
    assert.equal(index.snapshot(), null, 'no snapshot before the scan has finished');
    await done;
    const snapshot = index.snapshot();
    assert.ok(snapshot);
    assert.deepEqual(snapshot.definitions.map(d => `${d.uri} ${d.kind} ${d.name}`), [
        'file:///w/a.sql table a',
        'file:///w/a.sql function f'
    ], 'a file above the size limit is left out');
});

test('RepositoryIndex neither scans nor offers anything while the comparison is turned off', async (t) => {
    let searched = false;
    stubWorkspace(t, {});
    (vscodeStub.workspace as any).findFiles = async () => { searched = true; return []; };
    const index = new RepositoryIndex('postgresObjectNavigator', () => ({ ...SETTINGS, compare: false }));
    t.after(() => index.dispose());
    index.ensureScanned();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(searched, false);
    assert.equal(index.snapshot(), null);
});

test('a scan that was still running when the settings changed does not write its result', async (t) => {
    let releaseRead: () => void = () => {};
    const readStarted = new Promise<void>(resolve => {
        stubWorkspace(t, { 'file:///w/dumps/old.sql': 'CREATE TABLE app.dumped (id int);' });
        const ws = vscodeStub.workspace as any;
        const read = ws.fs.readFile;
        ws.fs.readFile = (uri: unknown) => {
            resolve();
            return new Promise(done => { releaseRead = () => done(read(uri)); });
        };
    });
    let settings: RepositorySettings = SETTINGS;
    const index = new RepositoryIndex('postgresObjectNavigator', () => settings);
    t.after(() => index.dispose());
    index.ensureScanned();
    await readStarted;
    // The user excludes the dumps while the first scan reads them.
    settings = { ...SETTINGS, exclude: ['dumps/**'] };
    fireDidChangeConfiguration(['postgresQueryBuilder.repository.exclude']);
    releaseRead();
    await new Promise(resolve => setTimeout(resolve, 10));
    const done = new Promise<void>(resolve => { const d = index.onDidChange(() => { d.dispose(); resolve(); }); });
    index.ensureScanned();
    await done;
    assert.deepEqual(index.snapshot()?.definitions, [], 'the excluded file read by the stale scan must not come back');
});

test('deleting a folder forgets the definitions of every file in it', async (t) => {
    stubWorkspace(t, {
        'file:///w/db/a.sql': 'CREATE TABLE app.a (id int);',
        'file:///w/db/sub/b.sql': 'CREATE TABLE app.b (id int);',
        'file:///w/dbx/c.sql': 'CREATE TABLE app.c (id int);'
    });
    const watchers: Array<{ glob: string; onDelete?: (uri: unknown) => void }> = [];
    const ws = vscodeStub.workspace as any;
    const createWatcher = ws.createFileSystemWatcher;
    ws.createFileSystemWatcher = (glob: string) => {
        const watcher: { glob: string; onDelete?: (uri: unknown) => void } = { glob };
        watchers.push(watcher);
        return {
            onDidCreate: () => ({ dispose() {} }),
            onDidChange: () => ({ dispose() {} }),
            onDidDelete: (listener: (uri: unknown) => void) => { watcher.onDelete = listener; return { dispose() {} }; },
            dispose() {}
        };
    };
    t.after(() => { ws.createFileSystemWatcher = createWatcher; });
    const index = new RepositoryIndex('postgresObjectNavigator', () => ({ ...SETTINGS, maxFileSizeKb: 100 }));
    t.after(() => index.dispose());
    const done = new Promise<void>(resolve => { const d = index.onDidChange(() => { d.dispose(); resolve(); }); });
    index.ensureScanned();
    await done;
    const folderWatcher = watchers.find(w => w.glob === '**/*');
    assert.ok(folderWatcher?.onDelete, 'no watcher reports deleted folders');
    folderWatcher.onDelete({ toString: () => 'file:///w/db' });
    assert.deepEqual(index.snapshot()?.definitions.map(d => d.name), ['c'], 'only the file outside the folder is left');
});
