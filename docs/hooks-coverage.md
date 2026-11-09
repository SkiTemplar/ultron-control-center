# Cobertura de eventos de hook de Claude Code (pilar 7)

Evaluación de los 30 tipos de hook que enumera `docs/GOAL.md` (pilar 7) y de los
3 que Claude Code ha añadido después. Fecha de todas las decisiones: 2026-10-23.

## Método

- **Versión instalada**: Claude Code 2.1.309 (`claude --version`).
- **Qué eventos existen**: la referencia oficial (`https://code.claude.com/docs/en/hooks`,
  tabla «Hook lifecycle») cruzada con la lista de eventos que lleva el propio binario
  instalado. Los 30 de `GOAL.md` existen en 2.1.309; **ninguno es inexistente**. La
  versión 2.1.309 trae tres más que `GOAL.md` no lista: `DirectoryAdded`,
  `PreModelSwitch` y `PostModelSwitch` (los dos últimos desde 2.1.251).
- **Estado**: lo que dice `hooks/manifest.json`, que es el espejo de
  `~/.claude/settings.json` (gate `node hooks/regen-manifest.js --check`).
- **Criterio para cablear**: que tenga consumidor real (alguien lee lo que produce o
  la decisión cambia algo) y que lo que aporta no lo haga ya otro hook. Cablear por
  completitud es un non-goal desde el plan ULTRON 4 del 2026-08-29.
- **Contexto de la máquina** que pesa en varias decisiones: las sesiones de ULTRON
  arrancan con el bypass de permisos por defecto (decisión del 2026-10-18), no se usan
  agent teams ni `--init`/`--maintenance`, y el inbox de memoria es autónomo
  (`inbox drain --auto` tras cada Stop, desde el 2026-07-13).
- **Interfaz**: la pestaña Hooks modela los 33 eventos
  (`control-center/src/components/hooks/hook-events.json`, compartido con
  `hooks_admin/validation.rs`), así que cualquiera de los no cableados se puede
  crear desde la UI si cambia la decisión.

## Resumen

| | Eventos |
|---|---|
| Cableados (14) | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `SubagentStart`, `SubagentStop`, `Stop`, `PreCompact`, `SessionEnd`, `PreModelSwitch`, `PostModelSwitch` |
| Retirado por decisión del mantenedor (1) | `FileChanged` |
| Descartados con motivo (18) | `Setup`, `UserPromptExpansion`, `PermissionDenied`, `PostToolBatch`, `MessageDisplay`, `TaskCreated`, `TaskCompleted`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `WorktreeCreate`, `WorktreeRemove`, `PostCompact`, `Elicitation`, `ElicitationResult` |

Los dos nuevos de esta revisión son `PreModelSwitch` y `PostModelSwitch`
(`hooks/scripts/model-family-guard.js`). El `Stop` pierde `response-meter`, que
escribía un log sin lector.

## Ideas de alto valor de `GOAL.md`

| Idea | Estado el 2026-10-23 |
|---|---|
| `FileChanged` → reindexar CodeGraph | Retirada. Lo hace el watcher del daemon de CodeGraph, que `ensure-codegraph.js` mantiene vivo en cada `SessionStart`. |
| `PreCompact`/`SessionEnd` → persistir estado y sincronizar el kanban | Persistir: cubierto (`precompact-preserve-l0`, `session-end-bitacora`, `lesson-distill`, `project-profile`). El kanban no se sincroniza solo: el resume cruza los «Cierres propuestos» de la bitácora con el kanban vivo (`lib/kanban-closures.js`) y avisa; el cambio de columna sigue siendo explícito con `scripts/kanban.mjs`. |
| `SubagentStop` → capturar candidatos de memoria | Cubierto: `subagent-harvest.js` propone un candidato `agent_note` vía `ultron-memory candidate` si el resultado no es trivial. |
| `PermissionDenied` → reintentar con otra ruta | Descartada: el evento solo salta con el modo `auto`, y ULTRON trabaja con bypass. |
| `PostToolUseFailure` → aprender del fallo | Cubierto: `posttoolfail-capture.js` propone un candidato `error_resolution` con la herramienta y el fragmento del error. |

## Evento por evento

### Cableados

| Evento | Script(s) según `manifest.json` | Qué aporta a ULTRON | Decisión (2026-10-23) |
|---|---|---|---|
| `SessionStart` | `ensure-codegraph`, `memory-session-resume`, `ensure-project`, `sessions-rich-format` (sync) | Daemon de CodeGraph vivo, resume del proyecto y bitácora, alta automática en `cockpit/projects.json`, formato rico en Sessions. Salta también con `source=compact`, así que reinyecta el resume tras compactar. | Se mantiene. |
| `UserPromptSubmit` | `socratic-gate`, `save-user-prompt`, `memory-orchestrate`, `session-feedback-capture`, `run-project-tests-report`, `context-guard`, `usage-pace-guard` (sync) | Protocolo socrático, archivo de prompts, tono, feedback, tests rotos, aviso de contexto y de ritmo de uso. | Se mantiene. |
| `PreToolUse` | `deny-secrets`, `document-convert-hint`, `codegraph-first`, `guardrails-pre`, `uni-deliverable-guard` (sync) | Bloqueos deterministas: credenciales, agentes inexistentes, la bandera de saltarse permisos, entregables universitarios; sugerencia de `markitdown`; desde el 2026-11-02, `codegraph-first` deniega una vez por sesión la segunda exploración de código sin CodeGraph (check 2.6). Desde el 2026-11-01, `deny-secrets` y `guardrails-pre` cubren también `Monitor`, que ejecuta shell. | Se mantiene. |
| `PermissionRequest` | `pupus-permission` (sync, tope de 660 s) | Lleva las peticiones de permiso al bocadillo de Pupus. | Se mantiene. Solo salta cuando el motor iba a preguntar: con el bypass por defecto es poco frecuente. |
| `PostToolUse` | `posttoolfail-capture` (async), `guardrails-post` (sync), `run-project-tests` (async) | Candidato de memoria ante un fallo con resultado, aviso de normas de contenido, suite del proyecto tras editar. | Se mantiene. |
| `PostToolUseFailure` | `posttoolfail-capture` (async) | Fallos en los que la herramienta ni se ejecutó (permiso, timeout, error del arnés). | Se mantiene. |
| `Notification` | `notify-relay` (async) | Reenvía las notificaciones a `~/.ultron/.tmp/notifications.log`. | Se mantiene. |
| `SubagentStart` | `subagent-lifecycle` (async) | Inicio de cada subagente para el monitor. | Se mantiene. |
| `SubagentStop` | `subagent-harvest`, `subagent-lifecycle` (async) | Resultado del subagente y candidato `agent_note`. | Se mantiene. |
| `Stop` | `stop-compress-session`, `batch-capture` (async) | Captura de candidatos de la sesión y drenaje autónomo del inbox; cola de comandos fallidos. | Se mantiene. **Se retira `response-meter`**: su único consumidor, la línea de concisión del resume, salió el 2026-09-29 (7ff38577) y `logs/response-meter.jsonl` crecía sin lector. |
| `PreCompact` | `precompact-preserve-l0` (sync) | Guarda los últimos hechos L0 en `~/.ultron/.tmp/l0/<session_id>.md` antes de compactar; el `SessionStart` de esa sesión los reinyecta como texto no confiable. | Se mantiene. |
| `SessionEnd` | `session-end-bitacora`, `lesson-distill`, `project-profile`, `session-feedback-mark`, `memory-gc` (async) | Bitácora, lecciones como candidatos, perfil del proyecto, feedback pendiente, mantenimiento semanal de `brain.db`. | Se mantiene. |
| `PreModelSwitch` | `model-family-guard` (sync) | Hace cumplir la regla «solo familia 5.5»: deniega `/model`, el selector, `/config` o un `set_model` del SDK hacia otro modelo. | **Cableado nuevo.** Valor alto (regla dura de modelos que hasta hoy solo cubrían los alias), coste bajo (un proceso por cambio de modelo). Verificado en vivo con `set_model` por stream-json: `claude-opus-4-6` y `claude-opus-5` denegados; `opus`, `haiku`, `claude-sonnet-5-5` y `claude-opus-5-5[1m]` aceptados. |
| `PostModelSwitch` | `model-family-guard` (sync) | Los cambios que no pasan por `PreModelSwitch` (fallback automático, resume) no se pueden bloquear; si dejan la sesión fuera de la familia 5.5, avisa al usuario y al modelo. | **Cableado nuevo**, mismo script. Verificado en vivo: el aviso llega como mensaje de sistema y el modelo lo recibe en el turno siguiente. |

### Retirado por decisión del mantenedor

| Evento | Qué aportaría | Decisión (2026-10-23) |
|---|---|---|
| `FileChanged` | Reindexar CodeGraph al cambiar un fichero. | Retirado: lo cubre el watcher del daemon de CodeGraph. Además el evento solo vigila nombres de fichero literales del matcher, no un árbol entero. |

### Descartados

| Evento | Qué aportaría a ULTRON | Decisión (2026-10-23) y motivo | Reabrir si… |
|---|---|---|---|
| `Setup` | Preparación única con `--init-only`, `--init` o `--maintenance`. | Descartado: ULTRON no arranca Claude Code con esas banderas; la instalación la hacen `install.ps1`/`install.sh`. | Se adopta `--init` en CI. |
| `UserPromptExpansion` | Contar o bloquear los `/comando` y `/skill` que se teclean. | Descartado: nadie leería esa serie y bloquear comandos tecleados no es una necesidad. | Se quiere medir el uso de skills. |
| `PermissionDenied` | Reintentar o reenrutar tras una denegación. | Descartado: solo salta en el modo `auto`; ULTRON no lo usa. | Se adopta el modo `auto`. |
| `PostToolBatch` | Revisar un lote de llamadas paralelas antes de la siguiente llamada al modelo. | Descartado: sería síncrono en el camino caliente y lo que se revisa por herramienta ya lo hacen `PostToolUse` y `PostToolUseFailure`. | — |
| `MessageDisplay` | Reescribir el texto que se muestra. | Descartado: el texto lo genera el modelo y las normas de contenido ya las avisa `guardrails-post`; reescribir lo mostrado sin que el modelo lo sepa confunde. | — |
| `TaskCreated` | Volcar las tareas de `TaskCreate` al kanban. | Descartado: las tareas de sesión son efímeras y el kanban de ULTRON se lleva a mano con `scripts/kanban.mjs` (el despacho de tarjetas está retirado). Volcarlas llenaría el Backlog de ruido. | Se decide que el kanban refleje las tareas de sesión. |
| `TaskCompleted` | Cerrar tarjetas del kanban al completar una tarea. | Descartado por lo mismo; el cierre de tarjetas ya lo detecta el resume con `lib/kanban-closures.js`. | Ídem. |
| `StopFailure` | Registrar los turnos que acaban por error de API (`rate_limit`, `overloaded`...). | Descartado: Claude Code ya enseña el error, el ritmo de cuota lo vigila `usage-pace-guard` antes de agotarla y la memoria se captura en el siguiente `Stop` o en `SessionEnd`. Un log sin lector repetiría el caso de `response-meter`. | Hay un consumidor para la serie de errores (por ejemplo, la pestaña Uso). |
| `TeammateIdle` | Puertas de calidad para un compañero de un agent team. | Descartado: ULTRON no usa agent teams. | Se adoptan los agent teams. |
| `InstructionsLoaded` | Medir qué `CLAUDE.md` y reglas entran en contexto. | Descartado: sin consumidor; el coste de contexto se controla con el tamaño de los propios ficheros. | Se quiere auditar el contexto cargado por sesión. |
| `ConfigChange` | Detectar que `settings.json` cambió a mitad de sesión (por ejemplo, desde la pestaña Hooks) y avisar de regenerar el manifest. | Descartado: Claude Code descarta el `systemMessage` de este evento y solo deja bloquear o registrar; el desfase ya lo para el pre-commit con `regen-manifest --check`. | — |
| `CwdChanged` | Reaccionar a un `cd` (re-identificar el proyecto). | Descartado: la identidad del proyecto se fija por sesión en `SessionStart` y un `cd` dentro de la sesión no cambia de proyecto. | — |
| `DirectoryAdded` | Reaccionar a `/add-dir`. | Descartado: sin caso de uso. | — |
| `WorktreeCreate` | Sustituir la creación de worktrees. | Descartado: reemplaza el comportamiento de git por defecto y los subagentes de ULTRON dependen de él; el riesgo no compensa. | — |
| `WorktreeRemove` | Limpiar al quitar un worktree. | Descartado: solo salta para worktrees creados por un hook `WorktreeCreate`, que no existe. | — |
| `PostCompact` | Guardar el resumen de la compactación (`compact_summary`). | Descartado: `SessionStart` con `source=compact` ya reinyecta el resume y la bitácora, y `SessionEnd` escribe la bitácora con la sesión entera. | Se rediseña el scratch L0 (hallazgo hooks-4) y se quiere partir del resumen oficial. |
| `Elicitation` | Responder o filtrar peticiones de entrada de un servidor MCP. | Descartado: ningún MCP de ULTRON pide elicitation. | Un MCP propio las usa. |
| `ElicitationResult` | Revisar la respuesta antes de devolverla al MCP. | Descartado por lo mismo. | Ídem. |

## Mantenimiento

- Al subir de versión de Claude Code, comparar esta lista con la tabla «Hook
  lifecycle» de la documentación y con `hook-events.json`.
- Un evento que se cablee se mueve a «Cableados» con su script, y el hook pasa por
  `node hooks/regen-manifest.js`, su selftest en `scripts/selftests.manifest.json` y
  `hooks/README.md`.
