import type { PendingSkillCall, SkillHit } from '../types'

/** Una activación concreta antes de agregarla a su fila. */
export type Activation = {
  name: string
  origin: string
  /** ≈ tokens del texto inyectado; null si no se conoce. */
  tokens: number | null
  at: number
}

export const MAIN_ORIGIN = 'principal'
/** `skill.prompt` sin llamada a la tool Skill que lo explique: `/nombre` tecleado o precarga de un subagente. */
export const UNKNOWN_LOOP_ORIGIN = '/nombre o precarga'

const MAX_ROWS = 60
const SHORT_ID = 7

/** ≈ tokens de un texto: caracteres / 4, redondeado hacia arriba. */
export const approxTokens = (text: string): number => Math.ceil(text.length / 4)

/** Origen de una llamada a la tool Skill según su loop: el hilo principal o el subagente. */
export function originOf(agentId: string | null): string {
  return agentId !== null && agentId !== '' ? `subagente ${agentId.slice(0, SHORT_ID)}` : MAIN_ORIGIN
}

/** La tool Skill puede nombrar `plugin:skill` y el motor expandir `skill`, o al revés. */
const sameSkill = (a: string, b: string): boolean => a === b || a.endsWith(`:${b}`) || b.endsWith(`:${a}`)

/** Llamada a la tool Skill en curso que explica un `skill.prompt`; undefined si ninguna lo hace. */
export const pendingFor = (pending: readonly PendingSkillCall[], skill: string): PendingSkillCall | undefined =>
  pending.find((call) => sameSkill(call.skill, skill))

export const withPending = (pending: readonly PendingSkillCall[], call: PendingSkillCall): PendingSkillCall[] => [
  ...pending.filter((p) => p.toolUseId !== call.toolUseId),
  call,
]

export const withoutPending = (pending: readonly PendingSkillCall[], toolUseId: string): PendingSkillCall[] =>
  pending.filter((p) => p.toolUseId !== toolUseId)

const keyOf = (name: string, origin: string): string => `${name}|${origin}`

const addTokens = (current: number | null, extra: number | null): number | null =>
  current === null && extra === null ? null : (current ?? 0) + (extra ?? 0)

/** Suma una activación: la fila de ese nombre y origen sube arriba con el contador incrementado. */
export function withActivation(hits: readonly SkillHit[], act: Activation): SkillHit[] {
  const key = keyOf(act.name, act.origin)
  const prev = hits.find((h) => h.key === key)
  const row: SkillHit = prev
    ? { ...prev, count: prev.count + 1, tokens: addTokens(prev.tokens, act.tokens), lastAt: act.at }
    : { key, name: act.name, origin: act.origin, count: 1, tokens: act.tokens, firstAt: act.at, lastAt: act.at }
  return [row, ...hits.filter((h) => h.key !== key)].slice(0, MAX_ROWS)
}

/** Añade una skill a las del turno en curso, sin repetirla. */
export const withTurnSkill = (names: readonly string[], name: string): string[] =>
  names.includes(name) ? [...names] : [...names, name]

/** Texto de la status line del turno; undefined la limpia. */
export const statusText = (names: readonly string[]): string | undefined =>
  names.length === 0 ? undefined : `skills: ${names.join(', ')}`

/** Totales del pie: filas, activaciones y tokens conocidos. */
export function totals(hits: readonly SkillHit[]): { skills: number; activations: number; tokens: number } {
  return {
    skills: new Set(hits.map((h) => h.name)).size,
    activations: hits.reduce((sum, h) => sum + h.count, 0),
    tokens: hits.reduce((sum, h) => sum + (h.tokens ?? 0), 0),
  }
}

export function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1_000))
  if (s < 60) return `hace ${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `hace ${m}m`
  return `hace ${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** 1234 → «1,2k»; por debajo de mil, tal cual. */
export const fmtTokens = (n: number): string => (n < 1_000 ? String(n) : `${(n / 1_000).toFixed(1).replace('.', ',')}k`)
