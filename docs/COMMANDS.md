# ULTRON — Commands reference

A flat index of everything you can run, organised by surface:

1. [Control Center command palette](#1-control-center-command-palette-ctrlk) (`Ctrl+K`)
2. [Maintenance commands](#2-maintenance-commands)
3. [Cockpit Python toolkit](#3-cockpit-python-toolkit) (`uv run python scripts/cockpit/*.py`)
4. [The `ultron` shell alias](#4-the-ultron-shell-alias)
5. [Hooks](#5-hooks)

If you only read one section, read **§1** — the command palette is the fastest path to 90 % of what the system does.

> [!NOTE]
> **Platform notes (v15.5+).** Most things are cross-platform: the
> command palette, Python cockpit toolkit, hooks written in Python, the
> memory pipeline, and the bulk of the `ultron` shell alias all work on
> both Windows and Linux. Surfaces that are Windows-only are marked with
> **(Windows-only)** below. On Linux the Control Center hides those
> entries; running the underlying script directly is a no-op or errors
> cleanly. PowerShell-only helpers (`*.ps1`) do not run on Linux; their
> bash siblings (where they exist) are noted inline.

---

## 1. Control Center command palette (Ctrl+K)

Press `Ctrl+K` anywhere in the Control Center to open the fuzzy palette. Type a few letters and the right action surfaces. Categories:

| Category | Examples |
|---|---|
| **Navigate** | Go to Dashboard / Memory / Skills / Agents / Plans / Sessions / Projects / MCPs / Settings (and the "More" tier) |
| **Actions** | Refresh dashboard data · Open Settings · Close Control Center |
| **Diagnostics** | Run Full Diagnostic · Detect Pending Items · Run Doctor · PC Diagnose (last 24 h) · Codex Adversarial Review · Self-Improve Report |
| **AI** | Spawn Claude session · Spawn Codex session · Spawn Gemini session |
| **Maintenance** | (dynamic — pulled from `list_maintenance_commands_inner`, see §2) |
| **Memory** | Qdrant re-embed vault · Embed skills index |
| **System** | Rebuild Control Center · Uninstall ULTRON · Reset ULTRON mode to autodetect · Purge legacy autostart · Scan projects |

The palette is fuzzy: `skreg` matches `Skill registry rebuild`, `agreem` matches `Agents re-embed`. `↑↓` to navigate, `Enter` to fire, `Esc` to close.

---

## 2. Maintenance commands

Surfaced both in the palette (under `Maintenance ·`) and as buttons on the Dashboard. All run from the Tauri backend with `CREATE_NO_WINDOW` (Windows) or a detached spawn (Linux); results land in `~/.ultron/cockpit/audits/`.

| Kind | Platform | What it does |
|---|---|---|
| `skill-registry-rebuild` | cross | Re-scan `~/.claude/skills`, refresh `~/.ultron/skills/registry.json` with security verdicts. |
| `skill-security-audit` | cross | Run the prompt-injection scanner against every installed skill (JSON report). |
| `registry-sync` | cross | Rebuild the cross-CLI skill manifest (Claude / Codex / Agents mirrors). |
| `memory-vault-sync` | cross | Refresh `~/.ultron-vault` highlights + brain_index incremental update. |
| `brain-index-update` | cross | Incrementally re-index changed notes into `~/.ultron/brain_index`. |
| `mcp-health` | cross | Probe configured MCP servers and write the latest status snapshot. |
| `weekly-backup` | cross | Run the weekly mirror backup script (ps1 on Windows, sh on Linux). Updates the Doctor backup status. |
| `agents-reembed` | cross | Re-vectorize `~/.claude/agents` into Qdrant for semantic discovery. |
| `deadwood-scan` | cross | Detect orphaned scripts, stale skills, unreferenced data files. |
| `doctor-fix` | cross | Run doctor with `--fix` to apply only the changes marked safe. |
| `audit-skills` | cross | Aggregate usage / freshness stats per persona — output to `~/.ultron/cockpit/audits/`. |
| `nsis-uninstall` | Windows-only | Run the NSIS uninstaller for the desktop app. |
| `crashdumps-cleanup` | Windows-only | Purge `%LOCALAPPDATA%\CrashDumps`. |
| `recycle-bin-empty` | Windows-only | Empty the Recycle Bin. |
| `msi-repair` | Windows-only | `msiexec /fa` against the installed MSI. |

Linux builds hide the Windows-only entries automatically via
`#[cfg(target_os = "windows")]` gates in `maintenance.rs`. Add a new
command in that file — the palette picks it up through
`list_maintenance_commands_inner`.

---

## 3. Cockpit Python toolkit

Scripts under `scripts/cockpit/*.py`. Always run them with `uv run python <script>` (never raw `python`). The high-traffic ones:

| Script | What it does |
|---|---|
| `brain_index.py` | Manage the SQLite + FTS5 keyword index over `~/.ultron-vault`. `query "<topic>"` / `rebuild` / `update`. |
| `embed_vault.py` | Vectorise vault notes into Qdrant (`ultron_vault` collection). |
| `embed_skills.py` | Vectorise skills metadata into Qdrant (`ultron_skills` collection). |
| `embed_agents.py` | Same for agents (`ultron_agents` collection). |
| `doctor.py` | Full system health check; `--fix` to apply safe auto-fixes; `--json` for machine-readable output. |
| `registry_sync.py` | Rebuild cross-CLI skill manifests. |
| `skill_vault.py` | Manage the skill vault: `search` / `restore` / `stats` / `merge-candidates`. |
| `skill_sync_security.py` | Run the PI001-PI013 scanner over `~/.claude/skills`. |
| `mcp_health_check.py` | Probe registered MCP servers. |
| `persona_audit.py` | Stats per persona (last used, drift, redundancy). |
| `deadwood_scanner.py` | Find orphan files in the cockpit tree. |

> **Status:** `version_propagate.py` is a **CI-only gate** (not user-facing).
> It exists at `scripts/cockpit/version_propagate.py` and runs in
> `.github/workflows/ci.yml` as the `version-drift` job to verify that all
> version files (Cargo.toml, package.json, pyproject.toml, README badges, etc.)
> stay synchronized with the canonical version in `pyproject.toml`. Users do
> **not** call this directly — the Rust `version_drift` module and the release
> helper `scripts/cut-release.ps1` are the maintainer-facing tools (see
> `docs/RELEASE-PROCESS.md`). For end-users, version bumps happen transparently
> via the auto-updater.

The full Python toolkit is ~90 scripts; the ones above are the ones the UI surfaces directly.

---

## 4. The `ultron` shell alias

`scripts/cockpit/ultron.ps1` is the canonical CLI front-end on Windows
and is wired up as a function in the user's `$PROFILE` by `install.ps1`.
On Linux the cockpit tools are invoked directly with `uv run python
~/.ultron/scripts/cockpit/<tool>.py …` — there is currently **no
`ultron.sh` wrapper**; a Linux-side alias is tracked as a future polish
item. The ~90 subcommands the Windows wrapper exposes are listed below;
the underlying Python tools they invoke are cross-platform. The ones you
actually use day-to-day:

| Command | Purpose |
|---|---|
| `ultron status` | Print L0/L1/L2 memory size + Qdrant health + recent alerts. |
| `ultron doctor` | Read-only health check. |
| `ultron doctor --fix` | Apply safe fixes interactively. |
| `ultron recall "<query>"` | Hybrid FTS5 + Qdrant search across vault / skills / agents. |
| `ultron memory sync` | Push memory to the L3 remote mirror. |
| `ultron memory push` / `pull` | Manual git push/pull on the memory repo. |
| `ultron gemini "<prompt>"` | Helper to invoke the Gemini CLI for long-context work. |
| `ultron osint <username>` / `osint email <email>` | Wrappers around Sherlock / holehe for self-auditing your digital footprint. |
| `ultron skills vault search "<q>"` | Search the local skill vault (~300 archived skills). |
| `ultron skills manifest rebuild` | Re-emit `~/.ultron/skills/registry.json`. |
| `ultron health` | Same as `doctor` but exit-coded for CI. |
| `ultron verify` | Re-check claims in the verification log. |
| `ultron jobs` | List background jobs the cockpit owns. |
| `ultron audit run <persona>` | Re-evaluate a persona's recent usage. |

Type `ultron <command> --help` for any of them, or `ultron --help` for the full list.

---

## 5. Hooks

Hooks under `scripts/hooks/` are the auto-magic layer. They fire on Claude Code lifecycle events and are wired into `~/.claude/settings.json` by the installer. The ones that matter:

| Hook | Event | Platform | What it does |
|---|---|---|---|
| `session-init.ps1` / `session-init.sh` | SessionStart | cross (per-OS) | Read `context.md`, set up Qdrant, surface BLOCKING alerts. |
| `auto-recall.py` | UserPromptSubmit | cross | Hit the brain_index for relevant notes and surface them inline. |
| `intent-dispatcher.py` | UserPromptSubmit | cross | Suggest the right persona/skill/agent based on prompt content. |
| `validate_push.py` | PreToolUse (Bash) | cross | Block `git push -f origin main` and laundered variants. |
| `block-dangerous-bash.py` | PreToolUse (Bash) | cross | Hard refuse `rm -rf /`-style suicide commands. |
| `auto-approve-readonly.py` | PreToolUse | cross | Skip the confirmation prompt for safe read-only Bash. |
| `hook_input_validator.py` | (all) | cross | Defensive shape validation on stdin payloads. |
| `stop-memory-sync.ps1` / `stop-memory-sync.sh` | Stop | cross (per-OS) | Embed new notes, refresh `context.md`, push to L3 if HIGH+ mode. |
| `ensure-qdrant.ps1` / `ensure-qdrant.sh` | session-init / boot | cross (per-OS) | Verify Qdrant is alive, restart if needed. |
| `qdrant-notify.ps1` | post-failure | Windows-only | WinForm toast bottom-right if Qdrant won't come up. Linux uses `notify-send` if available, silent fallback otherwise. |
| `auto-changelog.py` | post-commit (git) | cross | Append commit message to `CHANGELOG.md` under the right version banner. |
| `detect_gaps.py` | dashboard refresh | cross | Surface stale TODOs, missing files, drift. |

All hooks live in version control; they're plain Python, PowerShell, or
bash — fully auditable. PowerShell hooks (`*.ps1`) are wired into
`settings.json` only on Windows installs; their bash siblings (`*.sh`)
take their place on Linux. If a hook misbehaves, disable it in
`~/.claude/settings.json` and the system keeps working (degraded but
functional).
