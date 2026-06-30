import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSql, DEFAULT_FORMAT_OPTIONS, DEFAULT_THRESHOLDS } from '../plpgsqlFormatter';

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
            'CREATE FUNCTION f(p INT) RETURNS VOID',
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
    assert.equal(
        out,
        [
            'SELECT',
            '  a,',
            "  CASE WHEN x > 1 THEN 'a' ELSE 'b' END AS label",
            'FROM t;'
        ].join('\n')
    );
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
    const out = formatSql(
        'BEGIN\nIF a.amount IS NULL OR a.amount = 0 THEN\ndo_something();\nEND IF;\nEND;'
    );
    assert.equal(
        out,
        [
            'BEGIN',
            '  IF a.amount IS NULL',
            '    OR a.amount = 0',
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

test('wraps an INSERT with six or more columns even from a single source line', () => {
    const out = formatSql('INSERT INTO t (a, b, c, d, e, f) VALUES (1, 2, 3, 4, 5, 6);');
    assert.equal(
        out,
        [
            'INSERT INTO t(',
            '  a,',
            '  b,',
            '  c,',
            '  d,',
            '  e,',
            '  f',
            ')',
            'VALUES (',
            '  1,',
            '  2,',
            '  3,',
            '  4,',
            '  5,',
            '  6',
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

test('keeps a small CREATE TYPE attribute list on one line', () => {
    assert.equal(formatSql('CREATE TYPE t AS (a INTEGER);'), 'CREATE TYPE t AS (a INTEGER);');
    assert.equal(formatSql('CREATE TYPE t AS (a INTEGER, b TEXT);'), 'CREATE TYPE t AS (a INTEGER, b TEXT);');
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

test('breaks UPDATE ... SET assignments onto separate lines', () => {
    const out = formatSql('update tbl set a=1, b=2 where id=5;');
    assert.equal(
        out,
        ['UPDATE tbl', 'SET', '  a = 1,', '  b = 2', 'WHERE id = 5;'].join('\n')
    );
});

test('keeps DISTINCT ON (...) on the SELECT line', () => {
    const out = formatSql('select distinct on (a) a, b from t;');
    assert.equal(out, ['SELECT DISTINCT ON (a)', '  a,', '  b', 'FROM t;'].join('\n'));
});

test('supports leading comma style', () => {
    const out = formatSql('select a,b,c from t', { commaStyle: 'leading' });
    assert.equal(out, ['SELECT', '  a', '  , b', '  , c', 'FROM t'].join('\n'));
});

test('respects indentSize and tab indentation', () => {
    assert.equal(formatSql('select a,b from t', { indentSize: 4 }), 'SELECT\n    a,\n    b\nFROM t');
    assert.equal(formatSql('select a,b from t', { indentStyle: 'tab' }), 'SELECT\n\ta,\n\tb\nFROM t');
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
    assert.equal(
        formatSql('create table a(x int);\n\n\ncreate table b(y int);'),
        'CREATE TABLE a(x INT);\n\n\nCREATE TABLE b(y INT);'
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
        thresholds: DEFAULT_THRESHOLDS,
        normalizeDataTypes: true
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

test('normalizeDataTypes can be disabled', () => {
    const out = formatSql('declare a character varying(500); begin end;', { normalizeDataTypes: false });
    assert.ok(out.includes('a CHARACTER VARYING(500);'), out);
});

test('does not treat FROM/FOR inside a function call as SQL clauses', () => {
    const out = formatSql("select substring(SQLERRM from 1 for 500);");
    assert.equal(out, 'SELECT substring(SQLERRM FROM 1 FOR 500);');
});

test('keeps commas inside ARRAY[...] on one line', () => {
    const out = formatSql('select array[1, 2, 3, 4, 5];');
    assert.equal(out, 'SELECT ARRAY[1, 2, 3, 4, 5];');
});

test('formats a CREATE PROCEDURE header (params inline, characteristics own lines)', () => {
    const out = formatSql(
        'create or replace procedure p.add_text(inout po text, in pi text) language plpgsql as $procedure$ begin\n po := po || pi; end; $procedure$;'
    );
    assert.equal(
        out,
        [
            'CREATE OR REPLACE PROCEDURE p.add_text(INOUT po TEXT, IN pi TEXT)',
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

test('still expands a CREATE FUNCTION that the author wrote across lines', () => {
    const out = formatSql(
        "create function pk.g_pair() returns varchar language sql immutable as $$\nselect 'X';\n$$;"
    );
    assert.ok(out.includes('\n'), out);
    assert.ok(out.startsWith('CREATE FUNCTION pk.g_pair() RETURNS VARCHAR'), out);
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

test('CREATE TABLE column list wraps per createTable threshold', () => {
    assert.equal(formatSql('create table t (a int, b int);'), 'CREATE TABLE t(a INT, b INT);');
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

test('IN value list follows the inLists threshold', () => {
    // Default {4, 12}: a short IN list stays inline.
    assert.equal(formatSql('select a, b from t where x in (1, 2, 3);'),
        ['SELECT', '  a,', '  b', 'FROM t', 'WHERE x IN (1, 2, 3);'].join('\n'));
    // A lower threshold forces the list to wrap.
    assert.equal(
        formatSql('select a, b from t where x in (1, 2, 3);', { thresholds: { inLists: { inlineMax: 1, multilineMin: 2 } } }),
        ['SELECT', '  a,', '  b', 'FROM t', 'WHERE x IN (', '  1,', '  2,', '  3', ');'].join('\n')
    );
});

test('ARRAY literal wraps per arrayLiterals threshold', () => {
    assert.equal(
        formatSql('do $$ begin x := array[1, 2, 3, 4, 5]; end $$;', { thresholds: { arrayLiterals: { inlineMax: 2, multilineMin: 4 } } }),
        ['DO $$', 'BEGIN', '  x := ARRAY[', '    1,', '    2,', '    3,', '    4,', '    5', '  ];', 'END', '$$;'].join('\n')
    );
});

test('JOIN ON conditions follow the joinConditions threshold', () => {
    const sql = 'select a from t join u on t.a = u.a and t.b = u.b;';
    assert.equal(formatSql(sql),
        ['SELECT a', 'FROM t', 'JOIN u', '   ON t.a = u.a', '  AND t.b = u.b;'].join('\n'));
    assert.equal(
        formatSql(sql, { thresholds: { joinConditions: { inlineMax: 3, multilineMin: 5 } } }),
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

test('multi-line JOIN ON river-aligns OR with AND', () => {
    const sql = 'select a from t join u on t.a = u.a and t.b = u.b or t.c = u.c;';
    assert.equal(formatSql(sql),
        [
            'SELECT a',
            'FROM t',
            'JOIN u',
            '   ON t.a = u.a',
            '  AND t.b = u.b',
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

test('IF block collapses to one line per ifElse threshold', () => {
    const sql = 'do $$ begin if a then x := 1; end if; end $$;';
    // Default: structural blocks stay multiline.
    assert.equal(
        formatSql(sql),
        ['DO $$', 'BEGIN', '  IF a THEN', '    x := 1;', '  END IF;', 'END', '$$;'].join('\n')
    );
    // inlineMax >= 1 collapses a single-statement IF onto one line.
    assert.equal(
        formatSql(sql, { thresholds: { ifElse: { inlineMax: 1, multilineMin: 2 } } }),
        ['DO $$', 'BEGIN', '  IF a THEN x := 1; END IF;', 'END', '$$;'].join('\n')
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

test('keeps a single SELECT item on the SELECT line but splits multiple', () => {
    assert.equal(
        formatSql('select 1 into strict v from t where a = 1;'),
        ['SELECT 1', 'INTO STRICT v', 'FROM t', 'WHERE a = 1;'].join('\n')
    );
    assert.equal(
        formatSql('select a, b into x, y from t;'),
        ['SELECT', '  a,', '  b', 'INTO', '  x,', '  y', 'FROM t;'].join('\n')
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
