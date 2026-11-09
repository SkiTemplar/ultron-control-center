// hooks/scripts/lib/ai-text-heuristics-densidad.js — heurísticas de DENSIDAD
// para marcas de formato y de discurso.
//
// Por qué existe (auditoría del humanizer sobre el README, 2026-10-18): un
// texto con 16 negritas decorativas, un contraste «no X: lo Y» y una frase
// que hablaba del propio documento salía `sin_indicios`. En destino .md la
// negrita solo la medía «Artefactos de markup» (omitido en .md, porque ahí la
// negrita es sintaxis) y el contraste y el metacomentario solo los cubrían
// regex de aparición con formas que el texto no usaba.
//
// Calibración: las tres heurísticas pesan por densidad, como `emdash_incisos`.
// Una negrita, un contraste o un «este documento» sueltos son escritura
// humana normal y no disparan; lo que delata es la acumulación. Umbrales
// fijados contra readme-antes.md / readme-despues.md y la muestra humana de
// scripts/fixtures/ai-text-falsos-negativos/ (un solo texto técnico por
// clase: es la cifra mejor disponible, no una garantía).
//
// Gemelo Rust: control-center/src-tauri/src/tfg_heuristics_densidad.rs; el
// test `paridad_real_con_el_matcher_js` de tfg_heuristics.rs compara los spans
// de ambos lados. Mismo contrato que ai-text-heuristics.js:
// (texto) -> [{ start, end }]; lista vacía = no dispara.

'use strict';

const MAX_SPANS = 3;
const MIN_NEGRITAS = 5;
const DENSIDAD_NEGRITAS = 1.0;
const MIN_DISCURSO = 2;
const DENSIDAD_DISCURSO = 0.3;

function wordCount(s) {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

function density(hits, text) {
  const words = wordCount(text);
  return words > 0 ? (hits * 100) / words : 0;
}

/** Spans de todas las coincidencias de `re` (flag g) sobre `text`. */
function spansDe(re, text, acepta) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === '') { re.lastIndex++; continue; }
    if (!acepta || acepta(m)) out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Ordena por inicio y descarta los spans que se solapan con uno anterior. */
function sinSolapes(spans) {
  const orden = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  let fin = -1;
  for (const s of orden) {
    if (s.start >= fin) {
      out.push(s);
      fin = s.end;
    }
  }
  return out;
}

function porDensidad(spans, text, minimo, umbral) {
  if (spans.length < minimo || density(spans.length, text) < umbral) return [];
  return spans.slice(0, MAX_SPANS);
}

// --- negrita en prosa ---------------------------------------------------------

// Una negrita puede cruzar UN salto de línea (prosa ajustada a 80 columnas),
// nunca un párrafo.
const NEGRITA = /\*\*[^*\n]+(?:\n[^*\n]+)?\*\*/g;
const PREFIJO_LISTA = /^\s*(?:[-*+]|\d+[.)])?\s*$/;

/** Rangos [inicio, fin) de los bloques de código con valla (``` o ~~~). */
function rangosDeCodigo(text) {
  const rangos = [];
  let offset = 0;
  let abierto = -1;
  for (const linea of text.split('\n')) {
    const t = linea.trimStart();
    if (t.startsWith('```') || t.startsWith('~~~')) {
      if (abierto < 0) {
        abierto = offset;
      } else {
        rangos.push([abierto, offset + linea.length]);
        abierto = -1;
      }
    }
    offset += linea.length + 1;
  }
  if (abierto >= 0) rangos.push([abierto, text.length]);
  return rangos;
}

/**
 * ¿La negrita es la clave de una lista de definiciones («- **Clave**: valor»)
 * o de una fila de tabla? Ahí la negrita estructura datos, no decora prosa.
 */
function esNegritaEstructural(text, start, end) {
  const inicioLinea = text.lastIndexOf('\n', start - 1) + 1;
  if (text.slice(inicioLinea).trimStart().startsWith('|')) return true;
  if (!PREFIJO_LISTA.test(text.slice(inicioLinea, start))) return false;
  const contenido = text.slice(start + 2, end - 2);
  return contenido.trimEnd().endsWith(':') || text.startsWith(':', end);
}

/** Negrita decorativa en prosa: etiquetas y énfasis en negrita acumulados. */
function negritaDensa(text) {
  const codigo = rangosDeCodigo(text);
  const enCodigo = (i) => codigo.some(([a, b]) => i >= a && i < b);
  const spans = spansDe(NEGRITA, text, (m) => {
    const end = m.index + m[0].length;
    return !enCodigo(m.index) && !esNegritaEstructural(text, m.index, end);
  });
  return porDensidad(spans, text, MIN_NEGRITAS, DENSIDAD_NEGRITAS);
}

// --- contraste negativo -------------------------------------------------------

const COPULA = '(?:es|son|era|eran|fue|fueron)';
// «no es X, es Y» / «no son X: son Y».
const NO_ES_X_ES_Y = new RegExp(`\\bno\\s+${COPULA}\\s+[^.,;:!?]{1,60}?[,;:]\\s*${COPULA}\\b`, 'giu');
// «no X, sino Y». «no es … sino» y «no solo … sino» ya tienen patrón propio de
// aparición en el catálogo: se descartan aquí para no contarlos dos veces.
const NO_X_SINO_Y = /\bno\s+(\p{L}+)[^.;:!?]{0,60}?,?\s+sino\b/giu;
const YA_CUBIERTOS = new Set(['es', 'solo', 'sólo']);
// «no reemplaza a X: lo envuelve» (negación seguida de la afirmación real).
const NO_X_DOS_PUNTOS = /\bno\s+\p{L}+[^.;:!?]{0,60}?:\s*(?:lo|la|los|las|le|les|se)\s+\p{L}+/giu;

/** Contraste negativo acumulado: «no es X, es Y», «no X, sino Y», «no X: lo Y». */
function contrasteNegativo(text) {
  const spans = sinSolapes([
    ...spansDe(NO_ES_X_ES_Y, text),
    ...spansDe(NO_X_SINO_Y, text, (m) => !YA_CUBIERTOS.has(m[1].toLowerCase())),
    ...spansDe(NO_X_DOS_PUNTOS, text),
  ]);
  return porDensidad(spans, text, MIN_DISCURSO, DENSIDAD_DISCURSO);
}

// --- metacomentario -----------------------------------------------------------

const METAS = [
  /\b(?:este|esta|el presente|la presente)\s+(?:documento|documentaci[oó]n|secci[oó]n|apartado|readme|gu[ií]a|texto)\b/giu,
  /\ba continuaci[oó]n,?\s+se\s+\p{L}+/giu,
  /\ben\s+(?:la siguiente|las siguientes)\s+secci(?:[oó]n|ones)\b/giu,
];

/** El texto habla de sí mismo («este documento», «a continuación se…»). */
function metacomentario(text) {
  const spans = sinSolapes(METAS.flatMap((re) => spansDe(re, text)));
  return porDensidad(spans, text, MIN_DISCURSO, DENSIDAD_DISCURSO);
}

module.exports = {
  HEURISTICS_DENSIDAD: {
    negrita_densa: negritaDensa,
    contraste_negativo: contrasteNegativo,
    metacomentario,
  },
};
