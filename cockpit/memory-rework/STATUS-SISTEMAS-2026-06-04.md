# STATUS DE SISTEMAS — ULTRON (post-batch 2026-06-04)
### Spec + estado real por subsistema, tras 10 commits en `fullize-2026-05-30` (HEAD `823ed67`)

> **[RECONCILIADO 2026-06-04 — ver `STATE-RECONCILIATION-2026-06-04.md`]**
> HEAD real **`823ed67`** (no `0532dee`). **La Seccion 4 (QUOTA ROUTING) esta STALE**: el sistema de
> Quota % fue **QUITADO** en `cbb2d5c` (quota_watchdog.rs borrado, `is_critical()` ya no existe). La fila
> "Quota routing ~45%" del resumen ejecutivo no aplica. Lo correcto es `04-QUOTA.md`.

> Complementa `SPECS-SISTEMA-2026-06-04.md` (arquitectura) con el ESTADO verificado.
> Leyenda: ✅ hecho+verificado en runtime · 🟡 parcial/scaffolded · 🔴 pendiente · ⚪ sin auditar.
> "verificado" = ejecutado contra datos reales, no solo `cargo check`.

## 0. Resumen ejecutivo
| Subsistema | Estado | % a "mejor del mundo" |
|---|---|---|
| **Memoria** | ✅ núcleo seguro (redacción write-path) + consistente (content_hash/reconcile) + medible (eval security gate); falta motor avanzado (reranker/dedupe/contradiction) | ~70% |
| **AI Router** | 🟡 gobierna 10 callers; infrautilizado | ~40% |
| **Skills/Agentes routing** | 🔴 sugiere, no activa; sin reranker; catálogo solo agentes | ~30% |
| **Quota routing** | ⚫ QUITADO en `cbb2d5c` — no aplica (huérfanos limpiados) | n/a |
| **Hooks** | 🟡 memoria activada; Mem0/quota/ultron_sessions cortados (P0 2026-06-04); falta repoint SoT a ~/.ultron/hooks | ~72% |
| **Orquestador** | 🟡 intent→workflow→agentes real; intent regex | ~55% |
| **MCPs** | ⚪ sin auditar | n/d |

> Actualizado a HEAD `d3a16ff` (2026-06-04 noche). Memoria: OLA A (redacción) + OLA B1 (content_hash/migración/backfill 943) + OLA B3 (reconcile) + OLA C (eval security gate) hechos y verificados a runtime; recall@8=0.917 estable. Hooks: limpieza P0 de config viva ejecutada (Mem0/quota huérfano/ultron_sessions). Las secciones por subsistema abajo conservan su detalle; las marcadas con banner siguen vigentes salvo Memoria/Hooks (al día arriba).

---

## 1. MEMORIA  (el más trabajado)

### Spec
SQLite `~/.ultron/brain.db` = **fuente de verdad** (memory_items + memory_events event-sourced + memory_candidates + FTS5). Qdrant `ultron_memory` (E5 1024d) = **índice derivado reconstruible**. `MemoryService` = **único escritor**. Recall híbrido dense(E5)+sparse(FTS5/LIKE)→RRF+coseno→context pack (budget, summaries, lazy-load). Inbox de validación humana. 943 items active, 34 candidates pending.

### Status por componente
| Componente | Estado | Evidencia |
|---|---|---|
| Store canónico SQLite + event sourcing | ✅ | `memory/sqlite_store.rs`, `service.rs`; 56 tests |
| MemoryService único escritor | ✅ | invariante testeado |
| Qdrant índice reconstruible (`reindex_all`) | ✅ | 943 puntos green (verificado vía API) |
| **Seguridad: gate `Secret` en recall** | ✅ Ola 0 (`1a14a27`) | `assemble_pack`; test `assemble_pack_enforces_governance_invariants` |
| **Ruta legacy sin gobernanza cortada** | ✅ Ola 0 | `session-recall-inject.js` fuera de SessionStart |
| **Invariantes (no rejected/deprecated/secret/cross-proj) en CI** | ✅ Ola 3-D2 (`0574db0`) | test puro sin Qdrant |
| **Recall híbrido: coseno real + sparse** | ✅ Ola 1a (`b916c5a`) + fix (`5e7b7ca`) | **verificado e2e: sparse 0→30** |
| **Vault off-by-default bajo proyecto** | ✅ Ola 1b (`0d123e7`) | verificado e2e (recall con `--project` = solo proyecto) |
| **Eval harness + baseline** | ✅ (`0532dee`) | `ultron-memory eval` → **recall@8 = 0.917 (11/12)** |
| Contradiction detection | 🟡 scaffolded (`84280d5`) | `memory/contradiction.rs`, NO enganchado a `service.rs` aún |
| Reflection/consolidación | 🟡 scaffolded | `memory/reflection.rs`, sin comando vivo |
| Cerebro barato (ai_tasks) | 🟡 scaffolded | `memory/ai_tasks.rs`, no llamado por el kernel aún |
| Reranker cross-encoder | 🔴 | gap SOTA #1 (mayor salto de precisión) |
| Sparse = bm25 real (no LIKE) | 🔴 deuda | `fts5_available`=false en release+qdrant → LIKE term-OR (funcional, no bm25) |
| Decay / bi-temporal / KG en recall | 🔴 | meta-cognición |

### Hallazgo crítico de la noche
El "recall híbrido" **era solo-dense en producción**: en el binario release+qdrant `fts5_available()` da false → caía al LIKE-substring de la frase completa → toda query multi-palabra daba `sparse=0`. **Cazado ejecutando el binario real, arreglado (LIKE term-OR), verificado e2e (0→30).** Deuda: investigar por qué fts5 no carga en ese build (bm25 > LIKE).

---

## 2. AI ROUTER

### Spec
`ai_router.rs::route(zone, prompt)` enruta tareas a proveedores (Anthropic/Groq/Gemini/DeepSeek/Ollama + CLIs) con cadena primary→fallback, quota-guard, métricas. Proxy Node free-tier (NIM/OpenRouter/Groq) con failover.

### Status
| Aspecto | Estado | Evidencia |
|---|---|---|
| route() gobierna tareas internas | ✅ (corregido stale-comment) | ~10 callers reales (cost_watchdog/hooks_admin/workdays/library/...) |
| Proxy free-tier real | ✅ | `ultron-proxy.mjs` (NIM verificado) |
| **Orquestador despacha multi-IA (Codex/Gemini)** | 🔴 | `delegate_task_inner` hardcodea `"claude"`; `pty` ya soporta los 3 |
| **Kernel de memoria consume route()** | 🟡 scaffolded | `ai_tasks.rs` listo, no enganchado |
| `temperature`/`response_schema` en zonas | 🔴 | bloqueante para JSON determinista |
| Cache por hash + quality-gate + selector dinámico | 🔴 | métricas existen, no se usan para rankear |

Trabajado esta noche: workflow de diseño (`wqpf1uiwm`) + corrección del comentario stale que lo marcaba decorativo. Plan completo en el Master Plan (Olas 2/5/6/9).

---

## 3. SKILLS / AGENTES — AUTO-ROUTING

### Spec
Orquestador + hooks que enrutan el prompt a la skill/agente óptimo. Catálogo E5 (`ultron_catalog`).

### Status: 🔴 **HOY SE SUGIERE, NO SE ACTIVA**
| Aspecto | Estado | Evidencia |
|---|---|---|
| Hints inyectados (no determinista) | 🟡 | 2 routers paralelos en UserPromptSubmit; "ignore if wrong" |
| Catálogo indexa **solo agentes** | 🔴 | `catalog.rs:133` `entity="agent"`; skills nunca compiten |
| Reranker / umbral | 🔴 | top-5 coseno crudo → sesgo a genéricos `ultron-*` |
| Ficheros de routing (`intent-rules.yaml`, `skill_graph.json`) | 🔴 huérfanos | cero consumidores vivos |
| `routing-decision` (juez LLM) | 🔴 | existe en `ai_router.rs:477`, nadie lo llama |

Trabajado esta noche: workflow de diseño (`wwoac1zg1`) con el plan world-class (cascade 4 etapas: reglas→catálogo multi-entidad→reranker→juez; `index_skills()` = bloqueante #1). NO implementado aún.

---

## 4. QUOTA ROUTING  ⚫ QUITADO

### Spec (histórica)
La idea era detectar el rate-limit de Claude Max y hacer fallback automático a otras IAs, preservando cuota premium.

### Status: ⚫ **QUITADO en `cbb2d5c`** — no aplica
El subsistema de Quota % fue **eliminado**: `quota_watchdog.rs` borrado (−465 líneas),
`is_critical()`/`react_to_rate_limit()` ya no existen, −82 líneas en `ai_router.rs`. La descripción
previa de esta sección ("plomería existe, señal ciega", `is_critical()` consultado antes de cada
provider, ~45-55% scaffolded) era **stale** y queda **anulada**. No hay tarea pendiente de Quota en
el plan actual; si se quisiera, sería **re-implementar de cero** sobre la señal real (headers
`anthropic-ratelimit-unified-*` en la sesión CLI Max), no continuar el scaffold borrado.

**Documento canónico:** `memory-rework/04-QUOTA.md`.
**Reconciliación / evidencia:** `STATE-RECONCILIATION-2026-06-04.md` §2 (Conflicto de Quota: RESUELTO)
y §1 (`grep is_critical|quota_watchdog|react_to_rate_limit` en `src` = 0 matches; `git show cbb2d5c --stat`).

> **Huérfanos a limpiar** (residuo de Quota, ver STATE-RECONCILIATION §2): `quota-capture.js` (hook
> productor sin lector), `quota-state.json`, `QuotaDot`/`quota_get_status` en `Sidebar.tsx`, listeners
> `quota:critical/reset` en `ProxyControl.tsx`. Nota: `cost_watchdog.rs` ($) es notional/irrelevante
> para Max — no invertir.

---

## 5. HOOKS

### Status: 🟡
| Hook | Estado | Evidencia |
|---|---|---|
| SessionStart → `memory-session-resume.js` | ✅ activado+verificado | `settings.json`; inyecta resume real |
| UserPromptSubmit → `memory-orchestrate.js` | ✅ activado | inyecta `<orchestration-context>` |
| Ruta legacy `session-recall-inject` | ✅ retirada (Ola 0) | — |
| Sidecar `ultron-memory` (resume/orchestrate/recall/stats/reindex/**eval**/candidate) | ✅ | binario fresco en `~/.ultron/bin` |
| Stop → emisor de candidates | 🔴 | `stop-compress-session.js` aún escribe directo a Qdrant/Mem0 (debe pasar a `ultron-memory candidate`) |
| Dedup de hooks (2 routers UserPromptSubmit; resume+recall-inject+cross-project en SessionStart) | 🟡 | parcialmente limpiado |
| Latencia hook (cold-start E5 ~4-6s vs timeout 8s) | 🟡 | a veces no inyecta |

---

## 6. ORQUESTADOR (`orchestrator.rs`)

### Status: 🟡
intent (regex bilingüe) → workflow (7 builtin) → delegate_agents (E5 sobre catálogo) → recall → context+constraints+warnings. Real y cableado (CLI `orchestrate` + hook). Gaps: intent es regex (no juez LLM), delegate sesgado a genéricos (sin reranker), skills no en el catálogo, workflows builtin (sin trigger_patterns propios).

---

## 7. MCPs  (no lo mencionaste; sin auditar)

### Status: ⚪
4 servidores en `settings.json`: `context7` (docs), `playwright` (browser), `codex` (gpt-5.5 sandbox), `github` (HTTP `Bearer ${GITHUB_TOKEN}`). **Pendiente de auditar**: salud, seguridad del token (fuga histórica redactada, rotación pendiente), si faltan/sobran para el caso de uso. Recomendación: workflow de auditoría MCPs como hice con los demás.

---

## 8. Qué falta para cada uno (priorizado)
1. **Memoria**: enganchar contradiction/ai_tasks/reflection al pipeline (e2e) · reranker · investigar fts5 release · decay/bi-temporal.
2. **AI Router**: `temperature`/`response_schema` · cache · selector dinámico · multi-IA dispatch en `delegate_task_inner`.
3. **Skills/Agentes**: `index_skills()` · reranker · umbral auto/sugerir · matar 1 de los 2 routers.
4. **Quota**: señal real (headers Anthropic) · `is_soft_constrained()` · auto-relevo Codex.
5. **Hooks**: reorientar Stop→candidate · dedup routers.
6. **MCPs**: auditar.

Baseline para medir progreso de memoria: **recall@8 = 0.917** (`ultron-memory eval`). Cualquier cambio futuro de recall se compara contra esto.
