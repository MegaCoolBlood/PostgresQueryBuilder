/*
 * SQL editor of the Data Viewer's query bar.
 *
 * The query box starts as the plain <textarea> of tableView.html, so the grid is
 * usable at once. When the Monaco bundle (dist/monaco — the editor VS Code is
 * built on) has loaded, the textarea is replaced by a Monaco editor with
 * PostgreSQL highlighting, autocomplete and formatting. The textarea stays in the
 * DOM as the interface the rest of tableView.js talks to: its `value` reads and
 * writes the editor, `focus()` focuses it, and editor changes are re-dispatched
 * as `input` / `blur` events — so the undo history, the query history and every
 * feature that rewrites the query keep working unchanged. Without the bundle the
 * textarea simply stays.
 *
 * The top-level helpers are pure and exported for the tests; the DOM part only
 * runs inside the webview.
 */
(function () {
    'use strict';

    // ===== Tokenizer =========================================================

    // Split SQL into tokens: ws, comment, string, word, qident (a "quoted"
    // identifier), number, punct ( . , ; ( ) [ ] ), param ($1) and op. Unclosed
    // comments, strings and quoted identifiers run to the end and carry
    // `closed: false`, which tells the autocomplete that the cursor is inside one.
    function tokenizeSql(text) {
        const s = String(text == null ? '' : text);
        const n = s.length;
        const tokens = [];
        const push = (type, start, end, extra) => {
            tokens.push(Object.assign({ type, text: s.slice(start, end), start, end }, extra || {}));
        };
        let i = 0;
        while (i < n) {
            const ch = s[i];
            const start = i;
            if (/\s/.test(ch)) {
                while (i < n && /\s/.test(s[i])) i++;
                push('ws', start, i);
            } else if (ch === '-' && s[i + 1] === '-') {
                while (i < n && s[i] !== '\n') i++;
                push('comment', start, i, { closed: i < n });
            } else if (ch === '/' && s[i + 1] === '*') {
                const close = s.indexOf('*/', i + 2);
                i = close < 0 ? n : close + 2;
                push('comment', start, i, { closed: close >= 0 });
            } else if (ch === "'") {
                i++;
                let closed = false;
                while (i < n) {
                    if (s[i] === "'") {
                        if (s[i + 1] === "'") { i += 2; continue; }
                        i++;
                        closed = true;
                        break;
                    }
                    i++;
                }
                push('string', start, i, { closed });
            } else if (ch === '"') {
                i++;
                let closed = false;
                let name = '';
                while (i < n) {
                    if (s[i] === '"') {
                        if (s[i + 1] === '"') { name += '"'; i += 2; continue; }
                        i++;
                        closed = true;
                        break;
                    }
                    name += s[i++];
                }
                push('qident', start, i, { closed, name });
            } else if (ch === '$') {
                const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i));
                const param = /^\$\d+/.exec(s.slice(i));
                if (tag) {
                    const close = s.indexOf(tag[0], i + tag[0].length);
                    i = close < 0 ? n : close + tag[0].length;
                    push('string', start, i, { closed: close >= 0 });
                } else if (param) {
                    i += param[0].length;
                    push('param', start, i);
                } else {
                    i++;
                    push('op', start, i);
                }
            } else if (/[A-Za-z_\u0080-\uffff]/.test(ch)) {
                while (i < n && /[A-Za-z0-9_$\u0080-\uffff]/.test(s[i])) i++;
                push('word', start, i, { name: s.slice(start, i).toLowerCase() });
            } else if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(s[i + 1] || ''))) {
                while (i < n && /[0-9.eE]/.test(s[i])) i++;
                push('number', start, i);
            } else if ('.,;()[]'.includes(ch)) {
                i++;
                push('punct', start, i);
            } else {
                i++;
                push('op', start, i);
            }
        }
        return tokens;
    }

    function significantTokens(tokens) {
        return tokens.filter(t => t.type !== 'ws' && t.type !== 'comment');
    }

    const isIdent = t => !!t && (t.type === 'word' || t.type === 'qident');
    // Unquoted names are already folded to lower case like PostgreSQL does; quoted ones stay as written.
    const identName = t => t.name;
    const upperWord = t => (t && t.type === 'word' ? t.text.toUpperCase() : '');

    // ===== Table references ==================================================

    // Keywords after which a relation name follows.
    const RELATION_KEYWORDS = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO']);
    // Words that end a relation instead of naming its alias.
    const ALIAS_STOP_WORDS = new Set([
        'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL', 'ON', 'USING',
        'GROUP', 'ORDER', 'LIMIT', 'OFFSET', 'HAVING', 'WINDOW', 'UNION', 'EXCEPT', 'INTERSECT', 'SET',
        'VALUES', 'RETURNING', 'FOR', 'FETCH', 'LATERAL', 'TABLESAMPLE', 'SELECT', 'FROM', 'AND', 'OR',
        'WHEN', 'THEN', 'ELSE', 'END', 'DEFAULT', 'DO', 'AS', 'ONLY', 'WITH'
    ]);

    function matchParen(t, open) {
        let depth = 0;
        for (let k = open; k < t.length; k++) {
            if (t[k].text === '(') depth++;
            else if (t[k].text === ')' && --depth === 0) return k;
        }
        return t.length - 1;
    }

    function readAlias(t, k) {
        if (upperWord(t[k]) === 'AS') k++;
        let alias = null;
        if (isIdent(t[k]) && !(t[k].type === 'word' && ALIAS_STOP_WORDS.has(upperWord(t[k])))) {
            alias = identName(t[k]);
            k++;
            // A column alias list: `AS t(a, b)`.
            if (t[k] && t[k].text === '(') k = matchParen(t, k) + 1;
        }
        return { alias, next: k };
    }

    // One relation at t[j]: a (schema-qualified) name with an optional alias, or
    // a sub-select / table function, which is skipped together with its alias.
    // After INTO a parenthesis is the column list, not a function call.
    function readRelation(t, j, keyword) {
        const tok = t[j];
        if (!tok) return null;
        if (tok.text === '(') {
            return { ref: null, next: readAlias(t, matchParen(t, j) + 1).next };
        }
        if (!isIdent(tok) || (tok.type === 'word' && ALIAS_STOP_WORDS.has(upperWord(tok)))) return null;
        const parts = [identName(tok)];
        let k = j + 1;
        while (t[k] && t[k].text === '.' && isIdent(t[k + 1])) {
            parts.push(identName(t[k + 1]));
            k += 2;
        }
        // `schema.` still being typed names no table yet.
        if (t[k] && t[k].text === '.') {
            return { ref: null, next: k + 1 };
        }
        if (t[k] && t[k].text === '(' && keyword !== 'INTO') {
            return { ref: null, next: readAlias(t, matchParen(t, k) + 1).next };
        }
        const a = readAlias(t, k);
        return {
            ref: {
                schema: parts.length >= 2 ? parts[parts.length - 2] : null,
                table: parts[parts.length - 1],
                alias: a.alias
            },
            next: a.next
        };
    }

    // Every table the statement reads or writes, with its schema (when written)
    // and alias: FROM lists, JOINs, UPDATE and INSERT INTO targets, including
    // those inside sub-selects. Tolerates the half-typed text of an editor.
    function extractTableReferences(text) {
        const t = significantTokens(tokenizeSql(text));
        const refs = [];
        for (let i = 0; i < t.length; i++) {
            const kw = upperWord(t[i]);
            if (!RELATION_KEYWORDS.has(kw)) continue;
            let j = i + 1;
            for (;;) {
                while (upperWord(t[j]) === 'ONLY' || upperWord(t[j]) === 'LATERAL') j++;
                const r = readRelation(t, j, kw);
                if (!r) break;
                if (r.ref) refs.push(r.ref);
                j = r.next;
                if (kw !== 'FROM' || !t[j] || t[j].text !== ',') break;
                j++;
            }
        }
        return refs;
    }

    // ===== Completion context ================================================

    // Keywords that open the clause a comma belongs to.
    const CLAUSE_WORDS = new Set(['SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'SET', 'VALUES',
        'JOIN', 'ON', 'USING', 'RETURNING', 'LIMIT', 'BY']);

    // What the cursor at the end of `textBefore` is completing:
    //   { kind: 'none' }               inside a comment, string or quoted name
    //   { kind: 'member', path }       after `x.` / `schema.table.`
    //   { kind: 'relation' }           where a table name belongs (FROM, JOIN, …)
    //   { kind: 'any' }                anywhere else
    function completionContext(textBefore) {
        const all = tokenizeSql(textBefore);
        const last = all[all.length - 1];
        if (last && (last.type === 'comment' || last.type === 'string' || last.type === 'qident') && last.closed === false) {
            return { kind: 'none' };
        }
        let tokens = all;
        let prefix = '';
        if (last && last.type === 'word') {
            prefix = last.text;
            tokens = all.slice(0, -1);
        }
        const sig = significantTokens(tokens);
        // Only a dot directly before the word being typed qualifies it.
        const prevRaw = tokens[tokens.length - 1];
        if (prevRaw && prevRaw.text === '.') {
            const path = [];
            let k = sig.length - 1;
            while (k >= 1 && sig[k].text === '.' && isIdent(sig[k - 1])) {
                path.unshift(identName(sig[k - 1]));
                k -= 2;
            }
            return path.length ? { kind: 'member', path, prefix } : { kind: 'none' };
        }
        const prev = sig[sig.length - 1];
        if (prev && (RELATION_KEYWORDS.has(upperWord(prev)) || ['ONLY', 'LATERAL', 'TABLE'].includes(upperWord(prev)))) {
            return { kind: 'relation', prefix };
        }
        if (prev && prev.text === ',') {
            let depth = 0;
            for (let k = sig.length - 2; k >= 0; k--) {
                const tok = sig[k];
                if (tok.text === ')') depth++;
                else if (tok.text === '(') { if (depth === 0) break; depth--; }
                else if (depth === 0 && CLAUSE_WORDS.has(upperWord(tok))) {
                    return upperWord(tok) === 'FROM' ? { kind: 'relation', prefix } : { kind: 'any', prefix };
                }
            }
        }
        return { kind: 'any', prefix };
    }

    // ===== Resolving names against the catalog ==============================
    //
    // catalog = { schemas: [name], relations: [{ schema, name, kind }], searchPath: [schema] }

    // The table or schema a `qualifier.` refers to: an alias or table of the
    // statement first, then a schema, then any table of that name.
    function resolveQualifier(path, refs, catalog) {
        if (!path || path.length === 0) return null;
        if (path.length >= 2) {
            return { type: 'table', schema: path[path.length - 2], table: path[path.length - 1] };
        }
        const name = path[0];
        const byAlias = refs.find(r => r.alias === name);
        if (byAlias) return { type: 'table', schema: byAlias.schema, table: byAlias.table };
        const byTable = refs.find(r => !r.alias && r.table === name) || refs.find(r => r.table === name);
        if (byTable) return { type: 'table', schema: byTable.schema, table: byTable.table };
        if (catalog.schemas.includes(name)) return { type: 'schema', schema: name };
        if (catalog.relations.some(r => r.name === name)) return { type: 'table', schema: null, table: name };
        return null;
    }

    // The schema an unqualified table resolves to, following the search_path
    // like PostgreSQL does; a qualified one is taken as written.
    function resolveRelation(ref, catalog) {
        if (!ref || !ref.table) return null;
        if (ref.schema) return { schema: ref.schema, table: ref.table };
        const candidates = catalog.relations.filter(r => r.name === ref.table);
        for (const schema of catalog.searchPath) {
            if (candidates.some(r => r.schema === schema)) return { schema, table: ref.table };
        }
        return candidates.length ? { schema: candidates[0].schema, table: ref.table } : null;
    }

    // How a relation is inserted: unqualified when the search_path finds it
    // under that name anyway, schema-qualified otherwise.
    function relationInsertText(rel, catalog, quoteIdent) {
        const resolved = resolveRelation({ schema: null, table: rel.name }, catalog);
        const visible = resolved && resolved.schema === rel.schema && catalog.searchPath.includes(rel.schema);
        return visible ? quoteIdent(rel.name) : `${quoteIdent(rel.schema)}.${quoteIdent(rel.name)}`;
    }

    // The tables whose columns a suggestion list needs.
    function tablesNeedingColumns(ctx, refs, catalog) {
        let wanted = [];
        if (ctx.kind === 'member') {
            const q = resolveQualifier(ctx.path, refs, catalog);
            if (q && q.type === 'table') wanted = [q];
        } else if (ctx.kind === 'any') {
            wanted = refs;
        }
        const seen = new Set();
        const out = [];
        for (const ref of wanted) {
            const rel = resolveRelation(ref, catalog);
            const key = rel && `${rel.schema}.${rel.table}`;
            if (rel && !seen.has(key)) {
                seen.add(key);
                out.push(rel);
            }
        }
        return out;
    }

    const RELATION_KIND_LABEL = { table: 'table', view: 'view', matview: 'materialized view', foreign: 'foreign table' };

    // The suggestions for a completion context, ordered by sortText: columns,
    // then tables/aliases, then functions, then keywords. `columnsOf(schema,
    // table)` returns the loaded columns ([{ name, type }]) or undefined.
    function buildSuggestions(ctx, data) {
        const { catalog, refs, columnsOf, quoteIdent } = data;
        const items = [];
        const relationItem = (rel, insertText, sortGroup) => ({
            label: rel.name,
            kind: rel.kind === 'table' || rel.kind === 'foreign' ? 'table' : 'view',
            insertText,
            detail: `${rel.schema} · ${RELATION_KIND_LABEL[rel.kind] || rel.kind}`,
            sortText: sortGroup + rel.name.toLowerCase()
        });
        const columnItems = (rel, source, sortGroup) => (columnsOf(rel.schema, rel.table) || []).map((c, i) => ({
            label: c.name,
            kind: 'column',
            insertText: quoteIdent(c.name),
            detail: `${c.type || ''} — ${source}`.trim(),
            sortText: sortGroup + String(i).padStart(4, '0')
        }));

        if (ctx.kind === 'none') return items;
        if (ctx.kind === 'member') {
            const q = resolveQualifier(ctx.path, refs, catalog);
            if (q && q.type === 'schema') {
                catalog.relations.filter(r => r.schema === q.schema)
                    .forEach(r => items.push(relationItem(r, quoteIdent(r.name), '1')));
            } else if (q) {
                const rel = resolveRelation(q, catalog);
                if (rel) items.push(...columnItems(rel, `${rel.schema}.${rel.table}`, '0'));
            }
            return items;
        }
        if (ctx.kind === 'relation') {
            catalog.relations.forEach(r => {
                const insertText = relationInsertText(r, catalog, quoteIdent);
                items.push(relationItem(r, insertText, insertText.includes('.') ? '2' : '1'));
            });
            catalog.schemas.forEach(s => items.push({
                label: s, kind: 'schema', insertText: quoteIdent(s), detail: 'schema', sortText: '3' + s.toLowerCase()
            }));
        } else {
            refs.forEach(ref => {
                const rel = resolveRelation(ref, catalog);
                if (!rel) return;
                items.push(...columnItems(rel, ref.alias || ref.table, '1'));
                items.push({
                    label: ref.alias || ref.table,
                    kind: 'alias',
                    insertText: quoteIdent(ref.alias || ref.table),
                    detail: `${rel.schema}.${rel.table}`,
                    sortText: '2' + (ref.alias || ref.table).toLowerCase()
                });
            });
            (data.functions || []).forEach(f => items.push({
                label: f, kind: 'function', insertText: `${f}($0)`, isSnippet: true, detail: 'function', sortText: '3' + f
            }));
        }
        (data.keywords || []).forEach(k => items.push({
            label: k, kind: 'keyword', insertText: k, detail: 'keyword', sortText: '4' + k
        }));
        return items;
    }

    // Clause keywords that are not reserved words, so the grammar's keyword
    // list does not carry them.
    const EXTRA_KEYWORDS = [
        'BY', 'CONFLICT', 'DELETE', 'DESC', 'ASC', 'EXISTS', 'FIRST', 'ILIKE', 'INSERT', 'LAST', 'NOTHING',
        'NULLS', 'OVER', 'PARTITION', 'RECURSIVE', 'UPDATE', 'VALUES', 'SET', 'ROWS', 'RANGE', 'FILTER',
        'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL', 'JOIN', 'ILIKE', 'SIMILAR', 'TRUNCATE'
    ];

    // The keyword list offered by autocomplete: the grammar's keywords and
    // operator words plus the clause keywords above, upper case, without duplicates.
    function completionKeywords(grammar) {
        const words = []
            .concat(grammar && grammar.keywords || [])
            .concat(grammar && grammar.operators || [])
            .concat(EXTRA_KEYWORDS)
            .map(w => String(w).toUpperCase())
            .filter(w => /^[A-Z_]+$/.test(w));
        return Array.from(new Set(words)).sort();
    }

    // ===== Theme =============================================================

    // A CSS colour as Monaco expects it (#rrggbb or #rrggbbaa), or null.
    function cssColorToHex(value) {
        const v = String(value || '').trim();
        let m = /^#([0-9a-f]{3,4})$/i.exec(v);
        if (m) return '#' + m[1].split('').map(c => c + c).join('').toLowerCase();
        m = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v);
        if (m) return '#' + m[1].toLowerCase();
        m = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)(?:[\s,/]+(\d*\.?\d+)(%?))?\s*\)$/i.exec(v);
        if (!m) return null;
        const hex = x => Math.max(0, Math.min(255, Math.round(Number(x)))).toString(16).padStart(2, '0');
        let out = '#' + hex(m[1]) + hex(m[2]) + hex(m[3]);
        if (m[4] !== undefined) {
            const alpha = m[5] === '%' ? Number(m[4]) / 100 : Number(m[4]);
            if (alpha < 1) out += hex(alpha * 255);
        }
        return out;
    }

    // Monaco's base theme for the body class VS Code gives the webview.
    function monacoBaseTheme(bodyClassName) {
        const c = ' ' + String(bodyClassName || '') + ' ';
        if (c.includes(' vscode-high-contrast-light ')) return 'hc-light';
        if (c.includes(' vscode-high-contrast ')) return 'hc-black';
        if (c.includes(' vscode-light ')) return 'vs';
        return 'vs-dark';
    }

    // Editor colours taken from the active VS Code theme (first variable that is set wins).
    const THEME_COLOR_VARS = [
        ['editor.background', '--vscode-input-background', '--vscode-editor-background'],
        ['editor.foreground', '--vscode-input-foreground', '--vscode-editor-foreground'],
        ['editorCursor.foreground', '--vscode-editorCursor-foreground'],
        ['editor.selectionBackground', '--vscode-editor-selectionBackground'],
        ['editor.inactiveSelectionBackground', '--vscode-editor-inactiveSelectionBackground'],
        ['editor.selectionHighlightBackground', '--vscode-editor-selectionHighlightBackground'],
        ['editor.wordHighlightBackground', '--vscode-editor-wordHighlightBackground'],
        ['editor.findMatchBackground', '--vscode-editor-findMatchBackground'],
        ['editor.findMatchHighlightBackground', '--vscode-editor-findMatchHighlightBackground'],
        ['editor.lineHighlightBackground', '--vscode-editor-lineHighlightBackground'],
        ['editorLineNumber.foreground', '--vscode-editorLineNumber-foreground'],
        ['editorLineNumber.activeForeground', '--vscode-editorLineNumber-activeForeground'],
        ['editorBracketMatch.background', '--vscode-editorBracketMatch-background'],
        ['editorBracketMatch.border', '--vscode-editorBracketMatch-border'],
        ['editorIndentGuide.background1', '--vscode-editorIndentGuide-background1', '--vscode-editorIndentGuide-background'],
        ['editorWidget.background', '--vscode-editorWidget-background'],
        ['editorWidget.foreground', '--vscode-editorWidget-foreground'],
        ['editorWidget.border', '--vscode-editorWidget-border'],
        ['editorSuggestWidget.background', '--vscode-editorSuggestWidget-background'],
        ['editorSuggestWidget.border', '--vscode-editorSuggestWidget-border'],
        ['editorSuggestWidget.foreground', '--vscode-editorSuggestWidget-foreground'],
        ['editorSuggestWidget.selectedBackground', '--vscode-editorSuggestWidget-selectedBackground'],
        ['editorSuggestWidget.selectedForeground', '--vscode-editorSuggestWidget-selectedForeground'],
        ['editorSuggestWidget.highlightForeground', '--vscode-editorSuggestWidget-highlightForeground'],
        ['editorSuggestWidget.focusHighlightForeground', '--vscode-editorSuggestWidget-focusHighlightForeground'],
        ['editorHoverWidget.background', '--vscode-editorHoverWidget-background'],
        ['editorHoverWidget.border', '--vscode-editorHoverWidget-border'],
        ['input.background', '--vscode-input-background'],
        ['input.foreground', '--vscode-input-foreground'],
        ['input.border', '--vscode-input-border'],
        ['focusBorder', '--vscode-focusBorder'],
        ['list.hoverBackground', '--vscode-list-hoverBackground'],
        ['list.activeSelectionBackground', '--vscode-list-activeSelectionBackground'],
        ['list.activeSelectionForeground', '--vscode-list-activeSelectionForeground'],
        ['list.highlightForeground', '--vscode-list-highlightForeground'],
        ['scrollbarSlider.background', '--vscode-scrollbarSlider-background'],
        ['scrollbarSlider.hoverBackground', '--vscode-scrollbarSlider-hoverBackground'],
        ['scrollbarSlider.activeBackground', '--vscode-scrollbarSlider-activeBackground'],
        ['menu.background', '--vscode-menu-background'],
        ['menu.foreground', '--vscode-menu-foreground'],
        ['menu.selectionBackground', '--vscode-menu-selectionBackground'],
        ['menu.selectionForeground', '--vscode-menu-selectionForeground'],
        ['menu.separatorBackground', '--vscode-menu-separatorBackground'],
        ['quickInput.background', '--vscode-quickInput-background'],
        ['quickInput.foreground', '--vscode-quickInput-foreground']
    ];

    // The Monaco colour map for the current theme; `readVar(name)` returns a CSS variable's value.
    function themeColorsFrom(readVar) {
        const colors = {};
        for (const [key, ...vars] of THEME_COLOR_VARS) {
            for (const v of vars) {
                const hex = cssColorToHex(readVar(v));
                if (hex) { colors[key] = hex; break; }
            }
        }
        return colors;
    }

    // The editor's height for its content: at least one line, at most `max`.
    function editorHeight(contentHeight, min, max) {
        const h = Math.ceil(Number(contentHeight) || 0);
        return Math.max(min, Math.min(max, h));
    }

    const api = {
        tokenizeSql,
        extractTableReferences,
        completionContext,
        resolveQualifier,
        resolveRelation,
        relationInsertText,
        tablesNeedingColumns,
        buildSuggestions,
        completionKeywords,
        cssColorToHex,
        monacoBaseTheme,
        themeColorsFrom,
        editorHeight
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        return;
    }

    // ===== Webview: the editor ==============================================

    const MIN_HEIGHT = 26;
    const MAX_HEIGHT = 320;
    const CATALOG_TTL_MS = 60000;
    const THEME_NAME = 'pgqb-theme';

    const defaultQuote = name => (/^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${String(name).replace(/"/g, '""')}"`);

    function attach(textarea, opts) {
        const options = opts || {};
        const post = options.postMessage || (() => {});
        const discreteEdit = options.onDiscreteEdit || (() => {});
        const quoteIdent = options.quoteIdent || defaultQuote;
        const pending = new Map();
        let seq = 0;
        let editor = null;
        let catalog = null;
        let catalogAt = 0;
        const columns = new Map();

        // One round trip to the extension host; resolves null on timeout.
        function request(kind, payload, timeoutMs) {
            return new Promise(resolve => {
                const requestId = ++seq;
                pending.set(requestId, resolve);
                post(Object.assign({ command: 'queryEditorRequest', requestId, kind }, payload || {}));
                setTimeout(() => {
                    if (pending.delete(requestId)) resolve(null);
                }, timeoutMs);
            });
        }

        window.addEventListener('message', e => {
            const msg = e.data || {};
            if (msg.command === 'queryEditorResponse' && pending.has(msg.requestId)) {
                const resolve = pending.get(msg.requestId);
                pending.delete(msg.requestId);
                resolve(msg.result);
            } else if (msg.command === 'connectionChanged') {
                catalog = null;
                columns.clear();
            }
        });

        async function getCatalog() {
            if (!catalog || Date.now() - catalogAt > CATALOG_TTL_MS) {
                const result = await request('catalog', {}, 10000);
                catalog = {
                    schemas: (result && result.schemas) || [],
                    relations: (result && result.relations) || [],
                    searchPath: (result && result.searchPath) || []
                };
                catalogAt = result ? Date.now() : 0;
            }
            return catalog;
        }

        async function loadColumns(rels) {
            await Promise.all(rels.map(async rel => {
                const key = `${rel.schema}.${rel.table}`;
                if (columns.has(key)) return;
                const result = await request('columns', { schema: rel.schema, table: rel.table }, 5000);
                if (result) columns.set(key, result);
            }));
        }

        async function formatText(sql) {
            const result = await request('format', { sql }, 20000);
            return result && result.ok ? result.text : null;
        }

        // Format with the extension's PL/pgSQL formatter. Without Monaco the
        // textarea is rewritten directly as one undo step.
        async function format() {
            if (editor) {
                editor.focus();
                await editor.getAction('editor.action.formatDocument').run();
                return;
            }
            const text = await formatText(textarea.value);
            if (text !== null && text !== textarea.value) {
                discreteEdit();
                textarea.value = text;
                textarea.dispatchEvent(new Event('input'));
                discreteEdit();
            }
            textarea.focus();
        }

        function defineTheme(monaco) {
            const style = getComputedStyle(document.body);
            monaco.editor.defineTheme(THEME_NAME, {
                base: monacoBaseTheme(document.body.className),
                inherit: true,
                rules: [],
                colors: themeColorsFrom(name => style.getPropertyValue(name))
            });
        }

        function toMonacoItem(monaco, item, range) {
            const K = monaco.languages.CompletionItemKind;
            const kinds = { column: K.Field, table: K.Class, view: K.Interface, schema: K.Module, alias: K.Variable, function: K.Function, keyword: K.Keyword };
            return {
                label: item.label,
                kind: kinds[item.kind] !== undefined ? kinds[item.kind] : K.Text,
                insertText: item.insertText,
                insertTextRules: item.isSnippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
                detail: item.detail,
                sortText: item.sortText,
                range
            };
        }

        function registerLanguageFeatures(monaco) {
            const grammar = monaco.pgsqlLanguage || {};
            const keywords = completionKeywords(grammar);
            const functions = Array.from(new Set((grammar.builtinFunctions || []).map(f => String(f).toLowerCase()))).sort();

            monaco.languages.registerCompletionItemProvider('pgsql', {
                triggerCharacters: ['.'],
                async provideCompletionItems(model, position) {
                    const before = model.getValueInRange({
                        startLineNumber: 1, startColumn: 1,
                        endLineNumber: position.lineNumber, endColumn: position.column
                    });
                    const ctx = completionContext(before);
                    if (ctx.kind === 'none') return { suggestions: [] };
                    const cat = await getCatalog();
                    const refs = extractTableReferences(model.getValue());
                    await loadColumns(tablesNeedingColumns(ctx, refs, cat));
                    const items = buildSuggestions(ctx, {
                        catalog: cat,
                        refs,
                        columnsOf: (schema, table) => columns.get(`${schema}.${table}`),
                        keywords,
                        functions,
                        quoteIdent
                    });
                    const word = model.getWordUntilPosition(position);
                    const range = {
                        startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
                        startColumn: word.startColumn, endColumn: word.endColumn
                    };
                    return { suggestions: items.map(item => toMonacoItem(monaco, item, range)) };
                }
            });

            monaco.languages.registerDocumentFormattingEditProvider('pgsql', {
                async provideDocumentFormattingEdits(model) {
                    const original = model.getValue();
                    const text = await formatText(original);
                    if (text === null || text === original || model.getValue() !== original) return [];
                    // The formatted statement is one undo step of its own.
                    discreteEdit();
                    setTimeout(discreteEdit, 0);
                    return [{ range: model.getFullModelRange(), text }];
                }
            });
        }

        function upgrade(monaco) {
            defineTheme(monaco);
            new MutationObserver(() => {
                defineTheme(monaco);
                monaco.editor.setTheme(THEME_NAME);
            }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
            registerLanguageFeatures(monaco);

            const hadFocus = document.activeElement === textarea;
            const container = document.createElement('div');
            container.className = 'query-editor';
            textarea.insertAdjacentElement('afterend', container);
            textarea.classList.add('query-input-replaced');

            const style = getComputedStyle(document.body);
            editor = monaco.editor.create(container, {
                value: textarea.value,
                language: 'pgsql',
                theme: THEME_NAME,
                ariaLabel: 'SQL query',
                // Take input through a hidden textarea rather than the EditContext
                // API: VS Code runs Ctrl+C/X/V in a webview as document.execCommand,
                // which only reaches a focused text field — with EditContext the
                // focus sits on a plain <div> and pasting does nothing.
                editContext: false,
                automaticLayout: true,
                fixedOverflowWidgets: true,
                minimap: { enabled: false },
                lineNumbers: 'on',
                lineNumbersMinChars: 2,
                lineDecorationsWidth: 6,
                glyphMargin: false,
                folding: true,
                scrollBeyondLastLine: false,
                overviewRulerLanes: 0,
                hideCursorInOverviewRuler: true,
                renderLineHighlightOnlyWhenFocus: true,
                stickyScroll: { enabled: false },
                padding: { top: 3, bottom: 3 },
                scrollbar: { alwaysConsumeMouseWheel: false, verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
                fontFamily: style.getPropertyValue('--vscode-editor-font-family').trim() || undefined,
                fontSize: parseFloat(style.getPropertyValue('--vscode-editor-font-size')) || 13,
                tabSize: 4,
                quickSuggestions: { other: true, comments: false, strings: false },
                wordBasedSuggestions: 'off',
                suggest: { showWords: false },
                'semanticHighlighting.enabled': false
            });

            // The textarea becomes the interface to the editor for tableView.js.
            let applying = false;
            Object.defineProperty(textarea, 'value', {
                configurable: true,
                get: () => editor.getValue(),
                set: v => {
                    const text = v == null ? '' : String(v);
                    if (text === editor.getValue()) return;
                    applying = true;
                    try { editor.setValue(text); } finally { applying = false; }
                }
            });
            textarea.focus = () => editor.focus();
            editor.onDidChangeModelContent(() => {
                if (!applying) textarea.dispatchEvent(new Event('input'));
            });
            editor.onDidFocusEditorWidget(() => container.classList.add('focused'));
            editor.onDidBlurEditorWidget(() => {
                container.classList.remove('focused');
                textarea.dispatchEvent(new Event('blur'));
            });

            // Ctrl+Enter runs the query; Ctrl+Z / Ctrl+Y walk the Data Viewer's
            // shared history of grid and query changes instead of the editor's own.
            const { KeyMod, KeyCode } = monaco;
            editor.addCommand(KeyMod.CtrlCmd | KeyCode.Enter, () => options.onRun && options.onRun());
            editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyZ, () => options.onUndo && options.onUndo(), 'editorTextFocus');
            editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyY, () => options.onRedo && options.onRedo(), 'editorTextFocus');
            editor.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyZ, () => options.onRedo && options.onRedo(), 'editorTextFocus');

            const updateHeight = () => {
                const h = editorHeight(editor.getContentHeight(), MIN_HEIGHT, MAX_HEIGHT);
                container.style.setProperty('--query-editor-height', h + 'px');
            };
            editor.onDidContentSizeChange(updateHeight);
            updateHeight();
            if (hadFocus) editor.focus();
        }

        // Load the Monaco bundle after the page is up; null when it is not shipped.
        function loadMonaco(assets) {
            return new Promise(resolve => {
                if (!assets || !assets.script) { resolve(null); return; }
                window.MonacoEnvironment = {
                    // The worker script is loaded through a blob, since a webview
                    // cannot start a worker from its resource URL directly.
                    getWorker(_moduleId, label) {
                        const source = `importScripts(${JSON.stringify(assets.worker)});`;
                        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
                        return new Worker(url, { name: label });
                    }
                };
                const link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = assets.css;
                document.head.appendChild(link);
                const script = document.createElement('script');
                script.src = assets.script;
                script.onload = () => resolve(window.monaco || null);
                script.onerror = () => resolve(null);
                document.body.appendChild(script);
            });
        }

        loadMonaco(window.QUERY_EDITOR_ASSETS)
            .then(monaco => { if (monaco) upgrade(monaco); })
            .catch(err => console.warn('The SQL editor could not be loaded; the plain text box stays.', err));

        return {
            isEditor: () => !!editor,
            hasFocus: () => !!editor && (editor.hasTextFocus() || editor.hasWidgetFocus()),
            format
        };
    }

    window.QueryEditor = { attach };
})();
