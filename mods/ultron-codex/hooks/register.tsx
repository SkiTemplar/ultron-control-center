import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CodexJob, CodexResult } from '../types'
import {
  COMPANION_REL,
  PLUGIN_CACHE_REL,
  PLUGIN_DATA_REL,
  POLL_MS,
  type CompanionCall,
  cancelArgv,
  claudeDirOf,
  companionError,
  finishedReviewsSince,
  finishedSince,
  isActiveStatus,
  messageForClaude,
  parseLaunch,
  parseResult,
  parseStatus,
  parseTaskArgs,
  pickLatestVersion,
  refreshFailureText,
  rememberIds,
  rememberPrompt,
  resultArgv,
  reviewArgv,
  shouldPoll,
  statusArgv,
  taskCall,
} from './codex'
import { type Actions, codexView } from './view'

const PANE = 'codex'
const NODE = 'node'
const RUN_TIMEOUT_MS = 60_000
const REVIEW_SETTLE_MS = 1_500
const CLAIM_ATTEMPTS = 5

const snapshotAtom = atom({ plugin: 'ultron-codex', key: 'snapshot' } as const, { seq: 0, jobs: [] })
const seqAtom = atom({ plugin: 'ultron-codex', key: 'refreshSeq' } as const, 0)
const inFlightAtom = atom({ plugin: 'ultron-codex', key: 'refreshesInFlight' } as const, 0)
const failuresAtom = atom({ plugin: 'ultron-codex', key: 'pollFailures' } as const, 0)
const lastPolledAtom = atom({ plugin: 'ultron-codex', key: 'lastPolledAt' } as const, 0)
const reviewAliveAtom = atom({ plugin: 'ultron-codex', key: 'isReviewAlive' } as const, false)
const promptsAtom = atom({ plugin: 'ultron-codex', key: 'prompts' } as const, {})
const selectedAtom = atom({ plugin: 'ultron-codex', key: 'selectedId' } as const, null)
const detailAtom = atom({ plugin: 'ultron-codex', key: 'detail' } as const, null)
const loadingAtom = atom({ plugin: 'ultron-codex', key: 'isLoading' } as const, false)
const errorAtom = atom({ plugin: 'ultron-codex', key: 'error' } as const, null)
const actionErrorAtom = atom({ plugin: 'ultron-codex', key: 'actionError' } as const, null)
const noticeAtom = atom({ plugin: 'ultron-codex', key: 'notice' } as const, null)
const announcedRef = { plugin: 'ultron-codex', key: 'announced' } as const

type Companion = { script: string; env: Record<string, string> }
type Outcome<T> = { isOk: true; value: T } | { isOk: false; error: string }

const set = <T,>(value: T) => () => value

const autoOpenedAtom = atom({ plugin: 'ultron-codex', key: 'hasAutoOpened' } as const, false)

/** Abre el panel sin que se pida, una vez por sesión y solo en pantalla completa (acoplado, sin foco). */
async function autoOpen($: EngineInterface): Promise<void> {
  // Dentro de ULTRON Sessions la ventana tiene su propia interfaz: sin panel automático.
  if (await $.env.get('ULTRON_SESION_ID')) return
  if (await read($, autoOpenedAtom)) return
  await update($, autoOpenedAtom, set(true))
  await $.ui.open({ id: PANE, title: 'Codex', closeOnEscape: true, rows: 20 })
}
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const withProblem = (line: string, problem: string | null): string =>
  problem === null ? line : `${line}\n${problem}`
const fail = (error: string): { isOk: false; error: string } => ({ isOk: false, error })

/** Localiza el companion del plugin openai-codex (la versión más alta instalada). */
async function resolveCompanion($: EngineInterface): Promise<Outcome<Companion>> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (home === '' && (configDir ?? '') === '') return fail('Codex: no encuentro el directorio personal (USERPROFILE/HOME).')
  const claudeDir = claudeDirOf(configDir, home)
  const base = `${claudeDir}/${PLUGIN_CACHE_REL}`
  if (!(await $.fs.exists(base))) return fail(`Codex: el plugin openai-codex no está instalado (no existe ${base}).`)
  const versions = (await $.fs.list(base)).filter((entry) => entry.kind === 'dir').map((entry) => entry.name)
  const version = pickLatestVersion(versions)
  if (version === null) return fail(`Codex: no hay ninguna versión del plugin en ${base}.`)
  const script = `${base}/${version}/${COMPANION_REL}`
  if (!(await $.fs.exists(script))) return fail(`Codex: falta el companion ${script}.`)
  const env = { CLAUDE_PLUGIN_DATA: `${claudeDir}/${PLUGIN_DATA_REL}`, CODEX_COMPANION_SESSION_ID: await $.session.id() }
  return { isOk: true, value: { script, env } }
}

/** Ejecuta el companion con la llamada que construye `build`; stdout si sale con 0. */
async function runCompanion(
  $: EngineInterface,
  build: (node: string, script: string) => CompanionCall,
): Promise<Outcome<string>> {
  try {
    const companion = await resolveCompanion($)
    if (!companion.isOk) return companion
    const call = build(NODE, companion.value.script)
    const init = { env: companion.value.env, timeoutMs: RUN_TIMEOUT_MS }
    const run = await $.process.run(call.argv, call.stdin === undefined ? init : { ...init, stdin: call.stdin })
    if (run.exitCode !== 0) return fail(companionError(run.stderr, run.stdout, run.exitCode))
    return { isOk: true, value: run.stdout }
  } catch (err) {
    return fail(`Codex: no se pudo ejecutar node: ${message(err)}`)
  }
}

/** Error de lectura (status/result): lo limpia la siguiente lectura correcta. */
async function showError($: EngineInterface, error: string | null): Promise<void> {
  await update($, errorAtom, set<string | null>(error))
}

/** Error de una acción del usuario: solo lo limpia otra acción correcta, «volver» o «descartar». */
async function showActionError($: EngineInterface, error: string | null): Promise<void> {
  await update($, actionErrorAtom, set<string | null>(error))
}

async function loadDetail($: EngineInterface, id: string): Promise<void> {
  await update($, loadingAtom, set(true))
  const out = await runCompanion($, (node, script) => ({ argv: resultArgv(node, script, id) }))
  try {
    if (!out.isOk) return await showError($, out.error)
    const result = parseResult(out.value)
    await update($, detailAtom, set<CodexResult | null>(result))
    if (result.prompt !== '') await update($, promptsAtom, (prompts) => rememberPrompt(prompts, id, result.prompt))
    await showError($, null)
  } catch (err) {
    await showError($, message(err))
  } finally {
    await update($, loadingAtom, set(false))
  }
}

/** Reserva los avisos de fin (escritura condicional): dos lecturas simultáneas no avisan dos veces. */
async function claimAnnouncements($: EngineInterface, jobs: readonly CodexJob[]): Promise<CodexJob[]> {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    const held = await $.state.get(announcedRef)
    const known = held.value ?? []
    const fresh = jobs.filter((job) => !known.includes(job.id))
    if (fresh.length === 0) return []
    const written = await $.state.set(announcedRef, rememberIds(known, fresh.map((job) => job.id)), { ifVersion: held.version })
    if (written.isSet) return fresh
  }
  return [...jobs]
}

async function announceFinished($: EngineInterface, finished: readonly CodexJob[]): Promise<void> {
  if (finished.length === 0) return
  const claimed = await claimAnnouncements($, finished)
  const selected = await read($, selectedAtom)
  for (const job of claimed) {
    $.ui.toast(`Codex ${job.id} terminado${job.status === 'completed' ? '' : ` (${job.status})`}`)
    if (job.id === selected) await loadDetail($, job.id)
  }
}

/** Guarda la lista si es la lectura más reciente (una respuesta lenta no pisa a otra nueva). */
async function applyStatus($: EngineInterface, seq: number, jobs: CodexJob[]): Promise<void> {
  const previous = (await read($, snapshotAtom)).jobs
  const written = await update($, snapshotAtom, (current) => (seq > current.seq ? { seq, jobs } : current))
  if (written.seq !== seq) return
  await update($, failuresAtom, set(0))
  await showError($, null)
  await announceFinished($, finishedSince(previous, jobs))
}

async function noteRefreshFailure($: EngineInterface, error: string): Promise<void> {
  const failures = await update($, failuresAtom, (count) => count + 1)
  await showError($, refreshFailureText(error, failures))
}

/** Relee la lista de trabajos; avisa de los que acaban de terminar. */
async function refresh($: EngineInterface, isQuiet: boolean): Promise<void> {
  await update($, inFlightAtom, (count) => count + 1)
  if (!isQuiet) await update($, loadingAtom, set(true))
  try {
    const seq = await update($, seqAtom, (count) => count + 1)
    const out = await runCompanion($, (node, script) => ({ argv: statusArgv(node, script) }))
    if (!out.isOk) return await noteRefreshFailure($, out.error)
    await applyStatus($, seq, parseStatus(out.value))
  } catch (err) {
    await noteRefreshFailure($, message(err))
  } finally {
    await update($, inFlightAtom, (count) => Math.max(0, count - 1))
    if (!isQuiet) await update($, loadingAtom, set(false))
  }
}

async function poll($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const isDue = shouldPoll({
    jobs: (await read($, snapshotAtom)).jobs,
    now,
    lastPolledAt: await read($, lastPolledAtom),
    failures: await read($, failuresAtom),
    inFlight: await read($, inFlightAtom),
    isReviewAlive: await read($, reviewAliveAtom),
  })
  if (!isDue) return
  await update($, lastPolledAtom, set(now))
  await refresh($, true)
}

async function openPane($: EngineInterface): Promise<string | null> {
  const opened = await $.ui.open({ id: PANE, title: 'Codex', focus: true, closeOnEscape: true, rows: 20 })
  return opened.isPlaced ? null : `No se pudo abrir el panel de Codex: ${opened.reason}`
}

/** `/codex` y `/codex-write`: encola la tarea, abre el panel y devuelve la línea del chat. */
async function launchTask($: EngineInterface, args: string, isWrite: boolean): Promise<string> {
  const task = parseTaskArgs(args, isWrite)
  if (task.prompt === '') {
    const error = 'Codex: falta el prompt (uso: /codex-write [--model m] [--effort e] <prompt>).'
    await showActionError($, error)
    return error
  }
  const out = await runCompanion($, (node, script) => taskCall(node, script, task))
  let line: string
  try {
    if (!out.isOk) throw new Error(out.error)
    const id = parseLaunch(out.value)
    line = isWrite
      ? `Codex ${id} lanzado CON ESCRITURA: puede modificar ficheros del working tree.`
      : `Codex ${id} lanzado en segundo plano (solo lectura).`
    await update($, promptsAtom, (prompts) => rememberPrompt(prompts, id, task.prompt))
    await update($, noticeAtom, set<string | null>(isWrite ? `⚠ ${line}` : line))
    await update($, selectedAtom, set<string | null>(null))
    await showActionError($, null)
  } catch (err) {
    line = message(err)
    await showActionError($, line)
  }
  const problem = await openPane($)
  await refresh($, false)
  return withProblem(line, problem)
}

/** Corre la revisión hasta que el hijo sale; el error legible si no sale con 0. */
async function runReviewChild($: EngineInterface, companion: Companion): Promise<string | null> {
  try {
    const child = $.process.spawn({ argv: reviewArgv(NODE, companion.script), env: companion.env })
    const chunks: { stream: string; text: string }[] = []
    for await (const chunk of child) chunks.push(chunk)
    const ended = await child.result
    if (ended.code === 0) return null
    const textOf = (stream: string) => chunks.filter((one) => one.stream === stream).map((one) => one.text).join('')
    return companionError(textOf('stderr'), textOf('stdout'), ended.code ?? 1)
  } catch (err) {
    return `Codex: no se pudo ejecutar node: ${message(err)}`
  }
}

/** Mientras el hijo vive se sondea; al salir se avisa de la revisión aunque nunca se viera en curso. */
async function followReview($: EngineInterface, companion: Companion, idsBefore: readonly string[]): Promise<void> {
  const failure = await runReviewChild($, companion)
  await update($, reviewAliveAtom, set(false))
  if (failure !== null) await showActionError($, failure)
  await refresh($, true)
  await announceFinished($, finishedReviewsSince(idsBefore, (await read($, snapshotAtom)).jobs))
}

/** El review del companion corre en primer plano: se lanza como hijo vivo y se sigue por status. */
async function launchReview($: EngineInterface): Promise<string> {
  const companion = await resolveCompanion($).catch((err: unknown) => fail(`Codex: ${message(err)}`))
  if (!companion.isOk) {
    await showActionError($, companion.error)
    await openPane($)
    return companion.error
  }
  const idsBefore = (await read($, snapshotAtom)).jobs.map((job) => job.id)
  await update($, reviewAliveAtom, set(true))
  await showActionError($, null)
  void followReview($, companion.value, idsBefore)
  const line = 'Revisión de Codex del working tree lanzada en segundo plano.'
  await update($, noticeAtom, set<string | null>(line))
  await update($, selectedAtom, set<string | null>(null))
  $.clock.after(REVIEW_SETTLE_MS, () => void refresh($, true))
  const problem = await openPane($)
  return withProblem(line, problem)
}

async function sendToClaude($: EngineInterface): Promise<void> {
  const detail = await read($, detailAtom)
  if (detail === null) return showActionError($, 'No hay resultado cargado que enviar.')
  const text = messageForClaude(detail)
  const filled = await $.prompt.fill({ text, mode: 'append' })
  if (filled.isFilled) {
    $.ui.toast(`Resultado de Codex ${detail.id} en el prompt`)
    return
  }
  const copied = await $.ui.copy({ text })
  const why = filled.refusal ? ` (${filled.refusal})` : ''
  if (copied.isCopied) {
    $.ui.toast(`No pude escribir en el prompt${why}: resultado de ${detail.id} copiado al portapapeles`)
    return
  }
  await showActionError($, `No pude escribir en el prompt${why} ni copiar al portapapeles (${copied.reason}).`)
}

async function cancelJob($: EngineInterface, id: string): Promise<void> {
  const out = await runCompanion($, (node, script) => ({ argv: cancelArgv(node, script, id) }))
  if (!out.isOk) return showActionError($, out.error)
  await showActionError($, null)
  await update($, noticeAtom, set<string | null>(`Codex ${id} cancelado.`))
  await refresh($, true)
}

async function selectJob($: EngineInterface, id: string): Promise<void> {
  await update($, selectedAtom, set<string | null>(id))
  await showError($, null)
  const job = (await read($, snapshotAtom)).jobs.find((one) => one.id === id)
  if (job !== undefined && !isActiveStatus(job.status)) await loadDetail($, id)
}

async function goBack($: EngineInterface): Promise<void> {
  await update($, selectedAtom, set<string | null>(null))
  await showActionError($, null)
}

function actionsFor($: EngineInterface): Actions {
  return {
    select: (id) => void selectJob($, id),
    back: () => void goBack($),
    dismiss: () => void showActionError($, null),
    cancel: (id) => void cancelJob($, id),
    send: () => void sendToClaude($),
    refresh: () => void refresh($, false),
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'codex',
      description: 'Codex en segundo plano (solo lectura); sin argumentos abre el panel',
      argumentHint: '[--model m] [--effort e] [prompt]',
      immediate: true,
    })
    await $.command.register({
      name: 'codex-write',
      description: 'Tarea de Codex con escritura: puede modificar ficheros',
      argumentHint: '[--model m] [--effort e] <prompt>',
      immediate: true,
    })
    await $.command.register({
      name: 'codex-review',
      description: 'Revisión de Codex del working tree en segundo plano',
      immediate: true,
    })
    $.clock.every(POLL_MS, () => void poll($))
    return next(e)
  })

  on('command.run', { command: 'codex' }, async ($, e) => {
    if (e.args.trim() !== '') return { text: await launchTask($, e.args, false) }
    const problem = await openPane($)
    $.clock.after(0, () => void refresh($, false))
    return problem ? { text: problem } : {}
  })

  on('command.run', { command: 'codex-write' }, async ($, e) => ({ text: await launchTask($, e.args, true) }))

  on('command.run', { command: 'codex-review' }, async ($) => ({ text: await launchReview($) }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.viewport?.isFullscreen === true) $.clock.after(0, () => void autoOpen($))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface === 'mobile') return next(e)
    return codexView(
      $.ui.resolve(e),
      {
        jobs: (await read($, snapshotAtom)).jobs,
        prompts: await read($, promptsAtom),
        selectedId: await read($, selectedAtom),
        detail: await read($, detailAtom),
        isLoading: await read($, loadingAtom),
        error: await read($, errorAtom),
        actionError: await read($, actionErrorAtom),
        notice: await read($, noticeAtom),
        width: e.props.bodyColumns,
        rows: e.viewport?.rows ?? 30,
      },
      actionsFor($),
    )
  })
}
