#!/usr/bin/env node
/**
 * ensure-codegraph.js — guard de arranque del daemon CodeGraph para SessionStart.
 *
 * Patron calcado de ensure-qdrant.js: check barato en caliente, spawn detached
 * fire-and-forget en frio, y NUNCA bloquear ni romper el arranque de sesion.
 *
 * Motivo (diagnostico ultracode 2026-07-22): el daemon/watcher de codegraph solo
 * arrancaba cuando un cliente MCP conectaba, y con idle-timeout por defecto
 * (300s) moria solo -> daemon.pid ausente, indice stale, cat2.4/2.5 en rojo.
 * Este hook lo mantiene SIEMPRE vivo:
 *  - daemon.pid con PID vivo -> salida inmediata (~ms; el coste es el boot de node).
 *  - PID muerto/ausente -> spawn detached del shim npm con
 *    CODEGRAPH_DAEMON_INTERNAL=1 (el proceso ES el daemon: arbitra el mismo el
 *    lock O_EXCL de daemon.pid; si ya corre otro, el nuevo sale solo — sin
 *    riesgo de duplicados) y CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS=0 (0 = nunca
 *    idle-exit), stdout/stderr en append a .codegraph/daemon.log.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { observe, logHookError } = require('./lib/hook-obs');
observe('ensure-codegraph');

const ULTRON = path.join(os.homedir(), '.ultron');
const CG_DIR = path.join(ULTRON, '.codegraph');
const PID_FILE = path.join(CG_DIR, 'daemon.pid');
const LOG_FILE = path.join(CG_DIR, 'daemon.log');
// Shim npm global de codegraph. En Windows los wrappers sh/.cmd no son
// spawneables directos (hardening CVE-2024-27980 de Node moderno), asi que se
// invoca su entry real (npm-shim.js) con el node de este hook — es exactamente
// lo que hacen `codegraph` (sh) y `codegraph.cmd`.
const SHIM_JS = path.join(
  os.homedir(), 'AppData', 'Roaming', 'npm',
  'node_modules', '@colbymchenry', 'codegraph', 'npm-shim.js'
);

/** PID del daemon segun daemon.pid (JSON {pid,...} o entero plano), o null. */
function daemonPid() {
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf8').trim();
    const pid = raw.startsWith('{') ? JSON.parse(raw).pid : parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (_) {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = el proceso existe pero no es nuestro para senalar -> vivo.
    return !!e && e.code === 'EPERM';
  }
}

function main() {
  const pid = daemonPid();
  if (pid && isAlive(pid)) {
    console.log(`ensure-codegraph: daemon vivo (pid=${pid})`);
    return;
  }

  if (!fs.existsSync(SHIM_JS)) {
    console.log('ensure-codegraph: shim npm de codegraph ausente -- daemon no arrancado');
    return;
  }

  let logFd = null;
  let stdio = 'ignore';
  try {
    logFd = fs.openSync(LOG_FILE, 'a');
    stdio = ['ignore', logFd, logFd];
  } catch (_) {
    // Sin log: descartar el output del daemon antes que fallar el arranque.
  }
  try {
    const child = spawn(
      process.execPath,
      [SHIM_JS, 'serve', '--mcp', '--path', ULTRON],
      {
        detached: true,
        stdio,
        windowsHide: true,
        env: {
          ...process.env,
          CODEGRAPH_DAEMON_INTERNAL: '1',
          CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '0',
        },
      }
    );
    child.unref();
  } finally {
    // El hijo ya tiene su dup del fd del log; este proceso no lo necesita.
    if (logFd !== null) {
      try { fs.closeSync(logFd); } catch (_) { /* ignore */ }
    }
  }
  console.log(
    'ensure-codegraph: daemon caido/ausente -- arranque disparado en background (no se bloquea el arranque)'
  );
}

try {
  main();
} catch (e) {
  // cat9.5: deja rastro del fallo top-level sin romper el fail-safe.
  logHookError('ensure-codegraph', e);
  // Nunca romper el SessionStart.
  process.exit(0);
}
