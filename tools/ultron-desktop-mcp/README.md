# ultron-desktop — MCP de escritorio con mascota

Da a **Claude Code en terminal** (o a cualquier cliente MCP por stdio) control
del escritorio de Windows. El servidor (`server.mjs`, Node, sin dependencias) no
toca Windows: reenvía cada herramienta al puente HTTP local de **ULTRON Control
Center** (`control-center/src-tauri/src/mascot/bridge.rs`), que ejecuta la
acción. Con la mascota activada, esta vuela hasta cada punto llevando el cursor,
«pulsa» al clicar y teclea al escribir.

## Registro

Desde la app: **Settings → Mascota → Registrar en Claude Code**. A mano:

```
claude mcp add --scope user ultron-desktop -- node "%USERPROFILE%\.ultron\tools\ultron-desktop-mcp\server.mjs"
```

## Herramientas

| Herramienta | Qué hace |
|---|---|
| `screenshot` | Captura el monitor principal, reducida a 1280 px de ancho como mucho. La mascota no sale (`WDA_EXCLUDEFROMCAPTURE`, Windows 10 2004 o posterior). |
| `mouse_move` | Mueve el cursor a (x, y). |
| `click` | Clic izquierdo, derecho o central; `count: 2` hace doble clic. Sin coordenadas, clica donde esté el cursor. |
| `drag` | Arrastra con el botón pulsado de (x, y) a (to_x, to_y). |
| `scroll` | Rueda en muescas (`dy > 0` sube el contenido). |
| `type_text` | Escribe texto Unicode; `\n` = Enter. |
| `press_keys` | Combinación de teclas: `ctrl+c`, `alt+tab`, `win+r`, `f5`… |
| `cursor_position`, `list_windows` | Consultas. |
| `wait` | Espera hasta 30 s. |

Todas las acciones aceptan `screenshot_after: true` para devolver una captura
nueva medio segundo después.

**Coordenadas**: siempre las de la última captura. El puente las escala a
píxeles físicos con un factor determinista (`ancho / 1280`), así que no depende
de recordar cuál fue esa captura.

## Límites

- **Solo Windows y solo el monitor principal.**
- **ULTRON Control Center tiene que estar abierto.** Si no lo está, cada
  herramienta devuelve un error que lo dice. No hay un camino alternativo que
  mueva el ratón a ciegas.
- Windows bloquea la entrada sintética hacia programas abiertos como
  administrador (UIPI). Ahí `SendInput` falla y la herramienta lo dice.
- Puerto y token aleatorios por arranque, en `~/.ultron/cockpit/mascot-bridge.json`.
  El puente solo escucha en `127.0.0.1` y rechaza peticiones con cabecera
  `Origin`, así que una web abierta en el navegador no puede hablar con él.

## Tests

```
node --test tools/ultron-desktop-mcp/server.test.mjs
```

Usan un puente falso con el mismo contrato e incluyen un caso con ULTRON
cerrado, otro con el puente rechazando la acción y el servidor real por stdio.
