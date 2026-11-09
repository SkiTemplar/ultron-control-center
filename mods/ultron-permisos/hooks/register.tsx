import type { EngineInterface, Register } from 'claude-code'

import { minutesLeft, PAUSA_MAX_MIN, parseMinutes, pausaContent, pausaLine, pausaPath, reanudarContent } from './pausa'
import { evaluate, isHandsOffMode, isLearnableTool, patternFor, proposals, recordApproval } from './rules'
import type { Approvals } from './rules'

const APPROVALS_KEY = 'approvals'
const LEARNED_KEY = 'learned'

/** Patrón pendiente de cada llamada que acabó en el diálogo, por tool_use_id. */
const pending = new Map<string, string>()
let autoApproved = 0
/** Último `permission_mode` visto en un evento clásico; null hasta el primero. */
let permissionMode: string | null = null
/** Directorio personal, leído una vez: en él la raíz de la sesión no cuenta como proyecto. */
let home: string | null = null

async function homeDir($: EngineInterface): Promise<string> {
  if (home === null) home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  return home
}

/** Mensaje que lee la persona cuando una llamada aprobada a mano rechazó el diálogo. */
const USER_REJECTION = /doesn't want to proceed|rejected|denied|declined|rechaz/i

async function readApprovals($: EngineInterface): Promise<Approvals> {
  const value = await $.store.get(APPROVALS_KEY)
  return typeof value === 'object' && value !== null ? (value as Approvals) : {}
}

async function readLearned($: EngineInterface): Promise<string[]> {
  const value = await $.store.get(LEARNED_KEY)
  return Array.isArray(value) ? value.filter((rule): rule is string => typeof rule === 'string') : []
}

function showCounter($: EngineInterface): void {
  $.ui.status(autoApproved === 0 ? undefined : `permisos: ${autoApproved} auto`)
}

/** Cuenta una aprobación manual y, al llegar al umbral, propone la regla una sola vez. */
async function countApproval($: EngineInterface, pattern: string): Promise<void> {
  const learned = await readLearned($)
  if (learned.includes(pattern)) return
  const { approvals, shouldNotify } = recordApproval(await readApprovals($), pattern)
  await $.store.set(APPROVALS_KEY, approvals)
  if (!shouldNotify) return
  const index = proposals(approvals, learned).indexOf(pattern) + 1
  $.ui.toast(`Has aprobado \`${pattern}\` 3 veces. /permisos aceptar ${index} para auto-aprobarla.`, { timeoutMs: 8_000 })
}

function wasApproved(ran: { deny?: string; isError?: true; text?: string }): boolean {
  if (ran.deny !== undefined) return false
  return ran.isError !== true || !USER_REJECTION.test(ran.text ?? '')
}

/** Una regla aprendida antes de la lista blanca de MCP que ya no se aplica se marca, no se calla. */
function learnedLine(pattern: string, index: number): string {
  const note = isLearnableTool(pattern) ? '' : ' (inactiva: MCP fuera de la lista de solo lectura)'
  return `  ${index + 1}. ${pattern}${note}`
}

function listing(approvals: Approvals, learned: readonly string[], pausa: string): string {
  const offered = proposals(approvals, learned)
  const lines = ['Propuestas (aprobadas a mano 3 veces o más):']
  lines.push(...(offered.length === 0 ? ['  ninguna'] : offered.map((p, i) => `  ${i + 1}. ${p}`)))
  lines.push('Reglas aprendidas activas:')
  lines.push(...(learned.length === 0 ? ['  ninguna'] : learned.map(learnedLine)))
  lines.push(pausa)
  lines.push(
    `Uso: /permisos aceptar <n> · /permisos quitar <n> · /permisos pausar-env <1-${PAUSA_MAX_MIN} min> · /permisos reanudar-env`,
  )
  return lines.join('\n')
}

/** Ruta de la pausa de deny-secrets, o null si no se conoce el directorio personal. */
async function pausaFile($: EngineInterface): Promise<string | null> {
  return pausaPath(await homeDir($), (await $.env.get('ULTRON_DENY_SECRETS_PAUSA')) ?? undefined)
}

async function pausaLeft($: EngineInterface, path: string | null): Promise<number | null> {
  if (path === null) return null
  const text = await $.fs.read(path).catch(() => null)
  return minutesLeft(typeof text === 'string' ? text : null, await $.clock.now())
}

/** `/permisos pausar-env <min>` y `/permisos reanudar-env`: único productor de la pausa. */
async function runPausa($: EngineInterface, action: string, minutesText: string): Promise<string> {
  const path = await pausaFile($)
  if (path === null) return 'No se conoce el directorio personal (USERPROFILE/HOME): la pausa no se ha tocado.'
  const now = await $.clock.now()
  if (action === 'reanudar-env') {
    if ((await pausaLeft($, path)) === null) return 'No había pausa activa: el .env sigue pidiendo permiso.'
    const closed = await $.fs.write(path, reanudarContent(now)).then(() => null, (error: unknown) => String(error))
    return closed === null ? 'Pausa cerrada: el .env vuelve a pedir permiso.' : `No se pudo cerrar la pausa: ${closed}`
  }
  const minutes = parseMinutes(minutesText)
  if (minutes === null) return `Indica los minutos, de 1 a ${PAUSA_MAX_MIN}: /permisos pausar-env 60`
  const failed = await $.fs.write(path, pausaContent(now, minutes)).then(() => null, (error: unknown) => String(error))
  if (failed !== null) return `No se pudo escribir la pausa: ${failed}`
  return `Pausa puesta durante ${minutes} min: no piden permiso el .env, los .npmrc/.pypirc, ~/.claude.json (tokens de MCP), el volcado de variables de entorno ni el token del puente de Pupus. Las claves privadas, .ssh y las credenciales de AWS, git, GitHub, Codex y Gemini siguen bloqueadas.`
}

/** `/permisos`, `aceptar <n>`, `quitar <n>`, `pausar-env <min>` y `reanudar-env`. */
async function runCommand($: EngineInterface, args: string): Promise<string> {
  const pausa = /^(pausar-env|reanudar-env)(?:\s+(\S+))?$/i.exec(args.trim())
  if (pausa !== null) return runPausa($, pausa[1]?.toLowerCase() ?? '', pausa[2] ?? '')
  const approvals = await readApprovals($)
  const learned = await readLearned($)
  const listed = async () => listing(approvals, learned, pausaLine(await pausaLeft($, await pausaFile($))))
  const match = /^(aceptar|quitar)\s+(\d+)$/i.exec(args.trim())
  if (args.trim() === '') return listed()
  if (match === null) return `No entiendo «${args.trim()}». ${await listed()}`
  const index = Number(match[2]) - 1
  if (match[1]?.toLowerCase() === 'aceptar') {
    const pattern = proposals(approvals, learned)[index]
    if (pattern === undefined) return `No hay propuesta ${index + 1}.\n${await listed()}`
    await $.store.set(LEARNED_KEY, [...learned, pattern])
    return `Regla aprendida: ${pattern}`
  }
  const removed = learned[index]
  if (removed === undefined) return `No hay regla aprendida ${index + 1}.\n${await listed()}`
  await $.store.set(LEARNED_KEY, learned.filter((_, i) => i !== index))
  return `Regla retirada: ${removed}`
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    permissionMode = null
    home = null
    await $.command.register({
      name: 'permisos',
      description: 'Reglas de permisos aprendidas (aceptar/quitar) y pausa del permiso del .env (pausar-env/reanudar-env)',
      argumentHint: '[aceptar <n> | quitar <n> | pausar-env <min> | reanudar-env]',
    })
    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision !== 'ask' || verdict.hook !== undefined || verdict.rule !== undefined) return verdict
    if (isHandsOffMode(permissionMode)) return verdict
    const decided = evaluate(e.tool, e.input, await $.session.root(), await readLearned($), await homeDir($))
    if (decided.isAllowed) {
      autoApproved += 1
      showCounter($)
      return { decision: 'allow' as const, reason: `ultron-permisos: ${decided.rule}` }
    }
    const pattern = patternFor(e.tool, e.input)
    if (e.tool_use_id !== undefined && pattern !== null) pending.set(e.tool_use_id, pattern)
    return verdict
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const id = (e as { tool_use_id?: string }).tool_use_id
    const pattern = id === undefined ? undefined : pending.get(id)
    if (id === undefined || pattern === undefined) return ran
    pending.delete(id)
    if (wasApproved(ran)) await countApproval($, pattern)
    return ran
  })

  // El modo de permisos solo llega en la entrada de los eventos clásicos
  // (`permission_mode`); se guarda el último para no auto-aprobar en plan ni
  // en dontAsk (H29). Si el modo cambia a mitad de turno (ExitPlanMode), el
  // siguiente evento clásico lo actualiza; mientras, el error es no aprobar.
  on('classic.*', async ($, e, next) => {
    const mode = (e as { permission_mode?: unknown }).permission_mode
    if (typeof mode === 'string' && mode !== '') permissionMode = mode
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'permisos' }, async ($, e) => ({ text: await runCommand($, e.args) }))
}
