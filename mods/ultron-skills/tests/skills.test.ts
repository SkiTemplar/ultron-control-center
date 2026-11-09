import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { approxTokens, originOf, withActivation } from '../hooks/skills'

const T0 = Date.parse('2026-10-04T10:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()
const LOG_PATH = 'C:/Users/demo/.claude/logs/routing-dispatcher.jsonl'

const line = (ms: number, msg: string, extra: Record<string, unknown>): string =>
  JSON.stringify({ ts: iso(ms), level: 'info', msg, ...extra })

test('origen: principal sin agentId, subagente con id corto', () => {
  expect(originOf(null)).toBe('principal')
  expect(originOf('a1b2c3d4e5f6')).toBe('subagente a1b2c3d')
  expect(approxTokens('x'.repeat(401))).toBe(101)
})

test('la misma skill y origen suma en su fila y sube arriba', () => {
  const one = withActivation([], { name: 'commit', origin: 'principal', tokens: 10, at: 1 })
  const two = withActivation(one, { name: 'tdd', origin: 'principal', tokens: 5, at: 2 })
  const three = withActivation(two, { name: 'commit', origin: 'principal', tokens: 10, at: 3 })
  expect(three.map((h) => `${h.name}:${h.count}:${h.tokens}`)).toEqual(['commit:2:20', 'tdd:1:5'])
  expect(one[0]!.count).toBe(1)
})

const PANE_PROPS = { title: 'Skills', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } }

type Host = {
  /** Log del dispatcher en disco: lo siguen escribiendo los arneses y benchmarks, no las sesiones. */
  log: string | null
  statuses: Array<string | undefined>
  builtin: number
  /** Accesos del mod al disco (exists, stat o read): no debe tocar ninguno. */
  fsCalls: string[]
}

const newHost = (log: string | null): Host => ({ log, statuses: [], builtin: 0, fsCalls: [] })

/** Motor simulado: entorno, log del dispatcher en disco, status line, tool Skill y el /skills del motor. */
function fakeHost($: Engine, on: On, host: Host, clock: MockClock) {
  mock.env(on, { USERPROFILE: 'C:/Users/demo' })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('skill.prompt', async (_$, e) => ({ text: e.text }))
  on('prompt.submit', async (_$, e) => {
    // Un arnés escribe en el log mientras corre el prompt de esta sesión.
    host.log = [host.log ?? '', line(clock.now(), 'lazy_skill_injected', { skills: ['security-scan'], repeated: [] })].join('\n')
    return { text: e.text }
  })
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: 'respuesta' }))
  // La tool Skill expande el prompt de la skill dentro de su ejecución, como el motor.
  on('tool.call', async (_$, e) => {
    const skill = String((e as unknown as { skill: string }).skill)
    await $.skill.prompt({ skill, text: 'z'.repeat(40) })
    return { result: 'ok' as never }
  })
  on('fs.exists', async (_$, e) => {
    host.fsCalls.push(`exists ${e.path}`)
    return { value: host.log !== null && e.path.replace(/\\/g, '/') === LOG_PATH }
  })
  on('fs.stat', async (_$, e) => {
    host.fsCalls.push(`stat ${e.path}`)
    return { value: { kind: 'file' as const, size: (host.log ?? '').length, mtimeMs: clock.now(), isLink: false } }
  })
  on('fs.read', async (_$, e) => {
    host.fsCalls.push(`read ${e.path}`)
    return { value: host.log ?? '' }
  })
  on('ui.status', async (_$, e) => {
    host.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('ui.panes', async () => ({ value: [] }))
  on('command.run', async () => {
    host.builtin += 1
    return { text: 'listado del motor' }
  })
}

async function start($: Engine, on: On, host: Host) {
  const clock = mock.clock(on, { now: T0 })
  fakeHost($, on, host, clock)
  await $.session.start({ cwd: 'C:/demo', surface: 'terminal', isInteractive: true })
  return clock
}

const submit = ($: Engine, text: string) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)

const skillTool = ($: Engine, skill: string, toolUseId: string, agentId?: string) =>
  $.tool.call({ tool: 'Skill', skill, tool_use_id: toolUseId, ...(agentId === undefined ? {} : { agentId }) } as never)

const mountPane = ($: Engine) =>
  $.ui.mount({ plugin: 'ultron-skills', surface: 'terminal', component: 'Pane', requestId: 'skills', props: PANE_PROPS as never })

test('origen por la tool Skill: principal, subagente y «/nombre o precarga» sin llamada', async ($, on) => {
  const host = newHost(null)
  const clock = await start($, on, host)

  const out = await $.skill.prompt({ skill: 'commit', text: 'x'.repeat(400) })
  expect(out.text).toBe('x'.repeat(400))
  await skillTool($, 'tdd', 'tu-1')
  await skillTool($, 'rust-patterns', 'tu-2', 'abcdef123456')
  await clock.advance(1)

  expect(host.statuses.at(-1)).toBe('skills: commit, tdd, rust-patterns')
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: '/nombre o precarga' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'principal' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'subagente abcdef1' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /≈100 tok/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /3 skills · 3 activaciones · ≈120 tokens/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /el motor no dice en qué hilo/ })).toBeDefined()
  await pane.unmount()
})

test('una skill de subagente tras cerrar el turno no vacía la lista del turno', async ($, on) => {
  const host = newHost(null)
  await start($, on, host)
  await submit($, 'haz el commit')
  await skillTool($, 'commit', 'tu-1')
  await $.turn.complete({ reason: 'end_turn' } as never)
  await skillTool($, 'tdd', 'tu-2', 'sub-9')
  expect(host.statuses.at(-1)).toBe('skills: commit, tdd')
  await $.turn.start({ text: 'otra cosa', turnId: 't-2' })
  expect(host.statuses.at(-1)).toBeUndefined()
})

test('el log del dispatcher desconectado no se lee ni se atribuye, aunque un arnés escriba en él', async ($, on) => {
  const host = newHost(line(T0 - 60_000, 'lazy_skill_injected', { skills: ['vieja'] }))
  const clock = await start($, on, host)
  await submit($, 'revisa la seguridad')
  await clock.advance(5_000)
  await submit($, 'y ahora otra cosa')
  await clock.advance(1)

  expect(host.fsCalls).toEqual([])
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: 'security-scan' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /dispatcher/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /^Error/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /Ninguna skill activada todavía/ })).toBeDefined()
  await pane.unmount()
})

test('/skills abre el panel; /skills todas deja pasar el listado del motor', async ($, on) => {
  const host = newHost(null)
  await start($, on, host)
  expect((await $.command.run({ command: 'skills', args: '' } as never)).text).toBeUndefined()
  expect(host.builtin).toBe(0)
  expect((await $.command.run({ command: 'skills', args: 'todas' } as never)).text).toBe('listado del motor')
  expect(host.builtin).toBe(1)
})
