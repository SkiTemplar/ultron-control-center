/**
 * Reglas de auto-aprobación: lista fija (lecturas, shell segura, ediciones dentro
 * del proyecto) más las reglas aprendidas, y el cálculo del patrón que se propone
 * cuando una llamada acaba en el diálogo de permisos.
 */
import { commandPrefix, isApprovableCommand, isDangerousPattern } from './shell'

export const READ_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'NotebookRead',
  'WebSearch',
  'ToolSearch',
  'LSP',
])
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell'])
export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const CODEGRAPH_PREFIX = 'mcp__codegraph__'
const MCP_PREFIX = 'mcp__'

/**
 * Herramientas MCP de solo lectura: las únicas cuya aprobación manual se cuenta
 * y se puede convertir en regla aprendida (seguridad MEDIUM de la auditoría
 * 2026-10-17). Antes, tres aprobaciones de `mcp__ultron-desktop__click` o de
 * una escritura en GitHub proponían «siempre permitir». Lista blanca por nombre
 * exacto: un servidor MCP nuevo o una herramienta que escribe, controla el
 * escritorio o el navegador (con las sesiones iniciadas de la persona) sigue
 * pasando por el diálogo cada vez.
 */
const READ_ONLY_MCP: ReadonlySet<string> = new Set([
  'mcp__ultron-memory__memory_stats',
  'mcp__ultron-memory__memory_provenance',
  'mcp__ultron-memory__curso_status',
  'mcp__ultron-desktop__list_windows',
  'mcp__ultron-desktop__cursor_position',
  'mcp__plugin_context7_context7__resolve-library-id',
  'mcp__plugin_context7_context7__query-docs',
  'mcp__plugin_context7_context7__get-library-docs',
  'mcp__research__research_search',
  'mcp__research__research_session_list',
  'mcp__research__research_check_retraction',
  'mcp__research__research_verify_citations',
  'mcp__tauri__read_logs',
  'mcp__tauri__list_devices',
  'mcp__tauri__get_setup_instructions',
  'mcp__tauri__webview_dom_snapshot',
  'mcp__tauri__webview_find_element',
  'mcp__tauri__webview_screenshot',
  'mcp__tauri__ipc_get_captured',
  'mcp__tauri__ipc_get_backend_state',
  ...[
    'get_commit',
    'get_file_contents',
    'get_label',
    'get_latest_release',
    'get_me',
    'get_release_by_tag',
    'get_tag',
    'get_team_members',
    'get_teams',
    'issue_read',
    'list_branches',
    'list_commits',
    'list_issue_fields',
    'list_issue_types',
    'list_issues',
    'list_pull_requests',
    'list_releases',
    'list_repository_collaborators',
    'list_tags',
    'pull_request_read',
    'search_code',
    'search_commits',
    'search_issues',
    'search_pull_requests',
    'search_repositories',
    'search_users',
  ].map((name) => `mcp__plugin_github_github__${name}`),
])

/**
 * Una herramienta (o un patrón: el de una herramienta sin argumentos es su
 * nombre) se puede aprender: no es MCP, o es un MCP de la lista blanca.
 */
export function isLearnableTool(tool: string): boolean {
  if (!tool.startsWith(MCP_PREFIX)) return true
  return READ_ONLY_MCP.has(tool)
}

/**
 * Ficheros de credenciales: ni se leen ni se editan sin diálogo, tampoco como
 * argumento de una shell «de solo lectura» (`Get-Content .env`). Misma familia
 * que `deny-secrets` (H23 de la auditoría 2026-10-17). Se comparan sobre la
 * ruta normalizada (minúsculas y `/`).
 */
const SENSITIVE_PATHS: readonly RegExp[] = [
  /(^|\/)\.env[^/]*$/,
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)id_(rsa|ed25519|dsa|ecdsa)[^/]*$/,
  /\.(pem|key|pfx|p12|jks|keystore)$/,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.?(secrets|credentials)\.json$/,
  /(^|\/)service-account[^/]*\.json$/,
  /(^|\/)(\.git-credentials|\.netrc|_netrc|\.npmrc|\.pypirc)$/,
  /(^|\/)(gh|github cli)\/hosts\.yml$/,
]

/**
 * Rutas que nunca se editan solas, aunque estén dentro del proyecto: además de
 * las credenciales, todo lo que da ejecución persistente o cambia las reglas
 * del propio agente (H28 de la auditoría 2026-10-17): settings y hooks de
 * Claude Code, servidores MCP del proyecto, hooks y mods de ULTRON, la pausa de
 * `deny-secrets`, el marcador del modo uni, perfiles de shell y la carpeta de
 * inicio de Windows.
 */
const PROTECTED_PATHS: readonly RegExp[] = [
  ...SENSITIVE_PATHS,
  /secrets/,
  /\/\.git(\/|$)/,
  /\/borrador(\/|$)/,
  /\/entrega(\/|$)/,
  /(^|\/)\.claude\/settings[^/]*\.json$/,
  /(^|\/)\.claude\.json$/,
  /(^|\/)\.claude\/(hooks|agents|commands|plugins|skills)(\/|$)/,
  /(^|\/)\.mcp\.json$/,
  /(^|\/)\.ultron\/(hooks|mods)(\/|$)/,
  // La statusline es el otro comando que `settings.json` ejecuta en cada sesión.
  /(^|\/)\.ultron\/cockpit\/statusline\.js$/,
  /(^|\/)\.ultron\/run\/deny-secrets-pausa\.json$/,
  /(^|\/)\.ultron-trabajo\.json$/,
  /(^|\/)[^/]*profile\.ps1$/,
  /(^|\/)\.(bashrc|bash_profile|profile|zshrc|zprofile|gitconfig)$/,
  /\/start menu\/programs\/startup(\/|$)/,
]

/** Recuento de aprobaciones manuales por patrón, en `$.store` (clave `approvals`). */
export type Approvals = Readonly<Record<string, { count: number; isNotified: boolean }>>

export const PROPOSAL_THRESHOLD = 3

export type Verdict = { isAllowed: true; rule: string } | { isAllowed: false }

const DENIED: Verdict = { isAllowed: false }

/**
 * Normaliza una ruta de Windows o POSIX para comparar: `/`, minúsculas, sin `/`
 * final y con `.` y `..` resueltos, para que `<root>/../otro` no pase por dentro.
 */
export function normalizePath(path: string): string {
  const parts: string[] = []
  for (const part of path.replace(/\\/g, '/').toLowerCase().split('/')) {
    if (part === '.' || (part === '' && parts.length > 0)) continue
    if (part === '..') {
      if (parts.length > 1) parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts.join('/')
}

export function isProtectedPath(path: string): boolean {
  const normalized = normalizePath(path)
  return PROTECTED_PATHS.some((pattern) => pattern.test(normalized))
}

export function isSensitivePath(path: string): boolean {
  const normalized = normalizePath(path)
  return SENSITIVE_PATHS.some((pattern) => pattern.test(normalized))
}

/** Separadores de argumentos en Bash y PowerShell, comillas incluidas. */
const SHELL_ARG_SPLIT = /[\s;|&<>()=,'"`{}]+/

/** Algún argumento del comando es un fichero de credenciales. */
export function hasSensitiveArgument(command: string): boolean {
  return command
    .split(SHELL_ARG_SPLIT)
    .filter((token) => token !== '')
    .some((token) => isSensitivePath(token.replace(/^\$/, '')))
}

/** Ruta que lee una herramienta de lectura (`file_path`, `notebook_path` o el `path` de Grep). */
function readPath(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const record = input as Record<string, unknown>
  const path = record.file_path ?? record.notebook_path ?? record.path
  return typeof path === 'string' && path !== '' ? path : null
}

function readGlob(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const glob = (input as Record<string, unknown>).glob
  return typeof glob === 'string' && glob !== '' ? glob : null
}

/** La lectura apunta a un fichero de credenciales (por ruta o por el glob de Grep). */
function readsSensitive(tool: string, input: unknown): boolean {
  if (tool === 'Glob') return false
  const path = readPath(input)
  const glob = readGlob(input)
  return (path !== null && isSensitivePath(path)) || (glob !== null && isSensitivePath(glob))
}

export function isInside(path: string, root: string): boolean {
  const target = normalizePath(path)
  const base = normalizePath(root)
  return base !== '' && target.startsWith(`${base}/`)
}

function parentDir(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const cut = normalized.lastIndexOf('/')
  return cut <= 0 ? normalized : normalized.slice(0, cut)
}

/** Lee la ruta de una herramienta de edición (`file_path`, o `notebook_path` en NotebookEdit). */
export function editPath(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const record = input as Record<string, unknown>
  const path = record.file_path ?? record.notebook_path
  return typeof path === 'string' && path !== '' ? path : null
}

export function shellCommand(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const command = (input as Record<string, unknown>).command
  return typeof command === 'string' ? command : null
}

/** Prefijos de las reglas `Bash(<prefijo>:*)` o `PowerShell(<prefijo>:*)` aprendidas para esa herramienta. */
function learnedPrefixes(tool: string, learned: readonly string[]): string[] {
  const head = `${tool}(`
  return learned
    .filter((rule) => rule.startsWith(head) && rule.endsWith(':*)'))
    .map((rule) => rule.slice(head.length, -3))
}

/** Directorios de las reglas `<Tool>(<dir>/**)` aprendidas para esa herramienta. */
function learnedDirs(tool: string, learned: readonly string[]): string[] {
  const head = `${tool}(`
  return learned
    .filter((rule) => rule.startsWith(head) && rule.endsWith('/**)'))
    .map((rule) => rule.slice(head.length, -4))
}

function checkShell(tool: string, input: unknown, learned: readonly string[]): Verdict {
  const command = shellCommand(input)
  if (command === null || hasSensitiveArgument(command)) return DENIED
  if (isApprovableCommand(command)) return { isAllowed: true, rule: 'shell de solo lectura o build/test' }
  if (isApprovableCommand(command, learnedPrefixes(tool, learned))) return { isAllowed: true, rule: 'regla aprendida' }
  return DENIED
}

/**
 * La raíz de la sesión es el directorio personal o uno de sus ancestros
 * (`C:\Users`, `C:\`): «dentro del proyecto» sería todo el perfil
 * (`~/.claude`, `~/.ssh`, el escritorio…), así que ahí solo valen las reglas
 * aprendidas (H28).
 */
function isHomeRoot(root: string, home: string): boolean {
  return home !== '' && (normalizePath(root) === normalizePath(home) || isInside(home, root))
}

function checkEdit(tool: string, input: unknown, root: string, learned: readonly string[], home: string): Verdict {
  const path = editPath(input)
  if (path === null || isProtectedPath(path)) return DENIED
  if (!isHomeRoot(root, home) && isInside(path, root)) return { isAllowed: true, rule: 'edición dentro del proyecto' }
  const dir = learnedDirs(tool, learned).find((one) => isInside(path, one))
  return dir === undefined ? DENIED : { isAllowed: true, rule: `regla aprendida ${tool}(${dir}/**)` }
}

/**
 * Veredicto de la lista fija y de las reglas aprendidas para una llamada.
 * `root` es la raíz del proyecto de la sesión y `home` el directorio personal
 * (vacío si no se conoce: entonces no se aplica la restricción del home).
 */
export function evaluate(
  tool: string,
  input: unknown,
  root: string,
  learned: readonly string[],
  home = '',
): Verdict {
  if (READ_TOOLS.has(tool) || tool.startsWith(CODEGRAPH_PREFIX)) {
    return readsSensitive(tool, input) ? DENIED : { isAllowed: true, rule: 'lectura' }
  }
  if (SHELL_TOOLS.has(tool)) return checkShell(tool, input, learned)
  if (EDIT_TOOLS.has(tool)) return checkEdit(tool, input, root, learned, home)
  if (learned.includes(tool) && isLearnableTool(tool)) return { isAllowed: true, rule: `regla aprendida ${tool}` }
  return DENIED
}

/**
 * Modos en los que el mod no toca el veredicto (H29): en `plan` no se edita ni
 * se ejecuta nada sin que la persona lo apruebe, y en `dontAsk` lo que no está
 * permitido de antemano se rechaza; auto-aprobar ahí rompería el modo.
 */
const HANDS_OFF_MODES: ReadonlySet<string> = new Set(['plan', 'dontAsk'])

export function isHandsOffMode(mode: string | null): boolean {
  return mode !== null && HANDS_OFF_MODES.has(mode)
}

/**
 * El patrón que se contaría si la persona aprueba esta llamada a mano, o null si
 * no se debe proponer nunca (peligroso, ruta protegida o sin datos).
 */
export function patternFor(tool: string, input: unknown): string | null {
  const pattern = rawPattern(tool, input)
  return pattern === null || isDangerousPattern(pattern) ? null : pattern
}

function rawPattern(tool: string, input: unknown): string | null {
  if (SHELL_TOOLS.has(tool)) {
    const command = shellCommand(input)
    if (command !== null && hasSensitiveArgument(command)) return null
    const prefix = command === null ? null : commandPrefix(command)
    return prefix === null ? null : `${tool}(${prefix}:*)`
  }
  if (EDIT_TOOLS.has(tool)) {
    const path = editPath(input)
    if (path === null || isProtectedPath(path)) return null
    return `${tool}(${parentDir(path)}/**)`
  }
  if (READ_TOOLS.has(tool) && readsSensitive(tool, input)) return null
  return isLearnableTool(tool) ? tool : null
}

/** Suma una aprobación al patrón y dice si acaba de alcanzar el umbral sin avisar todavía. */
export function recordApproval(approvals: Approvals, pattern: string): { approvals: Approvals; shouldNotify: boolean } {
  const previous = approvals[pattern] ?? { count: 0, isNotified: false }
  const count = previous.count + 1
  const shouldNotify = count >= PROPOSAL_THRESHOLD && !previous.isNotified
  const entry = { count, isNotified: previous.isNotified || shouldNotify }
  return { approvals: { ...approvals, [pattern]: entry }, shouldNotify }
}

/**
 * Propuestas pendientes: patrones en el umbral que aún no son reglas aprendidas,
 * en orden estable. Los recuentos guardados antes de la lista blanca de MCP no
 * se ofrecen si el patrón ya no es aprendible.
 */
export function proposals(approvals: Approvals, learned: readonly string[]): string[] {
  return Object.keys(approvals)
    .filter((pattern) => (approvals[pattern]?.count ?? 0) >= PROPOSAL_THRESHOLD && !learned.includes(pattern))
    .filter(isLearnableTool)
    .sort()
}
