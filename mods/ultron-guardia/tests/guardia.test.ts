import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentSpawnInput, On } from 'claude-code'

import { ANSWER_FORMAT_CLAUSE, TURN_CAP_CLAUSE, boundPrompt, specialistFor } from '../hooks/policy'

type Host = { spawned: AgentSpawnInput[]; toasts: string[]; installed: ReadonlySet<string> }

const INSTALLED = new Set(['doc-summarizer', 'code-reviewer', 'technical-artist', 'devops-engineer'])

async function start(
  $: Engine,
  on: On,
  installed: ReadonlySet<string> = INSTALLED,
  env: Readonly<Record<string, string>> = {},
): Promise<Host> {
  const host: Host = { spawned: [], toasts: [], installed }
  mock.env(on, { USERPROFILE: 'C:/Users/demo', ...env })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('fs.exists', async (_$, e) => {
    const name = /agents\/([^/]+)\.md$/.exec(e.path.replace(/\\/g, '/'))?.[1] ?? ''
    return { value: host.installed.has(name) }
  })
  on('ui.toast', async (_$, e) => {
    host.toasts.push(e.text)
    return { value: undefined }
  })
  on('agent.spawn', async (_$, e) => {
    host.spawned.push(e)
    return { model: 'claude-opus-5-5', agentId: `a${host.spawned.length}` }
  })
  await $.session.start({ cwd: 'C:/demo', surface: 'terminal', isInteractive: true })
  return host
}

const spawn = ($: Engine, args: Partial<AgentSpawnInput>) =>
  $.agent.spawn({ description: 'tarea', prompt: 'haz algo', subagentType: 'general-purpose', ...args } as never)

test('general-purpose con «resume este paper» se deniega hacia doc-summarizer', async ($, on) => {
  const host = await start($, on)
  const result = await spawn($, { prompt: 'Resume este paper sobre RAG y dame las ideas clave.' })
  expect(result.deny).toContain('Usa doc-summarizer')
  expect(host.spawned).toHaveLength(0)
  expect(host.toasts[0]).toContain('doc-summarizer')
})

test('no nombra especialistas que no existen en disco', async ($, on) => {
  const host = await start($, on, new Set())
  const result = await spawn($, { prompt: 'Resume este paper sobre RAG.' })
  expect(result.deny).toBeUndefined()
  expect(host.spawned).toHaveLength(1)
})

test('la frase de escape deja pasar a general-purpose', async ($, on) => {
  const host = await start($, on)
  await spawn($, { prompt: 'Resume este paper y luego impleméntalo; ningún especialista encaja.' })
  expect(host.spawned).toHaveLength(1)
})

test('Explore recibe tope de turnos y formato de respuesta', async ($, on) => {
  const host = await start($, on)
  await spawn($, { subagentType: 'Explore', prompt: 'Localiza el parser de tokens.' })
  expect(host.spawned[0]?.prompt).toBe(`Localiza el parser de tokens.${TURN_CAP_CLAUSE}${ANSWER_FORMAT_CLAUSE}`)
})

test('un alias sin variable que lo fije se quita y el especialista queda intacto', async ($, on) => {
  const host = await start($, on)
  await spawn($, { subagentType: 'code-reviewer', prompt: 'Revisa el diff.', model: 'sonnet' })
  expect(host.spawned[0]?.model).toBeUndefined()
  expect(host.spawned[0]?.prompt).toBe('Revisa el diff.')
  expect(host.toasts[0]).toContain('sin model sonnet')
})

test('respeta un ID exacto de la familia 5.5, Haiku incluido', async ($, on) => {
  const host = await start($, on)
  for (const model of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5[1m]']) {
    await spawn($, { subagentType: 'Explore', prompt: 'Cuenta los ficheros. Máx 5 turnos. Devuelve la cifra.', model })
  }
  expect(host.spawned.map((s) => s.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5[1m]'])
  expect(host.toasts).toHaveLength(0)
})

test('respeta el alias haiku cuando la variable lo fija a Haiku 5.5', async ($, on) => {
  const host = await start($, on, INSTALLED, { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5' })
  await spawn($, { subagentType: 'code-reviewer', prompt: 'Revisa el diff.', model: 'haiku' })
  expect(host.spawned[0]?.model).toBe('haiku')
})

test('quita el alias si la variable lo lleva fuera de la familia 5.5', async ($, on) => {
  const host = await start($, on, INSTALLED, { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5' })
  await spawn($, { subagentType: 'code-reviewer', prompt: 'Revisa el diff.', model: 'haiku' })
  expect(host.spawned[0]?.model).toBeUndefined()
})

test('quita los modelos prohibidos', async ($, on) => {
  const host = await start($, on)
  for (const model of ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5', 'claude-opus-4-7', 'fable']) {
    await spawn($, { subagentType: 'code-reviewer', prompt: 'Revisa el diff.', model })
  }
  expect(host.spawned.map((s) => s.model)).toEqual([undefined, undefined, undefined, undefined, undefined])
  expect(host.toasts).toHaveLength(5)
})

test('inherit solo se respeta si el padre corre en la familia 5.5', async ($, on) => {
  const host = await start($, on)
  await spawn($, { subagentType: 'code-reviewer', prompt: 'Revisa el diff.', model: 'inherit', parentModel: 'claude-opus-5-5' })
  await spawn($, { subagentType: 'code-reviewer', prompt: 'Revisa el diff.', model: 'inherit', parentModel: 'claude-sonnet-5' })
  expect(host.spawned.map((s) => s.model)).toEqual(['inherit', undefined])
})

test('no toca forks', async ($, on) => {
  const host = await start($, on)
  await spawn($, { subagentType: 'fork', fork: true, prompt: 'Resume este paper.' })
  expect(host.spawned[0]?.prompt).toBe('Resume este paper.')
})

test('política pura: substrings cortos no disparan y el formato existente se respeta', () => {
  const all = () => true
  expect(specialistFor('Implementa la unidad de medida', all)).toBeNull()
  expect(specialistFor('Revisa el código del módulo auth', all)?.agent).toBe('code-reviewer')
  expect(specialistFor('Crea el kit en Blender', all)?.agent).toBe('technical-artist')
  expect(specialistFor('Busca dónde está definido parseToken', all)?.agent).toBe('Explore')
  expect(boundPrompt('Explore', 'Máx 10 turnos. Devuelve una lista.')).toBe('Máx 10 turnos. Devuelve una lista.')
  expect(boundPrompt('code-reviewer', 'x')).toBe('x')
})
