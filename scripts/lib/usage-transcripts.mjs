// usage-transcripts.mjs — uso de Claude Code por proyecto a partir de los
// transcripts locales (~/.claude/projects/<cwd codificado>/**/*.jsonl).
//
// Por que propio y no ccusage: ccusage no conoce el precio de Sonnet 5.5 (lo
// cuenta a 0 $) y vive en una cache temporal de npx. Aqui se replica su regla
// de coste (contrastada con ccusage el 2026-09-28: Opus 5, Opus 4.7 y Sonnet 5
// coinciden al centimo) y se anade lo que ccusage no da: reparto sesion
// principal / subagentes y contexto medio por llamada.
//
// Coste NOCIONAL: precio de la API por token. Con suscripcion no es lo que se
// factura, pero sirve para comparar proyectos, modelos y subagentes.
//
// Rendimiento: cada .jsonl se agrega una vez y se guarda en una cache por
// fichero (tamano + mtime); las llamadas siguientes solo releen lo que cambio.
//
// Overrides (tests): ULTRON_CLAUDE_PROJECTS_DIR, ULTRON_USAGE_CACHE_DIR,
// ULTRON_PROJECTS_JSON_OVERRIDE.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** $/MTok por modelo: [entrada, salida, lectura de cache]. Escritura: 1,25x (5 min) o 2x (1 h) la entrada. */
export const PRICES = {
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25, 0.5],
  'claude-opus-4-8': [5, 25, 0.5],
  'claude-opus-4-7': [5, 25, 0.5],
  'claude-opus-4-6': [5, 25, 0.5],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-sonnet-5': [2, 10, 0.2],
  'claude-sonnet-4-6': [3, 15, 0.3],
  'claude-fable-5-1': [10, 50, 0.25],
  'claude-fable-5': [10, 50, 0.25],
  'claude-haiku-4-5': [1, 5, 0.1],
};

const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const CACHE_VERSION = 2; // v2 (2026-09-28): las filas llevan la hora local

/** Quita el sufijo de fecha (`-20251001`) para buscar en la tabla. */
export function normalizeModel(model) {
  return String(model || '').replace(/-\d{8}$/, '');
}

/** Coste en USD de una fila de tokens, o null si el modelo no tiene precio. */
export function costOf(model, t) {
  const p = PRICES[normalizeModel(model)];
  if (!p) return null;
  const [pin, pout, pread] = p;
  return (
    (t.input * pin + t.output * pout + t.cacheRead * pread + t.cacheWrite5m * pin * CACHE_WRITE_5M + t.cacheWrite1h * pin * CACHE_WRITE_1H) / 1e6
  );
}

/** Nombre de carpeta que usa Claude Code para un cwd: todo lo no alfanumerico pasa a "-". */
export function encodeProjectDir(projectPath) {
  return String(projectPath).replace(/[^A-Za-z0-9]/g, '-');
}

const claudeProjectsDir = () =>
  process.env.ULTRON_CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const cacheDir = () =>
  process.env.ULTRON_USAGE_CACHE_DIR || path.join(os.homedir(), '.ultron', 'run', 'usage-cache');
const registryFile = () =>
  process.env.ULTRON_PROJECTS_JSON_OVERRIDE || path.join(os.homedir(), '.ultron', 'cockpit', 'projects.json');

/** Proyectos registrados: [{id, name, path}]. Tolera lista, {projects: []} o mapa id -> entrada. */
export function loadProjects(file = registryFile()) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : Array.isArray(raw.projects) ? raw.projects : Object.values(raw);
  return list
    .filter((p) => p && typeof p === 'object' && p.id && p.path)
    .map((p) => ({ id: String(p.id), name: String(p.name || p.id), path: String(p.path) }));
}

/** Dueno de una carpeta de transcripts: el proyecto registrado con el prefijo mas largo. */
export function ownerOfDir(dirName, projects) {
  let best = null;
  for (const p of projects) {
    const enc = encodeProjectDir(p.path);
    if (dirName === enc || dirName.startsWith(`${enc}-`)) {
      if (!best || enc.length > best.encLen) best = { id: p.id, encLen: enc.length };
    }
  }
  return best ? best.id : null;
}

function localDay(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const localHour = (ms) => String(new Date(ms).getHours()).padStart(2, '0');

function* walkJsonl(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(full);
    else if (e.name.endsWith('.jsonl')) yield full;
  }
}

/**
 * Agrega un .jsonl en filas por (dia local, hora local, modelo, origen). Un mensaje del
 * asistente aparece en varias lineas (una por bloque): se deduplica por id.
 */
export function aggregateFile(file, isSub) {
  const seen = new Map();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { rows: {}, first: null, last: null };
  }
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const m = o.message;
    if (!m || !m.usage || !m.model || m.model === '<synthetic>' || !o.timestamp) continue;
    const ts = Date.parse(o.timestamp);
    if (Number.isNaN(ts)) continue;
    const id = m.id || o.uuid;
    const prev = seen.get(id);
    if (!prev || (m.usage.output_tokens || 0) >= (prev.u.output_tokens || 0)) seen.set(id, { u: m.usage, model: m.model, ts });
  }
  const rows = {};
  let first = null;
  let last = null;
  for (const { u, model, ts } of seen.values()) {
    const cc = u.cache_creation;
    const total = u.cache_creation_input_tokens || 0;
    const w1h = cc ? cc.ephemeral_1h_input_tokens || 0 : 0;
    const w5m = cc ? cc.ephemeral_5m_input_tokens || 0 : total;
    const key = `${localDay(ts)}|${localHour(ts)}|${normalizeModel(model)}|${isSub ? 'sub' : 'main'}`;
    const r = (rows[key] ||= [0, 0, 0, 0, 0, 0]); // n, in, out, cacheRead, write5m, write1h
    r[0] += 1;
    r[1] += u.input_tokens || 0;
    r[2] += u.output_tokens || 0;
    r[3] += u.cache_read_input_tokens || 0;
    r[4] += w5m;
    r[5] += w1h;
    if (first === null || ts < first) first = ts;
    if (last === null || ts > last) last = ts;
  }
  return { rows, first, last };
}

function loadCache(dirName) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(cacheDir(), `${dirName}.json`), 'utf8'));
    return c && c.v === CACHE_VERSION ? c : { v: CACHE_VERSION, files: {} };
  } catch {
    return { v: CACHE_VERSION, files: {} };
  }
}

function saveCache(dirName, cache) {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const p = path.join(cacheDir(), `${dirName}.json`);
    fs.writeFileSync(`${p}.tmp`, JSON.stringify(cache));
    fs.renameSync(`${p}.tmp`, p);
  } catch {
    /* la cache es best-effort: sin ella se reagrega todo */
  }
}

/** Filas agregadas de una carpeta de transcripts, releyendo solo los ficheros nuevos o cambiados. */
export function aggregateDir(dirName) {
  const root = path.join(claudeProjectsDir(), dirName);
  const cache = loadCache(dirName);
  const alive = new Set();
  let dirty = false;
  const out = [];
  for (const file of walkJsonl(root)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    alive.add(rel);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    let entry = cache.files[rel];
    if (!entry || entry.size !== st.size || entry.mtimeMs !== st.mtimeMs) {
      const isSub = rel.split('/').includes('subagents');
      const agg = aggregateFile(file, isSub);
      entry = { size: st.size, mtimeMs: st.mtimeMs, isSub, main: !isSub && !rel.includes('/'), ...agg };
      cache.files[rel] = entry;
      dirty = true;
    }
    out.push(entry);
  }
  for (const rel of Object.keys(cache.files)) {
    if (!alive.has(rel)) {
      delete cache.files[rel];
      dirty = true;
    }
  }
  if (dirty) saveCache(dirName, cache);
  return out;
}

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

/**
 * Resumen de uso de un proyecto en los ultimos `days` dias (hoy incluido).
 * @param {string} projectId
 * @param {{days?: number, now?: number}} [opts]
 */
export function projectUsage(projectId, { days = 30, now = Date.now() } = {}) {
  const projects = loadProjects();
  const project = projects.find((p) => p.id === projectId);
  if (!project) return { ok: false, error: { code: 'PROJECT_NOT_FOUND', message: `proyecto no registrado: ${projectId}` } };

  const root = claudeProjectsDir();
  let dirNames = [];
  try {
    dirNames = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    /* sin ~/.claude/projects */
  }
  const dirs = dirNames.filter((d) => ownerOfDir(d, projects) === projectId);

  const from = localDay(now - (days - 1) * 86400000);
  const to = localDay(now);
  const dayList = [];
  for (let i = days - 1; i >= 0; i -= 1) dayList.push(localDay(now - i * 86400000));

  const byDay = Object.fromEntries(dayList.map((d) => [d, { costUsd: 0, messages: 0 }]));
  const byModel = {};
  const bySource = { main: { ...emptyTokens(), messages: 0, costUsd: 0 }, sub: { ...emptyTokens(), messages: 0, costUsd: 0 } };
  const unpriced = new Set();
  let sessions = 0;

  for (const dirName of dirs) {
    for (const f of aggregateDir(dirName)) {
      if (f.main && f.first !== null && localDay(f.last) >= from && localDay(f.first) <= to) sessions += 1;
      for (const [key, r] of Object.entries(f.rows)) {
        const [day, , model, src] = key.split('|');
        if (day < from || day > to) continue;
        const t = { input: r[1], output: r[2], cacheRead: r[3], cacheWrite5m: r[4], cacheWrite1h: r[5] };
        const cost = costOf(model, t);
        if (cost === null) unpriced.add(model);
        const c = cost || 0;
        byDay[day].costUsd += c;
        byDay[day].messages += r[0];
        const m = (byModel[model] ||= { model, messages: 0, costUsd: 0, priced: cost !== null });
        m.messages += r[0];
        m.costUsd += c;
        const s = bySource[src];
        s.messages += r[0];
        s.costUsd += c;
        for (const k of Object.keys(t)) s[k] += t[k];
      }
    }
  }

  const finish = (s) => ({
    messages: s.messages,
    costUsd: s.costUsd,
    outputTokens: s.output,
    cacheReadTokens: s.cacheRead,
    // Contexto medio que cada llamada reenvia: lo que mas pesa en el coste.
    avgContextTokens: s.messages ? Math.round((s.input + s.cacheRead + s.cacheWrite5m + s.cacheWrite1h) / s.messages) : 0,
  });
  const totalCost = bySource.main.costUsd + bySource.sub.costUsd;
  const models = Object.values(byModel)
    .sort((a, b) => b.costUsd - a.costUsd)
    .map((m) => ({ ...m, sharePct: totalCost > 0 ? (m.costUsd / totalCost) * 100 : 0 }));

  const notes = [];
  if (dirs.length === 0) notes.push('Sin sesiones de Claude Code registradas para la ruta de este proyecto.');
  if (unpriced.size) notes.push(`Sin precio conocido (cuentan a 0 $): ${[...unpriced].join(', ')}.`);
  notes.push('Coste nocional a precio de API por token; con suscripcion no es lo que se factura.');

  return {
    ok: true,
    projectId,
    projectName: project.name,
    days,
    window: { from, to },
    dirs: dirs.length,
    totals: {
      costUsd: totalCost,
      messages: bySource.main.messages + bySource.sub.messages,
      sessions,
    },
    byDay: dayList.map((d) => ({ day: d, ...byDay[d] })),
    byModel: models,
    bySource: { main: finish(bySource.main), sub: finish(bySource.sub) },
    unpricedModels: [...unpriced],
    notes,
  };
}

/**
 * Coste nocional por (dia de la semana, hora local) de TODOS los proyectos, en las
 * `weeks` semanas completas anteriores a hoy. Sirve para medir cuando se usa Claude
 * de verdad (scripts/usage-schedule-fit.mjs).
 * @returns {{cost:number[][], occurrences:number[], from:string, to:string, totalCost:number}}
 *   cost[dow][hora] = USD acumulados (dow 0 = domingo); occurrences[dow] = cuantas
 *   veces aparece ese dia de la semana en la ventana.
 */
export function hourlyCostMatrix({ weeks = 4, now = Date.now() } = {}) {
  const days = weeks * 7;
  const dayList = [];
  for (let i = days; i >= 1; i -= 1) dayList.push(localDay(now - i * 86400000));
  const from = dayList[0];
  const to = dayList[dayList.length - 1];
  const dowOf = new Map(dayList.map((d) => [d, new Date(`${d}T12:00:00`).getDay()]));

  const cost = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const occurrences = new Array(7).fill(0);
  for (const dow of dowOf.values()) occurrences[dow] += 1;

  let dirNames = [];
  try {
    dirNames = fs.readdirSync(claudeProjectsDir(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    /* sin ~/.claude/projects */
  }
  let totalCost = 0;
  for (const dirName of dirNames) {
    for (const f of aggregateDir(dirName)) {
      for (const [key, r] of Object.entries(f.rows)) {
        const [day, hour, model] = key.split('|');
        const dow = dowOf.get(day);
        if (dow === undefined) continue;
        const c = costOf(model, { input: r[1], output: r[2], cacheRead: r[3], cacheWrite5m: r[4], cacheWrite1h: r[5] });
        if (!c) continue;
        cost[dow][Number(hour)] += c;
        totalCost += c;
      }
    }
  }
  return { cost, occurrences, from, to, totalCost };
}

/**
 * Gasto nocional por día y hora local de los últimos `days` días completos (sin hoy):
 * { days: ['YYYY-MM-DD', ...], cost: Map<día, number[24]>, totalCost }.
 * Mismo origen y caché que `hourlyCostMatrix`, pero sin plegar por día de la semana.
 */
export function dailyHourlyCost({ days = 56, now = Date.now(), includeToday = false } = {}) {
  const dayList = [];
  for (let i = days; i >= (includeToday ? 0 : 1); i -= 1) dayList.push(localDay(now - i * 86400000));
  const cost = new Map(dayList.map((d) => [d, new Array(24).fill(0)]));
  let dirNames = [];
  try {
    dirNames = fs.readdirSync(claudeProjectsDir(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    /* sin ~/.claude/projects */
  }
  let totalCost = 0;
  for (const dirName of dirNames) {
    for (const f of aggregateDir(dirName)) {
      for (const [key, r] of Object.entries(f.rows)) {
        const [day, hour, model] = key.split('|');
        const row = cost.get(day);
        if (!row) continue;
        const c = costOf(model, { input: r[1], output: r[2], cacheRead: r[3], cacheWrite5m: r[4], cacheWrite1h: r[5] });
        if (!c) continue;
        row[Number(hour)] += c;
        totalCost += c;
      }
    }
  }
  return { days: dayList, cost, totalCost };
}
