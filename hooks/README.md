# ULTRON — Hooks de Claude Code

Los hooks que integran ULTRON con Claude Code viven versionados en esta
carpeta y Claude Code los ejecuta **in situ**: `~/.claude/settings.json`
apunta directamente a `~/.ultron/hooks/scripts/*.js`. No hay copia a
`~/.claude/scripts/` ni script de instalación propio de los hooks.

## Fuente de verdad y espejos

| Fichero | Papel |
|---------|-------|
| `~/.claude/settings.json` | Config viva: decide **qué** corre. Se edita aquí. |
| `hooks/manifest.json` | Espejo versionado y auditado (checksums, `writer_path`, descripción). Lo genera `node hooks/regen-manifest.js`; no se edita `hooks[]` a mano. |
| `templates/settings-hooks.json` | Plantilla que fusionan `install.ps1` / `install.sh` en una instalación nueva. La genera el mismo `regen-manifest.js`. |

Gate de paridad (pre-commit): `node hooks/regen-manifest.js --check` falla si
el manifest o la plantilla no coinciden con `settings.json` o si el checksum
de un script o de sus librerías cambió sin regenerar. Los checksums se calculan
sobre los ficheros del repo donde vive `regen-manifest.js` (también desde un
worktree). `--settings <ruta>` o `ULTRON_HOOKS_SETTINGS` cambian el
`settings.json` de origen, para regenerar un cableado propuesto antes de
aplicarlo al real.

## Regla de oro: los hooks PROPONEN, no escriben memoria

- El **único escritor** de la memoria (`brain.db`) es **MemoryService**, el
  sidecar Rust `ultron-memory`.
- Los hooks **nunca** escriben memoria canónica directa. Solo pueden:
  - emitir `additionalContext` (solo lectura del contexto), o
  - proponer **candidatos** al inbox gobernado vía el sidecar
    (`ultron-memory capture` / `candidate`).
- `writer_path` permitido en el manifest: `"MemoryService"` o `"NONE"`.
  Prohibido: `qdrant_direct`, `mem0`.

### Flujo Stop → candidato

```
Stop hook (stop-compress-session.js)
  -> extrae hechos de la transcripción
  -> `ultron-memory capture` propone candidatos   (redaction + inbox gobernado)
  -> `ultron-memory inbox drain --auto`            (en segundo plano, sin el usuario)
     aprueba las bandas A/B y rechaza secreto, duplicado, conflicto y ruido
  -> MemoryService escribe en brain.db             (único escritor)
```

El inbox es autónomo desde el 2026-07-13 (decisión del usuario): la política
de aprobación vive en el binario (`bin/ultron_memory/inbox_auto.rs` y
`memory/auto_approve.rs`) y cada rechazo queda con su motivo. Solo quedan
pending lo que no se pudo verificar (infraestructura caída) y las capturas que
el usuario no afirmó: esas esperan validación humana 7 días y después se
rechazan como caducadas. Los candidatos de `posttoolfail-capture`,
`subagent-harvest` y `lesson-distill` también entran pending y los resuelve el
mismo drenaje.

## Campos de `manifest.json`

| Campo | Significado |
|-------|-------------|
| `id` | Identificador estable (nombre del script sin extensión) |
| `event` / `matcher` | Evento de Claude Code y matcher del grupo |
| `command` / `script` | Comando y ruta, con el home sustituido por `~` |
| `timeout_s` / `async` | Presupuesto y si corre desacoplado (un hook `async` no puede hablar al modelo: su stdout se descarta) |
| `checksum_sha256` | SHA-256 del script con finales de línea normalizados a LF |
| `deps_sha256` | SHA-256 de las librerías locales que el script carga (`require` relativo, transitivo); `null` si no carga ninguna. Un `require` con ruta calculada no se sigue |
| `env_allowlist`, `version`, `failure_policy` | Metadatos que se conservan entre regeneraciones |
| `writes_memory` / `writer_path` | Si toca memoria y por dónde (`MemoryService` o `NONE`) |

## Fail-safe y observabilidad

No hay un runner común. Cada hook aplica su propio fail-safe: `try/catch` en el
nivel superior, `process.exitCode = 0` para no romper nunca la sesión, y rastro
de fallos con `logHookError` de `scripts/lib/hook-obs.js` (`hook-errors.jsonl`).
La duración se registra con `observe()` del mismo módulo.

## Inventario de hooks vivos (2026-10-23, 32 entradas en `manifest.json`)

La evaluación de los 33 tipos de evento de Claude Code 2.1.309 (cuáles se
cablean y por qué se descartan los demás) está en
[`docs/hooks-coverage.md`](../docs/hooks-coverage.md).

| Evento | Hook | Modo | Propósito |
|--------|------|------|-----------|
| `SessionStart` | `ensure-codegraph.js` | sync | Mantiene vivo el daemon/watcher de CodeGraph. |
| `SessionStart` | `memory-session-resume.js` | sync | Resume del proyecto (tareas, decisiones, pinned, siguiente acción) leído vía `ultron-memory resume`. |
| `SessionStart` | `ensure-project.js` | sync | Da de alta el proyecto en `cockpit/projects.json` y aplica las normas de alta. |
| `UserPromptSubmit` | `socratic-gate.js` | sync | Protocolo socrático; modo por proyecto en `cockpit/projects.json` (`scripts/project-socratic.mjs <id> <modo>`). |
| `UserPromptSubmit` | `save-user-prompt.js` | sync | Archiva cada prompt no trivial en el inbox diario. |
| `UserPromptSubmit` | `memory-orchestrate.js` | sync | Modo ligero por defecto (solo el tono); `ULTRON_ORCHESTRATE=full` restaura recall, routing y delegación. |
| `UserPromptSubmit` | `session-feedback-capture.js` | sync | Captura `fb: si\|no\|estorbo [nota]` en `logs/session-feedback.jsonl`. |
| `UserPromptSubmit` | `run-project-tests-report.js` | sync | Informa al modelo de los tests rotos que lanzó `run-project-tests.js`. |
| `UserPromptSubmit` | `context-guard.js` | sync | A partir de 200k de contexto decide con la bitácora si conviene compactar. |
| `UserPromptSubmit` | `usage-pace-guard.js` | sync | Avisa si el uso de las ventanas de 5 h o semanal va por delante del tiempo transcurrido. |
| `PreToolUse` | `deny-secrets.js` | sync | Gate de credenciales (deny duro de claves, keystores, `.ssh`, etc.). |
| `PreToolUse` | `document-convert-hint.js` | sync | En un `Read` de `.docx/.pptx/.xlsx/.epub` o PDF grande sugiere `markitdown`. |
| `PreToolUse` | `codegraph-first.js` | sync | En un proyecto con índice de CodeGraph, deniega una vez por sesión y subagente la segunda exploración (`Grep`, `Glob` o `Read` de código) sin haber usado CodeGraph. Fail-open; `ULTRON_CODEGRAPH_FIRST=0` lo apaga. |
| `PreToolUse` | `guardrails-pre.js` | sync | Comprobaciones deterministas (agente inexistente, bandera de saltarse permisos...). |
| `PreToolUse` | `uni-deliverable-guard.js` | sync | Bloquea la escritura en `borrador/` y `entrega/` de trabajos universitarios. |
| `PostToolUse` | `posttoolfail-capture.js` | async | Registra fallos de herramienta (también en `PostToolUseFailure`). |
| `PostToolUse` | `guardrails-post.js` | sync | Avisa si el texto recién escrito rompe una norma de contenido. |
| `PostToolUse` | `run-project-tests.js` | async | Lanza la suite del proyecto tras editar código (tope 120 s, debounce 60 s). |
| `PostToolUseFailure` | `posttoolfail-capture.js` | async | Fallos donde la herramienta no devolvió resultado. |
| `PreCompact` | `precompact-preserve-l0.js` | sync | Preserva el estado L0 en `~/.ultron/.tmp/context.md`. |
| `PreModelSwitch` | `model-family-guard.js` | sync | Deniega un cambio de modelo (`/model`, selector, `/config`, `set_model` del SDK) fuera de la familia 5.5. Escape `ULTRON_MODEL_GUARD=0`. |
| `PostModelSwitch` | `model-family-guard.js` | sync | Avisa al usuario y al modelo si un cambio que no se puede bloquear (fallback automático, resume) deja la sesión fuera de la familia 5.5. |
| `Stop` | `stop-compress-session.js` | async | Comprime la sesión a candidatos vía `ultron-memory capture` y lanza el drenaje autónomo del inbox. |
| `Stop` | `batch-capture.js` | async | Encola los comandos rechazados o que la IA no pudo ejecutar (`ai_cannot_execute`) para el desplegable «Ejecutar .bat» de Projects; los que solo fallaron no se encolan. |
| `SubagentStart` / `SubagentStop` | `subagent-lifecycle.js` | async | Ciclo de vida de cada subagente en `.tmp/subagent-lifecycle`. |
| `SubagentStop` | `subagent-harvest.js` | async | Registra el resultado del subagente y propone un candidato si no es trivial. |
| `SessionEnd` | `session-end-bitacora.js` | async | Escribe la bitácora de la sesión que cierra. |
| `SessionEnd` | `lesson-distill.js` | async | Destila 0-3 lecciones como candidatos `lesson`. |
| `SessionEnd` | `project-profile.js` | async | Mantiene `cockpit/projects/<id>/profile.json`. |
| `SessionEnd` | `session-feedback-mark.js` | async | Deja `feedback-pending.json` para preguntar en la siguiente sesión. |
| `SessionEnd` | `memory-gc.js` | async | Mantenimiento semanal de `brain.db` a 90 días (`ultron-memory gc`). |
| `Notification` | `notify-relay.js` | async | Reenvía las notificaciones a `~/.ultron/.tmp/notifications.log`. |

## Retirados

Fuera de `settings.json` y ya borrados del repo: `codegraph-reminder`,
`markdown-lint-hint`, `ai-text-warn`, `load-cross-project-memory` y
`session-start-override` (2026-09-29/30), `kanban-update-reminder`
(2026-10-08), `mem0-sync`, `session-recall-inject`, `quota-capture` y
`workday-*` (los dos últimos vivían en `hooks/hooks/`, que se borró el
2026-08-09), y `response-meter` (2026-10-23: su único consumidor, la línea de
concisión del resume, salió el 2026-09-29 y `logs/response-meter.jsonl` crecía
sin lector).
La cobertura de cada evento de hook de Claude Code (cableado, descartado y
motivo) está en [`docs/hooks-coverage.md`](../docs/hooks-coverage.md). El dispatcher de skills (`cockpit/skill-lazy/routing-dispatcher.v2.js`
y `v3.js`) sigue en el repo pero no está registrado como hook desde el
2026-09-29.

Siguen en `hooks/scripts/` sin registrar como hook de Claude Code:

- `ensure-qdrant.js`, `memory-warmup.js` (con `memory-warm-models.js`) y
  `qdrant-mirror-sync.js`: para volver al recall híbrido si se reactiva el
  denso (ver §Memoria del `CLAUDE.md` del repo).
- `session-summarize-previous.js`: lo lanza `session-end-bitacora.js`.
- `session-end-summary.js`: solo lo empaqueta el plugin de Cowork.
- `research-mcp.js`: servidor MCP, no hook.
- `project-roster-context.js`: SessionStart que no está en `settings.json`;
  solo lo ejercita su selftest.

## Nota de mantenimiento

Edita siempre aquí (`~/.ultron/hooks/scripts/`). Tras tocar un hook o
`settings.json`, ejecuta `node hooks/regen-manifest.js` para refrescar
checksums, manifest y plantilla.
