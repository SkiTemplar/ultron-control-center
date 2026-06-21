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

/** Start a timer and log {hook, elapsed_ms, exit_code} on process exit. Returns t0. */
function observe(hookId) {
  const t0 = Date.now();
  try {
    process.on('exit', () => {
      appendJsonl(TIMING_LOG, {
        hook: String(hookId || 'unknown'),
        elapsed_ms: Date.now() - t0,
        exit_code: typeof process.exitCode === 'number' ? process.exitCode : 0,
      });
    });
  } catch {
    /* observability must never break a hook */
  }
  return t0;
}

/** Append a bounded error record for a hook's top-level catch (cat9.5). Never throws. */
function logHookError(hookId, err) {
  appendJsonl(ERROR_LOG, {
    hook: String(hookId || 'unknown'),
    error: String((err && err.message) || err),
    stack: err && err.stack ? String(err.stack).slice(0, 1000) : undefined,
  });
}

module.exports = { observe, logHookError };
