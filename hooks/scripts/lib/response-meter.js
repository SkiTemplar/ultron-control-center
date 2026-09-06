'use strict';
/**
 * lib/response-meter.js — medidor de concision (ULTRON 4, F4.2 y 7.3).
 *
 * Mide cada respuesta del asistente (lineas, palabras, cabeceras, listas,
 * tablas, disculpas y preambulos) y la registra en logs/response-meter.jsonl.
 * El resume de SessionStart pinta la media de las ultimas sesiones y la
 * tendencia: la concision deja de ser una opinion y pasa a ser una cifra.
 *
 * Limite (Q4b): una respuesta esta "sobre el limite" si supera MAX_LINES
 * lineas no vacias o MAX_WORDS palabras. Se ajusta por entorno
 * (RESPONSE_METER_MAX_LINES / RESPONSE_METER_MAX_WORDS).
 *
 * Overrides (selftest): RESPONSE_METER_LOG.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const LOG_PATH = process.env.RESPONSE_METER_LOG || path.join(HOME, '.ultron', 'logs', 'response-meter.jsonl');
const MAX_LINES = Number(process.env.RESPONSE_METER_MAX_LINES) > 0 ? Number(process.env.RESPONSE_METER_MAX_LINES) : 12;
const MAX_WORDS = Number(process.env.RESPONSE_METER_MAX_WORDS) > 0 ? Number(process.env.RESPONSE_METER_MAX_WORDS) : 220;
const SESSIONS_WINDOW = 3;

// Disculpas y autocorreccion narrada (7.3): lo que el usuario pidio no leer.
// Cierre con lookahead: sin bandera `u`, \b no funciona tras vocal acentuada
// ("equivoqué", "razón").
const APOLOGY_RE = /\b(perd[oó]n(?:ame)?|disculpa[s]?|disc[uú]lpame|lo siento|mi error|mi equivocaci[oó]n|me equivoqu[eé]|me he equivocado|tienes raz[oó]n|ten[eé]is raz[oó]n|llevas raz[oó]n|mea culpa|sorry|my mistake|my bad|you'?re right|apologies)(?![a-z0-9áéíóúüñ])/gi;
// Preambulos vacios al empezar la respuesta o una linea.
const PREAMBLE_RE = /^\s*(?:¡\s*)?(buena pregunta|claro que s[ií]|por supuesto|desde luego|claro|great question|good question|of course|sure|certainly|absolutely)\b/gim;

function measure(text) {
  const raw = String(text || '');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const words = raw.split(/\s+/).filter(Boolean).length;
  const headers = lines.filter((l) => /^#{1,6}\s/.test(l)).length;
  const bullets = lines.filter((l) => /^(?:[-*•]|\d+[.)])\s/.test(l)).length;
  const tables = lines.filter((l) => l.startsWith('|')).length;
  const fences = (raw.match(/^```/gm) || []).length;
  const apologies = (raw.match(APOLOGY_RE) || []).length;
  const preambles = (raw.match(PREAMBLE_RE) || []).length;
  return {
    chars: raw.length,
    lines: lines.length,
    words,
    headers,
    bullets,
    tables,
    fences,
    apologies,
    preambles,
    over_limit: lines.length > MAX_LINES || words > MAX_WORDS,
  };
}

function appendEntry(entry) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
}

function readEntries() {
  try {
    return fs
      .readFileSync(LOG_PATH, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l); } catch (_) { return null; }
      })
      .filter((e) => e && e.session_id && Number.isFinite(e.lines));
  } catch (_) {
    return [];
  }
}

// Agregado por sesion (orden de aparicion), ultimas `lastN` sesiones.
function statsBySession(lastN = SESSIONS_WINDOW) {
  const bySession = new Map();
  for (const e of readEntries()) {
    if (!bySession.has(e.session_id)) bySession.set(e.session_id, { session_id: e.session_id, n: 0, lines: 0, words: 0, over: 0, apologies: 0, preambles: 0 });
    const s = bySession.get(e.session_id);
    s.n++;
    s.lines += e.lines;
    s.words += e.words || 0;
    s.over += e.over_limit ? 1 : 0;
    s.apologies += e.apologies || 0;
    s.preambles += e.preambles || 0;
  }
  return Array.from(bySession.values()).slice(-lastN).map((s) => ({
    ...s,
    avg_lines: s.n ? Math.round((s.lines / s.n) * 10) / 10 : 0,
    over_pct: s.n ? Math.round((s.over / s.n) * 100) : 0,
  }));
}

function fmt(n) {
  return String(n).replace('.', ',');
}

// Una linea para el resume; '' sin datos.
function renderResumeLine() {
  const sessions = statsBySession();
  if (!sessions.length) return '';
  const n = sessions.reduce((a, s) => a + s.n, 0);
  const lines = sessions.reduce((a, s) => a + s.lines, 0);
  const over = sessions.reduce((a, s) => a + s.over, 0);
  const apologies = sessions.reduce((a, s) => a + s.apologies, 0);
  const preambles = sessions.reduce((a, s) => a + s.preambles, 0);
  const avg = n ? Math.round((lines / n) * 10) / 10 : 0;
  const overPct = n ? Math.round((over / n) * 100) : 0;
  let trend = '=';
  if (sessions.length >= 2) {
    const last = sessions[sessions.length - 1].avg_lines;
    const prev = sessions[sessions.length - 2].avg_lines;
    trend = last < prev ? 'baja' : last > prev ? 'sube' : '=';
  }
  return (
    `response_meter (ultimas ${sessions.length} sesiones, ${n} respuestas): media ${fmt(avg)} lineas · ` +
    `${overPct} % sobre el limite (${MAX_LINES} lineas/${MAX_WORDS} palabras) · disculpas ${apologies} · ` +
    `preambulos ${preambles} · tendencia ${trend}`
  );
}

module.exports = {
  LOG_PATH,
  MAX_LINES,
  MAX_WORDS,
  SESSIONS_WINDOW,
  APOLOGY_RE,
  PREAMBLE_RE,
  measure,
  appendEntry,
  readEntries,
  statsBySession,
  renderResumeLine,
};
