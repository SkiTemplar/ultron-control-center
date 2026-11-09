/** Resultado de una operación del buzón tal como se publica en `/v1/result`. */
export type OpOutcome = { ok: true; value?: unknown; text?: string } | { ok: false; error: string }

/**
 * Una operación del buzón anotada en `$.state`: «en curso» con la generación
 * que la empezó, o hecha con su resultado (§6.4).
 */
export type OpRecord = {
  opId: string
  generation: number
  status: 'running' | 'done'
  result?: OpOutcome
}

declare module 'claude-code' {
  interface PluginState {
    'ultron-puente': {
      /** Las 64 últimas operaciones del buzón; sobrevive a una recarga en caliente. */
      ops: OpRecord[]
    }
  }
}
