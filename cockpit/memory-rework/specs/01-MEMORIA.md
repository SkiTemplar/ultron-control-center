# SPEC FULL — Sistema de MEMORIA (ULTRON)
### Autocontenido para revisión por IA externa · 2026-06-04 · rama `fullize-2026-05-30` · HEAD = `git rev-parse --short HEAD`

> **[RECONCILIADO 2026-06-04 — ver `../STATE-RECONCILIATION-2026-06-04.md`]** No se hardcodea HEAD (queda stale). Linea de commits relevante a esta spec: `4558554` (cierre 100% docs) ← `79a962c` (W4 index_item write-path) ← `cda7a99` (OLA A/H2 sensitivity write-path) ← `f936a66` (refresco specs) ← `823ed67`. Verifica con `git rev-parse --short HEAD`. Conteos verificados: 943 active / 35 candidates / ~1043 events.

## 1. Propósito
Memory-Orchestrated Agent Runtime LOCAL para Claude Code: que el asistente RECUPERE contexto por *recall* en vez de re-leer el código. NO chatbot con memoria, NO lista de recuerdos en Qdrant, NO demo. Memoria canónica auditable, recuperable, explicable, editable, eficiente en tokens.

## 2. Stack y ubicación
- App Tauri 2: backend Rust (`control-center/src-tauri/src/`), front React/TS.
- SQLite `~/.ultron/brain.db` (rusqlite 0.31 bundled) = **fuente de verdad**.
- Qdrant nativo `D:\Ultron\qdrant` (sin Docker) = índice vectorial.
- Embeddings: MultilingualE5-Large 1024d (fastembed-rs 4.9.1), prefijos `query:`/`passage:` manuales.
- Sidecar CLI `ultron-memory.exe` (bin/ultron_memory.rs) usado por los hooks Node.
- Escala real: 943 items active, 35 candidates pending, ~1043 eventos.

## 3. Arquitectura (archivos)
- `memory/model.rs` — MemoryItem/MemoryEvent/MemoryCandidate + enums (`str_enum!`).
- `memory/sqlite_store.rs` — esquema canónico, CRUD, FTS5, migraciones idempotentes (`apply_schema`), `search_items` (FTS5 OR / LIKE term-OR fallback), `fts5_available` (probe).
- `memory/service.rs` — `MemoryService` = ÚNICO escritor; candidates, edit, relabel, pin, deprecate, supersede, stats, dedupe FTS. `create_candidate` tiene TODO Fase D (contradiction).
- `memory/qdrant_index.rs` — índice E5 `ultron_memory`: `index_item`/`reindex_all`/`search_dense`/`search_dense_scored`/`remove_item`.
- `memory/qdrant_store.rs` — legacy BGE-384 sobre `ultron_sessions` (Fase F: retirar). **READ-PATH VIVO:** el WRITE a `ultron_sessions` (384d, 72 pts) ya esta cortado (hook `stop-compress`, commit `d3a16ff`), pero la LECTURA sigue activa en `commands/memory/memory_graph.rs:200` (`crate::qdrant::search("ultron_sessions", ...)` dentro de `unified_search_inner`, comando Tauri `memory_unified_search`). NO esta neutralizada del todo: es un read-path legacy fuera del pipeline canonico (`build_trace`/`assemble_pack`), no afecta `recall@8`, pero cerrarlo es parte de Fase F.
- `memory/migrations.rs` — ETL one-shot (sessions/kg/decisions/vault) + MigrationReport + backup.
- `memory/catalog.rs` — catálogo de agentes en `ultron_catalog` (solo agentes hoy).
- `commands/memory/recall_unified.rs` — `build_trace`/`assemble_pack` (recall híbrido), `recall`/`recall_inspect`/`memory_reindex`, `recall_pack` (CLI).
- `commands/memory/{inbox,session_resume,migrate}.rs` — comandos Tauri.
- **NUEVOS (scaffolded, no enganchados)**: `memory/ai_tasks.rs`, `memory/contradiction.rs`, `memory/reflection.rs`, `memory/evals.rs`.

## 4. Modelo de datos
**MemoryItem**: id, type, scope{global/user/project/repo/branch/session/workflow/agent/skill}, project_id, repo_id, branch, workflow_id, agent_id, skill_id, user_id, title, summary, content, content_json, tags, status, confidence, importance, stability, **sensitivity{public/internal/private/secret}**, source{user_explicit/assistant_inferred/tool_observed/code_observed/workflow_generated/imported_(mem0/ecc/kg/sessions/vault)/manual_ui}, source_session_id, source_event_ids, validated_by_user, validated_at, created_at, updated_at, expires_at, supersedes, superseded_by, contradicts, derived_from, qdrant_point_id, token_estimate, access_count, last_accessed_at, last_injected_at, pinned.
**Estados**: pending/active/rejected/stale/deprecated/quarantined/archived.
**MemoryEvent** (append-only): created/updated/approved/rejected/edited/merged/split/deprecated/restored/contradicted/retrieved/injected/exported/imported.
**MemoryCandidate**: proposed_*, duplicate_candidates, contradiction_candidates, recommended_action{Merge/Quarantine/...}, risk_level, status.

## 5. Pipeline de recall (build_trace -> assemble_pack)
1. DENSE: `search_dense_scored(query, 30, project)` → (id, cosine) desde Qdrant (status=active filtrado).
2. SPARSE: `MemoryService::search_active` → `search_items` (FTS5 OR si disponible; si no, LIKE term-OR).
3. RRF k=60 + dedup; **tie-break por coseno real**.
4. `assemble_pack` (PURA, testeable): por cada fused → load item → filtros: result-limit, status=active, project-scope (global aplica siempre), **gate sensitivity=Secret**, **vault off-by-default bajo proyecto**, token budget (1er item truncado UTF-8). → injected + discarded + total_tokens.
5. Context pack = summaries (no bodies) + lazy-load por id. Evento `Retrieved` auditado.

## 6. STATUS FULL por componente
| Componente | Estado | Evidencia / commit |
|---|---|---|
| Store canónico + event sourcing | ✅ | sqlite_store.rs/service.rs; 56 tests |
| MemoryService único escritor | ✅ | invariante testeado |
| Qdrant índice reconstruible | ✅ | reindex_all; 943 pts green (API) |
| ETL one-shot + backup + report | ✅ | migrations.rs |
| Gate sensitivity=Secret en recall | ✅ | Ola 0 `1a14a27`; test assemble_pack |
| Ruta legacy sin gobernanza cortada | ✅ | Ola 0; session-recall-inject fuera |
| Invariantes (no rejected/deprecated/secret/cross-proj) en CI | ✅ | Ola 3-D2 `0574db0` |
| Coseno real en fusión | ✅ | Ola 1a `b916c5a` |
| Vault off-by-default bajo proyecto | ✅ verificado e2e | Ola 1b `0d123e7` |
| Sparse multi-término | ✅ verificado e2e (0→30) | fix `5e7b7ca` |
| Eval harness + baseline | ✅ recall@8=0.917 | `0532dee` (`ultron-memory eval`) |
| content_hash / normalized_text / schema_version | ✅ OLA B1 `ba7e21b` | FNV-1a estable; migración aditiva idempotente + backfill 943/943 verificado en brain.db real; user_version=2 |
| reconcile --check (SQLite↔Qdrant) | ✅ OLA B3 `b003a30` | `ultron-memory reconcile` → in_sync=true 943=943 (cross-check Python) |
| eval security gate (secret/stale-leak) | ✅ OLA C `7c64e21` | `eval` reporta secret_leak/stale_leak=0 sobre el store real |
| Inbox validación humana | ✅ | inbox.rs (approve/reject/edit/relabel/deprecate/quarantine/pin/history) |
| Retrieval Inspector | ✅ | recall_inspect (why-this-memory) |
| Session Resume + Pinning | ✅ | session_resume.rs |
| Contradiction detection | 🟡 scaffolded, NEXT (OLA E · requiere API keys) | contradiction.rs (`84280d5`); TODO en service.rs:57 |
| Cerebro barato (ai_tasks) | 🟡 scaffolded, NO enganchado | ai_tasks.rs |
| Reflection/consolidación | 🟡 scaffolded, NO enganchado | reflection.rs |
| Sparse = bm25 real | 🔴 deuda | fts5_available=false en release+qdrant → LIKE (no bm25) |
| Reranker cross-encoder | 🔴 | gap SOTA #1 |
| Contextual Retrieval | 🔴 | se embebe searchable_text crudo |
| Decay + scoring recency*importance*relevance | 🔴 | access_count=0 (recall no incrementa) |
| Bi-temporal (valid_from/valid_to) | 🔴 | solo ingestion-time |
| KG en retrieval | 🔴 | kg_entities=11/kg_relations=8, recall no los toca |
| Secret/PII redaction en write-path | ✅ OLA A (`9cf27c9`/`2c28c20`) | redaction.rs cableado en create_candidate+add_imported (detector dependency-free); deletion-verificado (Qdrant/backups/logs) aún pendiente |
| Dual-store legacy (recall.rs/qdrant_store 384/mem0) | 🔴 deuda | peso muerto (tabla legacy vacía) |

## 7. QUÉ FALTA (priorizado)
1. **Enganchar** contradiction::check en service.rs::create_candidate + ai_tasks::extract en Stop hook + reflection como comando (necesita e2e + API keys del AI Router).
2. **Reranker** cross-encoder (sidecar ONNX `ultron-rerank`, bge-reranker-v2-m3) tras RRF → mayor salto de precisión. Medir vs baseline 0.917.
3. **Investigar fts5** en release+qdrant (bm25 > LIKE).
4. **Contextual Retrieval** (contexto situacional por item antes de embeber/indexar).
5. **Meta-cognición**: decay (incrementar access_count en recall + sweep stale) · bi-temporal · KG 1-hop en recall.
6. **Seguridad**: secret-detector en write-path + deletion verificado (SQLite+Qdrant+backups).
7. **Fase F cleanup**: borrar recall.rs/recall_hybrid/qdrant_store 384/mem0. **Incluye cortar el read-path vivo de `ultron_sessions`** en `memory_graph.rs:200` (`memory_unified_search`): el WRITE ya esta cortado, pero la LECTURA legacy sigue consultando la coleccion 384d; mientras no se retire, `ultron_sessions` NO esta neutralizada (solo write-dead, read-alive).

## 8. Preguntas para la IA
- ¿RRF+coseno+rerank vs late-interaction (ColBERT) a escala 1-usuario / 943 items multilingües?
- ¿Merece KG temporal (Zep/Graphiti) sobre SQLite a esta escala?
- ¿Reflection por umbral de importancia vs sleep-time vs clustering — cuál para 1 usuario local?
- ¿Golden-set honesto sin LoCoMo/LongMemEval (multi-sesión sintéticos)? El actual: 12 golden, recall@8=0.917.
- ¿fts5 en release+qdrant: por qué el probe falla si rusqlite bundled debería traerlo?

## 9. Aceptación / Tests / Runtime-verification / Rollback

Contrato vinculante (schemas memory item / source-trust / sensitivity / dedupe): ver `../CONTRACTS-2026-06-04.md`.

- **Aceptación (DoD):** `MemoryService` = único escritor (invariante en CI); nada a `active` sin política/inbox; gate `sensitivity=Secret` y `vault off-by-default` activos en `assemble_pack`; sin secretos en SQLite/Qdrant/logs/embeddings (redacción write-path OLA A); `recall@8 >= 0.917` sin regresión vs baseline.
- **Tests:** `cargo test --manifest-path control-center/src-tauri/Cargo.toml --no-default-features --lib memory` (store + service + assemble_pack puro + invariantes de gobernanza).
- **Runtime-verification:** `ultron-memory eval` → `recall@8` (baseline 0.917) + `secret_leak`/`stale_leak`=0 sobre el store real · `ultron-memory reconcile` → in_sync SQLite↔Qdrant 943=943 · `ultron-memory stats` · `curl http://127.0.0.1:6333/collections/ultron_memory` (943 pts, 1024d).
- **Rollback:** Qdrant `ultron_memory` es índice derivado reconstruible (`ultron-memory reindex` / `reindex_all`); migraciones de esquema son aditivas idempotentes (`apply_schema`, `user_version`) con snapshot previo de `brain.db`; cada unidad cerrada es un commit revertible (`git revert`).
