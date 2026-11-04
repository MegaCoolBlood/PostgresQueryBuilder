import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const view = require(path.join(__dirname, '../../../src/webview/tableView.js'));
const {
    CELL_DEFAULT,
    isCellDefault,
    updateDefaultAllowed,
    buildCommitTargets,
    cloneEditValue,
    editStatesEqual,
    fillPreviewText,
    continueSeries
} = view;

const JS = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'webview', 'tableView.js'), 'utf8');

/** leda.bos_mitarbeiter, opened from the tree: one table with a primary key. */
function employeeCaps() {
    const id = { name: 'mit_id', tableOid: 300, schema: 'leda', table: 'bos_mitarbeiter', sourceColumn: 'mit_id' };
    const type = { name: 'mit_type', tableOid: 300, schema: 'leda', table: 'bos_mitarbeiter', sourceColumn: 'mit_type' };
    const deleted = { name: 'geloescht', tableOid: 300, schema: 'leda', table: 'bos_mitarbeiter', sourceColumn: 'mit_geloescht' };
    return {
        canEdit: true, canInsert: true, canDelete: true, canConstrain: true, canMap: true,
        schema: 'leda', table: 'bos_mitarbeiter', identityStrategy: 'pk',
        tables: [{ tableOid: 300, schema: 'leda', table: 'bos_mitarbeiter', identityStrategy: 'pk', identityColumns: [id], columns: [id, type, deleted] }],
        columnSources: { mit_id: id, mit_type: type, geloescht: deleted },
        editableColumns: ['mit_id', 'mit_type', 'geloescht'],
        warning: null
    };
}

// ===== the marker of a cell set back to its default =====

test('the default marker is one shared object that no typed text can be taken for', () => {
    assert.equal(isCellDefault(CELL_DEFAULT), true);
    assert.equal(isCellDefault('DEFAULT'), false);
    assert.equal(isCellDefault({ cellDefault: true }), false, 'only the one object counts, not a look-alike');
    assert.equal(isCellDefault(null), false);
    assert.equal(Object.isFrozen(CELL_DEFAULT), true);
    assert.equal(String(CELL_DEFAULT), 'DEFAULT');
});

test('undo keeps a cell set back to its default, and tells it from the text DEFAULT', () => {
    const edits = new Map<string, unknown>([['0:mit_geloescht', CELL_DEFAULT], ['1:mit_type', 'EXT']]);
    const copy = cloneEditValue(edits);
    assert.equal(copy.get('0:mit_geloescht'), CELL_DEFAULT, 'the copy holds the same marker');
    assert.equal(editStatesEqual({ modified: edits }, { modified: copy }), true);
    assert.equal(
        editStatesEqual({ modified: new Map([['0:c', CELL_DEFAULT]]) }, { modified: new Map([['0:c', 'DEFAULT']]) }),
        false
    );
});

test('a fill preview shows DEFAULT, and a series with the marker repeats it', () => {
    assert.equal(fillPreviewText(CELL_DEFAULT, false, ' '), 'DEFAULT');
    assert.equal(fillPreviewText(CELL_DEFAULT, true, ' '), 'DEFAULT');
    assert.deepEqual(continueSeries([CELL_DEFAULT, CELL_DEFAULT], 'number', 3), [CELL_DEFAULT, CELL_DEFAULT, CELL_DEFAULT]);
});

// ===== which defaults an existing row may go back to =====

test('only a default the table defines can be taken back to; no identity and no generated column', () => {
    assert.equal(updateDefaultAllowed({ column: 'mit_geloescht', defaultExpression: "'N'::character varying", isIdentity: false, isGenerated: false }), true);
    assert.equal(updateDefaultAllowed({ column: 'changed_at', defaultExpression: 'now()', isIdentity: false, isGenerated: false }), true);
    assert.equal(updateDefaultAllowed({ column: 'id', defaultExpression: null, isIdentity: true, isGenerated: false }), false);
    assert.equal(updateDefaultAllowed({ column: 'total', defaultExpression: 'a + b', isIdentity: false, isGenerated: true }), false);
    assert.equal(updateDefaultAllowed({ column: 'x', defaultExpression: null, isIdentity: false, isGenerated: false }), false);
    assert.equal(updateDefaultAllowed(undefined), false);
});

// ===== saving =====

test('a cell set back to its default is saved as a DEFAULT column of its update, by its table name', () => {
    const rows = [{ mit_id: 7, mit_type: 'INT', geloescht: 'J' }];
    const targets = buildCommitTargets(employeeCaps(), rows, { updates: [[0, { geloescht: CELL_DEFAULT, mit_type: 'EXT' }]] });
    assert.deepEqual(targets[0].changes.updates, [
        { primaryKey: { mit_id: 7 }, changes: { mit_type: 'EXT' }, defaults: ['mit_geloescht'] }
    ]);
    assert.doesNotThrow(() => JSON.stringify(targets), 'what goes to the extension is plain data');
});

test('an update without a default keeps its old shape', () => {
    const targets = buildCommitTargets(employeeCaps(), [{ mit_id: 7 }], { updates: [[0, { mit_type: 'EXT' }]] });
    assert.deepEqual(targets[0].changes.updates, [{ primaryKey: { mit_id: 7 }, changes: { mit_type: 'EXT' } }]);
});

test('a row the join found no partner for leaves a column at its default by leaving it out', () => {
    const userId = { name: 'user_id', tableOid: 100, schema: 'public', table: 'users', sourceColumn: 'id' };
    const attrKey = { name: '__pqb_key_0', tableOid: 200, schema: 'public', table: 'attributes', sourceColumn: 'id' };
    const attrValue = { name: 'wert', tableOid: 200, schema: 'public', table: 'attributes', sourceColumn: 'value' };
    const attrFlag = { name: 'flag', tableOid: 200, schema: 'public', table: 'attributes', sourceColumn: 'flag' };
    const caps = {
        canEdit: true, canInsert: false, canDelete: false, canConstrain: false, canMap: false,
        schema: null, table: null, identityStrategy: 'pk',
        tables: [
            { tableOid: 100, schema: 'public', table: 'users', identityStrategy: 'pk', identityColumns: [userId], columns: [userId] },
            { tableOid: 200, schema: 'public', table: 'attributes', identityStrategy: 'pk', identityColumns: [attrKey], columns: [attrValue, attrFlag] }
        ],
        columnSources: { user_id: userId, wert: attrValue, flag: attrFlag },
        editableColumns: ['wert', 'flag'],
        warning: null
    };
    const rows = [{ user_id: 1, wert: null, flag: null, __pqb_key_0: null }];
    const targets = buildCommitTargets(caps, rows, { updates: [[0, { wert: 'neu', flag: CELL_DEFAULT }]] });
    assert.deepEqual(targets[0].changes.inserts, [{ value: 'neu' }]);
});

// ===== the grid =====

test('the cell menu offers Reset to Default for a cell or every cell of a selection', () => {
    assert.match(JS, /label: resettable\.length === 1 \? 'Reset to Default' : `Reset \$\{resettable\.length\} Cells to Default`/);
    assert.match(JS, /function canResetCellToDefault\(rowIdx, colName\) \{[\s\S]*?deletedRows\.has\(rowIdx\)[\s\S]*?isColumnEditable\(colName\)[\s\S]*?updateDefaultInfo\(colName\)/);
    assert.match(JS, /modifiedCells\.set\(modKey, CELL_DEFAULT\)/);
});

test('a cell set back to its default shows DEFAULT and stays there when it is left without typing', () => {
    assert.match(JS, /const displayVal = atDefault \? defaultMarkerHtml\(cc\.name\)/);
    assert.match(JS, /span\.querySelector\('\.default-value'\)\) \{\s*span\.textContent = '';\s*span\.setAttribute\('data-was-default', 'true'\);/);
    assert.match(JS, /if \(wasDefault && span\.textContent === ''\) \{\s*span\.innerHTML = defaultMarkerHtml\(colName\);\s*return;/);
});

test('the Single Record View shows a field at its default and offers to set one back', () => {
    assert.match(JS, /placeholder="' \+ \(atDefault \? 'DEFAULT' : 'NULL'\)/);
    assert.match(JS, /<button class="btn btn-sm record-default-btn" title="/);
    assert.match(JS, /resetCellsToDefault\(\[\{ rowIdx: idx, colName \}\]\)/);
});

test('the default of an existing row is looked up through the table column behind the result column', () => {
    const fn = JS.slice(JS.indexOf('function updateDefaultInfo(colName)'), JS.indexOf('function canResetCellToDefault'));
    assert.match(fn, /caps\.columnSources\[colName\]/);
    assert.match(fn, /plan\.schema !== caps\.schema \|\| plan\.table !== caps\.table/);
    assert.match(fn, /d\.column === source\.sourceColumn/);
    assert.match(fn, /updateDefaultAllowed\(info\)/);
});
