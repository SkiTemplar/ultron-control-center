/**
 * Cola FIFO de eventos del puente (§6.1). Funciones puras: cada operación
 * devuelve una cola nueva.
 *
 * Cada evento lleva `seq` (contador por generación, desde 1) para que el
 * backend descarte los duplicados de un reintento. Los deltas no se funden:
 * cada uno conserva su `seq`.
 */
import type { EventType, PuenteEvent } from './protocol'

/** Eventos por POST: un evento inmediato vacía la cola entera en el mismo POST. */
export const MAX_BATCH = 2_000
/** Tope de la cola: por encima se descartan primero los deltas más antiguos. */
export const MAX_QUEUE = 2_000

export type Stamped = {
  readonly generation: number
  readonly event: PuenteEvent & { seq: number }
  /** Ya salió en un POST fallido: conserva su sello aunque cambie la generación. */
  readonly isRetry?: true
}

export type Queue = {
  readonly items: readonly Stamped[]
  readonly generation: number
  /** Último `seq` asignado en `generation`. */
  readonly seq: number
  /** Eventos descartados por desbordamiento desde el arranque. */
  readonly dropped: number
}

export const EMPTY_QUEUE: Queue = { items: [], generation: 0, seq: 0, dropped: 0 }

/** Nunca se descartan por desbordamiento (§6.1). */
const NEVER_DROP: ReadonlySet<EventType> = new Set(['turnEnd', 'stepEnd', 'tool', 'commandEnd', 'prompt', 'turnStart', 'commandStart'])

const isDelta = (item: Stamped): boolean => item.event.type === 'text' || item.event.type === 'thinking'

function dropIndex(items: readonly Stamped[]): number {
  const delta = items.findIndex(isDelta)
  if (delta >= 0) return delta
  return items.findIndex((item) => !NEVER_DROP.has(item.event.type))
}

function trim(items: readonly Stamped[], dropped: number): { items: readonly Stamped[]; dropped: number } {
  let kept = items
  let count = dropped
  while (kept.length > MAX_QUEUE) {
    const index = dropIndex(kept)
    if (index < 0) break
    kept = [...kept.slice(0, index), ...kept.slice(index + 1)]
    count += 1
  }
  return { items: kept, dropped: count }
}

/** Añade un evento con el siguiente `seq` de la generación actual. */
export function enqueue(queue: Queue, event: PuenteEvent): Queue {
  const seq = queue.seq + 1
  const stamped: Stamped = { generation: queue.generation, event: { ...event, seq } }
  const { items, dropped } = trim([...queue.items, stamped], queue.dropped)
  return { ...queue, items, seq, dropped }
}

/**
 * Pasa a otra generación (un `hello` aceptado): los eventos aún sin enviar se
 * renumeran desde 1 en la nueva, en el mismo orden. Los que ya salieron en un
 * POST fallido vuelven con su sello original (`requeue`).
 */
export function renumber(queue: Queue, generation: number): Queue {
  if (generation === queue.generation) return queue
  let seq = 0
  const items = queue.items.map((item) => {
    if (item.isRetry === true) return item
    seq += 1
    return { generation, event: { ...item.event, seq } }
  })
  return { ...queue, items, generation, seq }
}

/**
 * El backend rechazó `batch` por ser de una generación anterior (un `hello`
 * a mitad de turno, `/compact`): el lote vuelve a la cabeza y toda la cola se
 * renumera desde 1 en `generation`, en el mismo orden. Nada de esa generación
 * ha salido aún, porque el lote rechazado iba delante y solo hay un POST en
 * vuelo.
 */
export function restamp(queue: Queue, batch: readonly Stamped[], generation: number): Queue {
  const target = Math.max(generation, queue.generation)
  const { items, dropped } = trim([...batch, ...queue.items], queue.dropped)
  const renumbered = items.map((item, index): Stamped => ({ generation: target, event: { ...item.event, seq: index + 1 } }))
  return { ...queue, items: renumbered, generation: target, seq: renumbered.length, dropped }
}

/** Separa el siguiente lote: los primeros eventos de la misma generación. */
export function takeBatch(queue: Queue): { batch: Stamped[]; rest: Queue } {
  const first = queue.items[0]
  if (first === undefined) return { batch: [], rest: queue }
  let end = 0
  while (end < queue.items.length && end < MAX_BATCH && queue.items[end]?.generation === first.generation) end += 1
  return { batch: queue.items.slice(0, end), rest: { ...queue, items: queue.items.slice(end) } }
}

/** Devuelve un lote fallido a la cabeza de la cola, sin perder nada. */
export function requeue(queue: Queue, batch: readonly Stamped[]): Queue {
  const retried = batch.map((item): Stamped => ({ ...item, isRetry: true }))
  const { items, dropped } = trim([...retried, ...queue.items], queue.dropped)
  return { ...queue, items, dropped }
}
