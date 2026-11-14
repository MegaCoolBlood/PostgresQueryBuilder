import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTypeName, scanSqlText } from '../repositoryScanner';

function summary(sql: string): Array<string> {
    return scanSqlText(sql).map(d => {
        const schema = d.schema === null ? '' : `${d.schema}.`;
        const args = d.argTypes ? `(${d.argTypes.join(', ')})` : '';
        const table = d.table ? ` on ${d.table.schema ?? ''}${d.table.schema ? '.' : ''}${d.table.name}` : '';
        return `${d.kind} ${schema}${d.name}${args}${table}`;
    });
}

// ===== scanSqlText: what counts as a definition =====

test('scanSqlText finds the CREATE statements of every navigable kind', () => {
    const sql = `
        CREATE SCHEMA billing;
        CREATE TABLE billing.invoice (id int);
        CREATE VIEW billing.open_invoice AS SELECT 1;
        CREATE MATERIALIZED VIEW billing.totals AS SELECT 1;
        CREATE FOREIGN TABLE billing.remote (id int) SERVER s;
        CREATE SEQUENCE billing.invoice_no;
        CREATE TYPE billing.state AS ENUM ('open', 'paid');
        CREATE DOMAIN billing.amount AS numeric(12,2);
        CREATE FUNCTION billing.total(p_id int) RETURNS numeric LANGUAGE sql AS 'select 1';
        CREATE PROCEDURE billing.close_all() LANGUAGE sql AS 'select 1';
        CREATE AGGREGATE billing.sum_amount(numeric) (SFUNC = numeric_add, STYPE = numeric);
        CREATE TRIGGER invoice_audit AFTER INSERT ON billing.invoice FOR EACH ROW EXECUTE FUNCTION billing.audit();
        CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`;
    assert.deepEqual(summary(sql), [
        'schema billing',
        'table billing.invoice',
        'view billing.open_invoice',
        'matview billing.totals',
        'foreign billing.remote',
        'sequence billing.invoice_no',
        'type billing.state',
        'domain billing.amount',
        'function billing.total(integer)',
        'procedure billing.close_all()',
        'aggregate billing.sum_amount(numeric)',
        'trigger invoice_audit on billing.invoice',
        'extension uuid-ossp'
    ]);
});

test('scanSqlText ignores CREATE inside comments, strings and dollar-quoted bodies', () => {
    const sql = `
        -- CREATE TABLE commented_out (id int);
        /* CREATE TABLE in_block (id int); /* nested CREATE VIEW v AS SELECT 1; */ still comment */
        CREATE FUNCTION public.make_tables() RETURNS void LANGUAGE plpgsql AS $body$
        BEGIN
            CREATE TABLE inside_body (id int);
            EXECUTE 'CREATE TABLE inside_string (id int)';
        END;
        $body$;
        SELECT 'CREATE TABLE in_literal (id int); still a string';
        SELECT E'it\\'s CREATE TABLE escaped (id int)';
        CREATE TABLE public.real_one (id int);`;
    assert.deepEqual(summary(sql), ['function public.make_tables()', 'table public.real_one']);
});

test('scanSqlText reads the CREATE statements a DO block runs, but not those in its strings', () => {
    const sql = `
        DO $$
        BEGIN
            ALTER TYPE app.mood RENAME TO mood_old;
            CREATE TYPE app.mood AS (a int);
            IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'seq') THEN CREATE SEQUENCE app.seq; END IF;
            CREATE TEMP TABLE scratch (id int);
            EXECUTE 'CREATE TABLE app.dynamic (id int)';
        EXCEPTION WHEN duplicate_object THEN NULL;
        END
        $$;
        CREATE TABLE app.after (id int);`;
    assert.deepEqual(summary(sql), ['type app.mood', 'sequence app.seq', 'table app.after']);
    const type = scanSqlText(sql)[0];
    assert.deepEqual(type.start, { line: 4, character: 24 }, 'positions point into the file, not into the body');
});

test('scanSqlText skips psql meta-commands', () => {
    assert.deepEqual(summary('\\set ON_ERROR_STOP on\n\\i other.sql\nCREATE TABLE t (id int);'), ['table t']);
});

test('scanSqlText leaves out temporary objects and kinds the navigator does not show', () => {
    const sql = `
        CREATE TEMP TABLE scratch (id int);
        CREATE GLOBAL TEMPORARY TABLE scratch2 (id int);
        CREATE INDEX ix ON t (id);
        CREATE UNIQUE INDEX ux ON t (id);
        CREATE ROLE reader;
        CREATE EVENT TRIGGER et ON ddl_command_start EXECUTE FUNCTION f();
        CREATE FOREIGN DATA WRAPPER fdw;
        CREATE OR REPLACE TRUSTED PROCEDURAL LANGUAGE plsample;`;
    assert.deepEqual(summary(sql), []);
});

test('scanSqlText reads OR REPLACE, IF NOT EXISTS and the modifiers in front of the kind', () => {
    const sql = `
        CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql AS 'select 1';
        CREATE TABLE IF NOT EXISTS a.t (id int);
        CREATE UNLOGGED TABLE a.u (id int);
        CREATE OR REPLACE RECURSIVE VIEW a.r (n) AS SELECT 1;
        CREATE OR REPLACE CONSTRAINT TRIGGER ct AFTER INSERT ON a.t FOR EACH ROW EXECUTE FUNCTION f();
        CREATE SCHEMA IF NOT EXISTS s2;
        CREATE SCHEMA AUTHORIZATION joe;`;
    assert.deepEqual(summary(sql), [
        'function f()', 'table a.t', 'table a.u', 'view a.r', 'trigger ct on a.t', 'schema s2', 'schema joe'
    ]);
});

test('scanSqlText folds unquoted names to lower case and keeps quoted names as written', () => {
    const defs = scanSqlText('CREATE TABLE Sales."OrderLine" (id int); CREATE TABLE "My Schema".Items (id int);');
    assert.deepEqual(defs.map(d => [d.schema, d.name]), [['sales', 'OrderLine'], ['My Schema', 'items']]);
});

test('scanSqlText assigns the elements of CREATE SCHEMA … CREATE TABLE … to that schema', () => {
    const sql = 'CREATE SCHEMA hr AUTHORIZATION joe CREATE TABLE staff (id int) CREATE VIEW staff_v AS SELECT id FROM staff;';
    assert.deepEqual(summary(sql), ['schema hr', 'table hr.staff', 'view hr.staff_v']);
});

test('scanSqlText reports the 0-based range of the qualified name', () => {
    const defs = scanSqlText('-- header\n\nCREATE OR REPLACE FUNCTION\n    app.calc(x int) RETURNS int AS $$ select x $$ LANGUAGE sql;');
    assert.equal(defs.length, 1);
    assert.deepEqual(defs[0].start, { line: 3, character: 4 });
    assert.deepEqual(defs[0].end, { line: 3, character: 12 });
});

// ===== scanSqlText: identity arguments =====

test('scanSqlText keeps the identity arguments of a function: no OUT, no defaults, no names', () => {
    const sql = `CREATE FUNCTION f(
        IN p_id int,
        OUT o_name text,
        p_limit integer DEFAULT 10,
        p_flag boolean = false,
        VARIADIC p_tags varchar[]
    ) RETURNS record LANGUAGE sql AS 'select 1';`;
    assert.deepEqual(scanSqlText(sql)[0].argTypes, ['integer', 'integer', 'boolean', 'character varying[]']);
});

test('scanSqlText drops OUT arguments of procedures too, like pg_proc.proargtypes does', () => {
    const defs = scanSqlText('CREATE PROCEDURE p(IN a int, OUT b text, INOUT c date) LANGUAGE plpgsql AS $$ BEGIN END $$;');
    assert.deepEqual(defs[0].argTypes, ['integer', 'date']);
});

test('scanSqlText reads the mode written after the argument name', () => {
    const defs = scanSqlText('CREATE PROCEDURE p(INOUT p_self app.t, pi_unit IN VARCHAR, po_x OUT int, pio INOUT date) LANGUAGE plpgsql AS $$ BEGIN END $$;');
    assert.deepEqual(defs[0].argTypes, ['t', 'character varying', 'date']);
});

test('scanSqlText tells an argument name from the first word of a multi-word type', () => {
    const sql = `CREATE FUNCTION f(double precision, ts timestamp with time zone, character varying(20),
        t timestamp, d double precision, a int ARRAY, b int[3], n numeric(10, 2)) RETURNS int AS 'x' LANGUAGE sql;`;
    assert.deepEqual(scanSqlText(sql)[0].argTypes, [
        'double precision',
        'timestamp with time zone',
        'character varying',
        'timestamp without time zone',
        'double precision',
        'integer[]',
        'integer[]',
        'numeric'
    ]);
});

test('scanSqlText marks a %TYPE argument as unknown', () => {
    const defs = scanSqlText('CREATE FUNCTION f(p_id public.users.id%TYPE, p_name text) RETURNS int AS $$ select 1 $$ LANGUAGE sql;');
    assert.deepEqual(defs[0].argTypes, ['?', 'text']);
});

test('scanSqlText reads the arguments of aggregates in every syntax', () => {
    const sql = `
        CREATE AGGREGATE a1(int, text) (SFUNC = f, STYPE = int);
        CREATE AGGREGATE a2(*) (SFUNC = f, STYPE = int8);
        CREATE AGGREGATE a3(float8 ORDER BY int) (SFUNC = f, STYPE = internal);
        CREATE AGGREGATE a4 (BASETYPE = int4, SFUNC = f, STYPE = int);
        CREATE AGGREGATE a5 (BASETYPE = 'any', SFUNC = f, STYPE = int);`;
    assert.deepEqual(scanSqlText(sql).map(d => d.argTypes), [
        ['integer', 'text'],
        [],
        ['double precision', 'integer'],
        ['integer'],
        []
    ]);
});

// ===== scanSqlText: search_path =====

test('scanSqlText records the search_path a file sets for the definitions after it', () => {
    const sql = `
        CREATE TABLE before_set (id int);
        SET search_path TO app, "$user", public;
        CREATE TABLE after_set (id int);
        SET search_path = DEFAULT;
        CREATE TABLE after_reset (id int);
        SELECT pg_catalog.set_config('search_path', 'reporting, public', false);
        CREATE TABLE after_set_config (id int);`;
    assert.deepEqual(scanSqlText(sql).map(d => [d.name, d.searchPath]), [
        ['before_set', null],
        ['after_set', ['app', 'public']],
        ['after_reset', null],
        ['after_set_config', ['reporting', 'public']]
    ]);
});

test('a SET search_path inside a function header does not change the search_path of the file', () => {
    const sql = `CREATE FUNCTION f() RETURNS int SET search_path = other AS 'select 1' LANGUAGE sql;
                 CREATE TABLE t (id int);`;
    assert.equal(scanSqlText(sql)[1].searchPath, null);
});

// ===== normalizeTypeName =====

test('normalizeTypeName maps the spellings of a type to the one format_type uses', () => {
    const cases: Array<[string, string]> = [
        ['int', 'integer'],
        ['INT4', 'integer'],
        ['int8', 'bigint'],
        ['float8', 'double precision'],
        ['float(10)', 'real'],
        ['float(40)', 'double precision'],
        ['decimal(10,2)', 'numeric'],
        ['bool', 'boolean'],
        ['varchar(30)', 'character varying'],
        ['char(3)', 'character'],
        ['"char"', '"char"'],
        ['timestamptz', 'timestamp with time zone'],
        ['timestamp(3) without time zone', 'timestamp without time zone'],
        ['interval day to second', 'interval'],
        ['pg_catalog.int4', 'integer'],
        ['myschema.MyType', 'mytype'],
        ['"MySchema"."MyType"', 'MyType'],
        ['integer[]', 'integer[]'],
        ['text[][]', 'text[]']
    ];
    for (const [input, expected] of cases) {
        assert.equal(normalizeTypeName(input), expected, input);
    }
});
