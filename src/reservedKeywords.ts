/**
 * PostgreSQL reserved keywords that require double-quoting when used as
 * identifiers.
 *
 * This is the single source of truth. The webview script
 * `src/webview/tableView.js` keeps its own copy (it is loaded as a plain
 * browser script and cannot import this module at runtime); the test
 * `src/test/reservedKeywords.test.ts` enforces that the two lists stay
 * identical.
 */
export const POSTGRES_RESERVED_KEYWORDS_LIST: readonly string[] = [
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
];

export const POSTGRES_RESERVED_KEYWORDS = new Set(POSTGRES_RESERVED_KEYWORDS_LIST);
