# Changelog

<!-- v15.5.20 -->
## v15.5.20 — 2026-05-18 (patch sweep: Round 5 evaluator fixes)

UX overhaul + leakage gate hardening based on seven parallel Round 5
audits. Per `docs/CHANGELOG-POLICY.md` this minor entry collapses the
v15.5.19 in-flight patches.

Errores corregidos:
- Stop hook debounce window 90s→300s; per-turn refire cut from ~25× to ~2× session ratio (`scripts/hooks/stop-memory-sync.{ps1,sh}`).
- `plan-detector.py` now dedupes against the last 200 inbox lines before appending — kills 5×-duplicate spam in `plans/_inbox.md`.
- Leakage scanner: word-boundary regex tightened to also catch underscore-adjacent matches (`USER_signal`-style); five new HIGH patterns added (`UNIVERSITY`, `PROGRAM_A`, `REDACTED_TEAM`, `REDACTED_COMMIT_LABEL`, `eval-N RX`); 21 internal `eval-N RX` annotations scrubbed from runtime files.
- `news_html_generator.py`: dead `SKILL_PATH` + `load_base_template()` removed (referenced a `newsletter-publisher` skill that was never shipped).
- CHANGELOG v15.4.x: 21 individual patch entries (~270 lines) collapsed into a single brief v15.4.1..v15.4.21 sweep block per `CHANGELOG-POLICY.md`.

Anadido:
- **In-app popup system (`PopupHost`)** — bottom-left, non-invasive. Replaces both the Windows-native `tauri_plugin_notification` toast and the central-modal `confirmDialog`. New API: `src/lib/popups.ts` (`showToast`, `showConfirm` returning `Promise<boolean>`). Backend emits Tauri event `ultron-toast` instead of OS-level notifications.
- L3 status in README + README.es upgraded from *(planned)* to *(opt-in)*. Documented that L3 is per-user: each user creates their own **private** `<user>/ultron-memory` repo (vault contents are personal), not a shared mirror.

Eliminado:
- `Logs` tab dead route (Sidebar + App.tsx) — was `available: false` since v15.2 F7 (Hooks moved inside System).
- `Hooks.tsx::ConfirmModal` (central overlay) replaced by inline popup confirm.
- Deadwood scripts: `scripts/consistency-check.py` (duplicate of underscore variant), `cockpit/projects.json.bak`, branches `backup-pre-history-rewrite-*` / `backup-pre-purge-*`.

Movido:
- `scripts/hooks/ensure-qdrant.{ps1,sh}` → `scripts/qdrant/` (catch-up with the v15.5.17 reorganisation that left two siblings behind).

Sanitizado:
- `intent-rules.yaml:267` regex no longer hardcodes a personal sports team.
- `routing-test-runner.py` dropped `PROGRAM_A` keyword (covered by `ue5`/`unreal`).
- `validate_push.py` + `route_quality.py` + `pyproject.toml` + CHANGELOG entries scrubbed of internal evaluator/persona vocabulary.

<!-- v15.5.0 -->
## v15.5.0 - 2026-05-17 (acumula v15.5.1..v15.5.18)

First Linux release; backlog burn-down across routing, Tauri ACL, leakage
sweep, docs, install, and release pipeline. The Windows path is unchanged.

Errores corregidos:
- install.sh `((counter++))` aborting under `set -e` (9 sites) + `$NONINTERACTIVE` typo blocking the first Linux end-to-end install.
- Missing `scripts/hooks/{session-init,session-cleanup,stop-memory-sync}.sh` siblings on Linux.
- `install.sh init_brain_index` step not provisioning the FTS5 DB at install time.
- `release.yml` ZIP missing `pyproject.toml`, `uv.lock`, `git-hooks/` (offline installs could not resolve venv deps).
- Tauri ACL: `window.confirm()` intercepted under Tauri 2 + WebView2; 9 destructive flows silently no-op'd. Replaced with `@tauri-apps/plugin-dialog` wrapper.
- Plans UI horizontal scroll on long words; layout reworked into a 2-row grid.
- AI Router: 7 zones missing an assigned agent (diagnose / summarize / brainstorm_plans / news_generate / skill_edit / mcp_create / repo_review).
- SKILL.md mojibake (re-encoded as clean UTF-8 via ftfy).
- Routing line leaking `skill=- | ctx=- | via=none` on no-match prompts.
- Personal-info leakage across 21 files + docs (hardcoded user paths, university folder layout, coursework names, personal identifiers, SECURITY.md email).
- `cockpit_base.py:SCAN_ROOTS` hardcoded the maintainer's folder layout; defaults to generic dev dirs with a `~/.ultron/cockpit/scan-roots.json` override.
- `audit_personal_data.py` finding itself in its own scan (74 HIGH on a clean tree); self-exclusion added.
- README + README.es + docs pinned to stale version across 6 places; `repo/agents/` and `cockpit/PLANS.json` path stragglers.
- SYSTEM-MAP.md mojibake regenerated as clean UTF-8.
- News button-prompt seed clarified as `[BANNER - not the real prompt]`.
- `weekly-backup.{ps1,sh}` defaults stripped of personal folders; override via `$ULTRON_BACKUP_SOURCES`.
- `release.yml:39` matrix expression simplified (dead-code `.platform.platform || .platform`).
- Legacy 1000+ line `scripts/install.{ps1,sh}` duplicates relocated to `_legacy/install-pre-v15.4.{ps1,sh}`.
- `bootstrap.{ps1,sh}` silent warn-and-continue when `.sha256` was missing; now `exit 5` by default (opt-in `--allow-unsigned-zip`).
- `stop-memory-sync.{ps1,sh}` now publishes `qdrant.health` alerts on embed timeouts (was logged-only).
- `auto-changelog.py` firing on every Stop event; gated behind HIGH/ULTRA modes.
- `ai_router.rs::AiRouterEntry::new` dead-code removed.
- Stop chain consolidated from 5 → 3 processes per session.
- `tests/test_backup_watch.py` asserting a stale literal path instead of the `$env:ULTRON_BACKUP_ROOT` contract.
- `i18n` accent normalization across `README.es.md`.
- `pyproject.toml` pytest markers (routing, layer1, tiebreak, plugins, combos, confidence, manual) registered to silence `UnknownMarkWarning`.
- `datetime.utcnow()` migrated to `datetime.now(timezone.utc)` (py3.14 hard-fail).
- 20 source files with personal-name comments rewritten to neutral attribution (MEDIUM 142 → 118).
- `# ...` comments incorrectly used in `.ts/.tsx/.rs` auto-fixed to `// ...`.
- `uninstall.sh` not stripping the `# Added by ULTRON installer` PATH line on re-cycles.
- Orphan version tags v15.5.11 / v15.5.12 / v15.5.13 cleaned from local refs.

Anadido:
- Linux x86_64 support (Debian / Ubuntu / Fedora / Arch); Tauri desktop app builds and runs natively.
- `bootstrap.sh` - Linux equivalent of `bootstrap.ps1` (resolve latest tag, download + SHA-256 verify, extract, hand off to `install.sh`).
- `install.sh` - package-manager-aware installer (`apt` / `dnf` / `pacman`); installs Tauri 2 system deps, Node 22, uv, Rust, Claude Code CLI, native Qdrant Linux binary.
- Release pipeline matrixed across `windows-latest` and `ubuntu-22.04`; Linux releases ship `.deb` and `.AppImage`.
- AppImage placement under `~/.local/bin/` with `.desktop` launcher under `~/.local/share/applications/`.
- Compatibility matrix updated; macOS marked as an explicit non-goal.
- Maintenance command list filtered per-platform; Windows-only entries hidden on Linux via `#[cfg]` gates.
- `docs/RELEASE-PROCESS.md` documents the dual-bootstrap pattern and expanded release-asset list.
- Manual install on Linux section in `INSTALL.md` with copy-pasteable matrices.
- `cockpit/secrets-loader.ps1` stub (silenced the PowerShell profile error on every shell).
- 5 personal personas added to `config/intent-rules.yaml` (`tio-gilito`, `warren`, `tolkien`, `pana`, `alfred`); raises real dispatcher match-rate from 49.8% → 95%/20.
- 2 ambiguity rules added (`casual-code-review`, `debug-lost`); closes macro-test M11+M12 misses.
- `tests/test_routing_macro.py` - 20-prompt harness with per-row assertions and aggregate `>=95%` test (21/21 passing).
- Context packet cap lowered 600 → 300 tokens (per-turn steady-state cost halved with no precision loss).
- `SYSTEM-MAP.md` lazy-load wake-up protocol (~1660 tokens saved per session-start).
- `scripts/cockpit/version_propagate.py --check` SSOT guard + dedicated `version-drift` CI job (drift had reopened 6x in v15.5.x; now blocked at PR time).
- `version_propagate.py` extended to scan markdown bodies (badges, bootstrap URLs, prose) with 5 context-anchored regexes.
- `.github/workflows/ci.yml` hard-fails on `audit_personal_data.py` HIGH hits (was advisory-only).
- `control-center/src/lib/dialog.ts` - async `confirmDialog(message, opts)` wrapper around `@tauri-apps/plugin-dialog`.
- `PendingItemsPanel` relocated above the Full Diagnostic section; sidebar Dashboard tab shows a red badge polled every 60s.
- `~/.ultron/logs/auto-recall.log` append-only fire trail so silent regressions stay visible.
- `control-center/README.md` rewritten from Vite/Tauri template to 41-line orientation.
- `scripts/hooks/README.md` rewritten to enumerate all hooks with cross-platform `.ps1` <-> `.sh` table.
- `docs/RELEASE-CHECKLIST.md` (versionless) created; legacy v15.2 references rewired.
- `docs/MAINTAINERS.md` documenting the 7 maintainer-only tools.
- `cockpit/scan-roots.json` and `cockpit/news_history.db` added to `.gitignore`.
- User brief catalogued in `plans/PLANS.json` (40+ items, repos-to-investigate parking until avg >=9.5).
- Asymmetric Qdrant SHA verification scaffolding on `install.sh` (Windows parity).

Non-goals (explicit):
- macOS - out of scope; not on any roadmap.
- ARM Linux - v15.5 is x86_64 only.
- Snap / Flatpak Store submissions - AppImage is the path of least resistance.

> See `plans/specs/v15.5-linux-support.md` for the full plan + execution log.
> Aggregated entry replaces the per-patch v15.5.1..v15.5.18 sections per the
> CHANGELOG policy documented in `docs/CHANGELOG-POLICY.md`.


<!-- v15.4.1..v15.4.21 — patch sweep -->
## v15.4.1..v15.4.21 — patch sweep (2026-05-17)

Per `docs/CHANGELOG-POLICY.md` patches collapse into the next minor entry.
Twenty-one patches landed on the same day after v15.4.0; grouped briefly:

- **Update / rebuild loop:** boot-time `update_checker.rs` + `<UpdateBanner/>`, Settings → Features "Auto-rebuild on update", rebuild auto-relaunches the app, kill-running-app-before-build.
- **AI Router + features wizard:** smart defaults per zone + reset button, 14 runtime toggles (`news, gaming, personal, schedules, self_improve, memory, plans, projects, mcps, skills, hooks, notifications, usage, sessions`), sidebar honours `featureKey`.
- **Skills + agents:** publica 332 skills + Install-SkillSets, 16 agents + Install-Agents installer step, MemoryGraph spacing iterations, Send to Vault, ftfy mojibake sweep, agent versioning.
- **Routing + telemetry:** 8 new intent-dispatcher rules from telemetry, Vault panel UI + news dedup + auto-recall vault layer + hooks search.
- **IDE selector:** CLion added (13 editors total).
- **Docs / hygiene:** README parity (EN + ES) for badges/roadmap/tab count, COMMANDS.md, top_intent fix, apps path UTF-16 decode, dev-only doctor hidden, release cadence policy.
- **Cleanup:** sidebar `FeaturesModal` removed (~95 LOC), stale comments scrubbed.

_See `git log v15.3.6..v15.4.21` for the full per-patch history._


<!-- v15.4.0 -->
## v15.4.0 — 2026-05-17

Post-overnight polish sweep. Fixes the regressions surfaced after the
overnight mega-commit (2e9a773) and closes every gap raised in the
2026-05-17 audit.

### Fixes

- fix(gitignore): anchor `personal/` to top-level + carve-out for `control-center/src/**/personal/` — restores `KnownSection.tsx` / `ProfileSection.tsx` / `StyleSection.tsx` / `types.ts`, unblocks the TypeScript CI step.
- fix(tests): drop `tests/test_usage_reset.py` and `tests/test_tui_recall_modal.py` (dead — `tui.py` removed in v15.4); fixes pytest collection error.
- fix(validate_push): scrub heredocs + quoted strings before laundering / protected-branch check — heredoc commit messages no longer trigger false-positive blocks. Force-pushes to `main`/`master`/`release`/`production` still hard-blocked.
- fix(hook_input_validator): downgrade `hook_event_name_mismatch` to non-fatal telemetry tag (same treatment as `null_byte_in_string` from v15.3.5). User prompts no longer dropped on minor metadata typos.

### Features

- feat(agents): Agents tab now renders Markdown via `<SkillRichView/>` — identical to Skills. No more raw `<pre>` text dump.
- feat(projects): IDE selector ampliado a 12 options — VS Code / Cursor / Insiders / Zed / IntelliJ IDEA / Rider / WebStorm / PyCharm / Android Studio / JetBrains Fleet / Neovim / Sublime Text. Backend `VALID_IDES` + `normalise_ide` + `slug_to_cli` + candidates fallback all updated.
- feat(command-palette): 4 new maintenance commands wired through `list_maintenance_commands_inner` — `agents-reembed`, `deadwood-scan`, `doctor-fix` (`--non-interactive`), `audit-skills` (persona audit).
- feat(button-prompts): 11 new entries covering previously empty sections — Personal (refresh_profile, refresh_known), Projects (suggest_refactor, generate_readme), Sessions (summarize, extract_decisions), Memory (consolidate, refresh_index), System (hook_review, diagnose_runtime), MCPs (debug_connection), Agents (batch_migrate).
- feat(installer): 5 new `Optional features` toggles on the visual wizard — `feat_notifications`, `feat_usage`, `feat_sessions`, `feat_project`, `feat_plans`. Wired through `Set-FeatureFlags` + `optOutManifest` so unchecking removes the implementing scripts idempotently.

### Cleanup

- chore(plans): reset `PLANS.json` — archive 9 wontfix entries to `_archive/resolved-2026-05-17.json`, keep only v15.4 → v15.7 vivos. Add `v15.4-control-center-polish` spec at `plans/specs/`.
- docs(INSTALL): expand opt-out manifest table to 8 rows, add **Post-install removal (advanced)** section explaining the three removal paths (re-run wizard, edit `features.json`, spawn Claude session).

### Verification

- `tsc --noEmit` green from CI on push.
- `uv run pytest tests/ -q` collection clean (no `ModuleNotFoundError: tui`).
- Manual smoke of `validate_push.py`: heredoc commit passes, raw `git push -f origin main` blocks.

_Polish reviewed adversarially via `/codex:adversarial-review` on the final diff (see commit body for findings)._


<!-- v15.3.6 -->
## v15.3.6 — 2026-05-17

- fix(v15.3.6): security CRITICAL fixes + bloatware cleanup + v15.4 plan document
- feat(v15.4): visual installer (WinForms) + agents wired into ULTRON core
- feat(v15.4-stabilize): split lib.rs + Settings.tsx + Sidebar tier reduction + Rust tests + CONTRIBUTING rewrite
- chore: refresh changelog (auto)

_Auto-generated from 3d25b052 by scripts/hooks/auto-changelog.py_


<!-- v15.3.5 -->
## v15.3.5 — 2026-05-16

- fix(v15.3.5): version drift sweep — SSOT sync + Doctor probe + auto-fix + agent catalog reality + Task matcher
- chore: refresh changelog (auto)

_Auto-generated from 27ed24e5 by scripts/hooks/auto-changelog.py_


<!-- v15.3.4 -->
## v15.3.4 — 2026-05-16

- feat(v15.3.4): Projects IDE-aware launch + System apps panel + AI Router auto-mode + Tauri auto-updater + docs sweep
- chore: refresh changelog (auto)

_Auto-generated from d93733bc by scripts/hooks/auto-changelog.py_


<!-- v15.3.3 -->
## v15.3.3 — 2026-05-16

- fix(v15.3.3): drop Cost watchdog + Discover, normalise agent models, tighter memory graph, scrub roadmap
- chore: refresh changelog (auto)

_Auto-generated from 0a69a36b by scripts/hooks/auto-changelog.py_


<!-- v15.3.2 -->
## v15.3.2 — 2026-05-16

- fix(v15.3.2): Backup-stale fix-it action + remove remaining 'cockpit' user-facing strings
- chore: refresh changelog (auto)

_Auto-generated from bf8db122 by scripts/hooks/auto-changelog.py_


<!-- v15.3.1 -->
## v15.3.1 — 2026-05-16

- feat(v15.3.1): agent security scanner + AI Router agent slot + editable button prompts + 15 community agents + Cockpit naming cleanup
- chore: refresh changelog (auto)

_Auto-generated from 0094caea by scripts/hooks/auto-changelog.py_


<!-- v15.3.0 -->
## v15.3.0 — 2026-05-16

- feat(v15.3.0): agent ecosystem — catalog, embeddings, telemetry, refreshed roster
- feat(v15.3.0-alpha): Agents tab — list / preview / edit / delete / AI / Discover
- chore: refresh changelog (auto)

_Auto-generated from 27d6d913 by scripts/hooks/auto-changelog.py_


<!-- v15.3.0-alpha -->
## v15.3.0-alpha — 2026-05-16

- feat(v15.3.0-alpha): Agents tab — list / preview / edit / delete / AI / Discover
- chore: refresh changelog (auto)

_Auto-generated from fe2d3297 by scripts/hooks/auto-changelog.py_


<!-- v15.2.39 -->
## v15.2.39 — 2026-05-16

- feat(v15.2.39): 7 nuevas zonas en AI Router para call-sites antes hardcoded
- chore: refresh changelog (auto)

_Auto-generated from be82d373 by scripts/hooks/auto-changelog.py_


<!-- v15.2.38 -->
## v15.2.38 — 2026-05-16

- feat(v15.2.38): hook validator tolerance + ndjson backfill + PC-with-Claude + Projects IDE button
- fix(ci): deselect one flaky telemetry test that needs populated routing tables
- fix(ci): junction-link workspace as ~/.ultron so expanduser-based path lookups work
- fix(ci): upgrade actions to v5/v6, exclude local-env-only tests
- chore: refresh changelog (auto)

_Auto-generated from 2f8ec5de by scripts/hooks/auto-changelog.py_


<!-- v15.2.37 -->
## v15.2.37 — 2026-05-16

- feat(v15.2.37): graph disk interior + CI + screenshots + quickstart + features picker + git hooks + Gemini icon

_Auto-generated from d9558ce6 by scripts/hooks/auto-changelog.py_


<!-- v15.2.36 -->
## v15.2.36 — 2026-05-16

- feat(v15.2.36): Settings App lifecycle tab — Uninstall + Update (Rebuild) buttons

_Auto-generated from 14794051 by scripts/hooks/auto-changelog.py_


<!-- v15.2.35 -->
## v15.2.35 — 2026-05-16

- fix(v15.2.35): hashtable splat for inner installer + relax EAP around every native binary

_Auto-generated from 5fd57f56 by scripts/hooks/auto-changelog.py_


<!-- v15.2.34 -->
## v15.2.34 — 2026-05-16

- fix(v15.2.34): inner installer skips redundant uv sync to avoid Windows file locks

_Auto-generated from 688ed986 by scripts/hooks/auto-changelog.py_


<!-- v15.2.33 -->
## v15.2.33 — 2026-05-16

- fix(v15.2.33): installer robustness — PS 5.1 \$IsWindows, native-binary stderr noise, step numbering

_Auto-generated from cb0c31be by scripts/hooks/auto-changelog.py_


All notable changes to ULTRON Control Center will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Auto-updater wiring (`tauri-plugin-updater` is in Cargo.toml but not yet
  invoked from `lib.rs` — tracked as `si-p1-b-auto-updater`).

Out of scope (dropped from the roadmap to keep the surface honest):
mobile companion app, remote BUS/sync server, supervisor daemon, DAG
scheduler. ULTRON stays a single-machine native tool. If something on
that list lands later it will be its own opt-in module, not a roadmap
promise.

Platform note: Windows 11 is the primary target. Linux x86_64 (Debian /
Ubuntu / Fedora / Arch) is supported from v15.5.0 with .deb + .AppImage
release artifacts and a parallel bash install path. macOS remains an
explicit non-goal.

## [15.2.32] - 2026-05-16

### Fixed — Docker scrub final pass
- `install.ps1`: replaced the Docker Desktop step with a Qdrant native
  step. Downloads `qdrant-x86_64-pc-windows-msvc.zip` v1.18.0 from the
  official release, extracts to `~/.ultron/qdrant-native/`, seeds
  `config/production.yaml`, and confirms `/healthz`. The
  `Test-Docker` / `Initialize-Qdrant` Docker functions are no longer
  called from the main flow (kept defined for git history).
- Banner now reads "Git, Node, Claude Code, Rust, uv" (no Docker).
- Step count down to 10 (was 11). Step 4 = Qdrant native, step 5 =
  directory layout, and so on.
- README EN+ES, INSTALL.md: every reference to Docker as a dependency
  or to `docker run qdrant/qdrant` rewritten to describe the native
  binary path. Auto-install matrix and troubleshooting tables updated.
  Uninstall snippet now uses `Stop-Process qdrant` instead of
  `docker stop qdrant`.
- Doctor: `probe_docker` removed from the full-diagnostic fan-out and
  the auto-fix allowlist; `probe_qdrant` already covered what mattered
  (the service health). Description text and Dashboard auto-fix copy
  updated to match.
- `restart-qdrant.ps1` auto-fix rewritten: no longer tries
  `docker restart` first; it just kills stale `qdrant.exe` and hands
  off to `ensure-qdrant.ps1`.
- Removed orphan `scripts/cockpit/auto-fixes/restart-docker.ps1`.
- `install-qdrant-bootcheck.ps1` task description rephrased to
  "native Qdrant binary, no Docker".

## [15.2.31] - 2026-05-16

### Added — hook bundle inspired by donchitos/Claude-Code-Game-Studios
- `scripts/hooks/pre_compact.py` — dumps L0 context.md, active plans,
  recent routing decisions and critical un-acked alerts to stdout RIGHT
  before Claude Code compacts the conversation. The dump survives
  summarisation, so the model retains its working state across compactions.
- `scripts/hooks/post_compact.py` — logs the compaction event and prints
  a short recovery roadmap pointing at context.md / Plans tab.
- `scripts/hooks/detect_gaps.py` — SessionStart hook. Lists open loops:
  skills on disk missing from registry.json, plans idle >7 days, backups
  stale >14 days, skills currently quarantined, critical alerts un-acked
  >24h. `--json` mode is consumed by the Dashboard "Pending items" widget.
- `scripts/hooks/validate_push.py` — PreToolUse Bash matcher. Blocks
  `git push --force` / `-f` / `--force-with-lease` to protected branches
  (main / master / release / production). Exit 2 stops the tool call and
  raises a warn-level alert.
- `scripts/cockpit/ultron_statusline.py` — Claude Code statusline command.
  Renders one line at the bottom of the conversation: current mode,
  un-acked alerts count, last skill invoked, vault context age.
- `templates/settings-hooks.json` schema bumped to v2: added
  `permissions.deny` defense-in-depth list (rm -rf, force-push, sudo,
  *.env / credentials / *-secret reads), the new hooks across SessionStart
  / PreToolUse Bash / PreCompact / PostCompact, plus the statusLine entry.
  Re-run `install.ps1` to merge into `~/.claude/settings.json`.
- Tauri command `run_detect_gaps` invokes the same Python script the hook
  uses and returns `GapsReport { count, gaps[] }` for the Dashboard
  "Pending items" widget. Renders each gap with category, severity
  pill, detail and suggestion. Auto-refreshes on mount.

### Fixed
- Memory graph: replaced the square box-clamp with a soft circular
  confinement field. Nodes outside `MAX_RADIUS = VIEW * 0.42` get a
  return force proportional to overshoot — the "line of beads along the
  cube border" is gone, distribution looks organic.

## [15.2.30] - 2026-05-16

### Changed
- Notifications: deletion is now final. `delete_alerts_by_fingerprints`
  no longer writes silent backups under `~/.ultron/backups/alerts/`, and
  it evicts any ack-tombstone whose id belongs to a deleted alert. No
  history of dismissed notifications survives.

### Docs
- README EN+ES: public-beta banner up top and a Docs nav row linking
  Install / Changelog / Contributing / Security / Authors / Notice /
  License so GitHub-rendered README surfaces all of them.

## [15.2.29] - 2026-05-16

### Added
- Dashboard "Maintenance commands" panel with whitelisted one-shot
  cockpit operations grouped by skills / memory / system (skill registry
  rebuild, skill security audit, registry sync, vault sync, brain index
  update, MCP health, weekly backup). Output streams inline.
- Skills tab "Quarantined" filter pill (active by default), per-row
  security badge, security-first preview that auto-opens the findings
  panel when a skill carries warn/quarantine/block (SKILL.md dims behind).
- Projects: changing default_provider retargets the first claude/codex/
  gemini chip in the row to the new provider, optimistically and on disk.

### Fixed
- Memory graph tuning pass 1 (further refined in v15.2.31): world 5000
  -> 3500, gravity 0.002 -> 0.005, zoom range (0.15..5) -> (0.4..10),
  spring rest 220 -> 170, polar init 0.42 -> 0.3.

## [15.2.28] - 2026-05-16

### Added
- Skills: strict security mode (Option A). `skill_vault.py registry` now scans
  every active skill with `skill_sync_security` and writes a `security` block
  per registry entry (decision, findings_count, high_severity_rules, sha1,
  scanned_at). Skills with decision `quarantine` or `block` are demoted to
  state `quarantined` instead of `active`.
- Skills tab: new "Quarantined" filter pill (active by default), per-row
  security badge with the findings count, and a Security panel in the
  preview listing each finding (rule_id, severity, excerpt) plus an
  "Allow anyway" form (reason required) that writes a per-SHA1 waiver to
  `~/.ultron/config/skill-trust.yaml`.
- Rust commands: `get_skill_findings`, `allow_skill_manually`.
  In-tree SHA1 + civil-from-days date formatter (no new deps).
- `uninstall.ps1` at repo root: removes `~/.ultron/`, autostart registry,
  ULTRON* scheduled tasks, Start Menu / Desktop shortcuts, and prunes
  `~/.claude/settings.json` hooks that point at `~/.ultron/` (backup
  first). Skips `~/.claude/skills/` and third-party CLIs. Flags:
  `-DryRun`, `-KeepBackups`, `-NonInteractive`.
- README ES+EN: short uninstall block under the install one.

### Fixed
- ACL: `dialog:allow-confirm`, `dialog:allow-ask`, `dialog:allow-message`
  added to the default capability so `window.confirm()` (Clear all,
  Delete project, soft-delete etc.) no longer logs
  `Command plugin:dialog|confirm not allowed by ACL`.

## [15.2.27] - 2026-05-16

### Added
- Notifications: "Clear all (N)" button in the toolbar (red), wipes every
  visible group with a confirm prompt.

## [15.2.26] - 2026-05-16

### Fixed
- News: removed the unused Theme `<input>` (and the residual `setGenTheme`
  call that broke tsc in 15.2.26.1).
- Notifications "Fix with Claude/Codex" sessions now open in `~/.ultron/`
  instead of the user home — Claude lands closer to the cockpit it needs
  to inspect.

## [15.2.25] - 2026-05-16

### Fixed
- Newsletter clipboard prompt now includes an explicit `[SAVE INSTRUCTION]`
  block with the absolute target path so Gemini saves to
  `~/.ultron/cockpit/news/newsletter-YYYY-MM-DD.html` (not cwd).

## [15.2.24] - 2026-05-16

### Fixed
- Skill security scanner (Codex pass): markdown code-block masking
  (`_FENCED_CODE_BLOCK`, `_INLINE_CODE_SPAN`) so PI001/PI002 do not
  fire on code-block examples. PI005 skips routing-metadata keys
  (`tags`, `triggers`, `aliases`, `routing_hint`).

### Added
- `skill-trust.yaml` schema: `trusted_source_waivers` (bulk waiver for
  warn-class rules across trusted sources) — covers PI009 / PI012 noise.

## [15.2.23] - 2026-05-16

### Changed
- Hook path resolution: `hook_input_validator.py` no longer emits
  "stdin is not valid JSON" info events — only real validation failures.
- Test assertions catch-up after the schema additions.

## [15.2.22] - 2026-05-16

### Changed
- README tech stack rows: "Control Center" (was "Cockpit shell") to
  match the tab name. Unreleased changelog cleaned of items already
  shipped in earlier 15.2.x releases.

## [15.2.21] - 2026-05-16

### Fixed
- README tab list: 16 tabs (was incorrectly listed as 15).

## [15.2.20] - 2026-05-16

### Fixed
- Newsletter clipboard mojibake (CP1252 vs UTF-8): write text to a
  UTF-8-sig temp file and pipe via `Get-Content -Raw -Encoding UTF8 |
  Set-Clipboard`. Gemini preview models added to the picker.

## [15.2.19] - 2026-05-16

### Added
- AI Router: all 7 zones wired (`diagnose`, `summarize`,
  `brainstorm_plans`, `news_generate`, `skill_edit`, `mcp_create`,
  `repo_review`). Every spawned session now reads
  `read_ai_router()` for provider + model.

## [15.2.18] - 2026-05-16

### Fixed
- No-emoji policy enforced across UI (Fix-Codex buttons match Fix-Claude).
- Memory graph: polar init using `sqrt(area)` distribution + gentler
  gravity to prevent corner clustering.
- Hook noise: low-signal info events suppressed.

## [15.2.17] - 2026-05-16

### Added
- Notifications: bulk "Fix all with Claude / Codex (N)" buttons.

### Fixed
- Security scanner `local_skill_root` path was wrong
  (`~/.ultron/skills` → `~/.claude/skills`). Added `expanduser/expandvars`
  in `_is_trusted_source`. `_downgrade()` for locally-owned skills:
  block → quarantine (terminal still for third-party).

### Removed
- Cockpit dead-file cleanup (33 legacy files identified in audit F26).

## [15.2.16] - 2026-05-16

### Removed
- 33 dead / legacy files purged (audit F26 verdict).

## [15.2.15] - 2026-05-16

### Added
- Notifications: per-card "Fix with Claude / Fix with Codex" launcher.
- AI Router per-zone model selector (Settings → AI Router).
- README bilingual polish.

## [15.2.14] - 2026-05-16

### Removed
- Deep purge: zero personal-persona references left in tracked files
  (kirkardo / tio-gilito / tolkien / novalbos / news-publisher /
  einstein / alfred / don-claudio / terry-davis / jordan-belfort /
  mike-tyson / warren / pana / repo-evaluator / investment-advisor /
  personal-assistant / ue5-dev / MEGA-PLAN / trading / manolo-lama /
  profesor-fisica).

## [15.2.13] - 2026-05-16

### Fixed
- Memory graph world doubled to 5000 + gentler gravity to spread nodes.

## [15.2.12] - 2026-05-16

### Removed
- `web/`, `docs/download.html`. All `C:\Users\USER` references
  scrubbed from tracked files.

## [15.2.11] - 2026-05-16

### Added
- Projects: per-project `default_provider` (claude / codex / gemini).
- Memory graph world expansion (first pass, refined in 15.2.13).

## [15.2.10] - 2026-05-16

### Fixed
- Skills personas restored from git history after an accidental delete
  in the `ultron-skills` clone (`.gitignore` added so they cannot be
  re-tracked).
- News clipboard `respect_clipboard` plumbed end-to-end
  (`SpawnFlags::respect_clipboard` + parse branch in
  `spawn-claude-session.ps1`).
- `catch_up` no longer arrives as the string `"True"` (PowerShell
  case-insensitive variable collision fixed).
- CHANGELOG backfill.

## [15.2.9] - 2026-05-16

### Added
- Zero-friction installer: `install.ps1` auto-installs Git, Node 22 LTS,
  Claude Code, uv, Rust, Docker Desktop via winget.
- Plans tab: archived drawer now lists `plans/_archive/resolved-*.json`
  entries synthesised with `status="archived"`.

## [15.2.8] - 2026-05-16

### Added
- Installer step: opt-in picker for community skills (`SkiTemplar/ultron-skills`).

## [15.2.7] - 2026-05-16

### Added
- Bilingual README (ES + EN) without screenshots; `memory_sync` stale fallback.

## [15.2.6] - 2026-05-16

### Fixed
- Settings hotkey capture no longer closes the window when user presses
  the global toggle combo (Ctrl+Alt+U). New `pause_global_hotkeys` /
  `resume_global_hotkeys` commands tear down OS-level listeners during edit.
- Newsletter Gemini flow: seed message no longer overwrites the real prompt
  the Python script seeded onto the clipboard. New
  `SpawnFlags::respect_clipboard` makes the spawn wrapper preserve clipboard.
- Dashboard full diagnostic: Docker missing reports gray "not installed"
  instead of orange warning (optional dependency, only used for Qdrant).

### Added
- In-app shortcuts editor in Settings → General (every Alt+N / Ctrl+K
  binding editable, persisted to `~/.ultron/.tmp/in-app-shortcuts.json`).
- Custom project hotkeys: bind arbitrary `Ctrl+Alt+<key>` combos to open
  any project from anywhere. Backed by `project_hotkeys::register_custom_hotkeys`.
- Settings Editor visual form mode (toggle "Raw JSON / Visual form") with
  dedicated editors for `hooks` and `mcpServers`.
- Settings Backups file picker via `@tauri-apps/plugin-dialog`.
- System tab "Overview" sub-tab consolidates RAM/CPU/disk/GPU/network +
  top processes.

### Changed
- Projects launcher: built-in items render as 28x28 icon-only buttons
  (Lucide-style folder + Claude-orange "C" + Codex-green "X");
  custom items render as name-only pill cards.
- Memory tab: single unified layout. List/Highlights/Graph toggle removed.
  Force graph now zoom-and-pannable (wheel 0.25-4x, drag pan, Reset view).
  Sidebar with Quick stats + compact Highlights + recent notes.
- System tab sub-tabs reduced: Overview · Schedules · Hooks (was 4).

## [15.2.5] - 2026-05-16

### Added
- 11 core skill stubs in `skills/<name>/SKILL.md` so a fresh install
  no longer skips the manifest's `claude://` skills silently.
- Wake-up templates: `CLAUDE.md.example`, `SYSTEM-MAP.md.example`,
  `MEMORY.md.example`.
- Cockpit + personal seeds (projects/apps/profile/known/vault README).
- `install.ps1` seeds wake-up files + cockpit seeds on fresh install.

### Changed
- 11 core skills in manifest flipped from `claude://` to `repo://`.

## [15.2.4] - 2026-05-16

### Fixed
- Settings "flicker raro": `reg.exe` spawns in `purge_legacy_autostart_inner`
  now use `CREATE_NO_WINDOW`. No more console flashes on Settings mount.

### Removed
- `scripts/_legacy/shared-duet.ps1` (only deprecated file still tracked).
- `.gitignore` blocks `*.bak`, `*.tmp`, `*~`, `*.lock.tmp` defensively.

## [15.2.3] - 2026-05-16

### Added
- Personal tab double-column layout: left = read-only known.json view,
  right = Train style + sample preview.
- Backend: `read_personal_sample`, `train_personal_style`,
  `generate_style_sample` Tauri commands.

## [15.2.2] - 2026-05-16

### Added
- Phase 2 — Notifications & Windows toasts via `toast_emit.rs`.
- Phase 3 — Plans rework: per-column buttons, auto-archive, archived drawer.
- Phase 6 — Dashboard `full_diagnostic.rs` with 10 parallel probes +
  Auto-fix modal + auto-changelog hook.
- Phase 7 — Settings refactor (Hooks → System sub-tab, MCP toggles → MCPs).
- Phase 8 — Schedules catch-up window (StartWhenAvailable).

### Changed
- Phase 4 — Memory graph stable physics.
- Phase 9 — Polish: GFM pipe-tables, Projects sort, removed Memory-notes
  recent widget, tooltips on Hook Signals + token-usage events.

## [15.2.1] - 2026-05-16

### Changed
- Trim repo to publishable essentials (559 → ~470 tracked files).
- `install.ps1`: `Initialize-PythonVenv` runs `uv sync` BEFORE hooks merge.
- `skills/ultron/SKILL.md` shipped as template stub.

### Fixed
- Newsletter Gemini: `generate_news_inner` delegates to session flow
  (clipboard + wt.exe), no more OAuth-stuck-on-headless hangs.

## [15.2.0] - 2026-05-16 (release candidate)

First public-distributable cut of ULTRON Control Center. Repo is now
clone-and-install-able by third parties.

### Added
- MIT `LICENSE`, public `README.md` and `CONTRIBUTING.md`.
- `docs/INSTALL.md`, `docs/REPO-SPLIT-PLAN.md`, `docs/RELEASE-CHECKLIST.md` (originally landed as `RELEASE-CHECKLIST-v15.2.md`, renamed in v15.5.14),
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
- Sanitised personal references (uni credentials, Notion IDs, project
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
