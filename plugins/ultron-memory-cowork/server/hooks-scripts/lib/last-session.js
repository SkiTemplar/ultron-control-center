'use strict';

/**
 * lib/last-session.js — lectura del resumen de sesion (fichero por sesion,
 * NUNCA brain.db: decision del usuario 2026-09-11). Vive en
 * cockpit/projects/<projectId>/sessions/<sessionId>/summary.md, escrito por
 * session-summarize-previous.js.
 *
 * Puro (solo fs de lectura); lo comparten memory-session-resume.js
 * (SessionStart: inyecta el ultimo summary.md que haya) y memory-orchestrate.js
 * (UserPromptSubmit: entrega el resumen pendiente si SessionStart no llego a
 * tiempo — ver lib/session-summary-delivery.js). Ninguno de los dos puede
 * requerir el script del otro directamente (ambos tienen efectos de arranque:
 * observe(), spawnDetached) — este modulo es el punto de encuentro sin
 * efectos secundarios.
 *
 * Confianza (revision de codigo 2026-09-11): el contenido de summary.md lo
 * escribio un modelo (`claude -p`), no el sistema — renderLastSessionLines()
 * lo entrega en su PROPIO bloque `trust="session-summary"`, nunca mezclado con
 * el `trust="system"` del resume/orquestacion que lo envuelve.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { safeId } = require('./safe-id');

const MAX_CHARS = 2500;

// Leido en cada llamada (no como constante de modulo) para que los tests
// puedan redirigirlo con LAST_SESSION_PROJECTS_DIR sin tocar el cockpit real
// (mismo patron que lib/project-identity.js).
function projectsDir() {
  return process.env.LAST_SESSION_PROJECTS_DIR || path.join(os.homedir(), '.ultron', 'cockpit', 'projects');
}

function summaryDir(projectId, sessionId) {
  return path.join(projectsDir(), safeId(projectId), 'sessions', safeId(sessionId));
}

function summaryPath(projectId, sessionId) {
  return path.join(summaryDir(projectId, sessionId), 'summary.md');
}

/** ¿Existe ya summary.md para esta sesion? Solo fs.statSync -- nunca lee el contenido. */
function hasSummary(projectId, sessionId) {
  if (!projectId || !sessionId) return false;
  try {
    return fs.statSync(summaryPath(projectId, sessionId)).isFile();
  } catch {
    return false;
  }
}

/**
 * El summary.md mas reciente (por mtime) de `projectId`, excluyendo
 * `excludeSessionId` (la sesion actual, que nunca tiene resumen de si misma).
 * `opts.sinceMs`: ignora summaries con mtime <= sinceMs (usado por la entrega
 * diferida para no confundir un summary.md YA existente antes de que empezara
 * la espera con el que genero el resumidor de ESTA sesion).
 * @returns {{sessionId: string, content: string}|null}
 */
function latestSummary(projectId, excludeSessionId, opts = {}) {
  if (!projectId) return null;
  const sessionsDir = path.join(projectsDir(), safeId(projectId), 'sessions');
  let entries;
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  let best = null;
  for (const e of entries) {
    if (!e.isDirectory() || e.name === excludeSessionId) continue;
    let st;
    try {
      st = fs.statSync(path.join(sessionsDir, e.name, 'summary.md'));
    } catch {
      continue;
    }
    if (Number.isFinite(opts.sinceMs) && st.mtimeMs <= opts.sinceMs) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { sessionId: e.name, mtimeMs: st.mtimeMs };
  }
  if (!best) return null;
  return readSummary(projectId, best.sessionId);
}

/** El summary.md de una sesion concreta, o null si no existe / no es legible. */
function readSummary(projectId, sessionId) {
  if (!projectId || !sessionId) return null;
  try {
    const content = fs.readFileSync(summaryPath(projectId, sessionId), 'utf8').trim();
    if (!content) return null;
    return { sessionId, content };
  } catch {
    return null;
  }
}

/**
 * Lineas del bloque `last_session` para el resume/orquestacion, YA envueltas
 * en su propia etiqueta de confianza (el contenido lo escribio un modelo, no
 * el sistema). [] si no hay nada.
 */
function renderLastSessionLines(summary) {
  if (!summary || !summary.content) return [];
  const clipped =
    summary.content.length > MAX_CHARS
      ? summary.content.slice(0, MAX_CHARS) + '\n[...]'
      : summary.content;
  return [
    `<last-session-summary source="claude-p" trust="session-summary" session_id="${summary.sessionId}">`,
    clipped,
    '</last-session-summary>',
  ];
}

module.exports = {
  projectsDir,
  MAX_CHARS,
  summaryDir,
  summaryPath,
  hasSummary,
  latestSummary,
  readSummary,
  renderLastSessionLines,
};
