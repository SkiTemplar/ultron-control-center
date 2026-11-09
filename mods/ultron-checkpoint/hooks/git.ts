import type { EngineInterface } from 'claude-code'

/** El cwd no es un repo git: no es un fallo, simplemente no hay nada que guardar. */
export class NotRepoError extends Error {}

/** Se acabó el tiempo de la operación. */
export class TimeoutError extends Error {}

export type RunOptions = { env?: Record<string, string>; stdin?: string; cwd?: string }

/** Ejecuta un proceso con lo que quede de plazo; lanza con la primera línea del error real. */
export type Runner = (argv: string[], options?: RunOptions) => Promise<string>

/** Sin bloqueos opcionales: `git status` no reescribe el índice del usuario. */
const BASE_ENV = { GIT_OPTIONAL_LOCKS: '0' }

const firstLine = (text: string): string => text.trim().split('\n')[0]?.trim() ?? ''

export function makeRunner($: EngineInterface, cwd: string, deadline: number): Runner {
  return async (argv, options = {}) => {
    const remaining = deadline - (await $.clock.now())
    if (remaining <= 0) throw new TimeoutError(`sin tiempo antes de ${argv.slice(0, 2).join(' ')}`)
    const init = {
      cwd: options.cwd ?? cwd,
      env: { ...BASE_ENV, ...options.env },
      timeoutMs: remaining,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    }
    let run
    try {
      run = await $.process.run(argv, init)
    } catch (err) {
      if ((await $.clock.now()) >= deadline) throw new TimeoutError(`${argv.slice(0, 2).join(' ')} no terminó a tiempo`)
      throw new Error(`${argv.slice(0, 2).join(' ')}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (run.exitCode === 0) return run.stdout
    const reason = firstLine(run.stderr) || firstLine(run.stdout) || `salió con ${run.exitCode}`
    if (/not a git repository/i.test(reason)) throw new NotRepoError(reason)
    throw new Error(`${argv.slice(0, 2).join(' ')}: ${reason}`)
  }
}

export type Repo = { root: string; gitDir: string }

/** Raíz y directorio git del cwd; lanza NotRepoError fuera de un repo. */
export async function repoOf(run: Runner): Promise<Repo> {
  const [root, gitDir] = (await run(['git', 'rev-parse', '--show-toplevel', '--absolute-git-dir'])).replace(/\r/g, '').split('\n')
  if (!root || !gitDir) throw new Error('git rev-parse no devolvió la raíz del repo')
  return { root, gitDir }
}

/** Índice temporal de una foto, dentro del directorio git (nunca el índice real). */
export const tmpIndexPath = (repo: Repo, stamp: number): string => `${repo.gitDir}/ultron-checkpoint-${stamp}.index`

/**
 * Escribe en la base de objetos el árbol de trabajo completo (sin seguimiento no ignorado
 * incluido) con un índice temporal sembrado con el real, para que `git add -A` solo vuelva a
 * leer lo cambiado. No toca el índice ni el árbol del usuario. El índice temporal lo borra
 * quien llama, también si esto falla a mitad.
 */
export async function writeWorktreeTree(run: Runner, repo: Repo, script: string, tmpIndex: string): Promise<string> {
  await run(['node', script, 'copy', `${repo.gitDir}/index`, tmpIndex])
  const env = { GIT_INDEX_FILE: tmpIndex }
  await run(['git', 'add', '-A'], { env, cwd: repo.root })
  const tree = (await run(['git', 'write-tree'], { env, cwd: repo.root })).trim()
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error(`git write-tree devolvió «${tree.slice(0, 80)}»`)
  return tree
}
