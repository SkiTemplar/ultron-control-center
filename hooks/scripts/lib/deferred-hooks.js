#!/usr/bin/env node
// hooks/scripts/lib/deferred-hooks.js — cola de los hooks de SessionEnd caros.
//
// Por qué (auditoría 2026-11-14): Sessions cierra el Job Object del PTY
// (KILL_ON_JOB_CLOSE) en cuanto `claude` sale, y los hooks async de SessionEnd
// mueren con él. Los que consultan al daemon (lesson-distill, project-profile)
// tardan segundos y perdían 7 y 9 de 47 cierres. Ahora el hook solo encola el
// payload (milisegundos, sobrevive al cierre) y el barrido de la tarea
// ULTRON-BitacoraSweep (scripts/bitacora-sweep.mjs, fuera de cualquier Job)
// lo ejecuta con `--from-queue <fichero>`.
//
// Cola: ~/.ultron/.tmp/deferred-hooks/<hook>/<ms>-<pid>.json (tmp + rename).
// Cada entrada se borra tras su pasada, termine como termine: un payload que
// cuelga el hook no se reintenta en bucle. Las de más de MAX_AGE_MS se
// descartan sin ejecutar.
//
// Seams: ULTRON_DEFERRED_DIR (raíz de la cola) y ULTRON_DEFER_SESSION_END=0
// (procesar en línea, como antes: lo usan los selftests de cada hook).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FROM_QUEUE_FLAG = '--from-queue';
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

function queueRoot(env = process.env) {
  return env.ULTRON_DEFERRED_DIR || path.join(os.homedir(), '.ultron', '.tmp', 'deferred-hooks');
}

function enqueue(hookId, raw, env = process.env) {
  const dir = path.join(queueRoot(env), hookId);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${process.pid}.json`;
  const tmp = path.join(dir, `${name}.tmp`);
  fs.writeFileSync(tmp, raw, 'utf8');
  fs.renameSync(tmp, path.join(dir, name));
  return path.join(dir, name);
}

/**
 * Payload que el hook debe procesar ahora, o `null` si lo ha encolado. Con
 * `--from-queue <fichero>` lee el fichero; sin cola posible (error de disco)
 * procesa en línea en vez de perder el cierre.
 */
function takePayload(hookId, readStdin, argv = process.argv, env = process.env) {
  const i = argv.indexOf(FROM_QUEUE_FLAG);
  if (i >= 0) {
    try {
      return fs.readFileSync(argv[i + 1], 'utf8');
    } catch (_) {
      return '';
    }
  }
  const raw = readStdin();
  if (env.ULTRON_DEFER_SESSION_END === '0' || !String(raw || '').trim()) return raw;
  try {
    enqueue(hookId, raw, env);
    return null;
  } catch (_) {
    return raw;
  }
}

/** Entradas pendientes de un hook, de la más antigua a la más reciente. */
function pending(hookId, env = process.env) {
  const dir = path.join(queueRoot(env), hookId);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
  return names
    .filter((n) => /^\d+-\d+\.json$/.test(n))
    .sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]))
    .map((n) => path.join(dir, n));
}

function removeQuietly(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch (_) {
    /* se reintenta en la pasada siguiente y caduca a los MAX_AGE_MS */
  }
}

/**
 * Ejecuta en orden lo encolado de `hooks` ([{ id, script }]) con
 * `spawnSync(node, [script, '--from-queue', fichero])`. Devuelve una línea por
 * entrada para el log del llamante. Como mucho `max` ejecuciones por pasada.
 */
function drain(hooks, opts = {}) {
  const {
    spawnSync,
    nodePath = process.execPath,
    timeoutMs = 90000,
    max = 4,
    now = Date.now(),
    env = process.env,
  } = opts;
  const results = [];
  let ran = 0;
  for (const { id, script } of hooks) {
    for (const file of pending(id, env)) {
      const base = path.basename(file);
      if (now - Number(base.split('-')[0]) > MAX_AGE_MS) {
        removeQuietly(file);
        results.push({ hook: id, entry: base, dropped: 'caducada' });
        continue;
      }
      if (ran >= max) return results;
      ran += 1;
      const t0 = Date.now();
      const r = spawnSync(nodePath, [script, FROM_QUEUE_FLAG, file], {
        timeout: timeoutMs,
        windowsHide: true,
        stdio: 'ignore',
        env,
      });
      removeQuietly(file);
      results.push({
        hook: id,
        entry: base,
        status: r && typeof r.status === 'number' ? r.status : null,
        signal: (r && r.signal) || null,
        ms: Date.now() - t0,
      });
    }
  }
  return results;
}

module.exports = { FROM_QUEUE_FLAG, MAX_AGE_MS, queueRoot, enqueue, takePayload, pending, drain };
