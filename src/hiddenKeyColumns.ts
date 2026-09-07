/**
 * Silently select the primary-key columns a query leaves out.
 *
 * Without them a row of a custom SELECT can only be matched by all of its
 * displayed values, so an UPDATE narrows by whatever happens to be on screen
 * instead of by the key. The missing key columns are therefore appended to the
 * executed statement under a reserved alias, kept out of the grid and used only
 * to identify the row that is written back.
 *
 * The rewrite is deliberately cautious: anything that could change the meaning
 * of the query — a grouped, distinct or combined SELECT, a table whose alias
 * cannot be determined beyond doubt — is left alone.
 */

import { maskSql } from './selectStatementExtractor';
import type { TableEditPlan } from './resultSource';

/** Alias prefix of a key column that is selected but never displayed. */
export const HIDDEN_KEY_PREFIX = '__pqb_key_';

export function isHiddenKeyColumn(name: string): boolean {
    return name.startsWith(HIDDEN_KEY_PREFIX);
}

/** One key column added to the select list on the user's behalf. */
export interface HiddenKeyColumn {
    /** Result column name it is selected under. */
    name: string;
    /** Table qualifier as written in the query; empty when unqualified. */
    qualifier: string;
    /** Real primary-key column of the source table. */
    column: string;
}

const IDENT = '(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)';
const PLAIN_ITEM = new RegExp(`^(${IDENT})(?:\\s*\\.\\s*(${IDENT}))?(?:\\s+AS\\s+(${IDENT})|\\s+(${IDENT}))?$`, 'i');

/** Clauses whose presence makes adding a column to the select list unsafe. */
const BLOCKING_CLAUSES = [/\bGROUP\s+BY\b/gi, /\bHAVING\b/gi, /\bWINDOW\b/gi, /\bUNION\b/gi, /\bINTERSECT\b/gi, /\bEXCEPT\b/gi];

/** A select-list entry that is a plain column reference. */
interface SelectItem {
    /** Qualifier exactly as written, '' when the reference is unqualified. */
    qualifier: string;
    /** Referenced column, folded like PostgreSQL folds an identifier. */
    column: string;
    /** Name the result exposes it under. */
    name: string;
}

function quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

/** Unquoted identifiers are folded to lower case, exactly as the server does. */
function foldIdent(token: string): string {
    return token.startsWith('"') ? token.slice(1, -1).replace(/""/g, '"') : token.toLowerCase();
}

/**
 * Comments, literals and quoted identifiers blanked out. Offsets and line
 * breaks stay aligned with the original, so positions found here can be used
 * to slice the untouched SQL.
 */
function maskForScan(sql: string): string {
    const out = maskSql(sql).split('');
    let i = 0;
    while (i < out.length) {
        if (out[i] !== '"') {
            i++;
            continue;
        }
        let j = i + 1;
        while (j < out.length) {
            if (out[j] === '"') {
                if (out[j + 1] === '"') { j += 2; continue; }
                j++;
                break;
            }
            j++;
        }
        for (let k = i; k < j; k++) {
            if (out[k] !== '\n' && out[k] !== '\r') { out[k] = ' '; }
        }
        i = j;
    }
    return out.join('');
}

/** Parenthesis nesting level of every character of the masked SQL. */
function parenDepths(masked: string): number[] {
    const depths: number[] = new Array(masked.length);
    let depth = 0;
    for (let i = 0; i < masked.length; i++) {
        const c = masked[i];
        if (c === ')') { depth = Math.max(0, depth - 1); }
        depths[i] = depth;
        if (c === '(') { depth++; }
    }
    return depths;
}

function findTopLevel(masked: string, depths: number[], pattern: RegExp, from = 0): number {
    pattern.lastIndex = from;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(masked)) !== null) {
        if (depths[match.index] === 0) { return match.index; }
    }
    return -1;
}

/** Offset of the top-level `FROM`, or -1 when the query has none. */
function findFromClause(masked: string, depths: number[]): number {
    return findTopLevel(masked, depths, /\bFROM\b/gi);
}

function splitTopLevelCommas(masked: string, start: number, end: number, depths: number[]): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    let itemStart = start;
    for (let i = start; i < end; i++) {
        if (masked[i] === ',' && depths[i] === 0) {
            ranges.push([itemStart, i]);
            itemStart = i + 1;
        }
    }
    ranges.push([itemStart, end]);
    return ranges;
}

/** The plain column references of the select list, or null when the query must not be touched. */
function parseSelectList(sql: string): { items: SelectItem[]; joined: boolean } | null {
    const stripped = sql.replace(/;\s*$/, '');
    const masked = maskForScan(stripped);
    if (masked.includes(';')) {
        return null;
    }
    const selectMatch = /^\s*SELECT\b/i.exec(masked);
    if (!selectMatch) {
        return null;
    }
    const depths = parenDepths(masked);
    const from = findFromClause(masked, depths);
    if (from < 0) {
        return null;
    }
    const listStart = selectMatch[0].length;
    if (/^\s*(DISTINCT|ALL)\b/i.test(masked.slice(listStart, from))) {
        return null;
    }
    for (const clause of BLOCKING_CLAUSES) {
        if (findTopLevel(masked, depths, clause) >= 0) {
            return null;
        }
    }

    // Items are read from a copy without comments and literals, so a comment
    // between two columns cannot hide a plain reference.
    const readable = maskSql(stripped);
    const items: SelectItem[] = [];
    for (const [start, end] of splitTopLevelCommas(masked, listStart, from, depths)) {
        const match = PLAIN_ITEM.exec(readable.slice(start, end).trim());
        if (!match) {
            continue;
        }
        const qualifier = match[2] ? match[1] : '';
        const column = foldIdent(match[2] || match[1]);
        const alias = match[3] || match[4];
        items.push({ qualifier, column, name: alias ? foldIdent(alias) : column });
    }

    const joined = findTopLevel(masked, depths, /\bJOIN\b/gi, from) >= 0
        || splitTopLevelCommas(masked, from, masked.length, depths).length > 1;
    return { items, joined };
}

/**
 * The qualifier every visible column of `plan` is selected through, or null
 * when the query uses more than one alias for that table (or none that can be
 * recognised) — then the key cannot be added without guessing.
 */
function qualifierOf(plan: TableEditPlan, items: ReadonlyArray<SelectItem>): string | null {
    const byName = new Map(plan.columns.map(c => [c.name, c.sourceColumn]));
    const qualifiers = new Set<string>();
    for (const item of items) {
        const sourceColumn = byName.get(item.name);
        if (sourceColumn === undefined || sourceColumn !== item.column) {
            continue;
        }
        qualifiers.add(item.qualifier);
    }
    return qualifiers.size === 1 ? [...qualifiers][0] : null;
}

/**
 * Result column name -> the table alias it is selected through. Only plain
 * `alias.column` items are reported, and a name used by two different aliases
 * is left out because it could not be told apart afterwards.
 */
export function resultColumnQualifiers(sql: string): Map<string, string> {
    const list = parseSelectList(sql);
    const qualifiers = new Map<string, string>();
    if (!list) {
        return qualifiers;
    }
    const ambiguous = new Set<string>();
    for (const item of list.items) {
        if (!item.qualifier) {
            continue;
        }
        const known = qualifiers.get(item.name);
        if (known !== undefined && known !== item.qualifier) {
            ambiguous.add(item.name);
        }
        qualifiers.set(item.name, item.qualifier);
    }
    for (const name of ambiguous) {
        qualifiers.delete(name);
    }
    return qualifiers;
}

/**
 * The key columns that should be selected silently for the given result, in the
 * order they will be appended to the select list.
 */
export function planHiddenKeyColumns(
    sql: string,
    tables: ReadonlyArray<TableEditPlan>,
    resultColumns: ReadonlyArray<string>
): HiddenKeyColumn[] {
    const candidates = tables.filter(t => t.identityStrategy === 'row' && (t.missingKeyColumns || []).length > 0);
    if (candidates.length === 0) {
        return [];
    }
    const list = parseSelectList(sql);
    if (!list) {
        return [];
    }

    const keys: HiddenKeyColumn[] = [];
    const taken = new Set<string>(resultColumns);
    let next = 0;
    for (const plan of candidates) {
        const qualifier = plan.qualifier ?? qualifierOf(plan, list.items);
        if (qualifier === null) {
            continue;
        }
        // An unqualified key column could be ambiguous as soon as a second
        // table is in play.
        if (qualifier === '' && (tables.length > 1 || list.joined)) {
            continue;
        }
        for (const column of plan.missingKeyColumns) {
            let name = `${HIDDEN_KEY_PREFIX}${next++}`;
            while (taken.has(name)) {
                name = `${HIDDEN_KEY_PREFIX}${next++}`;
            }
            taken.add(name);
            keys.push({ name, qualifier, column });
        }
    }
    return keys;
}

/** Append the planned key columns to the select list of `sql`. */
export function addHiddenKeyColumns(sql: string, keys: ReadonlyArray<HiddenKeyColumn>): string {
    if (keys.length === 0) {
        return sql;
    }
    const masked = maskForScan(sql);
    const from = findFromClause(masked, parenDepths(masked));
    if (from < 0) {
        return sql;
    }
    const additions = keys
        .map(k => `${k.qualifier ? `${k.qualifier}.` : ''}${quoteIdent(k.column)} AS ${quoteIdent(k.name)}`)
        .join(', ');
    // Only blanks are trimmed: a line break must survive, or a trailing comment
    // would swallow the addition.
    return `${sql.slice(0, from).replace(/[ \t]+$/, '')}, ${additions}\n${sql.slice(from)}`;
}
