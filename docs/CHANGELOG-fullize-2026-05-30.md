# Changelog — Campaña "ULTRON full" (2026-05-30)

Periodo: fullize-2026-05-30 rama (18 commits consolidados en main).

Derivado de [MASTER-PLAN-fullize-2026-05-30.md](../cockpit/MASTER-PLAN-fullize-2026-05-30.md) — campaña autónoma con run objetivo "Control Center honesto y compilando".

---

## [Unreleased] — fullize-2026-05-30

### Added

#### Honestidad backend (Ola 1)
- **AI Router honesto** — banner visible cuando `totalCalls == 0` (sin tráfico capturado); métricas degradadas a acordeón Avanzado; `utility` y `light` zones registradas en seed_zones.
- **ProviderCatalog sincronización real** — `ai_router_list_providers` command; keys/costes consultados en vivo, elimina providers fantasma (anthropic/cerebras sin credenciales).
- **Recall semántico BGE-384** — feature `qdrant` integrada; embedder BGE-small-en-v1.5 (384-dim) con ONNX; `recall_semantic` command Tauri; búsqueda unificada 4 capas (skills/agents/rules grep + mem0 async + KG + Qdrant).
- **Diagnostics nativo** — `diagnostics_run(error_id)` command (14 checks: mem0-unreachable, claude-login-expired, ai-router-no-keys, node-not-found, network-unreachable, port-1420-in-use, gh-cli-missing, tauri-capabilities-denied, qdrant-binary-missing, plugins-out-of-date, hooks-misconfigured, ultron-disk-usage, projects-json-missing, git-uncommitted-cockpit); mata falsos positivos rojo.
- **Slug canonización** — `project_slug_for` pub(crate) unificada; Timeline funciona por-proyecto en Windows (fix regresión).

#### Cockpit + Kanban (Ola 2)
- **Dashboard full-width** — `dashboard-shell` layout; bento grid `auto-fit minmax(320px,1fr)`; ErrorBoundary por-tab.
- **ActiveProjectCard hero** — intents lanzables directo (Recall/Fix/Free) via `spawn_session`; RecentSessionsCard montada; ejecución sin sessionStorage muerto.
- **DecisionsPanel separado** — fuera del Board; sub-tab "Decisiones" en kanban con filtro anti-ruido.
- **Kanban role canónico backend** — `role` field normalizado; migración idempotente; CRUD columnas (16 tests); UI pendiente.
- **ProjectQuickActions** — 4 botones por-proyecto (Terminal/IDE/Contexto/IA); montado en ProjectCard y ProjectWorkspace header.

#### Cimientos avanzados (Ola 3)
- **Proxy sidecar Go** — `proxy.rs` lifecycle (start/stop/health); env vars NIM/OpenRouter; sessions free-tier auto-ON 98%; toggle UI en AIRouterIndex; `-FreeTier` flag en spawn.ps1 PENDIENTE: binario Go externo (no vendorizado).
- **Orquestación delegación** — `delegate_task_launch` command; `list_delegations` lista agents; botón "Asignar tarea" en Agents; InboxTriage Vista (list_inbox). PENDIENTE: delete/mark/convert inbox backend.
- **Detector agentes/skills** — `project_propose_skill_roster` command (paridad skills); descripciones inyectadas al proposer; 4 tests. PENDIENTE: matching por embeddings.
- **Filtro ruido decisiones** — `is_noise` lógica en decisions.rs (drain-side, antes dedup); `decisions_reject_all_auto`, `decisions_purge_noise`; 29 tests. PENDIENTE: endurecer stop hook (~/.claude, no versionado).
- **Detach-reattach UI** — `/detached/project` route en main.tsx; DetachedProjectView; reattach via `listen('project:window-closed')`; tsc clean.

#### Memory UI improvements
- **MCP badge invalidar antigüedad** — respeta expiry timestamps.
- **Auth honesto** — token sin verificación visible; capa KG editor completa (crear/borrar/relacionar). PENDIENTE: mem0 user_id=global correcto.
- **Memory tree tab** — `memory_tree_snapshot` (load inicial sin round-trip); 6 tabs: Knowledge tree (default), Live status, Brain, KG editor, Mem0, ECC.

### Changed

#### UX/Dashboard
- Sidebar default aun Projects (sin cambios v2.0).
- Bento grid Cards sin minHeight fijo; responsive full-width.
- TabErrorBoundary por-tab para aislamiento de crashes.

#### Kanban data model
- Schema `role` field normalizado (canonización backend).
- Migración aplica a kanban.json idempotente; reversible en rollback.

#### Terminal / PTY
- `ProjectTerminal` recibe `projectPath`; propaga a `pty_spawn cwd`; respeta `parent_folder_override`.
- Capabilities Tauri ampliadas: `$HOME`, `$HOME/**`, `.ultron`, `.claude`, `.ultron-vault`, `$APPDATA/**`, `$LOCALAPPDATA/**`, `C:\\Users\\**`, `D:\\**`, `E:\\**` (sin wildcard global `**/*`).

#### AI Router metrics
- `getClass()` guard + `EMPTY_CLASS_METRICS` fallback.
- `AIRouterErrorBoundary` class component.
- ZoneEditor toast save honesto.

#### Qwen exclusión
- `ai_router_disabled_providers` + `ai_router_validate_keys` commands; providers sin key no se cuentan.

### Fixed

#### P0 bugs (Fase 1)
- **Notifications TypeError** — `(group?.count ?? 0)` defensive defaults; alertasProp normalizado; visibleTotal fallback.
- **Project Notes / Global Notes vacíos** — `loadList()` retorna Promise, set selección en mismo tick; `useMemo(selected)` con datos consistentes.
- **Terminal cwd System32** — ProjectTerminal inyecta cwd real via props; soporta override.
- **Tauri capabilities** — scope expandido para file dialogs multidisk.
- **Recall + Run Batch duplicados** — removidos header ProjectWorkspace (se mantienen en Terminal toolbar hasta siguiente release).

#### AI Router
- `route()` visibility (totalCalls==0 banner).
- Provider catalog fantasma (anthropic/cerebras).
- Cost watchdog usa `ai_router::route()` primer caller real.

#### Memory
- Mem0 HTTP 400 query blank → retorna Ok(vec![]).
- KG editor paridad CRUD.
- MemoryStore trait + 3 adapters (Mem0Store, EccStore, KgStore) con 21 tests.

#### Qdrant
- BGE-384-dim fastembed wire completo.
- `qdrant_status` command para diagnostics.
- `docs/qdrant-setup.md` con instrucciones install (binary externo requerido).

#### Concurrency
- `static WORKDAY_WRITE_LOCK: OnceLock<Mutex<()>>` en 8 commands RMW (workdays).
- `static KANBAN_WRITE_LOCK` en kanban.append_run / kanban.archive_done.
- 8 tests con contención simulada.

#### Recall chrono + tests
- `format_iso` reimplementación (45L) → `chrono::DateTime::<Utc>::from_timestamp` (5L).
- `RecallError` con `thiserror` (NotFound/IoError/ParseError).
- 9 unit tests + 3 fixtures JSONL.

#### Database-admin dedup
- `database-admin.md` → `.disabled`; canonical `database-administrator.md`.
- `rules/common/agents.md` actualizado.

#### Trabajo sessions backend
- `work_sessions.rs` nuevo módulo; WorkSession schema.
- Atomic JSONL en `cockpit/projects/<id>/work-sessions.jsonl`.
- 5 commands Tauri (start/end/list/link_ai/active).
- ActiveSessionBanner + StartSessionBar + SessionTimeline.

### Security

- **No regresiones críticas** — auditada por council (architect-reviewer + security-auditor + qa-expert + code-reviewer).
- **Nota pendiente:** GitHub PAT y mem0 keys en plaintext en `settings.json` (expuesto doc diagnostics 2026-05-29) — **ROTAR inmediatamente** (card-sec-rotate-leaked-tokens-2026-05-29).

### Tests

- **156 unit tests Rust** passing (KIRKARDO 19+16 añadieron ~15).
- **`tsc --noEmit` clean** (TypeScript).
- **`cargo check` clean** (Rust, warnings esperados en qdrant dead-code).
- **16 tests Kanban** role CRUD.
- **29 tests Decisiones** filtro anti-ruido.
- **Contención concurrency** 8 tests simulados.

### Pending / Requires Action

**3 acciones CRÍTICAS por USER:**

1. **Rebuild npm run tauri build + smoke-test** — valida compilación + Qdrant binary bundling, ONNX runtime.dll incluido.
2. **Compilar binario Go ultron-proxy.exe** — según `~/.ultron/proxy/HOWTO.md`; activa free-tier NVIDIA NIM auto-ON.
3. **Validar instalador limpio** — riesgo Qdrant/ONNX no copiados; cierra riesgo de "qdrant-binary-missing" en diagnostics.

**Para equipo:**
- Versionar `mem0-sync.js` hook (vive en `~/.claude/` sin git, riesgo pérdida).
- Vendor binario proxy Go en repo (recom. sidecar `nielspeter/claude-code-proxy` MIT).
- MEM0_USER_ID por dev (ya env-first, confirmar en `.env` local).

### Known Issues / Risks

- `--features qdrant` puede romper bundle si onnxruntime.dll ausente → **validar en smoke-test**.
- Proxy free-tier degrada calidad agentic → botón es red de seguridad, auto-OFF al renovar cuota, aviso visible.
- Hooks decisiones viven en `~/.claude` sin git → endurecer + versionar copia-fuente.
- Migración kanban `role` toca datos persistidos → idempotente + reversible probado (test coverage).
- `cargo.lock` impide agentes Rust paralelos en mismo workspace → secuenciar backend en CI.

### Notes

- **Ejecución incremental:** 3 olas (honestidad backend → cockpit visible → cimientos avanzados) con build-gate + checkpoint por bloque.
- **Doctrina:** "errores antes que features" — asertiva sobre completitud.
- **Auditoría:** 0 CRITICAL, council 5 reviewers (aceptado).
- **Ref:** [MASTER-PLAN-fullize-2026-05-30.md](../cockpit/MASTER-PLAN-fullize-2026-05-30.md)
