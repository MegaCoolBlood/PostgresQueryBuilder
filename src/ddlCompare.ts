/**
 * The structure of database objects as both sides describe it, and what
 * differs. Pure: no `vscode`, no I/O.
 *
 * The repository side is read from the statements of the SQL files —
 * `CREATE TABLE` folded with the later `ALTER TABLE`, `CREATE INDEX` and
 * `DROP INDEX` of the same table, `CREATE TYPE` with `ALTER TYPE`, and so on.
 * The database side is read from the catalog. Wherever the database can print
 * a part as SQL (`pg_get_indexdef`, `pg_get_constraintdef`,
 * `pg_get_triggerdef`), that text goes through the same parser as the
 * repository statement, so both sides are compared in the same shape.
 */
import { quoteIdentifier } from './ddlGenerator';
import {
    dollarContent,
    isPunct,
    isWord,
    matchingParen,
    normalizeTypeName,
    normalizeTypeTokens,
    readQualifiedName,
    searchPathOf,
    splitName,
    splitTopLevel,
    tokenize,
    type RepoParam,
    type Tok
} from './repositoryScanner';

export interface Difference {
    /** What the difference is about, e.g. `column mtd_von` or `index on (a, b)`. */
    path: string;
    message: string;
}

// ===== Normalisation =====

/** Words that continue a type name after `::` (`::character varying`, `::timestamp without time zone`). */
const TYPE_CONTINUATION = new Set(['varying', 'precision', 'with', 'without', 'time', 'zone']);

/** Skip a type after `::`; returns the index of the first token after it. */
function skipType(toks: Tok[], k: number): number {
    if (toks[k]?.type !== 'word' && toks[k]?.type !== 'qident') return k;
    k++;
    while (isPunct(toks[k], '.') && (toks[k + 1]?.type === 'word' || toks[k + 1]?.type === 'qident')) k += 2;
    while (toks[k]?.type === 'word' && TYPE_CONTINUATION.has(toks[k].value)) k++;
    if (isPunct(toks[k], '(')) {
        const close = matchingParen(toks, k);
        if (close > 0) k = close + 1;
    }
    while (isPunct(toks[k], '[') && isPunct(toks[k + 1], ']')) k += 2;
    return k;
}

/**
 * An expression in the shape both sides share: casts, parentheses and schema
 * qualifiers removed, words in lower case, white space irrelevant. The
 * database prints `('J'::character varying)` and `nextval('leda.seq_x'::regclass)`
 * where the repository wrote `'J'` and `nextval('seq_x')`.
 */
export function normalizeExpression(text: string): string {
    return normalizeExpressionTokens(tokenize(text));
}

/** Words that type the string literal after them: `interval '1 day'`, `date '2024-01-01'`. */
const TYPED_LITERALS = new Set(['interval', 'date', 'timestamp', 'timestamptz', 'time', 'timetz']);

const INTERVAL_UNITS: Record<string, string> = {
    year: 'year', years: 'year', mon: 'mon', mons: 'mon', month: 'mon', months: 'mon',
    day: 'day', days: 'day', week: 'week', weeks: 'week',
    hour: 'hour', hours: 'hour', min: 'minute', mins: 'minute', minute: 'minute', minutes: 'minute',
    sec: 'second', secs: 'second', second: 'second', seconds: 'second'
};

/** A one-unit interval as PostgreSQL prints it: `3 months` → `3 mons`, `1 week` → `7 days`, `2 hours` → `02:00:00`. */
export function normalizeIntervalLiteral(value: string): string | null {
    const m = /^\s*([+-]?\d+)\s*([a-z]+)\s*$/i.exec(value);
    const unit = m ? INTERVAL_UNITS[m[2].toLowerCase()] : undefined;
    if (!m || !unit) return null;
    let n = Number(m[1]);
    const pad = (x: number): string => String(Math.abs(x)).padStart(2, '0');
    const sign = n < 0 ? '-' : '';
    switch (unit) {
        case 'hour':
            return `${sign}${pad(n)}:00:00`;
        case 'minute':
            return `${sign}00:${pad(n)}:00`;
        case 'second':
            return `${sign}00:00:${pad(n)}`;
        case 'week':
            n *= 7;
            return `${n} day${Math.abs(n) === 1 ? '' : 's'}`;
        default:
            return `${n} ${unit}${Math.abs(n) === 1 ? '' : 's'}`;
    }
}

function normalizeExpressionTokens(toks: Tok[]): string {
    const out: string[] = [];
    for (let k = 0; k < toks.length; k++) {
        const t = toks[k];
        if (t.type === 'op' && t.text === '::') {
            k = skipType(toks, k + 1) - 1;
            continue;
        }
        // CAST(x AS type) is x.
        if (isWord(t, 'cast') && isPunct(toks[k + 1], '(')) {
            const close = matchingParen(toks, k + 1);
            const inner = toks.slice(k + 2, close < 0 ? toks.length : close);
            let depth = 0;
            let as = -1;
            inner.forEach((x, i) => {
                if (isPunct(x, '(')) depth++;
                else if (isPunct(x, ')')) depth--;
                else if (depth === 0 && isWord(x, 'as')) as = i;
            });
            const value = normalizeExpressionTokens(as < 0 ? inner : inner.slice(0, as));
            if (value) out.push(value);
            k = close < 0 ? toks.length : close;
            continue;
        }
        if (t.type === 'word' && TYPED_LITERALS.has(t.value) && toks[k + 1]?.type === 'string') continue;
        if (isPunct(t, '(') || isPunct(t, ')')) continue;
        if ((t.type === 'word' || t.type === 'qident') && isPunct(toks[k + 1], '.') && (toks[k + 2]?.type === 'word' || toks[k + 2]?.type === 'qident')) {
            k++;
            continue;
        }
        if (t.type === 'word') out.push(t.value);
        else if (t.type === 'qident') out.push(t.value);
        else if (t.type === 'string') {
            const prev = out[out.length - 1];
            // The sequence of nextval('…') without its schema and quotes.
            const value = prev === 'nextval' || prev === 'currval' || prev === 'setval'
                ? t.value.split('.').pop()!.replace(/"/g, '').toLowerCase()
                : normalizeIntervalLiteral(t.value) ?? t.value;
            out.push(`'${value}'`);
        } else if (t.type === 'dollar') {
            out.push(`'${dollarContent(t.text) ?? t.text}'`);
        } else {
            out.push(t.text);
        }
    }
    return out.join(' ');
}

/** A column type with its modifiers, e.g. `character varying(20)`, `numeric(10,0)`. */
export function columnType(text: string): string {
    const toks = tokenize(text);
    let base = normalizeTypeTokens(toks);
    const serials: Record<string, string> = {
        serial: 'integer', serial4: 'integer', bigserial: 'bigint', serial8: 'bigint', smallserial: 'smallint', serial2: 'smallint'
    };
    base = serials[base] ?? base;
    const open = toks.findIndex(t => isPunct(t, '('));
    let mods: string[] = [];
    if (open >= 0) {
        const close = matchingParen(toks, open);
        mods = toks.slice(open + 1, close < 0 ? toks.length : close).filter(t => t.type === 'number').map(t => t.text);
    }
    const plain = base.replace(/\[\]$/, '');
    if (mods.length === 0 && (plain === 'character' || plain === 'bit')) mods = ['1'];
    if (mods.length === 1 && plain === 'numeric') mods.push('0');
    if (mods.length === 0) return base;
    return base.endsWith('[]') ? `${plain}(${mods.join(',')})[]` : `${base}(${mods.join(',')})`;
}

/** True for `serial`, `bigserial` and their aliases. */
export function isSerialType(text: string): boolean {
    return /^(small|big)?serial[248]?$/i.test(text.trim());
}

function names(toks: Tok[]): string[] {
    return splitTopLevel(toks, t => isPunct(t, ',')).filter(p => p.length > 0).map(p => p[0].value);
}

/** A qualified name as `schema.name` (schema empty when not written). */
function qualified(toks: Tok[], k: number): { schema: string | null; name: string; next: number } | null {
    const q = readQualifiedName(toks, k);
    if (!q) return null;
    const { schema, name } = splitName(q.parts);
    return { schema, name, next: q.next };
}

/** The source text of tokens `from`..`to` (inclusive). */
function sourceOf(text: string, toks: Tok[], from: number, to: number): string {
    if (from > to || !toks[from]) return '';
    return text.slice(toks[from].start, toks[Math.min(to, toks.length - 1)].end);
}

// ===== Constraints =====

export type ForeignKeyAction = 'no action' | 'restrict' | 'cascade' | 'set null' | 'set default';

export interface ConstraintModel {
    kind: 'primary' | 'unique' | 'foreign' | 'check' | 'exclude';
    name?: string;
    columns: string[];
    refTable?: string;
    /** Empty when the repository leaves them out (then the primary key is meant). */
    refColumns?: string[];
    onDelete?: ForeignKeyAction;
    onUpdate?: ForeignKeyAction;
    expression?: string;
    /** The constraint as written, in the form `ALTER TABLE … ADD CONSTRAINT name` takes, without its name. */
    sql?: string;
}

/**
 * The source text of a run of tokens: as written, with every gap of white
 * space or comments between two tokens as one space.
 */
export function sourceText(toks: readonly Tok[]): string {
    let out = '';
    for (let i = 0; i < toks.length; i++) {
        if (i > 0 && toks[i].start > toks[i - 1].end) out += ' ';
        out += toks[i].text;
    }
    return out;
}

/** An identifier as it has to be written in SQL. */
const sqlName = quoteIdentifier;

function readAction(toks: Tok[], k: number): { action: ForeignKeyAction; next: number } {
    const w = toks[k]?.value;
    if (w === 'cascade' || w === 'restrict') return { action: w, next: k + 1 };
    if (w === 'no' && isWord(toks[k + 1], 'action')) return { action: 'no action', next: k + 2 };
    if (w === 'set' && isWord(toks[k + 1], 'null')) return { action: 'set null', next: k + 2 };
    if (w === 'set' && isWord(toks[k + 1], 'default')) return { action: 'set default', next: k + 2 };
    return { action: 'no action', next: k + 1 };
}

/**
 * One constraint, of a table or of a column (`column` is then the column it
 * belongs to). Also reads the output of `pg_get_constraintdef`.
 */
export function parseConstraint(toks: Tok[], column?: string): ConstraintModel | null {
    let k = 0;
    let name: string | undefined;
    if (isWord(toks[k], 'constraint')) {
        name = toks[k + 1]?.value;
        k += 2;
    }
    const word = toks[k]?.value;
    const parenList = (at: number): { list: string[]; next: number } => {
        if (!isPunct(toks[at], '(')) return { list: column ? [column] : [], next: at };
        const close = matchingParen(toks, at);
        return { list: names(toks.slice(at + 1, close < 0 ? toks.length : close)), next: close < 0 ? toks.length : close + 1 };
    };
    const column1 = column ? ` (${sqlName(column)})` : '';
    if (word === 'primary' && isWord(toks[k + 1], 'key')) {
        const own = isPunct(toks[k + 2], '(');
        return { kind: 'primary', name, columns: parenList(k + 2).list, sql: own ? sourceText(toks.slice(k)) : `${sourceText(toks.slice(k, k + 2))}${column1}${toks.length > k + 2 ? ` ${sourceText(toks.slice(k + 2))}` : ''}` };
    }
    if (word === 'unique') {
        let at = k + 1;
        while (toks[at]?.type === 'word' && ['nulls', 'not', 'distinct'].includes(toks[at].value)) at++;
        const own = isPunct(toks[at], '(');
        return { kind: 'unique', name, columns: parenList(at).list, sql: own ? sourceText(toks.slice(k)) : `${sourceText(toks.slice(k, at))}${column1}${toks.length > at ? ` ${sourceText(toks.slice(at))}` : ''}` };
    }
    if (word === 'check') {
        const open = k + 1;
        const close = isPunct(toks[open], '(') ? matchingParen(toks, open) : -1;
        return { kind: 'check', name, columns: column ? [column] : [], expression: normalizeExpressionTokens(toks.slice(open + 1, close < 0 ? toks.length : close)), sql: sourceText(toks.slice(k)) };
    }
    if (word === 'exclude') {
        return { kind: 'exclude', name, columns: [], expression: normalizeExpressionTokens(toks.slice(k + 1)), sql: sourceText(toks.slice(k)) };
    }
    let at = k;
    let columns = column ? [column] : [];
    if (word === 'foreign' && isWord(toks[k + 1], 'key')) {
        const list = parenList(k + 2);
        columns = list.list;
        at = list.next;
    }
    if (!isWord(toks[at], 'references')) return null;
    const ref = qualified(toks, at + 1);
    if (!ref) return null;
    const refList = isPunct(toks[ref.next], '(') ? parenList(ref.next) : { list: [], next: ref.next };
    const fk: ConstraintModel = {
        kind: 'foreign', name, columns, refTable: ref.name, refColumns: refList.list, onDelete: 'no action', onUpdate: 'no action',
        sql: word === 'foreign' ? sourceText(toks.slice(k)) : `FOREIGN KEY (${columns.map(sqlName).join(', ')}) ${sourceText(toks.slice(at))}`
    };
    for (let m = refList.next; m < toks.length; m++) {
        if (isWord(toks[m], 'on') && (isWord(toks[m + 1], 'delete') || isWord(toks[m + 1], 'update'))) {
            const { action, next } = readAction(toks, m + 2);
            if (toks[m + 1].value === 'delete') fk.onDelete = action;
            else fk.onUpdate = action;
            m = next - 1;
        }
    }
    return fk;
}

/** What makes two constraints the same, whatever their names. */
export function constraintKey(c: ConstraintModel): string {
    switch (c.kind) {
        case 'foreign':
            return `foreign(${c.columns.join(',')})->${c.refTable}`;
        case 'check':
        case 'exclude':
            return `${c.kind}:${c.expression}`;
        default:
            return `${c.kind}(${c.columns.join(',')})`;
    }
}

export function describeConstraint(c: ConstraintModel): string {
    switch (c.kind) {
        case 'primary':
            return `primary key (${c.columns.join(', ')})`;
        case 'unique':
            return `unique (${c.columns.join(', ')})`;
        case 'foreign':
            return `foreign key (${c.columns.join(', ')}) → ${c.refTable}`;
        case 'check':
            return `check (${c.expression})`;
        default:
            return `exclude ${c.expression}`;
    }
}

/** The name PostgreSQL gives a constraint the statement leaves unnamed. */
function defaultConstraintName(table: string, c: ConstraintModel): string {
    switch (c.kind) {
        case 'primary':
            return `${table}_pkey`;
        case 'unique':
            return `${table}_${c.columns.join('_')}_key`;
        case 'foreign':
            return `${table}_${c.columns.join('_')}_fkey`;
        case 'check':
            return `${table}_${c.columns[0] ?? ''}_check`.replace('__', '_');
        default:
            return `${table}_${c.columns.join('_')}_excl`;
    }
}

// ===== Indexes =====

export interface IndexModel {
    name: string;
    unique: boolean;
    method: string;
    /** Each key: column or expression, with DESC and a non-default NULLS order. */
    keys: string[];
    predicate?: string;
    /** The `CREATE INDEX` statement as written, around its table, which the script writes with its schema. */
    sql?: { head: string; tail: string };
}

/** A `CREATE INDEX` statement, also the output of `pg_get_indexdef`. */
export function parseCreateIndex(toks: Tok[]): (IndexModel & { table: { schema: string | null; name: string } }) | null {
    let k = 1;
    let unique = false;
    if (isWord(toks[k], 'unique')) {
        unique = true;
        k++;
    }
    if (!isWord(toks[k], 'index')) return null;
    k++;
    if (isWord(toks[k], 'concurrently')) k++;
    if (isWord(toks[k], 'if') && isWord(toks[k + 1], 'not') && isWord(toks[k + 2], 'exists')) k += 3;
    let name = '';
    if (!isWord(toks[k], 'on')) {
        name = toks[k]?.value ?? '';
        k++;
    }
    if (!isWord(toks[k], 'on')) return null;
    k++;
    if (isWord(toks[k], 'only')) k++;
    const tableStart = k;
    const table = qualified(toks, k);
    if (!table) return null;
    k = table.next;
    let method = 'btree';
    if (isWord(toks[k], 'using')) {
        method = toks[k + 1]?.value ?? 'btree';
        k += 2;
    }
    if (!isPunct(toks[k], '(')) return null;
    const close = matchingParen(toks, k);
    const keys = splitTopLevel(toks.slice(k + 1, close < 0 ? toks.length : close), t => isPunct(t, ',')).map(indexKey);
    let predicate: string | undefined;
    const where = toks.findIndex((t, i) => i > close && isWord(t, 'where'));
    if (where > 0) predicate = normalizeExpressionTokens(toks.slice(where + 1));
    const tableName = { schema: table.schema, name: table.name };
    const model: IndexModel & { table: { schema: string | null; name: string } } = {
        name: name || `${table.name}_${keys.map(key => key.split(' ')[0]).join('_')}_idx`,
        unique, method, keys, table: tableName
    };
    if (predicate) model.predicate = predicate;
    let end = toks.length;
    while (end > table.next && isPunct(toks[end - 1], ';')) end--;
    model.sql = { head: sourceText(toks.slice(0, tableStart)), tail: sourceText(toks.slice(table.next, end)) };
    return model;
}

function indexKey(toks: Tok[]): string {
    const words = normalizeExpressionTokens(toks).split(' ');
    // The defaults: ASC, NULLS LAST for ASC, NULLS FIRST for DESC.
    const desc = words.includes('desc');
    const out = words.filter(w => w !== 'asc');
    const text = out.join(' ');
    if (desc) return text.replace(/ nulls first$/, '');
    return text.replace(/ nulls last$/, '');
}

export function indexKeyOf(index: IndexModel): string {
    return `${index.unique ? 'unique ' : ''}${index.method}(${index.keys.join(', ')})${index.predicate ? ` where ${index.predicate}` : ''}`;
}

// ===== Tables =====

export interface ColumnModel {
    name: string;
    type: string;
    notNull: boolean;
    default: string | null;
    /** The repository wrote `serial`: any `nextval(…)` default matches. */
    serial?: boolean;
    /** The type as written. */
    typeSql?: string;
    /** The expression after DEFAULT as written. */
    defaultSql?: string;
    /** `GENERATED … AS IDENTITY` or `GENERATED ALWAYS AS (…) STORED` as written. */
    generatedSql?: string;
    /** `COLLATE …` as written. */
    collateSql?: string;
}

export interface TableModel {
    columns: ColumnModel[];
    constraints: ConstraintModel[];
    indexes: IndexModel[];
    /** Columns come from somewhere else as well (INHERITS, LIKE): columns only the database has are fine. */
    partial: boolean;
    /** PARTITION OF, OF type, AS SELECT: only existence is compared. */
    opaque: boolean;
}

const COLUMN_CONSTRAINT_START = new Set(['constraint', 'not', 'null', 'default', 'primary', 'unique', 'references', 'check', 'collate', 'generated']);

/** One column definition: `name type [constraints]`; its column constraints go to `constraints`. */
function parseColumn(toks: Tok[], constraints: ConstraintModel[]): ColumnModel | null {
    if (toks.length < 2 || (toks[0].type !== 'word' && toks[0].type !== 'qident')) return null;
    const name = toks[0].value;
    let k = 1;
    const typeStart = k;
    while (k < toks.length && !(toks[k].type === 'word' && COLUMN_CONSTRAINT_START.has(toks[k].value))) {
        if (isPunct(toks[k], '(')) {
            const close = matchingParen(toks, k);
            k = close < 0 ? toks.length : close + 1;
        } else {
            k++;
        }
    }
    const typeText = toks.slice(typeStart, k).map(t => t.text).join(' ');
    const column: ColumnModel = { name, type: columnType(typeText), notNull: false, default: null, typeSql: sourceText(toks.slice(typeStart, k)) };
    if (isSerialType(typeText)) {
        column.serial = true;
        column.notNull = true;
    }
    while (k < toks.length) {
        const w = toks[k].type === 'word' ? toks[k].value : '';
        if (w === 'constraint') {
            k += 2;
            continue;
        }
        if (w === 'not' && isWord(toks[k + 1], 'null')) {
            column.notNull = true;
            k += 2;
            continue;
        }
        if (w === 'null') {
            k++;
            continue;
        }
        // The extent of this constraint: up to the next constraint keyword at depth 0;
        // SET NULL and SET DEFAULT of a foreign key belong to it.
        let end = k + 1;
        while (end < toks.length) {
            if (isPunct(toks[end], '(')) {
                const close = matchingParen(toks, end);
                end = close < 0 ? toks.length : close + 1;
                continue;
            }
            const v = toks[end].type === 'word' ? toks[end].value : '';
            if (COLUMN_CONSTRAINT_START.has(v) && !isWord(toks[end - 1], 'set') && !isWord(toks[end - 1], 'by')) break;
            end++;
        }
        if (w === 'default') {
            const value = normalizeExpressionTokens(toks.slice(k + 1, end));
            column.default = value === '' || value === 'null' ? null : value;
            if (column.default !== null) column.defaultSql = sourceText(toks.slice(k + 1, end));
        } else if (w === 'generated') {
            column.generatedSql = sourceText(toks.slice(k, end));
            const as = toks.findIndex((t, i) => i > k && i < end && isWord(t, 'as'));
            if (as > 0 && isPunct(toks[as + 1], '(')) {
                column.default = `generated ${normalizeExpressionTokens(toks.slice(as + 2, matchingParen(toks, as + 1)))}`;
            } else {
                // GENERATED … AS IDENTITY: an identity column is NOT NULL.
                column.notNull = true;
                column.default = 'identity';
            }
        } else if (w === 'collate') {
            column.collateSql = sourceText(toks.slice(k, end));
        } else {
            const c = parseConstraint(toks.slice(k, end), name);
            if (c) {
                if (isWord(toks[k - 2], 'constraint')) c.name = toks[k - 1].value;
                if (c.kind === 'primary') column.notNull = true;
                constraints.push(c);
            }
        }
        k = end;
    }
    return column;
}

/** The structure a `CREATE TABLE` statement gives its table. */
export function parseCreateTable(toks: Tok[]): TableModel {
    const model: TableModel = { columns: [], constraints: [], indexes: [], partial: false, opaque: false };
    let k = toks.findIndex(t => isWord(t, 'table'));
    if (k < 0) return { ...model, opaque: true };
    k++;
    if (isWord(toks[k], 'if') && isWord(toks[k + 1], 'not') && isWord(toks[k + 2], 'exists')) k += 3;
    const name = qualified(toks, k);
    if (!name) return { ...model, opaque: true };
    k = name.next;
    if (!isPunct(toks[k], '(')) return { ...model, opaque: true };
    const close = matchingParen(toks, k);
    for (const part of splitTopLevel(toks.slice(k + 1, close < 0 ? toks.length : close), t => isPunct(t, ','))) {
        if (part.length === 0) continue;
        const first = part[0].type === 'word' ? part[0].value : '';
        if (first === 'like') {
            model.partial = true;
        } else if (['constraint', 'primary', 'unique', 'foreign', 'check', 'exclude'].includes(first) && part[0].type === 'word') {
            const c = parseConstraint(part);
            if (c) model.constraints.push(c);
        } else {
            const column = parseColumn(part, model.constraints);
            if (column) model.columns.push(column);
        }
    }
    if (toks.slice(close).some(t => isWord(t, 'inherits'))) model.partial = true;
    for (const c of model.constraints) {
        if (c.kind === 'primary') {
            for (const name of c.columns) {
                const column = model.columns.find(col => col.name === name);
                if (column) column.notNull = true;
            }
        }
        c.name ??= defaultConstraintName(name.name, c);
    }
    return model;
}

function cloneTable(model: TableModel): TableModel {
    return {
        columns: model.columns.map(c => ({ ...c })),
        constraints: model.constraints.map(c => ({ ...c })),
        indexes: model.indexes.map(i => ({ ...i })),
        partial: model.partial,
        opaque: model.opaque
    };
}

/** Apply one `ALTER TABLE` statement to the model; actions the comparison does not follow are skipped. */
export function applyAlterTable(model: TableModel, toks: Tok[], table: string): void {
    let k = 2;
    if (isWord(toks[k], 'if') && isWord(toks[k + 1], 'exists')) k += 2;
    if (isWord(toks[k], 'only')) k++;
    const name = qualified(toks, k);
    if (!name) return;
    for (const action of splitTopLevel(toks.slice(name.next), t => isPunct(t, ','))) {
        if (action.length === 0) continue;
        const w0 = action[0].value;
        let k2 = 1;
        if (w0 === 'add') {
            if (isWord(action[k2], 'column')) k2++;
            if (isWord(action[k2], 'if') && isWord(action[k2 + 1], 'not') && isWord(action[k2 + 2], 'exists')) k2 += 3;
            const rest = action.slice(k2);
            const first = rest[0]?.type === 'word' ? rest[0].value : '';
            if (['constraint', 'primary', 'unique', 'foreign', 'check', 'exclude'].includes(first)) {
                const c = parseConstraint(rest);
                if (c) {
                    c.name ??= defaultConstraintName(table, c);
                    model.constraints = model.constraints.filter(x => constraintKey(x) !== constraintKey(c));
                    model.constraints.push(c);
                    if (c.kind === 'primary') c.columns.forEach(n => { const col = model.columns.find(x => x.name === n); if (col) col.notNull = true; });
                }
            } else {
                const added: ConstraintModel[] = [];
                const column = parseColumn(rest, added);
                if (column && !model.columns.some(c => c.name === column.name)) {
                    model.columns.push(column);
                    for (const c of added) {
                        c.name ??= defaultConstraintName(table, c);
                        model.constraints.push(c);
                    }
                }
            }
        } else if (w0 === 'drop') {
            if (isWord(action[k2], 'constraint')) {
                k2++;
                if (isWord(action[k2], 'if') && isWord(action[k2 + 1], 'exists')) k2 += 2;
                const dropped = action[k2]?.value;
                model.constraints = model.constraints.filter(c => c.name !== dropped);
            } else {
                if (isWord(action[k2], 'column')) k2++;
                if (isWord(action[k2], 'if') && isWord(action[k2 + 1], 'exists')) k2 += 2;
                const dropped = action[k2]?.value;
                model.columns = model.columns.filter(c => c.name !== dropped);
                model.constraints = model.constraints.filter(c => !c.columns.includes(dropped ?? ''));
                model.indexes = model.indexes.filter(i => !i.keys.some(key => key.split(' ').includes(dropped ?? '')));
            }
        } else if (w0 === 'alter') {
            if (isWord(action[k2], 'column')) k2++;
            const column = model.columns.find(c => c.name === action[k2]?.value);
            const op = action.slice(k2 + 1);
            if (!column) continue;
            if (isWord(op[0], 'type') || (isWord(op[0], 'set') && isWord(op[1], 'data') && isWord(op[2], 'type'))) {
                const start = isWord(op[0], 'type') ? 1 : 3;
                const using = op.findIndex(t => isWord(t, 'using') || isWord(t, 'collate'));
                column.type = columnType(op.slice(start, using < 0 ? op.length : using).map(t => t.text).join(' '));
                column.typeSql = sourceText(op.slice(start, using < 0 ? op.length : using));
            } else if (isWord(op[0], 'set') && isWord(op[1], 'default')) {
                column.default = normalizeExpressionTokens(op.slice(2));
                column.defaultSql = sourceText(op.slice(2));
                column.serial = false;
            } else if (isWord(op[0], 'drop') && isWord(op[1], 'default')) {
                column.default = null;
                delete column.defaultSql;
                column.serial = false;
            } else if (isWord(op[0], 'set') && isWord(op[1], 'not') && isWord(op[2], 'null')) {
                column.notNull = true;
            } else if (isWord(op[0], 'drop') && isWord(op[1], 'not') && isWord(op[2], 'null')) {
                column.notNull = false;
            }
        } else if (w0 === 'rename') {
            if (isWord(action[k2], 'constraint')) {
                const c = model.constraints.find(x => x.name === action[k2 + 1]?.value);
                if (c && isWord(action[k2 + 2], 'to')) c.name = action[k2 + 3]?.value;
            } else {
                if (isWord(action[k2], 'column')) k2++;
                const from = action[k2]?.value;
                const to = isWord(action[k2 + 1], 'to') ? action[k2 + 2]?.value : undefined;
                const column = model.columns.find(c => c.name === from);
                if (column && to) {
                    column.name = to;
                    for (const c of model.constraints) c.columns = c.columns.map(n => (n === from ? to : n));
                }
            }
        }
    }
}

/** The statements of the repository that shape one table, in the order they run. */
export type TableStatement =
    | { type: 'createTable'; toks: Tok[] }
    | { type: 'alterTable'; toks: Tok[] }
    | { type: 'createIndex'; toks: Tok[] }
    | { type: 'dropIndex'; name: string };

/**
 * The models the repository allows for a table: one per `CREATE TABLE`, each
 * folded with the statements that follow it up to the next `CREATE TABLE`.
 */
export function tableModels(statements: readonly TableStatement[], table: string): TableModel[] {
    const models: TableModel[] = [];
    let current: TableModel | null = null;
    for (const stmt of statements) {
        if (stmt.type === 'createTable') {
            if (current) models.push(current);
            current = parseCreateTable(stmt.toks);
            continue;
        }
        if (!current) continue;
        if (stmt.type === 'alterTable') {
            applyAlterTable(current, stmt.toks, table);
        } else if (stmt.type === 'createIndex') {
            const index = parseCreateIndex(stmt.toks);
            if (index) {
                const { table: _table, ...model } = index;
                current.indexes = current.indexes.filter(i => i.name !== model.name && indexKeyOf(i) !== indexKeyOf(model));
                current.indexes.push(model);
            }
        } else {
            current.indexes = current.indexes.filter(i => i.name !== stmt.name);
        }
    }
    if (current) models.push(current);
    return models.map(cloneTable);
}

export function defaultsEqual(repo: ColumnModel, db: ColumnModel): boolean {
    if (repo.serial && (db.default ?? '').startsWith('nextval')) return true;
    if (repo.default === db.default) return true;
    if (repo.default === null && db.default === 'null') return true;
    if (repo.default === 'identity' && db.default === 'identity') return true;
    return false;
}

/** Two foreign keys of the same columns and table point at the same columns; a side that leaves them out means the primary key. */
export function foreignKeysMatch(a: ConstraintModel, b: ConstraintModel): boolean {
    return !a.refColumns?.length || !b.refColumns?.length || a.refColumns.join(',') === b.refColumns.join(',');
}

/** What differs between the repository's model of a table and the database. */
export function compareTables(repo: TableModel, db: TableModel, options: { columnOrder?: boolean } = {}): Difference[] {
    if (repo.opaque) return [];
    const out: Difference[] = [];
    for (const column of repo.columns) {
        const other = db.columns.find(c => c.name === column.name);
        const path = `column ${column.name}`;
        if (!other) {
            out.push({ path, message: 'missing in the database' });
            continue;
        }
        if (column.type !== other.type) out.push({ path, message: `type ${column.type} in the repository, ${other.type} in the database` });
        if (column.notNull !== other.notNull) out.push({ path, message: column.notNull ? 'NOT NULL in the repository only' : 'NOT NULL in the database only' });
        if (!defaultsEqual(column, other)) {
            out.push({ path, message: `default ${column.default ?? 'none'} in the repository, ${other.default ?? 'none'} in the database` });
        }
    }
    if (!repo.partial) {
        for (const column of db.columns) {
            if (!repo.columns.some(c => c.name === column.name)) out.push({ path: `column ${column.name}`, message: 'missing in the repository' });
        }
        if (options.columnOrder) {
            const repoOrder = repo.columns.map(c => c.name).filter(n => db.columns.some(c => c.name === n));
            const dbOrder = db.columns.map(c => c.name).filter(n => repoOrder.includes(n));
            if (repoOrder.join(',') !== dbOrder.join(',')) out.push({ path: 'columns', message: 'the columns are in another order' });
        }
    }
    const fkMatches = foreignKeysMatch;
    for (const c of repo.constraints) {
        const other = db.constraints.find(x => constraintKey(x) === constraintKey(c) && (c.kind !== 'foreign' || fkMatches(c, x)));
        const path = describeConstraint(c);
        if (!other) {
            out.push({ path, message: 'missing in the database' });
            continue;
        }
        if (c.kind === 'foreign' && (c.onDelete !== other.onDelete || c.onUpdate !== other.onUpdate)) {
            out.push({ path, message: `ON DELETE ${c.onDelete} / ON UPDATE ${c.onUpdate} in the repository, ${other.onDelete} / ${other.onUpdate} in the database` });
        }
    }
    for (const c of db.constraints) {
        if (!repo.constraints.some(x => constraintKey(x) === constraintKey(c))) out.push({ path: describeConstraint(c), message: 'missing in the repository' });
    }
    for (const index of repo.indexes) {
        if (!db.indexes.some(i => indexKeyOf(i) === indexKeyOf(index))) out.push({ path: `index ${index.name}`, message: `${indexKeyOf(index)} is missing in the database` });
    }
    for (const index of db.indexes) {
        if (!repo.indexes.some(i => indexKeyOf(i) === indexKeyOf(index))) out.push({ path: `index ${index.name}`, message: `${indexKeyOf(index)} is missing in the repository` });
    }
    return out;
}

// ===== Types and domains =====

export type TypeModel =
    | { flavour: 'enum'; labels: string[] }
    | { flavour: 'composite'; attributes: Array<{ name: string; type: string }> }
    | { flavour: 'range'; subtype: string }
    | { flavour: 'domain'; base: string; notNull: boolean; default: string | null; checks: string[] }
    | { flavour: 'other' };

/** `CREATE TYPE` or `CREATE DOMAIN`. */
export function parseCreateType(toks: Tok[]): TypeModel {
    const domain = toks.findIndex(t => isWord(t, 'domain'));
    if (domain > 0 && domain <= 3) return parseCreateDomain(toks, domain);
    const as = toks.findIndex(t => isWord(t, 'as'));
    if (as < 0) return { flavour: 'other' };
    if (isWord(toks[as + 1], 'enum') && isPunct(toks[as + 2], '(')) {
        const close = matchingParen(toks, as + 2);
        return { flavour: 'enum', labels: toks.slice(as + 3, close).filter(t => t.type === 'string').map(t => t.value) };
    }
    if (isWord(toks[as + 1], 'range')) {
        const sub = toks.findIndex((t, i) => i > as && isWord(t, 'subtype'));
        const end = toks.findIndex((t, i) => i > sub + 1 && (isPunct(t, ',') || isPunct(t, ')')));
        return { flavour: 'range', subtype: columnType(toks.slice(sub + 2, end < 0 ? toks.length : end).map(t => t.text).join(' ')) };
    }
    if (isPunct(toks[as + 1], '(')) {
        const close = matchingParen(toks, as + 1);
        const attributes = splitTopLevel(toks.slice(as + 2, close), t => isPunct(t, ','))
            .filter(p => p.length >= 2)
            .map(p => {
                const collate = p.findIndex(t => isWord(t, 'collate'));
                return { name: p[0].value, type: columnType(p.slice(1, collate < 0 ? p.length : collate).map(t => t.text).join(' ')) };
            });
        return { flavour: 'composite', attributes };
    }
    return { flavour: 'other' };
}

function parseCreateDomain(toks: Tok[], at: number): TypeModel {
    const name = qualified(toks, at + 1);
    if (!name) return { flavour: 'other' };
    let k = name.next;
    if (isWord(toks[k], 'as')) k++;
    const typeStart = k;
    while (k < toks.length && !(toks[k].type === 'word' && ['collate', 'default', 'constraint', 'not', 'null', 'check'].includes(toks[k].value))) {
        if (isPunct(toks[k], '(')) {
            const close = matchingParen(toks, k);
            k = close < 0 ? toks.length : close + 1;
        } else {
            k++;
        }
    }
    const model = { flavour: 'domain' as const, base: columnType(toks.slice(typeStart, k).map(t => t.text).join(' ')), notNull: false, default: null as string | null, checks: [] as string[] };
    while (k < toks.length) {
        const w = toks[k].value;
        if (w === 'constraint') {
            k += 2;
        } else if (w === 'not' && isWord(toks[k + 1], 'null')) {
            model.notNull = true;
            k += 2;
        } else if (w === 'null' || w === 'collate') {
            k += w === 'collate' ? 2 : 1;
        } else if (w === 'default') {
            let end = k + 1;
            while (end < toks.length && !(toks[end].type === 'word' && ['constraint', 'not', 'null', 'check'].includes(toks[end].value))) {
                end = isPunct(toks[end], '(') ? Math.max(matchingParen(toks, end), end) + 1 : end + 1;
            }
            model.default = normalizeExpressionTokens(toks.slice(k + 1, end));
            k = end;
        } else if (w === 'check' && isPunct(toks[k + 1], '(')) {
            const close = matchingParen(toks, k + 1);
            model.checks.push(normalizeExpressionTokens(toks.slice(k + 2, close)));
            k = close + 1;
        } else {
            k++;
        }
    }
    return model;
}

/** Apply `ALTER TYPE` / `ALTER DOMAIN` to a model. */
export function applyAlterType(model: TypeModel, toks: Tok[]): TypeModel {
    const domain = isWord(toks[1], 'domain');
    const name = qualified(toks, 2);
    if (!name) return model;
    const rest = toks.slice(name.next);
    if (model.flavour === 'enum' && isWord(rest[0], 'add') && isWord(rest[1], 'value')) {
        let k = 2;
        if (isWord(rest[k], 'if') && isWord(rest[k + 1], 'not') && isWord(rest[k + 2], 'exists')) k += 3;
        const label = rest[k]?.value;
        if (label === undefined || model.labels.includes(label)) return model;
        const labels = [...model.labels];
        const anchor = labels.indexOf(rest[k + 2]?.value ?? '');
        if (isWord(rest[k + 1], 'before') && anchor >= 0) labels.splice(anchor, 0, label);
        else if (isWord(rest[k + 1], 'after') && anchor >= 0) labels.splice(anchor + 1, 0, label);
        else labels.push(label);
        return { flavour: 'enum', labels };
    }
    if (model.flavour === 'enum' && isWord(rest[0], 'rename') && isWord(rest[1], 'value')) {
        return { flavour: 'enum', labels: model.labels.map(l => (l === rest[2]?.value ? rest[4]?.value ?? l : l)) };
    }
    if (model.flavour === 'composite') {
        let attributes = [...model.attributes];
        for (const action of splitTopLevel(rest, t => isPunct(t, ','))) {
            const w = action[0]?.value;
            if (w === 'add' && isWord(action[1], 'attribute')) {
                attributes.push({ name: action[2]?.value ?? '', type: columnType(action.slice(3).filter(t => !isWord(t, 'cascade') && !isWord(t, 'restrict')).map(t => t.text).join(' ')) });
            } else if (w === 'drop' && isWord(action[1], 'attribute')) {
                const k = isWord(action[2], 'if') ? 4 : 2;
                attributes = attributes.filter(a => a.name !== action[k]?.value);
            } else if (w === 'alter' && isWord(action[1], 'attribute')) {
                const typeAt = action.findIndex(t => isWord(t, 'type'));
                const attr = attributes.find(a => a.name === action[2]?.value);
                if (attr && typeAt > 0) attr.type = columnType(action.slice(typeAt + 1).filter(t => !isWord(t, 'cascade') && !isWord(t, 'restrict')).map(t => t.text).join(' '));
            } else if (w === 'rename' && isWord(action[1], 'attribute')) {
                const attr = attributes.find(a => a.name === action[2]?.value);
                if (attr && isWord(action[3], 'to')) attr.name = action[4]?.value ?? attr.name;
            }
        }
        return { flavour: 'composite', attributes };
    }
    if (domain && model.flavour === 'domain') {
        const next = { ...model, checks: [...model.checks] };
        if (isWord(rest[0], 'set') && isWord(rest[1], 'default')) next.default = normalizeExpressionTokens(rest.slice(2));
        else if (isWord(rest[0], 'drop') && isWord(rest[1], 'default')) next.default = null;
        else if (isWord(rest[0], 'set') && isWord(rest[1], 'not') && isWord(rest[2], 'null')) next.notNull = true;
        else if (isWord(rest[0], 'drop') && isWord(rest[1], 'not') && isWord(rest[2], 'null')) next.notNull = false;
        else if (isWord(rest[0], 'add')) {
            const check = rest.findIndex(t => isWord(t, 'check'));
            if (check > 0 && isPunct(rest[check + 1], '(')) next.checks.push(normalizeExpressionTokens(rest.slice(check + 2, matchingParen(rest, check + 1))));
        }
        return next;
    }
    return model;
}

export function compareTypes(repo: TypeModel, db: TypeModel): Difference[] {
    if (repo.flavour === 'other' || db.flavour === 'other') return [];
    if (repo.flavour !== db.flavour) return [{ path: 'kind', message: `${repo.flavour} in the repository, ${db.flavour} in the database` }];
    const out: Difference[] = [];
    if (repo.flavour === 'enum' && db.flavour === 'enum') {
        for (const l of repo.labels) if (!db.labels.includes(l)) out.push({ path: `value '${l}'`, message: 'missing in the database' });
        for (const l of db.labels) if (!repo.labels.includes(l)) out.push({ path: `value '${l}'`, message: 'missing in the repository' });
        if (out.length === 0 && repo.labels.join('\u0000') !== db.labels.join('\u0000')) out.push({ path: 'values', message: `order ${repo.labels.join(', ')} in the repository, ${db.labels.join(', ')} in the database` });
    } else if (repo.flavour === 'composite' && db.flavour === 'composite') {
        for (const a of repo.attributes) {
            const other = db.attributes.find(x => x.name === a.name);
            if (!other) out.push({ path: `attribute ${a.name}`, message: 'missing in the database' });
            else if (other.type !== a.type) out.push({ path: `attribute ${a.name}`, message: `type ${a.type} in the repository, ${other.type} in the database` });
        }
        for (const a of db.attributes) if (!repo.attributes.some(x => x.name === a.name)) out.push({ path: `attribute ${a.name}`, message: 'missing in the repository' });
    } else if (repo.flavour === 'range' && db.flavour === 'range') {
        if (repo.subtype !== db.subtype) out.push({ path: 'subtype', message: `${repo.subtype} in the repository, ${db.subtype} in the database` });
    } else if (repo.flavour === 'domain' && db.flavour === 'domain') {
        if (repo.base !== db.base) out.push({ path: 'base type', message: `${repo.base} in the repository, ${db.base} in the database` });
        if (repo.notNull !== db.notNull) out.push({ path: 'NOT NULL', message: repo.notNull ? 'in the repository only' : 'in the database only' });
        if ((repo.default ?? null) !== (db.default ?? null)) out.push({ path: 'default', message: `${repo.default ?? 'none'} in the repository, ${db.default ?? 'none'} in the database` });
        for (const c of repo.checks) if (!db.checks.includes(c)) out.push({ path: `check (${c})`, message: 'missing in the database' });
        for (const c of db.checks) if (!repo.checks.includes(c)) out.push({ path: `check (${c})`, message: 'missing in the repository' });
    }
    return out;
}

// ===== Sequences =====

export interface SequenceModel {
    type: string;
    increment: string;
    min: string;
    max: string;
    start: string;
    cache: string;
    cycle: boolean;
}

const TYPE_LIMITS: Record<string, [string, string]> = {
    smallint: ['32767', '-32768'],
    integer: ['2147483647', '-2147483648'],
    bigint: ['9223372036854775807', '-9223372036854775808']
};

interface SequenceOptions {
    type?: string;
    increment?: string;
    min?: string | null;
    max?: string | null;
    start?: string;
    cache?: string;
    cycle?: boolean;
}

function readNumber(toks: Tok[], k: number): { value: string; next: number } {
    if (toks[k]?.type === 'op' && toks[k].text === '-' && toks[k + 1]?.type === 'number') return { value: `-${toks[k + 1].text}`, next: k + 2 };
    if (toks[k]?.type === 'op' && toks[k].text === '+') k++;
    return { value: toks[k]?.text ?? '', next: k + 1 };
}

/** The options of `CREATE SEQUENCE` / `ALTER SEQUENCE`; `RESTART` and `OWNED BY` are not compared. */
export function parseSequenceOptions(toks: Tok[], from: number): SequenceOptions {
    const o: SequenceOptions = {};
    for (let k = from; k < toks.length;) {
        const w = toks[k].value;
        if (w === 'as') {
            o.type = normalizeTypeName(toks[k + 1]?.text ?? '');
            k += 2;
        } else if (w === 'increment') {
            k += isWord(toks[k + 1], 'by') ? 2 : 1;
            const n = readNumber(toks, k);
            o.increment = n.value;
            k = n.next;
        } else if (w === 'minvalue' || w === 'maxvalue') {
            const n = readNumber(toks, k + 1);
            if (w === 'minvalue') o.min = n.value;
            else o.max = n.value;
            k = n.next;
        } else if (w === 'no' && (isWord(toks[k + 1], 'minvalue') || isWord(toks[k + 1], 'maxvalue') || isWord(toks[k + 1], 'cycle'))) {
            const what = toks[k + 1].value;
            if (what === 'minvalue') o.min = null;
            else if (what === 'maxvalue') o.max = null;
            else o.cycle = false;
            k += 2;
        } else if (w === 'start') {
            k += isWord(toks[k + 1], 'with') ? 2 : 1;
            const n = readNumber(toks, k);
            o.start = n.value;
            k = n.next;
        } else if (w === 'cache') {
            const n = readNumber(toks, k + 1);
            o.cache = n.value;
            k = n.next;
        } else if (w === 'cycle') {
            o.cycle = true;
            k++;
        } else if (w === 'restart') {
            k += isWord(toks[k + 1], 'with') ? 3 : toks[k + 1]?.type === 'number' ? 2 : 1;
        } else if (w === 'owned') {
            k = toks.length;
        } else {
            k++;
        }
    }
    return o;
}

/** The sequence a chain of `CREATE SEQUENCE` and `ALTER SEQUENCE` options gives, with PostgreSQL's defaults filled in. */
export function sequenceModel(options: readonly SequenceOptions[]): SequenceModel {
    const o: SequenceOptions = {};
    for (const next of options) {
        for (const [key, value] of Object.entries(next)) (o as Record<string, unknown>)[key] = value;
    }
    const type = o.type ?? 'bigint';
    const increment = o.increment ?? '1';
    const ascending = !increment.startsWith('-');
    const [typeMax, typeMin] = TYPE_LIMITS[type] ?? TYPE_LIMITS.bigint;
    const min = o.min ?? (ascending ? '1' : typeMin);
    const max = o.max ?? (ascending ? typeMax : '-1');
    return { type, increment, min, max, start: o.start ?? (ascending ? min : max), cache: o.cache ?? '1', cycle: o.cycle ?? false };
}

export function compareSequences(repo: SequenceModel, db: SequenceModel): Difference[] {
    const out: Difference[] = [];
    for (const key of ['type', 'increment', 'min', 'max', 'start', 'cache', 'cycle'] as const) {
        if (String(repo[key]) !== String(db[key])) out.push({ path: key, message: `${repo[key]} in the repository, ${db[key]} in the database` });
    }
    return out;
}

// ===== Triggers =====

export interface TriggerModel {
    timing: string;
    events: string[];
    level: 'row' | 'statement';
    when?: string;
    func: string;
    args: string;
}

/** A `CREATE TRIGGER` statement, also the output of `pg_get_triggerdef`. */
export function parseCreateTrigger(toks: Tok[]): (TriggerModel & { name: string; table: { schema: string | null; name: string } }) | null {
    const at = toks.findIndex(t => isWord(t, 'trigger'));
    if (at < 0) return null;
    const name = toks[at + 1]?.value ?? '';
    let k = at + 2;
    let timing = toks[k]?.value ?? '';
    if (timing === 'instead') {
        timing = 'instead of';
        k += 2;
    } else {
        k++;
    }
    const events: string[] = [];
    while (k < toks.length && !isWord(toks[k], 'on')) {
        const w = toks[k].value;
        if (['insert', 'update', 'delete', 'truncate'].includes(w)) {
            if (w === 'update' && isWord(toks[k + 1], 'of')) {
                const cols: string[] = [];
                k += 2;
                while (k < toks.length && !isWord(toks[k], 'or') && !isWord(toks[k], 'on')) {
                    if (toks[k].type === 'word' || toks[k].type === 'qident') cols.push(toks[k].value);
                    k++;
                }
                events.push(`update of ${cols.sort().join(',')}`);
                continue;
            }
            events.push(w);
        }
        k++;
    }
    const table = qualified(toks, k + 1);
    if (!table) return null;
    let level: 'row' | 'statement' = 'statement';
    const each = toks.findIndex((t, i) => i >= table.next && isWord(t, 'for'));
    if (each > 0) {
        const w = isWord(toks[each + 1], 'each') ? toks[each + 2] : toks[each + 1];
        if (isWord(w, 'row')) level = 'row';
    }
    let when: string | undefined;
    const whenAt = toks.findIndex((t, i) => i >= table.next && isWord(t, 'when'));
    if (whenAt > 0 && isPunct(toks[whenAt + 1], '(')) when = normalizeExpressionTokens(toks.slice(whenAt + 2, matchingParen(toks, whenAt + 1)));
    const exec = toks.findIndex((t, i) => i >= table.next && isWord(t, 'execute'));
    const fn = exec > 0 ? qualified(toks, exec + 2) : null;
    let args = '';
    if (fn && isPunct(toks[fn.next], '(')) {
        args = toks.slice(fn.next + 1, matchingParen(toks, fn.next)).filter(t => !isPunct(t, ',')).map(t => (t.type === 'string' ? t.value : t.text.toLowerCase())).join(',');
    }
    const model = { name, table: { schema: table.schema, name: table.name }, timing, events: events.sort(), level, func: fn?.name ?? '', args } as TriggerModel & { name: string; table: { schema: string | null; name: string } };
    if (when) model.when = when;
    return model;
}

export function compareTriggers(repo: TriggerModel, db: TriggerModel): Difference[] {
    const out: Difference[] = [];
    if (repo.timing !== db.timing) out.push({ path: 'timing', message: `${repo.timing} in the repository, ${db.timing} in the database` });
    if (repo.events.join(' or ') !== db.events.join(' or ')) out.push({ path: 'events', message: `${repo.events.join(' or ')} in the repository, ${db.events.join(' or ')} in the database` });
    if (repo.level !== db.level) out.push({ path: 'level', message: `for each ${repo.level} in the repository, for each ${db.level} in the database` });
    if ((repo.when ?? '') !== (db.when ?? '')) out.push({ path: 'when', message: `${repo.when ?? 'none'} in the repository, ${db.when ?? 'none'} in the database` });
    if (repo.func !== db.func || repo.args !== db.args) out.push({ path: 'function', message: `${repo.func}(${repo.args}) in the repository, ${db.func}(${db.args}) in the database` });
    return out;
}

// ===== Routines =====

function normalizeDefault(value: string | null): string | null {
    return value === null ? null : normalizeExpression(value);
}

/** The result of a function in a comparable shape: `setof integer`, `table(a integer, b text)`, `integer`. */
export function normalizeReturns(text: string): string {
    const trimmed = text.trim();
    if (/^setof\s/i.test(trimmed)) return `setof ${normalizeTypeName(trimmed.slice(6))}`;
    if (/^table\s*\(/i.test(trimmed)) {
        const toks = tokenize(trimmed);
        const close = matchingParen(toks, 1);
        const cols = splitTopLevel(toks.slice(2, close < 0 ? toks.length : close), t => isPunct(t, ','))
            .map(p => `${p[0]?.value ?? ''} ${normalizeTypeTokens(p.slice(1))}`);
        return `table(${cols.join(', ')})`;
    }
    return normalizeTypeName(trimmed);
}

/** Differences of names, modes, types and defaults of the parameters, and of the result. */
export function compareSignatures(
    repo: { params: readonly RepoParam[]; returns?: string },
    db: { params: readonly RepoParam[]; returns?: string | null }
): Difference[] {
    const out: Difference[] = [];
    const count = Math.max(repo.params.length, db.params.length);
    for (let i = 0; i < count; i++) {
        const a = repo.params[i];
        const b = db.params[i];
        const path = `parameter ${i + 1}${a?.name || b?.name ? ` ${a?.name ?? b?.name}` : ''}`;
        if (!a) {
            out.push({ path, message: 'missing in the repository' });
            continue;
        }
        if (!b) {
            out.push({ path, message: 'missing in the database' });
            continue;
        }
        if ((a.name ?? '') !== (b.name ?? '')) out.push({ path, message: `named ${a.name ?? '(none)'} in the repository, ${b.name ?? '(none)'} in the database` });
        if (a.mode !== b.mode) out.push({ path, message: `${a.mode.toUpperCase()} in the repository, ${b.mode.toUpperCase()} in the database` });
        const ta = normalizeTypeName(a.type);
        const tb = normalizeTypeName(b.type);
        if (ta !== '?' && ta !== tb) out.push({ path, message: `type ${ta} in the repository, ${tb} in the database` });
        const da = normalizeDefault(a.defaultValue);
        const dbDefault = normalizeDefault(b.defaultValue);
        if (da !== dbDefault) out.push({ path, message: `default ${da ?? 'none'} in the repository, ${dbDefault ?? 'none'} in the database` });
    }
    if (repo.returns !== undefined && db.returns) {
        const ra = normalizeReturns(repo.returns);
        const rb = normalizeReturns(db.returns);
        if (ra !== rb) out.push({ path: 'result', message: `${ra} in the repository, ${rb} in the database` });
    }
    return out;
}

// ===== Views =====

/** The query of a `CREATE VIEW` or `CREATE MATERIALIZED VIEW` statement, with its column list. */
export function viewQuery(text: string): { columns: string | null; query: string } | null {
    const toks = tokenize(text);
    const view = toks.findIndex(t => isWord(t, 'view'));
    if (view < 0) return null;
    let k = view + 1;
    if (isWord(toks[k], 'if') && isWord(toks[k + 1], 'not') && isWord(toks[k + 2], 'exists')) k += 3;
    const name = qualified(toks, k);
    if (!name) return null;
    k = name.next;
    let columns: string | null = null;
    if (isPunct(toks[k], '(')) {
        const close = matchingParen(toks, k);
        columns = text.slice(toks[k].start, toks[close].end);
        k = close + 1;
    }
    while (k < toks.length && !isWord(toks[k], 'as')) {
        if (isPunct(toks[k], '(')) k = matchingParen(toks, k);
        k++;
    }
    if (k >= toks.length) return null;
    let end = toks.length - 1;
    // WITH [CASCADED | LOCAL] CHECK OPTION, WITH [NO] DATA at the end.
    if (isWord(toks[end], 'option') && isWord(toks[end - 1], 'check')) {
        end -= 2;
        if (isWord(toks[end], 'cascaded') || isWord(toks[end], 'local')) end--;
        if (isWord(toks[end], 'with')) end--;
    } else if (isWord(toks[end], 'data')) {
        end--;
        if (isWord(toks[end], 'no')) end--;
        if (isWord(toks[end], 'with')) end--;
    }
    return { columns, query: sourceOf(text, toks, k + 1, end) };
}

/**
 * Two view definitions printed by `pg_get_viewdef` are the same, apart from
 * white space and parentheses: `a AND b AND c` written once as `a AND (b AND c)`
 * prints its own parentheses.
 */
export function sameViewDefinition(a: string, b: string): boolean {
    const norm = (s: string): string => tokenize(s).filter(t => !isPunct(t, '(') && !isPunct(t, ')')).map(t => (t.type === 'word' ? t.value : t.text)).join(' ');
    return norm(a) === norm(b);
}

// ===== Statements of the repository =====

export type StructureKind = 'createTable' | 'alterTable' | 'createIndex' | 'dropIndex' | 'createView' | 'createType' | 'alterType' | 'createSequence' | 'alterSequence' | 'createTrigger';

export interface StructureStatement {
    type: StructureKind;
    /** As written; null when unqualified. */
    schema: string | null;
    name: string;
    /** The table of a trigger or an index. */
    table?: { schema: string | null; name: string };
    searchPath: string[] | null;
    /** The statement's source text. */
    text: string;
    /** Where the statement starts in its file, for the order. */
    offset: number;
}

const TYPE_OF: Record<string, StructureKind> = {};

/** One statement's structure kind and name, or null for a statement the comparison does not need. */
function classifyStatement(toks: Tok[]): Omit<StructureStatement, 'searchPath' | 'text' | 'offset'> | null {
    const w0 = toks[0]?.value;
    if (w0 === 'create') {
        let k = 1;
        if (isWord(toks[k], 'or') && isWord(toks[k + 1], 'replace')) k += 2;
        let materialized = false;
        while (toks[k]?.type === 'word' && ['unique', 'temp', 'temporary', 'unlogged', 'materialized', 'recursive', 'constraint', 'global', 'local'].includes(toks[k].value)) {
            if (toks[k].value === 'temp' || toks[k].value === 'temporary') return null;
            if (toks[k].value === 'materialized') materialized = true;
            k++;
        }
        const kind = toks[k]?.value;
        if (kind === 'index') {
            const index = parseCreateIndex(toks);
            return index ? { type: 'createIndex', schema: index.table.schema, name: index.name, table: index.table } : null;
        }
        if (kind === 'trigger') {
            const trigger = parseCreateTrigger(toks);
            return trigger ? { type: 'createTrigger', schema: trigger.table.schema, name: trigger.name, table: trigger.table } : null;
        }
        k++;
        if (isWord(toks[k], 'if') && isWord(toks[k + 1], 'not') && isWord(toks[k + 2], 'exists')) k += 3;
        const name = qualified(toks, k);
        if (!name) return null;
        if (kind === 'table') return { type: 'createTable', schema: name.schema, name: name.name };
        if (kind === 'view') return { type: 'createView', schema: name.schema, name: name.name, ...(materialized ? { table: { schema: null, name: 'materialized' } } : {}) };
        if (kind === 'type' || kind === 'domain') return { type: 'createType', schema: name.schema, name: name.name };
        if (kind === 'sequence') return { type: 'createSequence', schema: name.schema, name: name.name };
        return null;
    }
    if (w0 === 'alter') {
        const kind = toks[1]?.value;
        let k = 2;
        if (isWord(toks[k], 'if') && isWord(toks[k + 1], 'exists')) k += 2;
        if (isWord(toks[k], 'only')) k++;
        const name = qualified(toks, k);
        if (!name) return null;
        if (kind === 'table') return { type: 'alterTable', schema: name.schema, name: name.name };
        if (kind === 'type' || kind === 'domain') return { type: 'alterType', schema: name.schema, name: name.name };
        if (kind === 'sequence') return { type: 'alterSequence', schema: name.schema, name: name.name };
        return null;
    }
    if (w0 === 'drop' && isWord(toks[1], 'index')) {
        let k = 2;
        if (isWord(toks[k], 'concurrently')) k++;
        if (isWord(toks[k], 'if') && isWord(toks[k + 1], 'exists')) k += 2;
        const name = qualified(toks, k);
        return name ? { type: 'dropIndex', schema: name.schema, name: name.name } : null;
    }
    return null;
}
void TYPE_OF;

/**
 * The statements of a SQL file that shape tables, views, types, sequences and
 * triggers, in source order — also those of `DO` blocks. Function bodies are
 * not read: what they create runs only when they are called.
 */
export function scanStructure(text: string): StructureStatement[] {
    const out: StructureStatement[] = [];
    const visit = (src: string, base: number, searchPath: { value: string[] | null }): void => {
        const toks = tokenize(src);
        for (const stmt of splitTopLevel(toks, t => isPunct(t, ';'))) {
            if (stmt.length === 0) continue;
            const path = searchPathOf(stmt);
            if (path !== undefined) {
                searchPath.value = path;
                continue;
            }
            if (isWord(stmt[0], 'do')) {
                const body = stmt.find(t => t.type === 'dollar');
                const inner = body ? dollarContent(body.text) : null;
                if (body && inner !== null) {
                    const innerBase = base + body.start + (body.text.length - inner.length) / 2;
                    // Statements inside BEGIN … END follow BEGIN, THEN or ELSE.
                    const innerToks = tokenize(inner);
                    for (const part of splitTopLevel(innerToks, t => isPunct(t, ';'))) {
                        const at = part.findIndex(t => isWord(t, 'create') || isWord(t, 'alter') || (isWord(t, 'drop') && isWord(part[part.indexOf(t) + 1], 'index')));
                        if (at < 0) continue;
                        const sub = part.slice(at);
                        const found = classifyStatement(sub);
                        if (found) {
                            out.push({ ...found, searchPath: searchPath.value, text: inner.slice(sub[0].start, sub[sub.length - 1].end), offset: innerBase + sub[0].start });
                        }
                    }
                }
                continue;
            }
            const found = classifyStatement(stmt);
            if (found) out.push({ ...found, searchPath: searchPath.value, text: src.slice(stmt[0].start, stmt[stmt.length - 1].end), offset: base + stmt[0].start });
        }
    };
    visit(text, 0, { value: null });
    return out;
}

/** Tokens of a statement text. */
export function statementTokens(text: string): Tok[] {
    return tokenize(text);
}
