# ULTRON — Commands reference

A flat index of everything you can run, organised by surface:

1. [Control Center command palette](#1-control-center-command-palette-ctrlk) (`Ctrl+K`)
2. [Maintenance commands](#2-maintenance-commands)
3. [Cockpit Python toolkit](#3-cockpit-python-toolkit) (`uv run python scripts/cockpit/*.py`)
4. [The `ultron` shell alias](#4-the-ultron-shell-alias)
5. [Hooks](#5-hooks)

If you only read one section, read **§1** — the command palette is the fastest path to 90 % of what the system does.

> [!NOTE]
> **Platform notes.** Most things are cross-platform: the
> command palette, Python cockpit toolkit, the Node.js hooks, the
> memory pipeline, and the bulk of the `ultron` shell alias all work on
> both Windows and Linux. Surfaces that are Windows-only are marked with
> **(Windows-only)** below. On Linux the Control Center hides those
> entries; running the underlying script directly is a no-op or errors
> cleanly. PowerShell-only helpers (`*.ps1`) do not run on Linux; their
> bash siblings (where they exist) are noted inline.

---

## 1. Control Center command palette (Ctrl+K)

Press `Ctrl+K` anywhere in the Control Center to open the fuzzy palette. Type a few letters and the right action surfaces. Categories:

> **Tabs (real layout, `Sidebar.tsx` + `App.tsx`).** Top-level tabs are:
> **Dashboard, Usage, AI Router, System, MCPs, Library, Memory, Notes,
> Sessions, Projects, Finance, Settings, Notifications**. **Skills, Agents and
> Rules are NOT top-level** — they are **sub-tabs of Library** (alongside
> **Updates**, the plugin update-check panel). System hosts the **CodeGraph**
> panel and the Hooks/Schedules sub-tabs. Finance is build-gated
> (`VITE_FINANCE=1`). Each tab is still reachable individually via the command
> palette and deep-links even when it lives under another tab.

| Category | Examples |
|---|---|
| **Navigate** | Go to Dashboard / Memory / Library (Skills · Agents · Rules · Updates) / Sessions / Projects / MCPs / Settings (and the "More" tier) |
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
| `brain_index.py` | Manage the SQLite + FTS5 keyword index over the vault. |
| `embed_skills.py` | Vectorise skills metadata into Qdrant (`ultron_skills` collection). |
| `doctor.py` | Full system health check; `--fix` to apply safe auto-fixes; `--json` for machine-readable output. |
| `registry_sync.py` | Rebuild cross-CLI skill manifests. |
| `skill_vault.py` | Manage the skill vault: `search` / `restore` / `stats`. |
| `skill_sync_security.py` | Run the prompt-injection scanner over `~/.claude/skills`. |
| `mcp_health_check.py` | Probe registered MCP servers. |
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

The full Python toolkit is ~47 scripts (40 under `scripts/cockpit/`, the rest in `scripts/` and `scripts/hooks/`); the ones above are the ones the UI surfaces directly.

---

## 4. The `ultron` shell alias

`scripts/cockpit/ultron.ps1` is the canonical CLI front-end on Windows
and is wired up as a function in the user's `$PROFILE` by `install.ps1`.
On Linux the cockpit tools are invoked directly with `uv run python
~/.ultron/scripts/cockpit/<tool>.py …` — there is currently **no
`ultron.sh` wrapper**; a Linux-side alias is tracked as a future polish
item. The Windows wrapper exposes ~60 subcommands (one `switch` branch each
in `ultron.ps1`); the underlying Python tools they invoke are cross-platform.
The ones you actually use day-to-day:

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

Hooks live in `~/.ultron/hooks/scripts/*.js` (plain Node.js, no build step).
They fire on Claude Code lifecycle events and are wired into
`~/.claude/settings.json`. The canonical, versioned list — with events,
checksums and writer-path governance — is `~/.ultron/hooks/manifest.json`;
the table below is a human-readable view of it.

Golden rule: hooks **propose** memory candidates, they **never** write the
source of truth (`brain.db`) directly. The only writer is `MemoryService`
(the Rust `ultron-memory` sidecar). Hooks that touch memory go through
`ultron-memory candidate` and land in the governed inbox as pending; nothing
auto-promotes. The rest are read-only (emit `additionalContext`) or append to
local scratch files.

| Hook | Event | What it does |
|---|---|---|
| `memory-session-resume.js` | SessionStart | Inject a bounded resume (active workflows, open tasks, decisions, pinned, next action) read from the SoT via `ultron-memory resume`. Read-only. |
| `load-cross-project-memory.js` | SessionStart | Inject the summarised `MEMORY.md` index of recent projects as context. Read-only. |
| `session-start-override.js` | SessionStart | Fallback previous-session summary by project name when the ECC worktree match fails. Read-only. |
| `workday-session-linker.js` | SessionStart | Auto-link the session to the in-progress Workday (Tauri CLI if online, queue file if offline). |
| `routing-dispatcher.js` | UserPromptSubmit | Suggest a skill/persona by prompt intent (deterministic scoring, no LLM). Emits context only. |
| `memory-orchestrate.js` | UserPromptSubmit | Route the prompt through `ultron-memory orchestrate` (intent → workflow → agents → relevant memories) as context. Read-only. |
| `save-user-prompt.js` | UserPromptSubmit | Archive each non-trivial prompt to the daily markdown inbox (candidate for `consolidate-memory`). Does not write the SoT. |
| `posttoolfail-capture.js` | PostToolUse | On a failed tool result, propose an `error_resolution` candidate via the sidecar. Success path exits fast without writing. |
| `stop-compress-session.js` | Stop | Compress the session into facts and leave them as candidates in `decisions-pending.jsonl` (Decisions panel / backend drain). |
| `kanban-update-reminder.js` | Stop | If a task looks completed, emit a reminder to update the active project's kanban. Read-only. |
| `batch-capture.js` | Stop | Capture REJECTED / FAILED / `ai_cannot_execute` commands to the Run Batch queue. Operational queue, not semantic memory. |
| `subagent-harvest.js` | SubagentStop | Record a subagent's result to scratch; if non-trivial, propose an `agent_note` candidate via the sidecar. |
| `precompact-preserve-l0.js` | PreCompact | Before compaction, preserve key L0 facts to the scratch file `~/.ultron/.tmp/context.md`. Not governed memory. |
| `session-end-summary.js` | SessionEnd | On session close, propose a brief rule-based `session_summary` candidate via the sidecar (governed inbox, never auto-promotes). |
| `notify-relay.js` | Notification | Append each Claude Code notification (idle/permission/etc.) to a rotating scratch log. Local append only. |

Every hook is fail-safe: on error, missing transcript or missing sidecar it
exits 0 without aborting the event. If one misbehaves, remove its entry from
`~/.claude/settings.json` and the system keeps working.

> **De-registered (kept in `scripts/` only as historical reference, NOT live):**
> `mem0-sync.js` (wrote to Mem0 cloud — outside the SoT), `quota-capture.js`
> (Quota feature removed), `session-recall-inject.js` (superseded by
> `memory-session-resume.js`). `workday-auto-update.js` is a Windows scheduled
> task, not a Claude Code hook. See the `deregistered` block in `manifest.json`.
