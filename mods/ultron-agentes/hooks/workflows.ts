import type { AgentRow, WorkflowRun } from '../types'
import { capRows, isActive } from './agents'

/** Una línea del journal.jsonl de un run, ya validada. */
export type JournalEvent = {
  type: string
  key: string
  agentId: string | null
  label: string
  phase: string
  result?: unknown
  error: string
}

/** Lo que el journal dice de un agente del run. */
export type JournalAgent = {
  agentId: string
  label: string
  phase: string
  status: string
  result: string | null
}

/** Lo que se lee de agent-<id>.meta.json. */
export type AgentMeta = {
  agentType: string
  description: string
  phase: string
  model: string
}

/** Lo útil de la salida del tool Workflow. */
export type Launch = {
  runId: string
  name: string
  taskId: string
  dir: string | null
}

/** La meta leída, o por qué no: aún no está en la carpeta o no se pudo leer. */
export type MetaRead = AgentMeta | 'missing' | 'bad'

/** Lo que dice el listado de la carpeta del run, sin abrir ningún fichero. */
export type RunFiles = {
  /** `tamaño:mtime` de journal.jsonl; null si todavía no existe. */
  journalStamp: string | null
  /** Última escritura de cada agent-<id>.jsonl. */
  transcripts: Readonly<Record<string, number>>
  /** Ids con agent-<id>.meta.json ya escrito. */
  metas: ReadonlySet<string>
}

/** Lo mínimo de una entrada de `$.fs.list`. */
export type DirEntry = { name: string; kind: string; size: number; mtimeMs: number }

export type PhaseGroup = { phase: string; rows: AgentRow[] }

export type RunSummary = { active: number; finished: number; phase: string }

/** Sin agentes vivos ni líneas nuevas durante este tiempo, el run se da por terminado. */
export const RUN_QUIET_MS = 30_000
/** Un agente en curso cuyo transcript no crece en este tiempo pasa a «sin señales». */
export const STALE_MS = 10 * 60_000
/** Cada cuánto se vuelve a mirar un run cerrado, por si se reanuda. */
export const RECHECK_MS = 5_000
/** Intentos de leer la meta de un agente antes de rendirse. */
export const META_TRIES = 30
const RESULT_MAX = 1_200
export const NO_PHASE = '(sin fase)'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const str = (record: Record<string, unknown>, key: string): string =>
  typeof record[key] === 'string' ? (record[key] as string) : ''

const tryJson = (line: string): unknown => {
  try {
    return JSON.parse(line) as unknown
  } catch {
    // Una línea a medio escribir o corrupta no es JSON: la cuenta `parseJournal`.
    return undefined
  }
}

/** Convierte un resultado (texto u objeto) en un extracto legible y acotado. */
export function excerptOf(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1) ?? String(value)
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > RESULT_MAX ? `${flat.slice(0, RESULT_MAX - 1)}…` : flat
}

/** Lee el journal línea a línea; las que no son un objeto JSON con `type` cuentan como ilegibles. */
export function parseJournal(text: string): { events: JournalEvent[]; lineCount: number; badLines: number } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  const parsed = lines.map(tryJson)
  const events = parsed.filter(isRecord).filter((o) => str(o, 'type') !== '').map(
    (o): JournalEvent => ({
      type: str(o, 'type'),
      key: str(o, 'key'),
      agentId: str(o, 'agentId') === '' ? null : str(o, 'agentId'),
      label: str(o, 'label'),
      phase: str(o, 'phase'),
      error: str(o, 'error') || str(o, 'reason'),
      ...('result' in o ? { result: o.result } : {}),
    }),
  )
  return { events, lineCount: lines.length, badLines: lines.length - events.length }
}

function applyEvent(agent: JournalAgent | undefined, ev: JournalEvent & { agentId: string }): JournalAgent {
  const base = agent ?? { agentId: ev.agentId, label: ev.label, phase: ev.phase, status: 'running', result: null }
  if (ev.type === 'started') return { ...base, label: ev.label || base.label, phase: ev.phase || base.phase, status: 'running' }
  if (ev.type === 'result') return { ...base, status: 'completed', result: excerptOf(ev.result ?? '') }
  if (ev.type === 'failed') return { ...base, status: 'failed', result: ev.error === '' ? base.result : ev.error }
  return { ...base, status: ev.type }
}

/** Estado de cada agente del run, en el orden en que el journal los nombra por primera vez. */
export function foldJournal(events: readonly JournalEvent[]): JournalAgent[] {
  const withAgent = events.filter((ev): ev is JournalEvent & { agentId: string } => ev.agentId !== null)
  const folded = withAgent.reduce<ReadonlyMap<string, JournalAgent>>(
    (acc, ev) => new Map([...acc, [ev.agentId, applyEvent(acc.get(ev.agentId), ev)]]),
    new Map(),
  )
  return [...folded.values()]
}

/** Lee agent-<id>.meta.json; null si no es un objeto JSON. */
export function parseMeta(text: string): AgentMeta | null {
  const o = tryJson(text)
  if (!isRecord(o)) return null
  return {
    agentType: str(o, 'agentType'),
    description: str(o, 'description'),
    phase: str(o, 'workflowPhase'),
    model: str(o, 'model'),
  }
}

/** Tipo que enseña la fila mientras no hay meta: distingue «aún no escrita» de «ilegible». */
export function typeWithoutMeta(meta: 'missing' | 'bad', tries: number): string {
  if (meta === 'bad') return '(meta ilegible)'
  return tries >= META_TRIES ? '(sin meta)' : '(meta aún no escrita)'
}

/** Rellena la fila con su meta, o deja dicho por qué no la tiene todavía. */
function withMeta(row: AgentRow, meta: MetaRead): AgentRow {
  const metaTries = row.metaTries + 1
  if (typeof meta === 'string') return { ...row, type: typeWithoutMeta(meta, metaTries), metaTries }
  return {
    ...row,
    type: meta.agentType || 'agente',
    description: row.description || meta.description,
    model: meta.model,
    phase: row.phase === NO_PHASE && meta.phase !== '' ? meta.phase : row.phase,
    hasMeta: true,
    metaTries,
  }
}

function newWorkflowRow(agent: JournalAgent, meta: MetaRead, runId: string, now: number): AgentRow {
  const isEnded = agent.status !== 'running'
  const bare: AgentRow = {
    id: agent.agentId,
    type: '',
    description: agent.label,
    model: '',
    status: agent.status,
    parentId: null,
    startedAt: now,
    endedAt: isEnded ? now : null,
    source: 'workflow',
    runId,
    phase: agent.phase || NO_PHASE,
    result: agent.result,
    hasMeta: false,
    metaTries: 0,
  }
  return withMeta(bare, meta)
}

function updatedRow(row: AgentRow, agent: JournalAgent, now: number): AgentRow {
  // «running» en el journal no desmiente «stale»: eso lo decide el transcript (withLiveness).
  const isSameStatus = row.status === agent.status || (row.status === 'stale' && agent.status === 'running')
  if (isSameStatus && (agent.result === null || row.result === agent.result)) return row
  const isEnded = agent.status !== 'running'
  return { ...row, status: agent.status, endedAt: isEnded ? (row.endedAt ?? now) : null, result: agent.result ?? row.result }
}

/**
 * Funde lo que dice el journal con las filas: actualiza las conocidas y añade
 * al final las nuevas que no se descartaron antes (limpiadas o recortadas).
 */
export function mergeJournal(
  rows: readonly AgentRow[],
  runId: string,
  agents: readonly JournalAgent[],
  metas: Readonly<Record<string, MetaRead>>,
  dropped: readonly string[],
  now: number,
): AgentRow[] {
  const byId = new Map(agents.map((a) => [a.agentId, a]))
  const skip = new Set([...rows.map((r) => r.id), ...dropped])
  const updated = rows.map((r) => {
    const agent = r.runId === runId ? byId.get(r.id) : undefined
    return agent === undefined ? r : updatedRow(r, agent, now)
  })
  const added = agents.filter((a) => !skip.has(a.agentId)).map((a) => newWorkflowRow(a, metas[a.agentId] ?? 'missing', runId, now))
  return capRows([...updated, ...added])
}

/** Agentes nuevos del journal: ni en la lista ni descartados. */
export const freshAgentIds = (agents: readonly JournalAgent[], rows: readonly AgentRow[], dropped: readonly string[]): string[] => {
  const skip = new Set([...rows.map((r) => r.id), ...dropped])
  return agents.map((a) => a.agentId).filter((id) => !skip.has(id))
}

/** Filas del run a las que aún les falta la meta y les quedan intentos. */
export const metaPendingIds = (rows: readonly AgentRow[], runId: string): string[] =>
  rows.filter((r) => r.runId === runId && !r.hasMeta && r.metaTries < META_TRIES).map((r) => r.id)

/** Aplica un nuevo intento de meta a las filas indicadas. */
export function withMetas(rows: readonly AgentRow[], runId: string, metas: Readonly<Record<string, MetaRead>>): AgentRow[] {
  return rows.map((r) => {
    const meta = r.runId === runId && !r.hasMeta ? metas[r.id] : undefined
    return meta === undefined ? r : withMeta(r, meta)
  })
}

/**
 * Señal de vida aparte del journal: un agente en curso cuyo transcript lleva
 * STALE_MS sin crecer pasa a `stale`; si vuelve a crecer, vuelve a `running`.
 */
export function withLiveness(rows: readonly AgentRow[], runId: string, transcripts: Readonly<Record<string, number>>, now: number): AgentRow[] {
  return rows.map((r) => {
    if (r.runId !== runId) return r
    const lastSign = Math.max(transcripts[r.id] ?? 0, r.startedAt)
    const isQuiet = now - lastSign >= STALE_MS
    if (r.status === 'running' && isQuiet) return { ...r, status: 'stale', endedAt: lastSign }
    if (r.status === 'stale' && !isQuiet) return { ...r, status: 'running', endedAt: null }
    return r
  })
}

const TRANSCRIPT = /^agent-(.+)\.jsonl$/
const META_FILE = /^agent-(.+)\.meta\.json$/

/** Resume el listado de la carpeta del run. */
export function runFilesOf(entries: readonly DirEntry[]): RunFiles {
  const files = entries.filter((e) => e.kind === 'file')
  const journal = files.find((e) => e.name === 'journal.jsonl')
  const transcripts = files.flatMap((e) => {
    const id = TRANSCRIPT.exec(e.name)?.[1]
    return id === undefined ? [] : [[id, e.mtimeMs] as const]
  })
  const metas = files.flatMap((e) => META_FILE.exec(e.name)?.[1] ?? [])
  return {
    journalStamp: journal === undefined ? null : `${journal.size}:${journal.mtimeMs}`,
    transcripts: Object.fromEntries(transcripts),
    metas: new Set(metas),
  }
}

/** Filas de workflow que estaban antes y ya no, agrupadas por run. */
export function droppedByRun(before: readonly AgentRow[], after: readonly AgentRow[]): ReadonlyMap<string, string[]> {
  const kept = new Set(after.map((r) => r.id))
  const gone = before.filter((r) => r.runId !== null && !kept.has(r.id))
  return gone.reduce<ReadonlyMap<string, string[]>>(
    (acc, r) => new Map([...acc, [r.runId as string, [...(acc.get(r.runId as string) ?? []), r.id]]]),
    new Map(),
  )
}

/** Apunta en cada run los agentes descartados, para que el journal no los resucite. */
export const withDropped = (runs: readonly WorkflowRun[], gone: ReadonlyMap<string, readonly string[]>): WorkflowRun[] =>
  runs.map((r) => {
    const ids = gone.get(r.runId)
    return ids === undefined ? r : { ...r, dropped: [...new Set([...r.dropped, ...ids])] }
  })

/** Agentes del run agrupados por fase, en el orden en que aparece cada fase. */
export function groupByPhase(rows: readonly AgentRow[]): PhaseGroup[] {
  const phases = [...new Set(rows.map((r) => r.phase || NO_PHASE))]
  return phases.map((phase) => ({ phase, rows: rows.filter((r) => (r.phase || NO_PHASE) === phase) }))
}

export function runSummary(rows: readonly AgentRow[], runId: string): RunSummary {
  const mine = rows.filter((r) => r.runId === runId)
  const active = mine.filter(isActive)
  const phase = (active.at(-1) ?? mine.at(-1))?.phase ?? ''
  return { active: active.length, finished: mine.length - active.length, phase }
}

/**
 * ¿Se da el run por terminado? Sin agentes vivos (los que llevan STALE_MS sin
 * señales no cuentan) y con el journal quieto un rato. No es definitivo: si el
 * journal o un transcript vuelven a crecer, el run se reabre.
 */
export function isRunOver(run: WorkflowRun, rows: readonly AgentRow[], now: number): boolean {
  const hasLive = rows.some((r) => r.runId === run.runId && isActive(r))
  return !hasLive && now - run.lastChangeAt >= RUN_QUIET_MS
}

/** ¿Toca mirar el run en este sondeo? Los vivos siempre; los cerrados cada RECHECK_MS. */
export function isRunDue(run: WorkflowRun, now: number): boolean {
  if (run.dir === '') return false
  return run.endedAt === null || now - run.checkedAt >= RECHECK_MS
}

export const withRun = (runs: readonly WorkflowRun[], runId: string, patch: Partial<WorkflowRun>): WorkflowRun[] =>
  runs.map((r) => (r.runId === runId ? { ...r, ...patch } : r))

/** Saca de la salida del tool Workflow lo necesario para seguir el run; null si no es un run local. */
export function parseLaunch(result: unknown): Launch | null {
  if (!isRecord(result) || result.status !== 'async_launched' || str(result, 'error') !== '') return null
  if (result.taskType !== undefined && result.taskType !== 'local_workflow') return null
  const runId = str(result, 'runId')
  return {
    runId,
    name: str(result, 'workflowName') || runId || 'workflow',
    taskId: str(result, 'taskId'),
    dir: str(result, 'transcriptDir') || null,
  }
}

/** Nombre de la carpeta del proyecto en ~/.claude/projects: `C:\\a\\.b` → `C--a--b`. */
export const projectSlug = (cwd: string): string => cwd.replace(/[:\\/.]/g, '-')

export const slash = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '')

/** Último texto del asistente en un agent-<id>.jsonl; null si no hay ninguno legible. */
export function lastAssistantInTranscript(text: string): string | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '').reverse()
  for (const line of lines) {
    const entry = tryJson(line)
    const found = isRecord(entry) ? assistantTextOf(entry) : null
    if (found !== null) return found
  }
  return null
}

function assistantTextOf(entry: Record<string, unknown>): string | null {
  const attachment = entry.attachment
  if (isRecord(attachment) && attachment.type === 'structured_output') return excerptOf(attachment.data)
  const message = entry.message
  if (!isRecord(message) || message.role !== 'assistant') return null
  const content = message.content
  if (typeof content === 'string') return content.trim() === '' ? null : excerptOf(content)
  if (!Array.isArray(content)) return null
  const text = content
    .filter(isRecord)
    .filter((b) => b.type === 'text')
    .map((b) => str(b, 'text'))
    .join('\n')
    .trim()
  return text === '' ? null : excerptOf(text)
}
