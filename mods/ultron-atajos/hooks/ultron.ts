/** El comando de tests que ya resolvió run-project-tests de ULTRON para el proyecto del cwd. */

export type UltronTests = {
  project: string
  /** Raíz del proyecto: el comando se lanza desde aquí. */
  cwd: string
  cmd: string
}

/** Ruta comparable en Windows y en POSIX: barras normales, sin barra final, en minúsculas. */
export const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

const isInside = (cwd: string, root: string): boolean => cwd === root || cwd.startsWith(`${root}/`)

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Lee proyecto, cwd y cmd de un `*.result.json`; null si no es JSON o le falta alguno. */
export function parseUltronTests(text: string): UltronTests | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    const parsed = { project: str(raw.project), cwd: str(raw.cwd), cmd: str(raw.cmd) }
    return parsed.project !== '' && parsed.cwd !== '' && parsed.cmd !== '' ? parsed : null
  } catch {
    return null
  }
}

/** El del proyecto que contiene el cwd (la raíz más larga gana). */
export function pickForCwd(results: readonly UltronTests[], cwd: string): UltronTests | null {
  const here = normPath(cwd)
  const matches = results.filter((r) => isInside(here, normPath(r.cwd)))
  return [...matches].sort((a, b) => normPath(b.cwd).length - normPath(a.cwd).length)[0] ?? null
}
