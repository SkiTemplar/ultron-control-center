import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CtxConversation, CtxSnapshot, CtxTab } from '../types'
import { messageTokensOf, toConversation, toSnapshot } from './analysis'
import { type Actions, contextView } from './view'

const PANE = 'contexto'

const snapshotAtom = atom({ plugin: 'ultron-contexto', key: 'snapshot' } as const, null)
const conversationAtom = atom({ plugin: 'ultron-contexto', key: 'conversation' } as const, null)
const tabAtom = atom({ plugin: 'ultron-contexto', key: 'tab' } as const, 'resumen')
const loadingAtom = atom({ plugin: 'ultron-contexto', key: 'isLoading' } as const, false)
const errorAtom = atom({ plugin: 'ultron-contexto', key: 'error' } as const, null)
const autoOpenedAtom = atom({ plugin: 'ultron-contexto', key: 'hasAutoOpened' } as const, false)

const set = <T,>(value: T) => () => value

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

async function measure($: EngineInterface, detail: 'summary' | 'full'): Promise<void> {
  await update($, loadingAtom, set(true))
  try {
    const usage = await $.session.usage({ breakdown: detail })
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    const snapshot = toSnapshot(usage, detail, await $.clock.now(), home)
    if (!snapshot) throw new Error('El motor no ha devuelto desglose: la sesión aún no tiene respuesta.')
    const conversation = toConversation(await $.session.messages(), messageTokensOf(snapshot))
    await update($, snapshotAtom, set<CtxSnapshot | null>(snapshot))
    await update($, conversationAtom, set<CtxConversation | null>(conversation))
    await update($, errorAtom, set<string | null>(null))
  } catch (err) {
    await update($, errorAtom, set<string | null>(message(err)))
  } finally {
    await update($, loadingAtom, set(false))
  }
}

async function isOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some((pane) => pane.id === PANE)
}

async function compact($: EngineInterface): Promise<void> {
  const filled = await $.prompt.fill({ text: '/compact ', mode: 'replace' })
  if (!filled.isFilled) {
    $.ui.toast(`No pude escribir en el prompt${filled.refusal ? ` (${filled.refusal})` : ''}`)
    return
  }
  await $.ui.close({ id: PANE })
}

/**
 * Abre el panel sin que se pida, una vez por sesión y solo en pantalla completa
 * (acoplado a la derecha). No mide: antes de la primera respuesta no hay desglose;
 * `turn.complete` lo rellena en cuanto termina el primer turno.
 */
async function autoOpen($: EngineInterface): Promise<void> {
  // Dentro de ULTRON Sessions la ventana tiene su propia interfaz: sin panel automático.
  if (await $.env.get('ULTRON_SESION_ID')) return
  if (await read($, autoOpenedAtom)) return
  await update($, autoOpenedAtom, set(true))
  await $.ui.open({ id: PANE, title: 'Contexto', closeOnEscape: true, rows: 26 })
}

function actionsFor($: EngineInterface): Actions {
  return {
    tab: (tab: CtxTab) => void update($, tabAtom, set(tab)),
    refresh: () => void measure($, 'summary'),
    exact: () => void measure($, 'full'),
    compact: () => void compact($),
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'contexto',
      description: 'En qué se va la ventana de contexto (con «exacto», cuenta con la API)',
      argumentHint: '[exacto]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'contexto' }, async ($, e) => {
    const detail = /exact/i.test(e.args) ? 'full' : 'summary'
    const opened = await $.ui.open({ id: PANE, title: 'Contexto', focus: true, closeOnEscape: true, rows: 26 })
    if (!opened.isPlaced) return { text: `No se pudo abrir el panel: ${opened.reason}` }
    $.clock.after(0, () => void measure($, detail))
    return {}
  })

  // Tras cada turno del hilo principal, la medida del panel abierto se queda vieja.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && (await isOpen($))) {
      $.clock.after(0, () => void measure($, 'summary'))
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.viewport?.isFullscreen === true) $.clock.after(0, () => void autoOpen($))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface === 'mobile') return next(e)
    return contextView(
      $.ui.resolve(e),
      {
        snapshot: await read($, snapshotAtom),
        conversation: await read($, conversationAtom),
        tab: await read($, tabAtom),
        isLoading: await read($, loadingAtom),
        error: await read($, errorAtom),
        width: e.props.bodyColumns,
      },
      actionsFor($),
    )
  })
}
