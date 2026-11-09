import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { UsoSnapshot, UsoWindow } from '../types'
import { limitLine, newAlerts, usageLine, windowLabel } from './format'
import { usoView } from './view'

const PANE = 'uso'

const snapshotAtom = atom({ plugin: 'ultron-uso', key: 'snapshot' } as const, null)
const errorAtom = atom({ plugin: 'ultron-uso', key: 'error' } as const, null)
const alertsAtom = atom({ plugin: 'ultron-uso', key: 'alerts' } as const, [])

const set = <T,>(value: T) => () => value

const autoOpenedAtom = atom({ plugin: 'ultron-uso', key: 'hasAutoOpened' } as const, false)

/** Abre el panel sin que se pida, una vez por sesión y solo en pantalla completa (acoplado, sin foco). */
async function autoOpen($: EngineInterface): Promise<void> {
  // Dentro de ULTRON Sessions la ventana tiene su propia interfaz: sin panel automático.
  if (await $.env.get('ULTRON_SESION_ID')) return
  if (await read($, autoOpenedAtom)) return
  await update($, autoOpenedAtom, set(true))
  await $.ui.open({ id: PANE, title: 'Uso del plan', closeOnEscape: true, rows: 14 })
}

/** Pide a bin/uso.cjs el ritmo de las ventanas que da la API y guarda la foto. */
async function refresh($: EngineInterface): Promise<void> {
  const { rateLimits } = await $.session.usage()
  if (rateLimits.length === 0) {
    await update($, errorAtom, set<string | null>(null))
    return
  }
  const script = `${$.plugin.root}/bin/uso.cjs`
  const run = await $.process.run(['node', script], { stdin: JSON.stringify({ rateLimits }), timeoutMs: 15_000 })
  if (run.exitCode !== 0) {
    const reason = (run.stderr || run.stdout).trim().split('\n')[0] ?? ''
    await update($, errorAtom, set<string | null>(`No se pudo calcular el ritmo: ${reason.slice(0, 200)}`))
    return
  }
  const parsed = JSON.parse(run.stdout) as Omit<UsoSnapshot, 'takenAt'>
  const snapshot: UsoSnapshot = { ...parsed, takenAt: await $.clock.now() }
  await update($, snapshotAtom, set<UsoSnapshot | null>(snapshot))
  await update($, errorAtom, set<string | null>(null))
  await warnOnce($, snapshot.windows)
}

/** Un toast por ventana la primera vez que entra en alerta en la sesión. */
async function warnOnce($: EngineInterface, windows: readonly UsoWindow[]): Promise<void> {
  const fresh = newAlerts(windows, await read($, alertsAtom))
  if (fresh.length === 0) return
  await update($, alertsAtom, (seen) => [...seen, ...fresh])
  for (const w of windows.filter((one) => fresh.includes(one.kind))) {
    $.ui.toast(`Uso ${windowLabel(w.kind)}: ${usageLine(w)} · ${limitLine(w)}. /uso para el detalle.`)
  }
}

async function safeRefresh($: EngineInterface): Promise<void> {
  try {
    await refresh($)
  } catch (err) {
    await update($, errorAtom, set<string | null>(`No se pudo calcular el ritmo: ${String(err).slice(0, 200)}`))
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'uso',
      description: 'Cuota del plan: uso y tiempo de las ventanas de 5 h y semanal, y hora estimada del límite',
      immediate: true,
    })
    $.clock.after(0, () => void safeRefresh($))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('rateLimits')) $.clock.after(0, () => void safeRefresh($))
    return result
  })

  on('command.run', { command: 'uso' }, async ($) => {
    await safeRefresh($)
    const opened = await $.ui.open({ id: PANE, title: 'Uso del plan', focus: true, closeOnEscape: true, rows: 14 })
    return opened.isPlaced ? {} : { text: `No se pudo abrir el panel: ${opened.reason}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.viewport?.isFullscreen === true) $.clock.after(0, () => void autoOpen($))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface === 'mobile') return next(e)
    return usoView(
      $.ui.resolve(e),
      { snapshot: await read($, snapshotAtom), error: await read($, errorAtom) },
      () => void safeRefresh($),
    )
  })
}
