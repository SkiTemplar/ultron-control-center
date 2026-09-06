#!/usr/bin/env node
/**
 * run-project-tests.js — PostToolUse (Edit|Write|MultiEdit|NotebookEdit),
 * async. ULTRON 4, F4.1: tests que se lanzan solos tras editar codigo.
 *
 * Modo hook (sin argumentos): lee el payload, comprueba que el fichero editado
 * es codigo dentro del cwd, resuelve el comando de test del proyecto
 * (lib/run-project-tests.detectTestCommand), aplica debounce y lanza un
 * RUNNER desacoplado (`--runner`) que ejecuta la suite completa con tope de
 * tiempo y escribe <project>.result.json. El hook vuelve en milisegundos: el
 * harness no espera a los tests.
 *
 * Modo runner (`--runner`, parametros por entorno RUN_TESTS_*): toma el lock
 * del proyecto (un runner a la vez), ejecuta, parsea los fallos y guarda el
 * resultado; si mientras corria llegaron mas ediciones (dirty), repite una
 * vez. El reporter (run-project-tests-report.js, UserPromptSubmit) es quien
 * habla con el modelo en el turno siguiente (Q3b: diferido).
 *
 * Fail-safe: cualquier error -> exit 0, traza en
 * ~/.claude/logs/run-project-tests.jsonl. Opt-out: RUN_TESTS_DISABLED=1.
 * Override (selftest): RUN_TESTS_PROJECT salta la resolucion de identidad.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { observe, logHookError } = require('./lib/hook-obs');
const { appendJsonl } = require('./lib/jsonl-log');
const { projectIdFromCwd } = require('./lib/ultron-memory-cli');
const T = require('./lib/run-project-tests');

const RUNNER_MODE = process.argv.includes('--runner');
if (!RUNNER_MODE) observe('run-project-tests');

const TRACE_PATH = path.join(os.homedir(), '.claude', 'logs', 'run-project-tests.jsonl');
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MAX_RUNS_PER_LAUNCH = 2;

function trace(entry) {
  appendJsonl(TRACE_PATH, { ts: new Date().toISOString(), ...entry });
}

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch (_) {
    return {};
  }
}

function launchRunner(env) {
  try {
    const child = spawn(process.execPath, [__filename, '--runner'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    child.on('error', () => { /* best effort */ });
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
}

function hookMain() {
  if (process.env.RUN_TESTS_DISABLED === '1') return;
  const payload = readStdin();
  const toolName = payload.tool_name || payload.toolName || '';
  if (!EDIT_TOOLS.has(toolName)) return;
  const input = payload.tool_input || payload.toolInput || {};
  const filePath = String(input.file_path || input.notebook_path || '');
  const cwd = payload.cwd || process.cwd();
  const sessionId = payload.session_id || null;
  if (!T.isCodeFile(filePath) || !T.isUnder(filePath, cwd)) return;

  const project = process.env.RUN_TESTS_PROJECT || projectIdFromCwd(cwd) || path.basename(cwd);
  if (!project) return;

  const detected = T.detectTestCommand(cwd);
  const state = T.readState(project);
  if (!detected) {
    const prev = T.readResult(project);
    if (!prev || prev.status !== 'no_command') {
      T.writeResult(project, {
        project, cwd, cmd: null, source: null, status: 'no_command',
        finished_at: new Date().toISOString(), reported: false, session_id: sessionId,
      });
    }
    trace({ hook: 'trigger', msg: 'no_command', project, file: filePath });
    return;
  }

  const now = Date.now();
  const last = state.last_trigger_at ? Date.parse(state.last_trigger_at) : 0;
  const running = state.running && !T.isLockStale(state.running) ? state.running : null;
  if (running) {
    T.writeState(project, { ...state, dirty: true, last_edit_at: new Date(now).toISOString() });
    trace({ hook: 'trigger', msg: 'runner_busy_marked_dirty', project, file: filePath });
    return;
  }
  if (last && now - last < T.DEBOUNCE_MS) {
    T.writeState(project, { ...state, skipped_debounce: (state.skipped_debounce || 0) + 1, last_edit_at: new Date(now).toISOString() });
    trace({ hook: 'trigger', msg: 'debounced', project, file: filePath });
    return;
  }

  T.writeState(project, { ...state, last_trigger_at: new Date(now).toISOString(), last_edit_at: new Date(now).toISOString(), dirty: false, cmd: detected.cmd, source: detected.source });
  const launched = launchRunner({
    RUN_TESTS_PROJECT: project,
    RUN_TESTS_CWD: cwd,
    RUN_TESTS_CMD: detected.cmd,
    RUN_TESTS_SOURCE: detected.source,
    RUN_TESTS_SESSION: sessionId || '',
  });
  trace({ hook: 'trigger', msg: launched ? 'runner_launched' : 'runner_launch_failed', project, cmd: detected.cmd, source: detected.source, file: filePath });
}

async function runnerMain() {
  const project = process.env.RUN_TESTS_PROJECT;
  const cwd = process.env.RUN_TESTS_CWD;
  const cmd = process.env.RUN_TESTS_CMD;
  const source = process.env.RUN_TESTS_SOURCE || null;
  const sessionId = process.env.RUN_TESTS_SESSION || null;
  if (!project || !cwd || !cmd) return;

  let state = T.readState(project);
  if (state.running && !T.isLockStale(state.running)) {
    T.writeState(project, { ...state, dirty: true });
    trace({ hook: 'runner', msg: 'lock_held_exit', project });
    return;
  }
  state = { ...state, running: { pid: process.pid, started_at: new Date().toISOString() }, dirty: false };
  T.writeState(project, state);

  try {
    for (let run = 1; run <= MAX_RUNS_PER_LAUNCH; run++) {
      const r = await T.runCommand(cmd, cwd, T.TIME_CAP_MS);
      const parsed = r.status === 'passed' ? { failed: [], summary: 'ok' } : T.parseFailures(r.output, r.exit_code);
      const result = {
        project, cwd, cmd, source,
        status: r.status,
        exit_code: r.exit_code,
        duration_ms: r.duration_ms,
        failed_tests: parsed.failed.slice(0, T.MAX_FAILED_NAMES),
        failed_total: parsed.failed.length,
        summary: parsed.summary,
        tail: r.status === 'passed' ? '' : T.tailOf(r.output),
        finished_at: new Date().toISOString(),
        reported: false,
        session_id: sessionId,
        run_in_launch: run,
      };
      T.writeResult(project, result);
      trace({ hook: 'runner', msg: 'result', project, status: r.status, failed: parsed.failed.length, duration_ms: r.duration_ms, run });
      const fresh = T.readState(project);
      if (!fresh.dirty) break;
      T.writeState(project, { ...fresh, dirty: false });
    }
  } finally {
    const fresh = T.readState(project);
    T.writeState(project, { ...fresh, running: null });
  }
}

function onError(err) {
  logHookError('run-project-tests', err);
  try { trace({ hook: RUNNER_MODE ? 'runner' : 'trigger', msg: 'error', error: String(err && err.message) }); } catch (_) { /* nada */ }
}

process.exitCode = 0;
if (RUNNER_MODE) {
  runnerMain().catch(onError);
} else {
  try {
    hookMain();
  } catch (err) {
    onError(err);
  }
}
