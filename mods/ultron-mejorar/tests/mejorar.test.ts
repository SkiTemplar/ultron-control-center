import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { buildPrompt, failureReason, projectNameFor, summarizeStatus } from '../hooks/context'

const USAGE = { input_tokens: 10, output_tokens: 5 }

type Host = {
  prompts: string[]
  filled: string[]
  statuses: Array<string | undefined>
  runs: string[][]
  reply: { isAnswered: true; text: string } | { isAnswered: false; reason: 'api-error'; status: number }
  isFillRefused: boolean
}

const newHost = (over: Partial<Host> = {}): Host => ({
  prompts: [],
  filled: [],
  statuses: [],
  runs: [],
  reply: { isAnswered: true, text: 'Prompt mejorado' },
  isFillRefused: false,
  ...over,
})

const RUN_OK = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

const PROJECTS = JSON.stringify({ projects: [{ name: 'Demo', path: 'C:\\demo' }, { name: 'Raíz', path: 'C:\\' }] })

/** Motor falso: git, registro de proyectos, modelo y caja del prompt. */
async function start($: Engine, on: On, host: Host): Promise<void> {
  mock.env(on, { USERPROFILE: 'C:/Users/demo' })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.cwd', async () => ({ value: 'C:/demo/src' }))
  on('session.repo', async () => ({ value: { root: 'C:/demo', remote: null, internal: false, name: 'demo' } }))
  on('process.run', async (_$, e) => {
    host.runs.push([...e.argv])
    return { value: RUN_OK(e.argv.includes('rev-parse') ? 'feat/login\n' : ' M src/app.ts\n') }
  })
  on('fs.exists', async () => ({ value: true }))
  on('fs.read', async () => ({ value: PROJECTS }))
  on('ui.status', async (_$, e) => {
    host.statuses.push(e.text)
    return { value: undefined }
  })
  on('model.complete', async (_$, e) => {
    host.prompts.push(String(e.prompt))
    return { value: { ...host.reply, usage: USAGE } as never }
  })
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('tool.call', async () => ({ result: 'fallo' as never, isError: true, text: 'Error: cargo test falló en auth.rs:88' }) as never)
  on('prompt.fill', async (_$, e) => {
    if (host.isFillRefused) return { isFilled: false }
    host.filled.push(e.text)
    return { isFilled: true }
  })
  await $.session.start({ cwd: 'C:/demo/src', surface: 'terminal', isInteractive: true })
}

test('el estado de git se recorta a 15 líneas y cuenta el resto', () => {
  const porcelain = Array.from({ length: 18 }, (_, i) => ` M f${i}.ts`).join('\n')
  const summary = summarizeStatus(porcelain) ?? ''
  expect(summary.split('\n')).toHaveLength(16)
  expect(summary.endsWith('… y 3 más')).toBe(true)
  expect(summarizeStatus('\n')).toBeNull()
})

test('el proyecto ULTRON es el más específico que contiene el cwd', () => {
  expect(projectNameFor(PROJECTS, 'C:/demo/src')).toBe('Demo')
  expect(projectNameFor(PROJECTS, 'C:/demo-otro')).toBe('Raíz')
  expect(projectNameFor('{"projects":[]}', 'C:/demo')).toBeNull()
})

test('el prompt al modelo lleva solo el contexto disponible y el borrador', () => {
  const prompt = buildPrompt('arregla el login', {
    cwd: 'C:/demo', project: null, repo: 'demo', branch: 'main', status: null, lastError: null,
  })
  expect(prompt).toContain('Rama: main')
  expect(prompt).not.toContain('Proyecto ULTRON')
  expect(prompt).toContain('<borrador>\narregla el login\n</borrador>')
})

test('los motivos de fallo se explican', () => {
  expect(failureReason({ reason: 'api-error', status: 529 })).toBe('error de la API (HTTP 529)')
  expect(failureReason({ reason: 'empty-reply' })).toBe('el modelo respondió vacío')
})

test('/mejorar con borrador lo reescribe con contexto y lo deja en la caja', async ($, on) => {
  const host = newHost()
  await start($, on, host)
  const result = await $.command.run({ command: 'mejorar', args: 'arregla lo del login' } as never)
  expect(result.text).toBe('Prompt mejorado en la caja: revísalo y pulsa Enter.')
  expect(host.filled).toEqual(['Prompt mejorado'])
  expect(host.prompts[0]).toContain('Proyecto ULTRON: Demo')
  expect(host.prompts[0]).toContain('Rama: feat/login')
  expect(host.prompts[0]).toContain('M src/app.ts')
  expect(host.prompts[0]).toContain('arregla lo del login')
  expect(host.statuses).toEqual(['mejorando prompt…', undefined])
})

test('/mejorar sin argumentos mejora el último prompt enviado y lo avisa', async ($, on) => {
  const host = newHost()
  await start($, on, host)
  await $.prompt.submit({ text: 'revisa el parser', wait: false, origin: { kind: 'composer' } } as never)
  const result = await $.command.run({ command: 'mejorar', args: '' } as never)
  expect(result.text).toContain('he mejorado tu prompt anterior')
  expect(host.prompts[0]).toContain('<borrador>\nrevisa el parser\n</borrador>')
})

test('/mejorar sin argumentos ni prompt previo no llama al modelo', async ($, on) => {
  const host = newHost()
  await start($, on, host)
  const result = await $.command.run({ command: 'mejorar', args: '  ' } as never)
  expect(result.text).toContain('No hay borrador')
  expect(host.prompts).toHaveLength(0)
})

test('un fallo de la API devuelve el motivo, no toca la caja y limpia el estado', async ($, on) => {
  const host = newHost({ reply: { isAnswered: false, reason: 'api-error', status: 529 } })
  await start($, on, host)
  const result = await $.command.run({ command: 'mejorar', args: 'hola' } as never)
  expect(result.text).toBe('No se pudo mejorar el prompt: error de la API (HTTP 529).')
  expect(host.filled).toHaveLength(0)
  expect(host.statuses).toEqual(['mejorando prompt…', undefined])
})

test('si la caja no admite el texto, lo devuelve para copiarlo', async ($, on) => {
  const host = newHost({ isFillRefused: true })
  await start($, on, host)
  const result = await $.command.run({ command: 'mejorar', args: 'hola' } as never)
  expect(result.text).toContain('cópialo desde aquí')
  expect(result.text).toContain('Prompt mejorado')
})

test('el último error de herramienta entra en el contexto y se limpia con el siguiente prompt', async ($, on) => {
  const host = newHost()
  await start($, on, host)
  await $.tool.call({ tool: 'Bash', command: 'cargo test' } as never)
  await $.command.run({ command: 'mejorar', args: 'arréglalo' } as never)
  expect(host.prompts[0]).toContain('Último error de herramienta:\nError: cargo test falló en auth.rs:88')
  await $.prompt.submit({ text: 'otra cosa', wait: false, origin: { kind: 'composer' } } as never)
  await $.command.run({ command: 'mejorar', args: 'arréglalo' } as never)
  expect(host.prompts[1]).not.toContain('Último error')
})
