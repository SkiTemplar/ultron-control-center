import { expect, test } from 'claude-code/testing'

import type { CodexJob } from '../types'
import {
  MAX_POLL_FAILURES,
  SLOW_POLL_MS,
  STALE_MS,
  cancelArgv,
  finishedSince,
  messageForClaude,
  parseResult,
  parseStatus,
  parseTaskArgs,
  pickLatestVersion,
  promptOf,
  rememberPrompt,
  resultArgv,
  reviewArgv,
  shouldPoll,
  statusArgv,
  taskCall,
} from '../hooks/codex'
import { SCRIPT, job, mountPane, newHost, start, statusJson } from './fixtures'

test('status: en curso primero, sin duplicados y con duración o tiempo transcurrido', () => {
  const jobs = parseStatus(statusJson([job('t-1', 'running')], [job('t-2', 'completed', { write: true }), job('t-3', 'failed')]))
  expect(jobs.map((j) => `${j.id}:${j.status}:${j.time}`)).toEqual(['t-1:running:12s', 't-2:completed:1m 3s', 't-3:failed:1m 3s'])
  expect(jobs[0]).toMatchObject({ kind: 'rescue', summary: 'revisar t-1', prompt: 'revisar t-1', isWrite: false, isReview: false })
  expect(jobs[1]).toMatchObject({ summary: 'Salida de t-2', prompt: 'revisar t-2' })
  expect(jobs[1]!.isWrite).toBe(true)
})

test('status: una salida que no es JSON o sin listas es un error explícito', () => {
  expect(() => parseStatus('Traceback: algo')).toThrow(/no devolvió JSON/)
  expect(() => parseStatus('{"running":null}')).toThrow(/faltan las listas/)
})

test('result: rawOutput en tareas, rendered en revisiones y errorMessage si falló', () => {
  const task = parseResult(JSON.stringify({ job: job('t-1', 'completed'), storedJob: { result: { rawOutput: 'hecho\n' }, rendered: 'otro' } }))
  expect(task).toEqual({ id: 't-1', status: 'completed', title: 'Codex Task', prompt: '', text: 'hecho' })
  const review = parseResult(
    JSON.stringify({ job: job('r-1', 'completed', { jobClass: 'review' }), storedJob: { result: { rawOutput: 'crudo' }, rendered: '# Review\nok' } }),
  )
  expect(review.text).toBe('# Review\nok')
  const failed = parseResult(JSON.stringify({ job: job('t-9', 'failed', { errorMessage: 'sin login' }), storedJob: null }))
  expect(failed.text).toBe('sin login')
  expect(() => parseResult('{"storedJob":{}}')).toThrow(/falta el trabajo/)
})

test('argv: el prompt con comillas y saltos de línea va como un único argumento tras --', () => {
  const prompt = 'revisa "foo" y \'bar\'\nsegunda línea\n--write no es una opción'
  const call = taskCall('node', SCRIPT, parseTaskArgs(prompt, false))
  expect(call).toEqual({ argv: ['node', SCRIPT, 'task', '--background', '--json', '--', prompt] })
  const write = taskCall('node', SCRIPT, parseTaskArgs('--model gpt-6-astra --effort high arregla "x"', true))
  expect(write.argv).toEqual(['node', SCRIPT, 'task', '--background', '--json', '--write', '--model', 'gpt-6-astra', '--effort', 'high', '--', 'arregla "x"'])
  const long = taskCall('node', SCRIPT, parseTaskArgs('x'.repeat(9_000), false))
  expect(long.argv).not.toContain('--')
  expect(long.stdin).toHaveLength(9_000)
})

test('argv: review, status, result y cancel', () => {
  expect(reviewArgv('node', SCRIPT)).toEqual(['node', SCRIPT, 'review', '--background', '--json', '--scope', 'working-tree'])
  expect(statusArgv('node', SCRIPT)).toEqual(['node', SCRIPT, 'status', '--all', '--json'])
  expect(resultArgv('node', SCRIPT, 't-1')).toEqual(['node', SCRIPT, 'result', 't-1', '--json'])
  expect(cancelArgv('node', SCRIPT, 't-1')).toEqual(['node', SCRIPT, 'cancel', 't-1', '--json'])
})

test('versión más alta del plugin, avisos de fin y mensaje para Claude recortado', () => {
  expect(pickLatestVersion(['1.0.4', '1.0.10', 'tmp', '0.9'])).toBe('1.0.10')
  expect(pickLatestVersion(['tmp'])).toBeNull()
  const before = parseStatus(statusJson([job('t-1', 'running'), job('t-2', 'running')], []))
  const after = parseStatus(statusJson([job('t-2', 'running')], [job('t-1', 'completed')]))
  expect(finishedSince(before, after).map((j) => j.id)).toEqual(['t-1'])
  const text = messageForClaude({ id: 't-1', status: 'completed', title: '', prompt: '', text: 'a'.repeat(7_000) })
  expect(text.startsWith('Resultado de Codex (t-1):\n\n')).toBe(true)
  expect(text).toContain('[recortado: 1000 caracteres más')
})

test('/codex lanza la tarea de solo lectura con el prompt íntegro y el estado del plugin', async ($, on) => {
  const host = newHost()
  await start($, on, host)
  const prompt = 'mira "esto"\ny esto'
  const result = await $.command.run({ command: 'codex', args: prompt } as never)
  expect(result.text).toBe('Codex t-new lanzado en segundo plano (solo lectura).')
  const task = host.runs.find((argv) => argv[2] === 'task')!
  expect(task).toEqual(['node', SCRIPT, 'task', '--background', '--json', '--', prompt])
  expect(host.envs[0]).toEqual({ CLAUDE_PLUGIN_DATA: 'C:/Users/demo/.claude/plugins/data/codex-openai-codex', CODEX_COMPANION_SESSION_ID: 'ses-1' })
})

test('/codex-write avisa en el panel de que puede modificar ficheros; sin prompt da error', async ($, on) => {
  const host = newHost()
  await start($, on, host)
  const empty = await $.command.run({ command: 'codex-write', args: '  ' } as never)
  expect(empty.text).toMatch(/falta el prompt/)
  expect(host.runs).toHaveLength(0)
  await $.command.run({ command: 'codex-write', args: 'arregla el test' } as never)
  expect(host.runs.find((argv) => argv[2] === 'task')).toContain('--write')
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: /CON ESCRITURA: puede modificar ficheros/ })).toBeDefined()
  await pane.unmount()
})

test('/codex-review lanza la revisión del working tree como hijo vivo', async ($, on) => {
  const host = newHost()
  const clock = await start($, on, host)
  const result = await $.command.run({ command: 'codex-review', args: '' } as never)
  await clock.advance(10)
  expect(result.text).toMatch(/Revisión de Codex/)
  expect(host.spawned).toEqual([['node', SCRIPT, 'review', '--background', '--json', '--scope', 'working-tree']])
})

test('sin el plugin openai-codex el panel enseña el error real y no ejecuta nada', async ($, on) => {
  const host = newHost({ isInstalled: false })
  await start($, on, host)
  const result = await $.command.run({ command: 'codex', args: 'hola' } as never)
  expect(result.text).toMatch(/plugin openai-codex no está instalado/)
  expect(host.runs).toHaveLength(0)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: /no existe C:\/Users\/demo\/\.claude\/plugins\/cache/ })).toBeDefined()
  await pane.unmount()
})

test('si node no arranca el panel lo dice', async ($, on) => {
  const host = newHost({ isNodeBroken: true })
  const clock = await start($, on, host)
  await $.command.run({ command: 'codex', args: '' } as never)
  await clock.advance(10)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: /no se pudo ejecutar node: .*ENOENT/ })).toBeDefined()
  await pane.unmount()
})

test('seleccionar un trabajo muestra su resultado y lo envía al prompt con cabecera', async ($, on) => {
  const host = newHost()
  const clock = await start($, on, host)
  await $.command.run({ command: 'codex', args: '' } as never)
  await clock.advance(10)
  const pane = await mountPane($)
  await pane.press({ key: 'job-t-1' })
  expect(host.runs.some((argv) => argv[2] === 'result' && argv[3] === 't-1')).toBe(true)
  expect(await pane.find({ type: 'Text', text: /Todo correcto en app\.ts/ })).toBeDefined()
  await pane.press({ key: 'enviar' })
  expect(host.filled).toEqual(['Resultado de Codex (t-1):\n\nTodo correcto en app.ts\n'])
  await pane.press({ key: 'volver' })
  expect(await pane.find({ key: 'job-t-1' })).toBeDefined()
  await pane.unmount()
})

test('si el prompt no acepta el texto se copia al portapapeles y se avisa', async ($, on) => {
  const host = newHost({ isFillRefused: true })
  const clock = await start($, on, host)
  await $.command.run({ command: 'codex', args: '' } as never)
  await clock.advance(10)
  const pane = await mountPane($)
  await pane.press({ key: 'job-t-1' })
  await pane.press({ key: 'enviar' })
  expect(host.copied[0]).toMatch(/^Resultado de Codex \(t-1\):/)
  expect(host.toasts.some((t) => /copiado al portapapeles/.test(t))).toBe(true)
  await pane.unmount()
})

test('al terminar un trabajo en curso salta el toast; sin trabajos en curso no se sondea', async ($, on) => {
  const host = newHost({ status: statusJson([job('t-5', 'running')], []) })
  const clock = await start($, on, host)
  await $.command.run({ command: 'codex', args: '' } as never)
  await clock.advance(10)
  const pane = await mountPane($)
  expect(await pane.find({ key: 'cancelar' })).toBeUndefined()
  await pane.press({ key: 'job-t-5' })
  expect(await pane.find({ key: 'cancelar' })).toBeDefined()
  host.status = statusJson([], [job('t-5', 'completed')])
  await clock.advance(3_000)
  expect(host.toasts).toContain('Codex t-5 terminado')
  const polls = host.runs.filter((argv) => argv[2] === 'status').length
  await clock.advance(9_000)
  expect(host.runs.filter((argv) => argv[2] === 'status').length).toBe(polls)
  await pane.unmount()
})

const parsedJob = (id: string, status: string, extra: Record<string, unknown> = {}): CodexJob =>
  parseStatus(statusJson([job(id, status, extra)], []))[0]!

test('la fila identifica el trabajo por su prompt aunque el companion haya pisado summary', () => {
  const done = parseStatus(statusJson([], [job('t-1', 'completed')]))[0]!
  expect(done.summary).toBe('Salida de t-1')
  expect(promptOf(done, {})).toBe('revisar t-1')
  const unknown = { ...done, prompt: '' }
  expect(promptOf(unknown, rememberPrompt({}, 't-1', 'mi prompt\n  largo'))).toBe('mi prompt largo')
  expect(promptOf(unknown, {})).toBe('Salida de t-1')
  expect(Object.keys(rememberPrompt({ a: 'x' }, 'b', '   '))).toEqual(['a'])
})

test('sondeo: no se solapa, se detiene tras varios fallos y frena con trabajos parados', () => {
  const now = Date.parse('2026-10-04T12:00:00Z')
  const fresh = parsedJob('t-1', 'running', { updatedAt: new Date(now - 60_000).toISOString() })
  const stale = parsedJob('t-2', 'running', { updatedAt: new Date(now - STALE_MS - 1).toISOString() })
  const base = { jobs: [fresh], now, lastPolledAt: now - 3_000, failures: 0, inFlight: 0, isReviewAlive: false }
  expect(shouldPoll(base)).toBe(true)
  expect(shouldPoll({ ...base, inFlight: 1 })).toBe(false)
  expect(shouldPoll({ ...base, failures: MAX_POLL_FAILURES })).toBe(false)
  expect(shouldPoll({ ...base, jobs: [] })).toBe(false)
  expect(shouldPoll({ ...base, jobs: [], isReviewAlive: true })).toBe(true)
  expect(shouldPoll({ ...base, jobs: [stale] })).toBe(false)
  expect(shouldPoll({ ...base, jobs: [stale], lastPolledAt: now - SLOW_POLL_MS })).toBe(true)
})
