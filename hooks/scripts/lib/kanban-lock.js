'use strict';

/**
 * lib/kanban-lock.js — lock de fichero entre procesos para kanban.json.
 *
 * Por que (auditoria 2026-10-26, L12): kanban.json tiene tres escritores en
 * procesos distintos: este hook (lib/kanban-auto.js), el CLI scripts/kanban.mjs
 * y la app (control-center/src-tauri/src/kanban/board_io.rs). El Mutex de la
 * app solo vale dentro de su proceso, asi que un leer-modificar-escribir
 * concurrente podia perder una actualizacion.
 *
 * Protocolo (el mismo en board_io.rs/file_lock.rs; si se cambia aqui, se cambia
 * alli):
 *   - Lock = `<kanban.json>.lock`, creado con O_EXCL (`wx`). Contenido: JSON
 *     {pid, token, at} para diagnostico y para que solo su dueno lo borre.
 *   - Si existe: reintentos con backoff corto (5 ms doblando hasta 100 ms)
 *     hasta LOCK_TIMEOUT_MS (~2 s); despues, error explicito.
 *   - Un lock con mtime de mas de LOCK_STALE_MS (10 s) es rancio (proceso
 *     muerto): se rompe con aviso y se reintenta. Romperlo es renombrarlo a
 *     `<lock>.stale-<token>` (atomico) y, si lo renombrado resulta reciente
 *     (otro proceso lo acababa de crear), devolverlo con un hard link.
 *   - Se libera al terminar la seccion critica y, si el proceso sale antes
 *     (process.exit dentro de la seccion), en el evento 'exit'.
 *
 * API sincrona: los escritores (kanban-auto, kanban.mjs) son sincronos.
 */

const fs = require('fs');
const crypto = require('crypto');

const LOCK_SUFFIX = '.lock';
const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 10000;
const BACKOFF_START_MS = 5;
const BACKOFF_MAX_MS = 100;

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

/** Espera sincrona sin consumir CPU. */
function sleepSync(ms) {
  Atomics.wait(SLEEP_CELL, 0, 0, ms);
}

function lockPathFor(boardFile) {
  return `${boardFile}${LOCK_SUFFIX}`;
}

function defaultOnStale(lockPath, ageMs) {
  process.stderr.write(
    `[kanban-lock] lock rancio roto (${Math.round(ageMs / 1000)} s sin liberar, proceso muerto?): ${lockPath}\n`,
  );
}

/** Edad del lock en ms, o null si ya no existe. */
function lockAgeMs(lockPath, nowMs) {
  try {
    return nowMs - fs.statSync(lockPath).mtimeMs;
  } catch (e) {
    // ENOENT: ya se libero. EPERM/EACCES: borrado pendiente en Windows.
    if (e && ['ENOENT', 'EPERM', 'EACCES'].includes(e.code)) return null;
    throw e;
  }
}

// EPERM/EACCES al crear: en Windows, un lock recien liberado queda en borrado
// pendiente mientras otro proceso conserve un handle. Es contencion, no un error.
const BUSY_CODES = new Set(['EEXIST', 'EPERM', 'EACCES']);

/**
 * Intenta crear el lock con O_EXCL.
 * @returns {{acquired: boolean, denied?: string}} denied = ultimo EPERM/EACCES
 */
function tryCreate(lockPath, token) {
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (e) {
    if (e && BUSY_CODES.has(e.code)) return { acquired: false, denied: e.code === 'EEXIST' ? undefined : e.message };
    throw e;
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }));
  } finally {
    fs.closeSync(fd);
  }
  return { acquired: true };
}

/**
 * Rompe un lock rancio sin pisar uno recien creado (revision 2026-10-26, LOW).
 *
 * Carrera que evita: A y B ven el mismo lock rancio; A lo borra y crea el suyo;
 * B, que ya habia decidido que era rancio, borraba por ruta el lock NUEVO de A
 * y los dos entraban en la seccion critica. Ahora el lock se renombra a un
 * nombre unico (atomico: solo un proceso se lleva cada fichero) y se mira la
 * edad de LO QUE SE HA RENOMBRADO: si es reciente, era el de otro proceso y se
 * devuelve a su sitio con un hard link (que no sobrescribe si ya hay otro).
 *
 * @returns {boolean} true si conviene reintentar ya (roto, devuelto o ya no
 *   existia); false si el SO lo tiene ocupado y hay que esperar
 */
function breakStaleLock(lockPath, token, staleMs) {
  const grave = `${lockPath}.stale-${token}`;
  try {
    fs.renameSync(lockPath, grave);
  } catch (e) {
    if (e && e.code === 'ENOENT') return true;
    if (e && (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY')) return false;
    throw e;
  }
  const age = lockAgeMs(grave, Date.now());
  if (age !== null && age <= staleMs) {
    try {
      fs.linkSync(grave, lockPath);
    } catch (e) {
      // EEXIST: un tercero ya creo otro lock; el de A no se puede devolver.
      if (!e || e.code !== 'EEXIST') throw e;
    }
  }
  try {
    fs.unlinkSync(grave);
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
  return true;
}

// Codigos con los que Windows rechaza un rename sobre un fichero que otro proceso
// (antivirus, indexador, un lector sin lock) tiene abierto en ese instante.
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRIES = 40;

/**
 * renameSync con reintento acotado ante los bloqueos transitorios de Windows
 * (CI 2026-11-02: un alta de kanban.mjs murio dentro de la seccion critica en
 * windows-latest). Tras ~1 s sin exito relanza el ultimo error.
 */
function renameWithRetry(from, to) {
  let backoff = 2;
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (attempt >= RENAME_RETRIES || !e || !TRANSIENT_RENAME_CODES.has(e.code)) throw e;
      sleepSync(backoff);
      backoff = Math.min(backoff * 2, 50);
    }
  }
}

/** Borra el lock solo si sigue siendo nuestro (otro pudo romperlo por rancio). */
function releaseIfOwned(lockPath, token) {
  try {
    const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (current && current.token === token) fs.unlinkSync(lockPath);
  } catch {
    /* ya no existe o no es nuestro: nada que liberar */
  }
}

/**
 * Adquiere el lock de `boardFile`.
 * @param {string} boardFile  ruta de kanban.json
 * @param {{timeoutMs?: number, staleMs?: number, onStale?: (lockPath: string, ageMs: number) => void}} [opts]
 * @returns {() => void} funcion que libera el lock (idempotente)
 * @throws {Error} si no se consigue en `timeoutMs`
 */
function acquireBoardLock(boardFile, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? LOCK_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const onStale = opts.onStale || defaultOnStale;
  const lockPath = lockPathFor(boardFile);
  const token = crypto.randomBytes(8).toString('hex');
  const deadline = Date.now() + timeoutMs;
  let backoff = BACKOFF_START_MS;
  let lastDenied = null;

  for (;;) {
    const attempt = tryCreate(lockPath, token);
    if (attempt.acquired) break;
    if (attempt.denied) lastDenied = attempt.denied;
    const now = Date.now();
    const age = lockAgeMs(lockPath, now);
    if (age !== null && age > staleMs) {
      onStale(lockPath, age);
      if (breakStaleLock(lockPath, token, staleMs)) continue;
    }
    if (now >= deadline) {
      // Un EPERM que dura todo el plazo es un permiso real: se dice, no se esconde.
      const detail = lastDenied ? `; ultimo error al crearlo: ${lastDenied}` : '';
      throw new Error(`kanban.json bloqueado por otro proceso durante ${timeoutMs} ms (${lockPath})${detail}`);
    }
    sleepSync(Math.min(backoff, Math.max(1, deadline - now)));
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }

  let released = false;
  const onExit = () => releaseIfOwned(lockPath, token);
  process.on('exit', onExit);
  return () => {
    if (released) return;
    released = true;
    process.removeListener('exit', onExit);
    releaseIfOwned(lockPath, token);
  };
}

/**
 * Ejecuta `fn` con el lock de `boardFile` y lo libera siempre.
 * @template T
 * @param {string} boardFile
 * @param {() => T} fn
 * @param {Parameters<typeof acquireBoardLock>[1]} [opts]
 * @returns {T}
 */
function withBoardLock(boardFile, fn, opts) {
  const release = acquireBoardLock(boardFile, opts);
  try {
    return fn();
  } finally {
    release();
  }
}

module.exports = {
  LOCK_SUFFIX,
  LOCK_TIMEOUT_MS,
  LOCK_STALE_MS,
  lockPathFor,
  acquireBoardLock,
  withBoardLock,
  renameWithRetry,
};
