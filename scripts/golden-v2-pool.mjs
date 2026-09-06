#!/usr/bin/env node
// golden-v2-pool.mjs — pool de candidatos para el oráculo golden v2 (F1.5).
//
// POR QUÉ. El golden v1 son 29 queries limpias escritas a mano en junio
// ("qdrant", "router primary"...). No se parecen a lo que el usuario escribe de
// verdad, y una query vale ±0.034 de recall@8: el agregado se mueve con el
// ruido. El v2 se construye sobre PROMPTS REALES (orchestrate.jsonl guarda
// prompt + proyecto de cada turno) y las etiquetas las pone una persona: el
// script solo prepara el trabajo, no juzga relevancia.
//
// QUÉ HACE.
//   1. Muestrea N prompts reales de los últimos DAYS días: ≥ MIN_WORDS
//      palabras, sin turnos de sistema, sin pegotes largos, sin duplicados;
//      tope por proyecto para que ULTRON no lo sea todo. Semilla fija.
//   2. Por prompt pide al daemon dos recalls SIN reranker (el pool no debe
//      llevar el sesgo del reranker que luego se evalúa): top-K en el
//      proyecto del turno y top-KX cross-project. Une y conserva el origen.
//   3. Escribe pool.json (máquina) y labeling.md (persona: casillas [ ]).
//
// USO.
//   node scripts/golden-v2-pool.mjs                 # 30 prompts, 10 + 4
//   node scripts/golden-v2-pool.mjs --n 40 --k 12 --kx 6 --days 45
//   Salida: cockpit/memory-rework/evals/golden-v2/{pool.json,labeling.md}
//
// Después: rellenar labeling.md y `node scripts/golden-v2-compile.mjs`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { daemonRequest } = require('../hooks/scripts/lib/ultron-memory-cli.js');
const { isSystemTurnPrompt } = require('../hooks/scripts/lib/system-turn.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORCH_LOG = path.join(os.homedir(), '.claude', 'logs', 'orchestrate.jsonl');
const OUT_DIR = path.join(ROOT, 'cockpit', 'memory-rework', 'evals', 'golden-v2');

const args = process.argv.slice(2);
const num = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def;
};
const N = num('--n', 30);
const K = num('--k', 10);
const KX = num('--kx', 4);
const DAYS = num('--days', 30);
const SEED = num('--seed', 20260906);
const MIN_WORDS = 6;
const MAX_CHARS = 600;
const MAX_PER_PROJECT = { ultron: Math.ceil(N / 2) };
const DEFAULT_MAX_PER_PROJECT = 5;
const RECALL_TIMEOUT_MS = 20000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalize(s) {
  return String(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

function readTurns() {
  const since = Date.now() - DAYS * 86400000;
  const seen = new Set();
  const out = [];
  const lines = fs.readFileSync(ORCH_LOG, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const prompt = typeof o.prompt === 'string' ? o.prompt.trim() : '';
    if (!prompt || new Date(o.ts).getTime() < since) continue;
    if (prompt.split(/\s+/).length < MIN_WORDS || prompt.length > MAX_CHARS) continue;
    if (isSystemTurnPrompt(prompt)) continue;
    const key = normalize(prompt);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ts: o.ts, project: o.project || null, route: o.route || 'general', prompt });
  }
  return out;
}

function sample(turns) {
  const rnd = mulberry32(SEED);
  const shuffled = [...turns].sort(() => rnd() - 0.5);
  const perProject = new Map();
  const picked = [];
  for (const t of shuffled) {
    const p = t.project || '__none__';
    const cap = MAX_PER_PROJECT[p] ?? DEFAULT_MAX_PER_PROJECT;
    const used = perProject.get(p) || 0;
    if (used >= cap) continue;
    perProject.set(p, used + 1);
    picked.push(t);
    if (picked.length >= N) break;
  }
  return picked.sort((a, b) => a.ts.localeCompare(b.ts));
}

async function recall(prompt, project, top, cross) {
  const r = await daemonRequest(
    { cmd: 'recall', prompt, project: project || undefined, top, cross, rerank: false },
    RECALL_TIMEOUT_MS
  );
  return r && Array.isArray(r.entries) ? r.entries : [];
}

function candidate(e, source, rank) {
  return {
    id: e.canonical_id,
    kind: e.kind || '',
    project_id: e.project_id || null,
    title: e.title || '',
    summary: String(e.summary || '').replace(/\s+/g, ' ').trim(),
    source,
    rank,
    score: e.score ?? null,
  };
}

async function buildPool(picked) {
  const queries = [];
  let qi = 0;
  for (const t of picked) {
    qi += 1;
    const qid = 'q' + String(qi).padStart(2, '0');
    const byId = new Map();
    const inProject = await recall(t.prompt, t.project, K, false);
    inProject.forEach((e, i) => byId.set(e.canonical_id, candidate(e, 'project', i + 1)));
    const cross = await recall(t.prompt, t.project, KX, true);
    cross.forEach((e, i) => {
      const prev = byId.get(e.canonical_id);
      if (prev) prev.source = prev.source + '+cross';
      else byId.set(e.canonical_id, candidate(e, 'cross', i + 1));
    });
    const candidates = [...byId.values()].map((c, i) => ({ ...c, cid: 'c' + String(i + 1).padStart(2, '0') }));
    queries.push({ qid, ts: t.ts, project: t.project, route: t.route, prompt: t.prompt, candidates });
    process.stderr.write(`[pool] ${qid} ${t.project || '-'} candidatos=${candidates.length}\n`);
  }
  return queries;
}

function renderLabeling(queries) {
  const lines = [];
  lines.push('# Golden v2 — etiquetado a mano (' + new Date().toISOString().slice(0, 10) + ')');
  lines.push('');
  lines.push('Regla: marca `[x]` solo si esa memoria responde o ayuda DIRECTAMENTE a lo que pide el prompt tal y como está escrito. Contexto vago, mismo tema pero otra pregunta, o "no viene mal": `[ ]`. No edites ids ni el orden.');
  lines.push('');
  for (const q of queries) {
    lines.push(`## ${q.qid} · ${q.project || '-'} · route=${q.route} · ${q.ts.slice(0, 10)}`);
    lines.push('');
    lines.push('> ' + q.prompt.replace(/\s+/g, ' ').slice(0, 400));
    lines.push('');
    for (const c of q.candidates) {
      const sum = c.summary.slice(0, 180);
      lines.push(`- [ ] ${c.cid} \`${c.id.slice(0, 8)}\` ${c.kind} · ${c.title} — ${sum}`);
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const turns = readTurns();
  const picked = sample(turns);
  if (picked.length === 0) {
    console.error('[pool] sin prompts elegibles en ' + ORCH_LOG);
    process.exit(1);
  }
  const queries = await buildPool(picked);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const pool = {
    generated_at: new Date().toISOString(),
    source: ORCH_LOG,
    params: { n: N, k: K, kx: KX, days: DAYS, seed: SEED, min_words: MIN_WORDS, rerank: false },
    eligible_turns: turns.length,
    queries,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'pool.json'), JSON.stringify(pool, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'labeling.md'), renderLabeling(queries));
  const totalCands = queries.reduce((a, q) => a + q.candidates.length, 0);
  const perProject = {};
  for (const q of queries) perProject[q.project || '-'] = (perProject[q.project || '-'] || 0) + 1;
  console.log(JSON.stringify({
    ok: true,
    eligible_turns: turns.length,
    queries: queries.length,
    candidates: totalCands,
    per_project: perProject,
    out: OUT_DIR,
  }));
}

main().catch((e) => {
  console.error('[pool] ERROR', e && e.message);
  process.exit(1);
});
