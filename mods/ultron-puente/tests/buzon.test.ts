/**
 * Buzón backend → mod (§6.4): cada operación se ejecuta como mucho una vez,
 * con reintentos del backend y tras una recarga en caliente (AC-18, AC-24).
 */
import { expect, test } from 'claude-code/testing'

import type { Bridge, Host } from '../hooks/bridge'
import type { InboxDeps } from '../hooks/inbox'
import { EXPIRED_ERROR, ORPHAN_ERROR, createInbox, isExpired } from '../hooks/inbox'
import type { Session } from './fixtures'
import { eventsOf, newBackend, paths, restart, settle, start } from './fixtures'

const results = (session: Session) => paths(session.backend, '/v1/result').map((call) => call.body)

async function deliver(session: Session, ops: unknown[]): Promise<void> {
  session.backend.deliver(ops)
  await settle(session.clock, 10)
}

const COST = { opId: 'o1', op: 'command.run', command: 'cost', args: '' }

test('command.run del buzón: el mod emite commandStart/commandEnd y publica el texto', async ($, on) => {
  const session = await start($, on, newBackend())
  session.commandResult = async () => ({ text: 'Coste total: 0,12 $' })
  await deliver(session, [COST])
  expect(session.commandRuns).toEqual([{ command: 'cost', args: '' }])
  expect(results(session)).toEqual([{ sesionId: 's1', opId: 'o1', ok: true, value: { text: 'Coste total: 0,12 $' }, text: 'Coste total: 0,12 $' }])
  await settle(session.clock)
  expect(eventsOf(session.backend, 'commandStart')).toEqual([expect.objectContaining({ command: 'cost', args: '', origin: 'plugin:ultron-puente' })])
  expect(eventsOf(session.backend, 'commandEnd')).toEqual([expect.objectContaining({ command: 'cost', text: 'Coste total: 0,12 $', intercepted: false })])
})

test('la misma operación entregada dos veces: un solo $.command.run y dos resultados iguales', async ($, on) => {
  const session = await start($, on, newBackend())
  await deliver(session, [COST, COST])
  await deliver(session, [COST])
  expect(session.commandRuns).toHaveLength(1)
  const published = results(session)
  expect(published).toHaveLength(2)
  expect(published[0]).toEqual(published[1])
})

test('recarga simulada: el resultado guardado en $.state se reenvía sin repetir el efecto', async ($, on) => {
  const session = await start($, on, newBackend())
  await deliver(session, [COST])
  await restart($, session.clock)
  expect(paths(session.backend, '/v1/inbox').at(-1)?.body.generation).toBe(2)
  await deliver(session, [COST])
  expect(session.commandRuns).toHaveLength(1)
  expect(results(session)).toHaveLength(2)
  expect(results(session)[1]).toEqual(results(session)[0])
})

test('«en curso» de la generación 1 vista por la 2: resultado de error y ninguna llamada nueva', async ($, on) => {
  const session = await start($, on, newBackend())
  session.commandResult = () => new Promise(() => undefined)
  await deliver(session, [COST])
  await deliver(session, [COST])
  expect(session.commandRuns).toHaveLength(1)
  expect(results(session)).toEqual([])
  await restart($, session.clock)
  await deliver(session, [COST])
  expect(session.commandRuns).toHaveLength(1)
  expect(results(session)).toEqual([{ sesionId: 's1', opId: 'o1', ok: false, error: ORPHAN_ERROR }])
})

test('config.set: llama a $.config.set y publica {value}; un deny del motor sale como value {deny}', async ($, on) => {
  const session = await start($, on, newBackend())
  await deliver(session, [{ opId: 'c1', op: 'config.set', key: 'verbose', value: true }])
  session.configResult = { deny: 'Lo fija la política de la organización' }
  await deliver(session, [{ opId: 'c2', op: 'config.set', key: 'theme', value: 'dark' }])
  expect(session.configSets).toEqual([{ key: 'verbose', value: true }, { key: 'theme', value: 'dark' }])
  expect(results(session)).toEqual([
    { sesionId: 's1', opId: 'c1', ok: true, value: { value: true } },
    { sesionId: 's1', opId: 'c2', ok: true, value: { deny: 'Lo fija la política de la organización' } },
  ])
})

test('config.list, command.list, session.usage, turn.abort, prompt.read y prompt.clear', async ($, on) => {
  const session = await start($, on, newBackend())
  await deliver(session, [
    { opId: 'l1', op: 'config.list' },
    { opId: 'l2', op: 'command.list' },
    { opId: 'u1', op: 'session.usage', breakdown: 'summary' },
    { opId: 'a1', op: 'turn.abort', turnId: 't9' },
    { opId: 'r1', op: 'prompt.read' },
    { opId: 'p1', op: 'prompt.clear' },
  ])
  const byId = new Map(results(session).map((result) => [result.opId, result]))
  expect(byId.get('l1')).toMatchObject({ ok: true, value: [expect.objectContaining({ key: 'verbose' })] })
  expect(byId.get('l2')).toMatchObject({ ok: true, value: [expect.objectContaining({ name: 'cost' })] })
  expect(byId.get('u1')).toMatchObject({ ok: true, value: expect.objectContaining({ startedAt: 0 }) })
  expect(byId.get('a1')).toEqual({ sesionId: 's1', opId: 'a1', ok: true })
  expect(byId.get('r1')).toMatchObject({ ok: true, value: { text: 'texto escrito', cursor: 13 } })
  expect(byId.get('p1')).toMatchObject({ ok: true })
  expect(session.turnAborts).toEqual(['t9'])
  expect(session.promptFills).toEqual([expect.objectContaining({ text: '', mode: 'replace' })])
})

test('turn.abort sin turnId: el turno principal en curso; sin turno, error explícito', async ($, on) => {
  const session = await start($, on, newBackend())
  await deliver(session, [{ opId: 'a0', op: 'turn.abort', turnId: '' }])
  await $.turn.start({ text: 'hola', turnId: 't5' })
  await deliver(session, [{ opId: 'a1', op: 'turn.abort', turnId: '' }])
  expect(session.turnAborts).toEqual(['t5'])
  expect(results(session)).toEqual([
    { sesionId: 's1', opId: 'a0', ok: false, error: 'No hay ningún turno en curso que interrumpir' },
    { sesionId: 's1', opId: 'a1', ok: true },
  ])
})

test('setIntercept y operaciones desconocidas: error explícito o se omiten sin parar el buzón', async ($, on) => {
  const session = await start($, on, newBackend())
  await deliver(session, [{ opId: 'i1', op: 'setIntercept', on: false }, { opId: 'x1', op: 'otra' }])
  await deliver(session, [COST])
  expect(results(session)).toEqual([
    { sesionId: 's1', opId: 'i1', ok: false, error: expect.stringContaining('interceptación') },
    expect.objectContaining({ opId: 'o1', ok: true }),
  ])
})

test('generación vieja: el sondeo recibe stale y su bucle termina', async ($, on) => {
  const session = await start($, on, newBackend())
  session.backend.generation = 7
  session.backend.poke()
  await settle(session.clock, 10)
  const polls = paths(session.backend, '/v1/inbox').length
  await session.clock.advance(60_000)
  expect(paths(session.backend, '/v1/inbox')).toHaveLength(polls)
})

test('dos hello casi a la vez (--resume): el buzón no vuelve a la generación vieja si su respuesta llega la última', async () => {
  const polls: unknown[] = []
  const bridge = {
    post: (_host: Host, _path: string, body: unknown) => {
      polls.push(body)
      return new Promise<never>(() => undefined)
    },
  } as unknown as Bridge
  const timers: (() => void)[] = []
  const host: Host = {
    fetch: () => Promise.reject(new Error('sin red')),
    after: (_ms, fn) => {
      timers.push(fn)
      return { cancel: () => undefined }
    },
  }
  const deps: InboxDeps = { execute: async () => ({ ok: true }), store: { read: async () => ({ records: [], version: 0 }), write: async () => true } }
  const inbox = createInbox(bridge, 's1')
  inbox.start(host, 2, deps)
  inbox.start(host, 1, deps)
  for (const fn of timers.splice(0)) fn()
  await Promise.resolve()
  expect(polls).toEqual([{ sesionId: 's1', generation: 2 }])
})

test('caducidad: una operación con expiresAt vencido no se ejecuta y se contesta «caducada»; sin el campo o a tiempo, sí', async ($, on) => {
  const session = await start($, on, newBackend())
  // El reloj simulado arranca en 1_000 ms: 0 ya pasó y 1e13 queda lejos.
  await deliver(session, [
    { opId: 'p1', op: 'prompt.clear', expiresAt: 0 },
    { opId: 'o1', op: 'command.run', command: 'cost', args: '', expiresAt: 0 },
  ])
  expect(session.promptFills).toEqual([])
  expect(session.commandRuns).toEqual([])
  expect(results(session)).toEqual([
    { sesionId: 's1', opId: 'p1', ok: false, error: EXPIRED_ERROR },
    { sesionId: 's1', opId: 'o1', ok: false, error: EXPIRED_ERROR },
  ])
  expect(EXPIRED_ERROR).toContain('caducada')
  await deliver(session, [{ opId: 'p1', op: 'prompt.clear', expiresAt: 0 }])
  expect(session.promptFills).toEqual([])
  await deliver(session, [
    { opId: 'p2', op: 'prompt.clear', expiresAt: 1e13 },
    { opId: 'p3', op: 'prompt.clear' },
  ])
  expect(session.promptFills).toHaveLength(2)
  const byId = new Map(results(session).map((result) => [result.opId, result]))
  expect(byId.get('p2')).toMatchObject({ ok: true })
  expect(byId.get('p3')).toMatchObject({ ok: true })
})

test('isExpired: solo con expiresAt y a partir de ese instante', () => {
  const op = { opId: 'x', op: 'prompt.clear' as const }
  expect(isExpired(op, 5)).toBe(false)
  expect(isExpired({ ...op, expiresAt: 5 }, 4)).toBe(false)
  expect(isExpired({ ...op, expiresAt: 5 }, 5)).toBe(true)
})

test('/model por el buzón reemite el último status con el modelo nuevo; otro comando no', async ($, on) => {
  on('session.measure', async (_$, e) => ({ changed: e.changed }))
  const session = await start($, on, newBackend())
  await $.session.measure({ context: { tokens: 10, window: 100 }, rateLimits: [], changed: ['context'] })
  await settle(session.clock)
  await session.clock.advance(100)
  expect(eventsOf(session.backend, 'status').map((event) => event.model)).toEqual(['claude-opus-5-5'])
  await deliver(session, [COST])
  await settle(session.clock)
  await session.clock.advance(100)
  expect(eventsOf(session.backend, 'status')).toHaveLength(1)
  session.model = 'claude-sonnet-5-5'
  await deliver(session, [{ opId: 'o2', op: 'command.run', command: 'model', args: 'claude-sonnet-5-5' }])
  await settle(session.clock)
  await session.clock.advance(100)
  const statuses = eventsOf(session.backend, 'status')
  expect(statuses).toHaveLength(2)
  expect(statuses[1]).toMatchObject({ model: 'claude-sonnet-5-5', contextTokens: 10, contextWindow: 100 })
})
