'use strict';

/**
 * lib/session-summary-delivery.js — coordina la entrega DIFERIDA del resumen
 * de la sesion anterior entre memory-session-resume.js (SessionStart) y
 * memory-orchestrate.js (UserPromptSubmit).
 *
 * SessionStart no puede esperar los 20-40s que tarda `claude -p`
 * (session-summarize-previous.js), asi que si una comprobacion BARATA (stat/
 * mtime, sin leer transcripts — la seleccion completa vive en el proceso
 * desacoplado) sugiere que hay una sesion anterior sin resumir, la lanza en
 * segundo plano y deja un marcador "pending" con la hora de inicio (SIN
 * sesion objetivo: cual sea la que el resumidor elija de verdad se descubre
 * por la marca de tiempo, no adivinando aqui). El primer prompt real de la
 * sesion nueva (memory-orchestrate.js) consulta ese marcador en cada turno
 * hasta resolverlo:
 *   - si aparece un summary.md del proyecto con mtime POSTERIOR al inicio de
 *     la espera, es el que genero el resumidor: se entrega UNA vez y se marca
 *     resuelto.
 *   - si no, y sigue dentro del plazo maximo de espera, no hace nada (coste
 *     de un par de fs.existsSync/readdirSync — nada que espere red ni CLI).
 *   - si el plazo expiro sin resumen (el resumidor fallo o se colgo), marca
 *     resuelto igualmente para dejar de comprobar.
 * Una vez resuelto, todo prompt siguiente de esa sesion sale con una sola
 * comprobacion fs.existsSync ("sin coste en los prompts siguientes").
 *
 * Puro salvo el estado en ~/.ultron/.tmp/ (fail-safe: cualquier error de fs
 * se trata como "nada que entregar", nunca lanza).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { safeId } = require('./safe-id');

const STATE_DIR = path.join(os.homedir(), '.ultron', '.tmp');
// Plazo de espera: TIMEOUT_MS de session-summarize-previous.js (180s) + 20s de
// margen para el arranque del proceso desacoplado y la escritura del fichero.
const MAX_WAIT_MS = 200 * 1000;

function pendingPath(sessionId) {
  return path.join(STATE_DIR, `session-summary-pending-${safeId(sessionId)}.json`);
}

function resolvedPath(sessionId) {
  return path.join(STATE_DIR, `session-summary-resolved-${safeId(sessionId)}.json`);
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, file);
}

function isResolved(sessionId) {
  try {
    return fs.existsSync(resolvedPath(sessionId));
  } catch {
    return true; // fail-safe: ante duda, no seguir comprobando en cada prompt
  }
}

function markResolved(sessionId) {
  try {
    writeJsonAtomic(resolvedPath(sessionId), { resolved_at: Date.now() });
  } catch {
    /* best effort */
  }
}

/** SessionStart: `sessionId` (la sesion nueva) espera un resumen desde ahora. */
function writePending(sessionId) {
  if (!sessionId) return;
  try {
    writeJsonAtomic(pendingPath(sessionId), { started_at: Date.now() });
  } catch {
    /* best effort: sin marcador, memory-orchestrate.js simplemente no entrega nada */
  }
}

function readPending(sessionId) {
  try {
    const obj = JSON.parse(fs.readFileSync(pendingPath(sessionId), 'utf8'));
    if (obj && Number.isFinite(obj.started_at)) return obj;
  } catch {
    /* sin pendiente, o ilegible */
  }
  return null;
}

/**
 * Resuelve la entrega para `sessionId`. `findFreshSummary(sinceMs)` debe
 * devolver `{sessionId, content}` del summary.md mas reciente posterior a
 * `sinceMs`, o null (normalmente `lib/last-session.js#latestSummary` con
 * `{sinceMs}`).
 * @returns {{sessionId: string, content: string}|null}
 */
function resolveDelivery(sessionId, findFreshSummary) {
  if (!sessionId || isResolved(sessionId)) return null;
  const pending = readPending(sessionId);
  if (!pending) return null; // nunca hubo nada pendiente para esta sesion
  const summary = findFreshSummary(pending.started_at);
  if (summary) {
    markResolved(sessionId);
    return summary;
  }
  if (Date.now() - pending.started_at > MAX_WAIT_MS) markResolved(sessionId);
  return null;
}

module.exports = {
  MAX_WAIT_MS,
  pendingPath,
  resolvedPath,
  isResolved,
  markResolved,
  writePending,
  readPending,
  resolveDelivery,
};
