#!/usr/bin/env node
/**
 * SessionStart hook — auto-link the new Claude Code session to the most
 * recent in_progress Workday tracked by the Control Center.
 *
 * Strategy:
 *   1. Pull session_id from the hook stdin payload + cwd from process.cwd().
 *   2. Try the Tauri CLI helper if it exists (the Control Center is running).
 *      Invokes `workday_auto_link_session` which appends a pending entry and
 *      drains it immediately.
 *   3. If the Control Center is offline, write a JSONL entry to
 *      ~/.ultron/cockpit/workdays/_pending-links.jsonl. The backend drains
 *      that file at startup.
 *
 * Always exits 0 with an empty additionalContext payload so it can be chained
 * with the existing session-start-override.js — both hooks fire under
 * SessionStart and must not block startup.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { observe } = require('./lib/hook-obs');
observe('workday-session-linker');

const HOME = os.homedir();
const LOG_PATH = path.join(HOME, '.claude', 'logs', 'workday-session-linker.jsonl');
const PENDING_PATH = path.join(
  HOME,
  '.ultron',
  'cockpit',
  'workdays',
  '_pending-links.jsonl'
);

// Rotate the log when it crosses 2 MB so a long-running install doesn't
// fill the disk silently (KIRKARDO 15 — log rotation gap). Keep one
// generation .1 — older history is rarely useful for debugging hook misfires.
const MAX_LOG_BYTES = 2 * 1024 * 1024;

function rotateLogIfNeeded() {
  try {
    const st = fs.statSync(LOG_PATH);
    if (st.size < MAX_LOG_BYTES) return;
    const rotated = LOG_PATH + '.1';
    try { fs.unlinkSync(rotated); } catch (_) {}
    fs.renameSync(LOG_PATH, rotated);
  } catch (_) {
    // file missing or another rotation in flight — both safe.
  }
}

function safeLog(entry) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    rotateLogIfNeeded();
    fs.appendFileSync(
      LOG_PATH,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n',
      'utf8'
    );
  } catch (_) {
    // never throw from a hook
  }
}

// Whitelist-based sanitiser for values that flow into the Tauri CLI and
// the pending-links JSONL (KIRKARDO 15). Claude Code controls these
// fields today but a sanitiser at the boundary is the right place to
// catch anything weird (control chars, path traversal, NUL bytes).
function sanitizePathLike(value, maxLen) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_\-./:\\ ]/g, '_')
    .slice(0, maxLen || 512);
}

function emitPayload(additionalContext) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: additionalContext || '',
    },
  };
  try {
    process.stdout.write(JSON.stringify(payload));
  } catch (_) {
    // ignored
  }
}

function emitEmptyPayload() {
  emitPayload('');
}

// KIRKARDO 8 hardening: strip homoglyphs and non-printable Unicode by
// normalising to NFD then dropping anything outside printable ASCII. Closes
// the cyrillic/IPA lookalike vector the previous narrower filter missed.
// Bound per-line to 120 chars so a single oversized subject cannot push
// the global cap into the middle of a bullet.
function sanitizeCommitSubject(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function gatherRecentCommits(cwd) {
  if (!cwd) return '';
  try {
    const raw = execFileSync(
      'git',
      [
        '-C',
        cwd,
        'log',
        '--since=3.days.ago',
        '--pretty=format:%h %ad %s',
        '--date=short',
        '-n',
        '20',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, encoding: 'utf8' }
    );
    const lines = String(raw)
      .split(/\r?\n/)
      .map((l) => sanitizeCommitSubject(l))
      .filter(Boolean);
    if (lines.length === 0) return '';
    const head = lines.slice(0, 12);
    // KIRKARDO 8 V2: wrap in XML tags so Claude treats this as structured
    // external data (Anthropic guidance pattern) rather than markdown
    // narrative it could mistake for instructions.
    let body = '<untrusted_external_data source="git_log" trust="zero">\n';
    body += '### Recent commits (last 3 days)\n\n';
    for (const l of head) body += '- ' + l + '\n';
    if (lines.length > head.length) {
      body += '- ... (+' + (lines.length - head.length) + ' more)\n';
    }
    body += '</untrusted_external_data>\n';
    return body.slice(0, 2000);
  } catch (_) {
    return '';
  }
}

function readStdinSafe() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function extractSessionId(stdinPayload) {
  // Claude Code hooks supply `transcript_path` (full path to the live JSONL).
  // session_id sits in the filename: <id>.jsonl. We try a few field shapes.
  const direct = stdinPayload.session_id || stdinPayload.sessionId;
  if (direct) return String(direct);
  const tp = stdinPayload.transcript_path || stdinPayload.transcriptPath;
  if (tp) {
    return path.basename(String(tp)).replace(/\.jsonl$/i, '');
  }
  return '';
}

function appendPending(sessionId, cwd) {
  fs.mkdirSync(path.dirname(PENDING_PATH), { recursive: true });
  const line =
    JSON.stringify({
      session_id: sanitizePathLike(sessionId, 128),
      cwd: sanitizePathLike(cwd, 512),
      timestamp: new Date().toISOString(),
    }) + '\n';
  fs.appendFileSync(PENDING_PATH, line, 'utf8');
}

function tryTauriCli(sessionId, cwd) {
  // Optional CLI helper at ~/.ultron/control-center/scripts/ultron-cli.cmd
  // (or ultron-cli on POSIX). Falls back to the pending file when missing.
  // Sanitise both values at the boundary (KIRKARDO 15) so a malformed
  // sessionId/cwd cannot inject anything into the CLI invocation.
  const safeSession = sanitizePathLike(sessionId, 128);
  const safeCwd = sanitizePathLike(cwd || '', 512);
  const candidates = [
    path.join(HOME, '.ultron', 'control-center', 'scripts', 'ultron-cli.cmd'),
    path.join(HOME, '.ultron', 'control-center', 'scripts', 'ultron-cli'),
  ];
  for (const c of candidates) {
    try {
      if (!fs.statSync(c).isFile()) continue;
      execFileSync(
        c,
        ['workday_auto_link_session', safeSession, safeCwd],
        { stdio: 'ignore', timeout: 4000 }
      );
      return true;
    } catch (_) {
      // try next candidate
    }
  }
  return false;
}

function main() {
  // Opt-out env var (KIRKARDO 15). Lets the user disable the linker
  // without editing settings.json. Both names accepted so it composes
  // with any future CLAUDE_NO_HOOKS=1 global Anthropic convention.
  if (process.env.WORKDAY_LINKER_DISABLED === '1' || process.env.CLAUDE_NO_HOOKS === '1') {
    safeLog({ level: 'info', msg: 'opt_out_via_env' });
    return emitEmptyPayload();
  }
  const stdinRaw = readStdinSafe();
  let stdinPayload = {};
  try {
    stdinPayload = stdinRaw ? JSON.parse(stdinRaw) : {};
  } catch (_) {
    stdinPayload = {};
  }

  const source = String(stdinPayload.source || '').trim().toLowerCase();
  // Skip resume/clear/compact — they re-enter an existing session.
  if (source && source !== 'startup') {
    safeLog({ level: 'info', msg: 'skip_non_startup', source });
    return emitEmptyPayload();
  }

  const sessionId = extractSessionId(stdinPayload);
  const cwd = process.cwd();
  if (!sessionId) {
    safeLog({ level: 'info', msg: 'no_session_id', cwd });
    return emitEmptyPayload();
  }

  // Gather git-commit context BEFORE either branch — the additionalContext
  // is independent of the link result and runs in parallel-style. This is
  // the cheapest way to give the new session a "what happened recently"
  // snapshot without waiting on mem0/RAG.
  const commitsMd = gatherRecentCommits(cwd);

  // 1. Try the live Tauri CLI.
  const direct = tryTauriCli(sessionId, cwd);
  if (direct) {
    safeLog({ level: 'info', msg: 'linked_via_cli', sessionId, cwd, commitsAttached: Boolean(commitsMd) });
    return emitPayload(commitsMd);
  }

  // 2. Fall back to the pending-links file.
  try {
    appendPending(sessionId, cwd);
    safeLog({ level: 'info', msg: 'queued_pending', sessionId, cwd, file: PENDING_PATH, commitsAttached: Boolean(commitsMd) });
  } catch (e) {
    safeLog({ level: 'error', msg: 'append_pending_failed', error: String(e && e.message) });
  }

  emitPayload(commitsMd);
}

try {
  main();
} catch (err) {
  safeLog({ level: 'error', msg: 'unhandled', error: String(err && err.message) });
  emitEmptyPayload();
}

process.exitCode = 0;
