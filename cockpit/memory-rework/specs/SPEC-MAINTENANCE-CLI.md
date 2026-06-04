# SPEC — Maintenance CLI · Lifecycle + Disk Manager (OLA K/L)
### Autocontenido para revisión por IA externa · 2026-06-04 · HEAD `f936a66`

> **SoT = SQLite `~/.ultron/brain.db`** (943 active, 35 candidates, `schema_version=2`).
> Único escritor de memoria canónica = `MemoryService`. El Maintenance Manager **NO** es escritor
> de memoria: gestiona su propio dominio (artefactos deprecados, disco) en tablas dedicadas, y
> nunca toca `memory_items`/`memory_events` salvo lectura para sus checks.
> **Reuse-over-rebuild**: este doc formaliza dos inventarios YA producidos en read-only
> (`../DEPRECATION-REGISTRY-2026-06-04.md` 42 artefactos · `../DISK-FOOTPRINT-2026-06-04.md` ~40 GB).
> Esos docs son la **semilla** (seed) del registry persistente; este spec define el contrato que los
> convierte en estado vivo `scan → plan → apply`.
> Trazabilidad: `08-AUDIT-Y-PROMPT-CORRECCION-TOTAL.md` §3.8 (Lifecycle/Deprecation) y §3.9 (Disk Footprint);
> esquema base en `../CONTRACTS-2026-06-04.md` §9.

---

## 1. Propósito

Un único manager de mantenimiento que **explica y reduce** la entropía del repo (código muerto,
stores legacy, hooks fuera de SoT, UI sin backend, caches/logs/backups, ~40 GB de disco) de forma
**auditable, idempotente y reversible**, sin que el operador tenga que inspeccionar a mano.

No-objetivos:
- NO es un linter genérico ni un GC del compilador.
- NO borra nunca datos canónicos (`brain.db`, `qdrant_storage`, `bin/` sidecars, `qdrant-native`,
  backups `protected`, model cache canónica).
- NO escribe memoria; los scanners son **read-only**, solo `apply --confirm` muta disco/estado.

Invariante maestro (de §3.8/§3.9 y `CONTRACTS` §9): **nada pasa a `deleted` sin snapshot/rollback o
prueba de regenerabilidad; todo delete emite evento auditado con `trace_id`; la limpieza es
idempotente; no rompe `eval` / `reconcile` / hooks / startup.**

---

## 2. Modelo de datos (persistencia en `brain.db`)

Migración **aditiva** (no destructiva) `schema_version 2 → 3` aplicada por `apply_schema`
(idempotente, mismo patrón que las migraciones de memoria). Dos tablas nuevas; ninguna columna de
`memory_*` se altera.

### 2.1 `deprecation_entries` (estado vivo de cada artefacto)

```sql
CREATE TABLE IF NOT EXISTS deprecation_entries (
  id              TEXT PRIMARY KEY,          -- "DR-01" … (estable; clave de reconciliación con el seed)
  artifact        TEXT NOT NULL,             -- nombre legible
  domain          TEXT NOT NULL,             -- enum DeprecationDomain (ver 2.3)
  kind            TEXT NOT NULL,             -- hook_node|rust_module|rust_command|sqlite_table|
                                             --   qdrant_collection|react_component|ts_type|doc|
                                             --   disk_cache|disk_log|disk_backup|disk_target|mcp_store
  owner           TEXT,                      -- subsistema responsable (memory|hooks|router|ui|disk|mcp)
  path            TEXT NOT NULL,             -- ruta o glob canónico
  reason          TEXT NOT NULL,
  replacement     TEXT,                      -- artefacto que lo sustituye (NULL si no aplica)
  state           TEXT NOT NULL,             -- enum DeprecationState (ver 2.2)
  risk            TEXT NOT NULL,             -- bajo|medio|alto
  regenerable     INTEGER NOT NULL DEFAULT 0,-- 1 = se puede recrear sin pérdida (target/, caches)
  size_bytes      INTEGER,                   -- relleno por scanners de disco (NULL para code)
  cleanup_action  TEXT NOT NULL,             -- qué hace apply (texto + acción tipada en plan)
  rollback_action TEXT NOT NULL,             -- cómo revertir (git revert | restore snapshot | re-register)
  first_seen      TEXT NOT NULL,             -- ISO-8601 (primer scan que lo detectó)
  last_seen       TEXT NOT NULL,             -- ISO-8601 (último scan que lo confirmó vivo)
  deadline        TEXT,                      -- ISO-8601; vencido => doctor lo marca Warn/Error
  retention_class TEXT,                      -- enum RetentionClass (ver 5); rige TTL/rotación
  evidence_json   TEXT,                      -- JSON con prueba del scanner (líneas, hash, conteos)
  confirmed_by    TEXT,                      -- "human" cuando se aprobó un apply (alto riesgo)
  schema_version  INTEGER NOT NULL DEFAULT 3
);
CREATE INDEX IF NOT EXISTS idx_dep_state  ON deprecation_entries(state);
CREATE INDEX IF NOT EXISTS idx_dep_domain ON deprecation_entries(domain);
CREATE INDEX IF NOT EXISTS idx_dep_risk   ON deprecation_entries(risk);
```

### 2.2 `deprecation_events` (append-only, auditoría)

```sql
CREATE TABLE IF NOT EXISTS deprecation_events (
  event_id   TEXT PRIMARY KEY,              -- uuid/ulid
  entry_id   TEXT NOT NULL REFERENCES deprecation_entries(id),
  kind       TEXT NOT NULL,                 -- discovered|state_change|planned|applied|restored|
                                            --   skipped|error|deadline_breached
  from_state TEXT,                          -- estado previo (NULL en discovered)
  to_state   TEXT,                          -- estado nuevo
  trace_id   TEXT,                          -- correlación con OLA M (SPEC-CONTROL-PLANE §4)
  actor      TEXT NOT NULL,                 -- "scan"|"plan"|"apply"|"restore"|"human"
  snapshot_ref TEXT,                        -- ruta del snapshot creado antes del delete (si aplica)
  detail_json TEXT,                         -- payload (bytes liberados, archivos tocados, error)
  created_at TEXT NOT NULL                  -- ISO-8601
);
CREATE INDEX IF NOT EXISTS idx_depev_entry ON deprecation_events(entry_id);
CREATE INDEX IF NOT EXISTS idx_depev_trace ON deprecation_events(trace_id);
```

Append-only: nunca `UPDATE`/`DELETE`; `deprecation_entries` muta de estado pero cada transición deja
un `deprecation_events` con `from_state`/`to_state`. Reconstrucción del historial = `SELECT … ORDER BY created_at`.

### 2.3 Enums (`str_enum!`, mismo patrón que `memory/model.rs`)

```
DeprecationState  = active | deprecated | shadowed | quarantined | pending_delete | deleted | restored
DeprecationDomain = rust_dead_exports | sqlite_tablas_sin_lector | qdrant_collections_legacy |
                    hooks_fuera_de_sot | ui_tabs_sin_backend | logs_caches_backups |
                    competing_stores | docs_stale | disk_footprint
RetentionClass    = permanent | protected | ttl_<n>d | rotate_keep_<n> | audit
```

Mapeo seed → estado canónico: los estados del registry (`active/deprecated/shadowed/quarantined/
pending_delete/deleted/restored` de `DEPRECATION-REGISTRY` §leyenda) son **idénticos** a `DeprecationState`:
la siembra es 1:1 sin traducción.

---

## 3. Scanners read-only por dominio

Cada scanner es una función pura `scan(repo_root) -> Vec<DeprecationEntry>` que **solo lee** y produce
candidatos con `evidence_json`. Nunca muta. `last_seen` se refresca; un artefacto del seed que ya no
se detecta NO se borra: se marca con evento `state_change` (→ posible `restored`/`deleted` confirmado).

| Scanner | Dominio | Qué detecta | Evidencia (evidence_json) | Seed (DR-…) |
|---|---|---|---|---|
| `rust_dead_exports` | rust_dead_exports | módulos/comandos `pub` sin caller ni registro en `invoke_handler`; glob re-exports que ocultan comandos no registrados | def-vs-registered diff, ruta+línea | DR-14..21 |
| `sqlite_tablas_sin_lector` | sqlite_tablas_sin_lector | tablas escritas pero sin lector (`kg_entities`, `kg_relations`) | nombre tabla, writers, readers=0 | DR-20 |
| `qdrant_collections_legacy` | qdrant_collections_legacy | colecciones legacy/dim incompatible (`ultron_sessions` 384d; vector dim ≠ 1024) | nombre, dim, points, `in_sync` | DR-03 |
| `hooks_fuera_de_sot` | hooks_fuera_de_sot | hooks en `~/.claude/scripts` no versionados; duplicados homónimos vs `~/.ultron/hooks/scripts`; hooks en disco fuera de settings.json | par de rutas, hash, registrado(bool) | DR-25..27 |
| `ui_tabs_sin_backend` | ui_tabs_sin_backend | componentes React que invocan comandos Tauri inexistentes; listeners de eventos no emitidos | componente, comando/evento, existe(bool) | DR-10,11,19 |
| `logs_caches_backups` | logs_caches_backups | logs sin TTL, caches duplicadas, backups sin rotación, cruft `.tmpevals*` | ruta, bytes, antigüedad, dup_of | DR-38..42 |
| `competing_stores` | competing_stores | escritores fuera de SoT vivos (Mem0, Qdrant directo, ECC) | writer, target_store, settings.json línea | DR-01,02,04,05,06 |
| `docs_stale` | docs_stale | docs que contradicen el estado reconciliado | doc, claim stale | DR-28..37 |

Contrato de scanners:
- **Idempotentes**: dos `scan` consecutivos sin cambios producen el mismo conjunto (mismo `id`),
  refrescan `last_seen`, NO duplican filas.
- **Sin red salvo Qdrant**: `qdrant_collections_legacy` consulta `:6333` en read-only (GET collections).
- **Sin secretos**: `evidence_json` nunca contiene tokens; `competing_stores` detecta el **patrón**
  `Bearer ${GITHUB_TOKEN}` / token literal pero **nunca transcribe el valor** (regla SoT de seguridad).
- **Solo lectura del SoT**: leen `brain.db` para cross-check (p.ej. tablas sin lector) sin escribir.

---

## 4. Comandos CLI

Sidecar `ultron maintenance` (subcomando del binario `ultron-memory.exe` o un sidecar hermano
`ultron-maintenance.exe`; reusa el conector SQLite existente). **`--dry-run` es el modo por defecto**
de todo comando con efecto; mutar requiere `apply --confirm` explícito.

### 4.1 Lifecycle (artefactos)

```
ultron maintenance scan [--domain <D>] [--json]
  Read-only. Ejecuta todos los scanners (o el dominio dado), upserta deprecation_entries
  (first_seen/last_seen/evidence), emite eventos `discovered`/`state_change`. NO muta disco/código.
  Salida: tabla por dominio {id, artifact, state, risk, regenerable, size}.

ultron maintenance plan [--domain <D>] [--max-risk <bajo|medio|alto>] [--json]
  Read-only. A partir del estado actual de deprecation_entries, produce un MaintenancePlan:
  lista ordenada de acciones tipadas (DeleteFile, DropTable, DropCollection, UnregisterHook,
  RemoveComponent, RemoveCommand, RotateBackups, PruneLogs, DedupeCache) con:
    - bytes/efecto estimado, rollback_action, snapshot requerido (sí/no),
    - "blast radius" (qué eval/reconcile/hook/startup podría tocar),
    - gating: acciones risk=alto -> requieren --confirm + confirmed_by=human.
  NO ejecuta nada. Emite eventos `planned`.

ultron maintenance apply --confirm [--domain <D>] [--max-risk <...>] [--only <id,id>]
  ÚNICO comando que muta. Sin --confirm => error (rechaza). Por cada acción:
    1. snapshot/rollback preparado (ver 6) ANTES de tocar nada,
    2. ejecuta la acción,
    3. verifica post-condición (archivo ausente / tabla droppeada / hook desregistrado),
    4. corre smoke gate (ver 7); si falla => rollback automático de esa acción + evento `error`,
    5. estado -> deleted|restored; evento `applied` con trace_id, snapshot_ref, bytes liberados.
  Idempotente: re-apply de un id ya `deleted` es no-op (evento `skipped`).

ultron maintenance restore <entry_id|snapshot_ref> [--confirm]
  Revierte un apply: restaura desde snapshot_ref o ejecuta rollback_action (git revert /
  re-register hook / re-create collection desde snapshot Qdrant). Estado -> restored.
  Emite evento `restored`. Idempotente.

ultron maintenance explain <entry_id> [--json]
  Read-only. Vuelca: artefacto, dominio, por qué deprecado, replacement, evidencia del scanner,
  historial completo de deprecation_events, plan de cleanup y rollback, blast radius.
```

### 4.2 Disk (footprint)

```
ultron disk scan [--deep] [--json]
  Read-only. Mide top dirs / top files / target/ / caches / logs / backups / model caches / qdrant /
  sqlite (reusa el método de DISK-FOOTPRINT). Upserta entries dominio=disk_footprint con size_bytes.
  --deep = walk completo (job background, p95 puede exceder el resumen).

ultron disk plan [--level 1|2|3] [--json]
  Read-only. Plan de liberación por niveles (ver 8). Nivel por defecto = 1 (bajo riesgo).
  Produce: GB recuperables, coste (rebuild parcial/total), confirmación requerida, NO-TOCAR.

ultron disk apply --confirm [--level 1|2|3]
  ÚNICO comando que borra disco. Nivel 1 sin --confirm => sigue exigiendo --confirm (borra archivos).
  Niveles 2/3 => --confirm + confirmed_by=human obligatorio. Mismo pipeline snapshot->act->verify->smoke.
```

Acceptance de superficie CLI: `scan/plan/explain/disk scan/disk plan` **nunca** mutan (test: hash de
disco y `brain.db.deprecation_entries` mutables solo por `apply`). `apply`/`disk apply` **rechazan**
sin `--confirm` (exit code ≠ 0, sin efecto).

---

## 5. Retention policies

Cada entry de dominio `logs_caches_backups`/`disk_footprint` lleva `retention_class`:

| retention_class | Política | Aplica a |
|---|---|---|
| `permanent` | nunca se borra | `brain.db`, `qdrant_storage`, sidecars, `qdrant-native`, model cache **canónica** |
| `protected` | requiere `--confirm` + human; nunca en apply automático | backup `pre-v14.9` (899 MB), snapshots de auditoría |
| `ttl_<n>d` | borrar si `mtime` > n días | logs rotados, `mem0.jsonl`, `stop-memory-sync.log` |
| `rotate_keep_<n>` | conservar N más recientes, borrar resto | `backups/` (generacional) |
| `audit` | conservar, comprimible, nunca borrar contenido | `deprecation_events`, eval reports |

Regla de secretos en retención: antes de comprimir/rotar logs (`mem0.jsonl`, `stop-memory-sync.log`)
el manager corre el secret-detector (reuso de `redaction.rs` write-path) y **bloquea** la rotación a
un destino legible si detecta material sensible no redactado.

### 5.1 `FASTEMBED_CACHE_PATH` canónico (dedupe de las 6 copias)

Causa raíz (DISK-FOOTPRINT §2): el modelo E5 se descarga al CWD del proceso → 6 copias de
`.fastembed_cache` (~5.7 GB, ~3.5 GB recuperables). Contrato:

1. **Ruta canónica única**: `FASTEMBED_CACHE_PATH = C:\Users\USER\.ultron\.fastembed_cache`
   (la de 2.22 GB marcada CANONICA en el seed). Se fija en el entorno de **todo** proceso que embebe
   (app Tauri, sidecars `ultron-memory`/`ultron-embed`, hooks Node que invocan el sidecar).
2. `disk plan --level 2` propone: verificar hash del modelo en la canónica == hash de cada duplicada;
   solo entonces marcar las 5 duplicadas `pending_delete`.
3. `disk apply --confirm --level 2` borra las duplicadas tras hash-match; entry `retention_class=ttl`/
   regenerable=1 (el runtime la recrea, coste = primer embed más lento, documentado).
4. Acceptance: tras apply, `reconcile --check` sigue `in_sync=true`, `eval` sigue `recall@8≈0.917`,
   y un nuevo embed usa la canónica (no recrea duplicadas).

---

## 6. Snapshot / rollback (reversibilidad obligatoria)

Por tipo de artefacto, `apply` prepara el rollback **antes** de mutar:

| Tipo | Snapshot pre-delete | rollback_action |
|---|---|---|
| `sqlite_table` (drop) | `VACUUM INTO '<brain.db>.snap-<ts>'` (copia consistente completa) | restaurar tabla desde snap o re-`apply_schema` |
| `qdrant_collection` (drop) | snapshot Qdrant (`POST /collections/<c>/snapshots`) | recrear colección desde snapshot |
| `disk_file`/`cache`/`backup` | mover a `backups/.maintenance-trash/<ts>/` (no `rm` directo) | mover de vuelta |
| `hook` (unregister) | copia del `settings.json` a `backups/config-<ts>-preMaint/` + del `.js` | re-registrar entrada + restaurar `.js` |
| `rust_command`/`react_component`/`ts_type` | **NO** los toca el manager: emite un plan/parche para revisión humana (git revert es el rollback) | `git revert` |

Regla: código (Rust/TS/React) **no se borra desde el manager** — el manager lo marca y produce el
plan; el borrado real es un commit humano reversible por git. El manager solo ejecuta deletes de
datos/disco/config con snapshot. Esto respeta "NO toques código" y mantiene todo reversible.

`snapshot_ref` se persiste en `deprecation_events.snapshot_ref`; `restore` lo consume.

---

## 7. Smoke gate post-apply (no romper el sistema)

Tras cada acción mutante, `apply` corre un smoke gate y revierte si falla:

1. `ultron-memory reconcile --check` → `in_sync=true`, 943=943 (o el conteo vigente).
2. `ultron-memory eval` → `recall@8 ≥ 0.90` (baseline 0.917) y `secret_leak=0 / stale_leak=0`.
3. `doctor --json` (SPEC-CONTROL-PLANE) → `max_severity != Error`.
4. Hooks/startup smoke: settings.json válido (parseable) y los hooks `memory-*` resuelven su sidecar.

Si cualquier check pasa de verde a Error por la acción → rollback automático de esa acción + evento
`error` con detalle. El apply continúa con las acciones restantes (no aborta todo el plan salvo
`--fail-fast`).

---

## 8. Niveles de liberación de disco (de DISK-FOOTPRINT §5)

| Nivel | Qué | GB aprox | Coste | Confirmación |
|---|---|---:|---|---|
| 1 (bajo) | logs antiguos + TTL; cruft `.tmpevals*` | ~0.04 | nulo | `--confirm` |
| 2 (rebuild parcial/dup) | `target/debug/incremental` (5.51) + `.fastembed_cache` dup (~3.5) + `.uv-cache-rescue` antiguos (0.78) | ~9.8 | recompilación incremental; 1er embed más lento | `--confirm` + human |
| 3 (rebuild pesado/datos) | `target/debug` (23.32) + restos `release` + backups grandes | ~24+ | recompilación completa; pérdida de snapshots no-protected | `--confirm` + human (muy fuerte) |

NO-TOCAR (hard guard en código, no solo doc): `qdrant_storage`, `brain.db`, `workflow-runs.db`,
`bin/`, `qdrant-native`, model cache canónica, backups `protected`. Un `disk apply` que intente
tocarlos es rechazado con error aunque venga con `--confirm`.

---

## 9. Siembra (seed → registry persistente)

Comando de bootstrap `ultron maintenance seed [--from <doc>]`:
- Lee `DEPRECATION-REGISTRY-2026-06-04.md` (42 entries, ids `DR-01..DR-42`) y
  `DISK-FOOTPRINT-2026-06-04.md` (categorías de disco) y hace **upsert** a `deprecation_entries`
  con `first_seen=now`, `state` = el del doc, `actor=seed`.
- Idempotente: re-seed no duplica (clave `id`); refresca solo campos del doc, preserva eventos.
- Tras el seed, los **scanners** reconcilian: confirman cuáles siguen vivos (`last_seen`), cuáles ya
  no existen (candidatos a `restored`/`deleted` confirmado, p.ej. DR-02/DR-07 ya desregistrados en
  `d3a16ff`/`cbb2d5c`).
- Los 3 de **alto riesgo** del seed (DR-01 stop-compress writer, DR-02 mem0-sync, DR-03 colección
  `ultron_sessions`) entran como `shadowed`/`active` y **nunca** llegan a `apply` sin `confirmed_by=human`.

---

## 10. Acceptance medible

| # | Criterio | Verificación |
|---|---|---|
| A1 | Migración 2→3 aditiva e idempotente | `apply_schema` dos veces deja `user_version=3`, tablas presentes, `memory_*` intactas; `reconcile --check` verde antes/después |
| A2 | `scan` idempotente | dos `scan` seguidos → mismo nº de filas, `last_seen` refrescado, 0 duplicados |
| A3 | Scanners read-only | hash del repo + hash de `deprecation_entries` no cambian tras `scan`/`plan`/`explain`/`disk scan`/`disk plan` |
| A4 | `apply`/`disk apply` exigen `--confirm` | sin flag → exit≠0, 0 mutaciones (test) |
| A5 | Reversibilidad | todo `apply` con delete crea `snapshot_ref`; `restore` recupera al estado previo (round-trip test sobre una tabla/colección/cache de prueba) |
| A6 | No rompe el sistema | tras `disk apply --level 1/2`: `reconcile --check` in_sync, `eval` recall@8≥0.90 & leaks=0, `doctor` sin Error |
| A7 | Dedupe fastembed | tras fijar `FASTEMBED_CACHE_PATH` + `disk apply --level 2`: 1 sola copia canónica, embed nuevo no recrea duplicadas, ~3.5 GB liberados |
| A8 | Auditoría completa | cada delete tiene ≥1 `deprecation_events` con `trace_id`, `actor`, `snapshot_ref`; `explain` reconstruye el historial |
| A9 | Sin secretos | `evidence_json` y logs del manager no contienen tokens (grep de patrones de secreto = 0); rotación de logs pasa por secret-detector |
| A10 | Seed 1:1 | `seed` carga 42 entries con estados del doc; re-seed no duplica |
| A11 | Guard NO-TOCAR | `disk apply --confirm` contra `qdrant_storage`/`brain.db`/canónica → rechazado |
| A12 | Deadlines | `doctor` reporta entries con `deadline` vencido como Warn/Error (handoff a SPEC-CONTROL-PLANE) |

---

## 11. Rollback global del propio manager

- La migración 2→3 es aditiva: revertir = `DROP TABLE deprecation_entries, deprecation_events` (no
  toca memoria) o dejar las tablas inertes; el sistema funciona sin el manager.
- Cada `apply` es individualmente reversible (§6) vía `restore`.
- Si el manager se retira, el seed (`DEPRECATION-REGISTRY` / `DISK-FOOTPRINT`) sigue siendo la fuente
  documental; no se pierde estado porque `deprecation_events` es append-only y auditable.

---

## 12. Orden de implementación (OLA K → L)

1. **K-1** Migración 2→3 + enums + `apply_schema` (tests A1).
2. **K-2** `seed` desde los dos docs (A10) + reconciliación con scanners read-only (A2/A3).
3. **K-3** Scanners por dominio (tabla §3), empezando por `competing_stores`/`qdrant_collections_legacy`
   (cierran los 3 de alto riesgo en estado, sin apply).
4. **K-4** `plan` + `explain` (read-only) (A12 parcial).
5. **K-5** `apply --confirm` + snapshot/rollback (§6) + smoke gate (§7) (A4/A5/A6/A8).
6. **L-1** `disk scan/plan/apply` + niveles (§8) (A6).
7. **L-2** `FASTEMBED_CACHE_PATH` canónico + dedupe (§5.1) (A7).
8. **L-3** Retention policies + rotación con secret-detector (§5) (A9) + guard NO-TOCAR (A11).
