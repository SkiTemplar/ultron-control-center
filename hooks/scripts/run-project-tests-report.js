#!/usr/bin/env node
/**
 * run-project-tests-report.js — UserPromptSubmit (sincrono). ULTRON 4, F4.1.
 *
 * Lee <project>.result.json (escrito por el runner de run-project-tests.js)
 * y, en el turno siguiente, le dice al modelo lo que ha pasado con los tests:
 *   - failed  -> nombres de los tests rotos (una vez por resultado);
 *   - timeout -> la suite no cabe en el tope; pide un comando mas corto;
 *   - no_command -> una vez por sesion: no hay tests que lanzar;
 *   - passed  -> solo si lo ultimo reportado fue un fallo ("verdes de nuevo").
 * Sin resultado o ya reportado: silencio.
 *
 * Fail-safe: exit 0 siempre. Override (selftest): RUN_TESTS_PROJECT.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { observe, logHookError } = require('./lib/hook-obs');
const { projectIdFromCwd } = require('./lib/ultron-memory-cli');
const T = require('./lib/run-project-tests');

observe('run-project-tests-report');

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch (_) {
    return {};
  }
}

function emit(context) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
  }));
}

function secs(ms) {
  return Math.round((ms || 0) / 1000);
}

function main() {
  const payload = readStdin();
  const cwd = payload.cwd || process.cwd();
  const sessionId = payload.session_id || null;
  const project = process.env.RUN_TESTS_PROJECT || projectIdFromCwd(cwd) || path.basename(cwd);
  if (!project) return;
  const result = T.readResult(project);
  if (!result) return;
  const state = T.readState(project);

  if (result.status === 'no_command') {
    // Una vez por sesion (no por resultado): en la siguiente sesion se recuerda.
    if (state.no_command_reported_session === sessionId) return;
    T.writeState(project, { ...state, no_command_reported_session: sessionId });
    emit(`TESTS ${project}: sin comando de test detectado. Declara 'test: <comando>' en el CLAUDE.md del proyecto o un script test en package.json; si el proyecto no tiene tests, propón los primeros.`);
    return;
  }

  if (result.status === 'failed' || result.status === 'timeout') {
    if (result.reported) return;
    T.writeResult(project, { ...result, reported: true });
    T.writeState(project, { ...state, last_reported_status: result.status });
    if (result.status === 'timeout') {
      emit(`TESTS ${project}: '${result.cmd}' no terminó en ${secs(T.TIME_CAP_MS)} s. La suite completa no cabe en el hook: declara una más corta con 'test: <comando>' en CLAUDE.md.`);
      return;
    }
    const names = (result.failed_tests || []).join(', ');
    const more = result.failed_total > (result.failed_tests || []).length ? ` y ${result.failed_total - result.failed_tests.length} más` : '';
    const detail = names ? `${result.failed_total} fallo(s) -> ${names}${more}` : `${result.summary} (exit ${result.exit_code})`;
    emit(`TESTS ${project} (${result.cmd}, ${secs(result.duration_ms)} s): ${detail}. Arregla antes de seguir o di por qué no.`);
    return;
  }

  if (result.status === 'passed') {
    if (state.last_reported_status !== 'failed' && state.last_reported_status !== 'timeout') return;
    if (result.reported) return;
    T.writeResult(project, { ...result, reported: true });
    T.writeState(project, { ...state, last_reported_status: 'passed' });
    emit(`TESTS ${project}: verdes de nuevo (${result.cmd}, ${secs(result.duration_ms)} s).`);
  }
}

try {
  main();
} catch (err) {
  logHookError('run-project-tests-report', err);
} finally {
  process.exitCode = 0;
}
