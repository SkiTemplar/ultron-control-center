import type { Activity, AgentRow } from '../types'

/** Lo mínimo de `$.agent.list()` que usa el panel. */
export type AgentStatus = { id: string; status: string }

export type ActivityMap = Readonly<Record<string, Activity>>

const ACTIVE = new Set(['running', 'pending'])
const MAX_ROWS = 120
const MAX_ACTIVITY = 200
const DETAIL_MAX = 60
export const HISTORY_MAX = 8

export const isActive = (row: AgentRow): boolean => ACTIVE.has(row.status)

export const trunc = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text

const baseName = (path: string): string => path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path

const firstLine = (text: string): string => text.split(/\r?\n/)[0]?.trim() ?? ''

const DETAIL_KEYS = ['file_path', 'notebook_path', 'command', 'pattern', 'url', 'query', 'subagent_type'] as const

/** Resume una llamada a herramienta en pocas palabras: «Read register.tsx», «Bash npm test». */
export function describeTool(tool: string, input: Readonly<Record<string, unknown>>): string {
  const key = DETAIL_KEYS.find((k) => typeof input[k] === 'string' && input[k] !== '')
  const raw = key === undefined ? '' : (input[key] as string)
  const detail = key === 'file_path' || key === 'notebook_path' ? baseName(raw) : key === 'command' ? firstLine(raw) : raw
  const name = tool.startsWith('mcp__') ? tool.split('__').slice(1).join('·') : tool
  return detail === '' ? name : `${name} ${trunc(detail, DETAIL_MAX)}`
}

const recency = (row: AgentRow): number => row.endedAt ?? row.startedAt

/**
 * Quita los terminados más antiguos (por cuándo terminaron, no por su posición
 * en la lista) cuando hay demasiadas filas; los activos no se tocan.
 */
export function capRows(rows: readonly AgentRow[]): AgentRow[] {
  if (rows.length <= MAX_ROWS) return [...rows]
  const room = Math.max(0, MAX_ROWS - rows.filter(isActive).length)
  const newestFirst = rows.filter((r) => !isActive(r)).sort((a, b) => recency(b) - recency(a))
  const keptFinished = new Set(newestFirst.slice(0, room).map((r) => r.id))
  return rows.filter((r) => isActive(r) || keptFinished.has(r.id))
}

/** Fila de un subagente recién lanzado por el tool Agent. */
export function subagentRow(
  spawn: { id: string; type: string; description: string; model: string },
  parentId: string | null,
  now: number,
): AgentRow {
  return {
    ...spawn,
    status: 'running',
    parentId,
    startedAt: now,
    endedAt: null,
    source: 'subagent',
    runId: null,
    phase: '',
    result: null,
    hasMeta: true,
    metaTries: 0,
  }
}

export function withSpawn(rows: readonly AgentRow[], row: AgentRow): AgentRow[] {
  return capRows([row, ...rows.filter((r) => r.id !== row.id)])
}

/** Apunta una herramienta en la actividad del agente, con un historial corto. */
export function withTool(activity: ActivityMap, agentId: string, label: string): Record<string, Activity> {
  const prev = activity[agentId] ?? { tools: 0, history: [] }
  const next: Activity = { tools: prev.tools + 1, history: [...prev.history, label].slice(-HISTORY_MAX) }
  const ids = Object.keys(activity)
  const isNew = activity[agentId] === undefined
  const dropped = isNew && ids.length >= MAX_ACTIVITY ? new Set(ids.slice(0, ids.length - MAX_ACTIVITY + 1)) : new Set<string>()
  const kept = Object.fromEntries(Object.entries(activity).filter(([id]) => !dropped.has(id)))
  return { ...kept, [agentId]: next }
}

export const activityOf = (activity: ActivityMap, agentId: string): Activity =>
  activity[agentId] ?? { tools: 0, history: [] }

export const lastTool = (activity: ActivityMap, agentId: string): string => activityOf(activity, agentId).history.at(-1) ?? ''

/** Aplica los estados que da el motor; el que deja de estar activo queda cerrado en `now`. */
export function withStatuses(rows: readonly AgentRow[], statuses: readonly AgentStatus[], now: number): AgentRow[] {
  const byId = new Map(statuses.map((s) => [s.id, s.status]))
  return rows.map((r) => {
    const status = byId.get(r.id)
    if (r.source !== 'subagent' || status === undefined || status === r.status) return r
    const isEnded = !ACTIVE.has(status)
    return { ...r, status, endedAt: isEnded ? (r.endedAt ?? now) : null }
  })
}

export const withResult = (rows: readonly AgentRow[], id: string, result: string): AgentRow[] =>
  rows.map((r) => (r.id === id ? { ...r, result } : r))

export const withoutFinished = (rows: readonly AgentRow[]): AgentRow[] => rows.filter(isActive)

/** Deja solo la actividad de los agentes que siguen en la lista. */
export function pruneActivity(activity: ActivityMap, rows: readonly AgentRow[]): Record<string, Activity> {
  const ids = new Set(rows.map((r) => r.id))
  return Object.fromEntries(Object.entries(activity).filter(([id]) => ids.has(id)))
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1_000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** Nombre corto del modelo: `claude-opus-5-5[1m]` → `opus 5.5`. */
export function shortModel(model: string): string {
  const match = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i.exec(model)
  if (!match) return model
  return `${match[1]!.toLowerCase()} ${match[2]}${match[3] ? `.${match[3]}` : ''}`
}

/** Orden de pintado: activos primero; dentro, cada hijo justo debajo de su padre. */
export function ordered(rows: readonly AgentRow[]): Array<{ row: AgentRow; depth: number }> {
  const ids = new Set(rows.map((r) => r.id))
  const roots = rows.filter((r) => r.parentId === null || !ids.has(r.parentId))
  const sorted = [...roots.filter(isActive), ...roots.filter((r) => !isActive(r))]
  const visit = (row: AgentRow, depth: number): Array<{ row: AgentRow; depth: number }> => [
    { row, depth },
    ...rows.filter((r) => r.parentId === row.id).flatMap((child) => visit(child, depth + 1)),
  ]
  return sorted.flatMap((root) => visit(root, 0))
}

/** Último texto del asistente en las filas de `$.session.messages({ agentId })`. */
export function lastAssistantOf(messages: ReadonlyArray<{ role: string; text: string }>): string | null {
  const found = [...messages].reverse().find((m) => m.role === 'assistant' && m.text.trim() !== '')
  return found === undefined ? null : found.text.trim()
}
