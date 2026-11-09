/** Funciones puras de /relevo: encargo al modelo, nombre del fichero y motivos de fallo. */

export const RELEVOS_DIR = '.claude/relevos'

const SECTIONS = ['Objetivo', 'Hecho', 'Decisiones', 'Pendiente', 'Siguiente paso', 'Riesgos']

/** El encargo que recibe el fork del modelo sobre su propio transcript. */
export function forkPrompt(note: string): string {
  const lines = [
    'Escribe un relevo de esta sesión para que otra sesión, con contexto limpio, continúe el trabajo.',
    'Formato: markdown, en español técnico con ortografía completa, como máximo 400 palabras, sin título ni preámbulo.',
    `Usa exactamente estas secciones como encabezados de nivel 2: ${SECTIONS.join(', ')}.`,
    '- Objetivo: qué se persigue y el criterio de terminado.',
    '- Hecho: lo terminado, con rutas de ficheros y hashes de commit cuando existan.',
    '- Decisiones: cada decisión tomada y por qué.',
    '- Pendiente: lo que falta, en orden.',
    '- Siguiente paso: una sola acción concreta y verificable.',
    '- Riesgos: lo que puede fallar o no está verificado.',
    'Incluye solo hechos que aparezcan en la conversación; si algo no consta, dilo.',
  ]
  return note ? [...lines, `Nota de la persona para el relevo: ${note}`].join('\n') : lines.join('\n')
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** `YYYY-MM-DD-HHMM` en hora local, para el nombre del fichero. */
export function stampOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

/** `YYYY-MM-DD HH:MM` en hora local, para la cabecera del relevo. */
export function humanStampOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** El documento que se guarda: cabecera con fecha y nota, y el cuerpo que escribió el modelo. */
export function documentOf(body: string, ms: number, note: string): string {
  const header = [`# Relevo ${humanStampOf(ms)}`, ...(note ? ['', `> ${note}`] : [])]
  return `${[...header, '', body.trim()].join('\n')}\n`
}

export const continuationPrompt = (relativePath: string): string =>
  `Retoma desde el relevo ${relativePath}: léelo y ejecuta el siguiente paso.`

/** Explica por qué el fork no devolvió texto. */
export function failureReason(result: { reason: string; status?: number | null }): string {
  if (result.reason === 'api-error') {
    const status = result.status ?? null
    return `error de la API${status === null ? '' : ` (HTTP ${status})`}`
  }
  if (result.reason === 'empty-reply') return 'el modelo respondió vacío'
  if (result.reason === 'aborted') return 'la llamada se canceló o superó el tiempo límite'
  if (result.reason === 'nothing-to-fork') return 'aún no hay conversación que resumir'
  return `motivo desconocido (${result.reason})`
}
