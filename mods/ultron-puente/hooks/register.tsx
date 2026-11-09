/**
 * ultron-puente: conecta una sesión lanzada por ULTRON Sessions (PTY oculto)
 * con su ventana. Protocolo 2 del contrato de estabilidad (2026-10-08, §6).
 *
 * Sin `ULTRON_PUENTE_URL`, `ULTRON_PUENTE_TOKEN` y `ULTRON_SESION_ID` todos
 * los hooks devuelven `next(e)` sin más: fuera de Sessions el mod no hace
 * nada. Todos llevan `.catch` que deja pasar, salvo `tool.call` con
 * herramientas de persona y `tool.check` con veredicto `ask`, que con el
 * puente activo (configurado y sin otro dueño de la sesión) devuelven `deny`:
 * la TUI está oculta y su diálogo no lo vería nadie. Ningún hook devuelve
 * `context` (0 tokens extra, R31).
 */
import type { EngineInterface, On, Register, ToolCallInput, ToolCallResult } from 'claude-code'

import type { OpOutcome, OpRecord } from '../types'
import { DENY_FORMAT, DENY_UNREACHABLE, PERSON_TOOLS, isFailure, planDecision, planExitMode, questionResult, toAskQuestions, verdictFor } from './answers'
import type { AvisoKind } from './avisos'
import { createAvisos, noticeText } from './avisos'
import type { AskContext, AskOutcome } from './asks'
import { createAsker } from './asks'
import { createBridge } from './bridge'
import type { Bridge, Host } from './bridge'
import { createInbox } from './inbox'
import type { InboxDeps } from './inbox'
import type { CommandItem, HelloPayload, HelloSource, InboxOp, PermissionMode, PuenteConfig, PuenteEvent, TurnUsage } from './protocol'
import { isPermissionMode, parseConfig } from './protocol'
import { MAX_PROMPT_TEXT, clip, permissionSummary, summarizeTool, timeoutOf } from './summary'

const PLUGIN = 'ultron-puente'
const MAIN = 'main'
/** Fuentes de `classic.SessionStart` que cambian o recargan la conversación (§1.4). */
const HELLO_SOURCES: ReadonlySet<string> = new Set(['clear', 'resume', 'compact', 'fork'])
/** `session.end` que no termina el proceso: el buzón sigue. */
const KEEP_INBOX: ReadonlySet<string> = new Set(['clear', 'resume'])
/** Comandos tras los que cambia la lista viva. */
const RELOADS: ReadonlySet<string> = new Set(['reload-plugins', 'reload-skills', 'plugin'])
/** Tope del texto de un comando en `commandEnd`. */
const MAX_COMMAND_TEXT = 32_000
const INTERCEPT_RETIRED = 'La interceptación de menús está retirada: los menús de la TUI se muestran en el chat'
const DENY_AUTO_PANEL = 'ULTRON Sessions: panel automático omitido'
const PLAN_UNREADABLE = 'El plan no está disponible como texto: pide a Claude que lo resuma antes de aprobarlo.'

type Context = {
  config: PuenteConfig
  bridge: Bridge
  asker: ReturnType<typeof createAsker>
  inbox: ReturnType<typeof createInbox>
}

/** Contexto del puente por entorno del módulo; null si no corre bajo Sessions. */
let contextPromise: Promise<Context | null> | null = null
/** El contexto ya resuelto, para los `.catch` y `session.end` (sin `$`). */
let current: Context | null = null
let mainModel: string | null = null
/** Último `status` emitido: tras `/model` se reemite con el modelo nuevo. */
let lastStatus: Extract<PuenteEvent, { type: 'status' }> | null = null
let mainTurnId: string | null = null
let lastHelloSid: string | null = null
let lastMode: PermissionMode | null = null
let lastNonPlanMode: PermissionMode | null = null
let runSeq = 0
/** Fichero del plan por bucle (`main` o el id del subagente), leído de los recordatorios de modo plan. */
const planFiles = new Map<string, string>()
/** Modelo de cada subagente según sus pasos (`turn.step`), hasta su `turn.complete`. */
const agentModels = new Map<string, string>()
/** Subagentes cuyo modelo se recuerda a la vez; por encima se olvida el más antiguo. */
const MAX_AGENT_MODELS = 256
/** Aprobación de plan concedida en la ventana y pendiente de `classic.PermissionRequest`. */
let approvedPlan: { isAgent: boolean; mode: PermissionMode | null } | null = null
/** Filtro de avisos repetidos de otros mods hacia la ventana. */
const avisos = createAvisos()
/** Plugin que sirve cada comando de la lista viva (null: builtin o sin plugin). */
let commandPlugins = new Map<string, string | null>()
/** Comandos en marcha por plugin, y los de plugin desconocido (para `ui.open`). */
const runningPlugins = new Map<string, number>()
let runningUnknown = 0

/** Red y temporizador del motor para el transporte ($ no cruza imports). */
function hostOf($: EngineInterface): Host {
  return {
    fetch: (url, init) => $.http.fetch(url, init),
    after: (ms, fn) => $.clock.after(ms, fn),
  }
}

const OPS_REF = { plugin: 'ultron-puente', key: 'ops' } as const

function depsOf($: EngineInterface, ctx: Context, host: Host): InboxDeps {
  return {
    execute: (op) => execute($, ctx, host, op),
    now: () => $.clock.now(),
    store: {
      read: async () => {
        const { value, version } = await $.state.get(OPS_REF)
        return { records: value ?? [], version }
      },
      write: async (records: OpRecord[], ifVersion: number) => (await $.state.set(OPS_REF, records, { ifVersion })).isSet,
    },
  }
}

async function resolveContext($: EngineInterface): Promise<Context | null> {
  // Los procesos hijos (`claude -p`, el Agent SDK de un worktree, los hooks) heredan
  // las variables del puente: sin este filtro, su `hello` cambiaba el
  // `claudeSessionId` de la sesión, vaciaba el chat y sus turnos pisaban los del
  // padre. Solo la TUI que lanzó Sessions dibuja en `terminal`.
  if (!(await $.session.surfaces()).includes('terminal')) return null
  const [url, token, sesionId] = await Promise.all([
    $.env.get('ULTRON_PUENTE_URL'),
    $.env.get('ULTRON_PUENTE_TOKEN'),
    $.env.get('ULTRON_SESION_ID'),
  ])
  const config = parseConfig(url, token, sesionId)
  if (config === null) return null
  const bridge = createBridge(config)
  return { config, bridge, asker: createAsker(bridge, config.sesionId), inbox: createInbox(bridge, config.sesionId) }
}

/**
 * El contexto activo, o null; un fallo al leer el entorno no se memoriza. Un
 * contexto cuyo `hello` se rechazó con 409 (otro `claude` es dueño de la
 * sesión) cuenta como null: ni eventos, ni `hello` de `/clear` o de turno, ni
 * preguntas a la ventana; todo pasa al motor.
 */
async function contextOf($: EngineInterface): Promise<Context | null> {
  const ctx = await resolvedContext($)
  return ctx !== null && ctx.bridge.isForeign() ? null : ctx
}

/**
 * Si el puente atiende la sesión, para los `.catch` (sin `$`): hay contexto y su
 * `hello` no se rechazó con 409. Con otro dueño, un fallo pasa al motor como
 * sin puente, no se deniega en nombre de una ventana que no pregunta.
 */
const isBridged = (): boolean => current !== null && !current.bridge.isForeign()

function resolvedContext($: EngineInterface): Promise<Context | null> {
  if (contextPromise === null) {
    contextPromise = resolveContext($).then(
      (ctx) => {
        current = ctx
        return ctx
      },
      () => {
        contextPromise = null
        return null
      },
    )
  }
  return contextPromise
}

/** Sesión nueva o recarga del mod: se vuelve a leer el entorno y se olvida el estado anterior. */
function resetSession(): void {
  current?.inbox.stop()
  current?.bridge.close()
  current = null
  contextPromise = null
  mainModel = null
  mainTurnId = null
  lastHelloSid = null
  lastMode = null
  lastNonPlanMode = null
  approvedPlan = null
  planFiles.clear()
  agentModels.clear()
  avisos.clear()
  commandPlugins = new Map()
  runningPlugins.clear()
  runningUnknown = 0
}

/** Emite sin dejar que un fallo del temporizador corte el turno. */
function emit(ctx: Context, host: Host, event: PuenteEvent): void {
  try {
    ctx.bridge.emit(host, event)
  } catch {
    // El evento se pierde; el turno sigue intacto.
  }
}

function notice(ctx: Context, host: Host, text: string): void {
  emit(ctx, host, { type: 'notice', level: 'warn', text })
}

const loopOf = (agentId?: string): { agentId?: string } => (agentId === undefined ? {} : { agentId })

const originText = (origin: { kind: string; name?: string }): string =>
  origin.kind === 'plugin' && typeof origin.name === 'string' ? `plugin:${origin.name}` : origin.kind

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function newRunId(): string {
  runSeq += 1
  return `run-${runSeq}-${Math.random().toString(36).slice(2, 10)}`
}

function markRunning(command: string, delta: 1 | -1): void {
  const plugin = commandPlugins.get(command)
  if (plugin === undefined) runningUnknown = Math.max(0, runningUnknown + delta)
  else if (plugin !== null) runningPlugins.set(plugin, Math.max(0, (runningPlugins.get(plugin) ?? 0) + delta))
}

const isPluginRunning = (plugin: string): boolean => (runningPlugins.get(plugin) ?? 0) > 0 || runningUnknown > 0

/** Lista viva de comandos: la guarda para `ui.open` y la manda a la ventana. */
async function publishCommands($: EngineInterface, ctx: Context, host: Host): Promise<void> {
  const list = await $.command.list()
  commandPlugins = new Map(list.map((item) => [item.name, item.plugin ?? null]))
  const items: CommandItem[] = list.map((item) => ({
    name: item.name,
    description: item.description,
    source: item.source,
    ...(item.plugin === undefined ? {} : { plugin: item.plugin }),
  }))
  emit(ctx, host, { type: 'commands', items })
}

function noteMode(ctx: Context, host: Host, mode: unknown): void {
  if (!isPermissionMode(mode)) return
  if (mode !== 'plan') lastNonPlanMode = mode
  if (mode === lastMode) return
  lastMode = mode
  emit(ctx, host, { type: 'mode', mode })
}

/** `hello` v2; si se acepta, `ready`, buzón de esa generación y lista viva. */
async function announce($: EngineInterface, ctx: Context, host: Host, payload: HelloPayload): Promise<void> {
  lastHelloSid = payload.claudeSessionId
  const hello = await ctx.bridge.hello(host, payload)
  if (hello === null) return
  if (lastNonPlanMode === null && hello.launchPermissionMode !== null && hello.launchPermissionMode !== 'plan') {
    lastNonPlanMode = hello.launchPermissionMode
  }
  emit(ctx, host, { type: 'ready' })
  if (hello.protocol >= 2) ctx.inbox.start(host, hello.generation, depsOf($, ctx, host))
  await publishCommands($, ctx, host).catch((error: unknown) => notice(ctx, host, `No se pudo leer la lista de comandos: ${errorText(error)}`))
}

function scheduleHello($: EngineInterface, ctx: Context, host: Host, payload: HelloPayload): void {
  host.after(0, () => void announce($, ctx, host, payload))
}

/** `command.run` lanzado por el buzón: el propio mod emite su inicio y su fin. */
async function runCommand($: EngineInterface, ctx: Context, host: Host, op: Extract<InboxOp, { op: 'command.run' }>): Promise<OpOutcome> {
  const runId = newRunId()
  emit(ctx, host, { type: 'commandStart', runId, command: op.command, args: op.args, origin: `plugin:${PLUGIN}` })
  try {
    const result = await $.command.run({ command: op.command, args: op.args })
    const text = result.text === undefined ? undefined : clip(result.text, MAX_COMMAND_TEXT)
    emit(ctx, host, { type: 'commandEnd', runId, command: op.command, ...(text === undefined ? {} : { text }), intercepted: false })
    if (RELOADS.has(op.command)) host.after(0, () => void publishCommands($, ctx, host).catch(() => undefined))
    if (op.command === 'model') await refreshModel($, ctx, host)
    return text === undefined ? { ok: true, value: { text: null } } : { ok: true, value: { text }, text }
  } catch (error) {
    emit(ctx, host, { type: 'commandEnd', runId, command: op.command, text: errorText(error), intercepted: false })
    return { ok: false, error: errorText(error) }
  }
}

/**
 * Tras `/model`: `mainModel` venía del último `turn.step` y el `status` solo sale
 * en `session.measure`, así que Sessions seguía mostrando el modelo viejo hasta
 * el turno siguiente. Se relee el modelo y se reemite el último `status`.
 */
async function refreshModel($: EngineInterface, ctx: Context, host: Host): Promise<void> {
  const model = await $.session.model().catch(() => null)
  if (model === null || model === mainModel) return
  mainModel = model
  if (lastStatus !== null) {
    lastStatus = { ...lastStatus, model }
    emit(ctx, host, lastStatus)
  }
}

async function clearPrompt($: EngineInterface): Promise<OpOutcome> {
  const filled = await $.prompt.fill({ text: '', mode: 'replace' })
  return filled.isFilled ? { ok: true, value: filled } : { ok: false, error: `No se pudo limpiar la entrada (${filled.refusal ?? 'rechazado'})` }
}

/** Ejecuta una operación del buzón (§6.4); el buzón garantiza que como mucho una vez. */
async function execute($: EngineInterface, ctx: Context, host: Host, op: InboxOp): Promise<OpOutcome> {
  switch (op.op) {
    case 'command.run':
      return runCommand($, ctx, host, op)
    case 'command.list':
      return { ok: true, value: await $.command.list() }
    case 'config.list':
      return { ok: true, value: await $.config.list() }
    case 'config.set':
      return { ok: true, value: await $.config.set({ key: op.key, value: op.value }) }
    case 'turn.abort': {
      const turnId = op.turnId === '' ? mainTurnId : op.turnId
      if (turnId === null) return { ok: false, error: 'No hay ningún turno en curso que interrumpir' }
      await $.turn.abort({ turnId })
      return { ok: true }
    }
    case 'session.usage':
      return { ok: true, value: await $.session.usage(op.breakdown === undefined ? undefined : { breakdown: op.breakdown }) }
    case 'prompt.read':
      return { ok: true, value: await $.prompt.read() }
    case 'prompt.clear':
      return clearPrompt($)
    case 'setIntercept':
      return { ok: false, error: INTERCEPT_RETIRED }
  }
}

function askContext(host: Host, next: { signal: AbortSignal; budget: { remainingMs: number } }): AskContext {
  return { host, signal: next.signal, remainingMs: () => next.budget.remainingMs }
}

function reportFailure(ctx: Context, host: Host, outcome: AskOutcome, what: string): void {
  if (isFailure(outcome)) notice(ctx, host, `${what}: no se pudo preguntar desde ULTRON Sessions; se ha denegado`)
}

async function readPlan($: EngineInterface, e: ToolCallInput): Promise<string> {
  const inline = (e as { plan?: unknown }).plan
  if (typeof inline === 'string' && inline.trim() !== '') return inline
  const filePath = planFiles.get(e.agentId ?? MAIN)
  if (filePath === undefined) return PLAN_UNREADABLE
  const plan = await $.fs.read(filePath).catch(() => '')
  return plan.trim() === '' ? PLAN_UNREADABLE : plan
}

type PersonNext = { signal: AbortSignal; budget: { remainingMs: number } }

/** `AskUserQuestion` respondida en la ventana, o `deny` con el motivo. */
async function answerQuestion(ctx: Context, host: Host, e: ToolCallInput, next: PersonNext): Promise<ToolCallResult> {
  const raw = (e as { questions?: unknown }).questions
  const questions = toAskQuestions(raw)
  if (questions === null) {
    notice(ctx, host, DENY_FORMAT)
    return { deny: DENY_FORMAT }
  }
  const outcome = await ctx.asker.ask(askContext(host, next), { kind: 'question', questions })
  reportFailure(ctx, host, outcome, 'Pregunta')
  const result = questionResult(questions, raw, outcome)
  return 'deny' in result ? { deny: result.deny } : { result: { questions: raw, answers: result.answers } as never }
}

/**
 * `ExitPlanMode` decidido en la ventana. Rechazo: `deny` con los cambios
 * pedidos. Aprobación: se anota y la herramienta real sigue (`null`);
 * `classic.PermissionRequest` la aprueba sin diálogo con el modo elegido.
 */
async function answerPlan($: EngineInterface, ctx: Context, host: Host, e: ToolCallInput, next: PersonNext): Promise<ToolCallResult | null> {
  const plan = await readPlan($, e)
  const outcome = await ctx.asker.ask(askContext(host, next), { kind: 'plan', plan })
  reportFailure(ctx, host, outcome, 'Plan')
  const decision = planDecision(outcome)
  if ('deny' in decision) return { deny: decision.deny }
  approvedPlan = { isAgent: e.agentId !== undefined, mode: decision.approved.mode }
  return null
}

async function onToolCall($: EngineInterface, ctx: Context, e: ToolCallInput, next: PersonNext & ((e: ToolCallInput) => Promise<ToolCallResult>)): Promise<ToolCallResult> {
  const host = hostOf($)
  const name = String(e.tool)
  const timeoutMs = timeoutOf(e)
  const row = { toolUseId: e.tool_use_id ?? '', ...loopOf(e.agentId), name, summary: summarizeTool(name, e) }
  emit(ctx, host, { type: 'tool', ...row, phase: 'start', ...(timeoutMs === undefined ? {} : { timeoutMs }) })
  try {
    let answered: ToolCallResult | null = null
    if (name === 'AskUserQuestion') answered = await answerQuestion(ctx, host, e, next)
    else if (name === 'ExitPlanMode') answered = await answerPlan($, ctx, host, e, next)
    const result = answered ?? (await next(e))
    const isError = result.isError === true || result.deny !== undefined
    emit(ctx, host, { type: 'tool', ...row, phase: 'end', ...(isError ? { isError } : {}) })
    return result
  } finally {
    // La aprobación solo vale para esta llamada a ExitPlanMode.
    if (name === 'ExitPlanMode') approvedPlan = null
  }
}

const usageOf = (usage: unknown): TurnUsage | undefined =>
  typeof usage === 'object' && usage !== null ? ({ ...(usage as TurnUsage) }) : undefined

/** Arranque, cambio de conversación y fin: hello y buzón. */
function onSession(on: On): void {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    resetSession()
    const ctx = await contextOf($)
    if (ctx === null) return started
    const [claudeSessionId, model] = await Promise.all([$.session.id(), $.session.model()])
    mainModel = model
    scheduleHello($, ctx, hostOf($), { claudeSessionId, cwd: e.cwd, model, source: 'start' })
    return started
  }).catch(($, e, next) => next(e))

  on('classic.SessionStart', async ($, e, next) => {
    const ctx = await contextOf($)
    if (ctx !== null && HELLO_SOURCES.has(e.source)) {
      const model = mainModel ?? (await $.session.model())
      const payload: HelloPayload = { claudeSessionId: e.session_id, cwd: e.cwd, model, source: e.source as HelloSource }
      scheduleHello($, ctx, hostOf($), e.transcript_path === '' ? payload : { ...payload, transcriptPath: e.transcript_path })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (current !== null && !KEEP_INBOX.has(e.reason)) current.inbox.stop()
    return next(e)
  }).catch(($, e, next) => next(e))
}

/** Límites del turno: turnStart, turnEnd con duración y usage, agentEnd. */
function onTurns(on: On): void {
  on('turn.start', async ($, e, next) => {
    const ctx = await contextOf($)
    if (ctx === null) return next(e)
    const host = hostOf($)
    mainTurnId = e.turnId
    emit(ctx, host, { type: 'turnStart', turnId: e.turnId, ...(e.text === '' ? {} : { text: clip(e.text, MAX_PROMPT_TEXT) }) })
    const sid = await $.session.id()
    if (lastHelloSid !== null && sid !== lastHelloSid) {
      const model = mainModel ?? (await $.session.model())
      scheduleHello($, ctx, host, { claudeSessionId: sid, cwd: await $.session.cwd(), model, source: 'turn' })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const ctx = await contextOf($)
    if (ctx === null) return yield* next(e)
    const host = hostOf($)
    const loop = loopOf(e.agentId)
    if (e.agentId === undefined) mainModel = e.model
    else {
      rememberAgentModel(e.agentId, e.model)
      if (e.index === 0) emit(ctx, host, { type: 'turnStart', turnId: e.turnId, ...loop })
    }
    let stopReason: string | null = null
    let usage: TurnUsage | null = null
    try {
      const stream = next(e)
      for await (const chunk of stream) {
        if (chunk.kind === 'text' || chunk.kind === 'thinking') {
          emit(ctx, host, { type: chunk.kind, turnId: e.turnId, ...loop, step: e.index, block: chunk.index, delta: chunk.text })
        } else if (chunk.kind === 'stop') {
          stopReason = chunk.stopReason
          usage = usageOf(chunk.usage) ?? null
        }
        yield chunk
      }
      return await stream.result
    } finally {
      emit(ctx, host, { type: 'stepEnd', turnId: e.turnId, ...loop, step: e.index, stopReason, usage })
    }
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })
}

/** Guarda el modelo de un subagente; el mapa no crece sin límite. */
function rememberAgentModel(agentId: string, model: string | undefined): void {
  if (!model) return
  agentModels.delete(agentId)
  agentModels.set(agentId, model)
  if (agentModels.size > MAX_AGENT_MODELS) agentModels.delete(agentModels.keys().next().value as string)
}

/** Modelo del subagente que cierra su turno, y se olvida: no vuelve a hacer falta. */
function takeAgentModel(agentId: string | undefined): string | undefined {
  if (agentId === undefined) return undefined
  const model = agentModels.get(agentId)
  agentModels.delete(agentId)
  return model
}

function onTurnEnd(on: On): void {
  on('turn.complete', async ($, e, next) => {
    const ctx = await contextOf($)
    if (ctx !== null) {
      const host = hostOf($)
      const usage = usageOf(e.usage)
      const model = takeAgentModel(e.agentId)
      emit(ctx, host, {
        type: 'turnEnd',
        turnId: e.turnId,
        ...loopOf(e.agentId),
        reason: e.reason,
        isAborted: e.isAborted,
        durationMs: e.durationMs,
        ...(usage === undefined ? {} : { usage }),
        ...(model === undefined ? {} : { model }),
      })
      if (e.agentId !== undefined) emit(ctx, host, { type: 'agentEnd', agentId: e.agentId, isError: e.reason === 'error' })
      else if (mainTurnId === e.turnId) mainTurnId = null
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}

/** Prompts y comandos: prompt, commandStart/commandEnd y lista viva. */
function onPrompts(on: On): void {
  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    const ctx = await contextOf($)
    if (ctx === null || 'drop' in entered) return entered
    const text = clip(typeof entered.text === 'string' ? entered.text : e.text, MAX_PROMPT_TEXT)
    emit(ctx, hostOf($), { type: 'prompt', ...(e.turnId === undefined ? {} : { turnId: e.turnId }), text, origin: originText(e.origin), wait: e.wait })
    return entered
  }).catch(($, e, next) => next(e))

  on('command.run', async ($, e, next) => {
    const ctx = await contextOf($)
    if (ctx === null) return next(e)
    const host = hostOf($)
    const runId = newRunId()
    emit(ctx, host, { type: 'commandStart', runId, command: e.command, args: e.args, origin: originText(e.origin) })
    markRunning(e.command, 1)
    let text: string | undefined
    try {
      const result = await next(e)
      text = result.text === undefined ? undefined : clip(result.text, MAX_COMMAND_TEXT)
      if (RELOADS.has(e.command)) host.after(0, () => void publishCommands($, ctx, host).catch(() => undefined))
      return result
    } catch (error) {
      text = errorText(error)
      throw error
    } finally {
      markRunning(e.command, -1)
      emit(ctx, host, { type: 'commandEnd', runId, command: e.command, ...(text === undefined ? {} : { text }), intercepted: false })
    }
  }).catch(($, e, next) => next(e))
}

/** Cajas y paneles de otros mods: al composer de ULTRON y sin foco (§6.5). */
function onOtherMods(on: On): void {
  on('prompt.fill', async ($, e, next) => {
    if (e.origin.kind !== 'plugin') return next(e)
    const ctx = await contextOf($)
    if (ctx === null) return next(e)
    emit(ctx, hostOf($), { type: 'composerFill', text: e.text, mode: e.mode, from: e.origin.name })
    return { isFilled: true }
  }).catch(($, e, next) => next(e))

  on('ui.open', async ($, e, next) => {
    const opener = next.origin.plugin
    if (opener === 'engine' || opener === PLUGIN) return next(e)
    const ctx = await contextOf($)
    if (ctx === null) return next(e)
    if (!isPluginRunning(opener)) return { deny: DENY_AUTO_PANEL }
    const { focus: _focus, ...unfocused } = e
    return next(unfocused)
  }).catch(($, e, next) => next(e))
}

/** Una copia del aviso de otro mod a la ventana; el motor lo recibe igual. */
async function forwardNotice($: EngineInterface, kind: AvisoKind, plugin: string, text: string): Promise<void> {
  if (plugin === 'engine' || plugin === PLUGIN || text.trim() === '') return
  const ctx = await contextOf($)
  if (ctx === null || !avisos.shouldForward(kind, plugin, text, await $.clock.now())) return
  emit(ctx, hostOf($), { type: 'notice', level: 'info', text: noticeText(kind, plugin, text) })
}

/** Avisos de otros mods: con la TUI oculta no los vería nadie (ver `avisos.ts`). */
function onNotices(on: On): void {
  on('ui.toast', async ($, e, next) => {
    await forwardNotice($, 'toast', next.origin.plugin, e.text)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.log', async ($, e, next) => {
    if (e.to !== 'debug') await forwardNotice($, 'log', next.origin.plugin, e.text)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.status', async ($, e, next) => {
    if (e.text !== undefined) await forwardNotice($, 'status', next.origin.plugin, e.text)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.suggest', async ($, e, next) => {
    // La caja oculta no enseña la sugerencia; la del motor tras un turno no es un aviso.
    if (e.origin.kind === 'plugin') await forwardNotice($, 'suggest', e.origin.name, e.text)
    return next(e)
  }).catch(($, e, next) => next(e))
}

/** Subagentes, estado de la sesión y fichero del plan. */
function onAgents(on: On): void {
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    const ctx = await contextOf($)
    if (ctx === null || spawned.agentId === undefined) return spawned
    emit(ctx, hostOf($), {
      type: 'agentSpawn',
      agentId: spawned.agentId,
      ...(e.parentAgentId === undefined ? {} : { parentAgentId: e.parentAgentId }),
      agentType: e.subagentType,
      description: e.description,
    })
    return spawned
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    const ctx = await contextOf($)
    if (ctx !== null) {
      const model = mainModel ?? (await $.session.model())
      lastStatus = {
        type: 'status',
        model,
        contextTokens: e.context.tokens ?? 0,
        contextWindow: e.context.window,
        ...(e.cost === undefined ? {} : { costUsd: e.cost.usd }),
        ...(lastMode === null ? {} : { mode: lastMode }),
      }
      emit(ctx, hostOf($), lastStatus)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.attachment', async ($, e, next) => {
    if ((e.type === 'plan_mode' || e.type === 'plan_mode_reentry') && e.detail !== undefined) {
      planFiles.set(e.agentId ?? MAIN, e.detail.planFilePath)
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}

/** Herramientas: eventos tool y preguntas, planes y permisos por la ventana. */
function onTools(on: On): void {
  on('tool.call', async ($, e, next) => {
    const ctx = await contextOf($)
    if (ctx === null || e.tool_use_id === undefined) return next(e)
    return onToolCall($, ctx, e, next)
  }).catch(($, e, next) => (isBridged() && PERSON_TOOLS.has(String(e.tool)) ? { deny: DENY_UNREACHABLE } : next(e)))

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision !== 'ask' || e.tool_use_id === undefined || PERSON_TOOLS.has(e.tool)) return verdict
    const ctx = await contextOf($)
    if (ctx === null) return verdict
    const host = hostOf($)
    const outcome = await ctx.asker.ask(askContext(host, next), {
      kind: 'permission',
      tool: e.tool,
      input: e.input,
      summary: permissionSummary(e.tool, e.input),
      ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
      agentId: e.agentId ?? null,
    })
    reportFailure(ctx, host, outcome, `Permiso ${e.tool}`)
    return verdictFor(outcome)
  }).catch(async ($, e, next) => {
    const verdict = await next(e)
    const wouldAsk = verdict.decision === 'ask' && e.tool_use_id !== undefined && !PERSON_TOOLS.has(e.tool)
    return isBridged() && wouldAsk ? { decision: 'deny' as const, reason: DENY_UNREACHABLE } : verdict
  })
}

/** Hooks clásicos: modo de permisos y salida del plan con el modo elegido. */
function onClassic(on: On): void {
  on('classic.PermissionRequest', async ($, e, next) => {
    if (e.tool_name !== 'ExitPlanMode' || approvedPlan === null) return next(e)
    const mode = approvedPlan.isAgent ? null : planExitMode(approvedPlan.mode, lastNonPlanMode)
    approvedPlan = null
    const updatedPermissions = mode === null ? [] : [{ type: 'setMode' as const, mode, destination: 'session' as const }]
    return { decision: { behavior: 'allow' as const, updatedPermissions } }
  }).catch(($, e, next) => next(e))

  on('classic.*', async ($, e, next) => {
    const ctx = await contextOf($)
    if (ctx !== null) noteMode(ctx, hostOf($), (e as { permission_mode?: unknown }).permission_mode)
    return next(e)
  }).catch(($, e, next) => next(e))
}

export const register: Register = (on) => {
  onSession(on)
  onTurns(on)
  onTurnEnd(on)
  onPrompts(on)
  onOtherMods(on)
  onNotices(on)
  onAgents(on)
  onTools(on)
  onClassic(on)
}
