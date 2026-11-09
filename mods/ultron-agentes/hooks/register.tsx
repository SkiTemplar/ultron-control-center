import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, WorkflowRun } from '../types'
import {
  describeTool,
  isActive,
  lastAssistantOf,
  pruneActivity,
  subagentRow,
  withResult,
  withSpawn,
  withStatuses,
  withTool,
  withoutFinished,
} from './agents'
import { detailView } from './detail'
import { agentsView } from './view'
import {
  type Launch,
  type MetaRead,
  type RunFiles,
  RUN_QUIET_MS,
  droppedByRun,
  foldJournal,
  freshAgentIds,
  isRunDue,
  isRunOver,
  lastAssistantInTranscript,
  mergeJournal,
  metaPendingIds,
  parseJournal,
  parseLaunch,
  parseMeta,
  projectSlug,
  runFilesOf,
  slash,
  withDropped,
  withLiveness,
  withMetas,
  withRun,
} from './workflows'

const PANE = 'agentes'
const POLL_MS = 1_000
const POLL_FAILED = 'No se pudo sondear'

const agentsAtom = atom({ plugin: 'ultron-agentes', key: 'agents' } as const, [])
const runsAtom = atom({ plugin: 'ultron-agentes', key: 'runs' } as const, [])
const activityAtom = atom({ plugin: 'ultron-agentes', key: 'activity' } as const, {})
const selectedAtom = atom({ plugin: 'ultron-agentes', key: 'selected' } as const, null)
const noticeAtom = atom({ plugin: 'ultron-agentes', key: 'notice' } as const, '')
const nowAtom = atom({ plugin: 'ultron-agentes', key: 'now' } as const, 0)
const fullscreenAtom = atom({ plugin: 'ultron-agentes', key: 'isFullscreen' } as const, false)
const dismissedAtom = atom({ plugin: 'ultron-agentes', key: 'isDismissed' } as const, false)

const set = <T,>(value: T) => () => value

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

async function openPane($: EngineInterface, isAsked: boolean): Promise<string | null> {
  const opened = await $.ui.open(
    isAsked
      ? { id: PANE, title: 'Agentes', focus: true, closeOnEscape: true, rows: 16 }
      : { id: PANE, title: 'Agentes', closeOnEscape: true, rows: 16 },
  )
  return opened.isPlaced ? null : `No se pudo abrir el panel: ${opened.reason}`
}

/**
 * Al arrancar la sesión y al lanzarse un subagente o un workflow el panel se
 * abre solo, en pantalla completa (acoplado a la derecha) y sin foco, salvo que
 * la persona lo haya cerrado en esta sesión.
 */
async function autoOpen($: EngineInterface): Promise<void> {
  // Dentro de ULTRON Sessions la ventana tiene su propia interfaz: sin panel automático.
  if (await $.env.get('ULTRON_SESION_ID')) return
  if (!(await read($, fullscreenAtom)) || (await read($, dismissedAtom))) return
  const problem = await openPane($, false)
  if (problem !== null) await update($, noticeAtom, set(problem))
}

/** Carpeta de configuración de Claude Code, sin rutas personales escritas a mano. */
async function configDir($: EngineInterface): Promise<string> {
  const custom = await $.env.get('CLAUDE_CONFIG_DIR')
  if (custom !== undefined && custom !== '') return slash(custom)
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (home === undefined || home === '') throw new Error('sin USERPROFILE ni HOME para encontrar ~/.claude')
  return `${slash(home)}/.claude`
}

/** Carpeta del run cuando el tool no la dio: ~/.claude/projects/<slug>/<sesión>/subagents/workflows/<runId>. */
async function deriveRunDir($: EngineInterface, runId: string): Promise<string> {
  const projects = `${await configDir($)}/projects`
  const sessionId = await $.session.id()
  const tail = `${sessionId}/subagents/workflows/${runId}`
  const guess = `${projects}/${projectSlug(await $.session.cwd())}`
  if (await $.fs.exists(`${guess}/${sessionId}`)) return `${guess}/${tail}`
  const entries = await $.fs.list(projects)
  for (const entry of entries.filter((x) => x.kind === 'dir')) {
    if (await $.fs.exists(`${projects}/${entry.name}/${sessionId}`)) return `${projects}/${entry.name}/${tail}`
  }
  throw new Error(`no aparece la sesión ${sessionId} en ${projects}`)
}

async function startRun($: EngineInterface, launch: Launch): Promise<void> {
  const now = await $.clock.now()
  const base: WorkflowRun = {
    runId: launch.runId || `sin-id-${now}`,
    name: launch.name,
    taskId: launch.taskId,
    dir: '',
    startedAt: now,
    lastChangeAt: now,
    checkedAt: now,
    endedAt: null,
    journalStamp: '',
    badLines: 0,
    error: null,
    dropped: [],
  }
  const run = await resolveRun($, launch, base, now)
  await update($, runsAtom, (runs) => [run, ...runs.filter((r) => r.runId !== run.runId)])
  await update($, nowAtom, set(now))
  $.clock.after(0, () => void guarded($, 'No se pudo abrir el panel', () => autoOpen($)))
}

async function resolveRun($: EngineInterface, launch: Launch, base: WorkflowRun, now: number): Promise<WorkflowRun> {
  if (launch.dir !== null) return { ...base, dir: slash(launch.dir) }
  if (launch.runId === '') return { ...base, endedAt: now, error: 'El tool Workflow no devolvió runId: no se puede seguir este run.' }
  try {
    return { ...base, dir: await deriveRunDir($, launch.runId) }
  } catch (err) {
    return { ...base, endedAt: now, error: `No se encontró la carpeta del run: ${message(err)}` }
  }
}

/** Lee las metas pedidas; la que aún no aparece en la carpeta ni se intenta abrir. */
async function readMetas(
  $: EngineInterface,
  dir: string,
  ids: readonly string[],
  present: ReadonlySet<string>,
): Promise<Record<string, MetaRead>> {
  const pairs = await Promise.all(
    ids.map(async (id): Promise<[string, MetaRead]> => {
      if (!present.has(id)) return [id, 'missing']
      try {
        return [id, parseMeta(await $.fs.read(`${dir}/agent-${id}.meta.json`)) ?? 'bad']
      } catch {
        // A medio escribir o sin permiso: la fila lo enseña como «(meta ilegible)» y se reintenta.
        return [id, 'bad']
      }
    }),
  )
  return Object.fromEntries(pairs)
}

/** Cambia la lista de agentes y apunta en su run los de workflow que salieron de ella. */
async function setAgents($: EngineInterface, change: (list: AgentRow[]) => AgentRow[]): Promise<AgentRow[]> {
  let before: readonly AgentRow[] = []
  const after = await update($, agentsAtom, (list) => {
    before = list
    return change(list)
  })
  const gone = droppedByRun(before, after)
  if (gone.size > 0) await update($, runsAtom, (runs) => withDropped(runs, gone))
  return after
}

type JournalRead = { patch: Partial<WorkflowRun> }

/** Relee el journal (solo cuando creció) y funde sus agentes con la lista. */
async function readJournal($: EngineInterface, run: WorkflowRun, files: RunFiles, now: number): Promise<JournalRead> {
  let text: string
  try {
    text = await $.fs.read(`${run.dir}/journal.jsonl`)
  } catch (err) {
    return { patch: { error: `No se pudo leer el journal: ${message(err)}` } }
  }
  const { events, badLines } = parseJournal(text)
  const agents = foldJournal(events)
  const dropped = (await read($, runsAtom)).find((r) => r.runId === run.runId)?.dropped ?? run.dropped
  const fresh = freshAgentIds(agents, await read($, agentsAtom), dropped)
  const metas = await readMetas($, run.dir, fresh, files.metas)
  await setAgents($, (list) => mergeJournal(list, run.runId, agents, metas, dropped, now))
  return { patch: { badLines, error: null, journalStamp: files.journalStamp ?? '', lastChangeAt: now } }
}

/** Vuelve a pedir la meta de los agentes que aún no la tienen, con tope de intentos. */
async function retryMetas($: EngineInterface, run: WorkflowRun, files: RunFiles): Promise<void> {
  const ids = metaPendingIds(await read($, agentsAtom), run.runId)
  if (ids.length === 0) return
  const metas = await readMetas($, run.dir, ids, files.metas)
  await update($, agentsAtom, (list) => withMetas(list, run.runId, metas))
}

async function markRunError($: EngineInterface, run: WorkflowRun, now: number, error: string): Promise<void> {
  const isOver = now - run.lastChangeAt >= RUN_QUIET_MS
  const patch = { error, checkedAt: now, endedAt: run.endedAt ?? (isOver ? now : null) }
  await update($, runsAtom, (runs) => withRun(runs, run.runId, patch))
}

/**
 * Un sondeo de un run: lista su carpeta (tamaño y fecha de cada fichero), relee
 * el journal solo si cambió, marca sin señales a quien no escribe en su
 * transcript y cierra o reabre el run según lo que quede vivo.
 */
async function pollRun($: EngineInterface, run: WorkflowRun, now: number): Promise<void> {
  let files: RunFiles
  try {
    files = runFilesOf(await $.fs.list(run.dir))
  } catch (err) {
    await markRunError($, run, now, `No se pudo listar la carpeta del run: ${message(err)}`)
    return
  }
  const hasGrown = files.journalStamp !== null && files.journalStamp !== run.journalStamp
  const journal: JournalRead = hasGrown ? await readJournal($, run, files, now) : { patch: {} }
  await retryMetas($, run, files)
  const rows = await update($, agentsAtom, (list) => withLiveness(list, run.runId, files.transcripts, now))
  const noJournal = files.journalStamp === null ? { error: 'Todavía no hay journal.jsonl en la carpeta del run.' } : {}
  const patch: Partial<WorkflowRun> = { ...noJournal, ...journal.patch, checkedAt: now }
  const isOver = isRunOver({ ...run, ...patch }, rows, now)
  await update($, runsAtom, (runs) => withRun(runs, run.runId, { ...patch, endedAt: isOver ? (run.endedAt ?? now) : null }))
}

/** Refresca estados (el motor y las carpetas de los runs mandan) y el reloj. */
async function poll($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const rows = await read($, agentsAtom)
  const dueRuns = (await read($, runsAtom)).filter((r) => isRunDue(r, now))
  const hasLiveSub = rows.some((r) => r.source === 'subagent' && isActive(r))
  if (!hasLiveSub && dueRuns.length === 0) return
  if (hasLiveSub) {
    const statuses = await $.agent.list()
    await update($, agentsAtom, (list) => withStatuses(list, statuses, now))
  }
  for (const run of dueRuns) await pollRun($, run, now)
  await update($, nowAtom, set(now))
  await update($, noticeAtom, (notice) => (notice.startsWith(POLL_FAILED) ? '' : notice))
  const selected = await read($, selectedAtom)
  if (selected !== null) await loadResult($, selected)
}

async function subagentResult($: EngineInterface, id: string): Promise<string> {
  const found = await $.session.messages({ agentId: id })
  if ('deny' in found) return `No se pudo leer su conversación: ${found.deny}`
  return lastAssistantOf(found) ?? '(sin texto final del asistente)'
}

async function workflowResult($: EngineInterface, row: AgentRow): Promise<string> {
  const run = (await read($, runsAtom)).find((r) => r.runId === row.runId)
  if (run === undefined || run.dir === '') return 'No se sabe dónde está el run de este agente.'
  try {
    const text = await $.fs.read(`${run.dir}/agent-${row.id}.jsonl`)
    return lastAssistantInTranscript(text) ?? '(el transcript no tiene texto final del asistente)'
  } catch (err) {
    return `No se pudo leer el transcript: ${message(err)}`
  }
}

/** Lee el extracto del resultado de un agente terminado, una vez. */
async function loadResult($: EngineInterface, id: string): Promise<void> {
  const row = (await read($, agentsAtom)).find((r) => r.id === id)
  if (row === undefined || isActive(row) || row.result !== null) return
  const result = row.source === 'subagent' ? await subagentResult($, id) : await workflowResult($, row)
  await update($, agentsAtom, (list) => withResult(list, id, result))
}

async function select($: EngineInterface, id: string | null): Promise<void> {
  await update($, selectedAtom, set<string | null>(id))
  await update($, noticeAtom, set(''))
  if (id !== null) await loadResult($, id)
}

/** Pide TaskStop al motor; un rechazo (sin tool, abortado) también se cuenta. */
async function stopNotice($: EngineInterface, id: string): Promise<string> {
  try {
    const ran = await $.tool.call({ tool: 'TaskStop', task_id: id })
    if (ran.deny !== undefined) return `No se pudo detener: ${ran.deny}`
    if (ran.isError === true) return `No se pudo detener: ${ran.text ?? 'error del tool TaskStop'}`
    return 'Detención pedida al motor.'
  } catch (err) {
    return `No se pudo detener: ${message(err)}`
  }
}

/** Detiene un subagente con el tool TaskStop del motor; el panel dice cómo fue. */
async function stop($: EngineInterface, id: string): Promise<void> {
  const notice = await stopNotice($, id)
  await update($, noticeAtom, set(notice))
}

/** Quita los terminados; los de workflow quedan apuntados en su run para que el journal no los devuelva. */
async function clear($: EngineInterface): Promise<void> {
  const rows = await setAgents($, withoutFinished)
  const runIds = new Set(rows.map((r) => r.runId))
  await update($, runsAtom, (runs) => runs.filter((r) => r.endedAt === null || runIds.has(r.runId)))
  await update($, activityAtom, (activity) => pruneActivity(activity, rows))
  await update($, noticeAtom, set(''))
}

/** Ejecuta una acción lanzada sin esperar; si falla, el panel lo dice en vez de perder el rechazo. */
async function guarded($: EngineInterface, what: string, task: () => Promise<void>): Promise<void> {
  try {
    await task()
  } catch (err) {
    await update($, noticeAtom, set(`${what}: ${message(err)}`))
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agentes',
      description: 'Subagentes y agentes de workflows de esta sesión: quién trabaja, en qué y desde cuándo',
      immediate: true,
    })
    $.clock.every(POLL_MS, () => void guarded($, POLL_FAILED, () => poll($)))
    return next(e)
  })

  on('command.run', { command: 'agentes' }, async ($) => {
    await update($, nowAtom, set(await $.clock.now()))
    const problem = await openPane($, true)
    return problem ? { text: problem } : {}
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined || result.agentId === undefined) return result
    const now = await $.clock.now()
    const row = subagentRow({ id: result.agentId, type: e.subagentType, description: e.description, model: result.model }, e.parentAgentId ?? null, now)
    await setAgents($, (list) => withSpawn(list, row))
    await update($, nowAtom, set(now))
    $.clock.after(0, () => void guarded($, 'No se pudo abrir el panel', () => autoOpen($)))
    return result
  })

  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const launch = parseLaunch(ran.result as unknown)
    if (launch !== null) await startRun($, launch)
    return ran
  })

  // Lo que hace cada agente se apunta al empezar la llamada: es «lo que está haciendo ahora».
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId !== undefined) {
      const label = describeTool(String(e.tool), e as unknown as Record<string, unknown>)
      await update($, activityAtom, (activity) => withTool(activity, agentId, label))
    }
    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await update($, dismissedAtom, set(true))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.viewport?.isFullscreen === true && !(await read($, fullscreenAtom))) {
      // La primera vez que se ve la pantalla completa el panel se abre también sin agentes.
      $.clock.after(0, () => void guarded($, 'No se pudo apuntar la pantalla completa', async () => {
        await update($, fullscreenAtom, set(true))
        await autoOpen($)
      }))
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface === 'mobile') return next(e)
    const ui = $.ui.resolve(e)
    const agents = await read($, agentsAtom)
    const selected = await read($, selectedAtom)
    const vm = {
      agents,
      runs: await read($, runsAtom),
      activity: await read($, activityAtom),
      notice: await read($, noticeAtom),
      now: await read($, nowAtom),
      width: e.props.bodyColumns,
    }
    const back = () => void guarded($, 'No se pudo volver a la lista', () => select($, null))
    if (selected !== null) {
      return detailView(ui, vm, selected, { back, stop: (id) => void guarded($, 'No se pudo detener', () => stop($, id)) })
    }
    return agentsView(ui, vm, {
      clear: () => void guarded($, 'No se pudo limpiar', () => clear($)),
      select: (id) => void guarded($, 'No se pudo abrir el detalle', () => select($, id)),
    })
  })
}
