// ULTRON Control Center — Ollama (modelo local de autocompletado).
//
// Un solo mando: el motor del editor (`ollamaTab.engine` en el settings.json
// de VS Code: low/mid/high locales, Copilot u off). Lo cambian el item de la
// bandeja y la seccion "Modelo local (Ollama)" de AI Router a traves de la
// misma funcion (`engine::set_engine_blocking`), que suelta los modelos que
// no tocan y carga el del motor elegido. Un unico guard de concurrencia
// (`toggle::try_acquire_busy`) evita que un clic de bandeja y una accion
// desde la UI (motor/pull/delete/benchmark) se pisen.
//
// Modulos:
//   engine.rs     — cambio de motor compartido por comando y bandeja (guard +
//                    I/O real), motor local de referencia, modelo del motor activo
//                    con su plazo de residencia y funciones puras de la
//                    bandeja.
//   switch.rs     — secuencia del cambio de motor tras el trait
//                    `EngineBackend`: verificacion previa, liberar la VRAM
//                    salvo el destino, cargar y revertir si falla.
//   editor.rs     — lectura y escritura quirurgica del JSONC de VS Code,
//                    plan de modelos a cargar/soltar y tamano legible del
//                    modelo (`model_size_label`).
//   config.rs      — persistencia del ultimo motor local (`lastLocalEngine`)
//                    en `cockpit/ollama/config.json` (atomico, tmp+rename).
//   toggle.rs     — estado de un modelo (`/api/ps`), arranque del servidor,
//                    cargar/soltar un modelo, `model_name` para el AI Router
//                    y guard de concurrencia.
//   api.rs         — tipos expuestos al frontend + parseo puro de
//                    `/api/ps`, `/api/tags`, `/api/version` y del progreso
//                    NDJSON de `/api/pull`. Sin red — testeable sin Ollama
//                    vivo.
//   benchmark.rs   — peticion FIM de medicion de latencia + mediana/maximo.
//   commands.rs    — comandos `#[tauri::command]` (capa de red, delgada).
//
// NOTA sobre `generate_handler!`: los comandos de `commands.rs` se
// referencian en `handlers.rs` por su ruta completa
// (`ollama::commands::ollama_status`, …), NUNCA via un `pub use` que los
// reexporte aqui — un `pub use` mueve el simbolo de la funcion pero no
// los companions `__cmd__*`/`__tauri_command_name_*` que genera el macro,
// y `generate_handler!` dejaria de encontrarlos (mismo aviso que deja
// `ai_router/mod.rs` sobre su propio caso).

pub mod api;
pub mod benchmark;
pub mod commands;
pub mod config;
pub mod editor;
pub mod engine;
pub mod switch;
pub mod toggle;
