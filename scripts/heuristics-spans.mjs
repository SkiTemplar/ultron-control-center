#!/usr/bin/env node
// scripts/heuristics-spans.mjs — emite los spans que produce el matcher JS.
//
// Existe para que el gate de paridad de Rust (test
// `paridad_real_con_el_matcher_js` en tfg_heuristics.rs) pueda comparar
// EJECUCIÓN contra ejecución en vez de limitarse a que cada lado apruebe el
// fixture por su cuenta: dos implementaciones pueden pasar los mismos casos y
// aun así divergir en todo lo demás.
//
// Entrada (stdin): {"textos": ["...", "..."], "ids": ["tricolon", ...]}
// Salida (stdout): {"resultados": [{ "<id>": [[start,end], ...] }, ...]}
//
// Los offsets se emiten en BYTES UTF-8, que es como los cuenta el crate regex
// de Rust; JS los produce en unidades UTF-16, así que se convierten aquí.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runHeuristic } = require('../hooks/scripts/lib/ai-text-heuristics.js');

const entrada = JSON.parse(readFileSync(0, 'utf8'));
const textos = Array.isArray(entrada.textos) ? entrada.textos : [];
const ids = Array.isArray(entrada.ids) ? entrada.ids : [];

/** Offset UTF-16 -> offset en bytes UTF-8. */
function aBytes(texto, indice) {
  return Buffer.byteLength(texto.slice(0, indice), 'utf8');
}

const resultados = textos.map((texto) => {
  const porId = {};
  for (const id of ids) {
    const spans = runHeuristic(id, texto) || [];
    porId[id] = spans.map((s) => [aBytes(texto, s.start), aBytes(texto, s.end)]);
  }
  return porId;
});

process.stdout.write(JSON.stringify({ resultados }));
