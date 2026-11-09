import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

const BAND = { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 80 }
const FAILED_RUN = { exitCode: 1, stdout: '', stderr: 'sin motor', isStdoutTruncated: false, isStderrTruncated: false }

/** Arranca con un motor mínimo, monta la franja `renders` veces y devuelve lo que el mod pidió abrir. */
async function autoOpens($: Engine, on: On, isFullscreen: boolean, renders: number): Promise<unknown[]> {
  const opened: unknown[] = []
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, { USERPROFILE: 'C:/Users/demo' })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', async () => ({ value: 'C:/demo' }))
  on('session.id', async () => ({ value: 'ses-1' }))
  on('session.usage', async () => ({ value: { startedAt: 0, rateLimits: [] } }) as never)
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('process.run', async () => ({ value: FAILED_RUN }))
  on('fs.exists', async () => ({ value: false }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.panes', async () => ({ value: [] }))
  on('ui.open', async (_$, e) => {
    opened.push(e)
    return { value: { isPlaced: true as const } }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($e, e) => {
    const { Text } = $e.ui.resolve(e)
    return h(Text, {}, 'franja del motor') as RenderElement
  })
  await $.session.start({ cwd: 'C:/demo', surface: 'terminal', isInteractive: true })
  const viewport = { columns: 180, rows: 50, isFullscreen }
  for (let i = 0; i < renders; i++) {
    const ui = await $.ui.mount({ plugin: 'ultron-codex', surface: 'terminal', component: 'AbovePrompt', props: BAND, viewport } as never)
    await clock.advance(1)
    await ui.unmount()
  }
  return opened
}

test('en pantalla completa abre el panel al arrancar, una sola vez y sin foco', async ($, on) => {
  const opened = await autoOpens($, on, true, 2)
  expect(opened).toHaveLength(1)
  expect(opened[0]).toMatchObject({ id: 'codex' })
  expect((opened[0] as { focus?: true }).focus).toBeUndefined()
})

test('fuera de pantalla completa no abre el panel por su cuenta', async ($, on) => {
  const opened = await autoOpens($, on, false, 1)
  expect(opened).toHaveLength(0)
})
