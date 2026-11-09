/** Salida de error de una herramienta, recortada a 300 caracteres. */
export type ToolErrorText = string

declare module 'claude-code' {
  interface PluginState {
    'ultron-mejorar': {
      /** Último prompt que la persona envió desde la caja, tal cual; null si aún no hay ninguno. */
      lastPrompt: string | null
      /** Última salida de error de una herramienta del turno en curso o del anterior; null si no la hay. */
      lastToolError: ToolErrorText | null
    }
  }
}
