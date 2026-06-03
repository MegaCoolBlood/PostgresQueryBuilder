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
    /** Table alias / qualifier used to prefix columns. */
    alias: string;
    /** Optionally schema-qualified table reference. */
    tableReference: string;
    /** Already-quoted column identifiers. */
    columns: string[];
}

export interface JoinCondition {
    /** Alias of a previously listed table. */
    leftAlias: string;
    /** Quoted column on the previously listed table. */
    leftColumn: string;
    /** Quoted column on the table being joined. */
    rightColumn: string;
}

export interface JoinClause {
    type: JoinType;
    conditions: JoinCondition[];
}

/**
 * Build a multi-table SELECT with JOINs.
 *
 * `tables[0]` is the base table (FROM). For every following table
 * `tables[i]` there must be a corresponding `joins[i - 1]` describing how it
 * is joined to the already-listed tables. The SELECT list contains every
 * column of every table, qualified by its alias.
 */
export function buildJoinSelect(tables: JoinTableSpec[], joins: JoinClause[]): string {
    if (tables.length === 0) {
        return '';
    }

    const selectList = tables
        .flatMap(t => {
            const cols = t.columns.length ? t.columns : ['*'];
            return cols.map(c => `  ${t.alias}.${c}`);
        })
        .join(',\n');

    const base = tables[0];
    const lines: string[] = [`FROM ${base.tableReference} ${base.alias}`];

    for (let i = 1; i < tables.length; i++) {
        const t = tables[i];
        const join = joins[i - 1];
        if (!join || join.type === 'CROSS JOIN') {
            lines.push(`CROSS JOIN ${t.tableReference} ${t.alias}`);
            continue;
        }
        const on = join.conditions.length
            ? join.conditions
                  .map(c => `${t.alias}.${c.rightColumn} = ${c.leftAlias}.${c.leftColumn}`)
                  .join(' AND ')
            : '';
        lines.push(`${join.type} ${t.tableReference} ${t.alias} ON ${on}`);
    }

    return `SELECT\n${selectList}\n${lines.join('\n')};`;
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

        const conditions: JoinCondition[] = connecting
            .filter(e => (e.fromIndex === i ? e.toIndex : e.fromIndex) === partner)
            .map(e => {
                if (e.fromIndex === i) {
                    // Current table holds the FK, partner is referenced.
                    return { leftAlias: aliases[partner], leftColumn: e.toColumn, rightColumn: e.fromColumn };
                }
                // Partner holds the FK, current table is referenced.
                return { leftAlias: aliases[partner], leftColumn: e.fromColumn, rightColumn: e.toColumn };
            });

        clauses.push({ type: defaultType, conditions });
    }

    return clauses;
}


