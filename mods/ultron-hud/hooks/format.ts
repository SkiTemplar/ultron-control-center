import type { HudTone, HudTurn } from '../types'

export type SpinnerMode = 'requesting' | 'responding' | 'thinking' | 'tool-input' | 'tool-use'

/** Con el tono por defecto el spinner dice qué está haciendo, no un verbo decorativo. */
export const MODE_VERB: Record<SpinnerMode, string> = {
  requesting: 'Consultando',
  thinking: 'Razonando',
  responding: 'Redactando',
  'tool-input': 'Preparando',
  'tool-use': 'Ejecutando',
}

const ROTATE_MS = 20_000
const MATCH_TOLERANCE_MS = 1_500

export function pickVerb(tone: HudTone | null, mode: SpinnerMode, now: number): string {
  if (tone && !tone.isDefault && tone.verbs.length > 0) {
    return tone.verbs[Math.floor(now / ROTATE_MS) % tone.verbs.length] ?? MODE_VERB[mode]
  }
  return MODE_VERB[mode]
}

export function fmtDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function fmtTokens(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1).replace('.', ',')}k`
  return `${(n / 1_000_000).toFixed(2).replace('.', ',')}M`
}

export const fmtUsd = (usd: number): string => `$${usd.toFixed(usd < 1 ? 3 : 2).replace('.', ',')}`

/** El turno cuya duración casa con la de la línea de cierre (mismo turno, otro reloj). */
export function nearestTurn(turns: readonly HudTurn[], durationMs: number): HudTurn | undefined {
  let best: HudTurn | undefined
  for (const turn of turns) {
    const gap = Math.abs(turn.durationMs - durationMs)
    if (gap <= MATCH_TOLERANCE_MS && (!best || gap < Math.abs(best.durationMs - durationMs))) best = turn
  }
  return best
}

export function turnSummary(turn: HudTurn): string {
  const parts = [
    turn.tools > 0 ? `${turn.tools} herramienta${turn.tools === 1 ? '' : 's'}` : '',
    turn.outputTokens > 0 ? `${fmtTokens(turn.outputTokens)} tok de salida` : '',
    turn.costUsd !== null && turn.costUsd > 0 ? fmtUsd(turn.costUsd) : '',
  ]
  return parts.filter(Boolean).join(' · ')
}

export const SOCRATIC_MODES = ['strict', 'light', 'off', 'uni'] as const

/** Lee el argumento de /socratico: `''` (consulta), un modo válido o `null` (inválido). */
export function parseSocraticMode(args: string): string | null {
  const mode = args.trim().toLowerCase()
  if (mode === '') return ''
  return (SOCRATIC_MODES as readonly string[]).includes(mode) ? mode : null
}
