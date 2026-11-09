import type { AgentSpawnInput, EngineInterface, Register } from 'claude-code'

import { BUILTIN_AGENTS, SPECIALISTS, boundPrompt, denyMessage, keepsModel, specialistFor } from './policy'

/** Existencia de cada especialista, comprobada una vez por carga del mod. */
const availability = new Map<string, boolean>()

async function agentExists($: EngineInterface, agent: string): Promise<boolean> {
  if (BUILTIN_AGENTS.has(agent)) return true
  const cached = availability.get(agent)
  if (cached !== undefined) return cached
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const exists = home === undefined ? false : await $.fs.exists(`${home}/.claude/agents/${agent}.md`)
  availability.set(agent, exists)
  return exists
}

/** Los especialistas instalados: uno que no exista no se nombra nunca. */
async function availableAgents($: EngineInterface): Promise<ReadonlySet<string>> {
  const agents = SPECIALISTS.map((specialist) => specialist.agent)
  const checks = await Promise.all(agents.map((agent) => agentExists($, agent)))
  return new Set(agents.filter((_, i) => checks[i]))
}

/**
 * A qué ID resuelve un alias (por su variable de entorno) o `inherit` (el modelo
 * del padre). El motor exige el nombre de la variable literal en cada lectura.
 */
async function resolveModel($: EngineInterface, e: AgentSpawnInput, model: string): Promise<string | undefined> {
  switch (model) {
    case 'inherit':
      return e.parentModel
    case 'opus':
      return await $.env.get('ANTHROPIC_DEFAULT_OPUS_MODEL')
    case 'sonnet':
      return await $.env.get('ANTHROPIC_DEFAULT_SONNET_MODEL')
    case 'haiku':
      return await $.env.get('ANTHROPIC_DEFAULT_HAIKU_MODEL')
    default:
      return undefined
  }
}

/**
 * Reescrituras que no cambian el tipo: tope y formato, y fuera el `model` explícito
 * que no sea de la familia 5.5 (uno de la familia, Haiku incluido, se respeta).
 */
async function rewrite($: EngineInterface, e: AgentSpawnInput): Promise<{ next: AgentSpawnInput; changes: string[] }> {
  const changes: string[] = []
  const prompt = boundPrompt(e.subagentType, e.prompt)
  if (prompt !== e.prompt) changes.push('tope y formato')
  if (e.model === undefined) return { next: { ...e, prompt }, changes }
  if (keepsModel(e.model, await resolveModel($, e, e.model))) return { next: { ...e, prompt }, changes }
  changes.push(`sin model ${e.model} (fuera de la familia 5.5)`)
  return { next: { ...e, prompt, model: undefined }, changes }
}

export const register: Register = (on) => {
  on('agent.spawn', async ($, e, next) => {
    if (e.workflow !== undefined || e.fork) return next(e)
    if (e.subagentType === 'general-purpose') {
      const available = await availableAgents($)
      const specialist = specialistFor(`${e.description}\n${e.prompt}`, (agent) => available.has(agent))
      if (specialist !== null) {
        $.ui.toast(`Guardia: general-purpose → ${specialist.agent}`)
        return { deny: denyMessage(specialist) }
      }
    }
    const { next: rewritten, changes } = await rewrite($, e)
    if (changes.length > 0) $.ui.toast(`Guardia (${e.subagentType}): ${changes.join(', ')}`)
    return next(rewritten)
  }).catch(($, e, next) => next(e))
}
