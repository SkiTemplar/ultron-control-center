#!/usr/bin/env node
// hooks/scripts/precompact-preserve-l0.js — PreCompact hook (iter-10, FASE 6).
//
// Before Claude Code compacts the conversation, preserve the L0 working state
// (the few facts that must survive a compaction) to a SCRATCH file:
//   ~/.ultron/.tmp/context.md
//
// writer_path = NONE. This is a scratch/working file, NOT governed memory. It
// never touches brain.db / Qdrant / the sidecar. The governed write-path is
// owned exclusively by MemoryService; this hook only refreshes a local hint
// file that SessionStart / the operator can read after a compaction.
//
// NO-OP-SAFE: any failure exits 0 silently. A failed PreCompact hook must
// never abort the compaction or break the harness.
//
// Opt-out: CLAUDE_NO_HOOKS=1 or PRECOMPACT_L0_DISABLED=1.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { observe, logHookError } = require('./lib/hook-obs');
observe('precompact-preserve-l0');

const HOME = os.homedir();
const TMP_DIR = path.join(HOME, '.ultron', '.tmp');
const CONTEXT_MD = path.join(TMP_DIR, 'context.md');
const MAX_TURNS = 30;
const MAX_FACTS = 12;

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

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
    if (text.trim()) turns.push({ role: type, text: text.trim() });
  }
  return turns;
}

// Pull out lines that read like durable working state: decisions, todos,
// bugs/fixes, file references. Heuristic, no LLM. Keeps the scratch file small.
function extractKeyFacts(turns) {
  const facts = [];
  const seen = new Set();
  const re =
    /(decid|vamos a|usaremos|implement|pendiente|todo|falta|bug|error|fix|arregl|next action|próxim|proxim|importante)/i;
  for (const t of turns) {
    const oneLine = t.text.replace(/\s+/g, ' ').trim();
    if (!re.test(oneLine)) continue;
    const clip = oneLine.slice(0, 160);
    const key = clip.slice(0, 60).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push(`- [${t.role}] ${clip}`);
    if (facts.length >= MAX_FACTS) break;
  }
  return facts;
}

function projectName(cwd) {
  try {
    return path.basename(cwd || process.cwd()).replace(/^\.+/, '') || 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

function main() {
  if (process.env.CLAUDE_NO_HOOKS === '1' || process.env.PRECOMPACT_L0_DISABLED === '1') {
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
  const trigger = stdin.trigger || stdin.compact_trigger || 'auto';

  const turns = transcriptPath ? parseTurns(transcriptPath) : [];
  const facts = extractKeyFacts(turns);

  const now = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const lines = [
    `# ULTRON L0 CONTEXT (pre-compact) · ${now}`,
    `> Preservado por precompact-preserve-l0.js (scratch, no es memoria gobernada).`,
    `> trigger: ${trigger} · project: ${projectName(cwd)} · turns_scanned: ${turns.length}`,
    '',
    '## Hechos clave preservados',
  ];
  if (facts.length) {
    lines.push(...facts);
  } else {
    lines.push('- (sin hechos clave extraíbles del tail del transcript)');
  }
  lines.push('');

  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.writeFileSync(CONTEXT_MD, lines.join('\n') + '\n', 'utf8');
  } catch (_) {
    // scratch write failure is non-fatal
  }
}

try {
  main();
} catch (e) {
  // cat9.5: deja rastro del fallo top-level sin romper el fail-safe.
  logHookError('precompact-preserve-l0', e);
}
process.exitCode = 0;
