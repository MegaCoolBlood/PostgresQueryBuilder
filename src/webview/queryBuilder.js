/*
 * Query Builder webview (host: src/queryBuilder.ts).
 *
 * The page is a view of the model the extension host owns: it renders the
 * `state` it receives (tables, joins, the column grid and the SQL) and posts
 * the user's intents (toggleColumn, connectColumns, …). Tables come from the
 * Tables view: the host adds them; a drop on the canvas only asks for them
 * (requestDroppedTables). Nothing is changed locally except the position of a
 * box while it is dragged.
 *
 * Pure helpers (layout, join line geometry, grid rows) sit at the top level
 * and are exported for the tests; the DOM code runs only inside a webview.
 */
'use strict';

const QB_JOIN_TYPES = ['INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS'];
/** Geometry of the diagram; matches queryBuilder.css (--qb-box-w, --qb-row-h, the header height). */
const QB_BOX = { width: 220, header: 29, row: 20, maxRows: 14, gapX: 90, gapY: 32, margin: 24 };
/** State origins (see queryBuilder.ts) that never rewrite the text being typed in the SQL tab. */
const SQL_PRESERVING_ORIGINS = ['sql', 'place', 'catalog'];

function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

const escapeAttr = escapeHtml;

function icon(name) {
    return `<svg class="ico" aria-hidden="true"><use href="#icon-${name}"/></svg>`;
}

// ===== Tables ===============================================================

/** The name a table goes by in the diagram and the grid: its alias, else its name. */
function tableLabel(table) {
    if (!table) return '';
    return table.alias || table.name || (table.kind === 'function' ? 'function' : 'subquery');
}

/** A table as named in sentences: `orders o`, or the alias of a subquery or function. */
function tableDescription(table) {
    if (!table) return '';
    if (table.kind === 'relation' && table.name) return table.alias && table.alias !== table.name ? `${table.name} ${table.alias}` : table.name;
    return tableLabel(table);
}

/** The title of a box: `schema.name` (or `(subquery)`, the function call) and the alias next to it. */
function tableTitle(table) {
    const alias = table.alias || '';
    if (table.kind === 'subquery') return { name: '(subquery)', alias };
    if (table.kind === 'function') {
        const call = String(table.sql || '').replace(/\s+/g, ' ').trim();
        return { name: call.length > 32 ? call.slice(0, 31) + '…' : call, alias };
    }
    const name = (table.schema ? table.schema + '.' : '') + (table.name || '');
    return { name, alias: alias && alias !== table.name ? alias : '' };
}

/**
 * The rows of a table box: the catalog columns plus every column the query
 * uses of the table (so a join or a grid column always has its row), each with
 * whether it is ticked as an output column.
 */
function boxColumns(table, catalog, model) {
    const out = [];
    const seen = new Set();
    const add = (name, info) => {
        if (!name || name === '*' || seen.has(name)) return;
        seen.add(name);
        out.push({ name, dataType: (info && info.dataType) || '', isPrimaryKey: !!(info && info.isPrimaryKey) });
    };
    (catalog || []).forEach(c => add(c.name, c));
    model.columns.forEach(c => { if (c.tableId === table.id && c.column) add(c.column); });
    model.joins.forEach(j => j.pairs.forEach(p => {
        if (j.leftTableId === table.id) add(p.leftColumn);
        if (j.rightTableId === table.id) add(p.rightColumn);
    }));
    const selected = new Set(model.columns.filter(c => c.output && c.tableId === table.id && c.column).map(c => c.column));
    return out.map(c => Object.assign(c, { selected: selected.has(c.name) }));
}

// ===== Layout ===============================================================

function isPlaced(table) {
    return typeof table.x === 'number' && typeof table.y === 'number';
}

/** Size of a box with `columnCount` rows (the list scrolls beyond QB_BOX.maxRows). */
function estimateBoxSize(columnCount) {
    const rows = Math.max(1, Math.min(columnCount || 0, QB_BOX.maxRows));
    return { width: QB_BOX.width, height: QB_BOX.header + rows * QB_BOX.row + 2 };
}

function sizeOf(sizes, id) {
    return (sizes && sizes[id]) || estimateBoxSize(0);
}

/** Neighbours of every table along the joins. */
function joinGraph(tables, joins) {
    const adjacent = new Map(tables.map(t => [t.id, []]));
    for (const j of joins) {
        if (j.leftTableId === j.rightTableId || !adjacent.has(j.leftTableId) || !adjacent.has(j.rightTableId)) continue;
        adjacent.get(j.leftTableId).push(j.rightTableId);
        adjacent.get(j.rightTableId).push(j.leftTableId);
    }
    return adjacent;
}

/**
 * Left-to-right layout: each group of joined tables starts with its first
 * table in the left column, a table joined to it goes one column to the right,
 * and so on; groups are stacked below each other. Returns `{ id: { x, y } }`.
 */
function autoLayout(tables, joins, sizes) {
    const adjacent = joinGraph(tables, joins);
    const level = new Map();
    const positions = {};
    let top = QB_BOX.margin;
    for (const table of tables) {
        if (level.has(table.id)) continue;
        const group = [];
        level.set(table.id, 0);
        const queue = [table.id];
        while (queue.length) {
            const id = queue.shift();
            group.push(id);
            for (const next of adjacent.get(id)) {
                if (!level.has(next)) {
                    level.set(next, level.get(id) + 1);
                    queue.push(next);
                }
            }
        }
        const columnBottom = {};
        let bottom = top;
        for (const id of group) {
            const lv = level.get(id);
            const y = columnBottom[lv] !== undefined ? columnBottom[lv] : top;
            positions[id] = { x: QB_BOX.margin + lv * (QB_BOX.width + QB_BOX.gapX), y };
            columnBottom[lv] = y + sizeOf(sizes, id).height + QB_BOX.gapY;
            bottom = Math.max(bottom, columnBottom[lv]);
        }
        top = bottom;
    }
    return positions;
}

function rectsOverlap(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Positions for the tables that have none yet, leaving the others where they
 * are: everything is laid out when nothing is placed; otherwise a new table
 * goes right of a placed table it is joined to, or into a column right of all
 * boxes, moved down until it overlaps no other box.
 */
function placeMissing(tables, joins, sizes) {
    const missing = tables.filter(t => !isPlaced(t));
    if (missing.length === 0) return {};
    const placed = tables.filter(isPlaced);
    if (placed.length === 0) return autoLayout(tables, joins, sizes);
    const rects = placed.map(t => Object.assign({ id: t.id, x: t.x, y: t.y }, sizeOf(sizes, t.id)));
    const rightEdge = Math.max(...rects.map(r => r.x + r.width)) + QB_BOX.gapX;
    const adjacent = joinGraph(tables, joins);
    const result = {};
    for (const table of missing) {
        const size = sizeOf(sizes, table.id);
        const partner = adjacent.get(table.id).map(id => rects.find(r => r.id === id)).find(Boolean);
        const rect = partner
            ? { x: partner.x + partner.width + QB_BOX.gapX, y: partner.y, width: size.width, height: size.height }
            : { x: rightEdge, y: QB_BOX.margin, width: size.width, height: size.height };
        for (let guard = 0; guard < 500; guard++) {
            const hit = rects.find(r => rectsOverlap(r, rect));
            if (!hit) break;
            rect.y = hit.y + hit.height + QB_BOX.gapY;
        }
        rects.push(Object.assign({ id: table.id }, rect));
        result[table.id] = { x: rect.x, y: rect.y };
    }
    return result;
}

// ===== Join lines ===========================================================

/**
 * The y of a column row's anchor inside its box: the middle of the row, kept
 * within the visible part of the scrolled column list.
 */
function rowAnchorY(list, row) {
    const center = list.top + row.top - (list.scrollTop || 0) + row.height / 2;
    return Math.max(list.top, Math.min(list.top + list.height, center));
}

function round1(n) {
    return Math.round(n * 10) / 10;
}

/**
 * A join line between two boxes. `a` and `b` are `{ x, y, width, height,
 * anchorY }` with anchorY relative to the box. The line leaves each box on the
 * edge facing the other; boxes stacked above each other are both joined on
 * their left edge. Returns the end points, sides, the SVG path and its middle.
 */
function joinLineGeometry(a, b) {
    let aSide;
    let bSide;
    if (b.x >= a.x + a.width) {
        aSide = 'right';
        bSide = 'left';
    } else if (a.x >= b.x + b.width) {
        aSide = 'left';
        bSide = 'right';
    } else {
        aSide = 'left';
        bSide = 'left';
    }
    const from = { x: aSide === 'right' ? a.x + a.width : a.x, y: a.y + a.anchorY };
    const to = { x: bSide === 'right' ? b.x + b.width : b.x, y: b.y + b.anchorY };
    const bend = Math.max(36, Math.abs(to.x - from.x) / 2);
    const c1 = { x: from.x + (aSide === 'right' ? bend : -bend), y: from.y };
    const c2 = { x: to.x + (bSide === 'right' ? bend : -bend), y: to.y };
    const mid = {
        x: round1(0.125 * from.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * to.x),
        y: round1(0.125 * from.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * to.y)
    };
    const p = pt => `${round1(pt.x)} ${round1(pt.y)}`;
    return {
        from,
        to,
        fromSide: aSide,
        toSide: bSide,
        path: `M ${p(from)} C ${p(c1)}, ${p(c2)}, ${p(to)}`,
        mid
    };
}

/** CSS class of a join line: dashed for outer joins, dotted for a cross join. */
function joinLineClass(type) {
    if (type === 'LEFT' || type === 'RIGHT' || type === 'FULL') return 'qb-join-line outer';
    if (type === 'CROSS') return 'qb-join-line cross';
    return 'qb-join-line';
}

/** Which ends of a join keep all their rows (drawn with a dot). */
function preservedEnds(type) {
    return { left: type === 'LEFT' || type === 'FULL', right: type === 'RIGHT' || type === 'FULL' };
}

/** The choices of the join dialog, worded like SQL Developer's. */
function joinTypeChoices(leftLabel, rightLabel) {
    return [
        { type: 'INNER', label: 'Inner join', description: 'Only rows that match in both tables' },
        { type: 'LEFT', label: 'Left outer join', description: 'Include all rows from ' + leftLabel },
        { type: 'RIGHT', label: 'Right outer join', description: 'Include all rows from ' + rightLabel },
        { type: 'FULL', label: 'Full outer join', description: 'Include all rows from ' + leftLabel + ' and from ' + rightLabel },
        { type: 'CROSS', label: 'Cross join', description: 'Every row of ' + leftLabel + ' with every row of ' + rightLabel + ', no condition' }
    ];
}

// ===== Column grid ==========================================================

/** Number of criteria columns of the grid: the ones in use plus one empty, at least Criteria and one Or. */
function criteriaColumnCount(model) {
    const used = model.columns.reduce((max, c) => Math.max(max, (c.criteria || []).length), 0);
    return Math.max(2, used + 1);
}

/** Header of criteria column `i`: Criteria, then Or… */
function criteriaHeader(i) {
    return i === 0 ? 'Criteria' : 'Or…';
}

/**
 * One view row per grid column. `groupBy` is 'on' (ticked), 'auto' (grouped
 * because another column is aggregated, as the SQL generator does) or 'off'.
 */
function buildGridRows(model) {
    const count = criteriaColumnCount(model);
    const tables = new Map(model.tables.map(t => [t.id, t]));
    const autoGroup = model.autoGroupBy !== false && model.columns.some(c => !!c.aggregate);
    return model.columns.map((c, index) => {
        const plain = !!c.tableId && !!c.column && c.column !== '*';
        const criteria = [];
        for (let i = 0; i < count; i++) criteria.push((c.criteria || [])[i] || '');
        return {
            id: c.id,
            index,
            output: !!c.output,
            expression: c.expression,
            alias: c.alias || '',
            table: c.tableId ? tableLabel(tables.get(c.tableId)) : '',
            aggregate: c.aggregate || '',
            sortType: c.sortType || '',
            sortOrder: c.sortOrder ? String(c.sortOrder) : '',
            nulls: c.nulls || '',
            groupBy: c.groupBy ? 'on' : (autoGroup && !c.aggregate && c.output && plain ? 'auto' : 'off'),
            criteria,
            having: c.having || '',
            first: index === 0,
            last: index === model.columns.length - 1
        };
    });
}

/**
 * The index to move a dragged grid row to when it is dropped before or after
 * the row at `target` (moveColumn takes the row out before inserting it).
 */
function reorderIndex(from, target, before) {
    let to = target + (before ? 0 : 1);
    if (from < to) to--;
    return to;
}

// ===== Misc =================================================================

/** Where a SQL error is, for the line under the editor. */
function sqlErrorText(status) {
    const where = status.line ? `Line ${status.line}, column ${status.column}: ` : '';
    return where + (status.message || 'The SQL cannot be read.');
}

/** Whether a key press belongs to a text field rather than to the diagram's shortcuts. */
function isTypingTarget(el) {
    if (!el || !el.tagName) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName.toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return !['checkbox', 'radio', 'button'].includes(String(el.type || '').toLowerCase());
    return false;
}

/**
 * The text of the SQL tab: the generated SQL, or what the user typed (sent to
 * the host after a pause) until the host has read it. A text the host could
 * not read stays, with its error, until it is fixed or the model changes —
 * `state` messages say so with `sqlError`. `io` connects it to the page:
 * getText/setText, showStatus(status), post(message), setTimer/clearTimer.
 */
function createSqlText(io) {
    let generated = '';
    let dirty = false;
    let hasError = false;
    let seq = 0;
    let timer = null;

    function set(textValue) {
        io.clearTimer(timer);
        dirty = false;
        if (io.getText() !== textValue) io.setText(textValue);
    }

    function status(value) {
        hasError = !value.ok;
        io.showStatus(value);
    }

    function flush() {
        io.clearTimer(timer);
        if (!dirty) return;
        dirty = false;
        io.post({ command: 'sqlEdited', sql: io.getText(), seq: ++seq });
    }

    return {
        get hasError() { return hasError; },
        flush,
        /** The user typed in the SQL tab. */
        input() {
            dirty = true;
            io.clearTimer(timer);
            timer = io.setTimer(flush, 600);
        },
        /** The SQL tab is shown: it shows the generated SQL unless a typed or unreadable text is pending. */
        shown() {
            if (!dirty && !hasError) set(generated);
        },
        /** A `state` message; `sqlTabActive` while the user may be typing. */
        state(msg, sqlTabActive) {
            generated = msg.sql || '';
            if (msg.sqlError) return;
            // Text typed in the SQL tab is not replaced while the user is at it:
            // neither by its own parse result nor by changes that keep the query.
            if (!sqlTabActive || !SQL_PRESERVING_ORIGINS.includes(msg.origin)) {
                set(generated);
                status({ ok: true });
            }
        },
        /** A `sqlStatus` message; true when the SQL tab is to be shown. */
        status(msg) {
            if (typeof msg.sql === 'string') {
                // The SQL the builder was opened with could not be read: the
                // error goes first, so showing the tab keeps the text.
                status(msg);
                set(msg.sql);
                return true;
            }
            if (msg.seq === seq) status(msg);
            return false;
        }
    };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof acquireVsCodeApi === 'function') {
    const vscode = acquireVsCodeApi();
    const config = window.QB_CONFIG || { aggregates: [], canApply: false, previewRows: 100 };
    const $ = id => document.getElementById(id);

    const canvasWrap = $('canvasWrap');
    const canvas = $('canvas');
    const gridHead = $('gridHead');
    const gridBody = $('gridBody');
    const sqlInput = $('sqlInput');
    const sqlError = $('sqlError');
    const sqlErrorTextEl = $('sqlErrorText');
    const noticeEl = $('notice');
    const warningsEl = $('warnings');
    const resultStatus = $('resultStatus');
    const resultTable = $('resultTable');
    const distinctToggle = $('distinctToggle');
    const newExpression = $('newExpression');

    let model = { distinct: false, ctes: [], tables: [], joins: [], columns: [], warnings: [] };
    let columnsByTable = {};
    let selection = null;
    let activeTab = 'diagram';
    let dismissedWarnings = '';
    let noticeTimer = null;
    let dialogState = null;

    const post = message => vscode.postMessage(message);

    // ----- SQL editor ------------------------------------------------------

    let queryEditor = null;
    if (window.QueryEditor && typeof window.QueryEditor.attach === 'function') {
        queryEditor = window.QueryEditor.attach(sqlInput, {
            postMessage: post,
            onRun: run,
            onUndo: () => post({ command: 'undo' }),
            onRedo: () => post({ command: 'redo' })
        });
    }

    const sqlText = createSqlText({
        getText: () => sqlInput.value,
        setText: textValue => { sqlInput.value = textValue; },
        post,
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: handle => clearTimeout(handle),
        showStatus: status => {
            sqlError.hidden = !!status.ok;
            if (!status.ok) sqlErrorTextEl.textContent = sqlErrorText(status);
        }
    });
    const flushSql = sqlText.flush;

    sqlInput.addEventListener('input', () => sqlText.input());

    // ----- Tabs ------------------------------------------------------------

    function showTab(tab) {
        if (activeTab === 'sql' && tab !== 'sql') flushSql();
        activeTab = tab;
        document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
        $('tabDiagram').hidden = tab !== 'diagram';
        $('tabSql').hidden = tab !== 'sql';
        $('tabResults').hidden = tab !== 'results';
        if (tab === 'sql') sqlText.shown();
        if (tab === 'diagram') drawJoins();
    }

    // ----- Notices ---------------------------------------------------------

    function showNotice(textValue, kind) {
        clearTimeout(noticeTimer);
        noticeEl.textContent = textValue || '';
        noticeEl.title = textValue || '';
        noticeEl.classList.toggle('error', kind === 'error');
        noticeTimer = setTimeout(() => { noticeEl.textContent = ''; noticeEl.title = ''; }, kind === 'error' ? 15000 : 5000);
    }

    function renderWarnings() {
        const list = model.warnings || [];
        const textValue = list.join(' ');
        warningsEl.hidden = !textValue || textValue === dismissedWarnings;
        $('warningsText').textContent = textValue;
    }

    // ----- State -----------------------------------------------------------

    function tableById(id) {
        return model.tables.find(t => t.id === id);
    }

    function receiveState(msg) {
        model = msg.model;
        columnsByTable = msg.columns || {};
        document.querySelector('[data-action="undo"]').disabled = !msg.canUndo;
        document.querySelector('[data-action="redo"]').disabled = !msg.canRedo;
        distinctToggle.checked = !!model.distinct;
        if (selection && !selectionExists(selection)) selection = null;
        sqlText.state(msg, activeTab === 'sql');
        renderWarnings();
        renderCanvas();
        renderGrid();
    }

    function selectionExists(sel) {
        if (sel.kind === 'table') return !!tableById(sel.id);
        if (sel.kind === 'join') return model.joins.some(j => j.id === sel.id);
        return model.columns.some(c => c.id === sel.id);
    }

    function select(kind, id) {
        selection = kind ? { kind, id } : null;
        canvas.querySelectorAll('.qb-box').forEach(b => b.classList.toggle('selected', !!selection && selection.kind === 'table' && b.dataset.tableId === selection.id));
        canvas.querySelectorAll('.qb-join').forEach(g => g.classList.toggle('selected', !!selection && selection.kind === 'join' && g.dataset.joinId === selection.id));
        gridBody.querySelectorAll('tr[data-column-id]').forEach(r => r.classList.toggle('selected', !!selection && selection.kind === 'column' && r.dataset.columnId === selection.id));
    }

    // ----- Canvas ----------------------------------------------------------

    function estimatedSizes() {
        const sizes = {};
        for (const t of model.tables) sizes[t.id] = estimateBoxSize(boxColumns(t, columnsByTable[t.id], model).length);
        return sizes;
    }

    function measuredSizes() {
        const sizes = estimatedSizes();
        canvas.querySelectorAll('.qb-box').forEach(box => {
            sizes[box.dataset.tableId] = { width: box.offsetWidth, height: box.offsetHeight };
        });
        return sizes;
    }

    function boxMarkup(table, pos) {
        const title = tableTitle(table);
        const cols = boxColumns(table, columnsByTable[table.id], model);
        const allSelected = cols.length > 0 && cols.every(c => c.selected);
        const editTitle = table.kind === 'relation' ? 'Edit the alias' : 'Edit the alias and the SQL';
        const rows = cols.length
            ? cols.map(c => `<div class="qb-col" data-column="${escapeAttr(c.name)}" title="${escapeAttr(c.name + (c.dataType ? ' — ' + c.dataType : '') + '. Drag onto a column of another table to join them.')}">`
                + `<input type="checkbox" data-col-toggle${c.selected ? ' checked' : ''} aria-label="${escapeAttr('Output column ' + c.name)}">`
                + `<span class="qb-col-name">${escapeHtml(c.name)}</span>`
                + (c.isPrimaryKey ? '<span class="qb-col-pk" title="Primary key">PK</span>' : '')
                + `<span class="qb-col-type">${escapeHtml(c.dataType)}</span></div>`).join('')
            : `<div class="qb-box-empty hint">${table.kind === 'function' ? 'Columns unknown' : 'No columns known'}</div>`;
        return `<div class="qb-box${selection && selection.kind === 'table' && selection.id === table.id ? ' selected' : ''}" data-table-id="${escapeAttr(table.id)}" style="--x:${pos.x}px;--y:${pos.y}px">`
            + `<div class="qb-box-head" title="${escapeAttr(title.name + (title.alias ? ' ' + title.alias : '') + '. Drag to move.')}">`
            + `<span class="qb-box-title">${escapeHtml(title.name)}${title.alias ? `<span class="qb-box-alias">${escapeHtml(title.alias)}</span>` : ''}</span>`
            + `<button class="btn btn-ghost btn-icon btn-sm" data-box-action="edit" title="${editTitle}">${icon('edit')}</button>`
            + (cols.length ? `<button class="btn btn-ghost btn-icon btn-sm" data-box-action="all" title="${allSelected ? 'Clear all output columns' : 'Select all columns'}">${icon('check')}</button>` : '')
            + `<button class="btn btn-ghost btn-icon btn-sm" data-box-action="remove" title="Remove the table from the query">${icon('close')}</button>`
            + `</div><div class="qb-box-cols">${rows}</div></div>`;
    }

    /** Positions of all boxes: stored ones, and a computed place for new tables (sent to the host once). */
    function boxPositions() {
        const positions = {};
        model.tables.forEach(t => { if (isPlaced(t)) positions[t.id] = { x: t.x, y: t.y }; });
        const missing = placeMissing(model.tables, model.joins, estimatedSizes());
        const placements = Object.keys(missing).map(id => ({ tableId: id, x: missing[id].x, y: missing[id].y }));
        if (placements.length) post({ command: 'placeTables', positions: placements, record: false });
        return Object.assign(positions, missing);
    }

    function renderCanvas() {
        const positions = boxPositions();
        const boxes = model.tables.map(t => boxMarkup(t, positions[t.id])).join('');
        const empty = model.tables.length === 0
            ? '<div class="qb-canvas-empty">'
                + '<p>Right-click tables in the Tables view and choose Add to Query Builder, or drag them here. Drag a column onto a column of another table to join them.</p>'
                + `<button class="btn btn-sm" data-action="addDraggedTables" title="Add the tables last dragged from the Tables view">${icon('add')}Add Dragged Tables</button>`
                + '</div>'
            : '';
        canvas.innerHTML = '<svg class="qb-join-layer" id="joinLayer"></svg>' + boxes + empty;
        canvas.querySelectorAll('.qb-box-cols').forEach(list => list.addEventListener('scroll', drawJoins));
        updateCanvasSize();
        drawJoins();
    }

    function updateCanvasSize() {
        let w = 0;
        let h = 0;
        canvas.querySelectorAll('.qb-box').forEach(box => {
            w = Math.max(w, box.offsetLeft + box.offsetWidth);
            h = Math.max(h, box.offsetTop + box.offsetHeight);
        });
        canvas.style.setProperty('--canvas-w', (w + 200) + 'px');
        canvas.style.setProperty('--canvas-h', (h + 200) + 'px');
    }

    function boxOf(tableId) {
        return canvas.querySelector(`.qb-box[data-table-id="${CSS.escape(tableId)}"]`);
    }

    function boxRect(box) {
        return { x: box.offsetLeft, y: box.offsetTop, width: box.offsetWidth, height: box.offsetHeight };
    }

    /** Anchor of a column row relative to its box; the header middle when there is no such row. */
    function anchorOf(box, column) {
        const list = box.querySelector('.qb-box-cols');
        const row = column ? box.querySelector(`.qb-col[data-column="${CSS.escape(column)}"]`) : null;
        if (!list || !row) return QB_BOX.header / 2;
        return rowAnchorY(
            { top: list.offsetTop, height: list.clientHeight, scrollTop: list.scrollTop },
            { top: row.offsetTop, height: row.offsetHeight }
        );
    }

    function joinMarkup(join) {
        const leftBox = boxOf(join.leftTableId);
        const rightBox = boxOf(join.rightTableId);
        if (!leftBox || !rightBox || leftBox === rightBox) return '';
        const pairs = join.pairs.length ? join.pairs : [{ leftColumn: null, rightColumn: null }];
        const ends = preservedEnds(join.type);
        const selected = selection && selection.kind === 'join' && selection.id === join.id;
        let out = `<g class="qb-join${selected ? ' selected' : ''}" data-join-id="${escapeAttr(join.id)}">`;
        let labelAt = null;
        pairs.forEach((pair, i) => {
            const a = Object.assign(boxRect(leftBox), { anchorY: anchorOf(leftBox, pair.leftColumn) });
            const b = Object.assign(boxRect(rightBox), { anchorY: anchorOf(rightBox, pair.rightColumn) });
            const g = joinLineGeometry(a, b);
            out += `<path class="${joinLineClass(join.type)}" d="${g.path}"/>`;
            out += `<path class="qb-join-hit" d="${g.path}"><title>${escapeHtml(join.type + ' JOIN — click to edit')}</title></path>`;
            if (ends.left) out += `<circle class="qb-join-dot" cx="${round1(g.from.x)}" cy="${round1(g.from.y)}" r="3.5"/>`;
            if (ends.right) out += `<circle class="qb-join-dot" cx="${round1(g.to.x)}" cy="${round1(g.to.y)}" r="3.5"/>`;
            if (i === 0) labelAt = g.mid;
        });
        if (labelAt) {
            const label = join.natural ? 'NATURAL' : join.type;
            const w = label.length * 7 + 10;
            out += `<g class="qb-join-label"><title>${escapeHtml('Edit the ' + label + ' join')}</title>`
                + `<rect x="${round1(labelAt.x - w / 2)}" y="${round1(labelAt.y - 8)}" width="${w}" height="16" rx="3"/>`
                + `<text x="${labelAt.x}" y="${labelAt.y}">${escapeHtml(label)}</text></g>`;
        }
        return out + '</g>';
    }

    function drawJoins() {
        const layer = $('joinLayer');
        if (!layer || activeTab !== 'diagram') return;
        layer.innerHTML = model.joins.map(joinMarkup).join('');
    }

    function canvasPoint(e) {
        const r = canvas.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function startBoxDrag(e, box) {
        const id = box.dataset.tableId;
        select('table', id);
        const start = { x: e.clientX, y: e.clientY };
        const origin = { x: box.offsetLeft, y: box.offsetTop };
        let moved = false;
        let pos = origin;
        const move = ev => {
            const dx = ev.clientX - start.x;
            const dy = ev.clientY - start.y;
            if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
            moved = true;
            box.classList.add('dragging');
            pos = { x: Math.max(0, Math.round(origin.x + dx)), y: Math.max(0, Math.round(origin.y + dy)) };
            box.style.setProperty('--x', pos.x + 'px');
            box.style.setProperty('--y', pos.y + 'px');
            drawJoins();
        };
        const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            box.classList.remove('dragging');
            if (!moved) return;
            const table = tableById(id);
            if (table) {
                table.x = pos.x;
                table.y = pos.y;
            }
            updateCanvasSize();
            post({ command: 'moveTable', tableId: id, x: pos.x, y: pos.y });
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        e.preventDefault();
    }

    function startJoinDrag(e, row) {
        const box = row.closest('.qb-box');
        const source = { tableId: box.dataset.tableId, column: row.dataset.column };
        const start = { x: e.clientX, y: e.clientY };
        let active = false;
        let target = null;
        let temp = null;
        const move = ev => {
            if (!active && Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) < 4) return;
            active = true;
            const layer = $('joinLayer');
            if (!temp && layer) {
                temp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                temp.setAttribute('class', 'qb-join-temp');
                layer.appendChild(temp);
            }
            const p = canvasPoint(ev);
            const rect = boxRect(box);
            const right = p.x > rect.x + rect.width / 2;
            const from = { x: right ? rect.x + rect.width : rect.x, y: rect.y + anchorOf(box, source.column) };
            if (temp) temp.setAttribute('d', `M ${from.x} ${from.y} L ${p.x} ${p.y}`);
            const under = document.elementFromPoint(ev.clientX, ev.clientY);
            const hit = under && under.closest ? under.closest('.qb-col') : null;
            const valid = hit && hit.closest('.qb-box') !== box ? hit : null;
            if (target && target !== valid) target.classList.remove('join-target');
            target = valid;
            if (target) target.classList.add('join-target');
        };
        const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            if (temp) temp.remove();
            if (!active || !target) return;
            target.classList.remove('join-target');
            post({
                command: 'connectColumns',
                leftTableId: source.tableId,
                leftColumn: source.column,
                rightTableId: target.closest('.qb-box').dataset.tableId,
                rightColumn: target.dataset.column
            });
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        e.preventDefault();
    }

    canvas.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        const t = e.target;
        if (t.closest('button') || t.closest('input')) return;
        const join = t.closest('.qb-join');
        if (join) {
            select('join', join.dataset.joinId);
            return;
        }
        const head = t.closest('.qb-box-head');
        if (head) {
            startBoxDrag(e, head.closest('.qb-box'));
            return;
        }
        const row = t.closest('.qb-col');
        if (row) {
            select('table', row.closest('.qb-box').dataset.tableId);
            startJoinDrag(e, row);
            return;
        }
        if (!t.closest('.qb-box')) select(null);
    });

    canvas.addEventListener('click', e => {
        const action = e.target.closest('[data-box-action]');
        if (action) {
            const id = action.closest('.qb-box').dataset.tableId;
            const table = tableById(id);
            if (!table) return;
            if (action.dataset.boxAction === 'remove') post({ command: 'removeTable', tableId: id });
            else if (action.dataset.boxAction === 'edit') openTableDialog(table);
            else if (action.dataset.boxAction === 'all') {
                const cols = boxColumns(table, columnsByTable[id], model);
                const all = cols.every(c => c.selected);
                post({ command: 'setAllColumns', tableId: id, columns: cols.map(c => c.name), output: !all });
            }
            return;
        }
        const join = e.target.closest('.qb-join');
        if (join) openJoinDialog(join.dataset.joinId);
    });

    canvas.addEventListener('dblclick', e => {
        const head = e.target.closest('.qb-box-head');
        if (head && !e.target.closest('button')) {
            const table = tableById(head.closest('.qb-box').dataset.tableId);
            if (table) openTableDialog(table);
        }
    });

    canvas.addEventListener('change', e => {
        const toggle = e.target.closest('[data-col-toggle]');
        if (!toggle) return;
        const row = toggle.closest('.qb-col');
        post({ command: 'toggleColumn', tableId: row.closest('.qb-box').dataset.tableId, column: row.dataset.column, output: toggle.checked });
    });

    // Tables dragged from the Tables view: VS Code does not hand their names to
    // the webview, so the drop asks the host for the tables it saw dragged.
    // Grid rows are the only HTML drag of the page itself.
    canvasWrap.addEventListener('dragover', e => {
        if (!e.dataTransfer || draggedRow) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        canvas.classList.add('drop-target');
    });
    canvasWrap.addEventListener('dragleave', e => {
        if (!canvasWrap.contains(e.relatedTarget)) canvas.classList.remove('drop-target');
    });
    canvasWrap.addEventListener('drop', e => {
        canvas.classList.remove('drop-target');
        if (draggedRow) return;
        e.preventDefault();
        const p = canvasPoint(e);
        post({ command: 'requestDroppedTables', x: Math.max(0, Math.round(p.x - 24)), y: Math.max(0, Math.round(p.y - 12)) });
    });

    // ----- Grid ------------------------------------------------------------

    function renderGridHead() {
        const count = criteriaColumnCount(model);
        let crit = '';
        for (let i = 0; i < count; i++) crit += `<th title="${i === 0 ? 'WHERE condition on the expression, e.g. = 5, LIKE \'A%\', IS NULL. Conditions in one column are combined with AND.' : 'An alternative condition: the columns are combined with OR.'}">${criteriaHeader(i)}</th>`;
        gridHead.innerHTML = '<tr><th></th>'
            + '<th title="Part of the select list">Output</th><th>Expression</th><th>Alias</th><th>Table</th>'
            + '<th>Aggregate</th><th>Sort type</th><th title="Position in ORDER BY">Sort order</th><th>Nulls</th>'
            + '<th title="Part of GROUP BY">Group by</th>' + crit
            + '<th title="HAVING condition on the (aggregated) expression">Having</th><th></th></tr>';
    }

    function option(value, label, current) {
        return `<option value="${escapeAttr(value)}"${value === current ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    }

    function gridRowMarkup(row) {
        const aggregates = option('', '', row.aggregate) + (config.aggregates || []).map(a => option(a, a, row.aggregate)).join('');
        const sorts = option('', '', row.sortType) + option('ASC', 'Ascending', row.sortType) + option('DESC', 'Descending', row.sortType);
        const nulls = option('', 'Default', row.nulls) + option('FIRST', 'First', row.nulls) + option('LAST', 'Last', row.nulls);
        const groupTitle = row.groupBy === 'auto' ? 'Grouped automatically, because another column is aggregated' : 'Part of GROUP BY';
        const criteria = row.criteria.map((c, i) => `<td class="qb-w-crit"><input type="text" data-field="criteria" data-row="${i}" value="${escapeAttr(c)}" spellcheck="false" aria-label="${escapeAttr(criteriaHeader(i) + ' of ' + row.expression)}"></td>`).join('');
        const selected = selection && selection.kind === 'column' && selection.id === row.id;
        return `<tr data-column-id="${escapeAttr(row.id)}" data-index="${row.index}" class="${selected ? 'selected' : ''}${row.output ? '' : ' hidden-output'}">`
            + `<td><span class="qb-handle" draggable="true" title="Drag to change the order; click to select the row">${icon('grip')}</span></td>`
            + `<td class="qb-center"><input type="checkbox" data-field="output"${row.output ? ' checked' : ''} aria-label="Output"></td>`
            + `<td class="qb-w-expr"><input type="text" data-field="expression" value="${escapeAttr(row.expression)}" spellcheck="false" aria-label="Expression"></td>`
            + `<td class="qb-w-alias"><input type="text" data-field="alias" value="${escapeAttr(row.alias)}" spellcheck="false" aria-label="Alias"></td>`
            + `<td>${escapeHtml(row.table)}</td>`
            + `<td><select data-field="aggregate" aria-label="Aggregate">${aggregates}</select></td>`
            + `<td><select data-field="sortType" aria-label="Sort type">${sorts}</select></td>`
            + `<td class="qb-w-order"><input type="number" min="1" step="1" data-field="sortOrder" value="${escapeAttr(row.sortOrder)}"${row.sortType ? '' : ' disabled'} aria-label="Sort order"></td>`
            + `<td><select data-field="nulls"${row.sortType ? '' : ' disabled'} aria-label="Nulls">${nulls}</select></td>`
            + `<td class="qb-center"><input type="checkbox" data-field="groupBy"${row.groupBy !== 'off' ? ' checked' : ''}${row.groupBy === 'auto' ? ' class="qb-auto-group"' : ''} title="${groupTitle}" aria-label="Group by"></td>`
            + criteria
            + `<td class="qb-w-crit"><input type="text" data-field="having" value="${escapeAttr(row.having)}" spellcheck="false" aria-label="Having"></td>`
            + `<td><div class="qb-row-actions">`
            + `<button class="btn btn-ghost btn-icon btn-sm" data-grid-action="up" title="Move up"${row.first ? ' disabled' : ''}>${icon('arrow-up')}</button>`
            + `<button class="btn btn-ghost btn-icon btn-sm" data-grid-action="down" title="Move down"${row.last ? ' disabled' : ''}>${icon('arrow-down')}</button>`
            + `<button class="btn btn-danger btn-icon btn-sm" data-grid-action="remove" title="Delete the row">${icon('trash')}</button>`
            + `</div></td></tr>`;
    }

    function renderGrid() {
        // Keep the focus in the cell the user moved to while the grid is rebuilt.
        const active = document.activeElement;
        let focus = null;
        if (active && gridBody.contains(active) && active.dataset.field) {
            focus = { id: active.closest('tr').dataset.columnId, field: active.dataset.field, row: active.dataset.row, start: active.selectionStart, end: active.selectionEnd };
        }
        renderGridHead();
        const rows = buildGridRows(model);
        gridBody.innerHTML = rows.length
            ? rows.map(gridRowMarkup).join('')
            : `<tr class="qb-grid-empty"><td colspan="${13 + criteriaColumnCount(model)}">Tick the columns of a table, or add an expression below.</td></tr>`;
        if (focus) {
            const selector = `tr[data-column-id="${CSS.escape(focus.id)}"] [data-field="${focus.field}"]` + (focus.row !== undefined ? `[data-row="${focus.row}"]` : '');
            const el = gridBody.querySelector(selector);
            if (el) {
                el.focus();
                if (typeof focus.start === 'number' && typeof el.setSelectionRange === 'function') {
                    try { el.setSelectionRange(focus.start, focus.end); } catch { /* number inputs have no selection */ }
                }
            }
        }
    }

    function columnById(id) {
        return model.columns.find(c => c.id === id);
    }

    function commitGridField(el) {
        const tr = el.closest('tr[data-column-id]');
        if (!tr) return;
        const id = tr.dataset.columnId;
        const column = columnById(id);
        if (!column) return;
        const field = el.dataset.field;
        const value = el.type === 'checkbox' ? el.checked : el.value;
        if (el.type !== 'checkbox') {
            if (el.dataset.committed === value) return;
            el.dataset.committed = value;
        }
        switch (field) {
            case 'output':
            case 'groupBy':
                post({ command: 'updateColumn', columnId: id, patch: { [field]: value } });
                break;
            case 'expression':
                if (!value.trim() || value === column.expression) { el.value = column.expression; return; }
                post({ command: 'updateColumn', columnId: id, patch: { expression: value } });
                break;
            case 'alias':
            case 'aggregate':
            case 'having':
                post({ command: 'updateColumn', columnId: id, patch: { [field]: value || null } });
                break;
            case 'sortType':
                post({ command: 'setSort', columnId: id, sortType: value || null, nulls: column.nulls || null });
                break;
            case 'sortOrder': {
                const n = parseInt(value, 10);
                if (!column.sortType || !(n >= 1)) return;
                post({ command: 'setSort', columnId: id, sortType: column.sortType, sortOrder: n, nulls: column.nulls || null });
                break;
            }
            case 'nulls':
                if (!column.sortType) return;
                post({ command: 'setSort', columnId: id, sortType: column.sortType, sortOrder: column.sortOrder, nulls: value || null });
                break;
            case 'criteria':
                post({ command: 'setCriteria', columnId: id, row: Number(el.dataset.row), text: value });
                break;
        }
    }

    gridBody.addEventListener('change', e => {
        if (e.target.dataset && e.target.dataset.field) commitGridField(e.target);
    });

    gridBody.addEventListener('keydown', e => {
        if (e.key === 'Enter' && e.target.dataset && e.target.dataset.field && e.target.tagName === 'INPUT') {
            e.preventDefault();
            commitGridField(e.target);
        }
    });

    gridBody.addEventListener('click', e => {
        const tr = e.target.closest('tr[data-column-id]');
        if (!tr) return;
        const id = tr.dataset.columnId;
        const action = e.target.closest('[data-grid-action]');
        if (action) {
            const index = Number(tr.dataset.index);
            if (action.dataset.gridAction === 'remove') post({ command: 'removeColumn', columnId: id });
            else if (action.dataset.gridAction === 'up') post({ command: 'moveColumn', columnId: id, toIndex: index - 1 });
            else if (action.dataset.gridAction === 'down') post({ command: 'moveColumn', columnId: id, toIndex: index + 1 });
            return;
        }
        if (e.target.closest('.qb-handle') || e.target.tagName === 'TD') select('column', id);
    });

    gridBody.addEventListener('focusin', e => {
        const tr = e.target.closest('tr[data-column-id]');
        if (tr) select('column', tr.dataset.columnId);
    });

    const COLUMN_MIME = 'application/x-qb-column';
    let draggedRow = null;
    gridBody.addEventListener('dragstart', e => {
        const handle = e.target.closest && e.target.closest('.qb-handle');
        if (!handle) return;
        const tr = handle.closest('tr');
        draggedRow = tr;
        e.dataTransfer.setData(COLUMN_MIME, tr.dataset.columnId);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setDragImage(tr, 10, 10);
    });
    const clearDragMarks = () => gridBody.querySelectorAll('.drag-before, .drag-after').forEach(r => r.classList.remove('drag-before', 'drag-after'));
    gridBody.addEventListener('dragover', e => {
        const tr = e.target.closest('tr[data-column-id]');
        if (!draggedRow || !tr) return;
        e.preventDefault();
        const r = tr.getBoundingClientRect();
        const before = e.clientY < r.top + r.height / 2;
        clearDragMarks();
        tr.classList.add(before ? 'drag-before' : 'drag-after');
    });
    gridBody.addEventListener('drop', e => {
        const tr = e.target.closest('tr[data-column-id]');
        if (!draggedRow || !tr) return;
        e.preventDefault();
        const r = tr.getBoundingClientRect();
        const before = e.clientY < r.top + r.height / 2;
        const from = Number(draggedRow.dataset.index);
        const to = reorderIndex(from, Number(tr.dataset.index), before);
        if (to !== from) post({ command: 'moveColumn', columnId: draggedRow.dataset.columnId, toIndex: to });
    });
    gridBody.addEventListener('dragend', () => {
        draggedRow = null;
        clearDragMarks();
    });

    function addExpression() {
        const value = newExpression.value.trim();
        if (!value) {
            newExpression.focus();
            return;
        }
        post({ command: 'addExpression', expression: value });
        newExpression.value = '';
    }

    newExpression.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addExpression();
        }
    });

    // The splitter shares the height between the diagram and the grid.
    $('gridSplitter').addEventListener('mousedown', e => {
        const section = $('tabDiagram');
        const startY = e.clientY;
        const startH = canvasWrap.offsetHeight;
        document.body.classList.add('qb-resizing');
        const move = ev => {
            const h = Math.max(80, Math.min(section.clientHeight - 80, startH + ev.clientY - startY));
            section.style.setProperty('--qb-canvas-h', h + 'px');
        };
        const up = () => {
            document.body.classList.remove('qb-resizing');
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        e.preventDefault();
    });

    // ----- Results ---------------------------------------------------------

    function run() {
        flushSql();
        showTab('results');
        resultStatus.classList.remove('error');
        resultStatus.textContent = 'Running…';
        post({ command: 'runPreview' });
    }

    function receivePreview(msg) {
        if (msg.error) {
            resultStatus.textContent = msg.error;
            resultStatus.classList.add('error');
            resultTable.innerHTML = '';
            return;
        }
        resultStatus.classList.remove('error');
        const count = msg.rows.length;
        resultStatus.textContent = msg.truncated
            ? `The first ${count} rows (${msg.durationMs} ms). Open the query in a Data Viewer to see all of them.`
            : `${count} row${count === 1 ? '' : 's'} (${msg.durationMs} ms).`;
        const head = '<thead><tr>' + msg.columns.map(c => `<th>${escapeHtml(c)}</th>`).join('') + '</tr></thead>';
        const body = '<tbody>' + msg.rows.map(row => '<tr>' + row.map(v => v === null
            ? '<td class="qb-null">NULL</td>'
            : `<td title="${escapeAttr(v.length > 2000 ? v.slice(0, 2000) + '…' : v)}">${escapeHtml(v)}</td>`).join('') + '</tr>').join('') + '</tbody>';
        resultTable.innerHTML = head + body;
    }

    // ----- Dialogs ---------------------------------------------------------

    function openDialog(id) {
        const dialog = $(id);
        dialog.classList.add('open');
        const first = dialog.querySelector('input[type=radio]:checked') || dialog.querySelector('input:not([type=radio]), textarea, select');
        if (first) first.focus();
    }

    function closeDialog() {
        const open = document.querySelector('.dlg-overlay.open');
        if (!open) return false;
        open.classList.remove('open');
        dialogState = null;
        return true;
    }

    document.querySelectorAll('.dlg-overlay').forEach(overlay => {
        overlay.addEventListener('click', e => {
            if (e.target === overlay || e.target.closest('[data-dlg-close]')) closeDialog();
        });
    });

    // Join
    function columnNames(tableId) {
        const table = tableById(tableId);
        return table ? boxColumns(table, columnsByTable[tableId], model).map(c => c.name) : [];
    }

    function renderJoinPairs() {
        const s = dialogState;
        const leftCols = columnNames(s.join.leftTableId);
        const rightCols = columnNames(s.join.rightTableId);
        const columnSelect = (cols, current, side, i) => `<select data-pair="${i}" data-side="${side}" aria-label="${side === 'leftColumn' ? 'Column of ' + escapeAttr(s.leftLabel) : 'Column of ' + escapeAttr(s.rightLabel)}">`
            + option('', '', current) + cols.map(c => option(c, c, current)).join('') + (current && !cols.includes(current) ? option(current, current, current) : '') + '</select>';
        const container = $('joinPairs');
        container.classList.toggle('qb-pairs-disabled', s.type === 'CROSS');
        container.innerHTML = s.pairs.length
            ? s.pairs.map((p, i) => `<div class="qb-pair"><span class="qb-pair-side">${escapeHtml(s.leftLabel)}</span>${columnSelect(leftCols, p.leftColumn, 'leftColumn', i)}`
                + `<input type="text" class="qb-op" data-pair="${i}" data-side="operator" value="${escapeAttr(p.operator || '=')}" aria-label="Operator" spellcheck="false">`
                + `<span class="qb-pair-side">${escapeHtml(s.rightLabel)}</span>${columnSelect(rightCols, p.rightColumn, 'rightColumn', i)}`
                + `<button class="btn btn-ghost btn-icon btn-sm" data-join-action="removePair" data-pair="${i}" title="Remove this pair">${icon('trash')}</button></div>`).join('')
            : '<p class="hint">No matching columns: the join has only the further condition below, or none.</p>';
    }

    function openJoinDialog(joinId) {
        const join = model.joins.find(j => j.id === joinId);
        if (!join) return;
        select('join', joinId);
        const leftTable = tableById(join.leftTableId);
        const rightTable = tableById(join.rightTableId);
        const leftLabel = tableLabel(leftTable);
        const rightLabel = tableLabel(rightTable);
        dialogState = { kind: 'join', join, leftLabel, rightLabel, type: join.type, pairs: join.pairs.map(p => Object.assign({}, p)) };
        const leftName = tableDescription(leftTable);
        const rightName = tableDescription(rightTable);
        $('joinDlgTitle').textContent = `Join ${leftName} and ${rightName}`;
        $('joinTypes').innerHTML = joinTypeChoices(leftName, rightName).map(c => `<label class="qb-join-type">`
            + `<input type="radio" name="joinType" value="${c.type}"${c.type === join.type ? ' checked' : ''}>`
            + `<span><span class="qb-join-type-label">${escapeHtml(c.label)}</span><br><span class="hint">${escapeHtml(c.description)}</span></span></label>`).join('');
        $('joinCondition').value = join.condition || '';
        renderJoinPairs();
        openDialog('joinDlg');
    }

    $('joinDlg').addEventListener('change', e => {
        const s = dialogState;
        if (!s || s.kind !== 'join') return;
        if (e.target.name === 'joinType') {
            s.type = e.target.value;
            renderJoinPairs();
        } else if (e.target.dataset.pair !== undefined && e.target.dataset.side) {
            s.pairs[Number(e.target.dataset.pair)][e.target.dataset.side] = e.target.value;
        }
    });

    $('joinDlg').addEventListener('click', e => {
        const action = e.target.closest('[data-join-action]');
        const s = dialogState;
        if (!action || !s || s.kind !== 'join') return;
        const kind = action.dataset.joinAction;
        if (kind === 'addPair') {
            s.pairs.push({ leftColumn: '', rightColumn: '', operator: '=' });
            renderJoinPairs();
        } else if (kind === 'removePair') {
            s.pairs.splice(Number(action.dataset.pair), 1);
            renderJoinPairs();
        } else if (kind === 'delete') {
            post({ command: 'removeJoin', joinId: s.join.id });
            closeDialog();
        } else if (kind === 'save') {
            const cross = s.type === 'CROSS';
            post({
                command: 'updateJoin',
                joinId: s.join.id,
                type: s.type,
                pairs: cross ? [] : s.pairs.filter(p => p.leftColumn && p.rightColumn),
                condition: cross ? '' : $('joinCondition').value
            });
            closeDialog();
        }
    });

    // Table: alias, and the SQL of a subquery or function
    function openTableDialog(table) {
        select('table', table.id);
        dialogState = { kind: 'table', table };
        const title = tableTitle(table);
        $('tableDlgTitle').textContent = table.kind === 'relation' ? title.name : table.kind === 'subquery' ? 'Subquery in FROM' : 'Function in FROM';
        $('tableAlias').value = table.alias || '';
        $('tableSqlField').hidden = table.kind === 'relation';
        $('tableSql').value = table.sql || '';
        openDialog('tableDlg');
    }

    $('tableDlg').addEventListener('click', e => {
        const s = dialogState;
        if (!e.target.closest('[data-table-action="save"]') || !s || s.kind !== 'table') return;
        const msg = { command: 'editTable', tableId: s.table.id, alias: $('tableAlias').value };
        if (s.table.kind !== 'relation') msg.sql = $('tableSql').value;
        post(msg);
        closeDialog();
    });

    $('tableAlias').addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            document.querySelector('[data-table-action="save"]').click();
        }
    });

    // WITH queries and raw conditions
    function renderRaw() {
        const s = dialogState;
        $('rawCtes').innerHTML = s.ctes.map((c, i) => `<div class="qb-raw-row">`
            + `<input type="text" class="qb-raw-name mono" data-raw="ctes" data-i="${i}" data-key="name" value="${escapeAttr(c.name)}" placeholder="name" aria-label="Name of the WITH query" spellcheck="false">`
            + `<textarea rows="4" data-raw="ctes" data-i="${i}" data-key="sql" aria-label="SQL of the WITH query" spellcheck="false">${escapeHtml(c.sql)}</textarea>`
            + `<button class="btn btn-ghost btn-icon btn-sm" data-raw-action="remove" data-raw-kind="ctes" data-i="${i}" title="Remove the WITH query">${icon('trash')}</button></div>`).join('')
            || '<p class="hint">None.</p>';
        const conditions = (kind, list) => list.map((c, i) => `<div class="qb-raw-row">`
            + `<textarea rows="2" data-raw="${kind}" data-i="${i}" aria-label="Condition" spellcheck="false">${escapeHtml(c)}</textarea>`
            + `<button class="btn btn-ghost btn-icon btn-sm" data-raw-action="remove" data-raw-kind="${kind}" data-i="${i}" title="Remove the condition">${icon('trash')}</button></div>`).join('')
            || '<p class="hint">None.</p>';
        $('rawWhere').innerHTML = conditions('where', s.where);
        $('rawHaving').innerHTML = conditions('having', s.having);
    }

    function openRawDialog() {
        dialogState = {
            kind: 'raw',
            ctes: (model.ctes || []).map((c, index) => ({ name: c.name, sql: c.sql, index })),
            where: (model.whereExtra || []).slice(),
            having: (model.havingExtra || []).slice()
        };
        renderRaw();
        openDialog('rawDlg');
    }

    $('rawDlg').addEventListener('input', e => {
        const s = dialogState;
        const el = e.target;
        if (!s || s.kind !== 'raw' || !el.dataset.raw) return;
        const i = Number(el.dataset.i);
        if (el.dataset.raw === 'ctes') s.ctes[i][el.dataset.key] = el.value;
        else s[el.dataset.raw][i] = el.value;
    });

    $('rawDlg').addEventListener('click', e => {
        const action = e.target.closest('[data-raw-action]');
        const s = dialogState;
        if (!action || !s || s.kind !== 'raw') return;
        const kind = action.dataset.rawKind;
        if (action.dataset.rawAction === 'add') {
            if (kind === 'ctes') s.ctes.push({ name: '', sql: '' });
            else s[kind].push('');
            renderRaw();
        } else if (action.dataset.rawAction === 'remove') {
            s[kind].splice(Number(action.dataset.i), 1);
            renderRaw();
        } else if (action.dataset.rawAction === 'save') {
            post({ command: 'setRawParts', ctes: s.ctes, whereExtra: s.where, havingExtra: s.having });
            closeDialog();
        }
    });

    // ----- Toolbar and keyboard ----------------------------------------------

    function autoLayoutNow() {
        if (!model.tables.length) return;
        const positions = autoLayout(model.tables, model.joins, measuredSizes());
        post({ command: 'placeTables', positions: Object.keys(positions).map(id => ({ tableId: id, x: positions[id].x, y: positions[id].y })) });
    }

    const ACTIONS = {
        undo: () => post({ command: 'undo' }),
        redo: () => post({ command: 'redo' }),
        layout: autoLayoutNow,
        rawParts: openRawDialog,
        copySql: () => { flushSql(); post({ command: 'copySql' }); },
        openInDataViewer: () => { flushSql(); post({ command: 'openInDataViewer' }); },
        run,
        apply: () => { flushSql(); post({ command: 'apply' }); },
        addDraggedTables: () => post({ command: 'requestDroppedTables' }),
        addExpression,
        dismissWarnings: () => {
            dismissedWarnings = (model.warnings || []).join(' ');
            renderWarnings();
        }
    };

    document.addEventListener('click', e => {
        const tab = e.target.closest('[data-tab]');
        if (tab) {
            showTab(tab.dataset.tab);
            return;
        }
        const action = e.target.closest('[data-action]');
        if (action && !action.disabled && ACTIONS[action.dataset.action]) ACTIONS[action.dataset.action]();
    });

    distinctToggle.addEventListener('change', () => post({ command: 'setDistinct', distinct: distinctToggle.checked }));

    function deleteSelection() {
        if (!selection) return;
        if (selection.kind === 'table') post({ command: 'removeTable', tableId: selection.id });
        else if (selection.kind === 'join') post({ command: 'removeJoin', joinId: selection.id });
        else post({ command: 'removeColumn', columnId: selection.id });
        selection = null;
    }

    document.addEventListener('keydown', e => {
        // The SQL editor handles its own keys (Ctrl+Enter, Ctrl+Z, Ctrl+Y).
        if (e.target.closest && e.target.closest('.monaco-editor')) return;
        if (e.key === 'Escape') {
            if (closeDialog()) e.preventDefault();
            return;
        }
        if (document.querySelector('.dlg-overlay.open')) return;
        const ctrl = e.ctrlKey || e.metaKey;
        if (ctrl && e.key === 'Enter') {
            e.preventDefault();
            run();
            return;
        }
        if (isTypingTarget(e.target)) return;
        const key = e.key.toLowerCase();
        if (ctrl && key === 'z' && !e.shiftKey) {
            e.preventDefault();
            post({ command: 'undo' });
        } else if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) {
            e.preventDefault();
            post({ command: 'redo' });
        } else if (e.key === 'Delete' && selection) {
            e.preventDefault();
            deleteSelection();
        }
    });

    // ----- Messages from the host --------------------------------------------

    window.addEventListener('message', event => {
        const msg = event.data || {};
        switch (msg.command) {
            case 'state':
                receiveState(msg);
                break;
            case 'sqlStatus':
                if (sqlText.status(msg)) showTab('sql');
                break;
            case 'previewResult':
                receivePreview(msg);
                break;
            case 'notice':
                showNotice(msg.text, msg.kind);
                break;
        }
    });

    window.addEventListener('resize', drawJoins);
    post({ command: 'ready' });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        QB_BOX,
        QB_JOIN_TYPES,
        tableLabel,
        tableDescription,
        tableTitle,
        boxColumns,
        estimateBoxSize,
        autoLayout,
        placeMissing,
        rectsOverlap,
        rowAnchorY,
        joinLineGeometry,
        joinLineClass,
        preservedEnds,
        joinTypeChoices,
        criteriaColumnCount,
        criteriaHeader,
        buildGridRows,
        reorderIndex,
        sqlErrorText,
        isTypingTarget,
        createSqlText,
        escapeHtml
    };
}
