import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { detectPlan, failureCount, firstProjectScript, outcomeContext, outcomeToast } from '../hooks/stack'

const ROOT = 'C:/Demo'

type Host = {
  files: Record<string, string>
  run: { exitCode: number; stdout: string; ms: number }
  runs: string[][]
  toasts: string[]
  statuses: Array<string | undefined>
  /** Contenido de un result.json de run-project-tests; null = no hay. */
  ultronResult: string | null
  spawned: string[][]
}

const newHost = (files: Record<string, string>, over: Partial<Host> = {}): Host => ({
  files,
  run: { exitCode: 0, stdout: 'ok', ms: 2_000 },
  runs: [],
  toasts: [],
  statuses: [],
  ultronResult: null,
  spawned: [],
  ...over,
})

/** Ruta relativa a la raíz falsa, venga como venga del host (barras invertidas, mayúsculas). */
const relative = (path: string): string => path.replace(/\\/g, '/').replace(/^c:\/demo\//i, '')

function fakeHost(on: On, host: Host, clock: MockClock) {
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', async () => ({ value: ROOT }))
  on('session.root', async () => ({ value: ROOT }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  const isRuns = (path: string) => relative(path).endsWith('.tmp/run-tests')
  on('fs.exists', async (_$, e) => ({ value: relative(e.path) in host.files || (isRuns(e.path) && host.ultronResult !== null) }))
  on('fs.list', async () => ({ value: [{ name: 'demo.result.json', kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false }] }))
  on('fs.read', async (_$, e) => ({ value: relative(e.path).endsWith('.result.json') ? (host.ultronResult ?? '') : (host.files[relative(e.path)] ?? '') }))
  on('process.spawn', async function* (_$, e) {
    host.spawned.push([...e.argv])
    await clock.sleep(host.run.ms)
    yield { stream: 'stderr' as const, text: host.run.stdout }
    return { value: { code: host.run.exitCode, signal: null } }
  })
  on('process.run', async (_$, e) => {
    host.runs.push([...e.argv])
    await clock.sleep(host.run.ms)
    return { value: { exitCode: host.run.exitCode, stdout: host.run.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', async (_$, e) => {
    host.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', async (_$, e) => {
    host.statuses.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', async (_$, e) => ({ text: e.text, context: e.context }))
}

async function start($: Engine, on: On, host: Host): Promise<MockClock> {
  const clock = mock.clock(on, { now: 1_000 })
  fakeHost(on, host, clock)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  return clock
}

const command = ($: Engine, name: string) => $.command.run({ command: name, args: '' } as never)
const submit = ($: Engine) => $.prompt.submit({ text: 'sigue', wait: false } as never)

test('detecta cargo y lanza en segundo plano con aviso al acabar', async ($, on) => {
  const host = newHost({ 'Cargo.toml': '[package]' })
  const clock = await start($, on, host)
  const result = await command($, 'compilar')
  expect(result.text).toBe(`Lanzado: cargo build (en ${ROOT})`)
  await clock.advance(2_500)
  expect(host.runs[0]).toEqual(['cmd', '/d', '/s', '/c', 'cargo build'])
  expect(host.toasts).toEqual(['✓ compilar 2,0 s'])
  expect(host.statuses[0]).toBe('compilando…')
  expect(host.statuses.at(-1)).toBeUndefined()
})

test('package.json sin script dev ni start no ofrece arrancar', async ($, on) => {
  const host = newHost({ 'package.json': JSON.stringify({ scripts: { build: 'vite build' } }) })
  await start($, on, host)
  const result = await command($, 'arrancar')
  expect(result.text).toBe('El proyecto (npm) no tiene nada que /arrancar.')
  expect(host.runs).toHaveLength(0)
})

test('sin stack reconocido lo dice claro', async ($, on) => {
  const host = newHost({})
  await start($, on, host)
  const result = await command($, 'probar')
  expect(result.text).toContain('No reconozco el stack')
})

test('un fallo deja la cola de la salida como contexto del siguiente prompt, una sola vez', async ($, on) => {
  const lines = Array.from({ length: 60 }, (_, i) => `línea ${i + 1}`).join('\n')
  const host = newHost({ 'pyproject.toml': '[project]\nname = "demo"' }, { run: { exitCode: 1, stdout: `${lines}\n3 failed, 10 passed`, ms: 1_000 } })
  const clock = await start($, on, host)
  await command($, 'probar')
  await clock.advance(1_500)
  expect(host.toasts).toEqual(['✗ probar: 3 fallos'])
  const first = await submit($)
  const context = (first.context ?? []).join('\n')
  expect(context).toContain('«uv run pytest» falló (3 fallos)')
  expect(context).toContain('línea 60')
  expect(context).not.toContain('línea 20\n')
  const second = await submit($)
  expect(second.context ?? []).toHaveLength(0)
})

test('no lanza dos veces la misma acción a la vez', async ($, on) => {
  const host = newHost({ 'Cargo.toml': '' }, { run: { exitCode: 0, stdout: '', ms: 10_000 } })
  const clock = await start($, on, host)
  await command($, 'probar')
  const again = await command($, 'probar')
  expect(again.text).toBe('Ya hay un /probar en marcha.')
  await clock.advance(10_500)
  expect(host.runs).toHaveLength(1)
})

test('/probar usa el comando que ya resolvió ULTRON para el proyecto', async ($, on) => {
  const result = JSON.stringify({ project: 'demo', cwd: 'C:\\Demo', cmd: 'cd app && npx vitest run', status: 'passed' })
  const host = newHost({ 'Cargo.toml': '' }, { ultronResult: result })
  await start($, on, host)
  expect((await command($, 'probar')).text).toBe('Lanzado: cd app && npx vitest run (en C:\\Demo)')
})

test('/arrancar avisa solo si cae con error al poco de arrancar', async ($, on) => {
  const host = newHost({ 'Cargo.toml': '' }, { run: { exitCode: 101, stdout: 'error: address in use', ms: 3_000 } })
  const clock = await start($, on, host)
  expect((await command($, 'arrancar')).text).toBe('Lanzado: cargo run (en C:/Demo)')
  await clock.advance(3_500)
  expect(host.spawned[0]).toEqual(['cmd', '/d', '/s', '/c', 'cargo run'])
  expect(host.toasts).toEqual(['✗ arrancar: código 101'])
  expect(((await submit($)).context ?? []).join('')).toContain('address in use')
})

test('/arrancar no avisa si el proceso vive más allá del arranque', async ($, on) => {
  const host = newHost({ 'Cargo.toml': '' }, { run: { exitCode: 1, stdout: 'parado', ms: 60_000 } })
  const clock = await start($, on, host)
  await command($, 'arrancar')
  await clock.advance(61_000)
  expect(host.toasts).toHaveLength(0)
  expect(host.statuses.at(-1)).toBeUndefined()
})

test('detección por stack y prioridad', () => {
  const none = { hasCargo: false, pyproject: null, hasMainPy: false, packageJson: null, hasCmake: false }
  expect(detectPlan({ ...none, hasCargo: true, packageJson: '{}' })?.stack).toBe('cargo')
  expect(detectPlan({ ...none, hasCmake: true })).toEqual({
    stack: 'cmake',
    compilar: 'cmake --build build',
    probar: 'ctest --test-dir build --output-on-failure',
    arrancar: null,
  })
  expect(detectPlan({ ...none, pyproject: '[project]', hasMainPy: true })?.arrancar).toBe('uv run python main.py')
  const npmDefault = JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', dev: 'vite' } })
  expect(detectPlan({ ...none, packageJson: npmDefault })).toMatchObject({ probar: null, arrancar: 'npm run dev' })
  expect(detectPlan(none)).toBeNull()
})

test('primer script de [project.scripts] y recuento de fallos', () => {
  expect(firstProjectScript('[project]\nname="x"\n[project.scripts]\nservir = "x.app:main"\n')).toBe('servir')
  expect(firstProjectScript('[project.scripts]\n[tool.uv]\n')).toBeNull()
  expect(failureCount('test result: FAILED. 8 passed; 2 failed;')).toBe(2)
  expect(failureCount('Tests  1 failed | 4 passed')).toBe(1)
  expect(failureCount('todo bien')).toBeNull()
  const outcome = { action: 'compilar' as const, cmd: 'cargo build', exitCode: 101, durationMs: 12_345, output: 'error[E0308]' }
  expect(outcomeToast(outcome)).toBe('✗ compilar: código 101')
  expect(outcomeContext({ ...outcome, exitCode: 0 })).toBe('[ultron-atajos] /compilar: «cargo build» terminó bien en 12,3 s.')
})
