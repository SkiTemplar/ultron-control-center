# PROMPT DE CONTINUACION — ULTRON Memory Rework (limpio)
### 2026-06-04 (noche) · rama `fullize-2026-05-30` · HEAD `d3a16ff`

> Documento de reanudacion LIMPIO y CURRENT. Reemplaza versiones anteriores que tenian
> HEAD/Quota stale. Verdad verificada a runtime (git, Qdrant API, `ultron-memory eval/reconcile`,
> tests, brain.db real). Para retomar: lee este doc + `STATE-RECONCILIATION-2026-06-04.md`
> (mapa de hallazgos) + `CONTRACTS-2026-06-04.md` (schemas de diseno).

---

## 1. Estado actual verificado (lo que YA funciona)

**Nucleo de memoria: seguro, consistente y medible.** Base que el audit pedia antes de tocar ranking.

| Capa | Estado | Evidencia runtime |
|---|---|---|
| SQLite `~/.ultron/brain.db` = SoT | ✅ | 943 active, 34 candidates, schema_version=2, user_version=2 |
| Qdrant `ultron_memory` (E5 1024d) = indice derivado | ✅ | 943 puntos, in_sync con SQLite |
| `MemoryService` = unico escritor | ✅ | invariantes en CI |
| **Seguridad write-path (OLA A)**: redaccion secret/PII antes de persistir/indexar | ✅ VIVO | `memory/redaction.rs` cableado en create_candidate + add_imported; sidecar desplegado |
| **content_hash / normalized_text / schema_version (OLA B1)** | ✅ | FNV-1a estable; migracion aditiva + backfill 943/943 verificado |
| **`ultron-memory reconcile` (OLA B3)**: drift SQLite↔Qdrant read-only | ✅ | in_sync=true 943/943; cross-check Python |
| **eval security gate (OLA C)**: secret/stale-leak | ✅ | leak=0 sobre store real |
| Recall hibrido (dense E5 + sparse FTS/LIKE → RRF → coseno → pack) | ✅ | **baseline recall@8 = 0.917** (`ultron-memory eval`) |
| Hooks memoria (SessionStart resume, UserPromptSubmit orchestrate) | ✅ | via sidecar `~/.ultron/bin/ultron-memory.exe` |

**Limpieza P0 hecha (2026-06-04 noche, backup en `backups/config-2026-06-04-preP0/`):**
- Mem0 cloud cortado (hook `mem0-sync.js` fuera de Stop). 
- `quota-capture.js` huerfano fuera de PostToolUse + `quota-state.json` borrado.
- `stop-compress-session.js` ya no escribe a `ultron_sessions` 384d (fuera del SoT).

---

## 2. Reglas duras (no negociables)

- SQLite `brain.db` = fuente de verdad. Qdrant = indice derivado reconstruible (`reindex_all`).
- `MemoryService` (memory/service.rs) = UNICO escritor persistente. Hooks/agentes/MCPs proponen candidates.
- Nada a `active` sin politica/inbox. Auto-captura → candidate/quarantine.
- NO escribir secretos en SQLite/Qdrant/logs/backups/embeddings → redactar antes (OLA A ya lo hace en el write-path).
- NO borrar sin snapshot/backup + dry-run + reversibilidad.
- Verificacion 100% runtime real (cargo test + eval/reconcile + datos reales), no solo `cargo check`.
- Reuse-over-rebuild. Commit por unidad cerrada. ASCII puro en `.ps1`; `.rs` rustfmt-clean.
- **Config global (`~/.claude/settings.json`), rotacion de tokens, borrados irreversibles → requieren confirmacion explicita, incluso en modo autonomo.**
- UV para Python (`uv run python`, nunca `python` pelado).

## 3. Antes de tocar codigo
- App ULTRON cerrada (file-lock del `.exe`) para rebuild.
- Qdrant arriba: `curl http://127.0.0.1:6333/collections/ultron_memory`.
- Snapshot `brain.db` antes de cualquier migracion/escritura masiva.

---

## 4. Plan de ataque (orden por prioridad, cada item = commit verificado)

**Hecho:** OLA 0 (reconciliacion) · OLA A (redaccion write-path) · OLA B1 (content_hash+migracion) ·
OLA B3 (reconcile --check) · OLA C (eval security gate) · limpieza P0 config viva (parcial).

**Siguiente (gated/supervisado):**
1. **Contradiction wiring** (cerrar TODO `service.rs:57`): embed proposed_summary → `qdrant_index::search_dense`
   → `ai_tasks::judge_contradiction` (AI Router, **requiere API keys** + e2e vs baseline 0.917) →
   set contradiction_candidates + recommended_action=Quarantine. NUNCA auto-approve. [SUPERVISADO: keys]
2. **Hooks SoT repoint** a `~/.ultron/hooks` (versionado): copiar live → versionado, reapuntar settings.json,
   borrar duplicados. [config global → confirmacion; probar una sesion despues]
3. **reconcile --repair** (dry-run + --apply): reindex de missing + delete de orphans. Qdrant es
   reconstruible pero muta → dry-run por defecto, --apply con confirmacion.
4. **Stop → `ultron-memory candidate`**: reescribir stop-compress para emitir candidate (no solo
   appendPendingDecisions); cierra el camino canonico de captura de sesion.
5. **OLA D retrieval**: golden set ≥100 categorizado (precision@k/nDCG/context-waste) → reranker
   cross-encoder (bge-reranker-v2-m3 ONNX, sidecar warm) tras RRF. Medir vs 0.917.
6. **OLA E**: dedupe multicapa (usar content_hash + normalized_text ya disponibles) + contradiction +
   supersession bitemporal (valid_from/valid_to) + reflection grounded.
7. **AI Router (OLA F)**: temperature/response_schema en zonas + validacion JSON + cache + selector dinamico.
8. **Skills/Agentes (OLA G)**: `index_skills()` en catalog.rs (hoy solo agentes) + reranker + activation policy.
9. **MCPs (OLA J)**: auditar, rotar GITHUB_TOKEN, bloquear ecc-memory como competidor.
10. **Disco (OLA L)**: limpieza nivel 1/2 (~9.8 GB) con dry-run.

## 5. Comandos de verificacion
```
cargo test --manifest-path control-center/src-tauri/Cargo.toml --no-default-features --lib memory
cargo build --release --bin ultron-memory --features qdrant --manifest-path control-center/src-tauri/Cargo.toml
ultron-memory eval        # recall@8 (baseline 0.917) + secret_leak/stale_leak (deben ser 0)
ultron-memory reconcile   # in_sync SQLite<->Qdrant (943=943)
ultron-memory stats
curl http://127.0.0.1:6333/collections/ultron_memory
```
Tras editar memory: rebuild release + copiar a `~/.ultron/bin` para que los hooks vivos usen el binario nuevo.

## 6. Artefactos de referencia (cockpit/memory-rework/)
- `STATE-RECONCILIATION-2026-06-04.md` — verdad + hallazgos P0-P3 + plan.
- `CONTRACTS-2026-06-04.md` — schemas policy/manifest (memory item, source-trust, dedupe, hooks, router, MCP).
- `DEPRECATION-REGISTRY-2026-06-04.md` — 42 artefactos deprecados/huerfanos.
- `DISK-FOOTPRINT-2026-06-04.md` — ~40 GB explicado, plan por niveles.
- `NIGHT-RUN-2026-06-04.md` — log del run nocturno (decisiones + commits + turnkey).
- specs `01..07` — por subsistema (01-MEMORIA y 05-HOOKS al dia; resto con banner de reconciliacion).

## 7. Decisiones del dueno (2026-06-04)
- Mem0 = FUERA (cortado el hook; comandos mem0_* pendientes de marcar read-only).
- Hooks SoT → `~/.ultron/hooks` (versionado) [repoint pendiente].
- Conservar MEMORY KERNEL (recall_inspect/inbox/candidate_approve/stats) como base de una UI simple
  futura de revision/aprobacion de memoria; podar solo lo de features muertas (workday/kg/decisions huerfanos).
- Quota % = QUITADO (cbb2d5c), no reintroducir sin senal real.
