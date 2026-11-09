// link.mjs — llevar una entrada de la pool a un proyecto y quitarla.
//
//   skill       junction <proyecto>/.claude/skills/<n> -> subcarpeta de la pool,
//               más la línea `.claude/skills/<n>` en el .gitignore del proyecto
//   ue-plugin   copia en <carpeta del .uproject>/Plugins/<n> (al compilar se
//               generan Binaries/ e Intermediate/ y ensuciarían la pool)
//   python-lib  `uv add <n>==<versión>` con cwd en el proyecto
//
// Un enlace solo se borra si lstat dice que es un enlace y apunta a la pool:
// se elimina el punto de reparación (unlink), nunca su contenido.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  POOL_ROOT, assertName, entryTarget, fail, isInside, isReviewed,
  lstatOrNull, ownSkillsDir, readLinkTarget, realOrSelf, samePath,
} from './store.mjs';
import { chmodTree, cloneProblem } from './git.mjs';

// --- .gitignore ----------------------------------------------------------------

function readText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/** Patrón sin la barra inicial ni la final: "/.claude/skills/x/" -> ".claude/skills/x". */
const bare = (l) => l.trim().replace(/^\/+/, '').replace(/\/+$/, '');

/** Patrones que ya ignoran la línea: ella misma y cada carpeta padre (.claude/skills, .claude). */
function coveringPatterns(line) {
  const parts = line.split('/');
  return new Set(parts.map((_, i) => parts.slice(0, i + 1).join('/')));
}

/** Añade la línea si ningún patrón existente la cubre ya. Devuelve true si ha escrito. */
export function addGitignoreLine(projectPath, line) {
  const file = path.join(projectPath, '.gitignore');
  const text = readText(file);
  const covering = coveringPatterns(line);
  if (text.split(/\r?\n/).some((l) => covering.has(bare(l)))) return false;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const sep = text && !text.endsWith('\n') ? eol : '';
  fs.writeFileSync(file, `${text}${sep}${line}${eol}`, 'utf8');
  return true;
}

/**
 * Quita la línea de la entrada (con o sin barras inicial y final) y conserva el
 * final de línea de las demás tal cual. No toca patrones más amplios (.claude/,
 * .claude/skills): los puso el proyecto. Devuelve true si ha escrito.
 */
export function removeGitignoreLine(projectPath, line) {
  const file = path.join(projectPath, '.gitignore');
  const text = readText(file);
  const lines = text.split(/(?<=\n)/);
  const kept = lines.filter((l) => bare(l) !== line);
  if (kept.length === lines.length) return false;
  fs.writeFileSync(file, kept.join(''), 'utf8');
  return true;
}

export const gitignoreLine = (name) => `.claude/skills/${name}`;

// --- comprobaciones previas ------------------------------------------------------

function assertLinkable(entry, opts) {
  if (entry.own) return;
  if (!isReviewed(entry) && !opts.unreviewed) {
    fail(`"${entry.name}" no tiene revisión de seguridad para el SHA fijado (review null); `
      + 'revísala antes o pasa --unreviewed asumiendo el riesgo');
  }
  if (entry.kind === 'python-lib') return;
  const problem = cloneProblem(entry);
  if (problem) fail(`${problem}; no se enlaza código distinto del revisado`);
}

/**
 * La carpeta de skills del proyecto no puede ser (ni resolver a, por junction o
 * symlink en cualquier tramo) la global: se compara la ruta real de cada nivel
 * (proyecto, .claude y .claude/skills) con su equivalente en el home.
 */
function assertNotGlobalSkills(projectPath) {
  const home = os.homedir();
  const levels = [[projectPath, home], ...['.claude', path.join('.claude', 'skills')]
    .map((sub) => [path.join(projectPath, sub), path.join(home, sub)])];
  for (const [mine, global] of levels) {
    if (samePath(mine, global) || samePath(realOrSelf(mine), realOrSelf(global))) {
      fail(`${mine} resuelve a ${global}, en el home: enlazar ahí sería global`);
    }
  }
}

// --- skill -----------------------------------------------------------------------

/** Enlace que gestiona este CLI: apunta a la pool o a las skills propias. */
const isManaged = (target) => isInside(target, POOL_ROOT) || isInside(target, ownSkillsDir());

function linkSkill(project, entry) {
  const target = entryTarget(entry);
  const skillsDir = path.join(project.path, '.claude', 'skills');
  assertNotGlobalSkills(project.path);
  const link = path.join(skillsDir, entry.name);
  const st = lstatOrNull(link);
  let state = 'creado';
  if (st) {
    if (!st.isSymbolicLink()) fail(`${link} ya existe y no es un enlace: no se toca`);
    const current = readLinkTarget(link);
    if (samePath(current, target)) state = 'ya existía';
    else if (!isManaged(current)) fail(`${link} es un enlace ajeno a la pool (${current}): no se toca`);
    else { fs.unlinkSync(link); state = 're-enlazado'; }
  }
  if (state !== 'ya existía') {
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.symlinkSync(target, link, 'junction');
  }
  const ignored = addGitignoreLine(project.path, gitignoreLine(entry.name));
  return { state, link, target, gitignore: ignored ? 'línea añadida' : 'ya estaba' };
}

function unlinkSkill(project, name) {
  const link = path.join(project.path, '.claude', 'skills', name);
  const st = lstatOrNull(link);
  if (st && !st.isSymbolicLink()) fail(`${link} no es un enlace: no se borra una carpeta real del proyecto`);
  if (st) {
    const current = readLinkTarget(link);
    if (!isManaged(current)) fail(`${link} apunta fuera de la pool (${current}): no se toca`);
    fs.unlinkSync(link);
  }
  const ignored = removeGitignoreLine(project.path, gitignoreLine(name));
  return { state: st ? 'quitado' : 'no había enlace', link, gitignore: ignored ? 'línea quitada' : 'no estaba' };
}

// --- ue-plugin -------------------------------------------------------------------

function findUprojectDir(project, uproject) {
  if (uproject) {
    const file = path.resolve(uproject);
    if (!file.toLowerCase().endsWith('.uproject') || !fs.existsSync(file)) fail(`--uproject no válido: ${file}`);
    return path.dirname(file);
  }
  const found = fs.readdirSync(project.path).filter((f) => f.toLowerCase().endsWith('.uproject'));
  if (found.length !== 1) {
    fail(`el proyecto tiene ${found.length} ficheros .uproject en su raíz; indica cuál con --uproject <ruta>`);
  }
  return project.path;
}

function linkUePlugin(project, entry, opts) {
  const source = entryTarget(entry);
  const dest = path.join(findUprojectDir(project, opts.uproject), 'Plugins', entry.name);
  if (lstatOrNull(dest)) return { state: 'ya existía (no se sobrescribe)', link: dest, target: source };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(source, dest, {
    recursive: true,
    filter: (src) => path.basename(src) !== '.git',
  });
  // La copia hereda el solo lectura del clon; en Plugins/ el proyecto la edita y compila.
  chmodTree(dest, 0o644);
  return { state: 'copiado', link: dest, target: source };
}

// --- python-lib ------------------------------------------------------------------

function runUv(project, args) {
  const r = spawnSync('uv', args, { cwd: project.path, encoding: 'utf8', windowsHide: true });
  if (r.error) fail(`no se pudo ejecutar uv: ${r.error.message}`);
  if (r.status !== 0) fail(`uv ${args.join(' ')} ha fallado: ${(r.stderr || '').trim()}`);
  return { state: `uv ${args.join(' ')}`, link: project.path };
}

// --- despacho --------------------------------------------------------------------

export function linkEntry(project, entry, opts = {}) {
  assertName(entry.name);
  assertLinkable(entry, opts);
  if (entry.kind === 'skill') return linkSkill(project, entry);
  if (entry.kind === 'ue-plugin') return linkUePlugin(project, entry, opts);
  return runUv(project, ['add', `${entry.name}==${entry.version}`]);
}

export function unlinkEntry(project, name, entry) {
  assertName(name);
  if (entry && entry.kind === 'ue-plugin') {
    fail(`"${name}" es una copia en Plugins/ (no un enlace): bórrala a mano tras revisar que no tiene cambios locales`);
  }
  if (entry && entry.kind === 'python-lib') return runUv(project, ['remove', name]);
  return unlinkSkill(project, name);
}
