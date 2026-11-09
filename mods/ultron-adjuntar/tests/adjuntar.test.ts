import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import { mentionOf, rank } from '../hooks/files'

test('la mención es relativa dentro del proyecto y va entre comillas con espacios', () => {
  expect(mentionOf('C:\\demo\\src\\app.ts', 'C:/demo')).toBe('@src/app.ts')
  expect(mentionOf('C:/Users/demo/Downloads/Informe final.pdf', 'C:/demo')).toBe(
    '@"C:/Users/demo/Downloads/Informe final.pdf"',
  )
  expect(mentionOf('C:/demo-otro/x.ts', 'C:/demo')).toBe('@C:/demo-otro/x.ts')
})

test('la búsqueda exige todas las palabras y prioriza el nombre del fichero', () => {
  const paths = ['docs/kanban.md', 'src/kanban/view.tsx', 'src/view/kanban-old/readme.md', 'src/other.ts']
  const { paths: best, total } = rank(paths, 'kanban view', 10)
  expect(total).toBe(2)
  expect(best[0]).toBe('src/kanban/view.tsx')
  expect(rank(paths, 'nada', 10).total).toBe(0)
})

function fakeHost(on: On, filled: string[]) {
  mock.env(on, { USERPROFILE: 'C:/Users/demo' })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.cwd', async () => ({ value: 'C:/demo' }))
  on('ui.toast', async () => ({ value: undefined }))
  on('fs.exists', async () => ({ value: true }))
  on('fs.list', async () => ({
    value: [
      { name: 'vieja.png', kind: 'file' as const, size: 10, mtimeMs: 1_000, isLink: false },
      { name: 'desktop.ini', kind: 'file' as const, size: 1, mtimeMs: 9_000, isLink: false },
      { name: 'Captura reciente.png', kind: 'file' as const, size: 20, mtimeMs: 5_000, isLink: false },
    ],
  }))
  on('prompt.fill', async (_$, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
}

test('/captura adjunta la captura más reciente e ignora desktop.ini', async ($, on) => {
  const filled: string[] = []
  mock.clock(on, { now: 65_000 })
  fakeHost(on, filled)
  await $.session.start({ cwd: 'C:/demo', surface: 'terminal', isInteractive: true })
  const result = await $.command.run({ command: 'captura', args: '' } as never)
  expect(result.text).toBeUndefined()
  expect(filled).toEqual(['@"C:/Users/demo/Pictures/Screenshots/Captura reciente.png" '])
})

test('/captura 2 adjunta las dos últimas en orden', async ($, on) => {
  const filled: string[] = []
  mock.clock(on, { now: 65_000 })
  fakeHost(on, filled)
  await $.session.start({ cwd: 'C:/demo', surface: 'terminal', isInteractive: true })
  const result = await $.command.run({ command: 'captura', args: '2' } as never)
  expect(result.text).toBeUndefined()
  expect(filled[0]).toBe(
    '@"C:/Users/demo/Pictures/Screenshots/Captura reciente.png" @C:/Users/demo/Pictures/Screenshots/vieja.png ',
  )
})

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 6 },
  view: {},
}

/** Monta la franja `renders` veces; devuelve lo que se pidió abrir y las órdenes lanzadas. */
async function autoOpens($: Engine, on: On, isFullscreen: boolean, renders: number) {
  const opened: unknown[] = []
  const runs: string[][] = []
  // La lista del proyecto se cachea 60 s desde el instante 0: el reloj arranca después.
  const clock = mock.clock(on, { now: 120_000 })
  fakeHost(on, [])
  on('ui.render', { component: 'AbovePrompt' }, ($e, e) => {
    const { Text } = $e.ui.resolve(e)
    return h(Text, {}, 'franja del motor') as RenderElement
  })
  on('ui.open', async (_$, e) => {
    opened.push(e)
    return { value: { isPlaced: true as const } }
  })
  on('process.run', async (_$, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: 'src/app.ts\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: 'C:/demo', surface: 'terminal', isInteractive: true })
  const viewport = { columns: 180, rows: 50, isFullscreen }
  for (let i = 0; i < renders; i++) {
    const ui = await $.ui.mount({ plugin: 'ultron-adjuntar', surface: 'terminal', component: 'AbovePrompt', props: BAND, viewport })
    await clock.advance(1)
    await ui.unmount()
  }
  return { opened, runs }
}

test('en pantalla completa abre el buscador una vez, sin foco, y carga el proyecto', async ($, on) => {
  const { opened, runs } = await autoOpens($, on, true, 2)
  expect(opened).toHaveLength(1)
  expect(opened[0]).toMatchObject({ id: 'adjuntar' })
  expect((opened[0] as { focus?: true }).focus).toBeUndefined()
  expect(runs.some((argv) => argv.includes('ls-files'))).toBe(true)
})

test('fuera de pantalla completa no abre el buscador por su cuenta', async ($, on) => {
  const { opened } = await autoOpens($, on, false, 1)
  expect(opened).toHaveLength(0)
})
