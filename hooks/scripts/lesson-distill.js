#!/usr/bin/env node
// hooks/scripts/lesson-distill.js — SessionEnd hook (ULTRON 4, F1.2, Q2b).
//
// Al cerrar una sesion destila entre 0 y 3 LECCIONES reutilizables (sintoma,
// causa, regla) y las PROPONE como candidatos `lesson` al inbox gobernado.
// Nada se auto-aprueba: el usuario acepta o rechaza cada una en el inbox.
//
// Flujo:
//   1. Cola del transcript (lib/transcript-turns.js): ultimos turnos de usuario
//      y asistente + bloques `tool_result` con `is_error` (el sintoma barato).
//   2. Digest redactado (lib/security-helpers.js, FAIL-CLOSED: sin helpers no
//      sale nada de la maquina) y con tope de caracteres.
//   3. cmd `lesson_distill` del daemon (`ultron-memory serve`): cadena de
//      proveedores de skill_llm, cuota separada del AI Router, respuesta
//      validada en Rust. Sin daemon, no hay lecciones (no se levanta uno aqui:
//      un SessionEnd no es el momento de cargar 1,5 GB de modelos).
//   4. Cada leccion -> `ultron-memory candidate --project <id>` (escritor unico
//      = MemoryService). Cae `pending` al inbox.
//   5. Traza en ~/.ultron/.tmp/lesson-distill.jsonl (writer NONE, scratch).
//
// NO-OP-SAFE: cualquier fallo sale con 0 y sin escribir memoria. Un hook de
// cierre que rompe la sesion es peor que una leccion perdida.
//
// Opt-out: CLAUDE_NO_HOOKS=1 o LESSON_DISTILL_DISABLED=1.
// Seams de test (el selftest no toca ni daemon ni inbox):
//   LESSON_DISTILL_LOG           ruta del scratch log
//   LESSON_DISTILL_REQUEST_OUT   escribe la peticion al daemon en vez de enviarla
//   LESSON_DISTILL_FAKE_RESPONSE ruta a un JSON con la respuesta simulada del daemon
//   LESSON_DISTILL_CANDIDATE_OUT escribe los candidatos a fichero en vez de al sidecar

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { observe, logHookError } = require('./lib/hook-obs');
const { appendJsonl } = require('./lib/jsonl-log');
const { parseTurns } = require('./lib/transcript-turns');
const { findBinary, daemonRequest, projectIdFromCwd } = require('./lib/ultron-memory-cli');
observe('lesson-distill');

const HOME = os.homedir();
const LOG_PATH = process.env.LESSON_DISTILL_LOG || path.join(HOME, '.ultron', '.tmp', 'lesson-distill.jsonl');
const MAX_TURNS = 60;
const TURN_CHARS = 500;
// Cola del transcript que se recorre buscando turnos con texto. Una sesion con
// herramientas mete ~30 KB de tool_use/tool_result por turno hablado; con los
// 256 KiB por defecto una sesion real de 1,8 MB daba 265 caracteres de digest.
const TAIL_BYTES = 2 * 1024 * 1024;
// Espejo de MIN_DIGEST_CHARS en lesson_llm.rs: por debajo ni se llama al daemon.
const MIN_DIGEST_CHARS = 300;
const MAX_DIGEST_CHARS = 12000;
const MAX_LESSONS = 3;
const DAEMON_TIMEOUT_MS = 12000;
const SIDECAR_TIMEOUT_MS = 12000;
const TITLE_MAX = 80;
const SUMMARY_MAX = 220;

// FAIL-CLOSED: el digest sale de la maquina; sin redaccion real no se envia.
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

function buildDigest(turns) {
  const lines = turns.map((t) => `[${t.role}]: ${redactSecrets(t.text).replace(/\s+/g, ' ').trim()}`);
  const full = lines.join('\n');
  // Lo reciente manda: se recorta por el principio.
  return full.length > MAX_DIGEST_CHARS ? full.slice(full.length - MAX_DIGEST_CHARS) : full;
}

function truncate(s, max) {
  const plano = String(s || '').replace(/\s+/g, ' ').trim();
  return plano.length <= max ? plano : plano.slice(0, max - 1) + '…';
}

function toCandidate(lesson, project, sessionId) {
  return {
    type: 'lesson',
    scope: 'project',
    title: truncate(`[lesson] ${lesson.rule}`, TITLE_MAX),
    summary: truncate(`${lesson.symptom} → ${lesson.cause}`, SUMMARY_MAX),
    content: `Síntoma: ${lesson.symptom}\nCausa: ${lesson.cause}\nRegla: ${lesson.rule}\nProyecto origen: ${project}`,
    tags: ['lesson'],
    confidence: 0.6,
    source: 'lesson-distill',
    capture_source: 'lesson-distill',
    recommended_action: 'review',
    session_id: sessionId,
    project,
  };
}

function validLesson(l) {
  return (
    l &&
    typeof l.symptom === 'string' && l.symptom.trim() &&
    typeof l.cause === 'string' && l.cause.trim() &&
    typeof l.rule === 'string' && l.rule.trim()
  );
}

async function askDaemon(payload) {
  if (process.env.LESSON_DISTILL_REQUEST_OUT) {
    appendJsonl(process.env.LESSON_DISTILL_REQUEST_OUT, payload);
  }
  if (process.env.LESSON_DISTILL_FAKE_RESPONSE) {
    try {
      return JSON.parse(fs.readFileSync(process.env.LESSON_DISTILL_FAKE_RESPONSE, 'utf8'));
    } catch (_) {
      return null;
    }
  }
  return daemonRequest(payload, DAEMON_TIMEOUT_MS);
}

function propose(candidate, project) {
  if (process.env.LESSON_DISTILL_CANDIDATE_OUT) {
    appendJsonl(process.env.LESSON_DISTILL_CANDIDATE_OUT, { project, candidate });
    return true;
  }
  const bin = findBinary();
  if (!bin) return false;
  try {
    const r = spawnSync(bin, ['candidate', '--project', project], {
      input: JSON.stringify(candidate),
      encoding: 'utf8',
      timeout: SIDECAR_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    return r.status === 0;
  } catch (_) {
    return false;
  }
}

async function main() {
  if (process.env.CLAUDE_NO_HOOKS === '1' || process.env.LESSON_DISTILL_DISABLED === '1') return;

  let stdin = {};
  try {
    const raw = readStdin();
    stdin = raw ? JSON.parse(raw) : {};
  } catch (_) {
    stdin = {};
  }

  const started = Date.now();
  const transcriptPath = stdin.transcript_path || stdin.transcriptPath || '';
  const cwd = stdin.cwd || process.cwd();
  const project = projectIdFromCwd(cwd) || 'ultron';
  const sessionId = stdin.session_id || stdin.sessionId || null;
  const record = { session_id: sessionId, project, digest_chars: 0, lessons: 0, proposed: 0, ms: 0 };

  if (!transcriptPath) {
    record.skipped = 'sin transcript';
    return appendJsonl(LOG_PATH, record);
  }
  if (!redactSecrets) {
    record.skipped = 'sin redaccion (fail-closed)';
    return appendJsonl(LOG_PATH, record);
  }

  const turns = parseTurns(transcriptPath, {
    maxTurns: MAX_TURNS,
    textChars: TURN_CHARS,
    includeToolErrors: true,
    tailBytes: TAIL_BYTES,
  });
  const digest = buildDigest(turns);
  record.digest_chars = digest.length;
  record.tool_errors = turns.filter((t) => t.role === 'tool_error').length;
  if (digest.length < MIN_DIGEST_CHARS) {
    record.skipped = 'digest sin cuerpo';
    record.ms = Date.now() - started;
    return appendJsonl(LOG_PATH, record);
  }

  const resp = await askDaemon({ cmd: 'lesson_distill', prompt: digest, project });
  if (!resp || typeof resp !== 'object') {
    record.skipped = 'daemon no responde';
    record.ms = Date.now() - started;
    return appendJsonl(LOG_PATH, record);
  }
  if (resp.error) {
    record.skipped = `daemon: ${String(resp.error).slice(0, 120)}`;
    record.ms = Date.now() - started;
    return appendJsonl(LOG_PATH, record);
  }
  if (resp.skipped) record.daemon_skipped = String(resp.skipped).slice(0, 120);

  const lessons = (Array.isArray(resp.lessons) ? resp.lessons : []).filter(validLesson).slice(0, MAX_LESSONS);
  record.lessons = lessons.length;
  for (const lesson of lessons) {
    if (propose(toCandidate(lesson, project, sessionId), project)) record.proposed += 1;
  }
  record.ms = Date.now() - started;
  appendJsonl(LOG_PATH, record);
}

main()
  .catch((e) => logHookError('lesson-distill', e))
  .finally(() => {
    process.exitCode = 0;
  });
