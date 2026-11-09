/**
 * Backend simulado del puente v2 y arranque de una sesión de prueba.
 *
 * El backend responde a `hello` (subiendo la generación), `events`, `ask`
 * asíncrono, `ask/wait` multiplexado, `ask/cancel`, `inbox` y `result`. Los
 * sondeos largos esperan a que la prueba cambie algo o a que el reloj simulado
 * pase 20 s.
 */
import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, Register, ToolCheckResult } from 'claude-code'

export const CWD = 'C:/Users/demo/proyecto'
export const ENV = { ULTRON_PUENTE_URL: 'http://127.0.0.1:47011/', ULTRON_PUENTE_TOKEN: 'tok-123', ULTRON_SESION_ID: 's1' }

export type Body = Record<string, unknown> & { events?: Record<string, unknown>[]; askIds?: string[] }
/** `isStale`: lote de una generación anterior que el backend no aplicó. */
export type Call = { path: string; body: Body; auth?: string; status?: number; isStale?: true }

type AskState = { status: 'answered'; answer: unknown } | { status: 'cancelled'; reason: string }

export type Backend = {
  calls: Call[]
  protocol: number | null
  generation: number
  launchPermissionMode: string | null
  /** Estados scriptados para `/v1/events` (se consumen en orden; luego 200). */
  eventsStatus: number[]
  /**
   * Estados scriptados para `/v1/hello` (se consumen en orden; luego 200).
   * `0`: se acepta pero la respuesta se pierde (error de red).
   */
  helloStatus: number[]
  /** Último `helloSeq` aceptado; como el backend real, uno anterior es `superseded`. */
  lastHelloSeq: number
  isDown: boolean
  /** `/v1/ask` asíncrono: respuestas que fallan antes de dar `askId`. */
  askFailures: number
  /** `/v1/ask/wait`: lanza error de red siempre. */
  isWaitDown: boolean
  /** Respuesta de `/v1/ask` bloqueante (protocolo 1). */
  blockingAnswer: unknown
  asks: Map<string, AskState>
  askSeq: number
  /** Lotes de operaciones que devolverá `/v1/inbox`, en orden. */
  inbox: unknown[][]
  /** Despierta los sondeos en espera. */
  poke: () => void
  resolveAsk: (askId: string, state: AskState) => void
  deliver: (ops: unknown[]) => void
}

const sleepers = new WeakMap<Backend, (() => void)[]>()

function changed(backend: Backend): Promise<void> {
  return new Promise((resolve) => sleepers.get(backend)?.push(resolve))
}

export function newBackend(patch: Partial<Backend> = {}): Backend {
  const waiting: (() => void)[] = []
  const wake = (): void => {
    for (const resolve of waiting.splice(0)) resolve()
  }
  const backend: Backend = {
    calls: [],
    protocol: 2,
    generation: 0,
    launchPermissionMode: 'bypassPermissions',
    eventsStatus: [],
    helloStatus: [],
    lastHelloSeq: 0,
    isDown: false,
    askFailures: 0,
    isWaitDown: false,
    blockingAnswer: null,
    asks: new Map(),
    askSeq: 0,
    inbox: [],
    poke: () => wake(),
    resolveAsk: (askId, state) => {
      backend.asks.set(askId, state)
      wake()
    },
    deliver: (ops) => {
      backend.inbox.push(ops)
      wake()
    },
    ...patch,
  }
  sleepers.set(backend, waiting)
  return backend
}

export const paths = (backend: Backend, path: string): Call[] => backend.calls.filter((call) => call.path === path)

/** Eventos aplicados por el backend (sin los lotes `stale`). */
export const sentEvents = (backend: Backend): Record<string, unknown>[] =>
  paths(backend, '/v1/events').filter((call) => call.isStale !== true).flatMap((call) => call.body.events ?? [])

export const eventsOf = (backend: Backend, type: string): Record<string, unknown>[] => sentEvents(backend).filter((event) => event.type === type)

const ok = (text: unknown, status = 200) => ({ value: { status, ok: status < 400, headers: {}, text: JSON.stringify(text) } })

function waitResults(backend: Backend, askIds: string[]) {
  return askIds.map((askId) => {
    const state = backend.asks.get(askId)
    return state === undefined ? { askId, status: 'pending' } : { askId, ...state }
  })
}

async function onWait(backend: Backend, clock: MockClock, body: Body) {
  if (backend.isWaitDown) throw new Error('connect ECONNREFUSED')
  if (typeof body.generation === 'number' && body.generation < backend.generation) return ok({ stale: true })
  const askIds = body.askIds ?? []
  if (!askIds.some((askId) => backend.asks.has(askId))) await Promise.race([changed(backend), clock.sleep(20_000)])
  return ok({ results: waitResults(backend, askIds) })
}

async function onInbox(backend: Backend, clock: MockClock, body: Body) {
  if (typeof body.generation === 'number' && body.generation < backend.generation) return ok({ stale: true })
  if (backend.inbox.length === 0) await Promise.race([changed(backend), clock.sleep(20_000)])
  if (typeof body.generation === 'number' && body.generation < backend.generation) return ok({ stale: true })
  return ok({ ops: backend.inbox.shift() ?? [] })
}

function onAsk(backend: Backend, body: Body) {
  if (body.async !== true) return ok({ answer: backend.blockingAnswer })
  if (backend.askFailures > 0) {
    backend.askFailures -= 1
    return ok({ error: 'caído' }, 503)
  }
  backend.askSeq += 1
  return ok({ askId: `a${backend.askSeq}` })
}

/** Como el backend real: un lote de una generación anterior es `stale` con la vigente. */
function onEvents(backend: Backend, body: Body) {
  const status = backend.eventsStatus.shift() ?? 200
  const isOld = typeof body.generation === 'number' && body.generation < backend.generation
  if (status === 200 && isOld) return ok({ stale: true, generation: backend.generation })
  return ok({ ok: true }, status)
}

function onHello(backend: Backend, body: Body) {
  const status = backend.helloStatus.shift() ?? 200
  if (status !== 200 && status !== 0) return ok({ error: 'rechazado' }, status)
  if (backend.protocol === null) return ok({ ok: true })
  const seq = typeof body.helloSeq === 'number' ? body.helloSeq : null
  if (seq !== null && seq < backend.lastHelloSeq) return ok({ ok: true, superseded: true, generation: backend.generation })
  if (seq !== null) backend.lastHelloSeq = seq
  backend.generation += 1
  if (status === 0) throw new Error('socket hang up')
  return ok({ ok: true, protocol: backend.protocol, generation: backend.generation, launchPermissionMode: backend.launchPermissionMode })
}

async function route(backend: Backend, clock: MockClock, path: string, body: Body) {
  if (path === '/v1/hello') return onHello(backend, body)
  if (path === '/v1/events') return onEvents(backend, body)
  if (path === '/v1/ask') return onAsk(backend, body)
  if (path === '/v1/ask/wait') return onWait(backend, clock, body)
  if (path === '/v1/inbox') return onInbox(backend, clock, body)
  return ok({ ok: true })
}

/** Registra el backend simulado como `http.fetch` de la prueba. */
export function serve(on: On, backend: Backend, clock: MockClock): void {
  on('http.fetch', async (_$, e) => {
    const path = new URL(e.url).pathname
    const body = JSON.parse(e.init?.body ?? 'null') as Body
    const call: Call = { path, body, auth: e.init?.headers?.authorization }
    backend.calls.push(call)
    if (backend.isDown && path.startsWith('/v1/')) throw new Error('connect ECONNREFUSED 127.0.0.1:47011')
    const response = await route(backend, clock, path, body)
    call.status = response.value.status
    if (path === '/v1/events' && JSON.parse(response.value.text).stale === true) call.isStale = true
    return response
  })
}

export type Session = {
  clock: MockClock
  backend: Backend
  /** Superficies de `$.session.surfaces()`: `terminal` bajo la TUI, ninguna en un hijo `-p` o del SDK. */
  surfaces: ('terminal')[]
  /** Comandos que llegaron al fondo de `command.run` (el motor). */
  commandRuns: { command: string; args: string }[]
  /** Respuesta del fondo de `command.run`; una promesa deja el comando en marcha. */
  commandResult: () => Promise<{ text?: string }>
  configSets: { key: string; value: unknown }[]
  configResult: { value: unknown } | { deny: string }
  verdict: ToolCheckResult
  engineToolCalls: string[]
  /**
   * Herramientas cuyo `ask` llegó al diálogo de la TUI oculta: el
   * `classic.PermissionRequest` que ningún plugin contestó.
   */
  tuiDialogs: string[]
  /** Id de la conversación que devuelve `$.session.id()`. */
  sessionId: string
  /** Modelo que devuelve `$.session.model()` (cambia con `/model`). */
  model: string
  turnAborts: string[]
  /** Lo que llegó al fondo de `prompt.fill` (la caja oculta de la TUI). */
  promptFills: unknown[]
  /** Lo que llegó al fondo de `ui.open` (paneles abiertos en la TUI oculta). */
  uiOpens: unknown[]
  /** Comandos de la lista viva. */
  commands: { name: string; description: string; source: 'builtin' | 'plugin' | 'user' | 'mcp'; plugin?: string }[]
}

/** Sesión, lista de comandos, ajustes, entrada y paneles del motor de pruebas. */
function sessionHooks(on: On, session: Session): void {
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('session.id', async () => ({ value: session.sessionId }))
  on('session.cwd', async () => ({ value: CWD }))
  on('session.surfaces', async () => ({ value: session.surfaces }))
  on('session.model', async () => ({ value: session.model }))
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }) as never)
  on('command.list', async () => ({ value: session.commands }))
  on('command.run', async (_$, e) => {
    session.commandRuns.push({ command: e.command, args: e.args })
    return session.commandResult()
  })
  on('config.list', async () => ({ value: [{ key: 'verbose', label: 'Verbose', kind: 'boolean', value: false, provider: { plugin: 'engine', tier: 'core' }, isLocked: false }] }) as never)
  on('config.set', async (_$, e) => {
    session.configSets.push({ key: e.key, value: e.value })
    return session.configResult as never
  })
  on('turn.abort', async (_$, e) => {
    session.turnAborts.push(e.turnId)
    return { value: undefined }
  })
  on('prompt.read', async () => ({ value: { text: 'texto escrito', cursor: 13 } }))
  on('prompt.fill', async (_$, e) => {
    session.promptFills.push(e)
    return { isFilled: true }
  })
  on('ui.open', async (_$, e) => {
    session.uiOpens.push(e)
    return { value: { isPlaced: true as const } }
  })
}

/**
 * Turnos, herramientas y hooks clásicos del motor de pruebas.
 *
 * Desde el kit 2.1.309, `$.tool.call` pasa por `tool.check` y, ante un `ask`,
 * el propio motor lanza `classic.PermissionRequest` (EngineToolCall en
 * index.d.ts). El fondo de ese hook hace de diálogo de la TUI: lo anota y
 * contesta «sí», como haría la persona con la terminal a la vista.
 */
function turnHooks(on: On, session: Session): void {
  on('fs.read', async () => ({ value: '# Plan\n1. Crear el puente.' }))
  on('prompt.attachment', async (_$, e) => ({ text: e.text }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('tool.check', async () => session.verdict)
  on('classic.UserPromptSubmit', async () => ({}))
  on('classic.SessionStart', async () => ({}))
  on('classic.PermissionRequest', async (_$, e) => {
    session.tuiDialogs.push(e.tool_name)
    return { decision: { behavior: 'allow' as const } }
  })
  on('tool.call', async (_$, e) => {
    session.engineToolCalls.push(String(e.tool))
    if ((e as { boom?: unknown }).boom === true) throw new Error('herramienta rota')
    return { result: 'ok' as never }
  })
}

/**
 * Plugin en línea por encima de todos (`prepend`) que anota la respuesta que
 * recibe el motor a cada `classic.PermissionRequest`. Un plugin en línea corre
 * en su propio entorno y no ve las variables de la prueba, así que la manda
 * por `$.http.fetch` a `/permission` y el backend simulado la guarda.
 */
export const PERMISSION_SPY = {
  name: 'espia-permisos',
  tier: 'prepend' as const,
  register: ((on) => {
    on('classic.PermissionRequest', async ($, e, next) => {
      const answer = await next(e)
      await $.http.fetch('http://espia/permission', { method: 'POST', body: JSON.stringify(answer) })
      return answer
    })
  }) as Register,
}

/** Respuestas a `classic.PermissionRequest` que vio el motor, en orden (con PERMISSION_SPY). */
export const permissionAnswers = (backend: Backend): unknown[] => paths(backend, '/permission').map((call) => call.body)

/** Motor mínimo debajo de los plugins y arranque de la sesión (hello y buzón). */
export async function start($: Engine, on: On, backend: Backend, env: Record<string, string> = ENV, isInteractive = true): Promise<Session> {
  const clock = mock.clock(on, { now: 1_000 })
  const session: Session = {
    clock,
    backend,
    surfaces: isInteractive ? ['terminal'] : [],
    commandRuns: [],
    commandResult: async () => ({ text: 'ok' }),
    configSets: [],
    configResult: { value: true },
    verdict: { decision: 'ask', reason: 'regla del modo' },
    engineToolCalls: [],
    tuiDialogs: [],
    sessionId: 'claude-1',
    model: 'claude-opus-5-5',
    turnAborts: [],
    promptFills: [],
    uiOpens: [],
    commands: [{ name: 'cost', description: 'Coste', source: 'builtin' }],
  }
  mock.env(on, env)
  serve(on, backend, clock)
  sessionHooks(on, session)
  turnHooks(on, session)
  await restart($, clock, isInteractive)
  return session
}

/** `session.start` (también lo que hace una recarga en caliente del mod) y su hello. */
export async function restart($: Engine, clock: MockClock, isInteractive = true): Promise<void> {
  await $.session.start({ cwd: CWD, surface: isInteractive ? 'terminal' : null, isInteractive })
  await clock.advance(10)
  await clock.advance(10)
}

/** Argumentos completos de `$.command.run` desde el motor (lo que escribe la persona). */
export const typed = (command: string, args = '') => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 80 },
})

export const QUESTIONS = [
  {
    question: '¿Qué base de datos usamos?',
    header: 'Base',
    multiSelect: false,
    options: [
      { label: 'SQLite', description: 'Un fichero local' },
      { label: 'Postgres', description: 'Servidor' },
    ],
  },
]

/** Deja correr lo pendiente sin mover el reloj, varias vueltas. */
export async function settle(clock: MockClock, rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await clock.settle()
}
