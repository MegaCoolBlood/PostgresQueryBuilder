/**
 * References to database objects in SQL code: which object a name under the
 * cursor stands for, every reference in a file, and the call the cursor is in.
 *
 * Pure: no `vscode`, no I/O. Works on the scanner's tokens, so comments and
 * strings never count — except the sequence name in `nextval('…')`. The
 * bodies of functions, procedures and DO blocks are read too, so calls inside
 * PL/pgSQL are found. What a name is follows from its context: `CALL p(…)` is
 * a procedure, `FROM t` a relation, `::t` a type, `INSERT INTO t (a)` no call.
 */
import { POSTGRES_RESERVED_KEYWORDS } from './reservedKeywords';
import {
    dollarContent,
    isPunct,
    isWord,
    matchingParen,
    readQualifiedName,
    searchPathOf,
    splitTopLevel,
    tokenize,
    type QualifiedName,
    type RepoObjectKind,
    type Tok
} from './repositoryScanner';

export const RELATION_KINDS: readonly RepoObjectKind[] = ['table', 'view', 'matview', 'foreign'];
const TYPE_KINDS: readonly RepoObjectKind[] = ['type', 'domain'];
const FALLBACK_KINDS: readonly RepoObjectKind[] = [...RELATION_KINDS, 'type', 'domain', 'sequence'];

export interface SqlReference {
    /** The kinds the name may stand for, most likely first. */
    kinds: RepoObjectKind[];
    /** As written: folded unless quoted; null when unqualified. */
    schema: string | null;
    name: string;
    /** Offsets of the name, without its schema. */
    nameStart: number;
    nameEnd: number;
    /** Offsets of the qualified name. */
    start: number;
    end: number;
    /** A call, `name(…)`. */
    call: boolean;
    /** Number of arguments of a call; null when not a call or not closed yet. */
    argCount: number | null;
    /** Names of the arguments passed in named notation (`p => 1`). */
    namedArgs?: string[];
    /** The name a CREATE statement gives; not a use. */
    declaration: boolean;
    /** The table of a trigger. */
    table?: { schema: string | null; name: string };
    /** The search_path set earlier in the file; null when there was none. */
    searchPath: string[] | null;
}

/** Words that are never the name of an object, besides the reserved keywords. */
const NOT_A_NAME = new Set([
    'if', 'elsif', 'elseif', 'loop', 'while', 'exit', 'continue', 'return', 'returns', 'raise', 'notice', 'exception',
    'perform', 'execute', 'declare', 'begin', 'language', 'plpgsql', 'sql', 'immutable', 'stable', 'volatile', 'security',
    'definer', 'invoker', 'strict', 'cost', 'rows', 'set', 'values', 'insert', 'update', 'delete', 'merge', 'conflict',
    'nothing', 'instead', 'also', 'exists', 'coalesce', 'nullif', 'greatest', 'least', 'row', 'over', 'partition', 'range',
    'filter', 'within', 'key', 'first', 'last', 'nulls', 'by', 'cascade', 'restrict', 'data', 'no', 'cycle', 'owner',
    'replace', 'temp', 'temporary', 'unlogged', 'found', 'sqlstate', 'sqlerrm', 'message', 'detail', 'hint', 'errcode',
    'open', 'close', 'cursor', 'next', 'prior', 'absolute', 'relative', 'query', 'get', 'diagnostics', 'stacked',
    'row_count', 'setof', 'out', 'inout', 'interval', 'zone', 'without', 'at', 'local', 'session', 'search_path', 'show',
    'reset', 'commit', 'rollback', 'savepoint', 'transaction', 'work', 'isolation', 'level', 'read', 'write', 'lock',
    'share', 'mode', 'nowait', 'skip', 'locked', 'each', 'statement', 'of', 'after', 'before', 'trigger', 'function',
    'procedure', 'enable', 'disable', 'alter', 'drop', 'add', 'rename', 'attach', 'detach', 'vacuum', 'explain',
    'listen', 'notify', 'comment', 'revoke', 'role', 'public', 'schema', 'sequence', 'type', 'domain', 'view',
    'materialized', 'index', 'match', 'partial', 'simple', 'action', 'generated', 'always', 'identity', 'stored',
    'inherits', 'tablespace', 'option', 'options', 'server', 'wrapper', 'owned', 'none', 'ordinality', 'tablesample',
    'repeatable', 'groups', 'unbounded', 'preceding', 'following', 'current', 'exclude', 'ties', 'others', 'prepare',
    'deallocate', 'call', 'assert', 'alias', 'constant', 'reverse', 'foreach', 'slice', 'debug', 'log', 'info',
    'warning', 'extension', 'aggregate', 'extract', 'substring', 'position', 'overlay', 'trim', 'include', 'grouping',
    'rollup', 'cube', 'sets', 'new', 'old', 'refresh', 'truncate', 'copy', 'format', 'importance', 'atomic', 'rowtype'
]);

/** A keyword in the place of a name. */
function isKeyword(t: Tok): boolean {
    return t.type === 'word' && (POSTGRES_RESERVED_KEYWORDS.has(t.value) || NOT_A_NAME.has(t.value));
}

function isIdentifier(t: Tok | undefined): t is Tok {
    return !!t && (t.type === 'word' || t.type === 'qident');
}

const KIND_WORD_KINDS: Record<string, RepoObjectKind[]> = {
    function: ['function', 'aggregate', 'procedure'],
    procedure: ['procedure', 'function'],
    routine: ['function', 'procedure', 'aggregate'],
    aggregate: ['aggregate', 'function'],
    type: ['type', 'domain'],
    domain: ['domain', 'type'],
    sequence: ['sequence'],
    trigger: ['trigger'],
    extension: ['extension'],
    schema: ['schema'],
    table: ['table', 'foreign', 'view', 'matview'],
    view: ['view', 'matview']
};

/** Kind words whose names the navigator does not know: the name after them is no reference. */
const OTHER_KIND_WORDS = new Set([
    'index', 'role', 'user', 'group', 'policy', 'rule', 'language', 'server', 'publication', 'subscription', 'statistics',
    'collation', 'conversion', 'operator', 'cast', 'column', 'constraint', 'database', 'tablespace', 'event', 'owned',
    'label', 'wrapper', 'mapping', 'family', 'class', 'method', 'transform', 'parser', 'dictionary', 'template',
    'configuration', 'savepoint', 'cursor', 'prepare', 'channel', 'variable', 'attribute'
]);

const CREATE_WORDS = new Set(['or', 'replace', 'temp', 'temporary', 'global', 'local', 'unlogged', 'recursive', 'constraint', 'materialized', 'foreign', 'trusted', 'procedural']);

/** Previous words after which a name is a relation. */
const RELATION_BEFORE = new Set(['from', 'join', 'into', 'update', 'only', 'references', 'truncate', 'lock', 'copy']);

/** Words before `(` that are no call. */
const NO_CALL_WORDS = new Set([...POSTGRES_RESERVED_KEYWORDS, ...NOT_A_NAME]);

const SEQUENCE_FUNCTIONS = new Set(['nextval', 'currval', 'setval']);

interface Statement {
    toks: Tok[];
    searchPath: string[] | null;
}

/** Offsets of a token list shifted by `base`. */
function shift(toks: Tok[], base: number): Tok[] {
    return base === 0 ? toks : toks.map(t => ({ ...t, start: t.start + base, end: t.end + base }));
}

/** The body of a dollar-quoted token, also while it is still being typed (no closing tag yet). */
function bodyOf(tok: Tok): { content: string; base: number } | null {
    const tag = /^\$[^$]*\$/.exec(tok.text)?.[0];
    if (!tag) return null;
    const content = dollarContent(tok.text) ?? tok.text.slice(tag.length);
    return { content, base: tok.start + tag.length };
}

/** Is the dollar-quoted token at `i` a routine or DO body (and not a string)? */
function isBody(toks: Tok[], i: number): boolean {
    const prev = toks[i - 1];
    if (isWord(prev, 'as') || isWord(prev, 'do')) return true;
    // DO LANGUAGE plpgsql $$ … $$
    return isIdentifier(prev) && isWord(toks[i - 2], 'language') && isWord(toks[0], 'do');
}

/** Every statement of a text and of the bodies inside it, each with the search_path in effect. */
function statements(text: string): Statement[] {
    const out: Statement[] = [];
    const walk = (toks: Tok[], searchPath: string[] | null): void => {
        for (const stmt of splitTopLevel(toks, t => isPunct(t, ';'))) {
            if (stmt.length === 0) continue;
            const set = searchPathOf(stmt);
            if (set !== undefined) {
                searchPath = set;
                continue;
            }
            out.push({ toks: stmt, searchPath });
            stmt.forEach((t, i) => {
                if (t.type !== 'dollar' || !isBody(stmt, i)) return;
                const body = bodyOf(t);
                if (body) walk(shift(tokenize(body.content), body.base), searchPath);
            });
        }
    };
    walk(tokenize(text), null);
    return out;
}

/** `'leda.seq_abw'` → its parts, as a regclass name is read. */
function regclassParts(value: string): string[] {
    const parts: string[] = [];
    let i = 0;
    while (i <= value.length) {
        if (value[i] === '"') {
            let j = i + 1;
            let part = '';
            while (j < value.length) {
                if (value[j] === '"' && value[j + 1] === '"') {
                    part += '"';
                    j += 2;
                } else if (value[j] === '"') {
                    break;
                } else {
                    part += value[j++];
                }
            }
            parts.push(part);
            i = j + 2;
        } else {
            const dot = value.indexOf('.', i);
            const end = dot < 0 ? value.length : dot;
            parts.push(value.slice(i, end).trim().toLowerCase());
            i = end + 1;
        }
    }
    return parts.filter(p => p.length > 0);
}

/** The table of a trigger: `… ON t` after the name, else the `ALTER TABLE t` of the statement. */
function triggerTable(stmt: Tok[], after: number): { schema: string | null; name: string } | undefined {
    for (let k = after; k < stmt.length; k++) {
        if (isWord(stmt[k], 'on')) {
            const qn = readQualifiedName(stmt, k + 1);
            if (qn) return splitParts(qn.parts);
            break;
        }
    }
    if (isWord(stmt[0], 'alter') && isWord(stmt[1], 'table')) {
        let k = 2;
        if (isWord(stmt[k], 'if') && isWord(stmt[k + 1], 'exists')) k += 2;
        if (isWord(stmt[k], 'only')) k++;
        const qn = readQualifiedName(stmt, k);
        if (qn) return splitParts(qn.parts);
    }
    return undefined;
}

function splitParts(parts: string[]): { schema: string | null; name: string } {
    return { schema: parts.length >= 2 ? parts[parts.length - 2] : null, name: parts[parts.length - 1] };
}

/** Number of arguments of the call whose `(` is at `open`; null while it is not closed. */
function callArguments(stmt: Tok[], open: number): { count: number | null; named: string[] } {
    const close = matchingParen(stmt, open);
    if (close < 0) return { count: null, named: [] };
    const inner = stmt.slice(open + 1, close);
    if (inner.length === 0) return { count: 0, named: [] };
    if (inner.length === 1 && inner[0].type === 'op' && inner[0].text === '*') return { count: 0, named: [] };
    const args = splitTopLevel(inner, t => isPunct(t, ','));
    const named = args
        .filter(a => isIdentifier(a[0]) && a[1]?.type === 'op' && (a[1].text === '=>' || a[1].text === ':='))
        .map(a => a[0].value);
    return { count: args.length, named };
}

interface Classified {
    kinds: RepoObjectKind[];
    call: boolean;
    declaration: boolean;
    table?: { schema: string | null; name: string };
}

/** What the qualified name starting at `i` stands for; null when it is no reference. */
function classify(stmt: Tok[], i: number, qn: QualifiedName): Classified | null {
    const first = stmt[i];
    if (qn.parts.length === 1 && isKeyword(first)) return null;
    const prev = stmt[i - 1];
    const next = stmt[qn.next];
    // The parameter name of named notation: f(p => 1).
    if (next?.type === 'op' && next.text === '=>') return null;
    const opens = isPunct(next, '(');

    // After a kind word: CREATE / ALTER / DROP / COMMENT ON <kind> [IF [NOT] EXISTS] name.
    let k = i - 1;
    if (isWord(stmt[k], 'exists')) {
        k--;
        if (isWord(stmt[k], 'not')) k--;
        if (isWord(stmt[k], 'if')) k--;
        else k = i - 1;
    }
    const kindTok = stmt[k];
    if (kindTok?.type === 'word' && OTHER_KIND_WORDS.has(kindTok.value) && k === i - 1) return null;
    if (kindTok?.type === 'word' && KIND_WORD_KINDS[kindTok.value]) {
        let kinds = KIND_WORD_KINDS[kindTok.value];
        let m = k - 1;
        if (kindTok.value === 'view' && isWord(stmt[m], 'materialized')) kinds = ['matview'];
        if (kindTok.value === 'table' && isWord(stmt[m], 'foreign')) kinds = ['foreign'];
        // CREATE TRIGGER … EXECUTE FUNCTION f(): a call.
        if ((kindTok.value === 'function' || kindTok.value === 'procedure') && isWord(stmt[m], 'execute')) {
            return { kinds: ['function'], call: opens, declaration: false };
        }
        while (stmt[m]?.type === 'word' && CREATE_WORDS.has(stmt[m].value)) m--;
        const declaration = isWord(stmt[m], 'create');
        if (kindTok.value === 'schema' && isWord(first, 'authorization')) return null;
        const result: Classified = { kinds: [...kinds], call: false, declaration };
        if (kindTok.value === 'trigger') result.table = triggerTable(stmt, qn.next);
        return result;
    }

    const prevWord = prev?.type === 'word' ? prev.value : '';
    // After AS: the type of CAST(x AS t) and CREATE DOMAIN d AS t; otherwise an alias.
    if (prevWord === 'as' && !isCastParen(stmt, i) && !(isWord(stmt[0], 'create') && isWord(stmt[1], 'domain'))) return null;
    const onIsRelation = prevWord === 'on' && ['create', 'grant', 'revoke', 'comment', 'alter', 'drop', 'security'].includes(stmt[0]?.value ?? '');
    const usingIsRelation = prevWord === 'using' && ['delete', 'merge'].includes(stmt[0]?.value ?? '');
    const typeContext = (prev?.type === 'op' && prev.text === '::')
        || prevWord === 'returns' || prevWord === 'setof'
        || (prevWord === 'as' && (isCastParen(stmt, i) || isWord(stmt[1], 'domain')))
        // `p_id integer`, `v_x leda_types.t;`, a column definition: a name after a name is a type.
        || (isIdentifier(prev) && !isKeyword(prev) && !isPunct(stmt[i - 2], '.'));
    const rowType = next?.type === 'op' && next.text === '%' && isWord(stmt[qn.next + 1], 'rowtype');

    if (opens) {
        if (prevWord === 'into' || prevWord === 'references' || onIsRelation) {
            return { kinds: [...RELATION_KINDS], call: false, declaration: false };
        }
        if (typeContext) return { kinds: [...TYPE_KINDS], call: false, declaration: false };
        if (qn.parts.length === 1 && first.type === 'word' && NO_CALL_WORDS.has(first.value)) return null;
        // The access method of CREATE INDEX … USING btree (…) or EXCLUDE USING gist (…).
        if (prevWord === 'using' && stmt.slice(0, i).some(t => isWord(t, 'index') || isWord(t, 'exclude'))) return null;
        // A cursor with arguments: OPEN cu(…), FOR r IN cu(…) LOOP.
        if (prevWord === 'open' || prevWord === 'in') return null;
        const kinds: RepoObjectKind[] = prevWord === 'call' ? ['procedure', 'function'] : ['function', 'aggregate', 'procedure'];
        return { kinds, call: true, declaration: false };
    }
    if (rowType) return { kinds: [...RELATION_KINDS, ...TYPE_KINDS], call: false, declaration: false };
    if (RELATION_BEFORE.has(prevWord) || onIsRelation || usingIsRelation) {
        return { kinds: [...RELATION_KINDS], call: false, declaration: false };
    }
    if (typeContext) {
        const kinds: RepoObjectKind[] = prevWord === 'returns' || prevWord === 'setof' ? [...TYPE_KINDS, ...RELATION_KINDS] : [...TYPE_KINDS];
        return { kinds, call: false, declaration: false };
    }
    return { kinds: [...FALLBACK_KINDS], call: false, declaration: false };
}

/** Is the name at `i` the type of `CAST(x AS type)`? */
function isCastParen(stmt: Tok[], i: number): boolean {
    let depth = 0;
    for (let k = i - 1; k >= 0; k--) {
        if (isPunct(stmt[k], ')')) depth++;
        else if (isPunct(stmt[k], '(')) {
            if (depth === 0) return isWord(stmt[k - 1], 'cast');
            depth--;
        }
    }
    return false;
}

/** The start index of the qualified name that the token at `i` is part of. */
function nameStartIndex(stmt: Tok[], i: number): number {
    let j = i;
    while (isPunct(stmt[j - 1], '.') && isIdentifier(stmt[j - 2])) j -= 2;
    return j;
}

/**
 * The reference made by the qualified name starting at `i`, for the part at
 * `partIndex` (default: the object part). A three-part name `s.t.c` refers to
 * relation `s.t`; the schema part refers to the schema.
 */
function referenceFor(stmt: Tok[], i: number, searchPath: string[] | null, partIndex?: number): SqlReference | null {
    const qn = readQualifiedName(stmt, i);
    if (!qn) return null;
    const tokens: Tok[] = [];
    for (let k = i; k < qn.next; k += 2) tokens.push(stmt[k]);
    const count = qn.parts.length;
    if (count > 3) return null;
    const objectPart = count === 3 ? 1 : count - 1;
    const part = partIndex ?? objectPart;
    if (part < objectPart) {
        // The schema part.
        return {
            kinds: ['schema'], schema: null, name: qn.parts[part], nameStart: tokens[part].start, nameEnd: tokens[part].end,
            start: tokens[part].start, end: tokens[part].end, call: false, argCount: null, declaration: false, searchPath
        };
    }
    if (part > objectPart) return null;
    let classified: Classified | null;
    if (count === 3) {
        classified = { kinds: [...RELATION_KINDS], call: false, declaration: false };
    } else {
        classified = classify(stmt, i, qn);
    }
    if (!classified) return null;
    const ref: SqlReference = {
        kinds: classified.kinds,
        schema: objectPart > 0 ? qn.parts[objectPart - 1] : null,
        name: qn.parts[objectPart],
        nameStart: tokens[objectPart].start,
        nameEnd: tokens[objectPart].end,
        start: tokens[0].start,
        end: tokens[objectPart].end,
        call: classified.call,
        argCount: null,
        declaration: classified.declaration,
        searchPath
    };
    if (classified.table) ref.table = classified.table;
    if (classified.call) {
        const args = callArguments(stmt, qn.next);
        ref.argCount = args.count;
        if (args.named.length > 0) ref.namedArgs = args.named;
    }
    return ref;
}

/** The sequence a `nextval('…')`, `currval` or `setval` string at `i` names. */
function sequenceReference(stmt: Tok[], i: number, searchPath: string[] | null): SqlReference | null {
    const t = stmt[i];
    if (t.type !== 'string' || !isPunct(stmt[i - 1], '(') || stmt[i - 2]?.type !== 'word' || !SEQUENCE_FUNCTIONS.has(stmt[i - 2].value)) return null;
    const parts = regclassParts(t.value);
    if (parts.length === 0 || parts.length > 2) return null;
    const name = parts[parts.length - 1];
    const inner = t.text.slice(1, -1);
    const at = inner.toLowerCase().lastIndexOf(name.toLowerCase());
    const nameStart = t.start + 1 + Math.max(0, at);
    return {
        kinds: ['sequence'], schema: parts.length === 2 ? parts[0] : null, name,
        nameStart, nameEnd: nameStart + name.length, start: t.start + 1, end: t.end - 1,
        call: false, argCount: null, declaration: false, searchPath
    };
}

/** Every reference in a text — in statements and in the bodies of routines and DO blocks. */
export function referencesIn(text: string): SqlReference[] {
    const out: SqlReference[] = [];
    for (const { toks, searchPath } of statements(text)) {
        for (let i = 0; i < toks.length; i++) {
            const t = toks[i];
            if (t.type === 'string') {
                const seq = sequenceReference(toks, i, searchPath);
                if (seq) out.push(seq);
                continue;
            }
            if (!isIdentifier(t) || (isPunct(toks[i - 1], '.') && isIdentifier(toks[i - 2]))) continue;
            const ref = referenceFor(toks, i, searchPath);
            if (ref) out.push(ref);
        }
    }
    return out;
}

/** The statement (of the text or of a body) whose tokens cover `offset`. */
function statementAt(text: string, offset: number): Statement | undefined {
    let found: Statement | undefined;
    for (const stmt of statements(text)) {
        const first = stmt.toks[0];
        const last = stmt.toks[stmt.toks.length - 1];
        // Bodies come after their statement, so the innermost one wins.
        if (first.start <= offset && offset <= last.end) found = stmt;
    }
    return found;
}

/** The reference under the cursor; undefined in comments, strings and keywords. */
export function referenceAt(text: string, offset: number): SqlReference | undefined {
    const stmt = statementAt(text, offset);
    if (!stmt) return undefined;
    const toks = stmt.toks;
    const i = toks.findIndex(t => t.start <= offset && offset <= t.end && t.type !== 'punct' && t.type !== 'op');
    if (i < 0) return undefined;
    if (toks[i].type === 'string') return sequenceReference(toks, i, stmt.searchPath) ?? undefined;
    if (!isIdentifier(toks[i])) return undefined;
    const start = nameStartIndex(toks, i);
    return referenceFor(toks, start, stmt.searchPath, (i - start) / 2) ?? undefined;
}

export interface EnclosingCall {
    reference: SqlReference;
    /** 0-based index of the argument the cursor is in. */
    activeArgument: number;
    /** The name of that argument in named notation, if it is written so. */
    activeName?: string;
}

/** The call whose argument list the cursor is in, innermost first; strings and comments are skipped. */
export function enclosingCall(text: string, offset: number): EnclosingCall | undefined {
    const stmt = statementAt(text, offset) ?? lastStatementBefore(text, offset);
    if (!stmt) return undefined;
    const toks = stmt.toks;
    const open: number[] = [];
    for (let k = 0; k < toks.length && toks[k].start < offset; k++) {
        if (isPunct(toks[k], '(')) open.push(k);
        else if (isPunct(toks[k], ')') && toks[k].end <= offset) open.pop();
    }
    while (open.length > 0) {
        const paren = open.pop()!;
        if (!isIdentifier(toks[paren - 1])) continue;
        const start = nameStartIndex(toks, paren - 1);
        const ref = referenceFor(toks, start, stmt.searchPath);
        if (!ref || !ref.call) continue;
        let depth = 0;
        let index = 0;
        let argStart = paren + 1;
        for (let k = paren + 1; k < toks.length && toks[k].start < offset; k++) {
            if (isPunct(toks[k], '(')) depth++;
            else if (isPunct(toks[k], ')')) depth--;
            else if (depth === 0 && isPunct(toks[k], ',')) {
                index++;
                argStart = k + 1;
            }
        }
        const head = toks[argStart];
        const arrow = toks[argStart + 1];
        const activeName = isIdentifier(head) && arrow?.type === 'op' && (arrow.text === '=>' || arrow.text === ':=') && arrow.end <= offset
            ? head.value : undefined;
        return activeName ? { reference: ref, activeArgument: index, activeName } : { reference: ref, activeArgument: index };
    }
    return undefined;
}

/** While typing past the end of the last statement (`f(` not yet closed). */
function lastStatementBefore(text: string, offset: number): Statement | undefined {
    let found: Statement | undefined;
    for (const stmt of statements(text)) {
        if (stmt.toks[0].start <= offset) found = stmt;
    }
    return found;
}
