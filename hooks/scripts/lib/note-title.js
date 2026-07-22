#!/usr/bin/env node
// hooks/scripts/lib/note-title.js — titulado informativo para agent_notes.
//
// Problema (sprint recall 2026-07-22): 1181/3594 items activos eran agent_note
// con titulo generico "Subagente <tipo> — resultado", indistinguibles entre si
// en el top-k del recall. Este modulo deriva el titulo del CONTENIDO real:
//   1. primera frase significativa del resultado del subagente,
//   2. si no hay, el objetivo de la tarea (label/description del Task),
//   3. si no hay nada, el titulo generico viejo (fallback, nunca vacio).
//
// El titulo pasa por redactSecrets (misma redaccion que el resto de hooks);
// el write-path Rust (create_candidate) vuelve a redactar proposed_title —
// esto es defensa en profundidad, no la unica barrera.
//
// deriveNoteTitle NUNCA lanza: cualquier error interno degrada al titulo viejo
// (un hook SubagentStop roto no debe romper el harness).

'use strict';

const { redactSecrets } = require('./security-helpers');

const TITLE_MAX = 80;
// Lineas mas cortas no identifican nada ("OK.", "Done") — se saltan al buscar
// la frase significativa.
const MIN_MEANINGFUL_LINE = 15;
// Una "frase" cortada antes de este largo suele ser una abreviatura (e.g., p.ej.)
// o un lead vacio — se exige un minimo antes del terminador.
const MIN_SENTENCE_CHARS = 20;

// Linea de pura decoracion markdown: separadores, fences, bullets vacios.
const DECOR_LINE = /^(?:[#>*\-=_~\s]+|```.*)$/;

function truncateTitle(s, max) {
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  // Corta en palabra solo si no pierde mas del ~40% del titulo.
  if (sp > max * 0.6) cut = cut.slice(0, sp);
  return cut.replace(/[\s,;:.\-]+$/, '') + '…';
}

// Quita marcado markdown que no aporta al titulo, sin tocar identificadores
// (no se eliminan guiones bajos: `foo_bar` debe sobrevivir).
function stripMarkdown(line) {
  return line
    .replace(/^[#>]+\s*/, '') // heading / blockquote
    .replace(/^(?:[-*+]|\d+[.)])\s+/, '') // bullet / lista numerada
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
}

// Primera linea con contenido real del resultado (salta decoracion, bloques de
// codigo enteros y lineas demasiado cortas). Si ninguna linea llega al minimo,
// devuelve la primera no decorativa como mejor esfuerzo.
function firstMeaningfulLine(text) {
  let firstNonDecor = '';
  let inFence = false;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue; // el codigo dentro del fence no titula la nota
    const line = stripMarkdown(trimmed);
    if (!line) continue;
    if (DECOR_LINE.test(line)) continue;
    if (!firstNonDecor) firstNonDecor = line;
    if (line.length >= MIN_MEANINGFUL_LINE) return line;
  }
  return firstNonDecor;
}

// Recorta la linea a su primera frase si el corte deja algo sustancial.
function firstSentence(line) {
  const collapsed = line.replace(/\s+/g, ' ').trim();
  const m = collapsed.match(/^.{20,}?[.!?](?=\s|$)/);
  if (m && m[0].length >= MIN_SENTENCE_CHARS) return m[0];
  return collapsed;
}

/**
 * Deriva el titulo informativo de un agent_note.
 * @param {{agent?: string, label?: string, resultText?: string}} input
 * @returns {string} titulo (<= ~80 chars) — nunca vacio, nunca lanza.
 */
function deriveNoteTitle(input) {
  const agent = (input && typeof input.agent === 'string' && input.agent.trim()) || 'unknown';
  const fallback = `Subagente ${agent} — resultado`;
  try {
    const label = (input && typeof input.label === 'string' && input.label.trim()) || '';
    const resultText = (input && typeof input.resultText === 'string' && input.resultText) || '';

    let base = '';
    const line = firstMeaningfulLine(resultText);
    if (line) base = firstSentence(line);
    if (!base && label) base = label.replace(/\s+/g, ' ').trim();
    if (!base) return fallback;

    // Prefijo de tipo solo cuando identifica algo ('unknown' no aporta).
    const prefix = agent !== 'unknown' ? `[${agent}] ` : '';
    const title = truncateTitle(prefix + base, TITLE_MAX);
    return redactSecrets(title);
  } catch (_) {
    return fallback;
  }
}

module.exports = { deriveNoteTitle, TITLE_MAX };
