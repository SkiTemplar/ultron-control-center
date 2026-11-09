import type { GitFile, GitSnapshot } from '../types'

type Status = Omit<GitSnapshot, 'root' | 'files'> & { files: Array<{ path: string; code: string }> }
type Numstat = { added: number; deleted: number; isBinary: boolean }

/** Ruta comparable: barras normales, sin barra final, en minúsculas (Windows no distingue). */
export const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** Ruta relativa a la raíz del repo, o null si cae fuera. */
export function relToRoot(absPath: string, root: string): string | null {
  const abs = absPath.replace(/\\/g, '/')
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normPath(abs).startsWith(`${normPath(base)}/`)) return null
  return abs.slice(base.length + 1)
}

/** Quita las comillas con que git cita rutas con espacios o caracteres raros. */
const unquote = (p: string): string => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p)

/** Lee `git status --porcelain=v1 -b`: rama, adelanto/retraso y ficheros. */
export function parseStatus(text: string): Status {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l !== '')
  const head = lines[0]?.startsWith('## ') ? lines[0].slice(3) : ''
  const branch = head.split('...')[0]?.replace(/^No commits yet on /, '') || '(sin rama)'
  const ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0)
  const behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0)
  const files = lines
    .filter((l) => !l.startsWith('## '))
    .map((l) => {
      const target = l.slice(3)
      const path = unquote(target.includes(' -> ') ? (target.split(' -> ')[1] ?? target) : target)
      return { path, code: l.slice(0, 2).trim() || '?' }
    })
  return { branch, ahead, behind, files }
}

/** Lee `git diff --numstat`: líneas añadidas y quitadas por ruta (`-` = binario). */
export function parseNumstat(text: string): Map<string, Numstat> {
  const out = new Map<string, Numstat>()
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const [add, del, ...rest] = line.split('\t')
    if (add === undefined || del === undefined || rest.length === 0) continue
    const raw = rest.join('\t')
    const path = unquote(raw.includes(' => ') ? raw.replace(/\{(.*) => (.*)\}/, '$2').split(' => ').pop()! : raw)
    const isBinary = add === '-'
    out.set(normPath(path), { added: isBinary ? 0 : Number(add), deleted: isBinary ? 0 : Number(del), isBinary })
  }
  return out
}

export function mergeFiles(status: Status['files'], numstat: Map<string, Numstat>): GitFile[] {
  return status.map((f) => ({ ...f, ...(numstat.get(normPath(f.path)) ?? { added: 0, deleted: 0, isBinary: false }) }))
}

/** Los ficheros con cambios que se tocaron en el turno. */
export function turnChanges(snapshot: GitSnapshot, turnFiles: readonly string[]): GitFile[] {
  const wanted = new Set(turnFiles.map((p) => relToRoot(p, snapshot.root)).filter((p): p is string => p !== null).map(normPath))
  return snapshot.files.filter((f) => wanted.has(normPath(f.path)))
}

export const totals = (files: readonly GitFile[]): { added: number; deleted: number } => ({
  added: files.reduce((n, f) => n + f.added, 0),
  deleted: files.reduce((n, f) => n + f.deleted, 0),
})

/** Color de cada línea del diff. */
export function lineTone(line: string): 'success' | 'error' | 'suggestion' | undefined {
  if (line.startsWith('+++') || line.startsWith('---')) return undefined
  if (line.startsWith('+')) return 'success'
  if (line.startsWith('-')) return 'error'
  if (line.startsWith('@@')) return 'suggestion'
  return undefined
}

/** Quita la cabecera del diff (diff --git, index, ---/+++) y deja los hunks. */
export const diffBody = (text: string): string[] => {
  const lines = text.replace(/\r/g, '').split('\n')
  const first = lines.findIndex((l) => l.startsWith('@@'))
  return (first === -1 ? lines : lines.slice(first)).filter((l, i, all) => i < all.length - 1 || l !== '')
}
