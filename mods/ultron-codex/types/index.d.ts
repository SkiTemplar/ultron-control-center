/** Un trabajo de Codex tal como lo pinta el panel (de `status --all --json`). */
export type CodexJob = {
  id: string
  /** `rescue` (tarea), `review` o `adversarial-review`. */
  kind: string
  title: string
  /** `queued`, `running`, `completed`, `failed` o `cancelled`. */
  status: string
  phase: string
  /**
   * Lo que el companion guarda en el índice: el inicio del prompt mientras el
   * trabajo está en curso y la primera línea de la salida cuando termina.
   */
  summary: string
  /** El prompt de la petición (`request.prompt`, solo en tareas en segundo plano); vacío si no consta. */
  prompt: string
  /** Duración si terminó; tiempo transcurrido si sigue en curso. */
  time: string
  /** Última escritura del registro en el índice (ISO); vacío si no consta. */
  updatedAt: string
  isWrite: boolean
  isReview: boolean
  errorMessage: string | null
}

/** El resultado de un trabajo terminado (de `result <id> --json`). */
export type CodexResult = {
  id: string
  status: string
  title: string
  /** `storedJob.request.prompt`; vacío si el trabajo no guardó la petición. */
  prompt: string
  text: string
}

/** La última lista leída de `status` y el número de lectura que la produjo. */
export type CodexSnapshot = {
  seq: number
  jobs: CodexJob[]
}

declare module 'claude-code' {
  interface PluginState {
    'ultron-codex': {
      hasAutoOpened: boolean
      snapshot: CodexSnapshot
      refreshSeq: number
      refreshesInFlight: number
      pollFailures: number
      lastPolledAt: number
      isReviewAlive: boolean
      announced: string[]
      prompts: Record<string, string>
      selectedId: string | null
      detail: CodexResult | null
      isLoading: boolean
      error: string | null
      actionError: string | null
      notice: string | null
    }
  }
}
