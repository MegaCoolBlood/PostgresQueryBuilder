# Changelog

## 0.2.0

- Lange Kontextmenüs in der Tabellenansicht sind jetzt scrollbar und werden innerhalb des Viewports positioniert (öffnen bei Bedarf nach oben).
- Datenansicht zeigt jetzt eine Zeilennummernspalte (`#`) vor den Aktionen an.
- Query-History ist jetzt ein durchsuchbares Typeahead-Panel (breiter, scrollbar, mit Tastatur-Navigation und Treffer-Hervorhebung) statt eines schmalen Dropdowns.
- Rechtsklick auf einen Spaltenkopf öffnet ein Kontextmenü, mit dem sich der `ORDER BY`-Teil der aktuellen Query setzen, erweitern oder entfernen lässt (ASC/DESC, Replace/Add). Ist die Spalte bereits Teil der `ORDER BY`-Klausel, gibt es zusätzlich „Remove `col` from ORDER BY".
- Spaltenfilter (Enter) und „Add as Exact Match to Query" überschreiben nicht mehr die eigene SELECT-Anweisung: bestehende `WHERE`-Bedingungen bleiben erhalten, nur eine vorhandene Bedingung für dieselbe Spalte wird ersetzt; andere Bedingungen und `ORDER BY` bleiben unverändert.
- Beim Öffnen einer verknüpften Tabelle (FK/PK/Custom Mapping) und bei „Add as Exact Match to Query" wird der Wert nur noch in die SELECT-Klausel gemergt — die Filterzeile bleibt leer (statt automatisch mit dem Wert vorbefüllt zu werden).
- Neues Panel **Modify History** unter dem Search-Panel: zeigt persistent (bis 500 Einträge) alle ausgeführten ändernden Statements (INSERT/UPDATE/DELETE/MERGE/TRUNCATE/CREATE/DROP/ALTER/GRANT/REVOKE/COMMENT/REFRESH/CALL) aus Tabellen-Commits, der Query-Bar der Datenansicht und dem SQL-Editor. Klick auf einen Eintrag kopiert das SQL, „Clear" leert die Historie.
- Tabellenansicht zeigt in der Toolbar die Verbindung an, mit der die aktuell sichtbaren Daten geladen wurden (wird bei jedem SELECT-Lauf aktualisiert). Wechselt die aktive Verbindung danach, wird die Anzeige als Warnung markiert.
- Der „SQL Preview / Execute"-Dialog der Tabellenansicht zeigt jetzt die aktuelle Verbindung und die Verbindung, mit der die Daten geladen wurden. Unterscheiden sich beide, erscheint ein deutlich sichtbarer Warnhinweis, dass die Ausführung gegen die aktive Verbindung läuft.
- Benutzerdefinierte Spalten-Verknüpfungen (Custom Mappings) werden jetzt in beide Richtungen angezeigt: ein Mapping `A.col → B.col` erscheint auch in der Tabelle `B` als „Jump to A.col (reverse)" im Zellen-Kontextmenü sowie als nur-lesbarer Eintrag mit Badge „Reverse" im Manage-Dialog. Bearbeitet/gelöscht werden Mappings weiterhin nur auf der ursprünglichen Quell-Tabelle.
- Custom Mappings lassen sich jetzt **über git mit Kollegen teilen**: jedes Mapping hat einen Scope „Personal" (wie bisher, lokal pro Benutzer in VS Code globalState) oder „Workspace" (gespeichert in `.vscode/postgres-query-builder.mappings.json` im Workspace und damit committable). Im Mapping-Dialog gibt es eine Checkbox „Share with workspace (commit to git)"; der Manage-Dialog zeigt Badges „Workspace"/„Personal". Der Pfad zur Workspace-Datei ist über die Einstellung `postgresQueryBuilder.customMappingsFile` konfigurierbar; Änderungen an der Datei (z. B. nach `git pull`) werden via FileSystemWatcher erkannt und alle offenen Tabellenansichten aktualisiert. Zusätzlich gibt es die Befehle „PostgreSQL: Export/Import Custom Column Mappings..." und „PostgreSQL: Open Workspace Custom Mappings File" für ad-hoc Austausch.

## 0.1.0

- Initial release
- PostgreSQL connection management
- Table explorer with schema browsing
- Table data viewer
- SQL editor with query execution
- Table search
