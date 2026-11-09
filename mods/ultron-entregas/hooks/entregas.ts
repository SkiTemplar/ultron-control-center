/** Lógica pura de ultron-entregas: raíces, marcadores `.ultron-trabajo.json`, fechas y textos. */

export const MARKER = '.ultron-trabajo.json'
export const SOON_DAYS = 14

/** Carpetas que nunca contienen un trabajo y pueden ser enormes. */
const SKIPPED_DIRS = new Set([
  'node_modules', 'vcpkg_installed', 'build', 'target', 'dist', 'out', 'venv', '__pycache__',
  'Library', 'Intermediate', 'Saved', 'Binaries', 'DerivedDataCache',
])

export const isSkippedDir = (name: string): boolean => name.startsWith('.') || SKIPPED_DIRS.has(name)

/** Ruta con barras normales y sin barra final. */
export const slash = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')

/** Raíces de tipo `asignatura` de project-roots.json (el config de project-create.mjs). */
export function parseSubjectRoots(json: string): string[] {
  const parsed = JSON.parse(json) as { roots?: unknown }
  if (!Array.isArray(parsed.roots)) throw new Error('project-roots.json no tiene la lista `roots`')
  return (parsed.roots as Array<{ kind?: unknown; path?: unknown }>)
    .filter((r) => r.kind === 'asignatura' && typeof r.path === 'string' && r.path !== '')
    .map((r) => slash(r.path as string))
}

export type Subject = { root: string; dir: string; name: string }

/** Asignatura que contiene el cwd: la primera carpeta bajo una raíz de asignaturas. */
export function subjectOf(cwd: string, roots: readonly string[]): Subject | null {
  const here = slash(cwd)
  for (const root of roots) {
    if (!here.toLowerCase().startsWith(`${root.toLowerCase()}/`)) continue
    const name = here.slice(root.length + 1).split('/')[0]
    if (name) return { root, dir: `${root}/${name}`, name }
  }
  return null
}

export type Trabajo = { dir: string; title: string; subject: string; due: string | null }

const DUE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Días UTC del calendario de una fecha `AAAA-MM-DD`; null si no es una fecha real. */
function dayNumber(date: string): number | null {
  const m = DUE_RE.exec(date)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const ms = Date.UTC(y, mo - 1, d)
  const back = new Date(ms)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return ms / 86_400_000
}

/** Días que faltan desde hoy (fecha local de `nowMs`) hasta `due`; negativo si ya pasó. */
export function daysUntil(due: string, nowMs: number): number {
  const target = dayNumber(due)
  if (target === null) throw new Error(`fecha inválida: ${due}`)
  const now = new Date(nowMs)
  return target - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000
}

const folderOf = (dir: string): string => slash(dir).split('/').pop() || dir

/**
 * Lee un marcador. El creador escribe `version`, `tipo`, `protegidas`, `asignatura` y `creado`;
 * la fecha de entrega va en `due` (`AAAA-MM-DD`, como el flag `--due`) y el título en `titulo`
 * si lo hay (si no, el nombre de la carpeta).
 */
export function parseMarker(text: string, dir: string, fallbackSubject: string): Trabajo | { error: string } {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    return { error: 'JSON inválido' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { error: 'no es un objeto JSON' }
  const due = typeof parsed.due === 'string' && parsed.due.trim() !== '' ? parsed.due.trim() : null
  if (due !== null && dayNumber(due) === null) return { error: `«due» no es una fecha AAAA-MM-DD válida: ${due}` }
  const title = typeof parsed.titulo === 'string' && parsed.titulo.trim() !== '' ? parsed.titulo.trim() : folderOf(dir)
  const subject = typeof parsed.asignatura === 'string' && parsed.asignatura !== '' ? parsed.asignatura : fallbackSubject
  return { dir: slash(dir), title, subject, due }
}

/** Asignatura por la carpeta: la primera bajo la raíz que contiene `dir`. */
export const subjectFromDir = (dir: string, roots: readonly string[]): string => subjectOf(dir, roots)?.name ?? folderOf(dir)

export const remaining = (days: number): string => {
  if (days === 0) return 'es hoy'
  if (days === 1) return 'falta 1 día'
  return `faltan ${days} días`
}

export type Dated = Trabajo & { due: string; days: number }

/** Separa las entregas con fecha (pendientes y vencidas) de las que no tienen. */
export function classify(trabajos: readonly Trabajo[], nowMs: number): { pending: Dated[]; overdue: number; undated: Trabajo[] } {
  const dated = trabajos
    .filter((t): t is Trabajo & { due: string } => t.due !== null)
    .map((t) => ({ ...t, days: daysUntil(t.due, nowMs) }))
    .sort((a, b) => a.days - b.days || a.title.localeCompare(b.title))
  return {
    pending: dated.filter((t) => t.days >= 0),
    overdue: dated.filter((t) => t.days < 0).length,
    undated: trabajos.filter((t) => t.due === null),
  }
}

const datedLine = (t: Dated): string => `- [${t.subject}] ${t.title} · ${t.due} · ${remaining(t.days)}`

const problemLines = (problems: readonly string[]): string[] => (problems.length === 0 ? [] : ['Avisos:', ...problems.map((p) => `- ${p}`)])

/** Aviso de arranque: entregas de la asignatura en los próximos días; null si no hay ni problemas. */
export function formatSoon(subject: Subject, trabajos: readonly Trabajo[], problems: readonly string[], nowMs: number): string | null {
  const soon = classify(trabajos, nowMs).pending.filter((t) => t.days <= SOON_DAYS)
  if (soon.length === 0 && problems.length === 0) return null
  const head = soon.length === 0 ? [] : [`Entregas de ${subject.name} en los próximos ${SOON_DAYS} días:`, ...soon.map(datedLine)]
  return [...head, ...problemLines(problems)].join('\n')
}

/** Listado de /entregas: pendientes por fecha, sin fecha y avisos de la búsqueda. */
export function formatAll(roots: readonly string[], trabajos: readonly Trabajo[], problems: readonly string[], nowMs: number): string {
  const { pending, overdue, undated } = classify(trabajos, nowMs)
  const lines =
    pending.length === 0
      ? [`No hay entregas pendientes con fecha bajo ${roots.join(', ')}.`]
      : [`Entregas pendientes (${pending.length}):`, ...pending.map(datedLine)]
  if (undated.length > 0) {
    lines.push(`Sin fecha (añade "due": "AAAA-MM-DD" a su ${MARKER}):`, ...undated.map((t) => `- [${t.subject}] ${t.title} · ${t.dir}`))
  }
  if (overdue > 0) lines.push(overdue === 1 ? '1 entrega ya vencida no se lista.' : `${overdue} entregas ya vencidas no se listan.`)
  return [...lines, ...problemLines(problems)].join('\n')
}
