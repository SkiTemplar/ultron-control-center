import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import type { UsoWindow } from '../types'
import { fiveHourLines, limitLine, newAlerts, tone, usageLine } from '../hooks/format'

const week = (over: Partial<UsoWindow> = {}): UsoWindow => ({
  kind: 'seven_day',
  used: 51,
  elapsedPct: 47.7,
  linearElapsedPct: 39.3,
  projectedPct: 107,
  isScheduled: true,
  isAlert: true,
  resetsAtMs: 4 * 86_400_000,
  runsOutLabel: 'mié 07 20:08',
  ...over,
})

const fiveHour = (over: Partial<UsoWindow> = {}): UsoWindow =>
  week({ kind: 'five_hour', used: 12, elapsedPct: 40, linearElapsedPct: 40, projectedPct: 30, isScheduled: false, isAlert: false, runsOutLabel: null, ...over })

test('uso y tiempo: la semanal añade el relativo solo con horario', () => {
  expect(usageLine(week())).toBe('uso 51 % · tiempo 39 % · relativo 48 %')
  expect(usageLine(week({ isScheduled: false }))).toBe('uso 51 % · tiempo 39 %')
  expect(usageLine(fiveHour({ isScheduled: true }))).toBe('uso 12 % · tiempo 40 %')
})

test('ritmo y hora del límite o «no llega»', () => {
  expect(limitLine(week())).toBe('ritmo 107 % · límite mié 07 20:08')
  expect(limitLine(fiveHour())).toBe('ritmo 30 % · límite no llega')
  expect(limitLine(fiveHour({ projectedPct: null }))).toBe('ritmo — · límite no llega')
})

test('lo que queda de la semana en ventanas de 5 h llenas', () => {
  expect(fiveHourLines(week({ used: 55 }), 372)).toEqual(['ventanas 5 h: quedan 1,7 de 3,7 (167 %)'])
  expect(fiveHourLines(week({ used: 100 }), 200)).toEqual(['ventanas 5 h: quedan 0,0 de 2,0 (0 %)'])
  expect(fiveHourLines(week(), null)).toEqual([])
})

test('el color: rojo si llega al límite, ámbar si va justo; sin techo absoluto', () => {
  expect(tone(week())).toBe('error')
  expect(tone(fiveHour())).toBe('success')
  expect(tone(fiveHour({ used: 30 }))).toBe('success')
  expect(tone(week({ runsOutLabel: null, projectedPct: 95 }))).toBe('warning')
})

test('solo avisa una vez por ventana en alerta', () => {
  expect(newAlerts([week(), week({ kind: 'five_hour', isAlert: false })], [])).toEqual(['seven_day'])
  expect(newAlerts([week()], ['seven_day'])).toEqual([])
})

const RUN_OK = { windows: [fiveHour(), week()], weekInFiveHourPct: 371.4 }

async function session($: Engine, on: On, run: { exitCode: number; stdout: string; stderr: string }, limits = 1) {
  const clock = mock.clock(on, { now: 0 })
  const toasts: string[] = []
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.usage', async () => ({
    value: {
      startedAt: 0,
      rateLimits: limits ? [{ kind: 'seven_day', percentUsed: 51, resetsAt: '2026-10-09T01:00:00Z' }] : [],
    },
  }) as never)
  on('process.run', async () => ({ value: { ...run, isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  on('ui.render', { component: 'Pane' }, ($e, e, next) => next(e))
  await $.session.start({ cwd: 'C:/demo', surface: 'terminal', isInteractive: true })
  await clock.advance(1)
  return toasts
}

async function pane($: Engine) {
  return $.ui.mount({ plugin: 'ultron-uso', surface: 'terminal', component: 'Pane', requestId: 'uso', props: { bodyColumns: 80 } } as never)
}

test('el panel pinta las dos ventanas en formato corto y avisa una vez', async ($, on) => {
  const toasts = await session($, on, { exitCode: 0, stdout: JSON.stringify(RUN_OK), stderr: '' })
  const ui = await pane($)
  for (const text of [
    '5 horas',
    'Semanal',
    'uso 12 % · tiempo 40 %',
    'ritmo 30 % · límite no llega',
    'uso 51 % · tiempo 39 % · relativo 48 %',
    'ritmo 107 % · límite mié 07 20:08',
    'ventanas 5 h: quedan 1,8 de 3,7 (182 %)',
  ]) {
    expect(await ui.find({ type: 'Text', text })).toBeDefined()
  }
  expect(toasts).toHaveLength(1)
  await ui.unmount()
})

test('si el puente falla, el panel enseña el error', async ($, on) => {
  await session($, on, { exitCode: 1, stdout: '', stderr: 'Error: usage-pace.js no encontrado\n  at x' })
  const ui = await pane($)
  expect(await ui.find({ type: 'Text', text: 'No se pudo calcular el ritmo: Error: usage-pace.js no encontrado' })).toBeDefined()
  await ui.unmount()
})

test('sin límites en la API no ejecuta el puente y lo explica', async ($, on) => {
  await session($, on, { exitCode: 0, stdout: '{}', stderr: '' }, 0)
  const ui = await pane($)
  expect(await ui.find({ type: 'Text', text: 'Sin datos de límites todavía: llegan con la primera respuesta de la API.' })).toBeDefined()
  await ui.unmount()
})
