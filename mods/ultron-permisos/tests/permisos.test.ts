import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, ToolCheckResult } from 'claude-code'

const ROOT = 'C:/Users/demo/proyecto'
const NOW = Date.parse('2026-10-17T22:00:00Z')

type Host = { verdict: ToolCheckResult; toasts: string[]; statuses: (string | undefined)[]; isRejected: boolean }

const newHost = (verdict: ToolCheckResult = { decision: 'ask' }): Host => ({
  verdict,
  toasts: [],
  statuses: [],
  isRejected: false,
})

/** Motor mínimo: el veredicto del núcleo es `host.verdict`; la llamada real consulta tool.check. */
async function start($: Engine, on: On, host: Host, stored: Readonly<Record<string, unknown>> = {}): Promise<void> {
  mock.store(on, stored)
  mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:/Users/demo' })
  on('classic.UserPromptSubmit', async () => ({}))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.root', async () => ({ value: ROOT }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.status', async (_$, e) => {
    host.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', async (_$, e) => {
    host.toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.check', async () => host.verdict)
  // Desde el kit 2.1.309, `$.tool.call` pasa por `tool.check` con el id de la
  // llamada y, ante un `ask`, el motor lanza `classic.PermissionRequest`: este
  // hook hace de diálogo. Un `$.tool.check` desde un hook es una consulta y no
  // lleva `tool_use_id`, así que no puede simular la aprobación.
  on('classic.PermissionRequest', async () =>
    host.isRejected
      ? { decision: { behavior: 'deny' as const, message: "The user doesn't want to proceed with this tool use." } }
      : { decision: { behavior: 'allow' as const } },
  )
  on('tool.call', async () => ({ result: 'ok' as never }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
}

const check = ($: Engine, tool: string, input: unknown) => $.tool.check({ tool, input })

const bash = ($: Engine, command: string, id: string) =>
  $.tool.call({ tool: 'Bash', command, tool_use_id: id } as never)

test('aprueba lo seguro cuando el núcleo pregunta y cuenta en la línea de estado', async ($, on) => {
  const host = newHost()
  await start($, on, host)
  expect(await check($, 'Bash', { command: 'git status && cargo test' })).toMatchObject({ decision: 'allow' })
  expect(await check($, 'Edit', { file_path: `${ROOT}/src/a.ts` })).toMatchObject({ decision: 'allow' })
  expect(host.statuses.at(-1)).toBe('permisos: 2 auto')
})

test('no aprueba rm, ediciones en entrega/ ni fuera del proyecto', async ($, on) => {
  const host = newHost()
  await start($, on, host)
  expect(await check($, 'Bash', { command: 'rm -rf build' })).toMatchObject({ decision: 'ask' })
  expect(await check($, 'Write', { file_path: `${ROOT}/entrega/memoria.md` })).toMatchObject({ decision: 'ask' })
  expect(await check($, 'Edit', { file_path: 'D:/otro/a.ts' })).toMatchObject({ decision: 'ask' })
})

test('nunca pisa un deny, ni una decisión de hook clásico o de regla', async ($, on) => {
  const denied = newHost({ decision: 'deny', reason: 'deny-secrets' })
  await start($, on, denied)
  expect(await check($, 'Read', { file_path: `${ROOT}/a.ts` })).toMatchObject({ decision: 'deny' })
  denied.verdict = { decision: 'ask', hook: 'PreToolUse' }
  expect(await check($, 'Read', { file_path: `${ROOT}/a.ts` })).toMatchObject({ decision: 'ask' })
  denied.verdict = { decision: 'ask', rule: 'Bash(git status:*)' }
  expect(await check($, 'Bash', { command: 'git status' })).toMatchObject({ decision: 'ask' })
})

test('tres aprobaciones a mano proponen la regla una vez; aceptarla la aplica', async ($, on) => {
  const host = newHost()
  await start($, on, host)
  for (const id of ['t1', 't2', 't3', 't4']) await bash($, 'npm install zod', id)
  expect(host.toasts).toEqual(['Has aprobado `Bash(npm install:*)` 3 veces. /permisos aceptar 1 para auto-aprobarla.'])
  const listed = await $.command.run({ command: 'permisos', args: '' } as never)
  expect(listed.text).toContain('1. Bash(npm install:*)')
  const accepted = await $.command.run({ command: 'permisos', args: 'aceptar 1' } as never)
  expect(accepted.text).toBe('Regla aprendida: Bash(npm install:*)')
  expect(await check($, 'Bash', { command: 'npm install vitest' })).toMatchObject({ decision: 'allow' })
  const removed = await $.command.run({ command: 'permisos', args: 'quitar 1' } as never)
  expect(removed.text).toBe('Regla retirada: Bash(npm install:*)')
  expect(await check($, 'Bash', { command: 'npm install vitest' })).toMatchObject({ decision: 'ask' })
})

test('un rechazo de la persona no cuenta como aprobación y git push nunca se propone', async ($, on) => {
  const host = newHost()
  await start($, on, host)
  host.isRejected = true
  for (const id of ['r1', 'r2', 'r3']) await bash($, 'npm install zod', id)
  host.isRejected = false
  for (const id of ['p1', 'p2', 'p3']) await bash($, 'git push origin main', id)
  expect(host.toasts).toEqual([])
  // Control positivo: el arnés sí aprueba; los tres rechazos no contaron.
  for (const id of ['a1', 'a2']) await bash($, 'npm install zod', id)
  expect(host.toasts).toEqual([])
  await bash($, 'npm install zod', 'a3')
  expect(host.toasts).toHaveLength(1)
})

test('H29: en plan y en dontAsk no auto-aprueba nada; al volver a default, sí', async ($, on) => {
  const host = newHost()
  await start($, on, host)
  await $.classic.UserPromptSubmit({ prompt: 'x', permission_mode: 'plan' } as never)
  expect(await check($, 'Edit', { file_path: `${ROOT}/src/a.ts` })).toMatchObject({ decision: 'ask' })
  expect(await check($, 'Bash', { command: 'git status' })).toMatchObject({ decision: 'ask' })
  await $.classic.UserPromptSubmit({ prompt: 'x', permission_mode: 'dontAsk' } as never)
  expect(await check($, 'Edit', { file_path: `${ROOT}/src/a.ts` })).toMatchObject({ decision: 'ask' })
  await $.classic.UserPromptSubmit({ prompt: 'x', permission_mode: 'default' } as never)
  expect(await check($, 'Edit', { file_path: `${ROOT}/src/a.ts` })).toMatchObject({ decision: 'allow' })
})

test('H23/H28: credenciales por shell, lectura o edición y ficheros de configuración no se auto-aprueban', async ($, on) => {
  const host = newHost()
  await start($, on, host)
  const dotenv = `.${'env'}`
  expect(await check($, 'PowerShell', { command: `Get-Content ${dotenv}` })).toMatchObject({ decision: 'ask' })
  expect(await check($, 'Read', { file_path: `${ROOT}/${dotenv}` })).toMatchObject({ decision: 'ask' })
  expect(await check($, 'Grep', { pattern: 'KEY', path: `${ROOT}/${dotenv}` })).toMatchObject({ decision: 'ask' })
  expect(await check($, 'Edit', { file_path: `${ROOT}/.claude/settings.json` })).toMatchObject({ decision: 'ask' })
  expect(await check($, 'PowerShell', { command: 'Get-Content src/a.ts' })).toMatchObject({ decision: 'allow' })
})

test('/permisos pausar-env escribe la pausa; reanudar-env la cierra; sin minutos no toca nada', async ($, on) => {
  const files = new Map<string, string>()
  on('fs.read', async (_$, e, next) => {
    const text = files.get(e.path)
    return text === undefined ? next(e) : { value: text }
  })
  on('fs.write', async (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  await start($, on, newHost())
  const run = async (args: string) => (await $.command.run({ command: 'permisos', args } as never)).text
  expect(await run('pausar-env')).toContain('Indica los minutos')
  expect(await run('pausar-env 9999')).toContain('Indica los minutos')
  expect(files.size).toBe(0)
  expect(await run('reanudar-env')).toContain('No había pausa activa')
  const pausada = await run('pausar-env 60')
  expect(pausada).toContain('Pausa puesta durante 60 min')
  // La pausa también abre estos tres: el mensaje tiene que decirlo (auditoría 2026-11-01).
  for (const abierto of ['.claude.json', 'variables de entorno', 'puente de Pupus']) expect(pausada).toContain(abierto)
  const written = [...files.entries()]
  expect(written).toHaveLength(1)
  expect(written[0]?.[0].replace(/\\/g, '/')).toMatch(/demo\/\.ultron\/run\/deny-secrets-pausa\.json$/)
  expect(JSON.parse(written[0]?.[1] ?? '{}').hasta).toBe('2026-10-17T23:00:00.000Z')
  expect(await run('')).toContain('activa, quedan 60 min')
  expect(await run('reanudar-env')).toBe('Pausa cerrada: el .env vuelve a pedir permiso.')
  expect(await run('')).toContain('inactiva')
})

test('/permisos pausar-env sin directorio personal lo dice y no escribe', async ($, on) => {
  let writes = 0
  on('fs.write', async () => {
    writes += 1
    return { value: undefined }
  })
  mock.store(on)
  mock.env(on, {})
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const reply = await $.command.run({ command: 'permisos', args: 'pausar-env 30' } as never)
  expect(reply.text).toContain('No se conoce el directorio personal')
  expect(writes).toBe(0)
})

test('/permisos lista una regla MCP peligrosa aprendida antes como inactiva y no la aplica', async ($, on) => {
  await start($, on, newHost(), { learned: ['mcp__ultron-desktop__click'] })
  const listed = await $.command.run({ command: 'permisos', args: '' } as never)
  expect(listed.text).toContain('mcp__ultron-desktop__click (inactiva')
  expect(await check($, 'mcp__ultron-desktop__click', { x: 1, y: 1 })).toMatchObject({ decision: 'ask' })
})
