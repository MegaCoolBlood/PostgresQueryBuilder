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
            'WHERE a = 1 AND b > 2',
            'ORDER BY a'
        ].join('\n')
    );
});

test('keeps SELECT * on a single line', () => {
    assert.equal(formatSql('select * from t;'), 'SELECT *\nFROM t;');
});

test('formats a PL/pgSQL function body with DECLARE/BEGIN/IF/LOOP blocks', () => {
    const out = formatSql(
        "create function f(p int) returns void as $$ declare x int; begin if x>0 then perform do_it(x); else raise notice 'no'; end if; end; $$ language plpgsql;"
    );
    assert.equal(
        out,
        [
            'CREATE FUNCTION f(p INT) RETURNS VOID AS $$',
            '  DECLARE',
            '    x INT;',
            '  BEGIN',
            '    IF x > 0 THEN',
            '      PERFORM do_it(x);',
            '    ELSE',
            "      RAISE NOTICE 'no';",
            '    END IF;',
            '  END;',
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

test('indents subqueries inside parentheses', () => {
    const out = formatSql('select a from (select x from inner_t where x>0) sub;');
    assert.equal(
        out,
        [
            'SELECT',
            '  a',
            'FROM (',
            '  SELECT',
            '    x',
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
    assert.equal(formatSql('SELECT Foo FROM Bar', { keywordCase: 'lower' }), 'select\n  Foo\nfrom Bar');
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

test('preserves an authored blank line between statements', () => {
    const out = formatSql('select 1;\n\n\nselect 2;');
    assert.equal(out, ['SELECT', '  1;', '', 'SELECT', '  2;'].join('\n'));
});

test('preserves a trailing newline when present', () => {
    assert.equal(formatSql('select 1\n'), 'SELECT\n  1\n');
    assert.equal(formatSql('select 1'), 'SELECT\n  1');
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
        commaStyle: 'trailing'
    });
});
