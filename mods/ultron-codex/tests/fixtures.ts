import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

/** Fixtures y motor falso compartidos por los tests del mod. */

const BASE = 'C:/Users/demo/.claude/plugins/cache/openai-codex/codex'
export const SCRIPT = `${BASE}/1.0.10/scripts/codex-companion.mjs`

/**
 * Como lo devuelve el companion: `summary` es el inicio del prompt mientras el
 * trabajo está en curso y la primera línea de la salida cuando termina
 * (runTrackedJob lo pisa); el prompt íntegro queda en `request.prompt`.
 */
export const job = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'task',
  kindLabel: 'rescue',
  jobClass: 'task',
  title: 'Codex Task',
  status,
  phase: status === 'running' ? 'investigating' : 'done',
  summary: status === 'running' || status === 'queued' ? `revisar ${id}` : `Salida de ${id}`,
  request: { prompt: `revisar ${id}` },
  elapsed: '12s',
  duration: status === 'running' ? null : '1m 3s',
  ...extra,
})

/** Una revisión tal como la registra `review`: sin `request`. */
export const review = (id: string, status: string) =>
  job(id, status, { kind: 'review', kindLabel: 'review', jobClass: 'review', title: 'Codex Review', request: undefined })

export const statusJson = (running: unknown[], finished: unknown[]) =>
  JSON.stringify({ running, latestFinished: finished[0] ?? null, recent: finished.slice(1), needsReview: false })

export type Host = {
  runs: string[][]
  envs: Array<Record<string, string> | undefined>
  spawned: string[][]
  toasts: string[]
  filled: string[]
  copied: string[]
  status: string
  isInstalled: boolean
  isNodeBroken: boolean
  isFillRefused: boolean
  /** stderr con el que falla `task` (exitCode 1); null = funciona. */
  taskFailure: string | null
  /** stderr con el que falla `status` (exitCode 1); null = funciona. */
  statusFailure: string | null
  /** Lo que tarda `status` en el reloj simulado. */
  statusDelayMs: number
  /** Cómo sale el hijo de `review`. */
  review: { code: number; stderr: string; ms: number; statusAtEnd: string | null }
}

export const newHost = (over: Partial<Host> = {}): Host => ({
  runs: [],
  envs: [],
  spawned: [],
  toasts: [],
  filled: [],
  copied: [],
  status: statusJson([], [job('t-1', 'completed')]),
  isInstalled: true,
  isNodeBroken: false,
  isFillRefused: false,
  taskFailure: null,
  statusFailure: null,
  statusDelayMs: 0,
  review: { code: 0, stderr: '', ms: 0, statusAtEnd: null },
  ...over,
})

const ran = (exitCode: number, stdout: string, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

function answer(argv: readonly string[], host: Host) {
  const sub = argv[2]
  if (sub === 'task') return host.taskFailure === null ? ran(0, JSON.stringify({ jobId: 't-new', status: 'queued' })) : ran(1, '', host.taskFailure)
  if (sub === 'status') return host.statusFailure === null ? ran(0, host.status) : ran(1, '', host.statusFailure)
  if (sub === 'result') return ran(0, JSON.stringify({ job: job(argv[3]!, 'completed'), storedJob: { result: { rawOutput: 'Todo correcto en app.ts' } } }))
  return ran(0, JSON.stringify({ jobId: argv[3], status: 'cancelled' }))
}

function fakeProcesses(on: On, host: Host, clock: MockClock) {
  on('process.run', async (_$, e) => {
    if (host.isNodeBroken) return { deny: 'spawn node ENOENT' }
    host.runs.push([...e.argv])
    host.envs.push(e.init?.env)
    if (e.argv[2] === 'status' && host.statusDelayMs > 0) await clock.sleep(host.statusDelayMs)
    return answer(e.argv, host)
  })
  on('process.spawn', async function* (_$, e) {
    host.spawned.push([...e.argv])
    if (host.review.ms > 0) await clock.sleep(host.review.ms)
    if (host.review.stderr !== '') yield { stream: 'stderr' as const, text: host.review.stderr }
    if (host.review.statusAtEnd !== null) host.status = host.review.statusAtEnd
    return { value: { code: host.review.code, signal: null } }
  })
}

function fakeHost(on: On, host: Host, clock: MockClock) {
  mock.env(on, { USERPROFILE: 'C:\\Users\\demo' })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'ses-1' }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('ui.toast', async (_$, e) => {
    host.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', async () => ({ value: host.isInstalled }))
  on('fs.list', async () => ({
    value: ['1.0.4', '1.0.10'].map((name) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })),
  }))
  fakeProcesses(on, host, clock)
  on('prompt.fill', async (_$, e) => {
    if (host.isFillRefused) return { isFilled: false, refusal: 'dialog' as const }
    host.filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.copy', async (_$, e) => {
    host.copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
}

const PANE_PROPS = { title: 'Codex', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } }

export async function start($: Engine, on: On, host: Host) {
  const clock = mock.clock(on, { now: 1_000 })
  fakeHost(on, host, clock)
  await $.session.start({ cwd: 'C:/demo', surface: 'terminal', isInteractive: true })
  return clock
}

export const mountPane = ($: Engine) =>
  $.ui.mount({ plugin: 'ultron-codex', surface: 'terminal', component: 'Pane', requestId: 'codex', props: PANE_PROPS as never })

export const statusRuns = (host: Host): number => host.runs.filter((argv) => argv[2] === 'status').length
