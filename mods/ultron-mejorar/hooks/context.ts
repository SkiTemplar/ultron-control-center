/** Funciones puras de /mejorar: contexto del proyecto, prompt al modelo y motivos de fallo. */

export const MAX_STATUS_LINES = 15
export const MAX_ERROR_CHARS = 300

export type PromptContext = {
  cwd: string
  project: string | null
  repo: string | null
  branch: string | null
  status: string | null
  lastError: string | null
}

/**
 * Reglas del editor de prompts. Fuente única: `/mejorar` de ULTRON Sessions
 * (control-center/src-tauri/src/sesiones/mejorar.rs) las lee de aquí al
 * compilar. Mantener la forma: una línea por regla, literal con comilla simple
 * y sin escapes; si cambia, el test `las_reglas_salen_del_mod` falla.
 */
export const SYSTEM = [
  'Eres un editor de prompts para Claude Code. Reescribe el borrador que te dan para que el agente lo ejecute mejor.',
  'Reglas:',
  '- Escribe en español, en registro técnico y con ortografía completa.',
  '- Conserva la intención exacta del borrador: no añadas tareas ni cambies el alcance.',
  '- Añade solo hechos que aparezcan en el contexto dado; no inventes ficheros, rutas, funciones ni errores.',
  '- Explicita el objetivo, un criterio de aceptación verificable y las restricciones relevantes.',
  '- Sé breve: un párrafo o una lista corta.',
  '- Sin preámbulo ni comentarios: devuelve SOLO el prompt reescrito.',
].join('\n')

const normalize = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** Resume `git status --porcelain`: como mucho MAX_STATUS_LINES líneas y el resto contado. */
export function summarizeStatus(porcelain: string): string | null {
  const lines = porcelain.split('\n').map((line) => line.trimEnd()).filter((line) => line.length > 0)
  if (lines.length === 0) return null
  const shown = lines.slice(0, MAX_STATUS_LINES)
  const rest = lines.length - shown.length
  return rest > 0 ? [...shown, `… y ${rest} más`].join('\n') : shown.join('\n')
}

type ProjectEntry = { name?: unknown; path?: unknown }

/** Nombre del proyecto ULTRON cuyo path contiene el cwd (el más específico), o null. */
export function projectNameFor(projectsJson: string, cwd: string): string | null {
  const parsed = JSON.parse(projectsJson) as { projects?: unknown }
  if (!Array.isArray(parsed.projects)) return null
  const target = normalize(cwd)
  let best: { name: string; length: number } | null = null
  for (const entry of parsed.projects as ProjectEntry[]) {
    if (typeof entry.name !== 'string' || typeof entry.path !== 'string') continue
    const root = normalize(entry.path)
    const isInside = target === root || target.startsWith(`${root}/`)
    if (isInside && (best === null || root.length > best.length)) best = { name: entry.name, length: root.length }
  }
  return best?.name ?? null
}

/** Recorta la salida de un error de herramienta a MAX_ERROR_CHARS caracteres. */
export const clipError = (text: string): string => text.trim().slice(0, MAX_ERROR_CHARS)

/** El mensaje de usuario que recibe el modelo: contexto disponible y borrador. */
export function buildPrompt(draft: string, ctx: PromptContext): string {
  const facts = [
    `Directorio de trabajo: ${ctx.cwd}`,
    ctx.project ? `Proyecto ULTRON: ${ctx.project}` : null,
    ctx.repo ? `Repositorio: ${ctx.repo}` : null,
    ctx.branch ? `Rama: ${ctx.branch}` : null,
    ctx.status ? `Cambios sin commitear (git status --porcelain):\n${ctx.status}` : null,
    ctx.lastError ? `Último error de herramienta:\n${ctx.lastError}` : null,
  ].filter((line): line is string => line !== null)
  return ['<contexto>', ...facts, '</contexto>', '', '<borrador>', draft, '</borrador>'].join('\n')
}

type FailedCompletion =
  | { reason: 'api-error'; status: number | null }
  | { reason: 'empty-reply' }
  | { reason: 'aborted' }
  | { reason: string }

/** Explica por qué el modelo no devolvió texto. */
export function failureReason(result: FailedCompletion): string {
  if (result.reason === 'api-error') {
    const status = 'status' in result ? result.status : null
    return `error de la API${status === null ? '' : ` (HTTP ${status})`}`
  }
  if (result.reason === 'empty-reply') return 'el modelo respondió vacío'
  if (result.reason === 'aborted') return 'la llamada se canceló o superó el tiempo límite'
  return `motivo desconocido (${result.reason})`
}
