# ULTRON Vault

This is your personal markdown vault — like an Obsidian notebook. ULTRON
uses it as L2 memory: notes here are indexed by `brain_index.py` (FTS5)
and embedded into Qdrant (`ultron_vault` collection) for semantic recall.

## Conventions
- Markdown only (.md). Wikilinks `[[note-name]]` are supported.
- One topic per file. Title at top: `# Topic`.
- Folders organize by category (10_KNOWLEDGE, 20_DECISIONS, etc).
- Add a YAML frontmatter when needed; otherwise plain markdown works.

## Next steps
1. Create a note: `your-first-note.md` with `# My first note` and any content.
2. Run `uv run python ~/.ultron/scripts/cockpit/brain_index.py update`.
3. The Memory tab in the Control Center should now find your note.

This is YOUR vault. ULTRON only reads it for memory recall — never modifies
without explicit instruction.
