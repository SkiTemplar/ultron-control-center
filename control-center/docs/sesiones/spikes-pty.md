# Spikes de WP-PTY (contrato de estabilidad, §8.3 paso 0)

Comprobaciones hechas el 2026-10-08 sobre Claude Code 2.1.293 en Windows 11, con ConPTY (pywinpty, 160x48),
`tui: "fullscreen"` y los mods de ULTRON cargados (`CLAUDE_CODE_PLUGIN_DIRS` de producción). Los bytes grabados
están en `src-tauri/src/sesiones/fixtures/tui/` (un `.ans` acumulado por sesión y un índice `.json` con el offset
de cada corte; los `.ans` van como binarios en git). Las rutas personales se sustituyeron por cadenas de la misma
longitud para no mover el cursor de la TUI.

Marcas: **[V]** verificado en la CLI real; **[B]** leído en el binario de la CLI (sin ejecutar); **[N]** no
comprobado (motivo al lado).

## Lanzamiento

| Supuesto | Resultado |
|---|---|
| `--session-id <uuid>` fija el transcript | [V] la conversación se escribe en `<slug>/<uuid>.jsonl` |
| `--resume <sid>` escribe en el mismo `.jsonl` | [V] el fichero crece y no aparece otro |
| `--permission-mode bypassPermissions` sin diálogo | [V] arranca en bypass. Nota: el perfil de pruebas tiene `skipDangerousModePermissionPrompt: true`; si un perfil sin esa clave mostrara la confirmación, `pantalla.rs` la clasifica como `dialog` con sus opciones |
| `--permission-mode default` | [V] aceptado aunque la ayuda lista `manual`; el pie muestra `⏸ manual mode on` |
| `--effort <nivel>` | [V] aceptado (`low`) |
| `--fork-session` | [B] existe; `--session-id` con `--resume` exige `--fork-session` (mensaje de error en el binario) |
| Clave de `--settings` para la disposición | [B] `tui: "default" \| "fullscreen"`; se fija `fullscreen` (los fixtures se grabaron así) |
| `promptSuggestionEnabled: false` por `--settings` | [V] `/config` lo muestra en `false` |

## Entrada y comandos

| Supuesto | Resultado |
|---|---|
| `/cmd` pegado con bracketed paste se reconoce como comando | [V] `/cost` pegado abrió su panel; no hace falta teclearlo carácter a carácter |
| Secuencia de limpieza de la caja | [V] Ctrl+U (`0x15`) la vacía |
| Glifo del prompt | [V] `❯` seguido de U+00A0 (espacio duro), no de un espacio normal; en modo shell, `!` |
| Pista en la caja vacía | [V] texto atenuado (SGR 2), p. ej. «Press up to edit queued messages»; la pista de `ultron-hud` (`PromptHint`) va en el pie, no en la caja |
| `/config` y Esc | [V] abre con el buscador activo: el primer Esc solo limpia la búsqueda («Esc to clear»), el segundo cierra («Esc to close»). `exitMenu` manda el segundo Esc pasados 1,6 s (G1) |
| Teclas escritas con un menú abierto | [V] van al menú: con `/config` abierto, un `\r` cambió un ajuste. Es el caso que bloquea G3 |
| Esc con un comando de shell (`!cmd`) en curso | [V] lo interrumpe y devuelve el comando a la caja; el mensaje de la cola nativa se envió solo después |

## Pantalla

| Estado | Marcadores observados |
|---|---|
| prompt | caja entre dos reglas `─` a todo lo ancho; pie con el modo (`⏵⏵ bypass permissions on`, `⏵⏵ auto mode on`, `⏸ manual mode on`, `⏵⏵ accept edits on`, `⏸ plan mode on`) |
| busy | `⎿ Running…` (shell) o la línea del spinner justo encima de la caja; con `ultron-hud`, `· Redactando…` (el verbo cambia y no siempre hay «esc to interrupt») |
| dialog | sin caja; borde `▔` de los paneles a pantalla completa (`/config`, `/model`, `/cost`) o pie `Enter to confirm · Esc to cancel` |
| trust | «Is this a project you created or one you trust?» con `❯ No, exit` resaltado por defecto y «Yes, I trust this folder» |
| otro diálogo de arranque | [V] al reanudar en un proyecto con `.mcp.json` aparece «New MCP server found in this project» con tres opciones: se clasifica como `dialog` y nunca se escribe en él |

Ciclo de Shift+Tab lanzado en bypass: `bypassPermissions → auto → default (manual) → acceptEdits → plan →
bypassPermissions`.

## Segundo plano y cola nativa (CONTRATO-v3 §3.4)

Spike del 2026-10-16 sobre Claude Code 2.1.301 con el mismo montaje (pywinpty 160x48, `tui: "fullscreen"`, bypass y
los mods y hooks de producción; el entorno sin las marcas de sesión hija, como lanza ULTRON). Comando de prueba:
`node -e "setTimeout(()=>console.log(1),90000)"` en Bash en primer plano (la CLI bloquea un `sleep 90` suelto en
primer plano: «Blocked: standalone sleep»). Fixture: `segundo-plano.ans`/`.json`.

| Supuesto | Resultado |
|---|---|
| Un Bash en primer plano pinta la pista de Ctrl+B | [V] «(ctrl+b to run in background)» bajo la línea `⎿ $ comando (Ns)`, unos 3 s después de arrancar; antes solo se ve «Running 1 shell command…» (corte `bash-con-pista`) |
| `0x02` con la pista a la vista pasa el Bash a segundo plano | [V] el turno cerró 4 s después; `tool_result` «Command was manually backgrounded by user with ID: …» en el transcript; el pie cuenta «1 shell» |
| `0x02` antes de que se pinte la pista | [V] no hace nada: el comando siguió los 90 s. Por eso `segundo_plano.rs` espera a la pista (≤ 4 s) antes de mandarlo |
| Detach automático al encolar un mensaje durante la herramienta | [V] no ocurre en este equipo (hooks `PostToolUse` `*` y mods con `tool.call`): `queue-operation enqueue` y `remove` (`absorbed_mid_turn`) separados 90 s, justo al terminar el comando |
| Ctrl+B con un mensaje en la cola nativa | [V] el mensaje se absorbió 1,5 s después del Ctrl+B (cortes `cola-durante-bash` y `cola-tras-ctrl-b`) |
| `0x02` con el prompt libre | [V] sin efecto visible en la pantalla |
| Pista de la cola nativa | [V] bajo el mensaje encolado se pinta «ctrl+x ctrl+s to send now»; [N] qué hace esa combinación (no se probó) |
| Ctrl+B con un `Agent` o una herramienta MCP en primer plano | [N] no se grabó (exige un turno con subagente); se admiten porque el binario los trata como tareas, y el resultado se verifica igual por el cierre de la herramienta |
| El puente cierra la herramienta movida | [B] `ultron-puente` emite `tool` `end` cuando su `tool.call` termina, y termina con el `tool_result` de arriba; no se midió con el puente conectado |


- [N] Diálogo de permiso y de plan en la TUI: con el puente activo no deberían pintarse (§4.4); grabarlos exige
  turnos del modelo. Se clasifican por el pie genérico de diálogo.
- [N] Aviso de caché tras `/model <id>` y `/effort <n>`: cambia el modelo y el effort por defecto del usuario.
- [N] Spinner nativo del modelo con «esc to interrupt»: se cubre con el marcador de texto y con el del spinner.
- [N] `popAll` de la cola nativa tras interrumpir un turno del modelo (solo se grabó el caso del modo shell).
- [N] `$.turn.abort` y `prompt.read`/`prompt.clear` del buzón: dependen de WP-PUENTE y WP-ESTADO.
