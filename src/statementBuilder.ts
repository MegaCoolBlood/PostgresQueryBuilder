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
 * Build a multi-table SELECT with JOINs.
 *
 * `tables[0]` is the base table (FROM). For every following table
 * `tables[i]` there must be a corresponding `joins[i - 1]` describing how it
 * is joined to the already-listed tables. The SELECT list contains every
 * column of every table, qualified by its alias.
 */
export function buildJoinSelect(tables: JoinTableSpec[], joins: JoinClause[], orderBy?: string): string {
    if (tables.length === 0) {
        return '';
    }

    // An empty alias leaves the table unqualified, which keeps a WHERE clause
    // that was written against the plain table valid when it is moved into ON.
    const qualify = (alias: string, column: string) => (alias ? `${alias}.${column}` : column);
    const declare = (t: JoinTableSpec) => (t.alias ? `${t.tableReference} ${t.alias}` : t.tableReference);

    const selectList = tables
        .filter(t => !t.omitFromSelect)
        .flatMap(t => {
            const cols = t.columns.length ? t.columns : ['*'];
            return cols.map(c => `  ${qualify(t.alias, c)}`);
        })
        .join(',\n');

    const base = tables[0];
    const lines: string[] = [`FROM ${declare(base)}`];

    for (let i = 1; i < tables.length; i++) {
        const t = tables[i];
        const join = joins[i - 1];
        if (!join || join.type === 'CROSS JOIN') {
            lines.push(`CROSS JOIN ${declare(t)}`);
            continue;
        }
        const parts = join.conditions.map(
            c => `${qualify(t.alias, c.rightColumn)} = ${qualify(c.leftAlias, c.leftColumn)}`
        );
        for (const lc of join.literalConditions ?? []) {
            parts.push(`${qualify(lc.literalAlias, lc.literalColumn)} ${lc.operator} ${formatLiteralValue(lc.value)}`);
        }
        for (const rc of join.rawConditions ?? []) {
            if (rc && rc.trim()) {
                parts.push(rc.trim());
            }
        }
        const on = parts.join(' AND ');
        lines.push(`${join.type} ${declare(t)} ON ${on}`);
    }

    const tail = orderBy && orderBy.trim() ? `\nORDER BY ${orderBy.trim()}` : '';
    return `SELECT\n${selectList}\n${lines.join('\n')}${tail};`;
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
     */
    source: { tableReference: string; columns?: string[]; alias?: string };
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
        rawConditions: spec.sourceWhere ? [carry(spec.sourceWhere)] : []
    };
    return buildJoinSelect(tables, [join], carry(spec.sourceOrderBy));
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


