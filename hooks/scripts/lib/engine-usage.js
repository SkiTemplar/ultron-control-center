/**
 * engine-usage.js — uso de las suscripciones de Codex (plan de ChatGPT) y de
 * Antigravity `agy` (Gemini), para mostrarlo junto al de Claude.
 *
 * Fuente única: la usan la statusline (cockpit/statusline.js),
 * scripts/usage-outlook.mjs y scripts/engine-usage.mjs, que es el puente que
 * lanza la pestaña Uso de Sessions (sesiones_engines_usage). No hay otro parser
 * en Rust.
 *
 * - Codex: el último evento con `rate_limits` de los rollouts más recientes
 *   (~/.codex/sessions/AAAA/MM/DD/rollout-*.jsonl, por mtime). `primary` y
 *   `secondary` se clasifican por `window_minutes` (300 = 5 h, 10080 = semana).
 *   Una ventana cuyo `resets_at` ya pasó se da como desconocida (0 % o lo que
 *   se haya gastado desde el reinicio): la lectura es de antes del reinicio.
 *   La lectura se guarda en caché (`CODEX_CACHE_TTL_MS`, clave = ruta, mtime
 *   y tamaño del rollout más nuevo): la statusline repinta a menudo y leer
 *   las colas cuesta hasta ~3 MB. Dentro del plazo no se toca
 *   ~/.codex/sessions; pasado, se listan los rollouts y solo se vuelven a
 *   leer si la clave cambió. La caducidad de las ventanas se recalcula
 *   siempre con la hora actual.
 * - agy: `agy -p /usage --output-format json` devuelve la cuota real por grupo
 *   de modelos (`remaining_fraction` y `reset_time`) sin gastar turno. Se
 *   guarda en caché (`CACHE_TTL_MS`) para no lanzar el binario en cada
 *   consulta. Si no responde, se muestra la actividad de los transcripts
 *   (turnos y tokens en 5 h y 7 días), rotulada como actividad sin límite
 *   conocido: nunca un porcentaje inventado.
 *
 * Nunca lee `auth.json` ni `oauth_creds.json`.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FIVE_HOUR_MIN = 300;
const WEEK_MIN = 10080;
const HOUR_MS = 3600000;
/** Cola leída de cada rollout: los eventos `token_count` van al final. */
const ROLLOUT_TAIL_BYTES = 512 * 1024;
/** Rollouts que se miran como mucho (el más nuevo puede no traer límites aún). */
const MAX_ROLLOUTS = 6;
/** Días de carpetas de sesiones que se recorren hacia atrás. */
const MAX_DAY_DIRS = 8;
/**
 * Vida de la caché de `agy /usage`. Tiene que ser mayor que el sondeo de la
 * pestaña Uso (`REFRESH_MS` de UsoMotores.tsx, 2 min): con los dos iguales,
 * la caché vencía justo al llegar cada sondeo y agy se relanzaba en todos.
 */
const CACHE_TTL_MS = 5 * 60000;
const AGY_TIMEOUT_MS = 20000;
/** Plazo en que la lectura de Codex en caché se da por buena sin mirar el disco. */
const CODEX_CACHE_TTL_MS = 60000;
const CODEX_CACHE_VERSION = 1;

function codexHome(opts) {
  return opts.codexHome || process.env.ULTRON_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function agyHome(opts) {
  return opts.agyHome || process.env.ULTRON_AGY_HOME || path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

function agyCachePath(opts) {
  return opts.cachePath || process.env.ULTRON_AGY_CACHE || path.join(os.homedir(), '.ultron', '.tmp', 'agy-usage.json');
}

/**
 * Caché de la lectura de Codex; `null` la desactiva. Con un `codexHome`
 * explícito (pruebas) y sin ruta propia no hay caché: no se mezcla con la
 * del usuario.
 */
function codexCachePath(opts) {
  if (opts.codexCachePath !== undefined) return opts.codexCachePath;
  if (process.env.ULTRON_CODEX_CACHE) return process.env.ULTRON_CODEX_CACHE;
  if (opts.codexHome) return null;
  return path.join(os.homedir(), '.ultron', '.tmp', 'codex-usage.json');
}

function windowKind(minutes) {
  if (minutes === FIVE_HOUR_MIN) return 'five_hour';
  if (minutes === WEEK_MIN) return 'seven_day';
  return `w${minutes}m`;
}

const finite = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);

/** Ventana normalizada: `usedPct` null si ya se reinició o falta el dato. */
function makeWindow(kind, group, usedPct, resetsAtMs, nowMs) {
  const expired = resetsAtMs !== null && resetsAtMs <= nowMs;
  return { kind, group, usedPct: expired ? null : usedPct, resetsAtMs, expired };
}

/** Ventana de Codex sin evaluar contra la hora: `usedPct` tal cual se leyó. */
function codexWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const minutes = finite(w.window_minutes);
  const used = finite(w.used_percent);
  if (minutes === null || used === null) return null;
  const reset = finite(w.resets_at);
  return { kind: windowKind(minutes), group: null, usedPct: used, resetsAtMs: reset === null ? null : reset * 1000 };
}

/** Lectura cruda con sus ventanas evaluadas contra `nowMs`. */
function withNow(raw, nowMs) {
  return raw && { ...raw, windows: raw.windows.map((w) => makeWindow(w.kind, w.group, w.usedPct, w.resetsAtMs, nowMs)) };
}

/** Lectura de una línea de rollout; null si no es JSON o no trae `rate_limits` de Codex. */
function parseCodexLine(line, nowMs) {
  return withNow(rawCodexLine(line), nowMs);
}

function rawCodexLine(line) {
  if (!line.includes('"rate_limits"')) return null;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  const rl = ev && ev.payload && ev.payload.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  if (rl.limit_id !== undefined && rl.limit_id !== null && rl.limit_id !== 'codex') return null;
  const windows = [codexWindow(rl.primary), codexWindow(rl.secondary)].filter(Boolean);
  if (windows.length === 0) return null;
  const ts = Date.parse(ev.timestamp);
  return { windows, readAtMs: Number.isFinite(ts) ? ts : null, plan: typeof rl.plan_type === 'string' ? rl.plan_type : null };
}

function latestRawReading(text) {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const r = rawCodexLine(lines[i]);
    if (r) return r;
  }
  return null;
}

/** La lectura más reciente de un texto de rollout (de la última línea hacia atrás). */
function latestCodexReading(text, nowMs) {
  return withNow(latestRawReading(text), nowMs);
}

function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function numericDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => Number(b) - Number(a));
  } catch {
    return [];
  }
}

/** Rollouts de las carpetas de día más recientes, del más nuevo (mtime) al más viejo. */
function recentRollouts(sessionsDir) {
  const days = [];
  for (const y of numericDirs(sessionsDir)) {
    for (const m of numericDirs(path.join(sessionsDir, y))) {
      for (const d of numericDirs(path.join(sessionsDir, y, m))) {
        days.push(path.join(sessionsDir, y, m, d));
        if (days.length >= MAX_DAY_DIRS) break;
      }
      if (days.length >= MAX_DAY_DIRS) break;
    }
    if (days.length >= MAX_DAY_DIRS) break;
  }
  const files = [];
  for (const dir of days) {
    for (const name of fs.readdirSync(dir)) {
      if (!/^rollout-.*\.jsonl$/.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        files.push({ file, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* borrado entre el listado y el stat */
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_ROLLOUTS);
}

function engine(id, label, fields) {
  return { id, label, status: 'none', source: null, readAtMs: null, plan: null, windows: [], activity: null, note: null, ...fields };
}

/** Lectura cruda del rollout más reciente que trae límites; null si ninguno. */
function rawFromRollouts(files) {
  for (const { file } of files) {
    try {
      const raw = latestRawReading(readTail(file, ROLLOUT_TAIL_BYTES));
      if (raw) return raw;
    } catch {
      /* rollout ilegible: el siguiente */
    }
  }
  return null;
}

function codexEngine(raw, nowMs) {
  const reading = withNow(raw, nowMs);
  if (!reading) return engine('codex', 'Codex', { note: 'ningún rollout reciente trae rate_limits' });
  const expired = reading.windows.some((w) => w.expired);
  return engine('codex', 'Codex', {
    status: 'ok',
    source: 'rollout',
    readAtMs: reading.readAtMs,
    plan: reading.plan,
    windows: reading.windows,
    note: expired ? 'alguna ventana se reinició después de la lectura: su uso actual es desconocido' : null,
  });
}

/** Clave de la caché: el rollout más nuevo (ruta, mtime y tamaño). */
const rolloutKey = (files) => (files[0] ? { file: files[0].file, mtimeMs: files[0].mtimeMs, size: files[0].size } : null);

const sameKey = (a, b) => (a === null || b === null ? a === b : a.file === b.file && a.mtimeMs === b.mtimeMs && a.size === b.size);

/** Caché de Codex de `sessions`; null si no existe, es de otra carpeta o de otra versión. */
function readCodexCache(file, sessions) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ok = c && c.v === CODEX_CACHE_VERSION && c.sessions === sessions && finite(c.checkedAtMs) !== null && 'raw' in c && 'key' in c;
    return ok ? c : null;
  } catch {
    return null;
  }
}

/**
 * Uso de Codex. `force` no lee la caché (sí la reescribe). Dentro de
 * `CODEX_CACHE_TTL_MS` la caché se sirve sin tocar los rollouts; después se
 * listan y solo se lee su cola si cambió el más nuevo.
 */
function readCodexUsage(opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const sessions = path.join(codexHome(opts), 'sessions');
  const cacheFile = codexCachePath(opts);
  const cached = cacheFile && !opts.force ? readCodexCache(cacheFile, sessions) : null;
  const age = cached ? nowMs - cached.checkedAtMs : null;
  if (cached && age >= 0 && age < CODEX_CACHE_TTL_MS) return codexEngine(cached.raw, nowMs);
  if (!fs.existsSync(sessions)) return engine('codex', 'Codex', { note: `no existe ${sessions}` });
  let files;
  try {
    files = recentRollouts(sessions);
  } catch (e) {
    return engine('codex', 'Codex', { status: 'error', note: `no se pudieron listar los rollouts: ${e.message}` });
  }
  const key = rolloutKey(files);
  const raw = cached && sameKey(cached.key, key) ? cached.raw : rawFromRollouts(files);
  if (cacheFile) writeJson(cacheFile, { v: CODEX_CACHE_VERSION, sessions, key, checkedAtMs: nowMs, raw });
  return codexEngine(raw, nowMs);
}

/** Ventanas de la salida de `agy -p /usage --output-format json`; null si no trae cuota. */
function parseAgyUsage(json, nowMs) {
  const groups = json && json.command && json.command.data && json.command.data.groups;
  if (!Array.isArray(groups)) return null;
  const windows = [];
  for (const g of groups) {
    for (const b of Array.isArray(g && g.buckets) ? g.buckets : []) {
      const remaining = finite(b && b.remaining_fraction);
      const kind = b && b.window === '5h' ? 'five_hour' : b && b.window === 'weekly' ? 'seven_day' : null;
      if (remaining === null || kind === null) continue;
      const reset = Date.parse(b.reset_time);
      const used = Math.max(0, Math.min(100, (1 - remaining) * 100));
      windows.push(makeWindow(kind, typeof g.name === 'string' ? g.name : null, used, Number.isFinite(reset) ? reset : null, nowMs));
    }
  }
  if (windows.length === 0) return null;
  // Dentro de cada grupo, la de 5 h antes que la semanal (como en Claude y Codex).
  const groupOrder = [...new Set(windows.map((w) => w.group))];
  const rank = (w) => groupOrder.indexOf(w.group) * 2 + (w.kind === 'five_hour' ? 0 : 1);
  return [...windows].sort((a, b) => rank(a) - rank(b));
}

/** JSON de la salida del CLI: entero o la última línea que lo sea. */
function parseJsonOutput(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    const line = stdout.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'));
    if (!line) return null;
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }
}

/**
 * Lanza `agy -p /usage`; devuelve `{ json }` o `{ error }`. Sin shell: `/usage` no pasa por la conversión de rutas de MSYS.
 * Sin autoactualización: cada arranque de agy lanza `--bg-updater`, proceso desacoplado con
 * consola propia que `windowsHide` no alcanza y que abre una ventana de Windows Terminal en
 * cada sondeo. agy se sigue actualizando al usarlo directamente.
 */
function runAgyUsage(bin) {
  const r = spawnSync(bin, ['-p', '/usage', '--output-format', 'json'], {
    encoding: 'utf8',
    timeout: AGY_TIMEOUT_MS,
    windowsHide: true,
    cwd: os.tmpdir(),
    // agy solo acepta 'true': con '1' sigue lanzando el actualizador (medido).
    env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
  });
  if (r.error) return { error: r.error.code === 'ENOENT' ? `no se encontró '${bin}' en el PATH` : r.error.message };
  if (r.status !== 0) return { error: `agy salió con código ${r.status}` };
  const json = parseJsonOutput(r.stdout || '');
  return json ? { json } : { error: 'la salida de agy /usage no es JSON' };
}

function readCache(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    return finite(c.fetchedAtMs) !== null && c.payload ? c : null;
  } catch {
    return null;
  }
}

/** Escritura atómica (temporal + rename) de una caché; un fallo no rompe la lectura. */
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  } catch {
    // La caché es opcional; no dejar el temporal a medias.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nada que limpiar */
    }
  }
}

function writeCache(file, payload, nowMs) {
  writeJson(file, { fetchedAtMs: nowMs, payload });
}

/** Turnos del modelo y tokens (entrada + salida) en las últimas 5 h y 7 días según los transcripts. */
function agyActivity(home, nowMs) {
  const brain = path.join(home, 'brain');
  const weekAgo = nowMs - 7 * 24 * HOUR_MS;
  const fiveAgo = nowMs - 5 * HOUR_MS;
  const acc = { fiveHour: { turns: 0, tokens: 0 }, sevenDay: { turns: 0, tokens: 0 } };
  let dirs;
  try {
    dirs = fs.readdirSync(brain);
  } catch {
    return null;
  }
  for (const id of dirs) {
    const file = path.join(brain, id, '.system_generated', 'logs', 'transcript.jsonl');
    let text;
    try {
      if (fs.statSync(file).mtimeMs < weekAgo) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('PLANNER_RESPONSE')) continue;
      let step;
      try {
        step = JSON.parse(line);
      } catch {
        continue;
      }
      const at = Date.parse(step.created_at);
      if (step.type !== 'PLANNER_RESPONSE' || !Number.isFinite(at) || at < weekAgo || at > nowMs) continue;
      const tokens = (finite(step.input_tokens) ?? 0) + (finite(step.output_tokens) ?? 0);
      acc.sevenDay.turns += 1;
      acc.sevenDay.tokens += tokens;
      if (at >= fiveAgo) {
        acc.fiveHour.turns += 1;
        acc.fiveHour.tokens += tokens;
      }
    }
  }
  return acc;
}

/**
 * Uso de agy. `allowSpawn: false` (statusline) solo mira la caché; `force`
 * la salta. Sin cuota legible cae a la actividad de los transcripts.
 */
function readAgyUsage(opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const cacheFile = agyCachePath(opts);
  const maxAgeMs = opts.maxCacheMs ?? CACHE_TTL_MS;
  const cached = opts.force ? null : readCache(cacheFile);
  let payload = cached && nowMs - cached.fetchedAtMs <= maxAgeMs ? cached.payload : null;
  let readAtMs = payload ? cached.fetchedAtMs : null;
  let failure = null;
  if (!payload && opts.allowSpawn !== false) {
    const run = opts.run || runAgyUsage;
    const r = run(opts.agyBin || process.env.ULTRON_AGY_BIN || 'agy');
    if (r.json && parseAgyUsage(r.json, nowMs)) {
      payload = r.json;
      readAtMs = nowMs;
      writeCache(cacheFile, { command: { data: r.json.command.data } }, nowMs);
    } else {
      failure = r.error || 'agy /usage no trae cuota';
    }
  }
  const windows = payload ? parseAgyUsage(payload, nowMs) : null;
  if (windows) {
    return engine('agy', 'agy (Gemini)', { status: 'ok', source: 'agy-usage', readAtMs, windows });
  }
  if (opts.allowSpawn === false) return engine('agy', 'agy (Gemini)', { note: 'sin lectura reciente en caché' });
  const activity = agyActivity(agyHome(opts), nowMs);
  if (!activity) return engine('agy', 'agy (Gemini)', { status: failure ? 'error' : 'none', note: failure });
  return engine('agy', 'agy (Gemini)', {
    status: 'ok',
    source: 'activity',
    readAtMs: nowMs,
    activity,
    note: `actividad sin límite conocido (${failure})`,
  });
}

function readEngines(opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  return { generatedAtMs: nowMs, engines: [readCodexUsage({ ...opts, nowMs }), readAgyUsage({ ...opts, nowMs })] };
}

/**
 * Ficha corta para la statusline: `cx 4/3%` (5 h / semana). Una ventana
 * reiniciada o ausente sale como `?`; null si no hay nada que enseñar.
 * En agy usa el primer grupo (Gemini).
 */
function compactToken(e, prefix) {
  if (!e || e.status !== 'ok' || e.windows.length === 0) return null;
  const group = e.windows[0].group;
  const pick = (kind) => e.windows.find((w) => w.kind === kind && w.group === group);
  const val = (w) => (w && w.usedPct !== null ? String(Math.round(w.usedPct)) : '?');
  const five = pick('five_hour');
  const week = pick('seven_day');
  if ((!five || five.usedPct === null) && (!week || week.usedPct === null)) return null;
  return `${prefix} ${val(five)}/${val(week)}%`;
}

const LABELS = { five_hour: '5 h', seven_day: 'semana' };
const pad2 = (n) => String(n).padStart(2, '0');

function whenText(ms) {
  const d = new Date(ms);
  return `${['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'][d.getDay()]} ${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function ageText(ms, nowMs) {
  const min = Math.max(0, Math.round((nowMs - ms) / 60000));
  if (min < 1) return 'hace menos de 1 min';
  if (min < 120) return `hace ${min} min`;
  if (min < 48 * 60) return `hace ${Math.round(min / 60)} h`;
  return `hace ${Math.round(min / 1440)} días`;
}

function windowText(w) {
  const label = LABELS[w.kind] || w.kind;
  if (w.expired) return `${label} reiniciada (${whenText(w.resetsAtMs)}): uso actual desconocido`;
  const reset = w.resetsAtMs === null ? '' : ` · reset ${whenText(w.resetsAtMs)}`;
  return `${label} ${Math.round(w.usedPct)} %${reset}`;
}

const kTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} M` : `${Math.round(n / 1000)} k`);

/** Líneas de texto de un motor (usage-outlook y engine-usage.mjs). */
function describeEngine(e, nowMs = Date.now()) {
  const head = e.label + (e.plan ? ` (${e.plan})` : '');
  if (e.status !== 'ok') return [`${head}: sin dato${e.note ? ` (${e.note})` : ''}`];
  const age = e.readAtMs === null ? '' : ` · lectura ${ageText(e.readAtMs, nowMs)}`;
  if (e.source === 'activity') {
    const a = e.activity;
    return [
      `${head}: actividad sin límite conocido${age}`,
      `  5 h: ${a.fiveHour.turns} turnos, ${kTokens(a.fiveHour.tokens)} tokens · 7 días: ${a.sevenDay.turns} turnos, ${kTokens(a.sevenDay.tokens)} tokens`,
      ...(e.note ? [`  ${e.note}`] : []),
    ];
  }
  const groups = [...new Set(e.windows.map((w) => w.group))];
  const lines = [`${head}${age}`];
  for (const g of groups) {
    const ws = e.windows.filter((w) => w.group === g).map(windowText).join(' · ');
    lines.push(`  ${g ? `${g}: ` : ''}${ws}`);
  }
  if (e.note) lines.push(`  ${e.note}`);
  return lines;
}

module.exports = {
  CACHE_TTL_MS,
  CODEX_CACHE_TTL_MS,
  describeEngine,
  windowKind,
  parseCodexLine,
  latestCodexReading,
  readCodexUsage,
  parseAgyUsage,
  parseJsonOutput,
  agyActivity,
  readAgyUsage,
  readEngines,
  compactToken,
};
