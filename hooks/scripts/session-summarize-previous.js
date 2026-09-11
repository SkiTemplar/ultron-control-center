#!/usr/bin/env node
/**
 * session-summarize-previous.js — genera el resumen de la SESION ANTERIOR del
 * mismo proyecto con `claude -p` (Sonnet, misma suscripcion OAuth que la
 * sesion interactiva -- NUNCA API key de pago por token: ver README abajo).
 *
 * NO es un hook de Claude Code: lo lanza memory-session-resume.js (SessionStart)
 * como proceso totalmente desacoplado, porque `claude -p` tarda 20-40s y
 * SessionStart no puede bloquear la apertura de sesion ese tiempo. Si no
 * termina a tiempo, memory-orchestrate.js entrega el resumen en el primer
 * prompt (ver lib/session-summary-delivery.js).
 *
 * Flujo:
 *   1. Localiza ~/.claude/projects/<slug>/ (transcripts del cwd).
 *   2. Elige la sesion anterior mas reciente que: no sea la actual, tenga
 *      >=2 prompts reales, se haya modificado en los ultimos MAX_AGE_DAYS
 *      dias y no tenga summary.md todavia.
 *   3. Construye el digest (lib/session-digest.js) y llama a `claude -p`.
 *   4. Escribe cockpit/projects/<projectId>/sessions/<sessionId>/summary.md
 *      (atomico, con cabecera de procedencia). NUNCA escribe en brain.db.
 *
 * Anti-recursion (`claude -p` dispara su propio SessionStart si no se corta):
 *   - `--safe-mode`: Claude Code desactiva TODOS los hooks (entre otras cosas)
 *     para esa sesion. Verificado en runtime 2026-09-11: con --safe-mode no
 *     aparece ninguna entrada nueva en hook-timing.jsonl durante la llamada.
 *   - `CLAUDE_NO_HOOKS=1` en el entorno del hijo: por si algun hook se
 *     invocara pese a --safe-mode, todos los hooks de este repo lo comprueban
 *     al entrar y no hacen nada.
 *   - Variable propia `ULTRON_SUMMARY_SUBPROCESS=1`: comprobada al inicio de
 *     este mismo script (main()) por si, pese a lo anterior, algo volviera a
 *     invocarlo dentro del arbol del hijo.
 *
 * Auth (`--bare` vs `--safe-mode`, verificado en runtime 2026-09-11):
 *   `--bare` fuerza auth por ANTHROPIC_API_KEY/apiKeyHelper (nunca OAuth) --
 *   con la ANTHROPIC_API_KEY del entorno de ULTRON (AI Router) la llamada
 *   fallo con "Credit balance is too low" (API de pago, no la suscripcion).
 *   `--safe-mode` SI deja usar la sesion OAuth interactiva, pero solo si
 *   ANTHROPIC_API_KEY no esta en el entorno del hijo (si esta, `claude -p` la
 *   prioriza igual que --bare). Por eso runClaude() borra esa variable del
 *   entorno del hijo antes de lanzar el proceso -- confirmado: sin la key,
 *   `claude -p --safe-mode` cobra de la suscripcion Sonnet (total_cost_usd
 *   notional del plan, no facturacion por token).
 *
 * Redaccion (revision de codigo 2026-09-11, hallazgo MEDIUM): el digest sale
 * de la maquina hacia `claude -p` y summary.md se inyecta luego en el
 * contexto de otra sesion, asi que ambos pasan por lib/security-helpers.js
 * (los mismos patrones que stop-compress-session.js/project-profile.js)
 * ANTES de salir/escribirse. FAIL-CLOSED: si el modulo no carga, main() no
 * resume nada (mandamiento de seguridad: mejor sin resumen que sin redactar).
 *
 * Backoff por sesion objetivo (hallazgo LOW/MEDIUM): un fallo de `claude -p`
 * se cuenta en ~/.ultron/.tmp/session-summary-attempts/<sessionId>.json. Con
 * 2 fallos, esa sesion no se reintenta durante BACKOFF_MS (6h); con 5, se
 * abandona (selectPreviousSession la salta y prueba la siguiente candidata).
 * `--target-session` (verificacion manual) IGNORA el backoff a proposito.
 *
 * Seams de test (ninguno toca el sistema real):
 *   SESSION_SUMMARY_CLAUDE_BIN        binario de claude a invocar (stub en tests)
 *   SESSION_SUMMARY_PROJECTS_DIR      raiz de cockpit/projects
 *   SESSION_SUMMARY_LOCK_DIR          directorio de locks single-flight
 *   SESSION_SUMMARY_LOG               ruta del log jsonl
 *   SESSION_SUMMARY_TRANSCRIPTS_DIR   fuerza el directorio de transcripts (salta el slug)
 *   SESSION_SUMMARY_ATTEMPTS_DIR      directorio del backoff por sesion objetivo
 *   SESSION_SUMMARY_MAX_AGE_DAYS      edad maxima de una sesion candidata (dias)
 *   SESSION_SUMMARY_TIMEOUT_MS        timeout de la llamada a claude -p
 *   SESSION_SUMMARY_MAX_CHARS         tope de caracteres del digest
 *   SESSION_SUMMARY_MODEL             modelo (default: sonnet)
 *   SESSION_SUMMARY_FORCE_NO_REDACTION  1 = simula que security-helpers.js no
 *                                        cargo (solo tests del fail-closed)
 *
 * NO-OP-SAFE: cualquier fallo (sin candidata, lock ocupado, sin redaccion,
 * claude -p falla o hace timeout, JSON no parseable) sale con 0 y sin escribir
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

const HOME = os.homedir();
const LOG_PATH = process.env.SESSION_SUMMARY_LOG || path.join(HOME, '.ultron', 'logs', 'session-summary.jsonl');
const LOCK_DIR = process.env.SESSION_SUMMARY_LOCK_DIR || path.join(HOME, '.ultron', 'run', 'session-summary');
const ATTEMPTS_DIR = process.env.SESSION_SUMMARY_ATTEMPTS_DIR || path.join(HOME, '.ultron', '.tmp', 'session-summary-attempts');
const MODEL = process.env.SESSION_SUMMARY_MODEL || 'sonnet';
const MAX_AGE_DAYS = Number(process.env.SESSION_SUMMARY_MAX_AGE_DAYS) || 7;
const MIN_USER_PROMPTS = 2;
const TIMEOUT_MS = Number(process.env.SESSION_SUMMARY_TIMEOUT_MS) || 180000;
const MAX_DIGEST_CHARS = Number(process.env.SESSION_SUMMARY_MAX_CHARS) || digest.DEFAULT_MAX_CHARS;
const STALE_LOCK_MS = TIMEOUT_MS + 60000;
const GUARD_ENV = 'ULTRON_SUMMARY_SUBPROCESS';
// Backoff por sesion objetivo (ver cabecera del fichero).
const BACKOFF_AFTER_FAILURES = 2;
const BACKOFF_MS = 6 * 60 * 60 * 1000;
const ABANDON_AFTER_FAILURES = 5;

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
    return { failures: Number(o.failures) || 0, last_failure_at: Number(o.last_failure_at) || 0 };
  } catch {
    return { failures: 0, last_failure_at: 0 };
  }
}

/** Registra un fallo de `claude -p` para `sessionId`. Devuelve el estado tras contarlo. */
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
 * Sesion anterior mas reciente que merece resumen: distinta de la actual, con
 * >=MIN_USER_PROMPTS prompts reales, modificada dentro de MAX_AGE_DAYS, sin
 * summary.md todavia y sin backoff/abandono activo (una candidata en backoff
 * se SALTA, no bloquea a la siguiente).
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
    if (lastSession.hasSummary(projectId, sessionId)) continue; // ya tiene resumen
    let st;
    try {
      st = fs.statSync(path.join(transcriptsDir, e.name));
    } catch {
      continue;
    }
    if (st.mtimeMs < cutoff) continue;
    candidates.push({ sessionId, transcriptPath: path.join(transcriptsDir, e.name), mtimeMs: st.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const c of candidates) {
    if (backoffReason(c.sessionId)) continue;
    const parsed = digest.readTranscriptEntries(c.transcriptPath);
    if (digest.extractUserPrompts(parsed).length >= MIN_USER_PROMPTS) return c;
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

function resolveClaudeBin() {
  if (process.env.SESSION_SUMMARY_CLAUDE_BIN) return process.env.SESSION_SUMMARY_CLAUDE_BIN;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const candidate = path.join(HOME, '.local', 'bin', exe);
  try {
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    /* cae al PATH */
  }
  return 'claude';
}

function buildPrompt(digestText) {
  return [
    'Eres un asistente que resume sesiones de trabajo de un desarrollador para que',
    'su PROXIMA sesion arranque con contexto real. A continuacion tienes el',
    'contenido de una sesion de Claude Code (prompts del usuario y texto del',
    'asistente; las llamadas a herramientas ya se han quitado).',
    '',
    'Genera un resumen en espanol, en Markdown, con EXACTAMENTE estas 4 secciones',
    'y un maximo de 40 lineas en total:',
    '',
    '## Temas',
    '## Decisiones',
    '(indica quien decidio -- el usuario o el asistente -- cuando se pueda inferir)',
    '## Pendientes',
    '## Ficheros/commits relevantes',
    '',
    'Reglas: no inventes nada que no este en el texto de abajo; si una seccion no',
    'tiene contenido, escribe "(nada relevante)"; sintetiza, no copies el texto',
    'integro. Responde SOLO con el Markdown de las 4 secciones, sin preambulo.',
    '',
    '--- INICIO SESION ---',
    digestText,
    '--- FIN SESION ---',
  ].join('\n');
}

/**
 * Llama a `claude -p` de forma sincrona (este script YA corre desacoplado del
 * hook que lo lanzo, asi que bloquearse aqui es seguro). Ver cabecera del
 * fichero para el porque de cada flag.
 * @returns {{ok: true, text: string, model: string}|{ok: false, error: string}}
 */
function runClaude(promptText) {
  const bin = resolveClaudeBin();
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // fuerza la suscripcion OAuth, no pago por token
  env[GUARD_ENV] = '1';
  env.CLAUDE_NO_HOOKS = '1';
  const args = [
    '-p',
    '--model', MODEL,
    '--safe-mode',
    '--tools', '',
    '--no-session-persistence',
    '--output-format', 'json',
    promptText, // ultimo: verificado en runtime con esta misma posicion (ver cabecera)
  ];
  let res;
  try {
    res = spawnSync(bin, args, {
      cwd: os.tmpdir(), // fuera de cualquier proyecto: sin CLAUDE.md que cargar
      env,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    return { ok: false, error: `spawnSync lanzo: ${String((e && e.message) || e)}` };
  }
  if (!res) return { ok: false, error: 'spawnSync sin resultado' };
  if (res.error) return { ok: false, error: `spawnSync error: ${String(res.error.message || res.error)}` };
  if (res.signal) return { ok: false, error: `claude -p señal ${res.signal} (probable timeout de ${TIMEOUT_MS} ms)` };
  if (res.status !== 0) {
    return { ok: false, error: `claude -p status=${res.status}: ${String(res.stderr || '').slice(0, 300)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (e) {
    return { ok: false, error: `salida no-JSON de claude -p: ${String(e.message)}` };
  }
  if (parsed.is_error || typeof parsed.result !== 'string' || !parsed.result.trim()) {
    return { ok: false, error: `claude -p is_error=${!!parsed.is_error}: ${String(parsed.result || '').slice(0, 300)}` };
  }
  return { ok: true, text: parsed.result.trim(), model: MODEL };
}

function summaryHeader({ sessionId, range, model, generatedAt }) {
  return [
    '---',
    `session_id: ${sessionId}`,
    `rango: ${(range && range.start) || '?'} .. ${(range && range.end) || '?'}`,
    `modelo: ${model}`,
    `generated_at: ${generatedAt}`,
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

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd') out.cwd = argv[++i];
    else if (a === '--session') out.session = argv[++i];
    else if (a === '--project') out.project = argv[++i];
    else if (a === '--target-session') out.targetSession = argv[++i]; // verificacion manual: fuerza la sesion a resumir
  }
  return out;
}

function main() {
  observe('session-summarize-previous');
  if (process.env[GUARD_ENV] === '1') {
    logResult({ skipped: 'guardia anti-recursion: subproceso de claude -p' });
    return;
  }
  // FAIL-CLOSED (hallazgo MEDIUM): el digest sale de la maquina hacia
  // claude -p y summary.md se inyecta luego en otra sesion. Sin redaccion
  // real, mejor no resumir que arriesgar un secreto sin redactar.
  if (!securityHelpersLoaded) {
    return logResult({ skipped: 'sin redaccion (fail-closed): security-helpers.js no cargo' });
  }

  const args = parseArgs(process.argv.slice(2));
  const cwd = args.cwd || process.cwd();
  const projectId = args.project || resolveProjectId(cwd);
  if (!projectId) return logResult({ skipped: 'sin project_id', cwd });

  const transcriptsDir = transcriptsDirFor(cwd, null);
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
    if (digest.extractUserPrompts(entries).length < MIN_USER_PROMPTS) {
      return logResult({ project: projectId, session_id: target.sessionId, skipped: 'menos de 2 prompts reales' });
    }
    // Redaccion ANTES de que el digest salga de la maquina hacia claude -p.
    const digestText = redactSecrets(digest.buildDigest(entries, { maxChars: MAX_DIGEST_CHARS }));
    const range = digest.sessionTimeRange(entries);
    const result = runClaude(buildPrompt(digestText));
    if (!result.ok) {
      logHookError('session-summarize-previous', result.error);
      const attempts = recordFailure(target.sessionId);
      return logResult({ project: projectId, session_id: target.sessionId, ok: false, error: result.error, ms: Date.now() - t0, failures: attempts.failures });
    }
    // Redaccion de nuevo sobre el resultado (defensa en profundidad: el modelo
    // podria haber citado algo del digest en su resumen) ANTES de escribir a disco.
    const redactedText = redactSecrets(result.text);
    const header = summaryHeader({ sessionId: target.sessionId, range, model: result.model, generatedAt: new Date().toISOString() });
    writeSummaryAtomic(lastSession.summaryPath(projectId, target.sessionId), header + redactedText + '\n');
    clearAttempts(target.sessionId);
    logResult({ project: projectId, session_id: target.sessionId, ok: true, ms: Date.now() - t0, digest_chars: digestText.length });
  } catch (e) {
    logHookError('session-summarize-previous', e);
    logResult({ project: projectId, session_id: target.sessionId, ok: false, error: String((e && e.message) || e) });
  } finally {
    releaseLock(lock);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    try { logHookError('session-summarize-previous', e); } catch { /* ignore */ }
  }
  process.exitCode = 0;
} else {
  module.exports = {
    cwdToSlug,
    transcriptsDirFor,
    hasCheapPendingCandidate,
    selectPreviousSession,
    acquireLock,
    releaseLock,
    resolveClaudeBin,
    buildPrompt,
    runClaude,
    summaryHeader,
    writeSummaryAtomic,
    parseArgs,
    readAttempts,
    recordFailure,
    clearAttempts,
    backoffReason,
    securityHelpersLoaded,
    main,
  };
}
