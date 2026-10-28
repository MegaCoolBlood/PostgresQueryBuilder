const DEFAULT_THOUSAND_SEPARATOR = ' ';

// Markup for one icon of the sprite inlined at the top of the document.
// The icon inherits the surrounding text colour, so it needs no theme handling.
function icon(name) {
    return `<svg class="ico" aria-hidden="true"><use href="#icon-${name}"/></svg>`;
}

// Convert a raw cell value to its canonical string representation.
// JSON/JSONB columns are parsed by the pg driver into JS objects/arrays;
// String() would render them as "[object Object]", so stringify them as JSON.
function cellToString(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
}

function escapeSqlString(value) {
    return String(value).replace(/'/g, "''");
}

// NOTE: Keep in sync with maskSql in src/selectStatementExtractor.ts.
// Replaces comments and string literals by spaces while preserving offsets so
// the placeholder scanner never matches a `:name` inside a literal or comment.
function maskSqlForPlaceholders(text) {
    const out = String(text).split('');
    const n = out.length;
    const src = String(text);
    let i = 0;
    const blank = (from, to) => {
        for (let k = from; k < to && k < n; k++) {
            if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
        }
    };
    while (i < n) {
        const c = src[i], c2 = src[i + 1];
        if (c === '-' && c2 === '-') {
            let j = i + 2;
            while (j < n && src[j] !== '\n') j++;
            blank(i, j); i = j; continue;
        }
        if (c === '/' && c2 === '*') {
            let j = i + 2, depth = 1;
            while (j < n && depth > 0) {
                if (src[j] === '/' && src[j + 1] === '*') { depth++; j += 2; }
                else if (src[j] === '*' && src[j + 1] === '/') { depth--; j += 2; }
                else j++;
            }
            blank(i, j); i = j; continue;
        }
        if (c === "'") {
            let j = i + 1;
            while (j < n) {
                if (src[j] === "'") {
                    if (src[j + 1] === "'") { j += 2; continue; }
                    j++; break;
                }
                j++;
            }
            blank(i, j); i = j; continue;
        }
        if (c === '$') {
            const tagMatch = /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/.exec(src.slice(i));
            if (tagMatch) {
                const tag = tagMatch[0];
                const end = src.indexOf(tag, i + tag.length);
                const j = end === -1 ? n : end + tag.length;
                blank(i, j); i = j; continue;
            }
        }
        if (c === '"') {
            let j = i + 1;
            while (j < n) {
                if (src[j] === '"') {
                    if (src[j + 1] === '"') { j += 2; continue; }
                    j++; break;
                }
                j++;
            }
            i = j; continue;
        }
        i++;
    }
    return out.join('');
}

// NOTE: Keep in sync with parseQueryPlaceholders in src/savedQueryStore.ts.
function parseQueryPlaceholders(sql) {
    if (typeof sql !== 'string' || !sql) return [];
    const masked = maskSqlForPlaceholders(sql);
    const result = [];
    const re = /:([A-Za-z_][A-Za-z0-9_]*)/g;
    let m;
    while ((m = re.exec(masked)) !== null) {
        if (m.index > 0 && masked[m.index - 1] === ':') continue;
        result.push({ name: m[1], start: m.index, end: m.index + m[0].length });
    }
    return result;
}

// NOTE: Keep in sync with placeholderNames in src/savedQueryStore.ts.
function placeholderNames(sql) {
    const seen = new Set();
    const names = [];
    for (const occ of parseQueryPlaceholders(sql)) {
        const key = occ.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(occ.name);
    }
    return names;
}

// NOTE: Keep in sync with renderParameterValue in src/savedQueryStore.ts.
function renderParameterValue(value, kind) {
    const text = value === null || value === undefined ? '' : String(value);
    if (kind === 'number') {
        if (!/^-?\d+(\.\d+)?$/.test(text.trim())) {
            throw new Error('"' + text + '" is not a valid number.');
        }
        return text.trim();
    }
    if (kind === 'identifier') return '"' + text.replace(/"/g, '""') + '"';
    if (kind === 'raw') return text;
    return "'" + escapeSqlString(text) + "'";
}

// NOTE: Keep in sync with applyQueryParameters in src/savedQueryStore.ts.
// Occurrences are spliced in from right to left so a value that itself contains
// `:name` is never substituted again.
function applyQueryParameters(sql, values, parameters) {
    const occurrences = parseQueryPlaceholders(sql);
    if (occurrences.length === 0) return sql;
    const byName = new Map();
    for (const p of Array.isArray(parameters) ? parameters : []) {
        if (p && typeof p.name === 'string') byName.set(p.name.toLowerCase(), p);
    }
    const lookup = new Map();
    for (const key of Object.keys(values || {})) {
        const v = values[key];
        if (v !== undefined && v !== null) lookup.set(key.toLowerCase(), String(v));
    }
    let result = sql;
    for (let i = occurrences.length - 1; i >= 0; i--) {
        const occ = occurrences[i];
        const key = occ.name.toLowerCase();
        const param = byName.get(key) || { name: occ.name, kind: 'text' };
        let value = lookup.get(key);
        if (value === undefined || value === '') value = param.defaultValue;
        if (value === undefined || value === '') {
            throw new Error('No value supplied for :' + occ.name + '.');
        }
        result = result.slice(0, occ.start)
            + renderParameterValue(value, param.kind || 'text')
            + result.slice(occ.end);
    }
    return result;
}

function normalizeNumericInput(value, thousandSeparator = DEFAULT_THOUSAND_SEPARATOR) {
    if (value === null || value === undefined) return value;
    const str = String(value).trim();
    if (str === '') return str;
    let cleaned = str;
    if (thousandSeparator) {
        cleaned = cleaned.split(thousandSeparator).join('');
    }
    cleaned = cleaned.replace(/,/g, '.');
    if (!isNaN(Number(cleaned))) {
        return cleaned;
    }
    return str;
}

// The configured thousand separator, or '' when it would collide with the
// decimal comma, a digit or a sign: with "," the value 0.5 is shown as "0,5"
// and would read back as "05".
function sanitizeThousandSeparator(sep) {
    if (typeof sep !== 'string') return DEFAULT_THOUSAND_SEPARATOR;
    return /[\d,+\-]/.test(sep) ? '' : sep;
}

// The SQL literal for a numeric filter value, or null when the text is not a
// number. The digits are kept as typed, so a bigint above 2^53 is not rounded
// as it would be by Number().
function toNumericLiteral(text) {
    if (text === null || text === undefined) return null;
    const s = String(text).trim();
    return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s) ? s : null;
}

// Split a modified-cell key "<rowIdx>:<column>" at the first colon only, so a
// column name that itself contains ":" survives.
function parseCellKey(key) {
    const s = String(key);
    const i = s.indexOf(':');
    return { rowIdx: parseInt(i < 0 ? s : s.slice(0, i), 10), colName: i < 0 ? '' : s.slice(i + 1) };
}

// Plain-text summary of a custom mapping's conditions, e.g. "status = 'open'".
// The caller escapes it: the conditions come from a workspace file.
function formatMappingConditions(conditions) {
    if (!Array.isArray(conditions)) return '';
    return conditions
        .filter(c => c && typeof c === 'object')
        .map(c => `${String(c.column ?? '')} ${String(c.operator ?? '')} '${String(c.value ?? '')}'`)
        .join(', ');
}

/**
 * Remove thousand separators from a displayed numeric string for copying,
 * while preserving the decimal separator exactly as shown (e.g. the German
 * decimal comma). "9 999 999,99" -> "9999999,99". Non-numeric text or an empty
 * separator is returned unchanged.
 */
function stripThousandSeparators(value, thousandSeparator = DEFAULT_THOUSAND_SEPARATOR) {
    if (value === null || value === undefined) return value;
    if (!thousandSeparator) return String(value);
    return String(value).split(thousandSeparator).join('');
}

/**
 * Join a rectangular block of already-stringified cell values into
 * clipboard text: columns separated by a TAB, rows separated by CRLF, so it
 * pastes into Excel (and other spreadsheets) as a proper cell grid.
 */
function cellRangeToTsv(rows) {
    if (!Array.isArray(rows)) return '';
    return rows
        .map(row => (Array.isArray(row) ? row.join('\t') : ''))
        .join('\r\n');
}

/**
 * Render a rectangular block of cell values as an HTML `<table>` so pasting into
 * a rich-text target (Teams, Word, Outlook) keeps the row/column structure.
 * Every value is HTML-escaped.
 */
function cellRangeToHtml(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return '';
    const esc = (s) => String(s === null || s === undefined ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const body = rows
        .map(row => {
            const cells = (Array.isArray(row) ? row : [])
                .map(c => `<td>${esc(c)}</td>`).join('');
            return `<tr>${cells}</tr>`;
        })
        .join('');
    return `<table border="1" style="border-collapse:collapse">${body}</table>`;
}

/**
 * Parse clipboard text copied from Excel (or another spreadsheet) into a matrix
 * of cell strings: TAB separates columns, a newline separates rows. A field is
 * quoted with double quotes when it contains a tab, a newline or a quote, and an
 * embedded quote is doubled — the same convention Excel writes. A single
 * trailing empty row (Excel appends a newline) is dropped.
 */
function parseClipboardTable(text) {
    const s = String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;
    while (i < s.length) {
        const ch = s[i];
        if (inQuotes) {
            if (ch === '"') {
                if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
                inQuotes = false; i++; continue;
            }
            field += ch; i++; continue;
        }
        // A quote only opens a quoted field at the start of the field, so a lone
        // quote inside plain text (e.g. 5" pipe) stays literal.
        if (ch === '"' && field === '') { inQuotes = true; i++; continue; }
        if (ch === '\t') { row.push(field); field = ''; i++; continue; }
        if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
        field += ch; i++;
    }
    row.push(field);
    rows.push(row);
    if (rows.length > 1) {
        const last = rows[rows.length - 1];
        if (last.length === 1 && last[0] === '') { rows.pop(); }
    }
    return rows;
}

/**
 * Work out where a clipboard matrix lands when pasted at display position
 * `startPos`, column `startCol`, in Excel style. `rowOrder` lists the allRows
 * indices in the order the grid shows them (after client-side sort and filter),
 * so consecutive pasted rows land on the rows shown below each other; a plain
 * row count means unsorted, unfiltered rows. Rows that fall on displayed rows
 * become cell overwrites, rows past the last displayed row become new rows.
 * Columns are mapped left to right from `startCol`; a value whose target column
 * is missing or not editable is skipped. Returns `{ cellUpdates, newRows }`
 * where every `cellUpdate` is `{ rowIdx, colName, value }` (rowIdx into
 * allRows) and every `newRow` a partial `{ colName: value }` map.
 */
function planClipboardPaste(matrix, startPos, startCol, rowOrder, columnNames, isColumnEditable) {
    const editable = typeof isColumnEditable === 'function' ? isColumnEditable : () => true;
    const cols = Array.isArray(columnNames) ? columnNames : [];
    const order = Array.isArray(rowOrder)
        ? rowOrder
        : Array.from({ length: Math.max(0, Number(rowOrder) || 0) }, (_, i) => i);
    const cellUpdates = [];
    const newRows = [];
    (Array.isArray(matrix) ? matrix : []).forEach((rowValues, i) => {
        const pos = startPos + i;
        const values = Array.isArray(rowValues) ? rowValues : [];
        if (pos >= 0 && pos < order.length) {
            const targetRowIdx = order[pos];
            values.forEach((value, j) => {
                const colIdx = startCol + j;
                if (colIdx < 0 || colIdx >= cols.length) { return; }
                const colName = cols[colIdx];
                if (!editable(colName)) { return; }
                cellUpdates.push({ rowIdx: targetRowIdx, colName, value });
            });
        } else {
            const rowObj = {};
            let filled = false;
            values.forEach((value, j) => {
                const colIdx = startCol + j;
                if (colIdx < 0 || colIdx >= cols.length) { return; }
                const colName = cols[colIdx];
                if (!editable(colName)) { return; }
                rowObj[colName] = value;
                filled = true;
            });
            if (filled) { newRows.push(rowObj); }
        }
    });
    return { cellUpdates, newRows };
}

// The lone value of a clipboard matrix that holds exactly one cell, else null.
// Used to fill a whole selected range with a single copied value (Excel style).
function singleClipboardValue(matrix) {
    if (!Array.isArray(matrix) || matrix.length !== 1) { return null; }
    const row = matrix[0];
    if (!Array.isArray(row) || row.length !== 1) { return null; }
    return row[0];
}

// Whether a single copied value should be written into the selected cell(s):
// there must be a cell selection (one cell or a block) and the grid must accept
// edits or inserts. Without a selection the paste is left to the browser (an
// in-cell paste while editing).
function shouldFillLoneValue(hasSelection, canEdit, canInsert) {
    return !!hasSelection && (!!canEdit || !!canInsert);
}

// What releasing the mouse in a cell means: 'range' after a drag across cells,
// 'text' when text was selected inside one cell (keep the native selection),
// otherwise 'select' — a plain click that marks the single cell.
function resolveMouseRelease(dragged, hasTextSelection) {
    if (dragged) { return 'range'; }
    if (hasTextSelection) { return 'text'; }
    return 'select';
}

// True when the selection is a single cell, which is when the Excel-style fill
// handle is offered at its bottom-right corner.
function isSingleCellSelection(anchor, focus) {
    return !!anchor && !!focus && anchor.r === focus.r && anchor.c === focus.c;
}

// ===== Excel-like series fill ===============================================
// Dragging the fill handle of a multi-cell selection continues the selected
// values as a series: the steps between them are repeated in turn (1, 3, 2 →
// +2, -1 → 4, 3, 5, 4 …). Numbers, dates, timestamps and times form series;
// anything else — or a run containing NULL or unreadable text — is repeated.

// The series family of a column type: 'number', 'date', 'timestamp', 'time',
// or '' when the column's values are repeated instead of continued.
function seriesKindForType(dataType) {
    const parsed = parsePgType(dataType);
    if (parsed.isArray) return '';
    const base = parsed.base;
    if (/^(smallint|integer|bigint|int|int2|int4|int8|numeric|decimal|real|double precision|float4|float8)$/.test(base)) return 'number';
    if (base === 'date') return 'date';
    if (base.indexOf('timestamp') === 0) return 'timestamp';
    if (base === 'time' || base === 'timetz' || base.indexOf('time ') === 0) return 'time';
    return '';
}

// Whether a column holds plain numbers that sort by value (integers, numeric,
// floats). Arrays, ranges, money, interval and geometric types do not, even
// though their type names contain "int".
function isNumericScalarType(dataType) {
    return seriesKindForType(dataType) === 'number';
}

// The value a duplicated row starts with. The driver parses json/jsonb, so a
// JSON string "123" arrives as the JS string 123 and would be saved as the
// number 123; the copy therefore holds the JSON text of the value. An edited
// cell already holds the JSON text the user typed.
function duplicateCellValue(value, dataType, edited) {
    if (edited || value === null || value === undefined) return value;
    const t = String(dataType || '').trim().toLowerCase();
    if (t !== 'json' && t !== 'jsonb') return value;
    try {
        return JSON.stringify(value);
    } catch {
        return value;
    }
}

// A plain decimal ('-12', '1.50', '.5') as a scaled BigInt, or null.
function parseSeriesNumber(text) {
    const m = /^\s*([+-]?)(\d*)(?:\.(\d*))?\s*$/.exec(String(text));
    if (!m || (m[2] === '' && !m[3])) return null;
    const frac = m[3] || '';
    const v = BigInt((m[2] || '0') + frac);
    return { v: m[1] === '-' ? -v : v, scale: frac.length };
}

function formatSeriesNumber(v, scale) {
    const neg = v < 0n;
    let s = (neg ? -v : v).toString();
    if (scale > 0) {
        s = s.padStart(scale + 1, '0');
        s = s.slice(0, -scale) + '.' + s.slice(-scale);
    }
    return (neg ? '-' : '') + s;
}

const SERIES_DAY_MICROS = 86400000000n;

// Days since 1970-01-01 for a proleptic Gregorian date, or null when invalid.
function seriesDaysFromCivil(y, mo, d) {
    const dt = new Date(Date.UTC(2000, mo - 1, d));
    dt.setUTCFullYear(y);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return Math.round(dt.getTime() / 86400000);
}

function seriesCivilFromDays(days) {
    const dt = new Date(days * 86400000);
    return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function seriesDaysInMonth(y, mo) {
    const dt = new Date(Date.UTC(2000, mo, 0));
    dt.setUTCFullYear(y, mo, 0);
    return dt.getUTCDate();
}

// Parse a date, timestamp or time value into its parts and a microsecond
// position on one axis (days * 24h + time of day). Null when unreadable.
function parseSeriesDateTime(text, kind) {
    const s = String(text).trim();
    let m, y = 1970, mo = 1, d = 1, hasDate = false, sep = '', timeParts = null;
    if (kind === 'time') {
        m = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(s);
        if (!m) return null;
        timeParts = [m[1], m[2], m[3], m[4], m[5]];
    } else {
        m = /^(\d{4})-(\d{2})-(\d{2})(?:([T ])(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/.exec(s);
        if (!m) return null;
        y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]);
        hasDate = true;
        if (m[4]) {
            sep = m[4];
            timeParts = [m[5], m[6], m[7], m[8], m[9]];
        }
    }
    const days = seriesDaysFromCivil(y, mo, d);
    if (days === null) return null;
    let tod = 0n, hasTime = false, hasSeconds = false, fracDigits = 0, zone = '';
    if (timeParts) {
        const [hh, mi, ss, frac, z] = timeParts;
        if (Number(hh) > 23 || Number(mi) > 59 || (ss !== undefined && Number(ss) > 59)) return null;
        hasTime = true;
        hasSeconds = ss !== undefined;
        fracDigits = frac ? frac.length : 0;
        zone = z || '';
        const micros = frac ? BigInt(frac.padEnd(6, '0')) : 0n;
        tod = ((BigInt(hh) * 60n + BigInt(mi)) * 60n + BigInt(ss || '0')) * 1000000n + micros;
    }
    return { y, mo, d, days, tod, hasDate, hasTime, sep, hasSeconds, fracDigits, zone,
        pos: BigInt(days) * SERIES_DAY_MICROS + tod };
}

function formatSeriesDateTime(pos, shape) {
    const pad = (n, w) => String(n).padStart(w, '0');
    let days = pos / SERIES_DAY_MICROS;
    let tod = pos % SERIES_DAY_MICROS;
    if (tod < 0n) { tod += SERIES_DAY_MICROS; days -= 1n; }
    let out = '';
    if (shape.hasDate) {
        const c = seriesCivilFromDays(Number(days));
        out = `${pad(c.y, 4)}-${pad(c.mo, 2)}-${pad(c.d, 2)}`;
    }
    if (shape.hasTime) {
        const totalSeconds = tod / 1000000n;
        const hh = totalSeconds / 3600n, mi = (totalSeconds / 60n) % 60n, ss = totalSeconds % 60n;
        let t = `${pad(hh, 2)}:${pad(mi, 2)}`;
        if (shape.hasSeconds || shape.fracDigits > 0) t += `:${pad(ss, 2)}`;
        if (shape.fracDigits > 0) t += '.' + pad(tod % 1000000n, 6).slice(0, shape.fracDigits);
        out += (shape.hasDate ? shape.sep : '') + t + shape.zone;
    }
    return out;
}

// Continue numeric values; null when one of them is not a plain number.
function continueNumberSeries(values, count) {
    const parsed = values.map(parseSeriesNumber);
    if (parsed.some(p => p === null)) return null;
    const scale = Math.max(...parsed.map(p => p.scale));
    const nums = parsed.map(p => p.v * 10n ** BigInt(scale - p.scale));
    const steps = nums.slice(1).map((v, i) => v - nums[i]);
    const out = [];
    let cur = nums[nums.length - 1];
    for (let i = 0; i < count; i++) {
        cur += steps[i % steps.length];
        out.push(formatSeriesNumber(cur, scale));
    }
    return out;
}

// Continue date/time values; null when one of them cannot be read. Dates and
// timestamps on the same day of the month (or all on the last day of their
// month) at the same time step by whole months, so 31 Jan, 29 Feb continues
// with 31 Mar; everything else steps by the exact distance between the values.
function continueDateTimeSeries(values, kind, count) {
    const parsed = values.map(v => parseSeriesDateTime(v, kind));
    if (parsed.some(p => p === null)) return null;
    const zone = parsed[0].zone;
    if (parsed.some(p => p.zone !== zone || p.hasTime !== parsed[0].hasTime)) return null;
    const last = parsed[parsed.length - 1];
    const shape = {
        hasDate: last.hasDate,
        hasTime: last.hasTime,
        sep: last.sep,
        zone,
        hasSeconds: parsed.some(p => p.hasSeconds),
        fracDigits: Math.max(...parsed.map(p => p.fracDigits))
    };
    const out = [];
    const sameTime = parsed.every(p => p.tod === parsed[0].tod);
    const sameDay = parsed.every(p => p.d === parsed[0].d);
    const monthEnds = parsed.every(p => p.d === seriesDaysInMonth(p.y, p.mo));
    if (kind !== 'time' && sameTime && (sameDay || monthEnds)) {
        const months = parsed.map(p => p.y * 12 + (p.mo - 1));
        const steps = months.slice(1).map((v, i) => v - months[i]);
        let cur = months[months.length - 1];
        for (let i = 0; i < count; i++) {
            cur += steps[i % steps.length];
            const y = Math.floor(cur / 12), mo = cur - y * 12 + 1;
            const dim = seriesDaysInMonth(y, mo);
            const d = monthEnds && !sameDay ? dim : Math.min(parsed[0].d, dim);
            const days = seriesDaysFromCivil(y, mo, d);
            if (days === null) return null;
            out.push(formatSeriesDateTime(BigInt(days) * SERIES_DAY_MICROS + parsed[0].tod, shape));
        }
        return out;
    }
    const positions = parsed.map(p => p.pos);
    const steps = positions.slice(1).map((v, i) => v - positions[i]);
    let cur = positions[positions.length - 1];
    for (let i = 0; i < count; i++) {
        cur += steps[i % steps.length];
        // A time of day wraps around midnight.
        const pos = kind === 'time' ? ((cur % SERIES_DAY_MICROS) + SERIES_DAY_MICROS) % SERIES_DAY_MICROS : cur;
        out.push(formatSeriesDateTime(pos, shape));
    }
    return out;
}

// The `count` values that follow `values` (ordered away from the source), as
// the fill handle writes them. A series needs at least two values of a series
// kind; otherwise the values are repeated in order (A, B → A, B, A …).
function continueSeries(values, kind, count) {
    const n = values.length;
    if (!(count > 0) || n === 0) return [];
    let out = null;
    if (n >= 2 && kind === 'number') out = continueNumberSeries(values, count);
    else if (n >= 2 && (kind === 'date' || kind === 'timestamp' || kind === 'time')) out = continueDateTimeSeries(values, kind, count);
    if (out) return out;
    const repeated = [];
    for (let i = 0; i < count; i++) repeated.push(values[i % n]);
    return repeated;
}

// Where a fill drag from the `source` block ({minR, maxR, minC, maxC}) extends
// to with the pointer over cell {r, c}: one direction only, the one the pointer
// has moved furthest out of the block in (ties go vertical, like Excel).
// Returns { direction: 'down'|'up'|'right'|'left', target } — target being the
// new cells only — or null while the pointer is still inside the block.
function planFillExtension(source, pointer) {
    if (!source || !pointer) return null;
    const down = pointer.r - source.maxR, up = source.minR - pointer.r;
    const right = pointer.c - source.maxC, left = source.minC - pointer.c;
    const vertical = Math.max(down, up), horizontal = Math.max(right, left);
    if (vertical <= 0 && horizontal <= 0) return null;
    if (vertical >= horizontal) {
        return down > 0
            ? { direction: 'down', target: { minR: source.maxR + 1, maxR: pointer.r, minC: source.minC, maxC: source.maxC } }
            : { direction: 'up', target: { minR: pointer.r, maxR: source.minR - 1, minC: source.minC, maxC: source.maxC } };
    }
    return right > 0
        ? { direction: 'right', target: { minR: source.minR, maxR: source.maxR, minC: source.maxC + 1, maxC: pointer.c } }
        : { direction: 'left', target: { minR: source.minR, maxR: source.maxR, minC: pointer.c, maxC: source.minC - 1 } };
}

// Every cell a fill from the `source` block along `plan` writes, as
// [{ r, c, value }]: each column (vertical fill) or row (horizontal fill) of the
// block is continued as a series where its type allows and repeated otherwise.
// `valueAt(r, c)` reads a source value, `kindOfColumn(c)` gives the column's
// series kind; a row continues only when all its source columns share a kind.
// Both the drag preview and the fill itself use this, so they always agree.
function planSeriesWrites(source, plan, valueAt, kindOfColumn) {
    if (!source || !plan) return [];
    const t = plan.target;
    const vertical = plan.direction === 'down' || plan.direction === 'up';
    const forward = plan.direction === 'down' || plan.direction === 'right';
    const count = vertical ? t.maxR - t.minR + 1 : t.maxC - t.minC + 1;
    const writes = [];
    const laneFrom = vertical ? source.minC : source.minR;
    const laneTo = vertical ? source.maxC : source.maxR;
    for (let lane = laneFrom; lane <= laneTo; lane++) {
        const values = [];
        let kind;
        if (vertical) {
            for (let r = source.minR; r <= source.maxR; r++) values.push(valueAt(r, lane));
            kind = kindOfColumn(lane);
        } else {
            const kinds = new Set();
            for (let c = source.minC; c <= source.maxC; c++) {
                values.push(valueAt(lane, c));
                kinds.add(kindOfColumn(c));
            }
            kind = kinds.size === 1 ? [...kinds][0] : '';
        }
        continueSeries(forward ? values : values.slice().reverse(), kind, count).forEach((value, i) => {
            writes.push(vertical
                ? { r: forward ? t.minR + i : t.maxR - i, c: lane, value }
                : { r: lane, c: forward ? t.minC + i : t.maxC - i, value });
        });
    }
    return writes;
}

// The text a cell shows while a fill drag previews the value it would receive:
// an empty value becomes NULL, a number is displayed the way the grid shows it.
function fillPreviewText(value, isNumeric, thousandSeparator) {
    const text = value === null || value === undefined ? '' : String(value);
    if (text === '') return 'NULL';
    return isNumeric ? formatNumberDisplay(text, thousandSeparator) : text;
}

// The corners of a selection made over whole lines: kind 'rows' (clicking or
// dragging over row numbers) spans every column of rows from..to, kind 'cols'
// (the select strip on top of a column header) spans every row of columns
// from..to. Indexes are clamped to the grid; null when there is nothing to select.
function lineSelectionCorners(kind, from, to, rowCount, colCount) {
    if (!(rowCount > 0) || !(colCount > 0)) { return null; }
    const clamp = (v, max) => Math.max(0, Math.min(max, Number.isInteger(v) ? v : 0));
    if (kind === 'rows') {
        return {
            anchor: { r: clamp(from, rowCount - 1), c: 0 },
            focus: { r: clamp(to, rowCount - 1), c: colCount - 1 }
        };
    }
    if (kind === 'cols') {
        return {
            anchor: { r: 0, c: clamp(from, colCount - 1) },
            focus: { r: rowCount - 1, c: clamp(to, colCount - 1) }
        };
    }
    return null;
}

// Which row numbers and column headers to mark for a selection rectangle
// ({minR, maxR, minC, maxC}): rows whose every column is selected, and columns
// whose every row is selected. Each part is {min, max} or null.
function fullySelectedLines(bounds, rowCount, colCount) {
    const result = { rows: null, cols: null };
    if (!bounds || !(rowCount > 0) || !(colCount > 0)) { return result; }
    if (bounds.minC <= 0 && bounds.maxC >= colCount - 1) {
        result.rows = { min: Math.max(0, bounds.minR), max: Math.min(rowCount - 1, bounds.maxR) };
    }
    if (bounds.minR <= 0 && bounds.maxR >= rowCount - 1) {
        result.cols = { min: Math.max(0, bounds.minC), max: Math.min(colCount - 1, bounds.maxC) };
    }
    return result;
}

// True for a keystroke that types a character (not a shortcut or a control key),
// which over a multi-cell selection starts a multi-edit.
function isPrintableTypingKey(e) {
    return !!e && typeof e.key === 'string' && e.key.length === 1
        && !e.ctrlKey && !e.metaKey && !e.altKey;
}

// Whether a printable keystroke should start editing the selected cell(s): there
// must be a cell selection (single or multi), it must be a character key, and
// the focus must not already be inside an editing element. Typing then
// overwrites the cell with the typed character.
function typingStartsCellEdit(hasSelection, isPrintable, isEditing) {
    return !!hasSelection && !!isPrintable && !isEditing;
}

// True when the element sits inside the query bar's code editor (Monaco),
// including its suggest and find widgets. The editor owns typing and its
// clipboard keys there, whatever element it uses to take input — a hidden
// textarea or a plain <div> driven by the browser's EditContext API.
function isInCodeEditor(el) {
    return !!(el && typeof el.closest === 'function' && el.closest('.monaco-editor, .query-editor'));
}

// True for an element that takes typed text: a form field, a cell being
// edited, or the query bar's code editor. Keys pressed there keep their
// meaning instead of acting on the grid's cell selection.
function isTextEntryElement(el) {
    if (!el) { return false; }
    if (el.isContentEditable) { return true; }
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { return true; }
    return isInCodeEditor(el);
}

// True when a focused text <input>/<textarea> holds a non-empty selection. Such
// a selection is invisible to window.getSelection(), so the grid must check it
// explicitly before claiming a Ctrl+C for its cell range (e.g. text highlighted
// in the SQL query box must copy, not the selected grid cell).
function hasTextInputSelection(el) {
    if (!el) { return false; }
    const tag = el.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') { return false; }
    if (typeof el.selectionStart !== 'number' || typeof el.selectionEnd !== 'number') {
        return false;
    }
    return el.selectionStart !== el.selectionEnd;
}

// Decide whether a Ctrl+C should copy the selected grid cell range rather than
// letting the browser copy a text selection. Any competing text selection — in
// the page (hasDomSelection) or inside a focused input/textarea
// (hasInputSelection) — wins, so the highlighted text lands on the clipboard.
function shouldCopyCellRange(hasRangeSelection, hasDomSelection, hasInputSelection) {
    return !!hasRangeSelection && !hasDomSelection && !hasInputSelection;
}

// Compute where a navigation key moves the focus cell within a grid of
// rowCount × colCount cells, clamped to the grid. Arrow keys move by one,
// PageUp/PageDown by pageRows, Home/End move to the first/last column (and to
// the first/last row too when ctrlKey is set). Returns the new {r, c}, or null
// when the key is not a navigation key. The caller decides whether to also move
// the anchor (plain move) or keep it (Shift-extend).
function computeCellNavTarget(key, ctrlKey, current, rowCount, colCount, pageRows) {
    if (!current || rowCount <= 0 || colCount <= 0) { return null; }
    const step = Math.max(1, pageRows | 0);
    let r = current.r;
    let c = current.c;
    switch (key) {
        case 'ArrowUp': r -= 1; break;
        case 'ArrowDown': r += 1; break;
        case 'ArrowLeft': c -= 1; break;
        case 'ArrowRight': c += 1; break;
        case 'Home': c = 0; if (ctrlKey) { r = 0; } break;
        case 'End': c = colCount - 1; if (ctrlKey) { r = rowCount - 1; } break;
        case 'PageUp': r -= step; break;
        case 'PageDown': r += step; break;
        default: return null;
    }
    r = Math.max(0, Math.min(rowCount - 1, r));
    c = Math.max(0, Math.min(colCount - 1, c));
    return { r, c };
}

// How far to scroll a container so a cell is fully visible, keeping it clear of
// the pinned header (headInset at the top) and the frozen columns (leftInset at
// the left). `cell` and `view` are getBoundingClientRect-style rectangles in the
// same coordinate space; returns the scrollTop/scrollLeft deltas to apply (0
// when that axis already shows the cell). A cell larger than the free space is
// aligned to its top-left so its start stays reachable.
function computeScrollAdjustment(cell, view, headInset, leftInset) {
    const topLimit = view.top + (headInset || 0);
    const leftLimit = view.left + (leftInset || 0);
    let dTop = 0;
    let dLeft = 0;
    if (cell.top < topLimit) {
        dTop = cell.top - topLimit;
    } else if (cell.bottom > view.bottom) {
        // Never push the top above the header inset while chasing the bottom.
        dTop = Math.min(cell.bottom - view.bottom, cell.top - topLimit);
    }
    if (cell.left < leftLimit) {
        dLeft = cell.left - leftLimit;
    } else if (cell.right > view.right) {
        dLeft = Math.min(cell.right - view.right, cell.left - leftLimit);
    }
    return { dTop, dLeft };
}

// --- Unified edit-history (undo/redo) helpers ---------------------------------
// The Data Viewer keeps one history stack that spans both the staged grid edits
// (modified/inserted/duplicated/deleted cells) and the SQL query text, so
// Ctrl+Z / Ctrl+Y walk every change back and forth in the exact order it was
// made. These top-level helpers are pure so they can be unit-tested without a
// DOM; the stateful capture/restore lives in the webview closure.

// Deep-clone a value while preserving Map and Set instances, so a captured
// snapshot is fully independent of the live edit state it was taken from.
function cloneEditValue(v) {
    if (v instanceof Map) { return new Map(Array.from(v, ([k, val]) => [k, cloneEditValue(val)])); }
    if (v instanceof Set) { return new Set(Array.from(v, cloneEditValue)); }
    if (Array.isArray(v)) { return v.map(cloneEditValue); }
    if (v && typeof v === 'object') {
        const out = {};
        for (const k of Object.keys(v)) { out[k] = cloneEditValue(v[k]); }
        return out;
    }
    return v;
}

// Serialize a value to a canonical string for structural equality. Map and Set
// contents are order-independent (sorted); arrays keep their order because row
// order is meaningful.
function serializeEditValue(v) {
    if (v instanceof Map) {
        return 'M{' + Array.from(v, ([k, val]) => JSON.stringify(k) + ':' + serializeEditValue(val)).sort().join(',') + '}';
    }
    if (v instanceof Set) {
        return 'S[' + Array.from(v, serializeEditValue).sort().join(',') + ']';
    }
    if (Array.isArray(v)) {
        return '[' + v.map(serializeEditValue).join(',') + ']';
    }
    if (v && typeof v === 'object') {
        return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + serializeEditValue(v[k])).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
}

// Structural equality of two edit snapshots (the object captured by the webview).
function editStatesEqual(a, b) {
    if (a === b) { return true; }
    if (!a || !b) { return false; }
    return serializeEditValue(a) === serializeEditValue(b);
}

// Advance the history stack by one state. Redo entries past `index` are dropped.
// With `coalesce` the current top is replaced instead of a new entry pushed (so
// continuous typing collapses into one step); if the coalesced value returns to
// the entry below it, the top is removed entirely. A change equal to the current
// top is a no-op. Returns the new { history, index }.
function applyHistoryEntry(history, index, state, equals, coalesce) {
    const h = history.slice(0, index + 1);
    if (coalesce && h.length >= 2) {
        if (equals(h[h.length - 2], state)) {
            h.pop();
            return { history: h, index: h.length - 1 };
        }
        h[h.length - 1] = state;
        return { history: h, index: h.length - 1 };
    }
    if (h.length && equals(h[h.length - 1], state)) {
        return { history: h, index: h.length - 1 };
    }
    h.push(state);
    return { history: h, index: h.length - 1 };
}

function formatNumberDisplay(value, thousandSeparator = DEFAULT_THOUSAND_SEPARATOR) {
    if (value === null || value === undefined) return null;
    const num = Number(value);
    if (isNaN(num)) return String(value);
    const parts = String(value).split('.');
    const intPart = parts[0].replace(/^-/, '');
    const sign = num < 0 ? '-' : '';
    let formatted = '';
    for (let i = 0; i < intPart.length; i++) {
        if (i > 0 && (intPart.length - i) % 3 === 0) {
            formatted += thousandSeparator;
        }
        formatted += intPart[i];
    }
    if (parts.length > 1) {
        formatted += ',' + parts[1];
    }
    return sign + formatted;
}

function formatExactMatchValue(value, filterType, thousandSeparator = DEFAULT_THOUSAND_SEPARATOR) {
    if (filterType === 'numeric') {
        const normalized = normalizeNumericInput(value, thousandSeparator);
        return `'${escapeSqlString(normalized)}'`;
    }
    return `'${escapeSqlString(value)}'`;
}

function normalizeFilterInputValue(value, filterType, thousandSeparator = DEFAULT_THOUSAND_SEPARATOR) {
    if (value === null || value === undefined) return value;
    if (filterType === 'numeric') {
        return normalizeNumericInput(value, thousandSeparator);
    }
    return String(value);
}

/**
 * Core live-formatting logic for numeric values.
 * Takes current text, cursor position (as digit count before cursor), and thousand separator.
 * Returns { formatted, normalized, newCursor } or null if no formatting needed.
 */
function liveFormatNumeric(text, digitCursorPos, thousandSeparator = DEFAULT_THOUSAND_SEPARATOR) {
    if (!text || text === '') return null;
    const normalized = normalizeNumericInput(text, thousandSeparator);
    if (!normalized || isNaN(Number(normalized))) return null;
    const formatted = formatNumberDisplay(normalized, thousandSeparator);
    if (formatted === null || formatted === text) return null;

    // Compute new cursor offset by counting digits in formatted string
    let charCount = 0;
    let newCursor = formatted.length;
    for (let i = 0; i < formatted.length; i++) {
        if (formatted[i] !== thousandSeparator) {
            charCount++;
        }
        if (charCount >= digitCursorPos) {
            newCursor = i + 1;
            break;
        }
    }
    return { formatted, normalized, newCursor };
}

// ===== SQL query helpers (pure; shared with the webview IIFE and unit tests) =====

// Detect and strip a trailing LIMIT [n] [OFFSET m] clause that is not
// inside parentheses or string literals. Returns { base, hadLimit }.
function stripTrailingLimitOffset(sql) {
    const len = sql.length;
    let depth = 0;
    let inSingle = false, inDouble = false, inLineComment = false, inBlockComment = false;
    const tokens = []; // [{kw, start}] for top-level LIMIT/OFFSET
    let i = 0;
    while (i < len) {
        const ch = sql[i];
        const next = sql[i + 1];
        if (inLineComment) { if (ch === '\n') inLineComment = false; i++; continue; }
        if (inBlockComment) { if (ch === '*' && next === '/') { inBlockComment = false; i += 2; continue; } i++; continue; }
        if (inSingle) { if (ch === "'") { if (next === "'") { i += 2; continue; } inSingle = false; } i++; continue; }
        if (inDouble) { if (ch === '"') { if (next === '"') { i += 2; continue; } inDouble = false; } i++; continue; }
        if (ch === '-' && next === '-') { inLineComment = true; i += 2; continue; }
        if (ch === '/' && next === '*') { inBlockComment = true; i += 2; continue; }
        if (ch === "'") { inSingle = true; i++; continue; }
        if (ch === '"') { inDouble = true; i++; continue; }
        if (ch === '(') { depth++; i++; continue; }
        if (ch === ')') { depth--; i++; continue; }
        if (depth === 0 && /[A-Za-z_]/.test(ch)) {
            let j = i;
            while (j < len && /[A-Za-z0-9_]/.test(sql[j])) j++;
            const word = sql.substring(i, j).toLowerCase();
            const before = i === 0 ? ' ' : sql[i - 1];
            if ((word === 'limit' || word === 'offset' || word === 'fetch') && /[\s);]/.test(before)) {
                tokens.push({ kw: word, start: i });
            }
            i = j;
            continue;
        }
        i++;
    }
    if (tokens.length === 0) return { base: sql.replace(/[\s;]+$/, ''), hadLimit: false };
    // Pick the earliest LIMIT/FETCH token among the trailing run
    // (allow OFFSET to come before LIMIT too).
    const trailing = tokens[tokens.length - 1];
    // Walk back to the first contiguous LIMIT/OFFSET/FETCH that all belong
    // to the same trailing clause group.
    let firstIdx = trailing.start;
    for (let t = tokens.length - 1; t >= 0; t--) {
        firstIdx = tokens[t].start;
        if (t === 0) break;
        const prev = tokens[t - 1];
        // Only keep walking back if the previous token is also LIMIT/OFFSET
        // and only whitespace/numbers/parens between them.
        const between = sql.substring(prev.start, firstIdx);
        if (!/^\s*(limit|offset|fetch)\b[^A-Za-z_]*$/i.test(between)) break;
    }
    return {
        base: sql.substring(0, firstIdx).replace(/[\s;]+$/, ''),
        hadLimit: true
    };
}

function findTopLevelKeywordIndex(sql, keyword) {
    const upper = keyword.toUpperCase();
    let depth = 0;
    let inStr = false;
    let strCh = '';
    let i = 0;
    while (i < sql.length) {
        const ch = sql[i];
        if (inStr) {
            if (ch === strCh) {
                if (strCh === "'" && sql[i + 1] === "'") { i += 2; continue; }
                inStr = false;
            }
            i++;
            continue;
        }
        if (ch === "'" || ch === '"') { inStr = true; strCh = ch; i++; continue; }
        if (ch === '(') { depth++; i++; continue; }
        if (ch === ')') { depth--; i++; continue; }
        if (depth === 0) {
            // Word boundary on left (whitespace), and matches keyword followed by whitespace
            if ((i === 0 || /\s/.test(sql[i - 1])) &&
                sql.substring(i, i + upper.length).toUpperCase() === upper &&
                /\s/.test(sql[i + upper.length] || '')) {
                return i;
            }
        }
        i++;
    }
    return -1;
}

function parseSqlForWhere(sql) {
    let s = String(sql || '').trim().replace(/;\s*$/, '').trim();
    // Strip trailing LIMIT/OFFSET that we may have appended previously
    s = s.replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$/i, '');
    // Strip trailing ORDER BY ...
    let orderBy = '';
    const ordRe = /\s+ORDER\s+BY\s+([\s\S]+)$/i;
    const ordMatch = s.match(ordRe);
    if (ordMatch) {
        orderBy = ordMatch[1].trim();
        s = s.substring(0, ordMatch.index);
    }
    // Find top-level WHERE (best-effort: first WHERE at paren depth 0, outside strings)
    const whereIdx = findTopLevelKeywordIndex(s, 'WHERE');
    let base = s;
    let where = '';
    if (whereIdx !== -1) {
        const after = s.substring(whereIdx);
        const m = after.match(/^\s*WHERE\s+/i);
        base = s.substring(0, whereIdx).replace(/\s+$/, '');
        where = after.substring(m[0].length).trim();
    }
    return { base, where, orderBy };
}

function splitWhereByAnd(whereClause) {
    const parts = [];
    let buf = '';
    let depth = 0;
    let inStr = false;
    let strCh = '';
    let i = 0;
    while (i < whereClause.length) {
        const ch = whereClause[i];
        if (inStr) {
            buf += ch;
            if (ch === strCh) {
                if (strCh === "'" && whereClause[i + 1] === "'") { buf += "'"; i += 2; continue; }
                inStr = false;
            }
            i++;
            continue;
        }
        if (ch === "'" || ch === '"') { inStr = true; strCh = ch; buf += ch; i++; continue; }
        if (ch === '(') { depth++; buf += ch; i++; continue; }
        if (ch === ')') { depth--; buf += ch; i++; continue; }
        if (depth === 0) {
            const rest = whereClause.substring(i);
            const m = rest.match(/^\s+AND\s+/i);
            if (m && /\s/.test(whereClause[i] || '')) {
                parts.push(buf.trim());
                buf = '';
                i += m[0].length;
                continue;
            }
        }
        buf += ch;
        i++;
    }
    if (buf.trim()) parts.push(buf.trim());
    return parts;
}

function whereClauseTargetsColumn(clause, colName) {
    // Match an optional schema/table prefix then the column identifier (quoted or bare)
    const m = clause.match(/^\s*(?:(?:"[^"]+"|[A-Za-z_][\w$]*)\s*\.\s*)*("[^"]+"|[A-Za-z_][\w$]*)/);
    if (!m) return false;
    let tok = m[1];
    if (tok.startsWith('"') && tok.endsWith('"')) tok = tok.substring(1, tok.length - 1);
    return tok.toLowerCase() === colName.toLowerCase();
}

// Replace the WHERE clauses of the listed columns, keeping every other clause
// (including hand-written ones) untouched. An empty clause drops the column's
// condition, which is how clearing a column filter removes it from the query.
function mergeWhereClauses(existing, clausesByCol) {
    const clauses = existing || [];
    const targetCols = Object.keys(clausesByCol || {});
    if (targetCols.length === 0) return clauses.slice();
    const merged = clauses.filter(c => !targetCols.some(col => whereClauseTargetsColumn(c, col)));
    for (const col of targetCols) {
        if (clausesByCol[col]) merged.push(clausesByCol[col]);
    }
    return merged;
}

function parseSqlForOrder(sql) {
    let s = String(sql || '').trim().replace(/;\s*$/, '').trim();
    // Strip trailing LIMIT [OFFSET] (numeric only — generated by us)
    s = s.replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$/i, '');
    // Extract trailing ORDER BY ... up to end
    const orderRe = /\s+ORDER\s+BY\s+([\s\S]+)$/i;
    const m = s.match(orderRe);
    if (m) {
        return { base: s.substring(0, m.index), orderBy: m[1].trim() };
    }
    return { base: s, orderBy: '' };
}

// --- SQL pretty-printer for the query bar -------------------------------------
// Produces a readable, multi-line layout for plain SELECT statements: each
// top-level clause (FROM/WHERE/JOIN/GROUP BY/ORDER BY/...) starts on its own
// line, SELECT columns are listed one per indented line and WHERE/HAVING
// conditions are split on top-level AND. The function is intentionally
// conservative: statements it cannot safely reformat (CTEs, statements with
// comments, non-SELECT statements) are returned trimmed but otherwise as-is.

// True when the SQL contains a -- line comment or /* */ block comment at the
// top level (outside string/identifier literals).
function hasSqlComment(s) {
    let inSingle = false, inDouble = false, i = 0;
    while (i < s.length) {
        const ch = s[i], nx = s[i + 1];
        if (inSingle) { if (ch === "'") { if (nx === "'") { i += 2; continue; } inSingle = false; } i++; continue; }
        if (inDouble) { if (ch === '"') { if (nx === '"') { i += 2; continue; } inDouble = false; } i++; continue; }
        if (ch === "'") { inSingle = true; i++; continue; }
        if (ch === '"') { inDouble = true; i++; continue; }
        if (ch === '-' && nx === '-') return true;
        if (ch === '/' && nx === '*') return true;
        i++;
    }
    return false;
}

// Collapse every run of whitespace outside string/identifier literals to a
// single space so the keyword scanner can rely on single-space separators.
function collapseSqlWhitespace(s) {
    let out = '', inSingle = false, inDouble = false, i = 0;
    while (i < s.length) {
        const ch = s[i];
        if (inSingle) { out += ch; if (ch === "'") { if (s[i + 1] === "'") { out += "'"; i += 2; continue; } inSingle = false; } i++; continue; }
        if (inDouble) { out += ch; if (ch === '"') { if (s[i + 1] === '"') { out += '"'; i += 2; continue; } inDouble = false; } i++; continue; }
        if (ch === "'") { inSingle = true; out += ch; i++; continue; }
        if (ch === '"') { inDouble = true; out += ch; i++; continue; }
        if (/\s/.test(ch)) { out += ' '; i++; while (i < s.length && /\s/.test(s[i])) i++; continue; }
        out += ch; i++;
    }
    return out.trim();
}

// Split a list on top-level commas (ignoring commas inside parentheses or
// string/identifier literals).
function splitTopLevelCommas(s) {
    const parts = [];
    let buf = '', depth = 0, inSingle = false, inDouble = false, i = 0;
    while (i < s.length) {
        const ch = s[i];
        if (inSingle) { buf += ch; if (ch === "'") { if (s[i + 1] === "'") { buf += "'"; i += 2; continue; } inSingle = false; } i++; continue; }
        if (inDouble) { buf += ch; if (ch === '"') { if (s[i + 1] === '"') { buf += '"'; i += 2; continue; } inDouble = false; } i++; continue; }
        if (ch === "'") { inSingle = true; buf += ch; i++; continue; }
        if (ch === '"') { inDouble = true; buf += ch; i++; continue; }
        if (ch === '(') { depth++; buf += ch; i++; continue; }
        if (ch === ')') { depth--; buf += ch; i++; continue; }
        if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; i++; continue; }
        buf += ch; i++;
    }
    if (buf.trim()) parts.push(buf);
    return parts;
}

// Clause keywords that start a new top-level line. Multi-word entries must
// precede their single-word prefixes so the scanner matches the longest form.
const SQL_CLAUSE_KEYWORDS = [
    'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN',
    'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'INNER JOIN',
    'GROUP BY', 'ORDER BY', 'UNION ALL',
    'SELECT', 'FROM', 'WHERE', 'HAVING', 'WINDOW', 'LIMIT', 'OFFSET',
    'FETCH', 'UNION', 'INTERSECT', 'EXCEPT', 'JOIN', 'RETURNING'
];

// Break a (whitespace-collapsed) statement into ordered { kw, content }
// segments at top-level clause keywords.
function splitTopLevelClauses(s) {
    const U = s.toUpperCase();
    const segs = [];
    let i = 0, depth = 0, inSingle = false, inDouble = false;
    let segStart = 0, segKw = '';
    while (i < s.length) {
        const ch = s[i];
        if (inSingle) { if (ch === "'") { if (s[i + 1] === "'") { i += 2; continue; } inSingle = false; } i++; continue; }
        if (inDouble) { if (ch === '"') { if (s[i + 1] === '"') { i += 2; continue; } inDouble = false; } i++; continue; }
        if (ch === "'") { inSingle = true; i++; continue; }
        if (ch === '"') { inDouble = true; i++; continue; }
        if (ch === '(') { depth++; i++; continue; }
        if (ch === ')') { depth--; i++; continue; }
        if (depth === 0 && (i === 0 || /[\s(,]/.test(s[i - 1]))) {
            let matched = null;
            for (const kw of SQL_CLAUSE_KEYWORDS) {
                if (U.startsWith(kw, i)) {
                    const after = s[i + kw.length];
                    if (after === undefined || /[\s(]/.test(after)) { matched = kw; break; }
                }
            }
            if (matched) {
                segs.push({ kw: segKw, content: s.slice(segStart, i).trim() });
                segKw = matched;
                i += matched.length;
                segStart = i;
                continue;
            }
        }
        i++;
    }
    segs.push({ kw: segKw, content: s.slice(segStart).trim() });
    return segs.filter((seg, idx) => !(idx === 0 && seg.kw === '' && seg.content === ''));
}

function formatSql(sql) {
    if (sql == null) return sql;
    const raw = String(sql).trim().replace(/;+\s*$/, '').trim();
    if (!raw) return String(sql);
    // Only reformat plain SELECT statements; leave CTEs/DML/commented SQL alone.
    if (!/^SELECT\b/i.test(raw)) return raw;
    if (hasSqlComment(raw)) return raw;

    const s = collapseSqlWhitespace(raw);
    const segs = splitTopLevelClauses(s);
    if (segs.length === 0 || segs[0].kw.toUpperCase() !== 'SELECT') return raw;

    const INDENT = '    ';
    const lines = [];
    for (const seg of segs) {
        const kw = seg.kw.toUpperCase();
        const content = seg.content;
        if (kw === 'SELECT') {
            let prefix = '';
            let body = content;
            const distinct = body.match(/^DISTINCT(\s+ON\s*\([\s\S]*?\))?\s+/i);
            if (distinct) { prefix = body.slice(0, distinct[0].length).trim(); body = body.slice(distinct[0].length); }
            const cols = splitTopLevelCommas(body);
            const header = prefix ? `SELECT ${prefix}` : 'SELECT';
            if (cols.length <= 1) {
                lines.push(`${header} ${body}`.trimEnd());
            } else {
                lines.push(header);
                cols.forEach((c, idx) => {
                    lines.push(INDENT + c.trim() + (idx < cols.length - 1 ? ',' : ''));
                });
            }
        } else if (kw === 'WHERE' || kw === 'HAVING') {
            const conds = splitWhereByAnd(content);
            if (conds.length <= 1) {
                lines.push(`${kw} ${content}`.trimEnd());
            } else {
                lines.push(`${kw} ${conds[0].trim()}`);
                for (let k = 1; k < conds.length; k++) lines.push(`${INDENT}AND ${conds[k].trim()}`);
            }
        } else {
            lines.push(content ? `${kw} ${content}` : kw);
        }
    }
    return lines.join('\n');
}

// ===== Group Edit: turn the current SELECT into an UPDATE/DELETE template =====

// Split a fragment on top-level whitespace, ignoring whitespace inside string
// or identifier literals and parentheses.
function splitTopLevelSpaces(s) {
    const parts = [];
    let buf = '', depth = 0, inSingle = false, inDouble = false, i = 0;
    while (i < s.length) {
        const ch = s[i];
        if (inSingle) { buf += ch; if (ch === "'") { if (s[i + 1] === "'") { buf += "'"; i += 2; continue; } inSingle = false; } i++; continue; }
        if (inDouble) { buf += ch; if (ch === '"') { if (s[i + 1] === '"') { buf += '"'; i += 2; continue; } inDouble = false; } i++; continue; }
        if (ch === "'") { inSingle = true; buf += ch; i++; continue; }
        if (ch === '"') { inDouble = true; buf += ch; i++; continue; }
        if (ch === '(') { depth++; buf += ch; i++; continue; }
        if (ch === ')') { depth--; buf += ch; i++; continue; }
        if (depth === 0 && /\s/.test(ch)) { if (buf) { parts.push(buf); buf = ''; } i++; while (i < s.length && /\s/.test(s[i])) i++; continue; }
        buf += ch; i++;
    }
    if (buf) parts.push(buf);
    return parts;
}

// The unqualified, unquoted table name of a (possibly schema-qualified) table
// reference, e.g. `public."My Table"` -> `My Table`.
function unqualifiedTableName(ref) {
    let buf = '', last = '', inDouble = false, i = 0;
    const s = String(ref || '');
    while (i < s.length) {
        const ch = s[i];
        if (inDouble) { buf += ch; if (ch === '"') { if (s[i + 1] === '"') { buf += '"'; i += 2; continue; } inDouble = false; } i++; continue; }
        if (ch === '"') { inDouble = true; buf += ch; i++; continue; }
        if (ch === '.') { last = buf; buf = ''; i++; continue; }
        buf += ch; i++;
    }
    last = buf || last;
    if (last.length >= 2 && last[0] === '"' && last[last.length - 1] === '"') {
        last = last.slice(1, -1).replace(/""/g, '"');
    }
    return last;
}

// Split a table fragment into its reference and (optional) alias, e.g.
// `public.orders o` or `public.orders AS o` -> { ref, alias, tableName }.
function parseTableRefAlias(fragment) {
    const tokens = splitTopLevelSpaces(String(fragment || '').trim());
    const ref = tokens[0] || '';
    let alias = '';
    if (tokens.length >= 3 && tokens[1].toUpperCase() === 'AS') {
        alias = tokens[2];
    } else if (tokens.length >= 2 && tokens[1].toUpperCase() !== 'AS') {
        alias = tokens[1];
    }
    return { ref, alias, tableName: unqualifiedTableName(ref) };
}

// Index of the top-level `ON` keyword of a JOIN clause body, or -1 when the
// join carries no ON condition (CROSS JOIN). Literals and parentheses are
// skipped so an `ON` inside a sub-select is never mistaken for the join's own.
function findTopLevelOn(s) {
    const U = s.toUpperCase();
    let depth = 0, inSingle = false, inDouble = false, i = 0;
    while (i < s.length) {
        const ch = s[i];
        if (inSingle) { if (ch === "'") { if (s[i + 1] === "'") { i += 2; continue; } inSingle = false; } i++; continue; }
        if (inDouble) { if (ch === '"') { if (s[i + 1] === '"') { i += 2; continue; } inDouble = false; } i++; continue; }
        if (ch === "'") { inSingle = true; i++; continue; }
        if (ch === '"') { inDouble = true; i++; continue; }
        if (ch === '(') { depth++; i++; continue; }
        if (ch === ')') { depth--; i++; continue; }
        if (depth === 0 && (i === 0 || /\s/.test(s[i - 1])) && U.startsWith('ON', i)) {
            const after = s[i + 2];
            if (after === undefined || /\s/.test(after) || after === '(') { return i; }
        }
        i++;
    }
    return -1;
}

// Parse a plain SELECT into the parts a group UPDATE/DELETE needs: the base
// table (FROM), its joins (each with its ON condition) and the WHERE body.
// Returns null for anything that cannot be safely rewritten (a non-SELECT, a
// set operation, a commented statement or a SELECT without a FROM clause).
function parseGroupEditQuery(sql) {
    const raw = String(sql == null ? '' : sql).trim().replace(/;+\s*$/, '').trim();
    if (!raw || hasSqlComment(raw)) return null;
    const s = collapseSqlWhitespace(raw);
    if (!/^SELECT\b/i.test(s)) return null;
    const segs = splitTopLevelClauses(s);
    if (!segs.length || segs[0].kw.toUpperCase() !== 'SELECT') return null;

    let base = null;
    const joins = [];
    let where = '';
    let outerJoin = false;
    for (const seg of segs) {
        const kw = seg.kw.toUpperCase();
        if (kw === 'FROM') {
            const tables = splitTopLevelCommas(seg.content).map(t => t.trim()).filter(Boolean);
            if (!tables.length) return null;
            base = parseTableRefAlias(tables[0]);
            // Old-style comma joins keep their predicate in WHERE; the extra
            // tables simply move into the FROM/USING list.
            for (let k = 1; k < tables.length; k++) {
                const extra = parseTableRefAlias(tables[k]);
                joins.push({ ref: extra.ref, alias: extra.alias, on: '' });
            }
        } else if (/JOIN$/.test(kw)) {
            if (/(LEFT|RIGHT|FULL)/.test(kw)) outerJoin = true;
            const onIdx = findTopLevelOn(seg.content);
            const refPart = onIdx >= 0 ? seg.content.slice(0, onIdx) : seg.content;
            const on = onIdx >= 0 ? seg.content.slice(onIdx + 2).trim() : '';
            const t = parseTableRefAlias(refPart);
            joins.push({ ref: t.ref, alias: t.alias, on });
        } else if (kw === 'WHERE') {
            where = seg.content.trim();
        } else if (kw === 'UNION' || kw === 'UNION ALL' || kw === 'INTERSECT' || kw === 'EXCEPT') {
            // A set operation has no single base table to write back to.
            return null;
        }
        // GROUP BY / HAVING / ORDER BY / LIMIT / OFFSET / WINDOW do not carry
        // over to an UPDATE/DELETE and are dropped.
    }
    if (!base || !base.ref) return null;
    return { ok: true, base, joins, where, outerJoin };
}

// Build the WHERE body of a group edit: the join ON conditions and the original
// WHERE, each wrapped in parentheses when combined so their operator precedence
// is preserved.
function buildGroupEditWhere(parsed) {
    const parts = parsed.joins.map(j => j.on).filter(Boolean);
    if (parsed.where) parts.push(parsed.where);
    if (parts.length === 0) return '';
    if (parts.length === 1) return parts[0];
    return parts.map(p => '(' + p + ')').join(' AND ');
}

// Turn a parsed SELECT into an UPDATE or DELETE that hits exactly the rows the
// SELECT returns: joins become FROM/USING tables and their ON conditions move
// into WHERE. `setColumns` are the real column names of the base table used to
// seed the SET list of an UPDATE. Returns '' when the query cannot be rewritten.
function buildGroupEditSql(kind, parsed, setColumns, formatCol) {
    if (!parsed || !parsed.ok) return '';
    const fmt = typeof formatCol === 'function' ? formatCol : (c) => c;
    const baseRef = parsed.base.ref + (parsed.base.alias ? ' ' + parsed.base.alias : '');
    const usingTables = parsed.joins
        .map(j => j.ref + (j.alias ? ' ' + j.alias : ''))
        .join(', ');
    const whereBody = buildGroupEditWhere(parsed);
    const lines = [];
    if (parsed.outerJoin) {
        lines.push('-- Note: an outer join was flattened into '
            + (kind === 'update' ? 'FROM' : 'USING') + '/WHERE; review which rows this affects.');
    }
    if (kind === 'update') {
        lines.push('UPDATE ' + baseRef);
        lines.push('SET');
        const cols = Array.isArray(setColumns) ? setColumns : [];
        if (cols.length) {
            cols.forEach((c, i) => lines.push('    ' + fmt(c) + ' = NULL' + (i < cols.length - 1 ? ',' : '')));
        } else {
            lines.push('    -- add columns to update, e.g. <column> = NULL');
        }
        if (usingTables) lines.push('FROM ' + usingTables);
        if (whereBody) lines.push('WHERE ' + whereBody);
    } else {
        lines.push('DELETE FROM ' + baseRef);
        if (usingTables) lines.push('USING ' + usingTables);
        if (whereBody) lines.push('WHERE ' + whereBody);
    }
    return lines.join('\n') + ';';
}

// Map a filter mode keyword to its SQL comparison operator.
function filterOperatorForMode(mode) {
    switch (mode) {
        case 'not_equals': return '!=';
        case 'gt': return '>';
        case 'gte': return '>=';
        case 'lt': return '<';
        case 'lte': return '<=';
        default: return '=';
    }
}

// Build the SQL WHERE-clause fragment for a single column filter, or return
// null when the filter does not constrain the query. `fmtCol` is the already
// quoted/qualified column identifier and `operator` is the comparison operator
// for single-value numeric/date filters.
function buildFilterClause(fmtCol, val, filterType, isExact, operator, thousandSeparator) {
    if (val === null || val === undefined || val === '') return null;

    if (isExact) {
        return `${fmtCol} = ${formatExactMatchValue(val, filterType, thousandSeparator)}`;
    }

    if (typeof val === 'object' && val.from !== undefined) {
        const fromRaw = val.from ? normalizeFilterInputValue(val.from, filterType, thousandSeparator) : '';
        const toRaw = val.to ? normalizeFilterInputValue(val.to, filterType, thousandSeparator) : '';
        if (filterType === 'numeric') {
            const from = fromRaw !== '' ? (toNumericLiteral(fromRaw) || '') : '';
            const to = toRaw !== '' ? (toNumericLiteral(toRaw) || '') : '';
            if (from && to) return `${fmtCol} BETWEEN ${from} AND ${to}`;
            if (from) return `${fmtCol} >= ${from}`;
            if (to) return `${fmtCol} <= ${to}`;
            return null;
        }
        const from = escapeSqlString(fromRaw);
        const to = escapeSqlString(toRaw);
        if (from && to) return `${fmtCol} BETWEEN '${from}' AND '${to}'`;
        if (from) return `${fmtCol} >= '${from}'`;
        if (to) return `${fmtCol} <= '${to}'`;
        return null;
    }

    if (filterType === 'numeric') {
        const numericValue = toNumericLiteral(normalizeFilterInputValue(val, filterType, thousandSeparator));
        if (numericValue === null) return null;
        return `${fmtCol} ${operator} ${numericValue}`;
    }

    if (filterType === 'date') {
        return `${fmtCol} ${operator} '${escapeSqlString(val)}'`;
    }

    return `${fmtCol}::text ILIKE '%${escapeSqlString(val)}%'`;
}

// Build an `IS NULL` / `IS NOT NULL` WHERE clause for an already-formatted
// column identifier. `isNull` true yields `<col> IS NULL`, false yields
// `<col> IS NOT NULL`.
function buildNullConstraintClause(fmtCol, isNull) {
    return `${fmtCol} IS ${isNull ? 'NULL' : 'NOT NULL'}`;
}

// Decide whether the in-viewer error dialog should be shown for a given error
// text and what message it should display. A missing/blank message falls back
// to a generic text; surrounding whitespace is trimmed. Returns
// { visible, message }.
function buildErrorDialogState(text) {
    const message = (text === null || text === undefined) ? '' : String(text).trim();
    if (!message) {
        return { visible: true, message: 'An unknown error occurred.' };
    }
    return { visible: true, message };
}

// Turn a custom-mapping condition ({column, operator, value}) into a SQL WHERE
// clause for an already-formatted column identifier. LIKE/ILIKE use a
// "contains" match (wrapped in %…%) to mirror evaluateMappingConditions; every
// other operator emits `<col> <op> <quoted-value>`. Returns '' for an
// incomplete condition.
function mappingConditionToClause(cond, fmtCol, filterType, thousandSeparator) {
    if (!cond || !cond.column || !cond.operator) return '';
    const raw = (cond.value === null || cond.value === undefined) ? '' : String(cond.value);
    if (cond.operator === 'LIKE' || cond.operator === 'ILIKE') {
        return `${fmtCol} ${cond.operator} '${escapeSqlString('%' + raw + '%')}'`;
    }
    return `${fmtCol} ${cond.operator} ${formatExactMatchValue(raw, filterType, thousandSeparator)}`;
}

// Operators offered in the permanent-constraint editor. Mirrors the Join
// dialog's fixed-condition operators so both editors behave identically.
const CONSTRAINT_OPERATORS = ['=', '<>', '<', '<=', '>', '>=', 'LIKE', 'ILIKE', 'BETWEEN', 'IS NULL', 'IS NOT NULL'];

// True for operators that take no right-hand operand.
function constraintIsUnary(operator) {
    const op = (operator || '').toUpperCase();
    return op === 'IS NULL' || op === 'IS NOT NULL';
}

// True for the BETWEEN operator (two right-hand operands joined by AND).
function constraintIsBetween(operator) {
    return (operator || '').toUpperCase() === 'BETWEEN';
}

// Render a single constraint operand to SQL text. A `column` operand is quoted
// via the supplied `formatCol` callback; a `raw` operand is emitted verbatim.
function formatConstraintOperand(op, formatCol) {
    if (!op) {
        return '';
    }
    if (op.kind === 'column') {
        const col = (op.column || '').trim();
        if (!col) {
            return '';
        }
        return formatCol ? formatCol(col) : col;
    }
    return (op.text || '').trim();
}

// Build the SQL text for one permanent constraint condition. Returns an empty
// string when required operands are missing, so incomplete rows are skipped.
function formatConstraintCondition(cond, formatCol) {
    if (!cond) {
        return '';
    }
    const op = (cond.operator || '').toUpperCase();
    const left = formatConstraintOperand(cond.left, formatCol);
    if (!left) {
        return '';
    }
    if (constraintIsUnary(op)) {
        return `${left} ${op}`;
    }
    if (constraintIsBetween(op)) {
        const r1 = formatConstraintOperand(cond.right, formatCol);
        const r2 = formatConstraintOperand(cond.right2, formatCol);
        if (!r1 || !r2) {
            return '';
        }
        return `${left} BETWEEN ${r1} AND ${r2}`;
    }
    const right = formatConstraintOperand(cond.right, formatCol);
    if (!right) {
        return '';
    }
    return `${left} ${op} ${right}`;
}

// Join all permanent constraint conditions into a single WHERE clause body.
function buildConstraintWhere(conditions, formatCol) {
    if (!Array.isArray(conditions)) {
        return '';
    }
    return conditions
        .map((c) => formatConstraintCondition(c, formatCol))
        .filter((s) => s)
        .join(' AND ');
}

// Directions offered in the permanent-sort editor.
const CONSTRAINT_SORT_DIRECTIONS = ['ASC', 'DESC'];

// Render one permanent sort entry to SQL text. Returns '' when no column is
// selected, so incomplete rows are skipped.
function formatConstraintSort(sort, formatCol) {
    if (!sort) {
        return '';
    }
    const col = (sort.column || '').trim();
    if (!col) {
        return '';
    }
    const direction = String(sort.direction || '').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    const left = formatCol ? formatCol(col) : col;
    return `${left} ${direction}`;
}

// Join all permanent sort entries into a single ORDER BY clause body.
function buildConstraintOrderBy(sorts, formatCol) {
    if (!Array.isArray(sorts)) {
        return '';
    }
    return sorts
        .map((s) => formatConstraintSort(s, formatCol))
        .filter((s) => s)
        .join(', ');
}

// Build the explicit column list used by the default table-view query. Instead
// of a `*` wildcard the query bar lists every column by name. When the columns
// are not yet known (empty list) it falls back to `*` so the query bar still
// shows a valid statement while metadata is loading. When `alias` is a non-empty
// string every column (and the `*` fallback) is prefixed with `alias.`.
function buildSelectColumnList(columns, formatCol, alias) {
    const prefix = alias ? `${alias}.` : '';
    const star = `${prefix}*`;
    if (!Array.isArray(columns) || columns.length === 0) {
        return star;
    }
    const fmt = typeof formatCol === 'function' ? formatCol : (c) => c;
    const names = columns
        .map((col) => (col && col.name !== undefined && col.name !== null) ? `${prefix}${fmt(col.name)}` : '')
        .filter((s) => s !== '');
    return names.length > 0 ? names.join(', ') : star;
}

// Mirror of deriveQualifier in src/statementBuilder.ts: the part of the first
// column name before its first underscore, else the table name. Used to build
// the table alias for the default query when column qualification is on.
function deriveTableAlias(firstColumnName, table) {
    if (firstColumnName) {
        const underscore = String(firstColumnName).indexOf('_');
        if (underscore > 0) {
            return String(firstColumnName).slice(0, underscore);
        }
    }
    return table;
}

// Return a new array with the column at `fromIndex` moved so it sits at
// `toIndex` (drag-and-drop reordering of the Data Viewer header). The original
// array is left untouched. Out-of-range or no-op moves return a shallow copy of
// the input so callers can treat the result uniformly.
function reorderColumns(columns, fromIndex, toIndex) {
    if (!Array.isArray(columns)) {
        return [];
    }
    const result = columns.slice();
    const len = result.length;
    if (
        !Number.isInteger(fromIndex) || !Number.isInteger(toIndex) ||
        fromIndex < 0 || fromIndex >= len ||
        toIndex < 0 || toIndex >= len ||
        fromIndex === toIndex
    ) {
        return result;
    }
    const [moved] = result.splice(fromIndex, 1);
    result.splice(toIndex, 0, moved);
    return result;
}

// Build the tooltip text shown when hovering a Data Viewer column header.
// Returns the column's comment (trimmed) or '' when the column has no comment,
// so the caller can omit the `title` attribute entirely.
function buildColumnHeaderTitle(col) {
    if (!col || col.comment === null || col.comment === undefined) {
        return '';
    }
    return String(col.comment).trim();
}

function formatColumnTypeLabel(col) {
    if (!col) return '';
    const dataType = String(col.dataType || '').trim();
    const fullType = String(col.fullType || '').trim();
    if (!dataType) return fullType;
    const normalized = dataType.toLowerCase();
    if (['char', 'character', 'bpchar', 'varchar', 'character varying'].includes(normalized)) {
        const modifier = fullType.match(/\((\d+)\)/);
        if (modifier) return `${dataType}(${modifier[1]})`;
        return dataType;
    }
    return fullType || dataType;
}

// Next sort state for a click on `column`. A column cycles ascending →
// descending → off, and switching it off restores the sort that was active
// before it was first clicked, so looking at one column does not throw away the
// order the user had set up before.
function nextSortState(current, column) {
    const now = current || {};
    if (now.column !== column) {
        return {
            column,
            direction: 'asc',
            previous: { column: now.column || null, direction: now.direction || 'asc' }
        };
    }
    if (now.direction !== 'desc') {
        return { column, direction: 'desc', previous: now.previous || null };
    }
    const restored = now.previous || {};
    return { column: restored.column || null, direction: restored.direction || 'asc', previous: null };
}

// Compute the new per-row content height while dragging the row-resize handle.
// `startHeight` is the height (px) when the drag began, `deltaY` the vertical
// mouse movement (px, positive = downward = taller). The result is clamped to
// [minHeight, maxHeight] so a row can never shrink below a single line nor grow
// unbounded.
function computeResizedRowHeight(startHeight, deltaY, minHeight, maxHeight) {
    let h = (Number(startHeight) || 0) + (Number(deltaY) || 0);
    if (h < minHeight) {
        h = minHeight;
    }
    if (maxHeight != null && h > maxHeight) {
        h = maxHeight;
    }
    return h;
}

// Compute the new column width while dragging the handle on a header's right
// edge. `deltaX` is positive when the mouse moves right (= wider); the result is
// clamped so a column stays grabbable and cannot swallow the whole viewport.
function computeResizedColumnWidth(startWidth, deltaX, minWidth, maxWidth) {
    let w = (Number(startWidth) || 0) + (Number(deltaX) || 0);
    if (w < minWidth) {
        w = minWidth;
    }
    if (maxWidth != null && w > maxWidth) {
        w = maxWidth;
    }
    return Math.round(w);
}

// How many pixels to auto-scroll the grid per animation frame while a column
// is being resized with the pointer at (or past) the right edge of the visible
// grid. Inside the last `zone` pixels the speed rises with the depth into the
// zone up to `maxStep`; elsewhere it is 0. This is what lets the last column be
// widened beyond the edge of the panel, as in Excel.
function columnResizeEdgeStep(clientX, visibleRight, zone, maxStep) {
    const x = Number(clientX), right = Number(visibleRight);
    if (!isFinite(x) || !isFinite(right) || !(zone > 0) || !(maxStep > 0)) { return 0; }
    const depth = x - (right - zone);
    if (depth <= 0) { return 0; }
    return Math.max(1, Math.round(maxStep * Math.min(1, depth / zone)));
}

// Quote a column name for use inside a CSS attribute selector.
function cssStringLiteral(value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Build the stylesheet that pins the columns the user has resized. The auto
// table layout only honours a width when every cell of the column carries it,
// so header, filter and body cells are all addressed; the filter input has to
// be allowed to shrink as well, or its own min-width would hold the column open.
// The widths columns have grown to while their rows scrolled past, as minimum
// widths (content box, so a measured width set again does not grow), for every
// column whose width the user has not set by hand.
function buildAutoColumnWidthCss(autoWidths, userWidths) {
    const rules = [];
    Object.keys(autoWidths || {}).forEach(name => {
        if (userWidths && Number(userWidths[name]) > 0) return;
        const w = Math.round(Number(autoWidths[name]) || 0);
        if (!(w > 0)) return;
        const sel = `[data-col=${cssStringLiteral(name)}]`;
        rules.push(`#dataTable th${sel}, #dataTable td${sel} { min-width: ${w}px; }`);
    });
    return rules.join('\n');
}

function buildColumnWidthCss(widths) {
    const rules = [];
    Object.keys(widths || {}).forEach(name => {
        const w = Math.round(Number(widths[name]) || 0);
        if (!(w > 0)) return;
        const sel = `[data-col=${cssStringLiteral(name)}]`;
        rules.push(`#dataTable th${sel}, #dataTable td${sel} { width: ${w}px; min-width: ${w}px; max-width: ${w}px; }`);
        rules.push(`#dataTable th${sel} .filter-input, #dataTable th${sel} .filter-input-range { width: 100%; min-width: 0; }`);
    });
    return rules.join('\n');
}

// Number of rows still to load given how many are already loaded and the total.
// Never negative; used by the "Load All" button and the pagination indicator.
function remainingRowCount(loaded, total) {
    const n = (Number(total) || 0) - (Number(loaded) || 0);
    return n > 0 ? n : 0;
}

// Format a query execution time (milliseconds) for the row-count indicator.
// Returns '' for a missing/invalid value; sub-second times show as whole
// milliseconds, longer times as seconds with two decimals.
function formatExecutionTime(ms) {
    if (ms === null || ms === undefined || typeof ms !== 'number' || !isFinite(ms) || ms < 0) {
        return '';
    }
    if (ms < 1000) {
        return `${Math.round(ms)}\u00A0ms`;
    }
    return `${(ms / 1000).toFixed(2)}\u00A0s`;
}

// Reorder the column expressions of the SELECT clause in `sql` by moving the
// expression at `fromIndex` to `toIndex`, while preserving the rest of the
// statement (aliases, DISTINCT prefix, WHERE/ORDER BY/... clauses). This keeps a
// manually edited query bar (e.g. a column alias, a removed column) intact when
// the user reorders columns by drag-and-drop, instead of regenerating the query
// from scratch. Returns the rebuilt SQL, or null when the SELECT list cannot be
// safely reordered by column index (empty input, no SELECT clause, a `*`
// wildcard, or an out-of-range index) so callers can fall back.
function reorderSelectColumns(sql, fromIndex, toIndex) {
    if (typeof sql !== 'string' || sql.trim() === '') return null;
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex === toIndex) return null;
    const clauses = splitTopLevelClauses(collapseSqlWhitespace(sql));
    if (clauses.length === 0 || String(clauses[0].kw).toUpperCase() !== 'SELECT') return null;
    let body = clauses[0].content;
    let prefix = '';
    const distinct = body.match(/^DISTINCT(\s+ON\s*\([\s\S]*?\))?\s+/i);
    if (distinct) { prefix = body.slice(0, distinct[0].length); body = body.slice(distinct[0].length); }
    const exprs = splitTopLevelCommas(body).map(e => e.trim()).filter(e => e !== '');
    if (exprs.length === 0) return null;
    // A `*` / `table.*` wildcard has no 1:1 mapping to grid column indices.
    if (exprs.some(e => e === '*' || /\.\*$/.test(e))) return null;
    if (fromIndex < 0 || fromIndex >= exprs.length || toIndex < 0 || toIndex >= exprs.length) return null;
    const [moved] = exprs.splice(fromIndex, 1);
    exprs.splice(toIndex, 0, moved);
    clauses[0] = { kw: clauses[0].kw, content: prefix + exprs.join(', ') };
    return clauses.map(c => (c.content ? `${c.kw} ${c.content}` : c.kw)).join(' ').trim();
}

// --- Executable columns ------------------------------------------------------
// NOTE: Copy of EXECUTABLE_COLUMN_TYPES in src/executableColumns.ts, which this
// script cannot import; src/test/executableColumns.test.ts keeps them in sync.
const EXECUTABLE_COLUMN_TYPES = [
    { prefix: 'sql_', kind: 'dataViewer', label: 'Open in Data Viewer', action: 'Open this query in a new Data Viewer', confirm: false },
    { prefix: 'pgsql_', kind: 'statement', label: 'Run as Statement', action: 'Run this statement in the database session of this Data Viewer', confirm: true },
    { prefix: 'psql_', kind: 'psql', label: 'Send to psql Console', action: 'Send this to the psql console of the connection', confirm: true },
    { prefix: 'ps_', kind: 'powershell', label: 'Run in PowerShell', action: 'Run this command in a PowerShell terminal', confirm: true },
    { prefix: 'url_', kind: 'url', label: 'Open in Browser', action: 'Open this link in the browser', confirm: false },
    { prefix: 'file_', kind: 'file', label: 'Open File in Editor', action: 'Open this file in the editor', confirm: false },
    { prefix: 'copy_', kind: 'copy', label: 'Copy to Clipboard', action: 'Copy this value to the clipboard', confirm: false }
];

// The type a column name asks for through its prefix (in any letter case), or null.
function executableColumnType(name) {
    const lower = String(name == null ? '' : name).toLowerCase();
    return EXECUTABLE_COLUMN_TYPES.find(t => lower.startsWith(t.prefix) && lower.length > t.prefix.length) || null;
}

// The type of a result column whose values can be run, or null. Only a name the
// query gave — an alias or a computed column — counts: a stored table column that
// is merely called `url_slug` or `ps_number` and selected under its own name
// stays an ordinary column. `source` is the column's entry in columnSources.
function executableTypeOfColumn(name, source) {
    const type = executableColumnType(name);
    if (!type) return null;
    if (source && source.sourceColumn === name) return null;
    return type;
}

// The name a column gets for the type with `prefix`, or without a type for ''.
// A prefix the name already has is replaced rather than stacked, and an unnamed
// expression (`?column?`) is called `column`.
function executableColumnAlias(name, prefix) {
    let base = String(name == null ? '' : name);
    const current = executableColumnType(base);
    if (current) base = base.slice(current.prefix.length);
    if (base === '' || base === '?column?') base = 'column';
    return String(prefix || '') + base;
}

// The icon of what an executable column does.
function executableIcon(kind) {
    switch (kind) {
        case 'dataViewer': return icon('table');
        case 'psql':
        case 'powershell': return icon('terminal');
        case 'url': return icon('goto');
        case 'file': return icon('file');
        case 'copy': return icon('copy');
        default: return icon('run');
    }
}

// Key under which a value that ran is remembered: the same text in the same
// column stays marked across reloads, sorting and auto refresh.
function executableMarkKey(column, value) {
    return String(column) + '\u0000' + String(value);
}

// How a cell whose value ran is marked, from the outcome the extension reported
// and the time it came back; null for an outcome that leaves no mark (a link or
// a Data Viewer opened, a value copied, a run cancelled).
function executableMark(outcome, time) {
    if (!outcome) return null;
    const message = String(outcome.message || '').trim();
    switch (outcome.status) {
        case 'executed':
            return { status: 'executed', title: `Executed at ${time}: ${message} Click to run it again.` };
        case 'sent':
            return { status: 'executed', title: `${message.replace(/\.$/, '')} at ${time}. Click to send it again.` };
        case 'failed':
            return { status: 'failed', title: `Failed at ${time}: ${message} Click to try again.` };
        default:
            return null;
    }
}

// A copy of `sql` for finding its structure, offsets kept: comments become
// blanks, string literals and dollar-quoted bodies a run of `0` (a token that
// is never a name) and the inside of a quoted name a run of `_`, its quotes kept.
function maskSqlStructure(sql) {
    const src = String(sql == null ? '' : sql);
    const out = src.split('');
    const n = src.length;
    const fill = (from, to, ch) => {
        for (let k = Math.max(0, from); k < to && k < n; k++) {
            if (out[k] !== '\n' && out[k] !== '\r') out[k] = ch;
        }
    };
    let i = 0;
    while (i < n) {
        const c = src[i], c2 = src[i + 1];
        if (c === '-' && c2 === '-') {
            let j = i + 2;
            while (j < n && src[j] !== '\n') j++;
            fill(i, j, ' '); i = j; continue;
        }
        if (c === '/' && c2 === '*') {
            let j = i + 2, depth = 1;
            while (j < n && depth > 0) {
                if (src[j] === '/' && src[j + 1] === '*') { depth++; j += 2; }
                else if (src[j] === '*' && src[j + 1] === '/') { depth--; j += 2; }
                else j++;
            }
            fill(i, j, ' '); i = j; continue;
        }
        if (c === "'") {
            // The E of E'…' (and B, X, N, U&) belongs to its literal.
            const before = src[i - 1] || '', twoBefore = src[i - 2] || '';
            let from = i;
            if (/[eEbBxXnN]/.test(before) && !/[A-Za-z0-9_$]/.test(twoBefore)) from = i - 1;
            else if (before === '&' && /[uU]/.test(twoBefore) && !/[A-Za-z0-9_$]/.test(src[i - 3] || '')) from = i - 2;
            const escapes = from === i - 1 && /[eE]/.test(before);
            let j = i + 1;
            while (j < n) {
                if (escapes && src[j] === '\\') { j += 2; continue; }
                if (src[j] === "'") { if (src[j + 1] === "'") { j += 2; continue; } j++; break; }
                j++;
            }
            fill(from, j, '0'); i = j; continue;
        }
        if (c === '"') {
            let j = i + 1;
            while (j < n) {
                if (src[j] === '"') { if (src[j + 1] === '"') { j += 2; continue; } break; }
                j++;
            }
            fill(i + 1, j, '_'); i = j + 1; continue;
        }
        if (c === '$' && !/[A-Za-z0-9_$]/.test(src[i - 1] || '')) {
            const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 64));
            if (tag) {
                const close = src.indexOf(tag[0], i + tag[0].length);
                const j = close === -1 ? n : close + tag[0].length;
                fill(i, j, '0'); i = j; continue;
            }
        }
        i++;
    }
    return out.join('');
}

// Words, parentheses and semicolons of masked SQL, each with its nesting depth.
function sqlStructureTokens(masked) {
    const tokens = [];
    const re = /[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*|[();]/g;
    let depth = 0, m;
    while ((m = re.exec(masked)) !== null) {
        const text = m[0];
        if (text === '(') { tokens.push({ text, start: m.index, end: m.index + 1, depth }); depth++; continue; }
        if (text === ')') { depth = Math.max(0, depth - 1); tokens.push({ text, start: m.index, end: m.index + 1, depth }); continue; }
        tokens.push({ text, lower: text === ';' ? undefined : text.toLowerCase(), start: m.index, end: m.index + text.length, depth });
    }
    return tokens;
}

// Keywords that end the select list of a SELECT.
const SELECT_LIST_END_KEYWORDS = new Set([
    'from', 'into', 'where', 'group', 'having', 'window', 'order', 'limit', 'offset', 'fetch',
    'union', 'intersect', 'except', 'for'
]);

// Where the select list of the outermost SELECT — the one naming the result
// columns — lies in masked SQL, as { start, end, tokens, endToken }; null for a
// statement that is no SELECT or WITH … SELECT.
function findSelectListRange(masked) {
    const tokens = sqlStructureTokens(masked);
    const first = tokens[0];
    if (!first || first.depth !== 0 || (first.lower !== 'select' && first.lower !== 'with')) return null;
    let k = 0;
    for (; k < tokens.length; k++) {
        const t = tokens[k];
        if (t.depth !== 0) continue;
        if (t.text === ';' && k > 0) return null;
        if (t.lower === 'select') break;
        if (['insert', 'update', 'delete', 'merge', 'values', 'table'].indexOf(t.lower) !== -1) return null;
    }
    if (k >= tokens.length) return null;
    let start = tokens[k].end;
    k++;
    if (tokens[k] && tokens[k].lower === 'all') {
        start = tokens[k].end; k++;
    } else if (tokens[k] && tokens[k].lower === 'distinct') {
        start = tokens[k].end; k++;
        if (tokens[k] && tokens[k].lower === 'on' && tokens[k + 1] && tokens[k + 1].text === '(') {
            let m = k + 2;
            while (m < tokens.length && !(tokens[m].text === ')' && tokens[m].depth === 0)) m++;
            if (m >= tokens.length) return null;
            start = tokens[m].end; k = m + 1;
        }
    }
    let end = masked.length;
    let endToken = tokens.length;
    for (; k < tokens.length; k++) {
        const t = tokens[k];
        if (t.depth !== 0) continue;
        if (t.text === ';' || SELECT_LIST_END_KEYWORDS.has(t.lower)) { end = t.start; endToken = k; break; }
    }
    return { start, end, tokens, endToken };
}

// The items of a select list as [start, end) ranges without surrounding blanks,
// or null when one of them is empty (a stray comma).
function splitSelectItems(masked, range) {
    const items = [];
    const trimmed = (from, to) => {
        while (from < to && /\s/.test(masked[from])) from++;
        while (to > from && /\s/.test(masked[to - 1])) to--;
        return from < to ? { start: from, end: to } : null;
    };
    let depth = 0, from = range.start;
    for (let i = range.start; i < range.end; i++) {
        const ch = masked[i];
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth--;
        else if (ch === ',' && depth === 0) { items.push(trimmed(from, i)); from = i + 1; }
    }
    items.push(trimmed(from, range.end));
    return items.some(item => item === null) ? null : items;
}

// The name SQL gives an identifier token: a quoted name as written, any other
// folded to lower case.
function sqlIdentifierName(token) {
    const t = String(token || '');
    return t.length > 1 && t[0] === '"' && t[t.length - 1] === '"' ? t.slice(1, -1).replace(/""/g, '"') : t.toLowerCase();
}

const SQL_IDENT_MASKED = '(?:"_*"|[A-Za-z_\\u0080-\\uffff][A-Za-z0-9_$\\u0080-\\uffff]*)';

// Words after which the next word is an operand, never an alias.
const NO_ALIAS_AFTER = new Set([
    'and', 'or', 'not', 'is', 'in', 'like', 'ilike', 'similar', 'between', 'then', 'else', 'when', 'case',
    'distinct', 'collate', 'at', 'zone', 'over', 'escape', 'by', 'operator', 'interval', 'array', 'only'
]);
// Last words of type names, which follow a cast rather than name a column.
const TYPE_NAME_TAILS = new Set(['precision', 'varying', 'zone']);

// The name a select-list expression without an alias gives its column, as far
// as it can be told without a database: a column reference or a function call
// yields its name, a cast the name of what is cast; anything else null.
function implicitSelectItemName(sql, masked, start, end) {
    let exprEnd = end;
    // A cast keeps the name of what it casts.
    let depth = 0;
    for (let i = start; i < end - 1; i++) {
        const ch = masked[i];
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth--;
        else if (depth === 0 && ch === ':' && masked[i + 1] === ':') { exprEnd = i; break; }
    }
    while (exprEnd > start && /\s/.test(masked[exprEnd - 1])) exprEnd--;
    const text = masked.slice(start, exprEnd);
    const original = sql.slice(start, exprEnd);
    // The last part of a dotted name, splitting only at dots outside quotes.
    const lastPart = (dotted) => {
        const parts = dotted.split(/\s*\.\s*(?=(?:[^"]*"[^"]*")*[^"]*$)/);
        return sqlIdentifierName(parts[parts.length - 1].trim());
    };
    const columnRef = new RegExp(`^${SQL_IDENT_MASKED}(?:\\s*\\.\\s*${SQL_IDENT_MASKED})*$`);
    if (columnRef.test(text)) {
        return lastPart(original);
    }
    const call = new RegExp(`^(${SQL_IDENT_MASKED}(?:\\s*\\.\\s*${SQL_IDENT_MASKED})?)\\s*\\(`).exec(text);
    if (call && text.endsWith(')')) {
        // The call has to span the whole expression: its parenthesis closes at the end.
        let d = 0;
        for (let i = call[0].length - 1; i < text.length; i++) {
            if (text[i] === '(') d++;
            else if (text[i] === ')') { d--; if (d === 0 && i !== text.length - 1) return null; }
        }
        const name = lastPart(original.slice(0, call[1].length));
        return name === 'cast' ? null : name;
    }
    return null;
}

// One item of a select list: a wildcard (`*`, `t.*`) with its qualifier, or an
// expression with the alias it has (range in the SQL text), where the
// expression ends and the name of its result column (null when unknown).
function analyzeSelectItem(sql, masked, item, isReservedWord) {
    const text = masked.slice(item.start, item.end);
    const wildcard = new RegExp(`^((?:${SQL_IDENT_MASKED}\\s*\\.\\s*)*)\\*$`).exec(text);
    if (wildcard) {
        const qualifier = sql.slice(item.start, item.start + wildcard[1].length).replace(/\s*\.\s*$/, '').trim();
        return { wildcard: true, qualifier, start: item.start, end: item.end };
    }
    const plain = { wildcard: false, start: item.start, end: item.end, exprEnd: item.end, alias: null, name: null };
    // The last word of the item, if it is a name.
    let s = item.end;
    if (masked[s - 1] === '"') {
        s = masked.lastIndexOf('"', s - 2);
    } else {
        while (s > item.start && /[A-Za-z0-9_$\u0080-\uffff]/.test(masked[s - 1])) s--;
    }
    const lastWord = s >= item.start ? masked.slice(s, item.end) : '';
    const isName = lastWord !== '' && (lastWord[0] === '"' || /^[A-Za-z_\u0080-\uffff]/.test(lastWord));
    let alias = null;
    if (isName && s > item.start && /\s/.test(masked[s - 1])) {
        let p = s - 1;
        while (p > item.start && /\s/.test(masked[p])) p--;
        const prevChar = masked[p];
        const candidate = lastWord.toLowerCase();
        const quoted = lastWord[0] === '"';
        if (/[A-Za-z0-9_$\u0080-\uffff]/.test(prevChar)) {
            let w = p + 1;
            while (w > item.start && /[A-Za-z0-9_$\u0080-\uffff]/.test(masked[w - 1])) w--;
            const prevWord = masked.slice(w, p + 1).toLowerCase();
            if (prevWord === 'as') {
                let e = w;
                while (e > item.start && /\s/.test(masked[e - 1])) e--;
                alias = { start: s, end: item.end, exprEnd: e };
            } else if (!/^[0-9]/.test(prevWord)
                && (NO_ALIAS_AFTER.has(prevWord) || (isReservedWord(prevWord) && prevWord !== 'end'))) {
                alias = null;
            } else if (quoted || (!isReservedWord(candidate) && !TYPE_NAME_TAILS.has(candidate))) {
                alias = { start: s, end: item.end, exprEnd: p + 1 };
            }
        } else if ((prevChar === ')' || prevChar === '"' || prevChar === ']')
            && (quoted || (!isReservedWord(candidate) && !TYPE_NAME_TAILS.has(candidate)))) {
            alias = { start: s, end: item.end, exprEnd: p + 1 };
        }
    }
    if (alias) {
        plain.alias = { start: alias.start, end: alias.end };
        plain.exprEnd = alias.exprEnd;
        plain.name = sqlIdentifierName(sql.slice(alias.start, alias.end));
    } else {
        plain.name = implicitSelectItemName(sql, masked, item.start, item.end);
    }
    return plain;
}

// Apply text edits ({ start, end, text }) that do not overlap.
function applyTextEdits(text, edits) {
    return edits.slice().sort((a, b) => b.start - a.start)
        .reduce((out, e) => out.slice(0, e.start) + e.text + out.slice(e.end), text);
}

// Edits that rename a bare ORDER BY reference to the output column `oldName`;
// such a reference names the output column, so it has to follow its new name.
function orderByRenameEdits(sql, masked, range, oldName, newText) {
    const tokens = range.tokens;
    let k = range.endToken;
    for (; k < tokens.length - 1; k++) {
        const t = tokens[k];
        if (t.depth === 0 && t.lower === 'order' && tokens[k + 1].lower === 'by') break;
        if (t.depth === 0 && t.text === ';') return [];
    }
    if (k >= tokens.length - 1) return [];
    const from = tokens[k + 1].end;
    let to = masked.length;
    for (let m = k + 2; m < tokens.length; m++) {
        const t = tokens[m];
        if (t.depth === 0 && (t.text === ';' || ['limit', 'offset', 'fetch', 'for'].indexOf(t.lower) !== -1)) { to = t.start; break; }
    }
    const edits = [];
    const sortItems = splitSelectItems(masked, { start: from, end: to }) || [];
    const lead = new RegExp(`^${SQL_IDENT_MASKED}`);
    for (const item of sortItems) {
        const m = lead.exec(masked.slice(item.start, item.end));
        if (!m) continue;
        const after = masked.slice(item.start + m[0].length, item.end);
        if (after !== '' && !/^\s/.test(after)) continue;
        if (sqlIdentifierName(sql.slice(item.start, item.start + m[0].length)) === oldName) {
            edits.push({ start: item.start, end: item.start + m[0].length, text: newText });
        }
    }
    return edits;
}

// Rename the result column `target.name` — the column at `target.index` of a
// grid whose column names are `target.columns` — to `newName` in `sql`, and
// change nothing else: an alias is replaced, a missing one is added with AS, a
// lone `*` (or `t.*`) is spelled out as the column list, and a bare ORDER BY
// reference follows. `formatIdent` quotes a name where needed, `isReservedWord`
// knows the reserved keywords. Returns { sql } or { error }.
function renameSelectColumn(sql, target, newName, formatIdent, isReservedWord) {
    const source = String(sql == null ? '' : sql);
    const masked = maskSqlStructure(source);
    const range = findSelectListRange(masked);
    if (!range) {
        return { error: 'Only a column of a SELECT can be renamed, and the query bar holds no SELECT.' };
    }
    const items = splitSelectItems(masked, range);
    if (!items) {
        return { error: 'The select list of the query has an empty entry, so the column cannot be renamed.' };
    }
    const columns = Array.isArray(target.columns) ? target.columns : [];
    const sameName = columns.filter(c => c === target.name).length;
    if (sameName > 1) {
        return { error: `The result has ${sameName} columns named "${target.name}", so the one to rename is not clear. Give them different aliases first.` };
    }
    const reserved = typeof isReservedWord === 'function' ? isReservedWord : () => false;
    const analyzed = items.map(item => analyzeSelectItem(source, masked, item, reserved));
    const newText = formatIdent(newName);
    const orderBy = orderByRenameEdits(source, masked, range, target.name, newText);

    if (analyzed.length === 1 && analyzed[0].wildcard) {
        if (new Set(columns).size !== columns.length || target.index < 0 || target.index >= columns.length) {
            return { error: 'The * of the query cannot be spelled out into its columns, so the column cannot be renamed.' };
        }
        const qualifier = analyzed[0].qualifier ? analyzed[0].qualifier + '.' : '';
        const list = columns.map((c, i) => qualifier + formatIdent(c) + (i === target.index ? ' AS ' + newText : '')).join(', ');
        return { sql: applyTextEdits(source, [{ start: analyzed[0].start, end: analyzed[0].end, text: list }].concat(orderBy)) };
    }

    let item = null;
    const anyWildcard = analyzed.some(a => a.wildcard);
    // Up to the first wildcard, list entries and grid columns correspond one to one.
    const byPosition = anyWildcard
        ? !analyzed.slice(0, target.index + 1).some(a => a.wildcard)
        : analyzed.length === columns.length;
    if (byPosition && target.index >= 0) {
        const candidate = analyzed[target.index];
        if (candidate && !candidate.wildcard && (candidate.name === null || candidate.name === target.name)) {
            item = candidate;
        }
    }
    if (!item) {
        const named = analyzed.filter(a => !a.wildcard && a.name === target.name);
        if (named.length === 1) item = named[0];
    }
    if (!item) {
        return {
            error: anyWildcard
                ? `"${target.name}" comes from a * in the query. List it in the SELECT to rename it.`
                : `"${target.name}" was not found in the select list of the query. Run the query first if you have changed it.`
        };
    }
    const edit = item.alias
        ? { start: item.alias.start, end: item.alias.end, text: newText }
        : { start: item.exprEnd, end: item.exprEnd, text: ' AS ' + newText };
    return { sql: applyTextEdits(source, [edit].concat(orderBy)) };
}

// --- Virtual scrolling ---------------------------------------------------------
// The grid keeps only the rows near the visible part of the result in the DOM;
// two spacer rows of the right height stand in for the rest, so a result of
// tens of thousands of rows scrolls as lightly as one of fifty.

// The order the rows are shown in, as { kind: 'row' | 'insert' | 'dup', idx }:
// inserted and duplicated rows without an anchor first, then every displayed
// loaded row followed by those anchored to it, and last the ones whose anchor
// row is filtered out, so they are not lost.
function buildRenderPlan(displayedOrder, insertedRows, duplicatedRows) {
    const shown = new Set(displayedOrder);
    const byAnchor = new Map();
    const top = [];
    const orphans = [];
    const place = (anchor, entry) => {
        if (anchor == null) {
            top.push(entry);
        } else if (shown.has(anchor)) {
            if (!byAnchor.has(anchor)) byAnchor.set(anchor, []);
            byAnchor.get(anchor).push(entry);
        } else {
            orphans.push(entry);
        }
    };
    (insertedRows || []).forEach((e, i) => place(e.anchor, { kind: 'insert', idx: i }));
    (duplicatedRows || []).forEach((e, i) => place(e.anchor, { kind: 'dup', idx: i }));
    const plan = top;
    for (const idx of displayedOrder) {
        plan.push({ kind: 'row', idx });
        const anchored = byAnchor.get(idx);
        if (anchored) anchored.forEach(e => plan.push(e));
    }
    orphans.forEach(e => plan.push(e));
    return plan;
}

// Where row `index` starts, with every row `rowHeight` high except those in
// `extras` ({ index, extra }, sorted by index), which are `extra` px taller.
function virtualRowOffset(index, rowHeight, extras) {
    let offset = index * rowHeight;
    for (const e of extras || []) {
        if (e.index >= index) break;
        offset += e.extra;
    }
    return offset;
}

// The row at `offset`, counted like virtualRowOffset; clamped to the rows there are.
function virtualRowAt(offset, rowHeight, extras, total) {
    if (!(total > 0)) return 0;
    let base = 0;
    let baseIndex = 0;
    for (const e of extras || []) {
        const rowTop = base + (e.index - baseIndex) * rowHeight;
        if (offset < rowTop) break;
        const rowBottom = rowTop + rowHeight + e.extra;
        if (offset < rowBottom) return Math.min(total - 1, e.index);
        base = rowBottom;
        baseIndex = e.index + 1;
    }
    const index = baseIndex + Math.floor(Math.max(0, offset - base) / rowHeight);
    return Math.max(0, Math.min(total - 1, index));
}

// The rows to put into the DOM for a scroll position: those in view
// (visibleStart … visibleEnd, end exclusive) and `buffer` rows on either side.
function virtualWindow(o) {
    const total = Math.max(0, Number(o.total) || 0);
    if (total === 0) return { start: 0, end: 0, visibleStart: 0, visibleEnd: 0 };
    const rowHeight = o.rowHeight > 0 ? o.rowHeight : 24;
    const top = Math.max(0, Number(o.scrollTop) || 0);
    const first = virtualRowAt(top, rowHeight, o.extras, total);
    const last = virtualRowAt(top + Math.max(0, Number(o.viewportHeight) || 0), rowHeight, o.extras, total);
    const buffer = Math.max(0, Number(o.buffer) || 0);
    return {
        visibleStart: first,
        visibleEnd: last + 1,
        start: Math.max(0, first - buffer),
        end: Math.min(total, last + 1 + buffer)
    };
}

// Whether a rowsLoaded answer is followed by the relation metadata
// (foreignKeysLoaded / referencingTablesLoaded). The host sends it only after
// a fresh result: neither a "Load More" page nor an auto refresh, which re-runs
// the same query, loads it again.
function expectsRelationMetadata(msg, sourceTable) {
    if (!msg || msg.append || msg.autoRefresh) {
        return false;
    }
    return Boolean(sourceTable);
}

// Decide whether a data-load message replaces the current rows wholesale (a
// fresh first page or a re-run query) rather than appending a "Load More" page.
// Fresh loads must discard pending edits, since those edits are keyed by a
// 0-based row index that would otherwise be re-applied to unrelated new rows.
function isFreshRowLoad(offset, isAppend) {
    if (isAppend) {
        return false;
    }
    return (offset || 0) <= 0;
}

// The `readonly` attribute for a Single Record View field. A field is
// non-editable when its row is marked for deletion or when the whole view is
// read-only (e.g. an ad-hoc custom-query result that cannot be written back).
function recordFieldReadonlyAttr(isDeleted, readOnly) {
    return (isDeleted || readOnly) ? 'readonly' : '';
}

// Whether a click on a dialog's backdrop should close the dialog. A press
// inside the dialog that is released over the backdrop (resizing a text box,
// selecting text) still fires a `click` on the backdrop, the nearest element
// containing both ends, so it only counts when the press began there too.
function isBackdropDismissClick(overlay, pressTarget, clickTarget) {
    return !!overlay && pressTarget === overlay && clickTarget === overlay;
}

// --- Auto refresh ------------------------------------------------------------
// Preset intervals (seconds) of the toolbar's auto refresh control; 0 is off.
const AUTO_REFRESH_PRESETS = [0, 1, 5, 10, 30, 60, 300];

// `45 s`, `2 min`, `1 min 30 s`, `1 h 30 min`. Same rule as
// formatAutoRefreshInterval in src/autoRefresh.ts, which parses it back.
function formatAutoRefreshInterval(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const parts = [];
    if (h) parts.push(h + ' h');
    if (m) parts.push(m + ' min');
    if (s || parts.length === 0) parts.push(s + ' s');
    return parts.join(' ');
}

// Entries of the auto refresh drop-down: Off, the presets, a custom interval in
// use (in order of length) and the entry that asks for a new one.
function autoRefreshOptions(currentSeconds) {
    const current = Math.max(0, Math.round(Number(currentSeconds) || 0));
    const values = AUTO_REFRESH_PRESETS.slice();
    if (current > 0 && values.indexOf(current) < 0) {
        values.push(current);
        values.sort((a, b) => a - b);
    }
    const options = values.map(v => ({
        value: String(v),
        label: v === 0 ? 'Off' : 'Every ' + formatAutoRefreshInterval(v)
    }));
    options.push({ value: 'custom', label: 'Custom interval' });
    return options;
}

// What an auto refresh runs: the last executed query again, with as many rows
// as are loaded now (at least one page), so neither the scroll position nor
// rows fetched with "More" / "All" are lost. A query with its own LIMIT runs
// exactly as written. `limit` is null when the result is not paged.
function autoRefreshLoadPlan(state) {
    const s = state || {};
    const pageSize = Math.max(1, Number(s.pageSize) || 50);
    if (s.userPaged) return { sql: String(s.lastRawSql || ''), limit: null };
    const base = String(s.currentSql || '');
    if (s.allLoaded) return { sql: base, limit: null };
    const limit = Math.max(pageSize, Math.round(Number(s.loadedRows) || 0));
    return { sql: base + ' LIMIT ' + limit + ' OFFSET 0', limit };
}

// Why a due auto refresh does not run now: '' when it may run. 'busy' covers
// short-lived states (a query running, a dialog or cell editor open, a drag);
// the tick is retried shortly after instead of waiting for the next interval.
function autoRefreshPauseReason(state) {
    const s = state || {};
    if (!s.hasQuery) return 'noQuery';
    if (s.visible === false) return 'hidden';
    if (s.pendingChanges) return 'pendingChanges';
    if (s.busy) return 'busy';
    return '';
}

// Status shown next to the auto refresh control for a lasting pause.
const AUTO_REFRESH_PAUSE_LABELS = {
    hidden: 'Paused while the tab is hidden',
    pendingChanges: 'Paused until changes are saved or discarded',
    notConnected: 'Paused: not connected'
};

// Whether any undo step holds a grid edit. Those are keyed by row index and must
// not survive a refresh that replaced the rows; query-text steps may.
function editHistoryHasGridEdits(history) {
    const size = v => (v instanceof Map || v instanceof Set) ? v.size : (Array.isArray(v) ? v.length : 0);
    return (history || []).some(snap => !!snap && (
        size(snap.modified) > 0 || size(snap.deleted) > 0 ||
        size(snap.inserted) > 0 || size(snap.duplicated) > 0
    ));
}

// Height of the empty space after the last field of the Single Record View, so
// the body can scroll until the last field sits where the first one starts.
// `clientHeight` includes the body's padding; a last field taller than the
// visible area needs no extra space.
function recordScrollTailHeight(clientHeight, paddingTop, paddingBottom, lastRowHeight) {
    const visible = (Number(clientHeight) || 0) - (Number(paddingTop) || 0) - (Number(paddingBottom) || 0);
    return Math.max(0, Math.floor(visible - (Number(lastRowHeight) || 0)));
}

// What to do with a value that comes back from an editor tab a cell was opened
// in. The result may arrive long after the tab was opened, so the target cell
// can have disappeared (data reloaded, column removed) or have become
// non-editable in the meantime.
function cellEditorTargetState(hasRow, hasColumn, isEditable) {
    if (!hasRow || !hasColumn) return 'stale';
    if (!isEditable) return 'readonly';
    return 'apply';
}

// A stable text form of all values of one loaded row.
function rowFingerprint(row) {
    if (!row || typeof row !== 'object') return '';
    const keys = Object.keys(row).filter(k => k !== '_originalIndex').sort();
    return JSON.stringify(keys.map(k => [k, row[k] === undefined ? null : row[k]]));
}

// The allRows index a value saved in a cell editor tab belongs to, or -1. The
// row at the remembered index is used only while it still holds the values the
// tab was opened from; otherwise (rows reloaded, panel reopened) the row is
// looked up by its values, and a row that is gone, was changed or is no longer
// unique yields -1 instead of a wrong row.
function resolveCellEditorRow(rows, rowIdx, token) {
    const list = Array.isArray(rows) ? rows : [];
    if (!token || typeof token !== 'object') return list[rowIdx] ? rowIdx : -1;
    if (list[rowIdx] && rowFingerprint(list[rowIdx]) === token.fingerprint) return rowIdx;
    let found = -1;
    for (let i = 0; i < list.length; i++) {
        if (rowFingerprint(list[i]) !== token.fingerprint) continue;
        if (found !== -1) return -1;
        found = i;
    }
    return found;
}

// True when WHERE clauses can be merged into the current view's query and the
// query re-run. The query bar always holds the SQL that produced the current
// result, so this only requires a non-empty query.
function canApplyQueryFilters(sql) {
    return !!(sql && String(sql).trim());
}

// True when actions bound to a concrete table (permanent constraints, custom
// column mappings) are available. A result that cannot be traced back to a
// single table has nothing to attach them to, so those affordances are hidden.
function canManageTableMetadata(schema, table, readOnly) {
    return !readOnly && !!schema && !!table;
}

// Table name pre-filled for the INSERT export. A custom-query result has no
// source table, so a neutral placeholder is used instead of an empty name.
function defaultInsertTableName(tableReference) {
    return tableReference || 'exported_data';
}

// Compute the connection badge state shown in the Data Viewer toolbar. The
// badge is always clickable (to switch connection); `lastUsedConnection` is the
// connection the displayed rows came from and `currentConnection` is the now
// active one. Returns { text, warn, title }.
function buildConnectionBadge(lastUsedConnection, currentConnection) {
    const hint = ' (click to switch connection)';
    if (!lastUsedConnection && !currentConnection) {
        return {
            text: 'Select Connection',
            warn: false,
            title: 'Click to choose a database connection'
        };
    }
    const last = lastUsedConnection || '(none)';
    if (currentConnection && lastUsedConnection && currentConnection !== lastUsedConnection) {
        return {
            text: `⚠ ${last} → ${currentConnection}`,
            warn: true,
            title: `Data was loaded from "${last}". Active connection is now "${currentConnection}".` + hint
        };
    }
    return {
        text: last,
        warn: false,
        title: `Connection used for the currently displayed data: ${last}` + hint
    };
}

// Text and tooltip of the badge naming the database session a panel's queries
// run on: its own, or the one of the SQL file or tab it was opened from.
// Returns null when the host sent no session.
function buildSessionBadge(info) {
    if (!info || typeof info !== 'object') return null;
    const label = String(info.label || '');
    const own = Boolean(info.own) || !label;
    const open = Boolean(info.open);
    const sharedWith = Number(info.sharedWith) > 0 ? Math.floor(Number(info.sharedWith)) : 0;
    const pid = Number.isInteger(info.pid) && info.pid > 0 ? info.pid : null;
    const owner = own
        ? 'Queries of this Data Viewer run on its own database session'
        : `Queries of this Data Viewer run on the database session of "${label}"`;
    const shared = sharedWith > 0 ? `, shared with ${sharedWith} other ${sharedWith === 1 ? 'tab' : 'tabs'}.` : '.';
    const state = !open
        ? 'It connects with the next query.'
        : (pid !== null ? `Connected as server process ${pid}.` : 'Connected.');
    return {
        text: own ? 'Own session' : `Session: ${label}`,
        title: `${owner}${shared} ${state} Settings made with SET or set_config stay until the session ends. Click to reset the session.`,
        open
    };
}

// Predicate for local (in-memory) row filtering. Returns true when `cellVal`
// passes the given column filter. A filter that cannot constrain the data
// (empty range, invalid number) matches every row.
function rowValueMatchesFilter(cellVal, filterVal, filterType, mode, thousandSeparator) {
    if (typeof filterVal === 'object' && filterVal !== null && filterVal.from !== undefined) {
        const from = filterVal.from;
        const to = filterVal.to;
        if (!from && !to) return true;
        if (filterType === 'numeric') {
            const fromLit = from ? toNumericLiteral(normalizeFilterInputValue(from, 'numeric', thousandSeparator)) : null;
            const toLit = to ? toNumericLiteral(normalizeFilterInputValue(to, 'numeric', thousandSeparator)) : null;
            if ((from && fromLit === null) || (to && toLit === null)) return true;
            if (cellVal === null || cellVal === undefined || cellVal === '' || isNaN(Number(cellVal))) return false;
            // Compared digit by digit, so bigint values beyond 2^53 stay exact.
            if (fromLit !== null && compareNumericText(cellVal, fromLit) < 0) return false;
            if (toLit !== null && compareNumericText(cellVal, toLit) > 0) return false;
            return true;
        }
        if (cellVal === null || cellVal === undefined) return false;
        const val = String(cellVal);
        if (from && to) return val >= from && val <= to;
        if (from) return val >= from;
        return val <= to;
    }

    if ((filterType === 'numeric' || filterType === 'date') && mode && mode !== 'equals') {
        if (cellVal === null || cellVal === undefined) return false;
        const normalizedFilterVal = normalizeFilterInputValue(filterVal, filterType, thousandSeparator);
        let cmp;
        if (filterType === 'numeric') {
            if (toNumericLiteral(normalizedFilterVal) === null) return true;
            if (isNaN(Number(cellVal))) return false;
            cmp = compareNumericText(cellVal, normalizedFilterVal);
        } else {
            const a = String(cellVal);
            const b = String(normalizedFilterVal);
            cmp = a < b ? -1 : a > b ? 1 : 0;
        }
        switch (mode) {
            case 'not_equals': return cmp !== 0;
            case 'gt': return cmp > 0;
            case 'gte': return cmp >= 0;
            case 'lt': return cmp < 0;
            case 'lte': return cmp <= 0;
            default: return cmp === 0;
        }
    }

    if (cellVal === null || cellVal === undefined) return false;
    return String(cellVal).toLowerCase().includes(String(filterVal).toLowerCase());
}

// True when an answer belongs to a load the panel has since replaced. Answers
// without an id (from older hosts or other paths) are never treated as stale.
function isStaleLoadAnswer(msgLoadId, latestLoadId) {
    return typeof msgLoadId === 'number' && msgLoadId !== latestLoadId;
}

// The SQL an export runs: the last executed query (never unsaved query-bar
// text). Without a user-written LIMIT that is the query minus the paging LIMIT
// the grid appended; with one, the query exactly as run.
function exportQuerySql(lastRunRawSql, currentBaseSql, userPaged) {
    const raw = String(lastRunRawSql || '').trim();
    if (!raw) return '';
    return userPaged ? raw : String(currentBaseSql || raw).trim();
}

// Comparator for sorting two cell values. Nulls always sort last. `direction`
// is 'asc' or 'desc'. `numeric` marks a numeric column: node-pg returns int8
// and numeric as strings, which must not be ordered as text.
function compareCellValues(valA, valB, direction, numeric) {
    if (valA === null) return 1;
    if (valB === null) return -1;
    if (numeric || (typeof valA === 'number' && typeof valB === 'number')) {
        const cmp = compareNumericText(valA, valB);
        return direction === 'asc' ? cmp : -cmp;
    }
    const cmp = String(valA).localeCompare(String(valB));
    return direction === 'asc' ? cmp : -cmp;
}

// Split a plain decimal ("-0012.340") into sign, integer digits and fraction
// digits without leading/trailing zeros, or null for anything else (NaN,
// Infinity, exponent notation).
function parseDecimalText(value) {
    if (typeof value === 'number' && !isFinite(value)) return null;
    const m = /^\s*([+-]?)(\d*)(?:\.(\d*))?\s*$/.exec(String(value));
    if (!m || (m[2] === '' && !m[3])) return null;
    const int = m[2].replace(/^0+/, '');
    const frac = (m[3] || '').replace(/0+$/, '');
    return { neg: m[1] === '-' && (int !== '' || frac !== ''), int, frac };
}

// Exact numeric ordering of two values that may be numbers or numeric strings
// of any length (bigint, numeric). Returns <0, 0 or >0. Values that are not
// plain decimals fall back to Number(), and NaN sorts above every number as in
// PostgreSQL.
function compareNumericText(a, b) {
    const pa = parseDecimalText(a);
    const pb = parseDecimalText(b);
    if (!pa || !pb) {
        const na = Number(a);
        const nb = Number(b);
        if (isNaN(na) || isNaN(nb)) return (isNaN(na) ? 1 : 0) - (isNaN(nb) ? 1 : 0);
        return na < nb ? -1 : na > nb ? 1 : 0;
    }
    if (pa.neg !== pb.neg) return pa.neg ? -1 : 1;
    let mag;
    if (pa.int.length !== pb.int.length) {
        mag = pa.int.length < pb.int.length ? -1 : 1;
    } else if (pa.int !== pb.int) {
        mag = pa.int < pb.int ? -1 : 1;
    } else {
        const len = Math.max(pa.frac.length, pb.frac.length);
        const fa = pa.frac.padEnd(len, '0');
        const fb = pb.frac.padEnd(len, '0');
        mag = fa < fb ? -1 : fa > fb ? 1 : 0;
    }
    return pa.neg ? -mag : mag;
}

// Normalize a raw edited cell value into the canonical string stored in the
// change set. Numeric columns are trimmed and reformatted; text columns keep
// their leading/trailing whitespace so that values with significant spaces
// (e.g. " foo") are not silently altered merely by focusing and blurring a cell.
function normalizeCellInput(rawText, isNumeric, thousandSeparator) {
    const raw = rawText || '';
    if (isNumeric) {
        const trimmed = raw.trim();
        return trimmed === '' ? '' : normalizeNumericInput(trimmed, thousandSeparator);
    }
    return raw;
}

// Value range of the Postgres integer types, as strings because bigint does
// not fit into a JS number.
const PG_INTEGER_RANGES = {
    'smallint': ['-32768', '32767'],
    'int2': ['-32768', '32767'],
    'integer': ['-2147483648', '2147483647'],
    'int': ['-2147483648', '2147483647'],
    'int4': ['-2147483648', '2147483647'],
    'bigint': ['-9223372036854775808', '9223372036854775807'],
    'int8': ['-9223372036854775808', '9223372036854775807']
};

// Split a type as reported by the database (`format_type`) into the parts a
// value has to satisfy: 'character varying(5)' -> { base: 'character varying',
// length: 5 }, 'numeric(10,2)' -> { base: 'numeric', precision: 10, scale: 2 }.
function parsePgType(fullType) {
    const raw = String(fullType || '').trim().toLowerCase();
    if (!raw) return { base: '', isArray: false };
    const isArray = /\[\s*\]\s*$/.test(raw);
    const withoutArray = raw.replace(/(\s*\[\s*\])+\s*$/, '');
    const match = withoutArray.match(/^(.*?)\s*\((\d+)(?:\s*,\s*(\d+))?\)\s*$/);
    if (!match) {
        return { base: withoutArray, isArray };
    }
    const base = match[1];
    const first = parseInt(match[2], 10);
    const second = match[3] === undefined ? undefined : parseInt(match[3], 10);
    if (base === 'numeric' || base === 'decimal') {
        return { base, isArray, precision: first, scale: second === undefined ? 0 : second };
    }
    return { base, isArray, length: first };
}

// Compare two integers given as digit strings (may exceed Number precision).
function compareIntegerStrings(a, b) {
    const left = BigInt(a);
    const right = BigInt(b);
    return left < right ? -1 : (left > right ? 1 : 0);
}

// The date/time family of a Postgres base type, or '' for anything else.
function pgDateTimeKind(baseType) {
    const b = String(baseType || '').toLowerCase();
    if (b === 'date') return 'date';
    if (b.indexOf('timestamp') === 0) return 'timestamp';
    return '';
}

// Convert a European dotted date/time string (`DD.MM.YYYY [HH:mm[:ss]]`) — the
// shape a spreadsheet writes in a German (or similar) locale — into the ISO form
// Postgres parses unambiguously. A `date` column keeps only the date part, a
// `timestamp` column keeps the time (defaulting to midnight). Anything that is
// not this dotted shape (an already-ISO value, a plain time, other text) is
// returned unchanged, so only clearly localized dates are rewritten.
function localizedDateToIso(value, baseType) {
    const kind = pgDateTimeKind(baseType);
    if (!kind) return value;
    const text = String(value == null ? '' : value).trim();
    const m = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!m) return value;
    const pad = (n, w) => String(n).padStart(w, '0');
    let year = parseInt(m[3], 10);
    if (m[3].length <= 2) { year += year < 70 ? 2000 : 1900; }
    const month = Number(m[2]);
    const day = Number(m[1]);
    // Keep an impossible day/month failing loudly instead of silently shifting it.
    if (month < 1 || month > 12 || day < 1 || day > 31) return value;
    const datePart = `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
    if (kind === 'date' || m[4] === undefined) return datePart;
    const timePart = `${pad(m[4], 2)}:${pad(m[5], 2)}:${pad(m[6] === undefined ? 0 : m[6], 2)}`;
    return `${datePart} ${timePart}`;
}

// Check an entered cell value against the column type the database reported.
// Returns 'valid', 'invalid' (with a reason to show on the cell) or 'unknown'
// for every type whose text format only Postgres itself can judge (dates,
// timestamps, intervals, JSON, enums, domains, ...) - the caller then asks the
// database. Arrays and NULL are never judged here.
function validateCellValue(value, fullType) {
    if (value === null || value === undefined || value === '') {
        return { state: 'valid' };
    }
    const text = String(value);
    const type = parsePgType(fullType);
    if (!type.base || type.isArray) {
        return { state: 'unknown' };
    }

    const range = PG_INTEGER_RANGES[type.base];
    if (range) {
        if (!/^[+-]?\d+$/.test(text.trim())) {
            return { state: 'invalid', reason: `"${text}" is not a whole number (${type.base})` };
        }
        const digits = text.trim();
        if (compareIntegerStrings(digits, range[0]) < 0 || compareIntegerStrings(digits, range[1]) > 0) {
            return { state: 'invalid', reason: `${digits} is out of range for ${type.base} (${range[0]} … ${range[1]})` };
        }
        return { state: 'valid' };
    }

    if (type.base === 'numeric' || type.base === 'decimal') {
        const trimmed = text.trim();
        if (/^[+-]?(nan|infinity)$/i.test(trimmed)) {
            return { state: 'valid' };
        }
        const num = trimmed.match(/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/);
        if (!num) {
            return { state: 'invalid', reason: `"${text}" is not a valid ${type.base} value` };
        }
        if (type.precision !== undefined && !/[eE]/.test(trimmed)) {
            const intDigits = trimmed.replace(/^[+-]/, '').split('.')[0].replace(/^0+(?=\d)/, '');
            const allowed = type.precision - (type.scale || 0);
            if (intDigits !== '0' && intDigits.length > allowed) {
                return { state: 'invalid', reason: `Too large for numeric(${type.precision},${type.scale || 0}): at most ${allowed} digit(s) before the decimal point` };
            }
        }
        return { state: 'valid' };
    }

    if (type.base === 'real' || type.base === 'double precision' || type.base === 'float4' || type.base === 'float8') {
        const trimmed = text.trim();
        if (/^[+-]?(nan|infinity)$/i.test(trimmed)) {
            return { state: 'valid' };
        }
        if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
            return { state: 'invalid', reason: `"${text}" is not a valid ${type.base} value` };
        }
        return { state: 'valid' };
    }

    if (type.base === 'character varying' || type.base === 'varchar' ||
        type.base === 'character' || type.base === 'char' || type.base === 'bpchar') {
        if (type.length !== undefined && Array.from(text).length > type.length) {
            return { state: 'invalid', reason: `Too long for ${type.base}(${type.length}): ${Array.from(text).length} characters` };
        }
        return { state: 'valid' };
    }

    if (type.base === 'text' || type.base === 'name' || type.base === 'citext') {
        return { state: 'valid' };
    }

    if (type.base === 'boolean' || type.base === 'bool') {
        if (!/^(t|f|true|false|y|n|yes|no|on|off|1|0)$/i.test(text.trim())) {
            return { state: 'invalid', reason: `"${text}" is not a boolean value` };
        }
        return { state: 'valid' };
    }

    if (type.base === 'uuid') {
        if (!/^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i.test(text.trim())) {
            return { state: 'invalid', reason: `"${text}" is not a valid uuid` };
        }
        return { state: 'valid' };
    }

    return { state: 'unknown' };
}

// Share of the length a value may reach before the counter warns.
const CHAR_BUDGET_WARNING_RATIO = 0.8;

// How much of a length-limited column a value uses, for the counter shown
// while editing. Returns null for every type without a character limit
// (`text`, `varchar` without length, numbers, arrays), so the caller can omit
// the counter entirely. Characters are counted the way Postgres counts them
// for the length limit, not bytes.
function describeCharacterBudget(value, fullType) {
    const type = parsePgType(fullType);
    const limited = ['character varying', 'varchar', 'character', 'char', 'bpchar'];
    if (type.isArray || type.length === undefined || limited.indexOf(type.base) === -1) {
        return null;
    }
    const used = (value === null || value === undefined) ? 0 : Array.from(String(value)).length;
    const limit = type.length;
    const remaining = limit - used;
    if (remaining < 0) {
        return { used, limit, remaining, state: 'exceeded', text: `${used} / ${limit} · ${-remaining} over` };
    }
    const state = used >= limit * CHAR_BUDGET_WARNING_RATIO ? 'warning' : 'normal';
    return { used, limit, remaining, state, text: `${used} / ${limit} · ${remaining} left` };
}

// CSS class suffix for the character counter, so a value close to or beyond
// the column length stands out.
function charBudgetStateClass(budget) {
    if (!budget || budget.state === 'normal') return '';
    return budget.state === 'exceeded' ? ' is-exceeded' : ' is-warning';
}

// Context-dependent keywords that stand on their own, without parentheses.
const VOLATILE_DEFAULT_KEYWORDS = /\b(current_date|current_time|current_timestamp|localtime|localtimestamp|current_user|session_user|current_role|user)\b/i;

// Any call, qualified or not: now(), nextval(...), oracle.sysdate().
const FUNCTION_CALL_PATTERN = /[A-Za-z_][A-Za-z0-9_$]*\s*(?:\.\s*[A-Za-z_][A-Za-z0-9_$]*\s*)*\(/;

// Drop string literals and casts before looking for a call — 'user'::text and
// '0'::numeric(10,2) would otherwise read as a keyword and as a call.
function stripDefaultNoise(expression) {
    return expression
        .replace(/'(?:[^']|'')*'/g, "''")
        .replace(/::\s*[A-Za-z_][A-Za-z0-9_ ]*(\s*\([^)]*\))?(\s*\[\s*\])*/g, '');
}

// 'generated' (identity / GENERATED ALWAYS AS), 'volatile' (a new value per
// row), 'constant' (a fixed default worth copying) or null when the column has
// no default at all.
function classifyColumnDefault(info) {
    if (!info) return null;
    if (info.isIdentity || info.isGenerated) return 'generated';
    const expression = typeof info.defaultExpression === 'string' ? info.defaultExpression.trim() : '';
    if (!expression) return null;
    const bare = stripDefaultNoise(expression);
    const isVolatile = VOLATILE_DEFAULT_KEYWORDS.test(bare) || FUNCTION_CALL_PATTERN.test(bare);
    return isVolatile ? 'volatile' : 'constant';
}

// Which columns a duplicated row leaves to the database, for the configured
// mode: 'volatile' (default), 'all' or 'none'.
function defaultResetColumns(columnDefaults, mode) {
    if (mode === 'none' || !Array.isArray(columnDefaults)) return [];
    return columnDefaults
        .filter(info => {
            const kind = classifyColumnDefault(info);
            return kind !== null && (mode === 'all' || kind !== 'constant');
        })
        .map(info => info.column);
}

// Tooltip explaining why a duplicated cell was not copied.
function defaultCellTitle(info) {
    const kind = classifyColumnDefault(info);
    if (kind === 'generated') {
        return 'Generated by the database on save';
    }
    const expression = info && typeof info.defaultExpression === 'string' ? info.defaultExpression.trim() : '';
    return expression
        ? `Filled by the database on save (${expression})`
        : 'Filled by the database on save';
}

// Text and button state of the pending-changes indicator. Saving is blocked
// while a cell holds a value the column cannot store.
function describePendingChanges(counts, invalidCount) {
    const c = counts || {};
    const parts = [];
    if (c.modified > 0) parts.push(`${c.modified} modified`);
    if (c.inserted > 0) parts.push(`${c.inserted} inserted`);
    if (c.duplicated > 0) parts.push(`${c.duplicated} duplicated`);
    if (c.deleted > 0) parts.push(`${c.deleted} deleted`);
    const invalid = invalidCount || 0;
    if (parts.length === 0) {
        return { text: 'No pending changes', canCommit: false, canDiscard: false };
    }
    if (invalid > 0) {
        return {
            text: `Pending: ${parts.join(', ')} — ${invalid} invalid value${invalid === 1 ? '' : 's'}`,
            canCommit: false,
            canDiscard: true
        };
    }
    return { text: `Pending: ${parts.join(', ')}`, canCommit: true, canDiscard: true };
}

// Build the set of column/value pairs that uniquely identifies a row for an
// UPDATE/DELETE WHERE clause. Tables with a primary key use only the PK
// columns. Tables WITHOUT a primary key fall back to matching every column of
// the row, so edits and deletes still target the correct row(s) instead of
// producing an empty WHERE clause (which would fail or affect all rows).
//
// `columnNames` is the ordered list of all column names; `row` is the source
// row object. NULL values are kept in the identity so the caller can emit
// `IS NULL` for them.
function buildRowIdentity(primaryKeys, columnNames, row) {
    const id = {};
    const keys = (primaryKeys && primaryKeys.length > 0) ? primaryKeys : (columnNames || []);
    keys.forEach(col => {
        id[col] = row ? row[col] : undefined;
    });
    return id;
}

// Capabilities of a result that could not be traced back to any table: the
// grid is shown read-only until the extension reports something better.
function emptyCapabilities() {
    return {
        canEdit: false,
        canInsert: false,
        canDelete: false,
        canConstrain: false,
        canMap: false,
        schema: null,
        table: null,
        identityStrategy: 'none',
        tables: [],
        columnSources: {},
        editableColumns: [],
        warning: null
    };
}

// Merge the capabilities reported by the extension with the defaults so a
// partial or missing payload cannot leave the view in an inconsistent state.
function normalizeCapabilities(raw) {
    const base = emptyCapabilities();
    if (!raw || typeof raw !== 'object') {
        return base;
    }
    return {
        canEdit: !!raw.canEdit,
        canInsert: !!raw.canInsert,
        canDelete: !!raw.canDelete,
        canConstrain: !!raw.canConstrain,
        canMap: !!raw.canMap,
        schema: raw.schema || null,
        table: raw.table || null,
        identityStrategy: raw.identityStrategy || 'none',
        tables: Array.isArray(raw.tables) ? raw.tables : [],
        columnSources: raw.columnSources || {},
        editableColumns: Array.isArray(raw.editableColumns) ? raw.editableColumns : [],
        warning: raw.warning || null
    };
}

// Key of the table occurrence a column or plan belongs to. A table joined in
// twice carries the alias, because its two rows must not share one identity.
function sourceInstanceKey(source) {
    if (!source) { return ''; }
    return source.qualifier ? source.tableOid + ':' + source.qualifier : String(source.tableOid);
}

// Group the pending edits of the grid by the table each edited column really
// belongs to, so a result joined from several tables writes every change back
// to its own table within one transaction.
//
// `edits.updates` is a list of `[rowIndex, { resultColumn: newValue }]` pairs,
// `edits.deletes` a list of row indices and `edits.inserts` a list of new row
// objects keyed by result column name. Rows are identified through the identity
// columns of the respective table (its primary key when available).
function buildCommitTargets(caps, rows, edits) {
    const capabilities = normalizeCapabilities(caps);
    const sources = capabilities.columnSources;
    const tables = capabilities.tables;
    const planFor = (key) => tables.find(t => sourceInstanceKey(t) === key) || null;
    const targets = new Map();

    function targetFor(plan) {
        const key = sourceInstanceKey(plan);
        if (!targets.has(key)) {
            targets.set(key, {
                tableOid: plan.tableOid,
                schema: plan.schema,
                table: plan.table,
                identityStrategy: plan.identityStrategy,
                changes: { updates: [], inserts: [], deletes: [] }
            });
        }
        return targets.get(key);
    }

    function identityFor(plan, row) {
        const id = {};
        (plan.identityColumns || []).forEach(col => {
            id[col.sourceColumn] = row ? row[col.name] : undefined;
        });
        return id;
    }

    // An outer join that found no partner leaves every column of that table
    // empty: there is no row to update, so the change becomes a plain INSERT.
    // All displayed columns are checked, not only the identity, which leaves
    // out json/xml/geometric columns; and a single-table result only ever
    // shows real rows.
    function rowIsMissing(plan, row) {
        if (!row || tables.length < 2) { return false; }
        // The identity may be a hidden key column that `columns` does not list.
        const cols = [...(plan.columns || []), ...(plan.identityColumns || [])];
        if (cols.length === 0) { return false; }
        return cols.every(col => row[col.name] === null || row[col.name] === undefined);
    }

    (edits.updates || []).forEach(([rowIdx, changed]) => {
        const row = (rows || [])[rowIdx];
        const perTable = new Map();
        Object.keys(changed || {}).forEach(colName => {
            const source = sources[colName];
            if (!source) { return; }
            const key = sourceInstanceKey(source);
            if (!perTable.has(key)) { perTable.set(key, {}); }
            perTable.get(key)[source.sourceColumn] = changed[colName];
        });
        perTable.forEach((changes, key) => {
            const plan = planFor(key);
            if (!plan || plan.identityStrategy === 'none') { return; }
            const target = targetFor(plan);
            if (rowIsMissing(plan, row)) {
                target.changes.inserts.push(changes);
                target.missingRowInserts = (target.missingRowInserts || 0) + 1;
                return;
            }
            target.changes.updates.push({ primaryKey: identityFor(plan, row), changes });
        });
    });

    // Inserting or deleting a row is only meaningful when the whole result
    // comes from exactly one table.
    const single = tables.length === 1 ? tables[0] : null;
    if (single && single.identityStrategy !== 'none') {
        (edits.deletes || []).forEach(rowIdx => {
            targetFor(single).changes.deletes.push(identityFor(single, (rows || [])[rowIdx]));
        });
        (edits.inserts || []).forEach(row => {
            const clean = {};
            Object.keys(row || {}).forEach(colName => {
                const source = sources[colName];
                const value = row[colName];
                if (!source || source.tableOid !== single.tableOid) { return; }
                if (value === '' || value === null || value === undefined) { return; }
                clean[source.sourceColumn] = value;
            });
            if (Object.keys(clean).length > 0) {
                targetFor(single).changes.inserts.push(clean);
            }
        });
    }

    return Array.from(targets.values()).filter(t =>
        t.changes.updates.length > 0 || t.changes.inserts.length > 0 || t.changes.deletes.length > 0
    );
}

// Relations a column header can follow. Unlike the cell menu this does not
// need a value: the whole filtered result is carried into the target query as
// a JOIN, so every relation of the column applies.
function headerRelationTargets(colName, foreignKeys, referencingTables, customMappings) {
    const targets = [];
    (foreignKeys || []).forEach(fk => {
        if (fk.column !== colName) return;
        targets.push({
            label: `${fk.refSchema}.${fk.refTable}.${fk.refColumn}`,
            targetSchema: fk.refSchema,
            targetTable: fk.refTable,
            columnPairs: [{ sourceColumn: colName, targetColumn: fk.refColumn }],
            sourceConditions: [],
            targetConditions: []
        });
    });
    (referencingTables || []).forEach(ref => {
        if (ref.localColumn !== colName) return;
        targets.push({
            label: `${ref.fkSchema}.${ref.fkTable}.${ref.fkColumn}`,
            targetSchema: ref.fkSchema,
            targetTable: ref.fkTable,
            columnPairs: [{ sourceColumn: colName, targetColumn: ref.fkColumn }],
            sourceConditions: [],
            targetConditions: []
        });
    });
    (customMappings || []).forEach(m => {
        if (m.sourceColumn !== colName) return;
        const pairs = [{ sourceColumn: m.sourceColumn, targetColumn: m.targetColumn }];
        (m.additionalColumnPairs || []).forEach(p => {
            if (p && p.sourceColumn && p.targetColumn) {
                pairs.push({ sourceColumn: p.sourceColumn, targetColumn: p.targetColumn });
            }
        });
        const base = m.label || `${m.targetSchema}.${m.targetTable}.${m.targetColumn}`;
        targets.push({
            label: m.reversed ? `${base} (reverse)` : base,
            targetSchema: m.targetSchema,
            targetTable: m.targetTable,
            columnPairs: pairs,
            sourceConditions: m.conditions || [],
            targetConditions: m.targetConditions || []
        });
    });
    return targets;
}

// True when the current query is a plain `SELECT ... FROM <table> [WHERE ...]`.
// Only then can its WHERE clause be lifted into a JOIN's ON clause without
// changing what the query means; anything else is carried over whole instead.
function isLiftableSelect(sql) {
    const s = String(sql || '').trim();
    if (!s || !/^SELECT\s/i.test(s)) return false;
    const parsed = parseSqlForWhere(s);
    const fromIdx = findTopLevelKeywordIndex(parsed.base, 'FROM');
    if (fromIdx === -1) return false;
    if (/\bDISTINCT\b/i.test(parsed.base.substring(0, fromIdx))) return false;
    const fromPart = parsed.base.substring(fromIdx).replace(/^\s*FROM\s+/i, '').trim();
    const ident = '(?:"[^"]+"|[A-Za-z_][\\w$]*)';
    if (!new RegExp(`^${ident}(?:\\s*\\.\\s*${ident})?$`).test(fromPart)) return false;
    return !['GROUP', 'HAVING', 'UNION', 'INTERSECT', 'EXCEPT', 'WINDOW', 'FETCH']
        .some(kw => findTopLevelKeywordIndex(parsed.where, kw) !== -1);
}

// Message payload for opening a related table as a JOIN. `sources` describes
// the result the relation was found in: `columnOf(name)` gives the name the
// source table itself uses for a result column, `columns` lists the names the
// result shows.
function relatedJoinPayload(rel, schema, table, sql, sources) {
    const pairs = rel.columnPairs || [];
    const source = relatedJoinSource(sql, pairs.length ? pairs[0].sourceColumn : '');
    const columnOf = (sources && sources.columnOf) || (name => name);
    // Carried over as a derived table the columns keep the names the query gave
    // them; in every other shape the source table is joined under its own name.
    const rename = source.mode === 'derived' ? (name => name) : columnOf;
    return {
        sourceSchema: schema,
        sourceTable: table,
        targetSchema: rel.targetSchema,
        targetTable: rel.targetTable,
        columnPairs: pairs.map(p => ({ sourceColumn: rename(p.sourceColumn), targetColumn: p.targetColumn })),
        sourceConditions: (rel.sourceConditions || []).map(c => Object.assign({}, c, { column: rename(c.column) })),
        targetConditions: rel.targetConditions || [],
        where: source.where,
        orderBy: source.orderBy,
        sourceSql: source.sql,
        sourceColumns: source.mode === 'derived' ? ((sources && sources.columns) || []) : [],
        sourceJoins: source.joins,
        sourceAlias: source.alias
    };
}

// How the query on screen is carried into the query of the related table:
// joined directly when it is a plain single-table SELECT ('table'), with its
// own JOIN chain when its tables can be carried over ('chain'), and as a
// derived table when neither works ('derived').
function relatedJoinSource(sql, resultColumn) {
    const base = String(sql || '').trim();
    const empty = { mode: 'derived', where: '', orderBy: '', sql: base, joins: '', alias: '' };
    if (isLiftableSelect(base)) {
        const parsed = parseSqlForWhere(base);
        return { mode: 'table', where: parsed.where, orderBy: parsed.orderBy, sql: '', joins: '', alias: '' };
    }
    const chain = parseSelectChain(base);
    const column = chain ? selectItemColumn(chain.selectList, resultColumn) : null;
    // The relation is joined on the first table of the chain, so the column has
    // to belong to it: every other alias only comes into scope further down.
    if (!chain || !chain.joins || !column || column.alias !== chain.alias) {
        return empty;
    }
    return { mode: 'chain', where: chain.where, orderBy: chain.orderBy, sql: '', joins: chain.joins, alias: chain.alias };
}

// Clauses that stop a SELECT from being carried into another query, because
// they describe a result rather than a set of joined rows.
const UNCARRIED_SQL_CLAUSES = [
    'GROUP BY', 'HAVING', 'WINDOW', 'UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT', 'FETCH', 'RETURNING'
];

// Take a SELECT apart into what is needed to carry its tables into another
// query: its select list, the first FROM table with its alias, the JOIN
// clauses that follow verbatim, its WHERE and its ORDER BY. Anything that
// cannot be carried over safely yields null.
function parseSelectChain(sql) {
    const raw = String(sql || '').trim().replace(/;\s*$/, '');
    if (!/^SELECT\s/i.test(raw) || hasSqlComment(raw)) return null;
    const ident = '(?:"(?:[^"]|"")+"|[A-Za-z_][\\w$]*)';
    const fromRe = new RegExp(`^(${ident}(?:\\s*\\.\\s*${ident})?)(?:\\s+AS)?\\s+(${ident})$`, 'i');
    const chain = { selectList: '', table: '', alias: '', joins: '', where: '', orderBy: '' };
    const joins = [];
    for (const seg of splitTopLevelClauses(collapseSqlWhitespace(raw))) {
        const kw = String(seg.kw || '').toUpperCase();
        const content = String(seg.content || '').trim();
        if (UNCARRIED_SQL_CLAUSES.indexOf(kw) !== -1) return null;
        if (kw === 'SELECT') {
            if (chain.selectList || /^DISTINCT\b/i.test(content)) return null;
            chain.selectList = content;
        } else if (kw === 'FROM') {
            const m = content.match(fromRe);
            if (!m || chain.table) return null;
            chain.table = m[1];
            chain.alias = unquoteSqlIdentifier(m[2]);
        } else if (/JOIN$/.test(kw)) {
            joins.push(`${kw} ${content}`);
        } else if (kw === 'WHERE') {
            chain.where = content;
        } else if (kw === 'ORDER BY') {
            chain.orderBy = content;
        } else if (kw !== 'LIMIT' && kw !== 'OFFSET') {
            return null;
        }
    }
    if (!chain.table || !chain.alias) return null;
    chain.joins = joins.join('\n');
    return chain;
}

function unquoteSqlIdentifier(token) {
    const t = String(token || '');
    return t.startsWith('"') && t.endsWith('"') && t.length > 1 ? t.slice(1, -1).replace(/""/g, '"') : t;
}

// The `alias.column` a select list exposes under the given result name. Only a
// plain column reference can be joined on, so anything computed yields null.
function selectItemColumn(selectList, resultColumn) {
    const ident = '(?:"(?:[^"]|"")+"|[A-Za-z_][\\w$]*)';
    const itemRe = new RegExp(`^(${ident})(?:\\s*\\.\\s*(${ident}))?(?:\\s+AS\\s+(${ident})|\\s+(${ident}))?$`, 'i');
    for (const item of splitTopLevelCommas(String(selectList || ''))) {
        const m = item.trim().match(itemRe);
        if (!m) continue;
        const alias = m[2] ? unquoteSqlIdentifier(m[1]) : '';
        const column = unquoteSqlIdentifier(m[2] || m[1]);
        const name = m[3] || m[4] ? unquoteSqlIdentifier(m[3] || m[4]) : column;
        if (name === resultColumn) {
            return { alias, column };
        }
    }
    return null;
}

// Text for the row-count indicator. An exact total is only known when it was
// counted (always for the default table view, on demand for other queries);
// until then the loaded row count is shown instead.
function describeRowCount(showing, totalCount, moreAvailable) {
    if (typeof totalCount === 'number') {
        return `Showing ${showing} of ${totalCount} rows`;
    }
    return `${showing} rows loaded` + (moreAvailable ? ' (more available)' : '');
}

// How trustworthy writing back a column is, used to colour its header:
// 'editable' (traced to a table column identified by a primary key),
// 'unsafe' (traced to a table column, but rows are matched by their values)
// and 'readonly' (computed column with no source table).
function columnWriteMode(caps, colName) {
    const capabilities = normalizeCapabilities(caps);
    const source = capabilities.columnSources[colName];
    if (!source) {
        return 'readonly';
    }
    const plan = capabilities.tables.find(t => sourceInstanceKey(t) === sourceInstanceKey(source));
    return (plan && plan.identityStrategy === 'pk') ? 'editable' : 'unsafe';
}

// True when the statements in the commit preview were changed by the user.
// Pure whitespace differences are ignored so re-indenting is not treated as
// an edit.
function isSqlEdited(generated, edited) {
    return collapseSqlWhitespace(String(edited || '')).trim()
        !== collapseSqlWhitespace(String(generated || '')).trim();
}

// Warnings shown in the commit preview: how reliably the rows can be matched,
// which changes had to become an INSERT and whether the connection changed
// since the data was loaded.
function buildCommitWarnings(capabilityWarning, currentConnection, loadedConnection, targets) {
    const warnings = [];
    if (capabilityWarning) {
        warnings.push(capabilityWarning);
    }
    const inserted = (targets || []).filter(t => t && t.missingRowInserts > 0);
    if (inserted.length > 0) {
        const names = [...new Set(inserted.map(t => `${t.schema}.${t.table}`))].join(', ');
        warnings.push(
            `The join found no row in ${names} for what you edited, so there is nothing to update: `
            + 'an INSERT with the edited columns alone is generated instead. It sets no key and no join '
            + 'condition — complete the statement below before executing it.'
        );
    }
    if (currentConnection && loadedConnection && currentConnection !== loadedConnection) {
        warnings.push(
            `The active connection (${currentConnection}) differs from the connection the data was loaded with `
            + `(${loadedConnection}). Executing will run against "${currentConnection}".`
        );
    }
    return warnings;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
(function() {
    const vscode = acquireVsCodeApi();

    let columns = [];
    let primaryKeys = [];
    let foreignKeys = []; // [{column, refSchema, refTable, refColumn}]
    let columnDefaults = []; // [{column, defaultExpression, isIdentity, isGenerated}]
    let duplicateResetMode = 'volatile';
    let referencingTables = []; // [{fkSchema, fkTable, fkColumn, localColumn}]
    let customMappings = []; // [{id, sourceColumn, targetSchema, targetTable, targetColumn, conditions, isDefault, label}]
    let allRows = [];
    // Indices into allRows of the loaded rows the filters let through, in the
    // order the sort puts them.
    let displayedOrder = [];
    // Every row shown, in display order (see buildRenderPlan), and the part of
    // it that is in the DOM: [renderStart, renderEnd).
    let renderPlan = [];
    let renderStart = 0;
    let renderEnd = 0;
    // Where each row of the plan stands, by kind and index.
    let planIndexByRow = new Map();
    let planIndexByInsert = new Map();
    let planIndexByDup = new Map();
    // Height of a single-line row, measured once rows are on screen.
    let virtualRowHeight = 25;
    // Rows the user dragged taller, keyed by planRowKey: the content height set
    // with the row-height handle, and how much taller the row came out.
    const rowContentHeights = new Map();
    const rowExtraHeights = new Map();
    // Rows put into the DOM above and below the visible ones.
    const VIRTUAL_BUFFER_ROWS = 40;
    // Width each column has reached so far; it only grows, so a column does not
    // jump narrower and wider while the rows in view change.
    let autoColumnWidths = {};
    let schema = '';
    let table = '';
    let tableReference = '';
    let alwaysQuote = false;
    // Whether the query bar's autocomplete writes the alias after a completed table.
    let completionTableAlias = true;
    let thousandSeparator = ' ';
    // When on, the default table query qualifies every column with a table
    // alias; `tableAlias` holds the alias persisted for this table, or '' to let
    // it be derived from the first column name.
    let qualifyColumnsWithAlias = false;
    let tableAlias = '';
    // Whether a newly created custom mapping is shared with the workspace by
    // default (the mapping dialog's "Share with workspace" checkbox).
    let newMappingDefaultWorkspace = false;
    // Exact number of rows the current query returns, or null while unknown
    // (counting an arbitrary query is only done on request).
    let totalCount = null;
    let currentOffset = 0;
    // Permanent per-table WHERE constraints (array of ConstraintCondition).
    // Applied to the default table view's query every time it loads.
    let permanentConstraints = [];
    // Permanent per-table ORDER BY entries ({ column, direction }), applied to
    // the default table view's query alongside the constraints.
    let permanentSorts = [];
    // Saved query the panel currently runs: the template still holds the
    // `:name` placeholders, while the query bar shows the substituted SQL.
    let savedQueryId = '';
    let savedQueryTemplate = '';
    let savedQueryParameters = [];
    let savedQueryValues = {};
    // True while the initial parameter prompt of a saved query is open.
    let queryParamsPendingInitialRun = false;
    let lastUsedConnection = '';
    let currentConnection = '';
    // What the current result allows. Derived by the extension from the source
    // tables of the displayed columns, so an ad-hoc SELECT gets the same
    // features as a table opened from the tree whenever that is possible.
    let caps = emptyCapabilities();
    // Values of executable columns that ran, keyed by executableMarkKey, with
    // the mark their run button shows ({ status, title }).
    const executedValues = new Map();
    // When a run button was last clicked, so a double click does not run twice.
    let lastExecutableClickAt = 0;
    // Pagination state of the query currently displayed. `currentSql` is the
    // query without a trailing LIMIT/OFFSET so Load More can page through it.
    let currentSql = '';           // SQL without trailing LIMIT/OFFSET clause
    let userPaged = false;         // true when the user wrote an explicit LIMIT/OFFSET
    let appendPending = false;
    // The query text last run and whether its exact row count was requested,
    // so auto refresh can repeat exactly that run.
    let lastRunRawSql = '';
    let lastRunWantTotal = false;
    // Every fresh load gets a number; an auto refresh sends its number along and
    // the host echoes it, so an answer overtaken by a newer load is recognised.
    let loadCounter = 0;
    let latestLoadId = 0;
    // The auto refresh request on its way ({ id, limit }), or null.
    let autoRefreshInFlight = null;
    let moreAvailable = false;
    // Set when the user pressed "Load All": the next result has fetched every
    // remaining row, so pagination buttons stay disabled even though the
    // heuristic (a full last batch) cannot tell there is no more.
    let allLoaded = false;
    // Execution time (ms) of the most recent data/custom query, shown next to
    // the row-count indicator. null when not yet known.
    let lastQueryDurationMs = null;
    const PAGE_SIZE = 50;
    // NOTE: Single source of truth is src/reservedKeywords.ts. This browser
    // script is injected as a plain string and cannot import it at runtime;
    // src/test/reservedKeywords.test.ts enforces that this copy stays in sync.
    const POSTGRES_RESERVED_KEYWORDS = new Set([
        'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric',
        'authorization', 'between', 'binary', 'both', 'case', 'cast', 'check', 'collate',
        'column', 'concurrently', 'constraint', 'create', 'cross', 'current_catalog',
        'current_date', 'current_role', 'current_schema', 'current_time', 'current_timestamp',
        'current_user', 'default', 'deferrable', 'desc', 'distinct', 'do', 'else', 'end',
        'except', 'false', 'fetch', 'for', 'foreign', 'from', 'freeze', 'full', 'grant',
        'group', 'having', 'ilike', 'in', 'initially', 'inner', 'intersect', 'into', 'is',
        'isnull', 'join', 'lateral', 'leading', 'left', 'like', 'limit', 'localtime',
        'localtimestamp', 'natural', 'not', 'notnull', 'null', 'offset', 'on', 'only', 'or',
        'order', 'outer', 'overlaps', 'placing', 'primary', 'references', 'returning', 'right',
        'select', 'session_user', 'similar', 'some', 'symmetric', 'table', 'then', 'to',
        'trailing', 'true', 'union', 'unique', 'user', 'using', 'variadic', 'verbose', 'when',
        'where', 'window', 'with'
    ]);

    let modifiedCells = new Map(); // "rowIndex:colName" -> newValue
    let deletedRows = new Set();   // rowIndex
    let insertedRows = [];          // [{ row: {col: val, ...}, anchor: number|null }]
    let duplicatedRows = [];        // [{ row: {col: val, ...}, anchor: number|null }]
    let invalidCells = new Map();  // cell key -> why the column cannot store the value

    // Drop every pending (uncommitted) edit. Called whenever a fresh page of
    // data replaces the current rows, so that per-row-index changes are never
    // re-applied to unrelated rows after a reload.
    function resetPendingChanges() {
        modifiedCells.clear();
        deletedRows.clear();
        insertedRows = [];
        duplicatedRows = [];
        invalidCells.clear();
        selectedRowIdx = null;
    }

    // --- Unified undo/redo for grid edits and the query text ------------------
    // One stack of whole-state snapshots. Every staged change (a cell edit, a
    // fill, a delete, a new/duplicated row, or any change to the query text)
    // appends a snapshot; Ctrl+Z / Ctrl+Y walk it. See the pure helpers
    // cloneEditValue / editStatesEqual / applyHistoryEntry above.
    let editHistory = [];
    let editHistoryIndex = 0;
    // True while a run of continuous typing in the query box coalesces into one
    // history step; reset by any other change or when the box loses focus.
    let queryTypingRun = false;
    // Guards against recording while a snapshot is being restored.
    let historySuspended = false;

    function captureEditState() {
        return {
            modified: cloneEditValue(modifiedCells),
            deleted: cloneEditValue(deletedRows),
            inserted: cloneEditValue(insertedRows),
            duplicated: cloneEditValue(duplicatedRows),
            invalid: cloneEditValue(invalidCells),
            query: queryInput ? queryInput.value : ''
        };
    }

    function restoreEditState(snap) {
        historySuspended = true;
        modifiedCells = cloneEditValue(snap.modified);
        deletedRows = cloneEditValue(snap.deleted);
        insertedRows = cloneEditValue(snap.inserted);
        duplicatedRows = cloneEditValue(snap.duplicated);
        invalidCells = cloneEditValue(snap.invalid);
        if (queryInput && queryInput.value !== snap.query) {
            queryInput.value = snap.query;
            autoSizeQueryInput();
        }
        selectedRowIdx = null;
        clearCellRangeSelection();
        renderBody();
        updateRowCount();
        updateChangeIndicator();
        historySuspended = false;
    }

    // Start a fresh history whose baseline is the current state. Called when a
    // new result replaces the rows, since per-row-index snapshots no longer map.
    function resetEditHistory() {
        editHistory = [captureEditState()];
        editHistoryIndex = 0;
        queryTypingRun = false;
    }

    // Record the current state as the next history step. `kind === 'type'`
    // coalesces consecutive query-box keystrokes into a single step.
    function recordEditHistory(kind) {
        if (historySuspended) { return; }
        if (editHistory.length === 0) { resetEditHistory(); return; }
        const coalesce = kind === 'type' && queryTypingRun;
        const r = applyHistoryEntry(editHistory, editHistoryIndex, captureEditState(), editStatesEqual, coalesce);
        editHistory = r.history;
        editHistoryIndex = r.index;
        queryTypingRun = kind === 'type';
    }

    function undoEdit() {
        if (editHistoryIndex <= 0) { return false; }
        queryTypingRun = false;
        editHistoryIndex--;
        restoreEditState(editHistory[editHistoryIndex]);
        return true;
    }

    function redoEdit() {
        if (editHistoryIndex >= editHistory.length - 1) { return false; }
        queryTypingRun = false;
        editHistoryIndex++;
        restoreEditState(editHistory[editHistoryIndex]);
        return true;
    }

    // Undo/redo is claimed only on the grid or the query box, and never while a
    // modal dialog or another input owns its own native undo.
    function editHistoryShortcutAllowed() {
        const overlayOpen = Array.from(document.querySelectorAll('.sql-dialog-overlay'))
            .some(el => el.style && el.style.display && el.style.display !== 'none');
        if (overlayOpen) { return false; }
        const ae = document.activeElement;
        if (!ae || ae === document.body) { return true; }
        if (ae === queryInput) { return true; }
        if (queryEditor && queryEditor.hasFocus()) { return true; }
        // A cell being edited or any other field keeps its own native undo.
        return !isEditingElement(ae);
    }

    // Index of the currently "selected" existing row (the one most recently
    // clicked). New / duplicated rows are inserted directly below this row.
    // null means no row is selected -> new rows appear at the very top.
    let selectedRowIdx = null;

    // Active sort plus the one it replaced, so a third click can go back to it.
    let sortState = { column: null, direction: 'asc', previous: null };

    // Name of the column currently being dragged in the header (drag-and-drop
    // reordering), or null when no drag is in progress.
    let dragSourceCol = null;

    // Row-height resize: the default (single-line) content height in px must
    // match the CSS fallback for --row-content-max-h; MAX bounds how far a row
    // can be dragged open. `rowResizeState` holds the in-flight drag.
    const DEFAULT_ROW_CONTENT_H = 20;
    const MAX_ROW_CONTENT_H = 600;
    let rowResizeState = null;

    function startRowResize(e) {
        const tr = e.target.closest('tr');
        if (!tr) return;
        e.preventDefault();
        e.stopPropagation();
        const startVar = tr.style.getPropertyValue('--row-content-max-h');
        const startHeight = startVar ? parseFloat(startVar) : DEFAULT_ROW_CONTENT_H;
        const entry = renderPlan[planIndexOf(tr)];
        rowResizeState = { tr, startY: e.clientY, startHeight, key: entry ? planRowKey(entry) : null };
        document.addEventListener('mousemove', onRowResizeMove);
        document.addEventListener('mouseup', endRowResize);
        document.body.classList.add('row-resizing');
    }

    function onRowResizeMove(e) {
        if (!rowResizeState) return;
        const delta = e.clientY - rowResizeState.startY;
        const h = computeResizedRowHeight(rowResizeState.startHeight, delta, DEFAULT_ROW_CONTENT_H, MAX_ROW_CONTENT_H);
        rowResizeState.tr.style.setProperty('--row-content-max-h', h + 'px');
        // Kept by row, so the height survives the row leaving the DOM.
        if (rowResizeState.key) {
            if (h > DEFAULT_ROW_CONTENT_H) rowContentHeights.set(rowResizeState.key, h);
            else rowContentHeights.delete(rowResizeState.key);
        }
    }

    function endRowResize() {
        rowResizeState = null;
        document.removeEventListener('mousemove', onRowResizeMove);
        document.removeEventListener('mouseup', endRowResize);
        document.body.classList.remove('row-resizing');
        // The spacers below have to account for the new height.
        renderWindow(true);
    }

    // Column-width resize: widths the user dragged, keyed by column name so they
    // survive re-renders and column reordering. They are applied through one
    // generated stylesheet instead of inline styles, because every cell of a
    // column must carry the width for the table layout to honour it.
    const MIN_COL_W = 40;
    const MAX_COL_W = 1200;
    let columnWidths = {};
    let colResizeState = null;
    // A finished drag is followed by a click on the header, which would sort it.
    // Timestamp instead of a flag, so a release outside the header expires too.
    let colResizeEndedAt = 0;
    const columnWidthStyle = document.createElement('style');
    document.head.appendChild(columnWidthStyle);

    function applyColumnWidths() {
        columnWidthStyle.textContent = buildAutoColumnWidthCss(autoColumnWidths, columnWidths) + '\n' + buildColumnWidthCss(columnWidths);
    }

    function startColumnResize(e) {
        const th = e.target.closest('th');
        if (!th) return;
        e.preventDefault();
        e.stopPropagation();
        const col = th.getAttribute('data-col');
        // The header is draggable for reordering; that must not start here.
        th.draggable = false;
        const scroller = document.getElementById('tableWrapper');
        colResizeState = {
            col, th, startX: e.clientX, lastX: e.clientX,
            startWidth: th.getBoundingClientRect().width,
            scroller, startScrollLeft: scroller ? scroller.scrollLeft : 0,
            autoScrolled: 0, frame: 0
        };
        document.addEventListener('mousemove', onColumnResizeMove);
        document.addEventListener('mouseup', endColumnResize);
        window.addEventListener('blur', endColumnResize);
        document.body.classList.add('col-resizing');
    }

    function applyResizedColumnWidth() {
        const s = colResizeState;
        columnWidths[s.col] = computeResizedColumnWidth(s.startWidth, s.lastX - s.startX + s.autoScrolled, MIN_COL_W, MAX_COL_W);
        applyColumnWidths();
    }

    function onColumnResizeMove(e) {
        if (!colResizeState) return;
        // A release outside the panel may never arrive as a mouseup.
        if (e.buttons === 0) { endColumnResize(); return; }
        colResizeState.lastX = e.clientX;
        applyResizedColumnWidth();
        if (!colResizeState.frame) {
            colResizeState.frame = requestAnimationFrame(columnResizeAutoScroll);
        }
    }

    // While the pointer rests at the right edge of the grid, keep widening the
    // column and scroll along with it, so the last column is not capped by the
    // edge of the panel.
    const COL_RESIZE_EDGE_ZONE = 32;
    const COL_RESIZE_EDGE_MAX_STEP = 10;
    function columnResizeAutoScroll() {
        const s = colResizeState;
        if (!s) return;
        s.frame = 0;
        if (!s.scroller || columnWidths[s.col] >= MAX_COL_W) return;
        const visibleRight = s.scroller.getBoundingClientRect().left + s.scroller.clientWidth;
        const step = columnResizeEdgeStep(s.lastX, visibleRight, COL_RESIZE_EDGE_ZONE, COL_RESIZE_EDGE_MAX_STEP);
        if (step <= 0) return;
        s.autoScrolled += step;
        applyResizedColumnWidth();
        s.scroller.scrollLeft = s.startScrollLeft + s.autoScrolled;
        s.frame = requestAnimationFrame(columnResizeAutoScroll);
    }

    function endColumnResize() {
        if (colResizeState) {
            if (colResizeState.frame) cancelAnimationFrame(colResizeState.frame);
            colResizeState.th.draggable = true;
            colResizeEndedAt = Date.now();
        }
        colResizeState = null;
        document.removeEventListener('mousemove', onColumnResizeMove);
        document.removeEventListener('mouseup', endColumnResize);
        window.removeEventListener('blur', endColumnResize);
        document.body.classList.remove('col-resizing');
    }

    let filters = {};
    let exactFilters = {}; // FK filters that use exact match
    let filterModes = {}; // 'contains' | 'between' per column

    const tableHead = document.getElementById('tableHead');
    const dataTable = document.getElementById('dataTable');
    const tableBody = document.getElementById('tableBody');
    const tableName = document.getElementById('tableName');
    const rowCount = document.getElementById('rowCount');
    const commitBtn = document.getElementById('commitBtn');
    const discardBtn = document.getElementById('discardBtn');
    const insertRowBtn = document.getElementById('insertRowBtn');
    const loadMoreBtn = document.getElementById('loadMoreBtn');
    const loadAllBtn = document.getElementById('loadAllBtn');
    const groupUpdateBtn = document.getElementById('groupUpdateBtn');
    const groupDeleteBtn = document.getElementById('groupDeleteBtn');
    const changeCount = document.getElementById('changeCount');
    const sqlDialogOverlay = document.getElementById('sqlDialogOverlay');
    const sqlDialogContent = document.getElementById('sqlDialogContent');
    const sqlDialogExecute = document.getElementById('sqlDialogExecute');
    const sqlDialogCancel = document.getElementById('sqlDialogCancel');
    const sqlDialogClose = document.getElementById('sqlDialogClose');
    const sqlDialogReset = document.getElementById('sqlDialogReset');
    const queryInput = document.getElementById('queryInput');
    const queryRunBtn = document.getElementById('queryRunBtn');
    const queryFormatBtn = document.getElementById('queryFormatBtn');
    const queryHistoryContainer = document.getElementById('queryHistoryContainer');
    const queryHistoryToggle = document.getElementById('queryHistoryToggle');
    const queryHistoryPanel = document.getElementById('queryHistoryPanel');
    const queryHistorySearch = document.getElementById('queryHistorySearch');
    const queryHistoryList = document.getElementById('queryHistoryList');
    const queryHistoryEmpty = document.getElementById('queryHistoryEmpty');
    let queryHistoryEntries = [];
    let queryHistoryActiveIdx = -1;
    const contextMenu = document.getElementById('contextMenu');
    const contextMenuItems = document.getElementById('contextMenuItems');
    const contextMenuSearch = document.getElementById('contextMenuSearch');
    const contextMenuEmpty = document.getElementById('contextMenuEmpty');
    const charBudgetBadge = document.getElementById('charBudgetBadge');
    const dataLoading = document.getElementById('dataLoading');
    const dataLoadingOverlay = document.getElementById('dataLoadingOverlay');
    const metaLoading = document.getElementById('metaLoading');
    const connectionInfo = document.getElementById('connectionInfo');
    const sessionInfo = document.getElementById('sessionInfo');
    const sqlDialogConnection = document.getElementById('sqlDialogConnection');
    const sqlDialogWarning = document.getElementById('sqlDialogWarning');

    // The overlay only veils the rows: it starts below the pinned header and
    // filter rows so a filter can still be typed while the data is on its way.
    let dataLoadingActive = false;
    function setDataLoading(active) {
        dataLoadingActive = !!active;
        dataLoading.classList.toggle('hidden', !active);
        if (!dataLoadingOverlay) return;
        if (active) {
            const head = Math.round(tableHead.getBoundingClientRect().height);
            dataLoadingOverlay.style.setProperty('--data-overlay-top', head + 'px');
        }
        dataLoadingOverlay.classList.toggle('visible', active);
    }

    // Show data loading spinner. The actual initial load is kicked off from
    // handleInit() once the extension tells us whether this is a normal table
    // view or a read-only custom query.
    setDataLoading(true);

    // Set the query bar text, pretty-printed as a formatted multi-line SELECT,
    // and resize the textarea to fit.
    function setQueryText(sql) {
        queryInput.value = formatSql(sql == null ? '' : String(sql));
        autoSizeQueryInput();
        recordEditHistory();
    }

    // Grow/shrink the query textarea to fit its content (bounded by the CSS
    // max-height).
    function autoSizeQueryInput() {
        if (!queryInput) return;
        queryInput.style.height = 'auto';
        queryInput.style.height = (queryInput.scrollHeight + 2) + 'px';
    }

    commitBtn.addEventListener('click', commitChanges);
    discardBtn.addEventListener('click', discardChanges);
    insertRowBtn.addEventListener('click', insertRow);
    loadMoreBtn.addEventListener('click', loadMore);
    loadAllBtn.addEventListener('click', loadAll);
    // Counting all rows of an arbitrary query can be expensive, so it only runs
    // when the user asks for it by clicking the row-count indicator.
    if (rowCount) {
        rowCount.addEventListener('click', () => {
            if (typeof totalCount === 'number' || !currentSql) return;
            rowCount.textContent = 'Counting rows…';
            vscode.postMessage({ command: 'getTotalCount', sql: currentSql });
        });
    }
    // Clicking the connection badge lets the user switch to another saved
    // connection (handled by the extension host).
    if (connectionInfo) {
        connectionInfo.addEventListener('click', () => {
            vscode.postMessage({ command: 'selectConnection' });
        });
    }
    // Clicking the session badge offers to reset the session; the host asks
    // for confirmation first.
    if (sessionInfo) {
        sessionInfo.addEventListener('click', () => {
            vscode.postMessage({ command: 'resetSession' });
        });
        sessionInfo.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            e.stopPropagation();
            vscode.postMessage({ command: 'resetSession' });
        });
    }
    // Recompute the sticky filter-row offset when the header may rewrap.
    window.addEventListener('resize', updateStickyFilterOffset);
    sqlDialogCancel.addEventListener('click', closeSqlDialog);
    sqlDialogClose.addEventListener('click', closeSqlDialog);
    sqlDialogExecute.addEventListener('click', executePendingChanges);
    if (sqlDialogReset) {
        sqlDialogReset.addEventListener('click', () => {
            sqlDialogContent.value = generatedSql;
            sqlDialogContent.focus();
        });
    }
    queryRunBtn.addEventListener('click', runQuery);
    if (queryFormatBtn) {
        queryFormatBtn.addEventListener('click', () => {
            if (queryEditor) {
                queryEditor.format();
            } else {
                setQueryText(queryInput.value);
                queryInput.focus();
            }
        });
    }
    queryInput.addEventListener('keydown', (e) => {
        // The query input is a multi-line textarea: plain Enter inserts a new
        // line, Ctrl/Cmd+Enter runs the query.
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            runQuery();
        }
    });
    queryInput.addEventListener('input', autoSizeQueryInput);
    // Typing in the query box is one undoable step per focused run; leaving the
    // box ends the run so the next edit starts a fresh step.
    queryInput.addEventListener('input', () => recordEditHistory('type'));
    queryInput.addEventListener('blur', () => { queryTypingRun = false; });

    // The query box becomes a Monaco editor (highlighting, autocomplete, the
    // extension's formatter) once its bundle has loaded; until then, and when it
    // is not available, the textarea itself stays the editor.
    const queryEditor = window.QueryEditor
        ? window.QueryEditor.attach(queryInput, {
            postMessage: (msg) => vscode.postMessage(msg),
            onRun: runQuery,
            onUndo: undoEdit,
            onRedo: redoEdit,
            onDiscreteEdit: () => { queryTypingRun = false; },
            quoteIdent: formatIdentifier,
            addTableAlias: () => completionTableAlias
        })
        : null;

    queryHistoryToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleQueryHistoryPanel();
    });
    queryHistorySearch.addEventListener('input', () => {
        queryHistoryActiveIdx = -1;
        renderQueryHistoryList();
    });
    queryHistorySearch.addEventListener('keydown', (e) => {
        const items = queryHistoryList.querySelectorAll('li');
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (items.length === 0) return;
            queryHistoryActiveIdx = (queryHistoryActiveIdx + 1) % items.length;
            highlightActiveHistoryItem(items);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (items.length === 0) return;
            queryHistoryActiveIdx = (queryHistoryActiveIdx - 1 + items.length) % items.length;
            highlightActiveHistoryItem(items);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (queryHistoryActiveIdx >= 0 && items[queryHistoryActiveIdx]) {
                selectQueryHistoryItem(items[queryHistoryActiveIdx].getAttribute('data-sql'));
            } else if (items.length > 0) {
                selectQueryHistoryItem(items[0].getAttribute('data-sql'));
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeQueryHistoryPanel();
            queryHistoryToggle.focus();
        }
    });
    queryHistoryPanel.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    document.addEventListener('click', () => {
        hideContextMenu();
        closeQueryHistoryPanel();
    });

    // Typing in the menu's search box must not count as a click beside it.
    contextMenu.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    contextMenuSearch.addEventListener('input', filterContextMenu);
    contextMenuSearch.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            hideContextMenu();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const first = contextMenuItems.querySelector('li[data-action-idx]:not(.hidden)');
            if (first) { first.click(); }
        }
    });

    // Strip thousand separators from numeric cells when copying from the grid,
    // so a displayed "9 999 999,99" lands on the clipboard as "9999999,99".
    document.addEventListener('copy', handleGridCopy);

    // --- Excel-like rectangular cell selection ------------------------------
    // Drag across data cells (or Shift+click) to select a rectangle spanning any
    // number of columns and rows, then Ctrl/Cmd+C copies it as TAB-separated
    // columns and CRLF-separated rows (pastes straight into Excel). A plain
    // single click keeps the normal edit/focus behaviour.
    let rangeAnchor = null;   // {r, c} first corner of the selection
    let rangeFocus = null;    // {r, c} opposite corner
    let rangeMouseDown = null; // candidate anchor recorded on mousedown
    let rangeDragging = false;
    // Excel-style fill handle: while true, dragging extends a fill region. From a
    // single cell the region is filled with `fillSourceValue`; from a block of
    // cells (`fillSourceBounds`) it extends along one axis (`fillPlan`) and the
    // block's values are continued as a series or repeated.
    let fillDragging = false;
    let fillSourceValue = null;
    let fillSourceBounds = null;
    let fillPlan = null;
    // While set, typing edits the anchor cell and committing fills these bounds
    // (a multi-cell selection typed over at once).
    let multiEditBounds = null;

    // While set, a synthetic copy event writes these two representations of the
    // selected cells: tab-separated text and an HTML table (rich paste).
    let pendingRangeCopy = null;

    function cellCoords(td) {
        const tr = td.closest('tr');
        const r = planIndexOf(tr);
        if (r < 0) return null;
        const dataCells = tr.querySelectorAll(':scope > td[data-col]');
        const c = Array.prototype.indexOf.call(dataCells, td);
        if (c < 0) return null;
        return { r, c };
    }

    function clearNativeTextSelection() {
        const s = window.getSelection();
        if (s && s.rangeCount) s.removeAllRanges();
    }

    function clearCellRangeSelection() {
        rangeAnchor = null;
        rangeFocus = null;
        tableBody.querySelectorAll('td.cell-range-selected')
            .forEach(td => td.classList.remove('cell-range-selected'));
        markSelectedLines();
        removeFillHandle();
    }

    // Mark the row numbers and column headers of rows/columns that are selected
    // as a whole (by row-number / header-strip selection or a full-width drag).
    function markSelectedLines() {
        tableBody.querySelectorAll('td.row-num-selected')
            .forEach(td => td.classList.remove('row-num-selected'));
        tableHead.querySelectorAll('th.col-selected')
            .forEach(th => th.classList.remove('col-selected'));
        if (!rangeAnchor || !rangeFocus) return;
        const lines = fullySelectedLines(rangeBounds(), renderPlan.length, columns.length);
        if (lines.rows) {
            for (let r = Math.max(lines.rows.min, renderStart); r <= lines.rows.max && r < renderEnd; r++) {
                const tr = rowElementAt(r);
                const numCell = tr ? tr.querySelector(':scope > td.row-num-cell') : null;
                if (numCell) numCell.classList.add('row-num-selected');
            }
        }
        if (lines.cols) {
            const headers = tableHead.querySelectorAll('tr:first-child > th[data-col]');
            for (let c = lines.cols.min; c <= lines.cols.max && c < headers.length; c++) {
                headers[c].classList.add('col-selected');
            }
        }
    }

    // Remove the fill handle and the marker that positions it.
    function removeFillHandle() {
        tableBody.querySelectorAll('.fill-handle').forEach(h => h.remove());
        tableBody.querySelectorAll('td.cell-fill-anchor')
            .forEach(td => td.classList.remove('cell-fill-anchor'));
    }

    function rangeBounds() {
        return {
            minR: Math.min(rangeAnchor.r, rangeFocus.r),
            maxR: Math.max(rangeAnchor.r, rangeFocus.r),
            minC: Math.min(rangeAnchor.c, rangeFocus.c),
            maxC: Math.max(rangeAnchor.c, rangeFocus.c)
        };
    }

    function applyCellRangeHighlight() {
        tableBody.querySelectorAll('td.cell-range-selected')
            .forEach(td => td.classList.remove('cell-range-selected'));
        removeFillHandle();
        markSelectedLines();
        if (!rangeAnchor || !rangeFocus) return;
        const { minR, maxR, minC, maxC } = rangeBounds();
        // Only the rows in the DOM can carry the mark; the others get it when
        // they are rendered.
        for (let r = Math.max(minR, renderStart); r <= maxR && r < renderEnd; r++) {
            const tr = rowElementAt(r);
            if (!tr) continue;
            const dataCells = tr.querySelectorAll(':scope > td[data-col]');
            for (let c = minC; c <= maxC && c < dataCells.length; c++) {
                dataCells[c].classList.add('cell-range-selected');
            }
        }
        // Offer the fill handle on the bottom-right corner of the selection.
        if (!fillDragging) {
            const tr = rowElementAt(maxR);
            const cells = tr ? tr.querySelectorAll(':scope > td[data-col]') : null;
            const td = cells ? cells[maxC] : null;
            if (td) {
                td.classList.add('cell-fill-anchor');
                const handle = document.createElement('div');
                handle.className = 'fill-handle';
                handle.title = isSingleCellSelection(rangeAnchor, rangeFocus)
                    ? 'Drag to copy this value onto other cells'
                    : 'Drag to continue the selected values onto further cells';
                td.appendChild(handle);
            }
        }
    }

    // Collect the selected rectangle as a matrix of display strings, stripping
    // thousand separators from numeric columns just like a native grid copy.
    function collectCellRangeMatrix() {
        if (!rangeAnchor || !rangeFocus) return null;
        const { minR, maxR, minC, maxC } = rangeBounds();
        const matrix = [];
        for (let r = minR; r <= maxR && r < renderPlan.length; r++) {
            const tr = rowElementAt(r);
            const dataCells = tr ? tr.querySelectorAll(':scope > td[data-col]') : null;
            const parts = [];
            for (let c = minC; c <= maxC && c < columns.length; c++) {
                const colName = columns[c].name;
                // A row in the DOM is read as shown (an edit in progress
                // included), any other one from the data, the same way.
                const text = dataCells ? (dataCells[c] ? getCellTextContent(dataCells[c]) : '') : modelCellText(renderPlan[r], colName);
                parts.push(isNumericColumn(colName)
                    ? stripThousandSeparators(text, thousandSeparator)
                    : text);
            }
            matrix.push(parts);
        }
        return matrix;
    }

    function copyCellRangeToClipboard() {
        const matrix = collectCellRangeMatrix();
        if (!matrix || matrix.length === 0) return false;
        const tsv = cellRangeToTsv(matrix);
        const html = cellRangeToHtml(matrix);
        // A copy event lets us put both the tab-separated text (Excel) and an
        // HTML table (Teams/Word/Outlook) on the clipboard in one go.
        pendingRangeCopy = { tsv, html };
        const ok = fallbackClipboardCopy(tsv);
        pendingRangeCopy = null;
        if (!ok && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(tsv).catch(() => { /* nothing else to try */ });
        }
        return true;
    }

    function fallbackClipboardCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
        document.body.removeChild(ta);
        return ok;
    }

    // Mark a single data cell as selected, reusing the rectangle highlight.
    function selectSingleCell(md) {
        rangeAnchor = { r: md.r, c: md.c };
        rangeFocus = { r: md.r, c: md.c };
        applyCellRangeHighlight();
    }

    // The contenteditable element a cell edits through: the .cell-content span
    // for a loaded row, or the cell itself for an inserted/duplicated row. Only
    // returns an element for editable cells, so read-only cells never edit.
    function editableElementOf(target) {
        const td = target && target.closest ? target.closest('td[data-col]') : null;
        if (!td || td.parentElement.parentElement !== tableBody) { return null; }
        if (td.getAttribute('data-row') !== null) {
            return td.querySelector('.cell-content.editable-cell');
        }
        return td.classList.contains('editable-cell') ? td : null;
    }

    // True while a cell is in edit mode, so clicks inside it position the caret
    // instead of re-marking the cell.
    function isCellInEditMode(td) {
        if (td.getAttribute('contenteditable') === 'true') { return true; }
        return !!td.querySelector('.cell-content[contenteditable="true"]');
    }

    // Enter edit mode: make the cell editable, focus it and drop a caret at the
    // double-clicked position (falling back to the end of the text).
    function enterCellEditMode(editable, e) {
        clearCellRangeSelection();
        editable.setAttribute('contenteditable', 'true');
        editable.focus();
        placeCaretFromPoint(editable, e.clientX, e.clientY);
    }

    // Make an editable cell editable in place while keeping the text the user
    // just drag-selected, so the next keystroke replaces that selection. A
    // read-only cell keeps its text selected but does not become editable.
    function enterEditKeepingSelection(td) {
        const editable = editableElementOf(td);
        if (!editable) { return; }
        const sel = window.getSelection();
        const saved = (sel && sel.rangeCount) ? sel.getRangeAt(0).cloneRange() : null;
        if (!saved || !editable.contains(saved.startContainer)) { return; }
        editable.setAttribute('contenteditable', 'true');
        editable.focus();
        // Focusing can collapse the selection, so restore the drag-selected range.
        sel.removeAllRanges();
        sel.addRange(saved);
    }

    // Leave edit mode so a later single click marks the cell again.
    function exitCellEditMode(editable) {
        if (editable) { editable.setAttribute('contenteditable', 'false'); }
    }

    // Put the caret where the user double-clicked, or at the end of the value
    // when the point cannot be resolved.
    function placeCaretFromPoint(el, x, y) {
        const sel = window.getSelection();
        if (!sel) { return; }
        let range = null;
        if (document.caretRangeFromPoint) {
            range = document.caretRangeFromPoint(x, y);
        } else if (document.caretPositionFromPoint) {
            const pos = document.caretPositionFromPoint(x, y);
            if (pos) { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); }
        }
        if (!range || !el.contains(range.startContainer)) {
            range = document.createRange();
            range.selectNodeContents(el);
        }
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    }

    // The value of the single selected cell, as a string suitable for the edit
    // path (NULL becomes '' so the fill writes NULL into the target cells).
    function cellFillValue(td) {
        const col = td.getAttribute('data-col');
        const rowAttr = td.getAttribute('data-row');
        let raw;
        if (rowAttr !== null) {
            const idx = parseInt(rowAttr, 10);
            const key = `${idx}:${col}`;
            raw = modifiedCells.has(key) ? modifiedCells.get(key) : allRows[idx][col];
        } else {
            const insAttr = td.getAttribute('data-insert');
            const dupAttr = td.getAttribute('data-dup');
            const entry = insAttr !== null ? insertedRows[parseInt(insAttr, 10)]
                : dupAttr !== null ? duplicatedRows[parseInt(dupAttr, 10)] : null;
            raw = entry ? entry.row[col] : '';
        }
        return (raw === null || raw === undefined) ? '' : String(raw);
    }

    // Begin an Excel-style fill drag from the selection's handle.
    function beginFillDrag() {
        if (!rangeAnchor || !rangeFocus) { return; }
        if (isSingleCellSelection(rangeAnchor, rangeFocus)) {
            const srcTd = dataCellAt(rangeAnchor.r, rangeAnchor.c);
            if (!srcTd) { return; }
            fillSourceValue = cellFillValue(srcTd);
            fillSourceBounds = null;
        } else {
            fillSourceBounds = rangeBounds();
        }
        fillPlan = null;
        fillDragging = true;
        tableBody.classList.add('range-dragging');
        removeFillHandle();
    }

    // Select a block given as {minR, maxR, minC, maxC}.
    function selectBounds(b) {
        rangeAnchor = { r: b.minR, c: b.minC };
        rangeFocus = { r: b.maxR, c: b.maxC };
    }

    // Abandon a fill drag whose mouseup was missed, leaving the data untouched.
    function cancelFillDrag() {
        fillDragging = false;
        fillSourceValue = null;
        if (fillSourceBounds) { selectBounds(fillSourceBounds); }
        fillSourceBounds = null;
        fillPlan = null;
        clearFillPreview();
        tableBody.classList.remove('range-dragging');
        applyCellRangeHighlight();
    }

    // --- Fill preview: while the handle is dragged, every cell the fill would
    // write shows the value it would receive, laid over its current content.
    let fillPreviewKey = '';

    function clearFillPreview() {
        fillPreviewKey = '';
        tableBody.querySelectorAll('td.cell-fill-preview').forEach(td => {
            td.classList.remove('cell-fill-preview');
            td.removeAttribute('data-fill-preview');
        });
    }

    // Whether a fill writes into this cell; mirrors stageCellFill.
    function cellAcceptsFill(td) {
        if (td.getAttribute('data-row') !== null) return isColumnEditable(td.getAttribute('data-col'));
        const ins = td.getAttribute('data-insert');
        if (ins !== null) return !!insertedRows[parseInt(ins, 10)];
        const dup = td.getAttribute('data-dup');
        return dup !== null && !!duplicatedRows[parseInt(dup, 10)];
    }

    // The writes of the current drag: the series of a block, or the copied value
    // of a single cell into every other cell of the dragged rectangle.
    function currentFillWrites() {
        if (fillSourceBounds) return fillPlan ? seriesWritesFor(fillSourceBounds, fillPlan) : [];
        if (!rangeAnchor || !rangeFocus) return [];
        const { minR, maxR, minC, maxC } = rangeBounds();
        const writes = [];
        for (let r = minR; r <= maxR; r++) {
            for (let c = minC; c <= maxC; c++) {
                if (r !== rangeAnchor.r || c !== rangeAnchor.c) writes.push({ r, c, value: fillSourceValue });
            }
        }
        return writes;
    }

    function updateFillPreview() {
        const key = fillSourceBounds
            ? JSON.stringify(fillPlan)
            : JSON.stringify([rangeAnchor, rangeFocus]);
        if (key === fillPreviewKey) return;
        clearFillPreview();
        fillPreviewKey = key;
        currentFillWrites().forEach(w => {
            const td = dataCellAt(w.r, w.c);
            // Only a cell in the DOM can show the preview.
            if (!td || td.virtual || !cellAcceptsFill(td)) return;
            td.setAttribute('data-fill-preview',
                fillPreviewText(w.value, isNumericColumn(td.getAttribute('data-col')), thousandSeparator));
            td.classList.add('cell-fill-preview');
        });
    }

    // Whole-row / whole-column selection: pressing a row number (or the select
    // strip on top of a column header) selects that line, dragging over further
    // row numbers / strips extends it, Shift extends from the current anchor.
    let lineDrag = null; // { kind: 'rows'|'cols', from }
    // The click that ends a column-strip gesture must not sort the column.
    let colSelectEndedAt = 0;

    function selectLines(kind, from, to) {
        const corners = lineSelectionCorners(kind, from, to, renderPlan.length, columns.length);
        if (!corners) return;
        rangeAnchor = corners.anchor;
        rangeFocus = corners.focus;
        applyCellRangeHighlight();
    }

    function beginLineSelection(e, kind, index) {
        const from = (e.shiftKey && rangeAnchor)
            ? (kind === 'rows' ? rangeAnchor.r : rangeAnchor.c)
            : index;
        // Commit a cell that is being edited before the selection replaces it.
        if (document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
        }
        rangeMouseDown = null;
        rangeDragging = false;
        lineDrag = { kind, from };
        tableBody.classList.add('range-dragging');
        if (kind === 'cols') {
            // Header cells are draggable for reordering; that must not start here.
            tableHead.querySelectorAll('tr:first-child > th[data-col]').forEach(th => { th.draggable = false; });
        }
        selectLines(kind, from, index);
        clearNativeTextSelection();
        e.preventDefault();
    }

    // The row or column index of the line under the pointer during a line drag.
    function lineIndexAt(target, kind) {
        if (!target || !target.closest) return -1;
        if (kind === 'rows') {
            return planIndexOf(target.closest('tr'));
        }
        const cell = target.closest('th[data-col], td[data-col]');
        if (!cell || !(tableHead.contains(cell) || tableBody.contains(cell))) return -1;
        return columns.findIndex(c => c.name === cell.getAttribute('data-col'));
    }

    function endLineSelection() {
        if (!lineDrag) return;
        if (lineDrag.kind === 'cols') {
            colSelectEndedAt = Date.now();
            tableHead.querySelectorAll('tr:first-child > th[data-col]').forEach(th => { th.draggable = true; });
        }
        lineDrag = null;
        tableBody.classList.remove('range-dragging');
    }

    tableBody.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        // The handle at the bottom of a row number changes the row's height.
        if (e.target.closest && e.target.closest('.row-resize-handle')) {
            startRowResize(e);
            return;
        }
        // A row number selects the whole row.
        const numCell = e.target.closest ? e.target.closest('td.row-num-cell') : null;
        if (numCell && planIndexOf(numCell.parentElement) >= 0) {
            beginLineSelection(e, 'rows', planIndexOf(numCell.parentElement));
            return;
        }
        // The fill handle of a selected cell starts a copy-drag onto other cells.
        if (e.target.closest && e.target.closest('.fill-handle')) {
            beginFillDrag();
            e.preventDefault();
            return;
        }
        // The run button of an executable cell is a button, not a cell to select.
        if (e.target.closest && e.target.closest('.exec-btn')) return;
        const td = e.target.closest('td[data-col]');
        if (!td || td.parentElement.parentElement !== tableBody) return;
        // A cell already being edited keeps native caret / text-selection behaviour.
        if (isCellInEditMode(td)) return;
        const coords = cellCoords(td);
        if (!coords) return;
        if (e.shiftKey && rangeAnchor) {
            rangeFocus = coords;
            applyCellRangeHighlight();
            clearNativeTextSelection();
            e.preventDefault();
            return;
        }
        // Record a potential drag anchor; a plain click marks the cell on release.
        rangeMouseDown = { td, r: coords.r, c: coords.c };
        rangeDragging = false;
    });

    document.addEventListener('mousemove', (e) => {
        if (lineDrag) {
            if (e.buttons === 0) { endLineSelection(); return; }
            const idx = lineIndexAt(e.target, lineDrag.kind);
            if (idx >= 0) selectLines(lineDrag.kind, lineDrag.from, idx);
            clearNativeTextSelection();
            e.preventDefault();
            return;
        }
        // While dragging the fill handle, extend the fill region to the cell
        // under the cursor (anchored at the source cell).
        if (fillDragging) {
            if (e.buttons === 0) { cancelFillDrag(); return; }
            const ft = e.target && e.target.closest ? e.target.closest('td[data-col]') : null;
            if (!ft || ft.parentElement.parentElement !== tableBody) return;
            const fc = cellCoords(ft);
            if (!fc) return;
            if (fillSourceBounds) {
                // A block extends along one axis only; show source plus new cells.
                fillPlan = planFillExtension(fillSourceBounds, fc);
                const s = fillSourceBounds;
                const t = fillPlan ? fillPlan.target : s;
                selectBounds({
                    minR: Math.min(s.minR, t.minR), maxR: Math.max(s.maxR, t.maxR),
                    minC: Math.min(s.minC, t.minC), maxC: Math.max(s.maxC, t.maxC)
                });
            } else {
                rangeFocus = fc;
            }
            applyCellRangeHighlight();
            updateFillPreview();
            clearNativeTextSelection();
            e.preventDefault();
            return;
        }
        if (!rangeMouseDown) return;
        if (e.buttons === 0) { rangeMouseDown = null; return; }
        const td = e.target && e.target.closest ? e.target.closest('td[data-col]') : null;
        if (!td || td.parentElement.parentElement !== tableBody) return;
        const coords = cellCoords(td);
        if (!coords) return;
        if (!rangeDragging) {
            if (coords.r === rangeMouseDown.r && coords.c === rangeMouseDown.c) return;
            rangeDragging = true;
            rangeAnchor = { r: rangeMouseDown.r, c: rangeMouseDown.c };
            tableBody.classList.add('range-dragging');
            if (document.activeElement && typeof document.activeElement.blur === 'function') {
                document.activeElement.blur();
            }
        }
        rangeFocus = coords;
        applyCellRangeHighlight();
        clearNativeTextSelection();
        e.preventDefault();
    });

    document.addEventListener('mouseup', () => {
        if (lineDrag) {
            endLineSelection();
            return;
        }
        // Releasing a fill-handle drag copies the source value into the region,
        // or continues a block of values as a series.
        if (fillDragging) {
            fillDragging = false;
            tableBody.classList.remove('range-dragging');
            const value = fillSourceValue;
            const source = fillSourceBounds;
            const plan = fillPlan;
            fillSourceValue = null;
            fillSourceBounds = null;
            fillPlan = null;
            clearFillPreview();
            if (!source) {
                fillCellRangeWithValue(value);
            } else if (plan) {
                fillCellRangeWithSeries(source, plan);
            } else {
                selectBounds(source);
                applyCellRangeHighlight();
            }
            rangeMouseDown = null;
            rangeDragging = false;
            return;
        }
        if (rangeMouseDown && !rangeDragging) {
            const sel = window.getSelection();
            const hasText = !!(sel && !sel.isCollapsed && sel.toString().length > 0
                && rangeMouseDown.td.contains(sel.anchorNode));
            const action = resolveMouseRelease(rangeDragging, hasText);
            if (action === 'text') {
                // Text was drag-selected inside the cell: make the cell editable
                // in place (keeping the selection) so typing overwrites it.
                clearCellRangeSelection();
                enterEditKeepingSelection(rangeMouseDown.td);
            } else {
                // Plain click: mark just this cell.
                selectSingleCell(rangeMouseDown);
            }
        }
        rangeMouseDown = null;
        rangeDragging = false;
        tableBody.classList.remove('range-dragging');
    });

    // Double-click a cell to edit it: the previous single-click behaviour.
    tableBody.addEventListener('dblclick', (e) => {
        if (e.target.closest && e.target.closest('.fk-btn, .exec-btn')) return;
        const editable = editableElementOf(e.target);
        if (!editable) return;
        enterCellEditMode(editable, e);
    });

    document.addEventListener('keydown', (e) => {
        // Ctrl/Cmd+Z undoes and Ctrl/Cmd+Y (or Ctrl/Cmd+Shift+Z) redoes the last
        // staged change — grid edit or query-text change — in global order.
        if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
            if (editHistoryShortcutAllowed()) {
                e.preventDefault();
                undoEdit();
                return;
            }
        }
        if ((e.ctrlKey || e.metaKey) && !e.altKey
            && ((e.key === 'y' || e.key === 'Y') || (e.shiftKey && (e.key === 'z' || e.key === 'Z')))) {
            if (editHistoryShortcutAllowed()) {
                e.preventDefault();
                redoEdit();
                return;
            }
        }
        // Enter commits a multi-cell edit (fills the whole selection).
        if (multiEditBounds && e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            blurActiveEditable();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C') && rangeAnchor && rangeFocus) {
            // In the code editor Ctrl+C copies the editor's text (VS Code copies
            // the current line when nothing is selected), never the cell range.
            if (isInCodeEditor(document.activeElement)) { return; }
            const sel = window.getSelection();
            const hasDomSelection = !!(sel && !sel.isCollapsed && sel.toString().length > 0);
            const hasInputSelection = hasTextInputSelection(document.activeElement);
            if (shouldCopyCellRange(true, hasDomSelection, hasInputSelection) && copyCellRangeToClipboard()) {
                e.preventDefault();
            }
            return;
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && rangeAnchor && rangeFocus
            && !isEditingElement(document.activeElement)) {
            // Clear the selected cells to NULL.
            if (setSelectedCellsNull()) {
                e.preventDefault();
            }
            return;
        }
        if (e.key === 'Escape') {
            if (multiEditBounds) {
                cancelMultiEdit();
            } else if (rangeAnchor) {
                clearCellRangeSelection();
            }
            return;
        }
        // Arrow / Home / End / PageUp / PageDown move the selection; holding
        // Shift extends it instead of collapsing to a single cell.
        if (rangeAnchor && rangeFocus && !isEditingElement(document.activeElement)
            && !e.altKey && isCellNavKey(e.key)) {
            if (navigateCellSelection(e.key, e.ctrlKey, e.shiftKey)) {
                e.preventDefault();
            }
            return;
        }
        // Typing over a cell selection overwrites it: a single selected cell is
        // replaced by the typed character, and a multi-cell selection enters a
        // multi-edit that fills the whole block on commit.
        if (typingStartsCellEdit(rangeAnchor && rangeFocus, isPrintableTypingKey(e),
            isEditingElement(document.activeElement))) {
            startMultiEdit(e);
        }
    });

    function isCellNavKey(key) {
        return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft'
            || key === 'ArrowRight' || key === 'Home' || key === 'End'
            || key === 'PageUp' || key === 'PageDown';
    }

    // Number of data columns in the grid.
    function dataColumnCount() {
        return columns.length;
    }

    // Rows that a PageUp/PageDown jumps, derived from how many rows fit in the
    // scroll viewport (at least one), so a page roughly matches what is visible.
    function pageRowCount() {
        const viewH = gridScroller ? gridScroller.clientHeight - headerHeight() : 0;
        const fit = virtualRowHeight > 0 && viewH > 0 ? Math.floor(viewH / virtualRowHeight) : 0;
        return Math.max(1, fit - 1);
    }

    function navigateCellSelection(key, ctrlKey, shiftKey) {
        const target = computeCellNavTarget(
            key, ctrlKey, rangeFocus, renderPlan.length, dataColumnCount(), pageRowCount());
        if (!target) { return false; }
        rangeFocus = target;
        if (!shiftKey) {
            rangeAnchor = { r: target.r, c: target.c };
        }
        // Bring the row into the DOM first, so the highlight lands on it.
        ensureRowRendered(target.r);
        applyCellRangeHighlight();
        scrollCellIntoView(target);
        return true;
    }

    // Bring the focus cell into the scroll viewport after a keyboard move,
    // keeping it clear of the pinned header rows and the frozen left columns
    // that otherwise overlap a cell scrolled to the very top or left edge.
    function scrollCellIntoView(coords) {
        ensureRowRendered(coords.r);
        const tr = rowElementAt(coords.r);
        if (!tr) { return; }
        const cells = tr.querySelectorAll(':scope > td[data-col]');
        const td = cells[coords.c];
        const scroller = document.getElementById('tableWrapper');
        if (!td) { return; }
        if (!scroller) {
            if (td.scrollIntoView) { td.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
            return;
        }
        const headInset = tableHead ? tableHead.getBoundingClientRect().height : 0;
        const leftInset = frozenColumnsWidth(tr);
        const s = scroller.getBoundingClientRect();
        const c = td.getBoundingClientRect();
        const { dTop, dLeft } = computeScrollAdjustment(c, s, headInset, leftInset);
        scroller.scrollTop += dTop;
        scroller.scrollLeft += dLeft;
    }

    // Combined width of the frozen left columns (row number + row actions) of a
    // row, which stay pinned over the data cells as the grid scrolls sideways.
    function frozenColumnsWidth(tr) {
        let w = 0;
        tr.querySelectorAll(':scope > .row-num-cell, :scope > .actions-cell')
            .forEach(cell => { w += cell.getBoundingClientRect().width; });
        return w;
    }

    function blurActiveEditable() {
        const ae = document.activeElement;
        if (ae && typeof ae.blur === 'function') { ae.blur(); }
    }

    // True while the focus is on a cell being edited, on a form control or in
    // the query bar's code editor, where Delete/typing keep their native meaning
    // instead of acting on the selection.
    function isEditingElement(el) {
        return isTextEntryElement(el);
    }

    // Start editing the selection by seeding the anchor (top-left) cell with the
    // typed character; committing fills every cell of the remembered bounds (one
    // cell for a single selection, the whole block for a multi-cell selection).
    function startMultiEdit(e) {
        const b = rangeBounds();
        ensureRowRendered(b.minR);
        const anchorTd = dataCellAt(b.minR, b.minC);
        const editable = anchorTd && !anchorTd.virtual ? editableElementOf(anchorTd) : null;
        if (!editable) { return; }
        multiEditBounds = b;
        editable.setAttribute('contenteditable', 'true');
        editable.textContent = e.key;
        editable.focus();
        placeCaretAtEnd(editable);
        e.preventDefault();
    }

    // Commit a multi-cell edit: write the anchor cell's typed value into every
    // cell of the remembered selection. Called from the cell's blur handler.
    function commitMultiEdit(editable) {
        if (!multiEditBounds) { return; }
        const bounds = multiEditBounds;
        multiEditBounds = null;
        const value = editable.textContent;
        rangeAnchor = { r: bounds.minR, c: bounds.minC };
        rangeFocus = { r: bounds.maxR, c: bounds.maxC };
        fillCellRangeWithValue(value);
    }

    // Abandon a multi-cell edit: keep only the anchor cell's own value.
    function cancelMultiEdit() {
        multiEditBounds = null;
        blurActiveEditable();
    }

    // Move the caret to the end of an editable element's text.
    function placeCaretAtEnd(el) {
        const sel = window.getSelection();
        if (!sel) { return; }
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    }

    // Set every editable cell of the current selection to NULL, keeping the
    // selection so a further edit or Save is easy. Returns false when the
    // result is read-only, so Delete then keeps its default behaviour.
    function setSelectedCellsNull() {
        if (!rangeAnchor || !rangeFocus) { return false; }
        if (!caps.canEdit && !caps.canInsert) { return false; }
        fillCellRangeWithValue('');
        return true;
    }

    function isNumericColumn(colName) {
        const colMeta = columns.find(c => c.name === colName);
        return colMeta ? getColumnFilterType(colMeta.dataType) === 'numeric' : false;
    }

    function handleGridCopy(e) {
        // A rectangle copy routes its two representations through this event.
        if (pendingRangeCopy) {
            e.preventDefault();
            e.clipboardData.setData('text/plain', pendingRangeCopy.tsv);
            e.clipboardData.setData('text/html', pendingRangeCopy.html);
            return;
        }
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;

        // Only act on selections that cover data cells in the grid.
        const cells = Array.from(tableBody.querySelectorAll('td[data-col]'))
            .filter(td => sel.containsNode(td, true));
        if (cells.length === 0) return;

        // Leave native copy untouched unless at least one numeric cell is involved.
        if (!cells.some(td => isNumericColumn(td.getAttribute('data-col')))) return;

        // Single cell: respect a partial in-cell text selection; only normalize
        // when the column is numeric.
        if (cells.length === 1) {
            const td = cells[0];
            if (!isNumericColumn(td.getAttribute('data-col'))) return;
            const selectedText = sel.toString();
            const fullText = getCellTextContent(td);
            const source = (selectedText && selectedText.trim() && selectedText.trim() !== fullText)
                ? selectedText.trim()
                : fullText;
            e.clipboardData.setData('text/plain', stripThousandSeparators(source, thousandSeparator));
            e.preventDefault();
            return;
        }

        // Multiple cells: rebuild tab/newline separated text, normalizing the
        // numeric columns and leaving everything else as displayed.
        const rowMap = new Map();
        for (const td of cells) {
            const tr = td.closest('tr');
            if (!rowMap.has(tr)) rowMap.set(tr, []);
            rowMap.get(tr).push(td);
        }
        const matrix = [];
        for (const rowCells of rowMap.values()) {
            matrix.push(rowCells.map(td => {
                const text = getCellTextContent(td);
                return isNumericColumn(td.getAttribute('data-col'))
                    ? stripThousandSeparators(text, thousandSeparator)
                    : text;
            }));
        }
        e.clipboardData.setData('text/plain', matrix.map(r => r.join('\t')).join('\n'));
        e.clipboardData.setData('text/html', cellRangeToHtml(matrix));
        e.preventDefault();
    }

    // --- Paste a block of Excel cells into the grid -------------------------
    // Ctrl+V over the grid drops the clipboard matrix in Excel style: it
    // overwrites cells from the selected cell down/right and appends new rows
    // when the block is taller than the loaded data.
    document.addEventListener('paste', handleGridPaste);

    // The data cell a paste starts at: the top-left of an active rectangle, else
    // the cell that currently holds the caret. Returns null when neither exists.
    function pasteAnchorTd() {
        if (rangeAnchor && rangeFocus) {
            const { minR, minC } = rangeBounds();
            const anchor = dataCellAt(minR, minC);
            if (anchor) { return anchor; }
        }
        const active = document.activeElement;
        const td = active && active.closest ? active.closest('td[data-col]') : null;
        if (td && td.parentElement && td.parentElement.parentElement === tableBody) {
            return td;
        }
        return null;
    }

    // Translate the anchor cell into a start position in display-order/columns
    // index space. A cell of a displayed loaded row overwrites from there;
    // anything else (an insert row, or no anchor at all) appends after the last
    // displayed row.
    function pasteStartPosition(td, rowOrder) {
        if (td) {
            const colName = td.getAttribute('data-col');
            const ci = columns.findIndex(c => c.name === colName);
            const startCol = ci >= 0 ? ci : 0;
            const rowAttr = td.getAttribute('data-row');
            const pos = rowAttr !== null ? rowOrder.indexOf(parseInt(rowAttr, 10)) : -1;
            return { startPos: pos >= 0 ? pos : rowOrder.length, startCol };
        }
        return { startPos: rowOrder.length, startCol: 0 };
    }

    // Normalize a pasted value for its column: numeric text is de-separated, and
    // a localized dotted date (e.g. 03.11.2011 00:00) is turned into the ISO form
    // Postgres accepts so a spreadsheet date does not paste as an invalid value.
    function normalizePastedCellValue(rawValue, colMeta) {
        const isNumeric = !!colMeta && getColumnFilterType(colMeta.dataType) === 'numeric';
        const value = normalizeCellInput(rawValue, isNumeric, thousandSeparator);
        if (colMeta && !isNumeric && value !== null && value !== '') {
            return localizedDateToIso(value, parsePgType(colMeta.fullType || colMeta.dataType).base);
        }
        return value;
    }

    // Overwrite one loaded-row cell from pasted text, mirroring a manual edit:
    // numeric text is normalized, and a value equal to the original clears the
    // pending change instead of marking it.
    function applyPastedExistingCell(rowIdx, colName, rawValue) {
        const colMeta = columns.find(c => c.name === colName);
        let newValue = normalizePastedCellValue(rawValue, colMeta);
        const original = allRows[rowIdx] ? allRows[rowIdx][colName] : undefined;
        const originalNorm = (original === null || original === undefined) ? null : String(original);
        const modKey = `${rowIdx}:${colName}`;
        if (newValue === '' && originalNorm === null) { newValue = null; }
        if (newValue === originalNorm) {
            modifiedCells.delete(modKey);
            invalidCells.delete(modKey);
            return null;
        }
        const stored = newValue === '' ? null : newValue;
        modifiedCells.set(modKey, stored);
        return { key: modKey, value: stored };
    }

    // Stage `value` into one data cell exactly like a paste does: loaded rows go
    // through the modified-cell map (skipping read-only columns), inserted and
    // duplicated rows are written directly. Cells to validate are collected.
    function stageCellFill(td, value, validationTargets) {
        const colName = td.getAttribute('data-col');
        const rowAttr = td.getAttribute('data-row');
        const insAttr = td.getAttribute('data-insert');
        const dupAttr = td.getAttribute('data-dup');
        if (rowAttr !== null) {
            if (!isColumnEditable(colName)) { return; }
            const t = applyPastedExistingCell(parseInt(rowAttr, 10), colName, value);
            if (t) { validationTargets.push(t); }
        } else if (insAttr !== null && insertedRows[parseInt(insAttr, 10)]) {
            const idx = parseInt(insAttr, 10);
            const normalized = normalizePastedCellValue(value, columns.find(x => x.name === colName));
            insertedRows[idx].row[colName] = normalized;
            validationTargets.push({ key: `ins:${idx}:${colName}`, value: normalized });
        } else if (dupAttr !== null && duplicatedRows[parseInt(dupAttr, 10)]) {
            const idx = parseInt(dupAttr, 10);
            const entry = duplicatedRows[idx];
            const normalized = normalizePastedCellValue(value, columns.find(x => x.name === colName));
            entry.row[colName] = normalized;
            if (entry.defaults) { entry.defaults.delete(colName); }
            validationTargets.push({ key: `dup:${idx}:${colName}`, value: normalized });
        }
    }

    // Re-render after a fill, validate the written cells, keep `bounds` selected
    // and record the whole fill as one undo step.
    function finishCellFill(validationTargets, bounds) {
        renderBody();
        // Every written cell is checked, also those outside the DOM.
        validationTargets.forEach(t => checkCellValue(findCellByKey(t.key), t.key, t.value));
        // renderBody drops the selection; restore it so the filled cells stay
        // marked, then re-highlight the rebuilt tbody.
        selectBounds(bounds);
        applyCellRangeHighlight();
        updateChangeIndicator();
        recordEditHistory();
    }

    // The cell at row r and column c of the display: the <td> when its row is in
    // the DOM, otherwise a stand-in answering getAttribute like one, so a fill,
    // a paste or Delete reaches every cell of the selection.
    function dataCellAt(r, c) {
        const tr = rowElementAt(r);
        if (tr) {
            return tr.querySelectorAll(':scope > td[data-col]')[c] || null;
        }
        const entry = renderPlan[r];
        const col = columns[c];
        if (!entry || !col) return null;
        const attrs = { 'data-col': col.name };
        attrs[entry.kind === 'row' ? 'data-row' : entry.kind === 'insert' ? 'data-insert' : 'data-dup'] = String(entry.idx);
        return { virtual: true, getAttribute: (name) => (name in attrs ? attrs[name] : null) };
    }

    // Fill every cell of the active rectangle with one value, so a single copied
    // value pasted over a multi-cell selection lands in all of them (Excel fill).
    function fillCellRangeWithValue(value) {
        const bounds = rangeBounds();
        const validationTargets = [];
        for (let r = bounds.minR; r <= bounds.maxR; r++) {
            for (let c = bounds.minC; c <= bounds.maxC; c++) {
                const td = dataCellAt(r, c);
                if (td) { stageCellFill(td, value, validationTargets); }
            }
        }
        finishCellFill(validationTargets, bounds);
    }

    // Excel-like series fill: extend the `source` block in `plan.direction`,
    // continuing each column (vertical) or row (horizontal) of the block as a
    // series where its type allows, and repeating its values otherwise.
    function fillCellRangeWithSeries(source, plan) {
        const t = plan.target;
        const validationTargets = [];
        seriesWritesFor(source, plan).forEach(w => {
            const td = dataCellAt(w.r, w.c);
            if (td) { stageCellFill(td, w.value, validationTargets); }
        });
        finishCellFill(validationTargets, {
            minR: Math.min(source.minR, t.minR), maxR: Math.max(source.maxR, t.maxR),
            minC: Math.min(source.minC, t.minC), maxC: Math.max(source.maxC, t.maxC)
        });
    }

    function seriesWritesFor(source, plan) {
        return planSeriesWrites(
            source,
            plan,
            (r, c) => { const td = dataCellAt(r, c); return td ? cellFillValue(td) : ''; },
            (c) => (columns[c] ? seriesKindForType(columns[c].fullType || columns[c].dataType) : '')
        );
    }

    function handleGridPaste(e) {
        const target = e.target;
        // Leave paste into inputs, dialogs, the query bar and its code editor to them.
        if (target && target.closest
            && target.closest('input, textarea, select, .sql-dialog-overlay, .monaco-editor, .query-editor')) {
            return;
        }
        const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
        if (!text) { return; }
        const matrix = parseClipboardTable(text);

        // A single copied value dropped onto a selected cell or block fills every
        // cell of it (Excel fill); with no selection it is left to the browser as
        // an ordinary in-cell paste.
        const lone = singleClipboardValue(matrix);
        if (lone !== null) {
            const hasSelection = !!(rangeAnchor && rangeFocus);
            if (shouldFillLoneValue(hasSelection, caps.canEdit, caps.canInsert)) {
                e.preventDefault();
                fillCellRangeWithValue(lone);
            }
            return;
        }
        if (!caps.canEdit && !caps.canInsert) { return; }
        e.preventDefault();

        const rowOrder = displayedOrder.slice();
        const { startPos, startCol } = pasteStartPosition(pasteAnchorTd(), rowOrder);
        const columnNames = columns.map(c => c.name);
        const plan = planClipboardPaste(matrix, startPos, startCol, rowOrder, columnNames, isColumnEditable);

        const validationTargets = [];
        // Keys of every cell the paste wrote to, so the block can be re-selected.
        const pastedKeys = [];
        plan.cellUpdates.forEach(u => {
            pastedKeys.push(`${u.rowIdx}:${u.colName}`);
            const t = applyPastedExistingCell(u.rowIdx, u.colName, u.value);
            if (t) { validationTargets.push(t); }
        });

        let skippedRows = 0;
        if (plan.newRows.length) {
            if (caps.canInsert) {
                plan.newRows.forEach(partial => {
                    const newRow = {};
                    columns.forEach(col => { newRow[col.name] = ''; });
                    Object.keys(partial).forEach(name => {
                        const colMeta = columns.find(c => c.name === name);
                        newRow[name] = normalizePastedCellValue(partial[name], colMeta);
                    });
                    const insIdx = insertedRows.length;
                    insertedRows.push({ row: newRow, anchor: null });
                    Object.keys(partial).forEach(name => {
                        validationTargets.push({ key: `ins:${insIdx}:${name}`, value: newRow[name] });
                        pastedKeys.push(`ins:${insIdx}:${name}`);
                    });
                });
            } else {
                skippedRows = plan.newRows.length;
            }
        }

        renderBody();
        validationTargets.forEach(t => checkCellValue(findCellByKey(t.key), t.key, t.value));
        // Mark the pasted block so it stays selected after the paste.
        markPastedRegion(pastedKeys);
        updateChangeIndicator();
        recordEditHistory();

        if (skippedRows) {
            vscode.postMessage({
                command: 'showError',
                text: `${skippedRows} pasted row(s) were skipped: new rows can only be added to a result that comes from a single table.`
            });
        }
    }

    // Select the bounding rectangle of the cells a paste wrote to (found by
    // their keys in the display order, in the DOM or not), so the pasted block
    // stays highlighted.
    function markPastedRegion(keys) {
        let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
        keys.forEach(key => {
            const cc = coordsOfKey(key);
            if (!cc) { return; }
            if (cc.r < minR) minR = cc.r;
            if (cc.r > maxR) maxR = cc.r;
            if (cc.c < minC) minC = cc.c;
            if (cc.c > maxC) maxC = cc.c;
        });
        if (maxR < 0) { return; }
        rangeAnchor = { r: minR, c: minC };
        rangeFocus = { r: maxR, c: maxC };
        applyCellRangeHighlight();
    }

    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.command) {
            case 'init':
                handleInit(msg);
                break;
            case 'rowsLoaded':
                if (isStaleLoadAnswer(msg.loadId, latestLoadId)) break;
                handleRowsLoaded(msg);
                break;
            case 'columnsLoaded':
                if (isStaleLoadAnswer(msg.loadId, latestLoadId)) break;
                handleColumnsLoaded(msg);
                break;
            case 'totalCountLoaded':
                if (msg.autoRefreshId && msg.autoRefreshId !== latestLoadId) break;
                if (isStaleLoadAnswer(msg.loadId, latestLoadId)) break;
                totalCount = msg.totalCount;
                updateRowCount();
                break;
            case 'loadingFinished':
                if (isStaleLoadAnswer(msg.loadId, latestLoadId)) break;
                setDataLoading(false);
                break;
            case 'primaryKeysLoaded':
                handlePrimaryKeysLoaded(msg);
                break;
            case 'foreignKeysLoaded':
                handleForeignKeysLoaded(msg);
                break;
            case 'columnDefaultsLoaded':
                columnDefaults = msg.columnDefaults || [];
                break;
            case 'referencingTablesLoaded':
                handleReferencingTablesLoaded(msg);
                break;
            case 'customMappingsLoaded':
                handleCustomMappingsLoaded(msg);
                break;
            case 'cellEditorValue':
                handleCellEditorValue(msg);
                break;
            case 'savedQuerySaved':
                handleSavedQuerySaved(msg);
                break;
            case 'tablesForTypeahead':
                handleTablesForTypeahead(msg);
                break;
            case 'columnsForTypeahead':
                handleColumnsForTypeahead(msg);
                break;

            case 'queryHistoryUpdated':
                updateQueryHistoryDropdown(msg.history);
                break;
            case 'sqlPreview':
                showSqlDialog(msg.sql, msg.connectionName);
                break;
            case 'commitSuccess':
                handleCommitSuccess();
                break;
            case 'applyFilter':
                handleApplyFilter(msg);
                break;
            case 'exportDefaultsLoaded':
                applyExportDefaults(msg.defaults);
                applyExportPrefill();
                break;
            case 'exportDialogInvalid':
                // The dialog stays open with what was entered, to be corrected.
                document.getElementById('exportDialogError').textContent = String(msg.message || '');
                break;
            case 'exportSuccess':
                changeCount.textContent = `Exported to ${msg.filePath}`;
                setTimeout(() => { updateChangeIndicator(); }, 3000);
                break;
            case 'exportLocationSelected':
                if (msg.path) {
                    document.getElementById('exportSaveLocation').value = msg.path;
                }
                break;
            case 'error':
                // A failed load the user has since replaced is already reported
                // by the host; it must not end the newer load's spinner.
                if (isStaleLoadAnswer(msg.loadId, latestLoadId)) break;
                if (msg.autoRefreshId) {
                    // A failing auto refresh is reported once, then switched off.
                    if (!isAutoRefreshAnswer(msg)) break;
                    stopAutoRefresh('Stopped because the query failed');
                }
                showError(msg.text);
                break;
            case 'autoRefreshStopped':
                if (isAutoRefreshAnswer(msg)) stopAutoRefresh(msg.reason || 'Stopped');
                break;
            case 'autoRefreshSkipped':
                if (isAutoRefreshAnswer(msg)) {
                    autoRefreshInFlight = null;
                    setAutoRefreshBusyIndicator(false);
                    setAutoRefreshStatus(AUTO_REFRESH_PAUSE_LABELS[msg.reason] || '');
                    scheduleAutoRefresh();
                }
                break;
            case 'autoRefreshIntervalChosen':
                if (typeof msg.seconds === 'number' && msg.seconds > 0) {
                    setAutoRefreshInterval(msg.seconds);
                } else {
                    renderAutoRefreshSelect();
                }
                break;
            case 'viewStateChanged':
                panelVisible = msg.visible !== false;
                break;
            case 'validationResult':
                handleValidationResult(msg);
                break;
            case 'connectionChanged':
                currentConnection = msg.connectionName || '';
                updateConnectionDisplay();
                break;
            case 'sessionInfo':
                updateSessionDisplay(msg.session);
                break;
            case 'executableValueDone':
                handleExecutableValueDone(msg);
                break;
            case 'executableTypeChosen':
                if (typeof msg.prefix === 'string') makeColumnExecutable(String(msg.column || ''), msg.prefix);
                break;
        }
    });

    function handleInit(msg) {
        schema = msg.schema || '';
        table = msg.table || '';
        tableReference = msg.tableReference || '';
        alwaysQuote = Boolean(msg.alwaysQuote);
        completionTableAlias = msg.completionTableAlias !== false;
        qualifyColumnsWithAlias = Boolean(msg.qualifyColumnsWithAlias);
        tableAlias = typeof msg.tableAlias === 'string' ? msg.tableAlias : '';
        newMappingDefaultWorkspace = Boolean(msg.newMappingDefaultWorkspace);
        permanentConstraints = Array.isArray(msg.permanentConstraints) ? msg.permanentConstraints : [];
        permanentSorts = Array.isArray(msg.permanentSorts) ? msg.permanentSorts : [];
        if (msg.thousandSeparator !== undefined) { thousandSeparator = sanitizeThousandSeparator(msg.thousandSeparator); }
        if (typeof msg.duplicateRowResetDefaults === 'string') { duplicateResetMode = msg.duplicateRowResetDefaults; }
        if (typeof msg.connectionName === 'string') {
            currentConnection = msg.connectionName;
            updateConnectionDisplay();
        }

        // An Export tab shows only the export dialog and runs nothing.
        if (msg.exportOnly) {
            tableName.textContent = msg.title || 'Export';
            startExportOnly(msg.exportOnly, msg.title);
            return;
        }

        tableName.textContent = msg.title || (table ? `${schema}.${table}` : 'Query result');
        savedQueryId = typeof msg.savedQueryId === 'string' ? msg.savedQueryId : '';
        savedQueryParameters = Array.isArray(msg.savedQueryParameters) ? msg.savedQueryParameters : [];
        savedQueryValues = msg.savedQueryValues && typeof msg.savedQueryValues === 'object' ? msg.savedQueryValues : {};
        savedQueryTemplate = msg.sql || '';
        updateQueryParamsButton();
        // Both entry points start by running a query: a table view simply starts
        // with the default query for that table.
        setQueryText(msg.sql || getDefaultQuery());
        applyCapabilities(caps);
        if (msg.awaitParameters && savedQueryParameters.length) {
            // The template cannot run as-is: ask for the placeholder values and
            // let the dialog trigger the first query.
            openQueryParamsDialog(true);
        } else {
            runQuery();
        }
        vscode.postMessage({ command: 'getQueryHistory' });
    }

    // The "Parameters…" button only makes sense while a parameterized template
    // is loaded in this panel.
    function updateQueryParamsButton() {
        if (!queryParamsBtn) return;
        queryParamsBtn.style.display = savedQueryParameters.length ? '' : 'none';
    }

    // Enable/disable the affordances that depend on what the current result
    // allows: editing needs rows that can be traced back to a table, while
    // inserting, deleting, constraints and mappings need a single source table.
    function applyCapabilities(next) {
        caps = normalizeCapabilities(next);
        const toggle = (btn, enabled) => {
            if (btn) { btn.style.display = enabled ? '' : 'none'; }
        };
        toggle(insertRowBtn, caps.canInsert);
        toggle(commitBtn, caps.canEdit || caps.canInsert || caps.canDelete);
        toggle(discardBtn, caps.canEdit || caps.canInsert || caps.canDelete);
        toggle(constraintsBtn, caps.canConstrain);
        // Group edit rewrites the current query into an UPDATE/DELETE for its
        // base table, so it needs a result that traces back to an editable table.
        toggle(groupUpdateBtn, caps.canEdit);
        toggle(groupDeleteBtn, caps.canEdit);
        // Relation metadata is only fetched for a single source table; without
        // one nothing will arrive and the indicator must not keep spinning.
        // It is shown by handleRowsLoaded, for the loads the metadata follows.
        if (!caps.table) {
            metaLoading.classList.add('hidden');
        }
    }

    // True when a specific result column can be written back to its table.
    function isColumnEditable(colName) {
        return caps.canEdit && caps.editableColumns.indexOf(colName) !== -1;
    }

    function handleColumnsLoaded(msg) {
        // Columns arrive before the (possibly slow) row query finishes. Render
        // the header right away so the grid structure and the "Constraints"
        // editor become usable while data is still loading.
        const wasDefaultQuery = isDefaultQueryText(queryInput.value);
        columns = msg.columns || [];
        applyCapabilities(msg.capabilities);
        adoptSourceTable(msg);
        renderHeader();
        // Now that the columns are known, refresh an untouched default query so
        // it lists all columns explicitly instead of the `*` placeholder.
        if (wasDefaultQuery) {
            setQueryText(getDefaultQuery());
        }
    }

    // Take over the table a result originates from, so table-bound features
    // (default query, constraints, mappings) work for ad-hoc queries too.
    function adoptSourceTable(msg) {
        if (!msg.table) { return; }
        schema = msg.schema || '';
        table = msg.table;
        tableReference = msg.tableReference || '';
        if (msg.alwaysQuote !== undefined) { alwaysQuote = Boolean(msg.alwaysQuote); }
        if (Array.isArray(msg.permanentConstraints)) { permanentConstraints = msg.permanentConstraints; }
        if (Array.isArray(msg.permanentSorts)) { permanentSorts = msg.permanentSorts; }
    }

    function handleRowsLoaded(msg) {
        const incoming = msg.rows || [];
        const isAppend = !!msg.append;
        // An auto refresh answer the user has since replaced with a run of
        // their own is dropped, so it cannot overwrite the newer result.
        if (msg.autoRefresh && !isAutoRefreshAnswer(msg)) return;
        const auto = !!msg.autoRefresh && !isAppend;
        const autoLimit = auto ? autoRefreshInFlight.limit : null;
        const viewState = auto ? captureGridViewState() : null;
        const keepHistory = auto && !editHistoryHasGridEdits(editHistory);
        const previousTotal = totalCount;
        if (auto) {
            autoRefreshInFlight = null;
            currentOffset = 0;
        }
        appendPending = false;
        if (isFreshRowLoad(currentOffset, isAppend)) {
            allRows = incoming;
            // A fresh load replaces the row set entirely; any pending edits
            // refer to the previous rows and must not leak onto the newly loaded
            // ones (which share the same 0-based indices).
            resetPendingChanges();
            // Row heights and grown column widths belonged to the old rows; an
            // auto refresh shows the same rows again and keeps them.
            if (!auto) {
                rowContentHeights.clear();
                rowExtraHeights.clear();
                autoColumnWidths = {};
                applyColumnWidths();
            }
        } else {
            allRows = allRows.concat(incoming);
        }
        columns = msg.columns || columns;
        if (!isAppend) {
            applyCapabilities(msg.capabilities);
            adoptSourceTable(msg);
            // An auto refresh re-runs the same query, so the host sends no
            // relations for it and the indicator stays hidden.
            if (expectsRelationMetadata(msg, caps.table)) {
                fkLoaded = false;
                refsLoaded = false;
                metaLoading.classList.remove('hidden');
            }
            // Without an explicit count the total is unknown until requested.
            // An auto refresh keeps the last count until the new one arrives.
            totalCount = auto ? previousTotal : null;
        }
        if (typeof msg.connectionName === 'string') {
            lastUsedConnection = msg.connectionName;
            if (!currentConnection) { currentConnection = msg.connectionName; }
            updateConnectionDisplay();
        }

        if (table) {
            tableName.textContent = `${schema}.${table}`;
        }
        // A full last batch means there may be more rows to page through.
        moreAvailable = !userPaged && !allLoaded && incoming.length >= (autoLimit || PAGE_SIZE);
        lastQueryDurationMs = (typeof msg.durationMs === 'number') ? msg.durationMs : null;
        if (viewState && viewState.selectedRowIdx !== null && viewState.selectedRowIdx < allRows.length) {
            selectedRowIdx = viewState.selectedRowIdx;
        }
        setDataLoading(false);
        updateRowCount();
        renderTable();
        // A fresh result is the new baseline: per-row-index snapshots from the
        // previous rows no longer map, so the undo history starts over here.
        // An auto refresh keeps a history that holds only query-text changes.
        if (isFreshRowLoad(currentOffset, isAppend) && !keepHistory) {
            resetEditHistory();
        }
        if (auto) {
            // "More" continues after the rows the refresh brought back.
            if (autoLimit) currentOffset = Math.max(0, autoLimit - PAGE_SIZE);
            restoreGridViewState(viewState);
            autoRefreshSucceeded();
        } else if (!isAppend) {
            // The interval counts from the latest fresh result.
            scheduleAutoRefresh();
        }
    }

    let fkLoaded = false;
    let refsLoaded = false;

    function handlePrimaryKeysLoaded(msg) {
        primaryKeys = msg.primaryKeys || [];
    }

    function handleForeignKeysLoaded(msg) {
        foreignKeys = msg.foreignKeys || [];
        fkLoaded = true;
        checkMetaComplete();
        renderBody();
    }

    function handleReferencingTablesLoaded(msg) {
        referencingTables = msg.referencingTables || [];
        refsLoaded = true;
        checkMetaComplete();
        renderBody();
    }

    function handleCustomMappingsLoaded(msg) {
        customMappings = msg.mappings || [];
        renderBody();
    }

    function checkMetaComplete() {
        if (fkLoaded && refsLoaded) {
            metaLoading.classList.add('hidden');
        }
    }

    function updateQueryHistoryDropdown(history) {
        queryHistoryEntries = Array.isArray(history) ? history.slice() : [];
        if (queryHistoryPanel.style.display !== 'none') {
            renderQueryHistoryList();
        }
    }

    function toggleQueryHistoryPanel() {
        if (queryHistoryPanel.style.display === 'none') {
            openQueryHistoryPanel();
        } else {
            closeQueryHistoryPanel();
        }
    }

    function openQueryHistoryPanel() {
        queryHistorySearch.value = '';
        queryHistoryActiveIdx = -1;
        renderQueryHistoryList();
        queryHistoryPanel.style.display = 'flex';
        // Focus search input after layout
        setTimeout(() => queryHistorySearch.focus(), 0);
    }

    function closeQueryHistoryPanel() {
        queryHistoryPanel.style.display = 'none';
    }

    function renderQueryHistoryList() {
        const term = queryHistorySearch.value.trim().toLowerCase();
        const filtered = term
            ? queryHistoryEntries.filter(e => e.sql.toLowerCase().includes(term))
            : queryHistoryEntries;

        if (!filtered.length) {
            queryHistoryList.innerHTML = '';
            queryHistoryEmpty.style.display = 'block';
            queryHistoryEmpty.textContent = queryHistoryEntries.length === 0
                ? 'No history yet'
                : 'No matching history';
            return;
        }
        queryHistoryEmpty.style.display = 'none';

        let html = '';
        filtered.forEach(entry => {
            html += `<li data-sql="${escapeAttr(entry.sql)}" title="${escapeAttr(entry.sql)}">${highlightMatch(entry.sql, term)}</li>`;
        });
        queryHistoryList.innerHTML = html;

        queryHistoryList.querySelectorAll('li').forEach(li => {
            li.addEventListener('click', () => {
                selectQueryHistoryItem(li.getAttribute('data-sql'));
            });
            li.addEventListener('mouseenter', () => {
                const items = Array.from(queryHistoryList.querySelectorAll('li'));
                queryHistoryActiveIdx = items.indexOf(li);
                highlightActiveHistoryItem(items);
            });
        });
    }

    function highlightMatch(text, term) {
        if (!term) return escapeHtml(text);
        const lower = text.toLowerCase();
        let out = '';
        let i = 0;
        while (i < text.length) {
            const idx = lower.indexOf(term, i);
            if (idx === -1) {
                out += escapeHtml(text.substring(i));
                break;
            }
            out += escapeHtml(text.substring(i, idx));
            out += '<mark>' + escapeHtml(text.substring(idx, idx + term.length)) + '</mark>';
            i = idx + term.length;
        }
        return out;
    }

    function highlightActiveHistoryItem(items) {
        items.forEach((li, i) => {
            li.classList.toggle('active', i === queryHistoryActiveIdx);
        });
        if (queryHistoryActiveIdx >= 0 && items[queryHistoryActiveIdx]) {
            items[queryHistoryActiveIdx].scrollIntoView({ block: 'nearest' });
        }
    }

    function selectQueryHistoryItem(sql) {
        if (sql == null) return;
        setQueryText(sql);
        closeQueryHistoryPanel();
        queryInput.focus();
    }

    // Run the query currently shown in the query bar. This is the single data
    // path of the viewer: the default table view is just the query the panel
    // was opened with.
    function runQuery() {
        const raw = queryInput.value.trim();
        if (!raw) return;
        // Save to history (raw, user-entered form)
        vscode.postMessage({ command: 'saveQueryHistory', sql: raw });
        const stripped = stripTrailingLimitOffset(raw);
        currentSql = stripped.base;
        userPaged = stripped.hadLimit;
        currentOffset = 0;
        appendPending = false;
        allLoaded = false;
        moreAvailable = false;
        const sql = userPaged ? raw : (currentSql + ' LIMIT ' + PAGE_SIZE + ' OFFSET 0');
        const wantTotal = !userPaged && isDefaultQueryText(raw);
        lastRunRawSql = raw;
        lastRunWantTotal = wantTotal;
        // A run started by the user supersedes an auto refresh still on its way.
        autoRefreshInFlight = null;
        latestLoadId = ++loadCounter;
        setDataLoading(true);
        // An exact row count is cheap and expected for the plain table view, but
        // can be very expensive for an arbitrary query — there it is only
        // counted when the user asks for it.
        vscode.postMessage({
            command: 'loadRows',
            sql,
            baseSql: currentSql,
            append: false,
            wantTotal,
            loadId: latestLoadId
        });
    }

    // True when the query bar still shows the untouched default query of the
    // current table.
    function isDefaultQueryText(sql) {
        if (!table) return false;
        return collapseSqlWhitespace(String(sql || '')).trim().toLowerCase()
            === collapseSqlWhitespace(getDefaultQuery()).trim().toLowerCase();
    }

    function handleApplyFilter(msg) {
        // When opening a related table via FK/PK/custom mapping, only prefilter via
        // the SELECT clause and leave the column filter row empty.
        applyExactMatchToQuery(msg.column, msg.value, msg.conditions);
    }

    function applyExactMatchToQuery(colName, value, extraConditions) {
        if (!canApplyQueryFilters(queryInput.value)) return;
        if (value === null || value === undefined) return;
        const colMeta = columns.find(c => c.name === colName);
        const filterType = colMeta ? getColumnFilterType(colMeta.dataType) : 'text';
        const fmtCol = formatIdentifier(colName);
        const formatted = formatExactMatchValue(String(value), filterType, thousandSeparator);
        const clausesByCol = { [colName]: `${fmtCol} = ${formatted}` };
        // Append any custom-mapping conditions (e.g. from a reverse mapping) so
        // the navigation target is filtered by the full mapping definition.
        (extraConditions || []).forEach(cond => {
            if (!cond || !cond.column || cond.column === colName) return;
            const clause = buildMappingConditionClause(cond);
            if (clause) clausesByCol[cond.column] = clause;
        });
        mergeWhereClausesIntoQuery(clausesByCol);
        runQuery();
    }

    function buildMappingConditionClause(cond) {
        if (!cond || !cond.column) return '';
        const fmtCol = formatIdentifier(cond.column);
        const colMeta = columns.find(c => c.name === cond.column);
        const filterType = colMeta ? getColumnFilterType(colMeta.dataType) : 'text';
        return mappingConditionToClause(cond, fmtCol, filterType, thousandSeparator);
    }

    function applyNullConstraint(colName, isNull) {
        const fmtCol = formatIdentifier(colName);
        const clause = buildNullConstraintClause(fmtCol, isNull);
        mergeWhereClausesIntoQuery({ [colName]: clause });
        runQuery();
    }

    function mergeWhereClausesIntoQuery(clausesByCol) {
        const baseSql = (queryInput.value || '').trim() || `SELECT * FROM ${getDefaultTableReference()}`;
        const parsed = parseSqlForWhere(baseSql);
        const existing = mergeWhereClauses(parsed.where ? splitWhereByAnd(parsed.where) : [], clausesByCol);
        let sql = parsed.base;
        if (existing.length > 0) sql += ` WHERE ${existing.join(' AND ')}`;
        if (parsed.orderBy) sql += ` ORDER BY ${parsed.orderBy}`;
        setQueryText(sql);
    }

    function updateRowCount() {
        const showing = allRows.length + insertedRows.length + duplicatedRows.length;
        const time = formatExecutionTime(lastQueryDurationMs);
        const known = typeof totalCount === 'number';
        rowCount.textContent = describeRowCount(showing, totalCount, moreAvailable) + (time ? ` · ${time}` : '');
        rowCount.classList.toggle('clickable', !known);
        rowCount.title = known ? '' : 'Click to count all rows of this query';
        const noMore = known ? remainingRowCount(allRows.length, totalCount) === 0 : !moreAvailable;
        loadMoreBtn.disabled = noMore;
        loadAllBtn.disabled = noMore;
    }

    function getColumnFilterType(dataType) {
        if (!dataType) return 'text';
        const dt = dataType.toLowerCase();
        if (dt.includes('timestamp') || dt === 'date') return 'date';
        if (dt.includes('int') || dt === 'numeric' || dt === 'decimal' ||
            dt === 'real' || dt === 'double precision' || dt === 'smallint' ||
            dt === 'bigint' || dt.includes('float') || dt === 'money') return 'numeric';
        return 'text';
    }

    function getInputTypeForColumn(col) {
        const filterType = getColumnFilterType(col.dataType);
        if (filterType === 'date') {
            const dt = col.dataType.toLowerCase();
            if (dt.includes('timestamp')) return 'datetime-local';
            return 'date';
        }
        if (filterType === 'numeric') return 'text';
        return 'text';
    }

    function getMaxFormattedWidth(colName) {
        let maxLen = 5; // minimum width in characters
        for (const row of allRows) {
            const val = row[colName];
            if (val === null || val === undefined) continue;
            const formatted = formatNumberDisplay(val, thousandSeparator);
            if (formatted && formatted.length > maxLen) {
                maxLen = formatted.length;
            }
        }
        return maxLen;
    }

    function getFilterOperator(col) {
        return filterOperatorForMode(filterModes[col] || 'equals');
    }

    function renderTable() {
        renderHeader();
        renderBody();
        updateChangeIndicator();
    }

    // Wire up drag-and-drop reordering for a header cell. Dragging a column
    // header onto another column moves it to that position; the change is
    // reflected both in the grid and in the SELECT column order in the query
    // bar (for the standard table view).
    function attachColumnDragHandlers(th) {
        th.addEventListener('dragstart', (e) => {
            dragSourceCol = th.getAttribute('data-col');
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'move';
                // Firefox requires some data to be set for the drag to start.
                try { e.dataTransfer.setData('text/plain', dragSourceCol); } catch (_) { /* ignore */ }
            }
            th.classList.add('col-dragging');
        });
        th.addEventListener('dragover', (e) => {
            if (dragSourceCol === null) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
            if (th.getAttribute('data-col') !== dragSourceCol) {
                th.classList.add('col-drop-target');
            }
        });
        th.addEventListener('dragleave', () => {
            th.classList.remove('col-drop-target');
        });
        th.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            th.classList.remove('col-drop-target');
            moveColumn(dragSourceCol, th.getAttribute('data-col'));
            dragSourceCol = null;
        });
        th.addEventListener('dragend', () => {
            dragSourceCol = null;
            tableHead.querySelectorAll('.col-dragging, .col-drop-target').forEach(el => {
                el.classList.remove('col-dragging', 'col-drop-target');
            });
        });
    }

    // Move column `fromCol` in front of / onto `toCol`, update the grid and
    // reflect the new order in the query bar. The SELECT column expressions in
    // the current query text are reordered in place, so manual edits (aliases,
    // removed columns, custom WHERE/ORDER BY, a run custom query) are preserved.
    // Only when the current text cannot be reordered by column index (e.g. a
    // `SELECT *` fallback) does the standard table view regenerate its default
    // query.
    function moveColumn(fromCol, toCol) {
        if (!fromCol || !toCol || fromCol === toCol) return;
        const fromIndex = columns.findIndex(c => c.name === fromCol);
        const toIndex = columns.findIndex(c => c.name === toCol);
        if (fromIndex < 0 || toIndex < 0) return;
        columns = reorderColumns(columns, fromIndex, toIndex);
        renderTable();
        const reordered = reorderSelectColumns((queryInput.value || '').trim(), fromIndex, toIndex);
        if (reordered) {
            setQueryText(reordered);
        } else if (table) {
            setQueryText(getDefaultQuery());
        }
    }

    function renderHeader() {
        let html = '<tr>';
        html += '<th class="row-num-cell">#</th>';
        html += '<th class="actions-cell">Actions</th>';
        columns.forEach(col => {
            let cls = '';
            if (sortState.column === col.name) {
                cls = sortState.direction === 'asc' ? 'sorted-asc' : 'sorted-desc';
            }
            cls += ` col-${columnWriteMode(caps, col.name)}`;
            const commentTitle = buildColumnHeaderTitle(col);
            const titleAttr = commentTitle ? ` title="${escapeAttr(commentTitle)}"` : '';
            const commentMark = commentTitle ? ' <span class="col-comment-indicator" aria-hidden="true">🛈</span>' : '';
            const execType = executableTypeOfColumn(col.name, caps.columnSources[col.name]);
            const execMark = execType
                ? `<span class="col-exec-indicator" title="${escapeAttr(`Executable column: ${execType.label}. Every value has a button for it.`)}">${executableIcon(execType.kind)}</span>`
                : '';
            html += `<th class="${cls}" draggable="true" data-col="${escapeAttr(col.name)}"${titleAttr}><div class="col-select-strip" title="Click to select this column, drag to select several columns"></div>${escapeHtml(col.name)}${execMark}${commentMark}<br><small class="col-type">${escapeHtml(formatColumnTypeLabel(col))}</small><div class="col-resize-handle" title="Drag to change column width"></div></th>`;
        });
        html += '</tr>';

        html += '<tr class="filter-row">';
        html += '<th class="row-num-cell"></th>';
        html += '<th class="actions-cell"></th>';
        columns.forEach(col => {
            const filterType = getColumnFilterType(col.dataType);
            const inputType = getInputTypeForColumn(col);
            const mode = filterModes[col.name] || (filterType === 'text' ? 'contains' : 'equals');
            const val = filters[col.name] || '';

            html += `<th data-col="${escapeAttr(col.name)}"><div class="filter-cell">`;

            if (filterType === 'date' || filterType === 'numeric') {
                html += `<select class="filter-mode-select" data-col="${escapeAttr(col.name)}">`;
                html += `<option value="equals"${mode === 'equals' ? ' selected' : ''}>=</option>`;
                html += `<option value="not_equals"${mode === 'not_equals' ? ' selected' : ''}>!=</option>`;
                html += `<option value="gt"${mode === 'gt' ? ' selected' : ''}>&gt;</option>`;
                html += `<option value="gte"${mode === 'gte' ? ' selected' : ''}>&gt;=</option>`;
                html += `<option value="lt"${mode === 'lt' ? ' selected' : ''}>&lt;</option>`;
                html += `<option value="lte"${mode === 'lte' ? ' selected' : ''}>&lt;=</option>`;
                html += `<option value="between"${mode === 'between' ? ' selected' : ''}>Between</option>`;
                html += `</select>`;

                const numWidthStyle = (filterType === 'numeric') ? ` style="--col-w:${getMaxFormattedWidth(col.name) + 2}ch"` : '';

                if (mode === 'between') {
                    const rangeVal = (typeof val === 'object' && val !== null) ? val : { from: '', to: '' };
                    const langAttr = (filterType === 'date') ? ' lang="en-GB"' : '';
                    const fromDisplay = (filterType === 'numeric' && rangeVal.from) ? escapeAttr(formatNumberDisplay(rangeVal.from, thousandSeparator) || rangeVal.from) : escapeAttr(rangeVal.from || '');
                    const toDisplay = (filterType === 'numeric' && rangeVal.to) ? escapeAttr(formatNumberDisplay(rangeVal.to, thousandSeparator) || rangeVal.to) : escapeAttr(rangeVal.to || '');
                    html += `<input class="filter-input filter-input-range" type="${inputType}"${langAttr} data-col="${escapeAttr(col.name)}" data-range="from" placeholder="From" value="${fromDisplay}"${numWidthStyle}${inputType === 'number' ? ' step="any"' : ''}>`;
                    html += `<input class="filter-input filter-input-range" type="${inputType}"${langAttr} data-col="${escapeAttr(col.name)}" data-range="to" placeholder="To" value="${toDisplay}"${numWidthStyle}${inputType === 'number' ? ' step="any"' : ''}>`;
                } else {
                    const singleVal = (typeof val === 'string') ? val : '';
                    const langAttr = (filterType === 'date') ? ' lang="en-GB"' : '';
                    const displayVal = (filterType === 'numeric' && singleVal) ? escapeAttr(formatNumberDisplay(singleVal, thousandSeparator) || singleVal) : escapeAttr(singleVal);
                    html += `<input class="filter-input" type="${inputType}"${langAttr} data-col="${escapeAttr(col.name)}" placeholder="Filter..." value="${displayVal}"${numWidthStyle}${inputType === 'number' ? ' step="any"' : ''}>`;
                }
            } else {
                // Text filter (ILIKE)
                const singleVal = (typeof val === 'string') ? val : '';
                html += `<input class="filter-input" type="text" data-col="${escapeAttr(col.name)}" placeholder="Filter..." value="${escapeAttr(singleVal)}">`;
            }

            html += '</div></th>';
        });
        html += '</tr>';

        tableHead.innerHTML = html;
        updateStickyFilterOffset();

        tableHead.querySelectorAll('tr:first-child th[data-col]').forEach(th => {
            th.addEventListener('click', (e) => {
                if (Date.now() - colResizeEndedAt < 200) return;
                if (Date.now() - colSelectEndedAt < 200) return;
                if (e.target.closest && e.target.closest('.col-select-strip')) return;
                sortState = nextSortState(sortState, th.getAttribute('data-col'));
                renderTable();
            });
            th.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                showHeaderContextMenu(e, th.getAttribute('data-col'));
            });
            const resizeHandle = th.querySelector('.col-resize-handle');
            if (resizeHandle) {
                resizeHandle.addEventListener('mousedown', startColumnResize);
            }
            const selectStrip = th.querySelector('.col-select-strip');
            if (selectStrip) {
                selectStrip.addEventListener('mousedown', (e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    const idx = columns.findIndex(c => c.name === th.getAttribute('data-col'));
                    if (idx >= 0) beginLineSelection(e, 'cols', idx);
                });
            }
            attachColumnDragHandlers(th);
        });

        tableHead.querySelectorAll('.filter-input').forEach(input => {
            const col = input.getAttribute('data-col');
            const colMeta = columns.find(c => c.name === col);
            const filterType = colMeta ? getColumnFilterType(colMeta.dataType) : 'text';

            input.addEventListener('input', (e) => {
                const range = e.target.getAttribute('data-range');
                delete exactFilters[col]; // Manual input = not exact

                // For numeric inputs: live-format with thousand separators
                if (filterType === 'numeric') {
                    const cursorPos = e.target.selectionStart;
                    const oldVal = e.target.value;
                    // Count digits (non-separator chars) before cursor
                    const digitsBefore = oldVal.substring(0, cursorPos).split(thousandSeparator).join('').length;
                    const result = liveFormatNumeric(oldVal, digitsBefore, thousandSeparator);
                    if (result) {
                        e.target.value = result.formatted;
                        e.target.setSelectionRange(result.newCursor, result.newCursor);
                    }
                    // Store the normalized (raw) value in filters
                    const normalized = result ? result.normalized : normalizeNumericInput(oldVal, thousandSeparator);
                    if (range) {
                        if (typeof filters[col] !== 'object' || filters[col] === null) {
                            filters[col] = { from: '', to: '' };
                        }
                        filters[col][range] = normalized;
                    } else {
                        filters[col] = normalized;
                    }
                } else {
                    if (range) {
                        // Between mode - store as object
                        if (typeof filters[col] !== 'object' || filters[col] === null) {
                            filters[col] = { from: '', to: '' };
                        }
                        filters[col][range] = e.target.value;
                    } else {
                        filters[col] = e.target.value;
                    }
                }
                renderBody();
            });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    applyFiltersToQuery();
                }
            });
        });

        tableHead.querySelectorAll('.filter-mode-select').forEach(select => {
            select.addEventListener('change', (e) => {
                const col = e.target.getAttribute('data-col');
                const oldMode = filterModes[col] || 'equals';
                const newMode = e.target.value;
                filterModes[col] = newMode;

                // Preserve value when switching between single-value modes
                if (newMode === 'between' && oldMode !== 'between') {
                    const oldVal = (typeof filters[col] === 'string') ? filters[col] : '';
                    filters[col] = { from: oldVal, to: '' };
                } else if (newMode !== 'between' && oldMode === 'between') {
                    const oldRange = (typeof filters[col] === 'object' && filters[col] !== null) ? filters[col] : { from: '' };
                    filters[col] = oldRange.from || '';
                }
                // Otherwise keep filters[col] as-is

                delete exactFilters[col];
                renderHeader();
            });
        });
    }

    // Pin the sticky filter row directly below the (variable-height, two-line)
    // column header row. The header height isn't fixed — it depends on the
    // column name/data-type text and wrapping — so measure the first header row
    // and expose its height as a CSS variable that the filter row's `top` uses.
    function updateStickyFilterOffset() {
        const headerRow = tableHead.querySelector('tr:first-child');
        if (!headerRow) return;
        const height = headerRow.getBoundingClientRect().height;
        if (height > 0) {
            tableHead.style.setProperty('--header-row-height', `${Math.round(height)}px`);
        }
        // The action column pins right behind the row numbers, whose width grows
        // with the highest row number on screen.
        const numCell = headerRow.querySelector('th.row-num-cell');
        const numWidth = numCell ? numCell.getBoundingClientRect().width : 0;
        if (numWidth > 0) {
            dataTable.style.setProperty('--row-num-width', `${Math.round(numWidth)}px`);
        }
        // The header can appear or rewrap while a load is still running.
        if (dataLoadingOverlay && dataLoadingOverlay.classList.contains('visible')) {
            setDataLoading(true);
        }
    }

    function applyFiltersToQuery() {
        if (!canApplyQueryFilters(queryInput.value)) return;

        const newClausesByCol = {};
        for (const col of columns) {
            const val = filters[col.name];
            if (val === undefined) continue; // never filtered -> leave the query as it is
            const filterType = getColumnFilterType(col.dataType);
            // An emptied filter box yields no clause, which removes the column
            // from the WHERE clause on merge.
            newClausesByCol[col.name] = val
                ? buildFilterClause(
                    formatColumnReference(col.name), val, filterType,
                    !!exactFilters[col.name], getFilterOperator(col.name), thousandSeparator
                )
                : '';
        }

        // Merge into the existing SQL, preserving user-written clauses.
        mergeWhereClausesIntoQuery(newClausesByCol);
        runQuery();
    }

    function showCellContextMenu(e, td) {
        const colName = td.getAttribute('data-col');
        const rowIdx = td.getAttribute('data-row');
        let cellValue = null;
        if (rowIdx !== null) {
            const idx = parseInt(rowIdx);
            const modKey = `${idx}:${colName}`;
            cellValue = modifiedCells.has(modKey) ? modifiedCells.get(modKey) : allRows[idx][colName];
        }

        const items = [];

        // 0a. Per-cell control over what a duplicated row leaves to the database
        const dupAttr = td.getAttribute('data-dup');
        if (dupAttr !== null) {
            const dIdx = parseInt(dupAttr);
            const entry = duplicatedRows[dIdx];
            if (entry) {
                const atDefault = !!entry.defaults && entry.defaults.has(colName);
                const sourceValue = entry.source ? entry.source[colName] : undefined;
                if (atDefault && sourceValue !== null && sourceValue !== undefined) {
                    items.push({
                        label: 'Copy Value From Source Row',
                        action: () => copyDuplicateValueFromSource(dIdx, colName)
                    });
                }
                if (!atDefault && columnDefaults.some(d => d.column === colName)) {
                    items.push({
                        label: 'Reset to Default',
                        action: () => resetDuplicateCellToDefault(dIdx, colName)
                    });
                }
                if (items.length > 0) {
                    items.push({ separator: true });
                }
            }
        }

        // 0. View full record (only for existing rows)
        if (rowIdx !== null) {
            const execCell = executableCellValue(td);
            if (execCell) {
                items.push({ label: execCell.type.label, action: () => runExecutableCell(td) });
                items.push({ separator: true });
            }
            items.push({
                label: 'View Full Record...',
                action: () => {
                    openRecordDialog(parseInt(rowIdx));
                }
            });
            items.push({
                label: 'Open Value in Editor',
                action: () => {
                    openCellInEditor(parseInt(rowIdx), colName);
                }
            });
            if (caps.canDelete && !deletedRows.has(parseInt(rowIdx))) {
                items.push({
                    label: 'Duplicate Row',
                    action: () => addDuplicateRow(parseInt(rowIdx), defaultResetColumns(columnDefaults, duplicateResetMode))
                });
                items.push({
                    label: 'Duplicate Row Exactly',
                    action: () => addDuplicateRow(parseInt(rowIdx), [])
                });
            }
            items.push({ separator: true });
        }

        // 1. Add as exact match
        if (cellValue !== null && cellValue !== undefined) {
            items.push({
                label: 'Add as Exact Match to Query',
                action: () => {
                    applyExactMatchToQuery(colName, String(cellValue));
                }
            });
        }

        // 2. Exclude from query
        if (cellValue !== null && cellValue !== undefined) {
            items.push({
                label: 'Exclude this Value from Query',
                action: () => {
                    if (!canApplyQueryFilters(queryInput.value)) return;
                    const escaped = escapeSqlString(cellValue);
                    const fmtCol = formatIdentifier(colName);
                    const colMeta = columns.find(c => c.name === colName);
                    const filterType = colMeta ? getColumnFilterType(colMeta.dataType) : 'text';
                    let excludeClause;
                    if (filterType === 'numeric') {
                        excludeClause = `${fmtCol} != ${escaped}`;
                    } else {
                        excludeClause = `${fmtCol} != '${escaped}'`;
                    }
                    const parsed = parseSqlForWhere(
                        queryInput.value.trim() || `SELECT * FROM ${getDefaultTableReference()}`
                    );
                    const clauses = parsed.where ? splitWhereByAnd(parsed.where) : [];
                    clauses.push(excludeClause);
                    let sql = parsed.base + ` WHERE ${clauses.join(' AND ')}`;
                    if (parsed.orderBy) sql += ` ORDER BY ${parsed.orderBy}`;
                    setQueryText(sql);
                    runQuery();
                }
            });
        }

        // 3. Open Primary Key (if this column is a FK)
        const fk = foreignKeys.find(f => f.column === colName);
        if (fk && cellValue !== null && cellValue !== undefined) {
            items.push({ separator: true });
            items.push({
                label: `Open Primary Key (${fk.refSchema}.${fk.refTable}.${fk.refColumn})`,
                action: () => {
                    vscode.postMessage({
                        command: 'openForeignKey',
                        refSchema: fk.refSchema,
                        refTable: fk.refTable,
                        refColumn: fk.refColumn,
                        value: String(cellValue)
                    });
                }
            });
        }

        // 4. Open Foreign Keys (tables referencing this column)
        const refs = referencingTables.filter(r => r.localColumn === colName);
        if (refs.length > 0 && cellValue !== null && cellValue !== undefined) {
            if (!fk) { items.push({ separator: true }); }
            refs.forEach(ref => {
                items.push({
                    label: `Open Foreign Key (${ref.fkSchema}.${ref.fkTable}.${ref.fkColumn})`,
                    action: () => {
                        vscode.postMessage({
                            command: 'openForeignKey',
                            refSchema: ref.fkSchema,
                            refTable: ref.fkTable,
                            refColumn: ref.fkColumn,
                            value: String(cellValue)
                        });
                    }
                });
            });
        }

        // 5. Custom column mappings
        const rowIdx2 = rowIdx !== null ? parseInt(rowIdx) : null;
        const rowData = rowIdx2 !== null ? allRows[rowIdx2] : {};
        const applicableMappings = customMappings.filter(m =>
            m.sourceColumn === colName && evaluateMappingConditions(m, rowData)
        );
        if (applicableMappings.length > 0 && cellValue !== null && cellValue !== undefined) {
            items.push({ separator: true });
            applicableMappings.forEach(mapping => {
                const baseLabel = mapping.label || `${mapping.targetSchema}.${mapping.targetTable}.${mapping.targetColumn}`;
                const label = mapping.reversed ? `${baseLabel} (reverse)` : baseLabel;
                items.push({
                    label: `Jump to ${label}`,
                    action: () => {
                        vscode.postMessage({
                            command: 'openForeignKey',
                            refSchema: mapping.targetSchema,
                            refTable: mapping.targetTable,
                            refColumn: mapping.targetColumn,
                            value: String(cellValue),
                            conditions: mapping.targetConditions || []
                        });
                    }
                });
            });
        }

        // 6. Create/Manage custom mapping
        if (canManageTableMetadata(schema, table, !caps.canMap)) {
            items.push({ separator: true });
            items.push({
                label: 'Create Custom Mapping...',
                action: () => {
                    openMappingDialog(colName);
                }
            });
            items.push({
                label: 'Manage Mappings...',
                action: () => {
                    openManageMappingsDialog();
                }
            });
        }

        if (items.length === 0) return;

        showContextMenu(e, items);
    }

    function showHeaderContextMenu(e, colName) {
        const fmtCol = formatIdentifier(colName);
        const currentSql = (queryInput.value || '').trim();
        const parsed = parseSqlForOrder(currentSql || `SELECT * FROM ${getDefaultTableReference()}`);
        const hasOrderBy = !!parsed.orderBy;
        const colInOrderBy = hasOrderBy && orderByContainsColumn(parsed.orderBy, colName);

        const items = [
            { label: `Order by ${colName} ASC (replace)`, action: () => applyOrderBy(colName, 'ASC', 'replace') },
            { label: `Order by ${colName} DESC (replace)`, action: () => applyOrderBy(colName, 'DESC', 'replace') },
            { separator: true },
            { label: `Add ${colName} ASC to ORDER BY`, action: () => applyOrderBy(colName, 'ASC', 'add') },
            { label: `Add ${colName} DESC to ORDER BY`, action: () => applyOrderBy(colName, 'DESC', 'add') },
        ];
        if (colInOrderBy) {
            items.push({ separator: true });
            items.push({ label: `Remove ${colName} from ORDER BY`, action: () => removeColumnFromOrderBy(colName) });
        }
        if (hasOrderBy) {
            if (!colInOrderBy) items.push({ separator: true });
            items.push({ label: 'Remove ORDER BY', action: clearOrderBy });
        }

        items.push({ separator: true });
        items.push({ label: `Add ${colName} IS NULL to WHERE`, action: () => applyNullConstraint(colName, true) });
        items.push({ label: `Add ${colName} IS NOT NULL to WHERE`, action: () => applyNullConstraint(colName, false) });

        items.push({ separator: true });
        items.push({ label: 'Make Column Executable...', action: () => chooseExecutableType(colName) });

        addHeaderRelationItems(items, colName);

        showContextMenu(e, items);
    }

    // Follow a relation for the whole result: open the related table and join
    // the current one to it, carrying the current WHERE clause into the ON.
    function addHeaderRelationItems(items, colName) {
        const source = headerJoinSource(colName);
        if (!source) return;
        const relations = headerRelationTargets(colName, foreignKeys, referencingTables, customMappings);
        if (relations.length === 0) return;
        items.push({ separator: true });
        relations.forEach(rel => {
            items.push({
                label: `Open ${rel.label} joined with ${source.table}`,
                action: () => {
                    const baseSql = (queryInput.value || '').trim()
                        || (table ? `SELECT * FROM ${getDefaultTableReference()}` : '');
                    vscode.postMessage(Object.assign(
                        { command: 'openRelatedJoin' },
                        relatedJoinPayload(rel, source.schema, source.table, baseSql, {
                            columnOf: name => (caps.columnSources[name] || {}).sourceColumn || name,
                            columns: columns.map(c => c.name)
                        })
                    ));
                }
            });
        });
    }

    // The table whose relations a column header follows: the table of the
    // panel, or the table a column of an ad-hoc query was traced back to.
    function headerJoinSource(colName) {
        if (schema && table) return { schema, table };
        const source = caps.columnSources[colName];
        return source && source.schema && source.table ? { schema: source.schema, table: source.table } : null;
    }

    function orderByMatchesColumn(part, colName) {
        if (!part) return false;
        const colPart = part.split(/\s+/)[0];
        const lower = colPart.toLowerCase();
        const fmtLower = formatIdentifier(colName).toLowerCase();
        return lower === fmtLower
            || lower === formatColumnReference(colName).toLowerCase()
            || lower === `"${colName.toLowerCase()}"`
            || lower === colName.toLowerCase();
    }

    function orderByContainsColumn(orderByClause, colName) {
        return orderByClause.split(',').map(p => p.trim()).some(p => orderByMatchesColumn(p, colName));
    }

    function removeColumnFromOrderBy(colName) {
        const baseSql = (queryInput.value || '').trim();
        if (!baseSql) return;
        const parsed = parseSqlForOrder(baseSql);
        if (!parsed.orderBy) return;
        const parts = parsed.orderBy
            .split(',')
            .map(p => p.trim())
            .filter(p => p && !orderByMatchesColumn(p, colName));
        setQueryText(parts.length > 0
            ? `${parsed.base} ORDER BY ${parts.join(', ')}`
            : parsed.base);
        runQuery();
    }

    function applyOrderBy(colName, direction, mode) {
        const fmtCol = formatColumnReference(colName);
        const baseSql = (queryInput.value || '').trim() || `SELECT * FROM ${getDefaultTableReference()}`;
        const parsed = parseSqlForOrder(baseSql);
        let newOrder;
        if (mode === 'replace' || !parsed.orderBy) {
            newOrder = `${fmtCol} ${direction}`;
        } else {
            // Drop any existing entry that targets the same column
            const parts = parsed.orderBy
                .split(',')
                .map(p => p.trim())
                .filter(p => p && !orderByMatchesColumn(p, colName));
            parts.push(`${fmtCol} ${direction}`);
            newOrder = parts.join(', ');
        }
        setQueryText(`${parsed.base} ORDER BY ${newOrder}`);
        runQuery();
    }

    function clearOrderBy() {
        const baseSql = (queryInput.value || '').trim();
        if (!baseSql) return;
        const parsed = parseSqlForOrder(baseSql);
        setQueryText(parsed.base);
        runQuery();
    }

    // A table with many foreign keys produces a menu nobody can scan, so from
    // this many entries on it gets a filter box.
    const CONTEXT_MENU_SEARCH_FROM = 10;

    function hideContextMenu() {
        contextMenu.style.display = 'none';
    }

    function filterContextMenu() {
        const needle = contextMenuSearch.value.trim().toLowerCase();
        let visible = 0;
        contextMenuItems.querySelectorAll('li').forEach(li => {
            // While filtering, a separator no longer separates anything.
            if (li.classList.contains('separator')) {
                li.classList.toggle('hidden', !!needle);
                return;
            }
            const match = !needle || li.textContent.toLowerCase().includes(needle);
            li.classList.toggle('hidden', !match);
            if (match) visible++;
        });
        contextMenuEmpty.classList.toggle('hidden', visible > 0);
    }

    function showContextMenu(e, items) {
        if (!items || items.length === 0) return;

        let html = '';
        items.forEach((item, i) => {
            if (item.separator) {
                html += '<li class="separator"></li>';
            } else {
                html += `<li data-action-idx="${i}">${escapeHtml(item.label)}</li>`;
            }
        });
        contextMenuItems.innerHTML = html;

        const searchable = items.filter(item => !item.separator).length >= CONTEXT_MENU_SEARCH_FROM;
        contextMenuSearch.value = '';
        contextMenuSearch.classList.toggle('hidden', !searchable);
        contextMenuEmpty.classList.add('hidden');

        // Show first (offscreen) to measure size, then clamp into viewport
        contextMenu.style.visibility = 'hidden';
        contextMenu.style.left = '0px';
        contextMenu.style.top = '0px';
        contextMenu.style.maxHeight = '';
        contextMenu.style.display = 'flex';

        const margin = 8;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const menuWidth = contextMenu.offsetWidth;

        // Decide whether to open above or below the cursor
        const spaceBelow = vh - e.clientY - margin;
        const spaceAbove = e.clientY - margin;
        const openUpwards = spaceBelow < 120 && spaceAbove > spaceBelow;
        const availableHeight = Math.max(80, openUpwards ? spaceAbove : spaceBelow);
        contextMenu.style.maxHeight = availableHeight + 'px';

        const menuHeight = contextMenu.offsetHeight;
        let left = e.clientX;
        let top = openUpwards ? e.clientY - menuHeight : e.clientY;
        if (left + menuWidth + margin > vw) left = Math.max(margin, vw - menuWidth - margin);
        if (top + menuHeight + margin > vh) top = Math.max(margin, vh - menuHeight - margin);
        if (top < margin) top = margin;
        if (left < margin) left = margin;

        contextMenu.style.left = left + 'px';
        contextMenu.style.top = top + 'px';
        contextMenu.style.visibility = '';
        if (searchable) { contextMenuSearch.focus(); }

        contextMenuItems.querySelectorAll('li[data-action-idx]').forEach(li => {
            li.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const idx = parseInt(li.getAttribute('data-action-idx'));
                hideContextMenu();
                if (items[idx] && items[idx].action) {
                    items[idx].action();
                }
            });
        });
    }

    // Indices into allRows of the rows the filters let through, in sort order.
    // Indices rather than copies of the rows, so filtering and sorting tens of
    // thousands of rows stays quick.
    function getFilteredAndSortedRows() {
        let order = allRows.map((_, idx) => idx);

        for (const [col, filterVal] of Object.entries(filters)) {
            if (!filterVal) continue;
            const colMeta = columns.find(c => c.name === col);
            const filterType = colMeta ? getColumnFilterType(colMeta.dataType) : 'text';
            const mode = filterModes[col];
            order = order.filter(idx =>
                rowValueMatchesFilter(allRows[idx][col], filterVal, filterType, mode, thousandSeparator)
            );
        }

        if (sortState.column) {
            const sortCol = sortState.column;
            const sortMeta = columns.find(c => c.name === sortCol);
            const numericSort = !!sortMeta && isNumericScalarType(sortMeta.fullType || sortMeta.dataType);
            order.sort((a, b) => compareCellValues(allRows[a][sortCol], allRows[b][sortCol], sortState.direction, numericSort));
        }

        return order;
    }

    function renderBody() {
        displayedOrder = getFilteredAndSortedRows();
        renderPlan = buildRenderPlan(displayedOrder, insertedRows, duplicatedRows);
        planIndexByRow = new Map();
        planIndexByInsert = new Map();
        planIndexByDup = new Map();
        renderPlan.forEach((entry, i) => {
            const byKind = entry.kind === 'row' ? planIndexByRow : entry.kind === 'insert' ? planIndexByInsert : planIndexByDup;
            byKind.set(entry.idx, i);
        });
        renderWindow(true);
        updateChangeIndicator();
        // The row-number column widens with the digits of the last row.
        updateStickyFilterOffset();
        // The rows were rebuilt, so any cell-range selection now points at stale
        // positions; drop it to avoid copying the wrong cells.
        clearCellRangeSelection();
    }

    // The key a row of the plan keeps while it is shown: `row:12`, `insert:0`, `dup:1`.
    function planRowKey(entry) {
        return `${entry.kind}:${entry.idx}`;
    }

    function planIndexOfKey(key) {
        const sep = key.indexOf(':');
        const kind = key.slice(0, sep);
        const idx = parseInt(key.slice(sep + 1), 10);
        return kind === 'row' ? planIndexByRow.get(idx) : kind === 'insert' ? planIndexByInsert.get(idx) : planIndexByDup.get(idx);
    }

    // The position in the display of a row of the tbody, or -1 for anything else.
    function planIndexOf(tr) {
        if (!tr || tr.parentElement !== tableBody) return -1;
        const value = tr.getAttribute('data-plan');
        return value === null ? -1 : parseInt(value, 10);
    }

    // The <tr> of the row at position r of the display, or null when it is not in the DOM.
    function rowElementAt(r) {
        if (r < renderStart || r >= renderEnd) return null;
        const tr = tableBody.rows[r - renderStart + 1];
        return tr && planIndexOf(tr) === r ? tr : null;
    }

    function headerHeight() {
        return tableHead ? tableHead.getBoundingClientRect().height : 0;
    }

    // The rows dragged taller, as { index, extra } by position.
    function rowExtrasList() {
        const list = [];
        for (const [key, extra] of rowExtraHeights) {
            const index = planIndexOfKey(key);
            if (index !== undefined && extra > 0) list.push({ index, extra });
        }
        return list.sort((a, b) => a.index - b.index);
    }

    // Scroll the row at position r into the DOM, if it is not there.
    function ensureRowRendered(r) {
        if (!gridScroller || r < 0 || r >= renderPlan.length || rowElementAt(r)) return;
        const top = virtualRowOffset(r, virtualRowHeight, rowExtrasList());
        const viewH = Math.max(0, gridScroller.clientHeight - headerHeight());
        gridScroller.scrollTop = top < gridScroller.scrollTop ? top : Math.max(0, top + virtualRowHeight - viewH);
        renderWindow(false);
    }

    let renderingWindow = false;

    // Put the rows around the visible part of the result into the DOM. Without
    // `force` nothing happens while the rows in view are there already, so
    // scrolling re-renders only every few dozen rows.
    function renderWindow(force) {
        if (renderingWindow || !tableBody) return;
        const total = renderPlan.length;
        const extras = rowExtrasList();
        const win = virtualWindow({
            scrollTop: gridScroller ? gridScroller.scrollTop : 0,
            viewportHeight: gridScroller ? Math.max(0, gridScroller.clientHeight - headerHeight()) : 800,
            rowHeight: virtualRowHeight,
            total,
            buffer: VIRTUAL_BUFFER_ROWS,
            extras
        });
        if (!force && win.visibleStart >= renderStart && win.visibleEnd <= renderEnd && renderEnd <= total) return;
        if (!force) {
            // A cell being edited would leave the DOM with its row: commit it
            // first, as leaving the cell does.
            const active = document.activeElement;
            if (active && tableBody.contains(active) && typeof active.blur === 'function') {
                active.blur();
                renderWindow(false);
                return;
            }
        }
        renderingWindow = true;
        let remeasure = false;
        try {
            renderStart = win.start;
            renderEnd = win.end;
            buildCellContext();
            const parts = [spacerRowHtml(virtualRowOffset(win.start, virtualRowHeight, extras))];
            for (let i = win.start; i < win.end; i++) {
                parts.push(planRowHtml(renderPlan[i], i));
            }
            const totalHeight = virtualRowOffset(total, virtualRowHeight, extras);
            parts.push(spacerRowHtml(Math.max(0, totalHeight - virtualRowOffset(win.end, virtualRowHeight, extras))));
            tableBody.innerHTML = parts.join('');
            // The row numbers keep the width of the highest one, wherever the rows in view are.
            dataTable.style.setProperty('--row-num-digits', String(String(Math.max(total, 1)).length));
            remeasure = measureRenderedRows();
            growColumnWidths();
        } finally {
            renderingWindow = false;
        }
        applyCellRangeHighlight();
        if (fillDragging) {
            fillPreviewKey = '';
            updateFillPreview();
        }
        // The rows came out another height than assumed: lay the spacers out again.
        if (remeasure) renderWindow(true);
    }

    // A row standing in for the rows above or below the ones in the DOM.
    function spacerRowHtml(height) {
        return `<tr class="v-spacer" aria-hidden="true"><td colspan="${columns.length + 2}" style="--v-h:${Math.round(height)}px"></td></tr>`;
    }

    // Measure the rows just rendered: the height of a single-line row, and how
    // much taller each row is that the user dragged open. True when it changed.
    function measureRenderedRows() {
        let sum = 0;
        let count = 0;
        let changed = false;
        const rows = tableBody.rows;
        for (let i = 1; i < rows.length - 1; i++) {
            const r = planIndexOf(rows[i]);
            if (r < 0) continue;
            const height = rows[i].getBoundingClientRect().height;
            if (!(height > 0)) continue;
            const key = planRowKey(renderPlan[r]);
            if (rowContentHeights.has(key)) {
                const extra = Math.max(0, height - virtualRowHeight);
                if (Math.abs((rowExtraHeights.get(key) || 0) - extra) > 0.5) {
                    rowExtraHeights.set(key, extra);
                    changed = true;
                }
            } else {
                sum += height;
                count++;
            }
        }
        for (const key of Array.from(rowExtraHeights.keys())) {
            if (!rowContentHeights.has(key)) {
                rowExtraHeights.delete(key);
                changed = true;
            }
        }
        if (count > 0 && Math.abs(sum / count - virtualRowHeight) > 0.5) {
            virtualRowHeight = sum / count;
            changed = true;
        }
        return changed;
    }

    // Let each column keep the widest it has been, so it does not change width
    // while rows of other lengths scroll into the DOM.
    function growColumnWidths() {
        const headers = tableHead.querySelectorAll('tr:first-child > th[data-col]');
        if (!headers.length) return;
        const style = getComputedStyle(headers[0]);
        const chrome = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
            + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
        let grown = false;
        headers.forEach(th => {
            const name = th.getAttribute('data-col');
            if (Number(columnWidths[name]) > 0) return;
            const width = Math.floor(th.getBoundingClientRect().width - chrome);
            if (width > (autoColumnWidths[name] || 0) + 1) {
                autoColumnWidths[name] = width;
                grown = true;
            }
        });
        if (grown) applyColumnWidths();
    }

    // What every cell of a column shares, worked out once per render rather
    // than once per cell.
    let cellContext = { modifiedRows: new Set(), cols: [] };

    function buildCellContext() {
        const modifiedRows = new Set();
        for (const key of modifiedCells.keys()) {
            modifiedRows.add(parseInt(key.slice(0, key.indexOf(':')), 10));
        }
        cellContext = {
            modifiedRows,
            cols: columns.map(col => ({
                name: col.name,
                attr: escapeAttr(col.name),
                numeric: getColumnFilterType(col.dataType) === 'numeric',
                editable: isColumnEditable(col.name),
                fk: foreignKeys.find(f => f.column === col.name),
                mappings: customMappings.filter(m => m.isDefault && m.sourceColumn === col.name),
                execType: executableTypeOfColumn(col.name, caps.columnSources[col.name])
            }))
        };
    }

    // The text a cell shows, read from the data: what a row outside the DOM
    // would show, the same way getCellTextContent reads a rendered one.
    function modelCellText(entry, colName) {
        if (!entry) return '';
        if (entry.kind === 'insert') {
            const inserted = insertedRows[entry.idx];
            return inserted ? String(inserted.row[colName] || '').trim() : '';
        }
        if (entry.kind === 'dup') {
            const dup = duplicatedRows[entry.idx];
            if (!dup) return '';
            if (dup.defaults && dup.defaults.has(colName)) return 'DEFAULT';
            const value = dup.row[colName];
            return value === null || value === undefined ? '' : cellToString(value).trim();
        }
        const key = `${entry.idx}:${colName}`;
        const value = modifiedCells.has(key) ? modifiedCells.get(key) : (allRows[entry.idx] || {})[colName];
        if (value === null) return 'NULL';
        return String(isNumericColumn(colName) ? formatNumberDisplay(value, thousandSeparator) : cellToString(value)).trim();
    }

    // The markup of the row at position `planIndex` of the display.
    function planRowHtml(entry, planIndex) {
        const contentHeight = rowContentHeights.get(planRowKey(entry));
        const attrs = ` data-plan="${planIndex}"` + (contentHeight ? ` style="--row-content-max-h:${contentHeight}px"` : '');
        if (entry.kind === 'insert') return insertedRowHtml(entry.idx, planIndex + 1, attrs);
        if (entry.kind === 'dup') return duplicatedRowHtml(entry.idx, planIndex + 1, attrs);
        return loadedRowHtml(entry.idx, planIndex + 1, attrs);
    }

    function insertedRowHtml(iIdx, rowNum, attrs) {
        const row = insertedRows[iIdx].row;
        let html = `<tr class="row-inserted" data-insert-index="${iIdx}"${attrs}>`;
        html += `<td class="row-num-cell">${rowNum}</td>`;
        html += `<td class="actions-cell"><button class="btn btn-danger btn-sm btn-icon" data-row-action="removeInsertedRow" data-row-arg="${iIdx}" title="Remove this new row">${icon('close')}</button></td>`;
        cellContext.cols.forEach(cc => {
            const val = row[cc.name] || '';
            const invalid = invalidCells.get(`ins:${iIdx}:${cc.name}`);
            html += `<td class="editable-cell${invalid ? ' cell-invalid' : ''}" ${invalid ? `title="${escapeAttr(invalid)}"` : ''} contenteditable="false" data-insert="${iIdx}" data-col="${cc.attr}">${escapeHtml(val)}</td>`;
        });
        return html + '</tr>';
    }

    function duplicatedRowHtml(dIdx, rowNum, attrs) {
        const entry = duplicatedRows[dIdx];
        const row = entry.row;
        let html = `<tr class="row-duplicated" data-dup-index="${dIdx}"${attrs}>`;
        html += `<td class="row-num-cell">${rowNum}</td>`;
        html += `<td class="actions-cell"><button class="btn btn-danger btn-sm btn-icon" data-row-action="removeDuplicatedRow" data-row-arg="${dIdx}" title="Remove this duplicate">${icon('close')}</button></td>`;
        cellContext.cols.forEach(cc => {
            const atDefault = !!entry.defaults && entry.defaults.has(cc.name);
            const val = row[cc.name] !== null && row[cc.name] !== undefined ? cellToString(row[cc.name]) : '';
            const invalid = invalidCells.get(`dup:${dIdx}:${cc.name}`);
            const content = atDefault ? defaultMarkerHtml(cc.name) : escapeHtml(val);
            html += `<td class="editable-cell${invalid ? ' cell-invalid' : ''}" ${invalid ? `title="${escapeAttr(invalid)}"` : ''} contenteditable="false" data-dup="${dIdx}" data-col="${cc.attr}">${content}</td>`;
        });
        return html + '</tr>';
    }

    function loadedRowHtml(idx, rowNum, attrs) {
        const row = allRows[idx];
        const isDeleted = deletedRows.has(idx);
        const isModified = cellContext.modifiedRows.has(idx);
        const isSelected = selectedRowIdx === idx;
        let rowClass = '';
        if (isDeleted) rowClass = 'row-deleted';
        else if (isModified) rowClass = 'row-modified';
        if (isSelected) rowClass = (rowClass ? rowClass + ' ' : '') + 'row-selected';

        let html = `<tr class="${rowClass}" data-row-index="${idx}"${attrs}>`;
        html += `<td class="row-num-cell">${rowNum}<div class="row-resize-handle" title="Drag to change row height"></div></td>`;
        html += `<td class="actions-cell">`;
        if (!caps.canDelete) {
            html += `<button class="btn-view-record" data-row-action="openRecordDialog" data-row-arg="${idx}" title="View full record">&#128065;</button>`;
        } else if (!isDeleted) {
            html += `<button class="btn-view-record" data-row-action="openRecordDialog" data-row-arg="${idx}" title="View full record">&#128065;</button>`;
            html += `<button class="btn btn-sm btn-icon" data-row-action="duplicateRow" data-row-arg="${idx}" title="Duplicate row">${icon('copy')}</button>`;
            html += `<button class="btn btn-danger btn-sm btn-icon" data-row-action="deleteRow" data-row-arg="${idx}" title="Delete row">${icon('trash')}</button>`;
        } else {
            html += `<button class="btn-view-record" data-row-action="openRecordDialog" data-row-arg="${idx}" title="View full record">&#128065;</button>`;
            html += `<button class="btn btn-sm btn-icon" data-row-action="undeleteRow" data-row-arg="${idx}" title="Restore row">${icon('undo')}</button>`;
        }
        html += `</td>`;

        cellContext.cols.forEach(cc => {
            const originalVal = row[cc.name];
            const modKey = `${idx}:${cc.name}`;
            const isModifiedCell = modifiedCells.has(modKey);
            const currentVal = isModifiedCell ? modifiedCells.get(modKey) : originalVal;
            const invalidReason = invalidCells.get(modKey);
            const cellClass = `${isModifiedCell ? 'cell-modified' : ''}${invalidReason ? ' cell-invalid' : ''}`;
            const displayVal = currentVal === null ? '<span class="null-value">NULL</span>' : (
                cc.numeric
                    ? escapeHtml(formatNumberDisplay(currentVal, thousandSeparator))
                    : escapeHtml(cellToString(currentVal))
            );

            const hasValue = currentVal !== null && currentVal !== undefined;
            const defaultCustomMapping = hasValue && cc.mappings.length
                ? cc.mappings.find(m => evaluateMappingConditions(m, row))
                : undefined;
            let fkBtn = '';
            if (defaultCustomMapping) {
                // Custom mapping overrides or supplements FK button
                fkBtn = `<button class="fk-btn custom-fk-btn" data-ref-schema="${escapeAttr(defaultCustomMapping.targetSchema)}" data-ref-table="${escapeAttr(defaultCustomMapping.targetTable)}" data-ref-column="${escapeAttr(defaultCustomMapping.targetColumn)}" data-value="${escapeAttr(cellToString(currentVal))}" title="${escapeAttr(defaultCustomMapping.label || defaultCustomMapping.targetSchema + '.' + defaultCustomMapping.targetTable)}">&#8599;</button>`;
            } else if (cc.fk && hasValue) {
                fkBtn = `<button class="fk-btn" data-ref-schema="${escapeAttr(cc.fk.refSchema)}" data-ref-table="${escapeAttr(cc.fk.refTable)}" data-ref-column="${escapeAttr(cc.fk.refColumn)}" data-value="${escapeAttr(cellToString(currentVal))}" title="${escapeAttr('Open ' + cc.fk.refSchema + '.' + cc.fk.refTable)}">&#8599;</button>`;
            }
            const canEditCell = !isDeleted && cc.editable;
            const spanClass = canEditCell ? 'cell-content editable-cell' : 'cell-content';
            const execBtn = cc.execType && hasValue
                ? executableButtonHtml(cc.execType, executedValues.get(executableMarkKey(cc.name, cellToString(currentVal))))
                : '';
            const cellExtraClass = (fkBtn ? ' has-fk-btn' : '') + (execBtn ? ' has-exec-btn' : '');
            html += `<td class="${cellClass}${cellExtraClass}" ${invalidReason ? `title="${escapeAttr(invalidReason)}"` : ''} data-row="${idx}" data-col="${cc.attr}" data-original="${escapeAttr(originalVal === null ? '__NULL__' : cellToString(originalVal))}">${execBtn}<span class="${spanClass}" contenteditable="false">${displayVal}</span>${fkBtn}</td>`;
        });
        return html + '</tr>';
    }

    // Fill a counter element from a budget, or blank it out when the column has
    // no character limit.
    function applyCharBudget(el, budget) {        if (!el) return;
        el.textContent = budget ? budget.text : '';
        el.classList.toggle('is-warning', !!budget && budget.state === 'warning');
        el.classList.toggle('is-exceeded', !!budget && budget.state === 'exceeded');
    }

    // The cell the floating counter currently belongs to, so scrolling can move
    // it along instead of leaving it behind.
    let charBudgetTarget = null;

    function hideCharBudgetBadge() {
        charBudgetTarget = null;
        if (charBudgetBadge) charBudgetBadge.style.display = 'none';
    }

    // Show the remaining characters underneath the cell being edited.
    function showCharBudgetBadge(editable) {
        const td = editable ? editable.closest('td') : null;
        if (!charBudgetBadge || !td) return;
        const colMeta = columns.find(c => c.name === td.getAttribute('data-col'));
        const budget = colMeta
            ? describeCharacterBudget(editable.textContent, colMeta.fullType || colMeta.dataType)
            : null;
        if (!budget) {
            hideCharBudgetBadge();
            return;
        }
        charBudgetTarget = editable;
        applyCharBudget(charBudgetBadge, budget);
        charBudgetBadge.style.display = 'block';
        const cell = td.getBoundingClientRect();
        const badge = charBudgetBadge.getBoundingClientRect();
        const below = cell.bottom + 2;
        const top = below + badge.height > window.innerHeight ? cell.top - badge.height - 2 : below;
        charBudgetBadge.style.top = Math.max(0, top) + 'px';
        charBudgetBadge.style.left = Math.max(0, cell.right - badge.width) + 'px';
    }

    document.addEventListener('scroll', () => {
        if (charBudgetTarget) showCharBudgetBadge(charBudgetTarget);
    }, true);

    // Live formatting for numeric cells during editing.
    // `editable` is the contenteditable element (a .cell-content span for existing rows,
    // or the td itself for inserted/duplicated rows).
    function handleNumericCellInput(editable) {
        const td = editable.closest('td');
        if (!td) return;
        const colName = td.getAttribute('data-col');
        const colMeta = columns.find(c => c.name === colName);
        if (!colMeta || getColumnFilterType(colMeta.dataType) !== 'numeric') return;

        const text = editable.textContent;

        // Get cursor position as digit count
        const sel = window.getSelection();
        let digitsBefore = 0;
        if (sel && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            const beforeCursor = text.substring(0, range.startOffset);
            digitsBefore = beforeCursor.split(thousandSeparator).join('').length;
        }

        const result = liveFormatNumeric(text, digitsBefore, thousandSeparator);
        if (!result) return;

        editable.textContent = result.formatted;

        // Restore cursor position
        if (sel && editable.firstChild) {
            const newRange = document.createRange();
            newRange.setStart(editable.firstChild, Math.min(result.newCursor, result.formatted.length));
            newRange.collapse(true);
            sel.removeAllRanges();
            sel.addRange(newRange);
        }
    }

    // Clear the "NULL" placeholder when the user focuses a NULL cell so
    // they can immediately type a new value. Leaving the cell empty on
    // blur restores NULL via handleCellEdit (which converts '' -> null).
    function handleNullCellFocus(span) {
        if (span.querySelector('.null-value')) {
            span.textContent = '';
        }
    }

    // Which kind of editable element of the grid `el` is: the .cell-content
    // span of a loaded row, or the cell of an inserted or duplicated row.
    function editableKind(el) {
        if (!el || !el.matches || !tableBody.contains(el)) return null;
        if (el.matches('td[data-row] .cell-content.editable-cell')) return 'row';
        if (el.matches('td[data-insert].editable-cell')) return 'insert';
        if (el.matches('td[data-dup].editable-cell')) return 'dup';
        return null;
    }

    // The cells listen through the tbody, once, instead of each cell carrying
    // listeners of its own that every render would create anew.
    tableBody.addEventListener('focusin', (e) => {
        const el = e.target;
        const kind = editableKind(el);
        if (kind === 'row') handleNullCellFocus(el);
        else if (kind === 'dup') clearDefaultMarker(el);
        if (kind) showCharBudgetBadge(el);
    });

    tableBody.addEventListener('focusout', (e) => {
        const el = e.target;
        const kind = editableKind(el);
        if (!kind) return;
        hideCharBudgetBadge();
        if (kind === 'row') handleCellEdit(e);
        else if (kind === 'insert') handleInsertCellEdit(e);
        else handleDupCellEdit(e);
        exitCellEditMode(el);
        commitMultiEdit(el);
    });

    tableBody.addEventListener('input', (e) => {
        const el = e.target;
        if (!editableKind(el)) return;
        handleNumericCellInput(el);
        showCharBudgetBadge(el);
    });

    tableBody.addEventListener('contextmenu', (e) => {
        const td = e.target.closest ? e.target.closest('td[data-col]') : null;
        if (!td || planIndexOf(td.parentElement) < 0) return;
        e.preventDefault();
        showCellContextMenu(e, td);
    });

    tableBody.addEventListener('click', (e) => {
        const fkBtn = e.target.closest ? e.target.closest('.fk-btn') : null;
        if (fkBtn && tableBody.contains(fkBtn)) {
            vscode.postMessage({
                command: 'openForeignKey',
                refSchema: fkBtn.getAttribute('data-ref-schema'),
                refTable: fkBtn.getAttribute('data-ref-table'),
                refColumn: fkBtn.getAttribute('data-ref-column'),
                value: fkBtn.getAttribute('data-value')
            });
            return;
        }
        // Row selection: clicking anywhere in an existing row marks it as
        // selected so that subsequent Insert Row / Duplicate Row place new
        // rows directly below it. This listener comes before the one of the
        // row action buttons, so a button acts on the row it selected.
        const tr = e.target.closest ? e.target.closest('tr[data-row-index]') : null;
        if (!tr || planIndexOf(tr) < 0) return;
        const idx = parseInt(tr.getAttribute('data-row-index'), 10);
        if (selectedRowIdx === idx) return;
        // Update class on previously selected row without full
        // re-render to avoid clobbering an in-progress edit.
        tableBody.querySelectorAll('tr.row-selected').forEach(prev => prev.classList.remove('row-selected'));
        tr.classList.add('row-selected');
        selectedRowIdx = idx;
    });

    function handleCellEdit(e) {
        const span = e.target;
        const td = span.closest('td');
        if (!td) return;
        const rowIdx = parseInt(td.getAttribute('data-row'));
        const colName = td.getAttribute('data-col');
        const originalStr = td.getAttribute('data-original');
        const original = originalStr === '__NULL__' ? null : originalStr;

        const colMeta = columns.find(c => c.name === colName);
        const isNumeric = !!colMeta && getColumnFilterType(colMeta.dataType) === 'numeric';
        let newValue = normalizeCellInput(span.textContent, isNumeric, thousandSeparator);

        if (newValue === '' && original === null) {
            newValue = null;
        }

        const modKey = `${rowIdx}:${colName}`;

        if (newValue === original || (newValue === '' && original === null)) {
            modifiedCells.delete(modKey);
            td.classList.remove('cell-modified');
            setCellValidity(td, modKey, null);
        } else {
            modifiedCells.set(modKey, newValue === '' ? null : newValue);
            td.classList.add('cell-modified');
            checkCellValue(td, modKey, newValue === '' ? null : newValue);
        }

        // Re-format display for numeric columns
        if (isNumeric) {
            const displayValue = modifiedCells.has(modKey) ? modifiedCells.get(modKey) : (original === null ? null : original);
            if (displayValue !== null) {
                span.textContent = formatNumberDisplay(displayValue, thousandSeparator);
            }
        }

        // Restore the NULL placeholder when the cell ends up null (either
        // because the user cleared a NULL cell without typing anything, or
        // because they emptied a previously non-null cell -> we treat empty
        // as NULL on commit, so the display should reflect that).
        const finalValue = modifiedCells.has(modKey) ? modifiedCells.get(modKey) : original;
        if (finalValue === null) {
            span.innerHTML = '<span class="null-value">NULL</span>';
        }

        updateChangeIndicator();
        recordEditHistory();
    }

    // Shared handler for editable cells in inserted/duplicated rows. `rows` is
    // the backing array and `idxAttr` the data attribute holding its index.
    function applyDataRowCellEdit(e, rows, idxAttr) {
        const td = e.target;
        const idx = parseInt(td.getAttribute(idxAttr));
        const colName = td.getAttribute('data-col');
        const colMeta = columns.find(c => c.name === colName);
        const isNumeric = !!colMeta && getColumnFilterType(colMeta.dataType) === 'numeric';
        const value = normalizeCellInput(td.textContent, isNumeric, thousandSeparator);
        rows[idx].row[colName] = value;
        const defaults = rows[idx].defaults;
        if (defaults) {
            // An emptied cell is left to the database, so say so instead of
            // showing a blank that behaves like a default anyway.
            if (value === null && hasResettableDefault(colName)) {
                defaults.add(colName);
                td.innerHTML = defaultMarkerHtml(colName);
            } else {
                defaults.delete(colName);
            }
        }
        checkCellValue(td, `${idxAttr === 'data-insert' ? 'ins' : 'dup'}:${idx}:${colName}`, value);
        updateChangeIndicator();
        recordEditHistory();
    }

    function handleInsertCellEdit(e) {
        applyDataRowCellEdit(e, insertedRows, 'data-insert');
    }

    function handleDupCellEdit(e) {
        applyDataRowCellEdit(e, duplicatedRows, 'data-dup');
    }

    // Markup of a duplicated cell the database will fill in on save.
    function defaultMarkerHtml(colName) {
        const info = columnDefaults.find(d => d.column === colName);
        return `<span class="default-value" title="${escapeAttr(defaultCellTitle(info))}">DEFAULT</span>`;
    }

    // Typing into a cell replaces the marker, so remove it as soon as the cell
    // is focused.
    function clearDefaultMarker(td) {
        if (td.querySelector('.default-value')) {
            td.textContent = '';
        }
    }

    // Whether a column is one the database refills when the INSERT omits it.
    function hasResettableDefault(colName) {
        return defaultResetColumns(columnDefaults, duplicateResetMode).indexOf(colName) !== -1;
    }

    // Undo a reset for a single cell: take the source row's value after all.
    function copyDuplicateValueFromSource(dIdx, colName) {
        const entry = duplicatedRows[dIdx];
        if (!entry) return;
        entry.row[colName] = entry.source ? entry.source[colName] : null;
        if (entry.defaults) entry.defaults.delete(colName);
        renderBody();
        updateChangeIndicator();
        recordEditHistory();
    }

    // Leave a single cell of a duplicate to the database.
    function resetDuplicateCellToDefault(dIdx, colName) {
        const entry = duplicatedRows[dIdx];
        if (!entry) return;
        entry.row[colName] = null;
        if (!entry.defaults) entry.defaults = new Set();
        entry.defaults.add(colName);
        invalidCells.delete(`dup:${dIdx}:${colName}`);
        renderBody();
        updateChangeIndicator();
        recordEditHistory();
    }

    // Pending database checks, keyed by request id, so a late answer for a cell
    // that has been edited again in the meantime can be discarded.
    let validationSeq = 0;
    const pendingValidations = new Map();

    // Check an edited value against its column type and mark the cell when the
    // column cannot store it. Types whose text format only Postgres can judge
    // (timestamps, JSON, enums, ...) are sent to the database for a cast test.
    // `td` is null for a cell outside the DOM; its mark is kept by key.
    function checkCellValue(td, key, value) {
        const colName = colNameOfKey(key);
        const colMeta = columns.find(c => c.name === colName);
        const result = colMeta ? validateCellValue(value, colMeta.fullType || colMeta.dataType) : { state: 'valid' };
        if (result.state === 'unknown') {
            const requestId = ++validationSeq;
            pendingValidations.set(requestId, { key, value });
            vscode.postMessage({ command: 'validateValue', requestId, column: colMeta.name, value });
            return;
        }
        setCellValidity(td, key, result.state === 'invalid' ? result.reason : null);
    }

    function setCellValidity(td, key, reason) {
        if (reason) {
            invalidCells.set(key, reason);
        } else {
            invalidCells.delete(key);
        }
        if (td) {
            td.classList.toggle('cell-invalid', !!reason);
            if (reason) td.setAttribute('title', reason);
            else td.removeAttribute('title');
        }
        updateChangeIndicator();
    }

    function handleValidationResult(msg) {
        const pending = pendingValidations.get(msg.requestId);
        pendingValidations.delete(msg.requestId);
        if (!pending || currentCellValue(pending.key) !== pending.value) {
            return; // the cell was edited again; a newer check is on its way
        }
        setCellValidity(findCellByKey(pending.key), pending.key, msg.valid ? null : (msg.reason || 'Invalid value'));
    }

    // The value a cell key currently holds, or undefined when the edit was
    // reverted or the row is gone.
    function currentCellValue(key) {
        const parts = key.split(':');
        if (parts[0] === 'ins' || parts[0] === 'dup') {
            const rows = parts[0] === 'ins' ? insertedRows : duplicatedRows;
            const entry = rows[parseInt(parts[1])];
            return entry ? entry.row[parts.slice(2).join(':')] : undefined;
        }
        return modifiedCells.has(key) ? modifiedCells.get(key) : undefined;
    }

    function findCellByKey(key) {
        const parts = key.split(':');
        const colName = colNameOfKey(key);
        const rowSelector = parts[0] === 'ins' ? `[data-insert="${parts[1]}"]`
            : parts[0] === 'dup' ? `[data-dup="${parts[1]}"]`
            : `[data-row="${parts[0]}"]`;
        return tableBody.querySelector(`td${rowSelector}[data-col="${cssEscape(colName)}"]`);
    }

    // The column of a cell key: `12:name`, `ins:0:name` or `dup:1:name`.
    function colNameOfKey(key) {
        const parts = String(key).split(':');
        return parts[0] === 'ins' || parts[0] === 'dup' ? parts.slice(2).join(':') : parts.slice(1).join(':');
    }

    // Where the cell of a key stands in the display, in the DOM or not.
    function coordsOfKey(key) {
        const parts = String(key).split(':');
        const r = parts[0] === 'ins' ? planIndexByInsert.get(parseInt(parts[1], 10))
            : parts[0] === 'dup' ? planIndexByDup.get(parseInt(parts[1], 10))
            : planIndexByRow.get(parseInt(parts[0], 10));
        const c = columns.findIndex(col => col.name === colNameOfKey(key));
        return r === undefined || c < 0 ? null : { r, c };
    }

    function cssEscape(value) {
        return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : String(value).replace(/"/g, '\\"');
    }

    // Keep the invalid-cell keys of inserted/duplicated rows aligned after one
    // of those rows was removed from its backing array.
    function reindexInvalidRowKeys(prefix, removedIdx) {
        const next = new Map();
        for (const [key, reason] of invalidCells.entries()) {
            const parts = key.split(':');
            if (parts[0] !== prefix) { next.set(key, reason); continue; }
            const idx = parseInt(parts[1]);
            if (idx === removedIdx) { continue; }
            const shifted = idx > removedIdx ? idx - 1 : idx;
            next.set(`${prefix}:${shifted}:${parts.slice(2).join(':')}`, reason);
        }
        invalidCells = next;
    }

    // Global functions for inline handlers
    window.deleteRow = function(idx) {
        deletedRows.add(idx);
        renderBody();
        recordEditHistory();
    };

    window.undeleteRow = function(idx) {
        deletedRows.delete(idx);
        renderBody();
        recordEditHistory();
    };

    window.duplicateRow = function(idx) {
        addDuplicateRow(idx, defaultResetColumns(columnDefaults, duplicateResetMode));
    };

    // Duplicate without letting the database refill anything.
    window.duplicateRowExactly = function(idx) {
        addDuplicateRow(idx, []);
    };

    function addDuplicateRow(idx, resetColumns) {
        const rowData = {};
        const source = {};
        columns.forEach(col => {
            const modKey = `${idx}:${col.name}`;
            const edited = modifiedCells.has(modKey);
            const value = duplicateCellValue(edited ? modifiedCells.get(modKey) : allRows[idx][col.name], col.dataType, edited);
            rowData[col.name] = value;
            source[col.name] = value;
        });
        const defaults = new Set(resetColumns.filter(name => columns.some(col => col.name === name)));
        defaults.forEach(name => { rowData[name] = null; });
        // Anchor the duplicate directly below the source row.
        duplicatedRows.push({ row: rowData, anchor: idx, defaults, source });
        selectedRowIdx = idx;
        renderBody();
        updateRowCount();
        recordEditHistory();
    }

    window.removeInsertedRow = function(idx) {
        insertedRows.splice(idx, 1);
        reindexInvalidRowKeys('ins', idx);
        renderBody();
        updateRowCount();
        recordEditHistory();
    };

    window.removeDuplicatedRow = function(idx) {
        duplicatedRows.splice(idx, 1);
        reindexInvalidRowKeys('dup', idx);
        renderBody();
        updateRowCount();
        recordEditHistory();
    };

    // The row action buttons carry `data-row-action` instead of inline
    // onclick handlers, which the panel's Content Security Policy blocks.
    const ROW_ACTIONS = {
        openRecordDialog: (idx) => window.openRecordDialog(idx),
        duplicateRow: (idx) => window.duplicateRow(idx),
        deleteRow: (idx) => window.deleteRow(idx),
        undeleteRow: (idx) => window.undeleteRow(idx),
        removeInsertedRow: (idx) => window.removeInsertedRow(idx),
        removeDuplicatedRow: (idx) => window.removeDuplicatedRow(idx)
    };
    tableBody.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('[data-row-action]') : null;
        if (!btn || !tableBody.contains(btn)) return;
        const action = ROW_ACTIONS[btn.getAttribute('data-row-action')];
        const arg = parseInt(btn.getAttribute('data-row-arg'), 10);
        if (action && !isNaN(arg)) action(arg);
    });

    // The run button of a cell in an executable column.
    tableBody.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('.exec-btn') : null;
        if (!btn || !tableBody.contains(btn)) return;
        e.preventDefault();
        if (Date.now() - lastExecutableClickAt < 500) return;
        lastExecutableClickAt = Date.now();
        runExecutableCell(btn.closest('td[data-col]'));
    });

    // The run button of a cell, marked when its value ran before.
    function executableButtonHtml(type, mark) {
        const state = mark ? ` is-${mark.status}` : '';
        const title = mark ? mark.title : type.action;
        const glyph = mark && mark.status === 'executed' ? icon('check') : executableIcon(type.kind);
        return `<button class="btn btn-ghost btn-sm btn-icon exec-btn${state}" title="${escapeAttr(title)}" aria-label="${escapeAttr(type.label)}">${glyph}</button>`;
    }

    // The value of a cell of an existing row in an executable column, as it is
    // shown (an unsaved edit included), or null when the cell has none.
    function executableCellValue(td) {
        if (!td) return null;
        const colName = td.getAttribute('data-col');
        const rowAttr = td.getAttribute('data-row');
        if (rowAttr === null) return null;
        const idx = parseInt(rowAttr, 10);
        const modKey = `${idx}:${colName}`;
        const raw = modifiedCells.has(modKey) ? modifiedCells.get(modKey) : (allRows[idx] || {})[colName];
        const type = executableTypeOfColumn(colName, caps.columnSources[colName]);
        if (!type || raw === null || raw === undefined) return null;
        return { colName, type, value: cellToString(raw) };
    }

    function runExecutableCell(td) {
        const cell = executableCellValue(td);
        if (!cell) return;
        vscode.postMessage({ command: 'runExecutableValue', column: cell.colName, value: cell.value });
    }

    // Mark every cell showing the value that ran, in place, so a selection or
    // an edit in progress is not disturbed by a re-render.
    function handleExecutableValueDone(msg) {
        const mark = executableMark(msg.outcome, new Date().toTimeString().slice(0, 8));
        if (!mark) return;
        executedValues.set(executableMarkKey(msg.column, msg.value), mark);
        tableBody.querySelectorAll('td[data-col] > .exec-btn').forEach(btn => {
            const cell = executableCellValue(btn.parentElement);
            if (cell && cell.colName === msg.column && cell.value === msg.value) {
                btn.outerHTML = executableButtonHtml(cell.type, mark);
            }
        });
    }

    // Rename a column in the query so its alias carries the prefix of a type
    // ('' removes it), then run the query again.
    function renameColumnInQuery(colName, newName) {
        const sql = (queryInput.value || '').trim() || getDefaultQuery();
        return renameSelectColumn(
            sql,
            { name: colName, index: columns.findIndex(c => c.name === colName), columns: columns.map(c => c.name) },
            newName,
            formatIdentifier,
            word => POSTGRES_RESERVED_KEYWORDS.has(word)
        );
    }

    // Ask the extension which type the column should get, once it is clear the
    // query can be rewritten for it.
    function chooseExecutableType(colName) {
        const probe = renameColumnInQuery(colName, executableColumnAlias(colName, 'copy_'));
        if (probe.error) {
            showError(probe.error);
            return;
        }
        vscode.postMessage({ command: 'chooseExecutableType', column: colName });
    }

    function makeColumnExecutable(colName, prefix) {
        const newName = executableColumnAlias(colName, prefix);
        if (newName === colName) return;
        const result = renameColumnInQuery(colName, newName);
        if (result.error) {
            showError(result.error);
            return;
        }
        // The rewrite touches only the alias, so the query keeps its layout.
        queryInput.value = result.sql;
        autoSizeQueryInput();
        recordEditHistory();
        runQuery();
    }

    function insertRow() {
        const newRow = {};
        columns.forEach(col => { newRow[col.name] = ''; });
        // Anchor below the currently selected row, or at the top if none.
        const anchor = (selectedRowIdx != null && allRows[selectedRowIdx]) ? selectedRowIdx : null;
        insertedRows.push({ row: newRow, anchor: anchor });
        renderBody();
        updateRowCount();
        recordEditHistory();

        // The new row may be far from the rows in view: scroll it into the DOM.
        const planIndex = planIndexByInsert.get(insertedRows.length - 1);
        if (planIndex !== undefined) ensureRowRendered(planIndex);
        const newTr = planIndex !== undefined ? rowElementAt(planIndex) : null;
        if (newTr && newTr.scrollIntoView) {
            newTr.scrollIntoView({ block: 'nearest', behavior: 'auto' });
        }
    }

    function loadMore() {
        if (userPaged || !currentSql) return;
        currentOffset += PAGE_SIZE;
        appendPending = true;
        postLoadRows(currentSql + ' LIMIT ' + PAGE_SIZE + ' OFFSET ' + currentOffset, true);
    }

    // Load every remaining row in a single request (the "Load All" button).
    function loadAll() {
        if (userPaged || !currentSql) return;
        if (typeof totalCount === 'number' && remainingRowCount(allRows.length, totalCount) <= 0) return;
        currentOffset = allRows.length;
        appendPending = true;
        allLoaded = true;
        loadMoreBtn.disabled = true;
        loadAllBtn.disabled = true;
        // No LIMIT -> fetch all rows from the current offset onward.
        postLoadRows(currentSql + ' OFFSET ' + currentOffset, true);
    }

    function postLoadRows(sql, append) {
        // A page appended to the current result supersedes an auto refresh on
        // its way, which would otherwise reset the offset under it.
        if (autoRefreshInFlight) {
            autoRefreshInFlight = null;
            setAutoRefreshBusyIndicator(false);
            scheduleAutoRefresh();
        }
        setDataLoading(true);
        // The id of the result being extended: a page that arrives after a new
        // query was started is dropped instead of being appended to it.
        vscode.postMessage({ command: 'loadRows', sql, baseSql: currentSql, append: !!append, loadId: latestLoadId });
    }

    // ===== Auto refresh ========================================================
    // Re-runs the last executed query every `autoRefreshSeconds`. The interval
    // counts from the latest fresh result; a tick that finds the grid busy or
    // edited is retried shortly after instead of interrupting the user.
    const autoRefreshControl = document.getElementById('autoRefreshControl');
    const autoRefreshSelect = document.getElementById('autoRefreshSelect');
    const autoRefreshStatus = document.getElementById('autoRefreshStatus');
    const gridScroller = document.getElementById('tableWrapper');
    // Scrolling and resizing bring other rows into view, and with them into the DOM.
    if (gridScroller) {
        gridScroller.addEventListener('scroll', () => renderWindow(false), { passive: true });
    }
    window.addEventListener('resize', () => renderWindow(false));
    const AUTO_REFRESH_RETRY_MS = 1000;
    let autoRefreshSeconds = 0;
    let autoRefreshTimer = null;
    let panelVisible = true;
    let lastAutoRefreshAt = null;
    // True while a mouse button is held anywhere in the panel (cell or column
    // drag, column resize, a text selection): a refresh would cut it off.
    let pointerHeld = false;

    document.addEventListener('mousedown', () => { pointerHeld = true; }, true);
    document.addEventListener('mouseup', () => { pointerHeld = false; }, true);
    document.addEventListener('mousemove', (e) => { if (e.buttons === 0) pointerHeld = false; }, true);
    document.addEventListener('dragend', () => { pointerHeld = false; }, true);
    document.addEventListener('drop', () => { pointerHeld = false; }, true);
    window.addEventListener('blur', () => { pointerHeld = false; });

    function isAutoRefreshAnswer(msg) {
        return !!autoRefreshInFlight && msg.autoRefreshId === autoRefreshInFlight.id && msg.autoRefreshId === latestLoadId;
    }

    function hasPendingGridChanges() {
        return modifiedCells.size + deletedRows.size + insertedRows.length + duplicatedRows.length > 0;
    }

    function isVisible(el) {
        return !!el && getComputedStyle(el).display !== 'none';
    }

    function isAutoRefreshBusy() {
        if (dataLoadingActive || appendPending || autoRefreshInFlight) return true;
        if (pointerHeld || rangeDragging || fillDragging || multiEditBounds || dragSourceCol !== null) return true;
        if (isVisible(contextMenu) || isVisible(queryHistoryPanel)) return true;
        const overlays = document.querySelectorAll('.sql-dialog-overlay, .dlg-overlay');
        for (const el of overlays) {
            if (isVisible(el)) return true;
        }
        // Typing in a cell editor or a column filter: re-rendering would drop it.
        const active = document.activeElement;
        const tableArea = gridScroller ? gridScroller.parentElement : null;
        return !!(active && tableArea && tableArea.contains(active)
            && (active.matches('input, textarea, select') || active.isContentEditable));
    }

    function renderAutoRefreshSelect() {
        if (!autoRefreshSelect) return;
        autoRefreshSelect.innerHTML = autoRefreshOptions(autoRefreshSeconds)
            .map(o => '<option value="' + escapeAttr(o.value) + '">' + escapeHtml(o.label) + '</option>')
            .join('');
        autoRefreshSelect.value = String(autoRefreshSeconds);
        autoRefreshControl.classList.toggle('is-active', autoRefreshSeconds > 0);
        updateAutoRefreshTitle();
    }

    function updateAutoRefreshTitle() {
        if (!autoRefreshControl) return;
        let title = autoRefreshSeconds > 0
            ? 'Auto refresh: the query runs again every ' + formatAutoRefreshInterval(autoRefreshSeconds)
            : 'Auto refresh: run the query again at a fixed interval';
        if (autoRefreshSeconds > 0 && lastAutoRefreshAt) {
            title += '\nLast refreshed at ' + lastAutoRefreshAt.toLocaleTimeString();
        }
        autoRefreshControl.title = title;
    }

    function setAutoRefreshStatus(text) {
        if (!autoRefreshStatus) return;
        autoRefreshStatus.textContent = text || '';
        autoRefreshStatus.title = text || '';
        autoRefreshStatus.classList.toggle('hidden', !text);
    }

    function setAutoRefreshBusyIndicator(active) {
        if (autoRefreshControl) autoRefreshControl.classList.toggle('is-refreshing', !!active);
    }

    function scheduleAutoRefresh(delayMs) {
        if (autoRefreshTimer) {
            clearTimeout(autoRefreshTimer);
            autoRefreshTimer = null;
        }
        if (!autoRefreshSeconds) return;
        autoRefreshTimer = setTimeout(autoRefreshTick, delayMs != null ? delayMs : autoRefreshSeconds * 1000);
    }

    function setAutoRefreshInterval(seconds) {
        autoRefreshSeconds = Math.max(0, Math.round(Number(seconds) || 0));
        if (!autoRefreshSeconds) {
            autoRefreshInFlight = null;
            setAutoRefreshBusyIndicator(false);
        }
        lastAutoRefreshAt = null;
        renderAutoRefreshSelect();
        setAutoRefreshStatus('');
        scheduleAutoRefresh();
    }

    function stopAutoRefresh(status) {
        setAutoRefreshInterval(0);
        setAutoRefreshStatus(status);
    }

    function autoRefreshTick() {
        autoRefreshTimer = null;
        const reason = autoRefreshPauseReason({
            hasQuery: !!(userPaged ? lastRunRawSql : currentSql),
            visible: panelVisible,
            pendingChanges: hasPendingGridChanges(),
            busy: isAutoRefreshBusy()
        });
        if (reason === 'noQuery') {
            scheduleAutoRefresh();
            return;
        }
        if (reason) {
            if (AUTO_REFRESH_PAUSE_LABELS[reason]) setAutoRefreshStatus(AUTO_REFRESH_PAUSE_LABELS[reason]);
            scheduleAutoRefresh(AUTO_REFRESH_RETRY_MS);
            return;
        }
        runAutoRefresh();
    }

    function runAutoRefresh() {
        const plan = autoRefreshLoadPlan({
            currentSql, userPaged, lastRawSql: lastRunRawSql,
            loadedRows: allRows.length, allLoaded, pageSize: PAGE_SIZE
        });
        if (!plan.sql.trim()) {
            scheduleAutoRefresh();
            return;
        }
        latestLoadId = ++loadCounter;
        autoRefreshInFlight = { id: latestLoadId, limit: plan.limit };
        setAutoRefreshBusyIndicator(true);
        vscode.postMessage({
            command: 'loadRows',
            sql: plan.sql,
            baseSql: currentSql,
            append: false,
            // Keep a known row count up to date.
            wantTotal: lastRunWantTotal || totalCount !== null,
            autoRefresh: true,
            autoRefreshId: latestLoadId,
            loadId: latestLoadId
        });
    }

    function autoRefreshSucceeded() {
        lastAutoRefreshAt = new Date();
        setAutoRefreshBusyIndicator(false);
        setAutoRefreshStatus('');
        updateAutoRefreshTitle();
        scheduleAutoRefresh();
    }

    // Keep the place the user was looking at across an auto refresh.
    function captureGridViewState() {
        return {
            scrollTop: gridScroller ? gridScroller.scrollTop : 0,
            scrollLeft: gridScroller ? gridScroller.scrollLeft : 0,
            selectedRowIdx,
            anchor: rangeAnchor ? { r: rangeAnchor.r, c: rangeAnchor.c } : null,
            focus: rangeFocus ? { r: rangeFocus.r, c: rangeFocus.c } : null
        };
    }

    function restoreGridViewState(state) {
        if (!state) return;
        if (gridScroller) {
            gridScroller.scrollTop = state.scrollTop;
            gridScroller.scrollLeft = state.scrollLeft;
        }
        // The rows at the restored position have to be in the DOM before the
        // selection is marked on them.
        renderWindow(false);
        const rowCount = renderPlan.length;
        if (state.anchor && state.focus && Math.max(state.anchor.r, state.focus.r) < rowCount) {
            rangeAnchor = state.anchor;
            rangeFocus = state.focus;
            applyCellRangeHighlight();
        }
    }

    if (autoRefreshSelect) {
        autoRefreshSelect.addEventListener('change', () => {
            const value = autoRefreshSelect.value;
            if (value === 'custom') {
                // Keep showing the interval in use until the host answers.
                autoRefreshSelect.value = String(autoRefreshSeconds);
                vscode.postMessage({ command: 'chooseAutoRefreshInterval', current: autoRefreshSeconds });
                return;
            }
            setAutoRefreshInterval(Number(value));
        });
        renderAutoRefreshSelect();
        setAutoRefreshStatus('');
    }

    function updateChangeIndicator() {
        const state = describePendingChanges({
            modified: modifiedCells.size,
            inserted: insertedRows.length,
            duplicated: duplicatedRows.length,
            deleted: deletedRows.size
        }, invalidCells.size);
        changeCount.textContent = state.text;
        commitBtn.disabled = !state.canCommit;
        discardBtn.disabled = !state.canDiscard;
    }

    let pendingChanges = null;
    // The statements as generated for the pending changes, so a manual edit in
    // the preview dialog can be detected (and undone).
    let generatedSql = '';

    function commitChanges() {
        const totalChanges = modifiedCells.size + deletedRows.size + insertedRows.length + duplicatedRows.length;
        if (totalChanges === 0) return;
        if (invalidCells.size > 0) {
            showError('Some cells hold a value their column cannot store. Fix the cells marked in red first.');
            return;
        }

        // Build updates grouped by row
        const rowUpdates = new Map();
        for (const [key, value] of modifiedCells.entries()) {
            const { rowIdx, colName } = parseCellKey(key);
            if (deletedRows.has(rowIdx)) continue; // Skip if row is also deleted

            if (!rowUpdates.has(rowIdx)) {
                rowUpdates.set(rowIdx, {});
            }
            rowUpdates.get(rowIdx)[colName] = value;
        }

        // Each edited column is written back to the table it really came from,
        // so a result joined from several tables commits correctly.
        const targets = buildCommitTargets(caps, allRows, {
            updates: Array.from(rowUpdates.entries()),
            deletes: Array.from(deletedRows),
            inserts: [...insertedRows, ...duplicatedRows].map(entry => entry.row)
        });

        if (targets.length === 0) {
            showError('Nothing can be written back: the edited columns cannot be traced to a table row.');
            return;
        }

        pendingChanges = targets;
        vscode.postMessage({ command: 'previewSQL', targets });
    }

    function showSqlDialog(sql, connectionName) {
        generatedSql = sql;
        sqlDialogContent.value = sql;
        const curr = (typeof connectionName === 'string' && connectionName) ? connectionName : currentConnection;
        if (curr) currentConnection = curr;
        const last = lastUsedConnection || '(none)';
        const currLabel = curr || '(none)';
        if (sqlDialogConnection) {
            sqlDialogConnection.textContent = `Current connection: ${currLabel}  |  Data loaded with: ${last}`;
        }
        if (sqlDialogWarning) {
            const warnings = buildCommitWarnings(caps.warning, curr, lastUsedConnection, pendingChanges);
            sqlDialogWarning.textContent = warnings.map(w => `⚠ ${w}`).join('\n');
            sqlDialogWarning.style.display = warnings.length > 0 ? 'block' : 'none';
        }
        updateConnectionDisplay();
        sqlDialogOverlay.style.display = 'flex';
    }

    function updateConnectionDisplay() {
        if (!connectionInfo) return;
        const badge = buildConnectionBadge(lastUsedConnection, currentConnection);
        connectionInfo.textContent = badge.text;
        connectionInfo.classList.toggle('warn', badge.warn);
        connectionInfo.title = badge.title;
    }

    function updateSessionDisplay(info) {
        if (!sessionInfo) return;
        const badge = buildSessionBadge(info);
        sessionInfo.classList.toggle('hidden', !badge);
        if (!badge) return;
        sessionInfo.textContent = badge.text;
        sessionInfo.title = badge.title;
        sessionInfo.setAttribute('aria-label', badge.title);
        sessionInfo.classList.toggle('is-open', badge.open);
    }

    function closeSqlDialog() {
        sqlDialogOverlay.style.display = 'none';
        pendingChanges = null;
        generatedSql = '';
    }

    function executePendingChanges() {
        if (!pendingChanges) return;
        const edited = sqlDialogContent.value;
        // Only a manually edited script is executed verbatim; otherwise the
        // extension commits the parameterized statements it generated.
        const message = isSqlEdited(generatedSql, edited)
            ? { command: 'commitChanges', targets: pendingChanges, sql: edited }
            : { command: 'commitChanges', targets: pendingChanges };
        vscode.postMessage(message);
        sqlDialogOverlay.style.display = 'none';
        pendingChanges = null;
        generatedSql = '';
    }

    function handleCommitSuccess() {
        // Reset state and re-run the query the grid currently shows, so a
        // filtered or custom view is not silently replaced by the default one.
        resetPendingChanges();
        runQuery();
    }

    function discardChanges() {
        resetPendingChanges();
        runQuery();
        updateChangeIndicator();
    }

    function showError(text) {
        // A failed query leaves the grid in its loading state; release it so the
        // view does not keep spinning forever.
        setDataLoading(false);
        changeCount.textContent = `Error: ${text}`;
        changeCount.classList.add('status-error');
        setTimeout(() => {
            changeCount.classList.remove('status-error');
            updateChangeIndicator();
        }, 5000);
        showErrorDialog(text);
    }

    // Close a dialog when its backdrop is clicked, but not when a press that
    // began inside the dialog (resizing a text box, selecting text) is released
    // over the backdrop.
    function closeOnBackdropClick(overlay, close) {
        let pressTarget = null;
        overlay.addEventListener('mousedown', (e) => { pressTarget = e.target; });
        overlay.addEventListener('click', (e) => {
            const dismiss = isBackdropDismissClick(overlay, pressTarget, e.target);
            pressTarget = null;
            if (dismiss) close();
        });
    }

    // Modal error dialog shown inside the Data Viewer so a failing query is not
    // only reported through the small VS Code notification.
    const errorDialogOverlay = document.getElementById('errorDialogOverlay');
    const errorDialogMessage = document.getElementById('errorDialogMessage');
    const errorDialogClose = document.getElementById('errorDialogClose');
    const errorDialogOk = document.getElementById('errorDialogOk');

    function showErrorDialog(text) {
        if (!errorDialogOverlay || !errorDialogMessage) {
            return;
        }
        const state = buildErrorDialogState(text);
        if (!state.visible) {
            return;
        }
        errorDialogMessage.textContent = state.message;
        errorDialogOverlay.style.display = 'flex';
    }

    function closeErrorDialog() {
        if (errorDialogOverlay) {
            errorDialogOverlay.style.display = 'none';
        }
    }

    if (errorDialogClose) errorDialogClose.addEventListener('click', closeErrorDialog);
    if (errorDialogOk) errorDialogOk.addEventListener('click', closeErrorDialog);
    if (errorDialogOverlay) closeOnBackdropClick(errorDialogOverlay, closeErrorDialog);

    // ===== Permanent Constraints Dialog Logic =====
    const constraintsBtn = document.getElementById('constraintsBtn');
    const constraintsDialogOverlay = document.getElementById('constraintsDialogOverlay');
    const constraintsDialogClose = document.getElementById('constraintsDialogClose');
    const constraintsList = document.getElementById('constraintsList');
    const constraintsAdd = document.getElementById('constraintsAdd');
    const constraintSortsList = document.getElementById('constraintSortsList');
    const constraintSortsAdd = document.getElementById('constraintSortsAdd');
    const constraintsSave = document.getElementById('constraintsSave');
    const constraintsCancel = document.getElementById('constraintsCancel');
    const constraintsPreview = document.getElementById('constraintsPreview');

    // Working copy edited in the dialog; committed to permanentConstraints on Save.
    let constraintDraft = [];
    // Working copy of the permanent ORDER BY entries, committed on Save.
    let constraintSortDraft = [];

    if (constraintsBtn) constraintsBtn.addEventListener('click', openConstraintsDialog);
    if (constraintsDialogClose) constraintsDialogClose.addEventListener('click', closeConstraintsDialog);
    if (constraintsCancel) constraintsCancel.addEventListener('click', closeConstraintsDialog);
    if (constraintsAdd) constraintsAdd.addEventListener('click', () => {
        const cols = columns || [];
        const left = cols.length ? { kind: 'column', column: cols[0].name } : { kind: 'raw', text: '' };
        constraintDraft.push({ operator: '=', left, right: { kind: 'raw', text: '' } });
        renderConstraintRows();
    });
    if (constraintSortsAdd) constraintSortsAdd.addEventListener('click', () => {
        const cols = columns || [];
        constraintSortDraft.push({ column: cols.length ? cols[0].name : '', direction: 'ASC' });
        renderConstraintSortRows();
    });
    if (constraintsSave) constraintsSave.addEventListener('click', saveConstraints);

    function openConstraintsDialog() {
        // Deep-clone current constraints into a draft so Cancel discards edits.
        constraintDraft = JSON.parse(JSON.stringify(permanentConstraints || []));
        constraintSortDraft = JSON.parse(JSON.stringify(permanentSorts || []));
        renderConstraintRows();
        renderConstraintSortRows();
        constraintsDialogOverlay.style.display = 'flex';
    }

    function closeConstraintsDialog() {
        constraintsDialogOverlay.style.display = 'none';
    }

    // Render the dropdown + optional text input for one operand of a constraint.
    // Mirrors the Join dialog's fixed-condition operandControls design.
    function constraintOperandControls(ci, side, operand) {
        const cols = columns || [];
        const op = operand || { kind: 'raw', text: '' };
        const colOpts = cols.map(c => {
            const sel = op.kind === 'column' && op.column === c.name;
            return '<option value="c\u0001' + escapeAttr(c.name) + '" ' + (sel ? 'selected' : '') + '>' + escapeHtml(c.name) + '</option>';
        }).join('');
        const rawSel = op.kind === 'raw' ? 'selected' : '';
        const sel = '<select class="operand-kind" data-cons-op="' + ci + ':' + side + '">' +
            colOpts +
            '<option value="__raw__" ' + rawSel + '>Custom value…</option>' +
            '</select>';
        const rawInput = op.kind === 'raw'
            ? '<input class="cust-raw" data-cons-raw="' + ci + ':' + side + '" value="' + escapeAttr(op.text || '') + '" placeholder="value / expression">'
            : '';
        return sel + rawInput;
    }

    function renderConstraintRows() {
        let html = '';
        constraintDraft.forEach((c, ci) => {
            const operatorOpts = CONSTRAINT_OPERATORS.map(o =>
                '<option ' + (o === c.operator ? 'selected' : '') + '>' + o + '</option>'
            ).join('');
            let row = '<div class="cond-row">' +
                constraintOperandControls(ci, 'left', c.left) +
                '<select class="operand-operator" data-cons-operator="' + ci + '">' + operatorOpts + '</select>';
            if (constraintIsBetween(c.operator)) {
                row += constraintOperandControls(ci, 'right', c.right) +
                    '<span>AND</span>' +
                    constraintOperandControls(ci, 'right2', c.right2);
            } else if (!constraintIsUnary(c.operator)) {
                row += constraintOperandControls(ci, 'right', c.right);
            }
            row += '<button class="btn" data-cons-rm="' + ci + '">Remove</button></div>';
            html += row;
        });
        constraintsList.innerHTML = html;
        bindConstraintRows();
        updateConstraintPreview();
    }

    function bindConstraintRows() {
        constraintsList.querySelectorAll('[data-cons-operator]').forEach(seln => {
            seln.onchange = () => {
                const ci = Number(seln.dataset.consOperator);
                const c = constraintDraft[ci];
                c.operator = seln.value;
                if (constraintIsUnary(c.operator)) {
                    delete c.right; delete c.right2;
                } else if (constraintIsBetween(c.operator)) {
                    if (!c.right) c.right = { kind: 'raw', text: '' };
                    if (!c.right2) c.right2 = { kind: 'raw', text: '' };
                } else {
                    if (!c.right) c.right = { kind: 'raw', text: '' };
                    delete c.right2;
                }
                renderConstraintRows();
            };
        });
        constraintsList.querySelectorAll('[data-cons-op]').forEach(seln => {
            seln.onchange = () => {
                const parts = seln.dataset.consOp.split(':');
                const c = constraintDraft[Number(parts[0])];
                const side = parts[1];
                const raw = seln.value;
                let operand;
                if (raw === '__raw__') {
                    operand = { kind: 'raw', text: '' };
                } else {
                    const si = raw.indexOf('\u0001');
                    operand = { kind: 'column', column: raw.slice(si + 1) };
                }
                c[side] = operand;
                renderConstraintRows();
            };
        });
        constraintsList.querySelectorAll('[data-cons-raw]').forEach(inp => {
            inp.oninput = () => {
                const parts = inp.dataset.consRaw.split(':');
                const c = constraintDraft[Number(parts[0])];
                const side = parts[1];
                if (!c[side] || c[side].kind !== 'raw') c[side] = { kind: 'raw', text: '' };
                c[side].text = inp.value;
                updateConstraintPreview();
            };
        });
        constraintsList.querySelectorAll('[data-cons-rm]').forEach(b => {
            b.onclick = () => {
                constraintDraft.splice(Number(b.dataset.consRm), 1);
                renderConstraintRows();
            };
        });
    }

    function updateConstraintPreview() {
        const where = buildConstraintWhere(constraintDraft, formatIdentifier);
        const orderBy = buildConstraintOrderBy(constraintSortDraft, formatIdentifier);
        constraintsPreview.textContent = `SELECT * FROM ${getDefaultTableReference()}`
            + (where ? ` WHERE ${where}` : '')
            + (orderBy ? ` ORDER BY ${orderBy}` : '');
    }

    function renderConstraintSortRows() {
        if (!constraintSortsList) return;
        const cols = columns || [];
        let html = '';
        constraintSortDraft.forEach((s, si) => {
            const known = cols.some(c => c.name === s.column);
            const colOpts = cols.map(c =>
                '<option value="' + escapeAttr(c.name) + '" ' + (c.name === s.column ? 'selected' : '') + '>' + escapeHtml(c.name) + '</option>'
            ).join('');
            // Keep a stored column that is not part of the current result, so
            // switching queries does not silently drop it.
            const missingOpt = (!known && s.column)
                ? '<option value="' + escapeAttr(s.column) + '" selected>' + escapeHtml(s.column) + '</option>'
                : '';
            const dirOpts = CONSTRAINT_SORT_DIRECTIONS.map(d =>
                '<option ' + (d === String(s.direction || '').toUpperCase() ? 'selected' : '') + '>' + d + '</option>'
            ).join('');
            html += '<div class="cond-row">' +
                '<select class="operand-kind" data-sort-col="' + si + '">' + missingOpt + colOpts + '</select>' +
                '<select class="operand-operator" data-sort-dir="' + si + '">' + dirOpts + '</select>' +
                '<button class="btn" data-sort-rm="' + si + '">Remove</button>' +
                '</div>';
        });
        constraintSortsList.innerHTML = html;
        bindConstraintSortRows();
        updateConstraintPreview();
    }

    function bindConstraintSortRows() {
        constraintSortsList.querySelectorAll('[data-sort-col]').forEach(seln => {
            seln.onchange = () => {
                constraintSortDraft[Number(seln.dataset.sortCol)].column = seln.value;
                updateConstraintPreview();
            };
        });
        constraintSortsList.querySelectorAll('[data-sort-dir]').forEach(seln => {
            seln.onchange = () => {
                constraintSortDraft[Number(seln.dataset.sortDir)].direction = seln.value;
                updateConstraintPreview();
            };
        });
        constraintSortsList.querySelectorAll('[data-sort-rm]').forEach(b => {
            b.onclick = () => {
                constraintSortDraft.splice(Number(b.dataset.sortRm), 1);
                renderConstraintSortRows();
            };
        });
    }

    function saveConstraints() {
        // Drop incomplete rows so persisted constraints always format to SQL.
        permanentConstraints = constraintDraft.filter(c => formatConstraintCondition(c, formatIdentifier));
        permanentSorts = constraintSortDraft.filter(s => formatConstraintSort(s, formatIdentifier));
        vscode.postMessage({
            command: 'savePermanentConstraints',
            conditions: permanentConstraints,
            sorts: permanentSorts
        });
        closeConstraintsDialog();
        setQueryText(getDefaultQuery());
        runQuery();
    }

    // ===== Group Edit Logic =====

    // The real column names of the base table used to seed a group UPDATE's SET
    // list: the editable columns of the plan whose alias/name matches the FROM
    // table. Returns an empty list when the base table is not editable.
    function collectGroupEditSetColumns(parsed) {
        const baseName = parsed.base.tableName;
        const baseAlias = parsed.base.alias;
        const candidates = (caps.tables || []).filter(t => t.table === baseName);
        let plan = null;
        if (baseAlias) {
            plan = candidates.find(t => t.qualifier === baseAlias) || null;
        }
        if (!plan) {
            plan = candidates.find(t => t.identityStrategy !== 'none') || candidates[0] || null;
        }
        if (!plan || plan.identityStrategy === 'none') {
            return [];
        }
        const seen = new Set();
        const cols = [];
        (plan.columns || []).forEach(c => {
            if (c && c.sourceColumn && !seen.has(c.sourceColumn)) {
                seen.add(c.sourceColumn);
                cols.push(c.sourceColumn);
            }
        });
        return cols;
    }

    function generateGroupEdit(kind) {
        const sql = (queryInput.value || '').trim() || getDefaultQuery();
        const parsed = parseGroupEditQuery(sql);
        if (!parsed) {
            vscode.postMessage({
                command: 'showError',
                text: 'A group ' + kind.toUpperCase() + ' can only be generated from a plain SELECT with a FROM clause '
                    + '(no CTE, set operation or comment).'
            });
            return;
        }
        const setColumns = kind === 'update' ? collectGroupEditSetColumns(parsed) : [];
        const generated = buildGroupEditSql(kind, parsed, setColumns, formatIdentifier);
        vscode.postMessage({ command: 'openGeneratedStatement', sql: generated, kind: kind });
    }

    if (groupUpdateBtn) groupUpdateBtn.addEventListener('click', () => generateGroupEdit('update'));
    if (groupDeleteBtn) groupDeleteBtn.addEventListener('click', () => generateGroupEdit('delete'));

    // ===== Saved Queries Logic =====
    const querySaveBtn = document.getElementById('querySaveBtn');
    const queryParamsBtn = document.getElementById('queryParamsBtn');
    const queryParamsDialogOverlay = document.getElementById('queryParamsDialogOverlay');
    const queryParamsDialogTitle = document.getElementById('queryParamsDialogTitle');
    const queryParamsDialogClose = document.getElementById('queryParamsDialogClose');
    const queryParamsList = document.getElementById('queryParamsList');
    const queryParamsPreview = document.getElementById('queryParamsPreview');
    const queryParamsRun = document.getElementById('queryParamsRun');
    const queryParamsCancel = document.getElementById('queryParamsCancel');

    const PARAMETER_KINDS = [
        { value: 'text', label: 'Text (quoted)' },
        { value: 'number', label: 'Number' },
        { value: 'identifier', label: 'Identifier (quoted)' },
        { value: 'raw', label: 'Raw SQL (unchecked!)' }
    ];

    // Values entered in the parameter dialog before they are applied.
    let queryParamsDraft = {};

    if (querySaveBtn) querySaveBtn.addEventListener('click', bookmarkQuery);
    if (queryParamsBtn) queryParamsBtn.addEventListener('click', () => openQueryParamsDialog(false));
    if (queryParamsDialogClose) queryParamsDialogClose.addEventListener('click', closeQueryParamsDialog);
    if (queryParamsCancel) queryParamsCancel.addEventListener('click', closeQueryParamsDialog);
    if (queryParamsRun) queryParamsRun.addEventListener('click', applyQueryParamsDialog);

    // A bookmark is described in the dialog of the Bookmarked Queries panel, so
    // name, scope, statement and placeholders look the same on every surface.
    function bookmarkQuery() {
        // A running saved query starts from its template, so the placeholders
        // are preserved instead of the values already filled in.
        const source = savedQueryId && savedQueryTemplate
            ? savedQueryTemplate
            : (queryInput.value || '').trim();
        if (!source) {
            showError('There is no statement to bookmark.');
            return;
        }
        vscode.postMessage({
            command: 'bookmarkQuery',
            id: savedQueryId || '',
            name: table ? schema + '.' + table : '',
            sql: source
        });
    }

    /**
     * Ask for the placeholder values of the running saved query.
     * @param {boolean} initial true when the panel just opened and must not
     *   show a result until the values are known.
     */
    function openQueryParamsDialog(initial) {
        queryParamsPendingInitialRun = Boolean(initial);
        queryParamsDraft = {};
        savedQueryParameters.forEach(p => {
            const stored = savedQueryValues[p.name];
            queryParamsDraft[p.name] = stored !== undefined && stored !== null && stored !== ''
                ? String(stored)
                : (p.defaultValue || '');
        });
        queryParamsDialogTitle.textContent = 'Parameters for "' + (tableName.textContent || 'query') + '"';
        renderQueryParamRows();
        queryParamsDialogOverlay.style.display = 'flex';
        const first = queryParamsList.querySelector('input');
        if (first) first.focus();
    }

    function closeQueryParamsDialog() {
        queryParamsDialogOverlay.style.display = 'none';
        if (queryParamsPendingInitialRun) {
            // The panel opened for a saved query but the values were dismissed,
            // so nothing was ever run — say so instead of showing an empty grid.
            queryParamsPendingInitialRun = false;
            rowCount.textContent = 'Waiting for parameters — press "Parameters…" to run the query.';
        }
    }

    function renderQueryParamRows() {
        queryParamsList.innerHTML = savedQueryParameters.map((p, i) => {
            const kind = PARAMETER_KINDS.find(k => k.value === p.kind) || PARAMETER_KINDS[0];
            const warn = p.kind === 'raw'
                ? '<span class="mapping-hint">inserted unchanged</span>'
                : '<span class="mapping-hint">' + escapeHtml(kind.label) + '</span>';
            return '<div class="cond-row">' +
                '<label for="queryParamInput' + i + '">' + escapeHtml(p.label || (':' + p.name)) + '</label>' +
                '<input class="cust-raw" id="queryParamInput' + i + '" data-query-param="' + escapeAttr(p.name) + '" value="' +
                escapeAttr(queryParamsDraft[p.name] || '') + '">' +
                warn +
                '</div>';
        }).join('');
        queryParamsList.querySelectorAll('[data-query-param]').forEach(el => {
            el.oninput = () => {
                queryParamsDraft[el.dataset.queryParam] = el.value;
                updateQueryParamsPreview();
            };
            el.onkeydown = (e) => {
                if (e.key === 'Enter') { e.preventDefault(); applyQueryParamsDialog(); }
            };
        });
        updateQueryParamsPreview();
    }

    function updateQueryParamsPreview() {
        try {
            queryParamsPreview.textContent =
                applyQueryParameters(savedQueryTemplate, queryParamsDraft, savedQueryParameters);
        } catch (err) {
            queryParamsPreview.textContent = err && err.message ? err.message : String(err);
        }
    }

    function applyQueryParamsDialog() {
        let sql;
        try {
            sql = applyQueryParameters(savedQueryTemplate, queryParamsDraft, savedQueryParameters);
        } catch (err) {
            showError(err && err.message ? err.message : String(err));
            return;
        }
        savedQueryValues = Object.assign({}, queryParamsDraft);
        if (savedQueryId) {
            vscode.postMessage({
                command: 'saveSavedQueryValues',
                id: savedQueryId,
                values: savedQueryValues
            });
        }
        queryParamsPendingInitialRun = false;
        closeQueryParamsDialog();
        setQueryText(sql);
        runQuery();
    }

    // Reflect the query stored by the panel so a second "Bookmark Query"
    // updates it instead of creating another copy, and so the placeholders of
    // the grid match the ones that were just described.
    function handleSavedQuerySaved(msg) {
        if (typeof msg.id !== 'string' || !msg.id) return;
        savedQueryId = msg.id;
        if (typeof msg.sql === 'string') savedQueryTemplate = msg.sql;
        if (Array.isArray(msg.parameters)) savedQueryParameters = msg.parameters;
        updateQueryParamsButton();
    }

    // ===== Export Dialog Logic =====
    const exportBtn = document.getElementById('exportBtn');
    const exportDialogOverlay = document.getElementById('exportDialogOverlay');
    const exportDialogClose = document.getElementById('exportDialogClose');
    const exportFormat = document.getElementById('exportFormat');
    const exportFilename = document.getElementById('exportFilename');
    const exportExecute = document.getElementById('exportExecute');
    const exportCancel = document.getElementById('exportCancel');
    const exportSaveDefault = document.getElementById('exportSaveDefault');

    const exportOptGroups = {
        csv: document.getElementById('exportOptsCsv'),
        json: document.getElementById('exportOptsJson'),
        xml: document.getElementById('exportOptsXml'),
        insert: document.getElementById('exportOptsInsert'),
        excel: document.getElementById('exportOptsExcel')
    };

    let exportDefaults = {};

    const csvSeparatorSelect = document.getElementById('csvSeparator');
    const csvCustomSeparatorField = document.getElementById('csvCustomSeparatorField');
    const exportSaveLocation = document.getElementById('exportSaveLocation');

    exportBtn.addEventListener('click', openExportDialog);
    exportDialogClose.addEventListener('click', closeExportDialog);
    exportCancel.addEventListener('click', closeExportDialog);
    exportExecute.addEventListener('click', executeExport);
    exportSaveDefault.addEventListener('click', saveExportDefault);
    exportFormat.addEventListener('change', onExportFormatChange);
    csvSeparatorSelect.addEventListener('change', () => {
        csvCustomSeparatorField.style.display = csvSeparatorSelect.value === '__custom__' ? 'flex' : 'none';
    });
    document.getElementById('exportBrowseLocation').addEventListener('click', () => {
        vscode.postMessage({ command: 'browseExportLocation' });
    });

    function openExportDialog() {
        vscode.postMessage({ command: 'getExportDefaults' });
        exportFilename.value = table || 'export';
        const insertTableName = document.getElementById('insertTableName');
        if (insertTableName) {
            insertTableName.value = defaultInsertTableName(getDefaultTableReference());
        }
        onExportFormatChange();
        exportDialogOverlay.style.display = 'flex';
    }

    function closeExportDialog() {
        exportDialogOverlay.style.display = 'none';
        // In an Export tab the dialog is all there is: closing it cancels.
        if (exportOnly) {
            vscode.postMessage({ command: 'exportDialogResult', options: null });
        }
    }

    // The Export tab of an `-- @export … dialog` instruction in a SQL file:
    // only the export dialog, prefilled from the instruction, whose answer goes
    // back to the run of the file instead of exporting from a grid.
    let exportOnly = null;

    function startExportOnly(prefill, title) {
        exportOnly = prefill || {};
        document.body.classList.add('export-only');
        // Writing an `-- @export` line instead of exporting.
        document.body.classList.toggle('export-instruction', exportOnly.purpose === 'instruction');
        setDataLoading(false);
        // The dialog names where the query comes from and shows it as written.
        document.getElementById('exportDialogTitle').textContent = title || 'Export Data';
        document.getElementById('exportQuerySql').textContent = typeof exportOnly.sql === 'string' ? exportOnly.sql : '';
        document.getElementById('exportExecuteLabel').textContent = exportOnly.submitLabel || 'Export';
        document.getElementById('exportAskAtRunTime').checked = exportOnly.askAtRunTime === true;
        document.getElementById('exportDialogError').textContent = '';
        const options = exportOnly.options || {};
        // The key columns of ON CONFLICT … DO UPDATE come from the instruction.
        document.getElementById('insertConflictColumns').value = Array.isArray(options.insertConflictColumns)
            ? options.insertConflictColumns.join(', ')
            : '';
        if (exportOptGroups[exportOnly.format]) exportFormat.value = exportOnly.format;
        openExportDialog();
        applyExportPrefill();
    }

    // The instruction outranks the saved defaults, so it is applied after them.
    function applyExportPrefill() {
        if (!exportOnly) return;
        const options = exportOnly.options || {};
        // An instruction may have no file on purpose: then it asks when it runs.
        if (typeof exportOnly.fileName === 'string') exportFilename.value = exportOnly.fileName;
        if (exportOnly.folder) exportSaveLocation.value = exportOnly.folder;
        onExportFormatChange();
        applyExportFormatOptions(exportFormat.value, options);
        if (options.insertTableName) document.getElementById('insertTableName').value = options.insertTableName;
    }

    function onExportFormatChange() {
        const fmt = exportFormat.value;
        Object.keys(exportOptGroups).forEach(key => {
            exportOptGroups[key].style.display = key === fmt ? 'block' : 'none';
        });
        const extensions = { csv: '.csv', json: '.json', xml: '.xml', insert: '.sql', excel: '.xlsx' };
        const base = exportFilename.value.replace(/\.(csv|json|xml|sql|xlsx)$/, '');
        exportFilename.value = base;
        exportFilename.placeholder = `filename (${extensions[fmt]})`;
    }

    function applyExportDefaults(defaults) {
        exportDefaults = defaults || {};
        if (exportDefaults._saveLocation) {
            exportSaveLocation.value = exportDefaults._saveLocation;
        }
        const fmt = exportFormat.value;
        const defs = exportDefaults[fmt];
        if (!defs) return;
        applyExportFormatOptions(fmt, defs);
    }

    // Put the options of one format into the dialog's fields.
    function applyExportFormatOptions(fmt, defs) {
        if (fmt === 'csv') {
            if (defs.csvSeparator) {
                // Check if the separator matches a preset
                const presets = [',', ';', '\t', '|'];
                if (presets.includes(defs.csvSeparator)) {
                    csvSeparatorSelect.value = defs.csvSeparator;
                    csvCustomSeparatorField.style.display = 'none';
                } else {
                    csvSeparatorSelect.value = '__custom__';
                    document.getElementById('csvCustomSeparator').value = defs.csvSeparator;
                    csvCustomSeparatorField.style.display = 'flex';
                }
            }
            if (defs.csvIncludeHeaders !== undefined) document.getElementById('csvIncludeHeaders').checked = defs.csvIncludeHeaders;
            if (defs.csvQuoteStrings !== undefined) document.getElementById('csvQuoteStrings').checked = defs.csvQuoteStrings;
            if (defs.csvLineEnding) document.getElementById('csvLineEnding').value = defs.csvLineEnding;
        } else if (fmt === 'json') {
            if (defs.jsonPretty !== undefined) document.getElementById('jsonPretty').checked = defs.jsonPretty;
            if (defs.jsonArrayWrapper !== undefined) document.getElementById('jsonArrayWrapper').checked = defs.jsonArrayWrapper;
        } else if (fmt === 'xml') {
            if (defs.xmlRootElement) document.getElementById('xmlRootElement').value = defs.xmlRootElement;
            if (defs.xmlRowElement) document.getElementById('xmlRowElement').value = defs.xmlRowElement;
        } else if (fmt === 'insert') {
            if (defs.insertBatchSize) document.getElementById('insertBatchSize').value = defs.insertBatchSize;
            if (defs.insertOnConflict) document.getElementById('insertOnConflict').value = defs.insertOnConflict;
        } else if (fmt === 'excel') {
            if (defs.excelIncludeHeaders !== undefined) document.getElementById('excelIncludeHeaders').checked = defs.excelIncludeHeaders;
            if (defs.excelSheetName) document.getElementById('excelSheetName').value = defs.excelSheetName;
            if (defs.excelIncludeSqlSheet !== undefined) document.getElementById('excelIncludeSqlSheet').checked = defs.excelIncludeSqlSheet;
        }
    }

    function gatherExportOptions() {
        const fmt = exportFormat.value;
        const filename = exportFilename.value.trim() || 'export';
        const extensions = { csv: '.csv', json: '.json', xml: '.xml', insert: '.sql', excel: '.xlsx' };
        const ext = extensions[fmt];
        const fullFilename = filename.endsWith(ext) ? filename : filename + ext;

        const opts = {
            format: fmt,
            filename: fullFilename
        };

        if (fmt === 'csv') {
            const sepVal = csvSeparatorSelect.value;
            opts.csvSeparator = sepVal === '__custom__' ? (document.getElementById('csvCustomSeparator').value || ',') : sepVal;
            opts.csvIncludeHeaders = document.getElementById('csvIncludeHeaders').checked;
            opts.csvQuoteStrings = document.getElementById('csvQuoteStrings').checked;
            opts.csvLineEnding = document.getElementById('csvLineEnding').value;
        } else if (fmt === 'json') {
            opts.jsonPretty = document.getElementById('jsonPretty').checked;
            opts.jsonArrayWrapper = document.getElementById('jsonArrayWrapper').checked;
        } else if (fmt === 'xml') {
            opts.xmlRootElement = document.getElementById('xmlRootElement').value || 'data';
            opts.xmlRowElement = document.getElementById('xmlRowElement').value || 'row';
        } else if (fmt === 'insert') {
            const typedTable = document.getElementById('insertTableName').value.trim();
            // The Export tab of a SQL file has no table to fall back to: the
            // extension asks for one rather than inventing it.
            opts.insertTableName = typedTable || (exportOnly ? '' : defaultInsertTableName(getDefaultTableReference()));
            opts.insertBatchSize = parseInt(document.getElementById('insertBatchSize').value) || 1;
            opts.insertOnConflict = document.getElementById('insertOnConflict').value || 'none';
            // The conflict target for DO UPDATE is the primary key; every other
            // column is rewritten from EXCLUDED on the host side. The Export
            // tab of a SQL file has no table, so its key columns are entered.
            opts.insertConflictColumns = exportOnly
                ? document.getElementById('insertConflictColumns').value.split(',').map(c => c.trim()).filter(c => c)
                : primaryKeys.slice();
        } else if (fmt === 'excel') {
            opts.excelIncludeHeaders = document.getElementById('excelIncludeHeaders').checked;
            opts.excelSheetName = document.getElementById('excelSheetName').value || 'Data';
            opts.excelIncludeSqlSheet = document.getElementById('excelIncludeSqlSheet').checked;
            opts.excelSqlStatement = queryInput.value;
        }

        return opts;
    }

    function executeExport() {
        const opts = gatherExportOptions();
        opts.saveLocation = exportSaveLocation.value.trim() || '';
        if (exportOnly) {
            // The name as typed: an instruction keeps placeholders and may have none.
            opts.typedFilename = exportFilename.value.trim();
            opts.askAtRunTime = document.getElementById('exportAskAtRunTime').checked;
            document.getElementById('exportDialogError').textContent = '';
            vscode.postMessage({ command: 'exportDialogResult', options: opts });
            return;
        }
        // Export what the grid shows: the last executed query, not unsaved text
        // in the query bar. Only the paging LIMIT the grid added is left out; a
        // LIMIT the user wrote is kept.
        const sql = exportQuerySql(lastRunRawSql, currentSql, userPaged);
        if (opts.format === 'excel') { opts.excelSqlStatement = sql; }
        vscode.postMessage({
            command: 'exportData',
            options: opts,
            sql,
            schema: schema,
            table: table,
            columns: columns
        });
        closeExportDialog();
    }

    function saveExportDefault() {
        const opts = gatherExportOptions();
        const saveLocation = exportSaveLocation.value.trim();
        vscode.postMessage({
            command: 'saveExportDefaults',
            format: opts.format,
            options: opts,
            saveLocation: saveLocation
        });
    }

    function getCellTextContent(td) {
        let text = '';
        td.childNodes.forEach(node => {
            if (node.nodeType === Node.TEXT_NODE) {
                text += node.textContent;
            } else if (node.nodeType === Node.ELEMENT_NODE && !node.classList.contains('fk-btn') && !node.classList.contains('exec-btn')) {
                text += node.textContent;
            }
        });
        return text.trim();
    }

    function getDefaultTableReference() {
        if (tableReference) {
            return tableReference;
        }
        if (!table) {
            return '';
        }

        const formattedTable = formatIdentifier(table);
        if (!schema) {
            return formattedTable;
        }

        return `${formatIdentifier(schema)}.${formattedTable}`;
    }

    // SQL WHERE body for the permanent constraints, or '' when none apply.
    function getDefaultWhere() {
        return buildConstraintWhere(permanentConstraints, formatIdentifier);
    }

    // SQL ORDER BY body for the permanent sorts, or '' when none apply.
    function getDefaultOrderBy() {
        return buildConstraintOrderBy(permanentSorts, formatIdentifier);
    }

    // The default table-view query including any permanent WHERE constraints
    // and ORDER BY entries. Lists all known columns explicitly instead of `*`
    // (falls back to `*` while column metadata is still loading). When the
    // "qualify columns with alias" option is on, every column and the FROM
    // reference carry a table alias.
    function getDefaultQuery() {
        const where = getDefaultWhere();
        const orderBy = getDefaultOrderBy();
        const alias = getDefaultTableAlias();
        const columnList = buildSelectColumnList(columns, formatIdentifier, alias);
        const fromReference = getDefaultTableReference() + (alias ? ` ${alias}` : '');
        return `SELECT ${columnList} FROM ${fromReference}`
            + (where ? ` WHERE ${where}` : '')
            + (orderBy ? ` ORDER BY ${orderBy}` : '');
    }

    // The table alias used to qualify the default query's columns, or '' when
    // the option is off. Prefers the alias persisted by the drag-to-editor alias
    // system, falling back to one derived from the first column name.
    function getDefaultTableAlias() {
        if (!qualifyColumnsWithAlias) {
            return '';
        }
        if (tableAlias) {
            return tableAlias;
        }
        const firstColumn = Array.isArray(columns) && columns[0] ? columns[0].name : null;
        return deriveTableAlias(firstColumn, table);
    }

    // NOTE: Keep in sync with formatIdentifier/needsQuoting in src/queryRunner.ts
    function formatIdentifier(identifier) {
        if (alwaysQuote || needsQuoting(identifier)) {
            return `"${String(identifier).replace(/"/g, '""')}"`;
        }
        return identifier;
    }

    function needsQuoting(identifier) {
        return !/^[a-z_][a-z0-9_$]*$/.test(identifier) || POSTGRES_RESERVED_KEYWORDS.has(String(identifier).toLowerCase());
    }

    // SQL reference of a result column. A column whose name occurs twice in the
    // result carries the alias it is selected through (`a.x`), and that has to
    // be written as `a."x"` — quoting it as one name would not resolve.
    function formatColumnReference(colName) {
        const source = (caps.columnSources || {})[colName];
        if (source && source.qualifier && source.sourceColumn) {
            return formatIdentifier(source.qualifier) + '.' + formatIdentifier(source.sourceColumn);
        }
        return formatIdentifier(colName);
    }

    // Text for an HTML element's content. A plain replace, not a DOM round trip:
    // the grid escapes every cell it renders.
    function escapeHtml(text) {
        if (text === null || text === undefined) return '';
        return String(text).replace(/[&<>]/g, ch => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;'));
    }

    function escapeAttr(text) {
        if (text === null || text === undefined) return '';
        return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ===== Custom Column Mapping Logic =====

    function evaluateMappingConditions(mapping, rowData) {
        if (!mapping.conditions || mapping.conditions.length === 0) return true;
        if (!rowData) return false;
        return mapping.conditions.every(cond => {
            const cellValue = rowData[cond.column];
            if (cellValue === null || cellValue === undefined) return false;
            const strVal = String(cellValue);
            switch (cond.operator) {
                case '=': return strVal === cond.value;
                case '!=': return strVal !== cond.value;
                case '>': return strVal > cond.value;
                case '<': return strVal < cond.value;
                case '>=': return strVal >= cond.value;
                case '<=': return strVal <= cond.value;
                case 'LIKE': return strVal.includes(cond.value);
                case 'ILIKE': return strVal.toLowerCase().includes(cond.value.toLowerCase());
                default: return strVal === cond.value;
            }
        });
    }

    // Mapping dialog DOM refs
    const mappingDialogOverlay = document.getElementById('mappingDialogOverlay');
    const mappingDialogTitle = document.getElementById('mappingDialogTitle');
    const mappingDialogClose = document.getElementById('mappingDialogClose');
    const mappingDialogSave = document.getElementById('mappingDialogSave');
    const mappingDialogDelete = document.getElementById('mappingDialogDelete');
    const mappingDialogCancel = document.getElementById('mappingDialogCancel');
    const mappingLabel = document.getElementById('mappingLabel');
    const mappingSourceSchema = document.getElementById('mappingSourceSchema');
    const mappingSourceTable = document.getElementById('mappingSourceTable');
    const mappingSourceColumn = document.getElementById('mappingSourceColumn');
    const mappingTargetSchema = document.getElementById('mappingTargetSchema');
    const mappingTargetTable = document.getElementById('mappingTargetTable');
    const mappingTargetColumn = document.getElementById('mappingTargetColumn');
    const mappingConditions = document.getElementById('mappingConditions');
    const mappingAddCondition = document.getElementById('mappingAddCondition');
    const mappingColumnPairs = document.getElementById('mappingColumnPairs');
    const mappingAddColumnPair = document.getElementById('mappingAddColumnPair');
    const mappingIsDefault = document.getElementById('mappingIsDefault');
    const mappingShareWorkspace = document.getElementById('mappingShareWorkspace');

    // Manage mappings dialog DOM refs
    const manageMappingsOverlay = document.getElementById('manageMappingsOverlay');
    const manageMappingsClose = document.getElementById('manageMappingsClose');
    const manageMappingsCloseBtn = document.getElementById('manageMappingsCloseBtn');
    const manageMappingsAdd = document.getElementById('manageMappingsAdd');
    const mappingsList = document.getElementById('mappingsList');
    const noMappingsMsg = document.getElementById('noMappingsMsg');

    let editingMappingId = null;
    let typeaheadTables = []; // [{schema, table}]
    let typeaheadColumns = []; // column names for currently selected target table

    function handleTablesForTypeahead(msg) {
        typeaheadTables = msg.tables || [];
        updateTableTypeahead();
    }

    function handleColumnsForTypeahead(msg) {
        typeaheadColumns = msg.columns || [];
        updateColumnTypeahead();
    }

    function requestTablesForTypeahead() {
        vscode.postMessage({ command: 'getTablesForTypeahead' });
    }

    function requestColumnsForTypeahead(targetSchema, targetTable) {
        if (!targetSchema || !targetTable) {
            typeaheadColumns = [];
            updateColumnTypeahead();
            return;
        }
        vscode.postMessage({ command: 'getColumnsForTypeahead', schema: targetSchema, table: targetTable });
    }

    function setupTypeahead(input, getSuggestions, onSelect) {
        const wrapper = input.closest('.typeahead-wrapper') || input.parentElement;
        let dropdown = wrapper.querySelector('.typeahead-dropdown');
        if (!dropdown) {
            dropdown = document.createElement('div');
            dropdown.className = 'typeahead-dropdown';
            wrapper.appendChild(dropdown);
        }

        function showSuggestions() {
            const val = input.value.toLowerCase().trim();
            const suggestions = getSuggestions(val);
            if (suggestions.length === 0 || (suggestions.length === 1 && suggestions[0].value.toLowerCase() === val)) {
                dropdown.style.display = 'none';
                return;
            }
            let html = '';
            suggestions.slice(0, 20).forEach(s => {
                html += `<div class="typeahead-item" data-value="${escapeAttr(s.value)}">${escapeHtml(s.label)}</div>`;
            });
            dropdown.innerHTML = html;
            dropdown.style.display = 'block';

            dropdown.querySelectorAll('.typeahead-item').forEach(item => {
                item.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    const value = item.getAttribute('data-value');
                    input.value = value;
                    dropdown.style.display = 'none';
                    suppressNext = true;
                    if (onSelect) onSelect(value);
                });
            });
        }

        let suppressNext = false;
        input.addEventListener('input', () => {
            if (suppressNext) { suppressNext = false; return; }
            showSuggestions();
        });
        input.addEventListener('focus', () => {
            if (suppressNext) { suppressNext = false; return; }
            showSuggestions();
        });
        input.addEventListener('blur', () => {
            setTimeout(() => { dropdown.style.display = 'none'; }, 150);
        });
    }

    function getUniqueSchemas() {
        const schemas = new Set(typeaheadTables.map(t => t.schema));
        return [...schemas].sort();
    }

    function updateTableTypeahead() {
        // Re-trigger suggestions if dialog is open
        if (mappingDialogOverlay.style.display === 'flex') {
            mappingTargetTable.dispatchEvent(new Event('focus'));
        }
    }

    function updateColumnTypeahead() {
        if (mappingDialogOverlay.style.display === 'flex') {
            mappingTargetColumn.dispatchEvent(new Event('focus'));
        }
    }

    mappingDialogClose.addEventListener('click', closeMappingDialog);
    mappingDialogCancel.addEventListener('click', closeMappingDialog);
    mappingDialogSave.addEventListener('click', saveMappingFromDialog);
    mappingDialogDelete.addEventListener('click', deleteCurrentMapping);
    mappingAddCondition.addEventListener('click', addConditionRow);
    mappingAddColumnPair.addEventListener('click', () => addColumnPairRow());

    manageMappingsClose.addEventListener('click', closeManageMappingsDialog);
    manageMappingsCloseBtn.addEventListener('click', closeManageMappingsDialog);
    manageMappingsAdd.addEventListener('click', () => {
        closeManageMappingsDialog();
        openMappingDialog(null);
    });

    // -------- Single Record View Dialog --------
    const recordDialogOverlay = document.getElementById('recordDialogOverlay');
    const recordDialogClose = document.getElementById('recordDialogClose');
    const recordDialogCloseBtn = document.getElementById('recordDialogCloseBtn');
    const recordDialogPrev = document.getElementById('recordDialogPrev');
    const recordDialogNext = document.getElementById('recordDialogNext');
    const recordDialogBody = document.getElementById('recordDialogBody');
    const recordDialogIndex = document.getElementById('recordDialogIndex');
    const recordDialogTitle = document.getElementById('recordDialogTitle');
    const recordDialogStatus = document.getElementById('recordDialogStatus');

    // Index into allRows for the record currently shown (-1 = closed)
    let recordDialogRowIdx = -1;

    // Per-column textarea heights the user has dragged-to-resize. Kept while the
    // dialog stays open so a re-render (e.g. on blur) does not reset them.
    let recordTextareaHeights = {};

    function openRecordDialog(rowIdx) {
        if (rowIdx == null || rowIdx < 0 || !allRows[rowIdx]) return;
        recordDialogRowIdx = rowIdx;
        recordTextareaHeights = {};
        renderRecordDialog();
        recordDialogOverlay.style.display = 'flex';
        // The body had no size while the dialog was hidden.
        updateRecordScrollTail();
    }

    function closeRecordDialog() {
        recordDialogOverlay.style.display = 'none';
        recordDialogRowIdx = -1;
        recordTextareaHeights = {};
        if (recordScrollTailObserver) recordScrollTailObserver.disconnect();
    }

    function getDisplayedRowIndices() {
        // Returns array of original row indices in current display order
        if (displayedOrder.length > 0) {
            return displayedOrder.slice();
        }
        return allRows.map((_, i) => i);
    }

    function navigateRecord(delta) {
        const order = getDisplayedRowIndices();
        const pos = order.indexOf(recordDialogRowIdx);
        if (pos < 0) return;
        const nextPos = pos + delta;
        if (nextPos < 0 || nextPos >= order.length) return;
        recordDialogRowIdx = order[nextPos];
        // Preserve the scroll position when paging through records so the
        // user stays at the same logical column instead of being yanked
        // back to the top each time.
        renderRecordDialog({ preserveScroll: true });
    }

    function renderRecordDialog(opts) {
        const preserveScroll = !!(opts && opts.preserveScroll);
        const savedScrollTop = preserveScroll ? recordDialogBody.scrollTop : 0;
        const idx = recordDialogRowIdx;
        if (idx < 0 || !allRows[idx]) { closeRecordDialog(); return; }

        const order = getDisplayedRowIndices();
        const pos = order.indexOf(idx);
        recordDialogIndex.textContent = (pos >= 0 ? (pos + 1) : '?') + ' / ' + order.length;
        recordDialogTitle.textContent = (schema && table) ? (schema + '.' + table) : '';
        recordDialogPrev.disabled = pos <= 0;
        recordDialogNext.disabled = pos < 0 || pos >= order.length - 1;

        const isDeleted = deletedRows.has(idx);
        const rowData = allRows[idx];

        // Remember any heights the user dragged before we replace the DOM.
        captureRecordTextareaHeights();

        recordDialogBody.innerHTML = buildRecordRowsHtml(idx, isDeleted, rowData);

        // Reapply user-resized heights so a re-render keeps the layout stable.
        applyRecordTextareaHeights();

        // Size the trailing space before restoring the scroll position, so a
        // position near the end is not clamped by a still-empty spacer.
        updateRecordScrollTail();
        observeRecordScrollTail();

        // Restore the scroll position captured at the start of this render.
        // We do this synchronously (innerHTML assignment is synchronous and
        // the body has a fixed height, so the scroll range is already valid).
        recordDialogBody.scrollTop = savedScrollTop;

        const parts = [];
        if (isDeleted) parts.push('row marked for deletion (read-only)');
        if (Array.from(modifiedCells.keys()).some(k => k.startsWith(idx + ':'))) {
            const count = Array.from(modifiedCells.keys()).filter(k => k.startsWith(idx + ':')).length;
            parts.push(count + ' field' + (count === 1 ? '' : 's') + ' modified');
        }
        recordDialogStatus.textContent = parts.join(' \u2014 ');

        wireRecordDialogListeners(idx);
    }

    // Build the per-field HTML for the record dialog body.
    function buildRecordRowsHtml(idx, isDeleted, rowData) {
        let html = '';

        columns.forEach(col => {
            const modKey = idx + ':' + col.name;
            const isModified = modifiedCells.has(modKey);
            const originalVal = rowData[col.name];
            const currentVal = isModified ? modifiedCells.get(modKey) : originalVal;
            const isNull = currentVal === null || currentVal === undefined;

            const isPk = primaryKeys.includes(col.name);
            const fk = foreignKeys.find(f => f.column === col.name);
            const defaultMapping = customMappings.find(m =>
                m.isDefault && m.sourceColumn === col.name && evaluateMappingConditions(m, rowData)
            );

            let labelBadges = '';
            if (isPk) labelBadges += '<span class="record-label-pk" title="Primary Key">PK</span>';
            if (fk) labelBadges += '<span class="record-label-fk" title="Foreign Key &rarr; ' + escapeAttr(fk.refSchema + '.' + fk.refTable + '.' + fk.refColumn) + '">FK</span>';

            const dataType = col.dataType || '';
            const filterType = getColumnFilterType(dataType);

            // Display value: numeric columns get thousand separator format
            let displayVal;
            if (isNull) {
                displayVal = '';
            } else if (filterType === 'numeric') {
                displayVal = formatNumberDisplay(currentVal, thousandSeparator);
            } else {
                displayVal = cellToString(currentVal);
            }

            const lineCount = isNull ? 1 : Math.min(15, Math.max(1, displayVal.split('\n').length));
            const charInfo = isNull ? '(NULL)' : (displayVal.length + ' chars');
            const budget = describeCharacterBudget(isNull ? '' : displayVal, col.fullType || col.dataType);
            const budgetHtml = budget
                ? '<span class="record-value-budget' + charBudgetStateClass(budget) + '">' + escapeHtml(budget.text) + '</span>'
                : '';

            const editableAttr = recordFieldReadonlyAttr(isDeleted, !isColumnEditable(col.name));
            const valueClass = 'record-value' + (isNull ? ' is-null' : '');
            const rowClass = 'record-row' + (isModified ? ' record-row-modified' : '');

            let actions = '';
            actions += '<button class="btn btn-sm btn-icon record-editor-btn"' +
                ' title="Open this value in an editor tab; saving there writes it back">' +
                icon('edit') + '</button>';
            if (defaultMapping && !isNull) {
                actions += '<button class="btn btn-sm record-fk-btn"' +
                    ' data-ref-schema="' + escapeAttr(defaultMapping.targetSchema) + '"' +
                    ' data-ref-table="' + escapeAttr(defaultMapping.targetTable) + '"' +
                    ' data-ref-column="' + escapeAttr(defaultMapping.targetColumn) + '"' +
                    ' data-value="' + escapeAttr(cellToString(currentVal)) + '"' +
                    ' title="' + escapeAttr(defaultMapping.label || (defaultMapping.targetSchema + '.' + defaultMapping.targetTable)) + '"' +
                    '>&#8599; Jump</button>';
            } else if (fk && !isNull) {
                actions += '<button class="btn btn-sm record-fk-btn"' +
                    ' data-ref-schema="' + escapeAttr(fk.refSchema) + '"' +
                    ' data-ref-table="' + escapeAttr(fk.refTable) + '"' +
                    ' data-ref-column="' + escapeAttr(fk.refColumn) + '"' +
                    ' data-value="' + escapeAttr(cellToString(currentVal)) + '"' +
                    ' title="Open ' + escapeAttr(fk.refSchema + '.' + fk.refTable) + '"' +
                    '>&#8599; Open</button>';
            }
            if (isModified) {
                actions += '<button class="btn btn-sm record-reset-btn" title="Reset to original">&#8634; Reset</button>';
            }

            html += '<div class="' + rowClass + '" data-col="' + escapeAttr(col.name) + '">' +
                '<div class="record-label">' + labelBadges + escapeHtml(col.name) +
                    '<span class="record-label-type">' + escapeHtml(dataType) + '</span>' +
                '</div>' +
                '<div class="record-value-wrapper">' +
                    '<textarea class="' + valueClass + '" rows="' + lineCount + '" ' + editableAttr +
                        ' placeholder="NULL">' + escapeHtml(displayVal) + '</textarea>' +
                    '<div class="record-value-meta">' +
                        '<span class="record-value-info">' + charInfo + (isModified ? ' &middot; modified' : '') + '</span>' +
                        budgetHtml +
                    '</div>' +
                '</div>' +
                '<div class="record-row-actions">' + actions + '</div>' +
            '</div>';
        });

        if (html) html += '<div class="record-scroll-tail" aria-hidden="true"></div>';
        return html;
    }

    // Size the spacer after the last field so the last field can be scrolled up
    // to the top of the dialog, however short it is.
    function updateRecordScrollTail() {
        const tail = recordDialogBody.querySelector('.record-scroll-tail');
        const rows = recordDialogBody.querySelectorAll('.record-row');
        if (!tail || rows.length === 0) return;
        const style = getComputedStyle(recordDialogBody);
        const height = recordScrollTailHeight(
            recordDialogBody.clientHeight,
            parseFloat(style.paddingTop),
            parseFloat(style.paddingBottom),
            rows[rows.length - 1].getBoundingClientRect().height
        );
        tail.style.height = height + 'px';
    }

    // The visible height changes with the window, the last field's height when
    // its textarea is resized or grows while typing.
    const recordScrollTailObserver = typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            if (recordDialogRowIdx >= 0) updateRecordScrollTail();
        })
        : null;

    function observeRecordScrollTail() {
        if (!recordScrollTailObserver) return;
        recordScrollTailObserver.disconnect();
        recordScrollTailObserver.observe(recordDialogBody);
        const rows = recordDialogBody.querySelectorAll('.record-row');
        if (rows.length > 0) recordScrollTailObserver.observe(rows[rows.length - 1]);
    }

    // Read the current textarea heights from the DOM into recordTextareaHeights,
    // keyed by column name, so a re-render can restore them.
    function captureRecordTextareaHeights() {
        recordDialogBody.querySelectorAll('.record-row').forEach(rowEl => {
            const colName = rowEl.getAttribute('data-col');
            const textarea = rowEl.querySelector('.record-value');
            if (textarea && textarea.style.height) {
                recordTextareaHeights[colName] = textarea.style.height;
            }
        });
    }

    // Reapply previously captured textarea heights after a re-render.
    function applyRecordTextareaHeights() {
        recordDialogBody.querySelectorAll('.record-row').forEach(rowEl => {
            const colName = rowEl.getAttribute('data-col');
            const saved = recordTextareaHeights[colName];
            const textarea = rowEl.querySelector('.record-value');
            if (textarea && saved) {
                textarea.style.height = saved;
            }
        });
    }

    // Wire textarea edit / reset / FK-jump listeners for the record dialog body.
    function wireRecordDialogListeners(idx) {
        recordDialogBody.querySelectorAll('.record-row').forEach(rowEl => {
            const colName = rowEl.getAttribute('data-col');
            const textarea = rowEl.querySelector('.record-value');
            if (!textarea) return;

            textarea.addEventListener('focus', () => {
                textarea.classList.remove('is-null');
            });

            textarea.addEventListener('input', () => {
                // Auto-grow as user types
                textarea.style.height = 'auto';
                textarea.style.height = Math.min(400, textarea.scrollHeight) + 'px';
                recordTextareaHeights[colName] = textarea.style.height;
                const colMeta = columns.find(c => c.name === colName);
                applyCharBudget(
                    rowEl.querySelector('.record-value-budget'),
                    colMeta ? describeCharacterBudget(textarea.value, colMeta.fullType || colMeta.dataType) : null
                );
            });

            // Persist a manual drag-resize so it survives the next re-render.
            textarea.addEventListener('mouseup', () => {
                if (textarea.style.height) recordTextareaHeights[colName] = textarea.style.height;
            });

            textarea.addEventListener('blur', () => {
                applyRecordEdit(idx, colName, textarea.value);
                // Re-render to refresh modified badges, reset buttons, displayed value
                renderRecordDialog({ preserveScroll: true });
                renderBody();
            });

            const resetBtn = rowEl.querySelector('.record-reset-btn');
            if (resetBtn) {
                resetBtn.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    modifiedCells.delete(idx + ':' + colName);
                    renderRecordDialog({ preserveScroll: true });
                    renderBody();
                    updateChangeIndicator();
                });
            }

            const fkBtn = rowEl.querySelector('.record-fk-btn');
            if (fkBtn) {
                fkBtn.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    vscode.postMessage({
                        command: 'openForeignKey',
                        refSchema: fkBtn.getAttribute('data-ref-schema'),
                        refTable: fkBtn.getAttribute('data-ref-table'),
                        refColumn: fkBtn.getAttribute('data-ref-column'),
                        value: fkBtn.getAttribute('data-value')
                    });
                });
            }

            const editorBtn = rowEl.querySelector('.record-editor-btn');
            if (editorBtn) {
                editorBtn.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    openCellInEditor(idx, colName);
                });
            }
        });
    }

    // Hand one cell value to the extension host, which opens it in an editor
    // tab. Saving that tab posts the value back as `cellEditorValue`.
    function openCellInEditor(rowIdx, colName) {
        if (rowIdx == null || rowIdx < 0 || !allRows[rowIdx]) return;
        const modKey = rowIdx + ':' + colName;
        const value = modifiedCells.has(modKey) ? modifiedCells.get(modKey) : allRows[rowIdx][colName];
        const colMeta = columns.find(c => c.name === colName);
        vscode.postMessage({
            command: 'openCellInEditor',
            rowIdx: rowIdx,
            column: colName,
            dataType: colMeta ? (colMeta.dataType || '') : '',
            value: cellToString(value),
            readOnly: !isColumnEditable(colName) || deletedRows.has(rowIdx),
            // Echoed back on save, so the value lands on the same record even
            // when the rows were reloaded in between.
            rowToken: { fingerprint: rowFingerprint(allRows[rowIdx]) }
        });
    }

    // A cell opened in an editor tab was saved: apply the text as a pending
    // change, exactly as if it had been typed into the cell.
    function handleCellEditorValue(msg) {
        const idx = resolveCellEditorRow(allRows, Number(msg.rowIdx), msg.rowToken);
        const state = cellEditorTargetState(
            idx >= 0,
            columns.some(c => c.name === msg.column),
            idx >= 0 && isColumnEditable(msg.column) && !deletedRows.has(idx)
        );
        if (state === 'stale') {
            vscode.postMessage({
                command: 'showError',
                text: 'The edited row is no longer part of the loaded result, or it was changed in the meantime. Open the cell again to edit it.'
            });
            return;
        }
        if (state === 'readonly') {
            vscode.postMessage({ command: 'showError', text: `Column "${msg.column}" cannot be edited here.` });
            return;
        }
        applyRecordEdit(idx, msg.column, msg.value);
        renderBody();
        if (recordDialogRowIdx === idx) {
            renderRecordDialog({ preserveScroll: true });
        }
    }

    // Mirrors handleCellEdit: writes to modifiedCells / clears it if equal to original
    function applyRecordEdit(rowIdx, colName, rawText) {
        if (!isColumnEditable(colName)) return;
        if (deletedRows.has(rowIdx)) return;
        const originalVal = allRows[rowIdx][colName];
        const colMeta = columns.find(c => c.name === colName);
        const isNumeric = !!colMeta && getColumnFilterType(colMeta.dataType) === 'numeric';
        const newValue = normalizeCellInput(rawText, isNumeric, thousandSeparator);

        // Empty -> NULL
        const finalValue = newValue === '' ? null : newValue;

        // Compare against original, accounting for stringification
        const originalStr = (originalVal === null || originalVal === undefined) ? null : cellToString(originalVal);
        const finalStr = finalValue === null ? null : String(finalValue);

        const modKey = rowIdx + ':' + colName;
        if (finalStr === originalStr) {
            modifiedCells.delete(modKey);
        } else {
            modifiedCells.set(modKey, finalValue);
        }
        updateChangeIndicator();
        recordEditHistory();
    }

    // Wire dialog buttons
    recordDialogClose.addEventListener('click', closeRecordDialog);
    recordDialogCloseBtn.addEventListener('click', closeRecordDialog);
    recordDialogPrev.addEventListener('click', () => navigateRecord(-1));
    recordDialogNext.addEventListener('click', () => navigateRecord(1));

    closeOnBackdropClick(recordDialogOverlay, closeRecordDialog);

    document.addEventListener('keydown', (e) => {
        if (recordDialogOverlay.style.display !== 'flex') return;
        // Don't hijack typing inside the textareas
        const inField = document.activeElement && document.activeElement.tagName === 'TEXTAREA';
        if (e.key === 'Escape') { e.preventDefault(); closeRecordDialog(); return; }
        if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); navigateRecord(-1); return; }
        if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); navigateRecord(1); return; }
        if (!inField && e.key === 'ArrowLeft') { e.preventDefault(); navigateRecord(-1); return; }
        if (!inField && e.key === 'ArrowRight') { e.preventDefault(); navigateRecord(1); return; }
    });

    window.openRecordDialog = openRecordDialog;

    // Setup typeahead on target schema field
    setupTypeahead(mappingTargetSchema, (val) => {
        const schemas = getUniqueSchemas();
        return schemas
            .filter(s => s.toLowerCase().includes(val))
            .map(s => ({ value: s, label: s }));
    }, (selectedSchema) => {
        // When schema changes, clear table and column
        mappingTargetTable.value = '';
        mappingTargetColumn.value = '';
        typeaheadColumns = [];
    });

    // Setup typeahead on target table field
    setupTypeahead(mappingTargetTable, (val) => {
        const selectedSchema = mappingTargetSchema.value.trim().toLowerCase();
        return typeaheadTables
            .filter(t => {
                const matchesSchema = !selectedSchema || t.schema.toLowerCase() === selectedSchema;
                const matchesTable = t.table.toLowerCase().includes(val);
                return matchesSchema && matchesTable;
            })
            .map(t => ({
                value: t.table,
                label: selectedSchema ? t.table : `${t.schema}.${t.table}`
            }));
    }, (selectedTable) => {
        // Auto-fill schema if not set
        if (!mappingTargetSchema.value.trim()) {
            const match = typeaheadTables.find(t => t.table === selectedTable);
            if (match) {
                mappingTargetSchema.value = match.schema;
            }
        }
        // Request columns for the selected table
        const targetSchema = mappingTargetSchema.value.trim();
        requestColumnsForTypeahead(targetSchema, selectedTable);
    });

    // Setup typeahead on target column field
    setupTypeahead(mappingTargetColumn, (val) => {
        return typeaheadColumns
            .filter(c => c.toLowerCase().includes(val))
            .map(c => ({ value: c, label: c }));
    }, null);

    // When table input loses focus, also request columns
    mappingTargetTable.addEventListener('change', () => {
        const targetSchema = mappingTargetSchema.value.trim() || schema;
        const targetTable = mappingTargetTable.value.trim();
        if (targetTable) {
            requestColumnsForTypeahead(targetSchema, targetTable);
        }
    });

    function openMappingDialog(preselectedColumn, existingMapping) {
        editingMappingId = existingMapping ? existingMapping.id : null;
        mappingDialogTitle.textContent = existingMapping ? 'Edit Custom Column Mapping' : 'Create Custom Column Mapping';
        mappingDialogDelete.style.display = existingMapping ? 'inline-block' : 'none';

        // Populate source fields
        mappingSourceSchema.value = schema;
        mappingSourceTable.value = table;

        // Populate source column dropdown
        let colHtml = '';
        columns.forEach(col => {
            const selected = (existingMapping && existingMapping.sourceColumn === col.name) ||
                             (!existingMapping && col.name === preselectedColumn);
            colHtml += `<option value="${escapeAttr(col.name)}"${selected ? ' selected' : ''}>${escapeHtml(col.name)}</option>`;
        });
        mappingSourceColumn.innerHTML = colHtml;

        // Populate target fields
        mappingTargetSchema.value = existingMapping ? existingMapping.targetSchema : schema;
        mappingTargetTable.value = existingMapping ? existingMapping.targetTable : '';
        mappingTargetColumn.value = existingMapping ? existingMapping.targetColumn : '';
        mappingLabel.value = existingMapping ? (existingMapping.label || '') : '';
        mappingIsDefault.checked = existingMapping ? existingMapping.isDefault : true;
        if (mappingShareWorkspace) {
            mappingShareWorkspace.checked = existingMapping ? (existingMapping.scope === 'workspace') : newMappingDefaultWorkspace;
        }

        // Populate conditions
        mappingConditions.innerHTML = '';
        if (existingMapping && existingMapping.conditions && existingMapping.conditions.length > 0) {
            existingMapping.conditions.forEach(cond => {
                addConditionRow(null, cond);
            });
        }

        // Populate additional column matches (composite key)
        mappingColumnPairs.innerHTML = '';
        if (existingMapping && Array.isArray(existingMapping.additionalColumnPairs)) {
            existingMapping.additionalColumnPairs.forEach(pair => {
                addColumnPairRow(pair);
            });
        }

        // Request tables for typeahead
        requestTablesForTypeahead();

        // If existing mapping has a target table, load its columns
        if (existingMapping && existingMapping.targetSchema && existingMapping.targetTable) {
            requestColumnsForTypeahead(existingMapping.targetSchema, existingMapping.targetTable);
        } else {
            typeaheadColumns = [];
        }

        mappingDialogOverlay.style.display = 'flex';
    }

    function closeMappingDialog() {
        mappingDialogOverlay.style.display = 'none';
        editingMappingId = null;
    }

    function addConditionRow(e, existing) {
        const row = document.createElement('div');
        row.className = 'mapping-condition-row';

        // Column selector from current table columns
        let colOpts = '';
        columns.forEach(col => {
            const selected = existing && existing.column === col.name;
            colOpts += `<option value="${escapeAttr(col.name)}"${selected ? ' selected' : ''}>${escapeHtml(col.name)}</option>`;
        });

        const operatorVal = existing ? existing.operator : '=';
        const valueVal = existing ? existing.value : '';

        row.innerHTML = `
            <select class="condition-column">${colOpts}</select>
            <select class="condition-operator">
                <option value="="${operatorVal === '=' ? ' selected' : ''}>=</option>
                <option value="!="${operatorVal === '!=' ? ' selected' : ''}>!=</option>
                <option value=">"${operatorVal === '>' ? ' selected' : ''}>&gt;</option>
                <option value="<"${operatorVal === '<' ? ' selected' : ''}>&lt;</option>
                <option value=">="${operatorVal === '>=' ? ' selected' : ''}>&gt;=</option>
                <option value="<="${operatorVal === '<=' ? ' selected' : ''}>&lt;=</option>
                <option value="LIKE"${operatorVal === 'LIKE' ? ' selected' : ''}>LIKE</option>
                <option value="ILIKE"${operatorVal === 'ILIKE' ? ' selected' : ''}>ILIKE</option>
            </select>
            <input type="text" class="condition-value" placeholder="value" value="${escapeAttr(valueVal)}" />
            <button class="btn-remove-condition" title="Remove condition">&times;</button>
        `;

        row.querySelector('.btn-remove-condition').addEventListener('click', () => {
            row.remove();
        });

        mappingConditions.appendChild(row);
    }

    // Add a source-column/target-column equality row (composite-key match).
    // Reuses the same constraint-row style as the Build JOIN dialog.
    function addColumnPairRow(existing) {
        const row = document.createElement('div');
        row.className = 'mapping-condition-row';

        let colOpts = '';
        columns.forEach(col => {
            const selected = existing && existing.sourceColumn === col.name;
            colOpts += `<option value="${escapeAttr(col.name)}"${selected ? ' selected' : ''}>${escapeHtml(col.name)}</option>`;
        });

        const targetVal = existing ? existing.targetColumn : '';
        row.innerHTML = `
            <select class="pair-source-column">${colOpts}</select>
            <span class="pair-eq">=</span>
            <span class="typeahead-wrapper"><input type="text" class="pair-target-column" placeholder="target column" autocomplete="off" value="${escapeAttr(targetVal)}" /></span>
            <button class="btn-remove-condition" title="Remove column match">&times;</button>
        `;

        row.querySelector('.btn-remove-condition').addEventListener('click', () => {
            row.remove();
        });

        // Typeahead on the target column, fed by the selected target table's columns.
        const targetInput = row.querySelector('.pair-target-column');
        setupTypeahead(targetInput, (val) => {
            return typeaheadColumns
                .filter(c => c.toLowerCase().includes(val))
                .map(c => ({ value: c, label: c }));
        }, null);

        mappingColumnPairs.appendChild(row);
    }

    function gatherMappingFromDialog() {
        const conditions = [];
        mappingConditions.querySelectorAll('.mapping-condition-row').forEach(row => {
            const col = row.querySelector('.condition-column').value;
            const op = row.querySelector('.condition-operator').value;
            const val = row.querySelector('.condition-value').value;
            if (col && val !== '') {
                conditions.push({ column: col, operator: op, value: val });
            }
        });

        const additionalColumnPairs = [];
        mappingColumnPairs.querySelectorAll('.mapping-condition-row').forEach(row => {
            const sourceColumn = row.querySelector('.pair-source-column').value;
            const targetColumn = row.querySelector('.pair-target-column').value.trim();
            if (sourceColumn && targetColumn) {
                additionalColumnPairs.push({ sourceColumn, targetColumn });
            }
        });

        const mapping = {
            sourceSchema: mappingSourceSchema.value.trim(),
            sourceTable: mappingSourceTable.value.trim(),
            sourceColumn: mappingSourceColumn.value,
            targetSchema: mappingTargetSchema.value.trim(),
            targetTable: mappingTargetTable.value.trim(),
            targetColumn: mappingTargetColumn.value.trim(),
            conditions: conditions,
            isDefault: mappingIsDefault.checked,
            label: mappingLabel.value.trim() || undefined
        };
        if (additionalColumnPairs.length > 0) {
            mapping.additionalColumnPairs = additionalColumnPairs;
        }
        return mapping;
    }

    function saveMappingFromDialog() {
        const data = gatherMappingFromDialog();
        if (!data.targetTable || !data.targetColumn) {
            // alert() is blocked inside VS Code webviews.
            vscode.postMessage({ command: 'showError', text: 'Target table and column are required.' });
            return;
        }
        if (!data.targetSchema) {
            data.targetSchema = 'public';
        }
        const scope = (mappingShareWorkspace && mappingShareWorkspace.checked) ? 'workspace' : 'global';
        if (editingMappingId) {
            data.scope = scope;
        }

        vscode.postMessage({
            command: editingMappingId ? 'updateCustomMapping' : 'addCustomMapping',
            mappingId: editingMappingId,
            scope: scope,
            mapping: data
        });
        closeMappingDialog();
    }

    function deleteCurrentMapping() {
        if (!editingMappingId) return;
        // The host asks for confirmation: confirm() is blocked in webviews.
        vscode.postMessage({
            command: 'deleteCustomMapping',
            mappingId: editingMappingId
        });
        closeMappingDialog();
    }

    function openManageMappingsDialog() {
        renderMappingsList();
        manageMappingsOverlay.style.display = 'flex';
    }

    function closeManageMappingsDialog() {
        manageMappingsOverlay.style.display = 'none';
    }

    function renderMappingsList() {
        if (customMappings.length === 0) {
            mappingsList.innerHTML = '';
            noMappingsMsg.style.display = 'block';
            return;
        }
        noMappingsMsg.style.display = 'none';

        let html = '';
        customMappings.forEach(mapping => {
            const label = mapping.label || `${mapping.sourceColumn} → ${mapping.targetSchema}.${mapping.targetTable}.${mapping.targetColumn}`;
            const detail = `${mapping.sourceColumn} → ${mapping.targetSchema}.${mapping.targetTable}.${mapping.targetColumn}`;
            let badges = '';
            if (mapping.reversed) {
                badges += '<span class="mapping-badge mapping-badge-reverse" title="Synthesized from a mapping defined on the target table">Reverse</span>';
            }
            if (mapping.scope === 'workspace') {
                badges += '<span class="mapping-badge mapping-badge-workspace" title="Shared via the workspace mappings file (committed to git)">Workspace</span>';
            } else if (mapping.scope === 'global') {
                badges += '<span class="mapping-badge mapping-badge-personal" title="Personal mapping, stored in VS Code global state only">Personal</span>';
            }
            if (mapping.isDefault) {
                badges += '<span class="mapping-badge">Default</span>';
            }
            if (mapping.conditions && mapping.conditions.length > 0) {
                badges += `<span class="mapping-badge">IF ${escapeHtml(formatMappingConditions(mapping.conditions))}</span>`;
            }
            if (Array.isArray(mapping.additionalColumnPairs) && mapping.additionalColumnPairs.length > 0) {
                const pairStr = mapping.additionalColumnPairs.map(p => `${p.sourceColumn} = ${p.targetColumn}`).join(' AND ');
                badges += `<span class="mapping-badge" title="Composite-key match: ${escapeAttr(pairStr)}">+${mapping.additionalColumnPairs.length} col</span>`;
            }
            const actions = mapping.reversed
                ? '<span class="mapping-item-note" title="Edit this mapping on the originating table">read-only</span>'
                : '<button class="btn btn-sm mapping-edit-btn">Edit</button>' +
                  '<button class="btn btn-danger btn-sm mapping-delete-btn">Delete</button>';
            html += `<div class="mapping-item${mapping.reversed ? ' mapping-item-reverse' : ''}" data-mapping-id="${escapeAttr(mapping.id)}">
                <div class="mapping-item-info">
                    <div class="mapping-item-label">${escapeHtml(label)}</div>
                    <div class="mapping-item-detail">${escapeHtml(detail)}</div>
                    ${badges ? '<div class="mapping-item-badges">' + badges + '</div>' : ''}
                </div>
                <div class="mapping-item-actions">
                    ${actions}
                </div>
            </div>`;
        });
        mappingsList.innerHTML = html;

        // Attach event listeners
        mappingsList.querySelectorAll('.mapping-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.closest('.mapping-item').getAttribute('data-mapping-id');
                const mapping = customMappings.find(m => m.id === id);
                if (mapping) {
                    closeManageMappingsDialog();
                    openMappingDialog(mapping.sourceColumn, mapping);
                }
            });
        });
        mappingsList.querySelectorAll('.mapping-delete-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.closest('.mapping-item').getAttribute('data-mapping-id');
                vscode.postMessage({ command: 'deleteCustomMapping', mappingId: id });
            });
        });
    }
})();
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        isNumericScalarType,
        duplicateCellValue,
        isStaleLoadAnswer,
        exportQuerySql,
        sanitizeThousandSeparator,
        toNumericLiteral,
        parseCellKey,
        formatMappingConditions,
        compareNumericText,
        cellToString,
        normalizeNumericInput,
        formatNumberDisplay,
        formatExactMatchValue,
        normalizeFilterInputValue,
        escapeSqlString,
        parseQueryPlaceholders,
        placeholderNames,
        renderParameterValue,
        applyQueryParameters,
        liveFormatNumeric,
        stripThousandSeparators,
        cellRangeToTsv,
        cellRangeToHtml,
        parseClipboardTable,
        planClipboardPaste,
        singleClipboardValue,
        shouldFillLoneValue,
        resolveMouseRelease,
        isSingleCellSelection,
        seriesKindForType,
        continueSeries,
        planFillExtension,
        planSeriesWrites,
        fillPreviewText,
        lineSelectionCorners,
        fullySelectedLines,
        isPrintableTypingKey,
        typingStartsCellEdit,
        isInCodeEditor,
        isTextEntryElement,
        hasTextInputSelection,
        shouldCopyCellRange,
        computeCellNavTarget,
        computeScrollAdjustment,
        cloneEditValue,
        serializeEditValue,
        editStatesEqual,
        applyHistoryEntry,
        stripTrailingLimitOffset,
        parseSqlForWhere,
        findTopLevelKeywordIndex,
        splitWhereByAnd,
        whereClauseTargetsColumn,
        mergeWhereClauses,
        parseSqlForOrder,
        hasSqlComment,
        collapseSqlWhitespace,
        splitTopLevelCommas,
        splitTopLevelClauses,
        formatSql,
        filterOperatorForMode,
        buildFilterClause,
        buildNullConstraintClause,
        buildErrorDialogState,
        mappingConditionToClause,
        CONSTRAINT_OPERATORS,
        constraintIsUnary,
        constraintIsBetween,
        formatConstraintOperand,
        formatConstraintCondition,
        buildConstraintWhere,
        CONSTRAINT_SORT_DIRECTIONS,
        formatConstraintSort,
        buildConstraintOrderBy,
        buildSelectColumnList,
        deriveTableAlias,
        parseTableRefAlias,
        unqualifiedTableName,
        findTopLevelOn,
        parseGroupEditQuery,
        buildGroupEditWhere,
        buildGroupEditSql,
        buildColumnHeaderTitle,
        formatColumnTypeLabel,
        nextSortState,
        computeResizedRowHeight,
        computeResizedColumnWidth,
        columnResizeEdgeStep,
        cssStringLiteral,
        buildColumnWidthCss,
        buildAutoColumnWidthCss,
        remainingRowCount,
        formatExecutionTime,
        reorderColumns,
        reorderSelectColumns,
        isFreshRowLoad,
        expectsRelationMetadata,
        recordFieldReadonlyAttr,
        isBackdropDismissClick,
        AUTO_REFRESH_PRESETS,
        formatAutoRefreshInterval,
        autoRefreshOptions,
        autoRefreshLoadPlan,
        autoRefreshPauseReason,
        editHistoryHasGridEdits,
        recordScrollTailHeight,
        cellEditorTargetState,
        rowFingerprint,
        resolveCellEditorRow,
        buildConnectionBadge,
        buildSessionBadge,
        canApplyQueryFilters,
        canManageTableMetadata,
        defaultInsertTableName,
        rowValueMatchesFilter,
        compareCellValues,
        normalizeCellInput,
        buildRowIdentity,
        emptyCapabilities,
        normalizeCapabilities,
        sourceInstanceKey,
        buildCommitTargets,
        describeRowCount,
        columnWriteMode,
        buildCommitWarnings,
        isSqlEdited,
        parsePgType,
        pgDateTimeKind,
        localizedDateToIso,
        validateCellValue,
        describeCharacterBudget,
        charBudgetStateClass,
        classifyColumnDefault,
        defaultResetColumns,
        defaultCellTitle,
        headerRelationTargets,
        isLiftableSelect,
        relatedJoinPayload,
        parseSelectChain,
        selectItemColumn,
        describePendingChanges,
        buildRenderPlan,
        virtualRowOffset,
        virtualRowAt,
        virtualWindow,
        EXECUTABLE_COLUMN_TYPES,
        executableColumnType,
        executableTypeOfColumn,
        executableColumnAlias,
        executableIcon,
        executableMarkKey,
        executableMark,
        maskSqlStructure,
        findSelectListRange,
        renameSelectColumn
    };
}
