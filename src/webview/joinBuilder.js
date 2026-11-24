/*
 * Join builder — the shared UI of the "Build JOIN SELECT" dialog
 * (src/joinDialog.ts) and the Query Builder tab of the Data Viewer.
 *
 * It shows the FROM items of one SELECT (order, aliases, saving an alias,
 * removing, adding tables), how they are joined (join type, column pairs,
 * conditions from custom mappings, fixed conditions), which columns and
 * expressions are selected, the WHERE conditions, the ORDER BY items and — read
 * only — the parts of the query it does not edit.
 *
 * Load order in a webview: joinDialogLogic.js, then this file; it then offers
 * `window.JoinBuilder`. The pure model functions at the top need no DOM and are
 * exported for the tests; `createJoinBuilder` is the DOM part. Every event is
 * wired by delegation on the component's root (the webviews' CSP blocks inline
 * handlers) and every interpolated value is escaped.
 *
 * The state handed in and out is `JoinBuilderState`, mirrored as a TypeScript
 * interface in src/statementBuilder.ts, where `buildBuilderSql` turns it into SQL.
 */

/**
 * @typedef {{ kind: 'column', tableIndex: number, column: string } | { kind: 'raw', text: string }} JoinBuilderOperand
 *   A column of `tables[tableIndex]`, or a value / expression kept as typed (`'abc'`, `42`, `$1`, `now()`).
 *
 * @typedef {{ kind: 'column', tableIndex: number, column: string, alias?: string }
 *   | { kind: 'expr', text: string, alias?: string }} JoinBuilderSelectItem
 *   A SELECT list item: a column (`*` for all of them) of `tables[tableIndex]`, or a free expression.
 *
 * @typedef {{ kind: 'compare', left: string, operator: string, right: string } | { kind: 'raw', text: string }} JoinBuilderWhere
 *   One WHERE condition; the conditions are combined with AND. Operands are SQL
 *   text (`o.total`, `$1`, `'x'`); IS NULL / IS NOT NULL have an empty `right`,
 *   BETWEEN has `low AND high`. Operand objects (JoinBuilderOperand, plus
 *   `right2` for BETWEEN) are accepted on input too.
 *
 * @typedef {{ expr: string, column?: { tableIndex: number, column: string }, direction?: 'ASC'|'DESC', nulls?: 'FIRST'|'LAST' }} JoinBuilderOrderBy
 *   One ORDER BY item. `column`, when given, wins over `expr`, which then mirrors it.
 *
 * @typedef {{ schema: string, table: string, tableReference: string, alias: string, savedAlias?: string, columns: string[], raw?: string }} JoinBuilderTable
 *   A FROM item. `columns` are quoted identifiers. Without an alias the table is
 *   referred to by its table name. `raw` is a FROM item the builder cannot read
 *   (sub-select, function, CTE reference) as written, alias included; it is
 *   emitted verbatim, `alias` only names it, and it is joined through text conditions.
 *
 * @typedef {{ leftAlias: string, leftColumn: string, rightColumn: string }} JoinBuilderPair
 * @typedef {{ literalAlias: string, literalColumn: string, operator: string, value: string }} JoinBuilderLiteral
 * @typedef {{ type: string, conditions: JoinBuilderPair[], literalConditions?: JoinBuilderLiteral[], rawConditions?: string[] }} JoinBuilderJoin
 *   How `tables[i]` is joined (`joins[i - 1]`): `rightColumn = leftAlias.leftColumn`
 *   pairs, literal conditions from custom mappings and text conditions, all ANDed.
 *   A sole raw condition `NATURAL` or `USING (a, b)` is written that way instead of ON; next to
 *   other conditions USING becomes its ON pairs, and a NATURAL join takes no others. Since such a
 *   join matches columns of every table before it, no table moves across it and none before it
 *   is removed.
 *
 * @typedef {{ with?: string, groupBy?: string, having?: string, window?: string,
 *   limit?: string, offset?: string, fetch?: string, locking?: string, setOps?: string }} JoinBuilderCarried
 *   Parts the builder carries through unchanged. `groupBy`, `having`, `window`,
 *   `limit`, `offset` and `fetch` are bodies without their keyword; `with`
 *   (`WITH x AS (…)`), `locking` (`FOR UPDATE …`) and `setOps` (`UNION ALL SELECT …`,
 *   from the first set operator to the end) are whole, keyword included.
 *
 * @typedef {{ distinct: boolean, distinctOn?: string, selectItems: JoinBuilderSelectItem[], tables: JoinBuilderTable[],
 *   joins: JoinBuilderJoin[], where: JoinBuilderWhere[], orderBy: JoinBuilderOrderBy[],
 *   carried: JoinBuilderCarried }} JoinBuilderState
 *   `distinctOn` holds the expressions of DISTINCT ON and counts while `distinct` is set.
 * * @typedef {{ fromSchema: string, fromTable: string, fromColumn: string, toSchema: string, toTable: string,
 *   toColumn: string, extraConditions?: Array<{ schema: string, table: string, column: string, operator: string, value: string }> }} JoinBuilderEdge
 *   A foreign key or custom column mapping, by name; used to join added tables.
 */
(function (root) {
    'use strict';

    const logic = (typeof module !== 'undefined' && module.exports && typeof require === 'function')
        ? require('./joinDialogLogic.js')
        : root.JoinDialogLogic;

    const DEFAULT_JOIN_TYPES = ['INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN'];
    const SEP = '\u0001';
    const CARRIED_PARTS = [
        { key: 'with', label: '' },
        { key: 'distinctOn', label: 'DISTINCT ON' },
        { key: 'groupBy', label: 'GROUP BY' },
        { key: 'having', label: 'HAVING' },
        { key: 'window', label: 'WINDOW' },
        { key: 'setOps', label: '' },
        { key: 'limit', label: 'LIMIT' },
        { key: 'offset', label: 'OFFSET' },
        { key: 'fetch', label: 'FETCH' },
        { key: 'locking', label: '' }
    ];

    // ===== Model =============================================================
    // Inside the component tables keep the index they were added with ("orig"),
    // so joins, aliases and references survive reordering; `order` lists the
    // orig indices in display order. The state handed out is positional.

    function tableKey(t) { return t.schema + '.' + t.table; }

    function qualify(alias, column) { return alias ? alias + '.' + column : column; }

    /** The name a table is referred to by: its alias, else its table name; '' for an unnamed raw item. */
    function qualifierOf(model, orig) {
        if (model.aliases[orig]) return model.aliases[orig];
        const t = model.tables[orig];
        if (!t) return '';
        const parts = String(t.tableReference || '').split(/\s*\.\s*(?=(?:[^"]*"[^"]*")*[^"]*$)/);
        return parts[parts.length - 1].trim();
    }

    /** A column as the query refers to it: qualified unless its table is the only, unaliased one. */
    function columnRef(model, orig, column) {
        return qualify(model.order.length > 1 || model.aliases[orig] ? qualifierOf(model, orig) : '', column);
    }

    function sameEdge(a, b) {
        return a.fromSchema === b.fromSchema && a.fromTable === b.fromTable && a.fromColumn === b.fromColumn
            && a.toSchema === b.toSchema && a.toTable === b.toTable && a.toColumn === b.toColumn;
    }

    function copyTable(t) {
        const out = {
            schema: String(t.schema || ''),
            table: String(t.table || ''),
            tableReference: String(t.tableReference || ''),
            columns: Array.isArray(t.columns) ? t.columns.map(String) : []
        };
        if (t.raw) out.raw = String(t.raw);
        return out;
    }

    /** Orig index of the table referred to as `name`, preferring tables listed before `before`. */
    function findAlias(model, name, before) {
        let found = -1;
        for (let i = 0; i < model.tables.length; i++) {
            if (qualifierOf(model, i) !== name) continue;
            if (i < before) return i;
            if (found < 0) found = i;
        }
        return found;
    }

    /** A name as Postgres compares it: an unquoted one folded to lower case, a quoted one as written. */
    function nameKey(name) {
        const s = String(name == null ? '' : name).trim();
        return s.length > 1 && s[0] === '"' && s[s.length - 1] === '"' ? s.slice(1, -1).replace(/""/g, '"') : s.toLowerCase();
    }

    /** `text` with string literals and comments blanked out, so every name left in it is SQL. */
    function maskLiterals(text) {
        const s = String(text == null ? '' : text);
        let out = '';
        let i = 0;
        while (i < s.length) {
            const c = s[i];
            let end = -1;
            if (c === "'") {
                end = i + 1;
                while (end < s.length && !(s[end] === "'" && s[end + 1] !== "'")) end += s[end] === "'" ? 2 : 1;
                end = Math.min(end + 1, s.length);
            } else if (c === '"') {
                let j = i + 1;
                while (j < s.length && !(s[j] === '"' && s[j + 1] !== '"')) j += s[j] === '"' ? 2 : 1;
                out += s.slice(i, j + 1);
                i = j + 1;
                continue;
            } else if (c === '-' && s[i + 1] === '-') {
                end = s.indexOf('\n', i);
                if (end < 0) end = s.length;
            } else if (c === '/' && s[i + 1] === '*') {
                end = s.indexOf('*/', i + 2);
                end = end < 0 ? s.length : end + 2;
            } else if (c === '$' && !/[A-Za-z0-9_$]/.test(s[i - 1] || '')) {
                const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i));
                if (tag) {
                    const close = s.indexOf(tag[0], i + tag[0].length);
                    end = close < 0 ? s.length : close + tag[0].length;
                }
            }
            if (end > i) {
                out += ' '.repeat(end - i);
                i = end;
            } else {
                out += c;
                i++;
            }
        }
        return out;
    }

    const NAME_RE = '(?:"(?:[^"]|"")+"|[A-Za-z_\\u0080-\\uffff][A-Za-z0-9_$\\u0080-\\uffff]*)';

    /** The qualifiers of the `qualifier.column` references in a text condition, as written. */
    function textQualifiers(text) {
        const masked = maskLiterals(text);
        const chain = new RegExp(NAME_RE + '(?:\\s*\\.\\s*(?:' + NAME_RE + '|\\*))+', 'g');
        const out = [];
        let m;
        while ((m = chain.exec(masked)) !== null) {
            const before = masked.slice(0, m.index).replace(/\s+$/, '');
            if (/(?:\.|::)$/.test(before) || /^\s*\(/.test(masked.slice(m.index + m[0].length))) continue;
            const parts = m[0].split(/\s*\.\s*(?=(?:[^"]*"[^"]*")*[^"]*$)/);
            out.push(parts[parts.length - 2].trim());
        }
        return out;
    }

    /** Orig indices of the tables in the query that a text condition names. */
    function textConditionTables(model, text) {
        const found = new Set();
        textQualifiers(text).forEach(q => {
            const key = nameKey(q);
            const oi = model.order.find(o => nameKey(qualifierOf(model, o)) === key);
            if (oi !== undefined) found.add(oi);
        });
        return found;
    }

    /** True for the `NATURAL` / `USING (…)` marker that stands for how a join matches columns. */
    function isJoinMarker(c) {
        return !!c && c.operator === undefined && /^(?:NATURAL$|USING\s*\()/i.test(String(c.text || '').trim());
    }

    function joinMarker(model, orig) {
        return (model.customByOrig[orig] || []).find(isJoinMarker) || null;
    }

    function isNaturalJoin(model, orig) {
        const marker = joinMarker(model, orig);
        return !!marker && /^NATURAL$/i.test(String(marker.text).trim());
    }

    /**
     * Why the table at `fromPos` cannot move to `toPos`, or ''. A NATURAL or
     * USING join matches columns of every table before it, so neither it nor a
     * table across it moves — that would change which columns it matches.
     */
    function moveBlockReason(model, fromPos, toPos) {
        for (let m = 1; m < model.order.length; m++) {
            const marker = joinMarker(model, model.order[m]);
            if (!marker) continue;
            if (fromPos === m || (fromPos < m && toPos >= m) || (fromPos > m && toPos <= m)) {
                return markerBlockText(model, m, marker, 'no table can be moved across it');
            }
        }
        return '';
    }

    /** Why the table at `pos` cannot be removed, or '' (see moveBlockReason). */
    function removeBlockReason(model, pos) {
        for (let m = Math.max(pos + 1, 2); m < model.order.length; m++) {
            const marker = joinMarker(model, model.order[m]);
            if (marker) return markerBlockText(model, m, marker, 'none of them can be removed');
        }
        return '';
    }

    function markerBlockText(model, m, marker, consequence) {
        const kind = /^NATURAL$/i.test(String(marker.text).trim()) ? 'NATURAL' : 'USING';
        return qualifierOf(model, model.order[m]) + ' is joined with ' + kind + ', which matches columns of the tables before it, so ' +
            consequence + '. Replace ' + kind + ' with ON conditions first.';
    }

    /** A WHERE operand written as text: a column of a table when it names one as `qualifier.column`, else raw. */
    function textOperand(model, text) {
        const s = String(text).trim();
        const m = /^("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)$/.exec(s);
        if (m) {
            const orig = findAlias(model, m[1], model.tables.length);
            if (orig >= 0 && model.tables[orig].columns.indexOf(m[2]) >= 0) return { kind: 'column', orig, column: m[2] };
        }
        return { kind: 'raw', text: s };
    }

    /** `low AND high` split at its first AND outside quotes and parentheses. */
    function splitBetweenBounds(text) {
        const s = String(text);
        let depth = 0;
        for (let i = 0; i < s.length; i++) {
            const c = s[i];
            if (c === "'" || c === '"') {
                const close = s.indexOf(c, i + 1);
                if (close < 0) break;
                i = close;
            } else if (c === '(') {
                depth++;
            } else if (c === ')') {
                depth--;
            } else if (depth === 0 && /\s/.test(c) && /^\s+and\s/i.test(s.slice(i))) {
                const m = /^\s+and\s+/i.exec(s.slice(i));
                return [s.slice(0, i).trim(), s.slice(i + m[0].length).trim()];
            }
        }
        return [s.trim(), ''];
    }

    /**
     * Build the component's model from a (positional) state.
     * @param {JoinBuilderState} state
     * @param {JoinBuilderEdge[]} [identityEdges]
     */
    function createModel(state, identityEdges) {
        const s = state || {};
        const tables = (s.tables || []).map(copyTable);
        const model = {
            tables,
            aliases: (s.tables || []).map(t => String(t.alias || '')),
            order: tables.map((_, i) => i),
            savedAliases: {},
            typeByOrig: {},
            joins: {},
            customByOrig: {},
            identityEdges: (identityEdges || []).slice(),
            distinct: !!s.distinct,
            distinctOn: String(s.distinctOn || (s.carried && s.carried.distinctOn) || ''),
            selectItems: [],
            where: [],
            orderBy: [],
            carried: Object.assign({}, s.carried || {})
        };
        delete model.carried.distinctOn;
        (s.tables || []).forEach(t => {
            if (!t.raw && t.savedAlias && !model.savedAliases[tableKey(t)]) model.savedAliases[tableKey(t)] = t.savedAlias;
        });

        (s.joins || []).forEach((j, idx) => {
            const oi = idx + 1;
            if (!j || oi >= tables.length) return;
            const type = j.type || 'INNER JOIN';
            const conditions = [];
            const custom = [];
            (j.conditions || []).forEach(c => {
                const leftOrig = findAlias(model, c.leftAlias, oi);
                if (leftOrig >= 0 && leftOrig !== oi) {
                    conditions.push({ leftOrig, leftColumn: c.leftColumn, rightColumn: c.rightColumn });
                } else {
                    custom.push({ text: qualify(qualifierOf(model, oi), c.rightColumn) + ' = ' + qualify(c.leftAlias, c.leftColumn) });
                }
            });
            const partner = conditions.length ? conditions[0].leftOrig : -1;
            const literals = [];
            (j.literalConditions || []).forEach(lc => {
                const litOrig = findAlias(model, lc.literalAlias, tables.length);
                const otherOrig = litOrig === oi ? partner : oi;
                if (litOrig >= 0 && otherOrig >= 0) {
                    literals.push({ litOrig, otherOrig, litColumn: lc.literalColumn, operator: lc.operator, value: lc.value });
                } else if (litOrig >= 0) {
                    custom.push(logic.literalToCustomCondition({ litOrig, litColumn: lc.literalColumn, operator: lc.operator, value: lc.value }));
                } else {
                    custom.push({ text: qualify(lc.literalAlias, lc.literalColumn) + ' ' + lc.operator + ' ' + logic.formatSqlLiteral(lc.value) });
                }
            });
            (j.rawConditions || []).forEach(text => {
                if (text && String(text).trim()) custom.push({ text: String(text).trim() });
            });
            model.typeByOrig[oi] = type;
            model.joins[oi] = { type, conditions, literals };
            model.customByOrig[oi] = custom;
        });

        const operandIn = op => {
            if (op == null) return undefined;
            if (typeof op === 'string') return textOperand(model, op);
            if (op.kind === 'column') {
                return tables[op.tableIndex]
                    ? { kind: 'column', orig: op.tableIndex, column: op.column }
                    : { kind: 'raw', text: String(op.column || '') };
            }
            return { kind: 'raw', text: String(op.text || '') };
        };

        (s.selectItems || []).forEach(it => {
            if (!it) return;
            const alias = it.alias ? String(it.alias) : '';
            if (it.kind === 'column' && tables[it.tableIndex]) {
                model.selectItems.push({ kind: 'column', orig: it.tableIndex, column: it.column, alias });
            } else {
                model.selectItems.push({ kind: 'expr', text: String(it.kind === 'column' ? it.column : it.text || ''), alias });
            }
        });
        (s.where || []).forEach(w => {
            if (!w) return;
            if (w.kind === 'compare') {
                const row = { kind: 'compare', operator: w.operator || '=', left: operandIn(w.left) || { kind: 'raw', text: '' } };
                let right = w.right, right2 = w.right2;
                // A BETWEEN written as text carries both bounds in `right`.
                if (logic.isBetweenOperator(row.operator) && typeof right === 'string' && right2 == null) {
                    const bounds = splitBetweenBounds(right);
                    right = bounds[0];
                    right2 = bounds[1];
                }
                if (!logic.isUnaryOperator(row.operator)) row.right = operandIn(right) || { kind: 'raw', text: '' };
                if (logic.isBetweenOperator(row.operator)) row.right2 = operandIn(right2) || { kind: 'raw', text: '' };
                model.where.push(row);
            } else {
                model.where.push({ kind: 'raw', text: String(w.text || '') });
            }
        });
        (s.orderBy || []).forEach(o => {
            if (!o) return;
            const column = o.column && tables[o.column.tableIndex] ? { orig: o.column.tableIndex, column: o.column.column } : null;
            model.orderBy.push({ expr: String(o.expr || ''), column, direction: o.direction || '', nulls: o.nulls || '' });
        });
        normalizeJoins(model);
        return model;
    }

    /**
     * Re-attach every join relationship to whichever of its two tables comes
     * later in the current order, so moving a table (e.g. into the FROM slot)
     * never loses a condition. Join types stay with their table, except that a
     * CROSS JOIN handed a condition of another join becomes an INNER JOIN;
     * fixed and text conditions stay with it while it can see what they name.
     */
    function normalizeJoins(model) {
        const links = [];
        const litLinks = [];
        Object.keys(model.joins).forEach(k => {
            const oi = +k;
            const j = model.joins[oi];
            if (!j) return;
            if (j.type) model.typeByOrig[oi] = j.type;
            (j.conditions || []).forEach(c => {
                if (c.leftOrig == null || c.leftOrig < 0 || c.leftOrig === oi) return;
                links.push({ a: c.leftOrig, colA: c.leftColumn, b: oi, colB: c.rightColumn });
            });
            (j.literals || []).forEach(l => {
                if (l.litOrig == null || l.litOrig < 0 || l.otherOrig == null || l.otherOrig < 0) return;
                litLinks.push({ l, owner: oi });
            });
        });

        const rebuilt = {};
        const seen = new Set();
        const litSeen = new Set();
        for (let pos = 1; pos < model.order.length; pos++) {
            const oi = model.order[pos];
            const earlier = new Set(model.order.slice(0, pos));
            const conditions = [];
            let received = false;
            for (const lk of links) {
                let partner = -1, partnerCol = null, myCol = null;
                if (lk.b === oi && earlier.has(lk.a)) { partner = lk.a; partnerCol = lk.colA; myCol = lk.colB; }
                else if (lk.a === oi && earlier.has(lk.b)) { partner = lk.b; partnerCol = lk.colB; myCol = lk.colA; }
                if (partner < 0) continue;
                const sig = oi + '|' + partner + '|' + myCol + '|' + partnerCol;
                if (seen.has(sig)) continue;
                seen.add(sig);
                if (lk.b !== oi) received = true;
                conditions.push({ leftOrig: partner, leftColumn: partnerCol, rightColumn: myCol });
            }
            const literals = [];
            for (const { l: ll, owner } of litLinks) {
                const belongs = (ll.litOrig === oi && earlier.has(ll.otherOrig)) || (ll.otherOrig === oi && earlier.has(ll.litOrig));
                if (!belongs) continue;
                const sig = oi + '|' + ll.litOrig + '|' + ll.otherOrig + '|' + ll.litColumn + '|' + ll.operator + '|' + ll.value;
                if (litSeen.has(sig)) continue;
                litSeen.add(sig);
                if (owner !== oi) received = true;
                literals.push({ litOrig: ll.litOrig, otherOrig: ll.otherOrig, litColumn: ll.litColumn, operator: ll.operator, value: ll.value });
            }
            // A CROSS JOIN hides its own conditions, but one it is handed must not vanish.
            if (received && model.typeByOrig[oi] === 'CROSS JOIN') model.typeByOrig[oi] = 'INNER JOIN';
            rebuilt[oi] = { type: model.typeByOrig[oi] || 'INNER JOIN', conditions, literals };
        }
        model.joins = rebuilt;
        rehomeFixedConditions(model);
    }

    /**
     * A fixed or text ON condition belongs to a joined table that sees every
     * table it names: one whose table moved into FROM, or that names a table
     * now joined later, moves to the join of the latest table it needs (a
     * CROSS JOIN receiving it becomes an INNER JOIN). A NATURAL / USING marker
     * stays with its table and goes away once that table is the FROM item.
     */
    function rehomeFixedConditions(model) {
        if (model.order.length < 2) return;
        const posOf = new Map(model.order.map((oi, pos) => [oi, pos]));
        Object.keys(model.customByOrig).forEach(k => {
            const oi = +k;
            if (!posOf.has(oi)) return;
            const keep = [];
            model.customByOrig[oi].forEach(c => {
                if (isJoinMarker(c)) {
                    if (posOf.get(oi) > 0) keep.push(c);
                    return;
                }
                let target = posOf.get(oi);
                if (c.operator === undefined) {
                    textConditionTables(model, c.text).forEach(orig => { target = Math.max(target, posOf.get(orig)); });
                }
                ['left', 'right', 'right2'].forEach(side => {
                    const op = c[side];
                    if (op && op.kind === 'column' && posOf.has(op.orig)) target = Math.max(target, posOf.get(op.orig));
                });
                const toOrig = model.order[Math.max(target, 1)];
                if (toOrig === oi) {
                    keep.push(c);
                } else {
                    if (!model.customByOrig[toOrig]) model.customByOrig[toOrig] = [];
                    model.customByOrig[toOrig].push(c);
                    const j = model.joins[toOrig];
                    if (j && j.type === 'CROSS JOIN') j.type = model.typeByOrig[toOrig] = 'INNER JOIN';
                }
            });
            model.customByOrig[oi] = keep;
        });
    }

    function resolveOperand(model, op) {
        if (!op) return { kind: 'raw', text: '' };
        if (op.kind === 'column') return { kind: 'column', ref: columnRef(model, op.orig, op.column) };
        return { kind: 'raw', text: op.text || '' };
    }

    /** SQL of a fixed ON condition or a structured WHERE row; empty while incomplete. */
    function conditionText(model, c) {
        if (!c) return '';
        if (c.kind === 'raw' || (c.text !== undefined && c.operator === undefined)) return String(c.text || '').trim();
        return logic.formatCustomCondition({
            operator: c.operator,
            left: resolveOperand(model, c.left),
            right: resolveOperand(model, c.right),
            right2: c.right2 ? resolveOperand(model, c.right2) : undefined
        });
    }

    function usesTable(c, orig) {
        return ['left', 'right', 'right2'].some(side => c[side] && c[side].kind === 'column' && c[side].orig === orig);
    }

    /**
     * The positional state the model describes.
     * @returns {JoinBuilderState}
     */
    function stateFromModel(model) {
        normalizeJoins(model);
        const posOf = new Map(model.order.map((oi, pos) => [oi, pos]));
        const visible = orig => posOf.has(orig);
        const tables = model.order.map(oi => {
            const t = model.tables[oi];
            const out = { schema: t.schema, table: t.table, tableReference: t.tableReference, alias: model.aliases[oi], columns: t.columns.slice() };
            if (t.raw) {
                out.raw = t.raw;
            } else if (model.savedAliases[tableKey(t)]) {
                out.savedAlias = model.savedAliases[tableKey(t)];
            }
            return out;
        });
        const joins = [];
        for (let pos = 1; pos < model.order.length; pos++) {
            const oi = model.order[pos];
            const j = model.joins[oi] || { type: 'CROSS JOIN', conditions: [], literals: [] };
            // A CROSS JOIN has no conditions; the hidden ones come back with another type.
            const cross = j.type === 'CROSS JOIN';
            joins.push({
                type: j.type,
                conditions: cross ? [] : j.conditions.map(c => ({ leftAlias: qualifierOf(model, c.leftOrig), leftColumn: c.leftColumn, rightColumn: c.rightColumn })),
                literalConditions: cross ? [] : j.literals.map(l => ({ literalAlias: qualifierOf(model, l.litOrig), literalColumn: l.litColumn, operator: l.operator, value: l.value })),
                rawConditions: cross ? [] : (model.customByOrig[oi] || []).map(c => conditionText(model, c)).filter(Boolean)
            });
        }
        const operandOut = op => {
            if (!op) return '';
            return op.kind === 'column' ? columnRef(model, op.orig, op.column) : String(op.text || '').trim();
        };
        const selectItems = model.selectItems
            .filter(it => it.kind !== 'column' || visible(it.orig))
            .map(it => {
                const out = it.kind === 'column'
                    ? { kind: 'column', tableIndex: posOf.get(it.orig), column: it.column }
                    : { kind: 'expr', text: it.text };
                if (it.alias && it.alias.trim()) out.alias = it.alias.trim();
                return out;
            });
        const where = model.where
            .filter(w => w.kind === 'raw' || !['left', 'right', 'right2'].some(s => w[s] && w[s].kind === 'column' && !visible(w[s].orig)))
            .map(w => {
                if (w.kind === 'raw') return { kind: 'raw', text: w.text };
                const out = { kind: 'compare', left: operandOut(w.left), operator: w.operator, right: '' };
                if (logic.isBetweenOperator(w.operator)) {
                    const low = operandOut(w.right), high = operandOut(w.right2);
                    out.right = low && high ? low + ' AND ' + high : '';
                } else if (!logic.isUnaryOperator(w.operator)) {
                    out.right = operandOut(w.right);
                }
                return out;
            });
        const orderBy = model.orderBy
            .filter(o => !o.column || visible(o.column.orig))
            .map(o => {
                const out = o.column
                    ? { expr: columnRef(model, o.column.orig, o.column.column), column: { tableIndex: posOf.get(o.column.orig), column: o.column.column } }
                    : { expr: o.expr };
                if (o.direction) out.direction = o.direction;
                if (o.nulls) out.nulls = o.nulls;
                return out;
            });
        const state = { distinct: !!model.distinct, selectItems, tables, joins, where, orderBy, carried: Object.assign({}, model.carried) };
        if (model.distinctOn) state.distinctOn = model.distinctOn;
        return state;
    }

    // ===== Model changes =====================================================

    /** Move the table at `fromPos` to `toPos`; the joins follow. Not across a NATURAL / USING join (see moveBlockReason). */
    function moveTable(model, fromPos, toPos) {
        const n = model.order.length;
        if (fromPos === toPos || fromPos < 0 || toPos < 0 || fromPos >= n || toPos >= n) return false;
        if (moveBlockReason(model, fromPos, toPos)) return false;
        const moved = model.order.splice(fromPos, 1)[0];
        model.order.splice(toPos, 0, moved);
        normalizeJoins(model);
        return true;
    }

    /**
     * Remove the table at `pos`, with every condition (text ones naming it
     * too), select item, WHERE row and ORDER BY item that refers to it. The
     * last table cannot be removed, nor one a NATURAL / USING join matches
     * columns of (see removeBlockReason). Returns the removed table, or null.
     */
    function removeTableAt(model, pos) {
        if (model.order.length <= 1 || pos < 0 || pos >= model.order.length) return null;
        if (removeBlockReason(model, pos)) return null;
        const oi = model.order[pos];
        const namesIt = c => c.operator === undefined && !isJoinMarker(c) && textConditionTables(model, c.text).has(oi);
        Object.keys(model.customByOrig).forEach(k => {
            model.customByOrig[k] = model.customByOrig[k].filter(c => !usesTable(c, oi) && !namesIt(c));
        });
        model.where = model.where.filter(w => (w.kind === 'raw' ? !namesIt({ text: w.text }) : !usesTable(w, oi)));
        model.order.splice(pos, 1);
        delete model.joins[oi];
        delete model.typeByOrig[oi];
        delete model.customByOrig[oi];
        Object.keys(model.joins).forEach(k => {
            const j = model.joins[k];
            j.conditions = j.conditions.filter(c => c.leftOrig !== oi);
            j.literals = (j.literals || []).filter(l => l.litOrig !== oi && l.otherOrig !== oi);
        });
        model.selectItems = model.selectItems.filter(it => it.kind !== 'column' || it.orig !== oi);
        model.orderBy = model.orderBy.filter(o => !o.column || o.column.orig !== oi);
        normalizeJoins(model);
        return model.tables[oi];
    }

    /** Use `alias` for the table; an empty alias is ignored, and a raw item keeps the alias it is written with. */
    function setTableAlias(model, orig, alias) {
        const a = String(alias == null ? '' : alias).trim();
        if (!a || !model.tables[orig] || model.tables[orig].raw) return false;
        model.aliases[orig] = a;
        return true;
    }

    function isColumnSelected(model, orig, column) {
        return model.selectItems.some(it => it.kind === 'column' && it.orig === orig && it.column === column);
    }

    /** Tick a column (appended to the SELECT list) or untick it (every occurrence removed). */
    function toggleColumn(model, orig, column, checked) {
        if (checked) {
            if (!isColumnSelected(model, orig, column)) model.selectItems.push({ kind: 'column', orig, column, alias: '' });
        } else {
            model.selectItems = model.selectItems.filter(it => !(it.kind === 'column' && it.orig === orig && it.column === column));
        }
    }

    /** Tick or untick every column of a table; a table without known columns selects `*`. */
    function setAllColumns(model, orig, checked) {
        const t = model.tables[orig];
        if (!t) return;
        if (!checked) {
            model.selectItems = model.selectItems.filter(it => !(it.kind === 'column' && it.orig === orig));
            return;
        }
        if (t.columns.length) {
            t.columns.forEach(c => toggleColumn(model, orig, c, true));
        } else if (!isColumnSelected(model, orig, '*')) {
            model.selectItems.push({ kind: 'column', orig, column: '*', alias: '' });
        }
    }

    /**
     * Append the tables (and their edges) the host sends after "Add tables".
     * Each is a new instance with an alias unique among the visible tables,
     * joined to the earliest related table before it.
     * @param {{ tables: JoinBuilderTable[], fkEdges?: JoinBuilderEdge[] }} payload
     * @returns {number[]} orig indices of the added tables
     */
    function addTablesToModel(model, payload, selectColumns) {
        const p = payload || {};
        (p.fkEdges || []).forEach(e => {
            if (!model.identityEdges.some(x => sameEdge(x, e))) model.identityEdges.push(e);
        });
        const added = [];
        (p.tables || []).forEach(nt => {
            const alias = logic.uniqueAlias(nt.alias || nt.table || 't', model.order.map(oi => model.aliases[oi]));
            const oi = model.tables.length;
            model.tables.push(copyTable(nt));
            if (!nt.raw && nt.savedAlias && !model.savedAliases[tableKey(nt)]) model.savedAliases[tableKey(nt)] = nt.savedAlias;
            model.aliases.push(alias);
            model.order.push(oi);
            if (model.order.length > 1) {
                const clause = logic.computeAutoJoinClause(oi, model.order, model.tables, model.identityEdges);
                model.typeByOrig[oi] = clause.type;
                model.joins[oi] = clause;
            }
            if (selectColumns) setAllColumns(model, oi, true);
            added.push(oi);
        });
        if (added.length) normalizeJoins(model);
        return added;
    }

    /** Every column of the visible tables, as operand choices. */
    function allColumnOptions(model) {
        const opts = [];
        model.order.forEach(oi => {
            model.tables[oi].columns.forEach(c => opts.push({ orig: oi, ref: columnRef(model, oi, c), column: c }));
        });
        return opts;
    }

    function earlierColumnOptions(model, pos) {
        const opts = [];
        for (let p = 0; p < pos; p++) {
            const oi = model.order[p];
            model.tables[oi].columns.forEach(c => opts.push({ orig: oi, ref: columnRef(model, oi, c), column: c }));
        }
        return opts;
    }

    function ensureJoin(model, orig) {
        if (!model.joins[orig]) model.joins[orig] = { type: model.typeByOrig[orig] || 'INNER JOIN', conditions: [], literals: [] };
        return model.joins[orig];
    }

    function ensureCustom(model, orig) {
        if (!model.customByOrig[orig]) model.customByOrig[orig] = [];
        return model.customByOrig[orig];
    }

    /** Add a `column = column` pair to the join of `orig`; a NATURAL join takes none. */
    function addJoinCondition(model, orig) {
        const pos = model.order.indexOf(orig);
        if (pos < 1 || isNaturalJoin(model, orig)) return false;
        const left = earlierColumnOptions(model, pos)[0];
        const right = model.tables[orig].columns[0];
        if (!left || right === undefined) return false;
        ensureJoin(model, orig).conditions.push({ leftOrig: left.orig, leftColumn: left.column, rightColumn: right });
        return true;
    }

    function firstColumnOperand(model) {
        const first = allColumnOptions(model)[0];
        return first ? { kind: 'column', orig: first.orig, column: first.column } : { kind: 'raw', text: '' };
    }

    /** Add a fixed `<operand> = <value>` condition to the join of `orig`; a NATURAL join takes none. */
    function addFixedCondition(model, orig) {
        if (isNaturalJoin(model, orig)) return false;
        ensureCustom(model, orig).push({ operator: '=', left: firstColumnOperand(model), right: { kind: 'raw', text: '' } });
        return true;
    }

    /** Turn a read-only custom-mapping condition into an editable fixed one. */
    function promoteLiteral(model, orig, index) {
        const j = model.joins[orig];
        const lit = j && j.literals && j.literals[index];
        if (!lit) return false;
        ensureCustom(model, orig).push(logic.literalToCustomCondition(lit));
        j.literals.splice(index, 1);
        return true;
    }

    /** Change a condition's operator, adding or dropping the right operands it needs. */
    function applyOperator(c, operator) {
        c.operator = operator;
        if (logic.isUnaryOperator(operator)) {
            delete c.right;
            delete c.right2;
        } else {
            if (!c.right) c.right = { kind: 'raw', text: '' };
            if (logic.isBetweenOperator(operator)) {
                if (!c.right2) c.right2 = { kind: 'raw', text: '' };
            } else {
                delete c.right2;
            }
        }
    }

    /** Add a WHERE row: a column comparison, or (`raw`) a free text condition. */
    function addWhereRow(model, raw) {
        model.where.push(raw
            ? { kind: 'raw', text: '' }
            : { kind: 'compare', operator: '=', left: firstColumnOperand(model), right: { kind: 'raw', text: '' } });
    }

    /** Add an ORDER BY item on the first column, or an empty expression. */
    function addOrderByItem(model) {
        const first = allColumnOptions(model)[0];
        model.orderBy.push(first
            ? { expr: '', column: { orig: first.orig, column: first.column }, direction: '', nulls: '' }
            : { expr: '', column: null, direction: '', nulls: '' });
    }

    function addSelectExpression(model, text) {
        model.selectItems.push({ kind: 'expr', text: String(text || ''), alias: '' });
    }

    /** Move `list[index]` by `delta`; false when it would leave the list. */
    function moveItem(list, index, delta) {
        const to = index + delta;
        if (index < 0 || index >= list.length || to < 0 || to >= list.length) return false;
        const item = list.splice(index, 1)[0];
        list.splice(to, 0, item);
        return true;
    }

    function removeItem(list, index) {
        if (index < 0 || index >= list.length) return false;
        list.splice(index, 1);
        return true;
    }

    // ===== Markup ============================================================

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }

    function icon(name) {
        return '<svg class="ico" aria-hidden="true"><use href="#icon-' + name + '"/></svg>';
    }

    /** `data-*` attributes addressing an element: action plus table, index and side. */
    function at(action, o, i, s) {
        let a = ' data-jb="' + action + '"';
        if (o !== undefined && o !== null) a += ' data-o="' + escapeHtml(o) + '"';
        if (i !== undefined && i !== null) a += ' data-i="' + escapeHtml(i) + '"';
        if (s !== undefined && s !== null) a += ' data-s="' + escapeHtml(s) + '"';
        return a;
    }

    function button(action, o, i, iconHtml, title, extraClass, disabled) {
        return '<button type="button" class="btn btn-sm btn-icon' + (extraClass ? ' ' + extraClass : '') + '"' +
            at(action, o, i) + ' title="' + escapeHtml(title) + '"' + (disabled ? ' disabled' : '') + '>' + iconHtml + '</button>';
    }

    function removeButton(action, o, i, title) {
        return button(action, o, i, icon('close'), title, 'btn-ghost');
    }

    function labelButton(action, o, iconHtml, label, title, disabled) {
        return '<button type="button" class="btn btn-sm"' + at(action, o) + ' title="' + escapeHtml(title) + '"' +
            (disabled ? ' disabled' : '') + '>' + iconHtml + escapeHtml(label) + '</button>';
    }

    function columnOptions(model, selected) {
        return allColumnOptions(model).map(o => {
            const sel = selected && selected.orig === o.orig && selected.column === o.column;
            return '<option value="' + escapeHtml('c' + SEP + o.orig + SEP + o.column) + '"' + (sel ? ' selected' : '') + '>' +
                escapeHtml(o.ref) + '</option>';
        }).join('');
    }

    /** Column picker of any table plus "Custom value…", with a text box for the latter. */
    function operandControls(model, scope, o, i, side, operand) {
        const op = operand || { kind: 'raw', text: '' };
        const column = op.kind === 'column' ? op : null;
        let html = '<select class="jb-operand"' + at(scope + '-operand', o, i, side) + ' title="Column or custom value">' +
            columnOptions(model, column) +
            '<option value="__raw__"' + (column ? '' : ' selected') + '>Custom value…</option></select>';
        if (!column) {
            html += '<input type="text" class="jb-value"' + at(scope + '-raw', o, i, side) + ' value="' + escapeHtml(op.text || '') +
                '" placeholder="value / expression">';
        }
        return html;
    }

    /** The operators to choose from; one the list lacks (`!=`, `~`, …) is offered as it is written. */
    function operatorSelect(scope, o, i, operator) {
        const current = String(operator == null ? '' : operator).trim().replace(/\s+/g, ' ');
        const known = logic.CUSTOM_OPERATORS.find(x => x.toUpperCase() === current.toUpperCase());
        const list = known || !current ? logic.CUSTOM_OPERATORS : logic.CUSTOM_OPERATORS.concat([current]);
        const selected = known || current;
        return '<select class="jb-operator"' + at(scope + '-operator', o, i) + ' title="Operator">' +
            list.map(x => '<option' + (x === selected ? ' selected' : '') + '>' + escapeHtml(x) + '</option>').join('') +
            '</select>';
    }

    /** Operands and operator of a structured condition (fixed ON condition or WHERE row). */
    function conditionControls(model, scope, o, i, c) {
        let html = operandControls(model, scope, o, i, 'left', c.left) + operatorSelect(scope, o, i, c.operator);
        if (logic.isBetweenOperator(c.operator)) {
            html += operandControls(model, scope, o, i, 'right', c.right) + '<span>AND</span>' +
                operandControls(model, scope, o, i, 'right2', c.right2);
        } else if (!logic.isUnaryOperator(c.operator)) {
            html += operandControls(model, scope, o, i, 'right', c.right);
        }
        return html;
    }

    function saveAliasButton(model, oi) {
        const t = model.tables[oi];
        const state = logic.aliasSaveState(model.aliases[oi], model.savedAliases[tableKey(t)], tableKey(t));
        return '<button type="button" class="btn btn-sm btn-icon"' + at('save-alias', oi) + ' title="' + escapeHtml(state.title) + '"' +
            (state.canSave ? '' : ' disabled') + '>' + icon('save') + '</button>';
    }

    function columnsHtml(model, oi, open) {
        const t = model.tables[oi];
        if (!t.columns.length) return '';
        const ticked = t.columns.filter(c => isColumnSelected(model, oi, c)).length;
        let html = '<details class="jb-columns"' + at('cols', oi) + (open ? ' open' : '') + '>' +
            '<summary>Columns (' + ticked + ' of ' + t.columns.length + ' selected)</summary>' +
            '<div class="jb-col-actions">' +
            labelButton('cols-all', oi, icon('check'), 'All', 'Select every column of ' + qualifierOf(model, oi)) +
            labelButton('cols-none', oi, icon('close'), 'None', 'Select no column of ' + qualifierOf(model, oi)) +
            '</div><div class="jb-col-list">';
        t.columns.forEach(c => {
            html += '<label class="jb-col"><input type="checkbox"' + at('col', oi) + ' data-c="' + escapeHtml(c) + '"' +
                (isColumnSelected(model, oi, c) ? ' checked' : '') + '><span class="mono">' + escapeHtml(c) + '</span></label>';
        });
        return html + '</div></details>';
    }

    function tableRowHtml(model, oi, pos, openColumns) {
        const t = model.tables[oi];
        const n = model.order.length;
        const name = t.raw
            ? '<code class="jb-raw" title="' + escapeHtml(t.raw) + '">' + escapeHtml(t.raw) + '</code>'
            : '<span class="jb-name">' + escapeHtml(tableKey(t)) + '</span>';
        const upBlock = pos > 0 ? moveBlockReason(model, pos, pos - 1) : '';
        const downBlock = pos < n - 1 ? moveBlockReason(model, pos, pos + 1) : '';
        const removeBlock = removeBlockReason(model, pos);
        return '<div class="jb-table" data-p="' + pos + '">' +
            '<div class="jb-table-head">' +
            '<span class="jb-grip" title="Drag to reorder">' + icon('grip') + '</span>' +
            button('up', pos, null, icon('arrow-up'), upBlock || 'Move up', '', pos === 0 || !!upBlock) +
            button('down', pos, null, icon('arrow-down'), downBlock || 'Move down', '', pos === n - 1 || !!downBlock) +
            '<span class="badge">' + (pos === 0 ? 'FROM' : 'JOIN') + '</span>' + name +
            '<span class="jb-as">as</span><input type="text" class="jb-alias"' + at('alias', oi) + ' value="' + escapeHtml(model.aliases[oi]) + '"' +
            (t.raw ? ' readonly title="Alias, kept as written in the FROM item"' : ' title="Alias"') + '>' +
            (t.raw ? '' : saveAliasButton(model, oi)) +
            '<span class="jb-spacer"></span>' +
            button('remove-table', pos, null, icon('close'), removeBlock || 'Remove table from the query', 'btn-ghost', n <= 1 || !!removeBlock) +
            '</div>' + columnsHtml(model, oi, openColumns.has(oi)) + '</div>';
    }

    function joinBlockHtml(model, oi, pos, joinTypes) {
        const t = model.tables[oi];
        const j = ensureJoin(model, oi);
        const types = joinTypes.indexOf(j.type) >= 0 ? joinTypes : joinTypes.concat([j.type]);
        const label = qualifierOf(model, oi) + ' (' + (t.raw ? t.raw : tableKey(t)) + ')';
        let html = '<div class="jb-join"><div class="jb-join-head"><select' + at('jtype', oi) + ' title="Join type">' +
            types.map(jt => '<option' + (jt === j.type ? ' selected' : '') + '>' + escapeHtml(jt) + '</option>').join('') +
            '</select><span class="jb-name">' + escapeHtml(label) + '</span></div>';
        if (j.type === 'CROSS JOIN') return html + '</div>';

        const earlier = earlierColumnOptions(model, pos);
        j.conditions.forEach((c, ci) => {
            const leftOpts = earlier.map(o => {
                const sel = o.orig === c.leftOrig && o.column === c.leftColumn;
                return '<option value="' + escapeHtml(o.orig + SEP + o.column) + '"' + (sel ? ' selected' : '') + '>' +
                    escapeHtml(o.ref) + '</option>';
            }).join('');
            const rightOpts = t.columns.map(col =>
                '<option value="' + escapeHtml(col) + '"' + (col === c.rightColumn ? ' selected' : '') + '>' + escapeHtml(col) + '</option>').join('');
            html += '<div class="jb-row"><select' + at('cond-left', oi, ci) + ' title="Column of an earlier table">' + leftOpts + '</select>' +
                '<span>=</span><span class="mono">' + escapeHtml(qualify(qualifierOf(model, oi), '')) + '</span>' +
                '<select' + at('cond-right', oi, ci) + ' title="Column of ' + escapeHtml(qualifierOf(model, oi)) + '">' + rightOpts + '</select>' +
                removeButton('rm-cond', oi, ci, 'Remove condition') + '</div>';
        });
        (j.literals || []).forEach((l, li) => {
            html += '<div class="jb-row jb-literal" title="Condition from a custom mapping — edit it to change it">' +
                '<span class="mono">' + escapeHtml(columnRef(model, l.litOrig, l.litColumn) + ' ' + l.operator + ' ' + logic.formatSqlLiteral(l.value)) + '</span>' +
                button('edit-lit', oi, li, icon('edit'), 'Edit condition') +
                removeButton('rm-lit', oi, li, 'Remove condition') + '</div>';
        });
        (model.customByOrig[oi] || []).forEach((c, ci) => {
            if (c.operator === undefined) {
                html += '<div class="jb-row" title="Condition kept as written">' +
                    '<input type="text" class="jb-text"' + at('cust-text', oi, ci) + ' value="' + escapeHtml(c.text || '') + '" placeholder="condition">' +
                    removeButton('rm-custom', oi, ci, 'Remove condition') + '</div>';
            } else {
                html += '<div class="jb-row" title="Fixed condition">' + conditionControls(model, 'cust', oi, ci, c) +
                    removeButton('rm-custom', oi, ci, 'Remove condition') + '</div>';
            }
        });
        const natural = isNaturalJoin(model, oi);
        const naturalTitle = 'NATURAL joins take no further conditions';
        html += '<div class="jb-row">' +
            labelButton('add-cond', oi, icon('add'), 'Add condition', natural ? naturalTitle : 'Join on a column of an earlier table',
                natural || !earlier.length || !t.columns.length) +
            labelButton('add-fixed', oi, icon('add'), 'Add fixed condition',
                natural ? naturalTitle : "Add an ON condition with a value, e.g. t.type = 'TGB' or CURRENT_TIMESTAMP BETWEEN t.valid_from AND t.valid_to", natural) +
            '</div>';
        return html + '</div>';
    }

    function selectListHtml(model) {
        let html = '<div class="jb-section-title">Columns</div>' +
            '<label class="jb-check"><input type="checkbox"' + at('distinct') + (model.distinct ? ' checked' : '') + '>DISTINCT</label>';
        if (!model.selectItems.length) {
            html += '<div class="hint">No column selected — the query returns every column (*).</div>';
        }
        html += '<div class="jb-list">';
        const n = model.selectItems.length;
        model.selectItems.forEach((it, i) => {
            html += '<div class="jb-row">' +
                button('sel-up', null, i, icon('arrow-up'), 'Move up', '', i === 0) +
                button('sel-down', null, i, icon('arrow-down'), 'Move down', '', i === n - 1) +
                (it.kind === 'column'
                    ? '<span class="mono jb-ref">' + escapeHtml(columnRef(model, it.orig, it.column)) + '</span>'
                    : '<input type="text" class="jb-text"' + at('sel-text', null, i) + ' value="' + escapeHtml(it.text) + '" placeholder="expression, e.g. count(*)">') +
                '<span class="jb-as">as</span><input type="text" class="jb-alias"' + at('sel-alias', null, i) + ' value="' + escapeHtml(it.alias || '') + '" placeholder="name" title="Column name in the result">' +
                removeButton('sel-rm', null, i, 'Remove from the SELECT list') + '</div>';
        });
        return html + '</div><div class="jb-row">' +
            labelButton('add-expr', null, icon('add'), 'Add expression', 'Select an expression such as count(*) or upper(t.name)') + '</div>';
    }

    function whereHtml(model) {
        let html = '<div class="jb-section-title">Where</div><div class="jb-list">';
        model.where.forEach((w, i) => {
            html += '<div class="jb-row">' + (w.kind === 'raw'
                ? '<input type="text" class="jb-text"' + at('where-text', null, i) + ' value="' + escapeHtml(w.text) + '" placeholder="condition, e.g. o.total > 100">'
                : conditionControls(model, 'where', null, i, w)) +
                removeButton('rm-where', null, i, 'Remove condition') + '</div>';
        });
        return html + '</div><div class="jb-row">' +
            labelButton('add-where', null, icon('add'), 'Add condition', 'Filter on a column') +
            labelButton('add-where-raw', null, icon('add'), 'Add text condition', 'Filter with a condition typed as SQL') + '</div>';
    }

    function orderByHtml(model) {
        let html = '<div class="jb-section-title">Order by</div>';
        // The ORDER BY of a set operation follows its last part, kept as written.
        if (model.carried.setOps && String(model.carried.setOps).trim()) {
            return html + '<div class="hint">A UNION query is sorted after its last part — edit the ORDER BY in the query bar.</div>';
        }
        html += '<div class="jb-list">';
        const n = model.orderBy.length;
        model.orderBy.forEach((o, i) => {
            html += '<div class="jb-row">' +
                button('order-up', null, i, icon('arrow-up'), 'Move up', '', i === 0) +
                button('order-down', null, i, icon('arrow-down'), 'Move down', '', i === n - 1) +
                '<select class="jb-operand"' + at('order-col', null, i) + ' title="Column or expression">' + columnOptions(model, o.column) +
                '<option value="__expr__"' + (o.column ? '' : ' selected') + '>Expression…</option></select>' +
                (o.column ? '' : '<input type="text" class="jb-value"' + at('order-expr', null, i) + ' value="' + escapeHtml(o.expr) + '" placeholder="expression">') +
                '<select' + at('order-dir', null, i) + ' title="Direction">' +
                [['', 'ASC'], ['DESC', 'DESC']].map(d => '<option value="' + d[0] + '"' + ((o.direction || '') === d[0] || (d[0] === '' && o.direction === 'ASC') ? ' selected' : '') + '>' + d[1] + '</option>').join('') +
                '</select><select' + at('order-nulls', null, i) + ' title="Position of NULL values">' +
                [['', 'NULLS default'], ['FIRST', 'NULLS FIRST'], ['LAST', 'NULLS LAST']].map(d => '<option value="' + d[0] + '"' + ((o.nulls || '') === d[0] ? ' selected' : '') + '>' + d[1] + '</option>').join('') +
                '</select>' + removeButton('rm-order', null, i, 'Remove sort item') + '</div>';
        });
        return html + '</div><div class="jb-row">' +
            labelButton('add-order', null, icon('add'), 'Add sort', 'Sort the result by a column or an expression') + '</div>';
    }

    function carriedHtml(model) {
        const carried = Object.assign({}, model.carried, model.distinct && model.distinctOn ? { distinctOn: model.distinctOn } : {});
        const parts = CARRIED_PARTS
            .filter(p => carried[p.key] && String(carried[p.key]).trim())
            .map(p => {
                const body = String(carried[p.key]).trim();
                const text = p.key === 'distinctOn' ? 'DISTINCT ON (' + body + ')' : (p.label ? p.label + ' ' + body : body);
                return '<code class="jb-carried-part">' + escapeHtml(text) + '</code>';
            });
        if (!parts.length) return '';
        return '<div class="jb-section-title">Kept as written</div><div class="jb-carried">' + parts.join('') + '</div>';
    }

    // ===== Component =========================================================

    /**
     * Render a join builder into `container`.
     *
     * Posts through `options.post` (the host answers by calling the returned
     * methods, or `handleMessage` with the same message):
     *  - `{ command: 'requestAddTables' }` — the user wants to add tables;
     *    answer with `addTables({ tables, fkEdges })`.
     *  - `{ command: 'saveAlias', schema, table, alias }` — store the alias;
     *    answer with `aliasSaved(schema, table, alias)`.
     *  - `{ command: 'tableRemoved', schema, table }` — a table left the query.
     *
     * @param {HTMLElement} container
     * @param {JoinBuilderState} initialState
     * @param {{ post?: (message: object) => void, onChange?: (state: JoinBuilderState) => void,
     *   joinTypes?: string[], identityEdges?: JoinBuilderEdge[], canAddTables?: boolean,
     *   selectNewTableColumns?: boolean, sections?: { select?: boolean, where?: boolean, orderBy?: boolean } }} [options]
     *   `onChange` fires after every change the user makes (not after `setState`).
     */
    function createJoinBuilder(container, initialState, options) {
        const opts = options || {};
        const post = typeof opts.post === 'function' ? opts.post : function () {};
        const joinTypes = Array.isArray(opts.joinTypes) && opts.joinTypes.length ? opts.joinTypes : DEFAULT_JOIN_TYPES;
        const sections = Object.assign({ select: true, where: true, orderBy: true }, opts.sections || {});
        let model = createModel(initialState, opts.identityEdges);
        const openColumns = new Set();
        let dragFromPos = null;

        const rootEl = document.createElement('div');
        rootEl.className = 'jb';
        container.appendChild(rootEl);

        function render() {
            normalizeJoins(model);
            let html = '<div class="jb-section-title">Tables</div><div class="jb-tables">' +
                model.order.map((oi, pos) => tableRowHtml(model, oi, pos, openColumns)).join('') + '</div>';
            if (opts.canAddTables !== false) {
                html += '<button type="button" class="btn jb-add-tables"' + at('add-tables') +
                    ' title="Add tables — those just dragged from the Tables view, otherwise picked from a list">' + icon('add') + 'Add tables</button>';
            }
            if (model.order.length > 1) {
                html += '<div class="jb-section-title">Joins</div>';
                for (let pos = 1; pos < model.order.length; pos++) html += joinBlockHtml(model, model.order[pos], pos, joinTypes);
            }
            if (sections.select) html += selectListHtml(model);
            if (sections.where) html += whereHtml(model);
            if (sections.orderBy) html += orderByHtml(model);
            html += carriedHtml(model);
            rootEl.innerHTML = html;
        }

        function changed(rerender) {
            if (rerender) render();
            if (typeof opts.onChange === 'function') opts.onChange(stateFromModel(model));
        }

        const num = (el, key) => Number(el.dataset[key]);
        const parseColumnValue = value => {
            const parts = String(value).split(SEP);
            return parts[0] === 'c' ? { orig: Number(parts[1]), column: parts.slice(2).join(SEP) } : null;
        };
        const customAt = el => (model.customByOrig[num(el, 'o')] || [])[num(el, 'i')];
        const whereAt = el => model.where[num(el, 'i')];
        const conditionOf = el => (el.dataset.jb.indexOf('cust-') === 0 ? customAt(el) : whereAt(el));

        function saveAlias(oi) {
            const input = rootEl.querySelector('[data-jb="alias"][data-o="' + oi + '"]');
            if (input) setTableAlias(model, oi, input.value);
            const t = model.tables[oi];
            if (!t || !logic.aliasSaveState(model.aliases[oi], model.savedAliases[tableKey(t)], '').canSave) return;
            post({ command: 'saveAlias', schema: t.schema, table: t.table, alias: model.aliases[oi] });
            changed(true);
        }

        const CLICK = {
            'up': el => moveTable(model, num(el, 'o'), num(el, 'o') - 1) && changed(true),
            'down': el => moveTable(model, num(el, 'o'), num(el, 'o') + 1) && changed(true),
            'remove-table': el => {
                const t = removeTableAt(model, num(el, 'o'));
                if (!t) return;
                if (!t.raw) post({ command: 'tableRemoved', schema: t.schema, table: t.table });
                changed(true);
            },
            'save-alias': (el, e) => { if (e.detail === 0) saveAlias(num(el, 'o')); },
            'add-tables': () => post({ command: 'requestAddTables' }),
            'add-cond': el => addJoinCondition(model, num(el, 'o')) && changed(true),
            'rm-cond': el => removeItem(ensureJoin(model, num(el, 'o')).conditions, num(el, 'i')) && changed(true),
            'rm-lit': el => removeItem(ensureJoin(model, num(el, 'o')).literals, num(el, 'i')) && changed(true),
            'edit-lit': el => promoteLiteral(model, num(el, 'o'), num(el, 'i')) && changed(true),
            'add-fixed': el => addFixedCondition(model, num(el, 'o')) && changed(true),
            'rm-custom': el => removeItem(ensureCustom(model, num(el, 'o')), num(el, 'i')) && changed(true),
            'cols-all': el => { setAllColumns(model, num(el, 'o'), true); changed(true); },
            'cols-none': el => { setAllColumns(model, num(el, 'o'), false); changed(true); },
            'sel-up': el => moveItem(model.selectItems, num(el, 'i'), -1) && changed(true),
            'sel-down': el => moveItem(model.selectItems, num(el, 'i'), 1) && changed(true),
            'sel-rm': el => removeItem(model.selectItems, num(el, 'i')) && changed(true),
            'add-expr': () => { addSelectExpression(model, ''); changed(true); },
            'add-where': () => { addWhereRow(model, false); changed(true); },
            'add-where-raw': () => { addWhereRow(model, true); changed(true); },
            'rm-where': el => removeItem(model.where, num(el, 'i')) && changed(true),
            'add-order': () => { addOrderByItem(model); changed(true); },
            'order-up': el => moveItem(model.orderBy, num(el, 'i'), -1) && changed(true),
            'order-down': el => moveItem(model.orderBy, num(el, 'i'), 1) && changed(true),
            'rm-order': el => removeItem(model.orderBy, num(el, 'i')) && changed(true)
        };

        const setOperator = el => {
            const c = conditionOf(el);
            if (!c) return;
            applyOperator(c, el.value);
            changed(true);
        };
        const setOperand = el => {
            const c = conditionOf(el);
            if (!c) return;
            const col = parseColumnValue(el.value);
            c[el.dataset.s] = col ? { kind: 'column', orig: col.orig, column: col.column } : { kind: 'raw', text: '' };
            changed(true);
        };

        const CHANGE = {
            'alias': el => { if (setTableAlias(model, num(el, 'o'), el.value)) changed(true); else render(); },
            'jtype': el => {
                const oi = num(el, 'o');
                model.typeByOrig[oi] = el.value;
                ensureJoin(model, oi).type = el.value;
                changed(true);
            },
            'cond-left': el => {
                const c = ensureJoin(model, num(el, 'o')).conditions[num(el, 'i')];
                if (!c) return;
                const parts = String(el.value).split(SEP);
                c.leftOrig = Number(parts[0]);
                c.leftColumn = parts.slice(1).join(SEP);
                changed(false);
            },
            'cond-right': el => {
                const c = ensureJoin(model, num(el, 'o')).conditions[num(el, 'i')];
                if (!c) return;
                c.rightColumn = el.value;
                changed(false);
            },
            'cust-operator': setOperator,
            'where-operator': setOperator,
            'cust-operand': setOperand,
            'where-operand': setOperand,
            'col': el => { toggleColumn(model, num(el, 'o'), el.dataset.c, el.checked); changed(true); },
            'distinct': el => { model.distinct = el.checked; changed(false); },
            'order-col': el => {
                const o = model.orderBy[num(el, 'i')];
                if (!o) return;
                const col = parseColumnValue(el.value);
                if (col) {
                    o.column = col;
                } else {
                    if (o.column) o.expr = columnRef(model, o.column.orig, o.column.column);
                    o.column = null;
                }
                changed(true);
            },
            'order-dir': el => { const o = model.orderBy[num(el, 'i')]; if (o) { o.direction = el.value; changed(false); } },
            'order-nulls': el => { const o = model.orderBy[num(el, 'i')]; if (o) { o.nulls = el.value; changed(false); } }
        };

        const setRaw = el => {
            const c = conditionOf(el);
            if (!c) return;
            c[el.dataset.s] = { kind: 'raw', text: el.value };
            changed(false);
        };

        const INPUT = {
            'alias': el => {
                const btn = rootEl.querySelector('[data-jb="save-alias"][data-o="' + el.dataset.o + '"]');
                const t = model.tables[num(el, 'o')];
                if (!btn || !t) return;
                const state = logic.aliasSaveState(el.value, model.savedAliases[tableKey(t)], tableKey(t));
                btn.disabled = !state.canSave;
                btn.title = state.title;
            },
            'cust-raw': setRaw,
            'where-raw': setRaw,
            'cust-text': el => { const c = customAt(el); if (c) { c.text = el.value; changed(false); } },
            'where-text': el => { const w = whereAt(el); if (w) { w.text = el.value; changed(false); } },
            'sel-text': el => { const it = model.selectItems[num(el, 'i')]; if (it) { it.text = el.value; changed(false); } },
            'sel-alias': el => { const it = model.selectItems[num(el, 'i')]; if (it) { it.alias = el.value; changed(false); } },
            'order-expr': el => { const o = model.orderBy[num(el, 'i')]; if (o) { o.expr = el.value; changed(false); } }
        };

        const target = (e, selector) => {
            const el = e.target && e.target.closest ? e.target.closest(selector || '[data-jb]') : null;
            return el && rootEl.contains(el) ? el : null;
        };
        const dispatch = table => e => {
            const el = target(e);
            if (!el || el.disabled) return;
            const handler = table[el.dataset.jb];
            if (handler) handler(el, e);
        };
        const onClick = dispatch(CLICK);
        const onChange = dispatch(CHANGE);
        const onInput = dispatch(INPUT);

        // Saving on mousedown keeps the click from being lost: leaving the alias
        // field would otherwise re-render the row under the pointer.
        function onMouseDown(e) {
            const grip = target(e, '.jb-grip');
            if (grip) {
                const row = grip.closest('.jb-table');
                if (row) row.draggable = true;
                return;
            }
            const el = target(e, '[data-jb="save-alias"]');
            if (!el || e.button !== 0 || el.disabled) return;
            e.preventDefault();
            saveAlias(num(el, 'o'));
        }

        function onToggle(e) {
            const el = e.target;
            if (!el || !el.dataset || el.dataset.jb !== 'cols' || !rootEl.contains(el)) return;
            if (el.open) openColumns.add(num(el, 'o')); else openColumns.delete(num(el, 'o'));
        }

        function clearDrag() {
            dragFromPos = null;
            rootEl.querySelectorAll('.jb-table').forEach(r => {
                r.classList.remove('dragging', 'drag-over');
                r.draggable = false;
            });
        }

        function onDragStart(e) {
            const row = target(e, '.jb-table');
            if (!row || !row.draggable) return;
            dragFromPos = Number(row.dataset.p);
            row.classList.add('dragging');
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(dragFromPos));
            }
        }
        function onDragOver(e) {
            if (dragFromPos === null || !target(e, '.jb-table')) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        }
        function onDragEnter(e) {
            const row = target(e, '.jb-table');
            if (dragFromPos === null || !row) return;
            e.preventDefault();
            if (Number(row.dataset.p) !== dragFromPos) row.classList.add('drag-over');
        }
        function onDragLeave(e) {
            const row = target(e, '.jb-table');
            if (row && !row.contains(e.relatedTarget)) row.classList.remove('drag-over');
        }
        function onDrop(e) {
            const row = target(e, '.jb-table');
            if (dragFromPos === null || !row) return;
            e.preventDefault();
            e.stopPropagation();
            const from = dragFromPos;
            clearDrag();
            if (moveTable(model, from, Number(row.dataset.p))) changed(true);
        }

        const listeners = [
            ['click', onClick], ['change', onChange], ['input', onInput], ['mousedown', onMouseDown],
            ['mouseup', () => { if (dragFromPos === null) clearDrag(); }],
            ['dragstart', onDragStart], ['dragend', clearDrag], ['dragover', onDragOver],
            ['dragenter', onDragEnter], ['dragleave', onDragLeave], ['drop', onDrop]
        ];
        listeners.forEach(l => rootEl.addEventListener(l[0], l[1]));
        rootEl.addEventListener('toggle', onToggle, true);

        render();

        const api = {
            /** Replace what the builder shows; does not fire `onChange`. */
            setState(state, identityEdges) {
                model = createModel(state, identityEdges || model.identityEdges);
                openColumns.clear();
                render();
            },
            /** @returns {JoinBuilderState} */
            getState() { return stateFromModel(model); },
            /** Append tables sent by the host after `requestAddTables`; fires `onChange`. */
            addTables(payload) {
                if (addTablesToModel(model, payload, opts.selectNewTableColumns !== false).length) changed(true);
            },
            /** The host stored `alias` for `schema.table`. */
            aliasSaved(schema, table, alias) {
                model.savedAliases[schema + '.' + table] = alias;
                render();
            },
            /** Route a host message (`addTables` / `aliasSaved`); true when it was one of them. */
            handleMessage(message) {
                const m = message || {};
                if (m.command === 'addTables') { api.addTables(m.payload); return true; }
                if (m.command === 'aliasSaved') { api.aliasSaved(m.schema, m.table, m.alias); return true; }
                return false;
            },
            destroy() {
                listeners.forEach(l => rootEl.removeEventListener(l[0], l[1]));
                rootEl.removeEventListener('toggle', onToggle, true);
                rootEl.remove();
            }
        };
        return api;
    }

    const exported = {
        DEFAULT_JOIN_TYPES,
        createModel,
        stateFromModel,
        normalizeJoins,
        moveTable,
        moveBlockReason,
        removeTableAt,
        removeBlockReason,
        setTableAlias,
        isColumnSelected,
        toggleColumn,
        setAllColumns,
        addTablesToModel,
        addJoinCondition,
        addFixedCondition,
        promoteLiteral,
        applyOperator,
        addWhereRow,
        addOrderByItem,
        addSelectExpression,
        moveItem,
        removeItem,
        conditionText,
        createJoinBuilder
    };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = exported;
    }
    if (root) {
        root.JoinBuilder = exported;
    }
})(typeof window !== 'undefined' ? window : null);
