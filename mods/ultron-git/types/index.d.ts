/** Un fichero con cambios frente a HEAD (o sin seguimiento). */
export type GitFile = {
  /** Ruta relativa a la raíz del repo, con barras normales. */
  path: string
  /** Código de `git status --porcelain` (`M`, `A`, `D`, `R`, `??`…), sin espacios. */
  code: string
  added: number
  deleted: number
  isBinary: boolean
}

export type GitSnapshot = {
  /** Raíz del repo con barras normales. */
  root: string
  branch: string
  ahead: number
  behind: number
  files: GitFile[]
}

export type GitTab = 'turno' | 'arbol'

export type GitView = { tab: GitTab; selected: string | null; offset: number }

export type GitDiff = { path: string; lines: string[] }

declare module 'claude-code' {
  interface PluginState {
    'ultron-git': {
      hasAutoOpened: boolean
      snapshot: GitSnapshot | null
      error: string | null
      /** Rutas absolutas normalizadas que se editaron en el turno en curso o el último. */
      turnFiles: string[]
      view: GitView
      diff: GitDiff | null
      isBandHidden: boolean
    }
  }
}
