#!/usr/bin/env node
/**
 * session-summarize-previous.js — genera el resumen de la SESION ANTERIOR del
 * mismo proyecto. Primer eslabon: Codex CLI (`codex exec`, lib/codex-exec.js;
 * suscripcion de ChatGPT, coste 0 por uso y contexto grande). Si Codex no esta
 * instalado, falla o agota su plazo, sigue la LLM SECUNDARIA
 * (lib/secondary-llm.js: Groq con relevo a Gemini por API). NUNCA Claude:
 * desde 2026-09-29 no se llama a `claude -p` (consumia la cuota del plan Max).
 * Si toda la cadena falla, se registra el fallo y no hay resumen.
 *
 * NO es un hook de Claude Code: lo lanzan desacoplados session-end-bitacora.js
 * (SessionEnd, desde 2026-09-22: la sesion que cierra, con --target-session y
 * --transcript) y memory-session-resume.js (SessionStart: la sesion anterior
 * sin resumen o con uno viejo, como red), porque la llamada tarda 10-60 s y
 * ningun hook puede bloquear ese tiempo. Si no termina a tiempo,
 * memory-orchestrate.js entrega el resumen en el primer prompt (ver
 * lib/session-summary-delivery.js). Para el historico: scripts/session-summary-backfill.mjs.
 *
 * Flujo:
 *   1. Localiza ~/.claude/projects/<slug>/ (transcripts del cwd).
 *   2. Elige la sesion anterior mas reciente que: no sea la actual, tenga
 *      >=2 prompts reales, se haya modificado en los ultimos MAX_AGE_DAYS
 *      dias y no tenga summary.md todavia.
 *   3. Construye el digest (lib/session-digest.js) y lo resume: Codex primero,
 *      Groq -> Gemini de relevo.
 *   4. Escribe cockpit/projects/<projectId>/sessions/<sessionId>/summary.md
 *      (atomico, con cabecera de procedencia). NUNCA escribe en brain.db.
 *
 * Tamano: los digests reales rondan 150.000 caracteres (SESSION_SUMMARY_MAX_CHARS).
 * Codex los admite; Groq los rechaza con HTTP 413 (cuota de tokens por minuto)
 * y entonces responde Gemini.
 *
 * Redaccion (revision de codigo 2026-09-11, hallazgo MEDIUM): el digest sale
 * de la maquina hacia el proveedor externo y summary.md se inyecta luego en el
 * contexto de otra sesion, asi que ambos pasan por lib/security-helpers.js
 * (los mismos patrones que stop-compress-session.js/project-profile.js)
 * ANTES de salir/escribirse. FAIL-CLOSED: si el modulo no carga, main() no
 * resume nada (mandamiento de seguridad: mejor sin resumen que sin redactar).
 *
 * Backoff por sesion objetivo (hallazgo LOW/MEDIUM): un fallo de la LLM
 * se cuenta en ~/.ultron/.tmp/session-summary-attempts/<sessionId>.json. Con
 * 2 fallos, esa sesion no se reintenta durante BACKOFF_MS (6h); con 5, se
 * abandona (selectPreviousSession la salta y prueba la siguiente candidata).
 * `--target-session` (verificacion manual) IGNORA el backoff a proposito.
 * Si TODOS los eslabones responden HTTP 429 (cuota agotada), no cuenta para
 * el backoff y congela los resumenes QUOTA_COOLDOWN_MIN minutos.
 *
 * Seams de test (ninguno toca el sistema real):
 *   SESSION_SUMMARY_PROJECTS_DIR      raiz de cockpit/projects
 *   SESSION_SUMMARY_LOCK_DIR          directorio de locks single-flight
 *   SESSION_SUMMARY_LOG               ruta del log jsonl
 *   SESSION_SUMMARY_TRANSCRIPTS_DIR   fuerza el directorio de transcripts (salta el slug)
 *   SESSION_SUMMARY_ATTEMPTS_DIR      directorio del backoff por sesion objetivo
 *   SESSION_SUMMARY_MAX_AGE_DAYS      edad maxima de una sesion candidata (dias)
 *   SESSION_SUMMARY_TIMEOUT_MS        plazo total de la cadena de la LLM secundaria
 *   SESSION_SUMMARY_CODEX             0 = sin Codex (directo a Groq -> Gemini)
 *   SESSION_SUMMARY_CODEX_MODEL       modelo de Codex (gpt-5.6-terra por defecto)
 *   SESSION_SUMMARY_CODEX_EFFORT      model_reasoning_effort de Codex (low)
 *   SESSION_SUMMARY_CODEX_TIMEOUT_MS  plazo de Codex (120 s por defecto)
 *   CODEX_EXEC_BIN                    lanzador de Codex (lib/codex-exec.js)
 *   SESSION_SUMMARY_MAX_CHARS         tope de caracteres del digest
 *   SECONDARY_LLM_ENDPOINT / SECONDARY_LLM_ENV_FILE  (lib/secondary-llm.js)
 *   SESSION_SUMMARY_FORCE_NO_REDACTION  1 = simula que security-helpers.js no
 *                                        cargo (solo tests del fail-closed)
 *
 * NO-OP-SAFE: cualquier fallo (sin candidata, lock ocupado, sin redaccion,
 * la LLM secundaria falla o agota el plazo) sale con 0 y sin escribir
 * summary.md; el error queda en logs/session-summary.jsonl y hook-errors.jsonl.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { observe, logHookError } = require('./lib/hook-obs');
const { appendJsonl } = require('./lib/jsonl-log');
const { resolveProjectId } = require('./lib/project-identity');
const { safeId } = require('./lib/safe-id');
const digest = require('./lib/session-digest');
const lastSession = require('./lib/last-session');
const kanbanAuto = require('./lib/kanban-auto');
const { externalTrackerFor, isManualKanban } = require('./lib/project-tracker');

const HOME = os.homedir();
const LOG_PATH = process.env.SESSION_SUMMARY_LOG || path.join(HOME, '.ultron', 'logs', 'session-summary.jsonl');
const LOCK_DIR = process.env.SESSION_SUMMARY_LOCK_DIR || path.join(HOME, '.ultron', 'run', 'session-summary');
const ATTEMPTS_DIR = process.env.SESSION_SUMMARY_ATTEMPTS_DIR || path.join(HOME, '.ultron', '.tmp', 'session-summary-attempts');
const MAX_AGE_DAYS = Number(process.env.SESSION_SUMMARY_MAX_AGE_DAYS) || 7;
const MIN_USER_PROMPTS = digest.MIN_USER_PROMPTS;
const TIMEOUT_MS = Number(process.env.SESSION_SUMMARY_TIMEOUT_MS) || 180000;
const MAX_DIGEST_CHARS = Number(process.env.SESSION_SUMMARY_MAX_CHARS) || digest.DEFAULT_MAX_CHARS;
// Codex (primer eslabon): Terra basta para resumir y no gasta la cuota de Astra.
const CODEX_ENABLED = process.env.SESSION_SUMMARY_CODEX !== '0';
const CODEX_MODEL = process.env.SESSION_SUMMARY_CODEX_MODEL || 'gpt-5.6-terra';
const CODEX_EFFORT = process.env.SESSION_SUMMARY_CODEX_EFFORT || 'low';
const CODEX_TIMEOUT_MS = Number(process.env.SESSION_SUMMARY_CODEX_TIMEOUT_MS) || 120000;
const STALE_LOCK_MS = (CODEX_ENABLED ? CODEX_TIMEOUT_MS : 0) + TIMEOUT_MS + 60000;
// Backoff por sesion objetivo (ver cabecera del fichero).
const BACKOFF_AFTER_FAILURES = 2;
const BACKOFF_MS = 6 * 60 * 60 * 1000;
const ABANDON_AFTER_FAILURES = 5;
// Cuota agotada: si TODOS los eslabones de la cadena responden HTTP 429, no
// es culpa de la sesion objetivo: no cuenta para el backoff/abandono y congela
// TODOS los resumenes un rato (ver recordQuotaCooldown) en vez de gastar un
// intento por sesion y pasada.
const QUOTA_COOLDOWN_MIN = Number(process.env.SESSION_SUMMARY_QUOTA_COOLDOWN_MIN) || 30;
// Cadena propia: el 120b resume mejor que el 20b; Gemini recoge los digests
// que Groq rechaza por tamano (HTTP 413).
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const SUMMARY_CHAIN = [
  { provider: 'groq', model: 'openai/gpt-oss-120b', endpoint: GROQ_URL, keyVar: 'GROQ_API_KEY' },
  { provider: 'groq', model: 'openai/gpt-oss-20b', endpoint: GROQ_URL, keyVar: 'GROQ_API_KEY' },
  { provider: 'gemini', model: 'gemini-3.6-flash', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', keyVar: 'GEMINI_API_KEY' },
];
const SUMMARY_MAX_TOKENS = 4000;

// ---------------------------------------------------------------------------
// Redaccion — lib/security-helpers.js (mismo modulo que stop-compress-session.js
// / project-profile.js). FAIL-CLOSED: sin helpers reales, no se resume nada
// (ver main()). El seam SESSION_SUMMARY_FORCE_NO_REDACTION es SOLO para el test
// del camino fail-closed.
// ---------------------------------------------------------------------------
let redactSecrets = null;
let securityHelpersLoaded = false;
if (process.env.SESSION_SUMMARY_FORCE_NO_REDACTION !== '1') {
  try {
    const sec = require('./lib/security-helpers.js');
    if (typeof sec.redactSecrets === 'function') {
      redactSecrets = sec.redactSecrets;
      securityHelpersLoaded = true;
    }
  } catch {
    /* security-helpers.js no disponible -> fail-closed en main() */
  }
}

/** project_dir slug de Claude Code: cada caracter no alfanumerico -> '-'. */
function cwdToSlug(cwd) {
  return String(cwd || '').replace(/[^A-Za-z0-9]/g, '-');
}

/** Directorio de transcripts del cwd; usa transcript_path del hook si esta disponible. */
function transcriptsDirFor(cwd, transcriptPath) {
  if (process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR) return process.env.SESSION_SUMMARY_TRANSCRIPTS_DIR;
  if (transcriptPath) {
    const dir = path.dirname(transcriptPath);
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      /* transcript_path no resuelve: cae al slug */
    }
  }
  return path.join(HOME, '.claude', 'projects', cwdToSlug(cwd));
}

/**
 * Candidata BARATA (hallazgo de latencia, revision 2026-09-11): solo
 * readdir+stat, NUNCA lee el contenido de un transcript. La usa
 * memory-session-resume.js (SessionStart, presupuesto de 12s) para decidir si
 * merece la pena lanzar el resumidor; la seleccion FINA (con lectura de
 * transcripts) vive en selectPreviousSession(), dentro del proceso
 * desacoplado.
 * @returns {boolean}
 */
function hasCheapPendingCandidate({ transcriptsDir, currentSessionId, projectId }) {
  let entries;
  try {
    entries = fs.readdirSync(transcriptsDir, { withFileTypes: true });
  } catch {
    return false;
  }
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const sessionId = e.name.slice(0, -'.jsonl'.length);
    if (sessionId === currentSessionId) continue;
    if (lastSession.hasSummary(projectId, sessionId)) continue; // barato: 1 stat, ya tiene resumen
    let st;
    try {
      st = fs.statSync(path.join(transcriptsDir, e.name));
    } catch {
      continue;
    }
    if (st.mtimeMs < cutoff) continue;
    // Sin esto el aviso "llegara en el primer prompt" salia en casi todos los
    // arranques: los transcripts de `claude -p` y las sesiones de un solo
    // prompt nunca se resumen, pero la candidata barata los contaba igual.
    if (isKnownNonCandidate(sessionId, st.mtimeMs)) continue;
    return true; // basta con UNA; la fina la hace selectPreviousSession()
  }
  return false;
}

function attemptsPath(sessionId) {
  return path.join(ATTEMPTS_DIR, `${safeId(sessionId)}.json`);
}

function readAttempts(sessionId) {
  try {
    const o = JSON.parse(fs.readFileSync(attemptsPath(sessionId), 'utf8'));
    return {
      failures: Number(o.failures) || 0,
      last_failure_at: Number(o.last_failure_at) || 0,
      trivial_mtime: Number(o.trivial_mtime) || 0,
    };
  } catch {
    return { failures: 0, last_failure_at: 0, trivial_mtime: 0 };
  }
}

/**
 * Recuerda que `sessionId`, con el transcript en `mtimeMs`, tiene menos de
 * MIN_USER_PROMPTS prompts reales. Si el transcript vuelve a crecer (la sesion
 * se retomo), el mtime cambia y la marca deja de valer.
 */
function markTrivial(sessionId, mtimeMs) {
  try {
    fs.mkdirSync(ATTEMPTS_DIR, { recursive: true });
    const p = attemptsPath(sessionId);
    const tmp = `${p}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ ...readAttempts(sessionId), trivial_mtime: Math.floor(mtimeMs) }));
    fs.renameSync(tmp, p);
  } catch {
    /* best effort: sin marca, la candidata barata solo avisara de mas */
  }
}

/** ¿Ya se sabe que esta sesion no se va a resumir (trivial sin cambios, o abandonada)? */
function isKnownNonCandidate(sessionId, mtimeMs) {
  const a = readAttempts(sessionId);
  if (a.failures >= ABANDON_AFTER_FAILURES) return true;
  return a.trivial_mtime > 0 && a.trivial_mtime === Math.floor(mtimeMs);
}

/** Registra un fallo de la LLM secundaria para `sessionId`. Devuelve el estado tras contarlo. */
function recordFailure(sessionId) {
  const prev = readAttempts(sessionId);
  const next = { failures: prev.failures + 1, last_failure_at: Date.now() };
  try {
    fs.mkdirSync(ATTEMPTS_DIR, { recursive: true });
    const p = attemptsPath(sessionId);
    const tmp = `${p}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, p);
  } catch {
    /* best effort: sin fichero, el backoff simplemente no se aplica */
  }
  return next;
}

/** Limpia el historial de fallos tras un exito (mandamiento 1: no mentir sobre el estado). */
function clearAttempts(sessionId) {
  try {
    fs.rmSync(attemptsPath(sessionId), { force: true });
  } catch {
    /* best effort */
  }
}

function quotaCooldownPath() {
  return path.join(ATTEMPTS_DIR, '_quota-cooldown.json');
}

/** ¿Todos los intentos de la cadena fallaron por cuota (HTTP 429)? */
function isQuotaExhausted(attempts) {
  return Array.isArray(attempts) && attempts.length > 0 && attempts.every((a) => /HTTP 429\b/.test(String(a)));
}

/** Congela todos los resumenes durante QUOTA_COOLDOWN_MIN (best effort). */
function recordQuotaCooldown(reason) {
  try {
    fs.mkdirSync(ATTEMPTS_DIR, { recursive: true });
    const p = quotaCooldownPath();
    const tmp = `${p}.tmp.${process.pid}`;
    const until = Date.now() + QUOTA_COOLDOWN_MIN * 60 * 1000;
    fs.writeFileSync(tmp, JSON.stringify({ until, reason: String(reason || '').slice(0, 200) }));
    fs.renameSync(tmp, p);
  } catch {
    /* best effort: sin fichero, la siguiente pasada vuelve a intentarlo */
  }
}

/** Milisegundos que quedan de congelacion por cuota (0 = se puede llamar a la LLM). */
function quotaCooldownRemainingMs() {
  try {
    const o = JSON.parse(fs.readFileSync(quotaCooldownPath(), 'utf8'));
    return Math.max(0, Number(o.until) - Date.now()) || 0;
  } catch {
    return 0;
  }
}

/** Motivo por el que NO se debe reintentar `sessionId` ahora mismo, o null. */
function backoffReason(sessionId) {
  const a = readAttempts(sessionId);
  if (a.failures >= ABANDON_AFTER_FAILURES) return `abandonada tras ${a.failures} fallos`;
  if (a.failures >= BACKOFF_AFTER_FAILURES && Date.now() - a.last_failure_at < BACKOFF_MS) {
    return `en backoff (${a.failures} fallos, reintento tras 6h desde el ultimo)`;
  }
  return null;
}

/**
 * Margen para dar por VIEJO un summary.md: si el transcript siguio escribiendose
 * mas de esto despues de generarse el resumen, la sesion continuo y el resumen
 * no la cubre. Caso real (2026-09-21): resumen a las 17:29, sesion hasta las
 * 18:35; el arranque del 22 no sabia nada de la rama maria-core. Los hooks de
 * Stop tocan el transcript segundos despues del ultimo turno: 10 min de margen
 * evita regenerar por ese ruido.
 */
const SUMMARY_STALE_GRACE_MS = 10 * 60 * 1000;

/** ¿El summary.md (si existe) cubre el transcript, o la sesion siguio despues? */
function summaryCoversTranscript(summaryMtimeMs, transcriptMtimeMs) {
  if (summaryMtimeMs === null) return false;
  return transcriptMtimeMs <= summaryMtimeMs + SUMMARY_STALE_GRACE_MS;
}

/**
 * Sesion anterior mas reciente que merece resumen: distinta de la actual, con
 * >=MIN_USER_PROMPTS prompts reales, modificada dentro de MAX_AGE_DAYS, sin
 * summary.md todavia (o con uno VIEJO, ver summaryCoversTranscript) y sin
 * backoff/abandono activo (una candidata en backoff se SALTA, no bloquea a la
 * siguiente).
 * @returns {{sessionId: string, transcriptPath: string}|null}
 */
function selectPreviousSession({ transcriptsDir, currentSessionId, projectId }) {
  let entries;
  try {
    entries = fs.readdirSync(transcriptsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const candidates = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const sessionId = e.name.slice(0, -'.jsonl'.length);
    if (sessionId === currentSessionId) continue;
    let st;
    try {
      st = fs.statSync(path.join(transcriptsDir, e.name));
    } catch {
      continue;
    }
    if (st.mtimeMs < cutoff) continue;
    // Ya tiene resumen y la sesion no siguio despues: nada que hacer. Un
    // resumen escrito a mitad de sesion se regenera (writeSummaryAtomic pisa).
    if (summaryCoversTranscript(lastSession.summaryMtimeMs(projectId, sessionId), st.mtimeMs)) continue;
    candidates.push({ sessionId, transcriptPath: path.join(transcriptsDir, e.name), mtimeMs: st.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const c of candidates) {
    if (backoffReason(c.sessionId)) continue;
    if (isKnownNonCandidate(c.sessionId, c.mtimeMs)) continue;
    const parsed = digest.readTranscriptEntries(c.transcriptPath);
    if (digest.isWorthSummarizing(parsed)) return c;
    markTrivial(c.sessionId, c.mtimeMs);
  }
  return null;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Escribe `file` con {pid, started_at}, solo si no existe ya (atomico via 'wx'). */
function tryCreateLock(file) {
  try {
    const fd = fs.openSync(file, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, started_at: Date.now() }));
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lock single-flight por sesion objetivo (gotcha: drains solapados duplicaron
 * trabajo -- ver memoria `gotcha-drains-solapados-duplicados`). Un lock cuyo
 * dueno ya no esta vivo, o mas viejo que STALE_LOCK_MS, se considera huerfano
 * y se reclama.
 * @returns {string|null} ruta del lock adquirido, o null si otra instancia lo tiene
 */
function acquireLock(sessionId) {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const file = path.join(LOCK_DIR, `${safeId(sessionId)}.lock`);
  if (tryCreateLock(file)) return file;
  try {
    const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
    const stale = !isPidAlive(prev.pid) || Date.now() - prev.started_at > STALE_LOCK_MS;
    if (!stale) return null; // otra instancia legitima en marcha
    fs.rmSync(file, { force: true });
  } catch {
    return null; // lock ilegible: mejor no arriesgar una carrera
  }
  return tryCreateLock(file) ? file : null;
}

function releaseLock(file) {
  try {
    if (file) fs.rmSync(file, { force: true });
  } catch {
    /* best effort */
  }
}

const SUMMARY_SYSTEM = [
  'Eres un asistente que resume sesiones de trabajo de un desarrollador para que',
  'su PROXIMA sesion arranque con contexto real. El usuario te pasa el',
  'contenido de una sesion de Claude Code (prompts del usuario y texto del',
  'asistente; las llamadas a herramientas ya se han quitado).',
  '',
  'Genera un resumen en espanol, en Markdown, con EXACTAMENTE estas 6 secciones',
  'y un maximo de 50 lineas en total:',
  '',
  '## Temas',
  '## Decisiones',
  '(indica quien decidio -- el usuario o el asistente -- cuando se pueda inferir)',
  '## Pendientes',
  '## Ficheros/commits relevantes',
  '## Cierres propuestos',
  '(tarjetas de la lista TARJETAS ABIERTAS DEL KANBAN cuyo trabajo la sesion deja',
  'TERMINADO -- no a medias ni solo empezado. Una por linea con el formato',
  '"<id exacto de la lista> | motivo breve". Solo ids de esa lista; sin lista o',
  'sin cierres claros: "(nada relevante)")',
  '## Tarjetas nuevas',
  '(como maximo 3: trabajo pendiente CONCRETO que la sesion deja abierto y que no',
  'este ya en la lista de tarjetas abiertas. Una por linea con el formato',
  '"todo | Titulo corto" o "doing | Titulo corto" (doing si se quedo a medias).',
  'Nada de ideas vagas ni de lo ya hecho; sin nada: "(nada relevante)")',
  '',
  'Reglas: no inventes nada que no este en el texto de la sesion; si una seccion no',
  'tiene contenido, escribe "(nada relevante)"; sintetiza, no copies el texto',
  'integro. Responde SOLO con el Markdown de las 6 secciones, sin preambulo.',
].join('\n');

/**
 * Mensajes para la LLM: instrucciones fijas (system) y la sesion (user), con
 * las tarjetas abiertas del kanban detras si las hay (lib/kanban-auto.js).
 */
function buildPrompt(digestText, openCardsBlock = '') {
  const user = ['--- INICIO SESION ---', digestText, '--- FIN SESION ---'];
  if (openCardsBlock) user.push('', openCardsBlock);
  return { system: SUMMARY_SYSTEM, user: user.join('\n') };
}

/** Motivo por el que kanban-auto no toca el tablero del proyecto, o ''. */
function kanbanAutoExclusion(projectId) {
  if (process.env.KANBAN_AUTO_DISABLED === '1') return 'KANBAN_AUTO_DISABLED=1';
  const tracker = externalTrackerFor(projectId);
  if (tracker) return `tracker externo (${tracker})`;
  return isManualKanban(projectId) ? 'kanban:manual' : '';
}

/** Tablero del proyecto o null (sin kanban.json, JSON roto). */
function readBoard(projectId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lastSession.projectsDir(), safeId(projectId), 'kanban.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Aplica al kanban los cierres y tarjetas nuevas de la bitacora recien
 * escrita. Un fallo se registra y no toca la bitacora.
 */
function applyKanbanAuto(projectId, sessionId, summaryText, excluded) {
  try {
    const r = kanbanAuto.applyFromSummary({
      projectsDir: lastSession.projectsDir(),
      projectId: safeId(projectId),
      sessionId,
      summary: summaryText,
      excluded,
    });
    if (r.applied || r.skipped) logResult({ project: projectId, session_id: sessionId, kanban_auto: r });
  } catch (e) {
    logHookError('session-summarize-previous', e);
  }
}

/** Quita un envoltorio ```markdown ... ``` si el modelo lo anade. */
function stripFence(text) {
  const raw = String(text || '').trim();
  const m = /^\`\`\`(?:markdown|md)?[ \t]*\r?\n([\s\S]*?)\r?\n\`\`\`$/.exec(raw);
  return (m ? m[1] : raw).trim();
}

/** Prompt unico para Codex: `codex exec` recibe un solo mensaje por stdin. */
function buildCodexPrompt(prompt) {
  return [
    prompt.system,
    '',
    'No ejecutes comandos ni leas o escribas ficheros: todo lo que necesitas esta',
    'en este mensaje. Tu respuesta final es el Markdown del resumen, nada mas.',
    '',
    prompt.user,
  ].join('\n');
}

/**
 * Resume con Codex CLI. Se llama al modulo en el momento para que los tests
 * puedan sustituir askCodex.
 * @returns {Promise<{ok: true, text: string, model: string}|{ok: false, error: string}>}
 */
async function summarizeWithCodex(prompt) {
  let res;
  try {
    res = await require('./lib/codex-exec').askCodex({
      prompt: buildCodexPrompt(prompt),
      model: CODEX_MODEL,
      reasoningEffort: CODEX_EFFORT,
      timeoutMs: CODEX_TIMEOUT_MS,
    });
  } catch (e) {
    return { ok: false, error: `codex lanzo: ${String((e && e.message) || e)}` };
  }
  if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'codex: sin respuesta' };
  const text = stripFence(res.text);
  if (!text) return { ok: false, error: 'codex: resumen vacio' };
  return { ok: true, text, model: `codex/${res.model}` };
}

/**
 * Cadena completa: Codex y, si falla, Groq -> Gemini. `quota` solo refleja la
 * cadena secundaria (un Codex caido no congela nada por si solo).
 * @returns {Promise<{ok: true, text: string, model: string, codexError?: string}
 *                  |{ok: false, error: string, quota: boolean}>}
 */
async function summarize(prompt) {
  let codexError = null;
  if (CODEX_ENABLED) {
    const c = await summarizeWithCodex(prompt);
    if (c.ok) return c;
    codexError = c.error;
  }
  const r = await summarizeWithSecondaryLlm(prompt);
  if (!codexError) return r;
  return r.ok ? { ...r, codexError } : { ...r, error: `${codexError}; ${r.error}` };
}

/**
 * Resume con la LLM secundaria (Groq -> Gemini). Se llama al modulo en el
 * momento (no destructurado al cargar) para que los tests puedan sustituir
 * askText sin red.
 * @returns {Promise<{ok: true, text: string, model: string}|{ok: false, error: string, quota: boolean}>}
 */
async function summarizeWithSecondaryLlm(prompt) {
  let res;
  try {
    res = await require('./lib/secondary-llm').askText({
      system: prompt.system,
      user: prompt.user,
      deadlineMs: TIMEOUT_MS,
      maxTokens: SUMMARY_MAX_TOKENS,
      chain: SUMMARY_CHAIN,
    });
  } catch (e) {
    return { ok: false, error: `LLM secundaria lanzo: ${String((e && e.message) || e)}`, quota: false };
  }
  if (!res || !res.ok) {
    const error = `LLM secundaria: ${(res && res.error) || 'sin respuesta'}`;
    return { ok: false, error, quota: isQuotaExhausted(res && res.attempts) };
  }
  const text = stripFence(res.text);
  if (!text) return { ok: false, error: 'LLM secundaria: resumen vacio', quota: false };
  return { ok: true, text, model: `${res.provider}/${res.model}` };
}

/** Huella corta del digest: si no cambia, el resumen existente sigue valiendo. */
function digestSha(text) {
  return require('crypto').createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

/** `digest_sha` del frontmatter del summary.md existente, o null. */
function existingDigestSha(projectId, sessionId) {
  try {
    const head = fs.readFileSync(lastSession.summaryPath(projectId, sessionId), 'utf8').slice(0, 1024);
    const m = /^digest_sha: ([0-9a-f]{16})$/m.exec(head);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function summaryHeader({ sessionId, range, model, generatedAt, digestShaValue }) {
  return [
    '---',
    `session_id: ${sessionId}`,
    `rango: ${(range && range.start) || '?'} .. ${(range && range.end) || '?'}`,
    `modelo: ${model}`,
    `generated_at: ${generatedAt}`,
    ...(digestShaValue ? [`digest_sha: ${digestShaValue}`] : []),
    '---',
    '',
    '',
  ].join('\n');
}

function writeSummaryAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function logResult(rec) {
  appendJsonl(LOG_PATH, rec);
}

/**
 * Fusiona la bitacora recien escrita en el estado vivo del proyecto
 * (lib/project-state.js, LLM secundaria: Groq -> Gemini). Proceso aparte y
 * sincrono (este script ya corre desacoplado). `rebuild --last 3` es
 * idempotente: fusiona esta bitacora y recupera las 2 anteriores si su fusion
 * fallo (429 de Groq, red). Un fallo no toca el summary.md ya escrito.
 * Opt-out: PROJECT_STATE_DISABLED=1.
 */
function mergeIntoProjectState(projectId, sessionId) {
  if (process.env.PROJECT_STATE_DISABLED === '1') return;
  try {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'lib', 'project-state.js'), 'rebuild', '--project', projectId, '--last', '3'], {
      encoding: 'utf8',
      timeout: 150000,
      windowsHide: true,
    });
    logResult({ project: projectId, session_id: sessionId, project_state: (r.stdout || '').trim().slice(0, 300) || `status ${r.status}` });
  } catch (e) {
    logHookError('session-summarize-previous', e);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd') out.cwd = argv[++i];
    else if (a === '--session') out.session = argv[++i];
    else if (a === '--project') out.project = argv[++i];
    else if (a === '--target-session') out.targetSession = argv[++i]; // verificacion manual / SessionEnd: fuerza la sesion a resumir
    else if (a === '--transcript') out.transcript = argv[++i]; // SessionEnd: transcript_path del hook
  }
  return out;
}

async function main() {
  observe('session-summarize-previous');
  // FAIL-CLOSED (hallazgo MEDIUM): el digest sale de la maquina hacia
  // el proveedor externo y summary.md se inyecta luego en otra sesion. Sin redaccion
  // real, mejor no resumir que arriesgar un secreto sin redactar.
  if (!securityHelpersLoaded) {
    return logResult({ skipped: 'sin redaccion (fail-closed): security-helpers.js no cargo' });
  }

  const args = parseArgs(process.argv.slice(2));
  const cwd = args.cwd || process.cwd();
  const projectId = args.project || resolveProjectId(cwd);
  if (!projectId) return logResult({ skipped: 'sin project_id', cwd });
  const coolMs = quotaCooldownRemainingMs();
  if (coolMs > 0) {
    return logResult({ project: projectId, skipped: `cuota de la LLM secundaria agotada: pausa ${Math.ceil(coolMs / 60000)} min` });
  }

  // `--transcript` (SessionEnd, 2026-09-22): el hook trae transcript_path; con
  // el se resuelve el directorio real aunque el cwd no case con el slug (worktrees).
  const transcriptsDir = transcriptsDirFor(cwd, args.transcript || null);
  const target = args.targetSession
    ? { sessionId: args.targetSession, transcriptPath: path.join(transcriptsDir, `${args.targetSession}.jsonl`) }
    : selectPreviousSession({ transcriptsDir, currentSessionId: args.session, projectId });
  if (!target) return logResult({ project: projectId, skipped: 'sin sesion anterior candidata' });

  const lock = acquireLock(target.sessionId);
  if (!lock) {
    return logResult({ project: projectId, session_id: target.sessionId, skipped: 'lock ocupado (otra instancia en marcha)' });
  }

  const t0 = Date.now();
  try {
    const entries = digest.readTranscriptEntries(target.transcriptPath);
    if (!digest.isWorthSummarizing(entries)) {
      try {
        markTrivial(target.sessionId, fs.statSync(target.transcriptPath).mtimeMs);
      } catch {
        /* transcript desaparecido: no hay nada que marcar */
      }
      return logResult({ project: projectId, session_id: target.sessionId, skipped: 'sin sustancia (menos de 2 prompts reales y menos de 20 turnos)' });
    }
    // Redaccion ANTES de que el digest salga de la maquina.
    const digestText = redactSecrets(digest.buildDigest(entries, { maxChars: MAX_DIGEST_CHARS }));
    const range = digest.sessionTimeRange(entries);
    const sha = digestSha(digestText);
    // Transcript tocado sin contenido nuevo (cost-state, away_summary, bridge
    // de una sesion remota): el 25-09 la misma sesion se re-resumio 10 veces
    // con el mismo digest. Se da el resumen por vigente sin llamar a la LLM.
    if (existingDigestSha(projectId, target.sessionId) === sha) {
      const now = new Date();
      fs.utimesSync(lastSession.summaryPath(projectId, target.sessionId), now, now);
      return logResult({ project: projectId, session_id: target.sessionId, skipped: 'digest sin cambios: resumen vigente' });
    }
    const kanbanExcluded = kanbanAutoExclusion(projectId);
    const openCardsBlock = kanbanExcluded ? '' : redactSecrets(kanbanAuto.renderOpenCardsBlock(readBoard(projectId)));
    const result = await summarize(buildPrompt(digestText, openCardsBlock));
    if (!result.ok) {
      logHookError('session-summarize-previous', result.error);
      if (result.quota) {
        // Global y transitorio: no penaliza a la sesion (no la acerca al abandono).
        recordQuotaCooldown(result.error);
        return logResult({ project: projectId, session_id: target.sessionId, ok: false, quota: true, error: result.error, ms: Date.now() - t0 });
      }
      const attempts = recordFailure(target.sessionId);
      return logResult({ project: projectId, session_id: target.sessionId, ok: false, error: result.error, ms: Date.now() - t0, failures: attempts.failures });
    }
    // Redaccion de nuevo sobre el resultado (defensa en profundidad: el modelo
    // podria haber citado algo del digest en su resumen) ANTES de escribir a disco.
    const redactedText = redactSecrets(result.text);
    const header = summaryHeader({ sessionId: target.sessionId, range, model: result.model, generatedAt: new Date().toISOString(), digestShaValue: sha });
    writeSummaryAtomic(lastSession.summaryPath(projectId, target.sessionId), header + redactedText + '\n');
    clearAttempts(target.sessionId);
    applyKanbanAuto(projectId, target.sessionId, redactedText, kanbanExcluded);
    logResult({
      project: projectId,
      session_id: target.sessionId,
      ok: true,
      modelo: result.model,
      ms: Date.now() - t0,
      digest_chars: digestText.length,
      ...(result.codexError ? { codex_error: result.codexError } : {}),
    });
    mergeIntoProjectState(projectId, target.sessionId);
  } catch (e) {
    logHookError('session-summarize-previous', e);
    logResult({ project: projectId, session_id: target.sessionId, ok: false, error: String((e && e.message) || e) });
  } finally {
    releaseLock(lock);
  }
}

if (require.main === module) {
  main()
    .catch((e) => {
      try { logHookError('session-summarize-previous', e); } catch { /* ignore */ }
    })
    .finally(() => {
      process.exitCode = 0;
    });
} else {
  module.exports = {
    cwdToSlug,
    transcriptsDirFor,
    hasCheapPendingCandidate,
    selectPreviousSession,
    markTrivial,
    isKnownNonCandidate,
    summaryCoversTranscript,
    SUMMARY_STALE_GRACE_MS,
    acquireLock,
    releaseLock,
    buildPrompt,
    kanbanAutoExclusion,
    stripFence,
    summarizeWithSecondaryLlm,
    summarizeWithCodex,
    summarize,
    buildCodexPrompt,
    SUMMARY_CHAIN,
    CODEX_MODEL,
    summaryHeader,
    writeSummaryAtomic,
    parseArgs,
    readAttempts,
    recordFailure,
    clearAttempts,
    backoffReason,
    isQuotaExhausted,
    recordQuotaCooldown,
    quotaCooldownRemainingMs,
    digestSha,
    existingDigestSha,
    securityHelpersLoaded,
    main,
  };
}
