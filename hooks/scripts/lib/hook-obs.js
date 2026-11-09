#!/usr/bin/env node
// hooks/scripts/lib/hook-obs.js — lightweight per-hook observability (cat15.1 + cat9.5).
//
// observe(hookId): records ONE timing line {hook, elapsed_ms, exit_code} to
//   ~/.ultron/logs/hook-timing.jsonl when the process exits. A single call near
//   the top of a hook gives "every hook logs its duration" WITHOUT restructuring
//   the hook body into the hook-runner wrapper. Uses process.on('exit') (sync
//   only -> appendFileSync is sync, safe).
//
// logHookError(hookId, err): bounded error line to ~/.ultron/logs/hook-errors.jsonl
//   for the top-level catch of fail-safe hooks (cat9.5), so a silent failure
//   leaves a trace without ever breaking the session.
//
// Pure stdlib; reuses jsonl-log for bounded (rotating) appends. Fail-safe:
// observability must NEVER throw or break a hook.

'use strict';

const os = require('os');
const path = require('path');
const { appendJsonl, appendJsonlRetained } = require('./jsonl-log');

// hook-timing.jsonl conserva 8 dias por EDAD, no 1 MiB (2026-09-27): con la
// rotacion de una generacion solo guardaba entre 2 y 13 h segun la carga, y
// medir la latencia de una semana era imposible. Archivos rotados:
// logs/hook-timing.<stamp>-<pid>.jsonl (ver jsonl-log.retainedFiles).
const TIMING_RETAIN = { maxBytes: 4 * 1024 * 1024, retainDays: 8 };

// Telemetria aislada de las pruebas (hooks-7, auditoria 2026-10-23): 76 de
// las 222 lineas de hook-errors.jsonl venian de selftests y hook-timing
// registraba como "disparos" las corridas de los harnesses, y la pestana Hooks
// las ensenaba como reales. Destino, por orden:
//   1. ULTRON_HOOK_LOGS_DIR, si esta fijada (los harnesses y el medidor).
//   2. <tmp>/ultron-selftest-logs si el proceso es una prueba: ULTRON_SELFTEST=1
//      (lo fija scripts/run-selftests.mjs para cada hijo) o el script principal
//      es un `*.selftest.mjs` (selftest lanzado a mano que carga el hook).
//   3. ~/.ultron/logs (produccion).
// Se resuelve en cada escritura: un selftest puede fijar la variable despues
// de cargar el modulo.
const SELFTEST_SCRIPT = /\.selftest\.mjs$/i;

function isTestProcess(env = process.env, argv = process.argv) {
  return env.ULTRON_SELFTEST === '1' || SELFTEST_SCRIPT.test(String(argv[1] || ''));
}

function logsDir(env = process.env, argv = process.argv) {
  if (env.ULTRON_HOOK_LOGS_DIR) return env.ULTRON_HOOK_LOGS_DIR;
  if (isTestProcess(env, argv)) return path.join(os.tmpdir(), 'ultron-selftest-logs');
  return path.join(os.homedir(), '.ultron', 'logs');
}

const timingLog = () => path.join(logsDir(), 'hook-timing.jsonl');
const errorLog = () => path.join(logsDir(), 'hook-errors.jsonl');

// Campos extra que `annotate()` acumula y que se vuelcan en la MISMA linea de
// timing al salir. Vive fuera de observe() porque quien anota (el cuerpo del
// hook, a mitad de su trabajo) no tiene a mano el cierre del observador.
let extraFields = {};

/** Start a timer and log {hook, elapsed_ms, exit_code, ...annotate} on process exit. Returns t0. */
function observe(hookId) {
  const t0 = Date.now();
  try {
    process.on('exit', () => {
      appendJsonlRetained(
        timingLog(),
        {
          hook: String(hookId || 'unknown'),
          elapsed_ms: Date.now() - t0,
          exit_code: typeof process.exitCode === 'number' ? process.exitCode : 0,
          ...extraFields,
        },
        TIMING_RETAIN
      );
    });
  } catch {
    /* observability must never break a hook */
  }
  return t0;
}

/**
 * Anade campos a la linea de timing de ESTE proceso (2026-09-22).
 *
 * Regla de contenido: solo etiquetas de un conjunto CERRADO (que decidio el
 * hook, que regla caso, en que fase se fue el tiempo). NUNCA rutas, nombres de
 * fichero, prompts ni contenido — el log se comparte con la app y el repo es
 * publico.
 *
 * Nunca lanza: la observabilidad no puede romper un hook.
 */
function annotate(fields) {
  try {
    if (fields && typeof fields === 'object') extraFields = { ...extraFields, ...fields };
  } catch {
    /* observability must never break a hook */
  }
}

/** Append a bounded error record for a hook's top-level catch (cat9.5). Never throws. */
function logHookError(hookId, err) {
  appendJsonl(errorLog(), {
    hook: String(hookId || 'unknown'),
    error: String((err && err.message) || err),
    stack: err && err.stack ? String(err.stack).slice(0, 1000) : undefined,
  });
}

module.exports = { observe, annotate, logHookError, logsDir, isTestProcess };
