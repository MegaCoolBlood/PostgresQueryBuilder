import test from 'node:test';
import assert from 'node:assert/strict';
import {
    maskSql,
    findVariableTokens,
    extractSelect,
    substituteVariables,
    findEnclosingDollarBody,
    extractTableNames
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

test('findVariableTokens captures variables used as function arguments in BETWEEN', () => {
    const sql =
        "SELECT * FROM t WHERE d BETWEEN DATE_TRUNC('day', v_von) AND LAST_DAY(v_bis)";
    const names = findVariableTokens(sql).map((o) => o.name);
    assert.ok(names.includes('v_von'), 'v_von (DATE_TRUNC argument) must be detected');
    assert.ok(names.includes('v_bis'), 'v_bis (LAST_DAY argument) must be detected');
});

test('findVariableTokens captures variables nested in function arguments after an operator', () => {
    const sql = 'SELECT * FROM t WHERE d < LEAST(v_bis, GREATEST(v_min, v_max))';
    const names = findVariableTokens(sql).map((o) => o.name);
    assert.ok(names.includes('v_bis'));
    assert.ok(names.includes('v_min'));
    assert.ok(names.includes('v_max'));
});

test('findVariableTokens does not treat select-list function arguments as values', () => {
    const sql = "SELECT DATE_TRUNC('day', mtd_datum) AS d FROM t WHERE x = v_x";
    const names = findVariableTokens(sql).map((o) => o.name);
    assert.ok(!names.includes('mtd_datum'), 'select-list function args are not value positions');
    assert.deepEqual(names, ['v_x']);
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

test('extractSelect picks only the SELECT inside a dollar-quoted function body', () => {
    const fn = [
        'CREATE OR REPLACE FUNCTION f(pi_employeeid numeric)',
        ' RETURNS boolean LANGUAGE plpgsql AS $function$',
        'DECLARE vJaNein varchar(10);',
        'BEGIN',
        "    vJaNein := 'N';",
        '    IF (pi_employeeid is not null) THEN',
        '        SELECT eaz.eaz_wert',
        '        INTO vJaNein',
        '        FROM bos_ext_attr_zuordnungen eaz',
        "        WHERE eaz.eaz_mit_id = pi_employeeid::integer;",
        '    END IF;',
        '    RETURN FALSE;',
        'END;',
        '$function$;'
    ].join('\n');
    const cursor = fn.indexOf('eaz.eaz_wert');
    const res = extractSelect(fn, cursor);
    assert.ok(res);
    assert.ok(res.sql.startsWith('SELECT eaz.eaz_wert'), `got: ${res.sql}`);
    assert.ok(!/CREATE OR REPLACE/i.test(res.sql), 'must not include the CREATE FUNCTION wrapper');
    assert.ok(!/\bINTO\b/i.test(res.sql), 'INTO clause must be stripped');
    assert.ok(!/END IF/i.test(res.sql), 'must stop at the statement semicolon');
    assert.deepEqual(res.variables, ['pi_employeeid']);
});

test('findEnclosingDollarBody returns inner bounds for the enclosing body', () => {
    const text = 'AS $b$ SELECT 1 $b$;';
    const inside = text.indexOf('SELECT');
    const bounds = findEnclosingDollarBody(text, inside);
    assert.ok(bounds);
    assert.equal(text.slice(bounds.start, bounds.end).trim(), 'SELECT 1');
    assert.equal(findEnclosingDollarBody(text, 0), null);
});

// ===== extractSelect: PL/pgSQL FOR ... IN (query) LOOP =====

test('extractSelect peels a parenthesized FOR ... IN (SELECT ...) LOOP', () => {
    const body = [
        'BEGIN',
        '    x := 1;',
        '    FOR r IN (',
        '        SELECT col_id, col_name',
        '        FROM some_table',
        '        WHERE col_name = p_name',
        '    ) LOOP',
        '        do_something(r);',
        '    END LOOP;',
        'END;'
    ].join('\n');
    const cursor = body.indexOf('col_id');
    const res = extractSelect(body, cursor);
    assert.ok(res);
    assert.ok(res.sql.startsWith('SELECT col_id'), `got: ${res.sql}`);
    assert.ok(!/FOR\s+r\s+IN/i.test(res.sql), 'must not include the FOR ... IN scaffolding');
    assert.ok(!/LOOP/i.test(res.sql), 'must not include the LOOP keyword');
    assert.ok(!/do_something/i.test(res.sql), 'must not include the loop body');
    assert.deepEqual(res.variables, ['p_name']);
});

test('extractSelect peels a FOR ... IN (...) loop with a UNION ALL query', () => {
    const body = [
        'BEGIN',
        '    x := 1;',
        '    FOR r IN (',
        '        SELECT a FROM t1 WHERE x = v_x',
        '        UNION ALL',
        '        SELECT b FROM t2',
        '    ) LOOP',
        '        process(r);',
        '    END LOOP;',
        'END;'
    ].join('\n');
    const cursor = body.indexOf('FROM t1');
    const res = extractSelect(body, cursor);
    assert.ok(res);
    assert.ok(res.sql.startsWith('SELECT a FROM t1'), `got: ${res.sql}`);
    assert.ok(/UNION ALL/i.test(res.sql), 'must keep the full union query');
    assert.ok(/SELECT b FROM t2/i.test(res.sql));
    assert.ok(!/\)\s*LOOP/i.test(res.sql), 'must not include the closing paren and LOOP');
    assert.deepEqual(res.variables, ['v_x']);
});

test('extractSelect peels an unparenthesized FOR ... IN SELECT ... LOOP', () => {
    const body = [
        'BEGIN',
        '    x := 1;',
        '    FOR r IN SELECT id FROM users WHERE id = v_id LOOP',
        '        handle(r);',
        '    END LOOP;',
        'END;'
    ].join('\n');
    const cursor = body.indexOf('FROM users');
    const res = extractSelect(body, cursor);
    assert.ok(res);
    assert.equal(res.sql, 'SELECT id FROM users WHERE id = v_id');
    assert.deepEqual(res.variables, ['v_id']);
});

test('extractSelect peels a FOR ... IN (...) loop whose query starts with a comment', () => {
    const body = [
        'BEGIN',
        '    -- COMMIT;',
        '    FOR r IN (',
        '        -- leading comment before the query',
        '        SELECT',
        '            col_a,',
        '            COALESCE(col_b, col_c) AS col_b',
        '        FROM some_table t',
        '        WHERE NOT EXISTS (',
        '            SELECT 1 FROM other_table WHERE o_id = t.t_id',
        '        )',
        '        AND t.col_a = p_value',
        '    )',
        '    LOOP',
        '        IF r.col_a IS NULL THEN',
        '            v_x := 1;',
        '        END IF;',
        '    END LOOP;',
        'END;'
    ].join('\n');
    const cursor = body.indexOf('col_a,');
    const res = extractSelect(body, cursor);
    assert.ok(res);
    assert.ok(res.sql.startsWith('SELECT'), `got: ${res.sql}`);
    assert.ok(!/FOR\s+r\s+IN/i.test(res.sql), 'must not include the FOR ... IN scaffolding');
    assert.ok(!/leading comment/i.test(res.sql), 'must not keep the leading comment line');
    assert.ok(!/\bLOOP\b/i.test(res.sql), 'must not include the LOOP keyword');
    assert.ok(!/v_x\s*:=/i.test(res.sql), 'must not include the loop body');
    assert.ok(/NOT EXISTS/i.test(res.sql), 'must keep the nested subquery');
    assert.deepEqual(res.variables, ['p_value']);
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

// ===== extractSelect: UPDATE -> SELECT conversion =====

test('extractSelect converts a simple UPDATE into a SELECT', () => {
    const body = "UPDATE some_table SET col_a = '60', col_b = 0 WHERE id = v_id AND name = p_name;";
    const cursor = body.indexOf('SET');
    const res = extractSelect(body, cursor);
    assert.ok(res);
    assert.equal(res.sql, 'SELECT * FROM some_table WHERE id = v_id AND name = p_name');
    assert.ok(!/\bSET\b/i.test(res.sql), 'SET clause must be dropped');
    assert.deepEqual(res.variables, ['v_id', 'p_name']);
});

test('extractSelect converts an UPDATE with a nested NOT EXISTS subquery and BETWEEN', () => {
    const body = [
        'UPDATE some_table',
        "    SET col_status = '60',",
        '        col_hours = 0',
        '    WHERE col_sid = v_sid',
        '    AND col_persnr = p_persnr',
        '    AND NOT EXISTS (',
        '        SELECT 1',
        '        FROM other_table o',
        '        WHERE o.o_persnr = st.col_persnr',
        "        AND o.o_valid = 'J'",
        '    )',
        "    AND col_from BETWEEN v_von AND v_bis + INTERVAL '1 day';"
    ].join('\n');
    const cursor = body.indexOf('SET');
    const res = extractSelect(body, cursor);
    assert.ok(res);
    assert.ok(res.sql.startsWith('SELECT * FROM some_table'), `got: ${res.sql}`);
    assert.ok(!/\bSET\b/i.test(res.sql), 'SET clause must be dropped');
    assert.ok(!/col_status/i.test(res.sql), 'assignment columns must be dropped');
    assert.ok(/NOT EXISTS/i.test(res.sql), 'WHERE subquery must be kept');
    assert.deepEqual(res.variables, ['v_sid', 'p_persnr', 'v_von', 'v_bis']);
});

test('extractSelect converts an UPDATE ... FROM ... into a SELECT with a combined FROM list', () => {
    const body =
        'UPDATE t1 SET a = b.x FROM t2 b WHERE t1.id = b.t1_id AND t1.k = v_k;';
    const cursor = body.indexOf('SET');
    const res = extractSelect(body, cursor);
    assert.ok(res);
    assert.equal(res.sql, 'SELECT * FROM t1, t2 b WHERE t1.id = b.t1_id AND t1.k = v_k');
    assert.deepEqual(res.variables, ['v_k']);
});

test('extractSelect converts an UPDATE with an alias and drops RETURNING', () => {
    const body = 'UPDATE some_table st SET col = 1 WHERE st.id = v_id RETURNING st.id;';
    const cursor = body.indexOf('SET');
    const res = extractSelect(body, cursor);
    assert.ok(res);
    assert.equal(res.sql, 'SELECT * FROM some_table st WHERE st.id = v_id');
    assert.ok(!/RETURNING/i.test(res.sql), 'RETURNING clause must be dropped');
    assert.deepEqual(res.variables, ['v_id']);
});

// ===== extractTableNames =====

test('extractTableNames returns the FROM table', () => {
    assert.deepEqual(extractTableNames('SELECT * FROM users WHERE id = v_id'), ['users']);
});

test('extractTableNames returns FROM-list and JOIN tables with aliases skipped', () => {
    const sql =
        'SELECT * FROM t1 a, t2 b JOIN t3 c ON c.id = a.id LEFT JOIN t4 ON t4.k = b.k';
    assert.deepEqual(extractTableNames(sql), ['t1', 't2', 't3', 't4']);
});

test('extractTableNames strips the schema qualifier', () => {
    assert.deepEqual(extractTableNames('SELECT * FROM public.users u'), ['users']);
});

test('extractTableNames includes tables inside subqueries', () => {
    const sql =
        'SELECT * FROM orders o WHERE NOT EXISTS (SELECT 1 FROM order_items i WHERE i.oid = o.id)';
    assert.deepEqual(extractTableNames(sql), ['orders', 'order_items']);
});

test('extractTableNames skips derived tables (subquery in FROM)', () => {
    const sql = 'SELECT * FROM (SELECT id FROM users) sub JOIN roles r ON r.id = sub.id';
    assert.deepEqual(extractTableNames(sql), ['users', 'roles']);
});

test('extractTableNames does not treat a table-position function as a table', () => {
    const sql = 'SELECT * FROM generate_series(1, 10) g JOIN nums n ON n.v = g';
    assert.deepEqual(extractTableNames(sql), ['nums']);
});

test('extractTableNames de-duplicates repeated tables', () => {
    const sql = 'SELECT * FROM t a JOIN t b ON a.id = b.parent';
    assert.deepEqual(extractTableNames(sql), ['t']);
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
