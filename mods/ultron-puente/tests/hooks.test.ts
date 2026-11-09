/**
 * Hooks de la sección 6.5: comandos, cambio de conversación, fin de sesión,
 * prompts, cajas y paneles de otros mods, y 0 tokens extra.
 */
import { expect, test } from 'claude-code/testing'

import { eventsOf, newBackend, paths, settle, start, typed } from './fixtures'

test('command.run de un menú (config): nunca se intercepta, llega al motor y deja commandStart/commandEnd', async ($, on) => {
  const session = await start($, on, newBackend())
  session.commandResult = async () => ({})
  await $.command.run(typed('config'))
  session.commandResult = async () => ({ text: 'Total cost: $0.12' })
  expect(await $.command.run(typed('cost'))).toMatchObject({ text: 'Total cost: $0.12' })
  await settle(session.clock)
  expect(session.commandRuns).toEqual([{ command: 'config', args: '' }, { command: 'cost', args: '' }])
  const starts = eventsOf(session.backend, 'commandStart')
  const ends = eventsOf(session.backend, 'commandEnd')
  expect(starts).toEqual([
    expect.objectContaining({ command: 'config', args: '', origin: 'composer' }),
    expect.objectContaining({ command: 'cost', origin: 'composer' }),
  ])
  expect(ends[0]).toEqual(expect.objectContaining({ runId: starts[0]?.runId, command: 'config', intercepted: false }))
  expect(ends[0]).not.toHaveProperty('text')
  expect(ends[1]).toEqual(expect.objectContaining({ runId: starts[1]?.runId, text: 'Total cost: $0.12', intercepted: false }))
  expect(eventsOf(session.backend, 'panel')).toEqual([])
})

test('reload-plugins: la lista viva se vuelve a leer y a enviar', async ($, on) => {
  const session = await start($, on, newBackend())
  session.commands = [...session.commands, { name: 'codex:rescue', description: 'Rescate', source: 'plugin', plugin: 'codex' }]
  await $.command.run(typed('reload-plugins'))
  await settle(session.clock)
  await session.clock.advance(100)
  const lists = eventsOf(session.backend, 'commands')
  expect(lists).toHaveLength(2)
  expect(lists[1]?.items).toEqual([
    { name: 'cost', description: 'Coste', source: 'builtin' },
    { name: 'codex:rescue', description: 'Rescate', source: 'plugin', plugin: 'codex' },
  ])
})

test('/clear: classic.SessionStart{clear} manda hello con el sid y el transcript nuevos y el buzón sigue', async ($, on) => {
  const session = await start($, on, newBackend())
  await $.classic.SessionStart({ source: 'clear', session_id: 'claude-2', transcript_path: 'C:/t/claude-2.jsonl' } as never)
  await $.classic.SessionStart({ source: 'startup', session_id: 'claude-2', transcript_path: 'C:/t/claude-2.jsonl' } as never)
  await settle(session.clock, 10)
  const hellos = paths(session.backend, '/v1/hello').map((call) => call.body)
  expect(hellos).toHaveLength(2)
  expect(hellos[1]).toMatchObject({ claudeSessionId: 'claude-2', transcriptPath: 'C:/t/claude-2.jsonl', source: 'clear', protocol: 2 })
  await $.session.end({ reason: 'clear', sessionId: 'claude-1', resume: { id: 'claude-1' } } as never)
  session.backend.deliver([{ opId: 'k1', op: 'config.set', key: 'verbose', value: true }])
  await settle(session.clock, 10)
  expect(paths(session.backend, '/v1/inbox').at(-1)?.body.generation).toBe(2)
  expect(session.configSets).toEqual([{ key: 'verbose', value: true }])
})

test('session.end por otra razón: el buzón se para (negativo de clear)', async ($, on) => {
  const session = await start($, on, newBackend())
  await $.session.end({ reason: 'other', sessionId: 'claude-1', resume: { id: 'claude-1' } } as never)
  session.backend.deliver([{ opId: 'k1', op: 'config.set', key: 'verbose', value: true }])
  await settle(session.clock, 10)
  await session.clock.advance(60_000)
  expect(session.configSets).toEqual([])
  expect(paths(session.backend, '/v1/result')).toEqual([])
})

test('turn.start: turnStart inmediato con el texto y hello de red si cambió el sid', async ($, on) => {
  const session = await start($, on, newBackend())
  await $.turn.start({ text: 'Hola', turnId: 't1' })
  session.sessionId = 'claude-3'
  await $.turn.start({ text: '', turnId: 't2' })
  await settle(session.clock, 10)
  const starts = eventsOf(session.backend, 'turnStart')
  expect(starts).toEqual([expect.objectContaining({ turnId: 't1', text: 'Hola' }), expect.objectContaining({ turnId: 't2' })])
  expect(starts[1]).not.toHaveProperty('text')
  expect(paths(session.backend, '/v1/hello').at(-1)?.body).toMatchObject({ claudeSessionId: 'claude-3', source: 'turn' })
})

test('prompt.submit: evento prompt con turnId, origen y espera', async ($, on) => {
  const session = await start($, on, newBackend())
  await $.prompt.submit({ text: 'y añade tests', origin: { kind: 'composer' }, wait: false, turnId: 't1' })
  await settle(session.clock)
  expect(eventsOf(session.backend, 'prompt')).toEqual([expect.objectContaining({ turnId: 't1', text: 'y añade tests', origin: 'composer', wait: false })])
})

const OTHER = {
  name: 'otro',
  register(on: Parameters<import('claude-code').Register>[0]) {
    on('command.run', { command: 'relevo' }, async ($) => {
      const filled = await $.prompt.fill({ text: 'Retoma desde aquí', mode: 'replace' })
      return { text: filled.isFilled ? 'lleno' : 'vacío' }
    })
    on('command.run', { command: 'panel' }, async ($) => {
      await $.ui.open({ id: 'mio', focus: true })
      return { text: 'abierto' }
    })
    on('command.run', { command: 'auto' }, async ($) => {
      $.clock.after(0, () => {
        void $.ui.open({ id: 'solo', focus: true }).then(
          (result) => $.http.fetch('http://spy/auto', { method: 'POST', body: JSON.stringify(result) }),
          (error: unknown) => $.http.fetch('http://spy/auto', { method: 'POST', body: JSON.stringify({ rejected: String(error) }) }),
        )
      })
      return { text: 'programado' }
    })
    on('clock.sleep', async ($, e, next) => {
      await $.http.fetch('http://spy/sleep', { method: 'POST', body: '{}' })
      return next(e)
    })
  },
}

test('prompt.fill de otro mod: composerFill a la ventana, la caja oculta intacta y isFilled', { plugins: [OTHER] }, async ($, on) => {
  const session = await start($, on, newBackend())
  expect(await $.command.run(typed('relevo'))).toMatchObject({ text: 'lleno' })
  await settle(session.clock)
  expect(session.promptFills).toEqual([])
  expect(eventsOf(session.backend, 'composerFill')).toEqual([expect.objectContaining({ text: 'Retoma desde aquí', mode: 'replace', from: 'otro' })])
})

test('ui.open de otro mod: con su comando, sin foco; automático, deny', { plugins: [OTHER] }, async ($, on) => {
  const session = await start($, on, newBackend())
  await $.command.run(typed('panel'))
  expect(session.uiOpens).toHaveLength(1)
  expect(session.uiOpens[0]).toMatchObject({ id: 'mio' })
  expect((session.uiOpens[0] as { focus?: unknown }).focus).toBeUndefined()
  await $.command.run(typed('auto'))
  await settle(session.clock, 10)
  expect(session.uiOpens).toHaveLength(1)
  const spied = paths(session.backend, '/auto')
  expect(spied).toHaveLength(1)
  expect(JSON.stringify(spied[0]?.body)).toContain('panel automático omitido')
})

const AVISADOR = {
  name: 'ultron-avisador',
  register(on: Parameters<import('claude-code').Register>[0]) {
    on('command.run', { command: 'avisa' }, async ($) => {
      $.ui.toast('tests en rojo')
      $.ui.log('una línea de log')
      $.ui.log('solo para depurar', { to: 'debug' })
      $.ui.status('trabajando')
      $.ui.status(undefined)
      await $.prompt.suggest({ text: 'arregla los tests' })
      return { text: 'avisado' }
    })
    on('command.run', { command: 'repite' }, async ($) => {
      $.ui.toast('el mismo')
      $.ui.toast('el mismo')
      $.ui.status('uno')
      $.ui.status('dos')
      return { text: 'repetido' }
    })
    on('command.run', { command: 'propio' }, async ($) => {
      $.ui.toast('avisador: ya lleva el nombre')
      return { text: 'propio' }
    })
  },
}

const noticeTexts = (session: { backend: Parameters<typeof eventsOf>[0] }): unknown[] =>
  eventsOf(session.backend, 'notice').map((event) => event.text)

test('avisos de otro mod: toast, log, status y sugerencia llegan como notice; depuración y borrado no', { plugins: [AVISADOR] }, async ($, on) => {
  const session = await start($, on, newBackend())
  await $.command.run(typed('avisa'))
  await settle(session.clock, 10)
  expect(eventsOf(session.backend, 'notice')).toEqual([
    expect.objectContaining({ level: 'info', text: 'avisador: tests en rojo' }),
    expect.objectContaining({ level: 'info', text: 'avisador: una línea de log' }),
    expect.objectContaining({ level: 'info', text: 'avisador: trabajando' }),
    expect.objectContaining({ level: 'info', text: 'Sugerencia de avisador: arregla los tests' }),
  ])
})

test('avisos de otro mod: lo repetido y el status que cambia enseguida no se repiten', { plugins: [AVISADOR] }, async ($, on) => {
  const session = await start($, on, newBackend())
  await $.command.run(typed('repite'))
  await settle(session.clock, 10)
  expect(noticeTexts(session)).toEqual(['avisador: el mismo', 'avisador: uno'])
})

test('avisos de otro mod: si el texto ya empieza por el nombre no se antepone', { plugins: [AVISADOR] }, async ($, on) => {
  const session = await start($, on, newBackend())
  await $.command.run(typed('propio'))
  await settle(session.clock, 10)
  expect(noticeTexts(session)).toEqual(['avisador: ya lleva el nombre'])
})

test('avisos de otro mod: con otro dueño de la sesión (409) no se envía nada (negativo)', { plugins: [AVISADOR] }, async ($, on) => {
  const session = await start($, on, newBackend({ generation: 3, helloStatus: [409] }))
  await $.command.run(typed('avisa'))
  await settle(session.clock, 10)
  expect(noticeTexts(session)).toEqual([])
})

test('presupuesto: ningún reintento del puente duerme con $.clock.sleep', { plugins: [OTHER] }, async ($, on) => {
  const backend = newBackend()
  const session = await start($, on, backend)
  backend.isWaitDown = true
  const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf x' }, tool_use_id: 'c1' })
  expect(verdict).toMatchObject({ decision: 'deny' })
  expect(paths(backend, '/v1/ask/wait')).toHaveLength(3)
  await session.clock.advance(5_000)
  expect(paths(backend, '/sleep')).toEqual([])
})

test('0 tokens: ningún hook devuelve context ni additionalContext', async ($, on) => {
  const session = await start($, on, newBackend())
  // El núcleo permite la lectura: `$.tool.call` pasa por `tool.check` y un `ask`
  // quedaría esperando la respuesta de la ventana.
  session.verdict = { decision: 'allow' }
  const answers: unknown[] = [
    await $.command.run(typed('cost')),
    await $.prompt.submit({ text: 'hola', origin: { kind: 'composer' }, wait: false }),
    await $.turn.start({ text: 'hola', turnId: 't1' }),
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' }),
    await $.classic.UserPromptSubmit({ prompt: 'x', permission_mode: 'plan' } as never),
    await $.classic.SessionStart({ source: 'compact', session_id: 'claude-1', transcript_path: '' } as never),
    await $.tool.call({ tool: 'Read', file_path: 'a.md', tool_use_id: 'r1' } as never),
  ]
  await settle(session.clock)
  for (const answer of answers) {
    expect(answer).not.toHaveProperty('context')
    expect(answer).not.toHaveProperty('additionalContext')
  }
})
