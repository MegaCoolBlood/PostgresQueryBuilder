// Pure helper logic for the "Build JOIN SELECT" dialog. This file is loaded
// both as a plain script inside the webview (inlined by joinDialog.ts) and via
// `require` from the unit tests, so it must not depend on any browser globals
// at load time. Keep it free of DOM/VS Code API usage.

/**
 * Return an alias that does not collide with any of `used`. If `base` is free
 * it is returned unchanged; otherwise the smallest numeric suffix (2, 3, …)
 * that yields a free alias is appended. Only the aliases of currently visible
 * tables should be passed in `used`, so suffixes freed by removing a table are
 * reused instead of ever-increasing.
 */
function uniqueAlias(base, used) {
    const taken = new Set(used);
    if (!taken.has(base)) {
        return base;
    }
    let n = 2;
    while (taken.has(base + n)) {
        n++;
    }
    return base + n;
}

/**
 * Compute the auto-derived join clause for the table at original index
 * `newOrig`, using the foreign-key / custom-mapping identity edges. The same
 * relationships that pre-fill the join when a table is first added are applied
 * again here, so re-adding a table (or adding a second instance of it) offers
 * the same ON conditions.
 *
 * Edges and tables are matched by schema/table name (not by index), so the
 * logic works even when the same table appears multiple times. The earliest
 * preceding table related to the new one becomes the join partner; if none is
 * related, a CROSS JOIN is returned.
 *
 * @param {number} newOrig original index of the newly added table
 * @param {number[]} order original indices in current display order
 * @param {Array<{schema:string,table:string}>} tables table metadata by original index
 * @param {Array<{fromSchema:string,fromTable:string,fromColumn:string,toSchema:string,toTable:string,toColumn:string,extraConditions?:Array<{schema:string,table:string,column:string,operator:string,value:string}>}>} identityEdges
 * @returns {{type:string, conditions:Array<{leftOrig:number,leftColumn:string,rightColumn:string}>, literals:Array<{litOrig:number,otherOrig:number,litColumn:string,operator:string,value:string}>}}
 */
function computeAutoJoinClause(newOrig, order, tables, identityEdges) {
    const edges = identityEdges || [];
    const pos = order.indexOf(newOrig);
    const earlierOrig = pos >= 0 ? order.slice(0, pos) : order.slice();

    const nameMatches = (oi, schema, table) =>
        !!tables[oi] && tables[oi].schema === schema && tables[oi].table === table;

    // The earliest preceding table that shares at least one edge with the new
    // table becomes the join partner.
    let partner = -1;
    for (const oi of earlierOrig) {
        const related = edges.some(e => {
            const fromMe = nameMatches(newOrig, e.fromSchema, e.fromTable);
            const toMe = nameMatches(newOrig, e.toSchema, e.toTable);
            const fromEarlier = nameMatches(oi, e.fromSchema, e.fromTable);
            const toEarlier = nameMatches(oi, e.toSchema, e.toTable);
            return (fromMe && toEarlier) || (toMe && fromEarlier);
        });
        if (related) {
            partner = oi;
            break;
        }
    }

    if (partner < 0) {
        return { type: 'CROSS JOIN', conditions: [], literals: [] };
    }

    const relevant = edges.filter(e => {
        const fromMe = nameMatches(newOrig, e.fromSchema, e.fromTable);
        const toMe = nameMatches(newOrig, e.toSchema, e.toTable);
        const fromPartner = nameMatches(partner, e.fromSchema, e.fromTable);
        const toPartner = nameMatches(partner, e.toSchema, e.toTable);
        return (fromMe && toPartner) || (toMe && fromPartner);
    });

    const conditions = relevant.map(e => {
        const fromMe = nameMatches(newOrig, e.fromSchema, e.fromTable);
        if (fromMe) {
            // New table holds the FK column, partner is referenced.
            return { leftOrig: partner, leftColumn: e.toColumn, rightColumn: e.fromColumn };
        }
        // Partner holds the FK column, new table is referenced.
        return { leftOrig: partner, leftColumn: e.fromColumn, rightColumn: e.toColumn };
    });

    const literals = relevant.flatMap(e => (e.extraConditions || []).map(ec => {
        const onMe = nameMatches(newOrig, ec.schema, ec.table);
        return {
            litOrig: onMe ? newOrig : partner,
            otherOrig: onMe ? partner : newOrig,
            litColumn: ec.column,
            operator: ec.operator,
            value: ec.value
        };
    }));

    return { type: 'INNER JOIN', conditions, literals };
}

/** Operators offered for fixed/custom join conditions. */
const CUSTOM_OPERATORS = ['=', '<>', '<', '<=', '>', '>=', 'LIKE', 'ILIKE', 'BETWEEN', 'IS NULL', 'IS NOT NULL'];

/** Operators that take no right-hand operand. */
function isUnaryOperator(operator) {
    const op = (operator || '').toUpperCase();
    return op === 'IS NULL' || op === 'IS NOT NULL';
}

/** Operator that takes two right-hand operands joined by AND. */
function isBetweenOperator(operator) {
    return (operator || '').toUpperCase() === 'BETWEEN';
}

/**
 * Render a single resolved operand of a fixed condition to SQL text. A
 * `column` operand uses its pre-resolved qualified reference (e.g. `t.id`); a
 * `raw` operand is emitted verbatim (e.g. `CURRENT_TIMESTAMP` or `'TGB'`).
 */
function formatOperand(op) {
    if (!op) {
        return '';
    }
    if (op.kind === 'column') {
        return (op.ref || '').trim();
    }
    return (op.text || '').trim();
}

/**
 * Build the SQL text for a fixed/custom join condition from its resolved
 * operands. Returns an empty string when required operands are missing, so
 * incomplete rows can be skipped.
 *
 * Supported shapes:
 *  - `<left> <op> <right>`              (=, <>, <, <=, >, >=, LIKE, ILIKE)
 *  - `<left> BETWEEN <right> AND <r2>`  (BETWEEN)
 *  - `<left> IS NULL` / `IS NOT NULL`   (unary)
 *
 * @param {{operator:string,left:object,right?:object,right2?:object}} cond
 * @returns {string}
 */
function formatCustomCondition(cond) {
    if (!cond) {
        return '';
    }
    const op = (cond.operator || '').toUpperCase();
    const left = formatOperand(cond.left);
    if (!left) {
        return '';
    }
    if (isUnaryOperator(op)) {
        return left + ' ' + op;
    }
    if (isBetweenOperator(op)) {
        const r1 = formatOperand(cond.right);
        const r2 = formatOperand(cond.right2);
        if (!r1 || !r2) {
            return '';
        }
        return left + ' BETWEEN ' + r1 + ' AND ' + r2;
    }
    const right = formatOperand(cond.right);
    if (!right) {
        return '';
    }
    return left + ' ' + op + ' ' + right;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        uniqueAlias,
        computeAutoJoinClause,
        CUSTOM_OPERATORS,
        isUnaryOperator,
        isBetweenOperator,
        formatOperand,
        formatCustomCondition
    };
}