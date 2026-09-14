#!/usr/bin/env node
/**
 * ai-text-eval.selftest.mjs — selftest del banco multi-idioma
 * (scripts/ai-text-eval.mjs, ampliado 2026-09-14 con --lang es|en|all).
 *
 * Construye un corpus de FIXTURES EN TEMPORAL (un doc humano y uno IA por
 * idioma, ambos >= MIN_WORDS=400 y verificados a mano contra el detector real
 * para que no disparen señales por accidente) y ejecuta el CLI real como
 * subproceso contra ese corpus via la variable AI_TEXT_EVAL_CORPUS — nunca
 * lee ni muta el corpus personal real (gitignorado, fuera del repo).
 *
 * Cubre:
 *   - --lang es (default): un solo informe "es", igual que antes de esta tarea.
 *   - --lang en: un solo informe "en", carpetas humano-en/ e ia-en/.
 *   - --lang all: tres informes (es, en, agregado que suma ambos idiomas).
 *   - --docs: el detalle_docs trae idioma/clase/palabras/densidad/veredicto/motivo.
 *   - caso negativo: --lang inexistente -> exit 1 con mensaje claro en stderr.
 *
 * Uso: node scripts/ai-text-eval.selftest.mjs   (exit 0 = verde)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVAL_SCRIPT = path.join(__dirname, 'ai-text-eval.mjs');

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

// --- Corpus de fixtures en temporal: un doc humano + uno IA por idioma ------
// Textos verificados a mano contra scan() real antes de fijarlos aqui:
//   humano-es: 490 palabras, densidad 0, veredicto sin_indicios.
//   ia-es    : 511 palabras, densidad 1.57, veredicto probable_ia.
//   humano-en: 518 palabras, densidad 0, veredicto sin_indicios.
//   ia-en    : 548 palabras, densidad 1.82, veredicto probable_ia.
const HUMANO_ES = `Mi abuelo vivía en un pueblo pequeño de la sierra, rodeado de encinas centenarias y un río que apenas llevaba agua en verano. Cada mañana salía a caminar antes de que saliera el sol. A veces se cruzaba con el pastor. Llevaba siempre el mismo bastón de madera, tallado por su padre hace más de sesenta años; decía que ese bastón conocía el camino mejor que él. En otoño recogía castañas junto al arroyo seco, las guardaba en un saco de tela y las llevaba a casa antes de que oscureciera. Su cocina olía a leña quemada y a pan recién hecho. Nunca usaba receta escrita: medía todo a ojo, con las manos, probando de vez en cuando hasta que el sabor le convencía. Los domingos venían mis primos y jugábamos en el corral hasta que mi abuela nos llamaba para comer. Había tres cosas que mi abuelo repetía siempre: cuidar la tierra, no fiarse del vecino que no saluda y guardar semilla para el año siguiente. Nunca entendí del todo esa última frase hasta que, años después, tuve mi propio huerto (pequeño, apenas unos metros cuadrados en la terraza) y empecé a guardar tomates para plantarlos en primavera. El pueblo cambió poco con los años. La carretera se asfaltó en los noventa. El bar de la plaza cerró y volvió a abrir con otro dueño, y ahora sirve cervezas artesanas que mi abuelo jamás habría probado. Aun así, cuando vuelvo en verano, reconozco cada esquina, cada piedra suelta del camino que sube hacia la ermita, cada olor que se mezcla con el del romero cuando pisas fuerte la tierra seca. A veces me pregunto qué pensaría mi abuelo de todo esto. Seguramente se reiría y seguiría con su bastón hacia el monte, sin dar más explicaciones.

Mi tía, en cambio, se marchó del pueblo con veinte años y no volvió hasta pasados quince. Trabajó de camarera en varias ciudades, después en una fábrica textil, y finalmente montó su propia mercería cerca de la estación. Contaba que los primeros años fueron duros: dormía en una pensión compartida, ahorraba cada céntimo y escribía cartas a mi abuelo cada dos semanas. Cuando por fin volvió, trajo una máquina de coser vieja, dos maletas y un gato callejero que había adoptado sin querer. Se instaló en la casa de arriba, la que llevaba años cerrada, y en pocos meses la llenó de plantas, telas de colores y fotografías en blanco y negro. Los vecinos tardaron en acostumbrarse a sus horarios raros: se acostaba tarde, se levantaba tarde y abría la mercería después de comer. Con el tiempo se hizo imprescindible en el pueblo; arreglaba dobladillos, remendaba chaquetas y enseñaba a coser a quien se lo pedía, sin cobrar nada si veía que la familia andaba justa de dinero. Murió hace cuatro años, una tarde de enero, sentada en su silla de siempre, con la radio encendida y el gato dormido a sus pies.`;

const IA_ES = `${HUMANO_ES}

Es crucial destacar que esto presenta aristas, resulta sumamente enriquecedor y plantea desafíos que exploraremos a fondo en las próximas semanas.`;

const HUMANO_EN = `My grandfather lived in a small village in the mountains, surrounded by old oak trees and a river that barely had water in the summer. Every morning he went out for a walk before sunrise. Sometimes he ran into the shepherd. He always carried the same wooden cane, carved by his father more than sixty years ago; he used to say that cane knew the road better than he did. In autumn he collected chestnuts by the dry stream, kept them in a cloth sack, and brought them home before it got dark. His kitchen smelled of burning firewood and freshly baked bread. He never followed a written recipe: he measured everything by eye, with his hands, tasting now and then until the flavor convinced him. On Sundays my cousins would come over and we played in the yard until my grandmother called us in for lunch. There were three things my grandfather repeated over and over: take care of the land, do not trust a neighbor who never says hello, and save seed for next year. I never fully understood that last one until, years later, I got my own small garden (barely a few square meters on the balcony) and started saving tomato seeds to plant in spring. The village changed little over the years. The road got paved in the nineties. The bar on the square closed and reopened under a new owner, and now it serves craft beer my grandfather would never have tried. Still, when I go back in summer, I recognize every corner, every loose stone on the path up to the chapel, every smell that mixes with rosemary when you press down on the dry earth. Sometimes I wonder what my grandfather would think of all this. He would probably just laugh and keep walking up the hill with his cane, without any further explanation.

My aunt, on the other hand, left the village at twenty and did not come back for fifteen years. She waited tables in several cities, then worked in a textile factory, and finally opened her own sewing shop near the train station. She used to say the first years were hard: she slept in a shared boarding house, saved every cent, and wrote letters to my grandfather every other week. When she finally came back, she brought an old sewing machine, two suitcases, and a stray cat she had adopted without meaning to. She moved into the upstairs house, the one that had been closed for years, and within a few months filled it with plants, colorful fabric, and black and white photographs. The neighbors took a while to get used to her odd hours: she went to bed late, woke up late, and opened the shop after lunch. Over time she became essential to the village; she fixed hems, patched jackets, and taught anyone who asked how to sew, charging nothing if she saw a family was short on money. She died four years ago, on a January afternoon, sitting in her usual chair, with the radio on and the cat asleep at her feet.`;

const IA_EN = `${HUMANO_EN}

This delves into the intricate landscape of rural life, and boasts a groundbreaking, pivotal, vibrant tapestry that stands as a testament to a way of living few people still remember.`;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-text-eval-selftest-'));
for (const d of ['humano', 'ia', 'humano-en', 'ia-en']) fs.mkdirSync(path.join(tmpRoot, d), { recursive: true });
fs.writeFileSync(path.join(tmpRoot, 'humano', 'fixture-humano.txt'), HUMANO_ES);
fs.writeFileSync(path.join(tmpRoot, 'ia', 'fixture-ia.txt'), IA_ES);
fs.writeFileSync(path.join(tmpRoot, 'humano-en', 'fixture-humano-en.txt'), HUMANO_EN);
fs.writeFileSync(path.join(tmpRoot, 'ia-en', 'fixture-ia-en.txt'), IA_EN);

function correr(argv) {
  try {
    const out = execFileSync('node', [EVAL_SCRIPT, ...argv], {
      env: { ...process.env, AI_TEXT_EVAL_CORPUS: tmpRoot },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout: out, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' };
  }
}

// --- Caso 1: --lang es (default) — no toca esta cifra histórica -------------
const resEs = correr(['--lang', 'es', '--json']);
A(resEs.code === 0, '--lang es: exit 0', `stderr=${resEs.stderr}`);
let jsonEs = null;
try { jsonEs = JSON.parse(resEs.stdout); } catch (e) { ko('--lang es: stdout es JSON valido', String(e)); }
if (jsonEs) {
  const etiquetas = jsonEs.informes.map((i) => i.etiqueta);
  A(etiquetas.length === 1 && etiquetas[0] === 'es', '--lang es: un solo informe "es"', JSON.stringify(etiquetas));
  const rep = jsonEs.informes[0];
  A(rep.corpus.ia === 1 && rep.corpus.humano === 1, '--lang es: 1 doc IA + 1 doc humano cargados', JSON.stringify(rep.corpus));
  A(rep.veredicto_real.vp === 1, '--lang es: el fixture IA se clasifica probable_ia', JSON.stringify(rep.veredicto_real));
  A(rep.veredicto_real.fp === 0, '--lang es: el fixture humano NO se acusa (fp=0)', JSON.stringify(rep.veredicto_real));
}

// --- Caso 2: --lang en — solo humano-en/ e ia-en/ ----------------------------
const resEn = correr(['--lang', 'en', '--json']);
A(resEn.code === 0, '--lang en: exit 0', `stderr=${resEn.stderr}`);
let jsonEn = null;
try { jsonEn = JSON.parse(resEn.stdout); } catch (e) { ko('--lang en: stdout es JSON valido', String(e)); }
if (jsonEn) {
  const etiquetas = jsonEn.informes.map((i) => i.etiqueta);
  A(etiquetas.length === 1 && etiquetas[0] === 'en', '--lang en: un solo informe "en"', JSON.stringify(etiquetas));
  const rep = jsonEn.informes[0];
  A(rep.corpus.ia === 1 && rep.corpus.humano === 1, '--lang en: 1 doc IA + 1 doc humano cargados', JSON.stringify(rep.corpus));
  A(rep.veredicto_real.vp === 1, '--lang en: el fixture IA se clasifica probable_ia', JSON.stringify(rep.veredicto_real));
  A(rep.veredicto_real.fp === 0, '--lang en: el fixture humano NO se acusa (fp=0)', JSON.stringify(rep.veredicto_real));
}

// --- Caso 3: --lang all — informe por idioma + agregado, y --docs ------------
const resAll = correr(['--lang', 'all', '--docs', '--json']);
A(resAll.code === 0, '--lang all: exit 0', `stderr=${resAll.stderr}`);
let jsonAll = null;
try { jsonAll = JSON.parse(resAll.stdout); } catch (e) { ko('--lang all: stdout es JSON valido', String(e)); }
if (jsonAll) {
  const etiquetas = jsonAll.informes.map((i) => i.etiqueta);
  A(
    etiquetas.length === 3 && etiquetas.includes('es') && etiquetas.includes('en') && etiquetas.includes('all'),
    '--lang all: tres informes (es, en, agregado)',
    JSON.stringify(etiquetas),
  );
  const agregado = jsonAll.informes.find((i) => i.etiqueta === 'all');
  A(!!agregado && agregado.corpus.ia === 2 && agregado.corpus.humano === 2, '--lang all: el agregado suma los 2 idiomas (2 IA + 2 humano)', JSON.stringify(agregado && agregado.corpus));
  A(!!agregado && agregado.detalle_docs.length === 4, '--lang all: detalle_docs trae los 4 documentos', JSON.stringify(agregado && agregado.detalle_docs.length));
  A(
    !!agregado && agregado.detalle_docs.every((d) => d.lang === 'es' || d.lang === 'en'),
    '--lang all: cada documento del detalle trae su idioma',
    JSON.stringify(agregado && agregado.detalle_docs.map((d) => d.lang)),
  );
  A(
    !!agregado && agregado.detalle_docs.every((d) => 'veredicto' in d && 'motivo' in d),
    '--lang all: cada documento trae veredicto y motivo (aunque sea null)',
    JSON.stringify(agregado && agregado.detalle_docs),
  );
  A(!!agregado && CATALOGO_TIENE_IDIOMA_EN_JSON(jsonAll), '--lang all: el JSON declara si el catalogo distingue idioma', JSON.stringify(jsonAll.catalogo_distingue_idioma));
}
function CATALOGO_TIENE_IDIOMA_EN_JSON(j) {
  return typeof j.catalogo_distingue_idioma === 'boolean';
}

// --- Caso negativo: idioma inexistente -> error claro, exit 1 ---------------
const resBad = correr(['--lang', 'fr']);
A(resBad.code === 1, '--lang fr (idioma inexistente): exit 1', `code=${resBad.code}`);
A(/--lang invalido/i.test(resBad.stderr), '--lang fr (idioma inexistente): mensaje de error claro en stderr', resBad.stderr);

// --- Limpieza -----------------------------------------------------------------
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(fail === 0 ? '\nSELFTEST ai-text-eval: VERDE' : `\nSELFTEST ai-text-eval: ROJO (${fail} fallo/s)`);
process.exit(fail === 0 ? 0 : 1);
