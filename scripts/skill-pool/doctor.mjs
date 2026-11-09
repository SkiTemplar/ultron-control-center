// doctor.mjs — consistencia de la pool y de los enlaces en los proyectos.
//
// Problemas (salida distinta de 0):
//   - entrada sin carpeta de clon, con HEAD distinto del SHA fijado o con el
//     árbol de trabajo sucio (editado a través de una junction, por ejemplo)
//   - entrada con nombre no válido o que resuelve fuera de la pool
//   - carpeta de repos/ sin entrada en pool.json
//   - enlace a la pool roto, en el home (global) o a un clon que no es el fijado
// Avisos (no cambian la salida): entradas sin revisión de seguridad.

import fs from 'node:fs';
import path from 'node:path';
import {
  CLONED_KINDS, POOL_ROOT, REPOS_DIR, cloneDir, cloneDirName, entryTarget, isHomeLike,
  isInside, isReviewed, loadPool, loadRegistry, lstatOrNull, readLinkTarget, samePath,
} from './store.mjs';
import { cloneProblem } from './git.mjs';

const out = (line = '') => process.stdout.write(`${line}\n`);

/** Ejecuta fn y convierte un error en texto de problema (null si no falla). */
function attempt(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err.message;
  }
}

function checkEntry(entry, problems, warnings) {
  if (!isReviewed(entry)) warnings.push(`${entry.name}: sin revisión de seguridad para el SHA o versión fijados`);
  if (!CLONED_KINDS.includes(entry.kind)) return;
  const invalid = attempt(() => entryTarget(entry));
  if (invalid) {
    problems.push(`${entry.name}: ${invalid}`);
    return;
  }
  const dir = cloneDir(entry);
  if (!fs.existsSync(dir)) {
    problems.push(`${entry.name}: entrada sin carpeta (${path.relative(POOL_ROOT, dir)})`);
    return;
  }
  const problem = cloneProblem(entry);
  if (problem) problems.push(`${entry.name}: ${problem}`);
}

function checkOrphanDirs(entries, problems) {
  if (!fs.existsSync(REPOS_DIR)) return;
  const expected = new Set();
  for (const e of entries.filter((x) => CLONED_KINDS.includes(x.kind))) {
    attempt(() => expected.add(cloneDirName(e)));
  }
  for (const d of fs.readdirSync(REPOS_DIR, { withFileTypes: true })) {
    if (!expected.has(d.name)) problems.push(`repos/${d.name}: carpeta sin entrada en pool.json`);
  }
}

function expectedTargets(entries) {
  const map = new Map();
  for (const e of entries.filter((x) => x.kind === 'skill')) {
    attempt(() => map.set(e.name, entryTarget(e)));
  }
  return map;
}

function checkProjectLinks(project, targets, problems) {
  const skillsDir = path.join(project.path, '.claude', 'skills');
  if (!fs.existsSync(skillsDir)) return;
  const label = project.id || project.path;
  for (const d of fs.readdirSync(skillsDir)) {
    const link = path.join(skillsDir, d);
    const st = lstatOrNull(link);
    if (!st || !st.isSymbolicLink()) continue;
    const current = readLinkTarget(link);
    if (!isInside(current, POOL_ROOT)) continue;
    if (!fs.existsSync(current)) problems.push(`${label}: enlace roto .claude/skills/${d} -> ${current}`);
    else if (isHomeLike(project.id, project.path)) problems.push(`${label}: enlace a la pool en el home (global): .claude/skills/${d}`);
    else if (!targets.has(d) || !samePath(current, targets.get(d))) {
      problems.push(`${label}: .claude/skills/${d} apunta a un clon que no es el fijado (repite link)`);
    }
  }
}

export function cmdDoctor() {
  const problems = [];
  const warnings = [];
  const { entries } = loadPool();
  for (const e of entries) checkEntry(e, problems, warnings);
  checkOrphanDirs(entries, problems);
  const targets = expectedTargets(entries);
  const projects = loadRegistry().filter((p) => p.path && fs.existsSync(p.path));
  for (const p of projects) checkProjectLinks({ id: p.id, path: p.path }, targets, problems);

  out(`[skill-pool] pool: ${POOL_ROOT} (${entries.length} entradas, ${projects.length} proyectos revisados)`);
  for (const w of warnings) out(`  aviso: ${w}`);
  for (const p of problems) out(`  PROBLEMA: ${p}`);
  out(problems.length ? `[skill-pool] ${problems.length} problema(s).` : '[skill-pool] sin problemas.');
  return problems.length ? 1 : 0;
}
