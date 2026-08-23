'use strict';

/**
 * Identidad de proyecto estable frente a mudanzas de carpeta.
 *
 * Hasta 2026-08-23 el project_id era el basename del cwd. Mover o renombrar la
 * carpeta creaba una identidad nueva y la memoria del proyecto quedaba
 * inalcanzable: el home-reorg de agosto dejó 46 memorias huérfanas y una sesión
 * viva de Legacy FC con recall vacío en el 100% de sus turnos.
 *
 * La identidad es un UUID que ULTRON fija en `.git/config` (`ultron.projectId`)
 * la primera vez que ve el repositorio. Vive con el `.git`, así que sobrevive a
 * mover, renombrar y reorganizar el árbol; no se versiona, no aparece en los
 * diffs y no depende de heurísticas sobre la ruta.
 *
 * El SHA del commit raíz solo actúa de puente: sirve para reconocer un repo ya
 * registrado antes de escribirle el UUID. No vale como clave primaria porque
 * colisiona entre repos gemelos — mismo árbol, autor, mensaje y segundo
 * producen el mismo SHA, y el alta automática de proyectos crea justo ese caso.
 *
 * El UUID identifica; el `id` es un nombre legible que se fija en el alta y ya
 * no cambia. Eso permite apuntar un repo al id que YA tiene los datos en
 * brain.db en vez de reescribir miles de filas.
 *
 * Fail-safe: cualquier error devuelve el basename, que es el comportamiento
 * anterior. Este módulo está en el camino caliente de UserPromptSubmit y nunca
 * debe lanzar ni bloquear un prompt.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const GIT_TIMEOUT_MS = 2000;
const REGISTRY_VERSION = 2;
const GIT_CONFIG_KEY = 'ultron.projectId';

/**
 * Ruta del registro. Se lee en cada llamada (y no como constante de módulo)
 * para que los tests puedan redirigirla con ULTRON_PROJECT_IDENTITY_PATH sin
 * tocar el registro real del usuario.
 */
function registryPath() {
  return (
    process.env.ULTRON_PROJECT_IDENTITY_PATH ||
    path.join(os.homedir(), '.ultron', 'cockpit', 'project-identity.json')
  );
}

/** Normaliza una ruta para usarla como clave del registro. */
function normPath(p) {
  try {
    return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  } catch {
    return String(p || '').toLowerCase();
  }
}

/** Basename saneado: comportamiento histórico y último recurso. */
function basenameId(cwd) {
  try {
    const base = path.basename(cwd || process.cwd());
    const p = base.replace(/^\.+/, '');
    return p || null;
  } catch {
    return null;
  }
}

function emptyRegistry() {
  return { version: REGISTRY_VERSION, repos: {}, paths: {}, bySha: {} };
}

function readRegistry() {
  try {
    const reg = JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
    if (!reg || typeof reg !== 'object') return emptyRegistry();
    for (const k of ['repos', 'paths', 'bySha']) {
      if (!reg[k] || typeof reg[k] !== 'object') reg[k] = {};
    }
    return reg;
  } catch {
    return emptyRegistry();
  }
}

/**
 * Escritura atómica. Varias sesiones pueden escribir a la vez: se relee justo
 * antes de fusionar para que la perdedora de una carrera solo pague un `git`
 * de más, nunca una entrada perdida de otro proyecto.
 */
function writeRegistry(mutate) {
  try {
    const reg = readRegistry();
    mutate(reg);
    reg.version = REGISTRY_VERSION;
    const target = registryPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
    fs.renameSync(tmp, target);
    return reg;
  } catch {
    return null;
  }
}

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** Sube desde `cwd` hasta la raíz del repo. `.git` puede ser fichero (worktrees). */
function repoRootFor(cwd) {
  try {
    let dir = path.resolve(cwd || process.cwd());
    for (let i = 0; i < 40; i++) {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * SHA (12 hex) del commit raíz. Con varias raíces históricas se toma la última
 * que lista `rev-list`, la más antigua. Solo se usa como puente hacia el UUID:
 * repos gemelos comparten SHA, así que no identifica por sí solo.
 */
function rootShaFor(repoRoot) {
  try {
    const lines = String(git(repoRoot, ['rev-list', '--max-parents=0', 'HEAD']))
      .trim()
      .split('\n')
      .filter(Boolean);
    if (!lines.length) return null;
    const sha = lines[lines.length - 1].trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha.slice(0, 12).toLowerCase() : null;
  } catch {
    // Repo sin commits: legítimo justo después de `git init`.
    return null;
  }
}

/** UUID que ULTRON guarda en `.git/config`, o null si aún no lo tiene. */
function readRepoUuid(repoRoot) {
  try {
    const v = String(git(repoRoot, ['config', '--local', '--get', GIT_CONFIG_KEY])).trim();
    return /^[0-9a-f-]{8,}$/i.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Fija el UUID en `.git/config`. Devuelve false si el repo no admite escritura. */
function writeRepoUuid(repoRoot, uuid) {
  try {
    git(repoRoot, ['config', '--local', GIT_CONFIG_KEY, uuid]);
    return true;
  } catch {
    return false;
  }
}

/**
 * project_id estable para un cwd.
 *
 * 1. Ruta ya conocida: se resuelve sin tocar git (camino caliente, 0 spawns).
 * 2. UUID en `.git/config`: identidad exacta del repositorio.
 * 3. Repo sin UUID: se reconoce por el SHA raíz si ya estaba registrado —
 *    así un proyecto conocido conserva su id — y se le escribe el UUID.
 * 4. Sin repo: basename, igual que antes.
 */
function resolveProjectId(cwd) {
  const fallback = basenameId(cwd);
  try {
    const key = normPath(cwd || process.cwd());
    const reg = readRegistry();

    const knownUuid = reg.paths[key];
    if (knownUuid && reg.repos[knownUuid] && reg.repos[knownUuid].id) {
      return reg.repos[knownUuid].id;
    }

    const root = repoRootFor(cwd);
    if (!root) return fallback;
    const rootKey = normPath(root);

    let uuid = readRepoUuid(root);
    const sha = rootShaFor(root);

    // Repo ya conocido por su SHA pero todavía sin UUID: hereda su identidad en
    // vez de estrenar una. Es el camino que reengancha los proyectos mudados.
    if (!uuid && sha && reg.bySha[sha] && reg.repos[reg.bySha[sha]]) {
      const candidate = reg.bySha[sha];
      const paths = reg.repos[candidate].paths || [];
      // Si la ruta registrada sigue viva y es OTRA, son repos gemelos: el SHA
      // coincide por plantilla, no por ser el mismo proyecto.
      const otraViva = paths.some((p) => p !== rootKey && fs.existsSync(p));
      if (!otraViva) uuid = candidate;
    }

    const yaEnGit = Boolean(uuid) && Boolean(readRepoUuid(root));
    if (!uuid) uuid = crypto.randomUUID();
    const fijado = yaEnGit || writeRepoUuid(root, uuid);

    const known = reg.repos[uuid];
    const id = known && known.id ? known.id : basenameId(root) || fallback;
    if (!id) return fallback;

    // Sin UUID en `.git/config` la identidad no es estable: persistir el atajo
    // por ruta dejaría el repo atado a su ubicación —justo lo que este módulo
    // viene a eliminar— y el alta no se reintentaría nunca. Se devuelve el id
    // sin ensuciar el registro, y el siguiente turno vuelve a intentarlo.
    if (!fijado) return id;

    writeRegistry((r) => {
      const entry = r.repos[uuid] || {
        id,
        name: id,
        rootSha: sha || null,
        paths: [],
        created_at: new Date().toISOString(),
      };
      entry.id = entry.id || id;
      entry.rootSha = entry.rootSha || sha || null;
      entry.paths = Array.isArray(entry.paths) ? entry.paths : [];
      if (!entry.paths.includes(rootKey)) entry.paths.push(rootKey);
      r.repos[uuid] = entry;
      r.paths[key] = uuid;
      r.paths[rootKey] = uuid;
      // Solo el primer repo se queda el SHA: en una colisión de gemelos el
      // segundo no debe robarle el puente al primero.
      if (sha && !r.bySha[sha]) r.bySha[sha] = uuid;
    });

    return id;
  } catch {
    return fallback;
  }
}

module.exports = {
  resolveProjectId,
  basenameId,
  repoRootFor,
  rootShaFor,
  readRepoUuid,
  writeRepoUuid,
  readRegistry,
  writeRegistry,
  normPath,
  registryPath,
  GIT_CONFIG_KEY,
};
