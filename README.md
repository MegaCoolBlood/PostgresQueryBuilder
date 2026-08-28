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
- **Bookmark queries.** Keep a query for yourself or share it with your team
  through a file in `.vscode/`; placeholders are filled in every time it runs.
- **Export what you see.** CSV, Excel, JSON, XML or ready-made `INSERT`
  statements — always the complete result, not just the page you loaded.
- **Format PL/pgSQL.** A formatter for `sql`, `plpgsql` and `pgsql` that never
  changes what your code means, configurable per repository and available as a
  standalone CLI.

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

SSL is attempted first and falls back to an unencrypted connection when the
server does not offer it. Hostnames are resolved by the operating system, so
`/etc/hosts` applies.

Several connections can be saved and switched from the status bar item at the
bottom left, which also shows which database you are currently looking at.
**Show / Edit search_path** displays the `search_path` of the active connection
and lets you override it.

---

## Tables and search

The *Tables* view lists the schemas and their tables. The system schemas
`pg_catalog`, `information_schema` and `pg_toast` stay hidden, and if a
connection names specific schemas, only those are shown. **Refresh** in the
title bar reloads the tree; a click on a table opens it.

The *Search* view below it filters the tables while you type, across all
schemas, and understands the `schema.table` notation.

---

## The Data Viewer

Opening a table opens a grid with the first 50 rows, the total row count and
the time the query took. **Load More** fetches the next 50, **Load All** the
rest. Column headers carry the name and the data type, and the comment of a
column as a tooltip.

### Finding rows

- **Sort** by clicking a column header, click again to reverse.
- **Filter** in the row underneath the headers. Text columns match
  case-insensitively, numeric and date columns offer `=`, `<>`, `<`, `<=`, `>`,
  `>=` and *between*. Several filters are combined with `AND`. Filter values
  are sent as query parameters and never pasted into the SQL.
- **Constraints** stores a `WHERE` condition and an `ORDER BY` per table that
  are applied every time you open it — for the client, tenant or valid-from
  column you filter by anyway.
- **Reorder columns** by dragging a header; the `SELECT` list in the query bar
  follows.
- The **query bar** shows the SQL behind the grid. Edit it and press
  `Ctrl+Enter` to run whatever you like; the grid stays editable as long as its
  rows can be traced back to one table.

### Editing rows

- Click a cell to edit it. Modified cells are marked, and the toolbar counts
  what is pending.
- A long value opens in a real editor tab with syntax highlighting through
  **Open Value in Editor** — saving the tab writes the value back, closing it
  discards it, emptying it sets the cell to `NULL`.
- **View Full Record** shows a single row as a form, one field per line, with
  data type, primary and foreign key badges, a character counter for
  length-limited columns and arrows to step through the result.
- Insert, duplicate and delete rows from the row toolbar. A deleted row is
  struck through until you save and can be restored until then.
- **Save** shows the generated statements before anything happens. You can edit
  them; **Execute** then runs them in one transaction that rolls back
  completely on the first error, and every `UPDATE` and `DELETE` is checked to
  hit exactly one row.
- Views, materialized views and results that cannot be traced back to a table
  are read-only and say so. A table without a primary key stays editable but is
  marked, because its rows have to be matched by their values.

### Getting somewhere else

- A foreign key cell offers the jump to the row it points at; the context menu
  offers the way back to every table pointing at this row.
- **Custom column mappings** add that jump where the database has no foreign
  key — including composite keys and mappings that only apply to rows meeting a
  condition. They are kept personally or shared with the workspace.
- A cell value can be added to the query as an exact match or as an exclusion
  straight from the context menu.

### Joins

The join builder assembles a query across several tables: add the tables,
reorder them by dragging, name their aliases, choose `INNER`, `LEFT`, `RIGHT`,
`FULL` or `CROSS`, and take the join condition from the foreign keys that
already exist between them. Further conditions and self-joins are possible, the
SQL is shown while you build it, and the result opens as an ordinary grid.

### Export

**Export** writes the complete result of the current query — filters included —
as CSV (separator, quoting and line endings configurable), as Excel with an
optional sheet holding the executed SQL, as JSON, as XML or as `INSERT`
statements with a batch size of your choice. Your choices per format can be
kept as the default.

---

## Bookmarked queries

A query you will need again goes into the **Bookmarked Queries** view, either
for yourself or into `.vscode/postgres-query-builder.queries.json`, which you
can commit so that everyone on the team has it.

Placeholders written as `:name` are asked for when the query runs, and the
values are remembered for the session. Every placeholder has a kind — text,
number, identifier or raw — so its value ends up in the SQL properly quoted
instead of merely concatenated. A bookmarked query can be dragged into an
editor to insert its SQL.

---

## SQL editor and SQL files

- **Open SQL Editor** gives you a panel for ad-hoc SQL: write it, run it with
  `Ctrl+Enter`, read the result underneath, format it with one button.
- In a `.sql` file, **View Data** takes the `SELECT` your cursor sits in and
  opens it in the Data Viewer. PL/pgSQL variables inside the statement are
  recognised and asked for — column names that merely look like variables are
  not.
- **Bookmark Query** stores the statement under the cursor.

Every statement that changes data — from the grid, the query bar or the SQL
editor — is recorded in the **Modify History** view with its table and its
timestamp, so you can see afterwards what ran and copy it back out.

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
| View Data | Run the `SELECT` under the cursor in the Data Viewer |
| Format PL/pgSQL | Format the current SQL file |
| Export Formatter Settings to .pgformat.json | Write the current formatter settings into a file |
| Bookmark Query... | Store the statement under the cursor |
| Run Bookmarked Query... | Pick a bookmarked query and run it |
| Manage Custom Column Mappings... | Open the mappings panel |
| Import / Export Custom Column Mappings... | Exchange mappings as a file |

Bookmarked queries and mappings carry further commands for renaming,
duplicating, deleting and moving between the personal and the workspace scope.

---

## Keyboard shortcuts

| Shortcut | Where | What it does |
|----------|-------|--------------|
| `Ctrl+Enter` | SQL editor, query bar | Run the query |
| `Enter` | Filter inputs | Apply the column filter |
| `Alt+←` / `Alt+→` | Single record view | Previous / next row |
| `Esc` | Dialogs | Close |
| `Shift+Alt+F` | SQL files | Format |

---

## Settings

| Setting | Default | What it does |
|---------|---------|--------------|
| `postgresQueryBuilder.defaultHost` | `localhost` | Host a new connection form starts with |
| `postgresQueryBuilder.defaultPort` | `5432` | Port a new connection form starts with |
| `postgresQueryBuilder.defaultDatabase` | `postgres` | Database a new connection form starts with |
| `postgresQueryBuilder.thousandSeparator` | space | Separator numbers are displayed with |
| `postgresQueryBuilder.alwaysQualifySchema` | `false` | Always write the schema into generated `SELECT`s |
| `postgresQueryBuilder.alwaysQuote` | `false` | Always quote identifiers in generated `SELECT`s |
| `postgresQueryBuilder.duplicateRowResetDefaults` | `volatile` | Which columns a duplicated row leaves to their database default |
| `postgresQueryBuilder.savedQueriesFile` | `.vscode/postgres-query-builder.queries.json` | Where shared bookmarked queries are kept |
| `postgresQueryBuilder.customMappingsFile` | `.vscode/postgres-query-builder.mappings.json` | Where shared column mappings are kept |
| `postgresQueryBuilder.format.enable` | `true` | Whether the formatter is offered at all |
| `postgresQueryBuilder.format.formatOnSave` | `false` | Format SQL files when they are saved |

The formatter brings around twenty further settings under
`postgresQueryBuilder.format.*`; the settings UI describes each of them, and
all of them can be moved into a `.pgformat.json`.

---

## Requirements

- VS Code 1.85 or newer
- Network access to a PostgreSQL server

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
