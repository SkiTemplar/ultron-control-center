// hooks/scripts/lib/tone-detect.js — deteccion de tono LOCAL al hook.
//
// POR QUE EXISTE (2026-08-14): el tono lo detectaba el sidecar y viajaba dentro
// del context pack de `orchestrate`. Ese pack se CACHEA 30 min y se sirve stale
// cuando el daemon no responde a tiempo -> un prompt cani heredaba el `tone` del
// prompt anterior (o `null`), y el registro salia descafeinado o directamente
// ausente. Sintoma reportado por el usuario: "algunos tonos apenas los aplican".
//
// La deteccion es determinista, sin modelo y sin I/O mas alla de leer
// personality.json: no tiene por que depender de que el daemon de memoria este
// vivo. Este modulo la calcula en el propio hook (~1ms) y el hook SOBREESCRIBE
// el `tone` del pack, venga fresco o cacheado.
//
// PARIDAD: puerto fiel de `control-center/src-tauri/src/orchestrator/personality.rs`
// (normalize / contains_word / is_all_caps / detect). Si se toca aquel, correr
// `node hooks/scripts/_tone_parity.js` — compara esta implementacion con la de
// Rust sobre un corpus y falla si divergen.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ALL_CAPS_SIGNAL = '(GRITANDO)';
const ALL_CAPS_RATIO = 0.6;
const ALL_CAPS_MIN_LETTERS = 12;
const SIGNAL_FLOOR = 2;

const DIACRITICS = {
  á: 'a', à: 'a', ä: 'a', â: 'a',
  é: 'e', è: 'e', ë: 'e', ê: 'e',
  í: 'i', ì: 'i', ï: 'i', î: 'i',
  ó: 'o', ò: 'o', ö: 'o', ô: 'o',
  ú: 'u', ù: 'u', ü: 'u', û: 'u',
};

/** Minusculas + sin diacriticos, igual que `normalize()` en Rust. */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[áàäâéèëêíìïîóòöôúùüû]/g, (c) => DIACRITICS[c] || c);
}

const ALNUM = /[\p{L}\p{N}]/u;

/**
 * ¿`needle` (ya normalizada) aparece en `haystack` con limites de palabra?
 * Frases multi-palabra: substring con bordes no alfanumericos. Tokens sueltos:
 * equivale a palabra completa ("cani" no matchea "mecanica").
 */
function containsWord(haystack, needle) {
  if (!needle) return false;
  let from = 0;
  for (;;) {
    const pos = haystack.indexOf(needle, from);
    if (pos < 0) return false;
    const end = pos + needle.length;
    const leftOk = pos === 0 || !ALNUM.test(haystack[pos - 1]);
    const rightOk = end >= haystack.length || !ALNUM.test(haystack[end]);
    if (leftOk && rightOk) return true;
    from = end;
  }
}

function isAllCaps(prompt) {
  const letters = [...String(prompt || '')].filter((c) => /\p{L}/u.test(c));
  if (letters.length < ALL_CAPS_MIN_LETTERS) return false;
  const upper = letters.filter((c) => /\p{Lu}/u.test(c)).length;
  return upper / letters.length >= ALL_CAPS_RATIO;
}

function personalityPath() {
  return path.join(os.homedir(), '.ultron', 'personality.json');
}

/** Lee personality.json. Devuelve null si falta o es ilegible (sin seeds: la
 *  fuente de los seeds es Rust y duplicarlos aqui seria otra divergencia). */
function loadPersonality(file) {
  try {
    const raw = fs.readFileSync(file || personalityPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed && parsed.tones) ? parsed : null;
  } catch {
    return null;
  }
}

function choiceFrom(tone, matched, reason, explicit) {
  return {
    id: tone.id,
    name: tone.name,
    lang: tone.lang,
    style_guide: tone.style_guide,
    profanity: tone.profanity,
    matched_signals: matched,
    reason,
    explicit,
  };
}

/**
 * Deteccion completa. Devuelve `{ chosen, scores, default_tone }`;
 * `chosen` es null cuando ningun tono cruza el floor (o gana el default).
 */
function detect(prompt, file) {
  const norm = normalize(prompt);
  const shouting = isAllCaps(prompt);
  const tones = file.tones || [];

  const scores = tones.map((tone) => {
    const explicitHit =
      (tone.explicit_triggers || []).find((t) => containsWord(norm, normalize(t))) || null;
    const hits = [];
    for (const s of tone.signals || []) {
      if (s === ALL_CAPS_SIGNAL) {
        if (shouting) hits.push(ALL_CAPS_SIGNAL);
      } else if (containsWord(norm, normalize(s))) {
        hits.push(s);
      }
    }
    return { id: tone.id, name: tone.name, hits, explicit_hit: explicitHit };
  });

  // 1) Peticion explicita gana siempre (primer tono con trigger presente).
  const explicitWinner = scores.find((s) => s.explicit_hit);
  if (explicitWinner) {
    const tone = tones.find((t) => t.id === explicitWinner.id);
    return {
      chosen: choiceFrom(
        tone,
        explicitWinner.hits,
        `petición explícita: "${explicitWinner.explicit_hit}"`,
        true
      ),
      scores,
      default_tone: file.default_tone,
    };
  }

  // 2) Señales: gana el maximo de hits que cruce el floor (2), o 1 fuerte.
  //    Empate -> primer tono por orden del archivo (por eso `>` estricto).
  let best = null;
  for (const s of scores) {
    const tone = tones.find((t) => t.id === s.id);
    const strong = new Set((tone.strong_signals || []).map(normalize));
    const hasStrong = s.hits.some((h) => strong.has(normalize(h)));
    const qualifies = s.hits.length >= SIGNAL_FLOOR || (hasStrong && s.hits.length > 0);
    if (!qualifies) continue;
    if (!best || s.hits.length > best.hits.length) best = s;
  }

  let chosen = null;
  // El default ganando por señales = no inyectar (ya es la base).
  if (best && best.id !== file.default_tone) {
    const tone = tones.find((t) => t.id === best.id);
    chosen = choiceFrom(tone, best.hits, `señales del chat: ${best.hits.join(', ')}`, false);
  }

  return { chosen, scores, default_tone: file.default_tone };
}

/** Camino del hook: carga + detecta. Devuelve null si no hay personality.json. */
function detectForPrompt(prompt) {
  const file = loadPersonality();
  if (!file) return null;
  return detect(prompt, file).chosen;
}

module.exports = {
  normalize,
  containsWord,
  isAllCaps,
  loadPersonality,
  detect,
  detectForPrompt,
  personalityPath,
};
