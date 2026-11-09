export type CtxCategory = { name: string; tokens: number; color: string; kind: string }

/** Una fila de ranking: qué es, un detalle corto y sus tokens (estimados o medidos). */
export type CtxItem = { label: string; detail: string; tokens: number; count: number }

export type CtxRateLimit = { kind: string; percentUsed: number; resetsAt: string | null }

export type CtxSnapshot = {
  takenAt: number
  detail: 'summary' | 'full'
  model: string
  totalTokens: number
  maxTokens: number
  percentage: number
  autoCompactThreshold: number | null
  categories: CtxCategory[]
  memory: CtxItem[]
  mcpServers: CtxItem[]
  skills: { total: number; included: number; tokens: number; top: CtxItem[] } | null
  agents: { tokens: number; top: CtxItem[] }
  slashCommands: { total: number; included: number; tokens: number } | null
  costUsd: number | null
  rateLimits: CtxRateLimit[]
}

/** Reparto de la categoría de mensajes: por herramienta, piezas más gordas y relecturas. */
export type CtxConversation = {
  messageTokens: number
  byKind: CtxItem[]
  heaviest: CtxItem[]
  rereads: CtxItem[]
}

export type CtxTab = 'resumen' | 'carga' | 'conversacion'

declare module 'claude-code' {
  interface PluginState {
    'ultron-contexto': {
      snapshot: CtxSnapshot | null
      conversation: CtxConversation | null
      tab: CtxTab
      isLoading: boolean
      error: string | null
      hasAutoOpened: boolean
    }
  }
}
