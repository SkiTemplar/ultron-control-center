# ULTRON Cleanup Report — 2026-05-02

> Task 13 formal inventory — generated at end of v12.4 plan execution session.

---

## Deleted (permanent)

| File / Directory | Registry | Reason |
|---|---|---|
| `.agents/skills/unreal-engine/SKILL.md` | `.agents` | Byte-identical duplicate of `ue5-dev/SKILL.md` (SHA256: 3C88422F…). Created erroneously by Task 6D. |
| `.claude/skills/unreal-engine/SKILL.md` | `.claude` | Same duplicate, same SHA256. |
| `.codex/skills/unreal-engine/SKILL.md` | `.codex` | Same duplicate, same SHA256. |

**Effect:** Registry counts corrected: Claude=369, Codex=368, Agents=368.

---

## Archived (moved, not deleted)

Archive root: `C:\Users\USER\.ultron\archive\cleanup-2026-05-02\`

### `global/` → `archive/cleanup-2026-05-02/global/`
- `skill-registry.md` — canonical skill map; superseded by `.ultron-vault/30_PATTERNS/skill-tree.md`
- `ultra-mode.md`, `learning-mode.md`, `cockpit-config.md` — merged into SKILL.md / brain_config.py

### Other archived files (16 total)
- `activity.jsonl` — log from deprecated Activity tracker module
- `auth-vault.dpapi` + `.bak` — deprecated Auth Vault module
- `newsletter_template.html` — moved to news-publisher skill
- `projects.json.*.bak` (×3) — backup artifacts from Projects migration
- `REGISTRY-CLEANUP-2026-04-29.md` — previous cleanup log
- `settings.local.json` — stale local override (superseded by settings.json)
- `skills-registry.json` — superseded by `.ultron/skill_manifest.json`
- `github-sync/`, `obsidian-vault/`, `scripts/` subdirs — legacy structure

---

## Stale entries removed from code/config

| Entry | File | Action |
|---|---|---|
| `skill_66dc2b17` | `ULTRON_SYNC.md` | Removed — was ghost entry, ue5-dev is the canonical skill |
| `T-33 routing-tests` | `SKILL.md` routing section | Removed — referenced non-existent test fixture |
| `TodoWrite/TaskCreate` ambiguity | `SKILL.md` line 329 | Clarified to TodoWrite |

---

## Registry state (post-cleanup)

| Registry | Count | Notes |
|---|---|---|
| `.claude/skills/` | 369 | Includes 2 Claude-exclusive: `claude-skills`, `everything-claude-code` |
| `.codex/skills/` | 368 | Excludes Claude-exclusive skills |
| `.agents/skills/` | 368 | Excludes Claude-exclusive skills |

**Unsynced (intentional):**
- `claude-skills` — Claude-internal skill library; no equivalent in Codex/Agents
- `everything-claude-code` — CC-specific memory/OWASP harness

---

## Vault state (post-cleanup)

| Layer | Location | Count |
|---|---|---|
| L1 hot | `~/.ultron/INDEX.md` | 160 notes indexed (FTS5) |
| L2 vault | `~/.ultron-vault/` | 513 .md notes |
| L2 CC-memories | `~/.ultron-vault/CC-memories/` | 67 files (63 CC project memories) |
| L3 remote | `github.com/SkiTemplar/ultron-memory` | Pushed as of 2026-05-02 |

---

## Open cleanup debt

These are deferred — do NOT delete without explicit approval:

| Item | Location | Why deferred |
|---|---|---|
| Orphan git worktree `agent-ab8c425fe827d7b67` | `.claude/` | Windows file lock — needs admin or process kill |
| `activity.jsonl` originals | `.ultron/archive/` | Archived but kept; may have historical signal |
| Legacy v6.x dir | `.ultron/archive/v6.x-legacy/` | Historical reference — never delete |
| Triple-debate-schema.json TODO | `skill_cache/` | Design incomplete, not blocking |

---

## Commits pushed (this session)

| Hash | Message |
|---|---|
| `fbd92c6` | fix: remove duplicate unreal-engine skill from Claude registry |
| `a5f3c5c` | fix: mark claude-skills + everything-claude-code as Claude-exclusive |
| `f67a2e1` | fix: remove skill_66dc2b17 entry — resolved as ue5-dev duplicate |

---

*Generated: 2026-05-02 by ULTRON Kirkardo audit session*
