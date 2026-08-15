// hooks/scripts/lib/ai-text-heuristics.js — señales ESTRUCTURALES del detector.
//
// Por qué existe: hasta 2026-08-15 el catálogo solo sabía ejecutar señales
// `lexico` y `regex`. Eso alcanza para vocabulario ("delve", "tapestry") pero
// deja fuera todo lo que un LLM delata en la FORMA y no en las palabras:
// frases de longitud clonada, párrafos calibrados, puntuación pobre, cadenas
// de sinónimos para no repetir el sujeto. Dos patrones del catálogo estaban
// declarados y sin poder disparar jamás ("Variación léxica forzada" y
// "Monotonía de longitud de frase") justo por eso — el audit de cobertura los
// marcaba INERTE.
//
// Cada heurística se identifica por `id` y el catálogo la invoca con
// `{ "tipo": "heuristica", "valor": "<id>" }`. La implementación Rust
// (tfg_lab.rs) replica estas mismas reglas; `scripts/fixtures/heuristic-cases.json`
// es el fixture compartido que verifica que ambas dan el mismo veredicto.
//
// Contrato de cada heurística: (texto) -> [{ start, end }] con los tramos que
// justifican la señal. Lista vacía = no dispara.

'use strict';

// --- utilidades de segmentación --------------------------------------------

/** Trocea en frases por . ! ? ; y saltos de línea, conservando offsets. */
function splitSentences(text) {
  const out = [];
  const re = /[^.!?;\n]+[.!?;]?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const start = m.index + raw.indexOf(trimmed[0]);
    out.push({ text: trimmed, start, end: start + trimmed.length });
  }
  return out;
}

function splitParagraphs(text) {
  const out = [];
  let offset = 0;
  for (const chunk of text.split(/\n\s*\n/)) {
    const trimmed = chunk.trim();
    if (trimmed) {
      const start = offset + chunk.indexOf(trimmed[0]);
      out.push({ text: trimmed, start, end: start + trimmed.length });
    }
    offset += chunk.length + 2;
  }
  return out;
}

function wordCount(s) {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Coeficiente de variación (desviación típica / media). 0 = clones. */
function coefficientOfVariation(values) {
  if (values.length < 2) return Infinity;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return Infinity;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

// --- heurísticas -------------------------------------------------------------

/** Frases de longitud casi idéntica: la "baja burstiness" de los LLM. */
function monotoniaFrases(text) {
  const sentences = splitSentences(text).filter((s) => wordCount(s.text) >= 2);
  if (sentences.length < 4) return [];
  const cv = coefficientOfVariation(sentences.map((s) => wordCount(s.text)));
  if (cv >= 0.30) return [];
  return [{ start: sentences[0].start, end: sentences[sentences.length - 1].end }];
}

/** Párrafos calibrados al mismo tamaño (mismo fenómeno, un nivel arriba). */
function uniformidadParrafos(text) {
  const paras = splitParagraphs(text).filter((p) => wordCount(p.text) >= 25);
  if (paras.length < 3) return [];
  const cv = coefficientOfVariation(paras.map((p) => wordCount(p.text)));
  if (cv >= 0.20) return [];
  return [{ start: paras[0].start, end: paras[paras.length - 1].end }];
}

/**
 * Puntuación pobre + frases largas. El informe de The Economist (2026) mide
 * que los LLM usan MENOS punto y coma, paréntesis y dos puntos que un humano,
 * y encadenan frases largas con "y". Es señal de documento, no de frase: solo
 * se evalúa con suficiente texto.
 */
function puntuacionPobre(text) {
  const words = wordCount(text);
  if (words < 120) return [];
  const marks = (text.match(/[;():]/g) || []).length;
  if (marks > 0) return [];
  // La coma también cuenta como puntuación interna: el habla transcrita va sin
  // punto y coma pero llena de comas, y sin este filtro la señal la marcaba
  // (falso positivo medido sobre prosa humana real, 2026-08-15). Lo que delata
  // al modelo es la frase larga y LISA, no la ausencia de un signo culto.
  const commas = (text.match(/,/g) || []).length;
  if (commas > 0 && words / commas < 25) return [];
  const sentences = splitSentences(text).filter((s) => wordCount(s.text) >= 2);
  if (sentences.length < 3) return [];
  const avg = sentences.reduce((acc, s) => acc + wordCount(s.text), 0) / sentences.length;
  if (avg < 20) return [];
  return [{ start: sentences[0].start, end: sentences[0].end }];
}

const CONECTORES = [
  'además', 'ademas', 'asimismo', 'sin embargo', 'no obstante', 'por lo tanto',
  'por tanto', 'en consecuencia', 'por otro lado', 'por otra parte',
  'en primer lugar', 'en segundo lugar', 'finalmente', 'en definitiva',
  'en resumen', 'en conclusión', 'en conclusion', 'de igual manera',
  'de este modo', 'cabe destacar', 'es importante',
];

/** Un conector formal cada dos frases: la prosa "de manual" del LLM. */
function densidadConectores(text) {
  const words = wordCount(text);
  if (words < 80) return [];
  const lower = text.toLowerCase();
  const hits = [];
  for (const c of CONECTORES) {
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(c, from);
      if (idx === -1) break;
      hits.push({ start: idx, end: idx + c.length });
      from = idx + c.length;
    }
  }
  if (hits.length < 3) return [];
  if (words / hits.length > 35) return [];
  hits.sort((a, b) => a.start - b.start);
  return hits.slice(0, 3);
}

// El anafórico solo cuenta cuando ENCABEZA un sintagma nominal ("dicho
// modelo", "el mencionado sistema"). Sin esa exigencia, el participio verbal
// de cualquier frase normal —"lo que te he mencionado", "lo que había dicho"—
// disparaba la señal: dos falsos positivos medidos sobre prosa humana real
// (2026-08-15).
const ANAFORICOS = /\b(?:(?:dicho|dicha|dichos|dichas)\s+\p{L}{3,}|(?:el|la|los|las)\s+(?:mencionad|citad|aludid|referid)[oa]s?\s+\p{L}{3,})/giu;
const SUJETO_INICIAL = /^((?:el|la|los|las|este|esta|estos|estas|dicho|dicha|dichos|dichas)\s+\p{L}+(?:\s+\p{L}+){0,2}|\p{Lu}\p{L}+)/u;

/**
 * Variación léxica forzada ("elegant variation"): el LLM evita repetir el
 * sujeto y lo va renombrando — "Qdrant" -> "la base vectorial" -> "este motor
 * de búsqueda". Dos vías de disparo, porque el fenómeno aparece de dos formas:
 *   a) marcadores anafóricos explícitos ("dicho modelo", "el mencionado sistema"),
 *   b) una cadena de 3+ segmentos cuyos sujetos NO se repiten nunca y en la que
 *      al menos uno es un demostrativo/anafórico.
 * Repetir el mismo nombre (lo que hace un humano técnico) nunca dispara.
 */
function variacionLexica(text) {
  const anaforicos = [];
  ANAFORICOS.lastIndex = 0;
  let m;
  while ((m = ANAFORICOS.exec(text)) !== null) {
    anaforicos.push({ start: m.index, end: m.index + m[0].length });
  }
  if (anaforicos.length >= 2) return anaforicos.slice(0, 3);

  const segments = splitSentences(text);
  if (segments.length < 3) return [];
  const subjects = [];
  for (const seg of segments) {
    const hit = seg.text.match(SUJETO_INICIAL);
    if (!hit) return [];
    subjects.push({ raw: hit[1].toLowerCase(), start: seg.start, end: seg.start + hit[1].length });
  }
  const unique = new Set(subjects.map((s) => s.raw));
  if (unique.size !== subjects.length) return []; // algo se repite: es prosa honesta
  const demostrativo = subjects.some((s) => /^(este|esta|estos|estas|dicho|dicha|dichos|dichas)\b/.test(s.raw));
  if (!demostrativo) return [];
  return subjects.slice(0, 3).map((s) => ({ start: s.start, end: s.end }));
}

/**
 * Em dash: en 2026 dejó de ser prueba por sí solo (el informe de The Economist
 * lo degrada a red herring; un inciso suelto es puntuación española legítima).
 * Lo que sigue delatando es la ACUMULACIÓN: tres o más incisos en el mismo
 * fragmento. Por eso se mide el recuento, no la presencia.
 */
function emdashIncisos(text) {
  const hits = [];
  const re = /—/g;
  let m;
  while ((m = re.exec(text)) !== null) hits.push({ start: m.index, end: m.index + 1 });
  if (hits.length < 5) return [];
  return hits.slice(0, 3);
}

const NEUTROS = [
  /\bcomputadoras?\b/gi, /\bcelulares?\b/gi,
  /\bpresionar\b/gi, /\bpresione\b/gi, /\barribar\b/gi, /\bamerita\b/gi,
  /\binicializar\b/gi, /\bordenamiento\b/gi, /\bcarro\b/gi, /\bpapas\b/gi,
];

/**
 * "Español neutro": un solo término neutro no prueba nada (mucha gente dice
 * "computadora"). Lo que delata es el racimo: dos o más marcadores distintos
 * en el mismo fragmento.
 */
function espanolNeutro(text) {
  const hits = [];
  let distintos = 0;
  for (const re of NEUTROS) {
    re.lastIndex = 0;
    let m;
    let vistoEnEsteTermino = false;
    while ((m = re.exec(text)) !== null) {
      hits.push({ start: m.index, end: m.index + m[0].length });
      vistoEnEsteTermino = true;
    }
    if (vistoEnEsteTermino) distintos += 1;
  }
  if (distintos < 2) return [];
  hits.sort((a, b) => a.start - b.start);
  return hits.slice(0, 3);
}

const SUBORDINANTE_INICIAL = /^(si|cuando|aunque|mientras|una vez|tras|después de|despues de|antes de|para que|si bien|en cuanto|dado que|puesto que|ya que|conforme|según|segun|apenas|salvo que|a menos que)\b/i;
// Elementos de 3 palabras como mucho. Con 4+ el patrón dejaba de describir una
// enumeración y empezaba a casar cláusulas coordinadas normales: "se llama de
// una manera, ya no me acuerdo, y no está creado" saltaba como tríada sobre
// habla humana transcrita (medido 2026-08-15). Las tríadas reales del corpus
// ("rápido, eficiente y escalable") caben de sobra en tres palabras.
const TRIADA = /((?:\p{L}+\s+){0,2}\p{L}+),\s+((?:\p{L}+\s+){0,2}\p{L}+),?\s+(?:y|e|and)\s+((?:\p{L}+\s+){0,2}\p{L}+)/giu;

/**
 * Tricolon ("X, Y y Z"). El regex plano del catálogo confundía la coma
 * ENUMERATIVA con la coma SUBORDINANTE: "Si no hay señales, dilo y para ahi"
 * saltaba como tríada sin serlo (falso positivo visto tres veces seguidas).
 * Aquí se trocea primero en frases y se descarta cualquiera que arranque con
 * un subordinante — donde la coma cierra la subordinada, no enumera.
 */
function tricolon(text) {
  const out = [];
  for (const sentence of splitSentences(text)) {
    if (SUBORDINANTE_INICIAL.test(sentence.text)) continue;
    TRIADA.lastIndex = 0;
    let m;
    while ((m = TRIADA.exec(sentence.text)) !== null) {
      out.push({ start: sentence.start + m.index, end: sentence.start + m.index + m[0].length });
      if (out.length >= 3) return out;
    }
  }
  return out;
}

const HEDGES = [
  /\bpodr[íi]an?\b/gi, /\bparece(?:r[íi]a)?\b/gi, /\ben cierta medida\b/gi,
  /\bhasta cierto punto\b/gi, /\bes posible que\b/gi, /\bsuele\b/gi,
  /\ben general\b/gi, /\bciertos?\b/gi, /\balgunos?\b/gi, /\bpuede que\b/gi,
  /\btiende a\b/gi, /\brelativamente\b/gi,
];

/**
 * Hedging: un solo atenuador es prosa honesta — "el recall podría bajar si el
 * corpus crece" es exactamente como se redacta una limitación medida. Lo que
 * delata al modelo es la manta de atenuadores: dos en la misma frase, o tres
 * repartidos por el fragmento.
 */
function hedgingDenso(text) {
  const hits = [];
  for (const re of HEDGES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) hits.push({ start: m.index, end: m.index + m[0].length });
  }
  if (!hits.length) return [];
  hits.sort((a, b) => a.start - b.start);
  if (hits.length >= 3) return hits.slice(0, 3);
  for (const sentence of splitSentences(text)) {
    const dentro = hits.filter((h) => h.start >= sentence.start && h.end <= sentence.end);
    if (dentro.length >= 2) return dentro.slice(0, 3);
  }
  return [];
}

const HEURISTICS = {
  hedging_denso: hedgingDenso,
  monotonia_frases: monotoniaFrases,
  uniformidad_parrafos: uniformidadParrafos,
  puntuacion_pobre: puntuacionPobre,
  densidad_conectores: densidadConectores,
  variacion_lexica: variacionLexica,
  emdash_incisos: emdashIncisos,
  espanol_neutro: espanolNeutro,
  tricolon,
};

function runHeuristic(id, text) {
  const fn = HEURISTICS[id];
  if (!fn) return null; // id desconocido: el catálogo manda, se degrada en silencio
  return fn(String(text || ''));
}

module.exports = { HEURISTICS, runHeuristic, splitSentences, splitParagraphs, coefficientOfVariation };
