import test from 'node:test';
import assert from 'node:assert/strict';
import {
    maskSql,
    findVariableTokens,
    extractSelect,
    substituteVariables
} from '../selectStatementExtractor';

// ===== maskSql =====

test('maskSql blanks single-quoted string literals but keeps length', () => {
    const sql = "SELECT 'a;b' FROM t";
    const masked = maskSql(sql);
    assert.equal(masked.length, sql.length);
    assert.ok(!masked.includes(';'), 'semicolon inside string should be masked');
    assert.ok(masked.startsWith('SELECT'));
    assert.ok(masked.includes('FROM t'));
});

test('maskSql blanks line and block comments', () => {
    const sql = 'SELECT 1 -- ; comment\nFROM t /* ; */ WHERE x';
    const masked = maskSql(sql);
    assert.ok(!masked.includes(';'));
    assert.ok(masked.includes('FROM t'));
    assert.ok(masked.includes('WHERE x'));
});

test('maskSql blanks dollar-quoted strings', () => {
    const sql = "SELECT $tag$ ; not real $tag$ FROM t";
    const masked = maskSql(sql);
    assert.ok(!masked.includes(';'));
    assert.ok(masked.includes('FROM t'));
});

// ===== findVariableTokens =====

test('findVariableTokens skips keywords, qualified columns and tables', () => {
    const sql = 'SELECT t.id, t.name FROM users t WHERE t.id = v_user_id';
    const names = findVariableTokens(sql).map((o) => o.name);
    assert.deepEqual(names, ['v_user_id']);
});

test('findVariableTokens includes session value keywords', () => {
    const sql = 'SELECT * FROM logs WHERE created_by = current_user';
    const names = findVariableTokens(sql).map((o) => o.name);
    assert.ok(names.includes('current_user'));
});

test('findVariableTokens skips function calls', () => {
    const sql = 'SELECT count(*) FROM t WHERE d > now()';
    const names = findVariableTokens(sql).map((o) => o.name);
    assert.ok(!names.includes('count'));
    assert.ok(!names.includes('now'));
});

test('findVariableTokens captures positional parameters', () => {
    const sql = 'SELECT * FROM t WHERE id = $1';
    const names = findVariableTokens(sql).map((o) => o.name);
    assert.deepEqual(names, ['$1']);
});

// ===== extractSelect: statement boundary detection =====

test('extractSelect finds the SELECT around the cursor between semicolons', () => {
    const body = "x := 1;\nSELECT id FROM users WHERE id = v_id;\ny := 2;";
    const cursor = body.indexOf('FROM');
    const res = extractSelect(body, cursor);
    assert.ok(res);
    assert.equal(res.sql, 'SELECT id FROM users WHERE id = v_id');
    assert.deepEqual(res.variables, ['v_id']);
});

test('extractSelect trims a leading prefix down to SELECT', () => {
    const body = 'RETURN QUERY SELECT id FROM t WHERE a = v_a;';
    const cursor = body.indexOf('FROM');
    const res = extractSelect(body, cursor);
    assert.ok(res);
    assert.equal(res.sql, 'SELECT id FROM t WHERE a = v_a');
});

test('extractSelect keeps a WITH statement', () => {
    const body = 'WITH c AS (SELECT 1) SELECT * FROM c WHERE n = v_n;';
    const cursor = body.indexOf('FROM');
    const res = extractSelect(body, cursor);
    assert.ok(res);
    assert.ok(res.sql.startsWith('WITH c AS'));
    assert.deepEqual(res.variables, ['v_n']);
});

// ===== extractSelect: INTO stripping =====

test('extractSelect strips a simple INTO clause', () => {
    const body = 'SELECT id, name INTO v_id, v_name FROM users WHERE id = p_id;';
    const cursor = body.indexOf('FROM');
    const res = extractSelect(body, cursor);
    assert.ok(res);
    assert.equal(res.sql, 'SELECT id, name FROM users WHERE id = p_id');
    assert.deepEqual(res.variables, ['p_id']);
});

test('extractSelect strips an INTO STRICT clause', () => {
    const body = 'SELECT count(*) INTO STRICT v_cnt FROM users;';
    const cursor = body.indexOf('FROM');
    const res = extractSelect(body, cursor);
    assert.ok(res);
    assert.equal(res.sql, 'SELECT count(*) FROM users');
});

// ===== extractSelect: explicit selection (sub-select / WITH) =====

test('extractSelect uses an explicit selection verbatim without expanding', () => {
    const body = 'SELECT * FROM (SELECT id FROM users WHERE id = v_id) sub;';
    const subStart = body.indexOf('SELECT id');
    const subEnd = body.indexOf(')');
    const res = extractSelect(body, 0, { start: subStart, end: subEnd });
    assert.ok(res);
    assert.equal(res.sql, 'SELECT id FROM users WHERE id = v_id');
    assert.deepEqual(res.variables, ['v_id']);
});

// ===== substituteVariables =====

test('substituteVariables replaces values verbatim and case-insensitively', () => {
    const sql = 'SELECT * FROM users WHERE id = v_id AND role = current_user';
    const out = substituteVariables(sql, { V_ID: '42', current_user: "'alice'" });
    assert.equal(out, "SELECT * FROM users WHERE id = 42 AND role = 'alice'");
});

test('substituteVariables leaves blank values untouched', () => {
    const sql = 'SELECT * FROM users WHERE id = v_id AND active = v_flag';
    const out = substituteVariables(sql, { v_id: '7', v_flag: '' });
    assert.equal(out, 'SELECT * FROM users WHERE id = 7 AND active = v_flag');
});

test('substituteVariables does not touch qualified columns', () => {
    const sql = 'SELECT u.id FROM users u WHERE u.id = id';
    const out = substituteVariables(sql, { id: '99' });
    assert.equal(out, 'SELECT u.id FROM users u WHERE u.id = 99');
});
