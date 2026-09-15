#!/usr/bin/env node
// package-cowork-plugin.mjs — empaqueta plugins/ultron-memory-cowork en el .zip
// que se sube desde Customize -> Plugins en la app de escritorio de Claude.
//
// El zip se escribe a mano (zero-dep, mismo criterio que los hooks) para
// controlar lo que el validador del servidor puede rechazar: separador "/",
// sin rutas absolutas ni segmentos "." / "..", entradas de directorio
// explicitas, atributos Unix (0644 / 0755), flag UTF-8, sin enlaces simbolicos
// ni zips anidados, y marca de tiempo fija para que el mismo arbol produzca el
// mismo zip byte a byte. Se regenera siempre desde la carpeta: un zip hecho a
// mano se queda viejo en cuanto cambia el manifiesto.
//
// Fuente unica de cada servidor/hook que el plugin reutiliza: sus ficheros
// canonicos en scripts/ y hooks/scripts/. Un plugin instalado no puede leer
// fuera de su propia carpeta (ver "Path traversal limitations" en la
// referencia de plugins), asi que server/ es SIEMPRE una copia. En vez de
// mantener a mano la lista de ficheros a copiar (se queda vieja en cuanto
// alguien anade o quita un require()), se resuelve el grafo real de
// imports/requires desde cada punto de entrada (resolveLocalClosure) y se
// sincroniza el cierre completo. El selftest falla si la copia commiteada
// difiere de la fuente o si algun require local no resuelve.
//
// Uso:    node scripts/package-cowork-plugin.mjs [--src <dir>] [--out <zip>]
// Prueba: node scripts/package-cowork-plugin.selftest.mjs

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SRC = join(REPO_ROOT, 'plugins', 'ultron-memory-cowork');
const DEFAULT_OUT = join(REPO_ROOT, 'plugins', 'ultron-memory-cowork.zip');

export const MANIFEST = '.claude-plugin/plugin.json';
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const VERSION_NEEDED = 20;
const MADE_BY_UNIX = (3 << 8) | VERSION_NEEDED;
const FLAG_UTF8 = 0x0800;
const DOS_DATE_1980_01_01 = (1 << 5) | 1;
const MODE_FILE = 0o100644;
const MODE_DIR = 0o040755;
const DOS_ATTR_DIR = 0x10;
// Un segmento con estos nombres no se puede extraer en Windows, con o sin extension.
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

// Rechaza cualquier nombre que un extractor pudiera resolver fuera de la raiz
// o interpretar de forma distinta segun el sistema.
export function validateEntryName(name) {
  if (typeof name !== 'string' || name === '') throw new Error('nombre de entrada vacio');
  if (name.includes('\\')) throw new Error(`ruta con backslash: ${name}`);
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new Error(`ruta absoluta: ${name}`);
  const segments = name.replace(/\/$/, '').split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`segmento vacio o relativo en la ruta: ${name}`);
  }
  if (segments.some((s) => WINDOWS_RESERVED_RE.test(s))) {
    throw new Error(`nombre reservado de Windows en la ruta: ${name}`);
  }
  if (/\.zip$/i.test(name)) throw new Error(`zip anidado: ${name}`);
  return name;
}

// Sobrescribe copyPath con canonicalPath si difieren. Devuelve true si escribio.
export function syncServerCopy(canonicalPath, copyPath) {
  const canonical = readFileSync(canonicalPath);
  if (existsSync(copyPath) && readFileSync(copyPath).equals(canonical)) return false;
  mkdirSync(dirname(copyPath), { recursive: true });
  writeFileSync(copyPath, canonical);
  return true;
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// Recorre srcDir en orden estable. Directorios con data === null.
export function collectEntries(srcDir) {
  const entries = [];
  const walk = (absDir, prefix) => {
    for (const item of readdirSync(absDir, { withFileTypes: true }).sort(byName)) {
      const name = prefix + item.name;
      if (item.isSymbolicLink()) throw new Error(`enlace simbolico no admitido: ${name}`);
      if (item.isDirectory()) {
        entries.push({ name: validateEntryName(`${name}/`), data: null });
        walk(join(absDir, item.name), `${name}/`);
      } else if (item.isFile()) {
        entries.push({ name: validateEntryName(name), data: readFileSync(join(absDir, item.name)) });
      }
    }
  };
  walk(srcDir, '');
  if (!entries.some((e) => e.name === MANIFEST)) {
    throw new Error(`falta ${MANIFEST} en la raiz de ${srcDir}`);
  }
  return entries;
}

function encodeEntry({ name, data }, offset) {
  validateEntryName(name);
  const nameBuf = Buffer.from(name, 'utf8');
  const isDir = data === null;
  if (isDir !== name.endsWith('/')) throw new Error(`tipo de entrada incoherente con el nombre: ${name}`);
  const raw = isDir ? Buffer.alloc(0) : data;
  const deflated = isDir ? raw : deflateRawSync(raw, { level: 9 });
  const useDeflate = !isDir && deflated.length < raw.length;
  const body = useDeflate ? deflated : raw;
  const method = useDeflate ? 8 : 0;
  const crc = isDir ? 0 : crc32(raw);
  const externalAttr = isDir ? ((MODE_DIR << 16) | DOS_ATTR_DIR) >>> 0 : (MODE_FILE << 16) >>> 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(SIG_LOCAL, 0);
  local.writeUInt16LE(VERSION_NEEDED, 4);
  local.writeUInt16LE(FLAG_UTF8, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(DOS_DATE_1980_01_01, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(SIG_CENTRAL, 0);
  central.writeUInt16LE(MADE_BY_UNIX, 4);
  central.writeUInt16LE(VERSION_NEEDED, 6);
  central.writeUInt16LE(FLAG_UTF8, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(DOS_DATE_1980_01_01, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(externalAttr, 38);
  central.writeUInt32LE(offset, 42);

  return {
    localPart: Buffer.concat([local, nameBuf, body]),
    centralPart: Buffer.concat([central, nameBuf]),
  };
}

export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const { localPart, centralPart } = encodeEntry(entry, offset);
    locals.push(localPart);
    centrals.push(centralPart);
    offset += localPart.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDir, eocd]);
}

// Lee el directorio central; lo usan el selftest y la verificacion posterior.
export function listZipEntries(zip) {
  let eocdAt = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === SIG_EOCD) { eocdAt = i; break; }
  }
  if (eocdAt < 0) throw new Error('zip sin registro de fin de directorio central');
  const total = zip.readUInt16LE(eocdAt + 10);
  let p = zip.readUInt32LE(eocdAt + 16);
  const entries = [];
  for (let n = 0; n < total; n++) {
    if (zip.readUInt32LE(p) !== SIG_CENTRAL) throw new Error(`directorio central corrupto en ${p}`);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    entries.push({
      name: zip.toString('utf8', p + 46, p + 46 + nameLen),
      madeBy: zip.readUInt16LE(p + 4),
      flags: zip.readUInt16LE(p + 8),
      method: zip.readUInt16LE(p + 10),
      crc: zip.readUInt32LE(p + 16),
      compressedSize: zip.readUInt32LE(p + 20),
      size: zip.readUInt32LE(p + 24),
      externalAttr: zip.readUInt32LE(p + 38),
      localOffset: zip.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Sincronizacion desde las fuentes canonicas (scripts/ y hooks/scripts/)
// ---------------------------------------------------------------------------

// Grupos a sincronizar: cada uno tiene una raiz canonica en el repo, los
// puntos de entrada (rutas relativas a esa raiz) y el prefijo bajo el que se
// copian dentro del plugin. El resto del arbol de cada grupo lo determina
// resolveLocalClosure() siguiendo los require()/import reales.
export const SYNC_GROUPS = [
  {
    id: 'memory-mcp',
    // scripts/mcp-memory-server.mjs: el mismo servidor MCP que usa Claude
    // Code por CLI (incluye curso_status -> scripts/lib/curso.mjs). Los datos
    // que lee (cockpit/curso.json) NO se empaquetan: se leen en runtime desde
    // la maquina donde corre el plugin.
    root: join(REPO_ROOT, 'scripts'),
    entries: ['mcp-memory-server.mjs'],
    destPrefix: 'server',
  },
  {
    id: 'research-and-hooks',
    // research-mcp.js (buscador de papers) + los 3 hooks minimos: resume de
    // memoria al abrir, gate socratico por prompt y captura de memoria al
    // cerrar. Deliberadamente NO se incluye memory-orchestrate.js (prefetch
    // por prompt: descartado por meter ruido) ni el resto de hooks del
    // sistema completo (kanban, codegraph, etc. no tienen sentido en Cowork).
    root: join(REPO_ROOT, 'hooks', 'scripts'),
    entries: ['research-mcp.js', 'socratic-gate.js', 'memory-session-resume.js', 'session-end-summary.js'],
    destPrefix: 'server/hooks-scripts',
  },
];

function toPosix(p) {
  return p.split(sep).join('/');
}

function resolveModulePath(candidate) {
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  if (existsSync(`${candidate}.js`)) return `${candidate}.js`;
  if (existsSync(`${candidate}.mjs`)) return `${candidate}.mjs`;
  if (existsSync(join(candidate, 'index.js'))) return join(candidate, 'index.js');
  return null;
}

// Extrae los targets locales (relativos) de require()/import de un fuente:
// require('./x'), import ... from '../x', y require(path.join(__dirname|'..'|'.', ...)).
export function extractLocalTargets(src) {
  const targets = [];
  const reReqLit = /require\(\s*(['"])(\.\.?\/[^'"]*)\1\s*\)/g;
  let m;
  while ((m = reReqLit.exec(src))) targets.push(m[2]);
  const reImportLit = /\bimport\s+(?:[^'";]+\s+from\s+)?(['"])(\.\.?\/[^'"]*)\1/g;
  while ((m = reImportLit.exec(src))) targets.push(m[2]);
  const reJoin = /require\(\s*path\.join\(([^)]*)\)\s*\)/g;
  while ((m = reJoin.exec(src))) {
    const args = m[1].split(',').map((s) => s.trim());
    const parts = [];
    let hasDirname = false;
    let ok = true;
    for (const a of args) {
      if (a === '__dirname') { hasDirname = true; continue; }
      const lit = a.match(/^(['"])(.*)\1$/);
      if (lit) { parts.push(lit[2]); continue; }
      ok = false; // argumento dinamico: no se puede resolver de forma estatica
    }
    if (ok && (hasDirname || parts[0] === '.' || parts[0] === '..')) targets.push(parts.join('/'));
  }
  return targets;
}

// Recorre el grafo real de requires/imports locales desde `entries` (rutas
// relativas a `root`). Devuelve las rutas relativas POSIX del cierre
// completo, entries incluidas, en orden estable. Lanza si algun require local
// no resuelve: mejor romper el empaquetado que enviar un plugin con un
// require roto.
export function resolveLocalClosure(root, entries) {
  const visited = new Set();
  const stack = entries.map((e) => resolve(join(root, e)));
  while (stack.length) {
    const file = stack.pop();
    if (visited.has(file)) continue;
    if (!existsSync(file)) throw new Error(`punto de entrada no existe: ${file}`);
    visited.add(file);
    const src = readFileSync(file, 'utf8');
    const dir = dirname(file);
    for (const target of extractLocalTargets(src)) {
      const resolved = resolveModulePath(join(dir, target));
      if (!resolved) throw new Error(`require local sin resolver: "${target}" en ${file}`);
      stack.push(resolved);
    }
  }
  return [...visited].map((f) => toPosix(relative(root, f))).sort();
}

// Borra de destRoot cualquier fichero que ya no este en keepRel (el grupo
// dejo de necesitarlo), y las carpetas que quedan vacias tras el borrado.
// excludeRel son subrutas (relativas a destRoot, sin barra final) que NO se
// tocan: el destPrefix de otro grupo puede colgar dentro de este destRoot
// (p.ej. 'hooks-scripts' cuelga de 'server'), y ese subarbol lo gestiona su
// propio pruneOrphans, no este.
function pruneOrphans(destRoot, keepRel, excludeRel = new Set()) {
  if (!existsSync(destRoot)) return 0;
  let removed = 0;
  const walk = (dir, prefix) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix + item.name;
      const abs = join(dir, item.name);
      if (excludeRel.has(rel)) continue;
      if (item.isDirectory()) {
        walk(abs, `${rel}/`);
        if (existsSync(abs) && readdirSync(abs).length === 0) rmSync(abs, { recursive: true, force: true });
        continue;
      }
      if (!keepRel.has(rel)) {
        rmSync(abs, { force: true });
        removed++;
      }
    }
  };
  walk(destRoot, '');
  return removed;
}

// Sincroniza todos los SYNC_GROUPS dentro de pluginDir: copia lo que cambio,
// borra lo que sobra. Devuelve cuantos ficheros se tocaron (copiados o
// borrados) y, por grupo, el cierre resuelto (lo usa el selftest para el
// check de paridad).
export function syncManagedServers(pluginDir, groups = SYNC_GROUPS) {
  let changed = 0;
  const resolved = [];
  for (const group of groups) {
    const rels = resolveLocalClosure(group.root, group.entries);
    resolved.push({ group, rels });
    const destRoot = join(pluginDir, ...group.destPrefix.split('/'));
    for (const rel of rels) {
      const canonical = join(group.root, ...rel.split('/'));
      const copy = join(destRoot, ...rel.split('/'));
      if (syncServerCopy(canonical, copy)) changed++;
    }
    const exclude = new Set();
    for (const other of groups) {
      if (other === group) continue;
      if (other.destPrefix.startsWith(`${group.destPrefix}/`)) {
        exclude.add(other.destPrefix.slice(group.destPrefix.length + 1));
      }
    }
    changed += pruneOrphans(destRoot, new Set(rels), exclude);
  }
  return { changed, resolved };
}

function parseArgs(argv) {
  const args = { src: DEFAULT_SRC, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== '--src' && flag !== '--out') throw new Error(`argumento desconocido: ${flag}`);
    const value = argv[++i];
    if (!value) throw new Error(`falta el valor de ${flag}`);
    args[flag.slice(2)] = resolve(value);
  }
  return args;
}

function main() {
  const { src, out } = parseArgs(process.argv.slice(2));
  if (!existsSync(src)) throw new Error(`no existe la carpeta del plugin: ${src}`);
  if (src === DEFAULT_SRC) {
    const { changed } = syncManagedServers(src);
    if (changed) process.stdout.write(`${changed} fichero(s) de server/ sincronizados desde scripts/ y hooks/scripts/\n`);
  }
  const entries = collectEntries(src);
  const zip = buildZip(entries);
  writeFileSync(out, zip);
  const files = entries.filter((e) => e.data !== null).length;
  process.stdout.write(`${out}: ${files} ficheros, ${entries.length - files} directorios, ${zip.length} bytes\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`package-cowork-plugin: ${err.message}\n`);
    process.exit(1);
  }
}
