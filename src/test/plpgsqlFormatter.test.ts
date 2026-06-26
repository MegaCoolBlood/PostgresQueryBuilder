import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSql, DEFAULT_FORMAT_OPTIONS } from '../plpgsqlFormatter';

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

test('keeps a single-line three-column INSERT on one line', () => {
    const out = formatSql('INSERT INTO t (a, b, c) VALUES (1, 2, 3);');
    assert.equal(out, 'INSERT INTO t(a, b, c)\nVALUES (1, 2, 3);');
});

test('wraps a single-line INSERT once it reaches the upper threshold', () => {
    const out = formatSql('INSERT INTO t (a, b, c, d) VALUES (1, 2, 3, 4);');
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

test('uses one shared threshold pair for every list (middle band follows the source)', () => {
    // Three items sits in the middle band (listInlineMax 2 < 3 < listMultilineMin 4),
    // so a single-line source stays inline and a multi-line source stays wrapped –
    // the same rule for call lists, INSERT columns and FROM lists alike.
    assert.equal(formatSql('call f(a, b, c);'), 'CALL f(a, b, c);');
    assert.equal(
        formatSql('call f(\na,\nb,\nc\n);'),
        ['CALL f(', '  a,', '  b,', '  c', ');'].join('\n')
    );
    assert.equal(
        formatSql('INSERT INTO t (a, b, c) VALUES (1, 2, 3);'),
        'INSERT INTO t(a, b, c)\nVALUES (1, 2, 3);'
    );
    assert.equal(
        formatSql('SELECT a FROM t1, t2, t3 WHERE t1.id = t2.id;'),
        'SELECT a\nFROM t1, t2, t3\nWHERE t1.id = t2.id;'
    );
    // At/above the upper threshold everything wraps regardless of the source.
    assert.equal(
        formatSql('call f(a, b, c, d);'),
        ['CALL f(', '  a,', '  b,', '  c,', '  d', ');'].join('\n')
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
        listInlineMax: 2,
        listMultilineMin: 4,
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

test('listInlineMax / listMultilineMin control call wrapping', () => {
    assert.equal(formatSql('call f(a);'), 'CALL f(a);');
    assert.equal(formatSql('call f(a, b, c);'), 'CALL f(a, b, c);');
    const four = formatSql('call f(a, b, c, d);');
    assert.equal(four, ['CALL f(', '  a,', '  b,', '  c,', '  d', ');'].join('\n'));
    // Lowering both thresholds forces two-argument calls to wrap.
    const two = formatSql('call f(a, b);', { listInlineMax: 1, listMultilineMin: 2 });
    assert.equal(two, ['CALL f(', '  a,', '  b', ');'].join('\n'));
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
