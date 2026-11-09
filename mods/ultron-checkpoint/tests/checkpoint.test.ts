import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { formatList, parseChangedCounts, parseIndex, parseRefs, parseStatusV2, refSegment, refsToPrune } from '../hooks/checkpoint'

const SHA = (n: number): string => n.toString(16).padStart(40, '0')
const START = 1_760_000_000_000

test('lee HEAD y cuenta entradas del status v2', () => {
  expect(parseStatusV2(`# branch.oid ${SHA(1)}\n# branch.head main\n1 .M N... 100644 100644 100644 a b x.ts\n? nuevo.ts\n`)).toEqual({ head: SHA(1), entries: 2 })
  expect(parseStatusV2('# branch.oid (initial)\n# branch.head main\n')).toEqual({ head: null, entries: 0 })
})

test('refs ordenadas por instante y poda de las que sobran', () => {
  const refs = parseRefs(`refs/ultron/checkpoints/s/100\t${SHA(1)}\nrefs/ultron/checkpoints/s/300\t${SHA(3)}\nrefs/ultron/checkpoints/s/raro\t${SHA(9)}\nrefs/ultron/checkpoints/t/200\t${SHA(2)}\n`)
  expect(refs.map((r) => r.takenAt)).toEqual([300, 200, 100])
  expect(refsToPrune(refs, 2)).toEqual(['refs/ultron/checkpoints/s/100'])
  expect(refSegment('a b/../c.lock')).toBe('a-b-..-c')
})

test('cuenta ficheros por foto y valida el número de /checkpoint-diff', () => {
  const counts = parseChangedCounts(`\0${SHA(1)}\n\na.ts\nb.ts\n\0${SHA(2)}\n\n`)
  expect(counts.get(SHA(1))).toBe(2)
  expect(counts.get(SHA(2))).toBe(0)
  expect(formatList([{ ref: 'refs/ultron/checkpoints/s/1', sha: SHA(1), takenAt: 1 }], counts)).toContain('1. ')
  expect(parseIndex('', 3)).toMatchObject({ error: expect.stringContaining('Uso: /checkpoint-diff') })
  expect(parseIndex('x', 3)).toMatchObject({ error: expect.stringContaining('no es un número') })
  expect(parseIndex('4', 3)).toMatchObject({ error: 'Solo hay 3 checkpoints en esta sesión.' })
  expect(parseIndex('2', 3)).toBe(2)
})

type Call = { argv: string[]; env: Record<string, string>; stdin: string | undefined }

type Host = {
  isRepo: boolean
  entries: number
  refs: Map<string, string>
  failOn: string | null
  slowOn: string | null
  calls: Call[]
  logs: string[]
  queued: string[]
  tools: number
}

const newHost = (over: Partial<Host> = {}): Host => ({
  isRepo: true,
  entries: 2,
  refs: new Map(),
  failOn: null,
  slowOn: null,
  calls: [],
  logs: [],
  queued: [],
  tools: 0,
  ...over,
})

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const failed = (stderr: string) => ({ value: { exitCode: 128, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })

/** git simulado: lo justo para la foto, la poda y los comandos. */
function git(host: Host, argv: string[], stdin: string | undefined) {
  const sub = argv[1] ?? ''
  if (sub === 'rev-parse') return host.isRepo ? ok('C:/Repo\nC:/Repo/.git\n') : failed('fatal: not a git repository (or any of the parent directories): .git')
  if (sub === host.failOn) return failed(`fatal: ${sub} roto`)
  if (sub === 'status') return ok(`# branch.oid ${SHA(1)}\n# branch.head main\n${'? x\n'.repeat(host.entries)}`)
  if (sub === 'write-tree') return ok(`${SHA(7)}\n`)
  if (sub === 'commit-tree') return ok(`${SHA(8)}\n`)
  if (sub === 'update-ref' && argv[2] === '--stdin') {
    for (const line of (stdin ?? '').split('\n')) if (line.startsWith('delete ')) host.refs.delete(line.slice(7))
    return ok('')
  }
  if (sub === 'update-ref') {
    host.refs.set(argv[2]!, argv[3]!)
    return ok('')
  }
  if (sub === 'for-each-ref') {
    const prefix = argv[3]!
    return ok([...host.refs].filter(([ref]) => ref.startsWith(prefix)).map(([ref, sha]) => `${ref}\t${sha}\n`).join(''))
  }
  if (sub === 'log') return ok(argv.slice(5).map((sha) => `\0${sha}\n\nsrc/app.ts\n`).join(''))
  if (sub === 'diff') return ok(' src/app.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n')
  return ok('')
}

async function start($: Engine, on: On, host: Host, env: Record<string, string> = {}): Promise<MockClock> {
  const clock = mock.clock(on, { now: START })
  mock.env(on, env)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', async () => ({ value: 'C:/Repo' }))
  on('session.id', async () => ({ value: 'ses-1' }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('ui.log', async (_$, e) => {
    host.logs.push(e.text)
    return { value: undefined }
  })
  on('command.run', async (_$, e) => {
    host.queued.push(e.command)
    return { text: '' }
  })
  on('tool.call', async () => {
    host.tools += 1
    return { result: 'ok' } as never
  })
  on('process.run', async (_$, e) => {
    const argv = [...e.argv]
    host.calls.push({ argv, env: { ...e.init?.env }, stdin: e.init?.stdin })
    if (argv[0] === 'node') return ok('')
    if (argv[1] === host.slowOn) {
      await clock.sleep(11_000)
      return { deny: 'the child timed out' }
    }
    return git(host, argv, e.init?.stdin)
  })
  await $.session.start({ cwd: 'C:/Repo', surface: 'terminal', isInteractive: true })
  return clock
}

const edit = ($: Engine, tool = 'Edit') =>
  $.tool.call({ tool, tool_use_id: `t-${Math.random()}`, file_path: 'C:/Repo/src/app.ts', old_string: 'a', new_string: 'b', command: 'ls' } as never)

const snapshotsTaken = (host: Host) => host.calls.filter((c) => c.argv[1] === 'update-ref' && c.argv[2] !== '--stdin')

test('una sola foto por turno aunque haya varias ediciones, y otra en el turno siguiente', async ($, on) => {
  const host = newHost()
  const clock = await start($, on, host)
  await $.turn.start({ text: 'edita', turnId: 'u1' })
  await Promise.all([edit($), edit($, 'Write')])
  await edit($, 'Bash')
  await clock.settle()
  expect(snapshotsTaken(host)).toHaveLength(1)
  expect(host.tools).toBe(3)
  await clock.advance(1_000)
  await $.turn.start({ text: 'otra', turnId: 'u2' })
  await edit($)
  await clock.settle()
  expect(snapshotsTaken(host).map((c) => c.argv[2])).toEqual([`refs/ultron/checkpoints/ses-1/${START}`, `refs/ultron/checkpoints/ses-1/${START + 1_000}`])
})

test('la foto usa un índice temporal, nunca el real, y lo borra después', async ($, on) => {
  const host = newHost()
  const clock = await start($, on, host)
  await $.turn.start({ text: 'edita', turnId: 'u1' })
  await edit($)
  await clock.settle()
  const tmp = `C:/Repo/.git/ultron-checkpoint-${START}.index`
  const add = host.calls.find((c) => c.argv[1] === 'add')
  expect(add?.argv).toEqual(['git', 'add', '-A'])
  expect(add?.env.GIT_INDEX_FILE).toBe(tmp)
  expect(host.calls.find((c) => c.argv[1] === 'write-tree')?.env.GIT_INDEX_FILE).toBe(tmp)
  expect(host.calls.find((c) => c.argv[1] === 'commit-tree')?.argv).toContain(SHA(1))
  const node = host.calls.filter((c) => c.argv[0] === 'node').map((c) => c.argv.slice(2))
  expect(node).toEqual([['copy', 'C:/Repo/.git/index', tmp], ['remove', tmp, `${tmp}.lock`]])
  expect(host.logs).toEqual([])
})

test('las ediciones que no son de herramientas de edición no hacen foto', async ($, on) => {
  const host = newHost()
  const clock = await start($, on, host)
  await $.turn.start({ text: 'lee', turnId: 'u1' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: 'C:/Repo/x' } as never)
  await clock.settle()
  expect(host.calls).toHaveLength(0)
})

test('fuera de un repo no hace foto ni avisa, y la edición sigue', async ($, on) => {
  const host = newHost({ isRepo: false })
  const clock = await start($, on, host)
  await $.turn.start({ text: 'edita', turnId: 'u1' })
  await edit($)
  await clock.settle()
  expect(host.calls.map((c) => c.argv[1])).toEqual(['rev-parse'])
  expect(host.logs).toEqual([])
  expect(host.tools).toBe(1)
  const result = await $.command.run({ command: 'checkpoints', args: '' } as never)
  expect(result.text).toBe('No es un repositorio git: C:/Repo')
})

test('si git falla, avisa una vez, la edición sigue y el índice temporal se borra', async ($, on) => {
  const host = newHost({ failOn: 'commit-tree' })
  const clock = await start($, on, host)
  for (const id of ['u1', 'u2']) {
    await $.turn.start({ text: 'edita', turnId: id })
    await edit($)
    await clock.settle()
  }
  expect(host.tools).toBe(2)
  expect(snapshotsTaken(host)).toHaveLength(0)
  expect(host.logs).toEqual(['Checkpoint: foto omitida: git commit-tree: fatal: commit-tree roto.'])
  expect(host.calls.filter((c) => c.argv[2] === 'remove')).toHaveLength(2)
  const listed = await $.command.run({ command: 'checkpoints', args: '' } as never)
  expect(listed.text).toContain('Último aviso: foto omitida: git commit-tree: fatal: commit-tree roto.')
})

test('con más de 5.000 entradas en git status se omite con aviso', async ($, on) => {
  const host = newHost({ entries: 5_001 })
  const clock = await start($, on, host)
  await $.turn.start({ text: 'edita', turnId: 'u1' })
  await edit($)
  await clock.settle()
  expect(host.calls.some((c) => c.argv[1] === 'add')).toBe(false)
  expect(host.logs).toEqual(['Checkpoint: foto omitida: git status lista 5001 entradas (el tope es 5000).'])
})

test('si la foto pasa de 10 s se omite con aviso y la edición sigue', async ($, on) => {
  const host = newHost({ slowOn: 'add' })
  const clock = await start($, on, host)
  await $.turn.start({ text: 'edita', turnId: 'u1' })
  const call = edit($)
  await clock.advance(11_000)
  await call
  await clock.settle()
  expect(host.tools).toBe(1)
  expect(snapshotsTaken(host)).toHaveLength(0)
  expect(host.logs[0]).toContain('Checkpoint: foto omitida: superó el tope de 10 s')
})

test('poda: conserva los 30 más recientes del repo', async ($, on) => {
  const old = new Map(Array.from({ length: 30 }, (_, i) => [`refs/ultron/checkpoints/otra/${START - 100 + i}`, SHA(100 + i)] as [string, string]))
  const host = newHost({ refs: old })
  const clock = await start($, on, host)
  await $.turn.start({ text: 'edita', turnId: 'u1' })
  await edit($)
  await clock.settle()
  expect(host.refs.size).toBe(30)
  expect(host.refs.has(`refs/ultron/checkpoints/otra/${START - 100}`)).toBe(false)
  expect(host.refs.has(`refs/ultron/checkpoints/ses-1/${START}`)).toBe(true)
})

test('/checkpoints lista las fotos de la sesión y /checkpoint-diff resume contra el árbol actual', async ($, on) => {
  const host = newHost({ refs: new Map([['refs/ultron/checkpoints/otra/5', SHA(5)]]) })
  const clock = await start($, on, host)
  await $.turn.start({ text: 'edita', turnId: 'u1' })
  await edit($)
  await clock.settle()
  const listed = await $.command.run({ command: 'checkpoints', args: '' } as never)
  expect(listed.text).toContain('Checkpoints de esta sesión (1, el 1 es el más reciente):')
  expect(listed.text).toContain('1 fichero cambiado respecto a HEAD')
  expect(listed.text).toContain(`git restore --source=refs/ultron/checkpoints/ses-1/${START} --worktree -- .`)
  expect(listed.text).not.toContain('otra')
  const usage = await $.command.run({ command: 'checkpoint-diff', args: '' } as never)
  expect(usage.text).toContain('Uso: /checkpoint-diff <n>')
  const tooFar = await $.command.run({ command: 'checkpoint-diff', args: '2' } as never)
  expect(tooFar.text).toBe('Solo hay 1 checkpoints en esta sesión.')
  const diff = await $.command.run({ command: 'checkpoint-diff', args: '1' } as never)
  expect(diff.text).toContain('1 file changed')
  expect(host.calls.find((c) => c.argv[1] === 'diff')?.argv).toEqual(['git', 'diff', '--stat', SHA(8), SHA(7)])
})

test('dentro de ULTRON Sessions el aviso no lanza ningún comando en la TUI', async ($, on) => {
  const host = newHost({ failOn: 'add' })
  const clock = await start($, on, host, { ULTRON_SESION_ID: 'ses-ultron' })
  await $.turn.start({ text: 'edita', turnId: 'u1' })
  await edit($)
  await clock.settle()
  expect(host.queued).toEqual([])
})

test('Bash no hace foto: solo las herramientas de edición', async ($, on) => {
  const host = newHost()
  const clock = await start($, on, host)
  await $.turn.start({ text: 'ejecuta', turnId: 'u1' })
  await edit($, 'Bash')
  await clock.settle()
  expect(snapshotsTaken(host)).toHaveLength(0)
})
