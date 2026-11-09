import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import type { AgentRow } from '../types'
import {
  META_TRIES,
  STALE_MS,
  foldJournal,
  groupByPhase,
  lastAssistantInTranscript,
  mergeJournal,
  parseJournal,
  parseLaunch,
  projectSlug,
  typeWithoutMeta,
  withLiveness,
} from '../hooks/workflows'

const started = (agentId: string, phase: string, label = `tarea:${agentId}`) =>
  JSON.stringify({ type: 'started', key: `v2:${agentId}`, agentId, label, phase })

test('el journal se lee aunque tenga líneas corruptas, y las cuenta', () => {
  const text = [
    '{"type":"launched"}',
    started('a1', 'Revisar'),
    '{"type":"result","key":"v2:a1","agentId":"a1","result":{"ok"',
    'no es json',
    '[1,2]',
    '',
    '{"type":"result","key":"v2:a1","agentId":"a1","result":{"hallazgos":3}}',
  ].join('\n')
  const { events, lineCount, badLines } = parseJournal(text)
  expect(lineCount).toBe(6)
  expect(badLines).toBe(3)
  expect(events.map((e) => e.type)).toEqual(['launched', 'started', 'result'])
  expect(foldJournal(events)).toEqual([
    { agentId: 'a1', label: 'tarea:a1', phase: 'Revisar', status: 'completed', result: '{ "hallazgos": 3 }' },
  ])
})

test('cada agente del journal lleva su estado: resultado, fallo o un tipo desconocido', () => {
  const text = [
    started('a1', 'Uno'),
    started('a2', 'Uno'),
    started('a3', 'Dos'),
    '{"type":"failed","key":"v2:a2","agentId":"a2"}',
    '{"type":"skipped","key":"v2:a3","agentId":"a3"}',
    '{"type":"result","key":"v2:a1","agentId":"a1","result":"hecho"}',
  ].join('\n')
  const agents = foldJournal(parseJournal(text).events)
  expect(agents.map((a) => `${a.agentId}:${a.status}:${a.result}`)).toEqual(['a1:completed:hecho', 'a2:failed:null', 'a3:skipped:null'])
})

const wfRow = (id: string, phase: string, status = 'running', startedAt = 0): AgentRow => ({
  id,
  type: 'code-reviewer',
  description: id,
  model: '',
  status,
  parentId: null,
  startedAt,
  endedAt: status === 'running' ? null : startedAt,
  source: 'workflow',
  runId: 'wf_1',
  phase,
  result: null,
  hasMeta: true,
  metaTries: 1,
})

test('los agentes se agrupan por fase en el orden en que aparece cada una', () => {
  const groups = groupByPhase([wfRow('a', 'Revisar'), wfRow('b', 'Corregir'), wfRow('c', 'Revisar'), wfRow('d', '')])
  expect(groups.map((g) => `${g.phase}:${g.rows.map((r) => r.id).join('')}`)).toEqual(['Revisar:ac', 'Corregir:b', '(sin fase):d'])
})

test('fundir el journal actualiza sin mutar, añade los nuevos con su meta y no resucita los descartados', () => {
  const rows = [wfRow('a1', 'Uno')]
  const agents = foldJournal(parseJournal([started('a1', 'Uno'), started('a2', 'Dos'), started('a3', 'Dos'), '{"type":"result","agentId":"a1","result":"ok"}'].join('\n')).events)
  const meta = { agentType: 'Explore', description: 'leer', phase: 'Dos', model: 'claude-sonnet-5-5' }
  const merged = mergeJournal(rows, 'wf_1', agents, { a2: meta }, ['a3'], 7_000)
  expect(rows[0]?.status).toBe('running')
  expect(merged[0]).toMatchObject({ id: 'a1', status: 'completed', endedAt: 7_000, result: 'ok' })
  expect(merged[1]).toMatchObject({ id: 'a2', type: 'Explore', model: 'claude-sonnet-5-5', phase: 'Dos', source: 'workflow', hasMeta: true })
  expect(merged.map((r) => r.id)).not.toContain('a3')
  const unread = mergeJournal([], 'wf_1', agents, { a3: 'bad' }, [], 7_000)
  expect(unread.map((r) => `${r.id}:${r.type}:${r.hasMeta}`)).toEqual([
    'a1:(meta aún no escrita):false',
    'a2:(meta aún no escrita):false',
    'a3:(meta ilegible):false',
  ])
  expect(typeWithoutMeta('missing', META_TRIES)).toBe('(sin meta)')
})

test('sin señales en su transcript un agente pasa a «stale», y vuelve si el transcript crece', () => {
  const rows = [wfRow('a1', 'Uno', 'running', 1_000), wfRow('a2', 'Uno', 'completed', 1_000)]
  const quiet = withLiveness(rows, 'wf_1', { a1: 2_000 }, 2_000 + STALE_MS)
  expect(quiet[0]).toMatchObject({ status: 'stale', endedAt: 2_000 })
  expect(quiet[1]).toBe(rows[1])
  expect(withLiveness(rows, 'wf_1', { a1: 2_000 }, 2_000 + STALE_MS - 1)[0]).toBe(rows[0])
  const back = withLiveness(quiet, 'wf_1', { a1: 3_000 + STALE_MS }, 3_000 + STALE_MS)
  expect(back[0]).toMatchObject({ status: 'running', endedAt: null })
})

test('solo un lanzamiento local del tool Workflow se sigue', () => {
  const ok = { status: 'async_launched', taskId: 't1', taskType: 'local_workflow', workflowName: 'rev', runId: 'wf_1', transcriptDir: 'D:/x/wf_1' }
  expect(parseLaunch(ok)).toEqual({ runId: 'wf_1', name: 'rev', taskId: 't1', dir: 'D:/x/wf_1' })
  expect(parseLaunch({ ...ok, status: 'remote_launched' })).toBeNull()
  expect(parseLaunch({ ...ok, error: 'sintaxis' })).toBeNull()
  expect(parseLaunch('texto')).toBeNull()
  expect(projectSlug('C:\\Users\\demo\\.ultron')).toBe('C--Users-demo--ultron')
})

test('el final de un transcript de agente da su último texto o su salida estructurada', () => {
  const assistant = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Conclusión' }] } })
  const structured = JSON.stringify({ attachment: { type: 'structured_output', data: { veredicto: 'ok' } } })
  const user = JSON.stringify({ message: { role: 'user', content: 'gracias' } })
  expect(lastAssistantInTranscript([assistant, user, 'roto{'].join('\n'))).toBe('Conclusión')
  expect(lastAssistantInTranscript([assistant, structured, user].join('\n'))).toBe('{ "veredicto": "ok" }')
  expect(lastAssistantInTranscript(user)).toBeNull()
})

// ---- Integración: un run de workflow visto por el panel ----

const DIR = 'C:/Users/demo/.claude/projects/C--demo/s-1/subagents/workflows/wf_1'
const JOURNAL = `${DIR}/journal.jsonl`

const PANE_PROPS = { title: 'Agentes', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } }

const BAND = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} }

type Host = { files: Record<string, string>; mtimes: Record<string, number>; launch: Record<string, unknown>; reads: string[] }

const newHost = (files: Record<string, string>, launch: Record<string, unknown> = LAUNCH): Host => ({ files, mtimes: {}, launch, reads: [] })

const META = (phase: string) => JSON.stringify({ agentType: 'code-reviewer', description: 'x', workflowPhase: phase, model: 'claude-opus-5-5' })

/** El motor entrega las rutas con la barra del sistema: la prueba las compara con «/». */
const norm = (path: string): string => path.replace(/\\/g, '/')

/** Lista la carpeta simulada: tamaño del texto y la fecha que fije la prueba. */
function listing(host: Host, path: string) {
  const dir = `${norm(path)}/`
  return Object.entries(host.files)
    .filter(([p]) => p.startsWith(dir) && !p.slice(dir.length).includes('/'))
    .map(([p, text]) => ({ name: p.slice(dir.length), kind: 'file' as const, size: text.length, mtimeMs: host.mtimes[p] ?? 0, isLink: false }))
}

function fakeHost(on: On, host: Host) {
  mock.env(on, { USERPROFILE: 'C:\\Users\\demo' })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.id', async () => ({ value: 's-1' }))
  on('session.cwd', async () => ({ value: 'C:/demo' }))
  on('agent.list', async () => ({ value: [] }))
  on('fs.exists', async (_$, e) => ({ value: norm(e.path).endsWith('C--demo/s-1') }))
  on('fs.list', async (_$, e) => ({ value: listing(host, e.path) }))
  on('fs.read', async (_$, e) => {
    host.reads.push(norm(e.path))
    const text = host.files[norm(e.path)]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('tool.call', async (_$, e) => ({ result: (e.tool === 'Workflow' ? host.launch : 'ok') as never }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('ui.render', { component: 'AbovePrompt' }, ($e, e) => {
    const { Text } = $e.ui.resolve(e)
    return h(Text, {}, 'franja') as RenderElement
  })
}

const LAUNCH = { status: 'async_launched', taskId: 't1', taskType: 'local_workflow', workflowName: 'revision', runId: 'wf_1', transcriptDir: DIR }

async function start($: Engine, on: On, host: Host) {
  const clock = mock.clock(on, { now: 1_000 })
  fakeHost(on, host)
  await $.session.start({ cwd: 'C:/demo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'ultron-agentes', surface: 'terminal', component: 'AbovePrompt', props: BAND, viewport: { columns: 180, rows: 50, isFullscreen: true } })
  await clock.advance(1)
  await band.unmount()
  await $.tool.call({ tool: 'Workflow', script: 'export const meta = {}' } as never)
  return clock
}

const mountPane = ($: Engine) =>
  $.ui.mount({ plugin: 'ultron-agentes', surface: 'terminal', component: 'Pane', requestId: 'agentes', props: PANE_PROPS as never })

const journalReads = (host: Host) => host.reads.filter((p) => p === JOURNAL).length

test('un workflow se pinta como grupo con sus agentes por fase, su herramienta y su resultado', async ($, on) => {
  const host = newHost({
    [JOURNAL]: ['{"type":"launched"}', started('a1', 'Revisar', 'revisar:api'), started('a2', 'Revisar', 'revisar:ui'), '{roto'].join('\n'),
    [`${DIR}/agent-a1.meta.json`]: META('Revisar'),
    [`${DIR}/agent-a2.meta.json`]: META('Revisar'),
  })
  const clock = await start($, on, host)
  await $.tool.call({ tool: 'Read', file_path: 'C:/repo/api.ts', agentId: 'a1' } as never)
  await clock.advance(1_000)

  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: '⧉ revision · fase Revisar' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /2 activos · 0 terminados/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /1 líneas ilegibles/ })).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'agente-a1', text: /code-reviewer .*opus 5\.5.*1 herr\./ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /→ Read api\.ts/ })).toBeDefined()

  host.files[JOURNAL] += `\n{"type":"result","agentId":"a1","result":{"veredicto":"bien"}}\n{"type":"failed","agentId":"a2"}`
  await clock.advance(1_000)
  expect(await pane.find({ type: 'Text', text: /0 activos · 2 terminados/ })).toBeDefined()

  await pane.press({ key: 'agente-a1' })
  expect(await pane.find({ type: 'Text', text: /workflow revision · fase Revisar/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '{ "veredicto": "bien" }' })).toBeDefined()
  await pane.press({ key: 'volver' })

  await pane.press({ key: 'agente-a2' })
  expect(await pane.find({ type: 'Text', text: /^No se pudo leer el transcript: / })).toBeDefined()
  await pane.unmount()
})

test('un agente con «started» y sin cierre no deja el run abierto para siempre, y el journal quieto no se relee', async ($, on) => {
  const transcript = `${DIR}/agent-a1.jsonl`
  const host = newHost({ [JOURNAL]: ['{"type":"launched"}', started('a1', 'Revisar')].join('\n'), [`${DIR}/agent-a1.meta.json`]: META('Revisar'), [transcript]: '{}' })
  host.mtimes[transcript] = 1_000
  const clock = await start($, on, host)
  await clock.advance(1_000)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: /1 trabajando/ })).toBeDefined()

  await clock.advance(STALE_MS + 1_000)
  expect(journalReads(host)).toBe(1)
  expect(await pane.find({ type: 'Text', text: /nadie trabajando/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /0 activos · 1 terminados .*run cerrado/ })).toBeDefined()

  host.mtimes[transcript] = clock.now()
  await clock.advance(6_000)
  expect(await pane.find({ type: 'Text', text: /1 trabajando/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /run cerrado/ })).toBeUndefined()
  await pane.unmount()
})

test('sin transcriptDir la carpeta se deriva; el run quieto se cierra y se reabre si el journal vuelve a crecer', async ($, on) => {
  const host = newHost({ [JOURNAL]: '{"type":"launched"}', [`${DIR}/agent-a9.meta.json`]: META('Corregir') }, { ...LAUNCH, transcriptDir: undefined })
  const clock = await start($, on, host)
  await clock.advance(1_000)
  expect(host.reads).toContain(JOURNAL)
  await clock.advance(31_000)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: /run cerrado/ })).toBeDefined()

  host.files[JOURNAL] += `\n${started('a9', 'Corregir')}`
  await clock.advance(6_000)
  expect(await pane.find({ type: 'Text', text: /run cerrado/ })).toBeUndefined()
  expect(await pane.find({ type: 'Button', key: 'agente-a9' })).toBeDefined()
  await pane.unmount()
})

test('«limpiar terminados» con el run en curso no se deshace en el siguiente sondeo', async ($, on) => {
  const host = newHost({
    [JOURNAL]: [started('a1', 'Uno'), started('a2', 'Uno'), '{"type":"result","agentId":"a1","result":"ok"}'].join('\n'),
    [`${DIR}/agent-a1.meta.json`]: META('Uno'),
    [`${DIR}/agent-a2.meta.json`]: META('Uno'),
  })
  const clock = await start($, on, host)
  await clock.advance(1_000)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Button', key: 'agente-a1' })).toBeDefined()
  await pane.press({ key: 'limpiar' })
  host.files[JOURNAL] += `\n${started('a3', 'Dos')}`
  await clock.advance(3_000)
  expect(await pane.find({ type: 'Button', key: 'agente-a1' })).toBeUndefined()
  expect(await pane.find({ type: 'Button', key: 'agente-a2' })).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'agente-a3' })).toBeDefined()
  await pane.unmount()
})

test('la meta que aún no está escrita se reintenta y la fila lo dice mientras tanto', async ($, on) => {
  const host = newHost({ [JOURNAL]: started('a1', 'Uno') })
  const clock = await start($, on, host)
  await clock.advance(1_000)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Button', key: 'agente-a1', text: /\(meta aún no escrita\)/ })).toBeDefined()
  host.files[`${DIR}/agent-a1.meta.json`] = META('Uno')
  await clock.advance(1_000)
  expect(await pane.find({ type: 'Button', key: 'agente-a1', text: /code-reviewer .*opus 5\.5/ })).toBeDefined()
  await pane.unmount()
})

test('un lanzamiento sin runId ni carpeta no se sigue en silencio: el panel lo dice', async ($, on) => {
  const host = newHost({}, { status: 'async_launched', taskId: 't9', workflowName: 'huérfano' })
  const clock = await start($, on, host)
  await clock.advance(1_000)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: /no devolvió runId/ })).toBeDefined()
  expect(host.reads).toHaveLength(0)
  await pane.unmount()
})
