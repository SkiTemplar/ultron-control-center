/**
 * Preguntas, permisos y planes contra la ventana (§4.2, §4.4).
 *
 * Protocolo 2: `POST /v1/ask {async:true}` devuelve `askId` al momento y la
 * respuesta llega por un sondeo `POST /v1/ask/wait` multiplexado: lleva todos
 * los `askId` pendientes de la sesión y reparte cada resultado a su hook.
 *
 * Presupuesto del hook (`HookBudget`): solo se para mientras el propio hook
 * tiene una llamada `$` en vuelo. Por eso el sondeo lo hace siempre uno de los
 * hooks que esperan, con su `$`; otro hook que espera se apoya en ese sondeo y
 * solo lanza el suyo si su presupuesto baja de `TAKEOVER_MS` (si no, su
 * `.catch` contestaría `deny` aunque la persona siguiera decidiendo).
 * Ningún reintento usa `$.clock.sleep`.
 */
import type { Bridge, Host } from './bridge'
import type { AskAnswer, AskKind, AskRequest } from './protocol'
import { parseAnswer, parseAskId, parseWaitResponse, toAnswer } from './protocol'

/** Por debajo de este presupuesto no se reintenta: se contesta `deny`. */
export const LOW_BUDGET_MS = 2_000
/** Margen con el que un hook que espera lanza su propio sondeo. */
export const TAKEOVER_MS = 4_000
/** `POST /v1/ask` seguidos que pueden fallar antes de rendirse. */
export const MAX_ASK_FAILURES = 2
/** Sondeos `wait` seguidos que pueden fallar antes de rendirse. */
export const MAX_WAIT_FAILURES = 3

export type AskOutcome =
  | { kind: 'answered'; answer: AskAnswer }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'failed'; why: 'unreachable' | 'budget' | 'invalid' }
  | { kind: 'aborted' }

/** Lo que un hook aporta a su pregunta: su red, su señal y su presupuesto. */
export type AskContext = { host: Host; signal: AbortSignal; remainingMs: () => number }

type Waiter = { kind: AskKind; outcome: AskOutcome | null }

type Deferred = { promise: Promise<void>; resolve: () => void }

function deferred(): Deferred {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function onAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
}

const FAILED_UNREACHABLE: AskOutcome = { kind: 'failed', why: 'unreachable' }
const FAILED_BUDGET: AskOutcome = { kind: 'failed', why: 'budget' }

export type Asker = ReturnType<typeof createAsker>

export function createAsker(bridge: Bridge, sesionId: string) {
  const waiting = new Map<string, Waiter>()
  let polls = 0
  let tick = deferred()

  function notify(): void {
    tick.resolve()
    tick = deferred()
  }

  function settle(askId: string, outcome: AskOutcome): void {
    const waiter = waiting.get(askId)
    if (waiter === undefined || waiter.outcome !== null) return
    waiter.outcome = outcome
  }

  function apply(items: ReturnType<typeof parseWaitResponse>): 'ok' | 'error' {
    if (items === null || items.stale) return 'error'
    for (const item of items.items) {
      const waiter = waiting.get(item.askId)
      if (waiter === undefined || item.status === 'pending') continue
      if (item.status === 'cancelled') settle(item.askId, { kind: 'cancelled', reason: item.reason })
      else {
        const answer = toAnswer(item.answer, waiter.kind)
        settle(item.askId, answer === null ? { kind: 'failed', why: 'invalid' } : { kind: 'answered', answer })
      }
    }
    return 'ok'
  }

  /** Un sondeo con todos los `askId` sin resolver, hecho con la red del hook que llama. */
  async function pollOnce(host: Host): Promise<'ok' | 'error'> {
    const askIds = [...waiting].filter(([, waiter]) => waiter.outcome === null).map(([askId]) => askId)
    polls += 1
    try {
      const response = await bridge.post(host, '/v1/ask/wait', { sesionId, generation: bridge.generation(), askIds })
      return response === null || !response.ok ? 'error' : apply(parseWaitResponse(response.text))
    } finally {
      polls -= 1
      notify()
    }
  }

  /** Espera a que cambie algo: un sondeo termina, la señal aborta o toca relevar. */
  async function standBy(ctx: AskContext): Promise<void> {
    const remaining = ctx.remainingMs()
    const timer = Number.isFinite(remaining) ? ctx.host.after(Math.max(0, remaining - TAKEOVER_MS), () => notify()) : null
    try {
      await Promise.race([tick.promise, onAbort(ctx.signal)])
    } finally {
      timer?.cancel()
    }
  }

  function cancel(host: Host, askId: string): void {
    waiting.delete(askId)
    host.after(0, () => void bridge.post(host, '/v1/ask/cancel', { sesionId, askId, reason: 'modAborted' }))
  }

  async function create(ctx: AskContext, request: AskRequest): Promise<string | AskOutcome> {
    for (let attempt = 1; attempt <= MAX_ASK_FAILURES; attempt += 1) {
      if (attempt > 1 && ctx.remainingMs() < LOW_BUDGET_MS) return FAILED_BUDGET
      const response = await bridge.post(ctx.host, '/v1/ask', { sesionId, ask: request, async: true })
      const askId = response !== null && response.ok ? parseAskId(response.text) : null
      if (askId !== null) return askId
      if (ctx.signal.aborted) return { kind: 'aborted' }
    }
    return FAILED_UNREACHABLE
  }

  async function waitOutcome(ctx: AskContext, waiter: Waiter): Promise<AskOutcome> {
    let failures = 0
    for (;;) {
      if (waiter.outcome !== null) return waiter.outcome
      if (ctx.signal.aborted) return { kind: 'aborted' }
      if (polls > 0 && ctx.remainingMs() > TAKEOVER_MS) {
        await standBy(ctx)
        continue
      }
      if (ctx.remainingMs() < LOW_BUDGET_MS) return FAILED_BUDGET
      const poll = pollOnce(ctx.host)
      await Promise.race([poll, onAbort(ctx.signal)])
      if (ctx.signal.aborted) continue
      failures = (await poll) === 'error' && waiter.outcome === null ? failures + 1 : 0
      if (failures >= MAX_WAIT_FAILURES) return FAILED_UNREACHABLE
    }
  }

  /** Protocolo 1: una sola petición bloqueante; sin respuesta, fallo explícito. */
  async function askBlocking(ctx: AskContext, request: AskRequest): Promise<AskOutcome> {
    const call = bridge.post(ctx.host, '/v1/ask', { sesionId, ask: request })
    await Promise.race([call, onAbort(ctx.signal)])
    if (ctx.signal.aborted) return { kind: 'aborted' }
    const response = await call
    const answer = response !== null && response.ok ? parseAnswer(response.text, request.kind) : null
    return answer === null ? FAILED_UNREACHABLE : { kind: 'answered', answer }
  }

  return {
    async ask(ctx: AskContext, request: AskRequest): Promise<AskOutcome> {
      if (bridge.protocol() < 2) return askBlocking(ctx, request)
      const created = await create(ctx, request)
      if (typeof created !== 'string') return created
      const waiter: Waiter = { kind: request.kind, outcome: null }
      waiting.set(created, waiter)
      const outcome = await waitOutcome(ctx, waiter)
      if (outcome.kind === 'aborted') cancel(ctx.host, created)
      else waiting.delete(created)
      return outcome
    },
    /** Sondeos `wait` en vuelo ahora mismo (para las pruebas). */
    pollsInFlight: (): number => polls,
  }
}
