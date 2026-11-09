import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GitDiff, GitSnapshot, GitTab, GitView } from '../types'
import { diffBody, mergeFiles, normPath, parseNumstat, parseStatus, turnChanges } from './git'
import { gitView, summaryLine } from './view'

const PANE = 'git'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const GIT_TIMEOUT_MS = 15_000
const INITIAL_VIEW: GitView = { tab: 'turno', selected: null, offset: 0 }

const snapshotAtom = atom({ plugin: 'ultron-git', key: 'snapshot' } as const, null)
const errorAtom = atom({ plugin: 'ultron-git', key: 'error' } as const, null)
const turnFilesAtom = atom({ plugin: 'ultron-git', key: 'turnFiles' } as const, [])
const viewAtom = atom({ plugin: 'ultron-git', key: 'view' } as const, { tab: 'turno', selected: null, offset: 0 })
const diffAtom = atom({ plugin: 'ultron-git', key: 'diff' } as const, null)
const bandHiddenAtom = atom({ plugin: 'ultron-git', key: 'isBandHidden' } as const, false)

const set = <T,>(value: T) => () => value

const autoOpenedAtom = atom({ plugin: 'ultron-git', key: 'hasAutoOpened' } as const, false)

/** Abre el panel sin que se pida, una vez por sesión y solo en pantalla completa (acoplado, sin foco). */
async function autoOpen($: EngineInterface): Promise<void> {
  // Dentro de ULTRON Sessions la ventana tiene su propia interfaz: sin panel automático.
  if (await $.env.get('ULTRON_SESION_ID')) return
  if (await read($, autoOpenedAtom)) return
  await update($, autoOpenedAtom, set(true))
  await $.ui.open({ id: PANE, title: 'Git', closeOnEscape: true, rows: 20 })
}

/** Ejecuta git en el cwd de la sesión; lanza con el stderr real si falla. */
async function git($: EngineInterface, args: string[], okCodes: number[] = [0]): Promise<string> {
  const run = await $.process.run(['git', ...args], { cwd: await $.session.cwd(), timeoutMs: GIT_TIMEOUT_MS })
  if (!okCodes.includes(run.exitCode)) throw new Error((run.stderr || run.stdout).trim().split('\n')[0] || `git ${args[0]} salió con ${run.exitCode}`)
  return run.stdout
}

async function loadSnapshot($: EngineInterface): Promise<GitSnapshot> {
  const root = (await git($, ['rev-parse', '--show-toplevel'])).trim()
  const status = parseStatus(await git($, ['status', '--porcelain=v1', '-b', '--untracked-files=all']))
  // En un repo sin commits no hay HEAD: se cuentan solo los cambios preparados.
  const numstat = await git($, ['diff', '--numstat', 'HEAD']).catch(() => git($, ['diff', '--numstat', '--cached']))
  return { root, branch: status.branch, ahead: status.ahead, behind: status.behind, files: mergeFiles(status.files, parseNumstat(numstat)) }
}

async function refresh($: EngineInterface): Promise<void> {
  try {
    await update($, snapshotAtom, set<GitSnapshot | null>(await loadSnapshot($)))
    await update($, errorAtom, set<string | null>(null))
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await update($, errorAtom, set<string | null>(`git no responde aquí: ${reason.slice(0, 200)}`))
  }
}

/** Diff de un fichero frente a HEAD; los no seguidos, contra el fichero vacío. */
async function loadDiff($: EngineInterface, path: string): Promise<GitDiff> {
  const snapshot = await read($, snapshotAtom)
  const file = snapshot?.files.find((f) => f.path === path)
  if (file?.code === '??') {
    const devNull = /^[a-z]:\//i.test(snapshot?.root ?? '') ? 'NUL' : '/dev/null'
    return { path, lines: diffBody(await git($, ['diff', '--no-index', '--', devNull, path], [0, 1])) }
  }
  const text = await git($, ['diff', 'HEAD', '--', path]).catch(() => git($, ['diff', '--cached', '--', path]))
  return { path, lines: diffBody(text) }
}

async function select($: EngineInterface, path: string): Promise<void> {
  try {
    await update($, diffAtom, set<GitDiff | null>(await loadDiff($, path)))
    await update($, viewAtom, (v) => ({ ...v, selected: path, offset: 0 }))
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await update($, errorAtom, set<string | null>(`No se pudo sacar el diff de ${path}: ${reason.slice(0, 200)}`))
  }
}

async function openPane($: EngineInterface, tab: GitTab): Promise<string | null> {
  await update($, viewAtom, set<GitView>({ ...INITIAL_VIEW, tab }))
  await update($, diffAtom, set<GitDiff | null>(null))
  await refresh($)
  const opened = await $.ui.open({ id: PANE, title: 'Git', focus: true, closeOnEscape: true, rows: 20 })
  return opened.isPlaced ? null : `No se pudo abrir el panel: ${opened.reason}`
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'git',
      description: 'Ficheros tocados en el turno y árbol sin commitear, con su diff',
      immediate: true,
    })
    $.clock.after(0, () => void refresh($))
    return next(e)
  })

  // Un prompt nuevo del usuario abre turno: se olvida lo tocado en el anterior.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' && !e.text.startsWith('/')) {
      await update($, turnFilesAtom, set<string[]>([]))
      await update($, bandHiddenAtom, set(false))
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (!EDIT_TOOLS.has(String(e.tool))) return result
    const input = e as unknown as Record<string, unknown>
    const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
    if (path !== '') await update($, turnFilesAtom, (list) => (list.includes(normPath(path)) ? list : [...list, normPath(path)]))
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) $.clock.after(0, () => void refresh($))
    return result
  })

  on('command.run', { command: 'git' }, async ($) => {
    const problem = await openPane($, 'turno')
    return problem ? { text: problem } : {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.viewport?.isFullscreen === true) $.clock.after(0, () => void autoOpen($))
    const snapshot = await read($, snapshotAtom)
    if (e.props.isWorking || e.props.hasSurvey || snapshot === null || (await read($, bandHiddenAtom))) return next(e)
    const changed = turnChanges(snapshot, await read($, turnFilesAtom))
    if (changed.length === 0) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" columnGap={1}>
        <Text dimColor>{`turno · ${summaryLine(changed)}`}</Text>
        <Button key="ver" label="ver diff" onPress={() => void openPane($, 'turno')} />
        <Button key="ocultar" label="ocultar" onPress={() => void update($, bandHiddenAtom, set(true))} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface === 'mobile') return next(e)
    const vm = {
      snapshot: await read($, snapshotAtom),
      error: await read($, errorAtom),
      turnFiles: await read($, turnFilesAtom),
      view: await read($, viewAtom),
      diff: await read($, diffAtom),
      rows: e.viewport?.rows ?? 24,
    }
    return gitView($.ui.resolve(e), vm, {
      tab: (tab) => void update($, viewAtom, (v) => ({ ...v, tab, selected: null })),
      select: (path) => void select($, path),
      back: () => void update($, viewAtom, (v) => ({ ...v, selected: null, offset: 0 })),
      page: (delta) => void update($, viewAtom, (v) => ({ ...v, offset: Math.max(0, v.offset + delta) })),
      refresh: () => void refresh($),
    })
  })
}
