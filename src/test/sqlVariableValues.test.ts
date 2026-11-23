import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTableAliasMap } from '../selectStatementExtractor';
import {
    buildColumnTypeLookup,
    detectVariableContext,
    formatVariableValue,
    guessVariableKind,
    guessVariableKinds,
    initialVariableInput,
    mergeVariableCache,
    parseListInput,
    parseNumberInput,
    readCachedVariable,
    readSubmittedInputs,
    substituteTypedVariables,
    untypedArrayLiteral,
    type ColumnTypeLookup
} from '../sqlVariableValues';

function spanOf(sql: string, token: string, nth = 0): { start: number; end: number } {
    let start = -1;
    for (let i = 0; i <= nth; i++) start = sql.indexOf(token, start + 1);
    assert.ok(start >= 0, `${token} not found in ${sql}`);
    return { start, end: start + token.length };
}

// ===== formatVariableValue =====

test('formatVariableValue inserts Plain SQL verbatim', () => {
    assert.deepEqual(formatVariableValue("'a' || x", 'sql'), { sql: "'a' || x" });
});

test('formatVariableValue quotes a string and doubles embedded single quotes', () => {
    assert.deepEqual(formatVariableValue("O'Reilly", 'string'), { sql: "'O''Reilly'" });
    assert.deepEqual(formatVariableValue('', 'string'), { sql: "''" });
});

test('formatVariableValue accepts numbers with thousand separators and a decimal comma', () => {
    assert.deepEqual(formatVariableValue('1 234,5', 'number'), { sql: '1234.5' });
    assert.deepEqual(formatVariableValue('1,234.5', 'number'), { sql: '1234.5' });
    assert.deepEqual(formatVariableValue('1.234,5', 'number'), { sql: '1234.5' });
    assert.deepEqual(formatVariableValue('1_000_000', 'number'), { sql: '1000000' });
    assert.deepEqual(formatVariableValue('-42', 'number'), { sql: '-42' });
    assert.deepEqual(formatVariableValue("9'999", 'number', { thousandSeparator: "'" }), { sql: '9999' });
});

test('formatVariableValue rejects text and ambiguous grouping as a number', () => {
    assert.ok(formatVariableValue('12abc', 'number').error);
    assert.ok(formatVariableValue('12,34.5', 'number').error, 'groups must have three digits');
    assert.ok(formatVariableValue('1.2.3', 'number').error);
    assert.equal(formatVariableValue('', 'number').error, 'Enter a number.');
    assert.equal(parseNumberInput('1; DROP TABLE x'), null);
});

test('formatVariableValue renders a date and rejects an impossible one', () => {
    assert.deepEqual(formatVariableValue('2024-02-29', 'date'), { sql: "DATE '2024-02-29'" });
    assert.ok(formatVariableValue('2023-02-29', 'date').error);
    assert.ok(formatVariableValue('31.01.2024', 'date').error);
    assert.ok(formatVariableValue("2024-01-31'; --", 'date').error);
});

test('formatVariableValue renders a timestamp from the date-time field and a typed one', () => {
    assert.deepEqual(formatVariableValue('2024-01-31T13:45', 'timestamp'), { sql: "TIMESTAMP '2024-01-31 13:45:00'" });
    assert.deepEqual(formatVariableValue('2024-01-31 13:45:07.123', 'timestamp'), { sql: "TIMESTAMP '2024-01-31 13:45:07.123'" });
    assert.deepEqual(formatVariableValue('2024-01-31', 'timestamp'), { sql: "TIMESTAMP '2024-01-31 00:00:00'" });
    assert.ok(formatVariableValue('2024-01-31 24:00', 'timestamp').error);
    assert.ok(formatVariableValue('yesterday', 'timestamp').error);
});

test('formatVariableValue renders a boolean and NULL', () => {
    assert.deepEqual(formatVariableValue('true', 'boolean'), { sql: 'TRUE' });
    assert.deepEqual(formatVariableValue('false', 'boolean'), { sql: 'FALSE' });
    assert.ok(formatVariableValue('maybe', 'boolean').error);
    assert.deepEqual(formatVariableValue('ignored', 'null'), { sql: 'NULL' });
});

test('parseListInput splits by line when there are lines, otherwise by comma', () => {
    assert.deepEqual(parseListInput('a, b ,c'), ['a', 'b', 'c']);
    assert.deepEqual(parseListInput('x, y\r\n\r\nz\n'), ['x, y', 'z']);
    assert.deepEqual(parseListInput('  '), []);
});

test('formatVariableValue renders a list of strings or numbers in the requested wrapping', () => {
    assert.deepEqual(formatVariableValue("a\nO'Neil", 'list', { listKind: 'string' }), { sql: "('a', 'O''Neil')" });
    assert.deepEqual(formatVariableValue('1, 2', 'list', { listKind: 'number', listWrapping: 'bare' }), { sql: '1, 2' });
    assert.deepEqual(formatVariableValue('1,5\n2', 'list', { listKind: 'number', listWrapping: 'array' }), { sql: 'ARRAY[1.5, 2]' });
    assert.equal(formatVariableValue('1, x', 'list', { listKind: 'number' }).error, 'Item 2: "x" is not a number.');
    assert.equal(formatVariableValue('', 'list').error, 'Enter at least one value.');
});

test('formatVariableValue renders a text list for = ANY(…) as one untyped array literal', () => {
    const uuids = '0b6f5c1e-8d0a-4a51-9a39-2b1f2e3c4d5e, 6a1c3a0e-1f7b-4a0d-8f4e-9c2d1b0a7e6f';
    assert.deepEqual(formatVariableValue(uuids, 'list', { listKind: 'string', listWrapping: 'array' }), {
        sql: `'{"0b6f5c1e-8d0a-4a51-9a39-2b1f2e3c4d5e","6a1c3a0e-1f7b-4a0d-8f4e-9c2d1b0a7e6f"}'`
    });
    const tricky = 'say "hi"\nback\\slash\nO\'Neil\na,b\n{x}\nNULL';
    assert.deepEqual(formatVariableValue(tricky, 'list', { listWrapping: 'array' }), {
        sql: `'{"say \\"hi\\"","back\\\\slash","O''Neil","a,b","{x}","NULL"}'`
    });
    assert.deepEqual(formatVariableValue("a\nO'Neil", 'list', { listKind: 'string', listWrapping: 'bare' }), { sql: "'a', 'O''Neil'" }, 'IN lists keep the quoted items');
    assert.equal(untypedArrayLiteral([]), "'{}'");
});

// ===== substituteTypedVariables =====

test('substituteTypedVariables adds parentheses only where the list has none', () => {
    const inputs = { ':ids': { value: '1, 2', kind: 'list' as const, listKind: 'number' as const } };
    assert.equal(substituteTypedVariables('SELECT * FROM t WHERE x IN (:ids)', inputs).sql, 'SELECT * FROM t WHERE x IN (1, 2)');
    assert.equal(substituteTypedVariables('SELECT * FROM t WHERE x IN :ids', inputs).sql, 'SELECT * FROM t WHERE x IN (1, 2)');
    assert.equal(substituteTypedVariables('SELECT * FROM t WHERE x = ANY(:ids)', inputs).sql, 'SELECT * FROM t WHERE x = ANY(ARRAY[1, 2])');
    const names = { ':ids': { value: 'a, b', kind: 'list' as const, listKind: 'string' as const } };
    assert.equal(substituteTypedVariables('SELECT * FROM t WHERE id = ANY(:ids)', names).sql, `SELECT * FROM t WHERE id = ANY('{"a","b"}')`);
    assert.equal(substituteTypedVariables('SELECT * FROM t WHERE id IN (:ids)', names).sql, "SELECT * FROM t WHERE id IN ('a', 'b')");
});

test('substituteTypedVariables reports invalid values and leaves their variable in place', () => {
    const result = substituteTypedVariables('SELECT * FROM t WHERE a = :a AND b = :b', {
        ':a': { value: 'abc', kind: 'number' },
        ':B': { value: "it's", kind: 'string' }
    });
    assert.equal(result.sql, "SELECT * FROM t WHERE a = :a AND b = 'it''s'");
    assert.deepEqual(Object.keys(result.errors), [':a']);
});

test('substituteTypedVariables keeps a variable with empty Plain SQL and never forms a comment', () => {
    const result = substituteTypedVariables('SELECT x-:n, :k FROM t', {
        ':n': { value: '-5', kind: 'number' },
        ':k': { value: '', kind: 'sql' }
    });
    assert.equal(result.sql, 'SELECT x- -5, :k FROM t');
});

// ===== detectVariableContext =====

test('detectVariableContext reads the column on either side of a comparison', () => {
    const a = 'SELECT * FROM mitarbeiter a WHERE a.mit_id = :id';
    assert.deepEqual(detectVariableContext(a, spanOf(a, ':id')).column, { qualifier: 'a', column: 'mit_id' });
    const b = 'SELECT * FROM mitarbeiter WHERE :id = mit_id';
    assert.deepEqual(detectVariableContext(b, spanOf(b, ':id')).column, { column: 'mit_id' });
    const c = 'SELECT * FROM t WHERE x::text = :v';
    assert.equal(detectVariableContext(c, spanOf(c, ':v')).column, undefined);
});

test('detectVariableContext recognises a whole IN list and a single list element', () => {
    const sql = 'SELECT * FROM t WHERE x IN (:ids) AND y NOT IN (:a, 3)';
    const whole = detectVariableContext(sql, spanOf(sql, ':ids'));
    assert.deepEqual(whole, { isWholeList: true, listWrapping: 'bare', column: { column: 'x' } });
    const element = detectVariableContext(sql, spanOf(sql, ':a'));
    assert.equal(element.isWholeList, false);
    assert.deepEqual(element.column, { column: 'y' });
});

test('detectVariableContext finds the column of both BETWEEN bounds', () => {
    const sql = 'SELECT * FROM t WHERE t.d BETWEEN :a AND :b';
    assert.deepEqual(detectVariableContext(sql, spanOf(sql, ':a')).column, { qualifier: 't', column: 'd' });
    assert.deepEqual(detectVariableContext(sql, spanOf(sql, ':b')).column, { qualifier: 't', column: 'd' });
});

test('detectVariableContext hints a string after LIKE and a number after LIMIT', () => {
    const sql = 'SELECT * FROM t WHERE name LIKE :p LIMIT $1';
    assert.equal(detectVariableContext(sql, spanOf(sql, ':p')).hint, 'string');
    assert.equal(detectVariableContext(sql, spanOf(sql, '$1')).hint, 'number');
});

// ===== guessVariableKind / guessVariableKinds =====

test('guessVariableKind maps column types to value types', () => {
    assert.equal(guessVariableKind('integer'), 'number');
    assert.equal(guessVariableKind('numeric(10,2)'), 'number');
    assert.equal(guessVariableKind('double precision'), 'number');
    assert.equal(guessVariableKind('date'), 'date');
    assert.equal(guessVariableKind('timestamp without time zone'), 'timestamp');
    assert.equal(guessVariableKind('timestamptz'), 'timestamp');
    assert.equal(guessVariableKind('boolean'), 'boolean');
    assert.equal(guessVariableKind('character varying'), 'string');
    assert.equal(guessVariableKind('uuid'), 'string');
    assert.equal(guessVariableKind('jsonb'), 'string');
    assert.equal(guessVariableKind('ARRAY'), 'sql');
    assert.equal(guessVariableKind('integer[]'), 'sql');
    assert.equal(guessVariableKind(undefined), 'sql');
});

test('guessVariableKinds resolves aliases through the referenced tables', () => {
    const sql = `SELECT * FROM emp e JOIN dept d ON d.id = e.dept_id
                 WHERE e.id = p_id AND d.name IN (:names) AND e.hired BETWEEN $1 AND $2 AND e.active = :flag AND note = :n`;
    const lookup = buildColumnTypeLookup(extractTableAliasMap(sql), [
        { table: 'emp', column: 'id', type: 'integer' },
        { table: 'emp', column: 'hired', type: 'date' },
        { table: 'emp', column: 'active', type: 'boolean' },
        { table: 'emp', column: 'note', type: 'text' },
        { table: 'dept', column: 'id', type: 'integer' },
        { table: 'dept', column: 'name', type: 'text' }
    ]);
    const guesses = guessVariableKinds(sql, lookup);
    assert.deepEqual(guesses.get('p_id'), { kind: 'number' });
    assert.deepEqual(guesses.get(':names'), { kind: 'list', listKind: 'string' });
    assert.deepEqual(guesses.get('$1'), { kind: 'date' });
    assert.deepEqual(guesses.get('$2'), { kind: 'date' });
    assert.deepEqual(guesses.get(':flag'), { kind: 'boolean' });
    assert.deepEqual(guesses.get(':n'), { kind: 'string' });
});

test('an unqualified column that two tables type differently gives no guess', () => {
    const sql = 'SELECT * FROM a, b WHERE code = :c';
    const lookup = buildColumnTypeLookup(extractTableAliasMap(sql), [
        { table: 'a', column: 'code', type: 'integer' },
        { table: 'b', column: 'code', type: 'text' }
    ]);
    assert.equal(guessVariableKinds(sql, lookup).has(':c'), false);
});

test('an unknown column gives no guess, so the variable stays Plain SQL', () => {
    const none: ColumnTypeLookup = () => undefined;
    assert.equal(guessVariableKinds('SELECT * FROM t WHERE x = :v', none).size, 0);
    assert.deepEqual(initialVariableInput(undefined, undefined), { value: '', kind: 'sql' });
});

// ===== Remembered values =====

test('a cached plain string from an older version is read as Plain SQL', () => {
    assert.deepEqual(readCachedVariable("'active'"), { value: "'active'", kind: 'sql' });
    assert.deepEqual(readCachedVariable({ value: '1', kind: 'list', listKind: 'number' }), { value: '1', kind: 'list', listKind: 'number' });
    assert.equal(readCachedVariable({ value: 1, kind: 'number' }), undefined);
    assert.equal(readCachedVariable({ value: '1', kind: 'bogus' }), undefined);
});

test('a remembered choice overrides the guess unless it is empty Plain SQL', () => {
    assert.deepEqual(initialVariableInput({ value: 'x', kind: 'string' }, { kind: 'number' }), { value: 'x', kind: 'string' });
    assert.deepEqual(initialVariableInput("'a'", { kind: 'number' }), { value: "'a'", kind: 'sql' });
    assert.deepEqual(initialVariableInput('', { kind: 'number' }), { value: '', kind: 'number' });
    assert.deepEqual(initialVariableInput(undefined, { kind: 'list', listKind: 'number' }), { value: '', kind: 'list', listKind: 'number' });
});

test('mergeVariableCache stores value and type under the lower-cased name and keeps other entries', () => {
    const merged = mergeVariableCache({ old: 'x', p_id: 'stale' }, {
        P_ID: { value: '7', kind: 'number', listKind: 'number' },
        ids: { value: 'a', kind: 'list' }
    });
    assert.deepEqual(merged, {
        old: 'x',
        p_id: { value: '7', kind: 'number' },
        ids: { value: 'a', kind: 'list', listKind: 'string' }
    });
});

test('readSubmittedInputs keeps only expected, well-formed variables', () => {
    const inputs = readSubmittedInputs({
        ':a': { value: '1', kind: 'number' },
        ':b': 'raw string',
        ':c': { value: '1', kind: 'nope' },
        ':x': { value: '1', kind: 'sql' }
    }, [':a', ':b', ':c']);
    assert.deepEqual(inputs, { ':a': { value: '1', kind: 'number' } });
});
