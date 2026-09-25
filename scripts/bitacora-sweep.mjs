#!/usr/bin/env node
// scripts/bitacora-sweep.mjs — barrido PERIODICO de bitacoras (summary.md)
// pendientes, para todos los proyectos registrados.
//
// Por que (diagnostico 2026-09-25): session-end-bitacora.js (SessionEnd) casi
// nunca dispara -- el usuario cierra la ventana en vez de salir con /exit --
// asi que summary.md solo lo genera el fallback de memory-session-resume.js
// (SessionStart) del arranque SIGUIENTE del MISMO proyecto. En un proyecto que
// se retoma a los pocos dias, la bitacora llega con 8h-4 dias de retraso (ver
// logs/session-summary.jsonl). Este script recorre TODOS los proyectos de
// cockpit/projects.json, no solo el que se este abriendo, y resume las
// sesiones que llevan >= INACTIVE_MIN minutos sin escribirse y aun no tienen
// resumen (o tienen uno VIEJO). Pensado para correr cada 15 min via tarea
// programada (scripts/install-bitacora-sweep.ps1, mismo patron oculto que el
// watchdog de Qdrant: scripts/qdrant/install-qdrant-watchdog.ps1).
//
// NO duplica la generacion: toda la seleccion fina (summary VIEJO vs
// cubierto, backoff, "ya sabemos que es trivial") y la generacion en si
// (`claude -p`, redaccion, lock POR SESION, escritura atomica) viven enteras
// en hooks/scripts/session-summarize-previous.js -- este script solo decide
// QUE sesiones de QUE proyectos tocan en esta pasada y CUANTAS (limite, para
// no quemar cuota de Sonnet), y lo lanza como el resto de llamantes
// (session-end-bitacora.js, scripts/session-summary-backfill.mjs).
//
// Uso:
//   node scripts/bitacora-sweep.mjs [--dry-run] [--max N] [--project id]
// Env:
//   BITACORA_SWEEP_MAX            limite de resumenes por pasada (default 3)
//   BITACORA_SWEEP_INACTIVE_MIN   inactividad minima en minutos (default 20)
//   BITACORA_SWEEP_LOG            ruta del log jsonl (default logs/session-summary.jsonl)
//   BITACORA_SWEEP_PROJECTS_FILE  ruta de cockpit/projects.json (seam de test)
//   BITACORA_SWEEP_SUMMARIZER     script a invocar por sesion (seam de test;
//                                 en produccion siempre session-summarize-previous.js)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const HOOKS = path.join(ROOT, 'hooks', 'scripts');
const REAL_SUMMARIZER = path.join(HOOKS, 'session-summarize-previous.js');
// Las funciones puras (seleccion/backoff/lock) SIEMPRE vienen del resumidor
// real -- solo el BINARIO que se spawnea por sesion es sustituible en test.
const summarizer = require(REAL_SUMMARIZER);
const lastSession = require(path.join(HOOKS, 'lib', 'last-session.js'));
const digest = require(path.join(HOOKS, 'lib', 'session-digest.js'));
const { appendJsonl } = require(path.join(HOOKS, 'lib', 'jsonl-log.js'));

const HOME = os.homedir();
const LOG_PATH = process.env.BITACORA_SWEEP_LOG || path.join(HOME, '.ultron', 'logs', 'session-summary.jsonl');
const PROJECTS_FILE = process.env.BITACORA_SWEEP_PROJECTS_FILE || path.join(HOME, '.ultron', 'cockpit', 'projects.json');
const SUMMARIZER_SCRIPT = process.env.BITACORA_SWEEP_SUMMARIZER || REAL_SUMMARIZER;
const DEFAULT_MAX = 3;
const DEFAULT_INACTIVE_MIN = 20;
const SWEEP_LOCK_ID = '__bitacora_sweep__';

function parseArgs(argv) {
  const out = { dryRun: false, max: null, project: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--max') out.max = Number(argv[++i]);
    else if (a === '--project') out.project = argv[++i];
  }
  return out;
}

function loadProjects() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : raw.projects || [];
  return list.filter((p) => p && p.id && p.path);
}

/**
 * Sesiones de `project` sin resumen (o con uno VIEJO, ver
 * summaryCoversTranscript) que llevan >= `inactiveMs` sin escribirse y tienen
 * sustancia suficiente (isWorthSummarizing). Reutiliza integramente los gates
 * del resumidor (backoff, ya-sabemos-trivial) para no repetir trabajo que
 * SessionStart ya descarto. Fail-safe: sin transcripts -> [].
 */
function pendingSessions(project, inactiveMs, now) {
  const dir = summarizer.transcriptsDirFor(project.path, null);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const pending = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const sessionId = e.name.slice(0, -'.jsonl'.length);
    const transcriptPath = path.join(dir, e.name);
    let st;
    try {
      st = fs.statSync(transcriptPath);
    } catch {
      continue;
    }
    if (now - st.mtimeMs < inactiveMs) continue; // sigue activa: aun no toca
    const summaryMtime = lastSession.summaryMtimeMs(project.id, sessionId);
    if (summarizer.summaryCoversTranscript(summaryMtime, st.mtimeMs)) continue;
    if (summarizer.backoffReason(sessionId)) continue;
    if (summarizer.isKnownNonCandidate(sessionId, st.mtimeMs)) continue;
    let parsedEntries;
    try {
      parsedEntries = digest.readTranscriptEntries(transcriptPath);
    } catch {
      continue;
    }
    if (!digest.isWorthSummarizing(parsedEntries)) {
      summarizer.markTrivial(sessionId, st.mtimeMs);
      continue;
    }
    pending.push({ sessionId, transcriptPath, mtimeMs: st.mtimeMs });
  }
  // La que mas tiempo lleva esperando primero: es la mas urgente.
  pending.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return pending;
}

/** Lanza el resumidor (o su stub de test) para UNA sesion y espera el resultado. */
function summarizeOne(project, sessionId) {
  const t0 = Date.now();
  const r = spawnSync(
    process.execPath,
    [SUMMARIZER_SCRIPT, '--cwd', project.path, '--project', project.id, '--session', SWEEP_LOCK_ID, '--target-session', sessionId],
    { encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 5 * 60 * 1000 }
  );
  const written = lastSession.summaryMtimeMs(project.id, sessionId);
  const ok = r.status === 0 && written !== null && Date.now() - written < 10 * 60 * 1000;
  return { ok, status: r.status, ms: Date.now() - t0 };
}

/**
 * Candidatas de TODOS los proyectos (o solo `onlyProjectId` si se pasa),
 * mezcladas y ordenadas por la que mas tiempo lleva esperando resumen,
 * independientemente del proyecto al que pertenezca.
 */
function collectCandidates(projects, inactiveMs, now) {
  const out = [];
  for (const project of projects) {
    for (const s of pendingSessions(project, inactiveMs, now)) {
      out.push({ project, ...s });
    }
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const max = Number.isFinite(args.max) && args.max > 0 ? args.max : Number(process.env.BITACORA_SWEEP_MAX) || DEFAULT_MAX;
  const inactiveMin = Number(process.env.BITACORA_SWEEP_INACTIVE_MIN) || DEFAULT_INACTIVE_MIN;
  const inactiveMs = inactiveMin * 60 * 1000;

  // Single-flight (mismo mecanismo que session-summarize-previous.js usa por
  // sesion, ver gotcha-drains-solapados-duplicados): evita que dos pasadas de
  // la tarea programada se solapen entre si. El lock POR SESION del propio
  // resumidor ya evita solaparse con SessionStart/SessionEnd para la MISMA
  // sesion; este lock cubre la pasada completa del sweep consigo misma.
  const lock = summarizer.acquireLock(SWEEP_LOCK_ID);
  if (!lock) {
    console.log('bitacora-sweep: otra pasada ya en marcha (lock ocupado)');
    process.exitCode = 0;
    return;
  }

  try {
    const now = Date.now();
    const projects = loadProjects().filter((p) => !args.project || p.id === args.project);
    const candidates = collectCandidates(projects, inactiveMs, now);

    console.log(`bitacora-sweep: ${candidates.length} sesion(es) pendiente(s) en ${projects.length} proyecto(s) (inactividad >= ${inactiveMin} min); limite ${max}`);

    let done = 0;
    let failed = 0;
    for (const c of candidates.slice(0, max)) {
      if (args.dryRun) {
        console.log(`  [dry-run] ${c.project.id}/${c.sessionId}`);
        continue;
      }
      const r = summarizeOne(c.project, c.sessionId);
      appendJsonl(LOG_PATH, {
        trigger: 'sweep',
        project: c.project.id,
        session_id: c.sessionId,
        ok: r.ok,
        status: r.status,
        ms: r.ms,
      });
      if (r.ok) {
        done++;
        console.log(`  ok    ${c.project.id}/${c.sessionId} (${(r.ms / 1000).toFixed(0)}s)`);
      } else {
        failed++;
        console.log(`  FALLO ${c.project.id}/${c.sessionId} (status ${r.status}) -- ver logs/session-summary.jsonl`);
      }
    }
    console.log(
      args.dryRun
        ? `dry-run: ${Math.min(candidates.length, max)} se resumirian`
        : `hecho: ${done} resumidas, ${failed} fallidas`
    );
    process.exitCode = failed > 0 && done === 0 ? 1 : 0;
  } finally {
    summarizer.releaseLock(lock);
  }
}

main();
