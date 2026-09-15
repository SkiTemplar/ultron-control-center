'use strict';
/**
 * lib/codegraph-summary.js — resumen del indice CodeGraph para el resume de
 * SessionStart (ULTRON 4, F8.1; pilar 2 "inyectado al contexto, no solo el CLI").
 *
 * Medido el 2026-09-04: 7 llamadas a codegraph en 7 dias, todas en ULTRON, 0 en
 * los otros 8 proyectos, con 1.898 disparos del reminder. El nudge no se
 * consumia; el resumen entra en el contexto desde el primer turno: tamano del
 * indice, lenguajes, zonas con mas simbolos y los simbolos usados desde mas
 * ficheros (hubs), con la instruccion de consultar el grafo antes de leer.
 *
 * Lee `.codegraph/codegraph.db` (SQLite del MCP colbymchenry/codegraph) en solo
 * lectura con node:sqlite y cachea el resultado en `.codegraph/ultron-summary.json`
 * (clave: mtime del .db/.db-wal; TTL 10 min). Sin indice o sin node:sqlite:
 * null, y el resume no dice nada (ensure-codegraph ya avisa de eso).
 */

const fs = require('fs');
const path = require('path');

const DB_REL = path.join('.codegraph', 'codegraph.db');
const CACHE_REL = path.join('.codegraph', 'ultron-summary.json');
const CACHE_TTL_MS = 10 * 60 * 1000;
const TOP_DIRS = 5;
const TOP_HUBS = 6;
const MAX_LANGS = 4;
// Kinds que cuentan como "simbolo de dominio" para los hubs (fuera: import,
// file, variable, property, constant...).
const HUB_KINDS = ['function', 'method', 'struct', 'class', 'interface', 'enum', 'trait', 'type_alias'];
// Nombres genericos que dominan el fan-in por ser de la libreria estandar o
// helpers triviales: no dicen nada de la arquitectura del proyecto.
const HUB_STOPLIST = new Set([
  'ok', 'err', 'some', 'none', 'clone', 'collect', 'unwrap', 'map', 'get', 'set', 'new', 'from', 'into',
  'push', 'len', 'format', 'println', 'print', 'log', 'to_string', 'as_ref', 'iter', 'join', 'split',
  'trim', 'parse', 'stringify', 'require', 'default', 'main', 'run', 'a', 'ko', 'assert', 'expect',
  'test', 'it', 'describe', 'read', 'write', 'open', 'close', 'path', 'name', 'id', 'value', 'data',
  'as_str', 'from_str', 'to_str', 'to_owned', 'to_vec', 'borrow', 'deref', 'fmt', 'eq', 'hash', 'cmp',
  'toString', 'valueOf', 'then', 'catch', 'call', 'apply', 'bind',
]);
const EDGE_KINDS = ['calls', 'references', 'instantiates', 'implements'];
// Un indice desmesurado (p. ej. el home entero: 14 GB medidos el 2026-09-04)
// no se resume: las agregaciones tardarian segundos en un hook de arranque.
const MAX_DB_BYTES = Number(process.env.CODEGRAPH_SUMMARY_MAX_DB_BYTES) > 0
  ? Number(process.env.CODEGRAPH_SUMMARY_MAX_DB_BYTES)
  : 512 * 1024 * 1024;

function loadSqlite() {
  try {
    // eslint-disable-next-line global-require
    return require('node:sqlite').DatabaseSync;
  } catch (_) {
    return null;
  }
}

function mtimeOf(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch (_) {
    return 0;
  }
}

// Raiz del indice: el cwd o, como maximo, dos niveles por encima (sesion
// abierta en una subcarpeta del proyecto).
function findIndexRoot(cwd) {
  let dir = cwd ? path.resolve(cwd) : '';
  for (let i = 0; i < 3 && dir; i++) {
    if (fs.existsSync(path.join(dir, DB_REL))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function topDir(filePath) {
  const parts = String(filePath || '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 1) return parts[0] ? '(raiz)' : '';
  return parts.slice(0, 2).join('/');
}

function human(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '').replace('.', ',')}k`;
  return String(n);
}

function querySummary(DatabaseSync, dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const files = db.prepare('SELECT COUNT(*) AS c FROM files').get().c;
    const nodes = db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE kind <> 'file'").get().c;
    const edges = db.prepare('SELECT COUNT(*) AS c FROM edges').get().c;
    const languages = db
      .prepare('SELECT language, SUM(node_count) AS n FROM files GROUP BY language ORDER BY n DESC LIMIT ?')
      .all(MAX_LANGS)
      .filter((r) => r.n > 0)
      .map((r) => ({ language: r.language, symbols: r.n }));
    const dirs = new Map();
    for (const r of db.prepare('SELECT path, node_count FROM files WHERE node_count > 0').all()) {
      const d = topDir(r.path);
      if (!d) continue;
      dirs.set(d, (dirs.get(d) || 0) + r.node_count);
    }
    const zones = Array.from(dirs.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_DIRS)
      .map(([dir, symbols]) => ({ dir, symbols }));
    const kindList = HUB_KINDS.map((k) => `'${k}'`).join(',');
    const edgeList = EDGE_KINDS.map((k) => `'${k}'`).join(',');
    const raw = db
      .prepare(
        `SELECT t.name AS name, t.kind AS kind, t.file_path AS file_path, ` +
        `COUNT(DISTINCT s.file_path) AS files, COUNT(*) AS refs ` +
        `FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target ` +
        `WHERE e.kind IN (${edgeList}) AND t.kind IN (${kindList}) AND s.file_path <> t.file_path ` +
        `GROUP BY e.target ORDER BY files DESC, refs DESC LIMIT ?`,
      )
      .all(TOP_HUBS * 4);
    const hubs = raw
      .filter((h) => h.name && h.name.length > 2 && !HUB_STOPLIST.has(String(h.name).toLowerCase()))
      .slice(0, TOP_HUBS)
      .map((h) => ({ name: h.name, kind: h.kind, file: String(h.file_path).replace(/\\/g, '/'), files: h.files, refs: h.refs }));
    return { files, symbols: nodes, edges, languages, zones, hubs };
  } finally {
    try { db.close(); } catch (_) { /* nada */ }
  }
}

// Resumen del indice del proyecto en `cwd` (cacheado) o null.
function summarize(cwd) {
  const root = findIndexRoot(cwd);
  if (!root) return null;
  const dbPath = path.join(root, DB_REL);
  const cachePath = path.join(root, CACHE_REL);
  try {
    if (fs.statSync(dbPath).size > MAX_DB_BYTES) return null;
  } catch (_) {
    return null;
  }
  const dbStamp = Math.max(mtimeOf(dbPath), mtimeOf(dbPath + '-wal'));
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (cached && cached.db_stamp === dbStamp && Date.now() - Date.parse(cached.generated_at) < CACHE_TTL_MS) {
      return { ...cached, from_cache: true };
    }
  } catch (_) {
    // sin cache valida
  }
  const DatabaseSync = loadSqlite();
  if (!DatabaseSync) return null;
  let summary;
  try {
    summary = querySummary(DatabaseSync, dbPath);
  } catch (_) {
    return null;
  }
  const doc = { ...summary, root, db_stamp: dbStamp, generated_at: new Date().toISOString() };
  try {
    fs.writeFileSync(cachePath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  } catch (_) {
    // cache best-effort
  }
  return { ...doc, from_cache: false };
}

// Lineas para el resume ([] sin indice).
function renderLines(summary) {
  if (!summary || !summary.symbols) return [];
  const langs = (summary.languages || []).map((l) => `${l.language} ${human(l.symbols)}`).join(', ');
  const out = [
    `codegraph (indice .codegraph: ${human(summary.files)} ficheros, ${human(summary.symbols)} simbolos, ` +
    `${human(summary.edges)} aristas${langs ? `; ${langs}` : ''}):`,
  ];
  if (summary.zones && summary.zones.length) {
    out.push(`  zonas: ${summary.zones.map((z) => `${z.dir} (${human(z.symbols)})`).join(' · ')}`);
  }
  if (summary.hubs && summary.hubs.length) {
    out.push(`  hubs (usados desde mas ficheros): ${summary.hubs.map((h) => `${h.name} [${h.kind}, ${h.files} fich.]`).join(' · ')}`);
  }
  out.push(
    '  usa codegraph_explore / codegraph_search ANTES de leer ficheros a ciegas; codegraph_impact antes de un refactor multi-fichero ' +
    '(tools mcp__codegraph__*, cargar con ToolSearch si estan deferred).',
  );
  return out;
}

module.exports = {
  DB_REL,
  CACHE_REL,
  CACHE_TTL_MS,
  MAX_DB_BYTES,
  HUB_STOPLIST,
  findIndexRoot,
  topDir,
  human,
  summarize,
  renderLines,
};
