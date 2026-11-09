import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { diffBody, lineTone, mergeFiles, parseNumstat, parseStatus, relToRoot, turnChanges } from '../hooks/git'

const STATUS = '## main...origin/main [ahead 2, behind 1]\n M src/app.ts\n?? "docs/con espacio.md"\nR  viejo.ts -> nuevo.ts\n'
const NUMSTAT = '10\t2\tsrc/app.ts\n-\t-\tlogo.png\n3\t0\t{viejo.ts => nuevo.ts}\n'

test('lee rama, adelanto, retraso y ficheros del porcelain', () => {
  const s = parseStatus(STATUS)
  expect(s).toMatchObject({ branch: 'main', ahead: 2, behind: 1 })
  expect(s.files).toEqual([
    { path: 'src/app.ts', code: 'M' },
    { path: 'docs/con espacio.md', code: '??' },
    { path: 'nuevo.ts', code: 'R' },
  ])
  expect(parseStatus('## No commits yet on main\n').branch).toBe('main')
})

test('cruza numstat con el estado, con binarios y renombrados', () => {
  const n = parseNumstat(NUMSTAT)
  expect(n.get('logo.png')).toEqual({ added: 0, deleted: 0, isBinary: true })
  const files = mergeFiles(parseStatus(STATUS).files, n)
  expect(files[0]).toMatchObject({ added: 10, deleted: 2 })
  expect(files[2]).toMatchObject({ path: 'nuevo.ts', added: 3 })
})

test('solo cuenta en el turno los ficheros del repo con cambios', () => {
  expect(relToRoot('C:\\Repo\\src\\app.ts', 'C:/Repo')).toBe('src/app.ts')
  expect(relToRoot('C:\\Repo2\\x.ts', 'C:/Repo')).toBeNull()
  const snapshot = { root: 'C:/Repo', branch: 'main', ahead: 0, behind: 0, files: mergeFiles(parseStatus(STATUS).files, parseNumstat(NUMSTAT)) }
  const turn = turnChanges(snapshot, ['c:/repo/src/app.ts', 'c:/repo/limpio.ts', 'd:/fuera/x.ts'])
  expect(turn.map((f) => f.path)).toEqual(['src/app.ts'])
})

test('el diff queda sin cabecera y con color por línea', () => {
  const lines = diffBody('diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-viejo\n+nuevo\n')
  expect(lines).toEqual(['@@ -1 +1 @@', '-viejo', '+nuevo'])
  expect(lines.map(lineTone)).toEqual(['suggestion', 'error', 'success'])
  expect(lineTone('+++ b/x')).toBeUndefined()
})

/** Sesión en C:/Repo con git simulado; `isRepo` false hace fallar rev-parse. */
async function session($: Engine, on: On, isRepo = true) {
  const clock = mock.clock(on, { now: 0 })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', async () => ({ value: 'C:/Repo' }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('process.run', async (_$, e) => {
    const sub = e.argv[1]
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (!isRepo) return { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
    if (sub === 'rev-parse') return ok('C:/Repo\n')
    if (sub === 'status') return ok(STATUS)
    return ok(NUMSTAT)
  })
  on('tool.call', async () => ({ result: 'ok' }) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($e, e, next) => next(e))
  on('ui.render', { component: 'Pane' }, ($e, e, next) => next(e))
  await $.session.start({ cwd: 'C:/Repo', surface: 'terminal', isInteractive: true })
  await clock.advance(1)
  return clock
}

const band = ($: Engine) =>
  $.ui.mount({ plugin: 'ultron-git', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 80 } } as never)

test('tras editar un fichero, la franja resume el turno', async ($, on) => {
  const clock = await session($, on)
  await $.tool.call({ tool: 'Edit', tool_use_id: 't1', file_path: 'C:\\Repo\\src\\app.ts', old_string: 'a', new_string: 'b' } as never)
  await clock.advance(1)
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: 'turno · 1 fichero · +10 −2' })).toBeDefined()
  await ui.unmount()
})

test('fuera de un repo el panel enseña el error real de git', async ($, on) => {
  await session($, on, false)
  const ui = await $.ui.mount({ plugin: 'ultron-git', surface: 'terminal', component: 'Pane', requestId: 'git', props: { bodyColumns: 80 } } as never)
  expect(await ui.find({ type: 'Text', text: 'git no responde aquí: fatal: not a git repository' })).toBeDefined()
  await ui.unmount()
})
