import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildCreateAggregate,
    buildCreateComposite,
    buildCreateDomain,
    buildCreateEnum,
    buildCreateMaterializedView,
    buildCreateRange,
    buildCreateSequence,
    buildCreateTable,
    buildCreateView,
    buildDropStatement,
    buildExtras,
    buildGrantStatements,
    buildPolicyStatement,
    buildTriggerStatements,
    combineScripts,
    fetchCreateScript,
    formatFdwOptions,
    formatStorageOptions,
    quoteIdentifier,
    terminate,
    type AggregateInfo,
    type DdlContext,
    type TableInfo,
    withQualifiedNames
} from '../ddlGenerator';

const ALL_EXTRAS = { includeComments: true, includeOwner: true, includeGrants: true };

// ===== names and DROP =====

test('quoteIdentifier quotes only what PostgreSQL would not read as written', () => {
    assert.equal(quoteIdentifier('orders'), 'orders');
    assert.equal(quoteIdentifier('Orders'), '"Orders"');
    assert.equal(quoteIdentifier('order'), '"order"');
    assert.equal(quoteIdentifier('my "x"'), '"my ""x"""');
});

test('buildDropStatement names every kind the way DROP expects it, always with IF EXISTS', () => {
    assert.equal(buildDropStatement({ kind: 'function', schema: 'app', name: 'calc', args: 'a integer, b text' }),
        'DROP FUNCTION IF EXISTS app.calc(a integer, b text);');
    assert.equal(buildDropStatement({ kind: 'procedure', schema: 'app', name: 'run', args: '' }), 'DROP PROCEDURE IF EXISTS app.run();');
    assert.equal(buildDropStatement({ kind: 'aggregate', schema: 'app', name: 'cnt', args: '' }), 'DROP AGGREGATE IF EXISTS app.cnt(*);');
    assert.equal(buildDropStatement({ kind: 'trigger', schema: 'app', name: 'audit', table: 'Orders' }), 'DROP TRIGGER IF EXISTS audit ON app."Orders";');
    assert.equal(buildDropStatement({ kind: 'matview', schema: 'app', name: 'totals' }), 'DROP MATERIALIZED VIEW IF EXISTS app.totals;');
    assert.equal(buildDropStatement({ kind: 'foreign', schema: 'app', name: 'remote' }), 'DROP FOREIGN TABLE IF EXISTS app.remote;');
    assert.equal(buildDropStatement({ kind: 'schema', schema: 'app', name: 'app' }), 'DROP SCHEMA IF EXISTS app;');
    assert.equal(buildDropStatement({ kind: 'extension', schema: 'public', name: 'uuid-ossp' }), 'DROP EXTENSION IF EXISTS "uuid-ossp";');
    assert.equal(buildDropStatement({ kind: 'domain', schema: 'app', name: 'amount' }), 'DROP DOMAIN IF EXISTS app.amount;');
});

test('combineScripts separates the scripts by one blank line and ends with a newline', () => {
    assert.equal(combineScripts(['A;\n', '', 'B;']), 'A;\n\nB;\n');
});

test('combineScripts moves OWNED BY to the end, after the table that owns the sequence', () => {
    const sequence = 'CREATE SEQUENCE app.s;\nALTER SEQUENCE app.s OWNED BY app.t.id;\n\nCOMMENT ON SEQUENCE app.s IS \'x\';';
    const table = "CREATE TABLE app.t (id integer DEFAULT nextval('app.s'::regclass));";
    assert.equal(combineScripts([sequence, table]), [
        'CREATE SEQUENCE app.s;',
        '',
        "COMMENT ON SEQUENCE app.s IS 'x';",
        '',
        "CREATE TABLE app.t (id integer DEFAULT nextval('app.s'::regclass));",
        '',
        'ALTER SEQUENCE app.s OWNED BY app.t.id;',
        ''
    ].join('\n'));
    assert.equal(combineScripts([sequence]), sequence + '\n', 'a single script stays as it is');
});

test('terminate closes a definition with exactly one semicolon', () => {
    assert.equal(terminate('SELECT 1\n'), 'SELECT 1;');
    assert.equal(terminate(' SELECT 1;  '), ' SELECT 1;');
});

// ===== comments, owner and privileges =====

test('buildGrantStatements writes nothing while the object has its default privileges', () => {
    assert.deepEqual(buildGrantStatements('table', 'public.t', 'owner', null), []);
});

test('buildGrantStatements groups the privileges per role and skips those of the owner', () => {
    const lines = buildGrantStatements('table', 'public.t', 'owner', [
        { grantee: 'owner', privilege: 'SELECT', grantable: false },
        { grantee: 'reader', privilege: 'SELECT', grantable: false },
        { grantee: 'Writer', privilege: 'UPDATE', grantable: false },
        { grantee: 'Writer', privilege: 'INSERT', grantable: false },
        { grantee: 'admin', privilege: 'DELETE', grantable: true }
    ]);
    assert.deepEqual(lines, [
        'GRANT SELECT ON TABLE public.t TO reader;',
        'GRANT INSERT, UPDATE ON TABLE public.t TO "Writer";',
        'GRANT DELETE ON TABLE public.t TO admin WITH GRANT OPTION;'
    ]);
});

test('buildGrantStatements revokes PUBLIC\'s EXECUTE on a function that no longer grants it', () => {
    assert.deepEqual(
        buildGrantStatements('function', 'app.f(integer)', 'owner', [{ grantee: 'app_user', privilege: 'EXECUTE', grantable: false }]),
        ['REVOKE ALL ON FUNCTION app.f(integer) FROM PUBLIC;', 'GRANT EXECUTE ON FUNCTION app.f(integer) TO app_user;']
    );
    assert.deepEqual(
        buildGrantStatements('function', 'app.f(integer)', 'owner', [{ grantee: 'PUBLIC', privilege: 'EXECUTE', grantable: false }]),
        [],
        'PUBLIC keeps its default: nothing to write'
    );
});

test('buildExtras writes comment, owner and grants only as far as the options ask', () => {
    const target = { kind: 'view' as const, schema: 'app', name: 'v' };
    const extras = {
        owner: 'boss',
        comment: "it's open",
        acl: [{ grantee: 'reader', privilege: 'SELECT', grantable: false }],
        columnComments: [{ column: 'Amount', comment: 'in EUR' }]
    };
    assert.deepEqual(buildExtras(target, extras, ALL_EXTRAS), [
        "COMMENT ON VIEW app.v IS 'it''s open';",
        `COMMENT ON COLUMN app.v."Amount" IS 'in EUR';`,
        'ALTER VIEW app.v OWNER TO boss;',
        'GRANT SELECT ON TABLE app.v TO reader;'
    ]);
    assert.deepEqual(buildExtras(target, extras, { includeComments: false, includeOwner: false, includeGrants: false }), []);
});

test('buildExtras gives a trigger a comment but neither owner nor grants', () => {
    const lines = buildExtras({ kind: 'trigger', schema: 'app', name: 'audit', table: 'orders' },
        { owner: 'boss', comment: 'logs changes', acl: null }, ALL_EXTRAS);
    assert.deepEqual(lines, ["COMMENT ON TRIGGER audit ON app.orders IS 'logs changes';"]);
});

test('buildExtras names an ordered-set aggregate in GRANT by its flat argument list', () => {
    const lines = buildExtras(
        { kind: 'aggregate', schema: 'app', name: 'pct', args: 'double precision ORDER BY anyelement' },
        { owner: 'boss', comment: null, acl: [{ grantee: 'reader', privilege: 'EXECUTE', grantable: false }] },
        ALL_EXTRAS
    );
    assert.deepEqual(lines, [
        'ALTER AGGREGATE app.pct(double precision ORDER BY anyelement) OWNER TO boss;',
        'REVOKE ALL ON FUNCTION app.pct(double precision, anyelement) FROM PUBLIC;',
        'GRANT EXECUTE ON FUNCTION app.pct(double precision, anyelement) TO reader;'
    ]);
});

test('options of a relation and of a foreign table are written in their own syntax', () => {
    assert.equal(formatStorageOptions(['fillfactor=70', 'autovacuum_enabled=false', 'odd=a b']), "fillfactor=70, autovacuum_enabled=false, odd='a b'");
    assert.equal(formatFdwOptions(['schema_name=public', "table_name=o'clock"]), "schema_name 'public', table_name 'o''clock'");
});

// ===== CREATE builders =====

const AGGREGATE: AggregateInfo = {
    schema: 'app', name: 'median', arguments: 'numeric', aggKind: 'n',
    sfunc: 'array_append', stype: 'numeric[]', sspace: 0,
    finalfunc: 'app.median_final', finalExtra: false, finalModify: 'r',
    combinefunc: null, serialfunc: null, deserialfunc: null, initcond: '{}',
    msfunc: null, minvfunc: null, mstype: null, msspace: 0, mfinalfunc: null, mfinalExtra: false, mfinalModify: 'r', minitcond: null,
    sortop: null, parallel: 's'
};

test('buildCreateAggregate writes the options that differ from the defaults', () => {
    assert.equal(buildCreateAggregate(AGGREGATE), [
        'CREATE AGGREGATE app.median (numeric) (',
        '    SFUNC = array_append,',
        '    STYPE = numeric[],',
        '    FINALFUNC = app.median_final,',
        "    INITCOND = '{}',",
        '    PARALLEL = SAFE',
        ');'
    ].join('\n'));
});

test('buildCreateAggregate writes * for an aggregate without arguments and marks hypothetical-set aggregates', () => {
    const sql = buildCreateAggregate({ ...AGGREGATE, arguments: '', aggKind: 'h', finalModify: 'w', parallel: 'u', initcond: null, finalfunc: null });
    assert.match(sql, /^CREATE AGGREGATE app\.median \(\*\) \(/);
    assert.match(sql, /HYPOTHETICAL\n\);$/);
    assert.doesNotMatch(sql, /FINALFUNC_MODIFY/, 'READ_WRITE is the default of an ordered-set aggregate');
});

test('buildCreateEnum, buildCreateComposite and buildCreateRange write the type definitions', () => {
    assert.equal(buildCreateEnum('app', 'mood', ['sad', "it's ok"]), "CREATE TYPE app.mood AS ENUM (\n    'sad',\n    'it''s ok'\n);");
    assert.equal(
        buildCreateComposite('app', 'pair', [{ name: 'a', type: 'integer', collation: null }, { name: 'B', type: 'text', collation: 'pg_catalog."C"' }]),
        'CREATE TYPE app.pair AS (\n    a integer,\n    "B" text COLLATE pg_catalog."C"\n);'
    );
    assert.equal(
        buildCreateRange('app', 'floatrange', { subtype: 'double precision', opclass: null, collation: null, canonical: null, subdiff: 'float8mi', multirange: 'floatmultirange' }),
        'CREATE TYPE app.floatrange AS RANGE (\n    SUBTYPE = double precision,\n    SUBTYPE_DIFF = float8mi\n);',
        'the default multirange name is left out'
    );
    assert.match(
        buildCreateRange('app', 'span', { subtype: 'int4', opclass: null, collation: null, canonical: null, subdiff: null, multirange: 'spans' }),
        /MULTIRANGE_TYPE_NAME = app\.spans/
    );
});

test('buildCreateDomain writes base type, collation, default, NOT NULL and the checks', () => {
    assert.equal(buildCreateDomain('app', 'amount', {
        baseType: 'numeric(12,2)', collation: null, defaultValue: '0', notNull: true,
        constraints: [{ name: 'amount_positive', definition: 'CHECK (VALUE >= 0::numeric)' }]
    }), 'CREATE DOMAIN app.amount AS numeric(12,2)\n    DEFAULT 0\n    NOT NULL\n    CONSTRAINT amount_positive CHECK (VALUE >= 0::numeric);');
});

test('buildCreateSequence writes every parameter and the column it belongs to', () => {
    assert.equal(buildCreateSequence('app', 'order_no', {
        dataType: 'bigint', start: '1000', increment: '1', min: '1', max: '9223372036854775807', cache: '1', cycle: false,
        unlogged: false, ownedBy: { schema: 'app', table: 'orders', column: 'no' }
    }), [
        'CREATE SEQUENCE app.order_no',
        '    AS bigint',
        '    INCREMENT BY 1',
        '    MINVALUE 1',
        '    MAXVALUE 9223372036854775807',
        '    START WITH 1000',
        '    CACHE 1',
        '    NO CYCLE;',
        'ALTER SEQUENCE app.order_no OWNED BY app.orders.no;'
    ].join('\n'));
});

test('buildTriggerStatements restores a trigger that is not enabled as usual', () => {
    assert.deepEqual(buildTriggerStatements('app', 'orders', { name: 'audit', definition: 'CREATE TRIGGER audit AFTER INSERT ON app.orders FOR EACH ROW EXECUTE FUNCTION f()', enabled: 'D' }), [
        'CREATE TRIGGER audit AFTER INSERT ON app.orders FOR EACH ROW EXECUTE FUNCTION f();',
        'ALTER TABLE app.orders DISABLE TRIGGER audit;'
    ]);
    assert.equal(buildTriggerStatements('app', 'orders', { name: 'audit', definition: 'CREATE TRIGGER x', enabled: 'O' }).length, 1);
});

test('buildCreateView keeps the definition and turns check_option into WITH … CHECK OPTION', () => {
    assert.equal(
        buildCreateView('app', 'open_orders', { definition: ' SELECT id\n   FROM app.orders\n  WHERE NOT done;', options: ['security_barrier=true', 'check_option=cascaded'] }),
        'CREATE OR REPLACE VIEW app.open_orders WITH (security_barrier=true) AS\n SELECT id\n   FROM app.orders\n  WHERE NOT done\n  WITH CASCADED CHECK OPTION;'
    );
});

test('buildCreateMaterializedView says whether it is populated and adds its indexes', () => {
    assert.equal(
        buildCreateMaterializedView('app', 'totals', { definition: ' SELECT 1 AS n;', options: null, populated: false, indexes: ['CREATE INDEX t_n ON app.totals USING btree (n)'] }),
        'CREATE MATERIALIZED VIEW app.totals AS\n SELECT 1 AS n\nWITH NO DATA;\nCREATE INDEX t_n ON app.totals USING btree (n);'
    );
});

function table(overrides: Partial<TableInfo>): TableInfo {
    return {
        kind: 'table', schema: 'app', name: 'orders', unlogged: false, partitionKey: null, partitionOf: null, inherits: [],
        options: null, foreignServer: null, foreignOptions: null, columns: [], constraints: [], indexes: [], triggers: [],
        rowSecurity: false, forceRowSecurity: false, policies: [], ...overrides
    };
}

const column = (name: string, type: string, extra: Partial<TableInfo['columns'][number]> = {}): TableInfo['columns'][number] => ({
    name, type, notNull: false, defaultExpr: null, identity: '', generated: '', collation: null, isLocal: true, fdwOptions: null, ...extra
});

test('buildCreateTable writes columns with identity, generated values, defaults, collation and constraints', () => {
    const sql = buildCreateTable(table({
        unlogged: true,
        options: ['fillfactor=80'],
        columns: [
            column('id', 'bigint', { notNull: true, identity: 'a' }),
            column('Name', 'text', { collation: 'pg_catalog."C"', notNull: true }),
            column('created', 'timestamp with time zone', { defaultExpr: 'now()' }),
            column('total', 'numeric', { generated: 's', defaultExpr: '(net + tax)' })
        ],
        constraints: [
            { name: 'orders_pkey', definition: 'PRIMARY KEY (id)' },
            { name: 'orders_customer_fkey', definition: 'FOREIGN KEY (customer) REFERENCES app.customer(id)' }
        ]
    }));
    assert.equal(sql, [
        'CREATE UNLOGGED TABLE app.orders (',
        '    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,',
        '    "Name" text COLLATE pg_catalog."C" NOT NULL,',
        '    created timestamp with time zone DEFAULT now(),',
        '    total numeric GENERATED ALWAYS AS ((net + tax)) STORED,',
        '    CONSTRAINT orders_pkey PRIMARY KEY (id),',
        '    CONSTRAINT orders_customer_fkey FOREIGN KEY (customer) REFERENCES app.customer(id)',
        ')',
        'WITH (fillfactor=80);'
    ].join('\n'));
});

test('buildCreateTable writes partitioned tables and their partitions', () => {
    assert.equal(
        buildCreateTable(table({ columns: [column('day', 'date')], partitionKey: 'RANGE (day)' })),
        'CREATE TABLE app.orders (\n    day date\n)\nPARTITION BY RANGE (day);'
    );
    assert.equal(
        buildCreateTable(table({
            name: 'orders_2024', columns: [column('day', 'date', { isLocal: false })],
            partitionOf: { schema: 'app', name: 'orders', bound: "FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')" }
        })),
        "CREATE TABLE app.orders_2024 PARTITION OF app.orders\nFOR VALUES FROM ('2024-01-01') TO ('2025-01-01');"
    );
});

test('buildCreateTable leaves inherited columns to INHERITS', () => {
    const sql = buildCreateTable(table({
        name: 'special_orders',
        inherits: [{ schema: 'app', name: 'orders' }],
        columns: [column('id', 'bigint', { isLocal: false }), column('reason', 'text')]
    }));
    assert.equal(sql, 'CREATE TABLE app.special_orders (\n    reason text\n)\nINHERITS (app.orders);');
});

test('buildCreateTable writes a foreign table with server and options', () => {
    const sql = buildCreateTable(table({
        kind: 'foreign', name: 'remote_orders', foreignServer: 'erp',
        foreignOptions: ['schema_name=sales', 'table_name=orders'],
        columns: [column('id', 'integer', { fdwOptions: ['column_name=order_id'] })]
    }));
    assert.equal(sql, "CREATE FOREIGN TABLE app.remote_orders (\n    id integer OPTIONS (column_name 'order_id')\n)\nSERVER erp\nOPTIONS (schema_name 'sales', table_name 'orders');");
});

test('buildCreateTable follows the table with its indexes, triggers, row level security and policies', () => {
    const sql = buildCreateTable(table({
        columns: [column('id', 'integer')],
        indexes: ['CREATE INDEX orders_id_idx ON app.orders USING btree (id)'],
        triggers: [{ name: 'audit', definition: 'CREATE TRIGGER audit AFTER INSERT ON app.orders FOR EACH ROW EXECUTE FUNCTION f()', enabled: 'O' }],
        rowSecurity: true,
        forceRowSecurity: true,
        policies: [{ name: 'own_rows', permissive: false, roles: ['app_user'], command: 'SELECT', using: '(owner = CURRENT_USER)', withCheck: null }]
    }));
    assert.equal(sql.split('\n').slice(3).join('\n'), [
        '',
        'CREATE INDEX orders_id_idx ON app.orders USING btree (id);',
        'CREATE TRIGGER audit AFTER INSERT ON app.orders FOR EACH ROW EXECUTE FUNCTION f();',
        'ALTER TABLE app.orders ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE app.orders FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY own_rows ON app.orders AS RESTRICTIVE FOR SELECT TO app_user USING ((owner = CURRENT_USER));'
    ].join('\n'));
});

test('buildPolicyStatement leaves out what is the default: ALL commands and PUBLIC', () => {
    assert.equal(
        buildPolicyStatement('app', 'orders', { name: 'p', permissive: true, roles: ['public'], command: 'ALL', using: null, withCheck: '(true)' }),
        'CREATE POLICY p ON app.orders WITH CHECK ((true));'
    );
});

// ===== fetchCreateScript =====

function stubContext(answer: (sql: string, params: unknown[]) => Array<Record<string, unknown>>, calls: Array<{ sql: string; params: unknown[] }>): DdlContext {
    return {
        query: async (sql, params) => {
            calls.push({ sql, params });
            return answer(sql, params);
        },
        options: ALL_EXTRAS,
        serverVersion: 160000
    };
}

test('fetchCreateScript reads a function by its oid as a parameter and appends its extras', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const ctx = stubContext((sql) => {
        if (sql.includes('pg_get_functiondef')) {
            return [{ def: 'CREATE OR REPLACE FUNCTION app.f(a integer)\n RETURNS integer\n LANGUAGE sql\nAS $function$select a$function$\n', args: 'a integer', owner: 'boss', comment: 'doubles' }];
        }
        if (sql.includes('aclexplode')) return [{ is_default: true, grantee: null, privilege_type: null, is_grantable: null }];
        return [];
    }, calls);
    const script = await fetchCreateScript(ctx, { kind: 'function', schema: 'app', name: 'f', args: 'a integer', oid: 4242 });
    assert.equal(script, [
        'CREATE OR REPLACE FUNCTION app.f(a integer)',
        ' RETURNS integer',
        ' LANGUAGE sql',
        'AS $function$select a$function$;',
        '',
        "COMMENT ON FUNCTION app.f(a integer) IS 'doubles';",
        'ALTER FUNCTION app.f(a integer) OWNER TO boss;'
    ].join('\n'));
    assert.ok(calls.every(c => c.params.length === 1 && c.params[0] === 4242), 'the oid travels as a parameter');
    assert.ok(calls.every(c => !c.sql.includes('4242')), 'the oid is never written into the SQL');
});

test('fetchCreateScript looks up the oid of a relation from the Tables view by schema and name', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const ctx = stubContext((sql) => {
        if (sql.includes('SELECT c.oid FROM')) return [{ oid: 77 }];
        if (sql.includes('pg_get_viewdef')) return [{ def: ' SELECT 1 AS one;' }];
        if (sql.includes('c.relkind, c.relpersistence')) return [{ nspname: 'app', relname: 'v', relkind: 'v', reloptions: null, owner: null, comment: null }];
        if (sql.includes('aclexplode')) return [{ is_default: true }];
        return [];
    }, calls);
    const script = await fetchCreateScript(ctx, { kind: 'view', schema: 'app', name: 'v' });
    assert.equal(script, 'CREATE OR REPLACE VIEW app.v AS\n SELECT 1 AS one;');
    assert.deepEqual(calls[0].params, ['app', 'v']);
});

test('fetchCreateScript says so when the object is gone from the database', async () => {
    const ctx = stubContext(() => [], []);
    await assert.rejects(fetchCreateScript(ctx, { kind: 'sequence', schema: 'app', name: 's', oid: 1 }), /no longer exists/);
});

// ===== withQualifiedNames =====

test('withQualifiedNames reads with an empty search_path in a read-only transaction, and ends it also after an error', async () => {
    const sent: string[] = [];
    const client = { query: async (sql: string) => { sent.push(sql); if (sql === 'boom') throw new Error('boom'); return { rows: [{ ok: 1 }] }; } };
    const rows = await withQualifiedNames(client, (query) => query('SELECT 1', []));
    assert.deepEqual(rows, [{ ok: 1 }]);
    assert.deepEqual(sent, ['BEGIN READ ONLY', "SELECT pg_catalog.set_config('search_path', '', true)", 'SELECT 1', 'ROLLBACK']);
    sent.length = 0;
    await assert.rejects(withQualifiedNames(client, (query) => query('boom', [])), /boom/);
    assert.equal(sent[sent.length - 1], 'ROLLBACK');
});
