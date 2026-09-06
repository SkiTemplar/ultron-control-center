'use strict';

// hooks/scripts/lib/transcript-turns.js — turnos de texto de un transcript
// JSONL de Claude Code, a partir de su cola acotada (readJsonlTail).
//
// Compartido por `session-end-summary` (resumen de cierre) y `lesson-distill`
// (destilado de lecciones, ULTRON 4 F1.2). Antes vivía como `parseTurns`
// dentro de session-end-summary.js.
//
// Devuelve [{ role, text }] con role en 'user' | 'assistant' | 'tool_error'.
// Los `tool_error` son bloques `tool_result` con `is_error: true` dentro de
// entradas `user`: son la señal más barata de "algo falló" que tiene un
// transcript, y sin ellos una lección no sabe de qué síntoma habla. Solo se
// emiten con `includeToolErrors: true` para no cambiar el resumen de cierre.

const { readJsonlTail } = require('./jsonl-tail');

const DEFAULT_MAX_TURNS = 40;
const DEFAULT_TEXT_CHARS = 400;

function blockText(block) {
  if (!block || typeof block !== 'object') return '';
  if (typeof block.text === 'string') return block.text;
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

/**
 * @param {string} jsonlPath transcript de la sesión
 * @param {{maxTurns?: number, textChars?: number, includeToolErrors?: boolean, tailBytes?: number}} [opts]
 * @returns {{role: string, text: string}[]} los últimos `maxTurns` turnos CON texto
 */
function parseTurns(jsonlPath, opts) {
  const o = opts || {};
  const maxTurns = Number.isFinite(o.maxTurns) ? o.maxTurns : DEFAULT_MAX_TURNS;
  const textChars = Number.isFinite(o.textChars) ? o.textChars : DEFAULT_TEXT_CHARS;
  const includeToolErrors = Boolean(o.includeToolErrors);

  // Se recorren TODAS las lineas de la cola y se recortan los turnos al final,
  // no las lineas al principio: en una sesion con herramientas, las ultimas 60
  // lineas son casi todas tool_use/tool_result sin texto (medido 2026-09-02
  // sobre un transcript real de 1,8 MB: 60 lineas -> 265 caracteres de digest).
  const lines = readJsonlTail(jsonlPath, o.tailBytes).filter((l) => l.trim());
  const turns = [];
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const type = obj.type || '';
    if (type !== 'user' && type !== 'assistant') continue;
    const msg = obj.message || obj;
    const content = msg.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block) continue;
        if (block.type === 'text' && block.text) {
          text = block.text;
          break;
        }
        if (includeToolErrors && type === 'user' && block.type === 'tool_result' && block.is_error === true) {
          const err = blockText(block).trim();
          if (err) turns.push({ role: 'tool_error', text: err.slice(0, textChars) });
        }
      }
    }
    if (text.trim()) turns.push({ role: type, text: text.trim().slice(0, textChars) });
  }
  return turns.slice(-maxTurns);
}

module.exports = { parseTurns, DEFAULT_MAX_TURNS, DEFAULT_TEXT_CHARS };
