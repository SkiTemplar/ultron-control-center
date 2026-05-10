# Sprint 0 — Final Report (2026-05-04)

**Status:** ✅ DONE
**Version bump:** v13.2.0 (TRUST FIX) → v13.3.0 (CLEAN HOUSE)

## Groups completed

- **A:** Plugin cleanup (17→13). Removed `claude-mem@thedotmack`, `pensyve@major7apps-pensyve`, `code-simplifier@claude-plugins-official`, `context7@claude-plugins-official` from `~/.claude/settings.json`.
- **B:** Cruft folder deletion under `~/.ultron/` (`archive/v6.x-legacy/`, `archive/deprecated-memory-system/`, `archive/skill_installs/20260430-coding-sync/`, `archive/cleanup-2026-05-02/`, `_knowledge-deprecated-v12.5/`, `.tmp.driveupload/`, `hooks/push-async.log`). Backed up at `~/.ultron/backups/2026-05-04-pre-S0/`.
- **B.5:** Legacy `~/.ultron/knowledge/` folder migration — hash-verified byte-identical with vault L2 `~/.ultron-vault/10_KNOWLEDGE/` (18 files SHA256 match), zipped to `knowledge-legacy.zip` (71050 bytes), then deleted. SKILL.md line 218 patched to reflect TRUTH (folder was supposedly archived in v12.5 but never was).
- **C:** MCP cleanup (9→8). Removed `mcpServers.memory` (redundant with `brain_index` + vault L2).
- **D:** `settings.local.json` review (no changes required).
- **E + E.5:** Orphan marketplace refs purgadas. `agents/subagent-routing.md:33` corregido (`code-simplifier:code-simplifier` → `pr-review-toolkit:code-simplifier o skill agent-skills:code-simplify`). Changelog wording fix. Codex peer re-review GREEN-LIGHT.
- **F:** Version bump + `~/.ultron/docs/version-touchpoints.md` inventory created. Drift detected and fixed in cockpit, modes, INDEX, MEMORY, CLAUDE.md (user global), version-policy, and tui.py.

## Touchpoints bumped

22 live touchpoints updated (full inventory in `~/.ultron/docs/version-touchpoints.md`):

- Skill manifest: `SKILL.md:3,5,14`
- Skill agent doc: `~/.claude/skills/ultron/CLAUDE.md:1,78,117`
- Mode banners: `mode-ultra.md:1`, `mode-high.md:1`, `mode-medium.md:1`, `mode-low.md:1`, `mode-learn.md:1`
- Version-policy table: `references/version-policy.md:11`
- User global agent: `~/.claude/CLAUDE.md:1`
- L1 memory: `~/.ultron/INDEX.md:1,3`
- MEMORY orient: `~/.ultron/MEMORY.md:1`
- Cockpit (USER's flagged drift): `scripts/cockpit/tui.py:580,583,619,804`
- Cockpit dispatcher comment: `scripts/cockpit/ultron.ps1:1`
- Telemetry: `sprint-0-baseline-post.json:3`, `sprint-0-diff.md:7`
- Changelog: extended `v13.3.0 (pending peer review)` stub at `references/changelog.md:2142` → final "CLEAN HOUSE" entry with Group F summary.

## Drift caught

- **Cockpit "CORE v12.5"** (root cause of USER's flag "Sale CORE en Cockpit con la 12.5"): `tui.py` had v12.5.0 hardcoded in 4 places (App docstring, `TITLE`, sidebar `Static`, Kirkardo prompt) — visible to USER every time he opened the TUI.
- **`ultron.ps1:1`** header was `v11.1.0` — 8 minor versions stale.
- **`SKILL.md:14`** said `v12.5.0 "The Brain Update"` while frontmatter (line 3) said `v13.2.0` — split-brain in single file.
- **`CLAUDE.md` capability sections** labelled `v13.1.0` while top banner said `v13.2.0`.
- **`INDEX.md`** slim-index date was 2026-05-03 / `v12.5.0` while MEMORY.md said `v13.2`.
- **Telemetry** files left at `v13.3.0-pending-review` placeholder — finalized.

## Reclaimed (from PRE→POST baseline)

| Metric | PRE | POST | Δ |
|---|---|---|---|
| Plugins | 17 | 13 | -4 |
| MCP servers | 9 | 8 | -1 |
| `settings.json` size | 5837 B | 5627 B | -210 B |
| `~/.ultron/` disk | 29.55 MB | 34.71 MB | +5.16 MB |

> Disk size *increased* because backup zips were deposited under `~/.ultron/backups/2026-05-04-pre-S0/` before deletes — net cleanup is on the source side, while backups are reversible. Backup zip total ≈ knowledge-legacy.zip (71 KB) + cruft tarballs.

## Open issues for next sprints

- **Hook errors observed at session compact:** `EEXIST` mkdir on `session-env`, parser error in `session-init.ps1:192` — surfaced during this very sprint's bash calls. **Sprint 1 (Silent Execution Audit) target.**
- **Cockpit `ultron sync` dispatcher bug** (positional arg parsing) → **Sprint 2 (Single Source of Truth dispatcher).**
- **Encoding mojibake risk on `changelog.md` when using PS 5.1 `Add-Content`** — Group F deliberately used the BOM-preserving `Edit` tool. **Document in Sprint 1 silent-execution-policy.md.**
- **Version manifest (Sprint 4)** is now justified by drift evidence: 9 of 22 live touchpoints had drifted to 3 different stale versions simultaneously. Manual maintenance is failing.

## Next

Sprint 1: Silent Execution Audit. Awaiting USER's go-signal.
