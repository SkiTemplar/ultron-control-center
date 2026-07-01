#!/usr/bin/env node
/**
 * Stop hook — capture REJECTED / FAILED shell commands into the Run Batch queue.
 *
 * The user's rule: whenever a command is REJECTED (permission denied) OR the AI
 * itself cannot execute it, it must be LEFT in Run Batch (a persistent queue)
 * and never silently dropped, so it surfaces in the Control Center UI.
 *
 * Flow (append-to-pending-queue pattern, drained by the Tauri backend):
 *   1. Read the transcript JSONL path from the Stop hook stdin payload.
 *   2. Scan tool_use blocks whose name is Bash / PowerShell whose paired
 *      tool_result is an error (is_error:true) or a permission denial.
 *   3. Classify the reason:
 *        - "rejected"          — a permission/sandbox denial (human said no)
 *        - "ai_cannot_execute" — the tool/schema was unavailable to the agent
 *        - "failed"            — ran but errored (non-zero exit / runtime error)
 *   4. Append one line per captured command to
 *        ~/.ultron/batches/queue-pending.jsonl
 *      (drained into queue.jsonl by the Tauri backend) AND, when the command is
 *      a single coherent script, write an ASCII-pure .ps1 next to it so the user
 *      can run it with one (human) click.
 *   5. Exit 0 always — a hook must never interrupt the user's workflow.
 *
 * Conservative by design:
 *   - Only Bash / PowerShell tool_use blocks are considered.
 *   - InputValidationError / tool-schema errors are skipped (those are agent
 *     plumbing problems, not commands the user needs to re-run).
 *   - Dedup by normalised command text within the run AND against what is
 *     already queued, so re-runs don't pile up duplicates.
 *
 * Opt-out: BATCH_CAPTURE_DISABLED=1 or CLAUDE_NO_HOOKS=1.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { observe, logHookError } = require('./lib/hook-obs');
const { appendJsonl } = require('./lib/jsonl-log');
observe('batch-capture');

const HOME = os.homedir();
const BATCHES_DIR = path.join(HOME, '.ultron', 'batches');
const QUEUE_PENDING = path.join(BATCHES_DIR, 'queue-pending.jsonl');
const QUEUE_FILE = path.join(BATCHES_DIR, 'queue.jsonl');
const LOG_PATH = path.join(HOME, '.claude', 'logs', 'batch-capture.jsonl');
const MAX_TURNS = 200; // scan a generous tail; the dedup keeps it cheap
const MAX_CAPTURES = 20; // never flood the queue from a single session
const MAX_ERROR_LEN = 1500;

// ---------------------------------------------------------------------------
// Logging (best-effort, rotating via shared appendJsonl)
// ---------------------------------------------------------------------------

function safeLog(entry) {
  appendJsonl(LOG_PATH, entry);
}

// ---------------------------------------------------------------------------
// Stdin
// ---------------------------------------------------------------------------

function readStdinSync() {
  try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; }
}

// ---------------------------------------------------------------------------
// ASCII-pure sanitizer (PS 5.1 gotcha — em-dash / smart quotes break parser).
// Mirrors batches_queue::sanitize_ps1_ascii on the Rust side.
// ---------------------------------------------------------------------------

function sanitizePs1Ascii(s) {
  let out = '';
  for (const ch of String(s == null ? '' : s)) {
    if (ch === '\r' || ch === '\n' || ch === '\t') {
      out += ch;
      continue;
    }
    const code = ch.codePointAt(0);
    if (code >= 0x20 && code <= 0x7e) {
      out += ch;
    } else {
      out += ' '; // non-ASCII / control → space
    }
  }
  return out;
}

/** Build a stable, safe bare .ps1 filename from a command hash. */
function safeScriptName(command) {
  const hash = crypto.createHash('sha256').update(command).digest('hex').slice(0, 12);
  return `queued-${hash}.ps1`;
}

// ---------------------------------------------------------------------------
// Reason classification
// ---------------------------------------------------------------------------

const PERMISSION_DENIAL_PATTERNS = [
  "the user doesn't want to proceed",
  'the tool use was rejected',
  'user rejected',
  'permission denied',
  'permission to use',
  "haven't granted",
  'not allowed to use',
  'operation was rejected',
  'denied permission',
  'requested permissions',
  'user doesn’t want', // curly apostrophe variant
];

// Agent-plumbing errors that are NOT user commands to re-run — skip these.
const SKIP_PATTERNS = [
  'inputvalidationerror',
  "tool's schema was not sent",
  'was not in the discovered-tool set',
  'load the tool first',
  'string to replace not found',
  'file has not been read yet',
  'no such tool available',
];

/**
 * Returns one of "rejected" | "ai_cannot_execute" | "failed" | null.
 * null means "do not capture" (either not an error, or agent plumbing noise).
 */
function classifyReason(errorText) {
  const t = String(errorText || '').toLowerCase();

  // Plumbing / schema errors — not the user's command failing.
  for (const p of SKIP_PATTERNS) {
    if (t.includes(p)) return null;
  }

  for (const p of PERMISSION_DENIAL_PATTERNS) {
    if (t.includes(p)) return 'rejected';
  }

  // "Sandbox" / "operation not permitted" style → the AI could not execute it.
  if (
    t.includes('sandbox') ||
    t.includes('operation not permitted') ||
    t.includes('eacces') ||
    t.includes('access is denied') ||
    t.includes('acceso denegado')
  ) {
    return 'ai_cannot_execute';
  }

  // Anything else that is flagged as an error and looks like a real command
  // failure (exit code present, or non-trivial stderr) → failed.
  if (t.includes('exit code') || t.trim().length > 0) {
    return 'failed';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Transcript parse — pair tool_use (Bash/PowerShell) with its error result
// ---------------------------------------------------------------------------

function extractContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b.text === 'string') return b.text;
        if (b && typeof b.content === 'string') return b.content;
        return '';
      })
      .join('\n');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return '';
}

const SHELL_TOOLS = new Set(['bash', 'powershell']);

/**
 * Scan the transcript and return an array of:
 *   { command, reason, lastError }
 * for every shell tool_use whose result was an error/denial.
 */
function scanTranscript(jsonlPath) {
  let raw;
  try { raw = fs.readFileSync(jsonlPath, 'utf8'); } catch (_) { return []; }

  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const tail = lines.slice(-MAX_TURNS);

  // First pass: map tool_use_id -> { tool, command } for shell tools.
  const shellCalls = new Map();
  // Collect error results keyed by tool_use_id.
  const errorResults = new Map();

  for (const line of tail) {
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }
    const msg = obj.message || obj;
    const content = msg && msg.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'tool_use') {
        const toolName = String(block.name || '').toLowerCase();
        if (!SHELL_TOOLS.has(toolName)) continue;
        const input = block.input || {};
        const command = typeof input.command === 'string' ? input.command : '';
        if (command.trim()) {
          shellCalls.set(block.id, { tool: toolName, command: command.trim() });
        }
      } else if (block.type === 'tool_result' && block.is_error === true) {
        const text = extractContentText(block.content);
        if (block.tool_use_id) errorResults.set(block.tool_use_id, text);
      }
    }
  }

  const out = [];
  for (const [id, call] of shellCalls.entries()) {
    if (!errorResults.has(id)) continue; // succeeded — nothing to capture
    const errText = errorResults.get(id);
    const reason = classifyReason(errText);
    if (!reason) continue; // plumbing noise / not a real failure
    out.push({
      command: call.command,
      reason,
      lastError: String(errText || '').slice(0, MAX_ERROR_LEN),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dedup helpers
// ---------------------------------------------------------------------------

function normalizeCmd(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Read existing queue.jsonl + queue-pending.jsonl and return a Set of
 * normalised command keys already present, so we never enqueue a duplicate.
 * Keyed on the script name we derive (hash of command), which is stable.
 */
function loadExistingNames() {
  const names = new Set();
  for (const file of [QUEUE_FILE, QUEUE_PENDING]) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t);
        if (o && typeof o.name === 'string') names.add(o.name.toLowerCase());
      } catch (_) {}
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Write: .ps1 script + queue-pending line
// ---------------------------------------------------------------------------

function writeScript(filename, command) {
  const target = path.join(BATCHES_DIR, filename);
  // Idempotent: don't clobber a script the user may have edited.
  if (fs.existsSync(target)) return target;
  const header =
    '# Auto-capturado por batch-capture.js (Stop hook).\n' +
    '# Comando que la sesion Claude no pudo ejecutar (rechazado o fallido).\n' +
    '# Revisa antes de ejecutar. Requiere TU click desde Run Batch.\n';
  const body = sanitizePs1Ascii(header + command + '\n');
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, target);
  return target;
}

/**
 * Append captured commands to queue-pending.jsonl and drop a .ps1 each.
 * Best-effort: never throws into the Stop hot path.
 */
function appendPendingQueue(captures) {
  try {
    if (!captures.length) return;
    fs.mkdirSync(BATCHES_DIR, { recursive: true });

    const existing = loadExistingNames();
    const seenThisRun = new Set();
    let written = 0;

    for (const cap of captures) {
      if (written >= MAX_CAPTURES) break;
      const filename = safeScriptName(cap.command);
      const key = filename.toLowerCase();
      if (existing.has(key) || seenThisRun.has(key)) continue;
      seenThisRun.add(key);

      let scriptPath = '';
      try {
        scriptPath = writeScript(filename, cap.command);
      } catch (e) {
        safeLog({ level: 'warn', msg: 'write_script_failed', filename, error: String(e && e.message) });
        // Still enqueue the metadata even if the .ps1 write failed.
      }

      appendJsonl(QUEUE_PENDING, {
        name: filename,
        path: scriptPath,
        reason: cap.reason,
        last_error: cap.lastError,
        source: 'batch-capture',
        command_preview: normalizeCmd(cap.command).slice(0, 200),
      });
      written += 1;
    }

    if (written === 0) return;
    safeLog({ level: 'info', msg: 'pending_queue_written', count: written });
  } catch (e) {
    safeLog({ level: 'warn', msg: 'append_pending_failed', error: String(e && e.message) });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (process.env.BATCH_CAPTURE_DISABLED === '1' || process.env.CLAUDE_NO_HOOKS === '1') {
    safeLog({ level: 'info', msg: 'opt_out_via_env' });
    return;
  }

  const stdinRaw = readStdinSync();
  let stdin = {};
  try { stdin = stdinRaw ? JSON.parse(stdinRaw) : {}; } catch (_) {}

  const transcriptPath = stdin.transcript_path || stdin.transcriptPath || '';
  const sessionId =
    stdin.session_id ||
    stdin.sessionId ||
    (transcriptPath ? path.basename(transcriptPath).replace(/\.jsonl$/i, '') : '') ||
    'unknown';

  if (!transcriptPath) {
    safeLog({ level: 'info', msg: 'no_transcript_skip', sessionId });
    return;
  }

  const captures = scanTranscript(transcriptPath);
  safeLog({ level: 'info', msg: 'scanned', captured: captures.length, sessionId });

  appendPendingQueue(captures);
}

try {
  main();
} catch (err) {
  safeLog({ level: 'error', msg: 'unhandled', error: String(err && err.message) });
  logHookError('batch-capture', err);
}

process.exitCode = 0;

// Exported for unit tests (require('./batch-capture.js')).
module.exports = {
  sanitizePs1Ascii,
  safeScriptName,
  classifyReason,
  scanTranscript,
  normalizeCmd,
};
