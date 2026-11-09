import type { UsoWindow } from '../types'

export type Tone = 'success' | 'warning' | 'error'

const LABELS: Record<string, string> = { five_hour: '5 horas', seven_day: 'Semanal' }
const BAR = 20

/** Porcentaje sin decimales: `55 %`. */
export const pct = (n: number): string => `${Math.round(n)} %`

export const windowLabel = (kind: string): string =>
  LABELS[kind] ?? Object.entries(LABELS).find(([k]) => kind.startsWith(k))?.[1] ?? kind

export const isWeek = (w: UsoWindow): boolean => w.kind.startsWith('seven_day')

/** Barra de % usado: ▰ usado, ▱ libre. */
export function bar(used: number): string {
  const filled = Math.min(BAR, Math.max(0, Math.round((used / 100) * BAR)))
  return '▰'.repeat(filled) + '▱'.repeat(BAR - filled)
}

/** Color de la barra: rojo si llega al límite antes del reset, ámbar si va justo. */
export function tone(w: UsoWindow): Tone {
  if (w.runsOutLabel !== null) return 'error'
  return w.projectedPct !== null && w.projectedPct > 90 ? 'warning' : 'success'
}

/** `uso 55 % · tiempo 54 %`, y en la semanal `· relativo 63 %` (tiempo según tu horario). */
export function usageLine(w: UsoWindow): string {
  const base = `uso ${pct(w.used)} · tiempo ${pct(w.linearElapsedPct)}`
  return isWeek(w) && w.isScheduled ? `${base} · relativo ${pct(w.elapsedPct)}` : base
}

/** Ritmo (100 % = llegar al reset justo en el límite) y hora estimada de llegar al límite. */
export function limitLine(w: UsoWindow): string {
  const rate = w.projectedPct === null ? '—' : pct(w.projectedPct)
  return `ritmo ${rate} · límite ${w.runsOutLabel ?? 'no llega'}`
}

const dec = (n: number): string => n.toFixed(1).replace('.', ',')

/** Lo que queda de la semana en ventanas de 5 h llenas (y su %). */
export function fiveHourLines(w: UsoWindow, weekInFiveHourPct: number | null): string[] {
  if (weekInFiveHourPct === null) return []
  const left = (Math.max(0, 100 - w.used) * weekInFiveHourPct) / 100
  return [`ventanas 5 h: quedan ${dec(left / 100)} de ${dec(weekInFiveHourPct / 100)} (${pct(left)})`]
}

/** Ventanas que acaban de entrar en alerta (para avisar una vez). */
export const newAlerts = (windows: readonly UsoWindow[], seen: readonly string[]): string[] =>
  windows.filter((w) => w.isAlert && !seen.includes(w.kind)).map((w) => w.kind)
