# ULTRON — Commands reference

A flat index of everything you can run, organised by surface:

1. [Control Center command palette](#1-control-center-command-palette-ctrlk) (`Ctrl+K`)
2. [Maintenance commands](#2-maintenance-commands)
3. [Cockpit Python toolkit](#3-cockpit-python-toolkit) (`uv run python scripts/cockpit/*.py`)
4. [The `ultron` shell alias](#4-the-ultron-shell-alias)
5. [Hooks](#5-hooks)

If you only read one section, read **§1**: the command palette is the fastest path to most of what the system does.

> [!NOTE]
> **Platform notes.** The command palette, the Python cockpit toolkit, the
> Node.js hooks and the memory pipeline work on Windows and Linux. Surfaces
> that are Windows-only are marked **(Windows-only)** below. PowerShell
> helpers (`*.ps1`) do not run on Linux; their bash siblings (where they
> exist) are noted inline.

---

## 1. Control Center command palette (Ctrl+K)

Press `Ctrl+K` anywhere in the Control Center to open the fuzzy palette. Type a few letters and the right action surfaces.

> **Tabs (real layout, `SECTIONS` in `Sidebar.tsx`).** Top-level tabs:
> **Dashboard, Usage, AI Router, System, MCPs, Library, Notes, Lab, Session
> Monitor, Projects, Finance**, plus **Notifications** and **Settings** at the
> bottom. Finance is build-gated (`VITE_FINANCE=1`); Usage, MCPs, Library,
> Session Monitor and Projects can be hidden by `features.json`. The sidebar
> is in English; the palette labels are in Spanish.
>
> - **Library** sub-tabs: Skills, Agents, Rules, Plugins, Hooks, Catalog,
>   Commands, Tones (`LibrarySubTab` in `Library.tsx`).
> - **System** sub-tabs: Diagnostics, Apps, Tasks, Turn off
>   (`SystemSubTab` in `system/system-tab/types.ts`). Hooks moved to Library.
> - **AI Router** is its own tab (sub-tabs Dashboard, Providers, Zones), not a
>   Settings section.

| Group | Actions (labels as they appear) |
|---|---|
| **Navegar** | `Ir a <tab>` for every visible sidebar tab, in sidebar order (Dashboard · Usage · AI Router · System · MCPs · Library · Notes · Lab · Session Monitor · Projects · Finance), then `Library · Skills` / `Library · Agentes` / `Library · Reglas`, `Ir a Notifications` and `Ir a Settings` |
| **Navegar (ocultas)** | `Ir a Notas de versión` · `Ir a Planes` (tabs with no sidebar entry) |
| **Acciones** | Actualizar los datos del panel · Abrir Ajustes · Mostrar la pantalla de bienvenida · Cerrar Control Center |
| **Diagnóstico** | Abrir el diagnóstico del sistema |
| **IA** | Abrir la ventana de ULTRON Sessions · Lanzar una sesión de Claude · Lanzar una sesión de Codex |
| **Mantenimiento (skills / sistema / PC)** | Dynamic: one entry per command from `list_maintenance_commands_inner` (see §2) |
| **Sistema** | Recompilar Control Center · Desinstalar ULTRON · Limpiar entradas antiguas de arranque automático · Escanear proyectos |

Navigation follows the sidebar filters (a tab hidden by `features.json` or
not built, like Finance without `VITE_FINANCE=1`, has no entry). Sources:
`buildTabActions` in `src/components/CommandPalette.tsx`, the `extraActions`
built in `src/App.tsx` and `src/components/palette/systemPaletteActions.ts`
(maintenance entries and «Recompilar Control Center», which asks for
confirmation). `↑↓` to navigate, `Enter` to fire, `Esc` to close.

---

## 2. Maintenance commands

Surfaced in the palette (`Maintenance (<group>)`) and, for the `pc` group, in
the Dashboard "Fix common issues" strip. The list lives in
`control-center/src-tauri/src/maintenance/commands.rs`
(`list_maintenance_commands_inner`, and `build_cmd` maps each `kind` to the
executable it runs). Entries with `destructive: true` (`doctor-fix`,
`pc-reset-network`, `pc-restart-explorer`, `pc-clear-temp`) ask for
confirmation in the palette, and every result is shown: a non-zero exit
(`success: false`) is reported as a failure with its exit code.

| Kind | Group | Platform | What it runs |
|---|---|---|---|
| `skill-security-audit` | skills | cross | `skill_sync_security.py audit-all --json` |
| `registry-sync` | skills | cross | `registry_sync.py update-manifest` |
| `mcp-health` | system | cross | `mcp_health_check.py --quiet` |
| `weekly-backup` | system | cross | `scripts/backup/weekly-backup.ps1` (Windows) or `.sh` (Linux); errors if the script is missing |
| `deadwood-scan` | system | cross | `deadwood_scanner.py` |
| `doctor-fix` | system | cross | `doctor.py --fix --yes`: applies every proposed fix without asking (destructive: the UI confirms first) |
| `pc-flush-dns`, `pc-reset-network`, `pc-disk-cleanup`, `pc-reliability-monitor`, `pc-task-manager`, `pc-restart-explorer`, `pc-clear-temp`, `pc-windows-update`, `pc-open-hosts` | pc | Windows-only | Hard-coded Windows commands (`ipconfig /flushdns`, `cleanmgr.exe`, `perfmon /rel`, ...) |

`build_cmd` also accepts more `pc-*` kinds that are not in the default list
(`pc-renew-ip`, `pc-winsock-reset`, `pc-restart-*`, `pc-repair-wu`, `pc-sfc`,
`pc-dism`, `pc-chkdsk`, `pc-reset-firewall`, `pc-wsreset`, ...); the
Diagnostics panel fires some of them directly. All `pc-*` arms are gated with
`#[cfg(target_os = "windows")]`; on other hosts they fall through to the
unknown-kind error.

---

## 3. Cockpit Python toolkit

Scripts under `scripts/cockpit/*.py`. Always run them with `uv run python <script>` (never raw `python`). The high-traffic ones:

| Script | What it does |
|---|---|
| `brain_index.py` | Manage the SQLite + FTS5 keyword index over the vault (`~/.ultron/brain_index/index.db`). |
| `embed_skills.py` | Vectorise skills metadata into Qdrant (`ultron_skills` collection). Optional: needs a running Qdrant. |
| `doctor.py` | Full system health check; `--fix` to apply safe auto-fixes; `--json` for machine-readable output. |
| `registry_sync.py` | Rebuild cross-CLI skill manifests. |
| `skill_vault.py` | Manage the skill vault: `search` / `restore` / `stats`. `registry` rewrites `skills/registry.json` (local, gitignored, nothing regenerates it automatically); the Skills tab reads `priority`, `usage_count` and `tags` from it. |
| `skill_sync_security.py` | Run the prompt-injection scanner over `~/.claude/skills`. |
| `mcp_health_check.py` | Probe registered MCP servers. |
| `deadwood_scanner.py` | Find orphan files in the cockpit tree. |

> **Status:** `version_propagate.py` is a **CI-only gate** (not user-facing).
> It runs in `.github/workflows/ci.yml` as the `version-drift` job to verify
> that the installer versions (`install.ps1`, `install.sh`,
> `install-wizard.ps1`) and the markdown bodies match the canonical version in
> `pyproject.toml`. The Control Center manifests (`package.json`, `Cargo.toml`,
> `tauri.conf.json`, `CC_TARGETS` in the script) carry their own version (15.x):
> they are only checked against each other, not against `pyproject.toml`, so
> the two can differ. Maintainers bump versions with `scripts/cut-release.ps1`
> (see `docs/RELEASE-PROCESS.md`).

The Python toolkit is 36 scripts under `scripts/cockpit/` plus 5 in `scripts/`
and `scripts/hooks/`; the ones above are the ones the UI surfaces directly.

---

## 4. The `ultron` shell alias

`scripts/cockpit/ultron.ps1` is a manual CLI front-end for the cockpit
scripts on Windows. The Control Center does not call it (open and scan live
in Rust). `install.ps1` does **not** add it to `$PROFILE`: run
`ultron.ps1 alias` to print the function to paste into your profile. On Linux
call the tools directly with `uv run python ~/.ultron/scripts/cockpit/<tool>.py`.

Since 2026-10-08 it only dispatches subcommands whose target script exists:

| Command | Purpose |
|---|---|
| `ultron status` | Projects summary, alerts hint and scheduler state. |
| `ultron open <project>` / `projects` / `scan` | Launch a project in its IDE, browse or re-scan the registry. |
| `ultron project ...` / `notes <id> ...` | `project_editor.py` and `project_notes.py` wrappers. |
| `ultron claude` / `codex` | Spawn an interactive session in the current folder. |
| `ultron app <name>` / `apps` | GUI app launcher registry. |
| `ultron skills registry\|vault\|manifest ...` | `registry_sync.py`, `skill_vault.py`, `skill_manifest.py`. |
| `ultron skill register\|list` | Re-index skills in `brain_index`. |
| `ultron sync` / `sync-all` | Registry + manifest sync; `sync-all` adds brain index, MCP probe, deadwood and doctor. |
| `ultron health` / `doctor [--fix\|--json]` / `deadwood` | Health checks. |
| `ultron mcp health` | Probe all MCP servers and pretty-print the result. |
| `ultron alerts ...` / `security ...` | Alerts bus and security audits. |
| `ultron brain ...` / `index ...` / `config ...` | `brain_index.py` and `brain_config.py`. |
| `ultron schedule install\|status\|uninstall` | Windows scheduled tasks from `cockpit/schedule-config.json`. |

`ultron help` prints the full list.

---

## 5. Hooks

Hooks live in `~/.ultron/hooks/scripts/*.js` (plain Node.js, no build step)
and run in place from there. They are wired into `~/.claude/settings.json`,
the single source of truth. `node hooks/regen-manifest.js` mirrors it into
`hooks/manifest.json` (events, checksums, writer-path governance) and into
`templates/settings-hooks.json` (the template `install.ps1` / `install.sh`
merge); `--check` fails on drift. The table below is a human-readable view of
the manifest as of 2026-10-08 (31 entries).

Golden rule: hooks **propose** memory candidates, they **never** write the
source of truth (`brain.db`) directly. The only writer is `MemoryService`
(the Rust `ultron-memory` sidecar). Hooks that touch memory go through
`ultron-memory candidate` / `capture` and land in the governed inbox as
pending. The inbox is autonomous (since 2026-07-13): after each capture,
`stop-compress-session.js` spawns `ultron-memory inbox drain --auto`, whose
policy approves bands A/B and rejects secrets, duplicates, conflicts and
noise with an auditable reason, without asking the user. Only unverifiable
candidates and captures the user did not assert stay pending (the latter
expire after 7 days without human validation). The rest are
read-only (emit `additionalContext`) or append to local scratch files.

| Hook | Event | What it does |
|---|---|---|
| `ensure-codegraph.js` | SessionStart | Keep the CodeGraph daemon/watcher alive (PID checked, relaunch if dead). |
| `memory-session-resume.js` | SessionStart | Inject a bounded resume (active workflows, open tasks, decisions, pinned, next action) read via `ultron-memory resume`. Read-only. Also injects the session-feedback question and the concision meter. |
| `ensure-project.js` | SessionStart | Register the project in `cockpit/projects.json` and apply the project onboarding rules. |
| `sessions-rich-format.js` | SessionStart | Only inside ULTRON Sessions (`ULTRON_SESION_ID`): inject the rich format as the daily chat style, also after `/clear` and compaction. |
| `pupus-permission.js` | PermissionRequest | Send terminal permission requests to the Pupus speech bubble and return allow/deny; with no answer it does not decide and the terminal dialog takes over. |
| `socratic-gate.js` | UserPromptSubmit | Inject the Socratic decision protocol. Per-project mode in `cockpit/projects.json` (`strict` default, `light`, `off`, `uni`); set it with `node scripts/project-socratic.mjs <id> <mode>`. |
| `save-user-prompt.js` | UserPromptSubmit | Archive each non-trivial prompt to the daily markdown inbox. Does not write the SoT. |
| `memory-orchestrate.js` | UserPromptSubmit | Light mode by default (only the tone); `ULTRON_ORCHESTRATE=full` restores recall, routing and delegation hints from `ultron-memory orchestrate`. |
| `session-feedback-capture.js` | UserPromptSubmit | Capture `fb: si\|no\|estorbo [note]` into `logs/session-feedback.jsonl` and propose the note as a candidate. |
| `run-project-tests-report.js` | UserPromptSubmit | Tell the model, once per result, which tests broke in the last automatic run. |
| `context-guard.js` | UserPromptSubmit | From 200k tokens of context, decide with the session log whether to suggest compacting. |
| `usage-pace-guard.js` | UserPromptSubmit | Warn when the 5 h or weekly usage window runs ahead of elapsed time. |
| `deny-secrets.js` | PreToolUse (Read/Edit/MultiEdit/Write/NotebookEdit/Bash/PowerShell/Grep) | Block tool calls that touch secrets; the project env file and `.npmrc`/`.pypirc` ask instead. |
| `document-convert-hint.js` | PreToolUse (Read) | Suggest `markitdown` for binary documents and large PDFs. |
| `codegraph-first.js` | PreToolUse (Grep, Glob, Read, CodeGraph) | In a project with a CodeGraph index, deny once per session the second Grep/Glob/code Read made without using CodeGraph first. |
| `guardrails-pre.js` | PreToolUse (Bash/PowerShell/Agent/Task) | Deterministic checks (unknown subagent type, permission-skipping flag, ...). |
| `uni-deliverable-guard.js` | PreToolUse | Block writes into `borrador/` and `entrega/` of university deliverables. |
| `posttoolfail-capture.js` | PostToolUse + PostToolUseFailure | On a failed tool result, propose an `error_resolution` candidate via the sidecar. |
| `guardrails-post.js` | PostToolUse (Write/Edit) | Warn when freshly written text breaks a content rule. |
| `run-project-tests.js` | PostToolUse (Edit/Write/MultiEdit/NotebookEdit, async) | Run the project test suite in a detached runner after a code edit (120 s cap, 60 s debounce). Opt-out: `RUN_TESTS_DISABLED=1`. |
| `precompact-preserve-l0.js` | PreCompact | Preserve key L0 facts in `~/.ultron/.tmp/context.md`. Not governed memory. |
| `model-family-guard.js` | PreModelSwitch + PostModelSwitch | Deny a model switch (`/model`, picker, `/config`, SDK `set_model`) outside the 5.5 family; warn when an automatic fallback or a resume leaves it. Opt-out: `ULTRON_MODEL_GUARD=0`. |
| `stop-compress-session.js` | Stop | Compress the session into governed candidates via `ultron-memory capture`, then spawn the autonomous `inbox drain --auto`. |
| `batch-capture.js` | Stop | Queue commands the user rejected or the AI could not run (`ai_cannot_execute`) into `~/.ultron/batches/`, consumed by the "Ejecutar .bat" dropdown in Projects (not the kanban RunBatch retired on 2026-10-17). Commands that merely failed are not queued. |
| `subagent-lifecycle.js` | SubagentStart + SubagentStop | Record each subagent's start/stop to scratch. |
| `subagent-harvest.js` | SubagentStop | Record each subagent's result to scratch and propose an `agent_note` candidate for non-trivial results of named specialists. |
| `session-end-bitacora.js` | SessionEnd | Write the closing session's log (`summary.md`). |
| `lesson-distill.js` | SessionEnd | Distill 0-3 `lesson` candidates through the daemon. |
| `project-profile.js` | SessionEnd | Keep `cockpit/projects/<id>/profile.json` fresh. |
| `session-feedback-mark.js` | SessionEnd | Write `feedback-pending.json` so the next session asks whether ULTRON helped. |
| `memory-gc.js` | SessionEnd | Weekly 90-day maintenance of `brain.db` (`ultron-memory gc`). |
| `notify-relay.js` | Notification | Append each notification to a rotating scratch log. |

Every hook is fail-safe: on error, missing transcript or missing sidecar it
exits 0 without aborting the event. If one misbehaves, remove its entry from
`~/.claude/settings.json` and regenerate the manifest.

> **De-registered (not live):** `codegraph-reminder.js`, `markdown-lint-hint.js`,
> `ai-text-warn.js`, `load-cross-project-memory.js`, `session-start-override.js`
> (2026-09-29/30) and `kanban-update-reminder.js` (2026-10-08), all deleted;
> `routing-dispatcher.v2/v3.js` (kept in `cockpit/skill-lazy/`, not wired);
> `ensure-qdrant.js`, `memory-warmup.js` and `qdrant-mirror-sync.js` (kept for
> re-enabling dense recall); `route_quality_aggregator.py` (no longer a Stop
> hook); `session-end-summary.js` (orphan: the Cowork plugin that packaged it was deleted on 2026-10-28). Older removals
> (`mem0-sync.js`, `quota-capture.js`, `session-recall-inject.js`,
> `workday-*`) are listed in the `deregistered` block of `manifest.json`.
