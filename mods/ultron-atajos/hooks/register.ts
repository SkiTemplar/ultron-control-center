import type { EngineInterface, Register } from 'claude-code'

import { ACTIONS, detectPlan, isWindowsPath, outcomeContext, outcomeToast, shellArgv, statusLine } from './stack'
import type { Action, Plan, ProjectFiles, RunOutcome } from './stack'
import { parseUltronTests, pickForCwd } from './ultron'
import type { UltronTests } from './ultron'

const RUN_TIMEOUT_MS = 600_000
/** Una salida con error de /arrancar antes de esto se avisa; después, el proceso ya «arrancó». */
const EARLY_EXIT_MS = 15_000

const DESCRIPTIONS: Record<Action, string> = {
  compilar: 'Compila el proyecto en segundo plano (cargo, uv, npm o cmake, según el stack)',
  probar: 'Lanza los tests del proyecto en segundo plano y deja el resultado al modelo',
  arrancar: 'Arranca la aplicación del proyecto en segundo plano y avisa si cae al arrancar',
}

/** Estado del mod en la sesión: acciones en marcha y contexto pendiente para el siguiente prompt. */
type Ctx = {
  running: Action[]
  pending: string[]
}

/** Un comando resuelto y el directorio desde el que lanzarlo. */
type Resolved = { cmd: string; cwd: string }

const join = (dir: string, name: string): string => `${dir.replace(/[\\/]+$/, '')}/${name}`

async function readText($: EngineInterface, path: string): Promise<string | null> {
  return (await $.fs.exists(path)) ? String(await $.fs.read(path)) : null
}

async function readProject($: EngineInterface, dir: string): Promise<ProjectFiles> {
  return {
    hasCargo: await $.fs.exists(join(dir, 'Cargo.toml')),
    pyproject: await readText($, join(dir, 'pyproject.toml')),
    hasMainPy: await $.fs.exists(join(dir, 'main.py')),
    packageJson: await readText($, join(dir, 'package.json')),
    hasCmake: await $.fs.exists(join(dir, 'CMakeLists.txt')),
  }
}

/** El comando de tests que ULTRON ya resolvió para el proyecto del cwd, si lo hay. */
async function ultronTests($: EngineInterface, cwd: string): Promise<UltronTests | null> {
  const dir = `${$.plugin.root}/../../.tmp/run-tests`
  if (!(await $.fs.exists(dir))) return null
  const found: UltronTests[] = []
  for (const entry of (await $.fs.list(dir)).filter((f) => f.kind === 'file' && f.name.endsWith('.result.json'))) {
    const parsed = parseUltronTests(String(await $.fs.read(`${dir}/${entry.name}`)))
    if (parsed) found.push(parsed)
  }
  return pickForCwd(found, cwd)
}

/** Busca el stack en el cwd y, si no hay, en la raíz de la sesión. */
async function findPlan($: EngineInterface): Promise<{ plan: Plan; dir: string } | null> {
  const cwd = await $.session.cwd()
  const root = await $.session.root()
  for (const dir of cwd === root ? [cwd] : [cwd, root]) {
    const plan = detectPlan(await readProject($, dir))
    if (plan) return { plan, dir }
  }
  return null
}

/** El comando de la acción, o el motivo por el que no hay ninguno. */
async function resolve($: EngineInterface, action: Action): Promise<Resolved | string> {
  if (action === 'probar') {
    const ultron = await ultronTests($, await $.session.cwd())
    if (ultron) return { cmd: ultron.cmd, cwd: ultron.cwd }
  }
  const found = await findPlan($)
  if (!found) return 'No reconozco el stack: no hay Cargo.toml, pyproject.toml, package.json ni CMakeLists.txt en el cwd ni en la raíz.'
  const cmd = found.plan[action]
  if (cmd === null) return `El proyecto (${found.plan.stack}) no tiene nada que /${action}.`
  return { cmd, cwd: found.dir }
}

function setRunning($: EngineInterface, ctx: Ctx, running: Action[]): void {
  ctx.running = running
  $.ui.status(statusLine(running))
}

function finish($: EngineInterface, ctx: Ctx, outcome: RunOutcome): void {
  $.ui.toast(outcomeToast(outcome))
  ctx.pending = [...ctx.pending, outcomeContext(outcome)]
}

/** Compilar o probar: espera al final (con tope) y deja el resultado. La acción ya está marcada en marcha. */
async function runToEnd($: EngineInterface, ctx: Ctx, action: Action, target: Resolved): Promise<void> {
  const startedAt = await $.clock.now()
  let outcome: RunOutcome
  try {
    const argv = shellArgv(target.cmd, isWindowsPath(target.cwd))
    const run = await $.process.run(argv, { cwd: target.cwd, timeoutMs: RUN_TIMEOUT_MS })
    const durationMs = (await $.clock.now()) - startedAt
    outcome = { action, cmd: target.cmd, exitCode: run.exitCode, durationMs, output: `${run.stdout}\n${run.stderr}` }
  } catch (err) {
    const durationMs = (await $.clock.now()) - startedAt
    outcome = { action, cmd: target.cmd, exitCode: -1, durationMs, output: `No se pudo lanzar: ${String(err)}` }
  } finally {
    setRunning($, ctx, ctx.running.filter((a) => a !== action))
  }
  finish($, ctx, outcome)
}

/** Arrancar: no espera; solo avisa si el proceso cae con error al poco de arrancar. Ya está marcada en marcha. */
async function launch($: EngineInterface, ctx: Ctx, target: Resolved): Promise<void> {
  const startedAt = await $.clock.now()
  let output = ''
  try {
    const child = $.process.spawn({ argv: shellArgv(target.cmd, isWindowsPath(target.cwd)), cwd: target.cwd })
    for await (const chunk of child) output += chunk.text
    const ended = await child.result
    const durationMs = (await $.clock.now()) - startedAt
    const exitCode = ended.code ?? 1
    if (exitCode !== 0 && durationMs < EARLY_EXIT_MS) finish($, ctx, { action: 'arrancar', cmd: target.cmd, exitCode, durationMs, output })
  } catch (err) {
    const durationMs = (await $.clock.now()) - startedAt
    finish($, ctx, { action: 'arrancar', cmd: target.cmd, exitCode: -1, durationMs, output: `No se pudo lanzar: ${String(err)}` })
  } finally {
    setRunning($, ctx, ctx.running.filter((a) => a !== 'arrancar'))
  }
}

export const register: Register = (on) => {
  const ctx: Ctx = { running: [], pending: [] }

  on('session.start', async ($, e, next) => {
    for (const action of ACTIONS) {
      await $.command.register({ name: action, description: DESCRIPTIONS[action], immediate: true })
    }
    return next(e)
  })

  for (const action of ACTIONS) {
    on('command.run', { command: action }, async ($) => {
      if (ctx.running.includes(action)) return { text: `Ya hay un /${action} en marcha.` }
      const target = await resolve($, action)
      if (typeof target === 'string') return { text: target }
      setRunning($, ctx, [...ctx.running, action])
      const work = action === 'arrancar' ? () => launch($, ctx, target) : () => runToEnd($, ctx, action, target)
      $.clock.after(0, () => void work().catch((err) => $.ui.log(`ultron-atajos: ${String(err).slice(0, 200)}`)))
      return { text: `Lanzado: ${target.cmd} (en ${target.cwd})` }
    })
  }

  on('prompt.submit', async (_$, e, next) => {
    if (ctx.pending.length === 0) return next(e)
    const extra = ctx.pending
    ctx.pending = []
    return next({ ...e, context: [...(e.context ?? []), ...extra] })
  })
}
