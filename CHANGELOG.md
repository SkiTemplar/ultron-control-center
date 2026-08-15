# Changelog

## Unreleased

Sprint ultracode 2026-07-22: cierre del harness kirkardo (OVERALL 9.73 · CORE
9.58 · 109/112 checks, partida 8.57/7.78). 13 commits (`30a2297..3608a32`).
Bloque 2026-08 (commits `d9a3ce5..44056f4` + instalador): Personalities v1,
detector de texto IA, statusline/vibe, atribución de proyecto en memoria y
selección de componentes en los instaladores.

### Added
- **Selección de componentes en los instaladores** (2026-08-15): `install.ps1`
  acepta `-All` / `-Core` / `-Skills` / `-Tones` / `-Agents` / `-DryRun` y
  `install.sh` sus equivalentes `--all` / `--core` / `--skills` / `--tones` /
  `--agents` / `--dry-run`. Modo determinista sin wizard; sin flags nuevos el
  comportamiento histórico no cambia. `tones` nunca toca un
  `personality.json` existente (config local gitignored; los seeds publicables
  van compilados en la app/sidecar).
- **Personalities v1** (2026-08-13/14): detección determinista del tono del
  chat en el orchestrate (señales léxicas + petición explícita), editor y
  playground en Library → Tones, directiva de compromiso total con límite duro
  de ámbito (solo chat, jamás artefactos); tono desacoplado del cache de
  memoria con gate de paridad JS↔Rust 16/16 (6846353, 194a2e0, 21887d0,
  9703855).
- **Detector de texto IA** (apoyo TFG): Lab de patrones deterministas sobre el
  catálogo de investigación (e92c4f5), hook PostToolUse `ai-text-warn`
  (147c41f), CLI del matcher + routing de la skill escritura-humana (9c08b44)
  y banco de casos por patrón (09220f8). Señala, no reescribe.
- **Vibe/statusline**: statusline propia de Claude Code (proyecto + rama +
  modelo + tono activo), barras de contexto y límites 5h/semana, color de
  Windows Terminal por proyecto en el spawn (fcb4927, f45ebe2, 4048892,
  70145e3).
- **Memoria**: atribución de proyecto real en la captura + backfill fase 2 con
  exclusión de huérfanos (277b5fa, dbe5e59), fase 4 LLM del backfill
  (f59f78d), preferencias/perfil a scope Global cross-proyecto (cb32075).
- **Finance**: wiring del write path + categorización IA (a09ee53; solo build
  local con `VITE_FINANCE=1`).
- **Grupos de equivalencia en el oráculo del eval golden** (`expect_groups`,
  collapse retrocompatible) + `DENSE_W` default 1.0→0.8 fijado con evidencia
  del sweep de knobs (3608a32).
- **Blindaje del daemon de memoria**: claim atómico del lockfile, prioridad
  BELOW_NORMAL en batch, eval fuera del hot-path (bd4e8cd).
- **Calidad de recall**: rerank hondo (RERANK_TOP_N 24→48), fanout por path de
  calidad, unaccent en el trust gate (9ca6d25).
- **CodeGraph siempre vivo**: ensure-codegraph en SessionStart + nudge
  reforzado + timeout adaptativo (30a2297).
- Titulado informativo de `agent_notes` en la captura (95c75fa).

### Changed
- CI: split del job Rust en clippy+test paralelos + `save-if` con `job.status`
  (`cancelled()` no es válido en inputs `with:`) — 511s → 144s (3758a60,
  e9eebdc).
- Medidor kirkardo recalibrado con techos medidos: GOAL recall 0.95→0.90,
  waste 0.4→0.62, timeout del eval golden 120s→600s (23283be).
- Tests de rules extraídos a `rules_tests.rs` (límite 800L) (3bca2ec).
- Remediaciones cats 5/9/11 del audit 2026-07-20 en cockpit (935bc2a).

### Fixed
- **Instaladores rotos en Windows PowerShell 5.1** (2026-08-15): `install.ps1`,
  `bootstrap.ps1` y `uninstall.ps1` contenían em-dashes en UTF-8 sin BOM, que
  PS 5.1 descodifica como ANSI y rompe el parser (21, 6 y 1 errores de parseo
  respectivamente con `.\install.ps1` desde un clone). Los tres scripts son
  ahora ASCII puro y parsean con 0 errores.
- Hooks: los turnos de SISTEMA ya no atraviesan el pipeline como prompts
  humanos (dc49cce); kanban-update-reminder sin bucle (880b422); arranque frío
  del orchestrate + falsos positivos del codegraph-reminder (c288b18).
- Dead-code `save_features` y contrato colgante eliminados (0ed9ee9).
- Tabla RULES normalizada a palabras desnudas — 14 patrones muertos por
  word-boundary (2209b0c).
- `summarize_session_activity` async + resumen AI bajo demanda (privacidad:
  los transcripts no salen a Groq/Gemini sin gesto explícito) (11d6589).

<!-- v15.7.0 -->
## v15.7.0 — 2026-07-18 — Auditoría cerrada + memoria por proyectos

Cierre al 100% de la auditoría ultracode 2026-07-16 (29 hallazgos + re-verificación
de los auto-refutados, todo medido en runtime) y el bloque de memoria por proyectos.

### Added
- **Hook `socratic-gate.js`** (UserPromptSubmit): inyección del protocolo
  socrático con escalada determinista ante acks de bajo esfuerzo, guard de
  delegación y detección de "opción sin porqué".
- **Memoria por proyectos**: `backfill-projects` (etiqueta el corpus ambiente),
  `reassign-project` (curación puntual), tarea semanal programada de backfill
  (label propagation) y down-rank de items ambiente bajo filtro de proyecto.
- **Inbox `drain --auto` full-autónomo** con re-verificación del juez fuera del
  hot path; gate anti-sondas + cap 3/sesión en posttoolfail-capture.
- **`sync-registry.js` emite `references/skill-registry.md` generado** (RT-07):
  el registro humano de skills se regenera de disco en cada sync — estado y
  descripciones del frontmatter real; flags `--md-only` / `--no-md`.
- Kanban: cierre de cards por token de fase + marcador de cierre; resume con
  edad visible cuando la card está stale. Card Terminal en Projects.

### Changed
- Warm-up del daemon de memoria en SessionStart + cap del fallback con pack
  cacheado (HOOKS-04): E2E 514ms con daemon; MISS capado (2.4s vs 4.1s antes).
- Limpieza de superficie muerta UI/backend: −629 líneas (auditoría por zonas).
- `.gitignore`: `cockpit/projects-archive/` (datos personales, misma regla que
  `cockpit/projects/`).

### Fixed
- **Dispatcher v3 zombie**: 4.5s de proceso colgado por prompt (timer sin
  clear) → 122ms medidos; telemetría ahora atribuye a v3, no a v2.
- Resolución de plugin skills (`commands/`/`agents/` además de `skills/`);
  catch-all de namespace eliminado (inyectaba manifiesto genérico para
  fantasmas); hint semántico ya no sugiere el inexistente `/use skill`.
- `stop-compress` 20-24s vs timeout 30s → subido a 60s (async, sin coste UX).
- `update-checker` comparaba versiones de esquemas distintos ("15.6.0 is out,
  you have 2.7.1" en una app más nueva que el release).
- `cut-release.ps1` alineado con el esquema SSOT real (estaba roto para este
  mismo release).
- 3 fuentes de `project_ids` basura cerradas + residuo de test purgado.
- `docs/INSTALL.md`: la nota "no release published yet" era stale (v15.6.0
  existe desde 2026-07-06); el one-liner de bootstrap funciona.

<!-- v15.6.0 -->
## v15.6.0 — 2026-07-06 — Primer release publico

El repositorio pasa a **publico** (auditoria previa del historial completo:
0 secretos, 0 PII sensible — gitleaks + barridos dirigidos verificados
hallazgo a hallazgo) y se estrena el pipeline de release automatizado.

### Added
- **Pipeline de release activo** (`release.yml`, antes `.disabled`): un tag
  `v*.*.*` publica NSIS `setup.exe` + MSI (Windows), `.deb` + `.AppImage`
  (Linux), el ZIP del sistema y el sidecar `ultron-memory` por plataforma
  (todo con SHA-256). Gate `finalize-release`: 10 assets verificados antes
  de publicar el draft; funciona sin secrets (auto-updater OFF deliberado).
- **Paso de instalacion del sidecar de memoria** (`install.ps1` 9b /
  `install.sh` 7c + `scripts/install-memory-sidecar.ps1/.sh`): presente ->
  skip · asset del release (SHA-256 verificado) -> deploy · fallback
  `cargo build`. Antes, una instalacion limpia quedaba sin recall semantico
  en silencio (el binario esta gitignored y ningun paso lo construia).

### Changed
- El ZIP del sistema ahora incluye `skills/` y `hooks/` (antes el bootstrap
  instalaba un sistema sin skills ni hooks).
- README: quickstart canonico = `install.ps1` / `install.sh` (sistema
  completo); build manual de la app como ruta secundaria.
- `docs/RELEASE-PROCESS.md`: la signing key del updater es OPCIONAL (solo
  para re-activar auto-updates); tabla de assets actualizada.

### Fixed
- `*.sh` forzados a LF via `.gitattributes` — el ZIP se construye en
  `windows-latest` (autocrlf) y los shebangs llegaban como `bash\r` a Linux.

## 2026-06 — Endurecimiento Kirkardo (iteraciones R5-R11 + sprint F0-F3)

Un mes de trabajo guiado por la auditoria Kirkardo (14 categorias con criterios
binarios verificados en runtime): memoria, routing, hooks, union del sistema e
infraestructura subidas de ~5.2 a ~8.3 sobre 10.

### Added
- **AI Router con salud real**: `last_error` / `cooldown` / `timeout` por proveedor,
  panel "Salud de providers" y boton de validacion de keys en Settings.
- **Mejora de prompt e2e** (`build_prompt_plan`): encuadre por intent, modo sugerido,
  criterios de exito y clarificaciones, inyectado en cada UserPromptSubmit.
- **LiveSessionMonitor**: visor en vivo de skills/agentes/routing + preview de
  orquestacion (`orchestrate_prompt`).
- **CodeGraph por proyecto**: panel que lee el grafo real (`codegraph_summary`) y el
  estado del indice; adopcion del CodeGraph externo con watcher.
- **Paneles por proyecto**: Git (mini GitHub-Desktop) y CodeGraph en ProjectWorkspace.
- **Learn**: guia de uso del orquestador.
- **Pre-commit** real: gate de datos personales + paridad del manifest de hooks + cargo fmt.

### Changed
- **Politica de router**: CLI-first para codigo (codex-cli); groq para zonas rapidas
  (chat / utility / routing) tras medir el cold-start de ~20s de gemini-cli.
- **Routing de skills**: modelo lazy on-demand (nucleo minimo activo, resto inyectado
  por el dispatcher determinista v2); mas peso a planning/orquestacion.
- **Memoria**: recall hibrido RRF (sparse FTS5 + denso E5) con escritor unico
  (MemoryService), redaction de secretos y eval reproducible.
- **Hooks**: fuente de verdad unica de ejecucion + manifest regenerable con checksums.
- **CI**: ejecuta tests de verdad (cargo test + vitest), hermetico, con gate de fuga
  de datos personales que bloquea en HIGH.

### Fixed
- gemini-cli 0/164 exitos: un backslash rompia el quoting de `cmd /C` (`sanitize_for_cmd`).
- codex-cli: usa el subcomando `exec` posicional, no `-p`.
- Compactacion de sesion restaurada (helpers de seguridad extraidos tras retirar el
  modulo externo de sincronizacion).
- fastembed con cache canonica unica (-10.9 GB de disco).

### Removed
- CodeGraph casero v4 (sustituido por el externo indexado).
- 85 comandos sin consumidor des-registrados + ~1020 lineas de codigo muerto.
- Scripts huerfanos, hooks stale, rutas personales y nombre de autor del codigo publico.
- Dependencias sin ahorro medido en runtime y un sistema de memoria externo redundante.

<!-- fullize -->
## fullize - 2026-06-01 — producto final, sin overengineering

Recorte grande a lo esencial + endurecimiento del núcleo (memoria, orquestador,
router, hooks).

Anadido:
- **Memoria #1:** SQLite "DB fuerte" (`brain.db`, FTS5 + migración kg.jsonl) +
  Qdrant (D:) con **auto-launch desde el backend** (arregla el "cerebro muerto
  tras reboot"). `recall_hybrid` (fan-out Qdrant/SQLite/Ecc/Kg/Mem0) + `memory_health`.
- **Orquestador ULTRON MAX:** sabe Run Batch, llama IAs por API (`ai_router_route`/
  proxy), gestiona el auto-routing, hace código/investiga/resuelve.
- **Auto-router de agentes especialistas** (UserPromptSubmit): persona/skill/agent
  best-of (rust-engineer, security-auditor…), nunca general-purpose.
- **Cola de Run Batch:** comando rechazado o que la IA no puede ejecutar queda en
  la cola (no se pierde) + hook `batch-capture.js`. UI "Cola" en BatchDropdown.
- **To-Do** simple en Dashboard y Notes.
- **Usage:** botón Proxy (on/off + uso de IAs secundarias).
- **Library:** search ranked (fuzzy+sinónimos), bulk enable/disable, AI-install mejorado.

Errores corregidos:
- Proxy free-tier "Binario no encontrado" → modo light funcional sin binario.
- Qdrant no auto-arrancaba (`ensure-qdrant.ps1` faltaba).

Eliminado (UI a lo esencial):
- Tabs Memory-visual (backend-only), Workdays, Inbox.
- Projects → solo botones V1 (IDE/sesión IA/carpeta/Run Batch) + Kanban; fuera
  terminales embebidas y sub-pestañas (Sessions/Context/Agents/Timeline/Decisions/Notes).
- Settings/Notifications podados. Kanban reseteado (incl. archivados). ~51GB de
  build/logs/archivados deprecados liberados.

<!-- v2.13.0 -->
## v2.13.0 - 2026-05-27 (acumula v2.12.1)

Errores corregidos:
- (sin cambios)

Anadido:
- Wave Feedback 2026-05-27e — 17/18 P0/P1 cierres masivos


<!-- v2.12.0 -->
## v2.12.0 - 2026-05-27 (acumula v2.11.1..v2.11.2)

Errores corregidos:
- (sin cambios)

Anadido:
- Memory.tsx split (1151→68L) + 6 sub-panes + Qdrant install D: drive
- auto-mejora KIRKARDO Round 7 — cierre de los 6 hallazgos
- Wave 6 — cerrar 5 cards Backlog + manual integration fixes


<!-- v2.11.0 -->
## v2.11.0 - 2026-05-27 (acumula v2.9.1..v2.10.1)

Errores corregidos:
- KIRKARDO 26 CRITICAL — workflows con agentes REALES + Round 6 sync

Anadido:
- AI Router pub fn route() + a11y fixes (KIRKARDO 28 + 25)
- ai_router_usage_summary command + Codex/Gemini subscription roadmap
- cost_watchdog usa ai_router::route() (PRIMER caller real) + quota 98% design doc
- Hooks redesign — sidebar categorías, colores por evento, auto-naming AI
- Fase 1 — 5 bugs P0 + Qwen exclude + Usage UI + Kanban sync masivo
- Fase 2 Library + Fase 5 Sessions/Dashboard/Usage + Fase 6 Settings parts
- Fase 3 Projects REDESIGN (Jarvis launcher + Context + Agents + Sessions + Timeline + ApiKeys + BatchDelete)
- Fase 4 Memory Graphify + Fase 6 System/Workdays + Fase 7 backlog técnico (KIRKARDO 14+19+16+21+26)
- KIRKARDO 29 — priority field en RegistrySkill + sort determinista
- Wave 5 — cerrar TODO el backlog técnico activo


<!-- v2.10.0 -->
## v2.10.0 - 2026-05-27 (Sprint masivo "feedback nocturno" — acumula v2.9.6..v2.9.9)

Sprint en 8 fases lanzado tras feedback verbatim del usuario (35 ítems agrupados en bloques A-I). Pattern: agentes paralelos sobre archivos independientes + wiring final + commits incrementales por wave.

### Fase 1 — 5 bugs P0 (v2.9.6)

- **A1 Notifications TypeError 'count'** — defensive defaults `(group?.count ?? 0)` en dedupe + alertasProp normalizado a `[]` + visibleTotal con fallback
- **A2 Project Notes y Notes globales no se mostraban** — `loadList()` retorna `Promise<NoteEntry[]>`, sets de selección en mismo tick para que `useMemo(selected)` calcule con datos consistentes
- **A3 Terminal cwd System32** — `ProjectTerminal` recibe `projectPath`, propaga a `pty_spawn cwd`; respeta `parent_folder_override` (fb-016)
- **A4 Tauri capabilities opener** — scope ampliado en `capabilities/default.json` (`$HOME`, `$HOME/**`, `.ultron`, `.claude`, `.ultron-vault`, `$APPDATA/**`, `$LOCALAPPDATA/**`, `C:\\Users\\**`, `D:\\**`, `E:\\**`). Sin wildcard `**/*` global
- **A5 Recall + Run Batch duplicados** — eliminados del header de `ProjectWorkspace` (se mantienen en Terminal toolbar hasta C10)

Features Wave 1:
- **I35 Qwen excluido del router** — `ai_router_validate_keys` + `ai_router_disabled_providers` commands; `route()` salta providers sin key sin contar métricas
- **F26 Usage UI** — `AiRouterSection` con FallbackRateGauge, ProviderRow, ZonePipeline, auto-refresh 30s

### Fase 2 — Library polish (v2.9.7)

- **D18 Agents.tsx unifica layout con Skills/Rules** — LibraryDetailPane kind=agent, sidebar categorías derivadas de filesystem (`~/.claude/agents/<folder>/`), accent violet
- **D19 Plugins update detection** — `plugin_check_updates_bulk` (gh API por SHA, cache 1h en `plugin-update-cache.json`) + `plugin_changelog_summary` (Haiku via AI Router). UI con badge "Update available", ChangelogPanel lazy, Update all bulk
- **D20 Hooks redesign (v2.9.5 standalone)** — sidebar categorías por evento, color por categoría sin amarillo global, `analyze_hook_name_inner` con AI Router utility zone + heurística fallback, cache en `hooks-names.json`, botón Auto-name all
- **D21 Catalog AI install** — `library_install_via_ai` clone temp → leer README + manifests → AI Router code-review zone analiza compatibilidad → JSON `{compatible, steps, copy_files, warnings}` → ejecuta con dry-run mode. UI modal preview + confirm

### Fase 3 — Projects REDESIGN completo (v2.9.8)

- **C11 ProjectJarvisLauncher** — landing tab nuevo `jarvis` (default) con 6 intents: Corregir errores (Bug, red) / Desarrollar desde 0 (Sparkles, cyan) / Recuperar de ayer (History, amber) / Equipo de subagentes (Users, violet) / Free prompt (MessageSquare, lime) / Investigar (Search, blue). Cada intent emite `JarvisIntent { id, label, provider, initial_prompt, spawn_kind }` y stash en sessionStorage al pasar a Terminal
- **C10 Wiring** — nueva sub-tab `jarvis` añadida a `ProjectSubTab` type, `TABS` array reordenado, default subTab cambiado de "board" a "jarvis"
- **C14 ProjectContext rewrite** — `project_context.rs` aggregator. CLAUDE.md detection en 3 paths (`<path>/CLAUDE.md`, `.claude/CLAUDE.md`, `.github/CLAUDE.md`). Mem0 search por `project.name` (antes filtraba por UUID inexistente → siempre vacío). KG entities filtradas. Kanban bug cards. `decisions.jsonl` parse. Git summary (branch + 10 commits). Next steps (mem0 + In Progress cards). UI: 5 paneles colapsables + Create CLAUDE.md button
- **C13 ProjectAgents rewrite** — `project_agents.rs` (detect stack, list `~/.claude/agents/`, `ai_router::route("utility")` propone roster JSON `{recommended, gaps, detected_stack}`). 4 commands Tauri. UI elimina "AI Configure Team Beta", cards con "Invoke from active session" que escribe a PTY Running más reciente del proyecto
- **C12 ProjectSessions rewrite** — `work_sessions.rs` nuevo módulo. WorkSession schema (`id, project_id, workday_id, started_at, ended_at, status, ai_session_ids, cards_touched, files_changed, notes`). Atomic JSONL en `cockpit/projects/<id>/work-sessions.jsonl`. 5 commands Tauri (start/end/list/link_ai/active). Frontend: ActiveSessionBanner con counter live + StartSessionBar con workday dropdown + History list expandable + SessionTimeline horizontal últimas 10
- **C16 ProjectTimeline polish** — w-110px → w-12 (48px), px-3 → px-1.5, gap-3 → gap-2, label flex-col, min-w-0 truncate. Resolved overflow con números 2 dígitos
- **C17 Batch + Settings ApiKeys** — `delete_batch_single` (path-traversal validation) + UI con confirm inline. `env_keys.rs` con whitelist 7 vars + `setx` User scope. `Settings/ApiKeysSection.tsx` nueva tab con 7 inputs password-masked + Save all bulk

### Fase 4 — Memory ULTRON-Graphify (v2.9.9)

- **E22 Memory tree tab** — `memory_graph.rs` con `memory_tree_snapshot` (load inicial sin round-trip mem0) + `memory_unified_search` (4 capas paralelas: skills/agents/rules grep, mem0 async, KG, Qdrant stub). `MemoryTree.tsx` (~680 LOC) con tree 280px + detail flex-1 + search sticky. Memory.tsx ahora con 6 tabs (Knowledge tree default, Live status, Brain, KG editor, Mem0, ECC)

### Fase 6 — System + Workdays + Settings (v2.9.9)

- **G27 Diagnostics rewrite** — 13 COMMON_ERRORS catalogados con severidad + descripción + check + fix por cada uno (mem0-unreachable, claude-login-expired, ai-router-no-keys, node-not-found, network-unreachable, port-1420-in-use, gh-cli-missing, tauri-capabilities-denied, qdrant-binary-missing, plugins-out-of-date, hooks-misconfigured, ultron-disk-usage, projects-json-missing, git-uncommitted-cockpit). Header con search + 7 filtros categoría. Botones Diagnose/Fix por error. Recent fixes telemetría localStorage. Windows Toolbox colapsable. Backend `diagnostics_run(error_id)` command
- **G28 MCPs audit** — `docs/mcps-audit-2026-05-27.md` (read-only). **CRÍTICO: GitHub PAT y mem0 keys EXPUESTOS en plaintext en settings.json — rotar inmediatamente**. Top-3 quitar (0 usos en 30d): sequential-thinking, memory (ECC+System32), mem0 MCP. Top-3 mantener: playwright (135 usos), github-pat (33), exa+context7. Hallazgo: los "chat MCPs" (imessage, telegram, fakechat, discord) NO están instalados — solo aparecen en el catálogo del marketplace
- **H29 Workdays wipe** — `workday_wipe_all_with_backup` con zip backup antes de delete. UI con confirm modal. `zip = "2"` crate añadido
- **H30 Workdays day timeline** — `HourBlock` schema + `workday_day_view` command. `WorkdayDayTimeline.tsx` timeline horizontal 24h con periodos morning/afternoon/evening/night y slices por proyecto
- **I33 Button Prompts cerrado** — audit, `useRoutingTitle` purgada de useState/useEffect huérfanos, `schema_version` corregido a 1
- **I34 AI Router Metrics no crashea** — `getClass()` guard + `EMPTY_CLASS_METRICS` fallback + `AIRouterErrorBoundary` class component + ZoneEditor toast save + empty state cuando todos los contadores son cero

### Fase 5 — Sessions + Dashboard + Usage (v2.9.7)

- **B6-B9 Sessions** — workspace card con 3 botones fijos `New` (Plus) / `Custom` (Sliders) / `Send ctx` (Share2) flex-1. `+Root` eliminado. `+Create Project` movido al header del grid (no en cards). Buscador global cross-workspace. `sessions_auto_tag` command (Groq llama-3.3 free / Gemini fallback) → 3-5 tags kebab-case en `sessions-tags.jsonl`. Tag chips clicables con mutual exclusion vs search text
- **F24-F25 Dashboard** — RecentSessionsCard eliminado. `WorkdaysWeekCard` nuevo: barra horizontal stacked 7 días con slices por proyecto, paleta 10 colores, tooltip fixed, dot indicator hoy con glow, métricas header

### Fase 7 — Backlog técnico (v2.9.9, KIRKARDO 14+19+16+21+26)

- **KIRKARDO 21 MemoryStore trait** — `memory/mod.rs` con trait + tipos (`MemoryHit, MemoryDoc, Query, StoreHealth, Capabilities, MemoryError thiserror`). Adapters: `Mem0Store` (wraps mem0 async via `tauri::async_runtime::block_on`), `EccStore` (read-only sobre `ecc_memory`), `KgStore` (read-write sobre kg). `HybridRecall` orchestrator detrás de feature flag `hybrid_recall` (default off). `recall::mem0_fallback` usa `Mem0Store` via trait. Funciones viejas `#[deprecated]`. 21 tests pasan
- **KIRKARDO 14 Qdrant wire chain** — `qdrant.rs` (~415L) con fastembed BGE-small 384d, `search(collection, query, k) → Vec<QdrantHit>`, `recall_semantic` command Tauri, `qdrant_status` ping para diagnostics. `qdrant-client = "1.10"` + `fastembed = "4"` added. `docs/qdrant-setup.md` con install instructions (Qdrant requiere binary externo, no embebido por size)
- **KIRKARDO 19 Concurrency locks** — `static WORKDAY_WRITE_LOCK: OnceLock<Mutex<()>>` aplicado en 8 commands RMW de workdays (start/pause/resume/complete/archive/link_session/append_context/record_kanban_event). `static KANBAN_WRITE_LOCK` en `kanban.append_run` y `kanban.archive_done`. Tests con contención simulada
- **KIRKARDO 16 Recall chrono + tests** — `format_iso` reimplementación (45L) → `chrono::DateTime::<Utc>::from_timestamp` (5L). `RecallError` con `thiserror` (NotFound/IoError/ParseError). 9 unit tests + 3 fixtures JSONL en `tests/fixtures/recall/`
- **KIRKARDO 26 Database-admin dedup** — `database-admin.md` → `.disabled`, canonical queda `database-administrator.md`, `rules/common/agents.md` actualizado
- **Skills priority field** — deferido a PR separado por el agent (requiere edición coordinada de `skills.rs` + `skill_vault.py` + 8 SKILL.md afectados)

### Kanban hygiene

- 4 cards movidas a Done: `agents-manifest-fantom`, `workflow-event-stream`, `a11y-tablist-dialog`, `workdays-accordion-polish`
- 31 cards nuevas del feedback (bloques A1-A5, B6/B9, C10-C17, D18-D21, E22, F24/F26, G27-G28, H29-H32, I33-I35)
- Fase 8 cierre Investigar (en progreso por agente background)

### Tests

- 156 unit tests Rust passing tras Wave 4 (KIRKARDO 19+16 añadieron ~15)
- TypeScript `tsc --noEmit` clean
- `cargo check` clean (warnings: ensure_collection/upsert_point de qdrant son dead-code esperado hasta wire del stop-hook compresor — KIRKARDO 14 paso 2)

### ⚠ Pendiente notable

> [!CAUTION]
> **SECURITY ADVISORY (acción urgente):** GitHub PAT y mem0 API key quedaron
> expuestos en plaintext en `~/.claude/settings.json` (reportado por G28 audit).
> **Rotar ambas claves inmediatamente.** Mem0 fue eliminado en el fullize 2026-06-01,
> pero las claves siguen en disco hasta que se roten/borren a mano.
- H31+H32 (Workday Goals + auto-AI-update) y H32 hook 15min — en progreso por agente background al cierre de la sesión
- KIRKARDO 14 paso 2 (stop hook compresor) + paso 3 (SessionStart recall inject) — `qdrant.rs` listo, falta hook JS y wire en linker

<!-- v2.9.0 -->
## v2.9.0 - 2026-05-26 (acumula v2.5.1..v2.8.9)

Errores corregidos:
- KIRKARDO round 1 fixes (5 reviewers, 12 issues applied)
- KIRKARDO round 2 - a11y + hook hardening + blackboard wire
- KIRKARDO 12 quick-win Tauri event stream + agents.md fantasma fix (external)
- KIRKARDO Round 4 quick-wins (hook 9/10, others honest)
- fix+feat(v2.8.9): Round 5 quick-fixes + batch cleanup + KIRKARDO 17 O(1) blackboard

Anadido:
- extra research + 8 backlog cards in ultron Kanban
- Oleada 2.1 - agent_toggle + batch spinner
- nocturnal sprint + Oleada 1 polish
- + New project layout + system troubleshooting + library catalog fix
- workdays + ai-router + detach + batches (sprint 2026-05-25)
- Active/Disabled/All toggle tabs + inline card switch
- Oleada 2.2 - Timeline ingests workdays + kanban moves
- Oleada 2.3 - delegations log + Recent runs cards
- Oleada 3 - D Sessions git_root + G ultron-orchestrator skill + H MemoryBrain
- batches/set-api-keys.ps1 interactive env var setup + kanban sync
- UX redesign ProjectWorkspace + Workdays accordion + Recall dialog (3 react-specialist agentes paralelos)


<!-- v2.7.1 -->
## v2.7.1 - 2026-05-24

Errores corregidos:
- BUG P0 Backup Force Now: weekly-backup.ps1 no leía backup-root.txt al reiniciar — ahora resolve order coincide con backend (file → env → default). run_backup_now_inner inyecta env vars desde config en cada invocación (stateless). Verified: copia las 5 carpetas al backup-root configurado con timestamp real.
- BUG Notes Delete confirm: popup contextual inline anclado al botón Delete (no bottom-left), click-outside dismiss.
- BUG Mem0 HTTP 400 query blank: search_inner retorna Ok(vec![]) si query vacío, sin llamada HTTP.
- BUG TS Catalog.tsx: Search icon style→className.

Añadido / Rediseñado:
- **Dashboard FULL REDESIGN**: AlertsCard banner top, trio Mem0+Pending+Backup, RecentSessions+RecentProjects, CrashEvents (sin Event Viewer button), PluginStatus. Typography baseline 13-14px, hero metrics 16-22px.
- **Library cards uniformes**: Skills (cyan/Sparkle), Agents (violet/Bot), Rules (lime/BookOpen). Detail pane compartido (LibraryDetailPane). Edit + Edit with AI + **Open Externally** (open_in_vscode con folder padre + archivo). Sibling tabs en detail pane.
- **System rediseño**: Bloatware eliminada. Apps con Library-style cards agrupadas por dominio. Hooks sub-tab eliminada (solo en Library). Diagnostics absorbe Troubleshooting con FIX_CATALOG (28 fixes) + KNOWN_ERRORS map (14 event IDs).
- **Hooks cards categorías**: 9 cards por evento con count+preview. Detail pane con Test/Edit/Delete. Instrumentation banner exacto.
- **Sessions modal overlays**: Custom y Send Context salen como LauncherModal, no inline. Botón Continue eliminado. Cards solo headline (project_name o cwd legible), sin session ID ni epoch.
- **Workdays sub-tab skeleton**: WorkdaysPanel con concepto + "Coming soon". Backend stub workday_list_inner. Card investigación añadida al Kanban.
- **Projects**: vista default = flat. Investigar fusionado en Backlog (SplitBacklogColumn vertical). Executables por proyecto (ProjectInfo.executables + launch_project_executable cmd + QuickLaunchPanel en Project Home). Archive Done + Show Archived (kanban_archive_done / list_archives / load_archive).
- **ProjectAgents → Agent Team**: rename "Pinned" → "Agent Team", roles editables inline, picker con sidebar de categorías. Workflow tiles con badge "Beta". Create skill from project relocalizado.
- **Plugins en Library**: grid 3 columnas, botones w-fit max-w-[120px]. Search for updates (check_plugin_updates via gh repo view).
- **MCPs**: enable/disable global toolbar eliminado.
- **Settings consolidation**: GeneralSection stub, todo movido a App Lifecycle renombrado "General". JsonVisualEditor orden por importancia.
- **Button Prompts vista categorías**: 2 niveles (categorías → prompts), modal overlay.
- **Notes**: Delete confirm popup anclado a botón. Editor pane usa ancho completo. Project Notes Enter para crear.
- **Sidebar**: font 15→16.5px, width w-56→w-64.
- **Backend nuevos commands**: open_in_vscode, read_text_file, bootstrap_ecc_memory, launch_project_executable, kanban_archive_done / list_archives / load_archive, workday_list, check_plugin_updates.

Mantenido para sesión adicional (columna Investigar del Kanban):
- /usage scraping, Background-tasks free-tier LLM, Graphify, Ralph, Sessions context backend, ProjectAgents workflows backend, KG MCP proxy, Catalog GitHub install completo, Workdays aggregator backend.


<!-- v2.7.0 -->
## v2.7.0 - 2026-05-24

Errores corregidos:
- Notes: createNew inline input + confirmDialog para delete/discard (sin alertas Tauri nativas)
- Notes: error al eliminar nota (confirmDialog reemplaza window.confirm)
- Library Catalog: URLs 404 marcadas con `dead: true` + razón (schema v2)
- Projects Terminal: wiring SplitPane → ProjectTerminal verificado
- System Apps: heurística reforzada con 6 reglas (Microsoft Store appx, Windows paths, MS runtime/updates, hardware drivers)
- Notifications: verificado, no había bug delete vs clear
- Mem0 cloud: JSONL log + diagnostics panel para debug visible
- Sessions debug round 2: console.log instrumentation con eslint-disable comment

Añadido:
- **Projects: New OpenGL Project (vcpkg) button** — genera CMakeLists/CMakePresets/vcpkg.json (glfw3+glad+glm)/common.h/main.cpp Simple|Context/README. Modal con parent folder picker (default sticky en localStorage).
- **Library Catalog: GitHub trending search** — modos Trending y Search libre. Backend `github_search_repos` y `github_search_trending` via gh subprocess. Catalog movido al final de SUB_TABS.
- **Diagnostics: auto-load + Event Log parsing** — wevtutil parsing, KNOWN_ERRORS db (12 IDs), severity badges, Open Event Viewer button.
- **Dashboard: CrashEventsCard** — solo crashes (IDs 41/1001/6008), 'All clear ✓' si no hay.
- **System: Bloatware sub-tab** — 6 categorías + ~30 apps. Backend `appx_query` + `uninstall_bloatware_app` con pattern allowlist + protected refusal.
- **System: Troubleshooting sub-tab** — 9 comandos en 3 categorías colapsables (Network, Storage, Shell).
- **Settings Backup: rewrite completo** — Destination + Folders + Schedule (schtasks WEEKLY) + Force backup now.
- **Settings General**: simplificado (Welcome screen y autostart eliminados, autostart movido a App Lifecycle).
- **Settings App Lifecycle**: añade Start with Windows. Uninstall block eliminado. Descripciones acortadas.
- **Settings Plugins**: grid de 2 columnas. Browse Marketplaces eliminado.
- **Memory Knowledge Graph: editor local funcional** — backend kg.rs con create_entities/add_observations/create_relations/search_nodes. Persiste en ~/.ultron/cockpit/kg.jsonl (mismo schema MCP). UI 3 paneles con SVG circular graph.
- **Memory Mem0 diagnostics panel** — JSONL log de todas las llamadas, last_success/last_error, API key check, Test connection button.
- **Sidebar**: Notifications movido al footer (junto a Settings). Items 15px + spacing aumentado.
- **Library Hooks**: rediseño con categorías colapsables por evento + cards compactas en filas.
- **Library Skills/Agents**: solo título en cards (sin descripción). Sibling files inline togglable.
- **Library Rules**: solo título en cards + padding reducido.
- **Library Commands**: grid 280px+1fr fijo. Categorías colapsadas por defecto. Preview pane denso.
- **MCPs**: sin ruta, grid xl 3-col, toggle Enable/Disable individual por card.
- **Sessions**: quita Open Folder/Open in IDE, añade Create Project, Custom popover simplificado (provider+model+Launch), search bar, agrupación por proyecto, badges de provider, Send Context → New Session.
- **Projects Kanban**: cards solo título (description en modal), botón Add más visible, collapse-column removido.
- **Projects CardEditorModal**: Advanced section colapsable + tooltips 'i' explicativos.
- **Projects Edit Modal**: convertido a overlay (fixed inset). Default provider selector. Nuevos campos: default_shell, parent_folder_override, notes, tags pool clickable.
- **Projects Notes**: notebook múltiple per-project (~/.ultron/cockpit/projects/<id>/notes/<slug>.md).
- **Projects ProjectAgents**: rewrite con cards estilo Library + 4 workflow tiles placeholder.
- **Projects Timeline**: 2-column grid (110px label + 1fr entries). Entradas inline 4-column.
- **Projects Terminal**: nombres de tabs automáticos (Claude/Codex/Gemini/PowerShell/Admin).
- **Notes global: Send to Project** — copia la nota al notebook del proyecto elegido.
- **Settings Button Prompts**: modal overlay para ver/editar. Audit: 2 prompts outdated marcados.
- **Font sizes**: ~50 archivos auditados — text-[11px] → text-[11.5px] (excepciones documentadas).

Pendiente para sesión adicional (columna Investigar del Kanban):
- /usage scraping (límite 5h + weekly)
- Background-tasks free-tier LLM
- Graphify integration
- Ralph agentic loop
- Sessions context transfer backend definitivo
- ProjectAgents workflows backend (multi-agent dispatch)
- Knowledge Graph MCP proxy sync
- Catalog GitHub install flow completo


<!-- v2.5.0 -->
## v2.5.0 - 2026-05-23

Errores corregidos:
- (sin cambios)

Anadido:
- (sin cambios)


<!-- v2.4.0 -->
## v2.4.0 - 2026-05-23

Errores corregidos:
- (sin cambios)

Anadido:
- (sin cambios)


<!-- v2.3.0 -->
## v2.3.0 - 2026-05-23

Errores corregidos:
- (sin cambios)

Anadido:
- (sin cambios)


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

Pre-2.0 history (v15.x and earlier) archived at `docs/CHANGELOG-archive.md`.
