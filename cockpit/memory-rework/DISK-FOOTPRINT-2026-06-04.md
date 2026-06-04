# DISK FOOTPRINT — ULTRON `.ultron` ~40 GB — 2026-06-04

> OLA L (fase analisis). Medicion real `Get-ChildItem -Recurse | Measure-Object Length` sobre
> `C:\Users\USER\.ultron`. NINGUNA limpieza ejecutada: este doc define categorias, niveles de
> riesgo y un plan dry-run. Acceptance 08-AUDIT 3.9: explicar los ~40 GB sin inspeccion manual y
> proponer liberacion por niveles sin tocar datos canonicos.

## 1. Top-level por tamano

| Ruta | GB | Categoria | Recuperable |
|---|---:|---|---|
| `control-center` | 34.11 | (contenedor) | ver desglose |
| -> `src-tauri/target/debug` | 23.32 | rust_target_debug | nivel 3 (rebuild pesado) |
| -> `src-tauri/target/release` | 7.37 | rust_target_release | nivel 3 (conservar binario en uso) |
| -> `src-tauri/target/debug/incremental` | 5.51 | rust_incremental | **nivel 2** (rebuild parcial) |
| `.fastembed_cache` (x6, ver 2) | ~5.70 | model_cache | **nivel 2** (~3.5 GB dup) |
| `backups` | 0.90 | backups | nivel 3 (rotacion) |
| `.venv` | 0.87 | python_env | nivel 2 (si no se usa) |
| `.uv-cache-rescue` | 0.78 | uv_cache | **nivel 2** (archives antiguos) |
| `qdrant_storage` | 0.38 | qdrant | **NO TOCAR** (datos vectoriales) |
| `instructions` | 0.12 | docs/data | no tocar |
| `qdrant-native` | 0.08 | binario qdrant | no tocar |
| `bin` | 0.05 | sidecars (ultron-memory/embed) | no tocar |
| `logs` | 0.02 | logs | **nivel 1** (rotacion/TTL) |
| brain.db | ~0.002 | sqlite (SoT) | **NO TOCAR** |

Total estimado `.ultron` ~= **39.6 GB**. Causa principal confirmada: `target/` (36.2 GB regenerable).

## 2. Caches de modelo `.fastembed_cache` (DUPLICACION x6)

| Ruta | GB | Veredicto |
|---|---:|---|
| `~/.ultron/.fastembed_cache` | 2.22 | candidata a CANONICA |
| `~/.ultron/control-center/src-tauri/.fastembed_cache` | 2.22 | dup completo |
| `~/.ultron/control-center/.fastembed_cache` | 0.91 | parcial |
| `~/.ultron/control-center/src-tauri/src/.fastembed_cache` | 0.12 | parcial |
| `~/.ultron/control-center/src-tauri/target/release/.fastembed_cache` | 0.12 | parcial |
| `~/.ultron/instructions/mcps/.fastembed_cache` | 0.12 | parcial |

Causa: el modelo E5 se descarga al CWD del proceso que lo invoca (sin `FASTEMBED_CACHE_PATH` canonico).
**Accion (nivel 2)**: fijar `FASTEMBED_CACHE_PATH` a una ruta unica, verificar hash del modelo en la
canonica, borrar duplicadas tras confirmar. Recuperable ~3.5 GB. Requiere confirmacion (toca caches que el
runtime puede recrear pero ralentiza el primer arranque).

## 3. Cruft / temporales

- Dirs con nombre malformado (paths concatenados): `CUsersRodrigo.ultron.tmpevals`,
  `.tmpevalsround3`, `.tmpevalsround4` — temporales de corridas de `ultron-memory eval`. Tamano ~0.
  **Accion (nivel 1)**: borrar tras confirmar que no hay eval en curso. Investigar por que el harness
  crea rutas malformadas (bug de path join en evals.rs).
- `logs/backup-2026-06-01.log` 15.6 MB; `logs/stop-memory-sync.log` 0.89 MB; `logs/mem0.jsonl` 0.07 MB.
  **Accion (nivel 1)**: TTL + rotacion; revisar `mem0.jsonl`/`stop-memory-sync.log` por posibles secretos antes de comprimir.

## 4. Backups (sin rotacion)

- ~24 entradas en `backups/`, casi todas <1 MB (mayo). El grande: `pre-v14.9-2026-05-10-134132-fb47`
  = **899.9 MB** (candidato `protected`). + `2026-05-05-1437-pre-S2-rebuild/index.db` 14.9 MB.
- **Accion (nivel 3)**: rotacion generacional (conservar N recientes + protected); el de 899 MB requiere
  confirmacion explicita (snapshot pre-v14.9, posible valor de auditoria).

## 5. Plan de liberacion por niveles (dry-run primero, SIEMPRE)

| Nivel | Que | GB aprox | Coste | Confirmacion |
|---|---|---:|---|---|
| **1 (bajo riesgo)** | logs antiguos + TTL; cruft `.tmpevals*` | ~0.04 | nulo | si (borrado) |
| **2 (rebuild parcial / dup)** | `target/debug/incremental` (5.51) + `.fastembed_cache` dup (~3.5) + `.uv-cache-rescue` antiguos (0.78) | **~9.8** | recompilacion incremental; primer embed mas lento | si (fuerte) |
| **3 (rebuild pesado / datos)** | `target/debug` (23.32) + `target/release` restos antiguos + backups grandes | **~24+** | recompilacion completa; perdida de snapshots | si (muy fuerte) |

> **NO se toca jamas**: `qdrant_storage`, `brain.db`, `workflow-runs.db`, `bin/` (sidecars), `qdrant-native`,
> model cache canonica, backups `protected`.
>
> **Acceptance post-limpieza** (08-AUDIT): tras nivel 1/2, `doctor`/`eval`/`reconcile --check` siguen verdes
> (o se documenta que hace falta rebuild). Hoy `eval` = recall@8 0.917 es el smoke de memoria.

## 6. Ahorro potencial seguro (sin tocar datos canonicos)
- **Inmediato/seguro (nivel 1+2)**: ~9.8 GB (incremental + caches dup + uv antiguo).
- **Con rebuild aceptado (nivel 3)**: hasta ~33 GB (target completo), recuperable recompilando.
- **Suelo irreducible**: qdrant_storage (0.38) + brain.db + bin + qdrant-native + instructions + 1 model cache (2.22) ~= **3 GB**.
