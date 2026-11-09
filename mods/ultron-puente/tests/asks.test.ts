/**
 * Preguntas, permisos y planes de punta a punta, con el motor de pruebas:
 * con el puente configurado nada cae a la TUI oculta (AC-20) y aprobar un
 * plan conserva el modo previo (AC-7).
 */
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { DENY_CANCELLED_PREFIX, DENY_FORMAT, DENY_INTERRUPTED, DENY_REJECTED, DENY_UNREACHABLE } from '../hooks/answers'
import type { Session } from './fixtures'
import { PERMISSION_SPY, QUESTIONS, eventsOf, newBackend, paths, permissionAnswers, settle, start } from './fixtures'

const checkBash = ($: Engine, command: string) => $.tool.check({ tool: 'Bash', input: { command }, tool_use_id: 'c1' })

/** Lanza la llamada, deja que el ask se cree y contesta `a1` desde la «ventana». */
async function answered<T>(session: Session, call: Promise<T>, state: Parameters<Session['backend']['resolveAsk']>[1]): Promise<T> {
  await settle(session.clock)
  session.backend.resolveAsk('a1', state)
  return call
}

const PLAN_MODE_REMINDER = {
  type: 'plan_mode',
  text: 'Plan mode is active.',
  origin: { kind: 'engine' },
  detail: { reminder: 'full', planFilePath: 'C:/Users/demo/.claude/plans/p.md', hasPlan: true },
}

test('permiso permitido en la ventana: ask asíncrono, wait y allow', async ($, on) => {
  const session = await start($, on, newBackend())
  const verdict = await answered(session, checkBash($, 'rm -rf build'), { status: 'answered', answer: { kind: 'permission', decision: 'allow' } })
  expect(verdict).toMatchObject({ decision: 'allow' })
  expect(paths(session.backend, '/v1/ask')[0]?.body).toEqual({
    sesionId: 's1',
    async: true,
    ask: { kind: 'permission', tool: 'Bash', input: { command: 'rm -rf build' }, summary: 'Bash: rm -rf build', reason: 'regla del modo', agentId: null },
  })
  expect(paths(session.backend, '/v1/ask/wait')[0]?.body).toEqual({ sesionId: 's1', generation: 1, askIds: ['a1'] })
})

test('permiso denegado con motivo y nunca un deny pisado', async ($, on) => {
  const session = await start($, on, newBackend())
  const verdict = await answered(session, checkBash($, 'rm -rf build'), { status: 'answered', answer: { kind: 'permission', decision: 'deny', reason: 'Nada de borrar' } })
  expect(verdict).toEqual({ decision: 'deny', reason: 'Nada de borrar' })
  session.verdict = { decision: 'deny', reason: 'deny-secrets' }
  expect(await checkBash($, 'cat .env')).toMatchObject({ decision: 'deny', reason: 'deny-secrets' })
  expect(paths(session.backend, '/v1/ask')).toHaveLength(1)
})

test('backend caído: deny explícito y aviso, nunca el veredicto ask hacia la TUI', async ($, on) => {
  const backend = newBackend()
  const session = await start($, on, backend)
  backend.askFailures = 2
  expect(await checkBash($, 'rm -rf build')).toEqual({ decision: 'deny', reason: DENY_UNREACHABLE })
  await settle(session.clock)
  expect(eventsOf(backend, 'notice')).toEqual([expect.objectContaining({ level: 'warn', text: expect.stringContaining('Permiso Bash') })])
})

test('ask cancelado en el backend (interrupción): deny «Interrumpido…»', async ($, on) => {
  const session = await start($, on, newBackend())
  const verdict = await answered(session, checkBash($, 'npm test'), { status: 'cancelled', reason: 'interrupted' })
  expect(verdict).toEqual({ decision: 'deny', reason: DENY_INTERRUPTED })
})

test('ask cancelado por la máquina (reinicio): el motivo no se atribuye al usuario (negativo)', async ($, on) => {
  const session = await start($, on, newBackend())
  const verdict = await answered(session, checkBash($, 'npm test'), { status: 'cancelled', reason: 'restart' })
  expect(verdict).toEqual({ decision: 'deny', reason: `${DENY_CANCELLED_PREFIX}la sesión se reinició` })
})

test('AskUserQuestion respondida: result con la forma de la herramienta y tool start/end', async ($, on) => {
  const session = await start($, on, newBackend())
  const call = $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS, tool_use_id: 'q1' } as never)
  const ran = await answered(session, call, { status: 'answered', answer: { kind: 'question', answers: { '¿Qué base de datos usamos?': 'SQLite' } } })
  expect(ran).toMatchObject({ result: { questions: QUESTIONS, answers: { '¿Qué base de datos usamos?': 'SQLite' } } })
  expect(session.engineToolCalls).toEqual([])
  await settle(session.clock)
  expect(eventsOf(session.backend, 'tool').map((event) => event.phase)).toEqual(['start', 'end'])
})

test('AskUserQuestion rechazada o mal formada: deny explícito, sin la herramienta real', async ($, on) => {
  const session = await start($, on, newBackend())
  const rejected = $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS, tool_use_id: 'q1' } as never)
  expect(await answered(session, rejected, { status: 'answered', answer: { kind: 'question', rejected: true } })).toMatchObject({ deny: DENY_REJECTED })
  const malformed = await $.tool.call({ tool: 'AskUserQuestion', questions: [{ header: 'sin pregunta' }], tool_use_id: 'q2' } as never)
  expect(malformed).toMatchObject({ deny: DENY_FORMAT })
  await settle(session.clock)
  expect(eventsOf(session.backend, 'notice')).toEqual([expect.objectContaining({ text: DENY_FORMAT })])
  expect(session.engineToolCalls).toEqual([])
  expect(paths(session.backend, '/v1/ask')).toHaveLength(1)
})

/**
 * Lo que contesta el puente al `classic.PermissionRequest` que lanza el motor al
 * aprobar el plan; el diálogo de la TUI oculta no llega a abrirse (AC-20).
 */
function planAnswers(session: Session): unknown[] {
  expect(session.tuiDialogs).toEqual([])
  return permissionAnswers(session.backend)
}

test('plan aprobado sin modo tras bypassPermissions: setMode bypassPermissions (no default)', { plugins: [PERMISSION_SPY] }, async ($, on) => {
  const session = await start($, on, newBackend({ launchPermissionMode: null }))
  await $.classic.UserPromptSubmit({ prompt: 'x', permission_mode: 'bypassPermissions' } as never)
  await $.classic.UserPromptSubmit({ prompt: 'x', permission_mode: 'plan' } as never)
  await $.prompt.attachment(PLAN_MODE_REMINDER as never)
  const call = $.tool.call({ tool: 'ExitPlanMode', tool_use_id: 'p1' } as never)
  await answered(session, call, { status: 'answered', answer: { kind: 'plan', decision: 'approve' } })
  expect(paths(session.backend, '/v1/ask')[0]?.body.ask).toEqual({ kind: 'plan', plan: '# Plan\n1. Crear el puente.' })
  expect(session.engineToolCalls).toEqual(['ExitPlanMode'])
  expect(planAnswers(session)).toEqual([
    { decision: { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }] } },
  ])
})

test('plan aprobado con modo elegido: setMode con ese modo', { plugins: [PERMISSION_SPY] }, async ($, on) => {
  const session = await start($, on, newBackend())
  const call = $.tool.call({ tool: 'ExitPlanMode', plan: 'Plan en línea', tool_use_id: 'p1' } as never)
  await answered(session, call, { status: 'answered', answer: { kind: 'plan', decision: 'approve', mode: 'acceptEdits' } })
  expect(planAnswers(session)).toEqual([
    { decision: { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] } },
  ])
})

test('plan aprobado sin modo elegido ni modo previo: sin setMode', { plugins: [PERMISSION_SPY] }, async ($, on) => {
  const session = await start($, on, newBackend({ launchPermissionMode: null }))
  const call = $.tool.call({ tool: 'ExitPlanMode', plan: 'Plan en línea', tool_use_id: 'p1' } as never)
  await answered(session, call, { status: 'answered', answer: { kind: 'plan', decision: 'approve' } })
  expect(planAnswers(session)).toEqual([{ decision: { behavior: 'allow', updatedPermissions: [] } }])
})

test('plan aprobado sin modo: el modo de lanzamiento del hello vale como modo previo', { plugins: [PERMISSION_SPY] }, async ($, on) => {
  const session = await start($, on, newBackend({ launchPermissionMode: 'bypassPermissions' }))
  const call = $.tool.call({ tool: 'ExitPlanMode', plan: 'Plan en línea', tool_use_id: 'p1' } as never)
  await answered(session, call, { status: 'answered', answer: { kind: 'plan', approve: true } })
  expect(planAnswers(session)).toEqual([
    { decision: { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }] } },
  ])
})

test('seguir planificando: deny con los cambios pedidos y sin la herramienta real', async ($, on) => {
  const session = await start($, on, newBackend())
  const call = $.tool.call({ tool: 'ExitPlanMode', plan: 'Plan en línea', tool_use_id: 'p1' } as never)
  const ran = await answered(session, call, { status: 'answered', answer: { kind: 'plan', decision: 'keepPlanning', feedback: 'Añade tests' } })
  expect(ran.deny).toContain('Añade tests')
  expect(session.engineToolCalls).toEqual([])
})

test('.catch de tool.call con una herramienta de persona: deny, nunca next(e) hacia la TUI', async ($, on) => {
  const backend = newBackend()
  const session = await start($, on, backend)
  backend.askFailures = 0
  const failing = $.tool.call({ tool: 'ExitPlanMode', plan: 'Plan', tool_use_id: 'p1', boom: true } as never)
  await settle(session.clock)
  backend.resolveAsk('a1', { status: 'answered', answer: { kind: 'plan', decision: 'approve' } })
  expect(await failing).toMatchObject({ deny: DENY_UNREACHABLE })
})
