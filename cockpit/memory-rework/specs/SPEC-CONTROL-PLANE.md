# SPEC — Control Plane · doctor + trace_id + repair/rollback (OLA M)
### Autocontenido para revisión por IA externa · 2026-06-04 · HEAD `f936a66`

> **SoT = SQLite `~/.ultron/brain.db`** (943 active, 35 candidates, `schema_version=2`).
> Único escritor de memoria = `MemoryService`. El Control Plane **observa y opera** el sistema;
> NO es escritor de memoria. `doctor` es read-only; `repair`/`rollback` mutan solo bajo `--confirm`.
> **Reuse-over-rebuild**: `doctor` reusa el enum `Severity` (`Ok | Warn | Error`, ordenado, serde
> `lowercase`) y el patrón `DiagnosticReport { checks, max_severity }` ya en
> `control-center/src-tauri/src/diagnostics_native.rs:13-19`. NO se redefine Severity.
> Trazabilidad: `08-AUDIT-Y-PROMPT-CORRECCION-TOTAL.md` §2.6 (observabilidad), §2.7 (control plane),
> OLA M; esquema en `../CONTRACTS-2026-06-04.md` §10.
> **Prioridad de implementación: `doctor` + `trace_id` primero** (el resto se apoya en ellos).

---

## 1. Propósito

Operar el sistema sin adivinar: un comando de salud (`doctor`), correlación end-to-end por turno
(`trace_id`), replay de un turno, y reparación reversible (`repair`/`rollback`). Cierra los huecos
§2.6 (no había trace_id real ni replay) y §2.7 (no había control plane).

No-objetivos:
- NO es un dashboard nuevo (la UI Health consume `doctor --json`; fuera de este spec).
- NO escribe memoria; `repair` opera infra (índices, reconcile, hooks, snapshots), no contenido.
- NO duplica `Severity` ni la lógica de diagnóstico nativa existente: la **extiende**.

---

## 2. `ultron doctor [--json]` — ≥9 checks

Reusa `Severity` y la forma `Check { name, severity, detail, … }` + `Report { checks, max_severity }`
de `diagnostics_native.rs`. Cada check es una función pura `run() -> Check` (read-only, sin mutación).
`max_severity = checks.map(|c| c.severity).max()` (ord existente: `Ok < Warn < Error`).

| # | Check | Verde (Ok) | Warn | Error | Fuente |
|---|---|---|---|---|---|
| 1 | `sqlite` | `brain.db` abre, `PRAGMA integrity_check=ok`, `user_version` esperado (2/3) | WAL grande / vacuum pendiente | corrupto / no abre / schema inesperado | rusqlite |
| 2..n | `qdrant_<collection>` (**per-collection**) | colección existe, dim correcta, `points` esperado, `status=green` | dim/conteo drift menor | inalcanzable / dim incompatible | `:6333` GET (read-only) |
| — | → `ultron_memory` | 943/1024d, in_sync | — | — | |
| — | → `ultron_catalog` | 78/1024 | — | — | |
| — | → `ultron_sessions` | **WRITE-DEAD esperado**: 72/384, no debe crecer | crece (writer revivido) | — | legacy, `memory_graph.rs:201` aún la lee |
| k | `reconcile` | `ultron-memory reconcile --check` → in_sync, 943=943 | drift ≤ N | drift > N / falla | sidecar |
| k+1 | `evals` | `recall@8 ≥ 0.90` (baseline 0.917) y `secret_leak=0 / stale_leak=0` | recall en [0.85,0.90) | recall < 0.85 o leak > 0 | `ultron-memory eval` |
| k+2 | `hooks` | settings.json parseable; hooks vivos resuelven sidecar; ninguno escribe fuera de SoT | hook fuera de SoT (versionado) / duplicado homónimo | hook escritor competidor vivo | settings.json + `SPEC-MAINTENANCE-CLI` scanners |
| k+3 | `sidecars` | `ultron-memory.exe`/`ultron-embed.exe` presentes, versión esperada, ejecutables | versión drift | ausente / no ejecuta | `bin/` |
| k+4 | `mcps` | MCPs declarados resuelven; ninguno es escritor de memoria | store competidor latente (ecc memory) | escritor de memoria activo / token literal en config | `CONTRACTS` §8 |
| k+5 | `router_keys` | claves de zonas con provider disponible; sin secreto en claro en logs | zona sin fallback / key ausente opcional | zona crítica sin key | `ai_router.rs` |
| k+6 | `versions` | binario en uso == HEAD esperado (anti stale-binary) | binario más nuevo que docs | binario stale (.exe viejo) | git HEAD vs build stamp |
| k+7 | `disk` | uso < umbral; sin cruft crítico | nivel 1/2 recuperable disponible | disco crítico | `SPEC-MAINTENANCE-CLI` disk scan |
| k+8 | `deprecation_deadlines` | sin deadlines vencidos | deadline próximo | deadline vencido | `deprecation_entries.deadline` |

≥9 checks garantizados aun con 1 sola colección Qdrant (1+1+7). Con las 3 colecciones reales → 11.

Reglas:
- **Read-only**: `doctor` nunca muta `brain.db`, Qdrant ni disco.
- **Sin secretos**: `router_keys`/`mcps` reportan *presencia* y *patrón* (`Bearer ${GITHUB_TOKEN}` =
  Ok no-literal; token literal `gho_…` en config = Error) **sin transcribir** el valor. Nunca se lee
  ni imprime `~/.claude.json`/`settings.json` crudo.
- `--json` → `{ "checks": [...], "max_severity": "ok|warn|error", "generated_at": "...", "trace_id": "..." }`.
  El exit code refleja `max_severity` (0=ok, 1=warn opcional, 2=error) para gates de CI/smoke.

---

## 3. `ultron policy explain <subsystem|item>`

Read-only. Dado un subsistema (memory/hooks/router/mcp/maintenance) o un item/decisión, vuelca la
**política efectiva** que se aplicó y por qué (de los contratos `CONTRACTS-2026-06-04.md`):
- memoria: injection_policy, sensitivity gate, scope/vault, source_trust → destino (active/candidate/quarantine).
- router: ZonePolicy efectiva (privacy, candidates, selector, circuit breaker) para una zona.
- hooks: HookManifest (writer_path, failure_policy, writes_memory).
- mcp: McpPolicy (classification, allowlist, writes_memory).
- maintenance: estado/retention/rollback de un `deprecation_entries.id`.

Salida explica la **regla aplicada** y la **evidencia**, no solo el valor. Útil para auditar "por qué
este item no se inyectó" o "por qué esta zona fue a local_only".

---

## 4. `trace_id` end-to-end (migración aditiva 2→3)

### 4.1 Esquema

Migración **aditiva** `schema_version 2 → 3` (coordinada con `SPEC-MAINTENANCE-CLI` §2, mismo bump;
`apply_schema` idempotente). Dos cambios, ninguno destructivo:

```sql
-- (a) columna aditiva en memory_events (NULL para filas históricas)
ALTER TABLE memory_events ADD COLUMN trace_id TEXT;   -- idempotente: guard "columna ya existe"
CREATE INDEX IF NOT EXISTS idx_memev_trace ON memory_events(trace_id);

-- (b) tabla nueva: spans del turno (un trace_id = un turno usuario)
CREATE TABLE IF NOT EXISTS trace_events (
  span_id     TEXT PRIMARY KEY,        -- ulid
  trace_id    TEXT NOT NULL,           -- correlación del turno
  parent_span TEXT,                    -- árbol de spans (NULL = raíz)
  stage       TEXT NOT NULL,           -- enum TraceStage (4.2)
  component   TEXT NOT NULL,           -- "hook:memory-orchestrate" | "orchestrator" | "recall" |
                                       --   "router:zone-x" | "memory_event" | "maintenance"
  status      TEXT NOT NULL,           -- ok | error
  error_kind  TEXT,                    -- taxonomy (4.3); NULL si ok
  detail_json TEXT,                    -- payload acotado (NO secretos; query hash, no query cruda si sensible)
  started_at  TEXT NOT NULL,           -- ISO-8601
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_trev_trace ON trace_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_trev_stage ON trace_events(stage);
```

`memory_events.trace_id` enlaza cada evento de memoria (Retrieved/Created/…) con el turno que lo
originó. Filas históricas quedan con `trace_id=NULL` (válido; no se reescriben).

### 4.2 Propagación (hook → orchestrator → recall → router → memory_event)

```
TraceStage = hook | orchestrate | recall | route | act | memory_event
```

1. **Hook** (UserPromptSubmit: `routing-dispatcher` / `memory-orchestrate`) **genera** el `trace_id`
   (ulid) al inicio del turno y lo emite como primer `trace_events` span (`stage=hook`).
2. Lo **propaga** al sidecar/orchestrator vía argumento explícito (`--trace-id <id>`) o variable de
   entorno del proceso del turno; el orchestrator abre span `stage=orchestrate` con `parent_span`.
3. **recall** (`build_trace`/`assemble_pack`) abre `stage=recall`; cada `Retrieved` que persiste a
   `memory_events` **lleva el mismo `trace_id`**.
4. **router** (`ai_router::route`) abre `stage=route` (provider/model elegido, fallback, latencia).
5. Cualquier escritura de candidate/edit resultante abre `stage=memory_event` y estampa `trace_id` en
   la fila `memory_events`.

Contrato: **un turno = un `trace_id`**; todo span y todo `memory_event` del turno comparten ese id.
Propagación aditiva: si un componente no lo recibe, usa `NULL` (degradación elegante, no rompe).

### 4.3 Taxonomy de errores (de `CONTRACTS` §10)

```
provider_error | schema_error | timeout | policy_block | index_stale |
corrupt_memory | secret_block
```

`trace_events.error_kind` usa esta taxonomy; `doctor` y `replay` la agregan por `trace_id`.

---

## 5. `ultron trace replay <trace_id> [--json]`

Read-only. Dado un `trace_id`, reconstruye el turno:
- timeline de `trace_events` (hook → orchestrate → recall → route → memory_event) con duraciones,
- **qué contexto se inyectó y por qué**: items del recall pack (ids, score, razón) y descartados
  (gate sensitivity, scope, budget) — reusa la lógica `recall_inspect` (why-this-memory),
- decisión de router (provider/model, fallback, error_kind si lo hubo),
- `memory_events` estampados con ese `trace_id`.

Acceptance: para un turno reciente, `replay` reproduce el pack inyectado y la decisión de routing sin
re-ejecutar el turno (solo lectura de `trace_events` + `memory_events` + items).

---

## 6. `ultron repair` / `ultron rollback` (reversible, `--confirm`)

`repair` opera **infra**, nunca contenido de memoria. Cada acción es individualmente reversible y
crea snapshot antes de mutar.

| Acción `repair` | Qué hace | Snapshot pre | Rollback |
|---|---|---|---|
| `--reindex` | `reindex_all` Qdrant desde SQLite (índice reconstruible) | n/a (regenerable) | re-reindex |
| `--reconcile` | re-sincroniza SQLite↔Qdrant (drift de §2 check) | snapshot Qdrant | restore snapshot |
| `--vacuum` | `VACUUM` / `VACUUM INTO` snapshot de `brain.db` | la propia copia VACUUM INTO | restore copia |
| `--hooks` | re-registra hooks `memory-*` a SoT correcta (settings.json) | copia settings.json | restaurar copia |
| `--fastembed-canon` | fija `FASTEMBED_CACHE_PATH` canónico (delega en `SPEC-MAINTENANCE-CLI` §5.1) | — | — |

```
ultron repair <action> --confirm      # sin --confirm => dry-run que describe el plan
ultron rollback <snapshot_ref> --confirm
```

`snapshot_ref` se crea con **`VACUUM INTO '<brain.db>.snap-<ts>'`** (copia consistente y completa de
SQLite) o snapshot Qdrant; `rollback` restaura desde él. Todo `repair`/`rollback` emite `trace_events`
+ (si toca un artefacto deprecado) `deprecation_events`, ambos con `trace_id`.

Smoke gate post-repair (idéntico a `SPEC-MAINTENANCE-CLI` §7): `reconcile --check` + `eval` (recall@8
≥0.90, leaks=0) + `doctor` sin Error. Si una acción empeora la salud → rollback automático.

---

## 7. Acceptance medible

| # | Criterio | Verificación |
|---|---|---|
| A1 | `doctor` ≥9 checks, reusa Severity | `doctor --json` lista ≥9 checks; tipo `severity ∈ {ok,warn,error}`; `max_severity` = max real |
| A2 | Per-collection | hay un check por colección Qdrant viva (ultron_memory/catalog/sessions) |
| A3 | `doctor` read-only | hash de `brain.db`+Qdrant points+disco no cambian tras `doctor` |
| A4 | Sin secretos | `doctor`/`policy explain`/`replay` no imprimen tokens; token literal en config → Error sin transcribir el valor; `~/.claude.json` nunca volcado |
| A5 | Migración 2→3 aditiva idempotente | `apply_schema` x2 → `user_version=3`, `memory_events.trace_id` existe, `trace_events` existe, filas históricas intactas; `reconcile --check` verde antes/después |
| A6 | trace_id 1-por-turno | un turno produce 1 `trace_id` compartido por todos sus `trace_events` y `memory_events` (test e2e con hook → recall → memory_event) |
| A7 | Degradación elegante | si un componente no recibe trace_id, escribe `NULL` y NO falla el turno |
| A8 | `replay` fiel | `replay <trace_id>` reproduce pack inyectado + descartados + decisión router sin re-ejecutar |
| A9 | `repair`/`rollback` reversibles | round-trip: `repair --reconcile --confirm` tras introducir drift → in_sync; `rollback` desde snapshot restaura estado previo |
| A10 | Smoke gate | toda acción `repair` deja `reconcile`/`eval`/`doctor` no-Error o auto-revierte |
| A11 | `--confirm` obligatorio | `repair`/`rollback` sin `--confirm` → dry-run, 0 mutaciones |
| A12 | Exit codes | `doctor` exit refleja `max_severity` (0/1/2) para gates de CI |

---

## 8. Rollback global del Control Plane

- Migración 2→3 aditiva: revertir = ignorar/`DROP TABLE trace_events` y dejar `memory_events.trace_id`
  inerte (columna nullable; no rompe lecturas existentes). El sistema funciona sin trace_id.
- `doctor`/`policy explain`/`trace replay` son read-only: retirarlos no deja estado.
- `repair`/`rollback` son individualmente reversibles vía `snapshot_ref` (VACUUM INTO / snapshot Qdrant).

---

## 9. Orden de implementación (OLA M, prioridad doctor + trace_id)

1. **M-1 (PRIORIDAD)** `doctor [--json]` reusando `Severity`/`DiagnosticReport` (A1/A2/A3/A4/A12).
   Empezar por sqlite + qdrant-per-collection + reconcile + evals (los 4 de mayor valor).
2. **M-2 (PRIORIDAD)** Migración 2→3: `memory_events.trace_id` + `trace_events` + enums (A5).
3. **M-3** Propagación trace_id hook → orchestrator → recall → router → memory_event (A6/A7).
4. **M-4** `trace replay` reusando `recall_inspect` (A8).
5. **M-5** `policy explain` (lee `CONTRACTS` efectivos).
6. **M-6** `repair`/`rollback` + snapshot `VACUUM INTO`/Qdrant + smoke gate (A9/A10/A11).
7. **M-7** Checks restantes de `doctor` (hooks/sidecars/mcps/router_keys/versions/disk/deadlines) que
   reusan scanners de `SPEC-MAINTENANCE-CLI` y `deprecation_entries`.
