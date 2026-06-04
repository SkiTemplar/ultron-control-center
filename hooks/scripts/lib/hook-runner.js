#!/usr/bin/env node
// hooks/scripts/lib/hook-runner.js
//
// Common wrapper for every ULTRON Claude Code hook (OLA I). Responsibilities:
//   1. Load the canonical manifest (~/.ultron/hooks/manifest.json) and resolve
//      the hook entry by id.
//   2. Apply a CIRCUIT-BREAKER (cockpit/hooks/breaker-state.json): after N
//      failures inside a rolling window the breaker OPENS and the hook is
//      skipped (no_op) until a cooldown elapses; one trial probe half-opens it.
//   3. Run the hook body inside a hard try/catch so a crashing hook NEVER
//      breaks the Claude Code session (always exit 0).
//   4. Append a structured JSONL log line per invocation to
//      cockpit/hooks/logs/<id>.jsonl.
//
// Pure Node stdlib — NO external dependencies. Every filesystem touch is
// fail-safe: if state/log writes fail the hook still runs (fail-open on
// bookkeeping, fail-safe on the hook body).
//
// SoT note: hooks here only PROPOSE candidates. They MUST NOT write canonical
// memory directly. The single writer of brain.db is MemoryService (the Rust
// `ultron-memory` sidecar). This runner enforces nothing about that — it is a
// reliability wrapper — but it refuses to mark `writes_memory` hooks as healthy
// if their manifest writer_path is a forbidden direct store.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// --- Paths (all derived from homedir; nothing hardcoded beyond layout) ------

const HOME = os.homedir();
const HOOKS_ROOT = path.join(HOME, '.ultron', 'hooks');
const MANIFEST_PATH = path.join(HOOKS_ROOT, 'manifest.json');
const COCKPIT_HOOKS = path.join(HOME, '.ultron', 'cockpit', 'hooks');
const BREAKER_PATH = path.join(COCKPIT_HOOKS, 'breaker-state.json');
const LOGS_DIR = path.join(COCKPIT_HOOKS, 'logs');

// --- Circuit-breaker tuning (named constants, no magic numbers) -------------

const FAILURE_THRESHOLD = 5; // failures inside the window -> OPEN
const FAILURE_WINDOW_MS = 10 * 60 * 1000; // 10 min rolling window
const COOLDOWN_MS = 15 * 60 * 1000; // OPEN stays open this long, then half-open
const MAX_RECENT_FAILURES = 50; // cap stored timestamps per hook
const WRITER_PATHS_FORBIDDEN = ['qdrant_direct', 'mem0'];

// --- Tiny fail-safe fs helpers ----------------------------------------------

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function readJsonSafe(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonSafe(file, obj) {
  try {
    ensureDir(path.dirname(file));
    // Atomic-ish: write temp then rename, so a concurrent reader never sees a
    // half-written file. Falls back to direct write if rename is unavailable.
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.writeFileSync(file, JSON.stringify(obj, null, 2));
      return true;
    } catch {
      return false;
    }
  }
}

function appendLog(id, record) {
  try {
    ensureDir(LOGS_DIR);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
    fs.appendFileSync(path.join(LOGS_DIR, `${String(id).replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`), line);
  } catch {
    /* logging must never throw */
  }
}

// --- Manifest ----------------------------------------------------------------

function loadManifest() {
  return readJsonSafe(MANIFEST_PATH, null);
}

function findHook(manifest, id) {
  if (!manifest || !Array.isArray(manifest.hooks)) return null;
  return manifest.hooks.find((h) => h && h.id === id) || null;
}

// --- Circuit-breaker ---------------------------------------------------------
//
// breaker-state.json shape:
// {
//   "<hookId>": {
//     "state": "closed" | "open" | "half-open",
//     "recent_failures": [<epochMs>, ...],
//     "opened_at": <epochMs|null>,
//     "consecutive_successes": <int>,
//     "last_outcome": "ok" | "fail" | "skipped",
//     "updated_at": "<iso>"
//   }, ...
// }

function defaultEntry() {
  return {
    state: 'closed',
    recent_failures: [],
    opened_at: null,
    consecutive_successes: 0,
    last_outcome: null,
    updated_at: null,
  };
}

function getEntry(state, id) {
  const e = state[id];
  if (!e || typeof e !== 'object') return defaultEntry();
  return {
    state: e.state || 'closed',
    recent_failures: Array.isArray(e.recent_failures) ? e.recent_failures : [],
    opened_at: typeof e.opened_at === 'number' ? e.opened_at : null,
    consecutive_successes: Number.isInteger(e.consecutive_successes) ? e.consecutive_successes : 0,
    last_outcome: e.last_outcome || null,
    updated_at: e.updated_at || null,
  };
}

// Returns { allowed: bool, reason: string, entry, state } — does NOT persist.
function evaluateBreaker(id, now) {
  const state = readJsonSafe(BREAKER_PATH, {}) || {};
  const entry = getEntry(state, id);

  // Prune failures outside the rolling window.
  entry.recent_failures = entry.recent_failures.filter((t) => typeof t === 'number' && now - t <= FAILURE_WINDOW_MS);

  if (entry.state === 'open') {
    if (entry.opened_at != null && now - entry.opened_at >= COOLDOWN_MS) {
      // Cooldown elapsed -> half-open: allow ONE trial probe.
      entry.state = 'half-open';
      return { allowed: true, reason: 'half-open-probe', entry, state };
    }
    return { allowed: false, reason: 'breaker-open', entry, state };
  }

  // closed or half-open -> allow.
  return { allowed: true, reason: entry.state === 'half-open' ? 'half-open-probe' : 'closed', entry, state };
}

// Records an outcome and transitions the breaker. Persists state. outcome is
// one of "ok" | "fail" | "skipped". Returns the updated entry.
function recordOutcome(id, outcome, now) {
  const state = readJsonSafe(BREAKER_PATH, {}) || {};
  const entry = getEntry(state, id);
  entry.recent_failures = entry.recent_failures.filter((t) => typeof t === 'number' && now - t <= FAILURE_WINDOW_MS);

  if (outcome === 'skipped') {
    entry.last_outcome = 'skipped';
  } else if (outcome === 'ok') {
    entry.consecutive_successes += 1;
    entry.last_outcome = 'ok';
    // Any success on a half-open or closed breaker closes it and clears failures.
    if (entry.state === 'half-open' || entry.state === 'open') {
      entry.state = 'closed';
      entry.opened_at = null;
      entry.recent_failures = [];
    }
  } else {
    // fail
    entry.consecutive_successes = 0;
    entry.last_outcome = 'fail';
    entry.recent_failures.push(now);
    if (entry.recent_failures.length > MAX_RECENT_FAILURES) {
      entry.recent_failures = entry.recent_failures.slice(-MAX_RECENT_FAILURES);
    }
    if (entry.state === 'half-open') {
      // Probe failed -> re-open and restart cooldown.
      entry.state = 'open';
      entry.opened_at = now;
    } else if (entry.recent_failures.length >= FAILURE_THRESHOLD) {
      entry.state = 'open';
      entry.opened_at = now;
    }
  }

  entry.updated_at = new Date(now).toISOString();
  state[id] = entry;
  writeJsonSafe(BREAKER_PATH, state);
  return entry;
}

// --- Public API --------------------------------------------------------------

/**
 * Run a hook body under the circuit-breaker + fail-safe wrapper.
 *
 * @param {string} id            Manifest hook id (e.g. "memory-orchestrate").
 * @param {Function} body        async/sync fn that performs the hook work. It
 *                               receives { entry, manifestHook } and may return
 *                               a value (ignored). Throwing => "fail".
 * @param {object} [opts]
 * @param {Function} [opts.onSkip]  called when the breaker is OPEN (skipped).
 *                                  Use it to emit the hook's neutral/empty
 *                                  payload (e.g. empty additionalContext).
 * @returns {Promise<{outcome:string, allowed:boolean, reason:string}>}
 *
 * NEVER throws. Always resolves. Caller should `process.exitCode = 0`.
 */
async function runHook(id, body, opts) {
  const options = opts || {};
  const started = Date.now();
  const manifest = loadManifest();
  const manifestHook = findHook(manifest, id);

  // Guardrail: a hook flagged writes_memory with a forbidden direct writer_path
  // is a contract violation. We do not run it (fail-closed) and log it, but we
  // still never break the session.
  if (
    manifestHook &&
    manifestHook.writes_memory === true &&
    WRITER_PATHS_FORBIDDEN.includes(String(manifestHook.writer_path))
  ) {
    appendLog(id, {
      event: 'blocked',
      reason: 'forbidden-writer-path',
      writer_path: manifestHook.writer_path,
      duration_ms: Date.now() - started,
    });
    if (typeof options.onSkip === 'function') {
      try {
        options.onSkip('forbidden-writer-path');
      } catch {
        /* ignore */
      }
    }
    return { outcome: 'skipped', allowed: false, reason: 'forbidden-writer-path' };
  }

  const now = Date.now();
  const decision = evaluateBreaker(id, now);

  if (!decision.allowed) {
    recordOutcome(id, 'skipped', now);
    appendLog(id, {
      event: 'skipped',
      reason: decision.reason,
      breaker_state: 'open',
      duration_ms: Date.now() - started,
    });
    if (typeof options.onSkip === 'function') {
      try {
        options.onSkip(decision.reason);
      } catch {
        /* ignore */
      }
    }
    return { outcome: 'skipped', allowed: false, reason: decision.reason };
  }

  try {
    await body({ entry: decision.entry, manifestHook });
    recordOutcome(id, 'ok', Date.now());
    appendLog(id, {
      event: 'ok',
      reason: decision.reason,
      duration_ms: Date.now() - started,
    });
    return { outcome: 'ok', allowed: true, reason: decision.reason };
  } catch (err) {
    const entry = recordOutcome(id, 'fail', Date.now());
    appendLog(id, {
      event: 'fail',
      reason: decision.reason,
      error: String((err && err.message) || err),
      breaker_state: entry.state,
      recent_failures: entry.recent_failures.length,
      duration_ms: Date.now() - started,
    });
    // Fail-safe: a crashing hook must not break the session. Give the caller a
    // chance to emit its neutral payload.
    if (typeof options.onSkip === 'function') {
      try {
        options.onSkip('hook-threw');
      } catch {
        /* ignore */
      }
    }
    return { outcome: 'fail', allowed: true, reason: decision.reason };
  }
}

/** Read-only snapshot of the breaker state (for diagnostics / UI). */
function inspect() {
  return {
    manifest_path: MANIFEST_PATH,
    breaker_path: BREAKER_PATH,
    logs_dir: LOGS_DIR,
    state: readJsonSafe(BREAKER_PATH, {}) || {},
    config: {
      FAILURE_THRESHOLD,
      FAILURE_WINDOW_MS,
      COOLDOWN_MS,
    },
  };
}

module.exports = {
  runHook,
  inspect,
  loadManifest,
  findHook,
  // Exposed for unit tests / introspection:
  evaluateBreaker,
  recordOutcome,
  MANIFEST_PATH,
  BREAKER_PATH,
  LOGS_DIR,
};
