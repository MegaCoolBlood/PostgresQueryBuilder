/**
 * What the SQL editor features answer, as plain data: the objects under the
 * cursor, their references across the repository, the symbols of a file, the
 * hover text, signature help, completion of the user's own routines, CodeLens
 * and diagnostics. `sqlLanguageFeatures.ts` turns the results into VS Code
 * objects; everything here can be tested without an editor.
 */
import {
    ROUTINE_KINDS,
    acceptsArgCount,
    dollarContent,
    normalizeTypeName,
    positionMapper,
    scanSqlText,
    tokenize,
    type ArgCount,
    type RepoDefinition,
    type RepoDoc,
    type RepoObjectKind,
    type RepoParam,
    type SourcePosition,
    type SqlComment
} from './repositoryScanner';
import { enclosingCall, referenceAt, referencesIn, RELATION_KINDS, type SqlReference } from './sqlReferences';
import { candidateSchemas, resolveReference, sameObject, type ResolutionSources, type ResolvedObject } from './sqlResolution';
import {
    argumentTypesMatch,
    databaseObjectStatus,
    routineStatus,
    type LocatedDefinition,
    type ObjectIdentity,
    type RepoStatus,
    type UnmarkedObjects
} from './repositoryComparison';
import {
    checkDocComment,
    docCommentTemplate,
    docForParam,
    docPosition,
    entryRemoval,
    missingParamsEdit,
    parseDocComment,
    type DocComment,
    type DocFinding
} from './docComments';
import type { DbEntry, DbObject } from './databaseCatalog';

export interface IntelSources extends ResolutionSources {
    /** The exact comparison of routine bodies (comments ignored); the fast hash alone when missing. */
    bodies?: { status(db: DbObject, definitions: readonly LocatedDefinition[]): RepoStatus } | null;
    /** Names of built-in and extension functions and of every type; null when not connected. */
    builtins?: { functions: Set<string>; types: Set<string> } | null;
    /** What extensions and PostgreSQL provide, which is never compared with the repository. */
    unmarked?: UnmarkedObjects | null;
    /** The schemas the catalog covers; a name in another schema is never reported unknown. */
    allowedSchema?: (schema: string) => boolean;
}

export interface FileRange {
    uri: string;
    start: SourcePosition;
    end: SourcePosition;
}

const RELATIONS = new Set<RepoObjectKind>(RELATION_KINDS);
const CALLABLE = new Set<RepoObjectKind>(['function', 'procedure', 'aggregate']);

export const KIND_LABELS: Record<RepoObjectKind, string> = {
    function: 'function', procedure: 'procedure', aggregate: 'aggregate', type: 'type', domain: 'domain',
    sequence: 'sequence', trigger: 'trigger', extension: 'extension', schema: 'schema',
    table: 'table', view: 'view', matview: 'materialized view', foreign: 'foreign table'
};

// ===== Doc comments =====

const parsedDocs = new WeakMap<RepoDoc, DocComment>();

/** The parsed doc comment, parsed once per scanned comment. */
export function parsedDoc(doc: RepoDoc | undefined): DocComment | undefined {
    if (!doc) return undefined;
    let parsed = parsedDocs.get(doc);
    if (!parsed) {
        parsed = parseDocComment(doc.text);
        parsedDocs.set(doc, parsed);
    }
    return parsed;
}

/** The doc comment of an object: the repository's, else the database comment read the same way. */
export function docOf(o: ResolvedObject): DocComment | undefined {
    const repo = parsedDoc(o.definitions.find(d => d.doc)?.doc);
    if (repo) return repo;
    const comment = o.db?.object?.comment;
    return comment ? parseDocComment(comment) : undefined;
}

// ===== Objects =====

/** Where the object exists; undefined when that is unknown (no repository, no connection) or never compared. */
export function objectStatus(o: ResolvedObject, sources: Pick<IntelSources, 'matcher' | 'db' | 'unmarked' | 'bodies'>): RepoStatus | undefined {
    if (!sources.matcher || !sources.db) return undefined;
    if (!o.db) return o.definitions.length > 0 ? 'repoOnly' : undefined;
    const object = o.db.object;
    if (object?.fromExtension || (object?.kind === 'extension' && object.name === 'plpgsql')) return undefined;
    if (o.kind === 'schema' && (sources.unmarked?.schema(o.name) || (o.name === 'public' && o.definitions.length === 0))) return undefined;
    if (o.db.relation && sources.unmarked?.relation(o.schema, o.name)) return undefined;
    if (o.kind !== 'schema' && o.kind !== 'extension' && sources.unmarked?.schema(o.schema)) return undefined;
    if (!object) return databaseObjectStatus(o.definitions);
    return sources.bodies ? sources.bodies.status(object, o.definitions) : routineStatus(object, o.definitions);
}

/** `schema.name`, or the name alone for schemas and extensions. */
export function qualifiedName(o: Pick<ResolvedObject, 'kind' | 'schema' | 'name'>): string {
    return o.schema && o.kind !== 'schema' && o.kind !== 'extension' ? `${o.schema}.${o.name}` : o.name;
}

/** The parameters of a routine, from the database when it has them, else from its CREATE statement. */
export function paramsOf(o: ResolvedObject): RepoParam[] {
    const fullArgs = o.db?.object?.fullArgs;
    if (fullArgs !== undefined && fullArgs !== null) return parseArgumentList(o.kind, fullArgs);
    return o.definitions.find(d => d.params)?.params ?? [];
}

/** The parameters a call passes: OUT parameters only for procedures (CALL passes them). */
export function callableParams(kind: RepoObjectKind, params: readonly RepoParam[]): RepoParam[] {
    return kind === 'procedure' ? [...params] : params.filter(p => p.mode !== 'out');
}

/** The result type of a function or aggregate. */
export function returnsOf(o: ResolvedObject): string | undefined {
    if (o.kind !== 'function' && o.kind !== 'aggregate') return undefined;
    return o.db?.object?.detail ?? o.definitions.find(d => d.returns)?.returns ?? undefined;
}

function argCountOf(o: ResolvedObject): ArgCount | undefined {
    return o.db?.argCount ?? o.definitions.find(d => d.argCount)?.argCount;
}

/** Parameters as `pg_get_function_arguments` writes them, read by the scanner. */
export function parseArgumentList(kind: RepoObjectKind, args: string): RepoParam[] {
    const create = kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION';
    const returns = kind === 'procedure' ? '' : ' RETURNS void';
    const defs = scanSqlText(`CREATE ${create} pqb_signature(${args})${returns} LANGUAGE sql AS $pqb$$pqb$;`);
    return defs[0]?.params ?? [];
}

function paramText(p: RepoParam): string {
    const mode = p.mode === 'in' ? '' : `${p.mode.toUpperCase()} `;
    const name = p.name ? `${p.name} ` : '';
    const def = p.defaultValue !== null ? ` DEFAULT ${p.defaultValue}` : '';
    return `${mode}${name}${p.type}${def}`;
}

/** The kind and qualified signature, e.g. `function leda.f_x(p_a integer) → text`. */
export function objectSignature(o: ResolvedObject): string {
    const name = qualifiedName(o);
    if (CALLABLE.has(o.kind)) {
        const args = o.db?.object?.fullArgs ?? (paramsOf(o).length > 0 || o.definitions.length > 0 ? paramsOf(o).map(paramText).join(', ') : o.db?.object?.args ?? '');
        const returns = returnsOf(o);
        return `${KIND_LABELS[o.kind]} ${name}(${args})${returns ? ` → ${returns}` : ''}`;
    }
    if (o.kind === 'trigger' && o.table) return `trigger ${o.name} on ${o.schema ? `${o.schema}.` : ''}${o.table}`;
    return `${KIND_LABELS[o.kind]} ${name}`;
}

/**
 * The tree node a command gets for the object, shaped like the nodes of the
 * Objects and Tables views, so every command that takes a node takes it.
 */
export function commandNode(o: ResolvedObject): Record<string, unknown> | undefined {
    if (o.kind === 'schema') return { type: 'schema', schema: o.name, definitions: [], status: o.db ? undefined : 'repoOnly' };
    if (RELATIONS.has(o.kind)) {
        return o.db ? { type: 'table', schema: o.schema, table: o.name, kind: o.kind } : { type: 'table', schema: o.schema, table: o.name, kind: o.kind, status: 'repoOnly', definitions: [] };
    }
    const object = o.db?.object;
    if (object) {
        return {
            type: 'object', kind: object.kind, schema: object.schema, name: object.name, args: object.args,
            db: { ...object, argCount: undefined }, definitions: []
        };
    }
    const def = o.definitions[0];
    if (!def) return undefined;
    const routine = ROUTINE_KINDS.has(o.kind);
    return {
        type: 'object', kind: o.kind, schema: o.schema, name: o.name,
        args: routine ? (def.argTypes ?? []).join(', ') : null,
        repoArgTypes: routine ? def.argTypes : undefined,
        repoTable: o.kind === 'trigger' ? o.table : undefined,
        status: 'repoOnly', definitions: []
    };
}

// ===== Under the cursor =====

/** The CREATE statement whose name the offset is on. */
function declarationAt(text: string, offset: number): RepoDefinition | undefined {
    const at = positionMapper(text)(offset);
    const before = (a: SourcePosition, b: SourcePosition): boolean => a.line < b.line || (a.line === b.line && a.character <= b.character);
    return scanSqlText(text).find(d => before(d.start, at) && before(at, d.end));
}

/** The object a CREATE statement of `uri` creates, with its database entry. */
export function declaredObject(def: RepoDefinition, uri: string, sources: ResolutionSources): ResolvedObject {
    const identity: ObjectIdentity = sources.matcher
        ? sources.matcher.identityOf(def)
        : {
            kind: def.kind,
            schema: def.kind === 'schema' || def.kind === 'extension' ? '' : (def.kind === 'trigger' ? def.table?.schema : def.schema) ?? def.searchPath?.[0] ?? sources.searchPath?.[0] ?? '',
            name: def.name,
            argTypes: def.argTypes,
            table: def.table?.name
        };
    let dbs: DbEntry[] = sources.db ? sources.db.lookup(identity.kind, identity.schema || null, identity.name) : [];
    if (identity.kind === 'trigger') dbs = dbs.filter(e => e.table === identity.table);
    if (ROUTINE_KINDS.has(identity.kind) && identity.argTypes) {
        dbs = dbs.filter(e => !e.object?.argTypes || argumentTypesMatch(identity.argTypes!, e.object.argTypes.map(normalizeTypeName)));
    }
    const definitions = sources.matcher?.find(identity) ?? [];
    if (!definitions.some(d => d.uri === uri && d.start.line === def.start.line && d.start.character === def.start.character)) {
        definitions.unshift({ ...def, uri });
    }
    return { kind: identity.kind, schema: identity.schema, name: identity.name, table: identity.table, definitions, db: dbs[0] };
}

export interface ObjectsAt {
    reference: SqlReference;
    objects: ResolvedObject[];
}

/** What the name under the cursor stands for: a reference, or the name of a CREATE statement. */
export function objectsAt(text: string, offset: number, uri: string, sources: ResolutionSources): ObjectsAt | undefined {
    const reference = referenceAt(text, offset);
    if (!reference) return undefined;
    if (reference.declaration && reference.kinds[0] !== 'schema') {
        const def = declarationAt(text, offset);
        if (def) return { reference, objects: [declaredObject(def, uri, sources)] };
    }
    return { reference, objects: resolveReference(reference, sources) };
}

/** The CREATE statements of the objects, by file and line, each once. */
export function definitionRanges(objects: readonly ResolvedObject[]): FileRange[] {
    const seen = new Set<string>();
    const out: FileRange[] = [];
    for (const def of objects.flatMap(o => o.definitions)) {
        const key = `${def.uri}#${def.start.line}:${def.start.character}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ uri: def.uri, start: def.start, end: def.end });
    }
    return out.sort((a, b) => a.uri.localeCompare(b.uri) || a.start.line - b.start.line);
}

// ===== References =====

/**
 * Every reference to one of `targets` in the files: the same kind group,
 * name and schema after resolution, and for routines the same overload.
 * With `includeDeclaration`, the CREATE statements of the targets come first.
 */
export function findReferences(
    targets: readonly ResolvedObject[],
    files: ReadonlyArray<{ uri: string; text: string }>,
    sources: ResolutionSources,
    includeDeclaration: boolean
): FileRange[] {
    const names = new Set(targets.map(t => t.name));
    const out: FileRange[] = includeDeclaration ? definitionRanges(targets) : [];
    const seen = new Set(out.map(r => `${r.uri}#${r.start.line}:${r.start.character}`));
    for (const file of files) {
        let position: ((offset: number) => SourcePosition) | undefined;
        for (const ref of referencesIn(file.text)) {
            if (ref.declaration || !names.has(ref.name)) continue;
            const resolved = resolveReference(ref, sources);
            if (!resolved.some(r => targets.some(t => sameObject(r, t)))) continue;
            position ??= positionMapper(file.text);
            const start = position(ref.nameStart);
            const key = `${file.uri}#${start.line}:${start.character}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ uri: file.uri, start, end: position(ref.nameEnd) });
        }
    }
    return out;
}

// ===== Symbols =====

export interface SymbolInfo {
    name: string;
    detail: string;
    kind: RepoObjectKind;
    /** The whole statement. */
    start: SourcePosition;
    end: SourcePosition;
    /** The name. */
    selectionStart: SourcePosition;
    selectionEnd: SourcePosition;
    /** The objects of a schema node, when the outline is grouped by schema. */
    children?: SymbolInfo[];
}

/** The schema an outline entry belongs to: a trigger goes with its table; schemas and extensions belong to none. */
function outlineSchema(def: RepoDefinition): string | null {
    if (def.kind === 'schema' || def.kind === 'extension') return null;
    return def.kind === 'trigger' ? def.table?.schema ?? null : def.schema;
}

function definitionLabel(def: RepoDefinition, omitSchema = false): string {
    const qualify = (schema: string | null | undefined) => (schema && !omitSchema ? `${schema}.` : '');
    const name = def.kind === 'trigger'
        ? `${def.name} on ${qualify(def.table?.schema)}${def.table?.name ?? ''}`
        : `${qualify(def.schema)}${def.name}`;
    if (!ROUTINE_KINDS.has(def.kind)) return name;
    const params = def.params ? callableParams(def.kind, def.params).map(paramText) : def.argTypes ?? [];
    return `${name}(${params.join(', ')})`;
}

function symbolOf(def: RepoDefinition, omitSchema = false): SymbolInfo {
    return {
        name: definitionLabel(def, omitSchema),
        detail: parsedDoc(def.doc)?.summary || KIND_LABELS[def.kind],
        kind: def.kind,
        start: def.statementStart ?? def.start,
        end: def.statementEnd ?? def.end,
        selectionStart: def.start,
        selectionEnd: def.end
    };
}

function comparePositions(a: SourcePosition, b: SourcePosition): number {
    return a.line - b.line || a.character - b.character;
}

export interface DocumentSymbolOptions {
    /**
     * Put the objects of each schema into a node of that schema. With a single
     * schema in the file the list stays flat and the schema is left out of the
     * names instead; unqualified objects stay at the top level.
     */
    groupBySchema?: boolean;
}

/** The CREATE statements of a file as outline entries, with the doc summary as detail. */
export function documentSymbols(text: string, options: DocumentSymbolOptions = {}): SymbolInfo[] {
    const defs = scanSqlText(text);
    if (!options.groupBySchema) return defs.map(def => symbolOf(def));
    // Schemas are folded to lower case unless quoted, so `Leda` and `leda` meet here.
    const schemas = new Set(defs.map(outlineSchema).filter((s): s is string => s !== null));
    if (schemas.size === 0) return defs.map(def => symbolOf(def));
    if (schemas.size === 1) return defs.map(def => symbolOf(def, outlineSchema(def) !== null));

    const out: SymbolInfo[] = [];
    const nodes = new Map<string, SymbolInfo>();
    const createSchema = new Map<string, RepoDefinition>();
    for (const def of defs) {
        if (def.kind === 'schema' && schemas.has(def.name) && !createSchema.has(def.name)) createSchema.set(def.name, def);
    }
    for (const def of defs) {
        const schema = def.kind === 'schema' && createSchema.get(def.name) === def ? def.name : outlineSchema(def);
        if (schema === null) {
            out.push(symbolOf(def));
            continue;
        }
        let node = nodes.get(schema);
        if (!node) {
            node = { ...symbolOf(def), name: schema, detail: '', kind: 'schema', children: [] };
            nodes.set(schema, node);
            out.push(node);
        }
        const symbol = symbolOf(def, true);
        if (def.kind === 'schema') {
            // The CREATE SCHEMA is the node itself: clicking the node goes there.
            node.selectionStart = symbol.selectionStart;
            node.selectionEnd = symbol.selectionEnd;
            node.detail = parsedDoc(def.doc)?.summary ?? '';
        } else {
            node.children!.push(symbol);
        }
        if (comparePositions(symbol.start, node.start) < 0) node.start = symbol.start;
        if (comparePositions(symbol.end, node.end) > 0) node.end = symbol.end;
    }
    for (const node of nodes.values()) {
        const count = node.children!.length;
        const objects = `${count} ${count === 1 ? 'object' : 'objects'}`;
        node.detail = node.detail ? `${node.detail} · ${objects}` : objects;
        if (!createSchema.has(node.name)) {
            node.selectionStart = node.children![0].selectionStart;
            node.selectionEnd = node.children![0].selectionEnd;
        }
    }
    return out;
}

/** True when every character of `query` appears in `text` in order. */
function fuzzyMatch(text: string, query: string): boolean {
    let i = 0;
    for (const ch of text) {
        if (ch === query[i]) i++;
        if (i === query.length) return true;
    }
    return query.length === 0;
}

/** The repository's definitions matching `query` for Go to Symbol in Workspace; closest matches first. */
export function workspaceSymbols(definitions: readonly LocatedDefinition[], query: string, limit = 500): Array<{ def: LocatedDefinition; name: string }> {
    const q = query.toLowerCase().replace(/\s+/g, '');
    const rank = (name: string): number => {
        const n = name.toLowerCase();
        if (n === q) return 0;
        if (n.startsWith(q)) return 1;
        if (n.includes(q)) return 2;
        return 3;
    };
    const found: Array<{ def: LocatedDefinition; name: string; rank: number }> = [];
    for (const def of definitions) {
        const qualified = def.schema ? `${def.schema}.${def.name}` : def.name;
        if (!fuzzyMatch(qualified.toLowerCase(), q)) continue;
        found.push({ def, name: definitionLabel(def), rank: Math.min(rank(def.name), rank(qualified) + 0.5) });
    }
    found.sort((a, b) => a.rank - b.rank || a.def.name.length - b.def.name.length || a.name.localeCompare(b.name));
    return found.slice(0, limit).map(({ def, name }) => ({ def, name }));
}

// ===== Hover =====

const STATUS_TEXT: Record<RepoStatus, string> = {
    both: 'In the database and in the repository',
    dbOnly: 'Only in the database — not found in the repository',
    repoOnly: 'Only in the repository — not in the database',
    differs: 'The definition in the database differs from the repository'
};

function escapeMarkdown(text: string): string {
    return text.replace(/([\\`*_{}[\]<>|#])/g, '\\$1');
}

function cell(text: string | undefined): string {
    return escapeMarkdown((text ?? '').replace(/\s*\n\s*/g, ' '));
}

/** A doc comment as Markdown: deprecation, summary, description, parameters, result, exceptions, links, examples. */
export function docMarkdown(doc: DocComment, params?: readonly RepoParam[]): string {
    const parts: string[] = [];
    if (doc.deprecated !== undefined) parts.push(`**~~Deprecated~~**${doc.deprecated ? ` ${escapeMarkdown(doc.deprecated)}` : ''}`);
    if (doc.summary) parts.push(escapeMarkdown(doc.summary));
    if (doc.description) parts.push(escapeMarkdown(doc.description));
    const rows = (params ?? []).filter(p => p.name).map(p => ({ name: p.name!, type: p.type, mode: p.mode.toUpperCase(), text: docForParam(doc, p.name)?.text }));
    for (const entry of doc.params) {
        if (!rows.some(r => r.name.toLowerCase() === entry.name.toLowerCase())) rows.push({ name: entry.name, type: entry.type ?? '', mode: entry.mode?.toUpperCase() ?? '', text: entry.text });
    }
    if (rows.length > 0) {
        parts.push(['| Parameter | Type | Mode | Description |', '| --- | --- | --- | --- |',
            ...rows.map(r => `| ${cell(r.name)} | ${cell(r.type)} | ${cell(r.mode)} | ${cell(r.text)} |`)].join('\n'));
    }
    if (doc.returns) parts.push(`**Returns:** ${escapeMarkdown(doc.returns)}`);
    for (const t of doc.throws) parts.push(`**Throws:** ${escapeMarkdown(t)}`);
    for (const s of doc.see) parts.push(`**See:** ${escapeMarkdown(s)}`);
    for (const o of doc.other) parts.push(`**${escapeMarkdown(o.tag.charAt(0).toUpperCase() + o.tag.slice(1))}:** ${escapeMarkdown(o.text)}`);
    for (const e of doc.examples) parts.push('```sql\n' + e.replace(/```/g, '`\u200b``') + '\n```');
    return parts.join('\n\n');
}

/** The commands a hover may link to; only these are trusted. */
export const HOVER_COMMANDS = [
    'postgresQueryBuilder.openCreateScript',
    'postgresQueryBuilder.compareWithDatabase',
    'postgresQueryBuilder.revealInObjectView',
    'postgresQueryBuilder.showDependencies'
] as const;

function commandLink(title: string, command: string, args: unknown[]): string {
    return `[${title}](command:${command}?${encodeURIComponent(JSON.stringify(args))})`;
}

export interface HoverInput {
    object: ResolvedObject;
    status?: RepoStatus;
    /** The first columns of a relation. */
    columns?: ReadonlyArray<{ name: string; type: string }>;
    /** Total number of columns, when more than `columns` exist. */
    columnCount?: number;
}

/** The hover of one object as Markdown. */
export function hoverMarkdown(input: HoverInput): string {
    const { object: o, status, columns } = input;
    const parts: string[] = ['```sql\n' + objectSignature(o) + '\n```'];
    const doc = docOf(o);
    const repoDoc = o.definitions.some(d => d.doc);
    if (doc) parts.push(docMarkdown(doc, CALLABLE.has(o.kind) ? paramsOf(o) : undefined));
    const db = o.db?.object;
    const comment = db?.comment?.trim();
    if (repoDoc && comment && comment !== doc?.summary && !o.definitions.some(d => d.doc?.text.includes(comment))) {
        parts.push(`**Database comment:** ${escapeMarkdown(comment)}`);
    }
    const facts: string[] = [];
    if (db?.language) facts.push(`Language: ${db.language}`);
    if (db?.owner) facts.push(`Owner: ${db.owner}`);
    if (db?.fromExtension) facts.push('Belongs to an extension');
    if (facts.length > 0) parts.push(facts.map(escapeMarkdown).join(' · '));
    if (columns && columns.length > 0) {
        const more = input.columnCount && input.columnCount > columns.length ? `\n\n… and ${input.columnCount - columns.length} more columns` : '';
        parts.push(['| Column | Type |', '| --- | --- |', ...columns.map(c => `| ${cell(c.name)} | ${cell(c.type)} |`)].join('\n') + more);
    }
    const footer: string[] = [];
    if (status) footer.push(`*${STATUS_TEXT[status]}*`);
    const node = commandNode(o);
    if (node) {
        const links: string[] = [];
        if (o.db && o.kind !== 'schema') links.push(commandLink('Open CREATE Script', 'postgresQueryBuilder.openCreateScript', [node]));
        if (o.db && o.definitions.length > 0 && o.kind !== 'schema' && o.kind !== 'extension') {
            links.push(commandLink('Compare with Database', 'postgresQueryBuilder.compareWithDatabase', [node]));
        }
        links.push(commandLink('Reveal in Objects View', 'postgresQueryBuilder.revealInObjectView', [node]));
        if (o.db) links.push(commandLink('Show Dependencies', 'postgresQueryBuilder.showDependencies', [node]));
        footer.push(links.join(' · '));
    }
    if (footer.length > 0) parts.push(footer.join('\n\n'));
    return parts.join('\n\n---\n\n');
}

// ===== Signature help =====

export interface SignatureInfo {
    label: string;
    /** Markdown. */
    documentation?: string;
    parameters: Array<{ label: [number, number]; documentation?: string }>;
    argCount?: ArgCount;
    /** Names of the parameters, for named notation. */
    names: Array<string | null>;
}

export interface SignatureHelpInfo {
    signatures: SignatureInfo[];
    activeSignature: number;
    activeParameter: number;
}

/** One overload as a signature: the parameters a call passes, with their documentation. */
export function signatureOf(o: ResolvedObject): SignatureInfo {
    const params = callableParams(o.kind, paramsOf(o));
    const doc = docOf(o);
    let label = `${qualifiedName(o)}(`;
    const parameters: SignatureInfo['parameters'] = [];
    params.forEach((p, i) => {
        if (i > 0) label += ', ';
        const text = paramText(p);
        const paramDoc = docForParam(doc, p.name);
        parameters.push(paramDoc?.text ? { label: [label.length, label.length + text.length], documentation: paramDoc.text } : { label: [label.length, label.length + text.length] });
        label += text;
    });
    label += ')';
    const returns = returnsOf(o);
    if (returns) label += ` → ${returns}`;
    const parts: string[] = [];
    if (doc?.deprecated !== undefined) parts.push(`**~~Deprecated~~**${doc.deprecated ? ` ${escapeMarkdown(doc.deprecated)}` : ''}`);
    if (doc?.summary) parts.push(escapeMarkdown(doc.summary));
    return { label, documentation: parts.length > 0 ? parts.join('\n\n') : undefined, parameters, argCount: argCountOf(o), names: params.map(p => p.name) };
}

/** The overloads of the call the cursor is in, the one that fits the arguments active. */
export function signatureHelpAt(text: string, offset: number, sources: ResolutionSources): SignatureHelpInfo | undefined {
    const call = enclosingCall(text, offset);
    if (!call) return undefined;
    const objects = resolveReference({ ...call.reference, argCount: null }, sources).filter(o => CALLABLE.has(o.kind));
    if (objects.length === 0) return undefined;
    const signatures = objects.map(signatureOf);
    const needed = Math.max(call.activeArgument + 1, call.reference.argCount ?? 0);
    let activeSignature = signatures.findIndex(s => acceptsArgCount(s.argCount, needed));
    if (activeSignature < 0) activeSignature = 0;
    const active = signatures[activeSignature];
    let activeParameter = call.activeArgument;
    if (call.activeName) {
        const named = active.names.findIndex(n => n?.toLowerCase() === call.activeName!.toLowerCase());
        if (named >= 0) activeParameter = named;
    } else if (active.argCount?.max === Infinity && activeParameter >= active.parameters.length) {
        activeParameter = active.parameters.length - 1;
    }
    return { signatures, activeSignature, activeParameter };
}

// ===== Completion =====

/** The opening tag of a dollar-quoted token and whether the token is closed. */
function dollarTag(text: string): { tag: string; closed: boolean } {
    const tag = /^\$[A-Za-z0-9_]*\$/.exec(text)?.[0] ?? '$$';
    return { tag, closed: text.length >= 2 * tag.length && text.endsWith(tag) };
}

/** A string, quoted name or dollar body still open at the end of the text — where the cursor is while typing it. */
function unclosed(tok: { type: string; text: string }): boolean {
    if (tok.type === 'string') return !(tok.text.length >= 2 && tok.text.endsWith("'"));
    if (tok.type === 'qident') return !(tok.text.length >= 2 && tok.text.endsWith('"'));
    if (tok.type === 'dollar') return !dollarTag(tok.text).closed;
    return false;
}

/** The innermost code around the offset — inside a `$$` body the body — or null in comments, strings and quoted names. */
export function codeAt(text: string, offset: number): { text: string; offset: number } | null {
    const comments: SqlComment[] = [];
    const toks = tokenize(text, comments);
    if (comments.some(c => c.start < offset && (offset < c.end || (!c.block && offset === c.end && !/\n$/.test(c.text))))) return null;
    const tok = toks.find(t => t.start < offset && (offset < t.end || (offset === t.end && unclosed(t))));
    if (!tok) return { text, offset };
    if (tok.type === 'dollar') {
        const { tag, closed } = dollarTag(tok.text);
        if (offset < tok.start + tag.length || (closed && offset > tok.end - tag.length)) return null;
        const inner = closed ? dollarContent(tok.text) : tok.text.slice(tag.length);
        if (inner === null) return null;
        return codeAt(inner, offset - tok.start - tag.length);
    }
    if (tok.type === 'string' || tok.type === 'qident') return null;
    return { text, offset };
}

export interface RoutineCompletion {
    object: ResolvedObject;
    label: string;
    /** The signature after the name, e.g. `(p_a integer)`. */
    labelDetail: string;
    /** Schema and result, e.g. `leda · → text`. */
    description: string;
    /** Snippet text. */
    insertText: string;
    /** Offsets of the text the item replaces. */
    replaceStart: number;
    replaceEnd: number;
    deprecated: boolean;
}

function snippetEscape(text: string): string {
    return text.replace(/[$}\\]/g, '\\$&');
}

/** The routines a call can name at the cursor: the user's functions after an expression start, procedures after CALL. */
export function routineCompletions(text: string, offset: number, sources: ResolutionSources): RoutineCompletion[] {
    const code = codeAt(text, offset);
    if (!code) return [];
    const before = code.text.slice(0, code.offset);
    const word = /[A-Za-z_][A-Za-z0-9_$]*$/.exec(before)?.[0] ?? '';
    const qualifier = /([A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*$/.exec(before.slice(0, before.length - word.length));
    const head = before.slice(0, before.length - word.length - (qualifier?.[0].length ?? 0));
    if (/[A-Za-z0-9_$."]$/.test(head)) return [];
    const previous = /([A-Za-z_]+)\s*$/.exec(head)?.[1]?.toLowerCase();
    const afterCall = previous === 'call';
    if (!word && !qualifier && !afterCall) return [];
    const schema = qualifier ? qualifier[1].toLowerCase() : null;
    const kinds = new Set<RepoObjectKind>(afterCall ? ['procedure'] : ['function', 'aggregate']);
    const path = new Set(candidateSchemas({ schema: null, searchPath: null, kinds: ['function'] }, sources.searchPath).filter((s): s is string => s !== null));
    const first = word.charAt(0).toLowerCase();
    const objects: ResolvedObject[] = [];
    const seen = new Set<LocatedDefinition>();
    if (sources.db) {
        for (const entry of sources.db.entries(kinds)) {
            if (entry.object?.fromExtension) continue;
            if (schema !== null ? entry.schema !== schema : first && !entry.name.startsWith(first)) continue;
            const definitions = sources.matcher && entry.object
                ? sources.matcher.find({ kind: entry.kind, schema: entry.schema, name: entry.name, argTypes: entry.object.argTypes })
                : [];
            definitions.forEach(d => seen.add(d));
            objects.push({ kind: entry.kind, schema: entry.schema, name: entry.name, definitions, db: entry });
        }
    }
    if (sources.matcher) {
        const repoOnly = new Map<string, ResolvedObject>();
        for (const { def, identity } of sources.matcher.entries()) {
            if (!kinds.has(identity.kind) || seen.has(def)) continue;
            if (sources.db && sources.db.lookup(identity.kind, identity.schema, identity.name).some(e =>
                !e.object?.argTypes || !identity.argTypes || argumentTypesMatch(identity.argTypes, e.object.argTypes.map(normalizeTypeName)))) continue;
            if (schema !== null ? identity.schema !== schema : first && !identity.name.startsWith(first)) continue;
            const key = `${identity.kind}:${identity.schema}.${identity.name}(${(identity.argTypes ?? []).join(',')})`;
            const existing = repoOnly.get(key);
            if (existing) existing.definitions.push(def);
            else repoOnly.set(key, { kind: identity.kind, schema: identity.schema, name: identity.name, definitions: [def] });
        }
        objects.push(...repoOnly.values());
    }
    const replaceStart = offset - word.length;
    return objects.map(o => {
        const params = callableParams(o.kind, paramsOf(o));
        const required = params.filter(p => p.defaultValue === null && p.mode !== 'variadic');
        const qualify = schema === null && path.size > 0 && !path.has(o.schema);
        const name = qualify ? `${o.schema}.${o.name}` : o.name;
        const args = required.map((p, i) => `\${${i + 1}:${snippetEscape(p.name ?? p.type)}}`).join(', ');
        const returns = returnsOf(o);
        return {
            object: o,
            label: o.name,
            labelDetail: `(${params.map(paramText).join(', ')})`,
            description: `${o.schema}${returns ? ` · → ${returns}` : ''}`,
            insertText: `${snippetEscape(name)}(${args})$0`,
            replaceStart,
            replaceEnd: offset,
            deprecated: docOf(o)?.deprecated !== undefined
        };
    });
}

export interface DocTemplate {
    /** Offsets of the `/**` (and of an auto-closed `*\/`) the template replaces. */
    replaceStart: number;
    replaceEnd: number;
    snippet: string;
}

/** The doc comment template offered after typing `/**` on the line above a CREATE FUNCTION or PROCEDURE. */
export function docTemplateAt(text: string, offset: number): DocTemplate | undefined {
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    const nl = text.indexOf('\n', offset);
    const lineEnd = nl < 0 ? text.length : nl;
    const head = /^([ \t]*)\/\*\*$/.exec(text.slice(lineStart, offset));
    if (!head || !/^\s*(\*\/)?\s*$/.test(text.slice(offset, lineEnd))) return undefined;
    const blanked = text.slice(0, lineStart) + ' '.repeat(lineEnd - lineStart) + text.slice(lineEnd);
    const line = text.slice(0, lineStart).split('\n').length - 1;
    const def = scanSqlText(blanked).find(d => (d.statementStart ?? d.start).line > line);
    if (!def || (def.kind !== 'function' && def.kind !== 'procedure')) return undefined;
    const startLine = (def.statementStart ?? def.start).line;
    const between = blanked.split('\n').slice(line + 1, startLine);
    if (between.some(l => l.trim() !== '')) return undefined;
    return { replaceStart: lineStart + head[1].length, replaceEnd: lineEnd, snippet: docCommentTemplate(def, head[1], true) };
}

// ===== CodeLens =====

export interface LensInfo {
    object: ResolvedObject;
    status: RepoStatus | undefined;
    start: SourcePosition;
    end: SourcePosition;
}

/** One entry per CREATE statement of the file, with where its object exists. */
export function codeLensesFor(text: string, uri: string, sources: IntelSources): LensInfo[] {
    if (!sources.db) return [];
    const out: LensInfo[] = [];
    for (const def of scanSqlText(text)) {
        const object = declaredObject(def, uri, sources);
        if (object.kind !== 'schema' && object.kind !== 'extension' && sources.allowedSchema && !sources.allowedSchema(object.schema)) continue;
        const status = objectStatus(object, sources) ?? (object.db ? undefined : sources.unmarked?.schema(object.schema) ? undefined : 'repoOnly');
        if (!status) continue;
        out.push({ object, status, start: def.statementStart ?? def.start, end: def.end });
    }
    return out;
}

// ===== Diagnostics =====

export interface CodeFinding {
    code: 'unknownRoutine' | 'argumentCount' | DocFinding['code'];
    message: string;
    start: SourcePosition;
    end: SourcePosition;
    param?: string;
}

/**
 * Calls of routines no one knows — not PostgreSQL, an extension, the
 * database or the repository — and calls whose argument count no overload
 * accepts. Only calls that are certainly calls of a routine are checked, and
 * only while connected, so the built-ins are known.
 */
export function routineFindings(text: string, sources: IntelSources): CodeFinding[] {
    const { db, builtins } = sources;
    if (!db || !builtins) return [];
    const out: CodeFinding[] = [];
    let position: ((offset: number) => SourcePosition) | undefined;
    for (const ref of referencesIn(text)) {
        if (!ref.call || ref.declaration || ref.argCount === null) continue;
        if (ref.kinds[0] !== 'function' && ref.kinds[0] !== 'procedure') continue;
        if (ref.schema !== null && (ref.schema === 'pg_catalog' || ref.schema === 'information_schema'
            || (sources.allowedSchema && !sources.allowedSchema(ref.schema)) || sources.unmarked?.schema(ref.schema))) continue;
        // `rec.method()` on a record or object variable: the qualifier is no schema anyone knows.
        if (ref.schema !== null && db.lookup('schema', null, ref.schema).length === 0
            && !(sources.matcher && sources.matcher.lookup('schema', null, ref.schema).length > 0)) continue;
        const what = ref.kinds[0] === 'procedure' ? 'procedure' : 'function';
        const name = ref.schema ? `${ref.schema}.${ref.name}` : ref.name;
        const resolved = resolveReference(ref, sources).filter(o => CALLABLE.has(o.kind));
        position ??= positionMapper(text);
        if (resolved.length === 0) {
            if (builtins.functions.has(ref.name) || builtins.types.has(ref.name)) continue;
            if (ref.schema === null && (db.hasName([...CALLABLE], ref.name)
                || (sources.matcher && [...CALLABLE].some(k => sources.matcher!.lookup(k, null, ref.name).length > 0)))) continue;
            out.push({ code: 'unknownRoutine', message: `Unknown ${what} ${name}: neither the database nor the repository has it.`, start: position(ref.start), end: position(ref.end) });
            continue;
        }
        const counts = resolved.map(argCountOf);
        // pg_catalog comes first in every search_path: a built-in of that name may be the one called.
        if (ref.schema === null && builtins.functions.has(ref.name)) continue;
        if (counts.every(c => c !== undefined) && !counts.some(c => acceptsArgCount(c, ref.argCount!))) {
            out.push({
                code: 'argumentCount',
                message: `No overload of ${name} takes ${ref.argCount} argument${ref.argCount === 1 ? '' : 's'}.`,
                start: position(ref.start),
                end: position(ref.end)
            });
        }
    }
    return out;
}

/** The doc comment checks of every function and procedure of the file. */
export function docFindings(text: string): CodeFinding[] {
    return scanSqlText(text).flatMap(def => checkDocComment(def));
}

// ===== Quick fixes =====

export interface TextEditInfo {
    start: SourcePosition;
    end: SourcePosition;
    text: string;
}

/** The CREATE statement a doc finding at `at` belongs to. */
export function definitionForFinding(text: string, at: SourcePosition): RepoDefinition | undefined {
    const inside = (s: SourcePosition, e: SourcePosition): boolean =>
        (s.line < at.line || (s.line === at.line && s.character <= at.character)) && (at.line < e.line || (at.line === e.line && at.character <= e.character));
    return scanSqlText(text).find(def =>
        inside(def.statementStart ?? def.start, def.statementEnd ?? def.end) || (def.doc && inside(def.doc.start, def.doc.end)));
}

/** Insert a doc comment template above the statement. */
export function addDocCommentEdit(text: string, def: RepoDefinition): TextEditInfo {
    const start = def.statementStart ?? def.start;
    const line = text.split('\n')[start.line] ?? '';
    const indent = /^[ \t]*/.exec(line)![0];
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    const at = { line: start.line, character: 0 };
    return { start: at, end: at, text: indent + docCommentTemplate(def, indent, false).replace(/\n/g, nl) + nl };
}

/** Add entries for the undocumented parameters, in the comment's style. */
export function addMissingParamsEdit(def: RepoDefinition): TextEditInfo | undefined {
    const edit = missingParamsEdit(def);
    if (!edit || !def.doc) return undefined;
    return { start: docPosition(def.doc.text, def.doc.start, edit.start), end: docPosition(def.doc.text, def.doc.start, edit.end), text: edit.text };
}

/** Remove the entry of a parameter the signature does not have. */
export function removeEntryEdit(def: RepoDefinition, name: string): TextEditInfo | undefined {
    const removal = entryRemoval(def, name);
    if (!removal || !def.doc) return undefined;
    return { start: docPosition(def.doc.text, def.doc.start, removal.start), end: docPosition(def.doc.text, def.doc.start, removal.end), text: '' };
}
