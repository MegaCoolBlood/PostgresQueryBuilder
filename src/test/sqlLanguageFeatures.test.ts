import { languageRegistrations, vscodeStub } from './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSqlText } from '../repositoryScanner';
import type { LocatedDefinition, RepositorySnapshot } from '../repositoryComparison';
import { DatabaseCatalog, type CatalogConnection } from '../databaseCatalog';
import {
    DIAGNOSTIC_SOURCE,
    SqlDefinitionProvider,
    SqlDiagnostics,
    SqlDocCodeActionProvider,
    SqlHoverProvider,
    SqlIntel,
    registerSqlLanguageFeatures,
    toDiagnostic
} from '../sqlLanguageFeatures';

/** A text document as the providers use it. */
function doc(text: string, uri = 'file:///w/open.sql'): any {
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
    const offsetAt = (p: { line: number; character: number }): number => (lineStarts[p.line] ?? text.length) + p.character;
    const positionAt = (offset: number) => {
        let line = 0;
        while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) line++;
        return new vscodeStub.Position(line, offset - lineStarts[line]);
    };
    return {
        uri: { toString: () => uri }, languageId: 'sql', version: 1, isClosed: false,
        getText: (range?: any) => (range ? text.slice(offsetAt(range.start), offsetAt(range.end)) : text),
        offsetAt, positionAt
    };
}

function catalog(connected: boolean): DatabaseCatalog {
    const connection: CatalogConnection = {
        isConnected: () => connected,
        getActiveConnectionConfig: () => ({}),
        clearMetadataCache: () => {},
        queryMetadata: async (sql: string) => {
            if (sql.includes('server_version_num')) return [{ server_version_num: 160000 }];
            if (sql.includes('current_schemas')) return [{ schema_name: 'app' }];
            if (sql.includes('information_schema.schemata')) return [{ schema_name: 'app' }];
            if (sql.includes('pg_get_function_identity_arguments')) {
                return [{ kind: 'function', oid: 5, schema_name: 'app', name: 'db_only', args: '', arg_types: [], min_args: 0, max_args: 0,
                    detail: 'integer', rel_schema: null, rel_name: null, rel_column: null, owner: null, language: 'sql', comment: null, from_extension: false }];
            }
            return [];
        }
    };
    return new DatabaseCatalog(connection);
}

function repository(files: Record<string, string> | null) {
    const definitions: LocatedDefinition[] = files ? Object.entries(files).flatMap(([uri, sql]) => scanSqlText(sql).map(d => ({ ...d, uri }))) : [];
    const snapshot: RepositorySnapshot | null = files ? { version: 1, definitions } : null;
    return {
        snapshot: () => snapshot,
        ensureScanned: () => {},
        filesContaining: async (word: string) => Object.entries(files ?? {}).filter(([, text]) => text.includes(word)).map(([uri, text]) => ({ uri, text })),
        onDidChange: () => ({ dispose() {} })
    };
}

const REPO = { 'file:///w/f.sql': 'CREATE FUNCTION app.f(a integer) RETURNS integer LANGUAGE sql AS $$ SELECT a $$;' };

/** Answer `postgresQueryBuilder` settings from `values` for the duration of the test. */
function settings(t: { after(fn: () => void): void }, values: Record<string, unknown>): void {
    const ws = vscodeStub.workspace as any;
    const saved = ws.getConfiguration;
    ws.getConfiguration = () => ({ get: <T>(key: string, d?: T): T => (key in values ? values[key] as T : d as T) });
    t.after(() => { ws.getConfiguration = saved; });
}

function statusMessages(t: { after(fn: () => void): void }): string[] {
    const messages: string[] = [];
    const win = vscodeStub.window as any;
    const saved = win.setStatusBarMessage;
    win.setStatusBarMessage = (text: string) => { messages.push(text); return { dispose() {} }; };
    t.after(() => { win.setStatusBarMessage = saved; });
    return messages;
}

// ===== registration =====

test('every provider is registered for every SQL language, signature help on ( and , and completion on . and *', () => {
    const before = languageRegistrations.other.length;
    const completions = languageRegistrations.completion.length;
    registerSqlLanguageFeatures(new SqlIntel(catalog(false), repository(null)), ['sql', 'pgsql'], async () => []);
    const added = languageRegistrations.other.slice(before);
    for (const kind of ['definition', 'reference', 'documentSymbol', 'signatureHelp', 'codeLens']) {
        assert.deepEqual(added.filter(r => r.kind === kind).map(r => r.selector), ['sql', 'pgsql'], kind);
    }
    assert.equal(added.filter(r => r.kind === 'workspaceSymbol').length, 1);
    assert.deepEqual(added.find(r => r.kind === 'signatureHelp')?.triggers, ['(', ',']);
    assert.deepEqual(languageRegistrations.completion.slice(completions).map(r => r.triggers), [['.', '*'], ['.', '*']]);
});

// ===== Go to Definition =====

test('Go to Definition answers the CREATE statement in the repository', async () => {
    const provider = new SqlDefinitionProvider(new SqlIntel(catalog(true), repository(REPO)));
    const text = 'SELECT app.f(1);';
    const locations = await provider.provideDefinition(doc(text), doc(text).positionAt(text.indexOf('f(')));
    assert.equal(locations?.length, 1);
    assert.equal(locations![0].uri.toString(), 'file:///w/f.sql');
    assert.equal(locations![0].range.start.character, 16, 'the qualified name app.f');
});

test('an object only in the database is reported in the status bar, the same name once in a while', async (t) => {
    const messages = statusMessages(t);
    let now = 0;
    const provider = new SqlDefinitionProvider(new SqlIntel(catalog(true), repository(REPO)), () => now);
    const text = 'SELECT app.db_only();';
    const position = doc(text).positionAt(text.indexOf('db_only'));
    assert.equal(await provider.provideDefinition(doc(text), position), undefined);
    await provider.provideDefinition(doc(text), position);
    assert.deepEqual(messages, ['$(info) app.db_only exists in the database but not in the repository']);
    now = 6000;
    await provider.provideDefinition(doc(text), position);
    assert.equal(messages.length, 2);
});

test('while the first scan runs, Go to Definition says so', async (t) => {
    const messages = statusMessages(t);
    const provider = new SqlDefinitionProvider(new SqlIntel(catalog(true), repository(null)));
    const text = 'SELECT app.f(1);';
    await provider.provideDefinition(doc(text), doc(text).positionAt(text.indexOf('f(')));
    assert.deepEqual(messages, ['$(info) The repository is still being scanned for CREATE statements']);
});

// ===== hover =====

test('the hover trusts only its own commands and can be turned off', async (t) => {
    const provider = new SqlHoverProvider(new SqlIntel(catalog(true), repository(REPO)), async () => []);
    const text = 'SELECT app.f(1);';
    const hover: any = await provider.provideHover(doc(text), doc(text).positionAt(text.indexOf('f(')));
    assert.ok(hover);
    assert.ok(hover.contents.isTrusted.enabledCommands.includes('postgresQueryBuilder.revealInObjectView'));
    assert.equal(hover.contents.isTrusted.enabledCommands.length, 4);
    settings(t, { 'editor.hover': false });
    assert.equal(await provider.provideHover(doc(text), doc(text).positionAt(text.indexOf('f('))), undefined);
});

// ===== diagnostics =====

const UNDOCUMENTED = 'CREATE FUNCTION app.g(p_a integer) RETURNS void LANGUAGE sql AS $$ SELECT nosuch(1) $$;';

test('diagnostics are off by default and appear per setting: doc checks always, unknown routines only while connected', async (t) => {
    const before = languageRegistrations.diagnostics.length;
    const diagnostics = new SqlDiagnostics(new SqlIntel(catalog(true), repository(REPO)), ['sql'], 0);
    t.after(() => diagnostics.dispose());
    const collection = languageRegistrations.diagnostics[before];
    const document = doc(UNDOCUMENTED);
    await diagnostics.check(document);
    assert.deepEqual(collection.get(document.uri), []);

    settings(t, { 'diagnostics.docComments': true, 'diagnostics.unknownRoutines': true });
    await diagnostics.check(document);
    const found = collection.get(document.uri) as any[];
    assert.deepEqual(found.map(d => [d.code, d.severity, d.source]), [
        ['missingDoc', 2, DIAGNOSTIC_SOURCE],
        ['unknownRoutine', 1, DIAGNOSTIC_SOURCE]
    ]);

    const offline = new SqlDiagnostics(new SqlIntel(catalog(false), repository(REPO)), ['sql'], 0);
    t.after(() => offline.dispose());
    await offline.check(document);
    assert.deepEqual(languageRegistrations.diagnostics[before + 1].get(document.uri).map((d: any) => d.code), ['missingDoc']);
});

// ===== quick fixes =====

test('a missing doc comment gets the quick fix Add doc comment, also without the check turned on', () => {
    const provider = new SqlDocCodeActionProvider();
    const document = doc(UNDOCUMENTED);
    const [finding] = scanSqlText(UNDOCUMENTED);
    const diagnostic = toDiagnostic({ code: 'missingDoc', message: 'x', start: finding.start, end: finding.end }, 2);
    const [fix] = provider.provideCodeActions(document, diagnostic.range, { diagnostics: [diagnostic] } as any);
    assert.equal(fix.title, 'Add doc comment');
    const change = (fix as any).edit.changes[0];
    assert.equal(change.range.start.line, 0);
    assert.match(change.text, /^\/\*\*\n \* Purpose: \n[\s\S]* \* - p_a \(integer, IN\): \n \*\n \* Returns: void\n \*\/\n$/);
    const onName = provider.provideCodeActions(document, new vscodeStub.Range(0, 21, 0, 21) as any, { diagnostics: [] } as any);
    assert.deepEqual(onName.map(a => a.title), ['Add doc comment']);
});

test('an unknown documented parameter gets Remove entry, an undocumented one Add missing parameters', () => {
    const text = '/**\n * @param p_gone gone\n */\nCREATE FUNCTION g(p_a integer) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;';
    const document = doc(text);
    const provider = new SqlDocCodeActionProvider();
    const unknown = toDiagnostic({ code: 'unknownParam', message: 'x', start: { line: 1, character: 10 }, end: { line: 1, character: 16 } }, 2);
    const undocumented = toDiagnostic({ code: 'undocumentedParam', message: 'x', start: { line: 3, character: 18 }, end: { line: 3, character: 21 } }, 2);
    const actions = provider.provideCodeActions(document, unknown.range, { diagnostics: [unknown, undocumented] } as any);
    assert.deepEqual(actions.map(a => a.title), ['Remove entry for p_gone', 'Add missing parameters to the doc comment']);
    assert.equal((actions[1] as any).edit.changes[0].text, '\n * @param p_a ');
});
