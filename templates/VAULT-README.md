# ULTRON Vault

This is your personal markdown vault, like an Obsidian notebook.

The governed memory that Claude Code sessions use is a different store:
`~/.ultron/brain.db` (SQLite + FTS5), written only by the `ultron-memory`
sidecar, with keyword (FTS5) recall.

## Conventions
- Markdown only (.md). Wikilinks `[[note-name]]` are supported.
- One topic per file. Title at top: `# Topic`.
- Folders organize by category (10_KNOWLEDGE, 20_DECISIONS, etc).
- Add a YAML frontmatter when needed; otherwise plain markdown works.

## Next steps
1. Create a note: `your-first-note.md` with `# My first note` and any content.

This is YOUR vault. ULTRON only reads it; it never modifies it without
explicit instruction.
