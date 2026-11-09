/**
 * Buzón backend → mod (§6.4): sondeo largo `POST /v1/inbox` por generación y
 * ejecución de cada operación como mucho una vez.
 *
 * El backend reentrega cada operación hasta recibir su `/v1/result`. Antes de
 * ejecutar, el mod la anota «en curso» en `$.state` (sobrevive a una recarga
 * en caliente) con una escritura condicionada a la versión; al terminar guarda
 * el resultado. Una operación ya hecha se contesta con el resultado guardado;
 * una «en curso» de la misma generación no se toca; una «en curso» de otra
 * generación (la recarga mató su promesa) se contesta con error sin repetir el
 * efecto. Se guardan las 64 últimas.
 *
 * Caducidad: una operación con `expiresAt` vencido no se ejecuta; se anota y
 * se contesta con `ok:false` («caducada»). Quien la pidió ya dejó de esperarla
 * (el `prompt.clear` de G3 caería tarde sobre otra caja). Sin el campo
 * (backend antiguo), se ejecuta como siempre.
 */
import type { Bridge, Host } from './bridge'
import type { OpOutcome, OpRecord } from '../types'
import { delay } from './bridge'
import type { InboxOp } from './protocol'
import { parseInboxResponse } from './protocol'

export const MAX_OP_RECORDS = 64
/** Espera tras un fallo de red del sondeo. */
export const INBOX_RETRY_MS = 2_000
/** Espera cuando el sondeo solo devuelve operaciones que ya están en marcha aquí. */
export const INBOX_IDLE_MS = 1_000
/** Intentos de la escritura condicionada antes de rendirse por contención. */
const MAX_CAS = 8

export const ORPHAN_ERROR = 'resultado perdido al recargar el mod; puede haberse aplicado'
export const EXPIRED_ERROR = 'caducada: venció su plazo antes de ejecutarse; no se aplicó'

/** `$.state` del mod para la clave `ops`, con escritura condicionada. */
export type OpsStore = {
  read: () => Promise<{ records: OpRecord[]; version: number }>
  write: (records: OpRecord[], ifVersion: number) => Promise<boolean>
}

export type OpExecutor = (op: InboxOp) => Promise<OpOutcome>

/**
 * Lo que el buzón necesita del motor en cada generación: ejecutar, anotar y la
 * hora (ms desde la época UNIX) para la caducidad; sin `now` no se comprueba.
 */
export type InboxDeps = { execute: OpExecutor; store: OpsStore; now?: () => Promise<number> }

/** true si `op` trae caducidad y ya pasó. Función pura. */
export function isExpired(op: InboxOp, now: number): boolean {
  return op.expiresAt !== undefined && now >= op.expiresAt
}

async function expired(op: InboxOp, deps: InboxDeps): Promise<boolean> {
  if (op.expiresAt === undefined || deps.now === undefined) return false
  return isExpired(op, await deps.now())
}

export type Decision = { kind: 'run' } | { kind: 'skip' } | { kind: 'replay'; result: OpOutcome } | { kind: 'orphan' }

/** Qué hacer con una operación según lo anotado. Función pura. */
export function decide(records: readonly OpRecord[], opId: string, generation: number): Decision {
  const record = records.find((item) => item.opId === opId)
  if (record === undefined) return { kind: 'run' }
  if (record.status === 'done' && record.result !== undefined) return { kind: 'replay', result: record.result }
  return record.generation === generation ? { kind: 'skip' } : { kind: 'orphan' }
}

/** Inserta o sustituye el registro de `opId`, conservando los 64 más recientes. */
export function withRecord(records: readonly OpRecord[], record: OpRecord): OpRecord[] {
  const rest = records.filter((item) => item.opId !== record.opId)
  return [...rest, record].slice(-MAX_OP_RECORDS)
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export type Inbox = ReturnType<typeof createInbox>

/** Escritura condicionada en bucle: vuelve a leer si otra escritura ganó. */
async function update(store: OpsStore, change: (records: readonly OpRecord[]) => OpRecord[] | null): Promise<OpRecord[] | null> {
  for (let attempt = 0; attempt < MAX_CAS; attempt += 1) {
    const { records, version } = await store.read()
    const next = change(records)
    if (next === null) return null
    if (await store.write(next, version)) return next
  }
  return null
}

export function createInbox(bridge: Bridge, sesionId: string) {
  let generation: number | null = null
  /** Operaciones en marcha en este entorno del módulo (atajo antes de leer `$.state`). */
  const active = new Set<string>()

  async function claim(store: OpsStore, op: InboxOp, gen: number): Promise<Decision> {
    let decision = { kind: 'skip' } as Decision
    const written = await update(store, (records) => {
      decision = decide(records, op.opId, gen)
      if (decision.kind === 'run') return withRecord(records, { opId: op.opId, generation: gen, status: 'running' })
      if (decision.kind === 'orphan') {
        const result: OpOutcome = { ok: false, error: ORPHAN_ERROR }
        return withRecord(records, { opId: op.opId, generation: gen, status: 'done', result })
      }
      return null
    })
    if (decision.kind === 'orphan') return { kind: 'replay', result: { ok: false, error: ORPHAN_ERROR } }
    if (decision.kind === 'run' && written === null) return { kind: 'skip' }
    return decision
  }

  async function publish(host: Host, opId: string, outcome: OpOutcome): Promise<void> {
    await bridge.post(host, '/v1/result', { sesionId, opId, ...outcome })
  }

  async function handle(host: Host, op: InboxOp, gen: number, deps: InboxDeps): Promise<void> {
    active.add(op.opId)
    try {
      const decision = await claim(deps.store, op, gen)
      if (decision.kind === 'replay') return await publish(host, op.opId, decision.result)
      if (decision.kind !== 'run') return
      // Justo antes de ejecutar (tras anotarla «en curso»): lo más cerca posible del efecto.
      const outcome: OpOutcome = (await expired(op, deps))
        ? { ok: false, error: EXPIRED_ERROR }
        : await deps.execute(op).catch((error: unknown): OpOutcome => ({ ok: false, error: errorText(error) }))
      await update(deps.store, (records) => withRecord(records, { opId: op.opId, generation: gen, status: 'done', result: outcome }))
      await publish(host, op.opId, outcome)
    } finally {
      active.delete(op.opId)
    }
  }

  async function loop(host: Host, gen: number, deps: InboxDeps): Promise<void> {
    while (generation === gen) {
      const response = await bridge.post(host, '/v1/inbox', { sesionId, generation: gen })
      if (generation !== gen) return
      const parsed = response !== null && response.ok ? parseInboxResponse(response.text) : null
      if (parsed === null) {
        await delay(host, INBOX_RETRY_MS)
        continue
      }
      if (parsed.stale) return
      const fresh = parsed.items.filter((op) => !active.has(op.opId))
      for (const op of fresh) void handle(host, op, gen, deps)
      if (fresh.length === 0 && parsed.items.length > 0) await delay(host, INBOX_IDLE_MS)
    }
  }

  return {
    /**
     * Arranca el bucle de `gen` (tras un `hello` aceptado); el de otra generación
     * termina solo. Una generación anterior a la vigente se ignora: con dos
     * `hello` casi a la vez (`--resume`) la respuesta del primero puede llegar
     * la última, y su sondeo recibía `stale` y dejaba el buzón sin bucle.
     */
    start(host: Host, gen: number, deps: InboxDeps): void {
      if (generation !== null && gen < generation) return
      generation = gen
      host.after(0, () => void loop(host, gen, deps))
    },
    /** Para el bucle (fin de sesión que no es `/clear` ni `/resume`). */
    stop(): void {
      generation = null
    },
    /** Entrada directa de una operación (pruebas y reentregas). */
    handle,
    isRunning: (): boolean => generation !== null,
  }
}
