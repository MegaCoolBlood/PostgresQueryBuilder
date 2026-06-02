# Changelog

## 0.2.0

- Lange Kontextmenüs in der Tabellenansicht sind jetzt scrollbar und werden innerhalb des Viewports positioniert (öffnen bei Bedarf nach oben).
- Datenansicht zeigt jetzt eine Zeilennummernspalte (`#`) vor den Aktionen an.
- Query-History ist jetzt ein durchsuchbares Typeahead-Panel (breiter, scrollbar, mit Tastatur-Navigation und Treffer-Hervorhebung) statt eines schmalen Dropdowns.
- Rechtsklick auf einen Spaltenkopf öffnet ein Kontextmenü, mit dem sich der `ORDER BY`-Teil der aktuellen Query setzen, erweitern oder entfernen lässt (ASC/DESC, Replace/Add). Ist die Spalte bereits Teil der `ORDER BY`-Klausel, gibt es zusätzlich „Remove `col` from ORDER BY".
- Spaltenfilter (Enter) und „Add as Exact Match to Query" überschreiben nicht mehr die eigene SELECT-Anweisung: bestehende `WHERE`-Bedingungen bleiben erhalten, nur eine vorhandene Bedingung für dieselbe Spalte wird ersetzt; andere Bedingungen und `ORDER BY` bleiben unverändert.

## 0.1.0

- Initial release
- PostgreSQL connection management
- Table explorer with schema browsing
- Table data viewer
- SQL editor with query execution
- Table search
