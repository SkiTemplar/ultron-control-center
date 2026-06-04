# CLEANUP PLAN — ULTRON repo (`~/.ultron`) — 2026-06-04

> **NADA SE HA BORRADO.** Este documento es solo inventario + propuesta para
> publicar el repo en **GitHub PRIVADO**. Toda ejecución queda diferida a una
> decisión explícita de USER. El `.gitignore` real NO se ha tocado; la
> propuesta vive en `~/.ultron/.gitignore.proposed`.

Repo: `C:/Users/USER/.ultron`
Rama: `fullize-2026-05-30`
`.git` actual: **160 MB** (arrastra el sidecar binario histórico)

Leyenda de acción:
- **CONSERVAR** — se queda versionado / en disco tal cual.
- **ARCHIVAR** — mover a `cockpit/memory-rework/_archive/` (o `archive/`), fuera del flujo activo pero recuperable. Sigue en git si ya estaba trackeado.
- **BORRAR** — candidato a eliminación física (basura/temporales/regenerable). Requiere OK de USER.

---

## 0) Resumen ejecutivo (lo que más importa para publicar)

1. **Hallazgo crítico (gitignore):** tres ficheros de validación en
   `cockpit/memory-rework/` **NO están cubiertos** por el `.gitignore` actual:
   - `.codex-validation.txt` (28 KB)
   - `.gemini-validation.txt` (22 KB)
   - `.validation-package.md` (5 KB)

   Hoy están **untracked** (no se han commiteado), así que no hay fuga todavía,
   pero un `git add -A` los subiría. La `.gitignore.proposed` ya los cubre.

2. **Binarios `bin/` (285 MB en disco):** el sidecar `ultron-memory.exe` y sus
   **8 backups `*.bak-pre-*`** (~240 MB sumados) están **untracked y ya ignorados**
   correctamente. No entran en git. Son **BORRAR** en disco (regenerables con
   `cargo build` / `scripts/install-sidecars.ps1`) salvo el `.exe` activo.

3. **Caches gigantes en disco (no en git):** `.fastembed_cache/` raíz = **2.3 GB**,
   `qdrant_storage/` = **393 MB**, `backups/` = **928 MB**. Ya ignorados; solo
   consumen disco. **BORRAR/ARCHIVAR** a criterio (regenerables).

4. **Markdowns de planning en `memory-rework/` (19 trackeados):** varios están
   **superseded** por los docs de cierre (`STATE-RECONCILIATION`, `INFORME-CIERRE-100`).
   Propuesta: **ARCHIVAR** los pre-reconciliación, **CONSERVAR** los de cierre.

5. El `.gitignore` real **ya es muy completo** (300 líneas). La propuesta solo
   **añade** las 3 entradas de validación + endurece patrones; no quita nada.

---

## 1) Markdowns stale / duplicados / desordenados

### 1.A — `cockpit/memory-rework/` (raíz del rework) — TODOS trackeados

| Fichero | Fecha | Estado | Acción | Motivo |
|---|---|---|---|---|
| `INFORME-CIERRE-100-2026-06-04.md` | 06-04 13:03 | Cierre | **CONSERVAR** | Informe final de la sesión (15 secciones), SoT de cierre. |
| `STATE-RECONCILIATION-2026-06-04.md` | 06-04 02:59 | Cierre | **CONSERVAR** | Verdad reconciliada que invalida los docs viejos. Referencia viva. |
| `CONTRACTS-2026-06-04.md` | 06-04 12:32 | Vigente | **CONSERVAR** | Contratos de interfaz actuales. |
| `DEPRECATION-REGISTRY-2026-06-04.md` | 06-04 12:44 | Vigente | **CONSERVAR** | Registro de deprecaciones (42). Útil para limpieza futura. |
| `DISK-FOOTPRINT-2026-06-04.md` | 06-04 12:45 | Vigente | **CONSERVAR** | Inventario de footprint (40 GB). Base de este plan. |
| `MEMORY-SYSTEM-SPEC-FOR-REVIEW.md` | 06-04 13:59 | Vigente | **CONSERVAR** | Spec autocontenida para revisión externa (la más reciente). |
| `STATUS-SISTEMAS-2026-06-04.md` | 06-04 10:24 | Vigente | **CONSERVAR** | Estado por subsistema, post-batch HEAD `823ed67`. |
| `SPECS-SISTEMA-2026-06-04.md` | 06-04 03:02 | Solapa con MEMORY-SYSTEM-SPEC | **ARCHIVAR** | Spec para 2ª IA; redundante con `MEMORY-SYSTEM-SPEC-FOR-REVIEW.md` (más nueva). |
| `STATE` → `STATUS.md` | 06-03 20:00 | Pre-reconciliación | **ARCHIVAR** | "Biblia de reanudación" superada por `STATE-RECONCILIATION` + `STATUS-SISTEMAS`. |
| `PLAN.md` | 06-04 03:02 | Reconciliado-encima | **ARCHIVAR** | Marcado `[RECONCILIADO]` en su cabecera; histórico. |
| `MASTER-PLAN-CONSOLIDADO-2026-06-03.md` | 06-04 03:02 | Pre-removal | **ARCHIVAR** | Cabecera dice "doc de 2026-06-03, pre-removal". Superado. |
| `MASTER-PROMPT.md` | 06-03 11:32 | Prompt fuente | **ARCHIVAR** | Prompt de arranque del rework; histórico, no doc de producto. |
| `DIAGNOSIS.md` | 06-04 03:02 | Reconciliado-encima | **ARCHIVAR** | Marcado `[RECONCILIADO]`; diagnóstico Fase 1 ya consumido. |
| `NIGHT-RUN-2026-06-04.md` | 06-04 04:12 | Log de run | **ARCHIVAR** | Bitácora de la corrida nocturna; valor histórico, no de producto. |

Duplicación detectada (consolidar antes de publicar, opcional):
- **Specs solapadas:** `SPECS-SISTEMA-2026-06-04.md` vs `MEMORY-SYSTEM-SPEC-FOR-REVIEW.md` → quedarse con la 2ª.
- **Estado solapado:** `STATUS.md` vs `STATUS-SISTEMAS-2026-06-04.md` vs `STATE-RECONCILIATION` → la trinidad describe el mismo estado en 3 momentos; conservar los 2 nuevos, archivar `STATUS.md`.
- **Plan solapado:** `PLAN.md` + `MASTER-PLAN-CONSOLIDADO` + `MASTER-PROMPT` → todos pre-reconciliación; el plan vivo es `INFORME-CIERRE-100` + esta limpieza.

### 1.B — `cockpit/memory-rework/specs/` — trackeados

| Fichero | Acción | Motivo |
|---|---|---|
| `01-MEMORIA.md` … `07-MCPS.md`, `SPEC-CONTROL-PLANE.md`, `SPEC-MAINTENANCE-CLI.md`, `UI-BACKEND-ALIGNMENT-MAP.md`, `04-QUOTA.md` | **CONSERVAR** | Specs por subsistema vigentes (actualizadas 06-04). |
| `00-PROMPT-CONTINUACION.md` | **ARCHIVAR** | Prompt de continuación de sesión; operativo, no spec de producto. |
| `08-AUDIT-Y-PROMPT-CORRECCION-TOTAL.md` (47 KB) | **ARCHIVAR** | Prompt-auditoría consumido; histórico. |
| `09-PROMPT-MEJORA-SPECS-Y-CORRECCION-100.md` | **ARCHIVAR** | Prompt consumido; histórico. |
| `10-PROMPT-FINAL-EJECUCION-LIMPIEZA-ULTRON.md` (untracked) | **ARCHIVAR** | Es el prompt que originó esta misma limpieza; guardar como referencia. |
| `03-SKILLS-AGENTES.md`, `06-ORQUESTADOR.md` | **CONSERVAR** | Specs cortas pero vigentes. |

> Patrón: los ficheros `NN-PROMPT-*.md` son **prompts de sesión**, no documentación
> de producto. Recomendado moverlos todos a `specs/_prompts/` o a `_archive/`
> para que `specs/` quede limpio de cara a publicar.

### 1.C — `cockpit/` (raíz cockpit) — MDs

| Fichero | Acción | Motivo |
|---|---|---|
| `MASTER-PLAN-fullize-2026-05-30.md` | **ARCHIVAR** | Plan de la ola fullize anterior; superado por el rework. |
| `MASTER-PLAN-fullize-2026-06-01.md` | **ARCHIVAR** | Idem (prioridades 06-01); ya volcado en MEMORY.md. |
| `DASHBOARD.md` | **CONSERVAR** (ya gitignored) | Operativo personal; el `.gitignore` ya lo excluye. |
| `README.md`, `TUTORIAL.md` | **CONSERVAR** (ya gitignored) | Excluidos por gitignore (Control Center tiene los suyos). |
| `cleanup-report-2026-05-02.md` | **ARCHIVAR** (ya gitignored por `cleanup-report-*.md`) | Reporte de limpieza vieja; ya excluido. |
| `changelog_table.md` | CONSERVAR (ya gitignored) | Generado. |

### 1.D — Raíz del repo — MDs trackeados

| Fichero | Acción | Motivo |
|---|---|---|
| `README.md`, `README.es.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `INSTALL.md`, `SECURITY.md`, `AUTHORS.md` | **CONSERVAR** | Documentación pública estándar del repo. |
| `NEXT-SESSION-PLAN.md` | **ARCHIVAR** | Plan de "próxima sesión"; operativo, rota con el tiempo. Valorar gitignore. |
| `MEMORY.md`, `SYSTEM-MAP.md` | **CONSERVAR** (ya gitignored) | Excluidos del repo público por gitignore (datos personales). |
| `GENESIS-RELEASE.md` | **CONSERVAR** (ya gitignored) | Excluido por gitignore (doc interno de release). |

---

## 2) Temporales y basura

### 2.A — Ficheros de validación (HALLAZGO CRÍTICO — no ignorados hoy)

| Fichero | Tamaño | Tracked | Ignored | Acción |
|---|---|---|---|---|
| `cockpit/memory-rework/.codex-validation.txt` | 28 KB | NO | **NO** ⚠ | **BORRAR** + añadir a gitignore. Salida one-shot del review de Codex. |
| `cockpit/memory-rework/.gemini-validation.txt` | 22 KB | NO | **NO** ⚠ | **BORRAR** + añadir a gitignore. Salida one-shot de Gemini. |
| `cockpit/memory-rework/.validation-package.md` | 5 KB | NO | **NO** ⚠ | **ARCHIVAR** o BORRAR. Paquete enviado a las IAs externas. |

> Estos 3 son la razón nº1 para actualizar el `.gitignore` **antes** de cualquier
> `git add -A`. La propuesta los cubre con `*-validation.txt` y `.validation-package.md`.

### 2.B — Backups binarios del sidecar en `bin/` (untracked, ya ignorados)

Todos son **BORRAR** en disco (regenerables). Ya excluidos de git por `bin/*.bak-*` y `bin/*.exe`.

| Fichero | Tamaño | Acción |
|---|---|---|
| `bin/ultron-memory.exe.bak-pre-capture` | 30 MB | **BORRAR** |
| `bin/ultron-memory.exe.bak-pre-doctor-sparse` | 30 MB | **BORRAR** |
| `bin/ultron-memory.exe.bak-pre-evalwiring` | 30 MB | **BORRAR** |
| `bin/ultron-memory.exe.bak-pre-olaA-redaction` | 30 MB | **BORRAR** |
| `bin/ultron-memory.exe.bak-pre-olaB` | 30 MB | **BORRAR** |
| `bin/ultron-memory.exe.bak-pre-olaE-L0` | 30 MB | **BORRAR** |
| `bin/ultron-memory.exe.bak-pre-olaH2W4` | 30 MB | **BORRAR** |
| `bin/ultron-memory.exe.bak-pre-reviewfix` | 30 MB | **BORRAR** |
| `bin/ultron-memory.exe` (ACTIVO) | 30 MB | **CONSERVAR** en disco (runtime); NO versionar. |
| `bin/ultron-embed.exe` (ACTIVO) | 26 MB | **CONSERVAR** en disco; NO versionar. |

Total liberable solo en backups del sidecar: **~240 MB**.

### 2.C — Otros `*.bak` / `*.tmp`

| Fichero | Tracked | Ignored | Acción |
|---|---|---|---|
| `cockpit/projects.json.bak` | NO | SÍ (`*.bak`) | **BORRAR** (runtime regenerable). |
| `web/index.html.bak` | (web/ ignorado) | SÍ | **BORRAR**. |
| `backups/2026-05-04-pre-S0/*.bak`, `backups/.../*.bak` | (backups/ ignorado) | SÍ | **ARCHIVAR/BORRAR** con todo `backups/`. |

### 2.D — Logs sueltos (todos bajo dirs ya ignorados o `*.log`)

| Ruta | Ignored | Acción |
|---|---|---|
| `.tmp/*.log` (13 logs) | SÍ (`.tmp/`) | **BORRAR** (cache de sesión). |
| `logs/*.log` (auto-recall, backup, push-async, stop-memory-sync) | SÍ (`logs/`) | **BORRAR**. |
| `sessions/**/on-wake.log`, `peer-errors.log` | SÍ (`sessions/`) | **BORRAR** con `sessions/`. |
| `proxy/proxy.log` | SÍ (`/proxy/`) | **BORRAR**. |
| `.playwright-mcp/console-*.log` | SÍ (`.playwright-mcp/`) | **BORRAR**. |
| `telemetry/v14-overhaul/*.log` | SÍ (`telemetry/`) | **BORRAR**. |

### 2.E — Caches y storage pesados en disco (no en git)

| Ruta | Tamaño | Ignored | Acción | Motivo |
|---|---|---|---|---|
| `.fastembed_cache/` (raíz) | **2.3 GB** | SÍ | **BORRAR** | Modelo ONNX auto-descargable. |
| `cockpit/memory-rework/.fastembed_cache/` | — | SÍ | **BORRAR** | Cache duplicada del eval. |
| `qdrant_storage/` | **393 MB** | SÍ | **ARCHIVAR/BORRAR** | Índice vectorial regenerable desde SQLite. |
| `qdrant-native/` (binario qdrant) | **85 MB** | parcial | **CONSERVAR** binario activo; NO versionar. |
| `backups/` | **928 MB** | SÍ | **ARCHIVAR** fuera del repo | Snapshots con posibles secretos; nunca a git. |
| `.uv-cache-rescue/`, `.venv/`, `.pytest_cache/` | — | SÍ | **BORRAR** | Caches Python regenerables. |
| `C:UsersRodrigo.ultron.tmpevals*` (3 dirs con ruta mal-expandida) | — | NO ⚠ | **BORRAR** | Dirs basura de una expansión de ruta fallida (nombre literal `C:UsersRodrigo...`). No deben existir. |

> **Hallazgo:** existen 3 carpetas con nombre literal `C:UsersRodrigo.ultron.tmpevals*`
> en la raíz — artefacto de un script que no expandió `~/.ultron/.tmp/evals`.
> Son **BORRAR** (basura pura) y NO están cubiertas por el gitignore.

---

## 3) `.gitignore` propuesto

Escrito en `~/.ultron/.gitignore.proposed` (el `.gitignore` real NO se tocó).
La propuesta **parte del `.gitignore` real existente** (que ya cubre `target/`,
`node_modules/`, `brain.db`, `qdrant_storage/`, `.env`, `.fastembed_cache/`,
`*.bak*`, `dist/`, `.uv-cache-rescue/`, `bin/*.exe`, `bin/*.bak-*`) y **añade**:

1. **Ficheros de validación (gap crítico):**
   ```
   *-validation.txt
   .codex-validation.txt
   .gemini-validation.txt
   .validation-package.md
   ```
2. **Dirs basura de ruta mal-expandida:**
   ```
   /C:Users*
   ```
3. **Endurecimiento de patrones pedidos en el encargo** (clave/secretos/caches),
   por si algún día se reorganiza el árbol:
   ```
   *.key
   *.pem
   *.p12
   *.pfx
   secrets/
   **/secrets.*
   .uv-cache*
   ```
4. **brain.db** explícito también fuera de la raíz (`**/brain.db`), por si se mueve.

Diferencias netas vs `.gitignore` real: **solo añade** entradas; no elimina
ninguna regla existente. Revisar y, si OK, hacer `mv .gitignore.proposed .gitignore`.

---

## 4) Orden de ejecución sugerido (cuando USER dé OK — NO ejecutado)

1. Adoptar `.gitignore.proposed` → `.gitignore`.
2. Borrar basura segura: `bin/*.bak-pre-*`, `.tmp/*.log`, `logs/*.log`,
   `cockpit/projects.json.bak`, `C:UsersRodrigo.ultron.tmpevals*`,
   los 3 ficheros de validación.
3. Vaciar caches regenerables: `.fastembed_cache/` (raíz + memory-rework),
   `.pytest_cache/`, `.uv-cache-rescue/`.
4. Mover a `_archive/` los MD pre-reconciliación (§1.A/§1.B/§1.C).
5. (Opcional, pesado) Evaluar `git filter-repo` para purgar el sidecar binario
   del historial y bajar `.git` de 160 MB — solo si se va a publicar el historial.
6. Verificar con `git status` que nada sensible queda staged antes del primer push.

---

## 5) Checklist de seguridad pre-publicación (privado)

- [ ] `.env` confirmado ignorado (✅ ya lo está).
- [ ] 3 ficheros `*-validation*` ignorados (⚠ pendiente: adoptar propuesta).
- [ ] `backups/` fuera del repo y del historial (✅ ignorado; revisar historial).
- [ ] `bin/*.exe` y `*.bak-pre-*` no trackeados (✅).
- [ ] `qdrant_storage/`, `brain.db`, `.fastembed_cache/` ignorados (✅).
- [ ] `git log --all -- '*.env' '*.key' '*.pem'` limpio antes de push.
- [ ] Tokens reales referenciados en MEMORY (H1 `gho_`/leaked tokens) ya rotados.
