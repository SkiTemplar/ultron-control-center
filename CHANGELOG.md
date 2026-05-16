# Changelog

All notable changes to ULTRON Control Center will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Auto-updater wiring (`tauri-plugin-updater` is in Cargo.toml but not yet
  invoked from `lib.rs` — tracked as `si-p1-b-auto-updater`).
- Light theme toggle (current build is OLED-black hardcoded).
- macOS / Linux ports (Windows-only at v15.2).
- Cross-session BUS, supervisor daemon, DAG scheduler, overnight loop and
  mobile companion are deferred to v15.3.

## [15.2.0] - 2026-05-16 (release candidate)

First public-distributable cut of ULTRON Control Center. Repo is now
clone-and-install-able by third parties.

### Added
- MIT `LICENSE`, public `README.md` and `CONTRIBUTING.md`.
- `docs/INSTALL.md`, `docs/REPO-SPLIT-PLAN.md`, `docs/RELEASE-CHECKLIST-v15.2.md`,
  `docs/personas-release-decision.md`, `docs/backup-strategy.md`.
- Interactive installers: `scripts/install.ps1` (Windows, 488 lines) and
  `scripts/install.sh` (POSIX, 484 lines), plus matching
  `scripts/uninstall.{ps1,sh}` for clean removal.
- Portable path helpers: `control-center/src/lib/paths.ts`
  (`getUltronRoot` / `getHomeDir` / `joinPath`), `cockpit/apps.json` now
  uses `%LOCALAPPDATA%` tokens instead of hardcoded user folders.
- Skill alias map (`SKILL_ALIASES`) with 4 new test cases preserving
  backwards-compat after the persona rename.
- Plan spec `plans/specs/v15.2-public-release.md` (11-section spec).
- New helper scripts: `scripts/cockpit/verify_claims.py`,
  `scripts/cockpit/version_propagate.py`,
  `scripts/cockpit/installed_apps.py`.

### Changed
- Persona-strip sweep over 26 files: zero hardcoded `C:\Users\USER`
  references remaining; all paths resolve via `Path.home()` /
  `ultron_paths.py`.
- Skill rename propagation across 66 files (persona → generic name):
  `pana` → `personal-assistant`, `alfred` → `windows-admin`,
  `don-claudio` → `gamedev-engineer`. Persona names preserved as optional
  aliases.
- `control-center` crate and package bumped to `15.2.0`.
- Sanitised personal references (UNIVERSITY credentials, Notion IDs, project
  names) from cockpit configs and example files.

### Removed
- Dead capability entries `claude-inline-cmd`, `codex-inline-cmd`,
  `gemini-inline`, `auth-status-claude`, `auth-status-codex`,
  `codex-adversarial` from `capabilities/default.json`.
- Logs tab removed from sidebar (replaced by Notifications absorbing UI
  errors).
- Retired commands: `run_doctor`, `system_info`, `read_skill_md_inner_raw`
  and `skill_md` backup rotation.

## [15.1.5] - 2026-05-16

Ambitious feature drop on top of v15.1.4.

### Added
- **Memory visual Qdrant 2D scatter plot** (`memory_graph.rs` +382,
  `MemoryGraph.tsx` +405). SVG scatter over deterministic pseudo-UMAP
  projection of the 752 `brain_index` entries; click a point to open the
  source note.
- **Activity timeline** (`activity_timeline.rs` +407,
  `ActivityTimeline.tsx` +572). Cross-source heatmap over 7-day and 30-day
  windows fed by 8 hook signal sources (hyper-plans, doctor,
  prompt-feedback, token-usage, auto-updater, mcp-audit, session-log,
  routing-telemetry).
- **Codex-fallback with ULTRON context** (`codex_fallback.rs` +659,
  `CodexFallbackButton.tsx` +274). Detects Claude rate-limit, opens a
  Codex session injecting last 50 transcript lines + `context.md` +
  `brain_index` recall of the current topic. 7 unit tests included; 50K
  prompt cap.

## [15.1.4] - 2026-05-16

Closing sprint before the public release. UX polish + safety nets.

### Added
- **Cost watchdog** (`cost_watchdog.rs` +282, `CostWatchdog.tsx` +266).
  Reads `token-usage.jsonl`, computes burn rate, USD projection and fires
  alerts at 80% of the weekly Anthropic limit.
- **Inbox quick capture** (`inbox.rs` +144, `InboxModal.tsx` +290).
  Global hotkey `Ctrl+Alt+I` opens a modal overlay anywhere on Windows;
  notes go to a persistent queue.
- **Tray menu** (`tray.rs` +165). Quick actions: Open ULTRON, new
  Claude/Codex/Gemini session, jump to Plans / Memory, Quit. Wired via
  `setupTrayEventListeners` in `App.tsx`.
- **Per-project hotkeys** (`project_hotkeys.rs` +198, `hotkeys.rs` +107).
  `Ctrl+Alt+1..9` opens project N with its configured action stack
  (Shift+G chord turned out to be OS-impossible — replaced).
- **Multi-action projects** (`projects.rs` +72, `Projects.tsx` +422).
  Each project carries an `actions[]` list (`open_ide`, `new_claude`,
  `new_codex`, `open_folder`, `git_status`) plus an "Open all" dispatcher.
- **Responsive UI** (`styles.css` +104). Four breakpoints (1280 / 1600 /
  2200 / 4K+) with fluid `max-width` caps and font scaling.
- AI-create instruction folders: `~/.ultron/instructions/{skills,mcps,
  plans,tasks,memory}/` each with a `*-CREATE-GUIDE.md`; each "Create
  new X" button now opens a Claude session with `cwd` set to the matching
  folder.

### Changed
- Personal section split UI: left pane shows what ULTRON already knows
  (`known.json` auto-detected style fingerprints), right pane is a
  textarea + Submit that spawns Claude for deep analysis.
- Stats tab gained 6 new hook signal aggregations (hyper-plans, doctor,
  prompt-feedback, token-usage, auto-updater, mcp-audit).
- SelfImprove: Codex review collapsed by default; hook-signal badges
  colour-coded.
- MCPs: "Generate from prompt" dropped; replaced by unified "Add with AI".
- Projects: "Rescan" → "Rescan disk" and "Reload" → "Refresh list" with
  clearer tooltips.
- Settings: JSON editor with Codex assist; AI Router section (7 routing
  zones, persisted to `~/.ultron/.tmp/ai-router.json`).
- News HTML now renders inline via a sandboxed `iframe`; summary toggle
  added.

### Fixed
- `wt.exe` semicolon separator caused a double-terminal bug — fixed in
  `d89e14c`.
- News UTF-8 panic when files exceeded 200 KB with Spanish accents —
  `news.rs` switched from `raw[..200_000]` byte slice to
  `chars().take(200_000)` (commit `ba3ad44`).
- Sessions "resume" returning "log not found" — `cwd` heuristic rewritten
  in `a095082`.
- Usage stats stuck on a 7-day window — live recompute on focus refresh
  (`0877e70`).
- Multi-line prompts truncated by `wt.exe` argv length — now passed via
  clipboard (`a07e4f7`).
- `spawn-claude-session.ps1` killed by `$ErrorActionPreference = 'Stop'`
  when `cwd` was missing; now `Test-Path` first and reject UNC paths.
- `system_diagnose.ps1` level mapping always `null` due to int/string key
  mismatch — replaced with `[int]$e.Level` plus fallback.
- `list_scheduled_tasks` parser now tolerates the PS 5.1
  single-element-collapse quirk in `ConvertTo-Json`.
- `self_improve.rs` Codex adversarial review now executes from
  `~/.ultron` (git diff was reading the wrong cwd).
- News summarize: bypass argv limits by piping prompt through the
  clipboard (`d89e14c`).

### Security
- **MCP command allowlist** (`mcps.rs`). `validate_mcp_config` now allows
  only `npx`, `npm`, `node`, `uvx`, `uv`, `python`, `deno`, `bun`, `cargo`,
  `go`, `ruby`, `java` with a denylist of dangerous arg fragments
  (`-EncodedCommand`, `Invoke-Expression`, `iex`, `DownloadString`,
  `wget -`, `curl -`). Closes the persistent RCE vector where
  `add_mcp` / `update_mcp` could write `powershell.exe -Command <payload>`
  into `settings.json` and have Claude execute it on next start.
- **Content Security Policy** added in `tauri.conf.json` (default-src
  self, plus explicit style/img/font/connect/script directives) replacing
  the previous null CSP.
- News HTML render confined to a sandboxed `iframe`.
- `gaming-enum` PowerShell inline payload (4 KB) extracted to a pinned
  script file (`scripts/cockpit/gaming-enum.ps1`) with a capability
  validator restricted to that exact path.
- `projects.rs::create_project_inner` rejects UNC paths and enforces a
  file-extension allowlist (`exe`, `lnk`, `bat`, `cmd`, `url`, `html`,
  `pdf`) when entries point at files.
- All inline scripts (`run-inline.ps1`, `system_diagnose.ps1`,
  `spawn-claude-session.ps1`, `windows-tweaks.ps1`) now set
  `[Console]::OutputEncoding = UTF8Encoding` at start so Rust no longer
  receives `U+FFFD` for accented characters.
- Capability base64 payload widened from 16K/20K to 100K so AI prompts
  reach `diagnose_with_ai`, `summarize_news` and Settings "Ask Codex"
  intact (was being silently truncated at 4 KB).

## [15.1.1] - 2026-05-15

Heavy iteration on the Control Center after the v15.1 base shell. Roughly
26 commits, all under the `v15.1.1` tag.

### Added
- **Plans tab** with CRUD + AI brainstorm button (Codex-driven; produces a
  structured list of plans that get upserted via `add_plan`).
- **Plans archive-no-destruct**: `clean_resolved` moves entries to
  `plans/_archive` instead of deleting them; new "Revision" column;
  4 Claude-driven action buttons (execute / review / add / resolve).
- **Sessions presets** + `--dangerously-skip-permissions` toggle +
  Claude history resume.
- **Settings JSON editor** with Codex assist; live `Usage` recompute.
- **News tab generator** (Gemini 3.1 via CLI, no API key) +
  delete / summary toggle.
- **Memory tab** live FTS5 search, recent notes panel, four maintenance
  actions (vault / brain / qdrant / skills).
- **Skills tab** with AI edit, rich frontmatter view, filter granularity,
  skill spec fields.
- **Gaming mode** keep-list + weekly percentage display.
- **Logs tab** (later hidden in v15.1.4 in favour of Notifications).
- **Projects tab** multi-folder support, external apps, per-project
  hotkeys (initial wiring), AI-create folders.
- **Diagnose PC** action that pipes its output into a new Claude session.
- Personal tab (initial), Stats++ telemetry, UI error capture.
- BUS Foundation storage layer (`a6a2b0b`, 25 tests) — substrate only;
  full BUS still tracked under `v15.1-bus-foundation`.

### Fixed
- `wt.exe` title bug, "REAL Sessions launcher" path issues, Claude/Codex
  `---` separator rendering, Doctor exit code 1, Sessions UX bugs,
  Projects CRUD edge cases, dark notification styling, `PATH` inheritance
  in spawned subprocesses, MCPs "Hide" tooltip, monogram icon, Plans
  Revision column rendering.

### Changed
- News summarize routed via clipboard to avoid argv limits.

## [15.1.0] - 2026-05-13

Genesis of the Control Center desktop app (Tauri 2).

### Added
- Tauri 2 desktop shell with 10 tabs: Dashboard, Sessions, Projects,
  Skills, MCPs, Memory, Plans, Stats, Gaming, Settings.
- Sessions unified launcher for Claude / Codex / Gemini.
- MCPs tab with health-check + retry.
- Skills tab with search + filter + preview.
- Memory tab with live FTS5 search.
- Projects wizard + IDE launch + Rescan; group-by + filters.
- Usage tab with Claude Code stats.
- System tab with scheduled tasks + rich system info, task detail
  expandable.
- Gaming mode (kill background apps with triple guard).
- Autostart with Windows (`F9`) + global hotkey `Ctrl+Alt+U`.
- Weekly reset countdown; Settings tab with `settings.json` editor.
- Workspace picker linked to `projects.json` + custom directory.
- Command palette + Mode switcher + Auth status panels.

## [15.0.1] - 2026-05

Dual-Mode v2 — Codex and Gemini moved off API keys onto user
subscriptions.

### Added
- Codex via official `codex@openai-codex` plugin (`codex-plugin-cc`); auth
  via ChatGPT subscription. Sub-commands `/codex:review`,
  `/codex:adversarial-review`, `/codex:rescue`.
- Gemini via OAuth CLI; helper `~/.ultron/scripts/gemini-peer.ps1`.
- ULTRON sub-modes `/minidual`, `/dual`, `/maxdual` mapped over the plugin.

### Removed
- `GEMINI_API_KEY` requirement.
- `gemini` MCP server (replaced by CLI).

## [15.0b] - 2026-05

Token-diet sprint. Skill-vault landed.

### Added
- Skill vault: 380 → 46 active skills (334 moved to a cold vault).
- Qdrant-indexed skill-vault with semantic search and hot/cold ranking.
- Auto-recall vaulted-hint and merge-candidates suggestions; MCP audit.

## Earlier versions

See `cockpit/changelog.ndjson`, `cockpit/changelog_table.md` and the git
log for v15.0.x, v14.9.x and earlier. No formal Keep-a-Changelog file
existed before v15.2.
