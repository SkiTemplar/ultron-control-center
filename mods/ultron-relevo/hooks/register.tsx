import type { EngineInterface, Register } from 'claude-code'

import { RELEVOS_DIR, continuationPrompt, documentOf, failureReason, forkPrompt, stampOf } from './handoff'

const STATUS_TEXT = 'escribiendo relevo…'

/** Pide el relevo al fork, lo guarda y deja en la caja el prompt para retomarlo. */
async function handoff($: EngineInterface, note: string): Promise<string> {
  const result = await $.model.fork({ prompt: forkPrompt(note) })
  if (!result.isAnswered) return `No se pudo escribir el relevo: ${failureReason(result)}.`
  if (result.text.trim().length === 0) return 'No se pudo escribir el relevo: el modelo respondió vacío.'

  const [cwd, now] = await Promise.all([$.session.cwd(), $.clock.now()])
  const relativePath = `${RELEVOS_DIR}/${stampOf(now)}.md`
  await $.fs.write(`${cwd}/${relativePath}`, documentOf(result.text, now, note))

  const prompt = continuationPrompt(relativePath)
  const filled = await $.prompt.fill({ text: prompt, mode: 'replace' })
  if (filled.isFilled) return `Relevo guardado en ${relativePath}; el prompt para retomarlo está en la caja.`
  return `Relevo guardado en ${relativePath}. No se pudo escribir en la caja; para retomarlo:\n\n${prompt}`
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'relevo',
      description: 'Guarda el estado de la sesión en .claude/relevos/ y deja el prompt para retomarlo con contexto limpio',
      argumentHint: '[nota opcional]',
    })
    return next(e)
  })

  on('command.run', { command: 'relevo' }, async ($, e) => {
    $.ui.status(STATUS_TEXT)
    try {
      return { text: await handoff($, e.args.trim()) }
    } catch (err) {
      return { text: `No se pudo escribir el relevo: ${String(err).slice(0, 300)}` }
    } finally {
      $.ui.status(undefined)
    }
  })
}
