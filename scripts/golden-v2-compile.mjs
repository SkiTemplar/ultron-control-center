#!/usr/bin/env node
// golden-v2-compile.mjs — de labeling.md (casillas marcadas a mano) al golden
// que entiende `ultron-memory.exe eval --golden <path>` (F1.5).
//
// Lee cockpit/memory-rework/evals/golden-v2/{pool.json,labeling.md}, cruza
// cada `- [x] cNN` con el candidato del pool (id completo, no el corto del
// .md) y escribe golden_labels.v2.json con el mismo esquema que el v1:
// { _note, labeled: [{ id, query, category, project_id, expect_ids,
//   n_relevant, expect_groups }] }. Las queries sin ninguna marca se
// conservan con expect_ids vacío: el eval las salta (skipped_no_expectation)
// y así se ve cuántas quedaron sin etiquetar en vez de inflar el recall.
//
// USO: node scripts/golden-v2-compile.mjs [--out <ruta>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'cockpit', 'memory-rework', 'evals', 'golden-v2');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 && args[outIdx + 1] ? path.resolve(args[outIdx + 1]) : path.join(DIR, 'golden_labels.v2.json');

const QUERY_RE = /^## (q\d{2}) /;
const MARK_RE = /^- \[([ xX])\] (c\d{2}) `([0-9a-f]{8})`/;

function parseLabeling(md) {
  const marks = new Map(); // qid -> Map(cid -> {checked, shortId})
  let current = null;
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const q = line.match(QUERY_RE);
    if (q) {
      current = q[1];
      if (!marks.has(current)) marks.set(current, new Map());
      continue;
    }
    const m = line.match(MARK_RE);
    if (m && current) {
      marks.get(current).set(m[2], { checked: m[1] !== ' ', shortId: m[3] });
    }
  }
  return marks;
}

function main() {
  const pool = JSON.parse(fs.readFileSync(path.join(DIR, 'pool.json'), 'utf8'));
  const marks = parseLabeling(fs.readFileSync(path.join(DIR, 'labeling.md'), 'utf8'));
  const labeled = [];
  let relevantTotal = 0;
  let unlabeled = 0;
  const problems = [];
  for (const q of pool.queries) {
    const qm = marks.get(q.qid) || new Map();
    const expect = [];
    for (const c of q.candidates) {
      const mark = qm.get(c.cid);
      if (!mark) {
        problems.push(`${q.qid} ${c.cid}: falta la línea en labeling.md`);
        continue;
      }
      if (mark.shortId !== c.id.slice(0, 8)) {
        problems.push(`${q.qid} ${c.cid}: id corto ${mark.shortId} no coincide con el pool ${c.id.slice(0, 8)}`);
        continue;
      }
      if (mark.checked) expect.push(c.id);
    }
    if (expect.length === 0) unlabeled += 1;
    relevantTotal += expect.length;
    labeled.push({
      id: 'gv2-' + q.qid,
      query: q.prompt,
      category: q.route || 'general',
      project_id: q.project || null,
      expect_ids: expect,
      n_relevant: expect.length,
      expect_groups: expect.map((id) => [id]),
      source_ts: q.ts,
    });
  }
  if (problems.length) {
    console.error('[compile] problemas:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  const golden = {
    _note:
      'Golden v2 (F1.5, ' + new Date().toISOString().slice(0, 10) + '): ' + labeled.length +
      ' prompts REALES de orchestrate.jsonl etiquetados a mano sobre un pool de recall sin reranker ' +
      '(top-' + pool.params.k + ' proyecto + top-' + pool.params.kx + ' cross). ' +
      'expect_ids = memorias que responden directamente al prompt. Queries sin marca se conservan con expect_ids vacío (el eval las salta).',
    generated_from: { pool: pool.generated_at, params: pool.params },
    labeled,
  };
  fs.writeFileSync(OUT, JSON.stringify(golden, null, 2));
  console.log(JSON.stringify({
    ok: true,
    queries: labeled.length,
    with_labels: labeled.length - unlabeled,
    without_labels: unlabeled,
    relevant_total: relevantTotal,
    relevant_per_query: labeled.length ? +(relevantTotal / labeled.length).toFixed(2) : 0,
    out: OUT,
  }));
}

main();
