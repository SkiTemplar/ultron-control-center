/**
 * Traducción entre lo que decide la ventana (`AskOutcome`) y lo que el motor
 * espera de cada hook (§4.4). Módulo puro.
 *
 * Con el puente configurado nunca se devuelve el veredicto `ask` ni se deja
 * pasar una herramienta de persona a la TUI: la TUI está oculta y su diálogo
 * no lo vería nadie. Todo fallo acaba en un `deny` explícito.
 */
import type { ToolCheckResult } from 'claude-code'

import type { AskOutcome } from './asks'
import type { AskQuestion, PermissionMode } from './protocol'

/** Herramientas que siempre requieren a la persona: se resuelven en `tool.call`, no en `tool.check`. */
export const PERSON_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode'])

export const DENY_UNREACHABLE = 'No se pudo preguntar desde ULTRON Sessions; decide tú o pregunta en texto'
export const DENY_PLAN_UNREACHABLE = 'Plan no aprobado: ULTRON Sessions no disponible'
export const DENY_INTERRUPTED = 'Interrumpido por el usuario'
export const DENY_CANCELLED_PREFIX = 'Sin respuesta (no es una decisión del usuario): '
const CANCEL_REASONS: Readonly<Record<string, string>> = {
  turnEnded: 'el turno terminó',
  sessionExited: 'la sesión terminó',
  modAborted: 'se interrumpió en la CLI',
  restart: 'la sesión se reinició',
}
export const DENY_REJECTED = 'El usuario rechazó responder'
export const DENY_FORMAT = 'Formato de pregunta no soportado por ULTRON Sessions'
const DEFAULT_DENY_REASON = 'Denegado desde ULTRON Sessions.'

/** Motivo del `deny` cuando la ventana no dio una respuesta utilizable. */
export function denyReason(outcome: AskOutcome, kind: 'permission' | 'question' | 'plan'): string {
  if (outcome.kind === 'aborted') return DENY_INTERRUPTED
  if (outcome.kind === 'cancelled') {
    // El modelo no puede leer como decisión humana un evento de la máquina: la
    // sesión reiniciada o terminada no es un «no». Límite: `interrupted` también lo
    // emite el backend por sus temporizadores, y aquí no se distingue.
    if (outcome.reason === 'interrupted') return DENY_INTERRUPTED
    return `${DENY_CANCELLED_PREFIX}${CANCEL_REASONS[outcome.reason] ?? outcome.reason}`
  }
  return kind === 'plan' ? DENY_PLAN_UNREACHABLE : DENY_UNREACHABLE
}

/** ¿El fallo merece un aviso en la ventana? (no lo merece interrumpir). */
export const isFailure = (outcome: AskOutcome): boolean => outcome.kind === 'failed'

/** Veredicto final de `tool.check` a partir de lo que decidió la ventana. */
export function verdictFor(outcome: AskOutcome): ToolCheckResult {
  if (outcome.kind !== 'answered' || outcome.answer.kind !== 'permission') {
    return { decision: 'deny', reason: denyReason(outcome, 'permission') }
  }
  const answer = outcome.answer
  if (answer.decision === 'deny') {
    const reason = answer.reason?.trim()
    return { decision: 'deny', reason: reason === undefined || reason === '' ? DEFAULT_DENY_REASON : reason }
  }
  const scope = answer.decision === 'allowAlways' ? ' (siempre)' : ''
  return { decision: 'allow', reason: `ultron-puente: permitido desde ULTRON Sessions${scope}` }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function toOption(option: unknown): AskQuestion['options'][number] | null {
  if (!isRecord(option) || typeof option.label !== 'string') return null
  return { label: option.label, description: typeof option.description === 'string' ? option.description : '' }
}

function toQuestion(question: unknown): AskQuestion | null {
  if (!isRecord(question) || typeof question.question !== 'string') return null
  const rawOptions = Array.isArray(question.options) ? question.options : []
  const options = rawOptions.map(toOption)
  if (options.some((option) => option === null)) return null
  return {
    question: question.question,
    header: typeof question.header === 'string' ? question.header : '',
    multiSelect: question.multiSelect === true,
    options: options as AskQuestion['options'],
  }
}

/** Preguntas de `AskUserQuestion` en la forma del contrato; null si alguna no se entiende. */
export function toAskQuestions(questions: unknown): AskQuestion[] | null {
  if (!Array.isArray(questions) || questions.length === 0) return null
  const mapped = questions.map(toQuestion)
  return mapped.some((question) => question === null) ? null : (mapped as AskQuestion[])
}

/**
 * Respuestas válidas para la salida de `AskUserQuestion` (pregunta → texto):
 * solo las de preguntas que se hicieron. Null si no queda ninguna.
 */
export function questionAnswers(questions: readonly AskQuestion[], answers: Record<string, string>): Record<string, string> | null {
  const asked = new Set(questions.map((question) => question.question))
  const kept = Object.entries(answers).filter(([question]) => asked.has(question))
  return kept.length === 0 ? null : Object.fromEntries(kept)
}

/** Resultado de `AskUserQuestion`: la salida de la herramienta o un `deny` con motivo. */
export function questionResult(questions: readonly AskQuestion[], raw: unknown, outcome: AskOutcome): { answers: Record<string, string> } | { deny: string } {
  if (outcome.kind !== 'answered' || outcome.answer.kind !== 'question') return { deny: denyReason(outcome, 'question') }
  const answer = outcome.answer
  if (answer.rejected === true) return { deny: DENY_REJECTED }
  const answers = questionAnswers(questions, answer.answers)
  return answers === null ? { deny: DENY_REJECTED } : { answers }
}

/** Texto que lee el modelo cuando el plan se rechaza desde la ventana. */
export function planRejection(feedback?: string): string {
  const note = feedback?.trim()
  const base = 'El usuario ha rechazado el plan desde ULTRON Sessions y sigue en modo plan.'
  return note === undefined || note === '' ? base : `${base} Cambios pedidos: ${note}`
}

/** Decisión sobre `ExitPlanMode`: aprobado con el modo elegido, o `deny`. */
export function planDecision(outcome: AskOutcome): { approved: { mode: PermissionMode | null } } | { deny: string } {
  if (outcome.kind !== 'answered' || outcome.answer.kind !== 'plan') return { deny: denyReason(outcome, 'plan') }
  const answer = outcome.answer
  if (answer.decision === 'keepPlanning') return { deny: planRejection(answer.feedback ?? 'Sigue planificando') }
  return { approved: { mode: answer.mode ?? null } }
}

/**
 * Modo al que vuelve la sesión tras aprobar un plan: el elegido en la
 * ventana o, si no hay, el último modo distinto de `plan`. Sin ninguno, null
 * (sin `setMode`: la CLI decide como haría sin el puente).
 */
export function planExitMode(chosen: PermissionMode | null, lastNonPlanMode: PermissionMode | null): PermissionMode | null {
  return chosen ?? lastNonPlanMode
}
