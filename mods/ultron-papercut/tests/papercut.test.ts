import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { USAGE, appendLine, formatLine, parseArgs, projectIdFor } from '../hooks/papercut'

const PROJECTS = JSON.stringify({
  projects: [
    { id: 'ultron', path: 'C:\\Users\\demo\\.ultron' },
    { id: 'raiz', path: 'C:\\Users\\demo' },
    { id: 'sin-ruta' },
  ],
})

test('separa síntoma, arreglo y proyecto opcional, en una sola línea', () => {
  expect(parseArgs('  git cuelga \n al hacer push · usar --no-verify ')).toEqual({ symptom: 'git cuelga al hacer push', fix: 'usar --no-verify', project: null })
  expect(parseArgs('a · b · Tortunabo')).toEqual({ symptom: 'a', fix: 'b', project: 'Tortunabo' })
})

test('sin argumentos explica el uso; con partes vacías o de más, lo dice', () => {
  expect(parseArgs('   ')).toEqual({ error: USAGE })
  expect('error' in parseArgs('solo síntoma')).toBe(true)
  expect('error' in parseArgs('síntoma · ')).toBe(true)
  expect((parseArgs('a · b · c · d') as { error: string }).error).toContain('Sobran separadores')
})

test('la línea sigue el formato del fichero y respeta su fin de línea', () => {
  const line = formatLine('2026-10-15', { symptom: 's', fix: 'f', project: null }, 'ultron')
  expect(line).toBe('- 2026-10-15 · s · f · ultron')
  expect(appendLine('# P\n- viejo\n', line)).toBe(`# P\n- viejo\n${line}\n`)
  expect(appendLine('# P\r\n- viejo', line)).toBe(`# P\r\n- viejo\r\n${line}\r\n`)
})

test('el proyecto es el registrado más profundo que contiene el cwd', () => {
  expect(projectIdFor(PROJECTS, 'c:/users/demo/.ultron/mods/x')).toBe('ultron')
  expect(projectIdFor(PROJECTS, 'C:\\Users\\demo\\Docs')).toBe('raiz')
  expect(projectIdFor(PROJECTS, 'D:/otro')).toBeNull()
  expect(() => projectIdFor('{}', 'C:/x')).toThrow()
})

type Host = { files: Record<string, string>; writes: Array<{ path: string; text: string }>; isWriteBroken: boolean }

/** El motor entrega las rutas con barras invertidas en Windows. */
const slash = (p: string): string => p.replace(/\\/g, '/')

const NOW = new Date(2026, 9, 15, 12, 0, 0).getTime()
const PAPERCUTS = 'C:/Users/demo/.ultron/papercuts.md'

async function start($: Engine, on: On, host: Host, cwd = 'C:/Users/demo/.ultron/mods') {
  mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:\\Users\\demo' })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', async () => ({ value: cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('fs.read', async (_$, e) => {
    const text = host.files[slash(e.path)]
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', async (_$, e) => {
    if (host.isWriteBroken) return { deny: 'EACCES: permiso denegado' }
    host.writes.push({ path: slash(e.path), text: e.text })
    return { value: undefined }
  })
  await $.session.start({ cwd, surface: 'terminal', isInteractive: true })
}

const papercut = ($: Engine, args: string) => $.command.run({ command: 'papercut', args } as never)

const newHost = (over: Partial<Host> = {}): Host => ({
  files: { [PAPERCUTS]: '# Papercuts\n\n- 2026-10-14 · a · b · ultron\n', 'C:/Users/demo/.ultron/cockpit/projects.json': PROJECTS },
  writes: [],
  isWriteBroken: false,
  ...over,
})

test('/papercut añade la línea con fecha e id de proyecto y la confirma', async ($, on) => {
  const host = newHost()
  await start($, on, host)
  const result = await papercut($, 'vitest cuelga · usar --pool=forks')
  expect(host.writes).toEqual([{ path: PAPERCUTS, text: '# Papercuts\n\n- 2026-10-14 · a · b · ultron\n- 2026-10-15 · vitest cuelga · usar --pool=forks · ultron\n' }])
  expect(result.text).toBe(`Añadido a ${PAPERCUTS}:\n- 2026-10-15 · vitest cuelga · usar --pool=forks · ultron`)
})

test('/papercut sin argumentos explica el uso y no escribe', async ($, on) => {
  const host = newHost()
  await start($, on, host)
  const result = await papercut($, '')
  expect(result.text).toBe(USAGE)
  expect(host.writes).toHaveLength(0)
})

test('sin projects.json usa la carpeta del cwd y lo avisa', async ($, on) => {
  const host = newHost({ files: { [PAPERCUTS]: '' } })
  await start($, on, host, 'D:\\Juegos\\Explored')
  const result = await papercut($, 's · f')
  expect(host.writes[0]?.text).toBe('- 2026-10-15 · s · f · Explored\n')
  expect(result.text).toContain('Proyecto por nombre de carpeta: no se pudo leer projects.json')
})

test('si el disco falla, lo dice y no rompe la sesión', async ($, on) => {
  const host = newHost({ isWriteBroken: true })
  await start($, on, host)
  const result = await papercut($, 's · f')
  expect(result.text).toContain(`No se pudo escribir en ${PAPERCUTS}: `)
  expect(result.text).toContain('EACCES: permiso denegado')
  expect(result.text).toContain('No se ha añadido nada.')
})

test('si papercuts.md no existe, no lo crea a ciegas', async ($, on) => {
  const host = newHost({ files: {} })
  await start($, on, host)
  const result = await papercut($, 's · f')
  expect(result.text).toContain('No se pudo escribir en')
  expect(host.writes).toHaveLength(0)
})
