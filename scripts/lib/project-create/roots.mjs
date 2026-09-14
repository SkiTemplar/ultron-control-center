// roots.mjs — carga y escritura de project-roots.json, y lectura del
// registro de proyectos (projects.json). La escritura del registro pasa
// siempre por project-new.mjs (ver steps.mjs); aqui solo se lee.
//
// Overrides para tests (nunca tocan el disco real del usuario):
//   ULTRON_PROJECT_ROOTS_OVERRIDE  ruta a project-roots.json alternativo
//   ULTRON_PROJECTS_JSON_OVERRIDE  ruta a projects.json alternativo

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, renameSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { CliError } from './errors.mjs';
import { COCKPIT } from './paths.mjs';

export function rootsPath() {
  return process.env.ULTRON_PROJECT_ROOTS_OVERRIDE || join(COCKPIT, 'project-roots.json');
}
export function registryPath() {
  return process.env.ULTRON_PROJECTS_JSON_OVERRIDE || join(COCKPIT, 'projects.json');
}

export function writeJsonAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

export function loadRoots() {
  const p = rootsPath();
  if (!existsSync(p)) {
    throw new CliError(
      'ROOTS_NOT_CONFIGURED',
      `no hay raices configuradas (${p} no existe). Usa: node scripts/project-create.mjs roots set --id <id> --label "<label>" --path <ruta-abs> --kind asignatura|personal`,
    );
  }
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  if (!Array.isArray(raw.roots)) throw new CliError('ROOTS_INVALID', `${p} no tiene un array "roots"`);
  return raw;
}

export function loadRootsOrEmpty() {
  const p = rootsPath();
  if (!existsSync(p)) return { roots: [] };
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  return Array.isArray(raw.roots) ? raw : { roots: [] };
}

export function rootsWithExists(raw) {
  return raw.roots.map((r) => ({ ...r, exists: existsSync(r.path) }));
}

export function findRoot(raw, id) {
  const root = raw.roots.find((r) => r.id === id);
  if (!root) {
    const ids = raw.roots.map((r) => r.id).join(', ') || '(ninguna)';
    throw new CliError('ROOT_NOT_FOUND', `raiz desconocida: "${id}". Raices disponibles: ${ids}`);
  }
  return root;
}

export function ensureRootPathExists(root) {
  if (!existsSync(root.path)) {
    throw new CliError('ROOT_PATH_MISSING', `la raiz "${root.id}" apunta a una ruta que no existe en disco: ${root.path}`);
  }
}

export function cmdRoots() {
  return { roots: rootsWithExists(loadRoots()) };
}

export function cmdRootsSet(flags) {
  const { id, label, path: rawPath, kind } = flags;
  if (!id || !label || !rawPath || !kind) {
    throw new CliError('BAD_ARGS', 'roots set requiere --id --label --path --kind asignatura|personal');
  }
  if (!['asignatura', 'personal'].includes(kind)) {
    throw new CliError('BAD_ARGS', `--kind debe ser "asignatura" o "personal", recibido: ${kind}`);
  }
  const raw = loadRootsOrEmpty();
  const entry = { id, label, path: resolve(rawPath), kind };
  const idx = raw.roots.findIndex((r) => r.id === id);
  if (idx >= 0) raw.roots[idx] = entry; else raw.roots.push(entry);
  writeJsonAtomic(rootsPath(), raw);
  return { roots: rootsWithExists(raw) };
}

export function loadRegistrySafe() {
  const p = registryPath();
  if (!existsSync(p)) return { projects: [] };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(raw.projects) ? raw : { projects: [] };
  } catch {
    return { projects: [] };
  }
}
