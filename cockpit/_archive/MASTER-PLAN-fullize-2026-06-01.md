# MASTER PLAN — ULTRON "fullize final" (2026-06-01)

> Cierre de ULTRON como **producto final, sin overengineering**. Recortar mucho,
> dejar el núcleo (memoria, orquestador, router, hooks) al 100%. Rama:
> `fullize-2026-05-30`. Decisiones confirmadas con el usuario (ver abajo).

## Filosofía
KISS · producto final · nada extraño · funcional al 100% · quitar > añadir.
El núcleo importa; la UI sobrante es ruido. "Lo que mejor funcione aunque lleve más".

## Decisiones de arquitectura (confirmadas)
1. **Memoria = Qdrant + SQLite.** SQLite (`rusqlite`) = DB estructurada fuerte
   (kg, ecc-import, FTS, telemetría de routing, cola de batch, decisiones).
   Qdrant = vectores. HybridRecall L0/L1/L3 sobre SQLite + Qdrant + Mem0.
2. **Qdrant canónico = `D:\Ultron\qdrant`** (35 memorias vivas). Auto-launch desde
   el backend (`lib.rs run()` spawn). Cero migración de vectores.
3. **Auto-router = hook UserPromptSubmit**, enruta a "lo mejor de ambos"
   (skill-persona O agente técnico, nunca general-purpose).
4. **Limpieza backend = total**, respetando: `workdays` NO se borra (compile dep de
   `agent_orchestration`), `agents_pinned_*`/`recall`/`mem0`/`kg`/`qdrant` se quedan.

## Lista final de tabs (sidebar)
**Se quedan:** Dashboard (simplificado, + To-Do) · Usage (+ botón Proxy) · System ·
MCPs · Library (search arreglada + AI-install + bulk-disable) · Notes (+ To-Do, sin
send-to-project) · Sessions · Projects (sólo botones + kanban) · Settings (podado) ·
Notifications (podado).
**Fuera:** Workdays (tab) · Inbox (entero) · Memory (visual; backend se queda) ·
Plans/Changelog (ya fuera del sidebar).

## Projects → sólo botones (diseño V1)
Por proyecto: **Abrir IDE · Sesión IA (Claude/Codex/Gemini) · Abrir carpeta ·
Run Batch** + **Kanban board**. Nada más.
- `ProjectQuickActions.tsx` = fila de botones V1 (quitar Terminal + Refactor/README IA;
  AÑADIR Run Batch montando `BatchDropdown`).
- `ProjectWorkspace.tsx` = header + botones + `ProjectBoard` only. Borrar barra de
  sub-tabs, path v2-dashboard, e imports de paneles.
- BORRAR: ProjectJarvisLauncher, ProjectTerminal + `terminal/`, EmbeddedTerminal,
  ProjectSessions, ProjectContext, ProjectAgents, ProjectTimeline, ProjectNotes,
  DecisionsPanel, DecisionEditor, ProjectDashboard, DashboardPanel.
- AI button → `spawn_session` (CLI externa), NO pty-en-tab (terminales fuera).
- KEEP `agents_pinned_*` (ProjectBoard default-agent), Detach (chrome inofensivo).

## Olas de ejecución (commit por ola)
- **Ola 0 — Reset destructivo:** kanban de TODOS los proyectos a vacío + borrar
  archivados (`cockpit/projects/*/archives/`, `*.json`). Borrar `brain_index/index.db`
  (27MB huérfano). Plan + memoria. ✅ autorizado 2×.
- **Ola 1 — Cortes (yo, secuencial; tocan hubs App/Sidebar/lib.rs):** Projects→botones;
  quitar Workdays(front)/Inbox(entero)/Memory(visual); Settings/Dashboard/Notifications
  poda; backend cleanup total (respetando deps).
- **Ola 2 — Núcleo MEMORIA (#1):** SQLite store fuerte (`memory/sqlite_store.rs`),
  migrar kg.jsonl→SQLite, FTS5; Qdrant auto-launch (D:) + `ensure-qdrant`; wire
  HybridRecall L0/L1/L3 a un comando `recall` único; guard anti-embed-stub; verify real.
- **Ola 3 — Orquestador + Router + Hooks:** `ultron-orchestrator/SKILL.md` MAX
  (sabe Run Batch, llama IAs por API, gestiona routing, hace código/research/resuelve);
  auto-router hook best-of (skill_graph+synonyms+telemetría); cola de batch rechazado
  (`batches-pending.jsonl` patrón `decisions.rs` + hook PreToolUse+Stop, user-click-only);
  afinar hooks (sin no-ops/duplicados, versionar en ~/.ultron/hooks).
- **Ola 4 — AI Router/Proxy + Usage + Library:** fix "Binario no encontrado"
  (proxy light-mode persist + probe 8082); botón Proxy en Usage (on/off + uso
  secundarias); Library search fuzzy+synonyms+ranking; bulk enable/disable;
  AI-install hardening (deep repo read, zona más fuerte); curar/desactivar
  skills/agentes poco usados.
- **Ola 5 — To-Do:** add-on simple en Notes (texto+check+borrar, store en
  `cockpit/notes/`) + card en Dashboard. KISS, "tan sencillo como Notas".
- **Ola 6 — Integración + verify:** auditar contract-drift (front↔back), `tsc`,
  `cargo check`, cerrar app + `npm run tauri build`, verify funcional, docs
  (README/CHANGELOG/SYSTEM-MAP simplificados), commit final.

## Riesgos vigilados
- `workdays` Rust = compile dep → tab fuera solo-frontend.
- `BatchDropdown` pierde su único host (ProjectTerminal) → re-hostear o Run Batch desaparece.
- Borrar comando Rust con `invoke()` vivo = panic IPC → verificar cero call-sites.
- Embed devuelve vector CERO si se compila `--no-default-features` → forzar `--features qdrant` + guard.
- Hooks viven en `~/.claude/` sin git → autorar en `~/.ultron/hooks` + instalar.
- `.ps1` que escriba el hook debe ser ASCII puro (PS 5.1 em-dash gotcha).
- Cola de batch = comando rechazado se vuelve 1-click-runnable → framing "requiere click", filtro forbidden-fragment.
