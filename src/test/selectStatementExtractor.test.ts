import test from 'node:test';
import assert from 'node:assert/strict';
import {
    maskSql,
    findVariableTokens,
    extractSelect,
    substituteVariables,
    findEnclosingDollarBody,
    extractTableNames,
    extractTableQualifiers,
    extractDefinedNames,
    selectStatementForEditing,
    selectStatementRange,
    queryVariableNames
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

test('maskSql ends a literal at a backslash-quote pair', () => {
    // A backslash is an ordinary character in a plain literal, so '\' closes it.
    const sql = "SELECT a FROM t WHERE x LIKE 'W\\_%' ESCAPE '\\' AND y = 1";
    const masked = maskSql(sql);
    assert.equal(masked.length, sql.length);
    assert.ok(masked.includes('AND y = 1'), 'text after the literal must stay visible: ' + masked);
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

test('findVariableTokens reports a :name placeholder wherever it stands', () => {
    const sql = [
        'WITH bounds AS (',
        '  SELECT :v_von AS from_day, LEAST(:v_bis, now()) AS to_day',
        ')',
        'SELECT * FROM bounds'
    ].join('\n');
    const names = findVariableTokens(sql).map((o) => o.name);
    assert.deepEqual(names, [':v_von', ':v_bis']);
});

test('findVariableTokens keeps a :name placeholder that follows an operator', () => {
    const names = findVariableTokens('SELECT * FROM t WHERE a=:from AND b >= :to').map((o) => o.name);
    assert.deepEqual(names, [':from', ':to']);
});

test('findVariableTokens does not mistake a cast or an assignment for a placeholder', () => {
    const cast = findVariableTokens('SELECT * FROM t WHERE a = b::text').map((o) => o.name);
    assert.ok(!cast.some((n) => n.startsWith(':')), `no placeholder in a cast, got: ${cast.join(', ')}`);
    assert.deepEqual(findVariableTokens('SELECT * FROM t WHERE a = v_x::integer').map((o) => o.name), ['v_x']);
    assert.deepEqual(findVariableTokens('SELECT * FROM t WHERE ts = now()::date').map((o) => o.name), []);
});

test('findVariableTokens reports psql-style quoted placeholders but not a string after a cast', () => {
    const sql = `SELECT :"col" FROM t WHERE d >= :'from'::date AND e = 'x:''y' AND f = ':''z'''`;
    assert.deepEqual(findVariableTokens(sql).map((o) => o.name), [':"col"', `:'from'`]);
    assert.equal(substituteVariables(sql, { ":'from'": "'2024-01-01'" }).includes(`'2024-01-01'::date`), true);
    assert.deepEqual(queryVariableNames('SELECT * FROM t WHERE a = :x OR b = :X OR c = $1'), [':x', '$1']);
});

test('substituteVariables replaces a :name placeholder including its colon', () => {
    const sql = 'SELECT :v_von AS from_day FROM t WHERE d <= :v_bis';
    const out = substituteVariables(sql, { ':v_von': "'2026-01-01'", ':v_bis': "'2026-12-31'" });
    assert.equal(out, "SELECT '2026-01-01' AS from_day FROM t WHERE d <= '2026-12-31'");
});

test('queryVariableNames and substituteVariables read SQL that starts with FROM', () => {
    assert.deepEqual(queryVariableNames('FROM t WHERE id = v_id'), ['v_id']);
    assert.equal(substituteVariables('FROM t WHERE id = :id', { ':id': '1' }), 'FROM t WHERE id = 1');
});

test('queryVariableNames treats the colon of an array slice as a slice, not a placeholder', () => {
    const sql = 'SELECT a[1:n] FROM t WHERE a[lo:hi] = ARRAY[:x]';
    assert.deepEqual(queryVariableNames(sql), [':x']);
    assert.equal(substituteVariables(sql, { ':x': '5', ':n': '7' }), 'SELECT a[1:n] FROM t WHERE a[lo:hi] = ARRAY[5]');
    assert.deepEqual(queryVariableNames('SELECT a[:n], b[ 2 : m ][:k] FROM t'), []);
    assert.deepEqual(queryVariableNames('SELECT * FROM t WHERE a && ARRAY[:x, :y] AND b = array [ :z ]'), [':x', ':y', ':z']);
    assert.deepEqual(queryVariableNames('SELECT ARRAY[:x][1:n] FROM t WHERE c = :after'), [':x', ':after']);
});

test('extractDefinedNames covers a CTE declared as MATERIALIZED', () => {
    const sql = 'WITH a AS MATERIALIZED (SELECT 1), b AS NOT MATERIALIZED (SELECT 2) SELECT * FROM a JOIN b ON true';
    const defined = extractDefinedNames(sql);
    assert.ok(defined.has('a'), 'MATERIALIZED CTE name is defined');
    assert.ok(defined.has('b'), 'NOT MATERIALIZED CTE name is defined');
});

test('findVariableTokens detects a variable after LIMIT', () => {
    const sql = 'SELECT * FROM t WHERE a = v_a ORDER BY id LIMIT pi_max_history';
    const names = findVariableTokens(sql).map((o) => o.name);
    assert.ok(names.includes('pi_max_history'), 'LIMIT introduces a value position');
});

test('findVariableTokens detects a variable after OFFSET', () => {
    const sql = 'SELECT * FROM t LIMIT 10 OFFSET pi_skip';
    const names = findVariableTokens(sql).map((o) => o.name);
    assert.ok(names.includes('pi_skip'), 'OFFSET introduces a value position');
});

test('findVariableTokens does not flag a numeric LIMIT literal', () => {
    const sql = 'SELECT * FROM t WHERE a = v_a LIMIT 100';
    const names = findVariableTokens(sql).map((o) => o.name);
    assert.deepEqual(names, ['v_a']);
});

test('findVariableTokens does not flag a column alias used in a value expression', () => {
    const sql =
        'SELECT a AS function_name FROM t WHERE (b || function_name) LIKE x';
    const defined = extractDefinedNames(sql);
    const names = findVariableTokens(sql, extractTableQualifiers(sql), defined).map((o) => o.name);
    assert.ok(!names.includes('function_name'), 'a self-defined column alias is not a variable');
});

test('findVariableTokens still detects a real variable alongside a defined alias', () => {
    const sql =
        'SELECT a AS function_name FROM t WHERE (b || function_name) LIKE pi_pattern';
    const defined = extractDefinedNames(sql);
    const names = findVariableTokens(sql, extractTableQualifiers(sql), defined).map((o) => o.name);
    assert.ok(!names.includes('function_name'), 'defined alias excluded');
    assert.ok(names.includes('pi_pattern'), 'genuine variable still detected');
});

test('findVariableTokens treats a record-field access as a variable', () => {
    const sql = 'SELECT * FROM bos_belege lbe WHERE lbe.lbe_mit_id = pi_employeeObj.emplId';
    const qualifiers = extractTableQualifiers(sql);
    const names = findVariableTokens(sql, qualifiers).map((o) => o.name);
    assert.ok(names.includes('pi_employeeObj.emplId'), 'record-field access is a variable');
    assert.ok(!names.includes('lbe.lbe_mit_id'), 'real qualified column stays excluded');
});

test('findVariableTokens keeps a qualified column excluded without qualifiers', () => {
    const sql = 'SELECT * FROM users t WHERE t.id = a.col';
    const names = findVariableTokens(sql).map((o) => o.name);
    assert.deepEqual(names, [], 'no qualifiers supplied → all dotted identifiers excluded');
});

test('findVariableTokens excludes a schema-qualified function call in value position', () => {
    const sql = 'SELECT * FROM t WHERE d >= oracle.trunc(oracle.sysdate())';
    const qualifiers = extractTableQualifiers(sql);
    const names = findVariableTokens(sql, qualifiers).map((o) => o.name);
    assert.ok(!names.some((n) => n.startsWith('oracle.')), 'function calls are not variables');
});

test('findVariableTokens excludes a three-part chain in value position', () => {
    const sql = 'SELECT * FROM t WHERE a = my_schema.my_table.col';
    const qualifiers = extractTableQualifiers(sql);
    const names = findVariableTokens(sql, qualifiers).map((o) => o.name);
    assert.ok(!names.some((n) => n.startsWith('my_schema')), 'longer chains are not record variables');
});

// ===== extractTableQualifiers =====

test('extractTableQualifiers collects table names and aliases', () => {
    const sql = 'SELECT * FROM bos_belege lbe JOIN bos_leistungen lei ON lei_id = lbe_id';
    const q = extractTableQualifiers(sql);
    assert.ok(q.has('bos_belege'));
    assert.ok(q.has('lbe'));
    assert.ok(q.has('bos_leistungen'));
    assert.ok(q.has('lei'));
});

// A real-world query: LATERAL subqueries (sed, saw, eoa) are referenced by alias.
const LATERAL_JOIN_QUERY = `
WITH param AS (
  SELECT
    date_trunc('month', oracle.sysdate()) - INTERVAL '3 months' AS von,  -- earliest mtd_datum
    date_trunc('day', oracle.sysdate()) AS bis,  -- exclusive
    'DEB'::VARCHAR AS region,  -- bos_regionen.rk_rk
    NULL::VARCHAR AS persnr  -- NULL = all employees
), deb AS MATERIALIZED (
  SELECT
    mit.mit_id,
    mit.mit_persnr,
    mit.mit_name,
    mit.mit_vorname,
    rk.rk_id,
    GREATEST(mia.mia_gvon, p.von) AS von,
    LEAST(mia.mia_gbis, p.bis - INTERVAL '1 second') AS bis
  FROM param p
  JOIN bos_regionen rk ON rk.rk_rk = p.region
  JOIN bos_personalteilbereiche ptb ON ptb.ptb_rk_id = rk.rk_id
  JOIN bos_mit_attributes mia
     ON mia.mia_type = 'PTB'
    AND mia.mia_ref_id = ptb.ptb_id
  JOIN bos_mitarbeiter mit ON mit.mit_id = mia.mia_mit_id
  WHERE mia.mia_gvon < p.bis
    AND mia.mia_gbis >= p.von
    AND oracle.sysdate() BETWEEN mia.mia_svon AND mia.mia_sbis
    AND (
      p.persnr IS NULL
      OR mit.mit_persnr = p.persnr
    )
), chk AS (
  SELECT
    d.mit_id,
    d.mit_persnr,
    d.mit_name,
    d.mit_vorname,
    d.rk_id,
    m.mtd_id,
    m.mtd_datum,
    COALESCE(m.mtd_manager_awart, m.mtd_awart) AS awart,
    COALESCE(m.mtd_manager_von, m.mtd_von) AS von,
    COALESCE(m.mtd_manager_bis, m.mtd_bis) AS bis,
    m.mtd_cost_object,
    sed.sed_id,
    sed.sed_status,
    sed.sed_confirmed,
    sed.sed_session_id,
    sed.sed_saw_variante,
    COALESCE(
      (sed.sed_impdaten ->> 'p_catshours')::NUMERIC,
      sed.sed_catshours,
      m.mtd_manager_stunden,
      m.mtd_stunden,
      round(EXTRACT(EPOCH FROM (COALESCE(m.mtd_manager_bis, m.mtd_bis) - COALESCE(m.mtd_manager_von, m.mtd_von))) / 3600, 2)
    ) AS stunden
  FROM deb d
  JOIN bos_mit_timedata m
     ON m.mtd_persnr = d.mit_persnr
    AND m.mtd_datum BETWEEN d.von AND d.bis
  LEFT JOIN LATERAL (
    SELECT s.*
    FROM bos_sap_einsatzdaten s
    WHERE s.sed_counter = LPAD(m.mtd_id::TEXT, 10, '0')
      AND s.sed_persnr = m.mtd_persnr
    ORDER BY (s.sed_status = '30') DESC, s.sed_confirmed DESC NULLS LAST, s.sed_id DESC
    LIMIT 1
  ) sed ON TRUE
  WHERE m.mtd_gueltig = 'J'
    AND COALESCE(m.mtd_approved, 'J') = 'J'
    AND COALESCE(m.mtd_manager_awart, m.mtd_awart) NOT IN ('0600', '0601', '0602')
    AND COALESCE(sed.sed_ausgeblendet, 'N') = 'N'
    AND NOT EXISTS (
      SELECT 1
      FROM bos_leistungen_ex lex
      JOIN bos_leistungen lei ON lei.lei_id = lex.lei_ref_id
      JOIN bos_leistungsbelege lbe ON lbe.lbe_id = lei.lei_lbe_id
      WHERE lex.lei_sed_id = sed.sed_id
        AND lei.lei_modifiziert IN ('O', 'U', 'I')
        AND lei.lei_storno_ref_id IS NULL
        AND lbe.lbe_modifiziert IN ('O', 'U', 'I')
    )
), kand AS MATERIALIZED (
  SELECT c.*, saw.saw_lbe_herkunft
  FROM chk c
  JOIN LATERAL (
    SELECT a.saw_lbe_herkunft
    FROM bos_sap_awarten a
    WHERE a.saw_awart = c.awart
      AND (
        c.sed_saw_variante IS NULL
        OR a.saw_variante = c.sed_saw_variante
      )
    ORDER BY (a.saw_lbe_herkunft <> 'XX') DESC
    LIMIT 1
  ) saw ON saw.saw_lbe_herkunft <> 'XX'
  -- claims only matter for zero-hour entries; CASE keeps the lookups lazy
  WHERE CASE
    WHEN c.stunden IS NULL
      OR c.stunden <> 0
    THEN
      TRUE
    ELSE
      EXISTS (SELECT 1 FROM bos_mit_timedata_lumpsums l WHERE l.mtdl_mtd_id = c.mtd_id) OR EXISTS (SELECT 1 FROM bos_mit_timedata_specialcharges s WHERE s.mtds_mtd_id = c.mtd_id) OR EXISTS (SELECT 1 FROM bos_mit_timedata_travelexpenses t WHERE t.mtdt_mtd_id = c.mtd_id)
  END
),
-- same rule as pk_gensed2tkn.p_auto_gen_f_store_v_pref_auto_tkn_gen, evaluated once per employee and day
pref AS MATERIALIZED (
  SELECT
    t.mit_id,
    t.mtd_datum,
    COALESCE(
      NULLIF(pk_azmutil.f_get_azmparam(t.mit_id, t.mtd_datum, 'RUECKRECHNUNG'), 'N'),
      pk_pref_interface.f_get_orgpref_value(
        'MANDANTEN_STEUERUNG',
        'R_S_ADM',
        pk_mitarbeiter_merkmale.vorgplanstelle(t.mit_id, t.mtd_datum),
        t.rk_id,
        NULL,
        oracle.sysdate(),
        'AUTO_TKN_GEN'
      )
    ) AS auto_tkn_gen,
    COALESCE(pk_azmutil.f_get_azmparam(t.mit_id, t.mtd_datum, 'KEINE_RUECKRECHNUNG'), 'N') AS keine_rueckrechnung
  FROM (
    SELECT DISTINCT
      k.mit_id,
      k.rk_id,
      k.mtd_datum
    FROM kand k
  ) t
)
SELECT
  k.mit_persnr,
  format('CALL pk_gensed2tkn.p_tkn_rueckrechnung(%L, %L, TRUE, TRUE, TRUE, pi_mit_id => %L);', MIN(k.mtd_datum), MAX(k.mtd_datum), k.mit_id) AS rueckrechnung
FROM kand k
JOIN pref p
   ON p.mit_id = k.mit_id
  AND p.mtd_datum = k.mtd_datum
LEFT JOIN LATERAL (
  SELECT string_agg(lbe.lbe_id || ' (' || lbe.lbe_herkunft || ')', ', ' ORDER BY lbe.lbe_id) AS eoa_am_tag
  FROM bos_leistungsbelege lbe
  WHERE lbe.lbe_mit_id = k.mit_id
    AND lbe.lbe_modifiziert IN ('O', 'U', 'I')
    AND k.mtd_datum BETWEEN lbe.lbe_min_tag AND lbe.lbe_max_tag
) eoa ON TRUE
WHERE p.auto_tkn_gen IN ('R', 'V', 'C', 'A')
  AND p.keine_rueckrechnung <> 'J'
  AND NOT EXISTS (
    SELECT 1
    FROM bos_cico_eoa_reject cer
    WHERE cer.cer_employee_id = k.mit_id
      AND cer.cer_state = 'REJECTED'
  )
GROUP BY k.mit_id, k.mit_persnr
ORDER BY k.mit_persnr;
`;

test('queryVariableNames finds no variables in a query with aliased LATERAL subqueries', () => {
    assert.deepEqual(queryVariableNames(LATERAL_JOIN_QUERY), []);
    const q = extractTableQualifiers(LATERAL_JOIN_QUERY);
    for (const alias of ['sed', 'saw', 'eoa', 't', 'p', 'k', 'c']) {
        assert.ok(q.has(alias), `alias ${alias} is known`);
    }
});

test('extractTableQualifiers records the alias of a LATERAL subquery', () => {
    const sql = 'SELECT x.a FROM t JOIN LATERAL (SELECT 1 a) x ON TRUE WHERE x.a = 1';
    assert.ok(extractTableQualifiers(sql).has('x'));
    assert.deepEqual(queryVariableNames(sql), []);
});

test('extractTableQualifiers records aliases of table functions, ONLY and TABLESAMPLE references', () => {
    const cases: Array<[string, string[]]> = [
        ['SELECT g.n FROM generate_series(1, 3) g WHERE g.n > 1', ['g']],
        ['SELECT u.v FROM t, unnest(t.arr) WITH ORDINALITY AS u(v, i) WHERE u.v = 1 AND u.i > 0', ['t', 'u']],
        ['SELECT r.a FROM ROWS FROM (f(), g()) AS r(a, b) WHERE r.b = 1', ['r']],
        ['SELECT p.id FROM ONLY parent p WHERE p.id = 1', ['parent', 'p']],
        ['SELECT s.id FROM t s TABLESAMPLE SYSTEM (10) REPEATABLE (1), u WHERE s.id = u.id', ['t', 's', 'u']],
        ['SELECT s.id FROM t TABLESAMPLE SYSTEM (10) s WHERE s.id = 1', ['t', 's']]
    ];
    for (const [sql, aliases] of cases) {
        const q = extractTableQualifiers(sql);
        for (const alias of aliases) assert.ok(q.has(alias), `${alias} known in: ${sql}`);
        assert.ok(!q.has('tablesample') && !q.has('lateral') && !q.has('with'), `no keyword alias in: ${sql}`);
        assert.deepEqual(queryVariableNames(sql), [], sql);
    }
});

test('queryVariableNames still reports a record-field access next to a known table', () => {
    assert.deepEqual(queryVariableNames('SELECT * FROM t WHERE t.id = pi_obj.emplid'), ['pi_obj.emplid']);
});

test('substituteVariables replaces a record-field variable', () => {
    const sql = 'SELECT * FROM bos_belege lbe WHERE lbe.lbe_mit_id = pi_employeeObj.emplId LIMIT pi_max_history';
    const out = substituteVariables(sql, { 'pi_employeeObj.emplId': '42', 'pi_max_history': '5' });
    assert.ok(out.includes('= 42'), 'record-field variable substituted');
    assert.ok(out.includes('LIMIT 5'), 'LIMIT variable substituted');
    assert.ok(out.includes('lbe.lbe_mit_id'), 'qualified column left intact');
});

// ===== extractDefinedNames =====

test('extractDefinedNames collects column aliases', () => {
    const sql = 'SELECT a AS schema_name, b AS function_name FROM t';
    const defined = extractDefinedNames(sql);
    assert.ok(defined.has('schema_name'));
    assert.ok(defined.has('function_name'));
});

test('extractDefinedNames collects CTE names', () => {
    const sql = 'WITH checks AS (SELECT 1), more AS (SELECT 2) SELECT * FROM checks';
    const defined = extractDefinedNames(sql);
    assert.ok(defined.has('checks'));
    assert.ok(defined.has('more'));
});

test('extractDefinedNames ignores SELECT without aliases', () => {
    const sql = 'SELECT a, b FROM t';
    const defined = extractDefinedNames(sql);
    assert.equal(defined.size, 0);
});

test('extractSelect does not offer a CTE column alias as a variable', () => {
    const sql = [
        'WITH checks AS (',
        '    SELECT pg_proc.oid AS function_name, pg_proc.lineno',
        '    FROM pg_proc',
        ')',
        'SELECT function_name, lineno',
        'FROM checks',
        "WHERE (schema_name || '.' || function_name) NOT LIKE 'leda_types.obj_%'",
        '  AND message NOT LIKE \'unused parameter%\';'
    ].join('\n');
    const result = extractSelect(sql, sql.indexOf('SELECT function_name'));
    assert.ok(result, 'extraction succeeds');
    assert.ok(!result!.variables.includes('function_name'),
        'a self-defined CTE column alias must not be offered for substitution');
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

test('selectStatementRange points at the inner query of a FOR loop in the original text', () => {
    const body = 'BEGIN\n    FOR r IN (\n        SELECT id\n        FROM t\n    ) LOOP\n        NULL;\n    END LOOP;\nEND;';
    const range = selectStatementRange(body, body.indexOf('id'));
    assert.ok(range);
    assert.equal(body.slice(range.start, range.end), 'SELECT id\n        FROM t');
    assert.equal(extractSelect(body, body.indexOf('id'))?.sql, 'SELECT id\n        FROM t');
});

test('selectStatementForEditing tells an INTO clause and an UPDATE apart from a plain SELECT', () => {
    const into = 'SELECT a INTO v FROM t;';
    assert.deepEqual(selectStatementForEditing(into, 3), { start: 0, end: into.length - 1, sql: 'SELECT a INTO v FROM t', isUpdate: false, hasInto: true });
    assert.equal(selectStatementForEditing('UPDATE t SET a = 1', 2)?.isUpdate, true);
    assert.equal(selectStatementForEditing('  SELECT 1 ;  ', 4)?.sql, 'SELECT 1');
    assert.equal(selectStatementForEditing('SELECT 1', 4)?.hasInto, false);
    assert.equal(selectStatementForEditing(' ; ', 1), null);
});

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

test('extractSelect preserves newlines and line comments when stripping INTO', () => {
    // Regression: collapsing whitespace while stripping INTO used to merge a
    // `-- comment` line with the following code, letting the comment swallow it
    // (and hiding variables that followed). Newlines must survive.
    const body = [
        'SELECT a  -- first column',
        '    INTO v_target',
        '    FROM t',
        '    WHERE id = p_id  -- filter',
        '      AND flag = p_flag;'
    ].join('\n');
    const cursor = body.indexOf('FROM');
    const res = extractSelect(body, cursor);
    assert.ok(res);
    assert.ok(!/\bINTO\b/i.test(res.sql), 'INTO clause is stripped');
    assert.ok(res.sql.includes('\n'), 'newlines are preserved');
    assert.ok(res.sql.includes('-- first column'), 'leading line comment kept');
    // The variable after the WHERE comment must still be detected (it would be
    // swallowed by `-- filter` if newlines were collapsed).
    assert.deepEqual(res.variables, ['p_id', 'p_flag']);
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
        'UPDATE some_table st',
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
    assert.ok(res.sql.startsWith('SELECT * FROM some_table st'), `got: ${res.sql}`);
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

test('extractTableNames skips LATERAL, table functions and ROWS FROM but keeps following tables', () => {
    const sql =
        'SELECT * FROM a, LATERAL (SELECT 1 FROM b) x, ' +
        'LATERAL generate_series(1, 3) g, ' +
        'unnest(a.arr) WITH ORDINALITY AS u(v, i), ROWS FROM (f(), g()) AS r(c, d), ' +
        'ONLY parent p, c s TABLESAMPLE SYSTEM (10), d';
    assert.deepEqual(extractTableNames(sql).sort(), ['a', 'b', 'c', 'd', 'parent']);
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
