#!/usr/bin/env node
/**
 * session-feedback-capture.js — UserPromptSubmit hook (sincrono). ULTRON 4, 12.1.
 *
 * Captura la respuesta de feedback del usuario, con prefijo explicito y cero
 * heuristica: `fb: si|no|estorbo [nota]`. Registra la entrada en
 * logs/session-feedback.jsonl (la fuente de la metrica), retira el
 * feedback-pending.json del proyecto y, si hay nota, la propone como candidato
 * de memoria via `ultron-memory candidate` (single writer; fire-and-forget para
 * no gastar el presupuesto del hook). Devuelve una linea de additionalContext
 * para que el modelo no se ponga a comentar el feedback.
 *
 * Prompts que no empiezan por `fb:` salen sin tocar nada y sin output.
 *
 * Overrides (solo selftest): SESSION_FEEDBACK_PROJECT y los de
 * lib/session-feedback.js; ULTRON_MEMORY_BIN apuntando a un binario ausente
 * evita el candidato.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { observe, logHookError } = require('./lib/hook-obs');
const { appendJsonl } = require('./lib/jsonl-log');
const { projectIdFromCwd, findBinary } = require('./lib/ultron-memory-cli');
const feedback = require('./lib/session-feedback');

observe('session-feedback-capture');

const TRACE_PATH = path.join(os.homedir(), '.claude', 'logs', 'session-feedback-hook.jsonl');
const NOTE_MAX_CHARS = 400;

function trace(entry) {
  appendJsonl(TRACE_PATH, { ts: new Date().toISOString(), hook: 'capture', ...entry });
}

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch (_) {
    return {};
  }
}

// Candidato de memoria con la nota (la cifra vive en el jsonl; la memoria
// guarda el CONTEXTO: que ayudo o estorbo y por que).
function proposeCandidate(project, entry) {
  const bin = findBinary();
  if (!bin || !entry.note) return false;
  const fecha = String(entry.rated_ended_at || entry.ts).slice(0, 10);
  const candidate = {
    type: 'session_summary',
    scope: 'project',
    title: `Feedback de sesion ${fecha}: ${feedback.ANSWER_LABEL[entry.answer]}`,
    summary: entry.note,
    content: `session_feedback=${entry.answer}; session_id=${entry.rated_session_id || 'n/a'}`,
    confidence: 0.7,
    source: 'session-feedback',
    capture_source: 'session-feedback',
    recommended_action: 'review',
    session_id: entry.rated_session_id || null,
  };
  try {
    const child = spawn(bin, ['candidate', '--project', project], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    child.on('error', () => { /* fire-and-forget */ });
    child.stdin.end(JSON.stringify(candidate));
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
}

function main() {
  const stdin = readStdin();
  const prompt = typeof stdin.prompt === 'string' ? stdin.prompt : '';
  const parsed = feedback.parseAnswer(prompt);
  if (!parsed) return;

  const cwd = stdin.cwd || process.cwd();
  const sessionId = stdin.session_id || stdin.sessionId || null;
  const project = process.env.SESSION_FEEDBACK_PROJECT || projectIdFromCwd(cwd) || 'desconocido';
  const pending = feedback.readPending(project);
  const entry = {
    ts: new Date().toISOString(),
    project,
    answer: parsed.answer,
    note: parsed.note.slice(0, NOTE_MAX_CHARS),
    rated_session_id: pending ? pending.session_id : null,
    rated_ended_at: pending ? pending.ended_at || null : null,
    minutes: pending ? pending.minutes || 0 : 0,
    human_turns: pending ? pending.human_turns || 0 : 0,
    commits: pending ? pending.commits || 0 : 0,
    from_session_id: sessionId,
    had_pending: !!pending,
  };
  feedback.appendFeedback(entry);
  if (pending) feedback.removePending(project);
  const proposed = proposeCandidate(project, entry);
  trace({ msg: 'captured', project, answer: entry.answer, had_pending: entry.had_pending, note_chars: entry.note.length, candidate: proposed, session_id: sessionId });

  const s = feedback.stats();
  const cifra = s.n ? ` Acumulado: si ${s.pct_si} % de ${s.n}.` : '';
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext:
        `session_feedback registrado: ${feedback.ANSWER_LABEL[entry.answer]} (${project})` +
        `${entry.had_pending ? '' : ', sin sesion pendiente'}.${cifra} ` +
        'Confirma en una linea y no lo comentes mas; si el mensaje trae otra peticion, atiendela.',
    },
  }));
}

try {
  main();
} catch (err) {
  logHookError('session-feedback-capture', err);
} finally {
  process.exitCode = 0;
}
