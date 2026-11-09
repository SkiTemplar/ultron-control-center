# Mods de ULTRON para Claude Code

Los mods son plugins de Claude Code que viven en `mods/<nombre>/` (manifiesto en
`.claude-plugin/plugin.json`, hooks en `hooks/`, tests en `tests/`). Verificado
contra el código el 2026-10-23.

## Cómo se activan

Un mod está activo si su carpeta figura en `env.CLAUDE_CODE_PLUGIN_DIRS` de
`~/.claude/settings.json` (lista separada por `;` en Windows, admite `~/`):

```json
"CLAUDE_CODE_PLUGIN_DIRS": "~/.ultron/mods/ultron-contexto;~/.ultron/mods/ultron-git;..."
```

Se aplica al abrir una sesión nueva de Claude Code. ULTRON Sessions hereda la
variable (`pty/spawn.rs`) y lista los mods y sus comandos en solo lectura
(`sesiones/mods.rs`; activarlos desde Sessions se retiró el 2026-10-14).

## Tests

Cada mod con `tests/` se prueba con el kit de Claude Code, desde su carpeta:

```bash
cd mods/ultron-guardia && claude plugin test
```

Cifras del 2026-10-23 (claude 2.1.309): 290 tests, 0 fallos. El job
`mods-tests` de `.github/workflows/ci.yml` (windows-latest, CLI fijada en
`CLAUDE_CODE_VERSION`) los ejecuta en cada push y PR a main con
`node scripts/run-mod-tests.mjs`.

## Los 18 mods

| Mod | Qué hace | Comandos | Tests |
|---|---|---|---|
| `ultron-adjuntar` | Adjuntar ficheros sin escribir rutas: buscador por proyecto, sesión, capturas, descargas y escritorio | `/adjuntar [búsqueda]`, `/captura [n]`, `/citar` | 6 |
| `ultron-agentes` | Panel de subagentes y agentes de workflows de la sesión: quién trabaja, en qué y desde cuándo | `/agentes` | 28 |
| `ultron-atajos` | Detecta el stack (cargo, uv, npm, cmake) y lanza el comando en segundo plano; el resultado llega al modelo | `/compilar`, `/probar`, `/arrancar` | 10 |
| `ultron-checkpoint` | Antes de la primera edición de cada turno guarda una foto del árbol en `refs/ultron/checkpoints`, sin tocar índice ni árbol | `/checkpoints`, `/checkpoint-diff <n>` | 14 |
| `ultron-cierre` | Si el turno editó ficheros, al terminar avisa de tests en rojo (resultados de `run-project-tests`) o cambios sin commitear y sugiere el siguiente prompt | — | 7 |
| `ultron-codex` | Panel de Codex: tareas y revisiones en segundo plano con el resultado en el chat | `/codex [--model m] [--effort e] [prompt]` (solo lectura), `/codex-write <prompt>` (escribe), `/codex-review` | 25 |
| `ultron-contexto` | En qué se va la ventana de contexto: categorías, carga fija, herramientas y lecturas repetidas | `/contexto [exacto]` | 6 |
| `ultron-entregas` | Al arrancar, aviso de las entregas de la asignatura en los próximos 14 días (`.ultron-trabajo.json`) | `/entregas [próximas]` | 12 |
| `ultron-git` | Panel y franja de turno: ficheros tocados con +/- líneas, árbol sin commitear y diff por fichero | `/git` | 9 |
| `ultron-guardia` | Guardia de subagentes: desvía `general-purpose` al especialista instalado, añade tope de turnos y formato de respuesta a `general-purpose` y `Explore`, y quita un `model` explícito fuera de la familia 5.5 (respeta `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, sus alias si `ANTHROPIC_DEFAULT_<ALIAS>_MODEL` los fija a la familia, e `inherit` si el padre es de la familia) | — | 12 |
| `ultron-hud` | Aspecto ULTRON: spinner con el verbo del tono, cierre de turno con herramientas, tokens y coste, modos en el pie, tema ULTRON Acero (`themes/`) y recordatorio de comandos en las primeras vueltas | `/socratico [strict\|light\|off\|uni]` | 9 |
| `ultron-mejorar` | Reescribe el borrador del prompt con el contexto del proyecto (rama, cambios, último error) y lo deja en la caja | `/mejorar <borrador>` | 10 |
| `ultron-papercut` | Añade una línea fechada con el proyecto a `~/.ultron/papercuts.md` | `/papercut síntoma · arreglo` | 9 |
| `ultron-permisos` | Auto-aprueba lo seguro cuando el núcleo pregunta (lecturas, shell de solo lectura, build/test, ediciones en el proyecto; nunca en plan ni dontAsk), propone una regla tras 3 aprobaciones manuales y pausa el permiso del `.env` | `/permisos [aceptar <n> \| quitar <n> \| pausar-env <min> \| reanudar-env]` | 36 |
| `ultron-puente` | Puente entre una sesión lanzada por ULTRON Sessions y su ventana (protocolo 2). Sin `ULTRON_PUENTE_URL`, `ULTRON_PUENTE_TOKEN` y `ULTRON_SESION_ID` no hace nada | — | 74 |
| `ultron-relevo` | Escribe el estado de la sesión en `.claude/relevos/` y deja en la caja el prompt para retomarlo con contexto limpio | `/relevo [nota]` | 5 |
| `ultron-skills` | Panel de las skills expandidas en la sesión (tool Skill, `/nombre` o precarga de subagente) y su coste aproximado en tokens; no lee el log del dispatcher, desconectado desde el 2026-09-29 | `/skills` (`/skills todas` deja pasar el listado del motor) | 8 |
| `ultron-uso` | Cuota del plan: uso y tiempo de las ventanas de 5 h y semanal, ritmo según el horario y hora estimada del límite | `/uso` | 10 |

Los mods con panel (`adjuntar`, `agentes`, `codex`, `contexto`, `git`, `skills`,
`uso`) tienen además una apertura automática (`autoOpen`) que no actúa dentro de
ULTRON Sessions (`ULTRON_SESION_ID`), que tiene su propia interfaz; las
condiciones exactas varían por mod (ver `hooks/register.tsx` de cada uno).
