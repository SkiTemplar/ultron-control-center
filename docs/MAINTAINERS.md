# MAINTAINERS — internal-only scripts and tools

This document enumerates the **maintainer-only** tooling in the ULTRON tree.
None of these scripts are invoked by:

- The Claude Code hooks under `~/.claude/settings.json`
- The Control Center desktop app (Tauri + React)
- `doctor.py`, `health.py`, `auto_updater.py`, `background_tasks.py`
- The Windows `ULTRON-QdrantBoot` scheduled task
- The `ultron` PowerShell command (`scripts/cockpit/ultron.ps1`)
- Any user-facing wizard / installer prompt

They exist solely so the project maintainer (`@SkiTemplar`) can:

1. **Validate a release** before tagging (drift guards, leak scanners).
2. **Cut a release** (tag automation, orphan release cleanup).
3. **Audit the source tree** ad-hoc (silent-exec, personal-data, persona
   coverage, routing rules).

Each file is marked with a `# === maintainer-only (not user-facing) ===`
comment block above its docstring so a `grep` on that string returns the
canonical set.

Eval-8 will use this document as the source of truth when deciding whether
to migrate this tooling to a dedicated `scripts/dev/` or `tools/` tree. The
migration is **not done yet** in v15.5.14 — too many test / CI / RELEASE-
PROCESS references would need coordinated updates. The marker comment is
the cheap, reversible step that makes the future move safe.

---

## CI / pre-release guards

| Tool | Purpose | Invocation |
|---|---|---|
| `scripts/cockpit/version_propagate.py` | SSOT version drift guard. Reads `pyproject.toml` `[project].version`, compares against 6 other files (Cargo.toml, package.json, tauri.conf.json, both installers, README). Wired into `.github/workflows/ci.yml § version-drift`. | `uv run python scripts/cockpit/version_propagate.py --check` |
| `scripts/cockpit/audit_personal_data.py` | Pre-publish leak scanner. Walks every `git ls-files` entry for the author's name, home path, email, persona / agent slugs. Exit 1 on any HIGH finding (CI-gateable). | `uv run python scripts/cockpit/audit_personal_data.py [--strict]` |
| `scripts/cockpit/audit_silent_exec.py` | Read-only AST + regex audit that flags `subprocess.run/Popen` calls and PowerShell `Start-Process` invocations missing the silent-exec wrapper. CONTRIBUTING.md flags this as the starting point for the hooks-observability work. | `uv run python scripts/cockpit/audit_silent_exec.py [--exit-on-hits]` |

## Release automation

| Tool | Purpose | Invocation |
|---|---|---|
| `scripts/cut-release.ps1` | Local-only release driver: verifies clean main, bumps coherent versions, creates an annotated (optionally signed) tag, pushes the tag. The actual GitHub Actions workflow takes over from the tag push. Documented in `docs/RELEASE-PROCESS.md`. | `.\scripts\cut-release.ps1 -NewVersion v15.5.15 [-DryRun] [-NoSign]` |
| `scripts/delete-orphan-releases.ps1` | One-shot GitHub Releases admin tool — deletes Release entries whose tag has already been removed (GitHub does NOT auto-cascade). Needs a PAT with `repo` scope. Used after a botched tag cleanup. | `$env:GITHUB_TOKEN = 'ghp_…'; .\scripts\delete-orphan-releases.ps1 [-Tags @('v15.4.17')]` |

## Ad-hoc audits

| Tool | Purpose | Invocation |
|---|---|---|
| `scripts/persona-benchmark-runner.py` | Parses `references/persona-benchmarks.md`, reports coverage + structural validation. Run before any persona-set release. Stage 2 (LLM-as-judge) is future work. | `uv run python scripts/persona-benchmark-runner.py [--persona <slug>] [--validate-only]` |
| `scripts/routing-test-runner.py` | Regression harness for FAST PATH Layer 1 + tiebreaks (T-01..T-16, T-34, T-35). Run after every `config/intent-rules.yaml` edit. | `uv run python scripts/routing-test-runner.py [--verbose]` |

## Standalone bootstrap / scaffolders

These scripts have **no runtime caller** — they exist for manual one-off invocations during fresh-machine bootstrap, vault setup, or skill-catalog rebuilds. All four carry the `# === maintainer-only ===` marker.

| Tool | Purpose | Invocation |
|---|---|---|
| `scripts/skill-discovery.py` | One-off scan over `~/.claude/skills/` to detect skills not mapped in FAST PATH Layer 1/2. Run when rebuilding the routing catalog. | `uv run python scripts/skill-discovery.py [--verbose]` |
| `scripts/new-project.ps1` | Scaffolds a new project under `~/.ultron/projects/<name>/`. Not wired to Control Center — manual PowerShell invocation. | `powershell -File scripts/new-project.ps1 -Name "myproj" -Type "PERSONAL"` |
| `scripts/init-memory.ps1` | Bootstraps the vault layout on a fresh machine. `install.ps1` + `brain_index.py` do this automatically for end users; this is the manual maintainer/debug path. | `powershell -File scripts/init-memory.ps1` |
| `scripts/ultron-paths.ps1` | Dot-sourced path resolver SSOT (PowerShell sibling of `ultron_paths.py`). Not invoked directly — dot-sourced by hooks/scripts. | `. scripts/ultron-paths.ps1; $UltronPaths.brain_index_db` |

## Deprecated Stop-hook scripts (v15.5.16 consolidation sweep)

These scripts used to be wired directly into the Stop hook chain. As of v15.5.16
their bodies are inlined inside `scripts/hooks/stop-memory-sync.{ps1,sh}` so the
chain spends 2 fewer process launches per session (5 → 3). The files stay on
disk so maintainers can still invoke them manually or for parity audits.

| Tool | Inlined location | Manual invocation |
|---|---|---|
| `scripts/hooks/session-log.py` | `stop-memory-sync.{ps1,sh}` top block (after stdin parse, before debounce) | `uv run python scripts/hooks/session-log.py < /dev/null` |
| `scripts/hooks/session-cleanup.ps1` | `stop-memory-sync.ps1` tail block (before final `exit 0`) | `pwsh -File scripts/hooks/session-cleanup.ps1` |
| `scripts/hooks/session-cleanup.sh`  | `stop-memory-sync.sh` tail block (before final `exit 0`) | `bash scripts/hooks/session-cleanup.sh` |

## Gray-area scripts (NOT marked as maintainer-only)

The following were initially candidates but have at least one production
runtime caller and therefore **stay user-facing**:

| Script | Reason it's user-facing |
|---|---|
| `deadwood_scanner.py` | `doctor.py` (D17), `control-center/src-tauri/src/maintenance.rs`, `cockpit/ultron.ps1` command alias |
| `skill_sync_security.py` | `doctor.py`, control-center SecurityPanel, runtime quarantine guard |
| `skill_provenance.py` | `doctor.py` D-check + drift auto-repair |
| `registry_sync.py` | `ultron` command, multiple tests, build-time SSOT |
| `vault_migrator.py` | `ultron` command, migration tests |
| `frontmatter_backfill.py` | Skill toolchain — fixes drift surfaced by `skill_finder` |
| `dispatcher_audit.py` | Referenced in `health.py` allowlist |
| `audit_index.py` | Called by `auto_updater.py` (dashboard refresh) |
| `skill_summarizer.py` | `background_tasks.py` daily run |
| `cache_telemetry.py` / `memory_dedupe.py` / `token_baseline.py` / `prompt_eval.py` | All wired into `doctor.py` D-checks |
| `verify_claims.py` | Called by `ultron` command |
| `consistency_check.py` (scripts root) | Phase A of `stop-memory-sync.{ps1,sh}` |
| `memory-audit.py` (scripts root) | Auto-cleanup protocol (docs/protocols.md) |
| `setup-git-hooks.ps1` | Called from `install.ps1` to wire `.git/hooks/` |

---

## Future migration plan (deferred — eval-8 input)

When the team is ready to move the maintainer-only set to a dedicated
location:

1. Create `scripts/dev/` (or `tools/`).
2. `git mv` each `# === maintainer-only` script under that tree, preserving
   relative paths where downstream callers care:
   - `scripts/cockpit/version_propagate.py` → `scripts/dev/cockpit/version_propagate.py`
   - `scripts/cockpit/audit_personal_data.py` → `scripts/dev/cockpit/audit_personal_data.py`
   - `scripts/cockpit/audit_silent_exec.py` → `scripts/dev/cockpit/audit_silent_exec.py`
   - `scripts/cut-release.ps1` → `scripts/dev/cut-release.ps1`
   - `scripts/delete-orphan-releases.ps1` → `scripts/dev/delete-orphan-releases.ps1`
   - `scripts/persona-benchmark-runner.py` → `scripts/dev/persona-benchmark-runner.py`
   - `scripts/routing-test-runner.py` → `scripts/dev/routing-test-runner.py`
3. Update the following references in the **same commit** (otherwise CI breaks):
   - `.github/workflows/ci.yml` — `python scripts/cockpit/version_propagate.py --check`
   - `docs/RELEASE-PROCESS.md` — `./scripts/cut-release.ps1`
   - `tests/test_silent_exec.py` — `importlib.import_module("audit_silent_exec")`
   - `CONTRIBUTING.md` — link to `scripts/cockpit/audit_silent_exec.py`
   - This file (`docs/MAINTAINERS.md`) — update the table paths.
4. Remove the `# === maintainer-only (not user-facing) ===` markers (the
   directory itself now communicates the same fact).
5. Decide whether `_legacy/` (already empty-ish — it now houses the retired
   inner installers from v15.5.14) should fold into `scripts/dev/_legacy/`
   to keep all maintainer-only files under one root.

The marker comment is **non-destructive** — every script still runs from its
current path, every caller still resolves, no .gitignore change is needed.
The migration is a clean, atomic future step.

---

## Stats panel signals (Hook Signals → 6 sources, 3 dead by design)

`control-center/src-tauri/src/self_improve.rs::read_hook_signals` aggregates
six telemetry streams. Three fire rarely *by design* — do **not** treat them
as broken when the panel shows them stale:

| Source | Fires when | Typical interval |
|---|---|---|
| `prompt-feedback` | every Skill/Agent invocation | continuous |
| `token-usage` | every Claude turn | continuous |
| `hiper-plans` | a `hiper-plans` skill runs | rare |
| `doctor` | weekly only (`scripts/cockpit/doctor.py` cron, opt-in) | 7+ days |
| `auto_updater` | on-demand from the update banner | 7-30+ days |
| `mcp-audit` | weekly only (`scripts/cockpit/mcp-resilience.py` cron) | 7+ days |

The Settings → Notifications panel surfaces freshness only for the first
three. The last three are scheduled jobs, not realtime signals — their age
reflects schedule cadence, not health.
