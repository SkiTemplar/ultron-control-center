# DEPRECATION REGISTRY — ULTRON — 2026-06-04

> Registro canonico inicial de artefactos deprecados/huerfanos/competidores (OLA K, fase datos).
> Producido en OLA 0 (read-only). NINGUN artefacto se borra desde este doc: es el inventario que
> alimentara `ultron maintenance scan/plan/apply` cuando se implemente. Estados:
> `active` · `deprecated` · `shadowed` · `quarantined` · `pending_delete` · `deleted` · `restored`.
>
> Contrato (08-AUDIT 3.8): nada pasa a `deleted` sin snapshot/rollback o prueba de regenerabilidad;
> todo delete emite evento auditado; la limpieza es idempotente; no rompe `eval`/`reconcile`/hooks/startup.
>
> **[SEED del registry persistente — OLA K]** Este doc es la **semilla** de la tabla `deprecation_entries`
> en `brain.db` (migración aditiva `schema_version 2→3`). El contrato `scan → plan → apply --confirm`
> que lo convierte en estado vivo (con eventos auditados y rollback) está en
> `specs/SPEC-MAINTENANCE-CLI.md`. `ultron maintenance seed` carga estas 42 entries 1:1; los scanners
> read-only reconcilian cuáles siguen vivos (`last_seen`). Editar aquí ≈ editar el seed, no el estado vivo.

## Leyenda de riesgo
- **alto**: store competidor vivo / escritura fuera del SoT / posible perdida de datos.
- **medio**: codigo muerto que toca contratos o config viva.
- **bajo**: comentarios stale, dead code aislado, docs.

---

## A. Stores / escritores competidores (P0/P1)

| id | artefacto | tipo | ruta | motivo | replacement | estado | risk | cleanup_action | rollback_action |
|---|---|---|---|---|---|---|---|---|---|
| DR-01 | `stop-compress-session.js` writer a Qdrant `ultron_sessions` 384d | hook Node | `~/.claude/scripts/stop-compress-session.js:82,419,432` | escribe fuera del SoT (no MemoryService); 384d incompatible con E5 1024d | reorientar a `ultron-memory candidate` | active (VIVO) | **alto** | reescribir upsert -> sidecar candidate; cortar creacion de ultron_sessions | revertir hook (git/backup del .js) |
| DR-02 | `mem0-sync.js` writer a Mem0 cloud | hook Node | `~/.claude/scripts/mem0-sync.js:30,456-475`; settings.json:36 | store competidor (PLAN.md:84 "Mem0 fuera"); token-gated | ninguno (o L3 opt-in documentado) | active (VIVO, token-gated) | **alto** | desregistrar de settings.json Stop | re-registrar hook |
| DR-03 | coleccion Qdrant `ultron_sessions` (BGE 384d, 69 pts) | Qdrant collection | Qdrant `:6333/collections/ultron_sessions` | legacy retirada (Fase F) pero aun escrita/leida | `ultron_memory` (E5 1024d) | shadowed | **alto** | drenar/migrar 69 pts -> candidates; luego DELETE collection | restore desde snapshot Qdrant |
| DR-04 | Mem0 local config | data | `~/.mem0/config.json` | cliente cloud Mem0 (user_id) | — | active | medio | conservar hasta decidir Mem0; no borrar sin confirmar | n/a |
| DR-05 | `EccStore` (read-only) + comandos `ecc_memory_read`/`bootstrap_ecc_memory` | Rust + commands | `memory/mod.rs:384-465`; lib.rs:316-317 | store de lectura paralelo (PLAN.md:84 "ECC fuera") | — | shadowed | bajo | retirar de memory_health o marcar display-only | git revert |
| DR-06 | MCP `ecc memory` (knowledge graph) | MCP store | plugin `ecc@ecc`; `~/.claude/memory.jsonl` (0.2 KB) | escritor de memoria potencial; store casi vacio | MemoryService | active (latente) | bajo | vigilar; bloquear si empieza a escribir | n/a |

## B. Quota (huerfanos tras cbb2d5c) (P1/P3)

| id | artefacto | tipo | ruta | motivo | estado | risk | cleanup_action |
|---|---|---|---|---|---|---|---|
| DR-07 | `quota-capture.js` (PostToolUse, VIVO) | hook Node | `~/.claude/hooks/quota-capture.js`; settings.json:145 | productor huerfano (lector borrado) | orphan | medio | desregistrar de settings.json |
| DR-08 | `quota-state.json` (98%, critical:true) | data | `cockpit/quota-state.json` (118 B) | huerfano (nadie lee) | orphan | bajo | borrar tras desregistrar DR-07 |
| DR-09 | comentarios "quota watchdog" | Rust | `lib.rs:556-557`, `644-646` | sin codigo detras | deprecated | bajo | borrar comentarios (rebuild) |
| DR-10 | `QuotaDot` + `useQuotaDot` | React | `Sidebar.tsx:213-285,497-500` | invoca `quota_get_status` inexistente; señal falsa (0% verde) | shadowed | bajo | eliminar componente |
| DR-11 | listeners `quota:critical/reset` | React | `ProxyControl.tsx:13,133-168` | eventos no emitidos | orphan | bajo | eliminar useEffect |
| DR-12 | descriptor quota-capture activo | Rust | `hooks_admin.rs:1641-1643` | stale | deprecated | bajo | actualizar descriptor |
| DR-13 | comentario "usage stats + quota" | React | `Usage.tsx:530` | tarjeta ya retirada | deprecated | bajo | editar comentario |

## C. Codigo muerto / scaffolding no cableado (P2/P3)

| id | artefacto | tipo | ruta | motivo | estado | risk | cleanup_action |
|---|---|---|---|---|---|---|---|
| DR-14 | `contradiction.rs` | Rust modulo | `memory/contradiction.rs` | scaffolded, TODO sin cerrar en service.rs:57 | orphan | medio | cablear en create_candidate O marcar diferido |
| DR-15 | `ai_tasks.rs` (extract/rewrite/judge) | Rust modulo | `memory/ai_tasks.rs:131,156,201` | cheap-brain sin caller | orphan | medio | cablear rewrite_query en recall_unified O diferir |
| DR-16 | `reflection.rs` (~505 lineas) | Rust modulo | `memory/reflection.rs` | sin punto de entrada | orphan | medio | subcomando `reflect` O diferir |
| DR-17 | comando `recall_hybrid` + `HybridRecall` | Rust | `recall_hybrid.rs:24-62`; `memory/mod.rs:596-666` | retirado Ola 0 | orphan | **medio** | mover `memory_health` a archivo propio ANTES de borrar (usa el trait) |
| DR-18 | comando `recall_semantic` (384d) | Rust | `qdrant.rs:624-630` | retirado, no en invoke_handler | deprecated | bajo | borrar comando |
| DR-19 | tipos `QdrantHit`/`RecallSemanticResult` | TS | `types.ts:1050-1086` | sin caller; doc apunta a comando retirado | orphan | bajo | borrar tipos |
| DR-20 | tablas `kg_entities`/`kg_relations` | SQLite | `sqlite_store.rs:129-137` | escritas, sin lector (KG usa kg.jsonl) | orphan | medio | decidir SSOT KG; borrar tablas O migrar lectores |
| DR-21 | glob re-exports `pub use *::*` | Rust | `commands/memory/mod.rs:24-35` | ocultan comandos no registrados | active (riesgo) | bajo | re-exports nominales + test def-vs-registered |

## D. Comandos backend sin caller UI (P1/P2) — decision: backend-only intencional vs podar

| id | bloque | ruta | nota |
|---|---|---|---|
| DR-22 | MEMORY KERNEL ~15 comandos (recall, recall_inspect, memory_inbox_*, memory_candidate_*, memory_item_*, memory_stats, session_resume, catalog_*, memory_migrate, orchestrate_prompt, memory_unified_search, memory_tree_snapshot) | `lib.rs:270-343` | pestañas Memory/Inbox eliminadas; consumidos por hooks/CLI? Solo memory_health + mem0_status vivos en UI |
| DR-23 | 6 comandos `mem0_*` CRUD | `lib.rs:327-333` | solo mem0_status tiene caller |
| DR-24 | ~35 `workday_*`, 7 `kg_*`, 9 `decisions_*` | `lib.rs:319-394` | solo workday_record_kanban_event tiene caller |

## E. Hooks duplicados / fragmentacion (P1)

| id | artefacto | ruta | nota |
|---|---|---|---|
| DR-25 | 10 copias homonimas duplicadas | `~/.ultron/hooks/scripts/*` vs `~/.claude/scripts/*` | identicas hoy; el versionado casi no se invoca; drift estructural |
| DR-26 | `session-recall-inject.js` | ambos arboles | retirado de settings.json (Ola 0), sigue en disco, lee ultron_sessions |
| DR-27 | `workday-auto-update.js` | `~/.claude/hooks/` | no en settings.json -> posible huerfano (verificar) |

## F. Docs stale (P1-P3) — ver STATE-RECONCILIATION seccion 4
DR-28..DR-37: `00-PROMPT-CONTINUACION`, `STATUS-SISTEMAS`, `SPECS-SISTEMA`, `MASTER-PLAN-CONSOLIDADO`,
`02-AI-ROUTER`, `05-HOOKS`, `01-MEMORIA`, `08-AUDIT`, `DIAGNOSIS`, `PLAN`.

## G. Cruft de disco (P1) — ver DISK-FOOTPRINT-2026-06-04.md
DR-38: `.fastembed_cache` x6 copias (~3.5 GB recuperables). DR-39: dirs malformados
`CUsersRodrigo.ultron.tmpevals*`, `.tmpevalsround3/4`. DR-40: backups sin rotacion (899 MB protected candidate).
DR-41: `target/debug` 23 GB + incremental 5.5 GB regenerable. DR-42: `logs/backup-2026-06-01.log` 15.6 MB.

---

## Resumen
- **42 artefactos** registrados: 6 stores/escritores competidores, 7 huerfanos de Quota, 8 codigo muerto,
  3 bloques de comandos sin UI, 3 de hooks, 10 docs, 5 de disco.
- **Alto riesgo (3)**: DR-01, DR-02, DR-03 (escritura fuera del SoT / store competidor). Bloqueados por confirmacion.
- Ninguno marcado `pending_delete` aun: requieren `ultron maintenance plan` + dry-run + snapshot (no implementado).
