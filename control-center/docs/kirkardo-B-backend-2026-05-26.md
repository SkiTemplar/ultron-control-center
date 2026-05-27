# KIRKARDO — Evaluación Backend Rust/Tauri ULTRON Control Center

Fecha: 2026-05-26 · Repo: `src-tauri/src/` · Clippy: 76 warnings, 0 errors.

## Resumen (3 líneas)

Arquitectura modular correcta (lib.rs delgado + commands/ + domain/), pero la disciplina baja: cero file-locking (race conditions documentables en kg.rs, workdays.rs, ai_router.rs), tests inexistentes en módulos críticos (kg.rs, mem0.rs, memory_status.rs, commands/workdays.rs), errores silenciados (`let _ =`) y 76 warnings de clippy sin atender (manual range-checks, &PathBuf, `Error::new(Other)` en vez de `Error::other`). API key de Mem0 leída desde plaintext en `~/.claude/settings.json`. Aprobado raspado: el código funciona pero está a una colisión de FS de corromper estado.

## 1. Modularidad y separación domain/commands — 7/10

Evidencias:
- `src/lib.rs:19-70` — module declarations limpios; `commands/` separado de domain. Bien.
- `src/lib.rs:162` — `generate_handler!` único, todos los comandos centralizados.
- `src/commands/workdays.rs:1-223` — wrappers ultradelgados (`spawn_blocking` + delegate). Patrón correcto.

Pero: `ai_router.rs` mete 980 líneas — domain + HTTP clients + storage + seed data + tests + commands en un solo archivo. `workdays.rs` 1098 líneas. Violación KISS/cohesión propia del CLAUDE.md (max 800).

Fixes:
1. Partir `ai_router.rs` en `ai_router/{providers,zones,metrics,probes,commands}.rs`.
2. Extraer storage de `workdays.rs` a `workdays/storage.rs`.
3. Mover los `#[tauri::command]` que aún quedan dentro de archivos domain a `commands/<grupo>.rs` (el patrón ya está iniciado pero incompleto).

## 2. Manejo de errores — 6/10

Evidencias:
- `src/workdays.rs:274` — `let _ = crate::mem0::add_inner(...).await;` error swallowed. Si Mem0 falla nunca te enteras.
- `src/mem0.rs:60,70` — `let _ = std::fs::create_dir_all(parent);` y `let _ = writeln!(f, ...)`. El logger silencia su propio fallo: si no puede escribir, el "log" de diagnóstico miente.
- `Result<T, String>` en toda la API pública (`ai_router.rs:160`, `kg.rs:45`, `mem0.rs:138`). Pierde structured errors. `anyhow` ni se importa.

Fixes:
1. Sustituir `String` por `thiserror::Error` por dominio (`KgError`, `WorkdayError`, `Mem0Error`); convertir a String solo en el wrapper Tauri.
2. Cambiar los `let _ =` por `.map_err(|e| tracing::warn!(?e, "..."))` mínimo.
3. Propagar fallo de mem0 en `workdays.rs:274` o documentarlo como fire-and-forget explícito con métrica.

## 3. Tests — 3/10

Evidencias:
- `tests/` (integration) no existe. Solo módulos `#[cfg(test)]` inline.
- `kg.rs`: 0 tests. `mem0.rs`: 0 tests. `memory_status.rs`: 0 tests. `commands/workdays.rs`: 0 tests. Módulos centrales sin cobertura.
- `ai_router.rs`: 5 tests sobre serialización; ninguno toca routing, fallback ni concurrencia.

Fixes:
1. Crear `tests/kg_concurrency.rs` que valide read/write paralelo con tempfile.
2. Tests unit en `kg.rs` para `create_entities_inner` idempotencia, `delete_entity_inner` cascade, `search_nodes_inner` case-insensitive.
3. Integration test con `mockito` para `mem0.rs` (status/add/search/list).

## 4. Idioms Rust — 6/10

Evidencias clippy (76 warnings — `cargo clippy --no-deps`):
- `lib.rs:538,542,549` — `std::io::Error::new(ErrorKind::Other, e)` en vez de `Error::other(e)`.
- Multiples sitios — `&PathBuf` en lugar de `&Path` (7 ocurrencias), `iter().cloned().collect()` en vez de `to_vec()`, `manual Range::contains`, `manual div_ceil`, `clamp-like pattern sin clamp()`.
- `workdays.rs` — funciones con 10 y 11 argumentos (`too_many_arguments`). Indica falta de DTOs.

Fixes:
1. `cargo clippy --fix --lib -p control-center --no-deps` (35 sugerencias auto-aplicables).
2. Introducir struct-builders para los completes/creates con >7 args.
3. Reemplazar `&PathBuf` por `&Path` en signatures públicas.

## 5. Concurrency safety — 4/10

Evidencias críticas:
- `kg.rs:131-162` `write_graph` — NO HAY LOCK. Dos comandos Tauri concurrentes (`create_entities` + `add_observations`) leen el JSONL, mutan en memoria y reescriben. Last writer wins → pérdida silenciosa de entidades. El `rename` atómico no salva del read-modify-write race.
- `workdays.rs:182,958` mismo patrón: read → modify → write tmp → rename. Sin Mutex global por archivo.
- `ai_router.rs:412-413` mismo patrón en `save_*`. Sí tiene `Mutex` (línea 33) pero solo para cache en memoria, no para serializar I/O.
- `kg.rs` cuenta 0 primitivas de concurrencia (`Mutex`/`RwLock`/`Arc`).

Fixes:
1. `static KG_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));` y wrappear cada `read_modify_write` con `_guard = KG_LOCK.lock()`.
2. Idem para `workdays.rs` y `ai_router.rs` storage.
3. Para robustez real: `fs2::FileExt::lock_exclusive` sobre el archivo destino (protege contra otros procesos también, no solo otros hilos Tauri).

## 6. API design Tauri — 7/10

Evidencias:
- `commands/workdays.rs:8-65` — patrón uniforme `spawn_blocking` + `inner`. Bien para no bloquear el async runtime.
- `commands/workdays.rs:24` — `complete_workday` con 7 args opcionales. Debería ser un DTO `CompleteWorkdayRequest`.
- `lib.rs:162` registra 234 comandos en un único `generate_handler!`. Funciona pero el archivo cargará lento al compilar; revisar comandos huérfanos (no encontré huérfanos en grep, pero hay agentes que reportan duplicados — auditar `commands_registry.rs` vs handler real).
- Mem0 API key se lee plaintext de `~/.claude/settings.json` (`mem0.rs:138-183`). No es vuln del backend per se, pero el log `mem0.jsonl` puede capturar headers — verificar `body_excerpt` no incluya Authorization.

Fixes:
1. Convertir `complete_workday` y los wrappers con ≥5 opcionales a structs `Deserialize` request.
2. Añadir `tauri-specta` (ya hay TODO en `lib.rs:15`) para tipar el frontend.
3. Sanitizar `body_excerpt` en `mem0.rs:48` para strip de `Authorization:` antes del log.

---

## Nota global: 5.5/10

Aprueba justo. Arquitectura bien dirigida, ejecución descuidada. Las dos prioridades inmediatas son (1) lock file-system writes en kg/workdays/ai_router antes de perder datos, y (2) tests en kg.rs/mem0.rs antes del próximo refactor.
