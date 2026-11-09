# ULTRON Sesiones — contrato v0.1

> Las secciones de estado, cola, preguntas, comandos y puente quedan
> sustituidas por `CONTRATO-v3.md` (contrato de estabilidad, 2026-10-08).

Ventana de chat para Claude Code (y Codex) dentro del Control Center. Este
documento es el contrato entre las tres piezas que se construyen en paralelo:
backend Rust, frontend React y el mod puente. Quien implemente una pieza no
cambia el contrato sin anotarlo en «Cambios al contrato» al final.

## Decisiones (2026-10-07, delegadas por el usuario)

| # | Decisión | Por qué |
|---|----------|---------|
| D1 | Segunda ventana (`label: "sesiones"`) del mismo binario del Control Center, con su entrada en la barra de tareas. Se abre desde Projects. | Las sesiones (PTY) viven en el backend: cerrar la ventana no las mata y al reabrirla se reengancha. Reutiliza PTY, proyectos y git. |
| D2 | Motor: `claude` interactivo en un PTY oculto. | Cuenta contra el plan (no el crédito del SDK) y conserva todas las funciones del CLI. |
| D3 | Entrada de texto: se escribe en el PTY (bracketed paste + `\r`). | Fidelidad total: comandos `/`, `@ficheros`, imágenes por ruta, todo igual que tecleado. |
| D4 | Historial: el JSONL del transcript (`~/.claude/projects/<slug>/<id>.jsonl` y `subagents/`), seguido por el backend. | Fuente de verdad; si el puente falla, el chat sigue funcionando. |
| D5 | En vivo: mod `ultron-puente` dentro de cada sesión lanzada por Sesiones, que habla con el backend por HTTP en loopback: texto en streaming, herramientas, subagentes, uso, contexto, permisos y preguntas. | Permisos y AskUserQuestion se responden con botones sin tocar la TUI. |
| D6 | Vista «Terminal» (xterm.js) del mismo PTY como respaldo. | Lo que la vista de chat no pinte (diálogos raros, `/config`, login) sigue accesible: no se pierde nada. |
| D7 | Adjuntos de cualquier tipo (pegar, arrastrar o elegir). Imágenes, PDF y texto dentro de sus topes se guardan en `~/.ultron/adjuntos/AAAA-MM-DD/` y se mencionan como `@"<ruta>"`; del resto se añade al texto `Fichero adjunto (solo ruta): "<ruta original>"`. | Claude Code lee entero lo que se cita con `@`: un binario no aporta nada y un fichero de texto grande costaría tokens. |
| D8 | Codex: tareas en segundo plano `codex exec --json` (local) y `codex cloud exec` (si el proyecto tiene `codexCloudEnv`). Tarjeta con progreso y «Traer al chat». | «Enviar a Codex y que vuelva». |
| D9 | Espacio de trabajo: pestañas de sesiones + rejilla de hasta 4 paneles («juntar»). Un panel muestra una sesión o un subagente. | Varias terminales de trabajo bajo una misma app, separadas o juntas. |
| D10 | Temas: Obsidiana (negro puro, por defecto), Vacío, Fósforo y Acero. Selector en la barra superior. | Preferencia del usuario por el negro puro; elige entre opciones. |

Fuera de alcance: gestión de skills, MCPs o ajustes de Claude Code.

## Arquitectura

```
Ventana "sesiones" (React)  ──invoke/listen──►  Backend Rust (src-tauri/src/sesiones/)
                                                  ├─ PTY por sesión (claude, env ULTRON_PUENTE_*)
                                                  ├─ Seguidor de JSONL (transcript + subagentes)
                                                  ├─ Servidor HTTP loopback del puente
                                                  ├─ Adjuntos, git, uso del plan, Codex
   claude (PTY) ─ mod ultron-puente ──HTTP──►  servidor del puente
```

## 1. Backend Rust — comandos Tauri

Módulo nuevo `src-tauri/src/sesiones/` (submódulos de 200-400 líneas). Todos
los comandos devuelven `Result<T, String>` con errores en español. Tipos en
`camelCase` vía `#[serde(rename_all = "camelCase")]`.

```ts
// Tipos compartidos (el frontend los replica en src/sesiones/types.ts)
type SessionId = string            // id interno de Sesiones (uuid), estable mientras viva el PTY
type Engine = 'claude' | 'codex'

interface SessionInfo {
  id: SessionId
  projectId: string | null
  projectName: string
  cwd: string
  title: string                    // primer prompt recortado o nombre puesto por el usuario
  claudeSessionId: string | null   // uuid del transcript, cuando el puente o el JSONL lo revelen
  status: 'starting' | 'idle' | 'working' | 'waiting' | 'exited'
  model: string | null
  startedAt: string                // ISO
  bridgeConnected: boolean
}

interface PastSession {            // transcripts cerrados que se pueden reanudar
  claudeSessionId: string
  cwd: string
  projectName: string
  preview: string
  lastActivity: string
}

// Mensajes normalizados desde el JSONL
type Block =
  | { kind: 'text'; text: string }                          // markdown
  | { kind: 'thinking'; text: string }
  | { kind: 'image'; mediaType: string; dataUrl?: string; path?: string }
  | { kind: 'toolUse'; id: string; name: string; input: unknown; summary: string }
  | { kind: 'toolResult'; toolUseId: string; isError: boolean; text: string; images?: string[] }

interface ChatMessage {
  uuid: string
  role: 'user' | 'assistant' | 'system'
  timestamp: string
  blocks: Block[]
  agentId: string | null           // null = hilo principal
  model?: string
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

interface AgentNode {
  agentId: string
  parentAgentId: string | null
  type: string                     // code-reviewer, Explore, fork, codex…
  description: string
  status: 'running' | 'done' | 'error'
  startedAt: string
  turns: number
  tokens: number
  maxTurns: number | null          // frontmatter de ~/.claude/agents/<tipo>.md (caché 60 s); null si no lo declara o el tipo no es un nombre simple (plugin:x)
}
```

| Comando | Firma | Notas |
|---------|-------|-------|
| `sesiones_open_window` | `(projectId?: string) -> ()` | Crea o enfoca la ventana `sesiones`. Con `projectId`, emite `sesiones://focus-project`. |
| `sesiones_list` | `() -> SessionInfo[]` | Sesiones vivas. |
| `sesiones_rail_report` | `(report: { dpr, rail: CssRect \| null, items: { id, rect: CssRect, clip: 'full' \| 'partial' \| 'above' \| 'below' }[], composer?: CssRect \| null }) -> ()` | La ventana que invoca publica dónde están sus filas de la columna izquierda (px CSS del viewport; `CssRect = { x, y, w, h }`). La etiqueta sale de la ventana, no del payload; solo ventanas de Sessions. Se valida: `dpr` en (0,25, 8], como mucho 200 filas, ids `[A-Za-z0-9_-]{1,64}`, números finitos. Se olvida al cerrar la ventana. `composer` es el cuadro de texto del chat (`.composer .cbox`; opcional, ancho y alto > 0). Lo lee la mascota: `mascot_sessions_target` (filas) y `mascot_sessions_surfaces` (el borde superior del cuadro es una plataforma; los laterales de la ventana, paredes por las que trepa). |
| `sesiones_focus_session` | `(sessionId: string, window?: string) -> string` | Enfoca la ventana `window` (si es de Sessions y está abierta; si no, la principal o cualquier otra) y emite `sesiones://focus-session`; sin ventanas abre la principal con `?session=<id>`. Devuelve la etiqueta. Error si la sesión no existe. Lo usa el clic en Pupus con un aviso. |
| `sesiones_past` | `(projectId?: string, limit?: number) -> PastSession[]` | Reutiliza `claude_sessions.rs`. |
| `sesiones_create` | `({ projectId?, cwd, resume?: string, model?: string }) -> SessionInfo` | Lanza `claude` (o `claude --resume <id>`) en PTY 160×48 con env `ULTRON_PUENTE_URL`, `ULTRON_PUENTE_TOKEN`, `ULTRON_SESION_ID`. Usa `pty::spawn` existente (resolver `.cmd`, `strip_api_key_for_claude`). |
| `sesiones_send` | `({ id, text, attachments: string[] }) -> ()` | Escribe en el PTY: `ESC[200~` + texto + ` @"ruta"` por adjunto + `ESC[201~` + `\r`. |
| `sesiones_key` | `({ id, key: 'escape' \| 'ctrlC' \| 'enter' \| 'shiftTab' \| 'up' \| 'down' \| 'tab' \| 'raw', data?: string }) -> ()` | Teclas especiales (interrumpir = escape). |
| `sesiones_kill` | `(id) -> ()` | Mata el PTY, quita la sesión de `abiertas.json` y olvida sus notas de restauración (CONTRATO-v3 §8). |
| `sesiones_rename` | `({ id, title }) -> ()` | |
| `sesiones_history` | `({ id, agentId?: string, beforeUuid?: string, limit?: number }) -> { messages: ChatMessage[], hasMore: boolean }` | Paginado desde el final: devuelve hasta `limit` mensajes (400 por defecto, máximo 2000) anteriores a `beforeUuid`, del JSONL de la sesión o del subagente (`sesiones/pagina.rs`). |
| `sesiones_agents` | `(id) -> AgentNode[]` | |
| `sesiones_terminal_attach` | `(id) -> string` | Devuelve el búfer del PTY (base64) y activa la emisión en vivo `sesiones://pty/<id>`. |
| `sesiones_terminal_detach` | `(id) -> ()` | |
| `sesiones_terminal_resize` | `({ id, cols, rows }) -> ()` | Redimensiona el PTY y la pantalla emulada; la TUI se repinta entera. El bloque de menú lo llama al abrirse y al cambiar de tamaño. |
| `sesiones_terminal_restore_size` | `(id) -> ()` | Vuelve al tamaño de lanzamiento (160x48) al cerrar el bloque de menú. |
| `sesiones_answer` | `({ askId, answer: AskAnswer }) -> ()` | Responde a un permiso o pregunta pendiente del puente. |
| `sesiones_save_attachment` | `({ name, dataBase64, mediaType }) -> { path, previewDataUrl }` | Guarda en `~/.ultron/adjuntos/AAAA-MM-DD/<uuid>-<nombre>`. Máx. 20 MB de cualquier tipo; las extensiones de texto, máx. 256 KB. El composer solo copia lo que Claude Code puede leer, o cualquier fichero si no consigue su ruta original. |
| `sesiones_read_image` | `(path) -> string` | data URL de una imagen local (para mostrar imágenes de herramientas o adjuntos). Solo rutas bajo `$HOME`. |
| `sesiones_paths_status` | `(paths: string[]) -> PathStatus[]` | Estado en disco de rutas citadas en la sesión (pestaña Adjuntos), en el mismo orden. `PathStatus = { path, abs: string \| null, exists, isFile, canOpen, size: number \| null, error: string \| null }`. Las rutas van absolutas: el cliente resuelve las relativas contra el cwd (`rutas-sesion.ts`) y una relativa recibe `error` «ruta relativa sin directorio de trabajo». Validación por ruta (`archivos::resolve_under`): vacía, de red o de dispositivo (`\\host\…`, `//host/…`, `\\?\UNC\…`, `\\.\…`, `\??\…`, también `\\?\C:\…`) se rechaza **antes de tocar el disco** (comprobar una UNC abriría una conexión SMB que entrega el hash NTLM); con `..`, inexistente o fuera de `$HOME` tras `canonicalize`, `exists: false` y el motivo en `error`. Un directorio sale con `exists: true`, `isFile: false` y `error` «no es un fichero». `canOpen` = `isFile` y extensión en `ABRIBLES` (abajo) sin `:` en el nombre. Un rechazo por ruta no hace fallar el comando; solo falla con más de 500 rutas (`MAX_RUTAS_ESTADO`) o sin directorio personal. En TS: `api.pathsStatus(paths)`. |
| `sesiones_turn_edits` | `(id, since: string) -> string[]` | Ficheros distintos que editaron `Write`, `Edit`, `MultiEdit` y `NotebookEdit` desde `since` (ISO), leídos del transcript del hilo principal y de los subagentes escritos desde entonces; máx. 500. Lo usa la segunda opinión automática, porque la ventana poda los mensajes de los turnos largos. |
| `sesiones_open_file` | `(path: string, cwd?: string) -> ()` | Abre un fichero citado con la app del sistema (botón «Abrir» de Adjuntos y rutas que no son código en el chat). Misma resolución que `sesiones_paths_status`, con `cwd` (absoluto) para las relativas; el `cwd` también se rechaza si es de red o de dispositivo. Error si no es un fichero o si su extensión no está en `ABRIBLES`: medios (imagen, vídeo, audio), pdf, texto y datos (`txt`, `md`, `log`, `csv`, `tsv`, `json`, `yaml`, `yml`, `toml`), ofimática, comprimidos y modelos 3D (`glb`, `gltf`, `obj`, `fbx`, `stl`). Fuera quedan ejecutables y scripts (`.exe`, `.bat`, `.ps1`, `.js`, `.lnk`…), que el sistema ejecutaría, y lo que el navegador abriría con sus scripts: `.html`, `.htm`, `.xhtml`, `.svg`, `.mht`, `.hta` y `.xml`; para ellos queda «Abrir carpeta» (`sesiones_reveal_path`). En TS: `api.openFile(path, cwd)`. |
| `sesiones_git` | — | **Retirado**: no está registrado en `handlers.rs`. El frontend llama directamente a `git_repo_snapshot`, `git_diff_file` y `git_commit`. |
| `sesiones_usage` | `(force?: bool) -> PlanUsage` | Muestra local de `logs/usage-history.jsonl` si tiene menos de 5 min y ninguna ventana se ha reiniciado; si no, endpoint OAuth de `plan_limits.rs` con caché y espera exponencial tras un fallo (60 s ×2, tope 15 min). `force` (Actualizar) salta la muestra local, la caché y la espera; dos forzados en 5 s comparten la llamada. |
| `sesiones_usage_pace` | `(force?: bool) -> UsoPace` | Ritmo del mod `ultron-uso` más `stale`, `source`, `fetchedAtMs` y `lastError` del uso. `force` como en `sesiones_usage`. En TS: `api.usage({force})` y `api.usagePace({force})`. |
| `sesiones_engines_usage` | `(force?: bool) -> EnginesUsage` | Uso de las suscripciones de Codex (último `rate_limits` de `~/.codex/sessions`, con caché de 60 s en `~/.ultron/.tmp/codex-usage.json` invalidada por ruta, mtime y tamaño del rollout más nuevo) y agy (`agy -p /usage`, con caché de 5 min; sin cuota, actividad de los transcripts). Lo calcula `scripts/engine-usage.mjs --json`, el mismo lector que la statusline y `usage-outlook.mjs`. `force` salta las dos cachés. La pestaña Uso sondea cada 2 min, por debajo de la caché de agy, para que agy corra como mucho una vez cada 5 min. En TS: `api.enginesUsage({force})`. |
| `sesiones_codex_start` | — | **Retirado**: no está registrado en `handlers.rs`. Sustituido por `sesiones_engine_run` (CONTRATO-v2). |
| `sesiones_codex_list` | — | **Retirado**: no está registrado en `handlers.rs`. Sustituido por `sesiones_engine_list`. |
| `sesiones_codex_cancel` | — | **Retirado**: no está registrado en `handlers.rs`. Sustituido por `sesiones_engine_cancel`. |
| `sesiones_codex_bring` | — | **Retirado**: no está registrado en `handlers.rs`. Sustituido por `sesiones_engine_bring`. |

```ts
type AskAnswer =
  | { kind: 'permission'; decision: 'allow' | 'allowAlways' | 'deny'; reason?: string }
  | { kind: 'question'; answers: Record<string, string> }   // pregunta -> opción elegida o texto
  | { kind: 'plan'; approve: boolean; feedback?: string }

interface CodexTask {
  id: string; mode: 'local' | 'cloud'; cwd: string; prompt: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  startedAt: string; finishedAt?: string
  events: { kind: 'message' | 'command' | 'patch' | 'error'; text: string }[]   // últimos 200
  summary?: string; cloudTaskId?: string
}
```

### Eventos emitidos a la ventana `sesiones`

| Evento | Payload |
|--------|---------|
| `sesiones://sessions` | `SessionInfo[]` (cada cambio de estado) |
| `sesiones://messages` | `{ id, messages: ChatMessage[] }` líneas nuevas del JSONL (incluye subagentes) |
| `sesiones://stream` | `{ id, agentId: string \| null, turnId, text, thinking?: string, done: boolean }` texto en vivo del puente |
| `sesiones://tool` | `{ id, agentId, toolUseId, name, summary, phase: 'start' \| 'end', isError?: boolean }` |
| `sesiones://agents` | `{ id, agents: AgentNode[] }` |
| `sesiones://ask` | `Ask` (abajo) |
| `sesiones://ask-resolved` | `{ askId }` (respondido en la ventana, en la TUI o caducado) |
| `sesiones://status` | `{ id, model, contextTokens, contextWindow, costUsd?, mode? }` |
| `sesiones://pty/<id>` | `string` base64 de bytes del PTY (solo con terminal enganchado) |
| `sesiones://engine` | `EngineTask` (el alias `sesiones://codex` de v0.1 se retiró el 2026-10-17) |
| `sesiones://focus-project` | `{ projectId }` |
| `sesiones://focus-session` | `{ sessionId }` (solo a la ventana elegida por `sesiones_focus_session`; una sesión que la ventana no conoce se ignora) |
| `sesiones://new-in-cwd` | `{ cwd }` (solo a la ventana principal: `control-center.exe --sesiones-cwd <ruta>` con la ventana ya abierta; crea una sesión de Claude en esa carpeta con el último perfil usado) |

```ts
type Ask =
  | { askId: string; id: SessionId; kind: 'permission'; tool: string; input: unknown; summary: string; reason?: string; agentId: string | null }
  | { askId: string; id: SessionId; kind: 'question'; questions: { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] }[] }
  | { askId: string; id: SessionId; kind: 'plan'; plan: string }
```

## 2. Protocolo del puente (mod ↔ backend)

Servidor HTTP/1.1 en `127.0.0.1:<puerto dinámico>` (crate `tiny_http` u
otro pequeño), arrancado con la app. Cabecera obligatoria
`Authorization: Bearer <ULTRON_PUENTE_TOKEN>` (token aleatorio por lanzamiento: `gestor` lo rota en cada uno);
sin ella, 401. Cuerpos JSON. El mod solo se activa si existen
`ULTRON_PUENTE_URL`, `ULTRON_PUENTE_TOKEN` y `ULTRON_SESION_ID`; si no, no hace
nada (sesiones de terminal normales intactas).

| Método y ruta | Cuerpo | Respuesta |
|---------------|--------|-----------|
| `POST /v1/hello` | `{ sesionId, claudeSessionId, cwd, model, transcriptPath? }` | `{ ok: true }` |
| `POST /v1/events` | `{ sesionId, events: PuenteEvent[] }` (lotes cada ≤ 80 ms) | `{ ok: true }` |
| `POST /v1/ask` | `{ sesionId, ask: Ask sin askId ni id }` | Bloquea hasta respuesta o 10 min: `{ answer: AskAnswer }` o `{ answer: null }` si no hay ventana abierta (en ≤ 300 ms) o caduca |

```ts
type PuenteEvent =
  | { type: 'turnStart'; turnId: string; agentId?: string }
  | { type: 'text'; turnId: string; agentId?: string; delta: string }
  | { type: 'thinking'; turnId: string; agentId?: string; delta: string }
  | { type: 'turnEnd'; turnId: string; agentId?: string; reason: string }
  | { type: 'tool'; toolUseId: string; agentId?: string; name: string; summary: string; phase: 'start' | 'end'; isError?: boolean }
  | { type: 'agentSpawn'; agentId: string; parentAgentId?: string; agentType: string; description: string }
  | { type: 'agentEnd'; agentId: string; isError: boolean }
  | { type: 'status'; model: string; contextTokens: number; contextWindow: number; costUsd?: number }
  | { type: 'ready' }   // tras session.start: el PTY acepta entrada
```

Comportamiento del mod (`~/.ultron/mods/ultron-puente/`):

- `session.start` → `hello` y `ready`.
- `turn.step` (generador asíncrono, `yield* next(e)` sin alterar nada) → `text`/`thinking` deltas, en lotes.
- `tool.call` → `tool` start/end (resumen corto: ruta, comando, patrón).
- `agent.spawn` / `turn.complete` con `agentId` → `agentSpawn`/`agentEnd`.
- `session.measure` → `status`.
- `tool.check`: `const v = await next(e)`; si `v.decision === 'ask'` → `POST /v1/ask` (permission). `allow`/`allowAlways` → `{ decision: 'allow' }` (`allowAlways` además guarda la regla vía `ultron-permisos` si está: clave de `$.store` compartida no; basta con devolver allow y emitir un `tool` con nota); `deny` → `{ decision: 'deny', reason }`; `null` → `v` (decide la TUI).
- `tool.call` de `AskUserQuestion` → `POST /v1/ask` (question); con respuesta, devolver `{ result }` con la forma de salida del tool (ver `claude-code-tools`); con `null`, `next(e)`.
- `tool.call` de `ExitPlanMode` → `POST /v1/ask` (plan); igual.
- Todo con `.catch` que deje pasar: el puente nunca rompe la sesión.

## 3. Frontend — ventana `sesiones`

- Entrada Vite propia: `sesiones.html` + `src/sesiones/main.tsx` (multi-page en `vite.config.ts`). No importa nada pesado del Control Center.
- Estructura (`src/sesiones/`): `App.tsx`, `api.ts` (wrapper de invoke/listen, y un adaptador `mock` con datos de ejemplo activado con `?mock=1` para desarrollo y e2e), `store.ts` (estado por sesión, `useSyncExternalStore` o reducer; inmutable), `components/` (Sidebar, Tabs, Grid, ChatPane, Message, Markdown, ToolRow, AskCard, Composer, Inspector/{Agentes,Git,Contexto,Uso,Adjuntos,Codex}, TerminalPane, ThemePicker), `themes.ts`, `types.ts`.
- Maqueta aprobada: https://claude.ai/artifact/49teH5JmsyfZ3kY7LCcxge (estructura y tono; los colores pasan a los temas).
- Markdown: `react-markdown` + `remark-gfm` (ya están) + resaltado de código (`rehype-highlight` o `shiki` ligero), tablas con scroll propio, botón copiar en bloques de código, imágenes en línea con visor a pantalla completa.
- Composer: textarea autoajustable; Enter envía, Shift+Enter salto; pegar imagen del portapapeles (`paste` con `clipboardData.files`) y arrastrar ficheros → `sesiones_save_attachment` → chip con miniatura; `/` abre autocompletado de comandos conocidos (incluye `/mejorar`, `/relevo`, `/compilar`, `/probar`, `/arrancar`, `/compact`, `/clear`, `/model`); `@` autocompleta ficheros del proyecto (git ls-files vía comando existente o uno nuevo); botón Interrumpir (escape) mientras trabaja; selector «Enviar a: Claude | Codex local | Codex Cloud». Con Claude trabajando (CONTRATO-v3 §3.4): Ctrl+Enter «Enviar ya», Ctrl+Mayús+Enter «Interrumpir y enviar», Ctrl+B «Segundo plano» de la herramienta en curso y Ctrl+Mayús+D alterna «Subagente».
- Chat: mensajes del JSONL; burbuja en vivo con el streaming hasta que llega el mensaje definitivo; herramientas plegadas en filas (nombre, resumen, +/− en ediciones, estado); resultados expandibles; imágenes; tarjetas `Ask` (permiso con Permitir / Siempre / Denegar; pregunta con opciones y «Otro»; plan con Aprobar / Pedir cambios).
- Espacio de trabajo: barra lateral con sesiones (vivas y pasadas por proyecto, nueva sesión Claude o Codex), pestañas arriba; arrastrar una pestaña a un borde divide (máx. 2×2); cada panel tiene selector de sesión/subagente; atajos Ctrl+1..4 foco de panel, Ctrl+T nueva sesión, Ctrl+W cerrar panel, Ctrl+F buscar en el hilo y Ctrl+B «Segundo plano» en la sesión del panel con foco. Estado de la disposición en `localStorage`.
- Inspector derecho (plegable): Agentes (árbol en vivo; clic abre el transcript del subagente en el panel o en uno nuevo), Git (ficheros, diff, commit), Contexto (tokens / ventana, barra por categoría estimada, aviso de compactar), Uso (5 h y semanal con barra y reset), Adjuntos (de la sesión, miniaturas), Codex (tareas, eventos, Traer al chat, Cancelar).
- Barra superior: proyecto y rama, modelo y modo, uso del plan, selector de tema, botón Terminal (alterna la vista xterm del PTY en el panel).
- Temas (tokens CSS, `data-theme` en `html`): **Obsidiana** fondo `#000000`, superficies `#0a0a0a/#111`, línea `#1c1c1c`, texto `#e8e8e8`, acento cobre `#d08a5c`; **Vacío** negro puro con acento cian frío `#6fd3e8`; **Fósforo** negro puro con acento verde fósforo `#7cf29a` y mono para todo el chat; **Acero** el de la maqueta. Fuentes: Geist (UI), Geist Mono (código), Chakra Petch (marca y títulos), empaquetadas con `@fontsource` (la CSP no permite Google Fonts).
- Rendimiento: lista de mensajes virtualizada a partir de 300 mensajes; streaming con `requestAnimationFrame`; sin re-render global por delta.
- Accesibilidad: foco visible, roles en pestañas, `prefers-reduced-motion`.
- Projects: botón «Abrir en Sesiones» en cada tarjeta y en el detalle del proyecto → `sesiones_open_window(projectId)`.

## 4. Verificación

- Rust: tests unitarios del parser de JSONL (fixtures reales anonimizados), del protocolo del puente (401 sin token, ask sin ventana devuelve `null`), de `sesiones_send` (secuencia de bytes) y de adjuntos (ruta, tamaño). `cargo test` y `cargo clippy` limpios.
- Mod: `claude plugin validate` y `claude plugin test` con casos de ask permitido/denegado/sin ventana y AskUserQuestion respondido.
- Frontend: `tsc`, `vitest` de store y markdown, y un e2e Playwright con `?mock=1` que abre la ventana, envía un prompt, responde un permiso y divide en dos paneles.
- Integración: `npm run build:local`, abrir Sesiones desde Projects, crear sesión real en un proyecto de prueba, enviar «di hola», ver la respuesta en markdown y el streaming.

## Cambios al contrato

- 2026-10-07 · mod `ultron-puente` · `ExitPlanMode` aprobado no devuelve `{ result }`: un resultado propio no saca del modo plan (la API de hooks no tiene un setter de modo). Al aprobar, la herramienta real sigue (`next(e)`) y `classic.PermissionRequest` la aprueba sin diálogo con `setMode: default` (destino `session`; en subagentes, sin `setMode`). Al rechazar, `{ deny }` con los cambios pedidos. El texto del plan sale de `e.plan` si existe o del `planFilePath` de los recordatorios `plan_mode`; sin plan, decide la TUI.
- 2026-10-07 · backend · `sesiones://stream`: `text` y `thinking` son **deltas** (el frontend acumula por `turnId`); `done: true` llega sin texto y cierra el turno.
- 2026-10-07 · backend · `ChatMessage` es **una línea del JSONL**: Claude Code escribe cada bloque del asistente en su propia línea con el mismo `message.id`, así que un turno llega como varios mensajes consecutivos. `usage` solo va en el primero de cada `message.id` (sumar sin duplicar). Los bloques `thinking` vacíos (solo firma) se omiten. El texto de `toolResult` se recorta a 20 000 caracteres. Los mensajes de usuario `isMeta` o que empiezan por `<local-command`, `<command-name>`, `<task-notification>` o `<system-reminder>` llegan con `role: 'system'`.
- 2026-10-07 · backend · `sesiones://messages` puede repetir mensajes (reanudación o cambio de transcript al llegar el `hello`): el frontend deduplica por `uuid`. Los lotes son de hasta 200 mensajes.
- 2026-10-07 · backend · `sesiones_open_window(projectId)` con la ventana recién creada pasa el proyecto en la URL (`sesiones.html?project=<id>`), porque aún no escucha `sesiones://focus-project`; con la ventana ya abierta se emite el evento.
- 2026-10-07 · backend · `sesiones_save_attachment` acepta base64 puro o `data:` URL; el tipo se deduce de la extensión (`mediaType` es informativo). `previewDataUrl` es `null` si no es imagen. Imágenes admitidas: png, jpg, jpeg, gif, webp, bmp (SVG no); además pdf y extensiones de texto y código.
- 2026-10-07 · backend · `PlanUsage = { fiveHour: { percent, resetsAt } | null, sevenDay: { percent, resetsAt } | null, subscriptionType: string | null, stale: boolean }`. `sesiones_git` devuelve el `GitRepoSnapshot` existente (`{ state, changes }`).
- 2026-10-07 · backend · `CodexTask` añade `sessionId?` (sesión desde la que se lanzó). En `cloud`, el prompt va como argumento tras `--` (`codex cloud exec` no lee stdin); el entorno sale de `codexCloudEnv` del proyecto de la sesión o del que tenga `path == cwd`.
- 2026-10-07 · backend · Estados sin puente: `starting` pasa a `idle` al localizar el transcript o a los 4 s; `sesiones_send` pone `working` (y el título si aún es automático); un `end_turn` del hilo principal pone `idle`. La salida natural del PTY deja la sesión en `exited` hasta `sesiones_kill`, que la quita de la lista.
- 2026-10-07 · backend · Puente: 400 cuerpo o JSON no válido, 404 ruta o `sesionId` desconocidos, 405 método distinto de POST, 413 cuerpo de más de 4 MiB. Los `ask` pendientes se resuelven con `null` al cerrarse la ventana o terminar la sesión. `ULTRON_SESION_ID` va siempre; `ULTRON_PUENTE_URL`/`TOKEN` solo si el puente arrancó.
- 2026-10-07 · backend · `AgentNode.parentAgentId` solo lo aporta el puente (`agentSpawn`); los subagentes leídos del disco llegan con `null`. Sin `end_turn` y sin escrituras en 10 min, un subagente se da por `done`.
- ~~2026-10-07 · backend · Las sesiones de Sesiones heredan `--dangerously-skip-permissions` salvo `claude_safe_mode: true` en `features.json`~~ Sustituido: se lanzan con `--permission-mode` (`lanzamiento.rs`), nunca con esa bandera.
- 2026-10-07 · frontend · Comando opcional `sesiones_files(cwd) -> string[]` (ficheros del proyecto, p. ej. `git ls-files`) para el autocompletado de `@`. Mientras no exista, el frontend usa los ficheros cambiados de `git_repo_snapshot`.
- 2026-10-07 · frontend · Al abrir la ventana no hay comando para leer los `ask` pendientes ni el último `status`: el frontend espera que el backend los reemita al crear o enfocar la ventana (si no, una pregunta abierta antes de abrirla no se ve hasta la siguiente).
- 2026-10-07 · frontend · Varias líneas consecutivas del asistente (mismo turno) se pintan como un solo bloque: solo la primera lleva cabecera. Los mensajes `role: 'system'` se muestran plegados.
- 2026-10-14 · backend · `PlanUsage` añade `source: 'local' | 'oauth'`, `fetchedAtMs` y `lastError?` (motivo del último fallo con `stale`); las ventanas cuyo `resetsAt` ya pasó se descartan, también en la caché. `sesiones_usage` y `sesiones_usage_pace` aceptan `force` (ver la tabla).
- 2026-10-19 · backend · Nuevo `sesiones_engines_usage` (ver la tabla) para el bloque secundario de Codex y agy en la pestaña Uso.
- 2026-10-14 · backend · `Usage.model?: string`, solo en `subagentUsage` de `sesiones://turn`: el modelo del subagente, que llega en el `turnEnd` del puente con `agentId`. Sin él, el uso se valora con el modelo de la sesión.
- 2026-10-14 · backend · `AgentNode.maxTurns` (ver el tipo): sale del frontmatter en el disco y en el `agentSpawn` del puente.
- 2026-10-14 · backend · Sesiones abiertas persistentes y restauradas al arrancar ULTRON (`~/.ultron/cockpit/sesiones/abiertas.json`), con su cola y sus notas: CONTRATO-v3 §8.
- 2026-10-14 · backend · Puente: token rotado en cada lanzamiento (401 para el proceso anterior), `claudeSessionId` con forma de UUID (400), `sesionId` obligatorio en `/v1/result` (400), 429 por encima de 32 asks pendientes por sesión, 409 a un lote de protocolo 2 sin `generation` y a un `hello` de otra instancia sin `claudeSessionId` con dueño en el PTY: CONTRATO-v3 §5.
- 2026-10-14 · backend · `StallReason` añade `startupTimeout` (subcondición de `starting`); `waiting.options` solo en `menu`, y su cambio reemite `sesiones://sessions`: CONTRATO-v3 §1. `SessionInfo.terminalAttached` lo rellena el backend (#31) y el reinicio sin transcript relanza como sesión nueva (#32): CONTRATO-v3 §1.
- 2026-10-14 · backend · El eco del transcript tras un `turnEnd` del puente pasa a `idle` si ya no hay pendientes y no llegó un `prompt` después (#41.3); `abiertas.json` se vuelca en la salida de ULTRON: CONTRATO-v3 §1 y §8.
- 2026-10-16 · backend · `SessionInfo.queuePause?` (pausa de la cola tras un cierre por plazo; «Enviar ahora» la levanta) y pasos nuevos de `sesiones_recover` (`turnoNuevo`, `retomaPorTarea`, `colaDevuelta`, `esc2`, `ctrlCOmitido`, `sinRespuesta`, `antirrebote`): CONTRATO-v3 §1.
- 2026-10-16 · backend · Comandos `sesiones_background(id)` (Ctrl+B verificado sobre la herramienta en primer plano) y `sesiones_interrupt_send(id, text, attachments?, clientId?, delegate?)` (interrumpir y enviar por delante de la cola), `SessionInfo.foregroundTool?` y guarda G5 del escritor (Ctrl+B solo con la pantalla `busy`, uno cada 1,5 s): CONTRATO-v3 §3.4.
- 2026-10-16 · backend + frontend · Coreografía de permisos de la mascota: comandos `sesiones_rail_report` (la columna de sesiones informa de sus filas al cambiar el layout, `rail-rects.ts`) y `sesiones_focus_session`, y evento `sesiones://focus-session`. Las filas llevan `data-session-id`. Ver la tabla.
- 2026-10-18 · backend · Puente: tope del cuerpo por ruta (4 MiB `events` y `result`, 1 MiB `ask` y `fill`, 64 KiB el resto; 413 por encima) y plazo de cada conexión: 60 s por lectura (una conexión callada recibe 408 o se cierra; un cuerpo a medias, 400) y 30 s por escritura.
- 2026-10-19 · backend · Comandos `sesiones_paths_status` y `sesiones_open_file` para la pestaña Adjuntos (ver la tabla). Las rutas de red y de dispositivo se rechazan sin acceder al disco, y `.html`, `.htm`, `.svg` y afines ya no se abren con la app por defecto.
- 2026-10-19 · backend + frontend · Comando `sesiones_turn_edits` (ver la tabla): la segunda opinión automática cuenta los ficheros del turno sobre el transcript y suma los que solo tenga la ventana; si el backend falla, avisa y cuenta solo la ventana.
- 2026-10-28 · backend + frontend · Argumento `--sesiones-cwd <ruta>` (también `--sesiones-cwd=<ruta>`; `sesiones/abrir_carpeta.rs`), para la entrada «ULTRON Sessions aquí» del menú contextual del Explorador: valida la ruta (absoluta, sin `..`, carpeta existente; error en el log y en un diálogo) y abre Sessions con una sesión nueva de Claude en esa carpeta. En frío o sin ventana, `sesiones.html?cwd=<ruta>` (el frontend lo quita de la URL antes de crear la sesión, para que una recarga no la repita); con la ventana abierta, evento `sesiones://new-in-cwd`. La carpeta se asocia al proyecto de `cockpit/projects.json` solo si coincide exactamente con su ruta (`gestor::find_project`); una subcarpeta queda sin proyecto.
- 2026-10-28 · backend + frontend · Relevo automático (`sesiones/relevo.rs`, `relevo_aviso.rs`, `relevo_prompt.rs`): un mensaje `<synthetic>` de cuota de Claude Code (`hit your … limit` o `limit reached`, con apóstrofo ASCII o tipográfico; nunca `rate limit`) o, como segunda señal, un mensaje sintético que hable de un límite con la muestra local de uso al 100 % crea una tarea `relay` en el mismo cwd. Cadena: OpenCode con la API de Anthropic (`anthropic/claude-sonnet-5-5`, solo si existe `ULTRON_KEY_ANTHROPIC_CREDITS`; `--auto`) → Codex (`danger-full-access`) → Gemini/agy (`accept-edits`, su máximo en headless) → error visible en la banda. Cada fallo escala una sola vez al motor siguiente aunque fallen dos tareas a la vez, y lo que se lance mientras se vuelve a Claude se cancela. El traspaso (último prompt, 12 mensajes de texto y `git status --short`) y el prompt de escalado (historial acotado a los 6 últimos turnos y la última petición pendiente del usuario) pasan por la redacción de secretos de memoria; en OpenCode el relevo va siempre como fichero adjunto (`-f`) y solo con la key de Anthropic. Las tareas de motores no heredan variables secretas de la app (`motores::command_for_task`). Los turnos de seguimiento a Gemini van con `includeContext: true` y reciben el traspaso y los turnos previos del relevo (agy no reanuda conversaciones). Vuelta: a la hora de reinicio de la ventana agotada (la de 5 h o la semanal, por la muestra local o por la hora/fecha del aviso: `1:20am`, `3pm`, `Oct 30, 9am`), sin turno en curso y si la muestra local no sigue al 100 %; los resultados se traen por la vía existente y el estado se limpia. Sin hora conocida, la banda dice que la vuelta es manual. `RelayState.limitKind` (`session` | `weekly`). `sesiones://relay` publica el estado por sesión; `sesiones_relay_list`, `sesiones_relay_switch_gemini` y `sesiones_relay_return` permiten restaurarlo y actuar. Límite: el estado vive solo en memoria; si la app se cierra a mitad, la tarea queda `cancelled` (`error` si la app se cae sin cerrar), no se escala, la banda desaparece y no hay vuelta automática (`sesiones_relay_list` solo restaura tras recargar la ventana).
- 2026-10-31 · backend + frontend · Adjuntos de cualquier tipo (D7). `sesiones_save_attachment` deja de filtrar por extensión. La ruta original de un `File` la da el host de WebView2 (`sesiones/ruta_fichero.rs`): la página llama a `chrome.webview.postMessageWithAdditionalObjects("ultronFilePath:<id>", [file])` y recibe `{ ultronFilePath: id, path }` por `chrome.webview` (`path` null fuera del origen de la app; un `File` sin fichero en disco hace lanzar a la API). La cadena llega también al IPC de Tauri, que deja un `console.error` inofensivo por adjunto. Sin tope de tamaño cuando hay ruta; sin ruta, se copia hasta 20 MB. Límite: la pestaña Adjuntos marca como no disponible una ruta fuera del directorio personal, aunque el mensaje la envíe.
- 2026-11-01 · backend · Auditoría de Sessions. (1) La cola se retiene por el límite de uso y por interrupción de forma persistente; ver `queuePause` en `CONTRATO-v3.md` (`reason`: `deadline`, `interrupted`, `usageLimit`). (2) Relevo: lo caro (transcript, `git status` con plazo de 5 s, lanzar el motor y volver a Claude) va en el hilo `sesiones-relevo`, no en el del seguidor; el traspaso lee el final del transcript, no el fichero entero. El reintento de OpenCode por sesión caducada valida la generación del relevo y, si no se puede lanzar, el turno sigue la vía de una tarea fallida (escala). `track_task` ya no cambia el motor activo. La poda de `motor` y `sesiones_engine_clear` conservan las tareas de un relevo vivo. Cerrar una sesión cancela sus motores en curso y olvida su relevo. (3) Barrera que se pierde en el relevo, declarada: Codex (`danger-full-access`), Gemini y OpenCode (`--auto`) salen sin intervención del usuario y sin los hooks de Claude Code (`guardrails-pre`, `deny-secrets`), que no corren en esos motores; un contenido no confiable citado en el texto reciente pasa al motor. Es la decisión vigente del propietario; lo único que lo acota es sacar los secretos del entorno. (4) Secretos: un solo clasificador (`motores::es_variable_secreta`) para motores y sesiones de Claude; estas conservan `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN` y `GITHUB_PERSONAL_ACCESS_TOKEN` (`.mcp.json` del plugin github). Efecto: `GITHUB_TOKEN` y demás `*_TOKEN` dejan de llegar a las sesiones de Claude. OpenCode con modelo explícito recibe solo la key de su proveedor, y `opencode models` solo la del consultado. (5) Rutas de red rechazadas por el texto, antes de tocar el disco, también en `sesiones_read_image`, `sesiones_files`, `sesiones_commands`, el cwd de una sesión nueva y `--sesiones-cwd`: una sesión en un UNC ya no funcionaba (quitar `\\?\` dejaba la ruta relativa `UNC\host\s`); una unidad de red con letra sigue valiendo. Los adjuntos y el destino de una exportación no llevan esta guarda: los elige el usuario en un diálogo o arrastrándolos, no vienen del texto del chat. (6) `/effort <nivel>` escrito desde el composer entra en la `Config` de Reiniciar y de la restauración; sin nivel (el menú de la TUI) o en cola, la nota avisa de que no se conserva. Tecleado en la terminal no se ve: tampoco se conserva. (7) El aviso de salida ya no dice que se pierde la cola (se guarda y se repone) y cuenta los motores en curso (`Ocupadas.engines`). Reiniciar con un relanzamiento fallido emite `ProcesoSalio`. Alcance: nada de esto se ha ejercitado con un límite real ni con motores reales; `observe`, `enter_relay`, `poll_return` y `return_to_claude` tienen tests con el lanzamiento de motores anulado.
- 2026-11-02 · backend + frontend · Estado de los subagentes. `AgentNode.status` añade `stale`: transcript sin escrituras en 10 min y sin fin de turno, que antes salía como `done` aunque el agente siguiera con una orden larga. Un `end_turn` seguido de `user` o `api-request` es una reanudación y vuelve a `running`, y un `done` del puente anterior a la última escritura ya no manda (`error` sí). `AgentNode.workflowRun` da el run de `Workflow`; el inspector agrupa por run, abierto mientras tenga agentes en marcha, y ordena lo vivo primero.
