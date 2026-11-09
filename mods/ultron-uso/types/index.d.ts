/** Una ventana de límite del plan, en absoluto y en relativo (lib/usage-pace.js de ULTRON). */
export type UsoWindow = {
  /** `five_hour`, `seven_day` u otra ventana que informe la API. */
  kind: string
  /** % de la ventana usado (absoluto). */
  used: number
  /** % de uso esperado a estas alturas según el horario (lineal si no hay horario). */
  elapsedPct: number
  /** % de tiempo transcurrido de la ventana. */
  linearElapsedPct: number
  /** Ritmo: % usado / % esperado × 100; null si no se puede calcular. */
  projectedPct: number | null
  isScheduled: boolean
  isAlert: boolean
  resetsAtMs: number
  /** Cuándo llega al 100 % al ritmo actual (`hoy 18:30`, `mié 07 20:15`); null si llega antes al reset. */
  runsOutLabel: string | null
}

export type UsoSnapshot = {
  windows: UsoWindow[]
  /** La semana en % de una ventana de 5 h (200 = dos ventanas llenas), según logs/usage-history.jsonl; null sin muestras. */
  weekInFiveHourPct: number | null
  takenAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'ultron-uso': {
      hasAutoOpened: boolean
      snapshot: UsoSnapshot | null
      error: string | null
      alerts: string[]
    }
  }
}
