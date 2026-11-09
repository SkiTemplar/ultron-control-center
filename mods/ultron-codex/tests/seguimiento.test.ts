import { expect, test } from 'claude-code/testing'

import { MAX_POLL_FAILURES } from '../hooks/codex'
import { SCRIPT, job, mountPane, newHost, review, start, statusJson, statusRuns } from './fixtures'

const GIT_ERROR = 'This command must run inside a Git repository.'

test('si /codex-review falla antes de crear el trabajo, el error real sigue en el panel tras los refrescos', async ($, on) => {
  const host = newHost({ review: { code: 1, stderr: `${GIT_ERROR}\n`, ms: 0, statusAtEnd: null } })
  const clock = await start($, on, host)
  const result = await $.command.run({ command: 'codex-review', args: '' } as never)
  expect(result.text).toMatch(/Revisión de Codex/)
  await clock.advance(2_000)
  expect(statusRuns(host)).toBeGreaterThan(0)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: /Codex falló \(código 1\): This command must run inside a Git repository\./ })).toBeDefined()
  await pane.press({ key: 'descartar' })
  expect(await pane.find({ type: 'Text', text: /inside a Git repository/ })).toBeUndefined()
  await pane.unmount()
})

test('si task falla y status funciona, el error de lanzamiento no se borra al refrescar', async ($, on) => {
  const host = newHost({ taskFailure: 'Unsupported reasoning effort "turbo".' })
  const clock = await start($, on, host)
  const result = await $.command.run({ command: 'codex', args: '--effort turbo hola' } as never)
  expect(result.text).toMatch(/Unsupported reasoning effort/)
  const pane = await mountPane($)
  await pane.press({ key: 'refrescar' })
  await clock.advance(4_000)
  expect(statusRuns(host)).toBe(2)
  expect(await pane.find({ type: 'Text', text: /Codex falló \(código 1\): Unsupported reasoning effort/ })).toBeDefined()
  await pane.unmount()
})

test('Cancelar ejecuta cancel con el id del trabajo y lo avisa en el panel', async ($, on) => {
  const host = newHost({ status: statusJson([job('t-5', 'running')], []) })
  const clock = await start($, on, host)
  await $.command.run({ command: 'codex', args: '' } as never)
  await clock.advance(10)
  const pane = await mountPane($)
  await pane.press({ key: 'job-t-5' })
  await pane.press({ key: 'cancelar' })
  expect(host.runs).toContainEqual(['node', SCRIPT, 'cancel', 't-5', '--json'])
  expect(await pane.find({ type: 'Text', text: /Codex t-5 cancelado/ })).toBeDefined()
  await pane.unmount()
})

test('la fila de un trabajo terminado muestra el inicio del prompt, no la primera línea de la salida', async ($, on) => {
  const host = newHost({ status: statusJson([], [job('t-1', 'completed'), job('t-new', 'completed', { request: undefined })]) })
  const clock = await start($, on, host)
  await $.command.run({ command: 'codex', args: 'mi prompt especial\nsegunda línea' } as never)
  await clock.advance(10)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: /revisar t-1/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /mi prompt especial segunda línea/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Salida de/ })).toBeUndefined()
  await pane.unmount()
})

test('el sondeo no lanza otro status mientras uno sigue en curso', async ($, on) => {
  const host = newHost({ status: statusJson([job('t-5', 'running')], []) })
  const clock = await start($, on, host)
  await $.command.run({ command: 'codex', args: '' } as never)
  await clock.advance(10)
  expect(statusRuns(host)).toBe(1)
  host.statusDelayMs = 10_000
  await clock.advance(9_000)
  expect(statusRuns(host)).toBe(2)
  host.statusDelayMs = 0
  await clock.advance(6_000)
  expect(statusRuns(host)).toBeGreaterThan(2)
})

test('tras varios fallos seguidos de status el sondeo se detiene y el panel lo dice', async ($, on) => {
  const host = newHost({ status: statusJson([job('t-5', 'running')], []) })
  const clock = await start($, on, host)
  await $.command.run({ command: 'codex', args: '' } as never)
  await clock.advance(10)
  const before = statusRuns(host)
  host.statusFailure = 'status roto'
  await clock.advance(3_000 * (MAX_POLL_FAILURES + 3))
  expect(statusRuns(host) - before).toBe(MAX_POLL_FAILURES)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: /status roto\nSondeo automático detenido tras 5 fallos/ })).toBeDefined()
  await pane.press({ key: 'refrescar' })
  expect(statusRuns(host) - before).toBe(MAX_POLL_FAILURES + 1)
  await pane.unmount()
})

test('una revisión que nunca se vio en curso se anuncia una sola vez al salir el hijo', async ($, on) => {
  const host = newHost({
    status: statusJson([], []),
    review: { code: 0, stderr: '', ms: 5_000, statusAtEnd: statusJson([], [review('review-1', 'completed')]) },
  })
  const clock = await start($, on, host)
  await $.command.run({ command: 'codex-review', args: '' } as never)
  await clock.advance(4_000)
  expect(statusRuns(host)).toBeGreaterThanOrEqual(2)
  expect(host.toasts).toEqual([])
  await clock.advance(2_000)
  expect(host.toasts).toEqual(['Codex review-1 terminado'])
  await clock.advance(9_000)
  expect(host.toasts).toEqual(['Codex review-1 terminado'])
})
