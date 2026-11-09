# ULTRON Sessions — contrato v0.2 («The Ultimate Claude Code Interface»)

Amplía `CONTRATO.md` (v0.1, sigue vigente salvo lo que se cambia aquí). Tres
piezas en paralelo: backend Rust (`src-tauri/src/sesiones/`), frontend React
(`src/sesiones/`) y Projects. Cambios al contrato: anotarlos al final.

## Decisiones (2026-10-07, pedidas por el usuario)

| # | Decisión | Por qué |
|---|----------|---------|
| E1 | Nombre visible: **ULTRON Sessions** (título de ventana, marca, textos). Los identificadores internos (`sesiones_*`, `sesiones://`, carpetas) no cambian. | Evitar una migración sin valor. |
| E2 | Vista principal con **estética de terminal**: monoespaciada (Geist Mono), marcadores `❯` (prompt del usuario), `⏺` (respuesta), `⎿` (resultado de herramienta), herramientas en una línea plegable, colores por motor. Rápida: lista virtualizada, sin re-render global por delta. | El usuario quiere «diseño de la terminal», no el de la app de Claude. |
| E3 | **Línea de estado (HUD)** fija bajo el composer, siempre visible: modelo · effort · contexto (% y barra) · 5 h · semana (+ ritmo) · socrático · rama y cambios git · adjuntos · coste del turno/sesión · modo de permisos. Cada segmento abre su desplegable visual. | «Ver modelo, contexto, effort, socrático, usos, adjuntos, git». |
| E4 | **Desplegables propios** (no `<select>` nativo): popover con teclado (↑↓ Enter Esc), descripción por opción, estado actual marcado. Un componente único `Dropdown` reutilizado en todo. | «Que los desplegables sean visuales». |
| E5 | **Historial de prompts con ↑/↓** en el composer (caret en la primera/última línea), por proyecto, sembrado con los prompts de los transcripts del proyecto; Ctrl+R busca en el historial. | «Volver a prompts con flechas». |
| E6 | **Paleta de comandos** con `/`: integrados de Claude Code, comandos de los mods ULTRON, skills y comandos del proyecto, con descripción y origen. Arriba, **Recomendados** según el estado (contexto > 70 % → `/compact` o `/relevo`; git sucio → commit; tests tocados → `/probar`; prompt vago → `/mejorar`). | «Comandos recomendados». |
| E7 | **Consejos de prompting** en vivo bajo el composer (no bloquean): prompt muy corto o vago, sin criterio de aceptación, sin ficheros citados en una tarea de código, prompt enorme (sugerir adjuntar o `/mejorar`). Reglas deterministas en el frontend, sin llamar a ningún modelo. | «Recomendaciones de prompting» sin coste. |
| E8 | **Motores mezclados en un mismo hilo** (propuesta): Claude Code (PTY) es el conductor. Codex y Gemini entran como **intervenciones** en la misma línea de tiempo: el composer tiene «Enviar a: Claude · Codex · Gemini»; además, cada respuesta tiene «Segunda opinión → Codex/Gemini». La intervención se ejecuta en el mismo cwd con un **paquete de contexto** (últimos turnos de texto del hilo, recortado a ~24 000 caracteres, más el prompt) y su resultado aparece como bloque del motor (color propio) con «Traer a Claude» (pega un resumen en el PTY) y «Descartar». Codex mantiene continuidad por sesión (`codex exec resume <thread>` si hay hilo previo). Nada entra en el contexto de Claude sin pulsar «Traer». | Una sola línea de tiempo, Claude como orquestador, los demás como consultores; sin duplicar contexto ni gastar plan de Claude en lo que hace otro. |
| E9 | Gemini por la CLI `agy` (Antigravity) en modo no interactivo; si no está o falla, el motor aparece deshabilitado con el motivo. `gemini` (npm) como segunda opción solo si `agy` no existe. | `gemini-cli` perdió el free tier OAuth (2026-06-19); `agy` es la vía viva. |
| E10 | Inspector con pestañas: Agentes, Git, Contexto, Uso, Adjuntos, **Motores** (antes Codex: tareas de Codex y Gemini), **Kanban**, **Bitácora**, **Mods**, **Hooks**. | «Mods y sistemas integrados», kanban y bitácora. |
| E11 | El botón **Claude** de Projects abre la sesión en ULTRON Sessions (crea sesión del proyecto y abre/enfoca la ventana). La terminal clásica queda accesible con Mayús+clic o desde un menú del botón. | «Lo más óptimo es el botón de Claude en Project». |
| E12 | Las sesiones de Sessions se lanzan con los mismos argumentos que las de terminal de Projects (incluido `--settings` del tema del proyecto, `claude_theme.rs`) para que mods y tema se comporten igual. | «Mezcla bien» entre ambos lanzamientos. |
| E13 | La entrada a una sesión que aún arranca se **encola** y se envía al aparecer el prompt (`entrada.rs`, ya hecho). El composer muestra «en cola hasta que Claude arranque». Si la TUI muestra un diálogo, la sesión pasa a `waiting` y la UI ofrece abrir la vista Terminal. | Causa del «el mensaje no llegó». |

Fuera de alcance de esta versión: editar hooks (solo verlos), instalar mods
nuevos, sesiones de Claude abiertas fuera de Sessions.

## 1. Backend — comandos nuevos

Todos `Result<T, String>`, errores en español, tipos `camelCase`, añadidos a
`capabilities/sesiones.json` y a `handlers.rs`.

```ts
interface SessionSettings {          // lo que muestra el HUD y no viene del puente
  model: string | null               // de la sesión (puente/JSONL) o de settings.json
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
  permissionMode: string | null      // 'skip' si va con --dangerously-skip-permissions
  socratic: 'strict' | 'light' | 'off' | 'uni' | null   // projects.json del proyecto
  projectId: string | null
}
interface CommandDef {
  name: string                       // sin la barra: 'compact', 'mejorar'
  description: string
  argHint?: string
  source: 'builtin' | 'mod' | 'skill' | 'user' | 'project'
  origin?: string                    // nombre del mod o skill
}
interface ModInfo { name: string; description: string; version: string | null; path: string; enabled: boolean; commands: string[] }
interface HookInfo { event: string; name: string; command: string; isAsync: boolean; runs24h: number; p50Ms: number | null; p95Ms: number | null; errors24h: number; lastError?: string }
interface Bitacora { resumen: string; pendientes: string[]; decisiones: string[]; gotchas: string[]; updatedAt: string | null }
type EngineId = 'codex' | 'gemini'
interface EngineStatus { id: EngineId; available: boolean; reason?: string; version?: string }
// CodexTask de v0.1 pasa a EngineTask: añade `engine: EngineId` y `kind: 'task' | 'opinion'`.
```

> **Retirados el 2026-10-14** (sin consumidor tras quitar las pestañas Kanban, Hooks y Mods del inspector): `sesiones_mod_toggle`, `sesiones_hooks`, `sesiones_kanban` y `sesiones_kanban_move`, con el tipo `HookInfo`. Lo que sigue de ellos en este documento es histórico.

| Comando | Firma | Notas |
|---------|-------|-------|
| `sesiones_launch` | `(projectId: string) -> SessionInfo` | Abre/enfoca la ventana y crea una sesión del proyecto. Para el botón Claude de Projects. |
| `sesiones_settings` | `(id: SessionId) -> SessionSettings` | Effort: `modelSettings[<modelo sin [1m]>].effortLevel` y si no `effortLevel` de `~/.claude/settings.json` (o el `--settings` de la sesión si lo fija). |
| `sesiones_set_effort` | `({ id, effort }) -> ()` | Usa la vía real que soporte Claude Code (verificar: comando `/effort`, o `/model` con effort, o settings por sesión). Si solo puede aplicarse a sesiones nuevas, devolver error claro que lo diga; nunca un no-op. |
| `sesiones_set_model` | `({ id, model }) -> ()` | Escribe `/model <id>` en el PTY (vía `entrada::send_or_queue`). Solo familia 5.5. |
| `sesiones_set_socratic` | `({ projectId, mode }) -> ()` | Ejecuta `node ~/.ultron/scripts/project-socratic.mjs <id> <modo>`. |
| `sesiones_prompt_history` | `({ projectId?, cwd?, limit? }) -> string[]` | Prompts del usuario de los transcripts del proyecto (sin `isMeta` ni `<command…`/`<system-reminder>`), más recientes primero, sin duplicados consecutivos, máx. 500. |
| `sesiones_commands` | `(cwd: string) -> CommandDef[]` | Integrados (lista fija documentada), mods (los `command:` que registran los mods de `CLAUDE_CODE_PLUGIN_DIRS`), skills (`~/.claude/skills/*/SKILL.md`, no `_disabled`), `~/.claude/commands`, `<cwd>/.claude/commands`. Caché por cwd con invalidación por mtime. |
| `sesiones_mods` | `() -> ModInfo[]` | Carpetas de `~/.ultron/mods/*` con `.claude-plugin/plugin.json`; `enabled` = está en `CLAUDE_CODE_PLUGIN_DIRS` de `~/.claude/settings.json`. |
| `sesiones_mod_toggle` | `({ name, enabled }) -> ModInfo[]` | Edita `env.CLAUDE_CODE_PLUGIN_DIRS` con copia de seguridad y escritura atómica. Afecta a sesiones nuevas (decirlo en la UI). `ultron-puente` no se puede desactivar desde aquí. |
| `sesiones_hooks` | `() -> HookInfo[]` | `~/.ultron/hooks/manifest.json` + últimas 24 h de `~/.ultron/logs/hook-timing.jsonl` y `hook-errors.jsonl` (leer solo la cola del fichero, máx. 8 MB). |
| `sesiones_kanban` | `(projectId) -> KanbanBoard` | Reutiliza la carga de `commands::kanban`. Mover tarjetas: `sesiones_kanban_move({ projectId, cardId, column })` reutilizando la lógica existente. |
| `sesiones_bitacora` | `(projectId) -> Bitacora` | `~/.ultron/cockpit/projects/<id>/estado.json`. |
| `sesiones_engines` | `{force?} -> EngineStatus[]` | Detecta `codex` y `agy` (y `gemini` como reserva) y su versión, con caché de 5 min y revalidación en segundo plano; `force` (botón «Detectar») detecta en el acto y renueva la caché. `note` avisa de qué CLI de Gemini funciona (solo `agy`; `gemini` de npm se quedó sin tier gratuito). |
| `sesiones_engine_run` | `({ sessionId, engine, prompt, kind, includeContext, mode?, model?, group?, turnId? }) -> EngineTask` | Generaliza `sesiones_codex_start`. `kind`: `task`, `opinion` o `review` (segunda opinión automática: responde `SIN HALLAZGOS` si no encuentra nada). `group`: id del Tribunal. `turnId`: clave idempotente (la revisión automática manda el turno): la misma clave no lanza un segundo proceso y devuelve la tarea ya lanzada, aunque la pidan varias ventanas. Plazo máximo por tarea: 15 min `review`, 30 min el resto; al vencer se mata el árbol de procesos y la tarea queda en `error` con la causa. Un `error` de primer nivel de Codex seguido de `turn.completed` (reintento de stream) es un aviso, no un fallo. Codex guarda los tokens de `turn.completed` en `usage`. `includeContext` añade el paquete de contexto (E8) leído del transcript de la sesión. Gemini: `agy` no interactivo con el prompt por stdin o fichero (nunca como argumento largo: ENAMETOOLONG en Windows). Emite `sesiones://engine`. |
| `sesiones_engine_bring` / `sesiones_engine_cancel` / `sesiones_engine_list` | como los de Codex | Los `sesiones_codex_*` quedan como alias hasta que el frontend migre. |
| `sesiones_engine_clear` | `(sessionId) -> EngineTask[]` | Borra las tareas terminadas de la sesión y las que no tienen sesión; las que siguen en curso y las de un Tribunal con algún miembro en curso se quedan. Devuelve la lista que queda y la emite en `sesiones://engine-list` para las demás ventanas. |
| `sesiones_engine_contrast` | `({ group, sessionId }) -> void` | Tribunal: pega en la sesión las respuestas del grupo con la petición de contrastarlas. Exige al menos dos, todas en `done` (igual que `canContrast` en el frontend) y sin traer; si el envío o la composición del texto fallan, deshace todas las reservas. |

Lanzamiento (E12): `gestor::create` añade el `--settings` del tema del proyecto
igual que el lanzamiento de terminal de Projects.

## 2. Frontend

- Marca «ULTRON Sessions»; `sesiones.html` sin estilos inline (CSP: ver `themes.ts`).
- Componentes nuevos: `Dropdown` (E4), `StatusLine` (E3), `CommandPalette` (E6), `PromptTips` (E7), `EngineBlock` (bloque de intervención con Traer/Descartar), pestañas `Kanban`, `Bitacora`, `Mods`, `Hooks`, `Motores`.
- `ChatPane` en estética de terminal (E2) para los cuatro temas; el chat entero en mono.
- Composer: historial ↑/↓ y Ctrl+R (E5); «Enviar a» con `Dropdown`; estado «en cola» mientras `status === 'starting'`; aviso con botón «Abrir terminal» si `status === 'waiting'` sin pregunta pendiente.
- Mock (`?mock=1`) con datos de todos los comandos nuevos; e2e ampliado.
- Projects: botón Claude → `sesiones_launch(projectId)`; Mayús+clic o menú → terminal clásica (`spawn_session`).

## 3. Verificación

- Rust: tests de `sesiones_prompt_history` (filtra meta), `sesiones_commands` (fixtures de mods y skills), `sesiones_mod_toggle` (no toca otras claves, rechaza `ultron-puente`), `sesiones_hooks` (agregado de p50/p95), paquete de contexto (recorte), detección de motores sin binario (`available: false` con motivo). `cargo test sesiones::` y clippy sin avisos.
- Frontend: `tsc`, `vitest` de `Dropdown` (teclado), historial, reglas de `PromptTips`, recomendaciones; e2e con `?mock=1`.
- Integración (la hace la sesión principal): `build:local`, botón Claude de Projects, enviar al arrancar, Codex y Gemini en el mismo hilo.

## Cambios al contrato

Backend, 2026-10-07:

- **Effort** (verificado en Claude Code 2.1.292): existe `/effort <low|medium|high|xhigh|max>` y se aplica a la sesión en curso; `sesiones_set_effort` lo escribe en el PTY (en cola si arranca). Efecto lateral del CLI: también lo guarda como valor por defecto para sesiones nuevas. Si `CLAUDE_CODE_EFFORT_LEVEL` está definida, el CLI lo ignoraría: el comando devuelve error.
- `sesiones_create` admite `effort?` (→ `--effort`, igual que el lanzamiento de terminal). Con E12, `gestor::create` añade `--settings <ruta>` del tema del proyecto (`sessions::project_theme_for_cwd`); una ruta con metacaracteres de `cmd.exe` se descarta con aviso.
- `sesiones_set_model`: solo los ID exactos `claude-opus-5-5` y `claude-sonnet-5-5` (con `[1m]` opcional); los alias se rechazan.
- `sesiones_settings.socratic`: modo ausente en `projects.json` = `strict` (como `socratic-gate.js`); `null` solo si el cwd no pertenece a ningún proyecto.
- `EngineTask` añade `threadId?` (hilo de Codex o `conversation_id` de agy) y `contextChars` (0 sin paquete). `prompt` es el del usuario, sin el paquete de contexto.
- `sesiones_engine_run`: con `kind: 'opinion'` e `includeContext: true` el prompt puede ir vacío. Codex: `task` con sandbox `workspace-write`, `opinion` con `read-only`; la continuidad (`codex exec resume <hilo>`) es por sesión y solo en modo local. Codex Cloud limita el prompt a 28 000 caracteres (va como argumento). Gemini: `agy --input-format stream-json --output-format stream-json --print=` con el prompt como NDJSON por stdin (`{"event":"user","message":{"content":…}}`); `task` añade `--mode accept-edits`; sin continuidad de hilo.
- `sesiones_engine_bring({ taskId, sessionId })` como el de Codex. Se emite `sesiones://engine` para todas las tareas (el alias `sesiones://codex` ya no se emite). `sesiones_codex_list` devuelve solo las de Codex.
- `sesiones_kanban_move`: `column` admite id, nombre o rol (`todo|doing|blocked|done`); la tarjeta va al final. No lanza el PTY de RunBatch que dispara `kanban_move_card` al entrar en «In Progress».
- `sesiones_hooks`: `errors24h` cuenta solo `hook-errors.jsonl` (un `exit_code` ≠ 0 no es error: los guardarraíles bloquean con 2). Los registros no guardan el evento, así que un hook en dos eventos comparte métricas.
- `sesiones_bitacora`: sin `estado.json` devuelve la bitácora vacía con `updatedAt: null`.
- `capabilities/sesiones.json`: los comandos propios no necesitan permiso (no hay AppManifest de comandos); solo cambia la descripción. Título de la ventana: «ULTRON Sessions».

Frontend, 2026-10-07:

- Argumentos: los comandos con `({ … })` se invocan como en v0.1, cada campo como parámetro de primer nivel en camelCase (`invoke("sesiones_set_effort", { id, effort })`).
- `sesiones_kanban_move`: la UI manda el **id** de la columna y usa el `KanbanBoard` devuelto; si falla, recarga con `sesiones_kanban`.
- El HUD ofrece `claude-opus-5-5`, `claude-opus-5-5[1m]` y `claude-sonnet-5-5`.
- `EngineTask.sessionId` es lo que coloca la intervención en la línea de tiempo de su sesión (se intercala por `startedAt`); sin él solo aparece en la pestaña Motores. `contextChars` se muestra en la cabecera del bloque; `threadId` se tipa pero no se pinta.
- El frontend escucha solo `sesiones://engine` (el reducer deduplica por id); el alias `sesiones://codex` se retiró del backend y del frontend el 2026-10-17. Ya no llama a ningún `sesiones_codex_*`.
- «Segunda opinión» manda `kind: 'opinion'`, `includeContext: true` y un prompt con la respuesta citada (recortada a 6 000 caracteres), no vacío.
- Temas: token nuevo `gemini` en los cuatro temas (contraste AA en el test). `--f-chat` es monoespaciada en todos (E2); `chatMono` queda obsoleto.
- Mock: `?mock=1&sinMotor=gemini` simula Gemini ausente. En el mock, `sesiones_set_effort` con `max` falla a propósito (camino de error del HUD); el backend real lo admite.

Integración, 2026-10-07 (tras la primera prueba real):

- **PTY sin terminal**: portable-pty crea la ConPTY con `PSEUDOCONSOLE_INHERIT_CURSOR`; conhost pide la posición del cursor (`ESC[6n`) y no lanza el hijo hasta recibir respuesta. Sin xterm enganchado el lector del PTY responde `ESC[1;1R` y quita la consulta del búfer (`pty/ops.rs`). Era la causa de que ningún mensaje llegara a Claude.
- **Entorno heredado**: si la app se lanzó desde una sesión de Claude Code, el `claude` del PTY heredaba `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`… y no escribía transcript (el texto en vivo aparecía y desaparecía al cerrar el turno). `pty::spawn` las quita al lanzar `claude`.
- **Varias ventanas**: `sesiones_new_window({ sessionId? }) -> string` abre `sesiones-<8 hex>` con `?win=<etiqueta>&session=<id>`. Los eventos `sesiones://*` se emiten a todas las ventanas de Sessions; cada ventana adicional guarda su espacio de trabajo en `sessionStorage`. Las preguntas pendientes se liberan al cerrar la última.
- **`/mejorar`**: `sesiones_mejorar({ id, draft, lastError? }) -> string`. Lo resuelve la app por la zona `light` del AI Router (mismo contexto y reglas que el mod `ultron-mejorar`) y el texto vuelve al composer sin enviarse. Sin borrador usa el último prompt del historial.
- **Barra lateral**: solo sesiones abiertas (se retiran las pasadas y el filtro). El inicio de `working` vive en el store (`workingSince`), así que abrir un chat no reinicia el contador.
- **Sin textos de ayuda**: fuera las indicaciones de teclado del placeholder, la paleta, el estado vacío y la línea «Trabajando».
- **Puntos de entrada**: el botón «Sessions» de las tarjetas de Projects se retira; Sessions se abre con el botón Claude, desde la bandeja («ULTRON Sessions») y con el acceso directo del escritorio (`control-center.exe --sesiones`, que en la copia viva llega por single-instance).
- **PATH**: lanzada desde el Explorador, la app heredaba un PATH sin `%USERPROFILE%\.local\bin` («'claude' not found on PATH»). Al arrancar, `env_path::refresh_from_registry` añade al PATH del proceso las entradas que falten del PATH de máquina y de usuario del registro.
- **Sin vista Terminal visible**: se retiran el conmutador chat/terminal del panel y de la barra superior, y el menú «terminal clásica» del botón Claude de Projects (también Mayús+clic). La vista Terminal queda solo como salida automática cuando la TUI muestra un diálogo que el puente no cubre (aviso «Abrir terminal» con la sesión en `waiting`).
- **Ajustes** (botón de engranaje en la barra superior): tema, escala de la interfaz (90-120 %, `zoom` de WebView2), mostrar el razonamiento, confirmar antes de terminar una sesión (doble clic en la ✕), y modelo y effort de las sesiones nuevas creadas desde Sessions. Se guardan en `localStorage` (`ultron.sesiones.prefs`). El modelo y el effort también se aplican a `sesiones_launch` (botón Claude de Projects): sin modelo ni effort en la petición, `gestor.rs` toma `launch_model` y `launch_effort` de las prefs del backend (`ajustes::prefs_actuales`).
- **Temas**: siete (Obsidiana, Vacío, Fósforo, Acero, Grafito, Medianoche, Ámbar), todos con contraste AA comprobado en test; Acero por defecto.
