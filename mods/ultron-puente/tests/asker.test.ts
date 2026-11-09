/**
 * El ask asíncrono con su red simulada: sondeo `wait` multiplexado, relevo
 * por presupuesto, cancelación al abortar y fallos sin reintentos dormidos.
 */
import { expect, test } from 'claude-code/testing'

import type { AskContext } from '../hooks/asks'
import { LOW_BUDGET_MS, TAKEOVER_MS, createAsker } from '../hooks/asks'
import type { Host, HttpResponse } from '../hooks/bridge'
import { createBridge } from '../hooks/bridge'

type Call = { path: string; body: Record<string, unknown> }
type Handler = (body: Record<string, unknown>) => Promise<HttpResponse>

const json = (value: unknown, status = 200): HttpResponse => ({ ok: status < 400, status, text: JSON.stringify(value) })

/** Red y temporizador en memoria; los temporizadores corren al llamar a `run`. */
function fakeHost(handlers: Record<string, Handler>) {
  const calls: Call[] = []
  let timers: (() => void)[] = []
  const host: Host = {
    fetch: async (url, init) => {
      const path = new URL(url).pathname
      const body = JSON.parse(init.body) as Record<string, unknown>
      calls.push({ path, body })
      const handler = handlers[path]
      if (handler === undefined) return json({ ok: true })
      return handler(body)
    },
    after: (_ms, fn) => {
      let isCancelled = false
      timers.push(() => {
        if (!isCancelled) fn()
      })
      return { cancel: () => void (isCancelled = true) }
    },
  }
  async function run(): Promise<void> {
    for (let round = 0; round < 10; round += 1) {
      const due = timers
      timers = []
      for (const fn of due) fn()
      for (let i = 0; i < 30; i += 1) await Promise.resolve()
    }
  }
  return { host, calls, run, paths: (path: string) => calls.filter((call) => call.path === path) }
}

/** Respuestas de `wait` que la prueba suelta a mano. */
function heldWaits() {
  const held: ((value: HttpResponse) => void)[] = []
  const handler: Handler = () => new Promise((resolve) => held.push(resolve))
  return { handler, held }
}

async function connected(handlers: Record<string, Handler>, protocol = 2) {
  let askSeq = 0
  const net = fakeHost({
    '/v1/hello': async () => json({ ok: true, protocol, generation: 1 }),
    '/v1/ask': async () => {
      askSeq += 1
      return json({ askId: `a${askSeq}` })
    },
    ...handlers,
  })
  const bridge = createBridge({ url: 'http://127.0.0.1:1', token: 't', sesionId: 's1' })
  await bridge.hello(net.host, { claudeSessionId: 'c', cwd: 'C:/p', model: 'm', source: 'start' })
  return { net, asker: createAsker(bridge, 's1') }
}

const ctxOf = (host: Host, remainingMs = Number.POSITIVE_INFINITY, signal = new AbortController().signal): AskContext => ({
  host,
  signal,
  remainingMs: () => remainingMs,
})

const ALLOW = { kind: 'permission', decision: 'allow' }
const PERMISSION = { kind: 'permission' as const, tool: 'Bash', input: {}, summary: 'Bash', agentId: null }

test('dos preguntas en paralelo: un solo sondeo wait en vuelo con los dos askId', async () => {
  const waits = heldWaits()
  const { net, asker } = await connected({ '/v1/ask/wait': waits.handler })
  const first = asker.ask(ctxOf(net.host), PERMISSION)
  const second = asker.ask(ctxOf(net.host), PERMISSION)
  await net.run()
  expect(net.paths('/v1/ask/wait')).toHaveLength(1)
  expect(asker.pollsInFlight()).toBe(1)
  waits.held.shift()?.(json({ results: [{ askId: 'a1', status: 'pending' }, { askId: 'a2', status: 'pending' }] }))
  await net.run()
  expect(net.paths('/v1/ask/wait').map((call) => call.body.askIds)).toEqual([['a1'], ['a1', 'a2']])
  waits.held.shift()?.(json({ results: [{ askId: 'a1', status: 'answered', answer: ALLOW }, { askId: 'a2', status: 'cancelled', reason: 'turnEnded' }] }))
  expect(await first).toEqual({ kind: 'answered', answer: ALLOW })
  expect(await second).toEqual({ kind: 'cancelled', reason: 'turnEnded' })
})

test('con poco presupuesto, el que espera lanza su propio sondeo (el clock del hook solo para con su $)', async () => {
  const waits = heldWaits()
  const { net, asker } = await connected({ '/v1/ask/wait': waits.handler })
  const first = asker.ask(ctxOf(net.host), PERMISSION)
  await net.run()
  const second = asker.ask(ctxOf(net.host, TAKEOVER_MS - 1), PERMISSION)
  await net.run()
  expect(net.paths('/v1/ask/wait')).toHaveLength(2)
  for (const resolve of waits.held.splice(0)) resolve(json({ results: [{ askId: 'a1', status: 'answered', answer: ALLOW }, { askId: 'a2', status: 'answered', answer: ALLOW }] }))
  expect((await first).kind).toBe('answered')
  expect((await second).kind).toBe('answered')
})

test('interrumpir: el ask se cancela en el backend con modAborted', async () => {
  const waits = heldWaits()
  const { net, asker } = await connected({ '/v1/ask/wait': waits.handler })
  const controller = new AbortController()
  const pending = asker.ask(ctxOf(net.host, Number.POSITIVE_INFINITY, controller.signal), PERMISSION)
  await net.run()
  controller.abort()
  expect(await pending).toEqual({ kind: 'aborted' })
  await net.run()
  expect(net.paths('/v1/ask/cancel').map((call) => call.body)).toEqual([{ sesionId: 's1', askId: 'a1', reason: 'modAborted' }])
})

test('wait caído: se rinde a los 3 fallos seguidos, sin esperas entre reintentos', async () => {
  const { net, asker } = await connected({ '/v1/ask/wait': async () => Promise.reject(new Error('ECONNREFUSED')) })
  const outcome = await asker.ask(ctxOf(net.host), PERMISSION)
  expect(outcome).toEqual({ kind: 'failed', why: 'unreachable' })
  expect(net.paths('/v1/ask/wait')).toHaveLength(3)
})

test('ask caído dos veces: fallo explícito; con poco presupuesto no se reintenta', async () => {
  const down = async () => json({ error: 'caído' }, 503)
  const first = await connected({ '/v1/ask': down })
  expect(await first.asker.ask(ctxOf(first.net.host), PERMISSION)).toEqual({ kind: 'failed', why: 'unreachable' })
  expect(first.net.paths('/v1/ask')).toHaveLength(2)
  const second = await connected({ '/v1/ask': down })
  expect(await second.asker.ask(ctxOf(second.net.host, LOW_BUDGET_MS - 1), PERMISSION)).toEqual({ kind: 'failed', why: 'budget' })
  expect(second.net.paths('/v1/ask')).toHaveLength(1)
})

test('presupuesto agotado antes de sondear: deny sin sondeo', async () => {
  const { net, asker } = await connected({})
  expect(await asker.ask(ctxOf(net.host, LOW_BUDGET_MS - 1), PERMISSION)).toEqual({ kind: 'failed', why: 'budget' })
  expect(net.paths('/v1/ask/wait')).toHaveLength(0)
})

test('respuesta de otro tipo que el pedido: inválida, no se toma por buena', async () => {
  const { net, asker } = await connected({
    '/v1/ask/wait': async () => json({ results: [{ askId: 'a1', status: 'answered', answer: { kind: 'plan', decision: 'approve' } }] }),
  })
  expect(await asker.ask(ctxOf(net.host), PERMISSION)).toEqual({ kind: 'failed', why: 'invalid' })
})

test('protocolo 1: ask bloqueante; sin respuesta, fallo explícito (nunca la TUI)', async () => {
  const { net, asker } = await connected({ '/v1/ask': async () => json({ answer: null }) }, 1)
  expect(await asker.ask(ctxOf(net.host), PERMISSION)).toEqual({ kind: 'failed', why: 'unreachable' })
  expect(net.paths('/v1/ask')[0]?.body).toEqual({ sesionId: 's1', ask: PERMISSION })
})
