---
description: "Rules for AI-generated Git commit messages in this repository."
applyTo: "**"
---

# Commit message rules

Follow [Conventional Commits v1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) strictly.

- Format: `<type>[optional scope]: <description>`
- `type` is one of: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`,
  `build`, `ci`, `chore`, `revert`.
- `description` is lower-case, imperative mood ("add", not "added"/"adds"), no
  trailing period, and fits on one line (~72 chars).
- Add a scope in parentheses when the change is limited to one area, using the
  module name (e.g. `feat(plpgsqlFormatter): ...`, `fix(tableWebView): ...`).
- Add a body (separated by a blank line) explaining *why*, only when the
  change is not self-explanatory from the description.
- Use `!` after the type/scope and a `BREAKING CHANGE:` footer for breaking changes.
- Never invent a scope or type that doesn't match the actual change.
- Write the message in English.
