import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { closingNotice, countPorcelain, parseResult } from '../hooks/check'

type Host = {
  porcelain: string
  isGitBroken: boolean
  result: Record<string, unknown> | null
  toasts: string[]
  suggestions: string[]
  /** Nombres de fichero cuya lectura lanza (EBUSY simulado). */
  unreadable: string[]
  /** Si el lock del runner (`.state.json`) existe. */
  hasState: boolean
  logs: string[]
}

const newHost = (over: Partial<Host> = {}): Host => ({
  porcelain: '',
  isGitBroken: false,
  result: null,
  toasts: [],
  suggestions: [],
  unreadable: [],
  hasState: false,
  logs: [],
  ...over,
})

const RED = {
  project: 'demo',
  cwd: 'C:\\Demo',
  status: 'failed',
  failed_tests: ['suma', 'resta'],
  failed_total: 2,
  summary: '2 failed',
}

const ran = (exitCode: number, stdout: string) => ({
  value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false },
})

function fakeHost(on: On, host: Host) {
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', async () => ({ value: 'C:/Demo/src' }))
  on('process.run', async () => (host.isGitBroken ? ran(128, '') : ran(0, host.porcelain)))
  on('fs.exists', async (_$, e) => ({ value: host.result !== null && (host.hasState || !e.path.endsWith('.state.json')) }))
  const file = (name: string) => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })
  on('fs.list', async () => ({ value: [file('otro.result.json'), file('demo.result.json')] }))
  on('fs.read', async (_$, e) => {
    if (host.unreadable.some((n) => e.path.endsWith(n))) throw new Error(`EBUSY: ${e.path}`)
    if (e.path.endsWith('otro.result.json')) return { value: JSON.stringify({ ...RED, project: 'otro', cwd: 'C:\\Otro' }) }
    return { value: JSON.stringify(host.result) }
  })
  on('ui.log', async (_$, e) => {
    host.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', async (_$, e) => {
    host.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.suggest', async (_$, e) => {
    host.suggestions.push(e.text)
    return { isShown: true }
  })
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: 'respuesta' }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
}

async function start($: Engine, on: On, host: Host): Promise<MockClock> {
  const clock = mock.clock(on, { now: 1_000 })
  fakeHost(on, host)
  await $.session.start({ cwd: 'C:/Demo/src', surface: 'terminal', isInteractive: true })
  return clock
}

/** Un turno del bucle principal: empieza, opcionalmente edita y termina con respuesta. */
async function turn($: Engine, clock: MockClock, isEditing: boolean) {
  await $.turn.start({ text: 'haz algo', turnId: 't-1' })
  if (isEditing) await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: 'C:/Demo/src/app.ts', old_string: 'a', new_string: 'b' } as never)
  await $.turn.complete({ reason: 'answer', answer: 'hecho', durationMs: 10, isAborted: false, turnId: 't-1' } as never)
  await clock.advance(1)
}

test('sin ediciones en el turno no comprueba ni avisa', async ($, on) => {
  const host = newHost({ porcelain: ' M app.ts\n', result: RED })
  const clock = await start($, on, host)
  await turn($, clock, false)
  expect(host.toasts).toHaveLength(0)
  expect(host.suggestions).toHaveLength(0)
})

test('con tests en rojo avisa y sugiere arreglarlos', async ($, on) => {
  const host = newHost({ porcelain: ' M app.ts\n?? nuevo.ts\n', result: RED })
  const clock = await start($, on, host)
  await turn($, clock, true)
  expect(host.toasts).toEqual(['Cierre: tests ✗ 2 fallos · 2 ficheros sin commitear'])
  expect(host.suggestions).toEqual(['Arregla los tests en rojo (suma, resta) antes de seguir.'])
})

test('limpio y en verde no sugiere nada', async ($, on) => {
  const host = newHost({ porcelain: '', result: { ...RED, status: 'passed', failed_tests: [], failed_total: 0 } })
  const clock = await start($, on, host)
  await turn($, clock, true)
  expect(host.toasts).toHaveLength(0)
  expect(host.suggestions).toHaveLength(0)
})

test('si git falla se omite esa comprobación y el resto sigue', async ($, on) => {
  const host = newHost({ isGitBroken: true, result: RED })
  const clock = await start($, on, host)
  await turn($, clock, true)
  expect(host.toasts).toEqual(['Cierre: tests ✗ 2 fallos'])
})

test('un result.json ilegible de otro proyecto no oculta el rojo del cwd', async ($, on) => {
  const host = newHost({ result: RED, unreadable: ['otro.result.json'] })
  const clock = await start($, on, host)
  await turn($, clock, true)
  expect(host.toasts).toEqual(['Cierre: tests ✗ 2 fallos'])
  expect(host.logs.some((l) => l.includes('otro.result.json'))).toBe(true)
})

test('state.json ilegible no descarta el rojo', async ($, on) => {
  const host = newHost({ result: RED, hasState: true, unreadable: ['demo.state.json'] })
  const clock = await start($, on, host)
  await turn($, clock, true)
  expect(host.toasts).toEqual(['Cierre: tests ✗ 2 fallos'])
  expect(host.logs.some((l) => l.includes('demo.state.json'))).toBe(true)
})

test('solo cambios sin commitear sugiere el commit', () => {
  expect(closingNotice({ tests: null, dirtyCount: 1 })).toEqual({
    toast: 'Cierre: 1 fichero sin commitear',
    suggestion: 'Haz commit de los cambios con conventional commits.',
  })
})

test('lectura robusta: JSON roto o sin forma mínima no cuenta como resultado', () => {
  expect(parseResult('{no json')).toBeNull()
  expect(parseResult(JSON.stringify({ project: 'x' }))).toBeNull()
  expect(countPorcelain(' M a\r\n?? b\r\n\r\n')).toBe(2)
})

test('más de tres tests caídos se resumen', () => {
  const tests = parseResult(JSON.stringify({ ...RED, failed_tests: ['a', 'b', 'c', 'd', 'e'], failed_total: 5 }))
  expect(closingNotice({ tests, dirtyCount: 0 })?.suggestion).toBe('Arregla los tests en rojo (a, b, c y 2 más) antes de seguir.')
})
