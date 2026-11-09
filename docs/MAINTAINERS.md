# MAINTAINERS — internal-only scripts and tools

This document enumerates the **maintainer-only** tooling in the ULTRON tree.
None of these scripts are invoked by:

- The Claude Code hooks under `~/.claude/settings.json`
- The Control Center desktop app (Tauri + React)
- `doctor.py` or `health.py`
- Any user-facing wizard / installer prompt

They exist so the project maintainer (`@SkiTemplar`) can:

1. **Validate a release** before tagging (drift guards, leak scanners).
2. **Cut a release** (tag automation, orphan release cleanup).
3. **Audit or evaluate** ad hoc (memory evals, detector benches).

Most of them carry a `# === maintainer-only (not user-facing) ===` comment
block above the docstring, so a `grep` on that string returns the canonical
set.

Pruned on 2026-10-08: the tables only list files that exist. Removed since
the previous revision: `audit_silent_exec.py`, `persona-benchmark-runner.py`,
`routing-test-runner.py`, `new-project.ps1` (root), `init-memory.ps1`,
`background_tasks.py`, the Stop-hook scripts `session-log.py`,
`session-cleanup.{ps1,sh}` and `stop-memory-sync.{ps1,sh}`, and the
self-improve stats panel (`self_improve.rs`).

---

## CI / pre-release guards

| Tool | Purpose | Invocation |
|---|---|---|
| `scripts/cockpit/version_propagate.py` | Version drift guard. The SSOT version lives in `pyproject.toml` `[project].version` (the 15.x monorepo line) and is compared against the two installers (`install.ps1`, `install.sh`), the install wizard, and version pins in the docs/badges. **The Control Center is decoupled**: the three CC manifests (`control-center/package.json`, `Cargo.toml`, `tauri.conf.json`) carry their own line and are checked only for internal consistency with each other via `CC_TARGETS`, never against the SSOT. Wired into `.github/workflows/ci.yml § version-drift`. | `uv run python scripts/cockpit/version_propagate.py --check` |
| `scripts/cockpit/audit_personal_data.py` | Pre-publish leak scanner. Walks every `git ls-files` entry for the author's name, home path, email, persona / agent slugs. Exit 1 on any HIGH finding (CI and pre-commit gate). `--history` scans every blob reachable from any ref. | `uv run python scripts/cockpit/audit_personal_data.py [--strict] [--history]` |
| `hooks/regen-manifest.js` | Mirrors `~/.claude/settings.json` into `hooks/manifest.json` and `templates/settings-hooks.json`; `--check` fails on drift (pre-commit gate). | `node hooks/regen-manifest.js [--check]` |
| `scripts/run-selftests.mjs` | Runs the selftests classified in `scripts/selftests.manifest.json`; `--check` fails on an unclassified selftest (pre-commit), `--ci` runs the hermetic ones (CI). | `node scripts/run-selftests.mjs [--check\|--ci]` |

## Release automation

| Tool | Purpose | Invocation |
|---|---|---|
| `scripts/cut-release.ps1` | Local-only release driver: verifies clean main, bumps coherent versions, creates an annotated (optionally signed) tag, pushes the tag. The GitHub Actions workflow takes over from the tag push. Documented in `docs/RELEASE-PROCESS.md`. | `.\scripts\cut-release.ps1 -NewVersion v15.5.15 [-DryRun] [-NoSign]` |
| `scripts/delete-orphan-releases.ps1` | One-shot GitHub Releases admin tool: deletes Release entries whose tag has already been removed (GitHub does not auto-cascade). Needs a PAT with `repo` scope. | `$env:GITHUB_TOKEN = '<token>'; .\scripts\delete-orphan-releases.ps1 [-Tags @('v15.4.17')]` |
| `scripts/sync-public.mjs` | Syncs the private monorepo into the public mirror (`ultron-control-center`). | `node scripts/sync-public.mjs` |

## Memory eval & webponize tooling

No Control Center / hook / CI caller: manual invocation only.

| Tool | Purpose | Invocation |
|---|---|---|
| `scripts/golden-v2-ab.mjs` | A/B of the memory cross-encoder reranker: runs `ultron-memory.exe eval --golden <path>` twice (`ULTRON_RERANK=0` and `=1`) and compares recall@8/precision/MRR/nDCG/context_waste. Warns instead of declaring a tie when both passes are identical (sign that the daemon read the flag at startup). | `node scripts/golden-v2-ab.mjs [golden-path] [--only 0\|1]` |
| `scripts/golden-v2-pool.mjs` | Builds the candidate pool for the v2 recall golden set from real prompts in `~/.claude/logs/orchestrate.jsonl`; writes `pool.json` and `labeling.md`. Followed by `golden-v2-compile.mjs`. | `node scripts/golden-v2-pool.mjs [--n 30] [--k 10] [--kx 4] [--days 30]` |
| `scripts/new-web.mjs` | Scaffold for a `webponize` web project: creates `cockpit/projects/web-<slug>/`, registers it in `cockpit/projects.json` and adds the pipeline card through `scripts/kanban.mjs`. Next manual step: `scripts/deploy-variants.mjs`. | `node scripts/new-web.mjs <slug> "<Business>" [--tipo <sector>] [--maps <url>] [--tier front\|front+backend]` |
| `scripts/tricolon-bench.js` | Regression bench for the "rule of three" pattern of the AI-text catalogue (`docs/research/patrones-texto-ia.json`), using the production compiler (`hooks/scripts/lib/ai-text-detector.js`). Warns on lookaround (Rust `regex` does not support it, so the JS detector and the Rust Lab would diverge). | `node scripts/tricolon-bench.js ['<candidate-regex>']` |

## Standalone tools without a runtime caller

| Tool | Purpose | Invocation |
|---|---|---|
| `scripts/skill-discovery.py` | Scans `~/.claude/skills/` for skills not mapped in the FAST PATH tables. | `uv run python scripts/skill-discovery.py [--verbose]` |
| `scripts/memory-audit.py` | Manual audit of the Claude Code auto-memory files (`~/.claude/projects/*/memory/*.md`): missing frontmatter, invalid type, duplicates, stale entries, orphans in `MEMORY.md` (see `docs/protocols.md`). | `uv run python scripts/memory-audit.py [--fix-index]` |
| `scripts/consistency_check.py` | Internal-consistency checks of the system. No hook calls it any more. | `uv run python scripts/consistency_check.py [--quiet]` |
| `scripts/ultron-paths.ps1` | PowerShell sibling of `ultron_paths.py`. Nothing dot-sources it today. | `. scripts/ultron-paths.ps1; $UltronPaths.brain_index_db` |
| `scripts/cockpit/ultron.ps1` | Manual CLI over the cockpit scripts (see `docs/COMMANDS.md` §4). | `scripts\cockpit\ultron.ps1 help` |

## Manual multi-CLI consensus tooling

| Tool | Purpose | Invocation |
|---|---|---|
| `scripts/shared-duet.ps1` | Manual launcher for the dual/triple peer-consensus pattern: writes per-peer `cmd.exe` launchers, runs CLI peers in parallel and resumes them across rounds via `-SessionIds`. The `gemini` peer is dead (Google retired the free-tier OAuth); use `-Peers codex`. | `.\scripts\shared-duet.ps1 -Peers codex -Mode Dual -Round 1 -Prompt "..."` |

## Gray-area scripts (user-facing, not maintainer-only)

These have at least one production caller:

| Script | Callers |
|---|---|
| `scripts/cockpit/deadwood_scanner.py` | Maintenance `deadwood-scan`, `doctor` checks, `ultron deadwood` |
| `scripts/cockpit/skill_sync_security.py` | Maintenance `skill-security-audit`, `doctor` checks, `ultron security` |
| `scripts/cockpit/skill_provenance.py` | `doctor` drift check and auto-repair, `ultron security provenance` |
| `scripts/cockpit/registry_sync.py` | Maintenance `registry-sync`, `ultron skills registry` / `sync` |
| `scripts/cockpit/cache_telemetry.py`, `token_baseline.py` | `doctor` checks |
| `scripts/setup-git-hooks.ps1` | `install.ps1` (wires `.git/hooks/` from `git-hooks/`) |

---

## Disk Hygiene

### Quarantine directories

Wave-based refactors leave behind `_cleanup_quarantine_<YYYY-MM-DD>`
directories directly under `~/.ultron/`. Use `scripts/cleanup-quarantine.ps1`
to inspect and manage them.

| Task | Command |
|---|---|
| Report sizes (read-only, safe) | `.\scripts\cleanup-quarantine.ps1` |
| Compress dirs larger than 1 GB | `.\scripts\cleanup-quarantine.ps1 -AutoCompress -WhatIf` (preview) then `-Force` to execute |
| Delete entries older than 4 weeks | `.\scripts\cleanup-quarantine.ps1 -PurgeExpired` (WhatIf by default); add `-Force` to delete |
| Compress all and delete sources | `.\scripts\cleanup-quarantine.ps1 -Apply -Force` |

**Safety rules:**

- `-PurgeExpired` always runs in WhatIf mode unless `-Force` is also passed.
- No deletion happens without a `.zip` archive being confirmed on disk first
  (for `-Apply` and `-AutoCompress`).
- Never pass `~/.ultron/.fastembed_cache` to this script (see below).

### .fastembed_cache policy

`~/.ultron/.fastembed_cache` (override: `ULTRON_FASTEMBED_CACHE`) holds the
ONNX model weights that `fastembed` downloads for dense recall (E5 and the
cross-encoder, see `control-center/src-tauri/src/qdrant.rs`). Delete it only
with the `ultron-memory` sidecar stopped; the next dense use re-downloads the
models. With `ULTRON_DENSE=0` nothing reads it.
