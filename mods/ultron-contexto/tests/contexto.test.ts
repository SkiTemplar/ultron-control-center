import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement, SessionMessage } from 'claude-code'

import { toConversation } from '../hooks/analysis'
import { segments } from '../hooks/view'

const read = (path: string, text: string) => ({
  tool_use_id: `t-${path}-${text.length}`,
  tool: 'Read',
  input: { file_path: path },
  text,
})

const MESSAGES: SessionMessage[] = [
  { role: 'user', text: 'mira esto', toolUses: [] },
  {
    role: 'assistant',
    text: 'voy',
    toolUses: [read('C:/repo/a.ts', 'x'.repeat(4000)), read('C:/repo/a.ts', 'x'.repeat(4000)), read('C:/repo/b.ts', 'y'.repeat(100))],
  },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'b1', tool: 'Bash', input: { command: 'npm test' }, text: 'z'.repeat(2000) }],
  },
]

test('reparte los tokens de mensajes y señala las relecturas', () => {
  const conv = toConversation(MESSAGES, 10_000)
  const total = conv.byKind.reduce((sum, item) => sum + item.tokens, 0)
  expect(Math.abs(total - 10_000)).toBeLessThanOrEqual(conv.byKind.length)
  expect(conv.byKind[0]?.label).toBe('Read')
  expect(conv.rereads).toHaveLength(1)
  expect(conv.rereads[0]?.count).toBe(2)
  expect(conv.rereads[0]?.detail).toBe('C:/repo/a.ts')
})

test('sin relecturas no hay sección de relecturas', () => {
  const conv = toConversation([MESSAGES[2] as SessionMessage], 1_000)
  expect(conv.rereads).toHaveLength(0)
  expect(conv.heaviest[0]?.detail).toBe('npm test')
})

test('la barra ocupa exactamente el ancho y deja fuera lo diferido', () => {
  const cats = [
    { name: 'System prompt', tokens: 3_000, color: 'promptBorder', kind: 'used' },
    { name: 'Messages', tokens: 120_000, color: 'permission', kind: 'used' },
    { name: 'MCP diferido', tokens: 50_000, color: 'inactive', kind: 'deferred' },
    { name: 'Free space', tokens: 677_000, color: 'inactive', kind: 'free' },
    { name: 'Autocompact buffer', tokens: 200_000, color: 'warning', kind: 'buffer' },
  ]
  for (const width of [20, 57, 120]) {
    const cells = segments(cats, width).reduce((sum, s) => sum + [...s.text].length, 0)
    expect(cells).toBe(width)
  }
  expect(segments(cats, 40).some((s) => s.color === 'inactive' && s.text.includes('█'))).toBe(false)
})

test('/contexto abre el panel y pinta las categorías medidas', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { USERPROFILE: 'C:/Users/demo' })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('session.messages', async () => ({ value: MESSAGES }))
  on('session.usage', async () => ({
    value: {
      startedAt: 0,
      rateLimits: [],
      cost: { usd: 1.5 },
      context: {
        window: 1_000_000,
        tokens: 123_000,
        percent: 12,
        breakdown: {
          categories: [
            { name: 'Messages', tokens: 120_000, color: 'permission', kind: 'used', isDeferred: false },
            { name: 'Free space', tokens: 880_000, color: 'inactive', kind: 'free', isDeferred: false },
          ],
          totalTokens: 123_000,
          maxTokens: 1_000_000,
          rawMaxTokens: 1_000_000,
          percentage: 12,
          gridRows: [],
          model: 'claude-opus-5-5',
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          isAutoCompactEnabled: false,
          apiUsage: null,
        },
      },
    } as never,
  }))

  await $.session.start({ cwd: 'C:/demo', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'contexto', args: '' } as never)
  await clock.advance(1)

  const ui = await $.ui.mount({
    plugin: 'ultron-contexto',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'contexto',
    props: { title: 'Contexto', isFocused: true, bodyColumns: 90, placement: 'inline', scroll: { offset: 0, bodyRows: 30 } } as never,
  })
  expect(await ui.find({ type: 'Text', text: /Messages/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /123,0k \/ 1,00M/ })).toBeDefined()
  await ui.press({ key: 'tab-conversacion' })
  expect(await ui.find({ type: 'Text', text: /C:\/repo\/a\.ts/ })).toBeDefined()
  await ui.unmount()
})

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 6 },
  view: {},
}

/** Monta la franja `renders` veces y devuelve lo que el mod pidió abrir. */
async function autoOpens($: Engine, on: On, isFullscreen: boolean, renders: number): Promise<unknown[]> {
  const opened: unknown[] = []
  const clock = mock.clock(on)
  mock.env(on, {})
  on('ui.render', { component: 'AbovePrompt' }, ($e, e) => {
    const { Text } = $e.ui.resolve(e)
    return h(Text, {}, 'franja del motor') as RenderElement
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', async (_$, e) => {
    opened.push(e)
    return { value: { isPlaced: true as const } }
  })
  await $.session.start({ cwd: 'C:/demo', surface: 'terminal', isInteractive: true })
  const viewport = { columns: 180, rows: 50, isFullscreen }
  for (let i = 0; i < renders; i++) {
    const ui = await $.ui.mount({ plugin: 'ultron-contexto', surface: 'terminal', component: 'AbovePrompt', props: BAND, viewport })
    await clock.advance(1)
    await ui.unmount()
  }
  return opened
}

test('en pantalla completa abre el panel una sola vez y sin foco', async ($, on) => {
  const opened = await autoOpens($, on, true, 2)
  expect(opened).toHaveLength(1)
  expect(opened[0]).toMatchObject({ id: 'contexto' })
  expect((opened[0] as { focus?: true }).focus).toBeUndefined()
})

test('fuera de pantalla completa no abre el panel por su cuenta', async ($, on) => {
  const opened = await autoOpens($, on, false, 1)
  expect(opened).toHaveLength(0)
})
