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

// Tope del bloque inyectado al arranque. Subio de 2500 a 3200 el 2026-09-22:
// con 2500 y un corte ciego, el resumen de 4683 caracteres del 21-09 perdia
// entero "## Pendientes" (donde estaba la rama maria-core) y el arranque
// siguiente no sabia de que iba la sesion anterior. Ahora el recorte es por
// secciones (ver clipSummary), asi que el tope solo decide cuantas caben.
const MAX_CHARS = 3200;

// Orden en el que las secciones de summary.md se salvan cuando no cabe todo:
// lo pendiente es lo que el arranque necesita; los ficheros son lo prescindible.
const SECTION_PRIORITY = ['pendientes', 'decisiones', 'temas'];

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
  return summaryMtimeMs(projectId, sessionId) !== null;
}

/**
 * mtime (ms) del summary.md de esta sesion, o null si no existe / no es un
 * fichero. Lo usa el resumidor para detectar un resumen VIEJO: uno escrito a
 * mitad de sesion (el 21-09 se genero a las 17:29 y la sesion siguio hasta las
 * 18:35) que ya no cubre lo que paso despues.
 */
function summaryMtimeMs(projectId, sessionId) {
  if (!projectId || !sessionId) return null;
  try {
    const st = fs.statSync(summaryPath(projectId, sessionId));
    return st.isFile() ? st.mtimeMs : null;
  } catch {
    return null;
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
  const clipped = clipSummary(summary.content, MAX_CHARS);
  return [
    `<last-session-summary source="claude-p" trust="session-summary" session_id="${summary.sessionId}">`,
    clipped,
    '</last-session-summary>',
  ];
}

/**
 * Recorta un summary.md a `max` caracteres POR SECCIONES, no por bytes: se
 * conserva la cabecera (frontmatter) y se van salvando secciones enteras por
 * prioridad (Pendientes > Decisiones > Temas > el resto en su orden) mientras
 * quepan; las que no caben se omiten y se anota cuales. Si ni la primera cabe
 * entera, esa unica se trunca con "[...]" para que el bloque nunca quede vacio.
 * Las secciones conservadas salen en su orden original. Puro.
 * @param {string} content
 * @param {number} max
 * @returns {string}
 */
function clipSummary(content, max) {
  if (typeof content !== 'string') return '';
  if (content.length <= max) return content;

  const parts = content.split(/^(?=## )/m);
  const head = parts[0].startsWith('## ') ? '' : parts.shift();
  const sections = parts.map((text, index) => {
    const title = (text.match(/^## +(.*)$/m) || [, ''])[1].trim();
    const key = title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    let rank = SECTION_PRIORITY.findIndex((p) => key.startsWith(p));
    if (rank < 0) rank = SECTION_PRIORITY.length + index;
    return { index, title, text: text.replace(/\s+$/, '') + '\n\n', rank };
  });
  if (sections.length === 0) return content.slice(0, max) + '\n[...]';

  let budget = max - head.length;
  const kept = new Set();
  const byPriority = [...sections].sort((a, b) => a.rank - b.rank || a.index - b.index);
  for (const s of byPriority) {
    if (s.text.length <= budget) {
      kept.add(s.index);
      budget -= s.text.length;
    } else if (kept.size === 0) {
      // Ni la seccion prioritaria cabe entera: truncarla antes que perderla.
      s.text = s.text.slice(0, Math.max(0, budget - 6)) + '\n[...]\n';
      kept.add(s.index);
      budget = 0;
    }
  }
  const omitted = sections.filter((s) => !kept.has(s.index)).map((s) => s.title);
  const body = sections
    .filter((s) => kept.has(s.index))
    .map((s) => s.text)
    .join('');
  const note = omitted.length ? `[... secciones omitidas por tamano: ${omitted.join(', ')}]` : '';
  return (head + body + note).replace(/\s+$/, '');
}

module.exports = {
  projectsDir,
  MAX_CHARS,
  summaryDir,
  summaryPath,
  hasSummary,
  summaryMtimeMs,
  latestSummary,
  readSummary,
  renderLastSessionLines,
  clipSummary,
};
