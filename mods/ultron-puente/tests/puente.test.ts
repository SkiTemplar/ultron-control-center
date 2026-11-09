import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { CWD, QUESTIONS, eventsOf, newBackend, paths, restart, sentEvents, settle, start, typed } from './fixtures'

type Chunk = { kind: 'text' | 'thinking'; index: number; text: string } | { kind: 'stop'; stopReason: string; usage: unknown }

const USAGE = { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }

/** Motor de `turn.step`: los trozos de cada paso por su índice. */
function steps(on: On, byStep: Chunk[][]): void {
  on('turn.step', async function* (_$, e) {
    for (const chunk of byStep[e.index] ?? []) yield chunk as never
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
}

async function runStep($: Engine, index: number, agentId?: string): Promise<void> {
  const stream = $.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', messageCount: 1, ...(agentId === undefined ? {} : { agentId }) })
  for await (const _chunk of stream) {
    // Se consume entero, como el motor.
  }
}

test('un proceso hijo sin terminal (claude -p, Agent SDK) hereda las variables pero no toca el puente', async ($, on) => {
  const backend = newBackend()
  steps(on, [[{ kind: 'text', index: 0, text: 'Hola' }]])
  const session = await start($, on, backend, undefined, false)
  await runStep($, 0)
  await session.clock.advance(30_000)
  expect(backend.calls).toEqual([])
})

test('inactivo sin variables de entorno: ninguna petición y todo pasa al motor', async ($, on) => {
  const backend = newBackend()
  steps(on, [[{ kind: 'text', index: 0, text: 'Hola' }]])
  const session = await start($, on, backend, {})
  expect(await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'c1' })).toMatchObject({ decision: 'ask' })
  expect(await $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS, tool_use_id: 'q1' } as never)).toMatchObject({ result: 'ok' })
  expect(await $.command.run(typed('config'))).toMatchObject({ text: 'ok' })
  await runStep($, 0)
  await $.classic.UserPromptSubmit({ prompt: 'x', permission_mode: 'plan' } as never)
  await session.clock.advance(30_000)
  expect(backend.calls).toEqual([])
  expect(session.tuiDialogs).toEqual(['AskUserQuestion'])
  expect(session.engineToolCalls).toEqual(['AskUserQuestion'])
  expect(session.commandRuns).toEqual([{ command: 'config', args: '' }])
})

test('hello v2 con generación, después ready y la lista viva, y el buzón de esa generación', async ($, on) => {
  const backend = newBackend()
  await start($, on, backend)
  const hello = paths(backend, '/v1/hello')
  expect(hello).toHaveLength(1)
  expect(hello[0]?.body).toEqual({
    sesionId: 's1',
    protocol: 2,
    modVersion: '2.0.0',
    claudeSessionId: 'claude-1',
    cwd: CWD,
    model: 'claude-opus-5-5',
    source: 'start',
    instanceId: expect.stringMatching(/^mod-/),
    helloSeq: expect.any(Number),
  })
  expect(hello[0]?.auth).toBe('Bearer tok-123')
  const events = sentEvents(backend)
  expect(events.map((event) => event.type)).toEqual(['ready', 'commands'])
  expect(events[0]).toEqual({ type: 'ready', seq: 1 })
  expect(eventsOf(backend, 'commands')[0]).toEqual({ type: 'commands', items: [{ name: 'cost', description: 'Coste', source: 'builtin' }], seq: 2 })
  expect(paths(backend, '/v1/events')[0]?.body.generation).toBe(1)
  expect(paths(backend, '/v1/inbox')[0]?.body).toEqual({ sesionId: 's1', generation: 1 })
})

test('text, text, stepEnd: un único POST con seq consecutivos, paso y bloque', async ($, on) => {
  const backend = newBackend()
  steps(on, [[{ kind: 'text', index: 0, text: 'Ho' }, { kind: 'text', index: 0, text: 'la' }, { kind: 'stop', stopReason: 'end_turn', usage: USAGE }]])
  const session = await start($, on, backend)
  const before = paths(backend, '/v1/events').length
  await runStep($, 0)
  await settle(session.clock)
  const posts = paths(backend, '/v1/events').slice(before)
  expect(posts).toHaveLength(1)
  const events = posts[0]?.body.events ?? []
  expect(events.map((event) => event.type)).toEqual(['text', 'text', 'stepEnd'])
  expect(events[0]).toMatchObject({ turnId: 't1', step: 0, block: 0, delta: 'Ho' })
  expect(events[2]).toMatchObject({ step: 0, stopReason: 'end_turn', usage: USAGE })
  const seqs = events.map((event) => event.seq as number)
  expect(seqs).toEqual([seqs[0] ?? 0, (seqs[0] ?? 0) + 1, (seqs[0] ?? 0) + 2])
})

test('el primer delta de cada paso sale al momento; el resto, a los 80 ms; pasos distintos, step distinto', async ($, on) => {
  const backend = newBackend()
  steps(on, [[{ kind: 'thinking', index: 0, text: 'Pienso' }], [{ kind: 'text', index: 1, text: 'A' }]])
  const session = await start($, on, backend)
  const before = paths(backend, '/v1/events').length
  await runStep($, 0)
  await settle(session.clock)
  expect(paths(backend, '/v1/events').length).toBeGreaterThan(before)
  await runStep($, 1)
  await settle(session.clock)
  const deltas = sentEvents(backend).filter((event) => event.type === 'text' || event.type === 'thinking')
  expect(deltas).toEqual([
    expect.objectContaining({ type: 'thinking', step: 0, block: 0, delta: 'Pienso' }),
    expect.objectContaining({ type: 'text', step: 1, block: 1, delta: 'A' }),
  ])
})

test('un delta que no es el primero del paso espera a los 80 ms si no hay nada inmediato', async ($, on) => {
  const backend = newBackend()
  const pause: { sleep: (ms: number) => Promise<void> } = { sleep: async () => undefined }
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text' as const, index: 0, text: 'uno' }
    await pause.sleep(500)
    yield { kind: 'text' as const, index: 0, text: 'dos' }
    await pause.sleep(1_000)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
  })
  const session = await start($, on, backend)
  pause.sleep = (ms) => session.clock.sleep(ms)
  const done = runStep($, 0)
  await settle(session.clock)
  const firstPosts = paths(backend, '/v1/events').length
  await session.clock.advance(500)
  await settle(session.clock)
  expect(eventsOf(backend, 'text').map((event) => event.delta)).toEqual(['uno'])
  await session.clock.advance(79)
  expect(eventsOf(backend, 'text').map((event) => event.delta)).toEqual(['uno'])
  await session.clock.advance(1)
  await settle(session.clock)
  expect(eventsOf(backend, 'text').map((event) => event.delta)).toEqual(['uno', 'dos'])
  expect(eventsOf(backend, 'stepEnd')).toHaveLength(0)
  await session.clock.advance(1_000)
  await done
  await settle(session.clock)
  expect(eventsOf(backend, 'stepEnd')).toHaveLength(1)
  expect(firstPosts).toBeGreaterThan(0)
})

test('un POST con 503 se reintenta sin perder turnEnd ni cambiar su seq', async ($, on) => {
  const backend = newBackend()
  const session = await start($, on, backend)
  backend.eventsStatus.push(503)
  await $.turn.complete({ answer: 'ok', durationMs: 1200, isAborted: false, turnId: 't1', reason: 'answer', usage: USAGE } as never)
  await settle(session.clock)
  const failed = paths(backend, '/v1/events').filter((call) => call.status === 503)
  expect(failed).toHaveLength(1)
  await session.clock.advance(500)
  await settle(session.clock)
  const delivered = paths(backend, '/v1/events').filter((call) => call.status === 200 && (call.body.events ?? []).some((event) => event.type === 'turnEnd'))
  expect(delivered).toHaveLength(1)
  expect(delivered[0]?.body.events).toEqual(failed[0]?.body.events)
  expect(eventsOf(backend, 'turnEnd')[0]).toMatchObject({ turnId: 't1', reason: 'answer', isAborted: false, durationMs: 1200, usage: USAGE })
})

test('hello a mitad de turno (compact): el lote de la generación vieja vuelve renumerado y turnEnd no se pierde', async ($, on) => {
  const backend = newBackend()
  const session = await start($, on, backend)
  // El hello del compact ya subió la generación en el backend; su respuesta aún no ha llegado.
  backend.generation += 1
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await settle(session.clock)
  const posts = paths(backend, '/v1/events')
  const stale = posts.filter((call) => call.isStale === true)
  expect(stale.map((call) => call.body.generation)).toEqual([1])
  const applied = posts.filter((call) => call.isStale !== true && (call.body.events ?? []).some((event) => event.type === 'turnEnd'))
  expect(applied).toHaveLength(1)
  expect(applied[0]?.body.generation).toBe(2)
  expect(applied[0]?.body.events?.[0]).toMatchObject({ type: 'turnEnd', turnId: 't1', seq: 1 })
})

test('turn.complete abortado y de subagente: turnEnd con isAborted, duración y usage, y agentEnd', async ($, on) => {
  const backend = newBackend()
  const session = await start($, on, backend)
  await $.turn.complete({ answer: '', durationMs: 300, isAborted: true, turnId: 't1', reason: 'aborted' })
  await $.turn.complete({ answer: 'r', durationMs: 50, isAborted: false, turnId: 'ta', agentId: 'a1', reason: 'answer', usage: USAGE } as never)
  await settle(session.clock)
  expect(eventsOf(backend, 'turnEnd')).toEqual([
    expect.objectContaining({ turnId: 't1', reason: 'aborted', isAborted: true, durationMs: 300 }),
    expect.objectContaining({ turnId: 'ta', agentId: 'a1', isAborted: false, usage: USAGE }),
  ])
  expect(eventsOf(backend, 'turnEnd')[0]).not.toHaveProperty('usage')
  expect(eventsOf(backend, 'agentEnd')).toEqual([expect.objectContaining({ agentId: 'a1', isError: false })])
})

test('turnEnd de subagente lleva el modelo de sus pasos; el del hilo principal no', async ($, on) => {
  const backend = newBackend()
  steps(on, [[]])
  const session = await start($, on, backend)
  const step = $.turn.step({ turnId: 'ta', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'a1' })
  for await (const _chunk of step) {
    // Se consume entero, como el motor.
  }
  await $.turn.complete({ answer: 'r', durationMs: 50, isAborted: false, turnId: 'ta', agentId: 'a1', reason: 'answer', usage: USAGE } as never)
  await $.turn.complete({ answer: 'r', durationMs: 9, isAborted: false, turnId: 'tb', agentId: 'a2', reason: 'answer' } as never)
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await settle(session.clock)
  const ends = eventsOf(backend, 'turnEnd')
  expect(ends[0]).toMatchObject({ turnId: 'ta', agentId: 'a1', model: 'claude-sonnet-5-5' })
  expect(ends[1]).not.toHaveProperty('model')
  expect(ends[2]).not.toHaveProperty('model')
})

test('backend caído: el hello se reintenta con espera y ningún evento se pierde ni se envía antes', async ($, on) => {
  const backend = newBackend({ isDown: true })
  const session = await start($, on, backend)
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await session.clock.advance(3_600)
  expect(paths(backend, '/v1/hello')).toHaveLength(4)
  expect(paths(backend, '/v1/events')).toHaveLength(0)
  backend.isDown = false
  await session.clock.advance(2_000)
  await settle(session.clock)
  expect(eventsOf(backend, 'turnEnd')).toHaveLength(1)
})

test('modo de permisos: un evento mode por cambio y el modo en status', async ($, on) => {
  const backend = newBackend()
  on('session.measure', async (_$, e) => ({ changed: e.changed }))
  const session = await start($, on, backend)
  for (const mode of ['bypassPermissions', 'bypassPermissions', 'plan', 'plan', 'acceptEdits', 'raro']) {
    await $.classic.UserPromptSubmit({ prompt: 'x', permission_mode: mode } as never)
  }
  await $.session.measure({ context: { tokens: 10, window: 100 }, rateLimits: [], cost: { usd: 0.25 }, changed: ['context'] })
  await settle(session.clock)
  await session.clock.advance(100)
  expect(eventsOf(backend, 'mode').map((event) => event.mode)).toEqual(['bypassPermissions', 'plan', 'acceptEdits'])
  expect(eventsOf(backend, 'status')[0]).toMatchObject({ model: 'claude-opus-5-5', costUsd: 0.25, mode: 'acceptEdits' })
})

test('start(A) aceptado con la respuesta perdida y después clear(B): el reintento de start(A) se abandona y el dueño sigue vivo', async ($, on) => {
  const backend = newBackend({ helloStatus: [0] })
  const session = await start($, on, backend)
  expect(paths(backend, '/v1/hello')).toHaveLength(1)
  await $.classic.SessionStart({ source: 'clear', session_id: 'claude-2', transcript_path: 'C:/t/claude-2.jsonl' } as never)
  await settle(session.clock, 10)
  await session.clock.advance(3_000)
  await settle(session.clock, 10)
  const hellos = paths(backend, '/v1/hello')
  expect(hellos.map((call) => call.body.source)).toEqual(['start', 'clear'])
  const [first, second] = hellos.map((call) => call.body)
  expect(first?.instanceId).toEqual(second?.instanceId)
  expect(Number(second?.helloSeq)).toBeGreaterThan(Number(first?.helloSeq))
  // Un `superseded` del backend tampoco es un rechazo: el contexto sigue vivo.
  backend.lastHelloSeq = Number.MAX_SAFE_INTEGER
  session.sessionId = 'claude-3'
  await $.turn.start({ text: '', turnId: 't9' })
  await settle(session.clock, 10)
  expect(paths(backend, '/v1/hello').at(-1)?.body.source).toBe('turn')
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't9', reason: 'answer' })
  await settle(session.clock, 10)
  expect(eventsOf(backend, 'turnEnd')).toEqual([expect.objectContaining({ turnId: 't9' })])
  expect(paths(backend, '/v1/events').every((call) => call.status === 200)).toBe(true)
  expect(paths(backend, '/v1/events').at(-1)?.body.generation).toBe(2)
})

test('hello rechazado con 409 (otro claude es dueño del PTY): sin eventos, sin hello de /clear ni de turno, y la pregunta va a la TUI', async ($, on) => {
  // El padre ya dijo hello tres veces: un lote de generación 0 sería `stale` y se reenviaría renumerado.
  const backend = newBackend({ generation: 3, helloStatus: [409] })
  const session = await start($, on, backend)
  await $.turn.start({ text: 'Hola desde el hijo', turnId: 'h1' })
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 'h1', reason: 'answer' })
  await $.classic.SessionStart({ source: 'clear', session_id: 'claude-hijo-2', transcript_path: 'C:/t/claude-hijo-2.jsonl' } as never)
  session.sessionId = 'claude-hijo-2'
  await $.turn.start({ text: 'Otra', turnId: 'h2' })
  expect(await $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS, tool_use_id: 'q1' } as never)).toMatchObject({ result: 'ok' })
  await session.clock.advance(30_000)
  await settle(session.clock, 10)
  expect(paths(backend, '/v1/hello')).toHaveLength(1)
  expect(paths(backend, '/v1/events')).toEqual([])
  expect(paths(backend, '/v1/ask')).toEqual([])
  expect(paths(backend, '/v1/inbox')).toEqual([])
  expect(session.tuiDialogs).toEqual(['AskUserQuestion'])
  expect(session.engineToolCalls).toEqual(['AskUserQuestion'])
})

test('hello rechazado con 409 y una herramienta de persona que falla: el fallo llega como sin puente, sin deny de la ventana', async ($, on) => {
  const session = await start($, on, newBackend({ generation: 3, helloStatus: [409] }))
  const call = $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS, tool_use_id: 'q1', boom: true } as never)
  await expect(call).rejects.toThrow()
  expect(session.tuiDialogs).toEqual(['AskUserQuestion'])
  expect(paths(session.backend, '/v1/ask')).toEqual([])
})

test('un 409 en /v1/events cierra el puente: el lote no vuelve y no sale ninguno más', async ($, on) => {
  const backend = newBackend({ eventsStatus: [200, 409] })
  const session = await start($, on, backend)
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await settle(session.clock)
  const rejected = paths(backend, '/v1/events').length
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't2', reason: 'answer' })
  await session.clock.advance(10_000)
  await settle(session.clock)
  expect(paths(backend, '/v1/events')).toHaveLength(rejected)
  expect(paths(backend, '/v1/events').at(-1)?.status).toBe(409)
})

test('un session.start nuevo cierra el contexto anterior: su hello pendiente no sube la generación', async ($, on) => {
  const backend = newBackend({ isDown: true })
  const session = await start($, on, backend)
  await restart($, session.clock)
  backend.isDown = false
  await session.clock.advance(3_000)
  await settle(session.clock)
  const accepted = paths(backend, '/v1/hello').filter((call) => call.status === 200)
  expect(accepted).toHaveLength(1)
  expect(backend.generation).toBe(1)
  expect(paths(backend, '/v1/inbox').every((call) => call.body.generation === 1)).toBe(true)
})
