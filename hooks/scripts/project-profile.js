#!/usr/bin/env node
// hooks/scripts/project-profile.js — SessionEnd hook (ULTRON 4, F1.4 / G9).
//
// Al cerrar una sesion mantiene el PERFIL del proyecto actual: que es, stack,
// arquitectura, estado y decisiones clave, en cockpit/projects/<id>/profile.json.
// El SessionStart del mismo proyecto lo inyecta tal cual (memory-session-resume)
// para que "¿de que iba este proyecto?" tenga respuesta completa sin arqueologia.
//
// Flujo:
//   1. Fuentes del repo (lib/project-sources.js): registro del Control Center,
//      cabecera de CLAUDE.md/README, manifiestos, kanban, git.
//   2. Gate de frescura: si ya hay un perfil LLM del mismo HEAD con menos de
//      PROFILE_MAX_AGE_DAYS, no se toca (una sesion sin commits rara vez cambia
//      lo que el proyecto ES). PROJECT_PROFILE_FORCE=1 salta el gate.
//   3. Fuentes redactadas (lib/security-helpers.js, FAIL-CLOSED) -> cmd
//      `profile_distill` del daemon, que las junta con la memoria del proyecto y
//      consulta la cadena de proveedores de skill_llm (cuota separada del AI
//      Router). Sin daemon no se levanta uno aqui.
//   4. Con perfil valido: se escribe (source=llm). Sin perfil y sin uno previo:
//      se escribe el determinista (source=deterministic) para que el resume no
//      quede vacio. Sin perfil pero con uno previo: se conserva el anterior.
//   5. Traza en ~/.ultron/.tmp/project-profile.jsonl (writer NONE, scratch).
//
// NO-OP-SAFE: cualquier fallo sale con 0 y sin escribir nada.
//
// Opt-out: CLAUDE_NO_HOOKS=1 o PROJECT_PROFILE_DISABLED=1.
// Seams de test (el selftest no toca ni daemon ni cockpit real):
//   PROJECT_PROFILE_LOG            ruta del scratch log
//   PROJECT_PROFILE_DIR            raiz de cockpit/projects (perfil + kanban)
//   PROJECT_PROFILE_REGISTRY       ruta de projects.json
//   PROJECT_PROFILE_PROJECT        id del proyecto (salta la resolucion por cwd)
//   PROJECT_PROFILE_REQUEST_OUT    escribe la peticion al daemon en vez de enviarla
//   PROJECT_PROFILE_FAKE_RESPONSE  ruta a un JSON con la respuesta simulada del daemon
//   PROJECT_PROFILE_FORCE          1 = regenera aunque el perfil este fresco
//   PROJECT_PROFILE_MAX_AGE_DAYS   edad maxima del perfil LLM antes de regenerar
//   PROJECT_PROFILE_RELAUNCH_FAKE  ruta a un JSON que simula el ciclo de
//                                  relanzamiento del daemon (relaunched, retry_response)
//                                  sin tocar spawn/lockfile/red reales

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { observe, logHookError } = require('./lib/hook-obs');
const { appendJsonl } = require('./lib/jsonl-log');
const { daemonRequest, projectIdFromCwd, spawnDetached, readDaemonLock } = require('./lib/ultron-memory-cli');
const { gatherSources, perfilDeterminista } = require('./lib/project-sources');
observe('project-profile');

const HOME = os.homedir();
const LOG_PATH = process.env.PROJECT_PROFILE_LOG || path.join(HOME, '.ultron', '.tmp', 'project-profile.jsonl');
const PROJECTS_DIR = process.env.PROJECT_PROFILE_DIR || path.join(HOME, '.ultron', 'cockpit', 'projects');
const DEFAULT_MAX_AGE_DAYS = 14;
const DAEMON_TIMEOUT_MS = 25000;
const PROFILE_VERSION = 1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Relanzamiento del daemon si no responde (2026-09-10): mismo patron que
// lesson-distill.js. Presupuesto: este hook tiene timeout=75s en
// ~/.claude/settings.json (SessionEnd; subido de 40s el 2026-09-10 para dar
// margen al relanzamiento). Peor caso = pre-proceso (gatherSources con git,
// ~2s) + ask inicial (DAEMON_TIMEOUT_MS=25s) + esta espera (25s) +
// RETRY_TIMEOUT_MS (15s) + cola (~0,5s) = 67,5s, margen ~7s.
const DAEMON_RELAUNCH_POLL_MS = 1500;
const DAEMON_RELAUNCH_WAIT_MS = 25000;
const RETRY_TIMEOUT_MS = 15000;

// FAIL-CLOSED: las fuentes salen de la maquina; sin redaccion real no se envian.
let redactSecrets = null;
try {
  const sec = require('./lib/security-helpers.js');
  if (sec && typeof sec.redactSecrets === 'function') redactSecrets = sec.redactSecrets;
} catch (_) {
  redactSecrets = null;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function maxAgeDays() {
  const n = Number(process.env.PROJECT_PROFILE_MAX_AGE_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_AGE_DAYS;
}

function profilePath(project) {
  return path.join(PROJECTS_DIR, project, 'profile.json');
}

function readPrevious(project) {
  try {
    const raw = JSON.parse(fs.readFileSync(profilePath(project), 'utf8'));
    return raw && typeof raw === 'object' && raw.profile ? raw : null;
  } catch (_) {
    return null;
  }
}

function validPerfil(p) {
  return (
    p &&
    typeof p === 'object' &&
    typeof p.que_es === 'string' &&
    p.que_es.trim().length > 0 &&
    Array.isArray(p.decisiones_clave || [])
  );
}

function normalizePerfil(p) {
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  return {
    que_es: str(p.que_es),
    stack: str(p.stack),
    arquitectura: str(p.arquitectura),
    estado: str(p.estado),
    decisiones_clave: (Array.isArray(p.decisiones_clave) ? p.decisiones_clave : [])
      .map(str)
      .filter(Boolean),
  };
}

/**
 * ¿Sigue valiendo el perfil anterior? Solo un perfil LLM del MISMO HEAD y con
 * menos de `maxDays` dias se da por fresco. Un determinista siempre se intenta
 * mejorar; un HEAD distinto significa trabajo nuevo que describir.
 */
function isFresh(previous, head, maxDays, now = Date.now()) {
  if (!previous || previous.source !== 'llm') return false;
  const prevSha = previous.head && previous.head.sha;
  if (!head || !prevSha || prevSha !== head.sha) return false;
  const generated = Date.parse(previous.generated_at || '');
  if (!Number.isFinite(generated)) return false;
  return now - generated < maxDays * MS_PER_DAY;
}

function writeProfile(project, doc) {
  const file = profilePath(project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

async function askDaemon(payload) {
  if (process.env.PROJECT_PROFILE_REQUEST_OUT) {
    appendJsonl(process.env.PROJECT_PROFILE_REQUEST_OUT, payload);
  }
  if (process.env.PROJECT_PROFILE_FAKE_RESPONSE) {
    try {
      return JSON.parse(fs.readFileSync(process.env.PROJECT_PROFILE_FAKE_RESPONSE, 'utf8'));
    } catch (_) {
      return null;
    }
  }
  return daemonRequest(payload, DAEMON_TIMEOUT_MS);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * La peticion inicial no obtuvo respuesta: levanta el daemon y reintenta UNA
 * vez. Devuelve { relaunched, waitMs, retryResp }. NO lanza nunca.
 *
 * Seam de test (PROJECT_PROFILE_RELAUNCH_FAKE): ruta a un JSON
 * { relaunched: bool, retry_response?: object } que sustituye por completo el
 * spawn + sondeo + reintento reales — el selftest no toca el binario ni el
 * puerto del daemon.
 */
async function relaunchAndRetry(payload) {
  const fakePath = process.env.PROJECT_PROFILE_RELAUNCH_FAKE;
  if (fakePath) {
    try {
      const sim = JSON.parse(fs.readFileSync(fakePath, 'utf8'));
      return {
        relaunched: !!sim.relaunched,
        waitMs: 0,
        retryResp: sim.relaunched ? (sim.retry_response || null) : null,
      };
    } catch (_) {
      return { relaunched: false, waitMs: 0, retryResp: null };
    }
  }

  const startedAt = Date.now();
  const spawned = spawnDetached(['serve']);
  let relaunched = false;
  if (spawned) {
    const deadline = startedAt + DAEMON_RELAUNCH_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(DAEMON_RELAUNCH_POLL_MS);
      if (readDaemonLock()) {
        relaunched = true;
        break;
      }
    }
  }
  const waitMs = Date.now() - startedAt;
  const retryResp = relaunched ? await daemonRequest(payload, RETRY_TIMEOUT_MS) : null;
  return { relaunched, waitMs, retryResp };
}

async function main() {
  if (process.env.CLAUDE_NO_HOOKS === '1' || process.env.PROJECT_PROFILE_DISABLED === '1') return;

  let stdin = {};
  try {
    const raw = readStdin();
    stdin = raw ? JSON.parse(raw) : {};
  } catch (_) {
    stdin = {};
  }

  const started = Date.now();
  const cwd = stdin.cwd || process.cwd();
  const project = process.env.PROJECT_PROFILE_PROJECT || projectIdFromCwd(cwd);
  const sessionId = stdin.session_id || stdin.sessionId || null;
  const record = { session_id: sessionId, project, source_chars: 0, ms: 0 };

  if (!project) {
    record.skipped = 'sin proyecto';
    return appendJsonl(LOG_PATH, record);
  }
  if (!redactSecrets) {
    record.skipped = 'sin redaccion (fail-closed)';
    return appendJsonl(LOG_PATH, record);
  }

  const sources = gatherSources(cwd, project, {
    projectsDir: PROJECTS_DIR,
    registryPath: process.env.PROJECT_PROFILE_REGISTRY,
  });
  record.head = sources.head ? sources.head.sha : null;
  const previous = readPrevious(project);
  const force = process.env.PROJECT_PROFILE_FORCE === '1';
  if (!force && isFresh(previous, sources.head, maxAgeDays())) {
    record.skipped = 'perfil fresco';
    record.ms = Date.now() - started;
    return appendJsonl(LOG_PATH, record);
  }

  const text = redactSecrets(sources.text);
  record.source_chars = text.length;

  // Modo test: con PROJECT_PROFILE_FAKE_RESPONSE puesto (y sin optar al seam
  // de relanzamiento) el "daemon" ya esta simulado por askDaemon; relanzar de
  // verdad ahi rompería el hermetismo del selftest.
  const testMode = !!process.env.PROJECT_PROFILE_FAKE_RESPONSE && !process.env.PROJECT_PROFILE_RELAUNCH_FAKE;

  const payload = { cmd: 'profile_distill', project, prompt: text };
  let resp = await askDaemon(payload);
  if ((!resp || typeof resp !== 'object') && !testMode) {
    const r = await relaunchAndRetry(payload);
    record.relaunched = r.relaunched;
    record.relaunch_wait_ms = r.waitMs;
    if (r.retryResp && typeof r.retryResp === 'object') resp = r.retryResp;
  }
  const now = new Date().toISOString();
  const base = { version: PROFILE_VERSION, project, generated_at: now, head: sources.head, session_id: sessionId };

  if (resp && typeof resp === 'object' && !resp.error && validPerfil(resp.profile)) {
    writeProfile(project, { ...base, source: 'llm', profile: normalizePerfil(resp.profile) });
    record.written = 'llm';
    record.memory_chars = resp.memory_chars || 0;
  } else {
    record.daemon = !resp
      ? 'no responde'
      : resp.error
        ? `error: ${String(resp.error).slice(0, 120)}`
        : `sin perfil: ${String(resp.skipped || 'respuesta sin forma').slice(0, 120)}`;
    if (previous) {
      record.written = 'conservado';
    } else {
      const det = perfilDeterminista(sources);
      if (det) {
        writeProfile(project, { ...base, source: 'deterministic', profile: det });
        record.written = 'deterministic';
      } else {
        record.skipped = 'sin fuentes para un perfil';
      }
    }
  }
  record.ms = Date.now() - started;
  appendJsonl(LOG_PATH, record);
}

if (require.main === module) {
  main()
    .catch((e) => logHookError('project-profile', e))
    .finally(() => {
      process.exitCode = 0;
    });
} else {
  module.exports = { isFresh, validPerfil, normalizePerfil };
}
