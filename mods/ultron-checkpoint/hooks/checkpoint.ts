/** Lógica pura de ultron-checkpoint: lectura de la salida de git y formato de los listados. */

export const REF_ROOT = 'refs/ultron/checkpoints'

/** Lo que interesa de `git status --porcelain=v2 --branch`: HEAD y número de entradas. */
export type StatusSummary = { head: string | null; entries: number }

export function parseStatusV2(text: string): StatusSummary {
  let head: string | null = null
  let entries = 0
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (line === '') continue
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length).trim()
      head = oid === '(initial)' ? null : oid
    } else if (!line.startsWith('#')) {
      entries += 1
    }
  }
  return { head, entries }
}

/** Segmento válido de nombre de ref: solo letras, dígitos, punto, guion y guion bajo. */
export const refSegment = (raw: string): string => raw.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '').replace(/\.lock$/, '') || 'sin-id'

export const sessionPrefix = (sessionId: string): string => `${REF_ROOT}/${refSegment(sessionId)}/`

export type Checkpoint = { ref: string; sha: string; takenAt: number }

/** Instante de la foto: el último segmento de la ref (milisegundos); NaN si no lo es. */
const stampOf = (ref: string): number => Number(ref.slice(ref.lastIndexOf('/') + 1))

/** Lee `git for-each-ref --format=%(refname)%09%(objectname)`; los más recientes primero. */
export function parseRefs(text: string): Checkpoint[] {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((parts): parts is [string, string] => parts.length === 2 && parts[0] !== '' && parts[1] !== '')
    .map(([ref, sha]) => ({ ref, sha, takenAt: stampOf(ref) }))
    .filter((c) => Number.isFinite(c.takenAt))
    .sort((a, b) => b.takenAt - a.takenAt)
}

/** Refs que sobran para dejar las `keep` más recientes del repo. */
export const refsToPrune = (all: readonly Checkpoint[], keep: number): string[] => all.slice(keep).map((c) => c.ref)

/**
 * Lee `git log --no-walk=unsorted --format=%x00%H --name-only <shas>`: ficheros que cambió
 * cada foto respecto a su padre (el HEAD de cuando se tomó).
 */
export function parseChangedCounts(text: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const block of text.replace(/\r/g, '').split('\0')) {
    const lines = block.split('\n').filter((l) => l !== '')
    const sha = lines[0]
    if (sha !== undefined) out.set(sha, lines.length - 1)
  }
  return out
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Fecha y hora local `AAAA-MM-DD HH:MM:SS`. */
export const localStamp = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const files = (n: number): string => (n === 1 ? '1 fichero' : `${n} ficheros`)

export const restoreHint = (ref: string): string =>
  `Para restaurar a mano (no se hace solo): git restore --source=${ref} --worktree -- .`

/** Listado de /checkpoints: 1 es el más reciente. */
export function formatList(list: readonly Checkpoint[], counts: ReadonlyMap<string, number>): string {
  const lines = list.map((c, i) => {
    const count = counts.get(c.sha)
    const changed = count === undefined ? 'ficheros: ?' : `${files(count)} ${count === 1 ? 'cambiado' : 'cambiados'} respecto a HEAD`
    return `${i + 1}. ${localStamp(c.takenAt)} · ${changed} · ${c.sha.slice(0, 7)}`
  })
  const newest = list[0]
  return [
    `Checkpoints de esta sesión (${list.length}, el 1 es el más reciente):`,
    ...lines,
    'Diferencias con el árbol actual: /checkpoint-diff <n>.',
    ...(newest === undefined ? [] : [restoreHint(newest.ref)]),
  ].join('\n')
}

/** Número de checkpoint de /checkpoint-diff, o el error que se enseña. */
export function parseIndex(raw: string, count: number): number | { error: string } {
  const text = raw.trim()
  if (text === '') return { error: 'Uso: /checkpoint-diff <n>, con n el número que da /checkpoints (1 = el más reciente).' }
  const n = Number(text)
  if (!Number.isInteger(n) || n < 1) return { error: `«${text}» no es un número de checkpoint válido: usa un entero desde 1.` }
  if (n > count) return { error: count === 0 ? 'Esta sesión no tiene checkpoints todavía.' : `Solo hay ${count} checkpoints en esta sesión.` }
  return n
}
