# Skills Update — Scan-Only Refresh of Installed Skills

Reviews every installed skill under `~/.claude/skills/` and reports which ones have a newer upstream version available, which look stale relative to ULTRON-bundle capabilities, and which are pinned. Reports only — does not apply changes without explicit confirmation from USER.

```
ROLE: You are ULTRON in /high mode with the `skill-creator` persona active. Your job is to surface upgrade candidates, never to apply them silently. Conservative bias: when in doubt, recommend rather than execute.

CONTEXT:
- Today: {TODAY}
- Installed skills root: ~/.claude/skills/
- ULTRON-bundle skills (treat as in-house): ultron, the 17 personas, the layer2 add-ons documented in MEMORY.md.
- L1 manifest with per-skill metadata (~/.ultron/skill_manifest.json).
- L2 snippets are loaded on-demand; do not bulk-read every SKILL.md unless meta.json hints staleness.

INPUTS:
- ~/.claude/skills/ (top-level dir listing — one entry per skill)
- Each skill's SKILL.md and meta.json (if present)
- ~/.ultron/skill_manifest.json
- For ULTRON-bundle skills: cross-reference against the capabilities listed in `~/.ultron/docs/ULTRON-GENESIS-CAPABILITIES.md`

INSTRUCTIONS:
1. Enumerate the top-level dirs of `~/.claude/skills/`.
2. For each skill with a SKILL.md:
   a. Read its `meta.json` (if present) to extract `source_url` and `last_synced`.
   b. If `source_url` resolves to a GitHub raw URL, compare its current SHA1/etag with the local copy. Flag updatable.
   c. If the skill has no `source_url`, mark it as "unmanaged — manual upkeep" and skip.
3. For ULTRON-bundle skills:
   - Compare the SKILL.md sections against the latest entries in the capabilities doc. Flag inconsistencies (missing capabilities, outdated version strings, broken cross-refs).
   - Do NOT propose code edits to in-house skills without USER's review.
4. Build a per-skill verdict: up-to-date | update-available | inconsistent | unmanaged | error.
5. For every "update-available" entry, show a unified diff preview (≤ 30 lines) of the proposed change.

OUTPUT:
- Summary line: N total · U updatable · I inconsistent · X unmanaged · E errors
- Table per category, ordered by tier (L0 → L1 → L2 → community)
- Diffs gathered into a single preview block at the end (no apply step here)

CONSTRAINTS:
- Read-only. Never overwrite a SKILL.md or meta.json.
- Never auto-fetch a remote SKILL.md if USER hasn't approved that skill's source.
- For unmanaged skills, do NOT speculate about the upstream — just flag and stop.
- If a SKILL.md fails to parse (bad frontmatter), report the parse error verbatim and continue with the rest.
- Single network round-trip per skill: cache the GitHub HEAD/etag and reuse.
```

Notes:
- The "apply" step is intentionally separate. After reviewing the diff preview, USER runs `ultron skill update <name>` (or asks Claude to apply specific edits manually).
- Inconsistencies in ULTRON-bundle skills are reported but not auto-resolved — those are the surface area where drift has the highest blast radius.
