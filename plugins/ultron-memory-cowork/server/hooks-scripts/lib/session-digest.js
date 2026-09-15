'use strict';

/**
 * lib/session-digest.js — extrae de un transcript JSONL de Claude Code el
 * texto que de verdad importa para resumir la sesion: los prompts REALES del
 * usuario y el texto (no herramientas, no thinking) del asistente.
 *
 * Funciones puras, sin fs mas alla de la lectura del propio transcript — sin
 * red, sin sidecar, sin logging. Compartido por session-summarize-previous.js
 * (resumen con `claude -p`) y sus tests.
 *
 * Filtros de "prompt real" (mismo criterio que lib/session-feedback.js y
 * response-meter.js, que ya resolvieron este problema para otros consumidores
 * del transcript):
 *   - excluye `isMeta: true` (inyecciones de skills/contexto, no algo que
 *     el usuario escribio)
 *   - excluye bloques `tool_result` (no es un prompt, es la salida de una
 *     herramienta devuelta al modelo)
 *   - excluye turnos de sistema (`<system-reminder>`, `<task-notification>`,
 *     notificaciones de tarea en background — ver lib/system-turn.js)
 *   - excluye `[Request interrupted`, `<command-name>`, `<local-command-stdout>`
 *   - excluye `isSidechain: true` (revision de codigo 2026-09-11): son turnos
 *     de un SUBAGENTE (Task), no la conversacion principal con el usuario — ni
 *     cuentan para MIN_USER_PROMPTS ni entran en el digest.
 */

const fs = require('fs');
const { isSystemTurnPrompt } = require('./system-turn');

const DEFAULT_MAX_CHARS = 150000;
// Recortar un turno del asistente a un marcador breve en vez de borrarlo del
// todo: el hueco queda visible en el digest en vez de desaparecer sin rastro.
const TRIM_PLACEHOLDER = '[recortado por longitud]';

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function hasToolResult(content) {
  return Array.isArray(content) && content.some((b) => b && b.type === 'tool_result');
}

/** Mismo criterio que session-feedback.js / response-meter.js. */
function looksSynthetic(text) {
  if (isSystemTurnPrompt(text)) return true;
  return (
    text.startsWith('<system-reminder>') ||
    text.startsWith('<command-name>') ||
    text.startsWith('[Request interrupted') ||
    text.startsWith('<local-command-stdout>')
  );
}

/**
 * Lee el transcript COMPLETO (no la cola) y devuelve las entradas JSONL ya
 * parseadas. Fail-safe: [] si el fichero no existe o no es legible; las
 * lineas partidas o corruptas se ignoran una a una, no rompen el resto.
 * @param {string} jsonlPath
 * @returns {object[]}
 */
function readTranscriptEntries(jsonlPath) {
  let raw;
  try {
    raw = fs.readFileSync(jsonlPath, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* linea partida o corrupta: se ignora, no rompe el resto del transcript */
    }
  }
  return out;
}

/** Prompts REALES del usuario, en orden cronologico. */
function extractUserPrompts(entries) {
  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.type !== 'user' || e.isMeta === true || e.isSidechain === true) continue;
    const msg = e.message || e;
    if (!msg || msg.role !== 'user' || !msg.content) continue;
    if (hasToolResult(msg.content)) continue;
    const text = textOf(msg.content).trim();
    if (!text || looksSynthetic(text)) continue;
    out.push({ text, ts: e.timestamp || null });
  }
  return out;
}

/** Bloques de texto del asistente (sin thinking, sin tool_use), en orden. */
function extractAssistantTexts(entries) {
  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.type !== 'assistant' || e.isSidechain === true) continue;
    const msg = e.message || e;
    if (!msg || msg.role !== 'assistant') continue;
    const text = textOf(msg.content).trim();
    if (text) out.push({ text, ts: e.timestamp || null });
  }
  return out;
}

/** Primer y ultimo timestamp ISO presentes en el transcript, o null. */
function sessionTimeRange(entries) {
  let start = null;
  let end = null;
  for (const e of Array.isArray(entries) ? entries : []) {
    const ts = e && typeof e.timestamp === 'string' ? e.timestamp : null;
    if (!ts) continue;
    if (!start || ts < start) start = ts;
    if (!end || ts > end) end = ts;
  }
  return { start, end };
}

/** Turnos combinados {role, text} en orden cronologico (filtros ya aplicados). */
function mergeChronological(entries) {
  const turns = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || (e.type !== 'user' && e.type !== 'assistant') || e.isSidechain === true) continue;
    if (e.type === 'user') {
      if (e.isMeta === true) continue;
      const msg = e.message || e;
      if (!msg || msg.role !== 'user' || !msg.content || hasToolResult(msg.content)) continue;
      const text = textOf(msg.content).trim();
      if (!text || looksSynthetic(text)) continue;
      turns.push({ role: 'user', text });
    } else {
      const msg = e.message || e;
      if (!msg || msg.role !== 'assistant') continue;
      const text = textOf(msg.content).trim();
      if (text) turns.push({ role: 'assistant', text });
    }
  }
  return turns;
}

/**
 * Recorta los turnos del asistente MAS CERCANOS AL CENTRO de la secuencia de
 * turnos del asistente hasta caber en `budget` caracteres. Los del principio
 * y el final (encuadre y cierre de la sesion) se conservan intactos el mayor
 * tiempo posible.
 */
function trimAssistantFromMiddle(turns, budget) {
  const out = turns.map((t) => ({ ...t }));
  const idxs = out.reduce((acc, t, i) => {
    if (t.role === 'assistant') acc.push(i);
    return acc;
  }, []);
  let total = idxs.reduce((n, i) => n + out[i].text.length, 0);
  if (total <= budget) return out;
  const mid = (idxs.length - 1) / 2;
  const order = idxs
    .map((i, pos) => ({ i, dist: Math.abs(pos - mid) }))
    .sort((a, b) => a.dist - b.dist);
  for (const { i } of order) {
    if (total <= budget) break;
    const len = out[i].text.length;
    if (len <= TRIM_PLACEHOLDER.length) continue;
    total -= len - TRIM_PLACEHOLDER.length;
    out[i] = { ...out[i], text: TRIM_PLACEHOLDER };
  }
  return out;
}

function renderTurns(turns) {
  return turns
    .map((t) => `[${t.role === 'user' ? 'USUARIO' : 'ASISTENTE'}] ${t.text}`)
    .join('\n\n');
}

/**
 * Digest de la sesion acotado a `maxChars`: conserva TODOS los prompts del
 * usuario y recorta el texto del asistente por el medio si hace falta. Si los
 * prompts del usuario por si solos ya exceden `maxChars`, se devuelven
 * integros igualmente (mandamiento 7: mejor un digest largo que perder lo que
 * el usuario pidio) y el texto del asistente se omite por completo.
 * @param {object[]} entries  salida de readTranscriptEntries
 * @param {{maxChars?: number}} [opts]
 * @returns {string}
 */
function buildDigest(entries, opts = {}) {
  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : DEFAULT_MAX_CHARS;
  const turns = mergeChronological(entries);
  const total = turns.reduce((n, t) => n + t.text.length, 0);
  if (total <= maxChars) return renderTurns(turns);

  const userChars = turns
    .filter((t) => t.role === 'user')
    .reduce((n, t) => n + t.text.length, 0);
  const budgetForAssistant = Math.max(0, maxChars - userChars);
  return renderTurns(trimAssistantFromMiddle(turns, budgetForAssistant));
}

module.exports = {
  readTranscriptEntries,
  extractUserPrompts,
  extractAssistantTexts,
  sessionTimeRange,
  mergeChronological,
  buildDigest,
  looksSynthetic,
  DEFAULT_MAX_CHARS,
};
