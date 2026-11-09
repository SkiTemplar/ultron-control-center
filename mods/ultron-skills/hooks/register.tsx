import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PendingSkillCall, SkillHit } from '../types'
import {
  type Activation,
  UNKNOWN_LOOP_ORIGIN,
  approxTokens,
  originOf,
  pendingFor,
  statusText,
  withActivation,
  withPending,
  withTurnSkill,
  withoutPending,
} from './skills'
import { skillsView } from './view'

const PANE = 'skills'
const TICK_MS = 30_000
/** Con este argumento, `/skills` sigue al listado de skills del propio Claude Code. */
const BUILTIN_ARGS = /^\s*(todas|lista)\b/i

const hitsAtom = atom({ plugin: 'ultron-skills', key: 'hits' } as const, [])
const turnSkillsAtom = atom({ plugin: 'ultron-skills', key: 'turnSkills' } as const, [])
const turnOverAtom = atom({ plugin: 'ultron-skills', key: 'isTurnOver' } as const, true)
const startedAtom = atom({ plugin: 'ultron-skills', key: 'sessionStartedAt' } as const, 0)
const pendingAtom = atom({ plugin: 'ultron-skills', key: 'pendingSkillCalls' } as const, [])
const errorAtom = atom({ plugin: 'ultron-skills', key: 'error' } as const, null)
const nowAtom = atom({ plugin: 'ultron-skills', key: 'now' } as const, 0)

const set = <T,>(value: T) => () => value

const autoOpenedAtom = atom({ plugin: 'ultron-skills', key: 'hasAutoOpened' } as const, false)

/** Abre el panel sin que se pida, una vez por sesión y solo en pantalla completa (acoplado, sin foco). */
async function autoOpen($: EngineInterface): Promise<void> {
  // Dentro de ULTRON Sessions la ventana tiene su propia interfaz: sin panel automático.
  if (await $.env.get('ULTRON_SESION_ID')) return
  if (await read($, autoOpenedAtom)) return
  await update($, autoOpenedAtom, set(true))
  await $.ui.open({ id: PANE, title: 'Skills', closeOnEscape: true, rows: 18 })
}
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Arranque de la sesión (o del módulo, si se recargó a mitad). */
async function markStart($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, startedAtom, set(now))
  await update($, nowAtom, set(now))
}

/** Si el turno anterior ya terminó, empieza uno nuevo: sin skills y sin status line. */
async function beginTurnIfOver($: EngineInterface): Promise<void> {
  if (!(await read($, turnOverAtom))) return
  await update($, turnOverAtom, set(false))
  await update($, turnSkillsAtom, set<string[]>([]))
  $.ui.status(undefined)
}

/**
 * Apunta una activación. No abre turno: eso lo hacen `prompt.submit` y `turn.start` del
 * hilo principal, para que un subagente en segundo plano no vacíe la lista del turno.
 */
async function record($: EngineInterface, act: Activation): Promise<void> {
  await update($, hitsAtom, (hits) => withActivation(hits, act))
  const names = await update($, turnSkillsAtom, (list) => withTurnSkill(list, act.name))
  await update($, nowAtom, set(act.at))
  $.ui.status(statusText(names))
}

/** Origen de un `skill.prompt`: el loop de la llamada a la tool Skill que lo provocó, si la hay. */
async function originFor($: EngineInterface, skill: string): Promise<string> {
  const call = pendingFor(await read($, pendingAtom), skill)
  return call === undefined ? UNKNOWN_LOOP_ORIGIN : originOf(call.agentId)
}

async function isOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some((pane) => pane.id === PANE)
}

/** Con el panel abierto, el «hace cuánto» avanza aunque no se active nada. */
async function tick($: EngineInterface): Promise<void> {
  if (await isOpen($)) await update($, nowAtom, set(await $.clock.now()))
}

async function clearAll($: EngineInterface): Promise<void> {
  await update($, hitsAtom, set<SkillHit[]>([]))
  await update($, turnSkillsAtom, set<string[]>([]))
  $.ui.status(undefined)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await markStart($)
    $.clock.every(TICK_MS, () => void tick($))
    return next(e)
  })

  // `/skills` es nombre de un comando del motor (registrarlo se rechaza): se intercepta su
  // ejecución. `/skills todas` deja pasar el listado original de skills disponibles.
  on('command.run', { command: 'skills' }, async ($, e, next) => {
    if (BUILTIN_ARGS.test(e.args)) return next({ ...e, args: '' })
    await update($, nowAtom, set(await $.clock.now()))
    const opened = await $.ui.open({ id: PANE, title: 'Skills', focus: true, closeOnEscape: true, rows: 18 })
    return opened.isPlaced ? {} : { text: `No se pudo abrir el panel: ${opened.reason}` }
  })

  // `skill.prompt` no dice en qué loop se expande; la tool Skill sí (`agentId`). Mientras la
  // llamada corre, su loop queda apuntado para el `skill.prompt` que provoca dentro de `next`.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const raw = e as unknown as { skill?: unknown }
    const call: PendingSkillCall = { toolUseId: e.tool_use_id, skill: String(raw.skill ?? ''), agentId: e.agentId ?? null }
    await update($, pendingAtom, (pending) => withPending(pending, call))
    try {
      return await next(e)
    } finally {
      await update($, pendingAtom, (pending) => withoutPending(pending, call.toolUseId))
    }
  })

  on('skill.prompt', async ($, e, next) => {
    const result = await next(e)
    try {
      await record($, { name: e.skill, origin: await originFor($, e.skill), tokens: approxTokens(result.text), at: await $.clock.now() })
    } catch (err) {
      await update($, errorAtom, set<string | null>(`skill ${e.skill}: ${message(err)}`))
    }
    return result
  })

  // El dispatcher de skills está desconectado desde el 2026-09-29: su log
  // (logs/routing-dispatcher.jsonl) solo lo escriben los arneses y los
  // benchmarks, así que el panel no lo lee ni atribuye nada a él.
  on('prompt.submit', async ($, e, next) => {
    if ((await read($, startedAtom)) === 0) await markStart($)
    await beginTurnIfOver($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if ((e as typeof e & { agentId?: unknown }).agentId === undefined) await beginTurnIfOver($)
    return next(e)
  })

  // La status line del turno se queda hasta que empiece el siguiente.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await update($, turnOverAtom, set(true))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.viewport?.isFullscreen === true) $.clock.after(0, () => void autoOpen($))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface === 'mobile') return next(e)
    return skillsView(
      $.ui.resolve(e),
      {
        hits: await read($, hitsAtom),
        error: await read($, errorAtom),
        now: await read($, nowAtom),
      },
      { clear: () => void clearAll($) },
    )
  })
}
