import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { SYSTEM, buildPrompt, clipError, failureReason, projectNameFor, summarizeStatus } from './context'
import type { PromptContext } from './context'

const MODEL = 'claude-sonnet-5-5'
const GIT_TIMEOUT_MS = 5_000
const MODEL_TIMEOUT_MS = 45_000
const STATUS_TEXT = 'mejorando prompt…'
const FILLED_TEXT = 'Prompt mejorado en la caja: revísalo y pulsa Enter.'

const lastPromptAtom = atom({ plugin: 'ultron-mejorar', key: 'lastPrompt' } as const, null)
const lastToolErrorAtom = atom({ plugin: 'ultron-mejorar', key: 'lastToolError' } as const, null)

const set = <T,>(value: T) => () => value

/** Ejecuta git en el cwd; null si falla o tarda (el contexto se omite, no es un error del comando). */
async function git($: EngineInterface, cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const run = await $.process.run(['git', '-C', cwd, ...args], { timeoutMs: GIT_TIMEOUT_MS })
    return run.exitCode === 0 ? run.stdout : null
  } catch {
    return null
  }
}

/** Nombre del proyecto ULTRON del cwd; null si no hay registro o no se puede leer. */
async function ultronProject($: EngineInterface, cwd: string): Promise<string | null> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (!home) return null
  const path = `${home}/.ultron/cockpit/projects.json`
  try {
    if (!(await $.fs.exists(path))) return null
    return projectNameFor(String(await $.fs.read(path)), cwd)
  } catch {
    return null
  }
}

async function gatherContext($: EngineInterface): Promise<PromptContext> {
  const cwd = await $.session.cwd()
  const [repo, branch, porcelain, project] = await Promise.all([
    $.session.repo().catch(() => null),
    git($, cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git($, cwd, ['status', '--porcelain']),
    ultronProject($, cwd),
  ])
  return {
    cwd,
    project,
    repo: repo ? (repo.name ?? repo.root) : null,
    branch: branch?.trim() || null,
    status: porcelain === null ? null : summarizeStatus(porcelain),
    lastError: await read($, lastToolErrorAtom),
  }
}

/** Pide la reescritura y la deja en la caja; devuelve el texto que muestra el comando. */
async function improve($: EngineInterface, draft: string, isPrevious: boolean): Promise<string> {
  const ctx = await gatherContext($)
  const result = await $.model.complete({
    model: MODEL,
    effort: 'medium',
    maxTokens: 800,
    timeoutMs: MODEL_TIMEOUT_MS,
    system: SYSTEM,
    prompt: buildPrompt(draft, ctx),
  })
  if (!result.isAnswered) return `No se pudo mejorar el prompt: ${failureReason(result)}.`
  const text = result.text.trim()
  if (text.length === 0) return 'No se pudo mejorar el prompt: el modelo respondió vacío.'
  const prefix = isPrevious ? 'Sin borrador: he mejorado tu prompt anterior. ' : ''
  const filled = await $.prompt.fill({ text, mode: 'replace' })
  if (filled.isFilled) return `${prefix}${FILLED_TEXT}`
  return `${prefix}No se pudo escribir en la caja; cópialo desde aquí:\n\n${text}`
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mejorar',
      description: 'Reescribe el borrador del prompt con el contexto del proyecto y lo deja en la caja para revisarlo',
      argumentHint: '<borrador del prompt>',
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const isTyped = e.origin.kind === 'composer' && !e.text.trimStart().startsWith('/')
    if (isTyped && e.text.trim().length > 0) {
      await update($, lastPromptAtom, set<string | null>(e.text))
      await update($, lastToolErrorAtom, set<string | null>(null))
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if ('isError' in result && result.isError === true) {
      await update($, lastToolErrorAtom, set<string | null>(clipError(result.text ?? '')))
    }
    return result
  })

  on('command.run', { command: 'mejorar' }, async ($, e) => {
    const typed = e.args.trim()
    const draft = typed || (await read($, lastPromptAtom))
    if (!draft) return { text: 'No hay borrador que mejorar: escribe /mejorar <borrador>.' }
    $.ui.status(STATUS_TEXT)
    try {
      return { text: await improve($, draft, typed.length === 0) }
    } catch (err) {
      return { text: `No se pudo mejorar el prompt: ${String(err).slice(0, 300)}` }
    } finally {
      $.ui.status(undefined)
    }
  })
}
