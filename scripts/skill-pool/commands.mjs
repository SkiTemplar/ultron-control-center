// commands.mjs — subcomandos add, list, show, review y update de skill-pool.
// Cada uno recibe { positional, flags } y escribe su salida con `out`.

import fs from 'node:fs';
import path from 'node:path';
import {
  CLONED_KINDS, REPOS_DIR, assertKind, assertName, assertSha, assertSubpath, cloneDir,
  entryTarget, fail, findAnyEntry, findEntry, isReviewed, listOwnSkills, loadPool, replaceEntry, savePool,
} from './store.mjs';
import {
  assertRef, cloneAt, cloneProblem, describeChange, fetchRemoteHead, headOf, normalizeRepoUrl, removeClone,
} from './git.mjs';

const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+!-]{0,63}$/;
const out = (line = '') => process.stdout.write(`${line}\n`);
const today = () => new Date().toISOString().slice(0, 10);

function assertVersion(version) {
  if (!version || !VERSION_RE.test(version)) fail(`--version no válida: ${version}`);
  return version;
}

function splitList(value) {
  return value ? value.split(',').map((t) => t.trim()).filter(Boolean) : [];
}

// --- add -------------------------------------------------------------------------

function buildPythonEntry(base, flags, repo) {
  return { ...base, repo: repo ? normalizeRepoUrl(repo) : null, version: assertVersion(flags.version), path: null };
}

function buildClonedEntry(base, flags, repo) {
  if (!repo) fail('falta el repo (owner/repo o URL)');
  const url = normalizeRepoUrl(repo);
  const sha = assertSha(flags.sha);
  const draft = { ...base, repo: url, sha, path: assertSubpath(flags.path), ref: assertRef(flags.ref) };
  const dest = cloneDir(draft);
  const head = cloneAt(url, dest, sha);
  const entry = { ...draft, sha: head };
  const target = entryTarget(entry);
  const missing = !fs.existsSync(target)
    || (entry.kind === 'skill' && !fs.existsSync(path.join(target, 'SKILL.md')));
  if (missing) {
    removeClone(dest);
    fail(`la subcarpeta "${entry.path}" no existe en el repo${entry.kind === 'skill' ? ' o no tiene SKILL.md' : ''}`);
  }
  return entry;
}

export function cmdAdd({ positional, flags }) {
  const name = assertName(flags.name);
  const kind = assertKind(flags.kind);
  const pool = loadPool();
  if (pool.entries.some((e) => e.name === name)) fail(`ya hay una entrada "${name}"; para cambiar de SHA usa update`);
  const base = {
    name, kind, license: flags.license || null, templates: splitList(flags.templates), review: null,
  };
  const entry = kind === 'python-lib'
    ? buildPythonEntry(base, flags, positional[0])
    : buildClonedEntry(base, flags, positional[0]);
  savePool({ ...pool, entries: [...pool.entries, entry] });
  const pin = entry.kind === 'python-lib' ? `==${entry.version}` : `@${entry.sha.slice(0, 12)}`;
  out(`[skill-pool] registrada: ${name} (${kind}) ${pin}`);
  out('[skill-pool] sin revisión de seguridad: link exigirá --unreviewed hasta registrarla con `review`.');
}

// --- list ------------------------------------------------------------------------

export function cmdList({ flags }) {
  const { entries } = loadPool();
  const own = listOwnSkills().filter((s) => !entries.some((e) => e.name === s.name));
  if (flags.json) {
    out(JSON.stringify({ entries, own: own.map(({ name, target }) => ({ name, path: target })) }));
    return;
  }
  if (!entries.length) out('[skill-pool] la pool está vacía.');
  for (const e of entries) {
    const pin = e.kind === 'python-lib' ? `==${e.version}` : `@${e.sha.slice(0, 7)}`;
    const reviewed = isReviewed(e) ? `revisada ${e.review.fecha}` : 'SIN REVISAR';
    out(`  ${e.name.padEnd(24)} ${e.kind.padEnd(10)} ${pin.padEnd(12)} ${(e.license || '?').padEnd(10)} ${reviewed}`);
  }
  for (const s of own) out(`  ${s.name.padEnd(24)} propia`);
}

// --- show ------------------------------------------------------------------------

function listFiles(dir, base = dir) {
  const files = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name === '.git') continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) files.push(...listFiles(full, base));
    else files.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return files.sort();
}

function assertPinnedClone(entry) {
  const problem = cloneProblem(entry);
  if (problem) fail(`${problem}; ejecuta doctor`);
}

export function cmdShow({ positional, flags }) {
  const entry = findAnyEntry(loadPool(), assertName(positional[0]));
  if (!entry.own && !isReviewed(entry) && !flags.unreviewed) {
    fail(`"${entry.name}" no tiene revisión de seguridad; pasa --unreviewed para leerla igualmente`);
  }
  if (entry.kind === 'python-lib') {
    out(`${entry.name}==${entry.version} (python-lib, ${entry.license || 'licencia ?'}): se instala con uv add`);
    return;
  }
  if (!entry.own) assertPinnedClone(entry);
  const target = entryTarget(entry);
  const skillMd = path.join(target, 'SKILL.md');
  if (fs.existsSync(skillMd)) out(fs.readFileSync(skillMd, 'utf8'));
  out(`\n--- ficheros de ${entry.name} (${target}) ---`);
  for (const f of listFiles(target)) out(`  ${f}`);
}

// --- review ----------------------------------------------------------------------

export function cmdReview({ positional, flags }) {
  const pool = loadPool();
  const entry = findEntry(pool, assertName(positional[0]));
  if (!flags.notes) fail('--notes es obligatorio: resumen de la revisión de seguridad');
  if (CLONED_KINDS.includes(entry.kind)) assertPinnedClone(entry);
  const pinned = entry.kind === 'python-lib' ? entry.version : entry.sha;
  const updated = { ...entry, review: { fecha: flags.date || today(), sha: pinned, notas: flags.notes } };
  savePool(replaceEntry(pool, updated));
  out(`[skill-pool] revisión registrada: ${entry.name} @ ${String(pinned).slice(0, 12)}`);
}

// --- update ----------------------------------------------------------------------

function updatePythonLib(pool, entry, flags) {
  if (!flags.version) fail('python-lib: indica la versión nueva con --version <v>');
  const version = assertVersion(flags.version);
  out(`[skill-pool] ${entry.name}: ${entry.version} -> ${version}`);
  if (!flags.accept) {
    out('[skill-pool] revisa el changelog y repite con --accept para fijarla.');
    return;
  }
  savePool(replaceEntry(pool, { ...entry, version, review: null }));
  out('[skill-pool] fijada; review queda a null: hay que revisarla antes de enlazarla.');
}

export function cmdUpdate({ positional, flags }) {
  const pool = loadPool();
  const entry = findEntry(pool, assertName(positional[0]));
  if (entry.kind === 'python-lib') {
    updatePythonLib(pool, entry, flags);
    return;
  }
  const dir = cloneDir(entry);
  if (!headOf(dir)) fail(`no existe el clon de "${entry.name}": ${dir}`);
  const remote = fetchRemoteHead(dir, entry.ref);
  if (remote === entry.sha) {
    out(`[skill-pool] ${entry.name} está al día (${remote.slice(0, 12)}).`);
    return;
  }
  const { log, stat } = describeChange(dir, entry.sha, remote, entry.path);
  out(`[skill-pool] ${entry.name}: ${entry.sha.slice(0, 12)} -> ${remote.slice(0, 12)} (cambios en ${entry.path})`);
  out(log || '  (sin commits que toquen la subcarpeta)');
  out(stat || '  (sin diferencias en la subcarpeta)');
  if (!flags.accept) {
    out('[skill-pool] no se ha cambiado nada; revisa el diff y repite con --accept para re-fijar.');
    return;
  }
  const updated = { ...entry, sha: remote, review: null };
  cloneAt(entry.repo, cloneDir(updated), remote);
  savePool(replaceEntry(pool, updated));
  out(`[skill-pool] re-fijada en ${remote.slice(0, 12)} (${path.relative(REPOS_DIR, cloneDir(updated))}).`);
  out('[skill-pool] AVISO: review queda a null; hay que revisar el SHA nuevo antes de enlazarlo.');
  out(`[skill-pool] los proyectos siguen en el clon anterior hasta repetir link; después borra repos/${path.basename(dir)}.`);
}
