import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    DEFAULT_CHECK_SETTINGS,
    HIDE_CANDIDATES_QUERY,
    SingleFlightQueue,
    bodyLine,
    buildCheckCall,
    checkTargets,
    creationAttempts,
    creationFinding,
    findingOf,
    hideStatement,
    offsetAt,
    retryCreation,
    runCheck,
    severityOf,
    type CheckClient
} from '../plpgsqlCheck';

const FILE = [
    'SET search_path = app;',                                                       // 0
    '',                                                                             // 1
    'CREATE OR REPLACE FUNCTION app.f(p_a integer) RETURNS integer',                // 2
    'LANGUAGE plpgsql AS $body$',                                                   // 3
    'DECLARE',                                                                      // 4
    '  v_x integer;',                                                               // 5
    'BEGIN',                                                                        // 6
    '  SELECT no_col INTO v_x FROM t WHERE id = p_a;',                              // 7
    '  RETURN v_x;',                                                                // 8
    'END $body$;',                                                                  // 9
    "CREATE FUNCTION app.g() RETURNS int LANGUAGE sql AS 'SELECT 1';",              // 10
    "CREATE FUNCTION app.h() RETURNS trigger LANGUAGE 'plpgsql' AS 'BEGIN RETURN NEW; END';", // 11
    'CREATE TRIGGER trg BEFORE INSERT ON app.t FOR EACH ROW EXECUTE FUNCTION app.h();', // 12
    'CREATE PROCEDURE app.p() LANGUAGE plpgsql AS $$ BEGIN NULL; END $$;'           // 13
].join('\n');

// ===== targets =====

test('the check targets are the PL/pgSQL functions and procedures, with their bodies and where they start', () => {
    const targets = checkTargets(FILE);
    assert.deepEqual(targets.map(t => [t.def.name, t.trigger, t.searchPath?.join(',')]), [['f', false, 'app'], ['h', true, 'app'], ['p', false, 'app']]);
    const [f, h] = targets;
    assert.deepEqual(f.bodyStart, { line: 3, character: 26 });
    assert.equal(f.body.split('\n')[4], '  SELECT no_col INTO v_x FROM t WHERE id = p_a;');
    assert.equal(bodyLine(f, 5), 7, 'line 5 of the body is the SELECT');
    assert.ok(f.statement.startsWith('CREATE OR REPLACE FUNCTION') && f.statement.endsWith('END $body$'));
    assert.equal(h.body, 'BEGIN RETURN NEW; END');
    assert.deepEqual(h.triggerTable, { schema: 'app', name: 't' });
    assert.equal(offsetAt(FILE, { line: 2, character: 0 }), FILE.indexOf('CREATE OR REPLACE'));
});

// ===== the call =====

test('every option is passed as a named parameter; unknown ones are left out, the function is qualified', () => {
    const all = buildCheckCall(DEFAULT_CHECK_SETTINGS, new Set(), false, 'ext');
    assert.match(all.sql, /^SELECT \* FROM "ext"\.plpgsql_check_function_tb\(\$1::pg_catalog\.oid::pg_catalog\.regprocedure, fatal_errors => \$2::boolean/);
    assert.equal(all.params.length, 10);
    assert.equal(all.params[1], false);
    const some = buildCheckCall({ ...DEFAULT_CHECK_SETTINGS, performanceWarnings: true }, new Set(['funcoid', 'relid', 'performance_warnings']), true);
    assert.equal(some.sql, 'SELECT * FROM "public".plpgsql_check_function_tb($1::pg_catalog.oid::pg_catalog.regprocedure, relid => $2::pg_catalog.regclass, performance_warnings => $3::boolean)');
    assert.deepEqual(some.params, [null, null, true]);
});

test('the severity follows the level; extra warnings use the configured severity', () => {
    assert.equal(severityOf('error', 'information'), 'error');
    assert.equal(severityOf('warning', 'information'), 'warning');
    assert.equal(severityOf('warning extra', 'information'), 'information');
    assert.equal(severityOf('performance', 'warning'), 'warning');
});

// ===== findings =====

test('a finding lands on its line of the file, at the query position when the line holds the query', () => {
    const [f] = checkTargets(FILE);
    const finding = findingOf({ lineno: 5, level: 'error', message: 'column "no_col" does not exist', sqlstate: '42703', query: 'SELECT no_col INTO v_x FROM t WHERE id = p_a', position: 8, hint: 'Check it' }, f, FILE, 'information');
    assert.equal(finding.severity, 'error');
    assert.equal(finding.code, '42703');
    assert.equal(finding.message, 'column "no_col" does not exist\nHint: Check it');
    assert.deepEqual([finding.start, finding.end], [{ line: 7, character: 9 }, { line: 7, character: 15 }]);
    const lineOnly = findingOf({ lineno: 4, level: 'warning extra', message: 'x' }, f, FILE, 'information');
    assert.deepEqual([lineOnly.severity, lineOnly.start, lineOnly.end], ['information', { line: 6, character: 0 }, { line: 6, character: 5 }]);
    const whole = findingOf({ lineno: null, level: 'warning', message: 'unused parameter' }, f, FILE, 'information');
    assert.deepEqual(whole.start, f.def.start);
});

test('a statement the server refuses is an error at the position the server names', () => {
    const [f] = checkTargets(FILE);
    const position = f.statement.indexOf('no_col') + 1;
    const finding = creationFinding(Object.assign(new Error('syntax error at or near "no_col"'), { position: String(position), code: '42601' }), f, FILE);
    assert.deepEqual([finding.start, finding.end, finding.code], [{ line: 7, character: 9 }, { line: 7, character: 15 }, '42601']);
});

// ===== the run =====

function client(answer: (sql: string, params?: unknown[]) => Array<Record<string, unknown>> | Error = () => []): CheckClient & { sent: string[] } {
    const sent: string[] = [];
    return {
        sent,
        query: async (sql: string, params?: unknown[]) => {
            sent.push(sql);
            const result = answer(sql, params);
            if (result instanceof Error) throw result;
            return { rows: result };
        }
    };
}

const OPTIONS = { settings: DEFAULT_CHECK_SETTINGS, extraSeverity: 'information' as const, timeoutMs: 5000, knownParameters: new Set<string>(), functionSchema: 'public' };

test('the routines are created, checked and always rolled back, each behind a savepoint', async () => {
    const c = client((sql) => {
        if (sql.includes('FROM pg_catalog.pg_proc p') && sql.includes('prosrc = $2')) return [{ oid: 42 }];
        if (sql.includes('to_regclass')) return [{ relid: 7 }];
        if (sql.includes('plpgsql_check_function_tb')) return [{ lineno: 5, level: 'error', message: 'boom' }];
        return [];
    });
    const findings = await runCheck(c, FILE, OPTIONS);
    assert.equal(c.sent[0], 'BEGIN');
    assert.equal(c.sent[c.sent.length - 1], 'ROLLBACK');
    assert.equal(c.sent.filter(s => s === 'SAVEPOINT pqb_check').length, 3);
    assert.ok(c.sent.some(s => s.startsWith('CREATE OR REPLACE FUNCTION app.f')));
    assert.ok(!c.sent.some(s => s.includes('app.g()')), 'a SQL function is not checked');
    assert.ok(c.sent.some(s => s.includes('relid => $2')), 'the trigger function is checked with the table of its trigger');
    assert.equal(findings.length, 3);
    assert.deepEqual(findings[0].start, { line: 7, character: 2 });
});

test('a refused CREATE is reported and the next routine is still checked; nothing is committed', async () => {
    const c = client((sql) => (sql.startsWith('CREATE OR REPLACE FUNCTION app.f') ? Object.assign(new Error('syntax error'), { position: '1' }) : []));
    const findings = await runCheck(c, FILE, OPTIONS);
    assert.deepEqual(findings.map(f => f.message), ['syntax error']);
    assert.ok(c.sent.includes('ROLLBACK TO SAVEPOINT pqb_check'));
    assert.ok(c.sent.some(s => s.startsWith('CREATE PROCEDURE app.p')));
    assert.ok(!c.sent.includes('COMMIT'));
    assert.equal(c.sent[c.sent.length - 1], 'ROLLBACK');
});

test('a trigger function no trigger uses is reported as not checked', async () => {
    const only = "CREATE FUNCTION app.h() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';";
    const c = client((sql) => (sql.includes('prosrc = $2') ? [{ oid: 42 }] : []));
    const findings = await runCheck(c, only, OPTIONS);
    assert.deepEqual(findings.map(f => [f.severity, /no trigger uses it/.test(f.message)]), [['information', true]]);
    assert.ok(!c.sent.some(s => s.includes('plpgsql_check_function_tb')));
});

test('a file without PL/pgSQL routines sends nothing', async () => {
    const c = client();
    assert.deepEqual(await runCheck(c, 'SELECT 1;', OPTIONS), []);
    assert.deepEqual(c.sent, []);
});

// ===== routines the database already has =====

const EXISTING = [
    'SET search_path = app;',
    'CREATE FUNCTION k(p integer) RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN p; END $$;'
].join('\n');
const sqlError = (message: string, code: string, position?: number) => Object.assign(new Error(message), { code, ...(position ? { position: String(position) } : {}) });
const REPLACING = { ...OPTIONS, replaceExisting: true };

test('a routine the database already has is created with OR REPLACE and still checked', async () => {
    const c = client((sql) => {
        if (sql.startsWith('CREATE FUNCTION k(')) return sqlError('function "k" already exists with same argument types', '42723');
        if (sql.includes('prosrc = $2')) return [{ oid: 42 }];
        if (sql.includes('plpgsql_check_function_tb')) return [{ lineno: 1, level: 'warning', message: 'unused variable' }];
        return [];
    });
    const findings = await runCheck(c, EXISTING, REPLACING);
    assert.deepEqual(findings.map(f => f.message), ['unused variable']);
    assert.ok(c.sent.includes(EXISTING.split('\n')[1].replace(/^CREATE/, 'CREATE OR REPLACE').replace(/;$/, '')));
    const replacing = c.sent.findIndex(s => s.startsWith('CREATE OR REPLACE'));
    assert.match(c.sent[replacing - 1], /set_config\('search_path'/, 'the search_path is set again after the rollback to the savepoint');
    assert.equal(c.sent[c.sent.length - 1], 'ROLLBACK');
});

test('a routine OR REPLACE cannot replace is checked under a temporary name and reported under its own', async () => {
    let lookedUp: unknown;
    const c = client((sql, params) => {
        if (sql.startsWith('CREATE FUNCTION k(')) return sqlError('function "k" already exists with same argument types', '42723');
        if (sql.startsWith('CREATE OR REPLACE')) return sqlError('cannot change return type of existing function', '42P13');
        if (sql.includes('prosrc = $2')) {
            lookedUp = params?.[0];
            return [{ oid: 42 }];
        }
        if (sql.includes('plpgsql_check_function_tb')) return [{ lineno: 1, level: 'warning', message: 'unused parameter "p" of k_pqb_check_1' }];
        return [];
    });
    const findings = await runCheck(c, EXISTING, REPLACING);
    assert.ok(c.sent.some(s => s.startsWith('CREATE FUNCTION "k_pqb_check_1"(p integer)')));
    assert.equal(lookedUp, 'k_pqb_check_1');
    assert.deepEqual(findings.map(f => f.message), ['unused parameter "p" of k']);
    assert.ok(!c.sent.includes('COMMIT') && !c.sent.some(s => /^DROP/i.test(s)), 'nothing is dropped or kept');
});

test('without replaceExisting a routine the database already has is reported as before', async () => {
    const c = client((sql) => (sql.startsWith('CREATE FUNCTION k(') ? sqlError('function "k" already exists with same argument types', '42723') : []));
    const findings = await runCheck(c, EXISTING, OPTIONS);
    assert.deepEqual(findings.map(f => [f.message, f.code]), [['function "k" already exists with same argument types', '42723']]);
    assert.ok(!c.sent.some(s => s.startsWith('CREATE OR REPLACE') || s.includes('_pqb_check_')));
});

test('an error of the replacing statement lands where it is in the file', async () => {
    const statement = EXISTING.split('\n')[1];
    const c = client((sql) => {
        if (sql.startsWith('CREATE FUNCTION k(')) return sqlError('already exists', '42723');
        if (sql.startsWith('CREATE OR REPLACE')) return sqlError('syntax error at or near "RETURN"', '42601', sql.indexOf('RETURN p') + 1);
        return [];
    });
    const findings = await runCheck(c, EXISTING, REPLACING);
    const column = statement.indexOf('RETURN p');
    assert.deepEqual(findings.map(f => [f.message, f.start, f.end]), [['syntax error at or near "RETURN"', { line: 1, character: column }, { line: 1, character: column + 6 }]]);
    assert.ok(!c.sent.some(s => s.includes('_pqb_check_')), 'a body error is not retried under another name');
});

test('a statement that already says OR REPLACE is not given it twice, and a temporary name fits an identifier', () => {
    const [f] = checkTargets(FILE);
    assert.deepEqual(creationAttempts(f, FILE, 0).map(a => a.sql.slice(0, 40)), [
        'CREATE OR REPLACE FUNCTION app.f(p_a int',
        'CREATE OR REPLACE FUNCTION app."f_pqb_ch'
    ]);
    const long = `CREATE FUNCTION ${'x'.repeat(63)}() RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;`;
    const [renamed] = creationAttempts(checkTargets(long)[0], long, 0).slice(-1);
    assert.equal(Buffer.byteLength(renamed.name), 63);
    assert.ok(renamed.name.endsWith('_pqb_check_1'));
    assert.equal(retryCreation(sqlError('x', '42P13'), creationAttempts(f, FILE, 0)[0]), true, 'its own OR REPLACE may fail like an added one');
});

// ===== versions of the database moved out of the way =====

const OVERLOADS = [
    'CREATE FUNCTION nrs.f_getsapinstance(pi_lbe_id integer, pi_update_cache boolean DEFAULT false) RETURNS varchar LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;',
    'CREATE FUNCTION nrs.tkn(pi_lbe_id integer) RETURNS integer LANGUAGE plpgsql AS $$ BEGIN PERFORM nrs.f_getsapinstance(pi_lbe_id); RETURN 1; END $$;',
    'CREATE FUNCTION nrs.f_getsapinstance(pi_mit_id integer, pi_stichtag timestamp) RETURNS varchar LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;'
].join('\n');

/** A database that has an old f_getsapinstance(integer) and reports an ambiguous call while it is not renamed. */
function overloadedDatabase(rename: (sql: string) => Error | null = () => null) {
    let oldVisible = true;
    let nextOid = 100;
    const oids = new Map<string, number>();
    const c = client((sql, params) => {
        if (sql === HIDE_CANDIDATES_QUERY) {
            return params?.[0] === 'f_getsapinstance' ? [{ oid: 7, schema_name: 'nrs', name: 'f_getsapinstance', args: 'pi_lbe_id integer' }] : [];
        }
        if (sql.startsWith('ALTER ROUTINE')) {
            const err = rename(sql);
            if (err) return err;
            oldVisible = false;
            return [];
        }
        if (sql.startsWith('CREATE')) {
            if (!oids.has(sql)) oids.set(sql, nextOid++);
            return [];
        }
        if (sql.includes('prosrc = $2')) return [{ oid: nextOid - 1 }];
        if (sql.includes('plpgsql_check_function_tb')) {
            const created = [...oids.values()];
            return params?.[0] === created[1] && oldVisible
                ? [{ lineno: 1, level: 'error', message: 'function nrs.f_getsapinstance(integer) is not unique' }]
                : [];
        }
        return [];
    });
    return c;
}

test('the versions the database has of a routine the file creates are renamed first, so a call does not see an old overload', async () => {
    const c = overloadedDatabase();
    const findings = await runCheck(c, OVERLOADS, REPLACING);
    assert.deepEqual(findings, []);
    const rename = c.sent.findIndex(s => s.startsWith('ALTER ROUTINE'));
    assert.equal(c.sent[rename], 'ALTER ROUTINE "nrs"."f_getsapinstance"(pi_lbe_id integer) RENAME TO "f_getsapinstance_pqb_hidden_1"');
    assert.ok(rename < c.sent.findIndex(s => s.startsWith('CREATE')), 'renamed before anything is created');
    assert.equal(c.sent.filter(s => s === HIDE_CANDIDATES_QUERY).length, 2, 'each name is looked up once');
    assert.ok(!c.sent.some(s => /^DROP/i.test(s) || s === 'COMMIT'));
    assert.equal(c.sent[c.sent.length - 1], 'ROLLBACK');
});

test('every routine of the file is created before the first is checked', async () => {
    const c = overloadedDatabase();
    await runCheck(c, OVERLOADS, REPLACING);
    const lastCreate = c.sent.map((s, i) => (s.startsWith('CREATE') ? i : -1)).reduce((a, b) => Math.max(a, b));
    const firstCheck = c.sent.findIndex(s => s.includes('plpgsql_check_function_tb'));
    assert.ok(lastCreate < firstCheck, 'tkn finds the f_getsapinstance defined below it');
    assert.equal(c.sent.filter(s => s.includes('plpgsql_check_function_tb')).length, 3);
});

test('a version the database refuses to rename keeps its name, and the file\'s routine is still created around it', async () => {
    const c = overloadedDatabase(() => sqlError('must be owner of function f_getsapinstance', '42501'));
    const findings = await runCheck(c, OVERLOADS, REPLACING);
    assert.ok(c.sent.includes('ROLLBACK TO SAVEPOINT pqb_hide'));
    assert.deepEqual(findings.map(f => f.message), ['function nrs.f_getsapinstance(integer) is not unique'], 'the ambiguity is real then, and reported');
});

test('without replaceExisting nothing is renamed', async () => {
    const c = overloadedDatabase();
    await runCheck(c, OVERLOADS, OPTIONS);
    assert.ok(!c.sent.some(s => s === HIDE_CANDIDATES_QUERY || s.startsWith('ALTER ROUTINE')));
});

test('only plain functions and procedures outside extensions are moved aside, under a name that fits an identifier', () => {
    assert.match(HIDE_CANDIDATES_QUERY, /p\.prokind IN \('f', 'p'\)/);
    assert.match(HIDE_CANDIDATES_QUERY, /d\.deptype = 'e'/);
    assert.match(HIDE_CANDIDATES_QUERY, /COALESCE\(\$2::text, pg_catalog\.current_schema\(\)\)/, 'an unqualified name is looked for where CREATE puts it');
    const long = hideStatement({ schema_name: 'a"b', name: 'y'.repeat(63), args: '' }, 0);
    assert.equal(Buffer.byteLength(long.name), 63);
    assert.match(long.sql, /^ALTER ROUTINE "a""b"\."y{63}"\(\) RENAME TO "y+_pqb_hidden_1"$/);
});

test('a trigger function is checked on the table of the trigger that uses the version moved aside', async () => {
    const only = "CREATE FUNCTION app.h() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';";
    let triggerOids: unknown;
    const c = client((sql, params) => {
        if (sql === HIDE_CANDIDATES_QUERY) return [{ oid: 9, schema_name: 'app', name: 'h', args: '' }];
        if (sql.includes('prosrc = $2')) return [{ oid: 42 }];
        if (sql.includes('pg_trigger')) {
            triggerOids = params?.[0];
            return [{ relid: 5 }];
        }
        return [];
    });
    await runCheck(c, only, REPLACING);
    assert.deepEqual(triggerOids, [42, 9]);
    assert.ok(c.sent.some(s => s.includes('relid => $2')));
});

// ===== one check at a time =====

test('the queue runs one check at a time, coalesces waiting requests and repeats a check requested while it runs', async () => {
    const runs: string[] = [];
    let active = 0;
    let maxActive = 0;
    const gates: Array<() => void> = [];
    const queue = new SingleFlightQueue(async (key) => {
        active++;
        maxActive = Math.max(maxActive, active);
        runs.push(key);
        await new Promise<void>(resolve => gates.push(resolve));
        active--;
    });
    queue.request('a');
    queue.request('b');
    queue.request('b');
    queue.request('a');
    await new Promise(r => setTimeout(r, 0));
    assert.equal(queue.active, 'a');
    const release = async (): Promise<void> => {
        while (gates.length === 0) await new Promise(r => setTimeout(r, 0));
        gates.shift()!();
        await new Promise(r => setTimeout(r, 0));
    };
    await release();
    await release();
    await release();
    await queue.idle();
    assert.deepEqual(runs, ['a', 'b', 'a']);
    assert.equal(maxActive, 1);
    // A waiting request can be cancelled; a running one finishes.
    queue.request('c');
    queue.request('d');
    queue.cancel('d');
    await release();
    await queue.idle();
    assert.deepEqual(runs, ['a', 'b', 'a', 'c']);
});

test('the settings of the plpgsql_check group default to what a check uses without them', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
    const group = (manifest.contributes.configuration as Array<{ title: string; properties: Record<string, { default: unknown }> }>).find(g => g.title === 'plpgsql_check');
    assert.ok(group, 'there is no plpgsql_check settings group');
    for (const [key, value] of Object.entries(DEFAULT_CHECK_SETTINGS)) {
        assert.equal(group.properties[`postgresQueryBuilder.plpgsqlCheck.${key}`]?.default, value, key);
    }
    assert.equal(group.properties['postgresQueryBuilder.plpgsqlCheck.replaceExisting']?.default, true);
});

test('the plpgsql_check settings are listed in the order of the file: when, how, what is reported, then the rest', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
    const group = (manifest.contributes.configuration as Array<{ title: string; properties: Record<string, { order?: number }> }>).find(g => g.title === 'plpgsql_check')!;
    const keys = Object.keys(group.properties).map(k => k.replace('postgresQueryBuilder.plpgsqlCheck.', ''));
    assert.deepEqual(Object.values(group.properties).map(p => p.order), keys.map((_, i) => i + 1), 'every setting has the order of its place');
    assert.deepEqual(keys.slice(0, 5), ['onSave', 'onType', 'delayMs', 'timeoutMs', 'replaceExisting']);
    assert.ok(keys.indexOf('withoutWarnings') < keys.indexOf('otherWarnings'), 'errors only comes before the kinds of warnings');
    assert.ok(keys.indexOf('extraSeverity') > keys.indexOf('compatibilityWarnings'), 'the severity follows the warnings it applies to');
});
