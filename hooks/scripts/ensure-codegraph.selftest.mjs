#!/usr/bin/env node
// Selftest de ensure-codegraph: el guard de SessionStart que mantiene vivo el
// daemon de CodeGraph de ~/.ultron (auditoria 2026-10-23: no tenia ningun test).
//
// Hermetico: un home temporal con su daemon.pid, daemon.log y shim falsos;
// `spawn` e `isAlive` inyectados, asi que no arranca ni senala ningun proceso.
// Ejecutar: node hooks/scripts/ensure-codegraph.selftest.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ecg = require('./ensure-codegraph.js');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-ecg-'));
let asserts = 0;
const check = (fn) => { fn(); asserts++; };

/** spawn falso: registra la llamada y devuelve un hijo con unref(). */
function spawnFalso() {
  const llamadas = [];
  const fn = (cmd, args, opts) => {
    llamadas.push({ cmd, args, opts });
    return { unref() {} };
  };
  return { fn, llamadas };
}

try {
  const p = ecg.rutas(home);
  fs.mkdirSync(path.dirname(p.pidFile), { recursive: true });

  // daemonPid: JSON, entero plano, basura y ausente.
  check(() => assert.equal(ecg.daemonPid(p.pidFile), null, 'sin daemon.pid => null'));
  fs.writeFileSync(p.pidFile, JSON.stringify({ pid: 4321, started: 1 }));
  check(() => assert.equal(ecg.daemonPid(p.pidFile), 4321, 'formato JSON'));
  fs.writeFileSync(p.pidFile, '987\n');
  check(() => assert.equal(ecg.daemonPid(p.pidFile), 987, 'entero plano'));
  fs.writeFileSync(p.pidFile, 'basura');
  check(() => assert.equal(ecg.daemonPid(p.pidFile), null, 'basura => null'));
  fs.writeFileSync(p.pidFile, '-5');
  check(() => assert.equal(ecg.daemonPid(p.pidFile), null, 'pid no positivo => null'));

  // isAlive real: este proceso vive.
  check(() => assert.equal(ecg.isAlive(process.pid), true));

  // Daemon vivo: no se lanza nada.
  fs.writeFileSync(p.pidFile, '987');
  const vivo = spawnFalso();
  const msgVivo = ecg.main({ rutas: p, spawn: vivo.fn, isAlive: () => true });
  check(() => assert.match(msgVivo, /daemon vivo \(pid=987\)/));
  check(() => assert.equal(vivo.llamadas.length, 0, 'con el daemon vivo no se arranca otro'));

  // Daemon muerto y sin shim: lo dice y no lanza nada.
  const sinShim = spawnFalso();
  const msgSinShim = ecg.main({ rutas: p, spawn: sinShim.fn, isAlive: () => false });
  check(() => assert.match(msgSinShim, /shim npm de codegraph ausente/));
  check(() => assert.equal(sinShim.llamadas.length, 0));

  // Daemon muerto con shim: arranca el daemon de ~/.ultron sin idle-exit.
  fs.mkdirSync(path.dirname(p.shim), { recursive: true });
  fs.writeFileSync(p.shim, '// shim falso');
  const arranque = spawnFalso();
  const msgArranque = ecg.main({ rutas: p, spawn: arranque.fn, isAlive: () => false });
  check(() => assert.match(msgArranque, /arranque disparado en background/));
  check(() => assert.equal(arranque.llamadas.length, 1));
  const [{ cmd, args, opts }] = arranque.llamadas;
  check(() => assert.equal(cmd, process.execPath));
  check(() => assert.deepEqual(args, [p.shim, 'serve', '--mcp', '--path', p.ultron]));
  check(() => assert.equal(opts.detached, true));
  check(() => assert.equal(opts.env.CODEGRAPH_DAEMON_INTERNAL, '1'));
  check(() => assert.equal(opts.env.CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS, '0', '0 = nunca sale por inactividad'));
  check(() => assert.ok(Array.isArray(opts.stdio), 'la salida del daemon va al log'));
  check(() => assert.ok(fs.existsSync(p.logFile), 'el log se crea'));

  // Rotacion del log: por debajo del tope no rota; por encima, a .1.
  fs.writeFileSync(p.logFile, 'x'.repeat(10));
  check(() => assert.equal(ecg.rotateLogIfNeeded(p.logFile, 100), false));
  fs.writeFileSync(p.logFile, 'x'.repeat(200));
  check(() => assert.equal(ecg.rotateLogIfNeeded(p.logFile, 100), true));
  check(() => assert.ok(fs.existsSync(`${p.logFile}.1`) && !fs.existsSync(p.logFile)));
  check(() => assert.equal(ecg.rotateLogIfNeeded(path.join(home, 'no-existe.log'), 1), false));

  console.log(`ensure-codegraph.selftest: OK (${asserts} asserts)`);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
