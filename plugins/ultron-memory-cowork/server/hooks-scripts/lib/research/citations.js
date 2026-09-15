'use strict';

/**
 * lib/research/citations.js — extrae las claves de cita usadas en el texto
 * de un informe (.tex o .md), con el numero de veces que aparece cada una.
 * Deteccion sintactica, no un parser LaTeX/Pandoc completo:
 *  - .tex: cualquier comando `\..cite..{claves}` (natbib/biblatex: \cite,
 *    \citep, \citet, \parencite, \textcite, \autocite... y sus variantes con
 *    `*` o argumentos opcionales `[...]`), claves separadas por coma.
 *    Limite conocido: los comandos multi-grupo de biblatex (`\cites{a}{b}`)
 *    solo capturan el primer grupo de llaves.
 *  - .md: sintaxis de citas de Pandoc, `@clave` suelta o dentro de
 *    `[@clave1; @clave2]`. Limite conocido: no distingue un `@` de cita de
 *    un `@` que apareciera dentro de una direccion de correo en texto plano.
 */

const TEX_CITE_RE = /\\([A-Za-z]*[Cc]ite[A-Za-z]*)\*?((?:\[[^\]]*\])*)\{([^}]*)\}/g;
const MD_CITE_RE = /(?<![\w@])-?@([A-Za-z][A-Za-z0-9_:.#$%&+?<>~/-]*)/g;

function bump(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function extractTexCitedKeys(text) {
  const counts = new Map();
  for (const m of text.matchAll(TEX_CITE_RE)) {
    for (const rawKey of m[3].split(',')) {
      const key = rawKey.trim();
      if (key) bump(counts, key);
    }
  }
  return counts;
}

function extractMdCitedKeys(text) {
  const counts = new Map();
  for (const m of text.matchAll(MD_CITE_RE)) {
    const key = m[1].replace(/[.,;:)\]]+$/, '');
    if (key) bump(counts, key);
  }
  return counts;
}

/** Cuenta de citas por clave (Map clave -> numero de apariciones) para `format`: 'tex' | 'md'. */
function extractCitedKeys(text, format) {
  if (format === 'tex') return extractTexCitedKeys(text);
  if (format === 'md') return extractMdCitedKeys(text);
  throw new Error(`formato no soportado para extraer citas: ${format}`);
}

module.exports = { extractCitedKeys };
