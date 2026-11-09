# Piloto MCP de la GUI (solo desarrollo)

Permite que un agente de Claude Code vea y opere la GUI de ULTRON Control Center
mientras corre en `tauri dev`: capturas del webview, árbol DOM/accesibilidad, logs
de consola, clics y teclado, ejecución de JavaScript en el webview, invocación de
comandos IPC y monitorización del tráfico IPC.

Proyecto upstream: [hypothesi/mcp-server-tauri](https://github.com/hypothesi/mcp-server-tauri)
(licencia MIT). Versión fijada: **0.13.0** en las dos piezas.

| Pieza | Dónde | Versión |
|---|---|---|
| Plugin Rust `tauri-plugin-mcp-bridge` | `control-center/src-tauri/Cargo.toml`, dependencia opcional de la feature `mcp-bridge` | `=0.13.0` |
| Servidor MCP `@hypothesi/tauri-mcp-server` | `.mcp.json` en la raíz del repo (servidor `tauri`, vía `npx`) | `@0.13.0` |

El paquete npm opcional `@hypothesi/tauri-plugin-mcp-bridge` (bindings TS para el
frontend) no se instala: el servidor MCP habla con el plugin por WebSocket.

## Cómo arrancarlo

1. Cerrar ULTRON si está abierto. El plugin `single-instance` comparte identificador
   con la build de escritorio: con la app instalada en marcha, la copia de `tauri dev`
   sale nada más arrancar y enfoca la otra ventana.
2. Desde `control-center/`: `npm run dev:mcp`. Equivale a
   `tauri dev --features mcp-bridge --config src-tauri/tauri.mcp.conf.json`.
3. Abrir Claude Code en la raíz del repo y aprobar el servidor `tauri` de `.mcp.json`
   (Claude Code pide confirmación la primera vez para los servidores de proyecto).
4. En la sesión: `driver_session` con `action: "start"` y después, por ejemplo,
   `webview_screenshot`, `webview_dom_snapshot` o `read_logs`.

## Qué cambia respecto a la build normal

- Feature cargo `mcp-bridge`: fuera de `default`. Ni `npm run build:local` ni
  `npm run build:app` la activan.
- `src-tauri/src/lib.rs` solo compila `mcp_bridge.rs` con
  `cfg(all(feature = "mcp-bridge", debug_assertions))` y emite `compile_error!` si la
  feature llega a un perfil sin `debug_assertions`: `cargo build --release --features mcp-bridge`
  no compila.
- La capability `mcp-bridge:default` vive en `src-tauri/capabilities-dev/`, fuera de
  `capabilities/`, para que tauri-build no la meta en ningún binario. Se concede en
  runtime (`App::add_capability`) a las ventanas `main`, `project_*`, `sesiones` y `sesiones-*`.
- `src-tauri/tauri.mcp.conf.json` activa `app.withGlobalTauri` (el script que inyecta
  el plugin usa `window.__TAURI__`). Solo se fusiona en `dev:mcp`; la configuración
  base no cambia.

## Alcance y riesgos

- **Solo desarrollo.** No va en ningún binario de producción.
- El plugin abre un WebSocket sin autenticación en `127.0.0.1`, puerto 9223 o el siguiente libre
  hasta el 9322. Su valor por defecto es `0.0.0.0`; aquí se fuerza `Config::localhost_only()`.
  Cualquier proceso local que conecte a ese puerto puede ejecutar JavaScript en el
  webview e invocar cualquier comando Tauri de la app (`ipc_execute_command`): con el
  piloto en marcha, la app queda tan expuesta como la sesión local del usuario.
- `withGlobalTauri` expone `window.__TAURI__` a todo el JavaScript del webview durante
  la sesión de desarrollo.
- `.mcp.json` usa `cmd /c npx`, que es la forma que necesita Claude Code en Windows
  nativo. En Linux o macOS hay que cambiar `command` a `npx` y quitar `/c`.
- La CSP de la app (`script-src 'self'`) no se toca. Si alguna herramienta del
  servidor fallara por ella, se documentará aquí antes de relajarla, y solo para
  `dev:mcp`.
