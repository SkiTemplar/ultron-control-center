/** Lógica pura de los atajos: detección de stack, comandos por acción y resumen de una ejecución. */

export type Action = 'compilar' | 'probar' | 'arrancar'

export type Stack = 'cargo' | 'uv' | 'npm' | 'cmake'

/** Lo que se ha leído de la raíz del proyecto; null = el fichero no existe. */
export type ProjectFiles = {
  hasCargo: boolean
  pyproject: string | null
  hasMainPy: boolean
  packageJson: string | null
  hasCmake: boolean
}

/** El comando de cada acción para el stack detectado; null = esa acción no aplica. */
export type Plan = { stack: Stack } & Record<Action, string | null>

/** Cómo terminó una ejecución, para el aviso y el contexto del modelo. */
export type RunOutcome = {
  action: Action
  cmd: string
  exitCode: number
  durationMs: number
  output: string
}

const CONTEXT_TAIL_LINES = 40

export const ACTIONS: readonly Action[] = ['compilar', 'probar', 'arrancar']

export const STATUS_LABEL: Record<Action, string> = {
  compilar: 'compilando…',
  probar: 'probando…',
  arrancar: 'en marcha',
}

/** Scripts de un package.json; vacío si no es JSON válido o no tiene `scripts`. */
export function packageScripts(text: string): Record<string, string> {
  try {
    const raw = JSON.parse(text) as { scripts?: unknown }
    if (typeof raw.scripts !== 'object' || raw.scripts === null) return {}
    const entries = Object.entries(raw.scripts as Record<string, unknown>).filter(
      (pair): pair is [string, string] => typeof pair[1] === 'string',
    )
    return Object.fromEntries(entries)
  } catch {
    return {}
  }
}

/** El primer script de `[project.scripts]` de un pyproject.toml, o null. */
export function firstProjectScript(toml: string): string | null {
  const lines = toml.replace(/\r/g, '').split('\n')
  const start = lines.findIndex((line) => line.trim() === '[project.scripts]')
  if (start < 0) return null
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) return null
    const match = /^["']?([A-Za-z0-9_.-]+)["']?\s*=/.exec(trimmed)
    if (match) return match[1] ?? null
  }
  return null
}

/** El script por defecto de npm (`echo "Error: no test specified" && exit 1`) no cuenta como suite. */
const isRealTestScript = (script: string | undefined): boolean =>
  script !== undefined && !script.includes('no test specified')

function npmPlan(text: string): Plan {
  const scripts = packageScripts(text)
  const runner = scripts.dev !== undefined ? 'npm run dev' : scripts.start !== undefined ? 'npm start' : null
  return {
    stack: 'npm',
    compilar: scripts.build !== undefined ? 'npm run build' : null,
    probar: isRealTestScript(scripts.test) ? 'npm test' : null,
    arrancar: runner,
  }
}

function uvPlan(toml: string, hasMainPy: boolean): Plan {
  const script = firstProjectScript(toml)
  const runner = script !== null ? `uv run ${script}` : hasMainPy ? 'uv run python main.py' : null
  return { stack: 'uv', compilar: 'uv run python -m compileall -q .', probar: 'uv run pytest', arrancar: runner }
}

/** Detecta el stack por orden de prioridad: cargo, uv, npm, cmake; null si no reconoce ninguno. */
export function detectPlan(files: ProjectFiles): Plan | null {
  if (files.hasCargo) return { stack: 'cargo', compilar: 'cargo build', probar: 'cargo test', arrancar: 'cargo run' }
  if (files.pyproject !== null) return uvPlan(files.pyproject, files.hasMainPy)
  if (files.packageJson !== null) return npmPlan(files.packageJson)
  if (files.hasCmake) {
    return { stack: 'cmake', compilar: 'cmake --build build', probar: 'ctest --test-dir build --output-on-failure', arrancar: null }
  }
  return null
}

/** argv para lanzar un comando por la shell del sistema (mismo patrón que el runner de tests). */
export const shellArgv = (cmd: string, isWindows: boolean): string[] =>
  isWindows ? ['cmd', '/d', '/s', '/c', cmd] : ['sh', '-c', cmd]

export const isWindowsPath = (path: string): boolean => /^[a-z]:[\\/]/i.test(path)

/** Las últimas `n` líneas útiles de una salida (sin retornos de carro ni líneas vacías del final). */
export const lastLines = (text: string, n: number): string =>
  text.replace(/\r/g, '').trimEnd().split('\n').slice(-n).join('\n')

/** «12,3 s» con coma decimal. */
export const formatSeconds = (ms: number): string => `${(ms / 1000).toFixed(1).replace('.', ',')} s`

/** Fallos que declara la salida (pytest, cargo, vitest, jest, ctest); null si no dice ninguno. */
export function failureCount(output: string): number | null {
  const counts = [...output.matchAll(/(\d+)\s+(?:tests?\s+)?failed/gi)].map((m) => Number(m[1]))
  const positive = counts.filter((n) => Number.isFinite(n) && n > 0)
  return positive.length > 0 ? Math.max(...positive) : null
}

const failureLabel = (outcome: RunOutcome): string => {
  const failures = failureCount(outcome.output)
  if (failures !== null) return `${failures} ${failures === 1 ? 'fallo' : 'fallos'}`
  return `código ${outcome.exitCode}`
}

/** El toast de fin: «✓ compilar 12,3 s» o «✗ probar: 3 fallos». */
export function outcomeToast(outcome: RunOutcome): string {
  if (outcome.exitCode === 0) return `✓ ${outcome.action} ${formatSeconds(outcome.durationMs)}`
  return `✗ ${outcome.action}: ${failureLabel(outcome)}`
}

/** Lo que lee el modelo con el siguiente prompt: una línea si fue bien, la cola de la salida si falló. */
export function outcomeContext(outcome: RunOutcome): string {
  const head = `[ultron-atajos] /${outcome.action}: «${outcome.cmd}»`
  if (outcome.exitCode === 0) return `${head} terminó bien en ${formatSeconds(outcome.durationMs)}.`
  const tail = lastLines(outcome.output, CONTEXT_TAIL_LINES)
  return `${head} falló (${failureLabel(outcome)}) en ${formatSeconds(outcome.durationMs)}. Últimas ${CONTEXT_TAIL_LINES} líneas:\n\`\`\`\n${tail}\n\`\`\``
}

/** Texto de la línea de estado para las acciones en marcha; undefined la limpia. */
export const statusLine = (running: readonly Action[]): string | undefined =>
  running.length === 0 ? undefined : ACTIONS.filter((a) => running.includes(a)).map((a) => STATUS_LABEL[a]).join(' · ')
