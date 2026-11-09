/** De dónde sale un agente: el tool Agent (subagente) o una ejecución del tool Workflow. */
export type AgentSource = 'subagent' | 'workflow'

/** Un agente de esta sesión, tal como lo pinta el panel. */
export type AgentRow = {
  id: string
  type: string
  description: string
  model: string
  /** `running`, `completed`, `failed`, `killed`, `stale` (sin señales de vida) u otro estado del motor o del journal. */
  status: string
  parentId: string | null
  startedAt: number
  endedAt: number | null
  source: AgentSource
  /** Ejecución de workflow a la que pertenece; null en un subagente. */
  runId: string | null
  /** Fase del workflow; '' en un subagente. */
  phase: string
  /** Extracto del resultado; null mientras no se ha leído. */
  result: string | null
  /** Se leyó su agent-<id>.meta.json (siempre true en un subagente). */
  hasMeta: boolean
  /** Intentos de leer la meta hechos hasta ahora. */
  metaTries: number
}

/** Lo que ha hecho un agente: cuántas herramientas y las últimas, la más reciente al final. */
export type Activity = {
  tools: number
  history: string[]
}

/** Una ejecución del tool Workflow lanzada en esta sesión. */
export type WorkflowRun = {
  runId: string
  name: string
  taskId: string
  /** Carpeta del run (journal.jsonl, agent-<id>.meta.json, agent-<id>.jsonl). */
  dir: string
  startedAt: number
  /** Última vez que el journal creció. */
  lastChangeAt: number
  /** Última vez que se miró la carpeta del run. */
  checkedAt: number
  endedAt: number | null
  /** Tamaño y fecha del journal en la última lectura: si no cambian, no se relee. */
  journalStamp: string
  /** Líneas del journal que no son JSON válido. */
  badLines: number
  /** Último problema al seguir el run; null si va bien. */
  error: string | null
  /** Agentes que se limpiaron o salieron del historial: el journal no los vuelve a añadir. */
  dropped: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'ultron-agentes': {
      agents: AgentRow[]
      runs: WorkflowRun[]
      activity: Record<string, Activity>
      selected: string | null
      notice: string
      now: number
      isFullscreen: boolean
      isDismissed: boolean
    }
  }
}
