'use strict';
/**
 * lib/session-feedback.js — la metrica externa de ULTRON 4 (plan, seccion 12.1).
 *
 * Pregunta una sola cosa por sesion de proyecto: "¿ayudo ULTRON?" (si / no /
 * estorbo) con una nota opcional. Es la unica medida que dice si ULTRON ayuda;
 * el Kirkardo solo mide si esta bien hecho.
 *
 * Mecanismo (decision del usuario 2026-09-04, opcion A "pregunta diferida"):
 *   - SessionEnd (session-feedback-mark.js) deja `feedback-pending.json` en
 *     cockpit/projects/<id>/ con los datos de la sesion que termina.
 *   - El resume del siguiente SessionStart en ese proyecto (memory-session-
 *     resume.js) inyecta la pregunta; el modelo la traslada al usuario.
 *   - UserPromptSubmit (session-feedback-capture.js) captura `fb: si|no|estorbo
 *     [nota]`, lo registra en logs/session-feedback.jsonl y retira el pending.
 *   - Un pending que se sobreescribe sin respuesta cuenta como "sin_respuesta":
 *     ignorar la pregunta no es un "no", pero tampoco desaparece.
 *
 * Solo proyectos que NO son ULTRON (EXCLUDED_PROJECTS): la metrica mide lo que
 * ULTRON aporta a los demas.
 *
 * Overrides (solo selftest): SESSION_FEEDBACK_PROJECTS_DIR, SESSION_FEEDBACK_LOG.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { isSystemTurnPrompt } = require('./system-turn');

const HOME = os.homedir();
const PROJECTS_DIR =
  process.env.SESSION_FEEDBACK_PROJECTS_DIR || path.join(HOME, '.ultron', 'cockpit', 'projects');
const LOG_PATH =
  process.env.SESSION_FEEDBACK_LOG || path.join(HOME, '.ultron', 'logs', 'session-feedback.jsonl');
const EXCLUDED_PROJECTS = new Set(['ultron']);
// Sesiones con menos turnos humanos no se preguntan: abrir y cerrar no es una
// sesion de trabajo y preguntar por ella seria ruido.
const MIN_HUMAN_TURNS = 3;
const STATS_WINDOW = 20;
const GOAL_PCT_SI = 80;
// Transcripts por encima de este tamaño se leen por cabeza + cola (basta para
// las marcas de tiempo; los turnos se cuentan sobre lo leido).
const MAX_FULL_READ_BYTES = 8 * 1024 * 1024;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;

// Sin bandera `u`, \w es ASCII y \b no cierra tras una vocal acentuada ("sí",
// "estorbó"): el limite se declara con un lookahead explicito.
const ANSWER_RE = /^\s*fb\s*:\s*(s[ií]|no|estorb[oó]|estorba)(?=$|[\s.,;:!-])[\s.,;:!-]*(.*)$/i;
const ANSWER_LABEL = { si: 'sí', no: 'no', estorbo: 'estorbó', sin_respuesta: 'sin respuesta' };

function pendingPath(project) {
  return path.join(PROJECTS_DIR, project, 'feedback-pending.json');
}

function projectDirExists(project) {
  try {
    return !!project && fs.statSync(path.join(PROJECTS_DIR, project)).isDirectory();
  } catch (_) {
    return false;
  }
}

function isExcluded(project) {
  return !project || EXCLUDED_PROJECTS.has(String(project).toLowerCase());
}

function readPending(project) {
  try {
    const doc = JSON.parse(fs.readFileSync(pendingPath(project), 'utf8'));
    return doc && typeof doc === 'object' && doc.session_id ? doc : null;
  } catch (_) {
    return null;
  }
}

function writePending(project, doc) {
  const p = pendingPath(project);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

function removePending(project) {
  try {
    fs.rmSync(pendingPath(project), { force: true });
  } catch (_) {
    // best-effort
  }
}

function appendFeedback(entry) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
}

function readFeedback() {
  try {
    return fs
      .readFileSync(LOG_PATH, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l); } catch (_) { return null; }
      })
      .filter((e) => e && e.answer);
  } catch (_) {
    return [];
  }
}

// `fb: sí ha ido fino` -> { answer: 'si', note: 'ha ido fino' }; null si no es
// una respuesta de feedback. Prefijo explicito: cero heuristica.
function parseAnswer(prompt) {
  const m = ANSWER_RE.exec(String(prompt || ''));
  if (!m) return null;
  const raw = m[1].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const answer = raw === 'si' ? 'si' : raw === 'no' ? 'no' : 'estorbo';
  return { answer, note: String(m[2] || '').trim() };
}

function isHumanUserEntry(entry) {
  const message = entry && (entry.message || entry);
  if (!message || message.role !== 'user' || !message.content) return false;
  const content = message.content;
  if (Array.isArray(content)) {
    if (content.some((p) => p && p.type === 'tool_result')) return false;
    const text = content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join(' ').trim();
    return !!text && !looksSynthetic(text);
  }
  const text = String(content).trim();
  return !!text && !looksSynthetic(text);
}

function looksSynthetic(text) {
  if (isSystemTurnPrompt(text)) return true;
  return (
    text.startsWith('<system-reminder>') ||
    text.startsWith('<command-name>') ||
    text.startsWith('[Request interrupted') ||
    text.startsWith('<local-command-stdout>')
  );
}

function readTranscript(transcriptPath) {
  const size = fs.statSync(transcriptPath).size;
  if (size <= MAX_FULL_READ_BYTES) return fs.readFileSync(transcriptPath, 'utf8');
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const head = Buffer.alloc(HEAD_BYTES);
    fs.readSync(fd, head, 0, HEAD_BYTES, 0);
    const tail = Buffer.alloc(TAIL_BYTES);
    fs.readSync(fd, tail, 0, TAIL_BYTES, size - TAIL_BYTES);
    const headText = head.toString('utf8');
    let tailText = tail.toString('utf8');
    const nl = tailText.indexOf('\n');
    tailText = nl >= 0 ? tailText.slice(nl + 1) : '';
    return headText.slice(0, headText.lastIndexOf('\n') + 1) + tailText;
  } finally {
    fs.closeSync(fd);
  }
}

// Datos de la sesion a partir del transcript: primera y ultima marca de
// tiempo, minutos y turnos humanos. Devuelve null si no hay transcript legible.
function sessionStats(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  let text;
  try {
    text = readTranscript(transcriptPath);
  } catch (_) {
    return null;
  }
  let first = null;
  let last = null;
  let humanTurns = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const ts = entry && entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      if (first === null || ts < first) first = ts;
      if (last === null || ts > last) last = ts;
    }
    if (isHumanUserEntry(entry)) humanTurns++;
  }
  const minutes = first !== null && last !== null ? Math.max(0, Math.round((last - first) / 60000)) : 0;
  return {
    started_at: first !== null ? new Date(first).toISOString() : null,
    ended_at: last !== null ? new Date(last).toISOString() : null,
    minutes,
    human_turns: humanTurns,
  };
}

// Commits del repo de `cwd` entre dos instantes (evidencia de trabajo
// registrado). Best-effort: 0 ante cualquier fallo.
function commitsBetween(cwd, startIso, endIso) {
  if (!cwd || !startIso) return 0;
  try {
    const args = ['-C', cwd, 'rev-list', '--count', `--since=${startIso}`, 'HEAD'];
    if (endIso) args.push(`--until=${endIso}`);
    const out = execFileSync('git', args, { encoding: 'utf8', timeout: 4000, windowsHide: true });
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch (_) {
    return 0;
  }
}

function stats(lastN = STATS_WINDOW) {
  const entries = readFeedback().slice(-lastN);
  const out = { n: entries.length, si: 0, no: 0, estorbo: 0, sin_respuesta: 0, pct_si: null };
  for (const e of entries) {
    if (e.answer in out) out[e.answer]++;
  }
  if (out.n) out.pct_si = Math.round((out.si / out.n) * 100);
  return out;
}

function fechaCorta(iso) {
  return String(iso || '').slice(0, 10) || '?';
}

// Lineas para el resume de SessionStart: la pregunta pendiente (si la hay para
// este proyecto) y la cifra global. Sin datos ni pendiente: [].
function renderResumeLines(project) {
  const out = [];
  const pending = project && !isExcluded(project) ? readPending(project) : null;
  if (pending) {
    const fecha = fechaCorta(pending.ended_at);
    out.push(
      `feedback_pendiente: la sesion anterior en este proyecto (${fecha}, ${pending.minutes || 0} min, ` +
      `${pending.human_turns || 0} turnos, ${pending.commits || 0} commits) no tiene feedback. ` +
      `PREGUNTA al usuario en tu primera respuesta, en una sola linea: ` +
      `"¿Ayudo ULTRON en la sesion del ${fecha}? Contesta 'fb: si', 'fb: no' o 'fb: estorbo' (nota opcional)". ` +
      `Si no contesta, no insistas.`,
    );
  }
  const s = stats();
  if (s.n) {
    out.push(
      `session_feedback (ultimas ${s.n} sesiones de proyecto): si ${s.pct_si} % · no ${s.no} · ` +
      `estorbo ${s.estorbo} · sin respuesta ${s.sin_respuesta} (objetivo ≥${GOAL_PCT_SI} %)`,
    );
  }
  return out;
}

module.exports = {
  PROJECTS_DIR,
  LOG_PATH,
  EXCLUDED_PROJECTS,
  MIN_HUMAN_TURNS,
  STATS_WINDOW,
  GOAL_PCT_SI,
  ANSWER_LABEL,
  pendingPath,
  projectDirExists,
  isExcluded,
  readPending,
  writePending,
  removePending,
  appendFeedback,
  readFeedback,
  parseAnswer,
  sessionStats,
  commitsBetween,
  stats,
  renderResumeLines,
};
