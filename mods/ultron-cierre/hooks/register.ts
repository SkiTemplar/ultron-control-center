import type { EngineInterface, Register } from 'claude-code'

import { closingNotice, countPorcelain, isRunnerBusy, parseResult, pickForCwd } from './check'
import type { TestsResult } from './check'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const GIT_TIMEOUT_MS = 5_000
/** Un lock del runner más viejo que esto se considera abandonado (el runner tiene tope de 120 s). */
const LOCK_STALE_MS = 150_000

/** Directorio donde run-project-tests deja sus resultados: `~/.ultron/.tmp/run-tests`. */
const runsDir = ($: EngineInterface): string => `${$.plugin.root}/../../.tmp/run-tests`

const editedPath = (input: Record<string, unknown>): string => {
  if (typeof input.file_path === 'string') return input.file_path
  return typeof input.notebook_path === 'string' ? input.notebook_path : ''
}

/** Ficheros sin commitear en el cwd; null si git no responde (no es repo, timeout…). */
async function dirtyCount($: EngineInterface, cwd: string): Promise<number | null> {
  try {
    const run = await $.process.run(['git', 'status', '--porcelain'], { cwd, timeoutMs: GIT_TIMEOUT_MS })
    return run.exitCode === 0 ? countPorcelain(run.stdout) : null
  } catch {
    return null
  }
}

const logError = ($: EngineInterface, what: string, err: unknown): void =>
  void $.ui.log(`ultron-cierre: ${what}: ${String(err).slice(0, 200)}`)

/** Un `.result.json` parseado; null (y una línea de log) si no se puede leer. */
async function readResult($: EngineInterface, dir: string, name: string): Promise<TestsResult | null> {
  try {
    return parseResult(String(await $.fs.read(`${dir}/${name}`)))
  } catch (err) {
    logError($, `no se pudo leer ${name}`, err)
    return null
  }
}

/**
 * ¿El runner del proyecto sigue en marcha? Un lock ilegible cuenta como «no
 * ocupado» (mismo criterio que isRunnerBusy con un lock corrupto): no se pierde
 * un rojo por no poder leer el lock.
 */
async function isBusy($: EngineInterface, dir: string, project: string): Promise<boolean> {
  const name = `${project}.state.json`
  try {
    if (!(await $.fs.exists(`${dir}/${name}`))) return false
    return isRunnerBusy(String(await $.fs.read(`${dir}/${name}`)), await $.clock.now(), LOCK_STALE_MS)
  } catch (err) {
    logError($, `no se pudo leer ${name}`, err)
    return false
  }
}

/**
 * Último resultado de tests del proyecto del cwd; null si no hay o el runner
 * sigue en marcha. Un `.result.json` ilegible se omite y se registra en el log,
 * sin descartar los demás.
 */
async function latestTests($: EngineInterface, cwd: string): Promise<TestsResult | null> {
  try {
    const dir = runsDir($)
    if (!(await $.fs.exists(dir))) return null
    const results: TestsResult[] = []
    for (const entry of (await $.fs.list(dir)).filter((f) => f.kind === 'file' && f.name.endsWith('.result.json'))) {
      const parsed = await readResult($, dir, entry.name)
      if (parsed) results.push(parsed)
    }
    const result = pickForCwd(results, cwd)
    if (!result) return null
    return (await isBusy($, dir, result.project)) ? null : result
  } catch (err) {
    logError($, 'no se pudieron listar los resultados de tests', err)
    return null
  }
}

/** Comprueba tests y git y, si queda algo pendiente, lo avisa y sugiere el siguiente prompt. */
async function closeTurn($: EngineInterface): Promise<void> {
  const cwd = await $.session.cwd()
  const [tests, dirty] = await Promise.all([latestTests($, cwd), dirtyCount($, cwd)])
  const notice = closingNotice({ tests, dirtyCount: dirty })
  if (notice === null) return
  $.ui.toast(notice.toast)
  await $.prompt.suggest({ text: notice.suggestion })
}

export const register: Register = (on) => {
  // Ficheros editados por el bucle principal en el turno en curso.
  let edited: string[] = []

  on('turn.start', async (_$, e, next) => {
    edited = []
    return next(e)
  })

  on('tool.call', async (_$, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || !EDIT_TOOLS.has(String(e.tool)) || 'deny' in result) return result
    const path = editedPath(e as unknown as Record<string, unknown>)
    if (path !== '' && !edited.includes(path)) edited = [...edited, path]
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer' || edited.length === 0) return result
    $.clock.after(0, () => void closeTurn($).catch((err) => $.ui.log(`ultron-cierre: ${String(err).slice(0, 200)}`)))
    return result
  })
}
