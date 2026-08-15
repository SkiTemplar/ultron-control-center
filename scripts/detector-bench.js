#!/usr/bin/env node
// scripts/detector-bench.js — banco de medida del detector sobre DOCUMENTOS.
//
// Por qué existe: catalog-coverage.js mide patrón a patrón con frases sueltas,
// y eso se sobreajusta con facilidad — se puede tener 100% de cobertura ahí y
// que un texto de ChatGPT pegado entero apenas dispare nada (que es justo lo
// que reportó el usuario el 2026-08-15). Este banco mide lo otro: la densidad
// de señales por 100 palabras sobre textos completos, separando el corpus de
// IA del corpus de control humano.
//
// Uso:
//   node scripts/detector-bench.js            # tabla + veredicto
//   node scripts/detector-bench.js --json
//
// Corpus:
//   scripts/fixtures/ai-text-docs/ia-*.txt        -> se esperan densidades altas
//   scripts/fixtures/ai-text-docs/humano/*.txt    -> se espera ruido bajo
//   (el control humano se puede ampliar dejando .txt en humano/)
//
// Exit: 0 si la separación se mantiene, 1 si algún documento cae del lado
// equivocado del umbral. Es un gate, no un informe decorativo.

'use strict';

const fs = require('fs');
const path = require('path');
const { scan, loadCatalog } = require('../hooks/scripts/lib/ai-text-detector');

const DOCS = path.join(__dirname, 'fixtures', 'ai-text-docs');
const HUMANO = path.join(DOCS, 'humano');

/** Umbrales medidos el 2026-08-15 sobre este corpus. */
const UMBRAL_IA = 4.0;      // señales/100 palabras: por debajo, el detector se durmió
const UMBRAL_HUMANO = 2.5;  // por encima, estaría acusando a prosa humana

function listTxt(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.txt'))
    .map((f) => path.join(dir, f));
}

function medir(file, catalogo) {
  const text = fs.readFileSync(file, 'utf8');
  const r = scan(text, catalogo);
  return {
    file: path.basename(file),
    words: r.words,
    matches: r.matches.length,
    patterns_hit: r.patterns_hit,
    density: Number(r.density_per_100w.toFixed(2)),
  };
}

function main() {
  const asJson = process.argv.includes('--json');
  const catalogo = loadCatalog();

  const ia = listTxt(DOCS).filter((f) => path.basename(f).startsWith('ia-')).map((f) => medir(f, catalogo));
  const humano = listTxt(HUMANO).map((f) => medir(f, catalogo));

  const fallosIa = ia.filter((r) => r.density < UMBRAL_IA);
  const fallosHumano = humano.filter((r) => r.density > UMBRAL_HUMANO);
  // Un banco sin corpus no aprueba nada: antes salía exit 0 midiendo cero
  // documentos, que es el peor verde posible — dice "separación mantenida"
  // sin haber comparado nada.
  const corpusVacio = ia.length === 0 || humano.length === 0;
  const ok = !corpusVacio && fallosIa.length === 0 && fallosHumano.length === 0;

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ia, humano, umbrales: { UMBRAL_IA, UMBRAL_HUMANO }, ok }, null, 2)}\n`);
    process.exit(ok ? 0 : 1);
  }

  const linea = (r, limite, sentido) => {
    const mal = sentido === 'ia' ? r.density < limite : r.density > limite;
    return `  [${mal ? 'FALLA' : ' ok  '}] ${String(r.density).padStart(6)} /100w · ${String(r.matches).padStart(3)} señales · ${String(r.patterns_hit).padStart(2)} patrones · ${r.words} palabras · ${r.file}`;
  };

  process.stdout.write('BANCO DEL DETECTOR — densidad de señales sobre documentos completos\n\n');
  process.stdout.write(`CORPUS IA (se espera densidad >= ${UMBRAL_IA})\n`);
  ia.forEach((r) => process.stdout.write(`${linea(r, UMBRAL_IA, 'ia')}\n`));
  process.stdout.write(`\nCONTROL HUMANO (se espera densidad <= ${UMBRAL_HUMANO})\n`);
  if (!humano.length) process.stdout.write('  (vacío: deja .txt en fixtures/ai-text-docs/humano/)\n');
  humano.forEach((r) => process.stdout.write(`${linea(r, UMBRAL_HUMANO, 'humano')}\n`));

  const media = (xs) => (xs.length ? xs.reduce((a, b) => a + b.density, 0) / xs.length : 0);
  process.stdout.write(
    `\nRESUMEN: media IA ${media(ia).toFixed(2)} · media humano ${media(humano).toFixed(2)} · ` +
      `separación ${
        !humano.length ? 'sin medir (falta corpus humano)' : media(humano) > 0 ? `x${(media(ia) / media(humano)).toFixed(1)}` : 'total (0 señales en prosa humana)'
      }\n`,
  );
  if (corpusVacio) {
    process.stdout.write(
      `FALLA: corpus incompleto (IA=${ia.length}, humano=${humano.length}). ` +
        'Sin ambos lados no hay separación que medir — deja .txt humanos en fixtures/ai-text-docs/humano/.\n',
    );
  } else if (!ok) {
    process.stdout.write(`FALLA: ${fallosIa.length} doc(s) IA por debajo del umbral, ${fallosHumano.length} humano(s) por encima.\n`);
  }
  process.exit(ok ? 0 : 1);
}

main();
