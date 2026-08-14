#!/usr/bin/env node
// scripts/tricolon-bench.js — banco de casos para el patron "Regla de tres".
//
// PROBLEMA (card ocnkjf, 2026-08-14): el regex actual del catalogo casa
// cualquier "palabra, palabra y palabra" sin distinguir la coma ENUMERATIVA de
// la coma que cierra una subordinada. "Si no hay señales, dilo y para ahi"
// salta como triada y no lo es. Aparecio 3 veces seguidas al redactar una skill.
//
// Este banco NO trae el regex bueno: mide el que haya en el catalogo, o el que
// se le pase por argumento, contra casos etiquetados a mano. Sirve para iterar
// una regla nueva sin adivinar si mejora o empeora.
//
// LIMITE TECNICO: el catalogo se escribe en sintaxis de Rust y la crate `regex`
// de Rust NO soporta lookahead ni lookbehind. Una regex con lookarounds se
// saltaria en silencio del lado Rust (Lab) mientras funciona en JS (hook) — es
// decir, divergencia muda entre los dos consumidores. Cualquier regla nueva
// tiene que sobrevivir sin ellos.
//
// Uso:
//   node scripts/tricolon-bench.js                 # mide el regex del catalogo
//   node scripts/tricolon-bench.js '<regex>'       # mide una regex candidata
//
// Exit: 0 si no hay fallos, 1 si los hay.

'use strict';

const path = require('path');
const CATALOG = path.join(__dirname, '..', 'docs', 'research', 'patrones-texto-ia.json');

// DEBE cazar: triadas retoricas reales (enumeracion de elementos paralelos).
const POSITIVOS = [
  'El sistema es rapido, eficiente y seguro.',
  'Analiza el contexto, sintetiza los hallazgos y evalua el impacto.',
  'This approach is fast, efficient, and scalable.',
  'La memoria, el routing y la interfaz forman el nucleo.',
  'Un enfoque innovador, riguroso y transformador.',
  'Su obra combina tradicion, tecnica y emocion.',
  'The framework delivers speed, clarity and depth.',
  'Requiere paciencia, method y disciplina.',
];

// NO debe cazar: la coma cierra una subordinada, o une oraciones, no enumera.
const NEGATIVOS = [
  'Si no hay señales, dilo y para ahi.',
  'Cuando termine el build, avisa y sigue con el deploy.',
  'Aunque el test falle, reintenta y documenta el motivo.',
  'Tras medir el daemon, apaga el prewarm y vuelve a medir.',
  'Una vez desplegado, arranca y comprueba el doctor.',
  'Mientras compila, revisa el manifest y regeneralo.',
  'Como el corpus crecio, reindexa y valida el drift.',
  'Porque el floor es 0.85, abstiene y no inyecta nada.',
];

function catalogRegex() {
  const cat = require(CATALOG);
  const arr = Array.isArray(cat) ? cat : cat.patrones || Object.values(cat)[0];
  const p = arr.find((x) => /tres|tricolon/i.test(x.nombre || ''));
  if (!p) throw new Error('patron de triada no encontrado en el catalogo');
  const s = (p.senales_ejecutables || []).find((x) => x.tipo === 'regex');
  if (!s) throw new Error('el patron no tiene señal de tipo regex');
  return s.valor;
}

/**
 * Compila la regex con el MISMO codigo que produccion (`compileRules` de
 * lib/ai-text-detector.js) en vez de reimplementar la adaptacion Rust->JS.
 * Reimplementarla fue el primer bug de este banco: sin el flag `u`, `\p{L}` se
 * lee como literal y el banco medía una regex que no es la que corre.
 */
function compile(rustSource) {
  const { compileRules } = require('../hooks/scripts/lib/ai-text-detector');
  if (/\(\?<|\(\?=|\(\?!/.test(rustSource)) {
    process.stderr.write(
      'AVISO: la regex usa lookaround. Rust `regex` no lo soporta: compilaria en JS\n' +
        '       (hook) y se saltaria en silencio en Rust (Lab). Divergencia muda.\n\n'
    );
  }
  const rules = compileRules([
    { nombre: 'bench', senales_ejecutables: [{ tipo: 'regex', valor: rustSource }] },
  ]);
  if (!rules.length) {
    process.stderr.write('La regex no compila: produccion la saltaria en silencio.\n');
    process.exit(1);
  }
  return rules[0].re;
}

function main() {
  const source = process.argv[2] || catalogRegex();
  const re = compile(source);
  const hit = (t) => {
    re.lastIndex = 0;
    return re.test(t);
  };

  const fp = NEGATIVOS.filter(hit); // falsos positivos
  const fn = POSITIVOS.filter((t) => !hit(t)); // falsos negativos

  console.log(`regex: ${source}\n`);
  console.log(`cazadas   ${POSITIVOS.length - fn.length}/${POSITIVOS.length} triadas reales`);
  console.log(`ignoradas ${NEGATIVOS.length - fp.length}/${NEGATIVOS.length} comas no enumerativas\n`);

  for (const t of fn) console.log(`  FALSO NEGATIVO (era triada) : ${t}`);
  for (const t of fp) console.log(`  FALSO POSITIVO (no lo era)  : ${t}`);

  const fallos = fp.length + fn.length;
  console.log(fallos ? `\n${fallos} fallo(s).` : '\nsin fallos.');
  process.exit(fallos ? 1 : 0);
}

main();
