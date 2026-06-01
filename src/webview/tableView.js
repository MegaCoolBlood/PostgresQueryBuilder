const DEFAULT_THOUSAND_SEPARATOR = ' ';

function escapeSqlString(value) {
    return String(value).replace(/'/g, "''");
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

function formatNumberDisplay(value, thousandSeparator = DEFAULT_THOUSAND_SEPARATOR) {
    if (value === null || value === undefined) return null;
    const num = Number(value);
    if (isNaN(num)) return String(value);
    // Split into integer and decimal parts
    const parts = String(value).split('.');
    const intPart = parts[0].replace(/^-/, '');
    const sign = num < 0 ? '-' : '';
    // Add thousand separator
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

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
(function() {
    const vscode = acquireVsCodeApi();

    // State
    let columns = [];
    let primaryKeys = [];
    let foreignKeys = []; // [{column, refSchema, refTable, refColumn}]
    let referencingTables = []; // [{fkSchema, fkTable, fkColumn, localColumn}]
    let customMappings = []; // [{id, sourceColumn, targetSchema, targetTable, targetColumn, conditions, isDefault, label}]
    let allRows = [];
    let displayedRows = [];
    let schema = '';
    let table = '';
    let tableReference = '';
    let alwaysQuote = false;
    let thousandSeparator = ' ';
    let totalCount = 0;
    let currentOffset = 0;
    const PAGE_SIZE = 50;
    // NOTE: Keep in sync with POSTGRES_RESERVED_KEYWORDS in src/queryRunner.ts
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

    // Change tracking
    let modifiedCells = new Map(); // "rowIndex:colName" -> newValue
    let deletedRows = new Set();   // rowIndex
    let insertedRows = [];          // [{col: val, ...}]
    let duplicatedRows = [];        // [{col: val, ...}]

    // Sort state
    let sortColumn = null;
    let sortDirection = 'asc';

    // Filter state
    let filters = {};
    let exactFilters = {}; // FK filters that use exact match
    let filterModes = {}; // 'contains' | 'between' per column

    // DOM refs
    const tableHead = document.getElementById('tableHead');
    const tableBody = document.getElementById('tableBody');
    const tableName = document.getElementById('tableName');
    const rowCount = document.getElementById('rowCount');
    const commitBtn = document.getElementById('commitBtn');
    const discardBtn = document.getElementById('discardBtn');
    const insertRowBtn = document.getElementById('insertRowBtn');
    const loadMoreBtn = document.getElementById('loadMoreBtn');
    const changeCount = document.getElementById('changeCount');
    const sqlDialogOverlay = document.getElementById('sqlDialogOverlay');
    const sqlDialogContent = document.getElementById('sqlDialogContent');
    const sqlDialogExecute = document.getElementById('sqlDialogExecute');
    const sqlDialogCancel = document.getElementById('sqlDialogCancel');
    const sqlDialogClose = document.getElementById('sqlDialogClose');
    const queryInput = document.getElementById('queryInput');
    const queryRunBtn = document.getElementById('queryRunBtn');
    const queryHistoryDropdown = document.getElementById('queryHistoryDropdown');
    const contextMenu = document.getElementById('contextMenu');
    const contextMenuItems = document.getElementById('contextMenuItems');
    const dataLoading = document.getElementById('dataLoading');
    const metaLoading = document.getElementById('metaLoading');

    // Show data loading, request initial data
    dataLoading.classList.remove('hidden');
    metaLoading.classList.remove('hidden');
    vscode.postMessage({ command: 'loadData', offset: 0, limit: PAGE_SIZE });

    // Event listeners
    commitBtn.addEventListener('click', commitChanges);
    discardBtn.addEventListener('click', discardChanges);
    insertRowBtn.addEventListener('click', insertRow);
    loadMoreBtn.addEventListener('click', loadMore);
    sqlDialogCancel.addEventListener('click', closeSqlDialog);
    sqlDialogClose.addEventListener('click', closeSqlDialog);
    sqlDialogExecute.addEventListener('click', executePendingChanges);
    queryRunBtn.addEventListener('click', runCustomQuery);
    queryInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { runCustomQuery(); }
    });
    queryHistoryDropdown.addEventListener('change', () => {
        const selected = queryHistoryDropdown.value;
        if (selected) {
            queryInput.value = selected;
            queryHistoryDropdown.value = '';
        }
    });

    // Close context menu on click outside
    document.addEventListener('click', () => {
        contextMenu.style.display = 'none';
    });

    // Listen for messages from extension
    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.command) {
            case 'init':
                handleInit(msg);
                break;
            case 'dataLoaded':
                handleDataLoaded(msg);
                break;
            case 'primaryKeysLoaded':
                handlePrimaryKeysLoaded(msg);
                break;
            case 'foreignKeysLoaded':
                handleForeignKeysLoaded(msg);
                break;
            case 'referencingTablesLoaded':
                handleReferencingTablesLoaded(msg);
                break;
            case 'customMappingsLoaded':
                handleCustomMappingsLoaded(msg);
                break;
            case 'tablesForTypeahead':
                handleTablesForTypeahead(msg);
                break;
            case 'columnsForTypeahead':
                handleColumnsForTypeahead(msg);
                break;

            case 'queryResult':
                handleQueryResult(msg);
                break;
            case 'queryHistoryUpdated':
                updateQueryHistoryDropdown(msg.history);
                break;
            case 'sqlPreview':
                showSqlDialog(msg.sql);
                break;
            case 'commitSuccess':
                handleCommitSuccess();
                break;
            case 'applyFilter':
                handleApplyFilter(msg);
                break;
            case 'exportDefaultsLoaded':
                applyExportDefaults(msg.defaults);
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
                showError(msg.text);
                break;
        }
    });

    function handleInit(msg) {
        schema = msg.schema;
        table = msg.table;
        tableReference = msg.tableReference || '';
        alwaysQuote = Boolean(msg.alwaysQuote);
        if (msg.thousandSeparator !== undefined) { thousandSeparator = msg.thousandSeparator; }
        tableName.textContent = `${schema}.${table}`;
        queryInput.value = `SELECT * FROM ${getDefaultTableReference()}`;
        // Request query history for this table
        vscode.postMessage({ command: 'getQueryHistory' });
    }

    function handleDataLoaded(msg) {
        if (currentOffset === 0) {
            allRows = msg.data;
        } else {
            allRows = allRows.concat(msg.data);
        }
        columns = msg.columns;
        if (msg.primaryKeys) { primaryKeys = msg.primaryKeys; }
        totalCount = msg.totalCount;
        schema = msg.schema;
        table = msg.table;
        tableReference = msg.tableReference || '';
        alwaysQuote = Boolean(msg.alwaysQuote);

        tableName.textContent = `${schema}.${table}`;
        queryInput.value = `SELECT * FROM ${getDefaultTableReference()}`;
        dataLoading.classList.add('hidden');
        updateRowCount();
        renderTable();
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

    function handleQueryResult(msg) {
        allRows = msg.rows;
        columns = msg.columns;
        totalCount = msg.rows.length;
        tableName.textContent = `${schema}.${table} (custom query)`;
        rowCount.textContent = `${msg.rows.length} rows returned`;
        loadMoreBtn.disabled = true;
        dataLoading.classList.add('hidden');
        renderTable();
    }

    function updateQueryHistoryDropdown(history) {
        let html = '<option value="">-- History --</option>';
        if (history && history.length > 0) {
            history.forEach(entry => {
                const display = entry.sql.length > 80 ? entry.sql.substring(0, 80) + '...' : entry.sql;
                html += `<option value="${escapeAttr(entry.sql)}">${escapeHtml(display)}</option>`;
            });
        }
        queryHistoryDropdown.innerHTML = html;
    }

    function runCustomQuery() {
        let sql = queryInput.value.trim();
        if (!sql) return;
        // Save to history
        vscode.postMessage({ command: 'saveQueryHistory', sql: sql });
        // Silently add LIMIT and OFFSET if not already present
        const sqlLower = sql.toLowerCase();
        if (!sqlLower.includes(' limit ')) {
            sql += ` LIMIT ${PAGE_SIZE} OFFSET 0`;
        }
        dataLoading.classList.remove('hidden');
        vscode.postMessage({ command: 'runCustomQuery', sql });
    }

    function handleApplyFilter(msg) {
        exactFilters[msg.column] = msg.value;
        filters[msg.column] = msg.value;
        applyFiltersToQuery();
    }

    function updateRowCount() {
        const showing = allRows.length + insertedRows.length + duplicatedRows.length;
        rowCount.textContent = `Showing ${showing} of ${totalCount} rows`;
        loadMoreBtn.disabled = allRows.length >= totalCount;
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
        const mode = filterModes[col] || 'equals';
        switch (mode) {
            case 'not_equals': return '!=';
            case 'gt': return '>';
            case 'gte': return '>=';
            case 'lt': return '<';
            case 'lte': return '<=';
            default: return '=';
        }
    }

    function renderTable() {
        renderHeader();
        renderBody();
        updateChangeIndicator();
    }

    function renderHeader() {
        let html = '<tr>';
        html += '<th class="actions-cell">Actions</th>';
        columns.forEach(col => {
            let cls = '';
            if (sortColumn === col.name) {
                cls = sortDirection === 'asc' ? 'sorted-asc' : 'sorted-desc';
            }
            html += `<th class="${cls}" data-col="${escapeAttr(col.name)}">${escapeHtml(col.name)}<br><small style="font-weight:normal;color:var(--vscode-descriptionForeground)">${escapeHtml(col.dataType)}</small></th>`;
        });
        html += '</tr>';

        // Filter row
        html += '<tr class="filter-row">';
        html += '<th></th>';
        columns.forEach(col => {
            const filterType = getColumnFilterType(col.dataType);
            const inputType = getInputTypeForColumn(col);
            const mode = filterModes[col.name] || (filterType === 'text' ? 'contains' : 'equals');
            const val = filters[col.name] || '';

            html += '<th><div class="filter-cell">';

            if (filterType === 'date' || filterType === 'numeric') {
                // Mode selector
                html += `<select class="filter-mode-select" data-col="${escapeAttr(col.name)}">`;
                html += `<option value="equals"${mode === 'equals' ? ' selected' : ''}>=</option>`;
                html += `<option value="not_equals"${mode === 'not_equals' ? ' selected' : ''}>!=</option>`;
                html += `<option value="gt"${mode === 'gt' ? ' selected' : ''}>&gt;</option>`;
                html += `<option value="gte"${mode === 'gte' ? ' selected' : ''}>&gt;=</option>`;
                html += `<option value="lt"${mode === 'lt' ? ' selected' : ''}>&lt;</option>`;
                html += `<option value="lte"${mode === 'lte' ? ' selected' : ''}>&lt;=</option>`;
                html += `<option value="between"${mode === 'between' ? ' selected' : ''}>Between</option>`;
                html += `</select>`;

                // Compute width style for numeric columns
                const numWidthStyle = (filterType === 'numeric') ? ` style="width:${getMaxFormattedWidth(col.name) + 2}ch"` : '';

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

        // Attach sort listeners
        tableHead.querySelectorAll('tr:first-child th[data-col]').forEach(th => {
            th.addEventListener('click', () => {
                const col = th.getAttribute('data-col');
                if (sortColumn === col) {
                    sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
                } else {
                    sortColumn = col;
                    sortDirection = 'asc';
                }
                renderTable();
            });
        });

        // Attach filter listeners
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

        // Attach filter mode change listeners
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

    function applyFiltersToQuery() {
        if (!schema || !table) return;

        const whereClauses = [];
        for (const [col, val] of Object.entries(filters)) {
            if (!val) continue;
            const fmtCol = formatIdentifier(col);
            const colMeta = columns.find(c => c.name === col);
            const filterType = colMeta ? getColumnFilterType(colMeta.dataType) : 'text';

            if (exactFilters[col]) {
                // Exact match for FK navigation — no cast
                const formatted = formatExactMatchValue(val, filterType, thousandSeparator);
                whereClauses.push(`${fmtCol} = ${formatted}`);
            } else if (typeof val === 'object' && val !== null && val.from !== undefined) {
                // Between mode
                const fromRaw = val.from ? normalizeFilterInputValue(val.from, filterType, thousandSeparator) : '';
                const toRaw = val.to ? normalizeFilterInputValue(val.to, filterType, thousandSeparator) : '';
                if (filterType === 'numeric') {
                    const fromNum = fromRaw !== '' ? Number(fromRaw) : null;
                    const toNum = toRaw !== '' ? Number(toRaw) : null;
                    const from = fromNum !== null && !isNaN(fromNum) ? String(fromNum) : '';
                    const to = toNum !== null && !isNaN(toNum) ? String(toNum) : '';
                    if (from && to) {
                        whereClauses.push(`${fmtCol} BETWEEN ${from} AND ${to}`);
                    } else if (from) {
                        whereClauses.push(`${fmtCol} >= ${from}`);
                    } else if (to) {
                        whereClauses.push(`${fmtCol} <= ${to}`);
                    }
                } else {
                    const from = escapeSqlString(fromRaw);
                    const to = escapeSqlString(toRaw);
                    if (from && to) {
                        whereClauses.push(`${fmtCol} BETWEEN '${from}' AND '${to}'`);
                    } else if (from) {
                        whereClauses.push(`${fmtCol} >= '${from}'`);
                    } else if (to) {
                        whereClauses.push(`${fmtCol} <= '${to}'`);
                    }
                }
            } else if (filterType === 'numeric') {
                // Numeric with operator — no cast
                const normalized = normalizeFilterInputValue(val, filterType, thousandSeparator);
                const numericValue = Number(normalized);
                if (isNaN(numericValue)) continue;
                const op = getFilterOperator(col);
                whereClauses.push(`${fmtCol} ${op} ${numericValue}`);
            } else if (filterType === 'date') {
                // Date/timestamp with operator — no cast
                const escaped = escapeSqlString(val);
                const op = getFilterOperator(col);
                whereClauses.push(`${fmtCol} ${op} '${escaped}'`);
            } else {
                // Text ILIKE — no cast needed for text types
                const escaped = escapeSqlString(val);
                whereClauses.push(`${fmtCol}::text ILIKE '%${escaped}%'`);
            }
        }

        let sql = `SELECT * FROM ${getDefaultTableReference()}`;
        if (whereClauses.length > 0) {
            sql += ` WHERE ${whereClauses.join(' AND ')}`;
        }
        queryInput.value = sql;
        runCustomQuery();
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

        // 1. Add as exact match
        if (cellValue !== null && cellValue !== undefined) {
            items.push({
                label: 'Add as Exact Match to Query',
                action: () => {
                    exactFilters[colName] = String(cellValue);
                    filters[colName] = String(cellValue);
                    applyFiltersToQuery();
                }
            });
        }

        // 2. Exclude from query
        if (cellValue !== null && cellValue !== undefined) {
            items.push({
                label: 'Exclude this Value from Query',
                action: () => {
                    if (!schema || !table) return;
                    const escaped = escapeSqlString(cellValue);
                    const currentSql = queryInput.value.trim();
                    const fmtCol = formatIdentifier(colName);
                    const colMeta = columns.find(c => c.name === colName);
                    const filterType = colMeta ? getColumnFilterType(colMeta.dataType) : 'text';
                    let excludeClause;
                    if (filterType === 'numeric') {
                        excludeClause = `${fmtCol} != ${escaped}`;
                    } else {
                        excludeClause = `${fmtCol} != '${escaped}'`;
                    }
                    let sql;
                    if (currentSql.toLowerCase().includes(' where ')) {
                        sql = currentSql + ` AND ${excludeClause}`;
                    } else {
                        sql = `SELECT * FROM ${getDefaultTableReference()} WHERE ${excludeClause}`;
                    }
                    queryInput.value = sql;
                    runCustomQuery();
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
                const label = mapping.label || `${mapping.targetSchema}.${mapping.targetTable}.${mapping.targetColumn}`;
                items.push({
                    label: `Jump to ${label}`,
                    action: () => {
                        vscode.postMessage({
                            command: 'openForeignKey',
                            refSchema: mapping.targetSchema,
                            refTable: mapping.targetTable,
                            refColumn: mapping.targetColumn,
                            value: String(cellValue)
                        });
                    }
                });
            });
        }

        // 6. Create/Manage custom mapping
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

        if (items.length === 0) return;

        // Render menu
        let html = '';
        items.forEach((item, i) => {
            if (item.separator) {
                html += '<li class="separator"></li>';
            } else {
                html += `<li data-action-idx="${i}">${escapeHtml(item.label)}</li>`;
            }
        });
        contextMenuItems.innerHTML = html;

        // Position
        contextMenu.style.left = e.clientX + 'px';
        contextMenu.style.top = e.clientY + 'px';
        contextMenu.style.display = 'block';

        // Attach click handlers
        contextMenuItems.querySelectorAll('li[data-action-idx]').forEach(li => {
            li.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const idx = parseInt(li.getAttribute('data-action-idx'));
                contextMenu.style.display = 'none';
                if (items[idx] && items[idx].action) {
                    items[idx].action();
                }
            });
        });
    }

    function getFilteredAndSortedRows() {
        let rows = allRows.map((row, idx) => ({ ...row, _originalIndex: idx }));

        // Apply filters
        for (const [col, filterVal] of Object.entries(filters)) {
            if (!filterVal) continue;
            const colMeta = columns.find(c => c.name === col);
            const filterType = colMeta ? getColumnFilterType(colMeta.dataType) : 'text';

            if (typeof filterVal === 'object' && filterVal !== null && filterVal.from !== undefined) {
                // Between mode — filter locally by range
                const from = filterVal.from;
                const to = filterVal.to;
                if (!from && !to) continue;
                if (filterType === 'numeric') {
                    const fromNum = from ? Number(normalizeFilterInputValue(from, 'numeric', thousandSeparator)) : null;
                    const toNum = to ? Number(normalizeFilterInputValue(to, 'numeric', thousandSeparator)) : null;
                    if ((fromNum !== null && isNaN(fromNum)) || (toNum !== null && isNaN(toNum))) {
                        continue;
                    }
                    rows = rows.filter(row => {
                        const cellVal = Number(row[col]);
                        if (isNaN(cellVal)) return false;
                        if (fromNum !== null && toNum !== null) return cellVal >= fromNum && cellVal <= toNum;
                        if (fromNum !== null) return cellVal >= fromNum;
                        return cellVal <= toNum;
                    });
                } else {
                    rows = rows.filter(row => {
                        const cellVal = row[col];
                        if (cellVal === null || cellVal === undefined) return false;
                        const val = String(cellVal);
                        if (from && to) return val >= from && val <= to;
                        if (from) return val >= from;
                        return val <= to;
                    });
                }
            } else {
                const mode = filterModes[col];

                if ((filterType === 'numeric' || filterType === 'date') && mode && mode !== 'equals') {
                    // Comparison operator mode
                    rows = rows.filter(row => {
                        const cellVal = row[col];
                        if (cellVal === null || cellVal === undefined) return false;
                        const a = filterType === 'numeric' ? Number(cellVal) : String(cellVal);
                        const normalizedFilterVal = normalizeFilterInputValue(filterVal, filterType, thousandSeparator);
                        const b = filterType === 'numeric' ? Number(normalizedFilterVal) : String(normalizedFilterVal);
                        switch (mode) {
                            case 'not_equals': return a !== b;
                            case 'gt': return a > b;
                            case 'gte': return a >= b;
                            case 'lt': return a < b;
                            case 'lte': return a <= b;
                            default: return a === b;
                        }
                    });
                } else {
                    const lowerFilter = String(filterVal).toLowerCase();
                    rows = rows.filter(row => {
                        const cellVal = row[col];
                        if (cellVal === null || cellVal === undefined) return false;
                        return String(cellVal).toLowerCase().includes(lowerFilter);
                    });
                }
            }
        }

        // Apply sort
        if (sortColumn) {
            rows.sort((a, b) => {
                let valA = a[sortColumn];
                let valB = b[sortColumn];
                if (valA === null) return 1;
                if (valB === null) return -1;

                if (typeof valA === 'number' && typeof valB === 'number') {
                    return sortDirection === 'asc' ? valA - valB : valB - valA;
                }
                valA = String(valA);
                valB = String(valB);
                const cmp = valA.localeCompare(valB);
                return sortDirection === 'asc' ? cmp : -cmp;
            });
        }

        return rows;
    }

    function renderBody() {
        displayedRows = getFilteredAndSortedRows();
        let html = '';

        // Existing rows
        displayedRows.forEach(row => {
            const idx = row._originalIndex;
            const isDeleted = deletedRows.has(idx);
            const isModified = hasModifications(idx);
            let rowClass = '';
            if (isDeleted) rowClass = 'row-deleted';
            else if (isModified) rowClass = 'row-modified';

            html += `<tr class="${rowClass}" data-row-index="${idx}">`;
            html += `<td class="actions-cell">`;
            if (!isDeleted) {
                html += `<button class="btn btn-duplicate" onclick="duplicateRow(${idx})">⧉</button>`;
                html += `<button class="btn btn-danger" onclick="deleteRow(${idx})">✕</button>`;
            } else {
                html += `<button class="btn btn-default" onclick="undeleteRow(${idx})" style="padding:2px 6px;font-size:11px">↩</button>`;
            }
            html += `</td>`;

            columns.forEach(col => {
                const originalVal = allRows[idx][col.name];
                const modKey = `${idx}:${col.name}`;
                const currentVal = modifiedCells.has(modKey) ? modifiedCells.get(modKey) : originalVal;
                const isModifiedCell = modifiedCells.has(modKey);
                const cellClass = isModifiedCell ? 'cell-modified' : '';
                const displayVal = currentVal === null ? '<span class="null-value">NULL</span>' : (
                    getColumnFilterType(col.dataType) === 'numeric'
                        ? escapeHtml(formatNumberDisplay(currentVal, thousandSeparator))
                        : escapeHtml(String(currentVal))
                );

                const fk = foreignKeys.find(f => f.column === col.name);
                const defaultCustomMapping = customMappings.find(m => m.isDefault && m.sourceColumn === col.name && evaluateMappingConditions(m, allRows[idx]));
                let fkBtn = '';
                if (defaultCustomMapping && currentVal !== null && currentVal !== undefined) {
                    // Custom mapping overrides or supplements FK button
                    fkBtn = `<button contenteditable="false" class="fk-btn custom-fk-btn" data-ref-schema="${escapeAttr(defaultCustomMapping.targetSchema)}" data-ref-table="${escapeAttr(defaultCustomMapping.targetTable)}" data-ref-column="${escapeAttr(defaultCustomMapping.targetColumn)}" data-value="${escapeAttr(String(currentVal))}" title="${escapeAttr(defaultCustomMapping.label || defaultCustomMapping.targetSchema + '.' + defaultCustomMapping.targetTable)}">&#8599;</button>`;
                } else if (fk && currentVal !== null && currentVal !== undefined) {
                    fkBtn = `<button contenteditable="false" class="fk-btn" data-ref-schema="${escapeAttr(fk.refSchema)}" data-ref-table="${escapeAttr(fk.refTable)}" data-ref-column="${escapeAttr(fk.refColumn)}" data-value="${escapeAttr(String(currentVal))}" title="Open ${fk.refSchema}.${fk.refTable}">&#8599;</button>`;
                }

                html += `<td class="${cellClass}" contenteditable="${!isDeleted}" data-row="${idx}" data-col="${escapeAttr(col.name)}" data-original="${escapeAttr(originalVal === null ? '__NULL__' : String(originalVal))}">${displayVal}${fkBtn}</td>`;
            });
            html += '</tr>';
        });

        // Inserted rows
        insertedRows.forEach((row, iIdx) => {
            html += `<tr class="row-inserted" data-insert-index="${iIdx}">`;
            html += `<td class="actions-cell"><button class="btn btn-danger" onclick="removeInsertedRow(${iIdx})">✕</button></td>`;
            columns.forEach(col => {
                const val = row[col.name] || '';
                html += `<td contenteditable="true" data-insert="${iIdx}" data-col="${escapeAttr(col.name)}">${escapeHtml(val)}</td>`;
            });
            html += '</tr>';
        });

        // Duplicated rows
        duplicatedRows.forEach((row, dIdx) => {
            html += `<tr class="row-duplicated" data-dup-index="${dIdx}">`;
            html += `<td class="actions-cell"><button class="btn btn-danger" onclick="removeDuplicatedRow(${dIdx})">✕</button></td>`;
            columns.forEach(col => {
                const val = row[col.name] !== null ? String(row[col.name]) : '';
                html += `<td contenteditable="true" data-dup="${dIdx}" data-col="${escapeAttr(col.name)}">${escapeHtml(val)}</td>`;
            });
            html += '</tr>';
        });

        tableBody.innerHTML = html;

        // Live formatting for numeric cells during editing
        function handleNumericCellInput(td) {
            const colName = td.getAttribute('data-col');
            const colMeta = columns.find(c => c.name === colName);
            if (!colMeta || getColumnFilterType(colMeta.dataType) !== 'numeric') return;

            const text = getCellTextContent(td);

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

            // Update cell content
            const fkBtn = td.querySelector('.fk-btn');
            td.textContent = result.formatted;
            if (fkBtn) { td.appendChild(fkBtn); }

            // Restore cursor position
            if (sel && td.firstChild) {
                const newRange = document.createRange();
                newRange.setStart(td.firstChild, Math.min(result.newCursor, result.formatted.length));
                newRange.collapse(true);
                sel.removeAllRanges();
                sel.addRange(newRange);
            }
        }

        // Attach blur listeners for editable cells (existing rows)
        tableBody.querySelectorAll('td[data-row][contenteditable="true"]').forEach(td => {
            td.addEventListener('blur', handleCellEdit);
            td.addEventListener('input', () => handleNumericCellInput(td));
        });

        // Attach blur listeners for inserted rows
        tableBody.querySelectorAll('td[data-insert][contenteditable="true"]').forEach(td => {
            td.addEventListener('blur', handleInsertCellEdit);
            td.addEventListener('input', () => handleNumericCellInput(td));
        });

        // Attach blur listeners for duplicated rows
        tableBody.querySelectorAll('td[data-dup][contenteditable="true"]').forEach(td => {
            td.addEventListener('blur', handleDupCellEdit);
            td.addEventListener('input', () => handleNumericCellInput(td));
        });

        // Attach FK button listeners
        tableBody.querySelectorAll('.fk-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const refSchema = btn.getAttribute('data-ref-schema');
                const refTable = btn.getAttribute('data-ref-table');
                const refColumn = btn.getAttribute('data-ref-column');
                const value = btn.getAttribute('data-value');
                vscode.postMessage({
                    command: 'openForeignKey',
                    refSchema, refTable, refColumn, value
                });
            });
        });

        // Attach context menu to data cells
        tableBody.querySelectorAll('td[data-col]').forEach(td => {
            td.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                showCellContextMenu(e, td);
            });
        });

        updateChangeIndicator();
    }

    function handleCellEdit(e) {
        const td = e.target;
        const rowIdx = parseInt(td.getAttribute('data-row'));
        const colName = td.getAttribute('data-col');
        const originalStr = td.getAttribute('data-original');
        const original = originalStr === '__NULL__' ? null : originalStr;
        // Read only text nodes, excluding FK button content
        let newValue = getCellTextContent(td);

        // Strip thousand separators and normalize decimal comma for numeric columns
        const colMeta = columns.find(c => c.name === colName);
        if (colMeta && getColumnFilterType(colMeta.dataType) === 'numeric' && newValue !== '' && newValue !== null) {
            newValue = normalizeNumericInput(newValue, thousandSeparator);
        }

        if (newValue === '' && original === null) {
            newValue = null;
        }

        const modKey = `${rowIdx}:${colName}`;

        if (newValue === original || (newValue === '' && original === null)) {
            modifiedCells.delete(modKey);
            td.classList.remove('cell-modified');
        } else {
            modifiedCells.set(modKey, newValue === '' ? null : newValue);
            td.classList.add('cell-modified');
        }

        // Re-format display for numeric columns
        if (colMeta && getColumnFilterType(colMeta.dataType) === 'numeric') {
            const displayValue = modifiedCells.has(modKey) ? modifiedCells.get(modKey) : (original === null ? null : original);
            if (displayValue !== null) {
                // Preserve FK button if present
                const fkBtn = td.querySelector('.fk-btn');
                td.textContent = formatNumberDisplay(displayValue, thousandSeparator);
                if (fkBtn) { td.appendChild(fkBtn); }
            }
        }

        updateChangeIndicator();
    }

    function handleInsertCellEdit(e) {
        const td = e.target;
        const iIdx = parseInt(td.getAttribute('data-insert'));
        const colName = td.getAttribute('data-col');
        let newValue = td.textContent.trim() || '';
        const colMeta = columns.find(c => c.name === colName);
        if (colMeta && getColumnFilterType(colMeta.dataType) === 'numeric' && newValue !== '') {
            newValue = normalizeNumericInput(newValue, thousandSeparator);
        }
        insertedRows[iIdx][colName] = newValue;
        updateChangeIndicator();
    }

    function handleDupCellEdit(e) {
        const td = e.target;
        const dIdx = parseInt(td.getAttribute('data-dup'));
        const colName = td.getAttribute('data-col');
        let newValue = td.textContent.trim() || '';
        const colMeta = columns.find(c => c.name === colName);
        if (colMeta && getColumnFilterType(colMeta.dataType) === 'numeric' && newValue !== '') {
            newValue = normalizeNumericInput(newValue, thousandSeparator);
        }
        duplicatedRows[dIdx][colName] = newValue;
        updateChangeIndicator();
    }

    function hasModifications(rowIdx) {
        for (const key of modifiedCells.keys()) {
            if (key.startsWith(`${rowIdx}:`)) return true;
        }
        return false;
    }

    // Global functions for inline handlers
    window.deleteRow = function(idx) {
        deletedRows.add(idx);
        renderBody();
    };

    window.undeleteRow = function(idx) {
        deletedRows.delete(idx);
        renderBody();
    };

    window.duplicateRow = function(idx) {
        const rowData = {};
        columns.forEach(col => {
            const modKey = `${idx}:${col.name}`;
            rowData[col.name] = modifiedCells.has(modKey) ? modifiedCells.get(modKey) : allRows[idx][col.name];
        });
        duplicatedRows.push(rowData);
        renderBody();
        updateRowCount();
    };

    window.removeInsertedRow = function(idx) {
        insertedRows.splice(idx, 1);
        renderBody();
        updateRowCount();
    };

    window.removeDuplicatedRow = function(idx) {
        duplicatedRows.splice(idx, 1);
        renderBody();
        updateRowCount();
    };

    function insertRow() {
        const newRow = {};
        columns.forEach(col => { newRow[col.name] = ''; });
        insertedRows.push(newRow);
        renderBody();
        updateRowCount();

        // Scroll to bottom
        const wrapper = document.getElementById('tableWrapper');
        wrapper.scrollTop = wrapper.scrollHeight;
    }

    function loadMore() {
        currentOffset += PAGE_SIZE;
        vscode.postMessage({ command: 'loadData', offset: currentOffset, limit: PAGE_SIZE });
    }

    function updateChangeIndicator() {
        const totalChanges = modifiedCells.size + deletedRows.size + insertedRows.length + duplicatedRows.length;
        if (totalChanges === 0) {
            changeCount.textContent = 'No pending changes';
            commitBtn.disabled = true;
            discardBtn.disabled = true;
        } else {
            const parts = [];
            if (modifiedCells.size > 0) parts.push(`${modifiedCells.size} modified`);
            if (insertedRows.length > 0) parts.push(`${insertedRows.length} inserted`);
            if (duplicatedRows.length > 0) parts.push(`${duplicatedRows.length} duplicated`);
            if (deletedRows.size > 0) parts.push(`${deletedRows.size} deleted`);
            changeCount.textContent = `Pending: ${parts.join(', ')}`;
            commitBtn.disabled = false;
            discardBtn.disabled = false;
        }
    }

    let pendingChanges = null;

    function commitChanges() {
        const totalChanges = modifiedCells.size + deletedRows.size + insertedRows.length + duplicatedRows.length;
        if (totalChanges === 0) return;

        // Build change set
        const changes = {
            updates: [],
            inserts: [],
            deletes: []
        };

        // Build updates grouped by row
        const rowUpdates = new Map();
        for (const [key, value] of modifiedCells.entries()) {
            const [rowIdxStr, colName] = key.split(':');
            const rowIdx = parseInt(rowIdxStr);
            if (deletedRows.has(rowIdx)) continue; // Skip if row is also deleted

            if (!rowUpdates.has(rowIdx)) {
                rowUpdates.set(rowIdx, {});
            }
            rowUpdates.get(rowIdx)[colName] = value;
        }

        for (const [rowIdx, changedCols] of rowUpdates.entries()) {
            const pk = {};
            primaryKeys.forEach(pkCol => {
                pk[pkCol] = allRows[rowIdx][pkCol];
            });
            changes.updates.push({ primaryKey: pk, changes: changedCols });
        }

        // Inserts (both new and duplicated)
        changes.inserts = [...insertedRows, ...duplicatedRows].map(row => {
            const clean = {};
            columns.forEach(col => {
                if (row[col.name] !== '' && row[col.name] !== null && row[col.name] !== undefined) {
                    clean[col.name] = row[col.name];
                }
            });
            return clean;
        });

        // Deletes
        for (const rowIdx of deletedRows) {
            const pk = {};
            primaryKeys.forEach(pkCol => {
                pk[pkCol] = allRows[rowIdx][pkCol];
            });
            changes.deletes.push(pk);
        }

        pendingChanges = changes;
        vscode.postMessage({ command: 'previewSQL', changes });
    }

    function showSqlDialog(sql) {
        sqlDialogContent.textContent = sql;
        sqlDialogOverlay.style.display = 'flex';
    }

    function closeSqlDialog() {
        sqlDialogOverlay.style.display = 'none';
        pendingChanges = null;
    }

    function executePendingChanges() {
        if (pendingChanges) {
            vscode.postMessage({ command: 'commitChanges', changes: pendingChanges });
            sqlDialogOverlay.style.display = 'none';
            pendingChanges = null;
        }
    }

    function handleCommitSuccess() {
        // Reset state and reload
        modifiedCells.clear();
        deletedRows.clear();
        insertedRows = [];
        duplicatedRows = [];
        currentOffset = 0;
        vscode.postMessage({ command: 'loadData', offset: 0, limit: PAGE_SIZE });
    }

    function discardChanges() {
        modifiedCells.clear();
        deletedRows.clear();
        insertedRows = [];
        duplicatedRows = [];
        currentOffset = 0;
        vscode.postMessage({ command: 'loadData', offset: 0, limit: PAGE_SIZE });
        updateChangeIndicator();
    }

    function showError(text) {
        changeCount.textContent = `Error: ${text}`;
        changeCount.style.color = 'var(--vscode-errorForeground)';
        setTimeout(() => {
            changeCount.style.color = '';
            updateChangeIndicator();
        }, 5000);
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
        // Request defaults from extension
        vscode.postMessage({ command: 'getExportDefaults' });
        // Set default filename based on table
        exportFilename.value = table || 'export';
        // Set insert table name default
        const insertTableName = document.getElementById('insertTableName');
        if (insertTableName) {
            insertTableName.value = getDefaultTableReference();
        }
        onExportFormatChange();
        exportDialogOverlay.style.display = 'flex';
    }

    function closeExportDialog() {
        exportDialogOverlay.style.display = 'none';
    }

    function onExportFormatChange() {
        const fmt = exportFormat.value;
        Object.keys(exportOptGroups).forEach(key => {
            exportOptGroups[key].style.display = key === fmt ? 'block' : 'none';
        });
        // Update filename extension hint
        const extensions = { csv: '.csv', json: '.json', xml: '.xml', insert: '.sql', excel: '.xlsx' };
        const base = exportFilename.value.replace(/\.(csv|json|xml|sql|xlsx)$/, '');
        exportFilename.value = base;
        exportFilename.placeholder = `filename (${extensions[fmt]})`;
    }

    function applyExportDefaults(defaults) {
        exportDefaults = defaults || {};
        // Apply save location if stored
        if (exportDefaults._saveLocation) {
            exportSaveLocation.value = exportDefaults._saveLocation;
        }
        const fmt = exportFormat.value;
        const defs = exportDefaults[fmt];
        if (!defs) return;

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
            opts.insertTableName = document.getElementById('insertTableName').value || getDefaultTableReference();
            opts.insertBatchSize = parseInt(document.getElementById('insertBatchSize').value) || 1;
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
        // Send the current SQL query so backend can fetch ALL rows (not limited to page)
        const currentSql = queryInput.value.trim();
        vscode.postMessage({
            command: 'exportData',
            options: opts,
            sql: currentSql,
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

    // Utility
    function getCellTextContent(td) {
        let text = '';
        td.childNodes.forEach(node => {
            if (node.nodeType === Node.TEXT_NODE) {
                text += node.textContent;
            } else if (node.nodeType === Node.ELEMENT_NODE && !node.classList.contains('fk-btn')) {
                text += node.textContent;
            }
        });
        return text.trim();
    }

    function getDefaultTableReference() {
        if (tableReference) {
            return tableReference;
        }

        const formattedTable = formatIdentifier(table);
        if (!schema) {
            return formattedTable;
        }

        return `${formatIdentifier(schema)}.${formattedTable}`;
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

    function escapeHtml(text) {
        if (text === null || text === undefined) return '';
        const div = document.createElement('div');
        div.textContent = String(text);
        return div.innerHTML;
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
    const mappingIsDefault = document.getElementById('mappingIsDefault');

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

    // Event listeners for mapping dialog
    mappingDialogClose.addEventListener('click', closeMappingDialog);
    mappingDialogCancel.addEventListener('click', closeMappingDialog);
    mappingDialogSave.addEventListener('click', saveMappingFromDialog);
    mappingDialogDelete.addEventListener('click', deleteCurrentMapping);
    mappingAddCondition.addEventListener('click', addConditionRow);

    // Event listeners for manage mappings dialog
    manageMappingsClose.addEventListener('click', closeManageMappingsDialog);
    manageMappingsCloseBtn.addEventListener('click', closeManageMappingsDialog);
    manageMappingsAdd.addEventListener('click', () => {
        closeManageMappingsDialog();
        openMappingDialog(null);
    });

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
        mappingIsDefault.checked = existingMapping ? existingMapping.isDefault : false;

        // Populate conditions
        mappingConditions.innerHTML = '';
        if (existingMapping && existingMapping.conditions && existingMapping.conditions.length > 0) {
            existingMapping.conditions.forEach(cond => {
                addConditionRow(null, cond);
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

        return {
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
    }

    function saveMappingFromDialog() {
        const data = gatherMappingFromDialog();
        if (!data.targetTable || !data.targetColumn) {
            alert('Target table and column are required.');
            return;
        }
        if (!data.targetSchema) {
            data.targetSchema = 'public';
        }

        vscode.postMessage({
            command: editingMappingId ? 'updateCustomMapping' : 'addCustomMapping',
            mappingId: editingMappingId,
            mapping: data
        });
        closeMappingDialog();
    }

    function deleteCurrentMapping() {
        if (!editingMappingId) return;
        if (!confirm('Delete this custom mapping?')) return;
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
            if (mapping.isDefault) {
                badges += '<span class="mapping-badge">Default</span>';
            }
            if (mapping.conditions && mapping.conditions.length > 0) {
                const condStr = mapping.conditions.map(c => `${c.column} ${c.operator} '${c.value}'`).join(', ');
                badges += `<span class="mapping-badge">IF ${condStr}</span>`;
            }
            html += `<div class="mapping-item" data-mapping-id="${escapeAttr(mapping.id)}">
                <div class="mapping-item-info">
                    <div class="mapping-item-label">${escapeHtml(label)}</div>
                    <div class="mapping-item-detail">${escapeHtml(detail)}</div>
                    ${badges ? '<div class="mapping-item-badges">' + badges + '</div>' : ''}
                </div>
                <div class="mapping-item-actions">
                    <button class="btn btn-default btn-sm mapping-edit-btn">Edit</button>
                    <button class="btn btn-danger btn-sm mapping-delete-btn">Delete</button>
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
                if (confirm('Delete this custom mapping?')) {
                    vscode.postMessage({ command: 'deleteCustomMapping', mappingId: id });
                }
            });
        });
    }
})();
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        normalizeNumericInput,
        formatNumberDisplay,
        formatExactMatchValue,
        normalizeFilterInputValue,
        escapeSqlString,
        liveFormatNumeric
    };
}
