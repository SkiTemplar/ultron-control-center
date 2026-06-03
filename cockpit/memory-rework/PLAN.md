# PLAN DE IMPLEMENTACIÓN — Memory-Orchestrated Agent Runtime

> 2026-06-03 · rama `fullize-2026-05-30` · estado: **PARA REVISIÓN DE USER**.
> No se toca código de producción hasta OK explícito. Ver `DIAGNOSIS.md` (auditoría) y
> `MASTER-PROMPT.md` (prompt original + refinamientos vinculantes).

## Decisiones locked
1. Embeddings = **bge-m3** (dense 1024 + sparse nativo, multilingüe, un solo sidecar).
2. Mem0 = **FUERA** (remove completo).
3. Vault histórico = **RESCATAR** (ETL antes de borrar legacy).
4. Frontend = **mínimo** (Validation Inbox + status; resto CLI/logs). Trigger = **"Ultron"**.

## Principios de ejecución
- Backend-first. Incremental: una fase = un commit verificado, checkpoint, siguiente.
- Reúso > reescritura: extender lo que existe (Library, decisions-drain, workflow_runs, ai_router).
- Memory Agent = único escritor persistente. Hooks/agentes solo emiten candidates/eventos.
- Nada destructivo sin migración + rollback. ETL con reporte antes de borrar fuentes.

---

## FASE A — Fundación de la memoria canónica (backend puro) ★ siguiente

**Objetivo:** que exista UNA fuente de verdad gobernada y auditable en `brain.db`, viva y cableada.

### A1 · Esquema SQLite canónico (`memory/sqlite_store.rs` reescrito)
Reemplaza la tabla plana `memories` por:

```sql
CREATE TABLE memory_items (
  id              TEXT PRIMARY KEY,         -- ULID/uuid crate (no el casero)
  type            TEXT NOT NULL,            -- preference|fact|decision|constraint|task|
                                            -- workflow_state|codebase_fact|skill|agent_note|
                                            -- session_summary|error_resolution|architecture|
                                            -- tool_usage|user_profile
  scope           TEXT NOT NULL,            -- global|user|project|repo|branch|session|
                                            -- workflow|agent|skill
  project_id      TEXT, repo_id TEXT, branch TEXT,
  workflow_id     TEXT, agent_id TEXT, skill_id TEXT,
  title           TEXT,
  summary         TEXT,                     -- lo que se inyecta (compacto)
  content         TEXT,                     -- detalle (lazy-load)
  content_json    TEXT,
  tags            TEXT,                     -- json array
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|active|rejected|stale|
                                            -- deprecated|quarantined|archived
  confidence      REAL DEFAULT 0.5,
  importance      REAL DEFAULT 0.5,
  stability       TEXT DEFAULT 'durable',   -- temporary|durable|permanent
  sensitivity     TEXT DEFAULT 'internal',  -- public|internal|private|secret
  source          TEXT NOT NULL,            -- user_explicit|assistant_inferred|tool_observed|
                                            -- code_observed|workflow_generated|imported_*|manual_ui
  source_session_id TEXT,
  created_at      INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER,
  supersedes      TEXT, superseded_by TEXT, contradicts TEXT, derived_from TEXT,
  qdrant_point_id TEXT,
  token_estimate  INTEGER DEFAULT 0,
  access_count    INTEGER DEFAULT 0, last_accessed_at INTEGER, last_injected_at INTEGER,
  validated_by_user INTEGER DEFAULT 0, validated_at INTEGER
);
CREATE VIRTUAL TABLE memory_items_fts USING fts5(   -- sparse/keyword sobre el canónico
  title, summary, content, content='memory_items', content_rowid='rowid');
CREATE INDEX idx_items_status_scope ON memory_items(status, scope, project_id);

CREATE TABLE memory_events (                 -- append-only, auditoría total
  id TEXT PRIMARY KEY, event_type TEXT NOT NULL, memory_id TEXT,
  before_json TEXT, after_json TEXT,
  actor TEXT NOT NULL,                       -- user|memory_agent|workflow_agent|system|migration
  source_session_id TEXT, source_turn_id TEXT, reason TEXT, confidence REAL,
  created_at INTEGER NOT NULL);
CREATE INDEX idx_events_memory ON memory_events(memory_id, created_at);

CREATE TABLE memory_candidates (             -- inbox de validación humana
  id TEXT PRIMARY KEY,
  proposed_type TEXT, proposed_scope TEXT, proposed_title TEXT,
  proposed_summary TEXT, proposed_content TEXT, proposed_content_json TEXT, proposed_tags TEXT,
  source_event_ids TEXT, source_session_id TEXT,
  confidence REAL, importance REAL, risk_level TEXT,
  duplicate_candidates TEXT, contradiction_candidates TEXT,
  recommended_action TEXT,                   -- approve|reject|edit|merge|supersede|quarantine
  status TEXT NOT NULL DEFAULT 'pending',    -- pending|approved|rejected|edited|merged|quarantined
  created_at INTEGER NOT NULL);
```
- Reusar `workflow_runs` (existe, GOOD). `routing_telemetry` llega en Fase D.
- `kg_entities`/`kg_relations` se conservan (KG colapsado aquí); ECC y Mem0 fuera.

### A2 · Dominio + servicio (Memory Agent, único escritor)
- `MemoryItem` Rust type (reemplaza `MemoryHit` anémico); `update()`/`transition_status()` en el trait.
- `MemoryService`: `create_candidate`, `approve_candidate`, `reject_candidate`, `edit`,
  `merge`, `split`, `deprecate`, `supersede`, `search`, `get`, `list`, `history`,
  `get_context_for_turn`. Cada mutación escribe un `memory_event`. Sustituir `uuid_v4()` casero.
- Cablear `SqliteStore::init()` + migraciones en `lib.rs run()` (hoy NO se llama → bug raíz).

### A3 · Migración / ETL one-shot (`memory/migrations/`)
Normaliza las fuentes vivas → `memory_items` con `memory_events(imported)`:
- `ultron_sessions` (Qdrant): scroll de puntos → items `status=active` (filtrar `embed_stub:true`).
  Mapea `{text,kind,importance,session_id,project,date}` → campos canónicos.
- `kg.jsonl` → items tipo `codebase_fact`/`architecture` + tablas KG.
- `~/.ultron-vault` + session_compactor (rescate histórico) → items `session_summary`/`fact`.
- Mem0: dump JSON one-shot de seguridad (opcional) → luego REMOVE. No re-ingesta por defecto.
- Dudosas → `status=pending` (inbox). Reporte: total, activas, pendientes, duplicadas,
  contradicciones, sin proyecto, sensibles, errores. **Rollback**: backup de `brain.db` pre-ETL.

### A4 · Tests (gobernanza)
rejected/deprecated/pending no se inyectan; approved aparece; edit/deprecate refleja en índice;
event-log registra cada mutación; ETL no pierde IDs ni fuente. → **commit Fase A**

---

## FASE B — Índice vectorial unificado + recall real

- **B1 · Sidecar bge-m3.** Extender `ultron_embed.rs` a bge-m3 (dense 1024 + sparse). Shipping en
  build. **Hard-fail** si falta (no zero-vector). Emite modelo/dim para evitar mismatch.
- **B2 · Qdrant una colección.** `ultron_memory` con named vectors (dense+sparse), payload rico
  (`canonical_id, type, scope, project_id, status, confidence, importance, validated, sensitivity,
  tags, summary, token_estimate, updated_at`). `QdrantIndexService`: upsert/delete/search/
  reindex_all/reindex_project/explain. Borrar `ultron_sessions`/`ultron_vault`/`skills`/`agents`
  tras reindexar desde el canónico.
- **B3 · Recall híbrido real.** Qdrant Query API nativa (prefetch dense + sparse → RRF) + rerank
  opcional (cross-encoder) + filtros `status=active`/scope/project_id. Dedup por `canonical_id`.
  **UN** comando `recall`. Matar el dual recall (Python `auto-recall.py` + Rust). Context pack con
  presupuesto de tokens + `<ORCHESTRATION_CONTEXT>`.
- **B4 · Tests** recall + budget + `explain` a log. → **commit Fase B**

---

## FASE C — Ingestión candidate-first + hooks

- **C1.** `stop-compress-session.js` → emisor de **candidates** vía comando backend (no upsert
  directo a Qdrant). Persistir en disco ANTES de cualquier red. Extraer `redactSecrets`/opt-out a
  módulo de seguridad compartido.
- **C2.** Matar legacy py/ps1 (`auto-recall`, `session-init`, `stop-memory-sync`). Invertir SoT:
  `hooks/` versionado = fuente, `~/.claude` = derivado por install. Añadir PreToolUse/SessionEnd
  mínimos para el pipeline de eventos/candidates. Reducir inyección por turno (git-log presupuestado).
- **C3.** **Validation Inbox** (UI mínima, reusar patrón Accept/Reject de `decisions.rs`) +
  CLI `memory inbox/approve/reject/edit`. Arreglar bug nav de `MemoryStatusCard`. → **commit Fase C**

---

## FASE D — ModelRouter + tareas de memoria

- `route_structured()` + `TaskPolicy` (temperature 0, `response_format`/json_schema, max_tokens,
  timeout) sobre `ai_router.rs`. Wire tareas de memoria a modelos baratos: intent_classification,
  candidate_extraction, dedup, contradiction_detection, query_rewrite, summarization.
  Cache por hash(input+project+route). Telemetría → SQLite. Consolidar key whitelist (1 fuente).
  Proxy delega decisión al router. → **commit Fase D**

---

## FASE E — Orquestador "Ultron" (workflows de 1ª clase)

- Esquema `Workflow` único (colapsar las 3 defs) con `trigger_patterns, allowed_agents,
  required_skills, memory_read/write_policy, token_budget, completion_criteria, states/transitions`.
  Reusar `workflow_loader` (YAML) + `workflow_runs` (persistencia). **Step-runner real**.
- Selección agente/skill por **embeddings** (Qdrant) + `allowed_agents`; reusar contrato
  `agent_suggest`. **Sanear ghost agents** (planner/architect/tdd-guide no existen). Converger
  dispatchers en uno. Activación por trigger **"Ultron"** (sinónimos enrutan al mismo).
- Golden prompts: "Ultron", "sigue con la memoria", "qué quedó pendiente", "no uses esa memoria",
  "crea una skill para esto", "continúa el workflow anterior". → **commit Fase E**

---

## FASE F — Limpieza + docs + verify

REMOVE Mem0/ECC/dead-python/dead-hooks/docs-stale (con banner+archivo). Reescribir
`ARCHITECTURE-overview.md` contra HEAD. Contract-drift audit (front↔back) + `cargo check` + `tsc`
+ cerrar app + `npm run tauri build` + verify funcional. Docs CLI + MIGRATION_REPORT. → **commit Fase F**

---

## Riesgos vigilados
- `workdays` Rust = compile dep de `agent_orchestration` (no borrar backend).
- ETL antes de borrar fuentes; backup `brain.db`; auditar `embed_stub` antes de migrar.
- bge-m3 en sidecar: verificar soporte fastembed sparse + tamaño descarga ONNX.
- `.ps1` de hooks = ASCII puro (PS 5.1 em-dash gotcha).
- Borrar comando Rust con `invoke()` vivo = panic IPC → verificar cero call-sites.
- Hooks viven en `~/.claude` sin git → autorar en `hooks/` + install.

## Estado por fase
| Fase | Estado |
|---|---|
| A Fundación memoria | PENDIENTE (siguiente, requiere OK del esquema) |
| B Índice + recall | PENDIENTE |
| C Ingestión + hooks | PENDIENTE |
| D ModelRouter | PENDIENTE |
| E Orquestador Ultron | PENDIENTE |
| F Limpieza + verify | PENDIENTE |
