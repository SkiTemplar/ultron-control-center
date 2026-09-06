# ULTRON — Hooks de Claude Code (fuente versionada + manifest OLA I)

Estos son los hooks que integran ULTRON con Claude Code. Claude Code los
ejecuta desde `~/.claude/scripts/` (donde `install-hooks.ps1` los copia),
pero la **fuente de verdad (SoT) unica y versionada** es esta carpeta:

```
~/.ultron/hooks/scripts/*.js
```

Cualquier cambio se hace AQUI y se propaga con `install-hooks.ps1`. La SoT
historica estaba fragmentada (`~/.claude/scripts` sin versionar + restos en
`~/.ultron/hooks/hooks`); a partir de OLA I la unica SoT versionada de hooks
de sesion es `~/.ultron/hooks/scripts`.

## Regla de oro: los hooks PROPONEN, no escriben memoria

- El **unico escritor** del Source of Truth de memoria (`brain.db`, 943
  active) es **MemoryService** (el sidecar Rust `ultron-memory`).
- Los hooks **NUNCA** escriben memoria canonica directa. Solo pueden:
  - emitir `additionalContext` (solo lectura del contexto), o
  - dejar **candidates** en colas/inbox que el backend drena via
    MemoryService (Stop -> candidate).
- `writer_path` permitido en el manifest: `"MemoryService"` o `"NONE"`.
  PROHIBIDO: `qdrant_direct`, `mem0`.

### Flujo Stop -> candidate

`stop-compress-session.js` ya **no** hace upsert directo a Qdrant
`ultron_sessions` (retirado en `d3a16ff`: estaba fuera del SoT y usaba una
dimension de embedding incompatible). Ahora:

```
Stop hook (stop-compress-session.js)
  -> extrae hechos de la transcripcion
  -> `ultron-memory capture` propone candidatos   (redaction + inbox gobernado)
  -> el usuario aprueba/rechaza en el inbox        (nunca auto-promocion)
  -> MemoryService escribe a brain.db              (unico escritor)
```

## `manifest.json`

Cada hook VIVO versionado tiene una entrada en `manifest.json` con:

| Campo | Significado |
|-------|-------------|
| `id` | Identificador estable del hook |
| `event` | `Stop` \| `SessionStart` \| `UserPromptSubmit` |
| `command_rel` | Ruta del `.js` relativa a `~/.ultron/hooks/` |
| `timeout_s` | Presupuesto de tiempo (s) |
| `env_allowlist` | Variables de entorno que el hook puede leer |
| `version` | SemVer del hook |
| `checksum_sha256` | SHA-256 REAL del `.js` (verifica integridad) |
| `failure_policy` | `no_op` (fail-safe) o `disable_after_N` |
| `writes_memory` | `true`/`false` — si toca memoria |
| `writer_path` | `"MemoryService"` \| `"NONE"` (nunca direct stores) |

Verificar el checksum de un hook:

```powershell
node -e "const fs=require('fs'),c=require('crypto');console.log(c.createHash('sha256').update(fs.readFileSync('scripts/stop-compress-session.js')).digest('hex'))"
```

## Circuit-breaker + runner comun

`scripts/lib/hook-runner.js` es el wrapper comun (solo stdlib Node, sin
dependencias externas). Envuelve el cuerpo de cualquier hook y aporta:

1. **Circuit-breaker** persistido en
   `~/.ultron/cockpit/hooks/breaker-state.json`:
   - Tras **5 fallos** en una ventana de **10 min** el breaker se **ABRE** y
     el hook se salta (`no_op`).
   - Tras un **cooldown de 15 min** pasa a **half-open** y permite UNA prueba.
     Si la prueba va bien -> `closed`; si falla -> vuelve a `open`.
2. **Fail-safe**: un `try/catch` duro garantiza que un hook que peta **nunca**
   rompa la sesion (siempre `exit 0`). El callback `onSkip` deja emitir el
   payload neutro (p.ej. `additionalContext` vacio).
3. **Logging** estructurado JSONL por hook en
   `~/.ultron/cockpit/hooks/logs/<id>.jsonl` (un objeto por invocacion:
   `ts`, `event`, `reason`, `duration_ms`, ...).
4. **Guardrail de SoT**: si un hook se declara `writes_memory:true` con un
   `writer_path` prohibido (`qdrant_direct`/`mem0`), el runner lo **bloquea**
   (fail-closed) y lo registra, sin romper la sesion.

Uso minimo desde un hook:

```js
const { runHook } = require('./lib/hook-runner');
runHook('memory-orchestrate', async () => {
  // ... cuerpo del hook ...
}, { onSkip: () => emit('') }) // emite contexto vacio si el breaker abre / peta
  .finally(() => { process.exitCode = 0; });
```

## Inventario de hooks VIVOS (settings.json, 2026-06-04 HEAD f936a66)

### `Stop`
| Hook | Proposito |
|------|-----------|
| `stop-compress-session.js` | Comprime la sesion a hechos -> `ultron-memory capture` (candidatos al inbox gobernado). Upsert a Qdrant `ultron_sessions` **RETIRADO** (`d3a16ff`); sink `decisions-pending.jsonl` **ERRADICADO** (cat20.3, sin consumidor). |
| `response-meter.js` | F4.2/7.3: mide la respuesta del turno (lineas, palabras, cabeceras, listas, disculpas, preambulos; limite 12 lineas/220 palabras) en `logs/response-meter.jsonl`; el resume pinta media, % sobre el limite y tendencia de las ultimas 3 sesiones. |
| `kanban-update-reminder.js` | Solo si el turno tuvo Edit/Write en el cwd o `git commit`: cierra las cards que matchean un commit reciente y, si hay tarjetas In Progress, las nombra una vez por sesion (cooldown 30 min). Sin trabajo en el turno, silencio. Una card reabierta a mano no se vuelve a cerrar por el mismo commit (memoria de cierres en `kanban.auto-close.json`, junto al tablero) y el turno se corta en el ultimo prompt, humano o de sistema (v3.1). |
| `batch-capture.js` | Captura comandos REJECTED/FAILED a la cola Run Batch (`queue-pending.jsonl`). |

### `SessionStart`
| Hook | Proposito |
|------|-----------|
| `load-cross-project-memory.js` | Inyecta el indice de `MEMORY.md` de proyectos recientes. |
| `session-start-override.js` | Fallback de resumen de sesion previa por nombre de proyecto. |
| `workday-session-linker.js` | Auto-enlaza la sesion al Workday in_progress (offline -> `_pending-links.jsonl`). |
| `memory-session-resume.js` | Resume canonico (workflows/tareas/decisiones/pinned) leido del SoT via `ultron-memory resume`. Desde 2026-09-04 anade `feedback_pendiente`/`session_feedback`, `response_meter` y el bloque `codegraph` (tamano del indice, zonas, hubs; cache en `.codegraph/ultron-summary.json`). |

### `UserPromptSubmit`
| Hook | Proposito |
|------|-----------|
| `routing-dispatcher.js` | Sugiere skill/persona por intencion del prompt (scoring determinista). |
| `socratic-gate.js` | Protocolo socratico en cada prompt (escalada ante acks de bajo esfuerzo). Modo por proyecto: `socratic: strict|light|off` en `cockpit/projects.json` (ausente = strict); `scripts/project-socratic.mjs <id> <modo>`. |
| `save-user-prompt.js` | Archiva cada prompt no trivial en el inbox diario (candidate a promover). |
| `memory-orchestrate.js` | Enruta el prompt por el orquestador canonico (`ultron-memory orchestrate`). |
| `session-feedback-capture.js` | Metrica externa (ULTRON 4, 12.1): captura `fb: si|no|estorbo [nota]` en `logs/session-feedback.jsonl`, retira el `feedback-pending.json` del proyecto y propone la nota como candidato de memoria. Sin `fb:`: silencio. |
| `run-project-tests-report.js` | Reporter de F4.1: en el turno siguiente dice los tests rotos (nombres), el timeout o, una vez por sesion, que no hay comando de test; anuncia el verde solo tras un fallo reportado. |

### `PostToolUse` (`Edit|Write|MultiEdit|NotebookEdit`, async)
| Hook | Proposito |
|------|-----------|
| `run-project-tests.js` | F4.1: tras editar codigo del proyecto lanza la suite COMPLETA en un runner desacoplado (tope 120 s, debounce 60 s). Comando: linea `test: <cmd>` en el CLAUDE.md del proyecto, o package.json / Cargo.toml / pyproject / go.mod. Resultado en `.tmp/run-tests/<project>.result.json`. |

### `SessionEnd` (async: no hablan al modelo)
| Hook | Proposito |
|------|-----------|
| `session-end-summary.js` | Resumen corto de la sesion como candidato `session_summary` (inbox gobernado). |
| `lesson-distill.js` | Destila 0-3 candidatos `lesson` (sintoma, causa, regla) via el daemon. |
| `project-profile.js` | Mantiene `cockpit/projects/<id>/profile.json` (que es, stack, arquitectura, estado, decisiones). |
| `session-feedback-mark.js` | Deja `feedback-pending.json` (minutos, turnos humanos, commits) para que el siguiente SessionStart del proyecto pregunte si ULTRON ayudo. Solo proyectos registrados que no son ultron y con >=3 turnos; un pending ignorado se registra como `sin_respuesta`. |

## De-registrados / fuera de settings.json (correccion del inventario)

El inventario anterior listaba como vivos hooks que YA **no** lo estan:

| Hook | Estado | Motivo |
|------|--------|--------|
| `mem0-sync.js` | **FUERA** de settings.json | De-registrado (P0 config viva). Escribia a Mem0 cloud (store competidor, fuera del SoT). Sigue versionado como referencia. |
| `quota-capture.js` | **FUERA** de settings.json | Quota QUITADO (`cbb2d5c`). Vive en `hooks/hooks/`, ya no se invoca. |
| `session-recall-inject.js` | **FUERA** de settings.json | Reemplazado por `memory-session-resume.js` (resume canonico, dim E5 1024d). |
| `workday-auto-update.js` | No es hook de sesion | Tarea programada de Windows (cada 15 min) en `hooks/hooks/`. |

## Instalacion

```powershell
powershell -ExecutionPolicy Bypass -File hooks\install-hooks.ps1
# opcional: registrar la tarea programada de Workdays (cada 15 min)
powershell -ExecutionPolicy Bypass -File hooks\install-hooks.ps1 -RegisterTask
```

## Nota de mantenimiento

Edita SIEMPRE aqui (`~/.ultron/hooks/scripts/`), no en `~/.claude/`. Tras
editar un `.js`, **recalcula su `checksum_sha256` en `manifest.json`** y
re-ejecuta `install-hooks.ps1` para propagar a `~/.claude/`.
