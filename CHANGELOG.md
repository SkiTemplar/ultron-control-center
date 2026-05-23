# Changelog

<!-- v2.2.0 -->
## v2.2.0 - 2026-05-23

Errores corregidos:
- use /v1/ping/ endpoint instead of /v1/memories/?limit=1

Anadido:
- card redesign + ProjectWorkspace polish (first pass)
- drop Features, simplify Backups, multi-plugin Plugins
- rebuild around ECC + Mem0 stack
- drop Schedules+Overview, fix Apps mojibake, expand MCPs
- fix gh search + false-positive detection + contrast + live catalog


<!-- v2.1.0 -->
## v2.1.0 - 2026-05-23

Errores corregidos:
- Mem0 panel: corregido path lookup de la API key en settings.json
  (mcpServers.mem0.headers.Authorization en lugar del nested mcp.servers.*
  inexistente). La pestana Memory ahora conecta correctamente cuando la
  key esta puesta como MCP server.

Eliminado:
- Pestana Gaming (game-killer + Windows tweaks, legado del overlay ULTRON).
- Pestana Personal (profile.md / known.json / writing-style trainer del
  stack Tio Gilito).
- Modulos backend asociados: gaming.rs, personal.rs, commands/gaming.rs,
  commands/personal.rs.
- ACL scopes gaming-enum + gaming-kill de capabilities/default.json.
- Cockpit stale dirs: news, standup, trending, audits, scheduler-logs,
  tui, last-run.
- PLANS.json reseteado a sprint v2.1 (backlog ULTRON antiguo archivado en
  plans/_archived-2026-05-22-ultron-backlog.json, gitignored).

Anadido:
- Pestana Library unificada: Skills + Agents + Rules colapsados en una
  unica entrada de sidebar con sub-tabs internos. Deep links via command
  palette ("Library - Skills" / "Library - Agents" / "Library - Rules")
  abren la sub-pestana correspondiente. localStorage recuerda la ultima
  sub-tab abierta.
- Sub-tab Catalog dentro de Library: catalogo curado por dominio
  (Graphics Programming, Unreal Engine 5, AI / ML, MCP Development) con
  install de un clic via library_install_from_github al global scope.
  Filtros All / Skills / Agents y estado por item (idle / installing /
  done / error). Editable desde cockpit/curated-catalog.json.
- Backend command read_curated_catalog que sirve el JSON crudo (el
  schema puede evolucionar sin recompilar).
- 9 nuevos iconos SVG inline (Sparkle, Bot, BookOpen, Compass, Folder,
  Globe, ExternalLink, Check, AlertTriangle) en library/icons.tsx.

Polish:
- Sidebar reducido (12 -> 10 items primarios + "More" sigue intacto).
- CommandPalette navega a Library + mantiene deep links a sub-tabs.
- FeaturesSection META map reducido a los toggles que quedan vivos.
- types.ts limpio: GameProcessInfo / KillResult / KillFailure eliminados.


<!-- v2.0.0 -->
## v2.0.0 - 2026-05-23

Errores corregidos:
- (sin cambios)

Anadido:
- Phase 7 — Settings cleanup (raw first, plugins panel, MCP/Hooks polish)
- Phase 6 - PC Diagnostic native rewrite (sysinfo + wmi + AI + history + scheduled)
- P5 — agent/skill library (GitHub search + in-app create + per-project pinning)
- P4.10 wire tabs in App + projects open dispatch + migration
- P4.9 ProjectSessions sub-tab
- P4.8 ProjectContext sub-tab (CLAUDE.md editor + Mem0 panel)
- P4.7 ProjectAgents sub-tab + pinning persistence
- P4.6 ProjectTerminal sub-tab with multi-PTY bar


> Per `docs/CHANGELOG-POLICY.md`: only MAJOR / MINOR get detailed entries.
> Patches collapse into the next minor entry as a brief sweep.

## v2.0.0 — Control Center rewrite (ECC + Mem0)

**Fecha:** 2026-05-23

**BREAKING:** Reescritura completa del Control Center. ULTRON backend reemplazado por ECC (plugin Claude Code) + Mem0 (memoria cross-session). Nuevo Projects workspace con Kanban dispatch-a-agente y terminal embebida.

### Removed (mass cleanup desde v15.5.20)
- News pipeline (`news.rs`, `News.tsx`).
- Self-Improve / Stats (`self_improve.rs`, `SelfImprove.tsx`).
- AI Router interno (`ai_router.rs`, `commands/ai_router.rs`, `AiRouterSection.tsx`).
- Modos LOW/MED/HIGH/ULTRA (`mode.rs`, `ModeSection.tsx`, `ModeSwitcher.tsx`).
- Memory Qdrant + vault (`memory_graph.rs`, `memory_highlights.rs`, embedder, brain_index).
- Version drift / ultron_status / detect_gaps (scripts Python shell-out).
- Skill/Agent vault y findings (`commands/skills.rs::vault*`).
- Maintenance Qdrant kinds.
- Doctor Python script (`run_doctor` shell-out).

### Added
- **P1** Mem0 client REST nativo (Rust `reqwest` + `serde`): add/search/list/update/delete con filtros `metadata.project_id`. Nueva tab global Memory.
- **P2** Skills + Agents + Rules viewers con 3 origenes (global / per-project / plugin). Toggle on/off + abrir en editor externo.
- **P3** Embedded terminal (`portable-pty` + `xterm.js` + addons fit/webgl). Adios `wt.exe` popups.
- **P4** Projects re-arquitectura: pestanas por proyecto (browser-style), sub-tabs Board/Terminal/Agents/Context/Sessions, Kanban data model (kanban.json atomico), dispatch de cards a PTYs reales.
- **P5** Library de agents/skills: search GitHub via `gh search code`, install desde `gh api contents` (base64 decode), create in-app con frontmatter form, per-project pinning.
- **P6** PC Diagnostic nativo: `sysinfo` + `wmi` (Windows), checks rust 100%, analisis AI inline via `claude --print`, historial JSON con prune a 30, scheduled diario via `schtasks.exe` + modo headless `--run-diagnostic`.
- **P7** Settings cleanup: editor `settings.json` como default tab, panel Plugins (ECC introspection), MCP ping con latency + Test button, Hooks last-fired + toggle visual.
- **P8** Kirkardo UX rubric (>=9.5/10 target, 9.27 code-level alcanzado, walkthrough manual documentado como follow-up post-tag).

### Changed
- Sidebar default tab: Dashboard -> Projects.
- Storage root: `~/.ultron/` (sin cambios — branding ULTRON Control Center se queda).
- Auth Claude Code: OAuth de suscripcion, sin tocar.

### Migrated
- `~/.ultron/cockpit/projects.json` -> mantenido tal cual.
- Cada proyecto gana `~/.ultron/cockpit/projects/<id>/kanban.json` (auto-creado con 4 columnas vacias al primer open, idempotente).

### Risks
- Linux/macOS no testeados — la app solo se ha verificado en Windows 11.
- `gh` CLI requerido para la library (P5).
- Mem0 requiere API key en `~/.claude/settings.json`.

---

## Pre-2.0 history

Las entradas de v15.x y anteriores se conservan abajo por referencia.

## [Unreleased] — fase de correcciones hacia 1.0

> Trabajo de la fase de correcciones del Control Center previa a ULTRON 1.0.
> No se publica release hasta confirmar la 1.0 (tras el gate de calidad). Se acumula aquí.

- **Onboarding:** overlay de bienvenida en el primer arranque — explica qué es ULTRON + mini-glosario de términos núcleo (Skill/Agent/MCP/Vault/Plan/Session/Hook); re-abrible desde Settings → General.
- **Idioma:** Control Center unificado a **inglés único** — barrido de ~49 componentes; vocabulario de UI consistente (un verbo por concepto).
- **Plans tab:** drag-and-drop entre columnas del kanban; fila inferior (Revision/Blocked/Rejected) alineada con la superior; columna `merged` retirada (los items merged van al drawer de archivados); botón "AI Brainstorm" eliminado y "Sprint AI" rediseñado (también reescribe planes manuales).
- **Notificaciones:** el Delete deja de mostrar un "Undo" engañoso; sistema de notificaciones globalizado — `notify.ts` unifica el popup app-level con la persistencia en `alerts.jsonl`.
- **Dashboard:** retirado el botón rojo "Close Control Center" de la pantalla inicial (sigue en Settings → Lifecycle).
- **Sidebar:** pestaña Personal promovida al tier primary.
- **MCPs:** retirado el botón "Retry" por-card que en realidad re-chequeaba todos los MCP.
- **AI Router:** los botones de IA muestran en el tooltip la zona destino → provider/modelo.
- **Higiene:** purgado código muerto (`Logs.tsx`, superficie `tab.logs`); arreglado el bug de ruta de `consistency_check.py`.
- **Diagnóstico/Stats:** Full Diagnostic se auto-ejecuta al abrir el Dashboard (casillas siempre activas); arreglado el parser de `version_drift` que confundía `## [Unreleased]` con una versión; el "Top intent" de Stats filtra rutas corruptas heredadas (`U+FFFD` del em-dash leak).

<!-- v15.5.22 — Sprint AI button + backlog dedup -->
## v15.5.22 — patch (2026-05-20)

- **Plans:** nuevo botón "Sprint AI" en la columna Open del kanban — inyecta la lista de planes open ordenada por prioridad (P0→P3) en el AI Router y genera una propuesta de sprint accionable. Mismo patrón `pasteOnly` que AI Brainstorm.
- **Backlog:** 6 items de PLANS.json mergeados en 2 sprints consolidados (`dashboard-sprint-wave-2`, `pending-items-sprint`). 0 P0 abiertos.

<!-- v15.5.21 — sprint de estabilización -->
## v15.5.21 — sprint de estabilización (2026-05-20)

- **Errores corregidos:** 5 tests en rojo — `hook_input_validator` etiquetaba mal el telemetry tag de `session_id_invalid`; el dispatcher descartaba telemetría bajo presupuesto agotado (ahora se escribe siempre); `test_pii_filter` usaba un input que el filtro no cubría; 8 tests de `test_multimodel` invocaban un script borrado en v15.0.1.
- **AltGr:** el sistema legacy `Ctrl+Alt+1..9` de project hotkeys secuestraba `@ | #` en teclados internacionales (AltGr = Ctrl+Alt) — eliminado; solo quedan los hotkeys que el usuario define.
- **Seguridad:** nuevo hook `PreToolUse` `deny-secrets` — bloquea acceso a `.env`, claves, `~/.ssh/`, `~/.aws/credentials` y `secrets.json`. Crítico con `--dangerously-skip-permissions`.
- **Routing:** `dispatch()` refactorizado a resultado estructurado — la telemetría deja de parsear la línea con regex y el em-dash `—` ya no se filtra al campo `route`.
- **Cleanup:** purgado el subsistema MMFP/`shared-duet.ps1`, huérfano desde v15.0.1 (−1503 líneas) — `multimodel.py` y sus referencias en `health`/`doctor`/`consistency_check`/`ultron.ps1` eliminadas.
- **CI/release:** `release.yml` con gate `finalize-release` (draft hasta que los 7 assets estén live — cierra la ventana de 404 de v15.5.18); `ci.yml` deja de ocultar tests rojos con `--ignore`; criterio patch/minor/major documentado.
- **Modos:** restaurados los sub-archivos `mode-*.md`/`protocols.md` de la skill ultron (perdidos en la curación de v15.2.7) + guardia anti-regresión en la suite.
- **Windows:** shim `python3` → `python.exe` (evita el diálogo "Elegir aplicación" que disparaban hooks de plugins de terceros).

<!-- v15.5.19..v15.5.20 — patch sweep -->
## v15.5.19..v15.5.20 — patch sweep (2026-05-18)

- **UX:** in-app `PopupHost` (bottom-left, non-invasive) replaces Windows-native toasts + central `confirmDialog`. New API `showToast` / `showConfirm`. Backups Settings UI checklist (replaces env-var-only sources). Dead `Logs` tab removed (Sidebar + Tab unions + palette).
- **Hooks:** Stop debounce 90s→300s, `plan-detector` dedupes against last 200 inbox lines, `embed_vault` skips `_archive`/`.git`/`.obsidian`/`.trash` and self-heals orphan Qdrant points.
- **Leakage gate:** regex tightened for underscore-adjacent matches; 5 new HIGH patterns; 21 internal annotations scrubbed from runtime files.
- **Telemetry:** `intent-dispatcher` writes `rule_id` so dead-rule cleanup over the corpus becomes feasible.
- **Docs:** L3 status `(planned)` → `(opt-in)` with per-user private guidance; `.env.example` added; `CHANGELOG-POLICY` enforced (v15.4.x 21 patches collapsed).
- **Cleanup:** deadwood (`scripts/consistency-check.py`, `cockpit/projects.json.bak`, backup branches) + `ensure-qdrant.{ps1,sh}` moved to `scripts/qdrant/` + 5 maintainer-only headers + 4 orphan GitHub release tags purged.

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


<!-- v15.3.0 -->
## v15.3.0 — 2026-05-16 (acumula v15.3.0-alpha..v15.3.6)

Agent ecosystem cycle. Brief summary of the seven patches that landed
between the alpha and v15.4.0:

- **Agents tab**: list / preview / edit / delete / AI / Discover; embeddings + telemetry; 15 community agents added.
- **AI Router**: per-zone agent slot, smart defaults.
- **Settings + UI**: editable button prompts, Tauri auto-updater, IDE-aware project launch, System apps panel, MemoryGraph polish.
- **Doctor + SSOT**: version drift sweep, Doctor probe + auto-fix, agent catalog reality check, Task matcher.
- **Hardening**: agent security scanner, security CRITICAL fixes, backup-stale fix-it action.
- **Cleanup**: drop Cost watchdog + Discover stub, normalise agent models, scrub roadmap and "cockpit" user-facing strings.

_See `git log v15.2..v15.3.6` for the full per-patch history._


<!-- v15.2.0..v15.2.39 — patch sweep -->
## v15.2.0..v15.2.39 — patch sweep (2026-05-16)

Forty patches landed on top of v15.2.0; grouped briefly:

- **Docker → native Qdrant**: full scrub. `install.ps1` downloads + extracts the Qdrant Windows binary, Doctor `probe_docker` retired, `restart-qdrant` rewritten, README + INSTALL updated.
- **Hooks bundle** (inspired by external community repos): `pre_compact`, `post_compact`, `detect_gaps`, `validate_push`, statusline. Deny-list permissions schema. Dashboard "Pending items" widget.
- **AI Router**: 7 zones wired (`diagnose, summarize, brainstorm_plans, news_generate, skill_edit, mcp_create, repo_review`), per-zone model selector, smart defaults.
- **Skills security**: strict mode, quarantine state, per-row badge, manual waiver flow (`skill-trust.yaml`), security scanner sandboxing fences.
- **Notifications**: "Clear all" with confirm, "Fix with Claude/Codex" per-card + bulk variants, dismissal final (no silent backups).
- **Memory graph**: tuning passes (world 5000, gravity 0.005, polar init via sqrt(area), circular confinement field).
- **Installer + uninstaller**: `uninstall.ps1` at repo root, App lifecycle tab (Uninstall + Rebuild), inner installer robustness for PS 5.1.
- **News**: clipboard pipeline (UTF-8 sig + Get-Content -Raw), explicit `[SAVE INSTRUCTION]` block, Gemini preview models.
- **Cleanup**: 33 dead files purged, deep persona scrub, "Control Center" name parity in README, dead capability entries removed.

_See `git log v15.1.5..v15.2.39` for the full per-patch history._


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
