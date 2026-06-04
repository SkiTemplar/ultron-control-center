# PROMPT DE CONTINUACION — ULTRON (para mañana / para pasar a una IA)
### 2026-06-04 · rama `fullize-2026-05-30` · HEAD `823ed67`

> **[RECONCILIADO 2026-06-04 — ver `../STATE-RECONCILIATION-2026-06-04.md`]**
> HEAD real **`823ed67`** (no `0532dee`; +4 commits). El item **[7] Quota ya NO aplica**:
> el sistema de Quota % fue **QUITADO** en `cbb2d5c` (quota_watchdog.rs borrado). Retomar Quota
> = re-implementar de cero con señal real, no "enganchar lo existente". Embeddings = **E5-Large 1024d**.

## Cómo usar este prompt
- **Para una IA externa que revise/mejore**: pégale este archivo + los specs `01..07` de `cockpit/memory-rework/specs/`. Cada spec es autocontenido (arquitectura + status + qué falta + preguntas).
- **Para retomar tú con Claude Code**: pega la sección "PROMPT" de abajo.

---

## PROMPT (copiar-pegar para retomar)

```
Retomamos ULTRON (Memory-Orchestrated Agent Runtime, rama fullize-2026-05-30, HEAD 0532dee).
Contexto autoritativo (leer ANTES, en orden):
1. cockpit/memory-rework/STATUS.md (biblia de reanudacion)
2. cockpit/memory-rework/MASTER-PLAN-CONSOLIDADO-2026-06-03.md (10 olas)
3. cockpit/memory-rework/STATUS-SISTEMAS-2026-06-04.md (estado por subsistema)
4. cockpit/memory-rework/specs/01..07 (specs full individuales)

Estado: nucleo de memoria VERIFICADO e2e (recall hibrido real, sparse 0->30,
vault off-by-default, invariantes en CI, eval baseline recall@8=0.917). 4 modulos
(ai_tasks/contradiction/reflection/evals) SCAFFOLDED (compilan + tests) pero NO
enganchados al pipeline vivo.

Reglas duras: SQLite=fuente de verdad, Qdrant=indice; MemoryService=unico escritor;
verificacion 100% runtime real antes de avanzar; reuse-over-rebuild; agentes paralelos
crean archivos nuevos, wiring final manual; no frankenstein; ASCII puro en .ps1/.rs strings.

Antes de tocar codigo: cerrar la app ULTRON (yo la cierro) para poder rebuild;
asegurar Qdrant arriba (curl 127.0.0.1:6333/collections/ultron_memory) para verificar e2e.

Plan de ataque (orden por impacto, cada uno = commit verificado):
[1] ENGANCHAR contradiction::check en service.rs::create_candidate (escritor critico:
    con cuidado, e2e con API keys del AI Router). Medir vs baseline recall@8=0.917.
[2] ENGANCHAR ai_tasks::extract en el Stop hook (reemplazar la cascada Groq->Anthropic
    duplicada de stop-compress-session.js) -> respeta escritor unico.
[3] RERANKER cross-encoder (sidecar ultron-rerank, bge-reranker-v2-m3 ONNX, warm como
    ultron-embed) tras RRF en recall_unified + en catalog::search_catalog. Medir vs baseline.
[4] index_skills() en catalog.rs (skills NO indexadas, solo agentes) + catalog-reindex CLI.
[5] AI Router: temperature/response_schema en ZoneAssignment+wrappers + cache + selector
    dinamico + delegate_task_inner despacha a Codex/Gemini (pty ya soporta los 3).
[6] Investigar fts5_available=false en release+qdrant (bm25 real > LIKE term-OR actual).
[7] Quota: senal real (headers anthropic-ratelimit-unified-5h/7d) + is_soft_constrained
    + quota:critical -> launch_codex_fallback.
[8] Hooks: reorientar Stop->candidate; dedup routers; invertir SoT a ~/.ultron/hooks.
[9] Auditar MCPs + rotar GITHUB_TOKEN.

Verificacion: tras cada cambio, cargo test --no-default-features --lib memory; para recall,
rebuild sidecar (cargo build --release --bin ultron-memory --features qdrant) + ultron-memory eval
(comparar recall@k vs 0.917). Commit por item.
```

---

## Resumen de lo hecho esta noche (2026-06-04, 10 commits)
- `1a14a27` Ola 0 seguridad (gate Secret + ruta legacy cortada)
- `aeb3091` higiene repo
- `b916c5a` Ola 1a (coseno real, budget)
- `31cb151` master plan + kanban
- `0574db0` Ola 3-D2 (invariantes en CI) + specs
- `0d123e7` Ola 1b (vault off-by-default)
- `5e7b7ca` **fix sparse roto en produccion** (verificado e2e 0->30)
- `84280d5` Olas 5/7 scaffolding (ai_tasks/contradiction/reflection/evals)
- `0532dee` eval harness + baseline recall@8=0.917
- (+ docs status/specs)

## Workflows de analisis disponibles (outputs en tasks/*.output del transcript dir)
w83p7ntwp (auditoria memoria PARTIAL 62%) · w4uv2ocgd (SOTA ~55-60%) · waqq5qec7 (quota) ·
wqpf1uiwm (AI router) · wwoac1zg1 (skills/agentes) · w9x5bdil5 (implementacion 4 modulos).

## Verdad incomoda (honestidad)
"El mejor sistema de memoria del mundo" NO esta acabado — el nucleo critico SI (seguridad,
recall real, medible). Lo que falta (reranker, meta-cognicion, enganche de componentes,
multi-IA, fts5 bm25) es real y necesita ciclos coordinados rebuild+Qdrant+keys, no batch a ciegas.
