import type { EngineInterface, Register } from 'claude-code'

import { REF_ROOT, formatList, localStamp, parseChangedCounts, parseIndex, parseRefs, parseStatusV2, refsToPrune, restoreHint, sessionPrefix } from './checkpoint'
import type { Checkpoint } from './checkpoint'
import { NotRepoError, TimeoutError, makeRunner, repoOf, tmpIndexPath, writeWorktreeTree } from './git'
import type { Repo, Runner } from './git'

/** Herramientas de edición: antes de la primera de cada turno se hace la foto. `Bash` no cuenta: casi
 * todos los turnos lo usan y la foto (`git add -A`) retrasaría hasta 10 s cada uno (revisión 2026-10-15). */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SNAPSHOT_BUDGET_MS = 10_000
const COMMAND_BUDGET_MS = 15_000
const CLEANUP_BUDGET_MS = 10_000
const MAX_ENTRIES = 5_000
const KEEP_PER_REPO = 30
const REFS_FORMAT = '--format=%(refname)%09%(objectname)'
/** Autor fijo: la foto no depende de que el repo tenga user.name configurado. */
const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: 'ULTRON checkpoint',
  GIT_AUTHOR_EMAIL: 'checkpoint@ultron.local',
  GIT_COMMITTER_NAME: 'ULTRON checkpoint',
  GIT_COMMITTER_EMAIL: 'checkpoint@ultron.local',
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200)

const scriptOf = ($: EngineInterface): string => `${$.plugin.root}/bin/indice.cjs`

type Outcome = { saved: string } | { warning: string } | null

/** Borra el índice temporal (y su .lock si quedó) y poda las fotos de más; devuelve los problemas. */
async function cleanup($: EngineInterface, repo: Repo, tmpIndex: string | null): Promise<string[]> {
  const run = makeRunner($, repo.root, (await $.clock.now()) + CLEANUP_BUDGET_MS)
  const problems: string[] = []
  if (tmpIndex !== null) {
    await run(['node', scriptOf($), 'remove', tmpIndex, `${tmpIndex}.lock`]).catch((err: unknown) =>
      problems.push(`no se pudo borrar el índice temporal ${tmpIndex}: ${reasonOf(err)}`),
    )
  }
  await prune(run).catch((err: unknown) => problems.push(`no se pudieron podar los checkpoints viejos: ${reasonOf(err)}`))
  return problems
}

/** Deja las KEEP_PER_REPO fotos más recientes del repo, de todas las sesiones. */
async function prune(run: Runner): Promise<void> {
  const extra = refsToPrune(parseRefs(await run(['git', 'for-each-ref', REFS_FORMAT, REF_ROOT])), KEEP_PER_REPO)
  if (extra.length === 0) return
  await run(['git', 'update-ref', '--stdin'], { stdin: extra.map((ref) => `delete ${ref}\n`).join('') })
}

const snapshotWarning = (err: unknown): string =>
  err instanceof TimeoutError
    ? `foto omitida: superó el tope de ${SNAPSHOT_BUDGET_MS / 1000} s (${reasonOf(err)}).`
    : `foto omitida: ${reasonOf(err)}.`

/** Guarda el árbol de trabajo completo en una ref propia sin tocar el índice ni el árbol. */
async function snapshot($: EngineInterface): Promise<Outcome> {
  const start = await $.clock.now()
  const run = makeRunner($, await $.session.cwd(), start + SNAPSHOT_BUDGET_MS)
  let repo: Repo
  try {
    repo = await repoOf(run)
  } catch (err) {
    return err instanceof NotRepoError ? null : { warning: snapshotWarning(err) }
  }
  let tmpIndex: string | null = null
  try {
    const status = parseStatusV2(await run(['git', 'status', '--porcelain=v2', '--branch'], { cwd: repo.root }))
    if (status.entries > MAX_ENTRIES) {
      return { warning: `foto omitida: git status lista ${status.entries} entradas (el tope es ${MAX_ENTRIES}).` }
    }
    tmpIndex = tmpIndexPath(repo, start)
    const tree = await writeWorktreeTree(run, repo, scriptOf($), tmpIndex)
    const sessionId = await $.session.id()
    const parent = status.head === null ? [] : ['-p', status.head]
    const message = `ultron checkpoint · sesión ${sessionId} · ${localStamp(start)}`
    const commit = (await run(['git', 'commit-tree', tree, ...parent, '-m', message], { env: AUTHOR_ENV, cwd: repo.root })).trim()
    const ref = `${sessionPrefix(sessionId)}${start}`
    await run(['git', 'update-ref', ref, commit], { cwd: repo.root })
    return { saved: ref }
  } catch (err) {
    return { warning: snapshotWarning(err) }
  } finally {
    const done = repo
    const leftover = tmpIndex
    // Fuera del camino de la edición: el borrado y la poda no retrasan la herramienta.
    $.clock.after(0, () => void cleanupAndWarn($, done, leftover))
  }
}

/** Fotos de la sesión en el repo del cwd, la más reciente primero. */
async function sessionCheckpoints($: EngineInterface, run: Runner): Promise<Checkpoint[]> {
  const prefix = sessionPrefix(await $.session.id())
  return parseRefs(await run(['git', 'for-each-ref', REFS_FORMAT, prefix.slice(0, -1)]))
}

async function listText($: EngineInterface, lastWarning: string | null): Promise<string> {
  const header = lastWarning === null ? [] : [`Último aviso: ${lastWarning}`]
  const cwd = await $.session.cwd()
  try {
    const run = makeRunner($, cwd, (await $.clock.now()) + COMMAND_BUDGET_MS)
    await repoOf(run)
    const list = await sessionCheckpoints($, run)
    if (list.length === 0) {
      return [...header, 'Sin checkpoints en esta sesión: se guarda uno antes de la primera edición de cada turno.'].join('\n')
    }
    const log = await run(['git', 'log', '--no-walk=unsorted', '--format=%x00%H', '--name-only', ...list.map((c) => c.sha)])
    return [...header, formatList(list, parseChangedCounts(log))].join('\n')
  } catch (err) {
    if (err instanceof NotRepoError) return [...header, `No es un repositorio git: ${cwd}`].join('\n')
    return [...header, `No se pudieron listar los checkpoints: ${reasonOf(err)}`].join('\n')
  }
}

async function diffText($: EngineInterface, args: string): Promise<string> {
  const usage = parseIndex(args, Number.POSITIVE_INFINITY)
  if (typeof usage !== 'number') return usage.error
  const cwd = await $.session.cwd()
  const run = makeRunner($, cwd, (await $.clock.now()) + COMMAND_BUDGET_MS)
  let repo: Repo
  let list: Checkpoint[]
  try {
    repo = await repoOf(run)
    list = await sessionCheckpoints($, run)
  } catch (err) {
    return err instanceof NotRepoError ? `No es un repositorio git: ${cwd}` : `No se pudieron leer los checkpoints: ${reasonOf(err)}`
  }
  const n = parseIndex(args, list.length)
  if (typeof n !== 'number') return n.error
  const target = list[n - 1]!
  const tmpIndex = tmpIndexPath(repo, await $.clock.now())
  try {
    const tree = await writeWorktreeTree(run, repo, scriptOf($), tmpIndex)
    const stat = (await run(['git', 'diff', '--stat', target.sha, tree], { cwd: repo.root })).trimEnd()
    return [
      `Checkpoint ${n} (${localStamp(target.takenAt)}) contra el árbol actual, sin seguimiento incluidos:`,
      stat === '' ? 'Sin diferencias.' : stat,
      restoreHint(target.ref),
    ].join('\n')
  } catch (err) {
    return `No se pudo comparar el checkpoint ${n}: ${reasonOf(err)}`
  } finally {
    const problems = await cleanup($, repo, tmpIndex)
    for (const problem of problems) $.ui.log(`Checkpoint: ${problem}`)
  }
}

// Estado de la carga del módulo (una recarga lo reinicia: como mucho, una foto de más).
let turn = 0
let shotTurn = -1
let pending: Promise<void> = Promise.resolve()
let lastWarning: string | null = null
const reported = new Set<string>()

/** Aviso visible como línea en el transcript. Dentro de ULTRON Sessions no se lanza ningún comando:
 * competiría con la cola de la app; el aviso queda en `/checkpoints`. */
async function warn($: EngineInterface, text: string): Promise<void> {
  lastWarning = text
  if (reported.has(text)) return
  reported.add(text)
  $.ui.log(`Checkpoint: ${text}`)
}


async function cleanupAndWarn($: EngineInterface, repo: Repo, tmpIndex: string | null): Promise<void> {
  for (const problem of await cleanup($, repo, tmpIndex)) await warn($, problem)
}

async function takeSnapshot($: EngineInterface): Promise<void> {
  try {
    const outcome = await snapshot($)
    if (outcome !== null && 'warning' in outcome) await warn($, outcome.warning)
  } catch (err) {
    await warn($, `foto omitida: ${reasonOf(err)}.`)
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'checkpoints',
      description: 'Lista las fotos del árbol de trabajo guardadas en esta sesión',
      immediate: true,
    })
    await $.command.register({
      name: 'checkpoint-diff',
      description: 'Resumen de diferencias entre un checkpoint y el árbol actual',
      argumentHint: '<n>',
      immediate: true,
    })
    return next(e)
  })

  // Un turno del bucle principal abre la ventana de una foto; los subagentes cuentan dentro de él.
  on('turn.start', async (_$, e, next) => {
    if (!('agentId' in e) || e.agentId === undefined) turn += 1
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (!EDIT_TOOLS.has(String(e.tool))) return next(e)
    if (shotTurn !== turn) {
      shotTurn = turn
      pending = takeSnapshot($)
    }
    // Las ediciones en paralelo esperan a la foto en curso para no colarse en ella.
    await pending
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'checkpoints' }, async ($) => ({ text: await listText($, lastWarning) }))

  on('command.run', { command: 'checkpoint-diff' }, async ($, e) => ({ text: await diffText($, e.args) }))
}
