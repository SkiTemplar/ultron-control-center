# MASTER PLAN — "ULTRON full" para el proyecto de equipo (2026-05-30)

> Run autónomo. USER away, full trust. Objetivo: dejar el Control Center
> **compilando, honesto y commiteado**, cerrando lo pendiente de memoria,
> agentes/skills, bugs del sistema, AI routing y el cockpit. Doctrina:
> "errores antes que features", incremental con checkpoint, build-gate +
> commit por bloque. Nada se da por aplicado sin compilar.

## Inputs consolidados
- **Investigación #1** (diseño/UX, 8 subsistemas): vision de cockpit, 6 pilares, 8 quick-wins, 6 decisiones.
- **Forense #2** (10 dominios + verificación adversarial): 11 fixes priorizados con evidencia file:line.
- **Research free-claude-code**: proxy `nielspeter/claude-code-proxy` (Go, binario, MIT) como sidecar.

## Decisiones LOCKED (USER)
1. Dashboard = **Híbrido**: ActiveProjectCard hero (Terminal/Contexto/IDE/IA + intents) + grid bento fluido full-width.
2. Proxy = investigar repo y **vendorizar si vale** → recomendado sidecar Go `nielspeter/claude-code-proxy`, fallback Python `Alishahryar1/free-claude-code`. Validación tool_use en vivo antes de fijar.
3. Ejecución = **olas paralelas** (cimientos + cockpit), con build-gate y commit por bloque.
4. Técnicas (yo): embeddings **e5-small 384-d** SSOT · kanban `role` canónico · detector descripciones→embeddings · resume PTY embebido.

## Salud por dominio (forense)
AI Router 3 · Memoria 4 · Orquestación 4 · UX/Shell 5 · Projects/Kanban 6 · System/Diag 6 · Sessions/Workdays 7 · Settings 7 · Terminal/PTY 8 · Notif/Plans 8

## EJECUCIÓN — checklist (marco según avanzo)

### Ola 1 — Honestidad backend (motores sin enchufe) [errores antes que features]
- [x] **F-AIR**: AI Router honesto — registrar zonas `utility`/`light` en seed_zones; `test_zone`→`bump_metrics`; banner "router no captura tráfico" si totalCalls==0; demote % a acordeón Avanzado. (ai_router.rs, RouterMetrics.tsx, Usage.tsx)
- [x] **F-CAT**: Sincronizar ProviderCatalog/ZoneEditor desde `ai_router_list_providers` (fuera anthropic/cerebras fantasma, costes/keys reales). (types.ts, ProviderCatalog.tsx)
- [x] **F-MEM**: Recall real — `default=["qdrant"]` en Cargo.toml (o `--features qdrant`); verificar embed BGE real (no vec![0.0;384]) y bundling onnxruntime.dll; cablear capa qdrant del unified search (memory_graph.rs:200 TODO). (Cargo.toml, qdrant.rs, recall.rs, memory_graph.rs)
- [x] **F-DIAG**: Implementar `diagnostics_run(error_id)` + registrar en lib.rs (mata 14 falsos "fail" rojos). (diagnostics_native.rs/system.rs, lib.rs, Diagnostics.tsx)
- [x] **F-SLUG**: Unificar slug Claude — `claude_sessions::project_slug_for` pub(crate), reemplazar el de timeline.rs (arregla Timeline por-proyecto en Windows). (timeline.rs, claude_sessions.rs)
- [~] **F-BUGS**: Force Backup respeta `r.success` ✓; botón IDE `{path,preferredIde}` ✓; appendFixHistory = n/a (símbolo no existe ya); spawn_inner inyecta prompt del card → DIFERIDO a Ola 3.

### Ola 2 — Cockpit + Kanban (valor visible)
- [x] **C-CLAMP**: clamp muerto (Dashboard `dashboard-shell` full-width; bento `auto-fit minmax(320px,1fr)`; Card sin minHeight; sidebar `w-64`) + ErrorBoundary por-tab (TabErrorBoundary).
- [~] **C-QA**: `ProjectQuickActions` creado + montado en ProjectCard + ProjectWorkspace header. PENDIENTE montar en ProjectRow (refactor Projects.tsx ~3600 líneas) → Ola 3.
- [x] **C-HERO**: ActiveProjectCard hero + RecentSessionsCard montada + intents Recall/Fix/Free lanzando vía spawn_session directo (sin sessionStorage muerto).
- [x] **C-DEC**: DecisionsPanel fuera del Board → sub-tab "Decisiones". Board 100% columnas.
- [~] **C-KAN**: backend `role` canónico + migración idempotente + CRUD columnas + 16 tests ✓. PENDIENTE UI de CRUD columnas → Ola 3.

### Ola 3 — Cimientos avanzados + proxy + detector + hardening
- [ ] **A-PROXY**: Vendorizar sidecar proxy (Go nielspeter) — proxy.rs lifecycle start/stop/health; `-FreeTier` en spawn-claude-session.ps1 (ANTHROPIC_BASE_URL=127.0.0.1:8082); toggle en Usage; auto-ON 98% vía quota_watchdog. Validar tool_use con NIM.
- [ ] **A-ORCH**: Conectar motor de orquestación (delegate_task, 7 workflows, ~1500 líneas muertas) a botón real en Agents + vista Inbox triage (list_inbox sin consumidor).
- [ ] **A-DET**: Detector agentes+skills+sesión: pasar descripciones (list_agents_with_origin), espejo para skills, converger a embeddings deterministas (e5-small).
- [ ] **A-DECQ**: Gate de calidad auto-captura decisiones (Stop hook importance>=0.7 + filtro anti-ruido git/CI/modelo). ⚠ hook en ~/.claude no versionado.
- [ ] **A-DETACH**: Reparar Detach (/detached/project router + reattach listener).
- [ ] **A-MEMUI**: KG editor borrar/relacionar; mem0 user_id=global hidratado; MCP badge invalidar por antigüedad.

### Cierre
- [ ] Auditoría independiente (council: architect + security + qa + code-review) sobre el diff.
- [ ] Build final / smoke-test (P0 REBUILD lo confirma USER).
- [ ] Actualizar kanban.json (mover cards a Done, añadir las nuevas) + memoria + commits.

## Riesgos vivos
- `--features qdrant` puede romper bundle si onnxruntime.dll no se incluye → validar arranque.
- Proxy free-tier degrada calidad agentic → botón = red de seguridad, auto-OFF al renovar cuota, aviso visible.
- Hooks de decisiones viven en ~/.claude sin git → endurecer + versionar copia-fuente.
- Migración kanban `role` toca datos persistidos → idempotente + reversible + test.
- cargo lock impide agentes Rust en paralelo en el mismo workspace → secuenciar backend.
