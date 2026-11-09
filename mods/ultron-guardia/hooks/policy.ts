/**
 * Política de encargos a subagentes (reglas de ~/.claude/rules/common/core.md):
 * qué especialista sustituye a general-purpose y qué cláusulas le faltan a un
 * encargo de general-purpose o Explore. Funciones puras: el registro decide.
 */

/** Tipos que no tienen fichero en ~/.claude/agents/ porque los trae el harness. */
export const BUILTIN_AGENTS: ReadonlySet<string> = new Set(['Explore', 'Plan'])

export type Specialist = { agent: string; reason: string; patterns: readonly RegExp[] }

/**
 * Especialistas por orden de prioridad. Solo frases o palabras completas con
 * contexto: los substrings cortos rompieron el enrutado en el pasado.
 */
export const SPECIALISTS: readonly Specialist[] = [
  {
    agent: 'doc-summarizer',
    reason: 'resumir o clasificar textos y papers',
    patterns: [
      /\bresum(e|ir|en|eme)\b[^.\n]{0,40}\b(papers?|art[ií]culos?|documentos?|pdfs?|textos?|transcripci[oó]n|notas)\b/i,
      /\bsummari[sz]e\b[^.\n]{0,40}\b(papers?|articles?|documents?|pdfs?|notes)\b/i,
      /\bclasifica(r)?\b[^.\n]{0,40}(?<!\p{L})(textos?|[ií]tems|documentos?|notas)(?!\p{L})/iu,
    ],
  },
  {
    agent: 'code-reviewer',
    reason: 'revisar código',
    patterns: [
      /\b(revisa|revisar|revisi[oó]n de|audita|auditar)\b[^.\n]{0,30}\b(c[oó]digo|diff|cambios|pr|pull request)\b/i,
      /\bcode review\b/i,
      /\breview (the|this|my) (code|diff|changes|pr)\b/i,
    ],
  },
  {
    agent: 'technical-artist',
    reason: 'assets, Blender, texturas o audio',
    patterns: [/\bblender\b/i, /\b(assets? 3d|modelos? 3d|texturas|efectos de sonido|sfx|low-poly)\b/i],
  },
  {
    agent: 'game-designer',
    reason: 'diseño de juego',
    patterns: [/\b(gdd|biblia de dise[nñ]o|game design document|mec[aá]nicas de juego|curva de progresi[oó]n)\b/i],
  },
  { agent: 'unreal-engine-engineer', reason: 'Unreal Engine', patterns: [/\b(unreal engine|ue5|unreal)\b/i] },
  { agent: 'unity-engineer', reason: 'Unity', patterns: [/\bunity\b/i] },
  {
    agent: 'devops-engineer',
    reason: 'PRs y CI',
    patterns: [/\b(ci\/cd|github actions|gitlab ci|pipeline de ci|ci pipeline|pull request|(abre|crea|abrir|crear) (una|la) pr)\b/i],
  },
  {
    agent: 'Explore',
    reason: 'búsquedas y barridos de lectura',
    patterns: [
      /\bbarrido de lectura\b/i,
      /\b(busca|buscar|localiza|localizar|encuentra|encontrar)\b[^.\n]{0,30}(?<!\p{L})(d[oó]nde (est[aá]|se)|los usos|todas las referencias|el fichero|los ficheros)(?!\p{L})/iu,
      /\b(find|locate) (where|all usages|all references|the file)\b/i,
    ],
  },
]

/** Frase con la que el encargo declara que ningún especialista encaja. */
export const OVERRIDE = /ning[uú]n especialista encaja/i

const TURN_CAP = /turnos|max turns|max_turns|maxturns/i
const ANSWER_FORMAT = /300 tokens|devuelve/i

export const TURN_CAP_CLAUSE = '\n\nLímite: como máximo 40 turnos. Si no te llega, devuelve estado y siguiente paso.'
export const ANSWER_FORMAT_CLAUSE =
  '\nDevuelve ≤ 300 tokens: hallazgos / decisión / ficheros; sin volcar ficheros, diffs ni logs.'

const BOUNDED_TYPES: ReadonlySet<string> = new Set(['general-purpose', 'Explore'])

/** El especialista que debería llevar este encargo de general-purpose, si alguno encaja. */
export function specialistFor(text: string, isAvailable: (agent: string) => boolean): Specialist | null {
  if (OVERRIDE.test(text)) return null
  for (const specialist of SPECIALISTS) {
    if (!isAvailable(specialist.agent)) continue
    if (specialist.patterns.some((pattern) => pattern.test(text))) return specialist
  }
  return null
}

/** El prompt con las cláusulas de tope y de formato que le falten, o el mismo si no faltan. */
export function boundPrompt(subagentType: string, prompt: string): string {
  if (!BOUNDED_TYPES.has(subagentType)) return prompt
  const capped = TURN_CAP.test(prompt) ? prompt : `${prompt}${TURN_CAP_CLAUSE}`
  return ANSWER_FORMAT.test(prompt) ? capped : `${capped}${ANSWER_FORMAT_CLAUSE}`
}

/** Modelos permitidos (core.md, 2026-10-21): solo la familia 5.5, con o sin la variante de 1M. */
const ALLOWED_MODEL_ID = /^claude-(opus|sonnet|haiku)-5-5(\[1m\])?$/

/** Alias del parámetro `model`; cada uno resuelve por su `ANTHROPIC_DEFAULT_<ALIAS>_MODEL`. */
export const MODEL_ALIASES: ReadonlySet<string> = new Set(['opus', 'sonnet', 'haiku'])

export function isAllowedModelId(id: string | undefined): boolean {
  return id !== undefined && ALLOWED_MODEL_ID.test(id.trim())
}

/**
 * Si un `model` explícito se respeta: cuando él (un ID exacto) o aquello a lo que
 * resuelve (un alias o `inherit`) es de la familia 5.5. Un alias sin variable que
 * lo fije resuelve al modelo por defecto del motor, que no es de fiar.
 */
export function keepsModel(model: string, resolved: string | undefined): boolean {
  if (isAllowedModelId(model)) return true
  const isIndirect = model === 'inherit' || MODEL_ALIASES.has(model)
  return isIndirect && isAllowedModelId(resolved)
}

export function denyMessage(specialist: Specialist): string {
  return (
    `Usa ${specialist.agent}: ${specialist.reason}. general-purpose solo si ningún especialista encaja ` +
    '(si es el caso, dilo en el prompt con «ningún especialista encaja»).'
  )
}
