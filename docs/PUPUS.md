# Pupus, la mascota de escritorio

Pupus es la mascota de ULTRON Control Center: una ventana transparente, sin
bordes y siempre encima que cubre el área de trabajo del monitor, de modo que
camina sobre la barra de tareas sin taparla. Los clics atraviesan la ventana
salvo encima de la mascota o de sus bocadillos. Verificado contra el código el
2026-11-02 (`control-center/src-tauri/src/mascot/`, `control-center/src/components/mascot/`).

**Alcance real: solo Windows.** En otros sistemas la ventana puede abrirse,
pero sin cursor global ni ventanas del escritorio, y el puente del MCP responde
con un error explícito.

## Cómo se activa

- Sale con la app si `enabled` es `true` en `~/.ultron/cockpit/mascot.json`
  (valor por defecto).
- Todos los ajustes se editan en **Settings → Mascota** (secciones Mascota,
  Escritorio, Juegos y calendario). El menú de la propia mascota abre esos
  ajustes o la esconde.
- **Ctrl+Alt+P** la esconde o la enseña a mano. Se esconde sola con una ventana
  a pantalla completa en su monitor, con un juego en ventana que la deje sin
  suelo y mientras una aplicación usa el micrófono; vuelve cuando no queda
  ningún motivo.
- Aparecer no le quita el foco a lo que estés usando: la ventana se enseña sin
  activarse (`page.rs`, `win::show_no_activate`). Solo coge el teclado al abrir
  el cuadro de texto del chat, con un clic tuyo o al soltarle un fichero.

## Qué hace (y el ajuste que lo controla)

| Función | Ajuste en `mascot.json` |
|---|---|
| Pasea, salta, trepa por las ventanas y choca con ellas; física con gravedad y rebote | `wander`, `jump`, `climb_windows`, `collide_windows`, `splat`, `gravity`, `bounciness`, `scale` (2-8) |
| Sigue el cursor con los ojos, se duerme tras un rato sin atención, sombreros y bromas con el cursor | `eyes_follow_cursor`, `sleep_after_min`, `hats`, `cursor_pranks`, `hang_struggle` |
| Chat por bocadillo con tres botones: Claude (`claude -p`), Codex (`codex exec`) y Antigravity (`agy -p`), cada uno por su CLI de suscripción y, si falla, por la API equivalente del AI Router; la respuesta dice siempre qué camino contestó | `claude_model`, `codex_model` |
| Lleva el cursor cuando Claude usa el MCP de escritorio (`tools/ultron-desktop-mcp`) | `drive_with_mcp` |
| Con un juego de la tabla en primer plano se disfraza y no molesta | `game_mode`, `games` (tabla de `.exe`, hasta 64) |
| Señala en la barra de tareas el botón que pide atención | `taskbar_hints` |
| Se posa en las islas de una barra de tareas transparente | `taskbar_islands` |
| Con una sesión de ULTRON Sessions esperando permiso, se cuelga junto a su fila y la señala | `sessions_choreo` |
| Avisa de builds y tests en rojo | `build_alerts` |
| Avisa de entregas del calendario de la universidad, las lleva al kanban y se las cuenta al chat (ver abajo) | `calendar` |
| Se esconde mientras una aplicación usa el micrófono | `hide_in_calls` |
| Sale en grabaciones de pantalla (nunca en las capturas del MCP) | `capturable` |
| Ánimo según lo que haces, actividades propias y baile con música | `ambient_mood`, `activities`, `music_dance` |
| Contesta permisos de Claude Code en terminal desde el bocadillo (ver abajo) | sin ajuste: hook `pupus-permission` |

## Entregas en el kanban

Cada entrega próxima con asignatura conocida crea una tarjeta en la columna de
pendientes del primer proyecto de esa asignatura en `curso.json`, con las
etiquetas `entrega`, `vence:AAAA-MM-DD` y `cal:<uid>`
(`mascot/calendar_kanban.rs`). Una tarjeta borrada o archivada a mano no vuelve.
Si Blackboard cambia la fecha, la tarjeta viva se actualiza (etiqueta y título,
salvo que la hayas retitulado); las terminadas no se tocan. El chat recibe las
entregas pendientes de esos tableros como contexto en cada mensaje
(`mascot/deliveries.rs`), marcadas como datos y no como instrucciones.

## Permisos del chat

**Claude** pasa por el freno de `mascot/chat_gate.rs`: un hook `PreToolUse` por
HTTP contra el puente que falla cerrado. Es un freno sobre el texto de la
acción, no un sandbox. Pide confirmación en el bocadillo para:

- comandos destructivos, ejecutar scripts o programas, sobrescribir o mover
  ficheros por shell y escribir en rutas de arranque o de configuración;
- credenciales con cualquier herramienta: `.env`, `~/.claude.json`, claves,
  tokens de CLI y volcados del entorno (`mascot/chat_gate/secrets.rs`). Con
  `deny-secrets` registrado pueden salir dos tarjetas seguidas, la del freno y
  la de la puerta `approve_tool_use`: esa puerta tampoco aprueba un secreto
  como una lectura normal. Lo que `deny-secrets` deniega en duro sigue denegado;
- enviar datos a la red (`curl -d`, `-F` o `-T`, `Invoke-RestMethod -Body`,
  `scp`, `nc`…), con o sin el turno marcado;
- contactar con el puente local o leer su token;
- lo tecleado con el MCP cuando coincide con uno de estos patrones, acumulado
  hasta el Enter: teclear sin más no pregunta;
- herramientas desconocidas o de MCP de terceros.

**Turno marcado.** Marcan la conversación lo que trae contenido de fuera:
WebFetch, WebSearch, comandos de red, Read, NotebookRead, Grep,
ReadMcpResourceTool, comandos que leen ficheros (`cat`, `Get-Content`, `grep`…)
y los ficheros adjuntos. Desde ese momento pide confirmación para cualquier
comando, escritura, clic, tecla y para otro WebFetch o WebSearch, cuya URL podría
sacar lo leído. La marca sobrevive al mensaje siguiente y a un reinicio de la app;
el bocadillo lo indica con «🛡 confirma acciones» y solo «nueva» la limpia.
**Con el turno marcado siguen sin preguntar** Read, Grep, Glob, las capturas,
mover el cursor, la rueda y esperar: lo que se frena es la salida, no la lectura.

**Codex** corre con `--sandbox workspace-write` y la carpeta de usuario como cwd,
sin confirmación en el bocadillo (decisión del 2026-10-19). **Antigravity**
autoaprueba en su sandbox de terminal, salvo con ficheros adjuntos. Ninguno de
los dos tiene freno ni marca de turno. Con adjuntos, el prompt indica que su
contenido es dato y no órdenes.

**Guardarraíl de persistencia** (`mascot/guardrail.rs`), solo en los turnos de
Codex y Antigravity: fotografía una lista fija de rutas antes del turno y, al
terminar, revierte lo que haya cambiado y lo avisa en la respuesta; lo que dejó
el turno queda en cuarentena en `~/.ultron/cockpit/pupus-guardrail/<marca>/`. Cubre settings,
hooks, agentes, reglas y skills de Claude Code, `.ultron/hooks`, `mods`, `scripts`
y `bin`, la configuración de Codex y Gemini, `.ssh`, perfiles de shell, `.gitconfig`
y la carpeta de Inicio. Los turnos con guardarraíl van de uno en uno: un segundo
mensaje espera a que acabe el primero (hasta 3 min).

Es reversión después del turno, no prevención. Lo que se escribe fuera de la
lista no se ve; un programa que el turno deje en marcha no se deshace; lo que no
cabe en la foto (ejecutables de `.ultron/bin`, más de 64 MiB) se detecta pero no se
restaura, y el aviso lo dice. Una edición legítima de esas rutas durante el turno
también se revierte, aunque queda en cuarentena. No se ha medido si el sandbox de
Codex o de Antigravity deja llegar al puente por loopback.

El detalle vigente está en las cabeceras de `mascot/chat.rs`,
`mascot/chat_gate.rs` y `mascot/guardrail.rs`.

## Permisos de Claude Code en terminal

El hook global `PermissionRequest` (`hooks/scripts/pupus-permission.js`) lleva las
peticiones de permiso de **cualquier sesión de Claude Code** en terminal o VS Code
a una tarjeta del bocadillo (`mascot/permission.rs`), con su origen, lo último que
dijo Claude y el comando entero, o la ruta y lo que se escribe (hasta 8.000
caracteres, con una marca si se recorta). Gana quien conteste antes, el bocadillo o
la terminal. Sin decisión (ULTRON cerrado, Pupus oculto, nadie contesta en 10 min)
manda el diálogo de la terminal: no poder preguntar nunca deniega. Las sesiones de
ULTRON Sessions no pasan por aquí: sus preguntas las enseña el bocadillo aparte.

## Tests

| Suite | Comando | Cifra (2026-11-02) |
|---|---|---|
| Backend Rust (`mascot::`) | `cd control-center/src-tauri && cargo test --features finance --lib mascot::` | 245 pass, 0 fail, 5 ignorados |
| Webview (`src/components/mascot/`) | `cd control-center && npx vitest run src/components/mascot` | 43 ficheros, 473 pass, 1 omitido |
| MCP de escritorio | `node --test tools/ultron-desktop-mcp/server.test.mjs` | 13 pass, 0 fail |
| Debloat y servicios (sin tocar el sistema) | `powershell -NoProfile -ExecutionPolicy Bypass -File desktop/debloat/debloat.selftest.ps1` | 51 ok, 0 fallos |

La parte visual (sprite, animaciones, bocadillos) y el foco real frente a un juego a
pantalla completa necesitan revisión a ojo: los tests no los ven.
