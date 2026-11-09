/**
 * Clasificación de comandos de shell (Bash y PowerShell) para la auto-aprobación.
 *
 * Un comando se aprueba solo si no contiene construcciones peligrosas y TODOS sus
 * segmentos (separados por `&&`, `||`, `;`, `|` o salto de línea) encajan en la
 * lista fija de prefijos seguros o en un prefijo aprendido. Ante la duda, no se
 * aprueba: el comando sigue al decisor del modo.
 */

/** Redirecciones inocuas que se eliminan antes de buscar `>` prohibidos. */
const HARMLESS_REDIRECTS = /\s*(?:2>&1|2>\s*\/dev\/null|2>\s*\$null|>\s*\/dev\/null)/g

/** Construcciones que descartan el comando entero, estén donde estén. */
const FORBIDDEN = [
  /\$\(/,
  /`/,
  /(^|[\s;&|])(sudo|rm|rmdir|del|Remove-Item|format|mkfs|dd)(\s|$)/i,
  />/,
]

const SEPARATORS = /&&|\|\||;|\||&|\r?\n/

/**
 * Caracteres admitidos en un segmento ya separado. Todo lo demás (`$`, `(`, `)`,
 * `{`, `}`, `<`, `!`, `%`, `^`…) abre expansión, subshell, redirección de entrada
 * o sintaxis de PowerShell/cmd que la lista de prefijos no puede razonar: el
 * segmento no se aprueba. Sin `*` ni `?`: un glob puede expandirse a un fichero
 * llamado `--ext-diff` y colar un flag vetado.
 */
const SEGMENT_CHARSET = /^[A-Za-z0-9 _\-./:=,@+'"~\\]+$/

/** Prefijos seguros de la lista fija: solo lectura, build y test. */
const SAFE_SEGMENTS: readonly RegExp[] = [
  /^git (status|diff|log|show|rev-parse|ls-files|blame|branch)\b/,
  /^git remote -v$/,
  /^git stash list\b/,
  /^(ls|cat|head|tail|wc|rg|grep|pwd|echo|which|where|cd)\b/,
  /^node (--version|-v)$/,
  /^cargo (check|test|build|clippy)\b/,
  /^cargo fmt\b.*--check\b/,
  /^uv run (pytest|mypy)\b/,
  /^uv run ruff check\b/,
  /^npm test\b/,
  /^npm run (build|test|lint|typecheck)\b/,
  /^cmake --build\b/,
  /^ctest\b/,
  /^claude plugin (validate|test)\b/,
  /^(Get-ChildItem|Get-Content|Select-String|Test-Path|Get-Location)\b/i,
]

/** Segmentos que parecen seguros pero escriben o borran: vetan la regla que los admitiría. */
const SEGMENT_VETOES: readonly RegExp[] = [
  // Flags que ejecutan un programa externo o escriben fichero en binarios de la
  // lista. Por PREFIJO, porque git acepta opciones largas abreviadas (`--outp=x`,
  // `--ext-d`); se comprueba sobre el segmento sin comillas (`"--ext-diff"`).
  /\s--(ext|out|textc|upl|rec|open|pre|exec)/,
  /\s-c(\s|=|$)/,
  // `git -c clave=valor …` o `git --exec-path=…` delante del subcomando.
  /^git\s+-/,
  /^uv run ruff\b.*(--fix|\bformat\b)/,
]

/**
 * Lista BLANCA de flags de git: en un segmento `git …` cada argumento que empiece
 * por `-` tiene que estar aquí. Una lista negra de flags peligrosos no se puede
 * cerrar (abreviaturas, comillas, escapes); esta sí. `git branch -d/-D/-m` queda
 * fuera por no estar en la lista.
 */
const GIT_FLAG_ALLOW =
  /^(-[0-9]+|-n|-p|-s|-b|-a|-r|-v|-vv|-u|-w|-U[0-9]+|--|--oneline|--stat|--shortstat|--numstat|--name-only|--name-status|--cached|--staged|--patch|--no-patch|--short|--branch|--porcelain(=v[12])?|--graph|--all|--decorate|--abbrev-commit|--abbrev-ref|--no-color|--color=never|--list|--show-current|--show-toplevel|--untracked-files(=(no|normal|all))?|--ignored|--follow|--reverse|--merges|--no-merges|--first-parent|--ignore-all-space|--word-diff|--format=.*|--pretty=.*|--since=.*|--until=.*|--author=.*|--grep=.*|--max-count=[0-9]+)$/

const GIT = /^git\s/

function hasOnlyAllowedGitFlags(unquoted: string): boolean {
  return unquoted
    .split(/\s+/)
    .filter((token) => token.startsWith('-'))
    .every((token) => GIT_FLAG_ALLOW.test(token))
}

/** Patrones que nunca se proponen como regla aprendida. */
const DANGEROUS_PATTERN =
  /(^|[\s(])(rm|rmdir|del|Remove-Item|curl|wget|Invoke-WebRequest|Invoke-RestMethod|format|sudo)(\s|:|\)|$)|git push|git reset --hard|git clean|(^|[\s(])(node|python3?|py|uv|npx|bash|sh|pwsh|powershell|cmd|deno|bun)\s+(run\s+)?(-e|-c|-p|--eval|-Command|\/c)(\s|:|$)/i

export function splitSegments(command: string): string[] {
  return command
    .replace(HARMLESS_REDIRECTS, '')
    .split(SEPARATORS)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')
}

export function hasForbiddenConstruct(command: string): boolean {
  const stripped = command.replace(HARMLESS_REDIRECTS, '')
  return FORBIDDEN.some((pattern) => pattern.test(stripped))
}

function isVetoed(segment: string): boolean {
  if (!SEGMENT_CHARSET.test(segment)) return true
  // Comillas y escapes no separan argumentos para el binario: `"--ext-diff"` y
  // `\--ext-diff` llegan como `--ext-diff`.
  const unquoted = segment.replace(/['"\\]/g, '')
  if (GIT.test(unquoted) && !hasOnlyAllowedGitFlags(unquoted)) return true
  return SEGMENT_VETOES.some((pattern) => pattern.test(unquoted))
}

/** El segmento encaja en la lista fija. */
export function isSafeSegment(segment: string): boolean {
  if (isVetoed(segment)) return false
  return SAFE_SEGMENTS.some((pattern) => pattern.test(segment))
}

/** El segmento empieza por un prefijo aprendido (`npm install` de `Bash(npm install:*)`). */
function matchesLearnedPrefix(segment: string, prefixes: readonly string[]): boolean {
  if (isVetoed(segment)) return false
  return prefixes.some((prefix) => segment === prefix || segment.startsWith(`${prefix} `))
}

/**
 * Decide si un comando completo puede aprobarse: sin construcciones prohibidas y
 * con cada segmento en la lista fija o en los prefijos aprendidos.
 */
export function isApprovableCommand(command: string, learnedPrefixes: readonly string[] = []): boolean {
  if (command.trim() === '' || hasForbiddenConstruct(command)) return false
  const segments = splitSegments(command)
  if (segments.length === 0) return false
  return segments.every((segment) => isSafeSegment(segment) || matchesLearnedPrefix(segment, learnedPrefixes))
}

/** Las dos primeras palabras del primer segmento: la base de `Bash(<prefijo>:*)`. */
export function commandPrefix(command: string): string | null {
  const first = splitSegments(command)[0]
  if (first === undefined) return null
  const words = first.split(/\s+/).slice(0, 2)
  return words.length === 0 ? null : words.join(' ')
}

export function isDangerousPattern(pattern: string): boolean {
  return DANGEROUS_PATTERN.test(pattern)
}
