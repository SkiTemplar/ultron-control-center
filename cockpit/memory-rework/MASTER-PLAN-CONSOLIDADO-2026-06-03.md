# MASTER PLAN CONSOLIDADO — Memory-Orchestrated Agent Runtime + AI Router multi-IA

> **[RECONCILIADO 2026-06-04 — ver `STATE-RECONCILIATION-2026-06-04.md`]** (doc de 2026-06-03, pre-removal).
> **OLA 8 (Quota gradual) quedo OBSOLETA**: las tareas I1/I2/I3 editan `quota_watchdog.rs` que fue **borrado**
> en `cbb2d5c`. Si se retoma Quota, es trabajo nuevo (re-crear watchdog con señal real), no editar lineas existentes.
> La frase "el lazo reactivo ya esta cableado (is_critical consultado)" ya no aplica. HEAD real `823ed67`.

> Fecha: 2026-06-03. Rama `fullize-2026-05-30`. Fuente: 4 workflows de auditoría/investigación a máximo nivel.
> Este documento UNIFICA sus hallazgos en olas de implementación ordenadas por dependencia.
> Acompaña a `STATUS.md` (biblia de reanudación), `DIAGNOSIS.md`, `PLAN.md`, `MASTER-PROMPT.md`.

## Fuentes (workflows, evidencia file:line + runtime)
- `w83p7ntwp` — Auditoría final de memoria (PARTIAL 62%, no production-ready).
- `w4uv2ocgd` — SOTA gap analysis (~55-60% del camino al mejor del mundo).
- `waqq5qec7` — Quota-aware routing (la plomería existe; señal ciega).
- `wqpf1uiwm` — AI Router al máximo (no decorativo; infrautilizado).
- Evidencia runtime propia: sidecar `ultron-memory` (golden queries), `cargo test` (54/54 memoria, 371/372 suite).

## Veredicto consolidado
- **Memoria**: cimientos de clase mundial (gobernanza 90%, datos 85%) + motor de calidad de 1ª generación (30%) + meta-cognición ~5%. **62% cumplimiento / ~55-60% al SOTA.**
- **AI Router**: NO decorativo (gobierna ~10 callers reales) pero **infrautilizado**: el orquestador pesado hardcodea `claude`, el kernel de memoria no lo consume, sin cache/quality-gate/JSON.
- **Quota**: el lazo reactivo ya está cableado (`is_critical` consultado antes de cada provider) pero la **señal es binaria/ciega** y el detector vive en el path equivocado.

## Ya es de clase mundial (NO tocar, preservar)
- SQLite event-sourced + `MemoryService` único escritor con invariantes testeadas (más estricto que Mem0/Letta).
- Qdrant como índice reconstruible (no SoT) vía `reindex_all`.
- Inbox auditable + `recall_inspect` (why-this-memory) — explicabilidad SOTA.
- Context pack just-in-time (summaries + lazy-load bajo budget).
- Modelo de dominio rico (supersedes/contradicts/importance/sensitivity/access_count… ya presentes).
- `route()` con cadena primary→fallback + quota guard + métricas reales.

## Correcciones a hallazgos previos (honestidad)
- **"sparse FTS5 = 0" era sesgo de muestreo**, no bug ni binario stale. El sparse funciona (qdrant=14, memoria=27 hits). El gap real: el query FTS usa **AND implícito** entre términos → queries multi-palabra con stopwords dan 0. Fix = OR + quitar stopwords.
- **"`route()` solo lo llama el botón Test" es un comentario STALE FALSO** (`ai_router.rs:1423-1437`). Gobierna ~10 callers reales. Borrarlo es fix gratis.

---

# OLAS DE IMPLEMENTACIÓN (orden por dependencia; cada ola es commiteable y verificable)

## OLA 0 — Seguridad crítica + higiene (BLOQUEA "production-ready", ~0.5-1 día)
| # | Tarea | Archivos | Acceptance |
|---|---|---|---|
| 🔴 A1 | Retirar la ruta de recall legacy sin gobernanza de SessionStart. Quitar `session-recall-inject.js` de `settings.json`; des-registrar `recall_hybrid`/`recall_semantic`/`memory_health` de `lib.rs:264-269`; reconstruir o retirar la colección Qdrant `ultron_sessions` (deja solo `ultron_memory` derivada de items active). UNA sola ruta gobernada. | `settings.json:101`, `~/.claude/scripts/session-recall-inject.js`, `lib.rs:264-269` | SessionStart inyecta solo vía `memory-session-resume.js`; no se puede inyectar rejected/deprecated |
| 🔴 A2 | Filtrar/redactar por sensibilidad en `build_trace`: excluir `Secret`, redactar `Private` salvo opt-in; marcar en discarded/warnings. | `recall_unified.rs:133-183`, `model.rs:115` | Test CI: item `sensitivity=Secret` nunca en `injected` |
| 🟢 A3 | Borrar el SCOPE NOTE stale de `route()` y documentar los ~10 callers reales. | `ai_router.rs:1423-1437` | `cargo build` OK; comentario lista callers verificados |

## OLA 1 — Quick wins de calidad de recall (S, alto impacto, ~1 día)
| # | Tarea | Archivos | Acceptance |
|---|---|---|---|
| B1 | Usar el **coseno real** en la fusión (hoy `search_dense` lo recibe y lo descarta). Devolver `(id, cosine)`; en `build_trace` fusión score-aware (RRF ponderado / min-max), coseno como tie-break. | `qdrant_index.rs:100`, `recall_unified.rs:81` | scores continuos, no `1/(60+rank)` |
| B2 | **Re-scopear las 868 del vault** (92% del corpus = `scope=global,project_id=null`) a `scope='vault'` (no entra por defecto). Filtro duro por proyecto en recall; global como fallback **penalizado**. | migración datos en `brain.db`, `recall_unified.rs:153-158`, `qdrant_index.rs:95-98` | golden query cross-proyecto: ruido baja |
| B3 | FTS query **AND→OR** + quitar stopwords (arregla sparse multi-término). | `sqlite_store.rs:331-337`, `recall_unified.rs` | "decision de arquitectura de embeddings" da sparse>0 |
| B4 | Budget: truncar 1er item si excede; `estimate_tokens` UTF-8. | `recall_unified.rs:160`, `model.rs` | test budget respetado incl. 1er item |

## OLA 2 — Router apto para el kernel (fundación, ~1-1.5 días)
| # | Tarea | Archivos | Acceptance |
|---|---|---|---|
| C1 | `temperature` + `response_schema` en `ZoneAssignment`; propagar a las 3 wrappers (OpenAI `response_format`, Gemini `responseSchema`, Anthropic tool-forcing). Backward-compatible. | `ai_router.rs:115-121,1036,1094,1145` | zona con schema devuelve JSON determinista (temp=0) |
| C2 | Conectar la zona huérfana `routing-decision` como juez intent→zona cuando `classify_intent`=="general". `model_plan` (zona+provider+rationale) en `OrchestrationContext`. | `orchestrator.rs:110-177`, `ai_router.rs:476` | intent ambiguo usa juez barato; keyword sigue por regla |
| C3 | Cache por `sha256(zone+model+system+prompt+project)` + TTL por zona. | `route()` `ai_router.rs:1439` | 2º route() idéntico → cache, sin hit al proveedor |

## OLA 3 — Evals harness (PREREQUISITO de medición, ~1 día)
| # | Tarea | Archivos | Acceptance |
|---|---|---|---|
| D1 | `~/.ultron/evals/golden.jsonl` (50-100 queries categorizadas: single/multi-hop/temporal/contradiction/cross-proyecto, ancladas en los 943 items). Subcomando `ultron-memory eval` (recall@k/MRR/nDCG) + tabla `eval_runs(git_sha,metric,mean)`. Validar el juez NIM (false-accept). | `bin/ultron_memory.rs`, nuevo `evals/` | baseline reproducible; guard en CI |
| D2 | Tests de pipeline no-ignored: hacer `dense_ids` inyectable; test sin Qdrant/ONNX de budget/no-rejected/no-deprecated/scope. Quitar `#[ignore]` de un smoke sparse. | `recall_unified.rs:323/338/392` | invariantes protegidos por CI |

## OLA 4 — Motor de calidad: reranking (M, MAYOR salto de precisión, ~2 días)
| # | Tarea | Archivos | Acceptance |
|---|---|---|---|
| E1 | Sidecar `ultron-rerank` (bge-reranker-v2-m3 ONNX, warm como `ultron-embed`). | nuevo `bin/ultron_rerank.rs` | binario warm responde rerank(query,docs) |
| E2 | `build_trace`: rerankear top-30 post-RRF; `rerank_score` en `RecallTrace`. | `recall_unified.rs` | eval recall@k sube vs baseline (Ola 3) |
| E3 | Reusar el reranker en `catalog::search_catalog` (arregla routing dominado por `ultron-*` genéricos). | `memory/catalog.rs` | especialistas suben sobre genéricos |

## OLA 5 — El cerebro barato gobierna el kernel (OBJETIVO del dueño, ~2 días)
| # | Tarea | Archivos | Acceptance |
|---|---|---|---|
| F1 | Zonas `memory-extract` + `memory-contradict` (free-pool primary, claude-haiku fallback, temp=0, schema). | `ai_router.rs` seed_zones | zonas en `zones.json` |
| F2 | Subcomando `ultron-memory extract`: portar `EXTRACTION_PROMPT` del hook Node a `route('memory-extract')`. El hook queda wrapper fino. | `bin/ultron_memory.rs`, `stop-compress-session.js:203-292` | extracción en métricas del router; cascada duplicada eliminada |
| F3 | Dedupe semántico E5 en `create_candidate` (cos>0.92→Merge). | `service.rs:46-55`, `qdrant_index::search_dense` | duplicado semántico → Merge sin LLM |
| F4 | `contradiction_detector`: `route('memory-contradict')` sobre 3 vecinos densos → Quarantine + `supersede` con `valid_to` (cierra TODO `service.rs:57`). | `service.rs:57-60` | contradictorio → Quarantine, nunca auto-approve |
| F5 | Query-rewrite/HyDE opcional pre-recall (zona `query-rewrite`). | `recall_unified.rs:106` | recall mejora en queries vagas (medir con evals) |

## OLA 6 — Orquestador multi-IA real (despacho a Codex/Gemini, ~2 días)
| # | Tarea | Archivos | Acceptance |
|---|---|---|---|
| G1 | `DelegateRequest` acepta `provider`/`zone`; `delegate_task_inner` resuelve runtime vía `route()` y lo pasa a `pty::spawn_inner` (deja de hardcodear `claude`). `resolve_cheap_model` consulta la zona. | `agent_orchestration.rs:155-164,166-192,291-299` | `provider=codex` spawnea codex, no claude |
| G2 | Enseñar el sentinel `[AGENT TASK COMPLETE]` a codex/gemini (rol va en prompt). | `pty.rs:281`, `agent_orchestration.rs:266` | captura de salida de codex/gemini vía sentinel |
| G3 | Zona `external-review` (codex-cli/gemini-cli, coste 0); migrar `second-opinion`/`codex:*` a delegar ahí. | `ai_router.rs`, skills | dashboard muestra tráfico Codex/Gemini; coste 0 OAuth |

## OLA 7 — Meta-cognición / aprendizaje (M, ~2-3 días)
| # | Tarea | Archivos | Acceptance |
|---|---|---|---|
| H1 | Reflection/consolidación background (`ultron-memory reflect` o Stop hook): cluster E5 + destilar insights **citando source ids** (grounding) → candidate `type=reflection`. | `bin/ultron_memory.rs`, `service.rs` | aparecen items type=reflection con provenance |
| H2 | Decay + scoring recency*importance*relevance: incrementar `access_count` en recall (hoy=0); `importance` vía LLM al aprobar; sweep stale (excepto pinned/validated/secret). | `recall_unified.rs`, `service.rs` | access_count>0; stale sweep funciona |
| H3 | Bi-temporal: `valid_from`/`valid_to` + extracción de valid_time; recall filtra `valid_to IS NULL` por defecto, permite "as-of". | `model.rs`, `sqlite_store.rs`, `recall_unified.rs` | query temporal responde "qué era cierto en X" |
| H4 | Core memory blocks `<memory_blocks>` siempre-inyectados (label/value/limit/read_only). Las 868 del vault como read_only `scope=vault`. | nueva tabla `memory_blocks`, `session_resume.rs` | bloque core en cada SessionStart con contador de chars |

## OLA 8 — Quota gradual + resiliencia (M, ~1.5 días)
| # | Tarea | Archivos | Acceptance |
|---|---|---|---|
| I1 | Señal real: el proxy lee `anthropic-ratelimit-unified-5h/7d-utilization` + `representative-claim` + `-reset` y escribe `quota-state.json`. Proxy "Claude-first". | `ultron-proxy.mjs`, `quota_watchdog.rs:42-52` | `claude_pct_used` gradual real, no 0/99 |
| I2 | `QuotaStatus` gradual + `is_soft_constrained()` (5h≥80% / 7d≥70%) + `quota_score()`. Degradar zonas no-críticas a free-tier ANTES del corte duro. | `quota_watchdog.rs`, `ai_router.rs` | tareas baratas van a free al 80%, no al 98% |
| I3 | `quota:critical` → auto-relevo a Codex (cablear el evento existente a `launch_codex_fallback`). | `quota_watchdog.rs:281`, `codex_fallback.rs` | al saturar Claude, relevo automático sin clic |

## OLA 9 — Selector dinámico + quality-gate + unify + cleanup (M, ~2 días)
| # | Tarea | Archivos | Acceptance |
|---|---|---|---|
| J1 | Selector dinámico: ordenar candidatos vivos por capacidad/key/free-tier-no-agotado/coste/success/latencia. Añadir NIM/Cerebras/DeepSeek al gauge. | `ai_router.rs:1465,199,210-218` | free-pool agotado → siguiente vivo |
| J2 | Quality-gate FrugalGPT (escalar si JSON inválido/campos faltan) + eval-harness 5% `quality_delta`. | `ai_router.rs:1500,189` | barato malformado escala al fuerte |
| J3 | Unify: `ultron-proxy.mjs` lee `zones.json`; sub-tab "Orquestar tarea" en `AIRouter/index.tsx`. | `ultron-proxy.mjs:76-101`, `AIRouter/index.tsx` | cambiar zona en UI afecta Rust y Node |
| J4 | Anti-poisoning gate (quarantine fuentes externas/baja-confianza) + drift detection (z-score embeddings). Auto-resumir nunca eleva confidence. | `service.rs` | fuente externa sospechosa → Quarantine |
| J5 | Cleanup Fase F: borrar `recall.rs`/`recall_hybrid`/`qdrant_store` 384d, tablas `memories`/`memories_fts` vacías, `mem0.rs`+`mem0-sync.js`. | varios | un solo codepath de recall |

---

# Notas de ejecución
- **Orden estricto de dependencia:** Ola 0 (seguridad) → 1 (quick wins) → 2 (router JSON) y 3 (evals) en paralelo → 4 (reranker, mide contra evals) → 5 (kernel sobre router, necesita 2) → 6 (multi-IA, independiente de 5) → 7/8/9.
- **Evals ANTES de tocar recall en serio:** sin Ola 3, los cambios de Ola 1/4/5 son fe ciega.
- **Patrón validado del dueño:** agentes paralelos crean **archivos nuevos**; el wiring final (lib.rs/settings.json) lo hace el humano, para evitar drift de contratos.
- **App corriendo bloquea el rebuild de la GUI** (`control-center.exe`), pero el **sidecar `ultron-memory` sí se reconstruye** sin cerrarla (verificado). Para aplicar cambios de la GUI: cerrar + `npm run tauri build`.
- **Reuse-over-rebuild:** casi todo es cableado/enriquecimiento de infra ya pagada (campos del modelo, route(), Qdrant, sidecar, pty multi-runtime). NO se reescribe el kernel.
