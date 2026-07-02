#!/usr/bin/env node
// hooks/scripts/subagent-harvest.js — SubagentStop hook (iter-10, FASE 6).
//
// When a subagent (Task tool) finishes, harvest a short record of its result.
// TWO sinks, both fail-safe:
//   1. Always: append a one-line JSON record to the scratch log
//      ~/.ultron/.tmp/subagent-harvest.jsonl  (writer_path = NONE, scratch).
//   2. Best-effort: if the subagent produced a non-trivial text result AND the
//      sidecar is available, PROPOSE an `agent_note` candidate via
//      `ultron-memory candidate` (writer_path = MemoryService — single writer).
//      Lands as a pending candidate in the governed inbox; never auto-promoted.
//
// NO-OP-SAFE: any failure exits 0 silently. A failed SubagentStop hook must
// never break the harness.
//
// Opt-out: CLAUDE_NO_HOOKS=1 or SUBAGENT_HARVEST_DISABLED=1.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { observe, logHookError } = require('./lib/hook-obs');
const { appendJsonl } = require('./lib/jsonl-log');
observe('subagent-harvest');

const HOME = os.homedir();
const TMP_DIR = path.join(HOME, '.ultron', '.tmp');
const LOG_PATH = process.env.SUBAGENT_HARVEST_LOG || path.join(TMP_DIR, 'subagent-harvest.jsonl');
const MIN_CANDIDATE_CHARS = 80; // skip trivial / empty results
const SIDECAR_TIMEOUT_MS = 12000;

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

// 0.3: resuelve el nombre del agente tolerando variantes de shape del payload
// SubagentStop (snake/camel, anidado). Antes solo miraba agent_type/subagent_type/
// agent -> 239 'unknown' historicos.
function resolveAgent(stdin) {
  const direct =
    stdin.agent_type || stdin.subagent_type || stdin.agentType || stdin.subagentType ||
    stdin.agent || stdin.agent_name ||
    (stdin.task && (stdin.task.subagent_type || stdin.task.agent_type)) ||
    (stdin.tool_input && (stdin.tool_input.subagent_type || stdin.tool_input.agent_type));
  const name = typeof direct === 'string' ? direct.trim() : '';
  return name || 'unknown';
}

// 0.3: identidad de la TAREA (label/description). Util cuando el agente es un wrapper
// generico (workflow-subagent / general-purpose) y el especialista real esta aqui.
function resolveLabel(stdin) {
  const src =
    stdin.label || stdin.description ||
    (stdin.task && (stdin.task.label || stdin.task.description)) ||
    (stdin.tool_input && stdin.tool_input.description) ||
    stdin.name;
  return typeof src === 'string' ? src.trim().slice(0, 120) : '';
}

// Pull a text result out of the SubagentStop payload, tolerant of shape drift.
function extractResultText(stdin) {
  const candidates = [
    stdin.result,
    stdin.response,
    stdin.output,
    stdin.last_message,
    stdin.subagent_result,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  // Some payloads nest the final assistant message.
  const msg = stdin.message || stdin.last_assistant_message;
  if (msg) {
    const content = msg.content || msg;
    if (typeof content === 'string' && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === 'text' && block.text) return block.text.trim();
      }
    }
  }
  return '';
}

function appendScratchLog(record) {
  appendJsonl(LOG_PATH, record);
}

function main() {
  if (process.env.CLAUDE_NO_HOOKS === '1' || process.env.SUBAGENT_HARVEST_DISABLED === '1') {
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
  const project = projectName(cwd);
  const agent = resolveAgent(stdin);
  const label = resolveLabel(stdin);
  const resultText = extractResultText(stdin);

  // Sink 1: scratch log (always, writer_path NONE).
  const record = {
    ts: new Date().toISOString(),
    project,
    agent,
    chars: resultText.length,
    preview: resultText.slice(0, 200),
  };
  // Identidad de la tarea: desambigua wrappers genericos (workflow-subagent / general-purpose).
  if (label) record.label = label;
  // Diagnostico (mand. 10): si no hay nombre, deja las claves del payload para fijar el campo real.
  if (agent === 'unknown') record._keys = Object.keys(stdin).slice(0, 25);
  appendScratchLog(record);

  // Sink 2: governed candidate (best-effort, writer_path MemoryService).
  if (resultText.length < MIN_CANDIDATE_CHARS) return;
  const bin = findBinary();
  if (!bin) return;

  const candidate = {
    type: 'agent_note',
    scope: 'agent',
    title: `Subagente ${agent} — resultado`,
    summary: resultText.replace(/\s+/g, ' ').slice(0, 220),
    content: resultText.slice(0, 2000),
    confidence: 0.6,
    source: 'subagent-harvest',
    capture_source: 'subagent-harvest',
    recommended_action: 'review',
    // Provenance episódica: SubagentStop trae el session_id de la sesión PADRE
    // (donde vive el transcript que citará `provenance --id`).
    session_id: stdin.session_id || stdin.sessionId || null,
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
    // sidecar failure must never break SubagentStop
  }
}

try {
  main();
} catch (e) {
  // cat9.5: deja rastro del fallo top-level sin romper el fail-safe.
  logHookError('subagent-harvest', e);
}
process.exitCode = 0;
