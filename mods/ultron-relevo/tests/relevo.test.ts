import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { continuationPrompt, documentOf, forkPrompt, stampOf } from '../hooks/handoff'

const USAGE = { input_tokens: 10, output_tokens: 5 }
const NOW = Date.UTC(2026, 9, 7, 10, 5)
const BODY = '## Objetivo\nTerminar /relevo.\n\n## Siguiente paso\nEjecutar los tests.'

type Reply = { isAnswered: true; text: string } | { isAnswered: false; reason: string; status?: number }

type Host = {
  forks: string[]
  writes: Array<{ path: string; text: string }>
  filled: string[]
  statuses: Array<string | undefined>
  reply: Reply
}

const newHost = (reply: Reply = { isAnswered: true, text: BODY }): Host => ({
  forks: [],
  writes: [],
  filled: [],
  statuses: [],
  reply,
})

async function start($: Engine, on: On, host: Host): Promise<void> {
  mock.clock(on, { now: NOW })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.cwd', async () => ({ value: 'C:/demo' }))
  on('ui.status', async (_$, e) => {
    host.statuses.push(e.text)
    return { value: undefined }
  })
  on('model.fork', async (_$, e) => {
    host.forks.push(e.prompt)
    return { value: { ...host.reply, usage: USAGE } as never }
  })
  on('fs.write', async (_$, e) => {
    host.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('prompt.fill', async (_$, e) => {
    host.filled.push(e.text)
    return { isFilled: true }
  })
  await $.session.start({ cwd: 'C:/demo', surface: 'terminal', isInteractive: true })
}

test('el encargo pide las seis secciones y añade la nota si la hay', () => {
  const prompt = forkPrompt('ojo con el CI')
  for (const section of ['Objetivo', 'Hecho', 'Decisiones', 'Pendiente', 'Siguiente paso', 'Riesgos']) {
    expect(prompt).toContain(section)
  }
  expect(prompt).toContain('Nota de la persona para el relevo: ojo con el CI')
  expect(forkPrompt('')).not.toContain('Nota de la persona')
})

test('el documento lleva cabecera con fecha, la nota citada y el cuerpo', () => {
  const doc = documentOf(`  ${BODY}\n\n`, NOW, 'ojo con el CI')
  expect(doc.startsWith('# Relevo 2026-10-07')).toBe(true)
  expect(doc).toContain('> ojo con el CI')
  expect(doc.endsWith('Ejecutar los tests.\n')).toBe(true)
})

test('/relevo escribe el fichero y deja el prompt de continuación en la caja', async ($, on) => {
  const host = newHost()
  await start($, on, host)
  const result = await $.command.run({ command: 'relevo', args: 'ojo con el CI' } as never)
  const relative = `.claude/relevos/${stampOf(NOW)}.md`
  expect(host.writes).toHaveLength(1)
  expect(host.writes[0]?.path.replace(/\\/g, '/')).toBe(`C:/demo/${relative}`)
  expect(host.writes[0]?.text).toContain('## Siguiente paso')
  expect(host.forks[0]).toContain('ojo con el CI')
  expect(host.filled).toEqual([continuationPrompt(relative)])
  expect(result.text).toBe(`Relevo guardado en ${relative}; el prompt para retomarlo está en la caja.`)
  expect(host.statuses).toEqual(['escribiendo relevo…', undefined])
})

test('si el fork falla informa el motivo, no escribe nada y limpia el estado', async ($, on) => {
  const host = newHost({ isAnswered: false, reason: 'api-error', status: 529 })
  await start($, on, host)
  const result = await $.command.run({ command: 'relevo', args: '' } as never)
  expect(result.text).toBe('No se pudo escribir el relevo: error de la API (HTTP 529).')
  expect(host.writes).toHaveLength(0)
  expect(host.filled).toHaveLength(0)
  expect(host.statuses).toEqual(['escribiendo relevo…', undefined])
})

test('sin conversación que resumir lo dice claramente', async ($, on) => {
  const host = newHost({ isAnswered: false, reason: 'nothing-to-fork' })
  await start($, on, host)
  const result = await $.command.run({ command: 'relevo', args: '' } as never)
  expect(result.text).toBe('No se pudo escribir el relevo: aún no hay conversación que resumir.')
})
