#!/usr/bin/env node
/**
 * memory-bench.mjs — benchmark EXTERNO duro del sistema de memoria
 * (masterplan (b), feedback 2026-07-02).
 *
 * Motivo: el eval interno (golden set, recall@8=1.0) puede ser fácil. Este
 * harness ataca 7 categorías adversariales con queries REALES contra el
 * sidecar desplegado (`bin/ultron-memory.exe recall`, k=8 fijo):
 *
 *   temporal        — el top-3 debe reflejar la era ACTUAL del hecho
 *   stale           — afirmaciones supersedidas no deben rankear top-3
 *   multihop        — las DOS piezas de una pregunta puente en el top-8
 *                     (en >=2 entries distintas)
 *   contradicciones — ante hechos en conflicto, gana la verdad vigente
 *   secretos        — 0 patrones de credencial en el output + 0 ids Secret
 *   cross_project   — sin --cross, cero fugas de otros proyectos
 *   abstain         — para lo incontestable: sin confianza sobre el floor
 *                     Y pack vacío (el read-path aún no tiene score-floor:
 *                     ese check DEBE salir rojo hasta que exista)
 *
 * READ-ONLY por diseño: solo `recall` + un chequeo sqlite de gobernanza vía
 * benchmarks/memory/check_ids.py (los ids devueltos deben ser active y no
 * Secret). Nunca escribe en brain.db — sin limpieza, sin contaminación.
 *
 * Queries versionadas en benchmarks/memory/queries.json. Las expectativas
 * codifican la VERDAD OBJETIVA (CLAUDE.md / decisiones vigentes), no lo que
 * el recall devuelva hoy: un rojo es información, no un bug del harness.
 *
 * Uso:
 *   node scripts/memory-bench.mjs            # corre y escribe logs/memory-bench.json
 *   node scripts/memory-bench.mjs --gate     # exit 1 si overall < meta.gate_min
 *   node scripts/memory-bench.mjs --json     # solo JSON por stdout
 *
 * Selftest hermético del evaluador: scripts/memory-bench.selftest.mjs
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ULTRON = join(__dirname, "..");
const QUERIES_FILE = join(ULTRON, "benchmarks", "memory", "queries.json");
const CHECK_IDS_PY = join(ULTRON, "benchmarks", "memory", "check_ids.py");
const OUT_FILE = join(ULTRON, "logs", "memory-bench.json");

// ---------------------------------------------------------------------------
// Evaluador puro (exportado para el selftest)
// ---------------------------------------------------------------------------

/** Patrones de credenciales (mismos vectores que redaction.rs cubre al escribir). */
const SECRET_PATTERNS = [
  { name: "openai-key", re: /sk-[A-Za-z0-9]{20,}/ },
  { name: "github-token", re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "aws-key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "slack-token", re: /xox[bap]-[A-Za-z0-9-]{10,}/ },
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "bearer", re: /Bearer\s+[A-Za-z0-9._~+/-]{25,}/ },
];

/** Devuelve los nombres de patrón de secreto hallados en `text`. */
export function scanSecrets(text) {
  const hits = [];
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(String(text || ""))) hits.push(name);
  }
  return hits;
}

const entryText = (e) => `${e.title ?? ""} ${e.summary ?? ""}`;

/** Similitud Jaccard sobre tokens normalizados (proxy LÉXICO de near-dup). */
export function jaccard(a, b) {
  const tok = (s) =>
    new Set(
      String(s || "")
        .toLowerCase()
        .split(/[^\p{L}\p{N}_.]+/u)
        .filter(Boolean),
    );
  const ta = tok(a);
  const tb = tok(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

/**
 * Pares (i,j) de entries del pack cuya similitud Jaccard >= threshold.
 * v3: un pack sano no repite la misma información con otro id — los near-dups
 * LÉXICOS son la clase "Retirar gemini_cli.py ×5". Límite declarado: paráfrasis
 * semánticas con vocabulario distinto no se cazan (eso pide embeddings).
 */
export function findNearDupPairs(entries, threshold = 0.7) {
  const pairs = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (jaccard(entryText(entries[i]), entryText(entries[j])) >= threshold) {
        pairs.push([i, j]);
      }
    }
  }
  return pairs;
}

/**
 * Evalúa un resultado de recall contra la expectativa de su spec.
 * result = { entries: [...], raw: string } · opts = { floor }
 * Devuelve { pass, checks: [{name, pass, detail}] } — pass = todos los checks.
 */
export function evaluateQuery(spec, result, opts = {}) {
  const expect = spec.expect || {};
  const entries = result.entries || [];
  const top3 = entries.slice(0, 3);
  const top8 = entries.slice(0, 8);
  const checks = [];

  for (const pat of expect.include_top3 || []) {
    const re = new RegExp(pat, "i");
    const hit = top3.some((e) => re.test(entryText(e)));
    checks.push({
      name: `include_top3:${pat}`,
      pass: hit,
      detail: hit ? "presente en top-3" : `ningún top-3 matchea /${pat}/i`,
    });
  }

  for (const pat of expect.exclude_top3 || []) {
    const re = new RegExp(pat, "i");
    const offender = top3.find((e) => re.test(entryText(e)));
    checks.push({
      name: `exclude_top3:${pat}`,
      pass: !offender,
      detail: offender ? `stale en top-3: "${entryText(offender).slice(0, 90)}"` : "limpio",
    });
  }

  if (expect.multihop_top8 && expect.multihop_top8.length > 0) {
    const matchedIdx = new Set();
    let allPatternsHit = true;
    const missing = [];
    for (const pat of expect.multihop_top8) {
      const re = new RegExp(pat, "i");
      const idxs = top8.map((e, i) => (re.test(entryText(e)) ? i : -1)).filter((i) => i >= 0);
      if (idxs.length === 0) {
        allPatternsHit = false;
        missing.push(pat);
      }
      idxs.forEach((i) => matchedIdx.add(i));
    }
    // >=2 entries distintas: dos hechos cubiertos por UNA sola memoria no es
    // recuperación multi-hop, es un resumen afortunado.
    const spread = matchedIdx.size >= 2;
    checks.push({
      name: "multihop_top8",
      pass: allPatternsHit && spread,
      detail: !allPatternsHit
        ? `patrones sin match: ${missing.join(", ")}`
        : spread
          ? `cubierto por ${matchedIdx.size} entries`
          : "ambos patrones caen en la MISMA entry (no hay hop)",
    });
  }

  if (expect.abstain) {
    const floor = opts.floor ?? 0.84;
    const denseMax = Math.max(0, ...entries.map((e) => e.dense_score ?? 0));
    checks.push({
      name: "abstain_confidence",
      pass: denseMax < floor,
      detail: `dense max=${denseMax.toFixed(4)} vs floor=${floor}`,
    });
    checks.push({
      name: "abstain_empty",
      pass: entries.length === 0,
      detail:
        entries.length === 0
          ? "pack vacío"
          : `${entries.length} entries devueltas para una query incontestable (sin score-floor en read-path)`,
    });
  }

  if (expect.no_near_dup) {
    const pairs = findNearDupPairs(entries, 0.7);
    checks.push({
      name: "no_near_dup",
      pass: pairs.length === 0,
      detail:
        pairs.length === 0
          ? "pack sin near-dups léxicos"
          : `${pairs.length} par(es) casi idéntico(s): ${pairs
              .map(([i, j]) => `(${i},${j}) "${entryText(entries[i]).slice(0, 50)}"`)
              .join(" · ")}`,
    });
  }

  for (const proj of expect.forbid_project || []) {
    const leak = entries.find((e) => e.project_id === proj);
    checks.push({
      name: `forbid_project:${proj}`,
      pass: !leak,
      detail: leak ? `FUGA: "${entryText(leak).slice(0, 90)}"` : "sin fuga",
    });
  }

  // Invariante global: cero credenciales en el texto devuelto.
  const leaks = scanSecrets(result.raw);
  checks.push({
    name: "no_secret_text",
    pass: leaks.length === 0,
    detail: leaks.length === 0 ? "limpio" : `patrones: ${leaks.join(", ")}`,
  });

  return { pass: checks.every((c) => c.pass), checks };
}

/** Tasa de duplicados en el pack: 1 - unique(texto)/n. Salud del corpus. */
export function dupRate(entries) {
  if (!entries || entries.length === 0) return 0;
  const uniq = new Set(entries.map((e) => entryText(e).trim().toLowerCase()));
  return 1 - uniq.size / entries.length;
}

// ---------------------------------------------------------------------------
// Runner (solo cuando se invoca directamente)
// ---------------------------------------------------------------------------

function findBinary() {
  const exe = process.platform === "win32" ? "ultron-memory.exe" : "ultron-memory";
  const candidates = [
    process.env.ULTRON_MEMORY_BIN,
    join(os.homedir(), ".ultron", "bin", exe),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function runRecall(bin, spec) {
  const args = ["recall", spec.query];
  if (spec.project) args.push("--project", spec.project);
  if (spec.cross) args.push("--cross");
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 60000, windowsHide: true });
  const raw = (r.stdout || "").replace(/^﻿/, "");
  try {
    const parsed = JSON.parse(raw);
    return { entries: parsed.entries || [], raw, error: null };
  } catch {
    return { entries: [], raw, error: `recall no devolvió JSON (${(r.stderr || "").slice(0, 160)})` };
  }
}

/** Gobernanza: ids devueltos deben ser active y no Secret (sqlite read-only). */
function checkIdsGovernance(ids) {
  if (ids.length === 0) return { checked: 0, non_active: [], secret: [], error: null };
  const r = spawnSync("uv", ["run", "python", CHECK_IDS_PY], {
    input: JSON.stringify(ids),
    encoding: "utf8",
    timeout: 60000,
    cwd: ULTRON,
    windowsHide: true,
    shell: process.platform === "win32", // uv es .cmd shim en Windows
  });
  try {
    const lines = (r.stdout || "").trim().split("\n");
    return { ...JSON.parse(lines[lines.length - 1]), error: null };
  } catch {
    return { checked: 0, non_active: [], secret: [], error: `check_ids falló: ${(r.stderr || "").slice(0, 160)}` };
  }
}

function main() {
  const argv = process.argv.slice(2);
  const gateMode = argv.includes("--gate");
  const jsonOnly = argv.includes("--json");

  const bin = findBinary();
  if (!bin) {
    console.error("[memory-bench] no se encontró ultron-memory(.exe)");
    process.exit(1);
  }
  const cfg = JSON.parse(readFileSync(QUERIES_FILE, "utf8"));
  const floor = cfg.meta.abstain_floor;

  const results = [];
  const allIds = new Set();
  for (const spec of cfg.queries) {
    const res = runRecall(bin, spec);
    const evalRes = res.error
      ? { pass: false, checks: [{ name: "recall_ok", pass: false, detail: res.error }] }
      : evaluateQuery(spec, res, { floor });
    res.entries.forEach((e) => e.canonical_id && allIds.add(e.canonical_id));
    results.push({
      id: spec.id,
      category: spec.category,
      query: spec.query,
      project: spec.project ?? null,
      pass: evalRes.pass,
      dup_rate: +dupRate(res.entries).toFixed(3),
      dense_max: +Math.max(0, ...res.entries.map((e) => e.dense_score ?? 0)).toFixed(4),
      checks: evalRes.checks,
    });
  }

  // Gobernanza sobre TODOS los ids devueltos por el benchmark.
  const gov = checkIdsGovernance([...allIds]);
  const govPass = !gov.error && gov.non_active.length === 0 && gov.secret.length === 0;

  // Nota por categoría = media de CHECKS (no de queries): abstain con 1/2
  // checks verdes puntúa 5, no 0 — granularidad honesta.
  const categories = {};
  for (const r of results) {
    const cat = (categories[r.category] ??= { checks_pass: 0, checks_total: 0, queries: 0 });
    cat.queries += 1;
    for (const c of r.checks) {
      cat.checks_total += 1;
      if (c.pass) cat.checks_pass += 1;
    }
  }
  for (const cat of Object.values(categories)) {
    cat.nota = +((cat.checks_pass / Math.max(1, cat.checks_total)) * 10).toFixed(2);
  }
  const notas = Object.values(categories).map((c) => c.nota);
  const overall = +(notas.reduce((a, b) => a + b, 0) / Math.max(1, notas.length)).toFixed(2);

  const report = {
    schema: "memory-bench.v1",
    version: cfg.meta.version,
    abstain_floor: floor,
    overall,
    governance: { pass: govPass, ...gov },
    avg_dup_rate: +(results.reduce((a, r) => a + r.dup_rate, 0) / Math.max(1, results.length)).toFixed(3),
    categories,
    results,
  };

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(report, null, 1));

  if (jsonOnly) {
    console.log(JSON.stringify(report));
  } else {
    console.log(`\nmemory-bench v${cfg.meta.version} · floor=${floor} · ${results.length} queries\n`);
    for (const [name, cat] of Object.entries(categories)) {
      console.log(`  ${cat.nota >= 10 ? "✔" : cat.nota >= 5 ? "~" : "✘"} ${name.padEnd(16)} ${String(cat.nota).padStart(5)}  (${cat.checks_pass}/${cat.checks_total} checks · ${cat.queries} queries)`);
    }
    console.log(`\n  gobernanza ids: ${govPass ? "OK" : "FALLO"} (${gov.checked} ids · non_active=${gov.non_active.length} · secret=${gov.secret.length}${gov.error ? ` · error=${gov.error}` : ""})`);
    console.log(`  dup_rate medio del pack: ${report.avg_dup_rate}`);
    console.log(`  OVERALL: ${overall}/10 -> logs/memory-bench.json`);
    const reds = results.filter((r) => !r.pass);
    if (reds.length) {
      console.log(`\n  Rojos (${reds.length}):`);
      for (const r of reds) {
        for (const c of r.checks.filter((c) => !c.pass)) {
          console.log(`    - [${r.category}] ${r.id} · ${c.name}: ${c.detail}`);
        }
      }
    }
  }

  const gateMin = cfg.meta.gate_min ?? 8;
  if (gateMode && (overall < gateMin || !govPass)) process.exit(1);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  main();
}
