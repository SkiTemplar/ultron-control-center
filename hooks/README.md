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

### Las dos puertas de paridad

```bash
node hooks/regen-manifest.js --check           # LOCAL: manifiesto vs ~/.claude/settings.json
node hooks/regen-manifest.js --check-template  # CI: manifiesto vs templates/settings-hooks.json
```

La primera es la completa (incluye checksums), pero lee la config de UNA
maquina: en un runner de CI ese fichero no existe y saldria en rojo por
entorno, no por regresion. La segunda compara lo que se **instala** con el
espejo versionado — evento, matcher, timeout, `async` y que el script exista en
el repo — y por eso es la que corre en CI desde el 2026-09-22. No mira
checksums a proposito: reflejan los ficheros de la maquina del mantenedor.

Lo que la puerta encontro el dia que se estreno: el manifiesto listaba
`routing-dispatcher.v3` cuando lo vivo es la **v2**; la plantilla instalaba
`memory-orchestrate` con `timeout: 12` cuando el hook presupuesta 20 s (con 12
Claude Code **descarta toda su salida en silencio**), `stop-compress-session`
con 30 s teniendo un p95 medido de 25,1 s, y `kanban-update-reminder` con
`async: true`, que descarta su stdout y dejaba el hook entero como un no-op.

`regen-manifest.js` entiende las dos formas de entrada de hook: la de shell
(`command: "node <ruta>"`) y la **exec** (`command: "node", args: ["<ruta>"]`).
Con la exec, `command` es solo `"node"`: sin leer `args[0]` los 20 hooks
colapsaban al mismo id y el manifiesto perdia script, checksum y metadatos de
todos a la vez. Lo fija `hooks/regen-manifest.selftest.mjs`.

## Forma exec: por que la plantilla ya no pasa por un shell (2026-09-22)

Desde `_schema_version: 4`, **todas** las entradas de
`templates/settings-hooks.json` (y las del plugin de Cowork) van en forma exec:

```jsonc
{ "type": "command", "command": "node", "args": ["{USERPROFILE}/.ultron/hooks/scripts/x.js"], "timeout": 5 }
```

El esquema del binario (`BashCommandHookSchema`, Claude Code 2.1.278) lo dice
asi: *«Argument list for exec form. When present, `command` is resolved as an
executable and spawned directly with these arguments — no shell. (…) When
absent, `command` runs through a shell (bash on POSIX, PowerShell on Windows
without Git Bash)»*. Dos motivos para el cambio:

1. **Coste.** Medido en esta maquina con un script vacio, 10 ejecuciones por
   forma, media: `node x.js` **34,4 ms**, `bash -c "node x.js"` **50,0 ms**
   (+15,6 ms, 31 %), `powershell -Command "node x.js"` **227,3 ms**
   (+192,9 ms, 85 %). En Windows **sin Git Bash** el interprete por defecto es
   PowerShell, asi que ahi cada hook pagaba ~0,2 s de shell para no hacer nada.
   Con 6 hooks sincronos en `UserPromptSubmit`, eso era mas de un segundo por
   prompt tirado en arrancar interpretes.
2. **Seguridad.** Sin shell no hay parser de shell: una ruta con espacios,
   comillas, `$` o backticks llega al proceso tal cual. Los marcadores
   (`${CLAUDE_PLUGIN_ROOT}`) se sustituyen **por elemento**, como texto plano.

`node` y `uv` se resuelven por PATH igual que los resolveria un shell, asi que
en Windows no hace falta ruta absoluta al interprete.

**Lo que NO se usa: el campo `if`.** Se busco en el binario 2.1.278 y
`BashCommandHookSchema` solo declara `command`, `args`, `shell`, `timeout`,
`statusMessage`, `once`, `async`, `asyncRewake` y campos `@internal` de
asyncRewake y de sesiones cloud. No hay campo condicional, asi que estrechar
`guardrails-pre` a `Bash(git push *)` habria sido configuracion muerta — y un
hook que no dispara es exactamente el no-op silencioso que prohibe el
mandamiento 11.

**`statusMessage`** (*«Custom status message to display in spinner while hook
runs»*) se pone solo en los sincronos que pueden tardar y bloquean el prompt:
`memory-orchestrate` («memoria…»), `memory-session-resume` («resume…») y
`ensure-qdrant` («qdrant…»). En el resto seria ruido.

Los dos instaladores expanden `{USERPROFILE}` sobre el **texto crudo** del
fichero antes de parsear el JSON (`install.ps1`: `$raw -replace`;
`install.sh`: `sed`), asi que la sustitucion alcanza igual a `command` y a
cada elemento de `args` — no hubo que tocarlos. Verificado ademas que
PowerShell 5.1 conserva los arrays de un solo elemento en el
`ConvertFrom-Json` -> `ConvertTo-Json -Depth 20` del merge (un `args` que
volviera como cadena habria roto todos los hooks en silencio): las 38 entradas
salen con `args` en corchetes y la ruta ya expandida.

**Dentro de `hooks` se escribe en ASCII puro**, `statusMessage` incluido.
`install.ps1` lee la plantilla con `Get-Content -Raw` **sin** `-Encoding UTF8`,
y PowerShell 5.1 sin BOM la interpreta como ANSI: los puntos suspensivos
tipograficos de `"memoria…"` (E2 80 A6) aterrizaban en `settings.json` como
tres caracteres basura y el spinner ensenaba `memoriaâ‚¬Â¦`. Por eso los
`statusMessage` llevan tres puntos normales. Las notas `_notas_*` si pueden
llevar acentos: nunca se copian a la config viva.

**Aviso para el dia que un hook vuelva a ser un `.ps1`:** `install.sh` filtra
las entradas de Windows con `select(.command | test("\\.ps1") | not)`, y en
forma exec `command` es solo `"node"` — la ruta vive en `args`, asi que ese
filtro no la veria. Hoy no hay ninguna entrada `.ps1` en la plantilla, asi que
no cambia nada; si se anade una, hay que mirar tambien `args`.

## Fail-safe y observabilidad

No hay un runner común: `scripts/lib/hook-runner.js` (circuit-breaker +
logging por hook) se retiró el 2026-09-11 porque ningún hook llegó a usarlo.
Cada hook aplica su propio fail-safe: `try/catch` en el nivel superior,
`process.exitCode = 0` para no romper nunca la sesión, y rastro de fallos con
`logHookError` de `scripts/lib/hook-obs.js` (`hook-errors.jsonl`). La duración
se registra con `observe()` del mismo módulo.

### Todo hook falla ABIERTO, menos uno

Un hook mal hecho rompe TODAS las sesiones de Claude Code. La regla es que
cualquier excepcion acabe en `exit 0` sin salida: el turno sigue, se pierde lo
que ese hook aportaba y queda el rastro en `hook-errors.jsonl`.

La unica excepcion es `deny-secrets.js`, que falla **CERRADO**: es una puerta
de seguridad, y si su clasificador revienta no puede demostrar que el acceso
sea seguro, asi que bloquea. Por eso su instrumentacion va envuelta en su
propio `try/catch`: si `lib/hook-obs` faltara, el hook sigue clasificando.

### Que se registra de cada disparo

`observe(id)` deja `{hook, elapsed_ms, exit_code}` en
`logs/hook-timing.jsonl`; `annotate({...})` (2026-09-22) anade campos a **esa
misma linea**, que es la que lee el backend para la ficha de cada hook. Regla
de contenido: solo etiquetas de un conjunto cerrado (que se decidio, que regla
caso, en que fase se fue el tiempo). **Nunca** rutas, nombres de fichero ni
prompts — el log se comparte con la app y el repo es publico.

## Inventario de hooks VIVOS (`templates/settings-hooks.json`, 2026-09-22)

**38 entradas**, 22 antes de la tanda H6. Hasta ese dia el manifiesto
documentaba 18 hooks que **no estaban instalados**: tenian ficha, checksum y
descripcion, pero jamas se disparaban. Se revisaron uno a uno con tres
criterios — (a) corre con payload sintetico y sale 0, (b) tiene consumidor real
de su salida, (c) cabe en el presupuesto de su evento — y entraron 16. Los dos
que no, con su motivo, en `deregistered` del manifiesto:

| Hook | Por que no se registra |
|------|------------------------|
| `uni-deliverable-guard.js` | Decision del usuario: bloquea la escritura del entregable en proyectos de asignatura y el **modo universitario** no esta activo. El script y su selftest se quedan: es el limite duro del modo `uni` de `socratic-gate` y se cablea el dia que se active. |
| `routing-dispatcher.v3.js` | Es la **variante** no elegida del dispatcher; lo vivo es la v2. Registrar las dos duplicaria el enrutado de cada prompt (v3 p50 72 ms, v2 p50 65 ms) e inyectaria un segundo bloque con las mismas skills. El script se queda: CI valida que carga. |

Presupuesto por evento, medido en esta maquina (p50 de 9 ejecuciones, arranque
de node incluido y sumados **en serie**, que es la cota pesimista): los seis
sincronos de `UserPromptSubmit` pasan de **141 ms a 255 ms** (tope acordado
300 ms) y los de `SessionStart` suman **+161 ms** (`ensure-codegraph` 51,
`project-roster-context` 51, `ensure-project` 59) sobre un tope de +1 s. Todo
lo que entra en `Stop`, `SessionEnd`, `SubagentStart` y `SubagentStop` va
`async`, que no bloquea el turno.

Detalle de `UserPromptSubmit` (p50, ms): `routing-dispatcher.v2` 50,
`save-user-prompt` 38, `socratic-gate` 38, `session-feedback-capture` 36,
`run-project-tests-report` 41, `memory-orchestrate` 53 (camino corto, con la
puerta de Qdrant cerrando el denso). Buena parte de ese coste es el arranque de
node, y es justo lo que abarata la forma exec: por la via del shell habria que
sumarle ~15,6 ms por hook en Git Bash y ~193 ms por hook en PowerShell.

### `Stop`
| Hook | Proposito |
|------|-----------|
| `stop-compress-session.js` | Comprime la sesion a hechos -> `ultron-memory capture` (candidatos al inbox gobernado). Upsert a Qdrant `ultron_sessions` **RETIRADO** (`d3a16ff`); sink `decisions-pending.jsonl` **ERRADICADO** (cat20.3, sin consumidor). |
| `response-meter.js` | F4.2/7.3: mide la respuesta del turno (lineas, palabras, cabeceras, listas, disculpas, preambulos; limite 12 lineas/220 palabras) en `logs/response-meter.jsonl`; el resume pinta media, % sobre el limite y tendencia de las ultimas 3 sesiones. |
| `kanban-update-reminder.js` | Solo si el turno tuvo Edit/Write en el cwd o `git commit`: cierra las cards que matchean un commit reciente y, si hay tarjetas In Progress, las nombra una vez por sesion (cooldown 30 min). Sin trabajo en el turno, silencio. Una card reabierta a mano no se vuelve a cerrar por el mismo commit (memoria de cierres en `kanban.auto-close.json`, junto al tablero) y el turno se corta en el ultimo prompt, humano o de sistema (v3.1). |
| `batch-capture.js` | Captura comandos REJECTED/FAILED a la cola Run Batch (`queue-pending.jsonl`). |

### `SessionStart`

Desde el 2026-09-22 la plantilla reparte estos hooks por **motivo** de arranque
(`startup|resume|clear|compact|fork`) en vez de correrlos los cinco con `*`:
`ensure-qdrant` y `memory-warmup` solo con `startup|resume|fork` (levantar
Qdrant y precalentar modelos no tiene sentido en un `/clear` ni tras
compactar; `fork` es una reanudacion), `memory-session-resume` con los cinco
motivos (es quien reinyecta el resume de memoria y el scratch L0 que
`precompact-preserve-l0` deja antes de compactar), y el resto se queda en `*`
porque cuesta p50 4 ms.

No hay ningun hook en `PostCompact`, a proposito: en Claude Code 2.1.278 ese
evento solo ensena el stdout del hook al **usuario** (`userDisplayMessage`) y
no acepta `hookSpecificOutput`, asi que nada que viva ahi puede devolver
contexto al modelo. El sitio para «lo de despues de compactar» es
`SessionStart` con motivo `compact`.

| Hook | Proposito |
|------|-----------|
| `ensure-qdrant.js` | `startup\|resume\|fork`. GET `/healthz` (~80 ms en caliente); si Qdrant esta caido dispara el watchdog detached y vuelve sin esperar. |
| `ensure-codegraph.js` | `startup\|resume\|fork` (nuevo en la plantilla, 2026-09-22). Mismo patron: si `daemon.pid` apunta a un proceso vivo sale en ~50 ms; si no, arranca el daemon de CodeGraph detached. Sin el, el indice queda stale y la exploracion cae a Glob/Grep a ciegas. |
| `memory-warmup.js` | `startup\|resume\|fork`. Precalienta el daemon de memoria (E5) para que el primer prompt no pague la carga. |
| `load-cross-project-memory.js` | Inyecta el indice de `MEMORY.md` de proyectos recientes. |
| `session-start-override.js` | Fallback de resumen de sesion previa por nombre de proyecto. |
| `project-roster-context.js` | Nuevo en la plantilla (2026-09-22). Inyecta el roster de subagentes del proyecto (los «empleados» delegables) y lo genera de forma determinista la primera vez, sin LLM. Filtra los agentes que ya no existen en disco: un agente fantasma no da error, simplemente no hace nada. Coste p50 51 ms. |
| `ensure-project.js` | Nuevo en la plantilla (2026-09-22). Da de alta el proyecto en el Control Center si falta, avisa si no tiene `CLAUDE.md` y lanza el indexado de CodeGraph detached. Como mucho dos lineas de contexto; coste p50 59 ms. |
| `memory-session-resume.js` | Resume canonico (workflows/tareas/decisiones/pinned) leido del SoT via `ultron-memory resume`. Desde 2026-09-04 anade `feedback_pendiente`/`session_feedback`, `response_meter` y el bloque `codegraph` (tamano del indice, zonas, hubs; cache en `.codegraph/ultron-summary.json`). |

### `UserPromptSubmit`
| Hook | Proposito |
|------|-----------|
| `routing-dispatcher.v2.js` | Sugiere skill/persona por intencion del prompt (scoring determinista). La `v3` (semantica, via daemon) existe pero **no** esta registrada. |
| `socratic-gate.js` | Protocolo socratico en cada prompt (escalada ante acks de bajo esfuerzo). Modo por proyecto: `socratic: strict|light|off` en `cockpit/projects.json` (ausente = strict); `scripts/project-socratic.mjs <id> <modo>`. |
| `save-user-prompt.js` | Archiva cada prompt no trivial en el inbox diario (candidate a promover). |
| `memory-orchestrate.js` | Enruta el prompt por el orquestador canonico (`ultron-memory orchestrate`). Presupuesto propio de 8 s con `timeout: 10` (ver abajo). |
| `session-feedback-capture.js` | Metrica externa (ULTRON 4, 12.1): captura `fb: si|no|estorbo [nota]` en `logs/session-feedback.jsonl`, retira el `feedback-pending.json` del proyecto y propone la nota como candidato de memoria. Sin `fb:`: silencio. |
| `run-project-tests-report.js` | Reporter de F4.1: en el turno siguiente dice los tests rotos (nombres), el timeout o, una vez por sesion, que no hay comando de test; anuncia el verde solo tras un fallo reportado. |

### `PreToolUse`
| Hook | Matcher | Proposito |
|------|---------|-----------|
| `deny-secrets.js` | `Read\|Edit\|Write\|NotebookEdit\|Bash` | Puerta de secretos. **El unico hook que falla CERRADO.** |
| `codegraph-reminder.js` | `Read\|Grep\|Glob\|Bash` | Recuerda usar el indice de CodeGraph antes de explorar a ciegas. |
| `guardrails-pre.js` | `Bash\|Agent\|Task` | Nuevo en la plantilla (2026-09-22). Ver abajo: entra con las DENY de Bash **apagadas**. |

#### `guardrails-pre`: que bloquea de verdad

| Regla | Decision | Estado |
|-------|----------|--------|
| `agente-fantasma` (Agent/Task) | **DENY** | Activa. Un `subagent_type` que no existe en disco no da error: Claude Code lo ignora y la delegacion se pierde entera. Fail-open si el catalogo de disco trae menos de 20 nombres (entonces es que no supimos leerlo). |
| `force-push` (Bash) | **ASK** | Activa. Pregunta, no bloquea. |
| `uv`, `commit-format`, `skip-permissions` (Bash) | DENY | **Apagadas** por defecto. Se encienden con `ULTRON_GUARDRAILS_BASH=1`. |

Las tres ultimas son heuristicas sobre **texto de shell**, y un DENY es un
bloqueo sin apelacion: un falso positivo no avisa, para el trabajo en seco y
obliga a reescribir el comando a ciegas. Las dos que se quedan activas no
tienen esa forma — una comprueba pertenencia a un catalogo de disco (o falla
abierto) y la otra solo pregunta. El selftest cubre los dos estados del flag,
con el caso negativo explicito de «apagado ⇒ `pip install` PASA».

### `PostToolUse`
| Hook | Matcher | Proposito |
|------|---------|-----------|
| `posttoolfail-capture.js` | `*`, async | Fallos de tool CON resultado -> candidate `error_resolution`. |
| `guardrails-post.js` | `Write\|Edit`, **sincrono** | Nuevo en la plantilla (2026-09-22). AVISA (nunca bloquea) cuando el texto recien escrito lleva registro coloquial a un artefacto que puede leer un tercero, o conteos de skills/agentes dentro de la skill ULTRON. Sincrono a proposito: `async` descartaria su stdout y el aviso no llegaria nunca. Coste p50 35 ms. |
| `run-project-tests.js` | `Edit\|Write\|MultiEdit\|NotebookEdit`, async | F4.1: tras editar codigo del proyecto lanza la suite COMPLETA en un runner desacoplado (tope 120 s, debounce 60 s, un runner por proyecto). Comando: linea `test: <cmd>` en el CLAUDE.md del proyecto, o package.json / Cargo.toml / pyproject / go.mod. Resultado en `.tmp/run-tests/<project>.result.json`, que lee `run-project-tests-report.js` en el turno siguiente. |

### `SubagentStart` / `SubagentStop` (async) — en la plantilla desde 2026-09-22
| Hook | Proposito |
|------|-----------|
| `subagent-lifecycle.js` | El MISMO script en los dos eventos: una linea `{ts, event:"start"\|"stop", agent_id, agent, label}` en `.tmp/subagent-lifecycle.jsonl`. El backend (`live_session.rs`) reduce por `agent_id`: si el ultimo evento es `start`, ese subagente esta EN VUELO y el Monitor lo pinta. Sin el par start/stop el Monitor solo veia resultados, nunca trabajo en curso. |
| `subagent-harvest.js` | Solo en `SubagentStop`: recoge el resultado del subagente. |

### `PostToolUseFailure` (`*`, async) — cableado el 2026-09-22
| Hook | Proposito |
|------|-----------|
| `posttoolfail-capture.js` | El mismo script que en `PostToolUse`, para la clase de fallo complementaria: la tool NI llego a ejecutarse (permiso, timeout, error del harness) y el payload trae `error` de primer nivel sin `tool_response`. El registro en `PostToolUse` se queda en `*`: estrecharlo tiraria los fallos que SI traen resultado. |

### `StopFailure` (matcher = valores del enum `error`, async) — nuevo el 2026-09-22
| Hook | Proposito |
|------|-----------|
| `stopfailure-relay.js` | Sensor de cuota para el relevo de proveedores. Cuando un turno muere por cuota, sobrecarga o un problema de cuenta, deja una linea en `cockpit/maria/relay-cuota.jsonl` (`{ts, proveedor, error, clase, detalle, sesion, fuente}`) para que el relevo degrade `claude` sin esperar a tropezar por su cuenta. Lee `payload.error` — el schema **no** tiene `error_type` — y vuelve a filtrar contra la misma lista del matcher. No es memoria: estado operativo, `writer_path: NONE`. |

### `SessionEnd` (async: no hablan al modelo)
| Hook | Proposito |
|------|-----------|
| `session-end-summary.js` | Resumen corto de la sesion como candidato `session_summary` (inbox gobernado). |
| `lesson-distill.js` | Destila 0-3 candidatos `lesson` (sintoma, causa, regla) via el daemon. |
| `project-profile.js` | Mantiene `cockpit/projects/<id>/profile.json` (que es, stack, arquitectura, estado, decisiones). |
| `session-feedback-mark.js` | Deja `feedback-pending.json` (minutos, turnos humanos, commits) para que el siguiente SessionStart del proyecto pregunte si ULTRON ayudo. Solo proyectos registrados que no son ultron y con >=3 turnos; un pending ignorado se registra como `sin_respuesta`. |
| `memory-gc.js` | En la plantilla desde 2026-09-22. Dispara `ultron-memory gc --days 90` como mucho una vez por semana (cadencia en `.tmp/memory-gc-last.json`, sellada solo tras un exit 0). No toca `brain.db`: el escritor sigue siendo MemoryService. |

## El presupuesto de `memory-orchestrate` (2026-09-22)

Es el unico hook que puede bloquear el prompt varios segundos, asi que su
presupuesto se decide **con el reparto por fase delante**, no por corazonada.
Con el daemon vivo cuesta **9 ms** (p50 de 19 ejecuciones con el campo
`fases`); la cola era otra cosa: p90 9.132 ms, p95 15.693 ms, y las fases que
mandaban eran `daemon_ms` (409 / 1.605 / 3.031 / 3.153 ms) y
`relanzamiento_ms` (3.261 y 9.116 ms).

Lo que dice ese dato: (1) esperar 9 s a un daemon que no ha contestado en 4 es
regalar 5 s por turno, porque ningun `daemon_ms` util pasa de 3,2 s; (2) el
relanzamiento de 9,1 s es el sintoma mas caro y el menos util — ese daemon no
llega a servir **ese** turno, solo el siguiente. De ahi el recorte:

| Constante | Antes | Ahora |
|-----------|-------|-------|
| `HOOK_BUDGET_MS` (y `timeout` de la plantilla) | 20.000 (20 s) | **8.000** (10 s) |
| `DAEMON_TIMEOUT_MS` / `_CACHED_MS` | 9.000 / 6.000 | **4.000 / 3.000** |
| `FIRST_PROMPT_DAEMON_WAIT_MS` | 12.000 | **4.000** |
| `DAEMON_BOOT_WAIT_MS` / poll | 12.000 / 1.500 | **4.000 / 500** |
| `BUSY_RETRY_BUDGET_MS` | 6.000 | **2.000** |
| relanzamiento | deadline absoluta 15.500 | **techo relativo 2.500** + deadline absoluta 5.000 |
| cap del `--sparse` | 3.000–6.000 | **1.500–3.000** |

El `timeout` de la plantilla tiene que ser **mayor** que el presupuesto: si el
hook lo vence, Claude Code descarta **toda** su salida en silencio (sintoma
medido el 2026-08-14 con 12 s contra un presupuesto de 20).

**Puerta de Qdrant.** Sin Qdrant no hay recall denso, y el daemon puede estar
vivo y aun asi tardar segundos intentando consultar un Qdrant que no esta. Asi
que antes de gastar nada, el hook hace el mismo `GET /healthz` barato que
`ensure-qdrant.js` (~2 ms en loopback caliente, tope 300 ms). Si no contesta:
no espera al daemon, no lo relanza — va directo al respaldo `--sparse` (FTS5,
que no necesita Qdrant) y **lo dice** en el aviso, con puerto incluido.

Medido con el harness `hooks/scripts/tests/test-orchestrate-recovery.js`
(hermetico: daemon, Qdrant y sidecar de mentira, `HOME` temporal — no toca
nada vivo), antes y despues:

| Caso | Antes | Ahora |
|------|-------|-------|
| (a) daemon vivo | 61 ms | **61 ms** (sin cambio, que era el requisito) |
| (b) daemon muerto que reaparece | 3.114 ms | **1.071 ms** |
| (c) nadie contesta -> sparse | 13.652 ms | **1.580 ms** |
| (e) nadie contesta y el sparse falla -> degradado | 13.686 ms | **1.579 ms** |
| (f) Qdrant caido (caso nuevo) | — | **57 ms** |

## De-registrados / fuera de settings.json (correccion del inventario)

Ademas de los dos de la tanda H6 (`uni-deliverable-guard`,
`routing-dispatcher.v3`, tabla al principio del inventario):

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
