// ULTRON Control Center — Ollama (modelo local de autocompletado).
//
// Interruptor de la bandeja + seccion "Modelo local (Ollama)" de AI
// Router. Un unico guard de concurrencia (`toggle::OLLAMA_BUSY`, expuesto
// via `toggle::try_acquire_busy`/`toggle::BusyGuard`) evita que un clic de
// bandeja y una accion desde la UI (activar/cambiar modelo/pull/delete)
// se pisen.
//
// Modulos:
//   toggle.rs     — estado (`OllamaState`), arranque del servidor,
//                    activar/desactivar, precedencia del modelo
//                    configurado (env > persistido > por defecto), guard
//                    de concurrencia compartido con la bandeja.
//   config.rs      — persistencia del modelo elegido en
//                    `cockpit/ollama/config.json` (atomico, tmp+rename).
//   api.rs         — tipos expuestos al frontend + parseo puro de
//                    `/api/ps`, `/api/tags`, `/api/version` y del progreso
//                    NDJSON de `/api/pull`. Sin red — testeable sin Ollama
//                    vivo.
//   benchmark.rs   — peticion FIM de medicion de latencia + mediana/maximo.
//   editor.rs      — motor de autocompletado del editor (`ollamaTab.engine`
//                    en el settings.json de VS Code): lectura y escritura
//                    quirurgica del JSONC, y plan de modelos a cargar/soltar.
//   commands.rs    — comandos `#[tauri::command]` (capa de red, delgada).
//
// `tray.rs` solo habla con `toggle.rs` (igual que antes de que existiera
// esta seccion): la bandeja no necesita status/benchmark/pull/delete, solo
// el interruptor simple.
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
pub mod toggle;
