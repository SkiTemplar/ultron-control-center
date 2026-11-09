/**
 * Tipos y validación del protocolo del puente v2 (contrato de estabilidad
 * 2026-10-08, §6). Módulo puro: sin `$`, testeable por separado.
 */

export const PROTOCOL = 2
export const MOD_VERSION = '2.0.0'

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto' | 'dontAsk'

export const PERMISSION_MODES: ReadonlySet<string> = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto', 'dontAsk'])

export const isPermissionMode = (value: unknown): value is PermissionMode =>
  typeof value === 'string' && PERMISSION_MODES.has(value)

export type TurnUsage = {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  [k: string]: unknown
}

export type CommandItem = { name: string; description: string; source: 'builtin' | 'plugin' | 'user' | 'mcp'; plugin?: string }

export type HelloSource = 'start' | 'clear' | 'resume' | 'compact' | 'fork' | 'turn'

export type PuenteEvent =
  | { type: 'ready' }
  | { type: 'turnStart'; turnId: string; agentId?: string; text?: string }
  | { type: 'text' | 'thinking'; turnId: string; agentId?: string; step: number; block: number; delta: string }
  | { type: 'stepEnd'; turnId: string; agentId?: string; step: number; stopReason: string | null; usage: TurnUsage | null }
  | {
      type: 'turnEnd'
      turnId: string
      agentId?: string
      reason: 'answer' | 'aborted' | 'refusal' | 'error'
      isAborted: boolean
      durationMs: number
      usage?: TurnUsage
      /** Solo en el de un subagente: el modelo de sus pasos, para valorar su uso. */
      model?: string
    }
  | {
      type: 'tool'
      toolUseId: string
      agentId?: string
      name: string
      summary: string
      phase: 'start' | 'end'
      isError?: boolean
      timeoutMs?: number
    }
  | { type: 'agentSpawn'; agentId: string; parentAgentId?: string; agentType: string; description: string }
  | { type: 'agentEnd'; agentId: string; isError: boolean }
  | { type: 'status'; model: string; contextTokens: number; contextWindow: number; costUsd?: number; mode?: string }
  | { type: 'prompt'; turnId?: string; text: string; origin: string; wait: boolean }
  | { type: 'commandStart'; runId: string; command: string; args: string; origin: string }
  | { type: 'commandEnd'; runId: string; command: string; text?: string; intercepted: boolean }
  | { type: 'mode'; mode: PermissionMode }
  | { type: 'commands'; items: CommandItem[] }
  | { type: 'composerFill'; text: string; mode: 'replace' | 'append' | 'insert'; from: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }

export type EventType = PuenteEvent['type']

export type AskQuestion = {
  question: string
  header: string
  multiSelect: boolean
  options: { label: string; description: string }[]
}

/** `Ask` del contrato sin `askId` ni `id`: lo que el mod envía a `POST /v1/ask`. */
export type AskRequest =
  | { kind: 'permission'; tool: string; input: unknown; summary: string; reason?: string; agentId: string | null }
  | { kind: 'question'; questions: AskQuestion[] }
  | { kind: 'plan'; plan: string }

/** Respuesta de la ventana (§4.5). `approve` del protocolo 1 se traduce a `decision`. */
export type AskAnswer =
  | { kind: 'permission'; decision: 'allow' | 'allowAlways' | 'deny'; reason?: string }
  | { kind: 'question'; answers: Record<string, string>; rejected?: false }
  | { kind: 'question'; rejected: true }
  | { kind: 'plan'; decision: 'approve' | 'keepPlanning'; mode?: PermissionMode; feedback?: string }

export type AskKind = AskRequest['kind']

/** Estado de un ask en `POST /v1/ask/wait`. */
export type WaitResult =
  | { askId: string; status: 'pending' }
  | { askId: string; status: 'answered'; answer: unknown }
  | { askId: string; status: 'cancelled'; reason: string }

/**
 * Operación del buzón. `expiresAt` (ms desde la época UNIX) es su caducidad
 * absoluta: pasada, el mod no la ejecuta. Un backend antiguo no la manda.
 */
export type InboxOp = InboxOpBody & { expiresAt?: number }

type InboxOpBody =
  | { opId: string; op: 'command.run'; command: string; args: string }
  | { opId: string; op: 'command.list' }
  | { opId: string; op: 'config.list' }
  | { opId: string; op: 'config.set'; key: string; value: string | number | boolean }
  | { opId: string; op: 'turn.abort'; turnId: string }
  | { opId: string; op: 'session.usage'; breakdown?: 'summary' }
  | { opId: string; op: 'setIntercept'; on: boolean }
  | { opId: string; op: 'prompt.read' }
  | { opId: string; op: 'prompt.clear' }

export type { OpOutcome } from '../types'

export type PuenteConfig = { url: string; token: string; sesionId: string }

export type HelloPayload = {
  claudeSessionId: string
  cwd: string
  model: string
  transcriptPath?: string
  source: HelloSource
}

export type HelloResponse = { protocol: number; generation: number; launchPermissionMode: PermissionMode | null }

/**
 * URL del puente local: http(s) a `127.0.0.1` o `localhost`, con puerto
 * opcional y ruta. Cualquier otro host (o credenciales delante del host)
 * queda fuera: el token, el stream y las respuestas a permisos no salen de la
 * máquina aunque la variable llegue sobrescrita.
 */
const LOCAL_URL = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::(\d{1,5}))?(?:\/\S*)?$/i

const MAX_PORT = 65535

function isLocalUrl(url: string): boolean {
  const match = LOCAL_URL.exec(url)
  if (match === null) return false
  return match[1] === undefined || Number(match[1]) <= MAX_PORT
}

/**
 * Configuración a partir de `ULTRON_PUENTE_URL`, `ULTRON_PUENTE_TOKEN` y
 * `ULTRON_SESION_ID`. Devuelve null si falta alguna o la URL no es la del
 * puente local (`isLocalUrl`): el mod queda inactivo.
 */
export function parseConfig(url?: string, token?: string, sesionId?: string): PuenteConfig | null {
  const cleanUrl = url?.trim() ?? ''
  const cleanToken = token?.trim() ?? ''
  const cleanId = sesionId?.trim() ?? ''
  if (cleanUrl === '' || cleanToken === '' || cleanId === '') return null
  if (!isLocalUrl(cleanUrl)) return null
  return { url: cleanUrl.replace(/\/+$/, ''), token: cleanToken, sesionId: cleanId }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

/**
 * Respuesta de `POST /v1/hello`. Sin `protocol` numérico es un backend del
 * protocolo 1 (sin buzón ni ask asíncrono); sin `generation`, 0.
 */
export function parseHelloResponse(body: string): HelloResponse {
  const parsed = parseJson(body)
  if (!isRecord(parsed)) return { protocol: 1, generation: 0, launchPermissionMode: null }
  const protocol = typeof parsed.protocol === 'number' && Number.isInteger(parsed.protocol) ? parsed.protocol : 1
  const generation = typeof parsed.generation === 'number' && Number.isInteger(parsed.generation) ? parsed.generation : 0
  const mode = isPermissionMode(parsed.launchPermissionMode) ? parsed.launchPermissionMode : null
  return { protocol, generation, launchPermissionMode: mode }
}

/**
 * Generación vigente si `POST /v1/events` rechazó el lote por ser de una
 * generación anterior (`{ stale, generation }`); null si lo aceptó.
 */
export function parseEventsStale(body: string): number | null {
  const parsed = parseJson(body)
  if (!isRecord(parsed) || parsed.stale !== true) return null
  return typeof parsed.generation === 'number' && Number.isInteger(parsed.generation) ? parsed.generation : null
}

/**
 * true si `POST /v1/hello` respondió que un anuncio posterior del mismo
 * proceso ya lo sustituyó (`{ superseded: true }`): no se aplica ni rechaza.
 */
export function parseHelloSuperseded(body: string): boolean {
  const parsed = parseJson(body)
  return isRecord(parsed) && parsed.superseded === true
}

/** `askId` de la respuesta de `POST /v1/ask` asíncrono; null si no viene. */
export function parseAskId(body: string): string | null {
  const parsed = parseJson(body)
  return isRecord(parsed) && typeof parsed.askId === 'string' && parsed.askId !== '' ? parsed.askId : null
}

export type Polled<T> = { stale: true } | { stale: false; items: T[] } | null

function parseWaitItem(item: unknown): WaitResult | null {
  if (!isRecord(item) || typeof item.askId !== 'string') return null
  if (item.status === 'pending') return { askId: item.askId, status: 'pending' }
  if (item.status === 'answered') return { askId: item.askId, status: 'answered', answer: item.answer }
  if (item.status === 'cancelled') {
    return { askId: item.askId, status: 'cancelled', reason: typeof item.reason === 'string' ? item.reason : 'unknown' }
  }
  return null
}

/** Respuesta de `POST /v1/ask/wait` (multiplexado); null si no se entiende. */
export function parseWaitResponse(body: string): Polled<WaitResult> {
  const parsed = parseJson(body)
  if (!isRecord(parsed)) return null
  if (parsed.stale === true) return { stale: true }
  if (!Array.isArray(parsed.results)) return null
  const items = parsed.results.map(parseWaitItem).filter((item): item is WaitResult => item !== null)
  return { stale: false, items }
}

const CONFIG_VALUE_TYPES = new Set(['string', 'number', 'boolean'])

function parseOp(raw: unknown): InboxOp | null {
  const op = parseOpBody(raw)
  if (op === null || !isRecord(raw)) return null
  const expiresAt = raw.expiresAt
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? { ...op, expiresAt } : op
}

function parseOpBody(raw: unknown): InboxOpBody | null {
  if (!isRecord(raw) || typeof raw.opId !== 'string' || raw.opId === '') return null
  const opId = raw.opId
  switch (raw.op) {
    case 'command.run':
      if (typeof raw.command !== 'string' || raw.command.trim() === '') return null
      return { opId, op: 'command.run', command: raw.command.replace(/^\//, ''), args: typeof raw.args === 'string' ? raw.args : '' }
    case 'config.set':
      if (typeof raw.key !== 'string' || !CONFIG_VALUE_TYPES.has(typeof raw.value)) return null
      return { opId, op: 'config.set', key: raw.key, value: raw.value as string | number | boolean }
    case 'turn.abort':
      return typeof raw.turnId === 'string' ? { opId, op: 'turn.abort', turnId: raw.turnId } : null
    case 'session.usage':
      return raw.breakdown === 'summary' ? { opId, op: 'session.usage', breakdown: 'summary' } : { opId, op: 'session.usage' }
    case 'setIntercept':
      return typeof raw.on === 'boolean' ? { opId, op: 'setIntercept', on: raw.on } : null
    case 'command.list':
    case 'config.list':
    case 'prompt.read':
    case 'prompt.clear':
      return { opId, op: raw.op }
    default:
      return null
  }
}

/**
 * Respuesta de `POST /v1/inbox`. Una operación desconocida o mal formada se
 * omite (tolerancia del §6.1); `skipped` cuenta las omitidas.
 */
export function parseInboxResponse(body: string): (Polled<InboxOp> & { skipped?: number }) | null {
  const parsed = parseJson(body)
  if (!isRecord(parsed)) return null
  if (parsed.stale === true) return { stale: true }
  if (!Array.isArray(parsed.ops)) return null
  const items = parsed.ops.map(parseOp)
  const ops = items.filter((op): op is InboxOp => op !== null)
  return { stale: false, items: ops, skipped: items.length - ops.length }
}

const PERMISSION_DECISIONS = new Set(['allow', 'allowAlways', 'deny'])

function parsePermission(answer: Record<string, unknown>): AskAnswer | null {
  if (typeof answer.decision !== 'string' || !PERMISSION_DECISIONS.has(answer.decision)) return null
  const decision = answer.decision as 'allow' | 'allowAlways' | 'deny'
  return typeof answer.reason === 'string'
    ? { kind: 'permission', decision, reason: answer.reason }
    : { kind: 'permission', decision }
}

function parseQuestion(answer: Record<string, unknown>): AskAnswer | null {
  if (answer.rejected === true) return { kind: 'question', rejected: true }
  if (!isRecord(answer.answers)) return null
  const entries = Object.entries(answer.answers)
  if (!entries.every(([, value]) => typeof value === 'string')) return null
  return { kind: 'question', answers: Object.fromEntries(entries) as Record<string, string> }
}

/** Respuesta de plan; acepta la forma del protocolo 1 (`approve: boolean`). */
export function parsePlanAnswer(answer: Record<string, unknown>): AskAnswer | null {
  let decision: 'approve' | 'keepPlanning'
  if (answer.decision === 'approve' || answer.decision === 'keepPlanning') decision = answer.decision
  else if (typeof answer.approve === 'boolean') decision = answer.approve ? 'approve' : 'keepPlanning'
  else return null
  return {
    kind: 'plan',
    decision,
    ...(isPermissionMode(answer.mode) ? { mode: answer.mode } : {}),
    ...(typeof answer.feedback === 'string' ? { feedback: answer.feedback } : {}),
  }
}

/** Interpreta una respuesta de la ventana del tipo pedido; null si no encaja. */
export function toAnswer(answer: unknown, expected: AskKind): AskAnswer | null {
  if (!isRecord(answer) || answer.kind !== expected) return null
  if (expected === 'permission') return parsePermission(answer)
  if (expected === 'question') return parseQuestion(answer)
  return parsePlanAnswer(answer)
}

/** Cuerpo de `POST /v1/ask` bloqueante (protocolo 1): `{ answer }`. */
export function parseAnswer(body: string, expected: AskKind): AskAnswer | null {
  const parsed = parseJson(body)
  return isRecord(parsed) ? toAnswer(parsed.answer, expected) : null
}
