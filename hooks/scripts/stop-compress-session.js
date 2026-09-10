#!/usr/bin/env node
/**
 * Stop hook — compress current session into structured facts (decisions, next
 * steps, bugs) and capture them to the canonical store (brain.db) through the
 * single-writer pipeline.
 *
 * KIRKARDO 14 — Paso 2: stop hook compresor.
 *
 * Flow:
 *   1. Read the transcript JSONL path from stdin payload (field: transcript_path).
 *   2. Parse last N turns (MAX_TURNS = 60) from the JSONL.
 *   3. Propone los hechos extraidos como candidatos gobernados via el UNICO
 *      camino de extraccion: el sidecar `ultron-memory capture` (AI Router con
 *      cadena primary->fallback y las keys del usuario, redaccion, dedupe,
 *      inbox con aprobacion humana). Este script ya NO llama a ningun proveedor
 *      cloud por su cuenta — decidido por el usuario 2026-09-10: la llamada
 *      directa (Groq sin fallback) estaba DUPLICADA con la del sidecar y
 *      fallaba el 51% de las veces (218/426, HTTP 429) sin aportar nada que el
 *      sidecar no hiciera ya mejor.
 *   4. Escribe cockpit/projects/{projectId}/sessions/{session_id}/compact.json
 *      a partir del informe del sidecar (decisions/next/bugs mapeados por
 *      `kind` — ver el comentario de `writeCompact`).
 *   5. Exits 0 always — hook failures must never interrupt user workflow.
 *
 * NOTE: the legacy upsert to the RETIRED Qdrant `ultron_sessions` collection
 * (384-d BGE) was removed (OLA A/B 2026-06-04) — brain.db (governed by
 * MemoryService) is the single source of truth. The dead embedding/qdrant
 * helpers were deleted (2026-06-22).
 *
 * Configuration via env vars:
 *   STOP_COMPRESS_DISABLED=1 / CLAUDE_NO_HOOKS=1 — opt-out
 *   ULTRON_MEMORY_BIN — override del binario del sidecar (tests/selftest)
 *
 * No hay ANTHROPIC_API_KEY ni GROQ_API_KEY aqui: las keys las gestiona el AI
 * Router dentro del binario `ultron-memory` (ver control-center/src-tauri/src/
 * ai_router/), no este script.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn, spawnSync } = require('child_process');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// cat15.1 — observabilidad de duración: registra elapsed_ms en hook-timing.jsonl
// cat9.5  — logHookError en catch top-level: deja rastro sin romper fail-safe
// ---------------------------------------------------------------------------
const { observe, logHookError } = require('./lib/hook-obs');
const { appendJsonl } = require('./lib/jsonl-log');
const { findBinary } = require('./lib/ultron-memory-cli');
// PERF-03: tail acotado del transcript (256 KiB) en vez de leerlo entero.
const { readJsonlTail } = require('./lib/jsonl-tail');
observe('stop-compress-session');

// ---------------------------------------------------------------------------
// Shared security helpers — lib/security-helpers.js (extraidos del antiguo
// mem0-sync.js, borrado 2026-06-08; el require roto degradaba a stubs y
// desactivaba la captura AI para siempre — fix Kirkardo Pass1 C5).
// Fallback gracioso: si el require falla, stubs + fail-closed (sin egress).
// ---------------------------------------------------------------------------

let redactSecrets = (s) => String(s == null ? '' : s);
let loadOptOut = () => ({ projects: [], cwd_patterns: [] });
let isOptedOut = () => false;
let detectProjectName = (cwd) => path.basename(cwd || process.cwd() || 'unknown');
// FAIL-CLOSED: only true once the real security helpers loaded. When false the
// transcript must NOT leave the machine — la captura via el sidecar (que manda
// el transcript al AI Router) se salta entera (ver 'capture_skipped_no_redaction').
let securityHelpersLoaded = false;

try {
  const sec = require('./lib/security-helpers.js');
  if (
    typeof sec.redactSecrets === 'function' &&
    typeof sec.isOptedOut === 'function' &&
    typeof sec.loadOptOut === 'function'
  ) {
    redactSecrets = sec.redactSecrets;
    loadOptOut = sec.loadOptOut;
    isOptedOut = sec.isOptedOut;
    if (typeof sec.detectProjectName === 'function') detectProjectName = sec.detectProjectName;
    if (typeof sec.setLogger === 'function') sec.setLogger((e) => safeLog(e));
    securityHelpersLoaded = true;
  }
} catch (_) {
  // security-helpers.js unavailable — stubs + securityHelpersLoaded=false
  // (fail-closed: no cloud egress below).
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HOME = os.homedir();
const LOG_PATH = path.join(HOME, '.claude', 'logs', 'stop-compress-session.jsonl');
const MAX_TURNS = 60;

// ---------------------------------------------------------------------------
// Logging (rotating via shared appendJsonl)
// ---------------------------------------------------------------------------

function safeLog(entry) {
  appendJsonl(LOG_PATH, entry);
}

// ---------------------------------------------------------------------------
// Stdin
// ---------------------------------------------------------------------------

function readStdinSync() {
  try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; }
}

// ---------------------------------------------------------------------------
// JSONL transcript parser
// ---------------------------------------------------------------------------

/**
 * Extract the last MAX_TURNS messages from a JSONL transcript.
 * Returns an array of { role, text } objects.
 */
function parseTurns(jsonlPath) {
  const lines = readJsonlTail(jsonlPath).filter(l => l.trim());
  const tail = lines.slice(-MAX_TURNS);
  const turns = [];

  for (const line of tail) {
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }

    const type = obj.type || '';
    if (type !== 'user' && type !== 'assistant') continue;

    // Extract first text block (mirrors recall.rs logic).
    const msg = obj.message || obj;
    const content = msg.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) { text = block.text; break; }
      }
    }
    if (text.trim()) turns.push({ role: type, text: text.trim().slice(0, 800) });
  }
  return turns;
}

// ---------------------------------------------------------------------------
// Throttle por sesion
// ---------------------------------------------------------------------------

const CAPTURE_MIN_USER_TURNS = 3;
const CAPTURE_MIN_INTERVAL_MS = 10 * 60 * 1000;

function throttlePath(sessionId) {
  const safe = String(sessionId || 'nosession').replace(/[^A-Za-z0-9_-]/g, '-');
  return path.join(HOME, '.ultron', '.tmp', `stop-compress-${safe}.json`);
}

function readThrottleState(sessionId) {
  try {
    const o = JSON.parse(fs.readFileSync(throttlePath(sessionId), 'utf8'));
    return { user_turns: Number(o.user_turns) || 0, ts: Number(o.ts) || 0 };
  } catch (_) {
    return null;
  }
}

function writeThrottleState(sessionId, state) {
  try {
    const p = throttlePath(sessionId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, p);
  } catch (_) {
    /* best-effort: sin estado se comprime como siempre */
  }
}

/**
 * true = saltar esta pasada. Pura. Se comprime cuando han entrado al menos
 * CAPTURE_MIN_USER_TURNS turnos del usuario desde la ultima pasada O han
 * pasado CAPTURE_MIN_INTERVAL_MS; la primera pasada de la sesion nunca se salta.
 */
function shouldThrottle(last, userTurns, now) {
  if (!last) return false;
  const enoughTurns = userTurns - last.user_turns >= CAPTURE_MIN_USER_TURNS;
  const enoughTime = now - last.ts >= CAPTURE_MIN_INTERVAL_MS;
  return !(enoughTurns || enoughTime);
}

// ---------------------------------------------------------------------------
// Throttle GLOBAL (decidido 2026-09-10)
//
// El throttle por sesion no cubre el caso de VARIAS sesiones abiertas a la vez:
// cada una respeta su propio limite, pero la primera pasada de cada sesion
// nunca se salta, asi que N sesiones concurrentes pueden disparar N capturas
// (N llamadas al AI Router) en la misma ventana y agotar la cuota compartida
// entre todas. Este throttle es independiente del de sesion — fichero propio
// (.tmp/stop-compress-global.json) — y gatea SOLO el intento de captura (la
// llamada al sidecar, que es la que hace egress); compact.json se sigue
// escribiendo siempre que haya proyecto, con los hechos que hubiera de una
// captura anterior o vacios si no los hay.
// ---------------------------------------------------------------------------

const CAPTURE_GLOBAL_MIN_INTERVAL_MS = 5 * 60 * 1000;

function globalThrottlePath() {
  return path.join(HOME, '.ultron', '.tmp', 'stop-compress-global.json');
}

function readGlobalThrottleState() {
  try {
    const o = JSON.parse(fs.readFileSync(globalThrottlePath(), 'utf8'));
    return { ts: Number(o.ts) || 0 };
  } catch (_) {
    return null;
  }
}

function writeGlobalThrottleState(state) {
  try {
    const p = globalThrottlePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, p);
  } catch (_) {
    /* best-effort: sin estado, el proximo intento no vera esta captura */
  }
}

/**
 * true = saltar el intento de captura (dentro de la ventana global). Pura.
 */
function shouldThrottleGlobal(last, now) {
  if (!last) return false;
  return now - last.ts < CAPTURE_GLOBAL_MIN_INTERVAL_MS;
}

// ---------------------------------------------------------------------------
// Git head SHA (best-effort)
// ---------------------------------------------------------------------------

function gitHeadSha(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500, encoding: 'utf8'
    }).trim();
  } catch (_) { return ''; }
}

// ---------------------------------------------------------------------------
// Project name heuristic
// ---------------------------------------------------------------------------

function projectName(cwd) {
  return path.basename(cwd || process.cwd() || 'unknown');
}

// ---------------------------------------------------------------------------
// Decision auto-capture (Control Center "Decisions" panel)
// ---------------------------------------------------------------------------
// Resolve the authoritative project_id used by the Control Center by matching
// cwd against the registered project paths in cockpit/projects.json.
//
// Fallback (endurecido 2026-07-13): antes devolvia el basename A PELO del cwd,
// y eso fabricaba project_ids basura en brain.db — el nombre de usuario (el home dir como
// proyecto, 53 items), 'src' (11), 'Tortunabo'/'Procedural Terrain' (variantes
// de casing que el filtro de recall trataba como proyectos distintos). Ahora:
// basename slugificado, y los basenames que NO son un proyecto (home del
// usuario, dirs genericos de codigo/build) devuelven null -> la captura queda
// AMBIENTE (sin --project), que es lo que significa "no se de que proyecto es".

const JUNK_BASENAMES = new Set([
  'src', 'dist', 'build', 'out', 'bin', 'lib', 'node_modules', 'scripts',
  'temp', 'tmp', 'downloads', 'desktop', 'documents', 'unknown', 'system32',
]);

function slugifyProjectId(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .join('-')
    .replace(/_/g, '-');
}

function resolveProjectId(cwd) {
  try {
    const reg = JSON.parse(
      fs.readFileSync(path.join(HOME, '.ultron', 'cockpit', 'projects.json'), 'utf8'),
    );
    const projects = (reg && reg.projects) || [];
    const norm = (p) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
    const target = norm(cwd || process.cwd());
    let best = null;
    for (const p of projects) {
      if (!p || !p.path || !p.id) continue;
      const pp = norm(p.path);
      if (target === pp) return p.id;
      if (target.startsWith(pp + '\\') || target.startsWith(pp + '/')) {
        if (!best || pp.length > best.len) best = { id: p.id, len: pp.length };
      }
    }
    if (best) return best.id;
  } catch (_) {
    // fall through to basename fallback
  }
  const target = cwd || process.cwd() || '';
  try {
    if (path.resolve(target) === path.resolve(os.homedir())) return null; // home no es un proyecto
  } catch (_) {
    /* si resolve falla, sigue el slug */
  }
  const slug = slugifyProjectId(path.basename(target).replace(/^\./, ''));
  if (!slug || JUNK_BASENAMES.has(slug)) return null;
  return slug;
}

// [erradicado 2026-07-01 · cat20.3] appendPendingDecisions escribia
// decisions-pending.jsonl por proyecto para un "panel Decisions / backend drain"
// que NUNCA existio en src-tauri (0 lectores en backend y frontend). Las
// decisiones ya se capturan por el camino gobernado `ultron-memory capture`
// (mas abajo) -> inbox de candidatos con redaction + aprobacion humana
// (single-writer). Era una segunda cola redundante que crecia sin sumidero.

// [retirado 2026-09-03 · ULTRON 4 F1.4] appendProjectContext acumulaba los
// facts kind="context" en cockpit/projects/<p>/context.md para que el resume
// dijera "que es este proyecto". Medido en 3 proyectos: frases sueltas ("Kanban
// card updated", "UE 5.6 instalado"), gemelos que el dedupe no colapsaba y
// contaminacion de otros proyectos; nunca respondio "de que iba". Lo sustituye
// el perfil de proyecto (hook SessionEnd project-profile -> profile.json).

// ---------------------------------------------------------------------------
// Captura via el sidecar `ultron-memory capture` (UNICO camino, 2026-09-10)
//
// Antes este hook extraia hechos por su cuenta (llamada directa a Groq/
// Anthropic, sin fallback) Y le pasaba el transcript al sidecar, que vuelve a
// extraer via el AI Router (cadena primary->fallback + keys del usuario) y
// propone candidatos gobernados. Las dos extracciones estaban DUPLICADAS; la
// de aqui fallaba el 51% de las veces (218/426, HTTP 429) sin fallback y no
// aportaba nada que el sidecar no hiciera ya mejor. Decision del usuario:
// un solo camino, el del sidecar — este script ya no extrae nada, solo manda
// el transcript (redactado turno a turno) y lee lo que el sidecar propuso.
// ---------------------------------------------------------------------------

/**
 * Intenta una pasada de captura contra el sidecar. Es el UNICO punto de
 * egress del hook — el transcript (ya redactado) sale de la maquina aqui.
 * Fail-safe: cualquier fallo (spawn, timeout, JSON invalido) devuelve
 * report=null; nunca lanza hacia main().
 * @returns {object|null} el CaptureReport parseado, o null.
 */
function attemptCapture(memBin, turns, projectId, sessionId) {
  try {
    const transcriptText = turns
      .map((t) => `${t.role || ''}: ${redactSecrets(t.text || '')}`)
      .join('\n')
      .slice(-8000);
    // Provenance episódica: --session estampa source_session_id en cada
    // candidate que la captura proponga (verificable via `provenance --id`).
    // Sin projectId (cwd sin proyecto) se captura SIN --project: ambiente.
    const captureArgs = ['capture'];
    if (projectId) captureArgs.push('--project', projectId);
    if (sessionId) captureArgs.push('--session', String(sessionId));
    const cap = spawnSync(memBin, captureArgs, {
      input: transcriptText,
      encoding: 'utf8',
      timeout: 25000,
      maxBuffer: 1024 * 1024,
    });
    safeLog({
      level: 'info',
      msg: 'memory_capture',
      sessionId,
      code: cap.status,
      out: (cap.stdout || '').slice(0, 200),
    });

    let report = null;
    if (cap.status === 0 && cap.stdout) {
      try {
        report = JSON.parse(cap.stdout);
      } catch (e) {
        safeLog({
          level: 'warn',
          msg: 'capture_report_unparseable',
          sessionId,
          error: String(e && e.message),
        });
      }
    }

    // (2026-07-13) Inbox 100% autonomo (decision del usuario): drena el stock
    // justo despues de capturar, detached fire-and-forget — la re-verificacion
    // (juez de contradiccion + dedup, con E5 en proceso) tarda segundos por
    // lote y NO debe bloquear el Stop. La politica vive en el binario
    // (`inbox drain --auto`): re-verifica los unjudged, aprueba bandas A/B,
    // rechaza secret/duplicado/conflicto/ruido con razon auditable. Sin esto
    // los candidatos `unjudged` (E5 frio agotaba el budget 4.5s del juez en
    // el one-shot de captura) se acumulaban pending para siempre.
    try {
      const drain = spawn(memBin, ['inbox', 'drain', '--auto'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      drain.unref();
      safeLog({ level: 'info', msg: 'inbox_drain_auto_spawned', sessionId });
    } catch (e2) {
      safeLog({
        level: 'warn',
        msg: 'inbox_drain_auto_failed',
        sessionId,
        error: String(e2 && e2.message),
      });
    }

    return report;
  } catch (e) {
    safeLog({
      level: 'warn',
      msg: 'memory_capture_failed',
      sessionId,
      error: String(e && e.message),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// cat17.1 — Structured compact output (>=4 of 8 outputs)
// Writes cockpit/projects/{projectId}/sessions/{session_id}/compact.json with:
//   human    — prose summary for humans
//   machine  — counters/metrics object for tooling
//   decisions — list of decision-kind facts del informe del sidecar
//   next     — list of task-kind facts as next steps
//   bugs     — list of lesson-kind facts (si el sidecar propuso alguna)
//   arch_delta — recent git commits during the session window (best-effort)
//
// Fail-safe: any error is logged and swallowed. Never throws into main().
// ---------------------------------------------------------------------------

function gitLogRecent(cwd, maxCommits) {
  try {
    const out = execFileSync(
      'git',
      ['-C', cwd, 'log', '--oneline', '--no-decorate', `-${maxCommits}`],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, encoding: 'utf8' }
    ).trim();
    if (!out) return [];
    return out.split('\n').filter(Boolean);
  } catch (_) {
    return [];
  }
}

/**
 * `facts` es el array `facts` del CaptureReport del sidecar (ver
 * control-center/src-tauri/src/memory/capture.rs — CapturedFact): cada
 * elemento es { kind, title, origin }, donde `kind` es el MemoryType en
 * snake_case tal y como serializa en brain.db (ver
 * control-center/src-tauri/src/memory/model.rs) y `origin` es una de
 * "origin:user" / "origin:assistant" / "origin:unknown".
 *
 * Mapeo kind -> seccion de compact.json:
 *   decision -> decisions
 *   task     -> next        (unico kind de "pendiente" en MemoryType; no
 *                             existe "todo" como valor real del enum)
 *   lesson   -> bugs        (MemoryType no tiene kind "bug"; lesson —
 *                             sintoma+causa+regla de un fallo cerrado en la
 *                             sesion — es lo mas cercano que produce el
 *                             extractor)
 * El resto de kinds (preference, fact, constraint, codebase_fact, skill,
 * agent_note, session_summary, error_resolution, architecture, user_profile)
 * no aparece en ninguna de las tres listas: compact.json es un resumen
 * operativo de la sesion, no un espejo completo de brain.db.
 */
function writeCompact(projectId, sessionId, cwd, turns, facts, aiUsed, date) {
  try {
    const sessionDir = path.join(HOME, '.ultron', 'cockpit', 'projects', projectId, 'sessions', sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const outPath = path.join(sessionDir, 'compact.json');

    // human: prosa — primer prompt del usuario + resumen de turno
    const firstUser = turns.find(t => t.role === 'user');
    const firstPrompt = firstUser ? firstUser.text.slice(0, 300) : '(sin prompt)';
    const human = `Sesión ${sessionId} del ${date} (${turns.length} turnos). Tema: ${firstPrompt}`;

    // machine: métricas de la sesión
    const userTurns = turns.filter(t => t.role === 'user').length;
    const assistantTurns = turns.filter(t => t.role === 'assistant').length;
    const machine = {
      session_id: sessionId,
      date,
      project: projectId,
      turns_total: turns.length,
      turns_user: userTurns,
      turns_assistant: assistantTurns,
      facts_extracted: (facts || []).length,
      ai_used: !!aiUsed,
      sha_head: gitHeadSha(cwd) || null,
      generated_at: new Date().toISOString(),
    };

    // decisions / next / bugs: mapeo por kind (ver comentario de la funcion).
    const decisions = (facts || [])
      .filter(f => f && f.kind === 'decision' && f.title)
      .map(f => ({ text: String(f.title).slice(0, 120), origin: f.origin || 'origin:unknown' }));

    const next = (facts || [])
      .filter(f => f && f.kind === 'task' && f.title)
      .map(f => String(f.title).slice(0, 120));

    const bugs = (facts || [])
      .filter(f => f && f.kind === 'lesson' && f.title)
      .map(f => ({ text: String(f.title).slice(0, 120), origin: f.origin || 'origin:unknown' }));

    // arch_delta: últimos commits de la sesión (best-effort, max 10)
    const arch_delta = gitLogRecent(cwd, 10);

    const compact = {
      schema_version: 1,
      session_id: sessionId,
      date,
      human,
      machine,
      decisions,
      next,
      bugs,
      arch_delta,
    };

    fs.writeFileSync(outPath, JSON.stringify(compact, null, 2), 'utf8');
    safeLog({ level: 'info', msg: 'compact_written', path: outPath, sessionId });
  } catch (e) {
    safeLog({ level: 'warn', msg: 'compact_write_failed', error: String(e && e.message), sessionId });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (process.env.STOP_COMPRESS_DISABLED === '1' || process.env.CLAUDE_NO_HOOKS === '1') {
    safeLog({ level: 'info', msg: 'opt_out_via_env' });
    return;
  }

  const stdinRaw = readStdinSync();
  let stdin = {};
  try { stdin = stdinRaw ? JSON.parse(stdinRaw) : {}; } catch (_) {}

  const transcriptPath = stdin.transcript_path || stdin.transcriptPath || '';
  const sessionId = stdin.session_id || stdin.sessionId
    || (transcriptPath ? path.basename(transcriptPath).replace(/\.jsonl$/i, '') : '')
    || crypto.randomUUID();
  const cwd = stdin.cwd || process.cwd();
  const project = projectName(cwd);

  // Per-project opt-out: financial projects and any project listed in
  // ~/.ultron/.mem0-opt-out.json will not send data to external services.
  // Checked early — opted-out sessions do zero network I/O.
  if (isOptedOut(detectProjectName(cwd), cwd, loadOptOut())) {
    safeLog({ level: 'info', msg: 'opted_out_by_project', project, sessionId });
    return;
  }
  const date = new Date().toISOString().slice(0, 10);

  safeLog({ level: 'info', msg: 'start', sessionId, project, transcriptPath: transcriptPath || '(none)' });

  // Parse transcript.
  const turns = transcriptPath ? parseTurns(transcriptPath) : [];
  if (turns.length === 0) {
    safeLog({ level: 'info', msg: 'no_turns_skip', sessionId });
    return;
  }

  // Throttle por sesion (2026-09-07, decidido por el usuario): Stop se dispara
  // en cada turno del asistente. Una sesion se comprime como mucho una vez
  // cada CAPTURE_MIN_USER_TURNS turnos del usuario o cada
  // CAPTURE_MIN_INTERVAL_MS, lo que antes se cumpla; la primera pasada nunca
  // se salta.
  const userTurns = turns.filter((t) => t.role === 'user').length;
  const throttle = readThrottleState(sessionId);
  if (shouldThrottle(throttle, userTurns, Date.now())) {
    safeLog({ level: 'info', msg: 'throttled', sessionId, userTurns, last: throttle });
    return;
  }
  writeThrottleState(sessionId, { user_turns: userTurns, ts: Date.now() });

  const projectId = resolveProjectId(cwd);

  // Captura via el sidecar (unico camino, ver comentario mas arriba). El
  // throttle GLOBAL gatea solo el intento de captura (el egress): la primera
  // pasada de una sesion nueva SIGUE respetandolo, que es justo lo que ahorra
  // cuota cuando hay varias sesiones concurrentes.
  let report = null;
  const nowMs = Date.now();
  const globalThrottle = readGlobalThrottleState();
  if (shouldThrottleGlobal(globalThrottle, nowMs)) {
    safeLog({ level: 'info', msg: 'throttled_global', sessionId, lastGlobalTs: globalThrottle.ts });
  } else if (!securityHelpersLoaded) {
    // FAIL-CLOSED: sin redaccion verificada, el transcript no sale de la
    // maquina — la captura (que lo manda al AI Router) se salta entera.
    safeLog({ level: 'warn', msg: 'capture_skipped_no_redaction', sessionId });
  } else {
    // HOOKS-JS-07: resolucion compartida del sidecar (env var + candidatos
    // release/debug) en vez del path hardcodeado a ~/.ultron/bin.
    const memBin = findBinary();
    if (memBin) {
      writeGlobalThrottleState({ ts: nowMs });
      report = attemptCapture(memBin, turns, projectId, sessionId);
    } else {
      safeLog({ level: 'warn', msg: 'memory_bin_not_found', sessionId });
    }
  }

  const facts = (report && Array.isArray(report.facts)) ? report.facts : [];
  const aiUsed = !!(report && report.router_used);
  safeLog({ level: 'info', msg: 'facts_extracted', count: facts.length, aiUsed, sessionId });

  // projectId=null (cwd sin proyecto: home, dir generico) -> nada de escribir
  // en cockpit/projects/<null>/ ni de estampar un proyecto inventado; la
  // captura de arriba ya fue SIN --project (candidato ambiente, down-rankeado).
  if (projectId) {
    // cat17.1 — escribe compact.json con >=4 outputs estructurados (human/machine/decisions/next/bugs/arch_delta).
    writeCompact(projectId, sessionId, cwd, turns, facts, aiUsed, date);
  }

  // OLA A/B (2026-06-04): the legacy upsert to the RETIRED Qdrant `ultron_sessions`
  // collection (384-d BGE) was REMOVED. It wrote memory OUTSIDE the canonical
  // store (brain.db, governed by MemoryService) and used an embedding dimension
  // incompatible with the canonical `ultron_memory` (E5 1024-d). Session capture
  // now flows solely through the Stop -> `ultron-memory capture` path
  // (single-writer, governed inbox). The dead
  // qdrant*/computeEmbedding helpers were deleted (2026-06-22).
  // See cockpit/memory-rework/STATE-RECONCILIATION-2026-06-04.md (P0-1).
  safeLog({
    level: 'info',
    msg: 'session_compressed',
    note: 'ultron_sessions upsert retired (SoT = brain.db); decisions captured via sidecar',
    count: facts.length,
    sessionId,
    project,
  });
}

// Solo corre el hook cuando se invoca directamente; al importarse (tests) expone
// las funciones puras sin disparar la compactacion ni la llamada al sidecar.
if (require.main === module) {
  main().catch(err => {
    safeLog({ level: 'error', msg: 'unhandled', error: String(err && err.message) });
    // cat9.5: rastro en hook-errors.jsonl para que el orquestador detecte fallos silenciosos.
    logHookError('stop-compress-session', err);
  });
  process.exitCode = 0;
} else {
  module.exports = {
    resolveProjectId,
    shouldThrottle,
    shouldThrottleGlobal,
    CAPTURE_MIN_USER_TURNS,
    CAPTURE_MIN_INTERVAL_MS,
    CAPTURE_GLOBAL_MIN_INTERVAL_MS,
  };
}
