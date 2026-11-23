/**
 * Catalog lookups of the Query Builder: the columns of the relations on the
 * canvas, the foreign keys that join them automatically, and the joins
 * derived from the user's custom column mappings.
 *
 * Every function takes the query function to run, so it works with any
 * connection (pool, session) and is tested with fakes. Values are always
 * passed as parameters.
 */
import type { QbForeignKey, QbMappingEdge } from './queryBuilderModel';
import type { CustomColumnMapping } from './columnMappingManager';

export type CatalogRow = Record<string, unknown>;
export type CatalogQueryFn = (sql: string, params?: unknown[]) => Promise<CatalogRow[]>;

export interface QbCatalogColumn {
    name: string;
    /** `format_type` spelling, e.g. `character varying(40)`. */
    dataType: string;
    nullable: boolean;
    isPrimaryKey: boolean;
    /** 1-based position in the table. */
    ordinal: number;
}

function toBoolean(value: unknown): boolean {
    return value === true || value === 't' || value === 'true' || value === 1;
}

/** A text[] value as the driver returns it, or its `{a,"b c"}` literal. */
export function toStringArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.map((v) => String(v));
    if (typeof value !== 'string') return [];
    const inner = value.trim().replace(/^\{/, '').replace(/\}$/, '');
    if (!inner) return [];
    const out: string[] = [];
    let i = 0;
    while (i < inner.length) {
        if (inner[i] === '"') {
            let j = i + 1;
            let item = '';
            while (j < inner.length && inner[j] !== '"') {
                if (inner[j] === '\\') j++;
                item += inner[j] ?? '';
                j++;
            }
            out.push(item);
            i = j + 2;
        } else {
            let j = inner.indexOf(',', i);
            if (j < 0) j = inner.length;
            out.push(inner.slice(i, j));
            i = j + 1;
        }
    }
    return out;
}

export const QB_COLUMNS_QUERY = `SELECT a.attname AS column_name,
       pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
       NOT a.attnotnull AS is_nullable,
       a.attnum AS ordinal,
       EXISTS (
           SELECT 1 FROM pg_catalog.pg_constraint pk
           WHERE pk.conrelid = c.oid AND pk.contype = 'p' AND a.attnum = ANY (pk.conkey)
       ) AS is_primary_key
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum`;

/** The columns of one relation in table order, with type, nullability and primary-key flag. */
export async function listColumns(query: CatalogQueryFn, schema: string, table: string): Promise<QbCatalogColumn[]> {
    const rows = await query(QB_COLUMNS_QUERY, [schema, table]);
    return rows.map((r, index) => ({
        name: String(r.column_name),
        dataType: String(r.data_type ?? ''),
        nullable: toBoolean(r.is_nullable),
        isPrimaryKey: toBoolean(r.is_primary_key),
        ordinal: Number(r.ordinal ?? index + 1)
    }));
}

const FOREIGN_KEYS_SELECT = `SELECT con.conname AS constraint_name,
       sn.nspname AS schema_name, sc.relname AS table_name,
       tn.nspname AS ref_schema, tc.relname AS ref_table,
       array_agg(sa.attname::text ORDER BY k.ord) AS columns,
       array_agg(ta.attname::text ORDER BY k.ord) AS ref_columns
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class sc ON sc.oid = con.conrelid
JOIN pg_catalog.pg_namespace sn ON sn.oid = sc.relnamespace
JOIN pg_catalog.pg_class tc ON tc.oid = con.confrelid
JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, refattnum, ord)
JOIN pg_catalog.pg_attribute sa ON sa.attrelid = con.conrelid AND sa.attnum = k.attnum
JOIN pg_catalog.pg_attribute ta ON ta.attrelid = con.confrelid AND ta.attnum = k.refattnum
WHERE con.contype = 'f'`;

const FOREIGN_KEYS_GROUP = `
GROUP BY con.oid, con.conname, sn.nspname, sc.relname, tn.nspname, tc.relname
ORDER BY sn.nspname, sc.relname, con.conname`;

export type ForeignKeyScope =
    | { schemas: readonly string[] }
    | { tables: ReadonlyArray<{ schema: string; name: string }> };

/**
 * The foreign keys touching the scope — referencing or referenced by a table
 * in one of the schemas, or by one of the tables — one row per constraint with
 * its columns in key order (multi-column keys keep their pairing).
 */
export function buildForeignKeysQuery(scope: ForeignKeyScope): { sql: string; params: unknown[] } {
    if ('schemas' in scope) {
        return {
            sql: `${FOREIGN_KEYS_SELECT}
  AND (sn.nspname = ANY ($1::text[]) OR tn.nspname = ANY ($1::text[]))${FOREIGN_KEYS_GROUP}`,
            params: [[...scope.schemas]]
        };
    }
    return {
        sql: `${FOREIGN_KEYS_SELECT}
  AND ((sn.nspname, sc.relname) IN (SELECT * FROM unnest($1::text[], $2::text[]))
       OR (tn.nspname, tc.relname) IN (SELECT * FROM unnest($1::text[], $2::text[])))${FOREIGN_KEYS_GROUP}`,
        params: [scope.tables.map((t) => t.schema), scope.tables.map((t) => t.name)]
    };
}

export async function listForeignKeys(query: CatalogQueryFn, scope: ForeignKeyScope): Promise<QbForeignKey[]> {
    if ('schemas' in scope ? scope.schemas.length === 0 : scope.tables.length === 0) return [];
    const { sql, params } = buildForeignKeysQuery(scope);
    const rows = await query(sql, params);
    return rows.map((r) => ({
        name: String(r.constraint_name),
        schema: String(r.schema_name),
        table: String(r.table_name),
        columns: toStringArray(r.columns),
        refSchema: String(r.ref_schema),
        refTable: String(r.ref_table),
        refColumns: toStringArray(r.ref_columns)
    }));
}

/** The operators of `MAPPING_CONDITION_OPERATORS` (columnMappingManager.ts, which needs `vscode`). */
const MAPPING_OPERATORS: ReadonlySet<string> = new Set(['=', '!=', '<>', '>', '<', '>=', '<=', 'LIKE', 'ILIKE']);

/**
 * Join edges from the user's custom column mappings between the given tables,
 * read like foreign keys: the mapping's source is `schema.table` with
 * `columns` (primary pair first, then the additional pairs), its target is
 * `refSchema.refTable`; the conditions apply to the source table. Mappings
 * between one pair of tables would contradict each other, so only one is
 * used: the default mapping, else the first.
 */
export function mappingJoinEdges(
    mappings: readonly CustomColumnMapping[],
    tables: ReadonlyArray<{ schema: string; name: string }>
): QbMappingEdge[] {
    const known = (schema: string, name: string) => tables.some((t) => t.schema === schema && t.name === name);
    const chosen = new Map<string, CustomColumnMapping>();
    for (const m of mappings) {
        if (m.reversed || !m.sourceColumn || !m.targetColumn) continue;
        if (!known(m.sourceSchema, m.sourceTable) || !known(m.targetSchema, m.targetTable)) continue;
        const ends = [`${m.sourceSchema}.${m.sourceTable}`, `${m.targetSchema}.${m.targetTable}`];
        if (ends[0] === ends[1]) continue;
        const key = JSON.stringify(ends.sort());
        const current = chosen.get(key);
        if (!current || (m.isDefault && !current.isDefault)) chosen.set(key, m);
    }
    return [...chosen.values()].map((m): QbMappingEdge => {
        const pairs = [{ sourceColumn: m.sourceColumn, targetColumn: m.targetColumn }, ...(m.additionalColumnPairs ?? [])]
            .filter((p) => p.sourceColumn && p.targetColumn);
        return {
            ...(m.label ? { name: m.label } : {}),
            mapping: true,
            schema: m.sourceSchema,
            table: m.sourceTable,
            columns: pairs.map((p) => p.sourceColumn),
            refSchema: m.targetSchema,
            refTable: m.targetTable,
            refColumns: pairs.map((p) => p.targetColumn),
            conditions: (m.conditions ?? [])
                .filter((c) => c && c.column && MAPPING_OPERATORS.has(String(c.operator).trim().toUpperCase()))
                .map((c) => ({ column: c.column, operator: String(c.operator).trim().toUpperCase(), value: String(c.value ?? '') }))
        };
    });
}
