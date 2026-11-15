import './helpers/vscodeMock';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    DEFAULT_CHECK_SETTINGS,
    SingleFlightQueue,
    bodyLine,
    buildCheckCall,
    checkTargets,
    creationFinding,
    findingOf,
    offsetAt,
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
});
