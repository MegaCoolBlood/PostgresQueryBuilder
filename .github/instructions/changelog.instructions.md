---
description: "Use when adding or editing an entry in CHANGELOG.md for the PostgreSQL Query Booster extension — release notes, version headings, wording and language rules."
applyTo: "CHANGELOG.md"
---

# Changelog entries

This changelog is written **for the user**, not for the committer. It is not
Keep-a-Changelog: there are no `Added` / `Fixed` / `Changed` sections, no dates,
no commit hashes, no issue or PR references, no contributor names.

## Structure

```markdown
## 3.0.1

- **Short claim in the user's language, ending with a colon:** One paragraph
  that first says what was wrong or missing before and why it hurt, then what
  happens now instead. Mention the button, menu entry or setting by its exact
  user-visible name in *italics* or quotes, and put identifiers, SQL and file
  names in `code`.

    - **A sub-aspect of the same change:** Sub-bullets are indented four spaces
      and follow the same bold-claim-then-explanation shape. Use them only to
      break down one large change, never as a flat list of small ones.
```

- Heading is `## <major>.<minor>.<patch>` and nothing else — no `v`, no date, no
  link. Newest version directly under `# Changelog`.
- One blank line between top-level bullets.
- Order bullets by how much the user will care, not by commit order.

## Voice

- **Problem first, then resolution.** "A cell whose value the column cannot
  store used to be noticed only when saving failed … it is now outlined in red
  as soon as the cell is left." A bullet that only states the new feature is
  incomplete.
- Full sentences, present tense, plain prose. No bullet fragments, no
  "Implemented X", no "This PR …".
- Describe **behaviour**, not implementation. A file name, class or function
  name appears only when the user meets it (`.pgformat.json`, a setting key, a
  command title). Internals go in the commit message instead.
- Technical detail is welcome when it explains *why* the fix works — see the
  formatter entries under `## 2.1.1` and `## 2.1.3` — but it stays subordinate
  to the user-visible effect.
- Reassure about compatibility when something is renamed: say explicitly that
  stored data, files, settings and keybindings keep working.

## Language

Entries are **English** — all of them, including the historical ones. The German
entries of version 2.0.4 and older were translated in 3.0.3; never write a new
entry in German.

## Scope

One entry per release, covering everything since the previous heading. Do not
add an `Unreleased` section — the entry is written together with the version
bump (see the `/release` prompt).
