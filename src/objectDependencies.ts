/**
 * The Dependencies view: what uses an object and what it uses, read from
 * `pg_depend`, and — because PostgreSQL does not record what PL/pgSQL bodies
 * call — where the repository refers to it.
 *
 * Rows of `pg_depend` that belong to a part of an object are shown as the
 * object: a view's rewrite rule as the view, a column default or a constraint
 * as its table, a row type as its table, an array type as its element type.
 * Internal and extension dependencies, indexes, schemas and languages are left
 * out; system objects too.
 */
import * as vscode from 'vscode';
import type { FileRange } from './sqlCodeIntel';
import { Logger, getErrorMessage } from './logger';
import { CLICK_ARGUMENT } from './objectNavigator';

export type DependencyClass = 'pg_proc' | 'pg_type' | 'pg_class' | 'pg_trigger' | 'pg_extension' | 'pg_namespace';

/** An object of the database as `pg_depend` names it. */
export interface DependencyTarget {
    classid: DependencyClass | string;
    oid: number;
}

export type DependencyDirection = 'usedBy' | 'uses';

export interface DependencyRow {
    classid: string;
    oid: number;
    /** `pg_identify_object` type, e.g. `function`, `view`, `table`, `trigger`. */
    type: string;
    schema: string | null;
    /** Readable identity, e.g. `leda.f_x(integer)` or `trg_x on leda.t`. */
    identity: string;
    /** For relations and sequences: the unquoted name and `relkind`. */
    relName: string | null;
    relKind: string | null;
}

/** The catalog table of each object kind of the views. */
export const KIND_CLASS: Record<string, DependencyClass> = {
    function: 'pg_proc', procedure: 'pg_proc', aggregate: 'pg_proc',
    type: 'pg_type', domain: 'pg_type',
    sequence: 'pg_class', table: 'pg_class', view: 'pg_class', matview: 'pg_class', foreign: 'pg_class',
    trigger: 'pg_trigger', extension: 'pg_extension', schema: 'pg_namespace'
};

/** Looks up the oid of a relation or schema of the database by name. */
export const RELATION_OID_QUERY =
    `SELECT c.oid::bigint AS oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2`;
export const SCHEMA_OID_QUERY = 'SELECT n.oid::bigint AS oid FROM pg_catalog.pg_namespace n WHERE n.nspname = $1';

const MAPPED = `
mapped AS (
    SELECT DISTINCT
        CASE
            WHEN r.classid IN ('pg_catalog.pg_rewrite'::regclass, 'pg_catalog.pg_attrdef'::regclass) THEN 'pg_catalog.pg_class'::regclass::oid
            WHEN r.classid = 'pg_catalog.pg_constraint'::regclass AND con.conrelid <> 0 THEN 'pg_catalog.pg_class'::regclass::oid
            WHEN r.classid = 'pg_catalog.pg_constraint'::regclass AND con.contypid <> 0 THEN 'pg_catalog.pg_type'::regclass::oid
            WHEN r.classid = 'pg_catalog.pg_type'::regclass AND t.typrelid <> 0 AND rel.relkind <> 'c' THEN 'pg_catalog.pg_class'::regclass::oid
            ELSE r.classid
        END AS classid,
        CASE
            WHEN r.classid = 'pg_catalog.pg_rewrite'::regclass THEN rw.ev_class
            WHEN r.classid = 'pg_catalog.pg_attrdef'::regclass THEN ad.adrelid
            WHEN r.classid = 'pg_catalog.pg_constraint'::regclass AND con.conrelid <> 0 THEN con.conrelid
            WHEN r.classid = 'pg_catalog.pg_constraint'::regclass AND con.contypid <> 0 THEN con.contypid
            WHEN r.classid = 'pg_catalog.pg_type'::regclass AND t.typrelid <> 0 AND rel.relkind <> 'c' THEN t.typrelid
            WHEN r.classid = 'pg_catalog.pg_type'::regclass AND t.typcategory = 'A' AND t.typelem <> 0 THEN t.typelem
            ELSE r.objid
        END AS objid
    FROM raw r
    LEFT JOIN pg_catalog.pg_rewrite rw ON r.classid = 'pg_catalog.pg_rewrite'::regclass AND rw.oid = r.objid
    LEFT JOIN pg_catalog.pg_attrdef ad ON r.classid = 'pg_catalog.pg_attrdef'::regclass AND ad.oid = r.objid
    LEFT JOIN pg_catalog.pg_constraint con ON r.classid = 'pg_catalog.pg_constraint'::regclass AND con.oid = r.objid
    LEFT JOIN pg_catalog.pg_type t ON r.classid = 'pg_catalog.pg_type'::regclass AND t.oid = r.objid
    LEFT JOIN pg_catalog.pg_class rel ON rel.oid = t.typrelid
)
SELECT m.classid::regclass::text AS class_name, m.objid::bigint AS oid,
       o.type AS object_type, o.schema AS object_schema, o.identity AS object_identity,
       rc.relname::text AS rel_name, rc.relkind::text AS rel_kind
FROM mapped m
CROSS JOIN LATERAL pg_catalog.pg_identify_object(m.classid, m.objid, 0) o
LEFT JOIN pg_catalog.pg_class rc ON m.classid = 'pg_catalog.pg_class'::regclass AND rc.oid = m.objid
WHERE NOT (m.classid = $1::regclass::oid AND m.objid = $2::oid)
  AND COALESCE(o.schema, '') NOT IN ('pg_catalog', 'information_schema')
  AND o.type NOT IN ('index', 'toast table', 'schema', 'language', 'access method', 'extension')
ORDER BY o.type, o.identity
LIMIT 1000`;

/**
 * The objects that depend on `$1`/`$2` (catalog table, oid). For a relation
 * the dependents of its row type count too.
 */
export const USED_BY_QUERY = `WITH target(classid, objid) AS (
    SELECT $1::regclass::oid, $2::oid
    UNION ALL
    SELECT 'pg_catalog.pg_type'::regclass::oid, c.reltype FROM pg_catalog.pg_class c
    WHERE $1::regclass = 'pg_catalog.pg_class'::regclass AND c.oid = $2::oid AND c.reltype <> 0
), raw AS (
    SELECT d.classid, d.objid FROM pg_catalog.pg_depend d
    JOIN target ON d.refclassid = target.classid AND d.refobjid = target.objid
    WHERE d.deptype IN ('n', 'a')
),${MAPPED}`;

/**
 * The objects `$1`/`$2` depends on. A relation depends through its rewrite
 * rules, column defaults, constraints and triggers; a domain through its constraints.
 */
export const USES_QUERY = `WITH src(classid, objid) AS (
    SELECT $1::regclass::oid, $2::oid
    UNION ALL
    SELECT 'pg_catalog.pg_rewrite'::regclass::oid, rw.oid FROM pg_catalog.pg_rewrite rw
    WHERE $1::regclass = 'pg_catalog.pg_class'::regclass AND rw.ev_class = $2::oid
    UNION ALL
    SELECT 'pg_catalog.pg_attrdef'::regclass::oid, ad.oid FROM pg_catalog.pg_attrdef ad
    WHERE $1::regclass = 'pg_catalog.pg_class'::regclass AND ad.adrelid = $2::oid
    UNION ALL
    SELECT 'pg_catalog.pg_constraint'::regclass::oid, con.oid FROM pg_catalog.pg_constraint con
    WHERE ($1::regclass = 'pg_catalog.pg_class'::regclass AND con.conrelid = $2::oid)
       OR ($1::regclass = 'pg_catalog.pg_type'::regclass AND con.contypid = $2::oid)
    UNION ALL
    SELECT 'pg_catalog.pg_trigger'::regclass::oid, tg.oid FROM pg_catalog.pg_trigger tg
    WHERE $1::regclass = 'pg_catalog.pg_class'::regclass AND tg.tgrelid = $2::oid AND NOT tg.tgisinternal
), raw AS (
    SELECT d.refclassid AS classid, d.refobjid AS objid FROM pg_catalog.pg_depend d
    JOIN src ON d.classid = src.classid AND d.objid = src.objid
    WHERE d.deptype IN ('n', 'a')
),${MAPPED}`;

/** One result row as a {@link DependencyRow}; the class without its `pg_catalog.` prefix. */
export function toDependencyRow(row: Record<string, unknown>): DependencyRow {
    const text = (key: string): string | null => (row[key] === null || row[key] === undefined ? null : String(row[key]));
    return {
        classid: String(row.class_name).replace(/^pg_catalog\./, ''),
        oid: Number(row.oid),
        type: String(row.object_type),
        schema: text('object_schema'),
        identity: String(row.object_identity),
        relName: text('rel_name'),
        relKind: text('rel_kind')
    };
}

/** The view kind of a `pg_class` row; undefined for kinds the views do not list. */
export function relationKindOf(relKind: string | null): 'table' | 'view' | 'matview' | 'foreign' | 'sequence' | undefined {
    switch (relKind) {
        case 'r':
        case 'p':
            return 'table';
        case 'v':
            return 'view';
        case 'm':
            return 'matview';
        case 'f':
            return 'foreign';
        case 'S':
            return 'sequence';
        default:
            return undefined;
    }
}

const TYPE_ICONS: Record<string, string> = {
    function: 'symbol-function', procedure: 'symbol-method', aggregate: 'symbol-operator',
    type: 'symbol-class', domain: 'symbol-type-parameter', sequence: 'symbol-number', trigger: 'zap',
    table: 'table', view: 'eye', 'materialized view': 'layers', 'foreign table': 'link-external',
    'composite type': 'symbol-structure', policy: 'shield'
};

// ===== Tree =====

/** A node of the Objects or Tables view, as the commands take it. */
export type ViewNode = { type: string; [key: string]: unknown };

export interface DependencyRoot {
    target: DependencyTarget;
    /** Label of the root, e.g. `function leda.f_x(integer)`. */
    title: string;
    icon: string;
    node?: ViewNode;
    /** Where the repository refers to the object; undefined when there is no repository to search. */
    usages?: () => Promise<FileRange[]>;
}

export interface DependencyRootNode { type: 'dependencyRoot'; root: DependencyRoot }
export interface DependencyGroupNode { type: 'dependencyGroup'; direction: DependencyDirection; target: DependencyTarget; path: string[] }
export interface DependencyItemNode { type: 'dependency'; direction: DependencyDirection; row: DependencyRow; node?: ViewNode; path: string[] }
export interface DependencyRepoNode { type: 'dependencyRepo'; locations: FileRange[] }
export interface DependencyLocationNode { type: 'dependencyLocation'; location: FileRange }
export interface DependencyMessageNode { type: 'dependencyMessage'; message: string }

export type DependencyNode = DependencyRootNode | DependencyGroupNode | DependencyItemNode | DependencyRepoNode | DependencyLocationNode | DependencyMessageNode;

export interface DependencySource {
    query(sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>>;
    /** The node of the Objects or Tables view a row stands for, so the same commands apply. */
    toNode(row: DependencyRow): Promise<ViewNode | undefined>;
}

const keyOf = (t: DependencyTarget): string => `${t.classid}:${t.oid}`;

/** The context value of a view node, so the menus of the Objects and Tables views apply. */
export function contextValueOf(node: ViewNode | undefined): string {
    if (!node) return 'dependency';
    if (node.type === 'object') return `${node.db ? 'dbObject' : 'repoObject'}.${String(node.kind)}`;
    if (node.type === 'table') return node.status === 'repoOnly' ? 'table.repoOnly' : 'table';
    if (node.type === 'schema') return 'objectSchema';
    return 'dependency';
}

export class DependenciesProvider implements vscode.TreeDataProvider<DependencyNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<DependencyNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private root?: DependencyRoot;
    private readonly cache = new Map<string, Promise<DependencyItemNode[]>>();

    constructor(private readonly source: DependencySource) {}

    get current(): DependencyRoot | undefined {
        return this.root;
    }

    setRoot(root: DependencyRoot): void {
        this.root = root;
        this.cache.clear();
        this._onDidChangeTreeData.fire();
    }

    clear(): void {
        this.root = undefined;
        this.cache.clear();
        this._onDidChangeTreeData.fire();
    }

    /** Read again from the database (and the repository). */
    refresh(): void {
        this.cache.clear();
        this._onDidChangeTreeData.fire();
    }

    /** The dependencies of `target` in one direction; kept until the root changes or Refresh. */
    dependencies(target: DependencyTarget, direction: DependencyDirection, path: string[]): Promise<DependencyItemNode[]> {
        const key = `${direction}:${keyOf(target)}`;
        let promise = this.cache.get(key);
        if (!promise) {
            promise = (async () => {
                const rows = await this.source.query(direction === 'usedBy' ? USED_BY_QUERY : USES_QUERY, [`pg_catalog.${target.classid}`, target.oid]);
                const items: DependencyItemNode[] = [];
                for (const row of rows.map(toDependencyRow)) {
                    items.push({ type: 'dependency', direction, row, node: await this.source.toNode(row), path: [...path, keyOf(target)] });
                }
                return items;
            })();
            this.cache.set(key, promise);
            promise.catch(() => this.cache.delete(key));
        }
        return promise;
    }

    async getChildren(element?: DependencyNode): Promise<DependencyNode[]> {
        const root = this.root;
        if (!root) return [];
        try {
            if (!element) return [{ type: 'dependencyRoot', root }];
            switch (element.type) {
                case 'dependencyRoot': {
                    const children: DependencyNode[] = [
                        { type: 'dependencyGroup', direction: 'usedBy', target: root.target, path: [] },
                        { type: 'dependencyGroup', direction: 'uses', target: root.target, path: [] }
                    ];
                    if (root.usages) children.push({ type: 'dependencyRepo', locations: await root.usages() });
                    return children;
                }
                case 'dependencyGroup': {
                    const items = await this.dependencies(element.target, element.direction, element.path);
                    return items.length > 0 ? items : [{ type: 'dependencyMessage', message: element.direction === 'usedBy' ? 'Nothing in the database uses it' : 'It uses nothing else in the database' }];
                }
                case 'dependency': {
                    const target = { classid: element.row.classid, oid: element.row.oid };
                    if (element.path.includes(keyOf(target))) return [];
                    return this.dependencies(target, element.direction, element.path);
                }
                case 'dependencyRepo':
                    return element.locations.map(location => ({ type: 'dependencyLocation' as const, location }));
                default:
                    return [];
            }
        } catch (err: unknown) {
            Logger.error('DependenciesProvider.getChildren', err);
            return [{ type: 'dependencyMessage', message: `Could not read the dependencies: ${getErrorMessage(err)}` }];
        }
    }

    getTreeItem(element: DependencyNode): vscode.TreeItem {
        const { Collapsed, Expanded, None } = vscode.TreeItemCollapsibleState;
        switch (element.type) {
            case 'dependencyRoot': {
                const item = new vscode.TreeItem(element.root.title, Expanded);
                item.iconPath = new vscode.ThemeIcon(element.root.icon);
                item.contextValue = contextValueOf(element.root.node);
                item.tooltip = element.root.title;
                return item;
            }
            case 'dependencyGroup': {
                const item = new vscode.TreeItem(element.direction === 'usedBy' ? 'Used by' : 'Uses', Expanded);
                item.iconPath = new vscode.ThemeIcon(element.direction === 'usedBy' ? 'arrow-left' : 'arrow-right');
                item.tooltip = element.direction === 'usedBy'
                    ? 'Objects the database records as depending on it'
                    : 'Objects the database records it as depending on';
                item.contextValue = 'dependencyGroup';
                return item;
            }
            case 'dependency': {
                const { row } = element;
                const cycle = element.path.includes(keyOf({ classid: row.classid, oid: row.oid }));
                const item = new vscode.TreeItem(row.identity, cycle ? None : Collapsed);
                item.description = row.type;
                item.iconPath = new vscode.ThemeIcon(TYPE_ICONS[row.type] ?? 'symbol-misc');
                item.tooltip = `${row.type} ${row.identity}`;
                item.contextValue = contextValueOf(element.node);
                if (element.node) {
                    item.command = {
                        command: 'postgresQueryBuilder.goToRepositoryDefinition',
                        title: 'Go to Definition in Repository',
                        arguments: [element.node, CLICK_ARGUMENT]
                    };
                }
                return item;
            }
            case 'dependencyRepo': {
                const count = element.locations.length;
                const item = new vscode.TreeItem(`Used in the repository (${count})`, count > 0 ? Collapsed : None);
                item.iconPath = new vscode.ThemeIcon('references');
                item.tooltip = 'References in the SQL files of the workspace, also calls inside PL/pgSQL bodies, which the database does not record';
                item.contextValue = 'dependencyRepo';
                return item;
            }
            case 'dependencyLocation': {
                const { location } = element;
                const uri = vscode.Uri.parse(location.uri);
                const item = new vscode.TreeItem(`${vscode.workspace.asRelativePath(uri, false)}:${location.start.line + 1}`, None);
                item.iconPath = new vscode.ThemeIcon('file-code');
                item.contextValue = 'dependencyLocation';
                item.command = {
                    command: 'vscode.open',
                    title: 'Open',
                    arguments: [uri, { selection: new vscode.Range(location.start.line, location.start.character, location.end.line, location.end.character) }]
                };
                return item;
            }
            default: {
                const item = new vscode.TreeItem(element.message, None);
                item.iconPath = new vscode.ThemeIcon('info');
                item.contextValue = 'dependencyMessage';
                return item;
            }
        }
    }
}
