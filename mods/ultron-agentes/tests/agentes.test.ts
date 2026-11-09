import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentStatus, On, RenderElement } from 'claude-code'

import type { Activity, AgentRow } from '../types'
import { capRows, describeTool, lastAssistantOf, ordered, shortModel, withStatuses, withTool } from '../hooks/agents'

const row = (id: string, parentId: string | null = null, status = 'running'): AgentRow => ({
  id,
  type: 'Explore',
  description: `tarea ${id}`,
  model: 'claude-sonnet-5-5',
  status,
  parentId,
  startedAt: 0,
  endedAt: null,
  source: 'subagent',
  runId: null,
  phase: '',
  result: null,
  hasMeta: true,
  metaTries: 0,
})

test('resume cada herramienta en pocas palabras', () => {
  expect(describeTool('Read', { file_path: 'C:\\repo\\src\\app.ts' })).toBe('Read app.ts')
  expect(describeTool('Bash', { command: 'npm test\necho fin' })).toBe('Bash npm test')
  expect(describeTool('mcp__ultron-memory__memory_recall', { query: 'mods' })).toBe('ultron-memory·memory_recall mods')
  expect(describeTool('TodoWrite', {})).toBe('TodoWrite')
  expect(shortModel('claude-opus-5-5[1m]')).toBe('opus 5.5')
})

test('el historial de herramientas es corto, no muta el original y guarda la última al final', () => {
  const empty: Record<string, Activity> = {}
  const filled = Array.from({ length: 10 }, (_, i) => `Read f${i}.ts`).reduce((acc, label) => withTool(acc, 'a', label), empty)
  expect(empty).toEqual({})
  expect(filled.a?.tools).toBe(10)
  expect(filled.a?.history).toHaveLength(8)
  expect(filled.a?.history.at(-1)).toBe('Read f9.ts')
  expect(filled.a?.history[0]).toBe('Read f2.ts')
})

test('el que deja de estar activo queda cerrado y los demás no cambian', () => {
  const rows = [row('a'), row('b')]
  const next = withStatuses(rows, [{ id: 'a', status: 'completed' }], 9_000)
  expect(next[0]).toMatchObject({ status: 'completed', endedAt: 9_000 })
  expect(next[1]).toBe(rows[1])
})

test('los estados del motor no tocan a los agentes de un workflow', () => {
  const wf: AgentRow = { ...row('w'), source: 'workflow', runId: 'wf_1' }
  expect(withStatuses([wf], [{ id: 'w', status: 'completed' }], 1)[0]).toBe(wf)
})

test('al recortar se van los terminados más antiguos, no los últimos añadidos', () => {
  const old = Array.from({ length: 119 }, (_, i): AgentRow => ({ ...row(`viejo-${i}`, null, 'completed'), endedAt: 1_000 + i }))
  const recent: AgentRow = { ...row('nuevo', null, 'completed'), source: 'workflow', runId: 'wf_1', endedAt: 9_000 }
  const live = row('vivo')
  const kept = capRows([...old, live, recent]).map((r) => r.id)
  expect(kept).toHaveLength(120)
  expect(kept).toContain('nuevo')
  expect(kept).toContain('vivo')
  expect(kept).not.toContain('viejo-0')
})

test('activos primero y cada hijo debajo de su padre', () => {
  const rows = [row('hecho', null, 'completed'), row('hijo', 'padre'), row('padre')]
  expect(ordered(rows).map(({ row: r, depth }) => `${r.id}:${depth}`)).toEqual(['padre:0', 'hijo:1', 'hecho:0'])
})

test('el extracto de un subagente es el último texto no vacío del asistente', () => {
  const messages = [
    { role: 'assistant', text: 'primero' },
    { role: 'user', text: 'sigue' },
    { role: 'assistant', text: 'final' },
    { role: 'assistant', text: '  ' },
  ]
  expect(lastAssistantOf(messages)).toBe('final')
  expect(lastAssistantOf([{ role: 'user', text: 'solo yo' }])).toBeNull()
})

const PANE_PROPS = { title: 'Agentes', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } }

const BAND = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} }

type HostState = {
  status: AgentStatus
  opened: unknown[]
  calls: Array<Record<string, unknown>>
  stopDeny: string | null
  isStopThrowing: boolean
  isListThrowing: boolean
}

const newState = (): HostState => ({ status: 'running', opened: [], calls: [], stopDeny: null, isStopThrowing: false, isListThrowing: false })

/** Motor simulado: lanza el subagente `sub-1` y deja que la prueba diga su estado. */
function fakeHost(on: On, state: HostState) {
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'sub-1' }))
  on('agent.list', async () => {
    if (state.isListThrowing) throw new Error('motor ocupado')
    return { value: [{ id: 'sub-1', description: 'Buscar el bug', type: 'Explore', status: state.status }] }
  })
  on('session.messages', async () => ({
    value: [
      { role: 'user' as const, text: 'Busca el bug', toolUses: [] },
      { role: 'assistant' as const, text: 'El bug está en app.ts:12.', toolUses: [] },
    ],
  }))
  on('tool.call', async (_$, e) => {
    state.calls.push(e as unknown as Record<string, unknown>)
    // Un hook de prueba que lanza se salta y el de abajo rechaza la llamada: es el rechazo de `$.tool.call`.
    if (e.tool === 'TaskStop' && state.isStopThrowing) throw new Error('sin TaskStop')
    if (e.tool === 'TaskStop' && state.stopDeny !== null) return { deny: state.stopDeny }
    return { result: 'ok' as never }
  })
  on('ui.open', async (_$, e) => {
    state.opened.push(e)
    return { value: { isPlaced: true as const } }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($e, e) => {
    const { Text } = $e.ui.resolve(e)
    return h(Text, {}, 'franja del motor') as RenderElement
  })
}

const SPAWN = {
  tool_use_id: 'tu-1',
  prompt: 'Busca el bug',
  description: 'Buscar el bug',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
}

async function startFullscreen($: Engine, on: On, state: HostState) {
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, {})
  fakeHost(on, state)
  await $.session.start({ cwd: 'C:/demo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({
    plugin: 'ultron-agentes',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: BAND,
    viewport: { columns: 180, rows: 50, isFullscreen: true },
  })
  await clock.advance(1)
  await band.unmount()
  return clock
}

const mountPane = ($: Engine) =>
  $.ui.mount({ plugin: 'ultron-agentes', surface: 'terminal', component: 'Pane', requestId: 'agentes', props: PANE_PROPS as never })

test('un subagente lanzado abre el panel y enseña qué está haciendo hasta que termina', async ($, on) => {
  const state = newState()
  const clock = await startFullscreen($, on, state)
  state.opened.length = 0

  await $.agent.spawn(SPAWN as never)
  await $.tool.call({ tool: 'Read', file_path: 'C:/repo/src/app.ts', agentId: 'sub-1' } as never)
  await clock.advance(5_000)

  expect(state.opened).toHaveLength(1)
  expect((state.opened[0] as { focus?: true }).focus).toBeUndefined()
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: /1 trabajando/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /→ Read app\.ts/ })).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'agente-sub-1', text: /Explore .*1 herr\./ })).toBeDefined()

  state.status = 'completed'
  await clock.advance(1_000)
  expect(await pane.find({ type: 'Text', text: /nadie trabajando/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /→ Read/ })).toBeUndefined()
  await pane.unmount()
})

test('al arrancar en pantalla completa abre el panel una sola vez y sin foco', async ($, on) => {
  const state = newState()
  const clock = await startFullscreen($, on, state)
  const band = await $.ui.mount({
    plugin: 'ultron-agentes',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: BAND,
    viewport: { columns: 180, rows: 50, isFullscreen: true },
  })
  await clock.advance(1)
  await band.unmount()

  expect(state.opened).toHaveLength(1)
  expect(state.opened[0]).toMatchObject({ id: 'agentes' })
  expect((state.opened[0] as { focus?: true }).focus).toBeUndefined()
})

test('fuera de pantalla completa un subagente no abre el panel por su cuenta', async ($, on) => {
  const state = newState()
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, {})
  fakeHost(on, state)
  await $.session.start({ cwd: 'C:/demo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({
    plugin: 'ultron-agentes',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: BAND,
    viewport: { columns: 180, rows: 50, isFullscreen: false },
  })
  await clock.advance(1)
  await band.unmount()
  await $.agent.spawn(SPAWN as never)
  await clock.advance(1)
  expect(state.opened).toHaveLength(0)
})

test('al pulsar un subagente se ve su detalle con historial y «volver» regresa a la lista', async ($, on) => {
  const state = newState()
  const clock = await startFullscreen($, on, state)
  await $.agent.spawn(SPAWN as never)
  await $.tool.call({ tool: 'Grep', pattern: 'TODO', agentId: 'sub-1' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'C:/repo/src/app.ts', agentId: 'sub-1' } as never)
  const pane = await mountPane($)

  await pane.press({ key: 'agente-sub-1' })
  expect(await pane.find({ type: 'Button', key: 'volver' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'sonnet 5.5' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'en curso' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'últimas herramientas (2)' })).toBeDefined()
  expect((await pane.findAll({ type: 'Text', text: /^→ / })).map((t) => t.text)).toEqual(['→ Read app.ts', '→ Grep TODO'])
  expect(await pane.find({ type: 'Text', text: 'todavía trabajando' })).toBeDefined()

  state.status = 'completed'
  await clock.advance(1_000)
  expect(await pane.find({ type: 'Text', text: 'El bug está en app.ts:12.' })).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'detener' })).toBeUndefined()

  await pane.press({ key: 'volver' })
  expect(await pane.find({ type: 'Button', key: 'volver' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /nadie trabajando/ })).toBeDefined()
  await pane.unmount()
})

test('«Detener» pide TaskStop con el id del subagente en curso', async ($, on) => {
  const state = newState()
  await startFullscreen($, on, state)
  await $.agent.spawn(SPAWN as never)
  const pane = await mountPane($)
  await pane.press({ key: 'agente-sub-1' })
  await pane.press({ key: 'detener' })
  expect(state.calls.find((c) => c.tool === 'TaskStop')).toMatchObject({ task_id: 'sub-1' })
  expect(await pane.find({ type: 'Text', text: 'Detención pedida al motor.' })).toBeDefined()
  await pane.unmount()
})

test('si el motor rechaza TaskStop el panel lo dice', async ($, on) => {
  const state = { ...newState(), stopDeny: 'no es una tarea en segundo plano' }
  await startFullscreen($, on, state)
  await $.agent.spawn(SPAWN as never)
  const pane = await mountPane($)
  await pane.press({ key: 'agente-sub-1' })
  await pane.press({ key: 'detener' })
  expect(await pane.find({ type: 'Text', text: /No se pudo detener: no es una tarea/ })).toBeDefined()
  await pane.unmount()
})

test('si TaskStop rechaza (sin tool o abortado) el panel lo dice', async ($, on) => {
  const state = { ...newState(), isStopThrowing: true }
  await startFullscreen($, on, state)
  await $.agent.spawn(SPAWN as never)
  const pane = await mountPane($)
  await pane.press({ key: 'agente-sub-1' })
  await pane.press({ key: 'detener' })
  expect(await pane.find({ type: 'Text', text: /^No se pudo detener: / })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Detención pedida al motor.' })).toBeUndefined()
  await pane.unmount()
})

test('si el sondeo falla el panel lo avisa, y el aviso se va cuando vuelve a ir bien', async ($, on) => {
  const state = { ...newState(), isListThrowing: true }
  const clock = await startFullscreen($, on, state)
  await $.agent.spawn(SPAWN as never)
  await clock.advance(1_000)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: /^No se pudo sondear: / })).toBeDefined()
  state.isListThrowing = false
  await clock.advance(1_000)
  expect(await pane.find({ type: 'Text', text: /No se pudo sondear/ })).toBeUndefined()
  await pane.unmount()
})
