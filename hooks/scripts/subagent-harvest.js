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
const { deriveNoteTitle } = require('./lib/note-title');
observe('subagent-harvest');

const HOME = os.homedir();
const TMP_DIR = path.join(HOME, '.ultron', '.tmp');
const LOG_PATH = process.env.SUBAGENT_HARVEST_LOG || path.join(TMP_DIR, 'subagent-harvest.jsonl');
// Grifo del harvest (ULTRON 4, Q1a, decidido 2026-09-02): solo especialistas
// nombrados, con al menos 400 caracteres y titulo derivable del contenido.
// Medido ese dia: 1.705 agent_note activos (43 % del corpus), 0 inyectados en
// 5 dias de telemetria de utilidad; 1.039 de ellos venian de wrappers
// genericos (workflow-subagent x561, unknown x268, general-purpose x210).
const MIN_CANDIDATE_CHARS = 400;
// Wrappers y agentes de sistema: su salida es un relato de ejecucion, no una
// leccion. Siguen en el scratch log (Sink 1); nunca proponen candidato.
const GENERIC_AGENTS = new Set([
  'unknown',
  'general-purpose',
  'explore',
  'plan',
  'claude',
  'fork',
  'workflow-subagent',
  'statusline-setup',
]);
const SIDECAR_TIMEOUT_MS = 12000;
// Tope de lectura del transcript del subagente (se lee solo la cola).
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

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

// Cola del transcript del subagente (`agent_transcript_path` en SubagentStop).
// Medido 2026-09-02 sobre 1.490 registros del scratch log: `chars` era 0 en el
// grueso porque el payload no traia el texto final; el transcript si lo trae
// como ultimo `assistant` con bloques `text`. Se lee solo la cola para no
// cargar transcripts de megas en un hook.
function readFileTail(file, maxBytes) {
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } catch (_) {
    return '';
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }
  }
}

function lastAssistantTextFromTranscript(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.trim()) return '';
  const tail = readFileTail(transcriptPath, TRANSCRIPT_TAIL_BYTES);
  if (!tail) return '';
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch (_) {
      continue; // la primera linea de la cola puede venir partida
    }
    if (!entry || entry.type !== 'assistant' || !entry.message) continue;
    const content = entry.message.content;
    if (typeof content === 'string' && content.trim()) return content.trim();
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text.trim())
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  return '';
}

function isGenericAgent(agent) {
  return GENERIC_AGENTS.has(String(agent || '').trim().toLowerCase());
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
  const transcriptPath = stdin.agent_transcript_path || stdin.agentTranscriptPath || '';
  let resultText = extractResultText(stdin);
  let resultFrom = resultText ? 'payload' : 'none';
  if (!resultText && transcriptPath) {
    resultText = lastAssistantTextFromTranscript(transcriptPath);
    if (resultText) resultFrom = 'transcript';
  }

  // Sink 1: scratch log (always, writer_path NONE).
  const record = {
    ts: new Date().toISOString(),
    project,
    agent,
    chars: resultText.length,
    from: resultFrom,
    preview: resultText.slice(0, 200),
  };
  if (typeof stdin.hook_event_name === 'string') record.event = stdin.hook_event_name;
  // Identidad de la tarea: desambigua wrappers genericos (workflow-subagent / general-purpose).
  if (label) record.label = label;
  // Diagnostico (mand. 10): si no hay nombre, deja las claves del payload para fijar el campo real
  // y el valor crudo de agent_type (1.410 'unknown' con la clave presente, 2026-09-02).
  if (agent === 'unknown') {
    record._keys = Object.keys(stdin).slice(0, 25);
    if ('agent_type' in stdin) record._agent_type_raw = JSON.stringify(stdin.agent_type).slice(0, 60);
  }
  appendScratchLog(record);

  // Sink 2: governed candidate (best-effort, writer_path MemoryService).
  // Grifo Q1a: wrappers genericos fuera; minimo de sustancia; titulo derivable.
  if (isGenericAgent(agent)) return;
  if (resultText.length < MIN_CANDIDATE_CHARS) return;

  // (2026-08-23, decidido por el usuario) Si no se puede derivar un titulo del
  // CONTENIDO, no hay nota que merezca entrar en el corpus. Medido ese dia:
  // 1.623 de los 3.536 items activos (46%) eran agent_note de este hook, y el
  // grueso llevaba el titulo generico repetido en masa — "Subagente
  // workflow-subagent - resultado" x561, "Subagente unknown - resultado" x269,
  // "Subagente general-purpose - resultado" x210. Un titulo generico es la
  // senal de que `deriveNoteTitle` no encontro ni una linea con sustancia: son
  // wrappers sin conclusion, y en el recall solo servian para desplazar
  // decisiones reales. El log de scratch (Sink 1) los sigue registrando: se
  // pierde la nota en brain.db, no la trazabilidad.
  const proposedTitle = deriveNoteTitle({ agent, label, resultText });
  if (proposedTitle === `Subagente ${agent} — resultado`) return;

  const candidate = {
    type: 'agent_note',
    scope: 'agent',
    // Titulo derivado del contenido real (sprint recall 2026-07-22): el titulo
    // generico "Subagente X — resultado" hacia indistinguibles 1181 notas en el
    // top-k. deriveNoteTitle redacta secretos y cae al titulo viejo si no hay
    // contenido usable; el write-path Rust vuelve a redactar proposed_title.
    title: proposedTitle,
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

  // Seam de test: con SUBAGENT_HARVEST_CANDIDATE_OUT el candidato se escribe a
  // ese fichero en vez de ir al sidecar (el selftest no debe ensuciar el inbox).
  if (process.env.SUBAGENT_HARVEST_CANDIDATE_OUT) {
    appendJsonl(process.env.SUBAGENT_HARVEST_CANDIDATE_OUT, { project, candidate });
    return;
  }
  const bin = findBinary();
  if (!bin) return;

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
