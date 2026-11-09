/**
 * squash.mjs - precondiciones de `merge` y estado del squash hasta el commit.
 *
 * `merge` deja un `git merge --squash` SIN commit (los hooks del repo corren al
 * hacerlo), asi que no puede registrar `merged`: si el usuario deshace el
 * squash, el ledger mentiria. Registra el paso `squash-prepared` (con la rama y
 * el HEAD de ese momento) y `merged` se escribe cuando el contenido de la rama
 * ya esta en un commit posterior; lo comprueban `merge`, `list`, `clean` y `gc`
 * (`settleSquash`). Estados del squash:
 *
 * - `committed`: HEAD avanzo y los ficheros de la rama coinciden con ella.
 * - `pending`: los cambios siguen en el indice, sin commit.
 * - `undone`: ni en el indice ni en HEAD (reset o checkout); se puede repetir `merge`.
 *
 * Antes del squash se exige arbol principal limpio (sin cambios en ficheros
 * versionados: se mezclarian con el squash en el mismo commit) y que la base
 * de la rama (`<rama>~1`, cada intento es un unico commit sobre la base) sea
 * ancestro de HEAD.
 */

import { isOwnBranch } from './cleanup.mjs';
import { finalOf, lastStageOf, recordFinal, recordStage } from './ledger.mjs';
import { UsageError, git } from './proc.mjs';

export const SQUASH_PREPARED = 'squash-prepared';

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Lanza UsageError si el repo no admite el squash de `branch`, que apunta a `sha`. */
export function assertMergeable(repo, branch, sha) {
  const dirty = git(repo, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no']);
  if (dirty) {
    throw new UsageError(`el arbol de ${repo} tiene cambios sin commitear y se mezclarian con el squash (commit o stash antes de merge):\n${dirty}`);
  }
  const base = git(repo, ['rev-parse', '--verify', '--quiet', `${sha}~1^{commit}`]);
  if (git(repo, ['merge-base', base, 'HEAD'], { allowFail: true }) !== base) {
    throw new UsageError(`la base de ${branch} (${base.slice(0, 10)}) no es ancestro de HEAD: HEAD cambio de rama o se reescribio; rebasa la rama o fusionala a mano`);
  }
}

/** `git merge --squash` del commit validado y paso `squash-prepared` en el ledger (sin `final`). */
export function prepareSquash(id, repo, branch, sha) {
  assertMergeable(repo, branch, sha);
  const head = git(repo, ['rev-parse', 'HEAD']);
  // Por SHA: entre la comprobacion y aqui, el nombre de rama podria moverse.
  git(repo, ['merge', '--squash', sha]);
  recordStage(id, SQUASH_PREPARED, { branch, head, sha });
}

/** Ficheros que cambia la rama respecto a su base. */
const branchFiles = (repo, branch) =>
  git(repo, ['diff', '--name-only', '-z', `${branch}~1`, branch]).split('\0').filter(Boolean);

/** Estado del squash de `stage` en `repo`: committed | pending | undone | unknown. */
export function squashState(repo, stage) {
  const { branch, head } = stage;
  if (!git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true })) return 'unknown';
  const files = branchFiles(repo, branch);
  if (!files.length) return 'unknown';
  const staged = git(repo, ['diff', '--cached', '--name-only', 'HEAD', '--', ...files]) !== '';
  if (git(repo, ['rev-parse', 'HEAD']) === head) return staged ? 'pending' : 'undone';
  const differs = git(repo, ['diff', '--name-only', 'HEAD', branch, '--', ...files]) !== '';
  if (!differs) return 'committed';
  return staged ? 'pending' : 'undone';
}

/**
 * Estado del ultimo `squash-prepared` de la delegacion (null si no hay o si la
 * linea no es valida: el ledger esta fuera del worktree, pero el motor corre
 * sin sandbox). Con `committed` registra `final: merged` si aun no lo estaba.
 */
export function settleSquash(id, m) {
  const stage = lastStageOf(id);
  if (!stage || stage.stage !== SQUASH_PREPARED) return null;
  if (!isOwnBranch(id, stage.branch) || !SHA.test(String(stage.head))) return null;
  const state = squashState(m.repo, stage);
  if (state === 'committed' && !finalOf(id)) recordFinal(id, 'merged');
  return state;
}
