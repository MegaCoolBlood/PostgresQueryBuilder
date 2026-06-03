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
