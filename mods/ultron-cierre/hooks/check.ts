/** Lógica pura del cierre de turno: resultados de run-project-tests, git status y el aviso final. */

/** Último resultado de la suite, tal como lo deja run-project-tests en `.tmp/run-tests/<proyecto>.result.json`. */
export type TestsResult = {
  project: string
  cwd: string
  /** `passed`, `failed`, `timeout` u otro estado del runner. */
  status: string
  failedTests: string[]
  failedTotal: number
  summary: string
}

/** Lo que se ha podido comprobar al cerrar el turno; null en un campo = esa comprobación se omitió. */
export type ClosingFacts = {
  /** Resultado de tests del proyecto del cwd, o null si no hay o no se pudo leer. */
  tests: TestsResult | null
  /** Ficheros sin commitear según `git status --porcelain`, o null si git falló. */
  dirtyCount: number | null
}

export type ClosingNotice = {
  toast: string
  suggestion: string
}

const MAX_NAMED_TESTS = 3

/** Ruta comparable en Windows y en POSIX: barras normales, sin barra final, en minúsculas. */
export const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

const isInside = (cwd: string, root: string): boolean => cwd === root || cwd.startsWith(`${root}/`)

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Normaliza un `*.result.json`; null si no es JSON válido o le falta la forma mínima (proyecto, cwd, estado). */
export function parseResult(text: string): TestsResult | null {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
  if (str(raw.project) === '' || str(raw.cwd) === '' || str(raw.status) === '') return null
  const failed = Array.isArray(raw.failed_tests) ? raw.failed_tests.filter((t): t is string => typeof t === 'string') : []
  return {
    project: str(raw.project),
    cwd: str(raw.cwd),
    status: str(raw.status),
    failedTests: failed,
    failedTotal: num(raw.failed_total) ?? failed.length,
    summary: str(raw.summary),
  }
}

/** El resultado del proyecto que contiene el cwd de la sesión (la raíz más larga gana). */
export function pickForCwd(results: readonly TestsResult[], cwd: string): TestsResult | null {
  const here = normPath(cwd)
  const matches = results.filter((r) => isInside(here, normPath(r.cwd)))
  return [...matches].sort((a, b) => normPath(b.cwd).length - normPath(a.cwd).length)[0] ?? null
}

/** Lock del runner: hay ejecución si `running` tiene `started_at` de hace menos de `staleMs`. */
export function isRunnerBusy(stateText: string, now: number, staleMs: number): boolean {
  try {
    const state = JSON.parse(stateText) as { running?: { started_at?: string } | null }
    const startedAt = Date.parse(state.running?.started_at ?? '')
    return Number.isFinite(startedAt) && now - startedAt < staleMs
  } catch {
    return false
  }
}

/** Número de entradas de `git status --porcelain` (una por línea no vacía). */
export const countPorcelain = (stdout: string): number =>
  stdout.replace(/\r/g, '').split('\n').filter((line) => line.trim() !== '').length

const isRed = (tests: TestsResult | null): tests is TestsResult => tests !== null && tests.status !== 'passed'

/** «3 fallos», «1 fallo» o el estado del runner (`timeout`, `error`) cuando no hay recuento. */
function failureLabel(tests: TestsResult): string {
  if (tests.status === 'failed' && tests.failedTotal > 0) return `${tests.failedTotal} ${tests.failedTotal === 1 ? 'fallo' : 'fallos'}`
  return tests.status
}

/** Resumen para el prompt sugerido: los primeros tests caídos, o el resumen del runner. */
function failureDetail(tests: TestsResult): string {
  if (tests.failedTests.length > 0) {
    const named = tests.failedTests.slice(0, MAX_NAMED_TESTS).join(', ')
    const rest = tests.failedTests.length - MAX_NAMED_TESTS
    return rest > 0 ? `${named} y ${rest} más` : named
  }
  return tests.summary !== '' ? tests.summary : failureLabel(tests)
}

/** El aviso de cierre, o null si no queda nada pendiente. */
export function closingNotice(facts: ClosingFacts): ClosingNotice | null {
  const parts: string[] = []
  if (isRed(facts.tests)) parts.push(`tests ✗ ${failureLabel(facts.tests)}`)
  const dirty = facts.dirtyCount ?? 0
  if (dirty > 0) parts.push(`${dirty} ${dirty === 1 ? 'fichero' : 'ficheros'} sin commitear`)
  if (parts.length === 0) return null
  const suggestion = isRed(facts.tests)
    ? `Arregla los tests en rojo (${failureDetail(facts.tests)}) antes de seguir.`
    : 'Haz commit de los cambios con conventional commits.'
  return { toast: `Cierre: ${parts.join(' · ')}`, suggestion }
}
