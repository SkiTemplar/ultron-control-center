import type { EngineInterface, Register } from 'claude-code'

import { appendLine, folderName, formatLine, localDate, parseArgs, projectIdFor } from './papercut'

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200)

/** Carpeta personal del usuario: USERPROFILE en Windows, HOME en el resto. */
async function homeDir($: EngineInterface): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  if (!home) throw new Error('no están definidas USERPROFILE ni HOME')
  return home.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** Proyecto de la línea: id de ULTRON si el cwd cae en un proyecto registrado; si no, la carpeta. */
async function projectOf($: EngineInterface, home: string, cwd: string): Promise<{ project: string; note: string | null }> {
  const fallback = folderName(cwd)
  try {
    const id = projectIdFor(await $.fs.read(`${home}/.ultron/cockpit/projects.json`), cwd)
    return { project: id ?? fallback, note: null }
  } catch (err) {
    return { project: fallback, note: `Proyecto por nombre de carpeta: no se pudo leer projects.json (${reasonOf(err)}).` }
  }
}

async function addPapercut($: EngineInterface, raw: string): Promise<string> {
  const args = parseArgs(raw)
  if ('error' in args) return args.error
  let home: string
  try {
    home = await homeDir($)
  } catch (err) {
    return `No se pudo localizar papercuts.md: ${reasonOf(err)}.`
  }
  const file = `${home}/.ultron/papercuts.md`
  const cwd = await $.session.cwd()
  const { project, note } = args.project === null ? await projectOf($, home, cwd) : { project: args.project, note: null }
  const line = formatLine(localDate(await $.clock.now()), args, project)
  try {
    const text = await $.fs.read(file)
    await $.fs.write(file, appendLine(text, line))
  } catch (err) {
    return `No se pudo escribir en ${file}: ${reasonOf(err)}. No se ha añadido nada.`
  }
  return [`Añadido a ${file}:`, line, ...(note === null ? [] : [note])].join('\n')
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'papercut',
      description: 'Añade una fricción de herramientas a ~/.ultron/papercuts.md',
      argumentHint: 'síntoma · arreglo',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'papercut' }, async ($, e) => ({ text: await addPapercut($, e.args) }))
}
