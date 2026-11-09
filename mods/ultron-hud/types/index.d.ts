/** Un turno del hilo principal ya cerrado, para la línea que lo cierra. */
export type HudTurn = {
  durationMs: number
  tools: number
  outputTokens: number
  costUsd: number | null
}

export type HudProject = { id: string; name: string; socratic: string }

export type HudTone = { id: string | null; isDefault: boolean; verbs: string[] }

declare module 'claude-code' {
  interface PluginState {
    'ultron-hud': {
      project: HudProject | null
      tone: HudTone | null
      turns: HudTurn[]
    }
  }
}
