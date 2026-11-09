import type { CodexJob, CodexResult } from '../types'

/** Lógica pura del mod: argv del companion, parseo de su JSON y formato. */

export const PLUGIN_CACHE_REL = 'plugins/cache/openai-codex/codex'
export const PLUGIN_DATA_REL = 'plugins/data/codex-openai-codex'
export const COMPANION_REL = 'scripts/codex-companion.mjs'

/** Por encima de esta longitud el prompt va por stdin (límite de línea de órdenes de Windows). */
export const MAX_ARG_PROMPT = 8_000
/** Lo que se lleva al prompt de Claude como máximo; el resto se indica como recortado. */
export const MAX_SEND_CHARS = 6_000

/** Sondeo normal mientras hay trabajo vivo. */
export const POLL_MS = 3_000
/** Sondeo lento cuando los trabajos activos llevan mucho sin cambiar (worker muerto, por ejemplo). */
export const SLOW_POLL_MS = 30_000
/** Un trabajo activo cuyo registro no cambia en este tiempo se sondea despacio. */
export const STALE_MS = 10 * 60_000
/** Fallos seguidos de `status` tras los que se deja de sondear solo. */
export const MAX_POLL_FAILURES = 5
/** Caracteres del prompt que se recuerdan por trabajo. */
export const PROMPT_KEEP = 200
/** Trabajos recordados (prompts y avisos) por sesión. */
export const MAX_REMEMBERED = 100

const ACTIVE = new Set(['queued', 'running'])

export type TaskOptions = {
  prompt: string
  isWrite: boolean
  model: string | null
  effort: string | null
}

export type CompanionCall = { argv: string[]; stdin?: string }

export const isActiveStatus = (status: string): boolean => ACTIVE.has(status)

export const trunc = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text

export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

const slash = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '')

export const claudeDirOf = (configDir: string | undefined, home: string): string =>
  configDir !== undefined && configDir !== '' ? slash(configDir) : `${slash(home)}/.claude`

/** Versión más alta de una lista de carpetas tipo `1.0.4`; null si no hay ninguna. */
export function pickLatestVersion(names: readonly string[]): string | null {
  const parse = (name: string): number[] | null =>
    /^\d+(\.\d+)*$/.test(name) ? name.split('.').map((part) => Number(part)) : null
  const versions = names.flatMap((name) => {
    const parts = parse(name)
    return parts ? [{ name, parts }] : []
  })
  const compare = (a: number[], b: number[]): number => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const diff = (a[i] ?? 0) - (b[i] ?? 0)
      if (diff !== 0) return diff
    }
    return 0
  }
  const sorted = [...versions].sort((a, b) => compare(b.parts, a.parts))
  return sorted[0]?.name ?? null
}

/**
 * Separa las opciones iniciales (`--model x`, `-m x`, `--effort x`) del prompt,
 * que conserva saltos de línea y comillas tal cual.
 */
export function parseTaskArgs(args: string, isWrite: boolean): TaskOptions {
  const flag = /^\s*(--model|-m|--effort)(?:=|\s+)(\S+)/
  let rest = args
  let model: string | null = null
  let effort: string | null = null
  for (let match = flag.exec(rest); match !== null; match = flag.exec(rest)) {
    if (match[1] === '--effort') effort = match[2]!
    else model = match[2]!
    rest = rest.slice(match[0].length)
  }
  return { prompt: rest.trim(), isWrite, model, effort }
}

/** `task --background --json …`: el prompt va como un único argumento tras `--`, o por stdin si es largo. */
export function taskCall(node: string, script: string, task: TaskOptions): CompanionCall {
  const flags = [
    ...(task.isWrite ? ['--write'] : []),
    ...(task.model ? ['--model', task.model] : []),
    ...(task.effort ? ['--effort', task.effort] : []),
  ]
  const base = [node, script, 'task', '--background', '--json', ...flags]
  return task.prompt.length > MAX_ARG_PROMPT
    ? { argv: base, stdin: task.prompt }
    : { argv: [...base, '--', task.prompt] }
}

export const reviewArgv = (node: string, script: string): string[] => [
  node,
  script,
  'review',
  '--background',
  '--json',
  '--scope',
  'working-tree',
]

export const statusArgv = (node: string, script: string): string[] => [node, script, 'status', '--all', '--json']

export const resultArgv = (node: string, script: string, id: string): string[] => [node, script, 'result', id, '--json']

export const cancelArgv = (node: string, script: string, id: string): string[] => [node, script, 'cancel', id, '--json']

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

const str = (obj: Json, key: string): string => (typeof obj[key] === 'string' ? (obj[key] as string) : '')

function parseJson(stdout: string, what: string): Json {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch (err) {
    throw new Error(`${what}: el companion no devolvió JSON (${err instanceof Error ? err.message : String(err)})`)
  }
  if (!isObject(value)) throw new Error(`${what}: JSON inesperado`)
  return value
}

function toJob(raw: Json): CodexJob {
  const kind = str(raw, 'kindLabel') || str(raw, 'kind') || 'job'
  return {
    id: str(raw, 'id'),
    kind,
    title: str(raw, 'title'),
    status: str(raw, 'status') || 'desconocido',
    phase: str(raw, 'phase'),
    summary: str(raw, 'summary'),
    prompt: isObject(raw.request) ? str(raw.request, 'prompt') : '',
    time: str(raw, 'duration') || str(raw, 'elapsed'),
    updatedAt: str(raw, 'updatedAt'),
    isWrite: raw.write === true,
    isReview: str(raw, 'jobClass') === 'review' || kind.includes('review'),
    errorMessage: str(raw, 'errorMessage') || null,
  }
}

/** `status --all --json` → trabajos, en curso primero y luego el resto, sin duplicados. */
export function parseStatus(stdout: string): CodexJob[] {
  const snapshot = parseJson(stdout, 'status')
  const { running, latestFinished, recent } = snapshot
  if (!Array.isArray(running) || !Array.isArray(recent)) throw new Error('status: faltan las listas running/recent')
  const raws = [...running, ...(isObject(latestFinished) ? [latestFinished] : []), ...recent]
  const jobs = raws.filter(isObject).map(toJob).filter((job) => job.id !== '')
  return jobs.filter((job, index) => jobs.findIndex((other) => other.id === job.id) === index)
}

/** El texto del resultado con la misma prioridad que el render del propio plugin. */
function resultText(job: Json, stored: Json | null): string {
  const result = stored && isObject(stored.result) ? stored.result : null
  const codex = result && isObject(result.codex) ? result.codex : null
  const rendered = stored ? str(stored, 'rendered') : ''
  const isReview = str(job, 'jobClass') === 'review' || str(job, 'kind').includes('review')
  const candidates = [
    isReview ? rendered : '',
    result ? str(result, 'rawOutput') : '',
    codex ? str(codex, 'stdout') : '',
    rendered,
    str(job, 'errorMessage') || (stored ? str(stored, 'errorMessage') : ''),
  ]
  return candidates.find((text) => text.trim() !== '')?.trim() ?? '(el trabajo terminó sin salida)'
}

/** `result <id> --json` → resultado del trabajo. */
export function parseResult(stdout: string): CodexResult {
  const payload = parseJson(stdout, 'result')
  if (!isObject(payload.job)) throw new Error('result: falta el trabajo en la respuesta')
  const stored = isObject(payload.storedJob) ? payload.storedJob : null
  return {
    id: str(payload.job, 'id'),
    status: str(payload.job, 'status'),
    title: str(payload.job, 'title'),
    prompt: stored && isObject(stored.request) ? str(stored.request, 'prompt') : '',
    text: resultText(payload.job, stored),
  }
}

/** `task --json` → id del trabajo encolado. */
export function parseLaunch(stdout: string): string {
  const payload = parseJson(stdout, 'task')
  const id = str(payload, 'jobId')
  if (id === '') throw new Error('task: la respuesta no trae jobId')
  return id
}

/** Ids que estaban en curso y ya no lo están. */
export function finishedSince(before: readonly CodexJob[], after: readonly CodexJob[]): CodexJob[] {
  const wasActive = new Set(before.filter((job) => isActiveStatus(job.status)).map((job) => job.id))
  return after.filter((job) => wasActive.has(job.id) && !isActiveStatus(job.status))
}

/** El mensaje que se deja en el prompt de Claude, recortado si es largo. */
export function messageForClaude(result: CodexResult): string {
  const header = `Resultado de Codex (${result.id}):`
  const body =
    result.text.length > MAX_SEND_CHARS
      ? `${result.text.slice(0, MAX_SEND_CHARS)}\n\n[recortado: ${result.text.length - MAX_SEND_CHARS} caracteres más; completo con /codex:result ${result.id}]`
      : result.text
  return `${header}\n\n${body}\n`
}

/** Error legible del companion: stderr sin los avisos de deprecación de Node. */
export function companionError(stderr: string, stdout: string, exitCode: number): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('(node:') && !line.startsWith('(Use `node'))
  const detail = lines.join(' ') || oneLine(stdout) || 'sin mensaje'
  return `Codex falló (código ${exitCode}): ${trunc(detail, 400)}`
}

/** Lo que identifica un trabajo en el panel: el prompt recordado, el de la petición, el resumen o el título. */
export function promptOf(job: CodexJob, prompts: Readonly<Record<string, string>>): string {
  return prompts[job.id] || job.prompt || job.summary || job.title
}

/** Añade el inicio de un prompt al mapa, sin pasar de MAX_REMEMBERED entradas. */
export function rememberPrompt(prompts: Readonly<Record<string, string>>, id: string, prompt: string): Record<string, string> {
  const head = trunc(oneLine(prompt), PROMPT_KEEP)
  if (head === '') return { ...prompts }
  const kept = Object.entries(prompts).filter(([key]) => key !== id).slice(-(MAX_REMEMBERED - 1))
  return { ...Object.fromEntries(kept), [id]: head }
}

/** Ids nuevos al final de la lista, sin duplicados y sin pasar de MAX_REMEMBERED. */
export function rememberIds(known: readonly string[], ids: readonly string[]): string[] {
  const fresh = ids.filter((id, index) => !known.includes(id) && ids.indexOf(id) === index)
  return [...known, ...fresh].slice(-MAX_REMEMBERED)
}

/** Un trabajo activo cuyo registro no se ha tocado en STALE_MS. */
export function isStaleJob(job: CodexJob, now: number): boolean {
  const updated = Date.parse(job.updatedAt)
  return Number.isFinite(updated) && now - updated > STALE_MS
}

export type PollState = {
  jobs: readonly CodexJob[]
  now: number
  lastPolledAt: number
  failures: number
  inFlight: number
  isReviewAlive: boolean
}

/**
 * Si este tic del sondeo debe leer `status`: nunca con una lectura en curso ni
 * tras MAX_POLL_FAILURES fallos seguidos; deprisa con trabajo vivo y reciente,
 * despacio si todo lo activo lleva STALE_MS sin cambiar.
 */
export function shouldPoll(state: PollState): boolean {
  if (state.inFlight > 0 || state.failures >= MAX_POLL_FAILURES) return false
  if (state.isReviewAlive) return true
  const active = state.jobs.filter((job) => isActiveStatus(job.status))
  if (active.length === 0) return false
  if (active.some((job) => !isStaleJob(job, state.now))) return true
  return state.now - state.lastPolledAt >= SLOW_POLL_MS
}

/** El error de `status`, con el aviso de que el sondeo se ha parado si toca. */
export function refreshFailureText(error: string, failures: number): string {
  return failures >= MAX_POLL_FAILURES
    ? `${error}
Sondeo automático detenido tras ${failures} fallos seguidos; pulsa «refrescar» para reintentar.`
    : error
}

/** Revisiones terminadas que no existían al lanzar la revisión. */
export function finishedReviewsSince(idsBefore: readonly string[], jobs: readonly CodexJob[]): CodexJob[] {
  return jobs.filter((job) => job.isReview && !isActiveStatus(job.status) && !idsBefore.includes(job.id))
}
