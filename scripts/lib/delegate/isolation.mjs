/**
 * isolation.mjs - vigilancia del checkout principal y de la config de git
 * durante un intento.
 *
 * El aislamiento del worktree solo es real con Codex (`-s workspace-write`):
 * agy y OpenCode corren sin sandbox y pueden escribir con rutas absolutas en el
 * repo principal o, a traves de las junctions de `--link`, en sus directorios.
 * Antes y despues del intento se toma una huella de `git status --porcelain` del
 * repo principal (estado XY, tamano y mtime de cada entrada).
 *
 * Que el checkout cambie NO demuestra nada: la regla manda lanzar en segundo
 * plano para que la sesion siga trabajando, y eso cambia el checkout (3 de 7
 * delegaciones reales se abortaron asi). Por eso se distingue:
 *
 * - Ruptura (`isolation`: aborta, corta el relevo): una entrada cambiada tiene en
 *   el checkout el MISMO contenido que en el diff del worktree, o un motor sin
 *   sandbox termina bien sin ningun cambio en el worktree mientras el checkout
 *   cambia: escribio donde no debia.
 * - Sospecha (`isolation-suspect`: el intento sigue y el check cuenta): cualquier
 *   otro cambio. No se puede atribuir al motor; se lista para revisarlo.
 *
 * Aparte, la config de git (`gitGuardSnapshot`): `.git/config`, `.git/hooks`,
 * `info/attributes` y el fichero `.git` del worktree. Un cambio ahi permite
 * ejecutar codigo en el siguiente `git` (filtros, fsmonitor, hooks), asi que es
 * ruptura siempre y no se lanza ni un `git add` mas sobre ese worktree.
 *
 * Limites: lo que git ignora (node_modules, target) no sale en la huella y una
 * LECTURA no deja rastro: un motor sin sandbox puede leer cualquier fichero del
 * usuario. No se revierte nada.
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { git } from './proc.mjs';

export const ISOLATION_REASON = 'isolation';
export const ISOLATION_SUSPECT_REASON = 'isolation-suspect';

const norm = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));

/** Entradas de `git status --porcelain -z`: ruta y estado XY (los renombrados traen la ruta de origen detras). */
export function parsePorcelainZ(out) {
  const tokens = out.split('\0').filter(Boolean);
  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const xy = tokens[i].slice(0, 2);
    entries.push({ xy, path: tokens[i].slice(3) });
    if (xy[0] === 'R' || xy[0] === 'C') i++;
  }
  return entries;
}

function statSignature(file) {
  try {
    const st = lstatSync(file);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return 'ausente';
  }
}

/**
 * Huella del checkout principal: Map ruta -> `XY|tamano:mtime`. `excludeDir`
 * (el directorio de la delegacion, por si cae dentro del repo) no cuenta.
 */
export function mainRepoSnapshot(repo, excludeDir = null) {
  const out = git(repo, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { raw: true });
  const skip = excludeDir ? norm(excludeDir) + sep : null;
  const snapshot = new Map();
  for (const { xy, path } of parsePorcelainZ(out)) {
    const abs = join(repo, path);
    if (skip && norm(abs).startsWith(skip)) continue;
    snapshot.set(path, `${xy}|${statSignature(abs)}`);
  }
  return snapshot;
}

/** Rutas cuya huella cambio, aparecio o desaparecio entre dos instantaneas. Pura. */
export function mainRepoChanges(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((p) => before.get(p) !== after.get(p)).sort();
}

/** Contenido de un fichero, o null si no existe o no es un fichero normal. */
function contentOf(file) {
  try {
    return lstatSync(file).isFile() ? readFileSync(file) : null;
  } catch {
    return null;
  }
}

/** Rutas tocadas del diff del worktree con el mismo contenido en el checkout (borrado en ambos incluido). */
export function sameAsWorktree(touched, repo, wt, files) {
  const inDiff = new Set(files);
  return touched.filter((p) => {
    if (!inDiff.has(p)) return false;
    const [a, b] = [contentOf(join(repo, p)), contentOf(join(wt, p))];
    return a === null || b === null ? a === b : a.equals(b);
  });
}

function brokenVerdict(touched) {
  return {
    outcome: 'engine-fail', reason: ISOLATION_REASON, checkOk: null, check: null,
    engineText: `cambio el repo principal fuera del worktree (${touched.length} fichero(s))`,
    isolation: touched,
  };
}

/**
 * Estado del aislamiento de un intento: `{ broken, suspect }`.
 * `broken`: veredicto que aborta el intento, o null. `suspect`: rutas cambiadas
 * sin poder atribuirlas al motor. `sandboxed`: el motor no puede escribir fuera
 * del worktree, asi que lo que cambie no es suyo. `engineFinishedClean`: salio
 * bien y sin ningun cambio en el worktree.
 */
export function isolationState(run, before, { wt, files, sandboxed, engineFinishedClean }) {
  const touched = mainRepoChanges(before, mainRepoSnapshot(run.repo, run.dir));
  if (!touched.length) return { broken: null, suspect: [] };
  if (sandboxed) return { broken: null, suspect: touched };
  const copied = sameAsWorktree(touched, run.repo, wt, files);
  if (copied.length || engineFinishedClean) return { broken: brokenVerdict(touched), suspect: [] };
  return { broken: null, suspect: touched };
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    return d.isDirectory() ? listFiles(p) : [p];
  });
}

const hashOf = (file) => {
  const data = contentOf(file);
  return data === null ? 'ausente' : createHash('sha256').update(data).digest('hex');
};

/** Ficheros vigilados, con etiqueta legible. Los `dirs` se resuelven UNA vez, antes del motor. */
function guardedFiles({ common, gitDir, wt }) {
  return [
    ['.git (del worktree)', join(wt, '.git')],
    ['.git/config', join(common, 'config')],
    ['.git/config.worktree', join(common, 'config.worktree')],
    ['.git/info/attributes', join(common, 'info', 'attributes')],
    [`.git/worktrees/${basename(gitDir)}/config.worktree`, join(gitDir, 'config.worktree')],
    ...listFiles(join(common, 'hooks')).map((p) => [`.git/hooks/${p.slice(join(common, 'hooks').length + 1).replace(/\\/g, '/')}`, p]),
  ];
}

const guardHashes = (dirs) => new Map(guardedFiles(dirs).map(([label, file]) => [label, hashOf(file)]));

/** Huella de la config de git que afecta al worktree `wt`. Se toma antes del motor. */
export function gitGuardSnapshot(wt) {
  const absolute = (flag) => git(wt, ['rev-parse', '--path-format=absolute', flag]);
  const dirs = { common: absolute('--git-common-dir'), gitDir: absolute('--git-dir'), wt };
  return { dirs, hashes: guardHashes(dirs) };
}

/** Etiquetas de lo vigilado que cambio. No lanza git: la config puede estar plantada. */
export function gitGuardChanges(guard) {
  return mainRepoChanges(guard.hashes, guardHashes(guard.dirs));
}

/** Veredicto de una config de git tocada durante el intento. */
export function tamperedVerdict(labels) {
  return {
    outcome: 'engine-fail', reason: ISOLATION_REASON, checkOk: null, check: null,
    engineText: `cambio la config de git durante el intento (${labels.join(', ')})`,
    isolation: labels,
  };
}
