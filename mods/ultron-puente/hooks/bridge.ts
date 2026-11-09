/**
 * Transporte HTTP del puente v2 (§6.1): `hello` con generación y cola FIFO de
 * eventos con un solo POST en vuelo.
 *
 * - Un evento inmediato vacía la cola entera en el mismo POST, así que nunca
 *   adelanta a los deltas que tenía delante.
 * - Un lote fallido (red o 5xx) vuelve a la cabeza de la cola y se reintenta a
 *   los 0,5 s, 1 s y 2 s (y después cada 2 s): nunca se descarta.
 * - Los eventos esperan al primer `hello` aceptado, que fija la generación.
 * - Un lote de una generación anterior (`stale`: un `hello` llegó mientras iba
 *   de camino) vuelve a la cabeza renumerado en la generación vigente.
 *
 * Nunca lanza ni bloquea la sesión; los fallos se cuentan en `stats()`.
 */
import type { HelloPayload, HelloResponse, PuenteConfig, PuenteEvent } from './protocol'
import { MOD_VERSION, PROTOCOL, parseEventsStale, parseHelloResponse, parseHelloSuperseded } from './protocol'
import { EMPTY_QUEUE, enqueue, renumber, requeue, restamp, takeBatch } from './queue'
import type { Queue } from './queue'

/** Espera máxima antes de enviar un lote de deltas. */
export const FLUSH_MS = 80
/** Esperas entre reintentos de un lote o de un `hello`; la última se repite. */
export const RETRY_MS: readonly number[] = [500, 1_000, 2_000]

export type HttpResponse = { ok: boolean; status: number; text: string }

/** Lo que el puente necesita del motor: red y temporizador. */
export type Host = {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<HttpResponse>
  after: (ms: number, fn: () => void) => { cancel: () => void }
}

export type BridgeStats = { sent: number; failed: number; dropped: number; queued: number }

/** Tipos que salen con `schedule(0)` (§6.1); el primer delta de cada paso, también. */
const IMMEDIATE = new Set<PuenteEvent['type']>([
  'turnStart', 'tool', 'stepEnd', 'turnEnd', 'prompt', 'commandStart', 'commandEnd', 'mode', 'composerFill', 'notice',
])

/**
 * 4xx que cierran el puente para siempre: token o sesión rechazados (401/403)
 * u otro `claude` es dueño de la sesión (409: este proceso es un hijo que
 * heredó las variables del puente).
 */
const REJECTING = new Set([401, 403, 409])
const OWNED_BY_OTHER = 409

/**
 * Identidad de este proceso del mod (`instanceId`): estable entre `/clear` y
 * `/resume`, distinta en cada `claude`. El backend ata a ella la propiedad de
 * la sesión y el veto de un hijo, no al `claudeSessionId`.
 */
const INSTANCE_ID = `mod-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
/** Orden de los anuncios de este proceso (`helloSeq`): un reintento viejo no pisa a uno nuevo. */
let helloSeq = 0

export const retryDelay = (failures: number): number => RETRY_MS[Math.min(Math.max(failures, 1), RETRY_MS.length) - 1] ?? 2_000

export const delay = (host: Host, ms: number): Promise<void> => new Promise((resolve) => void host.after(ms, resolve))

export type Bridge = ReturnType<typeof createBridge>

export function createBridge(config: PuenteConfig) {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${config.token}` }
  let queue: Queue = EMPTY_QUEUE
  let timer: { cancel: () => void; isImmediate: boolean } | null = null
  let isSending = false
  let wantsImmediate = false
  let isOpen = false
  let isRejected = false
  /** Rechazado con 409: la sesión es de otro `claude`; este proceso no debe tocarla. */
  let isForeign = false
  /** Contexto sustituido por otro `session.start`: no vuelve a enviar nada. */
  let isClosed = false
  let protocol = 0
  /** `helloSeq` del último anuncio de este contexto. */
  let latestHello = 0
  let failures = 0
  let sent = 0
  let failed = 0
  /** Último paso visto por bucle (`main` o subagente), para el primer delta inmediato. */
  const lastStep = new Map<string, string>()

  /** Un POST; null ante error de red. */
  async function post(host: Host, path: string, body: unknown): Promise<HttpResponse | null> {
    try {
      return await host.fetch(`${config.url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
    } catch {
      return null
    }
  }

  /** Un 4xx: anota si cierra el puente para siempre. */
  function reject(status: number): void {
    isRejected = REJECTING.has(status)
    isForeign = status === OWNED_BY_OTHER
  }

  function schedule(host: Host, ms: number): void {
    if (isSending) {
      wantsImmediate = wantsImmediate || ms === 0
      return
    }
    if (timer !== null && (timer.isImmediate || ms > 0)) return
    timer?.cancel()
    const handle = host.after(ms, () => {
      timer = null
      void flush(host)
    })
    timer = { cancel: handle.cancel, isImmediate: ms === 0 }
  }

  function afterBatch(host: Host, isDelivered: boolean): void {
    if (isDelivered) failures = 0
    if (queue.items.length === 0) return
    if (!isDelivered) return schedule(host, retryDelay(failures))
    schedule(host, wantsImmediate ? 0 : FLUSH_MS)
  }

  async function flush(host: Host): Promise<void> {
    if (isSending || !isOpen || isRejected || isClosed || queue.items.length === 0) return
    const { batch, rest } = takeBatch(queue)
    queue = rest
    isSending = true
    wantsImmediate = false
    const generation = batch[0]?.generation ?? 0
    const response = await post(host, '/v1/events', { sesionId: config.sesionId, generation, events: batch.map((item) => item.event) })
    isSending = false
    const stale = response !== null && response.ok ? parseEventsStale(response.text) : null
    if (stale !== null && stale > generation) {
      // Un `hello` subió la generación mientras el lote iba de camino: se
      // reenvía renumerado en la vigente en vez de perderse.
      queue = restamp(queue, batch, stale)
      wantsImmediate = true
      return afterBatch(host, true)
    }
    const isDelivered = response !== null && response.ok && stale === null
    if (isDelivered) sent += batch.length
    else if (stale !== null) failed += batch.length
    else if (response !== null && response.status < 500) {
      // 4xx: el backend rechaza el token o la sesión; reintentar no lo arregla.
      failed += batch.length
      reject(response.status)
    } else {
      failures += 1
      queue = requeue(queue, batch)
    }
    afterBatch(host, isDelivered || (response !== null && response.status < 500))
  }

  function isFirstOfStep(event: PuenteEvent): boolean {
    if (event.type !== 'text' && event.type !== 'thinking') return false
    const loop = event.agentId ?? 'main'
    const key = `${event.turnId}:${event.step}`
    if (lastStep.get(loop) === key) return false
    lastStep.set(loop, key)
    return true
  }

  /** Aplica un `hello` aceptado: la generación solo avanza. */
  function accept(host: Host, hello: HelloResponse): void {
    protocol = hello.protocol
    if (hello.generation > queue.generation) queue = renumber(queue, hello.generation)
    isOpen = true
    schedule(host, 0)
  }

  /**
   * `hello` con reintentos idempotentes (mismo `helloSeq`). Un anuncio
   * posterior lo sustituye: el reintento se abandona en silencio, sin
   * rechazo, tanto si lo ve este proceso como si lo dice el backend.
   */
  async function hello(host: Host, payload: HelloPayload): Promise<HelloResponse | null> {
    helloSeq += 1
    const seq = helloSeq
    latestHello = seq
    const isSuperseded = (): boolean => latestHello !== seq
    const body = { sesionId: config.sesionId, protocol: PROTOCOL, modVersion: MOD_VERSION, instanceId: INSTANCE_ID, helloSeq: seq, ...payload }
    for (let attempt = 1; !isRejected && !isClosed && !isSuperseded(); attempt += 1) {
      const response = await post(host, '/v1/hello', body)
      if (isClosed || isSuperseded()) return null
      if (response !== null && response.ok && parseHelloSuperseded(response.text)) return null
      if (response !== null && response.ok) {
        const parsed = parseHelloResponse(response.text)
        accept(host, parsed)
        return parsed
      }
      failed += 1
      if (response !== null && response.status < 500) {
        reject(response.status)
        isOpen = true
        return null
      }
      await delay(host, retryDelay(attempt))
    }
    return null
  }

  return {
    emit(host: Host, event: PuenteEvent): void {
      if (isRejected || isClosed) return
      queue = enqueue(queue, event)
      schedule(host, IMMEDIATE.has(event.type) || isFirstOfStep(event) ? 0 : FLUSH_MS)
    },
    hello,
    post,
    /** Protocolo del último `hello` aceptado; 0 sin ninguno. */
    protocol: (): number => protocol,
    generation: (): number => queue.generation,
    isRejected: (): boolean => isRejected,
    /** La sesión es de otro `claude` (409): el mod debe comportarse como si no hubiera puente. */
    isForeign: (): boolean => isForeign,
    /** Deja de enviar y de reintentar (el contexto lo sustituye otro). */
    close(): void {
      isClosed = true
      timer?.cancel()
      timer = null
    },
    stats: (): BridgeStats => ({ sent, failed, dropped: queue.dropped, queued: queue.items.length }),
  }
}
