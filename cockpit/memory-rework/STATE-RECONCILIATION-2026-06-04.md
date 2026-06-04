# STATE RECONCILIATION — ULTRON Memory Rework — 2026-06-04

> OLA 0 del prompt maestro (`specs/08-AUDIT-Y-PROMPT-CORRECCION-TOTAL.md`).
> Verdad del sistema verificada contra runtime real (git, Qdrant API, `ultron-memory stats`,
> disco, lectura de codigo con evidencia `file:line`). Producido por sondeo inline + workflow
> paralelo `wgj62ddh9` (5 streams read-only, 682k tokens). CERO cambios funcionales en esta ola.
>
> **Documentos correctos de referencia**: `04-QUOTA.md` (header) y `STATUS.md` (top-level).
> Todo lo demas se reconcilia contra este documento.

---

## 1. Verdad verificada (correcciones al prompt y a los docs)

| Afirmacion en prompt/docs | Verdad verificada | Evidencia |
|---|---|---|
| HEAD `0532dee` | **`823ed67`** (+4 commits: 8d965e3, 425feca, cbb2d5c, 4ff0281, 823ed67) | `git rev-parse HEAD` |
| Quota = subsistema vivo / tarea pendiente | **QUITADO** en `cbb2d5c` (quota_watchdog.rs borrado, -465 lineas; -82 en ai_router) | `grep is_critical\|quota_watchdog\|react_to_rate_limit` en src = 0 matches; `git show cbb2d5c --stat` |
| `~/.ultron/workflow-runs.db` (no-data-loss contract) | Esta en **`cockpit/workflow-runs.db`** (0.02 MB) y persiste | disk scan |
| SQLite y Qdrant "pueden divergir" | Hoy **CONSISTENTES**: 943 = 943 | `ultron-memory stats` active=943; Qdrant `ultron_memory` points_count=943 |
| Embeddings = `bge-m3` (DIAGNOSIS/PLAN/MASTER-PROMPT) | **E5-Large 1024d** (bge-m3 descartado, fastembed no lo soporta) | Qdrant `ultron_memory` size=1024; STATUS.md:22-24 |
| brain.db conteos | active=**943**, candidates_pending=**34**, events=**1043** (docs dicen ~995/977+, drift menor append-only) | `ultron-memory stats`; SQLite COUNT |

### Estado runtime (snapshot 2026-06-04)
- Branch `fullize-2026-05-30`, HEAD `823ed67`, tree limpio salvo untracked `specs/08-AUDIT...md`.
- Qdrant UP: `ultron_memory` (943 pts, 1024d, Cosine, `indexed_vectors_count=0` = normal bajo umbral HNSW -> brute-force exacto), `ultron_catalog` (solo agentes), `ultron_sessions` (legacy 384d, 69 pts, **aun escrita**).
- `brain.db` 1.96 MB. `ultron-memory.exe` release 28.6 MB (04/06 02:25). App **cerrada**, `.exe` desbloqueado (rebuild posible). `sqlite3` no en PATH.
- Recall baseline reproducible: **recall@8 = 0.917** (`ultron-memory eval`).

---

## 2. Conflicto de Quota: RESUELTO

El conflicto que el 08-AUDIT marca (su seccion 1) **ya esta resuelto en codigo**: Quota % se quito en
`cbb2d5c`. La "primera tarea: comprobar si Quota existe" del master-prompt es innecesaria — existe la
respuesta. Lo que queda es **propagar la verdad** y **limpiar huerfanos**:

| Residuo de Quota | Ubicacion | Estado | Accion |
|---|---|---|---|
| Comentarios watchdog sin codigo | `lib.rs:556-557`, `644-646` | stale | borrar comentarios (cosmetico, requiere rebuild) |
| `quota-capture.js` (PostToolUse, VIVO) | `~/.claude/hooks/` | huerfano productor | desregistrar de settings.json `[BLOQUEADO: config viva]` |
| `quota-state.json` (98%, critical:true) | `cockpit/` | huerfano (nadie lee) | borrar tras desregistrar hook |
| `QuotaDot` (Sidebar) invoca `quota_get_status` inexistente | `Sidebar.tsx:213-285,497-500` | shadowed, señal falsa (catch silencioso -> 0% verde) | eliminar componente |
| Listeners `quota:critical/reset` del proxy | `ProxyControl.tsx:13,133-168` | dead events | eliminar useEffect |
| Comentario "usage stats + quota" | `Usage.tsx:530` | stale (tarjeta ya retirada) | editar comentario |
| `hooks_admin.rs:1641` cataloga quota-capture como activo | backend | stale | actualizar descriptor |

---

## 3. Hallazgos por severidad (consolidado: inline + 5 streams)

### P0 — seguridad / data-loss / store competidor / escritura fuera del SoT
| # | Hallazgo | Evidencia | Estado |
|---|---|---|---|
| P0-1 | **`stop-compress-session.js` escribe DIRECTO a Qdrant `ultron_sessions` (384d)** saltandose MemoryService y el SoT, en cada Stop. Embed 384d (ultron-embed.exe) incompatible con el canonico E5 1024d. | `stop-compress-session.js:82,419,432`; `qdrant_index.rs:8` declara ultron_sessions retirada; live 69 pts 384d | **VIVO** (settings.json:25) |
| P0-2 | **`mem0-sync.js` escribe a Mem0 cloud** (mcp.mem0.ai) en cada Stop, store competidor fuera del SoT. PLAN.md:84 dice "Mem0 fuera". Hoy gateado por token ausente, pero cableado. | `mem0-sync.js:30,456-475`; settings.json:36; `~/.mem0/config.json` | **VIVO** (token-gated) |

> Nota: ambos son escritores de memoria que NO pasan por MemoryService -> violan "unico escritor".
> La mitigacion (cortar el writer / reorientar a `ultron-memory candidate`) toca **hooks vivos +
> settings.json global** -> requiere confirmacion (ver seccion 6).

### P1 — reconciliacion / deprecados / hooks / backups / disco
| # | Hallazgo | Evidencia |
|---|---|---|
| P1-1 | Hooks fragmentados en **3 arboles**; el VIVO (`~/.claude/scripts`, `~/.claude/hooks`) **NO esta versionado**; el versionado (`~/.ultron/hooks/scripts`) casi no se invoca (solo memory-orchestrate, memory-session-resume). 10 copias homonimas **identicas hoy** pero drift estructural. | settings.json mapea mezcla; `.claude` no es repo git |
| P1-2 | `quota-capture.js` huerfano productor (escribe quota-state.json, sin lector). Corre en CADA PostToolUse. | settings.json:145; quota-capture.js:42,118 |
| P1-3 | **`ultron_sessions` (384d legacy) aun viva**: escrita por stop-compress, leida por `memory_unified_search` (registrado). | `memory_graph.rs:201`; lib.rs:342 |
| P1-4 | **Catalogo solo indexa agentes**; `index_skills()` no existe en Rust -> skills no compiten en routing. | `catalog.rs:133` entity="agent"; sin index_skills en src |
| P1-5 | **~15 comandos MEMORY KERNEL** registrados sin caller UI (pestañas Memory/Inbox eliminadas fullize 2026-06-01); + 6 mem0_*, + ~35 workday_*, 7 kg_*, 9 decisions_* huerfanos de UI. | lib.rs:270-394; Sidebar.tsx:82-83 |
| P1-6 | **Disco ~40 GB**: `target/` 36 GB regenerable; `.fastembed_cache` x6 copias (~3.5 GB recuperables); backups sin rotacion (uno de 899 MB). | disk scan (ver DISK-FOOTPRINT-2026-06-04.md) |

### P2 — consistencia / codigo muerto / deuda
| # | Hallazgo | Evidencia |
|---|---|---|
| P2-1 | `contradiction.rs` scaffolded, NUNCA invocado (TODO sin cerrar). | `service.rs:57-60`; sin callers de contradiction::check |
| P2-2 | `ai_tasks.rs` (extract_candidates, rewrite_query, judge_contradiction) sin caller vivo (cheap-brain desconectado). | grep sin matches en recall_unified/orchestrator/bin |
| P2-3 | `reflection.rs` totalmente huerfano (ni binario ni comando). | `mod.rs:163` unica ref; ~505 lineas |
| P2-4 | Comando `recall_hybrid` + orquestador `HybridRecall` huerfanos. **CUIDADO**: `memory_health` (vivo, Dashboard) usa el trait MemoryStore + 5 adaptadores -> no borrable sin mover memory_health antes. | recall_hybrid.rs:24-62; lib.rs:265-266 |
| P2-5 | `memory_health` instancia y reporta 4 stores competidores (Qdrant384/Ecc/Kg/Mem0) como vivos al UI. | recall_hybrid.rs:64-125 |
| P2-6 | Tablas `kg_entities`/`kg_relations` escritas, sin lector real (KG lee `kg.jsonl`). | sqlite_store.rs:129-137,662-680,770 |

### P3 — mejora / cosmetico
- `recall_semantic` (384d) dead code; glob re-exports `pub use *::*` ocultan comandos no registrados; `EccStore` read-only competidor; tabs (plans/changelog/skills/agents/rules) ruteadas pero sin entrada en Sidebar (alcanzables por command palette).
- Solo `evals.rs` de los 4 modulos Fase D/E esta vivo (subcomando `eval`). Es el harness del baseline 0.917.

---

## 4. Docs stale (10) y plan de reconciliacion

| Doc | Stale en | Fix |
|---|---|---|
| `00-PROMPT-CONTINUACION.md` | HEAD 0532dee; item [7] Quota como tarea viva | HEAD->823ed67; reformular [7]: Quota = re-implementar de cero |
| `STATUS-SISTEMAS-2026-06-04.md` | HEAD; Seccion 4 Quota viva (~45%) | HEAD; reescribir Seccion 4 -> QUITADO |
| `SPECS-SISTEMA-2026-06-04.md` | Quota plomeria viva (file:line obsoletos) | banner reconciliacion Quota |
| `MASTER-PLAN-CONSOLIDADO-2026-06-03.md` | Ola 8 edita quota_watchdog.rs inexistente | banner: Ola 8 obsoleta tras cbb2d5c |
| `02-AI-ROUTER.md` | fila "quota-guard is_critical() vivo" | quitar fila; remitir a 04-QUOTA |
| `05-HOOKS.md` | quota-capture.js "fragil" (es huerfano) | nota: huerfano tras cbb2d5c |
| `01-MEMORIA.md` | HEAD 0532dee | HEAD->823ed67 |
| `08-AUDIT-...md` | HEAD 0532dee; "primera tarea: ver si Quota existe" | HEAD; nota: Quota ya resuelto |
| `DIAGNOSIS.md` | locked bge-m3 | banner: descartado, se uso E5 1024d |
| `PLAN.md` | locked bge-m3 (B1 sidecar) | banner: descartado, se uso E5 1024d |

> Correctos (no tocar): `04-QUOTA.md`, `STATUS.md`.

---

## 5. Plan ajustado por olas (vs 08-AUDIT)

El orden del 08-AUDIT es correcto (verdad -> contratos -> seguridad -> mantenimiento), con **3 ajustes**:
1. **OLA 0 Quota**: no "investigar si existe" (resuelto), sino "propagar verdad + limpiar huerfanos".
2. **P0 competing-stores** (stop-compress, mem0-sync) estan BLOQUEADOS por confirmacion (hooks+config vivos).
   El trabajo autonomo P0 viable esta en el **write-path Rust** (secret/PII redaction antes de SQLite/Qdrant),
   no en desactivar hooks.
3. **App cerrada + rebuild posible** habilita cambios de codigo verificables esta noche (no solo docs).

Secuencia recomendada (cada ola = commit verificado):
- **OLA 0** (esta): reconciliacion + registries (deprecados, disco) + docs. [AUTONOMO, esta noche]
- **OLA A** contratos: definir schemas de policy/manifest (memory injection, source-trust, hook manifest,
  MCP policy, deprecation schema) como specs. Implementar secret/PII detector en write-path. [schemas AUTONOMO; detector = codigo + rebuild + tests]
- **OLA B** consistencia: outbox/reconciler SQLite<->Qdrant, `ultron-memory reconcile --check`, content_hash/normalized_text. [codigo]
- **OLA C** evals serias: golden set >=100 queries categorizadas + secret/stale/cross-project/temporal. [codigo]
- **OLA I** hooks: SoT unica + reorientar Stop->candidate + dedup routers + cortar ultron_sessions. [BLOQUEADO config viva]
- **OLA E/D/F/G/H/J/K/L/M**: contradiction/dedupe -> reranker -> router policy -> skills routing -> orquestador -> MCP audit -> lifecycle -> disco -> control plane.

---

## 6. Riesgos que requieren DECISION HUMANA (bloqueantes de confirmacion)

1. **Desactivar `mem0-sync.js`** (settings.json Stop) y des-registrar comandos `mem0_*`. ¿Mem0 esta definitivamente fuera (PLAN.md:84) o se mantiene como L3 opt-in? — toca config global.
2. **Reorientar/cortar `stop-compress-session.js`** (escribe ultron_sessions 384d directo). ¿Reescribir a `ultron-memory candidate` o desactivar upsert? — toca hook vivo. + decidir si migrar los 69 pts de ultron_sessions antes de borrar la coleccion.
3. **Desregistrar `quota-capture.js`** + borrar `quota-state.json`. — config global.
4. **SoT de hooks**: ¿versionar `~/.claude/scripts` o migrar a `~/.ultron/hooks/scripts` y reapuntar settings.json? — config global + mover archivos no versionados.
5. **Rotacion de `GITHUB_TOKEN`** (fuga historica redactada pendiente) — secreto.
6. **Borrados de disco** (target/debug incremental, caches duplicadas, backups grandes) — destructivo, dry-run + confirmacion.
7. **Borrado de dead code** que toca contratos (recall_hybrid/memory_health refactor) — riesgo de regresion en Dashboard.

---

## 7. Plan de workflows paralelos para la noche

| Workflow | Objetivo | Inputs | Outputs | Riesgo | Dependencia |
|---|---|---|---|---|---|
| `wgj62ddh9` (HECHO) | Inventario OLA 0 (5 streams) | repo, hooks, docs | findings -> este doc | nulo (read-only) | — |
| OLA-A-contracts (autonomo) | Redactar schemas policy/manifest como specs | este doc | `CONTRACTS-2026-06-04.md` | nulo | OLA 0 |
| OLA-C-goldenset (proponible) | Generar golden set >=100 queries categorizadas | brain.db items | dataset JSON | bajo (lectura) | eval harness |
| dead-code-map (proponible) | Mapa exacto de lineas a borrar + plan de refactor memory_health | streams 1/5 | RFC de poda | nulo (analisis) | OLA 0 |

---

## 8. Checkpoint: autonomo vs bloqueado

**Ejecutable SIN supervision esta noche (reversible vvia git, sin tocar config viva):**
- [x] STATE-RECONCILIATION (este doc)
- [ ] DEPRECATION-REGISTRY-2026-06-04.md (registro canonico OLA K, solo datos)
- [ ] DISK-FOOTPRINT-2026-06-04.md (analisis OLA L + plan por niveles, sin borrar)
- [ ] Reconciliar los 10 docs stale (banners/correcciones)
- [ ] CONTRACTS-2026-06-04.md (schemas OLA A como diseno)

**Bloqueado por confirmacion explicita (seccion 6):** desactivar/reescribir hooks vivos, editar settings.json
global, borrar archivos/colecciones/backups/caches, rotar tokens, refactor de memory_health.

**Codigo de repo verificable (posible pero lo dejo para confirmacion por riesgo de contrato):** borrado de
dead code (recall_hybrid, recall_semantic, tipos types.ts), limpieza de comentarios stale, cableado de
contradiction/ai_tasks. Requieren rebuild + `ultron-memory eval` (comparar vs 0.917) + revisar memory_health.
