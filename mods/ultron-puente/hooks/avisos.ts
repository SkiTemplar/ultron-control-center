/**
 * Avisos de otros mods hacia la ventana de Sessions (auditoría 2026-11-01). La TUI
 * está oculta, así que `$.ui.toast`, `$.ui.log`, `$.ui.status` y `$.prompt.suggest`
 * no los ve nadie: `ultron-cierre` era un no-op silencioso (mandamiento 11). El
 * puente los copia como eventos `notice`, que la ventana pinta como notas del chat.
 *
 * Una nota se queda en el chat y un toast o un status no: se filtra lo repetido.
 * Límite declarado: un status que cambia varias veces en `STATUS_MIN_MS` solo
 * muestra el primero (`permisos: N auto` escribe uno por aprobación), y borrar un
 * status (`undefined`) no borra la nota. Módulo puro: sin `$`, testeable por separado.
 */

export type AvisoKind = 'toast' | 'log' | 'status' | 'suggest'

/** Mínimo entre dos notas de status de un mismo mod. */
export const STATUS_MIN_MS = 30_000
/** Mínimo para repetir exactamente el mismo aviso de un mismo mod. */
export const REPEAT_MIN_MS = 60_000
/** Tope del texto de una nota. */
export const MAX_NOTICE_TEXT = 2_000

/** Texto de la nota, con el nombre del mod si el aviso no empieza ya por él. */
export function noticeText(kind: AvisoKind, plugin: string, text: string): string {
  const clean = text.trim().slice(0, MAX_NOTICE_TEXT)
  const short = plugin.replace(/^ultron-/, '')
  if (kind === 'suggest') return `Sugerencia de ${short}: ${clean}`
  return clean.toLowerCase().startsWith(short.toLowerCase()) || clean.startsWith(plugin) ? clean : `${short}: ${clean}`
}

type Seen = { text: string; at: number }

/** Filtro de lo repetido, por mod y tipo de aviso. */
export function createAvisos(): { shouldForward: (kind: AvisoKind, plugin: string, text: string, now: number) => boolean; clear: () => void } {
  const last = new Map<string, Seen>()
  return {
    shouldForward(kind, plugin, text, now) {
      const key = `${kind}:${plugin}`
      const seen = last.get(key)
      if (seen !== undefined) {
        if (seen.text === text && now - seen.at < REPEAT_MIN_MS) return false
        if (kind === 'status' && now - seen.at < STATUS_MIN_MS) return false
      }
      last.set(key, { text, at: now })
      return true
    },
    clear() {
      last.clear()
    },
  }
}
