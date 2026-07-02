#!/usr/bin/env node
// hooks/scripts/session-end-summary.js — SessionEnd hook (iter-10, FASE 6).
//
// On session close, compose a SHORT rule-based summary of the transcript tail
// and PROPOSE it as a governed candidate via the `ultron-memory candidate`
// sidecar (writer_path = MemoryService — the sidecar is the single writer of
// brain.db; this hook NEVER writes memory directly). Lands as a `pending`
// session_summary candidate in the governed inbox for human approval; it is
// never auto-promoted.
//
// NO-OP-SAFE: any failure (no transcript, missing binary, sidecar error, bad
// JSON) exits 0 silently and writes nothing. A hook that fails must never
// break the harness.
//
// Opt-out: CLAUDE_NO_HOOKS=1 or SESSION_END_SUMMARY_DISABLED=1.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { observe, logHookError } = require('./lib/hook-obs');
observe('session-end-summary');

const HOME = os.homedir();
const MAX_TURNS = 40;
const MAX_SUMMARY_CHARS = 600;
const SIDECAR_TIMEOUT_MS = 12000; // candidate path can take ~2s+ (contradiction judge)

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

// Locate the ultron-memory sidecar (single memory writer). Mirrors
// lib/ultron-memory-cli.js resolution order. Returns null if not found.
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

function projectIdFromCwd(cwd) {
  try {
    const base = path.basename(cwd || process.cwd());
    return base.replace(/^\.+/, '') || null;
  } catch (_) {
    return null;
  }
}

// Extract last MAX_TURNS user/assistant text turns from a JSONL transcript.
function parseTurns(jsonlPath) {
  let raw;
  try {
    raw = fs.readFileSync(jsonlPath, 'utf8');
  } catch (_) {
    return [];
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const tail = lines.slice(-MAX_TURNS);
  const turns = [];
  for (const line of tail) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const type = obj.type || '';
    if (type !== 'user' && type !== 'assistant') continue;
    const msg = obj.message || obj;
    const content = msg.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === 'text' && block.text) {
          text = block.text;
          break;
        }
      }
    }
    if (text.trim()) turns.push({ role: type, text: text.trim().slice(0, 400) });
  }
  return turns;
}

// Cheap rule-based summary: first user ask + count of turns. No LLM, no egress.
function buildSummary(turns) {
  const firstUser = turns.find((t) => t.role === 'user');
  const head = firstUser ? firstUser.text : '';
  const oneLine = head.replace(/\s+/g, ' ').slice(0, 200);
  const summary = `Sesión cerrada (${turns.length} turnos). Tema inicial: ${oneLine}`;
  return summary.slice(0, MAX_SUMMARY_CHARS);
}

function main() {
  if (
    process.env.CLAUDE_NO_HOOKS === '1' ||
    process.env.SESSION_END_SUMMARY_DISABLED === '1'
  ) {
    return;
  }

  const raw = readStdin();
  let stdin = {};
  try {
    stdin = raw ? JSON.parse(raw) : {};
  } catch (_) {
    stdin = {};
  }

  const transcriptPath = stdin.transcript_path || stdin.transcriptPath || '';
  const cwd = stdin.cwd || process.cwd();
  if (!transcriptPath) return; // nothing to summarise

  const turns = parseTurns(transcriptPath);
  if (turns.length === 0) return;

  const bin = findBinary();
  if (!bin) return; // single-writer absent -> propose nothing (fail-safe)

  const project = projectIdFromCwd(cwd) || 'ultron';
  const sessionId =
    stdin.session_id ||
    stdin.sessionId ||
    (transcriptPath ? path.basename(transcriptPath).replace(/\.jsonl$/i, '') : 'unknown');

  const candidate = {
    type: 'session_summary',
    scope: 'session',
    title: `Resumen SessionEnd ${new Date().toISOString().slice(0, 10)}`,
    summary: buildSummary(turns),
    content: `session_id=${sessionId}`,
    confidence: 0.6,
    source: 'session-end-summary',
    capture_source: 'session-end-summary',
    recommended_action: 'review',
    // Provenance episódica: campo estructurado (el content de arriba es informativo;
    // este es el que emit.rs mapea a source_session_id).
    session_id: sessionId === 'unknown' ? null : sessionId,
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
    // sidecar failure must never break SessionEnd
  }
}

try {
  main();
} catch (e) {
  // cat9.5: deja rastro del fallo top-level sin romper el fail-safe.
  logHookError('session-end-summary', e);
}
process.exitCode = 0;
