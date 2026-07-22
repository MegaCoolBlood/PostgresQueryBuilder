import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSql, DEFAULT_FORMAT_OPTIONS, DEFAULT_THRESHOLDS, sqlSemanticallyEqual, sqlSemanticDiff, formatSqlChecked, coerceFormatOptions } from '../plpgsqlFormatter';

test('uppercases keywords and breaks a SELECT into clauses with a column list', () => {
    const out = formatSql('select a,b ,c from foo f join bar b on b.id=f.bid where a=1 and b>2 order by a');
    assert.equal(
        out,
        [
            'SELECT',
            '  a,',
            '  b,',
            '  c',
            'FROM foo f',
            'JOIN bar b ON b.id = f.bid',
            'WHERE a = 1',
            '  AND b > 2',
            'ORDER BY a'
        ].join('\n')
    );
});

test('keeps a simple SELECT * on a single line', () => {
    assert.equal(formatSql('select * from t;'), 'SELECT * FROM t;');
});

test('formats a PL/pgSQL function body with DECLARE/BEGIN/IF/LOOP blocks', () => {
    const out = formatSql(
        "create function f(p int) returns void as $$ declare x int;\nbegin if x>0 then perform do_it(x); else raise notice 'no'; end if; end; $$ language plpgsql;"
    );
    assert.equal(
        out,
        [
            'CREATE FUNCTION f(',
            '  p INT',
            ') RETURNS VOID',
            'AS $$',
            'DECLARE',
            '  x INT;',
            'BEGIN',
            '  IF x > 0 THEN',
            '    PERFORM do_it(x);',
            '  ELSE',
            "    RAISE NOTICE 'no';",
            '  END IF;',
            'END;',
            '$$ LANGUAGE plpgsql;'
        ].join('\n')
    );
});

test('handles ELSIF chains', () => {
    const out = formatSql('begin\nif a then b(); elsif c then d(); else e(); end if;\nend;');
    assert.equal(
        out,
        [
            'BEGIN',
            '  IF a THEN',
            '    b();',
            '  ELSIF c THEN',
            '    d();',
            '  ELSE',
            '    e();',
            '  END IF;',
            'END;'
        ].join('\n')
    );
});

test('treats CASE as an expression (does not break on its ELSE/END)', () => {
    const out = formatSql("select a, case when x>1 then 'a' else 'b' end as label from t;");
    // With selectColumns default {1, 3}: 2 columns follow source layout (single-line → stays inline).
    assert.equal(out, "SELECT a, CASE WHEN x > 1 THEN 'a' ELSE 'b' END AS label\nFROM t;");
});

test('keeps a single-line CASE expression on one line', () => {
    const out = formatSql("select case when a and b then 1 else 0 end from t;");
    assert.equal(out, 'SELECT CASE WHEN a AND b THEN 1 ELSE 0 END FROM t;');
});

test('formats a multiline CASE with one WHEN per line', () => {
    const out = formatSql([
        'select',
        'case',
        "when x > 1 then 'a'",
        "when y = 2 then 'b'",
        "else 'c'",
        'end as label',
        'from t;'
    ].join('\n'));
    assert.equal(
        out,
        [
            'SELECT CASE',
            "  WHEN x > 1 THEN 'a'",
            "  WHEN y = 2 THEN 'b'",
            "  ELSE 'c'",
            'END AS label',
            'FROM t;'
        ].join('\n')
    );
});

test('breaks a multi-condition WHEN clause (BETWEEN AND stays inline)', () => {
    const out = formatSql([
        'select',
        'case',
        "when a = b and c between d and g then 'x'",
        "when z = 1 then 'y'",
        "else 'n'",
        'end',
        'from t;'
    ].join('\n'));
    assert.equal(
        out,
        [
            'SELECT CASE',
            '  WHEN a = b',
            '    AND c BETWEEN d AND g',
            '  THEN',
            "    'x'",
            "  WHEN z = 1 THEN 'y'",
            "  ELSE 'n'",
            'END',
            'FROM t;'
        ].join('\n')
    );
});

test('puts the result on its own line when a CASE clause spans lines', () => {
    const out = formatSql([
        'select case',
        'when x = 1 then',
        '  some_long_function(a, b)',
        'else other',
        'end from t;'
    ].join('\n'));
    assert.equal(
        out,
        [
            'SELECT CASE',
            '  WHEN x = 1 THEN',
            '    some_long_function(a, b)',
            '  ELSE other',
            'END',
            'FROM t;'
        ].join('\n')
    );
});

test('does not collapse a CASE statement (END CASE) with nested IF blocks', () => {
    const out = formatSql([
        'CASE',
        "WHEN pi_import_name = 'ImpAccAssign' THEN  -- emplNo given?",
        'IF pi_param1 IS NOT NULL THEN',
        'v_text := v_column_line;',
        'END IF;',
        'END CASE;'
    ].join('\n'));
    // The branch body must NOT be swallowed into the trailing comment.
    assert.ok(out.includes('-- emplNo given?'), 'trailing comment is preserved');
    assert.ok(/IF pi_param1 IS NOT NULL THEN/.test(out), 'nested IF is kept as code');
    assert.ok(/^\s*v_text := v_column_line;$/m.test(out), 'assignment stays on its own line');
    assert.ok(/END IF;/.test(out) && /END CASE;/.test(out), 'block terminators preserved');
    // Nothing after the comment marker on its line (i.e. it is a trailing comment, not swallowing code).
    const commentLine = out.split('\n').find(l => l.includes('-- emplNo given?'))!;
    assert.ok(!/IF pi_param1/.test(commentLine), 'code is not pulled onto the comment line');
});

test('a line comment inside a CASE expression does not swallow the following WHEN branch', () => {
    const out = formatSql([
        'SELECT CASE rgl_antwort',
        "  WHEN 'AV' THEN pk_onlinerm.f_abgelehnt_von() -- functions without arguments",
        "  WHEN 'GV' THEN pk_onlinerm.f_genehmigt_von()",
        '  ELSE NULL',
        'END AS antwort',
        'FROM t;'
    ].join('\n'));
    assert.ok(out.includes('-- functions without arguments'), 'comment is preserved');
    // The branch following the comment must stay live code, not be absorbed into the comment.
    const commentLine = out.split('\n').find(l => l.includes('-- functions without arguments'))!;
    assert.ok(!/WHEN 'GV'/.test(commentLine), "second WHEN is not pulled onto the comment line");
    assert.ok(/WHEN 'GV' THEN pk_onlinerm\.f_genehmigt_von\(\)/.test(out), 'second WHEN survives as code');
    assert.ok(/f_abgelehnt_von\(\)/.test(out), 'first branch result survives');
});

test('a line comment directly after an operator (||--) does not swallow the following code', () => {
    // Regression: the tokenizer treated `||--` as a single operator, so the
    // `--` never started a comment and the code on the next lines was silently
    // merged into it. `--` must always begin a comment, even with no space.
    const input = [
        'CREATE FUNCTION f() RETURNS void AS $$',
        'BEGIN',
        '    v_params := CONCAT_WS(',
        "        ';',",
        "        TO_CHAR(pi_refdate, 'DD') || '.' ||-- P_TAG_KG",
        "        TO_CHAR(pi_refdate, 'MM') || '.' ||-- P_MONAT",
        "        TO_CHAR(pi_refdate, 'YYYY'),      -- P_JAHR",
        "        (buf_params ->> 'AStd'::text)",
        '    );',
        'END;',
        '$$ LANGUAGE plpgsql;'
    ].join('\n');
    const r = formatSqlChecked(input);
    assert.equal(r.ok, true, r.reason);
    const out = r.text;
    // Each comment must remain a trailing comment; no code may sit after the marker.
    for (const marker of ['-- P_TAG_KG', '-- P_MONAT', '-- P_JAHR']) {
        const line = out.split('\n').find(l => l.includes(marker))!;
        assert.ok(line, `${marker} is preserved`);
        assert.ok(!/TO_CHAR|buf_params/.test(line.slice(line.indexOf(marker))), `code is not pulled onto the ${marker} line`);
    }
    // All three TO_CHAR calls survive as live code and are not lost to a comment.
    assert.equal((out.match(/TO_CHAR\(pi_refdate/g) ?? []).length, 3, 'all TO_CHAR calls survive');
    assert.ok(sqlSemanticallyEqual(input, out), 'formatting preserves meaning');
});

test('tokenizer stops an operator run before -- and /* comment markers', () => {
    // `x ||-- c` keeps the `||` operator and starts a comment; the block-comment
    // marker `/*` likewise ends an operator run rather than being absorbed.
    const line = formatSql('SELECT a ||-- note\nb;');
    assert.ok(line.includes('-- note'), 'line comment after || is preserved');
    assert.ok(sqlSemanticallyEqual('SELECT a ||-- note\nb;', line), 'meaning preserved for ||--');
    const blk = formatSql('SELECT a ||/* note */ b;');
    assert.ok(blk.includes('/* note */'), 'block comment after || is preserved');
    assert.ok(sqlSemanticallyEqual('SELECT a ||/* note */ b;', blk), 'meaning preserved for ||/*');
});

test('safety net: code absorbed into a comment after an operator is detected', () => {
    // Correct: the concat operator ends the line, code follows below.
    const good = "a || '.' ||-- c1\nTO_CHAR(x)";
    // Corrupt: the next line was merged onto the comment, so TO_CHAR(x) is now
    // comment text. The signatures must differ so the safety net rejects it.
    const corrupt = "a || '.' ||-- c1 TO_CHAR(x)";
    assert.ok(!sqlSemanticallyEqual(good, corrupt), 'swallowed code after an operator must change the signature');
    assert.match(sqlSemanticDiff(good, corrupt)!, /lineComment/, 'diff names the offending comment token');
});

test('a trailing line comment after a statement does not swallow the next statement', () => {
    const out = formatSql([
        'BEGIN',
        '  do_it(); -- run it',
        '  CALL p_next(id);',
        'END;'
    ].join('\n'));
    const commentLine = out.split('\n').find(l => l.includes('-- run it'))!;
    assert.ok(!/CALL p_next/.test(commentLine), 'next statement is not pulled onto the comment line');
    assert.ok(/CALL p_next\(id\);/.test(out), 'next statement survives as code');
});

test('a nested multiline CASE in an ELSE branch is rendered as its own block', () => {
    const out = formatSql([
        'SELECT',
        '  CASE',
        '    WHEN a IS NULL THEN NULL',
        '    ELSE CASE b',
        "      WHEN 'AV' THEN f_av()",
        "      WHEN 'GV' THEN f_gv()",
        "      WHEN 'AB' THEN f_ab()",
        '      ELSE NULL',
        '    END',
        '  END AS antwort',
        'FROM t;'
    ].join('\n'));
    const lines = out.split('\n');
    // Each WHEN of the inner CASE must be on its own line, not collapsed.
    assert.ok(lines.some(l => /^\s*WHEN 'AV' THEN f_av\(\)\s*$/.test(l)), "WHEN 'AV' on its own line");
    assert.ok(lines.some(l => /^\s*WHEN 'GV' THEN f_gv\(\)\s*$/.test(l)), "WHEN 'GV' on its own line");
    assert.ok(lines.some(l => /^\s*WHEN 'AB' THEN f_ab\(\)\s*$/.test(l)), "WHEN 'AB' on its own line");
    // The inner WHENs are indented deeper than the inner CASE/ELSE keyword.
    const elseLine = lines.find(l => /^\s*ELSE\s*$/.test(l))!;
    const innerCaseLine = lines.find(l => /^\s*CASE b\s*$/.test(l))!;
    const avLine = lines.find(l => /WHEN 'AV'/.test(l))!;
    const indent = (s: string): number => s.match(/^\s*/)![0].length;
    assert.ok(indent(innerCaseLine) > indent(elseLine), 'inner CASE is indented past ELSE');
    assert.ok(indent(avLine) > indent(innerCaseLine), 'inner WHEN is indented past inner CASE');
});

test('a nested multiline CASE in a THEN result is rendered as its own block', () => {
    const out = formatSql([
        'SELECT',
        '  CASE',
        '    WHEN a IS NOT NULL THEN CASE b',
        "      WHEN 'X' THEN 1",
        "      WHEN 'Y' THEN 2",
        '      ELSE 0',
        '    END',
        '    ELSE NULL',
        '  END AS v',
        'FROM t;'
    ].join('\n'));
    const lines = out.split('\n');
    assert.ok(lines.some(l => /^\s*WHEN 'X' THEN 1\s*$/.test(l)), "inner WHEN 'X' on its own line");
    assert.ok(lines.some(l => /^\s*WHEN 'Y' THEN 2\s*$/.test(l)), "inner WHEN 'Y' on its own line");
});

test('indents a CASE statement and breaks the body after THEN', () => {
    const out = formatSql([
        'BEGIN',
        'CASE',
        "WHEN pi_import_name = 'ImpCostCateg' THEN",
        'v_text := v_column_line;',
        'IF pi_param1 IS NOT NULL THEN',
        'v_prefix := v_text || pi_param1;',
        'ELSE',
        'v_prefix := v_text;',
        'END IF;',
        'ELSE',
        'v_retwert := v_unknown;  --Unknown message type',
        'END CASE;',
        'END;'
    ].join('\n'));
    assert.equal(
        out,
        [
            'BEGIN',
            '  CASE',
            "    WHEN pi_import_name = 'ImpCostCateg' THEN",
            '      v_text := v_column_line;',
            '      IF pi_param1 IS NOT NULL THEN',
            '        v_prefix := v_text || pi_param1;',
            '      ELSE',
            '        v_prefix := v_text;',
            '      END IF;',
            '    ELSE',
            '      v_retwert := v_unknown;  --Unknown message type',
            '  END CASE;',
            'END;'
        ].join('\n')
    );
});

test('formats a query FOR loop: indents the query and dedents LOOP', () => {
    const out = formatSql([
        'BEGIN',
        'FOR v_item IN',
        'SELECT *',
        'FROM unnest(v_web.items) AS item',
        'WHERE item.lei_id = v_err.row_id LOOP',
        'v_web_item := v_item;',
        'EXIT;  -- Take first match',
        'END LOOP;',
        'END;'
    ].join('\n'));
    assert.equal(
        out,
        [
            'BEGIN',
            '  FOR v_item IN',
            '    SELECT *',
            '    FROM unnest(v_web.items) AS item',
            '    WHERE item.lei_id = v_err.row_id',
            '  LOOP',
            '    v_web_item := v_item;',
            '    EXIT;  -- Take first match',
            '  END LOOP;',
            'END;'
        ].join('\n')
    );
});

test('keeps an integer FOR loop header compact', () => {
    const out = formatSql('BEGIN\nFOR i IN 1..10 LOOP\ndo_it(i);\nEND LOOP;\nEND;');
    assert.equal(
        out,
        [
            'BEGIN',
            '  FOR i IN 1..10 LOOP',
            '    do_it(i);',
            '  END LOOP;',
            'END;'
        ].join('\n')
    );
});

test('breaks a parenthesised boolean group across lines', () => {
    const out = formatSql(
        "SELECT * FROM pg_proc WHERE pg_proc.pronamespace <> 'pg_catalog'::regnamespace AND (pg_proc.prorettype <> 'pg_catalog.trigger'::regtype OR pg_trigger.tgfoid IS NOT NULL);"
    );
    assert.equal(
        out,
        [
            'SELECT *',
            'FROM pg_proc',
            "WHERE pg_proc.pronamespace <> 'pg_catalog'::regnamespace",
            '  AND (',
            "    pg_proc.prorettype <> 'pg_catalog.trigger'::regtype",
            '    OR pg_trigger.tgfoid IS NOT NULL',
            '  );'
        ].join('\n')
    );
});

test('indents AND one level deeper than OR when a boolean group mixes both', () => {
    const sql = "SELECT * FROM t WHERE a NOT LIKE 'obj_%' AND b NOT LIKE 'ad_%' "
        + "AND (c NOT LIKE 'ole_%' AND d LIKE 'e1%' AND e LIKE 'e2%' "
        + "OR f LIKE 'debug%' AND g LIKE 'e3%' "
        + "OR i LIKE 'debug2%' AND j LIKE 'e5%');";
    assert.equal(
        formatSql(sql),
        [
            'SELECT *',
            'FROM t',
            "WHERE a NOT LIKE 'obj_%'",
            "  AND b NOT LIKE 'ad_%'",
            '  AND (',
            "    c NOT LIKE 'ole_%'",
            "      AND d LIKE 'e1%'",
            "      AND e LIKE 'e2%'",
            "    OR f LIKE 'debug%'",
            "      AND g LIKE 'e3%'",
            "    OR i LIKE 'debug2%'",
            "      AND j LIKE 'e5%'",
            '  );'
        ].join('\n')
    );
});

test('indents AND one level deeper than OR in mixed IF conditions', () => {
    const sql = [
        'BEGIN',
        'IF a = 1 AND b = 2 OR c = 3 AND d = 4 THEN',
        'do_it();',
        'END IF;',
        'END;'
    ].join('\n');
    assert.equal(
        formatSql(sql),
        [
            'BEGIN',
            '  IF a = 1',
            '      AND b = 2',
            '    OR c = 3',
            '      AND d = 4',
            '  THEN',
            '    do_it();',
            '  END IF;',
            'END;'
        ].join('\n')
    );
});

test('indents AND one level deeper than OR in mixed CASE WHEN conditions', () => {
    const sql = [
        'SELECT CASE',
        '  WHEN a = 1 AND b = 2 OR c = 3 AND d = 4 THEN 1',
        '  ELSE 0',
        'END AS v',
        'FROM t;'
    ].join('\n');
    assert.equal(
        formatSql(sql),
        [
            'SELECT CASE',
            '  WHEN a = 1',
            '      AND b = 2',
            '    OR c = 3',
            '      AND d = 4',
            '  THEN',
            '    1',
            '  ELSE 0',
            'END AS v',
            'FROM t;'
        ].join('\n')
    );
});

test('a JOIN ON that mixes AND and OR indents AND one level deeper than OR', () => {
    const sql = 'SELECT x FROM a JOIN b ON a.x = b.x AND a.y = b.y OR a.z = b.z AND a.w = b.w;';
    assert.equal(
        formatSql(sql),
        [
            'SELECT x',
            'FROM a',
            'JOIN b',
            '   ON a.x = b.x',
            '    AND a.y = b.y',
            '   OR a.z = b.z',
            '    AND a.w = b.w;'
        ].join('\n')
    );
});


test('a INNER JOIN ON that mixes AND and OR indents AND one level deeper than OR', () => {
    const sql = 'SELECT x FROM a INNER JOIN b ON a.x = b.x AND a.y = b.y OR a.z = b.z AND a.w = b.w;';
    assert.equal(
        formatSql(sql),
        [
            'SELECT x',
            'FROM a',
            'INNER JOIN b',
            '   ON a.x = b.x',
            '    AND a.y = b.y',
            '   OR a.z = b.z',
            '    AND a.w = b.w;'
        ].join('\n')
    );
});

test('keeps non-boolean groups inline (arithmetic, IN list, BETWEEN)', () => {
    assert.equal(formatSql('select (a + b) * c from t;'), 'SELECT (a + b) * c FROM t;');
    assert.equal(formatSql('select a from t where x in (1, 2, 3);'), 'SELECT a FROM t WHERE x IN (1, 2, 3);');
    assert.equal(formatSql('select a from t where (x between 1 and 5);'), 'SELECT a FROM t WHERE (x BETWEEN 1 AND 5);');
});

test('produces stable output when formatted repeatedly (idempotent)', () => {
    const src =
        "SELECT * FROM pg_proc WHERE pg_proc.prolang = (SELECT lang.OID FROM pg_language lang WHERE lang.lanname = 'plpgsql') AND (pg_proc.prorettype <> 'pg_catalog.trigger'::regtype OR pg_trigger.tgfoid IS NOT NULL);";
    const once = formatSql(src);
    assert.equal(formatSql(once), once);
});

test('moves THEN to its own line when an IF condition is broken across lines', () => {
    // With ifConditions default {1, 3}: 2 conditions on one source line follow source (stay inline).
    const inlineInput = 'BEGIN\nIF a.amount IS NULL OR a.amount = 0 THEN\ndo_something();\nEND IF;\nEND;';
    assert.equal(
        formatSql(inlineInput),
        'BEGIN\n  IF a.amount IS NULL OR a.amount = 0 THEN\n    do_something();\n  END IF;\nEND;'
    );
    // 3 conditions reach multilineMin → THEN moves to its own line.
    const multiInput = 'BEGIN\nIF a IS NULL OR b = 0 OR c > 1 THEN\ndo_something();\nEND IF;\nEND;';
    assert.equal(
        formatSql(multiInput),
        [
            'BEGIN',
            '  IF a IS NULL',
            '    OR b = 0',
            '    OR c > 1',
            '  THEN',
            '    do_something();',
            '  END IF;',
            'END;'
        ].join('\n')
    );
});

test('keeps THEN inline for a single-line IF condition', () => {
    const out = formatSql('BEGIN\nIF x > 1 THEN\ndo_it();\nEND IF;\nEND;');
    assert.equal(
        out,
        [
            'BEGIN',
            '  IF x > 1 THEN',
            '    do_it();',
            '  END IF;',
            'END;'
        ].join('\n')
    );
});

test('wraps an INSERT VALUES list when the column list is multi-line', () => {
    const out = formatSql(
        'INSERT INTO t (\na,\nb,\nc,\nd\n) VALUES (\n1,\n2,\n3,\n4\n);'
    );
    assert.equal(
        out,
        [
            'INSERT INTO t(',
            '  a,',
            '  b,',
            '  c,',
            '  d',
            ')',
            'VALUES (',
            '  1,',
            '  2,',
            '  3,',
            '  4',
            ');'
        ].join('\n')
    );
});

test('keeps an INSERT with at most two columns on one line', () => {
    const out = formatSql('INSERT INTO t (\na,\nb\n) VALUES (\n1,\n2\n);');
    assert.equal(out, 'INSERT INTO t(a, b)\nVALUES (1, 2);');
});

test('keeps a single-line 3-5 column INSERT on one line', () => {
    assert.equal(
        formatSql('INSERT INTO t (a, b, c) VALUES (1, 2, 3);'),
        'INSERT INTO t(a, b, c)\nVALUES (1, 2, 3);'
    );
    assert.equal(
        formatSql('INSERT INTO t (a, b, c, d) VALUES (1, 2, 3, 4);'),
        'INSERT INTO t(a, b, c, d)\nVALUES (1, 2, 3, 4);'
    );
});

test('wraps an INSERT with ten or more columns even from a single source line', () => {
    // insertColumns default {2, 10}: 10 columns always wrap regardless of source layout.
    const out = formatSql('INSERT INTO t (a, b, c, d, e, f, g, h, i, j) VALUES (1, 2, 3, 4, 5, 6, 7, 8, 9, 10);');
    assert.equal(
        out,
        [
            'INSERT INTO t(',
            '  a,',
            '  b,',
            '  c,',
            '  d,',
            '  e,',
            '  f,',
            '  g,',
            '  h,',
            '  i,',
            '  j',
            ')',
            'VALUES (',
            '  1,',
            '  2,',
            '  3,',
            '  4,',
            '  5,',
            '  6,',
            '  7,',
            '  8,',
            '  9,',
            '  10',
            ');'
        ].join('\n')
    );
});

test('wraps a CREATE TYPE attribute list with many attributes', () => {
    const out = formatSql(
        'CREATE TYPE s.tr_obj AS (travelid NUMERIC, employee tr_obj_employee, generalinfo tr_obj_travelgeneral, status tr_obj_status);'
    );
    assert.equal(
        out,
        [
            'CREATE TYPE s.tr_obj AS (',
            '  travelid NUMERIC,',
            '  employee tr_obj_employee,',
            '  generalinfo tr_obj_travelgeneral,',
            '  status tr_obj_status',
            ');'
        ].join('\n')
    );
});

test('keeps a single-attribute CREATE TYPE on one line, wraps two or more', () => {
    // createType default {1, 2}: 1 attr stays inline, 2+ attrs always wrap.
    assert.equal(formatSql('CREATE TYPE t AS (a INTEGER);'), 'CREATE TYPE t AS (a INTEGER);');
    assert.equal(
        formatSql('CREATE TYPE t AS (a INTEGER, b TEXT);'),
        ['CREATE TYPE t AS (', '  a INTEGER,', '  b TEXT', ');'].join('\n')
    );
});

test('keeps a comma FROM list broken when it was multi-line in the source', () => {
    const out = formatSql('SELECT a\nFROM t1 x\n, t2 y\n, t3 z\nWHERE x.id = y.id;');
    assert.equal(
        out,
        [
            'SELECT a',
            'FROM',
            '  t1 x,',
            '  t2 y,',
            '  t3 z',
            'WHERE x.id = y.id;'
        ].join('\n')
    );
});

test('keeps a single-line comma FROM list on one line', () => {
    assert.equal(
        formatSql('SELECT a FROM t1, t2, t3 WHERE t1.id = t2.id;'),
        'SELECT a\nFROM t1, t2, t3\nWHERE t1.id = t2.id;'
    );
});

test('applies separate thresholds per construct', () => {
    // Function calls use {1, 4}: three args sit in the middle band and stay
    // inline when the source is single-line, but wrap when it was multi-line.
    assert.equal(formatSql('call f(a, b, c);'), 'CALL f(a, b, c);');
    assert.equal(
        formatSql('call f(\na,\nb,\nc\n);'),
        ['CALL f(', '  a,', '  b,', '  c', ');'].join('\n')
    );
    // INSERT uses {2, 6}: five columns stay inline from a single source line,
    // six columns always wrap.
    assert.equal(
        formatSql('INSERT INTO t (a, b, c, d, e) VALUES (1, 2, 3, 4, 5);'),
        'INSERT INTO t(a, b, c, d, e)\nVALUES (1, 2, 3, 4, 5);'
    );
    // CREATE TYPE uses {1, 4}: four attributes always wrap.
    assert.equal(
        formatSql('CREATE TYPE t AS (a INT, b INT, c INT, d INT);'),
        ['CREATE TYPE t AS (', '  a INT,', '  b INT,', '  c INT,', '  d INT', ');'].join('\n')
    );
    // ROW(...) uses the same defaults as list-like call parentheses ({1, 4}).
    assert.equal(
        formatSql('SELECT ROW(1, 2, 3);'),
        'SELECT ROW(1, 2, 3);'
    );
    assert.equal(
        formatSql('SELECT ROW(1, 2, 3, 4, 5, 6);'),
        ['SELECT ROW(', '  1,', '  2,', '  3,', '  4,', '  5,', '  6', ');'].join('\n')
    );
});

test('indents subqueries inside parentheses', () => {
    const out = formatSql('select a from (select x from inner_t where x>0) sub;');
    assert.equal(
        out,
        [
            'SELECT a',
            'FROM (',
            '  SELECT x',
            '  FROM inner_t',
            '  WHERE x > 0',
            ') sub;'
        ].join('\n')
    );
});

test('indents scalar subqueries in a SELECT column list', () => {
    const out = formatSql(
        'SELECT a,\n(SELECT COUNT(*) FROM t WHERE t.id = base.id) AS cnt\nFROM base;'
    );
    assert.equal(
        out,
        [
            'SELECT',
            '  a,',
            '  (',
            '    SELECT COUNT(*)',
            '    FROM t',
            '    WHERE t.id = base.id',
            '  ) AS cnt',
            'FROM base;'
        ].join('\n')
    );
});

test('indents scalar subqueries in a SELECT column list inside a PL/pgSQL block', () => {
    const out = formatSql(
        "BEGIN\n  RETURN QUERY\n  SELECT\n    mtd.id,\n    (SELECT COUNT(*) FROM expenses e WHERE e.mtd_id = mtd.id) AS expense_count\n  FROM timedata mtd;\nEND;"
    );
    assert.equal(
        out,
        [
            'BEGIN',
            '  RETURN QUERY',
            '  SELECT',
            '    mtd.id,',
            '    (',
            '      SELECT COUNT(*)',
            '      FROM expenses e',
            '      WHERE e.mtd_id = mtd.id',
            '    ) AS expense_count',
            '  FROM timedata mtd;',
            'END;'
        ].join('\n')
    );
});

test('breaks UPDATE ... SET assignments onto separate lines', () => {
    const out = formatSql('update tbl set a=1, b=2 where id=5;');
    assert.equal(
        out,
        ['UPDATE tbl', 'SET', '  a = 1,', '  b = 2', 'WHERE id = 5;'].join('\n')
    );
});

test('does not add spaces around JSON path operators ->, ->>, #>, #>>', () => {
    assert.equal(formatSql("select v_json->>'key' from t;"), "SELECT v_json->>'key' FROM t;");
    assert.equal(formatSql("select v_json->'obj' from t;"), "SELECT v_json->'obj' FROM t;");
    assert.equal(formatSql("select v_json#>'{a,b}' from t;"), "SELECT v_json#>'{a,b}' FROM t;");
    assert.equal(formatSql("select v_json#>>'{a,b}' from t;"), "SELECT v_json#>>'{a,b}' FROM t;");
    assert.equal(
        formatSql("select a from t where v_json->>'status' = 'active';"),
        "SELECT a FROM t WHERE v_json->>'status' = 'active';"
    );
    // Chains should also be compact
    assert.equal(
        formatSql("select data->'user'->>'name' from t;"),
        "SELECT data->'user'->>'name' FROM t;"
    );
});

test('keeps DISTINCT ON (...) on the SELECT line', () => {
    // selectColumns default {1, 3}: 2 columns follow source layout (single-line → stays inline).
    const out = formatSql('select distinct on (a) a, b from t;');
    assert.equal(out, 'SELECT DISTINCT ON (a) a, b\nFROM t;');
});

test('supports leading comma style', () => {
    const out = formatSql('select a,b,c from t', { commaStyle: 'leading' });
    assert.equal(out, ['SELECT', '  a', '  , b', '  , c', 'FROM t'].join('\n'));
});

test('respects indentSize and tab indentation', () => {
    // selectColumns default {1, 3}: 2 columns follow source (single-line → stays inline).
    assert.equal(formatSql('select a,b from t', { indentSize: 4 }), 'SELECT a, b\nFROM t');
    assert.equal(formatSql('select a,b from t', { indentStyle: 'tab' }), 'SELECT a, b\nFROM t');
    // With 3 columns the threshold fires and indentSize / indentStyle take effect.
    assert.equal(formatSql('select a,b,c from t', { indentSize: 4 }), 'SELECT\n    a,\n    b,\n    c\nFROM t');
    assert.equal(formatSql('select a,b,c from t', { indentStyle: 'tab' }), 'SELECT\n\ta,\n\tb,\n\tc\nFROM t');
});

test('keywordCase lower and identifierCase preserve', () => {
    assert.equal(formatSql('SELECT Foo FROM Bar', { keywordCase: 'lower' }), 'select Foo from Bar');
});

test('dataTypeCase is applied independently of keywordCase', () => {
    const out = formatSql('declare x integer; begin end;', { keywordCase: 'lower', dataTypeCase: 'upper' });
    assert.equal(out, ['declare', '  x INTEGER;', 'begin', 'end;'].join('\n'));
});

test('preserves string and comment contents verbatim', () => {
    const out = formatSql("select 'Keep  ME' /* note: from where */ as c from t;");
    assert.ok(out.includes("'Keep  ME'"));
    assert.ok(out.includes('/* note: from where */'));
});

test('preserves authored blank lines between statements (1:1)', () => {
    const out = formatSql('select 1;\n\n\nselect 2;');
    assert.equal(out, ['SELECT 1;', '', '', 'SELECT 2;'].join('\n'));
});

test('collapses blank lines when blankLines is collapse', () => {
    const out = formatSql('select 1;\n\n\nselect 2;', { blankLines: 'collapse' });
    assert.equal(out, ['SELECT 1;', '', 'SELECT 2;'].join('\n'));
});

test('preserves authored blank lines before a non-clause statement (e.g. CREATE)', () => {
    // createTable default {0, 1}: even 1 column wraps.
    assert.equal(
        formatSql('create table a(x int);\n\n\ncreate table b(y int);'),
        'CREATE TABLE a(\n  x INT\n);\n\n\nCREATE TABLE b(\n  y INT\n);'
    );
});

test('preserves a trailing newline when present', () => {
    assert.equal(formatSql('select 1\n'), 'SELECT 1\n');
    assert.equal(formatSql('select 1'), 'SELECT 1');
});

test('is idempotent (re-formatting yields the same result)', () => {
    const inputs = [
        'select a,b from foo f join bar b on b.id=f.bid where a=1 order by a',
        "create function f() returns void as $$ declare x int; begin if x>0 then perform g(); end if; end; $$ language plpgsql;",
        'update t set a=1,b=2 where id=5;'
    ];
    for (const sql of inputs) {
        const once = formatSql(sql);
        assert.equal(formatSql(once), once, `not idempotent for: ${sql}`);
    }
});

test('does not lose tokens (all words survive formatting)', () => {
    const sql = 'select alpha, beta, gamma from delta where epsilon = zeta';
    const out = formatSql(sql);
    for (const word of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) {
        assert.ok(out.toLowerCase().includes(word), `missing ${word}`);
    }
});

test('safety net: formatting never changes the semantic token stream', () => {
    const inputs = [
        'select a,b from foo f join bar b on b.id=f.bid where a=1 order by a',
        "create function f() returns void as $$ declare x int; begin if x>0 then perform g(); end if; end; $$ language plpgsql;",
        'update t set a=1,b=2 where id=5;',
        [
            'SELECT CASE rgl_antwort',
            "  WHEN 'AV' THEN f_av() -- comment",
            "  WHEN 'GV' THEN f_gv()",
            '  ELSE NULL',
            'END AS antwort',
            'FROM t;'
        ].join('\n'),
        [
            'BEGIN',
            '  do_it(); -- run it',
            '  CALL p_next(id);',
            'END;'
        ].join('\n'),
        "select 'a  literal  with  spaces', E'\\n', q.\"Quoted Col\" from t;"
    ];
    for (const sql of inputs) {
        assert.ok(sqlSemanticallyEqual(sql, formatSql(sql)), `meaning changed for: ${sql}`);
    }
});

test('safety net: sqlSemanticallyEqual ignores whitespace and keyword case', () => {
    assert.ok(sqlSemanticallyEqual('select   A , b\nfrom t', 'SELECT a, b FROM t'));
    assert.ok(sqlSemanticallyEqual("a   --x\nb", 'a -- x\nb') === false, 'comment text is significant');
});

test('safety net: a comment that swallows code is detected as a different meaning', () => {
    // Correct: comment ends the line, code follows on the next line.
    const good = "WHEN 'AV' THEN f() -- note\nWHEN 'GV' THEN g()";
    // Corrupt: the WHEN 'GV' branch was pulled onto the comment line, so it is
    // now part of the comment and no longer live code.
    const corrupt = "WHEN 'AV' THEN f() -- note WHEN 'GV' THEN g()";
    assert.ok(!sqlSemanticallyEqual(good, corrupt), 'swallowed code must change the signature');
});

test('safety net: invalid/odd input is returned unchanged rather than corrupted', () => {
    // A line comment directly followed by code on the next line must keep the
    // code; round-tripping through the formatter preserves meaning.
    const sql = 'select 1 -- c\n, 2 from t;';
    assert.ok(sqlSemanticallyEqual(sql, formatSql(sql)));
});

test('sqlSemanticDiff returns null for equivalent SQL and a detail for divergence', () => {
    assert.equal(sqlSemanticDiff('select   A , b\nfrom t', 'SELECT a, b FROM t'), null);
    const good = "WHEN 'AV' THEN f() -- note\nWHEN 'GV' THEN g()";
    const corrupt = "WHEN 'AV' THEN f() -- note WHEN 'GV' THEN g()";
    const reason = sqlSemanticDiff(good, corrupt);
    assert.ok(reason, 'a divergence must be reported');
    assert.match(reason!, /token \d+/, 'reason names the diverging token position');
    assert.match(reason!, /lineComment/, 'reason mentions the offending comment token');
});

test('sqlSemanticDiff reports added and dropped tokens', () => {
    const added = sqlSemanticDiff('select a', 'select a, b');
    assert.ok(added && /added|tokens instead/.test(added), added ?? 'expected a reason');
    const dropped = sqlSemanticDiff('select a, b', 'select a');
    assert.ok(dropped && /dropped|missing|tokens instead/.test(dropped), dropped ?? 'expected a reason');
});

test('formatSqlChecked reports ok for valid input', () => {
    const r = formatSqlChecked('select a, b from t;');
    assert.equal(r.ok, true);
    assert.equal(r.reason, undefined);
    assert.ok(sqlSemanticallyEqual('select a, b from t;', r.text));
});

test('preserves trailing whitespace inside a multi-line string literal', () => {
    // A multi-line string literal (e.g. the body of a format('…') call) whose
    // interior lines carry trailing whitespace must be emitted verbatim. The
    // formatter used to strip trailing whitespace on *every* physical line,
    // including those inside string literals, which changed the code and made
    // the safety net silently disable formatting for the whole file.
    const src = [
        'CREATE OR REPLACE PROCEDURE foo()',
        'LANGUAGE plpgsql AS $procedure$',
        'BEGIN',
        "    v_sql := format('",
        '        INSERT INTO wtm_backend_communication (a, b)    ',
        '        VALUES (%L, %L)',
        "    ', x, y);",
        'END;',
        '$procedure$;',
    ].join('\n');
    const r = formatSqlChecked(src);
    assert.equal(r.reason, undefined);
    assert.equal(r.ok, true);
    // The literal's interior trailing spaces survive in the output.
    assert.ok(
        r.text.includes('INSERT INTO wtm_backend_communication (a, b)    \n'),
        'trailing whitespace inside the string literal should be preserved',
    );
});

test('still strips trailing whitespace on ordinary code lines', () => {
    const r = formatSqlChecked('select a,   \n       b from t;   \n');
    assert.equal(r.ok, true);
    assert.ok(!/[ \t]+\n/.test(r.text), 'code lines should not keep trailing whitespace');
    assert.ok(!/[ \t]+$/.test(r.text.replace(/\n$/, '')), 'no trailing whitespace at end');
});

test('DEFAULT_FORMAT_OPTIONS matches the agreed defaults', () => {
    assert.deepEqual(DEFAULT_FORMAT_OPTIONS, {
        keywordCase: 'upper',
        identifierCase: 'preserve',
        dataTypeCase: 'upper',
        indentStyle: 'space',
        indentSize: 2,
        commaStyle: 'trailing',
        blankLines: 'preserve',
        simpleSelectSingleLine: true,
        preserveSingleLineRoutineHeaders: true,
        preserveSingleLineIfBlocks: true,
        thresholds: DEFAULT_THRESHOLDS,
        normalizeDataTypes: true,
        dataTypeAliases: {
            'timestamp without time zone': 'timestamp',
            'timestamp with time zone': 'timestamptz',
            'time without time zone': 'time',
            'time with time zone': 'timetz',
            int2: 'smallint',
            int4: 'integer',
            int8: 'bigint',
            'character varying': 'varchar',
            'bit varying': 'varbit'
        }
    });
});

test('does not break before IF in CREATE SCHEMA IF NOT EXISTS', () => {
    assert.equal(formatSql('CREATE SCHEMA IF NOT EXISTS pk_x;'), 'CREATE SCHEMA IF NOT EXISTS pk_x;');
    assert.equal(formatSql('drop table if exists t;'), 'DROP TABLE IF EXISTS t;');
});

test('keeps a type modifier attached to its data type (no space)', () => {
    const out = formatSql('declare x varchar(500); y numeric(10,2); begin end;');
    assert.ok(out.includes('x VARCHAR(500);'), out);
    assert.ok(out.includes('y NUMERIC(10, 2);'), out);
});

test('attaches %TYPE / %ROWTYPE to the name without spaces (but keeps modulo spaced)', () => {
    const out = formatSql('declare v_mitRec bos_mitarbeiter%ROWTYPE; x t.c%TYPE; begin end;');
    assert.ok(out.includes('v_mitRec bos_mitarbeiter%ROWTYPE;'), out);
    assert.ok(out.includes('x t.c%TYPE;'), out);
    assert.equal(formatSql('select a % b from t;'), 'SELECT a % b FROM t;');
});

test('keeps format() specifiers %L, %I and %s intact when a dollar-quoted body is reformatted', () => {
    const src = [
        'CREATE OR REPLACE PROCEDURE p()',
        'LANGUAGE plpgsql AS $body$',
        'DECLARE v_sql TEXT;',
        'BEGIN',
        '  v_sql := format($outer$',
        '    SELECT * FROM t WHERE a = %L AND b = %I AND c = %s',
        '  $outer$, x, y, z);',
        '  EXECUTE v_sql;',
        'END;',
        '$body$;',
    ].join('\n');
    const out = formatSql(src);
    assert.ok(out.includes('a = %L'), out);
    assert.ok(out.includes('b = %I'), out);
    assert.ok(out.includes('c = %s'), out);
    assert.ok(!/%\s+[LIs]\b/.test(out), 'a space must never be inserted between % and its type char\n' + out);
});

test('does not merge % into a following identifier that is not a format type char', () => {
    // `%system` is a modulo of the identifier `system`, not a format specifier.
    assert.equal(formatSql('select a %system from t;'), 'SELECT a % system FROM t;');
    // A modulo written with spaces is unaffected.
    assert.equal(formatSql('select a % l from t;'), 'SELECT a % l FROM t;');
});

test('format() specifier keeps the code semantically identical (safety net not tripped)', () => {
    const src = [
        'DO $outer$',
        'BEGIN',
        '  EXECUTE format($inner$ DELETE FROM t WHERE id = %L $inner$, 1);',
        'END',
        '$outer$;',
    ].join('\n');
    const r = formatSqlChecked(src);
    assert.equal(r.ok, true, r.reason);
    assert.ok(r.text.includes('id = %L'), r.text);
});

test('reformats a multi-line SQL statement inside a dollar-quoted format() template', () => {
    const src = [
        'CREATE OR REPLACE FUNCTION x.f() RETURNS void LANGUAGE plpgsql AS $BODY$',
        'DECLARE v_sql TEXT;',
        'BEGIN',
        '  v_sql := format(',
        '    $query$ SELECT a AS x,',
        '    b',
        ' FROM t',
        ' WHERE c = %L AND d = %L',
        '    $query$,',
        '    p1,',
        '    p2);',
        'END;',
        '$BODY$;',
    ].join('\n');
    const r = formatSqlChecked(src);
    assert.equal(r.ok, true, r.reason);
    // The inner SELECT is now structured onto its own clause lines.
    assert.ok(/\$query\$\n\s*SELECT\n/.test(r.text), 'SELECT should start a fresh line inside the body\n' + r.text);
    assert.ok(/\n\s*FROM t\n/.test(r.text), 'FROM should be on its own line\n' + r.text);
    assert.ok(/\n\s*WHERE c = %L\n\s*AND d = %L/.test(r.text), 'WHERE/AND should wrap; %L stays intact\n' + r.text);
    // The opening and closing $query$ tags share one indentation level and the
    // body is indented exactly one level (indentSize spaces) deeper.
    const lines = r.text.split('\n');
    const indentOf = (l: string): number => l.match(/^ */)![0].length;
    const openIndent = indentOf(lines.find(l => l.trim() === '$query$')!);
    const closeIndent = indentOf(lines.find(l => l.trim() === '$query$,')!);
    const selectIndent = indentOf(lines.find(l => l.trim() === 'SELECT')!);
    assert.equal(openIndent, closeIndent, 'opening and closing $query$ tags must be at the same indent\n' + r.text);
    assert.equal(selectIndent, openIndent + 2, 'body must be one level (2 spaces) deeper than the tags\n' + r.text);
    // Formatting is stable on a second pass.
    assert.equal(formatSql(r.text), r.text);
});

test('leaves a single-line SQL function body inline (does not force it multi-line)', () => {
    const out = formatSql("CREATE FUNCTION g() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;");
    assert.ok(out.includes('AS $$ SELECT 1 $$;'), out);
});

test('leaves a non-SQL dollar-quoted body verbatim', () => {
    // A plain-text body that does not start with a SQL statement keyword is untouched.
    const src = "SELECT set_config('x', $doc$line one\nline two$doc$, false);";
    const out = formatSql(src);
    assert.ok(out.includes('$doc$line one\nline two$doc$'), out);
});

test('normalizes verbose data type names to their short form', () => {
    const out = formatSql('declare a character varying(500); b timestamp without time zone; c timestamp with time zone; begin end;');
    assert.ok(out.includes('a VARCHAR(500);'), out);
    assert.ok(out.includes('b TIMESTAMP;'), out);
    assert.ok(out.includes('c TIMESTAMPTZ;'), out);
    assert.equal(
        formatSql('select cast(x as character varying) from t;'),
        'SELECT CAST (x AS VARCHAR) FROM t;'
    );
});

test('normalizes int2/int4/int8 aliases to canonical integer type names', () => {
    const out = formatSql('declare a int2; b int4; c int8; begin end;');
    assert.ok(out.includes('a SMALLINT;'), out);
    assert.ok(out.includes('b INTEGER;'), out);
    assert.ok(out.includes('c BIGINT;'), out);
});

test('normalizeDataTypes can be disabled', () => {
    const out = formatSql('declare a character varying(500); begin end;', { normalizeDataTypes: false });
    assert.ok(out.includes('a CHARACTER VARYING(500);'), out);
});

test('dataTypeAliases table can be customized', () => {
    const out = formatSql('declare a double precision; begin end;', {
        dataTypeAliases: { 'double precision': 'float8' }
    });
    assert.ok(out.includes('a FLOAT8;'), out);
});

test('dataTypeAliases table can disable default replacements by overriding entries', () => {
    const out = formatSql('declare a character varying(500); begin end;', {
        dataTypeAliases: { 'character varying': 'character varying' }
    });
    assert.ok(out.includes('a CHARACTER VARYING(500);'), out);
});

test('coerceFormatOptions accepts dataTypeAliases from settings table', () => {
    const opts = coerceFormatOptions({ dataTypeAliases: { 'double precision': 'float8' } });
    assert.equal(opts.dataTypeAliases['double precision'], 'float8');
    assert.equal(opts.dataTypeAliases['character varying'], 'varchar');
});

test('does not treat FROM/FOR inside a function call as SQL clauses', () => {
    const out = formatSql("select substring(SQLERRM from 1 for 500);");
    assert.equal(out, 'SELECT substring(SQLERRM FROM 1 FOR 500);');
});

test('keeps commas inside ARRAY[...] on one line', () => {
    const out = formatSql('select array[1, 2, 3, 4, 5];');
    assert.equal(out, 'SELECT ARRAY[1, 2, 3, 4, 5];');
});

test('formats a CREATE PROCEDURE header (params on own lines, characteristics own lines)', () => {
    // createProcedure default {0, 1}: any parameter count wraps to individual lines.
    const out = formatSql(
        'create or replace procedure p.add_text(inout po text, in pi text) language plpgsql as $procedure$ begin\n po := po || pi; end; $procedure$;'
    );
    assert.equal(
        out,
        [
            'CREATE OR REPLACE PROCEDURE p.add_text(',
            '  INOUT po TEXT,',
            '  IN pi TEXT',
            ')',
            '  LANGUAGE plpgsql',
            'AS $procedure$',
            'BEGIN',
            '  po := po || pi;',
            'END;',
            '$procedure$;'
        ].join('\n')
    );
});

test('wraps a routine parameter list when it has many parameters', () => {
    const out = formatSql(
        'create function f(a int, b int, c int, d int) returns int language sql as $f$ begin\n return 1; end; $f$;'
    );
    const lines = out.split('\n');
    assert.equal(lines[0], 'CREATE FUNCTION f(');
    assert.equal(lines[1], '  a INT,');
    assert.equal(lines[5], ') RETURNS INT');
});

test('keeps a trailing line comment on the same line (after a semicolon)', () => {
    assert.equal(formatSql('select 1; -- note'), 'SELECT 1;  -- note');
    const routine = formatSql(
        "CREATE FUNCTION pk.g() RETURNS VARCHAR LANGUAGE SQL STABLE AS $$ SELECT f(1); $$; --x"
    );
    assert.equal(routine, 'CREATE FUNCTION pk.g() RETURNS VARCHAR LANGUAGE SQL STABLE AS $$ SELECT f(1); $$;  --x');
    // A comment authored on its own line still gets its own line.
    assert.equal(formatSql('select 1;\n-- standalone\nselect 2;'), 'SELECT 1;\n-- standalone\nSELECT 2;');
});

test('a line comment on its own source line is not pulled onto the preceding expression line', () => {
    // Comment on next line inside a boolean group must stay on its own line.
    const out = formatSql(
        "SELECT a FROM t WHERE x = 0 AND (\n  c1 = 'A'\n  -- my note\n  OR c2 = 'B'\n);"
    );
    assert.equal(
        out,
        [
            'SELECT a',
            'FROM t',
            'WHERE x = 0',
            "  AND (",
            "    c1 = 'A'",
            '    -- my note',
            "    OR c2 = 'B'",
            '  );'
        ].join('\n')
    );
    // Trailing comment on the same source line is still kept on that line.
    assert.equal(
        formatSql("SELECT a FROM t WHERE x = 0 AND (\n  c1 = 'A' -- inline\n  OR c2 = 'B'\n);"),
        "SELECT a\nFROM t\nWHERE x = 0\n  AND (\n    c1 = 'A'  -- inline\n    OR c2 = 'B'\n  );"
    );
});

test('preserves an authored blank line before a standalone comment', () => {
    const out = formatSql('declare\n  a int := 1;\n\n  -- group\n  b int := 2;\nbegin end;');
    assert.equal(
        out,
        ['DECLARE', '  a INT := 1;', '', '  -- group', '  b INT := 2;', 'BEGIN', 'END;'].join('\n')
    );
});

test('keeps prefixed string literals intact (E\'...\' / B\'...\' / X\'...\' / U&\'...\')', () => {
    assert.equal(formatSql("select E'\\n';"), "SELECT E'\\n';");
    assert.ok(formatSql("select e'\\t';").includes("e'\\t'"));
    assert.ok(formatSql("select B'1010';").includes("B'1010'"));
    assert.ok(formatSql("select x'1f';").includes("x'1f'"));
    assert.ok(formatSql("select U&'\\0041';").includes("U&'\\0041'"));
    // A normal identifier starting with E is unaffected.
    assert.equal(formatSql('select each_col from t;'), 'SELECT each_col FROM t;');
});

test('keeps a CREATE FUNCTION written on a single line on one line', () => {
    const out = formatSql(
        "CREATE FUNCTION pk.g_pair() RETURNS varchar LANGUAGE SQL IMMUTABLE AS $$ SELECT 'X'; $$;"
    );
    assert.equal(out, "CREATE FUNCTION pk.g_pair() RETURNS VARCHAR LANGUAGE SQL IMMUTABLE AS $$ SELECT 'X'; $$;");
});

test('single-line CREATE FUNCTION special case can be disabled', () => {
    const out = formatSql(
        "CREATE FUNCTION pk.g_pair() RETURNS varchar LANGUAGE SQL IMMUTABLE AS $$ SELECT 'X'; $$;",
        { preserveSingleLineRoutineHeaders: false }
    );
    assert.equal(
        out,
        [
            'CREATE FUNCTION pk.g_pair() RETURNS VARCHAR',
            '  LANGUAGE SQL',
            '  IMMUTABLE',
            "AS $$ SELECT 'X'; $$;"
        ].join('\n')
    );
});

test('still expands a CREATE FUNCTION that the author wrote across lines', () => {
    const out = formatSql(
        "create function pk.g_pair() returns varchar language sql immutable as $$\nselect 'X';\n$$;"
    );
    assert.ok(out.includes('\n'), out);
    assert.ok(out.startsWith('CREATE FUNCTION pk.g_pair() RETURNS VARCHAR'), out);
});

test('createFunction threshold overrides preserveSingleLineRoutineHeaders for single-line input with 2 params', () => {
    // Regression: when preserveSingleLineRoutineHeaders=true (default) and a
    // createFunction threshold of "0, 1" is configured (all params → multiline),
    // a single-line function header with 2 parameters must still be expanded.
    // Previously the CLI produced incorrect single-line output because the
    // preserveSingleLineRoutineHeaders shortcut bypassed the threshold check.
    const opts = coerceFormatOptions({ listThresholds: { createFunction: '0, 1' } });
    assert.equal(opts.thresholds.createFunction!.multilineMin, 1);

    const singleLine = 'CREATE FUNCTION f(a integer, b text) RETURNS void LANGUAGE sql AS $$ SELECT 1; $$;';
    const out = formatSql(singleLine, { ...opts, preserveSingleLineRoutineHeaders: true });
    assert.equal(
        out,
        [
            'CREATE FUNCTION f(',
            '  a INTEGER,',
            '  b TEXT',
            ') RETURNS VOID',
            '  LANGUAGE sql',
            'AS $$ SELECT 1; $$;'
        ].join('\n')
    );
});

test('createFunction threshold "0,1" via coerceFormatOptions expands single-line function with preserveSingleLineRoutineHeaders default', () => {
    // Simulates the CLI scenario: config file has listThresholds.createFunction="0, 1"
    // and preserveSingleLineRoutineHeaders is not set (defaults to true).
    const opts = coerceFormatOptions({ listThresholds: { createFunction: '0, 1' } });
    const singleLine = "CREATE FUNCTION my_schema.my_fn(p_id integer, p_name text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN NULL; END $$;";
    const out = formatSql(singleLine, opts);
    // Must be expanded to multiline despite preserveSingleLineRoutineHeaders: true
    assert.ok(out.includes('\n'), `Expected multiline output, got: ${out}`);
    assert.ok(out.includes('  p_id INTEGER,'), `Expected param on own line, got: ${out}`);
    assert.ok(out.includes('  p_name TEXT'), `Expected param on own line, got: ${out}`);
});

test('preserveSingleLineRoutineHeaders still works for a zero-param function with createFunction threshold "0,1"', () => {
    // A function with 0 params (inlineMax=0 covers it exactly as boundary: count=0 <= inlineMax=0 → inline).
    const opts = coerceFormatOptions({ listThresholds: { createFunction: '0, 1' } });
    const singleLine = "CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $$ SELECT 1; $$;";
    const out = formatSql(singleLine, opts);
    // Zero params: threshold says inline, so the single-line shortcut may keep it intact.
    assert.equal(out, "CREATE FUNCTION f() RETURNS VOID LANGUAGE sql AS $$ SELECT 1; $$;");
});

test('formats an EXCEPTION ... WHEN block', () => {
    const out = formatSql(
        "begin perform 1; exception when no_data_found then raise exception 'x'; when others then null; end;"
    );
    assert.equal(
        out,
        [
            'BEGIN',
            '  PERFORM 1;',
            'EXCEPTION',
            '  WHEN no_data_found THEN',
            "    RAISE EXCEPTION 'x';",
            '  WHEN OTHERS THEN',
            '    NULL;',
            'END;'
        ].join('\n')
    );
});

test('functionCallThreshold controls call wrapping', () => {
    assert.equal(formatSql('call f(a);'), 'CALL f(a);');
    assert.equal(formatSql('call f(a, b, c);'), 'CALL f(a, b, c);');
    const four = formatSql('call f(a, b, c, d);');
    assert.equal(four, ['CALL f(', '  a,', '  b,', '  c,', '  d', ');'].join('\n'));
    // Lowering the upper threshold forces two-argument calls to wrap.
    const two = formatSql('call f(a, b);', { thresholds: { functionCall: { inlineMax: 1, multilineMin: 2 } } });
    assert.equal(two, ['CALL f(', '  a,', '  b', ');'].join('\n'));
});

test('coerceFormatOptions accepts multilineMin of 1 so a single parameter can be forced to wrap', () => {
    const opts = coerceFormatOptions({ listThresholds: { createProcedure: '0, 1', createFunction: '0, 1' } });
    // "0, 1" must survive coercion (previously multilineMin was clamped up to 2).
    assert.deepEqual(opts.thresholds.createProcedure, { inlineMax: 0, multilineMin: 1 });
    assert.deepEqual(opts.thresholds.createFunction, { inlineMax: 0, multilineMin: 1 });

    // A one-parameter CREATE PROCEDURE now wraps its single parameter.
    const sql = [
        'CREATE PROCEDURE p(IN x integer)',
        'LANGUAGE plpgsql',
        'AS $$',
        'BEGIN',
        '  NULL;',
        'END',
        '$$;'
    ].join('\n');
    assert.equal(
        formatSql(sql, opts),
        [
            'CREATE PROCEDURE p(',
            '  IN x INTEGER',
            ')',
            '  LANGUAGE plpgsql',
            'AS $$',
            'BEGIN',
            '  NULL;',
            'END',
            '$$;'
        ].join('\n')
    );
});

test('coerceFormatOptions maps separate single-line toggles and supports legacy fallback', () => {
    const split = coerceFormatOptions({
        preserveSingleLineRoutineHeaders: false,
        preserveSingleLineIfBlocks: true
    });
    assert.equal(split.preserveSingleLineRoutineHeaders, false);
    assert.equal(split.preserveSingleLineIfBlocks, true);

    const legacy = coerceFormatOptions({ preserveSingleLineSpecialCases: false });
    assert.equal(legacy.preserveSingleLineRoutineHeaders, false);
    assert.equal(legacy.preserveSingleLineIfBlocks, false);
});

test('CREATE TABLE column list wraps per createTable threshold', () => {
    // createTable default {0, 1}: any number of columns wraps.
    assert.equal(
        formatSql('create table t (a int, b int);'),
        ['CREATE TABLE t(', '  a INT,', '  b INT', ');'].join('\n')
    );
    assert.equal(
        formatSql('create table t (a int, b int, c int, d int);'),
        ['CREATE TABLE t(', '  a INT,', '  b INT,', '  c INT,', '  d INT', ');'].join('\n')
    );
});

test('RETURNS TABLE column list wraps per returnsTable threshold', () => {
    const tail = '\nas $$ begin end $$ language plpgsql;';
    // Default {1, 4}: a single-column table stays inline (no space before `(`).
    assert.equal(
        formatSql('create function f()\nreturns table(a integer)' + tail, { dataTypeCase: 'preserve' }),
        ['CREATE FUNCTION f() RETURNS TABLE(a integer)', 'AS $$', 'BEGIN', 'END', '$$ LANGUAGE plpgsql;'].join('\n')
    );
    // Four columns reach multilineMin and wrap, one column per line.
    assert.equal(
        formatSql('create function f()\nreturns table(a integer, b integer, c integer, d integer)' + tail, { dataTypeCase: 'preserve' }),
        [
            'CREATE FUNCTION f() RETURNS TABLE(',
            '  a integer,',
            '  b integer,',
            '  c integer,',
            '  d integer',
            ')',
            'AS $$',
            'BEGIN',
            'END',
            '$$ LANGUAGE plpgsql;'
        ].join('\n')
    );
});

test('FROM comma list wraps per fromTables threshold', () => {
    assert.equal(formatSql('select a from t1, t2;', { simpleSelectSingleLine: false }), 'SELECT a\nFROM t1, t2;');
    assert.equal(
        formatSql('select a from t1, t2, t3, t4;'),
        ['SELECT a', 'FROM', '  t1,', '  t2,', '  t3,', '  t4;'].join('\n')
    );
});

test('GROUP BY list follows the groupByColumns threshold', () => {
    // selectColumns default {1, 3}: 2 columns follow source (single-line → stays inline).
    assert.equal(
        formatSql('select a, count(*) from t group by a;'),
        'SELECT a, count(*)\nFROM t\nGROUP BY a;'
    );
    // Four or more columns wrap, one per line.
    assert.equal(
        formatSql('select a from t group by a, b, c, d;'),
        ['SELECT a', 'FROM t', 'GROUP BY', '  a,', '  b,', '  c,', '  d;'].join('\n')
    );
    // A lower threshold forces a short GROUP BY list to wrap.
    assert.equal(
        formatSql('select a from t group by a, b;', { thresholds: { groupByColumns: { inlineMax: 1, multilineMin: 2 } } }),
        ['SELECT a', 'FROM t', 'GROUP BY', '  a,', '  b;'].join('\n')
    );
});

test('ORDER BY list follows the orderByColumns threshold', () => {
    // Default {1, 4}: a short ORDER BY list stays on the clause line, keeping ASC/DESC.
    assert.equal(
        formatSql('select a from t order by a desc;'),
        ['SELECT a', 'FROM t', 'ORDER BY a DESC;'].join('\n')
    );
    // A lower threshold wraps the list, one term per line including ASC/DESC.
    assert.equal(
        formatSql('select a from t order by a asc, b desc;', { thresholds: { orderByColumns: { inlineMax: 1, multilineMin: 2 } } }),
        ['SELECT a', 'FROM t', 'ORDER BY', '  a ASC,', '  b DESC;'].join('\n')
    );
    // Four or more terms wrap by default.
    assert.equal(
        formatSql('select a from t order by a, b, c, d;'),
        ['SELECT a', 'FROM t', 'ORDER BY', '  a,', '  b,', '  c,', '  d;'].join('\n')
    );
});

test('GROUP BY / ORDER BY in a cursor FOR loop wrap by item count, not the loop body', () => {
    // A long GROUP BY/ORDER BY inside `FOR … IN <query> LOOP` still wraps.
    const many = [
        'do $$ begin',
        'for rec in select a from t',
        'group by c1, c2, c3, c4',
        'order by c1, c2, c3, c4',
        'loop x := 1; end loop; end $$;'
    ].join(' ');
    assert.equal(
        formatSql(many),
        [
            'DO $$',
            'BEGIN',
            '  FOR rec IN',
            '    SELECT a',
            '    FROM t',
            '    GROUP BY',
            '      c1,',
            '      c2,',
            '      c3,',
            '      c4',
            '    ORDER BY',
            '      c1,',
            '      c2,',
            '      c3,',
            '      c4',
            '  LOOP',
            '    x := 1;',
            '  END LOOP;',
            'END',
            '$$;'
        ].join('\n')
    );
    // A short single-line ORDER BY stays inline even when the multi-line loop
    // body follows (the list must stop at LOOP, not run into the body).
    const short = [
        'do $$ begin',
        'for rec in select a from t order by a, b',
        'loop',
        'x := 1;',
        'y := 2;',
        'end loop; end $$;'
    ].join('\n');
    assert.equal(
        formatSql(short),
        [
            'DO $$',
            'BEGIN',
            '  FOR rec IN',
            '    SELECT a',
            '    FROM t',
            '    ORDER BY a, b',
            '  LOOP',
            '    x := 1;',
            '    y := 2;',
            '  END LOOP;',
            'END',
            '$$;'
        ].join('\n')
    );
});

test('MERGE keeps MERGE, WHEN clauses and the closing semicolon on one level', () => {
    const sql = 'MERGE INTO customer_account ca USING (SELECT customer_id, transaction_value FROM recent_transactions) t '
        + 'ON (t.customer_id = ca.customer_id) '
        + 'WHEN MATCHED THEN UPDATE SET balance = balance + transaction_value '
        + 'WHEN NOT MATCHED THEN INSERT (customer_id, balance) VALUES (t.customer_id, t.transaction_value);';
    // selectColumns default {1, 3}: 2 columns in the subquery follow source (single-line → stays inline).
    assert.equal(
        formatSql(sql),
        [
            'MERGE',
            'INTO customer_account ca USING (',
            '  SELECT customer_id, transaction_value',
            '  FROM recent_transactions',
            ') t ON (t.customer_id = ca.customer_id)',
            'WHEN MATCHED THEN',
            '  UPDATE',
            '  SET',
            '    balance = balance + transaction_value',
            'WHEN NOT MATCHED THEN',
            '  INSERT (customer_id, balance)',
            '  VALUES (t.customer_id, t.transaction_value)',
            ';'
        ].join('\n')
    );
});

test('MERGE inside a block keeps its clauses and semicolon at the block level', () => {
    const sql = 'DO $$ BEGIN MERGE INTO t1 USING src ON (t1.id = src.id) '
        + 'WHEN MATCHED THEN UPDATE SET a = src.a '
        + 'WHEN NOT MATCHED THEN INSERT (id, a) VALUES (src.id, src.a); END $$;';
    assert.equal(
        formatSql(sql),
        [
            'DO $$',
            'BEGIN',
            '  MERGE',
            '  INTO t1 USING src ON (t1.id = src.id)',
            '  WHEN MATCHED THEN',
            '    UPDATE',
            '    SET',
            '      a = src.a',
            '  WHEN NOT MATCHED THEN',
            '    INSERT (id, a)',
            '    VALUES (src.id, src.a)',
            '  ;',
            'END',
            '$$;'
        ].join('\n')
    );
});

test('MERGE puts THEN on its own line at the WHEN level when the WHEN condition is multi-line', () => {
    const sql = 'MERGE INTO mak USING neu ON (mak.id = neu.id) '
        + 'WHEN MATCHED AND (mak.mak_anzahl != neu.mac_anzahl OR mak.mak_deend != neu.mac_deend) THEN '
        + 'UPDATE SET mak_anzahl = neu.mac_anzahl '
        + 'WHEN NOT MATCHED THEN INSERT (id, anzahl) VALUES (neu.id, neu.mac_anzahl);';
    assert.equal(
        formatSql(sql),
        [
            'MERGE',
            'INTO mak USING neu',
            '   ON (mak.id = neu.id)',
            'WHEN MATCHED',
            '  AND (',
            '    mak.mak_anzahl != neu.mac_anzahl',
            '     OR mak.mak_deend != neu.mac_deend',
            '  )',
            'THEN',
            '  UPDATE',
            '  SET',
            '    mak_anzahl = neu.mac_anzahl',
            'WHEN NOT MATCHED THEN',
            '  INSERT (id, anzahl)',
            '  VALUES (neu.id, neu.mac_anzahl)',
            ';'
        ].join('\n')
    );
});

test('IN value list follows the inLists threshold', () => {
    // selectColumns default {1, 3}: 2 columns follow source (single-line → stays inline).
    // inLists default {2, 10}: short IN lists (< 10) follow source and stay inline.
    assert.equal(formatSql('select a, b from t where x in (1, 2, 3);'),
        'SELECT a, b\nFROM t\nWHERE x IN (1, 2, 3);'
    );
    // A lower threshold forces the list to wrap.
    assert.equal(
        formatSql('select a, b from t where x in (1, 2, 3);', { thresholds: { inLists: { inlineMax: 1, multilineMin: 2 } } }),
        ['SELECT a, b', 'FROM t', 'WHERE x IN (', '  1,', '  2,', '  3', ');'].join('\n')
    );
});

test('ARRAY literal wraps per arrayLiterals threshold', () => {
    assert.equal(
        formatSql('do $$ begin x := array[1, 2, 3, 4, 5]; end $$;', { thresholds: { arrayLiterals: { inlineMax: 2, multilineMin: 4 } } }),
        ['DO $$', 'BEGIN', '  x := ARRAY[', '    1,', '    2,', '    3,', '    4,', '    5', '  ];', 'END', '$$;'].join('\n')
    );
});

test('JOIN ON conditions follow the joinConditions threshold', () => {
    // joinConditions default {1, 3}: 2 conditions follow source (single-line → stays inline).
    assert.equal(formatSql('select a from t join u on t.a = u.a and t.b = u.b;'),
        'SELECT a\nFROM t\nJOIN u ON t.a = u.a AND t.b = u.b;');
    // 3 conditions reach multilineMin → wrap.
    assert.equal(
        formatSql('select a from t join u on t.a = u.a and t.b = u.b and t.c = u.c;'),
        ['SELECT a', 'FROM t', 'JOIN u', '   ON t.a = u.a', '  AND t.b = u.b', '  AND t.c = u.c;'].join('\n')
    );
    assert.equal(
        formatSql('select a from t join u on t.a = u.a and t.b = u.b;', { thresholds: { joinConditions: { inlineMax: 3, multilineMin: 5 } } }),
        ['SELECT a', 'FROM t', 'JOIN u ON t.a = u.a AND t.b = u.b;'].join('\n')
    );
});

test('multi-line JOIN ON puts ON on its own line, river-aligned with AND', () => {
    const sql = 'select x from let join bos_t_kal_hours btkh on btkh.kal_tag = let.let_kal_tag '
        + 'and lze.lze_menge = btkh.p_worktimetarget and btkh.session_id = p_websessionid;';
    assert.equal(formatSql(sql),
        [
            'SELECT x',
            'FROM let',
            'JOIN bos_t_kal_hours btkh',
            '   ON btkh.kal_tag = let.let_kal_tag',
            '  AND lze.lze_menge = btkh.p_worktimetarget',
            '  AND btkh.session_id = p_websessionid;',
        ].join('\n'));
});

test('multi-line JOIN ON keeps OR river-aligned and indents AND one level deeper', () => {
    const sql = 'select a from t join u on t.a = u.a and t.b = u.b or t.c = u.c;';
    assert.equal(formatSql(sql),
        [
            'SELECT a',
            'FROM t',
            'JOIN u',
            '   ON t.a = u.a',
            '    AND t.b = u.b',
            '   OR t.c = u.c;',
        ].join('\n'));
});

test('single-condition JOIN ON stays inline', () => {
    assert.equal(
        formatSql('select a from t join u on t.a = u.a;'),
        ['SELECT a', 'FROM t', 'JOIN u ON t.a = u.a;'].join('\n')
    );
});

test('WHERE AND after a multi-line JOIN ON is not river-aligned', () => {
    const sql = 'select a from t join u on t.a = u.a and t.b = u.b where x = 1 or y = 2;';
    assert.equal(formatSql(sql),
        [
            'SELECT a',
            'FROM t',
            'JOIN u',
            '   ON t.a = u.a',
            '  AND t.b = u.b',
            'WHERE x = 1',
            '  OR y = 2;',
        ].join('\n'));
});

test('operator chain breaks per operatorChains threshold', () => {
    // Default {1, 8}: a short chain on one source line stays inline.
    assert.equal(
        formatSql('do $$ begin x := a + b + c; end $$;'),
        ['DO $$', 'BEGIN', '  x := a + b + c;', 'END', '$$;'].join('\n')
    );
    // Eight operands reach multilineMin and break, operator-leading.
    assert.equal(
        formatSql('do $$ begin select a + b + c + d + e + f + g + h into x; end $$;'),
        ['DO $$', 'BEGIN', '  SELECT a', '    + b', '    + c', '    + d', '    + e', '    + f', '    + g', '    + h', '  INTO x;', 'END', '$$;'].join('\n')
    );
    // A lower multilineMin makes the short chain break too.
    assert.equal(
        formatSql('do $$ begin x := a + b + c; end $$;', { thresholds: { operatorChains: { inlineMax: 1, multilineMin: 3 } } }),
        ['DO $$', 'BEGIN', '  x := a', '    + b', '    + c;', 'END', '$$;'].join('\n')
    );
});

test('IF block keeps a fully one-line source on one line (and can still be threshold-collapsed)', () => {
    const sql = 'do $$ begin if a then x := 1; end if; end $$;';
    // A fully single-line source IF stays on one line by default.
    assert.equal(
        formatSql(sql),
        ['DO $$', 'BEGIN', '  IF a THEN x := 1; END IF;', 'END', '$$;'].join('\n')
    );
    // inlineMax >= 1 collapses a single-statement IF onto one line.
    assert.equal(
        formatSql(sql, { thresholds: { ifElse: { inlineMax: 1, multilineMin: 2 } } }),
        ['DO $$', 'BEGIN', '  IF a THEN x := 1; END IF;', 'END', '$$;'].join('\n')
    );
    // The special-case preservation can be disabled via formatter options.
    assert.equal(
        formatSql(sql, { preserveSingleLineIfBlocks: false }),
        ['DO $$', 'BEGIN', '  IF a THEN', '    x := 1;', '  END IF;', 'END', '$$;'].join('\n')
    );
});

test('IF/ELSE collapses only when the statement count fits inlineMax', () => {
    const sql = 'do $$ begin if a then x := 1; else y := 2; end if; end $$;';
    // Two statements: inlineMax 1 is too small, stays multiline.
    assert.equal(
        formatSql(sql, { thresholds: { ifElse: { inlineMax: 1, multilineMin: 2 } } }),
        ['DO $$', 'BEGIN', '  IF a THEN', '    x := 1;', '  ELSE', '    y := 2;', '  END IF;', 'END', '$$;'].join('\n')
    );
    // inlineMax 2 fits both branches.
    assert.equal(
        formatSql(sql, { thresholds: { ifElse: { inlineMax: 2, multilineMin: 3 } } }),
        ['DO $$', 'BEGIN', '  IF a THEN x := 1; ELSE y := 2; END IF;', 'END', '$$;'].join('\n')
    );
});

test('a nested block prevents IF collapse', () => {
    const sql = 'do $$ begin if a then if b then x := 1; end if; end if; end $$;';
    // Outer IF body contains a nested IF, so it never collapses; the inner one does.
    assert.equal(
        formatSql(sql, { thresholds: { ifElse: { inlineMax: 5, multilineMin: 6 } } }),
        ['DO $$', 'BEGIN', '  IF a THEN', '    IF b THEN x := 1; END IF;', '  END IF;', 'END', '$$;'].join('\n')
    );
});

test('CASE statement collapses per caseWhenThen threshold', () => {
    const sql = 'do $$ begin case when a then x := 1; when b then y := 2; end case; end $$;';
    assert.equal(
        formatSql(sql, { thresholds: { caseWhenThen: { inlineMax: 2, multilineMin: 3 } } }),
        ['DO $$', 'BEGIN', '  CASE WHEN a THEN x := 1; WHEN b THEN y := 2; END CASE;', 'END', '$$;'].join('\n')
    );
});

test('EXCEPTION section collapses per exceptionWhenThen threshold', () => {
    const sql = 'do $$ begin x := 1; exception when others then y := 2; end $$;';
    assert.equal(
        formatSql(sql, { thresholds: { exceptionWhenThen: { inlineMax: 1, multilineMin: 2 } } }),
        ['DO $$', 'BEGIN', '  x := 1;', 'EXCEPTION WHEN OTHERS THEN y := 2;', 'END', '$$;'].join('\n')
    );
});

test('simpleSelectSingleLine can be disabled', () => {
    assert.equal(formatSql('select a from t;', { simpleSelectSingleLine: false }), 'SELECT a\nFROM t;');
    assert.equal(formatSql('select a from t;'), 'SELECT a FROM t;');
});

test('does not collapse a SELECT whose function call was split across lines with a compound argument', () => {
    const src = [
        'CREATE OR REPLACE FUNCTION pk.k(p_session_id VARCHAR, p_employee_no VARCHAR DEFAULT NULL) RETURNS BIGINT',
        '  LANGUAGE sql IMMUTABLE PARALLEL SAFE',
        'AS $$',
        'SELECT hashtext(',
        "               COALESCE(p_session_id, '') ||",
        "               COALESCE('::' || p_employee_no, '')",
        '       )::bigint;',
        '$$;',
    ].join('\n');
    const out = formatSql(src);
    // The SELECT is no longer on a single line: the hashtext call wraps its argument.
    assert.ok(/SELECT hashtext\(\n/.test(out), 'hashtext should wrap its argument onto a new line\n' + out);
    assert.ok(/\n\s*\)::BIGINT;/.test(out), 'the closing paren/cast should be on its own line\n' + out);
    // Stable on a second pass.
    assert.equal(formatSql(out), out);
});

test('still collapses a simple single-line function-call SELECT', () => {
    // A single-arg call written on one line stays inline.
    assert.equal(formatSql('select abs(x) from t;'), 'SELECT abs(x) FROM t;');
    // A single-arg call split across lines but with no top-level operator is not forced to wrap.
    assert.equal(formatSql('select foo(\n   bar\n);'), 'SELECT foo(bar);');
});

test('keeps a single SELECT item on the SELECT line; splits when threshold is met', () => {
    assert.equal(
        formatSql('select 1 into strict v from t where a = 1;'),
        ['SELECT 1', 'INTO STRICT v', 'FROM t', 'WHERE a = 1;'].join('\n')
    );
    // selectColumns default {1, 3}: 2 columns follow source (single-line → stays inline).
    assert.equal(
        formatSql('select a, b into x, y from t;'),
        'SELECT a, b\nINTO x, y\nFROM t;'
    );
    // 3 columns reach multilineMin → wrap.
    assert.equal(
        formatSql('select a, b, c into x, y, z from t;'),
        ['SELECT', '  a,', '  b,', '  c', 'INTO', '  x,', '  y,', '  z', 'FROM t;'].join('\n')
    );
});

test('puts each AND on its own indented line, except the AND of BETWEEN', () => {
    assert.equal(
        formatSql('select x from t where a = 1 and b between 2 and 5 and c = 3;'),
        [
            'SELECT x',
            'FROM t',
            'WHERE a = 1',
            '  AND b BETWEEN 2 AND 5',
            '  AND c = 3;'
        ].join('\n')
    );
});

test('keeps INSERT INTO on one line (does not break before INTO)', () => {
    assert.equal(formatSql('insert into t (a) values (1);'), 'INSERT INTO t(a)\nVALUES (1);');
});
