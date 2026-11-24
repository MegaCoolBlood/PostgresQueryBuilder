import './helpers/vscodeMock';
import { vscodeStub } from './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    documentApplyTarget,
    indentContinuationLines,
    lineIndentAt,
    locateApplyRange,
    selectSourceForBuilder,
    statementForFile
} from '../applyToDocument';

// ===== locateApplyRange =====

test('locateApplyRange finds the statement where it was, or at its only other place, and refuses otherwise', () => {
    const original = 'SELECT a FROM t';
    assert.deepEqual(locateApplyRange(`-- x\n${original};`, 5, original), { start: 5, end: 20 });
    assert.deepEqual(locateApplyRange(`-- added line\n-- x\n${original};`, 5, original), { start: 19, end: 34 });
    assert.match((locateApplyRange('SELECT b FROM t;', 0, original) as { error: string }).error, /changed in the editor/);
    assert.match((locateApplyRange(`x ${original}; ${original};`, 0, original) as { error: string }).error, /more than once/);
});

// ===== indentContinuationLines / lineIndentAt =====

test('indentContinuationLines indents a statement written into a function body, except multi-line literals', () => {
    assert.equal(indentContinuationLines('SELECT\n    a\nFROM\n\n    t', '    '), 'SELECT\n        a\n    FROM\n\n        t');
    const literal = "SELECT 'line one\nline two' AS x";
    assert.equal(indentContinuationLines(literal, '  '), literal);
    const dollar = 'SELECT $q$line one\nline two$q$ AS x';
    assert.equal(indentContinuationLines(dollar, '  '), dollar);
    assert.equal(indentContinuationLines('SELECT a -- it\'s\nFROM t', '  '), 'SELECT a -- it\'s\n  FROM t', 'a quote in a comment is no literal');
    assert.equal(indentContinuationLines('SELECT\n1', ''), 'SELECT\n1');
    assert.equal(lineIndentAt('BEGIN\n\t  RETURN QUERY SELECT 1;', 20), '\t  ');
});

// ===== selectSourceForBuilder =====

test('selectSourceForBuilder returns the exact range of the SELECT at the cursor in a function body', () => {
    const text = 'CREATE FUNCTION f() RETURNS SETOF t AS $$\nBEGIN\n    RETURN QUERY SELECT a\n      FROM t ;\nEND $$ LANGUAGE plpgsql;';
    const source = selectSourceForBuilder(text, text.indexOf('FROM t'));
    assert.ok(source);
    assert.equal(text.slice(source.start, source.end), 'SELECT a\n      FROM t');
    assert.equal(source.sql, 'SELECT a\n      FROM t');
    assert.equal(source.original, source.sql);
    assert.equal(source.applyBlockedReason, undefined);
});

test('selectSourceForBuilder shows a SELECT INTO or an UPDATE as a SELECT, without Apply', () => {
    const into = 'DO $$ BEGIN SELECT count(*) INTO n FROM t WHERE a = v_a; END $$;';
    const source = selectSourceForBuilder(into, into.indexOf('count'));
    assert.match(source?.applyBlockedReason ?? '', /INTO/);
    assert.equal(source?.sql, 'SELECT count(*) FROM t WHERE a = v_a', 'the variable stays as text');
    assert.equal(source?.original, 'SELECT count(*) INTO n FROM t WHERE a = v_a');

    const update = selectSourceForBuilder('UPDATE t SET a = 1 WHERE b = 2', 3);
    assert.match(update?.applyBlockedReason ?? '', /UPDATE/);
    assert.match(update?.sql ?? '', /^SELECT/);
    assert.equal(selectSourceForBuilder('   ', 1), undefined);
});

test('statementForFile leaves the semicolon to the file', () => {
    assert.equal(statementForFile('SELECT 1;\n'), 'SELECT 1');
    assert.equal(statementForFile('SELECT 1'), 'SELECT 1');
});

// ===== documentApplyTarget =====

test('documentApplyTarget replaces the statement, indented and with the line ends of the file, and follows it', async (t) => {
    let text = 'BEGIN\r\n    RETURN QUERY SELECT a FROM t;\r\nEND';
    const edits: any[] = [];
    const originalOpen = vscodeStub.workspace.openTextDocument;
    const originalApply = vscodeStub.workspace.applyEdit;
    vscodeStub.workspace.openTextDocument = async (uri: any) => ({ uri, getText: () => text, positionAt: (offset: number) => ({ offset }) });
    vscodeStub.workspace.applyEdit = async (edit: any) => {
        for (const change of edit.changes) {
            edits.push(change);
            text = text.slice(0, change.range.start.offset) + change.text + text.slice(change.range.end.offset);
        }
        return true;
    };
    t.after(() => {
        vscodeStub.workspace.openTextDocument = originalOpen;
        vscodeStub.workspace.applyEdit = originalApply;
    });
    const start = text.indexOf('SELECT');
    const target = documentApplyTarget({ fsPath: 'f.sql' } as any, 'f.sql', start, 'SELECT a FROM t');
    assert.equal(target.label, 'f.sql');
    const first = await target.apply('SELECT a, b\nFROM t;');
    assert.equal(first.ok, true);
    assert.equal(text, 'BEGIN\r\n    RETURN QUERY SELECT a, b\r\n    FROM t;\r\nEND');
    const second = await target.apply('SELECT b FROM t');
    assert.equal(second.ok, true, 'the second Apply finds what the first one wrote');
    assert.equal(text, 'BEGIN\r\n    RETURN QUERY SELECT b FROM t;\r\nEND');

    text = 'BEGIN SELECT other FROM x; END';
    const refused = await target.apply('SELECT c FROM t');
    assert.equal(refused.ok, false);
    assert.match(refused.message, /changed in the editor/);
    assert.equal(edits.length, 2);
});
