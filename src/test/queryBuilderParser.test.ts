import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPostgresParser, modelFromParseResult, parseSelect, parseSql, replacePlaceholders, SqlParseError } from '../queryBuilderParser';
import { generateSql, type QueryModel } from '../queryBuilderModel';

// ===== loader =====

test('loadPostgresParser loads the WebAssembly parser once', async () => {
    const first = loadPostgresParser();
    assert.equal(loadPostgresParser(), first);
    const mod = await first;
    assert.equal(typeof mod.parse, 'function');
});

// ===== parseSql =====

test('parseSql returns the libpg_query parse tree', async () => {
    const tree = await parseSql('SELECT 1 AS one');
    assert.equal(tree.stmts.length, 1);
    assert.equal(tree.stmts[0].stmt.SelectStmt.targetList[0].ResTarget.name, 'one');
});

test('parseSql reports syntax errors with their character position', async () => {
    await assert.rejects(parseSql('SELECT ä FROM WHERE'), (err: unknown) => {
        assert.ok(err instanceof SqlParseError);
        assert.equal(err.position, 14);
        assert.match(err.message, /^Syntax error at position 15: syntax error at or near "WHERE"/);
        return true;
    });
});

// ===== parseSelect =====

test('parseSelect ignores a byte order mark', async () => {
    const model = await parseSelect('\uFEFFSELECT a FROM t');
    assert.equal(model.columns[0].expression, 'a');
});

test('parseSelect refuses a parenthesized first SELECT with a clear message', async () => {
    await assert.rejects(parseSelect('(SELECT 1) UNION SELECT 2'), /starts with SELECT/);
});

test('modelFromParseResult reads the statement at its location in a longer text', async () => {
    const sql = '  -- header\n  SELECT x FROM t;  ';
    const model = modelFromParseResult(sql, await parseSql(sql));
    assert.deepEqual(model.columns.map((c) => c.expression), ['x']);
    assert.deepEqual(model.warnings, []);
});

// ===== placeholders =====

/** Parse, generate, parse again: the generated SQL is stable and returned. */
async function roundTrip(sql: string): Promise<{ model: QueryModel; generated: string }> {
    const model = await parseSelect(sql);
    const generated = generateSql(model);
    assert.equal(generateSql(await parseSelect(generated)), generated, 'the generated SQL reads back into the same query');
    return { model, generated };
}

test('parseSelect reads a :name placeholder in WHERE as a criterion of the column', async () => {
    const { model, generated } = await roundTrip('SELECT * FROM leda.bos_mitarbeiter m WHERE m.mit_id = :id');
    const column = model.columns.find((c) => c.expression === 'm.mit_id');
    assert.deepEqual([column?.tableId, column?.column, column?.criteria], ['t1', 'mit_id', ['= :id']]);
    assert.deepEqual(model.warnings, []);
    assert.match(generated, /m\.mit_id = :id/);
});

test('parseSelect keeps placeholders in an IN list, LIMIT and OFFSET', async () => {
    const { model, generated } = await roundTrip('SELECT a FROM t WHERE a IN (:a, :b) LIMIT :n OFFSET :o');
    assert.deepEqual(model.columns[0].criteria, ['IN (:a, :b)']);
    assert.deepEqual([model.limit, model.offset], [':n', ':o']);
    assert.match(generated, /LIMIT :n\nOFFSET :o/);
});

test('parseSelect keeps psql-style quoted placeholders and leaves a cast alone', async () => {
    const { model, generated } = await roundTrip(`SELECT :"col", a::text FROM t WHERE d >= :'from'::date`);
    assert.deepEqual(model.columns.map((c) => [c.expression, c.tableId]), [[':"col"', undefined], ['a::text', undefined], ['d', 't1']]);
    assert.deepEqual(model.columns[2].criteria, [`>= :'from'::date`]);
    assert.match(generated, /SELECT\n {4}:"col",\n {4}a::text/);
});

test('parseSelect shows a placeholder in the select list as an expression of no table', async () => {
    const { model } = await roundTrip('SELECT :x AS v, t.a FROM t');
    assert.deepEqual([model.columns[0].expression, model.columns[0].alias, model.columns[0].tableId], [':x', 'v', undefined]);
});

test('parseSelect keeps a placeholder table as a raw box with a warning', async () => {
    const { model, generated } = await roundTrip('SELECT t.x FROM :tbl t WHERE t.id = :id');
    assert.deepEqual(model.tables.map((t) => [t.kind, t.sql, t.alias, t.name]), [['function', ':tbl', 't', undefined]]);
    assert.ok(model.warnings.some((w) => /placeholder/.test(w)));
    assert.deepEqual(model.columns[1].criteria, ['= :id']);
    assert.match(generated, /FROM\n {4}:tbl t\n/);
});

test('parseSelect keeps a placeholder in a join condition as a raw condition of the join', async () => {
    const { model, generated } = await roundTrip('SELECT * FROM a JOIN b ON a.id = b.a_id AND b.kind = :val');
    assert.deepEqual(model.joins.map((j) => [j.pairs.length, j.condition]), [[1, 'b.kind = :val']]);
    assert.match(generated, /ON a\.id = b\.a_id AND b\.kind = :val/);
});

test('parseSelect leaves casts, assignments-like text, strings and slices alone', async () => {
    const { model } = await roundTrip(`SELECT a[1:2], a[lo:hi], ARRAY[:p] FROM t WHERE c = ':x' AND b = 1::int`);
    assert.deepEqual(model.columns.slice(0, 3).map((c) => c.expression), ['a[1:2]', 'a[lo:hi]', 'ARRAY[:p]']);
    assert.deepEqual(model.columns.slice(3).map((c) => c.criteria[0]), [`= ':x'`, '= 1::int']);
    const replaced = replacePlaceholders(`SELECT ':x', a::text, a[lo:hi] -- :c\nFROM t`);
    assert.equal(replaced.standIns.size, 0);
});

test('replacePlaceholders uses stand-ins that do not occur in the SQL', () => {
    const replaced = replacePlaceholders('SELECT __qb_ph_0__ FROM t WHERE a = :id');
    assert.equal(replaced.standIns.size, 1);
    const [standIn] = [...replaced.standIns.keys()];
    assert.notEqual(standIn, '__qb_ph_0__');
    assert.equal(replaced.sql, `SELECT __qb_ph_0__ FROM t WHERE a = ${standIn}`);
});

test('a syntax error after a placeholder is reported at its position in the original text', async () => {
    const sql = 'SELECT * FROM t WHERE a = :id AND AND b';
    await assert.rejects(parseSelect(sql), (err: unknown) => {
        assert.ok(err instanceof SqlParseError);
        assert.equal(err.position, sql.lastIndexOf('AND'));
        assert.match(err.message, /^Syntax error at position 35: syntax error at or near "AND"/);
        return true;
    });
    await assert.rejects(parseSelect('SELECT * FROM t WHERE a = :id :x'), (err: unknown) => {
        assert.ok(err instanceof SqlParseError);
        assert.equal(err.position, 30);
        assert.match(err.message, /near ":x"/);
        return true;
    });
});

test('a placeholder that stands for an alias is refused with a clear message', async () => {
    await assert.rejects(parseSelect('SELECT a AS :"name" FROM t'), /placeholder :"name" stands for a name/);
});

test('a PL/pgSQL record field is a value, so its comparison is a criterion of the column', async () => {
    const { model } = await roundTrip('SELECT * FROM t x WHERE x.b = pi_obj.emplid AND x.c = x.d');
    assert.deepEqual(model.columns.find((c) => c.expression === 'x.b')?.criteria, ['= pi_obj.emplid']);
    assert.deepEqual(model.whereExtra, ['x.c = x.d']);
});
