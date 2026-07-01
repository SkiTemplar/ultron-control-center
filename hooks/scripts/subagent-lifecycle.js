#!/usr/bin/env node
// hooks/scripts/subagent-lifecycle.js — SubagentStart + SubagentStop (masterplan 3.9).
//
// Registra el CICLO DE VIDA de cada subagente (Task tool) en un log scratch
//   ~/.ultron/.tmp/subagent-lifecycle.jsonl   (writer_path = NONE, scratch)
// con una linea por transicion: {ts, event:"start"|"stop", agent_id, agent, label}.
//
// Se cablea al MISMO script en dos eventos:
//   - SubagentStart  -> event:"start"  (el subagente ARRANCA; aun no hay resultado)
//   - SubagentStop   -> event:"stop"   (termina; corre junto a subagent-harvest.js)
//
// El backend (live_session_feed) reduce por agent_id: un agent_id cuyo ULTIMO
// evento es "start" = subagente EN VUELO (in-flight) -> lo pinta el Monitor. Es el
// gemelo de subagent-harvest.js (resultados), que queda INTACTO.
//
// NO-OP-SAFE: cualquier fallo sale 0 en silencio. Un hook roto no debe romper el
// harness. Opt-out: CLAUDE_NO_HOOKS=1 o SUBAGENT_LIFECYCLE_DISABLED=1.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { observe, logHookError } = require('./lib/hook-obs');
const { appendJsonl } = require('./lib/jsonl-log');
observe('subagent-lifecycle');

const LIFECYCLE_LOG =
  process.env.SUBAGENT_LIFECYCLE_LOG ||
  path.join(os.homedir(), '.ultron', '.tmp', 'subagent-lifecycle.jsonl');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

// start vs stop: primero por hook_event_name (fiable, lo trae el payload); si no,
// por shape (un stop trae el resultado / transcript del subagente).
function resolveEvent(s) {
  const ev = typeof s.hook_event_name === 'string' ? s.hook_event_name : '';
  if (ev === 'SubagentStart') return 'start';
  if (ev === 'SubagentStop') return 'stop';
  if (s.last_assistant_message || s.result || s.response || s.agent_transcript_path) return 'stop';
  return 'start';
}

// Mismo resolvedor tolerante que subagent-harvest.js (snake/camel/anidado).
function resolveAgent(s) {
  const d =
    s.agent_type || s.subagent_type || s.agentType || s.subagentType ||
    s.agent || s.agent_name ||
    (s.task && (s.task.subagent_type || s.task.agent_type)) ||
    (s.tool_input && (s.tool_input.subagent_type || s.tool_input.agent_type));
  const n = typeof d === 'string' ? d.trim() : '';
  return n || 'unknown';
}

function resolveLabel(s) {
  const src =
    s.label || s.description ||
    (s.task && (s.task.label || s.task.description)) ||
    (s.tool_input && s.tool_input.description) ||
    s.name;
  return typeof src === 'string' ? src.trim().slice(0, 120) : '';
}

function resolveAgentId(s) {
  const id = s.agent_id || s.agentId || s.subagent_id || s.subagentId;
  return typeof id === 'string' ? id.trim() : '';
}

function main() {
  if (process.env.CLAUDE_NO_HOOKS === '1' || process.env.SUBAGENT_LIFECYCLE_DISABLED === '1') {
    return;
  }

  const raw = readStdin();
  let s = {};
  try {
    s = raw ? JSON.parse(raw) : {};
  } catch (_) {
    s = {};
  }

  const record = {
    ts: new Date().toISOString(),
    event: resolveEvent(s),
    agent_id: resolveAgentId(s),
    agent: resolveAgent(s),
  };
  const label = resolveLabel(s);
  if (label) record.label = label;

  appendJsonl(LIFECYCLE_LOG, record);
}

try {
  main();
} catch (e) {
  logHookError('subagent-lifecycle', e);
}
process.exitCode = 0;
