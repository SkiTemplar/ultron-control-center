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

// Rotacion acotada (mismo criterio que lib/jsonl-log.js: 1 MiB, generacion
// unica .1). El log se abre en 'a' y lo alimenta el daemon detached durante
// horas -> sin esto crece sin cota (F6, 2026-09-10).
const LOG_MAX_BYTES = 1 * 1024 * 1024;

/**
 * Rutas del hook. Se calculan a partir del home para que el selftest las
 * apunte a una carpeta temporal.
 *  - shim: shim npm global de codegraph. En Windows los wrappers sh/.cmd no
 *    son spawneables directos (hardening CVE-2024-27980 de Node moderno), asi
 *    que se invoca su entry real (npm-shim.js) con el node de este hook — es
 *    exactamente lo que hacen `codegraph` (sh) y `codegraph.cmd`.
 */
function rutas(home = os.homedir()) {
  const ultron = path.join(home, '.ultron');
  const cgDir = path.join(ultron, '.codegraph');
  return {
    ultron,
    pidFile: path.join(cgDir, 'daemon.pid'),
    logFile: path.join(cgDir, 'daemon.log'),
    shim: path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@colbymchenry', 'codegraph', 'npm-shim.js'),
  };
}

/** PID del daemon segun daemon.pid (JSON {pid,...} o entero plano), o null. */
function daemonPid(pidFile) {
  try {
    const raw = fs.readFileSync(pidFile, 'utf8').trim();
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

/** Rota `logFile` -> `logFile.1` (pisando el anterior) si supera `maxBytes`. */
function rotateLogIfNeeded(logFile, maxBytes = LOG_MAX_BYTES) {
  try {
    const st = fs.statSync(logFile);
    if (st.size < maxBytes) return false;
    fs.renameSync(logFile, `${logFile}.1`);
    return true;
  } catch (_) {
    // fichero ausente o rename en carrera -> nada que rotar.
    return false;
  }
}

/** Abre el log en append para el daemon; sin log, su salida se descarta. */
function abrirLog(logFile) {
  try {
    rotateLogIfNeeded(logFile);
    return fs.openSync(logFile, 'a');
  } catch (_) {
    // Sin log: descartar el output del daemon antes que fallar el arranque.
    return null;
  }
}

/**
 * Comprueba el daemon y lo arranca si hace falta. Devuelve el mensaje que el
 * hook imprime. `opts` inyecta rutas, `spawn` e `isAlive` en el selftest.
 */
function main(opts = {}) {
  const p = opts.rutas || rutas();
  const lanzar = opts.spawn || spawn;
  const vivo = opts.isAlive || isAlive;
  const pid = daemonPid(p.pidFile);
  if (pid && vivo(pid)) return `ensure-codegraph: daemon vivo (pid=${pid})`;
  if (!fs.existsSync(p.shim)) return 'ensure-codegraph: shim npm de codegraph ausente -- daemon no arrancado';

  const logFd = abrirLog(p.logFile);
  try {
    const child = lanzar(process.execPath, [p.shim, 'serve', '--mcp', '--path', p.ultron], {
      detached: true,
      stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
      windowsHide: true,
      env: {
        ...process.env,
        CODEGRAPH_DAEMON_INTERNAL: '1',
        CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '0',
      },
    });
    child.unref();
  } finally {
    // El hijo ya tiene su dup del fd del log; este proceso no lo necesita.
    if (logFd !== null) {
      try { fs.closeSync(logFd); } catch (_) { /* ignore */ }
    }
  }
  return 'ensure-codegraph: daemon caido/ausente -- arranque disparado en background (no se bloquea el arranque)';
}

// Solo corre el hook cuando se invoca directamente; al importarse (selftest)
// expone las funciones sin tocar el daemon real.
if (require.main === module) {
  observe('ensure-codegraph');
  try {
    console.log(main());
  } catch (e) {
    // cat9.5: deja rastro del fallo top-level sin romper el fail-safe.
    logHookError('ensure-codegraph', e);
    // Nunca romper el SessionStart.
    process.exit(0);
  }
} else {
  module.exports = { rutas, daemonPid, isAlive, rotateLogIfNeeded, main, LOG_MAX_BYTES };
}
