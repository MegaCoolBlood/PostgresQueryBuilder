# PostgreSQL Query Builder

A VS Code extension for browsing, editing, and managing PostgreSQL databases directly from the editor.

## Features

- **Connection Management** – Add, edit, delete and switch between multiple PostgreSQL connections with secure password storage
- **Table Explorer** – Browse schemas and tables in a dedicated sidebar tree view
- **Table Data Viewer** – View, sort, filter, edit, insert, duplicate and delete rows in a full-featured data grid
- **SQL Editor** – Write and execute arbitrary SQL queries with tabular result display
- **Table Search** – Filter tables in real-time by name or schema prefix
- **Foreign Key Navigation** – Jump between related tables via FK links and context menus
- **Change Preview** – Preview generated SQL (UPDATE/INSERT/DELETE) before committing

---

## Getting Started

1. Open the **PostgreSQL Explorer** panel from the Activity Bar (database icon)
2. Run the command **"PostgreSQL: Connect to PostgreSQL Database"** from the Command Palette (`Ctrl+Shift+P`)
3. Fill in the connection form (Name, Host, Port, Database, Username, Password)
4. After connecting, schemas and tables appear in the tree view
5. Click any table to open the data viewer

---

## Connection Management

| Action | How to trigger |
|--------|----------------|
| Add connection | Command Palette → *Connect to PostgreSQL Database* |
| Edit connection | Command Palette → *Select Connection* → choose connection |
| Delete connection | Managed via connection selection |
| Switch connection | Click the status bar item (bottom left) or Command Palette → *Select Connection* |
| Disconnect | Command Palette → *Disconnect from PostgreSQL Database* |

### Connection Form Fields

| Field | Required | Description |
|-------|----------|-------------|
| Connection Name | Yes | Display name for this connection |
| Host | Yes | Hostname or IP address |
| Port | Yes | PostgreSQL port (default: 5432) |
| Database | Yes | Database name (default: postgres) |
| Username | Yes | PostgreSQL user |
| Password | No | Stored securely in VS Code SecretStorage |
| Schemas | No | Comma-separated list of schemas to show (all if empty) |

- SSL is attempted automatically; falls back to non-SSL if unsupported
- Hostnames are resolved via the OS resolver (respects `/etc/hosts`)

### Status Bar

The status bar (bottom left) shows the current connection state:
- **Connected**: `🗄 connection-name` – click to switch connections
- **Disconnected**: `🗄 Disconnected` – click to select a connection

---

## Table Explorer

The sidebar tree view shows:

```
📁 Schema A
   📋 table_one
   📋 table_two
📁 Schema B
   📋 table_three
```

- System schemas (`pg_catalog`, `information_schema`, `pg_toast`) are hidden by default
- If a connection defines specific schemas, only those appear
- Click the **↻ Refresh** button in the view title bar to reload
- Click a table to open the **Table Data Viewer**

---

## Table Search

The **Search** panel below the tree provides real-time table filtering:

- Type a table name to filter across all schemas
- Use `schema.table` notation to filter by schema prefix
- Filtering is debounced (200ms) for a smooth experience

---

## Table Data Viewer

Opening a table displays an interactive data grid with full CRUD capabilities.

### Viewing Data

- Loads **50 rows per page** – click **Load More** to fetch the next batch
- Total row count is displayed in the toolbar
- Column headers show **name + data type**

### Sorting

- Click a column header to sort ascending
- Click again to sort descending
- Sort indicator shows the current direction

### Filtering

- Each column has a **filter input** below the header
- Type a value and press **Enter** to query the database with a `WHERE` clause (case-insensitive `ILIKE`)
- Multiple column filters are combined

### Inline Editing

- Click any cell to edit its value directly
- Modified cells are highlighted visually
- The status bar shows pending changes: *"Pending: X modified, Y inserted, Z duplicated, W deleted"*

### Row Operations

| Action | Button | Description |
|--------|--------|-------------|
| Insert row | **+ Insert Row** | Adds an empty row at the bottom |
| Duplicate row | **⧉** | Copies the current row's values into a new editable row |
| Delete row | **✕** | Marks the row for deletion (strikethrough) |
| Undelete row | **↩** | Restores a row marked for deletion |

### Committing Changes

1. Click **Save** to generate a SQL preview
2. Review the generated `UPDATE` / `INSERT` / `DELETE` statements in the preview dialog
3. Click **Execute** to commit (runs in a transaction with automatic rollback on error)
4. Click **Discard Changes** to reset all pending modifications

### Foreign Key Navigation

- FK columns show a **↗** button in the cell – click to open the referenced table filtered to that value
- Right-click a cell for the **context menu**:
  - *Add as Exact Match to Query* – filter by this value
  - *Exclude this Value from Query* – add a `!=` filter
  - *Open Primary Key (schema.table.column)* – navigate to the referenced row
  - *Open Foreign Key (schema.table.column)* – navigate to referencing tables

### Custom Query

- The query bar shows the current SQL (`SELECT * FROM "schema"."table" LIMIT 50 OFFSET 0`)
- Edit the SQL and click **▶ Run** or press **Enter** to execute arbitrary queries
- Results replace the table data; title shows *(custom query)*

---

## SQL Editor

Open via Command Palette → **"PostgreSQL: Open SQL Editor"**

- Full-width text area for writing SQL
- Execute with the **▶ Execute** button or **Ctrl+Enter**
- Results are shown in a table below with column headers and row data
- Row count and errors are displayed clearly

---

## Keyboard Shortcuts

| Shortcut | Context | Action |
|----------|---------|--------|
| `Ctrl+Enter` | SQL Editor | Execute query |
| `Enter` | Table View – Query bar | Run custom query |
| `Enter` | Table View – Filter inputs | Apply column filter |

---

## Commands

All commands are available via the Command Palette (`Ctrl+Shift+P`) under the **PostgreSQL** category:

| Command | Description |
|---------|-------------|
| PostgreSQL: Connect to PostgreSQL Database | Open connection form |
| PostgreSQL: Disconnect from PostgreSQL Database | Close current connection |
| PostgreSQL: Select Connection | Switch between saved connections |
| PostgreSQL: Refresh Table Explorer | Reload schemas and tables |
| PostgreSQL: Open Table | Open a table in the data viewer |
| PostgreSQL: Open SQL Editor | Open the SQL query editor |

---

## Extension Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `postgresQueryBuilder.defaultHost` | string | `localhost` | Default host for new connections |
| `postgresQueryBuilder.defaultPort` | number | `5432` | Default port for new connections |
| `postgresQueryBuilder.defaultDatabase` | string | `postgres` | Default database name |
| `postgresQueryBuilder.savedConnections` | array | `[]` | Saved connection configurations |
| `postgresQueryBuilder.alwaysQualifySchema` | boolean | `false` | Always include schema in generated SELECT table references |
| `postgresQueryBuilder.alwaysQuote` | boolean | `false` | Always quote identifiers in generated SELECT statements |

---

## Requirements

- VS Code 1.85 or later
- Network access to a PostgreSQL server
