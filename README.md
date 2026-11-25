# PostgreSQL Query Booster

Browse, query and edit PostgreSQL databases without leaving VS Code — with an
Excel-like data grid, a join builder, bookmarked queries, exports and a
PL/pgSQL formatter.

No external client and no second window: the tables of your database sit in the
sidebar next to your source files, and every change you make is shown to you as
SQL before it is written.

---

## Highlights

- **An editable data grid.** Sort, filter, edit, insert, duplicate and delete
  rows. Every change is collected, shown as `UPDATE` / `INSERT` / `DELETE` and
  committed in a single transaction you can still call off.
- **Navigate along foreign keys.** Jump from a value to the row it references,
  and back to every row referencing it, in one click.
- **Build joins without writing them.** Pick the tables, have the join
  conditions suggested from the foreign keys, and open the result as a normal
  grid.
- **A Query Builder in every Data Viewer.** Switch to its *Query Builder* tab
  to edit the query as tables, joins, columns, conditions and sorting — joins
  come from foreign keys and custom column mappings, the SQL lands formatted
  in the query bar, and *Data* shows the result when you press Run.
- **Let Copilot use your databases — as far as you allow.** A built-in MCP
  server gives AI assistants the catalog, DDL, queries and more; what they may
  do is ticked per connection, and nothing is allowed until you do.
- **Bookmark queries.** Keep a query for yourself or share it with your team
  through a file in `.vscode/`; placeholders are filled in every time it runs.
- **Sessions that keep their state.** Every Data Viewer, and every SQL file,
  runs on a database session of its own: run a `DO` block or `set_config(…)`
  from the file, then look at the data it prepared with **View Data**.
- **Columns that act.** Name a column `pgsql_…`, `url_…` or `ps_…` and every
  value gets a button that runs the statement, opens the link or runs the
  command — a list of blocking sessions with a kill button in each row is one
  query away.
- **Export what you see.** CSV, Excel, JSON, XML or ready-made `INSERT`
  statements — always the complete result, not just the page you loaded.
- **Format PL/pgSQL.** A formatter for `sql`, `plpgsql` and `pgsql` that never
  changes what your code means, configurable per repository and available as a
  standalone CLI.
- **Every object, its DDL, and your repository.** Functions with their
  signature, procedures, types, sequences, triggers and extensions in a view
  of their own; CREATE and DROP scripts of any object or table; red marks
  for whatever the SQL files of your workspace do not create; and one click
  that compares every table, view, type, sequence, trigger and routine of the
  database with the repository, column by column.
- **plpgsql_check and a debugger.** Check the PL/pgSQL of the open file against
  a database with plpgsql_check — not necessarily the one you are connected
  to — and see the findings like those of a linter; step through a function
  with breakpoints and variables where pldbgapi is installed.
- **SQL files that know your database.** Go to Definition and Find All
  References across the repository, hovers with the doc comment and the
  columns, parameter hints while typing a call, completion of your own
  functions, a CodeLens above every `CREATE` that says whether the database
  has it — or a different version of it — and the dependencies of any object.

---

## Getting started

1. Open the **PostgreSQL Query Booster** container in the activity bar (the
   database icon).
2. Click **New Connection** in the *Tables* view and fill in host, port,
   database and user. The password goes into the VS Code SecretStorage — the
   keychain of your operating system — and never into your settings.
3. Schemas and tables appear in the tree. Click a table to open it.

Everything is available from the Command Palette (`Ctrl+Shift+P`) as well,
under the category **PostgreSQL Query Booster**.

---

## Connections

| Field | Required | Description |
|-------|----------|-------------|
| Connection Name | yes | The name this connection is listed under |
| Host | yes | Hostname or IP address |
| Port | yes | PostgreSQL port, `5432` by default |
| Database | yes | Database name |
| Username | yes | PostgreSQL user |
| Password | no | Kept in the VS Code SecretStorage |
| Schemas | no | Comma-separated list of the schemas to show; all if empty |
| SSL | yes | *Verify certificate and host name* (default for new connections), *Require SSL, do not verify the certificate*, *Prefer SSL, fall back to unencrypted*, or *Disable SSL* |
| CA certificate file | no | PEM file with the CA certificate(s) used to verify the server; the system's trusted certificates when empty |
| Application name | no | The `application_name` the server shows for this connection in `pg_stat_activity` and its logs; `PostgreSQL Query Booster` when empty |
| Commit behaviour of new sessions | yes | *Auto-commit* (default), *Manual commit* or *Commit per run* — how the database sessions of this connection commit until you choose otherwise in the *PostgreSQL Messages* panel; see [Commit behaviour](#commit-behaviour) |
| Check SQL files with plpgsql_check in this database | no | Offer this connection for [plpgsql_check](#plpgsql_check); only kept when the database has the extension |
| AI access (Copilot / MCP) | no | What AI assistants may do on this database, and whether they ask before writing; nothing is allowed by default, see [AI assistants (MCP)](#ai-assistants-mcp) |

Connections saved before the SSL option existed keep their old behaviour,
*Prefer SSL*: SSL is attempted first and falls back to an unencrypted
connection when the server does not offer it. A local server without SSL needs
*Prefer SSL* or *Disable SSL*. Hostnames are resolved by the operating system,
so `/etc/hosts` applies.

A stored password is only ever sent to the host, port, database and user it was
saved for; when one of them changes, the password is asked for again.

The psql console uses the connection's SSL mode too. With *Verify certificate
and host name* and no CA certificate file it relies on the system's trusted
certificates, which needs psql 16 or later; an older psql refuses to connect
instead of skipping the check. It reports the connection's application name as
well, or `PostgreSQL Query Booster console` when none is set.

Several connections can be saved and switched from the status bar item at the
bottom left, which also shows which database you are currently looking at.
**Show / Edit search_path** displays the `search_path` of the active connection
and lets you override it.

---

## Tables and search

The *Tables* view lists the schemas and their tables. The system schemas
`pg_catalog`, `information_schema` and `pg_toast` stay hidden, and if a
connection names specific schemas, only those are shown. A schema without any
table, view or foreign table is hidden too, until **Show Empty Schemas** (the
eye in the title bar) is turned on; **Hide Empty Schemas** turns it off again,
and the choice is kept per workspace. **Refresh** in the title bar reloads the
tree; a double click on a table opens it.

The *Search* view below it filters the tables — and the *Objects* view — while
you type, across all schemas, and understands the `schema.name` notation.

---

## Database objects

The *Objects* view, below *Search*, lists everything of the database that is
not a table: functions and procedures with their signature
(`add_tax(amount numeric) → numeric`), aggregates, enum, composite and range
types, domains, sequences, triggers with their table, and the installed
extensions. It starts collapsed and reads nothing until you open it; then one
query loads the whole catalog, and filtering happens without asking the
database again. Objects that belong to an extension, such as the functions of
PostGIS, stay hidden unless `postgresQueryBuilder.objectNavigator.showExtensionObjects`
is on; `postgresQueryBuilder.objectNavigator.objectKinds` chooses the kinds. A
schema with nothing left to show after these settings is hidden until **Show
Empty Schemas** in the title bar is on — the way to reach the CREATE and DROP
scripts of an empty schema.

**Go to Database Object** (the search icon in the title bar, or the Command
Palette) offers every object and table by name, kind and schema. The chosen
entry is revealed and selected in its view; a Search filter that would hide it
is cleared first.

### CREATE and DROP scripts

The context menu of an object, a schema or a table offers **Open CREATE
Script**, **Copy CREATE Script**, **Open DROP Script** and **Copy DROP
Script**. Several selected entries give one script — CREATE in the order of the
selection, DROP in reverse. Scripts are only written, never run:

- functions and procedures as the server prints them, aggregates, enum,
  composite and range types, domains, sequences, triggers, extensions and
  schemas;
- views, materialized views with their indexes, and tables with their columns
  (identity and generated columns included), constraints, inheritance and
  partitioning, indexes, triggers, row level security and policies; foreign
  tables with server and options;
- `COMMENT ON`, `ALTER … OWNER TO` and `GRANT`, each of which can be turned
  off with `postgresQueryBuilder.ddl.includeComments`, `…includeOwner` and
  `…includeGrants`;
- `DROP … IF EXISTS`, with the full signature for functions.

Every name outside `pg_catalog` is written with its schema, as pg_dump does,
so a script does not depend on the `search_path` of the session that runs it.

### Comparing with the repository

The SQL files of the workspace are scanned in the background for `CREATE`
statements, and both views show how the database compares with them:

| Look | Meaning |
|------|---------|
| red, with `!` | the object exists in the database but no file creates it |
| colour of an untracked file, with `+` | a file creates it, but the database does not have it |
| colour of a modified file, with `~` | the body of the function or procedure in the database matches none of its `CREATE` statements |
| unchanged | both have it |

A double click on an object of the *Objects* view jumps to its `CREATE`
statement — or offers a choice when several files create it. In the *Tables*
view, where a double click opens the Data Viewer, the context menu has **Go to
Definition in Repository**. Functions are matched together with their argument
types, so overloads are told apart, and `int`, `int4` and `integer` count as
the same type. A name without schema belongs to the schema of a `SET
search_path` earlier in the file, otherwise to the first schema of the
connection's `search_path`. Comments, strings and function bodies are skipped,
so a `CREATE TABLE` inside a function or an `EXECUTE` does not count; the
statements of a `DO` block do, as it runs when the file is deployed. What an
extension creates, and PostgreSQL's own `pg_*` schemas, are never marked.

**Show Only Differences to the Repository** in the title bar of *Objects*
hides what both sides have. A workspace without any `CREATE` statement marks
nothing. Changed files are rescanned as they are saved; **Rescan Repository**
starts over. `postgresQueryBuilder.repository.compare` turns the comparison
off, and `…include`, `…exclude` and `…maxFileSizeKb` choose the files.

Bodies are compared without whitespace, letter case and comments, so a
repository run through the formatter does not count as different, and neither
does a function whose `-- line comments` the database keeps as `/* block
comments */` or whose line breaks it lost. Spellings of one type count as the
same too — `varchar` and `character varying`, `int` and `integer`,
`timestamptz` and `timestamp with time zone` — unless
`postgresQueryBuilder.repository.compareIgnoresTypeSpelling` is turned off.
Matching any one of several `CREATE`
statements — an older migration, say — is enough. **Compare with Database**
(context menu, editor and CodeLens) opens the `CREATE` statement of the
repository next to the one of the database in a diff editor, both formatted
with your formatter settings and without owner and grants, so only real
differences remain. Comments are left out too, unless
`postgresQueryBuilder.repository.compareIgnoresComments` is turned off.

**Compare Repository with Database** — in the *Comparison* view and the menu
of the *Objects* title bar — compares everything at once: functions,
procedures and aggregates by their code, tables by their columns, types,
defaults, `NOT NULL`, constraints and indexes, views by their query, types by
their values, attributes or base type, sequences by their options and triggers
by their timing, events and function. A table is compared with what its
`CREATE TABLE` and every later `ALTER TABLE`, `CREATE INDEX` and `DROP INDEX`
of the repository make of it, in the order of the files; a view's query is
compared after the database has normalised both. The *Comparison* view lists
the result under *Differs*, *Only in the database* and *Only in the repository*,
each difference on a line of its own (`column amount: type numeric(10,2) in the
database, numeric(12,2) in the repository`), and the entries carry the same
context menu as in the other views; the marks also show in the *Objects* and
*Tables* views. The funnel limits the view to some kinds, **Export Comparison
Report** writes it as Markdown and **Clear Comparison** removes it. The
database is only read, in a transaction that is rolled back; a different column
order counts only with `postgresQueryBuilder.comparison.columnOrder`.

For a table that exists on both sides and differs, **Open ALTER TABLE Script**
and **Copy ALTER TABLE Script** in its context menu write the statements that
bring the database to what the repository makes of the table: constraints and
indexes the repository does not have are dropped, columns are added, changed
(`TYPE`, `SET DEFAULT`, `SET NOT NULL`) or dropped, and the missing
constraints and indexes are added — types, defaults, constraints and
`CREATE INDEX` statements exactly as the repository writes them. What
`ALTER TABLE` cannot do, such as reordering columns or changing an identity
column, is listed as a comment. The script is only written, never run.

### Working in SQL files

In `sql`, `postgres` and `pgsql` files the names of database objects work like
code symbols. Everything below reads the repository scan and, while connected,
the catalog of the database; nothing is loaded before a feature asks for it.

- **Go to Definition** (`F12`, `Ctrl+Click`) on a call, a table, a type or a
  sequence in `nextval('…')` jumps to its `CREATE` statement — also from inside
  function bodies and `DO` blocks. Names are resolved like PostgreSQL does: a
  `SET search_path` earlier in the file, otherwise the connection's
  `search_path`, the first schema with a hit wins, and a call goes to the
  overload that takes as many arguments. An object that exists only in the
  database is reported in the status bar.
- **Find All References** (`Shift+F12`) lists every place in the repository
  that uses the object, including calls inside PL/pgSQL. **Find Usages** in the
  context menu of the *Objects* and *Tables* views does the same for an entry.
- The **Outline** and the breadcrumbs list the `CREATE` statements of a file.
  When a file creates objects in several schemas, each schema is a node of its
  own — opening on its `CREATE SCHEMA`, if the file has one — with its
  functions, procedures, tables and other objects named without the schema; a
  trigger goes with its table. With a single schema the list stays flat and
  the schema is left out of the names, and objects created without a schema
  stay at the top. **Go to Symbol in Workspace** (`Ctrl+T`) finds any of the
  repository.
- **Hover** shows the signature, the doc comment, the `COMMENT ON` text of the
  database when it says something else, the first columns of a table, where the
  object exists, and links to its CREATE script, the comparison, the *Objects*
  view and its dependencies.
- **Parameter hints** appear while typing the arguments of a call, for every
  overload, with the documentation of the current parameter; named notation
  (`p_rate => …`) is understood.
- **Completion** offers your own functions — and procedures after `CALL` — as
  snippets with their required parameters, schema-qualified when the schema is
  not on the `search_path`. Deprecated ones are struck through.
- A **CodeLens** above each `CREATE` says *In database*, *Differs from database*
  or *Not in database*, with **Compare with Database** and **Reveal in Objects
  View** next to it (`postgresQueryBuilder.repository.codeLens`).
- The editor's context menu offers **Reveal in Objects View**, **Compare with
  Database** and **Show Dependencies** for the name under the cursor.

**Doc comments.** The `/** … */` block — or the `--` lines — right above a
`CREATE` is its documentation. Both common styles are read, also mixed:
sections such as `Purpose:`, `Explanation:`, `Parameters:` with one
`- name (TYPE, MODE): text` entry each and `Returns:`, and Javadoc tags such as
`@param`, `@return`, `@throws`, `@deprecated`, `@see` and `@example`. Typing
`/**` on the line above a `CREATE FUNCTION` or `PROCEDURE` offers a complete
comment with one entry per parameter.

**Checks (opt-in).** `postgresQueryBuilder.diagnostics.unknownRoutines` warns
about calls of functions and procedures nobody has — not PostgreSQL, an
extension, the database or the repository — and about calls with a number of
arguments no overload takes; it needs a connection, so the built-in functions
are known. `postgresQueryBuilder.diagnostics.docComments` reports functions and
procedures without a doc comment, undocumented parameters, documented ones that
do not exist and documented types that contradict the signature; Quick Fixes
add the comment or the missing entries, or remove an entry.

### Dependencies

**Show Dependencies** — in the context menu of both views and of the editor —
fills the *Dependencies* view with what uses the object and what it uses, as
the database records it: a view that reads a table, a trigger that calls a
function, a column default that calls `nextval`, a foreign key. Each entry
expands further and has the same context menu as in the *Objects* and *Tables*
views. Since PostgreSQL does not record what a PL/pgSQL body calls, *Used in
the repository* adds the references found in the SQL files.

### plpgsql_check

[plpgsql_check](https://github.com/okbob/plpgsql_check) finds what PostgreSQL
only reports when a PL/pgSQL function runs: a misspelt column, a wrong type, an
unused variable, a missing `RETURN`. To use it, tick *Check SQL files with
plpgsql_check in this database* in the connection form of a database that has
the extension (`CREATE EXTENSION plpgsql_check`); when it is missing, the mark
is dropped with a warning on saving. That connection does not have to be the
active one: the status bar shows *plpgsql_check: name*, and a click on it — or
**Select plpgsql_check Connection** — chooses among the marked connections for
this workspace.

Each `CREATE FUNCTION` and `CREATE PROCEDURE` in PL/pgSQL of the file is
created in a transaction on that database, checked and rolled back; trigger
functions are checked on the table of a `CREATE TRIGGER` in the same file. The
check works on the file's routines as if they replaced what the database has,
as a file that drops its routines before creating them expects: every version
the database has of a routine the file creates is renamed out of the way for
the check, so a call cannot match an old overload (*is not unique*), and all
routines are created before the first is checked, so a call finds the file's
version of a routine further down. A version that cannot be renamed is replaced
with `OR REPLACE`, or the file's routine is created under a temporary name;
findings still name it as the file does. Nothing is dropped, and
`postgresQueryBuilder.plpgsqlCheck.replaceExisting` turns this off. The
findings appear as squiggles and in the *Problems* panel on the line they
concern, errors as errors, warnings as warnings and the extra, performance,
security and compatibility warnings as `postgresQueryBuilder.plpgsqlCheck.extraSeverity`
says; a statement the database rejects is reported where it fails. A file is
checked when it is saved, after `…plpgsqlCheck.delayMs` with auto save, while
typing with `…plpgsqlCheck.onType`, and on demand with **Check File with
plpgsql_check** in the editor's context menu. Only one check runs at a time,
and an outdated result is dropped. The other `postgresQueryBuilder.plpgsqlCheck.*`
settings are the options of `plpgsql_check_function` — `fatal_errors`,
`other_warnings`, `extra_warnings` and so on — and are passed only where the
installed version knows them.

### Debugging PL/pgSQL

Where the database has the `pldbgapi` extension and the server loads
`plugin_debugger` (`shared_preload_libraries`), PL/pgSQL can be debugged with
VS Code's debugger. **Debug Function** — in the context menu of a function or
procedure of the views and, as a CodeLens, above its `CREATE` — asks for the
statement that calls it, prefilled with a call with every parameter;
**Debug Statement** in the editor's context menu runs the statement at the
cursor. Execution stops at the first line of the routine; then *Continue*,
*Step Over*, *Step Into* and *Step Out* work as usual, the *Variables* view shows
arguments and locals — and can change them —, and the call stack lists every
PL/pgSQL frame. Breakpoints set in a SQL file of the repository are honoured
when the file's code equals the code in the database; otherwise the debugger
shows the code of the database, read-only, and breakpoints are set there.

The statement runs on a session of its own on the active connection, in a
transaction that is rolled back when debugging ends, so the data stays as it
was; `"rollback": false` in a launch configuration of type `pgqb-plpgsql`
commits instead. What a function does outside the database, such as sending
mail through an extension, cannot be rolled back. *Pause* is not supported;
set a breakpoint instead. A statement that runs for long — a query over
foreign tables, say — cannot be interrupted while stepping; the *Debug
Console* says so after a few seconds, and *Stop* cancels the statement on
the server and rolls it back.

---

## The Data Viewer

Opening a table opens a grid with the first 50 rows, the total row count and
the time the query took. **Load More** fetches the next 50, **Load All** the
rest; while they load, the rows already there stay usable. Column headers carry the name and the data type, and the comment of a
column as a tooltip. Only the rows in view are drawn, so even tens of
thousands of loaded rows scroll, sort and filter without delay; selecting,
copying and filling still cover every row.

**Auto refresh**, the drop-down with the circular-arrow icon at the right of the
toolbar, runs the query again every 1 s, 5 s, 10 s, 30 s, 1 min, 5 min or at a
custom interval (`45s`, `2m`, `1h 30m`). It reloads as many rows as are shown
and keeps the scroll position. The selection stays on the same row, recognised
by its key or else by its values, even when that row has moved to another line,
and the view scrolls with it so it stays at the same place on screen; a row
that is gone is no longer selected. It pauses while there are unsaved
edits, while the tab is hidden and while you are typing in a cell or a dialog
is open, and it switches itself off for a statement that writes data or takes
locks (`FOR UPDATE`, `LOCK TABLE`, advisory locks). It is off whenever a Data
Viewer opens.

**Every Data Viewer has its own database session.** Its queries run on one
connection of their own, opened with the first query and closed with the tab, so
what one query sets up — `SET`, `set_config(…, false)`, a temporary table —
stays in place for *More*, *All*, the row count, *Auto refresh*, *Save* and
*Export*. A table opened from it through a foreign key or as a related table
shares the session, and a Data Viewer opened with **View Data** from a SQL file
runs on the session of that file. The badge next to the connection says *Own
session* or *Session: payroll.sql*; clicking it resets the session after asking.
If you opened a transaction in the session yourself (`BEGIN`), or the session
uses *Manual commit* (see [Commit behaviour](#commit-behaviour)), *Save* runs as a
savepoint inside it, so nothing is permanent before your `COMMIT`.
Switching the connection, disconnecting or changing the `search_path` closes
every session, and the next query reconnects; if the server drops a session, a
warning says that its settings are gone.

### Finding rows

- **Sort** by clicking a column header, click again to reverse.
- **Filter** in the row underneath the headers. Text columns match
  case-insensitively, numeric and date columns offer `=`, `<>`, `<`, `<=`, `>`,
  `>=` and *between*. Several filters are combined with `AND`. Filter values
  are sent as query parameters and never pasted into the SQL. A date or
  timestamp value stands for the whole day, minute or second it names: `=
  2026-11-25 10:39` finds every row of that minute, and *between* includes its
  whole last minute. Type `2026-11-25 10:39`, `25.11.2026 10:39` or `10:39` for
  today, or pick it in the 24-hour calendar behind the button next to the field
  (`Alt+↓`); the same picker serves date and timestamp cells while editing,
  the WHERE values of the Query Builder and the *View Data* form. A computed
  column such as `region(id) AS region` is filtered on its expression, an
  aggregate such as `count(*)` in `HAVING`, and a window function only in the
  rows already loaded. When a filtered column is removed from the query, its
  filter and sort are dropped the next time the query runs.
- **Constraints** stores a `WHERE` condition and an `ORDER BY` per table that
  are applied every time you open it — for the client, tenant or valid-from
  column you filter by anyway.
- **Reorder columns** by dragging a header; the `SELECT` list in the query bar
  follows.
- The **query bar** shows the SQL behind the grid. Edit it and press
  `Ctrl+Enter` to run whatever you like; the grid stays editable as long as its
  rows can be traced back to one table.
- The query bar is a real code editor — Monaco, the editor VS Code itself is
  built on — with PostgreSQL syntax highlighting in the colours of your theme,
  multi-cursor editing, find and replace, bracket matching and VS Code's
  keyboard shortcuts. Autocomplete suggests the columns of the tables in the
  statement (after `o.` only those of the table aliased `o`), tables and views
  of the connection where a table name belongs (after `sales.` those of that
  schema), and PostgreSQL's keywords and built-in functions. **Format SQL** and
  `Shift+Alt+F` format the statement with the extension's own formatter and
  your formatter settings, exactly like a `.sql` file. `Ctrl+Z` still steps back
  through grid edits and query changes together.

### Editing rows

- Click a cell to edit it. Modified cells are marked, and the toolbar counts
  what is pending.
- Drag the small square at the bottom-right corner of a selection to fill
  further cells, like in Excel. From one cell its value is copied; from several
  cells numbers, dates, timestamps and times are continued as a series — the
  steps between the selected values repeat in turn (`1, 3, 2` → `4, 3, 5, 4 …`),
  and dates on the same day of the month (or all on a month's last day) step
  by whole months. Other values are repeated. While you drag, the cells show
  in italics what they would receive. A fill works downwards, upwards and
  sideways, and one *Ctrl+Z* takes it back.
- A long value opens in a real editor tab with syntax highlighting through
  **Open Value in Editor** — saving the tab writes the value back, closing it
  discards it, emptying it sets the cell to `NULL`.
- **View Full Record** shows a single row as a form, one field per line, with
  data type, primary and foreign key badges, a character counter for
  length-limited columns and arrows to step through the result.
- Insert, duplicate and delete rows from the row toolbar. A deleted row is
  struck through until you save and can be restored until then. A new or
  duplicated row that is not saved yet can be duplicated as well; the copy
  goes directly below it.
- **Reset to Default** in the context menu of a cell of an existing row sets
  the column back to the default the table defines for it — for example
  `mit_geloescht VARCHAR(1) DEFAULT 'N'` — for that cell or every cell of a
  selection. The cell shows `DEFAULT` until it is saved as
  `SET column = DEFAULT`; typing into it replaces it, *Ctrl+Z* takes it back.
  **View Full Record** offers the same as a *Default* button per field.
  Identity and generated columns are left out.
- **Save** shows the generated statements before anything happens. You can edit
  them; **Execute** then runs them in one transaction that rolls back
  completely on the first error, and every `UPDATE` and `DELETE` is checked to
  hit exactly one row.
- Views, materialized views and results that cannot be traced back to a table
  are read-only and say so. A table without a primary key stays editable but is
  marked, because its rows have to be matched by their values.

### Getting somewhere else

- A foreign key cell offers the jump to the row it points at; the context menu
  offers the way back to every table pointing at this row. A hand-written or
  joined query offers the same jumps on every column it takes from a real
  table, even when the query renames it.
- **Custom column mappings** add that jump where the database has no foreign
  key — including composite keys and mappings that only apply to rows meeting a
  condition. They are kept personally or shared with the workspace.
- A cell value can be added to the query as an exact match or as an exclusion
  straight from the context menu.

### Executable columns

A column whose alias starts with one of these prefixes runs its values: every
cell gets a button at its left edge, the context menu of the cell offers the
same action, and the header shows an icon for it.

| Prefix | A click on a value |
|--------|--------------------|
| `sql_` | opens the query in a new Data Viewer that shares the database session of this one |
| `pgsql_` | runs the statement in the database session of this Data Viewer |
| `psql_` | sends it to the psql console of the connection (a statement gets its closing `;`) |
| `ps_` | runs it in a PowerShell terminal |
| `url_` | opens the http or https link in the browser |
| `file_` | opens the file in the editor — an absolute path, a `file:` URI or a path relative to the workspace folder |
| `copy_` | copies it to the clipboard |

```sql
SELECT psa.pid,
       psa.query,
       'SELECT pg_terminate_backend(' || psa.pid || ');' AS pgsql_kill_command
FROM pg_stat_activity AS psa
```

A `pgsql_`, `psql_` or `ps_` value only runs after you confirmed it in a dialog
that shows its exact text, because it comes from the data. Only a name the
query gives counts: a stored table column that happens to be called `url_slug`
stays an ordinary column. A statement that ran is marked with a check, and its
tooltip tells when and what it returned (`Result: true`); one that failed is
marked in the error colour. A `sql_` value has to be one query that returns
rows, and the psql console and the PowerShell terminal are reused while they
are open.

**Make Column Executable** in the context menu of a column header asks for the
type and writes the matching prefix into the alias of that column in the
query, without touching anything else of it: an alias is replaced, a missing
one is added with `AS`, a lone `SELECT *` is spelled out into its columns and
an `ORDER BY` on the old name follows. *Not Executable* takes the prefix away
again.

### Joins

The join builder assembles a query across several tables: add the tables,
reorder them by dragging, name their aliases, choose `INNER`, `LEFT`, `RIGHT`,
`FULL` or `CROSS`, and take the join condition from the foreign keys and custom
column mappings that already exist between them. Further conditions and
self-joins are possible, and you tick the columns to select. A renamed alias
applies to that statement only; the save button next to it keeps it as the
table's alias, used from then on when the table is dragged into an editor,
joined or completed after `FROM` / `JOIN`. It is the *Query Builder* tab of the
Data Viewer, and the dialog that opens when several tables are dragged into a
SQL file; both write the statement through the formatter, with your settings.

### Grouping

The context menu of a column header groups the result: **Group by** keeps the
column, the columns already grouped and the aggregates, and adds `count(*)` if
there is no aggregate yet; **Aggregate** turns the column into its *Count*,
*Sum*, *Average*, *Minimum* or *Maximum* — as far as its type allows — and
groups by every other column; **Remove grouping** takes it back. The query bar
gets the formatted query, which runs when you press Run.

### Export

**Export** writes the complete result of the current query — filters included —
as CSV (separator, quoting and line endings configurable), as Excel with an
optional sheet holding the executed SQL, as JSON, as XML or as `INSERT`
statements with a batch size of your choice. Your choices per format can be
kept as the default.

While it runs, a bar in the toolbar and a notification show how far it has
come: the rows are counted first, then fetched in batches and written, so the
percentage is real. Both have a **Cancel**, which also stops the query on the
server; a cancelled export writes no file.

---

## Query Builder

Every Data Viewer has two tabs at the top: **Data**, the grid, and **Query
Builder**, the same query as the [join builder](#joins) shows it. Both work on
the one query of the query bar, so you can switch between them at any time.

- **Tables** — their order, aliases and joins, as in the join builder:
  **Add tables** adds the tables just dragged from the *Tables* view, or picks
  them from a list, and joins them along their foreign keys and custom column
  mappings — the default mapping if there are several, its conditions
  included.
- **Columns** — a checkbox per column of every table, plus the expressions of
  the query, each with its alias; *DISTINCT*.
- **Where** and **Order by** — conditions on a column, or written as text, and
  the sorting with *ASC* / *DESC* and *NULLS FIRST* / *LAST*.
- **Kept as written** — what the builder does not edit is shown and left
  alone: `WITH`, `GROUP BY`, `HAVING`, `LIMIT`, `UNION` and the like, and
  subqueries or functions in `FROM`, which appear as tables of their own.

Every change writes the statement, formatted with your formatter settings,
into the query bar; typing in the query bar updates the builder. The query
runs only when you press **Run** (`Ctrl+Enter`), and as long as the query bar
differs from the query that produced the rows, the Data Viewer says *The data
shows the previous query — press Run to refresh*. Placeholders — `:name`,
`:'name'`, `:"name"`, `$1` — and PL/pgSQL variables stay in the query bar;
**Run** asks for their values with the form of **View Data**.

**New Query Builder** opens an empty Data Viewer on the builder tab, **Open in
Query Builder** on tables of the *Tables* view starts with them joined, and
**Edit SELECT in Query Builder** in a SQL file takes the statement at the
cursor, on the session of the file. **Apply to File** then writes the query
bar back in place of that statement — only if the statement is still where it
was. An `UPDATE` or a `SELECT … INTO` opens without *Apply to File*, so
nothing of it is lost.

---

## Bookmarked queries

A query you will need again goes into the **Bookmarked Queries** view, either
for yourself or into `postgres-query-builder.queries.json`, which you
can commit so that everyone on the team has it.

Placeholders written as `:name` are asked for when the query runs, and the
values are remembered for the session. Every placeholder has a kind — text,
number, date, timestamp, identifier or raw — so its value ends up in the SQL
properly quoted instead of merely concatenated; dates and timestamps are picked
with the 24-hour date picker and written as `DATE '…'` / `TIMESTAMP '…'`. Any
placeholder except an identifier can default to NULL (the *NULL* box next to
its default value) or be set to NULL with the *NULL* box of the parameter form
when the query runs. A bookmarked query can be dragged into an editor to insert
its SQL.

Tags sort the view into folders: every tag is a folder, a query with several
tags appears in each of them, and queries without a tag are collected under
*Untagged*. A `/` nests folders, so `Reports/Monthly` sits inside `Reports`.
Tags are set in the bookmark dialog — when a query is bookmarked, and later with
**Edit Bookmarked Query...** from the context menu — by dragging queries onto a
tag folder, or with **Edit Tags** for every selected row in **Manage Bookmarked
Queries**. Dropping queries onto *Untagged* removes their tags after asking.

**Manage Bookmarked Queries** (the gear icon of the view) lists every bookmark
in one table: move a selection between the personal and the workspace scope,
edit the statement — in the dialog or in a full editor tab — and give each
placeholder a description and a default value that the prompt then shows. The
same dialog opens when you bookmark a query, whether from an SQL file or with
the star button of the Data Viewer, so a bookmark is described with the same
fields wherever it comes from.

## Select history

A Data Viewer of a table opened from the **Tables** view keeps the queries you
run in it in its own history, under the **History** button of its query bar.
Every other Data Viewer — opened with **View Data**, by **Execute Selection** or
**Execute File**, from a bookmarked query or as a related table — writes its
queries into the **Select History** view instead, so none of them is lost.

The newest query is on top, with the time it ran last and how often it ran; a
query that runs again moves to the top instead of being listed twice. The
tooltip shows the whole statement, where it ran and on which connection.

The icon tells how the last run of a query ended:

| Icon | Last run |
|------|----------|
| green check | succeeded |
| red error, plus *Failed* | failed — the tooltip shows the error and how long it ran |
| slashed circle, plus *Cancelled* | cancelled — the tab was closed, the session reset or the connection switched while it ran, or no connection was chosen |
| spinning, plus *Running* | still running |

A run still marked as running when VS Code was closed counts as cancelled on
the next start.

- **Double-click** a query to run it in a new Data Viewer.
- **Drag** queries into an editor to insert them, each closed by a semicolon.
- **Copy Query** and **Delete from Select History** are in the context menu,
  for every selected query; the play icon runs one.
- **Search Select History**, the field right above the view, filters while you
  type, as the search of the **Tables** view does: every query that contains
  one of the entered terms — in the statement, the SQL file or Data Viewer it
  ran in, or its connection — is shown, the queries with the most matching
  terms first, the matches highlighted. A term is a part of a word, not a
  pattern; **Escape** clears the field. The trash icon in the title bar of the
  history deletes the whole history after asking.

The view keeps the newest 500 queries;
`postgresQueryBuilder.selectHistory.maxEntries` sets another number.

---

## SQL editor and SQL files

- **Open SQL Editor** gives you a panel for ad-hoc SQL: write it, run it with
  `Ctrl+Enter`, read the result underneath, format it with one button.
- In a `.sql` file, **View Data** takes the `SELECT` your cursor sits in and
  opens it in the Data Viewer. PL/pgSQL variables inside the statement are
  recognised and asked for — column names that merely look like variables are
  not. Each variable has a *Type*: *Plain SQL* inserts the text exactly as
  typed; *String*, *Number*, *Date*, *Timestamp*, *Boolean* and *NULL* are
  checked and written as the right literal; *List* builds the values of an
  `IN (…)` or `= ANY(…)` from one value per line or values separated by commas.
  The type is suggested from the column the variable is compared with, a live
  *Preview* shows the final statement, and values and types are remembered.
- **Execute Selection** (`Ctrl+Alt+Enter`) runs exactly the selected text in a
  database session that belongs to the file — nothing is guessed from the
  cursor, and without a selection nothing runs. It is meant for what returns no
  rows worth a grid: a `DO` block, a `CALL`, `SET` or `set_config(…)`. A
  selection that is a single `SELECT` (or `WITH … SELECT`, `VALUES`, `TABLE`)
  opens in the Data Viewer on that session instead. **View Data** in the same
  file runs on the session too, so a `SELECT` sees what the `DO` block set up:

  ```sql
  DO $$
  BEGIN
      CALL payroll.set_params(DATE '2026-09-21', DATE '2026-10-20');
  END $$;                                   -- select it, Ctrl+Alt+Enter …

  SELECT * FROM payroll.v_wages;            -- … then View Data here
  ```

  The session lives until the file and every Data Viewer opened from it are
  closed; **Reset Database Session** starts it afresh. `RAISE NOTICE`, `INFO`
  and `WARNING` messages, and the details of a failed statement, appear in the
  *PostgreSQL Messages* panel; a syntax error puts the cursor where it is. The
  panel keeps one log per database session — the file and the Data Viewers
  sharing its session write into the same log — and shows the log of the SQL
  file or Data Viewer tab that is active; a log ends with its session. The
  panel shows the newest 2000 messages of a log; **Save** writes every message
  of the session to a file and **Copy** puts all of them on the clipboard.
  With **Clear on Execute** ticked, every **Execute File** and **Execute
  Selection** starts with an empty log of its session. The **Context**
  drop-down chooses which messages show their `CONTEXT:` line — only errors
  and warnings (the default), always, or never; **Copy** and **Save** keep it
  either way. The
  list follows new messages until you scroll up; **Scroll to Bottom** then
  jumps back to the newest one and follows again.

  <a id="commit-behaviour"></a>**Commit behaviour.** The drop-down next to
  **Clear on Execute** sets how the session shown in the panel commits; a new
  session starts with the setting of its connection.

  | Mode | What happens |
  |------|--------------|
  | *Auto-commit* | Every statement is committed as soon as it has run, unless the script opens a transaction itself with `BEGIN`. |
  | *Manual commit* | **Execute File** and **Execute Selection** open a transaction before their first statement, and *Save* in a Data Viewer of the session saves into it. Nothing is permanent until you press **Commit** in the panel or run `COMMIT`; **Rollback** undoes it. |
  | *Commit per run* | Each **Execute File** and **Execute Selection** is one transaction: committed when every statement succeeded, rolled back when one fails or the run is cancelled. The log says which. A transaction you opened yourself before the run is joined and left to you. |

  While the session has an open transaction, the panel says *Uncommitted
  changes* and offers **Commit** and **Rollback**; after a failed statement it
  says *Transaction failed* and offers **Rollback**. Statements PostgreSQL does
  not allow in a transaction — `VACUUM`, `CREATE DATABASE`, `CREATE INDEX
  CONCURRENTLY` and the like — and your own `BEGIN`, `COMMIT` or `ROLLBACK` get
  no transaction opened in front of them. Closing the file and every Data
  Viewer of a session, or resetting it, ends the session and with it an open
  transaction, which PostgreSQL then rolls back. **Reset Session** next to the
  drop-down resets the session shown, after asking — the same as the
  **Reset Database Session** command or the session badge of a Data Viewer.
  Errors are striped, tinted and marked with an icon, and the header counts
  them; clicking the count jumps from one error to the next. A
  running statement can be cancelled from its notification, which also counts
  how long it has been running; one still waiting
  for a Data Viewer query of the same session is then not run at all.
- **Execute File** (`Ctrl+Shift+Alt+Enter`, or the run button in the editor's
  title bar) runs every statement of the file from top to bottom in the file's
  session. Each query returning rows opens in its own Data Viewer, and the run
  goes on only once that Data Viewer has loaded its first page, so it shows the
  data as the statements above left it. All Data Viewers of a run open as tabs
  of one editor group beside the file, which keeps the focus. While it runs, its
  notification shows the statement it is at and how long the run has taken so
  far (`statement 3 of 12 · 1 min 05 s elapsed`). The run stops at
  the first statement that fails, names it with its line and puts the cursor
  at the error.
- **Export instead of showing.** A comment line `-- @export …` above a query
  sends its result to a file when the query runs through *Execute File* or
  *Execute Selection*, instead of opening it in the Data Viewer:

  ```sql
  DO $$ BEGIN PERFORM set_config('payroll.month', '2026-10', false); END $$;

  -- @export excel file=exports/{file}_{date}.xlsx sheet=Wages sqlsheet=true
  SELECT * FROM payroll.v_wages;

  -- @export csv separator=; lineending=lf
  SELECT * FROM payroll.v_deductions;

  -- @export insert dialog table=archive.wages
  SELECT * FROM payroll.wages WHERE month = '2026-10';
  ```

  The format comes first — `csv`, `excel` (or `xlsx`), `json`, `xml` or
  `insert` (or `sql`) — followed by `key=value` options; a value with blanks
  goes in quotes (`file="my exports/a.csv"`).

  | Format | Options |
  |--------|---------|
  | every format | `file=` — relative to the folder of the SQL file; the placeholders below are filled in, and the extension is added when the name has none |
  | `csv` | `separator=` (a character, or `tab`, `comma`, `semicolon`, `pipe`, `space`), `header=`, `quote=`, `lineending=crlf\|lf` |
  | `excel` | `sheet=`, `header=`, `sqlsheet=` |
  | `json` | `pretty=`, `array=` |
  | `xml` | `root=`, `row=` |
  | `insert` | `table=` (required), `batch=`, `onconflict=none\|nothing\|update`, `conflict=` (the key columns, required for `update`) |

  | Placeholder | Filled in with |
  |-------------|----------------|
  | `{date}` / `{time}` | the day (`2026-10-28`) and time (`135959`) the export runs |
  | `{file}` | the name of the SQL file without its extension |
  | `{YEAR}` / `{YR}` | the year, four digits (`2026`) / two digits (`26`) |
  | `{MON}` | the month, `01` to `12` |
  | `{MDAY}` | the day of the month, `01` to `31` |
  | `{YDAY}` | the day of the year, `001` to `366` (`365` outside a leap year) |
  | `{WDAY}` | the day of the week, `1` (Monday) to `7` (Sunday) |
  | `{HOUR}` / `{MIN}` / `{SEC}` | the clock, 24-hour, `00` to `23` / `59` / `59` |
  | `{MSEC}` | the milliseconds, `000` to `999` |

  Names may be written in any case. A clock placeholder takes an offset:
  `{YR-1}` is last year, `{MON-1}` last month (`12` in January), `{MDAY+1}`
  the day of tomorrow. Without a unit the offset steps by the placeholder's
  own unit, so each one moves on its own and `{YEAR}{MON-1}` in January keeps
  the current year. After the number an offset may name the unit to step by —
  `YEAR`, `MON`, `DAY`, `HOUR`, `MIN`, `SEC` or `MSEC` — and the placeholder
  then shows its part of that moment:

  ```sql
  -- @export csv file=reports/{YEAR-1 MON}-{MON-1}.csv     -- last month: 2026-12 in January 2027
  -- @export csv file=daily/{YEAR-1 DAY}{MON-1 DAY}{MDAY-1}  -- yesterday: 20261231 on 1 January
  ```

  A month or a year back keeps the day where the month has it and takes its
  last day otherwise: a month back from 31 March is the last day of February.

  Options you leave out are preset like the export dialog of the Data Viewer:
  your saved defaults for that format, otherwise the dialog's own. Without
  `file=` a save dialog asks where the file goes, and an existing file is
  only overwritten after asking. The word `dialog` opens the export dialog of
  the Data Viewer in a small *Export* tab, prefilled from the instruction and
  showing the query it exports, to choose format, file and options there. The
  query runs in the file's
  session like every other statement. Every instruction is checked before the
  first statement runs, so a typo stops the run with its line; a Cancel in any
  of the dialogs stops it at that query. A selection that holds an
  instruction — or whose first query has one on the lines right above it —
  runs statement by statement like *Execute File*. Every export is listed with
  its row count and file in the log of the file in the *PostgreSQL Messages*
  panel, and while one
  runs, the notification of the run shows how many of its rows are fetched and
  written.
- **Writing an instruction without typing it.** **Add Export Instruction** —
  in the context menu of a SQL file, as the light bulb on the first line of a
  query, or with `Ctrl+.` anywhere in it — opens the export dialog of the
  Data Viewer for the query at the cursor. Choose format, file and options
  there as for any export, tick *Open this dialog when the SQL file runs* if
  you want to decide then, and **Insert** writes the matching `-- @export`
  line above the query, with every option of the format spelled out. On a
  query that has an instruction already, the dialog starts from it and
  **Update** replaces it. File name and folder may hold placeholders, an
  empty file name means *ask each time*, and a folder inside the folder of
  the SQL file is written relative to it. Typing `{` in either field — or the
  `{ }` button beside it — lists the placeholders and a few ready patterns
  (today, yesterday, last month with its year, a timestamp), each with what it
  gives right now; arrow keys, `Enter` or `Tab` pick one. Below the fields the
  dialog shows the file the instruction would write if the SQL file ran now,
  or what is wrong with a placeholder, before **Insert** is pressed.

  Typing an instruction by hand is guided too: `-- @export` is offered as a
  snippet at the start of a line, and inside the line the formats, the
  options of the chosen format, their values (`true`/`false`, `crlf`/`lf`,
  `none`/`nothing`/`update`) and the placeholders of `file=` are suggested.
  Hovering a word explains it, and a wrong instruction is underlined while
  you type, with the message *Execute File* would stop with — the light bulb
  on it offers **Rewrite Export Instruction**.
- **Bookmark Query** stores the statement under the cursor.
- **Autocomplete** in SQL files offers the same suggestions as the Data
  Viewer's query bar, for the statement the cursor is in — also inside a
  PL/pgSQL function body or a `DO` block: the columns of the tables in that
  statement with their types (after `o.` only those of the table aliased `o`),
  tables and views of the connection where a table name belongs (after `sales.`
  those of that schema), and PostgreSQL's keywords and built-in functions.
  Without a connection only keywords and functions are offered. Turn it off
  with `postgresQueryBuilder.completion.enable` if another SQL extension
  already completes your files.
- A table completed after `FROM` or `JOIN` — in SQL files and in the query bar
  — is written together with its alias (`mitarbeiter_tag mtd`): the alias
  saved for it (when dragging it into an editor or with the join builder's save
  button), otherwise the part of its first column before the underscore,
  numbered if the statement already uses it. A newly saved alias is offered
  right away. `postgresQueryBuilder.completion.tableAlias` turns this off.

Every statement that changes data — from the grid, the query bar or the SQL
editor — is recorded in the **Modify History** view with its table and its
timestamp, so you can see afterwards what ran and copy it back out.

---

## psql console

**Open psql Console** — from the Command Palette or the button in the *Search*
view — starts the real `psql` in a VS Code terminal, connected to the active
connection. Every psql command works there as usual: `\d`, `\dt`, `\x`,
`\timing`, `\copy`, `\i`, `\watch`, tab completion and command history.

- The password is taken from the SecretStorage and handed over as
  `PGPASSWORD`; it never appears on a command line, in the terminal or in a
  file, and the terminal is not restored after a window reload.
- A `search_path` set with **Show / Edit search_path** applies to the console
  as well.
- On Windows the console is switched to the Windows code page (`chcp`) before
  psql starts, so umlauts and quotation marks are displayed correctly.
- `psql` is looked up on `PATH` and, on Windows, in
  `Program Files\PostgreSQL\<version>\bin` (newest first). Point
  `postgresQueryBuilder.psqlPath` at it if it lives elsewhere.

---

## The PL/pgSQL formatter

The extension registers a formatter for the languages `sql`, `plpgsql` and
`pgsql`, so `Shift+Alt+F` and *Format Document* work on them.

It re-indents, wraps and re-cases, and it never rewrites what the code does.
String literals, dollar-quoted bodies and comments survive verbatim, and a
dollar-quoted body that looks like PL/pgSQL is formatted as well. Afterwards
the result is compared token by token against the input: if anything other than
whitespace and casing changed, the result is discarded and the file is left
untouched.

What it does is configurable — casing of keywords, identifiers and data types,
indent style and width, leading or trailing commas, blank lines, the point at
which a list is broken across lines, which data type aliases are normalised and
which function calls are broken into argument groups. The settings live under
`postgresQueryBuilder.format.*` and, for a whole repository, in a
`.pgformat.json` next to the sources; the command **Export Formatter Settings
to .pgformat.json** writes your current settings into one. Formatting on save
stays off until you switch on `postgresQueryBuilder.format.formatOnSave`.

The same formatter ships as the CLI `pgformat`, for a single file, a whole
directory or a pipe:

```bash
pgformat --file src/functions/order.sql
pgformat --directory sql --recursive
cat order.sql | pgformat --stdin
```

and as a language server (`dist/server.js`), so an editor that speaks LSP can
use it too.

---

## AI assistants (MCP)

The extension brings an MCP server, so GitHub Copilot — in VS Code's chat, in
Copilot CLI and in agents built on the Copilot SDK — can work with your saved
connections. There is nothing to set up. The server runs inside VS Code,
listens on `127.0.0.1` only and accepts only requests carrying a token that
changes with every VS Code session.

Copilot reads its MCP servers from `~/.copilot/mcp-config.json`
(`$COPILOT_HOME` when set), and so does VS Code. The extension enters a small
bridge there as `postgres-query-booster` (`postgres-query-booster-insiders`
from VS Code Insiders). It runs with VS Code's own executable, so no Node.js
is needed, and passes every request on to the running VS Code window whose
workspace contains the agent's folder, or else to the one started last; VS Code
has to be running. The file holds no token, and other servers in it are left
alone. `postgresQueryBuilder.mcp.copilotCli` turns this off and removes the
entry again; VS Code's chat then lists the server as **PostgreSQL Query
Booster** instead, registered by the extension itself, so it never appears
twice. **Show MCP Server Status** shows whether the server runs, on which
port, and which of the two ways Copilot reaches it.

An assistant can list schemas and objects, describe tables, read `CREATE`
scripts and dependencies, explain and run queries, execute changes, open a
query in the Data Viewer, format SQL, run plpgsql_check, compare the repository
with the database, and work with bookmarked queries and custom column mappings.

**Nothing is allowed until you allow it, per connection.** Run **Select
Connection**, choose *Edit Connection* and tick under *AI access (Copilot /
MCP)* what an assistant may do on that database:

- *Read the database structure* — schemas, tables, `CREATE` scripts,
  dependencies, `EXPLAIN`, plpgsql_check, comparison with the repository
- *Read data* — `SELECT` queries in a read-only transaction, `EXPLAIN ANALYZE`,
  the Data Viewer, running bookmarked queries
- *Change data* — `INSERT`, `UPDATE`, `DELETE`, `MERGE` and function calls
- *Change the database structure* — `CREATE`, `ALTER`, `DROP`, `TRUNCATE`,
  `GRANT` and `REVOKE`

Bookmarked queries and custom column mappings belong to no connection — they
are shared by all of them — so an assistant may list, add and change them
without a permission of its own; Copilot asks before each such change as it
does for any tool. Running a bookmarked query needs *Read data* on the
connection it runs on.

**Ask before AI writes**, on by default, shows every change to the database in a dialog and
runs it only after you press *Run* — also when Copilot itself is set to run
tools without asking. Changes run in one transaction that is committed only
when every statement succeeds. Queries return at most
`postgresQueryBuilder.mcp.maxRows` rows and stop after
`postgresQueryBuilder.mcp.statementTimeout` seconds;
`postgresQueryBuilder.mcp.enabled` turns the server off.

---

## Commands

Every command lives in the Command Palette (`Ctrl+Shift+P`) under the category
**PostgreSQL Query Booster**:

| Command | Description |
|---------|-------------|
| New Connection | Open the connection form |
| Select Connection | Switch between the saved connections |
| Disconnect | Close the active connection |
| Show / Edit search_path | Show the `search_path` and override it |
| Refresh Table Explorer | Reload schemas and tables |
| Open Table | Open a table in the Data Viewer |
| Open SQL Editor | Open the panel for ad-hoc SQL |
| Open psql Console | Start `psql` for the active connection in a terminal |
| View Data | Run the `SELECT` under the cursor in the Data Viewer |
| New Query Builder | Open an empty Data Viewer on its [Query Builder](#query-builder) tab |
| Show MCP Server Status | Show whether the [MCP server](#ai-assistants-mcp) runs, its port, and its entry for Copilot CLI |
| Edit SELECT in Query Builder | Open the `SELECT` under the cursor on the Query Builder tab of a Data Viewer; *Apply to File* writes it back into the file |
| Execute Selection | Run exactly the selected text in the session of the SQL file; a selected `SELECT` opens in the Data Viewer |
| Execute File | Run every statement of the SQL file from top to bottom in its session; queries open in the Data Viewer |
| Add Export Instruction | Write an `-- @export` line above the query at the cursor from the export dialog, so *Execute File* exports it |
| Reset Database Session | Discard the session of the SQL file: settings, temporary tables, an open transaction |
| Format PL/pgSQL | Format the current SQL file |
| Export Formatter Settings to .pgformat.json | Write the current formatter settings into a file |
| Bookmark Query... | Store the statement under the cursor |
| Run Bookmarked Query... | Pick a bookmarked query and run it |
| Edit Bookmarked Query... | Change name, tags, scope, statement and placeholders of a bookmark |
| Manage Bookmarked Queries... | Open the panel for scope, tags and placeholder metadata |
| Manage Custom Column Mappings... | Open the mappings panel |
| Import / Export Custom Column Mappings... | Exchange mappings as a file |
| Go to Database Object | Find a function, type, table or other object by name and reveal it in its view |
| Refresh Objects | Reload the *Objects* view from the database |
| Show Only Differences to the Repository | Hide the objects the database and the repository both have |
| Rescan Repository | Read the `CREATE` statements of the workspace's SQL files again |
| Reveal in Objects View | Select the object under the cursor in the *Objects* or *Tables* view |
| Compare with Database | Show the `CREATE` statement of the repository next to the one of the database |
| Find Usages | List every place in the repository that uses the object |
| Show Dependencies | Show what uses the object and what it uses in the *Dependencies* view |
| Compare Repository with Database | Compare every routine, table, view, type, sequence and trigger and list the differences in the *Comparison* view |
| Export Comparison Report | Write the result of the comparison as Markdown |
| Open ALTER TABLE Script | For a table of the *Comparison* view that differs: open the statements that bring the database to the repository, never run |
| Copy ALTER TABLE Script | The same script on the clipboard |
| Clear Comparison | Empty the *Comparison* view and remove its marks |
| Check File with plpgsql_check | Check the PL/pgSQL of the SQL file on the plpgsql_check connection |
| Select plpgsql_check Connection | Choose the connection files are checked against |
| Debug Function | Debug a PL/pgSQL function or procedure with a call you enter |
| Debug Statement | Debug the statement at the cursor |

Bookmarked queries and mappings carry further commands for renaming,
duplicating, deleting and moving between the personal and the workspace scope.
The entries of the *Objects* and *Tables* views carry **Open CREATE Script**,
**Copy CREATE Script**, **Open DROP Script**, **Copy DROP Script** and **Go to
Definition in Repository** in their context menu; tables and views of the
*Tables* view also carry **Open in Query Builder**. Their title bars carry **Show
Empty Schemas** / **Hide Empty Schemas**.

---

## Keyboard shortcuts

| Shortcut | Where | What it does |
|----------|-------|--------------|
| `Ctrl+Enter` | SQL editor, query bar | Run the query |
| `Ctrl+Alt+Enter` | SQL files | Execute the selected text |
| `Ctrl+Shift+Alt+Enter` | SQL files | Execute the whole file |
| `Enter` | Filter inputs | Apply the column filter |
| `Ctrl+A` | Data Viewer grid | Select every cell of the loaded rows |
| `Ctrl+Shift+A` | Data Viewer grid | Load every row, then select every cell; asks first above `dataViewer.loadAllWarningRows` rows |
| `Alt+←` / `Alt+→` | Single record view | Previous / next row |
| `Esc` | Dialogs | Close |
| `Shift+Alt+F` | SQL files, query bar | Format |
| `Ctrl+Space` | SQL files, query bar | Show the autocomplete suggestions |

---

## Settings

| Setting | Default | What it does |
|---------|---------|--------------|
| `postgresQueryBuilder.defaultHost` | `localhost` | Host a new connection form starts with |
| `postgresQueryBuilder.defaultPort` | `5432` | Port a new connection form starts with |
| `postgresQueryBuilder.defaultDatabase` | `postgres` | Database a new connection form starts with |
| `postgresQueryBuilder.psqlPath` | empty | `psql` used by the console; empty searches `PATH` and the default install folders. User or machine setting only, never read from a workspace |
| `postgresQueryBuilder.thousandSeparator` | space | Separator numbers are displayed with: space, non-breaking space, `.`, `'` or none. The decimal mark is always a comma, so a comma cannot be used |
| `postgresQueryBuilder.alwaysQualifySchema` | `false` | Always write the schema into generated `SELECT`s |
| `postgresQueryBuilder.alwaysQuote` | `false` | Always quote identifiers in generated `SELECT`s |
| `postgresQueryBuilder.completion.enable` | `true` | Autocomplete tables, columns, functions and keywords in SQL files |
| `postgresQueryBuilder.completion.tableAlias` | `true` | Write the alias after a table completed after `FROM` or `JOIN` |
| `postgresQueryBuilder.duplicateRowResetDefaults` | `volatile` | Which columns a duplicated row leaves to their database default |
| `postgresQueryBuilder.messages.clearOnExecute` | `false` | Clear the log of a session in the *PostgreSQL Messages* panel each time **Execute File** or **Execute Selection** starts in it; the panel's **Clear on Execute** checkbox sets it too |
| `postgresQueryBuilder.messages.showContext` | `errorsAndWarnings` | Which messages in the *PostgreSQL Messages* panel show their `CONTEXT:` line: `always`, `errorsAndWarnings` or `never`; the panel's **Context** drop-down sets it too |
| `postgresQueryBuilder.dataViewer.loadAllWarningRows` | `100000` | Above this many rows, `Ctrl+Shift+A` in the Data Viewer asks before loading them all; `0` never asks |
| `postgresQueryBuilder.selectHistory.maxEntries` | `500` | How many queries the **Select History** view keeps (10–10000); the oldest beyond that are dropped |
| `postgresQueryBuilder.savedQueriesFile` | `postgres-query-builder.queries.json` | Where shared bookmarked queries are kept |
| `postgresQueryBuilder.customMappingsFile` | `postgres-query-builder.mappings.json` | Where shared column mappings are kept |
| `postgresQueryBuilder.format.enable` | `true` | Whether the formatter is offered at all |
| `postgresQueryBuilder.format.formatOnSave` | `false` | Format SQL files when they are saved |
| `postgresQueryBuilder.objectNavigator.objectKinds` | all kinds | Which kinds of objects the *Objects* view lists |
| `postgresQueryBuilder.objectNavigator.showExtensionObjects` | `false` | Also list the functions, types and other objects of extensions |
| `postgresQueryBuilder.ddl.includeComments` | `true` | Write `COMMENT ON` into CREATE scripts |
| `postgresQueryBuilder.ddl.includeOwner` | `true` | Write `ALTER … OWNER TO` into CREATE scripts |
| `postgresQueryBuilder.ddl.includeGrants` | `true` | Write `GRANT` into CREATE scripts |
| `postgresQueryBuilder.repository.compare` | `true` | Compare the *Objects* and *Tables* views with the `CREATE` statements of the workspace |
| `postgresQueryBuilder.repository.include` | `**/*.sql`, `**/*.pgsql`, `**/*.psql` | Files scanned for `CREATE` statements |
| `postgresQueryBuilder.repository.exclude` | `**/node_modules/**`, `**/.git/**` | Files and folders left out of the scan |
| `postgresQueryBuilder.repository.maxFileSizeKb` | `5120` | Larger files are not scanned |
| `postgresQueryBuilder.repository.codeLens` | `true` | Show above each `CREATE` whether the database has the object, with Compare and Reveal |
| `postgresQueryBuilder.repository.compareIgnoresComments` | `true` | Leave comments out of both sides of **Compare with Database** |
| `postgresQueryBuilder.repository.compareIgnoresTypeSpelling` | `true` | Treat `varchar` and `character varying` and the other spellings of a type as the same when code is compared |
| `postgresQueryBuilder.comparison.columnOrder` | `false` | Report a different column order in **Compare Repository with Database** |
| `postgresQueryBuilder.plpgsqlCheck.onSave` | `true` | Check a SQL file with plpgsql_check when it is saved |
| `postgresQueryBuilder.plpgsqlCheck.onType` | `false` | Also check while typing |
| `postgresQueryBuilder.plpgsqlCheck.delayMs` | `1500` | Wait after the last change or auto save before checking |
| `postgresQueryBuilder.plpgsqlCheck.timeoutMs` | `10000` | `statement_timeout` of a check |
| `postgresQueryBuilder.plpgsqlCheck.replaceExisting` | `true` | Check the file's routines as if they replaced the database's: other versions of the same name are renamed out of the way for the check, instead of reporting *already exists* or *is not unique* |
| `postgresQueryBuilder.plpgsqlCheck.extraSeverity` | `information` | How extra, performance, security and compatibility warnings are shown |
| `postgresQueryBuilder.plpgsqlCheck.*` | as plpgsql_check | `fatalErrors` (`false`), `otherWarnings`, `extraWarnings`, `constantTracing`, `useIncommentOptions` (`true`), `performanceWarnings`, `securityWarnings`, `compatibilityWarnings`, `withoutWarnings` (`false`): the options of `plpgsql_check_function` |
| `postgresQueryBuilder.editor.hover` | `true` | Show the hover on database objects in SQL files |
| `postgresQueryBuilder.editor.signatureHelp` | `true` | Show the parameters while typing the arguments of a call |
| `postgresQueryBuilder.editor.outlineGroupBySchema` | `true` | Group the outline of a SQL file by schema; off lists every object flat as `schema.name` |
| `postgresQueryBuilder.diagnostics.unknownRoutines` | `false` | Warn about calls of unknown routines and wrong argument counts |
| `postgresQueryBuilder.diagnostics.docComments` | `false` | Check the doc comments of functions and procedures |
| `postgresQueryBuilder.mcp.enabled` | `true` | Offer the MCP server to Copilot and other AI assistants in VS Code |
| `postgresQueryBuilder.mcp.maxRows` | `500` | Most rows a query returns to an AI assistant |
| `postgresQueryBuilder.mcp.statementTimeout` | `30` | `statement_timeout` in seconds of what an AI assistant runs |
| `postgresQueryBuilder.mcp.copilotCli` | `true` | Enter the MCP server in `~/.copilot/mcp-config.json`, through which Copilot CLI, Copilot SDK agents and VS Code's chat reach it; off, VS Code's chat gets it registered by the extension |

The formatter brings around twenty further settings under
`postgresQueryBuilder.format.*`; the settings UI describes each of them, and
all of them can be moved into a `.pgformat.json`.

---

## Requirements

- VS Code 1.101 or newer
- Network access to a PostgreSQL server
- For the psql console only: the PostgreSQL client tools (`psql`)
- For checking PL/pgSQL only: the `plpgsql_check` extension in the database
- For debugging only: the `pldbgapi` extension and `plugin_debugger` in the
  server's `shared_preload_libraries`

Passwords are kept in the SecretStorage of VS Code, not in `settings.json`, and
nothing is sent anywhere except to the database you connect to.

---

## Contributing

Issues and pull requests are welcome in
[the repository](https://github.com/MegaCoolBlood/PostgresQueryBuilder).

- `npm test` runs the test suite
- `npm run lint` runs eslint
- Read [STYLEGUIDE.md](STYLEGUIDE.md) before changing any user interface

## License

[MIT](LICENSE)
