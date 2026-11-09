import type { AttachSource } from '../types'

const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i
const IGNORED_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store'])

export const SOURCES: Array<{ id: AttachSource; label: string; hotkey: string }> = [
  { id: 'proyecto', label: 'proyecto', hotkey: '1' },
  { id: 'sesion', label: 'esta sesión', hotkey: '2' },
  { id: 'capturas', label: 'capturas', hotkey: '3' },
  { id: 'descargas', label: 'descargas', hotkey: '4' },
  { id: 'escritorio', label: 'escritorio', hotkey: '5' },
]

/** Carpeta del perfil de cada origen de sistema. */
export const FOLDER_OF: Partial<Record<AttachSource, string>> = {
  capturas: 'Pictures/Screenshots',
  descargas: 'Downloads',
  escritorio: 'Desktop',
}

export const slash = (path: string): string => path.replace(/\\/g, '/')

export const isImage = (path: string): boolean => IMAGE.test(path)

export const isListable = (name: string): boolean => !IGNORED_NAMES.has(name.toLowerCase())

export const baseName = (path: string): string => {
  const clean = slash(path).replace(/\/+$/, '')
  return clean.slice(clean.lastIndexOf('/') + 1)
}

/** Ruta relativa al cwd si cuelga de él; si no, absoluta. Siempre con barras normales. */
export function displayPath(path: string, cwd: string): string {
  const clean = slash(path)
  const root = slash(cwd).replace(/\/+$/, '')
  if (root !== '' && clean.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return clean.slice(root.length + 1)
  }
  return clean
}

/** La mención que entiende Claude Code; entre comillas si la ruta lleva espacios. */
export function mentionOf(path: string, cwd: string): string {
  const shown = displayPath(path, cwd)
  return /\s/.test(shown) ? `@"${shown}"` : `@${shown}`
}

/**
 * Filtro difuso: todas las palabras de la búsqueda deben aparecer en la ruta.
 * Puntúa más las que caen en el nombre del fichero y las rutas cortas.
 */
export function rank(
  paths: readonly string[],
  query: string,
  limit: number,
): { paths: string[]; total: number } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { paths: paths.slice(0, limit), total: paths.length }
  const scored: Array<{ path: string; score: number }> = []
  for (const path of paths) {
    const lower = path.toLowerCase()
    if (!words.every((w) => lower.includes(w))) continue
    const name = baseName(lower)
    const inName = words.filter((w) => name.includes(w)).length
    const exact = words.some((w) => name.startsWith(w)) ? 2 : 0
    scored.push({ path, score: inName * 10 + exact * 5 - path.length / 20 })
  }
  const best = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.path)
  return { paths: best, total: scored.length }
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1).replace('.', ',')} MB`
}

export function fmtAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'ahora'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.floor(hours / 24)} d`
}

export const trunc = (text: string, max: number): string =>
  text.length <= max ? text : `…${text.slice(text.length - Math.max(1, max - 1))}`
