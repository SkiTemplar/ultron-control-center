//! Piloto MCP de la GUI (solo desarrollo).
//!
//! Registra `tauri-plugin-mcp-bridge`, el puente WebSocket que usa
//! `@hypothesi/tauri-mcp-server` para que un agente vea la GUI (capturas, DOM,
//! logs de consola) y opere sobre ella (clics, teclado, ejecucion de JS en el
//! webview, invocacion de comandos IPC). Ver `docs/MCP-TAURI-PILOTO.md`.
//!
//! Este modulo solo se compila con `--features mcp-bridge` en un perfil con
//! `debug_assertions`; `lib.rs` aborta la compilacion si la feature llega a
//! release. Arranque: `npm run dev:mcp` desde `control-center/`.

use tauri::{App, Builder, Manager, Runtime};

/// Capability del puente. Vive fuera de `capabilities/` para que tauri-build
/// no la incluya en ningun binario; se concede en runtime desde `setup`.
const CAPABILITY: &str = include_str!("../capabilities-dev/mcp-bridge.json");

/// Anade el plugin al builder. Escucha solo en 127.0.0.1 (el valor por
/// defecto del plugin es 0.0.0.0, que expondria la ejecucion de JS a la red
/// local); puerto 9223 o el siguiente libre hasta 9322.
pub fn attach<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    let config = tauri_plugin_mcp_bridge::Config::localhost_only();
    builder.plugin(tauri_plugin_mcp_bridge::init_with_config(config))
}

/// Concede `mcp-bridge:default` a las ventanas `main`, `project_*` y las de Sesiones.
///
/// # Errors
///
/// Devuelve el error de Tauri si la capability no se puede resolver contra
/// los manifiestos ACL embebidos (p. ej. si el plugin no se registro).
pub fn grant_capability<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    app.add_capability(CAPABILITY)?;
    tracing::warn!("piloto MCP activo: puente WebSocket en 127.0.0.1:9223-9322 (solo desarrollo)");
    Ok(())
}
