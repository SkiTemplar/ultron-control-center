# ULTRON Control Center — Arquitectura (v15.5)

Documentación de arquitectura mental para desarrolladores nuevos. Cada subsistema: qué hace, dónde vive, y cómo fluye front <-> backend.

## Introducción rápida

ULTRON Control Center es un Tauri 2 + Rust + React/TS monorepo que orquesta un ecosistema de herramientas para developers. Backend en `control-center/src-tauri/src/`, frontend en `control-center/src/`.

Flujo base: Frontend invoca `invoke("command_name", {...})` → Tauri despecha al backend Rust → comando `#[tauri::command]` en `src-tauri/src/commands/` → lógica de dominio en módulos clave → resultado JSON → frontend renderiza.

---

## 1. Dashboard & Cockpit (`dashboard_*.tsx`, `projects/DashboardPanel.tsx`)

**Qué hace**: Home visual. Tarjetas hero de proyecto activo, sesiones recientes, sesiones reanudables, recall, proyectos rápidos, metrices workdays, alertas.

**Backend** (`dashboard` module):
- Sin módulo backend dedicado; comandos vuelven a Projects, Sessions, Workdays.

**Frontend**:
- `src/components/Dashboard.tsx` (root container, tabs: Overview, Status)
- `src/components/dashboard/ActiveProjectCard.tsx` (hero card con botones Terminal/IDE/Contexto/IA)
- `src/components/dashboard/RecentSessionsCard.tsx` (últimas N sesiones, botones Resume)
- `src/components/dashboard/RecentProjectsCard.tsx` (grid bento proyectos frecuentes)
- `src/components/dashboard/ResumeSessionCard.tsx` (recall workflow)
- `src/components/dashboard/WorkdaysWeekCard.tsx` (jornadas activas hoy)
- `src/components/dashboard/AlertsCard.tsx` (última alerta)
- `src/components/dashboard/Mem0Card.tsx` (badge mem0 status)
- `src/components/dashboard/PluginStatusCard.tsx` (ECC, mem0 health)

**Flujo front↔back**:
- `invoke("list_projects")` → projects.rs:list_projects() → Vec<ProjectMetadata>
- `invoke("list_claude_sessions")` → sessions.rs → Vec<SessionMetadata>
- `invoke("recall_last_session", {project_id?})` → recall.rs:recall_last_session()
- Botones intents lanza `invoke("spawn_session", {intent: "Recall"|"Fix"|"Free", ...})`

**Decisión arquitectura**: dashboard = agregador no-opinionado. Value está en ProjectQuickActions (invoke terminal/IDE/editor) + visual de proyectos activos.

---

## 2. Projects + Kanban + Decisions (`Projects.tsx`, `kanban_sub/`, `commands/projects/`, `commands/kanban_sub/`, `decisions.rs`)

**Qué hace**:
- **Projects tab**: lista + grid proyectos, CRUD, apertura en IDE, settings por-proyecto.
- **Kanban (por-proyecto)**: tablero de tasks, columnas canónicas (`backlog|todo|in_progress|review|done`), tarjetas draggable, decisiones como sub-tab fuera del flujo.
- **Decisions**: registro de decisiones arquitectónicas, ruido auto-filtrado, UI aceptar/rechazar, inbox drain backend.

**Backend**:
- `projects.rs`: CRUD proyectos, apertura IDE, list_projects(), open_project(), create_project(), update_project(), delete_project().
- `kanban.rs`: 
  - Almacenamiento: `.ultron/cockpit/kanban/<project_id>.json` (tablero + metadata)
  - `kanban_list()` → Vec<Card>
  - `kanban_board_schema()` → lista columnas canónicas (role)
  - `kanban_create_column()`, `kanban_delete_column()`, `kanban_update_column()` (CRUD columnas, v15.5)
  - CRUD card: create/update/delete, reorder, move between columns
  - 16+ tests cubre idempotencia, migraciones schema.
- `decisions.rs`: 
  - Almacenamiento: `~/.ultron/cockpit/decisions.jsonl` (JSONL) + `~/.claude/decisions-pending.jsonl` (drain backend)
  - `decisions_list()` → Vec<Decision> (filtrado ruido: is_noise check)
  - `decisions_reject_all_auto()` (limpia propuestas spam)
  - `decisions_purge_noise()` (mantención)
  - 29+ tests anti-ruido.

**Frontend**:
- `src/components/Projects.tsx` (row grid ~3600 líneas, refactor pendiente)
- `src/components/projects/ProjectRow.tsx` (fila proyecto con modal settings)
- `src/components/projects/ProjectCard.tsx` (hero en dashboard, llama ProjectQuickActions)
- `src/components/projects/ProjectQuickActions.tsx` (botones Terminal/IDE/Context/IA, v15.5)
- **Kanban**:
  - `src/components/projects/ProjectWorkspace.tsx` (container por-proyecto)
  - `src/components/projects/Kanban.tsx` o `Board.tsx` (grid de columnas, v15.5)
  - Cards draggables, columnas reordenables (CRUD pendiente UI, v15.5)
  - Sub-tab "Decisiones" fuera del Board
- **Decisions**:
  - `src/components/projects/DecisionsPanel.tsx` (sub-tab Decisions)
  - Tabla decisiones, filtros (tipo, status), botones Aceptar/Rechazar
  - Detalle decisión + metadata (origen, fecha, agentes).

**Flujo front↔back**:
- Proyectos:
  - `invoke("list_projects")` → projects.rs:list_projects()
  - `invoke("open_project", {id})` → abre en IDE vía `project_context.rs:open_project_in_ide()`
  - `invoke("create_project", {name, path, ...})` → projects.rs:create_project()
- Kanban:
  - `invoke("kanban_list", {project_id})` → kanban.rs → {columns, cards}
  - `invoke("kanban_board_schema", {project_id})` → {columns: [...]}
  - `invoke("kanban_move_card", {project_id, card_id, col_id})` → actualiza pos local + backend sync
  - `invoke("kanban_create_column", ...)` v15.5 (UI pendiente)
- Decisions:
  - `invoke("decisions_list", {project_id?})` → decisions.rs → Vec<Decision> (ruido filtrado)
  - `invoke("decisions_reject_all_auto")` → limpia propuestas
  - Backend drains `~/.claude/decisions-pending.jsonl` (Stop hook) → cockpit/decisions.jsonl

**Decisión arquitectura**: 
- Kanban usa `role` canónico backend (no user-customizable hoy, evita 14 esquemas).
- Decisions = drain pipeline: hook Stop vacía pending → backend dedup+filter → UI show+accept/reject.
- Projects tab está 3600 líneas; refactor v15.6 separar por Project.

---

## 3. Workdays + Sessions (`workdays_sub/`, `commands/workdays/`, `sessions.rs`, `claude_sessions.rs`)

**Qué hace**:
- **Workdays** (jornadas laborales): crear/iniciar/pausar/completar jornadas, goals, auto-link sesiones, resumen IA auto-update.
- **Sessions** (Claude Code): spawn sesión con prompt, metadata por-proyecto, timeline, tags auto.

**Backend**:
- `workdays.rs` (CRUD jornadas):
  - Almacenamiento: `~/.ultron/cockpit/workdays/<date>.json` (historial día)
  - `create_workday()`, `start_workday()`, `pause_workday()`, `complete_workday()` (state machine)
  - `list_workdays()`, `get_workday_detail()`
  - `link_session()`, `link_task()` (asocia sesiones a jornada)
  - `workday_auto_link_session()` (auto-link si active hoy)
  - `workday_goals_add()`, `workday_goals_update()`, `workday_goals_delete()` (CRUD goals)
  - `workday_ai_summary_generate()` (invoca resumen IA vía spawn_session)
  - Almacenamiento goals en DB (sqlite).
- `claude_sessions.rs`:
  - Envuelve `~/.claude/sessions/` (JSON por sesión)
  - `list_claude_sessions()` → metadatos sesiones
  - `project_sessions_list(project_id)` → sesiones del proyecto
  - `project_slug_for(project_id)` pub helper (unifica slug generación, arregla Timeline Windows)
- `sessions.rs` (spawn + lifecycle):
  - `spawn_session({prompt, project_id, intent?, ...})` → lanza Claude Code en terminal embebido o externa
  - `run_inline()` (ejecuta prompt inline sin spawn)
  - `list_workspaces()` (workspaces ECC)
- `sessions_tags.rs`:
  - `sessions_auto_tag()` → etiqueta sesión basada en contexto (proyecto, workday, intent)
  - `sessions_bulk_auto_tag()` (batch)

**Frontend**:
- **Workdays**:
  - `src/components/Workdays/index.tsx` (root container, tabs: List, Calendar, Metrics)
  - `src/components/Workdays/WorkdaysList.tsx` (jornadas activas + historial)
  - `src/components/Workdays/WorkdayDayTimeline.tsx` (timeline eventos día)
  - `src/components/Workdays/WorkdayDaySummary.tsx` (resumen + goals)
  - Botones crear, iniciar, pausar, completar + goals CRUD + auto-resumen
- **Sessions**:
  - `src/components/Sessions.tsx` (lista sesiones globales)
  - `src/components/projects/ProjectSessions.tsx` (sesiones por-proyecto)
  - Botones spawn con intent (Recall, Fix, Free)

**Flujo front↔back**:
- Workdays:
  - `invoke("create_workday", {project_id?, goal?})` → workdays.rs
  - `invoke("start_workday", {id})` → cambia state a running
  - `invoke("complete_workday", {id})` → archiva, persiste
  - `invoke("link_session", {workday_id, session_id})` → asocia
  - `invoke("workday_goals_add", {id, goal})` → CRUD goals
  - `invoke("workday_ai_summary_generate", {id})` → spawn_session interno
- Sessions:
  - `invoke("spawn_session", {prompt, intent?, project_id?, ...})` → sessions.rs
  - `invoke("list_claude_sessions")` → claude_sessions.rs
  - `invoke("project_sessions_list", {project_id})` → filtering local
  - `invoke("sessions_auto_tag", {session_id})` → tags auto

**Decisión arquitectura**: 
- Workdays = granular (pause/resume, no solo on/off) para flow real.
- Sessions = delegados a Claude Code; Control Center = orquestador metadatos.
- Auto-link y auto-tag reducen friction.

---

## 4. Memoria: mem0 + Qdrant + Knowledge Graph (`mem0.rs`, `qdrant.rs`, `kg.rs`, `ecc_memory.rs`, `memory_status.rs`)

**Qué hace**:
- **mem0**: API LLM memory (recuerdos persistentes, búsqueda)
- **Qdrant**: recall semántico (embeddings BGE 384-dim, búsqueda vectorial)
- **Knowledge Graph**: grafo entidades + relaciones local (ECC-owned)

**Backend**:
- `mem0.rs`:
  - Almacenamiento: API remota (mem0.ai) + cache local SQLite
  - `mem0_status()` → health check (conexión, user_id ok)
  - `mem0_search(query)` → Vec<Memory> (búsqueda)
  - `mem0_add(text)` → agrega recuerdo nuevo
  - `mem0_delete(id)` → elimina
  - `mem0_list_all()` → todos los recuerdos
  - `mem0_diagnostics()` → test connection, token count
  - User ID: `${MEM0_USER_ID}` env (global hoy, per-dev a futuro)
- `qdrant.rs`:
  - Almacenamiento: Qdrant local (sidecar proceso)
  - Embeddings: BGE-small-en-v1.5 (384-dim) vía ONNX (bundled onnxruntime.dll)
  - `recall_semantic(query)` → busca en collection, retorna Vec<Match>
  - `qdrant_status()` → health check (proceso corriendo, colecciones)
  - `qdrant_embed_query(text)` → embeddings solo query (debug)
  - Feature-gated: `--features qdrant` en Cargo.toml (validación bundle ONNX crítica)
- `kg.rs` (Knowledge Graph editor):
  - Almacenamiento: Qdrant (mismo sidecar, otra collection) o SQLite local
  - `kg_read_graph()` → {entities, relations} snapshot
  - `kg_create_entities(entities)` → add/update nodos
  - `kg_delete_entity(id)` → remove nodo + edges
  - `kg_add_observations(entity_id, text)` → enriquece nodo
  - `kg_create_relations(...)` → add edges (A -[rel]-> B)
  - `kg_delete_relation(id)` → remove edge
  - `kg_search_nodes(query)` → search por nombre/tipo (TODO: embeddings matching v15.6)
- `ecc_memory.rs` (grafo ECC read-only):
  - Lee snapshot del grafo proyecto (ECC exportado)
  - `ecc_memory_read()` → {entities, relations}
  - `bootstrap_ecc_memory()` → indexa grafo inicial
- `memory_status.rs` (dashboard Memory tab):
  - `memory_status_mem0()` → {connected, count, last_sync}
  - `memory_status_ecc()` → {node_count, relation_count}
  - `memory_status_qdrant()` → {running, collections}
  - `memory_status_files()` → {total_memories, indexed}
  - `memory_sync_mem0_manual()` → force sync
  - `memory_graphify_index()` → index grafo a Qdrant
- `memory_graph.rs`:
  - `memory_unified_search(query)` → busca mem0 + Qdrant + KG, dedups, rank
  - `memory_tree_snapshot()` → serializa árbol KG para vis

**Frontend**:
- `src/components/Memory.tsx` (root container, tabs: Mem0, ECC, KG, Search)
- **Mem0**:
  - `src/components/memory/Mem0Pane.tsx` (búsqueda, nuevo recuerdo, listado)
  - `src/components/memory/Mem0Diagnostics.tsx` (health check, token estimate)
  - Badge "Conectado"/"Desconectado" (MCP invalidado por antigüedad v15.5)
- **ECC**:
  - `src/components/memory/EccGraphPane.tsx` (visualiza grafo ECC, read-only)
  - `src/components/memory/MemoryTree.tsx` (árbol nodos)
- **KG**:
  - `src/components/memory/GraphifyControls.tsx` (botones indexar, wipe)
  - Editor crear entidades, relaciones (UI PENDIENTE v15.5: borrar/relacionar backend)
  - `src/components/memory/MemoryBrain.tsx` (editor visual nodos/edges)
- **Search**:
  - Caja búsqueda unificada (mem0 + Qdrant + KG)

**Flujo front↔back**:
- Mem0:
  - `invoke("mem0_search", {query})` → mem0.rs → Vec<Memory>
  - `invoke("mem0_add", {text})` → agrega
  - `invoke("mem0_status")` → health
- Qdrant:
  - `invoke("recall_semantic", {query})` → qdrant.rs → Vec<Match>
  - `invoke("qdrant_status")` → health
  - `invoke("qdrant_embed_query", {text})` → embeddings debug
- KG:
  - `invoke("kg_read_graph")` → snapshot {entities, relations}
  - `invoke("kg_create_entities", {entities})` → add
  - `invoke("kg_delete_entity", {id})` → remove (UI pendiente)
  - `invoke("kg_create_relations", {from, to, type})` → edge (UI pendiente)

**Decisión arquitectura**:
- mem0 + Qdrant = memoria dual (semántica remota + semántica local)
- KG = grafo proyecto localmente, no centralizado
- Embeddings feature-gated; ONNX bundled (no descargas runtime)
- Search unificado = próxima ola (v15.6)

---

## 5. AI Router + Free-tier Proxy (`ai_router.rs`, `proxy.rs`, `src/components/AIRouter/`)

**Qué hace**:
- **AI Router**: enruta prompts a providers (Anthropic, OpenAI, Gemini, Groq, Ollama, DeepSeek) con fallback + métricas
- **Proxy free-tier**: sidecar Go `ultron-proxy` (MIT) que cachea/reutiliza tokens vía NVIDIA NIM free

**Backend**:
- `ai_router.rs`:
  - Almacenamiento: `~/.ultron/cockpit/ai-router/{providers.json, zones.json, metrics.json}`
  - Domain types: `ProviderClass` (Trivial|Light|Medium|Heavy), `ApiKeyStatus` (Configured|Missing|Placeholder)
  - `ai_router_list_providers()` → Vec<Provider> (id, name, cost_per_mtok, supports, api_key_status)
  - `ai_router_list_zones()` → Vec<Zone> (primary provider + fallbacks)
  - `ai_router_test_zone()` → invoca test prompt, retorna latency + tokens + excerpt
  - `ai_router_health_check()` → batch health checks (no tokens)
  - Métricas honesto (v15.5): `totalCalls==0` → banner "no captura tráfico"
  - `bump_metrics()` registra invocación real (usado por spawn_session internamente)
- `proxy.rs`:
  - Lifecycle: `proxy_start()`, `proxy_stop()`, `proxy_status()` → health check localhost:8001
  - `proxy_env_keys()` → {"NIM_API_KEY", "OPENROUTER_API_KEY", ...} (keys requeridas)
  - `proxy_set_free_tier(enabled)` → toggle auto-activación
  - Auto-ON a 98% demanda (v15.5: heurística: Si >N llamadas y degradación >X%, activate)
  - Binario Go no vendorizado aún (HOWTO en `~/.ultron/proxy/HOWTO.md`)

**Frontend**:
- `src/components/AIRouter/index.tsx` (tab AIRouter)
  - `src/components/AIRouter/ProviderCatalog.tsx` (grid providers, health badges, cost)
  - `src/components/AIRouter/ZoneEditor.tsx` (edit zones, primary + fallbacks)
  - `src/components/AIRouter/Usage.tsx` (métricas honesto: total calls, % success, % degraded)
  - Botón toggle "Free-tier (NVIDIA NIM)" (rojo warning si degradación >X%)
  - Acordeón "Avanzado" (demote % de métricas ahí, no hero)

**Flujo front↔back**:
- `invoke("ai_router_list_providers")` → catalog
- `invoke("ai_router_test_zone", {zone_id})` → test result {latency, tokens, excerpt, error?}
- `invoke("ai_router_list_zones")` → zones actual
- `invoke("ai_router_health_check")` → all providers health
- `invoke("proxy_status")` → running? latency?
- `invoke("proxy_set_free_tier", {enabled})` → toggle proxy

**Decisión arquitectura**:
- Router = simple JSON (sin LiteLLM sidecar), health checks baratos
- Proxy = sidecar Go independiente (start/stop on demand)
- Métricas honestas: muestra realidad (0 llamadas = "no captura", % degradados visible)
- Free-tier = botón rojo+aviso, toggle manual + auto-ON heurístico

---

## 6. Agents + Skills + Detector + Orquestación (`agents.rs`, `project_agents.rs`, `agent_orchestration.rs`, `inbox.rs`, `Library.tsx`)

**Qué hace**:
- **Agents**: lista (50+), CRUD per-proyecto, pinned, delegación de tareas
- **Skills**: CRUD, toggle, parser SKILL.md
- **Detector**: propone agentes/skills basado en descripción proyecto (embeddings pending v15.6)
- **Orquestación**: botón "Asignar tarea" → delegate → inbox backend drain → UI triage

**Backend**:
- `agents.rs`:
  - Almacenamiento: `~/.claude/agents/*.md` (no versionado)
  - `list_agents()` → Vec<Agent> (id, name, description, status)
  - `read_agent_md(id)` → content SKILL.md
  - `create_agent()`, `update_agent_md()`, `delete_agent()`, `agent_toggle()`
  - Per-proyecto roster: `project_roster_load(project_id)` / `project_roster_save()`
  - `list_delegations()` → recent task delegations
  - `delegate_task_to_agent(agent_id, task)` → crea task file
  - `delegate_task_launch(agent_id, task)` → lanza sesión + spawn
  - `agents_pinned_load/save()` → pinned agents list
  - `project_invoke_agent_from_session(agent_id, session_context)` → invoca desde sesión activa
- `project_agents.rs`:
  - `project_propose_agent_roster(project_id)` → propone agentes relevantes (TODO: embeddings v15.6)
  - `project_propose_skill_roster(project_id)` → skills recomendadas (descripción → embeddings pending)
- `agent_orchestration.rs`:
  - Workflow delegación:
    1. Usuario selecciona agente + escribe task
    2. `delegate_task_launch()` → crea task JSON + lanza sesión
    3. Sesión runbook: lee task → invoca agente → retorna resultado
    4. Backend drains resultado → inbox
- `inbox.rs`:
  - Almacenamiento: `~/.ultron/cockpit/inbox.jsonl` (JSONL)
  - `list_inbox()` → delegations pending triage
  - `inbox_mark_read()`, `inbox_delete()` (operaciones de inbox)
  - `inbox_convert_to_decision()` (move to decisions tab)

**Frontend**:
- `src/components/Library.tsx` (Library tab, sub-tabs: Agents, Skills, Commands)
- **Agents**:
  - Grid/list agentes con badges (status, pinned)
  - Botón "Asignar tarea" (modal → task text + submit)
  - Pestaña "Mi Roster" (per-proyecto agents)
  - Pestaña "Buscar" (search by name/description)
- **Skills**:
  - Similar a Agents (list, CRUD, toggle, read markdown)
- **Detector**:
  - `src/components/library/CreateAgentModal.tsx` (propone agentes en crear)
  - Skill roster UI pending (v15.5 backend listo, UI falta)
- **Orquestación**:
  - Botón "Asignar tarea" → modal texto → envía delegate_task_launch()
  - `src/components/InboxTriage.tsx` (sidebar widget: pending delegations)
  - Inbox modal (Ctrl+Shift+I hotkey)

**Flujo front↔back**:
- `invoke("list_agents")` → Vec<Agent>
- `invoke("project_propose_agent_roster", {project_id})` → [Agent] recomendados
- `invoke("project_propose_skill_roster", {project_id})` → [Skill] recomendadas (UI pendiente)
- `invoke("delegate_task_launch", {agent_id, task_text})` → crea task + spawn sesión
- `invoke("list_inbox")` → pending tasks
- `invoke("list_delegations")` → histórico

**Decisión arquitectura**:
- Agentes = observados de `~/.claude/agents/` (no Control Center-owned)
- Detector = embeddings pending (hoy propone basado en nombre pattern)
- Inbox = drain pipeline (sesión output → inbox → UI accept/reject/convert)
- Orquestación UI = Inbox sidebar + modal Ctrl+Shift+I

---

## 7. Terminal / PTY (`pty.rs`, `ProjectTerminal.tsx`, `EmbeddedTerminal.tsx`)

**Qué hace**: Terminal embebida (portable-pty + xterm.js) para Claude Code sessions + shell local

**Backend**:
- `pty.rs`:
  - PTY spawn/resize/input/output vía `portable-pty` (Windows/macOS/Linux)
  - `pty_spawn(cmd, args, cwd)` → {pty_id, initial_output}
  - `pty_input(pty_id, text)` → envía input
  - `pty_resize(pty_id, rows, cols)` → ajusta tamaño
  - `pty_read_output(pty_id)` → streaming output (event-based)
  - Limpieza automática on exit

**Frontend**:
- `src/components/projects/ProjectTerminal.tsx` (embed terminal per-proyecto)
- `src/components/projects/terminal/TerminalLeaf.tsx` (xterm.js widget)
- `src/components/projects/terminal/SplitPane.tsx` (split panes)
- `src/components/EmbeddedTerminal.tsx` (global embedded shell)
- Input/output via Tauri events bidireccionales

**Flujo front↔back**:
- `invoke("pty_spawn", {cmd, cwd})` → pty_id
- `listen("pty:output", (pty_id, data) => {})` → output stream
- `invoke("pty_input", {pty_id, data})` → send input
- `invoke("pty_resize", {pty_id, rows, cols})` → resize

**Decisión arquitectura**: PTY embebido, no lanza terminal externa (visual integrado)

---

## 8. System / Diagnostics (`diagnostics_native.rs`, `system.rs`, `System.tsx`, `Diagnostics.tsx`)

**Qué hace**: Health checks, alertas, logs, rendimiento, auto-repairs

**Backend**:
- `diagnostics_native.rs`:
  - 14+ checks: Tauri health, disk space, memory, plugins (ECC, mem0), API keys (Anthropic, OpenAI), qdrant status, net latency, lock files, .env perms, etc.
  - `run_full_diagnostic_native()` → {checks: [...], max_severity, duration}
  - Severidad: OK | Warning | Error
  - Headless mode: `--run-diagnostic` flag → exit sin UI
  - `diagnostics_run(error_id)` → re-run single check (mata falsos "fail" rojos)
  - Persistencia: `~/.ultron/cockpit/diagnostics/<timestamp>.json`
- `system.rs`:
  - `system_status()` → {cpu, memory, disk}
  - `system_logs()` → últimas N líneas de log
  - `system_restart_service(name)` → restart plugin/sidecar
  - `installed_apps()` → apps del sistema (IDE detection)

**Frontend**:
- `src/components/System.tsx` (System tab)
- `src/components/system/Diagnostics.tsx` (checks, re-run individual, timeline)
- `src/components/system/DiagnosticHistoryPanel.tsx` (historial checks)
- `src/components/system/DiagnosticSchedulePanel.tsx` (scheduler settings)
- Visual: cards por check con estado color (🟢 OK, 🟡 Warning, 🔴 Error)

**Flujo front↔back**:
- `invoke("diagnostics_run", {error_id?})` → {checks, max_severity}
- `invoke("system_status")` → {cpu, memory, disk}
- `listen("diagnostic-complete", (report) => {})` → realtime updates

**Decisión arquitectura**: Diagnostics = autoservicio (user re-runs on demand, no esperar), 14 checks cubre 95% de issues comunes

---

## Flujo de datos global

```
Frontend (React/TS)
  ├─ Event listeners (Tauri events)
  ├─ `invoke("command", {...})` → Tauri bridge
  └─ State (useState, Context, zustand pending)
         ↓
    [Tauri IPC bridge]
         ↓
Backend (Rust, Tauri)
  ├─ `#[tauri::command] pub async fn command(...)` wrappers
  ├─ Domain logic (projects.rs, kanban.rs, mem0.rs, etc.)
  ├─ Persistent storage (JSON, SQLite, Qdrant, file system)
  └─ Subprocess lifecycle (PTY, proxy, Qdrant sidecar)
         ↓
  Result<T, String> serialized JSON
         ↓
    [Tauri IPC bridge]
         ↓
Frontend render update
```

---

## Estructura de archivos clave

```
control-center/
├── src-tauri/src/
│   ├── lib.rs                      (entry, module declarations, command registry)
│   ├── main.rs                     (Tauri app builder)
│   ├── projects.rs                 (CRUD proyectos)
│   ├── kanban.rs                   (tablero, columnas, cards)
│   ├── decisions.rs                (drain decisiones, anti-ruido)
│   ├── workdays.rs                 (jornadas, goals, auto-link)
│   ├── sessions.rs                 (spawn sesiones, lifecycle)
│   ├── claude_sessions.rs          (metadatos sesiones ECC)
│   ├── sessions_tags.rs            (auto-tag sesiones)
│   ├── ai_router.rs                (routing providers, zones, métricas)
│   ├── proxy.rs                    (free-tier sidecar lifecycle)
│   ├── mem0.rs                     (API mem0 memory)
│   ├── qdrant.rs                   (recall semántico, embeddings)
│   ├── kg.rs                       (knowledge graph CRUD)
│   ├── ecc_memory.rs               (grafo ECC read-only)
│   ├── memory_status.rs            (memory tab dashboard)
│   ├── memory_graph.rs             (unified search, snapshots)
│   ├── agents.rs                   (agents CRUD, roster, delegation)
│   ├── project_agents.rs           (detector agentes/skills)
│   ├── agent_orchestration.rs      (workflow delegación)
│   ├── inbox.rs                    (task inbox, drain)
│   ├── diagnostics_native.rs       (14+ health checks)
│   ├── system.rs                   (status, logs, apps)
│   ├── pty.rs                      (PTY lifecycle)
│   ├── detach.rs                   (ventanas independientes proyectos)
│   ├── recall.rs                   (sesión anterior recall)
│   ├── commands/
│   │   ├── projects/               (project commands)
│   │   ├── kanban_sub/             (kanban commands)
│   │   ├── sessions_sub/           (sessions, PTY, timeline)
│   │   ├── workdays_sub/           (workdays commands)
│   │   ├── memory/                 (mem0, KG, recall)
│   │   ├── system_ops/             (diagnostics, settings)
│   │   ├── notes_sub/              (notes, inbox)
│   │   ├── workflows/              (plans, hooks, rules)
│   │   ├── library/                (agents, skills, plugins)
│   │   ├── batches_sub/            (batch scripts)
│   │   ├── misc_sub/               (hotkeys, MCPs, slash-commands)
│   │   └── decisions.rs            (decisions commands)
│   └── memory/                     (MemoryStore trait + adapters)
├── src/
│   ├── main.tsx                    (entry, routing /detached/project)
│   ├── App.tsx                     (root app, tab manager)
│   ├── components/
│   │   ├── Dashboard.tsx           (home tab)
│   │   ├── dashboard/              (dashboard sub-components)
│   │   ├── Projects.tsx            (projects tab)
│   │   ├── projects/               (project components, kanban, decisions)
│   │   ├── Workdays/               (workdays tab)
│   │   ├── Sessions.tsx            (sessions tab)
│   │   ├── Memory.tsx              (memory tab)
│   │   ├── memory/                 (mem0, KG, ECC sub-components)
│   │   ├── AIRouter/               (AI router tab)
│   │   ├── Library.tsx             (agents, skills tab)
│   │   ├── library/                (Library sub-components)
│   │   ├── System.tsx              (system tab)
│   │   ├── system/                 (diagnostics, logs)
│   │   ├── InboxTriage.tsx         (inbox sidebar widget)
│   │   ├── Sidebar.tsx             (nav tabs)
│   │   ├── EmbeddedTerminal.tsx    (PTY widget)
│   │   ├── CommandPalette.tsx      (cmd-K palette)
│   │   └── ... (otros componentes)
│   ├── types.ts                    (shared TypeScript types)
│   ├── lib/
│   │   ├── dialog.ts               (confirmDialog, etc)
│   │   ├── notify.ts               (toast notifications)
│   │   ├── status.ts               (status compute, colors)
│   │   ├── tauri-events.ts         (event listeners, tray)
│   │   └── ... (utilities)
│   └── styles.css                  (tailwind, fonts)
└── ...
```

---

## Notas de implementación

1. **Tauri IPC**: todos los comandos async, retornan `Result<T, String>`. Errores stringificados (frontend parsea y muestra).

2. **Storage**: JSON bajo `~/.ultron/cockpit/` (proyectos, kanban, decisiones, workdays, etc); SQLite para datos con acceso frecuente (goals, session tags).

3. **Events**: Tauri events para streaming (PTY output, workday updates); listeners en Frontend con `listen()`.

4. **Feature gates**: `--features qdrant` para embeddings (evita descargas ONNX si no needed).

5. **Helpers clave**:
   - `ultron_root()` → `~/.ultron` path (usado everywhere)
   - `project_slug_for()` → genera slug canónico proyecto (arregla paths Windows)
   - `emit()` → frontend event broadcasts

6. **Testeo**: 16+ tests kanban idempotencia, 29+ tests decisions anti-ruido, mocks en memory/, suite completa.

7. **v15.5 → v15.6 pendientes**:
   - KG editor UI: borrar entities, crear relaciones visual
   - Skill roster UI matching (detector embeddings)
   - Projects.tsx refactor (3600 líneas)
   - Memory unified search embeddings ranking
   - Proxy binario Go vendorizado + validar ONNX bundle

---

**Fecha**: 2026-05-30 | **Campaña**: fullize-2026-05-30 (18 commits)
