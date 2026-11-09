/**
 * cleanup.mjs - lectura validada de meta.json y limpieza de una delegacion.
 *
 * meta.json esta dos niveles por encima del cwd del motor (que corre sin pedir
 * permisos), asi que no se confia en el: el id tiene que tener la forma que da
 * `stamp()`, cada worktree tiene que estar bajo <delegaciones>/<id>/ y cada
 * rama tiene que ser `delegate/<id>` o `delegate/<id>-aN`. Lo que no cumpla
 * aborta con error de uso en vez de borrar un directorio o una rama ajenos.
 *
 * La limpieza no depende solo de `attempts`: si la ejecucion se corto (Ctrl+C,
 * excepcion) meta.json puede no listar los intentos, asi que tambien se
 * recorren los directorios `aN/wt` y las ramas `delegate/<id>*` del repo.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { delegationsDir } from './config.mjs';
import { UsageError, git } from './proc.mjs';
import { dropWorktree, isSafeRelPath } from './worktree.mjs';

/** Forma de los ids que genera run.mjs (`stamp`): sin `.` ni separadores. */
export const ID_PATTERN = /^[A-Za-z0-9_-]+-\d{8}-\d{4}-[0-9a-f]{4}$/;

export const delegationDir = (id) => join(delegationsDir(), id);

const norm = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));

export function assertId(id) {
  if (!id || !ID_PATTERN.test(id)) throw new UsageError(`id de delegacion no valido: ${id ?? '(vacio)'}`);
}

/** true si `branch` es una rama de la delegacion `id`. */
export function isOwnBranch(id, branch) {
  return typeof branch === 'string' && (branch === `delegate/${id}` || new RegExp(`^delegate/${id}-a\\d+$`).test(branch));
}

function assertInside(id, p) {
  if (typeof p !== 'string' || !norm(p).startsWith(norm(delegationDir(id)) + sep)) {
    throw new UsageError(`meta.json de ${id}: la ruta ${p} no esta bajo el directorio de la delegacion; no se toca`);
  }
}

function validateMeta(id, m) {
  if (!m || typeof m !== 'object' || m.id !== id) throw new UsageError(`meta.json de ${id}: el id no coincide`);
  if (typeof m.repo !== 'string' || !isAbsolute(m.repo)) throw new UsageError(`meta.json de ${id}: repo no valido`);
  if (!Array.isArray(m.links || []) || !(m.links || []).every(isSafeRelPath)) throw new UsageError(`meta.json de ${id}: links no validos`);
  for (const a of m.attempts || []) {
    if (a.wt) assertInside(id, a.wt);
    if (a.branch && !isOwnBranch(id, a.branch)) throw new UsageError(`meta.json de ${id}: la rama ${a.branch} no es de la delegacion`);
  }
  if (m.wt) assertInside(id, m.wt);
  if (m.winner && !isOwnBranch(id, m.winner)) throw new UsageError(`meta.json de ${id}: la rama ${m.winner} no es de la delegacion`);
  return m;
}

/** meta.json validado de la delegacion `id`. */
export function readMeta(id) {
  assertId(id);
  const file = join(delegationDir(id), 'meta.json');
  if (!existsSync(file)) throw new UsageError(`no existe la delegacion ${id}`);
  let m;
  try {
    m = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UsageError(`meta.json de ${id} no parsea (${e.message})`);
  }
  return validateMeta(id, m);
}

/** Worktrees de la delegacion: los de meta.json y los `aN/wt` que haya en disco. */
function worktreesOf(id, m) {
  const dir = delegationDir(id);
  const onDisk = existsSync(dir)
    ? readdirSync(dir).filter((d) => /^a\d+$/.test(d)).map((d) => join(dir, d, 'wt')).filter(existsSync)
    : [];
  const listed = (m.attempts || []).map((a) => a.wt).filter(Boolean);
  return [...new Map([...listed, ...onDisk].map((p) => [norm(p), p])).values()];
}

/** Ramas `delegate/<id>*` que existen en el repo y son de la delegacion. */
function branchesOf(id, repo) {
  const out = git(repo, ['branch', '--list', '--format=%(refname:short)', `delegate/${id}*`], { allowFail: true });
  return out.split(/\r?\n/).map((b) => b.trim()).filter((b) => isOwnBranch(id, b));
}

/** Borra los worktrees (y las ramas si `withBranches`); devuelve las ramas borradas. */
export function dropAll(id, m, withBranches) {
  for (const wt of worktreesOf(id, m)) dropWorktree(m.repo, wt, m.links || [], null);
  const branches = withBranches ? branchesOf(id, m.repo) : [];
  for (const b of branches) git(m.repo, ['branch', '-D', b], { allowFail: true });
  git(m.repo, ['worktree', 'prune'], { allowFail: true });
  return branches;
}
