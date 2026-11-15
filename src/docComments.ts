/**
 * Doc comments of database objects: the `/** … *\/` block (or the `--` lines)
 * right above a CREATE statement, and the `COMMENT ON` text of the database.
 *
 * Two styles are read, also mixed in one comment:
 * - sections: `Purpose:`, `Explanation:`, `Parameters:` with one
 *   `- name (TYPE, MODE): text` entry per parameter, `Returns:`;
 * - Javadoc tags: `@param name text`, `@return(s)`, `@throws` / `@exception`,
 *   `@deprecated`, `@see`, `@example` and any other `@tag`.
 *
 * Pure: no `vscode`. Offsets in the results refer to the raw comment text.
 */
import { normalizeTypeName, type RepoDefinition, type RepoDoc, type RepoParam, type SourcePosition } from './repositoryScanner';

export interface DocParam {
    /** As written; compared case-insensitively. */
    name: string;
    type?: string;
    mode?: string;
    text: string;
    style: 'section' | 'tag';
    /** Offsets of the name in the raw comment. */
    nameStart: number;
    nameEnd: number;
    /** Offsets of the lines the entry takes, for removing it. */
    lineStart: number;
    lineEnd: number;
    /** The entry starts its line, so the lines can be removed. */
    ownsLines: boolean;
}

export interface DocComment {
    /** The first sentence of the purpose, else of the description. */
    summary: string;
    /** The explanation or free text, without what the summary and the parameters repeat. */
    description: string;
    params: DocParam[];
    returns?: string;
    throws: string[];
    /** Text of `@deprecated`; an empty string when it has none. */
    deprecated?: string;
    see: string[];
    examples: string[];
    /** Other `@tags` and sections, e.g. `@since`, `Notes:`. */
    other: Array<{ tag: string; text: string }>;
    /** Where an entry for a missing parameter is inserted (raw offset), and how. */
    insertion: { offset: number; style: 'section-entry' | 'section' | 'tag' | 'none-entry'; prefix: string; replaceEnd?: number };
}

interface Line {
    content: string;
    /** Raw offset where `content` starts. */
    offset: number;
    /** Raw offsets of the whole line, line break excluded. */
    lineStart: number;
    lineEnd: number;
}

/** The text lines of a comment with the comment markers removed. */
function contentLines(raw: string): { lines: Line[]; prefix: string; closeLine: number } {
    const lines: Line[] = [];
    const block = raw.startsWith('/*');
    let pos = 0;
    let prefix: string | undefined;
    let closeLine = -1;
    const rawLines = raw.split('\n');
    rawLines.forEach((text, index) => {
        const lineStart = pos;
        const lineEnd = pos + text.replace(/\r$/, '').length;
        pos += text.length + 1;
        let content = text.replace(/\r$/, '');
        let offset = lineStart;
        const skip = (n: number): void => {
            content = content.slice(n);
            offset += n;
        };
        if (block) {
            if (index === 0) {
                skip(content.indexOf('/*') + 2 + (content.startsWith('/**', content.indexOf('/*')) ? 1 : 0));
            } else {
                const m = /^\s*\*(?!\/)\s?/.exec(content) ?? /^\s*/.exec(content)!;
                // The prefix of the comment's lines (indentation, `*` and a blank), for inserted lines.
                if (prefix === undefined && m[0].includes('*')) prefix = m[0].endsWith(' ') ? m[0] : `${m[0]} `;
                skip(m[0].length);
            }
            const close = content.lastIndexOf('*/');
            if (close >= 0 && index === rawLines.length - 1) {
                content = content.slice(0, close);
                closeLine = index;
            }
        } else {
            const m = /^\s*--\s?/.exec(content);
            if (m) {
                if (prefix === undefined) prefix = m[0].endsWith(' ') ? m[0] : `${m[0]} `;
                skip(m[0].length);
            }
        }
        lines.push({ content: content.replace(/\s+$/, ''), offset, lineStart, lineEnd });
    });
    return { lines, prefix: prefix ?? (block ? ' * ' : '-- '), closeLine };
}

const SECTION = /^(Purpose|Summary|Explanation|Description|Details|Parameters|Params|Arguments|Returns|Return|Return value|Throws|Raises|Exceptions|Exception|Notes|Note|Example|Examples|Deprecated|See|See also)\s*:\s*(.*)$/i;

/** Marks where a repeated label starts a new segment of the explanation. */
const SEGMENT = '\u0000';

function sectionKey(label: string): string {
    const l = label.toLowerCase();
    if (l === 'purpose' || l === 'summary') return 'purpose';
    if (l === 'explanation' || l === 'description' || l === 'details') return 'explanation';
    if (l === 'parameters' || l === 'params' || l === 'arguments') return 'parameters';
    if (l.startsWith('return')) return 'returns';
    if (l === 'throws' || l === 'raises' || l.startsWith('exception')) return 'throws';
    if (l.startsWith('example')) return 'examples';
    if (l === 'deprecated') return 'deprecated';
    if (l.startsWith('see')) return 'see';
    return 'notes';
}

const TAG_KEY: Record<string, string> = {
    param: 'param', parameter: 'param', arg: 'param', argument: 'param',
    return: 'returns', returns: 'returns',
    throws: 'throws', throw: 'throws', exception: 'throws', raises: 'throws',
    deprecated: 'deprecated', see: 'see', example: 'examples'
};

/** `name (TYPE, MODE): text` → its parts; the type may hold parentheses. */
function parseEntryHead(content: string): { name: string; nameIndex: number; type?: string; mode?: string; rest: string } | null {
    // `- VARIADIC args (…)`: the mode may come first.
    const m = /^-\s*(?:(IN|OUT|INOUT|VARIADIC)\s+(?=["\w$]))?("(?:[^"]|"")+"|[\w$]+)/i.exec(content);
    if (!m) return null;
    const leadingMode = m[1]?.toUpperCase();
    const name = m[2].startsWith('"') ? m[2].slice(1, -1).replace(/""/g, '"') : m[2];
    let i = m[0].length;
    let type: string | undefined;
    let mode: string | undefined;
    const afterName = content.slice(i);
    const open = /^\s*\(/.exec(afterName);
    if (open) {
        let depth = 0;
        const start = i + open[0].length;
        let j = i + open[0].length - 1;
        for (; j < content.length; j++) {
            if (content[j] === '(') depth++;
            else if (content[j] === ')') {
                depth--;
                if (depth === 0) break;
            }
        }
        const inside = content.slice(start, j).trim();
        const comma = inside.lastIndexOf(',');
        const tail = comma >= 0 ? inside.slice(comma + 1).trim() : '';
        if (comma >= 0 && /^(in|out|inout|in out|variadic)$/i.test(tail)) {
            type = inside.slice(0, comma).trim();
            mode = tail.toUpperCase().replace(' ', '');
        } else if (/^(in|out|inout|variadic)$/i.test(inside)) {
            mode = inside.toUpperCase();
        } else {
            type = inside;
        }
        // `(IN VARCHAR, IN)`: a mode written in front of the type as well.
        if (type) type = type.replace(/^(in|out|inout|variadic)\s+(?=\S)/i, '').replace(/,\s*(optional|nullable)$/i, '');
        i = j + 1;
    }
    const rest = content.slice(i).replace(/^\s*[:\-–—]?\s*/, '');
    // `- VARIADIC (args anycompatiblearray, IN)`: the name went into the parentheses.
    const inner = /^(in|out|inout|variadic)$/i.test(name) && type ? /^("(?:[^"]|"")+"|[\w$]+)\s+(.+)$/.exec(type) : null;
    if (inner) {
        return { name: inner[1], nameIndex: content.indexOf(inner[1], m[0].length), type: inner[2], mode: name.toUpperCase(), rest };
    }
    return { name, nameIndex: content.indexOf(m[2]), type, mode: mode ?? leadingMode, rest };
}

/** Text that only repeats the entry's own head (`name (TYPE, IN):`) is dropped, as often as it is repeated. */
function stripRepeatedHead(text: string, name: string): string {
    const word = `(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|in|out|inout|variadic)`;
    const head = new RegExp(`^${word}\\s*(\\([^)]*(\\([^)]*\\)[^)]*)*\\))?\\s*:\\s*`, 'i');
    let t = text.trim();
    for (let guard = 0; guard < 5 && head.test(t); guard++) t = t.replace(head, '').trim();
    return t;
}

/** Remove labels a generator repeated, such as `Purpose: Purpose: …` or `Explanation: Purpose: …`. */
function stripLabels(text: string): string {
    return text.replace(/^(\s*(Purpose|Explanation|Summary|Description)\s*:\s*)+/i, '').trim();
}

/** The first sentence of a text, at most 200 characters; `i.e. no-op` does not end it. */
export function firstSentence(text: string): string {
    const t = text.replace(/\s+/g, ' ').trim();
    const m = /^(.+?[.!?])(?=\s+[A-Z0-9"'(]|$)/.exec(t);
    const s = m ? m[1] : t;
    return s.length > 200 ? `${s.slice(0, 197)}…` : s;
}

function joinText(parts: string[]): string {
    return parts.join('\n').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/([^\n])\n(?!\n)/g, '$1 ').replace(/\n{2,}/g, '\n\n').trim();
}

/**
 * Split running text at inline `@tags` and inline `Returns:` / `Parameters:`
 * labels, as written by generators into an explanation.
 */
function extractInline(text: string): { text: string; tags: Array<{ tag: string; text: string }>; returns?: string } {
    const tags: Array<{ tag: string; text: string }> = [];
    let returns: string | undefined;
    // Inline "Parameters: …" repeats the Parameters section; cut it.
    let body = text.replace(/\s+Parameters\s*:.*$/is, '');
    const inlineReturns = /(^|[.!?]\s+)Returns?\s*:\s*(.+?)(?=(\s+@\w+)|$)/is.exec(body);
    if (inlineReturns) {
        returns = inlineReturns[2].trim();
        body = body.slice(0, inlineReturns.index + inlineReturns[1].length).trim();
    }
    const firstTag = body.search(/(^|\s)@[a-z]+\b/i);
    if (firstTag >= 0) {
        const tagText = body.slice(firstTag);
        body = body.slice(0, firstTag).trim();
        for (const m of tagText.matchAll(/@([a-z]+)\b\s*([\s\S]*?)(?=\s@[a-z]+\b|$)/gi)) {
            tags.push({ tag: m[1].toLowerCase(), text: m[2].trim() });
        }
    }
    return { text: body.trim(), tags, returns };
}

/** Parse a doc comment as written above a CREATE statement, or a `COMMENT ON` text. */
export function parseDocComment(raw: string): DocComment {
    const { lines, prefix, closeLine } = contentLines(raw);
    const texts: Record<string, string[]> = { free: [], purpose: [], explanation: [], returns: [], throws: [], notes: [], examples: [], deprecated: [], see: [] };
    const sectionParams: DocParam[] = [];
    const tagParams: DocParam[] = [];
    const tags: Array<{ tag: string; text: string[] }> = [];
    let section = 'free';
    let current: { kind: 'param'; param: DocParam } | { kind: 'tag'; tag: { tag: string; text: string[] } } | null = null;
    let parametersHeaderEnd = -1;
    let noneEntry: { start: number; end: number } | null = null;
    let lastLineWithText = -1;

    lines.forEach((line, index) => {
        const content = line.content.trim();
        const lead = line.content.length - line.content.trimStart().length;
        if (content.length > 0 && index !== closeLine) lastLineWithText = index;
        if (content.length === 0) {
            current = null;
            if (section !== 'parameters') texts[section]?.push('');
            return;
        }
        const tag = /^@([a-z]+)\b\s*(.*)$/i.exec(content);
        if (tag) {
            const key = TAG_KEY[tag[1].toLowerCase()];
            if (key === 'param') {
                const pm = /^("(?:[^"]|"")+"|[\w$]+)\s*(.*)$/.exec(tag[2]);
                if (pm) {
                    const nameIndex = line.offset + lead + content.indexOf(pm[1], tag[0].length - tag[2].length);
                    const param: DocParam = {
                        name: pm[1].replace(/^"|"$/g, ''),
                        text: pm[2].replace(/^[-:]\s*/, ''),
                        style: 'tag',
                        nameStart: nameIndex,
                        nameEnd: nameIndex + pm[1].length,
                        lineStart: line.lineStart,
                        lineEnd: line.lineEnd,
                        ownsLines: true
                    };
                    tagParams.push(param);
                    current = { kind: 'param', param };
                }
                return;
            }
            const entry = { tag: key ?? tag[1].toLowerCase(), text: [tag[2]] };
            tags.push(entry);
            current = { kind: 'tag', tag: entry };
            section = 'free';
            return;
        }
        const header = SECTION.exec(content);
        if (header) {
            section = sectionKey(header[1]);
            current = null;
            if (section === 'parameters') {
                parametersHeaderEnd = line.lineEnd;
                if (header[2] && /^none\.?$/i.test(header[2].trim())) noneEntry = { start: line.lineStart, end: line.lineEnd };
            } else {
                // A repeated label starts a new segment, so repetitions can be told apart.
                if (section === 'explanation') texts.explanation.push(SEGMENT);
                if (header[2]) texts[section].push(header[2]);
            }
            return;
        }
        if (section === 'parameters') {
            if (/^-\s*none\.?$/i.test(content)) {
                noneEntry = { start: line.lineStart, end: line.lineEnd };
                return;
            }
            const head = content.startsWith('-') ? parseEntryHead(content) : null;
            if (head) {
                const nameStart = line.offset + lead + head.nameIndex;
                const param: DocParam = {
                    name: head.name,
                    type: head.type,
                    mode: head.mode,
                    text: head.rest,
                    style: 'section',
                    nameStart,
                    nameEnd: nameStart + head.name.length + (content[head.nameIndex] === '"' ? 2 : 0),
                    lineStart: line.lineStart,
                    lineEnd: line.lineEnd,
                    ownsLines: true
                };
                sectionParams.push(param);
                current = { kind: 'param', param };
                return;
            }
        }
        if (current?.kind === 'param') {
            current.param.text += ` ${content}`;
            current.param.lineEnd = line.lineEnd;
            return;
        }
        if (current?.kind === 'tag') {
            current.tag.text.push(content);
            return;
        }
        texts[section]?.push(content);
    });

    // Generators repeat labels and the purpose inside the explanation
    // (`Explanation: Purpose: X` then `Explanation: X, continued`): split at
    // every label and drop a segment that a later one, or the purpose, repeats.
    const purpose = stripLabels(joinText(texts.purpose));
    const segments = joinText(texts.explanation.map(stripLabels))
        .replace(/\s*\b(Explanation|Purpose)\s*:\s*/g, SEGMENT)
        .split(SEGMENT)
        .map(s => s.trim())
        .filter(s => s.length > 0);
    const key = (s: string): string => s.replace(/\s+/g, ' ').replace(/[.\s]+$/, '').toLowerCase();
    const kept = segments.filter((s, i) => !segments.slice(i + 1).some(later => key(later).startsWith(key(s)))
        && !(purpose && key(s) === key(purpose) && segments.length > 1));
    const explanation = extractInline(kept.join(' '));
    const free = extractInline(joinText(texts.free.map(stripLabels)));
    for (const t of [...explanation.tags, ...free.tags]) {
        if (TAG_KEY[t.tag] === 'param') {
            const pm = /^([\w$]+)\s*(.*)$/s.exec(t.text);
            if (pm && !tagParams.some(p => p.name.toLowerCase() === pm[1].toLowerCase())) {
                tagParams.push({ name: pm[1], text: pm[2].trim(), style: 'tag', nameStart: -1, nameEnd: -1, lineStart: -1, lineEnd: -1, ownsLines: false });
            }
        } else {
            tags.push({ tag: TAG_KEY[t.tag] ?? t.tag, text: [t.text] });
        }
    }

    // Merge: the tag's text wins, the section entry supplies type and mode.
    const params: DocParam[] = sectionParams.map(p => ({ ...p, text: stripRepeatedHead(p.text, p.name) }));
    for (const t of tagParams) {
        const existing = params.find(p => p.name.toLowerCase() === t.name.toLowerCase());
        const text = stripRepeatedHead(t.text, t.name);
        if (existing) {
            if (text) existing.text = text;
        } else {
            params.push({ ...t, text });
        }
    }

    const tagText = (key: string): string[] => tags.filter(t => t.tag === key).map(t => joinText(t.text));
    const returns = [joinText(texts.returns), ...tagText('returns'), explanation.returns ?? '', free.returns ?? ''].find(t => t.length > 0);
    const deprecatedTexts = [...tagText('deprecated'), joinText(texts.deprecated)];
    const isDeprecated = tags.some(t => t.tag === 'deprecated') || texts.deprecated.length > 0;

    let description = [explanation.text, free.text].filter(t => t.length > 0).join('\n\n');
    let summary: string;
    if (purpose && key(description).startsWith(key(purpose))) {
        // The description repeats the purpose, often in full where a generator cut the purpose short.
        summary = firstSentence(description);
        description = description.slice(description.indexOf(summary) + summary.length).trim();
    } else {
        summary = firstSentence(purpose || description);
        if (!purpose && description.startsWith(summary)) description = description.slice(summary.length).trim();
    }

    const lastSectionParam = sectionParams[sectionParams.length - 1];
    let insertion: DocComment['insertion'];
    if (noneEntry) {
        insertion = { offset: (noneEntry as { start: number; end: number }).start, replaceEnd: (noneEntry as { start: number; end: number }).end, style: 'none-entry', prefix };
    } else if (lastSectionParam) {
        insertion = { offset: lastSectionParam.lineEnd, style: 'section-entry', prefix };
    } else if (parametersHeaderEnd >= 0) {
        insertion = { offset: parametersHeaderEnd, style: 'section-entry', prefix };
    } else if (tagParams.some(p => p.ownsLines)) {
        insertion = { offset: tagParams.filter(p => p.ownsLines).slice(-1)[0].lineEnd, style: 'tag', prefix };
    } else {
        const after = lastLineWithText >= 0 ? lines[lastLineWithText].lineEnd : 0;
        insertion = { offset: after, style: 'section', prefix };
    }

    return {
        summary,
        description,
        params,
        returns,
        throws: [...tagText('throws'), joinText(texts.throws)].filter(t => t.length > 0),
        deprecated: isDeprecated ? deprecatedTexts.find(t => t.length > 0) ?? '' : undefined,
        see: [...tagText('see'), joinText(texts.see)].filter(t => t.length > 0),
        examples: [...tagText('examples'), joinText(texts.examples)].filter(t => t.length > 0),
        other: [
            ...tags.filter(t => !['returns', 'throws', 'deprecated', 'see', 'examples'].includes(t.tag)).map(t => ({ tag: t.tag, text: joinText(t.text) })),
            ...(texts.notes.length > 0 ? [{ tag: 'notes', text: joinText(texts.notes) }] : [])
        ],
        insertion
    };
}

/** The summary of the first doc comment among the repository definitions of an object. */
export function docSummary(definitions: ReadonlyArray<{ doc?: RepoDoc }> | undefined): string | undefined {
    const doc = definitions?.find(d => d.doc)?.doc;
    return doc ? parseDocComment(doc.text).summary || undefined : undefined;
}

/** The documentation of one parameter, matched case-insensitively. */
export function docForParam(doc: DocComment | undefined, name: string | null): DocParam | undefined {
    if (!doc || !name) return undefined;
    return doc.params.find(p => p.name.toLowerCase() === name.toLowerCase());
}

// ===== Template =====

function paramLine(p: RepoParam, prefix: string): string {
    return `${prefix}- ${p.name ?? '?'} (${p.type}, ${p.mode.toUpperCase()}): `;
}

/**
 * A doc comment in the repository's style for a function or procedure: Purpose,
 * Explanation, one Parameters entry per parameter in signature order, Returns.
 * With `snippet`, the texts to fill in are snippet placeholders.
 */
export function docCommentTemplate(def: Pick<RepoDefinition, 'kind' | 'params' | 'returns'>, indent: string, snippet: boolean): string {
    let tab = 0;
    const slot = (text = ''): string => (snippet ? `\${${++tab}${text ? `:${text.replace(/[$}\\]/g, '\\$&')}` : ''}}` : text);
    const esc = (text: string): string => (snippet ? text.replace(/[$}\\]/g, '\\$&') : text);
    const lines = ['/**', ` * Purpose: ${slot()}`, ' *', ` * Explanation: ${slot()}`, ' *', ' * Parameters:'];
    const params = def.params ?? [];
    if (params.length === 0) lines.push(' * - None');
    for (const p of params) lines.push(esc(paramLine(p, ' * ')) + slot());
    if (def.kind === 'function' && def.returns) {
        lines.push(' *', ` * Returns: ${slot(def.returns)}`);
    }
    lines.push(' */');
    return lines.map((l, i) => (i === 0 ? l : indent + l)).join('\n');
}

// ===== Checks =====

export type DocFindingCode = 'missingDoc' | 'unknownParam' | 'undocumentedParam' | 'typeMismatch';

export interface DocFinding {
    code: DocFindingCode;
    message: string;
    /** In the file: the parameter or the name in the signature, or the entry in the comment. */
    start: SourcePosition;
    end: SourcePosition;
    /** The parameter the finding is about. */
    param?: string;
}

/** The file position of an offset in a doc comment that starts at `start`. */
export function docPosition(raw: string, start: SourcePosition, offset: number): SourcePosition {
    const before = raw.slice(0, offset);
    const lines = before.split('\n');
    if (lines.length === 1) return { line: start.line, character: start.character + offset };
    return { line: start.line + lines.length - 1, character: lines[lines.length - 1].length };
}

/** Check the doc comment of a function or procedure against its signature. */
export function checkDocComment(def: RepoDefinition): DocFinding[] {
    if (def.kind !== 'function' && def.kind !== 'procedure') return [];
    const qualified = def.schema ? `${def.schema}.${def.name}` : def.name;
    if (!def.doc) {
        return [{ code: 'missingDoc', message: `${qualified} has no doc comment.`, start: def.start, end: def.end }];
    }
    const doc = parseDocComment(def.doc.text);
    const findings: DocFinding[] = [];
    const params = (def.params ?? []).filter(p => p.name);
    for (const entry of doc.params) {
        const param = params.find(p => p.name!.toLowerCase() === entry.name.toLowerCase());
        const at = entry.nameStart >= 0
            ? { start: docPosition(def.doc.text, def.doc.start, entry.nameStart), end: docPosition(def.doc.text, def.doc.start, entry.nameEnd) }
            : { start: def.doc.start, end: def.doc.end };
        if (!param) {
            findings.push({ code: 'unknownParam', message: `Documented parameter ${entry.name} does not exist in ${qualified}.`, param: entry.name, ...at });
        } else if (entry.type && /^[\w\s$."[\](),]+$/.test(entry.type) && normalizeTypeName(entry.type) !== '?'
            && normalizeTypeName(entry.type) !== normalizeTypeName(param.type)) {
            findings.push({ code: 'typeMismatch', message: `Documented type ${entry.type} of ${entry.name} differs from ${param.type}.`, param: entry.name, ...at });
        }
    }
    for (const param of params) {
        if (!docForParam(doc, param.name)) {
            findings.push({ code: 'undocumentedParam', message: `Parameter ${param.name} is not documented.`, param: param.name!, start: param.start, end: param.end });
        }
    }
    return findings;
}

/** Text that adds entries for the parameters a doc comment misses, in its own style; offsets refer to the raw comment. */
export function missingParamsEdit(def: RepoDefinition): { start: number; end: number; text: string } | undefined {
    if (!def.doc) return undefined;
    const doc = parseDocComment(def.doc.text);
    const missing = (def.params ?? []).filter(p => p.name && !docForParam(doc, p.name));
    if (missing.length === 0) return undefined;
    const { insertion } = doc;
    const prefix = insertion.prefix;
    const lines = missing.map(p => (insertion.style === 'tag' ? `${prefix}@param ${p.name} ` : paramLine(p, prefix)));
    const nl = def.doc.text.includes('\r\n') ? '\r\n' : '\n';
    if (insertion.style === 'none-entry') {
        return { start: insertion.offset, end: insertion.replaceEnd ?? insertion.offset, text: lines.join(nl) };
    }
    if (insertion.style === 'section') {
        return { start: insertion.offset, end: insertion.offset, text: `${nl}${prefix.trimEnd()}${nl}${prefix}Parameters:${nl}${lines.join(nl)}` };
    }
    return { start: insertion.offset, end: insertion.offset, text: `${nl}${lines.join(nl)}` };
}

/** The raw offsets of the lines of an entry, line break included, for removing it. */
export function entryRemoval(def: RepoDefinition, name: string): { start: number; end: number } | undefined {
    if (!def.doc) return undefined;
    const entry = parseDocComment(def.doc.text).params.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (!entry || !entry.ownsLines || entry.lineStart < 0) return undefined;
    const text = def.doc.text;
    const end = text.indexOf('\n', entry.lineEnd);
    return { start: entry.lineStart, end: end < 0 ? entry.lineEnd : end + 1 };
}
