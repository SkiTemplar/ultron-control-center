# ULTRON Vault

This is your personal markdown vault, like an Obsidian notebook. ULTRON
indexes it with `brain_index.py` (SQLite FTS5 in
`~/.ultron/brain_index/index.db`) so the cockpit scripts can search it.

The governed memory that Claude Code sessions use is a different store:
`~/.ultron/brain.db` (SQLite + FTS5), written only by the `ultron-memory`
sidecar. Dense recall over Qdrant (`ultron_memory` collection) is optional
and can be turned off with `ULTRON_DENSE=0`.

## Conventions
- Markdown only (.md). Wikilinks `[[note-name]]` are supported.
- One topic per file. Title at top: `# Topic`.
- Folders organize by category (10_KNOWLEDGE, 20_DECISIONS, etc).
- Add a YAML frontmatter when needed; otherwise plain markdown works.

## Next steps
1. Create a note: `your-first-note.md` with `# My first note` and any content.
2. Run `uv run python ~/.ultron/scripts/cockpit/brain_index.py update`.
3. Search it: `uv run python ~/.ultron/scripts/cockpit/brain_index.py query "first note"`.

This is YOUR vault. ULTRON only reads it; it never modifies it without
explicit instruction.
