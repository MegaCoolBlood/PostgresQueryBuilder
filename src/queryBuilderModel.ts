/**
 * The model of the graphical Query Builder: tables on a canvas, the joins
 * drawn between their columns and the column grid (output, expression, alias,
 * aggregate, sort, criteria with OR rows, GROUP BY, HAVING).
 *
 * Everything here is pure: the SQL generator, the edit helpers the UI calls
 * and a small SQL lexer used to compare and combine expression texts. Reading
 * SQL into a model is done by `parseSelect` in `queryBuilderParser.ts`, which
 * needs the PostgreSQL parser.
 *
 * What the diagram cannot show is kept as raw SQL text, never dropped: CTEs,
 * derived tables (subqueries in FROM), parenthesized joins that a flat join
 * sequence cannot express, set operations after the first SELECT
 * (`tail`), conditions that do not belong to a single column (`whereExtra`,
 * `havingExtra`), grouping sets (`groupByExtra`), WINDOW and locking clauses.
 *
 * Edit helpers never mutate their input; they return a new model.
 */
import { quoteIdentifier } from './ddlGenerator';
import { POSTGRES_RESERVED_KEYWORDS } from './reservedKeywords';
import { formatLiteralValue } from './statementBuilder';

// ===== Types ==================================================================

export type QbTableKind = 'relation' | 'subquery' | 'function';
export type QbJoinType = 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'CROSS';
export type QbSortType = 'ASC' | 'DESC';

/** The aggregates the grid offers; anything else stays part of the expression. */
export const QB_AGGREGATES = [
    'COUNT', 'COUNT DISTINCT', 'SUM', 'SUM DISTINCT', 'AVG', 'AVG DISTINCT', 'MIN', 'MAX', 'ARRAY_AGG'
] as const;
export type QbAggregate = typeof QB_AGGREGATES[number];

export interface QbTable {
    id: string;
    kind: QbTableKind;
    /** Actual (unquoted) names; quoting is added when SQL is generated. */
    schema?: string;
    name?: string;
    /** Raw SQL of a derived table (without its parentheses) or of a table function call. */
    sql?: string;
    alias?: string;
    /** Column aliases of `alias(a, b)`. */
    aliasColumns?: string[];
    lateral?: boolean;
    /** `ONLY table` — excludes inheritance children. */
    only?: boolean;
    /** Output columns of a derived table, read from its select list ('*' when it selects all). */
    columns?: string[];
    x?: number;
    y?: number;
}

export interface QbJoinPair {
    /** Column of the join's left table. */
    leftColumn: string;
    /** Column of the join's right table. */
    rightColumn: string;
    /** Comparison operator, `=` when omitted. */
    operator?: string;
}

export interface QbJoin {
    id: string;
    leftTableId: string;
    rightTableId: string;
    type: QbJoinType;
    pairs: QbJoinPair[];
    /** Raw condition AND-ed to the pairs (anything that is not `left.col op right.col`). */
    condition?: string;
    /** `USING (cols)`: every pair names the same column on both sides. */
    using?: boolean;
    natural?: boolean;
}

export interface QbColumn {
    id: string;
    /** The SQL expression, without aggregate and alias (e.g. `m.name`, `upper(m.name)`, `*`). */
    expression: string;
    /** Set when the expression is a plain column of a table of the model. */
    tableId?: string;
    column?: string;
    alias?: string;
    /** Whether the column is part of the select list; hidden columns only carry criteria, sort or grouping. */
    output: boolean;
    aggregate?: QbAggregate;
    sortType?: QbSortType;
    /** 1-based position in ORDER BY. */
    sortOrder?: number;
    nulls?: 'FIRST' | 'LAST';
    /** `ORDER BY x USING <op>`; replaces sortType. */
    sortUsing?: string;
    groupBy: boolean;
    /**
     * WHERE criteria rows: index 0 is the Criteria column, 1..n the Or columns.
     * Each entry is the right-hand side applied to the expression (`= 5`,
     * `LIKE 'a%'`, `IS NULL`, `BETWEEN 1 AND 3`); a bare value means `= value`.
     * Criteria of one row are AND-ed, the rows are OR-ed. Empty string = no criterion.
     */
    criteria: string[];
    /** Right-hand side of a HAVING condition on the (aggregated) expression. */
    having?: string;
}

export interface QbCte {
    name: string;
    /** Column aliases of `name(a, b) AS (...)`. */
    aliasColumns?: string[];
    /** true = MATERIALIZED, false = NOT MATERIALIZED, undefined = default. */
    materialized?: boolean;
    /** Raw SQL of the CTE body, without its parentheses. */
    sql: string;
    /** Output columns read from the body's select list (informational). */
    columns?: string[];
}

export interface QueryModel {
    distinct: boolean;
    /** Raw expressions of `DISTINCT ON (...)`. */
    distinctOn?: string[];
    recursive?: boolean;
    ctes: QbCte[];
    tables: QbTable[];
    joins: QbJoin[];
    columns: QbColumn[];
    /** Raw WHERE conditions AND-ed to the criteria grid. */
    whereExtra?: string[];
    /** Raw GROUP BY items (grouping sets, ROLLUP, CUBE). */
    groupByExtra?: string[];
    groupByDistinct?: boolean;
    /** Raw HAVING conditions AND-ed to the column HAVING entries. */
    havingExtra?: string[];
    /**
     * Group by every plain, non-aggregated output column as soon as one column
     * is aggregated (SQL Developer behaviour). Undefined means true; the parser
     * turns it off when the source query groups by less.
     */
    autoGroupBy?: boolean;
    /** Raw window definitions after WINDOW. */
    window?: string;
    limit?: string;
    offset?: string;
    /** `FETCH FIRST n ROWS WITH TIES` instead of LIMIT n. */
    limitWithTies?: boolean;
    /** Raw locking clause, e.g. `FOR UPDATE SKIP LOCKED`. */
    locking?: string;
    /** Raw text after the first SELECT: UNION/INTERSECT/EXCEPT branches and their ORDER BY/LIMIT. */
    tail?: string;
    warnings: string[];
}

/** A foreign key as read from the catalog (see `listForeignKeys` in queryBuilderCatalog.ts). */
export interface QbForeignKey {
    name?: string;
    schema: string;
    table: string;
    columns: string[];
    refSchema: string;
    refTable: string;
    refColumns: string[];
}

/**
 * A join edge from a custom column mapping (see `mappingJoinEdges` in
 * queryBuilderCatalog.ts), read like a foreign key from the mapping's source
 * (`schema.table`) to its target (`refSchema.refTable`).
 */
export interface QbMappingEdge extends QbForeignKey {
    mapping: true;
    /** Conditions on the source table (`column operator value`), AND-ed into the join. */
    conditions: Array<{ column: string; operator: string; value: string }>;
}

export interface GenerateSqlOptions {
    /** Indentation unit, four spaces by default. */
    indent?: string;
}

// ===== Lexer ==================================================================

export type SqlTokenType = 'word' | 'qident' | 'string' | 'number' | 'param' | 'op' | 'punct' | 'comment';

export interface SqlToken {
    type: SqlTokenType;
    text: string;
    /** Character offsets into the source string, `end` exclusive. */
    start: number;
    end: number;
    /** Upper-cased text of a word; the text itself otherwise. */
    upper: string;
}

const OP_CHARS = '+-*/<>=~!@#%^&|`?';
const OP_SPECIAL = '~!@#%^&|`?';

function isIdentStart(ch: string): boolean {
    return /[A-Za-z_\u0080-\uffff]/.test(ch);
}

function isIdentChar(ch: string): boolean {
    return /[A-Za-z0-9_$\u0080-\uffff]/.test(ch);
}

/** Index after a quoted run that starts at `i` (the opening quote), honouring doubled quotes. */
function skipQuoted(text: string, i: number, quote: string, backslash: boolean): number {
    let j = i + 1;
    while (j < text.length) {
        const ch = text[j];
        if (backslash && ch === '\\') {
            j += 2;
            continue;
        }
        if (ch === quote) {
            if (text[j + 1] === quote) {
                j += 2;
                continue;
            }
            return j + 1;
        }
        j++;
    }
    return text.length;
}

/** `:name`, `:'name'` or `:"name"` (psql style) at the start of the text. */
const PLACEHOLDER = /^:(?:[A-Za-z_][A-Za-z0-9_]*(?![A-Za-z0-9_$\u0080-\uffff])|'[A-Za-z_][A-Za-z0-9_]*'|"[A-Za-z_][A-Za-z0-9_]*")/;

/**
 * Split SQL into tokens following PostgreSQL's lexical rules closely enough to
 * find clause boundaries: strings (incl. E'', U&'', dollar quoting), quoted
 * identifiers, nested block comments, numbers, parameters and operators.
 *
 * Parameters are `$1` and the placeholders `:name`, `:'name'` and `:"name"`;
 * a colon inside an array subscript (`a[lo:hi]`) is a slice, not a placeholder.
 */
export function tokenizeSql(text: string): SqlToken[] {
    const tokens: SqlToken[] = [];
    const push = (type: SqlTokenType, start: number, end: number) => {
        const t = text.slice(start, end);
        tokens.push({ type, text: t, start, end, upper: type === 'word' ? t.toUpperCase() : t });
    };
    /** Open brackets: true for an array subscript, false for `ARRAY[…]`. */
    const brackets: boolean[] = [];
    const lastCode = (): SqlToken | undefined => {
        for (let k = tokens.length - 1; k >= 0; k--) if (tokens[k].type !== 'comment') return tokens[k];
        return undefined;
    };
    let i = 0;
    const n = text.length;
    while (i < n) {
        const ch = text[i];
        const next = text[i + 1];
        if (/\s/.test(ch)) {
            i++;
            continue;
        }
        if (ch === '-' && next === '-') {
            let j = text.indexOf('\n', i);
            if (j < 0) j = n;
            push('comment', i, j);
            i = j;
            continue;
        }
        if (ch === '/' && next === '*') {
            let depth = 1;
            let j = i + 2;
            while (j < n && depth > 0) {
                if (text[j] === '/' && text[j + 1] === '*') {
                    depth++;
                    j += 2;
                } else if (text[j] === '*' && text[j + 1] === '/') {
                    depth--;
                    j += 2;
                } else {
                    j++;
                }
            }
            push('comment', i, j);
            i = j;
            continue;
        }
        if (ch === "'") {
            const j = skipQuoted(text, i, "'", false);
            push('string', i, j);
            i = j;
            continue;
        }
        if ((ch === 'E' || ch === 'e') && next === "'") {
            const j = skipQuoted(text, i + 1, "'", true);
            push('string', i, j);
            i = j;
            continue;
        }
        if (/[BbXxNn]/.test(ch) && next === "'") {
            const j = skipQuoted(text, i + 1, "'", false);
            push('string', i, j);
            i = j;
            continue;
        }
        if ((ch === 'U' || ch === 'u') && next === '&' && (text[i + 2] === "'" || text[i + 2] === '"')) {
            const quote = text[i + 2];
            const j = skipQuoted(text, i + 2, quote, false);
            push(quote === '"' ? 'qident' : 'string', i, j);
            i = j;
            continue;
        }
        if (ch === '"') {
            const j = skipQuoted(text, i, '"', false);
            push('qident', i, j);
            i = j;
            continue;
        }
        if (ch === '$') {
            const param = /^\$\d+/.exec(text.slice(i, i + 12));
            if (param) {
                push('param', i, i + param[0].length);
                i += param[0].length;
                continue;
            }
            const tag = /^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/.exec(text.slice(i, i + 128));
            if (tag) {
                const close = text.indexOf(tag[0], i + tag[0].length);
                const j = close < 0 ? n : close + tag[0].length;
                push('string', i, j);
                i = j;
                continue;
            }
            push('punct', i, i + 1);
            i++;
            continue;
        }
        if (/[0-9]/.test(ch) || (ch === '.' && next !== undefined && /[0-9]/.test(next))) {
            const m = /^(0[xX][0-9A-Fa-f_]+|0[oO][0-7_]+|0[bB][01_]+|(\d[\d_]*(\.[\d_]*)?|\.\d[\d_]*)([eE][+-]?\d+)?)/.exec(text.slice(i));
            const len = m ? m[0].length : 1;
            push('number', i, i + len);
            i += len;
            continue;
        }
        if (isIdentStart(ch)) {
            let j = i + 1;
            while (j < n && isIdentChar(text[j])) j++;
            push('word', i, j);
            i = j;
            continue;
        }
        if (ch === ':' && next === ':') {
            push('op', i, i + 2);
            i += 2;
            continue;
        }
        if (ch === ':' && !brackets[brackets.length - 1]) {
            const placeholder = PLACEHOLDER.exec(text.slice(i, i + 130));
            if (placeholder) {
                push('param', i, i + placeholder[0].length);
                i += placeholder[0].length;
                continue;
            }
        }
        if (OP_CHARS.includes(ch)) {
            let j = i;
            while (j < n && OP_CHARS.includes(text[j])) {
                if (j > i && ((text[j] === '-' && text[j + 1] === '-') || (text[j] === '/' && text[j + 1] === '*'))) break;
                j++;
            }
            // PostgreSQL: a multi-character operator cannot end in + or - unless
            // it also contains one of ~ ! @ # % ^ & | ` ?
            while (j - i > 1 && '+-'.includes(text[j - 1]) && ![...text.slice(i, j)].some((c) => OP_SPECIAL.includes(c))) j--;
            push('op', i, j);
            i = j;
            continue;
        }
        if (ch === '[') {
            const before = lastCode();
            brackets.push(!(before && before.type === 'word' && before.upper === 'ARRAY'));
        } else if (ch === ']') {
            brackets.pop();
        }
        push('punct', i, i + 1);
        i++;
    }
    return tokens;
}

/** Lexer tokens without comments. */
function codeTokens(text: string): SqlToken[] {
    return tokenizeSql(text).filter((t) => t.type !== 'comment');
}

/**
 * A comparison key for an expression: case and whitespace of the source text
 * do not matter, nor quotes that PostgreSQL would not need
 * (`COUNT( "x" )` and `count(x)` have the same key).
 */
export function normalizeExpressionKey(expression: string): string {
    return codeTokens(expression).map((t) => {
        if (t.type === 'word') return t.text.toLowerCase();
        if (t.type === 'qident' && t.text.startsWith('"')) {
            const inner = t.text.slice(1, -1).replace(/""/g, '"');
            return quoteIdentifier(inner);
        }
        return t.text;
    }).join(' ');
}

/** Whether `text` contains a keyword from `words` outside of parentheses and CASE … END. */
function hasTopLevelWord(text: string, words: readonly string[]): boolean {
    let depth = 0;
    for (const t of codeTokens(text)) {
        if (t.text === '(' || t.text === '[' || (t.type === 'word' && t.upper === 'CASE')) depth++;
        else if (t.text === ')' || t.text === ']' || (t.type === 'word' && t.upper === 'END')) depth--;
        else if (depth === 0 && t.type === 'word' && words.includes(t.upper)) return true;
    }
    return false;
}

/** Whether a condition needs parentheses before it can be AND-ed with others. */
export function hasTopLevelOr(text: string): boolean {
    return hasTopLevelWord(text, ['OR']);
}

const CRITERIA_KEYWORDS = new Set(['LIKE', 'ILIKE', 'NOT', 'IN', 'IS', 'BETWEEN', 'SIMILAR', 'ISNULL', 'NOTNULL', 'OPERATOR']);

/**
 * The condition a criteria cell stands for: `expression criteria` when the
 * cell starts with an operator or a predicate keyword, else `expression = criteria`.
 */
export function criteriaCondition(expression: string, criteria: string): string {
    const rhs = criteria.trim();
    const first = codeTokens(rhs)[0];
    let lhs = expression.trim();
    if (hasTopLevelWord(lhs, ['AND', 'OR', 'NOT'])) lhs = `(${lhs})`;
    const isOperator = !!first && ((first.type === 'op' && first.text !== '::') || (first.type === 'word' && CRITERIA_KEYWORDS.has(first.upper)));
    return isOperator ? `${lhs} ${rhs}` : `${lhs} = ${rhs}`;
}

// ===== Names ==================================================================

/** The name a table is referred to by in expressions: its alias, else its (quoted) name. */
export function tableQualifier(table: QbTable): string {
    if (table.alias) return quoteIdentifier(table.alias);
    return quoteIdentifier(table.name ?? '');
}

/** The select-list expression of a plain table column, e.g. `m.name`. */
export function columnExpression(table: QbTable, column: string): string {
    return column === '*' ? `${tableQualifier(table)}.*` : `${tableQualifier(table)}.${quoteIdentifier(column)}`;
}

/** The expression with its aggregate applied, e.g. `COUNT(DISTINCT m.id)`. */
export function aggregatedExpression(column: Pick<QbColumn, 'expression' | 'aggregate'>): string {
    if (!column.aggregate) return column.expression;
    const [fn, distinct] = column.aggregate.split(' ');
    return `${fn}(${distinct ? 'DISTINCT ' : ''}${column.expression})`;
}

// ===== SQL generation =========================================================

function aliasClause(alias: string | undefined, aliasColumns: string[] | undefined): string {
    if (!alias) return '';
    const cols = aliasColumns && aliasColumns.length > 0 ? `(${aliasColumns.map(quoteIdentifier).join(', ')})` : '';
    return ` ${quoteIdentifier(alias)}${cols}`;
}

/** The FROM-clause text of one table, e.g. `public.orders o` or `(SELECT …) s`. */
export function tableReference(table: QbTable): string {
    const alias = aliasClause(table.alias, table.aliasColumns);
    const lateral = table.lateral ? 'LATERAL ' : '';
    if (table.kind === 'subquery') return `${lateral}(${(table.sql ?? '').trim()})${alias}`;
    if (table.kind === 'function') return `${lateral}${(table.sql ?? '').trim()}${alias}`;
    const name = (table.schema ? `${quoteIdentifier(table.schema)}.` : '') + quoteIdentifier(table.name ?? '');
    return `${table.only ? 'ONLY ' : ''}${name}${alias}`;
}

function flipJoinType(type: QbJoinType): QbJoinType {
    if (type === 'LEFT') return 'RIGHT';
    if (type === 'RIGHT') return 'LEFT';
    return type;
}

function joinPairCondition(left: QbTable, right: QbTable, pair: QbJoinPair): string {
    return `${columnExpression(left, pair.leftColumn)} ${pair.operator || '='} ${columnExpression(right, pair.rightColumn)}`;
}

/** The type of `join` read with `newId` as the table joined last. */
function joinTypeFor(join: QbJoin, newId: string): QbJoinType {
    return join.leftTableId === newId ? flipJoinType(join.type) : join.type;
}

function isPlainInnerJoin(join: QbJoin): boolean {
    return (join.type === 'INNER' || join.type === 'CROSS') && !join.natural && !join.using;
}

/** The FROM line that joins `table` along `edges`, all its joins to the tables placed before it. */
function joinLine(table: QbTable, edges: QbJoin[], byId: Map<string, QbTable>): string {
    if (edges.length === 0) return `CROSS JOIN ${tableReference(table)}`;
    let type = joinTypeFor(edges[0], table.id);
    const conditions: string[] = [];
    for (const j of edges) {
        const left = byId.get(j.leftTableId) as QbTable;
        const right = byId.get(j.rightTableId) as QbTable;
        conditions.push(...j.pairs.map((p) => joinPairCondition(left, right, p)));
        if (j.condition && j.condition.trim()) conditions.push(j.condition.trim());
    }
    const single = edges.length === 1 ? edges[0] : undefined;
    if (single && single.natural) return `NATURAL ${type === 'CROSS' ? 'INNER' : type} JOIN ${tableReference(table)}`;
    if (single && single.using && single.pairs.length > 0 && !single.condition && single.pairs.every((p) => p.leftColumn === p.rightColumn && (!p.operator || p.operator === '='))) {
        return `${type === 'CROSS' ? 'INNER' : type} JOIN ${tableReference(table)} USING (${single.pairs.map((p) => quoteIdentifier(p.leftColumn)).join(', ')})`;
    }
    if (conditions.length === 0) return type === 'CROSS' ? `CROSS JOIN ${tableReference(table)}` : `${type} JOIN ${tableReference(table)} ON true`;
    if (type === 'CROSS') type = 'INNER';
    const on = conditions.map((c) => (conditions.length > 1 && hasTopLevelOr(c) ? `(${c})` : c));
    return `${type} JOIN ${tableReference(table)} ON ${on.join(' AND ')}`;
}

/**
 * The tables of one connected component in the order of the model (the
 * source order, which decides the columns of `SELECT *`), each with its joins
 * to the tables before it. A table joined to later tables only is CROSS JOINed
 * and its conditions go to the join of the later table. Undefined when that
 * order could change the meaning of the query: NATURAL or USING joins, a RIGHT
 * or FULL join, or a table whose joins to the tables before it differ in type.
 */
function sourceOrderSteps(tables: QbTable[], joins: QbJoin[]): Array<{ table: QbTable; edges: QbJoin[] }> | undefined {
    if (joins.some((j) => j.natural || j.using)) return undefined;
    const kind = (join: QbJoin, newId: string) => {
        const type = joinTypeFor(join, newId);
        return type === 'CROSS' ? 'INNER' : type;
    };
    const placed = new Set([tables[0].id]);
    const steps: Array<{ table: QbTable; edges: QbJoin[] }> = [];
    for (const table of tables.slice(1)) {
        const edges = joins.filter((j) => (j.leftTableId === table.id && placed.has(j.rightTableId)) || (j.rightTableId === table.id && placed.has(j.leftTableId)));
        if (edges.length === 0) {
            if (joins.some((j) => (j.leftTableId === table.id || j.rightTableId === table.id) && !isPlainInnerJoin(j))) return undefined;
        } else {
            const first = kind(edges[0], table.id);
            if (first === 'RIGHT' || first === 'FULL' || edges.some((j) => kind(j, table.id) !== first)) return undefined;
        }
        steps.push({ table, edges });
        placed.add(table.id);
    }
    return steps;
}

/** The tables of one connected component along its joins, in the order of the joins, starting with the first. */
function joinWalkSteps(tables: QbTable[], joins: QbJoin[]): Array<{ table: QbTable; edges: QbJoin[] }> {
    const byId = new Map(tables.map((t) => [t.id, t]));
    const component = new Set([tables[0].id]);
    const used = new Set<string>();
    const steps: Array<{ table: QbTable; edges: QbJoin[] }> = [];
    for (;;) {
        const edge = joins.find((j) => !used.has(j.id) && component.has(j.leftTableId) !== component.has(j.rightTableId));
        if (!edge) break;
        const newId = component.has(edge.leftTableId) ? edge.rightTableId : edge.leftTableId;
        const edges = joins.filter((j) => !used.has(j.id) && (
            (j.leftTableId === newId && component.has(j.rightTableId)) ||
            (j.rightTableId === newId && component.has(j.leftTableId))));
        edges.forEach((j) => used.add(j.id));
        steps.push({ table: byId.get(newId) as QbTable, edges });
        component.add(newId);
    }
    return steps;
}
/** The lines of the FROM clause: each table once, joined along the model's joins. */
function fromLines(model: QueryModel, ind: string): string[] {
    const byId = new Map(model.tables.map((t) => [t.id, t]));
    const joins = model.joins.filter((j) => byId.has(j.leftTableId) && byId.has(j.rightTableId) && j.leftTableId !== j.rightTableId);
    // Only `SELECT *` shows the order of the tables; other queries follow their joins.
    const keepOrder = model.columns.some((c) => c.output && !c.aggregate && c.expression.trim() === '*');
    const placed = new Set<string>();
    const components: string[][] = [];
    for (const first of model.tables) {
        if (placed.has(first.id)) continue;
        const members = new Set([first.id]);
        for (let grown = true; grown;) {
            grown = false;
            for (const j of joins) {
                if (members.has(j.leftTableId) !== members.has(j.rightTableId)) {
                    members.add(j.leftTableId);
                    members.add(j.rightTableId);
                    grown = true;
                }
            }
        }
        const tables = model.tables.filter((t) => members.has(t.id) && !placed.has(t.id));
        const edges = joins.filter((j) => members.has(j.leftTableId));
        const steps = (keepOrder ? sourceOrderSteps(tables, edges) : undefined) ?? joinWalkSteps(tables, edges);
        const lines = [`${ind}${tableReference(first)}`, ...steps.map((s) => `${ind}${joinLine(s.table, s.edges, byId)}`)];
        tables.forEach((t) => placed.add(t.id));
        components.push(lines);
    }
    return components.flatMap((lines, i) => (i < components.length - 1 ? [...lines.slice(0, -1), `${lines[lines.length - 1]},`] : lines));
}
function criteriaRowCount(model: QueryModel): number {
    return model.columns.reduce((max, c) => Math.max(max, c.criteria.length), 0);
}

function wrapOr(condition: string): string {
    return hasTopLevelOr(condition) ? `(${condition})` : condition;
}

function whereConditions(model: QueryModel, ind: string): string[] {
    const rows: string[][] = [];
    for (let r = 0; r < criteriaRowCount(model); r++) {
        const row = model.columns
            .filter((c) => (c.criteria[r] ?? '').trim() !== '')
            .map((c) => criteriaCondition(c.expression, c.criteria[r]));
        if (row.length > 0) rows.push(row);
    }
    const parts: string[] = [];
    if (rows.length === 1) {
        parts.push(...rows[0].map(wrapOr));
    } else if (rows.length > 1) {
        const ored = rows.map((row) => (row.length > 1 ? `(${row.map(wrapOr).join(' AND ')})` : wrapOr(row[0])));
        const extras = (model.whereExtra ?? []).length > 0;
        if (extras) {
            parts.push(`(\n${ored.map((o, i) => `${ind}${ind}${i > 0 ? 'OR ' : ''}${o}`).join('\n')}\n${ind})`);
        } else {
            parts.push(ored.join(`\n${ind}OR `));
        }
    }
    for (const extra of model.whereExtra ?? []) {
        if (extra.trim()) parts.push(wrapOr(extra.trim()));
    }
    return parts;
}

/** A column that is a plain column reference of a table (what auto GROUP BY considers). */
function isPlainColumn(column: QbColumn): boolean {
    return !!column.tableId && !!column.column && column.column !== '*';
}

/** The expressions of GROUP BY: flagged columns plus, with auto grouping, plain output columns. */
export function groupByExpressions(model: QueryModel): string[] {
    const auto = model.autoGroupBy !== false && model.columns.some((c) => !!c.aggregate);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of model.columns) {
        if (c.aggregate) continue;
        if (!(c.groupBy || (auto && c.output && isPlainColumn(c)))) continue;
        const key = normalizeExpressionKey(c.expression);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c.expression.trim());
    }
    return out;
}

function sortedColumns(model: QueryModel): QbColumn[] {
    return model.columns
        .map((c, index) => ({ c, index }))
        .filter(({ c }) => !!c.sortType || !!c.sortUsing)
        .sort((a, b) => ((a.c.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.c.sortOrder ?? Number.MAX_SAFE_INTEGER)) || a.index - b.index)
        .map(({ c }) => c);
}

function section(keyword: string, items: string[], ind: string, separator: string): string {
    return `${keyword}\n${items.map((item, i) => `${ind}${i > 0 ? separator : ''}${item}`).join('\n')}`;
}

/**
 * Readable, deterministic SQL for the model: one select item, table and
 * condition per line. WHERE combines the criteria grid like SQL Developer —
 * criteria of the same row are AND-ed, rows are OR-ed — and AND-s `whereExtra`.
 */
export function generateSql(model: QueryModel, options: GenerateSqlOptions = {}): string {
    const ind = options.indent ?? '    ';
    const out: string[] = [];
    if (model.ctes.length > 0) {
        const ctes = model.ctes.map((cte) => {
            const cols = cte.aliasColumns && cte.aliasColumns.length > 0 ? `(${cte.aliasColumns.map(quoteIdentifier).join(', ')})` : '';
            const mat = cte.materialized === true ? 'MATERIALIZED ' : cte.materialized === false ? 'NOT MATERIALIZED ' : '';
            // A one-line body is indented; a multi-line one is kept verbatim so
            // that line breaks inside its string literals stay untouched.
            const body = cte.sql.trim();
            return `${quoteIdentifier(cte.name)}${cols} AS ${mat}(\n${body.includes('\n') ? body : ind + body}\n)`;
        });
        out.push(`WITH ${model.recursive ? 'RECURSIVE ' : ''}${ctes.join(',\n')}`);
    }
    let select = 'SELECT';
    if (model.distinctOn && model.distinctOn.length > 0) select += ` DISTINCT ON (${model.distinctOn.map((d) => d.trim()).join(', ')})`;
    else if (model.distinct) select += ' DISTINCT';
    const items = model.columns
        .filter((c) => c.output)
        .map((c) => `${aggregatedExpression(c)}${c.alias ? ` AS ${quoteIdentifier(c.alias)}` : ''}`);
    out.push(`${select}\n${(items.length > 0 ? items : ['*']).map((item) => `${ind}${item}`).join(',\n')}`);
    if (model.tables.length > 0) out.push(`FROM\n${fromLines(model, ind).join('\n')}`);
    const where = whereConditions(model, ind);
    if (where.length > 0) out.push(section('WHERE', where, ind, 'AND '));
    const groupBy = [...groupByExpressions(model), ...(model.groupByExtra ?? []).map((g) => g.trim()).filter((g) => g)];
    if (groupBy.length > 0) out.push(`GROUP BY${model.groupByDistinct ? ' DISTINCT' : ''}\n${groupBy.map((g) => `${ind}${g}`).join(',\n')}`);
    const having = [
        ...model.columns.filter((c) => c.having && c.having.trim()).map((c) => wrapOr(criteriaCondition(aggregatedExpression(c), c.having as string))),
        ...(model.havingExtra ?? []).filter((h) => h.trim()).map((h) => wrapOr(h.trim()))
    ];
    if (having.length > 0) out.push(section('HAVING', having, ind, 'AND '));
    if (model.window && model.window.trim()) out.push(`WINDOW ${model.window.trim()}`);
    const sorted = sortedColumns(model);
    if (sorted.length > 0) {
        const orderItems = sorted.map((c) => {
            const target = c.output && c.alias ? quoteIdentifier(c.alias) : aggregatedExpression(c);
            const dir = c.sortUsing ? ` USING ${c.sortUsing}` : ` ${c.sortType}`;
            return `${target}${dir}${c.nulls ? ` NULLS ${c.nulls}` : ''}`;
        });
        out.push(`ORDER BY\n${orderItems.map((o) => `${ind}${o}`).join(',\n')}`);
    }
    const limit = model.limit?.trim();
    const offset = model.offset?.trim();
    if (model.limitWithTies && limit) {
        if (offset) out.push(`OFFSET ${offset} ROWS`);
        out.push(`FETCH FIRST ${limit} ROWS WITH TIES`);
    } else {
        if (limit) out.push(`LIMIT ${limit}`);
        if (offset) out.push(`OFFSET ${offset}`);
    }
    if (model.locking && model.locking.trim()) out.push(model.locking.trim());
    if (model.tail && model.tail.trim()) out.push(model.tail.trim());
    return out.join('\n');
}

// ===== Edit helpers ===========================================================

/** An empty model. */
export function createEmptyModel(): QueryModel {
    return { distinct: false, ctes: [], tables: [], joins: [], columns: [], warnings: [] };
}

function cloneModel(model: QueryModel): QueryModel {
    return JSON.parse(JSON.stringify(model)) as QueryModel;
}

/** A new id `<prefix><n>` that no table, join or column of the model uses. */
export function nextId(model: QueryModel, prefix: string): string {
    const used = new Set<string>([...model.tables.map((t) => t.id), ...model.joins.map((j) => j.id), ...model.columns.map((c) => c.id)]);
    let max = 0;
    for (const id of used) {
        if (id.startsWith(prefix)) {
            const n = Number(id.slice(prefix.length));
            if (Number.isInteger(n) && n > max) max = n;
        }
    }
    let n = max + 1;
    while (used.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
}

const SIMPLE_ALIAS = /^[a-z_][a-z0-9_]*$/;

/**
 * A short alias for a new table that no other table of the model uses: the
 * prefix of the first column before `_` (`lei_id` → `lei`, the convention of
 * the extension's SELECT generator), else the initials of the table name
 * (`order_items` → `oi`), made unique with a number (`oi2`).
 */
export function suggestTableAlias(model: QueryModel, tableName: string, firstColumn?: string): string {
    const usable = (a: string) => SIMPLE_ALIAS.test(a) && !POSTGRES_RESERVED_KEYWORDS.has(a);
    const candidates: string[] = [];
    if (firstColumn) {
        const underscore = firstColumn.indexOf('_');
        if (underscore > 0) candidates.push(firstColumn.slice(0, underscore).toLowerCase());
    }
    const initials = tableName.toLowerCase().split(/[^a-z0-9]+/).filter((p) => p).map((p) => p[0]).join('');
    candidates.push(initials);
    const base = candidates.find(usable) ?? 't';
    const taken = new Set(model.tables.map((t) => (t.alias ?? t.name ?? '').toLowerCase()));
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base}${n}`)) n++;
    return `${base}${n}`;
}

export interface AddTableInput {
    kind?: QbTableKind;
    schema?: string;
    name?: string;
    sql?: string;
    alias?: string;
    /** Columns of the relation; the first one feeds the alias suggestion. */
    columns?: string[];
    x?: number;
    y?: number;
}

/**
 * Add a table with a unique alias and, unless `autoJoin` is false, join it to
 * the tables already on the canvas along the given foreign keys (both
 * directions, one INNER join per foreign key, partner = first matching table).
 * A custom-mapping edge ({@link QbMappingEdge}) joins the same way; when a
 * foreign key already joins the two tables its pairs are added to that join
 * (without repeating a pair) and its conditions are AND-ed to the join.
 */
export function addTable(
    model: QueryModel,
    input: AddTableInput,
    foreignKeys: ReadonlyArray<QbForeignKey | QbMappingEdge> = [],
    options: { autoJoin?: boolean } = {}
): { model: QueryModel; table: QbTable; joins: QbJoin[] } {
    const next = cloneModel(model);
    const kind = input.kind ?? 'relation';
    const table: QbTable = {
        id: nextId(next, 't'),
        kind,
        alias: input.alias ?? suggestTableAlias(next, input.name ?? kind, input.columns?.[0])
    };
    if (input.schema !== undefined) table.schema = input.schema;
    if (input.name !== undefined) table.name = input.name;
    if (input.sql !== undefined) table.sql = input.sql;
    if (kind !== 'relation' && input.columns) table.columns = [...input.columns];
    if (input.x !== undefined) table.x = input.x;
    if (input.y !== undefined) table.y = input.y;
    const existing = next.tables.filter((t) => t.kind === 'relation');
    next.tables.push(table);
    const added: QbJoin[] = [];
    if (options.autoJoin !== false && kind === 'relation' && input.name) {
        const same = (t: QbTable, schema: string, name: string) => t.name === name && (t.schema === undefined || t.schema === schema);
        const isMapping = (edge: QbForeignKey | QbMappingEdge): edge is QbMappingEdge => (edge as QbMappingEdge).mapping === true;
        // Foreign keys first, so a mapping between the same tables joins their join.
        const edges = [...foreignKeys.filter((e) => !isMapping(e)), ...foreignKeys.filter(isMapping)];
        for (const fk of edges) {
            if (fk.columns.length === 0 || fk.columns.length !== fk.refColumns.length) continue;
            const fromNew = fk.table === input.name && (input.schema === undefined || fk.schema === input.schema);
            const toNew = fk.refTable === input.name && (input.schema === undefined || fk.refSchema === input.schema);
            if (fromNew === toNew) continue;
            const partner = fromNew
                ? existing.find((t) => same(t, fk.refSchema, fk.refTable))
                : existing.find((t) => same(t, fk.schema, fk.table));
            if (!partner) continue;
            const pairs: QbJoinPair[] = fromNew
                ? fk.refColumns.map((rc, i) => ({ leftColumn: rc, rightColumn: fk.columns[i] }))
                : fk.columns.map((c, i) => ({ leftColumn: c, rightColumn: fk.refColumns[i] }));
            if (!isMapping(fk)) {
                const join: QbJoin = { id: nextId(next, 'j'), leftTableId: partner.id, rightTableId: table.id, type: 'INNER', pairs };
                next.joins.push(join);
                added.push(join);
                continue;
            }
            const source = fromNew ? table : partner;
            const conditions = fk.conditions.map((c) => `${columnExpression(source, c.column)} ${c.operator} ${formatLiteralValue(c.value)}`);
            const join = added.find((j) => j.leftTableId === partner.id);
            if (!join) {
                const created: QbJoin = { id: nextId(next, 'j'), leftTableId: partner.id, rightTableId: table.id, type: 'INNER', pairs };
                if (conditions.length) created.condition = conditions.join(' AND ');
                next.joins.push(created);
                added.push(created);
                continue;
            }
            const key = (p: QbJoinPair) => `${p.leftColumn.toLowerCase()}\u0000${p.rightColumn.toLowerCase()}\u0000${p.operator ?? '='}`;
            const known = new Set(join.pairs.map(key));
            join.pairs.push(...pairs.filter((p) => !known.has(key(p))));
            if (conditions.length) join.condition = [join.condition, ...conditions].filter((c) => c).join(' AND ');
        }
    }
    return { model: next, table, joins: added };
}

/** Remove a table with its joins and the grid columns of its columns. */
export function removeTable(model: QueryModel, tableId: string): QueryModel {
    const next = cloneModel(model);
    next.tables = next.tables.filter((t) => t.id !== tableId);
    next.joins = next.joins.filter((j) => j.leftTableId !== tableId && j.rightTableId !== tableId);
    next.columns = renumberSort(next.columns.filter((c) => c.tableId !== tableId));
    return next;
}

/** Move a table on the canvas. */
export function moveTable(model: QueryModel, tableId: string, x: number, y: number): QueryModel {
    const next = cloneModel(model);
    const table = next.tables.find((t) => t.id === tableId);
    if (table) {
        table.x = x;
        table.y = y;
    }
    return next;
}

function sameWord(token: SqlToken, name: string): boolean {
    if (token.type === 'word') return token.text.toLowerCase() === name;
    if (token.type === 'qident' && token.text.startsWith('"')) return token.text.slice(1, -1).replace(/""/g, '"') === name;
    return false;
}

/** Replace `old.` qualifiers in an expression by `replacement.`. */
export function renameQualifier(expression: string, oldName: string, replacement: string): string {
    const tokens = tokenizeSql(expression);
    let out = '';
    let pos = 0;
    tokens.forEach((t, i) => {
        const prev = tokens[i - 1];
        const dot = tokens[i + 1];
        if (sameWord(t, oldName) && dot && dot.text === '.' && dot.start === t.end && !(prev && prev.text === '.' && prev.end === t.start)) {
            out += expression.slice(pos, t.start) + replacement;
            pos = t.end;
        }
    });
    return out + expression.slice(pos);
}

/**
 * Change the alias of a table (empty = no alias) and rewrite the qualifiers in
 * every expression, criteria, HAVING entry and join condition of the model.
 */
export function setTableAlias(model: QueryModel, tableId: string, alias: string | undefined): QueryModel {
    const next = cloneModel(model);
    const table = next.tables.find((t) => t.id === tableId);
    if (!table) return next;
    const oldName = table.alias ?? table.name ?? '';
    const newAlias = alias && alias.trim() ? alias.trim() : undefined;
    if (newAlias) table.alias = newAlias;
    else delete table.alias;
    const replacement = tableQualifier(table);
    const rename = (text: string) => renameQualifier(text, oldName, replacement);
    for (const c of next.columns) {
        c.expression = c.tableId === tableId && c.column ? columnExpression(table, c.column) : rename(c.expression);
        c.criteria = c.criteria.map(rename);
        if (c.having) c.having = rename(c.having);
    }
    for (const j of next.joins) {
        if (j.condition) j.condition = rename(j.condition);
    }
    if (next.whereExtra) next.whereExtra = next.whereExtra.map(rename);
    if (next.havingExtra) next.havingExtra = next.havingExtra.map(rename);
    if (next.distinctOn) next.distinctOn = next.distinctOn.map(rename);
    return next;
}

/** The columns of a table that are ticked (plain output columns of the grid). */
export function selectedColumns(model: QueryModel, tableId: string): string[] {
    return model.columns.filter((c) => c.output && c.tableId === tableId && c.column).map((c) => c.column as string);
}

function hasGridSettings(c: QbColumn): boolean {
    return !!c.sortType || !!c.sortUsing || c.groupBy || !!c.having || c.criteria.some((x) => x.trim() !== '') || !!c.aggregate || !!c.alias;
}

/**
 * Tick or untick a column of a table. Ticking adds a grid column (or shows a
 * hidden one); unticking hides it, or removes it when it carries no criteria,
 * sort, grouping, aggregate or alias.
 */
export function toggleColumn(model: QueryModel, tableId: string, column: string, output?: boolean): QueryModel {
    const next = cloneModel(model);
    const table = next.tables.find((t) => t.id === tableId);
    if (!table) return next;
    const existing = next.columns.filter((c) => c.tableId === tableId && c.column === column);
    const isOn = existing.some((c) => c.output);
    const target = output ?? !isOn;
    if (target === isOn) return next;
    if (target) {
        const hidden = existing.find((c) => !c.output);
        if (hidden) {
            hidden.output = true;
        } else {
            next.columns.push({ id: nextId(next, 'c'), expression: columnExpression(table, column), tableId, column, output: true, groupBy: false, criteria: [] });
        }
        return next;
    }
    for (const c of existing.filter((x) => x.output)) {
        if (hasGridSettings(c)) c.output = false;
        else next.columns = next.columns.filter((x) => x.id !== c.id);
    }
    next.columns = renumberSort(next.columns);
    return next;
}

/** Append a grid column (e.g. a free expression); returns the new model and column. */
export function addColumn(model: QueryModel, column: Partial<Omit<QbColumn, 'id'>> & { expression: string }): { model: QueryModel; column: QbColumn } {
    const next = cloneModel(model);
    const created: QbColumn = { output: true, groupBy: false, criteria: [], ...JSON.parse(JSON.stringify(column)), id: nextId(next, 'c') };
    next.columns.push(created);
    return { model: next, column: created };
}

/** Change fields of a grid column. `undefined` values remove optional fields. */
export function updateColumn(model: QueryModel, columnId: string, patch: Partial<Omit<QbColumn, 'id'>>): QueryModel {
    const next = cloneModel(model);
    const column = next.columns.find((c) => c.id === columnId);
    if (!column) return next;
    const target = column as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete target[key];
        else target[key] = JSON.parse(JSON.stringify(value));
    }
    next.columns = renumberSort(next.columns);
    return next;
}

export function removeColumn(model: QueryModel, columnId: string): QueryModel {
    const next = cloneModel(model);
    next.columns = renumberSort(next.columns.filter((c) => c.id !== columnId));
    return next;
}

/** Move a grid column to `toIndex` (clamped), changing the select-list order. */
export function moveColumn(model: QueryModel, columnId: string, toIndex: number): QueryModel {
    const next = cloneModel(model);
    const from = next.columns.findIndex((c) => c.id === columnId);
    if (from < 0) return next;
    const [column] = next.columns.splice(from, 1);
    const to = Math.max(0, Math.min(next.columns.length, Math.trunc(toIndex)));
    next.columns.splice(to, 0, column);
    return next;
}

/** Make sortOrder 1..n without gaps, keeping the relative order. */
function renumberSort(columns: QbColumn[]): QbColumn[] {
    const sorted = columns
        .map((c, index) => ({ c, index }))
        .filter(({ c }) => !!c.sortType || !!c.sortUsing)
        .sort((a, b) => ((a.c.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.c.sortOrder ?? Number.MAX_SAFE_INTEGER)) || a.index - b.index);
    sorted.forEach(({ c }, i) => { c.sortOrder = i + 1; });
    for (const c of columns) {
        if (!c.sortType && !c.sortUsing) delete c.sortOrder;
    }
    return columns;
}

/**
 * Set or clear the sort of a column. A new sort goes last unless `sortOrder`
 * is given, in which case the column is inserted at that position.
 */
export function setSort(model: QueryModel, columnId: string, sortType: QbSortType | undefined, sortOrder?: number, nulls?: 'FIRST' | 'LAST'): QueryModel {
    const next = cloneModel(model);
    const column = next.columns.find((c) => c.id === columnId);
    if (!column) return next;
    if (!sortType) {
        delete column.sortType;
        delete column.sortOrder;
        delete column.nulls;
        delete column.sortUsing;
        next.columns = renumberSort(next.columns);
        return next;
    }
    const others = next.columns.filter((c) => c !== column && (c.sortType || c.sortUsing));
    const max = others.reduce((m, c) => Math.max(m, c.sortOrder ?? 0), 0);
    const position = sortOrder ?? (column.sortType || column.sortUsing ? column.sortOrder ?? max + 1 : max + 1);
    for (const c of others) {
        if ((c.sortOrder ?? 0) >= position) c.sortOrder = (c.sortOrder ?? 0) + 1;
    }
    column.sortType = sortType;
    delete column.sortUsing;
    column.sortOrder = position - 0.5;
    if (nulls) column.nulls = nulls;
    else delete column.nulls;
    next.columns = renumberSort(next.columns);
    return next;
}

/** Set one criteria cell (row 0 = Criteria, 1.. = Or columns); empty text clears it. */
export function setCriteria(model: QueryModel, columnId: string, row: number, text: string): QueryModel {
    const next = cloneModel(model);
    const column = next.columns.find((c) => c.id === columnId);
    if (!column || row < 0) return next;
    while (column.criteria.length <= row) column.criteria.push('');
    column.criteria[row] = text;
    while (column.criteria.length > 0 && column.criteria[column.criteria.length - 1].trim() === '') column.criteria.pop();
    return next;
}

/** Number of criteria rows in use (Criteria + Or columns). */
export function criteriaRows(model: QueryModel): number {
    return criteriaRowCount(model);
}

/** Add a join between two tables; returns the new model and join. */
export function addJoin(
    model: QueryModel,
    join: { leftTableId: string; rightTableId: string; type?: QbJoinType; pairs?: QbJoinPair[]; condition?: string }
): { model: QueryModel; join: QbJoin } {
    const next = cloneModel(model);
    const created: QbJoin = {
        id: nextId(next, 'j'),
        leftTableId: join.leftTableId,
        rightTableId: join.rightTableId,
        type: join.type ?? 'INNER',
        pairs: (join.pairs ?? []).map((p) => ({ ...p }))
    };
    if (join.condition) created.condition = join.condition;
    next.joins.push(created);
    return { model: next, join: created };
}

/**
 * Join two columns, as when a column is dragged onto another: adds the pair
 * to an existing join of the two tables or creates an INNER join.
 */
export function connectColumns(model: QueryModel, leftTableId: string, leftColumn: string, rightTableId: string, rightColumn: string): QueryModel {
    const existing = model.joins.find((j) => (j.leftTableId === leftTableId && j.rightTableId === rightTableId) || (j.leftTableId === rightTableId && j.rightTableId === leftTableId));
    if (!existing) return addJoin(model, { leftTableId, rightTableId, pairs: [{ leftColumn, rightColumn }] }).model;
    const pair = existing.leftTableId === leftTableId ? { leftColumn, rightColumn } : { leftColumn: rightColumn, rightColumn: leftColumn };
    if (existing.pairs.some((p) => p.leftColumn === pair.leftColumn && p.rightColumn === pair.rightColumn)) return cloneModel(model);
    return updateJoin(model, existing.id, { pairs: [...existing.pairs, pair], natural: undefined });
}

/** Change fields of a join. `undefined` values remove optional fields. */
export function updateJoin(model: QueryModel, joinId: string, patch: Partial<Omit<QbJoin, 'id'>>): QueryModel {
    const next = cloneModel(model);
    const join = next.joins.find((j) => j.id === joinId);
    if (!join) return next;
    const target = join as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete target[key];
        else target[key] = JSON.parse(JSON.stringify(value));
    }
    return next;
}

export function removeJoin(model: QueryModel, joinId: string): QueryModel {
    const next = cloneModel(model);
    next.joins = next.joins.filter((j) => j.id !== joinId);
    return next;
}

/**
 * Assign unqualified grid columns (`SELECT name FROM a JOIN b …`) to the one
 * table whose catalog columns contain the name. Ambiguous names stay unassigned.
 */
export function resolveColumnTables(model: QueryModel, columnsByTable: Readonly<Record<string, readonly string[]>>): QueryModel {
    const next = cloneModel(model);
    for (const c of next.columns) {
        if (c.tableId) continue;
        const tokens = codeTokens(c.expression);
        if (tokens.length !== 1 || (tokens[0].type !== 'word' && tokens[0].type !== 'qident')) continue;
        const name = tokens[0].type === 'word' ? tokens[0].text.toLowerCase() : tokens[0].text.slice(1, -1).replace(/""/g, '"');
        const owners = next.tables.filter((t) => (columnsByTable[t.id] ?? []).includes(name));
        if (owners.length === 1) {
            c.tableId = owners[0].id;
            c.column = name;
        }
    }
    return next;
}
