import { expect, test } from 'claude-code/testing'

import { DENY_INTERRUPTED, DENY_PLAN_UNREACHABLE, DENY_REJECTED, DENY_UNREACHABLE, planDecision, planExitMode, planRejection, questionAnswers, questionResult, toAskQuestions, verdictFor } from '../hooks/answers'
import { retryDelay } from '../hooks/bridge'
import type { OpRecord } from '../types'
import { ORPHAN_ERROR, decide, withRecord } from '../hooks/inbox'
import { parseAnswer, parseConfig, parseHelloResponse, parseInboxResponse, parsePlanAnswer, parseWaitResponse, toAnswer } from '../hooks/protocol'
import { EMPTY_QUEUE, MAX_QUEUE, enqueue, renumber, requeue, takeBatch } from '../hooks/queue'
import { basename, permissionSummary, summarizeTool, timeoutOf } from '../hooks/summary'

const text = (delta: string) => ({ type: 'text' as const, turnId: 't', step: 0, block: 0, delta })

test('parseConfig exige las tres variables y una URL http(s)', async () => {
  expect(parseConfig('http://127.0.0.1:1/', 't', 's')).toEqual({ url: 'http://127.0.0.1:1', token: 't', sesionId: 's' })
  expect(parseConfig(undefined, 't', 's')).toBeNull()
  expect(parseConfig('http://127.0.0.1:1', ' ', 's')).toBeNull()
  expect(parseConfig('file:///etc/passwd', 't', 's')).toBeNull()
})

test('parseConfig solo acepta el puente local (127.0.0.1 o localhost)', async () => {
  expect(parseConfig('http://localhost:5123', 't', 's')).toEqual({ url: 'http://localhost:5123', token: 't', sesionId: 's' })
  expect(parseConfig('http://127.0.0.1:5123/v1/', 't', 's')).toEqual({ url: 'http://127.0.0.1:5123/v1', token: 't', sesionId: 's' })
  for (const url of [
    'https://evil.example',
    'http://10.0.0.1:1',
    'http://127.0.0.1.evil.example:1',
    'http://127.0.0.1@evil.example',
    'http://127.0.0.1:1@evil.example',
    'http://localhost.evil.example',
    'http://127.0.0.1:99999',
  ]) {
    expect(parseConfig(url, 't', 's')).toBeNull()
  }
})

test('hello: protocolo 2 con generación; sin protocol, backend del protocolo 1', async () => {
  expect(parseHelloResponse('{"ok":true,"protocol":2,"generation":3,"launchPermissionMode":"bypassPermissions"}')).toEqual({
    protocol: 2,
    generation: 3,
    launchPermissionMode: 'bypassPermissions',
  })
  expect(parseHelloResponse('{"ok":true}')).toEqual({ protocol: 1, generation: 0, launchPermissionMode: null })
  expect(parseHelloResponse('no es json')).toEqual({ protocol: 1, generation: 0, launchPermissionMode: null })
  expect(parseHelloResponse('{"protocol":2,"generation":1,"launchPermissionMode":"raro"}').launchPermissionMode).toBeNull()
})

test('wait multiplexado: resultados por askId, stale y formas inválidas', async () => {
  expect(parseWaitResponse('{"results":[{"askId":"a1","status":"pending"},{"askId":"a2","status":"answered","answer":{"kind":"plan","decision":"approve"}},{"askId":"a3","status":"cancelled"},{"x":1}]}')).toEqual({
    stale: false,
    items: [
      { askId: 'a1', status: 'pending' },
      { askId: 'a2', status: 'answered', answer: { kind: 'plan', decision: 'approve' } },
      { askId: 'a3', status: 'cancelled', reason: 'unknown' },
    ],
  })
  expect(parseWaitResponse('{"stale":true}')).toEqual({ stale: true })
  expect(parseWaitResponse('{"ok":true}')).toBeNull()
})

test('inbox: operaciones válidas, desconocidas omitidas y stale', async () => {
  const body = JSON.stringify({
    ops: [
      { opId: 'o1', op: 'command.run', command: '/cost', args: '' },
      { opId: 'o2', op: 'config.set', key: 'verbose', value: true },
      { opId: 'o3', op: 'otra' },
      { opId: 'o4', op: 'config.set', key: 'k', value: { x: 1 } },
      { opId: 'o5', op: 'session.usage', breakdown: 'summary' },
      { opId: 'o6', op: 'prompt.clear' },
    ],
  })
  expect(parseInboxResponse(body)).toEqual({
    stale: false,
    skipped: 2,
    items: [
      { opId: 'o1', op: 'command.run', command: 'cost', args: '' },
      { opId: 'o2', op: 'config.set', key: 'verbose', value: true },
      { opId: 'o5', op: 'session.usage', breakdown: 'summary' },
      { opId: 'o6', op: 'prompt.clear' },
    ],
  })
  expect(parseInboxResponse('{"stale":true}')).toEqual({ stale: true })
  expect(parseInboxResponse('[]')).toBeNull()
})

test('respuestas: plan con decision o con approve (protocolo 1), pregunta rechazada y tipos cruzados', async () => {
  expect(parsePlanAnswer({ decision: 'approve', mode: 'acceptEdits' })).toEqual({ kind: 'plan', decision: 'approve', mode: 'acceptEdits' })
  expect(parsePlanAnswer({ approve: false, feedback: 'más tests' })).toEqual({ kind: 'plan', decision: 'keepPlanning', feedback: 'más tests' })
  expect(parsePlanAnswer({ approve: 'sí' })).toBeNull()
  expect(toAnswer({ kind: 'question', rejected: true }, 'question')).toEqual({ kind: 'question', rejected: true })
  expect(toAnswer({ kind: 'plan', decision: 'approve' }, 'permission')).toBeNull()
  expect(parseAnswer('{"answer":{"kind":"permission","decision":"allowAlways"}}', 'permission')).toEqual({ kind: 'permission', decision: 'allowAlways' })
  expect(parseAnswer('{"answer":{"kind":"question","answers":{"a":1}}}', 'question')).toBeNull()
  expect(parseAnswer('no es json', 'plan')).toBeNull()
})

test('cola: seq por generación, sin fundir deltas y renumerada al cambiar de generación', async () => {
  let queue = renumber(EMPTY_QUEUE, 1)
  queue = enqueue(queue, text('a'))
  queue = enqueue(queue, text('b'))
  expect(queue.items.map((item) => [item.generation, item.event.seq])).toEqual([[1, 1], [1, 2]])
  const { batch, rest } = takeBatch(queue)
  expect(batch).toHaveLength(2)
  let next = enqueue(rest, { type: 'turnEnd', turnId: 't', reason: 'answer', isAborted: false, durationMs: 1 })
  next = requeue(next, batch)
  next = renumber(next, 2)
  expect(next.items.map((item) => [item.generation, item.event.seq, item.event.type])).toEqual([
    [1, 1, 'text'],
    [1, 2, 'text'],
    [2, 1, 'turnEnd'],
  ])
  expect(takeBatch(next).batch).toHaveLength(2)
})

test('cola desbordada: se descartan primero los deltas, nunca turnEnd', async () => {
  let queue = enqueue(EMPTY_QUEUE, { type: 'turnEnd', turnId: 't0', reason: 'answer', isAborted: false, durationMs: 1 })
  for (let i = 0; i < MAX_QUEUE + 5; i += 1) queue = enqueue(queue, text(`d${i}`))
  expect(queue.items).toHaveLength(MAX_QUEUE)
  expect(queue.dropped).toBe(6)
  expect(queue.items[0]?.event.type).toBe('turnEnd')
  let critical = EMPTY_QUEUE
  for (let i = 0; i < MAX_QUEUE + 3; i += 1) critical = enqueue(critical, { type: 'prompt', text: `p${i}`, origin: 'composer', wait: false })
  expect(critical.items).toHaveLength(MAX_QUEUE + 3)
  expect(critical.dropped).toBe(0)
})

test('reintentos: 0,5 s, 1 s y 2 s, y después 2 s', async () => {
  expect([1, 2, 3, 4, 9].map(retryDelay)).toEqual([500, 1_000, 2_000, 2_000, 2_000])
})

test('resúmenes: basename de las rutas, ≤ 160 caracteres y timeout declarado', async () => {
  expect(summarizeTool('Bash', { command: 'git status\n&& ls', description: 'Ver estado' })).toBe('git status && ls')
  expect(summarizeTool('Grep', { pattern: 'TODO', path: 'C:\\repo\\src' })).toBe('TODO en src')
  expect(summarizeTool('Edit', { file_path: 'C:/Users/demo/a.ts', old_string: 'x' })).toBe('a.ts')
  expect(summarizeTool('Read', { file_path: '/home/demo/b.md' })).toBe('b.md')
  expect(summarizeTool('Bash', { command: 'x'.repeat(400) })).toHaveLength(160)
  expect(basename('C:\\a\\b\\')).toBe('b')
  expect(permissionSummary('TodoWrite', { todos: [] })).toBe('TodoWrite')
  expect(timeoutOf({ command: 'npm test', timeout: 600_000 })).toBe(600_000)
  expect(timeoutOf({ timeout: '10' })).toBeUndefined()
})

test('veredicto de permiso: allow, deny con motivo por defecto y fallo explícito', async () => {
  const answered = (decision: 'allow' | 'allowAlways' | 'deny', reason?: string) =>
    ({ kind: 'answered', answer: { kind: 'permission', decision, ...(reason === undefined ? {} : { reason }) } }) as const
  expect(verdictFor(answered('allowAlways'))).toMatchObject({ decision: 'allow' })
  expect(verdictFor(answered('deny', ' '))).toEqual({ decision: 'deny', reason: 'Denegado desde ULTRON Sessions.' })
  expect(verdictFor({ kind: 'failed', why: 'unreachable' })).toEqual({ decision: 'deny', reason: DENY_UNREACHABLE })
  expect(verdictFor({ kind: 'cancelled', reason: 'interrupted' })).toEqual({ decision: 'deny', reason: DENY_INTERRUPTED })
})

test('preguntas: normaliza, filtra y rechaza explícitamente', async () => {
  const questions = toAskQuestions([{ question: '¿A o B?', header: 'Elige', multiSelect: false, options: [{ label: 'A' }, { label: 'B', description: 'b' }] }])
  expect(questions).toEqual([{ question: '¿A o B?', header: 'Elige', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: 'b' }] }])
  expect(toAskQuestions([])).toBeNull()
  expect(toAskQuestions([{ header: 'sin pregunta' }])).toBeNull()
  expect(questionAnswers(questions ?? [], { '¿A o B?': 'A', '¿Otra?': 'x' })).toEqual({ '¿A o B?': 'A' })
  const qs = questions ?? []
  expect(questionResult(qs, [], { kind: 'answered', answer: { kind: 'question', rejected: true } })).toEqual({ deny: DENY_REJECTED })
  expect(questionResult(qs, [], { kind: 'aborted' })).toEqual({ deny: DENY_INTERRUPTED })
  expect(questionResult(qs, [], { kind: 'failed', why: 'budget' })).toEqual({ deny: DENY_UNREACHABLE })
})

test('plan: aprobado con modo, seguir planificando y modo de salida', async () => {
  expect(planDecision({ kind: 'answered', answer: { kind: 'plan', decision: 'approve' } })).toEqual({ approved: { mode: null } })
  expect(planDecision({ kind: 'answered', answer: { kind: 'plan', decision: 'keepPlanning' } })).toEqual({ deny: planRejection('Sigue planificando') })
  expect(planDecision({ kind: 'failed', why: 'unreachable' })).toEqual({ deny: DENY_PLAN_UNREACHABLE })
  expect(planExitMode('acceptEdits', 'bypassPermissions')).toBe('acceptEdits')
  expect(planExitMode(null, 'bypassPermissions')).toBe('bypassPermissions')
  expect(planExitMode(null, null)).toBeNull()
  expect(planRejection('  ')).not.toContain('Cambios pedidos')
})

test('buzón: decidir por lo anotado y conservar los 64 últimos', async () => {
  const done = { opId: 'o1', generation: 1, status: 'done' as const, result: { ok: true as const, value: 1 } }
  const running = { opId: 'o2', generation: 1, status: 'running' as const }
  expect(decide([], 'o1', 1)).toEqual({ kind: 'run' })
  expect(decide([done], 'o1', 2)).toEqual({ kind: 'replay', result: { ok: true, value: 1 } })
  expect(decide([running], 'o2', 1)).toEqual({ kind: 'skip' })
  expect(decide([running], 'o2', 2)).toEqual({ kind: 'orphan' })
  let records: OpRecord[] = [done]
  for (let i = 0; i < 70; i += 1) records = withRecord(records, { opId: `x${i}`, generation: 1, status: 'running' })
  expect(records).toHaveLength(64)
  expect(records.some((record) => record.opId === 'o1')).toBe(false)
  expect(ORPHAN_ERROR).toContain('recargar')
})
