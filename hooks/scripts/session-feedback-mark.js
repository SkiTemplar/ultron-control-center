#!/usr/bin/env node
/**
 * session-feedback-mark.js — SessionEnd hook (async). ULTRON 4, plan 12.1.
 *
 * Deja en cockpit/projects/<id>/feedback-pending.json los datos de la sesion
 * que termina (minutos, turnos humanos, commits) para que el siguiente
 * SessionStart en ese proyecto pregunte "¿ayudo ULTRON?". Ver
 * lib/session-feedback.js para el mecanismo completo.
 *
 * Reglas:
 *   - Solo proyectos registrados en el cockpit y que no son ULTRON.
 *   - Solo sesiones con >= MIN_HUMAN_TURNS turnos humanos.
 *   - Si habia un pending de OTRA sesion sin responder, se registra como
 *     "sin_respuesta" antes de sobreescribirlo (ignorar cuenta, no desaparece).
 *
 * Fail-safe: cualquier error -> exit 0 sin escribir. Traza en
 * ~/.claude/logs/session-feedback-hook.jsonl.
 *
 * Overrides (solo selftest): SESSION_FEEDBACK_PROJECT (salta la resolucion por
 * cwd) y los de lib/session-feedback.js.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { observe, logHookError } = require('./lib/hook-obs');
const { appendJsonl } = require('./lib/jsonl-log');
const { projectIdFromCwd } = require('./lib/ultron-memory-cli');
const feedback = require('./lib/session-feedback');

observe('session-feedback-mark');

const TRACE_PATH = path.join(os.homedir(), '.claude', 'logs', 'session-feedback-hook.jsonl');

function trace(entry) {
  appendJsonl(TRACE_PATH, { ts: new Date().toISOString(), hook: 'mark', ...entry });
}

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch (_) {
    return {};
  }
}

function main() {
  const stdin = readStdin();
  const cwd = stdin.cwd || process.cwd();
  const sessionId = stdin.session_id || stdin.sessionId || null;
  const transcriptPath = stdin.transcript_path || stdin.transcriptPath || '';
  const project = process.env.SESSION_FEEDBACK_PROJECT || projectIdFromCwd(cwd);

  if (feedback.isExcluded(project)) {
    trace({ msg: 'skip', reason: 'excluded_project', project: project || null, session_id: sessionId });
    return;
  }
  if (!feedback.projectDirExists(project)) {
    trace({ msg: 'skip', reason: 'project_not_registered', project, session_id: sessionId });
    return;
  }
  const s = feedback.sessionStats(transcriptPath);
  if (!s) {
    trace({ msg: 'skip', reason: 'no_transcript', project, session_id: sessionId });
    return;
  }
  if (s.human_turns < feedback.MIN_HUMAN_TURNS) {
    trace({ msg: 'skip', reason: 'too_short', project, human_turns: s.human_turns, session_id: sessionId });
    return;
  }

  const previous = feedback.readPending(project);
  if (previous && previous.session_id !== sessionId) {
    feedback.appendFeedback({
      ts: new Date().toISOString(),
      project,
      answer: 'sin_respuesta',
      note: '',
      rated_session_id: previous.session_id,
      rated_ended_at: previous.ended_at || null,
      minutes: previous.minutes || 0,
      human_turns: previous.human_turns || 0,
      commits: previous.commits || 0,
      from_session_id: sessionId,
      had_pending: true,
    });
  }

  const doc = {
    session_id: sessionId,
    project,
    cwd,
    started_at: s.started_at,
    ended_at: s.ended_at || new Date().toISOString(),
    minutes: s.minutes,
    human_turns: s.human_turns,
    commits: feedback.commitsBetween(cwd, s.started_at, s.ended_at),
    reason: stdin.reason || null,
    marked_at: new Date().toISOString(),
  };
  feedback.writePending(project, doc);
  trace({ msg: 'pending_written', project, session_id: sessionId, minutes: doc.minutes, human_turns: doc.human_turns, commits: doc.commits, superseded: previous ? previous.session_id : null });
}

try {
  main();
} catch (err) {
  logHookError('session-feedback-mark', err);
} finally {
  process.exitCode = 0;
}
