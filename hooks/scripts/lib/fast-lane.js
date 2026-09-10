'use strict';
/**
 * lib/fast-lane.js — carril de doble velocidad del hot path (UserPromptSubmit).
 *
 * Decidido por el usuario el 2026-09-07 (opción 1 con la 3 de red): un ack,
 * una continuación o un prompt muy corto NO paga ni el orchestrate del daemon
 * (recall + routing + tono, p50 652 ms, hasta 15 s con E5 frío) ni el
 * dispatcher de skills (~760 ms). Reglas duras:
 *
 *   - El PRIMER prompt de la sesión va siempre completo ("tocho"): es el que
 *     más memoria necesita y el que hoy llegaba vacío.
 *   - Una pregunta de estado (pendiente, cómo va, qué teníamos, resumen…) va
 *     completa aunque sea corta.
 *   - Red de seguridad: tras FAST_STREAK_MAX prompts rápidos seguidos, o si el
 *     último completo tiene más de FAST_STREAK_MAX_MS, el siguiente va completo
 *     aunque parezca un ack, para que la memoria no se quede desfasada.
 *
 * Estado por sesión en ~/.ultron/.tmp/fastlane-<session>.json:
 *   { prompts, fast_streak, last_full_ms }
 * Lo incrementa `markPrompt` (llamado por memory-orchestrate, el último hook
 * del grupo); el dispatcher solo lee, así que ambos ven el mismo conteo en el
 * mismo turno. Puro salvo el fichero de estado; nunca lanza.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAST_STREAK_MAX = 6;
const FAST_STREAK_MAX_MS = 15 * 60 * 1000;
const FAST_MAX_WORDS = 8;

const STATE_DIR = path.join(os.homedir(), '.ultron', '.tmp');

/** Tokens que un ack o una continuación pueden contener (todos deben estarlo). */
const ACK_TOKENS = new Set([
  'ok', 'okey', 'okay', 'vale', 'va', 'dale', 'si', 'yes', 'yep', 'no', 'nop',
  'perfecto', 'genial', 'guay', 'bien', 'correcto', 'exacto', 'eso', 'claro',
  'hazlo', 'adelante', 'venga', 'sigue', 'continua', 'continue', 'go', 'procede',
  'gracias', 'thanks', 'listo', 'hecho', 'entendido', 'de', 'acuerdo', 'asi', 'sea',
  'y', 'e', 'o', 'u', 'con', 'el', 'la', 'lo', 'los', 'las', 'un', 'una', 'ese', 'esa',
  'esto', 'eso', 'primero', 'ahora', 'luego', 'despues', 'tambien', 'entonces',
  'pues', 'pero', 'sin', 'ya', 'mejor', 'opcion', 'option', 'numero', 'la', 'del',
  'por', 'favor', 'porfa', 'plis', 'please', 'todo', 'todos', 'ambos', 'ambas',
  'fb', 'estorbo', 'aplicalo', 'aplica', 'mergea', 'commitea', 'pushea', 'push',
  'commit', 'confirmo', 'confirmado', 'apruebo', 'aprobado', 'acepto', 'quiero',
  'prefiero', 'me', 'gusta', 'parece', 'debe', 'ser', 'deberia', 'diria', 'yo',
  'te', 'lo', 'que', 'tu', 'mismo', 'misma', 'tal', 'cual', 'como', 'dices',
]);

/** Verbos de continuación: el prompt puede llevar hasta FAST_MAX_WORDS más. */
const CONTINUATION_RE = /^(sigue|continua|continue|dale|hazlo|adelante|venga|procede|retoma|termina|acaba|cierra)\b/;

/** Pregunta de estado: SIEMPRE completa aunque sea corta. */
const STATUS_RE = /\b(pendiente|pendientes|estado|status|como va|como vamos|que teniamos|que tenemos|que falta|que queda|que hay|donde estamos|donde vamos|resumen|resume|recap|siguiente paso|siguientes pasos|next steps?|memoria|kanban|tablero|plan|roadmap|prioridad|prioridades)\b/;

/** Señales técnicas mínimas: una orden con esto no es un ack. */
const TECH_RE = /\b(arregla|fix|bug|error|fallo|implementa|refactor|build|test|tests|deploy|despliega|revisa|review|analiza|explica|investiga|busca|crea|escribe|borra|elimina|cambia|mueve|renombra|instala|actualiza|mide|compara|por que|porque|why|how|como se)\b/;

function normalize(prompt) {
  return String(prompt || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s?¿]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Clase del prompt: 'status' | 'ack' | 'other'.
 * 'ack' cubre acks puros ("ok", "1 y 2", "dale") y continuaciones cortas
 * ("sigue con el F1.7"). Cualquier interrogación, señal técnica o longitud
 * mayor que FAST_MAX_WORDS lo saca del carril rápido.
 */
function classify(prompt) {
  const norm = normalize(prompt);
  if (!norm) return 'other';
  if (STATUS_RE.test(norm)) return 'status';
  if (norm.includes('?') || norm.includes('¿')) return 'other';
  const words = norm.split(' ').filter(Boolean);
  if (words.length > FAST_MAX_WORDS) return 'other';
  if (TECH_RE.test(norm)) return 'other';
  if (CONTINUATION_RE.test(norm)) return 'ack';
  const allAck = words.every((w) => ACK_TOKENS.has(w) || /^\d+$/.test(w) || /^[a-z]$/.test(w));
  return allAck ? 'ack' : 'other';
}

function statePath(sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '-');
  return path.join(STATE_DIR, `fastlane-${safe}.json`);
}

function readState(sessionId) {
  if (!sessionId) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(statePath(sessionId), 'utf8'));
    return {
      prompts: Number(obj.prompts) || 0,
      fast_streak: Number(obj.fast_streak) || 0,
      last_full_ms: Number(obj.last_full_ms) || 0,
    };
  } catch {
    return { prompts: 0, fast_streak: 0, last_full_ms: 0 };
  }
}

/**
 * Registra que este prompt se ha servido (`full` = pasó por el camino completo).
 * Escritura write-then-rename; best-effort, nunca lanza.
 */
function markPrompt(sessionId, { full, now = Date.now() } = {}) {
  if (!sessionId) return null;
  const prev = readState(sessionId) || { prompts: 0, fast_streak: 0, last_full_ms: 0 };
  const next = {
    prompts: prev.prompts + 1,
    fast_streak: full ? 0 : prev.fast_streak + 1,
    last_full_ms: full ? now : prev.last_full_ms,
  };
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const p = statePath(sessionId);
    const tmp = `${p}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, p);
  } catch {
    /* estado best-effort */
  }
  return next;
}

/**
 * Decisión del carril para este prompt: { lane: 'fast'|'full', reason, class }.
 * `state` se puede inyectar (tests); si no, se lee del fichero de la sesión.
 */
function decide({ prompt, sessionId, state, now = Date.now() }) {
  const cls = classify(prompt);
  if (!sessionId) return { lane: 'full', reason: 'sin session_id', class: cls };
  const st = state || readState(sessionId);
  if (!st || st.prompts === 0) return { lane: 'full', reason: 'primer prompt de la sesion', class: cls };
  if (cls === 'status') return { lane: 'full', reason: 'pregunta de estado', class: cls };
  if (cls !== 'ack') return { lane: 'full', reason: 'prompt con contenido', class: cls };
  if (st.fast_streak >= FAST_STREAK_MAX) {
    return { lane: 'full', reason: `racha rapida agotada (${st.fast_streak})`, class: cls };
  }
  if (st.last_full_ms && now - st.last_full_ms > FAST_STREAK_MAX_MS) {
    return { lane: 'full', reason: 'ultimo completo hace mas de 15 min', class: cls };
  }
  return { lane: 'fast', reason: 'ack o continuacion corta', class: cls };
}

module.exports = {
  classify,
  decide,
  markPrompt,
  readState,
  statePath,
  FAST_STREAK_MAX,
  FAST_STREAK_MAX_MS,
  FAST_MAX_WORDS,
};
