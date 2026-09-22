#!/usr/bin/env node
// scripts/session-summary-backfill.mjs — bitacora para TODAS las sesiones.
//
// session-summarize-previous.js (SessionStart) solo resume la sesion anterior
// mas reciente y solo si tiene menos de 7 dias: el resto de transcripts nunca
// recibe su summary.md y la Bitacora del proyecto queda a medias (medido el
// 2026-09-22 en ultron: 119 transcripts, 20 resumenes). Este script recorre
// los transcripts de cada proyecto registrado en cockpit/projects.json y lanza
// el resumidor, uno a uno, para los que no tienen resumen o lo tienen VIEJO
// (la sesion siguio despues; ver summaryCoversTranscript). Cada resumen es una
// llamada `claude -p` (Sonnet, suscripcion) de 20-40 s: secuencial a proposito.
//
// Uso:
//   node scripts/session-summary-backfill.mjs --dry-run            # solo cuenta
//   node scripts/session-summary-backfill.mjs --project ultron     # un proyecto
//   node scripts/session-summary-backfill.mjs --all [--max N]      # todos
// Salida: una linea por sesion + resumen final. Log detallado del resumidor en
// logs/session-summary.jsonl (el suyo de siempre).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const HOOKS = path.join(ROOT, 'hooks', 'scripts');
const SUMMARIZER = path.join(HOOKS, 'session-summarize-previous.js');
const summarizer = require(SUMMARIZER);
const lastSession = require(path.join(HOOKS, 'lib', 'last-session.js'));
const digest = require(path.join(HOOKS, 'lib', 'session-digest.js'));


function parseArgs(argv) {
  const out = { dryRun: false, all: false, project: null, max: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--all') out.all = true;
    else if (a === '--project') out.project = argv[++i];
    else if (a === '--max') out.max = Number(argv[++i]) || Infinity;
  }
  return out;
}

function loadProjects() {
  const file = path.join(os.homedir(), '.ultron', 'cockpit', 'projects.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.projects || [];
  return list.filter((p) => p && p.id && p.path);
}

/** Transcripts del proyecto que necesitan resumen: sin summary.md, o con uno viejo. */
function pendingSessions(project) {
  const dir = summarizer.transcriptsDirFor(project.path, null);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { dir, pending: [], total: 0 };
  }
  const pending = [];
  let total = 0;
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    total++;
    const sessionId = e.name.slice(0, -'.jsonl'.length);
    const transcriptPath = path.join(dir, e.name);
    let st;
    try {
      st = fs.statSync(transcriptPath);
    } catch {
      continue;
    }
    const summaryMtime = lastSession.summaryMtimeMs(project.id, sessionId);
    if (summarizer.summaryCoversTranscript(summaryMtime, st.mtimeMs)) continue;
    pending.push({ sessionId, transcriptPath, mtimeMs: st.mtimeMs, stale: summaryMtime !== null });
  }
  pending.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { dir, pending, total };
}

function hasEnoughPrompts(transcriptPath) {
  try {
    const entries = digest.readTranscriptEntries(transcriptPath);
    return digest.isWorthSummarizing(entries);
  } catch {
    return false;
  }
}

function summarize(project, sessionId) {
  const r = spawnSync(
    process.execPath,
    [SUMMARIZER, '--cwd', project.path, '--project', project.id, '--session', '__backfill__', '--target-session', sessionId],
    { encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 5 * 60 * 1000 },
  );
  const written = lastSession.summaryMtimeMs(project.id, sessionId);
  return { ok: r.status === 0 && written !== null && Date.now() - written < 10 * 60 * 1000, status: r.status };
}

const args = parseArgs(process.argv.slice(2));
if (!args.all && !args.project) {
  console.error('uso: --dry-run | --project <id> | --all  [--max N]');
  process.exit(2);
}
const projects = loadProjects().filter((p) => args.all || p.id === args.project);
if (projects.length === 0) {
  console.error(`proyecto no encontrado: ${args.project}`);
  process.exit(2);
}

let done = 0;
let failed = 0;
let skippedShort = 0;
let launched = 0;
for (const project of projects) {
  const { dir, pending, total } = pendingSessions(project);
  console.log(`[${project.id}] transcripts=${total} pendientes=${pending.length} (${path.basename(dir)})`);
  for (const s of pending) {
    if (launched >= args.max) break;
    if (!hasEnoughPrompts(s.transcriptPath)) {
      skippedShort++;
      continue;
    }
    if (args.dryRun) {
      console.log(`  - ${s.sessionId}${s.stale ? ' (resumen viejo)' : ''}`);
      launched++;
      continue;
    }
    launched++;
    const t0 = Date.now();
    const r = summarize(project, s.sessionId);
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    if (r.ok) {
      done++;
      console.log(`  ok    ${s.sessionId} (${secs} s)${s.stale ? ' regenerado' : ''}`);
    } else {
      failed++;
      console.log(`  FALLO ${s.sessionId} (${secs} s, status ${r.status}) — ver logs/session-summary.jsonl`);
    }
  }
}
console.log(
  args.dryRun
    ? `dry-run: ${launched} sesiones a resumir, ${skippedShort} sin sustancia: menos de ${digest.MIN_USER_PROMPTS} prompts y menos de ${digest.MIN_ASSISTANT_TURNS_SINGLE_PROMPT} turnos (se omiten)`
    : `hecho: ${done} resumidas, ${failed} fallidas, ${skippedShort} omitidas por cortas`,
);
process.exitCode = failed > 0 ? 1 : 0;
