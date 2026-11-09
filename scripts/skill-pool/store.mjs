// store.mjs — rutas, validación y persistencia de la pool de skills de terceros.
//
// La pool vive en <repo>/skill-pool/: pool.json (versionado) y repos/ (clones
// de terceros, ignorado por git). Overrides para tests:
//   ULTRON_SKILL_POOL_ROOT  raíz alternativa de la pool
//   ULTRON_PROJECTS_JSON    registro de proyectos alternativo (también se
//                           acepta ULTRON_PROJECTS_JSON_OVERRIDE, el nombre que
//                           usan project-new.mjs y project-create.mjs)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ULTRON = path.resolve(import.meta.dirname, '..', '..');

export const POOL_ROOT = path.resolve(process.env.ULTRON_SKILL_POOL_ROOT || path.join(ULTRON, 'skill-pool'));
export const POOL_JSON = path.join(POOL_ROOT, 'pool.json');
export const REPOS_DIR = path.join(POOL_ROOT, 'repos');
export const REGISTRY = path.resolve(
  process.env.ULTRON_PROJECTS_JSON
  || process.env.ULTRON_PROJECTS_JSON_OVERRIDE
  || path.join(ULTRON, 'cockpit', 'projects.json'),
);

export const KINDS = ['skill', 'python-lib', 'ue-plugin'];
export const CLONED_KINDS = ['skill', 'ue-plugin'];
export const HOME_PROJECT_ID = '__home';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA_RE = /^[0-9a-f]{40}$/i;
const IS_WINDOWS = process.platform === 'win32';

/** Error esperado del CLI: se imprime sin traza y sale con código 1. */
export class PoolError extends Error {}

export function fail(message) {
  throw new PoolError(message);
}

// --- rutas -------------------------------------------------------------------

/** Normaliza una ruta para compararla (sin prefijo \\?\, sin separador final). */
export function normalizePath(p) {
  const clean = String(p).replace(/^\\\\\?\\/, '');
  const resolved = path.resolve(clean).replace(/[\\/]+$/, '');
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
}

export function samePath(a, b) {
  return normalizePath(a) === normalizePath(b);
}

/** true si `child` está dentro de `parent` (estrictamente, no igual). */
export function isInside(child, parent) {
  const rel = path.relative(normalizePath(parent), normalizePath(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function lstatOrNull(p) {
  return fs.lstatSync(p, { throwIfNoEntry: false }) || null;
}

/** Destino absoluto de un enlace (junction o symlink). */
export function readLinkTarget(linkPath) {
  const raw = fs.readlinkSync(linkPath).replace(/^\\\\\?\\/, '');
  return path.resolve(path.dirname(linkPath), raw);
}

/** Ruta real (resuelve junctions y symlinks) o la propia ruta si no existe. */
export function realOrSelf(p) {
  return fs.existsSync(p) ? fs.realpathSync.native(p) : path.resolve(p);
}

// --- validación --------------------------------------------------------------

export function assertName(name) {
  if (typeof name !== 'string' || !name) fail('falta el nombre de la entrada');
  if (name.includes('..') || /[\\/:]/.test(name) || !NAME_RE.test(name)) {
    fail(`nombre no válido: "${name}" (solo letras, dígitos, '.', '_' y '-'; sin '..' ni separadores)`);
  }
  return name;
}

export function assertKind(kind) {
  if (!KINDS.includes(kind)) fail(`--kind debe ser ${KINDS.join(' | ')}, recibido: ${kind}`);
  return kind;
}

export function assertSha(sha) {
  if (!sha || !SHA_RE.test(sha)) fail(`--sha debe ser un SHA completo de 40 caracteres hexadecimales, recibido: ${sha}`);
  return sha.toLowerCase();
}

/** Subcarpeta relativa del repo: sin rutas absolutas, unidades ni '..'. */
export function assertSubpath(sub) {
  const value = sub === undefined || sub === '' ? '.' : String(sub);
  const segments = value.split(/[\\/]+/);
  if (path.isAbsolute(value) || value.includes(':') || segments.includes('..')) {
    fail(`--path debe ser una subcarpeta relativa del repo sin '..', recibido: ${value}`);
  }
  return segments.filter((s) => s && s !== '.').join('/') || '.';
}

// --- entradas ----------------------------------------------------------------

export function cloneDirName(entry) {
  return `${assertName(entry.name)}@${assertSha(entry.sha).slice(0, 7)}`;
}

export function cloneDir(entry) {
  return path.join(REPOS_DIR, cloneDirName(entry));
}

/** Carpeta de la entrada dentro de su clon; rechaza la que resuelve fuera de la pool. */
export function entryTarget(entry) {
  if (entry.own) return entry.target;
  const base = cloneDir(entry);
  const target = path.resolve(base, entry.path || '.');
  if (!samePath(target, base) && !isInside(target, base)) {
    fail(`la entrada "${entry.name}" resuelve fuera de su clon en la pool: ${target}`);
  }
  if (!isInside(target, POOL_ROOT)) fail(`la entrada "${entry.name}" resuelve fuera de la pool: ${target}`);
  return target;
}

export function isReviewed(entry) {
  const pinned = entry.kind === 'python-lib' ? entry.version : entry.sha;
  return Boolean(entry.review && entry.review.sha && entry.review.sha === pinned);
}

// --- pool.json ---------------------------------------------------------------

export function emptyPool() {
  return { version: 1, entries: [] };
}

export function loadPool() {
  if (!fs.existsSync(POOL_JSON)) return emptyPool();
  const raw = JSON.parse(fs.readFileSync(POOL_JSON, 'utf8'));
  if (!Array.isArray(raw.entries)) fail(`${POOL_JSON} no tiene un array "entries"`);
  return raw;
}

/** Escritura atómica (tmp + rename) con copia previa en pool.json.bak. */
export function savePool(pool) {
  fs.mkdirSync(POOL_ROOT, { recursive: true });
  if (fs.existsSync(POOL_JSON)) fs.copyFileSync(POOL_JSON, `${POOL_JSON}.bak`);
  const tmp = `${POOL_JSON}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(pool, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, POOL_JSON);
}

export function findEntry(pool, name) {
  const entry = pool.entries.find((e) => e.name === name);
  if (!entry) fail(`no hay ninguna entrada "${name}" en la pool (mira: skill-pool list)`);
  return entry;
}

// --- skills propias ----------------------------------------------------------
//
// Las skills del usuario en ~/.claude/skills/_disabled/ no cargan solas. Se
// tratan como entradas `skill` sin SHA ni revisión (el código es suyo) y la pool
// gana si comparten nombre. El home se lee en cada llamada para que el selftest
// pueda falsearlo con USERPROFILE/HOME.

export const ownSkillsDir = () => path.join(os.homedir(), '.claude', 'skills', '_disabled');

function toOwnEntry(name) {
  const target = path.join(ownSkillsDir(), name);
  return fs.existsSync(path.join(target, 'SKILL.md')) ? { name, kind: 'skill', own: true, target } : null;
}

export function listOwnSkills() {
  const dir = ownSkillsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && NAME_RE.test(d.name))
    .map((d) => toOwnEntry(d.name))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Entrada de la pool o, si no hay, skill propia con ese nombre; falla si no hay ninguna. */
export function findAnyEntry(pool, name) {
  const entry = pool.entries.find((e) => e.name === name) || toOwnEntry(assertName(name));
  if (!entry) fail(`"${name}" no está ni en la pool ni entre tus skills de ${ownSkillsDir()} (mira: skill-pool list)`);
  return entry;
}

export function replaceEntry(pool, updated) {
  return { ...pool, entries: pool.entries.map((e) => (e.name === updated.name ? updated : e)) };
}

// --- registro de proyectos -----------------------------------------------------

export function loadRegistry() {
  if (!fs.existsSync(REGISTRY)) return [];
  const raw = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  return Array.isArray(raw.projects) ? raw.projects : [];
}

function isHomeLike(id, projectPath) {
  const home = os.homedir();
  return id === HOME_PROJECT_ID || samePath(projectPath, home)
    || samePath(realOrSelf(projectPath), realOrSelf(home));
}

/**
 * Resuelve un proyecto por id del registro o por ruta absoluta. Rechaza el home:
 * su .claude/skills es la carpeta global y enlazar ahí afectaría a todas las sesiones.
 */
export function resolveProject(arg) {
  if (!arg) fail('falta el proyecto (id del registro o ruta absoluta)');
  const projects = loadRegistry();
  let found;
  if (path.isAbsolute(arg)) {
    found = projects.find((p) => p.path && samePath(p.path, arg)) || { id: null, path: path.resolve(arg) };
  } else {
    found = projects.find((p) => p.id === arg);
    if (!found) fail(`no hay ningún proyecto con id "${arg}" en ${REGISTRY}`);
  }
  if (!found.path) fail(`el proyecto "${arg}" no tiene ruta en el registro`);
  if (isHomeLike(found.id, found.path)) {
    fail('el home no se admite como proyecto: su .claude/skills es la carpeta global de todas las sesiones');
  }
  const st = lstatOrNull(found.path);
  if (!st || !st.isDirectory()) fail(`la carpeta del proyecto no existe: ${found.path}`);
  return { id: found.id, path: path.resolve(found.path) };
}

export { isHomeLike };
