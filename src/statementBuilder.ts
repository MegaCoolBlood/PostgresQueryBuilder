import { escapeSqlLiteral } from './sqlUtils';

export type StatementKind = 'name' | 'insert' | 'delete' | 'update' | 'select' | 'join';

/**
 * Derive a default table alias/qualifier.
 *
 * If the first column name contains one or more underscores, the part before
 * the first underscore is used (e.g. `lei_id` -> `lei`). Otherwise the table
 * name itself is used as a fallback.
 */
export function deriveQualifier(firstColumnName: string | null, table: string): string {
    if (firstColumnName) {
        const underscore = firstColumnName.indexOf('_');
        if (underscore > 0) {
            return firstColumnName.slice(0, underscore);
        }
    }
    return table;
}

/**
 * Build a SQL statement skeleton for the given kind. `columns` must be the
 * already-quoted column identifiers and `tableReference` the (optionally
 * schema-qualified) table reference.
 */
export function buildStatement(
    kind: StatementKind,
    opts: { tableReference: string; columns: string[]; qualifier: string; columnTypes?: string[] }
): string {
    const { tableReference, columns, qualifier, columnTypes = [] } = opts;
    const q = qualifier;
    const hasColumns = columns.length > 0;
    const selectCols = hasColumns ? columns : ['*'];
    const firstCol = selectCols[0];

    switch (kind) {
        case 'name':
            return tableReference;
        case 'select': {
            const list = selectCols.map(c => `  ${q}.${c}`).join(',\n');
            return `SELECT\n${list}\nFROM ${tableReference} ${q};`;
        }
        case 'insert': {
            if (!hasColumns) {
                return `INSERT INTO ${tableReference} () VALUES ();`;
            }
            const colsBlock = columns.map(c => `    ${c}`).join(',\n');
            const valsBlock = columns
                .map((c, i) => {
                    const cast = columnTypes[i] ? `::${columnTypes[i]}` : '';
                    const comma = i < columns.length - 1 ? ',' : '';
                    return `    NULL${cast}${comma} -- ${c}`;
                })
                .join('\n');
            return `INSERT INTO ${tableReference} (\n${colsBlock}\n) VALUES (\n${valsBlock}\n);`;
        }
        case 'update': {
            if (!hasColumns) {
                return `UPDATE ${tableReference} ${q}\nSET \nWHERE ;`;
            }
            const setBlock = columns
                .map((c, i) => {
                    const cast = columnTypes[i] ? `::${columnTypes[i]}` : '';
                    const comma = i < columns.length - 1 ? ',' : '';
                    return `  ${c} = NULL${cast}${comma}`;
                })
                .join('\n');
            return `UPDATE ${tableReference} ${q}\nSET\n${setBlock}\nWHERE ;`;
        }
        case 'delete': {
            if (!hasColumns) {
                return `DELETE FROM ${tableReference} ${q}\nWHERE ;`;
            }
            const whereBlock = columns
                .map((c, i) => `${i === 0 ? '' : '  AND '}${q}.${c} = `)
                .join('\n');
            return `DELETE FROM ${tableReference} ${q}\nWHERE ${whereBlock};`;
        }
        case 'join':
            return `JOIN ${tableReference} ${q} ON ${q}.${firstCol} = `;
    }
}

/** Collapse a multi-line statement into a single-line preview string. */
export function toPreview(text: string): string {
    return text.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

export type JoinType = 'INNER JOIN' | 'LEFT JOIN' | 'RIGHT JOIN' | 'FULL JOIN' | 'CROSS JOIN';

export interface JoinTableSpec {
    /** Table alias / qualifier used to prefix columns; empty leaves them bare. */
    alias: string;
    /** Optionally schema-qualified table reference. */
    tableReference: string;
    /** Already-quoted column identifiers. */
    columns: string[];
    /** When set the table is joined but contributes no columns to the SELECT list. */
    omitFromSelect?: boolean;
}

export interface JoinCondition {
    /** Alias of a previously listed table. */
    leftAlias: string;
    /** Quoted column on the previously listed table. */
    leftColumn: string;
    /** Quoted column on the table being joined. */
    rightColumn: string;
}

/**
 * A literal join condition of the form `alias.column <operator> <value>`,
 * derived from a custom column mapping's extra conditions.
 */
export interface JoinLiteralCondition {
    /** Alias of the table the column belongs to. */
    literalAlias: string;
    /** Quoted column on that table. */
    literalColumn: string;
    operator: string;
    value: string;
}

export interface JoinClause {
    type: JoinType;
    conditions: JoinCondition[];
    /** Extra literal conditions (e.g. from custom mappings) added to the ON clause. */
    literalConditions?: JoinLiteralCondition[];
    /**
     * Free-form fixed conditions appended verbatim to the ON clause, e.g.
     * `CURRENT_TIMESTAMP BETWEEN t.valid_from AND t.valid_to` or `t.type = 'TGB'`.
     * The caller is responsible for producing valid SQL fragments.
     */
    rawConditions?: string[];
}

/** Format a custom-mapping condition value as a SQL literal. */
function formatLiteralValue(value: string): string {
    if (/^-?\d+(\.\d+)?$/.test(value)) {
        return value;
    }
    return escapeSqlLiteral(value);
}

/**
 * Qualify a column with a table alias. An empty alias leaves the column bare,
 * which keeps a WHERE clause that was written against the plain table valid
 * when it is moved into ON.
 */
function qualifyColumn(alias: string, column: string): string {
    return alias ? `${alias}.${column}` : column;
}

/**
 * Whether `fragment` contains an `OR` outside parentheses, string literals,
 * quoted identifiers and comments — such a condition must be parenthesised
 * before it is combined with others by AND.
 */
export function hasTopLevelOr(fragment: string): boolean {
    const tokens = fragment.match(SQL_FRAGMENT_TOKEN) ?? [];
    let depth = 0;
    for (const tok of tokens) {
        if (tok === '(' || tok === '[') {
            depth++;
        } else if (tok === ')' || tok === ']') {
            depth = Math.max(0, depth - 1);
        } else if (depth === 0 && /^or$/i.test(tok)) {
            return true;
        }
    }
    return false;
}

/** AND-combine conditions, parenthesising any that hold a top-level OR. */
function andConditions(parts: string[], separator: string): string {
    if (parts.length < 2) {
        return parts.join(separator);
    }
    return parts.map(p => (hasTopLevelOr(p) ? `(${p})` : p)).join(separator);
}

/**
 * The FROM line and one line per JOIN. `tables[0]` is the FROM table, and
 * `joins[i - 1]` says how `tables[i]` is joined; a missing clause is a CROSS JOIN.
 */
function buildFromLines(tables: JoinTableSpec[], joins: JoinClause[]): string[] {
    const declare = (t: JoinTableSpec) => (t.alias ? `${t.tableReference} ${t.alias}` : t.tableReference);
    const lines: string[] = [`FROM ${declare(tables[0])}`];

    for (let i = 1; i < tables.length; i++) {
        const t = tables[i];
        const join = joins[i - 1];
        if (!join || join.type === 'CROSS JOIN') {
            lines.push(`CROSS JOIN ${declare(t)}`);
            continue;
        }
        const parts = join.conditions.map(
            c => `${qualifyColumn(t.alias, c.rightColumn)} = ${qualifyColumn(c.leftAlias, c.leftColumn)}`
        );
        for (const lc of join.literalConditions ?? []) {
            parts.push(`${qualifyColumn(lc.literalAlias, lc.literalColumn)} ${lc.operator} ${formatLiteralValue(lc.value)}`);
        }
        for (const rc of join.rawConditions ?? []) {
            if (rc && rc.trim()) {
                parts.push(rc.trim());
            }
        }
        lines.push(`${join.type} ${declare(t)} ON ${andConditions(parts, ' AND ')}`);
    }
    return lines;
}

/**
 * Build a multi-table SELECT with JOINs.
 *
 * `tables[0]` is the base table (FROM). For every following table
 * `tables[i]` there must be a corresponding `joins[i - 1]` describing how it
 * is joined to the already-listed tables. The SELECT list contains every
 * column of every table, qualified by its alias.
 */
export function buildJoinSelect(
    tables: JoinTableSpec[],
    joins: JoinClause[],
    orderBy?: string,
    carried?: { joins?: string; where?: string }
): string {
    if (tables.length === 0) {
        return '';
    }

    const selectList = tables
        .filter(t => !t.omitFromSelect)
        .flatMap(t => {
            const cols = t.columns.length ? t.columns : ['*'];
            return cols.map(c => `  ${qualifyColumn(t.alias, c)}`);
        })
        .join(',\n');

    const lines = buildFromLines(tables, joins);

    if (carried?.joins && carried.joins.trim()) {
        lines.push(carried.joins.trim());
    }
    if (carried?.where && carried.where.trim()) {
        lines.push(`WHERE ${carried.where.trim()}`);
    }

    const tail = orderBy && orderBy.trim() ? `\nORDER BY ${orderBy.trim()}` : '';
    return `SELECT\n${selectList}\n${lines.join('\n')}${tail};`;
}

// ===== Query Builder state =====
// Mirrors the JSDoc typedef `JoinBuilderState` of src/webview/joinBuilder.js,
// the component both the JOIN dialog and the Data Viewer's builder tab use, and
// the state `readBuilderState` of src/webview/tableView.js reads from a SELECT.
// `buildBuilderSql` writes the same SQL as `builderStateToSql` there.

/** A FROM item of the builder: a table, or a raw item (sub-select, function, CTE) kept as written. */
export interface JoinBuilderTable {
    schema: string;
    table: string;
    /** Optionally schema-qualified, already quoted table reference. */
    tableReference: string;
    /** Alias; without one the table is referred to by its table name. */
    alias: string;
    /** The alias stored for the table, if any. */
    savedAlias?: string;
    /** Already-quoted column identifiers (may be empty, e.g. for a raw item). */
    columns: string[];
    /** The data type of each of `columns`, when known (date and timestamp columns get the date picker). */
    columnTypes?: string[];
    /**
     * A FROM item the builder cannot read — `(SELECT …) s`, `generate_series(1, 3) g`,
     * a CTE reference — as written, alias included; emitted verbatim. `alias`
     * then only names it.
     */
    raw?: string;
}

/** A column of a builder table (by its index in `tables`), or a raw value / expression. */
export type JoinBuilderOperand =
    | { kind: 'column'; tableIndex: number; column: string }
    | { kind: 'raw'; text: string };

/** One SELECT list item: a column of a table (`*` for all of them) or a free expression. */
export type JoinBuilderSelectItem =
    | { kind: 'column'; tableIndex: number; column: string; alias?: string }
    | { kind: 'expr'; text: string; alias?: string };

/**
 * One WHERE condition; all of them are combined with AND. A comparison's
 * operands are SQL text as written (`o.total`, `$1`, `'x'`; for BETWEEN the
 * right one is `low AND high`); operand objects are accepted too.
 */
export type JoinBuilderWhere =
    | {
        kind: 'compare';
        left: string | JoinBuilderOperand;
        operator: string;
        right?: string | JoinBuilderOperand;
        /** Upper bound of BETWEEN, when `right` is an operand object. */
        right2?: string | JoinBuilderOperand;
    }
    | { kind: 'raw'; text: string };

/** One ORDER BY item. `column`, when given, wins over `expr` (which then mirrors it). */
export interface JoinBuilderOrderBy {
    expr: string;
    column?: { tableIndex: number; column: string };
    direction?: 'ASC' | 'DESC';
    nulls?: 'FIRST' | 'LAST';
}

/**
 * Parts of the query the builder does not edit, carried through unchanged.
 * `groupBy`, `having`, `window`, `limit`, `offset` and `fetch` are clause
 * bodies without their keyword; `with` (`WITH x AS (…)`), `locking`
 * (`FOR UPDATE …`) and `setOps` (`UNION ALL SELECT …`, everything from the
 * first set operator to the end) are whole, keyword included. With `setOps`
 * the SELECT has no ORDER BY, LIMIT, OFFSET or FETCH of its own: those of a
 * set operation follow its last part, inside `setOps`.
 */
export interface JoinBuilderCarried {
    with?: string;
    groupBy?: string;
    having?: string;
    window?: string;
    limit?: string;
    offset?: string;
    /** `FIRST 10 ROWS ONLY`. */
    fetch?: string;
    locking?: string;
    setOps?: string;
}

/** Everything the Query Builder shows and edits of one SELECT. */
export interface JoinBuilderState {
    distinct: boolean;
    /** The expressions of `DISTINCT ON (…)`; used together with `distinct`. */
    distinctOn?: string;
    selectItems: JoinBuilderSelectItem[];
    tables: JoinBuilderTable[];
    /**
     * `joins[i - 1]` joins `tables[i]`. A join whose only condition is the raw
     * marker `NATURAL` or `USING (a, b)` is written that way instead of with ON;
     * next to other conditions USING becomes its ON pairs and NATURAL is left out.
     */
    joins: JoinClause[];
    where: JoinBuilderWhere[];
    orderBy: JoinBuilderOrderBy[];
    carried: JoinBuilderCarried;
}

/** Whether `sql` ends inside a `--` comment, which would swallow anything appended on its line. */
function endsInLineComment(sql: string): boolean {
    const tokens = sql.match(SQL_FRAGMENT_TOKEN) ?? [];
    const last = tokens[tokens.length - 1];
    return !!last && last.startsWith('--');
}

/** Append `text` with `glue`; after a trailing line comment the glue starts a new line. */
function appendSql(sql: string, glue: string, text: string): string {
    return endsInLineComment(sql) && !glue.startsWith('\n')
        ? `${sql}\n${glue.replace(/^[ \t]+/, '')}${text}`
        : `${sql}${glue}${text}`;
}

function joinSqlParts(parts: string[], glue: string): string {
    return parts.reduce((sql, part, i) => (i === 0 ? part : appendSql(sql, glue, part)), '');
}

/** The name a FROM item is referred to by: its alias, else its table name; '' for an unnamed raw item. */
function builderQualifier(table: JoinBuilderTable | undefined): string {
    if (!table) return '';
    if (table.alias) return table.alias;
    const parts = String(table.tableReference || '').split(/\s*\.\s*(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    return parts[parts.length - 1].trim();
}

function builderFromItem(table: JoinBuilderTable): string {
    if (table.raw && table.raw.trim()) return table.raw.trim();
    return table.alias ? `${table.tableReference} ${table.alias}` : table.tableReference;
}

/** A column of `tables[tableIndex]`, qualified unless it is the only, unaliased table. */
function builderColumn(tables: JoinBuilderTable[], tableIndex: number, column: string): string {
    const table = tables[tableIndex];
    if (!table) return '';
    const qualifier = tables.length > 1 || table.alias ? builderQualifier(table) : '';
    return qualifier ? `${qualifier}.${column}` : column;
}

function builderOperand(tables: JoinBuilderTable[], op: string | JoinBuilderOperand | undefined): string {
    if (op == null) return '';
    if (typeof op === 'string') return op.trim();
    return op.kind === 'column' ? builderColumn(tables, op.tableIndex, op.column) : String(op.text ?? '').trim();
}

/** A condition as SQL, empty while incomplete; a raw one with a top-level OR is parenthesised when `wrapOr`. */
function builderCondition(tables: JoinBuilderTable[], c: JoinBuilderWhere, wrapOr: boolean): string {
    if (c.kind === 'raw') {
        const text = String(c.text ?? '').trim();
        if (!text || !wrapOr || !hasTopLevelOr(text)) return text;
        return `(${text}${endsInLineComment(text) ? '\n' : ''})`;
    }
    const left = builderOperand(tables, c.left);
    const op = String(c.operator ?? '').trim().replace(/\s+/g, ' ');
    if (!left || !op) return '';
    if (/^IS (NOT )?NULL$/i.test(op)) return `${left} ${op}`;
    let right = builderOperand(tables, c.right);
    if (/^BETWEEN$/i.test(op) && c.right2 != null) {
        const right2 = builderOperand(tables, c.right2);
        right = right && right2 ? `${right} AND ${right2}` : '';
    }
    return right ? `${left} ${op} ${right}` : '';
}

/** A name as Postgres compares it: an unquoted one folded to lower case, a quoted one as written. */
function builderNameKey(name: string): string {
    const s = String(name ?? '').trim();
    return s.length > 1 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s.toLowerCase();
}

/**
 * `USING (a, b)` of the join of `tables[index]` as the equivalent ON pairs
 * `own.a = partner.a`, for when the join has further conditions; the partner of
 * a column is the latest earlier table known to have it, else the table just
 * before. Null when the marker is not a plain column list.
 * Same as usingToOnPairs in src/webview/tableView.js.
 */
function usingToOnPairs(tables: JoinBuilderTable[], index: number, marker: string): string[] | null {
    const m = /^USING\s*\(([\s\S]*)\)$/i.exec(marker.trim());
    if (!m) return null;
    const columns: string[] = [];
    let current = '', quoted = false;
    for (const ch of m[1]) {
        if (ch === '"') quoted = !quoted;
        if (ch === ',' && !quoted) { columns.push(current.trim()); current = ''; } else current += ch;
    }
    columns.push(current.trim());
    const ident = /^(?:"(?:[^"]|"")+"|[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*)$/;
    if (!columns.every(c => ident.test(c)) || index < 1) return null;
    const own = builderQualifier(tables[index]);
    return columns.map(column => {
        let partner = index - 1;
        for (let i = index - 1; i >= 0; i--) {
            if ((tables[i]?.columns ?? []).some(c => builderNameKey(c) === builderNameKey(column))) { partner = i; break; }
        }
        return `${qualifyColumn(own, column)} = ${qualifyColumn(builderQualifier(tables[partner]), column)}`;
    });
}

/** The JOIN line of `tables[index]`. */
function builderJoin(tables: JoinBuilderTable[], join: JoinClause | undefined, index: number): string {
    const item = builderFromItem(tables[index]);
    const j = join ?? { type: 'CROSS JOIN' as JoinType, conditions: [] };
    const conditions = (j.conditions ?? []).filter(c => c && c.leftColumn && c.rightColumn);
    const literals = (j.literalConditions ?? []).filter(c => c && c.literalColumn && c.operator);
    const raws = (j.rawConditions ?? []).map(r => String(r ?? '').trim()).filter(Boolean);
    const isMarker = (r: string) => /^NATURAL$/i.test(r) || /^USING\s*\(/i.test(r);
    const type = j.type || 'CROSS JOIN';
    // Conditions make a CROSS JOIN an inner one.
    const typed = type === 'CROSS JOIN' ? 'INNER JOIN' : type;
    if (raws.length === 1 && conditions.length === 0 && literals.length === 0) {
        if (/^NATURAL$/i.test(raws[0])) return `NATURAL ${typed} ${item}`;
        if (/^USING\s*\(/i.test(raws[0])) return `${typed} ${item} ${raws[0]}`;
    }
    const own = builderQualifier(tables[index]);
    // USING next to other conditions turns into its ON pairs; NATURAL cannot and is left out.
    const parts = raws.filter(r => /^USING\s*\(/i.test(r)).flatMap(r => usingToOnPairs(tables, index, r) ?? []);
    parts.push(...conditions.map(c => `${qualifyColumn(own, c.rightColumn)} = ${qualifyColumn(c.leftAlias, c.leftColumn)}`));
    for (const lc of literals) {
        parts.push(`${qualifyColumn(lc.literalAlias, lc.literalColumn)} ${lc.operator} ${formatLiteralValue(String(lc.value ?? ''))}`);
    }
    const plain = raws.filter(r => !isMarker(r));
    const total = parts.length + plain.length;
    for (const r of plain) parts.push(builderCondition(tables, { kind: 'raw', text: r }, total > 1));
    if (parts.length === 0) return type === 'CROSS JOIN' ? `CROSS JOIN ${item}` : `${type} ${item} ON TRUE`;
    return `${typed} ${item} ON ${joinSqlParts(parts, ' AND ')}`;
}

/**
 * Build the SELECT a Query Builder state describes — the same statement as
 * `builderStateToSql` of src/webview/tableView.js, laid out on lines.
 * Identifiers, expressions and carried clauses are used as given (already
 * quoted), so placeholders such as `$1` or `:name` stay as written; the
 * formatter does the real layout.
 */
export function buildBuilderSql(state: JoinBuilderState, options: { semicolon?: boolean } = {}): string {
    const tables = state.tables ?? [];
    const carried = state.carried ?? {};
    const text = (s: string | undefined) => String(s ?? '').trim();

    const items = (state.selectItems ?? [])
        .map(item => {
            if (!item) return '';
            const expr = item.kind === 'column'
                ? (item.column ? builderColumn(tables, item.tableIndex, item.column) : '')
                : text(item.text);
            if (!expr) return '';
            return text(item.alias) ? appendSql(expr, ' AS ', text(item.alias)) : expr;
        })
        .filter(Boolean);
    if (tables.length === 0 && items.length === 0) {
        return '';
    }
    if (items.length === 0) {
        items.push('*');
    }

    let sql = '';
    const add = (glue: string, part: string) => { sql = sql ? appendSql(sql, glue, part) : part; };
    if (text(carried.with)) add('', text(carried.with));
    const distinctOn = text(state.distinctOn);
    add('\n', !state.distinct ? 'SELECT' : distinctOn ? `SELECT DISTINCT ON (${distinctOn})` : 'SELECT DISTINCT');
    add('\n  ', joinSqlParts(items, ',\n  '));
    if (tables.length > 0) {
        add('\nFROM ', builderFromItem(tables[0]));
        for (let i = 1; i < tables.length; i++) add('\n', builderJoin(tables, (state.joins ?? [])[i - 1], i));
    }
    const conditions = state.where ?? [];
    const where = conditions.filter(Boolean).map(c => builderCondition(tables, c, conditions.length > 1)).filter(Boolean);
    if (where.length) add('\nWHERE ', joinSqlParts(where, '\n  AND '));
    if (text(carried.groupBy)) add('\nGROUP BY ', text(carried.groupBy));
    if (text(carried.having)) add('\nHAVING ', text(carried.having));
    if (text(carried.window)) add('\nWINDOW ', text(carried.window));
    // The ORDER BY, LIMIT, OFFSET and FETCH of a UNION / INTERSECT / EXCEPT
    // belong after its last part, which `setOps` holds as written.
    const setOps = text(carried.setOps);
    const orderBy = setOps ? [] : (state.orderBy ?? [])
        .filter(Boolean)
        .map(o => {
            const expr = o.column && tables[o.column.tableIndex]
                ? builderColumn(tables, o.column.tableIndex, o.column.column)
                : text(o.expr);
            return expr ? `${expr}${o.direction ? ` ${o.direction}` : ''}${o.nulls ? ` NULLS ${o.nulls}` : ''}` : '';
        })
        .filter(Boolean);
    if (orderBy.length) add('\nORDER BY ', joinSqlParts(orderBy, ', '));
    if (!setOps) {
        if (text(carried.limit)) add('\nLIMIT ', text(carried.limit));
        if (text(carried.offset)) add('\nOFFSET ', text(carried.offset));
        if (text(carried.fetch)) add('\nFETCH ', text(carried.fetch));
    }
    if (text(carried.locking)) add('\n', text(carried.locking));
    if (setOps) add('\n', setOps);

    if (options.semicolon === false) {
        return sql;
    }
    return endsInLineComment(sql) ? `${sql}\n;` : `${sql};`;
}

const SQL_FRAGMENT_TOKEN = /'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\/|[A-Za-z_][A-Za-z0-9_$]*|::|[\s\S]/g;

/** Strip the surrounding double quotes of an identifier, if it has any. */
function unquoteIdentifier(identifier: string): string {
    return identifier.startsWith('"') && identifier.endsWith('"') && identifier.length > 1
        ? identifier.slice(1, -1).replace(/""/g, '"')
        : identifier;
}

/**
 * Prefix every bare reference to one of `columns` with `alias`, so a clause
 * written against an unaliased table keeps its meaning once that table is
 * joined under an alias. String literals, comments, already qualified names,
 * cast types and function names are left untouched.
 */
export function qualifyColumnReferences(fragment: string, columns: string[], alias: string): string {
    if (!fragment || !alias) {
        return fragment;
    }
    const names = new Set(columns.map(unquoteIdentifier));
    const tokens = fragment.match(SQL_FRAGMENT_TOKEN) ?? [];
    const isIdentifier = (t: string) =>
        /^[A-Za-z_][A-Za-z0-9_$]*$/.test(t) || (t.startsWith('"') && t.endsWith('"') && t.length > 1);

    let out = '';
    let prev = '';
    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (!isIdentifier(tok)) {
            out += tok;
            if (tok.trim()) {
                prev = tok;
            }
            continue;
        }
        let next = '';
        for (let j = i + 1; j < tokens.length; j++) {
            if (tokens[j].trim()) {
                next = tokens[j];
                break;
            }
        }
        // Postgres folds an unquoted name to lower case before looking it up.
        const name = tok.startsWith('"') ? unquoteIdentifier(tok) : tok.toLowerCase();
        const taken = prev === '.' || prev === '::' || next === '.' || next === '(';
        out += !taken && names.has(name) ? `${alias}.${tok}` : tok;
        prev = tok;
    }
    return out;
}

/** A mapping's extra condition, with the column already quoted. */
export interface RelatedJoinCondition {
    column: string;
    operator: string;
    value: string;
}

/**
 * Describes opening a related table from a column header: the related table
 * becomes the FROM table and the table currently on screen is joined to it.
 */
export interface RelatedJoinSpec {
    /** The table being opened; supplies the FROM clause and the SELECT list. */
    target: { tableReference: string; columns: string[]; alias?: string };
    /**
     * The table the Data Viewer currently shows; joined in, not selected from.
     * `tableReference` may be a parenthesised sub-select, which then needs an
     * alias. `columns` are only used to qualify the carried-over clauses.
     * `joins` are the JOIN clauses of the query it came from, appended verbatim
     * after it — they reference its aliases, so `alias` must be its own.
     */
    source: { tableReference: string; columns?: string[]; alias?: string; joins?: string };
    /** `sourceColumn = targetColumn` equalities, both already quoted. */
    columnPairs: Array<{ sourceColumn: string; targetColumn: string }>;
    /** Mapping conditions that constrain the source table. */
    sourceConditions?: RelatedJoinCondition[];
    /** Mapping conditions that constrain the target table. */
    targetConditions?: RelatedJoinCondition[];
    /** The current query's WHERE clause, moved into the ON clause verbatim. */
    sourceWhere?: string;
    /** The current query's ORDER BY clause, kept for the new query. */
    sourceOrderBy?: string;
    type?: JoinType;
}

/**
 * Build the SELECT that opens a related table with the current one joined in.
 * Without aliases the source table's WHERE clause keeps its meaning verbatim;
 * aliases are needed once both tables share a column name, and the
 * carried-over clauses are then qualified to match.
 */
export function buildRelatedTableJoin(spec: RelatedJoinSpec): string {
    if (!spec.columnPairs.length) {
        return '';
    }
    const targetAlias = spec.target.alias ?? '';
    const sourceAlias = spec.source.alias ?? '';
    const tables: JoinTableSpec[] = [
        { alias: targetAlias, tableReference: spec.target.tableReference, columns: spec.target.columns },
        { alias: sourceAlias, tableReference: spec.source.tableReference, columns: [], omitFromSelect: true }
    ];
    const literal = (conditions: RelatedJoinCondition[] | undefined, alias: string): JoinLiteralCondition[] =>
        (conditions ?? []).map(c => ({
            literalAlias: alias,
            literalColumn: c.column,
            operator: c.operator,
            value: c.value
        }));
    const carry = (fragment: string | undefined) =>
        qualifyColumnReferences(fragment ?? '', spec.source.columns ?? [], sourceAlias);

    // Carried-over JOINs bring aliases of their own into scope, and only the
    // WHERE clause sees all of them.
    const carriedJoins = (spec.source.joins ?? '').trim();
    const carriedWhere = carriedJoins ? (spec.sourceWhere ?? '').trim() : '';

    const join: JoinClause = {
        type: spec.type ?? 'INNER JOIN',
        conditions: spec.columnPairs.map(p => ({
            leftAlias: targetAlias,
            leftColumn: p.targetColumn,
            rightColumn: p.sourceColumn
        })),
        literalConditions: [
            ...literal(spec.targetConditions, targetAlias),
            ...literal(spec.sourceConditions, sourceAlias)
        ],
        rawConditions: !carriedJoins && spec.sourceWhere ? [carry(spec.sourceWhere)] : []
    };
    return buildJoinSelect(tables, [join], carry(spec.sourceOrderBy), { joins: carriedJoins, where: carriedWhere });
}

export interface JoinFkEdge {
    /** Index of the table holding the FK column. */
    fromIndex: number;
    /** Quoted FK column on the `fromIndex` table. */
    fromColumn: string;
    /** Index of the referenced table. */
    toIndex: number;
    /** Quoted referenced column on the `toIndex` table. */
    toColumn: string;
    /**
     * Extra literal conditions (from a custom mapping) to add to the join's ON
     * clause. `tableIndex` identifies the table the column belongs to.
     */
    extraConditions?: Array<{ tableIndex: number; column: string; operator: string; value: string }>;
}

/**
 * Derive join clauses for tables in the given order using known foreign-key
 * edges. For each table after the first, the earliest preceding table that
 * shares one or more FK edges is used as the join partner and all matching
 * columns become ON conditions. Tables with no FK relation to any preceding
 * table fall back to a CROSS JOIN.
 */
export function autoJoinClauses(
    aliases: string[],
    edges: JoinFkEdge[],
    defaultType: JoinType = 'INNER JOIN'
): JoinClause[] {
    const clauses: JoinClause[] = [];

    for (let i = 1; i < aliases.length; i++) {
        // Edges connecting table i to some earlier table j (< i).
        const connecting = edges.filter(
            e =>
                (e.fromIndex === i && e.toIndex < i) ||
                (e.toIndex === i && e.fromIndex < i)
        );

        // Pick the earliest preceding partner table.
        let partner = -1;
        for (const e of connecting) {
            const other = e.fromIndex === i ? e.toIndex : e.fromIndex;
            if (partner === -1 || other < partner) {
                partner = other;
            }
        }

        if (partner === -1) {
            clauses.push({ type: 'CROSS JOIN', conditions: [] });
            continue;
        }

        const partnerEdges = connecting.filter(
            e => (e.fromIndex === i ? e.toIndex : e.fromIndex) === partner
        );

        const conditions: JoinCondition[] = partnerEdges.map(e => {
            if (e.fromIndex === i) {
                // Current table holds the FK, partner is referenced.
                return { leftAlias: aliases[partner], leftColumn: e.toColumn, rightColumn: e.fromColumn };
            }
            // Partner holds the FK, current table is referenced.
            return { leftAlias: aliases[partner], leftColumn: e.fromColumn, rightColumn: e.toColumn };
        });

        const literalConditions: JoinLiteralCondition[] = partnerEdges
            .flatMap(e => (e.extraConditions ?? []).map(ec => ({
                literalAlias: aliases[ec.tableIndex],
                literalColumn: ec.column,
                operator: ec.operator,
                value: ec.value
            })));

        clauses.push({ type: defaultType, conditions, literalConditions });
    }

    return clauses;
}


