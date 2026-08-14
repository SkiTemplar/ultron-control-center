#!/usr/bin/env node
// scripts/catalog-coverage.js — audit de cobertura del catalogo de texto IA.
//
// Mide cada patron del catalogo contra casos etiquetados a mano
// (scripts/fixtures/catalog-cases.json):
//
//   RECALL : de la prosa que el patron dice detectar, ¿cuanta detecta?
//   RUIDO  : de la prosa academica legitima, ¿cuanta marca por error?
//
// La distincion importa porque los dos fallos se pagan distinto: sub-cobertura
// deja pasar texto que canta a IA (el autor cree que esta limpio), y sobre-
// disparo entrena al autor a ignorar el detector, que es peor que no tenerlo.
//
// NO propone reglas nuevas: el catalogo es material de investigacion del TFG y
// su diseño le corresponde a su autor. Esto solo mide lo que hay.
//
// Uso:
//   node scripts/catalog-coverage.js            # informe completo
//   node scripts/catalog-coverage.js --fallos   # solo lo que falla
//   node scripts/catalog-coverage.js --json
//
// Exit: 0 siempre (es un informe, no un gate) salvo error de carga.

'use strict';

const path = require('path');
const { loadCatalog, compileRules } = require('../hooks/scripts/lib/ai-text-detector');

const CASES = require(path.join(__dirname, 'fixtures', 'catalog-cases.json'));

/** Compila SOLO un patron y devuelve un predicado "¿marca este texto?". */
function matcherFor(patron) {
  const rules = compileRules([patron]);
  return (text) =>
    rules.some((r) => {
      r.re.lastIndex = 0;
      return r.re.test(text);
    });
}

function main() {
  const soloFallos = process.argv.includes('--fallos');
  const asJson = process.argv.includes('--json');

  const catalogo = loadCatalog();
  const porNombre = new Map(catalogo.map((p) => [p.nombre, p]));
  const filas = [];

  for (const caso of CASES.patrones) {
    const patron = porNombre.get(caso.nombre);
    if (!patron) {
      filas.push({ nombre: caso.nombre, estado: 'AUSENTE del catalogo' });
      continue;
    }
    const señales = (patron.senales_ejecutables || []).length;
    const marca = señales ? matcherFor(patron) : () => false;

    const perdidos = caso.positivos.filter((t) => !marca(t));
    const ruidosos = caso.negativos.filter((t) => marca(t));

    filas.push({
      nombre: caso.nombre,
      señales,
      inerte: señales === 0,
      recall: `${caso.positivos.length - perdidos.length}/${caso.positivos.length}`,
      recall_pct: (caso.positivos.length - perdidos.length) / caso.positivos.length,
      ruido: `${ruidosos.length}/${caso.negativos.length}`,
      perdidos,
      ruidosos,
    });
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(filas, null, 2) + '\n');
    return;
  }

  console.log('AUDIT DE COBERTURA — catalogo de texto IA\n');
  console.log('  recall = positivos detectados · ruido = prosa legitima marcada por error\n');

  for (const f of filas) {
    if (f.estado) {
      console.log(`  [!!] ${f.nombre}: ${f.estado}`);
      continue;
    }
    const limpio = f.recall_pct === 1 && f.ruidosos.length === 0;
    if (soloFallos && limpio) continue;
    const marca = f.inerte ? 'INERTE' : limpio ? 'ok    ' : 'FALLA ';
    console.log(`  [${marca}] recall ${f.recall}  ruido ${f.ruido}  ${f.nombre}`);
    for (const t of f.perdidos) console.log(`            no detecta: "${t.slice(0, 82)}"`);
    for (const t of f.ruidosos) console.log(`            marca mal : "${t.slice(0, 82)}"`);
  }

  const inertes = filas.filter((f) => f.inerte).length;
  const conFallo = filas.filter((f) => !f.estado && (f.recall_pct < 1 || f.ruidosos.length)).length;
  const totalPos = filas.reduce((n, f) => n + (f.perdidos ? f.perdidos.length : 0), 0);
  const totalRuido = filas.reduce((n, f) => n + (f.ruidosos ? f.ruidosos.length : 0), 0);

  console.log(
    `\nRESUMEN: ${filas.length} patrones · ${inertes} inertes (0 señales) · ` +
      `${conFallo} con fallos · ${totalPos} positivos no detectados · ` +
      `${totalRuido} textos legitimos marcados por error.`
  );
}

main();
