import type { EngineInterface, Register } from 'claude-code'

import { MARKER, formatAll, formatSoon, isSkippedDir, parseMarker, parseSubjectRoots, slash, subjectFromDir, subjectOf } from './entregas'
import type { Trabajo } from './entregas'

const SEARCH_BUDGET_MS = 5_000
/** Profundidad máxima de carpetas bajo la raíz de asignaturas (raíz/asignatura/…/trabajo). */
const MAX_DEPTH = 4
/** Carpetas listadas a la vez. */
const BATCH = 16
const SOON_ARGS = new Set(['próximas', 'proximas'])
const USAGE = 'Uso: /entregas (todas las pendientes) o /entregas próximas (las de la asignatura del cwd en 14 días).'

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200)

type Scan = { trabajos: Trabajo[]; problems: string[] }

/** Raíces de asignaturas del config de project-create.mjs (con su override para tests). */
async function subjectRoots($: EngineInterface): Promise<string[]> {
  const override = await $.env.get('ULTRON_PROJECT_ROOTS_OVERRIDE')
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  if (!override && !home) throw new Error('no están definidas USERPROFILE ni HOME')
  const file = override || `${slash(home!)}/.ultron/cockpit/project-roots.json`
  return parseSubjectRoots(await $.fs.read(file))
}

/** Lista un nivel de carpetas; devuelve los marcadores y las subcarpetas del siguiente nivel. */
async function listLevel($: EngineInterface, dirs: readonly string[], isLast: boolean, problems: string[]): Promise<{ markers: string[]; next: string[] }> {
  const listed = await Promise.all(
    dirs.map((dir) => $.fs.list(dir).then((entries) => ({ dir, entries }), (err: unknown) => ({ dir, error: reasonOf(err) }))),
  )
  const markers: string[] = []
  const next: string[] = []
  for (const item of listed) {
    if ('error' in item) {
      problems.push(`no se pudo leer ${item.dir}: ${item.error}`)
      continue
    }
    if (item.entries.some((e) => e.kind === 'file' && e.name === MARKER)) markers.push(item.dir)
    if (!isLast) next.push(...item.entries.filter((e) => e.kind === 'dir' && !isSkippedDir(e.name)).map((e) => `${item.dir}/${e.name}`))
  }
  return { markers, next }
}

/** Busca marcadores por niveles bajo `base` (a `depth` de la raíz), con tope de tiempo. */
async function findMarkers($: EngineInterface, base: string, depth: number, problems: string[]): Promise<string[]> {
  const deadline = (await $.clock.now()) + SEARCH_BUDGET_MS
  const markers: string[] = []
  let level = [base]
  for (let d = depth; d <= MAX_DEPTH && level.length > 0; d += 1) {
    const next: string[] = []
    for (let i = 0; i < level.length; i += BATCH) {
      if ((await $.clock.now()) > deadline) {
        problems.push(`búsqueda cortada a los ${SEARCH_BUDGET_MS / 1000} s: puede faltar alguna entrega.`)
        return markers
      }
      const found = await listLevel($, level.slice(i, i + BATCH), d === MAX_DEPTH, problems)
      markers.push(...found.markers)
      next.push(...found.next)
    }
    level = next
  }
  return markers
}

/** Lee los marcadores encontrados; los ilegibles van a la lista de problemas, no se callan. */
async function scan($: EngineInterface, base: string, depth: number, roots: readonly string[]): Promise<Scan> {
  const problems: string[] = []
  const dirs = await findMarkers($, base, depth, problems)
  const trabajos: Trabajo[] = []
  for (const dir of dirs) {
    try {
      const parsed = parseMarker(await $.fs.read(`${dir}/${MARKER}`), dir, subjectFromDir(dir, roots))
      if ('error' in parsed) problems.push(`${dir}/${MARKER}: ${parsed.error}`)
      else trabajos.push(parsed)
    } catch (err) {
      problems.push(`${dir}/${MARKER}: ${reasonOf(err)}`)
    }
  }
  return { trabajos, problems }
}

/** Aviso de las entregas próximas de la asignatura del cwd; null si no está bajo una o no hay nada. */
async function soonText($: EngineInterface): Promise<string | null> {
  const roots = await subjectRoots($)
  const subject = subjectOf(await $.session.cwd(), roots)
  if (subject === null) return null
  const { trabajos, problems } = await scan($, subject.dir, 1, roots)
  return formatSoon(subject, trabajos, problems, await $.clock.now())
}

async function allText($: EngineInterface): Promise<string> {
  const roots = await subjectRoots($)
  if (roots.length === 0) return 'No hay raíces de tipo asignatura en project-roots.json.'
  const scans = await Promise.all(roots.map((root) => scan($, root, 0, roots)))
  const trabajos = scans.flatMap((s) => s.trabajos)
  const problems = scans.flatMap((s) => s.problems)
  return formatAll(roots, trabajos, problems, await $.clock.now())
}

async function commandText($: EngineInterface, args: string): Promise<string> {
  const mode = args.trim().toLowerCase()
  try {
    if (mode === '') return await allText($)
    if (!SOON_ARGS.has(mode)) return USAGE
    return (await soonText($)) ?? 'Sin entregas en los próximos 14 días (o el cwd no está bajo una asignatura).'
  } catch (err) {
    return `No se pudieron leer las entregas: ${reasonOf(err)}`
  }
}

/** Al arrancar, una línea en el transcript. Dentro de ULTRON Sessions no se lanza ningún comando:
 * competiría con la cola de la app; el listado sigue en `/entregas próximas`. */
async function announce($: EngineInterface): Promise<void> {
  let text: string | null
  try {
    text = await soonText($)
  } catch (err) {
    text = `No se pudieron revisar las entregas: ${reasonOf(err)}`
  }
  if (text === null) return
  $.ui.log(text)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'entregas',
      description: 'Entregas pendientes de las asignaturas (.ultron-trabajo.json)',
      argumentHint: '[próximas]',
      immediate: true,
    })
    // En segundo plano: el arranque no espera a la búsqueda.
    $.clock.after(0, () => void announce($))
    return next(e)
  })

  on('command.run', { command: 'entregas' }, async ($, e) => ({ text: await commandText($, e.args) }))
}
