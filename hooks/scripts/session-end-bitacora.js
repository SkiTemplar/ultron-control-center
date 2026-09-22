#!/usr/bin/env node
'use strict';

/**
 * session-end-bitacora.js — SessionEnd hook: la bitacora de la sesion que
 * acaba de cerrarse, sin esperar a que se abra otra.
 *
 * Hasta el 2026-09-22 el summary.md (Bitacora del proyecto) solo lo generaba
 * memory-session-resume.js en el SessionStart SIGUIENTE del mismo proyecto,
 * y solo para la sesion anterior mas reciente de menos de 7 dias. Resultado
 * medido: ultron 20/119 sesiones con bitacora, auto-album-maker 0/38,
 * legacy-fc 0/13 — en un proyecto que se abre una vez por semana la bitacora
 * no existia. Este hook lanza session-summarize-previous.js desacoplado
 * (`claude -p` Sonnet, 20-40 s) apuntando a ESTA sesion (--target-session) y
 * con su transcript_path (--transcript). El resumidor conserva sus gates:
 * >= 2 prompts reales, lock por sesion, backoff por fallos y redaccion.
 * El SessionStart sigue como red: regenera si el transcript siguio creciendo.
 *
 * Fail-safe: cualquier error se traga y sale 0; un hook nunca rompe el cierre.
 * Opt-out: CLAUDE_NO_HOOKS=1 o SESSION_END_BITACORA_DISABLED=1.
 * Test: SESSION_END_BITACORA_SCRIPT apunta a un stub y SESSION_END_BITACORA_SYNC=1
 * espera al hijo (en produccion es fire-and-forget).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { observe, logHookError } = require('./lib/hook-obs');

const SUMMARIZE_SCRIPT =
  process.env.SESSION_END_BITACORA_SCRIPT || path.join(__dirname, 'session-summarize-previous.js');

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Argumentos del resumidor para la sesion que cierra; null si falta lo esencial. */
function summarizerArgs(input) {
  const sessionId = typeof input.session_id === 'string' ? input.session_id.trim() : '';
  if (!/^[A-Za-z0-9_-]{6,}$/.test(sessionId)) return null;
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const args = [SUMMARIZE_SCRIPT, '--cwd', cwd, '--session', '__session_end__', '--target-session', sessionId];
  if (typeof input.transcript_path === 'string' && input.transcript_path) {
    args.push('--transcript', input.transcript_path);
  }
  return args;
}

function launch(args) {
  const dir = path.join(os.homedir(), '.ultron', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  if (process.env.SESSION_END_BITACORA_SYNC === '1') {
    return spawnSync(process.execPath, args, { stdio: 'ignore', windowsHide: true, timeout: 60_000 }).status;
  }
  let fd = null;
  try {
    fd = fs.openSync(path.join(dir, 'session-summary.stderr.log'), 'a');
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', 'ignore', fd], windowsHide: true });
    child.on('error', () => { /* best effort */ });
    child.unref();
    return 0;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* el hijo ya tiene su copia del handle */ }
    }
  }
}

function main() {
  if (process.env.CLAUDE_NO_HOOKS === '1' || process.env.SESSION_END_BITACORA_DISABLED === '1') return;
  observe('session-end-bitacora');
  const args = summarizerArgs(readStdinJson());
  if (!args) return;
  launch(args);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    try { logHookError('session-end-bitacora', e); } catch { /* ignore */ }
  }
  process.exitCode = 0;
} else {
  module.exports = { summarizerArgs, launch, SUMMARIZE_SCRIPT };
}
