#!/usr/bin/env node
// golden-v2-ab.mjs — A/B del reranker cross-encoder sobre un golden (F1.5).
//
// Lanza `ultron-memory.exe eval --golden <path>` dos veces, con
// ULTRON_RERANK=0 y ULTRON_RERANK=1, y pone las métricas agregadas lado a
// lado: recall@8, precision@k, MRR, nDCG@8, context_waste. El criterio del
// plan es uno solo: reranker ON si sube nDCG@8. Si ambas pasadas dan
// EXACTAMENTE lo mismo, el flag no ha llegado al proceso que hace el recall
// (el one-shot delegó en el daemon, que leyó el entorno al arrancar): se
// avisa en vez de declarar un empate falso.
//
// USO: node scripts/golden-v2-ab.mjs [ruta-golden] [--only 0|1]
//   por defecto: cockpit/memory-rework/evals/golden-v2/golden_labels.v2.json

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = process.env.ULTRON_MEMORY_BIN || path.join(ROOT, 'bin', 'ultron-memory.exe');
const args = process.argv.slice(2);
const goldenArg = args.find((a) => !a.startsWith('--'));
const GOLDEN = goldenArg
  ? path.resolve(goldenArg)
  : path.join(ROOT, 'cockpit', 'memory-rework', 'evals', 'golden-v2', 'golden_labels.v2.json');
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
const TIMEOUT_MS = 20 * 60 * 1000;

function runEval(rerank) {
  const t0 = Date.now();
  const r = spawnSync(BIN, ['eval', '--golden', GOLDEN], {
    env: { ...process.env, ULTRON_RERANK: rerank ? '1' : '0' },
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  const elapsed = Math.round((Date.now() - t0) / 1000);
  if (r.status !== 0) {
    return { error: (r.stderr || '').trim().split('\n').slice(-3).join(' | ') || `exit ${r.status}`, elapsed_s: elapsed };
  }
  let j;
  try {
    j = JSON.parse(r.stdout);
  } catch (e) {
    return { error: 'stdout no es JSON: ' + String(r.stdout).slice(0, 200), elapsed_s: elapsed };
  }
  const g = j.golden_metrics || j;
  const a = g.aggregate || g;
  return {
    elapsed_s: elapsed,
    scored: g.aggregated_over,
    skipped: g.zero_relevant,
    degraded: !!g.degraded,
    note: g.note || '',
    recall_at_8: a.recall_at_k,
    precision_at_k: a.precision_at_k,
    mrr: a.mrr,
    ndcg_at_8: a.ndcg_at_k,
    context_waste: a.context_waste,
    leaks: (g.secret_leak_count || 0) + (g.stale_leak_count || 0),
  };
}

function fmt(x) {
  return typeof x === 'number' ? x.toFixed(3) : String(x ?? '-');
}

function main() {
  if (!fs.existsSync(GOLDEN)) {
    console.error('[ab] no existe el golden: ' + GOLDEN);
    process.exit(1);
  }
  const runs = {};
  if (ONLY === null || ONLY === '0') runs.off = runEval(false);
  if (ONLY === null || ONLY === '1') runs.on = runEval(true);
  const rows = ['recall_at_8', 'precision_at_k', 'mrr', 'ndcg_at_8', 'context_waste', 'scored', 'skipped', 'elapsed_s'];
  console.log('metric            rerank=0   rerank=1');
  for (const k of rows) {
    console.log(k.padEnd(18) + fmt(runs.off && runs.off[k]).padStart(8) + '   ' + fmt(runs.on && runs.on[k]).padStart(8));
  }
  for (const [name, r] of Object.entries(runs)) {
    if (r.error) console.log(`[ab] ${name}: ERROR ${r.error}`);
    if (r.degraded) console.log(`[ab] ${name}: DEGRADED ${r.note}`);
    if (r.leaks) console.log(`[ab] ${name}: leaks=${r.leaks}`);
  }
  if (runs.off && runs.on && !runs.off.error && !runs.on.error) {
    const same = rows.slice(0, 5).every((k) => runs.off[k] === runs.on[k]);
    if (same) {
      console.log('[ab] AVISO: métricas idénticas con rerank 0 y 1 — el flag no llegó al recall (daemon con entorno viejo). No es un empate.');
    } else {
      const delta = runs.on.ndcg_at_8 - runs.off.ndcg_at_8;
      console.log(`[ab] nDCG@8 delta ON-OFF = ${delta >= 0 ? '+' : ''}${delta.toFixed(3)} → reranker ${delta > 0 ? 'ON' : 'OFF'} según el criterio F1.5`);
    }
  }
  const outPath = path.join(path.dirname(GOLDEN), 'ab-' + new Date().toISOString().slice(0, 10) + '.json');
  fs.writeFileSync(outPath, JSON.stringify({ golden: GOLDEN, runs }, null, 2));
  console.log('[ab] guardado ' + outPath);
}

main();
