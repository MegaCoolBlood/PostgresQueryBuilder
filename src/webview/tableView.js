(function() {
    const vscode = acquireVsCodeApi();

    // State
    let columns = [];
    let primaryKeys = [];
    let foreignKeys = []; // [{column, refSchema, refTable, refColumn}]
    let referencingTables = []; // [{fkSchema, fkTable, fkColumn, localColumn}]
    let allRows = [];
    let displayedRows = [];
    let schema = '';
    let table = '';
    let totalCount = 0;
    let currentOffset = 0;
    const PAGE_SIZE = 50;

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
    const contextMenu = document.getElementById('contextMenu');
    const contextMenuItems = document.getElementById('contextMenuItems');

    // Request initial data
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

    // Close context menu on click outside
    document.addEventListener('click', () => {
        contextMenu.style.display = 'none';
    });

    // Listen for messages from extension
    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.command) {
            case 'dataLoaded':
                handleDataLoaded(msg);
                break;
            case 'queryResult':
                handleQueryResult(msg);
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
            case 'error':
                showError(msg.text);
                break;
        }
    });

    function handleDataLoaded(msg) {
        if (currentOffset === 0) {
            allRows = msg.data;
        } else {
            allRows = allRows.concat(msg.data);
        }
        columns = msg.columns;
        primaryKeys = msg.primaryKeys;
        foreignKeys = msg.foreignKeys || [];
        referencingTables = msg.referencingTables || [];
        totalCount = msg.totalCount;
        schema = msg.schema;
        table = msg.table;

        tableName.textContent = `${schema}.${table}`;
        queryInput.value = `SELECT * FROM "${schema}"."${table}" LIMIT ${PAGE_SIZE} OFFSET ${currentOffset}`;
        updateRowCount();
        renderTable();
    }

    function handleQueryResult(msg) {
        allRows = msg.rows;
        columns = msg.columns;
        totalCount = msg.rows.length;
        tableName.textContent = `${schema}.${table} (custom query)`;
        rowCount.textContent = `${msg.rows.length} rows returned`;
        loadMoreBtn.disabled = true;
        renderTable();
    }

    function runCustomQuery() {
        const sql = queryInput.value.trim();
        if (!sql) return;
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
            const val = filters[col.name] || '';
            html += `<th><input class="filter-input" data-col="${escapeAttr(col.name)}" placeholder="Filter..." value="${escapeAttr(val)}"></th>`;
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
            input.addEventListener('input', (e) => {
                const col = e.target.getAttribute('data-col');
                filters[col] = e.target.value;
                delete exactFilters[col]; // Manual input = ILIKE, not exact
                renderBody();
            });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    applyFiltersToQuery();
                }
            });
        });
    }

    function applyFiltersToQuery() {
        if (!schema || !table) return;

        const whereClauses = [];
        for (const [col, val] of Object.entries(filters)) {
            if (!val) continue;
            const escaped = val.replace(/'/g, "''");
            if (exactFilters[col]) {
                // Exact match for FK navigation
                whereClauses.push(`"${col}" = '${escaped}'`);
            } else {
                whereClauses.push(`"${col}"::text ILIKE '%${escaped}%'`);
            }
        }

        let sql = `SELECT * FROM "${schema}"."${table}"`;
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
                    const escaped = String(cellValue).replace(/'/g, "''");
                    const currentSql = queryInput.value.trim();
                    const excludeClause = `"${colName}" != '${escaped}'`;
                    let sql;
                    if (currentSql.toLowerCase().includes(' where ')) {
                        sql = currentSql + ` AND ${excludeClause}`;
                    } else {
                        sql = `SELECT * FROM "${schema}"."${table}" WHERE ${excludeClause}`;
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
            const lowerFilter = filterVal.toLowerCase();
            rows = rows.filter(row => {
                const cellVal = row[col];
                if (cellVal === null || cellVal === undefined) return false;
                return String(cellVal).toLowerCase().includes(lowerFilter);
            });
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
                const displayVal = currentVal === null ? '<span class="null-value">NULL</span>' : escapeHtml(String(currentVal));

                const fk = foreignKeys.find(f => f.column === col.name);
                const fkBtn = (fk && currentVal !== null && currentVal !== undefined)
                    ? `<button class="fk-btn" data-ref-schema="${escapeAttr(fk.refSchema)}" data-ref-table="${escapeAttr(fk.refTable)}" data-ref-column="${escapeAttr(fk.refColumn)}" data-value="${escapeAttr(String(currentVal))}" title="Open ${fk.refSchema}.${fk.refTable}">&#8599;</button>`
                    : '';

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

        // Attach blur listeners for editable cells (existing rows)
        tableBody.querySelectorAll('td[data-row][contenteditable="true"]').forEach(td => {
            td.addEventListener('blur', handleCellEdit);
        });

        // Attach blur listeners for inserted rows
        tableBody.querySelectorAll('td[data-insert][contenteditable="true"]').forEach(td => {
            td.addEventListener('blur', handleInsertCellEdit);
        });

        // Attach blur listeners for duplicated rows
        tableBody.querySelectorAll('td[data-dup][contenteditable="true"]').forEach(td => {
            td.addEventListener('blur', handleDupCellEdit);
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
        let newValue = td.textContent.trim();

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

        updateChangeIndicator();
    }

    function handleInsertCellEdit(e) {
        const td = e.target;
        const iIdx = parseInt(td.getAttribute('data-insert'));
        const colName = td.getAttribute('data-col');
        insertedRows[iIdx][colName] = td.textContent.trim() || '';
        updateChangeIndicator();
    }

    function handleDupCellEdit(e) {
        const td = e.target;
        const dIdx = parseInt(td.getAttribute('data-dup'));
        const colName = td.getAttribute('data-col');
        duplicatedRows[dIdx][colName] = td.textContent.trim() || '';
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

    // Utility
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
})();
