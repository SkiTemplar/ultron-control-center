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
const { appendJsonl } = require('./jsonl-log');

const LOGS_DIR = path.join(os.homedir(), '.ultron', 'logs');
const TIMING_LOG = path.join(LOGS_DIR, 'hook-timing.jsonl');
const ERROR_LOG = path.join(LOGS_DIR, 'hook-errors.jsonl');

// Campos extra que `annotate()` acumula y que se vuelcan en la MISMA linea de
// timing al salir. Vive fuera de observe() porque quien anota (el cuerpo del
// hook, a mitad de su trabajo) no tiene a mano el cierre del observador.
let extraFields = {};

/** Start a timer and log {hook, elapsed_ms, exit_code, ...annotate} on process exit. Returns t0. */
function observe(hookId) {
  const t0 = Date.now();
  try {
    process.on('exit', () => {
      appendJsonl(TIMING_LOG, {
        hook: String(hookId || 'unknown'),
        elapsed_ms: Date.now() - t0,
        exit_code: typeof process.exitCode === 'number' ? process.exitCode : 0,
        ...extraFields,
      });
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
  appendJsonl(ERROR_LOG, {
    hook: String(hookId || 'unknown'),
    error: String((err && err.message) || err),
    stack: err && err.stack ? String(err.stack).slice(0, 1000) : undefined,
  });
}

module.exports = { observe, annotate, logHookError };
