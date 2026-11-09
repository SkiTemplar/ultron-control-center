/**
 * worktree.mjs - worktree aislado por intento, enlaces, commit y alcance.
 *
 * Los enlaces (`--link`, junctions en Windows) se quitan ANTES de borrar un
 * worktree: un borrado recursivo que entre por la junction se llevaria el
 * directorio real del repo (p. ej. node_modules).
 */

import { existsSync, lstatSync, mkdirSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { BRIEF_FILE } from './adapters.mjs';
import { UsageError, git } from './proc.mjs';

/** Ruta relativa sin `..` ni raiz: no puede salir del worktree. */
export const isSafeRelPath = (rel) =>
  typeof rel === 'string' && rel !== '' && !isAbsolute(rel) && !/^[\\/]/.test(rel) && !rel.split(/[\\/]/).includes('..');

export function checkLinks(repo, links) {
  const unsafe = links.find((rel) => !isSafeRelPath(rel));
  if (unsafe !== undefined) throw new UsageError(`--link ${unsafe}: debe ser una ruta relativa dentro del repo (sin ..)`);
  const missing = links.find((rel) => !existsSync(join(repo, rel)));
  if (missing) throw new UsageError(`--link ${missing}: no existe en el repo`);
}

/** Crea el worktree y devuelve el SHA de la base sobre la que se hara el commit. */
export function prepareWorktree(repo, base, wt, branch, links) {
  mkdirSync(dirname(wt), { recursive: true });
  git(repo, ['worktree', 'add', '-q', '-b', branch, wt, base]);
  for (const rel of links) {
    mkdirSync(dirname(join(wt, rel)), { recursive: true });
    symlinkSync(join(repo, rel), join(wt, rel), 'junction');
  }
  return git(wt, ['rev-parse', 'HEAD']);
}

/** Quita los enlaces sin tocar su destino. */
export function unlinkLinks(wt, links) {
  for (const rel of links) {
    const p = join(wt, rel);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (!st.isSymbolicLink()) continue;
    try {
      unlinkSync(p);
    } catch {
      rmdirSync(p);
    }
  }
}

/** Borra el worktree (y la rama si `branch`); tolera que ya no existan. */
export function dropWorktree(repo, wt, links, branch = null) {
  if (wt && existsSync(wt)) {
    unlinkLinks(wt, links);
    git(repo, ['worktree', 'remove', '--force', wt], { allowFail: true });
    try {
      if (existsSync(wt)) rmSync(wt, { recursive: true, force: true });
    } catch (e) {
      // Un proceso que sobrevivio al motor puede retener el directorio: se avisa y se sigue.
      console.error(`aviso: no se pudo borrar ${wt} (${e.code || e.message}); borralo a mano`);
    }
  }
  git(repo, ['worktree', 'prune'], { allowFail: true });
  if (branch) git(repo, ['branch', '-D', branch], { allowFail: true });
}

/**
 * Prepara el indice con el resultado del motor. Devuelve el arbol exacto que se
 * valida y los ficheros que cambia respecto a `baseSha` (no respecto a HEAD: un
 * commit del propio motor no puede esconder un fichero del alcance). Sin
 * renombrados: un `git mv` desde fuera del alcance mostraria solo el destino.
 */
export function stageResult(wt, links, baseSha) {
  rmSync(join(wt, BRIEF_FILE), { force: true });
  // Los enlaces no son parte del resultado. Solo se excluyen a mano los que git
  // no ignora ya: excluir una ruta ignorada (node_modules, target) hace fallar
  // `git add` («paths are ignored») y el intento se perdia entero (2026-10-28).
  const excludes = links
    .map((rel) => rel.replace(/\\/g, '/'))
    .filter((rel) => !git(wt, ['check-ignore', '--', rel], { allowFail: true }))
    .map((rel) => `:(exclude)${rel}`);
  git(wt, ['add', '-A', '--', '.', ...excludes]);
  // -z: rutas sin citar ni escapar (tildes, ñ, espacios), separadas por NUL.
  const files = git(wt, ['diff', '--cached', '--no-renames', '--name-only', '-z', baseSha]).split('\0').filter(Boolean);
  return { files, tree: git(wt, ['write-tree']) };
}

/**
 * Lo que cambio en el worktree o en el indice respecto a `tree`, que es lo que
 * se valido. Los enlaces no cuentan. El check ejecuta codigo: un fichero nuevo
 * sin ignorar tampoco estaba en lo validado.
 */
export function treeDrift(wt, links, tree) {
  const list = (args) => git(wt, args, { allowFail: true }).split('\0').filter(Boolean);
  const paths = [...list(['diff', '--name-only', '-z']), ...list(['ls-files', '--others', '--exclude-standard', '-z'])];
  const isLink = (p) => links.some((rel) => {
    const l = rel.replace(/\\/g, '/').replace(/\/$/, '');
    return p === l || p === `${l}/` || p.startsWith(`${l}/`);
  });
  const index = git(wt, ['write-tree'], { allowFail: true }) === tree ? [] : ['(indice de git)'];
  return [...index, ...paths.filter((p) => !isLink(p))];
}

/**
 * Commit del arbol `tree` validado sobre `baseSha` y rama apuntando a el.
 * Devuelve `{ sha, stat }`. Con plumbing, no con `git commit`: lo que entra es
 * ese arbol aunque el check haya tocado indice, HEAD o worktree, y no corre
 * ningun hook (los del repo corren cuando Opus hace el commit de la fusion).
 */
export function commitTree(wt, branch, { tree, baseSha }, { title, engine, model }) {
  const sha = git(wt, ['commit-tree', tree, '-p', baseSha, '-m', `chore(delegate): ${title}`, '-m', `Delegated-To: ${engine} ${model}`]);
  git(wt, ['update-ref', `refs/heads/${branch}`, sha], { config: ['core.hooksPath=/dev/null'] });
  return { sha, stat: git(wt, ['diff', '--stat', baseSha, sha]) };
}

/**
 * Glob -> RegExp: `**` cualquier ruta, `*` y `?` sin cruzar `/`. Un patron
 * sin `/` se compara tambien con el nombre del fichero (como .gitignore).
 */
export function globToRegExp(glob) {
  let re = '';
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      const slash = g[i + 2] === '/';
      re += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function parseScope(spec) {
  if (spec === undefined) return null;
  const globs = String(spec).split(',').map((s) => s.trim()).filter(Boolean);
  if (!globs.length) throw new UsageError('--scope necesita al menos un glob');
  return globs;
}

/** Ficheros del diff que caen fuera de todos los globs del alcance. */
export function outOfScope(files, globs) {
  if (!globs) return [];
  const matchers = globs.map((g) => ({ re: globToRegExp(g), base: !g.includes('/') }));
  const inScope = (f) => matchers.some(({ re, base }) => re.test(f) || (base && re.test(f.split('/').pop())));
  return files.filter((f) => !inScope(f));
}
