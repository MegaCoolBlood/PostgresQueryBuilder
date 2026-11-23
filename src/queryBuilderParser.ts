/**
 * Reads SQL into the Query Builder model (`queryBuilderModel.ts`) with the
 * real PostgreSQL parser: libpg-query, a WebAssembly build of libpg_query.
 *
 * The parser is loaded lazily on first use and only once. Unbundled (tests,
 * `out/`) it reads `node_modules/libpg-query/wasm/libpg-query.wasm`; in the
 * esbuild bundle its loader looks for `libpg-query.wasm` next to
 * `dist/extension.js`, where esbuild.js copies it.
 *
 * The AST gives the structure; the text of every expression is cut out of the
 * source (via the AST byte locations and a token scan), so the user's
 * formatting, casing and comments inside expressions survive a round trip.
 */
import {
    aggregatedExpression,
    createEmptyModel,
    normalizeExpressionKey,
    tokenizeSql,
    type QbAggregate,
    type QbColumn,
    type QbJoin,
    type QbJoinType,
    type QbTable,
    type QueryModel,
    type SqlToken
} from './queryBuilderModel';

// libpg-query returns plain JSON; its node shapes are a third-party format.
type AstNode = { [key: string]: any };

export interface PgStatement {
    stmt: AstNode;
    /** Byte offset of the statement in the parsed text. */
    stmt_location?: number;
    /** Byte length of the statement; 0 or missing = up to the end. */
    stmt_len?: number;
}

export interface PgParseResult {
    version: number;
    stmts: PgStatement[];
}

/** A syntax error reported by the PostgreSQL parser. */
export class SqlParseError extends Error {
    /** 0-based character position of the error, when the parser reports one. */
    readonly position?: number;

    constructor(message: string, position?: number) {
        super(message);
        this.name = 'SqlParseError';
        this.position = position;
    }
}

type PgQueryModule = {
    loadModule(): Promise<void>;
    parse(query: string): Promise<unknown>;
};

let parserModule: Promise<PgQueryModule> | undefined;

/** Load the WebAssembly parser once; a failed load is retried on the next call. */
export function loadPostgresParser(): Promise<PgQueryModule> {
    if (!parserModule) {
        const loading = (async () => {
            const mod = (await import('libpg-query')) as unknown as PgQueryModule;
            await mod.loadModule();
            return mod;
        })();
        parserModule = loading;
        loading.catch(() => {
            if (parserModule === loading) parserModule = undefined;
        });
    }
    return parserModule;
}

/** Parse SQL into the libpg_query JSON parse tree. */
export async function parseSql(sql: string): Promise<PgParseResult> {
    const mod = await loadPostgresParser();
    try {
        return (await mod.parse(sql)) as PgParseResult;
    } catch (err: unknown) {
        const details = (err as { sqlDetails?: { cursorPosition?: number } } | undefined)?.sqlDetails;
        const message = err instanceof Error ? err.message : String(err);
        if (details && typeof details.cursorPosition === 'number') {
            throw new SqlParseError(`Syntax error at position ${details.cursorPosition + 1}: ${message}`, details.cursorPosition);
        }
        throw new SqlParseError(message);
    }
}

/**
 * Parse a SELECT statement into a Query Builder model. Throws a clear error
 * for anything but a single SELECT. Parts the diagram cannot show are kept as
 * raw SQL text and listed in `warnings`.
 */
export async function parseSelect(sql: string): Promise<QueryModel> {
    const text = sql.replace(/^\uFEFF/, '');
    if (!text.trim()) throw new Error('Enter a SELECT statement to edit it in the Query Builder.');
    const placeholders = replacePlaceholders(text);
    let result: PgParseResult;
    try {
        result = await parseSql(placeholders.sql);
    } catch (err: unknown) {
        throw placeholders.restoreError(err);
    }
    try {
        const model = new SelectConverter(placeholders.sql, result, placeholders.standIns).convert();
        return placeholders.restoreModel(model);
    } catch (err: unknown) {
        throw placeholders.restoreError(err);
    }
}

/** Build the model from a parse tree of `sql` (pure; see {@link parseSelect}). */
export function modelFromParseResult(sql: string, result: PgParseResult): QueryModel {
    return new SelectConverter(sql, result).convert();
}

// ===== Placeholders ===========================================================

/** SQL with its placeholders replaced by stand-in identifiers the PostgreSQL parser accepts. */
export interface PlaceholderReplacement {
    sql: string;
    /** Stand-in identifier → the placeholder it replaces. */
    standIns: ReadonlyMap<string, string>;
    /** Put the placeholders back into every string of a model read from `sql`. */
    restoreModel(model: QueryModel): QueryModel;
    /** The error with the placeholders and the original character position put back. */
    restoreError(err: unknown): unknown;
}

/** Model fields that are names, quoted when SQL is generated, so they cannot hold a placeholder. */
const NAME_FIELDS = new Set(['schema', 'name', 'alias', 'aliasColumns', 'column', 'leftColumn', 'rightColumn']);

/**
 * Replace the `:name`, `:'name'` and `:"name"` placeholders of `sql` (never
 * inside strings, comments, quoted identifiers or array subscripts; `::` casts
 * and `:=` are no placeholders) by unique stand-in identifiers such as
 * `__qb_ph_0__`, which are valid wherever a value, a name or a table may stand.
 */
export function replacePlaceholders(sql: string): PlaceholderReplacement {
    const found = tokenizeSql(sql).filter((t) => t.type === 'param' && t.text.startsWith(':'));
    let prefix = '__qb_ph_';
    for (let k = 1; sql.toLowerCase().includes(prefix); k++) prefix = `__qb_ph${k}_`;
    const standIns = new Map<string, string>();
    const spans: Array<{ start: number; end: number; originalStart: number; originalEnd: number }> = [];
    let out = '';
    let last = 0;
    found.forEach((token, index) => {
        const standIn = `${prefix}${index}__`;
        standIns.set(standIn, token.text);
        out += sql.slice(last, token.start);
        spans.push({ start: out.length, end: out.length + standIn.length, originalStart: token.start, originalEnd: token.end });
        out += standIn;
        last = token.end;
    });
    out += sql.slice(last);
    const pattern = new RegExp(`${prefix}\\d+__`, 'g');
    const restore = (value: string) => (standIns.size === 0 ? value : value.replace(pattern, (m) => standIns.get(m) ?? m));
    const toOriginal = (position: number): number => {
        let shift = 0;
        for (const span of spans) {
            if (position < span.start) break;
            if (position < span.end) return span.originalStart;
            shift = span.originalEnd - span.end;
        }
        return position + shift;
    };
    const restoreValue = (value: unknown, key: string): unknown => {
        if (typeof value === 'string') {
            const restored = restore(value);
            if (restored !== value && NAME_FIELDS.has(key)) {
                throw new Error(`The placeholder ${restored} stands for a name (an alias, a column list or USING) that the Query Builder cannot keep. Use placeholders for values only.`);
            }
            return restored;
        }
        if (Array.isArray(value)) return value.map((v) => restoreValue(v, key));
        if (value && typeof value === 'object') {
            const copy: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) copy[k] = restoreValue(v, k);
            return copy;
        }
        return value;
    };
    return {
        sql: out,
        standIns,
        restoreModel: (model) => (standIns.size === 0 ? model : restoreValue(model, '') as QueryModel),
        restoreError(err: unknown): unknown {
            if (standIns.size === 0) return err;
            if (err instanceof SqlParseError) {
                const detail = restore(err.message.replace(/^Syntax error at position \d+: /, ''));
                if (err.position === undefined) return new SqlParseError(detail);
                const position = toOriginal(err.position);
                return new SqlParseError(`Syntax error at position ${position + 1}: ${detail}`, position);
            }
            if (err instanceof Error) {
                err.message = restore(err.message);
                return err;
            }
            return err;
        }
    };
}

// ===== Source text access =====================================================

const JOIN_TYPE_WORDS = new Set(['INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL']);
const SIMPLE_AGGREGATES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'ARRAY_AGG']);
const DISTINCT_AGGREGATES = new Set(['COUNT', 'SUM', 'AVG']);
const PREDICATE_KINDS = new Set([
    'AEXPR_OP', 'AEXPR_OP_ANY', 'AEXPR_OP_ALL', 'AEXPR_DISTINCT', 'AEXPR_NOT_DISTINCT', 'AEXPR_IN',
    'AEXPR_LIKE', 'AEXPR_ILIKE', 'AEXPR_SIMILAR', 'AEXPR_BETWEEN', 'AEXPR_NOT_BETWEEN',
    'AEXPR_BETWEEN_SYM', 'AEXPR_NOT_BETWEEN_SYM'
]);
const FLIPPED_OPERATORS: Record<string, string> = { '=': '=', '<>': '<>', '!=': '!=', '<': '>', '>': '<', '<=': '>=', '>=': '<=' };

/** Smallest source location (bytes) in a subtree, or -1. */
function minLocation(node: unknown): number {
    let min = -1;
    const visit = (value: unknown) => {
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            if (key === 'location' && typeof child === 'number') {
                if (child >= 0 && (min < 0 || child < min)) min = child;
            } else if (typeof child === 'object') {
                visit(child);
            }
        }
    };
    visit(node);
    return min;
}

/** Largest source location (bytes) in a subtree, or -1. */
function maxLocation(node: unknown): number {
    let max = -1;
    const visit = (value: unknown) => {
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            if (key === 'location' && typeof child === 'number') {
                if (child > max) max = child;
            } else if (typeof child === 'object') {
                visit(child);
            }
        }
    };
    visit(node);
    return max;
}

/**
 * Whether a subtree references a column; with `skipSubqueries` the inside of
 * subqueries does not count, nor a reference `isValue` calls a value.
 */
function containsColumnRef(node: unknown, skipSubqueries: boolean, isValue?: (ref: AstNode) => boolean): boolean {
    if (Array.isArray(node)) return node.some((n) => containsColumnRef(n, skipSubqueries, isValue));
    if (!node || typeof node !== 'object') return false;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'ColumnRef') {
            if (!isValue || !isValue(child as AstNode)) return true;
            continue;
        }
        if (skipSubqueries && key === 'subselect') continue;
        if (typeof child === 'object' && containsColumnRef(child, skipSubqueries, isValue)) return true;
    }
    return false;
}

function stringValues(list: unknown): string[] {
    if (!Array.isArray(list)) return [];
    return list.map((item: AstNode) => (item && item.String ? String(item.String.sval ?? '') : ''));
}

/** Integer value of an `A_Const`, or undefined. */
function intConst(node: AstNode | undefined): number | undefined {
    const c = node?.A_Const;
    if (!c || !c.ival) return undefined;
    return typeof c.ival.ival === 'number' ? c.ival.ival : 0;
}

/** Whether a FROM item is a table or a tree of plain inner/cross joins (no outer, NATURAL or USING join). */
function isPlainInnerJoinTree(node: AstNode | undefined): boolean {
    const je = node?.JoinExpr;
    if (!je) return true;
    if ((je.jointype ?? 'JOIN_INNER') !== 'JOIN_INNER' || je.isNatural || je.usingClause || je.alias) return false;
    return isPlainInnerJoinTree(je.larg) && isPlainInnerJoinTree(je.rarg);
}

/** The column name PostgreSQL gives a select-list entry (a simplified FigureColname). */
function figureColumnName(target: AstNode): string {
    if (target.name) return String(target.name);
    const name = (node: AstNode | undefined): string | undefined => {
        if (!node) return undefined;
        if (node.ColumnRef) {
            const fields = node.ColumnRef.fields ?? [];
            const last = fields[fields.length - 1];
            return last?.A_Star ? '*' : last?.String?.sval;
        }
        if (node.FuncCall) {
            const parts = stringValues(node.FuncCall.funcname);
            return parts[parts.length - 1];
        }
        if (node.TypeCast) {
            const parts = stringValues(node.TypeCast.typeName?.names);
            return name(node.TypeCast.arg) ?? parts[parts.length - 1];
        }
        if (node.A_Indirection) return name(node.A_Indirection.arg);
        if (node.CaseExpr) return 'case';
        if (node.CoalesceExpr) return 'coalesce';
        if (node.A_ArrayExpr) return 'array';
        if (node.RowExpr) return 'row';
        if (node.MinMaxExpr) return node.MinMaxExpr.op === 'IS_GREATEST' ? 'greatest' : 'least';
        if (node.NullIfExpr) return 'nullif';
        if (node.SubLink) {
            const type = node.SubLink.subLinkType;
            if (type === 'EXISTS_SUBLINK') return 'exists';
            if (type === 'ARRAY_SUBLINK') return 'array';
            if (type === 'EXPR_SUBLINK') {
                const first = node.SubLink.subselect?.SelectStmt?.targetList?.[0]?.ResTarget;
                return first ? figureColumnName(first) : undefined;
            }
        }
        return undefined;
    };
    return name(target.val) ?? '?column?';
}

/** The output column names of a SELECT (its first branch for set operations). */
function selectOutputColumns(stmt: AstNode | undefined): string[] | undefined {
    let select = stmt?.SelectStmt;
    while (select && select.op && select.op !== 'SETOP_NONE') select = select.larg;
    const targets = select?.targetList;
    if (!Array.isArray(targets)) return undefined;
    return targets.map((t: AstNode) => figureColumnName(t.ResTarget ?? {}));
}

interface Part {
    node: AstNode;
    a: number;
    b: number;
}

interface Predicate {
    lhsNode: AstNode;
    rhsNode?: AstNode;
    lhs: string;
    rhs: string;
    opTok: number;
    a: number;
    b: number;
}

class SelectConverter {
    private readonly tokens: SqlToken[];
    private readonly comments: SqlToken[];
    private readonly pair: number[];
    private readonly byteToChar: Int32Array;
    private readonly captured: Array<[number, number]> = [];
    private readonly model: QueryModel = createEmptyModel();
    private readonly warnings: string[] = [];
    private readonly itemOf = new Map<string, number>();
    /** The column an ORDER BY / GROUP BY ordinal refers to; unknown from a `*` on. */
    private readonly targetByOrdinal: Array<QbColumn | undefined> = [];
    private starSeen = false;
    private readonly whereJoins = new Map<string, QbJoin>();
    private nullable = new Set<string>();
    private ids = { t: 0, j: 0, c: 0 };

    constructor(private readonly sql: string, private readonly result: PgParseResult, private readonly standIns: ReadonlyMap<string, string> = new Map()) {
        const all = tokenizeSql(sql);
        this.tokens = all.filter((t) => t.type !== 'comment');
        this.comments = all.filter((t) => t.type === 'comment');
        this.pair = new Array<number>(this.tokens.length).fill(-1);
        const stack: number[] = [];
        this.tokens.forEach((t, i) => {
            if (t.type !== 'punct') return;
            if (t.text === '(' || t.text === '[') stack.push(i);
            else if (t.text === ')' || t.text === ']') {
                const open = stack.pop();
                if (open !== undefined) {
                    this.pair[open] = i;
                    this.pair[i] = open;
                }
            }
        });
        const bytes = Buffer.byteLength(sql, 'utf8');
        this.byteToChar = new Int32Array(bytes + 1);
        let b = 0;
        for (let i = 0; i < sql.length; i++) {
            const code = sql.charCodeAt(i);
            let len: number;
            if (code < 0x80) len = 1;
            else if (code < 0x800) len = 2;
            else if (code >= 0xd800 && code <= 0xdbff && i + 1 < sql.length) len = 4;
            else len = 3;
            for (let k = 0; k < len && b + k <= bytes; k++) this.byteToChar[b + k] = i;
            b += len;
            if (len === 4) i++;
        }
        this.byteToChar[bytes] = sql.length;
    }

    // ----- token helpers -----

    private charOf(byte: number): number {
        if (byte <= 0) return 0;
        return byte >= this.byteToChar.length ? this.sql.length : this.byteToChar[byte];
    }

    /** Index of the first token starting at or after a character offset. */
    private tokAt(charPos: number): number {
        let lo = 0;
        let hi = this.tokens.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this.tokens[mid].start < charPos) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    private minTok(node: unknown): number {
        const loc = minLocation(node);
        return loc < 0 ? -1 : this.tokAt(this.charOf(loc));
    }

    private maxTok(node: unknown): number {
        const loc = maxLocation(node);
        return loc < 0 ? -1 : this.tokAt(this.charOf(loc));
    }

    private word(i: number): string {
        const t = this.tokens[i];
        return t && t.type === 'word' ? t.upper : '';
    }

    private isPunct(i: number, text: string): boolean {
        const t = this.tokens[i];
        return !!t && t.type === 'punct' && t.text === text;
    }

    /** Indexes of the tokens in [a, b) outside of any parentheses/brackets. */
    private depth0(a: number, b: number): number[] {
        const out: number[] = [];
        let i = a;
        while (i < b) {
            out.push(i);
            const t = this.tokens[i];
            if (t.type === 'punct' && (t.text === '(' || t.text === '[') && this.pair[i] > i) i = this.pair[i] + 1;
            else i++;
        }
        return out;
    }

    private lastDepth0Before(a: number, limit: number, test: (i: number) => boolean): number {
        let found = -1;
        for (const i of this.depth0(a, limit)) {
            if (i >= limit) break;
            if (test(i)) found = i;
        }
        return found;
    }

    private split(a: number, b: number, separator: string): Array<[number, number]> {
        if (a >= b) return [];
        const out: Array<[number, number]> = [];
        let start = a;
        for (const i of this.depth0(a, b)) {
            if (this.isPunct(i, separator)) {
                out.push([start, i]);
                start = i + 1;
            }
        }
        out.push([start, b]);
        return out;
    }

    private stripParens(a: number, b: number): [number, number] {
        while (b - a >= 2 && this.isPunct(a, '(') && this.pair[a] === b - 1) {
            a++;
            b--;
        }
        return [a, b];
    }

    /** Source text of the tokens [a, b) (comments between them included). */
    private text(a: number, b: number): string {
        if (a >= b) return '';
        const start = this.tokens[a].start;
        const end = this.tokens[b - 1].end;
        this.captured.push([start, end]);
        return this.sql.slice(start, end);
    }

    private warn(message: string): void {
        if (!this.warnings.includes(message)) this.warnings.push(message);
    }

    private newId(kind: 't' | 'j' | 'c'): string {
        this.ids[kind]++;
        return `${kind}${this.ids[kind]}`;
    }

    /** Whether a name contains the stand-in of a placeholder (see {@link replacePlaceholders}). */
    private hasStandIn(name: string): boolean {
        if (this.standIns.size === 0) return false;
        for (const standIn of this.standIns.keys()) if (name.includes(standIn)) return true;
        return false;
    }

    /**
     * A column reference that is a value: a placeholder, or a PL/pgSQL record
     * field or qualified variable `head.tail` whose head names no table of the
     * query (`pi_obj.emplid`).
     */
    private isValueRef(ref: AstNode): boolean {
        const fields: AstNode[] = ref?.fields ?? [];
        if (fields.length === 0 || !fields.every((f) => f.String)) return false;
        const names = fields.map((f) => String(f.String.sval));
        if (names.length === 1) return this.hasStandIn(names[0]);
        if (names.length !== 2) return false;
        // A box without a name or alias may be referred to by a name the diagram does not know.
        if (this.model.tables.some((t) => !t.alias && !t.name)) return false;
        return !this.model.tables.some((t) => t.alias === names[0] || t.name === names[0]);
    }

    // ----- statement -----

    convert(): QueryModel {
        const stmts = this.result.stmts ?? [];
        if (stmts.length === 0) throw new Error('The text contains no SQL statement.');
        if (stmts.length > 1) throw new Error('Only a single SELECT statement can be edited in the Query Builder.');
        const stmt = stmts[0];
        const top: AstNode | undefined = stmt.stmt?.SelectStmt;
        if (!top) throw new Error('Only a SELECT statement can be edited in the Query Builder.');
        if (top.intoClause) throw new Error('SELECT INTO creates a table and cannot be edited in the Query Builder.');
        const startByte = stmt.stmt_location ?? 0;
        let s = this.tokAt(this.charOf(startByte));
        let e = stmt.stmt_len ? this.tokAt(this.charOf(startByte + stmt.stmt_len)) : this.tokens.length;
        while (e > s && this.isPunct(e - 1, ';')) e--;
        if (top.withClause) s = this.readCtes(top.withClause, s, e);
        let first = top;
        while (first.op && first.op !== 'SETOP_NONE') first = first.larg;
        if (first.valuesLists || this.word(s) !== 'SELECT') {
            throw new Error('Only a query that starts with SELECT (optionally after WITH) can be edited in the Query Builder.');
        }
        let end = e;
        if (first !== top) {
            const setOp = this.depth0(s + 1, e).find((i) => ['UNION', 'INTERSECT', 'EXCEPT'].includes(this.word(i)));
            if (setOp === undefined) throw new Error('Could not locate the set operation (UNION/INTERSECT/EXCEPT).');
            end = setOp;
            this.model.tail = this.text(setOp, e);
            this.warn('Everything from the set operation (UNION/INTERSECT/EXCEPT) on is kept as raw SQL text; only the first SELECT is shown in the diagram.');
        }
        this.readSelect(first, s, end);
        this.finish(s, e);
        return this.model;
    }

    /** Read the WITH clause, return the token index after it. */
    private readCtes(withClause: AstNode, s: number, e: number): number {
        this.model.recursive = !!withClause.recursive;
        let pos = s;
        for (const item of withClause.ctes ?? []) {
            const cte = item.CommonTableExpr;
            if (!cte) continue;
            if (cte.search_clause || cte.cycle_clause) {
                throw new Error('A CTE with SEARCH or CYCLE cannot be edited in the Query Builder.');
            }
            const nameTok = this.tokAt(this.charOf(cte.location));
            const asTok = this.depth0(nameTok + 1, e).find((i) => this.word(i) === 'AS');
            if (asTok === undefined) throw new Error(`Could not read the CTE ${cte.ctename}.`);
            let open = asTok + 1;
            while (open < e && !this.isPunct(open, '(')) open++;
            const close = this.pair[open];
            if (close < 0) throw new Error(`Could not read the CTE ${cte.ctename}.`);
            const entry: QueryModel['ctes'][number] = { name: String(cte.ctename), sql: this.text(open + 1, close) };
            const aliasColumns = stringValues(cte.aliascolnames);
            if (aliasColumns.length > 0) entry.aliasColumns = aliasColumns;
            if (cte.ctematerialized === 'CTEMaterializeAlways') entry.materialized = true;
            else if (cte.ctematerialized === 'CTEMaterializeNever') entry.materialized = false;
            const columns = selectOutputColumns(cte.ctequery);
            if (columns) entry.columns = columns;
            this.model.ctes.push(entry);
            pos = close + 1;
        }
        if (this.model.ctes.length > 0) this.warn('Common table expressions (WITH) are kept as raw SQL text.');
        return pos;
    }

    private readSelect(node: AstNode, s: number, e: number): void {
        const clauses = this.findClauses(s, e);
        const at = (name: string) => clauses.find((c) => c.name === name);
        const spanOf = (name: string): [number, number] | undefined => {
            const index = clauses.findIndex((c) => c.name === name);
            if (index < 0) return undefined;
            const c = clauses[index];
            return [c.index + c.length, index + 1 < clauses.length ? clauses[index + 1].index : e];
        };
        const located = (present: unknown, name: string, label: string): [number, number] | undefined => {
            if (!present) return undefined;
            const span = spanOf(name);
            if (!span) throw new Error(`Could not locate the ${label} clause.`);
            return span;
        };

        const fromSpan = located(node.fromClause, 'FROM', 'FROM');
        if (fromSpan) this.readFrom(node.fromClause, fromSpan[0], fromSpan[1]);

        let p = s + 1;
        const targetEnd = clauses.length > 0 ? clauses[0].index : e;
        if (Array.isArray(node.distinctClause)) {
            if (this.word(p) !== 'DISTINCT') throw new Error('Could not locate DISTINCT.');
            p++;
            if (this.word(p) === 'ON' && this.isPunct(p + 1, '(')) {
                const close = this.pair[p + 1];
                this.model.distinctOn = this.split(p + 2, close, ',').map(([a, b]) => this.text(a, b));
                p = close + 1;
            } else {
                this.model.distinct = true;
            }
        } else if (this.word(p) === 'ALL') {
            p++;
        }
        this.readTargets(node.targetList ?? [], p, targetEnd);

        const whereSpan = located(node.whereClause, 'WHERE', 'WHERE');
        if (whereSpan) this.readWhere(node.whereClause, whereSpan[0], whereSpan[1]);
        const groupSpan = located(node.groupClause, 'GROUP', 'GROUP BY');
        if (groupSpan) this.readGroupBy(node, groupSpan[0], groupSpan[1]);
        else if (node.groupDistinct) this.model.groupByDistinct = true;
        const havingSpan = located(node.havingClause, 'HAVING', 'HAVING');
        if (havingSpan) this.readHaving(node.havingClause, havingSpan[0], havingSpan[1]);
        const windowSpan = located(node.windowClause, 'WINDOW', 'WINDOW');
        if (windowSpan) {
            this.model.window = this.text(windowSpan[0], windowSpan[1]);
            this.warn('The WINDOW clause is kept as raw SQL text.');
        }
        const orderSpan = located(node.sortClause, 'ORDER', 'ORDER BY');
        if (orderSpan) this.readOrderBy(node.sortClause, orderSpan[0], orderSpan[1]);

        const limitSpan = spanOf('LIMIT');
        if (limitSpan) this.model.limit = this.text(limitSpan[0], limitSpan[1]);
        const fetchSpan = spanOf('FETCH');
        if (fetchSpan) this.readFetch(fetchSpan[0], fetchSpan[1]);
        const offsetSpan = spanOf('OFFSET');
        if (offsetSpan) {
            const a = offsetSpan[0];
            let b = offsetSpan[1];
            if (b > a + 1 && ['ROW', 'ROWS'].includes(this.word(b - 1))) b--;
            this.model.offset = this.text(a, b);
        }
        const forClause = at('FOR');
        if (forClause) {
            const span = spanOf('FOR') as [number, number];
            this.model.locking = this.text(forClause.index, span[1]);
            this.warn('The locking clause (FOR UPDATE/SHARE) is kept as raw SQL text.');
        }
    }

    /** The clause keywords of a SELECT at parenthesis depth 0, in source order. */
    private findClauses(s: number, e: number): Array<{ name: string; index: number; length: number }> {
        const found: Array<{ name: string; index: number; length: number }> = [];
        const has = (name: string) => found.some((f) => f.name === name);
        for (const i of this.depth0(s + 1, e)) {
            const w = this.word(i);
            if (!w) continue;
            const prev = this.tokens[i - 1];
            if (prev && ((prev.type === 'punct' && prev.text === '.') || (prev.type === 'word' && prev.upper === 'AS'))) continue;
            const prevWord = this.word(i - 1);
            const next = this.word(i + 1);
            let name: string | undefined;
            let length = 1;
            switch (w) {
                case 'FROM':
                    if (prevWord === 'ROWS' || (prevWord === 'DISTINCT' && ['IS', 'NOT'].includes(this.word(i - 2)))) break;
                    name = 'FROM';
                    break;
                case 'GROUP':
                    if (prevWord !== 'WITHIN' && next === 'BY') {
                        name = 'GROUP';
                        length = 2;
                    }
                    break;
                case 'ORDER':
                    if (next === 'BY') {
                        name = 'ORDER';
                        length = 2;
                    }
                    break;
                case 'FOR':
                    if (['UPDATE', 'SHARE', 'NO', 'KEY'].includes(next)) name = 'FOR';
                    break;
                case 'WHERE': case 'HAVING': case 'WINDOW': case 'LIMIT': case 'OFFSET': case 'FETCH':
                    name = w;
                    break;
            }
            if (name && !has(name)) found.push({ name, index: i, length });
        }
        return found;
    }

    // ----- FROM -----

    private readFrom(items: AstNode[], a: number, b: number): void {
        const spans = this.split(a, b, ',');
        if (spans.length !== items.length) throw new Error('Could not read the FROM clause.');
        items.forEach((item, index) => this.readFromItem(item, spans[index][0], spans[index][1], index));
        this.nullable = new Set<string>();
        for (const j of this.model.joins) {
            if (j.type === 'LEFT' || j.type === 'FULL') this.nullable.add(j.rightTableId);
            if (j.type === 'RIGHT' || j.type === 'FULL') this.nullable.add(j.leftTableId);
        }
    }

    /** Token index where a trailing `[AS] alias [(cols)]` starts. */
    private stripAlias(a: number, b: number, alias: AstNode | undefined): number {
        if (!alias) return b;
        if (Array.isArray(alias.colnames) && alias.colnames.length > 0 && this.isPunct(b - 1, ')')) b = this.pair[b - 1];
        b--;
        if (b - 1 >= a && this.word(b - 1) === 'AS') b--;
        return b;
    }

    private addTable(table: Omit<QbTable, 'id'>, item: number): string {
        const id = this.newId('t');
        this.model.tables.push({ id, ...table });
        this.itemOf.set(id, item);
        return id;
    }

    private readFromItem(node: AstNode, a: number, b: number, item: number): string[] {
        if (node.JoinExpr) return this.readJoin(node.JoinExpr, a, b, item);
        if (node.RangeVar) {
            const rv = node.RangeVar;
            if ([rv.relname, rv.schemaname, rv.catalogname].some((part) => typeof part === 'string' && this.hasStandIn(part))) {
                // A placeholder for the table: no relation of the catalog, so a raw box.
                const table: Omit<QbTable, 'id'> = { kind: 'function', sql: this.text(a, this.stripAlias(a, b, rv.alias)) };
                if (rv.alias?.aliasname) table.alias = String(rv.alias.aliasname);
                const cols = stringValues(rv.alias?.colnames);
                if (cols.length > 0) table.aliasColumns = cols;
                this.warn('A table given by a placeholder is kept as raw SQL text; its columns are unknown.');
                return [this.addTable(table, item)];
            }
            const table: Omit<QbTable, 'id'> = { kind: 'relation', name: String(rv.relname) };
            if (rv.schemaname) table.schema = String(rv.schemaname);
            if (rv.catalogname) this.warn(`The database name "${rv.catalogname}" in a table name is not kept.`);
            if (rv.alias?.aliasname) table.alias = String(rv.alias.aliasname);
            const cols = stringValues(rv.alias?.colnames);
            if (cols.length > 0) table.aliasColumns = cols;
            if (!rv.inh) table.only = true;
            return [this.addTable(table, item)];
        }
        if (node.RangeSubselect) {
            const rs = node.RangeSubselect;
            let start = a;
            const end = this.stripAlias(a, b, rs.alias);
            if (this.word(start) === 'LATERAL') start++;
            const wrapped = this.isPunct(start, '(') && this.pair[start] === end - 1;
            const table: Omit<QbTable, 'id'> = {
                kind: 'subquery',
                sql: wrapped ? this.text(start + 1, end - 1) : this.text(start, end)
            };
            if (rs.alias?.aliasname) table.alias = String(rs.alias.aliasname);
            const cols = stringValues(rs.alias?.colnames);
            if (cols.length > 0) table.aliasColumns = cols;
            if (rs.lateral) table.lateral = true;
            const columns = selectOutputColumns(rs.subquery);
            if (columns) table.columns = columns;
            this.warn('Subqueries in FROM are kept as raw SQL text.');
            return [this.addTable(table, item)];
        }
        if (node.RangeFunction) {
            const rf = node.RangeFunction;
            const hasColumnDefinitions = (Array.isArray(rf.coldeflist) && rf.coldeflist.length > 0) ||
                (rf.functions ?? []).some((f: AstNode) => Array.isArray(f.List?.items?.[1]?.List?.items) && f.List.items[1].List.items.length > 0);
            let start = a;
            if (this.word(start) === 'LATERAL') start++;
            const table: Omit<QbTable, 'id'> = { kind: 'function' };
            if (hasColumnDefinitions) {
                table.sql = this.text(start, b);
            } else {
                table.sql = this.text(start, this.stripAlias(start, b, rf.alias));
                if (rf.alias?.aliasname) table.alias = String(rf.alias.aliasname);
                const cols = stringValues(rf.alias?.colnames);
                if (cols.length > 0) table.aliasColumns = cols;
            }
            if (rf.lateral) table.lateral = true;
            this.warn('Table functions in FROM are kept as raw SQL text.');
            return [this.addTable(table, item)];
        }
        this.warn('A FROM item the diagram cannot show is kept as raw SQL text.');
        let start = a;
        const lateral = this.word(start) === 'LATERAL';
        if (lateral) start++;
        const table: Omit<QbTable, 'id'> = { kind: 'function', sql: this.text(start, b) };
        if (lateral) table.lateral = true;
        return [this.addTable(table, item)];
    }

    private readJoin(je: AstNode, a: number, b: number, item: number): string[] {
        if (je.alias) throw new Error('A parenthesized join with an alias cannot be edited in the Query Builder.');
        [a, b] = this.stripParens(a, b);
        const joinKw = this.lastDepth0Before(a, this.minTok(je.rarg), (i) => this.word(i) === 'JOIN');
        if (joinKw < 0) throw new Error('Could not read a JOIN.');
        let typeStart = joinKw;
        while (typeStart > a && JOIN_TYPE_WORDS.has(this.word(typeStart - 1))) typeStart--;
        let rightEnd = b;
        let qualsStart = -1;
        if (je.quals) {
            const on = this.lastDepth0Before(joinKw + 1, this.minTok(je.quals), (i) => this.word(i) === 'ON');
            if (on < 0) throw new Error('Could not read a JOIN condition.');
            rightEnd = on;
            qualsStart = on + 1;
        } else if (je.usingClause) {
            const using = this.lastDepth0Before(joinKw + 1, b, (i) => this.word(i) === 'USING');
            if (using < 0) throw new Error('Could not read a JOIN … USING.');
            rightEnd = using;
        }
        const leftIds = this.readFromItem(je.larg, a, typeStart, item);
        let type: QbJoinType;
        switch (je.jointype) {
            case 'JOIN_LEFT': type = 'LEFT'; break;
            case 'JOIN_RIGHT': type = 'RIGHT'; break;
            case 'JOIN_FULL': type = 'FULL'; break;
            default: type = je.quals || je.usingClause || je.isNatural ? 'INNER' : 'CROSS';
        }
        // The joins of this level go before those inside a nested right side,
        // the order in which the generator places the tables again.
        const insertAt = this.model.joins.length;
        let rightIds: string[];
        if (je.rarg?.JoinExpr) {
            // A parenthesized join on the right is the same as a flat join
            // sequence only when it and the join around it are plain inner joins.
            const flat = (type === 'INNER' || type === 'CROSS') && !je.isNatural && !je.usingClause && isPlainInnerJoinTree(je.rarg);
            if (flat) {
                this.warn('A parenthesized (nested) inner join is shown as a flat join sequence.');
                rightIds = this.readFromItem(je.rarg, joinKw + 1, rightEnd, item);
            } else {
                this.warn('A parenthesized (nested) join that a flat join sequence cannot express (outer, NATURAL or USING joins) is kept as raw SQL text.');
                rightIds = [this.addTable({ kind: 'function', sql: this.text(joinKw + 1, rightEnd) }, item)];
            }
        } else {
            rightIds = this.readFromItem(je.rarg, joinKw + 1, rightEnd, item);
        }
        const lastLeft = leftIds[leftIds.length - 1];
        const firstRight = rightIds[0];
        const lastRight = rightIds[rightIds.length - 1];
        let inserted = 0;
        const push = (join: Omit<QbJoin, 'id'>) => {
            const created: QbJoin = { id: this.newId('j'), ...join };
            this.model.joins.splice(insertAt + inserted++, 0, created);
            return created;
        };
        if (je.isNatural) {
            push({ leftTableId: lastLeft, rightTableId: firstRight, type, pairs: [], natural: true });
        } else if (je.usingClause) {
            const names = stringValues(je.usingClause);
            push({ leftTableId: lastLeft, rightTableId: firstRight, type, pairs: names.map((n) => ({ leftColumn: n, rightColumn: n })), using: true });
            if (je.join_using_alias) this.warn('The alias of JOIN … USING (…) AS alias is not kept.');
        } else if (!je.quals) {
            push({ leftTableId: lastLeft, rightTableId: firstRight, type, pairs: [] });
        } else {
            const groups = new Map<string, Omit<QbJoin, 'id'>>();
            const raw: string[] = [];
            for (const part of this.splitBool(je.quals, qualsStart, b, 'AND_EXPR')) {
                const p = this.columnPair(part.node);
                let oriented: { l: string; lc: string; r: string; rc: string; op: string } | undefined;
                if (p && leftIds.includes(p.lt) && rightIds.includes(p.rt)) {
                    oriented = { l: p.lt, lc: p.lc, r: p.rt, rc: p.rc, op: p.op };
                } else if (p && leftIds.includes(p.rt) && rightIds.includes(p.lt) && FLIPPED_OPERATORS[p.op]) {
                    oriented = { l: p.rt, lc: p.rc, r: p.lt, rc: p.lc, op: FLIPPED_OPERATORS[p.op] };
                }
                if (!oriented) {
                    raw.push(this.text(part.a, part.b));
                    continue;
                }
                const key = `${oriented.l}|${oriented.r}`;
                let group = groups.get(key);
                if (!group) {
                    group = { leftTableId: oriented.l, rightTableId: oriented.r, type, pairs: [] };
                    groups.set(key, group);
                }
                group.pairs.push(oriented.op === '=' ? { leftColumn: oriented.lc, rightColumn: oriented.rc } : { leftColumn: oriented.lc, rightColumn: oriented.rc, operator: oriented.op });
            }
            const created = [...groups.values()];
            if (raw.length > 0) {
                // Raw conditions may name any table of a flattened right side,
                // so they go to the join of its last table.
                let holder = created.find((g) => g.rightTableId === lastRight);
                if (!holder) {
                    holder = { leftTableId: lastLeft, rightTableId: lastRight, type, pairs: [] };
                    created.push(holder);
                }
                holder.condition = raw.join(' AND ');
            }
            if (created.length === 0) created.push({ leftTableId: lastLeft, rightTableId: firstRight, type, pairs: [] });
            created.forEach(push);
        }
        return [...leftIds, ...rightIds];
    }

    /** `x.a <op> y.b` between two different tables of the model. */
    private columnPair(node: AstNode): { lt: string; lc: string; rt: string; rc: string; op: string } | undefined {
        const ae = node?.A_Expr;
        if (!ae || ae.kind !== 'AEXPR_OP' || !ae.lexpr?.ColumnRef || !ae.rexpr?.ColumnRef) return undefined;
        const ops = stringValues(ae.name);
        if (ops.length !== 1 || !FLIPPED_OPERATORS[ops[0]]) return undefined;
        const left = this.resolveColumnRef(ae.lexpr.ColumnRef);
        const right = this.resolveColumnRef(ae.rexpr.ColumnRef);
        if (!left.tableId || !right.tableId || !left.column || !right.column || left.column === '*' || right.column === '*') return undefined;
        if ((ae.lexpr.ColumnRef.fields ?? []).length < 2 || (ae.rexpr.ColumnRef.fields ?? []).length < 2) return undefined;
        if (left.tableId === right.tableId) return undefined;
        return { lt: left.tableId, lc: left.column, rt: right.tableId, rc: right.column, op: ops[0] };
    }

    private resolveColumnRef(ref: AstNode): { tableId?: string; column?: string } {
        const fields: Array<string | undefined> = (ref.fields ?? []).map((f: AstNode) => (f.String ? String(f.String.sval) : f.A_Star ? '*' : undefined));
        if (fields.length === 0 || fields.some((f) => f === undefined)) return {};
        const names = fields as string[];
        if (names.some((n) => this.hasStandIn(n))) return {};
        const column = names[names.length - 1];
        let matches: QbTable[] = [];
        if (names.length === 1) {
            if (column === '*' || this.model.tables.length !== 1) return {};
            matches = this.model.tables;
        } else if (names.length === 2) {
            matches = this.model.tables.filter((t) => (t.alias ? t.alias === names[0] : t.name === names[0]));
        } else if (names.length === 3) {
            matches = this.model.tables.filter((t) => !t.alias && t.schema === names[0] && t.name === names[1]);
        }
        return matches.length === 1 ? { tableId: matches[0].id, column } : {};
    }

    // ----- select list -----

    private readTargets(targets: AstNode[], a: number, b: number): void {
        const spans = this.split(a, b, ',');
        if (spans.length !== targets.length) throw new Error('Could not read the select list.');
        targets.forEach((item, index) => {
            const rt = item.ResTarget ?? {};
            const [start] = spans[index];
            let end = spans[index][1];
            if (rt.name) {
                end--;
                if (end - 1 > start && this.word(end - 1) === 'AS') end--;
            }
            const column = this.columnFor(rt.val, start, end, true);
            if (rt.name) column.alias = String(rt.name);
            this.model.columns.push(column);
            const fields = rt.val?.ColumnRef?.fields;
            if (Array.isArray(fields) && fields[fields.length - 1]?.A_Star) this.starSeen = true;
            this.targetByOrdinal.push(this.starSeen ? undefined : column);
        });
    }

    /** A grid column for the expression `node` at tokens [a, b). */
    private columnFor(node: AstNode | undefined, a: number, b: number, output: boolean): QbColumn {
        const column: QbColumn = { id: this.newId('c'), expression: '', output, groupBy: false, criteria: [] };
        const agg = this.aggregateOf(node, a, b);
        let target = node;
        if (agg) {
            column.aggregate = agg.aggregate;
            column.expression = agg.expression;
            target = agg.arg;
        } else {
            column.expression = this.text(a, b);
        }
        if (target?.ColumnRef) {
            const resolved = this.resolveColumnRef(target.ColumnRef);
            if (resolved.tableId && resolved.column) {
                column.tableId = resolved.tableId;
                column.column = resolved.column;
            }
        }
        return column;
    }

    /** `COUNT(x)`, `SUM(DISTINCT x)`, … spanning exactly [a, b). */
    private aggregateOf(node: AstNode | undefined, a: number, b: number): { aggregate: QbAggregate; expression: string; arg?: AstNode } | undefined {
        const fc = node?.FuncCall;
        if (!fc) return undefined;
        const names = stringValues(fc.funcname);
        if (names.length !== 1) return undefined;
        const name = names[0].toUpperCase();
        if (!SIMPLE_AGGREGATES.has(name) || names[0] !== names[0].toLowerCase()) return undefined;
        if (fc.agg_order || fc.agg_filter || fc.over || fc.agg_within_group || fc.func_variadic) return undefined;
        const args: AstNode[] = fc.args ?? [];
        if (fc.agg_star ? name !== 'COUNT' || args.length > 0 : args.length !== 1) return undefined;
        if (fc.agg_distinct && !DISTINCT_AGGREGATES.has(name)) return undefined;
        const [s, e] = this.stripParens(a, b);
        const open = s + 1;
        if (!this.isPunct(open, '(') || this.pair[open] !== e - 1) return undefined;
        let inner = open + 1;
        if (['DISTINCT', 'ALL'].includes(this.word(inner))) inner++;
        const expression = fc.agg_star ? '*' : this.text(inner, e - 1);
        return { aggregate: (fc.agg_distinct ? `${name} DISTINCT` : name) as QbAggregate, expression, arg: args[0] };
    }

    // ----- WHERE / HAVING -----

    /** Split an AND/OR chain into its operands with their token spans (nested chains flattened). */
    private splitBool(node: AstNode, a: number, b: number, op: 'AND_EXPR' | 'OR_EXPR'): Part[] {
        [a, b] = this.stripParens(a, b);
        const be = node?.BoolExpr;
        if (!be || be.boolop !== op || !Array.isArray(be.args)) return [{ node, a, b }];
        const keyword = op === 'AND_EXPR' ? 'AND' : 'OR';
        const parts: Part[] = [];
        let start = a;
        for (let i = 1; i < be.args.length; i++) {
            const limit = this.minTok(be.args[i]);
            const sep = this.lastDepth0Before(start, limit, (k) => this.word(k) === keyword);
            if (sep < 0) return [{ node, a, b }];
            parts.push({ node: be.args[i - 1], a: start, b: sep });
            start = sep + 1;
        }
        parts.push({ node: be.args[be.args.length - 1], a: start, b });
        return parts.flatMap((p) => (p.node?.BoolExpr?.boolop === op ? this.splitBool(p.node, p.a, p.b, op) : [p]));
    }

    /** Split `lhs <operator> rhs` (also IS NULL, IN, BETWEEN, LIKE, IN (subquery)) at the operator. */
    private splitPredicate(node: AstNode, a: number, b: number): Predicate | undefined {
        [a, b] = this.stripParens(a, b);
        let lhsNode: AstNode | undefined;
        let rhsNode: AstNode | undefined;
        let location: number | undefined;
        if (node.A_Expr && PREDICATE_KINDS.has(node.A_Expr.kind) && node.A_Expr.lexpr) {
            lhsNode = node.A_Expr.lexpr;
            rhsNode = node.A_Expr.rexpr;
            location = node.A_Expr.location;
        } else if (node.NullTest?.arg) {
            lhsNode = node.NullTest.arg;
            location = node.NullTest.location;
        } else if (node.BooleanTest?.arg) {
            lhsNode = node.BooleanTest.arg;
            location = node.BooleanTest.location;
        } else if (node.SubLink?.testexpr && ['ANY_SUBLINK', 'ALL_SUBLINK'].includes(node.SubLink.subLinkType)) {
            lhsNode = node.SubLink.testexpr;
            location = node.SubLink.location;
        } else if (node.BoolExpr?.boolop === 'NOT_EXPR' && node.BoolExpr.args?.length === 1) {
            const inner = node.BoolExpr.args[0];
            if (inner.SubLink?.testexpr && inner.SubLink.subLinkType === 'ANY_SUBLINK') {
                lhsNode = inner.SubLink.testexpr;
                location = node.BoolExpr.location;
            }
        }
        if (!lhsNode || typeof location !== 'number' || location < 0) return undefined;
        const opTok = this.tokAt(this.charOf(location));
        if (opTok <= a || opTok >= b || this.tokens[opTok].start !== this.charOf(location)) return undefined;
        if (!this.depth0(a, b).includes(opTok)) return undefined;
        const lhsMin = this.minTok(lhsNode);
        const lhsMax = this.maxTok(lhsNode);
        if (lhsMin < a || lhsMax >= opTok) return undefined;
        return { lhsNode, rhsNode, lhs: this.text(a, opTok), rhs: this.text(opTok, b), opTok, a, b };
    }

    /** A WHERE predicate on one expression with a column-free right-hand side. */
    private criteriaPredicate(part: Part): Predicate | undefined {
        const p = this.splitPredicate(part.node, part.a, part.b);
        if (!p) return undefined;
        if (!containsColumnRef(p.lhsNode, true, (ref) => this.isValueRef(ref))) return undefined;
        if (p.rhsNode && containsColumnRef(p.rhsNode, true, (ref) => this.isValueRef(ref))) return undefined;
        return p;
    }

    private readWhere(where: AstNode, a: number, b: number): void {
        const remaining: Part[] = [];
        for (const part of this.splitBool(where, a, b, 'AND_EXPR')) {
            if (!this.tryCommaJoin(part.node)) remaining.push(part);
        }
        let rows: Predicate[][] | undefined;
        if (remaining.length === 1) {
            const alternatives = this.splitBool(remaining[0].node, remaining[0].a, remaining[0].b, 'OR_EXPR');
            if (alternatives.length > 1) {
                const candidate = alternatives.map((alt) => this.splitBool(alt.node, alt.a, alt.b, 'AND_EXPR').map((c) => this.criteriaPredicate(c)));
                if (candidate.every((row) => row.every((p) => !!p))) rows = candidate as Predicate[][];
            }
        }
        if (rows) {
            rows.forEach((row, r) => row.forEach((p) => this.assignCriteria(r, p)));
            return;
        }
        const extra: string[] = [];
        for (const part of remaining) {
            const p = this.criteriaPredicate(part);
            if (p) this.assignCriteria(0, p);
            else extra.push(this.text(part.a, part.b));
        }
        if (extra.length > 0) {
            this.model.whereExtra = extra;
            this.warn('WHERE conditions that do not belong to a single column are kept as raw SQL text.');
        }
    }

    private assignCriteria(row: number, p: Predicate): void {
        const key = normalizeExpressionKey(p.lhs);
        let column = this.model.columns.find((c) => !c.aggregate && !(c.criteria[row] ?? '').trim() && normalizeExpressionKey(c.expression) === key);
        if (!column) {
            column = this.columnFor(p.lhsNode, p.a, p.opTok, false);
            if (column.aggregate) {
                column.expression = p.lhs;
                delete column.aggregate;
            }
            this.model.columns.push(column);
        }
        while (column.criteria.length < row) column.criteria.push('');
        column.criteria[row] = p.rhs;
    }

    /** Turn `a.x = b.y` between comma-separated FROM items into an INNER join. */
    private tryCommaJoin(node: AstNode): boolean {
        const p = this.columnPair(node);
        if (!p || p.op !== '=') return false;
        const li = this.itemOf.get(p.lt);
        const ri = this.itemOf.get(p.rt);
        if (li === undefined || ri === undefined) return false;
        const key = li <= ri ? `${p.lt}|${p.rt}` : `${p.rt}|${p.lt}`;
        const existing = this.whereJoins.get(key);
        if (li === ri && !existing) return false;
        if (this.nullable.has(p.lt) || this.nullable.has(p.rt)) return false;
        const [l, lc, r, rc] = li <= ri ? [p.lt, p.lc, p.rt, p.rc] : [p.rt, p.rc, p.lt, p.lc];
        if (existing) {
            existing.pairs.push({ leftColumn: lc, rightColumn: rc });
        } else {
            const join: QbJoin = { id: this.newId('j'), leftTableId: l, rightTableId: r, type: 'INNER', pairs: [{ leftColumn: lc, rightColumn: rc }] };
            this.model.joins.push(join);
            this.whereJoins.set(key, join);
        }
        this.warn('Join conditions in WHERE between comma-separated tables are shown as INNER JOINs.');
        return true;
    }

    private readGroupBy(node: AstNode, a: number, b: number): void {
        if (this.word(a) === 'DISTINCT') {
            this.model.groupByDistinct = true;
            a++;
        } else if (this.word(a) === 'ALL') {
            a++;
        }
        const items: AstNode[] = node.groupClause;
        const spans = this.split(a, b, ',');
        const extra: string[] = [];
        if (spans.length !== items.length) {
            extra.push(this.text(a, b));
        } else {
            items.forEach((item, index) => {
                const [s, e] = spans[index];
                const text = this.text(s, e);
                if (item.GroupingSet) {
                    extra.push(text);
                    return;
                }
                const ordinal = intConst(item);
                if (ordinal !== undefined) {
                    const target = this.targetByOrdinal[ordinal - 1];
                    if (target) target.groupBy = true;
                    else extra.push(text);
                    return;
                }
                const key = normalizeExpressionKey(text);
                // A bare name is not matched against the output aliases:
                // PostgreSQL reads it as an input column first, which a
                // FROM table may have without the parser knowing.
                let column = this.model.columns.find((c) => !c.aggregate && normalizeExpressionKey(c.expression) === key);
                if (!column) {
                    column = this.columnFor(item, s, e, false);
                    if (column.aggregate) {
                        column.expression = text;
                        delete column.aggregate;
                    }
                    this.model.columns.push(column);
                }
                column.groupBy = true;
            });
        }
        if (extra.length > 0) {
            this.model.groupByExtra = extra;
            this.warn('Grouping sets (ROLLUP, CUBE, GROUPING SETS) are kept as raw SQL text.');
        }
    }

    private readHaving(having: AstNode, a: number, b: number): void {
        const extra: string[] = [];
        for (const part of this.splitBool(having, a, b, 'AND_EXPR')) {
            const p = this.splitPredicate(part.node, part.a, part.b);
            if (p && !(p.rhsNode && containsColumnRef(p.rhsNode, true, (ref) => this.isValueRef(ref)))) {
                const key = normalizeExpressionKey(p.lhs);
                const column = this.model.columns.find((c) => !c.having && normalizeExpressionKey(aggregatedExpression(c)) === key);
                if (column) {
                    column.having = p.rhs;
                    continue;
                }
                const agg = this.aggregateOf(p.lhsNode, p.a, p.opTok);
                if (agg) {
                    const hidden = this.columnFor(p.lhsNode, p.a, p.opTok, false);
                    hidden.having = p.rhs;
                    this.model.columns.push(hidden);
                    continue;
                }
            }
            extra.push(this.text(part.a, part.b));
        }
        if (extra.length > 0) {
            this.model.havingExtra = extra;
            this.warn('HAVING conditions that do not belong to a single aggregate are kept as raw SQL text.');
        }
    }

    // ----- ORDER BY / LIMIT -----

    private readOrderBy(items: AstNode[], a: number, b: number): void {
        const spans = this.split(a, b, ',');
        if (spans.length !== items.length) throw new Error('Could not read the ORDER BY clause.');
        items.forEach((item, index) => {
            const sb = item.SortBy ?? {};
            const [s] = spans[index];
            let e = spans[index][1];
            let nulls: 'FIRST' | 'LAST' | undefined;
            if (sb.sortby_nulls === 'SORTBY_NULLS_FIRST' || sb.sortby_nulls === 'SORTBY_NULLS_LAST') {
                nulls = sb.sortby_nulls === 'SORTBY_NULLS_FIRST' ? 'FIRST' : 'LAST';
                e -= 2;
            }
            let using: string | undefined;
            if (sb.sortby_dir === 'SORTBY_ASC' || sb.sortby_dir === 'SORTBY_DESC') {
                e--;
            } else if (sb.sortby_dir === 'SORTBY_USING') {
                const kw = this.lastDepth0Before(s, e, (i) => this.word(i) === 'USING');
                if (kw < 0) throw new Error('Could not read ORDER BY … USING.');
                using = this.text(kw + 1, e);
                e = kw;
            }
            const text = this.text(s, e);
            let column: QbColumn | undefined;
            const ordinal = intConst(sb.node);
            if (ordinal !== undefined) {
                column = this.targetByOrdinal[ordinal - 1];
            } else {
                const fields = sb.node?.ColumnRef?.fields;
                if (Array.isArray(fields) && fields.length === 1 && fields[0].String) {
                    column = this.model.columns.find((c) => c.output && c.alias === fields[0].String.sval);
                }
                if (!column) {
                    const key = normalizeExpressionKey(text);
                    const candidates = this.model.columns.filter((c) => normalizeExpressionKey(aggregatedExpression(c)) === key);
                    column = candidates.find((c) => c.output) ?? candidates[0];
                }
            }
            if (!column || column.sortType || column.sortUsing) {
                column = this.columnFor(sb.node, s, e, false);
                this.model.columns.push(column);
            }
            if (using) column.sortUsing = using;
            else column.sortType = sb.sortby_dir === 'SORTBY_DESC' ? 'DESC' : 'ASC';
            column.sortOrder = index + 1;
            if (nulls) column.nulls = nulls;
        });
    }

    private readFetch(a: number, b: number): void {
        let p = a;
        if (['FIRST', 'NEXT'].includes(this.word(p))) p++;
        const rowsTok = this.depth0(p, b).find((i) => ['ROW', 'ROWS'].includes(this.word(i)));
        const end = rowsTok ?? b;
        this.model.limit = end > p ? this.text(p, end) : '1';
        if (rowsTok !== undefined && this.word(rowsTok + 1) === 'WITH' && this.word(rowsTok + 2) === 'TIES') this.model.limitWithTies = true;
    }

    // ----- finishing -----

    private finish(s: number, e: number): void {
        const model = this.model;
        for (const c of model.columns) {
            while (c.criteria.length > 0 && !c.criteria[c.criteria.length - 1].trim()) c.criteria.pop();
        }
        const plain = (c: QbColumn) => !!c.tableId && !!c.column && c.column !== '*';
        if (model.columns.some((c) => !!c.aggregate) && model.columns.some((c) => c.output && !c.aggregate && plain(c) && !c.groupBy)) {
            model.autoGroupBy = false;
        }
        const statementStart = s < this.tokens.length ? this.tokens[s].start : this.sql.length;
        const statementEnd = e > 0 ? this.tokens[e - 1].end : 0;
        const lost = this.comments.filter((c) => c.start >= statementStart && c.end <= statementEnd &&
            !this.captured.some(([from, to]) => c.start >= from && c.end <= to));
        if (lost.length > 0) this.warn('Comments outside of expressions are not kept.');
        model.warnings = this.warnings;
    }
}
