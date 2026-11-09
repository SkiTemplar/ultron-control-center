export type AttachSource = 'proyecto' | 'sesion' | 'capturas' | 'descargas' | 'escritorio'

/** Un fichero de una carpeta del sistema (capturas, descargas, escritorio). */
export type FolderFile = { path: string; name: string; size: number; mtimeMs: number }

declare module 'claude-code' {
  interface PluginState {
    'ultron-adjuntar': {
      source: AttachSource
      query: string
      cwd: string
      projectFiles: string[]
      projectLoadedAt: number
      sessionFiles: string[]
      folder: FolderFile[]
      attached: string[]
      isLoading: boolean
      error: string | null
      hasAutoOpened: boolean
    }
  }
}
