# DIAGNÓSTICO — Memory-Orchestrated Agent Runtime (Fase 1)

> **[RECONCILIADO 2026-06-04 — ver `STATE-RECONCILIATION-2026-06-04.md`]** La decision locked "Embeddings = `bge-m3`"
> (seccion ~161) fue **DESCARTADA** durante la implementacion: fastembed 4.9.1 no lo soporta bien. Lo implementado
> y verificado es **MultilingualE5-Large 1024d** (ver `STATUS.md:22`). HEAD real `823ed67`.

> 2026-06-03 · rama `fullize-2026-05-30` · basado en lectura directa de código +
> 9 auditores paralelos (workflow `ultron-memory-audit`, 261 tool-uses).
> Evidencia con `file:line`. Veredicto por componente: GOOD/WRAP/MIGRATE/REWRITE/REMOVE.

---

## Los 8 problemas cardinales (cross-cutting, verificados)

1. **No hay fuente de verdad canónica — hay 5-7 sustratos compitiendo.**
   Mem0 cloud + ECC JSONL + kg.jsonl + brain.db (vacío) + Qdrant `ultron_sessions`(384) +
   Qdrant `ultron_vault`/`ultron_skills`/`ultron_agents`(768) + metrics.json + proxy-state.json.
   Cada módulo tiene su propia idea de "qué es la memoria" (`memory_status.rs` lista AÚN otra).

2. **La "DB fuerte" SQLite está MUERTA.** `brain.db` nace vacío: `SqliteStore::init()` e
   `import_kg_jsonl()` NO se cablean en `lib.rs` setup; NADIE llama `SqliteStore.add()` fuera
   de tests (`sqlite_store.rs:188-371`). El esquema real es una tabla plana
   `memories(id,text,namespace,source,tags,created_at)` + FTS5 + espejo KG. **Cero gobernanza**
   (sin status/confidence/importance/scope/project_id/supersedes/event-log).

3. **El writer real de memoria es un hook JS suelto → Qdrant es SoT indebido y frágil.**
   `stop-compress-session.js:600-624` comprime la sesión en facts y hace upsert DIRECTO a
   `ultron_sessions`; el transcript fuente se descarta. **Si Qdrant cae en Stop → pérdida total**
   (sin espejo en disco). El backend ni controla ni audita su propia memoria.

4. **Dos pipelines de embeddings INCOMPATIBLES sobre la misma Qdrant.**
   Rust **BGE-384** (`ultron_sessions`, vía sidecar `ultron-embed.exe`) vs Python **MPNet-768**
   (`ultron_vault/skills/agents`, `embed_*.py`). Un vector 384 jamás consulta una colección 768:
   **dos memorias semánticas que no se hablan**. Y el "hybrid" bueno (RRF+rerank) está en Python
   (`hybrid_retriever.py`), mientras el Rust `HybridRecall` es una **unión con scores mágicos**
   (Mem0=0.9, KG=0.7, ECC=0.6) ordenados contra coseno real → peras con manzanas.

5. **Degradación silenciosa a vector-cero.** Sin feature `qdrant`, `embed()` devuelve 384 ceros
   (`qdrant.rs:128`); sin el sidecar, el hook escribe puntos `embed_stub:true` igualmente →
   ruido matemático en el recall que parece "funcionar".

6. **No hay orquestador. "Workflow" = string hardcodeado.** TRES definiciones desincronizadas
   de "los 7 workflows" (`agent_orchestration.rs:900` / `workflow_loader` YAML / `workdays.rs:755`
   WorkflowTemplate). `brain_index/index.db` **NO existe** → `intent-dispatcher.py`+`agent_suggest`
   hacen silent no-op. `workflow_runs` SQLite con **0 filas**. Ningún `.tsx` invoca los comandos de
   orquestación. Único camino vivo: `delegate_task_launch` (fire-and-forget, 1 agente, sin hand-off).

7. **AI Routing NO toca memoria + doble router.** `route()` se usa para chat/utility/summarize
   (8 call-sites), **cero** para clasificación/extracción/dedupe/contradicciones. Sin política por
   tarea (grep `response_format|json_schema|temperature` → 0 matches). El proxy Node es un SEGUNDO
   router con su propio catálogo de modelos. Key whitelist **triplicada** (env_keys/proxy/seed).

8. **Dos sistemas de hooks; uno muerto. GUI de memoria borrada.** 11 hooks JS activos
   (settings.json) vs todo `scripts/hooks/*.py|ps1` huérfano (el "Brain v12", no cableado;
   install solo copia `*.js`). SoT operativo invertido: `~/.claude` sin git. La pestaña Memory
   completa se borró (Ola 1, `f5c52cf`); solo sobrevive `MemoryStatusCard` (health read-only) con
   bug de navegación. El inbox de validación (patrón Accept/Reject de decisions) también se borró.

---

## Tabla de auditoría maestra (condensada)

| Subsistema / pieza | Ubicación | Veredicto | Acción |
|---|---|---|---|
| MemoryStore trait + DTO | `memory/mod.rs:192` | **MIGRATE** | Conservar patrón repo; reescribir el DTO a `MemoryItem` canónico + `update()` |
| SqliteStore `brain.db` | `memory/sqlite_store.rs` | **REWRITE** | Esquema canónico (items+events+candidates), cablear init en `lib.rs` |
| QdrantStore / `qdrant.rs` | `memory/qdrant_store.rs` | **WRAP→índice** | Qdrant = índice derivado, no SoT; payload rico; hard-fail no cero |
| HybridRecall (Rust) | `memory/mod.rs:592` | **REWRITE** | Recall híbrido real (dense+sparse→RRF→rerank, filtros status/scope) |
| Mem0Store + `mem0.rs` | `memory/mod.rs:239` | **MIGRATE→REMOVE** | ETL one-shot de cloud → canónico; eliminar (opaco, sin key, no auditable) |
| EccStore + `ecc_memory.rs` | `memory/mod.rs:366` | **REMOVE** | Externo, read-only, substring, bajo valor → fuera del recall |
| KgStore + `kg.rs` + kg.jsonl | `memory/mod.rs:455` | **MIGRATE** | Colapsar en `brain.db` (ya se espeja); una sola fuente |
| `stop-compress-session.js` | `hooks/scripts/` | **MIGRATE→candidate** | Emisor de candidates al backend (no upsert directo); persistir antes de Qdrant |
| `session-recall-inject.js` | `hooks/scripts/` | **WRAP** | Lector del recall unificado; filtrar por `project_id` canónico |
| `ai_router.rs` route core | `ai_router.rs:1439` | **MIGRATE→ModelRouter** | Capa TaskPolicy (temp 0, JSON schema) + `route_structured()`; wire tareas de memoria |
| call wrappers (5 APIs) | `ai_router.rs:1008` | **GOOD** | Conservar; añadir temperature/response_format/tool_choice |
| proxy `ultron-proxy.mjs` | `proxy/` | **WRAP** | Que consulte al router central; unificar catálogo de modelos |
| `env_keys.rs` / `proxy.rs` | — | **GOOD** | Conservar; unificar la whitelist triplicada en una fuente |
| metrics.json | `ai_router.rs:1599` | **REWRITE** | Telemetría → SQLite central, percentiles reales, proxy reporta |
| `agent_orchestration.rs` (7 wf) | `:900-1058` | **REWRITE** | Workflow declarativo de 1ª clase; contenido = seed |
| `workflow_loader.rs` (YAML) | — | **MIGRATE** | Fuente única de workflows; conservar loader/validador, ampliar schema |
| `workflow_runs.rs` (SQLite) | — | **GOOD** | Conservar esquema; conectar a un runtime real (0 filas hoy) |
| `project_agents.rs` selección | `:401-741` | **REWRITE** | Selección por embeddings + `allowed_agents`, no keyword+catálogo-en-prompt |
| `intent-dispatcher.py` | `scripts/hooks/` | **REMOVE** | Muerto (no cableado); reglas `intent-rules.yaml` migrables |
| `agent_suggest.py` | `scripts/cockpit/` | **MIGRATE** | Unificar selección de agentes sobre índice que SÍ exista |
| hooks legacy py/ps1 | `scripts/hooks/` | **REMOVE** | `auto-recall`/`session-init`/`stop-memory-sync` = Brain v12 muerto |
| `work_sessions.rs` | — | **GOOD** | Dominio limpio; desacoplar canal pending-file |
| `claude_sessions.rs` | — | **GOOD** | Lector read-only del historial Claude; centralizar slug/parseo |
| `hooks_admin.rs` | — | **GOOD** | Panel de hooks robusto; actualizar catálogo curado |
| stack Python cockpit | `scripts/cockpit/` | **MIGRATE/REMOVE** | RRF/rerank → portar a Rust; embed_*.py → ingest unificado; resto muerto |
| `MemoryStatusCard` | `dashboard/` | **GOOD** | Conservar; arreglar bug de navegación (CTA a panel Memory) |
| Mem0Card | `dashboard/` | **REMOVE** | Código muerto (no importado) |
| InboxTriage (borrado) | `f5c52cf~1` | **REWRITE** | Reconstruir Validation Inbox reusando patrón Accept/Reject de decisions |
| docs 05-25/26 | `cockpit/diagnostics/`, `control-center/docs/` | **REMOVE/archive** | STALE: mem0-SoT y LiteLLM revertidos; banner + archivar |
| `MASTER-PLAN-06-01` | `cockpit/` | **GOOD** | SSOT de intención; añadir tabla de estado por ola |

---

## Arquitectura objetivo (backend-first, reuse-first)

```
"Ultron" (trigger)
  └─ Hook UserPromptSubmit (1 dispatcher, no dos)
       └─ Intent Router (barato, ModelRouter) ─ detecta proyecto/repo/sesión
            └─ Workflow Selector (entidad declarativa) → Agent/Skill Selector (embeddings)
                 └─ Memory Retriever (recall híbrido real)
                      └─ Context Builder (presupuesto de tokens) → <ORCHESTRATION_CONTEXT>
                           └─ Ejecución
                                └─ Event log + Candidate Extractor
                                     └─ Dedup/contradicciones (ModelRouter barato)
                                          └─ Validation Inbox (Accept/Reject) → MemoryItem active
                                               └─ Reindex Qdrant (derivado)
```

- **Source of truth = SQLite `brain.db` REESCRITO** (rusqlite, ya es dependencia; WAL; FTS5).
  Tablas: `memory_items` (gobernanza completa), `memory_events` (append-only),
  `memory_candidates` (inbox), + reusar `workflow_runs` y `routing_telemetry`. Sesiones derivan
  de `claude_sessions`/`work_sessions` (GOOD).
- **Índice = Qdrant, UNA colección, UN modelo** (named vectors dense+sparse, payload rico,
  filtro `status=active`). Reindexable desde el canónico. Nunca SoT.
- **Embedding = UN sidecar** (extender `ultron-embed.exe`), shipping en build, hard-fail no cero.
  Matar el pipeline Python de embeddings.
- **Recall = híbrido real en Rust** (portar RRF+rerank de `hybrid_retriever.py` o usar Query API
  nativa de Qdrant). UN comando recall. Matar el dual recall.
- **Ingestión = backend-owned, candidate-first.** El hook propone candidates → backend
  valida/persiste → reindexa. Persistir en disco ANTES de Qdrant.
- **Memory Agent = único escritor persistente.** Hooks/agentes solo emiten candidates/eventos.
- **ModelRouter = `ai_router.rs` extendido** con TaskPolicy (temp 0, JSON schema) para tareas de
  memoria. Proxy delega la decisión. Una whitelist de keys.
- **Orquestador "Ultron" = workflows de 1ª clase** (colapsar las 3 defs, reusar loader+runs,
  step-runner real, sanear ghost agents).
- **Frontend mínimo**: `MemoryStatusCard` (fix nav) + **Validation Inbox** (reuse decisions).
  Todo lo demás → **CLI + logs**. CLI = superficie de control principal.
- **Mem0/ECC fuera**, KG colapsado, docs stale archivados.

De 7 sustratos → **1 canónico (SQLite) + 1 índice (Qdrant)**.

---

## Línea de corte por fases (incremental, commit por fase)

- **Fase A — Fundación memoria canónica (backend puro).** Esquema `memory_items`+`memory_events`+
  `memory_candidates`; `MemoryItem` domain; Memory service single-writer; cablear init en `lib.rs`;
  ETL one-shot (`ultron_sessions`+kg.jsonl+Mem0?) con reporte+rollback; tests de gobernanza.
- **Fase B — Índice unificado + recall real.** Modelo único; reindex Qdrant (1 colección, payload
  rico, dense+sparse); recall híbrido Rust (RRF→rerank→filtros→context pack con presupuesto);
  retrieval-explain a log; UN comando recall.
- **Fase C — Ingestión candidate-first + hooks.** Reorientar `stop-compress` a emisor de
  candidates; afinar hooks; matar legacy py/ps1; invertir SoT `hooks/`; módulo seguridad
  compartido; **Validation Inbox** (UI mínima) + `memory inbox/approve/reject` (CLI).
- **Fase D — ModelRouter + tareas de memoria.** `route_structured()` + TaskPolicy; wire
  clasificación/extracción/dedupe/contradicciones/query-rewrite/summarize a modelos baratos;
  cache por hash; telemetría → SQLite; consolidar key whitelist.
- **Fase E — Orquestador "Ultron".** Esquema Workflow único; step-runner + WorkflowRun estado;
  selección agente/skill por embeddings; converger dispatchers (uno); golden prompts.
- **Fase F — Limpieza + docs + verify.** Remove Mem0/ECC/dead-python/dead-hooks; reescribir
  ARCHITECTURE-overview; archivar docs stale; contract-drift audit + `cargo check` + `tsc` +
  build; docs CLI.

**Punto de arranque recomendado: Fase A** (fundación, backend puro, indispensable, desbloquea todo).

---

## Decisiones tomadas (USER, 2026-06-03)

1. **Embeddings = `bge-m3`** (multilingüe, dense 1024 + sparse léxico nativo desde un solo modelo).
   Razón: habilita hybrid dense+sparse nativo en Qdrant con un único sidecar, mejor recall en
   español, elimina la necesidad de FTS5 como segundo índice de recall. Se descarta BGE-384
   (inglés, dense-only) y `e5-small` (dense-only). Sidecar `ultron-embed.exe` se extiende a bge-m3.
2. **Mem0 = FUERA.** Da problemas y no aporta. REMOVE completo: `mem0.rs`, `Mem0Store`,
   `mem0-sync.js`, `Mem0Card`, dot mem0 en `memory_status`. (Opción de dump JSON one-shot de
   seguridad antes de borrar, descartable.)
3. **Vault histórico = RESCATAR.** ETL one-shot de `~/.ultron-vault` + notas de session_compactor
   → `memory_items` (status según calidad) ANTES de borrar `stop-memory-sync.ps1`.
4. **Arranque = revisar el plan completo primero** (ver `PLAN.md`). No tocar código de producción
   hasta OK explícito de USER. El esquema canónico `memory_items` requiere su bendición.
