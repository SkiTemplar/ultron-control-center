import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { classify, daysUntil, formatAll, parseMarker, parseSubjectRoots, subjectOf } from '../hooks/entregas'

const NOW = new Date(2026, 9, 15, 9, 30).getTime()
const ROOT = 'C:/Users/demo/CARRERA/ASIGNATURAS'
const ROOTS_JSON = JSON.stringify({
  roots: [
    { id: 'asignaturas', path: 'C:\\Users\\demo\\CARRERA\\ASIGNATURAS', kind: 'asignatura' },
    { id: 'personal', path: 'C:\\Users\\demo\\PERSONAL', kind: 'personal' },
  ],
})

const marker = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, tipo: 'trabajo-entrega', protegidas: ['borrador', 'entrega'], asignatura: null, creado: '2026-10-01T00:00:00Z', ...over })

test('raíces de asignaturas y asignatura del cwd', () => {
  const roots = parseSubjectRoots(ROOTS_JSON)
  expect(roots).toEqual([ROOT])
  expect(subjectOf('c:\\users\\demo\\carrera\\asignaturas\\DVJ-Diseno\\codigo', roots)).toMatchObject({ name: 'DVJ-Diseno', dir: `${ROOT}/DVJ-Diseno` })
  expect(subjectOf(ROOT, roots)).toBeNull()
  expect(subjectOf('C:/Users/demo/PERSONAL/x', roots)).toBeNull()
  expect(() => parseSubjectRoots('{}')).toThrow()
})

test('marcador: fecha due, título por carpeta y errores visibles', () => {
  expect(parseMarker(marker({ due: '2026-10-20' }), `${ROOT}/DVJ/P7`, 'DVJ')).toEqual({ dir: `${ROOT}/DVJ/P7`, title: 'P7', subject: 'DVJ', due: '2026-10-20' })
  expect(parseMarker(marker({ titulo: 'Memoria', asignatura: 'ISW' }), 'x/y', 'Z')).toMatchObject({ title: 'Memoria', subject: 'ISW', due: null })
  expect(parseMarker('{roto', 'x', 'Z')).toEqual({ error: 'JSON inválido' })
  expect(parseMarker(marker({ due: '2026-02-31' }), 'x', 'Z')).toMatchObject({ error: expect.stringContaining('no es una fecha') })
})

test('días que faltan con la fecha local y orden por cercanía', () => {
  expect(daysUntil('2026-10-15', NOW)).toBe(0)
  expect(daysUntil('2026-10-29', NOW)).toBe(14)
  expect(daysUntil('2026-10-14', NOW)).toBe(-1)
  const t = (due: string | null, title: string) => ({ dir: title, title, subject: 'S', due })
  const { pending, overdue, undated } = classify([t('2026-11-30', 'b'), t('2026-10-16', 'a'), t('2026-10-01', 'v'), t(null, 'n')], NOW)
  expect(pending.map((p) => p.title)).toEqual(['a', 'b'])
  expect([overdue, undated.length]).toEqual([1, 1])
  expect(formatAll([ROOT], [], [], NOW)).toBe(`No hay entregas pendientes con fecha bajo ${ROOT}.`)
})

type Host = { tree: Record<string, string[]>; files: Record<string, string>; logs: string[]; queued: string[]; lists: string[] }

/** Árbol simulado: `tree[dir]` son sus entradas (las que acaban en `/` son carpetas). */
const newHost = (over: Partial<Host> = {}): Host => ({
  tree: {
    [ROOT]: ['DVJ-Diseno/', 'ISW-Software/', 'node_modules/'],
    [`${ROOT}/DVJ-Diseno`]: ['codigo/', 'notas.md'],
    [`${ROOT}/DVJ-Diseno/codigo`]: ['P7/', 'P8/', '.git/'],
    [`${ROOT}/DVJ-Diseno/codigo/P7`]: ['.ultron-trabajo.json', 'borrador/'],
    [`${ROOT}/DVJ-Diseno/codigo/P7/borrador`]: [],
    [`${ROOT}/DVJ-Diseno/codigo/P8`]: ['.ultron-trabajo.json'],
    [`${ROOT}/ISW-Software`]: ['Memoria/'],
    [`${ROOT}/ISW-Software/Memoria`]: ['.ultron-trabajo.json'],
    [`${ROOT}/node_modules`]: ['.ultron-trabajo.json'],
  },
  files: {
    'C:/Users/demo/.ultron/cockpit/project-roots.json': ROOTS_JSON,
    [`${ROOT}/DVJ-Diseno/codigo/P7/.ultron-trabajo.json`]: marker({ due: '2026-10-20' }),
    [`${ROOT}/DVJ-Diseno/codigo/P8/.ultron-trabajo.json`]: marker({ due: '2026-12-01' }),
    [`${ROOT}/ISW-Software/Memoria/.ultron-trabajo.json`]: marker({ titulo: 'Memoria final' }),
    [`${ROOT}/node_modules/.ultron-trabajo.json`]: marker({ due: '2026-10-16' }),
  },
  logs: [],
  queued: [],
  lists: [],
  ...over,
})

const slash = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')

function fakeHost(on: On, host: Host, cwd: string, env: Record<string, string>) {
  mock.env(on, { USERPROFILE: 'C:\\Users\\demo', ...env })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', async () => ({ value: cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.log', async (_$, e) => {
    host.logs.push(e.text)
    return { value: undefined }
  })
  on('command.run', async (_$, e) => {
    host.queued.push(`${e.command} ${e.args}`)
    return { text: '' }
  })
  on('fs.read', async (_$, e) => {
    const text = host.files[slash(e.path)]
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.list', async (_$, e) => {
    const dir = slash(e.path)
    host.lists.push(dir)
    const entries = host.tree[dir]
    if (entries === undefined) return { deny: `ENOENT: ${dir}` }
    return {
      value: entries.map((name) => ({
        name: name.replace(/\/$/, ''),
        kind: name.endsWith('/') ? ('dir' as const) : ('file' as const),
        size: 1,
        mtimeMs: 0,
        isLink: false,
      })),
    }
  })
}

async function start($: Engine, on: On, host: Host, cwd: string, env: Record<string, string> = {}): Promise<MockClock> {
  const clock = mock.clock(on, { now: NOW })
  fakeHost(on, host, cwd, env)
  await $.session.start({ cwd, surface: 'terminal', isInteractive: true })
  await clock.settle()
  return clock
}

const entregas = ($: Engine, args = '') => $.command.run({ command: 'entregas', args } as never)

test('al arrancar bajo una asignatura avisa solo de las de los próximos 14 días de esa asignatura', async ($, on) => {
  const host = newHost()
  await start($, on, host, `${ROOT}/DVJ-Diseno/codigo/P7`)
  expect(host.logs).toEqual(['Entregas de DVJ-Diseno en los próximos 14 días:\n- [DVJ-Diseno] P7 · 2026-10-20 · faltan 5 días'])
  expect(host.lists.some((d) => d.includes('ISW'))).toBe(false)
  expect(host.lists.some((d) => d.endsWith('.git'))).toBe(false)
})

test('fuera de una asignatura o sin .ultron-trabajo.json no avisa ni busca', async ($, on) => {
  const host = newHost()
  await start($, on, host, 'C:/Users/demo/PERSONAL/Tortunabo')
  expect(host.logs).toEqual([])
  expect(host.lists).toEqual([])
})

test('bajo una asignatura sin entregas no dice nada', async ($, on) => {
  const host = newHost({ tree: { [`${ROOT}/ISW-Software`]: ['apuntes.md'] } })
  await start($, on, host, `${ROOT}/ISW-Software`)
  expect(host.logs).toEqual([])
})

test('dentro de ULTRON Sessions el aviso va al transcript sin lanzar comandos', async ($, on) => {
  const host = newHost()
  await start($, on, host, `${ROOT}/DVJ-Diseno`, { ULTRON_SESION_ID: 'ses-ultron' })
  expect(host.queued).toEqual([])
  expect(host.logs).toHaveLength(1)
})

test('/entregas lista todas las pendientes, las sin fecha y salta node_modules', async ($, on) => {
  const host = newHost()
  await start($, on, host, 'C:/Users/demo')
  const result = await entregas($)
  expect(result.text).toBe(
    [
      'Entregas pendientes (2):',
      '- [DVJ-Diseno] P7 · 2026-10-20 · faltan 5 días',
      '- [DVJ-Diseno] P8 · 2026-12-01 · faltan 47 días',
      'Sin fecha (añade "due": "AAAA-MM-DD" a su .ultron-trabajo.json):',
      `- [ISW-Software] Memoria final · ${ROOT}/ISW-Software/Memoria`,
    ].join('\n'),
  )
  expect(host.lists).not.toContain(`${ROOT}/node_modules`)
})

test('/entregas con un argumento desconocido explica el uso', async ($, on) => {
  const host = newHost()
  await start($, on, host, 'C:/Users/demo')
  expect((await entregas($, 'todas')).text).toContain('Uso: /entregas')
})

test('un marcador roto o una carpeta ilegible se avisan, no se callan', async ($, on) => {
  const host = newHost()
  host.files[`${ROOT}/DVJ-Diseno/codigo/P8/.ultron-trabajo.json`] = '{roto'
  host.tree[`${ROOT}/DVJ-Diseno/codigo`] = ['P7/', 'P8/', 'Bloqueada/']
  await start($, on, host, 'C:/Users/demo')
  const text = (await entregas($)).text ?? ''
  expect(text).toContain(`- ${ROOT}/DVJ-Diseno/codigo/P8/.ultron-trabajo.json: JSON inválido`)
  expect(text).toContain(`- no se pudo leer ${ROOT}/DVJ-Diseno/codigo/Bloqueada: `)
  expect(text).toContain('[DVJ-Diseno] P7')
})

test('sin project-roots.json lo dice al arrancar y en /entregas', async ($, on) => {
  const host = newHost({ files: {} })
  await start($, on, host, `${ROOT}/DVJ-Diseno`)
  expect(host.logs[0]).toContain('No se pudieron revisar las entregas: ')
  expect((await entregas($)).text).toContain('No se pudieron leer las entregas: ')
})

test('la búsqueda se corta a los 5 s con aviso', async ($, on) => {
  const host = newHost()
  let now = NOW
  on('clock.now', async () => ({ value: (now += 2_000) }))
  fakeHost(on, host, 'C:/Users/demo', {})
  await $.session.start({ cwd: 'C:/Users/demo', surface: 'terminal', isInteractive: true })
  const text = (await entregas($)).text ?? ''
  expect(text).toContain('búsqueda cortada a los 5 s: puede faltar alguna entrega.')
})
