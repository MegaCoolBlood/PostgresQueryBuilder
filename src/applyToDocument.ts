import * as vscode from 'vscode';
import { extractSelect, selectStatementForEditing } from './selectStatementExtractor';
import { getErrorMessage } from './logger';

/**
 * Writing a query back over the statement of a SQL file it was read from —
 * the *Apply to File* of a Data Viewer opened by "Edit SELECT in Query Builder".
 */

/** Where the query of a Data Viewer can be written back to, and how. */
export interface ApplyTarget {
    /** The file, as the user knows it (its base name). */
    label: string;
    /** Replace the statement with `sql`; says how it went. */
    apply(sql: string): Promise<{ ok: boolean; message: string }>;
}

/**
 * Where the statement read from a file stands now: at the offset it was read
 * from, or — after edits above it — at its only other occurrence. Anything
 * else is refused, so Apply never overwrites code it did not read.
 */
export function locateApplyRange(currentText: string, expectedStart: number, originalText: string): { start: number; end: number } | { error: string } {
    if (currentText.slice(expectedStart, expectedStart + originalText.length) === originalText) {
        return { start: expectedStart, end: expectedStart + originalText.length };
    }
    const first = currentText.indexOf(originalText);
    if (first >= 0 && currentText.indexOf(originalText, first + 1) < 0) {
        return { start: first, end: first + originalText.length };
    }
    return {
        error: first < 0
            ? 'The SELECT statement was changed in the editor since the Query Builder was opened, so it cannot be replaced safely. Copy the SQL instead, or open the Query Builder on the statement again.'
            : 'The SELECT statement now occurs more than once in the file, so it is unclear which one to replace. Copy the SQL instead.'
    };
}

/** The whitespace that starts the line `offset` is on. */
export function lineIndentAt(source: string, offset: number): string {
    const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
    return /^[ \t]*/.exec(source.slice(lineStart))?.[0] ?? '';
}

/** String literals, quoted identifiers and dollar-quoted bodies, plus the comments that may hide quotes. */
const QUOTED_PART = /--[^\n]*|\/\*[\s\S]*?\*\/|[Ee]'(?:[^'\\]|\\[\s\S]|'')*'|'(?:[^']|'')*'|"(?:[^"]|"")*"|\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g;

/**
 * Indent every line after the first, so a statement written back into an
 * indented function body lines up. A string literal, quoted identifier or
 * dollar-quoted body spanning lines would change its value, so such SQL is
 * left as it is.
 */
export function indentContinuationLines(sql: string, indent: string): string {
    if (!indent) return sql;
    for (const part of sql.match(QUOTED_PART) ?? []) {
        if (!part.startsWith('--') && !part.startsWith('/*') && part.includes('\n')) return sql;
    }
    return sql.split('\n').map((line, i) => (i === 0 || line.trim() === '' ? line : indent + line)).join('\n');
}

/** What "Edit SELECT in Query Builder" opens for the statement at the cursor of a SQL file. */
export interface BuilderSelectSource {
    /** The SELECT shown in the Data Viewer. */
    sql: string;
    /** `[start, end)` of the statement in the file. */
    start: number;
    end: number;
    /** The statement as it stands in the file, which Apply replaces. */
    original: string;
    /** Set when the query must not be written back; the reason is shown to the user. */
    applyBlockedReason?: string;
}

/**
 * The SELECT at the cursor (or the selection) of a SQL file for the Query
 * Builder. A `SELECT … INTO` or an UPDATE is shown as the SELECT it stands
 * for, but cannot be written back: the INTO or the UPDATE would be lost.
 * Undefined when there is no statement.
 */
export function selectSourceForBuilder(
    fullText: string,
    cursorOffset: number,
    selection?: { start: number; end: number }
): BuilderSelectSource | undefined {
    const found = selectStatementForEditing(fullText, cursorOffset, selection);
    if (!found) return undefined;
    const source = { sql: found.sql, start: found.start, end: found.end, original: found.sql };
    if (!found.isUpdate && !found.hasInto) return source;
    const extracted = extractSelect(fullText, cursorOffset, selection);
    if (!extracted || !extracted.sql) return undefined;
    return {
        ...source,
        sql: extracted.sql,
        applyBlockedReason: found.isUpdate
            ? 'The statement is an UPDATE: the Query Builder shows the rows it changes as a SELECT and opens without Apply to File, so the UPDATE is never overwritten.'
            : 'The SELECT has an INTO clause, which the Query Builder cannot show. It opens without Apply to File; copy the SQL back by hand and keep the INTO.'
    };
}

/** The query bar text as it goes into the file: without a trailing semicolon (the file keeps its own). */
export function statementForFile(sql: string): string {
    return sql.replace(/[\s;]+$/, '');
}

/**
 * Apply into a SQL file: replace the statement the Data Viewer was opened on,
 * provided it still stands there unchanged. After a successful Apply the
 * written text is what the next Apply looks for.
 */
export function documentApplyTarget(uri: vscode.Uri, label: string, start: number, original: string): ApplyTarget {
    let expectedStart = start;
    let expectedText = original;
    return {
        label,
        async apply(sql: string) {
            const statement = statementForFile(sql);
            if (!statement.trim()) {
                return { ok: false, message: 'The query bar is empty, so there is nothing to write into the file.' };
            }
            let document: vscode.TextDocument;
            try {
                document = await vscode.workspace.openTextDocument(uri);
            } catch (err: unknown) {
                return { ok: false, message: `${label} cannot be opened: ${getErrorMessage(err)}` };
            }
            const current = document.getText();
            const located = locateApplyRange(current, expectedStart, expectedText);
            if ('error' in located) return { ok: false, message: located.error };
            let replacement = indentContinuationLines(statement, lineIndentAt(current, located.start));
            if (current.includes('\r\n')) replacement = replacement.replace(/\r?\n/g, '\r\n');
            const edit = new vscode.WorkspaceEdit();
            edit.replace(uri, new vscode.Range(document.positionAt(located.start), document.positionAt(located.end)), replacement);
            if (!await vscode.workspace.applyEdit(edit)) {
                return { ok: false, message: `VS Code did not accept the change to ${label}.` };
            }
            expectedStart = located.start;
            expectedText = replacement;
            return { ok: true, message: `The statement in ${label} was replaced.` };
        }
    };
}
