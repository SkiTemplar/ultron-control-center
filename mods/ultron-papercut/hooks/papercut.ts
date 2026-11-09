/** Lógica pura de /papercut: parseo de argumentos, formato de la línea y proyecto del cwd. */

export const USAGE = [
  'Uso: /papercut síntoma · arreglo',
  'Añade a ~/.ultron/papercuts.md la línea `- AAAA-MM-DD · síntoma · arreglo · proyecto`.',
  'El proyecto sale del cwd (id de ULTRON o nombre de la carpeta); para forzarlo: /papercut síntoma · arreglo · proyecto',
].join('\n')

export type PapercutArgs = { symptom: string; fix: string; project: string | null }

/** Una sola línea: sin saltos ni espacios repetidos (el fichero es una línea por papercut). */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * Separa `síntoma · arreglo [· proyecto]`. Devuelve el error que se enseña al usuario
 * si falta alguna parte o sobran separadores.
 */
export function parseArgs(raw: string): PapercutArgs | { error: string } {
  const parts = raw.split('·').map(oneLine)
  if (parts.length < 2 || parts.some((p) => p === '')) {
    return { error: raw.trim() === '' ? USAGE : `Falta el síntoma o el arreglo.\n${USAGE}` }
  }
  if (parts.length > 3) return { error: `Sobran separadores «·»: usa uno entre síntoma y arreglo.\n${USAGE}` }
  return { symptom: parts[0]!, fix: parts[1]!, project: parts[2] ?? null }
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Fecha local `AAAA-MM-DD` del instante dado. */
export const localDate = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const formatLine = (date: string, args: PapercutArgs, project: string): string =>
  `- ${date} · ${args.symptom} · ${args.fix} · ${project}`

/** Añade la línea respetando el fin de línea del fichero y dejando un salto final. */
export function appendLine(text: string, line: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const base = text === '' || text.endsWith('\n') ? text : `${text}${eol}`
  return `${base}${line}${eol}`
}

/** Ruta comparable: barras normales, sin barra final, en minúsculas (Windows no distingue). */
export const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

export const folderName = (cwd: string): string => cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || cwd

type ProjectEntry = { id?: unknown; path?: unknown }

/**
 * Id del proyecto de ULTRON cuyo `path` contiene el cwd (el más profundo gana);
 * null si ninguno lo contiene. Lanza si el JSON no tiene la forma esperada.
 */
export function projectIdFor(projectsJson: string, cwd: string): string | null {
  const parsed = JSON.parse(projectsJson) as { projects?: unknown }
  if (!Array.isArray(parsed.projects)) throw new Error('projects.json no tiene la lista `projects`')
  const here = normPath(cwd)
  let best: { id: string; depth: number } | null = null
  for (const entry of parsed.projects as ProjectEntry[]) {
    if (typeof entry.id !== 'string' || typeof entry.path !== 'string') continue
    const root = normPath(entry.path)
    const isInside = here === root || here.startsWith(`${root}/`)
    if (isInside && (best === null || root.length > best.depth)) best = { id: entry.id, depth: root.length }
  }
  return best?.id ?? null
}
