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
 * Alcance del campo `candidate` del trace (L2, 2026-10-26): true significa
 * «el sidecar arranco» (evento 'spawn' del hijo), no «el candidato se guardo».
 * El codigo de salida de `ultron-memory candidate` no se espera a proposito
 * (fire-and-forget); si el arranque falla, candidate=false y candidate_error
 * lleva el codigo (ENOENT, EACCES...).
 *
 * Overrides (solo selftest): SESSION_FEEDBACK_PROJECT, SESSION_FEEDBACK_TRACE
 * y los de lib/session-feedback.js; ULTRON_MEMORY_BIN apuntando a un binario
 * ausente evita el candidato.
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

const TRACE_PATH = process.env.SESSION_FEEDBACK_TRACE
  || path.join(os.homedir(), '.claude', 'logs', 'session-feedback-hook.jsonl');
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
// guarda el CONTEXTO: que ayudo o estorbo y por que). Resuelve {ok:true} cuando
// el hijo arranca y {ok:false, code} si spawn falla (sincrono o con el evento
// 'error', que llega despues de devolver el control).
function proposeCandidate(project, entry) {
  const bin = findBinary();
  if (!bin || !entry.note) return Promise.resolve({ ok: false });
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
  return new Promise((resolve) => {
    try {
      const child = spawn(bin, ['candidate', '--project', project], {
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      });
      child.once('spawn', () => resolve({ ok: true }));
      child.once('error', (err) => resolve({ ok: false, code: (err && err.code) || 'ERROR' }));
      child.stdin.on('error', () => { /* el hijo no arranco: lo reporta 'error' */ });
      child.stdin.end(JSON.stringify(candidate));
      child.unref();
    } catch (err) {
      resolve({ ok: false, code: (err && err.code) || 'ERROR' });
    }
  });
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
  const base = { msg: 'captured', project, answer: entry.answer, had_pending: entry.had_pending, note_chars: entry.note.length, session_id: sessionId };
  proposeCandidate(project, entry)
    .then((res) => trace({ ...base, candidate: res.ok, ...(res.ok ? {} : res.code ? { candidate_error: res.code } : {}) }))
    .catch((err) => logHookError('session-feedback-capture', err));

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
