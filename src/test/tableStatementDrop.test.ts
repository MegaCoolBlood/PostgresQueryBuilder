import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStatement, deriveQualifier } from '../statementBuilder';

const opts = (qualifier = 'lei') => ({
    tableReference: 'leistungen',
    columns: ['lei_id', 'name', 'amount'],
    columnTypes: ['integer', 'text', 'numeric'],
    qualifier
});

test('deriveQualifier uses part before first underscore', () => {
    assert.equal(deriveQualifier('lei_id', 'leistungen'), 'lei');
    assert.equal(deriveQualifier('cust_order_id', 'orders'), 'cust');
});

test('deriveQualifier falls back to table name without underscore', () => {
    assert.equal(deriveQualifier('id', 'users'), 'users');
    assert.equal(deriveQualifier(null, 'users'), 'users');
    assert.equal(deriveQualifier('', 'users'), 'users');
});

test('buildStatement name returns only the table reference', () => {
    assert.equal(buildStatement('name', opts()), 'leistungen');
});

test('buildStatement select qualifies all columns', () => {
    assert.equal(
        buildStatement('select', opts()),
        'SELECT\n  lei.lei_id,\n  lei.name,\n  lei.amount\nFROM leistungen lei;'
    );
});

test('buildStatement select falls back to star with no columns', () => {
    assert.equal(
        buildStatement('select', { tableReference: 'leistungen', columns: [], qualifier: 'lei' }),
        'SELECT\n  lei.*\nFROM leistungen lei;'
    );
});

test('buildStatement insert lists all columns', () => {
    const sql = buildStatement('insert', opts());
    assert.ok(sql.startsWith('INSERT INTO leistungen ('));
    assert.ok(sql.includes('    lei_id,'));
    assert.ok(sql.includes('    amount'));
    assert.ok(sql.includes('VALUES ('));
    assert.ok(sql.includes('NULL::integer, -- lei_id'));
    assert.ok(sql.includes('NULL::text, -- name'));
    assert.ok(sql.includes('NULL::numeric -- amount'));
});

test('buildStatement update qualifies table and casts all columns', () => {
    assert.equal(
        buildStatement('update', opts()),
        'UPDATE leistungen lei\nSET\n  lei_id = NULL::integer,\n  name = NULL::text,\n  amount = NULL::numeric\nWHERE ;'
    );
});

test('buildStatement delete lists all columns in where clause', () => {
    assert.equal(
        buildStatement('delete', opts()),
        'DELETE FROM leistungen lei\nWHERE lei.lei_id = \n  AND lei.name = \n  AND lei.amount = ;'
    );
});

test('buildStatement join uses first column', () => {
    assert.equal(buildStatement('join', opts()), 'JOIN leistungen lei ON lei.lei_id = ');
});

test('buildStatement respects a custom qualifier', () => {
    assert.equal(
        buildStatement('select', opts('x')),
        'SELECT\n  x.lei_id,\n  x.name,\n  x.amount\nFROM leistungen x;'
    );
});
