/**
 * Resúmenes cortos y legibles de una llamada a herramienta: el comando, el
 * fichero (por su nombre, sin la ruta) o el patrón que la identifica.
 * Módulo puro.
 */

export const MAX_SUMMARY = 160
/** Texto de `turnStart` y `prompt` (§6.3). */
export const MAX_PROMPT_TEXT = 2_000

/** Campos que identifican una llamada, por orden de preferencia. */
const KEY_FIELDS = ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill']
/** Campos que son rutas: se resumen por su `basename`. */
const PATH_FIELDS = new Set(['file_path', 'notebook_path', 'path'])

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

export const clip = (text: string, max: number = MAX_SUMMARY): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

/** Último segmento de una ruta Windows o POSIX; la propia ruta si no tiene. */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const name = cut < 0 ? trimmed : trimmed.slice(cut + 1)
  return name === '' ? path : name
}

function fieldOf(input: unknown, field: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const value = (input as Record<string, unknown>)[field]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Resumen de una línea de los argumentos de la herramienta (vacío si no hay nada útil). */
export function summarizeTool(tool: string, input: unknown): string {
  if (tool === 'AskUserQuestion') return 'Pregunta al usuario'
  if (tool === 'ExitPlanMode') return 'Plan para aprobar'
  const isSearch = tool === 'Grep' || tool === 'Glob'
  const pattern = isSearch ? fieldOf(input, 'pattern') : undefined
  if (pattern !== undefined) {
    const where = fieldOf(input, 'path')
    return clip(oneLine(where === undefined ? pattern : `${pattern} en ${basename(where)}`))
  }
  for (const field of KEY_FIELDS) {
    const value = fieldOf(input, field)
    if (value !== undefined) return clip(oneLine(PATH_FIELDS.has(field) ? basename(value) : value))
  }
  return ''
}

/** `timeout` declarado en la entrada (Bash: milisegundos), si es un número positivo. */
export function timeoutOf(input: unknown): number | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const value = (input as Record<string, unknown>).timeout
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Texto de la tarjeta de permiso: herramienta y resumen. */
export function permissionSummary(tool: string, input: unknown): string {
  const summary = summarizeTool(tool, input)
  return summary === '' ? tool : `${tool}: ${summary}`
}
