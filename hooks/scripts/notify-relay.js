#!/usr/bin/env node
// hooks/scripts/notify-relay.js — Notification hook (iter-10, FASE 6).
//
// Relay each Claude Code notification (idle prompt, permission request, etc.)
// to a rolling scratch log so the operator has a single place to review what
// the session has been asking for:
//   ~/.ultron/.tmp/notifications.log
//
// writer_path = NONE. Pure local append to a scratch log; never touches
// brain.db / Qdrant / the sidecar. No governed memory is written.
//
// NO-OP-SAFE: any failure exits 0 silently. A failed Notification hook must
// never break the harness.
//
// Opt-out: CLAUDE_NO_HOOKS=1 or NOTIFY_RELAY_DISABLED=1.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { observe, logHookError } = require('./lib/hook-obs');
observe('notify-relay');

const HOME = os.homedir();
const TMP_DIR = path.join(HOME, '.ultron', '.tmp');
const LOG_PATH = path.join(TMP_DIR, 'notifications.log');
const LOG_MAX_BYTES = 1 * 1024 * 1024;

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function projectName(cwd) {
  try {
    return path.basename(cwd || process.cwd()).replace(/^\.+/, '') || 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

function rotateLogIfNeeded() {
  try {
    const st = fs.statSync(LOG_PATH);
    if (st.size < LOG_MAX_BYTES) return;
    try {
      fs.unlinkSync(LOG_PATH + '.1');
    } catch (_) {}
    fs.renameSync(LOG_PATH, LOG_PATH + '.1');
  } catch (_) {}
}

function main() {
  if (process.env.CLAUDE_NO_HOOKS === '1' || process.env.NOTIFY_RELAY_DISABLED === '1') {
    return;
  }

  const raw = readStdin();
  let stdin = {};
  try {
    stdin = raw ? JSON.parse(raw) : {};
  } catch (_) {
    stdin = {};
  }

  const cwd = stdin.cwd || process.cwd();
  const message = stdin.message || stdin.title || stdin.notification || '(sin mensaje)';
  const ts = new Date().toISOString();
  const line = `[${ts}] [${projectName(cwd)}] ${String(message).replace(/\s+/g, ' ').slice(0, 300)}`;

  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    rotateLogIfNeeded();
    fs.appendFileSync(LOG_PATH, line + '\n', 'utf8');
  } catch (_) {
    // scratch append failure is non-fatal
  }
}

try {
  main();
} catch (e) {
  // cat9.5: deja rastro del fallo top-level sin romper el fail-safe.
  logHookError('notify-relay', e);
}
process.exitCode = 0;
