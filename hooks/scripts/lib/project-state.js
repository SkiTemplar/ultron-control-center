'use strict';
/**
 * lib/project-state.js — estado vivo por proyecto (memoria de proyecto).
 *
 * Un solo `cockpit/projects/<id>/estado.json` por proyecto con lo que sigue
 * vigente: resumen, decisiones, pendientes abiertos y gotchas. Cada bitacora
 * nueva (summary.md de session-summarize-previous.js) se FUSIONA en el con una
 * LLM secundaria (lib/secondary-llm.js: Groq -> Gemini, nunca Claude), que
 * quita lo cerrado y anade lo nuevo. El SessionStart inyecta el render
 * compacto (memory-session-resume.js), con tope de caracteres.
 *
 * Decidido el 2026-09-28 al apagar el recall denso por prompt: la memoria de
 * proyecto pasa a ser este estado + la bitacora de la ultima sesion.
 *
 * Garantias:
 *   - La salida de la LLM se valida y se recorta (MAX_ITEMS/MAX_ITEM_CHARS);
 *     nunca se escribe texto libre sin pasar por normalize().
 *   - Guardia anti-borrado: si una fusion deja menos del MIN_KEEP_RATIO de
 *     los items previos, se rechaza (una LLM que devuelve listas vacias no
 *     puede vaciar la memoria del proyecto).
 *   - Idempotente por (sesion, digest_sha): la misma bitacora no se fusiona
 *     dos veces.
 *
 * CLI:
 *   node lib/project-state.js merge   --project <id> --session <sid>
 *   node lib/project-state.js rebuild --project <id> [--last N]
 *   node lib/project-state.js show    --project <id>
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_ITEMS = { decisiones: 12, pendientes: 12, gotchas: 8 };
const MAX_ITEM_CHARS = 200;
const MAX_RESUMEN_CHARS = 400;
const MAX_MERGED_IDS = 60;
const MIN_KEEP_RATIO = 0.4;
const MIN_PREV_ITEMS_FOR_GUARD = 5;
/** Tope del bloque inyectado en el SessionStart (~650 tokens, recorte 2026-09-29). */
const RENDER_MAX_CHARS = 2600;
/**
 * Items por seccion en el SessionStart (recorte 2026-09-29): el estado guarda
 * hasta MAX_ITEMS, pero al arrancar solo viajan los mas recientes.
 */
const RENDER_LIMITS = { pendientes: 6, decisiones: 6, gotchas: 4 };
/** Pausa entre fusiones en `rebuild` (ms). */
const REBUILD_PAUSE_MS = Number(process.env.PROJECT_STATE_PAUSE_MS) || 20000;

const MERGE_CHAIN = [
  { provider: 'groq', model: 'openai/gpt-oss-120b', endpoint: 'https://api.groq.com/openai/v1/chat/completions', keyVar: 'GROQ_API_KEY' },
  { provider: 'groq', model: 'openai/gpt-oss-20b', endpoint: 'https://api.groq.com/openai/v1/chat/completions', keyVar: 'GROQ_API_KEY' },
  { provider: 'gemini', model: 'gemini-3.6-flash', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', keyVar: 'GEMINI_API_KEY' },
];

const SYSTEM_PROMPT = [
  'Mantienes el ESTADO VIVO de un proyecto de software: lo que un desarrollador necesita saber al abrir',
  'una sesion nueva. Recibes el estado actual (JSON) y la bitacora de la ultima sesion (markdown).',
  'Devuelve SOLO un objeto JSON con las claves: resumen (string), decisiones (array de strings),',
  'pendientes (array de strings), gotchas (array de strings).',
  'Reglas:',
  '- Conserva todo lo del estado que siga vigente; no lo reescribas si no cambia.',
  '- Quita los pendientes que la bitacora da por hechos o cerrados, y las decisiones que revierte.',
  '- Una decision nueva SUSTITUYE a la del estado que trate el mismo tema (la misma rama, el mismo sistema,',
  '  la misma regla de trabajo): deja solo la nueva, nunca las dos. Quita tambien los pendientes que',
  '  dependian de la decision sustituida.',
  '- Anade decisiones, pendientes y gotchas nuevos de la bitacora; fusiona duplicados.',
  `- Maximo ${MAX_ITEMS.decisiones} decisiones, ${MAX_ITEMS.pendientes} pendientes, ${MAX_ITEMS.gotchas} gotchas;`,
  '  si sobran, descarta lo mas antiguo o menos relevante. Cada item: una frase de menos de 200 caracteres,',
  '  concreta (ficheros, comandos, cifras), con fecha YYYY-MM-DD al inicio si la conoces.',
  '- resumen: 1-2 frases sobre en que punto esta el proyecto.',
  '- decisiones: SOLO decisiones de diseno, producto o reglas de trabajo duraderas. NO son decisiones y no van:',
  '  las autorizaciones o permisos que el usuario dio en una sesion concreta ("el usuario autorizo..."),',
  '  las restricciones de un turno ("no hacer commits", "mientras los auditores leen"), las acciones del',
  '  asistente ("el asistente decidio lanzar...") ni las cifras de una medicion (notas, puntuaciones).',
  '- Espanol. No inventes nada que no este en el estado o la bitacora.',
].join('\n');

/**
 * Items de "decisiones" que solo valen para la sesion en que se dijeron y no
 * pueden viajar como "Decisiones vigentes" a todas las sesiones futuras
 * (auditoria 2026-10-23: el SessionStart inyectaba "Usuario autorizo continuar
 * a full ultracode", "No hacer commits, no mover Kanban..." y una nota 6,5/10
 * ya superada). El prompt lo pide; esto lo garantiza aunque la LLM no obedezca
 * y limpia lo que ya estaba guardado.
 */
const SESSION_SCOPED_DECISION = [
  // Consentimientos y encargos de una sesion.
  /\b(usuario|user)\b[^.]{0,40}\b(autoriz|permiti|consinti|solicit|pidi)/i,
  /\bautoriz[oó](?![a-z])/i,
  // Acciones del asistente (lo que hizo, no lo que se decidio).
  /\basistente\b[^.]{0,20}\b(decidi|lanz|continu|ejecut)/i,
  // Restricciones de turno.
  /^(\d{4}-\d{2}-\d{2}\s+)?(decisi[oó]n:\s*)?no (hacer|tocar|editar|mover|commitear|pushear)\b/i,
  /\b(mientras (los|las|el|la|se)|en (este|esta) (turno|sesi[oó]n)|por ahora|de momento)\b/i,
  // Cifras de una medicion (notas sobre 10).
  /\b\d+(?:[.,]\d+)?\s*\/\s*10\b/,
];

function isSessionScopedDecision(text) {
  const s = String(text || '');
  return SESSION_SCOPED_DECISION.some((re) => re.test(s));
}

/** Copia del estado sin las decisiones de alcance de sesion. */
function withoutSessionScoped(state) {
  if (!state || !Array.isArray(state.decisiones)) return state;
  return { ...state, decisiones: state.decisiones.filter((d) => !isSessionScopedDecision(d)) };
}

function ultronRoot() {
  return process.env.ULTRON_ROOT || path.join(os.homedir(), '.ultron');
}

function statePath(project) {
  return path.join(ultronRoot(), 'cockpit', 'projects', project, 'estado.json');
}

function emptyState() {
  return { resumen: '', decisiones: [], pendientes: [], gotchas: [], merged: [], updated_at: null };
}

function readState(project) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(project), 'utf8'));
    return { ...emptyState(), ...raw };
  } catch {
    return emptyState();
  }
}

function writeState(project, state) {
  const file = statePath(project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.prev`);
  } catch {
    /* sin backup: se sigue, el .prev es solo una red */
  }
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

function clip(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Valida y recorta la respuesta de la LLM. null si no tiene forma de estado. */
function normalize(json) {
  if (!json || typeof json !== 'object') return null;
  const out = { resumen: clip(json.resumen, MAX_RESUMEN_CHARS) };
  for (const key of Object.keys(MAX_ITEMS)) {
    if (!Array.isArray(json[key])) return null;
    const seen = new Set();
    out[key] = json[key]
      .map((x) => clip(typeof x === 'string' ? x : x && (x.texto || x.text || JSON.stringify(x)), MAX_ITEM_CHARS))
      .filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()))
      .slice(0, MAX_ITEMS[key]);
  }
  return out;
}

function itemCount(s) {
  return Object.keys(MAX_ITEMS).reduce((n, k) => n + ((s && s[k]) || []).length, 0);
}

/** Guardia anti-borrado. Devuelve el motivo del rechazo o null si vale. */
function rejectReason(prev, next) {
  const before = itemCount(prev);
  const after = itemCount(next);
  if (before >= MIN_PREV_ITEMS_FOR_GUARD && after < before * MIN_KEEP_RATIO) {
    return `la fusion deja ${after} items de ${before} (< ${Math.round(MIN_KEEP_RATIO * 100)} %)`;
  }
  return null;
}

function mergeKey(sessionId, sha) {
  return `${sessionId}:${sha || 'nosha'}`;
}

/** Quita el frontmatter del summary.md y devuelve { body, sha }. */
function parseSummary(text) {
  const s = String(text || '');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(s.replace(/\r\n/g, '\n'));
  if (!m) return { body: s.trim(), sha: null };
  const sha = (/^digest_sha:\s*(\S+)/m.exec(m[1]) || [])[1] || null;
  return { body: s.replace(/\r\n/g, '\n').slice(m[0].length).trim(), sha };
}

/**
 * Fusiona una bitacora en el estado del proyecto.
 * @param {{project:string, sessionId:string, summaryText:string, ask?:Function, now?:Date}} args
 * @returns {Promise<{ok:boolean, skipped?:string, error?:string, model?:string}>}
 */
async function mergeSummary({ project, sessionId, summaryText, ask, now = new Date() }) {
  const { body, sha } = parseSummary(summaryText);
  if (!body) return { ok: false, error: 'bitacora vacia' };
  const prev = readState(project);
  const key = mergeKey(sessionId, sha);
  if (prev.merged.includes(key)) return { ok: true, skipped: 'ya fusionada' };

  const askFn = ask || ((opts) => require('./secondary-llm').askJson(opts));
  const current = { resumen: prev.resumen, decisiones: prev.decisiones, pendientes: prev.pendientes, gotchas: prev.gotchas };
  const res = await askFn({
    system: SYSTEM_PROMPT,
    user: `ESTADO ACTUAL:\n${JSON.stringify(current)}\n\nBITACORA DE LA SESION ${sessionId} (${now.toISOString().slice(0, 10)}):\n${body.slice(0, 12000)}`,
    deadlineMs: 45000,
    maxTokens: 3000,
    chain: MERGE_CHAIN,
  });
  if (!res || !res.ok) return { ok: false, error: `LLM: ${(res && res.error) || 'sin respuesta'}` };
  const normalized = normalize(res.json);
  if (!normalized) return { ok: false, error: 'respuesta sin forma de estado' };
  // Las decisiones de alcance de sesion no se guardan; la guardia compara con
  // el estado previo limpiado igual, para que la limpieza no cuente como borrado.
  const next = withoutSessionScoped(normalized);
  const why = rejectReason(withoutSessionScoped(prev), next);
  if (why) return { ok: false, error: `rechazada: ${why}` };

  writeState(project, {
    ...next,
    merged: [...prev.merged.filter((k) => !k.startsWith(`${sessionId}:`)), key].slice(-MAX_MERGED_IDS),
    updated_at: now.toISOString(),
    model: `${res.provider}/${res.model}`,
  });
  return { ok: true, model: `${res.provider}/${res.model}` };
}

/** true si la bitacora de esa sesion ya esta dentro del estado. */
function hasMerged(state, sessionId) {
  return Boolean(state && Array.isArray(state.merged) && state.merged.some((k) => k.startsWith(`${sessionId}:`)));
}

const ITEM_DATE_RE = /^(\d{4}-\d{2}-\d{2})\b/;

/**
 * Los `limit` items mas recientes segun la fecha YYYY-MM-DD con la que empieza
 * cada uno (el prompt de fusion la pide). Sin fecha cuentan como los mas
 * antiguos; a igual fecha se respeta el orden guardado. Devuelve copia.
 */
function mostRecent(items, limit) {
  return (Array.isArray(items) ? items : [])
    .map((text, idx) => ({ text, idx, date: (ITEM_DATE_RE.exec(String(text)) || [])[1] || '' }))
    .sort((a, b) => (a.date === b.date ? a.idx - b.idx : a.date < b.date ? 1 : -1))
    .slice(0, limit)
    .map((x) => x.text);
}

/**
 * Bloque compacto para el SessionStart; [] si el proyecto no tiene estado.
 * Con `externalTracker` (lib/project-tracker.js) los pendientes de las
 * bitacoras no viajan: la lista de tareas vigente es la del tracker.
 */
function renderLines(rawState, { externalTracker = '' } = {}) {
  const state = withoutSessionScoped(rawState);
  if (!state || itemCount(state) === 0) return [];
  const lines = [`<project-state source="bitacoras" trust="session-summary" updated="${state.updated_at || '?'}">`];
  if (state.resumen) lines.push(`resumen: ${state.resumen}`);
  if (externalTracker) lines.push(`Pendientes: en el tracker del proyecto (${externalTracker}); consultalo ahi, no en las bitacoras.`);
  const sections = [['pendientes', 'Pendientes'], ['decisiones', 'Decisiones vigentes'], ['gotchas', 'Gotchas']];
  for (const [key, title] of sections) {
    if (key === 'pendientes' && externalTracker) continue;
    const items = mostRecent(state[key], RENDER_LIMITS[key]);
    if (!items.length) continue;
    lines.push(`${title}:`);
    for (const item of items) lines.push(`  - ${item}`);
  }
  lines.push('</project-state>');
  let total = 0;
  const kept = [];
  for (const l of lines) {
    total += l.length + 1;
    if (total > RENDER_MAX_CHARS) break;
    kept.push(l);
  }
  if (kept[kept.length - 1] !== '</project-state>') kept.push('  … (recortado)', '</project-state>');
  return kept;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function sessionsDir(project) {
  return path.join(ultronRoot(), 'cockpit', 'projects', project, 'sessions');
}

function summaryFile(project, sessionId) {
  return path.join(sessionsDir(project), sessionId, 'summary.md');
}

async function cli(argv) {
  const cmd = argv[0];
  const project = argValue(argv, '--project');
  if (!project) throw new Error('falta --project');
  if (cmd === 'show') {
    process.stdout.write(`${renderLines(readState(project)).join('\n')}\n`);
    return 0;
  }
  if (cmd === 'merge') {
    const sessionId = argValue(argv, '--session');
    if (!sessionId) throw new Error('falta --session');
    const r = await mergeSummary({ project, sessionId, summaryText: fs.readFileSync(summaryFile(project, sessionId), 'utf8') });
    process.stdout.write(`${JSON.stringify(r)}\n`);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'rebuild') {
    const last = Number(argValue(argv, '--last')) || 10;
    const files = fs
      .readdirSync(sessionsDir(project))
      .map((sid) => ({ sid, file: summaryFile(project, sid) }))
      .filter((x) => fs.existsSync(x.file))
      .map((x) => ({ ...x, mtime: fs.statSync(x.file).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime)
      .slice(-last);
    let ok = 0;
    let calledLlm = false;
    for (const x of files) {
      // Pausa entre llamadas: Groq free limita por minuto y por modelo; dos
      // fusiones seguidas agotaban 120b y 20b (medido 2026-09-28).
      if (calledLlm) await new Promise((r) => setTimeout(r, REBUILD_PAUSE_MS));
      const r = await mergeSummary({ project, sessionId: x.sid, summaryText: fs.readFileSync(x.file, 'utf8'), now: new Date(x.mtime) });
      calledLlm = !r.skipped;
      process.stdout.write(`${x.sid} ${JSON.stringify(r)}\n`);
      if (r.ok) ok++;
    }
    process.stdout.write(`fusionadas ${ok}/${files.length}\n`);
    return ok === files.length ? 0 : 1;
  }
  throw new Error(`subcomando desconocido: ${cmd}`);
}

if (require.main === module) {
  cli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      process.stderr.write(`project-state: ${e.message}\n`);
      process.exitCode = 2;
    });
}

module.exports = {
  MAX_ITEMS,
  RENDER_MAX_CHARS,
  RENDER_LIMITS,
  mostRecent,
  statePath,
  readState,
  normalize,
  rejectReason,
  parseSummary,
  mergeSummary,
  hasMerged,
  renderLines,
  isSessionScopedDecision,
};
