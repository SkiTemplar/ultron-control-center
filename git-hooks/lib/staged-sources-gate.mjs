#!/usr/bin/env node
// staged-sources-gate.mjs: ningun commit puede referenciar fuente que no entra con el.
//
// Los gates locales miran el disco y no git: `cargo fmt --check` y `run-selftests
// --check` encuentran un `mod x;` o un selftest sin seguimiento y dan verde, y el
// commit rompe CI. Este gate lee el indice, que es lo que se va a commitear, y falla si:
//   - un fuente del indice referencia otro (`mod x;`, include_str!, #[path], imports
//     relativos, require) que esta en disco sin seguimiento;
//   - un Cargo.toml del indice apunta con `path =` a algo que no esta en el indice
//     (`[patch]` a vendor/, dependencias locales, `[[bin]]`, `[lib]`);
//   - scripts/selftests.manifest.json cita un fichero fuera del indice o el indice
//     lleva un selftest sin clasificar (run-selftests --ci falla por las dos cosas).
//
// Limites declarados: un destino ausente del indice y del disco no se marca (un `mod`
// dentro de un bloque `mod a { }` o de un cfg de un modulo ignorado no se resuelve aqui)
// y un destino ignorado por .gitignore tampoco (Finance es local a proposito). Lo de
// fuera del alcance de este analisis lo sigue cazando la compilacion del CI.
//
// Uso:
//   node git-hooks/lib/staged-sources-gate.mjs             indice (lo usa pre-commit)
//   node git-hooks/lib/staged-sources-gate.mjs --worktree  arbol de trabajo: lista lo
//                                                          que falta por anadir (check 10.7)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { rustRefTargets, tsImportTargets } from '../../scripts/kirkardo/predicates-r3.mjs';
import { isSelftest } from '../../scripts/run-selftests.mjs';

const MANIFEST = 'scripts/selftests.manifest.json';
// Terceros y datos de prueba: sus referencias no son codigo propio.
const SKIP_PREFIXES = ['control-center/src-tauri/vendor/', 'scripts/fixtures/', 'templates/', 'desktop/windhawk/'];
const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.json'];
const REQUIRE_RE = /\brequire\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;

function git(root, args, input) {
  const r = spawnSync('git', args, { cwd: root, input, maxBuffer: 1024 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    throw new Error(`git ${args[0]} fallo: ${r.error ? r.error.message : String(r.stderr)}`);
  }
  return r.stdout;
}

const gitList = (root, args) => git(root, [...args, '-z']).toString('utf8').split('\0').filter(Boolean);

/** Contenido en el indice de cada ruta (Map ruta -> texto), con una sola llamada a git. */
function readIndexed(root, paths) {
  const out = new Map();
  if (paths.length === 0) return out;
  const buf = git(root, ['cat-file', '--batch'], paths.map((p) => `:${p}`).join('\n') + '\n');
  let pos = 0;
  for (const p of paths) {
    const eol = buf.indexOf(0x0a, pos);
    const header = buf.subarray(pos, eol).toString('utf8');
    const size = Number(header.split(' ')[2]);
    if (!Number.isFinite(size)) throw new Error(`git cat-file sin contenido para ${p}: ${header}`);
    out.set(p, buf.subarray(eol + 1, eol + 1 + size).toString('utf8'));
    pos = eol + 1 + size + 1;
  }
  return out;
}

function readWorktree(root, paths) {
  const present = paths.filter((p) => fs.existsSync(path.join(root, p)));
  return new Map(present.map((p) => [p, fs.readFileSync(path.join(root, p), 'utf8')]));
}

/** Destinos de un fuente Rust: cada elemento es la lista de alternativas de esa referencia. */
function rustTargets(rel, text) {
  const dir = path.posix.dirname(rel);
  const base = path.posix.basename(rel, '.rs');
  const modRoot = ['mod', 'lib', 'main'].includes(base) ? dir : path.posix.join(dir, base);
  return rustRefTargets(text).map((t) => (t.kind === 'mod'
    ? [path.posix.join(modRoot, `${t.target}.rs`), path.posix.join(modRoot, t.target, 'mod.rs')]
    : [path.posix.normalize(path.posix.join(dir, t.target))]));
}

function jsCandidates(rel, target) {
  const p = path.posix.normalize(path.posix.join(path.posix.dirname(rel), target));
  if (path.posix.extname(p)) return [p];
  return [...JS_EXTENSIONS.map((e) => `${p}${e}`), ...JS_EXTENSIONS.map((e) => `${p}/index${e}`)];
}

function jsTargets(rel, text) {
  const required = [...text.matchAll(REQUIRE_RE)].map((m) => m[1]);
  return [...tsImportTargets(text), ...required].map((t) => jsCandidates(rel, t));
}

function targetsOf(rel, text) {
  if (rel.endsWith('.rs')) return rustTargets(rel, text);
  return jsTargets(rel, text);
}

/** Rutas `path =` de un Cargo.toml: dependencias y parches son carpetas; bin y lib, ficheros. */
export function cargoPathRefs(rel, text) {
  const dir = path.posix.dirname(rel);
  const refs = [];
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[{1,2}([^\]]+)\]{1,2}/.exec(line);
    if (header) section = header[1].trim();
    const m = /(?:^|[\s{,])path\s*=\s*"([^"]+)"/.exec(line.replace(/#.*$/, ''));
    if (!m) continue;
    const target = path.posix.normalize(path.posix.join(dir, m[1]));
    const isDependency = section.startsWith('patch') || section.includes('dependencies');
    refs.push(isDependency ? path.posix.join(target, 'Cargo.toml') : target);
  }
  return refs;
}

function manifestGaps(tracked, read) {
  if (!tracked.has(MANIFEST)) return [];
  const text = read([MANIFEST]).get(MANIFEST);
  if (text === undefined) return [];
  const tests = JSON.parse(text).tests || {};
  const missing = Object.keys(tests).filter((f) => !tracked.has(f))
    .map((f) => `${MANIFEST} cita ${f}, que no esta en el indice`);
  const scanned = [...tracked].filter((f) => /^(hooks|scripts|cockpit\/skill-lazy)\//.test(f) && isSelftest(f));
  const unclassified = scanned.filter((f) => !(f in tests))
    .map((f) => `${f} esta en el indice sin clasificar en ${MANIFEST}`);
  return [...missing, ...unclassified];
}

/**
 * Huecos del commit (array de textos; vacio = verde).
 * worktree=true lee los fuentes del disco en vez del indice: dice que falta por anadir.
 */
export function findGaps(root, { worktree = false } = {}) {
  const tracked = new Set(gitList(root, ['ls-files']));
  const untracked = new Set(gitList(root, ['ls-files', '--others', '--exclude-standard']));
  const read = (paths) => (worktree ? readWorktree(root, paths) : readIndexed(root, paths));
  const isScanned = (f) => /\.(rs|ts|tsx|js|mjs)$/.test(f) && !SKIP_PREFIXES.some((p) => f.startsWith(p));
  const gaps = new Set();
  for (const [rel, text] of read([...tracked].filter(isScanned))) {
    for (const alternatives of targetsOf(rel, text)) {
      if (alternatives.some((t) => tracked.has(t))) continue;
      const pending = alternatives.find((t) => untracked.has(t));
      if (pending) gaps.add(`${pending} (sin seguimiento), referenciado por ${rel}`);
    }
  }
  const cargoFiles = [...tracked].filter((f) => path.posix.basename(f) === 'Cargo.toml' && !SKIP_PREFIXES.some((p) => f.startsWith(p)));
  for (const [rel, text] of read(cargoFiles)) {
    for (const target of cargoPathRefs(rel, text)) {
      if (!tracked.has(target)) gaps.add(`${target} no esta en el indice y ${rel} lo necesita (path =)`);
    }
  }
  for (const gap of manifestGaps(tracked, read)) gaps.add(gap);
  return [...gaps].sort();
}

function main() {
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  const worktree = process.argv.includes('--worktree');
  const gaps = findGaps(root, { worktree });
  if (gaps.length === 0) return 0;
  console.error(`[staged-sources-gate] ${gaps.length} referencia(s) sin versionar:`);
  for (const gap of gaps) console.error(`  - ${gap}`);
  console.error('Anade esos ficheros al commit o quita la referencia: CI no compilaria este estado.');
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`[staged-sources-gate] no se pudo evaluar: ${e.message}`);
    process.exitCode = 2;
  }
}
