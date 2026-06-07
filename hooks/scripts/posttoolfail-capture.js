#!/usr/bin/env node
// hooks/scripts/posttoolfail-capture.js — PostToolUse hook (iter-10, FASE 6).
//
// Runs after EVERY tool call (matcher "*"). It is CHEAP and returns immediately
// when the tool succeeded — only when the tool result clearly indicates an
// error/failure does it PROPOSE an `error_resolution` candidate via
// `ultron-memory candidate` (writer_path = MemoryService — single writer).
// The candidate captures the failing tool + error snippet so a future session
// can recall "we hit this error before". Lands pending in the governed inbox;
// never auto-promoted.
//
// FAILURE DETECTION (conservative, to avoid noise):
//   - tool_response.is_error === true / status === "error" / success === false
//   - OR a top-level `error` string on the payload
//   - OR an exit/return code field that is a non-zero number
// Anything else is treated as success -> exit 0, no sidecar call, no write.
//
// NO-OP-SAFE: any failure exits 0 silently. A failed PostToolUse hook must
// never break the harness or block tool execution.
//
// Opt-out: CLAUDE_NO_HOOKS=1 or POSTTOOLFAIL_CAPTURE_DISABLED=1.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const HOME = os.homedir();
const MAX_ERROR_CHARS = 1200;
const SIDECAR_TIMEOUT_MS = 10000;

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function findBinary() {
  const exe = process.platform === 'win32' ? 'ultron-memory.exe' : 'ultron-memory';
  if (process.env.ULTRON_MEMORY_BIN) {
    try {
      if (fs.existsSync(process.env.ULTRON_MEMORY_BIN)) return process.env.ULTRON_MEMORY_BIN;
    } catch (_) {}
  }
  const candidates = [
    path.join(HOME, '.ultron', 'bin', exe),
    path.join(HOME, '.ultron', 'control-center', 'src-tauri', 'target', 'release', exe),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {}
  }
  return null;
}

function projectName(cwd) {
  try {
    return path.basename(cwd || process.cwd()).replace(/^\.+/, '') || 'ultron';
  } catch (_) {
    return 'ultron';
  }
}

// Conservative failure detector. Returns an error string if the tool clearly
// failed, otherwise null (treated as success -> no-op).
function detectError(stdin) {
  const resp = stdin.tool_response || stdin.toolResponse || stdin.result || {};

  // Object-shaped responses with explicit error flags.
  if (resp && typeof resp === 'object') {
    if (resp.is_error === true || resp.isError === true) {
      return String(resp.error || resp.message || resp.stderr || 'tool reported is_error');
    }
    if (typeof resp.status === 'string' && resp.status.toLowerCase() === 'error') {
      return String(resp.error || resp.message || resp.stderr || 'tool status=error');
    }
    if (resp.success === false) {
      return String(resp.error || resp.message || resp.stderr || 'tool success=false');
    }
    const code = resp.exit_code != null ? resp.exit_code : resp.code;
    if (typeof code === 'number' && code !== 0) {
      return String(resp.stderr || resp.error || resp.message || `tool exit code ${code}`);
    }
  }

  // Top-level error string on the payload.
  if (typeof stdin.error === 'string' && stdin.error.trim()) {
    return stdin.error.trim();
  }

  return null;
}

function main() {
  if (process.env.CLAUDE_NO_HOOKS === '1' || process.env.POSTTOOLFAIL_CAPTURE_DISABLED === '1') {
    return;
  }

  const raw = readStdin();
  let stdin = {};
  try {
    stdin = raw ? JSON.parse(raw) : {};
  } catch (_) {
    return; // bad payload -> nothing to do
  }

  const errText = detectError(stdin);
  if (!errText) return; // SUCCESS path: exit 0, no sidecar call, no write.

  const bin = findBinary();
  if (!bin) return;

  const cwd = stdin.cwd || process.cwd();
  const project = projectName(cwd);
  const toolName = stdin.tool_name || stdin.toolName || 'unknown_tool';
  const clipped = errText.replace(/\s+/g, ' ').slice(0, MAX_ERROR_CHARS);

  const candidate = {
    type: 'error_resolution',
    scope: 'project',
    title: `Fallo de ${toolName}`,
    summary: `Error en ${toolName}: ${clipped.slice(0, 180)}`,
    content: `tool=${toolName}\nerror=${clipped}`,
    confidence: 0.6,
    source: 'posttoolfail-capture',
    capture_source: 'posttoolfail-capture',
    recommended_action: 'review',
  };

  try {
    spawnSync(bin, ['candidate', '--project', project], {
      input: JSON.stringify(candidate),
      encoding: 'utf8',
      timeout: SIDECAR_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
  } catch (_) {
    // sidecar failure must never break PostToolUse
  }
}

try {
  main();
} catch (_) {
  /* never throw */
}
process.exitCode = 0;
