// git.mjs — llamadas a git para la pool de skills, sin shell y sin ejecutar
// nada del repo clonado: ni hooks (no se clonan), ni submódulos, ni npm.
// Los enlaces simbólicos del repo se materializan como ficheros de texto
// (core.symlinks=false) para que un SKILL.md no pueda apuntar a ficheros de
// fuera del clon. Tras el checkout, los ficheros del clon quedan de solo
// lectura: la pool se ve desde todos los proyectos a través de la junction y una
// edición desde uno de ellos entraría en el clon compartido sin cambiar el HEAD.
// Además, cloneProblem exige el árbol de trabajo limpio (git status vacío).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  cloneDir, fail, isInside, REPOS_DIR,
} from './store.mjs';

const HARDENING = ['-c', 'core.symlinks=false', '-c', 'protocol.ext.allow=never', '-c', 'submodule.recurse=false'];
const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const URL_RE = /^(https|ssh|file):\/\/\S+$/i;
const SCP_RE = /^git@[A-Za-z0-9.-]+:[A-Za-z0-9_.\/-]+$/;

export function git(args, { cwd, allowFail = false } = {}) {
  const r = spawnSync('git', [...HARDENING, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.error) fail(`no se pudo ejecutar git: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) fail(`git ${args[0]} ha fallado: ${(r.stderr || '').trim()}`);
  return r;
}

/** owner/repo -> URL https de GitHub; acepta https://, ssh://, file:// y git@host:ruta. */
export function normalizeRepoUrl(repo) {
  if (!repo || repo.startsWith('-')) fail(`repo no válido: ${repo}`);
  if (SLUG_RE.test(repo)) return `https://github.com/${repo.replace(/\.git$/, '')}.git`;
  if (URL_RE.test(repo) || SCP_RE.test(repo)) return repo;
  fail(`repo no válido: ${repo} (usa owner/repo o una URL https://, ssh:// o file://)`);
  return null;
}

export function headOf(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  const r = git(['-C', dir, 'rev-parse', 'HEAD'], { allowFail: true });
  return r.status === 0 ? r.stdout.trim().toLowerCase() : null;
}

/** Valida un nombre de rama con git check-ref-format --branch. */
export function assertRef(ref) {
  if (!ref) return null;
  const r = ref.startsWith('-') ? null : git(['check-ref-format', '--branch', ref], { allowFail: true });
  if (!r || r.status !== 0 || ref.includes('@{')) fail(`--ref no es un nombre de rama válido: ${ref}`);
  return ref;
}

/**
 * Ficheros modificados, sin seguimiento o ignorados en el árbol de trabajo del
 * clon, más los marcados assume-unchanged o skip-worktree (ocultarían cambios a
 * git status). Sin optional locks: comprobar no reescribe el índice.
 */
export function dirtyFiles(dir) {
  const ro = ['--no-optional-locks', '-C', dir];
  const st = git([...ro, 'status', '--porcelain', '--untracked-files=all', '--ignored'], { allowFail: true });
  const ls = git([...ro, 'ls-files', '-v'], { allowFail: true });
  if (st.status !== 0 || ls.status !== 0) return ['(git status ha fallado)'];
  const hidden = ls.stdout.split('\n').filter((l) => /^([a-z]|S) /.test(l)).map((l) => `oculto ${l.slice(2)}`);
  return [...st.stdout.split('\n').map((l) => l.trim()).filter(Boolean), ...hidden];
}

/**
 * Problema del clon de una entrada respecto a lo fijado (null si está bien):
 * clon ausente, HEAD distinto del SHA o árbol de trabajo con cambios.
 */
export function cloneProblem(entry) {
  const dir = cloneDir(entry);
  const head = headOf(dir);
  if (!head) return `no existe el clon de "${entry.name}": ${dir}`;
  if (head !== entry.sha) {
    return `el HEAD del clon de "${entry.name}" (${head.slice(0, 12)}) no coincide con el SHA fijado (${entry.sha.slice(0, 12)})`;
  }
  const dirty = dirtyFiles(dir);
  if (dirty.length) {
    return `el clon de "${entry.name}" tiene cambios sin fijar (${dirty.length}: ${dirty.slice(0, 3).join(', ')}); no coincide con el SHA revisado`;
  }
  return null;
}

/** Recorre los ficheros de un árbol (sin .git) y les aplica un modo. */
export function chmodTree(dir, mode) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name === '.git') continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) chmodTree(full, mode);
    else if (d.isFile()) fs.chmodSync(full, mode);
  }
}

/** Borra un clon que acabamos de crear; nunca fuera de repos/. */
export function removeClone(dir) {
  if (!isInside(dir, REPOS_DIR)) fail(`se ha evitado borrar una carpeta fuera de la pool: ${dir}`);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

/** Clona sin checkout y fija el HEAD (detached) en el SHA exacto. Devuelve el SHA completo. */
export function cloneAt(url, dest, sha) {
  if (fs.existsSync(dest)) fail(`ya existe la carpeta del clon: ${dest}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  git(['clone', '--quiet', '--no-checkout', '--no-recurse-submodules', '--', url, dest]);
  let r = git(['-C', dest, 'checkout', '--quiet', '--detach', sha], { allowFail: true });
  if (r.status !== 0) {
    git(['-C', dest, 'fetch', '--quiet', 'origin', sha], { allowFail: true });
    r = git(['-C', dest, 'checkout', '--quiet', '--detach', sha], { allowFail: true });
  }
  const head = r.status === 0 ? headOf(dest) : null;
  if (!head || !head.startsWith(sha.toLowerCase())) {
    removeClone(dest);
    fail(`el SHA ${sha} no existe en ${url}`);
  }
  chmodTree(dest, 0o444);
  return head;
}

/** SHA del remoto tras un fetch: la rama fijada en `ref` o la rama por defecto. */
export function fetchRemoteHead(dir, ref) {
  git(['-C', dir, 'fetch', '--quiet', '--prune', 'origin']);
  if (assertRef(ref)) {
    const r = git(['-C', dir, 'rev-parse', '--verify', `refs/remotes/origin/${ref}^{commit}`], { allowFail: true });
    if (r.status !== 0) fail(`la rama "${ref}" no existe en el remoto`);
    return r.stdout.trim().toLowerCase();
  }
  git(['-C', dir, 'remote', 'set-head', 'origin', '--auto'], { allowFail: true });
  const r = git(['-C', dir, 'rev-parse', '--verify', 'refs/remotes/origin/HEAD^{commit}'], { allowFail: true });
  if (r.status !== 0) fail('no se pudo resolver la rama por defecto del remoto (prueba con --ref <rama>)');
  return r.stdout.trim().toLowerCase();
}

/** Resumen del cambio entre dos SHA, limitado a la subcarpeta de la entrada. */
export function describeChange(dir, oldSha, newSha, subpath) {
  const scope = ['--', subpath || '.'];
  const log = git(['-C', dir, 'log', '--oneline', '--no-decorate', `${oldSha}..${newSha}`, ...scope]).stdout.trim();
  const stat = git(['-C', dir, 'diff', '--stat', oldSha, newSha, ...scope]).stdout.trim();
  return { log, stat };
}
