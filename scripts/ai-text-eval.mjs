#!/usr/bin/env node
/**
 * ai-text-eval.mjs — banco de medicion del detector de texto IA.
 *
 * Por que existe: el catalogo (docs/research/patrones-texto-ia.json) se venia
 * ampliando por intuicion, sin saber que patron aporta y cual no dispara nunca.
 * Medido el 2026-08-23 sobre 5.700 palabras de texto generado por IA en
 * espanol, solo 1 de los 31 patrones se activo. Un patron nuevo sin medir es
 * una hipotesis, no una mejora.
 *
 * Que mide, por PATRON:
 *   - cobertura        : documentos IA en los que dispara (recall del patron)
 *   - falsos positivos : documentos humanos en los que dispara
 *   - senales/1k       : densidad de senales por mil palabras en el corpus IA
 *
 * Y a nivel de DOCUMENTO, para el veredicto del gate: precision, recall y F1
 * clasificando como "IA" todo documento con >= UMBRAL senales.
 *
 * El corpus vive fuera del repo (docs/research/corpus/, gitignorado): es texto
 * personal. Estructura:
 *
 *   docs/research/corpus/ia/*.{md,txt}      -> texto generado por IA
 *   docs/research/corpus/humano/*.{md,txt}  -> texto escrito por una persona
 *
 * La extension importa: en `.md` el detector exime los patrones de markup, que
 * ahi son sintaxis legitima y no artefactos. Guarda cada muestra con la
 * extension del destino real donde ese texto viviria.
 *
 * Uso:
 *   node scripts/ai-text-eval.mjs                 # tabla por patron + global
 *   node scripts/ai-text-eval.mjs --umbral 2      # otro umbral de documento
 *   node scripts/ai-text-eval.mjs --json          # salida cruda
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const RAIZ = path.join(os.homedir(), '.ultron');
const { scan, loadCatalog, patternKey, MARKDOWN_NATIVE_PATTERNS } = require(
  path.join(RAIZ, 'hooks', 'scripts', 'lib', 'ai-text-detector.js')
);

const CORPUS = path.join(RAIZ, 'docs', 'research', 'corpus');
const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const UMBRAL = Number(args[args.indexOf('--umbral') + 1]) || 1;

function cargar(sub) {
  const dir = path.join(CORPUS, sub);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(md|txt)$/i.test(f))
    .map((f) => {
      const ruta = path.join(dir, f);
      const texto = fs.readFileSync(ruta, 'utf8');
      return {
        nombre: f,
        ext: path.extname(f).toLowerCase(),
        texto,
        palabras: texto.split(/\s+/).filter(Boolean).length,
      };
    })
    .filter((d) => d.palabras > 0);
}

// El catalogo se carga UNA vez: `scan` lo recompila en cada llamada si no se le
// pasa, y con un corpus grande eso multiplica el trabajo por documento.
const CATALOGO = loadCatalog();

/** Nombres de TODOS los patrones del catalogo, hayan disparado o no. */
const TODOS_LOS_PATRONES = (
  Array.isArray(CATALOGO) ? CATALOGO : CATALOGO.patrones || CATALOGO.patterns || []
).map((p) => p.id || p.nombre || p.name || '(sin id)');

/** Ejecuta el detector con la misma semantica que el hook y el CLI. */
function analizar(doc) {
  const res = scan(doc.texto, CATALOGO, {
    skipPatterns: doc.ext === '.md' ? MARKDOWN_NATIVE_PATTERNS : [],
  });
  const matches = res?.matches || res?.senales || [];
  const porPatron = new Map();
  for (const m of matches) {
    const k = m.pattern || m.id || m.regla || '(sin id)';
    porPatron.set(k, (porPatron.get(k) || 0) + 1);
  }
  return { total: matches.length, porPatron };
}

const ia = cargar('ia').map((d) => ({ ...d, r: analizar(d) }));
const humano = cargar('humano').map((d) => ({ ...d, r: analizar(d) }));

if (!ia.length && !humano.length) {
  console.error(`Corpus vacio. Anade muestras en:\n  ${path.join(CORPUS, 'ia')}\n  ${path.join(CORPUS, 'humano')}`);
  process.exit(2);
}

// --- Metricas por patron -----------------------------------------------------
const patrones = new Set();
for (const d of [...ia, ...humano]) for (const k of d.r.porPatron.keys()) patrones.add(k);

const palabrasIa = ia.reduce((a, d) => a + d.palabras, 0) || 1;
const filas = [...patrones]
  .map((p) => {
    const docsIa = ia.filter((d) => d.r.porPatron.has(p)).length;
    const docsHum = humano.filter((d) => d.r.porPatron.has(p)).length;
    const senalesIa = ia.reduce((a, d) => a + (d.r.porPatron.get(p) || 0), 0);
    return {
      patron: p,
      cobertura: ia.length ? docsIa / ia.length : 0,
      falsosPositivos: humano.length ? docsHum / humano.length : 0,
      senalesPor1k: (senalesIa / palabrasIa) * 1000,
      docsIa,
      docsHum,
    };
  })
  .sort((a, b) => b.cobertura - a.cobertura || b.senalesPor1k - a.senalesPor1k);

// --- Metricas por documento (el gate real) -----------------------------------
const vp = ia.filter((d) => d.r.total >= UMBRAL).length; // IA detectada
const fn = ia.length - vp; // IA que se cuela
const fp = humano.filter((d) => d.r.total >= UMBRAL).length; // humano acusado
const vn = humano.length - fp;
const precision = vp + fp ? vp / (vp + fp) : 0;
const recall = ia.length ? vp / ia.length : 0;
const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

const resumen = {
  umbral: UMBRAL,
  corpus: { ia: ia.length, humano: humano.length, palabrasIa },
  documento: { vp, fn, fp, vn, precision, recall, f1 },
  patrones: filas,
};

if (JSON_OUT) {
  console.log(JSON.stringify(resumen, null, 2));
  process.exit(0);
}

const pct = (x) => `${(x * 100).toFixed(0)}%`.padStart(4);
console.log(`\nCorpus: ${ia.length} doc IA (${palabrasIa} palabras) · ${humano.length} doc humano`);
console.log(`Umbral de documento: >= ${UMBRAL} senal(es)\n`);
console.log('PATRON                                          cobertura  falsoPos  senales/1k');
console.log('-'.repeat(84));
for (const f of filas) {
  console.log(
    `${f.patron.slice(0, 46).padEnd(46)}  ${pct(f.cobertura)}      ${pct(f.falsosPositivos)}      ${f.senalesPor1k.toFixed(2)}`
  );
}
// Lo que NO aparece arriba es lo que mas dice, y hay que sacarlo del CATALOGO:
// derivarlo de la tabla no vale, porque ahi solo entran los patrones que
// dispararon al menos una vez. Un patron que nunca salta no protege de nada y
// tiene que verse listado, no deducirse por ausencia.
const vistos = new Set([...patrones].map(patternKey));
const inertes = TODOS_LOS_PATRONES.filter((p) => !vistos.has(patternKey(p)));
if (inertes.length) {
  console.log(`\n--- ${inertes.length} de ${TODOS_LOS_PATRONES.length} patrones sin un solo disparo en todo el corpus ---`);
  for (const p of inertes) console.log(`   · ${String(p).slice(0, 70)}`);
}
console.log('\n--- Veredicto a nivel documento ---');
console.log(`  IA detectada      : ${vp}/${ia.length}`);
console.log(`  IA que se cuela   : ${fn}`);
console.log(`  Humano acusado    : ${fp}/${humano.length}`);
console.log(`  precision ${precision.toFixed(2)} · recall ${recall.toFixed(2)} · F1 ${f1.toFixed(2)}\n`);
