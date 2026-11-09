import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AttachSource, FolderFile } from '../types'
import {
  FOLDER_OF,
  displayPath,
  fmtAge,
  fmtSize,
  isImage,
  isListable,
  mentionOf,
  rank,
  slash,
} from './files'
import { type Actions, type Hit, attachView } from './view'

const PANE = 'adjuntar'
const PROJECT_TTL_MS = 60_000
const MAX_PROJECT_FILES = 20_000
const MAX_WALK_FILES = 5_000
const MAX_FOLDER_FILES = 300
const MAX_SESSION_FILES = 60
const SESSION_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'dist', 'build', '.venv', '__pycache__', '.next'])

const sourceAtom = atom({ plugin: 'ultron-adjuntar', key: 'source' } as const, 'proyecto')
const queryAtom = atom({ plugin: 'ultron-adjuntar', key: 'query' } as const, '')
const cwdAtom = atom({ plugin: 'ultron-adjuntar', key: 'cwd' } as const, '')
const projectAtom = atom({ plugin: 'ultron-adjuntar', key: 'projectFiles' } as const, [])
const projectAtAtom = atom({ plugin: 'ultron-adjuntar', key: 'projectLoadedAt' } as const, 0)
const sessionAtom = atom({ plugin: 'ultron-adjuntar', key: 'sessionFiles' } as const, [])
const folderAtom = atom({ plugin: 'ultron-adjuntar', key: 'folder' } as const, [])
const attachedAtom = atom({ plugin: 'ultron-adjuntar', key: 'attached' } as const, [])
const loadingAtom = atom({ plugin: 'ultron-adjuntar', key: 'isLoading' } as const, false)
const errorAtom = atom({ plugin: 'ultron-adjuntar', key: 'error' } as const, null)
const autoOpenedAtom = atom({ plugin: 'ultron-adjuntar', key: 'hasAutoOpened' } as const, false)

const set = <T,>(value: T) => () => value
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

async function homeDir($: EngineInterface): Promise<string> {
  return slash((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '')
}

/** Ficheros del proyecto relativos al cwd, de mayor a menor relevancia de git. */
async function walk($: EngineInterface, root: string): Promise<string[]> {
  const found: string[] = []
  let frontier = ['']
  for (let depth = 0; depth < 4 && frontier.length > 0 && found.length < MAX_WALK_FILES; depth++) {
    const nextFrontier: string[] = []
    for (const dir of frontier) {
      const entries = await $.fs.list(dir === '' ? root : `${root}/${dir}`)
      for (const entry of entries) {
        const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
        if (entry.kind === 'dir' && !SKIP_DIRS.has(entry.name)) nextFrontier.push(rel)
        if (entry.kind === 'file' && isListable(entry.name)) found.push(rel)
      }
    }
    frontier = nextFrontier
  }
  return found.slice(0, MAX_WALK_FILES)
}

async function loadProject($: EngineInterface, isForced: boolean): Promise<void> {
  const loadedAt = await read($, projectAtAtom)
  const now = await $.clock.now()
  if (!isForced && now - loadedAt < PROJECT_TTL_MS) return
  const cwd = slash(await $.session.cwd())
  await update($, cwdAtom, set(cwd))
  const git = await $.process.run(['git', 'ls-files', '-co', '--exclude-standard'], { cwd, timeoutMs: 20_000 })
  const files =
    git.exitCode === 0
      ? git.stdout.split(/\r?\n/).filter(Boolean).slice(0, MAX_PROJECT_FILES)
      : await walk($, cwd)
  await update($, projectAtom, set(files))
  await update($, projectAtAtom, set(now))
}

async function listFolder($: EngineInterface, source: AttachSource): Promise<FolderFile[]> {
  const rel = FOLDER_OF[source]
  if (!rel) return []
  const dir = `${await homeDir($)}/${rel}`
  if (!(await $.fs.exists(dir))) throw new Error(`No existe ${dir}`)
  const entries = await $.fs.list(dir)
  return entries
    .filter((entry) => entry.kind === 'file' && isListable(entry.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_FOLDER_FILES)
    .map((entry) => ({ path: `${dir}/${entry.name}`, name: entry.name, size: entry.size, mtimeMs: entry.mtimeMs }))
}

async function loadSource($: EngineInterface, source: AttachSource, isForced: boolean): Promise<void> {
  await update($, loadingAtom, set(true))
  try {
    if (source === 'proyecto') await loadProject($, isForced)
    if (FOLDER_OF[source]) await update($, folderAtom, set(await listFolder($, source)))
    if ((await read($, cwdAtom)) === '') await update($, cwdAtom, set(slash(await $.session.cwd())))
    await update($, errorAtom, set<string | null>(null))
  } catch (err) {
    await update($, errorAtom, set<string | null>(message(err)))
  } finally {
    await update($, loadingAtom, set(false))
  }
}

/** Lo que muestra el panel para el origen y la búsqueda actuales. */
async function hitsFor($: EngineInterface, limit: number): Promise<{ hits: Hit[]; total: number }> {
  const source = await read($, sourceAtom)
  const query = await read($, queryAtom)
  const cwd = await read($, cwdAtom)

  if (source === 'proyecto' || source === 'sesion') {
    const pool = source === 'proyecto' ? await read($, projectAtom) : await read($, sessionAtom)
    const ranked = rank(pool, query, limit)
    const hits = ranked.paths.map((p) => {
      const path = source === 'proyecto' ? `${cwd}/${p}` : p
      return { path, display: displayPath(path, cwd), meta: '', isImage: isImage(path) }
    })
    return { hits, total: ranked.total }
  }

  const now = await $.clock.now()
  const folder = await read($, folderAtom)
  const byName = new Map(folder.map((f) => [f.name, f]))
  const ranked = rank(folder.map((f) => f.name), query, limit)
  const hits = ranked.paths.flatMap((name) => {
    const file = byName.get(name)
    if (!file) return []
    return [{ path: file.path, display: file.name, meta: `${fmtSize(file.size)} · ${fmtAge(now - file.mtimeMs)}`, isImage: isImage(file.name) }]
  })
  return { hits, total: ranked.total }
}

async function attach($: EngineInterface, path: string): Promise<void> {
  const cwd = (await read($, cwdAtom)) || slash(await $.session.cwd())
  const filled = await $.prompt.fill({ text: `${mentionOf(path, cwd)} `, mode: 'insert' })
  if (!filled.isFilled) {
    $.ui.toast(`No pude escribir en el prompt${filled.refusal ? ` (${filled.refusal})` : ''}`)
    return
  }
  await update($, attachedAtom, (list) => (list.includes(path) ? list : [...list, path]))
}

/**
 * Abre el buscador sin que se pida, una vez por sesión y solo en pantalla
 * completa (acoplado a la derecha), sin foco, con la lista del origen actual.
 */
async function autoOpen($: EngineInterface): Promise<void> {
  // Dentro de ULTRON Sessions la ventana tiene su propia interfaz: sin panel automático.
  if (await $.env.get('ULTRON_SESION_ID')) return
  if (await read($, autoOpenedAtom)) return
  await update($, autoOpenedAtom, set(true))
  const opened = await $.ui.open({ id: PANE, title: 'Adjuntar', closeOnEscape: true, rows: 22 })
  if (opened.isPlaced) await loadSource($, await read($, sourceAtom), false)
}

function actionsFor($: EngineInterface, limit: number): Actions {
  return {
    source: (source) =>
      void (async () => {
        await update($, sourceAtom, set<AttachSource>(source))
        await loadSource($, source, false)
      })(),
    query: (text) => void update($, queryAtom, set(text)),
    attach: (path) => void attach($, path),
    attachFirst: () =>
      void (async () => {
        const first = (await hitsFor($, limit)).hits[0]
        if (first) await attach($, first.path)
      })(),
    done: () => void $.ui.close({ id: PANE }),
  }
}

async function attachScreenshots($: EngineInterface, args: string): Promise<string | null> {
  const count = Math.min(10, Math.max(1, Number.parseInt(args, 10) || 1))
  const images = (await listFolder($, 'capturas')).filter((f) => isImage(f.name)).slice(0, count)
  if (images.length === 0) return 'No hay capturas en Imágenes/Capturas de pantalla.'
  const cwd = slash(await $.session.cwd())
  const text = `${images.map((f) => mentionOf(f.path, cwd)).join(' ')} `
  const filled = await $.prompt.fill({ text, mode: 'insert' })
  if (!filled.isFilled) return `No pude escribir en el prompt${filled.refusal ? ` (${filled.refusal})` : ''}.`
  const now = await $.clock.now()
  $.ui.toast(images.map((f) => `▣ ${f.name} (hace ${fmtAge(now - f.mtimeMs)})`).join(' · '))
  return null
}

async function quoteSelection($: EngineInterface): Promise<string | null> {
  const selected = await $.ui.selection()
  if (selected === undefined) return 'No hay nada seleccionado (selecciona con el ratón en pantalla completa).'
  const quoted = selected.text.replace(/^/gm, '> ')
  const filled = await $.prompt.fill({ text: `${quoted}\n\n`, mode: 'insert' })
  return filled.isFilled ? null : 'No pude escribir en el prompt.'
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'adjuntar',
      description: 'Buscador de ficheros: proyecto, esta sesión, capturas, descargas y escritorio',
      argumentHint: '[búsqueda]',
      immediate: true,
    })
    await $.command.register({
      name: 'captura',
      description: 'Adjunta la última captura de pantalla (o las n últimas)',
      argumentHint: '[n]',
      immediate: true,
    })
    await $.command.register({
      name: 'citar',
      description: 'Cita en el prompt lo último que has seleccionado con el ratón',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'adjuntar' }, async ($, e) => {
    await update($, queryAtom, set(e.args.trim()))
    await update($, attachedAtom, set<string[]>([]))
    const opened = await $.ui.open({ id: PANE, title: 'Adjuntar', focus: true, closeOnEscape: true, rows: 22 })
    if (!opened.isPlaced) return { text: `No se pudo abrir el panel: ${opened.reason}` }
    const source = await read($, sourceAtom)
    $.clock.after(0, () => void loadSource($, source, false))
    return {}
  })

  on('command.run', { command: 'captura' }, async ($, e) => {
    try {
      const problem = await attachScreenshots($, e.args)
      return problem ? { text: problem } : {}
    } catch (err) {
      return { text: `Captura: ${message(err)}` }
    }
  })

  on('command.run', { command: 'citar' }, async ($) => {
    const problem = await quoteSelection($)
    return problem ? { text: problem } : {}
  })

  // Lo que Claude lee o edita en el hilo principal alimenta la pestaña «esta sesión».
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || !SESSION_TOOLS.has(String(e.tool))) return result
    const input = e as unknown as Record<string, unknown>
    const path = input.file_path ?? input.notebook_path
    if (typeof path === 'string' && path !== '') {
      const clean = slash(path)
      await update($, sessionAtom, (list) => [clean, ...list.filter((p) => p !== clean)].slice(0, MAX_SESSION_FILES))
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.viewport?.isFullscreen === true) $.clock.after(0, () => void autoOpen($))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface === 'mobile') return next(e)
    const limit = Math.min(30, Math.max(6, (e.viewport?.rows ?? 30) - 14))
    const { hits, total } = await hitsFor($, limit)
    return attachView(
      $.ui.resolve(e),
      {
        source: await read($, sourceAtom),
        query: await read($, queryAtom),
        hits,
        total,
        attached: new Set(await read($, attachedAtom)),
        isLoading: await read($, loadingAtom),
        error: await read($, errorAtom),
        width: e.props.bodyColumns,
      },
      actionsFor($, limit),
    )
  })
}
