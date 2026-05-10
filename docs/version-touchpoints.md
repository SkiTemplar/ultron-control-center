# Version Touchpoints — Inventory

Discovered during Sprint 0 / Group F (2026-05-04). This is input for **Sprint 4 — Manifest** (`skills.manifest.yaml`), where these touchpoints become the single source of truth and downstream files are generated from the manifest.

**Current release:** v13.3.0 "CLEAN HOUSE" — Sprint 0 close.
**Previous:** v13.2.0 "TRUST FIX".

---

## Live version touchpoints (must bump on every release)

| File | Line | Pattern | Notes |
|---|---|---|---|
| `~/.claude/skills/ultron/SKILL.md` | 3 | `version: vX.Y.Z` (frontmatter) | Skill manifest field — primary SSOT pre-manifest. |
| `~/.claude/skills/ultron/SKILL.md` | 5 | `ULTRON vX.Y.Z "Name"` (description block) | Echoed in Skill registry. |
| `~/.claude/skills/ultron/SKILL.md` | 14 | `# ULTRON vX.Y.Z "Name" — Index` | First-page header — USER's eye-level. |
| `~/.claude/skills/ultron/CLAUDE.md` | 1 | `# ULTRON vX.Y.Z "Name" — Claude Code Agent` | Top banner. |
| `~/.claude/skills/ultron/CLAUDE.md` | 78 | `## CAPACIDADES ACTIVAS vX.Y.Z` | Active capabilities header. |
| `~/.claude/skills/ultron/CLAUDE.md` | 117 | `## CAPACIDADES PENDIENTES vX.Y.Z` | Pending capabilities header. |
| `~/.claude/skills/ultron/mode-ultra.md` | 1 | `# ULTRON — ULTRA MODE 💀 · vX.Y.Z (NAME)` | Mode banner. |
| `~/.claude/skills/ultron/mode-high.md` | 1 | same pattern | Mode banner. |
| `~/.claude/skills/ultron/mode-medium.md` | 1 | same pattern | Mode banner. |
| `~/.claude/skills/ultron/mode-low.md` | 1 | same pattern | Mode banner. |
| `~/.claude/skills/ultron/mode-learn.md` | 1 | same pattern | Mode banner. |
| `~/.claude/skills/ultron/references/version-policy.md` | 11 | `\| **ultron** \| vX.Y.Z \|` (table row) | Version policy authoritative table. |
| `~/.claude/CLAUDE.md` | 1 | `# CLAUDE.md (User Global) — ULTRON vX.Y` | Loaded EVERY session — most-visible touchpoint. |
| `~/.ultron/INDEX.md` | 1 | `# ULTRON vMAJOR — INDEX (L1 hot)` | L1 memory header. |
| `~/.ultron/INDEX.md` | 3 | `> **Slim index vX.Y.Z "Name"** · YYYY-MM-DD` | L1 subtitle. |
| `~/.ultron/MEMORY.md` | 1 | `# ULTRON MEMORY vX.Y · árbol compacto` | MEMORY orient header. |

## Cockpit / scripts

| File | Line | Pattern | Notes |
|---|---|---|---|
| `~/.claude/skills/ultron/scripts/cockpit/tui.py` | 580 | `"""ULTRON vX.Y.Z CORE — terminal interface to all CORE subsystems."""` | TUI App docstring. |
| `~/.claude/skills/ultron/scripts/cockpit/tui.py` | 583 | `TITLE = "ULTRON CORE vX.Y.Z"` | Window title (visible to USER). |
| `~/.claude/skills/ultron/scripts/cockpit/tui.py` | 619 | `Static("[dim]CORE vX.Y.Z[/dim]")` | Sidebar version label — **root cause of USER's "Sale CORE en Cockpit con la 12.5"**. |
| `~/.claude/skills/ultron/scripts/cockpit/tui.py` | 804 | `"Ultron, /high kirkardo audit del sistema ULTRON vX.Y.Z hoy"` | Hardcoded Kirkardo audit prompt. |
| `~/.claude/skills/ultron/scripts/cockpit/ultron.ps1` | 1 | `# ULTRON vX.Y.Z CORE - Central command (CENTRALITA)` | Header comment (was 8 versions stale). |

## Telemetry rolling files (bump per sprint)

| File | Line | Pattern | Notes |
|---|---|---|---|
| `~/.ultron/telemetry/v14-overhaul/sprint-0-baseline-post.json` | 3 | `"ultron_version": "vX.Y.Z"` | Finalize from `pending-review` at sprint close. |
| `~/.ultron/telemetry/v14-overhaul/sprint-0-diff.md` | 7 | `\| ultron_version \| vOLD \| vNEW \| — \|` | PRE→POST diff row. |

## Historical (DO NOT TOUCH on release)

| File | Pattern | Notes |
|---|---|---|
| `~/.claude/skills/ultron/references/changelog.md` | All historical entries (v12.5.0-fix1/fix2, v13.2.1, v11.x, v10.x, v3-v4, etc.) | append-only, NEVER edit. |
| `~/.claude/skills/ultron/scripts/cockpit/*.py` | Comments like `# v13.2 (Sprint 4 F11)`, `# FIX-A (v13.2):`, `# v12.5.0-fix2 (F9):` | code change-log markers, semantic, not stale. |
| `~/.claude/skills/ultron/hooks/*.py` | Comments like `# F05 (v13.2): PowerShell destructive cmdlets...` | same — historical markers in code. |
| `~/.ultron/cockpit/audits/*.md` | All `kirkardo-*-2026-*.md` files | frozen audit records. |
| `~/.ultron/cockpit/audits/.tmp/*` | All round-output files | frozen audit transcripts. |
| `~/.ultron/cockpit/audits/INDEX.json` | `target` fields with version strings | targets are immutable historical anchors. |
| `~/.ultron/plans/ULTRON-v13.x-*.md`, `ULTRON-v12.6-*.md`, `ULTRON-roadmap-*.md`, `ULTRON-v14.0-*.md` | All version mentions inside | historical planning docs. |
| `~/.ultron/plans/2026-05-04-sprint-0-cleanup.md` (PowerShell snippets that mention `v13.2.0`/`v12.5.0` as pre-bump expectations) | code blocks | historical execution plan, preserved verbatim. |
| `~/.ultron/sessions/**/*.txt` | Any version mentions in session transcripts | frozen session captures. |
| `~/.ultron/news/news_*.html` | Mentions of `ULTRON CORE v11.1.0` etc. | published news, frozen. |
| `~/.ultron/backups/2026-05-04-pre-S0/**` | Anything inside | snapshot, frozen. |
| `~/.ultron/skill_cache/**` | `CORE` references inside third-party skill files | not ours. |
| `~/.ultron/cockpit/install-gitleaks.ps1`, `~/.ultron/cockpit/.gitleaks.toml` | Header `ULTRON v12.5.0-fix2 (F5) — gitleaks ...` | retained (was the version when feature shipped — file content not changed since). |
| `~/.ultron/cockpit/pending_actions.json` | `text` fields mentioning `v13.2 Trust Fix:`, `v13.0`, `v12.5`, etc. | append-only pending-actions log. |
| `~/.ultron/telemetry/v14-overhaul/sprint-0-baseline-pre.json` | `"ultron_version": "v13.2.0"` | frozen PRE-baseline (snapshot). |
| `~/.ultron/cockpit/audits/kirkardo-self-improve-metrics-*.json` | `version` fields | metrics snapshots. |
| `~/.claude/projects/**/*.jsonl` | Chat transcripts | not ours. |

## Manifest plan (Sprint 4)

When `skills.manifest.yaml` exists, the manifest holds:

```yaml
ultron:
  version: 13.3.0
  release_name: "CLEAN HOUSE"
  release_date: 2026-05-04
  prev_version: 13.2.0
  prev_release_name: "TRUST FIX"
```

A pre-commit / pre-release script will template-generate the live touchpoints from this manifest, eliminating drift. Specifically:

1. Replace each "Live version touchpoint" via templated comment markers (e.g., `<!-- ULTRON_VERSION_BANNER -->v13.3.0 "CLEAN HOUSE"<!-- /ULTRON_VERSION_BANNER -->`) so a regex script can swap atomically.
2. Cockpit `tui.py` reads version from a single `__version__` constant injected from the manifest at module import (or a `version.py` generated module).
3. `ultron.ps1` reads version from `(Get-Content version.txt)` instead of having it hard-coded in a comment.
4. `version-policy.md` table generated from manifest skill list (one row per skill).
5. Validator script (`validate_versions.py`) called from a pre-commit hook fails if any tracked file has a version banner that disagrees with the manifest.

## Drift detected in Sprint 0

| Drift | File:Line | Severity | Notes |
|---|---|---|---|
| Cockpit showed CORE v12.5.0 in 4 places (USER flagged "Sale CORE en Cockpit con la 12.5") | `tui.py:580,583,619,804` | HIGH (visible to user) | Bumped 2026-05-04 to v13.3.0. |
| `ultron.ps1` header was `v11.1.0` — 8 minor versions stale | `ultron.ps1:1` | MEDIUM (rarely seen) | Bumped to v13.3.0. |
| `SKILL.md:14` index header was `v12.5.0 "The Brain Update"` while frontmatter line 3 said `v13.2.0` | `SKILL.md:14` | HIGH (split-brain in single file) | Bumped to v13.3.0 "Clean House". |
| `CLAUDE.md` capability sections labelled `v13.1.0` while top banner said `v13.2.0` | `CLAUDE.md:78,117` | MEDIUM | Bumped to v13.3.0. |
| `INDEX.md` slim-index date was `2026-05-03` and version `v12.5.0` while MEMORY.md said `v13.2` | `INDEX.md:1,3` | MEDIUM | Bumped to v13.3.0 / 2026-05-04. |
| Telemetry `sprint-0-baseline-post.json` and `sprint-0-diff.md` left at `v13.3.0-pending-review` | telemetry | LOW (telemetry only) | Finalized to `v13.3.0`. |

## Lessons learned

- **9 of 22 live touchpoints had drifted** — version SSOT is impossible to maintain by hand at this scale. Sprint 4 manifest is critical, not nice-to-have.
- **Every TUI/cockpit script that has its own version label must read from a generated source**, not hard-code.
- **Comment markers > raw strings** for tracked banners — let a regex find them deterministically.
- **PowerShell 5.1 `Set-Content -Encoding utf8` adds BOM** — original Sprint 0 plan used it for SKILL.md/CLAUDE.md edits. Group F deliberately used the `Edit` tool (BOM-preserving) instead. Document this risk in Sprint 1's encoding policy.
