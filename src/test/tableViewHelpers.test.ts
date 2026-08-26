import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const {
    cellToString,
    hasSqlComment,
    collapseSqlWhitespace,
    splitTopLevelCommas,
    splitTopLevelClauses,
    buildRowIdentity,
    buildSelectColumnList,
    reorderColumns,
    reorderSelectColumns,
    buildColumnHeaderTitle,
    nextSortState,
    computeResizedRowHeight,
    computeResizedColumnWidth,
    cssStringLiteral,
    buildColumnWidthCss,
    remainingRowCount,
    formatExecutionTime,
    emptyCapabilities,
    normalizeCapabilities,
    buildCommitTargets,
    describeRowCount,
    columnWriteMode,
    buildCommitWarnings,
    isSqlEdited,
    parsePgType,
    validateCellValue,
    formatColumnTypeLabel,
    describeCharacterBudget,
    charBudgetStateClass,
    classifyColumnDefault,
    defaultResetColumns,
    defaultCellTitle,
    headerRelationTargets,
    isLiftableSelect,
    relatedJoinPayload,
    describePendingChanges
} = require(path.join(__dirname, '../../../src/webview/tableView.js'));

test('classifyColumnDefault separates generated, volatile and constant defaults', () => {
    assert.equal(classifyColumnDefault({ column: 'id', defaultExpression: null, isIdentity: true, isGenerated: false }), 'generated');
    assert.equal(classifyColumnDefault({ column: 'total', defaultExpression: null, isIdentity: false, isGenerated: true }), 'generated');
    assert.equal(classifyColumnDefault({ column: 'id', defaultExpression: "nextval('t_id_seq'::regclass)", isIdentity: false, isGenerated: false }), 'volatile');
    assert.equal(classifyColumnDefault({ column: 'created', defaultExpression: 'CURRENT_DATE', isIdentity: false, isGenerated: false }), 'volatile');
    assert.equal(classifyColumnDefault({ column: 'created_by', defaultExpression: 'CURRENT_USER', isIdentity: false, isGenerated: false }), 'volatile');
    assert.equal(classifyColumnDefault({ column: 'uid', defaultExpression: 'gen_random_uuid()', isIdentity: false, isGenerated: false }), 'volatile');
    assert.equal(classifyColumnDefault({ column: 'state', defaultExpression: "'open'::character varying", isIdentity: false, isGenerated: false }), 'constant');
    assert.equal(classifyColumnDefault({ column: 'amount', defaultExpression: '0', isIdentity: false, isGenerated: false }), 'constant');
    assert.equal(classifyColumnDefault({ column: 'flag', defaultExpression: 'false', isIdentity: false, isGenerated: false }), 'constant');
});

test('classifyColumnDefault ignores keywords inside string literals', () => {
    assert.equal(classifyColumnDefault({ column: 'role', defaultExpression: "'user'::text", isIdentity: false, isGenerated: false }), 'constant');
    assert.equal(classifyColumnDefault({ column: 'note', defaultExpression: "'now'::text", isIdentity: false, isGenerated: false }), 'constant');
});

test('classifyColumnDefault treats every function call as volatile', () => {
    for (const expression of [
        'oracle.sysdate()',
        'clock_timestamp()',
        'transaction_timestamp()',
        'uuid_generate_v4()',
        'public.next_order_number()',
        'my_schema.my_func(1, 2)',
        '(now())::date'
    ]) {
        assert.equal(
            classifyColumnDefault({ column: 'c', defaultExpression: expression, isIdentity: false, isGenerated: false }),
            'volatile',
            expression
        );
    }
});

test('classifyColumnDefault does not mistake a cast modifier for a function call', () => {
    for (const expression of [
        '0::numeric(10,2)',
        "''::character varying(10)",
        "'{}'::jsonb",
        'NULL::integer',
        "ARRAY[]::text[]",
        '(1 + 2)'
    ]) {
        assert.equal(
            classifyColumnDefault({ column: 'c', defaultExpression: expression, isIdentity: false, isGenerated: false }),
            'constant',
            expression
        );
    }
});

test('classifyColumnDefault returns null without a default', () => {
    assert.equal(classifyColumnDefault({ column: 'name', defaultExpression: null, isIdentity: false, isGenerated: false }), null);
    assert.equal(classifyColumnDefault({ column: 'name', defaultExpression: '   ', isIdentity: false, isGenerated: false }), null);
    assert.equal(classifyColumnDefault(null), null);
});

const sampleDefaults = [
    { column: 'id', defaultExpression: "nextval('t_id_seq'::regclass)", isIdentity: false, isGenerated: false },
    { column: 'created', defaultExpression: 'CURRENT_DATE', isIdentity: false, isGenerated: false },
    { column: 'state', defaultExpression: "'open'::character varying", isIdentity: false, isGenerated: false },
    { column: 'line_total', defaultExpression: null, isIdentity: false, isGenerated: true }
];

test('defaultResetColumns resets only volatile defaults by default', () => {
    assert.deepEqual(defaultResetColumns(sampleDefaults, 'volatile'), ['id', 'created', 'line_total']);
});

test('defaultResetColumns can reset every default or none at all', () => {
    assert.deepEqual(defaultResetColumns(sampleDefaults, 'all'), ['id', 'created', 'state', 'line_total']);
    assert.deepEqual(defaultResetColumns(sampleDefaults, 'none'), []);
});

test('defaultResetColumns copes with missing metadata', () => {
    assert.deepEqual(defaultResetColumns([], 'volatile'), []);
    assert.deepEqual(defaultResetColumns(undefined, 'volatile'), []);
});

test('defaultCellTitle names the expression that fills the column', () => {
    assert.equal(defaultCellTitle(sampleDefaults[1]), 'Filled by the database on save (CURRENT_DATE)');
    assert.equal(defaultCellTitle(sampleDefaults[3]), 'Generated by the database on save');
    assert.equal(defaultCellTitle(undefined), 'Filled by the database on save');
});

const relationFixture = {
    foreignKeys: [{ column: 'rk_id', refSchema: 'public', refTable: 'regionen', refColumn: 'reg_id' }],
    referencingTables: [{ localColumn: 'rk_id', fkSchema: 'public', fkTable: 'sap_rk_zuordnungen', fkColumn: 'srz_rk_id' }],
    customMappings: [
        {
            sourceColumn: 'rk_id',
            targetSchema: 'public',
            targetTable: 'kunden',
            targetColumn: 'kd_rk',
            label: 'Customers',
            conditions: [{ column: 'rk_aktiv', operator: '=', value: 'J' }],
            additionalColumnPairs: [{ sourceColumn: 'rk_mandant', targetColumn: 'kd_mandant' }]
        },
        { sourceColumn: 'other', targetSchema: 'public', targetTable: 'x', targetColumn: 'y' }
    ]
};

test('headerRelationTargets lists foreign keys, referencing tables and mappings', () => {
    const targets = headerRelationTargets(
        'rk_id', relationFixture.foreignKeys, relationFixture.referencingTables, relationFixture.customMappings
    );
    assert.equal(targets.length, 3);
    assert.deepEqual(targets[0].columnPairs, [{ sourceColumn: 'rk_id', targetColumn: 'reg_id' }]);
    assert.equal(targets[0].label, 'public.regionen.reg_id');
    assert.equal(targets[1].targetTable, 'sap_rk_zuordnungen');
    assert.deepEqual(targets[1].columnPairs, [{ sourceColumn: 'rk_id', targetColumn: 'srz_rk_id' }]);
});

test('headerRelationTargets keeps the extra pairs and conditions of a mapping', () => {
    const targets = headerRelationTargets('rk_id', [], [], relationFixture.customMappings);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].label, 'Customers');
    assert.deepEqual(targets[0].columnPairs, [
        { sourceColumn: 'rk_id', targetColumn: 'kd_rk' },
        { sourceColumn: 'rk_mandant', targetColumn: 'kd_mandant' }
    ]);
    assert.deepEqual(targets[0].sourceConditions, [{ column: 'rk_aktiv', operator: '=', value: 'J' }]);
});

test('headerRelationTargets marks a reversed mapping and reads its target conditions', () => {
    const targets = headerRelationTargets('a', [], [], [{
        sourceColumn: 'a',
        targetSchema: 's',
        targetTable: 't',
        targetColumn: 'b',
        reversed: true,
        targetConditions: [{ column: 'kind', operator: '=', value: 'X' }]
    }]);
    assert.equal(targets[0].label, 's.t.b (reverse)');
    assert.deepEqual(targets[0].targetConditions, [{ column: 'kind', operator: '=', value: 'X' }]);
});

test('headerRelationTargets returns nothing for an unrelated column', () => {
    assert.deepEqual(
        headerRelationTargets('unrelated', relationFixture.foreignKeys, relationFixture.referencingTables, relationFixture.customMappings),
        []
    );
    assert.deepEqual(headerRelationTargets('rk_id', undefined, undefined, undefined), []);
});

test('isLiftableSelect accepts a plain single-table select', () => {
    assert.equal(isLiftableSelect('SELECT rk_id, rk_rk FROM regionen'), true);
    assert.equal(isLiftableSelect("SELECT * FROM public.regionen WHERE rk_rk = 'DEB' ORDER BY rk_id LIMIT 100"), true);
    assert.equal(isLiftableSelect('SELECT a FROM t WHERE b IN (SELECT c FROM u)'), true);
});

test('isLiftableSelect rejects a query whose WHERE clause cannot be moved', () => {
    assert.equal(isLiftableSelect('SELECT a FROM t JOIN u ON t.id = u.id'), false);
    assert.equal(isLiftableSelect('SELECT a FROM t, u'), false);
    assert.equal(isLiftableSelect('SELECT a FROM (SELECT 1) x'), false);
    assert.equal(isLiftableSelect('SELECT DISTINCT a FROM t'), false);
    assert.equal(isLiftableSelect('SELECT a, count(*) FROM t GROUP BY a'), false);
    assert.equal(isLiftableSelect('WITH x AS (SELECT 1) SELECT * FROM x'), false);
    assert.equal(isLiftableSelect('SELECT a FROM t UNION SELECT b FROM u'), false);
    assert.equal(isLiftableSelect(''), false);
});

test('relatedJoinPayload hands over the WHERE and ORDER BY of a plain select', () => {
    const rel = {
        targetSchema: 'public', targetTable: 'sap_rk_zuordnungen',
        columnPairs: [{ sourceColumn: 'rk_id', targetColumn: 'srz_rk_id' }]
    };
    const payload = relatedJoinPayload(rel, 'public', 'regionen', "SELECT rk_id FROM regionen WHERE rk_rk = 'DEB' ORDER BY rk_id");
    assert.equal(payload.where, "rk_rk = 'DEB'");
    assert.equal(payload.orderBy, 'rk_id');
    assert.equal(payload.sourceSql, '');
    assert.equal(payload.sourceTable, 'regionen');
    assert.deepEqual(payload.sourceConditions, []);
});

test('relatedJoinPayload carries a query it cannot take apart over whole', () => {
    const rel = { targetSchema: 's', targetTable: 't', columnPairs: [{ sourceColumn: 'a', targetColumn: 'b' }] };
    const sql = 'SELECT a, count(*) FROM t GROUP BY a';
    const payload = relatedJoinPayload(rel, 's', 't', sql);
    assert.equal(payload.sourceSql, sql);
    assert.equal(payload.where, '');
    assert.equal(payload.orderBy, '');
});

test('describeCharacterBudget reports usage and remaining characters', () => {
    const budget = describeCharacterBudget('abcd', 'character varying(10)');
    assert.equal(budget.used, 4);
    assert.equal(budget.limit, 10);
    assert.equal(budget.remaining, 6);
    assert.equal(budget.state, 'normal');
    assert.equal(budget.text, '4 / 10 \u00b7 6 left');
});

test('describeCharacterBudget warns from 80 percent of the length on', () => {
    assert.equal(describeCharacterBudget('a'.repeat(79), 'varchar(100)').state, 'normal');
    assert.equal(describeCharacterBudget('a'.repeat(80), 'varchar(100)').state, 'warning');
    const full = describeCharacterBudget('a'.repeat(100), 'varchar(100)');
    assert.equal(full.state, 'warning');
    assert.equal(full.text, '100 / 100 \u00b7 0 left');
});

test('describeCharacterBudget reports how far a value exceeds the length', () => {
    const over = describeCharacterBudget('a'.repeat(105), 'varchar(100)');
    assert.equal(over.state, 'exceeded');
    assert.equal(over.remaining, -5);
    assert.equal(over.text, '105 / 100 \u00b7 5 over');
});

test('describeCharacterBudget counts characters, not bytes', () => {
    assert.equal(describeCharacterBudget('\u00e4\u00f6\u00fc\u00df\u20ac', 'varchar(10)').used, 5);
});

test('describeCharacterBudget treats NULL and an empty value as unused', () => {
    assert.equal(describeCharacterBudget(null, 'varchar(5)').used, 0);
    assert.equal(describeCharacterBudget(undefined, 'varchar(5)').remaining, 5);
    assert.equal(describeCharacterBudget('', 'varchar(5)').used, 0);
});

test('describeCharacterBudget stays silent for types without a character limit', () => {
    for (const type of ['text', 'character varying', 'varchar', 'integer', 'numeric(10,2)', 'jsonb', '']) {
        assert.equal(describeCharacterBudget('abc', type), null, type);
    }
    assert.equal(describeCharacterBudget('abc', 'character varying(5)[]'), null);
});

test('describeCharacterBudget also covers the fixed-length char types', () => {
    assert.equal(describeCharacterBudget('ab', 'character(3)').remaining, 1);
    assert.equal(describeCharacterBudget('ab', 'bpchar(3)').limit, 3);
});

test('charBudgetStateClass marks only a tight or exceeded budget', () => {
    assert.equal(charBudgetStateClass(describeCharacterBudget('a', 'varchar(100)')), '');
    assert.equal(charBudgetStateClass(describeCharacterBudget('a'.repeat(90), 'varchar(100)')), ' is-warning');
    assert.equal(charBudgetStateClass(describeCharacterBudget('a'.repeat(101), 'varchar(100)')), ' is-exceeded');
    assert.equal(charBudgetStateClass(null), '');
});

test('formatColumnTypeLabel includes declared character lengths', () => {
    assert.equal(formatColumnTypeLabel({ dataType: 'varchar', fullType: 'character varying(10)' }), 'varchar(10)');
    assert.equal(formatColumnTypeLabel({ dataType: 'char', fullType: 'character(3)' }), 'char(3)');
    assert.equal(formatColumnTypeLabel({ dataType: 'varchar', fullType: 'character varying' }), 'varchar');
    assert.equal(formatColumnTypeLabel({ dataType: 'numeric', fullType: 'numeric(10,2)' }), 'numeric(10,2)');
});

// ===== cellToString =====

test('cellToString renders null and undefined as an empty string', () => {
    assert.equal(cellToString(null), '');
    assert.equal(cellToString(undefined), '');
});

test('cellToString stringifies primitive values', () => {
    assert.equal(cellToString(42), '42');
    assert.equal(cellToString(0), '0');
    assert.equal(cellToString(false), 'false');
    assert.equal(cellToString('hello'), 'hello');
});

test('cellToString serializes objects and arrays as JSON', () => {
    assert.equal(cellToString({ a: 1, b: 'x' }), '{"a":1,"b":"x"}');
    assert.equal(cellToString([1, 2, 3]), '[1,2,3]');
    assert.equal(cellToString({ nested: { y: true } }), '{"nested":{"y":true}}');
});

test('cellToString falls back to String() for non-serializable objects', () => {
    const circular: any = {};
    circular.self = circular;
    assert.equal(cellToString(circular), '[object Object]');
});

// ===== hasSqlComment =====

test('hasSqlComment detects a line comment', () => {
    assert.equal(hasSqlComment('SELECT 1 -- trailing'), true);
});

test('hasSqlComment detects a block comment', () => {
    assert.equal(hasSqlComment('SELECT /* c */ 1'), true);
});

test('hasSqlComment returns false for a plain statement', () => {
    assert.equal(hasSqlComment('SELECT * FROM t WHERE x = 1'), false);
});

test('hasSqlComment ignores comment markers inside a string literal', () => {
    assert.equal(hasSqlComment("SELECT '-- not a comment'"), false);
    assert.equal(hasSqlComment("SELECT '/* not a comment */'"), false);
});

test('hasSqlComment ignores comment markers inside a quoted identifier', () => {
    assert.equal(hasSqlComment('SELECT "weird--col" FROM t'), false);
});

test('hasSqlComment handles escaped quotes within a string literal', () => {
    assert.equal(hasSqlComment("SELECT 'O''Reilly -- x'"), false);
});

// ===== collapseSqlWhitespace =====

test('collapseSqlWhitespace collapses runs of whitespace to single spaces', () => {
    assert.equal(collapseSqlWhitespace('SELECT   *\n\nFROM\tt'), 'SELECT * FROM t');
});

test('collapseSqlWhitespace trims leading and trailing whitespace', () => {
    assert.equal(collapseSqlWhitespace('   SELECT 1   '), 'SELECT 1');
});

test('collapseSqlWhitespace preserves whitespace inside string literals', () => {
    assert.equal(collapseSqlWhitespace("SELECT  'a   b'  FROM t"), "SELECT 'a   b' FROM t");
});

test('collapseSqlWhitespace preserves whitespace inside quoted identifiers', () => {
    assert.equal(collapseSqlWhitespace('SELECT  "a   b"  FROM t'), 'SELECT "a   b" FROM t');
});

// ===== splitTopLevelCommas =====

test('splitTopLevelCommas splits a simple column list', () => {
    assert.deepEqual(splitTopLevelCommas('a, b, c'), ['a', ' b', ' c']);
});

test('splitTopLevelCommas keeps commas inside parentheses intact', () => {
    assert.deepEqual(
        splitTopLevelCommas('a, fn(b, c), d'),
        ['a', ' fn(b, c)', ' d']
    );
});

test('splitTopLevelCommas keeps commas inside string literals intact', () => {
    assert.deepEqual(
        splitTopLevelCommas("a, 'x, y', b"),
        ['a', " 'x, y'", ' b']
    );
});

test('splitTopLevelCommas keeps commas inside quoted identifiers intact', () => {
    assert.deepEqual(
        splitTopLevelCommas('a, "weird, col", b'),
        ['a', ' "weird, col"', ' b']
    );
});

test('splitTopLevelCommas returns a single element when there is no top-level comma', () => {
    assert.deepEqual(splitTopLevelCommas('count(*)'), ['count(*)']);
});

// ===== splitTopLevelClauses =====

test('splitTopLevelClauses splits a SELECT into ordered clause segments', () => {
    assert.deepEqual(
        splitTopLevelClauses('SELECT a FROM t WHERE x = 1'),
        [
            { kw: 'SELECT', content: 'a' },
            { kw: 'FROM', content: 't' },
            { kw: 'WHERE', content: 'x = 1' }
        ]
    );
});

test('splitTopLevelClauses matches the longest multi-word JOIN keyword', () => {
    assert.deepEqual(
        splitTopLevelClauses('SELECT a FROM t LEFT OUTER JOIN u ON t.id = u.id'),
        [
            { kw: 'SELECT', content: 'a' },
            { kw: 'FROM', content: 't' },
            { kw: 'LEFT OUTER JOIN', content: 'u ON t.id = u.id' }
        ]
    );
});

test('splitTopLevelClauses does not split on keywords inside parentheses', () => {
    assert.deepEqual(
        splitTopLevelClauses('SELECT a FROM (SELECT b FROM u) sub'),
        [
            { kw: 'SELECT', content: 'a' },
            { kw: 'FROM', content: '(SELECT b FROM u) sub' }
        ]
    );
});

test('splitTopLevelClauses does not split on keywords inside string literals', () => {
    assert.deepEqual(
        splitTopLevelClauses("SELECT 'FROM WHERE' AS lbl"),
        [{ kw: 'SELECT', content: "'FROM WHERE' AS lbl" }]
    );
});

test('splitTopLevelClauses places GROUP BY, ORDER BY and LIMIT on their own segments', () => {
    assert.deepEqual(
        splitTopLevelClauses('SELECT a FROM t GROUP BY a ORDER BY a LIMIT 10'),
        [
            { kw: 'SELECT', content: 'a' },
            { kw: 'FROM', content: 't' },
            { kw: 'GROUP BY', content: 'a' },
            { kw: 'ORDER BY', content: 'a' },
            { kw: 'LIMIT', content: '10' }
        ]
    );
});

// ===== buildRowIdentity =====

test('buildRowIdentity uses only the primary key columns when a PK exists', () => {
    const row = { id: 7, name: 'Alice', age: 30 };
    assert.deepEqual(buildRowIdentity(['id'], ['id', 'name', 'age'], row), { id: 7 });
});

test('buildRowIdentity supports composite primary keys', () => {
    const row = { a: 1, b: 2, c: 3 };
    assert.deepEqual(buildRowIdentity(['a', 'b'], ['a', 'b', 'c'], row), { a: 1, b: 2 });
});

test('buildRowIdentity falls back to all columns when there is no primary key', () => {
    const row = { ts: '2026-01-01', level: 'info', msg: 'hi' };
    assert.deepEqual(
        buildRowIdentity([], ['ts', 'level', 'msg'], row),
        { ts: '2026-01-01', level: 'info', msg: 'hi' }
    );
});

test('buildRowIdentity keeps null values in the full-row fallback', () => {
    const row = { a: 1, note: null };
    assert.deepEqual(buildRowIdentity([], ['a', 'note'], row), { a: 1, note: null });
});

test('buildRowIdentity treats a missing primaryKeys argument as no primary key', () => {
    const row = { a: 1, b: 2 };
    assert.deepEqual(buildRowIdentity(undefined, ['a', 'b'], row), { a: 1, b: 2 });
});

// ===== buildSelectColumnList =====

test('buildSelectColumnList lists every column name instead of a wildcard', () => {
    const columns = [{ name: 'id' }, { name: 'name' }, { name: 'age' }];
    assert.equal(buildSelectColumnList(columns), 'id, name, age');
});

test('buildSelectColumnList applies the identifier formatter to each column', () => {
    const columns = [{ name: 'id' }, { name: 'order' }];
    const fmt = (c: string) => `"${c}"`;
    assert.equal(buildSelectColumnList(columns, fmt), '"id", "order"');
});

test('buildSelectColumnList falls back to * when columns are not yet known', () => {
    assert.equal(buildSelectColumnList([]), '*');
    assert.equal(buildSelectColumnList(undefined), '*');
    assert.equal(buildSelectColumnList(null), '*');
});

test('buildSelectColumnList skips entries without a usable name', () => {
    const columns = [{ name: 'id' }, {}, { name: null }, { name: 'note' }];
    assert.equal(buildSelectColumnList(columns), 'id, note');
});

test('buildSelectColumnList falls back to * when no column has a usable name', () => {
    assert.equal(buildSelectColumnList([{}, { name: null }]), '*');
});

// ===== reorderColumns =====

function names(cols: Array<{ name: string }>): string[] {
    return cols.map((c) => c.name);
}

test('reorderColumns moves a column forward to the target position', () => {
    const cols = [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }];
    assert.deepEqual(names(reorderColumns(cols, 0, 2)), ['b', 'c', 'a', 'd']);
});

test('reorderColumns moves a column backward to the target position', () => {
    const cols = [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }];
    assert.deepEqual(names(reorderColumns(cols, 3, 1)), ['a', 'd', 'b', 'c']);
});

test('reorderColumns keeps the SELECT list order in sync after a move', () => {
    const cols = [{ name: 'id' }, { name: 'name' }, { name: 'age' }];
    const moved = reorderColumns(cols, 2, 0);
    assert.equal(buildSelectColumnList(moved), 'age, id, name');
});

test('reorderColumns does not mutate the input array', () => {
    const cols = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    reorderColumns(cols, 0, 2);
    assert.deepEqual(names(cols), ['a', 'b', 'c']);
});

test('reorderColumns returns an unchanged copy for a no-op move', () => {
    const cols = [{ name: 'a' }, { name: 'b' }];
    assert.deepEqual(names(reorderColumns(cols, 1, 1)), ['a', 'b']);
});

test('reorderColumns returns an unchanged copy for out-of-range indices', () => {
    const cols = [{ name: 'a' }, { name: 'b' }];
    assert.deepEqual(names(reorderColumns(cols, -1, 0)), ['a', 'b']);
    assert.deepEqual(names(reorderColumns(cols, 0, 5)), ['a', 'b']);
    assert.deepEqual(names(reorderColumns(cols, 0, 1.5 as any)), ['a', 'b']);
});

test('reorderColumns returns an empty array when columns is not an array', () => {
    assert.deepEqual(reorderColumns(undefined as any, 0, 1), []);
    assert.deepEqual(reorderColumns(null as any, 0, 1), []);
});

// ===== reorderSelectColumns =====

test('reorderSelectColumns moves a plain column expression', () => {
    assert.equal(
        reorderSelectColumns('SELECT a, b, c FROM t', 0, 2),
        'SELECT b, c, a FROM t'
    );
});

test('reorderSelectColumns preserves a manually assigned alias', () => {
    assert.equal(
        reorderSelectColumns('SELECT id, name AS full_name, age FROM users', 2, 0),
        'SELECT age, id, name AS full_name FROM users'
    );
});

test('reorderSelectColumns keeps a trailing WHERE/ORDER BY clause intact', () => {
    assert.equal(
        reorderSelectColumns('SELECT a, b FROM t WHERE a > 1 ORDER BY b', 1, 0),
        'SELECT b, a FROM t WHERE a > 1 ORDER BY b'
    );
});

test('reorderSelectColumns works after a column was manually deleted', () => {
    // Only two expressions remain; reordering by their indices still works.
    assert.equal(
        reorderSelectColumns('SELECT a, c FROM t', 1, 0),
        'SELECT c, a FROM t'
    );
});

test('reorderSelectColumns preserves a DISTINCT prefix', () => {
    assert.equal(
        reorderSelectColumns('SELECT DISTINCT a, b, c FROM t', 0, 2),
        'SELECT DISTINCT b, c, a FROM t'
    );
});

test('reorderSelectColumns ignores commas inside function calls', () => {
    assert.equal(
        reorderSelectColumns('SELECT coalesce(a, b) AS x, c FROM t', 1, 0),
        'SELECT c, coalesce(a, b) AS x FROM t'
    );
});

test('reorderSelectColumns reorders a multi-line formatted query', () => {
    const sql = 'SELECT\n    a,\n    b,\n    c\nFROM t';
    assert.equal(reorderSelectColumns(sql, 2, 0), 'SELECT c, a, b FROM t');
});

test('reorderSelectColumns returns null for a wildcard SELECT', () => {
    assert.equal(reorderSelectColumns('SELECT * FROM t', 0, 1), null);
    assert.equal(reorderSelectColumns('SELECT t.*, a FROM t', 0, 1), null);
});

test('reorderSelectColumns returns null for out-of-range indices', () => {
    assert.equal(reorderSelectColumns('SELECT a, b FROM t', 0, 5), null);
    assert.equal(reorderSelectColumns('SELECT a, b FROM t', -1, 0), null);
});

test('reorderSelectColumns returns null for a no-op or non-SELECT input', () => {
    assert.equal(reorderSelectColumns('SELECT a, b FROM t', 1, 1), null);
    assert.equal(reorderSelectColumns('UPDATE t SET a = 1', 0, 1), null);
    assert.equal(reorderSelectColumns('', 0, 1), null);
});

// ===== buildColumnHeaderTitle =====

test('buildColumnHeaderTitle returns the column comment as the tooltip text', () => {
    assert.equal(buildColumnHeaderTitle({ name: 'id', comment: 'Primary key' }), 'Primary key');
});

test('buildColumnHeaderTitle trims surrounding whitespace', () => {
    assert.equal(buildColumnHeaderTitle({ name: 'id', comment: '  hello  ' }), 'hello');
});

test('buildColumnHeaderTitle returns an empty string when there is no comment', () => {
    assert.equal(buildColumnHeaderTitle({ name: 'id', comment: null }), '');
    assert.equal(buildColumnHeaderTitle({ name: 'id', comment: undefined }), '');
    assert.equal(buildColumnHeaderTitle({ name: 'id' }), '');
    assert.equal(buildColumnHeaderTitle(null), '');
    assert.equal(buildColumnHeaderTitle(undefined), '');
});

test('buildColumnHeaderTitle preserves multi-line comments', () => {
    assert.equal(buildColumnHeaderTitle({ name: 'id', comment: 'line 1\nline 2' }), 'line 1\nline 2');
});

// ===== nextSortState =====

test('nextSortState sorts a freshly clicked column ascending', () => {
    const state = nextSortState({ column: null, direction: 'asc', previous: null }, 'name');
    assert.equal(state.column, 'name');
    assert.equal(state.direction, 'asc');
});

test('nextSortState flips the same column to descending on the second click', () => {
    const first = nextSortState(null, 'name');
    const second = nextSortState(first, 'name');
    assert.equal(second.column, 'name');
    assert.equal(second.direction, 'desc');
});

test('nextSortState drops the sort on the third click when nothing was sorted before', () => {
    let state = nextSortState(null, 'name');
    state = nextSortState(state, 'name');
    state = nextSortState(state, 'name');
    assert.equal(state.column, null);
});

test('nextSortState restores the sort that was active before the column was clicked', () => {
    let state = { column: 'created_at', direction: 'desc', previous: null };
    state = nextSortState(state, 'name');
    state = nextSortState(state, 'name');
    state = nextSortState(state, 'name');
    assert.equal(state.column, 'created_at');
    assert.equal(state.direction, 'desc');
});

test('nextSortState remembers the replaced sort across the whole cycle', () => {
    let state = nextSortState({ column: 'id', direction: 'asc', previous: null }, 'name');
    state = nextSortState(state, 'name');
    assert.deepEqual(state.previous, { column: 'id', direction: 'asc' });
});

test('nextSortState only remembers the sort it replaced, not the one before that', () => {
    let state = nextSortState({ column: 'id', direction: 'asc', previous: null }, 'name');
    state = nextSortState(state, 'email');
    state = nextSortState(state, 'email');
    state = nextSortState(state, 'email');
    assert.equal(state.column, 'name');
    assert.equal(state.direction, 'asc');
    assert.equal(state.previous, null);
});

test('nextSortState starts a new cycle when a different column is clicked mid-cycle', () => {
    let state = nextSortState(null, 'name');
    state = nextSortState(state, 'email');
    assert.equal(state.column, 'email');
    assert.equal(state.direction, 'asc');
});

test('nextSortState copes with a missing state', () => {
    const state = nextSortState(undefined, 'name');
    assert.equal(state.column, 'name');
    assert.equal(state.direction, 'asc');
});

// ===== computeResizedRowHeight =====
test('computeResizedRowHeight grows the row when dragging downward', () => {
    assert.equal(computeResizedRowHeight(20, 40, 20, 600), 60);
});

test('computeResizedRowHeight shrinks the row when dragging upward', () => {
    assert.equal(computeResizedRowHeight(100, -30, 20, 600), 70);
});

test('computeResizedRowHeight never shrinks below the minimum (single line)', () => {
    assert.equal(computeResizedRowHeight(20, -50, 20, 600), 20);
    assert.equal(computeResizedRowHeight(40, -100, 20, 600), 20);
});

test('computeResizedRowHeight never grows beyond the maximum', () => {
    assert.equal(computeResizedRowHeight(500, 400, 20, 600), 600);
});

test('computeResizedRowHeight ignores the maximum when it is null', () => {
    assert.equal(computeResizedRowHeight(100, 1000, 20, null), 1100);
});

test('computeResizedRowHeight treats non-numeric inputs as zero', () => {
    assert.equal(computeResizedRowHeight(NaN as any, 40, 20, 600), 40);
    assert.equal(computeResizedRowHeight(50, undefined as any, 20, 600), 50);
});

// ===== computeResizedColumnWidth =====

test('computeResizedColumnWidth widens the column when dragging right', () => {
    assert.equal(computeResizedColumnWidth(120, 60, 40, 1200), 180);
});

test('computeResizedColumnWidth narrows the column when dragging left', () => {
    assert.equal(computeResizedColumnWidth(200, -80, 40, 1200), 120);
});

test('computeResizedColumnWidth keeps the column grabbable at the minimum', () => {
    assert.equal(computeResizedColumnWidth(100, -500, 40, 1200), 40);
});

test('computeResizedColumnWidth never grows beyond the maximum', () => {
    assert.equal(computeResizedColumnWidth(1000, 900, 40, 1200), 1200);
});

test('computeResizedColumnWidth rounds to whole pixels', () => {
    assert.equal(computeResizedColumnWidth(100.4, 20.2, 40, 1200), 121);
});

test('computeResizedColumnWidth treats non-numeric inputs as zero', () => {
    assert.equal(computeResizedColumnWidth(NaN as any, 100, 40, 1200), 100);
    assert.equal(computeResizedColumnWidth(150, undefined as any, 40, 1200), 150);
});

// ===== cssStringLiteral =====

test('cssStringLiteral quotes a plain column name', () => {
    assert.equal(cssStringLiteral('first_name'), '"first_name"');
});

test('cssStringLiteral escapes quotes and backslashes so the selector stays intact', () => {
    assert.equal(cssStringLiteral('we"ird'), '"we\\"ird"');
    assert.equal(cssStringLiteral('back\\slash'), '"back\\\\slash"');
});

// ===== buildColumnWidthCss =====

test('buildColumnWidthCss returns nothing while no column has been resized', () => {
    assert.equal(buildColumnWidthCss({}), '');
    assert.equal(buildColumnWidthCss(undefined), '');
});

test('buildColumnWidthCss pins header and body cells to the same width', () => {
    const css = buildColumnWidthCss({ email: 260 });
    assert.match(css, /#dataTable th\[data-col="email"\], #dataTable td\[data-col="email"\]/);
    assert.match(css, /width: 260px; min-width: 260px; max-width: 260px;/);
});

test('buildColumnWidthCss lets the filter input shrink with its column', () => {
    const css = buildColumnWidthCss({ email: 60 });
    assert.match(css, /\.filter-input[^{]*\{[^}]*min-width: 0/);
});

test('buildColumnWidthCss skips columns without a usable width', () => {
    assert.equal(buildColumnWidthCss({ a: 0, b: null, c: 'nope' }), '');
});

test('buildColumnWidthCss emits one rule pair per resized column', () => {
    const css = buildColumnWidthCss({ a: 100, b: 200 });
    assert.equal(css.split('\n').length, 4);
});

// ===== remainingRowCount =====

test('remainingRowCount returns the number of rows still to load', () => {
    assert.equal(remainingRowCount(50, 200), 150);
    assert.equal(remainingRowCount(0, 200), 200);
});

test('remainingRowCount returns 0 when everything is loaded', () => {
    assert.equal(remainingRowCount(200, 200), 0);
});

test('remainingRowCount never returns a negative number', () => {
    assert.equal(remainingRowCount(250, 200), 0);
});

test('remainingRowCount coerces non-numeric input to zero', () => {
    assert.equal(remainingRowCount(undefined as any, 100), 100);
    assert.equal(remainingRowCount(10, undefined as any), 0);
});

// ===== formatExecutionTime =====

test('formatExecutionTime shows sub-second times as whole milliseconds', () => {
    assert.equal(formatExecutionTime(0), '0\u00A0ms');
    assert.equal(formatExecutionTime(12), '12\u00A0ms');
    assert.equal(formatExecutionTime(12.6), '13\u00A0ms');
    assert.equal(formatExecutionTime(999), '999\u00A0ms');
});

test('formatExecutionTime shows one second and longer as seconds with two decimals', () => {
    assert.equal(formatExecutionTime(1000), '1.00\u00A0s');
    assert.equal(formatExecutionTime(1234), '1.23\u00A0s');
    assert.equal(formatExecutionTime(60000), '60.00\u00A0s');
});

test('formatExecutionTime uses a non-breaking space between number and unit', () => {
    assert.ok(formatExecutionTime(12).includes('\u00A0'));
    assert.ok(!formatExecutionTime(12).includes(' '));
    assert.ok(formatExecutionTime(1500).includes('\u00A0'));
    assert.ok(!formatExecutionTime(1500).includes(' '));
});

test('formatExecutionTime returns an empty string for missing or invalid values', () => {
    assert.equal(formatExecutionTime(null as any), '');
    assert.equal(formatExecutionTime(undefined as any), '');
    assert.equal(formatExecutionTime(-5), '');
    assert.equal(formatExecutionTime('12' as any), '');
    assert.equal(formatExecutionTime(NaN), '');
    assert.equal(formatExecutionTime(Infinity), '');
});

// ===== 2.2.2: capabilities of the unified data viewer =====

/** Capabilities for a single-table result with a primary key. */
function usersCaps() {
    const idSource = { name: 'id', tableOid: 100, schema: 'public', table: 'users', sourceColumn: 'id' };
    const nameSource = { name: 'name', tableOid: 100, schema: 'public', table: 'users', sourceColumn: 'name' };
    return {
        canEdit: true, canInsert: true, canDelete: true, canConstrain: true, canMap: true,
        schema: 'public', table: 'users', identityStrategy: 'pk',
        tables: [{
            tableOid: 100, schema: 'public', table: 'users',
            identityStrategy: 'pk', identityColumns: [idSource], columns: [idSource, nameSource]
        }],
        columnSources: { id: idSource, name: nameSource },
        editableColumns: ['id', 'name'],
        warning: null
    };
}

test('emptyCapabilities describes a read-only result', () => {
    const caps = emptyCapabilities();
    assert.equal(caps.canEdit, false);
    assert.equal(caps.canInsert, false);
    assert.equal(caps.canDelete, false);
    assert.equal(caps.canConstrain, false);
    assert.equal(caps.canMap, false);
    assert.equal(caps.identityStrategy, 'none');
    assert.deepEqual(caps.tables, []);
});

test('normalizeCapabilities falls back to the read-only defaults', () => {
    assert.deepEqual(normalizeCapabilities(undefined), emptyCapabilities());
    assert.deepEqual(normalizeCapabilities(null), emptyCapabilities());
    assert.deepEqual(normalizeCapabilities('nonsense'), emptyCapabilities());
});

test('normalizeCapabilities repairs a partial payload', () => {
    const caps = normalizeCapabilities({ canEdit: 1, table: 'users', editableColumns: 'oops' });
    assert.equal(caps.canEdit, true);
    assert.equal(caps.canInsert, false);
    assert.equal(caps.table, 'users');
    assert.equal(caps.schema, null);
    assert.deepEqual(caps.editableColumns, []);
    assert.deepEqual(caps.tables, []);
});

test('buildCommitTargets identifies updated rows by the primary key', () => {
    const rows = [{ id: 7, name: 'Alice' }];
    const targets = buildCommitTargets(usersCaps(), rows, { updates: [[0, { name: 'Bob' }]] });

    assert.equal(targets.length, 1);
    assert.equal(targets[0].schema, 'public');
    assert.equal(targets[0].table, 'users');
    assert.equal(targets[0].identityStrategy, 'pk');
    assert.deepEqual(targets[0].changes.updates, [{ primaryKey: { id: 7 }, changes: { name: 'Bob' } }]);
});

test('buildCommitTargets translates aliases back to the real column names', () => {
    const caps = usersCaps() as any;
    const key = { name: 'key', tableOid: 100, schema: 'public', table: 'users', sourceColumn: 'id' };
    caps.columnSources = {
        key,
        label: { name: 'label', tableOid: 100, schema: 'public', table: 'users', sourceColumn: 'name' }
    };
    caps.tables[0].identityColumns = [key];
    const targets = buildCommitTargets(caps, [{ key: 7, label: 'Alice' }], { updates: [[0, { label: 'Bob' }]] });

    assert.deepEqual(targets[0].changes.updates, [{ primaryKey: { id: 7 }, changes: { name: 'Bob' } }]);
});

test('buildCommitTargets splits a joined result into one target per table', () => {
    const userId = { name: 'user_id', tableOid: 100, schema: 'public', table: 'users', sourceColumn: 'id' };
    const userName = { name: 'user_name', tableOid: 100, schema: 'public', table: 'users', sourceColumn: 'name' };
    const orderId = { name: 'order_id', tableOid: 200, schema: 'public', table: 'orders', sourceColumn: 'id' };
    const orderQty = { name: 'qty', tableOid: 200, schema: 'public', table: 'orders', sourceColumn: 'qty' };
    const caps = {
        canEdit: true, canInsert: false, canDelete: false, canConstrain: false, canMap: false,
        schema: null, table: null, identityStrategy: 'pk',
        tables: [
            { tableOid: 100, schema: 'public', table: 'users', identityStrategy: 'pk', identityColumns: [userId], columns: [userId, userName] },
            { tableOid: 200, schema: 'public', table: 'orders', identityStrategy: 'pk', identityColumns: [orderId], columns: [orderId, orderQty] }
        ],
        columnSources: { user_id: userId, user_name: userName, order_id: orderId, qty: orderQty },
        editableColumns: ['user_id', 'user_name', 'order_id', 'qty'],
        warning: null
    };
    const rows = [{ user_id: 1, user_name: 'Alice', order_id: 9, qty: 2 }];

    const targets = buildCommitTargets(caps, rows, { updates: [[0, { user_name: 'Bob', qty: 5 }]] });

    assert.deepEqual(targets.map((t: any) => t.table), ['users', 'orders']);
    assert.deepEqual(targets[0].changes.updates, [{ primaryKey: { id: 1 }, changes: { name: 'Bob' } }]);
    assert.deepEqual(targets[1].changes.updates, [{ primaryKey: { id: 9 }, changes: { qty: 5 } }]);
});

test('buildCommitTargets skips columns without a source table', () => {
    const caps = usersCaps();
    const targets = buildCommitTargets(caps, [{ id: 7, name: 'Alice' }], { updates: [[0, { computed: 3 }]] });
    assert.deepEqual(targets, []);
});

test('buildCommitTargets identifies rows by all displayed columns without a primary key', () => {
    const ts = { name: 'ts', tableOid: 300, schema: 'app', table: 'log', sourceColumn: 'ts' };
    const msg = { name: 'msg', tableOid: 300, schema: 'app', table: 'log', sourceColumn: 'msg' };
    const caps = {
        canEdit: true, canInsert: true, canDelete: true, canConstrain: true, canMap: true,
        schema: 'app', table: 'log', identityStrategy: 'row',
        tables: [{ tableOid: 300, schema: 'app', table: 'log', identityStrategy: 'row', identityColumns: [ts, msg], columns: [ts, msg] }],
        columnSources: { ts, msg },
        editableColumns: ['ts', 'msg'],
        warning: 'no pk'
    };

    const targets = buildCommitTargets(caps, [{ ts: '2026-01-01', msg: 'hi' }], { updates: [[0, { msg: 'ho' }]] });

    assert.equal(targets[0].identityStrategy, 'row');
    assert.deepEqual(targets[0].changes.updates, [
        { primaryKey: { ts: '2026-01-01', msg: 'hi' }, changes: { msg: 'ho' } }
    ]);
});

test('buildCommitTargets collects deletes and inserts for a single source table', () => {
    const rows = [{ id: 7, name: 'Alice' }, { id: 8, name: 'Bob' }];
    const targets = buildCommitTargets(usersCaps(), rows, {
        deletes: [1],
        inserts: [{ id: 9, name: 'Carol' }]
    });

    assert.deepEqual(targets[0].changes.deletes, [{ id: 8 }]);
    assert.deepEqual(targets[0].changes.inserts, [{ id: 9, name: 'Carol' }]);
});

test('buildCommitTargets drops empty insert fields and fully empty inserts', () => {
    const targets = buildCommitTargets(usersCaps(), [], {
        inserts: [{ id: 9, name: '' }, { id: '', name: null }]
    });

    assert.deepEqual(targets[0].changes.inserts, [{ id: 9 }]);
});

test('buildCommitTargets refuses inserts and deletes for a multi-table result', () => {
    const userId = { name: 'user_id', tableOid: 100, schema: 'public', table: 'users', sourceColumn: 'id' };
    const orderId = { name: 'order_id', tableOid: 200, schema: 'public', table: 'orders', sourceColumn: 'id' };
    const caps = {
        canEdit: true, canInsert: false, canDelete: false, canConstrain: false, canMap: false,
        schema: null, table: null, identityStrategy: 'pk',
        tables: [
            { tableOid: 100, schema: 'public', table: 'users', identityStrategy: 'pk', identityColumns: [userId], columns: [userId] },
            { tableOid: 200, schema: 'public', table: 'orders', identityStrategy: 'pk', identityColumns: [orderId], columns: [orderId] }
        ],
        columnSources: { user_id: userId, order_id: orderId },
        editableColumns: ['user_id', 'order_id'],
        warning: null
    };

    const targets = buildCommitTargets(caps, [{ user_id: 1, order_id: 9 }], {
        deletes: [0],
        inserts: [{ user_id: 2 }]
    });

    assert.deepEqual(targets, []);
});

test('buildCommitTargets ignores changes to a table that cannot identify its rows', () => {
    const caps = usersCaps();
    caps.tables[0].identityStrategy = 'none';
    caps.tables[0].identityColumns = [];

    assert.deepEqual(buildCommitTargets(caps, [{ id: 7 }], { updates: [[0, { name: 'Bob' }]] }), []);
});

test('buildCommitTargets returns nothing when there is no pending edit', () => {
    assert.deepEqual(buildCommitTargets(usersCaps(), [{ id: 1 }], {}), []);
});

// ===== 2.2.2: row-count indicator =====

test('describeRowCount shows the exact total once it is known', () => {
    assert.equal(describeRowCount(50, 200, true), 'Showing 50 of 200 rows');
    assert.equal(describeRowCount(0, 0, false), 'Showing 0 of 0 rows');
});

test('describeRowCount reports the loaded rows while the total is unknown', () => {
    assert.equal(describeRowCount(50, null, false), '50 rows loaded');
    assert.equal(describeRowCount(50, null, true), '50 rows loaded (more available)');
    assert.equal(describeRowCount(50, undefined, false), '50 rows loaded');
});

// ===== 2.2.2: column header colour =====

test('columnWriteMode reports "editable" for a column identified by a primary key', () => {
    assert.equal(columnWriteMode(usersCaps(), 'name'), 'editable');
});

test('columnWriteMode reports "unsafe" when the source table has no primary key', () => {
    const caps = usersCaps() as any;
    caps.tables[0].identityStrategy = 'row';
    assert.equal(columnWriteMode(caps, 'name'), 'unsafe');
});

test('columnWriteMode reports "unsafe" for a column of a read-only relation', () => {
    const caps = usersCaps() as any;
    caps.tables[0].identityStrategy = 'none';
    assert.equal(columnWriteMode(caps, 'name'), 'unsafe');
});

test('columnWriteMode reports "readonly" for a column without a source table', () => {
    assert.equal(columnWriteMode(usersCaps(), 'computed'), 'readonly');
    assert.equal(columnWriteMode(undefined, 'anything'), 'readonly');
});

test('columnWriteMode judges every table of a joined result separately', () => {
    const userId = { name: 'user_id', tableOid: 100, schema: 'public', table: 'users', sourceColumn: 'id' };
    const logMsg = { name: 'msg', tableOid: 300, schema: 'app', table: 'log', sourceColumn: 'msg' };
    const caps = {
        canEdit: true, canInsert: false, canDelete: false, canConstrain: false, canMap: false,
        schema: null, table: null, identityStrategy: 'row',
        tables: [
            { tableOid: 100, schema: 'public', table: 'users', identityStrategy: 'pk', identityColumns: [userId], columns: [userId] },
            { tableOid: 300, schema: 'app', table: 'log', identityStrategy: 'row', identityColumns: [logMsg], columns: [logMsg] }
        ],
        columnSources: { user_id: userId, msg: logMsg },
        editableColumns: ['user_id', 'msg'],
        warning: 'no pk for app.log'
    };

    assert.equal(columnWriteMode(caps, 'user_id'), 'editable');
    assert.equal(columnWriteMode(caps, 'msg'), 'unsafe');
});

// ===== 2.2.2: commit preview =====

test('buildCommitWarnings is empty when everything is unambiguous', () => {
    assert.deepEqual(buildCommitWarnings(null, 'prod', 'prod'), []);
    assert.deepEqual(buildCommitWarnings('', '', ''), []);
});

test('buildCommitWarnings reports how rows are identified', () => {
    assert.deepEqual(buildCommitWarnings('No primary key available', 'prod', 'prod'), ['No primary key available']);
});

test('buildCommitWarnings reports a connection that changed since the data was loaded', () => {
    const warnings = buildCommitWarnings(null, 'prod', 'staging');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /prod.*staging|staging.*prod/);
});

test('buildCommitWarnings lists both reasons together', () => {
    assert.equal(buildCommitWarnings('No primary key available', 'prod', 'staging').length, 2);
});

test('buildCommitWarnings stays silent when one of the connections is unknown', () => {
    assert.deepEqual(buildCommitWarnings(null, 'prod', ''), []);
    assert.deepEqual(buildCommitWarnings(null, '', 'staging'), []);
});

test('isSqlEdited detects a changed statement', () => {
    assert.equal(isSqlEdited('DELETE FROM t WHERE id = 1;', 'DELETE FROM t WHERE id = 2;'), true);
    assert.equal(isSqlEdited('DELETE FROM t WHERE id = 1;', 'DELETE FROM t WHERE id = 1;\nSELECT 1;'), true);
});

test('isSqlEdited ignores pure whitespace and indentation changes', () => {
    assert.equal(isSqlEdited('UPDATE t SET a = 1;', '  UPDATE t\n    SET a = 1;  '), false);
    assert.equal(isSqlEdited('UPDATE t SET a = 1;', 'UPDATE t SET a = 1;'), false);
});

test('isSqlEdited keeps whitespace inside string literals significant', () => {
    assert.equal(isSqlEdited("UPDATE t SET a = 'x  y';", "UPDATE t SET a = 'x y';"), true);
});

// ===== 2.2.2: checking an entered value against its column type =====

test('parsePgType splits length, precision and scale off a type name', () => {
    assert.deepEqual(parsePgType('character varying(5)'), { base: 'character varying', isArray: false, length: 5 });
    assert.deepEqual(parsePgType('numeric(10,2)'), { base: 'numeric', isArray: false, precision: 10, scale: 2 });
    assert.deepEqual(parsePgType('numeric(10)'), { base: 'numeric', isArray: false, precision: 10, scale: 0 });
    assert.deepEqual(parsePgType('timestamp without time zone'), { base: 'timestamp without time zone', isArray: false });
    assert.deepEqual(parsePgType('text[]'), { base: 'text', isArray: true });
    assert.deepEqual(parsePgType(''), { base: '', isArray: false });
});

test('validateCellValue accepts an empty cell as NULL for every type', () => {
    assert.equal(validateCellValue('', 'integer').state, 'valid');
    assert.equal(validateCellValue(null, 'timestamp without time zone').state, 'valid');
});

test('validateCellValue rejects text in an integer column', () => {
    const result = validateCellValue('abc', 'integer');
    assert.equal(result.state, 'invalid');
    assert.match(result.reason, /whole number/);
    assert.equal(validateCellValue('1.5', 'integer').state, 'invalid');
    assert.equal(validateCellValue('-42', 'integer').state, 'valid');
});

test('validateCellValue enforces the range of each integer type', () => {
    assert.equal(validateCellValue('32767', 'smallint').state, 'valid');
    const tooBig = validateCellValue('40000', 'smallint');
    assert.equal(tooBig.state, 'invalid');
    assert.match(tooBig.reason, /out of range for smallint/);
    assert.equal(validateCellValue('-32769', 'smallint').state, 'invalid');
    assert.equal(validateCellValue('40000', 'integer').state, 'valid');
    assert.equal(validateCellValue('9223372036854775807', 'bigint').state, 'valid');
    assert.equal(validateCellValue('9223372036854775808', 'bigint').state, 'invalid');
});

test('validateCellValue checks the digits before the decimal point of a numeric', () => {
    assert.equal(validateCellValue('12345678.99', 'numeric(10,2)').state, 'valid');
    const overflow = validateCellValue('123456789.99', 'numeric(10,2)');
    assert.equal(overflow.state, 'invalid');
    assert.match(overflow.reason, /at most 8 digit/);
    assert.equal(validateCellValue('0.99', 'numeric(10,2)').state, 'valid');
    assert.equal(validateCellValue('abc', 'numeric').state, 'invalid');
    assert.equal(validateCellValue('NaN', 'numeric').state, 'valid');
});

test('validateCellValue rejects text that is too long for a varchar column', () => {
    assert.equal(validateCellValue('12345', 'character varying(5)').state, 'valid');
    const tooLong = validateCellValue('123456', 'character varying(5)');
    assert.equal(tooLong.state, 'invalid');
    assert.match(tooLong.reason, /Too long/);
    assert.equal(validateCellValue('any length at all', 'text').state, 'valid');
});

test('validateCellValue counts characters, not bytes, for a varchar column', () => {
    assert.equal(validateCellValue('äöüß€', 'character varying(5)').state, 'valid');
});

test('validateCellValue checks booleans and uuids locally', () => {
    assert.equal(validateCellValue('t', 'boolean').state, 'valid');
    assert.equal(validateCellValue('maybe', 'boolean').state, 'invalid');
    assert.equal(validateCellValue('123e4567-e89b-12d3-a456-426614174000', 'uuid').state, 'valid');
    assert.equal(validateCellValue('not-a-uuid', 'uuid').state, 'invalid');
});

test('validateCellValue leaves types only Postgres can judge to the database', () => {
    for (const type of ['timestamp without time zone', 'date', 'interval', 'jsonb', 'my_enum', 'text[]', 'inet']) {
        assert.equal(validateCellValue('whatever', type).state, 'unknown', type);
    }
});

test('validateCellValue asks the database when the column type is unknown', () => {
    assert.equal(validateCellValue('x', '').state, 'unknown');
});

// ===== 2.2.2: pending-changes indicator =====

test('describePendingChanges reports nothing to do for an unchanged grid', () => {
    assert.deepEqual(describePendingChanges({}, 0), {
        text: 'No pending changes', canCommit: false, canDiscard: false
    });
});

test('describePendingChanges lists every kind of pending change', () => {
    const state = describePendingChanges({ modified: 2, inserted: 1, duplicated: 3, deleted: 4 }, 0);
    assert.equal(state.text, 'Pending: 2 modified, 1 inserted, 3 duplicated, 4 deleted');
    assert.equal(state.canCommit, true);
});

test('describePendingChanges blocks saving while a value is invalid', () => {
    const state = describePendingChanges({ modified: 3 }, 1);
    assert.match(state.text, /1 invalid value$/);
    assert.equal(state.canCommit, false);
    assert.equal(state.canDiscard, true);
    assert.match(describePendingChanges({ modified: 3 }, 2).text, /2 invalid values$/);
});

