import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import { fmtDuration, nearestTurn, parseSocraticMode, pickVerb, turnSummary } from '../hooks/format'

test('con el tono por defecto el spinner dice lo que hace; con otro tono, su verbo', () => {
  expect(pickVerb(null, 'thinking', 0)).toBe('Razonando')
  expect(pickVerb({ id: 'ultron', isDefault: true, verbs: ['Procesando'] }, 'tool-use', 0)).toBe('Ejecutando')
  const cani = { id: 'cani', isDefault: false, verbs: ['Petándolo', 'Rulando'] }
  expect(pickVerb(cani, 'thinking', 0)).toBe('Petándolo')
  expect(pickVerb(cani, 'thinking', 20_000)).toBe('Rulando')
})

test('casa la línea de cierre con su turno aunque los relojes difieran un poco', () => {
  const turns = [
    { durationMs: 10_000, tools: 2, outputTokens: 900, costUsd: 0.12 },
    { durationMs: 64_000, tools: 7, outputTokens: 12_300, costUsd: 0.4 },
  ]
  expect(nearestTurn(turns, 64_400)?.tools).toBe(7)
  expect(nearestTurn(turns, 30_000)).toBeUndefined()
  expect(turnSummary(turns[1]!)).toBe('7 herramientas · 12,3k tok de salida · $0,400')
  expect(fmtDuration(64_000)).toBe('1m 4s')
})

test('el spinner reescribe la palabra y deja el resto al motor', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('ui.render', { component: 'Spinner' }, ($e, e) => {
    const { Text } = $e.ui.resolve(e)
    return h(Text, {}, `${e.props.word}${e.props.suffix}`) as RenderElement
  })
  const ui = await $.ui.mount({
    plugin: 'ultron-hud',
    surface: 'terminal',
    component: 'Spinner',
    props: { word: 'Sauteing', message: null, suffix: '…', mode: 'thinking' },
  })
  expect(await ui.find({ type: 'Text', text: 'Razonando…' })).toBeDefined()
  await ui.unmount()
})

/** Pinta el pie con el proyecto que devuelve el puente de ULTRON. */
async function footerWith($: Engine, on: On, socratic: string) {
  const clock = mock.clock(on, { now: 0 })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', async () => ({ value: 'C:/demo' }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('process.run', async () => ({
    value: {
      exitCode: 0,
      stdout: JSON.stringify({ id: 'demo', name: 'Demo', socratic, color: null, boardPath: null, ultronHome: 'C:/u' }),
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('ui.render', { component: 'SessionMode' }, ($e, e) => {
    const { Text } = $e.ui.resolve(e)
    return h(Text, {}, e.props.modes.join(' & ') || 'vacío') as RenderElement
  })
  await $.session.start({ cwd: 'C:/demo', surface: 'terminal', isInteractive: true })
  await clock.advance(1)
  return $.ui.mount({ plugin: 'ultron-hud', surface: 'terminal', component: 'SessionMode', props: { modes: ['focus'] } })
}

test('el pie enseña el modo socrático también cuando está apagado', async ($, on) => {
  const ui = await footerWith($, on, 'off')
  expect(await ui.find({ type: 'Text', text: 'focus & socrático off' })).toBeDefined()
  await ui.unmount()
})

test('el pie enseña el modo socrático activo', async ($, on) => {
  const ui = await footerWith($, on, 'uni')
  expect(await ui.find({ type: 'Text', text: 'focus & socrático uni' })).toBeDefined()
  await ui.unmount()
})

test('el argumento de /socratico: consulta, modo válido o inválido', () => {
  expect(parseSocraticMode('')).toBe('')
  expect(parseSocraticMode(' Light ')).toBe('light')
  expect(parseSocraticMode('estricto')).toBeNull()
})

/** Arranca la sesión con un proyecto en strict y apunta cada process.run. */
async function socraticSession($: Engine, on: On, exitCode = 0) {
  const clock = mock.clock(on, { now: 0 })
  const calls: string[][] = []
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', async () => ({ value: 'C:/demo' }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('process.run', async (_$, e) => {
    calls.push([...e.argv])
    const isBridge = e.argv.some((a) => a.endsWith('ultron.cjs'))
    const stdout = isBridge ? JSON.stringify({ id: 'demo', name: 'Demo', socratic: 'strict' }) : 'ok'
    return { value: { exitCode: isBridge ? 0 : exitCode, stdout, stderr: isBridge ? '' : 'boom', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: 'C:/demo', surface: 'terminal', isInteractive: true })
  await clock.advance(1)
  return calls
}

test('/socratico light lanza el script de ULTRON con el id y el modo', async ($, on) => {
  const calls = await socraticSession($, on)
  const result = await $.command.run({ command: 'socratico', args: 'light' } as never)
  expect(JSON.stringify(result)).toContain('strict → light')
  const call = calls.find((argv) => argv.some((a) => a.endsWith('project-socratic.mjs')))
  expect(call?.slice(-2)).toEqual(['demo', 'light'])
})

test('/socratico con un modo inválido no ejecuta nada y lo dice', async ($, on) => {
  const calls = await socraticSession($, on)
  const result = await $.command.run({ command: 'socratico', args: 'estricto' } as never)
  expect(JSON.stringify(result)).toContain('no válido')
  expect(calls.some((argv) => argv.some((a) => a.endsWith('project-socratic.mjs')))).toBe(false)
})

test('/socratico enseña el error del script si falla', async ($, on) => {
  await socraticSession($, on, 1)
  const result = await $.command.run({ command: 'socratico', args: 'off' } as never)
  expect(JSON.stringify(result)).toContain('No se pudo cambiar el modo: boom')
})
