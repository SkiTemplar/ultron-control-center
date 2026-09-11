#!/usr/bin/env node
/**
 * research-eval.mjs — evaluacion EN VIVO (APIs reales, no fixtures) del
 * ranking de search(): 8 queries del dominio del TFG (sim-to-real, domain
 * randomization, synthetic data, rendering fidelity, image enhancement...),
 * cada una con un paper pertinente conocido (DOI verificado a mano con una
 * busqueda real contra OpenAlex el 2026-09-11, ver QUERIES). Metricas:
 *
 *   - precision@5: cuantos del top-5 tratan del tema, segun un chequeo de
 *     palabras clave curado a mano POR QUERY (topicRe). Es un proxy honesto,
 *     no un juicio humano item-a-item de cada resultado posible -- pero
 *     replicable y barato de volver a correr.
 *   - posicion del pertinente conocido en el ranking completo (null = fuera
 *     del top pedido).
 *
 * Cada query se ejecuta 2 VECES (Semantic Scholar sin clave es intermitente:
 * a veces 429, a veces no) para reportar estabilidad, no solo un numero
 * suelto.
 *
 * Uso: node scripts/research-eval.mjs
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { search } = require(join(__dirname, '..', 'hooks', 'scripts', 'lib', 'research', 'search.js'));

// DOI y topicRe verificados a mano: cada pertinentDoi se confirmo con una
// busqueda real en OpenAlex antes de entrar aqui (ver commit/notas).
const QUERIES = [
  {
    query: 'domain randomization synthetic images drone detection',
    pertinentDoi: '10.1109/tro.2019.2942989', // Deep Drone Racing: From Simulation to Reality With Domain Randomization
    topicRe: /domain random|sim-to-real|reality gap|drone racing|synthetic (data|image)/i,
  },
  {
    query: 'synthetic data sim-to-real object detection drones',
    pertinentDoi: '10.1109/access.2021.3126658', // Crossing the Reality Gap: sim-to-real transferability survey
    topicRe: /sim-to-real|reality gap|synthetic (data|image)|domain random/i,
  },
  {
    query: 'sim-to-real gap object detection UAV',
    pertinentDoi: '10.1007/978-3-031-66694-0_11', // Closing the Sim-to-Real Gap: UAV precision landing
    topicRe: /sim-to-real|reality gap|synthetic (data|image)|domain random/i,
  },
  {
    query: 'domain randomization for synthetic training data',
    pertinentDoi: '10.1109/cvprw.2018.00143', // Training Deep Networks with Synthetic Data: domain randomization (seminal)
    topicRe: /domain random|synthetic (data|training|image)|reality gap|sim-to-real/i,
  },
  {
    query: 'photorealistic rendering for training data generation',
    pertinentDoi: '10.21105/joss.04901', // BlenderProc2: procedural pipeline for photorealistic rendering
    topicRe: /photorealistic|rendering|synthetic (data|training|image)|procedural/i,
  },
  {
    query: 'image enhancement before object detection',
    pertinentDoi: '10.1016/j.patcog.2024.110435', // UnitModule: joint image enhancement for underwater object detection
    topicRe: /image enhancement|dehaz|restoration|adaptive (gamma|yolo)|adverse weather/i,
  },
  {
    query: 'GAN image-to-image translation synthetic to real',
    pertinentDoi: '10.1145/3588432.3591513', // Zero-shot Image-to-Image Translation
    topicRe: /image-to-image|gan|generative adversarial|synthetic to real|domain translation/i,
  },
  {
    query: 'rendering fidelity vs detector accuracy',
    pertinentDoi: '10.1007/978-3-319-49409-8_18', // How Useful Is Photo-Realistic Rendering for Visual Learning?
    topicRe: /photo-?realistic|rendering|synthetic (data|image)|visual learning|detector accuracy/i,
  },
];

function isOnTopic(paper, topicRe) {
  return topicRe.test(paper.title ?? '') || topicRe.test(paper.abstract ?? '');
}

async function runOnce(q) {
  const { results, warnings } = await search(q.query, { limit: 10 });
  const top5 = results.slice(0, 5);
  const onTopicCount = top5.filter((p) => isOnTopic(p, q.topicRe)).length;
  const pos = results.findIndex((p) => p.doi === q.pertinentDoi);
  return {
    top5Titles: top5.map((p) => p.title),
    precisionAt5: onTopicCount / 5,
    pertinentPosition: pos === -1 ? null : pos + 1,
    warnings,
  };
}

function fmtRun(run) {
  const pos = run.pertinentPosition == null ? 'fuera' : `#${run.pertinentPosition}`;
  return `P@5=${run.precisionAt5.toFixed(1)} pertinente=${pos}`;
}

async function main() {
  const rows = [];
  for (const q of QUERIES) {
    process.stderr.write(`evaluando: "${q.query}"...\n`);
    const run1 = await runOnce(q);
    const run2 = await runOnce(q);
    rows.push({ query: q.query, run1, run2 });
  }

  console.log('\nquery | run1 | run2');
  console.log('---|---|---');
  for (const r of rows) console.log(`${r.query} | ${fmtRun(r.run1)} | ${fmtRun(r.run2)}`);

  const avgP5 = rows.reduce((s, r) => s + (r.run1.precisionAt5 + r.run2.precisionAt5) / 2, 0) / rows.length;
  const foundBoth = rows.filter((r) => r.run1.pertinentPosition != null && r.run2.pertinentPosition != null).length;
  console.log(`\nP@5 media (2 corridas, ${rows.length} queries): ${avgP5.toFixed(2)}`);
  console.log(`Pertinente encontrado en AMBAS corridas: ${foundBoth}/${rows.length}`);

  console.log('\n--- detalle por query ---');
  for (const r of rows) {
    console.log(`\n[${r.query}]`);
    console.log(`  run1: ${fmtRun(r.run1)}${r.run1.warnings.length ? ` (avisos: ${r.run1.warnings.length})` : ''}`);
    r.run1.top5Titles.forEach((t, i) => console.log(`    ${i + 1}. ${t}`));
    console.log(`  run2: ${fmtRun(r.run2)}${r.run2.warnings.length ? ` (avisos: ${r.run2.warnings.length})` : ''}`);
  }
}

main();
