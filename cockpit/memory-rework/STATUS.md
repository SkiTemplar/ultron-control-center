# STATUS — Memory-Orchestrated Agent Runtime (biblia de reanudación)

> ÚNICA fuente de verdad para reanudar el rework tras una compactación de contexto.
> Rama `fullize-2026-05-30`. Leer ANTES de seguir. Acompaña a `DIAGNOSIS.md`
> (auditoría), `PLAN.md` (fases A–F), `MASTER-PROMPT.md` (prompt original + 25
> requisitos de ahorro de tiempo). NO reiniciar ni rediseñar: continuar desde aquí.

## Principios rectores (NO violar)
- **Memory-Orchestrated Agent Runtime**, no chatbot con memoria.
- **Qdrant = índice, NO source of truth.** Canónico = SQLite `~/.ultron/brain.db`.
- **Memory Agent (`MemoryService`) = ÚNICO escritor persistente.** Hooks/agentes solo
  emiten `memory_candidates` o eventos.
- **Backend-first.** Frontend mínimo (inbox + status reusando patrón decisions). UI grande = NO.
- **Trigger = "Ultron"** (las frases vagas son sinónimos al mismo trigger; no keywords nuevas).
- **Reuse-over-rebuild.** Donde el prompt diga "crear de cero" y ya exista, EXTENDER.
  Los "agentes" del kernel DELEGAN a los ~78 agentes reales de `~/.claude/agents/` + skills.
- **0 atajos, 0 mentiras, verificación 100% en runtime real antes de avanzar de fase.**

## Decisiones técnicas locked
- Embeddings = **MultilingualE5Large (1024d, multilingüe, fastembed built-in)** dense +
  **FTS5 (brain.db)** sparse + **RRF k=60**. bge-m3 DESCARTADO (fastembed 4.9.1 no lo
  soporta bien; sería sparse incorrecto o regresión Python). E5 exige prefijos
  `query:`/`passage:` (fastembed NO los añade — se añaden manualmente).
- **Mem0 FUERA** (da problemas, no aporta). ECC → ETL kg.jsonl. Migración explícita hecha.
- Idempotencia de esquema: `ALTER TABLE ADD COLUMN` guardado por `PRAGMA table_info`.

## HECHO y VERIFICADO EN RUNTIME (10 commits)
| Commit | Qué | Verificación |
|---|---|---|
| `a73c844` | Fase A1/A2: modelo canónico + `brain.db` (memory_items+events+candidates+FTS5) + `MemoryService` único escritor + init cableado | 32 unit |
| `7bf4440` | Fase A3: ETL one-shot (`memory_migrate`): ultron_sessions+kg+decisiones(→candidates)+vault | e2e: 943 active+34 cand |
| `e207d9f` | Fase B: `embed_e5` + colección `ultron_memory` + recall híbrido RRF (`recall`/`memory_reindex`) | 45 unit |
| `028cc00` | Fase B e2e + warm-up E5 | e2e: indexed=943, recall relevante |
| `bacf7dd` | Retrieval Inspector (`recall_inspect`) + Memory Inbox (11 cmds) + dedupe FTS | 49 unit |
| `2595312` | Session Resume (`session_resume`) + Pinning (columna `pinned`+ALTER) | e2e real: 943, pin/unpin OK |
| `4af3fa4` | Workflow State (`state_json` en workflow_runs + `set/get_run_state` + 2 cmds) | e2e real: run 1 set/get OK |

**Estado de datos REAL (verificado):** `brain.db` = 943 items active (vault 868 + sessions 64
+ kg 11) + 34 candidates pending + 977+ eventos. Qdrant `ultron_memory` = 943 puntos, 1024d,
Cosine. `workflow-runs.db` operativa. Backups `brain.db.bak-*` creados por el ETL.

## Requisitos → estado (de los 25 + originales)
DONE: store canónico · Qdrant=índice · estados (pending/active/rejected/stale/deprecated/
quarantined/archived) · scopes (global/user/project/repo/branch/session/workflow/agent/skill) ·
event/audit log · Memory Agent único escritor · migración Mem0/ECC · **#2 Retrieval Inspector**
(traza why-this-memory + descartados+razón + lazy_load + warnings + evento Retrieved) ·
**#3 Memory Inbox** (list/approve/reject/edit candidate; item edit/relabel/deprecate/quarantine/
history; `memory_do_not_use` #23; `memory_stats` #24-parcial) · **#4 Context Pack** (RecallPack:
summaries, budget 1500, lazy-load) · **#5 Session Resume** (bounded) · **#6 Workflow State** ·
**#8(parcial) dedupe FTS** en create_candidate · **#17 Pinning** · tests.

MISSING/TODO (orden de prioridad del usuario):
- **#7 Auto-routing WF/agente/skill** — mapear prompts vagos ("sigue con esto", "arregla el bug",
  "lanza el orquestador"…) → workflow + agente + skills + memoria + modelo. Trigger "Ultron".
- **#8 AI Routing tareas baratas** — wire `ai_router.rs` a intent/extraction/dedupe/contradiction/
  summarization con TaskPolicy (temp 0, JSON schema). Hoy `ai_router` NO toca memoria.
- **#10 Contradiction semántica** — TODO ya marcado en `service.rs::create_candidate` (embed
  proposed_summary, comparar vs active del mismo scope/type, setear contradiction_candidates +
  recommended_action=Quarantine, nunca auto-approve).
- **#11 Open Tasks tipados** (hoy = memory_items type=task) · **#25 Auto-cleanup workflow** ·
  **Fase C hooks** (reorientar `stop-compress-session.js` a emisor de candidates; matar legacy
  py/ps1) · **Fase F** (borrar Mem0/ECC/legacy 384) · **Frontend Validation Inbox UI** (backend
  listo: `memory_inbox_list`/`memory_candidate_*`/`recall_inspect`/`session_resume`).

## Mapa de ficheros (Memory Kernel)
- `control-center/src-tauri/src/memory/model.rs` — MemoryItem/Event/Candidate + enums (str_enum!).
- `…/memory/sqlite_store.rs` — esquema canónico + CRUD low-level + FTS5 + migraciones idempotentes.
- `…/memory/service.rs` — `MemoryService` (único escritor): candidates, edit, relabel, pin,
  deprecate, set_status, supersede, stats, list_*, dedupe en create_candidate.
- `…/memory/qdrant_index.rs` — índice E5 `ultron_memory`: index_item/reindex_all/search_dense/remove_item.
- `…/memory/migrations.rs` — ETL (sessions/kg/decisions/vault) + report + backup.
- `…/qdrant.rs` — embed (BGE-384 legacy) + `embed_e5` (1024) + ensure_collection_dim/upsert_e5/
  search_with_vector/delete_point/scroll. **Legacy 384 path se retira en Fase F.**
- `…/commands/memory/{recall_unified,inbox,session_resume,migrate}.rs` — comandos Tauri.
- `…/workflow_runs.rs` — WorkflowRun CRUD + **WorkflowState** (state_json) + set/get.
- Orquestación existente a reusar para #7: `agent_orchestration.rs` (7 workflows builtin,
  `list_workflows_inner`), `workflow_loader.rs` (YAML `~/.ultron/cockpit/workflows/`),
  `project_agents.rs` (propose roster), `config/intent-rules.yaml` (reglas regex→skill).

## Catálogo real para #7 (NO re-inventariar — ya hecho)
Recon workflow `wm9v3ia2v` (output en temp `…/tasks/wm9v3ia2v.output`): agentes ~78 en
`~/.claude/agents/*.md`, skills (cientos) en `~/.claude/skills` + `embed_agents.py`/`embed_skills.py`
(payload name/description/tags). Dispatcher activo = `hooks/scripts/routing-dispatcher.js`;
`intent-dispatcher.py` (legacy) + `agent_suggest.py` cuelgan de `brain_index/index.db` INEXISTENTE.
Ghost agents (planner/architect/tdd-guide) NO existen → sanear.

## Cómo verificar (runtime real, sin atajos)
```
cargo test --no-default-features --lib memory          # unit memoria (51 verdes)
cargo test --lib -- --ignored --nocapture e2e_full_pipeline          # migrate+reindex+recall (E5 descarga ~1.3GB 1ª vez)
cargo test --lib -- --ignored --nocapture e2e_pinned_migration       # pinned migration + resume
cargo test --lib -- --ignored --nocapture e2e_run_state_persists     # workflow state
curl http://127.0.0.1:6333/collections/ultron_memory   # 943 pts, dim 1024
python -c "import sqlite3,os; c=sqlite3.connect(os.path.expanduser('~/.ultron/brain.db')); print(c.execute('SELECT status,COUNT(*) FROM memory_items GROUP BY status').fetchall())"
```
Comandos vivos: `recall`/`recall_inspect`/`memory_inbox_list`/`memory_candidate_approve`/
`memory_do_not_use`/`session_resume`/`memory_stats`/`workflow_set_state`/`workflow_get_state`.

## Diseño de #7 (siguiente, NO atajo)
Orquestador "Ultron" backend: (1) intent classification (reglas `intent-rules.yaml` + AI Routing
barato #8) → (2) workflow selection (trigger_patterns sobre los builtin de `agent_orchestration` +
YAML) → (3) agent/skill selection por **embeddings E5** (indexar el catálogo agentes/skills en una
colección Qdrant nueva, reusando `qdrant_index`) + `allowed_agents` del workflow + DELEGAR a
agentes reales → (4) memoria (recall ya hecho) → (5) modelo (AI Routing #8) → context pack
`<ORCHESTRATION_CONTEXT>`. Persistir el run + estado en `workflow_runs`/`WorkflowState` (#6 listo).
Sanear ghost agents. Reusar `agent_suggest` contrato. NO escribir memoria fuera del Memory Agent.
