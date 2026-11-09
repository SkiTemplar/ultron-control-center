/** Una skill activada en esta sesión desde un origen concreto, tal como la pinta el panel. */
export type SkillHit = {
  /** `nombre|origen`: una fila por skill y origen. */
  key: string
  name: string
  /** `principal`, `subagente <id corto>` o `/nombre o precarga`. */
  origin: string
  count: number
  /** ≈ tokens inyectados en total (caracteres / 4); null si el origen no da el texto. */
  tokens: number | null
  firstAt: number
  lastAt: number
}

/** Llamada a la tool Skill en curso: su loop explica el origen del `skill.prompt` que provoca. */
export type PendingSkillCall = {
  toolUseId: string
  skill: string
  /** Id del subagente; null en el hilo principal. */
  agentId: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'ultron-skills': {
      hasAutoOpened: boolean
      hits: SkillHit[]
      turnSkills: string[]
      isTurnOver: boolean
      sessionStartedAt: number
      pendingSkillCalls: PendingSkillCall[]
      error: string | null
      now: number
    }
  }
}
